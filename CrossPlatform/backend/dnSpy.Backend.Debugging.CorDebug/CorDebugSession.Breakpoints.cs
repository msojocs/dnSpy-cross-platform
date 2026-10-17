using System.Text.Json;
using dnSpy.Backend.Contracts;
using ICorDebugSharp;
using ICorDebugSharp.Extensions;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>
/// The breakpoint surface of a session: turning decompiled-source coordinates into engine
/// breakpoints, and keeping the client's view of them honest while modules come and go.
/// </summary>
/// <remarks>
/// The engine only speaks <c>(module, metadata token, IL offset)</c> and rejects offsets that are
/// not sequence points, so a request always goes through <see cref="IDebugSymbolResolver"/> first.
/// Resolution is deliberately done off the dispatcher: decompiling a whole module takes long enough
/// that holding the COM thread through it would stall the event pump.
/// </remarks>
internal sealed partial class CorDebugSession {
	/// <summary>
	/// What the client asked for, in decompiled-source coordinates. A breakpoint restored from the
	/// client's settings also carries the IL identity it was saved with, because the node id it was
	/// created against died with the workspace that issued it.
	/// </summary>
	sealed record BreakpointRequest(
		string Id,
		string NodeId,
		string Name,
		int Line,
		int? Column,
		bool Enabled,
		string? ModulePath = null,
		int? MetadataToken = null,
		int? SourceMethodToken = null,
		int? IlOffset = null,
		BreakpointSettings? Settings = null);

	const string NoWorkspaceReason =
		"This debug session has no workspace, so decompiled source cannot be resolved to IL.";
	const string ModuleNotLoadedReason = "Module not loaded yet.";

	readonly BreakpointTable breakpoints = new();

	public BreakpointTable Breakpoints => breakpoints;

	/// <summary>
	/// Replaces the session's line breakpoints with the requested set — DAP's <c>setBreakpoints</c>
	/// semantics: anything absent from the request is removed, and a breakpoint already present keeps
	/// its engine counterpart because the client sends the same id back.
	/// </summary>
	internal async Task<JsonElement> SetBreakpointsAsync(JsonElement? arguments, CancellationToken cancellationToken) {
		var requests = ParseBreakpointRequests(arguments, "line");
		var resolutions = await ResolveAsync(requests, cancellationToken).ConfigureAwait(false);
		var entries = requests.Select(request => CreateLineEntry(request, resolutions)).ToList();
		await ResolveVariableSlotsAsync(entries, cancellationToken).ConfigureAwait(false);
		return await ApplyAsync(BreakpointEntry.LineKind, entries).ConfigureAwait(false);
	}

	/// <summary>
	/// Replaces the session's method breakpoints. The legacy entry point is kept even though the
	/// gutter now sets line breakpoints: the client still offers "Toggle Method Breakpoint", and a
	/// method breakpoint is simply the first sequence point of the method body.
	/// </summary>
	internal async Task<JsonElement> SetFunctionBreakpointsAsync(JsonElement? arguments, CancellationToken cancellationToken) {
		var requests = ParseBreakpointRequests(arguments, "fn");
		var entries = new List<BreakpointEntry>(requests.Count);
		foreach (var request in requests)
			entries.Add(await CreateFunctionEntryAsync(request, cancellationToken).ConfigureAwait(false));
		await ResolveVariableSlotsAsync(entries, cancellationToken).ConfigureAwait(false);
		return await ApplyAsync(BreakpointEntry.FunctionKind, entries).ConfigureAwait(false);
	}

	/// <summary>
	/// Names the arguments and locals of every breakpoint whose settings read variables, so that
	/// checking a condition at a hit is a dictionary lookup.
	/// </summary>
	/// <remarks>
	/// Naming them goes through the decompiler, and a hit is handled on the dispatcher, where
	/// decompiling would stall the event pump — so it happens here instead, where the request is
	/// already off the dispatcher and the user is already waiting. Breakpoints whose settings never
	/// mention a variable pay nothing.
	/// </remarks>
	async Task ResolveVariableSlotsAsync(IReadOnlyList<BreakpointEntry> entries, CancellationToken cancellationToken) {
		if (SymbolResolver is null || WorkspaceId is null)
			return;
		foreach (var entry in entries) {
			if (!entry.Settings.ReadsVariables || string.IsNullOrEmpty(entry.ModulePath))
				continue;
			var names = await SymbolResolver.GetVariableNamesAsync(WorkspaceId, entry.ModulePath, entry.MetadataToken, cancellationToken).ConfigureAwait(false);
			var slots = new Dictionary<string, (bool IsArgument, int Index)>(StringComparer.Ordinal);
			foreach (var name in names) {
				// Two slots can share a name — a local declared in sibling scopes — and the first one
				// is the one a condition written against the method's text means.
				slots.TryAdd(name.Name, (name.IsArgument, name.Index));
			}
			entry.VariableSlots = slots;
		}
	}

	/// <summary>Installs the entries and answers with their post-binding state, as DAP expects.</summary>
	async Task<JsonElement> ApplyAsync(string kind, List<BreakpointEntry> entries) {
		await Dispatcher.RunAsync(() => {
			breakpoints.Replace(kind, entries);
			// A module that loaded before the request never raised a LoadModule for the table to
			// bind on, so sweep what is already there.
			foreach (var module in Modules.Enumerate())
				breakpoints.BindModule(module);
			return true;
		}).ConfigureAwait(false);
		return DebugJson.Serialize(new { breakpoints = entries.Select(Describe).ToArray() });
	}

	async Task<IReadOnlyDictionary<string, ResolvedBreakpoint>> ResolveAsync(IReadOnlyList<BreakpointRequest> requests, CancellationToken cancellationToken) {
		var resolutions = new Dictionary<string, ResolvedBreakpoint>(StringComparer.Ordinal);
		if (requests.Count == 0 || SymbolResolver is null || WorkspaceId is null)
			return resolutions;
		var response = await SymbolResolver.ResolveBreakpointsAsync(
			WorkspaceId,
			requests.Select(request => new BreakpointQuery(
				request.Id, request.NodeId, request.Line, request.Column,
				request.ModulePath, request.MetadataToken, request.SourceMethodToken, request.IlOffset)).ToArray(),
			cancellationToken).ConfigureAwait(false);
		foreach (var breakpoint in response.Breakpoints)
			resolutions[breakpoint.Id] = breakpoint;
		return resolutions;
	}

	static BreakpointEntry CreateLineEntry(BreakpointRequest request, IReadOnlyDictionary<string, ResolvedBreakpoint> resolutions) {
		if (!resolutions.TryGetValue(request.Id, out var resolved) ||
			!resolved.Bound || resolved.ModulePath is null || resolved.MetadataToken is null || resolved.IlOffset is null) {
			// Either the resolver refused (no sequence point on the line) or there was nothing to
			// resolve against; the client keeps showing the requested line, flagged as unbound.
			return new BreakpointEntry {
				Id = request.Id,
				ModulePath = string.Empty,
				MetadataToken = 0,
				IlOffset = -1,
				RequestedLine = request.Line,
				Line = request.Line,
				EndLine = request.Line,
				Enabled = request.Enabled,
				Settings = request.Settings ?? BreakpointSettings.None,
				Message = resolved?.Reason ?? NoWorkspaceReason,
			};
		}
		return new BreakpointEntry {
			Id = request.Id,
			ModulePath = resolved.ModulePath,
			MetadataToken = resolved.MetadataToken.Value,
			SourceMethodToken = resolved.SourceMethodToken ?? resolved.MetadataToken.Value,
			IlOffset = resolved.IlOffset.Value,
			SequencePointIlOffset = resolved.SequencePointIlOffset,
			RequestedLine = request.Line,
			// The snapped coordinates are what the client draws, so the click visibly moves.
			Line = resolved.StartLine,
			EndLine = resolved.EndLine,
			Column = resolved.StartColumn,
			EndColumn = resolved.EndColumn,
			Description = resolved.Description,
			Enabled = request.Enabled,
			Settings = request.Settings ?? BreakpointSettings.None,
		};
	}

	async Task<BreakpointEntry> CreateFunctionEntryAsync(BreakpointRequest request, CancellationToken cancellationToken) {
		var unbound = (string message) => new BreakpointEntry {
			Id = request.Id,
			Kind = BreakpointEntry.FunctionKind,
			ModulePath = string.Empty,
			MetadataToken = 0,
			IlOffset = -1,
			RequestedLine = request.Line,
			Line = request.Line,
			EndLine = request.Line,
			Enabled = request.Enabled,
			Settings = request.Settings ?? BreakpointSettings.None,
			Message = message,
		};
		if (SymbolResolver is null || WorkspaceId is null)
			return unbound(NoWorkspaceReason);
		var methods = await SymbolResolver.FindMethodsAsync(WorkspaceId, request.Name, cancellationToken).ConfigureAwait(false);
		var method = methods.FirstOrDefault(candidate => candidate.HasBody);
		if (method is null)
			return unbound($"No method with an IL body matches '{request.Name}'.");
		return new BreakpointEntry {
			Id = request.Id,
			Kind = BreakpointEntry.FunctionKind,
			ModulePath = method.ModulePath,
			MetadataToken = method.BodyMetadataToken,
			IlOffset = method.FirstIlOffset,
			Line = request.Line,
			EndLine = request.Line,
			Description = method.Description,
			Enabled = request.Enabled,
			Settings = request.Settings ?? BreakpointSettings.None,
		};
	}

	/// <summary>The DAP shape the client already understands, plus the extra fields it needs to draw.</summary>
	static object Describe(BreakpointEntry entry) => new {
		id = entry.Id,
		verified = entry.Breakpoint is not null,
		state = entry.Breakpoint is not null ? "bound" : entry.Message is null ? "pending" : "unbound",
		line = entry.Line,
		endLine = entry.EndLine,
		column = entry.Column,
		message = entry.Breakpoint is not null ? null : entry.Message ?? ModuleNotLoadedReason,
		modulePath = entry.ModulePath,
		metadataToken = entry.MetadataToken,
		sourceMethodToken = entry.SourceMethodToken,
		ilOffset = entry.IlOffset,
		description = entry.Description,
		enabled = entry.Enabled,
		// How many times the breakpoint has been reached and wanted, which is what the pane shows
		// beside a hit-count condition.
		hitCount = entry.HitState.HitCount,
	};

	void EmitBreakpointChanged(BreakpointEntry entry) =>
		Emit(DebugEventNames.Breakpoint, new { reason = "changed", breakpoint = Describe(entry) });

	/// <summary>
	/// Reads a <c>{ breakpoints: [...] }</c> payload. Function breakpoints arrive with a name and no
	/// id — the client only sends names — so ids are synthesised, unique per kind.
	/// </summary>
	static IReadOnlyList<BreakpointRequest> ParseBreakpointRequests(JsonElement? arguments, string fallbackPrefix) {
		var requests = new List<BreakpointRequest>();
		if (arguments is not { } args || args.ValueKind != JsonValueKind.Object)
			return requests;
		if (!args.TryGetProperty("breakpoints", out var array) || array.ValueKind != JsonValueKind.Array)
			return requests;
		var index = 0;
		foreach (var element in array.EnumerateArray()) {
			if (element.ValueKind != JsonValueKind.Object) {
				index++;
				continue;
			}
			requests.Add(new BreakpointRequest(
				GetString(element, "id") ?? $"{fallbackPrefix}{index}",
				GetString(element, "nodeId") ?? string.Empty,
				GetString(element, "name") ?? string.Empty,
				GetInt(element, "line") ?? 0,
				GetInt(element, "column"),
				GetBool(element, "enabled") ?? true,
				GetString(element, "modulePath"),
				GetInt(element, "metadataToken"),
				GetInt(element, "sourceMethodToken"),
				GetInt(element, "ilOffset"),
				ParseSettings(element)));
			index++;
		}
		return requests;
	}

	/// <summary>
	/// Reads the condition, hit count, filter, trace and labels off a request. A field the client
	/// spelled wrongly is dropped rather than failing the whole request: the breakpoint itself is
	/// still wanted, and a setting that silently does nothing is easier to notice than a breakpoint
	/// that never appeared.
	/// </summary>
	static BreakpointSettings? ParseSettings(JsonElement element) {
		if (!element.TryGetProperty("settings", out var settings) || settings.ValueKind != JsonValueKind.Object)
			return null;
		var parsed = new BreakpointSettings {
			Condition = ParseCondition(settings),
			HitCount = ParseHitCount(settings),
			Filter = GetString(settings, "filter") is { Length: > 0 } filter ? filter : null,
			Trace = ParseTrace(settings),
			Labels = ParseLabels(settings),
		};
		return parsed.IsDefault ? null : parsed;
	}

	static BreakpointCondition? ParseCondition(JsonElement settings) {
		if (!settings.TryGetProperty("condition", out var value) || value.ValueKind != JsonValueKind.Object)
			return null;
		if (GetString(value, "expression") is not { Length: > 0 } expression)
			return null;
		var kind = GetString(value, "kind") switch {
			"whenChanged" => BreakpointConditionKind.WhenChanged,
			_ => BreakpointConditionKind.IsTrue,
		};
		return new BreakpointCondition(kind, expression);
	}

	static BreakpointHitCount? ParseHitCount(JsonElement settings) {
		if (!settings.TryGetProperty("hitCount", out var value) || value.ValueKind != JsonValueKind.Object)
			return null;
		if (GetInt(value, "count") is not { } count)
			return null;
		var kind = GetString(value, "kind") switch {
			"multipleOf" => BreakpointHitCountKind.MultipleOf,
			"greaterThanOrEquals" => BreakpointHitCountKind.GreaterThanOrEquals,
			_ => BreakpointHitCountKind.Equals,
		};
		return new BreakpointHitCount(kind, count);
	}

	static BreakpointTrace? ParseTrace(JsonElement settings) {
		if (!settings.TryGetProperty("trace", out var value) || value.ValueKind != JsonValueKind.Object)
			return null;
		var message = GetString(value, "message");
		if (message is null)
			return null;
		return new BreakpointTrace(message, GetBool(value, "continue") ?? true);
	}

	static IReadOnlyList<string> ParseLabels(JsonElement settings) {
		if (!settings.TryGetProperty("labels", out var value) || value.ValueKind != JsonValueKind.Array)
			return Array.Empty<string>();
		var labels = new List<string>();
		foreach (var label in value.EnumerateArray()) {
			if (label.ValueKind == JsonValueKind.String && label.GetString() is { Length: > 0 } text)
				labels.Add(text);
		}
		return labels;
	}

	static string? GetString(JsonElement element, string name) =>
		element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

	static int? GetInt(JsonElement element, string name) =>
		element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number)
			? number
			: null;

	static bool? GetBool(JsonElement element, string name) =>
		element.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False
			? value.GetBoolean()
			: null;

	// ---------------------------------------------------------------- engine callbacks

	/// <summary>Corrects a breakpoint the client marked verified but the runtime refused to arm.</summary>
	partial void OnBreakpointSetError(ICorDebugBreakpoint breakpoint, uint dwError) {
		if (breakpoint is not ICorDebugFunctionBreakpoint functionBreakpoint)
			return;
		var entry = FindEntry(functionBreakpoint);
		if (entry is null)
			return;
		// The refusal names a place the runtime will not stop at — an offset inside a sequence point
		// rather than on its boundary. The statement usually has another offset that it will accept, so
		// the breakpoint moves there rather than being reported dead.
		uint token;
		int ilOffset;
		try {
			token = functionBreakpoint.Function.Token;
			ilOffset = functionBreakpoint.Offset;
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return;
		}
		if (breakpoints.RetryAtFallback(token, ilOffset)) {
			EmitBreakpointChanged(entry);
			return;
		}
		breakpoints.SetMessage(entry, $"Breakpoint could not be bound (DwError=0x{dwError:X8}).", dropBreakpoint: true);
		EmitBreakpointChanged(entry);
	}

	/// <summary>Binds the pending breakpoints of a module that has just loaded, and reports them.</summary>
	partial void OnModuleLoaded(ICorDebugModule module) {
		foreach (var entry in breakpoints.BindModule(module))
			EmitBreakpointChanged(entry);
	}

	/// <summary>Reports a hit as a normal stop, naming the breakpoint so the client can highlight it.</summary>
	partial void OnBreakpointHit(ICorDebugBreakpoint breakpoint, ICorDebugThread thread) {
		// A call the step went over has returned: its value is kept, and the step goes on.
		if (TryCaptureReturnValue(breakpoint, thread))
			return;
		// A step in flight owns the location it started from: the runtime re-announces the breakpoint
		// under the thread when the step resumes it, and that report is not a stop the user asked for.
		if (IsNativeStepOrigin(breakpoint, thread))
			return;
		if (IsRunToCursorHit(breakpoint, thread)) {
			Stop(StopReasons.RunToCursor, thread);
			return;
		}
		// The entry-point breakpoint is the session's own, so it has no entry in the table to name it.
		if (IsEntryBreakpoint(breakpoint)) {
			DisarmEntryBreakpoint();
			Stop(StopReasons.Entry, thread);
			return;
		}
		var function = breakpoint as ICorDebugFunctionBreakpoint;
		var entry = function is null ? null : FindEntry(function);
		// A breakpoint the user set wins over a step's temporary one at the same location, so the
		// stop is reported as the breakpoint it is. Stop() clears the step either way.
		if (entry is not null) {
			// A condition or a tracepoint expression is evaluated with the full evaluator, which may call into
			// the debuggee: the process is held where it is and the hit decided off the dispatcher.
			if (entry.Enabled && NeedsEvaluator(entry.Settings)) {
				deciding = true;
				holdAfterEvent = true;
				var isSteppingTarget = IsSteppingBreakpoint(breakpoint);
				_ = Task.Run(() => DecideBreakpointHitAsync(entry, thread, isSteppingTarget));
				return;
			}
			// A filter or a hit count can decide this hit is not one the user wants, and a tracepoint
			// prints and keeps going. Not calling Stop() is all that takes: the process stays unstopped,
			// and AfterEventProcessed() resumes it.
			if (!ShouldBreakOnHit(entry, thread)) {
				// The location may still be where a step was waiting to land, and a breakpoint
				// declining to stop must not swallow the step the user asked for.
				if (IsSteppingBreakpoint(breakpoint))
					Stop(StopReasons.Step, thread);
				return;
			}
			Stop(StopReasons.Breakpoint, thread, entry.Id);
			return;
		}
		if (!IsSteppingBreakpoint(breakpoint)) {
			Stop(StopReasons.Breakpoint, thread, null);
			return;
		}
		Stop(StopReasons.Step, thread);
	}

	/// <summary>Resolves the entry behind an engine breakpoint, so a hit can name itself.</summary>
	BreakpointEntry? FindEntry(ICorDebugFunctionBreakpoint breakpoint) {
		try {
			var token = breakpoint.Function.Token;
			return breakpoints.FindByEngineIdentity(token, breakpoint.Offset);
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return null;
		}
	}
}
