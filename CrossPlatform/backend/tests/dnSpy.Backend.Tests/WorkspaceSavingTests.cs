using dnlib.DotNet;
using dnlib.PE;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// dnSpy's DocumentSaver and its undo service's saved state: a document is modified until it is saved, and again
/// when an undo or a redo takes it away from where it was saved; a document whose only changes are bytes is written
/// as its file with the bytes on it; the Save Module window's options reach the writer; and a run reports its
/// progress and can be stopped.
/// </summary>
public sealed class WorkspaceSavingTests : IDisposable {
	readonly WorkspaceManager manager = new();
	readonly List<string> files = [];

	[Fact]
	public async Task ADocumentIsModifiedUntilItIsBackWhereItWasSaved() {
		var (workspaceId, root) = await OpenCopyAsync();
		Assert.Empty(await ModifiedAsync(workspaceId));

		var committed = await RenameAsync(workspaceId, await FindTypeAsync(workspaceId, "Library"), "Renamed");
		Assert.Equal([root.Id], committed.ModifiedDocuments!.Select(document => document.Id));

		// Undoing back to the state it was read in leaves nothing to save, and redoing the edit brings it back.
		Assert.Empty((await manager.UndoAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).ModifiedDocuments!);
		Assert.Single((await manager.RedoAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).ModifiedDocuments!);

		var saved = await SaveAsync(workspaceId, root.Id, Temporary(".dll"));
		Assert.True(Assert.Single(saved.Results).Saved);
		Assert.Empty(saved.ModifiedDocuments);

		// The save point is after the edit now: undoing it is a change from what was saved, redoing it is not.
		Assert.Single((await manager.UndoAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).ModifiedDocuments!);
		Assert.Empty((await manager.RedoAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).ModifiedDocuments!);
	}

	[Fact]
	public async Task ADocumentWithOnlyBytesWrittenOverItIsSavedAsTheFileWithThem() {
		var (workspaceId, root) = await OpenCopyAsync();
		var module = await FindModuleAsync(workspaceId, root.Id);
		// The DOS stub's message, which nothing in the module reads.
		var original = await File.ReadAllBytesAsync(root.Description!, TestContext.Current.CancellationToken);
		var offset = IndexOf(original, "This program"u8.ToArray());
		Assert.True(offset > 0);
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), TestContext.Current.CancellationToken);
		await manager.QueueHexPatchAsync(new HexPatchRequest(workspaceId, transaction.TransactionId, module.Id, offset, Convert.ToBase64String("THAT"u8.ToArray())), TestContext.Current.CancellationToken);
		var committed = await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var document = Assert.Single(committed.ModifiedDocuments!);
		Assert.True(document.IsHexDocument);
		var options = await manager.GetSaveOptionsAsync(new SaveOptionsRequest(workspaceId, document.Id), TestContext.Current.CancellationToken);
		Assert.True(options.IsHexDocument);
		Assert.Null(options.Writer);

		var target = Temporary(".dll");
		var saved = await SaveAsync(workspaceId, document.Id, target);
		Assert.True(Assert.Single(saved.Results).Saved);
		var written = await File.ReadAllBytesAsync(target, TestContext.Current.CancellationToken);
		var expected = original.ToArray();
		"THAT"u8.CopyTo(expected.AsSpan((int)offset));
		Assert.Equal(expected, written);
	}

	[Fact]
	public async Task AFileThatIsNoModuleIsEditedByteWiseAndSavedInPlace() {
		var path = Temporary(".bin");
		await File.WriteAllBytesAsync(path, "just some bytes"u8.ToArray(), TestContext.Current.CancellationToken);
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
		var workspaceId = opened.WorkspaceId;
		var root = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).Nodes);

		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), TestContext.Current.CancellationToken);
		await manager.QueueHexPatchAsync(new HexPatchRequest(workspaceId, transaction.TransactionId, root.Id, 5, Convert.ToBase64String("SOME"u8.ToArray())), TestContext.Current.CancellationToken);
		var committed = await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);
		Assert.True(Assert.Single(committed.ModifiedDocuments!).IsHexDocument);
		Assert.Equal("just SOME bytes", await ReadAllAsync(workspaceId, root.Id));
		// Nothing is written until the document is saved.
		Assert.Equal("just some bytes", await File.ReadAllTextAsync(path, TestContext.Current.CancellationToken));

		var saved = await SaveAsync(workspaceId, root.Id, path);
		Assert.True(Assert.Single(saved.Results).Saved);
		Assert.Empty(saved.ModifiedDocuments);
		Assert.Equal("just SOME bytes", await File.ReadAllTextAsync(path, TestContext.Current.CancellationToken));

		// Undoing the write after the save shows the bytes it replaced again, and the document is modified.
		var undone = await manager.UndoAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken);
		Assert.Single(undone.ModifiedDocuments!);
		Assert.Equal("just some bytes", await ReadAllAsync(workspaceId, root.Id));
		await SaveAsync(workspaceId, root.Id, path);
		Assert.Equal("just some bytes", await File.ReadAllTextAsync(path, TestContext.Current.CancellationToken));
	}

	async Task<string> ReadAllAsync(string workspaceId, string documentId) {
		var read = await manager.ReadHexAsync(new HexReadRequest(workspaceId, documentId, 0, 1024), TestContext.Current.CancellationToken);
		return System.Text.Encoding.ASCII.GetString(Convert.FromBase64String(read.Base64Data));
	}

	[Fact]
	public async Task TheWindowsOptionsReachTheWriter() {
		var (workspaceId, root) = await OpenCopyAsync();
		var options = await manager.GetSaveOptionsAsync(new SaveOptionsRequest(workspaceId, root.Id), TestContext.Current.CancellationToken);
		Assert.False(options.IsHexDocument);
		Assert.Equal(root.Description, options.FileName);
		var writer = options.Writer!;
		Assert.False(writer.UseMixedMode);
		Assert.Equal((int)ModuleKind.Dll, writer.ModuleKind);

		var target = Temporary(".dll");
		var saved = await manager.SaveDocumentsAsync(
			new SaveDocumentsRequest(workspaceId, [new SaveDocumentDto(root.Id, target, writer with {
				TimeDateStamp = 0x12345678,
				Machine = (ushort)Machine.AMD64,
				MajorLinkerVersion = 99,
				MetadataVersionString = "v4.0.99999",
			})]),
			null,
			TestContext.Current.CancellationToken);
		Assert.True(Assert.Single(saved.Results).Saved);

		using var image = new PEImage(target);
		Assert.Equal(0x12345678u, image.ImageNTHeaders.FileHeader.TimeDateStamp);
		Assert.Equal(Machine.AMD64, image.ImageNTHeaders.FileHeader.Machine);
		Assert.Equal(99, image.ImageNTHeaders.OptionalHeader.MajorLinkerVersion);
		using var written = ModuleDefMD.Load(target);
		Assert.Equal("v4.0.99999", written.Metadata.VersionString);
	}

	[Fact]
	public async Task ARunReportsItsProgressAndTheFilesItWrote() {
		var (workspaceId, root) = await OpenCopyAsync();
		await RenameAsync(workspaceId, await FindTypeAsync(workspaceId, "Library"), "Renamed");
		var progress = new List<SaveDocumentsProgressNotification>();
		var target = Temporary(".dll");
		var saved = await manager.SaveDocumentsAsync(
			new SaveDocumentsRequest(workspaceId, [new SaveDocumentDto(root.Id, target)], "token"),
			notification => { lock (progress) progress.Add(notification); return Task.CompletedTask; },
			TestContext.Current.CancellationToken);

		var result = Assert.Single(saved.Results);
		Assert.True(result.Saved);
		Assert.Equal(target, result.FileName);
		Assert.Equal($"Writing {target}...", result.Log[0]);
		Assert.Equal(0, result.ErrorCount);
		Assert.False(saved.Canceled);
		Assert.NotEmpty(progress);
		Assert.All(progress, notification => Assert.Equal("token", notification.ProgressToken));
		Assert.Equal(1, progress[^1].TotalProgress, 3);
		using var written = ModuleDefMD.Load(target);
		Assert.NotNull(written.Find("SearchTarget.Renamed", isReflectionName: false));
	}

	[Fact]
	public async Task ACancelledRunLeavesNoFileBehind() {
		var (workspaceId, root) = await OpenCopyAsync();
		using var cancellation = new CancellationTokenSource();
		var target = Temporary(".dll");
		var saved = await manager.SaveDocumentsAsync(
			new SaveDocumentsRequest(workspaceId, [new SaveDocumentDto(root.Id, target)], "token"),
			_ => cancellation.CancelAsync(),
			cancellation.Token);

		Assert.True(saved.Canceled);
		Assert.False(Assert.Single(saved.Results).Saved);
		Assert.False(File.Exists(target));
		Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(target)!, $".{Path.GetFileName(target)}.*.tmp"));
	}

	[Fact]
	public async Task AFileThatCannotBeWrittenIsReportedAndTheRunGoesOn() {
		var (workspaceId, root) = await OpenCopyAsync();
		var missingFolder = Path.Combine(Path.GetTempPath(), $"missing-{Guid.NewGuid():N}", "A.dll");
		var target = Temporary(".dll");
		var saved = await manager.SaveDocumentsAsync(
			new SaveDocumentsRequest(workspaceId, [new SaveDocumentDto(root.Id, missingFolder), new SaveDocumentDto(root.Id, target)]),
			null,
			TestContext.Current.CancellationToken);

		Assert.False(saved.Results[0].Saved);
		Assert.NotNull(saved.Results[0].Error);
		Assert.True(saved.Results[1].Saved);
	}

	async Task<(string WorkspaceId, TreeNodeDto Root)> OpenCopyAsync() {
		var copy = Temporary(".dll");
		File.Copy(typeof(SearchTarget.Library).Assembly.Location, copy);
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([copy]), TestContext.Current.CancellationToken);
		var root = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Nodes);
		return (opened.WorkspaceId, root with { Description = copy });
	}

	async Task<IReadOnlyList<ModifiedDocumentDto>> ModifiedAsync(string workspaceId) =>
		(await manager.GetModifiedDocumentsAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).Documents;

	async Task<EditCommitResponse> RenameAsync(string workspaceId, TreeNodeDto node, string name) {
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), TestContext.Current.CancellationToken);
		await manager.QueueRenameAsync(new RenameEditRequest(workspaceId, transaction.TransactionId, node.Id, name), TestContext.Current.CancellationToken);
		return await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);
	}

	Task<SaveDocumentsResponse> SaveAsync(string workspaceId, string documentId, string fileName) =>
		manager.SaveDocumentsAsync(new SaveDocumentsRequest(workspaceId, [new SaveDocumentDto(documentId, fileName)]), null, TestContext.Current.CancellationToken);

	async Task<TreeNodeDto> FindModuleAsync(string workspaceId, string rootId) =>
		Assert.Single((await manager.GetChildrenAsync(new NodeRequest(workspaceId, rootId), TestContext.Current.CancellationToken)).Nodes, node => node.Kind == "module");

	async Task<TreeNodeDto> FindTypeAsync(string workspaceId, string name) {
		var root = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).Nodes);
		var module = await FindModuleAsync(workspaceId, root.Id);
		var @namespace = Assert.Single((await manager.GetChildrenAsync(new NodeRequest(workspaceId, module.Id), TestContext.Current.CancellationToken)).Nodes, node => node.Label == "SearchTarget");
		return Assert.Single((await manager.GetChildrenAsync(new NodeRequest(workspaceId, @namespace.Id), TestContext.Current.CancellationToken)).Nodes, node => node.Label == name);
	}

	string Temporary(string extension) {
		var path = Path.Combine(Path.GetTempPath(), $"saving-{Guid.NewGuid():N}{extension}");
		files.Add(path);
		return path;
	}

	static long IndexOf(byte[] data, byte[] pattern) {
		for (var i = 0; i + pattern.Length <= data.Length; i++) {
			if (data.AsSpan(i, pattern.Length).SequenceEqual(pattern))
				return i;
		}
		return -1;
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
