using System.Diagnostics;
using System.Globalization;
using System.Text;
using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.Search;

namespace dnSpy.Backend.Core;

public sealed partial class WorkspaceManager {
	public Task<RemoveModuleResponse> RemoveModulesAsync(RemoveModulesRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.RemoveRoots(request.NodeIds), cancellationToken);

	public Task<ModifiedModulesResponse> GetModifiedModulesAsync(ModifiedModulesRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetModifiedModules(request.NodeIds), cancellationToken);

	public Task<CloseCandidatesResponse> GetCloseCandidatesAsync(WorkspaceRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetCloseCandidates(), cancellationToken);

	public Task<TreeNodesResponse> MoveRootsAsync(MoveRootsRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.MoveRoots(request.NodeIds, request.Index), cancellationToken);

	public Task<ActivateNodeResponse> ActivateNodeAsync(NodeRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.ActivateNode(request.NodeId), cancellationToken);

	/// <summary>
	/// Files dropped on the tree. With no workspace yet the drop is what opens one — and when the filter turns
	/// every file away there is nothing to open, so no workspace is left behind for the client to forget.
	/// </summary>
	public async Task<DropFilesResponse> DropFilesAsync(DropFilesRequest request, CancellationToken cancellationToken) {
		ObjectDisposedException.ThrowIf(disposed, this);
		if (request.WorkspaceId is not null)
			return await GetWorkspace(request.WorkspaceId).RunAsync(w => w.DropFilesAsync(request, cancellationToken), cancellationToken).ConfigureAwait(false);
		var workspace = new Workspace(symbols);
		try {
			var response = await workspace.RunAsync(w => w.DropFilesAsync(request, cancellationToken), cancellationToken).ConfigureAwait(false);
			if (response.Modules.Count == 0) {
				workspace.Dispose();
				return response with { WorkspaceId = null, StateId = null };
			}
			if (!workspaces.TryAdd(workspace.Id, workspace))
				throw new InvalidOperationException("Could not register the workspace.");
			return response;
		}
		catch {
			workspace.Dispose();
			throw;
		}
	}

	/// <summary>Every assembly of every global assembly cache on this machine. Reading them is a walk over
	/// directories only — no file is opened — so the dialog lists a whole cache quickly.</summary>
	public Task<GacListResponse> ListGacAsync(CancellationToken cancellationToken) => Task.Run(() => new GacListResponse(GacInfo.GetAssemblies()
		.Select(file => new GacAssemblyDto(file.Name, file.Version.ToString(), file.Culture, file.PublicKeyToken, file.Path))
		.ToArray()), cancellationToken);

	/// <summary>
	/// What dnSpy's dialog shows under its list for the selected file: who made it — the company in its version
	/// resource, or its AssemblyCompany attribute — and its file version, each cut to 512 characters.
	/// </summary>
	public Task<GacDetailsResponse> GetGacDetailsAsync(GacDetailsRequest request, CancellationToken cancellationToken) => Task.Run(() => {
		static string? Cut(string? text) => string.IsNullOrWhiteSpace(text) ? null : text.Length > 512 ? text[..512] : text;
		string? createdBy = null;
		string? fileVersion = null;
		try {
			var info = FileVersionInfo.GetVersionInfo(request.Path);
			createdBy = info.CompanyName;
			fileVersion = info.FileVersion;
		}
		catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) {
		}
		if (string.IsNullOrWhiteSpace(createdBy)) {
			try {
				using var module = ModuleDefMD.Load(request.Path);
				createdBy = module.Assembly?.CustomAttributes.Find("System.Reflection.AssemblyCompanyAttribute") is { ConstructorArguments.Count: 1 } company
					&& company.ConstructorArguments[0].Value is UTF8String value ? value.String : null;
			}
			catch {
				// A file the cache lists but nothing can read has no company to show.
			}
		}
		return new GacDetailsResponse(Cut(createdBy), Cut(fileVersion));
	}, cancellationToken);

	public Task<ResourceItemsResponse> GetResourceItemsAsync(ResourceItemsRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetResourceItems(request.NodeIds, request.Raw, cancellationToken, request.Baml), cancellationToken);

	public Task<FindResourceResponse> FindResourceAsync(FindResourceRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.FindResource(request), cancellationToken);

	/// <summary>The same request resource/getItems takes; only the nodes are read.</summary>
	public Task<ResourceItemNamesResponse> GetResourceItemNamesAsync(ResourceItemsRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetResourceItemNames(request.NodeIds), cancellationToken);

	public Task<SelectMemberResponse> SelectMemberAsync(SelectMemberRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.SelectMember(request.Paths, request.Member), cancellationToken);

	sealed partial class Workspace {
		// The roots the workspace opened by itself to resolve a reference — dnSpy's auto-loaded documents. They
		// look like any other root, but a sort puts them last and a saved list leaves them out.
		readonly HashSet<string> autoLoadedRoots = new(StringComparer.Ordinal);
		// The net modules of a multi-module assembly, which hang off its root beside the manifest module. dnlib
		// reads them out of the files the File table names; they are entries of their own so their trees work
		// the way a module's does, but they are no roots and cannot be saved here.
		readonly Dictionary<string, ModuleEntry> netModules = new(StringComparer.Ordinal);
		// A module's type and member references, grouped the way the Type References folder lists them. Built
		// once per edit state, the lifetime the namespace index has.
		readonly Dictionary<string, TypeReferenceIndex> typeReferenceIndexes = new(StringComparer.Ordinal);

		bool IsAutoLoaded(IModuleEntry entry) => autoLoadedRoots.Contains(entry.Id);

		/// <summary>
		/// Puts a file that has just been read into the tree as a root: at the end, or in front of the root at
		/// <paramref name="insertIndex"/> — where a drop put it. An auto-loaded one is marked as such.
		/// </summary>
		NodeEntry AddRoot(IModuleEntry entry, bool autoLoaded, int insertIndex = -1) {
			var fullPath = entry.Path;
			var root = entry switch {
				ModuleEntry module => GetOrAddNode($"assembly:{fullPath}", NodeKind.Assembly, module.Module.Assembly ?? (object)module.Module, entry),
				PeOnlyModuleEntry peModule => GetOrAddNode($"pe:{fullPath}", NodeKind.PEDocument, peModule, peModule),
				ElfFileEntry elf => GetOrAddNode($"elf:{fullPath}", NodeKind.ElfDocument, elf, elf),
				_ => GetOrAddNode($"unknown:{fullPath}", NodeKind.UnknownDocument, entry, entry),
			};
			switch (entry) {
				case ModuleEntry module:
					module.Id = root.Id;
					modules.Add(module.Id, module);
					break;
				case PeOnlyModuleEntry peModule:
					peModule.Id = root.Id;
					peModules.Add(peModule.Id, peModule);
					break;
				case ElfFileEntry elf:
					elf.Id = root.Id;
					elfFiles.Add(elf.Id, elf);
					break;
				case UnknownFileEntry unknown:
					unknown.Id = root.Id;
					unknownFiles.Add(unknown.Id, unknown);
					break;
			}
			if (insertIndex >= 0 && insertIndex < rootOrder.Count)
				rootOrder.Insert(insertIndex, root.Id);
			else
				rootOrder.Add(root.Id);
			if (autoLoaded)
				autoLoadedRoots.Add(root.Id);
			return root;
		}

		/// <summary>The entry a root id stands for, whatever kind of file it is.</summary>
		IModuleEntry? RootEntry(string id) =>
			modules.TryGetValue(id, out var module) ? module
			: peModules.TryGetValue(id, out var peModule) ? peModule
			: elfFiles.TryGetValue(id, out var elf) ? elf
			: unknownFiles.TryGetValue(id, out var unknown) ? unknown
			: null;

		/// <summary>A file the user opened that the workspace had only auto-loaded becomes one of theirs.</summary>
		void MarkOpenedByUser(string fullPath) {
			foreach (var id in rootOrder) {
				if (RootEntry(id) is { } entry && SameFile(entry.Path, fullPath))
					autoLoadedRoots.Remove(id);
			}
		}

		// ---------------------------------------------------------------- removing and moving roots

		/// <summary>
		/// Removes the documents the nodes belong to — dnSpy's Remove over the selection, and what its two Close
		/// All sweeps run. A node inside a document stands for that document, and a document named twice goes
		/// once. Every kind of document can go: an assembly, a PE, ELF or unknown file alike.
		/// <para>dnSpy's RemoveAssemblyCommand.Execute decides per document what the edit history makes of it. One
		/// an edit in the undo history touched cannot simply be let go — undoing that edit would reach into a
		/// module the tree no longer has — so its removal goes into the history as an edit of its own, which Undo
		/// reverses by putting the very same document back where it was. One only the redo history touched is let
		/// go, and the redo history with it, which recording the removal would have cleared anyway. Everything
		/// else is let go. The removal leaves the saved state where it was: it changes no module.</para>
		/// </summary>
		public RemoveModuleResponse RemoveRoots(IReadOnlyList<string> nodeIds) {
			var entries = new List<IModuleEntry>();
			foreach (var nodeId in nodeIds) {
				var node = GetNode(nodeId);
				if (node.Module is not IModuleEntry entry || RootEntry(entry.Id) is null)
					throw new RpcException(ErrorCodes.NodeNotFound, "The selected document is no longer open.");
				if (!entries.Contains(entry))
					entries.Add(entry);
			}
			var kept = entries.Where(entry => Touches(undoHistory, entry)).ToList();
			var onlyInRedo = entries.Any(entry => !kept.Contains(entry) && Touches(redoHistory, entry));
			var removed = new List<string>();
			foreach (var entry in entries.Except(kept))
				removed.AddRange(DropRoot(entry));
			if (kept.Count > 0) {
				var operations = kept.Select(entry => new EditOperation(entry.Id, entry, () => {
					var detached = DetachRoot(entry);
					return () => ReattachRoot(detached);
				}, ChangesRoots: true, Modifies: false)).ToArray();
				var undo = new Stack<Action>();
				foreach (var entry in kept) {
					var detached = DetachRoot(entry);
					removed.AddRange(detached.Nodes.Select(node => node.Id));
					undo.Push(() => ReattachRoot(detached));
				}
				undoHistory.Push(new EditHistoryEntry(nextHistoryId++, operations, undo.ToArray(), stateId, stateId));
				redoHistory.Clear();
			}
			else if (onlyInRedo) {
				redoHistory.Clear();
			}
			version++;
			return new RemoveModuleResponse(removed, GetRoots().Nodes, undoHistory.Count > 0, redoHistory.Count > 0);
		}

		/// <summary>Whether an edit of the history was made to the document or to a net module of it.</summary>
		static bool Touches(IEnumerable<EditHistoryEntry> history, IModuleEntry entry) =>
			history.Any(step => step.Operations.Any(operation => operation.Module.Id == entry.Id));

		/// <summary>Lets a document go for good: its nodes, and every cache that holds anything of it.</summary>
		IReadOnlyList<string> DropRoot(IModuleEntry entry) {
			if (!RemoveRootEntry(entry))
				return [];
			rootOrder.Remove(entry.Id);
			autoLoadedRoots.Remove(entry.Id);
			if (entry is ModuleEntry managed) {
				NoteModelChanged();
				return DropModule(managed);
			}
			return DropEntryNodes(entry);
		}

		bool RemoveRootEntry(IModuleEntry entry) => entry switch {
			ModuleEntry module => modules.Remove(module.Id),
			PeOnlyModuleEntry peModule => peModules.Remove(peModule.Id),
			ElfFileEntry elf => elfFiles.Remove(elf.Id),
			UnknownFileEntry unknown => unknownFiles.Remove(unknown.Id),
			_ => false,
		};

		/// <summary>
		/// What an undoable removal took out of the tree, kept so Undo can put back the very objects it took: the
		/// entry the edits in the history were made to, the nodes the client still names by id, and the net modules
		/// of an assembly with the edits made to them.
		/// </summary>
		sealed record DetachedRoot(IModuleEntry Entry, int Index, bool AutoLoaded, NodeEntry[] Nodes, ModuleEntry[] NetModules);

		DetachedRoot DetachRoot(IModuleEntry entry) {
			var index = rootOrder.IndexOf(entry.Id);
			var autoLoaded = autoLoadedRoots.Contains(entry.Id);
			var owned = entry is ModuleEntry ? netModules.Values.Where(netModule => netModule.Id == entry.Id).ToArray() : [];
			var detachedNodes = nodes.Values
				.Where(node => ReferenceEquals(node.Module, entry) || owned.Any(netModule => ReferenceEquals(node.Module, netModule)))
				.ToArray();
			RemoveRootEntry(entry);
			rootOrder.Remove(entry.Id);
			autoLoadedRoots.Remove(entry.Id);
			foreach (var netModule in owned)
				netModules.Remove(netModule.Path);
			foreach (var node in detachedNodes) {
				nodeIdsByKey.Remove(node.Key);
				nodes.Remove(node.Id);
			}
			if (entry is ModuleEntry module) {
				ForgetModuleCaches(module, owned);
				NoteModelChanged();
			}
			return new DetachedRoot(entry, index, autoLoaded, detachedNodes, owned);
		}

		void ReattachRoot(DetachedRoot detached) {
			var entry = detached.Entry;
			switch (entry) {
				case ModuleEntry module: modules.Add(module.Id, module); break;
				case PeOnlyModuleEntry peModule: peModules.Add(peModule.Id, peModule); break;
				case ElfFileEntry elf: elfFiles.Add(elf.Id, elf); break;
				case UnknownFileEntry unknown: unknownFiles.Add(unknown.Id, unknown); break;
			}
			rootOrder.Insert(Math.Clamp(detached.Index, 0, rootOrder.Count), entry.Id);
			if (detached.AutoLoaded)
				autoLoadedRoots.Add(entry.Id);
			foreach (var netModule in detached.NetModules)
				netModules[netModule.Path] = netModule;
			foreach (var node in detached.Nodes) {
				nodes[node.Id] = node;
				nodeIdsByKey[node.Key] = node.Id;
			}
			if (entry is ModuleEntry)
				NoteModelChanged();
			symbols.Invalidate();
		}

		/// <summary>The nodes of a file that is not a managed module go with it, the way a module's do.</summary>
		IReadOnlyList<string> DropEntryNodes(IModuleEntry entry) {
			var removed = nodes.Values.Where(node => ReferenceEquals(node.Module, entry)).Select(node => node.Id).ToArray();
			foreach (var id in removed) {
				nodeIdsByKey.Remove(nodes[id].Key);
				nodes.Remove(id);
			}
			return removed;
		}

		/// <summary>
		/// dnSpy's OnDropNodes: the roots are taken out and put back, in the order they had, in front of the
		/// root that was at <paramref name="index"/> — at the end when that root was one of them or there is
		/// none.
		/// </summary>
		public TreeNodesResponse MoveRoots(IReadOnlyList<string> nodeIds, int index) {
			var moving = rootOrder.Where(id => nodeIds.Contains(id, StringComparer.Ordinal)).ToList();
			if (moving.Count == 0)
				return GetRoots();
			var anchor = index >= 0 && index < rootOrder.Count ? rootOrder[index] : null;
			foreach (var id in moving)
				rootOrder.Remove(id);
			var insertAt = anchor is null ? -1 : rootOrder.IndexOf(anchor);
			if (insertAt < 0)
				insertAt = rootOrder.Count;
			rootOrder.InsertRange(insertAt, moving);
			version++;
			return GetRoots();
		}

		/// <summary>
		/// dnSpy's OnDropFiles. A directory stands for every file under it. A dropped file that is open already
		/// stays where it is — and stops being an auto-loaded one. The new files go in sorted by name, in front of
		/// the root at the drop index; with more than one of them the dragged-items filter decides which are let
		/// in. The selection goes to the first new root, or else to the first dropped file the tree holds.
		/// </summary>
		public async Task<DropFilesResponse> DropFilesAsync(DropFilesRequest request, CancellationToken cancellationToken) {
			var dropped = new List<string>();
			foreach (var path in request.Paths) {
				if (string.IsNullOrWhiteSpace(path))
					continue;
				var fullPath = Path.GetFullPath(path);
				if (Directory.Exists(fullPath)) {
					try {
						dropped.AddRange(Directory.EnumerateFiles(fullPath, "*", SearchOption.AllDirectories));
					}
					catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) {
						// A directory that cannot be walked adds nothing, the way dnSpy's GetFiles skips it.
					}
				}
				else {
					dropped.Add(fullPath);
				}
			}
			foreach (var path in dropped) {
				if (File.Exists(path) && IsOpen(path))
					MarkOpenedByUser(path);
			}
			var newFiles = dropped
				.Where(path => File.Exists(path) && !IsOpen(path))
				.Distinct(StringComparer.OrdinalIgnoreCase)
				.OrderBy(Path.GetFileNameWithoutExtension, StringComparer.CurrentCultureIgnoreCase)
				.ToArray();
			var index = Math.Clamp(request.Index, 0, rootOrder.Count);
			var added = new List<string>();
			string? selected = null;
			foreach (var path in newFiles) {
				cancellationToken.ThrowIfCancellationRequested();
				var entry = await Task.Run(() => LoadEntry(path), cancellationToken).ConfigureAwait(false);
				if (newFiles.Length > 1 && !PassesDropFilter(entry, request.Filter))
					continue;
				var root = AddRoot(entry, autoLoaded: false, index + added.Count);
				added.Add(path);
				selected ??= root.Id;
			}
			if (added.Count > 0)
				version++;
			selected ??= dropped.Where(File.Exists).Select(FindRootId).FirstOrDefault(id => id is not null);
			var response = CreateOpenResponse();
			return new DropFilesResponse(Id, response.Modules, added, selected, newFiles.Length > 0 && added.Count == 0, stateId);
		}

		/// <summary>The Assembly Explorer's dragged-items filter: everything, everything but files dnSpy cannot
		/// read as an image (the default), or .NET modules only.</summary>
		static bool PassesDropFilter(IModuleEntry entry, string filter) => filter switch {
			DropFilters.All => true,
			DropFilters.DotNetOnly => entry is ModuleEntry,
			_ => entry is not UnknownFileEntry,
		};

		string? FindRootId(string path) {
			foreach (var id in rootOrder) {
				if (RootEntry(id) is { } entry && SameFile(entry.Path, path))
					return id;
			}
			return null;
		}

		public ModifiedModulesResponse GetModifiedModules(IReadOnlyList<string>? nodeIds) {
			IEnumerable<ModuleEntry> candidates = OrderedModules();
			if (nodeIds is not null) {
				var named = new HashSet<ModuleEntry>();
				foreach (var nodeId in nodeIds) {
					if (nodes.TryGetValue(nodeId, out var node) && ModuleOf(node) is { } module)
						named.Add(module);
				}
				candidates = candidates.Where(named.Contains);
			}
			return new ModifiedModulesResponse(candidates.Where(IsModified).Select(module => module.Path).ToArray());
		}

		/// <summary>
		/// What dnSpy's two sweeps remove. Close All Framework Assemblies takes the assembly roots that are DLLs
		/// and framework files (FrameworkFileUtils: a .NET runtime directory, a name dnSpy knows, a GAC path).
		/// Close All Missing Files takes every unknown document — a file that is gone, or one that is no image.
		/// </summary>
		public CloseCandidatesResponse GetCloseCandidates() {
			var framework = new List<string>();
			var missing = new List<string>();
			foreach (var entry in OrderedEntries()) {
				switch (entry) {
					case ModuleEntry { Module.Assembly: { } assembly } module
						when (assembly.ManifestModule?.Characteristics & dnlib.PE.Characteristics.Dll) != 0
						&& FrameworkAssemblies.IsFrameworkAssembly(module.Path, assembly.Name.String):
						framework.Add(module.Id);
						break;
					case UnknownFileEntry unknown:
						missing.Add(unknown.Id);
						break;
				}
			}
			return new CloseCandidatesResponse(framework, missing);
		}

		// ---------------------------------------------------------------- references

		/// <summary>
		/// The References folder: the assembly references, then the module references, each sorted by full name —
		/// dnSpy's ReferencesFolderNodeImpl with its AssemblyRef and ModuleRef groups.
		/// </summary>
		IReadOnlyList<NodeEntry> GetReferenceChildren(NodeEntry node) {
			var module = (ModuleDefMD)node.Value;
			var owner = node.AsModuleEntry!;
			var result = new List<NodeEntry>();
			result.AddRange(module.GetAssemblyRefs()
				.OrderBy(reference => reference.FullName, StringComparer.OrdinalIgnoreCase)
				.Select(reference => GetOrAddNode(MemberKey(owner, "reference", reference.MDToken.Raw), NodeKind.AssemblyReference, reference, owner)));
			result.AddRange(module.GetModuleRefs()
				.OrderBy(reference => reference.FullName, StringComparer.OrdinalIgnoreCase)
				.Select(reference => GetOrAddNode(MemberKey(owner, "moduleref", reference.MDToken.Raw), NodeKind.ModuleReference, reference, owner)));
			return result;
		}

		static bool HasReferences(ModuleDefMD module) => module.GetAssemblyRefs().Any() || module.GetModuleRefs().Any();

		/// <summary>
		/// What an assembly reference expands into: the references of the assembly it names — dnSpy's
		/// AssemblyReferenceNodeImpl resolves the assembly and lists its own references, recursively. Resolving
		/// it puts the assembly into the tree, as dnSpy's resolver does, marked as one the workspace loaded by
		/// itself. Each row is filed under the assembly it belongs to, so its own references resolve from there.
		/// </summary>
		IReadOnlyList<NodeEntry> GetAssemblyReferenceChildren(NodeEntry node) {
			var reference = (AssemblyRef)node.Value;
			if (OpenReferencedAssembly(node.AsModuleEntry!, reference) is not { } target)
				return [];
			return target.Module.GetAssemblyRefs()
				.OrderBy(child => child.FullName, StringComparer.OrdinalIgnoreCase)
				.Select(child => GetOrAddNode($"{node.Key}:ref:{child.MDToken.Raw:X8}", NodeKind.AssemblyReference, child, target))
				.ToArray();
		}

		/// <summary>Whether a reference can be expanded. The file is looked up but never loaded here,
		/// because this runs for every reference node of every response the tree is asked for; the load
		/// happens when the node is actually opened.</summary>
		bool HasAssemblyReferenceChildren(NodeEntry node) {
			var reference = (AssemblyRef)node.Value;
			return FindOpenModuleByName(reference.Name.String) is not null
				|| ReferencePath(node.AsModuleEntry!, reference) is not null;
		}

		/// <summary>
		/// The open module an assembly reference names: one the workspace holds already, or the file the
		/// reference resolves to, opened as an auto-loaded root. Null when nothing on this machine provides it.
		/// </summary>
		ModuleEntry? OpenReferencedAssembly(ModuleEntry owner, AssemblyRef reference) {
			if (FindOpenModuleByName(reference.Name.String) is { } open)
				return open;
			if (ReferencePath(owner, reference) is not { } path)
				return null;
			if (FindModuleEntry(path) is { } byPath)
				return byPath;
			if (IsOpen(path) || LoadEntry(path) is not ModuleEntry loaded)
				return null;
			AddRoot(loaded, autoLoaded: true);
			version++;
			return loaded;
		}

		/// <summary>
		/// The type definition a reference names, read from a module the workspace holds — the assembly its scope
		/// names is opened as an auto-loaded root when it has to be, the way dnSpy's resolver loads it — and
		/// followed through type forwarders. Null when nothing resolves.
		/// </summary>
		(TypeDef Type, ModuleEntry Module)? ResolveTypeInWorkspace(ITypeDefOrRef type, ModuleEntry owner) {
			var scope = GetScopeType(type);
			if (scope is TypeDef definition)
				return ModuleEntryOf(definition) is { } definitionModule ? (definition, definitionModule) : null;
			if (scope is not TypeRef typeRef)
				return null;
			return ResolveTypeRef(typeRef, owner, 0);
		}

		(TypeDef, ModuleEntry)? ResolveTypeRef(TypeRef typeRef, ModuleEntry owner, int depth) {
			if (depth > MaxForwarderDepth)
				return null;
			switch (typeRef.ResolutionScope) {
				case TypeRef outer:
					return ResolveTypeRef(outer, owner, depth + 1) is var (declaring, module)
						&& declaring.NestedTypes.FirstOrDefault(nested => nested.Name == typeRef.Name) is { } nestedType
						? (nestedType, module)
						: null;
				case AssemblyRef assemblyRef:
					return OpenReferencedAssembly(owner, assemblyRef) is { } target ? FindTypeInModule(target, typeRef.FullName, depth) : null;
				case ModuleRef or ModuleDef or null:
					return FindTypeInModule(owner, typeRef.FullName, depth);
				default:
					return null;
			}
		}

		(TypeDef, ModuleEntry)? FindTypeInModule(ModuleEntry module, string fullName, int depth) {
			if (GetTypeIndex(module).TryGetValue(fullName, out var found))
				return (found, module);
			foreach (var exported in module.Module.ExportedTypes) {
				if (exported.MovedToAnotherAssembly && exported.FullName == fullName && exported.Implementation is AssemblyRef target
					&& OpenReferencedAssembly(module, target) is { } forwarded)
					return depth < MaxForwarderDepth ? FindTypeInModule(forwarded, fullName, depth + 1) : null;
			}
			return null;
		}

		/// <summary>The open entry a definition lives in: a root's module, a net module, or none.</summary>
		ModuleEntry? ModuleEntryOf(IMemberDef member) {
			var module = member.Module;
			foreach (var entry in modules.Values) {
				if (ReferenceEquals(entry.Module, module))
					return entry;
			}
			foreach (var entry in netModules.Values) {
				if (ReferenceEquals(entry.Module, module))
					return entry;
			}
			return null;
		}

		// ---------------------------------------------------------------- activation

		/// <summary>
		/// What activating a row leads to — dnSpy's DocumentTabService.ActivateNode: an assembly reference to the
		/// assembly it names, a base, derived or referenced type to the type's own row, a method, property or event
		/// reference to the method it calls and a field reference to the field. A target in an assembly the
		/// workspace does not hold yet is opened first. Every other row has nothing to go to.
		/// </summary>
		public ActivateNodeResponse ActivateNode(string nodeId) {
			var node = GetNode(nodeId);
			var rootsBefore = rootOrder.Count;
			var target = node.Kind switch {
				NodeKind.AssemblyReference => node.AsModuleEntry is { } owner && OpenReferencedAssembly(owner, (AssemblyRef)node.Value) is { } assembly
					? nodes[assembly.Id]
					: null,
				NodeKind.DerivedType => node.Value is TypeDef derived && ModuleEntryOf(derived) is { } derivedModule ? GetMemberNode(derived, derivedModule) : null,
				NodeKind.BaseType => node.AsModuleEntry is { } baseOwner && ResolveTypeInWorkspace(((BaseTypeValue)node.Value).TypeDefOrRef, baseOwner) is var (baseType, baseModule)
					? GetMemberNode(baseType, baseModule)
					: null,
				NodeKind.TypeReference => node.AsModuleEntry is { } typeOwner && ResolveTypeInWorkspace(((TypeReferenceValue)node.Value).Type, typeOwner) is var (referenced, referencedModule)
					? GetMemberNode(referenced, referencedModule)
					: null,
				NodeKind.MethodReference or NodeKind.PropertyReference or NodeKind.EventReference =>
					node.AsModuleEntry is { } methodOwner ? ResolveMethodInWorkspace((IMethod)node.Value, methodOwner) : null,
				NodeKind.FieldReference => node.AsModuleEntry is { } fieldOwner ? ResolveFieldInWorkspace((MemberRef)node.Value, fieldOwner) : null,
				_ => null,
			};
			return new ActivateNodeResponse(target?.Id, rootOrder.Count != rootsBefore);
		}

		NodeEntry? ResolveMethodInWorkspace(IMethod method, ModuleEntry owner) {
			if (method is MethodSpec spec)
				method = spec.Method;
			if (method is MethodDef definition)
				return ModuleEntryOf(definition) is { } definitionModule ? GetMemberNode(definition, definitionModule) : null;
			if (method is not MemberRef memberRef || memberRef.DeclaringType is not { } declaringType)
				return null;
			if (ResolveTypeInWorkspace(declaringType, owner) is not var (type, module))
				return null;
			return type.ResolveMethod(memberRef) is { } resolved ? GetMemberNode(resolved, module) : null;
		}

		NodeEntry? ResolveFieldInWorkspace(MemberRef field, ModuleEntry owner) {
			if (field.DeclaringType is not { } declaringType || ResolveTypeInWorkspace(declaringType, owner) is not var (type, module))
				return null;
			return type.ResolveField(field) is { } resolved ? GetMemberNode(resolved, module) : null;
		}

		// ---------------------------------------------------------------- type references

		const SigComparerOptions TypeReferenceTypeOptions =
			SigComparerOptions.CompareAssemblyLocale |
			SigComparerOptions.CompareAssemblyPublicKeyToken |
			SigComparerOptions.CompareAssemblyVersion |
			SigComparerOptions.IgnoreModifiers |
			SigComparerOptions.DontProjectWinMDRefs |
			SigComparerOptions.DontCheckTypeEquivalence;

		const SigComparerOptions TypeReferenceMemberOptions = TypeReferenceTypeOptions | SigComparerOptions.PrivateScopeIsComparable;

		/// <summary>One referenced type: the generic instances of it the module uses, and its members the module
		/// calls, reads or writes. dnSpy's TypeRefInfo.</summary>
		internal sealed class TypeRefInfo {
			public readonly Dictionary<ITypeDefOrRef, TypeRefInfo> Types = new(new TypeEqualityComparer(TypeReferenceMemberOptions));
			public readonly Dictionary<IMethod, IMethod> Methods = new(new MethodEqualityComparer(TypeReferenceMemberOptions));
			public readonly Dictionary<MemberRef, MemberRef> Fields = new(new FieldEqualityComparer(TypeReferenceMemberOptions));
			public readonly Dictionary<IMethod, IMethod> Properties = new(new MethodEqualityComparer(TypeReferenceMemberOptions));
			public readonly Dictionary<IMethod, IMethod> Events = new(new MethodEqualityComparer(TypeReferenceMemberOptions));

			public bool HasChildren => Types.Count != 0 || Methods.Count != 0 || Fields.Count != 0 || Properties.Count != 0 || Events.Count != 0;
		}

		sealed record TypeReferenceIndex(string StateId, IReadOnlyDictionary<ITypeDefOrRef, TypeRefInfo> Types);

		/// <summary>A row of the Type References folder: the type, and what the module uses of it.</summary>
		sealed record TypeReferenceValue(ITypeDefOrRef Type, TypeRefInfo Info);

		/// <summary>One of the five folders under a referenced type, which share the type's info.</summary>
		sealed record TypeReferenceFolderValue(TypeReferenceValue Owner);

		/// <summary>
		/// dnSpy's MemberReferenceFinder: the TypeRef, TypeSpec, MemberRef and MethodSpec tables in row order. A
		/// type of the module's own is no reference and is left out; a generic instance is filed under its
		/// generic type, a member under its declaring type — and a member of a type that is not listed, under
		/// nothing. Methods are told apart from accessors by their names alone, the way dnSpy does it so it
		/// does not have to resolve every one.
		/// </summary>
		IReadOnlyDictionary<ITypeDefOrRef, TypeRefInfo> GetTypeReferences(ModuleEntry entry) {
			if (typeReferenceIndexes.TryGetValue(entry.Path, out var cached) && cached.StateId == stateId)
				return cached.Types;
			var module = entry.Module;
			var types = new Dictionary<ITypeDefOrRef, TypeRefInfo>(new TypeEqualityComparer(TypeReferenceTypeOptions));
			for (uint rid = 1; module.ResolveTypeRef(rid) is { } typeRef; rid++)
				AddTypeReference(types, typeRef, module);
			for (uint rid = 1; module.ResolveTypeSpec(rid) is { } typeSpec; rid++)
				AddTypeReference(types, typeSpec, module);
			for (uint rid = 1; module.ResolveMemberRef(rid) is { } memberRef; rid++) {
				if (memberRef.IsMethodRef)
					AddMethodReference(types, memberRef);
				else if (memberRef.IsFieldRef && TryGetTypeRefInfo(types, memberRef.DeclaringType, out var info))
					info.Fields[memberRef] = memberRef;
			}
			for (uint rid = 1; module.ResolveMethodSpec(rid) is { } methodSpec; rid++)
				AddMethodReference(types, methodSpec);
			typeReferenceIndexes[entry.Path] = new TypeReferenceIndex(stateId, types);
			return types;
		}

		static void AddTypeReference(Dictionary<ITypeDefOrRef, TypeRefInfo> types, ITypeDefOrRef type, ModuleDefMD module) {
			var definitionOrReference = GenericTypeOf(type);
			if (IsOwnType(definitionOrReference, module))
				return;
			if (type is TypeSpec typeSpec && (!TryGetElementType(typeSpec, out var element) || IsOwnType(element, module)))
				return;
			var dictionary = types;
			if (definitionOrReference != type && type is TypeSpec) {
				if (!types.TryGetValue(definitionOrReference, out var generic))
					return;
				dictionary = generic.Types;
			}
			dictionary.TryAdd(type, new TypeRefInfo());
		}

		static bool IsOwnType(ITypeDefOrRef type, ModuleDefMD module) {
			if (type is TypeDef)
				return true;
			if (type is TypeRef typeRef) {
				return typeRef.Scope switch {
					null => true,
					ModuleDef scope => scope == module,
					AssemblyRef assemblyRef => AssemblyNameComparer.CompareAll.Equals(assemblyRef, module.Assembly),
					ModuleRef moduleRef => StringComparer.OrdinalIgnoreCase.Equals(moduleRef.Name, module.Name),
					_ => false,
				};
			}
			return false;
		}

		/// <summary>The type a TypeSpec is built on, with its arrays, pointers and byrefs taken off.</summary>
		static bool TryGetElementType(TypeSpec typeSpec, out ITypeDefOrRef element) {
			var signature = typeSpec.TypeSig;
			while (signature is NonLeafSig)
				signature = signature.Next;
			element = signature switch {
				GenericInstSig generic => generic.GenericType?.TypeDefOrRef!,
				TypeDefOrRefSig typeDefOrRef => typeDefOrRef.TypeDefOrRef,
				_ => null!,
			};
			return element is not null;
		}

		/// <summary>The generic type a generic instance TypeSpec instantiates; any other type is itself.</summary>
		static ITypeDefOrRef GenericTypeOf(ITypeDefOrRef type) =>
			type is TypeSpec typeSpec && typeSpec.TypeSig.RemovePinnedAndModifiers() is GenericInstSig generic && generic.GenericType?.TypeDefOrRef is { } genericType
				? genericType
				: type;

		static bool TryGetTypeRefInfo(Dictionary<ITypeDefOrRef, TypeRefInfo> types, ITypeDefOrRef? declaringType, out TypeRefInfo info) {
			info = null!;
			return declaringType is not null && types.TryGetValue(GenericTypeOf(declaringType), out info!);
		}

		static void AddMethodReference(Dictionary<ITypeDefOrRef, TypeRefInfo> types, IMethod method) {
			if (!TryGetTypeRefInfo(types, method.DeclaringType, out var info))
				return;
			var name = method.Name.String;
			var dictionary = name.StartsWith("get_", StringComparison.Ordinal) || name.StartsWith("set_", StringComparison.Ordinal) ? info.Properties
				: name.StartsWith("add_", StringComparison.Ordinal) || name.StartsWith("remove_", StringComparison.Ordinal) || name.StartsWith("raise_", StringComparison.Ordinal) ? info.Events
				: info.Methods;
			dictionary.TryAdd(method, method);
		}

		/// <summary>The rows of the Type References folder, sorted the way dnSpy's TypeReferenceTreeNodeGroup sorts.</summary>
		IReadOnlyList<NodeEntry> GetTypeReferenceChildren(NodeEntry node) {
			if (node.AsModuleEntry is not { } module)
				return [];
			return TypeReferenceRows(node, module, GetTypeReferences(module));
		}

		IReadOnlyList<NodeEntry> TypeReferenceRows(NodeEntry parent, ModuleEntry module, IReadOnlyDictionary<ITypeDefOrRef, TypeRefInfo> types) => types
			.OrderBy(pair => TypeReferenceSortName(pair.Key), StringComparer.OrdinalIgnoreCase)
			.ThenBy(pair => pair.Key switch { TypeDef => 0, TypeRef => 1, _ => 2 })
			.ThenBy(pair => pair.Key.MDToken.Raw)
			.Select(pair => GetOrAddNode($"{parent.Key}:type:{pair.Key.MDToken.Raw:X8}", NodeKind.TypeReference, new TypeReferenceValue(pair.Key, pair.Value), module))
			.ToArray();

		/// <summary>The name a referenced type sorts by: the type it is built on, without its namespace, nested
		/// types after the types they are in ("Outer.Inner").</summary>
		static string TypeReferenceSortName(ITypeDefOrRef type) {
			if (type is TypeSpec typeSpec) {
				switch (typeSpec.TypeSig.RemovePinnedAndModifiers()) {
					case TypeDefOrRefSig typeDefOrRef when typeDefOrRef.TypeDefOrRef is { } element:
						type = element;
						break;
					case GenericInstSig generic when generic.GenericType?.TypeDefOrRef is { } genericType:
						type = genericType;
						break;
				}
			}
			var name = type.Name.String;
			for (var declaring = type.DeclaringType; declaring is not null; declaring = declaring.DeclaringType)
				name = $"{declaring.Name.String}.{name}";
			return name;
		}

		/// <summary>What a referenced type expands into: the folders for what the module uses of it, each only
		/// when it would hold something — Types, Methods, Fields, Properties, Events, dnSpy's order.</summary>
		IReadOnlyList<NodeEntry> GetTypeReferenceNodeChildren(NodeEntry node) {
			var value = (TypeReferenceValue)node.Value;
			var folder = new TypeReferenceFolderValue(value);
			var result = new List<NodeEntry>();
			if (value.Info.Types.Count != 0)
				result.Add(GetOrAddNode($"{node.Key}:types", NodeKind.TypeSpecsFolder, folder, node.Module));
			if (value.Info.Methods.Count != 0)
				result.Add(GetOrAddNode($"{node.Key}:methods", NodeKind.MethodReferencesFolder, folder, node.Module));
			if (value.Info.Fields.Count != 0)
				result.Add(GetOrAddNode($"{node.Key}:fields", NodeKind.FieldReferencesFolder, folder, node.Module));
			if (value.Info.Properties.Count != 0)
				result.Add(GetOrAddNode($"{node.Key}:properties", NodeKind.PropertyReferencesFolder, folder, node.Module));
			if (value.Info.Events.Count != 0)
				result.Add(GetOrAddNode($"{node.Key}:events", NodeKind.EventReferencesFolder, folder, node.Module));
			return result;
		}

		IReadOnlyList<NodeEntry> GetTypeReferenceFolderChildren(NodeEntry node) {
			var info = ((TypeReferenceFolderValue)node.Value).Owner.Info;
			var module = node.AsModuleEntry!;
			return node.Kind switch {
				NodeKind.TypeSpecsFolder => TypeReferenceRows(node, module, info.Types),
				NodeKind.MethodReferencesFolder => MemberReferenceRows(node, info.Methods.Keys.OrderBy(method => method, MethodReferenceComparer.Methods), NodeKind.MethodReference),
				NodeKind.PropertyReferencesFolder => MemberReferenceRows(node, info.Properties.Keys.OrderBy(method => method, MethodReferenceComparer.Properties), NodeKind.PropertyReference),
				NodeKind.EventReferencesFolder => MemberReferenceRows(node, info.Events.Keys.OrderBy(method => method, MethodReferenceComparer.Events), NodeKind.EventReference),
				NodeKind.FieldReferencesFolder => MemberReferenceRows(node, info.Fields.Keys
					.OrderBy(field => field.Name.String, StringComparer.OrdinalIgnoreCase)
					.ThenBy(field => field.MDToken.Raw), NodeKind.FieldReference),
				_ => [],
			};
		}

		IReadOnlyList<NodeEntry> MemberReferenceRows(NodeEntry folder, IEnumerable<IMDTokenProvider> members, NodeKind kind) => members
			.Select(member => GetOrAddNode($"{folder.Key}:{member.MDToken.Raw:X8}", kind, member, folder.Module))
			.ToArray();

		/// <summary>dnSpy's MethodRefComparer, PropertyRefComparer and EventRefComparer: by name — an accessor by
		/// the member it is for, getter before setter, adder before remover before raiser — then by parameter
		/// count, generic parameter count and token.</summary>
		sealed class MethodReferenceComparer(Func<string, (string Name, int Accessor)> split) : IComparer<IMethod> {
			public static readonly MethodReferenceComparer Methods = new(name => (name, 0));
			public static readonly MethodReferenceComparer Properties = new(name =>
				name.StartsWith("get_", StringComparison.Ordinal) ? (name[4..], 0)
				: name.StartsWith("set_", StringComparison.Ordinal) ? (name[4..], 1)
				: (name, int.MaxValue));
			public static readonly MethodReferenceComparer Events = new(name =>
				name.StartsWith("add_", StringComparison.Ordinal) ? (name[4..], 0)
				: name.StartsWith("remove_", StringComparison.Ordinal) ? (name[7..], 1)
				: name.StartsWith("raise_", StringComparison.Ordinal) ? (name[6..], 2)
				: (name, int.MaxValue));

			public int Compare(IMethod? x, IMethod? y) {
				if (ReferenceEquals(x, y))
					return 0;
				if (x is null)
					return -1;
				if (y is null)
					return 1;
				var (xName, xAccessor) = split(x.Name.String);
				var (yName, yAccessor) = split(y.Name.String);
				var result = StringComparer.OrdinalIgnoreCase.Compare(xName, yName);
				if (result != 0)
					return result;
				result = xAccessor.CompareTo(yAccessor);
				if (result != 0)
					return result;
				result = x.MethodSig.GetParamCount().CompareTo(y.MethodSig.GetParamCount());
				if (result != 0)
					return result;
				result = x.MethodSig.GetGenParamCount().CompareTo(y.MethodSig.GetGenParamCount());
				return result != 0 ? result : x.MDToken.Raw.CompareTo(y.MDToken.Raw);
			}
		}

		// ---------------------------------------------------------------- definitions in the order dnSpy sorts them

		/// <summary>dnSpy's MethodDefComparer: name, parameter count, generic parameter count, token.</summary>
		static IOrderedEnumerable<MethodDef> SortMethods(IEnumerable<MethodDef> methods) => methods
			.OrderBy(method => method.Name.String, StringComparer.OrdinalIgnoreCase)
			.ThenBy(method => method.MethodSig.GetParamCount())
			.ThenBy(method => method.MethodSig.GetGenParamCount())
			.ThenBy(method => method.MDToken.Raw);

		/// <summary>dnSpy's MemberRefComparer, which sorts its fields, properties and events: name, then token.</summary>
		static IOrderedEnumerable<T> SortByNameAndToken<T>(IEnumerable<T> members) where T : IMemberRef => members
			.OrderBy(member => member.Name.String, StringComparer.OrdinalIgnoreCase)
			.ThenBy(member => member.MDToken.Raw);

		/// <summary>dnSpy's TypeTreeNodeGroup, which sorts a namespace's types and a type's nested types alike:
		/// by full name.</summary>
		static IOrderedEnumerable<TypeDef> SortTypes(IEnumerable<TypeDef> types) => types
			.OrderBy(type => type.FullName, StringComparer.OrdinalIgnoreCase);

		// ---------------------------------------------------------------- tree text

		/// <summary>
		/// A type row's name the way the C# decompiler's FormatTypeName writes it: no namespace, no enclosing
		/// type, no keywords for the System types, and the type's own type parameters — "List&lt;T&gt;".
		/// </summary>
		static string TypeRowName(TypeDef type) =>
			CSharpTypeName.Of(null, type, CSharpTypeName.Options.DoNotUsePrimitiveTypeNames | CSharpTypeName.Options.DoNotIncludeEnclosingType) ?? type.Name.String;

		/// <summary>
		/// A method row's name the way NodeFormatter writes it: a constructor is named after its type, the
		/// parameter types follow, and a vararg method ends its list with "...".
		/// </summary>
		static void WriteMethodRowName(TextPartsBuilder output, MethodDef method, Func<ITypeDefOrRef, string>? typeColor) {
			if (method.Name == ".ctor")
				output.Write(MetadataTextColors.Of(method.DeclaringType), method.DeclaringType.Name.String);
			else
				output.Write(MetadataTextColors.Of(method), method.Name.String);
			output.Write(TextColors.Punctuation, "(");
			var first = true;
			foreach (var parameter in method.Parameters) {
				if (parameter.IsHiddenThisParameter)
					continue;
				if (!first)
					output.WriteCommaSpace();
				first = false;
				CSharpTypeName.Write(output, parameter.ParamDef, parameter.Type, typeColor);
			}
			WriteVarArgs(output, method.MethodSig);
			output.Write(TextColors.Punctuation, ")");
		}

		static void WriteVarArgs(TextPartsBuilder output, MethodSig? signature) {
			var callingConvention = signature is null ? 0 : signature.CallingConvention & CallingConvention.Mask;
			if (callingConvention is not (CallingConvention.VarArg or CallingConvention.NativeVarArg))
				return;
			if (signature!.GetParamCount() > 0)
				output.WriteCommaSpace();
			output.Write(TextColors.Operator, "...");
		}

		/// <summary>
		/// A property row's name: the decompiler's FormatPropertyName, which writes an indexer as "this[int]" —
		/// after the interface it implements explicitly, when it does — and any other property by its name.
		/// </summary>
		static void WritePropertyRowName(TextPartsBuilder output, PropertyDef property, Func<ITypeDefOrRef, string>? typeColor) {
			if (!IsIndexer(property)) {
				output.Write(MetadataTextColors.Of(property), property.Name.String);
				return;
			}
			var accessor = property.GetMethod ?? property.SetMethod;
			if (accessor is not null && accessor.HasOverrides) {
				CSharpTypeName.Write(output, null, accessor.Overrides[0].MethodDeclaration?.DeclaringType, CSharpTypeName.Options.IncludeNamespace, typeColor);
				output.Write(TextColors.Operator, ".");
			}
			output.Write(TextColors.Keyword, "this").Write(TextColors.Punctuation, "[");
			var first = true;
			foreach (var parameter in property.PropertySig.GetParams()) {
				if (!first)
					output.WriteCommaSpace();
				first = false;
				CSharpTypeName.Write(output, null, parameter.ToTypeDefOrRef(), CSharpTypeName.Options.IncludeNamespace, typeColor);
			}
			output.Write(TextColors.Punctuation, "]");
		}

		/// <summary>
		/// dnSpy's IsIndexer: a property with parameters that is its type's default member — or that implements
		/// one, for an explicit implementation, whose own type names no default member. The base property is
		/// only looked for in a module that is already loaded.
		/// </summary>
		static bool IsIndexer(PropertyDef property) {
			if (property.PropertySig.GetParamCount() == 0)
				return false;
			var accessor = property.GetMethod ?? property.SetMethod;
			var baseProperty = property;
			if (accessor is not null && accessor.HasOverrides) {
				MethodDef? baseAccessor;
				try {
					baseAccessor = accessor.Overrides[0].MethodDeclaration.ResolveMethodDef();
				}
				catch {
					baseAccessor = null;
				}
				if (baseAccessor is null)
					return false;
				baseProperty = baseAccessor.DeclaringType.Properties.FirstOrDefault(candidate => candidate.GetMethod == baseAccessor || candidate.SetMethod == baseAccessor) ?? property;
			}
			return DefaultMemberName(baseProperty.DeclaringType) == baseProperty.Name;
		}

		static string? DefaultMemberName(TypeDef? type) {
			if (type is null)
				return null;
			foreach (var attribute in type.CustomAttributes.FindAll("System.Reflection.DefaultMemberAttribute")) {
				if (attribute.ConstructorArguments.Count == 1 && attribute.ConstructorArguments[0].Value is UTF8String name)
					return name.String;
			}
			return null;
		}

		/// <summary>
		/// A method, property or event reference row: NodeFormatter.WriteMethod with the generic arguments a
		/// method instance carries (or the parameters of a generic definition), then the parameter types. An
		/// accessor reference keeps its accessor's name — "get_Count()" — the way dnSpy shows it.
		/// </summary>
		void WriteMethodReferenceName(TextPartsBuilder output, IMethod method) {
			var definition = FindLoadedMethod(method);
			var reference = method is MethodSpec spec ? spec.Method : method;
			var name = reference.Name.String;
			if (name == ".ctor")
				output.Write(reference.DeclaringType is { } declaring ? TypeColor(declaring) : TextColors.Type, reference.DeclaringType?.Name.String ?? name);
			else
				output.Write(definition is not null ? MetadataTextColors.Of(definition) : TextColors.InstanceMethod, name);
			if (method is MethodSpec { GenericInstMethodSig: { } instance }) {
				output.Write(TextColors.Punctuation, "<");
				for (var i = 0; i < instance.GenericArguments.Count; i++) {
					if (i > 0)
						output.WriteCommaSpace();
					CSharpTypeName.Write(output, null, instance.GenericArguments[i], TypeColor);
				}
				output.Write(TextColors.Punctuation, ">");
			}
			else if (definition is { GenericParameters.Count: > 0 }) {
				output.Write(TextColors.Punctuation, "<");
				for (var i = 0; i < definition.GenericParameters.Count; i++) {
					if (i > 0)
						output.WriteCommaSpace();
					output.Write(TextColors.MethodGenericParameter, definition.GenericParameters[i].Name.String);
				}
				output.Write(TextColors.Punctuation, ">");
			}
			output.Write(TextColors.Punctuation, "(");
			var parameters = reference.MethodSig?.Params ?? [];
			for (var i = 0; i < parameters.Count; i++) {
				if (i > 0)
					output.WriteCommaSpace();
				CSharpTypeName.Write(output, null, parameters[i], TypeColor);
			}
			WriteVarArgs(output, reference.MethodSig);
			output.Write(TextColors.Punctuation, ")");
		}

		/// <summary>The definition a method reference names, when the module that defines it is already loaded —
		/// never a reason to load one, since this only picks a row's color and image.</summary>
		MethodDef? FindLoadedMethod(IMethod method) {
			if (method is MethodSpec spec)
				method = spec.Method;
			if (method is MethodDef definition)
				return definition;
			if (method is not MemberRef { DeclaringType: { } declaringType } memberRef)
				return null;
			return FindLoadedType(GetScopeType(declaringType), 0)?.ResolveMethod(memberRef);
		}

		FieldDef? FindLoadedField(MemberRef field) =>
			field.DeclaringType is { } declaringType ? FindLoadedType(GetScopeType(declaringType), 0)?.ResolveField(field) : null;

		/// <summary>The property or event an accessor belongs to, from its declaring type.</summary>
		static IMemberDef? OwnerOfAccessor(MethodDef? method, NodeKind kind) {
			if (method?.DeclaringType is not { } type)
				return null;
			return kind == NodeKind.PropertyReference
				? type.Properties.FirstOrDefault(property => property.GetMethod == method || property.SetMethod == method)
				: type.Events.FirstOrDefault(@event => @event.AddMethod == method || @event.RemoveMethod == method || @event.InvokeMethod == method);
		}

		/// <summary>The scope dnSpy's reference tooltips end with: the assembly a reference points into, or
		/// the module.</summary>
		static string ScopeText(IScope? scope) => scope switch {
			AssemblyRef assemblyRef => assemblyRef.FullName,
			ModuleRef moduleRef => moduleRef.Name.String,
			ModuleDef moduleDef => moduleDef.Name.String,
			_ => "???",
		};

		/// <summary>
		/// A row's tooltip, line by line, the way its WPF node writes one with DocumentNodeWriteOptions.ToolTip:
		/// an assembly or module names itself, the framework it targets, the platform and the file; a member
		/// gives its signature, its declaring type and the file; a reference gives what it resolves to and the
		/// assembly it points into.
		/// </summary>
		string? GetToolTip(NodeEntry node) {
			var file = (node.Module as IModuleEntry)?.Path;
			switch (node.Kind) {
				case NodeKind.Assembly when node.Value is AssemblyDef assembly && assembly.ManifestModule is { } manifest:
					return Lines(assembly.FullName, TargetFrameworkInfo.DisplayName(manifest), TargetFrameworkInfo.ArchString(manifest), file);
				case NodeKind.Assembly or NodeKind.Module when node.Value is ModuleDef module:
					return Lines(module.Name.String, TargetFrameworkInfo.DisplayName(module), TargetFrameworkInfo.ArchString(module), module.Location is { Length: > 0 } location ? location : file);
				case NodeKind.Namespace:
					return Lines($"namespace {((NamespaceValue)node.Value).Name}", file);
				case NodeKind.Type or NodeKind.Method or NodeKind.Field or NodeKind.Property or NodeKind.Event or NodeKind.DerivedType:
					return Lines(MemberToolTip((IMemberDef)node.Value), ((IMemberDef)node.Value).DeclaringType is { } declaringType ? MemberToolTip(declaringType) : null, file);
				case NodeKind.BaseType:
					var baseType = ((BaseTypeValue)node.Value).TypeDefOrRef;
					return Lines(baseType.FullName, file);
				case NodeKind.AssemblyReference:
					return Lines(((AssemblyRef)node.Value).FullName, file);
				case NodeKind.ModuleReference:
					return Lines(((ModuleRef)node.Value).Name.String, file);
				case NodeKind.TypeReference:
					var type = ((TypeReferenceValue)node.Value).Type;
					return Lines(type.FullName, ScopeText(type.Scope));
				case NodeKind.MethodReference or NodeKind.PropertyReference or NodeKind.EventReference:
					var method = (IMethod)node.Value;
					var definition = FindLoadedMethod(method);
					var shown = node.Kind == NodeKind.MethodReference ? definition : OwnerOfAccessor(definition, node.Kind);
					return Lines(shown is not null ? MemberToolTip(shown) : method.FullName, method.DeclaringType?.FullName, ScopeText(method.DeclaringType?.Scope));
				case NodeKind.FieldReference:
					var field = (MemberRef)node.Value;
					return Lines(FindLoadedField(field) is { } fieldDef ? MemberToolTip(fieldDef) : field.FullName, field.DeclaringType?.FullName, ScopeText(field.DeclaringType?.Scope));
				case NodeKind.TypeReferencesGroup or NodeKind.ReferencesGroup or NodeKind.ResourcesGroup:
					return Lines(GetLabel(node), file);
				case NodeKind.TypeSpecsFolder or NodeKind.MethodReferencesFolder or NodeKind.PropertyReferencesFolder or NodeKind.EventReferencesFolder or NodeKind.FieldReferencesFolder:
					return Lines(GetLabel(node), ScopeText(((TypeReferenceFolderValue)node.Value).Owner.Type.Scope));
				case NodeKind.Resource or NodeKind.ResourceEntry:
					return ResourceToolTip(node);
				default:
					return null;
			}
		}

		static string MemberToolTip(IMemberDef member) {
			var output = new TextPartsBuilder();
			CSharpMemberFormatter.Write(output, member,
				CSharpMemberFormatter.Options.ParameterTypes | CSharpMemberFormatter.Options.ParameterNames | CSharpMemberFormatter.Options.DeclaringTypes
				| CSharpMemberFormatter.Options.ReturnTypes | CSharpMemberFormatter.Options.Namespaces | CSharpMemberFormatter.Options.IntrinsicTypeKeywords);
			return output.ToString();
		}

		static string Lines(params string?[] lines) => string.Join('\n', lines.Where(line => !string.IsNullOrEmpty(line)));

		/// <summary>
		/// The page dnSpy's Search MSDN opens for a row (SearchMsdnCommand.GetAddress): a namespace by its name, a
		/// member after its declaring type with the dots in its own name made dashes, an accessor as the member it
		/// belongs to and an enum value as its enum. Only members outside code can see are offered — public or
		/// protected, in a type that is public all the way out. A row that names a reference — a base or derived
		/// type, a referenced type or member — is looked up as the definition it resolves to, the way dnSpy resolves
		/// the IMDTokenNode's reference; one whose definition is not loaded has nothing to look up.
		/// </summary>
		string? GetMsdnName(NodeEntry node) {
			if (node.Kind == NodeKind.Namespace)
				return ((NamespaceValue)node.Value).Name is { Length: > 0 } name ? name : null;
			if (MsdnMember(node) is not { } member)
				return null;
			if (member is MethodDef method && FindOwningPropertyOrEvent(method) is IMemberDef owner)
				member = owner;
			if (!IsPublicApi(member))
				return null;
			if (member is FieldDef { IsLiteral: true, DeclaringType: { IsEnum: true } enumType })
				member = enumType;
			var address = member.DeclaringType is null
				? member.FullName
				: $"{member.DeclaringType.FullName}.{member.Name.String.Replace('.', '-')}";
			return address.Replace('/', '.').Replace('`', '-');
		}

		/// <summary>The definition behind a row Search MSDN can be offered on — SearchMsdnCtxMenuCommand.ResolveDef.</summary>
		IMemberDef? MsdnMember(NodeEntry node) => node.Kind switch {
			NodeKind.Type or NodeKind.Method or NodeKind.Field or NodeKind.Property or NodeKind.Event or NodeKind.DerivedType => node.Value as IMemberDef,
			NodeKind.BaseType => FindLoadedType(GetScopeType(((BaseTypeValue)node.Value).TypeDefOrRef), 0),
			NodeKind.TypeReference => FindLoadedType(GetScopeType(((TypeReferenceValue)node.Value).Type), 0),
			NodeKind.MethodReference or NodeKind.PropertyReference or NodeKind.EventReference => FindLoadedMethod((IMethod)node.Value),
			NodeKind.FieldReference => FindLoadedField((MemberRef)node.Value),
			_ => null,
		};

		/// <summary>
		/// What dnSpy's Copy Full Name writes for a row: the <c>IFullName</c> of the metadata the row stands for
		/// (its IMDTokenNode's reference) — an assembly's display name, a module's name, a type's or a member's full
		/// name, and a reference's. A row that stands for no metadata row — a namespace, a folder, a resource, a
		/// structure — has none, and dnSpy does not offer the command on it.
		/// </summary>
		static string? GetFullName(NodeEntry node) => node.Kind switch {
			NodeKind.Assembly or NodeKind.Module or NodeKind.Type or NodeKind.Method or NodeKind.Field or NodeKind.Property or NodeKind.Event
				or NodeKind.DerivedType or NodeKind.AssemblyReference or NodeKind.ModuleReference
				or NodeKind.MethodReference or NodeKind.PropertyReference or NodeKind.EventReference or NodeKind.FieldReference => (node.Value as IFullName)?.FullName,
			NodeKind.BaseType => ((BaseTypeValue)node.Value).TypeDefOrRef.FullName,
			NodeKind.TypeReference => ((TypeReferenceValue)node.Value).Type.FullName,
			_ => null,
		};

		static bool IsPublicType(TypeDef? type) {
			if (type is null)
				return false;
			for (; type.DeclaringType is not null; type = type.DeclaringType) {
				if (type.Visibility is TypeAttributes.NotPublic or TypeAttributes.NestedPrivate or TypeAttributes.NestedAssembly or TypeAttributes.NestedFamANDAssem)
					return false;
			}
			return type.IsPublic;
		}

		/// <summary>
		/// Whether the C# and VB decompilers hide a row — dnSpy's ShowMember, which asks AstBuilder.MemberIsHidden:
		/// closures, state machines, backing fields and the compiler's other inventions. The IL view hides nothing;
		/// the client decides which view the tree answers to.
		/// </summary>
		static bool IsCompilerGenerated(NodeEntry node) => node.Kind switch {
			NodeKind.Type or NodeKind.Method or NodeKind.Field or NodeKind.Property or NodeKind.Event or NodeKind.DerivedType =>
				node.Value is IMemberDef member && CompilerGeneratedMembers.IsHidden(member),
			_ => false,
		};

		// ---------------------------------------------------------------- command line --select

		/// <summary>
		/// dnSpy's AppCommandLineArgsHandler.SelectMember over the files a command line opened. A number — decimal,
		/// or hexadecimal after "0x" or "&amp;H" — is a token in the first module of them, followed to its
		/// definition the way Go to Token follows one. Otherwise each module is asked in turn: "N:" names one of its
		/// namespaces, anything else is an XML documentation id, read the Roslyn way and then the MSVC way.
		/// </summary>
		public SelectMemberResponse SelectMember(IReadOnlyList<string> paths, string member) {
			var loaded = paths.SelectMany(LoadedModulesOf).ToList();
			if (TryParseCommandLineToken(member, out var token))
				return new SelectMemberResponse(loaded.FirstOrDefault() is { } first ? FindTokenNode(first, token).NodeId : null);
			const string NamespacePrefix = "N:";
			foreach (var module in loaded) {
				if (member.StartsWith(NamespacePrefix, StringComparison.Ordinal)) {
					var ns = member[NamespacePrefix.Length..];
					if (GetNamespaceIndex(module).Groups.TryGetValue(ns, out var group))
						return new SelectMemberResponse(GetOrAddNode($"module:{module.Path}:namespace:{ns}", NodeKind.Namespace, new NamespaceValue(ns, group), module).Id);
					continue;
				}
				var found = XmlDocKeyProvider.FindMemberByKey(module.Module, member) ?? XmlDocKeyProvider.FindMemberByKey(module.Module, member, XmlDocCompiler.MSVC);
				if (found is IMemberDef definition)
					return new SelectMemberResponse(GetMemberNode(definition, module).Id);
			}
			return new SelectMemberResponse(null);
		}

		/// <summary>dnSpy's GetLoadedFiles: an open assembly stands for each of its modules, a module for itself.</summary>
		IEnumerable<ModuleEntry> LoadedModulesOf(string path) {
			string fullPath;
			try {
				fullPath = Path.GetFullPath(path);
			}
			catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException) {
				yield break;
			}
			foreach (var module in OrderedModules()) {
				if (!SameFile(module.Path, fullPath))
					continue;
				yield return module;
				foreach (var netModule in netModules.Values.Where(entry => entry.Id == module.Id))
					yield return netModule;
			}
		}

		/// <summary>dnSpy's SimpleTypeConverter.ParseUInt32: decimal, or hexadecimal after "0x" or "&amp;H", with
		/// "_" as a digit separator.</summary>
		static bool TryParseCommandLineToken(string text, out uint token) {
			token = 0;
			var digits = text.Trim().Replace("_", string.Empty, StringComparison.Ordinal);
			if (digits.StartsWith("0x", StringComparison.OrdinalIgnoreCase) || digits.StartsWith("&H", StringComparison.OrdinalIgnoreCase)) {
				var hex = digits[2..];
				return hex.Trim() == hex && uint.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out token);
			}
			return uint.TryParse(digits, NumberStyles.Integer, CultureInfo.InvariantCulture, out token);
		}

		// ---------------------------------------------------------------- netmodules

		/// <summary>
		/// The modules an assembly row holds: the manifest module, which is the file the row was opened from,
		/// and then the net modules its File table names — dnSpy lists every module in <c>AssemblyDef.Modules</c>.
		/// </summary>
		IReadOnlyList<NodeEntry> GetAssemblyChildren(NodeEntry node) {
			var moduleEntry = node.AsModuleEntry!;
			var result = new List<NodeEntry> { GetOrAddNode($"module:{moduleEntry.Path}", NodeKind.Module, moduleEntry.Module, moduleEntry) };
			if (node.Value is not AssemblyDef assembly)
				return result;
			IList<ModuleDef> assemblyModules;
			try {
				assemblyModules = assembly.Modules;
			}
			catch (Exception ex) when (ex is BadImageFormatException or IOException) {
				return result;
			}
			foreach (var module in assemblyModules) {
				if (ReferenceEquals(module, moduleEntry.Module))
					continue;
				// A net module an edit added — a new one with no file among them — is an entry already.
				if (netModules.Values.FirstOrDefault(candidate => ReferenceEquals(candidate.Module, module)) is { } added) {
					result.Add(GetOrAddNode($"module:{added.Path}", NodeKind.Module, added.Module, added));
					continue;
				}
				if (module is not ModuleDefMD netModule || string.IsNullOrEmpty(netModule.Location) || !File.Exists(netModule.Location))
					continue;
				if (!netModules.TryGetValue(netModule.Location, out var entry)) {
					entry = new ModuleEntry(netModule.Location, netModule) { Id = moduleEntry.Id };
					netModules.Add(netModule.Location, entry);
				}
				result.Add(GetOrAddNode($"module:{netModule.Location}", NodeKind.Module, netModule, entry));
			}
			return result;
		}
	}
}
