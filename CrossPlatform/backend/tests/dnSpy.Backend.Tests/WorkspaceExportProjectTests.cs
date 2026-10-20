using System.Xml.Linq;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// dnSpy's Export to Project as the GUI runs it: the modules the selection names, the dialog's options reaching the
/// projects and the solution, the workspace's unsaved edits in what is written, the progress and the error log a run
/// reports, and a Cancel that stops it. The exporter itself is dnSpy.Console's, which ConsoleTests covers in depth.
/// </summary>
public sealed class WorkspaceExportProjectTests : IDisposable {
	readonly WorkspaceManager manager = new();
	readonly List<string> paths = [];

	public void Dispose() {
		manager.Dispose();
		foreach (var path in paths) {
			try {
				if (Directory.Exists(path))
					Directory.Delete(path, recursive: true);
				else if (File.Exists(path))
					File.Delete(path);
			}
			catch (IOException) {
			}
		}
	}

	[Fact]
	public async Task TheSelectionNamesItsAssemblysModulesAndTheSolutionAfterIt() {
		var (workspaceId, root) = await OpenCopyAsync(typeof(SearchTarget.Library).Assembly.Location);
		var type = await FindTypeAsync(workspaceId, "Library");

		// A type row exports the assembly it is in, as dnSpy's GetAssemblyNode() makes it.
		var info = await manager.GetExportProjectInfoAsync(new ExportProjectInfoRequest(workspaceId, [type.Id]), TestContext.Current.CancellationToken);
		Assert.Equal([root.Description!], info.ModulePaths);
		Assert.Equal("SearchTarget.sln", info.SolutionFilename);
		Assert.False(info.DontReferenceStdLib);

		// The same module selected twice is exported once.
		var twice = await manager.GetExportProjectInfoAsync(new ExportProjectInfoRequest(workspaceId, [root.Id, type.Id]), TestContext.Current.CancellationToken);
		Assert.Single(twice.ModulePaths);
	}

	[Fact]
	public async Task AFileThatIsNoModuleHasNothingToExport() {
		var path = Temporary(".bin");
		await File.WriteAllBytesAsync(path, "just some bytes"u8.ToArray(), TestContext.Current.CancellationToken);
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
		var root = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Nodes);

		var info = await manager.GetExportProjectInfoAsync(new ExportProjectInfoRequest(opened.WorkspaceId, [root.Id]), TestContext.Current.CancellationToken);
		Assert.Empty(info.ModulePaths);
		await Assert.ThrowsAsync<RpcException>(() => manager.ExportProjectAsync(Request(opened.WorkspaceId, root.Id, Temporary("")), TestContext.Current.CancellationToken));
	}

	[Fact]
	public async Task ExportsAnSdkProjectAndSolutionAndReportsItsProgress() {
		var (workspaceId, root) = await OpenCopyAsync(typeof(SearchTarget.Library).Assembly.Location);
		var output = Temporary("");
		var progress = new List<ExportProjectProgressNotification>();
		manager.ExportProgressInterval = TimeSpan.FromMilliseconds(1);

		var response = await manager.ExportProjectAsync(
			Request(workspaceId, root.Id, output) with {
				UseSdkStyleProjectFormat = true,
				ProjectGuid = "11111111-2222-3333-4444-555555555555",
				ProgressToken = "token",
			},
			notification => { lock (progress) progress.Add(notification); return Task.CompletedTask; },
			TestContext.Current.CancellationToken);

		Assert.False(response.Canceled);
		Assert.Empty(response.Errors);
		var project = Path.Combine(output, "SearchTarget", "SearchTarget.csproj");
		Assert.Equal([project], response.ProjectFilenames);
		Assert.Equal(Path.Combine(output, "SearchTarget.sln"), response.SolutionFilename);
		// With a solution, it is the solution "open project" opens.
		Assert.Equal(response.SolutionFilename, response.FileToOpen);
		var document = XDocument.Load(project);
		Assert.Equal("Project", document.Root!.Name.LocalName);
		Assert.NotNull(document.Root.Attribute("Sdk"));
		Assert.Contains(document.Descendants(), element => element.Name.LocalName == "ProjectGuid" && element.Value == "{11111111-2222-3333-4444-555555555555}");
		Assert.NotEmpty(Directory.EnumerateFiles(Path.Combine(output, "SearchTarget"), "Library.cs", SearchOption.AllDirectories));
		var solution = await File.ReadAllTextAsync(response.SolutionFilename!, TestContext.Current.CancellationToken);
		Assert.Contains("# Visual Studio 2010", solution, StringComparison.Ordinal);
		Assert.Contains("{11111111-2222-3333-4444-555555555555}", solution, StringComparison.Ordinal);

		Assert.NotEmpty(progress);
		Assert.All(progress, notification => Assert.Equal("token", notification.ProgressToken));
		var last = progress[^1];
		Assert.Equal(last.MaxProgress, last.Progress);
		Assert.True(progress.Zip(progress.Skip(1)).All(pair => pair.First.Progress <= pair.Second.Progress), "The progress went backwards.");
	}

	[Fact]
	public async Task TheDialogsOptionsReachTheProjects() {
		var (workspaceId, root) = await OpenCopyAsync(typeof(SearchTarget.Library).Assembly.Location);
		var output = Temporary("");

		// No solution, a legacy project for VS2015 and Visual Basic.
		var response = await manager.ExportProjectAsync(
			Request(workspaceId, root.Id, output) with {
				SolutionFilename = null,
				ProjectVersion = "VS2015",
				Language = DecompilerLanguage.VisualBasic,
			},
			TestContext.Current.CancellationToken);

		Assert.False(response.Canceled);
		var project = Path.Combine(output, "SearchTarget", "SearchTarget.vbproj");
		Assert.Equal([project], response.ProjectFilenames);
		Assert.Null(response.SolutionFilename);
		Assert.Equal(project, response.FileToOpen);
		Assert.Empty(Directory.EnumerateFiles(output, "*.sln"));
		Assert.Equal("14.0", XDocument.Load(project).Root!.Attribute("ToolsVersion")?.Value);
		Assert.NotEmpty(Directory.EnumerateFiles(output, "*.vb", SearchOption.AllDirectories));
		Assert.Empty(Directory.EnumerateFiles(output, "*.cs", SearchOption.AllDirectories));
	}

	[Fact]
	public async Task AnUnsavedEditIsInTheExportedProject() {
		var (workspaceId, root) = await OpenCopyAsync(typeof(SearchTarget.Library).Assembly.Location);
		var type = await FindTypeAsync(workspaceId, "Library");
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), TestContext.Current.CancellationToken);
		await manager.QueueRenameAsync(new RenameEditRequest(workspaceId, transaction.TransactionId, type.Id, "RenamedLibrary"), TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);
		var output = Temporary("");

		var response = await manager.ExportProjectAsync(Request(workspaceId, type.Id, output), TestContext.Current.CancellationToken);

		Assert.False(response.Canceled);
		var renamed = Assert.Single(Directory.EnumerateFiles(output, "RenamedLibrary.cs", SearchOption.AllDirectories));
		Assert.Contains("class RenamedLibrary", await File.ReadAllTextAsync(renamed, TestContext.Current.CancellationToken), StringComparison.Ordinal);
		Assert.Empty(Directory.EnumerateFiles(output, "Library.cs", SearchOption.AllDirectories));
	}

	[Fact]
	public async Task CancelStopsTheExport() {
		// A module big enough that the export is still running when the first progress arrives.
		var (workspaceId, root) = await OpenCopyAsync(typeof(HelloRequest).Assembly.Location);
		var output = Temporary("");
		using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
		manager.ExportProgressInterval = TimeSpan.FromMilliseconds(1);

		var response = await manager.ExportProjectAsync(
			Request(workspaceId, root.Id, output) with { ProgressToken = "token" },
			async notification => {
				if (notification.Progress > 0)
					await cancellation.CancelAsync();
			},
			cancellation.Token);

		Assert.True(response.Canceled);
		Assert.Null(response.FileToOpen);
		Assert.False(File.Exists(Path.Combine(output, "dnSpy.Backend.Contracts.sln")));
	}

	[Fact]
	public async Task OnlyTheLanguagesWithAProjectFormatCanExport() {
		var (workspaceId, root) = await OpenCopyAsync(typeof(SearchTarget.Library).Assembly.Location);
		var error = await Assert.ThrowsAsync<RpcException>(() => manager.ExportProjectAsync(
			Request(workspaceId, root.Id, Temporary("")) with { Language = DecompilerLanguage.IL },
			TestContext.Current.CancellationToken));
		Assert.Equal(ErrorCodes.InvalidParams, error.Code);

		var badGuid = await Assert.ThrowsAsync<RpcException>(() => manager.ExportProjectAsync(
			Request(workspaceId, root.Id, Temporary("")) with { ProjectGuid = "not a guid" },
			TestContext.Current.CancellationToken));
		Assert.Equal(ErrorCodes.InvalidParams, badGuid.Code);
	}

	/// <summary>The dialog's defaults: dnSpy's ExportToProjectVM as it opens, with a folder.</summary>
	static ExportProjectRequest Request(string workspaceId, string nodeId, string directory) => new(
		workspaceId,
		[nodeId],
		directory,
		SolutionFilename: "SearchTarget.sln",
		ProjectVersion: "VS2010",
		UseSdkStyleProjectFormat: false,
		Language: DecompilerLanguage.CSharp,
		ProjectGuid: null,
		DontReferenceStdLib: false,
		UnpackResources: true,
		CreateResX: true,
		DecompileXaml: true);

	async Task<(string WorkspaceId, TreeNodeDto Root)> OpenCopyAsync(string assembly) {
		var directory = Temporary("");
		Directory.CreateDirectory(directory);
		var copy = Path.Combine(directory, Path.GetFileName(assembly));
		File.Copy(assembly, copy);
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([copy]), TestContext.Current.CancellationToken);
		var root = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Nodes);
		return (opened.WorkspaceId, root with { Description = copy });
	}

	async Task<TreeNodeDto> FindTypeAsync(string workspaceId, string name) {
		var root = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).Nodes);
		var module = Assert.Single((await manager.GetChildrenAsync(new NodeRequest(workspaceId, root.Id), TestContext.Current.CancellationToken)).Nodes, node => node.Kind == "module");
		var @namespace = Assert.Single((await manager.GetChildrenAsync(new NodeRequest(workspaceId, module.Id), TestContext.Current.CancellationToken)).Nodes, node => node.Label == "SearchTarget");
		return Assert.Single((await manager.GetChildrenAsync(new NodeRequest(workspaceId, @namespace.Id), TestContext.Current.CancellationToken)).Nodes, node => node.Label == name);
	}

	string Temporary(string extension) {
		var path = Path.Combine(Path.GetTempPath(), $"export-project-{Guid.NewGuid():N}{extension}");
		paths.Add(path);
		return path;
	}
}
