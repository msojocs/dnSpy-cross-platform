using System.Collections.Concurrent;
using System.Collections.Immutable;
using dnSpy.Backend.Contracts;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Completion;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.QuickInfo;
using Microsoft.CodeAnalysis.Text;

namespace dnSpy.Backend.Core.LanguageService;

/// <summary>
/// The Roslyn language service of dnSpy's C# code editor (<c>dnSpy/Roslyn/dnSpy.Roslyn*</c>): each open document
/// lives in a workspace of its own, the way <c>RoslynLanguageCompiler</c> gives each Edit Code session one, and
/// gets the editor's colors, completion, Quick Info, signature help, compiler messages, smart indentation and
/// syntax-tree navigation from it.
/// </summary>
public sealed class RoslynLanguageService : IDisposable {
	readonly ConcurrentDictionary<string, CodeDocument> documents = new(StringComparer.Ordinal);
	int nextDocumentId;
	bool disposed;

	sealed class CodeDocument : IDisposable {
		public CodeDocument(AdhocWorkspace workspace, DocumentId id) {
			Workspace = workspace;
			Id = id;
		}

		public AdhocWorkspace Workspace { get; }
		public DocumentId Id { get; }
		public object Gate { get; } = new();

		/// <summary>The last completion list, kept for the description requests that name its items.</summary>
		public (int ResultId, Document Document, ImmutableArray<CompletionItem> Items)? Completion { get; set; }
		public int NextResultId { get; set; }

		public Document Document => Workspace.CurrentSolution.GetDocument(Id) ?? throw new InvalidOperationException("The document was removed from its workspace.");

		public void Dispose() => Workspace.Dispose();
	}

	public CodeDocumentOpenResponse Open(CodeDocumentOpenRequest request) {
		ObjectDisposedException.ThrowIf(disposed, this);
		ArgumentNullException.ThrowIfNull(request);
		var options = request.Options ?? new CodeCompilerOptionsDto();
		var workspace = new AdhocWorkspace(LanguageServiceHost.Services);
		var compilationOptions = new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary,
			optimizationLevel: options.Optimize ? OptimizationLevel.Release : OptimizationLevel.Debug,
			checkOverflow: options.CheckOverflow,
			allowUnsafe: options.AllowUnsafe);
		var parseOptions = new CSharpParseOptions(LanguageVersion.Latest, preprocessorSymbols: SplitSymbols(options.PreprocessorSymbols));
		var project = workspace.AddProject(ProjectInfo.Create(ProjectId.CreateNewId(), VersionStamp.Create(), "compilecodeproj", "compilecodeproj", LanguageNames.CSharp,
			compilationOptions: compilationOptions,
			parseOptions: parseOptions,
			metadataReferences: ReferenceAssemblies.Create(request.References ?? ReferenceAssemblies.Framework)));
		var document = workspace.AddDocument(DocumentInfo.Create(DocumentId.CreateNewId(project.Id), "main.cs",
			loader: TextLoader.From(TextAndVersion.Create(SourceText.From(request.Text, System.Text.Encoding.UTF8), VersionStamp.Create()))));
		var id = $"code-{Interlocked.Increment(ref nextDocumentId)}";
		documents[id] = new CodeDocument(workspace, document.Id);
		return new CodeDocumentOpenResponse(id);
	}

	static IEnumerable<string> SplitSymbols(string symbols) =>
		symbols.Split([';', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

	public void Update(CodeDocumentUpdateRequest request) {
		var document = Get(request.DocumentId);
		lock (document.Gate) {
			var solution = document.Workspace.CurrentSolution.WithDocumentText(document.Id, SourceText.From(request.Text, System.Text.Encoding.UTF8));
			if (!document.Workspace.TryApplyChanges(solution))
				throw new InvalidOperationException("The document's text could not be replaced.");
			document.Completion = null;
		}
	}

	public void Close(CodeDocumentRequest request) {
		if (documents.TryRemove(request.DocumentId, out var document))
			document.Dispose();
	}

	CodeDocument Get(string id) {
		ObjectDisposedException.ThrowIf(disposed, this);
		return documents.TryGetValue(id, out var document)
			? document
			: throw new RpcException(ErrorCodes.InvalidParams, $"No code document is open with the id '{id}'.");
	}

	public async Task<ClassifyResponse> ClassifyAsync(CodeDocumentRequest request, CancellationToken cancellationToken) {
		var document = Get(request.DocumentId).Document;
		var semanticModel = await document.GetSemanticModelAsync(cancellationToken).ConfigureAwait(false);
		var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
		if (semanticModel is null)
			return new ClassifyResponse([]);
		// The code editor's tagger passes no default color: what Roslyn does not name keeps the text color.
		return new ClassifyResponse(RoslynClassifier.Classify(semanticModel, document.Project.Solution.Workspace, new TextSpan(0, text.Length), null, cancellationToken));
	}

	public async Task<CodeCompletionResponse> GetCompletionAsync(CodeCompletionRequest request, CancellationToken cancellationToken) {
		var codeDocument = Get(request.DocumentId);
		var document = codeDocument.Document;
		var service = CompletionService.GetService(document);
		if (service is null)
			return new CodeCompletionResponse(null);
		var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
		var position = Math.Clamp(request.Position, 0, text.Length);
		var trigger = request.TriggerCharacter is { Length: > 0 } typed
			? CompletionTrigger.CreateInsertionTrigger(typed[0])
			: CompletionTrigger.Invoke;
		// dnSpy's command filter asks the service whether a typed character opens a list before it asks for one.
		if (trigger.Kind == CompletionTriggerKind.Insertion && !service.ShouldTriggerCompletion(text, position, trigger))
			return new CodeCompletionResponse(null);
		var list = await service.GetCompletionsAsync(document, position, trigger, cancellationToken: cancellationToken).ConfigureAwait(false);
		if (list.ItemsList.Count == 0)
			return new CodeCompletionResponse(null);

		// The rules a service is created with are internal; C#'s keep the default commit characters.
		var defaultCommitCharacters = CompletionRules.Default.DefaultCommitCharacters;
		var items = new List<CodeCompletionItemDto>(list.ItemsList.Count);
		var complexEdits = 0;
		for (var index = 0; index < list.ItemsList.Count; index++) {
			var item = list.ItemsList[index];
			CodeTextEditDto? edit = null;
			// What a complex item commits (an override's body, a using it needs) only its provider knows.
			if (item.IsComplexTextEdit && complexEdits++ < MaxComplexEdits) {
				var change = await service.GetChangeAsync(document, item, commitCharacter: null, cancellationToken).ConfigureAwait(false);
				edit = new CodeTextEditDto(change.TextChange.Span.Start, change.TextChange.Span.Length, change.TextChange.NewText ?? string.Empty);
			}
			items.Add(new CodeCompletionItemDto(
				index,
				item.DisplayText,
				item.DisplayTextPrefix,
				item.DisplayTextSuffix,
				item.InlineDescription,
				item.FilterText,
				item.SortText,
				item.Properties.TryGetValue("InsertionText", out var insertionText) ? insertionText : item.DisplayText,
				item.Tags,
				item.Rules.MatchPriority,
				item.Rules.MatchPriority == MatchPriority.Preselect,
				GetCommitCharacters(defaultCommitCharacters, item.Rules.CommitCharacterRules),
				edit));
		}

		int resultId;
		lock (codeDocument.Gate) {
			resultId = ++codeDocument.NextResultId;
			codeDocument.Completion = (resultId, document, [.. list.ItemsList]);
		}
		return new CodeCompletionResponse(new CodeCompletionListDto(resultId, new CodeSpanDto(list.Span.Start, list.Span.Length), list.SuggestionModeItem is not null, items));
	}

	const int MaxComplexEdits = 200;

	static string GetCommitCharacters(ImmutableArray<char> defaults, ImmutableArray<CharacterSetModificationRule> rules) {
		var characters = new HashSet<char>(defaults);
		foreach (var rule in rules) {
			switch (rule.Kind) {
			case CharacterSetModificationKind.Add:
				characters.UnionWith(rule.Characters);
				break;
			case CharacterSetModificationKind.Remove:
				characters.ExceptWith(rule.Characters);
				break;
			case CharacterSetModificationKind.Replace:
				characters = [.. rule.Characters];
				break;
			}
		}
		return new string([.. characters.Order()]);
	}

	public async Task<CodeCompletionDescriptionResponse> GetCompletionDescriptionAsync(CodeCompletionDescriptionRequest request, CancellationToken cancellationToken) {
		var codeDocument = Get(request.DocumentId);
		(int ResultId, Document Document, ImmutableArray<CompletionItem> Items)? completion;
		lock (codeDocument.Gate)
			completion = codeDocument.Completion;
		if (completion is not { } list || list.ResultId != request.ResultId || (uint)request.Index >= (uint)list.Items.Length)
			return new CodeCompletionDescriptionResponse([]);
		var service = CompletionService.GetService(list.Document);
		if (service is null)
			return new CodeCompletionDescriptionResponse([]);
		var description = await service.GetDescriptionAsync(list.Document, list.Items[request.Index], cancellationToken).ConfigureAwait(false);
		return new CodeCompletionDescriptionResponse(description is null ? [] : RoslynTextParts.ToParts(description.TaggedParts));
	}

	/// <summary>The sections dnSpy's Quick Info shows, in the order it shows them.</summary>
	static readonly string[] quickInfoSections = [
		QuickInfoSectionKinds.Description,
		QuickInfoSectionKinds.DocumentationComments,
		QuickInfoSectionKinds.Usage,
		QuickInfoSectionKinds.TypeParameters,
		QuickInfoSectionKinds.AnonymousTypes,
		QuickInfoSectionKinds.Exception,
	];

	public async Task<CodeQuickInfoResponse> GetQuickInfoAsync(CodePositionRequest request, CancellationToken cancellationToken) {
		var document = Get(request.DocumentId).Document;
		var service = QuickInfoService.GetService(document);
		if (service is null)
			return new CodeQuickInfoResponse(null);
		var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
		var item = await service.GetQuickInfoAsync(document, Math.Clamp(request.Position, 0, text.Length), cancellationToken).ConfigureAwait(false);
		if (item is null)
			return new CodeQuickInfoResponse(null);
		var sections = new List<CodeQuickInfoSectionDto>();
		foreach (var kind in quickInfoSections) {
			var section = item.Sections.FirstOrDefault(s => s.Kind == kind);
			if (section is null)
				continue;
			var parts = RoslynTextParts.ToParts(section.TaggedParts);
			if (parts.Count > 0)
				sections.Add(new CodeQuickInfoSectionDto(kind, parts));
		}
		if (sections.Count == 0)
			return new CodeQuickInfoResponse(null);
		return new CodeQuickInfoResponse(new CodeQuickInfoDto(
			new CodeSpanDto(item.Span.Start, item.Span.Length),
			RoslynTextParts.GetGlyph(item.Tags.Remove(Microsoft.CodeAnalysis.Tags.WellKnownTags.Warning)),
			item.Tags.Contains(Microsoft.CodeAnalysis.Tags.WellKnownTags.Warning),
			sections));
	}

	public async Task<CodeSignatureHelpResponse> GetSignatureHelpAsync(CodeSignatureHelpRequest request, CancellationToken cancellationToken) {
		var document = Get(request.DocumentId).Document;
		var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
		return new CodeSignatureHelpResponse(await SignatureHelpProvider.GetAsync(document, Math.Clamp(request.Position, 0, text.Length), request.TriggerCharacter, cancellationToken).ConfigureAwait(false));
	}

	/// <summary>
	/// What compiling the document reports — dnSpy's <c>RoslynLanguageCompiler.CompileAsync</c>, including its
	/// second try without unsafe code, which some corlibs cannot compile the attributes of.
	/// </summary>
	public async Task<CodeDiagnosticsResponse> GetDiagnosticsAsync(CodeDocumentRequest request, CancellationToken cancellationToken) {
		var document = Get(request.DocumentId).Document;
		var compilation = await document.Project.GetCompilationAsync(cancellationToken).ConfigureAwait(false);
		if (compilation is null)
			return new CodeDiagnosticsResponse([]);
		var result = Emit(compilation, cancellationToken);
		if (!result.Success) {
			var noUnsafe = ((CSharpCompilationOptions)compilation.Options).WithAllowUnsafe(false);
			if (noUnsafe != compilation.Options) {
				var second = Emit(compilation.WithOptions(noUnsafe), cancellationToken);
				if (second.Success)
					result = second;
			}
		}
		var diagnostics = result.Diagnostics
			.Where(d => d.Severity != DiagnosticSeverity.Hidden)
			.Select(ToDto)
			.ToArray();
		return new CodeDiagnosticsResponse(diagnostics);
	}

	static Microsoft.CodeAnalysis.Emit.EmitResult Emit(Compilation compilation, CancellationToken cancellationToken) {
		using var peStream = new MemoryStream();
		using var pdbStream = new MemoryStream();
		var options = new Microsoft.CodeAnalysis.Emit.EmitOptions(debugInformationFormat: Microsoft.CodeAnalysis.Emit.DebugInformationFormat.PortablePdb);
		return compilation.Emit(peStream, pdbStream, options: options, cancellationToken: cancellationToken);
	}

	static CodeDiagnosticDto ToDto(Diagnostic diagnostic) {
		var severity = diagnostic.Severity switch {
			DiagnosticSeverity.Error => "error",
			DiagnosticSeverity.Warning => "warning",
			_ => "info",
		};
		var span = diagnostic.Location.IsInSource ? diagnostic.Location.SourceSpan : default;
		var lines = diagnostic.Location.IsInSource ? diagnostic.Location.GetLineSpan() : default;
		return new CodeDiagnosticDto(diagnostic.Id, severity, diagnostic.GetMessage(), GetHelpUri(diagnostic.Id), span.Start, span.Length,
			lines.StartLinePosition.Line, lines.StartLinePosition.Character, lines.EndLinePosition.Line, lines.EndLinePosition.Character);
	}

	/// <summary>The ids whose page sits among the compiler messages rather than under misc (dnSpy's own list).</summary>
	static readonly HashSet<string> requiresCompilerMessagesUrl = new(StringComparer.Ordinal) {
		"cs0001", "cs0006", "cs0007", "cs0015", "cs0016", "cs0019", "cs0029", "cs0034",
		"cs0038", "cs0039", "cs0050", "cs0051", "cs0052", "cs0071", "cs0103", "cs0106",
		"cs0108", "cs0115", "cs0116", "cs0120", "cs0122", "cs0134", "cs0151", "cs0163",
		"cs0165", "cs0173", "cs0178", "cs0188", "cs0201", "cs0229", "cs0233", "cs0234",
		"cs0246", "cs0260", "cs0266", "cs0269", "cs0270", "cs0304", "cs0310", "cs0311",
		"cs0413", "cs0417", "cs0420", "cs0429", "cs0433", "cs0445", "cs0446", "cs0465",
		"cs0467", "cs0504", "cs0507", "cs0518", "cs0523", "cs0545", "cs0552", "cs0563",
		"cs0570", "cs0571", "cs0579", "cs0592", "cs0616", "cs0618", "cs0650", "cs0675",
		"cs0686", "cs0702", "cs0703", "cs0731", "cs0826", "cs0834", "cs0840", "cs0843",
		"cs0845", "cs1001", "cs1009", "cs1018", "cs1019", "cs1026", "cs1029", "cs1058",
		"cs1060", "cs1061", "cs1112", "cs1501", "cs1502", "cs1519", "cs1540", "cs1546",
		"cs1548", "cs1564", "cs1567", "cs1579", "cs1591", "cs1598", "cs1607", "cs1610",
		"cs1612", "cs1614", "cs1616", "cs1640", "cs1644", "cs1656", "cs1658", "cs1674",
		"cs1683", "cs1685", "cs1690", "cs1691", "cs1699", "cs1700", "cs1701", "cs1703",
		"cs1704", "cs1705", "cs1708", "cs1716", "cs1721", "cs1726", "cs1729", "cs1762",
		"cs1919", "cs1921", "cs1926", "cs1933", "cs1936", "cs1941", "cs1942", "cs1943",
		"cs1946", "cs1956", "cs2032", "cs3003", "cs3007", "cs3009", "cs4014", "cs7003",
	};

	/// <summary>dnSpy's <c>CSharpLanguageCompiler.GetHelpUri</c>.</summary>
	public static string GetHelpUri(string diagnosticId) {
		var id = diagnosticId.ToLowerInvariant();
		const string miscUrl = "https://docs.microsoft.com/dotnet/csharp/misc/";
		const string compilerMessagesUrl = "https://docs.microsoft.com/dotnet/csharp/language-reference/compiler-messages/";
		if (requiresCompilerMessagesUrl.Contains(id))
			return compilerMessagesUrl + id;
		if (id == "cs3024")
			return miscUrl + "compiler-warning-cs3024";
		return miscUrl + id;
	}

	/// <summary>
	/// The indentation a line should start at — dnSpy's Roslyn smart indent. Roslyn's indentation service is not
	/// public, so this asks its formatter instead: the line's first token (or, on an empty line, a placeholder
	/// standing where the caret is) is formatted in place, and the column the formatter moves it to is the answer.
	/// </summary>
	public async Task<CodeIndentationResponse> GetIndentationAsync(CodeIndentationRequest request, CancellationToken cancellationToken) {
		var document = Get(request.DocumentId).Document;
		var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
		if ((uint)request.Line >= (uint)text.Lines.Count)
			return new CodeIndentationResponse(null);
		var line = text.Lines[request.Line];
		var lineText = line.ToString();
		var firstNonWhiteSpace = 0;
		while (firstNonWhiteSpace < lineText.Length && char.IsWhiteSpace(lineText[firstNonWhiteSpace]))
			firstNonWhiteSpace++;

		const string placeholder = "dnSpyIndentationPlaceholder";
		var probeText = firstNonWhiteSpace == lineText.Length
			? text.WithChanges(new TextChange(new TextSpan(line.End, 0), placeholder))
			: text;
		var probe = document.WithText(probeText);
		var root = await probe.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
		if (root is null)
			return new CodeIndentationResponse(null);
		var token = root.FindToken(line.Start + firstNonWhiteSpace);
		// Inside a multi-line string or comment no token starts where the text does, and the whitespace there is
		// content rather than indentation.
		if (token.SpanStart != line.Start + firstNonWhiteSpace || token.IsKind(SyntaxKind.EndOfFileToken) || token.IsKind(SyntaxKind.InterpolatedStringTextToken))
			return new CodeIndentationResponse(null);

		var options = probe.Project.Solution.Options
			.WithChangedOption(FormattingOptions.UseTabs, LanguageNames.CSharp, request.UseTabs)
			.WithChangedOption(FormattingOptions.TabSize, LanguageNames.CSharp, request.TabSize)
			.WithChangedOption(FormattingOptions.IndentationSize, LanguageNames.CSharp, request.IndentSize);
#pragma warning disable CS0618 // The SyntaxFormattingOptions overloads are internal; the OptionSet one is what is public.
		// The formatter only moves a token whose pair with the token before it lies in the span.
		var previous = token.GetPreviousToken();
		var spanStart = previous.RawKind == 0 ? line.Start : previous.SpanStart;
		var changes = Formatter.GetFormattedTextChanges(root, TextSpan.FromBounds(spanStart, token.Span.End), probe.Project.Solution.Workspace, options, cancellationToken);
#pragma warning restore CS0618
		// The token keeps its text; where it lands is its old offset moved by every edit made in front of it.
		var tokenStart = token.SpanStart;
		foreach (var change in changes) {
			if (change.Span.End <= token.SpanStart)
				tokenStart += change.NewText!.Length - change.Span.Length;
		}
		var formatted = probeText.WithChanges(changes);
		var formattedLine = formatted.Lines.GetLineFromPosition(tokenStart);
		var leading = formatted.ToString(TextSpan.FromBounds(formattedLine.Start, tokenStart));
		if (leading.Any(ch => !char.IsWhiteSpace(ch)))
			return new CodeIndentationResponse(null);
		var column = 0;
		foreach (var ch in leading)
			column += ch == '\t' ? request.TabSize - column % request.TabSize : 1;
		return new CodeIndentationResponse(column);
	}

	/// <summary>
	/// For each position, the token and every node around it, innermost first — the spans dnSpy's text structure
	/// navigator walks out through (<c>GetSpanOfEnclosing</c>).
	/// </summary>
	public async Task<CodeSelectionRangesResponse> GetSelectionRangesAsync(CodeSelectionRangesRequest request, CancellationToken cancellationToken) {
		var document = Get(request.DocumentId).Document;
		var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
		if (root is null)
			return new CodeSelectionRangesResponse([]);
		var result = new List<IReadOnlyList<CodeSpanDto>>();
		foreach (var position in request.Positions) {
			var spans = new List<CodeSpanDto>();
			var clamped = Math.Clamp(position, 0, root.FullSpan.End);
			var token = root.FindToken(clamped, findInsideTrivia: true);
			// A caret right after a word belongs to the word, not to the space or punctuation that follows it.
			if (clamped > 0 && token.SpanStart == clamped && root.FindToken(clamped - 1, findInsideTrivia: true) is var previous && previous.Span.End == clamped && IsWord(previous))
				token = previous;
			var last = default(TextSpan?);
			void Add(TextSpan span) {
				if (span.Length == 0 || last == span || clamped < span.Start || clamped > span.End)
					return;
				spans.Add(new CodeSpanDto(span.Start, span.Length));
				last = span;
			}
			Add(token.Span);
			for (var node = token.Parent; node is not null; node = node.Parent)
				Add(node.Span);
			result.Add(spans);
		}
		return new CodeSelectionRangesResponse(result);
	}

	static bool IsWord(SyntaxToken token) => SyntaxFacts.IsIdentifierStartCharacter(token.Text.FirstOrDefault()) || token.IsKind(SyntaxKind.NumericLiteralToken);

	public void Dispose() {
		if (disposed)
			return;
		disposed = true;
		foreach (var document in documents.Values)
			document.Dispose();
		documents.Clear();
	}
}
