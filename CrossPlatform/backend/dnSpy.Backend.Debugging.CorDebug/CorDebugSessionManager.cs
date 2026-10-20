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
		"resetHitCounts",
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

	/// <summary>
	/// dnSpy's DbgFilterExpressionEvaluatorService.IsValidExpression, for the breakpoint settings dialog: null when the
	/// filter reads, or the reason it does not. It is tried against the five values a filter can name, so a name that is
	/// none of them, or a comparison of a number with a string, is caught before the breakpoint is hit.
	/// </summary>
	public static string? VerifyFilterExpression(string filter) {
		try {
			BreakpointExpression.Parse(filter).EvaluateAsBoolean(FilterSampleScope.Instance);
			return null;
		}
		catch (BreakpointExpressionException ex) {
			return ex.Message;
		}
	}

	/// <summary>The names a filter can read, each with a value of the kind the debugger fills it with.</summary>
	sealed class FilterSampleScope : IBreakpointScope {
		public static readonly FilterSampleScope Instance = new();

		public bool TryRead(string name, out BreakpointValue value) {
			value = name switch {
				"MachineName" or "ProcessName" or "ThreadName" => BreakpointValue.FromString(string.Empty),
				"ProcessId" or "ThreadId" => BreakpointValue.FromInteger(0),
				_ => BreakpointValue.Null,
			};
			return name is "MachineName" or "ProcessName" or "ThreadName" or "ProcessId" or "ThreadId";
		}
	}

	/// <summary>
	/// dnSpy's Attach to Process list: the processes with a runtime it has an engine for — here, those with CoreCLR
	/// loaded — other than its own.
	/// </summary>
	public IReadOnlyList<AttachableProcessDto> ListProcesses() {
		var processes = new List<AttachableProcessDto>();
		foreach (var process in Process.GetProcesses()) {
			using (process) {
				try {
					if (process.Id == Environment.ProcessId || process.HasExited || !TryFindCoreClr(process.Id, out var coreClrPath))
						continue;
					var path = TryGetExecutablePath(process);
					processes.Add(new AttachableProcessDto(
						process.Id,
						string.IsNullOrEmpty(path) ? process.ProcessName : Path.GetFileName(path),
						string.Empty,
						"CoreCLR " + CoreClrVersion(coreClrPath),
						ReadArchitecture(process.Id),
						path,
						ReadCommandLine(process.Id)));
				}
				catch (InvalidOperationException) {
				}
			}
		}
		return processes.OrderBy(process => process.Name, StringComparer.OrdinalIgnoreCase).ThenBy(process => process.ProcessId).ToArray();
	}

	/// <summary>
	/// Whether the process has CoreCLR loaded. On Linux the process's mappings say so, and where from; a process whose
	/// mappings cannot be read is listed, since attaching is what tells whether it can be debugged.
	/// </summary>
	static bool TryFindCoreClr(int processId, out string? coreClrPath) {
		coreClrPath = null;
		if (!OperatingSystem.IsLinux())
			return true;
		try {
			foreach (var line in File.ReadLines($"/proc/{processId}/maps")) {
				if (line.EndsWith("/libcoreclr.so", StringComparison.Ordinal)) {
					var start = line.IndexOf('/');
					coreClrPath = start < 0 ? null : line[start..];
					return true;
				}
			}
			return false;
		}
		catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) {
			return true;
		}
	}

	/// <summary>The runtime's version: the name of the shared framework directory libcoreclr.so is loaded from.</summary>
	internal static string CoreClrVersion(string? coreClrPath) {
		var directory = coreClrPath is null ? null : Path.GetFileName(Path.GetDirectoryName(coreClrPath));
		return !string.IsNullOrEmpty(directory) && char.IsAsciiDigit(directory[0]) ? directory : string.Empty;
	}

	/// <summary>dnSpy's DbgArchitecture names, read from the ELF header of the process's executable.</summary>
	internal static string ReadArchitecture(int processId) {
		if (!OperatingSystem.IsLinux())
			return ArchitectureName(System.Runtime.InteropServices.RuntimeInformation.OSArchitecture);
		try {
			using var stream = File.OpenRead($"/proc/{processId}/exe");
			Span<byte> header = stackalloc byte[20];
			if (stream.Read(header) < header.Length || header[0] != 0x7F || header[1] != (byte)'E' || header[2] != (byte)'L' || header[3] != (byte)'F')
				return string.Empty;
			// e_machine, in the byte order EI_DATA names.
			var machine = header[5] == 2 ? (header[18] << 8) | header[19] : header[18] | (header[19] << 8);
			return machine switch {
				0x03 => "x86",
				0x3E => "x64",
				0x28 => "ARM",
				0xB7 => "ARM64",
				_ => string.Empty,
			};
		}
		catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) {
			return string.Empty;
		}
	}

	static string ArchitectureName(System.Runtime.InteropServices.Architecture architecture) => architecture switch {
		System.Runtime.InteropServices.Architecture.X86 => "x86",
		System.Runtime.InteropServices.Architecture.X64 => "x64",
		System.Runtime.InteropServices.Architecture.Arm => "ARM",
		System.Runtime.InteropServices.Architecture.Arm64 => "ARM64",
		_ => string.Empty,
	};

	/// <summary>The command line, its arguments split by NULs in <c>/proc/&lt;pid&gt;/cmdline</c> and quoted where they hold a space.</summary>
	internal static string ReadCommandLine(int processId) {
		if (!OperatingSystem.IsLinux())
			return string.Empty;
		try {
			var arguments = File.ReadAllText($"/proc/{processId}/cmdline").Split('\0', StringSplitOptions.RemoveEmptyEntries);
			return string.Join(" ", arguments.Select(argument => argument.Contains(' ') ? "\"" + argument + "\"" : argument));
		}
		catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) {
			return string.Empty;
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
		// DbgManager.BreakAllProcessesIfNeeded: with Break all processes on, a process that breaks pauses the others.
		if (e.Event == DebugEventNames.Stopped && options.BreakAllProcesses)
			BreakOtherProcesses(session);
	}

	void BreakOtherProcesses(CorDebugSession broken) {
		foreach (var other in sessions.Values) {
			if (ReferenceEquals(other, broken) || other.IsStopped || other.HasExited)
				continue;
			// Off the thread the event came on: a pause waits for the other session's dispatcher.
			_ = Task.Run(async () => {
				try {
					await other.ExecuteAsync("pause", null, CancellationToken.None).ConfigureAwait(false);
				}
				catch (Exception ex) when (ex is RpcException or InvalidOperationException or ObjectDisposedException) {
					// A session that ends meanwhile has nothing to pause.
				}
			});
		}
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
