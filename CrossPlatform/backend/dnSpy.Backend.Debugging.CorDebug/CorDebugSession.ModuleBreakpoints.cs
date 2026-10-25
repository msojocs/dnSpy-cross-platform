using System.Text.Json;
using System.Text.RegularExpressions;
using ICorDebugSharp;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>
/// dnSpy's module breakpoints: the process pauses when a module whose name, kind, load order, app domain and
/// process match a breakpoint is loaded — the Module Breakpoints window's rows, wildcards and all.
/// </summary>
internal sealed partial class CorDebugSession {
	/// <summary>
	/// One enabled row of the Module Breakpoints window: dnSpy's <c>DbgModuleBreakpointSettings</c> minus
	/// <c>IsEnabled</c>. A null field matches anything; the names take <c>*</c> and <c>?</c>.
	/// </summary>
	internal sealed record ModuleBreakpoint(string? ModuleName, bool? IsDynamic, bool? IsInMemory, bool? IsLoaded, int? Order, string? AppDomainName, string? ProcessName) {
		/// <summary>
		/// ModuleBreakpointHitChecker.IsMatch: an IsLoaded of null matches both events, true only a load and
		/// false only an unload.
		/// </summary>
		public bool Matches(ModuleTable.ModuleEntry module, string? processName, bool isLoadedEvent) =>
			(IsLoaded is not { } loaded || loaded == isLoadedEvent) &&
			(IsDynamic is not { } dynamic || dynamic == module.IsDynamic) &&
			(IsInMemory is not { } inMemory || inMemory == module.IsInMemory) &&
			(Order is not { } order || order == module.Order) &&
			MatchesName(ModuleName, module.Path, module.Name) &&
			MatchesName(AppDomainName, module.AppDomainName) &&
			MatchesName(ProcessName, processName, processName is null ? null : Path.GetFileName(processName));

		/// <summary>dnSpy's WildcardsUtils: an empty pattern matches all, otherwise the whole text, case-insensitively.</summary>
		static bool MatchesName(string? pattern, params string?[] candidates) {
			if (string.IsNullOrWhiteSpace(pattern))
				return true;
			var regex = new Regex("^" + Regex.Escape(pattern.Trim()).Replace("\\*", ".*", StringComparison.Ordinal).Replace("\\?", ".", StringComparison.Ordinal) + "$",
				RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
			return candidates.Any(candidate => candidate is not null && regex.IsMatch(candidate));
		}
	}

	IReadOnlyList<ModuleBreakpoint> moduleBreakpoints = [];

	/// <summary><c>setModuleBreakpoints</c>: the enabled rows of the Module Breakpoints window, replacing the last set.</summary>
	JsonElement SetModuleBreakpoints(JsonElement? arguments) {
		var list = new List<ModuleBreakpoint>();
		if (arguments is { ValueKind: JsonValueKind.Object } args && args.TryGetProperty("breakpoints", out var array) && array.ValueKind == JsonValueKind.Array) {
			foreach (var element in array.EnumerateArray()) {
				if (element.ValueKind != JsonValueKind.Object)
					continue;
				list.Add(new ModuleBreakpoint(GetString(element, "moduleName"), GetBool(element, "isDynamic"), GetBool(element, "isInMemory"), GetBool(element, "isLoaded"),
					GetInt(element, "order"), GetString(element, "appDomainName"), GetString(element, "processName")));
			}
		}
		moduleBreakpoints = list;
		return EmptyJson();
	}

	partial void CheckModuleBreakpoints(ICorDebugModule module, ModuleTable.ModuleEntry? entry, bool isLoadedEvent) {
		if (entry is null || IsStopped || moduleBreakpoints.Count == 0)
			return;
		var processName = ProcessName ?? LaunchProgram;
		if (!moduleBreakpoints.Any(breakpoint => breakpoint.Matches(entry, processName, isLoadedEvent)))
			return;
		// A module load has no thread of its own; the stop is on the process, and the client reads the threads.
		var thread = Threads.Snapshot().Select(pair => pair.Thread).FirstOrDefault();
		Stop(StopReasons.ModuleBreakpoint, thread, extra: new Dictionary<string, object?>(StringComparer.Ordinal) {
			["module"] = entry.Name,
			["modulePath"] = entry.Path,
			["unloaded"] = !isLoadedEvent,
		});
	}
}
