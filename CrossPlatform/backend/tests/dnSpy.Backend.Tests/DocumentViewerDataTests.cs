using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// What the document viewer gets beside the text: the references and their colors, the locals tied to their
/// declarations, the block structure, the line separators and the related keywords dnSpy's writers record, in
/// each of the three languages — and the Quick Info a hover asks for.
/// </summary>
public sealed class DocumentViewerDataTests : IDisposable {
	static readonly string DebugTargetPath = Path.Combine(AppContext.BaseDirectory, "DebugTarget.dll");
	readonly WorkspaceManager manager = new();

	static int TokenOf(string typeName, string? methodName = null) {
		using var module = ModuleDefMD.Load(DebugTargetPath);
		var type = module.Find(typeName, isReflectionName: true) ?? throw new InvalidOperationException($"No type {typeName}.");
		return unchecked((int)(methodName is null ? type.MDToken.Raw : type.FindMethod(methodName).MDToken.Raw));
	}

	async Task<(string WorkspaceId, string NodeId)> OpenAsync(string typeName, string? methodName = null) {
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([DebugTargetPath]), TestContext.Current.CancellationToken);
		var found = await manager.FindMemberAsync(new FindMemberRequest(opened.WorkspaceId, DebugTargetPath, TokenOf(typeName, methodName)), TestContext.Current.CancellationToken);
		return (opened.WorkspaceId, found.NodeId ?? throw new InvalidOperationException("The member has no node."));
	}

	Task<DecompileResponse> DecompileAsync(string workspaceId, string nodeId, DecompilerLanguage language) =>
		manager.DecompileAsync(new DecompileRequest(workspaceId, nodeId, language), TestContext.Current.CancellationToken);

	static string TextOf(DecompileResponse document, int start, int length) => document.Text.Substring(start, length);

	static int LineOf(string text, int offset) => text.AsSpan(0, offset).Count('\n') + 1;

	[Fact]
	public async Task CSharpTiesLocalsToTheirDeclarationAndMarksWrites() {
		var (workspaceId, nodeId) = await OpenAsync("DebugTarget.Program", "Calculate");
		var document = await DecompileAsync(workspaceId, nodeId, DecompilerLanguage.CSharp);

		var sums = document.Spans.Where(span => span.LocalId is not null && TextOf(document, span.Start, span.Length) == "num").ToList();
		Assert.True(sums.Count >= 3, document.Text);
		Assert.Single(sums.Select(span => span.LocalId).Distinct());
		Assert.Contains(sums, span => span.Kind == "definition");
		// `sum += left` writes the local; `return sum` reads it.
		Assert.Contains(sums, span => span.IsWrite);
		Assert.Contains(sums, span => span.Kind == "reference" && !span.IsWrite);
		// The first span of a local carries its Quick Info, the way dnSpy's tooltip writes it.
		var toolTip = sums.First().ToolTip;
		Assert.NotNull(toolTip);
		Assert.Equal("(local variable) int num", string.Concat(toolTip!.Select(part => part.Text)));
		Assert.All(sums, span => Assert.Equal(TextColors.Local, span.Color));

		var left = document.Spans.First(span => TextOf(document, span.Start, span.Length) == "left");
		Assert.Equal(TextColors.Parameter, left.Color);
		Assert.NotEqual(sums[0].LocalId, left.LocalId);
		Assert.Equal("(parameter) int left", string.Concat(left.ToolTip!.Select(part => part.Text)));
	}

	[Fact]
	public async Task CSharpRecordsBlocksLineSeparatorsAndRelatedKeywords() {
		var (workspaceId, nodeId) = await OpenAsync("DebugTarget.Program");
		var document = await DecompileAsync(workspaceId, nodeId, DecompilerLanguage.CSharp);

		Assert.NotNull(document.BlockStructures);
		Assert.Contains(document.BlockStructures!, block => block.Kind == "type" && document.Text[block.Start] == '{' && document.Text[block.End] == '}');
		Assert.Contains(document.BlockStructures!, block => block.Kind == "method");
		Assert.Contains(document.BlockStructures!, block => block.Kind == "loop");
		Assert.Contains(document.BlockStructures!, block => block.Kind == "try");
		Assert.Contains(document.BlockStructures!, block => block.Kind == "catch");
		Assert.Contains(document.BlockStructures!, block => block.Kind == "interface");

		// A separator sits on the line of a method body's closing brace.
		Assert.NotNull(document.LineSeparators);
		Assert.NotEmpty(document.LineSeparators!);
		Assert.All(document.LineSeparators!, offset => Assert.Equal('}', document.Text[offset]));

		// The try and its catch share a group; so do a loop's keyword and nothing else's.
		var keywords = document.RelatedKeywords!;
		var tryKeyword = Assert.Single(keywords, keyword => TextOf(document, keyword.Start, keyword.Length) == "try");
		Assert.Contains(keywords, keyword => keyword.Group == tryKeyword.Group && TextOf(document, keyword.Start, keyword.Length) == "catch");
		var returns = keywords.Where(keyword => TextOf(document, keyword.Start, keyword.Length) == "return").ToList();
		Assert.NotEmpty(returns);
		Assert.DoesNotContain(keywords, keyword => keyword.Group == tryKeyword.Group && TextOf(document, keyword.Start, keyword.Length) == "return");
	}

	[Fact]
	public async Task CSharpColorsReferencesByWhatTheyName() {
		var (workspaceId, nodeId) = await OpenAsync("DebugTarget.Program", "Main");
		var document = await DecompileAsync(workspaceId, nodeId, DecompilerLanguage.CSharp);

		var calculate = document.Spans.First(span => TextOf(document, span.Start, span.Length) == "Calculate");
		Assert.Equal(TextColors.StaticMethod, calculate.Color);
		var console = document.Spans.First(span => TextOf(document, span.Start, span.Length) == "Console");
		Assert.Equal(TextColors.StaticType, console.Color);
	}

	[Fact]
	public async Task ILWritesOpCodesAsReferencesAndRecordsBlocks() {
		var (workspaceId, nodeId) = await OpenAsync("DebugTarget.Program", "Calculate");
		var document = await DecompileAsync(workspaceId, nodeId, DecompilerLanguage.IL);

		var opCode = document.Spans.First(span => span.OpCode is not null);
		Assert.Equal(opCode.OpCode, TextOf(document, opCode.Start, opCode.Length));
		Assert.Equal(TextColors.OpCode, opCode.Color);
		var method = Assert.Single(document.BlockStructures!, block => block.Kind == "method");
		// The separator is under the method's closing brace, at the end of the line its end comment is on.
		var separator = Assert.Single(document.LineSeparators!);
		Assert.Equal(LineOf(document.Text, method.End), LineOf(document.Text, separator));
		Assert.Equal("} // end of method Program::Calculate", document.Text[document.Text.LastIndexOf('\n', method.End)..separator].Trim());

		var info = await manager.GetQuickInfoAsync(new DocumentQuickInfoRequest(workspaceId, OpCode: "ldarg.0"), TestContext.Current.CancellationToken);
		Assert.StartsWith("ldarg.0 (0x02)", string.Concat(info.Parts.Select(part => part.Text)), StringComparison.Ordinal);
	}

	[Fact]
	public async Task VisualBasicBindsNamesToTheMembersAndLocalsTheyName() {
		var (workspaceId, nodeId) = await OpenAsync("DebugTarget.Program");
		var document = await DecompileAsync(workspaceId, nodeId, DecompilerLanguage.VisualBasic);
		Assert.Equal("visual-basic", document.Language);

		var calculateNode = (await manager.FindMemberAsync(new FindMemberRequest(workspaceId, DebugTargetPath, TokenOf("DebugTarget.Program", "Calculate")), TestContext.Current.CancellationToken)).NodeId;
		var calculate = document.Spans.Where(span => TextOf(document, span.Start, span.Length) == "Calculate").ToList();
		Assert.True(calculate.Count > 0, $"{document.Spans.Count} spans in:\n{document.Text}");
		Assert.Contains(calculate, span => span.Kind == "definition" && span.TargetNodeId == calculateNode);
		Assert.Contains(calculate, span => span.Kind == "reference" && span.TargetNodeId == calculateNode);

		var sums = document.Spans.Where(span => span.LocalId is not null && TextOf(document, span.Start, span.Length) == "sum").ToList();
		Assert.True(sums.Count >= 2, document.Text);
		Assert.Contains(sums, span => span.Kind == "definition");
		Assert.StartsWith("(local variable) sum As Integer", string.Concat(sums[0].ToolTip!.Select(part => part.Text)), StringComparison.Ordinal);

		// A reference into an assembly the workspace does not hold names the file and the token there.
		Assert.Contains(document.Spans, span => TextOf(document, span.Start, span.Length) == "Console" && span.TargetModulePath is not null && span.TargetMetadataToken is not null);

		Assert.Contains(document.BlockStructures!, block => block.Kind == "method" && LineOf(document.Text, block.End) > LineOf(document.Text, block.Start));
		Assert.Contains(document.BlockStructures!, block => block.Kind == "try");
		Assert.NotEmpty(document.LineSeparators!);
		var keywords = document.RelatedKeywords!;
		var tryKeyword = keywords.First(keyword => TextOf(document, keyword.Start, keyword.Length) == "Try");
		Assert.Contains(keywords, keyword => keyword.Group == tryKeyword.Group && TextOf(document, keyword.Start, keyword.Length) == "Catch");
	}

	[Fact]
	public async Task QuickInfoWritesTheMemberInTheDocumentsLanguage() {
		var (workspaceId, _) = await OpenAsync("DebugTarget.Program");
		var token = TokenOf("DebugTarget.Program", "Calculate");

		var csharp = await manager.GetQuickInfoAsync(new DocumentQuickInfoRequest(workspaceId, null, DebugTargetPath, token), TestContext.Current.CancellationToken);
		Assert.Equal("int DebugTarget.Program.Calculate(int left, int right)", string.Concat(csharp.Parts.Select(part => part.Text)));
		var visualBasic = await manager.GetQuickInfoAsync(new DocumentQuickInfoRequest(workspaceId, null, DebugTargetPath, token, DecompilerLanguage.VisualBasic), TestContext.Current.CancellationToken);
		Assert.Contains("Function", string.Concat(visualBasic.Parts.Select(part => part.Text)), StringComparison.Ordinal);
		Assert.Contains("As Integer", string.Concat(visualBasic.Parts.Select(part => part.Text)), StringComparison.Ordinal);
	}

	public void Dispose() => manager.Dispose();
}
