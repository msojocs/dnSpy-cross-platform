using System.Collections.Concurrent;
using System.Globalization;
using System.Reflection;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Resources;
using System.Security.Cryptography;
using System.Text;
using dnlib.DotNet;
using dnlib.DotNet.Emit;
using dnlib.PE;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.Editing;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.CSharp.OutputVisitor;
using ICSharpCode.Decompiler.CSharp.Syntax;
using ICSharpCode.Decompiler.Disassembler;
using ICSharpCode.CodeConverter;
using ICSharpCode.BamlDecompiler;
using DecompilerAstNode = ICSharpCode.Decompiler.CSharp.Syntax.AstNode;
using DecompilerILFunction = ICSharpCode.Decompiler.IL.ILFunction;
// Imported by alias: the namespace itself would make dnlib's Parameter ambiguous with the metadata one.
using PdbReaderProvider = System.Reflection.Metadata.MetadataReaderProvider;
using DecompilerILVariable = ICSharpCode.Decompiler.IL.ILVariable;
using DecompilerVariableKind = ICSharpCode.Decompiler.IL.VariableKind;
using DecompilerIMember = ICSharpCode.Decompiler.TypeSystem.IMember;
using DecompilerIType = ICSharpCode.Decompiler.TypeSystem.IType;
using DecompilerMetadataFile = ICSharpCode.Decompiler.Metadata.MetadataFile;

namespace dnSpy.Backend.Core;

public sealed partial class WorkspaceManager : IDisposable, IDebugSymbolResolver, IDebugSourceProvider {
	const int MaxHexReadLength = 1024 * 1024;
	readonly ConcurrentDictionary<string, Workspace> workspaces = new(StringComparer.Ordinal);
	readonly SymbolResolver symbols = new();
	bool disposed;

	public async Task<OpenWorkspaceResponse> OpenAsync(OpenWorkspaceRequest request, CancellationToken cancellationToken) {
		ObjectDisposedException.ThrowIf(disposed, this);
		if (request.Paths.Count == 0)
			throw new RpcException(ErrorCodes.InvalidParams, "At least one path is required.");

		var paths = ExpandPaths(request.Paths);
		if (paths.Count == 0)
			throw new RpcException(ErrorCodes.FileNotFound, "No managed assemblies were found in the selected paths.");

		var workspace = new Workspace(symbols);
		try {
			await workspace.OpenAsync(paths, cancellationToken).ConfigureAwait(false);
			if (!workspaces.TryAdd(workspace.Id, workspace))
				throw new InvalidOperationException("Could not register the workspace.");
			return workspace.CreateOpenResponse();
		}
		catch {
			workspace.Dispose();
			throw;
		}
	}

	public Task<AddModulesResponse> AddModulesAsync(AddModulesRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.AddModulesAsync(request, cancellationToken), cancellationToken);

	public void Close(WorkspaceRequest request) {
		if (workspaces.TryRemove(request.WorkspaceId, out var workspace))
			workspace.Dispose();
	}

	public Task<TreeNodesResponse> GetRootsAsync(WorkspaceRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetRoots(), cancellationToken);

	public Task<TreeNodesResponse> GetChildrenAsync(NodeRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetChildren(request.NodeId), cancellationToken);

	public Task<TreeNodeDto> GetNodeAsync(NodeRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetNodeDto(request.NodeId), cancellationToken);

	public Task<TreeNodesResponse> GetNodePathAsync(NodeRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetNodePath(request.NodeId), cancellationToken);

	public Task<DecompileResponse> DecompileAsync(DecompileRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).DecompileDocumentAsync(request, cancellationToken);

	public Task<FindMemberResponse> FindMemberAsync(FindMemberRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.FindMemberAsync(request.ModulePath, request.MetadataToken, cancellationToken), cancellationToken);

	public Task<HexLengthResponse> GetHexLengthAsync(HexLengthRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetHexLength(request.ModuleId), cancellationToken);

	public async Task<HexReadResponse> ReadHexAsync(HexReadRequest request, CancellationToken cancellationToken) {
		if (request.Offset < 0 || request.Count < 0)
			throw new RpcException(ErrorCodes.InvalidParams, "Offset and count must not be negative.");
		if (request.Count > MaxHexReadLength)
			throw new RpcException(ErrorCodes.RangeTooLarge, $"A hex read is limited to {MaxHexReadLength} bytes.");
		return await GetWorkspace(request.WorkspaceId).RunAsync(
			w => w.ReadHexAsync(request.ModuleId, request.Offset, request.Count, cancellationToken),
			cancellationToken).ConfigureAwait(false);
	}

	public Task<HexTargetResponse> ResolveHexTargetAsync(HexTargetRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.ResolveHexTarget(request.NodeId), cancellationToken);

	public Task<HexStatementResponse> ResolveHexStatementAsync(HexStatementRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.ResolveHexStatement(request), cancellationToken);

	public Task<HexResolvePositionResponse> ResolveHexPositionAsync(HexResolvePositionRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.ResolveHexPosition(request), cancellationToken);

	public Task<HexGoToMetadataResponse> GoToHexMetadataAsync(HexGoToMetadataRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GoToHexMetadata(request), cancellationToken);

	public Task<HexFindResponse> FindHexAsync(HexFindRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.FindHexAsync(request, cancellationToken), cancellationToken);

	public Task QueueHexPatchAsync(HexPatchRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => {
			w.QueueHexPatch(request);
			return true;
		}, cancellationToken);

	public Task<ModuleInfoResponse> GetModuleInfoAsync(ModuleInfoRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetModuleInfo(request.ModuleId), cancellationToken);

	public Task<BeginEditResponse> BeginEditAsync(BeginEditRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.BeginEdit(), cancellationToken);

	public Task<MethodBodyResponse> GetMethodBodyAsync(MethodBodyRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetMethodBody(request.MethodNodeId), cancellationToken);

	public Task<NodeOptionsDto> GetOptionsAsync(GetNodeOptionsRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetOptions(request), cancellationToken);

	public Task<EditNodeResponse> QueueCreateAsync(CreateNodeRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.QueueCreate(request), cancellationToken);

	public Task<EditNodeResponse> QueueSetOptionsAsync(SetNodeOptionsRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.QueueSetOptions(request), cancellationToken);

	public Task QueueRenameAsync(RenameEditRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => {
			w.QueueRename(request);
			return true;
		}, cancellationToken);

	public Task QueueDeleteAsync(DeleteEditRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => {
			w.QueueDelete(request);
			return true;
		}, cancellationToken);

	public Task QueueSetNamespaceAsync(SetNamespaceEditRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => {
			w.QueueSetNamespace(request);
			return true;
		}, cancellationToken);

	public Task QueueMethodBodyAsync(ReplaceMethodBodyRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => {
			w.QueueMethodBody(request);
			return true;
		}, cancellationToken);

	public Task QueueMethodBodyStubAsync(ReplaceMethodBodyWithStubRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => {
			w.QueueMethodBodyStub(request);
			return true;
		}, cancellationToken);

	public Task QueueResourceAsync(ReplaceResourceRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => {
			w.QueueResource(request);
			return true;
		}, cancellationToken);

	public Task QueueConvertModuleAsync(ConvertModuleRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => {
			w.QueueConvertModule(request);
			return true;
		}, cancellationToken);

	public Task<EditCommitResponse> CommitEditAsync(EditTransactionRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.CommitEdit(request.TransactionId), cancellationToken);

	public Task RollbackEditAsync(EditTransactionRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => {
			w.RollbackEdit(request.TransactionId);
			return true;
		}, cancellationToken);

	public Task<EditCommitResponse> UndoAsync(WorkspaceRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.Undo(), cancellationToken);

	public Task<EditCommitResponse> RedoAsync(WorkspaceRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.Redo(), cancellationToken);

	public Task<SaveModuleResponse> SaveModuleAsync(SaveModuleRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.SaveModuleAsync(request, cancellationToken), cancellationToken);

	public Task<SaveModuleResponse> SaveModuleInPlaceAsync(SaveModuleInPlaceRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.SaveModuleInPlaceAsync(request, cancellationToken), cancellationToken);

	public Task<SaveAllResponse> SaveAllModulesAsync(WorkspaceRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.SaveAllModulesAsync(cancellationToken), cancellationToken);

	public Task<OpenWorkspaceResponse> ReloadAsync(WorkspaceRequest request, CancellationToken cancellationToken) =>
		ReloadAsync(new ReloadWorkspaceRequest(request.WorkspaceId), cancellationToken);

	public Task<OpenWorkspaceResponse> ReloadAsync(ReloadWorkspaceRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.ReloadAsync(request.AutoLoadedPaths, cancellationToken), cancellationToken);

	public Task<TreeNodesResponse> SortAssembliesAsync(WorkspaceRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.SortAssemblies(), cancellationToken);

	public Task<RemoveModuleResponse> RemoveModuleAsync(NodeRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.RemoveModule(request.NodeId), cancellationToken);

	public Task<SpecialNodeResponse> GetSpecialNodeAsync(SpecialNodeRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetSpecialNode(request), cancellationToken);

	public Task<FindByTokenResponse> FindByTokenAsync(FindByTokenRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.FindByToken(request), cancellationToken);

	public Task<ResourceDataResponse> GetResourceDataAsync(ResourceDataRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetResourceData(request), cancellationToken);

	public Task<AddModulesResponse> LoadDependenciesAsync(LoadDependenciesRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.LoadDependenciesAsync(request, cancellationToken), cancellationToken);

	// ---------------------------------------------------------------- debug symbols

	public Task<ResolveBreakpointsResponse> ResolveBreakpointsAsync(string workspaceId, IReadOnlyList<BreakpointQuery> queries, CancellationToken cancellationToken) =>
		GetWorkspace(workspaceId).RunAsync(w => w.ResolveBreakpoints(queries, cancellationToken), cancellationToken);

	public Task<ResolvedIlLocation?> ResolveIlLocationAsync(string? workspaceId, string modulePath, int metadataToken, int ilOffset, CancellationToken cancellationToken) =>
		WithSymbolsAsync(workspaceId, w => symbols.ResolveIlLocation(w, modulePath, metadataToken, ilOffset, cancellationToken), cancellationToken);

	public Task<MethodIlInfoResponse?> GetMethodIlInfoAsync(string workspaceId, string modulePath, int metadataToken, CancellationToken cancellationToken) =>
		WithSymbolsAsync(workspaceId, w => symbols.GetMethodIlInfo(w, modulePath, metadataToken, cancellationToken), cancellationToken);

	public Task<IReadOnlyList<MethodIlInfoResponse>> FindMethodsAsync(string? workspaceId, string name, CancellationToken cancellationToken) =>
		WithSymbolsAsync(workspaceId, w => symbols.FindMethods(w, name, cancellationToken), cancellationToken);

	public Task<IReadOnlyList<DebugVariableNameDto>> GetVariableNamesAsync(string? workspaceId, string modulePath, int metadataToken, CancellationToken cancellationToken) =>
		WithSymbolsAsync(workspaceId, w => symbols.GetVariableNames(w, modulePath, metadataToken, cancellationToken), cancellationToken);

	public Task<SteppingTargetsResponse?> GetSteppingTargetsAsync(string? workspaceId, string modulePath, int metadataToken, int ilOffset, bool stepInto, CancellationToken cancellationToken) =>
		WithSymbolsAsync(workspaceId, w => symbols.GetSteppingTargets(w, modulePath, metadataToken, ilOffset, stepInto, cancellationToken), cancellationToken);

	public Task<bool> IsWorkspaceModuleAsync(string? workspaceId, string modulePath, CancellationToken cancellationToken) =>
		WithSymbolsAsync(workspaceId, w => symbols.IsWorkspaceModule(w, modulePath), cancellationToken);

	public Task<MethodSourceDto?> GetMethodSourceAsync(string? workspaceId, string modulePath, int metadataToken, CancellationToken cancellationToken) =>
		WithSymbolsAsync(workspaceId, w => symbols.GetMethodSource(w, modulePath, metadataToken, cancellationToken), cancellationToken);

	/// <summary>
	/// Runs a symbol lookup. Without a workspace the lookup still answers — a debuggee attached
	/// without one, or a module that lives outside the workspace, is read straight from its file.
	/// </summary>
	Task<T> WithSymbolsAsync<T>(string? workspaceId, Func<Workspace?, T> action, CancellationToken cancellationToken) =>
		workspaceId is not null && workspaces.TryGetValue(workspaceId, out var workspace)
			? workspace.RunAsync(_ => action(workspace), cancellationToken)
			: Task.Run(() => action(null), cancellationToken);

	Workspace GetWorkspace(string id) => workspaces.TryGetValue(id, out var workspace)
		? workspace
		: throw new RpcException(ErrorCodes.WorkspaceNotFound, "The workspace no longer exists.");

	static IReadOnlyList<string> ExpandPaths(IReadOnlyList<string> requestedPaths) {
		var paths = new HashSet<string>(StringComparer.Ordinal);
		foreach (var requestedPath in requestedPaths) {
			if (string.IsNullOrWhiteSpace(requestedPath))
				continue;
			var path = Path.GetFullPath(requestedPath);
			if (File.Exists(path)) {
				paths.Add(path);
				continue;
			}
			if (Directory.Exists(path)) {
				foreach (var candidate in Directory.EnumerateFiles(path, "*", SearchOption.TopDirectoryOnly)) {
					var extension = Path.GetExtension(candidate);
					if (extension.Equals(".dll", StringComparison.OrdinalIgnoreCase) ||
						extension.Equals(".exe", StringComparison.OrdinalIgnoreCase) ||
						extension.Equals(".netmodule", StringComparison.OrdinalIgnoreCase) ||
						extension.Equals(".winmd", StringComparison.OrdinalIgnoreCase))
						paths.Add(Path.GetFullPath(candidate));
				}
				continue;
			}
			throw new RpcException(ErrorCodes.FileNotFound, $"Path does not exist: {path}");
		}
		return paths.Order(StringComparer.Ordinal).ToArray();
	}

	public void Dispose() {
		if (disposed)
			return;
		disposed = true;
		foreach (var workspace in workspaces.Values)
			workspace.Dispose();
		workspaces.Clear();
		symbols.Dispose();
	}

	/// Answers the debug engine's IL-level questions. A module the workspace has open is read through
	/// the workspace; anything else — a debuggee attached without a workspace, a frame in a framework
	/// assembly — is loaded from its own file on demand and released when it falls out of the cache.
	/// </summary>
	sealed class SymbolResolver : IDisposable {
		const int MaxExternalModules = 16;
		const int MaxCachedMethods = 512;

		readonly object gate = new();
		readonly Dictionary<string, Workspace.ModuleEntry> externalModules = new(StringComparer.Ordinal);
		readonly Queue<string> externalOrder = new();
		readonly Dictionary<string, IReadOnlyList<CodeStatementDto>> methodStatements = new(StringComparer.Ordinal);
		readonly Dictionary<string, IReadOnlyList<DebugVariableNameDto>> variableNames = new(StringComparer.Ordinal);
		bool disposed;

		/// <summary>Drops every cached statement table; call after the decompiled text changes.</summary>
		public void Invalidate() {
			lock (gate) {
				methodStatements.Clear();
				variableNames.Clear();
			}
		}

		public Workspace.ModuleEntry? FindModule(Workspace? workspace, string path) {
			var full = Path.GetFullPath(path);
			return workspace?.FindModuleEntry(full) ?? FindExternalModule(full);
		}

		Workspace.ModuleEntry? FindExternalModule(string path) {
			lock (gate) {
				ObjectDisposedException.ThrowIf(disposed, this);
				if (externalModules.TryGetValue(path, out var cached))
					return cached;
			}
			if (!File.Exists(path))
				return null;
			ModuleDefMD module;
			try {
				module = ModuleDefMD.Load(path);
			}
			catch (Exception ex) when (ex is BadImageFormatException or IOException or UnauthorizedAccessException) {
				return null;
			}
			lock (gate) {
				if (externalModules.TryGetValue(path, out var raced))
					return raced;
				var entry = new Workspace.ModuleEntry(path, module) { IsExternal = true };
				while (externalOrder.Count >= MaxExternalModules) {
					if (externalModules.Remove(externalOrder.Dequeue(), out var evicted))
						evicted.Module.Dispose();
				}
				externalModules.Add(path, entry);
				externalOrder.Enqueue(path);
				return entry;
			}
		}

		public ResolvedIlLocation? ResolveIlLocation(Workspace? workspace, string modulePath, int metadataToken, int ilOffset, CancellationToken cancellationToken) {
			var entry = FindModule(workspace, modulePath);
			if (entry is null || entry.Module.ResolveToken(metadataToken) is not MethodDef method)
				return null;
			var source = FindSourceMethod(method);
			var statements = GetMethodStatements(workspace?.SymbolScope ?? string.Empty, entry, source, cancellationToken);
			var bodyToken = method.MDToken.Raw;
			// The sequence points tile the body, so the point that contains an offset is the statement the
			// runtime stopped in — whether or not the offset is where that statement's own code starts. The
			// two differ wherever the decompiler's statement begins inside code the points charge to it, and
			// an engine that reports such an offset (an async body, a field store) would otherwise name the
			// statement before it.
			var hit = statements.FirstOrDefault(statement => statement.MetadataToken == bodyToken && ilOffset >= statement.SequencePointIlOffset && ilOffset < statement.IlEndOffset)
				?? statements.LastOrDefault(statement => statement.MetadataToken == bodyToken && statement.SequencePointIlOffset <= ilOffset);
			if (hit is null)
				return null;
			return new ResolvedIlLocation(
				workspace?.TryGetMemberNodeId(entry, source),
				hit.Description,
				CSharpTypeName.StackFrameName(source),
				entry.Path,
				unchecked((int)bodyToken),
				hit.StartLine,
				hit.EndLine,
				hit.StartColumn,
				hit.EndColumn,
				hit.IlOffset,
				hit.IlEndOffset,
				hit.IsHidden,
				entry.IsExternal);
		}

		public MethodIlInfoResponse? GetMethodIlInfo(Workspace? workspace, string modulePath, int metadataToken, CancellationToken cancellationToken) {
			var entry = FindModule(workspace, modulePath);
			return entry is not null && entry.Module.ResolveToken(metadataToken) is MethodDef method
				? CreateMethodInfo(workspace, entry, method, cancellationToken)
				: null;
		}

		public IReadOnlyList<DebugVariableNameDto> GetVariableNames(Workspace? workspace, string modulePath, int metadataToken, CancellationToken cancellationToken) {
			var entry = FindModule(workspace, modulePath);
			if (entry is null || entry.Module.ResolveToken(metadataToken) is not MethodDef method || !method.HasBody)
				return Array.Empty<DebugVariableNameDto>();
			var scope = workspace?.SymbolScope ?? string.Empty;
			var key = $"{scope}|{entry.Path}|{method.MDToken.Raw:X8}";
			lock (gate) {
				ObjectDisposedException.ThrowIf(disposed, this);
				if (variableNames.TryGetValue(key, out var cached))
					return cached;
			}
			var names = BuildVariableNames(entry, method, cancellationToken);
			lock (gate) {
				if (variableNames.Count >= MaxCachedMethods)
					variableNames.Clear();
				variableNames[key] = names;
			}
			return names;
		}

		/// <summary>
		/// The statements a step from an IL location can land on, plus those of the method it calls when
		/// stepping into. A step is driven by breakpoints on these locations because the runtime, having
		/// no symbols, steps at IL-instruction granularity: it would stop in the middle of a statement.
		/// Statements are boundaries by construction.
		/// </summary>
		public SteppingTargetsResponse? GetSteppingTargets(Workspace? workspace, string modulePath, int metadataToken, int ilOffset, bool stepInto, CancellationToken cancellationToken) {
			var entry = FindModule(workspace, modulePath);
			if (entry is null || entry.Module.ResolveToken(metadataToken) is not MethodDef method)
				return null;
			var body = GetMethodStatements(workspace?.SymbolScope ?? string.Empty, entry, FindSourceMethod(method), cancellationToken)
				.Where(statement => statement.MetadataToken == metadataToken && !statement.IsHidden)
				.OrderBy(statement => statement.IlOffset)
				.ToArray();
			var targets = new List<SteppingTarget>();
			// A statement the thread is stopped inside of is where the step starts, so the line it is on is
			// the one the client marks: landing on another statement of it would not move the marker. They
			// are kept when they are all the body has, since stopping within the line beats running on.
			// The containment is the tiled one, like a reported stop: the location may be an offset the
			// statement's own code does not start at — a state machine's field store — and reading the line
			// off the statement's own start would name the wrong statement there.
			var current = body.FirstOrDefault(statement => ilOffset >= statement.SequencePointIlOffset && ilOffset < statement.IlEndOffset)
				?? body.LastOrDefault(statement => statement.SequencePointIlOffset <= ilOffset);
			var line = current?.StartLine;
			var stops = body.Where(statement => statement.StartLine != line).ToArray();
			if (stops.Length == 0)
				stops = body;
			// Every statement of the body is armed, not only the ones after the location: a loop runs its
			// body again, and the order the thread reaches them in is not the order of their IL offsets.
			// Whichever one the runtime reports first is the one the thread actually got to. Each is armed
			// at both offsets it has (see ArmStatement): a target the runtime cannot place is a target the
			// step cannot land on, and a body whose statements are all like that would never complete.
			foreach (var offset in stops.SelectMany(statement => ArmStatement(method, statement)).Distinct().OrderBy(offset => offset))
				targets.Add(new SteppingTarget(entry.Path, metadataToken, offset));
			var bodyTargets = targets.Count;
			if (stepInto)
				AddCalleeTargets(targets, workspace, entry, method, ilOffset, current?.IlEndOffset ?? int.MaxValue, cancellationToken);
			// Nothing of the body can run again before it returns, so the step has to leave the method — a
			// body maps its statements, the caller's resume point is not among them. A step into a call is
			// the exception: what it lands on belongs to the callee.
			var leavesMethod = targets.Count == bodyTargets
				&& !body.Any(statement => statement.IlOffset > ilOffset)
				&& !HasBackEdge(method, ilOffset);
			return new SteppingTargetsResponse(targets, leavesMethod);
		}

		/// <summary>
		/// The IL offsets a statement has to be armed at for a step to be able to land on it: where its own
		/// code starts, and — when the statement begins inside the sequence point covering it — the start of
		/// that point, because the runtime refuses a breakpoint anywhere else. Arming the second is what
		/// makes a state machine steppable: the field store in front of a statement is a point of its own,
		/// so the statement's own start is an offset <c>CreateBreakpoint</c> rejects.
		/// </summary>
		static IEnumerable<int> ArmStatement(MethodDef method, CodeStatementDto statement) {
			yield return statement.IlOffset;
			if (statement.SequencePointIlOffset < statement.IlOffset && RunsInto(method, statement.SequencePointIlOffset, statement.IlOffset))
				yield return statement.SequencePointIlOffset;
		}

		/// <summary>
		/// True when the IL before a statement runs straight into it. Where it branches instead, that IL
		/// belongs to the statement before — a loop's condition tail, which the tiling hands to whatever
		/// follows it — and a breakpoint there would stop the thread inside the other statement, reporting
		/// a line the user is not on. Such a point start is no substitute for the statement's own.
		/// </summary>
		static bool RunsInto(MethodDef method, int start, int end) {
			if (method.Body is not { } body)
				return false;
			foreach (var instruction in body.Instructions) {
				var offset = (int)instruction.Offset;
				if (offset >= end)
					break;
				if (offset < start)
					continue;
				// A branch within the range runs it out of order, and a branch into it is another
				// statement's control flow reaching inside.
				if (instruction.OpCode.FlowControl is FlowControl.Branch or FlowControl.Cond_Branch or FlowControl.Return)
					return false;
				switch (instruction.Operand) {
				case Instruction target when target.Offset >= start && target.Offset < end:
				case IList<Instruction> targets when targets.Any(target => target.Offset >= start && target.Offset < end):
					return false;
				}
			}
			return true;
		}

		/// <summary>
		/// The offset the runtime can be asked for instead of the statement's own, or null when there is
		/// none to be had. A breakpoint belongs on the statement's own start, which is what a stop is
		/// reported at; the point in front of it is only a substitute when it runs straight into it.
		/// </summary>
		internal int? AcceptedPointOffset(Workspace? workspace, CodeStatementDto statement) {
			if (statement.SequencePointIlOffset >= statement.IlOffset)
				return null;
			if (FindModule(workspace, statement.ModulePath)?.Module.ResolveToken(statement.MetadataToken) is not MethodDef body)
				return null;
			return RunsInto(body, statement.SequencePointIlOffset, statement.IlOffset) ? statement.SequencePointIlOffset : null;
		}

		/// <summary>
		/// True when the method branches back over <paramref name="ilOffset"/>, which means the location can
		/// run again: the last statement of a loop has nothing after it, yet the loop is not finished.
		/// </summary>
		static bool HasBackEdge(MethodDef method, int ilOffset) {
			if (method.Body is not { } body)
				return false;
			foreach (var instruction in body.Instructions) {
				if (instruction.Offset < ilOffset)
					continue;
				switch (instruction.Operand) {
				case Instruction target when target.Offset <= ilOffset:
				case IList<Instruction> targets when targets.Any(target => target.Offset <= ilOffset):
					return true;
				}
			}
			return false;
		}

		/// <summary>
		/// A step into a call lands on the first statement of what the call runs. The callee's module is
		/// read from disk when the workspace does not hold it, which is what dnSpy's own engine does: it
		/// asks its decompiler for the callee's statements and the decompiler loads the module to answer.
		/// The file a call to a framework method has to be read from is not beside the debuggee, so it is
		/// found the way the tree finds it (see <see cref="FindCalleeBody"/>).
		/// A call the workspace can say nothing about — native, or an assembly this machine does not have —
		/// has only its entry instruction to aim at, and a call whose body has no entry at all is not a
		/// target, so "step into" degrades to "step over" there rather than walking into code with no
		/// document. That is why the calls of the statement are walked rather than taken at the first:
		/// the one the user is pointing at is the first the workspace can enter.
		/// </summary>
		void AddCalleeTargets(List<SteppingTarget> targets, Workspace? workspace, Workspace.ModuleEntry entry, MethodDef method, int ilOffset, int ilEnd, CancellationToken cancellationToken) {
			if (method.Body is not { } body)
				return;
			// The stop is on a statement's first instruction, but a call site pushes its arguments first,
			// so the call is rarely at the location itself: the next call the thread reaches is the one a
			// step into enters. A call the thread branches past is not a problem — the caller's own
			// statements are armed too, so the step completes there instead of running on unobserved.
			//
			// The call the thread reaches is the call it can enter, and a statement often opens with one it
			// cannot: the constructor of a delegate the compiler builds inline, a body the runtime supplies
			// rather than the assembly, a method of an assembly this machine does not have. Taking that one
			// would leave the step with nothing to land on and it would run past the call the user pointed
			// at, so the calls are walked until one has a body — inside the statement alone, since a call in
			// the statement after it is the caller's next statement, which a step over reaches, not this one.
			(Workspace.ModuleEntry Entry, MethodDef Body)? calleeTarget = null;
			IMethod? call = null;
			foreach (var instruction in body.Instructions) {
				if (instruction.Offset < ilOffset)
					continue;
				if (instruction.Offset >= ilEnd)
					break;
				if (instruction.OpCode.Code is not (Code.Call or Code.Callvirt or Code.Newobj))
					continue;
				if (instruction.Operand is not IMethod candidate)
					continue;
				if (FindCalleeBody(workspace, entry, candidate) is not { } target)
					continue;
				call = candidate;
				calleeTarget = target;
				break;
			}
			if (call is null || calleeTarget is not { } calleeTargetValue)
				return;
			var (calleeEntry, callee) = calleeTargetValue;
			// Like the caller's own statements, the whole callee is armed: the runtime reports the statement
			// it reaches first, which is the one the call runs. Each target is armed under the token of the
			// body the statement belongs to rather than the method the call names, because the two are not
			// the same for an async method: its statements are the generated MoveNext's, and arming them
			// against the kickoff would put no breakpoint in the body at all — the step would run straight
			// past the call it was meant to enter.
			var calleeTargets = new List<(int MetadataToken, int IlOffset)>();
			foreach (var statement in GetMethodStatements(workspace?.SymbolScope ?? string.Empty, calleeEntry, FindSourceMethod(callee), cancellationToken)) {
				if (statement.IsHidden)
					continue;
				if (calleeEntry.Module.ResolveToken(statement.MetadataToken) is not MethodDef statementBody)
					continue;
				foreach (var offset in ArmStatement(statementBody, statement))
					calleeTargets.Add((statement.MetadataToken, offset));
			}
			// A body the decompiler gives no statements for — one it cannot read at all, or one whose
			// statements belong to another method — still begins somewhere, and that one location is what
			// entering the call reaches. Without it the step would quietly become a step over, which is
			// exactly the behaviour a step into must not have.
			if (calleeTargets.Count == 0 && callee.Body is { Instructions.Count: > 0 } calleeBody)
				calleeTargets.Add((unchecked((int)callee.MDToken.Raw), unchecked((int)calleeBody.Instructions[0].Offset)));
			foreach (var (metadataToken, offset) in calleeTargets.Distinct().OrderBy(target => target.IlOffset))
				targets.Add(new SteppingTarget(calleeEntry.Path, metadataToken, offset));
		}

		/// <summary>
		/// The module a call's body is in and the body itself, or null when nothing on this machine has
		/// either. A callee in the caller, or beside it, is one dnlib finds on its own. A framework callee
		/// is not: the assembly the call's declaring type comes from is in the runtime the debuggee
		/// targets rather than next to its file, and dnlib is never told where that is. The tree already
		/// answers where such a reference resolves, so the file is read as a module of its own and the
		/// method the call names is looked up in it by name and signature — which is what gives the step a
		/// body to enter instead of a call to run past.
		/// </summary>
		(Workspace.ModuleEntry Entry, MethodDef Body)? FindCalleeBody(Workspace? workspace, Workspace.ModuleEntry owner, IMethod call) {
			if (call.ResolveMethodDef() is { HasBody: true } resolved && !string.IsNullOrEmpty(resolved.Module.Location)) {
				var path = Path.GetFullPath(resolved.Module.Location);
				var entry = string.Equals(path, owner.Path, StringComparison.Ordinal) ? owner : FindModule(workspace, path);
				return entry is null ? null : (entry, resolved);
			}
			// An instantiated generic type is named by the type it instantiates, since that is the one
			// whose module declares the method; anything the reference does not spell out by name and
			// signature — a generic callee, say — is not followed, and the step stays a step over.
			if (workspace is null || DeclaringAssembly(call) is not { } reference || call.MethodSig is not { } signature)
				return null;
			if (workspace.FindReferencePath(owner, reference) is not { } referencePath)
				return null;
			if (FindModule(workspace, Path.GetFullPath(referencePath)) is not { } module)
				return null;
			var type = call.DeclaringType is TypeSpec specification ? specification.ScopeType : call.DeclaringType;
			if (type is null)
				return null;
			if (module.Module.Find(type.FullName, isReflectionName: false) is { } declaringType)
				return declaringType.FindMethod(call.Name, signature) is { HasBody: true } body ? (module, body) : null;
			return FindForwardedBody(workspace, module, type, call.Name, signature);
		}

		/// <summary>
		/// The body of a method on a type the referenced assembly only forwards, or null when nothing holds
		/// it. A reference to a framework type names the assembly the type used to live in — the facade the
		/// runtime keeps for compatibility — and that assembly declares nothing: its type table is empty and
		/// every entry is an <c>ExportedType</c> handing the type to the assembly that really declares it,
		/// which is how <c>System.Runtime</c> carries the whole BCL it does not own. A step into a call on
		/// such a type would find no body and quietly become a step over, so the forwarder is followed the
		/// way the runtime follows it — the file is resolved from the forwarding assembly's own directory,
		/// not the debuggee's — until an assembly declares the type.
		/// </summary>
		(Workspace.ModuleEntry Entry, MethodDef Body)? FindForwardedBody(Workspace workspace, Workspace.ModuleEntry facade, ITypeDefOrRef type, string name, MethodSig signature) {
			// A chain is followed, not a loop, so the bound is only there to stop a file that forwards a
			// type back to itself from being read forever. Four hops is more than the runtime itself uses.
			for (var hop = 0; hop < 4; hop++) {
				if (facade.Module.ExportedTypes.FirstOrDefault(exported => exported.FullName == type.FullName) is not { Scope: AssemblyRef reference })
					return null;
				// The forwarder is resolved against the module that carries it: the framework assembly a
				// reference hands to is a sibling of the facade, not of the debuggee the call is in.
				if (workspace.FindReferencePath(facade, reference) is not { } path)
					return null;
				if (FindModule(workspace, Path.GetFullPath(path)) is not { } next)
					return null;
				if (next.Module.Find(type.FullName, isReflectionName: false) is { } declaringType)
					return declaringType.FindMethod(name, signature) is { HasBody: true } body ? (next, body) : null;
				facade = next;
			}
			return null;
		}

		/// <summary>
		/// The assembly a call's declaring type is declared in, as the caller's metadata names it, or null
		/// when the type belongs to a module that metadata owns. A nested type hangs off its declaring
		/// type rather than the assembly, so it is walked to whichever of them the reference is on.
		/// </summary>
		static AssemblyRef? DeclaringAssembly(IMethod call) {
			var type = call.DeclaringType is TypeSpec specification ? specification.ScopeType : call.DeclaringType;
			while (type is TypeRef reference) {
				if (reference.ResolutionScope is AssemblyRef assembly)
					return assembly;
				type = reference.DeclaringType;
			}
			return null;
		}

		/// <summary>True when the module is one of the workspace's own files rather than a dependency.</summary>
		public bool IsWorkspaceModule(Workspace? workspace, string modulePath) =>
			!string.IsNullOrEmpty(modulePath) && workspace?.FindModuleEntry(modulePath) is not null;

		public IReadOnlyList<MethodIlInfoResponse> FindMethods(Workspace? workspace, string name, CancellationToken cancellationToken) {
			const int MaxResults = 64;
			if (string.IsNullOrWhiteSpace(name))
				return Array.Empty<MethodIlInfoResponse>();
			var results = new List<MethodIlInfoResponse>();
			foreach (var entry in EnumerateModules(workspace)) {
				foreach (var type in entry.Module.GetTypes()) {
					cancellationToken.ThrowIfCancellationRequested();
					foreach (var method in type.Methods) {
						if (!method.HasBody || !Matches(method, type, name))
							continue;
						results.Add(CreateMethodInfo(workspace, entry, method, cancellationToken));
						if (results.Count >= MaxResults)
							return results;
					}
				}
			}
			return results;
		}

		static bool Matches(MethodDef method, TypeDef type, string name) =>
			method.Name == name ||
			method.FullName == name ||
			$"{type.Name}.{method.Name}" == name ||
			$"{type.FullName}.{method.Name}" == name;

		IEnumerable<Workspace.ModuleEntry> EnumerateModules(Workspace? workspace) {
			if (workspace is not null) {
				foreach (var entry in workspace.OpenModules)
					yield return entry;
			}
			lock (gate) {
				foreach (var entry in externalModules.Values)
					yield return entry;
			}
		}

		MethodIlInfoResponse CreateMethodInfo(Workspace? workspace, Workspace.ModuleEntry entry, MethodDef method, CancellationToken cancellationToken) {
			var source = FindSourceMethod(method);
			var bodyToken = method.MDToken.Raw;
			var statements = method.HasBody
				? GetMethodStatements(workspace?.SymbolScope ?? string.Empty, entry, source, cancellationToken)
				: Array.Empty<CodeStatementDto>();
			// A method breakpoint goes on the first statement's sequence point rather than on the offset its
			// own code starts at: the runtime will not accept a breakpoint at the latter wherever the point
			// covering it begins earlier, which is the rule in a state machine's MoveNext.
			CodeStatementDto? first = null;
			foreach (var statement in statements) {
				if (statement.MetadataToken == bodyToken && !statement.IsHidden && (first is null || statement.IlOffset < first.IlOffset))
					first = statement;
			}
			return new MethodIlInfoResponse(
				workspace?.TryGetMemberNodeId(entry, source),
				source.FullName,
				entry.Path,
				unchecked((int)source.MDToken.Raw),
				unchecked((int)bodyToken),
				first?.SequencePointIlOffset ?? 0,
				GetCodeSize(method),
				method.HasBody);
		}

		static int GetCodeSize(MethodDef method) {
			if (!method.HasBody || method.Body.Instructions.Count == 0)
				return 0;
			var last = method.Body.Instructions[^1];
			return (int)last.Offset + last.GetSize();
		}

		/// <summary>
		/// The statement table of one method body. An async or iterator method compiles into a generated
		/// <c>MoveNext</c>, which is the token the engine reports, so the IL offsets are the state
		/// machine's while the lines belong to the method the user wrote; decompiling the source method
		/// and keeping the statements whose body token is the <c>MoveNext</c> lines both up.
		/// </summary>
		IReadOnlyList<CodeStatementDto> GetMethodStatements(string scope, Workspace.ModuleEntry entry, MethodDef method, CancellationToken cancellationToken) {
			if (!method.HasBody)
				return Array.Empty<CodeStatementDto>();
			var key = $"{scope}|{entry.Path}|{method.MDToken.Raw:X8}";
			lock (gate) {
				ObjectDisposedException.ThrowIf(disposed, this);
				if (methodStatements.TryGetValue(key, out var cached))
					return cached;
			}
			var statements = BuildMethodStatements(entry, method, cancellationToken);
			lock (gate) {
				if (methodStatements.Count >= MaxCachedMethods)
					methodStatements.Clear();
				methodStatements[key] = statements;
			}
			return statements;
		}

		static IReadOnlyList<CodeStatementDto> BuildMethodStatements(Workspace.ModuleEntry entry, MethodDef method, CancellationToken cancellationToken) {
			var settings = new DecompilerSettings();
			using var session = Workspace.CreateCSharpDecompilerSession(entry, settings, cancellationToken);
			var decompiler = session.Decompiler;
			var syntaxTree = decompiler.Decompile([Workspace.ToEntityHandle(method)]);
			var output = new Workspace.SpanTextOutput(_ => null);
			Workspace.RenderWithLocations(syntaxTree, output, settings);
			// Keyed on the source method rather than the body: an async method's statements live in a
			// generated MoveNext, and they are what a frame stopped inside that state machine needs.
			var sourceToken = unchecked((int)method.MDToken.Raw);
			return Workspace.BuildCodeStatements(syntaxTree, decompiler, entry, cancellationToken)
				.Where(statement => statement.SourceMethodToken == sourceToken)
				.ToArray();
		}

		/// <summary>
		/// A body's statements as the decompiler writes them and its IL, one instruction a line — what the
		/// Disassembly view writes as comments over the native code, and what the Autos window reads names from.
		/// </summary>
		public MethodSourceDto? GetMethodSource(Workspace? workspace, string modulePath, int metadataToken, CancellationToken cancellationToken) {
			var entry = FindModule(workspace, modulePath);
			if (entry is null || entry.Module.ResolveToken(metadataToken) is not MethodDef method)
				return null;
			var instructions = method.Body?.Instructions.Select(instruction => new IlLineDto((int)instruction.Offset, instruction.ToString() ?? string.Empty)).ToArray() ?? [];
			var source = FindSourceMethod(method);
			var statements = new List<SourceStatementDto>();
			try {
				var settings = new DecompilerSettings();
				using var session = Workspace.CreateCSharpDecompilerSession(entry, settings, cancellationToken);
				var decompiler = session.Decompiler;
				var syntaxTree = decompiler.Decompile([Workspace.ToEntityHandle(source)]);
				var output = new Workspace.SpanTextOutput(_ => null);
				Workspace.RenderWithLocations(syntaxTree, output, settings);
				var lines = output.ToString().Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
				var sourceToken = unchecked((int)source.MDToken.Raw);
				foreach (var statement in Workspace.BuildCodeStatements(syntaxTree, decompiler, entry, cancellationToken)) {
					if (statement.SourceMethodToken != sourceToken || statement.MetadataToken != metadataToken)
						continue;
					statements.Add(new SourceStatementDto(statement.IlOffset, statement.IlEndOffset, statement.MetadataToken, TextOf(lines, statement), statement.IsHidden));
				}
			}
			catch (OperationCanceledException) {
				throw;
			}
			catch (Exception) {
				// A body the decompiler cannot read still has its IL to show.
			}
			return new MethodSourceDto(method.FullName, statements.OrderBy(statement => statement.IlOffset).ToArray(), instructions);
		}

		/// <summary>The text between a statement's start and end, out of the document's lines.</summary>
		static string TextOf(string[] lines, CodeStatementDto statement) {
			if (statement.StartLine < 1 || statement.StartLine > lines.Length)
				return string.Empty;
			if (statement.StartLine == statement.EndLine) {
				var line = lines[statement.StartLine - 1];
				var start = Math.Clamp(statement.StartColumn - 1, 0, line.Length);
				var end = Math.Clamp(statement.EndColumn - 1, start, line.Length);
				return line[start..end];
			}
			var builder = new StringBuilder();
			for (var number = statement.StartLine; number <= Math.Min(statement.EndLine, lines.Length); number++) {
				var line = lines[number - 1];
				if (number == statement.StartLine)
					builder.Append(line[Math.Clamp(statement.StartColumn - 1, 0, line.Length)..]);
				else if (number == statement.EndLine)
					builder.Append('\n').Append(line[..Math.Clamp(statement.EndColumn - 1, 0, line.Length)]);
				else
					builder.Append('\n').Append(line);
			}
			return builder.ToString();
		}

		/// <summary>
		/// The names the decompiler gives a method body's locals and arguments. A debuggee without a
		/// PDB carries no symbol names of its own, so the engine maps ICorDebug slots onto these —
		/// which is how a slot reads as <c>sum</c> instead of <c>local2</c>.
		/// </summary>
		static IReadOnlyList<DebugVariableNameDto> BuildVariableNames(Workspace.ModuleEntry entry, MethodDef method, CancellationToken cancellationToken) {
			try {
				var settings = new DecompilerSettings();
				using var session = Workspace.CreateCSharpDecompilerSession(entry, settings, cancellationToken);
				var syntaxTree = session.Decompiler.Decompile([Workspace.ToEntityHandle(method)]);
				var token = method.MDToken.Raw;
				var localNames = ReadLocalNamesFromPdb(entry.Path, method);
				var names = new List<DebugVariableNameDto>();
				// The ILFunction keys of a sequence-point map are the bodies this tree printed, which is
				// exactly the body whose slots the engine is looking at.
				foreach (var function in session.Decompiler.CreateSequencePoints(syntaxTree).Keys) {
					cancellationToken.ThrowIfCancellationRequested();
					if (Workspace.GetSourceMethodToken(function) != token && Workspace.GetBodyMethodToken(function) != token)
						continue;
					foreach (var variable in function.Variables)
						AddVariableName(names, method, variable, localNames);
				}
				return names
					.OrderByDescending(name => name.IsArgument)
					.ThenBy(name => name.Index)
					.ToArray();
			}
			catch (OperationCanceledException) {
				throw;
			}
			catch (Exception) {
				// Names are a convenience: without them the engine falls back to slot numbers.
				return Array.Empty<DebugVariableNameDto>();
			}
		}

		/// <summary>
		/// Local names slot by slot. The metadata records parameter names but says nothing about locals,
		/// so a release build — which ships no PDB — genuinely has none, and ILSpy invents <c>num</c>-
		/// style names instead. Reading the portable PDB when one sits next to the module is what turns
		/// those back into the names the user wrote.
		/// </summary>
		static Dictionary<int, string> ReadLocalNamesFromPdb(string modulePath, MethodDef method) {
			var names = new Dictionary<int, string>();
			var pdbPath = Path.ChangeExtension(modulePath, ".pdb");
			if (!File.Exists(pdbPath))
				return names;
			try {
				using var stream = File.OpenRead(pdbPath);
				using var provider = PdbReaderProvider.FromPortablePdbStream(stream);
				var pdb = provider.GetMetadataReader();
				// PDB rows are numbered like the metadata rows they describe, so the method's row
				// number is the handle the debug metadata is keyed by.
				var handle = MetadataTokens.MethodDefinitionHandle(method.MDToken.ToInt32() & 0x00FFFFFF);
				foreach (var scopeHandle in pdb.GetLocalScopes(handle)) {
					foreach (var variableHandle in pdb.GetLocalScope(scopeHandle).GetLocalVariables()) {
						var variable = pdb.GetLocalVariable(variableHandle);
						var name = pdb.GetString(variable.Name);
						if (!string.IsNullOrEmpty(name))
							names[variable.Index] = name;
					}
				}
			}
			catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or BadImageFormatException or ArgumentException) {
				// An unreadable PDB costs the locals their names and nothing else.
			}
			return names;
		}

		static void AddVariableName(List<DebugVariableNameDto> names, MethodDef method, DecompilerILVariable variable, Dictionary<int, string> localNames) {
			// Stack slots and exception slots are not variables anyone can name, and a variable without
			// a slot has nothing the engine could match it against.
			if (variable.Kind is not (DecompilerVariableKind.Parameter or DecompilerVariableKind.Local) || variable.Index is not { } variableIndex)
				return;
			var isArgument = variable.Kind == DecompilerVariableKind.Parameter;
			// ILSpy indexes the signature's parameters, while the engine counts the receiver as
			// argument 0 of an instance method — and calls it "this", like the decompiler does.
			var index = isArgument ? variableIndex + (method.IsStatic ? 0 : 1) : variableIndex;
			// The PDB is the better authority on locals: ILSpy's names are its own invention once the
			// method is inlined into a caller, and a slot's real name never changes.
			var name = isArgument ? null : localNames.GetValueOrDefault(index);
			if (string.IsNullOrEmpty(name))
				name = string.IsNullOrEmpty(variable.Name) ? null : variable.Name;
			name ??= isArgument ? $"arg{index}" : $"local{index}";
			names.Add(new DebugVariableNameDto(name, variable.Type?.ToString() ?? string.Empty, index, isArgument));
		}

		/// <summary>
		/// Maps a generated state machine method back to the method that produced it, so a frame inside
		/// <c>MoveNext</c> is reported at the line of the <c>await</c> the user actually wrote.
		/// </summary>
		static MethodDef FindSourceMethod(MethodDef method) {
			if (method.Name != "MoveNext" || method.DeclaringType is not { } stateMachine || stateMachine.DeclaringType is not { } owner)
				return method;
			if (!IsCompilerGenerated(stateMachine))
				return method;
			foreach (var candidate in owner.Methods) {
				foreach (var attribute in candidate.CustomAttributes) {
					if (!attribute.TypeFullName.EndsWith("StateMachineAttribute", StringComparison.Ordinal))
						continue;
					if (attribute.ConstructorArguments.Count != 1)
						continue;
					if (ResolveType(attribute.ConstructorArguments[0].Value) == stateMachine)
						return candidate;
				}
			}
			return method;
		}

		static TypeDef? ResolveType(object? value) => value switch {
			ITypeDefOrRef reference => reference.ResolveTypeDef(),
			TypeSig signature => signature.ToTypeDefOrRef().ResolveTypeDef(),
			_ => null,
		};

		static bool IsCompilerGenerated(TypeDef type) => type.CustomAttributes.Any(
			attribute => attribute.TypeFullName == "System.Runtime.CompilerServices.CompilerGeneratedAttribute");

		public void Dispose() {
			lock (gate) {
				if (disposed)
					return;
				disposed = true;
				foreach (var entry in externalModules.Values)
					entry.Module.Dispose();
				externalModules.Clear();
				externalOrder.Clear();
				methodStatements.Clear();
			}
		}
	}

	sealed partial class Workspace : IDisposable {
		readonly SemaphoreSlim gate = new(1, 1);
		readonly SymbolResolver symbols;
		readonly Dictionary<string, ModuleEntry> modules = new(StringComparer.Ordinal);
		// PE-only modules (non-managed assemblies)
		readonly Dictionary<string, PeOnlyModuleEntry> peModules = new(StringComparer.Ordinal);
		// ELF images. dnSpy itself has no ELF reader, but on Linux an executable the user picks is usually
		// one of these, and its headers are readable the same way a PE image's are.
		readonly Dictionary<string, ElfFileEntry> elfFiles = new(StringComparer.Ordinal);
		// Files that are neither a managed assembly, a PE image nor an ELF image — a script, a file that is
		// not there any more. WPF keeps those open as unknown documents rather than refusing them
		// (DsDocumentService.CreateDocumentCore), and the tree shows them under their own file name.
		readonly Dictionary<string, UnknownFileEntry> unknownFiles = new(StringComparer.Ordinal);
		// The root nodes in the order the tree shows them. The dictionary above is keyed by node id, so
		// its iteration order is a hash order that the client cannot rely on — the same two assemblies
		// would come back in a different order across runs. This list is that order: load order until the
		// Sort Assemblies command rearranges it.
		readonly List<string> rootOrder = new();
		// The assemblies reached through a reference, loaded on demand. Unlike the debugger's cache these
		// are never evicted: a tree node for a type in one of them holds the module object, and evicting
		// it would leave that node pointing at a disposed module. The memory is bounded by what the user
		// actually expanded, and it goes when the workspace does.
		readonly Dictionary<string, ModuleEntry> referenceModules = new(StringComparer.Ordinal);
		// One resolver per module that has references, built on first use; a null entry records a module
		// whose resolver could not be built, so the attempt is not repeated for every reference node.
		readonly Dictionary<string, AssemblyReferenceResolver?> referenceResolvers = new(StringComparer.Ordinal);
		// Where a reference resolved to, keyed by the referencing module and the simple name. A null value
		// records one that nothing on this machine provides, so the search is not run again for it.
		readonly Dictionary<string, string?> referencePaths = new(StringComparer.Ordinal);
		// Namespace membership is requested once for the module row and again for whichever namespace the
		// user opens. Keep the grouping for the current edit state so expanding a namespace does not rescan
		// every top-level TypeDef in a large module. The state id changes on every edit/reload.
		readonly Dictionary<string, NamespaceIndex> namespaceIndexes = new(StringComparer.Ordinal);
		// The type hierarchy nodes resolve a base type's reference against the open modules, so a module's
		// types are indexed by full name once per edit state — the same lifetime the namespace index has.
		readonly Dictionary<string, TypeIndex> typeIndexes = new(StringComparer.Ordinal);
		readonly Dictionary<string, NodeEntry> nodes = new(StringComparer.Ordinal);
		readonly Dictionary<string, string> nodeIdsByKey = new(StringComparer.Ordinal);
		readonly Dictionary<string, EditTransaction> transactions = new(StringComparer.Ordinal);
		readonly Stack<EditHistoryEntry> undoHistory = new();
		readonly Stack<EditHistoryEntry> redoHistory = new();
		readonly Dictionary<string, IReadOnlyList<CodeStatementDto>> codeStatementsByNode = new(StringComparer.Ordinal);
		int nextNodeId;
		int version;
		string stateId = Guid.NewGuid().ToString("N");
		string cachedStatementsStateId = string.Empty;
		bool disposed;

		public Workspace(SymbolResolver symbols) {
			this.symbols = symbols;
			Id = Guid.NewGuid().ToString("N");
		}

		public string Id { get; }

		public async Task OpenAsync(IReadOnlyList<string> paths, CancellationToken cancellationToken) {
			await LoadModulesAsync(paths, cancellationToken).ConfigureAwait(false);
			// Every file that exists ends up in the tree one way or another, so this only fires when the
			// caller named no file at all.
			if (modules.Count == 0 && peModules.Count == 0 && elfFiles.Count == 0 && unknownFiles.Count == 0)
				throw new RpcException(ErrorCodes.InvalidParams, "Select at least one file to open.");
		}

		/// <summary>
		/// Loads the files of a path list that are not open yet and returns them. A path already open is
		/// left alone, the way dnSpy's drop handler skips a file it already has, so the same list can be
		/// offered twice without producing two trees. Loading nothing is not an error here: the Open command
		/// raises one instead, while adding to an open workspace is content to have had nothing to do.
		/// </summary>
		public async Task<IReadOnlyList<IModuleEntry>> LoadModulesAsync(IReadOnlyList<string> paths, CancellationToken cancellationToken, bool autoLoaded = false) {
			var added = new List<IModuleEntry>();
			foreach (var path in paths) {
				cancellationToken.ThrowIfCancellationRequested();
				var fullPath = Path.GetFullPath(path);
				if (IsOpen(fullPath)) {
					// dnSpy's loader clears the auto-loaded flag of a document the user opens on purpose.
					if (!autoLoaded)
						MarkOpenedByUser(fullPath);
					continue;
				}

				var entry = await Task.Run(() => LoadEntry(fullPath), cancellationToken).ConfigureAwait(false);
				AddRoot(entry, autoLoaded);
				added.Add(entry);
			}
			return added;
		}

		bool IsOpen(string fullPath) =>
			FindModuleEntry(fullPath) is not null
			|| FindPeModuleEntry(fullPath) is not null
			|| FindElfEntry(fullPath) is not null
			|| FindUnknownEntry(fullPath) is not null;

		/// <summary>
		/// Reads one file the way dnSpy's <c>DsDocumentService.CreateDocumentCore</c> does: a managed module
		/// when it carries .NET metadata, the PE image when it is a valid PE but not a managed one, and an
		/// unknown document for anything else — a file that is not a PE at all, or one that cannot be read.
		/// An ELF image gets its own reader, since dnSpy has none and on Linux it is what a native binary
		/// usually is. Nothing here throws, because a file the user picked is never a reason to fail the open.
		/// </summary>
		static IModuleEntry LoadEntry(string fullPath) {
			ModuleDefMD? module = null;
			try {
				module = ModuleDefMD.Load(fullPath);
			}
			catch {
				// Not a managed module dnSpy can read — a native binary, or a file that is gone or that
				// nothing may read. dnSpy decides by looking at the CLR data directory before it tries;
				// either way it moves on to the PE image rather than failing the open over one file.
			}
			if (module is not null)
				return new ModuleEntry(fullPath, module);

			try {
				return new PeOnlyModuleEntry(fullPath, new PEImage(fullPath));
			}
			catch {
				// Not a PE image either. An ELF image is only claimed as one when its own header can be
				// read, so a file with the magic bytes and nothing behind them stays an unknown document.
				if (ElfImage.HasMagic(fullPath) && ElfImage.TryLoad(fullPath) is { } elf)
					return new ElfFileEntry(fullPath, elf);
				return new UnknownFileEntry(fullPath);
			}
		}

		/// <summary>
		/// Adds files to an open workspace, the way dnSpy's Open command adds them to the tree rather than
		/// replacing it. The paths that were already open come back in the response so the caller can say so;
		/// a request that names only open files succeeds, and every file it names ends up in the tree, since
		/// one that is neither managed nor a PE image is kept as an unknown document.
		/// </summary>
		public async Task<AddModulesResponse> AddModulesAsync(AddModulesRequest request, CancellationToken cancellationToken) {
			var paths = ExpandPaths(request.Paths);
			var skipped = paths.Where(IsOpen).ToArray();
			await LoadModulesAsync(paths, cancellationToken).ConfigureAwait(false);
			return new AddModulesResponse(CreateOpenResponse().Modules, skipped, stateId);
		}

		/// <summary>
		/// dnSpy's Load Dependencies: every assembly the module's references name is resolved and opened as
		/// a document of its own, so the references stop being dead ends in the tree. The recursive form
		/// walks the closure — each opened assembly's own references are followed too — and a module is
		/// walked once, which is what keeps a cycle from turning into an endless walk. A reference that
		/// resolves to nothing on this machine is passed over, the way the tree lets it expand to nothing.
		/// </summary>
		public async Task<AddModulesResponse> LoadDependenciesAsync(LoadDependenciesRequest request, CancellationToken cancellationToken) {
			var module = ModuleOf(GetNode(request.NodeId))
				?? throw new RpcException(ErrorCodes.InvalidParams, "The selected node is not part of a managed assembly.");
			var paths = new List<string>();
			var walked = new HashSet<string>(StringComparer.Ordinal) { module.Path };
			var queue = new Queue<ModuleEntry>();
			queue.Enqueue(module);
			while (queue.Count > 0) {
				var owner = queue.Dequeue();
				foreach (var reference in owner.Module.GetAssemblyRefs()) {
					// A reference to an assembly the workspace already holds is that module, not a second
					// copy of it; loading the file again would put two roots over the same assembly.
					var target = FindOpenModuleByName(reference.Name.String) ?? LoadReferenceModule(owner, reference);
					if (target is null)
						continue;
					if (walked.Add(target.Path) && !IsOpen(target.Path))
						paths.Add(target.Path);
					if (request.Recursive)
						queue.Enqueue(target);
				}
			}
			return await AddModulesAsync(new AddModulesRequest(request.WorkspaceId, paths), cancellationToken).ConfigureAwait(false);
		}

		public OpenWorkspaceResponse CreateOpenResponse() {
			var opened = OrderedEntries().Select(entry => entry switch {
				ModuleEntry module => new OpenedModule(
					module.Id,
					module.Module.Assembly?.Name.String ?? module.Module.Name.String,
					module.Path,
					File.Exists(Path.ChangeExtension(module.Path, ".pdb")),
					IsAutoLoaded(module)),
				// A PE-only file and an unknown one have no assembly name to show or symbols to load, so
				// they are listed under their file name the way the tree lists them.
				_ => new OpenedModule(entry.Id, Path.GetFileName(entry.Path), entry.Path, false, IsAutoLoaded(entry)),
			}).ToList();
			return new OpenWorkspaceResponse(Id, opened, stateId);
		}

		public TreeNodesResponse GetRoots() =>
			new(OrderedEntries().Select(entry => ToDto(nodes[entry.Id])).ToArray());

		/// <summary>
		/// Every file the workspace holds, in the order the tree shows them, which is what keeps the client's
		/// root list and its module list in step. An id with nothing behind it is skipped rather than trusted,
		/// so a reload that rebuilds the modules cannot hand out a root that is no longer there.
		/// </summary>
		IEnumerable<IModuleEntry> OrderedEntries() {
			foreach (var id in rootOrder) {
				if (modules.TryGetValue(id, out var module))
					yield return module;
				else if (peModules.TryGetValue(id, out var peModule))
					yield return peModule;
				else if (elfFiles.TryGetValue(id, out var elf))
					yield return elf;
				else if (unknownFiles.TryGetValue(id, out var unknown))
					yield return unknown;
			}
		}

		IEnumerable<ModuleEntry> OrderedModules() => OrderedEntries().OfType<ModuleEntry>();

		/// <summary>
		/// Sorts the root nodes by the name the tree shows, case-insensitively, with the current position
		/// as the tie-breaker so two identical names keep the order they were loaded in. The roots the user
		/// opened come before the ones the workspace auto-loaded, the way dnSpy's DsDocumentNodeComparer puts
		/// them. This is dnSpy's Sort Assemblies (IDocumentTreeView.SortTopNodes).
		/// </summary>
		public TreeNodesResponse SortAssemblies() {
			var position = rootOrder.Select((id, index) => (id, index)).ToDictionary(entry => entry.id, entry => entry.index, StringComparer.Ordinal);
			rootOrder.Sort((left, right) => {
				var byOrigin = autoLoadedRoots.Contains(left).CompareTo(autoLoadedRoots.Contains(right));
				if (byOrigin != 0)
					return byOrigin;
				var byName = StringComparer.OrdinalIgnoreCase.Compare(GetLabel(nodes[left]), GetLabel(nodes[right]));
				return byName != 0 ? byName : position[left].CompareTo(position[right]);
			});
			version++;
			return GetRoots();
		}

		/// <summary>
		/// Removes the document a node belongs to — dnSpy's Remove Assembly for one node. The node may be the
		/// root or anything under it, and the whole document goes either way.
		/// </summary>
		public RemoveModuleResponse RemoveModule(string nodeId) => RemoveRoots([nodeId]);

		/// <summary>
		/// Forgets everything the workspace held for one module: the nodes of its own tree, and the caches
		/// keyed by its file, which would otherwise answer for a later open of the same path out of the
		/// module that was removed. Answers with the ids of the nodes it dropped. Node ids are never handed
		/// out twice, so an id the client still holds names nothing rather than naming whatever took the
		/// removed module's place.
		/// </summary>
		IReadOnlyList<string> DropModule(ModuleEntry module) {
			// The net modules hanging off the assembly go with it, and their rows with them.
			var owned = netModules.Values.Where(entry => entry.Id == module.Id).ToArray();
			foreach (var netModule in owned)
				netModules.Remove(netModule.Path);
			// The module's own nodes are the ones whose owner is this entry: its assembly root, its module
			// row, and everything the tree has listed under them so far.
			var removed = nodes.Values
				.Where(entry => ReferenceEquals(entry.Module, module) || owned.Any(netModule => ReferenceEquals(entry.Module, netModule)))
				.Select(entry => entry.Id)
				.ToArray();
			foreach (var id in removed) {
				nodeIdsByKey.Remove(nodes[id].Key);
				nodes.Remove(id);
			}
			ForgetModuleCaches(module, owned);
			return removed;
		}

		/// <summary>
		/// Forgets what the workspace worked out from a module that leaves the tree — its indexes, its reference
		/// resolver and the references it resolved, and the module cached under its file for anything that reached
		/// it through a reference. All of it is rebuilt on demand, should the module come back.
		/// </summary>
		void ForgetModuleCaches(ModuleEntry module, IReadOnlyList<ModuleEntry> netModulesOfIt) {
			foreach (var netModule in netModulesOfIt) {
				namespaceIndexes.Remove(netModule.Path);
				typeIndexes.Remove(netModule.Path);
				typeReferenceIndexes.Remove(netModule.Path);
			}
			namespaceIndexes.Remove(module.Path);
			typeIndexes.Remove(module.Path);
			typeReferenceIndexes.Remove(module.Path);
			// The resolver holds the module's file open, and nothing reads it once the module is gone.
			if (referenceResolvers.Remove(module.Path, out var resolver))
				resolver?.Dispose();
			foreach (var key in referencePaths.Keys.Where(key => key.StartsWith($"{module.Path}:", StringComparison.Ordinal)).ToArray())
				referencePaths.Remove(key);
			// A module another assembly resolved this one through is the same file, so its cache entry goes
			// too; whatever still references it resolves it again the next time it is asked for.
			foreach (var name in referenceModules.Where(pair => pair.Value.Path == module.Path).Select(pair => pair.Key).ToArray())
				referenceModules.Remove(name);
			// The debug symbols are per module file, and the decompiler's statement map is keyed by state as
			// well as by node, so dropping the lot is the safe half of the trade: the next read rebuilds them.
			symbols.Invalidate();
		}

		/// <summary>
		/// The node dnSpy's "Go to Entry Point" and "Go to Global Cctor" navigate to: the module's entry
		/// point method, or the static constructor of its global type. Both are ordinary members of the
		/// module's tree, so the answer is the node the client reveals — null when the module has neither.
		/// </summary>
		public SpecialNodeResponse GetSpecialNode(SpecialNodeRequest request) {
			var module = ModuleOf(GetNode(request.NodeId));
			if (module is null)
				throw new RpcException(ErrorCodes.InvalidParams, "The selected node is not part of a managed assembly.");
			var method = request.Kind switch {
				SpecialNodeKinds.EntryPoint => module.Module.EntryPoint,
				SpecialNodeKinds.GlobalCctor => module.Module.GlobalType?.FindStaticConstructor(),
				_ => throw new RpcException(ErrorCodes.InvalidParams, $"Unknown special node kind: {request.Kind}"),
			};
			// The node is created here rather than looked up, so a member the tree has not listed yet still
			// answers with the id the tree would give it — GetNodePath builds the chain above it the same way.
			return new SpecialNodeResponse(method is null ? null : GetMemberNode(method, module).Id);
		}

		/// <summary>
		/// The node a metadata token names — dnSpy's "Go to Token". The token is read the way the tree and
		/// the copy commands write it ("0x06000001" or "06000001", or VB's "&amp;H06000001"), and the table it
		/// belongs to picks the kind, so a caller only has to pass on what the user typed. A reference token —
		/// a TypeRef, a TypeSpec, a MemberRef or a MethodSpec — goes to the definition it names, the way dnSpy's
		/// GoToTokenCommand resolves it, opening the assembly that defines it when it has to. A token with no
		/// row answers with dnSpy's "Invalid metadata token", one whose reference resolves to nothing with its
		/// "Could not resolve member reference token".
		/// </summary>
		public FindByTokenResponse FindByToken(FindByTokenRequest request) {
			var module = ModuleOf(GetNode(request.NodeId));
			if (module is null)
				throw new RpcException(ErrorCodes.InvalidParams, "The selected node is not part of a managed assembly.");
			if (!TryParseToken(request.Token, out var token))
				throw new RpcException(ErrorCodes.InvalidParams, "A metadata token is a 32-bit value such as 0x06000001.");
			return FindTokenNode(module, token);
		}

		/// <summary>The node a token of the module names, a reference followed to its definition — or why none.</summary>
		FindByTokenResponse FindTokenNode(ModuleEntry module, uint token) {
			IMDTokenProvider? provider;
			try {
				provider = module.Module.ResolveToken(token);
			}
			catch (Exception) {
				provider = null;
			}
			if (provider is null)
				return new FindByTokenResponse(null, string.Format(CultureInfo.InvariantCulture, "Invalid metadata token: 0x{0:X8}", token));
			var target = provider switch {
				TypeDef or MethodDef or FieldDef or PropertyDef or EventDef => ResolveInModule(module, token)?.NodeId,
				ITypeDefOrRef type => ResolveTypeInWorkspace(type, module) is var (resolved, resolvedModule) ? GetMemberNode(resolved, resolvedModule).Id : null,
				MemberRef { IsFieldRef: true } field => ResolveFieldInWorkspace(field, module)?.Id,
				IMethod method => ResolveMethodInWorkspace(method, module)?.Id,
				_ => null,
			};
			if (target is null && provider is ITypeDefOrRef or MemberRef or MethodSpec)
				return new FindByTokenResponse(null, string.Format(CultureInfo.InvariantCulture, "Could not resolve member reference token: 0x{0:X8}", token));
			return new FindByTokenResponse(target);
		}

		/// <summary>The managed module a node belongs to, or null when it belongs to a file the tree holds
		/// as something other than an assembly.</summary>
		static ModuleEntry? ModuleOf(NodeEntry node) => node.AsModuleEntry ?? node.Module as ModuleEntry;

		/// <summary>
		/// Reads a metadata token out of what a user typed: an optional "0x" and then hexadecimal. Anything
		/// else — including a value too large for 32 bits — is not a token.
		/// </summary>
		static bool TryParseToken(string? text, out uint token) {
			token = 0;
			if (string.IsNullOrWhiteSpace(text))
				return false;
			var digits = text.Trim().Replace("_", string.Empty, StringComparison.Ordinal);
			if (digits.StartsWith("0x", StringComparison.OrdinalIgnoreCase) || digits.StartsWith("&H", StringComparison.OrdinalIgnoreCase))
				digits = digits[2..];
			// Eight digits is what the tree writes; a shorter one is still read the same way, the way
			// dnSpy's token box accepts "0x6000001".
			return digits.Length is > 0 and <= 8
				&& uint.TryParse(digits, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out token);
		}

		public TreeNodesResponse GetChildren(string nodeId) {
			var node = GetNode(nodeId);
			var children = node.Kind switch {
				NodeKind.Assembly => GetAssemblyChildren(node),
				NodeKind.Module => GetModuleChildren(node),
				// dnSpy hangs its hex PE node off a PE document as well as off a module
				// (PEFilePETreeNodeDataProvider), so a native file can be inspected the same way.
				NodeKind.PEDocument => GetPeDocumentChildren(node),
				NodeKind.PE => GetPEChildren(node),
				// An ELF image has no PE node to hang its headers off, so it gets nodes of its own.
				NodeKind.ElfDocument => GetElfDocumentChildren(node),
				NodeKind.Elf => GetElfChildren(node),
				NodeKind.Namespace => GetNamespaceChildren(node),
				NodeKind.TypeReferencesGroup => GetTypeReferenceChildren(node),
				NodeKind.TypeReference => GetTypeReferenceNodeChildren(node),
				NodeKind.TypeSpecsFolder or NodeKind.MethodReferencesFolder or NodeKind.PropertyReferencesFolder
					or NodeKind.EventReferencesFolder or NodeKind.FieldReferencesFolder => GetTypeReferenceFolderChildren(node),
				NodeKind.ReferencesGroup => GetReferenceChildren(node),
				NodeKind.AssemblyReference => GetAssemblyReferenceChildren(node),
				NodeKind.ResourcesGroup => GetResourceChildren(node),
				NodeKind.Resource => GetEmbeddedResourceChildren(node),
				NodeKind.Type => GetTypeChildren(node),
				NodeKind.Property => GetPropertyChildren(node),
				NodeKind.Event => GetEventChildren(node),
				NodeKind.BaseTypeFolder => GetBaseTypeChildren(node),
				NodeKind.BaseType => GetBaseTypeNodeChildren(node),
				NodeKind.DerivedTypesFolder => GetDerivedTypesChildren(node),
				NodeKind.DerivedType => GetDerivedTypeNodeChildren(node),
				_ => Array.Empty<NodeEntry>(),
			};
			return new TreeNodesResponse(children.Select(ToDto).ToArray());
		}

		public TreeNodeDto GetNodeDto(string nodeId) => ToDto(GetNode(nodeId));

		/// <summary>
		/// The chain of nodes from the workspace root down to the given node, the root first and the node
		/// itself last. A client asks for it because it cannot derive a node's ancestors from the node id:
		/// a member's id names its module and token, not the type that declares it. Every node on the chain
		/// is built through the same keys the tree uses, so an id the tree already handed out comes back the
		/// same. The chain is empty for a node that has no root above it — a structure read out of a PE or
		/// ELF image, a resource, or a node of a module the workspace never opened.
		/// </summary>
		public TreeNodesResponse GetNodePath(string nodeId) =>
			new(GetNodePathCore(GetNode(nodeId)).Select(ToDto).ToArray());

		IReadOnlyList<NodeEntry> GetNodePathCore(NodeEntry node) {
			// A root is the root of itself, and a document for a file that is not a managed assembly has
			// nothing under it to walk down through.
			if (node.Kind is NodeKind.Assembly or NodeKind.PEDocument or NodeKind.ElfDocument or NodeKind.UnknownDocument)
				return [node];
			if (node.AsModuleEntry is not { } module)
				return [];
			// A type hierarchy node hangs off the type whose chain it lists, and that type is not named by
			// its own value — a base type holds the reference, a derived type holds a type that may live in
			// another module. No chain from a root can be assembled from the node here. The same goes for the
			// rows of the Type References folder and for the references an assembly reference expands into:
			// each hangs off a row its own value does not name.
			if (node.Kind is NodeKind.BaseTypeFolder or NodeKind.BaseType or NodeKind.DerivedTypesFolder or NodeKind.DerivedType
				or NodeKind.TypeReference or NodeKind.TypeSpecsFolder or NodeKind.MethodReferencesFolder or NodeKind.PropertyReferencesFolder
				or NodeKind.EventReferencesFolder or NodeKind.FieldReferencesFolder or NodeKind.MethodReference or NodeKind.PropertyReference
				or NodeKind.EventReference or NodeKind.FieldReference)
				return [];
			if (node.Kind == NodeKind.AssemblyReference && node.Key.Contains(":ref:", StringComparison.Ordinal))
				return [];
			// A net module hangs off the root of the assembly it belongs to, which shares its id.
			if (netModules.TryGetValue(module.Path, out var netModule) && ReferenceEquals(netModule, module)) {
				if (!nodes.TryGetValue(module.Id, out var assemblyRoot))
					return [];
				var netModuleNode = GetOrAddNode($"module:{module.Path}", NodeKind.Module, module.Module, module);
				return node.Kind == NodeKind.Module ? [assemblyRoot, node] : PathBelowModule(assemblyRoot, netModuleNode, node, module);
			}
			// An open module owns the module node hanging off its assembly root, which is the node
			// LoadModulesAsync created. A module reached through an assembly reference has no root of its
			// own, so no chain leads to its nodes and the caller walks its own tree instead.
			if (!nodeIdsByKey.ContainsKey($"assembly:{module.Path}"))
				return [];

			var root = GetOrAddNode($"assembly:{module.Path}", NodeKind.Assembly, module.Module.Assembly ?? (object)module.Module, module);
			if (node.Kind == NodeKind.Module)
				return [root, node];
			var moduleNode = GetOrAddNode($"module:{module.Path}", NodeKind.Module, module.Module, module);
			return PathBelowModule(root, moduleNode, node, module);
		}

		IReadOnlyList<NodeEntry> PathBelowModule(NodeEntry root, NodeEntry moduleNode, NodeEntry node, ModuleEntry module) {
			var chain = new List<NodeEntry> { root, moduleNode };
			switch (node.Kind) {
				case NodeKind.Namespace or NodeKind.PE or NodeKind.ReferencesGroup or NodeKind.ResourcesGroup or NodeKind.TypeReferencesGroup:
					chain.Add(node);
					return chain;
				case NodeKind.AssemblyReference or NodeKind.ModuleReference:
					chain.Add(GetOrAddNode($"{moduleNode.Key}:references", NodeKind.ReferencesGroup, module.Module, module));
					chain.Add(node);
					return chain;
				case NodeKind.Resource:
					chain.Add(GetOrAddNode($"{moduleNode.Key}:resources", NodeKind.ResourcesGroup, module.Module, module));
					chain.Add(node);
					return chain;
				case NodeKind.ResourceEntry:
					var resources = GetOrAddNode($"{moduleNode.Key}:resources", NodeKind.ResourcesGroup, module.Module, module);
					var ownerResource = ((ResourceEntryValue)node.Value).Owner;
					if (GetResourceChildren(resources).FirstOrDefault(child => ReferenceEquals(child.Value, ownerResource)) is not { } resourceNode)
						return [];
					chain.Add(resources);
					chain.Add(resourceNode);
					chain.Add(node);
					return chain;
			}

			// A type or one of its members: the namespace the outermost type sits in, the declaring types
			// from the outside in, and then the node.
			var declaringType = node.Value switch {
				TypeDef type => type,
				MethodDef method => method.DeclaringType,
				FieldDef field => field.DeclaringType,
				PropertyDef property => property.DeclaringType,
				EventDef @event => @event.DeclaringType,
				_ => null,
			};
			if (declaringType is null)
				return [];
			var types = new List<TypeDef>();
			for (var type = declaringType; type is not null; type = type.DeclaringType)
				types.Insert(0, type);
			var outermost = types[0];
			// Only a top-level type sits in a namespace; a nested one is listed under the type that
			// declares it. The global <Module> type sits in the empty namespace, where dnSpy lists it.
			if (outermost.DeclaringType is null) {
				var ns = outermost.Namespace.String ?? string.Empty;
				if (GetNamespaceIndex(module).Groups.TryGetValue(ns, out var group))
					chain.Add(GetOrAddNode($"{moduleNode.Key}:namespace:{ns}", NodeKind.Namespace, new NamespaceValue(ns, group), module));
			}
			foreach (var type in types)
				chain.Add(GetMemberNode(type, module));
			// An accessor method hangs off the property or event that owns it — dnSpy's PropertyNodeImpl
			// and EventNodeImpl list their accessors as children — so a chain down to one walks through
			// that member, which is the row the caller has to open before the method's own row exists.
			if (node.Value is MethodDef accessor && FindOwningPropertyOrEvent(accessor) is { } owner)
				chain.Add(GetMemberNode(owner, module));
			// The last declaring type is the node itself when the node is a type.
			if (node.Kind != NodeKind.Type)
				chain.Add(node);
			return chain;
		}

		IReadOnlyList<NodeEntry> GetModuleChildren(NodeEntry node) {
			var module = (ModuleDefMD)node.Value;
			var result = new List<NodeEntry>();

			// The order dnSpy's tree node groups give a module's children: the PE node, Type References,
			// References, Resources, then the namespaces — the empty one, "-", first.
			if (module.Metadata?.PEImage is { } peImage)
				result.Add(GetOrAddNode($"{node.Key}:pe", NodeKind.PE, peImage, node.Module));
			result.Add(GetOrAddNode($"{node.Key}:typerefs", NodeKind.TypeReferencesGroup, module, node.Module));
			// dnSpy's two folders check their children, so an empty one is not shown.
			if (HasReferences(module))
				result.Add(GetOrAddNode($"{node.Key}:references", NodeKind.ReferencesGroup, module, node.Module));
			if (module.Resources.Count != 0)
				result.Add(GetOrAddNode($"{node.Key}:resources", NodeKind.ResourcesGroup, module, node.Module));
			result.AddRange(GetNamespaceNodes(node.Key, node.AsModuleEntry!));

			return result;
		}

		/// <summary>
		/// The namespaces a module's top-level types are grouped into. The node ids come from the parent's
		/// key, so the same module reached two ways — its own node and an assembly reference to it — would
		/// list two sets of namespaces; that is why a reference to a module the workspace already has open
		/// hands back that module's own children instead of building its own.
		/// </summary>
		IEnumerable<NodeEntry> GetNamespaceNodes(string parentKey, ModuleEntry module) => GetNamespaceIndex(module)
			.Groups
			.OrderBy(g => g.Key, StringComparer.OrdinalIgnoreCase)
			.Select(g => GetOrAddNode(
				$"{parentKey}:namespace:{g.Key}",
				NodeKind.Namespace,
				new NamespaceValue(g.Key, g.Value),
				module));

		NamespaceIndex GetNamespaceIndex(ModuleEntry module) {
			if (namespaceIndexes.TryGetValue(module.Path, out var cached) && cached.StateId == stateId)
				return cached;
			// Every top-level type, the global <Module> type included: dnSpy groups them all by namespace, which
			// puts <Module> in the empty one.
			var groups = module.Module.Types
				.Where(t => t.DeclaringType is null)
				.GroupBy(t => t.Namespace.String ?? string.Empty, StringComparer.Ordinal)
				.ToDictionary(g => g.Key, g => (IReadOnlyList<TypeDef>)g.ToArray(), StringComparer.Ordinal);
			var index = new NamespaceIndex(stateId, groups);
			namespaceIndexes[module.Path] = index;
			return index;
		}

		IReadOnlyList<NodeEntry> GetNamespaceChildren(NodeEntry node) {
			// Derived live from the module rather than from the node's NamespaceValue snapshot: a delete
			// or a namespace rename mutates the module while this node stays cached, so a snapshot would
			// keep listing types that no longer belong here.
			var moduleEntry = node.AsModuleEntry!;
			var value = (NamespaceValue)node.Value;
			if (!GetNamespaceIndex(moduleEntry).Groups.TryGetValue(value.Name, out var types))
				return Array.Empty<NodeEntry>();
			return SortTypes(types)
				.Select(t => GetMemberNode(t, moduleEntry))
				.ToArray();
		}

		/// <summary>
		/// The PE node that hangs off a PE document, which is the only child dnSpy gives it: a native file has
		/// no .NET metadata, and it holds no child document of its own.
		/// </summary>
		IReadOnlyList<NodeEntry> GetPeDocumentChildren(NodeEntry node) =>
			node.Module is PeOnlyModuleEntry peEntry
				? new[] { GetOrAddNode($"{node.Key}:pe", NodeKind.PE, peEntry.PEImage, node.Module) }
				: Array.Empty<NodeEntry>();

		IReadOnlyList<NodeEntry> GetPEChildren(NodeEntry node) {
			var entry = (IModuleEntry)node.Module;
			return PeStructures(entry)
				.Select(structure => PeStructureNode(node, structure))
				.ToArray();
		}

		/// <summary>
		/// The structures an image is made of, in the order dnSpy's PENode.CreateChildren yields them: the DOS
		/// header, the file header, the optional header, every section, and then — for an image that carries
		/// .NET metadata — the CLR header and the metadata storage it points at.
		/// </summary>
		static IReadOnlyList<PeStructureValue> PeStructures(IModuleEntry entry) =>
			GetPeStructureSource(entry) is { } source ? PeStructures(source) : Array.Empty<PeStructureValue>();

		static IReadOnlyList<PeStructureValue> PeStructures(PeStructureSource source) {
			var structures = new List<PeStructureValue> {
				new(PeStructureKind.DosHeader, -1),
				new(PeStructureKind.FileHeader, -1),
				new(PeStructureKind.OptionalHeader, -1),
			};
			for (var i = 0; i < source.Image.ImageSectionHeaders.Count; i++)
				structures.Add(new PeStructureValue(PeStructureKind.Section, i));
			if (source.Metadata is { } metadata && metadata.ImageCor20Header is not null) {
				structures.Add(new PeStructureValue(PeStructureKind.Cor20Header, -1));
				if (metadata.MetadataHeader is not null) {
					structures.Add(new PeStructureValue(PeStructureKind.StorageSignature, -1));
					structures.Add(new PeStructureValue(PeStructureKind.StorageHeader, -1));
					for (var i = 0; i < metadata.AllStreams.Count; i++)
						structures.Add(new PeStructureValue(PeStructureKind.StorageStream, i));
				}
			}
			return structures;
		}

		/// <summary>
		/// What the PE structures of a file are read from: its image, and the metadata when it is a managed
		/// module. A file that is neither has none, and so has no structures.
		/// </summary>
		static PeStructureSource? GetPeStructureSource(IModuleEntry entry) => entry switch {
			ModuleEntry module when module.Module.Metadata is { } metadata && metadata.PEImage as PEImage is { } peImage =>
				new PeStructureSource(peImage, metadata),
			PeOnlyModuleEntry peOnly => new PeStructureSource(peOnly.PEImage, null),
			_ => null,
		};

		NodeEntry PeStructureNode(NodeEntry peNode, PeStructureValue value) => GetOrAddNode(
			$"{peNode.Key}:{value.Kind.ToString().ToLowerInvariant()}:{value.Index}",
			NodeKind.PeStructure,
			value,
			peNode.Module);

		/// <summary>
		/// The ELF node that hangs off an ELF document, which is the only child it has: the file's own name is
		/// the document, and everything worth expanding is under this node.
		/// </summary>
		IReadOnlyList<NodeEntry> GetElfDocumentChildren(NodeEntry node) =>
			node.Module is ElfFileEntry elfEntry
				? new[] { GetOrAddNode($"{node.Key}:elf", NodeKind.Elf, elfEntry.Elf, node.Module) }
				: Array.Empty<NodeEntry>();

		IReadOnlyList<NodeEntry> GetElfChildren(NodeEntry node) {
			var elf = (ElfImage)node.Value;
			return ElfStructures(elf)
				.Select(structure => ElfStructureNode(node, structure))
				.ToArray();
		}

		/// <summary>
		/// The structures an ELF image is made of, in the order <c>readelf -h -l -S</c> prints them: the file
		/// header, every program header, then every section header.
		/// </summary>
		static IReadOnlyList<ElfStructureValue> ElfStructures(ElfImage elf) {
			var structures = new List<ElfStructureValue> { new(ElfStructureKind.FileHeader, -1) };
			for (var i = 0; i < elf.ProgramHeaders.Count; i++)
				structures.Add(new ElfStructureValue(ElfStructureKind.ProgramHeader, i));
			for (var i = 0; i < elf.Sections.Count; i++)
				structures.Add(new ElfStructureValue(ElfStructureKind.SectionHeader, i));
			return structures;
		}

		NodeEntry ElfStructureNode(NodeEntry elfNode, ElfStructureValue value) => GetOrAddNode(
			$"{elfNode.Key}:{value.Kind.ToString().ToLowerInvariant()}:{value.Index}",
			NodeKind.ElfStructure,
			value,
			elfNode.Module);

		/// <summary>An open module whose assembly goes by this simple name. Matching on the name alone is
		/// what dnSpy does: a reference and the assembly it names can differ in version and still be the
		/// same assembly to the tree.</summary>
		ModuleEntry? FindOpenModuleByName(string name) => modules.Values.FirstOrDefault(module =>
			(module.Module.Assembly?.Name.String ?? module.Module.Name.String) == name);

		/// <summary>
		/// The module a reference names, loaded from the file it resolves to, or null when nothing on this
		/// machine provides it. Kept forever rather than cached with an eviction bound: the nodes built for
		/// its types hold this object, so releasing it would leave them pointing at a disposed module.
		/// </summary>
		ModuleEntry? LoadReferenceModule(ModuleEntry owner, AssemblyRef reference) {
			var name = reference.Name.String;
			if (name.Length == 0)
				return null;
			if (referenceModules.TryGetValue(name, out var cached))
				return cached;
			if (ReferencePath(owner, reference) is not { } path)
				return null;
			ModuleDefMD module;
			try {
				module = ModuleDefMD.Load(path);
			}
			catch (Exception ex) when (ex is BadImageFormatException or IOException or UnauthorizedAccessException) {
				// A file the resolver offered but dnlib cannot read is treated as an unresolved reference.
				referencePaths[ReferenceKey(owner, name)] = null;
				return null;
			}
			var entry = new ModuleEntry(path, module);
			referenceModules.Add(name, entry);
			return entry;
		}

		/// <summary>
		/// The file a reference resolves to, or null when it resolves to nothing. Searched once per
		/// referencing module and reference, since the answer cannot change while the workspace is open.
		/// </summary>
		string? ReferencePath(ModuleEntry owner, AssemblyRef reference) {
			var key = ReferenceKey(owner, reference.Name.String);
			if (referencePaths.TryGetValue(key, out var cached))
				return cached;
			var path = ReferenceResolverFor(owner)?.FindFile(reference);
			referencePaths.Add(key, path);
			return path;
		}

		/// <summary>
		/// The file a reference of this module resolves to, for a caller outside the tree that has to
		/// follow the reference itself — the debug engine, on its way into a call it cannot read.
		/// </summary>
		internal string? FindReferencePath(ModuleEntry owner, AssemblyRef reference) => ReferencePath(owner, reference);

		static string ReferenceKey(ModuleEntry owner, string name) => $"{owner.Path}:{name}";

		/// <summary>
		/// The resolver that searches for this module's references, built from the module's own file because
		/// the search paths a framework assembly lives on depend on the module's target framework. A module
		/// the resolver cannot be built for is remembered as such, so the failure is not retried per node.
		/// </summary>
		AssemblyReferenceResolver? ReferenceResolverFor(ModuleEntry owner) {
			if (referenceResolvers.TryGetValue(owner.Path, out var cached))
				return cached;
			AssemblyReferenceResolver? resolver;
			try {
				resolver = new AssemblyReferenceResolver(owner.Path);
			}
			catch (Exception ex) when (ex is BadImageFormatException or IOException or UnauthorizedAccessException) {
				resolver = null;
			}
			referenceResolvers.Add(owner.Path, resolver);
			return resolver;
		}

		/// <summary>
		/// Finds the file an assembly reference points at, the same way the decompiler finds the assemblies
		/// it is asked to load: the module's own directory, then the directories its target framework names.
		/// </summary>
		/// <remarks>
		/// The module's file is held open for as long as the resolver is, because detecting the target
		/// framework and the runtime pack reads it.
		/// </remarks>
		sealed class AssemblyReferenceResolver : IDisposable {
			readonly ICSharpCode.Decompiler.Metadata.PEFile file;
			readonly GacFallbackAssemblyResolver resolver;

			public AssemblyReferenceResolver(string modulePath) {
				file = new ICSharpCode.Decompiler.Metadata.PEFile(modulePath, PEStreamOptions.PrefetchMetadata);
				resolver = GacFallbackAssemblyResolver.Create(modulePath, file, throwOnError: false);
			}

			/// <summary>The file the reference resolves to, or null when nothing provides it — the global
			/// assembly caches last, the way dnSpy's resolver falls back on them. An assembly the search cannot
			/// make sense of is the same as one it cannot find: neither has anything to show, and letting it
			/// throw would fail the whole tree listing over one bad reference.</summary>
			public string? FindFile(AssemblyRef reference) {
				try {
					return resolver.FindAssemblyFile(new ReferenceName(reference));
				}
				catch (Exception) {
					return null;
				}
			}

			public void Dispose() => file.Dispose();

			/// <summary>
			/// A dnlib reference handed to the decompiler's resolver, which searches by simple name and
			/// version. The rest of the identity is passed through unchanged so that a resolver that does
			/// compare it — a framework assembly is matched by name, but a shared one is not — sees what
			/// dnlib read rather than a rewritten version of it.
			/// </summary>
			sealed class ReferenceName(AssemblyRef reference) : ICSharpCode.Decompiler.Metadata.IAssemblyReference {
				public string Name => reference.Name.String;
				public string FullName => reference.FullName;
				public Version? Version => reference.Version;
				public string? Culture => reference.Culture?.String;
				public byte[]? PublicKeyToken => reference.PublicKeyOrToken?.Data;
				public bool IsWindowsRuntime => false;
				public bool IsRetargetable => (reference.Attributes & AssemblyAttributes.Retargetable) != 0;
			}
		}

		IReadOnlyList<NodeEntry> GetTypeChildren(NodeEntry node) {
			var type = (TypeDef)node.Value;
			var moduleEntry = node.AsModuleEntry!;
			var result = new List<NodeEntry>();
			// dnSpy's TypeNodeImpl yields the two hierarchy folders ahead of the members, and they are
			// always there whether or not the type has a base type or a subtype.
			result.Add(GetOrAddNode($"{node.Key}:basetypes", NodeKind.BaseTypeFolder, type, moduleEntry));
			result.Add(GetOrAddNode($"{node.Key}:derivedtypes", NodeKind.DerivedTypesFolder, type, moduleEntry));
			// The member groups in dnSpy's default order — methods, properties, events, fields, nested types —
			// each sorted the way its tree node group sorts it. The Assembly Explorer options can put the
			// groups in another order, which the client applies, since the groups stay together either way.
			// A property's or an event's accessor methods are not listed beside the member they implement:
			// dnSpy keeps them under it, so the tree shows one row per member instead of "Code" followed by
			// a loose "get_Code()" that repeats it.
			var accessors = GetPropertyAndEventMethods(type);
			result.AddRange(SortMethods(type.Methods.Where(m => !accessors.Contains(m))).Select(m => GetMemberNode(m, moduleEntry)));
			result.AddRange(SortByNameAndToken(type.Properties).Select(p => GetMemberNode(p, moduleEntry)));
			result.AddRange(SortByNameAndToken(type.Events).Select(e => GetMemberNode(e, moduleEntry)));
			result.AddRange(SortByNameAndToken(type.Fields).Select(f => GetMemberNode(f, moduleEntry)));
			result.AddRange(SortTypes(type.NestedTypes).Select(t => GetMemberNode(t, moduleEntry)));
			return result;
		}

		/// <summary>
		/// Every method a type's properties and events own, which is dnSpy's
		/// <c>Extensions.GetPropertyAndEventMethods</c>. The type's own method list is filtered through it:
		/// those methods are the accessors shown under the member that declares them.
		/// </summary>
		static HashSet<MethodDef> GetPropertyAndEventMethods(TypeDef type) {
			var methods = new HashSet<MethodDef>();
			foreach (var property in type.Properties) {
				foreach (var method in property.GetMethods)
					methods.Add(method);
				foreach (var method in property.SetMethods)
					methods.Add(method);
				foreach (var method in property.OtherMethods)
					methods.Add(method);
			}
			foreach (var @event in type.Events) {
				if (@event.AddMethod is { } add)
					methods.Add(add);
				if (@event.RemoveMethod is { } remove)
					methods.Add(remove);
				if (@event.InvokeMethod is { } invoke)
					methods.Add(invoke);
				foreach (var method in @event.OtherMethods)
					methods.Add(method);
			}
			return methods;
		}

		/// <summary>
		/// The property or event a method is an accessor of, or null when the method is an ordinary one.
		/// dnSpy files an accessor under the member it implements rather than under the type, and this is
		/// what walks a chain from a type down to such a method.
		/// </summary>
		static IMDTokenProvider? FindOwningPropertyOrEvent(MethodDef method) {
			if (method.DeclaringType is not { } type)
				return null;
			foreach (var property in type.Properties) {
				if (OwnsAccessor(property, method))
					return property;
			}
			foreach (var @event in type.Events) {
				if (OwnsAccessor(@event, method))
					return @event;
			}
			return null;
		}

		static bool OwnsAccessor(PropertyDef property, MethodDef method) =>
			property.GetMethods.Contains(method) || property.SetMethods.Contains(method) || property.OtherMethods.Contains(method);

		static bool OwnsAccessor(EventDef @event, MethodDef method) =>
			@event.AddMethod == method || @event.RemoveMethod == method || @event.InvokeMethod == method || @event.OtherMethods.Contains(method);

		/// <summary>
		/// The methods dnSpy's PropertyNodeImpl lists under a property: the getters, then the setters, then
		/// any other method the property owns.
		/// </summary>
		IReadOnlyList<NodeEntry> GetPropertyChildren(NodeEntry node) {
			var property = (PropertyDef)node.Value;
			var moduleEntry = node.AsModuleEntry!;
			// dnSpy files the accessors in one group and sorts it the way it sorts methods, by name first.
			return SortMethods(property.GetMethods.Concat(property.SetMethods).Concat(property.OtherMethods).Distinct())
				.Select(m => GetMemberNode(m, moduleEntry))
				.ToArray();
		}

		/// <summary>
		/// The methods dnSpy's EventNodeImpl lists under an event, in its order: the adder, the remover,
		/// the raiser, then any other method the event owns.
		/// </summary>
		IReadOnlyList<NodeEntry> GetEventChildren(NodeEntry node) {
			var @event = (EventDef)node.Value;
			var moduleEntry = node.AsModuleEntry!;
			var accessors = new List<MethodDef>();
			if (@event.AddMethod is { } add)
				accessors.Add(add);
			if (@event.RemoveMethod is { } remove)
				accessors.Add(remove);
			if (@event.InvokeMethod is { } invoke)
				accessors.Add(invoke);
			accessors.AddRange(@event.OtherMethods);
			// Sorted like methods, by name, the way dnSpy's group sorts them: add_, raise_, remove_.
			return SortMethods(accessors.Distinct()).Select(m => GetMemberNode(m, moduleEntry)).ToArray();
		}

		/// <summary>Whether a property or an event owns any accessor method at all — a member without one
		/// has nothing to expand, the way dnSpy's node shows no expander when it has no children.</summary>
		static bool HasAccessorMethods(NodeEntry node) => node.Value switch {
			PropertyDef property => property.GetMethods.Count != 0 || property.SetMethods.Count != 0 || property.OtherMethods.Count != 0,
			EventDef @event => @event.AddMethod is not null || @event.RemoveMethod is not null || @event.InvokeMethod is not null || @event.OtherMethods.Count != 0,
			_ => false,
		};


		/// <summary>
		/// The "Base Type and Interfaces" folder under a type: the base type first, then every interface,
		/// in the order dnSpy's BaseTypeFolderNodeImpl yields them.
		/// </summary>
		IReadOnlyList<NodeEntry> GetBaseTypeChildren(NodeEntry node) {
			var type = (TypeDef)node.Value;
			var moduleEntry = node.AsModuleEntry!;
			return BaseTypeRows(node, type, moduleEntry);
		}

		/// <summary>The base type, then the interfaces sorted by name — dnSpy's BaseTypeTreeNodeGroup, which puts
		/// the two kinds in groups of their own.</summary>
		IReadOnlyList<NodeEntry> BaseTypeRows(NodeEntry parent, TypeDef type, ModuleEntry moduleEntry) {
			var result = new List<NodeEntry>();
			if (type.BaseType is not null)
				result.Add(GetBaseTypeNode(parent, type.BaseType, true, moduleEntry));
			result.AddRange(type.Interfaces
				.Select(iface => iface.Interface)
				.Where(iface => iface is not null)
				.OrderBy(iface => iface.Name.String, StringComparer.OrdinalIgnoreCase)
				.Select(iface => GetBaseTypeNode(parent, iface, false, moduleEntry)));
			return result;
		}

		/// <summary>
		/// A base type node expands the way dnSpy's BaseTypeNodeImpl does: into that type's own base type
		/// and interfaces. The type is resolved across the open modules first, so a base type the workspace
		/// holds keeps walking; one it does not resolve has no chain and stays a leaf.
		/// </summary>
		IReadOnlyList<NodeEntry> GetBaseTypeNodeChildren(NodeEntry node) {
			var moduleEntry = node.AsModuleEntry!;
			var resolved = ResolveTypeForHierarchy(((BaseTypeValue)node.Value).TypeDefOrRef);
			return resolved is null ? [] : BaseTypeRows(node, resolved, moduleEntry);
		}

		/// <summary>
		/// The "Derived Types" folder under a type: every type in the open modules that derives from it,
		/// which is what dnSpy's DerivedTypesFinder searches for. A sealed class can never have one, and
		/// the folder then holds nothing at all.
		/// </summary>
		IReadOnlyList<NodeEntry> GetDerivedTypesChildren(NodeEntry node) {
			var type = (TypeDef)node.Value;
			if (!CanHaveDerivedTypes(type))
				return [];
			return FindDerivedTypes(node, type);
		}

		/// <summary>
		/// A derived type node expands into the types derived from it, the same search dnSpy's
		/// DerivedTypeNodeImpl runs for its own node.
		/// </summary>
		IReadOnlyList<NodeEntry> GetDerivedTypeNodeChildren(NodeEntry node) {
			var type = (TypeDef)node.Value;
			return CanHaveDerivedTypes(type) ? FindDerivedTypes(node, type) : [];
		}

		NodeEntry GetBaseTypeNode(NodeEntry parent, ITypeDefOrRef type, bool isBaseType, ModuleEntry moduleEntry) =>
			GetOrAddNode(
				$"{parent.Key}:basetype:{type.MDToken.Raw:X8}",
				NodeKind.BaseType,
				new BaseTypeValue(type, isBaseType),
				moduleEntry);

		IReadOnlyList<NodeEntry> FindDerivedTypes(NodeEntry parent, TypeDef type) {
			var moduleEntry = parent.AsModuleEntry!;
			var comparer = new SigComparer();
			var result = new List<(TypeDef Type, ModuleEntry Module)>();
			foreach (var module in OrderedModules()) {
				foreach (var candidate in module.Module.GetTypes()) {
					if (candidate == type)
						continue;
					if (!DerivesFrom(type, candidate, comparer))
						continue;
					result.Add((candidate, module));
				}
			}
			// dnSpy's DerivedTypeTreeNodeGroup sorts the rows by the type's name.
			return result
				.OrderBy(found => found.Type.Name.String, StringComparer.OrdinalIgnoreCase)
				.Select(found => GetOrAddNode(
					$"{parent.Key}:derived:{found.Module.Path}:{found.Type.MDToken.Raw:X8}",
					NodeKind.DerivedType,
					found.Type,
					moduleEntry))
				.ToArray();
		}

		/// <summary>dnSpy's DerivedTypesFinder.QuickCheck: only an interface or a non-sealed type can be
		/// derived from, so a sealed class never opens the search.</summary>
		static bool CanHaveDerivedTypes(TypeDef type) => type.IsInterface || !type.IsSealed;

		/// <summary>
		/// Whether a candidate derives from the type: an interface is implemented, a class is extended.
		/// The comparison is <see cref="SigComparer"/>'s, the one dnSpy's finder uses, so the base or
		/// interface seen from another module matches the type this one declares.
		/// </summary>
		static bool DerivesFrom(TypeDef type, TypeDef candidate, SigComparer comparer) {
			if (type.IsInterface) {
				foreach (var iface in candidate.Interfaces) {
					if (comparer.Equals(type, GetScopeType(iface.Interface)))
						return true;
				}
				return false;
			}
			return candidate.BaseType is { } baseType && comparer.Equals(type, GetScopeType(baseType));
		}

		/// <summary>A TypeSpec is a signature, not the type itself; its scope type is the type it is built
		/// on, which is what a comparison — or an icon — needs. dnSpy's Extensions.GetScopeType.</summary>
		static ITypeDefOrRef GetScopeType(ITypeDefOrRef type) {
			if (type is TypeSpec typeSpec) {
				var signature = typeSpec.TypeSig.RemovePinnedAndModifiers();
				if (signature is GenericInstSig generic)
					return generic.GenericType?.TypeDefOrRef ?? type;
				if (signature is TypeDefOrRefSig typeDefOrRef)
					return typeDefOrRef.TypeDefOrRef ?? type;
			}
			return type;
		}

		/// <summary>
		/// Resolves a base or interface reference to the type it names, preferring the modules the
		/// workspace holds over dnlib's resolver so a type in an open module resolves to that very
		/// definition — the one the tree shows. A type from a module nobody opened may still resolve
		/// through the assembly resolver; when it does not, the node is a leaf and shows a plain icon.
		/// </summary>
		TypeDef? ResolveTypeForHierarchy(ITypeDefOrRef type) {
			if (type is TypeDef typeDef)
				return typeDef;
			var scope = GetScopeType(type);
			if (scope is TypeDef scopeDef)
				return scopeDef;
			var name = scope.FullName;
			foreach (var module in OrderedModules()) {
				if (GetTypeIndex(module).TryGetValue(name, out var found))
					return found;
			}
			try {
				return scope.ResolveTypeDef();
			}
			catch {
				return null;
			}
		}

		/// <summary>Every type a module declares, nested ones included, by full name. Built once per
		/// workspace state and shared by every hierarchy node, the way the namespace index is.</summary>
		IReadOnlyDictionary<string, TypeDef> GetTypeIndex(ModuleEntry module) {
			if (typeIndexes.TryGetValue(module.Path, out var cached) && cached.StateId == stateId)
				return cached.Types;
			var types = new Dictionary<string, TypeDef>(StringComparer.Ordinal);
			foreach (var type in module.Module.GetTypes())
				types[type.FullName] = type;
			var index = new TypeIndex(stateId, types);
			typeIndexes[module.Path] = index;
			return index.Types;
		}

		// ILSpy owns its metadata and syntax tree. Only preparing the snapshot and publishing references
		// need the workspace gate; holding it through DecompileWholeModuleAsSingleFile makes a tree click
		// wait for an unrelated document (including a document restored at startup) to finish.
		public async Task<DecompileResponse> DecompileDocumentAsync(DecompileRequest request, CancellationToken cancellationToken) {
			if (request.Language is not (DecompilerLanguage.CSharp or DecompilerLanguage.VisualBasic))
				return await RunAsync(w => w.DecompileAsync(request, cancellationToken), cancellationToken).ConfigureAwait(false);

			try {
				var prepared = await RunAsync(w => w.PrepareCSharpDecompilation(request.NodeId, request.Settings, cancellationToken), cancellationToken).ConfigureAwait(false);
				if (prepared is null)
					return await RunAsync(w => w.DecompileAsync(request, cancellationToken), cancellationToken).ConfigureAwait(false);
				using var session = prepared.Session;
				var syntaxTree = await Task.Run(() => prepared.WholeModule
					? session.Decompiler.DecompileWholeModuleAsSingleFile()
					: session.Decompiler.Decompile(prepared.Handles), cancellationToken).ConfigureAwait(false);
				var csharp = await RunAsync(w => {
					// An edit, reload or close while ILSpy worked must not publish spans or a statement map
					// against different metadata. Shared dnlib objects and node dictionaries remain protected.
					if (stateId != prepared.StateId)
						throw new OperationCanceledException("The workspace changed while the document was decompiled.");
					cancellationToken.ThrowIfCancellationRequested();
					return w.FinishCSharpDecompilation(GetNode(request.NodeId), session.Decompiler, syntaxTree, prepared.Settings, cancellationToken);
				}, cancellationToken).ConfigureAwait(false);
				return request.Language == DecompilerLanguage.VisualBasic
					? await ConvertToVisualBasicAsync(csharp, cancellationToken).ConfigureAwait(false)
					: csharp;
			}
			catch (OperationCanceledException) {
				throw;
			}
			catch (RpcException) {
				throw;
			}
			catch (Exception ex) {
				throw new RpcException(ErrorCodes.UnsupportedDocument, "The selected item could not be decompiled.", null, ex);
			}
		}

		CSharpDecompilation? PrepareCSharpDecompilation(string nodeId, DecompilerSettingsDto? settingsDto, CancellationToken cancellationToken) {
			var node = GetNode(nodeId);
			if (node.AsModuleEntry is not { } module || node.Kind is not (NodeKind.Assembly or NodeKind.Module or NodeKind.Namespace or NodeKind.Type or NodeKind.Method or NodeKind.Field or NodeKind.Property or NodeKind.Event))
				return null;
			var wholeModule = node.Kind is NodeKind.Assembly or NodeKind.Module;
			var handles = node.Kind == NodeKind.Namespace
				? GetNamespaceIndex(module).Groups.GetValueOrDefault(((NamespaceValue)node.Value).Name, Array.Empty<TypeDef>()).Select(ToEntityHandle).ToArray()
				: wholeModule ? Array.Empty<System.Reflection.Metadata.EntityHandle>() : [ToEntityHandle((IMDTokenProvider)node.Value)];
			var settings = settingsDto.ToDecompilerSettings();
			return new CSharpDecompilation(stateId, wholeModule, handles, settings, CreateCSharpDecompilerSession(module, settings, cancellationToken));
		}

		DecompileResponse FinishCSharpDecompilation(NodeEntry node, CSharpDecompiler decompiler, SyntaxTree syntaxTree, DecompilerSettings settings, CancellationToken cancellationToken) {
			var module = node.AsModuleEntry!;
			var output = new SpanTextOutput(reference => ResolveDecompilerReference(reference, module));
			RenderWithLocations(syntaxTree, output, settings);
			var statements = BuildCodeStatements(syntaxTree, decompiler, module, cancellationToken);
			RefreshStatementCache();
			codeStatementsByNode[$"{node.Id}:{stateId}"] = statements;
			return new DecompileResponse(GetDocumentTitle(node), "csharp", output.ToString(), output.Spans,
				decompiler.Errors.Select(e => new DiagnosticDto("warning", e.ToString())).ToArray()) { CodeStatements = statements };
		}

		sealed record CSharpDecompilation(string StateId, bool WholeModule, System.Reflection.Metadata.EntityHandle[] Handles, DecompilerSettings Settings, CSharpDecompilerSession Session);

		public async Task<DecompileResponse> DecompileAsync(DecompileRequest request, CancellationToken cancellationToken) {
			var node = GetNode(request.NodeId);
			cancellationToken.ThrowIfCancellationRequested();
			if (node.Kind is NodeKind.Resource or NodeKind.ResourceEntry)
				return DecompileResource(node, request.Language, cancellationToken);
			// A type hierarchy node, a reference and the folders that hold them have no code in any language:
			// dnSpy's NodeDecompiler writes a comment per row whatever decompiler is chosen, so the language
			// request only picks how a comment starts.
			if (CommentDocumentLines(node) is { } lines) {
				var comment = request.Language == DecompilerLanguage.VisualBasic ? "'" : "//";
				var text = string.Concat(lines.Select(line => $"{comment} {line}\n"));
				return new DecompileResponse(GetDocumentTitle(node), request.Language == DecompilerLanguage.VisualBasic ? "visual-basic" : "csharp", text, Array.Empty<TextSpanDto>(), Array.Empty<DiagnosticDto>());
			}
			return request.Language switch {
				DecompilerLanguage.CSharp => DecompileCSharp(node, request.Settings, cancellationToken),
				DecompilerLanguage.IL => DecompileIL(node),
				DecompilerLanguage.ILWithCSharp => DecompileILWithCSharp(node, cancellationToken),
				DecompilerLanguage.VisualBasic => await DecompileVisualBasicAsync(node, cancellationToken).ConfigureAwait(false),
				_ => throw new RpcException(ErrorCodes.InvalidParams, "Unknown decompiler language."),
			};
		}

		/// <summary>
		/// The lines of a document that is only comments — what dnSpy's NodeDecompiler writes for a node that
		/// is no code: a type hierarchy row its type's reflection name, an assembly reference its full name, a
		/// module reference its name, and a folder one line per row it holds. A row dnSpy has no decompiler for
		/// at all — the rows of the Type References folder — writes the text it wears. Null for every node
		/// that is code.
		/// </summary>
		IReadOnlyList<string>? CommentDocumentLines(NodeEntry node) {
			switch (node.Kind) {
				case NodeKind.BaseType or NodeKind.DerivedType or NodeKind.AssemblyReference or NodeKind.ModuleReference:
					return [CommentLine(node)];
				case NodeKind.BaseTypeFolder:
					return GetBaseTypeChildren(node).Select(CommentLine).ToArray();
				case NodeKind.DerivedTypesFolder:
					return GetDerivedTypesChildren(node).Select(CommentLine).ToArray();
				case NodeKind.ReferencesGroup:
					return GetReferenceChildren(node).Select(CommentLine).ToArray();
				case NodeKind.TypeReferencesGroup or NodeKind.TypeReference or NodeKind.TypeSpecsFolder or NodeKind.MethodReferencesFolder
					or NodeKind.PropertyReferencesFolder or NodeKind.EventReferencesFolder or NodeKind.FieldReferencesFolder
					or NodeKind.MethodReference or NodeKind.PropertyReference or NodeKind.EventReference or NodeKind.FieldReference:
					return [RowText(node)];
				default:
					return null;
			}
		}

		string CommentLine(NodeEntry node) => node.Value switch {
			BaseTypeValue value => value.TypeDefOrRef.ReflectionFullName,
			TypeDef type => type.ReflectionFullName,
			AssemblyRef reference => reference.FullName,
			ModuleRef reference => reference.Name.String,
			_ => GetLabel(node),
		};

		/// <summary>The text a row wears — its label, the type after a colon and its token — which is what dnSpy
		/// writes for a node it has no decompiler for.</summary>
		string RowText(NodeEntry node) {
			var text = new StringBuilder(GetLabel(node));
			if (GetMemberReturnType(node) is { } returnType)
				text.Append(" : ").Append(returnType);
			if (GetMetadataToken(node) is { } token)
				text.Append(" @").Append(unchecked((uint)token).ToString("X8", CultureInfo.InvariantCulture));
			return text.ToString();
		}

		DecompileResponse DecompileCSharp(NodeEntry node, DecompilerSettingsDto? settingsDto, CancellationToken cancellationToken) {
			// A PE node and its structures are not decompiled code: they are the headers, sections and metadata
			// of the image, read straight out of the file (dnSpy's AsmEditor hex nodes). The ELF structures
			// are the same thing under a different file format.
			if (node.Kind is NodeKind.PE or NodeKind.PeStructure)
				return DecompilePeStructure(node);
			if (node.Kind is NodeKind.Elf or NodeKind.ElfStructure)
				return DecompileElfStructure(node);
			var moduleEntry = node.AsModuleEntry;
			// Neither a PE-only file, an ELF image nor one dnSpy could not read has any C# to decompile, so
			// the document says what the file is instead of showing an empty tab.
			if (moduleEntry is null) {
				if (node.AsPeOnlyModuleEntry is { } peEntry)
					return DecompilePEInfo(node, peEntry);
				if (node.Module is ElfFileEntry elfEntry)
					return DecompileElfInfo(node, elfEntry);
				return DecompileUnknownFile(node);
			}
			var settings = settingsDto.ToDecompilerSettings();
			try {
				using var session = CreateCSharpDecompilerSession(moduleEntry, settings, cancellationToken);
				var decompiler = session.Decompiler;

				var syntaxTree = node.Kind switch {
					NodeKind.Assembly => decompiler.DecompileWholeModuleAsSingleFile(),
					NodeKind.Module => decompiler.DecompileWholeModuleAsSingleFile(),
					NodeKind.Namespace => decompiler.Decompile(GetNamespaceIndex(moduleEntry).Groups.GetValueOrDefault(((NamespaceValue)node.Value).Name, Array.Empty<TypeDef>()).Select(ToEntityHandle)),
					NodeKind.Type or NodeKind.Method or NodeKind.Field or NodeKind.Property or NodeKind.Event =>
						decompiler.Decompile([ToEntityHandle((IMDTokenProvider)node.Value)]),
					_ => throw new RpcException(ErrorCodes.UnsupportedDocument, "This tree node cannot be decompiled."),
				};
				return FinishCSharpDecompilation(node, decompiler, syntaxTree, settings, cancellationToken);
			}
			catch (OperationCanceledException) {
				throw;
			}
			catch (Exception ex) {
				throw new RpcException(ErrorCodes.UnsupportedDocument, "The selected item could not be decompiled.", null, ex);
			}
		}

		/// <summary>
		/// A file that is not a managed assembly and not a PE image — an ELF binary, a script, a file that
		/// went away. dnSpy opens it all the same and its tab holds the file name as a comment
		/// (NodeDecompiler.DecompileUnknown); the diagnostic says why there is nothing else to show.
		/// </summary>
		DecompileResponse DecompileUnknownFile(NodeEntry node) {
			var path = ((IModuleEntry)node.Module).Path;
			return new DecompileResponse(
				GetLabel(node),
				"csharp",
				$"// {Path.GetFileName(path)}" + Environment.NewLine,
				Array.Empty<TextSpanDto>(),
				[new DiagnosticDto("info", $"{path} is not a managed assembly or a valid PE file, so it has no code to show.")]);
		}

		/// <summary>
		/// The document of a PE node or of one PE structure under it. A PE node shows every structure it holds
		/// in one document, the way dnSpy's PENode decompiles its children.
		/// </summary>
		DecompileResponse DecompilePeStructure(NodeEntry node) {
			var entry = (IModuleEntry)node.Module;
			var source = GetPeStructureSource(entry);
			var builder = new StringBuilder();
			if (node.Kind == NodeKind.PE) {
				builder.AppendLine($"// {Path.GetFileName(entry.Path)}");
				builder.AppendLine();
				AppendPeStructures(builder, entry);
			}
			else if (source is not null) {
				var value = (PeStructureValue)node.Value;
				PeStructureFormatter.Append(builder, source, value.Kind, value.Index);
			}
			return new DecompileResponse(
				GetLabel(node),
				"csharp",
				builder.ToString(),
				Array.Empty<TextSpanDto>(),
				Array.Empty<DiagnosticDto>());
		}

		/// <summary>Every structure of an image, one block after another.</summary>
		static void AppendPeStructures(StringBuilder builder, IModuleEntry entry) {
			if (GetPeStructureSource(entry) is not { } source)
				return;
			foreach (var structure in PeStructures(source)) {
				PeStructureFormatter.Append(builder, source, structure.Kind, structure.Index);
				builder.AppendLine();
			}
		}

		/// <summary>
		/// The document of an ELF node or of one ELF structure under it. It is the PE node's document under
		/// another format: the node shows every structure it holds, a structure shows its own fields.
		/// </summary>
		DecompileResponse DecompileElfStructure(NodeEntry node) {
			// The node carries the image itself, a structure node only names one of its parts, so the image
			// comes from the file either way.
			var image = ((ElfFileEntry)node.Module).Elf;
			var builder = new StringBuilder();
			if (node.Kind == NodeKind.Elf) {
				builder.AppendLine($"// {Path.GetFileName(((IModuleEntry)node.Module).Path)}");
				builder.AppendLine();
				AppendElfStructures(builder, image);
			}
			else {
				var value = (ElfStructureValue)node.Value;
				ElfStructureFormatter.Append(builder, image, value.Kind, value.Index);
			}
			return new DecompileResponse(
				GetLabel(node),
				"csharp",
				builder.ToString(),
				Array.Empty<TextSpanDto>(),
				Array.Empty<DiagnosticDto>());
		}

		/// <summary>
		/// The document of a file that is an ELF image. dnSpy has no such document, but on Linux this is what
		/// a native binary the user picked turns out to be, and its headers are all there is to show.
		/// </summary>
		DecompileResponse DecompileElfInfo(NodeEntry node, ElfFileEntry elfEntry) {
			var builder = new StringBuilder();
			builder.AppendLine($"// ELF File: {Path.GetFileName(elfEntry.Path)}");
			builder.AppendLine($"// Path: {elfEntry.Path}");
			builder.AppendLine($"// Size: {elfEntry.FileLength:N0} bytes");
			builder.AppendLine();
			AppendElfStructures(builder, elfEntry.Elf);
			return new DecompileResponse(
				GetLabel(node),
				"csharp",
				builder.ToString(),
				Array.Empty<TextSpanDto>(),
				Array.Empty<DiagnosticDto>());
		}

		/// <summary>Every structure of an ELF image, one block after another.</summary>
		static void AppendElfStructures(StringBuilder builder, ElfImage image) {
			foreach (var structure in ElfStructures(image)) {
				ElfStructureFormatter.Append(builder, image, structure.Kind, structure.Index);
				builder.AppendLine();
			}
		}

		/// <summary>
		/// The document of a file that is a PE image but not a managed assembly — dnSpy's PEDocumentNode. It
		/// says which file it is and then shows the same structures its PE node lists, since such a file has no
		/// code to show and the headers are all it has.
		/// </summary>
		DecompileResponse DecompilePEInfo(NodeEntry node, PeOnlyModuleEntry peEntry) {
			var builder = new StringBuilder();
			builder.AppendLine($"// PE File: {Path.GetFileName(peEntry.Path)}");
			builder.AppendLine($"// Path: {peEntry.Path}");
			builder.AppendLine($"// Size: {peEntry.FileLength:N0} bytes");
			builder.AppendLine();
			AppendPeStructures(builder, peEntry);
			return new DecompileResponse(
				GetLabel(node),
				"csharp",
				builder.ToString(),
				Array.Empty<TextSpanDto>(),
				Array.Empty<DiagnosticDto>());
		}

		// A gutter click has to land on an exact IL offset, not on "the method that owns this line": the engine
		// refuses an offset that is not a sequence point. CreateSequencePoints over the tree that was just printed
		// gives the IL range of every statement together with the line(s) it was printed on, and the ILFunction
		// annotation names both the body the IL lives in and the source method the user sees.
		internal static IReadOnlyList<CodeStatementDto> BuildCodeStatements(SyntaxTree syntaxTree, CSharpDecompiler decompiler, ModuleEntry module, CancellationToken cancellationToken) {
			try {
				var statements = new List<CodeStatementDto>();
				// The points tile the method's IL and so start a statement where the IL before it ends up, which is
				// not where the statement's own code starts. StatementIlRanges recovers the latter from the tree.
				var statementStarts = StatementIlRanges.Collect(syntaxTree);
				foreach (var (function, points) in decompiler.CreateSequencePoints(syntaxTree)) {
					cancellationToken.ThrowIfCancellationRequested();
					if (GetBodyMethodToken(function) is not { } bodyToken)
						continue;
					var sourceToken = GetSourceMethodToken(function) ?? bodyToken;
					var description = DescribeMethod(module, sourceToken);
					statementStarts.TryGetValue(function, out var starts);
					foreach (var point in points) {
						if (point.EndOffset <= point.Offset)
							continue;
						statements.Add(new CodeStatementDto(
							point.StartLine,
							point.EndLine,
							point.StartColumn,
							point.EndColumn,
							StatementIlRanges.StartWithin(starts, point.Offset, point.EndOffset),
							point.EndOffset,
							point.Offset,
							module.Path,
							unchecked((int)bodyToken),
							unchecked((int)sourceToken),
							description,
							point.IsHidden));
					}
				}
				statements.Sort(static (left, right) => {
					var result = left.StartLine.CompareTo(right.StartLine);
					if (result != 0)
						return result;
					result = left.StartColumn.CompareTo(right.StartColumn);
					return result != 0 ? result : left.IlOffset.CompareTo(right.IlOffset);
				});
				return statements;
			}
			catch (OperationCanceledException) {
				throw;
			}
			catch (Exception) {
				// Losing the statement map only costs the editor its gutter markers, so never fail the decompilation over it.
				return Array.Empty<CodeStatementDto>();
			}
		}

		static string DescribeMethod(ModuleEntry module, uint token) =>
			module.Module.ResolveToken(token) is MethodDef method
				? method.FullName
				: $"0x{token:X8}";

		/// <summary>Prints the tree so ILSpy records the line and column of every node.</summary>
		internal static void RenderWithLocations(SyntaxTree syntaxTree, SpanTextOutput output, DecompilerSettings settings) {
			var tokenWriter = TokenWriter.WrapInWriterThatSetsLocationsInAST(new LocationTokenWriter(output, settings));
			syntaxTree.AcceptVisitor(new CSharpOutputVisitor(tokenWriter, settings.CSharpFormattingOptions));
		}

		// Prefer the source level method over the state machine or lambda implementation so the derived breakpoint
		// name matches the tree node (and the name the debug adapter is given). GetBodyMethodToken() below is the
		// opposite choice: it asks where the IL actually lives, which is what the IL/C# interleaving view needs.
		internal static uint? GetSourceMethodToken(ICSharpCode.Decompiler.IL.ILFunction function) {
			var method = function.Method ?? function.MoveNextMethod;
			if (method is null || method.MetadataToken.IsNil)
				return null;
			return unchecked((uint)MetadataTokens.GetToken(method.MetadataToken));
		}

		internal static uint? GetBodyMethodToken(ICSharpCode.Decompiler.IL.ILFunction function) {
			var method = function.MoveNextMethod ?? function.Method;
			if (method is null || method.MetadataToken.IsNil)
				return null;
			return unchecked((uint)MetadataTokens.GetToken(method.MetadataToken));
		}

		internal static CSharpDecompilerSession CreateCSharpDecompilerSession(ModuleEntry module, DecompilerSettings settings, CancellationToken cancellationToken) {
			if (!module.IsModified) {
				// CSharpDecompiler(string, DecompilerSettings) spelled out, so the resolver it builds can fall back
				// on the global assembly caches the way dnSpy's does.
				settings.LoadInMemory = true;
				var file = new ICSharpCode.Decompiler.Metadata.PEFile(
					module.Path,
					new FileStream(module.Path, FileMode.Open, FileAccess.Read),
					PEStreamOptions.PrefetchEntireImage,
					settings.ApplyWindowsRuntimeProjections ? System.Reflection.Metadata.MetadataReaderOptions.Default : System.Reflection.Metadata.MetadataReaderOptions.None);
				var fileResolver = GacFallbackAssemblyResolver.Create(
					module.Path,
					file,
					settings.ThrowOnAssemblyResolveErrors,
					PEStreamOptions.PrefetchMetadata,
					settings.ApplyWindowsRuntimeProjections ? System.Reflection.Metadata.MetadataReaderOptions.Default : System.Reflection.Metadata.MetadataReaderOptions.None);
				var decompiler = new CSharpDecompiler(file, fileResolver, settings) { CancellationToken = cancellationToken };
				return new CSharpDecompilerSession(decompiler);
			}

			var snapshotStream = new MemoryStream();
			try {
				module.Module.Write(snapshotStream);
				// The decompiler reads this snapshot, so the hex patches have to be in it, or a body the
				// user rewrote byte-wise would still decompile as it was. The snapshot's layout is the
				// serializer's and not the file's, so the patches are resolved against a copy of it.
				if (module.HexPatches.Count > 0) {
					var copy = new MemoryStream(snapshotStream.ToArray(), writable: false);
					using (var snapshotModule = ModuleDefMD.Load(copy))
						WriteHexPatches(snapshotStream, module.ResolveHexPatchOffsets(snapshotModule));
				}
				snapshotStream.Position = 0;
				var snapshotFile = new ICSharpCode.Decompiler.Metadata.PEFile(
					module.Path,
					snapshotStream,
					PEStreamOptions.PrefetchEntireImage);
				try {
					var resolver = GacFallbackAssemblyResolver.Create(module.Path, snapshotFile, throwOnError: false);
					var decompiler = new CSharpDecompiler(snapshotFile, resolver, settings) { CancellationToken = cancellationToken };
					return new CSharpDecompilerSession(decompiler, snapshotFile, snapshotStream);
				}
				catch {
					snapshotFile.Dispose();
					throw;
				}
			}
			catch {
				snapshotStream.Dispose();
				throw;
			}
		}

		SpanTarget? ResolveDecompilerReference(object reference, ModuleEntry defaultModule) {
			if (reference is MetadataReference metadataReference)
				return ResolveMetadataHandle(metadataReference.Metadata, metadataReference.Handle, defaultModule);
			System.Reflection.Metadata.EntityHandle handle;
			DecompilerMetadataFile? metadataFile;
			switch (reference) {
				case DecompilerIMember member:
					handle = member.MetadataToken;
					metadataFile = member.ParentModule?.MetadataFile;
					break;
				case DecompilerIType type when type.GetDefinition() is { } definition:
					handle = definition.MetadataToken;
					metadataFile = definition.ParentModule?.MetadataFile;
					break;
				default:
					return null;
			}
			return ResolveMetadataHandle(metadataFile, handle, defaultModule);
		}

		/// <summary>
		/// Where a reference in decompiled text points. The handle belongs to the module whose metadata
		/// file it arrived with, and that is not the module being decompiled as soon as the reference
		/// crosses an assembly boundary — reading the token against the wrong module is what puts a span
		/// on whichever member happens to share it. A module the workspace holds is answered with a node;
		/// one it does not is answered with the file behind it, so following the reference can open that
		/// file on demand. dnSpy loads the document then, not while the text is being rendered.
		/// </summary>
		SpanTarget? ResolveMetadataHandle(DecompilerMetadataFile? metadataFile, System.Reflection.Metadata.Handle handle, ModuleEntry defaultModule) {
			if (handle.IsNil)
				return null;
			var token = unchecked((uint)MetadataTokens.GetToken(handle));
			var name = metadataFile?.FileName;
			// No metadata file means the handle is the decompiled module's own — the only case where
			// resolving it there is known to be right.
			if (string.IsNullOrEmpty(name))
				return ResolveInModule(defaultModule, token);
			// The module the decompiler read the handle out of: the same file when it is open, and when
			// the decompiler resolved a copy of its own, an open module of that assembly name — the tree
			// matches a reference by name for the same reason.
			var module = modules.Values.FirstOrDefault(candidate => SameFile(candidate.Path, name))
				?? FindOpenModuleByName(Path.GetFileNameWithoutExtension(name));
			if (module is not null)
				return ResolveInModule(module, token);
			// A reference into an assembly the workspace does not hold. The decompiler names the file it
			// resolved, or, for a reference it could not resolve, the file name alone — which the
			// assembly resolver would have searched for beside the referencing module.
			var path = Path.IsPathRooted(name)
				? name
				: Path.Combine(Path.GetDirectoryName(defaultModule.Path) ?? string.Empty, name);
			return File.Exists(path) ? new SpanTarget(null, path, unchecked((int)token)) : null;
		}

		/// <summary>
		/// A node for a handle that belongs to a module the workspace holds, or nothing to point at. The module
		/// and token come along too: a definition keeps them, since a bookmark set on it has to name it by
		/// something that outlives the node id (<see cref="SpanTextOutput"/> drops them from a reference).
		/// </summary>
		SpanTarget? ResolveInModule(ModuleEntry module, uint token) {
			IMDTokenProvider? provider;
			try {
				provider = module.Module.ResolveToken(token);
			}
			catch (Exception) {
				// A token the module has no row for is a reference to something it does not define.
				return null;
			}
			// Only members the tree can show are navigable.
			if (provider is not (TypeDef or MethodDef or FieldDef or PropertyDef or EventDef))
				return null;
			return new SpanTarget(GetMemberNode(provider, module).Id, module.Path, unchecked((int)provider.MDToken.Raw));
		}

		static bool SameFile(string left, string right) =>
			Path.GetFullPath(left).Equals(Path.GetFullPath(right), StringComparison.Ordinal);

		internal static System.Reflection.Metadata.EntityHandle ToEntityHandle(IMDTokenProvider provider) =>
			MetadataTokens.EntityHandle(unchecked((int)provider.MDToken.Raw));

		DecompileResponse DecompileIL(NodeEntry node) {
			var document = ILFormatter.Format(node, this, ResolveILDefinition(node));
			return new DecompileResponse(GetDocumentTitle(node), "il", document.Text, document.Spans, Array.Empty<DiagnosticDto>()) {
				CodeStatements = document.Statements,
			};
		}

		/// <summary>The definition span target of a member the IL view declares — its node, module and token.</summary>
		Func<IMemberDef, SpanTarget?>? ResolveILDefinition(NodeEntry node) =>
			node.AsModuleEntry is { } module ? member => ResolveInModule(module, member.MDToken.Raw) : null;

		/// <summary>
		/// A PE structure is a header of the image rather than code, so there is no IL to interleave — and no
		/// reason to build a decompiler session to say so.
		/// </summary>
		DecompileResponse DecompilePeStructureIl(NodeEntry node) => new(
			GetLabel(node),
			"il",
			$"// {GetLabel(node)}",
			Array.Empty<TextSpanDto>(),
			[new DiagnosticDto("info", "A PE structure has no IL; open it as C# to see its fields.")]);

		/// <summary>An ELF structure is a header of the file rather than code, and has no IL for the same reason.</summary>
		DecompileResponse DecompileElfStructureIl(NodeEntry node) => new(
			GetLabel(node),
			"il",
			$"// {GetLabel(node)}",
			Array.Empty<TextSpanDto>(),
			[new DiagnosticDto("info", "An ELF structure has no IL; open it as C# to see its fields.")]);

		DecompileResponse DecompileILWithCSharp(NodeEntry node, CancellationToken cancellationToken) {
			if (node.Kind is NodeKind.PE or NodeKind.PeStructure)
				return DecompilePeStructureIl(node);
			if (node.Kind is NodeKind.Elf or NodeKind.ElfStructure)
				return DecompileElfStructureIl(node);
			var moduleEntry = node.AsModuleEntry;
			// There is no IL to interleave with C# for a file that carries no .NET metadata.
			if (moduleEntry is null) {
				var description = node.AsPeOnlyModuleEntry is not null
					? "This PE file does not contain .NET metadata."
					: node.Module is ElfFileEntry
						? "This ELF file does not contain .NET metadata."
						: "This file is not a managed assembly or a valid PE file.";
				return new DecompileResponse(
					GetLabel(node),
					"il",
					"// No IL: this file does not contain .NET metadata.",
					Array.Empty<TextSpanDto>(),
					[new DiagnosticDto("info", description)]);
			}
			var settings = new DecompilerSettings {
				UsingDeclarations = false,
			};
			try {
				using var session = CreateCSharpDecompilerSession(moduleEntry, settings, cancellationToken);
				var sourceProvider = new DecompiledSourceProvider(session.Decompiler, settings, cancellationToken);
				var document = ILFormatter.Format(node, this, ResolveILDefinition(node), sourceProvider.GetStatements);
				var diagnostics = session.Decompiler.Errors
					.Select(error => new DiagnosticDto("warning", error.ToString()))
					.ToArray();
				return new DecompileResponse(GetDocumentTitle(node), "il", document.Text, document.Spans, diagnostics) {
					CodeStatements = document.Statements,
				};
			}
			catch (OperationCanceledException) {
				throw;
			}
			catch (Exception ex) {
				throw new RpcException(ErrorCodes.UnsupportedDocument, "The selected item could not be decompiled as IL with C#.", null, ex);
			}
		}

		async Task<DecompileResponse> DecompileVisualBasicAsync(NodeEntry node, CancellationToken cancellationToken) {
			var csharp = DecompileCSharp(node, null, cancellationToken);
			return await ConvertToVisualBasicAsync(csharp, cancellationToken).ConfigureAwait(false);
		}

		static async Task<DecompileResponse> ConvertToVisualBasicAsync(DecompileResponse csharp, CancellationToken cancellationToken) {
			var conversion = await CodeConverter.ConvertAsync(
				new CodeWithOptions(csharp.Text).WithTypeReferences(),
				cancellationToken).ConfigureAwait(false);
			if (!conversion.Success) {
				var message = conversion.GetExceptionsAsString();
				return new DecompileResponse(
					csharp.Title,
					"visual-basic",
					$"' Visual Basic conversion failed.\n' {message.Replace(Environment.NewLine, Environment.NewLine + "' ", StringComparison.Ordinal)}",
					Array.Empty<TextSpanDto>(),
					[new DiagnosticDto("error", message)]);
			}
			var diagnostics = csharp.Diagnostics
				.Concat(conversion.Exceptions?.Select(exception => new DiagnosticDto("warning", exception)) ?? [])
				.ToArray();
			return new DecompileResponse(csharp.Title, "visual-basic", conversion.ConvertedCode, Array.Empty<TextSpanDto>(), diagnostics);
		}

		public HexLengthResponse GetHexLength(string moduleId) => new(GetHexEntry(moduleId).FileLength);

		public async Task<HexReadResponse> ReadHexAsync(string moduleId, long offset, int count, CancellationToken cancellationToken) {
			var entry = GetHexEntry(moduleId);
			if (offset > entry.FileLength)
				throw new RpcException(ErrorCodes.InvalidParams, "Offset is beyond the end of the file.");
			// A file that could not be read while the tree was built has no length, and reading it would
			// only raise again — an empty dump is the honest answer, the way dnSpy shows one.
			var actualCount = (int)Math.Min(count, entry.FileLength - offset);
			if (actualCount <= 0)
				return new HexReadResponse(offset, string.Empty, true);
			var buffer = new byte[actualCount];
			try {
				await using var stream = new FileStream(entry.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 64 * 1024, FileOptions.Asynchronous | FileOptions.RandomAccess);
				stream.Position = offset;
				await stream.ReadExactlyAsync(buffer, cancellationToken).ConfigureAwait(false);
			}
			catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) {
				throw new RpcException(ErrorCodes.SaveFailed, $"The file could not be read: {ex.Message}");
			}
			// The file on disk never holds a patch; the hex tab reads the patched image, like every other
			// reader of the module does. Only a managed module can carry patches — the other entries are
			// read-only documents.
			if (entry is ModuleEntry module)
				module.OverlayHexPatches(offset, buffer);
			return new HexReadResponse(offset, Convert.ToBase64String(buffer), offset + actualCount >= entry.FileLength);
		}

		/// <summary>
		/// The file a hex tab shows. Unlike <see cref="GetModule"/>, which answers for the modules an edit can
		/// reach, this also accepts the read-only files dnSpy opens a hex editor on — a native PE image, an
		/// ELF image, a file nothing could be read from — because browsing their bytes is the whole point of
		/// the hex editor there.
		/// </summary>
		IModuleEntry GetHexEntry(string moduleId) {
			if (modules.TryGetValue(moduleId, out var module))
				return module;
			if (nodes.TryGetValue(moduleId, out var node) && node.Module is IModuleEntry entry)
				return entry;
			if (peModules.TryGetValue(moduleId, out var peModule))
				return peModule;
			if (elfFiles.TryGetValue(moduleId, out var elf))
				return elf;
			if (unknownFiles.TryGetValue(moduleId, out var unknown))
				return unknown;
			throw new RpcException(ErrorCodes.NodeNotFound, "The module no longer exists.");
		}

		/// <summary>The PE image behind a hex document, which is what RVA and PE-relative addresses need.</summary>
		static IPEImage? GetPeImage(IModuleEntry entry) => entry switch {
			ModuleEntry module => module.Module.Metadata.PEImage,
			PeOnlyModuleEntry pe => pe.PEImage,
			_ => null,
		};

		/// <summary>
		/// What the Go to Position dialog was given, as a file offset. dnSpy's hex buffer is the file itself
		/// here, so "absolute" and "file" are the same position; "current" arrives as the client already
		/// having added the delta up, and "rva" goes through the PE image's section table.
		/// </summary>
		public HexResolvePositionResponse ResolveHexPosition(HexResolvePositionRequest request) {
			var entry = GetHexEntry(request.ModuleId);
			if (request.Value < 0)
				return new HexResolvePositionResponse(-1);
			long offset;
			switch (request.Kind) {
			case "absolute":
			case "file":
			case "current":
				offset = request.Value;
				break;
			case "rva":
				// An RVA is only meaningful for an image with sections; an ELF file or a file nothing could
				// be read from has none, which answers "no such position" rather than an error.
				if (GetPeImage(entry) is not { } peImage)
					return new HexResolvePositionResponse(-1);
				// dnlib maps an RVA outside every section onto the file start rather than failing, so the
				// image's own size decides whether the address means anything first.
				if (request.Value >= peImage.ImageNTHeaders.OptionalHeader.SizeOfImage)
					return new HexResolvePositionResponse(-1);
				try {
					offset = Convert.ToInt64(Convert.ToUInt64(peImage.ToFileOffset((RVA)(uint)request.Value)));
				}
				catch (Exception ex) when (ex is ArgumentException or InvalidOperationException) {
					return new HexResolvePositionResponse(-1);
				}
				break;
			default:
				throw new RpcException(ErrorCodes.InvalidParams, $"Unknown position kind '{request.Kind}'.");
			}
			return new HexResolvePositionResponse(offset < entry.FileLength ? offset : -1);
		}

		/// <summary>
		/// What the Go to Metadata dialog was given, as the file range it names. The stream offsets dnlib
		/// reports are file offsets, so the only arithmetic is the index inside the stream or the row inside
		/// the table, exactly as dnSpy's own Go to Metadata does it.
		/// </summary>
		public HexGoToMetadataResponse GoToHexMetadata(HexGoToMetadataRequest request) {
			var entry = GetHexEntry(request.ModuleId);
			// Metadata only exists in a managed module; a native PE's or an ELF file's hex tab answers
			// "nothing here", which is what keeps the menu entry from naming a position that is not there.
			if (entry is not ModuleEntry module || request.Value < 0)
				return new HexGoToMetadataResponse(null);
			var metadata = module.Module.Metadata;
			var value = request.Value;
			HexRangeDto? range;
			switch (request.Kind) {
			case "blob":
				range = StreamRange(metadata.BlobStream, value, 0);
				break;
			case "strings":
				range = StreamRange(metadata.StringsStream, value, 0);
				break;
			case "us":
				range = StreamRange(metadata.USStream, value & 0x00FFFFFF, 0);
				break;
			case "guid":
				range = value == 0 ? null : StreamRange(metadata.GuidStream, (value - 1) * 16, 16);
				break;
			case "table":
			case "memberRva":
				range = TableRowRange(module, value, request.Kind == "memberRva");
				break;
			default:
				throw new RpcException(ErrorCodes.InvalidParams, $"Unknown metadata kind '{request.Kind}'.");
			}
			return new HexGoToMetadataResponse(range);
		}

		/// <summary>A range inside one metadata stream, or null when the index runs past its end.</summary>
		static HexRangeDto? StreamRange(dnlib.DotNet.MD.DotNetStream? stream, long index, long length) {
			if (stream is null || index < 0 || index > stream.StreamLength)
				return null;
			var start = Convert.ToInt64(Convert.ToUInt64(stream.StartOffset));
			if (length == 0)
				return new HexRangeDto(start + index, 0);
			return index + length <= stream.StreamLength ? new HexRangeDto(start + index, length) : null;
		}

		/// <summary>
		/// The file range one metadata table row covers. With <paramref name="memberRva"/> the row's first
		/// column — the RVA, which both the Method and the FieldRVA table keep there — is followed to the
		/// data it points at, which is dnSpy's "go to method body".
		/// </summary>
		static HexRangeDto? TableRowRange(ModuleEntry module, long token, bool memberRva) {
			var metadata = module.Module.Metadata;
			if (metadata.TablesStream is not { } tablesStream)
				return null;
			var table = (dnlib.DotNet.MD.Table)((token >> 24) & 0xFF);
			var rid = (uint)(token & 0x00FFFFFF);
			if (tablesStream.Get(table) is not { } mdTable || !mdTable.IsValidRID(rid))
				return null;
			var rowOffset = Convert.ToInt64(Convert.ToUInt64(mdTable.StartOffset)) + (long)(rid - 1) * mdTable.RowSize;
			if (!memberRva)
				return new HexRangeDto(rowOffset, mdTable.RowSize);
			if (table is not (dnlib.DotNet.MD.Table.Method or dnlib.DotNet.MD.Table.FieldRVA))
				return null;
			if (metadata.PEImage is not { } peImage)
				return null;
			// The row's first column is the RVA. It is read straight out of the image, which is where the
			// tables live, so the value the table holds is what the file shows.
			uint rva;
			try {
				var reader = peImage.CreateReader();
				reader.Position = Convert.ToUInt32(Convert.ToUInt64(mdTable.StartOffset) + (rid - 1UL) * (ulong)mdTable.RowSize);
				rva = reader.ReadUInt32();
			}
			catch (Exception ex) when (ex is IOException or ArgumentException) {
				return null;
			}
			if (rva == 0)
				return null;
			try {
				return new HexRangeDto(Convert.ToInt64(Convert.ToUInt64(peImage.ToFileOffset((RVA)rva))), 0);
			}
			catch (Exception ex) when (ex is ArgumentException or InvalidOperationException) {
				return null;
			}
		}

		/// <summary>
		/// One Find step over the file's bytes. The search reads the file in chunks with the pattern's
		/// length overlapping, so a match straddling two reads is still found, and it sees the hex patches
		/// the tab shows. A forward search answers the first match at or after <paramref name="start"/>; a
		/// reverse one answers the last match at or before it.
		/// </summary>
		public async Task<HexFindResponse> FindHexAsync(HexFindRequest request, CancellationToken cancellationToken) {
			var entry = GetHexEntry(request.ModuleId);
			byte[] pattern;
			try {
				pattern = Convert.FromBase64String(request.Base64Pattern);
			}
			catch (FormatException ex) {
				throw new RpcException(ErrorCodes.InvalidParams, "The search pattern is not valid base64.", null, ex);
			}
			if (pattern.Length == 0)
				throw new RpcException(ErrorCodes.InvalidParams, "The search pattern is empty.");
			var length = entry.FileLength;
			if (length < pattern.Length)
				return new HexFindResponse(-1);
			var start = Math.Clamp(request.Start, 0, length - pattern.Length);
			var module = entry as ModuleEntry;
			await using var stream = new FileStream(entry.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 64 * 1024, FileOptions.Asynchronous | FileOptions.RandomAccess);
			// Forward: everything from the start offset to the end. Reverse: everything before the start
			// offset, so a match that already begins there is not answered again.
			var found = request.Reverse
				? await FindInRangeAsync(stream, module, 0, Math.Max(0, start - 1), pattern, reverse: true, cancellationToken).ConfigureAwait(false)
				: await FindInRangeAsync(stream, module, start, length, pattern, reverse: false, cancellationToken).ConfigureAwait(false);
			if (found < 0 && request.Wrap) {
				// Wrap once: the part that was already searched is searched again from the other end.
				found = request.Reverse
					? await FindInRangeAsync(stream, module, start - 1, length, pattern, reverse: true, cancellationToken).ConfigureAwait(false)
					: await FindInRangeAsync(stream, module, 0, start + pattern.Length - 1, pattern, reverse: false, cancellationToken).ConfigureAwait(false);
			}
			return new HexFindResponse(found);
		}

		const int HexFindChunkSize = 1024 * 1024;

		static async Task<long> FindInRangeAsync(FileStream stream, ModuleEntry? module, long from, long to, byte[] pattern, bool reverse, CancellationToken cancellationToken) {
			if (from < 0)
				from = 0;
			if (to > stream.Length)
				to = stream.Length;
			if (to - from < pattern.Length)
				return -1;
			var buffer = new byte[HexFindChunkSize + pattern.Length - 1];
			for (var pos = from; pos < to; pos += HexFindChunkSize) {
				cancellationToken.ThrowIfCancellationRequested();
				var count = (int)Math.Min(buffer.Length, to - pos);
				stream.Position = pos;
				await stream.ReadExactlyAsync(buffer.AsMemory(0, count), cancellationToken).ConfigureAwait(false);
				module?.OverlayHexPatches(pos, buffer);
				if (reverse) {
					for (var i = count - pattern.Length; i >= 0; i--) {
						if (buffer.AsSpan(i, pattern.Length).SequenceEqual(pattern))
							return pos + i;
					}
				}
				else {
					for (var i = 0; i <= count - pattern.Length; i++) {
						if (buffer.AsSpan(i, pattern.Length).SequenceEqual(pattern))
							return pos + i;
					}
				}
			}
			return -1;
		}

		/// <summary>
		/// Where the hex commands for a tree node point. Only the node kinds dnSpy has an address for
		/// produce one, so a type or a resource entry resolves to nothing but its module.
		/// </summary>
		public HexTargetResponse ResolveHexTarget(string nodeId) {
			var node = GetNode(nodeId);
			// Member-level hex targets only exist in a managed module. A node of a PE-only, ELF or unknown
			// file answers with the file it lives in and no target, which is what leaves the member
			// commands off the menu for it — only the command that opens the bytes of the file it names
			// has something to point at. The query is an ordinary "nothing here" rather than an error the
			// caller has to swallow.
			var moduleEntry = node.Module as IModuleEntry
				?? throw new RpcException(ErrorCodes.NodeNotFound, "The selected tree node no longer exists.");
			HexMethodTargetDto? method = null;
			HexRangeDto? fieldInitialValue = null;
			HexRangeDto? resource = null;
			switch (node.Value) {
			case MethodDef value:
				method = ResolveMethodTarget(value);
				break;
			case FieldDef value:
				fieldInitialValue = ResolveFieldInitialValue(value);
				break;
			case EmbeddedResource value:
				resource = ResolveResourceTarget(value);
				break;
			}
			return new HexTargetResponse(moduleEntry.Id, moduleEntry.FileLength, method, fieldInitialValue, resource);
		}

		static HexMethodTargetDto? ResolveMethodTarget(MethodDef method) {
			if (!HexTargets.TryGetMethodBody(method, out var bodyOffset, out var bodySize, out var codeOffset, out var codeSize))
				return null;
			// The write commands only appear when their bytes fit the body they would overwrite, which is
			// dnSpy's own test (LengthAndOffset.Size >= data.Length).
			return new HexMethodTargetDto(
				bodyOffset,
				bodySize,
				codeOffset,
				codeSize,
				EncodeTemplate(HexTargets.GetReturnTrueBody(method), bodySize),
				EncodeTemplate(HexTargets.GetReturnFalseBody(method), bodySize),
				EncodeTemplate(HexTargets.GetEmptyBody(method), bodySize));
		}

		static string? EncodeTemplate(byte[]? data, long bodySize) =>
			data is not null && data.LongLength <= bodySize ? Convert.ToBase64String(data) : null;

		static HexRangeDto? ResolveFieldInitialValue(FieldDef field) {
			if (field.RVA == 0 || field.InitialValue is not { Length: > 0 } initialValue)
				return null;
			return HexTargets.GetMemberFileOffset(field) is { } offset ? new HexRangeDto(offset, initialValue.Length) : null;
		}

		static HexRangeDto? ResolveResourceTarget(EmbeddedResource resource) {
			var reader = resource.CreateReader();
			return reader.Length == 0 ? null : new HexRangeDto(reader.StartOffset, reader.Length);
		}

		/// <summary>
		/// The bytes one statement of a code document covers, for the "Show Instructions in Hex Editor"
		/// command. The IL offsets are relative to the method's code, so they are shifted by where that
		/// code starts in the file.
		/// </summary>
		public HexStatementResponse ResolveHexStatement(HexStatementRequest request) {
			var module = FindModuleEntry(request.ModulePath);
			if (module is null || request.MetadataToken == 0)
				return new HexStatementResponse(null, null);
			if (module.Module.ResolveToken(unchecked((uint)request.MetadataToken)) is not MethodDef method)
				return new HexStatementResponse(null, null);
			if (!HexTargets.TryGetMethodBody(method, out _, out _, out var codeOffset, out var codeSize))
				return new HexStatementResponse(null, null);
			var start = (long)request.IlOffset;
			var end = Math.Max((long)request.IlEndOffset, start);
			if (start < 0 || start > codeSize)
				return new HexStatementResponse(null, null);
			// A statement covering several sequence points, or one running past the code, is clipped to
			// what the method actually holds.
			return new HexStatementResponse(module.Id, new HexRangeDto(codeOffset + start, Math.Min(end, codeSize) - start));
		}

		/// <summary>
		/// Queues a byte patch over the module's file image. The patch is held in memory and overlaid on
		/// every read and every write, so it survives a save without ever touching the file it came from.
		/// </summary>
		public void QueueHexPatch(HexPatchRequest request) {
			var transaction = GetTransaction(request.TransactionId);
			var node = GetNode(request.NodeId);
			// PE-only modules don't support hex patches
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.UnsupportedDocument, "PE-only modules do not support hex patches.");
			byte[] data;
			try {
				data = Convert.FromBase64String(request.Base64Data);
			}
			catch (FormatException ex) {
				throw new RpcException(ErrorCodes.EditValidationFailed, "The patch is not valid base64.", null, ex);
			}
			if (data.Length == 0)
				throw new RpcException(ErrorCodes.EditValidationFailed, "The patch is empty.");
			if (request.Offset < 0 || request.Offset + data.Length > moduleEntry.FileLength)
				throw new RpcException(ErrorCodes.EditValidationFailed, "The patch does not fit inside the file.");
			// A patch over a member may only cover that member, so the write commands can never spill into
			// whatever the serializer put next to the body they were aimed at.
			if (HexTargets.GetPatchRegion(node.Value) is { } region &&
				(request.Offset < region.Offset || request.Offset + data.Length > region.Offset + region.Size))
				throw new RpcException(ErrorCodes.EditValidationFailed, "The patch is larger than what it is writing over.");
			transaction.Add(node.Id, moduleEntry, () => moduleEntry.ApplyHexPatch(node.Id, node.Value, request.Offset, data));
		}

		public ModuleInfoResponse GetModuleInfo(string moduleId) {
			var entry = GetModule(moduleId);
			var module = entry.Module;
			var (peHeaders, metadataTables) = ReadPortableExecutableInfo(entry.Path);
			return new ModuleInfoResponse(
				module.Assembly?.FullName ?? module.Name.String,
				entry.Path,
				module.RuntimeVersion ?? string.Empty,
				module.Machine.ToString(),
				module.Kind.ToString(),
				module.Mvid ?? Guid.Empty,
				module.EntryPoint?.FullName,
				module.GetTypes().Count(),
				module.Resources.Count,
				module.GetAssemblyRefs().Select(a => a.FullName).ToArray(),
				peHeaders,
				metadataTables);
		}

		static (IReadOnlyDictionary<string, string> PeHeaders, IReadOnlyDictionary<string, int> MetadataTables) ReadPortableExecutableInfo(string path) {
			using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
			using var peReader = new PEReader(stream, PEStreamOptions.PrefetchMetadata);
			var headers = peReader.PEHeaders;
			var peHeader = headers.PEHeader;
			var peValues = new Dictionary<string, string>(StringComparer.Ordinal) {
				["Machine"] = headers.CoffHeader.Machine.ToString(),
				["Characteristics"] = headers.CoffHeader.Characteristics.ToString(),
				["Sections"] = headers.SectionHeaders.Length.ToString(CultureInfo.InvariantCulture),
				["PE magic"] = peHeader?.Magic.ToString() ?? string.Empty,
				["Subsystem"] = peHeader?.Subsystem.ToString() ?? string.Empty,
				["Image base"] = peHeader is null ? string.Empty : $"0x{peHeader.ImageBase:X}",
				["Entry point RVA"] = peHeader is null ? string.Empty : $"0x{peHeader.AddressOfEntryPoint:X8}",
				["Cor flags"] = headers.CorHeader?.Flags.ToString() ?? string.Empty,
			};
			var tableValues = new Dictionary<string, int>(StringComparer.Ordinal);
			if (peReader.HasMetadata) {
				var metadata = System.Reflection.Metadata.PEReaderExtensions.GetMetadataReader(peReader);
				foreach (var table in Enum.GetValues<TableIndex>()) {
					var count = metadata.GetTableRowCount(table);
					if (count > 0)
						tableValues[table.ToString()] = count;
				}
			}
			return (peValues, tableValues);
		}

		/// <summary>
		/// The values a create- or edit-dialog opens with: what the node being edited already holds, or the
		/// defaults a new one starts from. Read-only, so it needs no transaction — the dialog is filled in
		/// before the user has changed anything, and a cancelled dialog must not have queued an operation.
		/// </summary>
		public NodeOptionsDto GetOptions(GetNodeOptionsRequest request) {
			var owner = GetNodeOrNull(request.OwnerNodeId);
			if (request.IsNew)
				return NewOptions(request.Kind, owner, request.Nested);
			if (GetNodeOrNull(request.NodeId) is not { } node || node.Value is not IMDTokenProvider member)
				throw new RpcException(ErrorCodes.EditValidationFailed, "The selected item cannot be edited.");
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support editing.");
			return CreateEditContext(moduleEntry).Options.Existing(member);
		}

		NodeOptionsDto NewOptions(string kind, NodeEntry? owner, bool nested) {
			var moduleEntry = owner?.AsModuleEntry ?? OpenModules.FirstOrDefault()
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "The workspace has no module to create the item in.");
			var options = CreateEditContext(moduleEntry).Options;
			return kind switch {
				// A nested type has no namespace of its own, which is what dnSpy's own create command passes.
				NodeOptionKinds.Type => options.NewType(nested ? string.Empty : NamespaceOf(owner), nested),
				NodeOptionKinds.Method => options.NewMethod(OwnerTypeOf(owner)),
				NodeOptionKinds.Field => options.NewField(OwnerTypeOf(owner)),
				NodeOptionKinds.Property => options.NewProperty(OwnerTypeOf(owner)),
				NodeOptionKinds.Event => options.NewEvent(OwnerTypeOf(owner)),
				_ => throw new RpcException(ErrorCodes.InvalidParams, $"Unknown item kind '{kind}'."),
			};
		}

		/// <summary>The type a new member goes into: the node itself when a type is selected, or the type
		/// the selected member belongs to — a member's parent node is always its type, which is how dnSpy's
		/// create commands reach it too.</summary>
		static TypeDef OwnerTypeOf(NodeEntry? owner) => owner?.Value switch {
			TypeDef type => type,
			MethodDef method => method.DeclaringType,
			FieldDef field => field.DeclaringType,
			PropertyDef property => property.DeclaringType,
			EventDef @event => @event.DeclaringType,
			_ => throw new RpcException(ErrorCodes.EditValidationFailed, "Select a type or one of its members."),
		};

		/// <summary>The namespace a new top-level type goes into, which is the selected namespace's own name
		/// or the one the selected type is already filed under — dnSpy asks the selection for its nearest
		/// namespace ancestor, and a type's is the one its name is written with. A module has none, so its
		/// types go into the empty namespace.</summary>
		static string NamespaceOf(NodeEntry? owner) => owner?.Value switch {
			NamespaceValue value => value.Name,
			TypeDef type => type.Namespace.String,
			_ => string.Empty,
		};

		/// <summary>
		/// The state an edit operation runs against: the module new rows are written into, the other open
		/// modules a bare type name may be looked up in, and the tree lookup that turns the node id a dialog
		/// names back into the row it stands for. A reference module is not editable, so it is not offered
		/// as a place to look a name up in either.
		/// </summary>
		internal EditContext CreateEditContext(ModuleEntry module) => new(
			module.Module,
			OpenModules.Where(entry => !ReferenceEquals(entry.Module, module.Module)).Select(entry => entry.Module).ToArray(),
			nodeId => nodes.TryGetValue(nodeId, out var node) ? node.Value : null);

		NodeEntry? GetNodeOrNull(string? nodeId) =>
			nodeId is { Length: > 0 } && nodes.TryGetValue(nodeId, out var node) ? node : null;

		public BeginEditResponse BeginEdit() {
			var transaction = new EditTransaction(version);
			transactions.Add(transaction.Id, transaction);
			return new BeginEditResponse(transaction.Id, transaction.BaseVersion);
		}

		public MethodBodyResponse GetMethodBody(string methodNodeId) {
			var node = GetNode(methodNodeId);
			if (node.Value is not MethodDef method || !method.HasBody)
				throw new RpcException(ErrorCodes.EditValidationFailed, "The selected method has no managed IL body.");
			var labels = method.Body.Instructions.ToDictionary(instruction => instruction, instruction => $"IL_{instruction.Offset:X4}");
			var instructions = method.Body.Instructions.Select(instruction => SerializeInstruction(method, instruction, labels)).ToArray();
			return new MethodBodyResponse(
				method.Body.MaxStack,
				method.Body.InitLocals,
				method.Body.Variables.Select(local => local.Type.FullName).ToArray(),
				instructions,
				method.Body.ExceptionHandlers.Count > 0);
		}

		IlInstructionDto SerializeInstruction(MethodDef method, Instruction instruction, IReadOnlyDictionary<Instruction, string> labels) {
			var label = labels[instruction];
			return instruction.Operand switch {
				null => new IlInstructionDto(label, instruction.OpCode.Name),
				string text => new IlInstructionDto(label, instruction.OpCode.Name, "string", text, text),
				Instruction target => new IlInstructionDto(label, instruction.OpCode.Name, "branch", labels[target], labels[target]),
				IList<Instruction> targets => new IlInstructionDto(label, instruction.OpCode.Name, "switch", string.Join(',', targets.Select(target => labels[target])), string.Join(", ", targets.Select(target => labels[target]))),
				Local local => new IlInstructionDto(label, instruction.OpCode.Name, "local", local.Index.ToString(CultureInfo.InvariantCulture), $"V_{local.Index}"),
				Parameter parameter => new IlInstructionDto(label, instruction.OpCode.Name, "argument", method.Parameters.IndexOf(parameter).ToString(CultureInfo.InvariantCulture), parameter.Name ?? $"A_{parameter.Index}"),
				IMDTokenProvider token => new IlInstructionDto(label, instruction.OpCode.Name, "token", token.MDToken.Raw.ToString("X8", CultureInfo.InvariantCulture), token.ToString()),
				float value => new IlInstructionDto(label, instruction.OpCode.Name, "number", value.ToString("R", CultureInfo.InvariantCulture)),
				double value => new IlInstructionDto(label, instruction.OpCode.Name, "number", value.ToString("R", CultureInfo.InvariantCulture)),
				IFormattable value => new IlInstructionDto(label, instruction.OpCode.Name, "number", value.ToString(null, CultureInfo.InvariantCulture)),
				_ => throw new RpcException(ErrorCodes.EditValidationFailed, $"Operand type {instruction.Operand.GetType().Name} cannot be edited."),
			};
		}

		public void QueueRename(RenameEditRequest request) {
			if (string.IsNullOrWhiteSpace(request.NewName) || request.NewName.Contains('\0'))
				throw new RpcException(ErrorCodes.EditValidationFailed, "The new name is invalid.");
			var transaction = GetTransaction(request.TransactionId);
			var node = GetNode(request.NodeId);
			if (node.Value is not IMDTokenProvider)
				throw new RpcException(ErrorCodes.EditValidationFailed, "Only types and members can be renamed.");
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support renaming.");
			var oldName = GetEditableName(node.Value)
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "The selected item cannot be renamed.");
			transaction.Add(node.Id, moduleEntry, () => {
				SetEditableName(node.Value, request.NewName);
				return () => SetEditableName(node.Value, oldName);
			});
		}

		public void QueueDelete(DeleteEditRequest request) {
			var transaction = GetTransaction(request.TransactionId);
			var node = GetNode(request.NodeId);
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support deletion.");
			var undo = new List<Action>();
			transaction.Add(node.Id, moduleEntry, () => {
				// Validation happens before any list is touched, so a rejected delete cannot leave the
				// module half-modified when CommitEdit rolls this operation back.
				PlanDelete(node, moduleEntry, out var remove);
				foreach (var step in remove)
					step(undo);
				return () => {
					// The steps recorded their undo in removal order; reversing replays them and restores
					// every list index exactly, including the descending-index bulk delete of a namespace.
					for (var i = undo.Count - 1; i >= 0; i--)
						undo[i]();
				};
			});
		}

		/// <summary>
		/// Works out how to remove <paramref name="node"/> without mutating anything yet. Each step both
		/// performs the removal when handed the undo list and records how to put the item back.
		/// </summary>
		static void PlanDelete(NodeEntry node, ModuleEntry module, out IReadOnlyList<Action<List<Action>>> remove) {
			switch (node.Value) {
			case TypeDef type: {
				var owner = type.DeclaringType is null ? module.Module.Types : type.DeclaringType.NestedTypes;
				var index = owner.IndexOf(type);
				if (index < 0)
					throw new RpcException(ErrorCodes.EditValidationFailed, "The type no longer belongs to its owner.");
				var steps = new List<Action<List<Action>>> {
					undo => {
						owner.RemoveAt(index);
						undo.Add(() => owner.Insert(index, type));
					},
				};
				remove = steps;
				break;
			}
			case MethodDef method: {
				var owner = method.DeclaringType?.Methods;
				var index = owner?.IndexOf(method) ?? -1;
				if (owner is null || index < 0)
					throw new RpcException(ErrorCodes.EditValidationFailed, "The method no longer belongs to its type.");
				remove = new List<Action<List<Action>>> {
					undo => {
						owner.RemoveAt(index);
						undo.Add(() => owner.Insert(index, method));
					},
				};
				break;
			}
			case FieldDef field: {
				var owner = field.DeclaringType?.Fields;
				var index = owner?.IndexOf(field) ?? -1;
				if (owner is null || index < 0)
					throw new RpcException(ErrorCodes.EditValidationFailed, "The field no longer belongs to its type.");
				remove = new List<Action<List<Action>>> {
					undo => {
						owner.RemoveAt(index);
						undo.Add(() => owner.Insert(index, field));
					},
				};
				break;
			}
			case PropertyDef property: {
				var declaringType = property.DeclaringType
					?? throw new RpcException(ErrorCodes.EditValidationFailed, "The property no longer belongs to its type.");
				var index = declaringType.Properties.IndexOf(property);
				if (index < 0)
					throw new RpcException(ErrorCodes.EditValidationFailed, "The property no longer belongs to its type.");
				remove = PlanDeleteWithAccessors(declaringType, () => {
					declaringType.Properties.RemoveAt(index);
					return () => declaringType.Properties.Insert(index, property);
				}, GetAccessorMethods(property));
				break;
			}
			case EventDef @event: {
				var declaringType = @event.DeclaringType
					?? throw new RpcException(ErrorCodes.EditValidationFailed, "The event no longer belongs to its type.");
				var index = declaringType.Events.IndexOf(@event);
				if (index < 0)
					throw new RpcException(ErrorCodes.EditValidationFailed, "The event no longer belongs to its type.");
				remove = PlanDeleteWithAccessors(declaringType, () => {
					declaringType.Events.RemoveAt(index);
					return () => declaringType.Events.Insert(index, @event);
				}, GetAccessorMethods(@event));
				break;
			}
			case NamespaceValue ns: {
				var types = module.Module.Types
					.Select((type, index) => (Type: type, Index: index))
					.Where(entry => entry.Type.DeclaringType is null && !entry.Type.IsGlobalModuleType &&
						(entry.Type.Namespace.String ?? string.Empty) == ns.Name)
					.OrderByDescending(entry => entry.Index)
					.ToArray();
				// Removing every type of the namespace, and removing an empty namespace, are the same
				// command in dnSpy — the latter just ends up with nothing to remove.
				remove = types.Select(entry => (Action<List<Action>>)(undo => {
					module.Module.Types.RemoveAt(entry.Index);
					undo.Add(() => module.Module.Types.Insert(entry.Index, entry.Type));
				})).ToArray();
				break;
			}
			case Resource resource: {
				var owner = module.Module.Resources;
				var index = owner.IndexOf(resource);
				if (index < 0)
					throw new RpcException(ErrorCodes.EditValidationFailed, "The resource no longer belongs to the module.");
				remove = new List<Action<List<Action>>> {
					undo => {
						owner.RemoveAt(index);
						undo.Add(() => owner.Insert(index, resource));
					},
				};
				break;
			}
			default:
				throw new RpcException(ErrorCodes.EditValidationFailed, "This item cannot be deleted.");
			}
		}

		/// <summary>
		/// Removes a property or an event together with its accessor methods, the way dnSpy does: leaving
		/// the getter/setter or add/remove methods behind would keep them in the type's method list.
		/// </summary>
		static IReadOnlyList<Action<List<Action>>> PlanDeleteWithAccessors(
			TypeDef declaringType,
			Func<Action> removeMembers,
			IEnumerable<MethodDef> accessors) {
			var methods = declaringType.Methods;
			var accessorIndexes = accessors
				.Select(method => (Method: method, Index: methods.IndexOf(method)))
				.Where(entry => entry.Index >= 0)
				.OrderByDescending(entry => entry.Index)
				.ToArray();
			return new List<Action<List<Action>>> {
				undo => {
					foreach (var entry in accessorIndexes) {
						methods.RemoveAt(entry.Index);
						undo.Add(() => methods.Insert(entry.Index, entry.Method));
					}
					undo.Add(removeMembers());
				},
			};
		}

		static IEnumerable<MethodDef> GetAccessorMethods(PropertyDef property) {
			foreach (var method in property.GetMethods)
				yield return method;
			foreach (var method in property.SetMethods)
				yield return method;
			foreach (var method in property.OtherMethods)
				yield return method;
		}

		static IEnumerable<MethodDef> GetAccessorMethods(EventDef @event) {
			if (@event.AddMethod is not null)
				yield return @event.AddMethod;
			if (@event.RemoveMethod is not null)
				yield return @event.RemoveMethod;
			if (@event.InvokeMethod is not null)
				yield return @event.InvokeMethod;
			foreach (var method in @event.OtherMethods)
				yield return method;
		}

		public void QueueSetNamespace(SetNamespaceEditRequest request) {
			if (request.NewName.Contains('\0'))
				throw new RpcException(ErrorCodes.EditValidationFailed, "The namespace name is invalid.");
			var transaction = GetTransaction(request.TransactionId);
			var node = GetNode(request.NodeId);
			if (node.Value is not NamespaceValue ns)
				throw new RpcException(ErrorCodes.EditValidationFailed, "Only a namespace can be renamed.");
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support namespace operations.");

			var oldName = ns.Name;
			var newName = request.NewName;
			var types = moduleEntry.Module.Types
				.Where(t => t.DeclaringType is null && !t.IsGlobalModuleType && (t.Namespace.String ?? string.Empty) == oldName)
				.ToArray();
			if (types.Length == 0)
				throw new RpcException(ErrorCodes.EditValidationFailed, "The namespace has no types to move.");

			// A type moved to another namespace is still named by its TypeRefs, so references in the other
			// workspace modules have to be rewritten too or the saved assembly would point at a name that
			// no longer exists. Matching on the full name catches them without resolving, which would load
			// a second copy of the module from disk and never compare equal to the in-memory type.
			var movedNames = types.Select(t => t.FullName).ToHashSet(StringComparer.Ordinal);
			var typeRefs = modules.Values
				.SelectMany(module => module.Module.GetTypeRefs())
				.Where(typeRef => movedNames.Contains(typeRef.FullName))
				.ToArray();

			transaction.Add(node.Id, moduleEntry, () => {
				foreach (var typeRef in typeRefs)
					typeRef.Namespace = newName;
				foreach (var type in types)
					type.Namespace = newName;
				return () => {
					foreach (var type in types)
						type.Namespace = oldName;
					foreach (var typeRef in typeRefs)
						typeRef.Namespace = oldName;
				};
			});
		}

		public void QueueMethodBody(ReplaceMethodBodyRequest request) {
			var transaction = GetTransaction(request.TransactionId);
			var node = GetNode(request.MethodNodeId);
			if (node.Value is not MethodDef method)
				throw new RpcException(ErrorCodes.EditValidationFailed, "The selected item is not a method.");
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support method body editing.");
			if (method.HasBody && method.Body.ExceptionHandlers.Count > 0 && !request.ClearExceptionHandlers)
				throw new RpcException(ErrorCodes.EditValidationFailed, "The method contains exception handlers. Explicitly clear them or use an exception-handler aware editor.");

			var body = BuildMethodBody(method, request);
			transaction.Add(node.Id, moduleEntry, () => {
				var oldBody = method.Body;
				method.Body = body;
				return () => method.Body = oldBody;
			});
		}

		public void QueueMethodBodyStub(ReplaceMethodBodyWithStubRequest request) {
			var transaction = GetTransaction(request.TransactionId);
			var node = GetNode(request.MethodNodeId);
			if (node.Value is not MethodDef method)
				throw new RpcException(ErrorCodes.EditValidationFailed, "The selected item is not a method.");
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support method body editing.");

			var body = MethodBodyStub.Create(method);
			transaction.Add(node.Id, moduleEntry, () => {
				var oldBody = method.Body;
				var oldCodeType = method.CodeType;
				// dnSpy's MethodBodyOptions.CopyTo writes the code type back as IL; a method that was
				// previously native or runtime would otherwise keep a flag that contradicts its body.
				method.CodeType = dnlib.DotNet.MethodImplAttributes.IL;
				method.Body = body;
				return () => {
					method.Body = oldBody;
					method.CodeType = oldCodeType;
				};
			});
		}

		/// <summary>
		/// dnSpy's two Convert commands. Turning an assembly into a net module detaches its single module and
		/// writes the module kind that says so; the other direction gives a module without an assembly a fresh
		/// definition named after its file. Both write the characteristics bit that goes with the kind, the
		/// way dnSpy's own helper does, and both are one queued operation — the inverse is what Undo runs.
		/// The assembly root node carries the definition it was built with, so the label it shows is refreshed
		/// here too; the module row names the file either way and does not change.
		/// </summary>
		public void QueueConvertModule(ConvertModuleRequest request) {
			var transaction = GetTransaction(request.TransactionId);
			var node = GetNode(request.NodeId);
			var moduleEntry = ModuleOf(node)
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "Only managed modules can be converted.");
			var module = moduleEntry.Module;
			var assembly = module.Assembly;
			if (request.ToAssembly) {
				if (assembly is not null)
					throw new RpcException(ErrorCodes.EditValidationFailed, "The module already belongs to an assembly.");
			}
			else {
				if (assembly is null)
					throw new RpcException(ErrorCodes.EditValidationFailed, "The module does not belong to an assembly.");
				// dnSpy only offers the command while the module is the assembly's manifest and only module:
				// stripping the manifest out from under the others would leave them with no way to be saved.
				if (assembly.Modules.Count != 1 || assembly.ManifestModule != module)
					throw new RpcException(ErrorCodes.EditValidationFailed, "The assembly has more than one module, so it cannot become a net module.");
			}

			var rootKey = $"assembly:{moduleEntry.Path}";
			var root = nodeIdsByKey.TryGetValue(rootKey, out var rootId) ? nodes[rootId] : null;
			transaction.Add(node.Id, moduleEntry, () => {
				var oldValue = root?.Value;
				var oldKind = module.Kind;
				var oldCharacteristics = module.Characteristics;
				object newValue;
				if (request.ToAssembly) {
					// dnlib hands the module its assembly through the collection: the property is read-only,
					// and adding the module is what sets it, exactly as dnSpy's own helper relies on.
					var created = new AssemblyDefUser(NetModuleName(module));
					created.Modules.Add(module);
					newValue = created;
					module.Kind = ModuleKind.Dll;
				}
				else {
					assembly!.Modules.Remove(module);
					newValue = module;
					module.Kind = ModuleKind.NetModule;
				}
				module.Characteristics = WithDllBit(oldCharacteristics, module.Kind);
				if (root is not null)
					root.Value = newValue;
				return () => {
					module.Kind = oldKind;
					module.Characteristics = oldCharacteristics;
					if (root is not null)
						root.Value = oldValue!;
				};
			});
		}

		/// <summary>The name dnSpy gives the assembly it creates, which is the file's without the extension a
		/// module file is allowed to end in — and the whole file name when nothing is left of it.</summary>
		static string NetModuleName(ModuleDef module) {
			var name = module.Name.String;
			foreach (var extension in new[] { ".dll", ".exe", ".netmodule" }) {
				if (name.EndsWith(extension, StringComparison.OrdinalIgnoreCase)) {
					var trimmed = name[..^extension.Length];
					return !string.IsNullOrWhiteSpace(trimmed) ? trimmed : name;
				}
			}
			return name;
		}

		/// <summary>The one bit that follows the module kind: a library and a net module are DLLs, an
		/// executable is not.</summary>
		static dnlib.PE.Characteristics WithDllBit(dnlib.PE.Characteristics characteristics, ModuleKind kind) =>
			kind is ModuleKind.Dll or ModuleKind.NetModule
				? characteristics | dnlib.PE.Characteristics.Dll
				: characteristics & ~dnlib.PE.Characteristics.Dll;

		public void QueueResource(ReplaceResourceRequest request) {
			var transaction = GetTransaction(request.TransactionId);
			var node = GetNode(request.ResourceNodeId);
			if (node.Value is not EmbeddedResource oldResource)
				throw new RpcException(ErrorCodes.EditValidationFailed, "Only embedded resources can be replaced.");
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support resource editing.");
			byte[] data;
			try {
				data = Convert.FromBase64String(request.Base64Data);
			}
			catch (FormatException ex) {
				throw new RpcException(ErrorCodes.EditValidationFailed, "The resource data is not valid base64.", null, ex);
			}
			var index = moduleEntry.Module.Resources.IndexOf(oldResource);
			if (index < 0)
				throw new RpcException(ErrorCodes.EditValidationFailed, "The resource no longer belongs to the module.");
			var replacement = new EmbeddedResource(oldResource.Name, data, oldResource.Attributes);
			transaction.Add(node.Id, moduleEntry, () => {
				moduleEntry.Module.Resources[index] = replacement;
				node.Value = replacement;
				return () => {
					moduleEntry.Module.Resources[index] = oldResource;
					node.Value = oldResource;
				};
			});
		}

		/// <summary>
		/// Queues the creation of a type or a member, which is what one of dnSpy's create commands does once
		/// its dialog has been accepted.
		/// </summary>
		/// <remarks>
		/// The row is given its id here rather than when the operation is applied, which is the order dnSpy
		/// uses too — its options classes call <c>UpdateRowId</c> from their constructors. That is what makes
		/// the new node knowable before the commit: the tree can be told which node to reveal, and applying
		/// the operation a second time (undo, then redo) puts the same row, with the same token, back.
		/// </remarks>
		public EditNodeResponse QueueCreate(CreateNodeRequest request) {
			var transaction = GetTransaction(request.TransactionId);
			var owner = GetNode(request.OwnerNodeId);
			var ownerModule = owner.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support creating items.");
			var options = request.Options;
			// Which list the row goes in is decided by its owner, so say now whether there is one: a rejected
			// request should not burn a row id on an object nothing will ever hold.
			TypeDef? ownerType;
			if (options.Kind == NodeOptionKinds.Type) {
				// Create Nested Type puts the new type inside the selected one, or inside the type the
				// selected member belongs to — dnSpy's command takes a type or a member of one. Create Type
				// is the other command, and it puts the type at the top level whatever is selected, a type
				// node included: the module holds it and its own namespace is what files it. The two
				// ask for different selections, and so are checked apart.
				if (request.Nested)
					ownerType = OwnerTypeOf(owner);
				else if (owner.Value is TypeDef or NamespaceValue or ModuleDef)
					ownerType = null;
				else
					throw new RpcException(ErrorCodes.EditValidationFailed, "Select a type, a namespace or a module.");
			}
			else
				ownerType = OwnerTypeOf(owner);

			var created = Create(options, CreateEditContext(ownerModule), ownerType);
			var node = GetMemberNode(created, ownerModule);
			var membership = MembershipOf(owner, ownerType, created);
			transaction.Add(node.Id, ownerModule, () => {
				membership.Add();
				return membership.Remove;
			});
			return new EditNodeResponse(node.Id, LabelOf(created, ownerType, node), node.Kind.ToString().ToLowerInvariant());
		}

		/// <summary>
		/// What the tree will call the row once the operation has run. That is the row's own label, except for
		/// a nested type: a type says what it is nested in through the list it joins, and it does not join it
		/// until the commit, so its <c>FullName</c> is still the bare name here and the nested form has to be
		/// spelled out — which is exactly what <c>FullName</c> will say once the list holds it.
		/// </summary>
		string LabelOf(IMDTokenProvider created, TypeDef? ownerType, NodeEntry node) =>
			created is TypeDef type && ownerType is not null ? $"{ownerType.Name}+{type.Name}" : GetLabel(node);

		/// <summary>
		/// Queues an edit of an existing type or member: the dialog's values are written over the row, and the
		/// values the row had are what the undo action writes back.
		/// </summary>
		/// <remarks>
		/// Both directions run the same codec over a whole model, so an edit undone and redone lands where it
		/// started and where it left off. That is why the row's own values are taken as a model up front
		/// instead of the operation remembering which fields the dialog touched — the codecs rebuild every
		/// collection they own, and a partial undo would leave the rest of them as the edit left them.
		/// </remarks>
		public EditNodeResponse QueueSetOptions(SetNodeOptionsRequest request) {
			var transaction = GetTransaction(request.TransactionId);
			var node = GetNode(request.NodeId);
			if (node.Value is not IMDTokenProvider target)
				throw new RpcException(ErrorCodes.EditValidationFailed, "The selected item cannot be edited.");
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support editing.");
			var context = CreateEditContext(moduleEntry);
			var before = context.Options.Existing(target);
			if (before.Kind != request.Options.Kind)
				throw new RpcException(ErrorCodes.EditValidationFailed, "The options are for a different kind of item.");
			var after = request.Options;
			transaction.Add(node.Id, moduleEntry, () => {
				Apply(context, target, after);
				return () => Apply(context, target, before);
			});
			// The operation has not run yet, so this is the name it still has; the new one is what the tree
			// shows once the commit lands and the node is read again.
			return new EditNodeResponse(node.Id, GetLabel(node), node.Kind.ToString().ToLowerInvariant());
		}

		IMDTokenProvider Create(NodeOptionsDto options, EditContext context, TypeDef? ownerType) => options.Kind switch {
			NodeOptionKinds.Type => context.TypeDefs.Create(options.Type ?? throw MissingOptions("type")),
			NodeOptionKinds.Method => context.MethodDefs.Create(options.Method ?? throw MissingOptions("method")),
			NodeOptionKinds.Field => context.FieldDefs.Create(options.Field ?? throw MissingOptions("field")),
			NodeOptionKinds.Property => context.PropertyDefs.Create(ownerType!, options.Property ?? throw MissingOptions("property")),
			NodeOptionKinds.Event => context.EventDefs.Create(ownerType!, options.Event ?? throw MissingOptions("event")),
			_ => throw new RpcException(ErrorCodes.InvalidParams, $"Unknown item kind '{options.Kind}'."),
		};

		static RpcException MissingOptions(string kind) =>
			new(ErrorCodes.EditValidationFailed, $"The {kind} options are missing.");

		/// <summary>Writes a whole model over an existing row. The owner a property or an event needs to find
		/// its accessors in is the type the row is declared in, which it already knows.</summary>
		static void Apply(EditContext context, IMDTokenProvider target, NodeOptionsDto options) {
			switch (options.Kind) {
				case NodeOptionKinds.Type: context.TypeDefs.CopyTo((TypeDef)target, options.Type!); break;
				case NodeOptionKinds.Method: context.MethodDefs.CopyTo((MethodDef)target, options.Method!); break;
				case NodeOptionKinds.Field: context.FieldDefs.CopyTo((FieldDef)target, options.Field!); break;
				case NodeOptionKinds.Property: context.PropertyDefs.CopyTo((PropertyDef)target, ((PropertyDef)target).DeclaringType, options.Property!); break;
				case NodeOptionKinds.Event: context.EventDefs.CopyTo((EventDef)target, ((EventDef)target).DeclaringType, options.Event!); break;
				default: throw new RpcException(ErrorCodes.InvalidParams, $"Unknown item kind '{options.Kind}'.");
			}
		}

		/// <summary>
		/// The list a created row belongs in, and the two closures that put it there and take it back out.
		/// A member goes into the type that owns it; a type goes into the type it is nested in, or into the
		/// module itself when it was created from a namespace or a module node.
		/// </summary>
		static (Action Add, Action Remove) MembershipOf(NodeEntry owner, TypeDef? ownerType, IMDTokenProvider created) => created switch {
			// A type with no type to be nested in is a top-level one, which the module holds; its own
			// namespace is what files it, and there is no list per namespace to put it in.
			TypeDef type when ownerType is null => Pair(owner.AsModuleEntry!.Module.Types, type),
			TypeDef type => Pair(ownerType.NestedTypes, type),
			MethodDef method => Pair(ownerType!.Methods, method),
			FieldDef field => Pair(ownerType!.Fields, field),
			PropertyDef property => Pair(ownerType!.Properties, property),
			EventDef @event => Pair(ownerType!.Events, @event),
			_ => throw new RpcException(ErrorCodes.EditValidationFailed, "The selected item cannot be created."),
		};

		static (Action Add, Action Remove) Pair<T>(IList<T> list, T value) =>
			(() => list.Add(value), () => list.Remove(value));

		public EditCommitResponse CommitEdit(string transactionId) {
			var transaction = GetTransaction(transactionId);
			if (transaction.BaseVersion != version)
				throw new RpcException(ErrorCodes.EditConflict, "The workspace changed after this edit transaction began.");
			var undo = new Stack<Action>();
			try {
				foreach (var operation in transaction.Operations)
					undo.Push(operation.Apply());
			}
			catch (Exception ex) {
				while (undo.TryPop(out var rollback))
					rollback();
				throw new RpcException(ErrorCodes.EditValidationFailed, "The edit transaction could not be applied.", null, ex);
			}
			transactions.Remove(transactionId);
			foreach (var module in transaction.Operations.Select(operation => operation.Module).Distinct().OfType<ModuleEntry>())
				module.IsModified = true;
			var previousStateId = stateId;
			stateId = Guid.NewGuid().ToString("N");
			NoteModelChanged();
			undoHistory.Push(new EditHistoryEntry(transaction.Operations.ToArray(), undo.ToArray(), previousStateId, stateId));
			redoHistory.Clear();
			version++;
			return CreateHistoryResponse(transaction.Operations);
		}

		public void RollbackEdit(string transactionId) {
			if (!transactions.Remove(transactionId))
				throw new RpcException(ErrorCodes.EditTransactionNotFound, "The edit transaction no longer exists.");
		}

		public EditCommitResponse Undo() {
			if (!undoHistory.TryPop(out var history))
				throw new RpcException(ErrorCodes.EditValidationFailed, "There is no edit to undo.");
			foreach (var undo in history.UndoActions)
				undo();
			stateId = history.BeforeStateId;
			NoteModelChanged();
			redoHistory.Push(history);
			version++;
			return CreateHistoryResponse(history.Operations);
		}

		public EditCommitResponse Redo() {
			if (!redoHistory.TryPop(out var history))
				throw new RpcException(ErrorCodes.EditValidationFailed, "There is no edit to redo.");
			var undo = new Stack<Action>();
			try {
				foreach (var operation in history.Operations)
					undo.Push(operation.Apply());
			}
			catch (Exception ex) {
				while (undo.TryPop(out var rollback))
					rollback();
				redoHistory.Push(history);
				throw new RpcException(ErrorCodes.EditValidationFailed, "The edit could not be reapplied.", null, ex);
			}
			stateId = history.AfterStateId;
			NoteModelChanged();
			var reapplied = new EditHistoryEntry(history.Operations, undo.ToArray(), history.BeforeStateId, history.AfterStateId);
			undoHistory.Push(reapplied);
			version++;
			return CreateHistoryResponse(history.Operations);
		}

		EditCommitResponse CreateHistoryResponse(IReadOnlyList<EditOperation> operations) => new(
			version,
			stateId,
			operations.Select(operation => operation.NodeId).Distinct(StringComparer.Ordinal).ToArray(),
			undoHistory.Count > 0,
			redoHistory.Count > 0,
			operations.Any(operation => operation.ChangesRoots) ? CreateOpenResponse().Modules : null);

		public async Task<SaveModuleResponse> SaveModuleAsync(SaveModuleRequest request, CancellationToken cancellationToken) {
			var module = GetModule(request.ModuleId);
			var destination = Path.GetFullPath(request.DestinationPath);
			var directory = Path.GetDirectoryName(destination);
			if (string.IsNullOrEmpty(directory) || !Directory.Exists(directory))
				throw new RpcException(ErrorCodes.SaveFailed, "The destination directory does not exist.");
			if (File.Exists(destination) && !request.Overwrite)
				throw new RpcException(ErrorCodes.SaveFailed, "The destination already exists.");

			var temporaryPath = Path.Combine(directory, $".{Path.GetFileName(destination)}.{Guid.NewGuid():N}.tmp");
			try {
				await Task.Run(() => module.Module.Write(temporaryPath), cancellationToken).ConfigureAwait(false);
				cancellationToken.ThrowIfCancellationRequested();
				// The reload is what the patches are resolved against: the file dnlib just wrote has a
				// layout of its own, so where a patch belongs is found through the member it aimed at.
				IReadOnlyList<(long Offset, byte[] Data)> hexPatches;
				using (var verificationModule = ModuleDefMD.Load(temporaryPath)) {
					_ = verificationModule.Mvid;
					_ = verificationModule.Types.Count;
					hexPatches = module.ResolveHexPatchOffsets(verificationModule);
				}
				// dnlib knows nothing about the hex patches, so they go on last — over the bytes it wrote.
				await Task.Run(() => {
					using var stream = new FileStream(temporaryPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
					WriteHexPatches(stream, hexPatches);
				}, cancellationToken).ConfigureAwait(false);
				File.Move(temporaryPath, destination, request.Overwrite);
				await using var savedFile = new FileStream(destination, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
				var hash = await SHA256.HashDataAsync(savedFile, cancellationToken).ConfigureAwait(false);
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
		/// Writes a module back over the file it was loaded from — dnSpy's Save, where Save As is
		/// <see cref="SaveModuleAsync"/>. The file is replaced in place, so the path the tree node holds
		/// still names it and no dialog is involved.
		/// </summary>
		public async Task<SaveModuleResponse> SaveModuleInPlaceAsync(SaveModuleInPlaceRequest request, CancellationToken cancellationToken) {
			var module = GetModule(request.ModuleId);
			var saved = await SaveModuleAsync(
				new SaveModuleRequest(request.WorkspaceId, request.ModuleId, module.Path, Overwrite: true),
				cancellationToken).ConfigureAwait(false);
			module.IsModified = false;
			return saved;
		}

		/// <summary>
		/// Writes every module that has unsaved edits back over its own file, which is dnSpy's Save All.
		/// Nothing modified means nothing written, and that is not an error. A module that fails to save
		/// stops the run: the ones already written stay written, and the error names what went wrong.
		/// </summary>
		public async Task<SaveAllResponse> SaveAllModulesAsync(CancellationToken cancellationToken) {
			var saved = new List<SaveModuleResponse>();
			foreach (var module in OrderedModules()) {
				if (!module.IsModified)
					continue;
				saved.Add(await SaveModuleInPlaceAsync(
					new SaveModuleInPlaceRequest(Id, module.Id), cancellationToken).ConfigureAwait(false));
			}
			return new SaveAllResponse(saved);
		}

		/// <summary>
		/// Drops every assembly and loads the files again, which is dnSpy's Reload All Assemblies: edits
		/// are lost, and so are the tabs, the undo stack and the loaded reference assemblies. The workspace
		/// keeps its id, so the client's handle on it still resolves, but every node id it cached is gone —
		/// it has to read the tree again. Node ids are not numbered from zero again either: a tab the client
		/// has not reset yet would otherwise match a node that is not the one it named.
		/// </summary>
		/// <summary>
		/// dnSpy's Reload All Assemblies (DocumentListLoader.Reload): every file the user opened, read again in the
		/// order the tree shows them, and after them the files the workspace had opened by itself that are named in
		/// <paramref name="autoLoadedPaths"/> — the ones a tab still shows something of, which come back auto-loaded
		/// as they were so the tab can be restored. Every other auto-loaded file is left to be found again when a
		/// reference asks for it. Every node id goes with the reload, and so does the edit history.
		/// </summary>
		public async Task<OpenWorkspaceResponse> ReloadAsync(IReadOnlyList<string>? autoLoadedPaths, CancellationToken cancellationToken) {
			var entries = OrderedEntries().ToArray();
			var paths = entries.Where(entry => !IsAutoLoaded(entry)).Select(entry => entry.Path).ToArray();
			var kept = entries
				.Where(entry => IsAutoLoaded(entry) && autoLoadedPaths?.Any(path => SameFile(Path.GetFullPath(path), entry.Path)) == true)
				.Select(entry => entry.Path)
				.ToArray();
			modules.Clear();
			peModules.Clear();
			elfFiles.Clear();
			unknownFiles.Clear();
			autoLoadedRoots.Clear();
			netModules.Clear();
			referenceModules.Clear();
			foreach (var resolver in referenceResolvers.Values)
				resolver?.Dispose();
			referenceResolvers.Clear();
			referencePaths.Clear();
			namespaceIndexes.Clear();
			typeIndexes.Clear();
			typeReferenceIndexes.Clear();
			nodes.Clear();
			nodeIdsByKey.Clear();
			transactions.Clear();
			undoHistory.Clear();
			redoHistory.Clear();
			codeStatementsByNode.Clear();
			rootOrder.Clear();
			cachedStatementsStateId = string.Empty;
			version = 0;
			stateId = Guid.NewGuid().ToString("N");
			NoteModelChanged();
			symbols.Invalidate();
			await LoadModulesAsync(paths, cancellationToken).ConfigureAwait(false);
			await LoadModulesAsync(kept, cancellationToken, autoLoaded: true).ConfigureAwait(false);
			if (modules.Count == 0 && peModules.Count == 0 && elfFiles.Count == 0 && unknownFiles.Count == 0)
				throw new RpcException(ErrorCodes.FileNotFound, "None of the assemblies could be reloaded.");
			return CreateOpenResponse();
		}

		/// <summary>
		/// Writes resolved patches over a serialized module. A patch only ever replaces bytes in place, so
		/// one that would reach past the end of the file is refused rather than allowed to grow it.
		/// </summary>
		static void WriteHexPatches(Stream stream, IReadOnlyList<(long Offset, byte[] Data)> patches) {
			foreach (var (offset, data) in patches) {
				if (offset < 0 || offset + data.Length > stream.Length)
					throw new RpcException(ErrorCodes.SaveFailed, "A hex patch no longer fits where it was aimed, so the module cannot be written.");
				stream.Position = offset;
				stream.Write(data);
			}
		}

		EditTransaction GetTransaction(string id) => transactions.TryGetValue(id, out var transaction)
			? transaction
			: throw new RpcException(ErrorCodes.EditTransactionNotFound, "The edit transaction no longer exists.");

		CilBody BuildMethodBody(MethodDef method, ReplaceMethodBodyRequest request) {
			if (request.Instructions.Count == 0 || request.Instructions.Count > 100_000)
				throw new RpcException(ErrorCodes.EditValidationFailed, "A method body must contain between 1 and 100,000 instructions.");
			var body = new CilBody {
				InitLocals = request.InitLocals ?? method.Body?.InitLocals ?? false,
				MaxStack = (ushort)Math.Clamp(request.MaxStack ?? method.Body?.MaxStack ?? 8, 0, ushort.MaxValue),
				KeepOldMaxStack = request.MaxStack is not null,
			};
			if (method.Body is not null) {
				foreach (var local in method.Body.Variables)
					body.Variables.Add(new Local(local.Type));
			}

			var instructions = new Dictionary<string, Instruction>(StringComparer.Ordinal);
			foreach (var source in request.Instructions) {
				if (string.IsNullOrWhiteSpace(source.Label) || instructions.ContainsKey(source.Label))
					throw new RpcException(ErrorCodes.EditValidationFailed, $"Instruction label is empty or duplicated: {source.Label}");
				var opCode = GetOpCode(source.OpCode);
				var instruction = new Instruction(opCode);
				instructions.Add(source.Label, instruction);
				body.Instructions.Add(instruction);
			}

			for (var index = 0; index < request.Instructions.Count; index++) {
				var source = request.Instructions[index];
				body.Instructions[index].Operand = ParseOperand(method, body, body.Instructions[index].OpCode, source, instructions);
			}
			body.UpdateInstructionOffsets();
			return body;
		}

		object? ParseOperand(MethodDef method, CilBody body, OpCode opCode, IlInstructionDto source, IReadOnlyDictionary<string, Instruction> instructions) {
			string RequiredOperand() => source.Operand ?? throw new RpcException(ErrorCodes.EditValidationFailed, $"{opCode.Name} requires an operand.");
			try {
				return opCode.OperandType switch {
					OperandType.InlineNone => null,
					OperandType.ShortInlineI => sbyte.Parse(RequiredOperand(), NumberStyles.Integer, CultureInfo.InvariantCulture),
					OperandType.InlineI => int.Parse(RequiredOperand(), NumberStyles.Integer, CultureInfo.InvariantCulture),
					OperandType.InlineI8 => long.Parse(RequiredOperand(), NumberStyles.Integer, CultureInfo.InvariantCulture),
					OperandType.ShortInlineR => float.Parse(RequiredOperand(), NumberStyles.Float, CultureInfo.InvariantCulture),
					OperandType.InlineR => double.Parse(RequiredOperand(), NumberStyles.Float, CultureInfo.InvariantCulture),
					OperandType.InlineString => RequiredOperand(),
					OperandType.ShortInlineBrTarget or OperandType.InlineBrTarget => GetTarget(RequiredOperand(), instructions),
					OperandType.InlineSwitch => RequiredOperand().Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).Select(label => GetTarget(label, instructions)).ToArray(),
					OperandType.ShortInlineVar or OperandType.InlineVar => GetVariableOperand(method, body, source),
					OperandType.InlineType or OperandType.InlineField or OperandType.InlineMethod or OperandType.InlineTok => GetTokenOperand(method.Module, opCode.OperandType, source),
					_ => throw new RpcException(ErrorCodes.EditValidationFailed, $"Operand type {opCode.OperandType} is not supported by the structured IL editor."),
				};
			}
			catch (RpcException) {
				throw;
			}
			catch (Exception ex) when (ex is FormatException or OverflowException or ArgumentOutOfRangeException) {
				throw new RpcException(ErrorCodes.EditValidationFailed, $"The operand for {opCode.Name} is invalid.", null, ex);
			}
		}

		object GetTokenOperand(ModuleDef module, OperandType operandType, IlInstructionDto source) {
			object value;
			if (source.OperandKind?.Equals("token", StringComparison.OrdinalIgnoreCase) == true) {
				if (!uint.TryParse(source.Operand, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var rawToken))
					throw new RpcException(ErrorCodes.EditValidationFailed, "The metadata token operand is invalid.");
				value = module.ResolveToken(rawToken)
					?? throw new RpcException(ErrorCodes.EditValidationFailed, "The metadata token operand could not be resolved.");
			}
			else {
				var nodeId = source.Operand ?? throw new RpcException(ErrorCodes.EditValidationFailed, "The token node ID is missing.");
				value = GetNode(nodeId).Value;
			}
			return operandType switch {
				OperandType.InlineType when value is ITypeDefOrRef type => type,
				OperandType.InlineField when value is IField field => field,
				OperandType.InlineMethod when value is IMethod method => method,
				OperandType.InlineTok when value is ITokenOperand token => token,
				_ => throw new RpcException(ErrorCodes.EditValidationFailed, "The selected node is incompatible with the IL token operand."),
			};
		}

		static object GetVariableOperand(MethodDef method, CilBody body, IlInstructionDto source) {
			var index = int.Parse(source.Operand ?? string.Empty, NumberStyles.None, CultureInfo.InvariantCulture);
			return source.OperandKind?.ToLowerInvariant() switch {
				"local" when index < body.Variables.Count => body.Variables[index],
				"argument" when index < method.Parameters.Count => method.Parameters[index],
				_ => throw new RpcException(ErrorCodes.EditValidationFailed, "Variable operands require a valid local or argument index."),
			};
		}

		static Instruction GetTarget(string label, IReadOnlyDictionary<string, Instruction> instructions) =>
			instructions.TryGetValue(label, out var target)
				? target
				: throw new RpcException(ErrorCodes.EditValidationFailed, $"Branch target does not exist: {label}");

		static readonly IReadOnlyDictionary<string, OpCode> OpCodesByName = typeof(OpCodes)
			.GetFields(BindingFlags.Public | BindingFlags.Static)
			.Where(field => field.FieldType == typeof(OpCode))
			.Select(field => (OpCode)field.GetValue(null)!)
			.ToDictionary(opCode => opCode.Name, StringComparer.OrdinalIgnoreCase);

		static OpCode GetOpCode(string name) => OpCodesByName.TryGetValue(name, out var opCode)
			? opCode
			: throw new RpcException(ErrorCodes.EditValidationFailed, $"Unknown IL opcode: {name}");

		static string? GetEditableName(object value) => value switch {
			TypeDef type => type.Name.String,
			MethodDef method => method.Name.String,
			FieldDef field => field.Name.String,
			PropertyDef property => property.Name.String,
			EventDef @event => @event.Name.String,
			_ => null,
		};

		static void SetEditableName(object value, string name) {
			switch (value) {
				case TypeDef type: type.Name = name; break;
				case MethodDef method: method.Name = name; break;
				case FieldDef field: field.Name = name; break;
				case PropertyDef property: property.Name = name; break;
				case EventDef @event: @event.Name = name; break;
				default: throw new RpcException(ErrorCodes.EditValidationFailed, "The selected item cannot be renamed.");
			}
		}

		ModuleEntry GetModule(string moduleId) {
			if (modules.TryGetValue(moduleId, out var module))
				return module;
			// Module tools are invoked on the module node, which now sits under the assembly root the entry
			// is keyed by; the node still carries the ModuleEntry it belongs to, so it resolves the same module.
			if (nodes.TryGetValue(moduleId, out var node) && node.AsModuleEntry is { } entry)
				return entry;
			// A PE-only, ELF or unreadable file is in the tree but has no module to edit or write, and saying
			// so is more use than reporting that the id is unknown.
			throw new RpcException(
				ErrorCodes.NodeNotFound,
				peModules.ContainsKey(moduleId) || elfFiles.ContainsKey(moduleId) || unknownFiles.ContainsKey(moduleId)
					? "This file is not a managed assembly, so it cannot be edited or saved."
					: "The module no longer exists.");
		}

		NodeEntry GetNode(string nodeId) => nodes.TryGetValue(nodeId, out var node)
			? node
			: throw new RpcException(ErrorCodes.NodeNotFound, "The selected tree node no longer exists.");

		NodeEntry GetMemberNode(IMDTokenProvider member, ModuleEntry module) => GetOrAddNode(
			MemberKey(module, GetKind(member).ToString(), member.MDToken.Raw),
			GetKind(member),
			member,
			module);

		NodeEntry GetOrAddNode(string key, NodeKind kind, object value, object module) {
			if (nodeIdsByKey.TryGetValue(key, out var id))
				return nodes[id];
			id = $"n{(++nextNodeId).ToString(CultureInfo.InvariantCulture)}";
			var entry = new NodeEntry(id, key, kind, value, module);
			nodes.Add(id, entry);
			nodeIdsByKey.Add(key, id);
			return entry;
		}

		static string MemberKey(ModuleEntry module, string kind, uint token) => $"{module.Path}:{kind}:{token:X8}";

		static NodeKind GetKind(IMDTokenProvider provider) => provider switch {
			TypeDef => NodeKind.Type,
			MethodDef => NodeKind.Method,
			FieldDef => NodeKind.Field,
			PropertyDef => NodeKind.Property,
			EventDef => NodeKind.Event,
			_ => throw new ArgumentOutOfRangeException(nameof(provider)),
		};

		/// <summary>
		/// The name a member's row wears — what dnSpy's NodeFormatter writes through the C# decompiler: a type
		/// with its own type parameters ("List&lt;T&gt;"), a method with its parameter types — a constructor named
		/// after its type — an indexer as "this[int]", anything else by its name. The namespace is on the row
		/// above and the full signature in the tooltip.
		/// </summary>
		static string GetMemberDisplayName(IMDTokenProvider member) {
			switch (member) {
				case TypeDef type:
					return TypeRowName(type);
				case MethodDef method:
					var methodName = new TextPartsBuilder();
					WriteMethodRowName(methodName, method, null);
					return methodName.ToString();
				case PropertyDef property:
					var propertyName = new TextPartsBuilder();
					WritePropertyRowName(propertyName, property, null);
					return propertyName.ToString();
				case FieldDef field:
					return field.Name.String;
				case EventDef @event:
					return @event.Name.String;
				default:
					return member.ToString() ?? string.Empty;
			}
		}

		/// <summary>
		/// The label a method's tab wears. dnSpy's <c>MethodNode.Write</c> with <c>DocumentNodeWriteOptions.Title</c>
		/// is what the WPF tab shows — it is the tree's "name(params)" plus the decompiler-written
		/// <c>" : RetType"</c> the tab adds behind it. The tree label keeps the short form — the client
		/// composes the row's "name(params) : RetType @token" from <see cref="TreeNodeDto.ReturnType"/> and
		/// <see cref="TreeNodeDto.MetadataToken"/> — because the row also has a tooltip with the full
		/// signature, which the tab does not.
		/// </summary>
		static string GetMethodTabTitle(MethodDef method) =>
			$"{GetMemberDisplayName(method)} : {CSharpTypeName.Of(method.Parameters.ReturnParameter.ParamDef, method.ReturnType)}";

		/// <summary>
		/// The title a tab shows for the given document node. A method node names its return type after
		/// the parameter list — dnSpy's tab for one reads "name(params) : return" — while every other
		/// kind keeps what the tree shows.
		/// </summary>
		string GetDocumentTitle(NodeEntry node) => node switch {
			{ Kind: NodeKind.Method, Value: MethodDef method } => GetMethodTabTitle(method),
			// A tab is written the way the row is, and the row writes an assembly's version by default
			// (DocumentTreeViewSettings.ShowAssemblyVersion); the label leaves it to the client's options.
			{ Kind: NodeKind.Assembly, Value: AssemblyDef { Version: { } version } } => $"{GetLabel(node)} ({version})",
			_ => GetLabel(node),
		};

		static string FormatParameterList(MethodDef method) => $"({string.Join(", ", method.Parameters.Where(p => !p.IsHiddenThisParameter).Select(p => p.Type.TypeName))})";

		TreeNodeDto ToDto(NodeEntry node) => new(
			node.Id,
			GetLabel(node),
			node.Kind.ToString().ToLowerInvariant(),
			HasChildren(node),
			GetDescription(node),
			GetIcon(node),
			node.Key,
			GetMetadataToken(node),
			GetMemberReturnType(node),
			GetLabelParts(node),
			GetMemberReturnTypeParts(node),
			GetToolTip(node),
			GetMsdnName(node),
			IsCompilerGenerated(node),
			node.Module is IModuleEntry entry && entry.Id == node.Id && IsAutoLoaded(entry),
			node.Kind == NodeKind.Assembly && node.Value is AssemblyDef { Version: { } version } ? version.ToString() : null,
			node.Kind == NodeKind.Assembly && node.Value is AssemblyDef assembly ? PublicKeyTokenText(assembly) : null,
			GetFullName(node));

		/// <summary>The public key token an assembly row may write after its version: the token, "null" when it
		/// has none — dnSpy's NodeFormatter only writes one that is not empty, which the client decides.</summary>
		static string? PublicKeyTokenText(AssemblyDef assembly) {
			var token = assembly.PublicKeyToken;
			return PublicKeyBase.IsNullOrEmpty2(token) ? null : token.ToString();
		}

		// The token the WPF tree appends as "@06000004" — every node whose value is a metadata row
		// (assemblies, modules, assembly and module references, types, members and the references the
		// module makes to other assemblies' types and members); namespaces, the group folders, resources and
		// the PE/ELF structures get none, same as dnSpy's NodeFormatter.
		static int? GetMetadataToken(NodeEntry node) => node.Value switch {
			// A base type row carries the reference it names, so the token is that reference's row — what
			// dnSpy's NodeFormatter writes for the node.
			BaseTypeValue value => unchecked((int)value.TypeDefOrRef.MDToken.Raw),
			TypeReferenceValue value => unchecked((int)value.Type.MDToken.Raw),
			IMDTokenProvider provider => unchecked((int)provider.MDToken.Raw),
			_ => null,
		};

		// The type a member's row names after the colon — through the C# decompiler's spelling, the
		// way dnSpy's tree writes it ("int", "Task<int>"). dnSpy writes it for methods, fields,
		// properties and events, and for the references to them; everything else has nothing to name.
		static string? GetMemberReturnType(NodeEntry node) => node.Value switch {
			// WPF passes the return parameter for a method, so a "dynamic" return is read off it.
			MethodDef method => CSharpTypeName.Of(method.Parameters.ReturnParameter.ParamDef, method.ReturnType),
			FieldDef field => CSharpTypeName.Of(field, field.FieldSig?.Type),
			PropertyDef property => CSharpTypeName.Of(property, property.PropertySig?.GetRetType()),
			EventDef @event => CSharpTypeName.Of(@event, @event.EventType),
			MemberRef { IsFieldRef: true } field when node.Kind == NodeKind.FieldReference => CSharpTypeName.Of(null, field.FieldSig?.Type) ?? "???",
			IMethod method when node.Kind is NodeKind.MethodReference or NodeKind.PropertyReference or NodeKind.EventReference =>
				CSharpTypeName.Of(null, (method is MethodSpec spec ? spec.Method : method).MethodSig?.RetType),
			_ => null,
		};

		string GetLabel(NodeEntry node) => node.Kind switch {
			NodeKind.Assembly => GetAssemblyLabel(node),
			NodeKind.Module => GetModuleLabel((ModuleDefMD)node.Value),
			NodeKind.PE => "PE",
			NodeKind.PeStructure => GetPeStructureLabel(node),
			NodeKind.Elf => "ELF",
			NodeKind.ElfStructure => GetElfStructureLabel(node),
			// dnSpy names these nodes after the file, so the tree says which file could not be read.
			NodeKind.PEDocument or NodeKind.UnknownDocument or NodeKind.ElfDocument => Path.GetFileName(((IModuleEntry)node.Module).Path),
			NodeKind.Namespace => string.IsNullOrEmpty(((NamespaceValue)node.Value).Name) ? "-" : ((NamespaceValue)node.Value).Name,
			// The folders dnSpy labels from its resources; the client translates them.
			NodeKind.TypeReferencesGroup => "Type References",
			NodeKind.ReferencesGroup => "References",
			NodeKind.ResourcesGroup => "Resources",
			NodeKind.TypeSpecsFolder => "Types",
			NodeKind.MethodReferencesFolder => "Methods",
			NodeKind.PropertyReferencesFolder => "Properties",
			NodeKind.EventReferencesFolder => "Events",
			NodeKind.FieldReferencesFolder => "Fields",
			// NodeFormatter writes an assembly or module reference by its name alone.
			NodeKind.AssemblyReference => ((AssemblyRef)node.Value).Name.String,
			NodeKind.ModuleReference => ((ModuleRef)node.Value).Name.String,
			NodeKind.Resource or NodeKind.ResourceEntry => ResourceLabel(node),
			NodeKind.Type or NodeKind.Method or NodeKind.Field or NodeKind.Property or NodeKind.Event => GetMemberDisplayName((IMDTokenProvider)node.Value),
			// dnSpy spells a base type the way the decompiler writes it — "object", "IEnumerable<int>" —
			// while a derived type is a definition the tree names as it names any other type.
			NodeKind.BaseTypeFolder => "Base Type and Interfaces",
			NodeKind.DerivedTypesFolder => "Derived Types",
			NodeKind.BaseType => GetBaseTypeLabel(((BaseTypeValue)node.Value).TypeDefOrRef),
			NodeKind.DerivedType => GetMemberDisplayName((TypeDef)node.Value),
			NodeKind.TypeReference => GetBaseTypeLabel(((TypeReferenceValue)node.Value).Type),
			NodeKind.MethodReference or NodeKind.PropertyReference or NodeKind.EventReference => MethodReferenceLabel((IMethod)node.Value),
			NodeKind.FieldReference => ((MemberRef)node.Value).Name.String,
			_ => node.Kind.ToString(),
		};



		string MethodReferenceLabel(IMethod method) {
			var output = new TextPartsBuilder();
			WriteMethodReferenceName(output, method);
			return output.ToString();
		}

		static string GetBaseTypeLabel(ITypeDefOrRef type) =>
			CSharpTypeName.Of(null, type) ?? type.Name.String;

		static string GetPeStructureLabel(NodeEntry node) {
			var value = (PeStructureValue)node.Value;
			var entry = (IModuleEntry)node.Module;
			return GetPeStructureSource(entry) is { } source
				? PeStructureFormatter.Label(source, value.Kind, value.Index)
				: value.Kind.ToString();
		}

		static string GetElfStructureLabel(NodeEntry node) {
			var value = (ElfStructureValue)node.Value;
			return node.Module is ElfFileEntry entry
				? ElfStructureFormatter.Label(entry.Elf, value.Kind, value.Index)
				: value.Kind.ToString();
		}

		/// <summary>
		/// An assembly row's label is the assembly's name. Its version and public key token are sent apart
		/// (<see cref="TreeNodeDto.AssemblyVersion"/>, <see cref="TreeNodeDto.PublicKeyToken"/>) because the
		/// Assembly Explorer options say whether the row writes them. A module with no assembly is named
		/// after itself.
		/// </summary>
		static string GetAssemblyLabel(NodeEntry node) =>
			node.Value is AssemblyDef assembly ? assembly.Name.String : GetModuleLabel((ModuleDefMD)node.Value);

		static string GetModuleLabel(ModuleDefMD module) {
			// Module node shows just the file name (e.g., mscorlib.dll)
			return module.Name.String;
		}

		/// <summary>
		/// A row's description: the file a document row was read from — which Open Containing Folder hands
		/// to the shell — the full name of a definition or a reference — which Copy Full Name copies — and a
		/// resource's own line.
		/// </summary>
		static string? GetDescription(NodeEntry node) => node.Kind switch {
			NodeKind.Assembly or NodeKind.Module or NodeKind.PEDocument or NodeKind.UnknownDocument or NodeKind.ElfDocument => ((IModuleEntry)node.Module).Path,
			// dnSpy's hex nodes show the file they read the structure out of as their tooltip, and the ELF
			// structures do the same.
			NodeKind.PE or NodeKind.PeStructure or NodeKind.Elf or NodeKind.ElfStructure => ((IModuleEntry)node.Module).Path,
			NodeKind.AssemblyReference => ((AssemblyRef)node.Value).FullName,
			NodeKind.ModuleReference => ((ModuleRef)node.Value).FullName,
			NodeKind.Resource => DescribeResource((Resource)node.Value),
			NodeKind.ResourceEntry => DescribeResourceEntry((ResourceEntryValue)node.Value),
			NodeKind.Type or NodeKind.Method or NodeKind.Field or NodeKind.Property or NodeKind.Event or NodeKind.DerivedType => ((IFullName)node.Value).FullName,
			NodeKind.BaseType => ((BaseTypeValue)node.Value).TypeDefOrRef.FullName,
			NodeKind.TypeReference => ((TypeReferenceValue)node.Value).Type.FullName,
			NodeKind.MethodReference or NodeKind.PropertyReference or NodeKind.EventReference or NodeKind.FieldReference => ((IFullName)node.Value).FullName,
			_ => null,
		};

		bool HasChildren(NodeEntry node) => node.Kind switch {
			NodeKind.Assembly or NodeKind.Module or NodeKind.PE or NodeKind.Namespace or NodeKind.TypeReferencesGroup or NodeKind.ReferencesGroup or NodeKind.ResourcesGroup => true,
			// The two hierarchy folders dnSpy lists under every type, and the base type rows inside them,
			// are lazy-loading nodes: they are shown with an expander whether or not they turn out to hold
			// anything, which is what dnSpy's BaseTypeFolderNodeImpl and BaseTypeNodeImpl set up.
			NodeKind.Type or NodeKind.BaseTypeFolder or NodeKind.BaseType => true,
			// A sealed class can never have a derived type, so the search is not even offered; every other
			// type opens it (dnSpy's DerivedTypesFinder.QuickCheck).
			NodeKind.DerivedTypesFolder or NodeKind.DerivedType => CanHaveDerivedTypes((TypeDef)node.Value),
			// A PE document has the PE node, the way dnSpy's does wherever the image was read from a file.
			NodeKind.PEDocument => node.Module is PeOnlyModuleEntry,
			// A property or an event holds the accessor methods dnSpy files under it, and nothing else.
			NodeKind.Property or NodeKind.Event => HasAccessorMethods(node),
			// An ELF document has the node its headers hang off, and that node always has the file header.
			NodeKind.ElfDocument => node.Module is ElfFileEntry,
			NodeKind.Elf => true,
			NodeKind.AssemblyReference => HasAssemblyReferenceChildren(node),
			NodeKind.Resource => ShapeOf((Resource)node.Value) == ResourceShape.ResourceSet,
			// A referenced type only expands when the module uses something of it; its folders only exist
			// when they hold something.
			NodeKind.TypeReference => ((TypeReferenceValue)node.Value).Info.HasChildren,
			NodeKind.TypeSpecsFolder or NodeKind.MethodReferencesFolder or NodeKind.PropertyReferencesFolder or NodeKind.EventReferencesFolder or NodeKind.FieldReferencesFolder => true,
			_ => false,
		};

		/// <summary>The image a row wears, named after dnSpy's own image set — see <see cref="DotNetImages"/>.</summary>
		string GetIcon(NodeEntry node) => node.Kind switch {
			NodeKind.Assembly => node.Value is AssemblyDef assembly ? DotNetImages.Of(assembly) : DotNetImages.Module,
			NodeKind.Module => DotNetImages.Module,
			// Every hex structure node dnSpy creates uses DsImages.BinaryFile, and a PE document wears the
			// image an assembly would. An ELF image is read and shown the same way.
			NodeKind.PE or NodeKind.PeStructure => DotNetImages.BinaryFile,
			NodeKind.PEDocument => node.Module is PeOnlyModuleEntry { PEImage: { } peImage } ? DotNetImages.Of(peImage.ImageNTHeaders.FileHeader.Characteristics) : DotNetImages.BinaryFile,
			NodeKind.Elf or NodeKind.ElfStructure or NodeKind.ElfDocument => DotNetImages.BinaryFile,
			// dnSpy shows an unknown document with DsImages.AssemblyError.
			NodeKind.UnknownDocument => DotNetImages.AssemblyError,
			NodeKind.Namespace => DotNetImages.Namespace,
			NodeKind.TypeReferencesGroup or NodeKind.ReferencesGroup or NodeKind.AssemblyReference or NodeKind.ModuleReference => DotNetImages.Reference,
			NodeKind.ResourcesGroup or NodeKind.BaseTypeFolder or NodeKind.DerivedTypesFolder => DotNetImages.FolderClosed,
			NodeKind.Resource or NodeKind.ResourceEntry => ResourceIcon(node),
			NodeKind.Type or NodeKind.Method or NodeKind.Field or NodeKind.Property or NodeKind.Event or NodeKind.DerivedType => DotNetImages.Of((IMemberDef)node.Value),
			// dnSpy shows a base type with the image of the type it resolves to, and falls back to the
			// class or interface image when it cannot resolve one.
			NodeKind.BaseType => GetBaseTypeIcon(node),
			// A referenced type or member wears its definition's image when the module that defines it is
			// loaded already, and the plain image of its kind otherwise — never a reason to load one.
			NodeKind.TypeReference => FindLoadedType(GetScopeType(((TypeReferenceValue)node.Value).Type), 0) is { } typeDef ? DotNetImages.Of(typeDef) : DotNetImages.Type,
			NodeKind.TypeSpecsFolder => DotNetImages.Template,
			NodeKind.MethodReferencesFolder => DotNetImages.MethodPublic,
			NodeKind.PropertyReferencesFolder => DotNetImages.Property,
			NodeKind.EventReferencesFolder => DotNetImages.EventPublic,
			NodeKind.FieldReferencesFolder => DotNetImages.FieldPublic,
			NodeKind.MethodReference => FindLoadedMethod((IMethod)node.Value) is { } methodDef ? DotNetImages.Of(methodDef) : DotNetImages.MethodPublic,
			NodeKind.PropertyReference => OwnerOfAccessor(FindLoadedMethod((IMethod)node.Value), node.Kind) is PropertyDef propertyDef ? DotNetImages.Of(propertyDef) : DotNetImages.Property,
			NodeKind.EventReference => OwnerOfAccessor(FindLoadedMethod((IMethod)node.Value), node.Kind) is EventDef eventDef ? DotNetImages.Of(eventDef) : DotNetImages.EventPublic,
			NodeKind.FieldReference => FindLoadedField((MemberRef)node.Value) is { } fieldDef ? DotNetImages.Of(fieldDef) : DotNetImages.FieldPublic,
			_ => DotNetImages.Type,
		};

		string GetBaseTypeIcon(NodeEntry node) {
			var value = (BaseTypeValue)node.Value;
			return ResolveTypeForHierarchy(value.TypeDefOrRef) is { } resolved
				? DotNetImages.Of(resolved)
				: value.IsBaseType ? DotNetImages.ClassPublic : DotNetImages.InterfacePublic;
		}

		// The statement map is derived from the decompiled text, so an edit invalidates every entry at once.
		void RefreshStatementCache() {
			if (stateId == cachedStatementsStateId)
				return;
			codeStatementsByNode.Clear();
			symbols.Invalidate();
			cachedStatementsStateId = stateId;
		}

		// ---------------------------------------------------------------- debug symbols

		internal ResolveBreakpointsResponse ResolveBreakpoints(IReadOnlyList<BreakpointQuery> queries, CancellationToken cancellationToken) {
			var resolved = new List<ResolvedBreakpoint>(queries.Count);
			foreach (var query in queries) {
				cancellationToken.ThrowIfCancellationRequested();
				resolved.Add(ResolveBreakpoint(query, cancellationToken));
			}
			return new ResolveBreakpointsResponse(resolved);
		}

		ResolvedBreakpoint ResolveBreakpoint(BreakpointQuery query, CancellationToken cancellationToken) {
			var statement = FindStatementByNode(query, cancellationToken, out var reason) ?? FindStatementByIlIdentity(query, cancellationToken);
			if (statement is null)
				return Unbound(query, reason ?? "No sequence point on this line.");
			return new ResolvedBreakpoint(
				query.Id,
				true,
				null,
				statement.ModulePath,
				statement.MetadataToken,
				statement.SourceMethodToken,
				statement.IlOffset,
				// The engine arms the statement's own start first and falls back to this; without one it
				// reports the breakpoint dead, which beats a breakpoint that stops on another line.
				symbols.AcceptedPointOffset(this, statement),
				statement.StartLine,
				statement.EndLine,
				statement.StartColumn,
				statement.EndColumn,
				statement.Description);
		}

		/// <summary>The statement a live node id and line name, which is what a click in the editor gives.</summary>
		CodeStatementDto? FindStatementByNode(BreakpointQuery query, CancellationToken cancellationToken, out string? reason) {
			reason = null;
			IReadOnlyList<CodeStatementDto> statements;
			try {
				statements = GetCodeStatements(query.NodeId, cancellationToken);
			}
			catch (RpcException ex) {
				// The node id is gone — a restored breakpoint naming a node from the workspace that saved
				// it. Its IL identity gets the next try, and this message only stands if that has none.
				reason = ex.Message;
				return null;
			}
			return FindStatement(statements, query.Line, query.Column);
		}

		/// <summary>
		/// The statement a saved breakpoint's IL identity names, for a breakpoint whose node id died with
		/// the workspace that issued it. This is the location WPF dnSpy persists — module, token and IL
		/// offset — so a restored breakpoint binds without its document ever having been opened.
		/// </summary>
		CodeStatementDto? FindStatementByIlIdentity(BreakpointQuery query, CancellationToken cancellationToken) {
			if (query.ModulePath is not string modulePath || query.MetadataToken is not int metadataToken)
				return null;
			// Inside a state machine a statement belongs to MoveNext, whose token resolves to a method
			// nobody navigates to; the source method is the one that owns a node with these statements.
			var memberToken = query.SourceMethodToken is int source && source != 0 ? source : metadataToken;
			if (FindMember(modulePath, memberToken).NodeId is not string nodeId)
				return null;
			IReadOnlyList<CodeStatementDto> statements;
			try {
				statements = GetCodeStatements(nodeId, cancellationToken);
			}
			catch (RpcException) {
				return null;
			}
			if (query.IlOffset is int ilOffset) {
				foreach (var statement in statements) {
					if (!statement.IsHidden && statement.MetadataToken == metadataToken && statement.IlOffset == ilOffset)
						return statement;
				}
			}
			// The method is still there but its body moved under the saved offset — the assembly was
			// recompiled, or edited here. The saved line is the best guess left.
			return FindStatement(statements, query.Line, null);
		}

		static ResolvedBreakpoint Unbound(BreakpointQuery query, string reason) => new(
			query.Id, false, reason, null, null, null, null, null, query.Line, query.Line, 0, 0, null);

		/// <summary>
		/// Snaps a requested line to the statement that owns it, or to the closest one below it. A click on a
		/// blank line, a brace or a comment still has to land on something the engine can bind.
		/// </summary>
		internal static CodeStatementDto? FindStatement(IReadOnlyList<CodeStatementDto> statements, int line, int? column) {
			CodeStatementDto? covering = null;
			foreach (var statement in statements) {
				if (statement.IsHidden || line < statement.StartLine || line > statement.EndLine)
					continue;
				if (column is int requested && statement.StartLine == statement.EndLine &&
					(requested < statement.StartColumn - 1 || requested > statement.EndColumn))
					continue;
				if (covering is null || statement.StartColumn < covering.StartColumn)
					covering = statement;
			}
			if (covering is not null)
				return covering;

			CodeStatementDto? nearest = null;
			foreach (var statement in statements) {
				if (statement.IsHidden)
					continue;
				if (nearest is null || IsCloser(statement, nearest, line))
					nearest = statement;
			}
			return nearest;
		}

		// Distance first; on a tie the statement after the requested line wins, matching what a user expects
		// from clicking just above a statement.
		static bool IsCloser(CodeStatementDto candidate, CodeStatementDto current, int line) {
			var candidateDistance = Distance(candidate.StartLine, line);
			var currentDistance = Distance(current.StartLine, line);
			if (candidateDistance != currentDistance)
				return candidateDistance < currentDistance;
			return candidate.StartLine > current.StartLine;
		}

		static int Distance(int startLine, int line) => startLine >= line ? startLine - line : line - startLine;

		IReadOnlyList<CodeStatementDto> GetCodeStatements(string nodeId, CancellationToken cancellationToken) {
			RefreshStatementCache();
			var key = $"{nodeId}:{stateId}";
			if (codeStatementsByNode.TryGetValue(key, out var cached))
				return cached;
			var node = GetNode(nodeId);
			var statements = DecompileCSharp(node, null, cancellationToken).CodeStatements ?? Array.Empty<CodeStatementDto>();
			codeStatementsByNode[key] = statements;
			return statements;
		}

		internal ResolvedIlLocation? ResolveIlLocation(string modulePath, int metadataToken, int ilOffset, CancellationToken cancellationToken) =>
			symbols.ResolveIlLocation(this, modulePath, metadataToken, ilOffset, cancellationToken);

		internal MethodIlInfoResponse? GetMethodIlInfo(string modulePath, int metadataToken, CancellationToken cancellationToken) =>
			symbols.GetMethodIlInfo(this, modulePath, metadataToken, cancellationToken);

		internal IReadOnlyList<MethodIlInfoResponse> FindMethods(string name, CancellationToken cancellationToken) =>
			symbols.FindMethods(this, name, cancellationToken);

		/// <summary>The module node id for a member, or null when the module is only loaded, not opened.</summary>
		internal string? TryGetMemberNodeId(ModuleEntry module, IMDTokenProvider member) =>
			module.IsExternal ? null : GetMemberNode(member, module).Id;

		/// <summary>
		/// Resolves the identity a persisted bookmark was saved with — module path plus metadata token —
		/// back to a node. The member is materialised on demand, so a bookmark stays navigable after a
		/// restart even though node ids are only unique within one workspace.
		/// </summary>
		internal FindMemberResponse FindMember(string modulePath, int metadataToken) =>
			string.IsNullOrEmpty(modulePath)
				? new FindMemberResponse(null, null, null)
				: FindMember(FindModuleEntry(modulePath), metadataToken);

		/// <summary>
		/// The same lookup for an identity that may name a module the workspace does not hold yet — the
		/// target of a reference in decompiled text. The file is opened on demand, which is what makes
		/// such a reference followable at all; it adds a root, so a caller that got a node back has to ask
		/// for the roots again.
		/// </summary>
		internal async Task<FindMemberResponse> FindMemberAsync(string modulePath, int metadataToken, CancellationToken cancellationToken) {
			if (metadataToken == 0 || string.IsNullOrEmpty(modulePath))
				return new FindMemberResponse(null, null, null);
			return FindMember(await EnsureModuleOpenAsync(modulePath, cancellationToken).ConfigureAwait(false), metadataToken);
		}

		/// <summary>
		/// The entry for a module path, opened into the workspace when it is not one of them yet. A file
		/// that is missing, or that is not a managed module, yields null rather than an entry — a
		/// reference into something this machine does not have is a reference with nowhere to go.
		/// </summary>
		async Task<ModuleEntry?> EnsureModuleOpenAsync(string modulePath, CancellationToken cancellationToken) {
			if (FindModuleEntry(modulePath) is { } open)
				return open;
			if (!File.Exists(modulePath))
				return null;
			var added = await LoadModulesAsync([modulePath], cancellationToken).ConfigureAwait(false);
			return added.OfType<ModuleEntry>().FirstOrDefault();
		}

		FindMemberResponse FindMember(ModuleEntry? module, int metadataToken) {
			if (metadataToken == 0 || module is null || module.IsExternal)
				return new FindMemberResponse(null, null, null);
			IMDTokenProvider? member;
			try {
				member = module.Module.ResolveToken(unchecked((uint)metadataToken));
			}
			catch (Exception) {
				// A token that no longer resolves is a bookmark whose assembly changed underneath it.
				return new FindMemberResponse(null, null, null);
			}
			// Only members the tree can show have a document to navigate to.
			if (member is not (TypeDef or MethodDef or FieldDef or PropertyDef or EventDef))
				return new FindMemberResponse(null, null, null);
			var dto = ToDto(GetMemberNode(member, module));
			return new FindMemberResponse(dto.Id, dto.Label, dto.Description);
		}

		internal ModuleEntry? FindModuleEntry(string path) {
			foreach (var entry in modules.Values) {
				if (Path.GetFullPath(entry.Path).Equals(Path.GetFullPath(path), StringComparison.Ordinal))
					return entry;
			}
			return null;
		}

		internal PeOnlyModuleEntry? FindPeModuleEntry(string path) {
			foreach (var entry in peModules.Values) {
				if (Path.GetFullPath(entry.Path).Equals(Path.GetFullPath(path), StringComparison.Ordinal))
					return entry;
			}
			return null;
		}

		internal ElfFileEntry? FindElfEntry(string path) {
			foreach (var entry in elfFiles.Values) {
				if (Path.GetFullPath(entry.Path).Equals(Path.GetFullPath(path), StringComparison.Ordinal))
					return entry;
			}
			return null;
		}

		internal UnknownFileEntry? FindUnknownEntry(string path) {
			foreach (var entry in unknownFiles.Values) {
				if (Path.GetFullPath(entry.Path).Equals(Path.GetFullPath(path), StringComparison.Ordinal))
					return entry;
			}
			return null;
		}

		internal IEnumerable<ModuleEntry> OpenModules => modules.Values;

		internal string SymbolScope => stateId;

		public async Task<T> RunAsync<T>(Func<Workspace, T> action, CancellationToken cancellationToken) {
			await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
			try {
				ObjectDisposedException.ThrowIf(disposed, this);
				return action(this);
			}
			finally {
				gate.Release();
			}
		}

		public async Task<T> RunAsync<T>(Func<Workspace, Task<T>> action, CancellationToken cancellationToken) {
			await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
			try {
				ObjectDisposedException.ThrowIf(disposed, this);
				return await action(this).ConfigureAwait(false);
			}
			finally {
				gate.Release();
			}
		}

		public void Dispose() {
			if (disposed)
				return;
			disposed = true;
			foreach (var module in modules.Values)
				module.Module.Dispose();
			modules.Clear();
			foreach (var peModule in peModules.Values)
				peModule.PEImage.Dispose();
			peModules.Clear();
			// An ELF image holds nothing but the headers that were read out of the file, so there is
			// nothing to dispose of here.
			elfFiles.Clear();
			unknownFiles.Clear();
			foreach (var module in referenceModules.Values)
				module.Module.Dispose();
			referenceModules.Clear();
			foreach (var resolver in referenceResolvers.Values)
				resolver?.Dispose();
			referenceResolvers.Clear();
			referencePaths.Clear();
			namespaceIndexes.Clear();
			typeIndexes.Clear();
			nodes.Clear();
			nodeIdsByKey.Clear();
			codeStatementsByNode.Clear();
			transactions.Clear();
			undoHistory.Clear();
			redoHistory.Clear();
			gate.Dispose();
		}

		internal sealed class CSharpDecompilerSession : IDisposable {
			readonly ICSharpCode.Decompiler.Metadata.PEFile? snapshotFile;
			readonly MemoryStream? snapshotStream;

			public CSharpDecompilerSession(
				CSharpDecompiler decompiler,
				ICSharpCode.Decompiler.Metadata.PEFile? snapshotFile = null,
				MemoryStream? snapshotStream = null) {
				Decompiler = decompiler;
				this.snapshotFile = snapshotFile;
				this.snapshotStream = snapshotStream;
			}

			public CSharpDecompiler Decompiler { get; }

			public void Dispose() {
				snapshotFile?.Dispose();
				snapshotStream?.Dispose();
			}
		}

		sealed class DecompiledSourceProvider(
			CSharpDecompiler decompiler,
			DecompilerSettings settings,
			CancellationToken cancellationToken) {
			public IReadOnlyList<ILSourceStatement> GetStatements(MethodDef method) {
				if (!method.HasBody)
					return Array.Empty<ILSourceStatement>();
				cancellationToken.ThrowIfCancellationRequested();
				var syntaxTree = decompiler.Decompile([ToEntityHandle(method)]);
				var output = new SpanTextOutput(_ => null);
				syntaxTree.AcceptVisitor(new CSharpOutputVisitor(new TextTokenWriter(output, settings), settings.CSharpFormattingOptions));
				var source = output.ToString();
				var methodToken = method.MDToken.Raw;
				var statements = decompiler.CreateSequencePoints(syntaxTree)
					.Where(pair => Workspace.GetBodyMethodToken(pair.Key) == methodToken)
					.SelectMany(pair => pair.Value)
					.Where(point => !point.IsHidden && point.EndOffset > point.Offset)
					.Select(point => new ILSourceStatement(point.Offset, point.EndOffset, ExtractSource(source, point.StartLine, point.StartColumn, point.EndLine, point.EndColumn)))
					.Where(statement => !string.IsNullOrWhiteSpace(statement.Text))
					.Distinct()
					.OrderBy(statement => statement.Offset)
					.ThenBy(statement => statement.EndOffset)
					.ToArray();
				if (statements.Length != 0)
					return statements;

				var fallback = source.Trim();
				return fallback.Length == 0
					? Array.Empty<ILSourceStatement>()
					: [new ILSourceStatement(0, int.MaxValue, fallback)];
			}

			static string ExtractSource(string source, int startLine, int startColumn, int endLine, int endColumn) {
				var lines = source.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n');
				if (startLine <= 0 || endLine < startLine || startLine > lines.Length)
					return string.Empty;
				endLine = Math.Min(endLine, lines.Length);
				var firstLine = startLine - 1;
				var lastLine = endLine - 1;
				var firstColumn = Math.Clamp(startColumn - 1, 0, lines[firstLine].Length);
				var lastColumn = Math.Clamp(endColumn - 1, 0, lines[lastLine].Length);
				if (firstLine == lastLine)
					return lines[firstLine][firstColumn..Math.Max(firstColumn, lastColumn)].Trim();

				var result = new List<string> { lines[firstLine][firstColumn..] };
				for (var line = firstLine + 1; line < lastLine; line++)
					result.Add(lines[line]);
				result.Add(lines[lastLine][..lastColumn]);
				return string.Join('\n', result).Trim();
			}
		}

		internal sealed class ModuleEntry(string path, ModuleDefMD module) : IModuleEntry {
			public string Id { get; set; } = string.Empty;
			public string Path { get; } = path;
			public ModuleDefMD Module { get; } = module;
			public long FileLength { get; } = new FileInfo(path).Length;
			public bool IsModified { get; set; }

			/// <summary>
			/// True for a module the debuggee loaded but the user never opened. It has no tree node, so
			/// the client can show a frame's file and line but cannot navigate to it.
			/// </summary>
			public bool IsExternal { get; init; }

			/// <summary>
			/// The byte patches the hex editor wrote, in the order they were applied. They are kept apart
			/// from the dnlib model, which knows nothing of them: the file image a reader sees is the file
			/// plus these, and a save replays them onto what dnlib writes.
			/// </summary>
			public List<HexPatch> HexPatches { get; } = [];

			/// <summary>
			/// Records a patch and hands back the undo. The offset is the one the reader saw, measured in
			/// the file as it is on disk; what the patch is measured from is kept too, so a module that is
			/// written back out can be patched in the place the same member ended up.
			/// </summary>
			public Action ApplyHexPatch(string nodeId, object value, long offset, byte[] data) {
				var patch = new HexPatch(nodeId, offset, data, DescribePatchTarget(value, offset));
				HexPatches.Add(patch);
				return () => HexPatches.Remove(patch);
			}

			/// <summary>
			/// Where a patch belongs, said in terms of the member it was aimed at rather than a file offset:
			/// the offset itself only means anything against the layout the module was read with.
			/// </summary>
			static HexPatchTarget DescribePatchTarget(object value, long offset) => value switch {
				MethodDef method when HexTargets.TryGetMethodBody(method, out var bodyOffset, out _, out _, out _) =>
					new HexPatchTarget.MethodBody(method.MDToken.Raw, offset - bodyOffset),
				FieldDef field when HexTargets.GetMemberFileOffset(field) is { } fieldOffset =>
					new HexPatchTarget.FieldInitialValue(field.MDToken.Raw, offset - fieldOffset),
				EmbeddedResource resource =>
					new HexPatchTarget.Resource(resource.Name, offset - (long)resource.CreateReader().StartOffset),
				_ => HexPatchTarget.Raw,
			};

			/// <summary>Copies the patches that fall inside the range into <paramref name="buffer"/>.</summary>
			public void OverlayHexPatches(long offset, byte[] buffer) {
				foreach (var patch in HexPatches) {
					var start = Math.Max(patch.Offset, offset);
					var end = Math.Min(patch.Offset + patch.After.Length, offset + buffer.Length);
					for (var i = start; i < end; i++)
						buffer[i - offset] = patch.After[i - patch.Offset];
				}
			}

			/// <summary>
			/// Where each patch belongs in a module that has just been serialized. The offsets are resolved
			/// against <paramref name="serialized"/> rather than reused: dnlib lays the file out from
			/// scratch, so a body sits at a different offset in its output than it did in the file it read,
			/// and the member the patch was aimed at is what still identifies it. A method the user wrote
			/// over twice leaves two patches on one body, which is an ordinary undo step here, so they are
			/// returned in the order they were applied.
			/// </summary>
			public IReadOnlyList<(long Offset, byte[] Data)> ResolveHexPatchOffsets(ModuleDefMD serialized) {
				var resolved = new List<(long, byte[])>(HexPatches.Count);
				foreach (var patch in HexPatches) {
					long? offset = patch.Target switch {
						HexPatchTarget.MethodBody target when serialized.ResolveToken(target.Token) is MethodDef method && HexTargets.TryGetMethodBody(method, out var bodyOffset, out _, out _, out _) =>
							bodyOffset + target.Delta,
						HexPatchTarget.FieldInitialValue target when serialized.ResolveToken(target.Token) is FieldDef field && HexTargets.GetMemberFileOffset(field) is { } fieldOffset =>
							fieldOffset + target.Delta,
						HexPatchTarget.Resource target when serialized.Resources.FirstOrDefault(r => r.Name == target.Name) is EmbeddedResource resource =>
							(long)resource.CreateReader().StartOffset + target.Delta,
						HexPatchTarget.RawTarget => patch.Offset,
						_ => null,
					};
					if (offset is null)
						throw new RpcException(ErrorCodes.SaveFailed,
							"What a hex patch was written over is no longer in the module, so it cannot be applied.");
					resolved.Add((offset.Value, patch.After));
				}
				return resolved;
			}
		}

		/// <summary>
		/// One in-place byte patch: the bytes written at <paramref name="Offset"/> in the file the reader
		/// saw, and what that offset is measured from. It never changes the file's length.
		/// </summary>
		internal sealed record HexPatch(string NodeId, long Offset, byte[] After, HexPatchTarget Target);

		/// <summary>
		/// What a hex patch is aimed at. dnSpy keeps a hex-edited file in a document of its own, so its
		/// patches never have to survive a rewrite of the module that produced it; here the two share a
		/// document, and keeping the member alongside the offset is what lets a patch be written to the
		/// right place in a file dnlib laid out afresh.
		/// </summary>
		internal abstract record HexPatchTarget {
			public static readonly HexPatchTarget Raw = new RawTarget();

			/// <summary>A patch on nothing in particular, whose offset only means anything against the layout it was read with.</summary>
			public sealed record RawTarget : HexPatchTarget;

			/// <summary>Relative to the start of a method's body, header included.</summary>
			public sealed record MethodBody(uint Token, long Delta) : HexPatchTarget;

			/// <summary>Relative to the start of a field's initial value.</summary>
			public sealed record FieldInitialValue(uint Token, long Delta) : HexPatchTarget;

			/// <summary>Relative to the start of an embedded resource's data.</summary>
			public sealed record Resource(string Name, long Delta) : HexPatchTarget;
		}

		/// <summary>
		sealed record NamespaceValue(string Name, IReadOnlyList<TypeDef> Types);
		sealed record NamespaceIndex(string StateId, IReadOnlyDictionary<string, IReadOnlyList<TypeDef>> Groups);
		/// <summary>A module's types by full name, for resolving a base type reference the workspace holds.</summary>
		sealed record TypeIndex(string StateId, IReadOnlyDictionary<string, TypeDef> Types);
		/// <summary>A row in the "Base Type and Interfaces" folder. <paramref name="IsBaseType"/> is what
		/// dnSpy keeps to pick the icon when the reference cannot be resolved to a type definition: the
		/// base type shows the class image and an interface shows the interface one.</summary>
		sealed record BaseTypeValue(ITypeDefOrRef TypeDefOrRef, bool IsBaseType);
	
		sealed record MetadataReference(DecompilerMetadataFile Metadata, System.Reflection.Metadata.Handle Handle);
		/// <summary>
		/// Where a piece of decompiled text points: a node of this workspace, or — for a reference into a
		/// module the workspace does not hold — the file it lives in and the token it has there, which the
		/// client follows on demand.
		/// </summary>
		internal readonly record struct SpanTarget(string? NodeId, string? ModulePath, int? MetadataToken);
		readonly record struct ILSourceStatement(int Offset, int EndOffset, string Text);
		sealed class NodeEntry(string id, string key, NodeKind kind, object value, object module) {
			public string Id { get; } = id;
			public string Key { get; } = key;
			public NodeKind Kind { get; } = kind;
			public object Value { get; set; } = value;
			/// <summary>The module this node belongs to — a ModuleEntry, or one of the entries for the files
			/// that are not managed ones (PeOnlyModuleEntry, ElfFileEntry, UnknownFileEntry).</summary>
			public object Module { get; } = module;
			public ModuleEntry? AsModuleEntry => Module as ModuleEntry;
			public PeOnlyModuleEntry? AsPeOnlyModuleEntry => Module as PeOnlyModuleEntry;
		}

		sealed class EditTransaction(int baseVersion) {
			public string Id { get; } = Guid.NewGuid().ToString("N");
			public int BaseVersion { get; } = baseVersion;
			public List<EditOperation> Operations { get; } = [];

			public void Add(string nodeId, IModuleEntry module, Func<Action> apply) => Operations.Add(new EditOperation(nodeId, module, apply));
		}

		/// <summary>One step of an edit. <paramref name="ChangesRoots"/> marks one that adds or takes away a root —
		/// a removal recorded in the history — after which the client reads the module list again.</summary>
		sealed record EditOperation(string NodeId, IModuleEntry Module, Func<Action> Apply, bool ChangesRoots = false);
		sealed record EditHistoryEntry(IReadOnlyList<EditOperation> Operations, IReadOnlyList<Action> UndoActions, string BeforeStateId, string AfterStateId);

		internal sealed class SpanTextOutput(Func<object, SpanTarget?> resolveTarget) : ITextOutput {
			readonly StringBuilder builder = new();
			readonly List<TextSpanDto> spans = [];
			int indentation;
			int line = 1;
			int column = 1;
			bool needsIndentation = true;

			public string IndentationString { get; set; } = "\t";
			public IReadOnlyList<TextSpanDto> Spans => spans;
			public int Position => builder.Length;

			/// <summary>Where the next character will land. ILSpy reads this to label the syntax tree.</summary>
			public TextLocation Location => new(line, column);

			public void Indent() => indentation++;
			public void Unindent() => indentation = Math.Max(0, indentation - 1);
			public void Write(char ch) => Write(ch.ToString());
			public void Write(string text) {
				EnsureIndentation();
				Append(text);
			}
			public void WriteLine() {
				Append(Environment.NewLine);
				needsIndentation = true;
			}
			public void WriteReference(OpCodeInfo opCode, bool omitSuffix = false) => Write(omitSuffix ? opCode.Name ?? string.Empty : opCode.ToString() ?? string.Empty);
			public void WriteReference(DecompilerMetadataFile metadata, System.Reflection.Metadata.Handle handle, string text, string protocol = "decompile", bool isDefinition = false) =>
				WriteReferenceCore(new MetadataReference(metadata, handle), text, isDefinition);
			public void WriteReference(DecompilerIType type, string text, bool isDefinition = false) => WriteReferenceCore(type, text, isDefinition);
			public void WriteReference(DecompilerIMember member, string text, bool isDefinition = false) => WriteReferenceCore(member, text, isDefinition);
			public void WriteLocalReference(string text, object reference, bool isDefinition = false, bool isHoverOnly = false) => Write(text);
			public void MarkFoldStart(string collapsedText = "...", bool defaultCollapsed = false, bool isDefinition = false) { }
			public void MarkDefinitionStart() { }
			public void MarkFoldEnd() { }

			void WriteReferenceCore(object reference, string text, bool isDefinition) {
				EnsureIndentation();
				var start = builder.Length;
				Append(text);
				// A reference the resolver could not place has no span: the text still renders, but a click
				// on it has nowhere to go — dnSpy's own output writer skips the reference the same way.
				if (text.Length == 0 || resolveTarget(reference) is not { } target)
					return;
				// A definition is where dnSpy's token bookmark sits, and a bookmark is written down as module and
				// token — so a definition keeps both beside its node id. A reference into the workspace only
				// needs the node; the module and token are what a reference outside it is followed by.
				if (!isDefinition && target.NodeId is not null)
					target = target with { ModulePath = null, MetadataToken = null };
				spans.Add(new TextSpanDto(start, text.Length, isDefinition ? "definition" : "reference", target.NodeId, target.ModulePath, target.MetadataToken));
			}

			// Every append goes through here so the line/column the syntax tree is labelled with stays in step
			// with the text the editor will show.
			void Append(string text) {
				for (var i = 0; i < text.Length; i++) {
					var ch = text[i];
					if (ch == '\r') {
						if (i + 1 < text.Length && text[i + 1] == '\n')
							i++;
					}
					else if (ch != '\n') {
						column++;
						continue;
					}
					line++;
					column = 1;
				}
				builder.Append(text);
			}

			void EnsureIndentation() {
				if (!needsIndentation)
					return;
				for (var i = 0; i < indentation; i++)
					Append(IndentationString);
				needsIndentation = false;
			}

			public override string ToString() => builder.ToString();
		}

		// ILSpy only writes line/column information into the syntax tree while a writer that reports its own
		// position (ILocatable) prints it; CreateSequencePoints has nothing to work with otherwise. The writer
		// that turns identifiers into the reference spans the editor navigates with — TextTokenWriter — is not
		// ILocatable, so this one reports the position of the output buffer instead of tracking its own.
		internal sealed class LocationTokenWriter(SpanTextOutput output, DecompilerSettings settings) : TextTokenWriter(output, settings), ILocatable {
			public TextLocation Location => output.Location;

			public int Length => output.Position;
		}

		enum NodeKind {
			Assembly,
			Module,
			// The PE structure node under a module, one of dnSpy's AsmEditor hex nodes.
			PE,
			// One field of that PE structure — a header, a section, a metadata stream.
			PeStructure,
			// The ELF node under an ELF document and one field of it — the file header, a program header or
			// a section header. dnSpy has no ELF reader, so these follow the PE node's shape instead.
			Elf,
			ElfStructure,
			// A root for a file that is a PE image but not a managed assembly, one for an ELF image, and one
			// for a file that is neither. All are labelled with the file name, as dnSpy's PE and unknown
			// document nodes are.
			PEDocument,
			ElfDocument,
			UnknownDocument,
			Namespace,
			TypeReferencesGroup,
			ReferencesGroup,
			ResourcesGroup,
			AssemblyReference,
			ModuleReference,
			Resource,
			ResourceEntry,
			Type,
			// The two folders dnSpy hangs off every type — its base type and interfaces, and the types
			// derived from it — and the rows inside them.
			BaseTypeFolder,
			BaseType,
			DerivedTypesFolder,
			DerivedType,
			Method,
			Field,
			Property,
			Event,
			// Type References folder contents: referenced types, their generic instances, and the members
			// the module calls — the five folders under a type, and the rows they hold.
			TypeReference,
			TypeSpecsFolder,
			MethodReferencesFolder,
			PropertyReferencesFolder,
			EventReferencesFolder,
			FieldReferencesFolder,
			MethodReference,
			PropertyReference,
			EventReference,
			FieldReference,
		}

		/// <summary>The IL view's text and what dnSpy's IL disassembler records beside it.</summary>
		internal sealed record ILDocument(string Text, IReadOnlyList<TextSpanDto> Spans, IReadOnlyList<CodeStatementDto> Statements);

		/// <summary>
		/// The IL view. Beside the text it records what dnSpy's disassembler does: a statement per instruction —
		/// the IL view's sequence points, which a bookmark, a hex lookup or a search hit at the caret resolves
		/// to — a definition span over the name of every member it declares, which is where a token bookmark
		/// sits, and a reference span over the member an instruction names, which is what the caret is put on
		/// when the analyzer shows a use in a method. Every line goes through <see cref="WriteLine"/>, so the line
		/// a statement is recorded at is the one its text lands on.
		/// </summary>
		sealed class ILFormatter {
			readonly StringBuilder builder = new();
			readonly List<TextSpanDto> spans = [];
			readonly List<CodeStatementDto> statements = [];
			readonly string? modulePath;
			readonly Workspace workspace;
			readonly Func<IMemberDef, SpanTarget?>? resolveDefinition;
			readonly Func<MethodDef, IReadOnlyList<ILSourceStatement>>? sourceProvider;
			// What the instructions name is found the way the analyzer finds it, among what is loaded: drawing a
			// method does not load the assemblies its calls go to.
			AnalyzerHost? referenceHost;
			int line = 1;

			ILFormatter(string? modulePath, Workspace workspace, Func<IMemberDef, SpanTarget?>? resolveDefinition, Func<MethodDef, IReadOnlyList<ILSourceStatement>>? sourceProvider) {
				this.modulePath = modulePath;
				this.workspace = workspace;
				this.resolveDefinition = resolveDefinition;
				this.sourceProvider = sourceProvider;
			}

			public static ILDocument Format(NodeEntry node, Workspace workspace, Func<IMemberDef, SpanTarget?>? resolveDefinition = null, Func<MethodDef, IReadOnlyList<ILSourceStatement>>? sourceProvider = null) {
				var formatter = new ILFormatter(node.AsModuleEntry?.Path, workspace, resolveDefinition, sourceProvider);
				formatter.FormatNode(node);
				return new ILDocument(formatter.builder.ToString(), formatter.spans, formatter.statements);
			}

			void FormatNode(NodeEntry node) {
				// A PE node and its structures are headers of the image, not code, so the node's own name is
				// all there is to say about them. The ELF structures are the same thing.
				if (node.Kind is NodeKind.PE or NodeKind.PeStructure or NodeKind.Elf or NodeKind.ElfStructure) {
					WriteLine($"// {workspace.GetLabel(node)}");
					return;
				}
				switch (node.Value) {
					case ModuleDef module:
						WriteLine($"// {module.Assembly?.FullName ?? module.Name.String}");
						WriteLine($".module {module.Name}");
						foreach (var type in module.Types.Where(t => !t.IsGlobalModuleType))
							FormatTypeHeader(type);
						break;
					case NamespaceValue ns:
						WriteLine($"// namespace {ns.Name}");
						foreach (var type in ns.Types)
							FormatType(type);
						break;
					case TypeDef type:
						FormatType(type);
						break;
					case MethodDef method:
						FormatMethod(method);
						break;
					case FieldDef field:
						FormatField(field, string.Empty);
						break;
					case PropertyDef property:
						FormatProperty(property);
						break;
					case EventDef @event:
						FormatEvent(@event);
						break;
					case AssemblyRef reference:
						WriteLine($".assembly extern {reference.Name}");
						WriteLine("{");
						WriteLine($"  .ver {reference.Version}");
						WriteLine("}");
						break;
					case Resource resource:
						WriteLine($".mresource {resource.Attributes} '{resource.Name}'");
						break;
					// A PE-only or unreadable file has no metadata, so it has no IL either. Its own name is
					// what the C# document shows as well, and it beats the generic error below.
					case IModuleEntry entry:
						WriteLine($"// {Path.GetFileName(entry.Path)}");
						break;
					default:
						throw new RpcException(ErrorCodes.UnsupportedDocument, "This tree node has no IL representation.");
				}
			}

			void WriteLine(string text) {
				builder.AppendLine(text);
				// A name is written as it is in the metadata, and nothing stops a name from holding a line break.
				line += 1 + text.Count(ch => ch == '\n');
			}

			/// <summary>A line declaring a member: the definition span covers the name, as dnSpy's disassembler writes it.</summary>
			void WriteDefinitionLine(string prefix, string name, string suffix, IMemberDef member) {
				if (name.Length > 0 && resolveDefinition?.Invoke(member) is { } target)
					spans.Add(new TextSpanDto(builder.Length + prefix.Length, name.Length, "definition", target.NodeId, target.ModulePath, target.MetadataToken));
				WriteLine(prefix + name + suffix);
			}

			void FormatTypeHeader(TypeDef type) => WriteDefinitionLine($".class {type.Attributes} ", type.FullName, string.Empty, type);

			void FormatType(TypeDef type) {
				FormatTypeHeader(type);
				WriteLine("{");
				foreach (var field in type.Fields)
					FormatField(field, "  ");
				foreach (var method in type.Methods) {
					WriteLine(string.Empty);
					FormatMethod(method, "  ");
				}
				WriteLine("}");
			}

			void FormatField(FieldDef field, string indent) =>
				WriteDefinitionLine($"{indent}.field {field.Attributes} {field.FieldType.FullName} ", field.Name, string.Empty, field);

			void FormatProperty(PropertyDef property) {
				WriteDefinitionLine($".property {property.PropertySig?.RetType.FullName ?? "<unknown>"} ", property.Name, string.Empty, property);
				foreach (var method in new[] { property.GetMethod, property.SetMethod }.Concat(property.OtherMethods).OfType<MethodDef>().Distinct()) {
					WriteLine(string.Empty);
					FormatMethod(method);
				}
			}

			void FormatEvent(EventDef @event) {
				WriteDefinitionLine($".event {@event.EventType.FullName} ", @event.Name, string.Empty, @event);
				foreach (var method in new[] { @event.AddMethod, @event.RemoveMethod, @event.InvokeMethod }.Concat(@event.OtherMethods).OfType<MethodDef>().Distinct()) {
					WriteLine(string.Empty);
					FormatMethod(method);
				}
			}

			void FormatMethod(MethodDef method, string indent = "") {
				WriteDefinitionLine($"{indent}.method {method.Attributes} {method.ReturnType.FullName} ", method.Name, FormatParameterList(method), method);
				WriteLine($"{indent}{{");
				if (method.HasBody) {
					WriteLine($"{indent}  .maxstack {method.Body.MaxStack}");
					if (method.Body.HasVariables) {
						WriteLine($"{indent}  .locals {string.Join(", ", method.Body.Variables.Select(v => $"[{v.Index}] {v.Type.FullName}"))}");
					}
					var sources = sourceProvider?.Invoke(method) ?? Array.Empty<ILSourceStatement>();
					var sourceIndex = 0;
					var instructions = method.Body.Instructions;
					var token = unchecked((int)method.MDToken.Raw);
					var description = method.FullName;
					var prefix = $"{indent}  ";
					for (var index = 0; index < instructions.Count; index++) {
						var instruction = instructions[index];
						while (sourceIndex < sources.Count && sources[sourceIndex].Offset <= instruction.Offset) {
							if (instruction.Offset < sources[sourceIndex].EndOffset)
								AppendSourceComment(prefix, sources[sourceIndex].Text);
							sourceIndex++;
						}
						var head = $"{prefix}IL_{instruction.Offset:X4}: {instruction.OpCode.Name,-12} ";
						var operand = FormatOperand(instruction.Operand);
						var text = (head + operand).TrimEnd();
						AddOperandReference(builder.Length + head.Length, operand, instruction.Operand);
						// dnSpy's IL view has a statement per instruction: the line covers the instruction's bytes
						// and nothing else, from its offset to the next one's.
						if (modulePath is not null) {
							var end = index + 1 < instructions.Count ? instructions[index + 1].Offset : instruction.Offset + (uint)instruction.GetSize();
							statements.Add(new CodeStatementDto(
								line,
								line,
								prefix.Length + 1,
								text.Length + 1,
								unchecked((int)instruction.Offset),
								unchecked((int)end),
								unchecked((int)instruction.Offset),
								modulePath,
								token,
								token,
								description,
								false));
						}
						WriteLine(text);
					}
				}
				WriteLine($"{indent}}}");
			}

			/// <summary>
			/// A reference span over what an instruction names: a member's own name in its full name, a type's
			/// whole name — the stretch dnSpy's disassembler writes as a reference to it. An operand that names
			/// nothing the workspace can place gets none.
			/// </summary>
			void AddOperandReference(int start, string text, object? operand) {
				if (operand is not IMDTokenProvider || text.Length == 0)
					return;
				referenceHost ??= new AnalyzerHost(workspace, null, loadOnDemand: false);
				if (workspace.ILReferenceTarget(referenceHost, operand) is not { } target)
					return;
				var (offset, length) = (0, text.Length);
				if (operand is IMemberRef member && (member.IsMethod || member.IsField)) {
					var name = member.Name.String;
					var at = text.IndexOf("::" + name, StringComparison.Ordinal);
					if (name.Length > 0 && at >= 0)
						(offset, length) = (at + 2, name.Length);
				}
				spans.Add(new TextSpanDto(start + offset, length, "reference", target.NodeId, target.ModulePath, target.MetadataToken));
			}

			void AppendSourceComment(string indent, string source) {
				WriteLine(string.Empty);
				foreach (var sourceLine in source.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n'))
					WriteLine($"{indent}// {sourceLine.TrimEnd()}");
				WriteLine(string.Empty);
			}

			static string FormatOperand(object? operand) => operand switch {
				null => string.Empty,
				string text => QuoteString(text),
				Instruction instruction => $"IL_{instruction.Offset:X4}",
				IList<Instruction> instructions => string.Join(", ", instructions.Select(i => $"IL_{i.Offset:X4}")),
				IMemberRef member => member.FullName,
				IType type => type.FullName,
				Local local => $"V_{local.Index}",
				Parameter parameter => parameter.Name ?? $"A_{parameter.Index}",
				float value => value.ToString("R", CultureInfo.InvariantCulture),
				double value => value.ToString("R", CultureInfo.InvariantCulture),
				IFormattable value => value.ToString(null, CultureInfo.InvariantCulture),
				_ => operand.ToString() ?? string.Empty,
			};

			/// <summary>A string operand in quotes, with every control character escaped — an instruction is one line,
			/// whatever the string it loads.</summary>
			static string QuoteString(string text) {
				var quoted = new StringBuilder(text.Length + 2).Append('"');
				foreach (var ch in text) {
					switch (ch) {
						case '\\': quoted.Append(@"\\"); break;
						case '"': quoted.Append("\\\""); break;
						case '\n': quoted.Append(@"\n"); break;
						case '\r': quoted.Append(@"\r"); break;
						case '\t': quoted.Append(@"\t"); break;
						case '\0': quoted.Append(@"\0"); break;
						default:
							if (char.IsControl(ch) || ch is '\u0085' or '\u2028' or '\u2029')
								quoted.Append(@"\u").Append(((int)ch).ToString("X4", CultureInfo.InvariantCulture));
							else
								quoted.Append(ch);
							break;
					}
				}
				return quoted.Append('"').ToString();
			}
		}
	}

	/// <summary>
	/// Common interface for module entries (both managed and non-managed PE files).
	/// </summary>
	internal interface IModuleEntry {
		string Id { get; }
		string Path { get; }
		long FileLength { get; }
	}
}
