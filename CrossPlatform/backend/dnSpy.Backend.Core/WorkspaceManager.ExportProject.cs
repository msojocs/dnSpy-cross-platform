using System.Reflection.PortableExecutable;
using dnlib.DotNet;
using dnlib.DotNet.Writer;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.ProjectExport;
using ICSharpCode.Decompiler.Metadata;

namespace dnSpy.Backend.Core;

/// <summary>
/// dnSpy's Export to Project (dnSpy/Documents/Tabs/SaveCommands.cs, ExportProjectCommand): the modules the tree's
/// selection names are decompiled to a project each, with a solution beside them, by the exporter dnSpy.Console uses
/// too. What is exported is the workspace's own modules — an edit that has not been saved is in the projects — and
/// the export runs off the workspace's gate, so the tree stays usable while it goes, the way dnSpy runs it on a task.
/// </summary>
public sealed partial class WorkspaceManager {
	/// <summary>How often a running export tells the client how far it has got.</summary>
	internal TimeSpan ExportProgressInterval { get; set; } = TimeSpan.FromMilliseconds(100);

	public Task<ExportProjectInfoResponse> GetExportProjectInfoAsync(ExportProjectInfoRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetExportProjectInfo(request.NodeIds), cancellationToken);

	public Task<ExportProjectResponse> ExportProjectAsync(ExportProjectRequest request, CancellationToken cancellationToken) =>
		ExportProjectAsync(request, null, cancellationToken);

	public async Task<ExportProjectResponse> ExportProjectAsync(ExportProjectRequest request, Func<ExportProjectProgressNotification, Task>? progress, CancellationToken cancellationToken) {
		var options = CreateExportOptions(request);
		var workspace = GetWorkspace(request.WorkspaceId);
		var snapshots = await workspace.RunAsync(w => w.CreateExportSnapshots(request.NodeIds), cancellationToken).ConfigureAwait(false);
		var reporter = new ExportProgressReporter(progress is null ? null : request.ProgressToken);
		try {
			var exporter = new ProjectExporter(options, [.. snapshots.Select(snapshot => snapshot.Module)], reporter.Error, reporter);
			var canceled = false;
			var export = Task.Run(() => exporter.ExportAsync(cancellationToken), cancellationToken);
			if (reporter.ProgressToken is not null) {
				while (!export.IsCompleted) {
					await Task.WhenAny(export, Task.Delay(ExportProgressInterval, CancellationToken.None)).ConfigureAwait(false);
					if (reporter.TakeUpdate() is { } update)
						await progress!(update).ConfigureAwait(false);
				}
			}
			try {
				await export.ConfigureAwait(false);
			}
			catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) {
				canceled = true;
			}
			catch (Exception ex) {
				// dnSpy's ExportTask logs what escaped the creator as ErrorExceptionOccurred and shows the log.
				reporter.Error("An exception occurred\n\n" + ex);
			}
			var fileToOpen = exporter.SolutionFilename ?? exporter.ProjectFilenames.FirstOrDefault();
			return new ExportProjectResponse(canceled, reporter.AllErrors, exporter.ProjectFilenames, exporter.SolutionFilename, canceled ? null : fileToOpen);
		}
		finally {
			foreach (var snapshot in snapshots)
				snapshot.Dispose();
		}
	}

	/// <summary>The dialog's options as the exporter takes them. What the dialog validates is checked again here.</summary>
	static ProjectExportOptions CreateExportOptions(ExportProjectRequest request) {
		if (string.IsNullOrWhiteSpace(request.Directory))
			throw new RpcException(ErrorCodes.InvalidParams, "Missing destination folder.");
		var directory = Path.GetFullPath(request.Directory);
		if (File.Exists(directory))
			throw new RpcException(ErrorCodes.InvalidParams, "A file with the same name as the destination folder already exists.");
		if (request.SolutionFilename is not null && string.IsNullOrWhiteSpace(request.SolutionFilename))
			throw new RpcException(ErrorCodes.InvalidParams, "Missing filename");
		if (!Enum.TryParse<ProjectVersion>(request.ProjectVersion, ignoreCase: true, out var projectVersion) || !Enum.IsDefined(projectVersion))
			throw new RpcException(ErrorCodes.InvalidParams, $"Unknown project version '{request.ProjectVersion}'.");
		Guid? projectGuid = null;
		if (!string.IsNullOrWhiteSpace(request.ProjectGuid)) {
			if (!Guid.TryParse(request.ProjectGuid, out var parsed))
				throw new RpcException(ErrorCodes.InvalidParams, "Invalid GUID");
			projectGuid = parsed;
		}
		var language = request.Language switch {
			DecompilerLanguage.CSharp => ProjectExportLanguage.CSharp,
			DecompilerLanguage.VisualBasic => ProjectExportLanguage.VisualBasic,
			// dnSpy offers only the decompilers that have a ProjectFileExtension: IL has none.
			_ => throw new RpcException(ErrorCodes.InvalidParams, "Only C# and Visual Basic can be exported to a project."),
		};
		return new ProjectExportOptions {
			Directory = directory,
			SolutionFilename = request.SolutionFilename,
			ProjectVersion = projectVersion,
			SdkProject = request.UseSdkStyleProjectFormat,
			Language = language,
			ProjectGuid = projectGuid,
			AddCorlibReference = !request.DontReferenceStdLib,
			UnpackResources = request.UnpackResources,
			// dnSpy's CanCreateResX and CanDecompileBaml: neither applies to resources that are not unpacked.
			CreateResX = request.UnpackResources && request.CreateResX,
			DecompileBaml = request.UnpackResources && request.DecompileXaml,
			Settings = request.Settings.ToDecompilerSettings(),
			XamlOutput = request.Settings?.Baml,
		};
	}

	/// <summary>
	/// What the exporter is told and what it logs, gathered for the notifications a single loop sends: the latest
	/// progress (dnSpy's listener keeps only the largest value) and the errors since the last one.
	/// </summary>
	sealed class ExportProgressReporter(string? progressToken) : IProjectExportProgress {
		readonly object gate = new();
		readonly List<string> errors = [];
		int sentErrors;
		int maxProgress = 1;
		int progress;
		bool changed;

		public string? ProgressToken => progressToken;

		public IReadOnlyList<string> AllErrors {
			get {
				lock (gate)
					return [.. errors];
			}
		}

		public void Error(string message) {
			lock (gate) {
				errors.Add(message);
				changed = true;
			}
		}

		public void SetMaxProgress(int value) {
			lock (gate) {
				maxProgress = Math.Max(1, value);
				changed = true;
			}
		}

		public void SetProgress(int value) {
			lock (gate) {
				if (value <= progress)
					return;
				progress = value;
				changed = true;
			}
		}

		public ExportProjectProgressNotification? TakeUpdate() {
			lock (gate) {
				if (!changed || progressToken is null)
					return null;
				changed = false;
				var newErrors = errors.GetRange(sentErrors, errors.Count - sentErrors);
				sentErrors = errors.Count;
				return new ExportProjectProgressNotification(progressToken, Math.Min(progress, maxProgress), maxProgress, newErrors);
			}
		}
	}

	/// <summary>A module's file as the export reads it, and what has to be let go of afterwards.</summary>
	internal sealed class ExportSnapshot(ProjectExportModule module, IDisposable? owned) : IDisposable {
		public ProjectExportModule Module { get; } = module;

		public void Dispose() {
			Module.File.Dispose();
			Module.Module.Dispose();
			owned?.Dispose();
		}
	}

	sealed partial class Workspace {
		/// <summary>
		/// dnSpy's ExportProjectCommand.GetModules: every module of a selected node's assembly — a module row under an
		/// assembly counts as its assembly too — or the module itself when it stands alone. Rows of files that are not
		/// managed modules name nothing to export. The modules come in path order, the order dnSpy adds them in.
		/// </summary>
		List<ModuleEntry> GetExportModules(IReadOnlyList<string> nodeIds) {
			var modules = new List<ModuleEntry>();
			var seen = new HashSet<ModuleEntry>();
			foreach (var id in nodeIds) {
				if (nodes.GetValueOrDefault(id)?.AsModuleEntry is not { IsExternal: false } owner || !nodes.TryGetValue(owner.Id, out var root))
					continue;
				foreach (var entry in ModulesOfAssembly(root)) {
					if (seen.Add(entry))
						modules.Add(entry);
				}
			}
			return [.. modules.OrderBy(entry => entry.Path, StringComparer.InvariantCultureIgnoreCase)];
		}

		internal ExportProjectInfoResponse GetExportProjectInfo(IReadOnlyList<string> nodeIds) {
			var modules = GetExportModules(nodeIds);
			return new ExportProjectInfoResponse(
				[.. modules.Select(entry => entry.Path)],
				GetSolutionFilename(modules.Select(entry => entry.Module)),
				modules.Any(entry => entry.Module.Assembly is { } assembly && assembly.IsCorLib()));
		}

		/// <summary>dnSpy's GetSolutionFilename: named after the first exe, else the first dll, else "solution".</summary>
		static string GetSolutionFilename(IEnumerable<ModuleDef> modules) {
			foreach (var module in modules.OrderBy(module => (module.Characteristics & dnlib.PE.Characteristics.Dll) == 0 ? 0 : 1)) {
				var name = module.IsManifestModule && module.Assembly is not null ? GetSolutionName(module.Assembly.Name) : GetSolutionName(module.Name);
				if (!string.IsNullOrWhiteSpace(name))
					return name;
			}
			// Here if eg. assembly name is empty
			return GetSolutionName("solution")!;
		}

		static string? GetSolutionName(string name) {
			if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
				name = name[..^4];
			else if (name.EndsWith(".netmodule", StringComparison.OrdinalIgnoreCase))
				name = name[..^10];
			if (!string.IsNullOrWhiteSpace(name))
				return name + ".sln";
			return null;
		}

		/// <summary>
		/// The files the export reads, taken while the gate is held so that an edit cannot land halfway through one.
		/// A module as it was read — with the bytes the hex editor wrote over it — is its file; a module with edits,
		/// or one that only exists in the workspace, is written out by dnlib first, the way the C# view's snapshot is.
		/// </summary>
		internal List<ExportSnapshot> CreateExportSnapshots(IReadOnlyList<string> nodeIds) {
			var modules = GetExportModules(nodeIds);
			if (modules.Count == 0)
				throw new RpcException(ErrorCodes.NodeNotFound, "The selection names no module that can be exported.");
			var snapshots = new List<ExportSnapshot>();
			try {
				foreach (var entry in modules)
					snapshots.Add(CreateExportSnapshot(entry));
				return snapshots;
			}
			catch {
				foreach (var snapshot in snapshots)
					snapshot.Dispose();
				throw;
			}
		}

		static ExportSnapshot CreateExportSnapshot(ModuleEntry entry) {
			MemoryStream stream;
			if (!entry.HasModelEdits && !entry.InMemory) {
				var bytes = File.ReadAllBytes(entry.Path);
				entry.OverlayHexPatches(0, bytes);
				stream = new MemoryStream(bytes, writable: false);
			}
			else {
				stream = new MemoryStream();
				var writerOptions = new ModuleWriterOptions(entry.Module);
				writerOptions.MetadataOptions.Flags |= MetadataFlags.PreserveRids;
				entry.Module.Write(stream, writerOptions);
				if (entry.HexPatches.Count > 0) {
					var copy = new MemoryStream(stream.ToArray(), writable: false);
					using (var snapshotModule = ModuleDefMD.Load(copy))
						WriteHexPatches(stream, entry.ResolveHexPatchOffsets(snapshotModule));
				}
				stream.Position = 0;
			}
			PEFile? file = null;
			ModuleDefMD? module = null;
			try {
				// The project creator reads the types, resources and Win32 resources from dnlib's view of the same bytes,
				// resolving base types and references the way the workspace's module does.
				module = ModuleDefMD.Load(stream.ToArray(), entry.Module.Context);
				module.Location = entry.Path;
				file = new PEFile(entry.Path, stream, PEStreamOptions.PrefetchEntireImage);
				var resolver = GacFallbackAssemblyResolver.Create(entry.Path, file, throwOnError: false);
				return new ExportSnapshot(new ProjectExportModule(entry.Path, file, module, resolver, resolver), stream);
			}
			catch {
				file?.Dispose();
				module?.Dispose();
				stream.Dispose();
				throw;
			}
		}
	}
}
