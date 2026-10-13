using System.Reflection;
using System.Runtime.InteropServices;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using SearchTarget;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The search window against the SearchTarget fixture: what dnSpy's search finds for each "Search For" entry
/// and option, how its list writes a result, where following one goes, and that a search run a slice at a time
/// comes to what one pass would.
/// </summary>
public sealed class WorkspaceSearchTests : IDisposable {
	// Every search here walks a step per slice and sends a batch after every slice that found something.
	readonly WorkspaceManager manager = new() { AnalyzerSliceBudget = TimeSpan.Zero, AnalyzerProgressInterval = TimeSpan.Zero };

	static CancellationToken Token => TestContext.Current.CancellationToken;

	static string TargetPath => typeof(Library).Assembly.Location;

	[Fact]
	public async Task WritesResultsTheWayTheWpfSearchListDoes() {
		var workspaceId = await OpenAsync();

		async Task<(string Name, string Location)> Written(string query, string searchType, string? location = "SearchTarget.Library") {
			var results = await SearchAsync(workspaceId, query, searchType);
			var result = Assert.Single(results, result => location is null || result.Location == location);
			return (result.Name, result.Location);
		}

		Assert.Equal(("string Describe(int, [string], params object[])", "SearchTarget.Library"), await Written("Describe", SearchTypes.Method));
		Assert.Equal(("Library operator +(Library, Library)", "SearchTarget.Library"), await Written("op_Addition", SearchTypes.Method));
		Assert.Equal(("implicit operator string(Library)", "SearchTarget.Library"), await Written("op_Implicit", SearchTypes.Method));
		Assert.Equal(("int NativeCall() (native_entry)", "SearchTarget.Library"), await Written("NativeCall", SearchTypes.Method));
		Assert.Equal(("string Title.get", "SearchTarget.Library"), await Written("get_Title", SearchTypes.Method));
		Assert.Equal(("string Title.init", "SearchTarget.Library"), await Written("set_Title", SearchTypes.Method));
		Assert.Equal(("string Title { get; init; }", "SearchTarget.Library"), await Written("Title", SearchTypes.Property));
		Assert.Equal(("int this[int] { get; }", "SearchTarget.Library"), await Written("Item", SearchTypes.Property));
		Assert.Equal(("EventHandler Opened { add; remove; }", "SearchTarget.Library"), await Written("Opened", SearchTypes.Event));
		Assert.Equal(("int Answer", "SearchTarget.Library"), await Written("Answer", SearchTypes.Field));
		// An enum's constants go without the type every one of them has.
		Assert.Equal(("Red", "SearchTarget.Color"), await Written("Red", SearchTypes.Field, "SearchTarget.Color"));
		Assert.Equal(("Library()", "SearchTarget.Library"), await Written(".ctor", SearchTypes.Method));
		// A type the way the decompiler names one — a nested type after its outer type — and where it lives:
		// a nested one in its outer type, a top-level one in its namespace.
		Assert.Equal(("Library.Nested<T>", "SearchTarget.Library"), await Written("Nested", SearchTypes.Type));
		Assert.Equal(("Generic<TKey, TValue>", "SearchTarget"), await Written("Generic", SearchTypes.Type, "SearchTarget"));
		Assert.Equal(("SearchTarget.Inner", "SearchTarget.dll"), await Written("Inner", SearchTypes.Namespace, null));
		Assert.Equal(("SearchTarget, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null", ""), await Written("SearchTarget", SearchTypes.Assembly, null));
		Assert.Equal(("SearchTarget.dll", "SearchTarget, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null"), await Written("SearchTarget", SearchTypes.Module, null));
	}

	[Fact]
	public async Task ColorsResultsTheWayTheWpfSearchListDoes() {
		var workspaceId = await OpenAsync();
		var describe = Assert.Single(await SearchAsync(workspaceId, "Describe", SearchTypes.Method));

		Assert.Equal(
			[("string", "keyword"), (" ", "text"), ("Describe", "instanceMethod"), ("(", "punctuation"), ("int", "keyword"), (",", "punctuation"), (" ", "text"), ("[", "punctuation")],
			describe.NameParts!.Take(8).Select(part => (part.Text, part.Color)));
		Assert.Equal([("SearchTarget", "namespace"), (".", "operator"), ("Library", "type")], describe.LocationParts!.Select(part => (part.Text, part.Color)));
		Assert.Equal("method", describe.Icon);
		Assert.Equal("class", describe.LocationIcon);
	}

	[Fact]
	public async Task FollowsAResultToTheTreeNodeItNames() {
		var workspaceId = await OpenAsync();

		async Task<TreeNodeDto?> NodeOf(SearchResultDto result) =>
			result.NodeId is null ? null : await manager.GetNodeAsync(new NodeRequest(workspaceId, result.NodeId), Token);

		var type = Assert.Single(await SearchAsync(workspaceId, "Library", SearchTypes.Type, matchWholeWords: true));
		Assert.Equal(("type", "Library"), ((await NodeOf(type))!.Kind, (await NodeOf(type))!.Label));
		Assert.Equal("namespace", (await NodeOf(Assert.Single(await SearchAsync(workspaceId, "Inner", SearchTypes.Namespace))))!.Kind);
		Assert.Equal("assembly", (await NodeOf(Assert.Single(await SearchAsync(workspaceId, "SearchTarget", SearchTypes.Assembly))))!.Kind);
		Assert.Equal("module", (await NodeOf(Assert.Single(await SearchAsync(workspaceId, "SearchTarget", SearchTypes.Module))))!.Kind);
		Assert.Equal("assemblyreference", (await NodeOf(Assert.Single(await SearchAsync(workspaceId, "System.Runtime", SearchTypes.AssemblyRef))))!.Kind);
		Assert.Equal("resource", (await NodeOf(Assert.Single(await SearchAsync(workspaceId, "notes.txt", SearchTypes.Resource))))!.Kind);

		// A module reference has no row in the tree to go to.
		var moduleRef = Assert.Single(await SearchAsync(workspaceId, "libsearch", SearchTypes.ModuleRef));
		Assert.Equal(("moduleReference", "libsearch", null), (moduleRef.Kind, moduleRef.Name, moduleRef.NodeId));

		// A parameter or a local is found as the method it is in, and is followed there.
		var parameter = Assert.Single(await SearchAsync(workspaceId, "label", SearchTypes.Parameter));
		Assert.Equal(("method", "string Describe(int, [string], params object[])"), (parameter.Kind, parameter.Name));
		Assert.Equal("Describe(int, string, object[])", (await NodeOf(parameter))!.Label);
		var local = Assert.Single(await SearchAsync(workspaceId, "describedCount", SearchTypes.Local));
		Assert.Equal(parameter.NodeId, local.NodeId);
	}

	[Fact]
	public async Task FindsLiteralsInBodiesConstantsAndAttributes() {
		var workspaceId = await OpenAsync();

		var number = Assert.Single(await SearchAsync(workspaceId, "31337", SearchTypes.Literal));
		Assert.Equal("string Describe(int, [string], params object[])", number.Name);
		Assert.NotNull(number.IlOffset);
		Assert.Contains($"IL_{number.IlOffset:X4}: ldc.i4 31337", number.ToolTip, StringComparison.Ordinal);
		Assert.EndsWith(TargetPath, number.ToolTip, StringComparison.Ordinal);

		// A quoted query is a string, whatever it looks like inside the quotes.
		Assert.Equal(number.NodeId, Assert.Single(await SearchAsync(workspaceId, "\"body-literal-needle\"", SearchTypes.Literal)).NodeId);
		Assert.Equal("double Ratio()", Assert.Single(await SearchAsync(workspaceId, "2.718", SearchTypes.Literal)).Name);
		Assert.Equal("string Greeting", Assert.Single(await SearchAsync(workspaceId, "field-literal-needle", SearchTypes.Literal)).Name);
		Assert.Equal("int Answer", Assert.Single(await SearchAsync(workspaceId, "0x1092", SearchTypes.Literal)).Name);

		// An attribute argument names what the attribute is applied to: a parameter in its method, the assembly.
		var parameter = Assert.Single(await SearchAsync(workspaceId, "param-note-needle", SearchTypes.Literal));
		Assert.Equal(("parameter", "label", "string Describe(int, [string], params object[])"), (parameter.Kind, parameter.Name, parameter.Location));
		Assert.Equal(number.NodeId, parameter.NodeId);
		Assert.Equal("assembly", Assert.Single(await SearchAsync(workspaceId, "assembly-note-needle", SearchTypes.Literal)).Kind);

		// A literal is not a name: the comparer for one looks at values only.
		Assert.Empty(await SearchAsync(workspaceId, "Describe", SearchTypes.Literal));
	}

	[Fact]
	public async Task FindsResourcesByNameTextAndEntryValue() {
		var workspaceId = await OpenAsync();

		var notes = Assert.Single(await SearchAsync(workspaceId, "notes.txt", SearchTypes.Resource));
		Assert.Equal(("resource", "notes.txt", "SearchTarget.dll"), (notes.Kind, notes.Name, notes.Location));
		Assert.Equal([("notes", "fileNameNoExtension"), (".", "text"), ("txt", "fileExtension")], notes.NameParts!.Select(part => (part.Text, part.Color)));
		// The text an embedded file holds is searched as well as its name.
		Assert.Equal(notes.NodeId, Assert.Single(await SearchAsync(workspaceId, "resource-text-needle", SearchTypes.Any)).NodeId);

		var entry = Assert.Single(await SearchAsync(workspaceId, "resx-value-needle", SearchTypes.Resource));
		Assert.Equal(("resourceEntry", "Greeting%20Text", "SearchTarget.Strings.resources"), (entry.Kind, entry.Name, entry.Location));
		Assert.Equal("resourceentry", (await manager.GetNodeAsync(new NodeRequest(workspaceId, entry.NodeId!), Token)).Kind);
		// An entry's name is matched unescaped too, and its string value as a literal.
		Assert.Equal(entry.NodeId, Assert.Single(await SearchAsync(workspaceId, "Greeting Text", SearchTypes.Any)).NodeId);
		Assert.Equal(entry.NodeId, Assert.Single(await SearchAsync(workspaceId, "resx-value-needle", SearchTypes.Literal)).NodeId);
	}

	[Fact]
	public async Task SearchesDecompiledBamlOnlyWhenAskedTo() {
		var target = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "BamlTarget", "bin", TestConfiguration, "net10.0-windows", "BamlTarget.dll"));
		Assert.True(File.Exists(target), $"BAML fixture was not built: {target}");
		var workspaceId = (await manager.OpenAsync(new OpenWorkspaceRequest([target]), Token)).WorkspaceId;

		var baml = Assert.Single(await SearchAsync(workspaceId, "BAML fixture", SearchTypes.Any));
		Assert.Equal(("resourceEntry", "sampleview.baml"), (baml.Kind, baml.Name));
		Assert.Empty(await SearchAsync(workspaceId, "BAML fixture", SearchTypes.Any, searchDecompiledData: false));
	}

	[Fact]
	public async Task MatchesTheWayTheOptionsSay() {
		var workspaceId = await OpenAsync();

		Assert.Single(await SearchAsync(workspaceId, "library", SearchTypes.Type, matchWholeWords: true));
		Assert.Empty(await SearchAsync(workspaceId, "library", SearchTypes.Type, caseSensitive: true));
		Assert.NotEmpty(await SearchAsync(workspaceId, "Lib", SearchTypes.Type));
		Assert.Empty(await SearchAsync(workspaceId, "Lib", SearchTypes.Type, matchWholeWords: true));
		// Terms must all match, or any of them.
		Assert.Empty(await SearchAsync(workspaceId, "Color Point", SearchTypes.Type));
		Assert.Equal(["Color", "Point"], (await SearchAsync(workspaceId, "Color Point", SearchTypes.Type, matchAny: true)).Select(result => result.Name).Order());
		// A query between slashes is a regular expression.
		Assert.Equal("IThing", Assert.Single(await SearchAsync(workspaceId, "/^I[A-Z]/", SearchTypes.Type)).Name);
		// The kinds of type each have an entry of their own.
		Assert.Equal("Color", Assert.Single(await SearchAsync(workspaceId, "o", SearchTypes.Enum)).Name);
		Assert.Equal("Point", Assert.Single(await SearchAsync(workspaceId, "o", SearchTypes.Struct)).Name);
		Assert.Equal("Handler", Assert.Single(await SearchAsync(workspaceId, "Handler", SearchTypes.Delegate)).Name);
		Assert.Equal("IThing", Assert.Single(await SearchAsync(workspaceId, "Thing", SearchTypes.Interface)).Name);
		Assert.Contains("Generic<TKey, TValue>", (await SearchAsync(workspaceId, "e", SearchTypes.GenericType)).Select(result => result.Name));
		Assert.DoesNotContain("Generic<TKey, TValue>", (await SearchAsync(workspaceId, "e", SearchTypes.NonGenericType)).Select(result => result.Name));
	}

	[Fact]
	public async Task HidesCompilerGeneratedMembersWhenAskedTo() {
		var workspaceId = await OpenAsync();

		Assert.NotEmpty(await SearchAsync(workspaceId, "<Counter>", SearchTypes.Type));
		Assert.Empty(await SearchAsync(workspaceId, "<Counter>", SearchTypes.Type, searchCompilerGenerated: false));
		// The lambda's body is a method of a closure class: its literal is found only with them.
		Assert.Single(await SearchAsync(workspaceId, "9001", SearchTypes.Literal));
		Assert.Empty(await SearchAsync(workspaceId, "9001", SearchTypes.Literal, searchCompilerGenerated: false));
	}

	[Fact]
	public async Task SearchesTheLocationTheSecondBoxNames() {
		var analyzerTarget = typeof(AnalyzerTarget.Circle).Assembly.Location;
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([TargetPath, analyzerTarget]), Token);
		var workspaceId = opened.WorkspaceId;
		var searchTarget = opened.Modules.Single(module => module.Path == TargetPath).Id;
		var library = await NodeAsync(workspaceId, typeof(Library));
		var describe = await NodeAsync(workspaceId, typeof(Library).GetMethod(nameof(Library.Describe))!);
		var color = await NodeAsync(workspaceId, typeof(Color));

		Task<IReadOnlyList<SearchResultDto>> Search(string query, string location, params string[] selection) =>
			SearchAsync(workspaceId, query, SearchTypes.Type, location: location, selection: selection);

		Assert.Single(await Search("Circle", SearchLocations.AllFiles));
		Assert.Empty(await Search("Circle", SearchLocations.SelectedFiles, library));
		Assert.Single(await Search("Circle", SearchLocations.SelectedFiles, library, searchTarget, opened.Modules.Single(module => module.Path == analyzerTarget).Id));
		// The fixtures sit side by side in the test output.
		Assert.Single(await Search("Circle", SearchLocations.AllFilesInSameDir, library));
		Assert.Empty(await Search("Circle", SearchLocations.AllFilesInSameDir));

		// The selected type takes its nested types along; a member stands for the type it is in.
		Assert.Equal("Library.Nested<T>", Assert.Single(await Search("Nested", SearchLocations.SelectedType, describe)).Name);
		// An enum's value__ is a field too, which the whole word keeps out.
		Assert.Single(await SearchAsync(workspaceId, "Value", SearchTypes.Field, matchWholeWords: true, location: SearchLocations.SelectedType, selection: [library]));
		Assert.Empty(await SearchAsync(workspaceId, "Value", SearchTypes.Field, matchWholeWords: true, location: SearchLocations.SelectedType, selection: [color]));
	}

	[Fact]
	public async Task LeavesFrameworkAssembliesOutWhenAskedTo() {
		var runtime = Path.Combine(RuntimeEnvironment.GetRuntimeDirectory(), "System.Runtime.dll");
		var workspaceId = (await manager.OpenAsync(new OpenWorkspaceRequest([TargetPath, runtime]), Token)).WorkspaceId;

		Assert.Equal(["SearchTarget", "System.Runtime"], (await SearchAsync(workspaceId, "S", SearchTypes.Assembly)).Select(result => result.Name.Split(',')[0]).Order());
		Assert.Equal("SearchTarget", Assert.Single(await SearchAsync(workspaceId, "S", SearchTypes.Assembly, searchFramework: false)).Name.Split(',')[0]);
	}

	[Fact]
	public async Task StopsAtTheLimitTheWayTheWpfSearchDoes() {
		var workspaceId = await OpenAsync();
		var response = await manager.SearchAsync(new SearchRequest(workspaceId, "e", SearchTypes.Any, MaxResults: 3), Token);

		Assert.Equal(3, response.Results.Count);
		Assert.True(response.Truncated);
		Assert.False((await manager.SearchAsync(new SearchRequest(workspaceId, "Describe", SearchTypes.Method, MaxResults: 1), Token)).Truncated);
	}

	[Fact]
	public async Task SendsWhatASearchFindsAheadOfItsAnswer() {
		var workspaceId = await OpenAsync();
		var whole = (await manager.SearchAsync(new SearchRequest(workspaceId, "e", SearchTypes.Any), Token)).Results;

		var batches = new List<SearchProgressNotification>();
		var response = await manager.SearchAsync(
			new SearchRequest(workspaceId, "e", SearchTypes.Any, ProgressToken: "search-e"),
			progress => {
				batches.Add(progress);
				return Task.CompletedTask;
			},
			Token);

		Assert.True(batches.Count > 1, $"Expected the search to send several batches, got {batches.Count}.");
		Assert.All(batches, batch => Assert.Equal("search-e", batch.ProgressToken));
		var position = 0;
		foreach (var batch in batches) {
			Assert.Equal(position, batch.Start);
			Assert.NotEmpty(batch.Results);
			position += batch.Results.Count;
		}
		Assert.Equal(position, response.Start);
		Assert.Equal(Written(whole), Written(batches.SelectMany(batch => batch.Results).Concat(response.Results)));
	}

	[Fact]
	public async Task GivesUpWhenAnEditLandsBetweenTheSlicesOfASearch() {
		var workspaceId = await OpenAsync();
		var describe = await NodeAsync(workspaceId, typeof(Library).GetMethod(nameof(Library.Describe))!);
		var edited = false;

		var exception = await Assert.ThrowsAsync<RpcException>(() => manager.SearchAsync(
			new SearchRequest(workspaceId, "e", SearchTypes.Any, ProgressToken: "edited"),
			async _ => {
				if (edited)
					return;
				edited = true;
				var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), Token);
				await manager.QueueRenameAsync(new RenameEditRequest(workspaceId, transaction.TransactionId, describe, "Portray"), Token);
				await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), Token);
			},
			Token));

		Assert.True(edited);
		Assert.Equal(ErrorCodes.EditConflict, exception.Code);
		Assert.Single(await SearchAsync(workspaceId, "Portray", SearchTypes.Method));
	}

	[Fact]
	public async Task FindsNothingForAQueryOfSpaces() {
		var workspaceId = await OpenAsync();
		Assert.Empty(await SearchAsync(workspaceId, "   ", SearchTypes.Any));
		var exception = await Assert.ThrowsAsync<RpcException>(() => SearchAsync(workspaceId, "x", "nonsense"));
		Assert.Equal(ErrorCodes.InvalidParams, exception.Code);
	}

	[Fact]
	public async Task FindsGlobalFunctionsAndFields() {
		var workspaceId = await OpenAsync();

		// Global functions and fields are in the <Module> type, which was previously skipped.
		var globalFunction = Assert.Single(await SearchAsync(workspaceId, "GlobalFunction", SearchTypes.Method));
		Assert.Equal("string GlobalFunction()", globalFunction.Name);
		Assert.Equal("SearchTarget.GlobalMembers", globalFunction.Location);

		var globalField = Assert.Single(await SearchAsync(workspaceId, "GlobalField", SearchTypes.Field));
		Assert.Equal("int GlobalField", globalField.Name);
		Assert.Equal("SearchTarget.GlobalMembers", globalField.Location);

		// Verify we can also find them by literal value.
		var literal = Assert.Single(await SearchAsync(workspaceId, "global-function-needle", SearchTypes.Literal));
		Assert.Equal("string GlobalFunction()", literal.Name);
	}

	async Task<string> OpenAsync() {
		Assert.True(File.Exists(TargetPath), "The search fixture was not copied to the test output.");
		return (await manager.OpenAsync(new OpenWorkspaceRequest([TargetPath]), Token)).WorkspaceId;
	}

	async Task<IReadOnlyList<SearchResultDto>> SearchAsync(
		string workspaceId,
		string query,
		string searchType,
		bool caseSensitive = false,
		bool matchWholeWords = false,
		bool matchAny = false,
		bool searchDecompiledData = true,
		bool searchFramework = true,
		bool searchCompilerGenerated = true,
		string location = SearchLocations.AllFiles,
		IReadOnlyList<string>? selection = null) {
		var response = await manager.SearchAsync(
			new SearchRequest(workspaceId, query, searchType, location, selection, caseSensitive, matchWholeWords, matchAny, searchDecompiledData, searchFramework, searchCompilerGenerated),
			Token);
		Assert.False(response.Truncated);
		return response.Results;
	}

	/// <summary>The tree node of a member, found the way a bookmark finds one: by its file and token.</summary>
	async Task<string> NodeAsync(string workspaceId, MemberInfo member) {
		var found = await manager.FindMemberAsync(new FindMemberRequest(workspaceId, member.Module.Assembly.Location, member.MetadataToken), Token);
		return found.NodeId ?? throw new InvalidOperationException($"No node for {member}.");
	}

	static IReadOnlyList<string> Written(IEnumerable<SearchResultDto> results) => results.Select(result => $"{result.Name} | {result.Location}").ToArray();

	static string TestConfiguration => new DirectoryInfo(AppContext.BaseDirectory).Parent?.Name
		?? throw new InvalidOperationException("Could not determine the test configuration.");

	public void Dispose() => manager.Dispose();
}
