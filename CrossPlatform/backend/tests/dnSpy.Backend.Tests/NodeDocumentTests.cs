using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The documents dnSpy writes for more than one member: a tab of several nodes (DocumentTreeNodeDecompiler), the
/// Resources folder (NodeDecompiler), and where a followed member reference opens
/// (TreeNodeReferenceDocumentTabContentProvider).
/// </summary>
public sealed class NodeDocumentTests : IDisposable {
	static readonly string DebugTargetPath = Path.Combine(AppContext.BaseDirectory, "DebugTarget.dll");
	readonly WorkspaceManager manager = new();

	static CancellationToken Token => TestContext.Current.CancellationToken;

	static int TokenOf(Func<ModuleDefMD, IMDTokenProvider> find) {
		using var module = ModuleDefMD.Load(DebugTargetPath);
		return unchecked((int)find(module).MDToken.Raw);
	}

	static TypeDef ProgramType(ModuleDefMD module) => module.Find("DebugTarget.Program", isReflectionName: true);

	async Task<string> NodeOfAsync(string workspaceId, Func<ModuleDefMD, IMDTokenProvider> find) {
		var found = await manager.FindMemberAsync(new FindMemberRequest(workspaceId, DebugTargetPath, TokenOf(find)), Token);
		return found.NodeId ?? throw new InvalidOperationException("The member has no node.");
	}

	async Task<string> OpenAsync(string path) => (await manager.OpenAsync(new OpenWorkspaceRequest([path]), Token)).WorkspaceId;

	Task<DecompileResponse> DecompileAsync(string workspaceId, string nodeId, DecompilerLanguage language) =>
		manager.DecompileAsync(new DecompileRequest(workspaceId, nodeId, language), Token);

	[Theory]
	[InlineData(DecompilerLanguage.CSharp)]
	[InlineData(DecompilerLanguage.IL)]
	[InlineData(DecompilerLanguage.VisualBasic)]
	public async Task SeveralNodesAreOneDocumentWithAnEmptyLineBetweenThem(DecompilerLanguage language) {
		var workspaceId = await OpenAsync(DebugTargetPath);
		var calculate = await NodeOfAsync(workspaceId, module => ProgramType(module).FindMethod("Calculate"));
		var identity = await NodeOfAsync(workspaceId, module => ProgramType(module).FindMethod("Identity"));
		var first = await DecompileAsync(workspaceId, calculate, language);
		var second = await DecompileAsync(workspaceId, identity, language);

		var both = await manager.DecompileNodesAsync(new DecompileNodesRequest(workspaceId, [calculate, identity], language), Token);

		// DocumentTreeNodeDecompiler writes `output.WriteLine()` between two nodes.
		Assert.Equal(first.Text + "\n" + second.Text, both.Text);
		Assert.Equal($"{first.Title}, {second.Title}", both.Title);
		var offset = first.Text.Length + 1;
		var lineShift = first.Text.Count(c => c == '\n') + 1;
		Assert.Equal(first.Spans.Count + second.Spans.Count, both.Spans.Count);
		foreach (var (span, index) in second.Spans.Select((span, index) => (span, index))) {
			var moved = both.Spans[first.Spans.Count + index];
			Assert.Equal(span.Start + offset, moved.Start);
			Assert.Equal(both.Text.Substring(moved.Start, moved.Length), second.Text.Substring(span.Start, span.Length));
		}
		// The statements of the second node are on its lines in the joined text.
		var secondStatements = second.CodeStatements ?? [];
		Assert.Equal((first.CodeStatements?.Count ?? 0) + secondStatements.Count, both.CodeStatements?.Count ?? 0);
		foreach (var statement in secondStatements.Where(statement => !statement.IsHidden))
			Assert.Contains(both.CodeStatements!, moved => moved.IlOffset == statement.IlOffset && moved.MetadataToken == statement.MetadataToken && moved.StartLine == statement.StartLine + lineShift);
		// A local of one node is not a local of the other.
		var firstLocals = both.Spans.Take(first.Spans.Count).Where(span => span.LocalId is not null).Select(span => span.LocalId).ToHashSet();
		Assert.DoesNotContain(both.Spans.Skip(first.Spans.Count), span => span.LocalId is not null && firstLocals.Contains(span.LocalId));
		foreach (var separator in second.LineSeparators ?? [])
			Assert.Contains(separator + offset, both.LineSeparators!);
	}

	[Fact]
	public async Task SeveralNodesHonourCancellation() {
		var workspaceId = await OpenAsync(DebugTargetPath);
		var calculate = await NodeOfAsync(workspaceId, module => ProgramType(module).FindMethod("Calculate"));
		using var canceled = new CancellationTokenSource();
		await canceled.CancelAsync();
		await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
			manager.DecompileNodesAsync(new DecompileNodesRequest(workspaceId, [calculate, calculate], DecompilerLanguage.CSharp), canceled.Token));
	}

	[Fact]
	public async Task FollowingAMemberShowsItsOutermostTypeWhenDecompileFullTypeIsOn() {
		var workspaceId = await OpenAsync(DebugTargetPath);
		var work = await NodeOfAsync(workspaceId, module => ProgramType(module).NestedTypes.Single(type => type.Name == "Worker").FindMethod("Work"));
		var program = await NodeOfAsync(workspaceId, ProgramType);

		var full = await manager.ResolveDocumentNodeAsync(new ResolveDocumentNodeRequest(workspaceId, work, DecompileFullType: true), Token);
		Assert.Equal(program, full.DocumentNodeId);
		Assert.Equal(work, full.DefinitionNodeId);

		var itself = await manager.ResolveDocumentNodeAsync(new ResolveDocumentNodeRequest(workspaceId, work, DecompileFullType: false), Token);
		Assert.Equal(work, itself.DocumentNodeId);
		Assert.Equal(work, itself.DefinitionNodeId);

		// A type is its own definition; a nested one is still shown inside the outermost.
		var programItself = await manager.ResolveDocumentNodeAsync(new ResolveDocumentNodeRequest(workspaceId, program, DecompileFullType: true), Token);
		Assert.Equal(program, programItself.DocumentNodeId);
	}

	[Fact]
	public async Task FollowingAStateMachineMethodGoesToTheMethodItWasMadeFrom() {
		var workspaceId = await OpenAsync(DebugTargetPath);
		var moveNext = await NodeOfAsync(workspaceId, module => ProgramType(module).NestedTypes.Single(type => type.Name.StartsWith("<AddAsync>", StringComparison.Ordinal)).FindMethod("MoveNext"));
		var addAsync = await NodeOfAsync(workspaceId, module => ProgramType(module).FindMethod("AddAsync"));
		var program = await NodeOfAsync(workspaceId, ProgramType);

		var itself = await manager.ResolveDocumentNodeAsync(new ResolveDocumentNodeRequest(workspaceId, moveNext, DecompileFullType: false), Token);
		Assert.Equal(addAsync, itself.DocumentNodeId);
		Assert.Equal(addAsync, itself.DefinitionNodeId);

		var full = await manager.ResolveDocumentNodeAsync(new ResolveDocumentNodeRequest(workspaceId, moveNext, DecompileFullType: true), Token);
		Assert.Equal(program, full.DocumentNodeId);
		Assert.Equal(addAsync, full.DefinitionNodeId);
	}

	/// <summary>
	/// NodeDecompiler.Decompile(ResourcesFolderNode): each resource's short form, a .resources file followed by its
	/// entries, with the Save button its line carries — and a BAML entry is a line there, not the XAML it shows alone.
	/// </summary>
	[Fact]
	public async Task TheResourcesFolderWritesEveryResourceInShort() {
		var target = Path.GetFullPath(Path.Combine(
			AppContext.BaseDirectory, "..", "..", "..", "..", "BamlTarget", "bin", TestConfiguration, "net10.0-windows", "BamlTarget.dll"));
		Assert.True(File.Exists(target), $"BAML fixture was not built: {target}");
		var workspaceId = await OpenAsync(target);
		var root = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), Token)).Nodes);
		var module = Assert.Single(await ChildrenAsync(workspaceId, root.Id), node => node.Kind == "module");
		var folder = Assert.Single(await ChildrenAsync(workspaceId, module.Id), node => node.Kind == "resourcesgroup");
		var generated = Assert.Single(await ChildrenAsync(workspaceId, folder.Id), node => node.Label.EndsWith(".g.resources", StringComparison.OrdinalIgnoreCase));
		var baml = Assert.Single(await ChildrenAsync(workspaceId, generated.Id), node => node.Label.EndsWith(".baml", StringComparison.OrdinalIgnoreCase));

		var document = await DecompileAsync(workspaceId, folder.Id, DecompilerLanguage.CSharp);
		var resourceDocument = await DecompileAsync(workspaceId, generated.Id, DecompilerLanguage.CSharp);
		Assert.Contains(resourceDocument.Text, document.Text, StringComparison.Ordinal);
		Assert.Contains(document.Attachments ?? [], attachment => attachment.Kind == DocumentAttachmentKinds.SaveButton && attachment.NodeId == generated.Id);
		var lines = document.Text.Split('\n');
		Assert.Contains(lines, line => line.StartsWith("// ", StringComparison.Ordinal) && line.Contains(generated.Label, StringComparison.Ordinal));
		Assert.Contains(lines, line => line.StartsWith("// ", StringComparison.Ordinal) && line.Contains(".baml", StringComparison.OrdinalIgnoreCase));
		Assert.All(lines.Where(line => line.Length > 0), line => Assert.StartsWith("// ", line, StringComparison.Ordinal));

		// Alone, a BAML entry shows its XAML; beside another node it is the line NodeDecompiler writes for it.
		var alone = await DecompileAsync(workspaceId, baml.Id, DecompilerLanguage.CSharp);
		Assert.Equal("xaml", alone.Language);
		var beside = await manager.DecompileNodesAsync(new DecompileNodesRequest(workspaceId, [generated.Id, baml.Id], DecompilerLanguage.CSharp), Token);
		Assert.Equal("csharp", beside.Language);
		Assert.DoesNotContain("<", beside.Text.Split('\n').Last(line => line.Length > 0), StringComparison.Ordinal);
	}

	[Fact]
	public void JoinedDocumentsKeepTheirLocalsKeywordGroupsAndAttachmentsApart() {
		var first = new DecompileResponse("A", "csharp", "a\nb\n", [new TextSpanDto(0, 1, "definition") { LocalId = "L0" }], [new DiagnosticDto("warning", "w", 2, 1)]) {
			RelatedKeywords = [new KeywordReferenceDto(0, 1, 0), new KeywordReferenceDto(2, 1, 1)],
			CodeStatements = [new CodeStatementDto(2, 2, 1, 2, 0, 1, 0, "m", 1, 1, "M", false), new CodeStatementDto(0xFEEFEE, 0xFEEFEE, 0, 0, 2, 3, 2, "m", 1, 1, "M", true)],
		};
		var second = new DecompileResponse("B", "csharp", "c\n", [new TextSpanDto(0, 1, "reference") { LocalId = "L0" }], []) {
			RelatedKeywords = [new KeywordReferenceDto(0, 1, 0)],
			Attachments = [new DocumentAttachmentDto(1, DocumentAttachmentKinds.SaveButton, NodeId: "n1")],
			BlockStructures = [new BlockStructureDto(0, 1, "type")],
		};

		var joined = DocumentConcatenation.Concat([first, second], "\n", "csharp");

		Assert.Equal("a\nb\n\nc\n", joined.Text);
		Assert.Equal("A, B", joined.Title);
		Assert.Equal(["L0", "1:L0"], joined.Spans.Select(span => span.LocalId));
		Assert.Equal([0, 5], joined.Spans.Select(span => span.Start));
		Assert.Equal(2, Assert.Single(joined.Diagnostics).Start);
		Assert.Equal([0, 1, 2], joined.RelatedKeywords!.Select(keyword => keyword.Group));
		Assert.Equal(5, joined.RelatedKeywords![2].Start);
		// The hidden statement stays on the line that stands for no line.
		Assert.Equal([2, 0xFEEFEE], joined.CodeStatements!.Select(statement => statement.StartLine));
		Assert.Equal(4, Assert.Single(joined.Attachments!).AfterLine);
		Assert.Equal(5, Assert.Single(joined.BlockStructures!).Start);
	}

	async Task<IReadOnlyList<TreeNodeDto>> ChildrenAsync(string workspaceId, string nodeId) =>
		(await manager.GetChildrenAsync(new NodeRequest(workspaceId, nodeId), Token)).Nodes;

	static string[] LinesOf(DecompileResponse document) => document.Text.Split('\n').Select(line => line.TrimEnd('\r')).ToArray();

	async Task<(string WorkspaceId, TreeNodeDto Root, TreeNodeDto Module)> OpenDebugTargetAsync() {
		var workspaceId = await OpenAsync(DebugTargetPath);
		var root = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), Token)).Nodes);
		var module = Assert.Single(await ChildrenAsync(workspaceId, root.Id), node => node.Kind == "module");
		return (workspaceId, root, module);
	}

	/// <summary>
	/// CSharpDecompiler.Decompile(AssemblyDef): WriteAssembly's header — the file, the full name, the entry point and
	/// the timestamp — and then AddAssembly with onlyAssemblyLevel, which is the assembly's own attributes and none of
	/// its types' code.
	/// </summary>
	[Fact]
	public async Task AnAssemblyInCSharpIsItsHeaderAndItsAttributes() {
		var (workspaceId, root, _) = await OpenDebugTargetAsync();

		var document = await DecompileAsync(workspaceId, root.Id, DecompilerLanguage.CSharp);

		var lines = LinesOf(document);
		Assert.Equal("csharp", document.Language);
		Assert.Equal("// " + DebugTargetPath, lines[0]);
		Assert.StartsWith("// DebugTarget, Version=", lines[1], StringComparison.Ordinal);
		Assert.Equal("", lines[2]);
		Assert.Equal("// Entry point: DebugTarget.Program.Main", lines[3]);
		Assert.StartsWith("// Timestamp: ", lines[4], StringComparison.Ordinal);
		Assert.Contains(lines, line => line.StartsWith("[assembly: ", StringComparison.Ordinal));
		Assert.DoesNotContain(lines, line => line.StartsWith("[module: ", StringComparison.Ordinal));
		Assert.DoesNotContain("class Program", document.Text, StringComparison.Ordinal);
		Assert.Empty(document.CodeStatements ?? []);
		// The entry point names its method, and the attributes their types.
		var main = Assert.Single(document.Spans, span => document.Text.Substring(span.Start, span.Length) == "Main");
		Assert.NotNull(main.TargetNodeId);
	}

	/// <summary>CSharpDecompiler.Decompile(ModuleDef): WriteModule's header and only the module's own attributes.</summary>
	[Fact]
	public async Task AModuleInCSharpIsItsHeaderAndItsAttributes() {
		var (workspaceId, _, module) = await OpenDebugTargetAsync();

		var document = await DecompileAsync(workspaceId, module.Id, DecompilerLanguage.CSharp);

		var lines = LinesOf(document);
		Assert.Equal("// " + DebugTargetPath, lines[0]);
		Assert.Equal("// DebugTarget.dll", lines[1]);
		Assert.Equal("", lines[2]);
		Assert.Equal("// Global type: <Module>", lines[3]);
		Assert.Equal("// Entry point: DebugTarget.Program.Main", lines[4]);
		Assert.StartsWith("// Architecture: ", lines[5], StringComparison.Ordinal);
		Assert.Contains(lines, line => line.StartsWith("// Runtime: ", StringComparison.Ordinal));
		Assert.Contains(lines, line => line.StartsWith("// Timestamp: ", StringComparison.Ordinal));
		Assert.DoesNotContain(lines, line => line.StartsWith("[assembly: ", StringComparison.Ordinal));
		Assert.DoesNotContain("class Program", document.Text, StringComparison.Ordinal);
		Assert.Empty(document.CodeStatements ?? []);
	}

	/// <summary>The Visual Basic assembly: the same header as comments of its own and the attributes converted.</summary>
	[Fact]
	public async Task AnAssemblyInVisualBasicIsItsHeaderAndItsAttributes() {
		var (workspaceId, root, _) = await OpenDebugTargetAsync();

		var document = await DecompileAsync(workspaceId, root.Id, DecompilerLanguage.VisualBasic);

		var lines = LinesOf(document);
		Assert.Equal("visual-basic", document.Language);
		Assert.Equal("' " + DebugTargetPath, lines[0]);
		Assert.Equal("' Entry point: DebugTarget.Program.Main", lines[3]);
		Assert.Contains(lines, line => line.StartsWith("<Assembly: ", StringComparison.Ordinal));
		Assert.DoesNotContain("[assembly:", document.Text, StringComparison.Ordinal);
		Assert.DoesNotContain("Class Program", document.Text, StringComparison.Ordinal);
		Assert.DoesNotContain("DnSpyAssemblyAttributesPlaceholder", document.Text, StringComparison.Ordinal);
	}

	/// <summary>DecompilerBase.DecompileNamespace, which neither the C# nor the Visual Basic decompiler overrides: the name and the types, each a reference.</summary>
	[Theory]
	[InlineData(DecompilerLanguage.CSharp, "//")]
	[InlineData(DecompilerLanguage.VisualBasic, "'")]
	public async Task ANamespaceListsItsTypesInEveryLanguage(DecompilerLanguage language, string comment) {
		var (workspaceId, _, module) = await OpenDebugTargetAsync();
		var @namespace = Assert.Single(await ChildrenAsync(workspaceId, module.Id), node => node.Kind == "namespace" && node.Label == "DebugTarget");

		var document = await DecompileAsync(workspaceId, @namespace.Id, language);

		var lines = LinesOf(document);
		Assert.Equal([$"{comment} DebugTarget", $"{comment} ", $"{comment} Types:", $"{comment} "], lines[..4]);
		Assert.Contains($"{comment} Program", lines);
		Assert.DoesNotContain("Main(", document.Text, StringComparison.Ordinal);
		var program = Assert.Single(document.Spans, span => document.Text.Substring(span.Start, span.Length) == "Program");
		Assert.Equal(await NodeOfAsync(workspaceId, ProgramType), program.TargetNodeId);
		// One line per type the tree lists under the namespace.
		var types = await ChildrenAsync(workspaceId, @namespace.Id);
		Assert.Equal(types.Count, lines[4..].Count(line => line.StartsWith(comment, StringComparison.Ordinal)));
	}

	static string TestConfiguration => new DirectoryInfo(AppContext.BaseDirectory).Parent?.Name
		?? throw new InvalidOperationException("Could not determine the test configuration.");

	public void Dispose() => manager.Dispose();
}
