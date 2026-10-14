using System.Collections.Immutable;
using System.Composition;
using dnSpy.Backend.Contracts;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Completion;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Host.Mef;
using Microsoft.CodeAnalysis.QuickInfo;
using Microsoft.CodeAnalysis.SignatureHelp;
using Microsoft.CodeAnalysis.Text;

namespace dnSpy.Backend.Core.LanguageService;

/// <summary>
/// Roslyn language service for C# code editing: completion, hover, signature help, and diagnostics.
/// This provides the code intelligence features that the WPF version has through its full Roslyn integration.
/// </summary>
public sealed class RoslynLanguageService : IDisposable {
	readonly AdhocWorkspace workspace;
	readonly Dictionary<string, DocumentId> documentIds = new();
	ProjectId? projectId;
	bool disposed;

	public RoslynLanguageService() {
		var host = MefHostServices.Create(MefHostServices.DefaultAssemblies);
		workspace = new AdhocWorkspace(host);
	}

	/// <summary>
	/// Creates or updates a document in the workspace for language service features.
	/// </summary>
	public async Task<string> CreateOrUpdateDocumentAsync(string filePath, string content, CancellationToken ct) {
		if (projectId is null) {
			var projectInfo = ProjectInfo.Create(
				ProjectId.CreateNewId(),
				VersionStamp.Create(),
				"DnSpyProject",
				"DnSpyProject",
				LanguageNames.CSharp,
				compilationOptions: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary),
				parseOptions: new CSharpParseOptions(LanguageVersion.Latest)
			);
			workspace.AddProject(projectInfo);
			projectId = projectInfo.Id;
		}

		if (documentIds.TryGetValue(filePath, out var existingDocId)) {
			workspace.TryApplyChanges(workspace.CurrentSolution.WithDocumentText(existingDocId, SourceText.From(content)));
			return filePath;
		}

		var docId = DocumentId.CreateNewId(projectId);
		var docInfo = DocumentInfo.Create(
			docId,
			Path.GetFileName(filePath),
			filePath: filePath,
			loader: TextLoader.From(TextAndVersion.Create(SourceText.From(content), VersionStamp.Create()))
		);
		workspace.AddDocument(docInfo);
		documentIds[filePath] = docId;
		return filePath;
	}

	/// <summary>
	/// Gets completion items at the specified position.
	/// </summary>
	public async Task<CompletionDto[]> GetCompletionsAsync(string filePath, int position, CancellationToken ct) {
		if (!documentIds.TryGetValue(filePath, out var docId))
			return [];

		var document = workspace.CurrentSolution.GetDocument(docId);
		if (document is null)
			return [];

		var completionService = CompletionService.GetService(document);
		if (completionService is null)
			return [];

		var completions = await completionService.GetCompletionsAsync(document, position, cancellationToken: ct);
		if (completions is null)
			return [];

		return completions.ItemsList.Select(item => new CompletionDto {
			Label = item.DisplayText,
			Kind = MapCompletionItemKind(item.Tags),
			Detail = item.InlineDescription,
			Documentation = item.Properties.TryGetValue("SymbolName", out var doc) ? doc : null,
			InsertText = item.DisplayText,
			SortText = item.SortText,
			FilterText = item.FilterText,
		}).ToArray();
	}

	/// <summary>
	/// Gets hover information at the specified position.
	/// </summary>
	public async Task<HoverDto?> GetHoverAsync(string filePath, int position, CancellationToken ct) {
		if (!documentIds.TryGetValue(filePath, out var docId))
			return null;

		var document = workspace.CurrentSolution.GetDocument(docId);
		if (document is null)
			return null;

		var quickInfoService = QuickInfoService.GetService(document);
		if (quickInfoService is null)
			return null;

		var quickInfo = await quickInfoService.GetQuickInfoAsync(document, position, ct);
		if (quickInfo is null)
			return null;

		var text = string.Join("\n", quickInfo.Sections.Select(s => s.Text));
		return new HoverDto {
			Contents = text,
			Range = new RangeDto {
				StartLine = quickInfo.Span.Start,
				StartColumn = 0,
				EndLine = quickInfo.Span.End,
				EndColumn = 0,
			},
		};
	}

	/// <summary>
	/// Gets signature help at the specified position.
	/// </summary>
	public async Task<SignatureHelpDto?> GetSignatureHelpAsync(string filePath, int position, CancellationToken ct) {
		if (!documentIds.TryGetValue(filePath, out var docId))
			return null;

		var document = workspace.CurrentSolution.GetDocument(docId);
		if (document is null)
			return null;

		var signatureHelpService = SignatureHelpService.GetService(document, LanguageNames.CSharp);
		if (signatureHelpService is null)
			return null;

		var signatureHelp = await signatureHelpService.GetItemsAsync(document, position, new SignatureHelpTriggerInfo(SignatureHelpTriggerReason.InvokeSignatureHelpCommand), cancellationToken: ct);
		if (signatureHelp is null)
			return null;

		return new SignatureHelpDto {
			Signatures = signatureHelp.Items.Select(item => new SignatureInformationDto {
				Label = item.ToString(),
				Documentation = item.DocumentationFactory?.Invoke(ct).GetFullText() ?? "",
				Parameters = item.Parameters.Select(p => new ParameterInformationDto {
					Label = p.Name,
					Documentation = p.DocumentationFactory?.Invoke(ct).GetFullText() ?? "",
				}).ToArray(),
			}).ToArray(),
			ActiveSignature = signatureHelp.SelectedItemIndex ?? 0,
			ActiveParameter = signatureHelp.ArgumentIndex,
		};
	}

	/// <summary>
	/// Gets diagnostics for the document.
	/// </summary>
	public async Task<DiagnosticDto[]> GetDiagnosticsAsync(string filePath, CancellationToken ct) {
		if (!documentIds.TryGetValue(filePath, out var docId))
			return [];

		var document = workspace.CurrentSolution.GetDocument(docId);
		if (document is null)
			return [];

		var semanticModel = await document.GetSemanticModelAsync(ct);
		if (semanticModel is null)
			return [];

		var diagnostics = semanticModel.GetDiagnostics(cancellationToken: ct);
		return diagnostics.Select(d => new DiagnosticDto {
			Message = d.GetMessage(),
			Severity = d.Severity switch {
				DiagnosticSeverity.Error => "error",
				DiagnosticSeverity.Warning => "warning",
				DiagnosticSeverity.Info => "info",
				_ => "hint",
			},
			Range = new RangeDto {
				StartLine = d.Location.GetLineSpan().StartLinePosition.Line,
				StartColumn = d.Location.GetLineSpan().StartLinePosition.Character,
				EndLine = d.Location.GetLineSpan().EndLinePosition.Line,
				EndColumn = d.Location.GetLineSpan().EndLinePosition.Character,
			},
			Code = d.Id,
		}).ToArray();
	}

	static string MapCompletionItemKind(ImmutableArray<string> tags) {
		if (tags.Contains("Class")) return "class";
		if (tags.Contains("Interface")) return "interface";
		if (tags.Contains("Struct")) return "struct";
		if (tags.Contains("Enum")) return "enum";
		if (tags.Contains("Method")) return "method";
		if (tags.Contains("Property")) return "property";
		if (tags.Contains("Field")) return "field";
		if (tags.Contains("Event")) return "event";
		if (tags.Contains("Namespace")) return "namespace";
		if (tags.Contains("Keyword")) return "keyword";
		if (tags.Contains("Variable")) return "variable";
		return "text";
	}

	public void Dispose() {
		if (disposed)
			return;
		disposed = true;
		workspace.Dispose();
	}
}

// DTO types for RPC communication

public sealed record CompletionDto {
	public required string Label { get; init; }
	public required string Kind { get; init; }
	public string? Detail { get; init; }
	public string? Documentation { get; init; }
	public required string InsertText { get; init; }
	public required string SortText { get; init; }
	public required string FilterText { get; init; }
}

public sealed record HoverDto {
	public required string Contents { get; init; }
	public required RangeDto Range { get; init; }
}

public sealed record SignatureHelpDto {
	public required SignatureInformationDto[] Signatures { get; init; }
	public required int ActiveSignature { get; init; }
	public required int ActiveParameter { get; init; }
}

public sealed record SignatureInformationDto {
	public required string Label { get; init; }
	public required string Documentation { get; init; }
	public required ParameterInformationDto[] Parameters { get; init; }
}

public sealed record ParameterInformationDto {
	public required string Label { get; init; }
	public required string Documentation { get; init; }
}

public sealed record DiagnosticDto {
	public required string Message { get; init; }
	public required string Severity { get; init; }
	public required RangeDto Range { get; init; }
	public required string Code { get; init; }
}

public sealed record RangeDto {
	public required int StartLine { get; init; }
	public required int StartColumn { get; init; }
	public required int EndLine { get; init; }
	public required int EndColumn { get; init; }
}
