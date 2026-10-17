using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Debugging.CorDebug.Evaluation;
using ICorDebugSharp;
using ICorDebugSharp.Extensions;
using Microsoft.CodeAnalysis;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>
/// The Threads and Processes windows: what each thread is (dnSpy's <c>ThreadProperties</c> — managed id,
/// name, category, state), freezing and thawing threads, the names the user gives them, and the process row.
/// </summary>
/// <remarks>
/// WPF reads a thread's category through the Windows DAC; on Linux the runtime names its own threads (the
/// finalizer, thread-pool workers) through the OS, and <c>/proc</c> has that name, the priority and the CPU
/// affinity — so that is where those columns come from.
/// </remarks>
internal sealed partial class CorDebugSession {
	JsonElement ThreadsResponse() {
		var types = TryGetTypeSystem();
		var rows = new List<object>();
		foreach (var (id, thread) in Threads.Snapshot())
			rows.Add(DescribeThread(types, id, thread));
		return DebugJson.Serialize(new { threads = rows });
	}

	DebuggeeTypeSystem? TryGetTypeSystem() {
		try {
			var types = TypeSystem;
			_ = types.BuiltVersion;
			return types;
		}
		catch (Exception ex) when (ex is IOException or InvalidOperationException or BadImageFormatException) {
			return null;
		}
	}

	object DescribeThread(DebuggeeTypeSystem? types, int id, ICorDebugThread thread) {
		var (managedId, managedName) = ReadManagedThreadInfo(types, thread);
		var userState = Try(() => thread.UserState);
		var debugState = Try(() => thread.DebugState);
		var osName = ReadProcThreadText(id, "comm")?.Trim();
		var (priority, nice) = ReadPriority(id);
		var userName = Threads.GetUserName(id);
		var appDomain = Try(() => thread.AppDomain);
		return new {
			id,
			name = userName ?? managedName ?? string.Empty,
			managedId,
			managedName,
			osName,
			category = CategoryOf(id, userState, osName),
			location = DescribeTopFrame(types, thread),
			priority,
			nice,
			affinityMask = ReadAffinityMask(id),
			suspendedCount = debugState == CorDebugThreadState.THREAD_SUSPEND ? 1 : 0,
			isFrozen = debugState == CorDebugThreadState.THREAD_SUSPEND,
			processId = TargetProcessId,
			processName = ProcessName is { } name ? Path.GetFileName(name) : null,
			appDomainId = appDomain is null ? (int?)null : Try(() => appDomain.Id),
			appDomainName = appDomain is null ? null : Try(() => appDomain.Name),
			state = StatesOf(userState),
			isMain = Threads.IsMainThread(id),
		};
	}

	static T Try<T>(Func<T> read) {
		try {
			return read();
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return default!;
		}
	}

	/// <summary>
	/// <c>Thread._managedThreadId</c> and <c>Thread._name</c> of the thread's managed object — dnSpy's
	/// <c>GetManagedId</c> and <c>GetThreadName</c>, field reads rather than calls.
	/// </summary>
	(int? ManagedId, string? Name) ReadManagedThreadInfo(DebuggeeTypeSystem? types, ICorDebugThread thread) {
		if (types is null)
			return (null, null);
		try {
			var threadType = types.Compilation.GetTypeByMetadataName("System.Threading.Thread");
			if (threadType is null || ValueReader.Dereference(thread.Object) is not ICorDebugObjectValue threadObject)
				return (null, null);
			var cls = types.GetClass(threadType);
			if (cls is null)
				return (null, null);
			int? managedId = null;
			string? name = null;
			if (threadType.GetMembers("_managedThreadId").OfType<IFieldSymbol>().FirstOrDefault() is { } idField) {
				var value = threadObject.GetFieldValue(cls, idField.MetadataToken);
				managedId = BitConverter.ToInt32(ValueReader.ReadBytes(value), 0);
			}
			if (threadType.GetMembers("_name").OfType<IFieldSymbol>().FirstOrDefault() is { } nameField) {
				var value = threadObject.GetFieldValue(cls, nameField.MetadataToken);
				if (ValueReader.Dereference(value) is ICorDebugStringValue text)
					name = ValueReader.ReadString(text);
			}
			return (managedId, name);
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex) || ex is EvaluationException or ArgumentException) {
			return (null, null);
		}
	}

	/// <summary>dnSpy's <c>PredefinedThreadKinds</c>, from what the runtime and the OS say about the thread.</summary>
	string CategoryOf(int id, CorDebugUserState state, string? osName) {
		if (Threads.IsMainThread(id))
			return "Main";
		if ((state & CorDebugUserState.USER_STOPPED) != 0)
			return "Terminated";
		if (osName is not null) {
			if (osName.Contains("Finalizer", StringComparison.OrdinalIgnoreCase))
				return "Finalizer";
			if (osName.Contains("GC", StringComparison.Ordinal) || osName.Contains("BGC", StringComparison.Ordinal))
				return "GC";
			if (osName.Contains("TP ", StringComparison.Ordinal) || osName.Contains("ThreadPool", StringComparison.OrdinalIgnoreCase))
				return "ThreadPool";
		}
		if ((state & CorDebugUserState.USER_THREADPOOL) != 0)
			return "ThreadPool";
		return "Worker";
	}

	/// <summary>dnSpy's <c>DnThreadUtils.GetState</c>: the user-state flags, by name.</summary>
	static string[] StatesOf(CorDebugUserState state) {
		var states = new List<string>();
		if ((state & CorDebugUserState.USER_STOP_REQUESTED) != 0)
			states.Add("StopRequested");
		if ((state & CorDebugUserState.USER_SUSPEND_REQUESTED) != 0)
			states.Add("SuspendRequested");
		if ((state & CorDebugUserState.USER_BACKGROUND) != 0)
			states.Add("Background");
		if ((state & CorDebugUserState.USER_UNSTARTED) != 0)
			states.Add("Unstarted");
		if ((state & CorDebugUserState.USER_STOPPED) != 0)
			states.Add("Stopped");
		if ((state & CorDebugUserState.USER_WAIT_SLEEP_JOIN) != 0)
			states.Add("WaitSleepJoin");
		if ((state & CorDebugUserState.USER_SUSPENDED) != 0)
			states.Add("Suspended");
		if ((state & CorDebugUserState.USER_UNSAFE_POINT) != 0)
			states.Add("UnsafePoint");
		if ((state & CorDebugUserState.USER_THREADPOOL) != 0)
			states.Add("ThreadPool");
		return [.. states];
	}

	/// <summary>The Threads window's Location column: the method the thread's innermost managed frame runs.</summary>
	string? DescribeTopFrame(DebuggeeTypeSystem? types, ICorDebugThread thread) {
		if (!IsStopped || types is null)
			return null;
		try {
			var frame = WalkFrames(thread, 1).FirstOrDefault();
			if (frame is null)
				return null;
			var (modulePath, token) = FrameIdentity(frame);
			var entry = string.IsNullOrEmpty(modulePath) ? null : Modules.FindEntry(modulePath);
			var method = entry is null ? null : types.GetMember(entry, token) as IMethodSymbol;
			if (method is null)
				return string.IsNullOrEmpty(modulePath) ? null : $"{Path.GetFileName(modulePath)}!0x{token:X8}";
			var shown = StackFrameFormatter.KickoffMethod(method) ?? method;
			return $"{Path.GetFileName(modulePath)}!{shown.ContainingType.ToDisplayString()}.{shown.Name}";
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return null;
		}
	}

	string? ReadProcThreadText(int threadId, string file) {
		if (!OperatingSystem.IsLinux() || TargetProcessId <= 0)
			return null;
		try {
			return File.ReadAllText($"/proc/{TargetProcessId.ToString(CultureInfo.InvariantCulture)}/task/{threadId.ToString(CultureInfo.InvariantCulture)}/{file}");
		}
		catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) {
			return null;
		}
	}

	/// <summary>The thread's priority as Windows names it, from its Linux nice value.</summary>
	(string? Priority, int? Nice) ReadPriority(int threadId) {
		var stat = ReadProcThreadText(threadId, "stat");
		if (stat is null)
			return (null, null);
		// The command name is in parentheses and may contain spaces; the fields after it are numbered from 3.
		var close = stat.LastIndexOf(')');
		if (close < 0)
			return (null, null);
		var fields = stat[(close + 2)..].Split(' ');
		// Field 19 (nice) is at index 16 once the first two are gone.
		if (fields.Length <= 16 || !int.TryParse(fields[16], NumberStyles.Integer, CultureInfo.InvariantCulture, out var nice))
			return (null, null);
		var priority = nice switch {
			<= -15 => "Time Critical",
			<= -10 => "Highest",
			< 0 => "Above Normal",
			0 => "Normal",
			< 10 => "Below Normal",
			< 19 => "Lowest",
			_ => "Idle",
		};
		return (priority, nice);
	}

	/// <summary>The CPUs the thread may run on, as the hexadecimal mask the Affinity Mask column shows.</summary>
	string? ReadAffinityMask(int threadId) {
		var status = ReadProcThreadText(threadId, "status");
		if (status is null)
			return null;
		foreach (var line in status.Split('\n')) {
			if (line.StartsWith("Cpus_allowed:", StringComparison.Ordinal))
				return line["Cpus_allowed:".Length..].Trim().Replace(",", string.Empty, StringComparison.Ordinal).TrimStart('0') is { Length: > 0 } mask ? mask : "0";
		}
		return null;
	}

	/// <summary><c>freezeThread</c>: the Threads window's Freeze and Thaw — the thread stays put while the rest run.</summary>
	JsonElement FreezeThread(JsonElement? arguments) {
		var args = arguments is { ValueKind: JsonValueKind.Object } value ? value : default;
		var freeze = GetBool(args, "freeze") ?? true;
		foreach (var id in ReadThreadIds(args)) {
			var thread = Threads.Find(id);
			if (thread is null)
				continue;
			try {
				thread.DebugState = freeze ? CorDebugThreadState.THREAD_SUSPEND : CorDebugThreadState.THREAD_RUN;
			}
			catch (Exception ex) when (ex is COMException or InvalidCastException or InvalidOperationException) {
			}
			Emit(DebugEventNames.Thread, new { reason = "changed", threadId = id });
		}
		return EmptyJson();
	}

	/// <summary><c>renameThread</c>: the name the Threads window shows, which the debuggee never sees.</summary>
	JsonElement RenameThread(JsonElement? arguments) {
		var args = arguments is { ValueKind: JsonValueKind.Object } value ? value : default;
		var id = GetInt(args, "threadId") ?? throw new RpcException(ErrorCodes.InvalidParams, "A thread is required.");
		Threads.SetUserName(id, GetString(args, "name"));
		Emit(DebugEventNames.Thread, new { reason = "changed", threadId = id });
		return EmptyJson();
	}

	static IEnumerable<int> ReadThreadIds(JsonElement args) {
		if (args.ValueKind == JsonValueKind.Object && args.TryGetProperty("threadIds", out var ids) && ids.ValueKind == JsonValueKind.Array) {
			foreach (var id in ids.EnumerateArray()) {
				if (id.ValueKind == JsonValueKind.Number && id.TryGetInt32(out var number))
					yield return number;
			}
		}
		else if (GetInt(args, "threadId") is { } single)
			yield return single;
	}

	/// <summary><c>process</c>: the Processes window's row for this session's process.</summary>
	JsonElement ProcessResponse() {
		string? path = LaunchProgram;
		string? name = null;
		try {
			if (debuggee is not null && !debuggee.HasExited) {
				name = debuggee.ProcessName;
				path ??= debuggee.MainModule?.FileName;
			}
		}
		catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException) {
		}
		if (path is null && OperatingSystem.IsLinux()) {
			try {
				path = new FileInfo($"/proc/{TargetProcessId.ToString(CultureInfo.InvariantCulture)}/exe").LinkTarget;
			}
			catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) {
			}
		}
		return DebugJson.Serialize(new {
			id = TargetProcessId,
			name = name ?? (path is null ? null : Path.GetFileName(path)),
			path,
			state = HasExited ? "Terminated" : IsStopped ? "Paused" : "Running",
			debugging = "CoreCLR",
			architecture = RuntimeInformation.ProcessArchitecture.ToString(),
			ownsDebuggee = OwnsDebuggee,
		});
	}
}
