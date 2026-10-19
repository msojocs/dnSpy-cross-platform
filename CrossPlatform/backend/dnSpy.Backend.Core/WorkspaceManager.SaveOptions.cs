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
}
