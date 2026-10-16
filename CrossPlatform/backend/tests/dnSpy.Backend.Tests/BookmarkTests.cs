using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The backend half of the Bookmarks window: the Location column the way WPF dnSpy writes it, its bookmark file,
/// and the statement table and definition spans that let a bookmark be set in the IL view and on a declaration.
/// </summary>
public sealed class BookmarkTests : IDisposable {
	readonly WorkspaceManager manager = new();
	static readonly string DebugTargetPath = Path.Combine(AppContext.BaseDirectory, "DebugTarget.dll");
	static readonly string ContractsPath = typeof(HelloRequest).Assembly.Location;

	// dnSpy's BookmarkDisplaySettings defaults: tokens, parameter types and names, declaring types, return types and
	// keywords on; module names and namespaces off.
	static readonly BookmarkLocationFormatDto Defaults = new(
		ShowTokens: true,
		ShowModuleNames: false,
		ShowParameterTypes: true,
		ShowParameterNames: true,
		ShowDeclaringTypes: true,
		ShowReturnTypes: true,
		ShowNamespaces: false,
		ShowIntrinsicTypeKeywords: true);

	static uint TokenOf(string path, string typeName, Func<TypeDef, IMemberDef>? member = null) {
		using var module = ModuleDefMD.Load(path);
		var type = module.Find(typeName, isReflectionName: true) ?? throw new InvalidOperationException($"No type {typeName}.");
		return (member?.Invoke(type) ?? type).MDToken.Raw;
	}

	static uint MethodToken(string path, string typeName, string methodName) => TokenOf(path, typeName, type => type.FindMethod(methodName));

	async Task<IReadOnlyList<BookmarkLocationTextDto>> FormatAsync(BookmarkLocationFormatDto format, params BookmarkLocationDto[] locations) =>
		(await manager.FormatBookmarkLocationsAsync(new FormatBookmarkLocationsRequest(null, locations, format), TestContext.Current.CancellationToken)).Locations;

	static string Text(BookmarkLocationTextDto location) => string.Concat(location.Parts.Select(part => part.Text));

	[Fact]
	public async Task WritesABodyLocationTheWayTheWpfWindowDoes() {
		var calculate = MethodToken(DebugTargetPath, "DebugTarget.Program", "Calculate");
		var identity = MethodToken(DebugTargetPath, "DebugTarget.Program", "Identity");

		var located = await FormatAsync(Defaults,
			new BookmarkLocationDto(DebugTargetPath, unchecked((int)calculate), 2),
			new BookmarkLocationDto(DebugTargetPath, unchecked((int)identity), 0x12345));

		Assert.True(located[0].Resolved);
		Assert.Equal($"0x{calculate:X8} int Program.Calculate(int left, int right) + 0x0002", Text(located[0]));
		// The token, the keyword and the offset are each in the color dnSpy writes them in.
		Assert.Contains(located[0].Parts, part => part.Text == $"0x{calculate:X8}" && part.Color == TextColors.Number);
		Assert.Contains(located[0].Parts, part => part.Text == "int" && part.Color == TextColors.Keyword);
		Assert.Contains(located[0].Parts, part => part.Text == "Calculate" && part.Color == TextColors.StaticMethod);
		Assert.Contains(located[0].Parts, part => part.Text == "left" && part.Color == TextColors.Parameter);
		// A generic method lists its parameters; an offset past 0xFFFF takes eight digits.
		Assert.Equal($"0x{identity:X8} T Program.Identity<T>(T value) + 0x00012345", Text(located[1]));
	}

	[Fact]
	public async Task FollowsTheDisplayOptions() {
		var calculate = MethodToken(DebugTargetPath, "DebugTarget.Program", "Calculate");
		var location = new BookmarkLocationDto(DebugTargetPath, unchecked((int)calculate), 2);

		var bare = await FormatAsync(Defaults with {
			ShowTokens = false,
			ShowParameterNames = false,
			ShowReturnTypes = false,
			ShowNamespaces = true,
			ShowIntrinsicTypeKeywords = false,
		}, location);
		Assert.Equal("DebugTarget.Program.Calculate(System.Int32, System.Int32) + 0x0002", Text(bare[0]));

		var withModule = await FormatAsync(Defaults with { ShowTokens = false, ShowModuleNames = true, ShowDeclaringTypes = false, ShowParameterTypes = false }, location);
		Assert.Equal("DebugTarget.dll!int Calculate(left, right) + 0x0002", Text(withModule[0]));

		var noParameters = await FormatAsync(Defaults with { ShowTokens = false, ShowParameterTypes = false, ShowParameterNames = false }, location);
		Assert.Equal("int Program.Calculate + 0x0002", Text(noParameters[0]));
	}

	[Fact]
	public async Task WritesTheMembersATokenLocationCanName() {
		var helloRequest = TokenOf(ContractsPath, typeof(HelloRequest).FullName!);
		var nonce = TokenOf(ContractsPath, typeof(HelloRequest).FullName!, type => type.Properties.Single(property => property.Name == "Nonce"));
		var getNonce = MethodToken(ContractsPath, typeof(HelloRequest).FullName!, "get_Nonce");
		var helloField = TokenOf(ContractsPath, typeof(RpcMethods).FullName!, type => type.FindField("Hello"));
		var rpcExceptionConstructor = MethodToken(ContractsPath, typeof(RpcException).FullName!, ".ctor");
		var noOffset = (uint token) => new BookmarkLocationDto(ContractsPath, unchecked((int)token), null);

		var located = await FormatAsync(Defaults with { ShowTokens = false },
			noOffset(helloRequest), noOffset(nonce), noOffset(getNonce), noOffset(helloField), noOffset(rpcExceptionConstructor));

		Assert.All(located, location => Assert.True(location.Resolved));
		Assert.Equal("HelloRequest", Text(located[0]));
		// A record's positional property has an init-only setter.
		Assert.Equal("string HelloRequest.Nonce { get; init; }", Text(located[1]));
		Assert.Equal("string HelloRequest.Nonce.get", Text(located[2]));
		// Field types are not shown in the Bookmarks window.
		Assert.Equal("RpcMethods.Hello", Text(located[3]));
		// A constructor wears its type's name and no return type; a parameter with a default is bracketed.
		Assert.Equal("RpcException.RpcException(int code, string message, [object data], [Exception innerException])", Text(located[4]));
	}

	[Fact]
	public async Task WritesOnlyTheTokenForWhatCannotBeRead() {
		var located = await FormatAsync(Defaults,
			new BookmarkLocationDto(DebugTargetPath, 0x06FFFFFF, 0),
			new BookmarkLocationDto("/nowhere/Gone.dll", 0x06000001, null),
			// A body location only names a method; a type token there is as good as unknown.
			new BookmarkLocationDto(DebugTargetPath, unchecked((int)TokenOf(DebugTargetPath, "DebugTarget.Program")), 0));

		Assert.All(located, location => Assert.False(location.Resolved));
		Assert.Equal("0x06FFFFFF ???", Text(located[0]));
		Assert.Contains(located[0].Parts, part => part.Text == "???" && part.Color == TextColors.Error);
		Assert.Equal("0x06000001 ???", Text(located[1]));

		var bare = await FormatAsync(Defaults with { ShowTokens = false }, new BookmarkLocationDto("/nowhere/Gone.dll", 0x06000001, null));
		Assert.Equal("0x06000001", Text(bare[0]));
	}

	[Fact]
	public async Task ExportsTheWpfBookmarkFileAndReadsItBack() {
		var calculate = MethodToken(DebugTargetPath, "DebugTarget.Program", "Calculate");
		var program = TokenOf(DebugTargetPath, "DebugTarget.Program");
		BookmarkFileEntryDto[] bookmarks = [
			new(DebugTargetPath, unchecked((int)calculate), 7, "Loop head", ["hot", "loop"], true),
			new(DebugTargetPath, unchecked((int)program), null, "Bookmark 2", [], false),
			new("/nowhere/Gone.dll", 0x06000001, 3, "Elsewhere\twith a tab", [], true),
		];

		var exported = await manager.ExportBookmarksAsync(new ExportBookmarksRequest(null, bookmarks), TestContext.Current.CancellationToken);
		var xml = exported.Xml;

		Assert.StartsWith("<?xml version=\"1.0\" encoding=\"utf-8\"?>", xml, StringComparison.Ordinal);
		Assert.Contains("<section _=\"eaa1be38-7a55-44af-ad93-5b7ee2327edd\">", xml, StringComparison.Ordinal);
		Assert.Contains("<section _=\"Bookmark\" IsEnabled=\"True\" Labels=\"hot, loop\" Name=\"Loop head\">", xml, StringComparison.Ordinal);
		Assert.Contains("<section _=\"Bookmark\" IsEnabled=\"False\" Name=\"Bookmark 2\">", xml, StringComparison.Ordinal);
		Assert.Contains($"__BMT=\"DotNetBody\" AssemblyFullName=\"DebugTarget, Version=", xml, StringComparison.Ordinal);
		Assert.Contains($"ModuleName=\"{DebugTargetPath}\" Offset=\"7\" Token=\"{calculate}\" TokenString=\"System.Int32 DebugTarget.Program::Calculate(System.Int32,System.Int32)\"", xml, StringComparison.Ordinal);
		Assert.Contains($"__BMT=\"DotNetToken\"", xml, StringComparison.Ordinal);
		// A control character is escaped the way dnSpy's XmlUtils does it, and a module that cannot be read has
		// no assembly name and no token string to write.
		Assert.Contains("Name=\"Elsewhere©0009with a tab\"", xml, StringComparison.Ordinal);
		Assert.Contains("AssemblyFullName=\"\" ModuleName=\"/nowhere/Gone.dll\" Offset=\"3\" Token=\"100663297\" />", xml, StringComparison.Ordinal);
		Assert.DoesNotContain('\uFEFF', xml);

		var imported = await manager.ImportBookmarksAsync(new ImportBookmarksRequest(null, xml), TestContext.Current.CancellationToken);

		Assert.Equal(0, imported.Skipped);
		Assert.Equal(3, imported.Bookmarks.Count);
		Assert.Equal(DebugTargetPath, imported.Bookmarks[0].ModulePath);
		Assert.Equal(unchecked((int)calculate), imported.Bookmarks[0].MetadataToken);
		Assert.Equal(7, imported.Bookmarks[0].IlOffset);
		Assert.Equal("Loop head", imported.Bookmarks[0].Name);
		Assert.Equal(["hot", "loop"], imported.Bookmarks[0].Labels);
		Assert.True(imported.Bookmarks[0].Enabled);
		Assert.Equal("System.Int32 DebugTarget.Program::Calculate(System.Int32,System.Int32)", imported.Bookmarks[0].Description);
		Assert.Null(imported.Bookmarks[1].IlOffset);
		Assert.False(imported.Bookmarks[1].Enabled);
		Assert.Equal("DebugTarget.Program", imported.Bookmarks[1].Description);
		// A module this machine does not have is kept, unlike WPF, which would drop the bookmark.
		Assert.Equal("Elsewhere\twith a tab", imported.Bookmarks[2].Name);
		Assert.Equal("/nowhere/Gone.dll", imported.Bookmarks[2].ModulePath);
		Assert.Null(imported.Bookmarks[2].Description);
	}

	[Fact]
	public async Task SkipsWhatTheWpfReaderWouldDrop() {
		var calculate = MethodToken(DebugTargetPath, "DebugTarget.Program", "Calculate");
		var xml = $"""
			<?xml version="1.0" encoding="utf-8"?>
			<settings>
			  <section _="9C9A5E3B-C7E0-4F6B-A0C5-1A7C4D0A8F11" Other="x" />
			  <section _="EAA1BE38-7A55-44AF-AD93-5B7EE2327EDD">
			    <section _="Bookmark" IsEnabled="true" Name="Kept">
			      <section _="BML" __BMT="DotNetBody" AssemblyFullName="DebugTarget" ModuleName="{DebugTargetPath}" Offset="0x2" Token="{calculate}" />
			    </section>
			    <section _="Bookmark" IsEnabled="True" Name="Renamed member">
			      <section _="BML" __BMT="DotNetBody" AssemblyFullName="DebugTarget" ModuleName="{DebugTargetPath}" Offset="2" Token="{calculate}" TokenString="System.Void DebugTarget.Program::Gone()" />
			    </section>
			    <section _="Bookmark" IsEnabled="True" Name="In memory">
			      <section _="BML" __BMT="DotNetBody" AssemblyFullName="X" ModuleName="X.dll" IsInMemory="True" Offset="2" Token="100663297" />
			    </section>
			    <section _="Bookmark" IsEnabled="True" Name="No offset">
			      <section _="BML" __BMT="DotNetBody" AssemblyFullName="X" ModuleName="/x/X.dll" Token="100663297" />
			    </section>
			    <section _="Bookmark" Name="No enabled flag">
			      <section _="BML" __BMT="DotNetToken" AssemblyFullName="X" ModuleName="/x/X.dll" Token="100663297" />
			    </section>
			    <section _="Bookmark" IsEnabled="True" Name="Unknown kind">
			      <section _="BML" __BMT="Somewhere" AssemblyFullName="X" ModuleName="/x/X.dll" Token="100663297" />
			    </section>
			  </section>
			</settings>
			""";

		var imported = await manager.ImportBookmarksAsync(new ImportBookmarksRequest(null, xml), TestContext.Current.CancellationToken);

		var kept = Assert.Single(imported.Bookmarks);
		Assert.Equal("Kept", kept.Name);
		Assert.Equal(2, kept.IlOffset);
		Assert.Equal(5, imported.Skipped);

		await Assert.ThrowsAsync<RpcException>(() => manager.ImportBookmarksAsync(new ImportBookmarksRequest(null, "{ \"bookmarks\": [] }"), TestContext.Current.CancellationToken));
		await Assert.ThrowsAsync<RpcException>(() => manager.ImportBookmarksAsync(new ImportBookmarksRequest(null, "<bookmarks />"), TestContext.Current.CancellationToken));
	}

	[Fact]
	public async Task GivesTheIlViewAStatementPerInstructionAndDefinitionSpans() {
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([DebugTargetPath]), TestContext.Current.CancellationToken);
		var calculate = MethodToken(DebugTargetPath, "DebugTarget.Program", "Calculate");
		var found = await manager.FindMemberAsync(new FindMemberRequest(opened.WorkspaceId, DebugTargetPath, unchecked((int)calculate)), TestContext.Current.CancellationToken);
		Assert.NotNull(found.NodeId);

		foreach (var language in new[] { DecompilerLanguage.IL, DecompilerLanguage.ILWithCSharp }) {
			var document = await manager.DecompileAsync(new DecompileRequest(opened.WorkspaceId, found.NodeId, language), TestContext.Current.CancellationToken);
			var lines = document.Text.Split('\n').Select(line => line.TrimEnd('\r')).ToArray();
			var statements = document.CodeStatements;
			Assert.NotNull(statements);
			using var module = ModuleDefMD.Load(DebugTargetPath);
			var body = ((MethodDef)module.ResolveToken(calculate)).Body;
			Assert.Equal(body.Instructions.Count, statements.Count);
			for (var index = 0; index < statements.Count; index++) {
				var statement = statements[index];
				var line = lines[statement.StartLine - 1];
				// The statement's line is the instruction's, and its columns cover the line from "IL_" on.
				Assert.Equal(statement.StartLine, statement.EndLine);
				Assert.Equal($"IL_{statement.IlOffset:X4}:", line.Substring(statement.StartColumn - 1, 8));
				Assert.Equal(line.Length + 1, statement.EndColumn);
				Assert.Equal(unchecked((int)body.Instructions[index].Offset), statement.IlOffset);
				Assert.Equal(statement.IlOffset, statement.SequencePointIlOffset);
				var next = index + 1 < statements.Count ? statements[index + 1].IlOffset : unchecked((int)(body.Instructions[^1].Offset + (uint)body.Instructions[^1].GetSize()));
				Assert.Equal(next, statement.IlEndOffset);
				Assert.Equal(unchecked((int)calculate), statement.MetadataToken);
				Assert.Equal(statement.MetadataToken, statement.SourceMethodToken);
				Assert.Equal(DebugTargetPath, statement.ModulePath);
				Assert.Equal("System.Int32 DebugTarget.Program::Calculate(System.Int32,System.Int32)", statement.Description);
				Assert.False(statement.IsHidden);
			}

			// The method's name on its .method line is a definition, named by node, module and token.
			var definition = Assert.Single(document.Spans, span => span.Kind == "definition");
			Assert.Equal("Calculate", document.Text.Substring(definition.Start, definition.Length));
			Assert.Equal(found.NodeId, definition.TargetNodeId);
			Assert.Equal(DebugTargetPath, definition.TargetModulePath);
			Assert.Equal(unchecked((int)calculate), definition.TargetMetadataToken);
			Assert.StartsWith(".method", document.Text[..definition.Start].Split('\n')[^1], StringComparison.Ordinal);
		}
	}

	[Fact]
	public async Task GivesATypesIlViewADefinitionForEveryMemberItDeclares() {
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([DebugTargetPath]), TestContext.Current.CancellationToken);
		var program = TokenOf(DebugTargetPath, "DebugTarget.Program");
		var found = await manager.FindMemberAsync(new FindMemberRequest(opened.WorkspaceId, DebugTargetPath, unchecked((int)program)), TestContext.Current.CancellationToken);

		var document = await manager.DecompileAsync(new DecompileRequest(opened.WorkspaceId, found.NodeId!, DecompilerLanguage.IL), TestContext.Current.CancellationToken);

		var names = document.Spans.Where(span => span.Kind == "definition").Select(span => document.Text.Substring(span.Start, span.Length)).ToArray();
		Assert.Contains("DebugTarget.Program", names);
		Assert.Contains("Main", names);
		Assert.Contains("Calculate", names);
		Assert.All(document.Spans.Where(span => span.Kind == "definition"), span => Assert.Equal(DebugTargetPath, span.TargetModulePath));
		// What an instruction names is a reference, which — as in C# — names a node of the workspace by its id alone.
		var calculate = Assert.Single(document.Spans, span => span.Kind == "definition" && document.Text.Substring(span.Start, span.Length) == "Calculate");
		var call = Assert.Single(document.Spans, span => span.Kind == "reference" && span.TargetNodeId == calculate.TargetNodeId);
		Assert.Equal("Calculate", document.Text.Substring(call.Start, call.Length));
		Assert.Null(call.TargetModulePath);
		// Every method's instructions are in the table, each on its own line.
		Assert.Equal(document.CodeStatements!.Count, document.CodeStatements.Select(statement => statement.StartLine).Distinct().Count());
	}

	[Fact]
	public async Task NamesACSharpDefinitionByModuleAndTokenButNotAReference() {
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([DebugTargetPath]), TestContext.Current.CancellationToken);
		var calculate = MethodToken(DebugTargetPath, "DebugTarget.Program", "Calculate");
		var main = MethodToken(DebugTargetPath, "DebugTarget.Program", "Main");
		var calculateNode = await manager.FindMemberAsync(new FindMemberRequest(opened.WorkspaceId, DebugTargetPath, unchecked((int)calculate)), TestContext.Current.CancellationToken);
		var mainNode = await manager.FindMemberAsync(new FindMemberRequest(opened.WorkspaceId, DebugTargetPath, unchecked((int)main)), TestContext.Current.CancellationToken);

		var document = await manager.DecompileAsync(new DecompileRequest(opened.WorkspaceId, mainNode.NodeId!, DecompilerLanguage.CSharp), TestContext.Current.CancellationToken);

		var definition = Assert.Single(document.Spans, span => span.Kind == "definition" && span.TargetNodeId == mainNode.NodeId);
		Assert.Equal(DebugTargetPath, definition.TargetModulePath);
		Assert.Equal(unchecked((int)main), definition.TargetMetadataToken);
		// The call to Calculate is a reference into the workspace: its node is enough to follow it. (The decompiler
		// makes the call's parentheses references to it too.)
		var call = Assert.Single(document.Spans, span => span.Kind == "reference" && span.TargetNodeId == calculateNode.NodeId
			&& document.Text.Substring(span.Start, span.Length) == "Calculate");
		Assert.Null(call.TargetModulePath);
		Assert.Null(call.TargetMetadataToken);
		Assert.All(document.Spans.Where(span => span.Kind == "reference" && span.TargetNodeId is not null), span => Assert.Null(span.TargetModulePath));
	}

	public void Dispose() => manager.Dispose();
}
