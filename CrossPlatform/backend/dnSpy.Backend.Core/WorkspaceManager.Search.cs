using System.Diagnostics;
using System.Globalization;
using System.Text;
using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.Search;
using ICSharpCode.BamlDecompiler;

namespace dnSpy.Backend.Core;

public sealed partial class WorkspaceManager {
	public Task<SearchResponse> SearchAsync(SearchRequest request, CancellationToken cancellationToken) =>
		SearchAsync(request, null, cancellationToken);

	/// <summary>
	/// dnSpy's search window. The search runs a slice at a time the way an analyzer search does, and one
	/// asked with a progress token hands what it finds to <paramref name="progress"/> as it goes; the response
	/// then carries only the rest.
	/// </summary>
	public Task<SearchResponse> SearchAsync(SearchRequest request, Func<SearchProgressNotification, Task>? progress, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).SearchAsync(request, new AnalyzerPacing(AnalyzerSliceBudget, AnalyzerProgressInterval, 1), progress, cancellationToken);

	sealed partial class Workspace {
		public async Task<SearchResponse> SearchAsync(SearchRequest request, AnalyzerPacing pacing, Func<SearchProgressNotification, Task>? progress, CancellationToken cancellationToken) {
			// dnSpy clears the list for an empty query; one of spaces alone has no term to look for either.
			if (string.IsNullOrWhiteSpace(request.Query))
				return new SearchResponse([], false);
			var progressToken = progress is null ? null : request.ProgressToken;
			var maxResults = Math.Clamp(request.MaxResults, 1, 100_000);
			var run = await RunAsync(w => w.PrepareSearch(request, maxResults, cancellationToken), cancellationToken).ConfigureAwait(false);
			var sent = 0;
			var sinceSent = Stopwatch.StartNew();
			while (!run.Completed) {
				var batch = await RunAsync(w => {
					w.CheckSearchEpoch(run);
					run.RunSlice(pacing.SliceBudget);
					if (progressToken is null || run.Count == sent || sinceSent.Elapsed < pacing.ProgressInterval)
						return null;
					return w.SearchResults(run, sent);
				}, cancellationToken).ConfigureAwait(false);
				// Written with the gate let go: the tree has no reason to wait for the pipe.
				if (batch is { Count: > 0 }) {
					await progress!(new SearchProgressNotification(progressToken!, sent, batch)).ConfigureAwait(false);
					sent += batch.Count;
					sinceSent.Restart();
				}
			}
			return await RunAsync(w => {
				w.CheckSearchEpoch(run);
				return new SearchResponse(w.SearchResults(run, sent), run.Truncated, sent);
			}, cancellationToken).ConfigureAwait(false);
		}

		SearchRun PrepareSearch(SearchRequest request, int maxResults, CancellationToken cancellationToken) {
			var filter = new SearchFilter(SearchFilter.FlagsOf(request.SearchType));
			var comparer = request.SearchType == SearchTypes.Literal
				? SearchComparerFactory.CreateLiteral(request.Query, request.CaseSensitive, request.MatchWholeWords, request.MatchAnySearchTerm)
				: SearchComparerFactory.Create(request.Query, request.CaseSensitive, request.MatchWholeWords, request.MatchAnySearchTerm);
			var run = new SearchRun(analyzerEpoch, maxResults);
			// One decompiler per module: building one reads the module and its references.
			var bamlDecompilers = new Dictionary<string, XamlDecompiler>(StringComparer.Ordinal);
			var searcher = new FilterSearcher(new FilterSearcherOptions(
				comparer,
				filter,
				request.SearchDecompiledData,
				request.SearchCompilerGeneratedMembers,
				run.Add,
				(entry, baml, token) => DecompileBaml(bamlDecompilers, entry, baml, token),
				cancellationToken));
			// The documents are listed now: the workspace may open another between two slices.
			run.Start(request.Location switch {
				SearchLocations.AllFiles => searcher.SearchDocuments(SearchDocuments(AllFilesToSearch(request))),
				SearchLocations.SelectedFiles => searcher.SearchDocuments(SearchDocuments(SelectedFilesToSearch(request))),
				SearchLocations.AllFilesInSameDir => searcher.SearchDocuments(SearchDocuments(AllFilesInSameDirToSearch(request))),
				SearchLocations.SelectedType => searcher.SearchTypes(SelectedTypesToSearch(request).ToArray()),
				_ => throw new RpcException(ErrorCodes.InvalidParams, $"Unknown search location \"{request.Location}\"."),
			});
			return run;
		}

		void CheckSearchEpoch(SearchRun run) {
			if (run.Epoch != analyzerEpoch)
				throw new RpcException(ErrorCodes.EditConflict, "The workspace changed while the search was running.");
		}

		static string? DecompileBaml(Dictionary<string, XamlDecompiler> decompilers, IModuleEntry module, byte[] baml, CancellationToken cancellationToken) {
			if (!decompilers.TryGetValue(module.Path, out var decompiler)) {
				decompiler = new XamlDecompiler(module.Path, new BamlDecompilerSettings {
					ThrowOnAssemblyResolveErrors = false,
				}) {
					CancellationToken = cancellationToken,
				};
				decompilers.Add(module.Path, decompiler);
			}
			using var stream = new MemoryStream(baml, writable: false);
			return decompiler.Decompile(stream).Xaml.ToString();
		}

		static SearchDocument[] SearchDocuments(IEnumerable<IModuleEntry> entries) =>
			entries.Select(entry => new SearchDocument(entry, (entry as ModuleEntry)?.Module)).ToArray();

		/// <summary>SearchControlVM.CanSearchFile: a framework assembly only when the search is asked to look in them.</summary>
		static bool CanSearchFile(SearchRequest request, IModuleEntry entry) =>
			request.SearchFrameworkAssemblies || !FrameworkAssemblies.IsFrameworkAssembly(entry.Path, (entry as ModuleEntry)?.Module.Assembly?.Name.String);

		IEnumerable<IModuleEntry> AllFilesToSearch(SearchRequest request) =>
			OrderedEntries().Where(entry => CanSearchFile(request, entry));

		/// <summary>The tree nodes of the selection that still exist.</summary>
		IEnumerable<NodeEntry> SelectedSearchNodes(SearchRequest request) =>
			(request.SelectedNodeIds ?? []).Select(id => nodes.GetValueOrDefault(id)).OfType<NodeEntry>();

		/// <summary>The documents the selection is in — the files the tree holds, not an assembly a reference loaded.</summary>
		IEnumerable<IModuleEntry> SelectedFilesToSearch(SearchRequest request) {
			var open = OrderedEntries().ToHashSet();
			return SelectedSearchNodes(request)
				.Select(node => node.Module as IModuleEntry)
				.OfType<IModuleEntry>()
				.Where(open.Contains)
				.Distinct()
				.Where(entry => CanSearchFile(request, entry));
		}

		IEnumerable<IModuleEntry> AllFilesInSameDirToSearch(SearchRequest request) {
			var directories = SelectedFilesToSearch(request)
				.Where(entry => File.Exists(entry.Path))
				.Select(entry => Path.GetDirectoryName(entry.Path))
				.OfType<string>()
				.ToHashSet(StringComparer.OrdinalIgnoreCase);
			return AllFilesToSearch(request).Where(entry => File.Exists(entry.Path) && Path.GetDirectoryName(entry.Path) is { } directory && directories.Contains(directory));
		}

		/// <summary>The type each selected node is in, or is: a member's declaring type, a hierarchy folder's owner.</summary>
		IEnumerable<(SearchDocument Document, TypeDef Type)> SelectedTypesToSearch(SearchRequest request) {
			var seen = new HashSet<TypeDef>();
			foreach (var node in SelectedSearchNodes(request)) {
				if (node.AsModuleEntry is not { } module)
					continue;
				var type = node.Kind switch {
					NodeKind.Type or NodeKind.BaseTypeFolder or NodeKind.DerivedTypesFolder => node.Value as TypeDef,
					NodeKind.Method or NodeKind.Field or NodeKind.Property or NodeKind.Event => (node.Value as IMemberDef)?.DeclaringType,
					_ => null,
				};
				if (type?.Module is not null && seen.Add(type))
					yield return (new SearchDocument(module, module.Module), type);
			}
		}

		/// <summary>The results of a run from <paramref name="from"/> on.</summary>
		List<SearchResultDto> SearchResults(SearchRun run, int from) {
			var results = new List<SearchResultDto>(run.Count - from);
			for (var index = from; index < run.Count; index++)
				results.Add(SearchResultDto(run[index]));
			return results;
		}

		SearchResultDto SearchResultDto(SearchHit hit) {
			var name = new TextPartsBuilder();
			SearchResultFormatter.Write(name, hit.NameObject, includeNamespace: false, TypeColor);
			var location = new TextPartsBuilder();
			SearchResultFormatter.Write(location, hit.LocationObject, includeNamespace: true, TypeColor);
			return new SearchResultDto(
				SearchNodeId(hit),
				SearchKind(hit.Object),
				name.ToString(),
				location.ToString(),
				name.ToParts(),
				location.ToParts(),
				SearchIcon(hit.NameObject),
				SearchIcon(hit.LocationObject),
				SearchToolTip(hit, name.ToString()),
				hit.Body is { } body ? (int)body.ILOffset : null);
		}

		/// <summary>
		/// The tree node following a result goes to — what dnSpy's SearchResult.Reference names. A parameter is
		/// followed to its method; a module reference has no row in this tree, so it goes nowhere.
		/// </summary>
		string? SearchNodeId(SearchHit hit) {
			if (hit.Document is not ModuleEntry module)
				return hit.Document.Id;
			switch (hit.Object) {
			case AssemblyDef:
				return module.Id;
			case ModuleDef:
				return SearchModuleNode(module).Id;
			case SearchNamespace ns:
				return GetNamespaceNodes(SearchModuleNode(module).Key, module).FirstOrDefault(node => ((NamespaceValue)node.Value).Name == ns.Name)?.Id;
			case TypeDef or MethodDef or FieldDef or PropertyDef or EventDef:
				return GetMemberNode((IMDTokenProvider)hit.Object, module).Id;
			case ParamDef { DeclaringMethod: { } method }:
				return GetMemberNode(method, module).Id;
			case AssemblyRef reference:
				return GetOrAddNode(MemberKey(module, "reference", reference.MDToken.Raw), NodeKind.AssemblyReference, reference, module).Id;
			case Resource resource:
				return SearchResourceNode(module, resource)?.Id;
			case SearchResourceElement element:
				return SearchResourceEntryNode(module, element)?.Id;
			default:
				return null;
			}
		}

		NodeEntry SearchModuleNode(ModuleEntry module) => GetAssemblyChildren(nodes[module.Id])[0];

		NodeEntry? SearchResourceNode(ModuleEntry module, Resource resource) {
			var group = GetOrAddNode($"{SearchModuleNode(module).Key}:resources", NodeKind.ResourcesGroup, module.Module, module);
			return GetResourceChildren(group).FirstOrDefault(node => ReferenceEquals(node.Value, resource));
		}

		/// <summary>The tree row of a .resources entry. Listing a resource's entries decodes every one of them, so
		/// it is done once, the first time a search finds one — a search can find thousands in one resource.</summary>
		NodeEntry? SearchResourceEntryNode(ModuleEntry module, SearchResourceElement element) {
			var key = ResourceEntryKey(module, element.Owner, element.Element.Name);
			if (nodeIdsByKey.TryGetValue(key, out var id))
				return nodes[id];
			if (SearchResourceNode(module, element.Owner) is not { } resource)
				return null;
			try {
				GetEmbeddedResourceChildren(resource);
			}
			catch (Exception ex) when (ex is BadImageFormatException or IOException or NotSupportedException or ArgumentException or InvalidOperationException) {
				// dnlib read an entry the framework's reader, which the tree lists entries with, cannot.
				return null;
			}
			return nodeIdsByKey.TryGetValue(key, out id) ? nodes[id] : null;
		}

		static string SearchKind(object value) => value switch {
			AssemblyDef => "assembly",
			ModuleDef => "module",
			SearchNamespace => "namespace",
			TypeDef => "type",
			MethodDef => "method",
			FieldDef => "field",
			PropertyDef => "property",
			EventDef => "event",
			ParamDef => "parameter",
			AssemblyRef => "assemblyReference",
			ModuleRef => "moduleReference",
			Resource => "resource",
			SearchResourceElement => "resourceEntry",
			_ => "file",
		};

		/// <summary>The image a result's name or location wears — the one its tree row wears.</summary>
		static string? SearchIcon(object? value) => value switch {
			AssemblyDef { ManifestModule: { } manifest } when (manifest.Characteristics & dnlib.PE.Characteristics.Dll) == 0 => "assembly-exe",
			AssemblyDef => "assembly",
			ModuleDef => "module",
			SearchNamespace => "namespace",
			TypeDef type => TypeIcon(type),
			MethodDef => "method",
			FieldDef => "field",
			PropertyDef => "property",
			EventDef => "event",
			ParamDef => "parameter",
			AssemblyRef or ModuleRef => "reference",
			Resource or SearchResourceElement => "resource",
			PeOnlyModuleEntry or ElfFileEntry => "binary",
			UnknownFileEntry => "error",
			_ => null,
		};

		/// <summary>SearchResult.CreateToolTipUI less the decompiler's member tooltip: the name, the instruction a
		/// body match is, and the file the result is in.</summary>
		static string SearchToolTip(SearchHit hit, string name) {
			var tip = new StringBuilder(name);
			if (hit.Body is { } body) {
				tip.Append('\n').Append("IL_").Append(body.ILOffset.ToString("X4", CultureInfo.InvariantCulture)).Append(": ").Append(body.OpCode.Name);
				if (OperandText(body.Operand) is { } operand)
					tip.Append(' ').Append(operand);
			}
			var file = hit.Document is ModuleEntry { Module.Location: { Length: > 0 } location } ? location : hit.Document.Path;
			return tip.Append('\n').Append(file).ToString();
		}

		static string? OperandText(object? operand) => operand switch {
			null => null,
			string text => "\"" + text.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal)
				.Replace("\r", "\\r", StringComparison.Ordinal).Replace("\n", "\\n", StringComparison.Ordinal).Replace("\t", "\\t", StringComparison.Ordinal) + "\"",
			float value => value == 0 ? (1 / value == float.NegativeInfinity ? "-0.0" : "0.0") : value.ToString("R", CultureInfo.InvariantCulture),
			double value => value == 0 ? (1 / value == double.NegativeInfinity ? "-0.0" : "0.0") : value.ToString("R", CultureInfo.InvariantCulture),
			IFormattable value => value.ToString(null, CultureInfo.InvariantCulture),
			_ => operand.ToString(),
		};
	}
}
