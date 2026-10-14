using System.Globalization;
using System.Text;
using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The Assembly Explorer commands that answer from the backend: Copy Full Name, Search MSDN, the Save Resource
/// headers, Remove Assembly against the edit history, Reload All with auto-loaded files, the command line's
/// --select, and the global assembly caches the reference resolver falls back on.
/// </summary>
public sealed class AssemblyExplorerCommandTests : IDisposable {
	readonly WorkspaceManager manager = new();

	static CancellationToken Token => TestContext.Current.CancellationToken;

	static string AnalyzerTargetPath => Path.Combine(AppContext.BaseDirectory, "AnalyzerTarget.dll");

	static string ConsumerPath => Path.Combine(AppContext.BaseDirectory, "AnalyzerTarget.Consumer.dll");

	/// <summary>
	/// dnSpy's Copy Full Name writes the IFullName of the metadata a row stands for: an assembly's display name, a
	/// module's name, a type's or member's full name and a reference's. A row that stands for no metadata row is
	/// not offered the command.
	/// </summary>
	[Fact]
	public async Task FullName_IsTheFullNameOfTheMetadataARowStandsFor() {
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([AnalyzerTargetPath]), Token);
		var root = Assert.Single(await RootsAsync(opened.WorkspaceId));
		Assert.Equal("AnalyzerTarget, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null", root.FullName);
		var module = Assert.Single(await ChildrenAsync(opened.WorkspaceId, root.Id), node => node.Kind == "module");
		Assert.Equal("AnalyzerTarget.dll", module.FullName);
		var moduleChildren = await ChildrenAsync(opened.WorkspaceId, module.Id);
		var @namespace = Assert.Single(moduleChildren, node => node.Kind == "namespace" && node.Label == "AnalyzerTarget");
		Assert.Null(@namespace.FullName);
		var references = Assert.Single(moduleChildren, node => node.Kind == "referencesgroup");
		Assert.Null(references.FullName);
		var runtime = Assert.Single(await ChildrenAsync(opened.WorkspaceId, references.Id), node => node.Label == "System.Runtime");
		Assert.StartsWith("System.Runtime, Version=", runtime.FullName, StringComparison.Ordinal);

		var circle = await FindTypeAsync(opened.WorkspaceId, "Circle");
		Assert.Equal("AnalyzerTarget.Circle", circle.FullName);
		var members = await ChildrenAsync(opened.WorkspaceId, circle.Id);
		Assert.Equal("System.String AnalyzerTarget.Circle::Name()", Assert.Single(members, node => node.Kind == "property" && node.Label == "Name").FullName);
		Assert.Equal("System.Void AnalyzerTarget.Circle::Grow()", Assert.Single(members, node => node.Kind == "method" && node.Label == "Grow()").FullName);
		Assert.Equal("System.Double AnalyzerTarget.Circle::Radius", Assert.Single(members, node => node.Kind == "field" && node.Label == "Radius").FullName);
		var shapeMembers = await ChildrenAsync(opened.WorkspaceId, (await FindTypeAsync(opened.WorkspaceId, "Shape")).Id);
		Assert.Equal("System.EventHandler AnalyzerTarget.Shape::Changed", Assert.Single(shapeMembers, node => node.Kind == "event").FullName);
		// The base type row names the reference it holds.
		var baseTypes = await ChildrenAsync(opened.WorkspaceId, members[0].Id);
		Assert.Equal("AnalyzerTarget.Shape", Assert.Single(baseTypes, node => node.Label == "Shape").FullName);
	}

	/// <summary>A row's coloured text spells exactly what its label says — a constructor wears its type's name in both.</summary>
	[Fact]
	public async Task LabelParts_SpellTheLabel() {
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([AnalyzerTargetPath]), Token);
		var members = await ChildrenAsync(opened.WorkspaceId, (await FindTypeAsync(opened.WorkspaceId, "Circle")).Id);
		Assert.Contains(members, member => member.Kind == "method" && member.Label == "Circle(double)");
		foreach (var member in members.Where(member => member.LabelParts is not null))
			Assert.Equal(member.Label, string.Concat(member.LabelParts!.Select(part => part.Text)));
	}

	/// <summary>
	/// Search MSDN is offered on a row that names a public definition — a reference row is followed to the
	/// definition it resolves to, an accessor stands for its member — and never on an internal one.
	/// </summary>
	[Fact]
	public async Task MsdnName_FollowsAReferenceRowToTheDefinitionItNames() {
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([AnalyzerTargetPath]), Token);
		var circle = await FindTypeAsync(opened.WorkspaceId, "Circle");
		Assert.Equal("AnalyzerTarget.Circle", circle.MsdnName);
		var members = await ChildrenAsync(opened.WorkspaceId, circle.Id);
		Assert.Null(Assert.Single(members, node => node.Kind == "field" && node.Label == "hits").MsdnName);
		Assert.Equal("AnalyzerTarget.Circle.Name", Assert.Single(members, node => node.Kind == "property" && node.Label == "Name").MsdnName);

		var baseType = Assert.Single(await ChildrenAsync(opened.WorkspaceId, members[0].Id), node => node.Label == "Shape");
		Assert.Equal("AnalyzerTarget.Shape", baseType.MsdnName);
		var shape = await FindTypeAsync(opened.WorkspaceId, "Shape");
		var derivedFolder = (await ChildrenAsync(opened.WorkspaceId, shape.Id))[1];
		var derived = Assert.Single(await ChildrenAsync(opened.WorkspaceId, derivedFolder.Id), node => node.Label == "Circle");
		Assert.Equal("AnalyzerTarget.Circle", derived.MsdnName);
	}

	/// <summary>
	/// The Save Resource headers count what would be written: a .resources file saves one file per entry, BAML as
	/// the XAML it decompiles to, while Raw Save writes the file itself. A lone resources folder stands for the
	/// resources in it.
	/// </summary>
	[Fact]
	public async Task ResourceItemNames_AreTheFilesEachSaveWouldWrite() {
		var target = Path.GetFullPath(Path.Combine(
			AppContext.BaseDirectory, "..", "..", "..", "..", "BamlTarget", "bin", TestConfiguration, "net10.0-windows", "BamlTarget.dll"));
		Assert.True(File.Exists(target), $"BAML fixture was not built: {target}");
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([target]), Token);
		var root = Assert.Single(await RootsAsync(opened.WorkspaceId));
		var module = Assert.Single(await ChildrenAsync(opened.WorkspaceId, root.Id), node => node.Kind == "module");
		var folder = Assert.Single(await ChildrenAsync(opened.WorkspaceId, module.Id), node => node.Kind == "resourcesgroup");
		var generated = Assert.Single(await ChildrenAsync(opened.WorkspaceId, folder.Id), node => node.Label.EndsWith(".g.resources", StringComparison.OrdinalIgnoreCase));
		var baml = Assert.Single(await ChildrenAsync(opened.WorkspaceId, generated.Id), node => node.Label.EndsWith(".baml", StringComparison.OrdinalIgnoreCase));

		var ofEntry = await manager.GetResourceItemNamesAsync(new ResourceItemsRequest(opened.WorkspaceId, [baml.Id], false), Token);
		Assert.EndsWith(".xaml", Assert.Single(ofEntry.Names), StringComparison.OrdinalIgnoreCase);
		Assert.EndsWith(".baml", Assert.Single(ofEntry.RawNames), StringComparison.OrdinalIgnoreCase);

		var ofFile = await manager.GetResourceItemNamesAsync(new ResourceItemsRequest(opened.WorkspaceId, [generated.Id], false), Token);
		Assert.Contains(ofFile.Names, name => name.EndsWith(".xaml", StringComparison.OrdinalIgnoreCase));
		Assert.Equal(generated.Label, Assert.Single(ofFile.RawNames));

		var ofFolder = await manager.GetResourceItemNamesAsync(new ResourceItemsRequest(opened.WorkspaceId, [folder.Id], false), Token);
		Assert.Equal(ofFile.Names, ofFolder.Names);
		Assert.Equal(ofFile.RawNames, ofFolder.RawNames);
		// The names are the ones the save itself writes, file for file.
		var items = await manager.GetResourceItemsAsync(new ResourceItemsRequest(opened.WorkspaceId, [generated.Id], false), Token);
		Assert.Equal(ofFile.Names, items.Items.Select(item => item.Name));
	}

	/// <summary>
	/// dnSpy's RemoveAssemblyCommand: a document an edit in the undo history touched is removed by an edit of its
	/// own, which Undo reverses with the very same nodes — and the edit under it is still there to undo.
	/// </summary>
	[Fact]
	public async Task RemovingAnEditedAssemblyIsRecordedInTheHistory() {
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([AnalyzerTargetPath]), Token);
		var circle = await FindTypeAsync(opened.WorkspaceId, "Circle");
		var renamed = await RenameAsync(opened.WorkspaceId, circle.Id, "Ring");
		var root = Assert.Single(await RootsAsync(opened.WorkspaceId));

		var removed = await manager.RemoveModuleAsync(new NodeRequest(opened.WorkspaceId, root.Id), Token);

		Assert.Empty(removed.Roots);
		Assert.Contains(circle.Id, removed.RemovedNodeIds);
		Assert.True(removed.CanUndo);
		Assert.False(removed.CanRedo);
		await Assert.ThrowsAsync<RpcException>(() => manager.GetNodeAsync(new NodeRequest(opened.WorkspaceId, circle.Id), Token));

		var undone = await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), Token);
		// The module list comes back with the step that changed it, and so do the very nodes the client named.
		Assert.Equal([AnalyzerTargetPath], undone.Modules?.Select(module => module.Path));
		Assert.Equal(root.Id, Assert.Single(await RootsAsync(opened.WorkspaceId)).Id);
		Assert.Equal("Ring", (await manager.GetNodeAsync(new NodeRequest(opened.WorkspaceId, circle.Id), Token)).Label);
		// The removal did not count as a change to save: the state is the one the rename left.
		Assert.Equal(renamed.StateId, undone.StateId);
		Assert.True(undone.CanUndo);

		var redone = await manager.RedoAsync(new WorkspaceRequest(opened.WorkspaceId), Token);
		Assert.Empty(redone.Modules ?? []);
		Assert.Empty(await RootsAsync(opened.WorkspaceId));
		await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), Token);
		var renameUndone = await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), Token);
		Assert.Null(renameUndone.Modules);
		Assert.Equal("Circle", (await manager.GetNodeAsync(new NodeRequest(opened.WorkspaceId, circle.Id), Token)).Label);
	}

	/// <summary>A document no edit touched just goes, and the history is left as it was.</summary>
	[Fact]
	public async Task RemovingAnUneditedAssemblyLeavesTheHistoryAlone() {
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([AnalyzerTargetPath, ConsumerPath]), Token);
		var circle = await FindTypeAsync(opened.WorkspaceId, "Circle");
		await RenameAsync(opened.WorkspaceId, circle.Id, "Ring");
		var consumer = Assert.Single(await RootsAsync(opened.WorkspaceId), node => node.Label.StartsWith("AnalyzerTarget.Consumer", StringComparison.Ordinal));

		var removed = await manager.RemoveModuleAsync(new NodeRequest(opened.WorkspaceId, consumer.Id), Token);

		Assert.Single(removed.Roots);
		Assert.True(removed.CanUndo);
		var undone = await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), Token);
		// Undo reaches the rename, not the removal, which was never recorded.
		Assert.Null(undone.Modules);
		Assert.Single(await RootsAsync(opened.WorkspaceId));
		Assert.Equal("Circle", (await manager.GetNodeAsync(new NodeRequest(opened.WorkspaceId, circle.Id), Token)).Label);
	}

	/// <summary>A document only the redo history touched is let go, and the redo history goes with it.</summary>
	[Fact]
	public async Task RemovingAnAssemblyOnlyTheRedoHistoryTouchedClearsIt() {
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([AnalyzerTargetPath]), Token);
		var circle = await FindTypeAsync(opened.WorkspaceId, "Circle");
		await RenameAsync(opened.WorkspaceId, circle.Id, "Ring");
		await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), Token);
		var root = Assert.Single(await RootsAsync(opened.WorkspaceId));

		var removed = await manager.RemoveModuleAsync(new NodeRequest(opened.WorkspaceId, root.Id), Token);

		Assert.False(removed.CanUndo);
		Assert.False(removed.CanRedo);
		await Assert.ThrowsAsync<RpcException>(() => manager.RedoAsync(new WorkspaceRequest(opened.WorkspaceId), Token));
	}

	/// <summary>
	/// dnSpy's Reload All reloads the files the user opened and only those auto-loaded ones a tab still needs,
	/// which stay auto-loaded.
	/// </summary>
	[Fact]
	public async Task ReloadKeepsOnlyTheAutoLoadedFilesItIsAskedTo() {
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([ConsumerPath]), Token);
		await ActivateAnalyzerTargetReferenceAsync(opened.WorkspaceId);
		var modules = (await manager.ReloadAsync(new ReloadWorkspaceRequest(opened.WorkspaceId, [AnalyzerTargetPath]), Token)).Modules;
		Assert.Equal([ConsumerPath, AnalyzerTargetPath], modules.Select(module => module.Path));
		Assert.Equal([false, true], modules.Select(module => module.AutoLoaded));
		Assert.Equal([false, true], (await RootsAsync(opened.WorkspaceId)).Select(root => root.AutoLoaded));

		var reloaded = await manager.ReloadAsync(new ReloadWorkspaceRequest(opened.WorkspaceId), Token);
		Assert.Equal([ConsumerPath], reloaded.Modules.Select(module => module.Path));
	}

	/// <summary>
	/// The command line's --select, which dnSpy reads in the modules of the files it opened: a token in decimal or
	/// hexadecimal, a namespace, or an XML documentation id of a type or member — a nested type's included.
	/// </summary>
	[Fact]
	public async Task SelectMember_ReadsTokensNamespacesAndDocumentationIds() {
		var debugTarget = Path.Combine(AppContext.BaseDirectory, "DebugTarget.dll");
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([AnalyzerTargetPath, debugTarget]), Token);
		async Task<TreeNodeDto?> Select(string member, string path) {
			var response = await manager.SelectMemberAsync(new SelectMemberRequest(opened.WorkspaceId, [path], member), Token);
			return response.NodeId is null ? null : await manager.GetNodeAsync(new NodeRequest(opened.WorkspaceId, response.NodeId), Token);
		}

		var circle = await FindTypeAsync(opened.WorkspaceId, "Circle", "AnalyzerTarget");
		var token = (uint)circle.MetadataToken!.Value;
		Assert.Equal(circle.Id, (await Select(token.ToString(CultureInfo.InvariantCulture), AnalyzerTargetPath))?.Id);
		Assert.Equal(circle.Id, (await Select($"0x{token:X8}", AnalyzerTargetPath))?.Id);
		Assert.Equal(circle.Id, (await Select("T:AnalyzerTarget.Circle", AnalyzerTargetPath))?.Id);
		Assert.Equal(("method", "Grow()"), Pair(await Select("M:AnalyzerTarget.Circle.Grow", AnalyzerTargetPath)));
		Assert.Equal(("method", "Circle(double)"), Pair(await Select("M:AnalyzerTarget.Circle.#ctor(System.Double)", AnalyzerTargetPath)));
		Assert.Equal(("property", "Name"), Pair(await Select("P:AnalyzerTarget.Circle.Name", AnalyzerTargetPath)));
		Assert.Equal(("field", "Radius"), Pair(await Select("F:AnalyzerTarget.Circle.Radius", AnalyzerTargetPath)));
		Assert.Equal(("namespace", "AnalyzerTarget"), Pair(await Select("N:AnalyzerTarget", AnalyzerTargetPath)));
		Assert.Equal(("type", "Worker"), Pair(await Select("T:DebugTarget.Program.Worker", debugTarget)));
		// A member is looked for in the files named, not in everything the workspace holds.
		Assert.Null(await Select("T:AnalyzerTarget.Circle", debugTarget));
		Assert.Null(await Select("T:AnalyzerTarget.Missing", AnalyzerTargetPath));

		static (string, string)? Pair(TreeNodeDto? node) => node is null ? null : (node.Kind, node.Label);
	}

	/// <summary>Every member's documentation id leads back to that member.</summary>
	[Fact]
	public void XmlDocKeys_RoundTripEveryMember() {
		using var module = ModuleDefMD.Load(AnalyzerTargetPath);
		var builder = new StringBuilder();
		foreach (var type in module.GetTypes().Where(type => !type.IsGlobalModuleType)) {
			Assert.Same(type, XmlDocKeyProvider.FindMemberByKey(module, XmlDocKeyProvider.GetKey(type, builder)!.ToString()));
			foreach (var member in type.Methods.Cast<IMemberRef>().Concat(type.Fields).Concat(type.Properties).Concat(type.Events)) {
				var key = XmlDocKeyProvider.GetKey(member, builder)!.ToString();
				Assert.Same(member, XmlDocKeyProvider.FindMemberByKey(module, key));
			}
		}
		var circle = module.Find("AnalyzerTarget.Circle", isReflectionName: false)!;
		Assert.Equal("M:AnalyzerTarget.Circle.#ctor(System.Double)", XmlDocKeyProvider.GetKey(circle.FindConstructors().Single(), builder)!.ToString());
	}

	/// <summary>
	/// dnSpy's resolver falls back on the global assembly caches: the cache entry with the reference's exact
	/// identity, then a file of that name and identity in one of Mono's reference directories.
	/// </summary>
	[Fact]
	public void GacResolve_FindsTheExactIdentityInACacheOrAMonoReferenceDirectory() {
		var prefix = Directory.CreateTempSubdirectory("dnspy-mono-").FullName;
		try {
			var runtimePath = Path.Combine(Path.GetDirectoryName(typeof(object).Assembly.Location)!, "System.Runtime.dll");
			using var runtime = ModuleDefMD.Load(runtimePath);
			var runtimeName = runtime.Assembly!;
			var token = PublicKeyBase.ToPublicKeyToken(runtimeName.PublicKey).ToString();
			var cached = Path.Combine(prefix, "lib", "mono", "gac", "System.Runtime", $"{runtimeName.Version}__{token}", "System.Runtime.dll");
			Directory.CreateDirectory(Path.GetDirectoryName(cached)!);
			File.Copy(runtimePath, cached);
			var reference = Path.Combine(prefix, "lib", "mono", "4.5", "AnalyzerTarget.dll");
			Directory.CreateDirectory(Path.GetDirectoryName(reference)!);
			File.Copy(AnalyzerTargetPath, reference);

			Assert.Equal(cached, GacInfo.ResolveUnder(new AssemblyNameInfo(runtimeName.FullName), prefix));
			Assert.Null(GacInfo.ResolveUnder(new AssemblyNameInfo($"System.Runtime, Version=1.2.3.4, Culture=neutral, PublicKeyToken={token}"), prefix));
			Assert.Equal(reference, GacInfo.ResolveUnder(new AssemblyNameInfo("AnalyzerTarget, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null"), prefix));
			// A reference directory only answers for the identity the file has, version included.
			Assert.Null(GacInfo.ResolveUnder(new AssemblyNameInfo("AnalyzerTarget, Version=2.0.0.0, Culture=neutral, PublicKeyToken=null"), prefix));
		}
		finally {
			Directory.Delete(prefix, recursive: true);
		}
	}

	async Task ActivateAnalyzerTargetReferenceAsync(string workspaceId) {
		var root = Assert.Single(await RootsAsync(workspaceId));
		var module = Assert.Single(await ChildrenAsync(workspaceId, root.Id), node => node.Kind == "module");
		var references = Assert.Single(await ChildrenAsync(workspaceId, module.Id), node => node.Kind == "referencesgroup");
		var analyzerTarget = Assert.Single(await ChildrenAsync(workspaceId, references.Id), node => node.Label == "AnalyzerTarget");
		var activated = await manager.ActivateNodeAsync(new NodeRequest(workspaceId, analyzerTarget.Id), Token);
		Assert.True(activated.RootsChanged);
		Assert.True((await RootsAsync(workspaceId))[1].AutoLoaded);
	}

	async Task<EditCommitResponse> RenameAsync(string workspaceId, string nodeId, string name) {
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), Token);
		await manager.QueueRenameAsync(new RenameEditRequest(workspaceId, transaction.TransactionId, nodeId, name), Token);
		return await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), Token);
	}

	async Task<IReadOnlyList<TreeNodeDto>> RootsAsync(string workspaceId) =>
		(await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), Token)).Nodes;

	async Task<IReadOnlyList<TreeNodeDto>> ChildrenAsync(string workspaceId, string nodeId) =>
		(await manager.GetChildrenAsync(new NodeRequest(workspaceId, nodeId), Token)).Nodes;

	async Task<TreeNodeDto> FindTypeAsync(string workspaceId, string typeName, string assemblyLabel = "AnalyzerTarget") {
		var root = Assert.Single(await RootsAsync(workspaceId), node => node.Label == assemblyLabel);
		var module = Assert.Single(await ChildrenAsync(workspaceId, root.Id), node => node.Kind == "module");
		var @namespace = Assert.Single(await ChildrenAsync(workspaceId, module.Id), node => node.Kind == "namespace" && node.Label == "AnalyzerTarget");
		return Assert.Single(await ChildrenAsync(workspaceId, @namespace.Id), node => node.Label == typeName);
	}

	public void Dispose() => manager.Dispose();

	static string TestConfiguration => new DirectoryInfo(AppContext.BaseDirectory).Parent?.Name
		?? throw new InvalidOperationException("Could not determine the test configuration.");
}
