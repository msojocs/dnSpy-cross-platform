using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

public sealed class WorkspaceSaveOptionsTests : IDisposable {
	readonly WorkspaceManager manager = new();

	[Fact]
	public async Task PreservedRidsKeepAMethodsTokenAcrossADeletion() {
		var opened = await OpenAsync();
		var module = await FindModuleAsync(opened.WorkspaceId);
		var target = await FindTypeAsync(opened.WorkspaceId, "WorkspaceSaveOptionsTests");
		var victim = await FindTypeAsync(opened.WorkspaceId, "SaveOptionsVictim");
		// The token of a type declared after the one that is deleted; compaction would move it.
		Assert.True(target.MetadataToken < victim.MetadataToken || victim.MetadataToken < target.MetadataToken);
		var before = target.MetadataToken!.Value;

		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.QueueDeleteAsync(new DeleteEditRequest(opened.WorkspaceId, transaction.TransactionId, victim.Id), TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var preserved = Path.Combine(Path.GetTempPath(), $"preserved-{Guid.NewGuid():N}.dll");
		var compacted = Path.Combine(Path.GetTempPath(), $"compacted-{Guid.NewGuid():N}.dll");
		await manager.SaveModuleWithOptionsAsync(
			new SaveModuleWithOptionsRequest(opened.WorkspaceId, module.Id, preserved, true, new SaveModuleOptionsDto(PreserveRids: true)),
			TestContext.Current.CancellationToken);
		await manager.SaveModuleWithOptionsAsync(
			new SaveModuleWithOptionsRequest(opened.WorkspaceId, module.Id, compacted, true, new SaveModuleOptionsDto(PreserveRids: false)),
			TestContext.Current.CancellationToken);

		using var preservedModule = ModuleDefMD.Load(preserved);
		var preservedAtToken = preservedModule.ResolveToken((uint)before) as TypeDef;
		Assert.Equal("WorkspaceSaveOptionsTests", preservedAtToken?.Name.String);

		using var compactedModule = ModuleDefMD.Load(compacted);
		var compactedAtToken = compactedModule.ResolveToken((uint)before) as TypeDef;
		// The compacted file has lost the hole the deletion left, so that token now names another row.
		Assert.NotEqual("WorkspaceSaveOptionsTests", compactedAtToken?.Name.String);
	}

	[Fact]
	public async Task SaveInPlaceWithOptionsWritesTheModule() {
		var opened = await OpenAsync();
		var module = await FindModuleAsync(opened.WorkspaceId);
		var path = await manager.SaveModuleInPlaceWithOptionsAsync(
			new SaveModuleInPlaceWithOptionsRequest(opened.WorkspaceId, module.Id, new SaveModuleOptionsDto(PreserveRids: true)),
			TestContext.Current.CancellationToken);
		Assert.True(path.Length > 0);
		// The file that was just written still loads as the same assembly.
		using var reloaded = ModuleDefMD.Load(path.Path);
		Assert.Contains("dnSpy.Backend.Tests", (reloaded.Assembly?.Name ?? UTF8String.Empty).String, StringComparison.Ordinal);
	}

	async Task<OpenWorkspaceResponse> OpenAsync() => await manager.OpenAsync(
		new OpenWorkspaceRequest([typeof(WorkspaceSaveOptionsTests).Assembly.Location]),
		TestContext.Current.CancellationToken);

	async Task<TreeNodeDto> FindModuleAsync(string workspaceId) {
		var root = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).Nodes);
		return Assert.Single((await manager.GetChildrenAsync(new NodeRequest(workspaceId, root.Id), TestContext.Current.CancellationToken)).Nodes, node => node.Kind == "module");
	}

	async Task<TreeNodeDto> FindTypeAsync(string workspaceId, string name) {
		var module = await FindModuleAsync(workspaceId);
		var @namespace = Assert.Single(
			(await manager.GetChildrenAsync(new NodeRequest(workspaceId, module.Id), TestContext.Current.CancellationToken)).Nodes,
			node => node.Label == "dnSpy.Backend.Tests");
		return Assert.Single(
			(await manager.GetChildrenAsync(new NodeRequest(workspaceId, @namespace.Id), TestContext.Current.CancellationToken)).Nodes,
			node => node.Label == name);
	}

	public void Dispose() => manager.Dispose();
}

/// <summary>A type the save-options test deletes, so the compaction it compares against has a hole to close.</summary>
static class SaveOptionsVictim {
}
