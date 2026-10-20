using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using StringTarget;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The String References window against the StringTarget fixture: the three kinds of reference dnSpy's string
/// searcher lists, how each one's referrer is written, where following it goes, which members the C# view leaves
/// out, and that a scan run a step at a time with progress comes to what one pass would.
/// </summary>
public sealed class WorkspaceStringReferencesTests : IDisposable {
	readonly WorkspaceManager manager = new() { AnalyzerSliceBudget = TimeSpan.Zero, AnalyzerProgressInterval = TimeSpan.Zero };

	public void Dispose() => manager.Dispose();

	static CancellationToken Token => TestContext.Current.CancellationToken;

	static string TargetPath => typeof(Holder<>).Assembly.Location;

	async Task<(string WorkspaceId, string AssemblyNodeId)> OpenAsync() {
		var response = await manager.OpenAsync(new OpenWorkspaceRequest([TargetPath]), Token);
		return (response.WorkspaceId, response.Modules[0].Id);
	}

	async Task<IReadOnlyList<StringReferenceDto>> ScanAsync(string workspaceId, string nodeId, bool showAllMembers = false) =>
		(await manager.SearchStringReferencesAsync(new StringReferencesSearchRequest(workspaceId, [nodeId], ShowAllMembers: showAllMembers), Token)).References;

	static string Referrer(StringReferenceDto reference) => string.Concat(reference.ReferrerParts.Select(part => part.Text));

	static StringReferenceDto Find(IReadOnlyList<StringReferenceDto> references, string literal) =>
		Assert.Single(references, reference => reference.Literal == literal);

	[Fact]
	public async Task ListsEveryStringWithTheReferrerTheWpfWindowWrites() {
		var (workspaceId, nodeId) = await OpenAsync();
		var references = await ScanAsync(workspaceId, nodeId);

		// Written with dnSpy's C# formatter and its defaults for this window: declaring types without their
		// namespace or generic parameters, parameter types alone, an optional one in brackets.
		var greeting = Find(references, "Hello, ");
		Assert.Equal(StringReferenceKinds.IL, greeting.Kind);
		Assert.NotNull(greeting.IlOffset);
		Assert.Equal($"Holder.Greet([string])+IL_{greeting.IlOffset:X4}", Referrer(greeting));
		Assert.Equal("method", greeting.ReferrerIcon);
		Assert.Equal("StringTarget.dll", greeting.ModuleName);

		var constant = Find(references, "field constant");
		Assert.Equal(StringReferenceKinds.Constant, constant.Kind);
		Assert.Equal("Holder.Constant", Referrer(constant));
		Assert.Null(constant.IlOffset);

		var parameter = Find(references, "default name");
		Assert.Equal(StringReferenceKinds.Constant, parameter.Kind);
		Assert.Equal("Holder.Greet([string]) parameter name", Referrer(parameter));
		Assert.Contains(parameter.ReferrerParts, part => part.Text == "parameter" && part.Color == TextColors.DarkGray);
		Assert.Contains(parameter.ReferrerParts, part => part.Text == "name" && part.Color == TextColors.Parameter);

		Assert.Equal("Holder attribute NoteAttribute (Argument #0)", Referrer(Find(references, "type note")));
		Assert.Equal("Holder attribute NoteAttribute (Extra)", Referrer(Find(references, "named extra")));
		// Each string of an array argument is a row of its own.
		Assert.Equal("Holder attribute NoteAttribute (Many)", Referrer(Find(references, "first of many")));
		Assert.Equal("Holder attribute NoteAttribute (Many)", Referrer(Find(references, "second of many")));
		Assert.Equal("Holder generic T attribute NoteAttribute (Argument #0)", Referrer(Find(references, "generic note")));
		// A field's attribute is filed under its type, the way dnSpy's scan keeps the type's context.
		Assert.Equal("Holder attribute NoteAttribute (Argument #0)", Referrer(Find(references, "field note")));
		Assert.Equal("Holder.Later() parameter return attribute NoteAttribute (Argument #0)", Referrer(Find(references, "return note")));
		Assert.Contains(Find(references, "return note").ReferrerParts, part => part.Text == "return" && part.Color == TextColors.Keyword);
		Assert.Equal("StringTarget.dll attribute NoteAttribute (Argument #0)", Referrer(Find(references, "module note")));
		Assert.Equal("StringTarget (1.0.0.0) attribute AssemblyMetadataAttribute (Argument #1)", Referrer(Find(references, "assembly value")));
		Assert.Equal("assembly", Find(references, "assembly value").ReferrerIcon);
		Assert.Equal("module", Find(references, "module note").ReferrerIcon);

		// An empty string is not listed.
		Assert.DoesNotContain(references, reference => reference.Literal.Length == 0);
	}

	[Fact]
	public async Task FormatsLiteralsAsCSharpDoes() {
		var (workspaceId, nodeId) = await OpenAsync();
		var references = await ScanAsync(workspaceId, nodeId);

		var path = Find(references, @"C:\temp\file.txt");
		Assert.True(path.IsVerbatim);
		Assert.Equal("@\"C:\\temp\\file.txt\"", path.FormattedLiteral);

		var escaped = Find(references, "line\nbreak \"quoted\"");
		Assert.False(escaped.IsVerbatim);
		Assert.Equal("\"line\\nbreak \\\"quoted\\\"\"", escaped.FormattedLiteral);
	}

	[Theory]
	[InlineData("plain", "\"plain\"", false)]
	[InlineData("a\\b", "@\"a\\b\"", true)]
	[InlineData("a\\\"b", "@\"a\\\"\"b\"", true)]
	[InlineData("a\\b\tc", "\"a\\\\b\\tc\"", false)]
	[InlineData("\u0001", "\"\\u0001\"", false)]
	[InlineData("a\\b\u2028", "\"a\\\\b\u2028\"", false)]
	public void TheFormatterFollowsDnSpysRules(string value, string expected, bool verbatim) {
		Assert.Equal(expected, StringLiteralFormatter.Format(value, out var isVerbatim));
		Assert.Equal(verbatim, isVerbatim);
	}

	[Fact]
	public async Task TheReferrerIsWrittenByTheDecompilerThatIsSelected() {
		var (workspaceId, nodeId) = await OpenAsync();
		async Task<IReadOnlyList<StringReferenceDto>> ScanIn(DecompilerLanguage language) =>
			(await manager.SearchStringReferencesAsync(new StringReferencesSearchRequest(workspaceId, [nodeId], Language: language), Token)).References;

		// Visual Basic has a formatter of its own: a method after its Sub or Function, a field with its type
		// whatever the options say, the attribute's type and a generic parameter written by it as well.
		var vb = await ScanIn(DecompilerLanguage.VisualBasic);
		var greeting = Find(vb, "Hello, ");
		Assert.Equal($"Function Holder.Greet([String])+IL_{greeting.IlOffset:X4}", Referrer(greeting));
		Assert.Contains(greeting.ReferrerParts, part => part.Text == "Function" && part.Color == TextColors.Keyword);
		Assert.Contains(greeting.ReferrerParts, part => part.Text == "String" && part.Color == TextColors.Keyword);
		Assert.Equal("Holder.Constant As String", Referrer(Find(vb, "field constant")));
		Assert.Equal("Function Holder.Greet([String]) parameter name", Referrer(Find(vb, "default name")));
		Assert.Equal("Function Holder.Later() parameter return attribute NoteAttribute (Argument #0)", Referrer(Find(vb, "return note")));
		Assert.Equal("Holder generic T attribute NoteAttribute (Argument #0)", Referrer(Find(vb, "generic note")));
		Assert.Contains(Find(vb, "generic note").ReferrerParts, part => part.Text == "T" && part.Color == TextColors.TypeGenericParameter);
		Assert.Equal("StringTarget (1.0.0.0) attribute AssemblyMetadataAttribute (Argument #1)", Referrer(Find(vb, "assembly value")));

		// Neither IL view overrides the decompiler's Write, so both go through the C# formatter.
		foreach (var language in new[] { DecompilerLanguage.IL, DecompilerLanguage.ILWithCSharp }) {
			var il = await ScanIn(language);
			Assert.Equal($"Holder.Greet([string])+IL_{greeting.IlOffset:X4}", Referrer(Find(il, "Hello, ")));
			Assert.Equal("Holder.Constant", Referrer(Find(il, "field constant")));
		}
	}

	[Fact]
	public async Task TheCSharpViewLeavesOutWhatTheCompilerMadeAndILShowsIt() {
		var (workspaceId, nodeId) = await OpenAsync();

		Assert.DoesNotContain(await ScanAsync(workspaceId, nodeId), reference => reference.Literal == "inside lambda");
		var lambda = Find(await ScanAsync(workspaceId, nodeId, showAllMembers: true), "inside lambda");
		Assert.Contains("<Later>", Referrer(lambda), StringComparison.Ordinal);
	}

	[Fact]
	public async Task FollowingGoesToTheReferrer() {
		var (workspaceId, nodeId) = await OpenAsync();
		var references = await ScanAsync(workspaceId, nodeId);

		async Task<TreeNodeDto> NodeOf(string literal) {
			var reference = Find(references, literal);
			Assert.NotNull(reference.NodeId);
			return await manager.GetNodeAsync(new NodeRequest(workspaceId, reference.NodeId), Token);
		}

		var greet = await NodeOf("Hello, ");
		Assert.Equal("method", greet.Kind);
		Assert.Equal(greet.MetadataToken, Find(references, "Hello, ").Token);
		Assert.Equal("field", (await NodeOf("field constant")).Kind);
		// A parameter's default and a parameter's attribute go to the method.
		Assert.Equal("method", (await NodeOf("default name")).Kind);
		Assert.Equal("method", (await NodeOf("return note")).Kind);
		// A field's attribute goes to the field even though the row names the type.
		Assert.Equal("field", (await NodeOf("field note")).Kind);
		Assert.Equal("type", (await NodeOf("generic note")).Kind);
		Assert.Equal("module", (await NodeOf("module note")).Kind);
		Assert.Equal("assembly", (await NodeOf("assembly value")).Kind);
	}

	[Fact]
	public async Task AnyNodeOfTheAssemblyScansTheWholeAssembly() {
		var (workspaceId, nodeId) = await OpenAsync();
		var all = await ScanAsync(workspaceId, nodeId);
		var greet = Find(all, "Hello, ").NodeId!;

		var fromMethod = await ScanAsync(workspaceId, greet);

		Assert.Equal(all.Select(reference => reference.Literal).Order(), fromMethod.Select(reference => reference.Literal).Order());
	}

	[Fact]
	public async Task ARefreshScansTheModulesTheScanBeforeRead() {
		var (workspaceId, nodeId) = await OpenAsync();
		var first = await manager.SearchStringReferencesAsync(new StringReferencesSearchRequest(workspaceId, [nodeId]), Token);

		var refresh = await manager.SearchStringReferencesAsync(new StringReferencesSearchRequest(workspaceId, ModulePaths: first.ModulePaths), Token);

		Assert.Equal([TargetPath], first.ModulePaths);
		Assert.Equal(first.References.Count, refresh.References.Count);
		// A module that is no longer open is dropped.
		var gone = await manager.SearchStringReferencesAsync(new StringReferencesSearchRequest(workspaceId, ModulePaths: ["/nowhere/Missing.dll"]), Token);
		Assert.Empty(gone.References);
		Assert.Empty(gone.ModulePaths);
	}

	[Fact]
	public async Task AScanSentInBatchesComesToWhatOnePassFinds() {
		var (workspaceId, nodeId) = await OpenAsync();
		var whole = await ScanAsync(workspaceId, nodeId);
		var batches = new List<StringReferencesProgressNotification>();

		var response = await manager.SearchStringReferencesAsync(
			new StringReferencesSearchRequest(workspaceId, [nodeId], ProgressToken: "scan-1"),
			progress => {
				batches.Add(progress);
				return Task.CompletedTask;
			},
			Token);

		Assert.NotEmpty(batches);
		Assert.All(batches, batch => Assert.Equal("scan-1", batch.ProgressToken));
		var sent = batches.SelectMany(batch => batch.References).ToList();
		Assert.Equal(sent.Count, response.Start);
		Assert.Equal(whole.Select(reference => (reference.Literal, reference.IlOffset)), sent.Concat(response.References).Select(reference => (reference.Literal, reference.IlOffset)));
	}
}
