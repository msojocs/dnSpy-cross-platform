using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

public sealed class WorkspaceAssemblyModuleOptionsTests : IDisposable {
	readonly WorkspaceManager manager = new();

	[Fact]
	public async Task ReadsAndWritesTheAssemblyOptions() {
		var opened = await OpenAsync();
		var module = await FindModuleAsync(opened.WorkspaceId);

		var options = await manager.GetAssemblyOptionsAsync(
			new AssemblyOptionsRequest(opened.WorkspaceId, module.Id),
			TestContext.Current.CancellationToken);
		Assert.StartsWith("dnSpy.Backend.Tests", options.Name, StringComparison.Ordinal);
		Assert.Contains("dnSpy.Backend.Tests", options.FullName, StringComparison.Ordinal);

		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.QueueAssemblyOptionsAsync(
			new SetAssemblyOptionsRequest(
				opened.WorkspaceId,
				transaction.TransactionId,
				module.Id,
				options with { Name = "Renamed.Assembly", VersionMajor = 2, VersionMinor = 3, VersionBuild = 4, VersionRevision = 5, Culture = "en-US" }),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var edited = await manager.GetAssemblyOptionsAsync(
			new AssemblyOptionsRequest(opened.WorkspaceId, module.Id),
			TestContext.Current.CancellationToken);
		Assert.Equal("Renamed.Assembly", edited.Name);
		Assert.Equal((2, 3, 4, 5), (edited.VersionMajor, edited.VersionMinor, edited.VersionBuild, edited.VersionRevision));
		Assert.Equal("en-US", edited.Culture);
		Assert.Contains("Renamed.Assembly", edited.FullName, StringComparison.Ordinal);

		await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		var undone = await manager.GetAssemblyOptionsAsync(
			new AssemblyOptionsRequest(opened.WorkspaceId, module.Id),
			TestContext.Current.CancellationToken);
		Assert.StartsWith("dnSpy.Backend.Tests", undone.Name, StringComparison.Ordinal);
		Assert.True(string.IsNullOrEmpty(undone.Culture));
	}

	[Fact]
	public async Task ReadsAndWritesTheModuleOptions() {
		var opened = await OpenAsync();
		var module = await FindModuleAsync(opened.WorkspaceId);
		var options = await manager.GetModuleOptionsAsync(
			new ModuleOptionsRequest(opened.WorkspaceId, module.Id),
			TestContext.Current.CancellationToken);
		Assert.Equal("dnSpy.Backend.Tests.dll", options.Name);
		Assert.NotEqual(Guid.Empty.ToString("D"), options.Mvid);

		var mvid = "0f8fad5b-d9cb-469f-a165-70867728950e";
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.QueueModuleOptionsAsync(
			new SetModuleOptionsRequest(
				opened.WorkspaceId,
				transaction.TransactionId,
				module.Id,
				options with { Name = "renamed.dll", Mvid = mvid, RuntimeVersion = "v4.0.30319" }),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var edited = await manager.GetModuleOptionsAsync(
			new ModuleOptionsRequest(opened.WorkspaceId, module.Id),
			TestContext.Current.CancellationToken);
		Assert.Equal("renamed.dll", edited.Name);
		Assert.Equal(mvid, edited.Mvid);
		Assert.Equal("v4.0.30319", edited.RuntimeVersion);

		await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		var undone = await manager.GetModuleOptionsAsync(
			new ModuleOptionsRequest(opened.WorkspaceId, module.Id),
			TestContext.Current.CancellationToken);
		Assert.Equal("dnSpy.Backend.Tests.dll", undone.Name);
	}

	[Fact]
	public async Task RefusesAnEntryPointTheModuleDoesNotHold() {
		var opened = await OpenAsync();
		var module = await FindModuleAsync(opened.WorkspaceId);
		var options = await manager.GetModuleOptionsAsync(
			new ModuleOptionsRequest(opened.WorkspaceId, module.Id),
			TestContext.Current.CancellationToken);
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);

		await Assert.ThrowsAsync<RpcException>(() => manager.QueueModuleOptionsAsync(
			new SetModuleOptionsRequest(
				opened.WorkspaceId,
				transaction.TransactionId,
				module.Id,
				options with { ManagedEntryPoint = "06FFFFFF" }),
			TestContext.Current.CancellationToken));
	}

	async Task<OpenWorkspaceResponse> OpenAsync() => await manager.OpenAsync(
		new OpenWorkspaceRequest([typeof(WorkspaceAssemblyModuleOptionsTests).Assembly.Location]),
		TestContext.Current.CancellationToken);

	async Task<TreeNodeDto> FindModuleAsync(string workspaceId) {
		var root = Assert.Single(
			(await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).Nodes);
		return Assert.Single(
			(await manager.GetChildrenAsync(new NodeRequest(workspaceId, root.Id), TestContext.Current.CancellationToken)).Nodes,
			node => node.Kind == "module");
	}

	public void Dispose() => manager.Dispose();
}
