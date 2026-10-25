using System.Globalization;
using System.Reflection.PortableExecutable;
using System.Text.Json;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Debugging.CorDebug.Evaluation;
using Iced.Intel;
using ICorDebugSharp;
using ICorDebugSharp.Extensions;
using IcedDecoder = Iced.Intel.Decoder;
using IcedInstruction = Iced.Intel.Instruction;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>
/// The debugger's views of native memory: the Memory windows' bytes, a module's image as the process has it
/// (Open Module from Memory, Save Module), and the Disassembly view of a jitted method — dnSpy's
/// <c>DisassemblyContentGenerator</c> over Iced, with the method's IL and source as comments.
/// </summary>
internal sealed partial class CorDebugSession {
	// ---------------------------------------------------------------- memory

	/// <summary>
	/// <c>readMemory</c>: bytes of the process, a page at a time so an unmapped page only blanks itself. The
	/// address is a string — a 64-bit address does not survive being a JSON number.
	/// </summary>
	internal async Task<JsonElement> ReadMemoryAsync(JsonElement? arguments) {
		var args = arguments is { ValueKind: JsonValueKind.Object } value ? value : default;
		var address = ParseAddress(GetString(args, "address")) ?? (ulong)(GetLong(args, "address") ?? 0);
		var count = Math.Clamp(GetInt(args, "count") ?? 0, 0, 1024 * 1024);
		var (data, readable) = await Dispatcher.RunAsync(() => ReadMemoryPaged(address, count)).ConfigureAwait(false);
		return DebugJson.Serialize(new {
			address = "0x" + address.ToString("X", CultureInfo.InvariantCulture),
			data = Convert.ToBase64String(data),
			// One flag per page of 4096 bytes from the page the address is in, true where the page could be read.
			readable,
			pageSize = PageSize,
		});
	}

	const int PageSize = 4096;

	(byte[] Data, bool[] Readable) ReadMemoryPaged(ulong address, int count) {
		var data = new byte[count];
		var firstPage = address & ~(ulong)(PageSize - 1);
		var lastPage = (address + (ulong)Math.Max(count, 1) - 1) & ~(ulong)(PageSize - 1);
		var pages = (int)((lastPage - firstPage) / PageSize) + 1;
		var readable = new bool[pages];
		for (var page = 0; page < pages; page++) {
			var pageStart = firstPage + (ulong)page * PageSize;
			var start = Math.Max(pageStart, address);
			var end = Math.Min(pageStart + PageSize, address + (ulong)count);
			if (end <= start)
				continue;
			var bytes = ReadMemoryCore(start, (int)(end - start));
			if (bytes is null || bytes.Length == 0)
				continue;
			readable[page] = bytes.Length == (int)(end - start);
			Array.Copy(bytes, 0, data, (int)(start - address), bytes.Length);
		}
		return (data, readable);
	}

	/// <summary><c>writeMemory</c>: the Memory window's edits, written straight into the process.</summary>
	internal async Task<JsonElement> WriteMemoryAsync(JsonElement? arguments) {
		var args = arguments is { ValueKind: JsonValueKind.Object } value ? value : default;
		var address = ParseAddress(GetString(args, "address")) ?? throw new RpcException(ErrorCodes.InvalidParams, "An address is required.");
		var data = Convert.FromBase64String(GetString(args, "data") ?? string.Empty);
		var written = await Dispatcher.RunAsync(() => {
			if (process is null)
				return 0;
			try {
				return (int)(nuint)process.WriteMemory(new CORDB_ADDRESS(address), data.Length, data);
			}
			catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
				return 0;
			}
		}).ConfigureAwait(false);
		if (written != data.Length)
			throw new RpcException(ErrorCodes.InvalidParams, "The memory could not be written.");
		// A value read before the write may be the one that changed.
		Generation++;
		return DebugJson.Serialize(new { written });
	}

	static ulong? ParseAddress(string? text) {
		if (string.IsNullOrWhiteSpace(text))
			return null;
		text = text.Trim();
		if (text.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
			return ulong.TryParse(text[2..], NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var hex) ? hex : null;
		return ulong.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number) ? number : null;
	}

	static long? GetLong(JsonElement element, string name) =>
		element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number) ? number : null;

	// ---------------------------------------------------------------- module images

	/// <summary>
	/// A loaded module's image in file layout: an in-memory module already is one, while a module the runtime
	/// mapped from disk is laid out by section and is put back the way the file stores it — what dnSpy's Open
	/// Module from Memory and Save Module read.
	/// </summary>
	byte[]? ReadModuleFileImage(ModuleTable.ModuleEntry entry) {
		if (entry.IsDynamic)
			return ReadDynamicModuleImage(entry);
		var image = ReadMemoryCore(entry.Address, (int)entry.Size);
		if (image is null || image.Length < 0x200)
			return null;
		if (entry.IsInMemory)
			return image;
		try {
			using var reader = new PEReader(new MemoryStream(image), PEStreamOptions.IsLoadedImage);
			var headers = reader.PEHeaders;
			var fileSize = headers.PEHeader?.SizeOfHeaders ?? 0;
			foreach (var section in headers.SectionHeaders)
				fileSize = Math.Max(fileSize, section.PointerToRawData + section.SizeOfRawData);
			var file = new byte[fileSize];
			Array.Copy(image, file, Math.Min(headers.PEHeader?.SizeOfHeaders ?? 0, image.Length));
			foreach (var section in headers.SectionHeaders) {
				var length = Math.Min(section.SizeOfRawData, Math.Max(0, image.Length - section.VirtualAddress));
				if (length > 0)
					Array.Copy(image, section.VirtualAddress, file, section.PointerToRawData, length);
			}
			return file;
		}
		catch (Exception ex) when (ex is BadImageFormatException or ArgumentException or InvalidOperationException) {
			return null;
		}
	}

	/// <summary>
	/// <c>saveModule</c>: writes a module's image to a file — Open Module from Memory reads it from a temporary
	/// one, Save Module from the one the user picks. Answers with the path written.
	/// </summary>
	internal async Task<JsonElement> SaveModuleAsync(JsonElement? arguments) {
		var args = arguments is { ValueKind: JsonValueKind.Object } value ? value : default;
		var order = GetInt(args, "moduleId") ?? throw new RpcException(ErrorCodes.InvalidParams, "A module is required.");
		var entry = Modules.FindByOrder(order) ?? throw new RpcException(ErrorCodes.InvalidParams, "The module is no longer loaded.");
		var bytes = await Dispatcher.RunAsync(() => ReadModuleFileImage(entry)).ConfigureAwait(false)
			?? throw new RpcException(ErrorCodes.InvalidParams, "The module's image could not be read from the process.");
		var path = GetString(args, "path");
		if (string.IsNullOrEmpty(path)) {
			// The copy keeps the module's own name — a dynamic module's is the one DefineDynamicModule gave it — which is
			// how the workspace and the engine tell which module of the process it stands for.
			var directory = Path.Combine(MemoryModuleFiles.Root, TargetProcessId.ToString(CultureInfo.InvariantCulture), entry.Order.ToString(CultureInfo.InvariantCulture));
			Directory.CreateDirectory(directory);
			var name = string.IsNullOrEmpty(entry.Name) ? $"module_{entry.Order}.dll" : entry.Name;
			path = Path.Combine(directory, name);
		}
		await File.WriteAllBytesAsync(path, bytes).ConfigureAwait(false);
		return DebugJson.Serialize(new { path });
	}

	// ---------------------------------------------------------------- disassembly

	/// <summary>The Disassembly view's options: dnSpy's DisassemblyContentSettings and the dialect's code style.</summary>
	sealed record DisassemblyOptions(string Syntax, bool Addresses, bool Bytes, bool ILCode, bool Code, bool EmptyLineBetweenBlocks, bool Labels, JsonElement Style);

	/// <summary>
	/// <c>disassemble</c>: a method's native code as the JIT compiled it, in the Disassembly view's dialect and
	/// style. The method is the frame's, or one named by module and token; the line the frame is at is marked.
	/// </summary>
	internal async Task<JsonElement> DisassembleAsync(JsonElement? arguments, CancellationToken cancellationToken) {
		var args = arguments is { ValueKind: JsonValueKind.Object } value ? value : default;
		var options = ReadDisassemblyOptions(args);
		var native = await Dispatcher.RunAsync(() => ReadNativeCode(args)).ConfigureAwait(false);
		MethodSourceDto? source = null;
		if ((options.ILCode || options.Code) && SymbolResolver is IDebugSourceProvider sources && !string.IsNullOrEmpty(native.ModulePath))
			source = await sources.GetMethodSourceAsync(WorkspaceId, native.ModulePath, native.Token, cancellationToken).ConfigureAwait(false);
		var (lines, currentLine) = WriteDisassembly(native, source, options);
		return DebugJson.Serialize(new {
			title = native.MethodName ?? $"0x{native.Token:X8}",
			moduleName = Path.GetFileName(native.ModulePath),
			methodName = native.MethodName,
			// The Disassembly tab's title, and its tool tip's first lines: dnSpy names the tab by the method's short name.
			shortName = native.ShortName,
			isOptimized = native.IsOptimized,
			address = native.Address,
			size = native.Bytes.Length,
			lines,
			currentLine,
		});
	}

	sealed record NativeCode(string ModulePath, int Token, string? MethodName, string? ShortName, ulong Address, byte[] Bytes, COR_DEBUG_IL_TO_NATIVE_MAP[] Map, bool? IsOptimized, int? CurrentNativeOffset);

	static DisassemblyOptions ReadDisassemblyOptions(JsonElement args) {
		var options = args.ValueKind == JsonValueKind.Object && args.TryGetProperty("options", out var element) && element.ValueKind == JsonValueKind.Object ? element : default;
		bool Read(string name, bool fallback) => options.ValueKind == JsonValueKind.Object && options.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False ? value.GetBoolean() : fallback;
		var syntax = options.ValueKind == JsonValueKind.Object && options.TryGetProperty("syntax", out var syntaxValue) && syntaxValue.ValueKind == JsonValueKind.String ? syntaxValue.GetString() ?? "masm" : "masm";
		var style = options.ValueKind == JsonValueKind.Object && options.TryGetProperty("codeStyle", out var styleValue) ? styleValue : default;
		return new DisassemblyOptions(syntax, Read("showInstructionAddress", true), Read("showInstructionBytes", true), Read("showILCode", false), Read("showCode", true), Read("emptyLineBetweenBasicBlocks", true), Read("addLabels", true), style);
	}

	NativeCode ReadNativeCode(JsonElement args) {
		ICorDebugFunction? function = null;
		int? currentOffset = null;
		string modulePath;
		int token;
		if (GetInt(args, "frameId") is { } frameId && frameTable.Find(frameId) is { } entry) {
			var frame = GetFrame(entry.ThreadId, entry.Index) ?? throw new RpcException(ErrorCodes.InvalidParams, "The frame is no longer available.");
			function = frame.Function;
			(modulePath, token) = FrameIdentity(frame);
			if (frame is ICorDebugNativeFrame nativeFrame && nativeFrame.TryGetIP(out var ip) >= 0)
				currentOffset = (int)ip;
		}
		else {
			modulePath = GetString(args, "modulePath") ?? throw new RpcException(ErrorCodes.InvalidParams, "A frame or a method is required.");
			token = GetInt(args, "metadataToken") ?? throw new RpcException(ErrorCodes.InvalidParams, "A frame or a method is required.");
			var module = Modules.Find(modulePath) ?? throw new RpcException(ErrorCodes.InvalidParams, "The module is not loaded in the process.");
			function = module.GetFunctionFromToken(token);
		}
		if (function.TryGetNativeCode(out var code) < 0 || code is null)
			throw new RpcException(ErrorCodes.InvalidParams, "The method hasn't been JIT-compiled.");
		var size = code.Size;
		var (bytes, read) = code.GetCode(0, size, size);
		var map = Array.Empty<COR_DEBUG_IL_TO_NATIVE_MAP>();
		try {
			map = code.ILToNativeMapping;
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
		}
		var moduleEntry = string.IsNullOrEmpty(modulePath) ? null : Modules.FindEntry(modulePath);
		string? methodName = null;
		string? shortName = null;
		var types = TryGetTypeSystem();
		if (types is not null && moduleEntry is not null && types.GetMember(moduleEntry, token) is Microsoft.CodeAnalysis.IMethodSymbol method) {
			methodName = method.ToDisplayString();
			shortName = method.MethodKind is Microsoft.CodeAnalysis.MethodKind.Constructor or Microsoft.CodeAnalysis.MethodKind.StaticConstructor ? method.ContainingType.Name : method.Name;
		}
		return new NativeCode(modulePath, token, methodName, shortName, code.Address.Value, bytes.AsSpan(0, Math.Min(read, bytes.Length)).ToArray(), map, moduleEntry?.IsOptimized, currentOffset);
	}

	/// <summary>dnSpy's <c>DisassemblyContentGenerator.Write</c>, line by line, in the theme's assembly colours.</summary>
	static (List<List<TextPartDto>> Lines, int CurrentLine) WriteDisassembly(NativeCode code, MethodSourceDto? source, DisassemblyOptions options) {
		var formatter = CreateFormatter(options);
		var commentPrefix = options.Syntax == "gas" ? "#" : ";";
		var lines = new List<List<TextPartDto>>();
		var currentLine = -1;
		void Comment(string text) {
			foreach (var line in text.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n'))
				lines.Add([new TextPartDto(line.Length == 0 ? commentPrefix : commentPrefix + " " + line, "asmComment")]);
		}
		// The module, method, size and "not optimized" banner are the tab's description, not part of its
		// text: dnSpy's document viewer shows them in the tool tip and keeps the body to the instructions
		// and block comments.

		// Decode everything first: branch targets inside the method become labels.
		var decoder = IcedDecoder.Create(IntPtr.Size * 8, new ByteArrayCodeReader(code.Bytes), code.Address);
		var instructions = new List<IcedInstruction>();
		while (decoder.IP < code.Address + (ulong)code.Bytes.Length) {
			decoder.Decode(out var instruction);
			instructions.Add(instruction);
		}
		var labels = new Dictionary<ulong, string>();
		if (options.Labels) {
			foreach (var target in instructions.Where(instruction => instruction.FlowControl is FlowControl.UnconditionalBranch or FlowControl.ConditionalBranch && instruction.Op0Kind is OpKind.NearBranch16 or OpKind.NearBranch32 or OpKind.NearBranch64)
				.Select(instruction => instruction.NearBranchTarget)
				.Where(target => target >= code.Address && target < code.Address + (ulong)code.Bytes.Length)
				.Distinct()
				.Order())
				labels[target] = "LBL_" + labels.Count.ToString(CultureInfo.InvariantCulture);
		}
		var symbolResolver = new LabelResolver(labels);
		var resolvingFormatter = CreateFormatter(options, symbolResolver);

		// Blocks follow the IL-to-native map: each mapped range starts a block, commented with its IL and source.
		var blockStarts = new SortedDictionary<ulong, (int IlOffset, int IlEnd)>();
		var sortedMap = code.Map.Where(entry => entry.nativeStartOffset < entry.nativeEndOffset).OrderBy(entry => entry.nativeStartOffset).ToArray();
		foreach (var entry in sortedMap)
			blockStarts.TryAdd(code.Address + entry.nativeStartOffset, ((int)entry.ilOffset, -1));
		var output = new TextPartsFormatterOutput();
		var first = true;
		foreach (var instruction in instructions) {
			if (blockStarts.TryGetValue(instruction.IP, out var block) || labels.ContainsKey(instruction.IP)) {
				if (!first && options.EmptyLineBetweenBlocks)
					lines.Add([]);
				if (blockStarts.ContainsKey(instruction.IP))
					WriteBlockComment(Comment, block.IlOffset, sortedMap, source, options);
				if (labels.TryGetValue(instruction.IP, out var label))
					lines.Add([new TextPartDto(label, "asmLabel"), new TextPartDto(":", "asmPunctuation")]);
			}
			first = false;
			var line = new List<TextPartDto>();
			if (options.Addresses)
				line.Add(new TextPartDto((IntPtr.Size == 8 ? instruction.IP.ToString("X16", CultureInfo.InvariantCulture) : instruction.IP.ToString("X8", CultureInfo.InvariantCulture)) + " ", "asmAddress"));
			else
				line.Add(new TextPartDto("        ", "text"));
			if (options.Bytes) {
				var start = (int)(instruction.IP - code.Address);
				var hex = Convert.ToHexString(code.Bytes, start, instruction.Length);
				line.Add(new TextPartDto(hex, "asmHexBytes"));
				line.Add(new TextPartDto(new string(' ', Math.Max(0, 10 - instruction.Length) * 2 + 1), "text"));
			}
			output.Parts.Clear();
			resolvingFormatter.Format(instruction, output);
			line.AddRange(output.Parts);
			if (code.CurrentNativeOffset is { } current && instruction.IP == code.Address + (ulong)current)
				currentLine = lines.Count;
			lines.Add(line);
		}
		_ = formatter;
		return (lines, currentLine);
	}

	static void WriteBlockComment(Action<string> comment, int ilOffset, COR_DEBUG_IL_TO_NATIVE_MAP[] map, MethodSourceDto? source, DisassemblyOptions options) {
		const int Prolog = unchecked((int)0xFFFFFFFE);
		const int Epilog = unchecked((int)0xFFFFFFFD);
		const int NoMapping = unchecked((int)0xFFFFFFFF);
		switch (ilOffset) {
			case Prolog:
				comment("Prolog");
				return;
			case Epilog:
				comment("Epilog");
				return;
			case NoMapping:
				return;
		}
		if (source is null)
			return;
		// The IL range of this block runs to the next mapped IL offset.
		var nextIl = map.Select(entry => (int)entry.ilOffset).Where(offset => offset > ilOffset && offset >= 0).DefaultIfEmpty(int.MaxValue).Min();
		if (options.Code) {
			foreach (var statement in source.Statements) {
				if (!statement.IsHidden && statement.IlOffset >= ilOffset && statement.IlOffset < nextIl && statement.Text.Length > 0)
					comment(statement.Text);
			}
		}
		if (options.ILCode) {
			foreach (var instruction in source.Instructions) {
				if (instruction.Offset >= ilOffset && instruction.Offset < nextIl)
					comment(instruction.Text);
			}
		}
	}

	static Formatter CreateFormatter(DisassemblyOptions options, ISymbolResolver? resolver = null) {
		Formatter formatter = options.Syntax switch {
			"nasm" => new NasmFormatter(resolver),
			"gas" => new GasFormatter(resolver),
			"intel" => new IntelFormatter(resolver),
			_ => new MasmFormatter(resolver),
		};
		var style = options.Style;
		bool Read(string name, bool fallback) => style.ValueKind == JsonValueKind.Object && style.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False ? value.GetBoolean() : fallback;
		string? Text(string name) => style.ValueKind == JsonValueKind.Object && style.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
		var o = formatter.Options;
		o.UppercasePrefixes = Read("uppercasePrefixes", o.UppercasePrefixes);
		o.UppercaseMnemonics = Read("uppercaseMnemonics", o.UppercaseMnemonics);
		o.UppercaseRegisters = Read("uppercaseRegisters", o.UppercaseRegisters);
		o.UppercaseKeywords = Read("uppercaseKeywords", o.UppercaseKeywords);
		o.UppercaseHex = Read("uppercaseHex", o.UppercaseHex);
		o.UppercaseAll = Read("uppercaseAll", o.UppercaseAll);
		o.SpaceAfterOperandSeparator = Read("spaceAfterOperandSeparator", o.SpaceAfterOperandSeparator);
		o.SpaceAfterMemoryBracket = Read("spaceAfterMemoryBracket", o.SpaceAfterMemoryBracket);
		o.SpaceBetweenMemoryAddOperators = Read("spaceBetweenMemoryAddOperators", o.SpaceBetweenMemoryAddOperators);
		o.SpaceBetweenMemoryMulOperators = Read("spaceBetweenMemoryMulOperators", o.SpaceBetweenMemoryMulOperators);
		o.ScaleBeforeIndex = Read("scaleBeforeIndex", o.ScaleBeforeIndex);
		o.AlwaysShowScale = Read("alwaysShowScale", o.AlwaysShowScale);
		o.AlwaysShowSegmentRegister = Read("alwaysShowSegmentRegister", o.AlwaysShowSegmentRegister);
		o.ShowZeroDisplacements = Read("showZeroDisplacements", o.ShowZeroDisplacements);
		o.LeadingZeros = Read("leadingZeroes", o.LeadingZeros);
		o.BranchLeadingZeros = Read("branchLeadingZeroes", o.BranchLeadingZeros);
		o.SmallHexNumbersInDecimal = Read("smallHexNumbersInDecimal", o.SmallHexNumbersInDecimal);
		o.AddLeadingZeroToHexNumbers = Read("addLeadingZeroToHexNumbers", o.AddLeadingZeroToHexNumbers);
		o.SignedImmediateOperands = Read("signedImmediateOperands", o.SignedImmediateOperands);
		o.SignedMemoryDisplacements = Read("signedMemoryDisplacements", o.SignedMemoryDisplacements);
		o.MemorySizeOptions = Read("alwaysShowMemorySize", false) ? MemorySizeOptions.Always : MemorySizeOptions.Default;
		o.RipRelativeAddresses = Read("ripRelativeAddresses", o.RipRelativeAddresses);
		o.ShowBranchSize = Read("showBranchSize", o.ShowBranchSize);
		o.UsePseudoOps = Read("usePseudoOps", o.UsePseudoOps);
		o.ShowSymbolAddress = Read("showSymbolAddress", o.ShowSymbolAddress);
		o.GasSpaceAfterMemoryOperandComma = Read("gasSpaceAfterMemoryOperandComma", o.GasSpaceAfterMemoryOperandComma);
		o.GasNakedRegisters = Read("gasNakedRegisters", o.GasNakedRegisters);
		o.GasShowMnemonicSizeSuffix = Read("gasShowMnemonicSizeSuffix", o.GasShowMnemonicSizeSuffix);
		o.NumberBase = Read("useHexNumbers", true) ? NumberBase.Hexadecimal : NumberBase.Decimal;
		if (style.ValueKind == JsonValueKind.Object && style.TryGetProperty("operandColumn", out var column) && column.TryGetInt32(out var operandColumn))
			o.FirstOperandCharIndex = operandColumn;
		if (Text("hexPrefix") is { } prefix)
			o.HexPrefix = prefix.Length == 0 ? null : prefix;
		if (Text("hexSuffix") is { } suffix)
			o.HexSuffix = suffix.Length == 0 ? null : suffix;
		if (Text("digitSeparator") is { } separator)
			o.DigitSeparator = separator.Length == 0 ? null : separator;
		return formatter;
	}

	/// <summary>Names the branch targets inside the method with their labels.</summary>
	sealed class LabelResolver(Dictionary<ulong, string> labels) : ISymbolResolver {
		public bool TryGetSymbol(in IcedInstruction instruction, int operand, int instructionOperand, ulong address, int addressSize, out SymbolResult symbol) {
			if (labels.TryGetValue(address, out var label)) {
				symbol = new SymbolResult(address, label, FormatterTextKind.Label);
				return true;
			}
			symbol = default;
			return false;
		}
	}

	/// <summary>Iced's output as text parts, in the theme's assembly colour classes.</summary>
	sealed class TextPartsFormatterOutput : FormatterOutput {
		public List<TextPartDto> Parts { get; } = [];

		public override void Write(string text, FormatterTextKind kind) {
			var color = kind switch {
				FormatterTextKind.Directive => "asmDirective",
				FormatterTextKind.Prefix => "asmPrefix",
				FormatterTextKind.Mnemonic => "asmMnemonic",
				FormatterTextKind.Keyword => "asmKeyword",
				FormatterTextKind.Operator => "asmOperator",
				FormatterTextKind.Punctuation => "asmPunctuation",
				FormatterTextKind.Number => "asmNumber",
				FormatterTextKind.Register => "asmRegister",
				FormatterTextKind.SelectorValue => "asmSelectorValue",
				FormatterTextKind.LabelAddress => "asmLabelAddress",
				FormatterTextKind.FunctionAddress => "asmFunctionAddress",
				FormatterTextKind.Data => "asmData",
				FormatterTextKind.Label => "asmLabel",
				FormatterTextKind.Function => "asmFunction",
				_ => "text",
			};
			if (Parts.Count > 0 && Parts[^1].Color == color)
				Parts[^1] = Parts[^1] with { Text = Parts[^1].Text + text };
			else
				Parts.Add(new TextPartDto(text, color));
		}
	}

	// ---------------------------------------------------------------- autos

	/// <summary>
	/// <c>autos</c>: the Autos window — the variables and member accesses the current and the previous
	/// statement use, with the values the last step returned. The names come from the statements' decompiled
	/// text; an expression with a call in it is left out, so looking at Autos never runs the program.
	/// </summary>
	internal async Task<JsonElement> AutosAsync(JsonElement? arguments, CancellationToken cancellationToken) {
		var args = arguments is { ValueKind: JsonValueKind.Object } value ? value : default;
		var (threadId, frameIndex) = ResolveFrameArgument(args);
		using var gate = await EnterEvaluationAsync(cancellationToken).ConfigureAwait(false);
		var nodes = new List<ValueNode>();
		EvaluationScope scope;
		try {
			scope = await OpenScopeAsync(threadId, frameIndex, allowFuncEval: true, cancellationToken).ConfigureAwait(false);
		}
		catch (EvaluationException) {
			return DebugJson.Serialize(new { variables = Array.Empty<object>() });
		}
		if (Options.ShowReturnValues) {
			for (var index = 0; index < returnValues.Count; index++) {
				var info = returnValues[index];
				var name = new ColorTextWriter();
				var formatter = scope.Factory.Formatter();
				name.Write(formatter.FormatTypeName(info.Method.ContainingType));
				name.Write(TextColors.Operator, ".");
				name.Write(ValueFormatter.ColorOf(info.Method), formatter.EscapeIdentifier(info.Method.Name));
				name.Write(TextColors.Text, " ");
				name.Write(ColorTextWriter.DebugReturnValueName, "returned");
				nodes.Add(await scope.Factory.CreateAsync(name.ToList(), "$ReturnValue" + (index + 1).ToString(CultureInfo.InvariantCulture), info.Value, info.Method.ReturnType, "FieldPublic", "returnValue", canEdit: false).ConfigureAwait(false));
			}
		}
		if (SymbolResolver is IDebugSourceProvider sources && !string.IsNullOrEmpty(scope.Frame.ModulePath)) {
			var source = await sources.GetMethodSourceAsync(WorkspaceId, scope.Frame.ModulePath, scope.Frame.MethodToken, cancellationToken).ConfigureAwait(false);
			foreach (var expression in AutosExpressions(scope, source)) {
				var node = await EvaluateNodeAsync(threadId, frameIndex, expression, allowSideEffects: false, allowFuncEval: true, cancellationToken).ConfigureAwait(false);
				// A name the frame cannot see is not a variable to show.
				if (node.IsError || node.NeedsRefresh)
					continue;
				nodes.Add(node);
			}
		}
		return DebugJson.Serialize(new { variables = nodes.Select(node => ToDto(node, threadId, frameIndex)).ToArray() });
	}

	/// <summary>
	/// The variables the statement the frame is at and the one before it use, read from their IL: the locals
	/// and parameters they load and store, the fields of <c>this</c> and the static fields they touch — named
	/// the way the Locals window names them, in the order the IL first uses them.
	/// </summary>
	IReadOnlyList<string> AutosExpressions(EvaluationScope scope, MethodSourceDto? source) {
		var frame = scope.Frame;
		var types = scope.Runtime.Types;
		var entry = Modules.FindEntry(frame.ModulePath);
		if (source is null || entry is null || types.GetReader(entry) is not { } reader)
			return [];
		var statements = source.Statements.Where(statement => !statement.IsHidden && statement.IlEndOffset > statement.IlOffset).OrderBy(statement => statement.IlOffset).ToArray();
		var index = Array.FindLastIndex(statements, statement => statement.IlOffset <= frame.IlOffset);
		if (index < 0)
			return [];
		// The previous statement through the current one, and the IL in front of the previous one that no
		// statement claims: the decompiler folds a store into an initializer and leaves the IL that does it
		// between two statements.
		var start = index >= 2 ? Math.Min(statements[index - 2].IlEndOffset, statements[index - 1].IlOffset) : 0;
		var ranges = new List<(int Start, int End)> {
			(index >= 1 ? start : statements[index].IlOffset, statements[index].IlEndOffset),
		};
		byte[] il;
		try {
			var definition = reader.GetMethodDefinition(System.Reflection.Metadata.Ecma335.MetadataTokens.MethodDefinitionHandle(frame.MethodToken & 0x00FFFFFF));
			il = definition.RelativeVirtualAddress == 0 ? [] : types.GetMethodBody(entry, definition.RelativeVirtualAddress)?.GetILBytes() ?? [];
		}
		catch (BadImageFormatException) {
			return [];
		}
		var isCSharp = Options.Language == EvalLanguage.CSharp;
		var thisName = isCSharp ? "this" : "Me";
		var hasThis = frame.Method is { IsStatic: false };
		string? Variable(VariableSource source) => frame.Variables.FirstOrDefault(variable => variable.Source == source && !variable.IsCompilerGenerated)?.Name;
		var expressions = new List<string>();
		void Add(string? expression) {
			if (expression is not null && !expressions.Contains(expression, StringComparer.Ordinal))
				expressions.Add(expression);
		}
		var instructions = ILScanner.ScanWithOffsets(il).ToArray();
		for (var position = 0; position < instructions.Length; position++) {
			var (offset, opcode, operand) = instructions[position];
			if (!ranges.Any(range => offset >= range.Start && offset < range.End))
				continue;
			switch (opcode) {
				case >= 0x06 and <= 0x09:
					Add(Variable(new VariableSource.Local(opcode - 0x06)));
					break;
				case >= 0x0A and <= 0x0D:
					Add(Variable(new VariableSource.Local(opcode - 0x0A)));
					break;
				case 0x11 or 0x12 or 0x13 or 0xFE0C or 0xFE0D or 0xFE0E:
					Add(Variable(new VariableSource.Local(operand)));
					break;
				case >= 0x02 and <= 0x05:
					// ldarg.0 of an instance method is this, which only stands on its own when no field follows.
					if (opcode == 0x02 && hasThis) {
						if (position + 1 < instructions.Length && instructions[position + 1].OpCode is 0x7B or 0x7C or 0x7D)
							break;
						Add(frame.Variables.Any(variable => variable.Kind == FrameVariableKind.This) ? thisName : null);
					}
					else
						Add(Variable(new VariableSource.Argument(opcode - 0x02)));
					break;
				case 0x0E or 0x0F or 0x10 or 0xFE09 or 0xFE0A or 0xFE0B:
					if (operand == 0 && hasThis)
						Add(thisName);
					else
						Add(Variable(new VariableSource.Argument(operand)));
					break;
				case 0x7B or 0x7C or 0x7D:
					// A field of this: in a state machine or a closure that is a hoisted variable.
					if (position > 0 && instructions[position - 1].OpCode == 0x02 && hasThis && types.GetMember(entry, operand) is Microsoft.CodeAnalysis.IFieldSymbol field) {
						var hoisted = frame.Variables.FirstOrDefault(variable => variable.Source is VariableSource.HoistedField { Field: var hoistedField } && Microsoft.CodeAnalysis.SymbolEqualityComparer.Default.Equals(hoistedField.OriginalDefinition, field.OriginalDefinition));
						if (hoisted is not null)
							Add(hoisted.Kind == FrameVariableKind.This ? thisName : hoisted.Name);
						else if (!field.Name.Contains('<', StringComparison.Ordinal))
							Add($"{thisName}.{field.Name}");
					}
					break;
				case 0x7E or 0x7F or 0x80:
					if (types.GetMember(entry, operand) is Microsoft.CodeAnalysis.IFieldSymbol staticField && !staticField.Name.Contains('<', StringComparison.Ordinal) && ExpressionCompiler.IsSpeakable(staticField.ContainingType))
						Add(scope.Factory.TypeExpression(staticField.ContainingType) + "." + staticField.Name);
					break;
			}
		}
		return expressions;
	}
}
