using System.Text;
using System.Text.RegularExpressions;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.ProjectExport;
using ICSharpCode.CodeConverter;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using Microsoft.CodeAnalysis.VisualBasic;
using Microsoft.CodeAnalysis.VisualBasic.Syntax;

namespace dnSpy.Backend.Core;

/// <summary>
/// The port's Visual Basic: the C# document run through a converter. dnSpy's own Visual Basic decompiler writes
/// its statements with the IL they came from, which is what breakpoints, the current statement and body bookmarks
/// are placed by; the converter keeps nothing of the kind. So the C# statements ride through it as comments — a
/// marker in front of each statement's code, which the converter carries over as a comment line above, or at the
/// end of, the statement it became — and the Visual Basic statement each one lands on gets the IL of the C# one.
/// </summary>
static partial class VisualBasicConversion {
	/// <summary>The type a member document is converted inside of: the converter only translates members of a type.</summary>
	const string MemberHost = "DnSpyMemberHost";

	// A statement marker names the statements that start where it stands; a member marker, at the start of the line
	// of an expression-bodied member, names the statements of the expression, whose own marker the converter drops
	// when it turns the expression into a body.
	[GeneratedRegex(@"dnSpy(Statement|Member):(\d+(?:,\d+)*)")]
	private static partial Regex MarkerPattern();

	[GeneratedRegex(@"^\s*'\s*(dnSpy(Statement|Member):\d+(?:,\d+)*\s*)+$")]
	private static partial Regex MarkerLinePattern();

	[GeneratedRegex(@"\s*'\s*(dnSpy(Statement|Member):\d+(?:,\d+)*\s*)+$")]
	private static partial Regex TrailingMarkerPattern();

	/// <summary>
	/// Converts a C# document. <paramref name="memberOnly"/> is a document of one member — a method, a field, a
	/// property, an event — which the converter is handed inside a type and given back without it, the way dnSpy's
	/// Visual Basic decompiler writes a member's document. <paramref name="referencePaths"/> are the assemblies the
	/// converter binds the C# against — the module and what it references, which the conversion of an event handler
	/// or a member of a framework type needs — instead of its own small set of the core libraries.
	/// </summary>
	public static async Task<DecompileResponse> ConvertAsync(DecompileResponse csharp, bool memberOnly, CancellationToken cancellationToken, IReadOnlyList<string>? referencePaths = null) {
		var statements = csharp.CodeStatements ?? [];
		var marked = Mark(csharp.Text, statements);
		// The same textual repairs the project export and the console apply: nullability attributes the converter
		// chokes on, and the spellings it invents for what VB has no syntax for.
		marked = VisualBasicConverterFixes.PrepareCSharp(marked);
		if (memberOnly)
			marked = WrapMember(marked);
		var conversion = await CodeConverter.ConvertAsync(new CodeWithOptions(marked).WithTypeReferences(ConverterReferences(referencePaths)), cancellationToken).ConfigureAwait(false);
		if (!conversion.Success) {
			var message = conversion.GetExceptionsAsString();
			return new DecompileResponse(
				csharp.Title,
				"visual-basic",
				$"' Visual Basic conversion failed.\n' {message.Replace(Environment.NewLine, Environment.NewLine + "' ", StringComparison.Ordinal)}",
				Array.Empty<TextSpanDto>(),
				[new DiagnosticDto("error", message)]);
		}
		var diagnostics = csharp.Diagnostics
			.Concat(conversion.Exceptions?.Select(exception => new DiagnosticDto("warning", exception)) ?? [])
			.ToArray();
		var converted = conversion.ConvertedCode;
		if (memberOnly)
			converted = UnwrapMember(converted);
		converted = VisualBasicConverterFixes.PrepareVB(VisualBasicConverterFixes.PrepareConvertedVB(converted));
		var (text, placed, members) = TakeMarkers(converted);
		return new DecompileResponse(csharp.Title, "visual-basic", text, Array.Empty<TextSpanDto>(), diagnostics) {
			CodeStatements = statements.Count == 0 ? null : MapStatements(text, statements, placed, members, cancellationToken),
		};
	}

	/// <summary>
	/// What the converter binds against: the given assemblies and the Visual Basic runtime its helpers come from, or —
	/// for no assemblies, or none that holds the core library — its own defaults.
	/// </summary>
	static IReadOnlyCollection<PortableExecutableReference>? ConverterReferences(IReadOnlyList<string>? referencePaths) {
		if (referencePaths is null || referencePaths.Count == 0)
			return null;
		var references = new List<PortableExecutableReference>();
		var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
		foreach (var path in referencePaths) {
			if (!names.Add(Path.GetFileNameWithoutExtension(path)))
				continue;
			try {
				references.Add(MetadataReference.CreateFromFile(path));
			}
			catch (Exception ex) when (ex is IOException or BadImageFormatException or UnauthorizedAccessException or ArgumentException) {
			}
		}
		if (!names.Overlaps(["System.Runtime", "mscorlib", "netstandard", "System.Private.CoreLib"]))
			return null;
		var runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location);
		foreach (var name in new[] { "Microsoft.VisualBasic.Core", "Microsoft.VisualBasic", "System.Runtime", "System.Private.CoreLib" }) {
			var path = runtimeDirectory is null ? null : Path.Combine(runtimeDirectory, name + ".dll");
			if (path is not null && File.Exists(path) && names.Add(name))
				references.Add(MetadataReference.CreateFromFile(path));
		}
		return references;
	}

	/// <summary>The C# text with a marker comment in front of every statement's code, naming the statements that start there.</summary>
	internal static string Mark(string text, IReadOnlyList<CodeStatementDto> statements) {
		if (statements.Count == 0)
			return text;
		var lineStarts = LineStarts(text);
		var byOffset = new SortedDictionary<int, SortedDictionary<string, List<int>>>(); 
		for (var i = 0; i < statements.Count; i++) {
			var statement = statements[i];
			// A hidden point's line is 0xFEEFEE: there is no place in the text it starts at.
			if (statement.IsHidden || statement.StartLine < 1 || statement.StartLine > lineStarts.Count)
				continue;
			var lineStart = lineStarts[statement.StartLine - 1];
			var offset = Math.Min(lineStart + Math.Max(statement.StartColumn - 1, 0), text.Length);
			Add(byOffset, offset, "Statement", i);
			// An expression body: the line it is on starts with the member it belongs to.
			if (text.AsSpan(lineStart, offset - lineStart).Contains("=>", StringComparison.Ordinal)) {
				var memberStart = lineStart;
				while (memberStart < offset && char.IsWhiteSpace(text[memberStart]))
					memberStart++;
				if (memberStart < offset)
					Add(byOffset, memberStart, "Member", i);
			}
		}
		var builder = new StringBuilder(text.Length + byOffset.Count * 24);
		var last = 0;
		foreach (var (offset, kinds) in byOffset) {
			builder.Append(text, last, offset - last);
			foreach (var (kind, ids) in kinds)
				builder.Append("/*dnSpy").Append(kind).Append(':').Append(string.Join(',', ids)).Append("*/");
			last = offset;
		}
		builder.Append(text, last, text.Length - last);
		return builder.ToString();
	}

	static void Add(SortedDictionary<int, SortedDictionary<string, List<int>>> byOffset, int offset, string kind, int index) {
		if (!byOffset.TryGetValue(offset, out var kinds))
			byOffset.Add(offset, kinds = new SortedDictionary<string, List<int>>(StringComparer.Ordinal));
		if (!kinds.TryGetValue(kind, out var ids))
			kinds.Add(kind, ids = []);
		ids.Add(index);
	}

	static List<int> LineStarts(string text) {
		var starts = new List<int> { 0 };
		for (var i = 0; i < text.Length; i++) {
			if (text[i] == '\n')
				starts.Add(i + 1);
		}
		return starts;
	}

	/// <summary>
	/// Puts a member document inside a type, after the <c>using</c> directives it opens with: the converter
	/// translates the members of a type, and turns a member it finds on its own into an empty one.
	/// </summary>
	static string WrapMember(string text) {
		var lines = text.Split('\n');
		var first = 0;
		while (first < lines.Length) {
			var trimmed = lines[first].Trim();
			if (trimmed.Length != 0 && !trimmed.StartsWith("using ", StringComparison.Ordinal) && !trimmed.StartsWith("//", StringComparison.Ordinal))
				break;
			first++;
		}
		var builder = new StringBuilder(text.Length + 64);
		for (var i = 0; i < first; i++)
			builder.Append(lines[i]).Append('\n');
		builder.Append("internal class ").Append(MemberHost).Append(" {\n");
		for (var i = first; i < lines.Length; i++)
			builder.Append(lines[i]).Append('\n');
		builder.Append("}\n");
		return builder.ToString();
	}

	/// <summary>Takes the type a member was converted inside of away again, and the indentation it gave the member.</summary>
	static string UnwrapMember(string text) {
		var lines = text.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n').ToList();
		var start = lines.FindIndex(line => line.Contains($"Class {MemberHost}", StringComparison.Ordinal));
		if (start < 0)
			return text;
		var end = lines.FindLastIndex(line => line.Trim() == "End Class");
		if (end <= start)
			return text;
		var body = lines.GetRange(start + 1, end - start - 1);
		var indent = body.Where(line => line.Trim().Length != 0).Select(line => line.Length - line.TrimStart(' ').Length).DefaultIfEmpty(0).Min();
		var result = new List<string>(lines.Count);
		result.AddRange(lines.Take(start));
		result.AddRange(body.Select(line => line.Length >= indent ? line[indent..] : line.TrimStart(' ')));
		result.AddRange(lines.Skip(end + 1));
		return string.Join('\n', result).Trim('\n') + "\n";
	}

	/// <summary>
	/// Takes the markers out of the converted text. A marker on a line of its own names the statement that starts
	/// on the next line of code; one at the end of a line names the statement on that line. Answers the text the
	/// viewer shows and, per statement index, the line (1-based, in that text) its statement marker and its member
	/// marker were found on.
	/// </summary>
	internal static (string Text, Dictionary<int, int> Statements, Dictionary<int, int> Members) TakeMarkers(string converted) {
		var lines = converted.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
		var kept = new List<string>(lines.Length);
		var statements = new Dictionary<int, int>();
		var members = new Dictionary<int, int>();
		var pending = new List<(bool Member, int Id)>();
		foreach (var line in lines) {
			if (MarkerLinePattern().IsMatch(line)) {
				pending.AddRange(MarkerIds(line));
				continue;
			}
			var text = line;
			var trailing = TrailingMarkerPattern().Match(line);
			var ids = new List<(bool Member, int Id)>();
			if (trailing.Success) {
				ids.AddRange(MarkerIds(trailing.Value));
				text = line[..trailing.Index];
			}
			// A marker the converter left inside a comment of its own is dropped from it the same way.
			if (MarkerPattern().IsMatch(text)) {
				ids.AddRange(MarkerIds(text));
				text = MarkerPattern().Replace(text, string.Empty);
			}
			kept.Add(text);
			var lineNumber = kept.Count;
			// A statement starts on a line of code: a blank line or a comment the decompiler wrote leaves it pending.
			if (text.Trim().Length == 0 || text.TrimStart().StartsWith('\''))
				continue;
			foreach (var (member, id) in pending.Concat(ids))
				(member ? members : statements).TryAdd(id, lineNumber);
			pending.Clear();
		}
		return (string.Join('\n', kept), statements, members);
	}

	static IEnumerable<(bool Member, int Id)> MarkerIds(string text) {
		foreach (Match match in MarkerPattern().Matches(text)) {
			var member = match.Groups[1].Value == "Member";
			foreach (var id in match.Groups[2].Value.Split(','))
				yield return (member, int.Parse(id, System.Globalization.CultureInfo.InvariantCulture));
		}
	}

	/// <summary>
	/// The Visual Basic statements: each C# statement on the Visual Basic statement its marker landed on — the
	/// header of a block statement, the way a C# <c>if</c>'s point is its condition line — and the ones whose
	/// marker the converter dropped on a statement nearby: the one the same C# line went to, else the header of the
	/// block the next placed statement is in (a <c>For</c>'s parts), else the end of the block the previous one is
	/// in (a <c>Loop While</c>'s condition). An expression body's statement goes to the first statement of the body
	/// the converter made of it.
	/// </summary>
	static IReadOnlyList<CodeStatementDto> MapStatements(string text, IReadOnlyList<CodeStatementDto> statements, Dictionary<int, int> placed, Dictionary<int, int> members, CancellationToken cancellationToken) {
		var tree = VisualBasicSyntaxTree.ParseText(text, cancellationToken: cancellationToken);
		var root = tree.GetRoot(cancellationToken);
		var source = tree.GetText(cancellationToken);
		var located = new Dictionary<int, StatementSyntax>();
		foreach (var (index, line) in placed) {
			if (StatementOnLine(root, source, line) is { } statement)
				located[index] = statement;
		}
		foreach (var (index, line) in members) {
			if (!located.ContainsKey(index) && StatementOnLine(root, source, line) is { } declaration && FirstStatementOfBody(declaration) is { } first)
				located[index] = first;
		}
		var order = Enumerable.Range(0, statements.Count)
			.Where(index => !statements[index].IsHidden)
			.OrderBy(index => statements[index].StartLine).ThenBy(index => statements[index].StartColumn)
			.ToArray();
		for (var position = 0; position < order.Length; position++) {
			var index = order[position];
			if (located.ContainsKey(index))
				continue;
			var statement = statements[index];
			// The same C# line went somewhere: an expression's point inside a statement whose own point was placed.
			var sameLine = order.Where(other => other != index && located.ContainsKey(other) && statements[other].StartLine == statement.StartLine)
				.OrderBy(other => Math.Abs(statements[other].StartColumn - statement.StartColumn))
				.Select(other => located[other])
				.FirstOrDefault();
			if (sameLine is not null) {
				located[index] = sameLine;
				continue;
			}
			var previous = order.Take(position).Reverse().Where(located.ContainsKey).Select(other => located[other]).FirstOrDefault();
			var next = order.Skip(position + 1).Where(located.ContainsKey).Select(other => located[other]).FirstOrDefault();
			var previousLine = previous is null ? 0 : LineOf(source, previous.SpanStart);
			var nextLine = next is null ? int.MaxValue : LineOf(source, next.SpanStart);
			if (next is not null && BlockHeader(next, source, previousLine, nextLine) is { } header) {
				located[index] = header;
				continue;
			}
			if (previous is not null && BlockEnd(previous, source, previousLine, nextLine) is { } end)
				located[index] = end;
		}
		var result = new List<CodeStatementDto>(statements.Count);
		for (var index = 0; index < statements.Count; index++) {
			var statement = statements[index];
			if (statement.IsHidden) {
				result.Add(statement);
				continue;
			}
			if (!located.TryGetValue(index, out var syntax))
				continue;
			// A procedure's opening brace is its declaration line, which starts after the attributes above it.
			var start = syntax is MethodBaseSyntax { AttributeLists.Count: > 0 } declaration
				? declaration.AttributeLists.Last().GetLastToken().GetNextToken().SpanStart
				: syntax.SpanStart;
			var span = source.Lines.GetLinePositionSpan(TextSpan.FromBounds(start, syntax.Span.End));
			result.Add(statement with {
				StartLine = span.Start.Line + 1,
				StartColumn = span.Start.Character + 1,
				EndLine = span.End.Line + 1,
				EndColumn = span.End.Character + 1,
			});
		}
		return result;
	}

	/// <summary>
	/// The first statement inside the body a declaration opens — a property's first accessor's — or the statement
	/// itself when it opens none.
	/// </summary>
	static StatementSyntax? FirstStatementOfBody(StatementSyntax declaration) => declaration.Parent switch {
		MethodBlockBaseSyntax block when block.BlockStatement == declaration => block.Statements.FirstOrDefault(),
		PropertyBlockSyntax block when block.PropertyStatement == declaration => block.Accessors.FirstOrDefault()?.Statements.FirstOrDefault(),
		EventBlockSyntax block when block.EventStatement == declaration => block.Accessors.FirstOrDefault()?.Statements.FirstOrDefault(),
		_ => declaration is MethodBaseSyntax ? null : declaration,
	};

	static int LineOf(SourceText source, int position) => source.Lines.GetLineFromPosition(position).LineNumber + 1;

	/// <summary>The statement that starts on a line: its header when it opens a block.</summary>
	static StatementSyntax? StatementOnLine(SyntaxNode root, SourceText source, int line) {
		if (line < 1 || line > source.Lines.Count)
			return null;
		var textLine = source.Lines[line - 1];
		var token = root.FindToken(textLine.Start + (textLine.ToString().Length - textLine.ToString().TrimStart().Length));
		if (token.Span.Start >= textLine.End && !textLine.Span.IsEmpty)
			return null;
		for (var node = token.Parent; node is not null; node = node.Parent) {
			if (node is StatementSyntax statement and not (MethodBlockBaseSyntax or TypeBlockSyntax or NamespaceBlockSyntax))
				return statement;
		}
		return null;
	}

	/// <summary>The header of the outermost block around <paramref name="inner"/> that opens between the two lines.</summary>
	static StatementSyntax? BlockHeader(StatementSyntax inner, SourceText source, int afterLine, int beforeLine) {
		StatementSyntax? found = null;
		for (var node = inner.Parent; node is not null && node is not MethodBlockBaseSyntax; node = node.Parent) {
			if (BlockBegin(node) is not { } begin)
				continue;
			var line = LineOf(source, begin.SpanStart);
			if (line > afterLine && line < beforeLine)
				found = begin;
		}
		return found;
	}

	/// <summary>The closing statement of the innermost block around <paramref name="inner"/> that ends between the two lines.</summary>
	static StatementSyntax? BlockEnd(StatementSyntax inner, SourceText source, int afterLine, int beforeLine) {
		for (var node = inner.Parent; node is not null && node is not MethodBlockBaseSyntax; node = node.Parent) {
			if (BlockClose(node) is not { } close)
				continue;
			var line = LineOf(source, close.SpanStart);
			if (line > afterLine && line < beforeLine)
				return close;
		}
		return null;
	}

	static StatementSyntax? BlockBegin(SyntaxNode node) => node switch {
		MultiLineIfBlockSyntax block => block.IfStatement,
		ForBlockSyntax block => block.ForStatement,
		ForEachBlockSyntax block => block.ForEachStatement,
		WhileBlockSyntax block => block.WhileStatement,
		DoLoopBlockSyntax block => block.DoStatement,
		UsingBlockSyntax block => block.UsingStatement,
		SyncLockBlockSyntax block => block.SyncLockStatement,
		SelectBlockSyntax block => block.SelectStatement,
		WithBlockSyntax block => block.WithStatement,
		_ => null,
	};

	static StatementSyntax? BlockClose(SyntaxNode node) => node switch {
		DoLoopBlockSyntax block => block.LoopStatement,
		ForBlockSyntax block => block.NextStatement,
		ForEachBlockSyntax block => block.NextStatement,
		WhileBlockSyntax block => block.EndWhileStatement,
		_ => null,
	};
}
