using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// dnSpy's Create Assembly and Create NetModule, which make documents with no file until they are saved, and the
/// commands that add a net module to an assembly or take one out of it.
/// </summary>
public sealed class WorkspaceDocumentTests : IDisposable {
	readonly WorkspaceManager manager = new();
	readonly List<string> files = [];

	static AssemblyOptionsDto Options(string name) => new(name, null, (int)AssemblyHashAlgorithm.SHA1, 0, string.Empty, 1, 2, 3, 4, [], [], string.Empty);

	[Fact]
	public async Task CreatesAnAssemblyThatIsModifiedUntilItIsSavedToAFile() {
		var workspace = manager.CreateWorkspace();
		Assert.Empty(workspace.Modules);
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspace.WorkspaceId), TestContext.Current.CancellationToken);
		var created = await manager.QueueCreateAssemblyAsync(new CreateAssemblyRequest(workspace.WorkspaceId, transaction.TransactionId, Options("MyAssembly"), ClrVersions.Clr40), TestContext.Current.CancellationToken);
		var committed = await manager.CommitEditAsync(new EditTransactionRequest(workspace.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var module = Assert.Single(committed.Modules!);
		Assert.True(module.InMemory);
		Assert.Equal("MyAssembly", module.Name);
		var document = Assert.Single(committed.ModifiedDocuments!);
		Assert.True(document.InMemory);
		Assert.Equal(string.Empty, document.Path);
		var root = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(workspace.WorkspaceId), TestContext.Current.CancellationToken)).Nodes);
		Assert.Equal(created.NodeId, root.Id);
		// A document with no file has no PE node — its offsets would mean nothing — and no hex view.
		var moduleRow = Assert.Single(await ChildrenAsync(workspace.WorkspaceId, root.Id));
		Assert.DoesNotContain(await ChildrenAsync(workspace.WorkspaceId, moduleRow.Id), node => node.Kind == "pe");
		await Assert.ThrowsAsync<RpcException>(() => manager.ResolveHexTargetAsync(new HexTargetRequest(workspace.WorkspaceId, root.Id), TestContext.Current.CancellationToken));

		var options = await manager.GetSaveOptionsAsync(new SaveOptionsRequest(workspace.WorkspaceId, root.Id), TestContext.Current.CancellationToken);
		Assert.Equal(string.Empty, options.FileName);
		var target = Temporary(".dll");
		var saved = await manager.SaveDocumentsAsync(new SaveDocumentsRequest(workspace.WorkspaceId, [new SaveDocumentDto(root.Id, target, options.Writer)]), null, TestContext.Current.CancellationToken);
		Assert.True(Assert.Single(saved.Results).Saved);
		Assert.Empty(saved.ModifiedDocuments);
		// The document took the file it was saved to.
		Assert.Equal(target, Assert.Single(saved.Modules!).Path);
		Assert.False(saved.Modules![0].InMemory);
		using var written = ModuleDefMD.Load(target);
		Assert.Equal("MyAssembly", written.Assembly!.Name.String);
		Assert.Equal(new Version(1, 2, 3, 4), written.Assembly.Version);
		Assert.Equal("v4.0.30319", written.RuntimeVersion);
	}

	[Fact]
	public async Task UndoTakesTheNewAssemblyAwayAndRedoPutsItBack() {
		var workspace = manager.CreateWorkspace();
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspace.WorkspaceId), TestContext.Current.CancellationToken);
		var created = await manager.QueueCreateAssemblyAsync(new CreateAssemblyRequest(workspace.WorkspaceId, transaction.TransactionId, Options("Undone"), ClrVersions.Clr20), TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(workspace.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var undone = await manager.UndoAsync(new WorkspaceRequest(workspace.WorkspaceId), TestContext.Current.CancellationToken);
		Assert.Empty(undone.Modules!);
		Assert.Empty(undone.ModifiedDocuments!);
		var redone = await manager.RedoAsync(new WorkspaceRequest(workspace.WorkspaceId), TestContext.Current.CancellationToken);
		Assert.Equal(created.NodeId, Assert.Single(redone.Modules!).Id);
		Assert.Single(redone.ModifiedDocuments!);
	}

	[Fact]
	public async Task AddsANewNetModuleToAnAssemblyAndRemovesItAgain() {
		var (workspaceId, root) = await CreateAssemblyAsync("Host");
		Assert.Equal(ClrVersions.Clr40, (await manager.GetNetModuleDefaultsAsync(new NetModuleDefaultsRequest(workspaceId, root.Id), TestContext.Current.CancellationToken)).ClrVersion);

		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), TestContext.Current.CancellationToken);
		var added = await manager.QueueAddNetModuleAsync(new AddNetModuleRequest(workspaceId, transaction.TransactionId, root.Id, "Extra.netmodule", Guid.NewGuid().ToString(), ClrVersions.Clr40), TestContext.Current.CancellationToken);
		var committed = await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);
		var rows = await ChildrenAsync(workspaceId, root.Id);
		Assert.Equal(2, rows.Count);
		Assert.Equal(added.NodeId, rows[1].Id);
		// The assembly and the new net module both have something to save.
		Assert.Equal(2, committed.ModifiedDocuments!.Count);
		Assert.Contains(committed.ModifiedDocuments, document => document.Id == added.NodeId && document.InMemory);

		var remove = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), TestContext.Current.CancellationToken);
		await Assert.ThrowsAsync<RpcException>(() => manager.QueueRemoveNetModuleAsync(new RemoveNetModuleRequest(workspaceId, remove.TransactionId, rows[0].Id), TestContext.Current.CancellationToken));
		await manager.QueueRemoveNetModuleAsync(new RemoveNetModuleRequest(workspaceId, remove.TransactionId, added.NodeId), TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, remove.TransactionId), TestContext.Current.CancellationToken);
		Assert.Single(await ChildrenAsync(workspaceId, root.Id));

		await manager.UndoAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken);
		Assert.Equal(2, (await ChildrenAsync(workspaceId, root.Id)).Count);
	}

	[Fact]
	public async Task AddsAnExistingNetModuleAndRefusesAFileThatIsNone() {
		var (workspaceId, root) = await CreateAssemblyAsync("Host");
		var netModulePath = Temporary(".netmodule");
		var netModule = new ModuleDefUser("Existing.netmodule") { Kind = ModuleKind.NetModule };
		netModule.Write(netModulePath);

		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), TestContext.Current.CancellationToken);
		var refused = await Assert.ThrowsAsync<RpcException>(() => manager.QueueAddNetModuleAsync(
			new AddNetModuleRequest(workspaceId, transaction.TransactionId, root.Id, Path: typeof(WorkspaceDocumentTests).Assembly.Location), TestContext.Current.CancellationToken));
		Assert.EndsWith("is not a NetModule", refused.Message, StringComparison.Ordinal);
		await manager.QueueAddNetModuleAsync(new AddNetModuleRequest(workspaceId, transaction.TransactionId, root.Id, Path: netModulePath), TestContext.Current.CancellationToken);
		var committed = await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		// A net module read from a file is as it was: only the assembly it joined is modified.
		Assert.Equal([root.Id], committed.ModifiedDocuments!.Select(document => document.Id));
		var rows = await ChildrenAsync(workspaceId, root.Id);
		Assert.Equal("Existing.netmodule", rows[1].Label);
	}

	[Fact]
	public async Task CreatesANetModuleOfItsOwn() {
		var workspace = manager.CreateWorkspace();
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspace.WorkspaceId), TestContext.Current.CancellationToken);
		var mvid = Guid.NewGuid();
		await manager.QueueCreateNetModuleAsync(new CreateNetModuleRequest(workspace.WorkspaceId, transaction.TransactionId, "MyNetModule.netmodule", mvid.ToString(), ClrVersions.Clr40), TestContext.Current.CancellationToken);
		var committed = await manager.CommitEditAsync(new EditTransactionRequest(workspace.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);
		Assert.Equal("MyNetModule.netmodule", Assert.Single(committed.Modules!).Name);

		var bad = await manager.BeginEditAsync(new BeginEditRequest(workspace.WorkspaceId), TestContext.Current.CancellationToken);
		var invalid = await Assert.ThrowsAsync<RpcException>(() => manager.QueueCreateNetModuleAsync(new CreateNetModuleRequest(workspace.WorkspaceId, bad.TransactionId, "x", "not a guid", ClrVersions.Clr40), TestContext.Current.CancellationToken));
		Assert.Equal("Invalid GUID", invalid.Message);
	}

	async Task<(string WorkspaceId, TreeNodeDto Root)> CreateAssemblyAsync(string name) {
		var workspace = manager.CreateWorkspace();
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspace.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.QueueCreateAssemblyAsync(new CreateAssemblyRequest(workspace.WorkspaceId, transaction.TransactionId, Options(name), ClrVersions.Clr40), TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(workspace.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);
		var root = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(workspace.WorkspaceId), TestContext.Current.CancellationToken)).Nodes);
		return (workspace.WorkspaceId, root);
	}

	async Task<IReadOnlyList<TreeNodeDto>> ChildrenAsync(string workspaceId, string nodeId) =>
		(await manager.GetChildrenAsync(new NodeRequest(workspaceId, nodeId), TestContext.Current.CancellationToken)).Nodes;

	string Temporary(string extension) {
		var path = Path.Combine(Path.GetTempPath(), $"documents-{Guid.NewGuid():N}{extension}");
		files.Add(path);
		return path;
	}

	public void Dispose() {
		manager.Dispose();
		foreach (var file in files) {
			try {
				File.Delete(file);
			}
			catch (IOException) {
			}
		}
	}
}
