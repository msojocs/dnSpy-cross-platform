using dnSpy.Backend.Contracts;
using System.Globalization;
using ICorDebugSharp;
using ICorDebugSharp.Extensions;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>
/// Modules, threads and the program's own messages as they come and go: the JIT flags and Just My Code
/// status a module is loaded with, and the events the Output window's Debug pane logs (dnSpy's
/// <c>OutputLogger</c>) and the Modules and Threads windows refresh on.
/// </summary>
internal sealed partial class CorDebugSession {
	/// <summary>Set once the first program module has been marked as the user's code, for "only step into the primary module".</summary>
	bool primaryModuleMarked;

	/// <summary>
	/// Configures a module as it loads, which is the only time the runtime accepts it: whether its code is
	/// JIT-optimized, and whether it is the user's code (dnSpy's <c>DebugOptionsProviderImpl.GetModuleLoadOptions</c>).
	/// </summary>
	void OnModuleLoadedCore(ICorDebugModule module) {
		var entry = Modules.FindEntry(module);
		var options = Options;
		var isProgram = entry is null || IsProgramModule(entry);
		if (entry is not null)
			entry.IsProgramModule = isProgram;
		var suppress = isProgram ? options.SuppressJitOptimizationProgramModules : options.SuppressJitOptimizationSystemModules;
		try {
			if (module is ICorDebugModule2 module2)
				module2.JITCompilerFlags = suppress ? CorDebugJITCompilerFlags.CORDEBUG_JIT_DISABLE_OPTIMIZATION : CorDebugJITCompilerFlags.CORDEBUG_JIT_DEFAULT;
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			// An NGen/ReadyToRun image keeps the code it was compiled with; the flags only govern what is jitted.
		}
		try {
			module.EnableJITDebugging(suppress, !suppress);
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
		}
		if (entry is not null) {
			try {
				entry.IsOptimized = module is ICorDebugModule2 flags ? flags.JITCompilerFlags == CorDebugJITCompilerFlags.CORDEBUG_JIT_DEFAULT : !suppress;
			}
			catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
				entry.IsOptimized = !suppress;
			}
			entry.IsJustMyCode = IsJustMyCode(entry, isProgram);
			ApplyJustMyCode(module, entry.IsJustMyCode);
		}
		// dnSpy's ClassLoader: the types Reflection.Emit creates in a dynamic module are announced as they load, so the
		// client can read the module out of the process again at the next stop.
		if (entry is { IsDynamic: true }) {
			try {
				module.EnableClassLoadCallbacks(true);
			}
			catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			}
		}
		if (entry is not null)
			Emit(DebugEventNames.Module, new { reason = "new", module = DescribeModule(entry) });
		CheckModuleBreakpoints(module, entry, isLoadedEvent: true);
	}

	void OnClassLoaded(ICorDebugClass? loaded) {
		try {
			if (loaded?.Module is not { } module || Modules.FindEntry(module) is not { IsDynamic: true } entry)
				return;
			Emit(DebugEventNames.Module, new { reason = "classLoaded", module = DescribeModule(entry), token = unchecked((int)loaded.Token.Value) });
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
		}
	}

	void OnModuleUnloading(ICorDebugModule module) {
		var entry = Modules.FindEntry(module);
		if (entry is not null) {
			Emit(DebugEventNames.Module, new { reason = "removed", module = DescribeModule(entry) });
			// ModuleBreakpointHitChecker matches MessageModuleUnloaded too, so a row with IsLoaded false — or
			// no Loaded filter — stops here as well.
			CheckModuleBreakpoints(module, entry, isLoadedEvent: false);
		}
		breakpoints.UnbindModule(module);
	}

	/// <summary>
	/// dnSpy's <c>IsProgramModule</c>: a module is the program's unless it was loaded from the runtime's own
	/// directory — the shared framework — or is dynamic or in memory, which are always the program's.
	/// </summary>
	bool IsProgramModule(ModuleTable.ModuleEntry entry) {
		if (entry.IsDynamic || entry.IsInMemory || string.IsNullOrEmpty(entry.Path) || !File.Exists(entry.Path))
			return true;
		var runtimeDirectory = RuntimeDirectory;
		if (runtimeDirectory is null)
			return true;
		return !entry.Path.StartsWith(runtimeDirectory, StringComparison.Ordinal);
	}

	string? runtimeDirectory;

	/// <summary>The directory the debuggee's core library was loaded from: the shared framework's.</summary>
	string? RuntimeDirectory {
		get {
			if (runtimeDirectory is not null)
				return runtimeDirectory;
			foreach (var entry in Modules.Entries()) {
				if (string.Equals(entry.Name, "System.Private.CoreLib.dll", StringComparison.OrdinalIgnoreCase)) {
					var directory = Path.GetDirectoryName(entry.Path);
					if (!string.IsNullOrEmpty(directory))
						return runtimeDirectory = directory + Path.DirectorySeparatorChar;
				}
			}
			return null;
		}
	}

	bool IsJustMyCode(ModuleTable.ModuleEntry entry, bool isProgram) {
		var options = Options;
		if (!options.EnableJustMyCode)
			return true;
		if (options.StepOverCodeInSystemModules)
			return isProgram;
		if (options.OnlyStepIntoCodeInPrimaryModule) {
			if (primaryModuleMarked || !isProgram)
				return false;
			primaryModuleMarked = true;
			return true;
		}
		return true;
	}

	static void ApplyJustMyCode(ICorDebugModule module, bool isJustMyCode) {
		try {
			if (module is ICorDebugModule2 module2)
				module2.SetJMCStatus(isJustMyCode, 0, []);
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
		}
	}

	/// <summary>The Modules window's row for a module (dnSpy's <c>ModuleVM</c> columns).</summary>
	internal object DescribeModule(ModuleTable.ModuleEntry entry) => new {
		id = entry.Order,
		name = entry.Name,
		path = entry.Path,
		isOptimized = entry.IsOptimized,
		isDynamic = entry.IsDynamic,
		isInMemory = entry.IsInMemory,
		isExe = entry.IsExe,
		order = entry.Order,
		version = entry.Version,
		timestamp = entry.Timestamp?.ToString("o", CultureInfo.InvariantCulture),
		address = entry.Address,
		size = entry.Size,
		appDomainId = entry.AppDomainId,
		appDomainName = entry.AppDomainName,
		isJustMyCode = entry.IsJustMyCode,
		isProgramModule = entry.IsProgramModule,
		processId = TargetProcessId,
		symbolStatus = "No symbols (IL only)",
	};

	/// <summary>The program's <c>Debugger.Log</c> messages, which the runtime only sends once asked to.</summary>
	void OnLogMessage(LogMessageCorDebugManagedCallbackEventArgs log) {
		var threadId = log.Thread is null ? null : ThreadTable.TryGetId(log.Thread);
		Emit(DebugEventNames.Output, new {
			category = "log",
			output = log.Message ?? string.Empty,
			level = log.LLevel,
			logSwitch = log.LogSwitchName,
			threadId,
		});
	}

	/// <summary>A thread or an app domain was renamed: the Threads window shows the new name.</summary>
	void OnNameChange(NameChangeCorDebugManagedCallbackEventArgs change) {
		if (change.Thread is null)
			return;
		var id = ThreadTable.TryGetId(change.Thread);
		if (id is not null)
			Emit(DebugEventNames.Thread, new { reason = "changed", threadId = id });
	}

	/// <summary>A step finished; whether the stop stands is the step filters' call.</summary>
	void OnStepComplete(ICorDebugThread thread) {
		// A return to the awaiter steps out until it is out of the task plumbing.
		if (ContinueReturnToAwaiter(thread))
			return;
		// dnSpy's StepOverHiddenInstructionsAsync: the runtime's stepper stops at IL boundaries, and one that no statement
		// owns — the compiler's own code between statements — is stepped past to the statement it leads to. Whether a
		// location is hidden is the resolver's to say, which decompiles, so the process is held while it is asked.
		var threadId = ThreadTable.TryGetId(thread);
		if (SymbolResolver is not null && threadId is { } id && CurrentFrame(id) is { } frame && FrameIdentity(frame) is var (modulePath, token) &&
			!string.IsNullOrEmpty(modulePath) && ReadIlOffset(frame) is >= 0 and var ilOffset && hiddenStepCount < MaxHiddenSteps) {
			deciding = true;
			holdAfterEvent = true;
			_ = Task.Run(() => FinishStepAsync(thread, id, modulePath, token, ilOffset));
			return;
		}
		hiddenStepCount = 0;
		Stop(StopReasons.Step, thread);
	}

	/// <summary>How many hidden locations in a row a step goes on past before it stops at one anyway.</summary>
	const int MaxHiddenSteps = 16;

	int hiddenStepCount;

	async Task FinishStepAsync(ICorDebugThread thread, int threadId, string modulePath, int token, int ilOffset) {
		ResolvedIlLocation? location = null;
		try {
			location = await SymbolResolver!.ResolveIlLocationAsync(WorkspaceId, modulePath, token, ilOffset, CancellationToken.None).ConfigureAwait(false);
		}
		catch (Exception ex) when (ex is not OutOfMemoryException) {
			// A location the resolver cannot read is shown as it is.
		}
		await Dispatcher.RunAsync(() => {
			deciding = false;
			if (HasExited || process is null)
				return;
			if (location is { IsHidden: true } && CurrentFrame(threadId) is { } frame) {
				hiddenStepCount++;
				ArmNativeStepper(frame, stepOut: false, stepInto: false, threadId);
				if (nativeStepper is not null) {
					ContinueProcess();
					return;
				}
			}
			hiddenStepCount = 0;
			Stop(StopReasons.Step, thread);
		}).ConfigureAwait(false);
	}

	/// <summary>Hook for work every stop does, such as collecting the values the step's calls returned.</summary>
	void OnStopped(ICorDebugThread? thread) {
		_ = thread;
	}

	/// <summary>Turns <c>Debugger.Log</c> forwarding on, which the runtime keeps off until a debugger asks.</summary>
	void EnableLogMessages() {
		try {
			process?.EnableLogMessages(true);
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
		}
	}

	// Implemented with the module breakpoints.
	partial void CheckModuleBreakpoints(ICorDebugModule module, ModuleTable.ModuleEntry? entry, bool isLoadedEvent);
}
