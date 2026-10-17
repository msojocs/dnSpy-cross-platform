using System.Globalization;
using System.Text.Json;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Debugging.CorDebug.Evaluation;
using ICorDebugSharp;
using ICorDebugSharp.Extensions;
using Microsoft.CodeAnalysis;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>
/// The stack half of a session: the frames of a stopped thread, written the way dnSpy's Call Stack window
/// writes them, and the decompiled location each one is stopped at.
/// </summary>
/// <remarks>
/// Frames are addressed by an id the engine hands out, because an ICorDebug frame has no identity of its own
/// and stops being valid as soon as the process runs again — a func-eval included. A frame is therefore also
/// remembered by its thread and its position on the stack, which is how it is read again after an evaluation
/// (<see cref="GetFrame"/>). Names come from metadata; only the line a frame is on needs the decompiler, and
/// that happens off the dispatcher.
/// </remarks>
internal sealed partial class CorDebugSession {
	/// <summary>
	/// How many frames of one stack get their decompiled line looked up up front. The frames nearest the
	/// stop are the ones a user navigates; the rest are resolved when the user switches to them.
	/// </summary>
	const int MaxResolvedFrames = 24;

	const string RunningReason = "The process is running.";

	readonly FrameTable frameTable = new();
	readonly VariableTable variableTable = new();
	readonly Dictionary<(int ThreadId, int Index), (int Generation, ICorDebugFrame Frame)> frameCache = new();
	ManagedValueFormatter? valueFormatter;

	ManagedValueFormatter Formatter => valueFormatter ??= new ManagedValueFormatter(variableTable);

	/// <summary>An identity the client can address: the frame id, and where the frame is.</summary>
	internal sealed record RawFrame(int Id, string ModulePath, int MetadataToken, int IlOffset, bool IsInternal, string? InternalName, ulong NativeAddress, int NativeOffset);

	/// <summary>
	/// The managed frame at <paramref name="index"/> on a thread, read again once a continue has neutered the
	/// one read before. Runs on the dispatcher.
	/// </summary>
	internal ICorDebugFrame? GetFrame(int threadId, int index) {
		if (frameCache.TryGetValue((threadId, index), out var cached) && cached.Generation == Generation)
			return cached.Frame;
		var thread = Threads.Find(threadId);
		if (thread is null)
			return null;
		var position = 0;
		try {
			foreach (var frame in WalkFrames(thread, index + 1)) {
				if (position++ == index) {
					frameCache[(threadId, index)] = (Generation, frame);
					return frame;
				}
			}
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
		}
		return null;
	}

	// ---------------------------------------------------------------- stack trace

	internal async Task<JsonElement> StackTraceAsync(JsonElement? arguments, CancellationToken cancellationToken) {
		var args = arguments is { ValueKind: JsonValueKind.Object } value ? value : default;
		var threadId = GetInt(args, "threadId") ?? 0;
		var startFrame = Math.Max(GetInt(args, "startFrame") ?? 0, 0);
		var levels = GetInt(args, "levels") ?? 0;
		var format = StackFrameFormat.Parse(args);

		var snapshot = await Dispatcher.RunAsync(() => SnapshotFrames(threadId, startFrame, levels)).ConfigureAwait(false);
		var names = await FormatFrameNamesAsync(threadId, snapshot, format, cancellationToken).ConfigureAwait(false);
		var resolved = await ResolveFramesAsync(snapshot, names, cancellationToken).ConfigureAwait(false);
		return DebugJson.Serialize(new {
			stackFrames = resolved,
			totalFrames = resolved.Length,
		});
	}

	/// <summary>Walks the stopped thread and registers what it finds, so scopes can come back to it.</summary>
	IReadOnlyList<RawFrame> SnapshotFrames(int threadId, int startFrame, int levels) {
		if (!IsStopped)
			throw new RpcException(ErrorCodes.InvalidParams, RunningReason);
		var thread = Threads.Find(threadId) ?? throw new RpcException(ErrorCodes.InvalidParams, $"There is no thread with id {threadId}.");
		var frames = new List<RawFrame>();
		var index = 0;
		foreach (var (frame, internalName) in WalkFramesWithTransitions(thread)) {
			if (frame is null) {
				frames.Add(new RawFrame(0, string.Empty, 0, -1, true, internalName, 0, 0));
				continue;
			}
			var entry = frameTable.Add(frame, threadId, index);
			frameCache[(threadId, index)] = (Generation, frame);
			index++;
			var (modulePath, token) = FrameIdentity(frame);
			var (nativeAddress, nativeOffset) = ReadNativeLocation(frame);
			frames.Add(new RawFrame(entry.Id, modulePath, token, ReadIlOffset(frame), false, null, nativeAddress, nativeOffset));
		}
		return startFrame >= frames.Count
			? Array.Empty<RawFrame>()
			: (levels > 0 ? frames.Skip(startFrame).Take(levels) : frames.Skip(startFrame)).ToArray();
	}

	/// <summary>
	/// The managed frames of a thread, innermost first — the order the client numbers them in.
	/// </summary>
	/// <remarks>
	/// The active chain holds the frame the thread stopped in; each caller chain holds the frames that
	/// were running when it was called, so enumerating from the active chain outwards is what puts the
	/// innermost frame first. A tracepoint asks for only the handful of frames its message names, which
	/// is why the count is a parameter rather than always the whole stack.
	/// </remarks>
	static IEnumerable<ICorDebugFrame> WalkFrames(ICorDebugThread thread, int max) {
		var chain = thread.ActiveChain;
		var produced = 0;
		for (var depth = 0; chain is not null && depth < 64; depth++) {
			if (chain.IsManaged) {
				foreach (var frame in chain.Frames) {
					if (produced >= max)
						yield break;
					produced++;
					yield return frame;
				}
			}
			chain = chain.Caller;
		}
	}

	/// <summary>
	/// The frames as the Call Stack window lists them: managed frames, with a transition row where native code
	/// sits between two runs of them — the "[Native to Managed Transition]" rows WPF shows.
	/// </summary>
	static IEnumerable<(ICorDebugFrame? Frame, string? InternalName)> WalkFramesWithTransitions(ICorDebugThread thread) {
		var chain = thread.ActiveChain;
		var sawManaged = false;
		var pendingTransition = false;
		for (var depth = 0; chain is not null && depth < 64; depth++) {
			if (chain.IsManaged) {
				var frames = chain.Frames;
				if (frames.Length > 0 && pendingTransition && sawManaged)
					yield return (null, "[Native to Managed Transition]");
				pendingTransition = false;
				foreach (var frame in frames) {
					sawManaged = true;
					yield return (frame, null);
				}
			}
			else
				pendingTransition = true;
			chain = chain.Caller;
		}
	}

	/// <summary>The native code address a frame is at and its offset in the method's code.</summary>
	static (ulong Address, int Offset) ReadNativeLocation(ICorDebugFrame frame) {
		try {
			if (frame is not ICorDebugNativeFrame native)
				return (0, 0);
			if (native.TryGetIP(out var offset) < 0)
				return (0, 0);
			if (frame.Function.TryGetNativeCode(out var code) < 0 || code is null)
				return (0, 0);
			return (code.Address.Value + offset, (int)offset);
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return (0, 0);
		}
	}

	/// <summary>The Call Stack window's display options (dnSpy's <c>CallStackDisplaySettings</c>).</summary>
	internal sealed record StackFrameFormat(bool ModuleNames, bool ParameterTypes, bool ParameterNames, bool ParameterValues, bool InstructionPointer, bool ReturnTypes, bool Namespaces, bool IntrinsicTypeKeywords, bool DeclaringTypes, bool Tokens, bool Hexadecimal, bool DigitSeparators) {
		public static StackFrameFormat Parse(JsonElement args) {
			if (args.ValueKind != JsonValueKind.Object || !args.TryGetProperty("format", out var format) || format.ValueKind != JsonValueKind.Object)
				return new StackFrameFormat(true, true, true, false, true, false, true, true, true, false, true, false);
			bool Read(string name, bool fallback) => format.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False ? value.GetBoolean() : fallback;
			return new StackFrameFormat(
				Read("showModuleNames", true),
				Read("showParameterTypes", true),
				Read("showParameterNames", true),
				Read("showParameterValues", false),
				Read("showFunctionOffset", true),
				Read("showReturnTypes", false),
				Read("showNamespaces", true),
				Read("showIntrinsicTypeKeywords", true),
				Read("showDeclaringTypes", true),
				Read("showTokens", false),
				Read("useHexadecimal", true),
				Read("useDigitSeparators", false));
		}
	}

	/// <summary>
	/// Writes each frame the way dnSpy's <c>CSharpStackFrameFormatter</c> does:
	/// <c>module!Namespace.Type.Method(int a, string b) (IL=0x0005, Native=0x...+0x1A)</c>. Names come from
	/// metadata, so no frame has to be decompiled to be named.
	/// </summary>
	async Task<IReadOnlyList<(string Text, IReadOnlyList<TextPartDto> Parts)>> FormatFrameNamesAsync(int threadId, IReadOnlyList<RawFrame> frames, StackFrameFormat format, CancellationToken cancellationToken) {
		var result = new (string, IReadOnlyList<TextPartDto>)[frames.Count];
		DebuggeeTypeSystem? types = null;
		try {
			types = TypeSystem;
			_ = types.BuiltVersion;
		}
		catch (Exception ex) when (ex is IOException or InvalidOperationException or BadImageFormatException) {
			types = null;
		}
		var language = Options.Language;
		for (var index = 0; index < frames.Count; index++) {
			var frame = frames[index];
			if (frame.IsInternal) {
				result[index] = (frame.InternalName ?? "[External Code]", [new TextPartDto(frame.InternalName ?? "[External Code]", TextColors.Text)]);
				continue;
			}
			var output = new ColorTextWriter();
			if (format.ModuleNames) {
				output.Write(TextColors.Module, string.IsNullOrEmpty(frame.ModulePath) ? "???" : Path.GetFileName(frame.ModulePath));
				output.Write(TextColors.Operator, "!");
			}
			var entry = string.IsNullOrEmpty(frame.ModulePath) ? null : Modules.FindEntry(frame.ModulePath);
			var method = types is not null && entry is not null ? types.GetMember(entry, frame.MetadataToken) as IMethodSymbol : null;
			if (method is null)
				output.Write(TextColors.Error, $"0x{frame.MetadataToken:X8}");
			else {
				var runtime = new EvalRuntime(this, types!, threadId, frameTable.Find(frame.Id)?.Index ?? 0, allowFuncEval: false, cancellationToken);
				var options = new ValueFormatOptions {
					Language = language,
					Hexadecimal = format.Hexadecimal,
					DigitSeparators = format.DigitSeparators,
					ShowNamespaces = format.Namespaces,
					IntrinsicTypeKeywords = format.IntrinsicTypeKeywords,
					ShowTokens = format.Tokens,
					FuncEval = false,
				};
				await StackFrameFormatter.WriteAsync(output, new ValueFormatter(runtime, options, null), runtime, method, frame, format, language).ConfigureAwait(false);
			}
			result[index] = (output.ToString(), output.ToList());
		}
		return result;
	}

	/// <summary>
	/// Adds the decompiled line to the frames the decompiler knows. Only the workspace's own modules are
	/// looked up: a frame in the framework has no document the user opened, and decompiling one to number
	/// its line would cost more than it is worth until the user actually switches to it.
	/// </summary>
	async Task<object[]> ResolveFramesAsync(IReadOnlyList<RawFrame> frames, IReadOnlyList<(string Text, IReadOnlyList<TextPartDto> Parts)> names, CancellationToken cancellationToken) {
		var workspaceModules = new Dictionary<string, bool>(StringComparer.Ordinal);
		var resolved = new object[frames.Count];
		var budget = MaxResolvedFrames;
		for (var index = 0; index < frames.Count; index++) {
			var frame = frames[index];
			var line = 0;
			var column = 0;
			string? nodeId = null;
			string? description = null;
			var resolvedLocation = false;
			if (!frame.IsInternal && budget > 0 && SymbolResolver is not null && !string.IsNullOrEmpty(frame.ModulePath) &&
				await IsWorkspaceModuleAsync(frame.ModulePath, workspaceModules, cancellationToken).ConfigureAwait(false)) {
				budget--;
				resolvedLocation = true;
				var location = await SymbolResolver.ResolveIlLocationAsync(WorkspaceId, frame.ModulePath, frame.MetadataToken, frame.IlOffset, cancellationToken).ConfigureAwait(false);
				if (location is not null) {
					line = location.StartLine;
					column = location.StartColumn;
					nodeId = location.NodeId;
					description = location.Description;
				}
			}
			resolved[index] = new {
				id = frame.Id,
				name = names[index].Text,
				nameParts = names[index].Parts,
				line,
				column,
				source = string.IsNullOrEmpty(frame.ModulePath)
					? null
					: new { name = Path.GetFileName(frame.ModulePath), path = frame.ModulePath },
				nodeId,
				description,
				metadataToken = frame.MetadataToken,
				ilOffset = frame.IlOffset,
				nativeAddress = frame.NativeAddress,
				isInternal = frame.IsInternal,
				// A frame whose location was not looked up up front is resolved when the user switches to it.
				locationResolved = resolvedLocation || frame.IsInternal,
			};
		}
		return resolved;
	}

	/// <summary>
	/// The decompiled location of one frame, for a frame whose line was not resolved with the stack — a deep
	/// frame, or one in a module the workspace does not hold. The client asks when the user switches to it.
	/// </summary>
	internal async Task<JsonElement> FrameLocationAsync(JsonElement? arguments, CancellationToken cancellationToken) {
		var args = arguments is { ValueKind: JsonValueKind.Object } value ? value : default;
		var frameId = GetInt(args, "frameId") ?? 0;
		var entry = frameTable.Find(frameId) ?? throw new RpcException(ErrorCodes.InvalidParams, $"There is no frame with id {frameId}; it belongs to an earlier stop.");
		var identity = await Dispatcher.RunAsync(() => {
			var frame = GetFrame(entry.ThreadId, entry.Index) ?? entry.Frame;
			var (modulePath, token) = FrameIdentity(frame);
			return (modulePath, token, ReadIlOffset(frame));
		}).ConfigureAwait(false);
		ResolvedIlLocation? location = null;
		if (SymbolResolver is not null && !string.IsNullOrEmpty(identity.modulePath))
			location = await SymbolResolver.ResolveIlLocationAsync(WorkspaceId, identity.modulePath, identity.token, identity.Item3, cancellationToken).ConfigureAwait(false);
		return DebugJson.Serialize(new {
			line = location?.StartLine ?? 0,
			column = location?.StartColumn ?? 0,
			endLine = location?.EndLine ?? 0,
			endColumn = location?.EndColumn ?? 0,
			nodeId = location?.NodeId,
			description = location?.Description,
			modulePath = identity.modulePath,
			metadataToken = identity.token,
			ilOffset = identity.Item3,
			isExternalModule = location?.IsExternalModule ?? true,
		});
	}

	async Task<bool> IsWorkspaceModuleAsync(string modulePath, Dictionary<string, bool> cache, CancellationToken cancellationToken) {
		if (cache.TryGetValue(modulePath, out var known))
			return known;
		var isWorkspace = await SymbolResolver!.IsWorkspaceModuleAsync(WorkspaceId, modulePath, cancellationToken).ConfigureAwait(false);
		cache[modulePath] = isWorkspace;
		return isWorkspace;
	}

	/// <summary>The module and method a frame runs, read the way the resolver spells them.</summary>
	static (string ModulePath, int MetadataToken) FrameIdentity(ICorDebugFrame frame) {
		try {
			var module = frame.Function.Module;
			return (module is null ? string.Empty : BreakpointTable.TryGetModulePath(module), unchecked((int)frame.FunctionToken.Value));
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return (string.Empty, 0);
		}
	}

	/// <summary>
	/// The IL offset a frame is stopped at. The instruction pointer reports the instruction the frame
	/// is about to execute, which is the location itself: a breakpoint at <c>IL_0001</c> reports
	/// <c>IP = 1</c>, and so does a step that has just run the instruction at <c>IL_0000</c>. That is
	/// worth stating because the Windows debugger APIs report the instruction just executed instead,
	/// and an offset shifted by one would miss every sequence point after the first.
	/// </summary>
	static int ReadIlOffset(ICorDebugFrame frame) {
		if (frame is not ICorDebugILFrame ilFrame)
			return -1;
		try {
			var (offset, _) = ilFrame.IP;
			return offset;
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return -1;
		}
	}

	/// <summary>How an IL offset maps onto the native code — exact, approximate, prolog, epilog.</summary>
	static CorDebugMappingResult ReadIlMapping(ICorDebugFrame frame) {
		if (frame is not ICorDebugILFrame ilFrame)
			return CorDebugMappingResult.MAPPING_NO_INFO;
		try {
			var (_, mapping) = ilFrame.IP;
			return mapping;
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return CorDebugMappingResult.MAPPING_NO_INFO;
		}
	}

	// ---------------------------------------------------------------- scopes

	internal JsonElement Scopes(JsonElement? arguments) {
		var args = arguments is { ValueKind: JsonValueKind.Object } value ? value : default;
		var frameId = GetInt(args, "frameId") ?? 0;
		var entry = frameTable.Find(frameId) ?? throw new RpcException(ErrorCodes.InvalidParams, $"There is no frame with id {frameId}; it belongs to an earlier stop.");
		if (entry.Frame is not ICorDebugILFrame)
			return DebugJson.Serialize(new { scopes = Array.Empty<object>() });
		if (entry.LocalsReference == 0)
			entry.LocalsReference = variableTable.Add(new FrameScopeEntry(entry.ThreadId, entry.Index));
		return DebugJson.Serialize(new {
			scopes = new object[] {
				new { name = "Locals", variablesReference = entry.LocalsReference, expensive = false },
			},
		});
	}
}

/// <summary>dnSpy's <c>CSharpStackFrameFormatter</c> and its Visual Basic twin, over Roslyn symbols.</summary>
internal static class StackFrameFormatter {
	static readonly Dictionary<string, string[]> CSharpOperators = new(StringComparer.Ordinal) {
		["op_Addition"] = ["operator", "+"],
		["op_Subtraction"] = ["operator", "-"],
		["op_Multiply"] = ["operator", "*"],
		["op_Division"] = ["operator", "/"],
		["op_Modulus"] = ["operator", "%"],
		["op_Equality"] = ["operator", "=="],
		["op_Inequality"] = ["operator", "!="],
		["op_LessThan"] = ["operator", "<"],
		["op_GreaterThan"] = ["operator", ">"],
		["op_LessThanOrEqual"] = ["operator", "<="],
		["op_GreaterThanOrEqual"] = ["operator", ">="],
		["op_Implicit"] = ["implicit", "operator"],
		["op_Explicit"] = ["explicit", "operator"],
		["op_UnaryNegation"] = ["operator", "-"],
		["op_UnaryPlus"] = ["operator", "+"],
		["op_LogicalNot"] = ["operator", "!"],
		["op_OnesComplement"] = ["operator", "~"],
		["op_Increment"] = ["operator", "++"],
		["op_Decrement"] = ["operator", "--"],
		["op_BitwiseAnd"] = ["operator", "&"],
		["op_BitwiseOr"] = ["operator", "|"],
		["op_ExclusiveOr"] = ["operator", "^"],
		["op_LeftShift"] = ["operator", "<<"],
		["op_RightShift"] = ["operator", ">>"],
		["op_True"] = ["operator", "true"],
		["op_False"] = ["operator", "false"],
	};

	internal static async Task WriteAsync(ColorTextWriter output, ValueFormatter formatter, EvalRuntime runtime, IMethodSymbol method, CorDebugSession.RawFrame frame, CorDebugSession.StackFrameFormat format, EvalLanguage language) {
		var isCSharp = language == EvalLanguage.CSharp;
		// An async or iterator body runs in a generated MoveNext: the frame is named after the method the user wrote.
		var shown = KickoffMethod(method) ?? method;
		if (shown.AssociatedSymbol is IPropertySymbol property) {
			if (format.ReturnTypes) {
				output.Write(formatter.FormatTypeName(property.Type));
				output.Write(TextColors.Text, " ");
			}
			if (format.DeclaringTypes) {
				output.Write(formatter.FormatTypeName(property.ContainingType));
				output.Write(TextColors.Operator, ".");
			}
			if (property.IsIndexer)
				output.Write(TextColors.Keyword, isCSharp ? "this" : "Item");
			else
				output.Write(ValueFormatter.ColorOf(property), formatter.EscapeIdentifier(property.Name));
			output.Write(TextColors.Operator, ".");
			output.Write(TextColors.Keyword, shown.MethodKind == MethodKind.PropertyGet ? (isCSharp ? "get" : "Get") : (isCSharp ? "set" : "Set"));
		}
		else if (shown.AssociatedSymbol is IEventSymbol @event) {
			if (format.DeclaringTypes) {
				output.Write(formatter.FormatTypeName(@event.ContainingType));
				output.Write(TextColors.Operator, ".");
			}
			output.Write(ValueFormatter.ColorOf(@event), formatter.EscapeIdentifier(@event.Name));
			output.Write(TextColors.Operator, ".");
			output.Write(TextColors.Keyword, shown.MethodKind == MethodKind.EventAdd ? (isCSharp ? "add" : "AddHandler") : (isCSharp ? "remove" : "RemoveHandler"));
		}
		else {
			var operatorInfo = isCSharp && shown.MethodKind is MethodKind.UserDefinedOperator or MethodKind.Conversion && CSharpOperators.TryGetValue(shown.Name, out var info) ? info : null;
			var isConversion = operatorInfo is not null && (operatorInfo[0] == "implicit" || operatorInfo[0] == "explicit");
			if (format.ReturnTypes && !isConversion && shown.MethodKind is not (MethodKind.Constructor or MethodKind.StaticConstructor)) {
				output.Write(formatter.FormatTypeName(shown.ReturnType));
				output.Write(TextColors.Text, " ");
			}
			if (format.DeclaringTypes) {
				output.Write(formatter.FormatTypeName(shown.ContainingType));
				output.Write(TextColors.Operator, ".");
			}
			if (shown.MethodKind is MethodKind.Constructor or MethodKind.StaticConstructor) {
				var typeName = shown.ContainingType.MetadataName;
				var tick = typeName.IndexOf('`');
				output.Write(ValueFormatter.ColorOf(shown.ContainingType), formatter.EscapeIdentifier(tick < 0 ? typeName : typeName[..tick]));
			}
			else if (operatorInfo is not null) {
				for (var index = 0; index < operatorInfo.Length; index++) {
					if (index > 0)
						output.Write(TextColors.Text, " ");
					output.Write(char.IsLower(operatorInfo[index][0]) ? TextColors.Keyword : TextColors.Operator, operatorInfo[index]);
				}
				if (isConversion) {
					output.Write(TextColors.Text, " ");
					output.Write(formatter.FormatTypeName(shown.ReturnType));
				}
			}
			else if (TryGetLocalFunctionName(shown.Name, out var containing, out var local)) {
				output.Write(ValueFormatter.ColorOf(shown), formatter.EscapeIdentifier(containing));
				output.Write(TextColors.Operator, ".");
				output.Write(ValueFormatter.ColorOf(shown), formatter.EscapeIdentifier(local));
			}
			else
				output.Write(ValueFormatter.ColorOf(shown), formatter.EscapeIdentifier(shown.Name));
		}
		if (format.Tokens)
			output.Write(TextColors.Comment, "/*0x" + shown.MetadataToken.ToString("X8", CultureInfo.InvariantCulture) + "*/");
		if (shown.TypeArguments.Length > 0) {
			output.Write(TextColors.Punctuation, isCSharp ? "<" : "(");
			if (!isCSharp)
				output.Write(TextColors.Keyword, "Of").Write(TextColors.Text, " ");
			for (var index = 0; index < shown.TypeArguments.Length; index++) {
				if (index > 0)
					output.Write(TextColors.Punctuation, ",").Write(TextColors.Text, " ");
				output.Write(formatter.FormatTypeName(shown.TypeArguments[index]));
			}
			output.Write(TextColors.Punctuation, isCSharp ? ">" : ")");
		}
		if (format.ParameterTypes || format.ParameterNames || format.ParameterValues) {
			output.Write(TextColors.Punctuation, "(");
			var parameters = shown.Parameters;
			for (var index = 0; index < parameters.Length; index++) {
				if (index > 0)
					output.Write(TextColors.Punctuation, ",").Write(TextColors.Text, " ");
				var parameter = parameters[index];
				var needSpace = false;
				if (format.ParameterTypes) {
					if (parameter.IsParams) {
						output.Write(TextColors.Keyword, isCSharp ? "params" : "ParamArray").Write(TextColors.Text, " ");
					}
					if (parameter.RefKind != RefKind.None)
						output.Write(TextColors.Keyword, (isCSharp ? parameter.RefKind switch { RefKind.Out => "out", RefKind.In => "in", _ => "ref" } : "ByRef")).Write(TextColors.Text, " ");
					output.Write(formatter.FormatTypeName(parameter.Type));
					needSpace = true;
				}
				if (format.ParameterNames) {
					if (needSpace)
						output.Write(TextColors.Text, " ");
					output.Write(TextColors.Parameter, formatter.EscapeIdentifier(string.IsNullOrEmpty(parameter.Name) ? "A_" + (index + (shown.IsStatic ? 0 : 1)).ToString(CultureInfo.InvariantCulture) : parameter.Name));
					needSpace = true;
				}
				if (format.ParameterValues && ReferenceEquals(shown, method)) {
					if (needSpace)
						output.Write(TextColors.Text, " ");
					output.Write(TextColors.Operator, "=").Write(TextColors.Text, " ");
					try {
						var value = await runtime.ReadArgumentAsync(index + (method.IsStatic ? 0 : 1), parameter.Type).ConfigureAwait(false);
						await formatter.FormatAsync(output, value).ConfigureAwait(false);
					}
					catch (EvaluationException) {
						output.Write(TextColors.Error, "???");
					}
				}
			}
			output.Write(TextColors.Punctuation, ")");
		}
		if (format.InstructionPointer) {
			var ilOffset = frame.IlOffset;
			var nativeAddress = frame.NativeAddress;
			var nativeOffset = frame.NativeOffset;
			output.Write(TextColors.Text, " ").Write(TextColors.Punctuation, "(").Write(TextColors.Text, "IL").Write(TextColors.Operator, "=");
			if (ilOffset < 0)
				output.Write(TextColors.Error, "???");
			else
				output.Write(TextColors.Number, (isCSharp ? "0x" : "&H") + (ilOffset <= ushort.MaxValue ? ilOffset.ToString("X4", CultureInfo.InvariantCulture) : ilOffset.ToString("X8", CultureInfo.InvariantCulture)));
			if (nativeAddress != 0) {
				output.Write(TextColors.Punctuation, ",").Write(TextColors.Text, " ").Write(TextColors.Text, "Native").Write(TextColors.Operator, "=");
				var start = nativeAddress - (ulong)nativeOffset;
				output.Write(TextColors.Number, (isCSharp ? "0x" : "&H") + (IntPtr.Size == 4 ? ((uint)start).ToString("X8", CultureInfo.InvariantCulture) : start.ToString("X16", CultureInfo.InvariantCulture)));
				output.Write(TextColors.Operator, "+").Write(TextColors.Number, (isCSharp ? "0x" : "&H") + nativeOffset.ToString("X", CultureInfo.InvariantCulture));
			}
			output.Write(TextColors.Punctuation, ")");
		}
	}

	/// <summary>The async or iterator method a state machine's MoveNext implements: <c>&lt;AddAsync&gt;d__2</c> is AddAsync.</summary>
	internal static IMethodSymbol? KickoffMethod(IMethodSymbol method) {
		if (method.Name != "MoveNext" || method.ContainingType is not { Name: var typeName, ContainingType: { } outer } || !typeName.StartsWith('<'))
			return null;
		var close = typeName.IndexOf('>', StringComparison.Ordinal);
		if (close <= 1)
			return null;
		var name = typeName[1..close];
		foreach (var candidate in outer.GetMembers(name).OfType<IMethodSymbol>()) {
			foreach (var attribute in candidate.GetAttributes()) {
				if (attribute.AttributeClass?.Name is "AsyncStateMachineAttribute" or "IteratorStateMachineAttribute" or "AsyncIteratorStateMachineAttribute"
					&& attribute.ConstructorArguments.FirstOrDefault().Value is INamedTypeSymbol stateMachine
					&& SymbolEqualityComparer.Default.Equals(stateMachine.OriginalDefinition, method.ContainingType.OriginalDefinition))
					return candidate;
			}
		}
		return outer.GetMembers(name).OfType<IMethodSymbol>().FirstOrDefault();
	}

	/// <summary>A local function's generated name, <c>&lt;Main&gt;g__Local|0_0</c>, as <c>Main.Local</c>.</summary>
	static bool TryGetLocalFunctionName(string name, out string containing, out string local) {
		containing = local = string.Empty;
		if (name.Length < 5 || name[0] != '<')
			return false;
		var close = name.IndexOf('>', StringComparison.Ordinal);
		if (close <= 1 || close + 3 >= name.Length || name[close + 1] != 'g' || name[close + 2] != '_' || name[close + 3] != '_')
			return false;
		var bar = name.IndexOf('|', close);
		if (bar < 0)
			return false;
		containing = name[1..close];
		local = name[(close + 4)..bar];
		return local.Length > 0;
	}
}
