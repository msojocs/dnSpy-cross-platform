using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using dnSpy.Backend.Contracts;
using ICorDebugSharp;
using ICorDebugSharp.Extensions;
using Microsoft.Diagnostics.NETCore.Client;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>A debug event the session wants the client to see.</summary>
internal sealed record SessionEvent(string Event, object? Body);

/// <summary>
/// One debuggee. Owns the ICorDebug process, the tables built from its callbacks, and the
/// command surface the client drives.
/// </summary>
internal sealed partial class CorDebugSession : IAsyncDisposable {
	readonly List<string> recentOutput = new();
	readonly object eventGate = new();

	ICorDebug? corDebug;
	ICorDebugProcess? process;
	CorDebugEventPump? pump;
	Process? debuggee;
	IntPtr unregisterToken;
	bool disposed;

	public string Id { get; } = Guid.NewGuid().ToString("N");

	public CorDebugDispatcher Dispatcher { get; } = new();

	public ModuleTable Modules { get; } = new();

	public ThreadTable Threads { get; } = new();

	public string? WorkspaceId { get; private init; }

	/// <summary>Resolves decompiled-source coordinates to IL identities. May be null.</summary>
	public IDebugSymbolResolver? SymbolResolver { get; private init; }

	/// <summary>The shared exception list a stop decision is read from. May be null in a host without the engine.</summary>
	public ExceptionSettingsService? ExceptionSettings { get; private init; }

	/// <summary>Absolute path of the program being launched, used to recognise its module.</summary>
	public string? LaunchProgram { get; private init; }

	/// <summary>True when the launch asked for a stop during startup.</summary>
	public bool StopAtEntry { get; private init; }

	/// <summary>The startup location requested by the client, including the WPF-compatible module cctor option.</summary>
	public string? BreakKind { get; private init; }

	/// <summary>
	/// True while a launch is being held back until the client has armed its breakpoints.
	///
	/// A launch that does not stop during startup has no stop of its own before user code, and
	/// the debuggee reaches it in the time the launch request itself takes to come back — a client
	/// that armed breakpoints afterwards would be arming them at a program that had already run.
	/// So the target is left suspended where the runtime stopped it and released by
	/// <c>configurationDone</c>. A launch that does break during startup needs none of this: the
	/// startup breakpoint is already a stop the client can arm behind.
	/// </summary>
	bool awaitingConfiguration;

	/// <summary>The debuggee PID, once known.</summary>
	public int TargetProcessId { get; private set; }

	/// <summary>
	/// True when this session started the debuggee and is therefore responsible for reaping it;
	/// an attached process is left running.
	/// </summary>
	public bool OwnsDebuggee { get; private init; }

	public bool IsStopped { get; private set; }

	public string? StopReason { get; private set; }

	public int? StoppedThreadId { get; private set; }

	public event EventHandler<SessionEvent>? EventReceived;

	SessionEvent? pendingStoppedEvent;

	public bool HasExited { get; private set; }

	internal SessionEvent? TakePendingStoppedEvent() {
		lock (eventGate) {
			var pending = pendingStoppedEvent;
			pendingStoppedEvent = null;
			return pending;
		}
	}

	// ---------------------------------------------------------------- lifecycle

	public static async Task<CorDebugSession> LaunchAsync(DebugLaunchRequest request, IDebugSymbolResolver? symbols, ExceptionSettingsService? exceptionSettings, DebuggerEngineOptions options, CancellationToken cancellationToken) {
		var program = Path.GetFullPath(request.Program);
		if (!File.Exists(program))
			throw new RpcException(ErrorCodes.FileNotFound, $"Debug target does not exist: {request.Program}");

		var breakKind = GetBreakKind(request);
		var session = new CorDebugSession {
			WorkspaceId = request.WorkspaceId,
			SymbolResolver = symbols,
			ExceptionSettings = exceptionSettings,
			Options = options,
			LaunchProgram = program,
			BreakKind = breakKind,
			StopAtEntry = breakKind is not null,
			OwnsDebuggee = true,
		};
		// Held until the client is done arming breakpoints; see awaitingConfiguration.
		session.awaitingConfiguration = !session.StopAtEntry;
		Process? child = null;
		RuntimeStartup.State? startup = null;
		try {
			var launchCommand = GetLaunchCommand(request, program);
			var startInfo = new ProcessStartInfo {
				FileName = launchCommand.FileName,
				WorkingDirectory = request.WorkingDirectory ?? Path.GetDirectoryName(program) ?? Environment.CurrentDirectory,
				UseShellExecute = false,
				// The debuggee must not inherit the host's stdio: stdin is the JSON-RPC request
				// stream and stdout is the response stream, so any write from the debuggee would
				// corrupt the protocol. Both are redirected and drained into output events.
				RedirectStandardInput = true,
				RedirectStandardOutput = true,
				RedirectStandardError = true,
			};
			foreach (var argument in launchCommand.Arguments)
				startInfo.ArgumentList.Add(argument);
			foreach (var argument in request.Arguments ?? [])
				startInfo.ArgumentList.Add(argument);
			// Suspends the runtime at startup so the debugger can attach before any user code runs.
			startInfo.Environment["DOTNET_DefaultDiagnosticPortSuspend"] = "1";
			// WPF's launch: with JIT optimization suppressed for system modules, precompiled framework code is
			// not used either, so the framework is jitted the way the flags ask for.
			if (options.SuppressJitOptimizationSystemModules) {
				startInfo.Environment["DOTNET_ReadyToRun"] = "0";
				startInfo.Environment["COMPlus_ReadyToRun"] = "0";
			}
			foreach (var (key, value) in request.Environment ?? new Dictionary<string, string>())
				startInfo.Environment[key] = value;

			child = Process.Start(startInfo) ?? throw new RpcException(ErrorCodes.InternalError, "Could not start the debug target.");
			session.debuggee = child;
			session.TargetProcessId = child.Id;
			child.StandardInput.Close();
			session.HookOutput(child);

			// Registration must happen before the runtime is resumed, or the startup callback is lost.
			startup = new RuntimeStartup.State();
			session.unregisterToken = RuntimeStartup.Register((uint)child.Id, startup);
			await ResumeRuntimeAsync(child.Id, cancellationToken).ConfigureAwait(false);

			var (corDebug, hResult) = await startup.Completion.Task
				.WaitAsync(TimeSpan.FromSeconds(30), cancellationToken)
				.ConfigureAwait(false);
			if (corDebug is null || hResult < 0)
				throw new RpcException(ErrorCodes.InternalError, $"The runtime did not start: 0x{hResult:X8}");

			await session.AttachCorDebugAsync(corDebug, child.Id).ConfigureAwait(false);
			startup.Release();
			session.Emit(DebugEventNames.Process, new { systemProcessId = child.Id, name = Path.GetFileName(program) });
			return session;
		}
		catch {
			// Unblock the native startup callback when attach or cancellation fails.
			startup?.Release();
			await session.DisposeAsync().ConfigureAwait(false);
			throw;
		}
	}

	static string? GetBreakKind(DebugLaunchRequest request) {
		return request.BreakKind switch {
			"DontBreak" => null,
			"CreateProcess" => "CreateProcess",
			"EntryPoint" => "EntryPoint",
			"ModuleCctorOrEntryPoint" => "ModuleCctorOrEntryPoint",
			_ when request.StopAtEntry => "EntryPoint",
			_ => null,
		};
	}

	/// <summary>The host a framework-dependent assembly is started through when the dialog leaves the
	/// host path empty — the <c>dotnet</c> CLI on <c>PATH</c>. WPF looks up the machine's installed
	/// host instead; on Linux the CLI that is on <c>PATH</c> is the one that can run the target.</summary>
	const string DefaultDotNetHost = "dotnet";

	/// <summary>
	/// Resolves the process command for a managed debug target, mirroring the upstream CoreCLR page's
	/// "Use host executable" choice. With a host the target is started as <c>host hostArgs program
	/// args</c> — the same line the WPF engine builds (<c>"host" hostArgs "filename" args</c>) — and
	/// an empty host path falls back to the <c>dotnet</c> CLI. Without one the program is run
	/// directly: an apphost (including Linux apphosts without an extension) on its own, since handing
	/// one to <c>dotnet</c> makes the CLI look for a managed assembly with that native file name and
	/// produces the misleading "dotnet-&lt;path&gt; does not exist" error. A request that never made
	/// the choice keeps the extension guess this engine grew up with: .dll through the host,
	/// anything else directly.
	/// </summary>
	static (string FileName, IReadOnlyList<string> Arguments) GetLaunchCommand(DebugLaunchRequest request, string program) {
		var useHost = request.UseHost ?? string.Equals(Path.GetExtension(program), ".dll", StringComparison.OrdinalIgnoreCase);
		if (!useHost)
			return (program, []);

		var host = string.IsNullOrWhiteSpace(request.Host) ? DefaultDotNetHost : request.Host;
		var arguments = new List<string>(request.HostArguments ?? []);
		arguments.Add(program);
		return (host, arguments);
	}

	public static async Task<CorDebugSession> AttachAsync(int processId, string? workspaceId, IDebugSymbolResolver? symbols, ExceptionSettingsService? exceptionSettings, DebuggerEngineOptions options, CancellationToken cancellationToken) {
		if (processId <= 0)
			throw new RpcException(ErrorCodes.InvalidParams, "A positive process ID is required.");
		// DebugActiveProcess resumes the target, so the CLR interfaces have to be obtained first.
		var corDebug = await Task.Run(() => CreateInterfaceForProcess(processId), cancellationToken).ConfigureAwait(false);
		var session = new CorDebugSession {
			WorkspaceId = workspaceId,
			SymbolResolver = symbols,
			ExceptionSettings = exceptionSettings,
			Options = options,
			TargetProcessId = processId,
		};
		try {
			session.debuggee = TryOpenProcess(processId);
			if (session.debuggee is not null)
				session.HookOutput(session.debuggee);
			await session.AttachCorDebugAsync(corDebug, processId).ConfigureAwait(false);
			return session;
		}
		catch {
			await session.DisposeAsync().ConfigureAwait(false);
			throw;
		}
	}

	async Task AttachCorDebugAsync(ICorDebug corDebugInstance, int processId) {
		corDebug = corDebugInstance;
		corDebug.Initialize();
		pump = new CorDebugEventPump(this);
		corDebug.SetManagedHandler(pump.Callbacks);
		process = corDebug.DebugActiveProcess(processId, false);
		TargetProcessId = processId;
		IsStopped = false;
		// Events delivered while DebugActiveProcess ran are already queued; draining starts now so
		// every one of them is answered with a Continue.
		pump.Start();
		await SeedThreadsAsync().ConfigureAwait(false);
	}

	/// <summary>
	/// Files the threads the process already had. The runtime announces every thread from here on, but
	/// the ones that predate the debugger are only in the process's own list — and on attach that is
	/// all of them, while the client asks for a thread to stop on as soon as it is connected.
	/// </summary>
	async Task SeedThreadsAsync() {
		if (process is null)
			return;
		await Dispatcher.RunAsync(() => {
			try {
				// The process's own list is in no particular order; the lowest id is the main thread, which
				// is the one the Threads window lists first.
				foreach (var thread in process.EnumerateThreads().OrderBy(thread => ThreadTable.TryGetId(thread) ?? int.MaxValue))
					Threads.Add(thread);
			}
			catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
				// A thread that went away between the enumeration and the read is not worth reporting.
			}
		}).ConfigureAwait(false);
	}

	static async Task ResumeRuntimeAsync(int processId, CancellationToken cancellationToken) {
		var client = new DiagnosticsClient(processId);
		for (var attempt = 1; ; attempt++) {
			try {
				client.ResumeRuntime();
				return;
			}
			catch (ServerNotAvailableException) when (attempt < 20) {
				// The runtime has not opened its diagnostic port yet.
			}
			catch (ServerErrorException) {
				// Already resumed: nothing left to release.
				return;
			}
			await Task.Delay(50, cancellationToken).ConfigureAwait(false);
		}
	}

	/// <summary>
	/// Behind <c>CreateDebuggingInterfaceFromVersionEx</c> on Linux are two quirks that cost real
	/// debugging time, so they are spelled out here:
	/// <list type="bullet">
	/// <item>the version argument has to be in 3..5; the Windows <c>CorDebugVersion</c> constants
	/// (1 and 2) are rejected with <c>E_INVALIDARG</c>.</item>
	/// <item>the version <em>string</em> is not the module path that <c>EnumerateCLRs</c> hands
	/// back — that path has to go through <c>CreateVersionStringFromModule</c> first.</item>
	/// </list>
	/// </summary>
	const int DebuggerVersion = 4;

	static ICorDebug CreateInterfaceForProcess(int processId) {
		var hr = DbgShim.EnumerateCLRs((uint)processId, out var handleArray, out var stringArray, out var count);
		if (hr < 0)
			throw new RpcException(ErrorCodes.InvalidParams, $"Could not enumerate the CLR instances in process {processId}: 0x{hr:X8}");
		if (count == 0)
			throw new RpcException(ErrorCodes.InvalidParams, $"No CLR was found in process {processId}.");
		try {
			var buffer = new char[512];
			for (var i = 0; i < (int)count; i++) {
				var modulePath = Marshal.PtrToStringUni(Marshal.ReadIntPtr(stringArray, i * IntPtr.Size));
				if (string.IsNullOrEmpty(modulePath))
					continue;
				var versionHr = DbgShim.CreateVersionStringFromModule((uint)processId, modulePath, buffer, (uint)buffer.Length, out var length);
				if (versionHr < 0)
					continue;
				var version = new string(buffer, 0, (int)Math.Min(length, (uint)buffer.Length)).TrimEnd('\0');
				if (DbgShim.CreateDebuggingInterfaceFromVersionEx(DebuggerVersion, version, out var corDebug) >= 0 && corDebug is not null)
					return corDebug;
			}
		}
		finally {
			DbgShim.CloseCLREnumeration(handleArray, stringArray, count);
		}
		throw new RpcException(ErrorCodes.InternalError, $"Could not attach to the CLR in process {processId}.");
	}

	static Process? TryOpenProcess(int processId) {
		try {
			return Process.GetProcessById(processId);
		}
		catch (ArgumentException) {
			return null;
		}
	}

	void HookOutput(Process child) {
		child.OutputDataReceived += (_, e) => EmitOutput(e.Data, "stdout");
		child.ErrorDataReceived += (_, e) => EmitOutput(e.Data, "stderr");
		child.EnableRaisingEvents = true;
		try {
			child.BeginOutputReadLine();
			child.BeginErrorReadLine();
		}
		catch (InvalidOperationException) {
			// Attached process: its streams are not redirected.
		}
	}

	void EmitOutput(string? line, string category) {
		if (line is null)
			return;
		Emit(DebugEventNames.Output, new { category, output = line + "\n" });
	}

	// ---------------------------------------------------------------- event handlers

	/// <summary>
	/// Runs on the dispatcher for every event the runtime raises. Events the engine does not care
	/// about fall through; <see cref="AfterEventProcessed"/> still resumes the process afterwards.
	/// </summary>
	public void HandleEvent(CorDebugManagedCallbackEventArgs e) {
		// A running func-eval owns the process: its completion is the only stop it can produce, and anything
		// else the call raises on the way is answered by AfterEventProcessed with another Continue.
		if (HandleEvaluationEvent(e))
			return;
		switch (e) {
			case CreateProcessCorDebugManagedCallbackEventArgs:
				EnableLogMessages();
				if (BreakKind == "CreateProcess") {
					if (process is not null) {
						try {
							foreach (var thread in process.EnumerateThreads())
								Threads.Add(thread);
						}
						catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
							// The runtime may not expose the main thread until the callback has returned.
						}
					}
					var threads = Threads.Snapshot();
					if (threads.Count > 0) {
						Stop(StopReasons.CreateProcess, threads[0].Thread);
					}
					// else: defer until CreateThread arrives; see the CreateThread handler below.
				}
				break;
			case CreateThreadCorDebugManagedCallbackEventArgs createThread:
				Threads.Add(createThread.Thread);
				Emit(DebugEventNames.Thread, new { reason = "started", threadId = ThreadTable.TryGetId(createThread.Thread) });
				// If we're breaking at CreateProcess and didn't have a thread yet, emit the stopped event now.
				if (BreakKind == "CreateProcess" && !IsStopped) {
					Stop(StopReasons.CreateProcess, createThread.Thread);
				}
				break;
			case ExitThreadCorDebugManagedCallbackEventArgs exitThread:
				Emit(DebugEventNames.Thread, new { reason = "exited", threadId = ThreadTable.TryGetId(exitThread.Thread), exitCode = 0 });
				Threads.Remove(exitThread.Thread);
				break;
			case LoadModuleCorDebugManagedCallbackEventArgs loadModule:
				Modules.Add(loadModule.Module);
				OnModuleLoadedCore(loadModule.Module);
				OnModuleLoaded(loadModule.Module);
				ArmEntryBreakpoint(loadModule.Module);
				break;
			case UnloadModuleCorDebugManagedCallbackEventArgs unloadModule:
				OnModuleUnloading(unloadModule.Module);
				Modules.Remove(unloadModule.Module);
				break;
			case BreakpointCorDebugManagedCallbackEventArgs hit:
				if (!IsEvaluating)
					OnBreakpointHit(hit.Breakpoint, hit.Thread);
				break;
			case StepCompleteCorDebugManagedCallbackEventArgs step:
				if (!IsEvaluating)
					OnStepComplete(step.Thread);
				break;
			case BreakCorDebugManagedCallbackEventArgs pause:
				// Debugger.Break() and the IL break instruction. The options can tell the engine to run past
				// them, which is what "Ignore Debugger.Break() and break instructions" means.
				if (!IsEvaluating && !Options.IgnoreBreakInstructions)
					Stop(StopReasons.UserBreak, pause.Thread);
				break;
			case LogMessageCorDebugManagedCallbackEventArgs log:
				OnLogMessage(log);
				break;
			case NameChangeCorDebugManagedCallbackEventArgs nameChange:
				OnNameChange(nameChange);
				break;
			case CreateAppDomainCorDebugManagedCallbackEventArgs createAppDomain:
				try {
					createAppDomain.AppDomain.Attach();
				}
				catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
				}
				break;
			case BreakpointSetErrorCorDebugManagedCallbackEventArgs error:
				OnBreakpointSetError(error.Breakpoint, error.DwError);
				break;
			case Exception2CorDebugManagedCallbackEventArgs exception:
				if (!IsEvaluating)
					OnExceptionThrown(exception);
				break;
			case DebuggerErrorCorDebugManagedCallbackEventArgs debuggerError:
				DebugLog.Error("debugger-error", new COMException($"The debugger reported error 0x{debuggerError.ErrorCode:X8}.", debuggerError.ErrorHR));
				break;
			case ExitProcessCorDebugManagedCallbackEventArgs:
				HasExited = true;
				IsStopped = false;
				var exitCode = TryGetExitCode();
				Emit(DebugEventNames.Exited, new { exitCode });
				Emit(DebugEventNames.Terminated, new { restart = false });
				break;
		}
	}

	int? TryGetExitCode() {
		try {
			return debuggee?.HasExited == true ? debuggee.ExitCode : null;
		}
		catch (InvalidOperationException) {
			return null;
		}
	}

	void Stop(string reason, ICorDebugThread? thread, string? breakpointId = null, IReadOnlyDictionary<string, object?>? extra = null) {
		// A stop ends whatever step was in flight — the step's own breakpoint hitting is one way for
		// it to end — and the frames and values the previous stop handed out die with it: their COM
		// objects belong to a suspension that no longer exists.
		CancelStepping();
		ClearRunToCursor();
		frameTable.Clear();
		variableTable.Clear();
		IsStopped = true;
		StopReason = reason;
		stoppedOnUnhandledException = extra is not null && extra.TryGetValue("unhandled", out var unhandled) && unhandled is true;
		StoppedThreadId = thread is null ? null : ThreadTable.TryGetId(thread);
		OnStopped(thread);
		var body = new Dictionary<string, object?>(StringComparer.Ordinal) {
			["reason"] = reason,
			["threadId"] = StoppedThreadId,
			["allThreadsStopped"] = true,
			["hitBreakpointIds"] = breakpointId is null ? [] : new[] { breakpointId },
		};
		// An exception stop says which exception and whether it was handled, so the client can show
		// more than "stopped: exception".
		if (extra is not null) {
			foreach (var (key, value) in extra)
				body[key] = value;
		}
		Emit(DebugEventNames.Stopped, body);
	}

	/// <summary>
	/// Called after every callback. The runtime delivers no further events while the debuggee is
	/// suspended, so anything not deliberately stopped must be resumed immediately.
	/// </summary>
	public void AfterEventProcessed() {
		var hold = holdAfterEvent;
		holdAfterEvent = false;
		if (HasExited || process is null || hold)
			return;
		// A func-eval keeps running through every callback the call raises; only its completion stops it.
		if (pendingEval is not null) {
			ContinueProcess(forEvaluation: true);
			return;
		}
		if (IsStopped || deciding || awaitingConfiguration)
			return;
		ContinueProcess();
	}

	/// <summary>True when the current stop is an exception nothing caught; the runtime refuses func-eval then.</summary>
	bool stoppedOnUnhandledException;

	// Implemented in CorDebugSession.Breakpoints.cs, which is where the breakpoint table lives.
	partial void OnModuleLoaded(ICorDebugModule module);

	partial void OnBreakpointHit(ICorDebugBreakpoint breakpoint, ICorDebugThread thread);

	partial void OnBreakpointSetError(ICorDebugBreakpoint breakpoint, uint dwError);

	// Implemented in CorDebugSession.Exceptions.cs, which is where the exception list lives.
	partial void OnExceptionThrown(Exception2CorDebugManagedCallbackEventArgs exception);

	// ---------------------------------------------------------------- commands

	public async Task<JsonElement> ExecuteAsync(string command, JsonElement? arguments, CancellationToken cancellationToken) {
		// Breakpoint requests resolve source coordinates to IL first, which means decompiling, and
		// that must not happen on the dispatcher: the debuggee is suspended while it runs, but the
		// event pump would stop draining callbacks until it finished. Everything else is cheap and
		// touches COM state, so it stays serialised on the dispatcher.
		switch (command) {
			case "setBreakpoints":
				return await SetBreakpointsAsync(arguments, cancellationToken).ConfigureAwait(false);
			case "setFunctionBreakpoints":
				return await SetFunctionBreakpointsAsync(arguments, cancellationToken).ConfigureAwait(false);
			// The stack and the values in it are only named by the resolver, which decompiles; that
			// has to happen off the dispatcher for the same reason breakpoint resolution does.
			case "stackTrace":
				return await StackTraceAsync(arguments, cancellationToken).ConfigureAwait(false);
			case "frameLocation":
				return await FrameLocationAsync(arguments, cancellationToken).ConfigureAwait(false);
			case "variables":
				return await VariablesAsync(arguments, cancellationToken).ConfigureAwait(false);
			// Evaluation makes func-evals, which are continues: the event pump has to keep running under them.
			case "evaluate":
				return await EvaluateRequestAsync(arguments, cancellationToken).ConfigureAwait(false);
			case "setExpression":
				return await SetExpressionAsync(arguments, cancellationToken).ConfigureAwait(false);
			case "staticFields":
				return await StaticFieldsAsync(arguments, cancellationToken).ConfigureAwait(false);
			case "makeObjectId":
				return await MakeObjectIdAsync(arguments, cancellationToken).ConfigureAwait(false);
			case "deleteObjectId":
				return await DeleteObjectIdAsync(arguments).ConfigureAwait(false);
			case "setNextStatement":
				return await SetNextStatementAsync(arguments, cancellationToken).ConfigureAwait(false);
			case "runToFrame":
				return await RunToFrameAsync(arguments).ConfigureAwait(false);
			case "setModuleBreakpoints":
				return SetModuleBreakpoints(arguments);
			case "runToCursor":
				return await RunToCursorAsync(arguments, cancellationToken).ConfigureAwait(false);
			case "autos":
				return await AutosAsync(arguments, cancellationToken).ConfigureAwait(false);
			case "disassemble":
				return await DisassembleAsync(arguments, cancellationToken).ConfigureAwait(false);
			case "readMemory":
				return await ReadMemoryAsync(arguments).ConfigureAwait(false);
			case "writeMemory":
				return await WriteMemoryAsync(arguments).ConfigureAwait(false);
			case "saveModule":
				return await SaveModuleAsync(arguments).ConfigureAwait(false);
			// A step picks its landing sites before it resumes, so it decompiles too.
			case "next":
			case "stepIn":
			case "stepOut":
				return await StepAsync(command, arguments, cancellationToken).ConfigureAwait(false);
			default:
				return await Dispatcher.RunAsync(() => Execute(command, arguments, cancellationToken)).ConfigureAwait(false);
		}
	}

	JsonElement Execute(string command, JsonElement? arguments, CancellationToken cancellationToken) {
		cancellationToken.ThrowIfCancellationRequested();
		switch (command) {
			case "configurationDone":
				// The client's breakpoints are in place, so the target may run: this is the release for
				// a launch that was held because it does not break during startup.
				if (awaitingConfiguration) {
					awaitingConfiguration = false;
					ResumeProcess();
				}
				return EmptyJson();
			case "continue":
				return Continue();
			case "pause":
				return Pause();
			case "threads":
				return ThreadsResponse();
			case "modules":
				return ModulesResponse();
			case "freezeThread":
				return FreezeThread(arguments);
			case "renameThread":
				return RenameThread(arguments);
			case "process":
				return ProcessResponse();
			case "scopes":
				return Scopes(arguments);
			// stackTrace, variables and the step commands are answered in ExecuteAsync: every one of
			// them needs the symbol resolver, which must not run while the event pump is held.
			default:
				throw new RpcException(ErrorCodes.InvalidParams, $"Unknown debug command: {command}");
		}
	}

	JsonElement Continue() {
		if (process is null || HasExited)
			return EmptyJson();
		CancelStepping();
		ClearReturnValues();
		ResumeProcess();
		return EmptyJson();
	}

	/// <summary>
	/// Marks the process running again and tells the client it has. The caller decides what to
	/// cancel first: <c>continue</c> drops any step in flight, while a step keeps the breakpoints it
	/// has just armed.
	/// </summary>
	void ResumeProcess() {
		IsStopped = false;
		StopReason = null;
		StoppedThreadId = null;
		frameTable.Clear();
		variableTable.Clear();
		Emit(DebugEventNames.Continued, new { threadId = (int?)null, allThreadsContinued = true });
		ContinueProcess();
	}

	JsonElement Pause() {
		if (process is null || HasExited)
			return EmptyJson();
		// The timeout argument is ignored by the runtime (hence its name). WPF passes uint.MaxValue
		// here, but the generated interop rejects a negative int, so pass 0.
		process.Stop(0);
		// A debugger-requested break does not raise a Break callback on Linux, so the stopped
		// state is recorded here instead of waiting for one. WPF does the same: TryBreakProcesses
		// calls Stop and then marks the process stopped itself.
		if (!IsStopped) {
			var threads = Threads.Snapshot();
			Stop(StopReasons.Pause, threads.Count == 0 ? null : threads[0].Thread);
		}
		return EmptyJson();
	}

	JsonElement ModulesResponse() {
		var entries = Modules.Entries();
		return DebugJson.Serialize(new {
			modules = entries.Select(DescribeModule).ToArray(),
			totalModules = entries.Count,
		});
	}

	static JsonElement EmptyJson() => DebugJson.Serialize(new { });

	// ---------------------------------------------------------------- shutdown

	public async Task DisconnectAsync(bool terminateDebuggee, CancellationToken cancellationToken) {
		await Dispatcher.RunAsync(() => {
			CancelStepping();
			breakpoints.Clear();
			Modules.Clear();
			Threads.Clear();
			frameTable.Clear();
			variableTable.Clear();
			if (process is not null && !HasExited) {
				try {
					if (terminateDebuggee)
						process.Terminate(0);
					else
						process.Detach();
				}
				catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
					// The debuggee is already gone.
				}
			}
		}).ConfigureAwait(false);
		await DisposeAsync().ConfigureAwait(false);
	}

	public async ValueTask DisposeAsync() {
		if (disposed)
			return;
		disposed = true;
		if (unregisterToken != IntPtr.Zero) {
			DbgShim.UnregisterForRuntimeStartup(unregisterToken);
			unregisterToken = IntPtr.Zero;
		}
		pump?.Dispose();
		pump = null;
		try {
			corDebug?.Terminate();
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			// Nothing left to terminate.
		}
		corDebug = null;
		process = null;
		KillDebuggee();
		Dispatcher.Dispose();
		await Task.CompletedTask.ConfigureAwait(false);
	}

	void KillDebuggee() {
		if (debuggee is null)
			return;
		// A detached debuggee keeps running; only a process we started is ours to reap.
		if (!OwnsDebuggee) {
			debuggee.Dispose();
			debuggee = null;
			return;
		}
		try {
			if (!debuggee.HasExited)
				debuggee.Kill(entireProcessTree: true);
		}
		catch (Exception ex) when (ex is InvalidOperationException or NotSupportedException or System.ComponentModel.Win32Exception) {
			// Already gone.
		}
		finally {
			debuggee.Dispose();
			debuggee = null;
		}
	}

	void Emit(string eventName, object? body) {
		var sessionEvent = new SessionEvent(eventName, body);
		EventHandler<SessionEvent>? handler;
		lock (eventGate) {
			handler = EventReceived;
			if (handler is null && eventName == DebugEventNames.Stopped)
				pendingStoppedEvent = sessionEvent;
		}
		handler?.Invoke(this, sessionEvent);
	}

	/// <summary>Records a line of debuggee output for <c>disconnect</c> diagnostics.</summary>
	public void NoteOutput(string line) {
		lock (recentOutput) {
			recentOutput.Add(line);
			if (recentOutput.Count > 100)
				recentOutput.RemoveAt(0);
		}
	}
}
