using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

public sealed class WorkspaceResourceEditingTests : IDisposable {
	readonly WorkspaceManager manager = new();

	[Fact]
	public async Task CreatesAFileResourceAndUndoRemovesItAgain() {
		var opened = await OpenAsync();
		var resources = await FindResourcesFolderAsync(opened.WorkspaceId);

		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		var created = await manager.CreateResourceAsync(
			new CreateResourceRequest(
				opened.WorkspaceId,
				transaction.TransactionId,
				resources.Id,
				ResourceCreateKinds.File,
				"new-file.txt",
				1,
				Base64("hello")),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var children = await ChildrenAsync(opened.WorkspaceId, resources.Id);
		var resource = Assert.Single(children, node => node.Id == created.NodeId);
		Assert.Equal("new-file.txt", resource.Label);
		Assert.Equal("resource", resource.Kind);

		await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		children = await ChildrenAsync(opened.WorkspaceId, resources.Id);
		Assert.DoesNotContain(children, node => node.Id == created.NodeId);

		await manager.RedoAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		children = await ChildrenAsync(opened.WorkspaceId, resources.Id);
		Assert.Contains(children, node => node.Id == created.NodeId);
	}

	[Fact]
	public async Task EditsAResourcesFileNameAndVisibility() {
		var opened = await OpenAsync();
		var resources = await FindResourcesFolderAsync(opened.WorkspaceId);
		var created = await CreateResourcesFileAsync(opened.WorkspaceId, resources.Id, "app.resources", ("Greeting", "hello"));

		var options = await manager.GetResourceOptionsAsync(
			new ResourceOptionsRequest(opened.WorkspaceId, created.NodeId),
			TestContext.Current.CancellationToken);
		Assert.Equal(ManifestResourceKinds.Embedded, options.Kind);
		Assert.Equal("app.resources", options.Name);
		Assert.Empty(options.CustomAttributes);

		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.QueueResourceOptionsAsync(
			new SetResourceOptionsRequest(opened.WorkspaceId, transaction.TransactionId, created.NodeId, options with { Name = "renamed.resources", Attributes = 2 }),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var renamed = await manager.GetResourceOptionsAsync(
			new ResourceOptionsRequest(opened.WorkspaceId, created.NodeId),
			TestContext.Current.CancellationToken);
		Assert.Equal("renamed.resources", renamed.Name);
		Assert.Equal(2, renamed.Attributes & 3);

		await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		var restored = await manager.GetResourceOptionsAsync(
			new ResourceOptionsRequest(opened.WorkspaceId, created.NodeId),
			TestContext.Current.CancellationToken);
		Assert.Equal("app.resources", restored.Name);
	}

	[Fact]
	public async Task AddsEditsAndDeletesAResourcesEntry() {
		var opened = await OpenAsync();
		var resources = await FindResourcesFolderAsync(opened.WorkspaceId);
		var created = await CreateResourcesFileAsync(opened.WorkspaceId, resources.Id, "entries.resources", ("first", "hello"));

		var entry = Assert.Single(await ChildrenAsync(opened.WorkspaceId, created.NodeId));
		Assert.Equal("first", entry.Label);

		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.QueueCreateResourceElementAsync(
			new CreateResourceElementRequest(opened.WorkspaceId, transaction.TransactionId, created.NodeId, ResourceElementKinds.String, "second", "world"),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var entries = await ChildrenAsync(opened.WorkspaceId, created.NodeId);
		Assert.Equal(2, entries.Count);
		var second = Assert.Single(entries, node => node.Label == "second");
		var secondOptions = await manager.GetResourceElementOptionsAsync(
			new ResourceElementOptionsRequest(opened.WorkspaceId, second.Id),
			TestContext.Current.CancellationToken);
		Assert.Equal(ResourceElementKinds.String, secondOptions.Kind);
		Assert.Equal("world", secondOptions.Text);

		transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.QueueResourceElementOptionsAsync(
			new SetResourceElementOptionsRequest(
				opened.WorkspaceId,
				transaction.TransactionId,
				second.Id,
				secondOptions with { Name = "renamed", Text = "changed" }),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		entries = await ChildrenAsync(opened.WorkspaceId, created.NodeId);
		Assert.Contains(entries, node => node.Label == "renamed");
		Assert.DoesNotContain(entries, node => node.Label == "second");
		var renamed = Assert.Single(entries, node => node.Label == "renamed");
		var renamedOptions = await manager.GetResourceElementOptionsAsync(
			new ResourceElementOptionsRequest(opened.WorkspaceId, renamed.Id),
			TestContext.Current.CancellationToken);
		Assert.Equal("changed", renamedOptions.Text);

		transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.QueueDeleteAsync(
			new DeleteEditRequest(opened.WorkspaceId, transaction.TransactionId, renamed.Id),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		entries = await ChildrenAsync(opened.WorkspaceId, created.NodeId);
		Assert.Single(entries);
		Assert.Equal("first", entries[0].Label);

		await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		entries = await ChildrenAsync(opened.WorkspaceId, created.NodeId);
		Assert.Contains(entries, node => node.Label == "renamed");
	}

	[Fact]
	public async Task AddsAStringEntryToAnExistingResourcesFile() {
		var opened = await OpenAsync();
		var resources = await FindResourcesFolderAsync(opened.WorkspaceId);
		var created = await CreateResourcesFileAsync(opened.WorkspaceId, resources.Id, "strings.resources", ("A", "1"));

		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.QueueCreateResourceElementAsync(
			new CreateResourceElementRequest(opened.WorkspaceId, transaction.TransactionId, created.NodeId, ResourceElementKinds.Int32, "answer", Text: "42"),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var entries = await ChildrenAsync(opened.WorkspaceId, created.NodeId);
		var answer = Assert.Single(entries, node => node.Label == "answer");
		var options = await manager.GetResourceElementOptionsAsync(
			new ResourceElementOptionsRequest(opened.WorkspaceId, answer.Id),
			TestContext.Current.CancellationToken);
		Assert.Equal(ResourceElementKinds.Int32, options.Kind);
		Assert.Equal("42", options.Text);
	}

	[Fact]
	public async Task CreatesLinkedResources() {
		var opened = await OpenAsync();
		var resources = await FindResourcesFolderAsync(opened.WorkspaceId);

		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		var assemblyLinked = await manager.CreateResourceAsync(
			new CreateResourceRequest(
				opened.WorkspaceId,
				transaction.TransactionId,
				resources.Id,
				ResourceCreateKinds.AssemblyLinked,
				"linked.assembly",
				1,
				AssemblyFullName: "System.Runtime, Version=10.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a"),
			TestContext.Current.CancellationToken);
		var fileLinked = await manager.CreateResourceAsync(
			new CreateResourceRequest(
				opened.WorkspaceId,
				transaction.TransactionId,
				resources.Id,
				ResourceCreateKinds.FileLinked,
				"linked.file",
				1,
				LinkedFileName: "linked.dat"),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var assemblyOptions = await manager.GetResourceOptionsAsync(
			new ResourceOptionsRequest(opened.WorkspaceId, assemblyLinked.NodeId),
			TestContext.Current.CancellationToken);
		Assert.Equal(ManifestResourceKinds.AssemblyLinked, assemblyOptions.Kind);
		Assert.Contains("System.Runtime", assemblyOptions.AssemblyFullName, StringComparison.Ordinal);

		var fileOptions = await manager.GetResourceOptionsAsync(
			new ResourceOptionsRequest(opened.WorkspaceId, fileLinked.NodeId),
			TestContext.Current.CancellationToken);
		Assert.Equal(ManifestResourceKinds.Linked, fileOptions.Kind);
		Assert.Equal("linked.dat", fileOptions.LinkedFileName);
	}

	/// <summary>
	/// Creates a .resources file with one string entry, the way the Create Multi File Resource command
	/// does, and answers the row it ends up on.
	/// </summary>
	async Task<CreateResourceResponse> CreateResourcesFileAsync(string workspaceId, string resourcesNodeId, string name, params (string Name, string Text)[] entries) {
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), TestContext.Current.CancellationToken);
		var created = await manager.CreateResourceAsync(
			new CreateResourceRequest(
				workspaceId,
				transaction.TransactionId,
				resourcesNodeId,
				ResourceCreateKinds.MultiFile,
				name,
				1),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);
		foreach (var (entryName, text) in entries) {
			transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), TestContext.Current.CancellationToken);
			await manager.QueueCreateResourceElementAsync(
				new CreateResourceElementRequest(workspaceId, transaction.TransactionId, created.NodeId, ResourceElementKinds.String, entryName, text),
				TestContext.Current.CancellationToken);
			await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);
		}
		return created;
	}

	static string Base64(string text) => Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(text));

	async Task<OpenWorkspaceResponse> OpenAsync() => await manager.OpenAsync(
		new OpenWorkspaceRequest([typeof(WorkspaceResourceEditingTests).Assembly.Location]),
		TestContext.Current.CancellationToken);

	async Task<IReadOnlyList<TreeNodeDto>> ChildrenAsync(string workspaceId, string nodeId) =>
		(await manager.GetChildrenAsync(new NodeRequest(workspaceId, nodeId), TestContext.Current.CancellationToken)).Nodes;

	async Task<TreeNodeDto> FindResourcesFolderAsync(string workspaceId) {
		var root = Assert.Single(
			(await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).Nodes);
		var module = Assert.Single(await ChildrenAsync(workspaceId, root.Id), node => node.Kind == "module");
		return Assert.Single(await ChildrenAsync(workspaceId, module.Id), node => node.Kind == "resourcesgroup");
	}

	public void Dispose() => manager.Dispose();
}
