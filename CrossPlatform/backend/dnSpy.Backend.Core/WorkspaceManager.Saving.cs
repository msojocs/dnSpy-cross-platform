using System.Security.Cryptography;
using dnlib.DotNet;
using dnlib.DotNet.MD;
using dnlib.DotNet.Writer;
using dnlib.PE;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core;

/// <summary>
/// dnSpy's DocumentSaver and the undo service's saved state: which documents have unsaved changes, the options
/// a document is written with, and the run that writes one or several of them with progress, a log and a way
/// to stop it — the work behind the Save Module and Save Modules windows.
/// </summary>
public sealed partial class WorkspaceManager {
	public Task<ModifiedDocumentsResponse> GetModifiedDocumentsAsync(WorkspaceRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => new ModifiedDocumentsResponse(w.GetModifiedDocuments()), cancellationToken);

	public Task<DocumentSaveOptionsDto> GetSaveOptionsAsync(SaveOptionsRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetSaveOptions(request.DocumentId, request.UseMixedMode), cancellationToken);

	public Task<SaveDocumentsResponse> SaveDocumentsAsync(SaveDocumentsRequest request, Func<SaveDocumentsProgressNotification, Task>? progress, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.SaveDocumentsAsync(request, progress, cancellationToken), cancellationToken);

	sealed partial class Workspace {
		// dnSpy's command counter: every undo step gets the next value when it is made, and keeps it through undo
		// and redo, so a saved state can name the step it was taken at. 0 is the state a document was read in.
		long nextHistoryId = 1;

		/// <summary>
		/// The newest step of the undo history that changed the document, or 0 when none did — the state the
		/// document was read in. A removal recorded in the history takes part without changing anything.
		/// </summary>
		long NewestStepChanging(IModuleEntry entry) {
			foreach (var step in undoHistory) {
				if (step.Operations.Any(operation => operation.Modifies && ReferenceEquals(operation.Module, entry)))
					return step.Id;
			}
			return 0;
		}

		/// <summary>dnSpy's IUndoCommandService.IsModified: the document is not at the step it was saved at.</summary>
		bool IsModified(IModuleEntry entry) => NewestStepChanging(entry) != entry.SavedHistoryId;

		/// <summary>dnSpy's MarkAsSaved: the step the document is at now is the one it was saved at.</summary>
		void MarkAsSaved(IModuleEntry entry) => entry.SavedHistoryId = NewestStepChanging(entry);

		static bool IsInMemory(IModuleEntry entry) => entry is ModuleEntry { InMemory: true };

		/// <summary>
		/// Every document that can be saved, in the order the tree shows them: the roots, each followed by the net
		/// modules of its assembly — dnSpy keeps every module of an assembly as a document of its own.
		/// </summary>
		IEnumerable<IModuleEntry> DocumentEntries() {
			foreach (var entry in OrderedEntries()) {
				yield return entry;
				if (entry is ModuleEntry)
					foreach (var netModule in netModules.Values.Where(netModule => netModule.Id == entry.Id))
						yield return netModule;
			}
		}

		/// <summary>The id a document is named by: a root's own, or the module row of a net module.</summary>
		string DocumentIdOf(IModuleEntry entry) {
			if (entry is ModuleEntry module && !ReferenceEquals(RootEntry(module.Id), module))
				return GetOrAddNode($"module:{module.Path}", NodeKind.Module, module.Module, module).Id;
			return entry.Id;
		}

		/// <summary>The document an id names — a root, a net module's row, or any row inside either.</summary>
		IModuleEntry GetSaveableDocument(string documentId) {
			if (RootEntry(documentId) is { } root)
				return root;
			if (nodes.TryGetValue(documentId, out var node) && node.Module is IModuleEntry entry)
				return entry;
			throw new RpcException(ErrorCodes.NodeNotFound, "The document is no longer open.");
		}

		static string DocumentName(IModuleEntry entry) => entry switch {
			ModuleEntry module => module.Module.Name.String is { Length: > 0 } name ? name : Path.GetFileName(module.Path),
			_ => Path.GetFileName(entry.Path),
		};

		ModifiedDocumentDto ToModifiedDocument(IModuleEntry entry) =>
			new(DocumentIdOf(entry), DocumentName(entry), IsInMemory(entry) ? string.Empty : entry.Path, IsInMemory(entry), SavesAsBytes(entry));

		public IReadOnlyList<ModifiedDocumentDto> GetModifiedDocuments() =>
			DocumentEntries().Where(IsModified).Select(ToModifiedDocument).ToArray();

		/// <summary>
		/// Whether the document is saved the way dnSpy saves a hex buffer — the file's own bytes with the patches
		/// written over them — rather than through dnlib's writer. A file that is no managed module only has bytes;
		/// a module does when every change it carries is a patch and the file is still the one it was read from,
		/// which is what the patches were measured against.
		/// </summary>
		bool SavesAsBytes(IModuleEntry entry) => entry switch {
			ModuleEntry module => !module.InMemory && !module.FileRewritten && module.HexPatches.Count > 0 && !HasAppliedModelEdits(module),
			_ => true,
		};

		bool HasAppliedModelEdits(ModuleEntry module) =>
			undoHistory.Any(step => step.Operations.Any(operation => operation.Modifies && !operation.IsHexPatch && ReferenceEquals(operation.Module, module)));

		// ---------------------------------------------------------------- writer options

		/// <summary>
		/// What the Save Module window opens with: dnlib's own options for the module — the native writer's for a
		/// mixed-mode module — and the file it came from. dnSpy's SaveModuleOptionsVM reads them the same way.
		/// </summary>
		public DocumentSaveOptionsDto GetSaveOptions(string documentId, bool? useMixedMode) {
			var entry = GetSaveableDocument(documentId);
			var fileName = IsInMemory(entry) ? string.Empty : entry.Path;
			if (entry is not ModuleEntry module || SavesAsBytes(entry))
				return new DocumentSaveOptionsDto(DocumentIdOf(entry), DocumentName(entry), fileName, true, false, false, false, null);
			var isMixedMode = IsMixedModeModule(module);
			var canUseMixedMode = !module.InMemory;
			var mixed = canUseMixedMode && (useMixedMode ?? isMixedMode);
			return new DocumentSaveOptionsDto(
				DocumentIdOf(entry),
				DocumentName(entry),
				fileName,
				false,
				module.Module.PdbState is not null,
				canUseMixedMode,
				isMixedMode,
				CreateDefaultWriterOptions(module, mixed));
		}

		/// <summary>dnSpy's IsMixedModeModule: a module that is not IL only carries native code.</summary>
		static bool IsMixedModeModule(ModuleEntry module) => !module.Module.IsILOnly;

		static WriterOptionsDto CreateDefaultWriterOptions(ModuleEntry module, bool mixedMode) {
			ModuleWriterOptionsBase options = mixedMode
				? new NativeModuleWriterOptions(module.Module, optimizeImageSize: true)
				: new ModuleWriterOptions(module.Module);
			var dto = ToDto(options, module.Module);
			// dnSpy turns the PDB on whenever there is one to write.
			return dto with { WritePdb = module.Module.PdbState is not null };
		}

		static WriterOptionsDto ToDto(ModuleWriterOptionsBase options, ModuleDef module) {
			var pe = options.PEHeadersOptions;
			var cor20 = options.Cor20HeaderOptions;
			var header = options.MetadataOptions.MetadataHeaderOptions;
			var tables = options.MetadataOptions.TablesHeapOptions;
			var native = options as NativeModuleWriterOptions;
			return new WriterOptionsDto(
				native is not null,
				options.WritePdb,
				options.ShareMethodBodies,
				(int)options.ModuleKind,
				options.AddCheckSum,
				options.AddMvidSection,
				native?.KeepExtraPEData ?? false,
				native?.KeepWin32Resources ?? false,
				(uint)options.MetadataOptions.Flags,
				false,
				header.Signature,
				header.MajorVersion,
				header.MinorVersion,
				header.Reserved1,
				header.VersionString,
				(byte?)header.StorageFlags,
				header.Reserved2,
				tables.Reserved1,
				tables.MajorVersion,
				tables.MinorVersion,
				tables.UseENC,
				tables.ForceBigColumns,
				tables.ExtraData,
				tables.Log2Rid,
				tables.HasDeletedRows,
				cor20.MajorRuntimeVersion,
				cor20.MinorRuntimeVersion,
				(uint?)cor20.Flags,
				cor20.EntryPoint,
				(ushort)(pe.Machine ?? module.Machine),
				(ushort)(pe.Subsystem ?? (options.ModuleKind == ModuleKind.Windows ? Subsystem.WindowsGui : Subsystem.WindowsCui)),
				pe.TimeDateStamp,
				pe.PointerToSymbolTable,
				pe.NumberOfSymbols,
				(ushort?)pe.Characteristics,
				pe.MajorLinkerVersion,
				pe.MinorLinkerVersion,
				pe.ImageBase,
				pe.SectionAlignment,
				pe.FileAlignment,
				pe.MajorOperatingSystemVersion,
				pe.MinorOperatingSystemVersion,
				pe.MajorImageVersion,
				pe.MinorImageVersion,
				pe.MajorSubsystemVersion,
				pe.MinorSubsystemVersion,
				pe.Win32VersionValue,
				(ushort?)pe.DllCharacteristics,
				pe.SizeOfStackReserve,
				pe.SizeOfStackCommit,
				pe.SizeOfHeapReserve,
				pe.SizeOfHeapCommit,
				pe.LoaderFlags,
				pe.NumberOfRvaAndSizes);
		}

		/// <summary>
		/// The writer options a save runs with — dnSpy's SaveModuleOptionsVM.CreateWriterOptions: dnlib's own for
		/// the module, every value of the window copied over them, the native entry point flag dropped from a module
		/// written by the managed writer that has a managed entry point, and the heaps kept in their order when the
		/// unknown streams are copied. Interfaces are always sorted the way Roslyn sorts them.
		/// </summary>
		internal static ModuleWriterOptionsBase CreateWriterOptions(ModuleDef module, WriterOptionsDto dto) {
			ModuleWriterOptionsBase options;
			if (dto.UseMixedMode && module is ModuleDefMD moduleMD) {
				options = new NativeModuleWriterOptions(moduleMD, optimizeImageSize: true) {
					KeepExtraPEData = dto.KeepExtraPeData,
					KeepWin32Resources = dto.KeepWin32Resources,
				};
			}
			else {
				options = new ModuleWriterOptions(module);
			}
			var pe = options.PEHeadersOptions;
			pe.Machine = (Machine)dto.Machine;
			pe.TimeDateStamp = dto.TimeDateStamp;
			pe.PointerToSymbolTable = dto.PointerToSymbolTable;
			pe.NumberOfSymbols = dto.NumberOfSymbols;
			pe.Characteristics = (Characteristics?)dto.Characteristics;
			pe.MajorLinkerVersion = dto.MajorLinkerVersion;
			pe.MinorLinkerVersion = dto.MinorLinkerVersion;
			pe.ImageBase = dto.ImageBase;
			pe.SectionAlignment = dto.SectionAlignment;
			pe.FileAlignment = dto.FileAlignment;
			pe.MajorOperatingSystemVersion = dto.MajorOperatingSystemVersion;
			pe.MinorOperatingSystemVersion = dto.MinorOperatingSystemVersion;
			pe.MajorImageVersion = dto.MajorImageVersion;
			pe.MinorImageVersion = dto.MinorImageVersion;
			pe.MajorSubsystemVersion = dto.MajorSubsystemVersion;
			pe.MinorSubsystemVersion = dto.MinorSubsystemVersion;
			pe.Win32VersionValue = dto.Win32VersionValue;
			pe.Subsystem = (Subsystem)dto.Subsystem;
			pe.DllCharacteristics = (DllCharacteristics?)dto.DllCharacteristics;
			pe.SizeOfStackReserve = dto.SizeOfStackReserve;
			pe.SizeOfStackCommit = dto.SizeOfStackCommit;
			pe.SizeOfHeapReserve = dto.SizeOfHeapReserve;
			pe.SizeOfHeapCommit = dto.SizeOfHeapCommit;
			pe.LoaderFlags = dto.LoaderFlags;
			pe.NumberOfRvaAndSizes = dto.NumberOfRvaAndSizes;

			var cor20 = options.Cor20HeaderOptions;
			cor20.MajorRuntimeVersion = dto.Cor20MajorRuntimeVersion;
			cor20.MinorRuntimeVersion = dto.Cor20MinorRuntimeVersion;
			cor20.Flags = (ComImageFlags?)dto.Cor20Flags;
			cor20.EntryPoint = dto.Cor20EntryPoint;

			var metadata = options.MetadataOptions;
			metadata.Flags = (MetadataFlags)dto.MetadataFlags | MetadataFlags.RoslynSortInterfaceImpl;
			var header = metadata.MetadataHeaderOptions;
			header.Signature = dto.MetadataSignature;
			header.MajorVersion = dto.MetadataMajorVersion;
			header.MinorVersion = dto.MetadataMinorVersion;
			header.Reserved1 = dto.MetadataReserved1;
			header.VersionString = string.IsNullOrEmpty(dto.MetadataVersionString) ? null : dto.MetadataVersionString;
			header.StorageFlags = (StorageFlags?)dto.MetadataStorageFlags;
			header.Reserved2 = dto.MetadataReserved2;
			var tables = metadata.TablesHeapOptions;
			tables.Reserved1 = dto.TablesReserved1;
			tables.MajorVersion = dto.TablesMajorVersion;
			tables.MinorVersion = dto.TablesMinorVersion;
			tables.UseENC = dto.TablesUseEnc;
			tables.ForceBigColumns = dto.TablesForceBigColumns;
			tables.ExtraData = dto.TablesExtraData;
			tables.Log2Rid = dto.TablesLog2Rid;
			tables.HasDeletedRows = dto.TablesHasDeletedRows;

			options.WritePdb = dto.WritePdb;
			options.ShareMethodBodies = dto.ShareMethodBodies;
			options.AddCheckSum = dto.AddCheckSum;
			options.AddMvidSection = dto.AddMvidSection;
			options.ModuleKind = (ModuleKind)dto.ModuleKind;

			if (options is ModuleWriterOptions && (module.ManagedEntryPoint is not null || module.NativeEntryPoint == 0))
				cor20.Flags &= ~ComImageFlags.NativeEntryPoint;
			if (dto.PreserveOtherMetadataStreams)
				metadata.PreserveHeapOrder(module, addCustomHeaps: true);
			return options;
		}

		/// <summary>The legacy options as the window's, for a document that goes through the writer.</summary>
		WriterOptionsDto? WriterOptionsFor(IModuleEntry entry, SaveModuleOptionsDto? legacy) =>
			entry is ModuleEntry module && !SavesAsBytes(entry) ? FromLegacyOptions(module, legacy) : null;

		/// <summary>
		/// The window's options for a request that came with the few check boxes the first version of the Save Module
		/// window had: dnlib's defaults, with those written over them.
		/// </summary>
		static WriterOptionsDto FromLegacyOptions(ModuleEntry module, SaveModuleOptionsDto? legacy) {
			var mixed = legacy?.MixedMode == true;
			var dto = ToDto(mixed ? new NativeModuleWriterOptions(module.Module, optimizeImageSize: true) : new ModuleWriterOptions(module.Module), module.Module);
			if (legacy is null)
				return dto;
			var flags = (MetadataFlags)dto.MetadataFlags;
			if (legacy.PreserveRids)
				flags |= MetadataFlags.PreserveRids;
			if (legacy.PreserveUsOffsets)
				flags |= MetadataFlags.PreserveUSOffsets;
			if (legacy.PreserveStringsOffsets)
				flags |= MetadataFlags.PreserveStringsOffsets;
			if (legacy.PreserveBlobOffsets)
				flags |= MetadataFlags.PreserveBlobOffsets;
			var kind = legacy.ModuleKind is { } moduleKind ? moduleKind : dto.ModuleKind;
			return dto with {
				MetadataFlags = (uint)flags,
				ShareMethodBodies = legacy.ShareMethodBodies,
				AddCheckSum = legacy.AddCheckSum,
				AddMvidSection = legacy.AddMvidSection,
				WritePdb = legacy.WritePdb && module.Module.PdbState is not null,
				KeepExtraPeData = legacy.KeepExtraPeData,
				KeepWin32Resources = legacy.KeepWin32Resources,
				ModuleKind = kind,
				Characteristics = legacy.ModuleKind is null ? dto.Characteristics : (ushort?)WithDllBit((Characteristics)(dto.Characteristics ?? 0), (ModuleKind)kind),
			};
		}

		// ---------------------------------------------------------------- the save run

		/// <summary>
		/// dnSpy's ModuleSaver over a list of documents: each written in turn, the run's progress weighted by how much
		/// there is to write, a log of what the writer reported, and a stop at the next progress report once the run
		/// is cancelled. A document that could not be written leaves its error in its result and the run goes on, the
		/// way dnSpy logs it and moves to the next file.
		/// </summary>
		public async Task<SaveDocumentsResponse> SaveDocumentsAsync(SaveDocumentsRequest request, Func<SaveDocumentsProgressNotification, Task>? progress, CancellationToken cancellationToken) {
			var documents = request.Documents.Select(document => (Request: document, Entry: GetSaveableDocument(document.DocumentId))).ToArray();
			foreach (var (document, _) in documents) {
				if (string.IsNullOrWhiteSpace(document.FileName))
					throw new RpcException(ErrorCodes.SaveFailed, "Every document needs a file name to be saved to.");
			}
			// dnSpy weighs a module by its types and a hex buffer by its size in 10 MB steps, so a big file moves the
			// overall bar as much as it takes to write.
			var weights = documents.Select(document => document.Entry is ModuleEntry module && !SavesAsBytes(module)
				? Math.Max(1.0, module.Module.Types.Count)
				: Math.Max(1.0, document.Entry.FileLength / (10.0 * 1024 * 1024))).ToArray();
			var totalWeight = weights.Sum();
			var done = 0.0;
			var results = new List<SaveDocumentResultDto>();
			var canceled = false;
			var rootsChanged = false;
			for (var index = 0; index < documents.Length; index++) {
				var (document, entry) = documents[index];
				var fileName = Path.GetFullPath(document.FileName);
				var log = new List<string>();
				var weight = weights[index];
				var lastReported = -1.0;
				var fileIndex = index;
				void Report(double fileProgress) {
					cancellationToken.ThrowIfCancellationRequested();
					if (progress is null || fileProgress - lastReported < 0.01 && fileProgress < 1)
						return;
					lastReported = fileProgress;
					_ = progress(new SaveDocumentsProgressNotification(request.ProgressToken ?? string.Empty, fileIndex, fileName, fileProgress, totalWeight == 0 ? 1 : (done + weight * fileProgress) / totalWeight));
				}
				try {
					log.Add($"Writing {fileName}...");
					var writer = document.Writer;
					if (writer is null && entry is ModuleEntry plain && !SavesAsBytes(plain))
						writer = CreateDefaultWriterOptions(plain, false);
					var wasInMemory = IsInMemory(entry);
					var saved = await SaveDocumentAsync(entry, fileName, writer, Report, log, cancellationToken).ConfigureAwait(false);
					rootsChanged |= wasInMemory;
					var errors = log.Count(line => line.StartsWith("Error: ", StringComparison.Ordinal) || line.StartsWith("Warning: ", StringComparison.Ordinal));
					results.Add(new SaveDocumentResultDto(document.DocumentId, saved.Path, true, saved.Length, saved.Sha256, log, errors, null));
				}
				catch (OperationCanceledException) {
					results.Add(new SaveDocumentResultDto(document.DocumentId, fileName, false, 0, null, log, 0, null));
					canceled = true;
					break;
				}
				catch (Exception ex) {
					var message = ex is RpcException { InnerException: { } inner } ? $"{ex.Message} {inner.Message}" : ex.Message;
					log.Add(ex is UnauthorizedAccessException ? $"Access error: {message}" : ex is IOException ? $"File error: {message}" : $"An exception occurred\n\n{message}");
					results.Add(new SaveDocumentResultDto(document.DocumentId, fileName, false, 0, null, log, 1, message));
				}
				done += weight;
			}
			return new SaveDocumentsResponse(results, canceled, GetModifiedDocuments(), rootsChanged ? CreateOpenResponse().Modules : null);
		}

		/// <summary>
		/// Writes one document to <paramref name="destination"/> — through dnlib's writer with the options given, or,
		/// for a document saved as bytes, as the file with its patches — and marks it saved. A file is written beside
		/// the destination first and moved over it once it is complete, so a failed or cancelled save leaves the old
		/// file as it was. A new document takes the file it was saved to; an application configuration file goes
		/// along with a module saved under another name, as dnSpy copies it.
		/// </summary>
		async Task<SaveModuleResponse> SaveDocumentAsync(IModuleEntry entry, string destination, WriterOptionsDto? writer, Action<double>? report, List<string>? log, CancellationToken cancellationToken) {
			var directory = Path.GetDirectoryName(destination);
			if (string.IsNullOrEmpty(directory) || !Directory.Exists(directory))
				throw new RpcException(ErrorCodes.SaveFailed, "The destination directory does not exist.");
			var temporaryPath = Path.Combine(directory, $".{Path.GetFileName(destination)}.{Guid.NewGuid():N}.tmp");
			var inPlace = !IsInMemory(entry) && SameFile(destination, entry.Path);
			var module = entry as ModuleEntry;
			var asBytes = SavesAsBytes(entry);
			try {
				if (asBytes) {
					await Task.Run(() => WriteFileWithPatches(entry, temporaryPath, report, cancellationToken), cancellationToken).ConfigureAwait(false);
				}
				else {
					var options = writer ?? CreateDefaultWriterOptions(module!, false);
					await Task.Run(() => WriteModule(module!, temporaryPath, destination, options, report, log), cancellationToken).ConfigureAwait(false);
					cancellationToken.ThrowIfCancellationRequested();
					// The reload is what the patches are resolved against: the file dnlib just wrote has a
					// layout of its own, so where a patch belongs is found through the member it aimed at.
					if (module!.HexPatches.Count > 0) {
						IReadOnlyList<(long Offset, byte[] Data)> hexPatches;
						using (var verificationModule = ModuleDefMD.Load(temporaryPath))
							hexPatches = module.ResolveHexPatchOffsets(verificationModule);
						// dnlib knows nothing about the hex patches, so they go on last — over the bytes it wrote.
						await Task.Run(() => {
							using var stream = new FileStream(temporaryPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
							WriteHexPatches(stream, hexPatches);
						}, cancellationToken).ConfigureAwait(false);
					}
					else {
						using var verificationModule = ModuleDefMD.Load(temporaryPath);
						_ = verificationModule.Mvid;
						_ = verificationModule.Types.Count;
					}
				}
				cancellationToken.ThrowIfCancellationRequested();
				// The patches are about to be in the file the document reads, so what they wrote over is kept aside.
				if (asBytes && inPlace) {
					using var current = new FileStream(entry.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
					HexPatchList.Rebase(entry, current);
				}
				File.Move(temporaryPath, destination, overwrite: true);
				if (!inPlace && !IsInMemory(entry) && File.Exists(entry.Path + ".config")) {
					try {
						File.Copy(entry.Path + ".config", destination + ".config", overwrite: true);
					}
					catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) {
						log?.Add($"File error: {ex.Message}");
					}
				}
				await using var savedFile = new FileStream(destination, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
				var hash = await SHA256.HashDataAsync(savedFile, cancellationToken).ConfigureAwait(false);
				if (module is not null && !asBytes && inPlace)
					module.FileRewritten = true;
				if (module is { InMemory: true })
					GiveFile(module, destination, savedFile.Length);
				MarkAsSaved(entry);
				report?.Invoke(1);
				return new SaveModuleResponse(destination, savedFile.Length, Convert.ToHexString(hash).ToLowerInvariant());
			}
			catch (OperationCanceledException) {
				throw;
			}
			catch (Exception ex) when (ex is not RpcException) {
				throw new RpcException(ErrorCodes.SaveFailed, "The module could not be saved.", null, ex);
			}
			finally {
				try {
					if (File.Exists(temporaryPath))
						File.Delete(temporaryPath);
				}
				catch (IOException) {
				}
			}
		}

		/// <summary>
		/// What dnSpy does for a document with no file name once it is saved: the file becomes the document's. The
		/// nodes keep their ids — the tree and the tabs name them by those — while the keys that named the module by
		/// the workspace's own name for it now name it by its file, and what was worked out under the old name is
		/// worked out again.
		/// </summary>
		void GiveFile(ModuleEntry module, string path, long length) {
			var oldPath = module.Path;
			foreach (var node in nodes.Values.Where(node => node.Key.Contains(oldPath, StringComparison.Ordinal)).ToArray()) {
				nodeIdsByKey.Remove(node.Key);
				node.Key = node.Key.Replace(oldPath, path, StringComparison.Ordinal);
				nodeIdsByKey[node.Key] = node.Id;
			}
			namespaceIndexes.Remove(oldPath);
			typeIndexes.Remove(oldPath);
			typeReferenceIndexes.Remove(oldPath);
			if (netModules.Remove(oldPath, out var netModule))
				netModules[path] = netModule;
			module.Path = path;
			module.FileLength = length;
			module.InMemory = false;
			// The file is dnlib's output, not what the module was read from, so the decompiler keeps reading the
			// model and a later save goes through the writer again.
			module.FileRewritten = true;
			module.Module.Location = path;
			symbols.Invalidate();
		}

		/// <summary>
		/// dnSpy's ModuleSaver for a module: dnlib's writer — the native one for a mixed-mode module — with a logger
		/// that keeps what it reports instead of throwing, and the progress it reports passed on, which is also where a
		/// cancelled run stops it. The PDB goes beside the file the module is finally saved as.
		/// </summary>
		static void WriteModule(ModuleEntry module, string path, string finalPath, WriterOptionsDto dto, Action<double>? report, List<string>? log) {
			var options = CreateWriterOptions(module.Module, dto);
			if (options.WritePdb && module.Module.PdbState is not null) {
				options.PdbFileName = Path.ChangeExtension(finalPath, ".pdb");
				// The DIA-based writer is a Windows component; the managed writer emits a portable PDB.
				options.PdbOptions = PdbWriterOptions.NoDiaSymReader | PdbWriterOptions.Deterministic;
			}
			else {
				options.WritePdb = false;
			}
			if (log is not null)
				options.Logger = new SaveLogger(log);
			if (report is not null)
				options.ProgressUpdated += (_, e) => report(e.Progress);
			if (options is NativeModuleWriterOptions native)
				((ModuleDefMD)module.Module).NativeWrite(path, native);
			else
				module.Module.Write(path, (ModuleWriterOptions)options);
		}

		/// <summary>
		/// dnSpy's hex buffer save: the file's bytes, read in 64 KB pieces, with every patch written over them. The
		/// file is the one the document was read from, which is what the patches were measured against.
		/// </summary>
		static void WriteFileWithPatches(IModuleEntry entry, string path, Action<double>? report, CancellationToken cancellationToken) {
			const int ChunkSize = 64 * 1024;
			using var source = new FileStream(entry.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, ChunkSize);
			using var target = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, ChunkSize);
			var length = source.Length;
			var buffer = new byte[ChunkSize];
			for (long offset = 0; offset < length; offset += ChunkSize) {
				cancellationToken.ThrowIfCancellationRequested();
				var count = (int)Math.Min(ChunkSize, length - offset);
				var chunk = count == buffer.Length ? buffer : new byte[count];
				source.ReadExactly(chunk);
				HexPatchList.Overlay(entry, offset, chunk);
				target.Write(chunk);
				report?.Invoke(length == 0 ? 1 : (double)(offset + count) / length);
			}
		}

		/// <summary>dnSpy's save window log: dnlib's warnings and errors, each said once per file.</summary>
		sealed class SaveLogger(List<string> log) : ILogger {
			readonly HashSet<string> seen = new(StringComparer.Ordinal);

			public bool IgnoresEvent(LoggerEvent loggerEvent) => loggerEvent is not (LoggerEvent.Error or LoggerEvent.Warning);

			public void Log(object sender, LoggerEvent loggerEvent, string format, params object[] args) {
				if (IgnoresEvent(loggerEvent))
					return;
				var text = args.Length == 0 ? format : string.Format(System.Globalization.CultureInfo.InvariantCulture, format, args);
				if (seen.Add(text))
					log.Add($"{(loggerEvent == LoggerEvent.Error ? "Error" : "Warning")}: {text}");
			}
		}
	}
}
