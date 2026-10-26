using System.Text;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core.Output;

/// <summary>
/// How a document resolves a reference the writer could not place by itself — a member, a type, a token: a span
/// over <paramref name="start"/>..<paramref name="start"/>+<paramref name="length"/>, or null for one that names
/// nothing the viewer can go to. Locals, labels, opcodes and addresses never reach it.
/// </summary>
delegate TextSpanDto? ReferenceResolver(object reference, DecompilerReferenceFlags flags, string color, int start, int length);

/// <summary>
/// The Quick Info a local reference carries — dnSpy's <c>DocumentViewerToolTipProvider</c>: the text parts its
/// provider writes, and the image it draws before them.
/// </summary>
readonly record struct DocumentToolTip(IReadOnlyList<TextPartDto> Parts, string? Image);

/// <summary>
/// The document an <see cref="IDecompilerOutput"/> writer produces — dnSpy's <c>DocumentViewerOutput</c>: the text,
/// and what was recorded beside it. A reference becomes a span the viewer follows and highlights (a local one ties
/// its uses together inside the document; an opcode opens its documentation; an address opens the hex editor);
/// a brace pair that opens a block becomes a block structure line; a debug info becomes the statements a
/// breakpoint, a bookmark or a search hit resolves to.
/// </summary>
sealed class DocumentOutput(ReferenceResolver? resolveReference = null, Func<object, DocumentToolTip?>? localToolTip = null) : IDecompilerOutput {
	readonly StringBuilder builder = new();
	readonly List<TextSpanDto> spans = [];
	readonly List<BlockStructureDto> blockStructures = [];
	readonly List<int> lineSeparators = [];
	readonly List<MethodDebugInfo> debugInfos = [];
	// One id per thing a local reference names. dnSpy's span map compares references with Equals, so two
	// writes of the same label, local or number are one reference for the highlighter.
	readonly Dictionary<object, string> localIds = [];
	int indentation;
	bool needsIndentation = true;

	public string IndentationString { get; init; } = "\t";

	/// <summary>
	/// Whether text that names nothing keeps its color too, as a span the viewer only paints — for a document no
	/// lexical colorizer knows, such as dnSpy's BAML disassembly, whose colors are all the writer's.
	/// </summary>
	public bool ColorsEveryWrite { get; init; }

	public int Length => builder.Length;

	public int NextPosition => builder.Length + (needsIndentation ? indentation * IndentationString.Length : 0);

	public IReadOnlyList<TextSpanDto> Spans => spans;
	public IReadOnlyList<BlockStructureDto> BlockStructures => blockStructures;
	public IReadOnlyList<int> LineSeparators => lineSeparators;
	public IReadOnlyList<MethodDebugInfo> DebugInfos => debugInfos;

	public void IncreaseIndent() => indentation++;

	public void DecreaseIndent() => indentation = Math.Max(0, indentation - 1);

	public void WriteLine() {
		builder.Append(Environment.NewLine);
		needsIndentation = true;
	}

	public void Write(string text, object color) => Write(text, 0, text.Length, color);

	public void Write(string text, int index, int length, object color) {
		if (length == 0)
			return;
		EnsureIndentation();
		var start = builder.Length;
		builder.Append(text, index, length);
		AddColorSpan(color, start, length);
	}

	void AddColorSpan(object color, int start, int length) {
		if (ColorsEveryWrite && color is string name && name != BoxedTextColor.Text)
			spans.Add(new TextSpanDto(start, length, "text") { Color = name });
	}

	public void Write(string text, object? reference, DecompilerReferenceFlags flags, object color) =>
		Write(text, 0, text.Length, reference, flags, color);

	public void Write(string text, int index, int length, object? reference, DecompilerReferenceFlags flags, object color) {
		EnsureIndentation();
		var start = builder.Length;
		builder.Append(text, index, length);
		if (length == 0)
			return;
		if (reference is not null && SpanOf(reference, flags, color as string ?? BoxedTextColor.Text, start, length) is { } span)
			spans.Add(span);
		else if (reference is not null && color is string name && name != BoxedTextColor.Text)
			// A reference the workspace cannot follow (a type of an assembly it does not hold) still wears the color
			// dnSpy's writer gave it.
			spans.Add(new TextSpanDto(start, length, "text") { Color = name });
		else
			AddColorSpan(color, start, length);
	}

	public void AddBracePair(TextSpan start, TextSpan end, CodeBracesRangeFlags flags) {
		if (flags.ToBlockKindName() is { } kind)
			blockStructures.Add(new BlockStructureDto(start.Start, end.Start, kind));
	}

	public void AddLineSeparator(int position) => lineSeparators.Add(position);

	public void AddDebugInfo(MethodDebugInfo debugInfo) => debugInfos.Add(debugInfo);

	TextSpanDto? SpanOf(object reference, DecompilerReferenceFlags flags, string color, int start, int length) {
		var kind = (flags & DecompilerReferenceFlags.Definition) != 0 ? "definition" : "reference";
		switch (reference) {
		// dnSpy's disassembler writes every opcode as a reference to it: following one opens its documentation.
		case dnlib.DotNet.Emit.OpCode opCode:
			return new TextSpanDto(start, length, "reference") { Color = color, OpCode = opCode.Name };
		case AddressReference address:
			return new TextSpanDto(start, length, "reference") {
				Color = color,
				Address = new AddressDto(string.IsNullOrEmpty(address.Filename) ? null : address.Filename, address.IsRVA, unchecked((long)address.Address), unchecked((long)address.Length)),
			};
		}
		if ((flags & DecompilerReferenceFlags.Local) != 0) {
			var first = !localIds.TryGetValue(reference, out var localId);
			if (first) {
				localId = $"L{localIds.Count}";
				localIds.Add(reference, localId);
			}
			var toolTip = first ? localToolTip?.Invoke(reference) : null;
			return new TextSpanDto(start, length, kind) {
				Color = color,
				LocalId = localId,
				ToolTip = toolTip?.Parts,
				ToolTipImage = toolTip?.Image,
				IsWrite = (flags & DecompilerReferenceFlags.IsWrite) != 0 && kind == "reference",
			};
		}
		return resolveReference?.Invoke(reference, flags, color, start, length);
	}

	void EnsureIndentation() {
		if (!needsIndentation)
			return;
		for (var i = 0; i < indentation; i++)
			builder.Append(IndentationString);
		needsIndentation = false;
	}

	public override string ToString() => builder.ToString();

	/// <summary>
	/// The statements of every debug info written, in the terms a debug engine speaks: lines and columns of this
	/// text, the IL range, and the method the IL is in and the one it belongs to.
	/// </summary>
	public IReadOnlyList<CodeStatementDto> GetStatements(string? modulePath) {
		if (modulePath is null || debugInfos.Count == 0)
			return [];
		var text = builder.ToString();
		var lineStarts = new List<int> { 0 };
		for (var i = 0; i < text.Length; i++) {
			if (text[i] == '\n')
				lineStarts.Add(i + 1);
		}
		(int Line, int Column) Locate(int position) {
			var index = lineStarts.BinarySearch(position);
			if (index < 0)
				index = ~index - 1;
			return (index + 1, position - lineStarts[index] + 1);
		}
		var statements = new List<CodeStatementDto>();
		foreach (var info in debugInfos) {
			var token = unchecked((int)info.Method.MDToken.Raw);
			var source = info.KickoffMethod ?? info.Method;
			var sourceToken = unchecked((int)source.MDToken.Raw);
			var description = source.FullName;
			foreach (var statement in info.Statements) {
				var (startLine, startColumn) = Locate(statement.TextSpan.Start);
				var (endLine, endColumn) = Locate(statement.TextSpan.End);
				statements.Add(new CodeStatementDto(
					startLine,
					endLine,
					startColumn,
					endColumn,
					unchecked((int)statement.ILSpan.Start),
					unchecked((int)statement.ILSpan.End),
					unchecked((int)statement.ILSpan.Start),
					modulePath,
					token,
					sourceToken,
					description,
					false));
			}
		}
		statements.Sort(static (left, right) => {
			var result = left.StartLine.CompareTo(right.StartLine);
			if (result != 0)
				return result;
			result = left.StartColumn.CompareTo(right.StartColumn);
			return result != 0 ? result : left.IlOffset.CompareTo(right.IlOffset);
		});
		return statements;
	}

	/// <summary>The document as the client receives it.</summary>
	public DecompileResponse ToResponse(string title, string language, string? modulePath, IReadOnlyList<DiagnosticDto>? diagnostics = null) =>
		new(title, language, builder.ToString(), spans, diagnostics ?? []) {
			CodeStatements = GetStatements(modulePath),
			BlockStructures = blockStructures,
			LineSeparators = lineSeparators,
		};
}
