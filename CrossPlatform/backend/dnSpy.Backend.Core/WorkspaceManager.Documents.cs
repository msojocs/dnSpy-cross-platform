using dnlib.DotNet;
using dnlib.DotNet.MD;
using dnlib.PE;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.Editing;

namespace dnSpy.Backend.Core;

/// <summary>
/// dnSpy's commands that make documents or move modules between them: Create Assembly and Create NetModule, which make
/// a document with no file — saving it is what gives it one — and Add New / Add Existing / Remove NetModule, which
/// change the modules an assembly is made of. Each is one undoable step.
/// </summary>
public sealed partial class WorkspaceManager {
	/// <summary>An empty workspace, for a document a command makes before anything was opened.</summary>
	public OpenWorkspaceResponse CreateWorkspace() {
		ObjectDisposedException.ThrowIf(disposed, this);
		var workspace = new Workspace(symbols);
		if (!workspaces.TryAdd(workspace.Id, workspace)) {
			workspace.Dispose();
			throw new InvalidOperationException("Could not register the workspace.");
		}
		return workspace.CreateOpenResponse();
	}

	public Task<CreateDocumentResponse> QueueCreateAssemblyAsync(CreateAssemblyRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.QueueCreateAssembly(request), cancellationToken);

	public Task<CreateDocumentResponse> QueueCreateNetModuleAsync(CreateNetModuleRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.QueueCreateNetModule(request), cancellationToken);

	public Task<CreateDocumentResponse> QueueAddNetModuleAsync(AddNetModuleRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.QueueAddNetModule(request), cancellationToken);

	public Task QueueRemoveNetModuleAsync(RemoveNetModuleRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => {
			w.QueueRemoveNetModule(request);
			return true;
		}, cancellationToken);

	public Task<NetModuleDefaultsResponse> GetNetModuleDefaultsAsync(NetModuleDefaultsRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetNetModuleDefaults(request.AssemblyNodeId), cancellationToken);

	/// <summary>dnSpy's ClrVersionValues: what a module made for each .NET version says it was made for.</summary>
	sealed record ClrValues(string Version, uint Cor20HeaderRuntimeVersion, ushort TablesHeaderVersion, string RuntimeVersion, Func<AssemblyRef> CorLibRef) {
		public static readonly ClrValues[] All = [
			new(ClrVersions.Clr10, 0x00020000, 0x0100, MDHeaderRuntimeVersion.MS_CLR_10, AssemblyRefUser.CreateMscorlibReferenceCLR10),
			new(ClrVersions.Clr11, 0x00020000, 0x0100, MDHeaderRuntimeVersion.MS_CLR_11, AssemblyRefUser.CreateMscorlibReferenceCLR11),
			new(ClrVersions.Clr20, 0x00020005, 0x0200, MDHeaderRuntimeVersion.MS_CLR_20, AssemblyRefUser.CreateMscorlibReferenceCLR20),
			new(ClrVersions.Clr40, 0x00020005, 0x0200, MDHeaderRuntimeVersion.MS_CLR_40, AssemblyRefUser.CreateMscorlibReferenceCLR40),
		];

		public static ClrValues Of(string? version) =>
			All.FirstOrDefault(values => values.Version == version)
			?? throw new RpcException(ErrorCodes.EditValidationFailed, $"Unknown .NET version '{version}'.");
	}

	sealed partial class Workspace {
		/// <summary>
		/// dnSpy's ModuleUtils.CreateModule: a module named and numbered as the window says, referencing the corlib of
		/// the .NET version it is made for, with the kind, characteristics and DLL characteristics dnSpy gives a new
		/// one. The workspace reads every module as a file image, so the new one is written out and read back — it is
		/// the same module either way, and nothing on disk is involved.
		/// </summary>
		static ModuleDefMD CreateModule(string name, Guid mvid, string clrVersion, ModuleKind kind, Action<ModuleDefUser>? fill = null) {
			var values = ClrValues.Of(clrVersion);
			var module = new ModuleDefUser(name, mvid, values.CorLibRef());
			module.UpdateRowId(module);
			module.RuntimeVersion = values.RuntimeVersion;
			module.Cor20HeaderRuntimeVersion = values.Cor20HeaderRuntimeVersion;
			module.TablesHeaderVersion = values.TablesHeaderVersion;
			module.Location = string.Empty;
			module.Kind = kind;
			module.Characteristics = Characteristics.Bit32Machine | Characteristics.ExecutableImage;
			if (kind is ModuleKind.Dll or ModuleKind.NetModule)
				module.Characteristics |= Characteristics.Dll;
			module.DllCharacteristics = DllCharacteristics.TerminalServerAware | DllCharacteristics.NoSeh | DllCharacteristics.NxCompat | DllCharacteristics.DynamicBase;
			fill?.Invoke(module);
			using var stream = new MemoryStream();
			module.Write(stream);
			return ModuleDefMD.Load(stream.ToArray());
		}

		/// <summary>The name the workspace gives a document with no file: a path nothing will ever be at.</summary>
		static string InMemoryPath(string name) =>
			Path.Combine(Path.GetTempPath(), $"dnSpy-in-memory-{Guid.NewGuid():N}", string.IsNullOrWhiteSpace(name) ? "module" : name);

		/// <summary>A document that exists only here: modified from the moment it is made, the way dnSpy marks it.</summary>
		static ModuleEntry InMemoryEntry(ModuleDefMD module, string name) => new(InMemoryPath(name), module, fileLength: 0) {
			InMemory = true,
			HasModelEdits = true,
			SavedHistoryId = -1,
		};

		/// <summary>
		/// Adds a new document as a root, as a step of the transaction: the node is made now, so the client can be
		/// told which one to select, and the document joins the tree when the step runs. Undo takes it out the way a
		/// removal does, and redo puts the very same nodes back.
		/// </summary>
		CreateDocumentResponse QueueNewRoot(EditTransaction transaction, ModuleEntry entry) {
			var root = GetOrAddNode($"assembly:{entry.Path}", NodeKind.Assembly, entry.Module.Assembly ?? (object)entry.Module, entry);
			entry.Id = root.Id;
			DetachedRoot? detached = null;
			transaction.Operations.Add(new EditOperation(root.Id, entry, () => {
				if (detached is null) {
					modules.Add(entry.Id, entry);
					rootOrder.Add(entry.Id);
					NoteModelChanged();
				}
				else {
					ReattachRoot(detached);
				}
				return () => detached = DetachRoot(entry);
			}, ChangesRoots: true));
			return new CreateDocumentResponse(root.Id, GetLabel(root));
		}

		/// <summary>
		/// dnSpy's CreateAssemblyCommand: an assembly made from the Edit Assembly window's model, with one module of the
		/// .NET version picked — named after the assembly, a DLL — added at the end of the tree.
		/// </summary>
		public CreateDocumentResponse QueueCreateAssembly(CreateAssemblyRequest request) {
			var transaction = GetTransaction(request.TransactionId);
			var options = request.Options;
			if (string.IsNullOrWhiteSpace(options.Name))
				throw new RpcException(ErrorCodes.EditValidationFailed, "The assembly needs a name.");
			PublicKey publicKey;
			try {
				publicKey = new PublicKey(Convert.FromHexString(options.PublicKey ?? string.Empty));
			}
			catch (FormatException ex) {
				throw new RpcException(ErrorCodes.EditValidationFailed, "The public key is not hexadecimal.", null, ex);
			}
			var module = CreateModule(options.Name, Guid.NewGuid(), request.ClrVersion, ModuleKind.Dll, created => {
				var context = new EditContext(created);
				var assembly = created.UpdateRowId(new AssemblyDefUser(options.Name, new Version(options.VersionMajor, options.VersionMinor, options.VersionBuild, options.VersionRevision), publicKey, string.IsNullOrEmpty(options.Culture) ? UTF8String.Empty : options.Culture) {
					HashAlgorithm = (AssemblyHashAlgorithm)options.HashAlgorithm,
					Attributes = (AssemblyAttributes)options.Attributes,
				});
				foreach (var attribute in context.Attributes.FromDtoList(options.CustomAttributes))
					assembly.CustomAttributes.Add(attribute);
				foreach (var security in context.DeclSecurities.FromDtoList(options.DeclSecurities))
					assembly.DeclSecurities.Add(security);
				assembly.Modules.Add(created);
			});
			return QueueNewRoot(transaction, InMemoryEntry(module, $"{options.Name}.dll"));
		}

		/// <summary>dnSpy's CreateNetModuleCommand: a net module of its own, added at the end of the tree.</summary>
		public CreateDocumentResponse QueueCreateNetModule(CreateNetModuleRequest request) {
			var transaction = GetTransaction(request.TransactionId);
			var module = CreateModule(request.Name ?? string.Empty, ParseMvid(request.Mvid), request.ClrVersion, ModuleKind.NetModule);
			return QueueNewRoot(transaction, InMemoryEntry(module, request.Name ?? string.Empty));
		}

		static Guid ParseMvid(string? text) => Guid.TryParse(text, out var mvid)
			? mvid
			: throw new RpcException(ErrorCodes.EditValidationFailed, "Invalid GUID");

		/// <summary>The assembly a node is in, with the root that holds it — the module row of a net module names it too.</summary>
		(AssemblyDef Assembly, ModuleEntry Root) AssemblyAndRootOf(NodeEntry node) {
			var entry = ModuleOf(node) ?? throw new RpcException(ErrorCodes.EditValidationFailed, "The selected item is not part of an assembly.");
			var root = modules.TryGetValue(entry.Id, out var owner) ? owner : entry;
			var assembly = root.Module.Assembly ?? throw new RpcException(ErrorCodes.EditValidationFailed, "The selected item is not part of an assembly.");
			return (assembly, root);
		}

		/// <summary>dnSpy's NetModuleOptionsVM for an assembly: the .NET version its manifest module was made for, 4.0
		/// when that is none dnSpy knows.</summary>
		public NetModuleDefaultsResponse GetNetModuleDefaults(string assemblyNodeId) {
			var (_, root) = AssemblyAndRootOf(GetNode(assemblyNodeId));
			var module = root.Module;
			var match = ClrValues.All.FirstOrDefault(values =>
				values.Cor20HeaderRuntimeVersion == module.Cor20HeaderRuntimeVersion
				&& values.TablesHeaderVersion == module.TablesHeaderVersion
				&& values.RuntimeVersion == module.RuntimeVersion);
			return new NetModuleDefaultsResponse(match?.Version ?? ClrVersions.Clr40);
		}

		/// <summary>
		/// dnSpy's AddNewNetModuleToAssemblyCommand and AddExistingNetModuleToAssemblyCommand: a new net module, or the
		/// one in a file — which must be a net module, a module with no assembly of its own — joins the assembly's
		/// modules. The assembly is what is modified; a new net module is a document with no file, modified from the
		/// start, while one read from a file is as it was.
		/// </summary>
		public CreateDocumentResponse QueueAddNetModule(AddNetModuleRequest request) {
			var transaction = GetTransaction(request.TransactionId);
			var (assembly, root) = AssemblyAndRootOf(GetNode(request.AssemblyNodeId));
			ModuleEntry entry;
			if (request.Path is { Length: > 0 } path) {
				var fullPath = Path.GetFullPath(path);
				ModuleDefMD? loaded = null;
				try {
					loaded = ModuleDefMD.Load(fullPath);
				}
				catch (Exception ex) when (ex is IOException or BadImageFormatException or UnauthorizedAccessException) {
				}
				if (loaded is null || loaded.Assembly is not null) {
					loaded?.Dispose();
					throw new RpcException(ErrorCodes.EditValidationFailed, $"{fullPath} is not a NetModule");
				}
				entry = new ModuleEntry(fullPath, loaded) { Id = root.Id };
			}
			else {
				var module = CreateModule(request.Name ?? string.Empty, ParseMvid(request.Mvid), request.ClrVersion ?? ClrVersions.Clr40, ModuleKind.NetModule);
				entry = InMemoryEntry(module, request.Name ?? string.Empty);
				entry.Id = root.Id;
			}
			var node = GetOrAddNode($"module:{entry.Path}", NodeKind.Module, entry.Module, entry);
			transaction.Add(node.Id, root, () => {
				assembly.Modules.Add(entry.Module);
				netModules[entry.Path] = entry;
				NoteModelChanged();
				return () => {
					assembly.Modules.Remove(entry.Module);
					netModules.Remove(entry.Path);
					NoteModelChanged();
				};
			});
			return new CreateDocumentResponse(node.Id, GetLabel(node));
		}

		/// <summary>
		/// dnSpy's RemoveNetModuleFromAssemblyCommand: a module of the assembly other than its manifest one leaves it.
		/// The assembly is modified; the net module itself is not, and undo puts it back where it was.
		/// </summary>
		public void QueueRemoveNetModule(RemoveNetModuleRequest request) {
			var transaction = GetTransaction(request.TransactionId);
			var node = GetNode(request.ModuleNodeId);
			if (node.Kind != NodeKind.Module || node.AsModuleEntry is not { } entry)
				throw new RpcException(ErrorCodes.EditValidationFailed, "Select a net module of an assembly.");
			var (assembly, root) = AssemblyAndRootOf(node);
			var index = assembly.Modules.IndexOf(entry.Module);
			if (index <= 0)
				throw new RpcException(ErrorCodes.EditValidationFailed, "The manifest module cannot be removed from its assembly.");
			transaction.Add(node.Id, root, () => {
				assembly.Modules.RemoveAt(index);
				netModules.Remove(entry.Path);
				NoteModelChanged();
				return () => {
					assembly.Modules.Insert(index, entry.Module);
					netModules[entry.Path] = entry;
					NoteModelChanged();
				};
			});
		}
	}
}
