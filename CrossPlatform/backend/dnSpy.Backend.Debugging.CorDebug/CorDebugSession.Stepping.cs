using System.Text.Json;
using dnSpy.Backend.Contracts;
using ICorDebugSharp;
using ICorDebugSharp.Extensions;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>
/// Stepping: moving the stopped thread to the next statement, into a call, or out of the method.
/// </summary>
/// <remarks>
/// A step is driven by breakpoints on the sequence points it may land on rather than by asking the
/// runtime to step one instruction at a time. Without symbols the runtime only knows IL offsets, so
/// a plain step stops in the middle of statements — between the two halves of a comparison, say —
/// while sequence points are statement boundaries by construction.
///
/// The same mechanism is what makes stepping in an <c>async</c> method sane: the frame is inside a
/// generated <c>MoveNext</c>, and the sequence points that body carries belong to the method the user
/// wrote, so F10 walks the user's statements instead of the state machine's plumbing.
/// </remarks>
internal sealed partial class CorDebugSession {
	/// <summary>One armed step target: where it is, and the breakpoint that watches for it.</summary>
	sealed record SteppingBreakpoint(string ModulePath, int MetadataToken, int IlOffset, ICorDebugFunctionBreakpoint Breakpoint);

	readonly List<SteppingBreakpoint> steppingBreakpoints = new();
	ICorDebugStepper? nativeStepper;
	(int ThreadId, int MetadataToken, int IlOffset)? nativeStepperOrigin;

	/// <summary>
	/// Steps the stopped thread. <paramref name="stepInto"/> walks into the first statement of a call
	/// the workspace can decompile, <paramref name="stepOut"/> leaves the method; plain stepping
	/// continues to the next statement of the body the frame is in, or out of it when it is the last.
	/// </summary>
	internal async Task<JsonElement> StepAsync(string kind, JsonElement? arguments, CancellationToken cancellationToken) {
		var args = arguments is { ValueKind: JsonValueKind.Object } value ? value : default;
		var threadId = GetInt(args, "threadId") ?? StoppedThreadId ?? 0;
		CancelStepping();
		ClearReturnValues();
		// The return values are read with the type system, which is built here, off the dispatcher: the
		// breakpoints that read them are hit on it.
		var returnValueTypes = Options.ShowReturnValues && kind != "stepIn" ? TryGetTypeSystem() : null;
		// The targets are computed before the process is resumed: the resolver decompiles, and the
		// frame it is asked about only exists while the process is stopped.
		var location = await Dispatcher.RunAsync(() => ReadStepLocation(threadId)).ConfigureAwait(false);
		SteppingTargetsResponse? targets = null;
		if (kind != "stepOut" && location is { } where && SymbolResolver is not null)
			targets = await SymbolResolver.GetSteppingTargetsAsync(WorkspaceId, where.ModulePath, where.MetadataToken, where.IlOffset, kind == "stepIn", cancellationToken).ConfigureAwait(false);
		var stepTargets = location is { } origin && targets is not null ? FilterStepIntoTargets(origin.ModulePath, origin.MetadataToken, targets.Targets) : targets?.Targets ?? [];
		await Dispatcher.RunAsync(() => {
			var frame = CurrentFrame(threadId);
			var armed = ArmStepTargets(stepTargets);
			var stepInto = kind == "stepIn";
			// Leaving a frame has one meaning, and the frame the thread returns to is exactly what the
			// runtime knows how to find — the resolver says so when the body has nothing left to run.
			var leaving = kind == "stepOut" || targets is { LeavesMethod: true };
			// Without a target to watch for there is nothing to stop the step, so the runtime's own
			// stepper is the only way to complete it. What it is asked to do is the step the user asked
			// for, not the one the body's end implies: a step into never leaves the frame it started in,
			// so a callee the workspace cannot decompile — nothing of it was armed — is still a call the
			// stepper walks into rather than a frame to return from.
			if (leaving || (armed == 0 && frame is not null))
				ArmNativeStepper(frame, leaving && !stepInto, stepInto, threadId);
			if (returnValueTypes is not null)
				ArmStepReturnValues(returnValueTypes, threadId, frame, stepOver: kind == "next", leaving);
			// The step is already armed, so this must not be Continue(): that would disarm it again.
			ResumeProcess();
			return true;
		}).ConfigureAwait(false);
		return EmptyJson();
	}

	/// <summary>
	/// The callees a step into may not land in: dnSpy's Step over properties and operators, and Just My Code's
	/// modules that are not the user's. Dropping a callee's targets turns the step into a step over that call;
	/// the targets in the method the step started in stay.
	/// </summary>
	IReadOnlyList<SteppingTarget> FilterStepIntoTargets(string modulePath, int metadataToken, IReadOnlyList<SteppingTarget> targets) {
		var options = Options;
		if (!options.StepOverPropertiesAndOperators && !options.EnableJustMyCode)
			return targets;
		var types = TryGetTypeSystem();
		return targets.Where(target => {
			if (target.MetadataToken == metadataToken && BreakpointTable.PathsMatch(target.ModulePath, modulePath))
				return true;
			var entry = Modules.FindEntry(target.ModulePath);
			if (options.EnableJustMyCode && entry is { IsJustMyCode: false })
				return false;
			if (options.StepOverPropertiesAndOperators && types is not null && entry is not null &&
				types.GetMember(entry, target.MetadataToken) is Microsoft.CodeAnalysis.IMethodSymbol method &&
				method.MethodKind is Microsoft.CodeAnalysis.MethodKind.PropertyGet or Microsoft.CodeAnalysis.MethodKind.PropertySet
					or Microsoft.CodeAnalysis.MethodKind.UserDefinedOperator or Microsoft.CodeAnalysis.MethodKind.Conversion)
				return false;
			return true;
		}).ToArray();
	}

	/// <summary>Where the thread is stopped, in the terms the resolver speaks.</summary>
	(int MetadataToken, string ModulePath, int IlOffset)? ReadStepLocation(int threadId) {
		if (!IsStopped)
			throw new RpcException(ErrorCodes.InvalidParams, "The process is running.");
		var frame = CurrentFrame(threadId);
		if (frame is null)
			return null;
		var (modulePath, token) = FrameIdentity(frame);
		var offset = ReadIlOffset(frame);
		return string.IsNullOrEmpty(modulePath) || offset < 0 ? null : (token, modulePath, offset);
	}

	ICorDebugFrame? CurrentFrame(int threadId) =>
		Threads.Find(threadId)?.ActiveFrame;

	/// <summary>Arms a breakpoint on every location the step may land on, and answers how many took.</summary>
	int ArmStepTargets(IReadOnlyList<SteppingTarget> targets) {
		var armed = 0;
		foreach (var target in targets) {
			var module = Modules.Find(target.ModulePath);
			if (module is null)
				continue;
			try {
				var breakpoint = module.GetFunctionFromToken(target.MetadataToken).ILCode.CreateBreakpoint(target.IlOffset);
				breakpoint.Activate(true);
				steppingBreakpoints.Add(new SteppingBreakpoint(target.ModulePath, target.MetadataToken, target.IlOffset, breakpoint));
				armed++;
			}
			catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
				// The runtime refuses some offsets; the remaining targets still cover the step.
			}
		}
		return armed;
	}

	/// <summary>
	/// The fallback for a step with nowhere to land: the runtime's stepper, which stops at the next
	/// IL instruction. It is statement granularity only by accident, so it is used when there is
	/// nothing better — leaving a method, a "step into" whose callee cannot be decompiled, or a
	/// location the resolver could not map.
	/// </summary>
	void ArmNativeStepper(ICorDebugFrame? frame, bool stepOut, bool stepInto, int threadId) {
		if (frame is null)
			return;
		try {
			var stepper = frame.CreateStepper();
			if (stepper is null)
				return;
			// The runtime's own defaults stop a step on code it cannot map, and without a PDB beside
			// the module almost all IL is unmapped, so a step would end in the middle of a statement
			// or never complete. Clearing the masks is what dnSpy's own engine does, and it is what
			// makes the step pass through the unplaceable code and stop where the runtime can place it.
			stepper.SetInterceptMask(CorDebugIntercept.INTERCEPT_NONE);
			stepper.SetUnmappedStopMask(CorDebugUnmappedStop.STOP_NONE);
			// Just My Code: the runtime's stepper skips the modules OnModuleLoadedCore marked as not the user's.
			stepper.SetJMC(Options.EnableJustMyCode);
			if (stepOut)
				stepper.StepOut();
			else
				// Only a step into advances the stepper; a step over passes its flag through, or the
				// fallback would walk into a call the user asked to step past.
				stepper.Step(stepInto);
			nativeStepper = stepper;
			nativeStepperOrigin = ReadStepOrigin(frame, threadId);
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			nativeStepper = null;
			nativeStepperOrigin = null;
		}
	}

	/// <summary>The location a step is leaving, which is where the runtime re-announces its breakpoint.</summary>
	(int, int, int)? ReadStepOrigin(ICorDebugFrame frame, int threadId) {
		var (modulePath, token) = FrameIdentity(frame);
		var offset = ReadIlOffset(frame);
		return string.IsNullOrEmpty(modulePath) || offset < 0 ? null : (threadId, token, offset);
	}

	/// <summary>
	/// True when a breakpoint hit is the runtime re-announcing the breakpoint the thread is standing
	/// on. Resuming a thread with a stepper re-reports that breakpoint, and the report has to be
	/// answered with another resume: stopping on it would leave the step forever unfinished.
	/// </summary>
	bool IsNativeStepOrigin(ICorDebugBreakpoint breakpoint, ICorDebugThread thread) {
		if (nativeStepper is null || nativeStepperOrigin is not { } origin)
			return false;
		if (ThreadTable.TryGetId(thread) != origin.ThreadId)
			return false;
		if (breakpoint is not ICorDebugFunctionBreakpoint hit)
			return false;
		try {
			return unchecked((int)hit.Function.Token.Value) == origin.MetadataToken && hit.Offset == origin.IlOffset;
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return false;
		}
	}

	/// <summary>True when a hit belongs to the step under way, which no client breakpoint owns.</summary>
	bool IsSteppingBreakpoint(ICorDebugBreakpoint breakpoint) {
		if (steppingBreakpoints.Count == 0)
			return false;
		try {
			if (breakpoint is not ICorDebugFunctionBreakpoint hit)
				return false;
			var token = hit.Function.Token;
			var offset = hit.Offset;
			return steppingBreakpoints.Any(target => target.Breakpoint.Function.Token == token && target.Breakpoint.Offset == offset);
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return false;
		}
	}

	/// <summary>Disarms everything a step left behind, called before any other move.</summary>
	void CancelStepping() {
		foreach (var target in steppingBreakpoints) {
			try {
				target.Breakpoint.Activate(false);
			}
			catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
				// The process is gone; there is nothing left to disarm.
			}
		}
		steppingBreakpoints.Clear();
		DisarmReturnValueBreakpoints();
		var stepper = nativeStepper;
		nativeStepper = null;
		nativeStepperOrigin = null;
		if (stepper is null)
			return;
		try {
			stepper.Deactivate();
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			// Same as above.
		}
	}
}
