using dnSpy.Backend.Contracts;
using dnSpy.Backend.Debugging.CorDebug.Evaluation;
using ICorDebugSharp;
using ICorDebugSharp.Extensions;
using Microsoft.CodeAnalysis;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>
/// Stepping across <c>await</c>, the way dnSpy's DbgEngineStepperImpl does it when Async debugging is on. A step in an
/// async method's MoveNext is about that one call of the method, and the task its builder completes is what tells the
/// call apart from another one running the same code.
/// <list type="bullet">
/// <item>A step watches the method's yield points on the stepping thread: reaching one means the call is suspending —
/// its task exists from then on — and the step lands only after the same task has resumed at that await's resumption
/// point, on whichever thread runs it (SetResumeBreakpoint).</item>
/// <item>A step that reaches the call to the builder's SetResult — the method is completing — goes back to whoever
/// waits for the task: the task is asked to tell the debugger when it is waited on (SetNotificationForWaitCompletion),
/// the step breaks in Task.NotifyDebuggerOfWaitCompletion when the awaiter collects it, and steps out of the task
/// plumbing to the code that awaited it. A step out does the same from the start.</item>
/// </list>
/// </summary>
internal sealed partial class CorDebugSession {
	sealed class AsyncStep {
		public required int ThreadId { get; init; }
		public required string ModulePath { get; init; }
		public required int MoveNextToken { get; init; }
		public required AsyncStepInfoDto Info { get; init; }
		/// <summary>The fields from the builder to its task.</summary>
		public required IReadOnlyList<int> TaskFieldPath { get; init; }
		/// <summary>The task of the call being stepped, once it exists — the identity a hit is checked against.</summary>
		public ICorDebugHandleValue? Task { get; set; }
		/// <summary>The yield points, each with the offset its await resumes at.</summary>
		public List<(ICorDebugFunctionBreakpoint Breakpoint, int ResumeOffset)> YieldBreakpoints { get; } = new();
		/// <summary>Where the call resumes once it has suspended: the step waits for it before it lands anywhere.</summary>
		public ICorDebugFunctionBreakpoint? ResumeBreakpoint { get; set; }
		public bool Suspended { get; set; }
		/// <summary>The builder's SetResult call, where the step turns into a return to the awaiter.</summary>
		public ICorDebugFunctionBreakpoint? SetResultBreakpoint { get; set; }
		/// <summary>Task.NotifyDebuggerOfWaitCompletion, where the awaiter collects the task.</summary>
		public ICorDebugFunctionBreakpoint? NotifyBreakpoint { get; set; }
		/// <summary>Set once the awaiter has collected the task: the step is walking out of the task plumbing.</summary>
		public bool ReturningToAwaiter { get; set; }
		public int StepOuts { get; set; }
	}

	AsyncStep? asyncStep;

	/// <summary>How many frames of plumbing a return to the awaiter steps out of before it gives up, as dnSpy's stepper does.</summary>
	const int MaxAwaiterStepOuts = 50;

	/// <summary>
	/// What an async step needs of the method the thread is stopped in: its await offsets, its SetResult call and the
	/// builder's task; null when the frame is no async MoveNext or Async debugging is off.
	/// </summary>
	async Task<(AsyncStepInfoDto Info, IReadOnlyList<int> TaskPath)?> ReadAsyncStepInfoAsync((int MetadataToken, string ModulePath, int IlOffset) location, CancellationToken cancellationToken) {
		if (!Options.AsyncDebugging || SymbolResolver is not IDebugAsyncStepInfoProvider provider)
			return null;
		var info = await provider.GetAsyncStepInfoAsync(WorkspaceId, location.ModulePath, location.MetadataToken, cancellationToken).ConfigureAwait(false);
		if (info is null)
			return null;
		var path = await Dispatcher.RunAsync(() => TaskFieldPath(location.ModulePath, info.BuilderFieldToken)).ConfigureAwait(false);
		return path is null ? null : (info, path);
	}

	/// <summary>The fields from a builder to the task it completes: <c>m_task</c>, or the one of the builder it wraps.</summary>
	IReadOnlyList<int>? TaskFieldPath(string modulePath, int builderFieldToken) {
		if (TryGetTypeSystem() is not { } types || Modules.FindEntry(modulePath) is not { } entry || types.GetMember(entry, builderFieldToken) is not IFieldSymbol builder)
			return null;
		return FindTaskField(builder.Type, 0);

		static IReadOnlyList<int>? FindTaskField(ITypeSymbol type, int depth) {
			var fields = type.OriginalDefinition.GetMembers().OfType<IFieldSymbol>().Where(field => !field.IsStatic).ToArray();
			if (fields.FirstOrDefault(field => field.Name is "m_task" or "_task") is { } task)
				return [task.MetadataToken];
			if (depth >= 3)
				return null;
			foreach (var field in fields.Where(field => field.Name is "m_builder" or "_builder" or "_methodBuilder" && field.Type.IsValueType)) {
				if (FindTaskField(field.Type, depth + 1) is { } inner)
					return [field.MetadataToken, .. inner];
			}
			return null;
		}
	}

	/// <summary>The task a MoveNext frame's builder holds, or null while it has none: the call has not suspended yet.</summary>
	static ICorDebugReferenceValue? ReadBuilderTask(ICorDebugFrame? frame, int builderFieldToken, IReadOnlyList<int> taskPath) {
		try {
			if (frame is not ICorDebugILFrame ilFrame || ValueReader.Dereference(ilFrame.GetArgument(0)) is not ICorDebugObjectValue stateMachine)
				return null;
			ICorDebugValue current = stateMachine.GetFieldValue(stateMachine.Class, new mdFieldDef(unchecked((uint)builderFieldToken)));
			foreach (var token in taskPath) {
				if (ValueReader.Dereference(current) is not ICorDebugObjectValue holder)
					return null;
				current = holder.GetFieldValue(holder.Class, new mdFieldDef(unchecked((uint)token)));
			}
			return current is ICorDebugReferenceValue { IsNull: false } task ? task : null;
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return null;
		}
	}

	static ICorDebugReferenceValue? ReadBuilderTask(ICorDebugFrame? frame, AsyncStep step) => ReadBuilderTask(frame, step.Info.BuilderFieldToken, step.TaskFieldPath);

	static bool SameObject(ICorDebugReferenceValue? left, ICorDebugReferenceValue? right) {
		try {
			return left is not null && right is not null && !left.IsNull && !right.IsNull && left.Value.Value == right.Value.Value;
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return false;
		}
	}

	static ICorDebugHandleValue? StrongHandle(ICorDebugReferenceValue? reference) {
		try {
			return reference is not null && ValueReader.Dereference(reference) is ICorDebugHeapValue2 heap ? heap.CreateHandle(CorDebugHandleType.HANDLE_STRONG) : null;
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return null;
		}
	}

	ICorDebugFunctionBreakpoint? ArmMoveNextBreakpoint(AsyncStep step, int offset) {
		try {
			if (Modules.Find(step.ModulePath) is not { } module)
				return null;
			var breakpoint = module.GetFunctionFromToken(step.MoveNextToken).ILCode.CreateBreakpoint(offset);
			breakpoint.Activate(true);
			return breakpoint;
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return null;
		}
	}

	/// <summary>
	/// Starts an async step over or into a statement: the task is read if the call already has one, the method's yield
	/// points are watched so the task is read the moment the call suspends, and the SetResult call so the step can go
	/// back to the awaiter when the method completes.
	/// </summary>
	void BeginAsyncStep(int threadId, ICorDebugFrame? frame, string modulePath, int moveNextToken, AsyncStepInfoDto info, IReadOnlyList<int> taskPath) {
		var step = new AsyncStep { ThreadId = threadId, ModulePath = modulePath, MoveNextToken = moveNextToken, Info = info, TaskFieldPath = taskPath };
		step.Task = StrongHandle(ReadBuilderTask(frame, step));
		foreach (var awaited in info.Awaits.DistinctBy(awaited => awaited.YieldOffset)) {
			// An await the runtime cannot break at is one the step does not see the call suspend at.
			if (ArmMoveNextBreakpoint(step, awaited.YieldOffset) is { } breakpoint)
				step.YieldBreakpoints.Add((breakpoint, awaited.ResumeOffset));
		}
		if (info.SetResultOffset >= 0)
			step.SetResultBreakpoint = ArmMoveNextBreakpoint(step, info.SetResultOffset);
		asyncStep = step;
	}

	/// <summary>
	/// A step out of an async method: the return to the awaiter starts right away. Answers whether it could — a method
	/// whose builder will not say, or a runtime without the notification, is left by an ordinary step out.
	/// </summary>
	async Task<bool> BeginStepOutToAwaiterAsync(int threadId, string modulePath, int moveNextToken, AsyncStepInfoDto info, IReadOnlyList<int> taskPath, CancellationToken cancellationToken) {
		var step = new AsyncStep { ThreadId = threadId, ModulePath = modulePath, MoveNextToken = moveNextToken, Info = info, TaskFieldPath = taskPath };
		if (!await EnableWaitNotificationAsync(step, cancellationToken).ConfigureAwait(false))
			return false;
		return await Dispatcher.RunAsync(() => {
			if (!ArmAwaiterNotification(step))
				return false;
			asyncStep = step;
			return true;
		}).ConfigureAwait(false);
	}

	/// <summary>
	/// TaskEvalUtils.CallSetNotificationForWaitCompletion: the builder is read off the state machine and the call is made
	/// on it where it lies, so the task it creates on the way, if it has none yet, is the one the method completes.
	/// </summary>
	async Task<bool> EnableWaitNotificationAsync(AsyncStep step, CancellationToken cancellationToken) {
		if (TryGetTypeSystem() is not { } types || Modules.FindEntry(step.ModulePath) is not { } entry || types.GetMember(entry, step.Info.BuilderFieldToken) is not IFieldSymbol builderField)
			return false;
		var setNotification = builderField.Type.GetMembers("SetNotificationForWaitCompletion").OfType<IMethodSymbol>()
			.FirstOrDefault(method => !method.IsStatic && method.Parameters.Length == 1 && method.Parameters[0].Type.SpecialType == SpecialType.System_Boolean);
		if (setNotification is null)
			return false;
		using (await EnterEvaluationAsync(cancellationToken).ConfigureAwait(false)) {
			try {
				var runtime = new EvalRuntime(this, types, step.ThreadId, 0, allowFuncEval: true, cancellationToken);
				var stateMachine = await runtime.ReadArgumentAsync(0, builderField.ContainingType).ConfigureAwait(false);
				var builder = await runtime.ReadFieldAsync(stateMachine, builderField).ConfigureAwait(false);
				await runtime.CallAsync(setNotification, builder, [new ScalarValue(types.Compilation.GetSpecialType(SpecialType.System_Boolean), true)]).ConfigureAwait(false);
				return true;
			}
			catch (EvaluationException) {
				return false;
			}
		}
	}

	/// <summary>Breaks where the awaiter collects the call's task: Task.NotifyDebuggerOfWaitCompletion, for any thread.</summary>
	bool ArmAwaiterNotification(AsyncStep step) {
		step.Task ??= StrongHandle(ReadBuilderTask(CurrentFrame(step.ThreadId), step));
		if (step.Task is null || TryGetTypeSystem() is not { } types)
			return false;
		var notify = types.FindType("System.Threading.Tasks.Task")?.GetMembers("NotifyDebuggerOfWaitCompletion").OfType<IMethodSymbol>()
			.FirstOrDefault(method => !method.IsStatic && method.Parameters.Length == 0 && method.ReturnsVoid);
		if (notify is null || types.GetFunction(notify) is not { } function)
			return false;
		try {
			var breakpoint = function.ILCode.CreateBreakpoint(0);
			breakpoint.Activate(true);
			step.NotifyBreakpoint = breakpoint;
			return true;
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return false;
		}
	}

	/// <summary>
	/// The async step's own breakpoints. Answers true for a hit the step has taken care of — the process goes on, or is
	/// held while the step makes a call in it.
	/// </summary>
	bool HandleAsyncStepHit(ICorDebugBreakpoint breakpoint, ICorDebugThread thread) {
		if (asyncStep is not { } step || breakpoint is not ICorDebugFunctionBreakpoint hit)
			return false;
		var threadId = ThreadTable.TryGetId(thread);
		if (step.YieldBreakpoints.FirstOrDefault(candidate => SameBreakpoint(candidate.Breakpoint, hit)) is { Breakpoint: not null } yielded) {
			// SetResumeBreakpoint: the stepping thread's call is suspending — its task exists now — and the step lands
			// only once the same task has resumed at the await's resumption point, on whichever thread runs it.
			if (threadId != step.ThreadId || step.Suspended || !SameMethodBody(thread.ActiveFrame, step.MoveNextToken))
				return true;
			step.Task ??= StrongHandle(ReadBuilderTask(thread.ActiveFrame, step));
			if (step.Task is not null && ArmMoveNextBreakpoint(step, yielded.ResumeOffset) is { } resume) {
				step.ResumeBreakpoint = resume;
				step.Suspended = true;
			}
			return true;
		}
		if (step.ResumeBreakpoint is { } resumeBreakpoint && SameBreakpoint(resumeBreakpoint, hit)) {
			if (!SameObject(ReadBuilderTask(thread.ActiveFrame, step), step.Task))
				return true;
			// Resumed: from here the step lands on the next statement this thread reaches.
			Deactivate(resumeBreakpoint);
			step.ResumeBreakpoint = null;
			step.Suspended = false;
			return true;
		}
		if (step.SetResultBreakpoint is { } setResult && SameBreakpoint(setResult, hit)) {
			if (step.Suspended || !SameMethodBody(thread.ActiveFrame, step.MoveNextToken))
				return true;
			if (step.Task is not null ? !SameObject(ReadBuilderTask(thread.ActiveFrame, step), step.Task) : threadId != step.ThreadId)
				return true;
			// The call is completing: the step is now a return to whoever awaits its task. The task is told to notify
			// the debugger, which is a call in the debuggee, so the process is held while it is made — on the thread
			// the method completes on, which is the one that resumed it.
			Deactivate(setResult);
			step.SetResultBreakpoint = null;
			if (threadId is { } completingThread && completingThread != step.ThreadId) {
				var moved = new AsyncStep { ThreadId = completingThread, ModulePath = step.ModulePath, MoveNextToken = step.MoveNextToken, Info = step.Info, TaskFieldPath = step.TaskFieldPath, Task = step.Task };
				step.Task = null;
				EndAsyncStep();
				asyncStep = step = moved;
			}
			deciding = true;
			holdAfterEvent = true;
			var completing = step;
			_ = Task.Run(() => ReturnToAwaiterAsync(completing, thread));
			return true;
		}
		if (step.NotifyBreakpoint is { } notify && SameBreakpoint(notify, hit)) {
			// Another task being waited on passes here too; only this call's is the one the step waits for.
			ICorDebugReferenceValue? waited = null;
			try {
				waited = (thread.ActiveFrame as ICorDebugILFrame)?.GetArgument(0) as ICorDebugReferenceValue;
			}
			catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			}
			if (waited is not null && !SameObject(waited, step.Task))
				return true;
			Deactivate(notify);
			step.NotifyBreakpoint = null;
			step.ReturningToAwaiter = true;
			ArmAwaiterStepOut(thread);
			return true;
		}
		return false;
	}

	/// <summary>Turns a step that reached the method's SetResult into a return to the awaiter, then lets the process go.</summary>
	async Task ReturnToAwaiterAsync(AsyncStep step, ICorDebugThread thread) {
		var enabled = false;
		try {
			enabled = await EnableWaitNotificationAsync(step, CancellationToken.None).ConfigureAwait(false);
		}
		catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException) {
		}
		await Dispatcher.RunAsync(() => {
			deciding = false;
			if (HasExited || process is null || !ReferenceEquals(asyncStep, step))
				return;
			// The statements of the method are no place to land any more: what is left of it is the completion.
			DisarmStepTargets();
			if (!enabled || !ArmAwaiterNotification(step)) {
				// Without the notification the step leaves the method the ordinary way.
				EndAsyncStep();
				ArmNativeStepper(thread.ActiveFrame, stepOut: true, stepInto: false, step.ThreadId);
			}
			ContinueProcess();
		}).ConfigureAwait(false);
	}

	/// <summary>
	/// Whether a stepping target reached by <paramref name="thread"/> is this step's to land on: the stepping thread
	/// before the call has suspended, and afterwards whichever thread runs the same task once it has resumed.
	/// </summary>
	bool AsyncStepAccepts(ICorDebugThread thread) {
		if (asyncStep is not { } step)
			return true;
		// Suspended, or on the way back to the awaiter: the method's statements are not where the step lands.
		if (step.Suspended || step.ReturningToAwaiter || step.NotifyBreakpoint is not null)
			return false;
		if (step.Task is null)
			return ThreadTable.TryGetId(thread) == step.ThreadId;
		return SameObject(ReadBuilderTask(thread.ActiveFrame, step), step.Task);
	}

	/// <summary>Steps out of the frame the thread is in, the way back from the awaiter's plumbing to the code that awaited.</summary>
	void ArmAwaiterStepOut(ICorDebugThread thread) {
		try {
			var stepper = thread.ActiveFrame?.CreateStepper() ?? thread.CreateStepper();
			stepper.SetInterceptMask(CorDebugIntercept.INTERCEPT_NONE);
			stepper.SetUnmappedStopMask(CorDebugUnmappedStop.STOP_NONE);
			stepper.StepOut();
			nativeStepper = stepper;
			nativeStepperOrigin = null;
			if (asyncStep is { } step)
				step.StepOuts++;
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			nativeStepper = null;
		}
	}

	/// <summary>
	/// A step out of the awaiter's plumbing has completed: still inside <c>System.Threading.Tasks</c> or
	/// <c>System.Runtime.CompilerServices</c> it steps out again, anywhere else it is the stop. Answers true while the
	/// step goes on.
	/// </summary>
	bool ContinueReturnToAwaiter(ICorDebugThread thread) {
		if (asyncStep is not { ReturningToAwaiter: true } step || step.StepOuts >= MaxAwaiterStepOuts)
			return false;
		if (!IsAwaiterPlumbing(thread.ActiveFrame))
			return false;
		ArmAwaiterStepOut(thread);
		return nativeStepper is not null;
	}

	bool IsAwaiterPlumbing(ICorDebugFrame? frame) {
		if (frame is null || TryGetTypeSystem() is not { } types)
			return false;
		try {
			var (modulePath, token) = FrameIdentity(frame);
			if (Modules.FindEntry(modulePath) is not { } entry || types.GetMember(entry, token) is not IMethodSymbol method)
				return false;
			var outermost = method.ContainingType;
			while (outermost.ContainingType is { } containing)
				outermost = containing;
			return outermost.ContainingNamespace?.ToDisplayString() is "System.Threading.Tasks" or "System.Runtime.CompilerServices";
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return false;
		}
	}

	static bool SameMethodBody(ICorDebugFrame? frame, int metadataToken) {
		try {
			return frame?.Function is { } function && unchecked((int)function.Token.Value) == metadataToken;
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return false;
		}
	}

	static bool SameBreakpoint(ICorDebugFunctionBreakpoint candidate, ICorDebugFunctionBreakpoint hit) {
		try {
			return candidate.Function.Token == hit.Function.Token && candidate.Offset == hit.Offset;
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return false;
		}
	}

	static void Deactivate(ICorDebugFunctionBreakpoint? breakpoint) {
		try {
			breakpoint?.Activate(false);
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
		}
	}

	/// <summary>Disarms what an async step left behind and lets its task go.</summary>
	void EndAsyncStep() {
		if (asyncStep is not { } step)
			return;
		asyncStep = null;
		foreach (var (breakpoint, _) in step.YieldBreakpoints)
			Deactivate(breakpoint);
		Deactivate(step.ResumeBreakpoint);
		Deactivate(step.SetResultBreakpoint);
		Deactivate(step.NotifyBreakpoint);
		try {
			step.Task?.Dispose();
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
		}
	}
}
