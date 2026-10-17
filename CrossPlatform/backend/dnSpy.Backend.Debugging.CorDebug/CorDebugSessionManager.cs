using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>
/// Hosts the debug sessions of the in-process ICorDebug engine. Shaped like the DAP manager it
/// replaces so the host only has to change its <c>using</c>.
/// </summary>
public sealed class CorDebugSessionManager : IAsyncDisposable {
	/// <summary>
	/// Commands the client may send. <c>source</c> is absent on purpose: breakpoints and stack
	/// frames are resolved against the decompiled text the client already has.
	/// </summary>
	static readonly HashSet<string> AllowedCommands = new(StringComparer.Ordinal) {
		"setBreakpoints",
		"setFunctionBreakpoints",
		"configurationDone",
		"continue",
		"pause",
		"next",
		"stepIn",
		"stepOut",
		"threads",
		"stackTrace",
		"frameLocation",
		"scopes",
		"variables",
		"evaluate",
		"setExpression",
		"staticFields",
		"makeObjectId",
		"deleteObjectId",
		"setNextStatement",
		"runToFrame",
		"runToCursor",
		"setModuleBreakpoints",
		"freezeThread",
		"renameThread",
		"process",
		"autos",
		"disassemble",
		"readMemory",
		"writeMemory",
		"saveModule",
		"modules",
	};

	static readonly JsonElement Capabilities = DebugJson.Serialize(new {
		supportsLineBreakpoints = true,
		supportsFunctionBreakpoints = true,
		supportsExceptionBreakpoints = true,
		supportsEvaluate = true,
		supportsSetExpression = true,
		supportsObjectIds = true,
	});

	/// <summary>The options every session reads; the client replaces them whenever the Options dialog changes.</summary>
	DebuggerEngineOptions options = DebuggerEngineOptions.Default;

	public DebuggerEngineOptions Options => options;

	/// <summary><c>debug/setOptions</c>: the debugger options the engine acts on, applied to every session.</summary>
	public void SetOptions(JsonElement element) {
		options = DebuggerEngineOptions.Parse(element);
		foreach (var session in sessions.Values)
			session.Options = options;
	}

	readonly ConcurrentDictionary<string, CorDebugSession> sessions = new(StringComparer.Ordinal);

	/// <summary>
	/// The exception list every session shares. Edits arrive as RPCs and are consulted per exception
	/// event, so a session reads the current settings without being pushed a copy.
	/// </summary>
	readonly ExceptionSettingsService exceptionSettings = new();

	public object GetExceptionSettings() => exceptionSettings.BuildSnapshot();

	public object ApplyExceptionSettings(JsonElement diff) {
		exceptionSettings.Apply(diff);
		return exceptionSettings.BuildSnapshot();
	}

	public object ResetExceptionSettings() {
		exceptionSettings.Reset();
		return exceptionSettings.BuildSnapshot();
	}

	/// <summary>
	/// Resolves decompiled-source breakpoints to IL identities. Null in a host built without the
	/// decompiler, in which case breakpoints are accepted but never bind.
	/// </summary>
	readonly IDebugSymbolResolver? symbols;

	public CorDebugSessionManager(IDebugSymbolResolver? symbols = null, string? explicitDbgShimPath = null) {
		this.symbols = symbols;
		// Loading the shim is a hard prerequisite: every DbgShim call below would otherwise fail
		// with a missing entry point. Throwing here is what lets the host degrade to
		// debug.coreclr.*=false instead of failing at launch time.
		DbgShimLoader.EnsureLoaded(explicitDbgShimPath ?? DbgShimLocator.Find(null));
	}

	public event EventHandler<DebugEventNotification>? EventReceived;

	public IReadOnlyList<DebugProcessDto> ListProcesses() {
		var processes = new List<DebugProcessDto>();
		foreach (var process in Process.GetProcesses()) {
			using (process) {
				try {
					if (process.Id == Environment.ProcessId || process.HasExited || !HasCoreClr(process.Id))
						continue;
					processes.Add(new DebugProcessDto(process.Id, process.ProcessName, TryGetExecutablePath(process)));
				}
				catch (InvalidOperationException) {
				}
			}
		}
		return processes.OrderBy(process => process.Name, StringComparer.OrdinalIgnoreCase).ThenBy(process => process.ProcessId).ToArray();
	}

	/// <summary>
	/// dnSpy's Attach to Process lists the processes it has an engine for: here, those with CoreCLR loaded. On Linux
	/// the process's mappings say so; a process whose mappings cannot be read is listed, since attaching is what
	/// tells whether it can be debugged.
	/// </summary>
	static bool HasCoreClr(int processId) {
		if (!OperatingSystem.IsLinux())
			return true;
		try {
			foreach (var line in File.ReadLines($"/proc/{processId}/maps")) {
				if (line.EndsWith("/libcoreclr.so", StringComparison.Ordinal))
					return true;
			}
			return false;
		}
		catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) {
			return true;
		}
	}

	static string? TryGetExecutablePath(Process process) {
		try {
			return process.MainModule?.FileName;
		}
		catch {
			// On Linux MainModule is unavailable without elevated access; /proc is the fallback there.
			// Windows and macOS answer from the process's own module list, so a failure there is final.
		}
		if (!OperatingSystem.IsLinux())
			return null;
		try {
			var link = new FileInfo($"/proc/{process.Id}/exe").LinkTarget;
			return string.IsNullOrEmpty(link) ? null : link;
		}
		catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) {
			return null;
		}
	}

	public async Task<DebugStartResponse> LaunchAsync(DebugLaunchRequest request, CancellationToken cancellationToken) {
		var session = await CorDebugSession.LaunchAsync(request, symbols, exceptionSettings, options, cancellationToken).ConfigureAwait(false);
		Register(session);
		return new DebugStartResponse(session.Id, Capabilities);
	}

	public async Task<DebugStartResponse> AttachAsync(DebugAttachRequest request, CancellationToken cancellationToken) {
		var session = await CorDebugSession.AttachAsync(request.ProcessId, request.WorkspaceId, symbols, exceptionSettings, options, cancellationToken).ConfigureAwait(false);
		Register(session);
		return new DebugStartResponse(session.Id, Capabilities);
	}

	public async Task<DebugAdapterResponse> RequestAsync(DebugAdapterRequest request, CancellationToken cancellationToken) {
		if (!AllowedCommands.Contains(request.Command))
			throw new RpcException(ErrorCodes.InvalidParams, $"Debug adapter command is not allowed: {request.Command}");
		var session = GetSession(request.SessionId);
		var body = await session.ExecuteAsync(request.Command, request.Arguments, cancellationToken).ConfigureAwait(false);
		return new DebugAdapterResponse(body);
	}

	public async Task DisconnectAsync(DebugDisconnectRequest request, CancellationToken cancellationToken) {
		if (sessions.TryRemove(request.SessionId, out var session)) {
			session.EventReceived -= Session_EventReceived;
			await session.DisconnectAsync(request.TerminateDebuggee, cancellationToken).ConfigureAwait(false);
		}
	}

	void Register(CorDebugSession session) {
		session.Options = options;
		session.EventReceived += Session_EventReceived;
		if (!sessions.TryAdd(session.Id, session)) {
			session.EventReceived -= Session_EventReceived;
			throw new InvalidOperationException("Could not register the debug session.");
		}
		if (session.TakePendingStoppedEvent() is { } pending)
			Session_EventReceived(session, pending);
	}

	void Session_EventReceived(object? sender, SessionEvent e) {
		if (sender is not CorDebugSession session)
			return;
		EventReceived?.Invoke(this, new DebugEventNotification(session.Id, e.Event, ToJson(e.Body)));
	}

	static JsonElement? ToJson(object? body) =>
		body is null ? null : DebugJson.Serialize(body);

	CorDebugSession GetSession(string id) => sessions.TryGetValue(id, out var session)
		? session
		: throw new RpcException(ErrorCodes.InvalidParams, "The debug session no longer exists.");

	public async ValueTask DisposeAsync() {
		foreach (var id in sessions.Keys.ToArray()) {
			if (sessions.TryRemove(id, out var session)) {
				session.EventReceived -= Session_EventReceived;
				await session.DisposeAsync().ConfigureAwait(false);
			}
		}
	}
}
