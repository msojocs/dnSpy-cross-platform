using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.LanguageService;

namespace dnSpy.Backend.Core;

/// <summary>
/// Roslyn language service methods for code intelligence: completions, hover, signature help, and diagnostics.
/// </summary>
public sealed partial class WorkspaceManager {
	readonly RoslynLanguageService languageService = new();

	/// <summary>
	/// Updates a document in the Roslyn workspace for language service features.
	/// This should be called whenever the user edits code in the C# editor.
	/// </summary>
	[RpcMethod("languageService/updateDocument")]
	public async Task<string> UpdateDocumentAsync(UpdateDocumentRequest request, CancellationToken ct) {
		return await languageService.CreateOrUpdateDocumentAsync(request.FilePath, request.Content, ct);
	}

	/// <summary>
	/// Gets completion items at the specified position in a C# document.
	/// </summary>
	[RpcMethod("languageService/completions")]
	public async Task<CompletionDto[]> GetCompletionsAsync(CompletionRequest request, CancellationToken ct) {
		return await languageService.GetCompletionsAsync(request.FilePath, request.Position, ct);
	}

	/// <summary>
	/// Gets hover information at the specified position in a C# document.
	/// </summary>
	[RpcMethod("languageService/hover")]
	public async Task<HoverDto?> GetHoverAsync(HoverRequest request, CancellationToken ct) {
		return await languageService.GetHoverAsync(request.FilePath, request.Position, ct);
	}

	/// <summary>
	/// Gets signature help at the specified position in a C# document.
	/// </summary>
	[RpcMethod("languageService/signatureHelp")]
	public async Task<SignatureHelpDto?> GetSignatureHelpAsync(SignatureHelpRequest request, CancellationToken ct) {
		return await languageService.GetSignatureHelpAsync(request.FilePath, request.Position, ct);
	}

	/// <summary>
	/// Gets diagnostics for a C# document.
	/// </summary>
	[RpcMethod("languageService/diagnostics")]
	public async Task<DiagnosticDto[]> GetDiagnosticsAsync(DiagnosticsRequest request, CancellationToken ct) {
		return await languageService.GetDiagnosticsAsync(request.FilePath, ct);
	}
}

// Request types for language service RPC methods

public sealed record UpdateDocumentRequest {
	public required string FilePath { get; init; }
	public required string Content { get; init; }
}

public sealed record CompletionRequest {
	public required string FilePath { get; init; }
	public required int Position { get; init; }
}

public sealed record HoverRequest {
	public required string FilePath { get; init; }
	public required int Position { get; init; }
}

public sealed record SignatureHelpRequest {
	public required string FilePath { get; init; }
	public required int Position { get; init; }
}

public sealed record DiagnosticsRequest {
	public required string FilePath { get; init; }
}
