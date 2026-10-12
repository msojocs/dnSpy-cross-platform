using System.Diagnostics;
using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.Analyzer;

namespace dnSpy.Backend.Core;

public sealed partial class WorkspaceManager {
	public Task<AnalyzeNodesResponse> AnalyzeNodesAsync(AnalyzeNodesRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.AnalyzeNodes(request.NodeIds), cancellationToken);

	public Task<AnalyzeChildrenResponse> AnalyzeChildrenAsync(AnalyzeChildrenRequest request, CancellationToken cancellationToken) =>
		AnalyzeChildrenAsync(request, null, cancellationToken);

	/// <summary>
	/// What an analyzer row expands to. A search asked with a progress token hands what it finds to
	/// <paramref name="progress"/> as it goes, and the response then carries only the rest; the next slice
	/// waits for the notification to be written, so the client always gets the batches before the answer.
	/// </summary>
	public Task<AnalyzeChildrenResponse> AnalyzeChildrenAsync(AnalyzeChildrenRequest request, Func<AnalyzeProgressNotification, Task>? progress, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).AnalyzeChildrenAsync(request, new AnalyzerPacing(AnalyzerSliceBudget, AnalyzerProgressInterval, AnalyzerParallelism), progress, cancellationToken);

	/// <summary>How long one slice of a search holds the workspace gate. Short enough that a tree click queued
	/// behind a search over a framework assembly is answered without a noticeable wait.</summary>
	public TimeSpan AnalyzerSliceBudget { get; init; } = TimeSpan.FromMilliseconds(40);

	/// <summary>How often a running search sends what it found so far — the 100 ms dnSpy's AsyncNodeProvider
	/// gives the tree to take a batch in. A search done sooner than that sends everything in its answer.</summary>
	public TimeSpan AnalyzerProgressInterval { get; init; } = TimeSpan.FromMilliseconds(100);

	/// <summary>
	/// How many types a search looks at at once, each on a thread of its own, the way dnSpy's PLINQ query
	/// does. One by default: measured on 25 framework assemblies, sixteen threads took a search that does
	/// little but read bodies from 2.0 s to 1.8 s and one that lists 20,000 rows nowhere faster — dnlib's
	/// thread-safe readers take a lock per metadata table — while a document decompiled during the search
	/// took twice as long and the tree's own requests waited longer. The searches keep what they remember
	/// between types in <see cref="AnalyzerSearch.Accept"/>, so more than one gives the same rows in the same
	/// order; a test holds them to it.
	/// </summary>
	public int AnalyzerParallelism { get; init; } = 1;

	readonly record struct AnalyzerPacing(TimeSpan SliceBudget, TimeSpan ProgressInterval, int Parallelism);

	sealed partial class Workspace {
		// Counts the changes to the dnlib model — edits, their undo and redo, reloads, removed assemblies. A
		// search lets the gate go between slices, and one that finds the count moved on has been looking at
		// a model that is no longer there. The state id cannot say so: an undo hands the previous one back.
		long analyzerEpoch;

		void NoteModelChanged() => analyzerEpoch++;

		/// <summary>The analyzer rows of the nodes asked for — null for one that is not a member any more.</summary>
		public AnalyzeNodesResponse AnalyzeNodes(IReadOnlyList<string> nodeIds) {
			var rows = new List<AnalyzerNodeDto?>(nodeIds.Count);
			foreach (var nodeId in nodeIds) {
				AnalyzerNodeDto? row = null;
				if (nodes.TryGetValue(nodeId, out var node) && AnalyzableMember(node) is { } member)
					row = AnalyzerEntityDto(new AnalyzerHost(this, member.Module), member);
				rows.Add(row);
			}
			return new AnalyzeNodesResponse(rows);
		}

		/// <summary>
		/// What an analyzer row expands to. A member's own rows are read straight off it. A search is run a
		/// slice at a time — prepared, scanned and finished each under the gate, with the gate let go in
		/// between — so it neither touches dnlib's objects unguarded nor keeps the rest of the workspace waiting.
		/// </summary>
		public async Task<AnalyzeChildrenResponse> AnalyzeChildrenAsync(AnalyzeChildrenRequest request, AnalyzerPacing pacing, Func<AnalyzeProgressNotification, Task>? progress, CancellationToken cancellationToken) {
			if (request.Search is null)
				return await RunAsync(w => w.GetAnalyzerEntityChildren(request), cancellationToken).ConfigureAwait(false);
			var progressToken = progress is null ? null : request.ProgressToken;
			var maxResults = Math.Clamp(request.MaxResults, 1, 100_000);
			var (run, host) = await RunAsync(w => w.PrepareAnalyzerSearch(request, maxResults, pacing.Parallelism, cancellationToken), cancellationToken).ConfigureAwait(false);
			// The hits written as rows so far, and the rows sent ahead: a hit in a module the workspace has no
			// entry for makes no row, so the two counts part.
			var written = 0;
			var sent = 0;
			var sinceSent = Stopwatch.StartNew();
			while (!run.Completed) {
				var batch = await RunAsync(w => {
					w.CheckAnalyzerEpoch(run);
					run.RunSlice(pacing.SliceBudget, cancellationToken);
					if (progressToken is null || run.Count == written || sinceSent.Elapsed < pacing.ProgressInterval)
						return null;
					var rows = w.AnalyzerRows(host, run, written);
					written = run.Count;
					return rows;
				}, cancellationToken).ConfigureAwait(false);
				// Written with the gate let go: the tree has no reason to wait for the pipe.
				if (batch is { Count: > 0 }) {
					await progress!(new AnalyzeProgressNotification(progressToken!, sent, batch)).ConfigureAwait(false);
					sent += batch.Count;
					sinceSent.Restart();
				}
			}
			return await RunAsync(w => {
				w.CheckAnalyzerEpoch(run);
				run.Finish();
				return new AnalyzeChildrenResponse(w.AnalyzerRows(host, run, written), run.Truncated, sent);
			}, cancellationToken).ConfigureAwait(false);
		}

		/// <summary>The rows of a run's hits from <paramref name="from"/> on, up to the limit.</summary>
		List<AnalyzerNodeDto> AnalyzerRows(AnalyzerHost host, AnalyzerSearchRun run, int from) {
			var rows = new List<AnalyzerNodeDto>(run.Count - from);
			for (var index = from; index < run.Count; index++) {
				var hit = run[index];
				if (AnalyzerEntityDto(host, hit.Entity, hit.Source, hit.HidesParent) is { } row)
					rows.Add(row);
			}
			return rows;
		}

		AnalyzeChildrenResponse GetAnalyzerEntityChildren(AnalyzeChildrenRequest request) {
			var member = AnalyzableMember(GetNode(request.NodeId))
				?? throw new RpcException(ErrorCodes.InvalidParams, "Only types and members can be analyzed.");
			var host = new AnalyzerHost(this, member.Module);
			var memberNodeId = AnalyzerNodeId(member);
			var rows = new List<AnalyzerNodeDto>();
			foreach (var child in AnalyzerEntityChildren.Of(host, member, request.IsSetter)) {
				if (child.Accessor is { } accessor) {
					if (AnalyzerEntityDto(host, accessor) is { } row)
						rows.Add(child.Keyword is null
							? row with { IsSetter = child.IsSetter }
							: row with { Label = child.Keyword, LabelParts = [new TextPartDto(child.Keyword, TextColors.Keyword)], Accessor = child.Keyword, IsSetter = child.IsSetter });
					continue;
				}
				rows.Add(new AnalyzerNodeDto(
					"search",
					AnalyzerEntityChildren.Header(child.Search!),
					HasChildren: true,
					NodeId: memberNodeId,
					Icon: "search",
					Search: child.Search,
					IsSetter: child.IsSetter));
			}
			return new AnalyzeChildrenResponse(rows, false);
		}

		(AnalyzerSearchRun Run, AnalyzerHost Host) PrepareAnalyzerSearch(AnalyzeChildrenRequest request, int maxResults, int parallelism, CancellationToken cancellationToken) {
			var member = AnalyzableMember(GetNode(request.NodeId))
				?? throw new RpcException(ErrorCodes.InvalidParams, "Only types and members can be analyzed.");
			var host = new AnalyzerHost(this, member.Module);
			var search = AnalyzerEntityChildren.CreateSearch(host, member, request.Search!, request.IsSetter);
			return (new AnalyzerSearchRun(search, analyzerEpoch, maxResults, parallelism, cancellationToken), host);
		}

		void CheckAnalyzerEpoch(AnalyzerSearchRun run) {
			if (run.Epoch != analyzerEpoch)
				throw new RpcException(ErrorCodes.EditConflict, "The workspace changed while the analysis was running.");
		}

		/// <summary>
		/// The member a node stands for, as long as it is still part of its module. A base type row stands for
		/// the type it resolves to; the derived type rows already hold one. A member an edit deleted has lost
		/// its declaring type, and a deleted type its module, which is how dnSpy's analyzer tells them apart.
		/// </summary>
		IMemberDef? AnalyzableMember(NodeEntry node) {
			var member = node.Kind switch {
				NodeKind.Type or NodeKind.Method or NodeKind.Field or NodeKind.Property or NodeKind.Event or NodeKind.DerivedType => node.Value as IMemberDef,
				NodeKind.BaseType => ResolveTypeForHierarchy(((BaseTypeValue)node.Value).TypeDefOrRef),
				_ => null,
			};
			if (member?.Module is null)
				return null;
			if (member is not TypeDef && member.DeclaringType is null)
				return null;
			return member;
		}

		/// <summary>The tree node a member's analyzer row names: the one the tree itself lists the member as,
		/// whichever row the analysis started from.</summary>
		string? AnalyzerNodeId(IMemberDef member) =>
			AnalyzerModuleEntry(member.Module) is { } entry ? GetMemberNode(member, entry).Id : null;

		/// <summary>The entry a module was opened or loaded with: one of the workspace's own, or one reached
		/// through a reference.</summary>
		ModuleEntry? AnalyzerModuleEntry(ModuleDef? module) {
			if (module is null)
				return null;
			foreach (var entry in modules.Values) {
				if (ReferenceEquals(entry.Module, module))
					return entry;
			}
			foreach (var entry in referenceModules.Values) {
				if (ReferenceEquals(entry.Module, module))
					return entry;
			}
			return null;
		}

		/// <summary>Whether an entry is a document of the workspace rather than an assembly a reference loaded.</summary>
		bool IsOpenModule(ModuleEntry entry) =>
			entry.Id.Length > 0 && modules.TryGetValue(entry.Id, out var open) && ReferenceEquals(open, entry);

		AnalyzerNodeDto? AnalyzerEntityDto(AnalyzerHost host, object entity, AnalyzerSourceRef? source = null, bool hidesParent = false) {
			switch (entity) {
			case AssemblyDef assembly: {
				// Only an assembly the workspace holds has a row of its own in the tree to go to.
				var entry = AnalyzerModuleEntry(assembly.ManifestModule);
				var isExe = assembly.ManifestModule is { } manifest && (manifest.Characteristics & dnlib.PE.Characteristics.Dll) == 0;
				var label = AnalyzerLabel(host, assembly);
				return new AnalyzerNodeDto(
					"assembly",
					label.ToString(),
					HasChildren: false,
					NodeId: entry is not null && IsOpenModule(entry) ? entry.Id : null,
					Icon: isExe ? "assembly-exe" : "assembly",
					MetadataToken: unchecked((int)assembly.MDToken.Raw),
					FullName: assembly.FullName,
					LabelParts: label.ToParts());
			}
			case ModuleDef module: {
				var entry = AnalyzerModuleEntry(module);
				var nodeId = entry is not null && IsOpenModule(entry)
					? GetOrAddNode($"module:{entry.Path}", NodeKind.Module, entry.Module, entry).Id
					: null;
				var label = AnalyzerLabel(host, module);
				return new AnalyzerNodeDto(
					"module",
					label.ToString(),
					HasChildren: false,
					NodeId: nodeId,
					Icon: "module",
					MetadataToken: unchecked((int)module.MDToken.Raw),
					FullName: module.FullName,
					LabelParts: label.ToParts());
			}
			case IMemberDef member when member is TypeDef or MethodDef or FieldDef or PropertyDef or EventDef: {
				var entry = AnalyzerModuleEntry(member.Module);
				if (entry is null)
					return null;
				var kind = GetKind(member);
				var label = AnalyzerLabel(host, member);
				return new AnalyzerNodeDto(
					kind.ToString().ToLowerInvariant(),
					label.ToString(),
					HasChildren: true,
					NodeId: GetMemberNode(member, entry).Id,
					Icon: member is TypeDef type ? TypeIcon(type) : kind.ToString().ToLowerInvariant(),
					MetadataToken: unchecked((int)member.MDToken.Raw),
					HidesParent: hidesParent,
					FullName: member.FullName,
					IsPublic: IsPublicApi(member),
					Source: AnalyzerSourceDto(host, source),
					LabelParts: label.ToParts());
			}
			default:
				return null;
			}
		}

		TextPartsBuilder AnalyzerLabel(AnalyzerHost host, object entity) {
			var label = new TextPartsBuilder();
			AnalyzerLabelFormatter.Write(label, host, entity, TypeColor);
			return label;
		}

		AnalyzerSourceDto? AnalyzerSourceDto(AnalyzerHost host, AnalyzerSourceRef? source) {
			if (source is not { } sourceRef || AnalyzerModuleEntry(sourceRef.Method.Module) is not { } entry)
				return null;
			var targets = new List<AnalyzerTargetDto>();
			var target = sourceRef.Reference switch {
				IMemberDef def => def,
				IMethod method when method.IsMethod => host.ResolveMethodDef(method),
				IField field when field.IsField => host.ResolveFieldDef(field),
				ITypeDefOrRef type => host.ResolveTypeDef(type),
				_ => (IMemberDef?)null,
			};
			if (target is not null) {
				AddAnalyzerTarget(targets, target);
				// The decompiled text names a property or an event where the instruction calls its accessor.
				if (target is MethodDef accessor && FindOwningPropertyOrEvent(accessor) is IMemberDef owner)
					AddAnalyzerTarget(targets, owner);
			}
			return new AnalyzerSourceDto(
				GetMemberNode(sourceRef.Method, entry).Id,
				entry.Path,
				unchecked((int)sourceRef.Method.MDToken.Raw),
				sourceRef.IlOffset is { } offset ? (int)offset : null,
				targets);
		}

		/// <summary>A target written the way a decompiled document's span writes one: by node in a module the
		/// workspace holds, by file and token in one a reference loaded.</summary>
		void AddAnalyzerTarget(List<AnalyzerTargetDto> targets, IMemberDef member) {
			if (AnalyzerModuleEntry(member.Module) is not { } entry)
				return;
			targets.Add(IsOpenModule(entry)
				? new AnalyzerTargetDto(GetMemberNode(member, entry).Id)
				: new AnalyzerTargetDto(null, entry.Path, unchecked((int)member.MDToken.Raw)));
		}

		/// <summary>
		/// Whether a member is part of its assembly's public surface — what dnSpy's Search MSDN asks before it
		/// offers itself. An accessor counts as the property or event it belongs to.
		/// </summary>
		static bool IsPublicApi(IMemberDef member) {
			if (member is MethodDef { SemanticsAttributes: not MethodSemanticsAttributes.None } accessor && FindOwningPropertyOrEvent(accessor) is IMemberDef owner)
				member = owner;
			if (member is TypeDef type)
				return IsAccessible(type);
			if (!IsAccessible(member.DeclaringType))
				return false;
			return member switch {
				MethodDef method => IsAccessible(method),
				FieldDef field => field.IsPublic || field.IsFamily || field.IsFamilyOrAssembly,
				PropertyDef property => property.GetMethods.Any(IsAccessible) || property.SetMethods.Any(IsAccessible) || property.OtherMethods.Any(IsAccessible),
				EventDef @event => IsAccessible(@event.AddMethod) || IsAccessible(@event.InvokeMethod) || IsAccessible(@event.RemoveMethod) || @event.OtherMethods.Any(IsAccessible),
				_ => false,
			};
		}

		static bool IsAccessible(TypeDef? type) {
			if (type is null)
				return false;
			for (; type.DeclaringType is not null; type = type.DeclaringType) {
				if (type.Visibility is TypeAttributes.NotPublic or TypeAttributes.NestedPrivate or TypeAttributes.NestedAssembly or TypeAttributes.NestedFamANDAssem)
					return false;
			}
			return type.IsPublic;
		}

		static bool IsAccessible(MethodDef? method) =>
			method is not null && (method.IsPublic || method.IsFamily || method.IsFamilyOrAssembly);

		/// <summary>
		/// The analyzer's view of the workspace. The documents are the modules the tree holds, plus the
		/// analyzed member's own when it lives in an assembly a reference loaded — dnSpy's document list holds
		/// such an assembly too. A reference resolves to a module of the workspace first, then to one a
		/// reference already loaded, then to one it loads on demand: the step dnSpy's own resolver takes when
		/// it auto-loads an assembly. What resolved is remembered for the length of the request. A search
		/// looks at several types at once, so one lookup runs at a time: it reads the workspace's indexes and
		/// may load a module into it, neither of which is safe to do from two threads.
		/// </summary>
		sealed class AnalyzerHost : IAnalyzerHost {
			const int MaxForwarderDepth = 8;
			readonly Lock sync = new();
			readonly Workspace workspace;
			readonly List<ModuleDef> documents;
			readonly Dictionary<object, TypeDef?> types = new(ReferenceEqualityComparer.Instance);
			readonly Dictionary<object, MethodDef?> methods = new(ReferenceEqualityComparer.Instance);
			readonly Dictionary<object, FieldDef?> fields = new(ReferenceEqualityComparer.Instance);

			public AnalyzerHost(Workspace workspace, ModuleDef? analyzedModule) {
				this.workspace = workspace;
				documents = workspace.OrderedModules().Select(entry => (ModuleDef)entry.Module).ToList();
				if (analyzedModule is not null && !documents.Contains(analyzedModule))
					documents.Add(analyzedModule);
			}

			public IReadOnlyList<ModuleDef> Documents => documents;

			public TypeDef? ResolveTypeDef(IType? type) {
				switch (type) {
				case TypeDef typeDef:
					return typeDef;
				case null:
					return null;
				}
				var reference = type as TypeRef ?? type.ScopeType as TypeRef;
				if (reference is null)
					return type.ScopeType as TypeDef;
				lock (sync)
					return ResolveTypeRef(reference);
			}

			TypeDef? ResolveTypeRef(TypeRef typeRef) {
				if (types.TryGetValue(typeRef, out var cached))
					return cached;
				// Recorded before the lookup so a malformed chain of references that leads back to itself ends.
				types[typeRef] = null;
				var resolved = ResolveTypeRefCore(typeRef);
				types[typeRef] = resolved;
				return resolved;
			}

			TypeDef? ResolveTypeRefCore(TypeRef typeRef) {
				switch (typeRef.ResolutionScope) {
				case TypeRef outer:
					return ResolveTypeRef(outer)?.NestedTypes.FirstOrDefault(nested => nested.Name == typeRef.Name && nested.Namespace == typeRef.Namespace);
				case AssemblyRef assemblyRef:
					return FindInAssembly(typeRef.Module, assemblyRef, typeRef.FullName, 0);
				default:
					// A module of the referencing assembly, or the referencing module itself.
					var module = typeRef.Module;
					if (module is null)
						return null;
					foreach (var candidate in module.Assembly?.Modules ?? (IEnumerable<ModuleDef>)[module]) {
						if (Find(candidate, typeRef.FullName) is { } found)
							return found;
					}
					return null;
				}
			}

			TypeDef? FindInAssembly(ModuleDef? sourceModule, AssemblyRef assemblyRef, string fullName, int depth) {
				if (depth > MaxForwarderDepth)
					return null;
				var name = assemblyRef.Name.String;
				foreach (var entry in workspace.modules.Values) {
					if (string.Equals(entry.Module.Assembly?.Name.String ?? entry.Module.Name.String, name, StringComparison.OrdinalIgnoreCase)
						&& FindOrFollow(entry.Module, fullName, depth) is { } found)
						return found;
				}
				if (workspace.referenceModules.TryGetValue(name, out var loaded) && FindOrFollow(loaded.Module, fullName, depth) is { } inLoaded)
					return inLoaded;
				// A type the workspace holds under its full name, in an assembly the reference does not name —
				// the way the tree's own hierarchy nodes resolve a base type.
				foreach (var entry in workspace.OrderedModules()) {
					if (workspace.GetTypeIndex(entry).TryGetValue(fullName, out var byName))
						return byName;
				}
				if (workspace.AnalyzerModuleEntry(sourceModule) is { } owner && workspace.LoadReferenceModule(owner, assemblyRef) is { } reference)
					return FindOrFollow(reference.Module, fullName, depth);
				return null;
			}

			/// <summary>The type in a module, or where the module's forwarder for it points.</summary>
			TypeDef? FindOrFollow(ModuleDef module, string fullName, int depth) {
				if (Find(module, fullName) is { } found)
					return found;
				foreach (var exportedType in module.ExportedTypes) {
					if (exportedType.MovedToAnotherAssembly && exportedType.FullName == fullName && exportedType.Implementation is AssemblyRef target)
						return FindInAssembly(module, target, fullName, depth + 1);
				}
				return null;
			}

			/// <summary>A type of a module by full name: through the workspace's index for a module it holds,
			/// which follows its edits, and through dnlib's own lookup for an assembly a reference loaded.</summary>
			TypeDef? Find(ModuleDef module, string fullName) {
				foreach (var entry in workspace.modules.Values) {
					if (ReferenceEquals(entry.Module, module))
						return workspace.GetTypeIndex(entry).TryGetValue(fullName, out var indexed) ? indexed : null;
				}
				return module.Find(fullName, isReflectionName: false);
			}

			public MethodDef? ResolveMethodDef(IMethod? method) {
				switch (method) {
				case MethodDef methodDef:
					return methodDef;
				case MethodSpec methodSpec:
					return ResolveMethodDef(methodSpec.Method);
				case MemberRef memberRef when memberRef.IsMethodRef:
					lock (sync) {
						if (methods.TryGetValue(memberRef, out var cached))
							return cached;
						var resolved = ResolveMethodRef(memberRef);
						methods[memberRef] = resolved;
						return resolved;
					}
				default:
					return null;
				}
			}

			/// <summary>
			/// dnlib's FindMethodCheckBaseType: the method in the declaring type or the nearest base type that
			/// declares it. The signature names the types the way the calling module does — through a facade,
			/// say — so where an exact match finds nothing the same lookup runs once more without comparing
			/// the assemblies the signature's types come from, which is what following those forwarders gives.
			/// </summary>
			MethodDef? ResolveMethodRef(MemberRef memberRef) {
				if (memberRef.Class is MethodDef varargTarget)
					return varargTarget;
				var declaringType = memberRef.Class switch {
					ITypeDefOrRef parent => ResolveTypeDef(parent),
					ModuleRef moduleRef => SameAssemblyModule(memberRef.Module, moduleRef)?.GlobalType,
					_ => null,
				};
				foreach (var options in new[] { SigComparerOptions.PrivateScopeMethodIsComparable, SigComparerOptions.PrivateScopeMethodIsComparable | SigComparerOptions.DontCompareTypeScope }) {
					var type = declaringType;
					for (var depth = 0; type is not null && depth < 100; depth++) {
						if (type.FindMethod(memberRef.Name, memberRef.MethodSig, options, memberRef.Module) is { } found)
							return found;
						type = ResolveTypeDef(type.BaseType);
					}
				}
				return null;
			}

			public FieldDef? ResolveFieldDef(IField? field) {
				switch (field) {
				case FieldDef fieldDef:
					return fieldDef;
				case MemberRef memberRef when memberRef.IsFieldRef:
					lock (sync) {
						if (fields.TryGetValue(memberRef, out var cached))
							return cached;
						var resolved = ResolveFieldRef(memberRef);
						fields[memberRef] = resolved;
						return resolved;
					}
				default:
					return null;
				}
			}

			FieldDef? ResolveFieldRef(MemberRef memberRef) {
				var declaringType = memberRef.Class switch {
					ITypeDefOrRef parent => ResolveTypeDef(parent),
					ModuleRef moduleRef => SameAssemblyModule(memberRef.Module, moduleRef)?.GlobalType,
					_ => null,
				};
				foreach (var options in new[] { SigComparerOptions.PrivateScopeFieldIsComparable, SigComparerOptions.PrivateScopeFieldIsComparable | SigComparerOptions.DontCompareTypeScope }) {
					var type = declaringType;
					for (var depth = 0; type is not null && depth < 100; depth++) {
						if (type.FindField(memberRef.Name, memberRef.FieldSig, options, memberRef.Module) is { } found)
							return found;
						type = ResolveTypeDef(type.BaseType);
					}
				}
				return null;
			}

			static ModuleDef? SameAssemblyModule(ModuleDef? module, ModuleRef moduleRef) =>
				module?.Assembly?.Modules.FirstOrDefault(candidate => string.Equals(candidate.Name, moduleRef.Name, StringComparison.OrdinalIgnoreCase));
		}
	}
}
