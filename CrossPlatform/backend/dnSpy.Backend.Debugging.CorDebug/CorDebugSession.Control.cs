using System.Text.Json;
using dnSpy.Backend.Contracts;
using ICorDebugSharp;
using ICorDebugSharp.Extensions;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>
/// Moving the stopped thread rather than stepping it: Set Next Statement, which moves the instruction pointer
/// within the method, and the Call Stack window's Run To Cursor, which runs until a caller frame is returned to.
/// </summary>
internal sealed partial class CorDebugSession {
	/// <summary>The one-shot breakpoint a Run To Cursor waits on, and the thread it is for.</summary>
	(ICorDebugFunctionBreakpoint Breakpoint, int ThreadId)? runToCursor;

	/// <summary>
	/// <c>setNextStatement</c>: dnSpy's <c>DbgThread.SetIP</c> — the thread's top frame continues from another
	/// statement of the same method. The location is the statement under the editor's caret, resolved the way
	/// a breakpoint on that line would be, or an IL location the client already knows.
	/// </summary>
	internal async Task<JsonElement> SetNextStatementAsync(JsonElement? arguments, CancellationToken cancellationToken) {
		var args = arguments is { ValueKind: JsonValueKind.Object } value ? value : default;
		var threadId = GetInt(args, "threadId") ?? StoppedThreadId ?? throw new RpcException(ErrorCodes.InvalidParams, "There is no thread to move.");
		var (modulePath, token, offset) = await ResolveCodeLocationAsync(args, cancellationToken).ConfigureAwait(false);
		var error = await Dispatcher.RunAsync(() => {
			if (!IsStopped)
				return RunningReason;
			var frame = GetFrame(threadId, 0) as ICorDebugILFrame;
			if (frame is null)
				return "The thread is not stopped in managed code.";
			var (frameModule, frameToken) = FrameIdentity(frame);
			if (frameToken != token || !BreakpointTable.PathsMatch(frameModule, modulePath))
				return "The next statement can only be set within the current method.";
			if (frame.TryCanSetIP((uint)offset) < 0)
				return "Unable to set the next statement to this location.";
			var hr = frame.TrySetIP((uint)offset);
			if (hr < 0)
				return $"Unable to set the next statement to this location (HRESULT 0x{hr:X8}).";
			// The frames read before the move describe where the thread was; the client reads them again.
			Generation++;
			frameTable.Clear();
			variableTable.Clear();
			Stop(StopReason ?? StopReasons.Step, Threads.Find(threadId));
			return null;
		}).ConfigureAwait(false);
		if (error is not null)
			throw new RpcException(ErrorCodes.InvalidParams, error);
		return EmptyJson();
	}

	/// <summary>
	/// An IL location from a request: <c>modulePath</c>/<c>metadataToken</c>/<c>ilOffset</c> as they are, or
	/// <c>nodeId</c>/<c>line</c>/<c>column</c> snapped to the statement a breakpoint there would bind to.
	/// </summary>
	async Task<(string ModulePath, int MetadataToken, int IlOffset)> ResolveCodeLocationAsync(JsonElement args, CancellationToken cancellationToken) {
		if (GetString(args, "modulePath") is { } path && GetInt(args, "metadataToken") is { } knownToken && GetInt(args, "ilOffset") is { } knownOffset && GetString(args, "nodeId") is null)
			return (path, knownToken, knownOffset);
		if (SymbolResolver is null || WorkspaceId is null)
			throw new RpcException(ErrorCodes.InvalidParams, NoWorkspaceReason);
		var query = new BreakpointQuery("location", GetString(args, "nodeId") ?? string.Empty, GetInt(args, "line") ?? 0, GetInt(args, "column"),
			GetString(args, "modulePath"), GetInt(args, "metadataToken"), GetInt(args, "sourceMethodToken"), GetInt(args, "ilOffset"));
		var response = await SymbolResolver.ResolveBreakpointsAsync(WorkspaceId, [query], cancellationToken).ConfigureAwait(false);
		var resolved = response.Breakpoints.FirstOrDefault();
		if (resolved is not { Bound: true, ModulePath: { } modulePath, MetadataToken: { } token, IlOffset: { } offset })
			throw new RpcException(ErrorCodes.InvalidParams, resolved?.Reason ?? "There is no statement at this location.");
		return (modulePath, token, offset);
	}

	/// <summary>
	/// <c>runToFrame</c>: the Call Stack window's Run To Cursor — the process runs until the selected caller
	/// frame is returned to. A native breakpoint goes on the frame's return address, which is exactly where its
	/// next statement continues, and is removed by the first stop whatever stopped it.
	/// </summary>
	internal async Task<JsonElement> RunToFrameAsync(JsonElement? arguments) {
		var args = arguments is { ValueKind: JsonValueKind.Object } value ? value : default;
		var frameId = GetInt(args, "frameId") ?? throw new RpcException(ErrorCodes.InvalidParams, "A frame is required.");
		var entry = frameTable.Find(frameId) ?? throw new RpcException(ErrorCodes.InvalidParams, $"There is no frame with id {frameId}; it belongs to an earlier stop.");
		await Dispatcher.RunAsync(() => {
			var frame = GetFrame(entry.ThreadId, entry.Index) ?? throw new RpcException(ErrorCodes.InvalidParams, "The frame is no longer available.");
			if (frame is not ICorDebugNativeFrame native || native.TryGetIP(out var nativeOffset) < 0)
				throw new RpcException(ErrorCodes.InvalidParams, "The frame has no native code to run to.");
			if (frame.Function.TryGetNativeCode(out var code) < 0 || code is null)
				throw new RpcException(ErrorCodes.InvalidParams, "The frame has no native code to run to.");
			ClearRunToCursor();
			var breakpoint = code.CreateBreakpoint((int)nativeOffset);
			breakpoint.Activate(true);
			runToCursor = (breakpoint, entry.ThreadId);
			CancelStepping();
			ResumeProcess();
			return true;
		}).ConfigureAwait(false);
		return EmptyJson();
	}

	/// <summary>
	/// <c>runToCursor</c>: the editor's Run To Cursor — dnSpy's temporary breakpoint on the statement under the caret,
	/// on any thread, then Continue. Like the Call Stack's, it is gone at the first stop, whatever stopped it.
	/// </summary>
	internal async Task<JsonElement> RunToCursorAsync(JsonElement? arguments, CancellationToken cancellationToken) {
		var args = arguments is { ValueKind: JsonValueKind.Object } value ? value : default;
		var (modulePath, token, offset) = await ResolveCodeLocationAsync(args, cancellationToken).ConfigureAwait(false);
		await Dispatcher.RunAsync(() => {
			if (!IsStopped)
				throw new RpcException(ErrorCodes.InvalidParams, RunningReason);
			var module = Modules.Find(modulePath) ?? throw new RpcException(ErrorCodes.InvalidParams, "The module is not loaded in the process.");
			var function = module.GetFunctionFromToken(token);
			ClearRunToCursor();
			var breakpoint = function.ILCode.CreateBreakpoint(offset);
			breakpoint.Activate(true);
			runToCursor = (breakpoint, AnyThread);
			CancelStepping();
			ResumeProcess();
			return true;
		}).ConfigureAwait(false);
		return EmptyJson();
	}

	/// <summary>The thread a Run To Cursor from the editor waits for: whichever reaches the statement first.</summary>
	const int AnyThread = -1;

	/// <summary>True when a breakpoint hit is the Run To Cursor's own; it stops as such and is gone.</summary>
	bool IsRunToCursorHit(ICorDebugBreakpoint breakpoint, ICorDebugThread thread) {
		if (runToCursor is not { } pending || breakpoint is not ICorDebugFunctionBreakpoint hit)
			return false;
		try {
			var same = hit.Function.Token == pending.Breakpoint.Function.Token && hit.Offset == pending.Breakpoint.Offset;
			// Another thread passing the same code is not the frame the user picked.
			return same && (pending.ThreadId == AnyThread || ThreadTable.TryGetId(thread) == pending.ThreadId);
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return false;
		}
	}

	void ClearRunToCursor() {
		if (runToCursor is not { } pending)
			return;
		runToCursor = null;
		try {
			pending.Breakpoint.Activate(false);
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
		}
	}
}
