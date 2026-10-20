using dnSpy.Backend.Debugging.CorDebug.Evaluation;
using ICorDebugSharp;
using ICorDebugSharp.Extensions;
using Microsoft.CodeAnalysis;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>
/// dnSpy's Show return values: what the calls a step went over returned, shown in Locals as "X returned" and
/// readable as <c>$ReturnValue</c>. Before a step resumes, every call the frame can still make gets a breakpoint
/// where the runtime says its return value is live (<c>ICorDebugCode3.GetReturnValueLiveOffset</c>); a hit
/// reads the value (<c>ICorDebugILFrame3.GetReturnValueForILOffset</c>), keeps it, and lets the step go on.
/// </summary>
internal sealed partial class CorDebugSession {
	/// <summary>A breakpoint at the point a call's return value is live, and the call it belongs to.</summary>
	sealed record ReturnValueBreakpoint(ICorDebugFunctionBreakpoint Breakpoint, int ThreadId, int FrameToken, int CallOffset, IMethodSymbol Callee);

	readonly List<ReturnValueBreakpoint> returnValueBreakpoints = new();

	/// <summary>The handles the kept return values hold, released when the values are dropped.</summary>
	readonly List<ICorDebugHandleValue> returnValueHandles = new();

	/// <summary>While a return value is read, the handles it takes outlive the stop: they belong to the value.</summary>
	bool capturingReturnValue;

	/// <summary>The most calls one frame is watched for; a long method's later calls rarely run before the step ends.</summary>
	const int MaxReturnValueCalls = 64;

	/// <summary>Drops the return values of the last step: a new step, or a Continue, starts without any.</summary>
	void ClearReturnValues() {
		returnValues = new();
		foreach (var handle in returnValueHandles) {
			try {
				handle.Dispose();
			}
			catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			}
		}
		returnValueHandles.Clear();
	}

	/// <summary>
	/// Arms what a step needs to read return values: a step over watches the calls left in the frame, a step out the
	/// call in the caller that the frame returns to.
	/// </summary>
	void ArmStepReturnValues(DebuggeeTypeSystem types, int threadId, ICorDebugFrame? frame, bool stepOver, bool leaving) {
		if (frame is null)
			return;
		// A step over the last statement leaves the frame too: its calls and the caller's are both watched.
		if (stepOver)
			ArmReturnValueBreakpoints(types, frame, threadId, ReadIlOffset(frame), onlyThisCall: false);
		if (!leaving)
			return;
		var thread = Threads.Find(threadId);
		var caller = thread is null ? null : WalkFrames(thread, 2).Skip(1).FirstOrDefault();
		if (caller is not null)
			ArmReturnValueBreakpoints(types, caller, threadId, ReadIlOffset(caller), onlyThisCall: true);
	}

	/// <summary>Disarms the return-value breakpoints a step left behind.</summary>
	void DisarmReturnValueBreakpoints() {
		foreach (var watched in returnValueBreakpoints) {
			try {
				watched.Breakpoint.Activate(false);
			}
			catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			}
		}
		returnValueBreakpoints.Clear();
	}

	/// <summary>
	/// Watches the calls <paramref name="frame"/> can make from <paramref name="fromOffset"/> on — or just the call
	/// at <paramref name="fromOffset"/>, for the caller of a step out — for the values they return.
	/// </summary>
	void ArmReturnValueBreakpoints(DebuggeeTypeSystem types, ICorDebugFrame? frame, int threadId, int fromOffset, bool onlyThisCall) {
		if (frame is null || fromOffset < 0)
			return;
		try {
			var (modulePath, token) = FrameIdentity(frame);
			var entry = Modules.FindEntry(modulePath);
			if (entry is null || types.GetMember(entry, token) is not IMethodSymbol method)
				return;
			var reader = types.GetReader(entry);
			if (reader is null)
				return;
			var definition = reader.GetMethodDefinition(MetadataTokens.MethodDefinitionHandle(token & 0x00FFFFFF));
			var body = definition.RelativeVirtualAddress == 0 ? null : types.GetMethodBody(entry, definition.RelativeVirtualAddress);
			if (body is null || frame.Function.TryGetNativeCode(out var code) < 0 || code is null)
				return;
			var calls = ILScanner.ScanWithOffsets(body.GetILBytes() ?? [])
				// call, callvirt
				.Where(instruction => instruction.OpCode is 0x28 or 0x6F)
				.Where(instruction => onlyThisCall ? instruction.Offset == fromOffset : instruction.Offset >= fromOffset)
				.Take(MaxReturnValueCalls);
			foreach (var call in calls) {
				var callee = ResolveMethod(types, entry, reader, call.Operand, method);
				// The runtime only tracks primitive and reference return values: for a call that returns a struct,
				// GetReturnValueLiveOffset answers CORDBG_E_UNSUPPORTED, so dnSpy's engine shows none for it either.
				if (callee is null || callee.ReturnsVoid)
					continue;
				IEnumerable<uint> offsets;
				try {
					var (buffer, fetched) = code.GetReturnValueLiveOffset(call.Offset, 8);
					offsets = buffer.Take(Math.Min(fetched, buffer.Length));
				}
				catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
					continue;
				}
				foreach (var offset in offsets.Distinct()) {
					try {
						var breakpoint = code.CreateBreakpoint((int)offset);
						breakpoint.Activate(true);
						returnValueBreakpoints.Add(new ReturnValueBreakpoint(breakpoint, threadId, token, call.Offset, callee));
					}
					catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
					}
				}
			}
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex) || ex is BadImageFormatException or InvalidOperationException) {
			// A frame whose method cannot be read just shows no return values.
		}
	}

	/// <summary>
	/// True when a hit is one of the return-value breakpoints: the value is read and kept, and the caller lets the
	/// process go on — the step it belongs to is still under way.
	/// </summary>
	bool TryCaptureReturnValue(ICorDebugBreakpoint breakpoint, ICorDebugThread thread) {
		if (returnValueBreakpoints.Count == 0 || breakpoint is not ICorDebugFunctionBreakpoint hit)
			return false;
		ReturnValueBreakpoint? watched;
		try {
			var function = hit.Function;
			var offset = hit.Offset;
			watched = returnValueBreakpoints.FirstOrDefault(candidate => candidate.Breakpoint.Function.Token == function.Token && candidate.Breakpoint.Offset == offset);
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return false;
		}
		if (watched is null)
			return false;
		// Another thread passing the same code is not the step's; its hit is let go all the same.
		if (ThreadTable.TryGetId(thread) == watched.ThreadId)
			CaptureReturnValue(thread.ActiveFrame, watched.ThreadId, watched.CallOffset, watched.Callee);
		return true;
	}

	/// <summary>Reads the value the call at <paramref name="callOffset"/> returned, if the frame is where it is live.</summary>
	void CaptureReturnValue(ICorDebugFrame? frame, int threadId, int callOffset, IMethodSymbol callee) {
		if (frame is not ICorDebugILFrame3 ilFrame || TryGetTypeSystem() is not { } types)
			return;
		try {
			if (ilFrame.TryGetReturnValueForILOffset((uint)callOffset, out var value) < 0 || value is null)
				return;
			var runtime = new EvalRuntime(this, types, threadId, 0, allowFuncEval: false, CancellationToken.None);
			capturingReturnValue = true;
			EvalValue wrapped;
			try {
				wrapped = runtime.Wrap(value, callee.ReturnType, null);
			}
			finally {
				capturingReturnValue = false;
			}
			// A struct is read where it lies, which the next continue takes away; only what was copied out or is
			// held by a handle is worth keeping.
			if (wrapped is RemoteValue { Ref.Handle: null })
				return;
			returnValues = [.. returnValues, new ReturnValueInfo(callee, wrapped)];
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex) || ex is EvaluationException or InvalidCastException) {
		}
	}

	/// <summary>The method a call's operand names: a definition, a reference to another module's, or an instantiation.</summary>
	static IMethodSymbol? ResolveMethod(DebuggeeTypeSystem types, ModuleTable.ModuleEntry entry, MetadataReader reader, int token, IMethodSymbol context) {
		var handle = MetadataTokens.EntityHandle(token);
		switch (handle.Kind) {
			case HandleKind.MethodDefinition:
				return types.GetMember(entry, token) as IMethodSymbol;
			case HandleKind.MethodSpecification:
				var specification = reader.GetMethodSpecification((MethodSpecificationHandle)handle);
				return ResolveMethod(types, entry, reader, MetadataTokens.GetToken(specification.Method), context);
			case HandleKind.MemberReference:
				var reference = reader.GetMemberReference((MemberReferenceHandle)handle);
				var name = reader.GetString(reference.Name);
				var signature = new SignatureContext(DebuggeeTypeSystem.AllTypeArguments(context.ContainingType), context.TypeArguments);
				var provider = new RoslynSignatureProvider(types, entry);
				ITypeSymbol? parent = reference.Parent.Kind switch {
					HandleKind.TypeReference => provider.GetTypeFromReference(reader, (TypeReferenceHandle)reference.Parent, 0),
					HandleKind.TypeDefinition => provider.GetTypeFromDefinition(reader, (TypeDefinitionHandle)reference.Parent, 0),
					HandleKind.TypeSpecification => provider.GetTypeFromSpecification(reader, signature, (TypeSpecificationHandle)reference.Parent, 0),
					_ => null,
				};
				if (parent is null)
					return null;
				var parameterCount = reference.DecodeMethodSignature(provider, signature).RequiredParameterCount;
				return parent.GetMembers(name).OfType<IMethodSymbol>().FirstOrDefault(method => method.Parameters.Length == parameterCount)
					?? parent.GetMembers(name).OfType<IMethodSymbol>().FirstOrDefault();
			default:
				return null;
		}
	}
}
