using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Text;
using ICSharpCode.CodeConverter;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.CSharp.OutputVisitor;
using ICSharpCode.Decompiler.CSharp.Syntax;
using ICSharpCode.Decompiler.Disassembler;
using ICSharpCode.Decompiler.IL;
using ICSharpCode.Decompiler.Metadata;
using dnlib.DotNet;

namespace dnSpy.Cli;

/// <summary>
/// Writes one type or member to stdout in the selected language. The C# text is ILSpy's own output
/// with the console's colours; Visual Basic is that text run through the same converter the GUI uses
/// for its VB documents; IL is dnSpy's IL view (ICSharpCode.Decompiler's disassembler), and
/// "IL with C#" interleaves the decompiled statements as comments the way the GUI's mixed view does.
/// </summary>
sealed class DecompilerRunner(LoadedModule module, CommandLineOptions options) {
	readonly CliAssemblyResolver resolver = module.Resolver;
	CSharpDecompiler? csharp;

	public string IndentationString => options.Spaces <= 0 ? "\t" : new string(' ', options.Spaces);

	public void WriteTo(IMDTokenProvider member, ColorTextWriter writer) {
		var handle = ToHandle(member);
		switch (options.Language.Kind) {
		case ConsoleLanguageKind.CSharp:
			WriteCSharp(writer, handle);
			break;
		case ConsoleLanguageKind.VisualBasic:
			WriteVisualBasic(writer, handle);
			break;
		case ConsoleLanguageKind.IL:
			WriteIL(writer, handle, withCSharp: false);
			break;
		case ConsoleLanguageKind.ILWithCSharp:
			WriteIL(writer, handle, withCSharp: true);
			break;
		default:
			throw new InvalidOperationException($"Unknown language: {options.Language.Name}");
		}
	}

	void WriteCSharp(ColorTextWriter writer, EntityHandle handle) {
		var tree = CreateCSharpDecompiler().Decompile(new[] { handle });
		var tokenWriter = new ConsoleTokenWriter(writer) {
			IndentationString = IndentationString,
		};
		var located = TokenWriter.WrapInWriterThatSetsLocationsInAST(tokenWriter);
		tree.AcceptVisitor(new CSharpOutputVisitor(located, options.Settings.CSharpFormattingOptions));
		writer.Flush();
	}

	void WriteVisualBasic(ColorTextWriter writer, EntityHandle handle) {
		var csharpText = VisualBasicConversion.PrepareCSharp(RenderCSharp(handle, indentString: IndentationString));
		var conversion = CodeConverter.ConvertAsync(
			new CodeWithOptions(csharpText).WithTypeReferences(),
			CancellationToken.None).GetAwaiter().GetResult();
		if (!conversion.Success) {
			writer.WriteLine("' Visual Basic conversion failed.");
			foreach (var line in conversion.GetExceptionsAsString().Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n'))
				writer.WriteLine("' " + line);
			return;
		}
		var vb = VisualBasicConversion.PrepareVB(VisualBasicConversion.PrepareConvertedVB(conversion.ConvertedCode));
		new VisualBasicColorWriter(writer).Write(vb);
		if (!vb.EndsWith('\n'))
			writer.WriteLine();
	}

	void WriteIL(ColorTextWriter writer, EntityHandle handle, bool withCSharp) {
		using var debugInfo = options.IlOptions.ShowPdbInfo ? PortablePdbInfoProvider.TryCreate(module.Path) : null;
		var output = new IlTextOutput(writer, IndentationString);
		var disassembler = new ReflectionDisassembler(output, CancellationToken.None) {
			DebugInfo = debugInfo,
			ShowMetadataTokens = options.IlOptions.ShowTokenAndRvaComments,
			ShowRawRVAOffsetAndBytes = options.IlOptions.ShowILBytes,
			ShowSequencePoints = options.IlOptions.ShowPdbInfo,
			EntityProcessor = options.IlOptions.SortMembers ? new SortByNameProcessor() : null,
		};
		if (withCSharp) {
			var sources = new SourceComments(module, options);
			output.SetSourceComments(sources.ForMethod);
		}
		switch (handle.Kind) {
		case HandleKind.TypeDefinition:
			disassembler.DisassembleType(module.File, (TypeDefinitionHandle)handle);
			break;
		case HandleKind.MethodDefinition:
			disassembler.DisassembleMethod(module.File, (MethodDefinitionHandle)handle);
			break;
		case HandleKind.FieldDefinition:
			disassembler.DisassembleField(module.File, (FieldDefinitionHandle)handle);
			break;
		case HandleKind.PropertyDefinition:
			disassembler.DisassembleProperty(module.File, (PropertyDefinitionHandle)handle);
			break;
		case HandleKind.EventDefinition:
			disassembler.DisassembleEvent(module.File, (EventDefinitionHandle)handle);
			break;
		default:
			throw new ConsoleErrorException(ConsoleStrings.InvalidMemberToDecompile);
		}
	}

	CSharpDecompiler CreateCSharpDecompiler() =>
		csharp ??= new CSharpDecompiler(module.File, resolver, options.Settings) { CancellationToken = CancellationToken.None };

	static string RenderCSharp(LoadedModule module, CommandLineOptions options, EntityHandle handle, string indentString) {
		var settings = DecompilerSettingsFactory.ForLanguage(options.Settings, options.Language.Kind);
		settings.CSharpFormattingOptions.IndentationString = indentString;
		var decompiler = new CSharpDecompiler(module.File, module.Resolver, settings) { CancellationToken = CancellationToken.None };
		var tree = decompiler.Decompile(new[] { handle });
		var writer = new StringWriter();
		var tokenWriter = new TextWriterTokenWriter(writer) { IndentationString = indentString };
		var located = TokenWriter.WrapInWriterThatSetsLocationsInAST(tokenWriter);
		tree.AcceptVisitor(new CSharpOutputVisitor(located, settings.CSharpFormattingOptions));
		return writer.ToString();
	}

	string RenderCSharp(EntityHandle handle, string indentString) => RenderCSharp(module, options, handle, indentString);

	internal static EntityHandle ToHandle(IMDTokenProvider member) =>
		MetadataTokens.EntityHandle(unchecked((int)member.MDToken.Raw));
}

/// <summary>
/// The decompiled statements of a method, by IL offset. They are what the GUI's mixed view prints in
/// front of the instructions; the sequence points are ILSpy's, reduced to the visible statements.
/// </summary>
sealed class SourceComments(LoadedModule module, CommandLineOptions options) {
	public Func<int, IReadOnlyList<string>> ForMethod(MethodDefinitionHandle method) {
		var map = Build(method);
		return offset => map.TryGetValue(offset, out var lines) ? lines : Array.Empty<string>();
	}

	Dictionary<int, List<string>> Build(MethodDefinitionHandle method) {
		var map = new Dictionary<int, List<string>>();
		try {
			var decompiler = new CSharpDecompiler(module.File, module.Resolver, options.Settings) { CancellationToken = CancellationToken.None };
			var tree = decompiler.Decompile([method]);
			var writer = new StringWriter();
			var tokenWriter = new TextWriterTokenWriter(writer) { IndentationString = options.Spaces <= 0 ? "\t" : new string(' ', options.Spaces) };
			var located = TokenWriter.WrapInWriterThatSetsLocationsInAST(tokenWriter);
			tree.AcceptVisitor(new CSharpOutputVisitor(located, options.Settings.CSharpFormattingOptions));
			var source = writer.ToString();
			var methodToken = MetadataTokens.GetToken(method);
			foreach (var (function, points) in decompiler.CreateSequencePoints(tree)) {
				if (BodyToken(function) != methodToken)
					continue;
				foreach (var point in points) {
					if (point.IsHidden || point.EndOffset <= point.Offset)
						continue;
					var text = ExtractSource(source, point.StartLine, point.StartColumn, point.EndLine, point.EndColumn);
					if (string.IsNullOrWhiteSpace(text))
						continue;
					if (!map.TryGetValue(point.Offset, out var lines))
						map[point.Offset] = lines = [];
					foreach (var line in text.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n')) {
						var trimmed = line.TrimEnd();
						if (trimmed.Length > 0)
							lines.Add(trimmed);
					}
				}
			}
		}
		catch (Exception ex) when (ex is not OperationCanceledException) {
			// No sources is a valid answer: the IL still shows, without the comments the GUI would add.
		}
		return map;
	}

	static int? BodyToken(ILFunction function) {
		var method = function.MoveNextMethod ?? function.Method;
		if (method is null || method.MetadataToken.IsNil)
			return null;
		return MetadataTokens.GetToken(method.MetadataToken);
	}

	static string ExtractSource(string source, int startLine, int startColumn, int endLine, int endColumn) {
		var lines = source.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n');
		if (startLine <= 0 || endLine < startLine || startLine > lines.Length)
			return string.Empty;
		endLine = Math.Min(endLine, lines.Length);
		var firstLine = startLine - 1;
		var lastLine = endLine - 1;
		var firstColumn = Math.Clamp(startColumn - 1, 0, lines[firstLine].Length);
		var lastColumn = Math.Clamp(endColumn - 1, 0, lines[lastLine].Length);
		if (firstLine == lastLine)
			return lines[firstLine][firstColumn..Math.Max(firstColumn, lastColumn)].Trim();
		var result = new List<string> { lines[firstLine][firstColumn..] };
		for (var line = firstLine + 1; line < lastLine; line++)
			result.Add(lines[line]);
		result.Add(lines[lastLine][..lastColumn]);
		return string.Join('\n', result).Trim();
	}
}
