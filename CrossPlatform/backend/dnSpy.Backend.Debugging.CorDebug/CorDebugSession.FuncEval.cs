using System.Runtime.InteropServices;
using ICorDebugSharp;
using ICorDebugSharp.Extensions;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>
/// A failure the user reads: an expression the evaluator could not bind, a call the runtime refused, a
/// function evaluation that timed out. The message is what the variables windows show in the value column.
/// </summary>
internal sealed class EvaluationException : Exception {
	public EvaluationException(string message) : base(message) { }

	public EvaluationException(string message, Exception inner) : base(message, inner) { }
}

/// <summary>What a function evaluation produced: the value it returned, or the exception it threw.</summary>
internal sealed record FuncEvalResult(ICorDebugValue? Value, bool IsException, ICorDebugEval Eval);

/// <summary>
/// Function evaluation: running a method of the debuggee on one of its threads while the user is stopped —
/// a property getter, <c>ToString()</c>, a method an expression calls. This is the port of dnSpy's
/// <c>DnEval</c>.
/// </summary>
/// <remarks>
/// <para>
/// A func-eval is a real <c>Continue</c>: the runtime runs the call on the evaluating thread and reports
/// <c>EvalComplete</c> or <c>EvalException</c> when it returns. Every other thread is suspended for the
/// duration, as WPF does, so the program does not run on behind the user's back. Callbacks the call raises
/// on the way — a module it loads, a breakpoint inside the code it runs, a first-chance exception — are
/// answered with another <c>Continue</c> rather than reported: the user is still stopped where they were.
/// </para>
/// <para>
/// Because it continues the process, an evaluation neuters every <see cref="ICorDebugValue"/> and
/// <see cref="ICorDebugFrame"/> read before it. <see cref="Generation"/> counts those continues so a holder
/// of such an object can tell it has to read it again; object references survive as strong handles.
/// </para>
/// <para>
/// A call that does not return within the timeout is aborted, and further evaluations are refused until the
/// next stop — WPF's "Function evaluation timed out and was disabled" — because a thread left inside an
/// aborted call is not one to run more code on.
/// </para>
/// </remarks>
internal sealed partial class CorDebugSession {
	/// <summary>
	/// dnSpy's <c>DbgLanguage.DefaultFuncEvalTimeout</c>. The debugger tests lengthen it: a call that takes a
	/// few milliseconds can still miss one second on a runner busy with other test processes.
	/// </summary>
	internal static TimeSpan FuncEvalTimeout { get; set; } = TimeSpan.FromSeconds(1);
	static readonly TimeSpan AbortTimeout = TimeSpan.FromSeconds(3);
	static readonly TimeSpan RudeAbortTimeout = TimeSpan.FromSeconds(1);

	const int CORDBG_E_ILLEGAL_AT_GC_UNSAFE_POINT = unchecked((int)0x80131C23);
	const int CORDBG_E_ILLEGAL_IN_PROLOG = unchecked((int)0x80131C24);
	const int CORDBG_E_ILLEGAL_IN_NATIVE_CODE = unchecked((int)0x80131C25);
	const int CORDBG_E_ILLEGAL_IN_OPTIMIZED_CODE = unchecked((int)0x80131C26);
	const int CORDBG_E_FUNC_EVAL_BAD_START_POINT = unchecked((int)0x80131C28);
	const int CORDBG_E_ILLEGAL_IN_STACK_OVERFLOW = unchecked((int)0x80131C42);
	const int CORDBG_E_CANT_CALL_ON_THIS_METHOD = unchecked((int)0x80131C32);
	const int CORDBG_E_ILLEGAL_AT_GC_UNSAFE_POINT2 = unchecked((int)0x80131303);
	const int CORDBG_E_OBJECT_NEUTERED = unchecked((int)0x8013134F);
	const int CORDBG_E_PROCESS_NOT_SYNCHRONIZED = unchecked((int)0x80131302);

	sealed class PendingEval(ICorDebugEval eval, ICorDebugThread thread) {
		public ICorDebugEval Eval { get; } = eval;
		public ICorDebugThread Thread { get; } = thread;
		public TaskCompletionSource<(ICorDebugValue? Value, bool IsException)> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
		public List<(ICorDebugThread Thread, CorDebugThreadState State)> SavedStates { get; } = new();
	}

	PendingEval? pendingEval;

	/// <summary>Set when an evaluation timed out; evaluations are refused until the next stop.</summary>
	string? funcEvalDisabledReason;

	/// <summary>
	/// Counts every continue of the process, including the ones a func-eval makes. A frame or a value read
	/// at an older generation is neutered and has to be read again.
	/// </summary>
	public int Generation { get; private set; }

	/// <summary>Serializes evaluations: one variables request, one watch, one condition at a time.</summary>
	readonly SemaphoreSlim evaluationGate = new(1, 1);

	/// <summary>
	/// The strong handles taken while the process is stopped, released at the next real continue. An object
	/// id keeps its own handle, which is not in here.
	/// </summary>
	readonly List<ICorDebugHandleValue> stopHandles = new();

	/// <summary>True while a func-eval is running, so the callbacks it raises are not mistaken for stops.</summary>
	internal bool IsEvaluating => pendingEval is not null;

	/// <summary>True while the process is held so a breakpoint's condition can be evaluated.</summary>
	bool deciding;

	/// <summary>Set by an event handler that wants the process left stopped after the event.</summary>
	bool holdAfterEvent;

	/// <summary>Takes the evaluation lock for the length of one request.</summary>
	internal async Task<IDisposable> EnterEvaluationAsync(CancellationToken cancellationToken) {
		await evaluationGate.WaitAsync(cancellationToken).ConfigureAwait(false);
		return new Releaser(evaluationGate);
	}

	sealed class Releaser(SemaphoreSlim gate) : IDisposable {
		int released;

		public void Dispose() {
			if (Interlocked.Exchange(ref released, 1) == 0)
				gate.Release();
		}
	}

	/// <summary>A strong handle on a heap value, kept until the process really continues.</summary>
	internal ICorDebugHandleValue? CreateStopHandle(ICorDebugValue heapValue) {
		if (heapValue is not ICorDebugHeapValue2 heap)
			return null;
		try {
			var handle = heap.CreateHandle(CorDebugHandleType.HANDLE_STRONG);
			// A return value read during a step is shown at the stop the step ends in, so its handle outlives
			// the continues in between.
			if (capturingReturnValue)
				returnValueHandles.Add(handle);
			else {
				lock (stopHandles)
					stopHandles.Add(handle);
			}
			return handle;
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return null;
		}
	}

	/// <summary>Releases the handles of the stop that is ending.</summary>
	void ReleaseStopHandles() {
		ICorDebugHandleValue[] handles;
		lock (stopHandles) {
			handles = stopHandles.ToArray();
			stopHandles.Clear();
		}
		foreach (var handle in handles) {
			try {
				handle.Dispose();
			}
			catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
				// The process is gone, and the handle with it.
			}
		}
	}

	/// <summary>
	/// Continues the process. Every continue neuters the values and frames read before it, which is what
	/// <see cref="Generation"/> records; a real one (not a func-eval) also ends the stop, so the handles it
	/// took are released.
	/// </summary>
	void ContinueProcess(bool forEvaluation = false) {
		if (process is null)
			return;
		Generation++;
		if (!forEvaluation) {
			ReleaseStopHandles();
			funcEvalDisabledReason = null;
		}
		try {
			if (!process.IsRunning)
				process.Continue(false);
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			// Already running or already gone.
		}
	}

	/// <summary>
	/// Runs one function evaluation on <paramref name="threadId"/>: <paramref name="start"/> issues the call
	/// on a fresh <see cref="ICorDebugEval"/>, and the result is whatever the runtime reports when it returns.
	/// </summary>
	internal async Task<FuncEvalResult> FuncEvalAsync(int threadId, Action<ICorDebugEval> start, CancellationToken cancellationToken) {
		var pending = await Dispatcher.RunAsync(() => StartFuncEval(threadId, start)).ConfigureAwait(false);
		var completion = pending.Completion.Task;
		try {
			try {
				var (value, isException) = await completion.WaitAsync(FuncEvalTimeout, cancellationToken).ConfigureAwait(false);
				return new FuncEvalResult(value, isException, pending.Eval);
			}
			catch (TimeoutException) {
				await AbortFuncEvalAsync(pending).ConfigureAwait(false);
				throw new EvaluationException("Function evaluation timed out.");
			}
			catch (OperationCanceledException) {
				await AbortFuncEvalAsync(pending).ConfigureAwait(false);
				throw;
			}
		}
		finally {
			await Dispatcher.RunAsync(() => FinishFuncEval(pending)).ConfigureAwait(false);
		}
	}

	PendingEval StartFuncEval(int threadId, Action<ICorDebugEval> start) {
		if (process is null || HasExited)
			throw new EvaluationException("The process has exited.");
		if (!IsStopped && !deciding)
			throw new EvaluationException("Function evaluation can only be done when the process is paused.");
		if (funcEvalDisabledReason is not null)
			throw new EvaluationException(funcEvalDisabledReason);
		if (pendingEval is not null)
			throw new EvaluationException("Function evaluation is already in progress.");
		if (StopReason == StopReasons.Exception && stoppedOnUnhandledException)
			throw new EvaluationException("Cannot evaluate expression because an unhandled exception has occurred.");
		var thread = Threads.Find(threadId) ?? throw new EvaluationException($"There is no thread with id {threadId}.");
		ICorDebugEval eval;
		try {
			eval = thread.CreateEval();
			start(eval);
		}
		catch (COMException ex) {
			throw new EvaluationException(DescribeFuncEvalFailure(ex.HResult), ex);
		}
		var pending = new PendingEval(eval, thread);
		// Every other thread sits still while the call runs, which is how WPF evaluates: a property getter
		// should not let the rest of the program race ahead of the place the user is looking at.
		foreach (var (id, other) in Threads.Snapshot()) {
			try {
				var state = other.DebugState;
				pending.SavedStates.Add((other, state));
				var wanted = id == threadId ? CorDebugThreadState.THREAD_RUN : CorDebugThreadState.THREAD_SUSPEND;
				if (state != wanted)
					other.DebugState = wanted;
			}
			catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
				// A thread that ended since the stop has nothing to suspend.
			}
		}
		pendingEval = pending;
		ContinueProcess(forEvaluation: true);
		return pending;
	}

	void FinishFuncEval(PendingEval pending) {
		if (ReferenceEquals(pendingEval, pending))
			pendingEval = null;
		foreach (var (thread, state) in pending.SavedStates) {
			try {
				if (thread.DebugState != state)
					thread.DebugState = state;
			}
			catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
				// The thread is gone.
			}
		}
	}

	/// <summary>
	/// Aborts a call that ran too long: politely, then rudely, then by stopping the whole process. Whatever
	/// it took, evaluation stays off until the next stop.
	/// </summary>
	async Task AbortFuncEvalAsync(PendingEval pending) {
		funcEvalDisabledReason = "Function evaluation timed out and was disabled. Continue debugging to re-enable it.";
		await Dispatcher.RunAsync(() => {
			try {
				pending.Eval.Abort();
			}
			catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			}
		}).ConfigureAwait(false);
		if (await CompletesWithinAsync(pending.Completion.Task, AbortTimeout).ConfigureAwait(false))
			return;
		await Dispatcher.RunAsync(() => {
			try {
				if (pending.Eval is ICorDebugEval2 eval2)
					eval2.RudeAbort();
			}
			catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			}
		}).ConfigureAwait(false);
		if (await CompletesWithinAsync(pending.Completion.Task, RudeAbortTimeout).ConfigureAwait(false))
			return;
		// The call would not stop: stop the process around it, the way WPF's TryBreakProcesses does.
		await Dispatcher.RunAsync(() => {
			try {
				process?.Stop(0);
			}
			catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			}
			pending.Completion.TrySetResult((null, true));
		}).ConfigureAwait(false);
	}

	static async Task<bool> CompletesWithinAsync(Task task, TimeSpan timeout) {
		try {
			await task.WaitAsync(timeout).ConfigureAwait(false);
			return true;
		}
		catch (TimeoutException) {
			return false;
		}
	}

	/// <summary>Routes the callbacks a running evaluation raises. Returns true when the event was the eval's own.</summary>
	bool HandleEvaluationEvent(CorDebugManagedCallbackEventArgs e) {
		var pending = pendingEval;
		if (pending is null)
			return false;
		switch (e) {
			case EvalCompleteCorDebugManagedCallbackEventArgs complete:
				pending.Completion.TrySetResult((TryGetResult(complete.Eval), false));
				holdAfterEvent = true;
				return true;
			case EvalExceptionCorDebugManagedCallbackEventArgs thrown:
				pending.Completion.TrySetResult((TryGetResult(thrown.Eval), true));
				holdAfterEvent = true;
				return true;
			case ExitProcessCorDebugManagedCallbackEventArgs:
				pending.Completion.TrySetException(new EvaluationException("The process has exited."));
				return false;
			case CustomNotificationCorDebugManagedCallbackEventArgs:
				// The call waits on another thread, which is suspended: it would never return.
				try {
					pending.Eval.Abort();
				}
				catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
				}
				return true;
			default:
				return false;
		}
	}

	static ICorDebugValue? TryGetResult(ICorDebugEval eval) {
		try {
			return eval.Result;
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return null;
		}
	}

	/// <summary>dnSpy's <c>CordbgErrorHelper.GetErrorMessage</c>: the reason a call cannot be made, in words.</summary>
	internal static string DescribeFuncEvalFailure(int hresult) => hresult switch {
		CORDBG_E_ILLEGAL_AT_GC_UNSAFE_POINT or CORDBG_E_ILLEGAL_AT_GC_UNSAFE_POINT2 or CORDBG_E_PROCESS_NOT_SYNCHRONIZED =>
			"Cannot evaluate expression because the code of the current method is optimized or the thread is not at a GC-safe point.",
		CORDBG_E_ILLEGAL_IN_PROLOG => "Cannot evaluate expression because the thread is in a method prolog.",
		CORDBG_E_ILLEGAL_IN_NATIVE_CODE => "Cannot evaluate expression because a native frame is on top of the call stack.",
		CORDBG_E_ILLEGAL_IN_OPTIMIZED_CODE => "Cannot evaluate expression because the code of the current method is optimized.",
		CORDBG_E_FUNC_EVAL_BAD_START_POINT => "Cannot evaluate expression because the thread is stopped at a point where it cannot run code.",
		CORDBG_E_ILLEGAL_IN_STACK_OVERFLOW => "Cannot evaluate expression because of a stack overflow.",
		CORDBG_E_CANT_CALL_ON_THIS_METHOD => "Cannot call this method.",
		CORDBG_E_OBJECT_NEUTERED => "The value is no longer valid.",
		_ => $"Function evaluation failed: HRESULT 0x{hresult:X8}.",
	};
}
