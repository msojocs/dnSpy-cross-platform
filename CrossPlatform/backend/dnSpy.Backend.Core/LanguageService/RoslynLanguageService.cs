using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Reflection;
using dnSpy.Backend.Contracts;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Completion;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.QuickInfo;
using Microsoft.CodeAnalysis.Text;
using CS = Microsoft.CodeAnalysis.CSharp;
using VB = Microsoft.CodeAnalysis.VisualBasic;

namespace dnSpy.Backend.Core.LanguageService;

/// <summary>
/// The Roslyn language service of dnSpy's code editor (<c>dnSpy/Roslyn/dnSpy.Roslyn*</c>), in C# and in Visual
/// Basic: each open document lives in a workspace of its own, the way <c>RoslynLanguageCompiler</c> gives each Edit
/// Code session one, and gets the editor's colors, completion, Quick Info, signature help, compiler messages,
/// smart indentation and the words of its text structure navigator from it.
/// </summary>
public sealed class RoslynLanguageService : IDisposable {
	readonly ConcurrentDictionary<string, CodeDocument> documents = new(StringComparer.Ordinal);
	int nextDocumentId;
	bool disposed;

	sealed class CodeDocument : IDisposable {
		public CodeDocument(AdhocWorkspace workspace, DocumentId id, SourceText text) {
			Workspace = workspace;
			Id = id;
			Text = text;
		}

		/// <summary>The text the document was last given, which the next one is an edit of.</summary>
		public SourceText Text { get; set; }

		public AdhocWorkspace Workspace { get; }
		public DocumentId Id { get; }
		public object Gate { get; } = new();

		/// <summary>The last completion list, kept for the description requests that name its items.</summary>
		public (int ResultId, Document Document, ImmutableArray<CompletionItem> Items)? Completion { get; set; }
		public int NextResultId { get; set; }

		public Document Document => Workspace.CurrentSolution.GetDocument(Id) ?? throw new InvalidOperationException("The document was removed from its workspace.");

		public void Dispose() => Workspace.Dispose();
	}

	/// <summary>
	/// Opens a document. <paramref name="references"/> are what the Edit Code window compiles against when the
	/// request names a module; without them, the request's own references or the host's framework.
	/// </summary>
	public CodeDocumentOpenResponse Open(CodeDocumentOpenRequest request, CompilerReferences? references = null) {
		ObjectDisposedException.ThrowIf(disposed, this);
		ArgumentNullException.ThrowIfNull(request);
		var settings = request.Settings ?? new CompilerSettingsDto();
		var visualBasic = request.Language == CompilerLanguages.VisualBasic;
		var language = visualBasic ? LanguageNames.VisualBasic : LanguageNames.CSharp;
		var paths = references?.Paths ?? request.References ?? ReferenceAssemblies.Framework;
		CompilationOptions compilationOptions = visualBasic
			? RoslynCompilerOptions.VisualBasicCompilationOptions(settings, references?.EmbedVisualBasicRuntime ?? settings.EmbedVisualBasicRuntime)
			: RoslynCompilerOptions.CSharpCompilationOptions(settings);
		ParseOptions parseOptions = visualBasic
			? RoslynCompilerOptions.VisualBasicParseOptions(settings)
			: RoslynCompilerOptions.CSharpParseOptions(settings);
		var workspace = new AdhocWorkspace(LanguageServiceHost.Services);
		var project = workspace.AddProject(ProjectInfo.Create(ProjectId.CreateNewId(), VersionStamp.Create(), "compilecodeproj", "compilecodeproj", language,
			compilationOptions: compilationOptions,
			parseOptions: parseOptions,
			metadataReferences: ReferenceAssemblies.Create(paths)));
		var text = SourceText.From(request.Text + EndOfText, System.Text.Encoding.UTF8);
		var document = workspace.AddDocument(DocumentInfo.Create(DocumentId.CreateNewId(project.Id), visualBasic ? "main.vb" : "main.cs",
			loader: TextLoader.From(TextAndVersion.Create(text, VersionStamp.Create()))));
		var id = $"code-{Interlocked.Increment(ref nextDocumentId)}";
		documents[id] = new CodeDocument(workspace, document.Id, text);
		var (trigger, retrigger) = RoslynSignatureHelp.GetTriggerCharacters(language);
		return new CodeDocumentOpenResponse(id, trigger, retrigger);
	}

	public void Update(CodeDocumentUpdateRequest request) {
		var document = Get(request.DocumentId);
		lock (document.Gate) {
			var text = ChangedText(document.Text, request.Text + EndOfText);
			var solution = document.Workspace.CurrentSolution.WithDocumentText(document.Id, text);
			if (!document.Workspace.TryApplyChanges(solution))
				throw new InvalidOperationException("The document's text could not be replaced.");
			document.Text = text;
			document.Completion = null;
		}
	}

	/// <summary>
	/// What the workspace's text has after the editor's. Roslyn reuses a method body's semantic model across edits of
	/// the body, and a body left open at the very end of the text — typing a new member at the end of the file — ends
	/// where the text does, so a position at the end lies outside it and the reused model throws: completion and
	/// signature help then have nothing to give. A line break past the end keeps every position of the editor's text
	/// inside the body.
	/// </summary>
	const string EndOfText = "\n";

	/// <summary>
	/// The new text as an edit of the old one — what the editor's buffer gives Roslyn as it is typed into. Roslyn
	/// reuses what it knows of the members an edit leaves alone (a method body's speculative semantic model), and
	/// does that from the text's changes: a text that is all new would be taken for the old one moved about.
	/// </summary>
	static SourceText ChangedText(SourceText old, string text) {
		var oldText = old.ToString();
		var prefix = 0;
		var max = Math.Min(oldText.Length, text.Length);
		while (prefix < max && oldText[prefix] == text[prefix])
			prefix++;
		var suffix = 0;
		while (suffix < max - prefix && oldText[oldText.Length - 1 - suffix] == text[text.Length - 1 - suffix])
			suffix++;
		var span = TextSpan.FromBounds(prefix, oldText.Length - suffix);
		return old.WithChanges(new TextChange(span, text[prefix..(text.Length - suffix)]));
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

	static bool IsVisualBasic(Document document) => document.Project.Language == LanguageNames.VisualBasic;

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
		var character = request.TriggerCharacter is { Length: > 0 } typed ? typed[0] : (char?)null;
		var trigger = (request.TriggerKind ?? (character is null ? "invoke" : "insertion"), character) switch {
			("insertion", { } ch) => CompletionTrigger.CreateInsertionTrigger(ch),
			("deletion", { } ch) => CompletionTrigger.CreateDeletionTrigger(ch),
			_ => CompletionTrigger.Invoke,
		};
		// dnSpy's command filter asks the service whether a typed or deleted character opens a list before it asks for one.
		if (trigger.Kind != CompletionTriggerKind.Invoke && !service.ShouldTriggerCompletion(text, position, trigger))
			return new CodeCompletionResponse(null);
		var list = await service.GetCompletionsAsync(document, position, trigger, cancellationToken: cancellationToken).ConfigureAwait(false);
		if (list.ItemsList.Count == 0)
			return new CodeCompletionResponse(null);

		var rules = GetRules(service);
		var items = new List<CodeCompletionItemDto>(list.ItemsList.Count);
		var complexEdits = 0;
		for (var index = 0; index < list.ItemsList.Count; index++) {
			var item = list.ItemsList[index];
			// dnSpy's completion set leaves out what has no text to show.
			if (string.IsNullOrEmpty(item.DisplayText))
				continue;
			CodeTextEditDto? edit = null;
			// What a complex item commits (an override's body, a using it needs) only its provider knows.
			if (item.IsComplexTextEdit && complexEdits++ < MaxComplexEdits) {
				var change = await service.GetChangeAsync(document, item, commitCharacter: null, cancellationToken).ConfigureAwait(false);
				edit = new CodeTextEditDto(change.TextChange.Span.Start, change.TextChange.Span.Length, change.TextChange.NewText ?? string.Empty);
			}
			var displayText = item.DisplayTextPrefix + item.DisplayText + item.DisplayTextSuffix;
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
				CompletionKinds.GetImage(item.Tags),
				CompletionKinds.GetDisplayParts(displayText, item.Tags, () => service.GetDescriptionAsync(document, item, cancellationToken).GetAwaiter().GetResult()),
				item.Tags.Contains(Microsoft.CodeAnalysis.Tags.WellKnownTags.Warning),
				ToString(item.Rules.EnterKeyRule),
				edit));
		}
		if (items.Count == 0)
			return new CodeCompletionResponse(null);

		int resultId;
		lock (codeDocument.Gate) {
			resultId = ++codeDocument.NextResultId;
			codeDocument.Completion = (resultId, document, [.. list.ItemsList]);
		}
		return new CodeCompletionResponse(new CodeCompletionListDto(
			resultId,
			new CodeSpanDto(list.Span.Start, list.Span.Length),
			list.SuggestionModeItem is not null,
			items,
			new string([.. rules.DefaultCommitCharacters]),
			ToString(rules.DefaultEnterKeyRule),
			CompletionKinds.GetFilters(list.ItemsList)));
	}

	const int MaxComplexEdits = 200;

	/// <summary>
	/// The service's rules — what dnSpy's command filter reads its commit characters and Enter rule from. The overload
	/// that takes completion options is internal; the one without them is obsolete, so it is asked for by name.
	/// </summary>
	static CompletionRules GetRules(CompletionService service) {
		var getRules = typeof(CompletionService).GetMethod(nameof(CompletionService.GetRules), BindingFlags.Public | BindingFlags.Instance, Type.EmptyTypes);
		return getRules?.Invoke(service, null) as CompletionRules ?? CompletionRules.Default;
	}

	static string ToString(EnterKeyRule rule) => rule switch {
		EnterKeyRule.Never => "never",
		EnterKeyRule.Always => "always",
		EnterKeyRule.AfterFullyTypedWord => "afterFullyTypedWord",
		_ => "default",
	};

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
		var position = Math.Clamp(request.Position, 0, text.Length);
		return new CodeSignatureHelpResponse(await RoslynSignatureHelp.GetAsync(document, position, request.TriggerCharacter, request.TriggerReason, cancellationToken).ConfigureAwait(false));
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
		if (!result.Success && compilation.Options is CS.CSharpCompilationOptions csharpOptions) {
			var noUnsafe = csharpOptions.WithAllowUnsafe(false);
			if (noUnsafe != compilation.Options) {
				var second = Emit(compilation.WithOptions(noUnsafe), cancellationToken);
				if (second.Success)
					result = second;
			}
		}
		var visualBasic = IsVisualBasic(document);
		var diagnostics = result.Diagnostics
			.Where(d => d.Severity != DiagnosticSeverity.Hidden)
			.Select(d => ToDto(d, visualBasic))
			.ToArray();
		return new CodeDiagnosticsResponse(diagnostics);
	}

	static Microsoft.CodeAnalysis.Emit.EmitResult Emit(Compilation compilation, CancellationToken cancellationToken) {
		using var peStream = new MemoryStream();
		using var pdbStream = new MemoryStream();
		var options = new Microsoft.CodeAnalysis.Emit.EmitOptions(debugInformationFormat: Microsoft.CodeAnalysis.Emit.DebugInformationFormat.PortablePdb);
		return compilation.Emit(peStream, pdbStream, options: options, cancellationToken: cancellationToken);
	}

	static CodeDiagnosticDto ToDto(Diagnostic diagnostic, bool visualBasic) {
		var severity = diagnostic.Severity switch {
			DiagnosticSeverity.Error => "error",
			DiagnosticSeverity.Warning => "warning",
			_ => "info",
		};
		var span = diagnostic.Location.IsInSource ? diagnostic.Location.SourceSpan : default;
		var lines = diagnostic.Location.IsInSource ? diagnostic.Location.GetLineSpan() : default;
		return new CodeDiagnosticDto(diagnostic.Id, severity, diagnostic.GetMessage(), visualBasic ? GetVisualBasicHelpUri(diagnostic.Id) : GetHelpUri(diagnostic.Id), span.Start, span.Length,
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

	/// <summary>dnSpy's <c>VisualBasicLanguageCompiler.GetHelpUri</c>.</summary>
	public static string GetVisualBasicHelpUri(string diagnosticId) =>
		"https://docs.microsoft.com/dotnet/visual-basic/misc/" + diagnosticId.ToLowerInvariant();

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
		if (token.SpanStart != line.Start + firstNonWhiteSpace || IsEndOfFileOrStringText(token))
			return new CodeIndentationResponse(null);

		var language = probe.Project.Language;
		var options = probe.Project.Solution.Options
			.WithChangedOption(FormattingOptions.UseTabs, language, request.UseTabs)
			.WithChangedOption(FormattingOptions.TabSize, language, request.TabSize)
			.WithChangedOption(FormattingOptions.IndentationSize, language, request.IndentSize);
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

	static bool IsEndOfFileOrStringText(SyntaxToken token) => token.Language == LanguageNames.VisualBasic
		? VB.VisualBasicExtensions.Kind(token) is VB.SyntaxKind.EndOfFileToken or VB.SyntaxKind.InterpolatedStringTextToken
		: CS.CSharpExtensions.Kind(token) is CS.SyntaxKind.EndOfFileToken or CS.SyntaxKind.InterpolatedStringTextToken;

	/// <summary>A word command's result, from the words dnSpy's Roslyn text structure navigator finds.</summary>
	public async Task<CodeWordNavigationResponse> GetWordNavigationAsync(CodeWordNavigationRequest request, CancellationToken cancellationToken) {
		var document = Get(request.DocumentId).Document;
		var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
		var text = await document.GetTextAsync(cancellationToken).ConfigureAwait(false);
		var position = Math.Clamp(request.Position, 0, text.Length);
		if (root is null)
			return new CodeWordNavigationResponse(position, position);
		var navigator = new TextStructureNavigator(root, text);
		switch (request.Command) {
		case "nextWord": {
			var point = navigator.GetPointOfRightWord(position);
			return new CodeWordNavigationResponse(point, point);
		}
		case "previousWord": {
			var start = navigator.GetSpanOfLeftWord(position).Start;
			return new CodeWordNavigationResponse(start, start);
		}
		case "currentWord": {
			var selectionStart = Math.Clamp(Math.Min(request.SelectionStart, request.SelectionEnd), 0, text.Length);
			var selectionEnd = Math.Clamp(Math.Max(request.SelectionStart, request.SelectionEnd), 0, text.Length);
			var word = navigator.GetCurrentWord(position, TextSpan.FromBounds(selectionStart, selectionEnd));
			return new CodeWordNavigationResponse(word.Start, word.End);
		}
		default:
			throw new RpcException(ErrorCodes.InvalidParams, $"Unknown word command '{request.Command}'.");
		}
	}

	public void Dispose() {
		if (disposed)
			return;
		disposed = true;
		foreach (var document in documents.Values)
			document.Dispose();
		documents.Clear();
	}
}
