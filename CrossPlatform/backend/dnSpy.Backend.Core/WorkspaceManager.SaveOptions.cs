using dnlib.DotNet;
using dnlib.DotNet.Writer;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core;

/// <summary>
/// The writer options behind dnSpy's Save Module window: what a module is written as, whether the
/// tables keep their row ids and heap offsets, whether a mixed-mode module goes through dnlib's native
/// writer, and whether the PDB is written beside it.
/// </summary>
public sealed partial class WorkspaceManager {
	public Task<SaveModuleResponse> SaveModuleWithOptionsAsync(SaveModuleWithOptionsRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.SaveModuleAsync(
			new SaveModuleRequest(request.WorkspaceId, request.ModuleId, request.DestinationPath, request.Overwrite),
			request.Options,
			cancellationToken), cancellationToken);

	public Task<SaveModuleResponse> SaveModuleInPlaceWithOptionsAsync(SaveModuleInPlaceWithOptionsRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.SaveModuleInPlaceAsync(
			new SaveModuleInPlaceRequest(request.WorkspaceId, request.ModuleId),
			request.Options,
			cancellationToken), cancellationToken);

	public Task<SaveAllResponse> SaveAllModulesWithOptionsAsync(SaveAllWithOptionsRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.SaveAllModulesAsync(request.Options, cancellationToken), cancellationToken);

	sealed partial class Workspace {
		/// <summary>
		/// Writes a module with the options the Save Module window collected. A mixed-mode module is the
		/// one case dnlib's ordinary writer cannot handle — it lays out managed metadata only — so it goes
		/// through <c>NativeModuleWriter</c>, which keeps the native code and the PE data around it.
		/// </summary>
		internal static void WriteModule(ModuleDef module, string path, SaveModuleOptionsDto? options) {
			var preserve = (MetadataFlags)0;
			if (options?.PreserveRids == true)
				preserve |= MetadataFlags.PreserveRids;
			if (options?.PreserveUsOffsets == true)
				preserve |= MetadataFlags.PreserveUSOffsets;
			if (options?.PreserveStringsOffsets == true)
				preserve |= MetadataFlags.PreserveStringsOffsets;
			if (options?.PreserveBlobOffsets == true)
				preserve |= MetadataFlags.PreserveBlobOffsets;

			ModuleWriterOptionsBase writerOptions;
			if (options is { MixedMode: true } && module is ModuleDefMD nativeModule) {
				var nativeOptions = new NativeModuleWriterOptions(nativeModule, optimizeImageSize: true) {
					KeepExtraPEData = options.KeepExtraPeData,
					KeepWin32Resources = options.KeepWin32Resources,
				};
				writerOptions = nativeOptions;
			}
			else {
				writerOptions = new ModuleWriterOptions(module) {
					NoWin32Resources = options?.KeepWin32Resources == false,
				};
			}
			writerOptions.MetadataOptions.Flags |= preserve;
			writerOptions.ShareMethodBodies = options?.ShareMethodBodies ?? false;
			writerOptions.AddCheckSum = options?.AddCheckSum ?? false;
			writerOptions.AddMvidSection = options?.AddMvidSection ?? false;
			if (options?.ModuleKind is { } kind)
				writerOptions.ModuleKind = (ModuleKind)kind;
			if (options?.WritePdb == true && module.PdbState is not null) {
				writerOptions.WritePdb = true;
				writerOptions.PdbFileName = Path.ChangeExtension(path, ".pdb");
				// The DIA-based writer is a Windows component; the managed writer emits a portable PDB.
				writerOptions.PdbOptions = PdbWriterOptions.NoDiaSymReader | PdbWriterOptions.Deterministic;
			}

			if (writerOptions is NativeModuleWriterOptions nativeWriter)
				((ModuleDefMD)module).NativeWrite(path, nativeWriter);
			else
				module.Write(path, (ModuleWriterOptions)writerOptions);
		}
	}
}
