using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using dnlib.DotNet;
using dnlib.DotNet.Emit;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

public sealed class WorkspaceManagerTests : IDisposable {
	readonly WorkspaceManager manager = new();

	[Fact]
	public async Task OpensAssemblyAndProvidesLazyTreeAndDecompilation() {
		var opened = await OpenContractsAssemblyAsync();
		var roots = await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);

		var assembly = Assert.Single(roots.Nodes);
		Assert.Equal(opened.Modules[0].Id, assembly.Id);
		Assert.Equal("assembly", assembly.Kind);
		var module = Assert.Single(await ChildrenAsync(opened.WorkspaceId, assembly.Id), node => node.Kind == "module");
		Assert.Equal("module", module.Kind);
		Assert.True(module.HasChildren);

		var moduleChildren = await manager.GetChildrenAsync(
			new NodeRequest(opened.WorkspaceId, module.Id),
			TestContext.Current.CancellationToken);
		var contractNamespace = Assert.Single(moduleChildren.Nodes, n => n.Label == "dnSpy.Backend.Contracts");

		var namespaceChildren = await manager.GetChildrenAsync(
			new NodeRequest(opened.WorkspaceId, contractNamespace.Id),
			TestContext.Current.CancellationToken);
		var helloRequest = Assert.Single(namespaceChildren.Nodes, n => n.Label == "HelloRequest");

		var csharp = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, helloRequest.Id, DecompilerLanguage.CSharp),
			TestContext.Current.CancellationToken);
		Assert.Equal("csharp", csharp.Language);
		Assert.Contains("record HelloRequest", csharp.Text, StringComparison.Ordinal);
		Assert.Contains(csharp.Spans, span => span.Kind == "definition" && span.TargetNodeId == helloRequest.Id);

		var il = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, helloRequest.Id, DecompilerLanguage.IL),
			TestContext.Current.CancellationToken);
		Assert.Equal("il", il.Language);
		Assert.Contains(".class", il.Text, StringComparison.Ordinal);
		Assert.Contains("HelloRequest", il.Text, StringComparison.Ordinal);

		var rpcException = Assert.Single(namespaceChildren.Nodes, n => n.Label == "RpcException");
		var rpcMembers = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, rpcException.Id), TestContext.Current.CancellationToken);
		var getCode = await FindAccessorAsync(opened.WorkspaceId, rpcMembers.Nodes, "Code", "get_Code()");
		var getCodeDocument = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, getCode.Id, DecompilerLanguage.CSharp),
			TestContext.Current.CancellationToken);
		Assert.Contains(getCodeDocument.Spans, span => span.Kind == "reference" && span.TargetNodeId is not null && span.TargetNodeId != getCode.Id);
		var mixed = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, getCode.Id, DecompilerLanguage.ILWithCSharp),
			TestContext.Current.CancellationToken);
		Assert.Equal("il", mixed.Language);
		Assert.Contains(".method", mixed.Text, StringComparison.Ordinal);
		Assert.Contains("IL_", mixed.Text, StringComparison.Ordinal);
		Assert.True(
			mixed.Text.IndexOf("//", StringComparison.Ordinal) < mixed.Text.IndexOf("IL_", StringComparison.Ordinal),
			$"Expected decompiled C# before the matching IL instructions:{Environment.NewLine}{mixed.Text}");
		var codeProperty = Assert.Single(rpcMembers.Nodes, member => member.Kind == "property" && member.Label == "Code");
		var mixedProperty = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, codeProperty.Id, DecompilerLanguage.ILWithCSharp),
			TestContext.Current.CancellationToken);
		Assert.Contains(".property", mixedProperty.Text, StringComparison.Ordinal);
		Assert.Contains(".method", mixedProperty.Text, StringComparison.Ordinal);
		Assert.Contains("//", mixedProperty.Text, StringComparison.Ordinal);
		var visualBasic = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, rpcException.Id, DecompilerLanguage.VisualBasic),
			TestContext.Current.CancellationToken);
		Assert.Equal("visual-basic", visualBasic.Language);
		Assert.Contains("Class RpcException", visualBasic.Text, StringComparison.OrdinalIgnoreCase);
	}

	/// <summary>
	/// A type's row hangs the two folders dnSpy's tree puts there — "Base Type and Interfaces" and
	/// "Derived Types" — ahead of its members. The base type folder lists the base type and then every
	/// interface, each a metadata row; the derived types folder lists the types that derive from it, and
	/// a sealed type is not even offered one.
	/// </summary>
	[Fact]
	public async Task TypeChildren_StartWithTheBaseTypeAndDerivedTypesFolders() {
		var path = Path.Combine(AppContext.BaseDirectory, "DebugTarget.dll");
		Assert.True(File.Exists(path), $"The debuggee was not copied to the test output: {path}");
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
		var program = await FindTypeAsync(opened.WorkspaceId, "DebugTarget", "Program");
		var nested = await ChildrenAsync(opened.WorkspaceId, program.Id);

		// Program's nested types — the interface and the class that implements it — are members like any
		// other, so they sit after the two folders.
		var worker = Assert.Single(nested, node => node.Kind == "type" && node.Label == "Worker");
		var workerChildren = await ChildrenAsync(opened.WorkspaceId, worker.Id);
		Assert.Equal("basetypefolder", workerChildren[0].Kind);
		Assert.Equal("Base Type and Interfaces", workerChildren[0].Label);
		Assert.True(workerChildren[0].HasChildren);
		Assert.Equal("derivedtypesfolder", workerChildren[1].Kind);
		Assert.Equal("Derived Types", workerChildren[1].Label);
		// Worker is sealed, so nothing can derive from it and its folder is not offered at all.
		Assert.False(workerChildren[1].HasChildren);
		Assert.Contains(workerChildren.Skip(2), node => node.Kind == "method" && node.Label == "Work()");

		// The base type row names the type the decompiler writes ("object") while the tooltip keeps the
		// full name, and it carries the reference's metadata token. The interface follows the base type,
		// its own name spelled the way the decompiler spells a nested type.
		var workerBaseTypes = await ChildrenAsync(opened.WorkspaceId, workerChildren[0].Id);
		Assert.Equal("basetype", workerBaseTypes[0].Kind);
		Assert.Equal("object", workerBaseTypes[0].Label);
		Assert.Equal("System.Object", workerBaseTypes[0].Description);
		Assert.Equal("ClassPublic", workerBaseTypes[0].Icon);
		Assert.NotNull(workerBaseTypes[0].MetadataToken);
		Assert.True(workerBaseTypes[0].HasChildren);
		var implemented = Assert.Single(workerBaseTypes, node => node.Label == "Program.IWorker");
		Assert.Equal("basetype", implemented.Kind);
		Assert.Equal("InterfacePrivate", implemented.Icon);

		// The interface resolves to the type this workspace already holds, so expanding it walks that
		// type's own base type and interfaces — the interface has neither, so the walk ends there.
		Assert.Empty(await ChildrenAsync(opened.WorkspaceId, implemented.Id));

		// The interface's own derived types folder finds the class that implements it, and both the folder
		// and the row decompile to a comment naming it, as dnSpy's NodeDecompiler writes them.
		var iface = Assert.Single(nested, node => node.Kind == "type" && node.Label == "IWorker");
		var ifaceChildren = await ChildrenAsync(opened.WorkspaceId, iface.Id);
		var derivedTypes = Assert.Single(ifaceChildren, node => node.Kind == "derivedtypesfolder");
		Assert.True(derivedTypes.HasChildren);
		var derived = Assert.Single(await ChildrenAsync(opened.WorkspaceId, derivedTypes.Id), node => node.Kind == "derivedtype");
		Assert.Equal("Worker", derived.Label);
		Assert.Equal("DebugTarget.Program/Worker", derived.Description);
		Assert.Equal("ClassPrivate", derived.Icon);
		Assert.NotNull(derived.MetadataToken);
		Assert.False(derived.HasChildren);
		// NodeDecompiler writes the type's ReflectionFullName, which joins a nested type with a plus.
		Assert.Equal($"// DebugTarget.Program+Worker{Environment.NewLine}", await DocumentTextAsync(opened.WorkspaceId, derived.Id));
		Assert.Equal($"// DebugTarget.Program+Worker{Environment.NewLine}", await DocumentTextAsync(opened.WorkspaceId, derivedTypes.Id));
	}

	/// <summary>
	/// The derived types search spans every module the workspace holds, which is what dnSpy's finder does:
	/// a type in one open assembly derives from an interface in another and the interface's folder names it.
	/// </summary>
	[Fact]
	public async Task DerivedTypes_FindATypeInAnotherOpenModule() {
		var opened = await manager.OpenAsync(
			new OpenWorkspaceRequest([typeof(HelloRequest).Assembly.Location, typeof(WorkspaceManager).Assembly.Location]),
			TestContext.Current.CancellationToken);

		var resolver = await FindTypeInModuleAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", "dnSpy.Backend.Contracts", "IDebugSymbolResolver");
		var children = await ChildrenAsync(opened.WorkspaceId, resolver.Id);
		var derivedTypes = Assert.Single(children, node => node.Kind == "derivedtypesfolder");

		var derived = Assert.Single(await ChildrenAsync(opened.WorkspaceId, derivedTypes.Id), node => node.Kind == "derivedtype");
		Assert.Equal("WorkspaceManager", derived.Label);
		Assert.Equal("dnSpy.Backend.Core.WorkspaceManager", derived.Description);
	}

	/// <summary>
	/// A method's tab wears the WPF title — "name(params) : return" — while its tree label keeps the short
	/// form, because the row already has a tooltip with the full signature and the tab does not. The row
	/// itself is composed on the client from the token and return type below.
	/// </summary>
	[Fact]
	public async Task DecompileMethod_TitleCarriesTheReturnTypeButTheTreeLabelDoesNot() {
		var (_, opened, node, document) = await OpenMethodDocumentAsync("Calculate(");

		Assert.Equal("Calculate(int, int)", node.Label);
		Assert.Equal("Calculate(int, int) : int", document.Title);

		// The IL document of the same method names it the same way, whatever language opened it.
		var il = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, node.Id, DecompilerLanguage.IL),
			TestContext.Current.CancellationToken);
		Assert.Equal(document.Title, il.Title);
	}

	/// <summary>
	/// The tree DTO hands the client the raw pieces dnSpy's NodeFormatter composes a row out of — the
	/// metadata token of anything that is a metadata row, and the type a member's row names after the
	/// colon — while the label itself stays the bare name that bookmarks and output messages quote.
	/// The document rows carry their token too, since dnSpy's document nodes expose one to the commands
	/// that copy it, even though the row itself writes no token for a document or a namespace.
	/// </summary>
	[Fact]
	public async Task TreeNodes_CarryTokenAndReturnTypeForTheClientToFormatRowsWith() {
		var path = typeof(HelloRequest).Assembly.Location;
		using var module = ModuleDefMD.Load(path);
		var getCode = module.GetTypes().Single(type => type.Name == "RpcException").Methods.Single(method => method.Name == "get_Code");

		var opened = await OpenContractsAssemblyAsync();
		var roots = await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		var assembly = Assert.Single(roots.Nodes);
		Assert.True(assembly.MetadataToken.HasValue, "The assembly node exposes its token to the copy-token command even though its row writes none.");

		var moduleNode = Assert.Single(await ChildrenAsync(opened.WorkspaceId, assembly.Id), node => node.Kind == "module");
		Assert.True(moduleNode.MetadataToken.HasValue);
		var contractNamespace = Assert.Single(await ChildrenAsync(opened.WorkspaceId, moduleNode.Id), n => n.Label == "dnSpy.Backend.Contracts");
		// A namespace and the group folders are no metadata rows, so dnSpy writes no token for them.
		Assert.Null(contractNamespace.MetadataToken);
		Assert.Null(contractNamespace.ReturnType);

		var helloRequest = Assert.Single(await ChildrenAsync(opened.WorkspaceId, contractNamespace.Id), n => n.Label == "HelloRequest");
		Assert.True(helloRequest.MetadataToken.HasValue);
		Assert.Null(helloRequest.ReturnType);

		var rpcException = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", "RpcException");
		var rpcMembers = await ChildrenAsync(opened.WorkspaceId, rpcException.Id);
		var getCodeNode = await FindAccessorAsync(opened.WorkspaceId, rpcMembers, "Code", "get_Code()");
		Assert.Equal(unchecked((int)getCode.MDToken.Raw), getCodeNode.MetadataToken);
		Assert.Equal("int", getCodeNode.ReturnType);
		var codeProperty = Assert.Single(rpcMembers, member => member.Kind == "property" && member.Label == "Code");
		Assert.Equal("int", codeProperty.ReturnType);
		Assert.True(codeProperty.MetadataToken.HasValue);
	}

	/// <summary>
	/// The types a row writes after the colon and inside a parameter list carry the C# decompiler's
	/// spelling — System.Int32 as "int", a generic instance with its actual arguments — because that
	/// is what the WPF tree shows, not the CLR names dnlib hands out.
	/// </summary>
	[Fact]
	public async Task TreeNodes_WriteMemberTypesTheWayTheCSharpDecompilerSpellsThem() {
		var opened = await OpenContractsAssemblyAsync();
		var helloResponse = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", "HelloResponse");
		var members = await ChildrenAsync(opened.WorkspaceId, helloResponse.Id);
		var capabilities = Assert.Single(members, member => member.Kind == "property" && member.Label == "Capabilities");
		Assert.Equal("IReadOnlyDictionary<string, bool>", capabilities.ReturnType);
		// The primary constructor wears its parameter list; the record's copy constructor is the other one. A
		// constructor row is named after its type, the way dnSpy's NodeFormatter writes it.
		Assert.Single(members, member => member.Label == "HelloResponse(int, string, string, string, string, IReadOnlyDictionary<string, bool>)");

		var openRequest = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", "OpenWorkspaceRequest");
		var openRequestMembers = await ChildrenAsync(opened.WorkspaceId, openRequest.Id);
		Assert.Single(openRequestMembers, member => member.Label == "OpenWorkspaceRequest(IReadOnlyList<string>)");
	}

	[Fact]
	public async Task DecompileWholeType_ProducesCodeStatements() {
		// The contracts assembly is nearly all primary-constructor records and constants, so almost none of it has
		// a body to map. The workspace manager is the opposite: it and its nested types are all code. A module
		// document is only its header and attributes (dnSpy's AddAssembly with onlyAssemblyLevel), so the largest
		// document with statements is a type's.
		var opened = await manager.OpenAsync(
			new OpenWorkspaceRequest([typeof(WorkspaceManager).Assembly.Location]),
			TestContext.Current.CancellationToken);
		var type = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Core", "WorkspaceManager");

		var csharp = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, type.Id, DecompilerLanguage.CSharp),
			TestContext.Current.CancellationToken);

		var statements = Assert.IsAssignableFrom<IReadOnlyList<CodeStatementDto>>(csharp.CodeStatements);
		AssertStatementsLookSane(statements, csharp.Text);

		// The type document has to cover every body in it, nested types included.
		var bodies = statements.Where(statement => !statement.IsHidden).Select(statement => statement.MetadataToken).Distinct().Count();
		Assert.True(bodies > 100, $"The whole-type statement map covers only {bodies} method bodies.");
		Assert.Contains(statements, statement => statement.Description.Contains("dnSpy.Backend.Core.WorkspaceManager::", StringComparison.Ordinal));

		// A breakpoint must land on the same IL offset whichever document it was set from, so the type map has
		// to agree with what the standalone method view of the same body reports.
		var members = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, type.Id), TestContext.Current.CancellationToken);
		var typeIdentities = statements.Where(statement => !statement.IsHidden).Select(statement => (statement.MetadataToken, statement.IlOffset)).ToHashSet();
		// Constructors are the one exception and are checked against a plain method instead: a field initializer
		// is written on the field, so the type document maps its IL to the field declaration while the method
		// document maps the same IL to the constructor body. Only the initializers' offsets line up between them.
		// A constructor row is named after its type, so it is told apart by that name rather than by ".ctor".
		foreach (var member in members.Nodes.Where(node => node.Kind == "method" && !node.Label.StartsWith("WorkspaceManager(", StringComparison.Ordinal) && !node.Label.StartsWith('.'))) {
			var view = await manager.DecompileAsync(
				new DecompileRequest(opened.WorkspaceId, member.Id, DecompilerLanguage.CSharp),
				TestContext.Current.CancellationToken);
			var body = (view.CodeStatements ?? []).Where(statement => !statement.IsHidden).ToArray();
			if (body.Length == 0)
				continue;
			Assert.All(body, statement => Assert.Contains((statement.MetadataToken, statement.IlOffset), typeIdentities));
			// A plain method's IL lives in the token the user sees, not in a generated state machine.
			Assert.Equal(body[0].MetadataToken, body[0].SourceMethodToken);
			Assert.EndsWith(".dll", body[0].ModulePath, StringComparison.OrdinalIgnoreCase);
			return;
		}
		Assert.Fail("No method of the workspace manager produced a statement map.");
	}

	/// <summary>
	/// A reference whose target belongs to an assembly the workspace does not hold is still navigable: the
	/// span names the file the target lives in and the token it has there, and looking that pair up opens
	/// the module — the way dnSpy's own reference navigation loads an assembly on demand — instead of
	/// leaving the reference with no target to go to at all.
	/// </summary>
	[Fact]
	public async Task ReferenceIntoAnAssemblyTheWorkspaceDoesNotHoldIsFollowedOnDemand() {
		// The manager's own module names types the workspace holds nothing of — its own product's other
		// assemblies — so its document is full of references that have a target to find rather than a
		// definition in a module already open.
		var opened = await manager.OpenAsync(
			new OpenWorkspaceRequest([typeof(WorkspaceManager).Assembly.Location]),
			TestContext.Current.CancellationToken);
		var type = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Core", "WorkspaceManager");
		var document = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, type.Id, DecompilerLanguage.CSharp),
			TestContext.Current.CancellationToken);

		var span = document.Spans.First(span =>
			span.TargetNodeId is null && span.TargetMetadataToken is > 0 && !string.IsNullOrEmpty(span.TargetModulePath));
		Assert.False(string.Equals(span.TargetModulePath, typeof(WorkspaceManager).Assembly.Location, StringComparison.Ordinal));
		Assert.True(File.Exists(span.TargetModulePath), $"The reference names a file that is not on this machine: {span.TargetModulePath}");
		var identity = new FindMemberRequest(opened.WorkspaceId, span.TargetModulePath!, span.TargetMetadataToken!.Value);
		var rootsBefore = (await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Nodes.Count;

		var found = await manager.FindMemberAsync(identity, TestContext.Current.CancellationToken);

		Assert.NotNull(found.NodeId);
		// The file was opened into the tree, and what the client was handed is a node of it — the caller
		// refreshes its roots to see the module, which is why the lookup has to answer a node id at all.
		var roots = (await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Nodes;
		Assert.Equal(rootsBefore + 1, roots.Count);
		Assert.Equal(found.NodeId, (await manager.GetNodeAsync(new NodeRequest(opened.WorkspaceId, found.NodeId!), TestContext.Current.CancellationToken)).Id);
		// The module is open now, so asking a second time answers the same node and adds nothing.
		Assert.Equal(found, await manager.FindMemberAsync(identity, TestContext.Current.CancellationToken));
	}

	/// <summary>
	/// A member identity is looked up in the module the request names: one the workspace already holds is
	/// answered where it is, and one this machine does not have is a reference with nowhere to go rather
	/// than a failure the caller has to handle.
	/// </summary>
	[Fact]
	public async Task FindMember_AnswersForAnOpenModuleAndForNothingElse() {
		var opened = await OpenContractsAssemblyAsync();
		var helloRequest = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", "HelloRequest");
		var token = unchecked((int)typeof(HelloRequest).MetadataToken);

		var found = await manager.FindMemberAsync(
			new FindMemberRequest(opened.WorkspaceId, typeof(HelloRequest).Assembly.Location, token),
			TestContext.Current.CancellationToken);
		Assert.Equal(helloRequest.Id, found.NodeId);

		var missing = Path.Combine(Path.GetTempPath(), $"dnspy-missing-{Guid.NewGuid():N}.dll");
		var absent = await manager.FindMemberAsync(new FindMemberRequest(opened.WorkspaceId, missing, token), TestContext.Current.CancellationToken);
		Assert.Null(absent.NodeId);
	}

	/// <summary>
	/// The offset a statement hands the engine has to be where that statement's own code starts. Tiling the
	/// method's IL charges every offset that belongs to no statement to the statement that follows it, which
	/// in a loop makes the <c>return</c> report the loop's own condition: a breakpoint set there runs the loop
	/// again instead of stopping on the line the user clicked. The debuggee ships a PDB, so the offsets it
	/// records can say whether the map is right.
	/// </summary>
	[Fact]
	public async Task CodeStatements_StartAtTheStatementsOwnCode() {
		var path = Path.Combine(AppContext.BaseDirectory, "DebugTarget.dll");
		Assert.True(File.Exists(path), $"The debuggee was not copied to the test output: {path}");
		using var module = ModuleDefMD.Load(path);
		var calculate = module.GetTypes().SelectMany(type => type.Methods).Single(method => method.Name == "Calculate");
		var token = unchecked((int)calculate.MDToken.Raw);

		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
		var program = await FindTypeAsync(opened.WorkspaceId, "DebugTarget", "Program");
		var members = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, program.Id), TestContext.Current.CancellationToken);
		var calculateNode = Assert.Single(members.Nodes, node => node.Label.StartsWith("Calculate(", StringComparison.Ordinal));
		var document = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, calculateNode.Id, DecompilerLanguage.CSharp),
			TestContext.Current.CancellationToken);

		var statements = (document.CodeStatements ?? [])
			.Where(statement => !statement.IsHidden && statement.MetadataToken == token)
			.OrderBy(statement => statement.IlOffset)
			.ToArray();
		Assert.NotEmpty(statements);
		var points = ReadSequencePoints(Path.ChangeExtension(path, ".pdb"), calculate.MDToken.ToInt32());
		// Hidden points mark IL that belongs to no source line, and an offset between two points is one the
		// engine cannot bind, so no statement may start on either — the loop's flag at IL_0014 is not the
		// return's code, even though the tiling hands it over.
		Assert.All(statements, statement => Assert.Contains(points, point => !point.IsHidden && point.Offset == statement.IlOffset));

		// The return's own code is the load of the returned value and the copy the compiler makes of it; the
		// branch out of the method after that is the exit's, not the line's. Staying inside the point it
		// starts on says so, and a statement started on the loop's flag would have to reach past it.
		var returnStatement = Assert.Single(statements, statement => statement.StartLine == LineOf(document.Text, "return num;"));
		var index = points.FindIndex(point => point.Offset == returnStatement.IlOffset);
		Assert.True(index >= 0, $"No sequence point starts at IL_{returnStatement.IlOffset:X4}.");
		// A point ends where the next one starts, and the last one at the end of the method's IL.
		var last = calculate.Body.Instructions[^1];
		var end = index + 1 < points.Count ? points[index + 1].Offset : (int)last.Offset + last.GetSize();
		Assert.InRange(returnStatement.IlEndOffset, returnStatement.IlOffset + 1, end);
	}

	/// <summary>
	/// The Visual Basic view carries the C# statements over — dnSpy's Visual Basic decompiler writes its statements
	/// with their IL too — and a member's document is the member itself, not an empty type.
	/// </summary>
	[Fact]
	public async Task VisualBasicDocument_CarriesTheStatementsOfTheCSharpOne() {
		var path = Path.Combine(AppContext.BaseDirectory, "DebugTarget.dll");
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
		var program = await FindTypeAsync(opened.WorkspaceId, "DebugTarget", "Program");
		var members = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, program.Id), TestContext.Current.CancellationToken);
		var calculateNode = Assert.Single(members.Nodes, node => node.Label.StartsWith("Calculate(", StringComparison.Ordinal));
		var csharp = await manager.DecompileAsync(new DecompileRequest(opened.WorkspaceId, calculateNode.Id, DecompilerLanguage.CSharp), TestContext.Current.CancellationToken);
		var visualBasic = await manager.DecompileAsync(new DecompileRequest(opened.WorkspaceId, calculateNode.Id, DecompilerLanguage.VisualBasic), TestContext.Current.CancellationToken);

		Assert.Equal("visual-basic", visualBasic.Language);
		Assert.Contains("Function Calculate(", visualBasic.Text, StringComparison.Ordinal);
		Assert.DoesNotContain("SurroundingClass", visualBasic.Text, StringComparison.Ordinal);
		Assert.DoesNotContain("dnSpyStatement", visualBasic.Text, StringComparison.Ordinal);
		Assert.DoesNotContain("DnSpyMemberHost", visualBasic.Text, StringComparison.Ordinal);
		var lines = visualBasic.Text.Split('\n');
		var statements = (visualBasic.CodeStatements ?? []).Where(statement => !statement.IsHidden).ToArray();
		Assert.NotEmpty(statements);
		// Every C# statement of the body is somewhere in the Visual Basic text, with the IL it had.
		var csharpOffsets = (csharp.CodeStatements ?? []).Where(statement => !statement.IsHidden).Select(statement => statement.IlOffset).Order().ToArray();
		Assert.Equal(csharpOffsets, statements.Select(statement => statement.IlOffset).Order().ToArray());
		string LineText(CodeStatementDto statement) => lines[statement.StartLine - 1];
		var returnOffset = Assert.Single(csharp.CodeStatements!, statement => !statement.IsHidden && statement.StartLine == LineOf(csharp.Text, "return num;")).IlOffset;
		Assert.Contains("Return ", LineText(Assert.Single(statements, statement => statement.IlOffset == returnOffset)), StringComparison.Ordinal);
		var sumOffset = Assert.Single(csharp.CodeStatements!, statement => !statement.IsHidden && statement.StartLine == LineOf(csharp.Text, "num += left;")).IlOffset;
		Assert.Contains("num += left", LineText(Assert.Single(statements, statement => statement.IlOffset == sumOffset)), StringComparison.Ordinal);
		// The loop's parts have no statement of their own in Visual Basic: they are the For line's.
		var loopOffsets = csharp.CodeStatements!.Where(statement => !statement.IsHidden && statement.StartLine == LineOf(csharp.Text, "for (")).Select(statement => statement.IlOffset).ToArray();
		Assert.NotEmpty(loopOffsets);
		Assert.All(loopOffsets, offset => Assert.Contains("For ", LineText(Assert.Single(statements, statement => statement.IlOffset == offset)), StringComparison.Ordinal));
	}

	/// <summary>The PDB's sequence points for a method, in IL order.</summary>
	static List<SequencePoint> ReadSequencePoints(string pdbPath, int methodToken) {
		using var stream = File.OpenRead(pdbPath);
		using var provider = MetadataReaderProvider.FromPortablePdbStream(stream);
		var pdb = provider.GetMetadataReader();
		// PDB rows are numbered like the metadata rows they describe, so the method's row number keys them.
		var debug = pdb.GetMethodDebugInformation(MetadataTokens.MethodDebugInformationHandle(methodToken & 0x00FFFFFF));
		return debug.GetSequencePoints()
			.OrderBy(point => point.Offset)
			.ToList();
	}

	static int LineOf(string text, string needle) {
		var lines = text.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
		for (var index = 0; index < lines.Length; index++) {
			if (lines[index].Contains(needle, StringComparison.Ordinal))
				return index + 1;
		}
		return 0;
	}

	[Fact]
	public async Task ResolveBreakpoints_SnapsToNearestStatement() {
		var opened = await OpenContractsAssemblyAsync();
		var rpcException = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", "RpcException");
		var csharp = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, rpcException.Id, DecompilerLanguage.CSharp),
			TestContext.Current.CancellationToken);
		var statements = Assert.IsAssignableFrom<IReadOnlyList<CodeStatementDto>>(csharp.CodeStatements);
		var first = statements.OrderBy(statement => statement.StartLine).ThenBy(statement => statement.StartColumn).First();
		// Line 1 is a using directive or the namespace header. The test needs that not to be a statement itself,
		// or it would be asserting the trivial case of a click landing exactly on a sequence point.
		Assert.True(first.StartLine > 1, $"Expected the first statement below line 1, found line {first.StartLine}.");
		Assert.DoesNotContain(statements, statement => statement.StartLine <= 1 && statement.EndLine >= 1);

		var response = await manager.ResolveBreakpointsAsync(
			opened.WorkspaceId,
			[new BreakpointQuery("on", rpcException.Id, first.StartLine), new BreakpointQuery("above", rpcException.Id, 1)],
			TestContext.Current.CancellationToken);

		var on = Assert.Single(response.Breakpoints, breakpoint => breakpoint.Id == "on");
		var above = Assert.Single(response.Breakpoints, breakpoint => breakpoint.Id == "above");
		Assert.True(on.Bound, on.Reason);
		Assert.True(above.Bound, above.Reason);
		// A click above every statement snaps down to the same sequence point the exact hit resolves to; the
		// snapped line travels back with it, which is what the editor echoes in the gutter.
		Assert.Equal(on.ModulePath, above.ModulePath);
		Assert.Equal(on.MetadataToken, above.MetadataToken);
		Assert.Equal(on.IlOffset, above.IlOffset);
		Assert.NotEqual(1, above.StartLine);
		Assert.Equal(first.StartLine, on.StartLine);
		Assert.Equal(on.StartLine, above.StartLine);
		Assert.Equal(on.StartColumn, above.StartColumn);
	}

	[Fact]
	public async Task ResolveBreakpoints_UnboundWhenNoSequencePoint() {
		// An interface method has no body and therefore no sequence points: its document renders, but nothing in
		// it maps to IL. The request has to come back unbound with a reason rather than inventing an offset.
		var opened = await OpenContractsAssemblyAsync();
		var resolver = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", "IDebugSymbolResolver");
		var members = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, resolver.Id), TestContext.Current.CancellationToken);
		var method = Assert.Single(members.Nodes, node => node.Label.StartsWith("FindMethods", StringComparison.Ordinal));

		var document = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, method.Id, DecompilerLanguage.CSharp),
			TestContext.Current.CancellationToken);
		Assert.Empty(document.CodeStatements ?? []);
		Assert.Contains("FindMethodsAsync", document.Text, StringComparison.Ordinal);

		var response = await manager.ResolveBreakpointsAsync(
			opened.WorkspaceId,
			[new BreakpointQuery("no-point", method.Id, 1)],
			TestContext.Current.CancellationToken);

		var breakpoint = Assert.Single(response.Breakpoints);
		Assert.False(breakpoint.Bound);
		Assert.False(string.IsNullOrWhiteSpace(breakpoint.Reason));
		Assert.Null(breakpoint.ModulePath);
		Assert.Null(breakpoint.MetadataToken);
		Assert.Null(breakpoint.IlOffset);
	}

	/// <summary>
	/// A breakpoint read back from settings names a node id the workspace that saved it issued, which this
	/// workspace has never heard of. What survives a restart is the location WPF dnSpy persists — module,
	/// token and IL offset — and that has to be enough to bind, without the document ever having been
	/// opened here.
	/// </summary>
	[Fact]
	public async Task ResolveBreakpoints_BindsASavedLocationWithoutItsNodeId() {
		var (path, opened, node, document) = await OpenMethodDocumentAsync("Calculate(");
		var statement = Assert.Single(
			(document.CodeStatements ?? []).Where(candidate => !candidate.IsHidden),
			candidate => candidate.StartLine == LineOf(document.Text, "+="));

		var response = await manager.ResolveBreakpointsAsync(
			opened.WorkspaceId,
			[
				// The id is shaped like one this workspace could hand out, and belongs to nothing in it.
				new BreakpointQuery("saved", node.Id + "-from-a-previous-run", statement.StartLine,
					null, path, statement.MetadataToken, statement.SourceMethodToken, statement.IlOffset),
				// Nothing was saved with this one but the line, so there is no second chance for it.
				new BreakpointQuery("no-identity", node.Id + "-from-a-previous-run", statement.StartLine),
			],
			TestContext.Current.CancellationToken);

		var saved = Assert.Single(response.Breakpoints, resolved => resolved.Id == "saved");
		Assert.True(saved.Bound, saved.Reason);
		Assert.Equal(path, saved.ModulePath);
		Assert.Equal(statement.MetadataToken, saved.MetadataToken);
		Assert.Equal(statement.IlOffset, saved.IlOffset);
		Assert.Equal(statement.StartLine, saved.StartLine);

		var unknown = Assert.Single(response.Breakpoints, resolved => resolved.Id == "no-identity");
		Assert.False(unknown.Bound);
		Assert.False(string.IsNullOrWhiteSpace(unknown.Reason));
	}

	[Fact]
	public async Task ResolveIlLocation_RoundTrips() {
		var opened = await OpenContractsAssemblyAsync();
		var rpcException = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", "RpcException");
		var rpcMembers = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, rpcException.Id), TestContext.Current.CancellationToken);
		var getCodeNode = await FindAccessorAsync(opened.WorkspaceId, rpcMembers.Nodes, "Code", "get_Code()");

		// The statement table of a method document is decompiled from the method alone, so the line it reports is
		// the line the client will see once it opens that same method as a document.
		var document = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, getCodeNode.Id, DecompilerLanguage.CSharp),
			TestContext.Current.CancellationToken);
		var statement = Assert.Single(Assert.IsAssignableFrom<IReadOnlyList<CodeStatementDto>>(document.CodeStatements));

		var location = await manager.ResolveIlLocationAsync(
			opened.WorkspaceId,
			statement.ModulePath,
			statement.MetadataToken,
			statement.IlOffset,
			TestContext.Current.CancellationToken);

		Assert.NotNull(location);
		Assert.Equal(getCodeNode.Id, location.NodeId);
		Assert.False(location.IsExternalModule);
		Assert.Equal(statement.Description, location.Description);
		// The Call Stack window wears this one instead: the dotted declaring type, the method and its
		// parameters — never dnlib's "System.Void Ns.Type::Method(...)".
		Assert.Equal("dnSpy.Backend.Contracts.RpcException.get_Code()", location.StackFrameName);
		Assert.Equal(statement.StartLine, location.StartLine);
		Assert.Equal(statement.EndLine, location.EndLine);
		Assert.Equal(statement.StartColumn, location.StartColumn);
		Assert.Equal(statement.EndColumn, location.EndColumn);
		Assert.Equal(statement.IlOffset, location.IlOffset);
		Assert.Equal(statement.MetadataToken, location.MetadataToken);

		// An offset in the middle of the range belongs to the same statement, not only its first instruction.
		var inside = await manager.ResolveIlLocationAsync(
			opened.WorkspaceId,
			statement.ModulePath,
			statement.MetadataToken,
			statement.IlEndOffset - 1,
			TestContext.Current.CancellationToken);
		Assert.NotNull(inside);
		Assert.Equal(location.StartLine, inside.StartLine);
		Assert.Equal(location.IlOffset, inside.IlOffset);
	}

	[Fact]
	public async Task ResolveIlLocation_ExternalModule() {
		// A debuggee module is routinely not one the user opened, so a stopped IL location has to resolve from the
		// file on disk alone: the frame keeps its line, but there is no tree node to navigate to.
		var directory = Directory.CreateTempSubdirectory("dnspy-external-module-");
		try {
			var path = Path.Combine(directory.FullName, "ExternalContracts.dll");
			File.Copy(typeof(HelloRequest).Assembly.Location, path);
			var token = typeof(RpcException).GetProperty(nameof(RpcException.Code))!.GetGetMethod()!.MetadataToken;

			var location = await manager.ResolveIlLocationAsync(null, path, token, 0, TestContext.Current.CancellationToken);

			Assert.NotNull(location);
			Assert.True(location.IsExternalModule);
			Assert.Null(location.NodeId);
			Assert.Equal(path, location.ModulePath);
			Assert.Equal("System.Int32 dnSpy.Backend.Contracts.RpcException::get_Code()", location.Description);
			Assert.Equal(0, location.IlOffset);
			Assert.Equal(location.StartLine, location.EndLine);
			Assert.True(location.StartColumn > 0 && location.EndColumn > 0, $"Columns {location.StartColumn}-{location.EndColumn} are not positive.");
		}
		finally {
			directory.Delete(true);
		}
	}

	/// <summary>The <c>get_Code</c> statements, in IL order, of whichever document produced them.</summary>
	static List<CodeStatementDto> GetCodeStatements(IReadOnlyList<CodeStatementDto> statements) =>
		statements
			.Where(statement => statement.Description.Contains("::get_Code(", StringComparison.Ordinal))
			.OrderBy(statement => statement.IlOffset)
			.ToList();

	static void AssertStatementsLookSane(IReadOnlyList<CodeStatementDto> statements, string text) {
		Assert.NotEmpty(statements);
		var lineCount = text.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n').Length;
		foreach (var statement in statements) {
			if (statement.IsHidden) {
				// A hidden sequence point has no line, and ILSpy marks that with the PDB-wide 0xFEEFEE sentinel.
				// Nothing may draw it or snap a click onto it, so out-of-range line numbers are expected here.
				Assert.Equal(0xFEEFEE, statement.StartLine);
				continue;
			}
			Assert.True(statement.StartLine <= statement.EndLine, $"Line range {statement.StartLine}-{statement.EndLine} is inverted.");
			Assert.InRange(statement.StartLine, 1, lineCount);
			Assert.InRange(statement.EndLine, 1, lineCount);
			Assert.True(statement.StartColumn > 0 && statement.EndColumn > 0, $"Columns {statement.StartColumn}-{statement.EndColumn} are not positive.");
			Assert.True(statement.IlEndOffset > statement.IlOffset, $"IL range {statement.IlOffset}-{statement.IlEndOffset} is empty.");
			Assert.NotEqual(0, statement.MetadataToken);
			Assert.NotEqual(0, statement.SourceMethodToken);
			Assert.EndsWith(".dll", statement.ModulePath, StringComparison.OrdinalIgnoreCase);
		}
	}

	[Fact]
	public async Task SearchesNamesAndStringLiterals() {
		var opened = await OpenContractsAssemblyAsync();

		var types = await manager.SearchAsync(
			new SearchRequest(opened.WorkspaceId, "HexReadResponse", SearchTypes.Type),
			TestContext.Current.CancellationToken);
		var type = Assert.Single(types.Results);
		Assert.Equal("type", type.Kind);

		var testAssembly = await manager.OpenAsync(
			new OpenWorkspaceRequest([typeof(WorkspaceManagerTests).Assembly.Location]),
			TestContext.Current.CancellationToken);
		var strings = await manager.SearchAsync(
			new SearchRequest(testAssembly.WorkspaceId, "HexReadResponse", SearchTypes.Literal),
			TestContext.Current.CancellationToken);
		Assert.NotEmpty(strings.Results);
	}

	[Fact]
	public async Task AnalyzesAcrossOpenedModules() {
		var opened = await manager.OpenAsync(
			new OpenWorkspaceRequest([typeof(HelloRequest).Assembly.Location, typeof(WorkspaceManager).Assembly.Location]),
			TestContext.Current.CancellationToken);
		var roots = await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		var contractsAssembly = Assert.Single(roots.Nodes, node => node.Label.StartsWith("dnSpy.Backend.Contracts", StringComparison.Ordinal));
		var contractsRoot = Assert.Single(await ChildrenAsync(opened.WorkspaceId, contractsAssembly.Id), node => node.Kind == "module");
		var moduleChildren = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, contractsRoot.Id), TestContext.Current.CancellationToken);
		var contractsNamespace = Assert.Single(moduleChildren.Nodes, node => node.Label == "dnSpy.Backend.Contracts");
		var types = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, contractsNamespace.Id), TestContext.Current.CancellationToken);
		var rpcException = Assert.Single(types.Nodes, node => node.Label == "RpcException");

		var row = Assert.Single((await manager.AnalyzeNodesAsync(new AnalyzeNodesRequest(opened.WorkspaceId, [rpcException.Id]), TestContext.Current.CancellationToken)).Nodes);
		Assert.Equal("RpcException", row?.Label);
		// The exception is thrown all over the other assembly, and each of those methods is found in its body.
		var instantiatedBy = await manager.AnalyzeChildrenAsync(
			new AnalyzeChildrenRequest(opened.WorkspaceId, rpcException.Id, AnalyzerSearchKinds.InstantiatedBy),
			TestContext.Current.CancellationToken);
		Assert.Contains(instantiatedBy.Children, child =>
			child.Label.StartsWith("dnSpy.Backend.Core.WorkspaceManager.", StringComparison.Ordinal) && child.Source?.IlOffset is not null);
	}

	[Fact]
	public async Task ReturnsModuleMetadataAndBoundedHexRanges() {
		var opened = await OpenContractsAssemblyAsync();
		var moduleId = Assert.Single(opened.Modules).Id;

		var info = await manager.GetModuleInfoAsync(
			new ModuleInfoRequest(opened.WorkspaceId, moduleId),
			TestContext.Current.CancellationToken);
		Assert.Contains("dnSpy.Backend.Contracts", info.Name, StringComparison.Ordinal);
		Assert.NotEqual(Guid.Empty, info.Mvid);
		Assert.True(info.TypeCount > 10);
		Assert.True(info.MetadataTables["TypeDef"] > 10);
		Assert.Equal("PE32", info.PeHeaders["PE magic"]);

		var length = await manager.GetHexLengthAsync(
			new HexLengthRequest(opened.WorkspaceId, moduleId),
			TestContext.Current.CancellationToken);
		Assert.True(length.Length > 512);

		var firstBytes = await manager.ReadHexAsync(
			new HexReadRequest(opened.WorkspaceId, moduleId, 0, 64),
			TestContext.Current.CancellationToken);
		var bytes = Convert.FromBase64String(firstBytes.Base64Data);
		Assert.Equal(64, bytes.Length);
		Assert.Equal((byte)'M', bytes[0]);
		Assert.Equal((byte)'Z', bytes[1]);
		Assert.False(firstBytes.EndOfFile);

		var exception = await Assert.ThrowsAsync<RpcException>(() => manager.ReadHexAsync(
			new HexReadRequest(opened.WorkspaceId, moduleId, 0, 1024 * 1024 + 1),
			TestContext.Current.CancellationToken));
		Assert.Equal(ErrorCodes.RangeTooLarge, exception.Code);
	}

	[Fact]
	public async Task ResolvesAMethodsHexTargetToItsBodyAndToTheStatementsInsideIt() {
		var path = typeof(HelloRequest).Assembly.Location;
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
		var moduleId = Assert.Single(opened.Modules).Id;
		var type = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", "RpcException");
		var members = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, type.Id), TestContext.Current.CancellationToken);
		var methodNode = await FindAccessorAsync(opened.WorkspaceId, members.Nodes, "Code", "get_Code()");

		var target = await manager.ResolveHexTargetAsync(
			new HexTargetRequest(opened.WorkspaceId, methodNode.Id),
			TestContext.Current.CancellationToken);

		Assert.Equal(moduleId, target.ModuleId);
		var method = Assert.IsType<HexMethodTargetDto>(target.Method);
		Assert.Null(target.FieldInitialValue);
		Assert.Null(target.Resource);
		Assert.True(method.BodySize > 0);

		// dnSpy's write templates carry the method header's own first byte, so the body offset is the one
		// they are written at. Read the file back and check that a header really is what sits there and
		// that it states exactly the code size the response does.
		var body = Convert.FromBase64String((await manager.ReadHexAsync(
			new HexReadRequest(opened.WorkspaceId, moduleId, method.BodyOffset, checked((int)method.BodySize)),
			TestContext.Current.CancellationToken)).Base64Data);
		Assert.Equal(method.BodySize, body.Length);
		switch (body[0] & 7) {
		case 2: case 6: // A tiny header is one byte: the code size is packed into it.
			Assert.Equal(1, method.CodeOffset - method.BodyOffset);
			Assert.Equal(body[0] >> 2, (int)method.CodeSize);
			break;
		case 3: // A fat header states its own size in the high nibble of its second byte.
			Assert.Equal((body[1] >> 4) * 4, (int)(method.CodeOffset - method.BodyOffset));
			Assert.Equal((int)BitConverter.ToUInt32(body, 4), (int)method.CodeSize);
			break;
		default:
			Assert.Fail($"The bytes at the reported body offset do not start with a method header: 0x{body[0]:X2}.");
			break;
		}
		Assert.True(method.CodeOffset - method.BodyOffset + method.CodeSize <= method.BodySize);

		// The same method's statements have to land inside that code, which ties the two offsets together:
		// a statement's file offset is the code offset plus the IL offset the decompiler reported.
		var document = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, methodNode.Id, DecompilerLanguage.CSharp),
			TestContext.Current.CancellationToken);
		var statement = Assert.Single(document.CodeStatements!, s => !s.IsHidden);
		var resolved = await manager.ResolveHexStatementAsync(
			new HexStatementRequest(opened.WorkspaceId, path, statement.MetadataToken, statement.IlOffset, statement.IlEndOffset),
			TestContext.Current.CancellationToken);
		Assert.Equal(moduleId, resolved.ModuleId);
		var range = Assert.IsType<HexRangeDto>(resolved.Range);
		Assert.Equal(method.CodeOffset + statement.IlOffset, range.Offset);
		Assert.True(range.Offset + range.Length <= method.CodeOffset + method.CodeSize);
	}

	[Fact]
	public async Task ResolvesAFieldsInitialValueAndAResourcesBytes() {
		var opened = await manager.OpenAsync(
			new OpenWorkspaceRequest([typeof(WorkspaceManagerTests).Assembly.Location]),
			TestContext.Current.CancellationToken);
		var moduleId = Assert.Single(opened.Modules).Id;
		var moduleNode = await FindModuleAsync(opened.WorkspaceId);

		// The compiler's own static data lives in the global namespace, and its field is the one kind of
		// field with an RVA and an initial value to point a hex editor at.
		var globalTypes = await manager.GetChildrenAsync(
			new NodeRequest(opened.WorkspaceId, (await FindNamespaceAsync(opened.WorkspaceId, "-")).Id),
			TestContext.Current.CancellationToken);
		var implementationDetails = Assert.Single(globalTypes.Nodes, node => node.Label.Contains("PrivateImplementationDetails", StringComparison.Ordinal));
		var fields = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, implementationDetails.Id), TestContext.Current.CancellationToken);
		var initialValue = (await Task.WhenAll(fields.Nodes.Where(node => node.Kind == "field").Select(async field =>
			await manager.ResolveHexTargetAsync(new HexTargetRequest(opened.WorkspaceId, field.Id), TestContext.Current.CancellationToken))))
			.Select(target => target.FieldInitialValue)
			.OfType<HexRangeDto>()
			.FirstOrDefault();
		var value = Assert.IsType<HexRangeDto>(initialValue);
		Assert.True(value.Length > 0);
		Assert.Null(Assert.IsType<HexTargetResponse>(
			await manager.ResolveHexTargetAsync(new HexTargetRequest(opened.WorkspaceId, implementationDetails.Id), TestContext.Current.CancellationToken)).FieldInitialValue);
		// The offsets point at the data section, which is inside the file the module was read from.
		Assert.InRange(value.Offset, 1, (await manager.GetHexLengthAsync(new HexLengthRequest(opened.WorkspaceId, moduleId), TestContext.Current.CancellationToken)).Length - value.Length);

		var resources = Assert.Single(
			(await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, moduleNode.Id), TestContext.Current.CancellationToken)).Nodes,
			node => node.Kind == "resourcesgroup");
		var resource = Assert.Single(
			(await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, resources.Id), TestContext.Current.CancellationToken)).Nodes,
			node => node.Label.EndsWith("sample-resource.txt", StringComparison.Ordinal));

		var resourceTarget = await manager.ResolveHexTargetAsync(
			new HexTargetRequest(opened.WorkspaceId, resource.Id),
			TestContext.Current.CancellationToken);
		var resourceRange = Assert.IsType<HexRangeDto>(resourceTarget.Resource);
		Assert.Equal(new FileInfo(typeof(WorkspaceManagerTests).Assembly.Location).Length > resourceRange.Offset, resourceRange.Length > 0);
		// What the range points at is the resource's own bytes.
		var bytes = Convert.FromBase64String((await manager.ReadHexAsync(
			new HexReadRequest(opened.WorkspaceId, moduleId, resourceRange.Offset, checked((int)resourceRange.Length)),
			TestContext.Current.CancellationToken)).Base64Data);
		Assert.Equal(resourceRange.Length, bytes.Length);
	}

	[Fact]
	public async Task AHexPositionIsAnAbsoluteFileOrRvaAddressAndAMetadataItemIsItsRow() {
		var opened = await OpenContractsAssemblyAsync();
		var moduleId = Assert.Single(opened.Modules).Id;

		// Absolute and file positions are the same address here: the buffer is the file.
		var absolute = await manager.ResolveHexPositionAsync(
			new HexResolvePositionRequest(opened.WorkspaceId, moduleId, "absolute", 0x20),
			TestContext.Current.CancellationToken);
		Assert.Equal(0x20, absolute.Offset);

		// What the RVA of the DOS header maps to is the start of the file, which is where "MZ" lives.
		var rva = await manager.ResolveHexPositionAsync(
			new HexResolvePositionRequest(opened.WorkspaceId, moduleId, "rva", 0),
			TestContext.Current.CancellationToken);
		Assert.Equal(0, rva.Offset);

		// A position past the end is "no such position", not an error the caller has to catch.
		var beyond = await manager.ResolveHexPositionAsync(
			new HexResolvePositionRequest(opened.WorkspaceId, moduleId, "rva", 0x7FFF_FFFF),
			TestContext.Current.CancellationToken);
		Assert.Equal(-1, beyond.Offset);

		// A metadata token names the row the tables stream holds for it; the range covers that row.
		var table = await manager.GoToHexMetadataAsync(
			new HexGoToMetadataRequest(opened.WorkspaceId, moduleId, "table", 0x02000005),
			TestContext.Current.CancellationToken);
		var row = Assert.IsType<HexRangeDto>(table.Range);
		Assert.True(row.Offset > 0);
		Assert.True(row.Length > 0);
		// #Strings offset 1 is the first string, an empty one in every writer that starts with a zero byte;
		// what matters is that the range sits inside the file.
		var strings = await manager.GoToHexMetadataAsync(
			new HexGoToMetadataRequest(opened.WorkspaceId, moduleId, "strings", 1),
			TestContext.Current.CancellationToken);
		Assert.NotNull(strings.Range);
		var length = (await manager.GetHexLengthAsync(new HexLengthRequest(opened.WorkspaceId, moduleId), TestContext.Current.CancellationToken)).Length;
		Assert.InRange(strings.Range!.Offset, 0, length - 1);

		// A token no table holds is answered with "nothing here".
		var invalid = await manager.GoToHexMetadataAsync(
			new HexGoToMetadataRequest(opened.WorkspaceId, moduleId, "table", 0x02FFFFFF),
			TestContext.Current.CancellationToken);
		Assert.Null(invalid.Range);
	}

	[Fact]
	public async Task FindHexAnswersMatchesInEitherDirectionAndWraps() {
		var opened = await OpenContractsAssemblyAsync();
		var moduleId = Assert.Single(opened.Modules).Id;
		var dosHeader = Convert.ToBase64String([(byte)'M', (byte)'Z']);

		var first = await manager.FindHexAsync(
			new HexFindRequest(opened.WorkspaceId, moduleId, dosHeader, 0, false, false),
			TestContext.Current.CancellationToken);
		Assert.Equal(0, first.Offset);

		// Find next starts after the match it was given. The assembly's own name appears more than once,
		// which is what makes a second match something the test can rely on; "MZ" need not recur.
		var nameBytes = Convert.ToBase64String("dnSpy.Backend.Contracts"u8);
		var firstRepeat = await manager.FindHexAsync(
			new HexFindRequest(opened.WorkspaceId, moduleId, nameBytes, 0, false, false),
			TestContext.Current.CancellationToken);
		var next = await manager.FindHexAsync(
			new HexFindRequest(opened.WorkspaceId, moduleId, nameBytes, firstRepeat.Offset + 1, false, false),
			TestContext.Current.CancellationToken);
		Assert.True(next.Offset > firstRepeat.Offset, "The assembly name should occur more than once in the file.");

		var previous = await manager.FindHexAsync(
			new HexFindRequest(opened.WorkspaceId, moduleId, nameBytes, next.Offset, true, false),
			TestContext.Current.CancellationToken);
		Assert.Equal(firstRepeat.Offset, previous.Offset);

		// A pattern nothing holds answers -1, and wrapping does not invent one.
		var missing = await manager.FindHexAsync(
			new HexFindRequest(opened.WorkspaceId, moduleId, Convert.ToBase64String([0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF, 0x00]), 0, false, true),
			TestContext.Current.CancellationToken);
		Assert.Equal(-1, missing.Offset);

		// A search sees the hex patches the tab shows, not the file on disk.
		await CommitHexPatchAsync(opened.WorkspaceId, moduleId, 0x200, [0xCA, 0xFE, 0xBA, 0xBE]);
		var patched = await manager.FindHexAsync(
			new HexFindRequest(opened.WorkspaceId, moduleId, Convert.ToBase64String([0xCA, 0xFE, 0xBA, 0xBE]), 0, false, false),
			TestContext.Current.CancellationToken);
		Assert.Equal(0x200, patched.Offset);
	}

	[Fact]
	public async Task AHexReadOfANativePeFileWorksEvenThoughItCannotBeEdited() {
		// A PE file that is not managed gets a hex editor in dnSpy all the same; the read is what has to
		// accept it, while every edit path keeps refusing it.
		var path = Path.Combine(AppContext.BaseDirectory, "dnSpy.Backend.Tests.dll");
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
		var assemblyId = Assert.Single(opened.Modules).Id;
		var length = await manager.GetHexLengthAsync(new HexLengthRequest(opened.WorkspaceId, assemblyId), TestContext.Current.CancellationToken);
		Assert.True(length.Length > 0);
		var bytes = Convert.FromBase64String((await manager.ReadHexAsync(
			new HexReadRequest(opened.WorkspaceId, assemblyId, 0, 2),
			TestContext.Current.CancellationToken)).Base64Data);
		Assert.Equal("MZ", System.Text.Encoding.ASCII.GetString(bytes));
	}

	[Fact]
	public async Task APatchShowsUpInTheHexReadAndUndoPutsTheOriginalBytesBack() {
		var opened = await OpenContractsAssemblyAsync();
		var moduleId = Assert.Single(opened.Modules).Id;
		var before = Convert.FromBase64String((await manager.ReadHexAsync(
			new HexReadRequest(opened.WorkspaceId, moduleId, 0x200, 4),
			TestContext.Current.CancellationToken)).Base64Data);

		var patch = await CommitHexPatchAsync(opened.WorkspaceId, moduleId, 0x200, [0xDE, 0xAD, 0xBE, 0xEF]);

		var after = Convert.FromBase64String((await manager.ReadHexAsync(
			new HexReadRequest(opened.WorkspaceId, moduleId, 0x200, 4),
			TestContext.Current.CancellationToken)).Base64Data);
		Assert.Equal(new byte[] { 0xDE, 0xAD, 0xBE, 0xEF }, after);
		Assert.True(patch.CanUndo);

		await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);

		var restored = Convert.FromBase64String((await manager.ReadHexAsync(
			new HexReadRequest(opened.WorkspaceId, moduleId, 0x200, 4),
			TestContext.Current.CancellationToken)).Base64Data);
		Assert.Equal(before, restored);
	}

	[Fact]
	public async Task ASavedModuleCarriesThePatchedBytes() {
		var opened = await OpenContractsAssemblyAsync();
		var moduleId = Assert.Single(opened.Modules).Id;
		var method = await FindRpcExceptionGetterAsync(opened.WorkspaceId);
		var target = await manager.ResolveHexTargetAsync(new HexTargetRequest(opened.WorkspaceId, method.Id), TestContext.Current.CancellationToken);
		var body = Assert.IsType<HexMethodTargetDto>(target.Method);

		// What "Hex Write 'return true' Body" posts: a tiny header and the two instructions after it.
		await CommitHexPatchAsync(opened.WorkspaceId, method.Id, body.BodyOffset, [0x0A, 0x17, 0x2A]);

		var destination = Path.Combine(Path.GetTempPath(), $"dnspy-hex-{Guid.NewGuid():N}.dll");
		try {
			await manager.SaveModuleAsync(new SaveModuleRequest(opened.WorkspaceId, moduleId, destination), TestContext.Current.CancellationToken);

			// The serializer lays the file out its own way, so the saved copy is asked where the method's
			// body landed rather than being read at the offset the patch was written at.
			var reopened = await manager.OpenAsync(new OpenWorkspaceRequest([destination]), TestContext.Current.CancellationToken);
			var savedMethod = await FindRpcExceptionGetterAsync(reopened.WorkspaceId);
			var savedTarget = await manager.ResolveHexTargetAsync(new HexTargetRequest(reopened.WorkspaceId, savedMethod.Id), TestContext.Current.CancellationToken);
			var savedBody = Assert.IsType<HexMethodTargetDto>(savedTarget.Method);
			var saved = Convert.FromBase64String((await manager.ReadHexAsync(
				new HexReadRequest(reopened.WorkspaceId, savedTarget.ModuleId, savedBody.BodyOffset, 3),
				TestContext.Current.CancellationToken)).Base64Data);
			Assert.Equal(new byte[] { 0x0A, 0x17, 0x2A }, saved);
		}
		finally {
			File.Delete(destination);
		}
	}

	[Fact]
	public async Task AHexPatchFollowsTheMethodBodyAStructuralEditMoved() {
		var opened = await OpenContractsAssemblyAsync();
		var moduleId = Assert.Single(opened.Modules).Id;
		var method = await FindRpcExceptionGetterAsync(opened.WorkspaceId);
		var target = await manager.ResolveHexTargetAsync(new HexTargetRequest(opened.WorkspaceId, method.Id), TestContext.Current.CancellationToken);
		var body = Assert.IsType<HexMethodTargetDto>(target.Method);

		// Not any stub's own bytes, so the file can only hold them if the patch put them there.
		await CommitHexPatchAsync(opened.WorkspaceId, method.Id, body.BodyOffset, [0x0A, 0x18, 0x2A]);

		// A structural edit gives the method a new body, and the serializer then lays the whole file out
		// afresh, so the offset the patch was written at means nothing in the file this save writes. The
		// patch was aimed at the method, so it lands on whatever body that method has now.
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.QueueMethodBodyStubAsync(
			new ReplaceMethodBodyWithStubRequest(opened.WorkspaceId, transaction.TransactionId, method.Id),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var destination = Path.Combine(Path.GetTempPath(), $"dnspy-hex-{Guid.NewGuid():N}.dll");
		try {
			await manager.SaveModuleAsync(new SaveModuleRequest(opened.WorkspaceId, moduleId, destination), TestContext.Current.CancellationToken);

			var reopened = await manager.OpenAsync(new OpenWorkspaceRequest([destination]), TestContext.Current.CancellationToken);
			var savedMethod = await FindRpcExceptionGetterAsync(reopened.WorkspaceId);
			var savedTarget = await manager.ResolveHexTargetAsync(new HexTargetRequest(reopened.WorkspaceId, savedMethod.Id), TestContext.Current.CancellationToken);
			var savedBody = Assert.IsType<HexMethodTargetDto>(savedTarget.Method);
			var saved = Convert.FromBase64String((await manager.ReadHexAsync(
				new HexReadRequest(reopened.WorkspaceId, savedTarget.ModuleId, savedBody.BodyOffset, 3),
				TestContext.Current.CancellationToken)).Base64Data);
			Assert.Equal(new byte[] { 0x0A, 0x18, 0x2A }, saved);
		}
		finally {
			File.Delete(destination);
		}
	}

	[Fact]
	public async Task RefusesAPatchLargerThanWhatItIsWritingOver() {
		var opened = await OpenContractsAssemblyAsync();
		var method = await FindRpcExceptionGetterAsync(opened.WorkspaceId);
		var target = await manager.ResolveHexTargetAsync(new HexTargetRequest(opened.WorkspaceId, method.Id), TestContext.Current.CancellationToken);
		var body = Assert.IsType<HexMethodTargetDto>(target.Method);

		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		var exception = await Assert.ThrowsAsync<RpcException>(() => manager.QueueHexPatchAsync(
			new HexPatchRequest(opened.WorkspaceId, transaction.TransactionId, method.Id, body.BodyOffset,
				Convert.ToBase64String(new byte[(int)body.BodySize + 1])),
			TestContext.Current.CancellationToken));
		Assert.Equal(ErrorCodes.EditValidationFailed, exception.Code);
	}

	[Fact]
	public async Task ClosingWorkspaceReleasesItsPublicIdentity() {
		var opened = await OpenContractsAssemblyAsync();
		manager.Close(new WorkspaceRequest(opened.WorkspaceId));

		var exception = await Assert.ThrowsAsync<RpcException>(() => manager.GetRootsAsync(
			new WorkspaceRequest(opened.WorkspaceId),
			TestContext.Current.CancellationToken));
		Assert.Equal(ErrorCodes.WorkspaceNotFound, exception.Code);
	}

	[Fact]
	public void CoreAssemblyDoesNotReferenceDesktopUiFrameworks() {
		var forbidden = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
			"PresentationCore",
			"PresentationFramework",
			"System.Windows.Forms",
			"WindowsBase",
		};
		var references = typeof(WorkspaceManager).Assembly.GetReferencedAssemblies().Select(a => a.Name).ToArray();
		Assert.DoesNotContain(references, name => name is not null && forbidden.Contains(name));
	}

	[Fact]
	public async Task CommitsRenameDetectsConflictsAndSavesVerifiedCopy() {
		var opened = await OpenContractsAssemblyAsync();
		var helloRequest = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", "HelloRequest");
		var first = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		var conflicting = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);

		await manager.QueueRenameAsync(
			new RenameEditRequest(opened.WorkspaceId, first.TransactionId, helloRequest.Id, "HelloRequestRenamed"),
			TestContext.Current.CancellationToken);
		var committed = await manager.CommitEditAsync(
			new EditTransactionRequest(opened.WorkspaceId, first.TransactionId),
			TestContext.Current.CancellationToken);
		Assert.Equal(1, committed.Version);
		Assert.Contains(helloRequest.Id, committed.ChangedNodeIds);
		var renamedCSharp = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, helloRequest.Id, DecompilerLanguage.CSharp),
			TestContext.Current.CancellationToken);
		Assert.Contains("record HelloRequestRenamed", renamedCSharp.Text, StringComparison.Ordinal);

		await manager.QueueRenameAsync(
			new RenameEditRequest(opened.WorkspaceId, conflicting.TransactionId, helloRequest.Id, "ConflictingName"),
			TestContext.Current.CancellationToken);
		var conflict = await Assert.ThrowsAsync<RpcException>(() => manager.CommitEditAsync(
			new EditTransactionRequest(opened.WorkspaceId, conflicting.TransactionId),
			TestContext.Current.CancellationToken));
		Assert.Equal(ErrorCodes.EditConflict, conflict.Code);
		await manager.RollbackEditAsync(
			new EditTransactionRequest(opened.WorkspaceId, conflicting.TransactionId),
			TestContext.Current.CancellationToken);
		var undone = await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		Assert.False(undone.CanUndo);
		Assert.True(undone.CanRedo);
		var originalCSharp = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, helloRequest.Id, DecompilerLanguage.CSharp),
			TestContext.Current.CancellationToken);
		Assert.Contains("record HelloRequest(", originalCSharp.Text, StringComparison.Ordinal);
		var redone = await manager.RedoAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		Assert.True(redone.CanUndo);
		Assert.False(redone.CanRedo);

		var destination = Path.Combine(Path.GetTempPath(), $"dnspy-edit-{Guid.NewGuid():N}.dll");
		try {
			var saved = await manager.SaveModuleAsync(
				new SaveModuleRequest(opened.WorkspaceId, opened.Modules[0].Id, destination),
				TestContext.Current.CancellationToken);
			Assert.Equal(destination, saved.Path);
			Assert.True(saved.Length > 512);
			Assert.Equal(64, saved.Sha256.Length);

			var reopened = await manager.OpenAsync(
				new OpenWorkspaceRequest([destination]),
				TestContext.Current.CancellationToken);
			var results = await manager.SearchAsync(
				new SearchRequest(reopened.WorkspaceId, "HelloRequestRenamed", SearchTypes.Type),
				TestContext.Current.CancellationToken);
			Assert.Single(results.Results);
		}
		finally {
			File.Delete(destination);
		}
	}

	[Fact]
	public async Task ReplacesStructuredIlMethodBody() {
		var opened = await OpenContractsAssemblyAsync();
		var rpcException = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", "RpcException");
		var members = await manager.GetChildrenAsync(
			new NodeRequest(opened.WorkspaceId, rpcException.Id),
			TestContext.Current.CancellationToken);
		var getCode = await FindAccessorAsync(opened.WorkspaceId, members.Nodes, "Code", "get_Code()");
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);

		await manager.QueueMethodBodyAsync(new ReplaceMethodBodyRequest(
			opened.WorkspaceId,
			transaction.TransactionId,
			getCode.Id,
			[
				new IlInstructionDto("L0", "ldc.i4", "int32", "42"),
				new IlInstructionDto("L1", "ret"),
			],
			MaxStack: 1), TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(
			new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId),
			TestContext.Current.CancellationToken);

		var il = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, getCode.Id, DecompilerLanguage.IL),
			TestContext.Current.CancellationToken);
		Assert.Contains("ldc.i4", il.Text, StringComparison.Ordinal);
		Assert.Contains("42", il.Text, StringComparison.Ordinal);
		var csharp = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, getCode.Id, DecompilerLanguage.CSharp),
			TestContext.Current.CancellationToken);
		Assert.Contains("42", csharp.Text, StringComparison.Ordinal);
		var mixed = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, getCode.Id, DecompilerLanguage.ILWithCSharp),
			TestContext.Current.CancellationToken);
		Assert.True(
			mixed.Text.Split('\n').Any(line => line.TrimStart().StartsWith("//", StringComparison.Ordinal) && line.Contains("42", StringComparison.Ordinal)),
			$"Expected the updated constant in a C# source comment:{Environment.NewLine}{mixed.Text}");
		Assert.Contains("ldc.i4", mixed.Text, StringComparison.Ordinal);
	}

	[Fact]
	public async Task RoundTripsEditableMethodBodyWithMetadataTokens() {
		var opened = await OpenContractsAssemblyAsync();
		var rpcException = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", "RpcException");
		var members = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, rpcException.Id), TestContext.Current.CancellationToken);
		var getCode = await FindAccessorAsync(opened.WorkspaceId, members.Nodes, "Code", "get_Code()");
		var body = await manager.GetMethodBodyAsync(
			new MethodBodyRequest(opened.WorkspaceId, getCode.Id),
			TestContext.Current.CancellationToken);
		Assert.Contains(body.Instructions, instruction => instruction.OperandKind == "token");

		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.QueueMethodBodyAsync(new ReplaceMethodBodyRequest(
			opened.WorkspaceId,
			transaction.TransactionId,
			getCode.Id,
			body.Instructions,
			body.MaxStack,
			body.InitLocals), TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var il = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, getCode.Id, DecompilerLanguage.IL),
			TestContext.Current.CancellationToken);
		Assert.Contains("ldfld", il.Text, StringComparison.Ordinal);
		Assert.Contains("ret", il.Text, StringComparison.Ordinal);
	}

	[Fact]
	public async Task ReplacesEmbeddedResourceTransactionally() {
		var opened = await manager.OpenAsync(
			new OpenWorkspaceRequest([typeof(WorkspaceManagerTests).Assembly.Location]),
			TestContext.Current.CancellationToken);
		var root = await FindModuleAsync(opened.WorkspaceId);
		var moduleChildren = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, root.Id), TestContext.Current.CancellationToken);
		var resources = Assert.Single(moduleChildren.Nodes, node => node.Kind == "resourcesgroup");
		var resourceNodes = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, resources.Id), TestContext.Current.CancellationToken);
		var resource = Assert.Single(resourceNodes.Nodes, node => node.Label.EndsWith("sample-resource.txt", StringComparison.Ordinal));
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);

		await manager.QueueResourceAsync(
			new ReplaceResourceRequest(opened.WorkspaceId, transaction.TransactionId, resource.Id, Convert.ToBase64String("updated"u8)),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var refreshed = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, resources.Id), TestContext.Current.CancellationToken);
		var updated = Assert.Single(refreshed.Nodes, node => node.Id == resource.Id);
		Assert.Contains("7 bytes", updated.Description, StringComparison.Ordinal);
	}

	[Fact]
	public async Task DeletesATypeAndUndoHandsBackTheSameNode() {
		var opened = await OpenContractsAssemblyAsync();
		var @namespace = await FindNamespaceAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts");
		var helloRequest = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", "HelloRequest");
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);

		await manager.QueueDeleteAsync(
			new DeleteEditRequest(opened.WorkspaceId, transaction.TransactionId, helloRequest.Id),
			TestContext.Current.CancellationToken);
		var committed = await manager.CommitEditAsync(
			new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId),
			TestContext.Current.CancellationToken);
		Assert.Contains(helloRequest.Id, committed.ChangedNodeIds);

		var removed = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, @namespace.Id), TestContext.Current.CancellationToken);
		Assert.DoesNotContain(removed.Nodes, node => node.Label == "HelloRequest");

		await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);

		// The node id is derived from the metadata token, so undo reinserts the very node the tree had.
		var restored = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, @namespace.Id), TestContext.Current.CancellationToken);
		Assert.Contains(restored.Nodes, node => node.Id == helloRequest.Id);
	}

	[Fact]
	public async Task DeletesSeveralTypesAsOneStepThatOneUndoPutsBack() {
		var opened = await OpenContractsAssemblyAsync();
		var @namespace = await FindNamespaceAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts");
		var names = new[] { "HelloRequest", "HelloResponse", "OpenWorkspaceRequest" };
		var types = new List<TreeNodeDto>();
		foreach (var name in names)
			types.Add(await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", name));
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		// dnSpy's DeleteTypeDefCommand over a selection: each type is taken out of the list it is in at the moment
		// it goes, so the ones before it having gone already does not move it.
		foreach (var type in types)
			await manager.QueueDeleteAsync(new DeleteEditRequest(opened.WorkspaceId, transaction.TransactionId, type.Id), TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var removed = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, @namespace.Id), TestContext.Current.CancellationToken);
		Assert.DoesNotContain(removed.Nodes, node => names.Contains(node.Label));

		var undone = await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		Assert.False(undone.CanUndo);
		var restored = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, @namespace.Id), TestContext.Current.CancellationToken);
		Assert.All(types, type => Assert.Contains(restored.Nodes, node => node.Id == type.Id));
	}

	[Fact]
	public async Task DeletesAPropertyTogetherWithItsAccessors() {
		var opened = await OpenContractsAssemblyAsync();
		var rpcException = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", "RpcException");
		var members = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, rpcException.Id), TestContext.Current.CancellationToken);
		var code = Assert.Single(members.Nodes, node => node.Kind == "property" && node.Label == "Code");
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);

		await manager.QueueDeleteAsync(
			new DeleteEditRequest(opened.WorkspaceId, transaction.TransactionId, code.Id),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(
			new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId),
			TestContext.Current.CancellationToken);

		var remaining = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, rpcException.Id), TestContext.Current.CancellationToken);
		Assert.DoesNotContain(remaining.Nodes, node => node.Label == "Code");
		// dnSpy drops a property's accessor methods along with it, so the tree must not keep listing them.
		Assert.DoesNotContain(remaining.Nodes, node => node.Label.StartsWith("get_Code", StringComparison.Ordinal));
	}

	[Fact]
	public async Task RenamesANamespaceAndUndoPutsTheTypesBack() {
		var opened = await OpenContractsAssemblyAsync();
		var module = await FindModuleAsync(opened.WorkspaceId);
		var @namespace = await FindNamespaceAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts");
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);

		await manager.QueueSetNamespaceAsync(
			new SetNamespaceEditRequest(opened.WorkspaceId, transaction.TransactionId, @namespace.Id, "dnSpy.Backend.Renamed"),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(
			new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId),
			TestContext.Current.CancellationToken);

		var children = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, module.Id), TestContext.Current.CancellationToken);
		Assert.DoesNotContain(children.Nodes, node => node.Label == "dnSpy.Backend.Contracts");
		var renamed = Assert.Single(children.Nodes, node => node.Label == "dnSpy.Backend.Renamed");
		var types = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, renamed.Id), TestContext.Current.CancellationToken);
		Assert.Contains(types.Nodes, node => node.Label == "HelloRequest");

		await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);

		var restored = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, module.Id), TestContext.Current.CancellationToken);
		Assert.DoesNotContain(restored.Nodes, node => node.Label == "dnSpy.Backend.Renamed");
		var original = Assert.Single(restored.Nodes, node => node.Label == "dnSpy.Backend.Contracts");
		var originalTypes = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, original.Id), TestContext.Current.CancellationToken);
		Assert.Contains(originalTypes.Nodes, node => node.Label == "HelloRequest");
	}

	[Fact]
	public async Task MovesANamespaceIntoTheEmptyOneAndDeletesItAsANoOp() {
		var opened = await OpenContractsAssemblyAsync();
		var module = await FindModuleAsync(opened.WorkspaceId);
		var @namespace = await FindNamespaceAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts");
		var first = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);

		// An empty new name is dnSpy's "Move Types to Empty Namespace".
		await manager.QueueSetNamespaceAsync(
			new SetNamespaceEditRequest(opened.WorkspaceId, first.TransactionId, @namespace.Id, string.Empty),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(
			new EditTransactionRequest(opened.WorkspaceId, first.TransactionId),
			TestContext.Current.CancellationToken);

		var children = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, module.Id), TestContext.Current.CancellationToken);
		Assert.DoesNotContain(children.Nodes, node => node.Label == "dnSpy.Backend.Contracts");
		var unnamed = Assert.Single(children.Nodes, node => node.Label == "-");
		var types = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, unnamed.Id), TestContext.Current.CancellationToken);
		Assert.Contains(types.Nodes, node => node.Label == "HelloRequest");

		// Deleting the namespace it left behind removes its types, of which there are now none — dnSpy's
		// delete-namespace command accepts that rather than failing on the empty list.
		var second = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.QueueDeleteAsync(
			new DeleteEditRequest(opened.WorkspaceId, second.TransactionId, @namespace.Id),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(
			new EditTransactionRequest(opened.WorkspaceId, second.TransactionId),
			TestContext.Current.CancellationToken);

		var afterDelete = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, module.Id), TestContext.Current.CancellationToken);
		Assert.Contains(afterDelete.Nodes, node => node.Label == "-");
	}

	[Fact]
	public async Task ReplacesAMethodBodyWithTheGeneratedStub() {
		var opened = await OpenContractsAssemblyAsync();
		var rpcException = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", "RpcException");
		var members = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, rpcException.Id), TestContext.Current.CancellationToken);
		var getCode = await FindAccessorAsync(opened.WorkspaceId, members.Nodes, "Code", "get_Code()");
		var before = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, getCode.Id, DecompilerLanguage.IL),
			TestContext.Current.CancellationToken);
		Assert.Contains("ldfld", before.Text, StringComparison.Ordinal);
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);

		await manager.QueueMethodBodyStubAsync(
			new ReplaceMethodBodyWithStubRequest(opened.WorkspaceId, transaction.TransactionId, getCode.Id),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(
			new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId),
			TestContext.Current.CancellationToken);

		// The stub is built from the method's own signature: for an int getter that is the default value,
		// so the field read is gone and the body still returns.
		var after = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, getCode.Id, DecompilerLanguage.IL),
			TestContext.Current.CancellationToken);
		Assert.DoesNotContain("ldfld", after.Text, StringComparison.Ordinal);
		Assert.Contains("ret", after.Text, StringComparison.Ordinal);
		var csharp = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, getCode.Id, DecompilerLanguage.CSharp),
			TestContext.Current.CancellationToken);
		Assert.Contains("return", csharp.Text, StringComparison.Ordinal);

		await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		var undone = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, getCode.Id, DecompilerLanguage.IL),
			TestContext.Current.CancellationToken);
		Assert.Contains("ldfld", undone.Text, StringComparison.Ordinal);
	}

	[Fact]
	public async Task ExpandsDotResourcesAndDecompilesBamlToXaml() {
		var target = Path.GetFullPath(Path.Combine(
			AppContext.BaseDirectory,
			"..", "..", "..", "..", "BamlTarget", "bin", TestConfiguration, "net10.0-windows", "BamlTarget.dll"));
		Assert.True(File.Exists(target), $"BAML fixture was not built: {target}");
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([target]), TestContext.Current.CancellationToken);
		var root = await FindModuleAsync(opened.WorkspaceId);
		var moduleChildren = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, root.Id), TestContext.Current.CancellationToken);
		var resources = Assert.Single(moduleChildren.Nodes, node => node.Kind == "resourcesgroup");
		var resourceNodes = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, resources.Id), TestContext.Current.CancellationToken);
		var generatedResources = Assert.Single(resourceNodes.Nodes, node => node.Label.EndsWith(".g.resources", StringComparison.OrdinalIgnoreCase));
		Assert.True(generatedResources.HasChildren);
		var entries = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, generatedResources.Id), TestContext.Current.CancellationToken);
		var baml = Assert.Single(entries.Nodes, node => node.Label.EndsWith(".baml", StringComparison.OrdinalIgnoreCase));

		var xaml = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, baml.Id, DecompilerLanguage.CSharp),
			TestContext.Current.CancellationToken);
		Assert.Equal("xaml", xaml.Language);
		Assert.False(xaml.Diagnostics.Any(diagnostic => diagnostic.Severity == "error"), $"BAML decompilation failed: {string.Join("; ", xaml.Diagnostics.Select(diagnostic => diagnostic.Message))}");
		Assert.Contains("UserControl", xaml.Text, StringComparison.Ordinal);
		Assert.Contains("BAML fixture", xaml.Text, StringComparison.Ordinal);
		// dnSpy's defaults (BamlSettings): tabs, one attribute per line, no XML declaration.
		var lines = xaml.Text.Split('\n');
		Assert.DoesNotContain("<?xml", xaml.Text, StringComparison.Ordinal);
		Assert.Contains(lines, line => line.StartsWith('\t'));
		Assert.DoesNotContain(lines, line => line.StartsWith("  ", StringComparison.Ordinal));
		var rootElement = lines.First(line => line.StartsWith("<UserControl", StringComparison.Ordinal));
		Assert.DoesNotContain("xmlns", rootElement, StringComparison.Ordinal);

		// The BAML page's two layout options.
		var spaced = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, baml.Id, DecompilerLanguage.CSharp) { Settings = new DecompilerSettingsDto(Baml: new BamlDecompilerSettingsDto(NewLineOnAttributes: false, UseTabs: false)) },
			TestContext.Current.CancellationToken);
		var spacedLines = spaced.Text.Split('\n');
		Assert.DoesNotContain(spacedLines, line => line.StartsWith('\t'));
		Assert.Contains(spacedLines, line => line.StartsWith("    <", StringComparison.Ordinal));
		Assert.Contains("xmlns", spacedLines.First(line => line.StartsWith("<UserControl", StringComparison.Ordinal)), StringComparison.Ordinal);

		// Disassemble BAML: the records instead, each painted in the color its writer gave it.
		var records = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, baml.Id, DecompilerLanguage.CSharp) { Settings = new DecompilerSettingsDto(Baml: new BamlDecompilerSettingsDto(DisassembleBaml: true)) },
			TestContext.Current.CancellationToken);
		Assert.Equal("baml", records.Language);
		Assert.Contains("DocumentStart", records.Text, StringComparison.Ordinal);
		Assert.Contains("DocumentEnd", records.Text, StringComparison.Ordinal);
		Assert.Contains(records.Spans, span => span.Color is not null && span.Color != "text");

		// Save writes what the tab shows, under the name dnSpy gives it.
		var saved = await manager.GetResourceItemsAsync(new ResourceItemsRequest(opened.WorkspaceId, [baml.Id], false) { Baml = new BamlDecompilerSettingsDto(DisassembleBaml: true) }, TestContext.Current.CancellationToken);
		Assert.EndsWith(".baml", Assert.Single(saved.Items).Name, StringComparison.OrdinalIgnoreCase);
		var savedXaml = await manager.GetResourceItemsAsync(new ResourceItemsRequest(opened.WorkspaceId, [baml.Id], false), TestContext.Current.CancellationToken);
		Assert.EndsWith(".xaml", Assert.Single(savedXaml.Items).Name, StringComparison.OrdinalIgnoreCase);
	}

	/// <summary>
	/// The engine has no symbol store to read a debuggee's locals from, so the names it shows come
	/// from the decompiler and are matched to ICorDebug slots by index.
	/// </summary>
	[Fact]
	public async Task GetVariableNames_NamesTheArgumentsAndLocalsOfAMethodBody() {
		var path = Path.Combine(AppContext.BaseDirectory, "DebugTarget.dll");
		Assert.True(File.Exists(path), $"The debuggee was not copied to the test output: {path}");
		using var module = ModuleDefMD.Load(path);
		var calculate = module.GetTypes()
			.SelectMany(type => type.Methods)
			.Single(method => method.Name == "Calculate");

		var names = await manager.GetVariableNamesAsync(null, path, unchecked((int)calculate.MDToken.Raw), TestContext.Current.CancellationToken);

		// `left` and `right` are the parameters, `sum` and `i` the locals: arguments first, then slots.
		// The locals are named from the PDB beside the assembly — the metadata holds no names for them.
		Assert.Equal(["left", "right", "sum", "i"], names.Select(name => name.Name));
		Assert.Equal([true, true, false, false], names.Select(name => name.IsArgument));
		Assert.Equal([0, 1, 0, 1], names.Select(name => name.Index));
		Assert.All(names, name => Assert.Contains("Int32", name.TypeName, StringComparison.Ordinal));
	}

	/// <summary>
	/// A debuggee built without symbols still has to answer: the arguments keep their metadata names
	/// and each local keeps a slot to match, so the Locals window shows values even without a PDB.
	/// </summary>
	[Fact]
	public async Task GetVariableNames_StillAnswersWithoutAPdbBesideTheModule() {
		var directory = Directory.CreateTempSubdirectory("dnspy-nopdb-");
		try {
			var source = Path.Combine(AppContext.BaseDirectory, "DebugTarget.dll");
			var path = Path.Combine(directory.FullName, "DebugTarget.dll");
			File.Copy(source, path);
			using var module = ModuleDefMD.Load(path);
			var calculate = module.GetTypes()
				.SelectMany(type => type.Methods)
				.Single(method => method.Name == "Calculate");

			var names = await manager.GetVariableNamesAsync(null, path, unchecked((int)calculate.MDToken.Raw), TestContext.Current.CancellationToken);

			Assert.Equal(4, names.Count);
			Assert.Equal(["left", "right"], names.Take(2).Select(name => name.Name));
			Assert.All(names, name => Assert.False(string.IsNullOrEmpty(name.Name)));
		}
		finally {
			directory.Delete(recursive: true);
		}
	}

	/// <summary>A method without a body has no slots, so it answers with nothing rather than failing.</summary>
	[Fact]
	public async Task GetVariableNames_IsEmptyForAMethodWithoutABody() {
		var opened = await OpenContractsAssemblyAsync();
		var method = typeof(IDebugSymbolResolver).GetMethod(nameof(IDebugSymbolResolver.FindMethodsAsync))!;

		var names = await manager.GetVariableNamesAsync(opened.WorkspaceId, typeof(IDebugSymbolResolver).Assembly.Location, method.MetadataToken, TestContext.Current.CancellationToken);

		Assert.Empty(names);
	}

	/// <summary>
	/// A step is nothing but a set of breakpoints on the statements it may land on, so the resolver has to
	/// hand back every statement of the body that is not on the line the thread stopped on: the runtime
	/// reports whichever of them the thread reaches first, and only it knows the order a loop runs in.
	/// The statements left out are the ones that could not move the client's stopped marker.
	/// </summary>
	[Fact]
	public async Task GetSteppingTargets_AreTheStatementsTheStepMayLandOn() {
		var path = Path.Combine(AppContext.BaseDirectory, "DebugTarget.dll");
		Assert.True(File.Exists(path), $"The debuggee was not copied to the test output: {path}");
		using var module = ModuleDefMD.Load(path);
		var calculate = module.GetTypes()
			.SelectMany(type => type.Methods)
			.Single(method => method.Name == "Calculate");
		var token = unchecked((int)calculate.MDToken.Raw);
		// The loop body is `sum += left;` and the header is the `for` it runs under, offsets read from the
		// PDB: the step is asked from the body, the way a breakpoint in the loop asks for it.
		var loopBody = SourceOffset(calculate, line: 39);
		var loopHeader = SourceOffset(calculate, line: 38);

		var response = await manager.GetSteppingTargetsAsync(null, path, token, loopBody, stepInto: false, TestContext.Current.CancellationToken);

		Assert.NotNull(response);
		Assert.NotEmpty(response.Targets);
		Assert.All(response.Targets, target => Assert.Equal(token, target.MetadataToken));
		var offsets = response.Targets.Select(target => target.IlOffset).ToArray();
		Assert.Equal(offsets.OrderBy(offset => offset).ToArray(), offsets);
		Assert.Equal(offsets.Length, offsets.Distinct().Count());
		// A statement on the line the thread is stopped on would report a stop that moves nothing, while
		// the header is armed even though it is behind the body: the loop reaches the body from it.
		Assert.DoesNotContain(loopBody, offsets);
		Assert.Contains(loopHeader, offsets);
		// The loop has statements to run again, so the step stays inside the method.
		Assert.False(response.LeavesMethod);
	}

	/// <summary>The offset a source line's first instruction was compiled to, read from the PDB.</summary>
	static int SourceOffset(MethodDef method, int line) {
		var points = ReadSequencePoints(Path.ChangeExtension(method.Module.Location, ".pdb"), method.MDToken.ToInt32());
		return points.First(point => !point.IsHidden && point.StartLine == line).Offset;
	}

	/// <summary>
	/// "Step into" has to add the first statement of the method the current instruction calls —
	/// without it there is no breakpoint inside the callee, so the step could only overshoot it.
	/// </summary>
	[Fact]
	public async Task GetSteppingTargets_SteppingIntoACallAlsoTargetsTheCallee() {
		var path = Path.Combine(AppContext.BaseDirectory, "DebugTarget.dll");
		Assert.True(File.Exists(path), $"The debuggee was not copied to the test output: {path}");
		using var module = ModuleDefMD.Load(path);
		var program = module.GetTypes().Single(type => type.Name == "Program");
		var main = program.Methods.Single(method => method.Name == "Main");
		var calculate = program.Methods.Single(method => method.Name == "Calculate");
		var mainToken = unchecked((int)main.MDToken.Raw);
		var calculateToken = unchecked((int)calculate.MDToken.Raw);
		var call = main.Body.Instructions.Single(instruction => instruction.Operand is MethodDef callee && callee.Name == "Calculate");

		var into = await manager.GetSteppingTargetsAsync(null, path, mainToken, (int)call.Offset, stepInto: true, TestContext.Current.CancellationToken);
		var over = await manager.GetSteppingTargetsAsync(null, path, mainToken, (int)call.Offset, stepInto: false, TestContext.Current.CancellationToken);
		// Asking from an offset before the method starts yields every statement, so the first one is
		// whatever the resolver considers the callee's entry — no need to hard-code an IL offset.
		var calleeStatements = await manager.GetSteppingTargetsAsync(null, path, calculateToken, -1, stepInto: false, TestContext.Current.CancellationToken);

		Assert.NotNull(into);
		Assert.NotNull(over);
		Assert.NotNull(calleeStatements);
		Assert.NotEmpty(calleeStatements.Targets);
		// Every statement of the callee is armed: the runtime stops at the first one the call runs.
		Assert.Contains(calleeStatements.Targets[0], into.Targets);
		Assert.DoesNotContain(over.Targets, target => target.MetadataToken == calculateToken);
		// The call is the last statement of `Main`, yet the callee does run, so the step goes into it
		// rather than out of the method.
		Assert.False(into.LeavesMethod);

		// A stop is on a statement's first instruction, and the call site pushes its arguments first, so
		// the call is not at the location a step starts from. The step still has to find it: the frame of
		// a breakpoint on the calling statement is the one a "step into" is asked from.
		var points = ReadSequencePoints(Path.ChangeExtension(main.Module.Location, ".pdb"), main.MDToken.ToInt32());
		var statementStart = points.Where(point => !point.IsHidden && point.Offset <= call.Offset).Max(point => point.Offset);
		Assert.True(statementStart < call.Offset, "The call is the first instruction of its statement, so the test covers nothing.");
		var fromStatementStart = await manager.GetSteppingTargetsAsync(null, path, mainToken, statementStart, stepInto: true, TestContext.Current.CancellationToken);

		Assert.NotNull(fromStatementStart);
		Assert.Contains(calleeStatements.Targets[0], fromStatementStart.Targets);
		Assert.False(fromStatementStart.LeavesMethod);
	}

	/// <summary>
	/// The callee of a step into need not live in a module the workspace holds, nor even beside the
	/// debuggee: a framework method's assembly is in the runtime the debuggee targets, which is a file the
	/// tree knows how to find and dnlib does not. The step reads it the same way the tree does, so F11
	/// enters the framework method instead of running past the call it was standing on.
	/// </summary>
	[Fact]
	public async Task GetSteppingTargets_SteppingIntoAFrameworkCallTargetsTheCallee() {
		var path = Path.Combine(AppContext.BaseDirectory, "DebugTarget.dll");
		Assert.True(File.Exists(path), $"The debuggee was not copied to the test output: {path}");
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
		using var module = ModuleDefMD.Load(path);
		var main = module.GetTypes().Single(type => type.Name == "Program").Methods.Single(method => method.Name == "Main");
		// `Console.WriteLine(...)` — the fixture's call whose body is in another module entirely.
		var call = main.Body.Instructions.First(instruction =>
			instruction.Operand is IMethod callee && callee.Name == "WriteLine" &&
			callee.MethodSig is { Params.Count: 1 } signature && signature.Params[0].ElementType == ElementType.I4);

		var into = await manager.GetSteppingTargetsAsync(opened.WorkspaceId, path, unchecked((int)main.MDToken.Raw), (int)call.Offset, stepInto: true, TestContext.Current.CancellationToken);

		Assert.NotNull(into);
		// The runtime the debuggee targets is where the callee lives, and every target of the step names
		// the file it was read from rather than the debuggee's own.
		var frameworkTargets = into.Targets.Where(target => !string.Equals(target.ModulePath, path, StringComparison.Ordinal)).ToArray();
		Assert.NotEmpty(frameworkTargets);
		Assert.All(frameworkTargets, target => Assert.Contains("System.Console", Path.GetFileName(target.ModulePath)));
		// The call does run, so the step goes into it rather than out of the method.
		Assert.False(into.LeavesMethod);
	}

	/// <summary>
	/// The statement a step into starts from can open with a call the workspace has nothing to enter: the
	/// fixture's <c>Console.WriteLine(ViaDelegate(doubler, left))</c> has its delegate local cached by the
	/// compiler, so the statement's IL begins in the cache — a <c>newobj</c> on <c>System.Func`2</c>, a type
	/// the debuggee's reference only forwards to the core library, whose constructor the runtime supplies and
	/// no assembly declares a body for. Arming nothing from it and giving up would turn the step into a step
	/// over; the step has to keep reading the statement and arm the call it does reach.
	/// </summary>
	[Fact]
	public async Task GetSteppingTargets_SteppingIntoAStatementThatOpensWithABodylessCallStillTargetsTheCallee() {
		var path = Path.Combine(AppContext.BaseDirectory, "DebugTarget.dll");
		Assert.True(File.Exists(path), $"The debuggee was not copied to the test output: {path}");
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
		using var module = ModuleDefMD.Load(path);
		var program = module.GetTypes().Single(type => type.Name == "Program");
		var main = program.Methods.Single(method => method.Name == "Main");
		var viaDelegate = program.Methods.Single(method => method.Name == "ViaDelegate");
		var token = unchecked((int)main.MDToken.Raw);
		var call = main.Body.Instructions.First(instruction => instruction.Operand is IMethod callee && callee.Name == "ViaDelegate");
		// The statement is the one the client arms a breakpoint on, read from the decompiled document the
		// same way the client reads it: the line's IL range, not the offset of the call.
		var member = await manager.FindMemberAsync(new FindMemberRequest(opened.WorkspaceId, path, token), TestContext.Current.CancellationToken);
		var document = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, member.NodeId!, DecompilerLanguage.CSharp),
			TestContext.Current.CancellationToken);
		var statements = (document.CodeStatements ?? [])
			.Where(candidate => !candidate.IsHidden && candidate.MetadataToken == token)
			.ToArray();
		var armed = statements.Single(candidate => candidate.IlOffset <= call.Offset && call.Offset < candidate.IlEndOffset);
		// The runtime only accepts a breakpoint on a sequence point, so that is where it stops the thread and
		// where the step is asked from — not the statement's own code, which here sits behind the cache.
		var stop = armed.SequencePointIlOffset;
		var current = statements.Single(candidate => stop >= candidate.SequencePointIlOffset && stop < candidate.IlEndOffset);

		// The statement's first call, from where the step is asked, is the delegate's constructor, and that is
		// what makes the step's first attempt fail. Should the compiler stop caching the delegate, the first
		// call would be the one the step is after and this test would no longer cover the shape it was written
		// for — so the precondition is asserted rather than assumed.
		var firstCall = main.Body.Instructions.First(instruction =>
			instruction.Offset >= stop && instruction.Offset < current.IlEndOffset &&
			instruction.OpCode.Code is Code.Call or Code.Callvirt or Code.Newobj);
		Assert.Equal(Code.Newobj, firstCall.OpCode.Code);
		Assert.StartsWith("System.Func`2", ((IMethod)firstCall.Operand!).DeclaringType!.FullName, StringComparison.Ordinal);

		var into = await manager.GetSteppingTargetsAsync(opened.WorkspaceId, path, token, stop, stepInto: true, TestContext.Current.CancellationToken);

		Assert.NotNull(into);
		// The call the statement does reach is armed, so the step lands inside ViaDelegate instead of running
		// past it — the body-less constructor before it is skipped rather than ending the search.
		Assert.Contains(into.Targets, target =>
			target.MetadataToken == unchecked((int)viaDelegate.MDToken.Raw) &&
			string.Equals(target.ModulePath, path, StringComparison.Ordinal));
		Assert.False(into.LeavesMethod);
	}

	/// <summary>
	/// The end of a body is where a step has to leave the method: no statement of it can run again, so the
	/// engine asks the runtime to step out and the stop is reported in the caller.
	/// </summary>
	[Fact]
	public async Task GetSteppingTargets_LeaveTheMethodAfterItsLastStatement() {
		var path = Path.Combine(AppContext.BaseDirectory, "DebugTarget.dll");
		Assert.True(File.Exists(path), $"The debuggee was not copied to the test output: {path}");
		using var module = ModuleDefMD.Load(path);
		var calculate = module.GetTypes()
			.SelectMany(type => type.Methods)
			.Single(method => method.Name == "Calculate");
		var last = calculate.Body.Instructions[^1];
		var end = (int)last.Offset + last.GetSize();
		// The last statement is the `return`, which the step must not land on again. The body's other
		// statements are still armed — a loop runs its body again, and which pass the thread is on is
		// not something a step can know from the IL — so the assertion is about the return alone.
		var returnOffset = SourceOffset(calculate, line: 41);

		var response = await manager.GetSteppingTargetsAsync(null, path, unchecked((int)calculate.MDToken.Raw), end, stepInto: false, TestContext.Current.CancellationToken);

		Assert.NotNull(response);
		Assert.True(response.LeavesMethod);
		Assert.DoesNotContain(returnOffset, response.Targets.Select(target => target.IlOffset));
	}

	/// <summary>
	/// An async method's IL is the state machine's <c>MoveNext</c>, and the compiler charges the code that
	/// copies an argument into the machine to the statement that follows it — so a statement's own start is
	/// not an offset the runtime will accept a breakpoint on. The sequence point is, and both are answered so
	/// a click still binds while the statement keeps its own identity.
	/// </summary>
	[Fact]
	public async Task ResolveBreakpoints_NamesTheOffsetAStateMachineWillAccept() {
		var (path, opened, node, document) = await OpenMethodDocumentAsync("AddAsync(");
		var sum = Assert.Single(
			document.CodeStatements ?? [],
			statement => statement.StartLine == LineOf(document.Text, "int sum = left + right;"));

		// The body's offsets belong to the generated MoveNext, which is not the method the user wrote.
		using var module = ModuleDefMD.Load(path);
		var addAsync = module.GetTypes().SelectMany(type => type.Methods).Single(method => method.Name == "AddAsync");
		Assert.NotEqual(unchecked((int)addAsync.MDToken.Raw), sum.MetadataToken);
		// The premise of the test: the statement starts inside the point that covers it. If the compiler
		// ever stops doing that, the case is no longer covered and the assertion below would be false.
		Assert.NotEqual(sum.SequencePointIlOffset, sum.IlOffset);

		var response = await manager.ResolveBreakpointsAsync(opened.WorkspaceId, [new BreakpointQuery("sum", node.Id, sum.StartLine)], TestContext.Current.CancellationToken);

		var breakpoint = Assert.Single(response.Breakpoints);
		Assert.True(breakpoint.Bound, breakpoint.Reason);
		Assert.Equal(sum.MetadataToken, breakpoint.MetadataToken);
		Assert.Equal(sum.IlOffset, breakpoint.IlOffset);
		Assert.Equal(sum.SequencePointIlOffset, breakpoint.SequencePointIlOffset);
	}

	/// <summary>
	/// Stepping through a state machine needs both offsets of every statement it may land on: the runtime
	/// refuses the statement's own start wherever the point that covers it begins earlier, and it is the
	/// statement's own start that says which line a stop belongs to. Arming only one of them leaves either
	/// the step unable to land or the line it reports wrong.
	/// </summary>
	[Fact]
	public async Task GetSteppingTargets_ArmsTheOffsetsAStateMachineWillAccept() {
		var (path, opened, _, document) = await OpenMethodDocumentAsync("AddAsync(");
		var statements = (document.CodeStatements ?? []).Where(statement => !statement.IsHidden).ToArray();
		var sum = Assert.Single(statements, statement => statement.StartLine == LineOf(document.Text, "int sum = left + right;"));
		var wait = Assert.Single(statements, statement => statement.StartLine == LineOf(document.Text, "await Task.Yield();"));
		var ret = Assert.Single(statements, statement => statement.StartLine == LineOf(document.Text, "return sum;"));

		// A breakpoint on the statement stops where the runtime accepts the breakpoint, which is the point.
		var response = await manager.GetSteppingTargetsAsync(opened.WorkspaceId, path, sum.MetadataToken, sum.SequencePointIlOffset, stepInto: false, TestContext.Current.CancellationToken);

		var targets = Assert.IsAssignableFrom<IReadOnlyList<SteppingTarget>>(response?.Targets);
		var offsets = targets.Select(target => target.IlOffset).ToArray();
		Assert.All(targets, target => Assert.Equal(sum.MetadataToken, target.MetadataToken));
		// The statement the step starts from is not armed again: stopping there moves no marker.
		Assert.DoesNotContain(sum.IlOffset, offsets);
		Assert.DoesNotContain(sum.SequencePointIlOffset, offsets);
		// What it can reach is armed at the offset the runtime accepts and at the statement's own start.
		Assert.Contains(wait.IlOffset, offsets);
		Assert.Contains(ret.SequencePointIlOffset, offsets);
		Assert.Contains(ret.IlOffset, offsets);
		// The suspension is inside the method, so the step stays in it.
		Assert.False(response!.LeavesMethod);
	}

	/// <summary>
	/// A point whose leading IL branches belongs to the statement before it — a loop's condition tail,
	/// which the tiling charges to whatever follows — and the runtime accepts a breakpoint there. It is
	/// not offered as a fallback: the thread would stop inside the loop's condition on every pass while
	/// the client reported the line after it.
	/// </summary>
	[Fact]
	public async Task ResolveBreakpoints_RefusesAPointThatBranchesAwayFromItsStatement() {
		var (path, opened, node, document) = await OpenMethodDocumentAsync("Calculate(");
		var statements = (document.CodeStatements ?? []).Where(statement => !statement.IsHidden).ToArray();
		var body = Assert.Single(statements, statement => statement.StartLine == LineOf(document.Text, "+="));
		var ret = Assert.Single(statements, statement => statement.StartLine == LineOf(document.Text, "return "));
		// The premise: the tiling starts the return's point on the loop's own condition tail.
		Assert.True(ret.SequencePointIlOffset < ret.IlOffset, "The tiling no longer charges the loop's tail to the return.");

		var response = await manager.ResolveBreakpointsAsync(opened.WorkspaceId, [new BreakpointQuery("ret", node.Id, ret.StartLine)], TestContext.Current.CancellationToken);

		var breakpoint = Assert.Single(response.Breakpoints);
		Assert.True(breakpoint.Bound, breakpoint.Reason);
		Assert.Equal(ret.IlOffset, breakpoint.IlOffset);
		Assert.Null(breakpoint.SequencePointIlOffset);

		// A step run from the loop's body arms the return, since the loop can reach it — but only at the
		// offset the statement's own code starts at.
		var targets = await manager.GetSteppingTargetsAsync(opened.WorkspaceId, path, ret.MetadataToken, body.IlOffset, stepInto: false, TestContext.Current.CancellationToken);

		Assert.NotNull(targets);
		var offsets = targets.Targets.Select(target => target.IlOffset).ToArray();
		Assert.Contains(ret.IlOffset, offsets);
		Assert.DoesNotContain(ret.SequencePointIlOffset, offsets);
	}

	/// <summary>
	/// A bookmark is saved as module path plus metadata token, because node ids only live as long as the
	/// workspace that minted them. Resolving it back is what makes a bookmark survive a restart.
	/// </summary>
	[Fact]
	public async Task FindMember_ResolvesAPersistedBookmarkBackToItsNode() {
		var (_, opened, node, document) = await OpenMethodDocumentAsync("AddAsync(");
		var sum = Assert.Single(document.CodeStatements ?? [], statement => statement.StartLine == LineOf(document.Text, "int sum = left + right;"));

		var found = await manager.FindMemberAsync(
			new FindMemberRequest(opened.WorkspaceId, sum.ModulePath, sum.SourceMethodToken),
			TestContext.Current.CancellationToken);

		Assert.Equal(node.Id, found.NodeId);
		Assert.Equal(node.Label, found.Label);
		Assert.False(string.IsNullOrWhiteSpace(found.Description));

		// The token the IL itself is named by belongs to the generated MoveNext. Resolving that would take
		// the user somewhere they never wrote, which is why the source token is the one that gets saved.
		var moveNext = await manager.FindMemberAsync(
			new FindMemberRequest(opened.WorkspaceId, sum.ModulePath, sum.MetadataToken),
			TestContext.Current.CancellationToken);

		Assert.NotNull(moveNext.NodeId);
		Assert.NotEqual(node.Id, moveNext.NodeId);
		Assert.Contains("MoveNext", moveNext.Label!, StringComparison.Ordinal);
	}

	[Fact]
	public async Task FindMember_AnswersNothingForWhatItCannotResolve() {
		var opened = await OpenContractsAssemblyAsync();
		var path = opened.Modules[0].Path;

		async Task<FindMemberResponse> Find(string modulePath, int metadataToken) => await manager.FindMemberAsync(
			new FindMemberRequest(opened.WorkspaceId, modulePath, metadataToken),
			TestContext.Current.CancellationToken);

		// A module this workspace never opened, a token its assembly does not contain, and no token at all.
		var missing = Path.Combine(Path.GetDirectoryName(path)!, "Missing.dll");
		Assert.Null((await Find(missing, 0x06000001)).NodeId);
		Assert.Null((await Find(path, 0x0600FFFF)).NodeId);
		Assert.Null((await Find(path, 0)).NodeId);
	}

	/// <summary>
	/// "Go to Token" reads what a user typed the way the tree and the copy commands write it: the token may
	/// carry its "0x" or not, and the table it names picks the row. A token the module has no row for names
	/// nothing; text that is not a token at all is an error rather than a silent miss.
	/// </summary>
	[Fact]
	public async Task FindByToken_ResolvesATypedTokenToItsRow() {
		var opened = await OpenContractsAssemblyAsync();
		var getter = await FindRpcExceptionGetterAsync(opened.WorkspaceId);
		var module = await FindModuleAsync(opened.WorkspaceId);
		var token = typeof(RpcException).GetProperty(nameof(RpcException.Code))!.GetGetMethod()!.MetadataToken;

		async Task<FindByTokenResponse> Find(string text) => await manager.FindByTokenAsync(
			new FindByTokenRequest(opened.WorkspaceId, module.Id, text),
			TestContext.Current.CancellationToken);

		// Both spellings of the same token land on the same row, and a type's row is reachable the same way.
		Assert.Equal(getter.Id, (await Find($"0x{token:X8}")).NodeId);
		Assert.Equal(getter.Id, (await Find($"{token:X8}")).NodeId);
		var type = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", "RpcException");
		Assert.Equal(type.Id, (await Find($"0x{typeof(RpcException).MetadataToken:X8}")).NodeId);

		// A row the tree does not show and a token past the end of the table both name nothing.
		Assert.Null((await Find("0x0600FFFF")).NodeId);

		var refused = await Assert.ThrowsAsync<RpcException>(() => Find("not a token"));
		Assert.Equal(ErrorCodes.InvalidParams, refused.Code);
	}

	[Fact]
	public async Task FindByToken_RefusesANodeThatIsNotInAManagedAssembly() {
		var path = Path.Combine(Path.GetTempPath(), $"dnspy-unknown-{Guid.NewGuid():N}");
		await File.WriteAllBytesAsync(
			path,
			[0x7F, (byte)'E', (byte)'L', (byte)'F', 2, 1, 1, ..new byte[32]],
			TestContext.Current.CancellationToken);
		try {
			var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
			var root = Assert.Single((await manager.GetRootsAsync(
				new WorkspaceRequest(opened.WorkspaceId),
				TestContext.Current.CancellationToken)).Nodes);

			var refused = await Assert.ThrowsAsync<RpcException>(() => manager.FindByTokenAsync(
				new FindByTokenRequest(opened.WorkspaceId, root.Id, "0x06000001"),
				TestContext.Current.CancellationToken));
			Assert.Equal(ErrorCodes.InvalidParams, refused.Code);
		}
		finally {
			File.Delete(path);
		}
	}

	/// <summary>
	/// The entry point and the global type's static constructor are ordinary members, so the two "Go to ..."
	/// commands answer with the node the tree would give them. Neither is listed until it is asked for, and
	/// the answer is the id, not the row — the client reveals it the way it reveals any other node.
	/// </summary>
	[Fact]
	public async Task GetSpecialNode_AnswersWithTheEntryPointAndTheGlobalCctor() {
		var path = Path.Combine(AppContext.BaseDirectory, "DebugTarget.dll");
		Assert.True(File.Exists(path), $"The debuggee was not copied to the test output: {path}");
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
		var module = await FindModuleAsync(opened.WorkspaceId);

		async Task<SpecialNodeResponse> Special(string kind) => await manager.GetSpecialNodeAsync(
			new SpecialNodeRequest(opened.WorkspaceId, module.Id, kind),
			TestContext.Current.CancellationToken);

		var entryPoint = await Special(SpecialNodeKinds.EntryPoint);
		Assert.NotNull(entryPoint.NodeId);
		Assert.Equal(
			"Main(string[])",
			(await manager.GetNodeAsync(new NodeRequest(opened.WorkspaceId, entryPoint.NodeId!), TestContext.Current.CancellationToken)).Label);

		// The fixture's [ModuleInitializer] is what the module's global type ctor calls, so the module has one.
		var globalCctor = await Special(SpecialNodeKinds.GlobalCctor);
		Assert.NotNull(globalCctor.NodeId);
		Assert.Contains(
			"cctor",
			(await manager.GetNodeAsync(new NodeRequest(opened.WorkspaceId, globalCctor.NodeId!), TestContext.Current.CancellationToken)).Label,
			StringComparison.OrdinalIgnoreCase);

		var unknown = await Assert.ThrowsAsync<RpcException>(() => Special("nowhere"));
		Assert.Equal(ErrorCodes.InvalidParams, unknown.Code);
	}

	[Fact]
	public async Task GetSpecialNode_AnswersNothingForAModuleWithoutTheMember() {
		var opened = await OpenContractsAssemblyAsync();
		var module = await FindModuleAsync(opened.WorkspaceId);

		async Task<SpecialNodeResponse> Special(string kind) => await manager.GetSpecialNodeAsync(
			new SpecialNodeRequest(opened.WorkspaceId, module.Id, kind),
			TestContext.Current.CancellationToken);

		// A record library is neither an executable nor one with a global type of its own.
		Assert.Null((await Special(SpecialNodeKinds.EntryPoint)).NodeId);
		Assert.Null((await Special(SpecialNodeKinds.GlobalCctor)).NodeId);
	}

	/// <summary>
	/// Remove Assembly takes the whole document: the assembly root, its module row, and every row the tree
	/// had listed under them — whichever of those rows the command was run on. The ids it dropped come back
	/// so the client can close the tabs still showing them.
	/// </summary>
	[Fact]
	public async Task RemoveModule_TakesTheAssemblyAndEveryRowUnderIt() {
		// Each row of the assembly names the same document, so the command answers the same way from all of
		// them: the assembly root, the module row, and a member row under it.
		var opened = await OpenContractsAssemblyAsync();
		var getter = await FindRpcExceptionGetterAsync(opened.WorkspaceId);
		var module = await FindModuleAsync(opened.WorkspaceId);
		var assembly = Assert.Single((await manager.GetRootsAsync(
			new WorkspaceRequest(opened.WorkspaceId),
			TestContext.Current.CancellationToken)).Nodes);
		foreach (var node in new[] { assembly, module, getter }) {
			var removed = await manager.RemoveModuleAsync(
				new NodeRequest(opened.WorkspaceId, node.Id),
				TestContext.Current.CancellationToken);

			// Everything the tree had listed for the module is in the answer, including the row that was
			// clicked, and the tree is left with nothing on it.
			Assert.Contains(getter.Id, removed.RemovedNodeIds);
			Assert.Contains(node.Id, removed.RemovedNodeIds);
			Assert.Empty(removed.Roots);
			// Nothing names the rows it dropped any more, and the same file opens cleanly again.
			await Assert.ThrowsAsync<RpcException>(() => manager.GetNodeAsync(
				new NodeRequest(opened.WorkspaceId, getter.Id),
				TestContext.Current.CancellationToken));
			opened = await OpenContractsAssemblyAsync();
			getter = await FindRpcExceptionGetterAsync(opened.WorkspaceId);
			module = await FindModuleAsync(opened.WorkspaceId);
			assembly = Assert.Single((await manager.GetRootsAsync(
				new WorkspaceRequest(opened.WorkspaceId),
				TestContext.Current.CancellationToken)).Nodes);
		}
	}

	/// <summary>
	/// A file that is not a managed assembly is a document all the same, and dnSpy's Remove Assembly takes any
	/// root document (RemoveAssemblyCommand.CanExecute: a DsDocumentNode at the root) — Close All Missing
	/// Files is nothing but that command run over the unknown documents. Its rows go with it.
	/// </summary>
	[Fact]
	public async Task RemoveModule_TakesAFileThatIsNotAManagedAssembly() {
		var path = Path.Combine(Path.GetTempPath(), $"dnspy-unknown-{Guid.NewGuid():N}");
		await File.WriteAllBytesAsync(
			path,
			[0x7F, (byte)'E', (byte)'L', (byte)'F', 2, 1, 1, ..new byte[32]],
			TestContext.Current.CancellationToken);
		try {
			var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
			var root = Assert.Single((await manager.GetRootsAsync(
				new WorkspaceRequest(opened.WorkspaceId),
				TestContext.Current.CancellationToken)).Nodes);

			var removed = await manager.RemoveModuleAsync(
				new NodeRequest(opened.WorkspaceId, root.Id),
				TestContext.Current.CancellationToken);
			Assert.Contains(root.Id, removed.RemovedNodeIds);
			Assert.Empty(removed.Roots);
			Assert.Empty((await manager.GetRootsAsync(
				new WorkspaceRequest(opened.WorkspaceId),
				TestContext.Current.CancellationToken)).Nodes);
		}
		finally {
			File.Delete(path);
		}
	}

	/// <summary>
	/// Save Resource asks a resource node for its bytes, and the name the dialog suggests comes back with
	/// them. The bytes are read out of the module the workspace holds, so an edit that has not been saved
	/// yet is what would be written.
	/// </summary>
	[Fact]
	public async Task GetResourceData_AnswersWithTheResourceBytesAndItsName() {
		var opened = await manager.OpenAsync(
			new OpenWorkspaceRequest([typeof(WorkspaceManagerTests).Assembly.Location]),
			TestContext.Current.CancellationToken);
		var module = await FindModuleAsync(opened.WorkspaceId);
		var resources = Assert.Single(
			(await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, module.Id), TestContext.Current.CancellationToken)).Nodes,
			node => node.Kind == "resourcesgroup");
		var resource = Assert.Single(
			(await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, resources.Id), TestContext.Current.CancellationToken)).Nodes,
			node => node.Label.EndsWith("sample-resource.txt", StringComparison.Ordinal));

		var data = await manager.GetResourceDataAsync(
			new ResourceDataRequest(opened.WorkspaceId, resource.Id),
			TestContext.Current.CancellationToken);

		Assert.EndsWith("sample-resource.txt", data.Name, StringComparison.Ordinal);
		// The bytes are the fixture's own, which the test project embeds from its Fixtures folder.
		var name = Assert.Single(typeof(WorkspaceManagerTests).Assembly.GetManifestResourceNames(), name => name.EndsWith("sample-resource.txt", StringComparison.Ordinal));
		using var stream = typeof(WorkspaceManagerTests).Assembly.GetManifestResourceStream(name)!;
		using var buffer = new MemoryStream();
		await stream.CopyToAsync(buffer, TestContext.Current.CancellationToken);
		Assert.Equal(buffer.ToArray(), Convert.FromBase64String(data.Base64Data));

		// A node that holds no resource refuses rather than writing out something that is not one.
		var other = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Tests", nameof(WorkspaceManagerTests));
		var refused = await Assert.ThrowsAsync<RpcException>(() => manager.GetResourceDataAsync(
			new ResourceDataRequest(opened.WorkspaceId, other.Id),
			TestContext.Current.CancellationToken));
		Assert.Equal(ErrorCodes.InvalidParams, refused.Code);
	}

	/// <summary>
	/// Load Dependencies opens the assemblies the module's references name, so the reference rows stop being
	/// dead ends. Running it again is a no-op: everything it would load is in the tree by then.
	/// </summary>
	[Fact]
	public async Task LoadDependencies_OpensTheAssembliesTheModulesReferencesName() {
		var opened = await manager.OpenAsync(
			new OpenWorkspaceRequest([typeof(WorkspaceManager).Assembly.Location]),
			TestContext.Current.CancellationToken);
		var module = await FindModuleAsync(opened.WorkspaceId);
		var request = new LoadDependenciesRequest(opened.WorkspaceId, module.Id, Recursive: false);

		var loaded = await manager.LoadDependenciesAsync(request, TestContext.Current.CancellationToken);

		// The core assembly's references are files that sit beside it: dnlib and the contracts assembly.
		var names = loaded.Modules.Select(entry => entry.Name).ToArray();
		Assert.Contains("dnlib", names);
		Assert.Contains("dnSpy.Backend.Contracts", names);
		Assert.True(loaded.Modules.Count > opened.Modules.Count, "the tree should have grown");

		// Every one of them is a document now, and asking a second time adds nothing because it is all open.
		var again = await manager.LoadDependenciesAsync(request, TestContext.Current.CancellationToken);
		Assert.Equal(loaded.Modules.Count, again.Modules.Count);
		Assert.Equal(
			loaded.Modules.Count,
			(await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Nodes.Count);
	}

	/// <summary>
	/// The recursive form walks the closure: every assembly it opens has its own references followed too. A
	/// reference that leads back to something already walked is not followed twice, which is what keeps a
	/// cycle between two assemblies from turning the walk into an endless one.
	/// </summary>
	[Fact]
	public async Task LoadDependencies_WalksTheWholeClosureWhenAskedRecursively() {
		var opened = await manager.OpenAsync(
			new OpenWorkspaceRequest([typeof(WorkspaceManager).Assembly.Location]),
			TestContext.Current.CancellationToken);
		var module = await FindModuleAsync(opened.WorkspaceId);

		var loaded = await manager.LoadDependenciesAsync(
			new LoadDependenciesRequest(opened.WorkspaceId, module.Id, Recursive: true),
			TestContext.Current.CancellationToken);

		// The closure is at least what the module's own references are, and no assembly appears twice.
		var names = loaded.Modules.Select(entry => entry.Name).ToArray();
		Assert.Contains("dnlib", names);
		Assert.Equal(names.Length, names.Distinct(StringComparer.Ordinal).Count());
		Assert.Equal(
			names.Length,
			(await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Nodes.Count);
	}

	/// <summary>
	/// A file the workspace holds as a PE image rather than a managed assembly has no reference table to walk,
	/// so the command is refused instead of quietly doing nothing.
	/// </summary>
	[Fact]
	public async Task LoadDependencies_RefusesAFileThatIsNotAManagedAssembly() {
		var path = Path.Combine(Path.GetTempPath(), $"dnspy-unknown-{Guid.NewGuid():N}");
		await File.WriteAllBytesAsync(
			path,
			[0x7F, (byte)'E', (byte)'L', (byte)'F', 2, 1, 1, ..new byte[32]],
			TestContext.Current.CancellationToken);
		try {
			var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
			var root = Assert.Single((await manager.GetRootsAsync(
				new WorkspaceRequest(opened.WorkspaceId),
				TestContext.Current.CancellationToken)).Nodes);

			var refused = await Assert.ThrowsAsync<RpcException>(() => manager.LoadDependenciesAsync(
				new LoadDependenciesRequest(opened.WorkspaceId, root.Id, Recursive: true),
				TestContext.Current.CancellationToken));
			Assert.Equal(ErrorCodes.InvalidParams, refused.Code);
		}
		finally {
			File.Delete(path);
		}
	}

	/// <summary>
	/// Convert Assembly to NetModule detaches the assembly's only module, and the row that named the assembly
	/// is the same row afterwards — it falls back to naming the file, since there is nothing else left to
	/// name. Undo puts the assembly back, definition and label alike.
	/// </summary>
	[Fact]
	public async Task ConvertModule_DetachesTheOnlyModuleAndUndoPutsItBack() {
		var opened = await OpenContractsAssemblyAsync();
		var module = await FindModuleAsync(opened.WorkspaceId);
		var assembly = Assert.Single((await manager.GetRootsAsync(
			new WorkspaceRequest(opened.WorkspaceId),
			TestContext.Current.CancellationToken)).Nodes);
		// The row names the assembly; its version travels apart, for the client to write when its options say so.
		Assert.Equal("dnSpy.Backend.Contracts", assembly.Label);
		Assert.NotNull(assembly.AssemblyVersion);
		Assert.Equal("dnSpy.Backend.Contracts.dll", module.Label);

		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.QueueConvertModuleAsync(
			new ConvertModuleRequest(opened.WorkspaceId, transaction.TransactionId, module.Id, ToAssembly: false),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		// The module row still names the file; the row above it now has no assembly to name and says so by
		// falling back to the module's own name.
		var converted = Assert.Single((await manager.GetRootsAsync(
			new WorkspaceRequest(opened.WorkspaceId),
			TestContext.Current.CancellationToken)).Nodes);
		Assert.Equal(assembly.Id, converted.Id);
		Assert.Equal("dnSpy.Backend.Contracts.dll", converted.Label);
		Assert.Equal("dnSpy.Backend.Contracts.dll", (await manager.GetNodeAsync(
			new NodeRequest(opened.WorkspaceId, module.Id),
			TestContext.Current.CancellationToken)).Label);

		await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		var restored = Assert.Single((await manager.GetRootsAsync(
			new WorkspaceRequest(opened.WorkspaceId),
			TestContext.Current.CancellationToken)).Nodes);
		Assert.Equal(assembly.Label, restored.Label);

		// Redo goes back to the net module, so the operation is the same one either way round.
		await manager.RedoAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		Assert.Equal("dnSpy.Backend.Contracts.dll", Assert.Single((await manager.GetRootsAsync(
			new WorkspaceRequest(opened.WorkspaceId),
			TestContext.Current.CancellationToken)).Nodes).Label);
	}

	/// <summary>
	/// Convert NetModule to Assembly gives a module that has none a fresh assembly definition named after
	/// its file — the file's name without the extension a module may end in — and the root row starts naming
	/// the assembly instead of the file.
	/// </summary>
	[Fact]
	public async Task ConvertModule_GivesANetModuleAnAssemblyNamedAfterItsFile() {
		var path = Path.Combine(Path.GetTempPath(), $"dnspy-netmodule-{Guid.NewGuid():N}.netmodule");
		// A net module is written without an assembly manifest, which is what makes it one.
		var netModule = new ModuleDefUser("Probe.netmodule", Guid.NewGuid(), new AssemblyRefUser("System.Runtime"));
		netModule.Kind = ModuleKind.NetModule;
		netModule.Write(path);
		try {
			var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
			var root = Assert.Single((await manager.GetRootsAsync(
				new WorkspaceRequest(opened.WorkspaceId),
				TestContext.Current.CancellationToken)).Nodes);
			// With no assembly to name, the row falls back to the module's file name.
			Assert.Equal("Probe.netmodule", root.Label);
			var module = await FindModuleAsync(opened.WorkspaceId);

			var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
			await manager.QueueConvertModuleAsync(
				new ConvertModuleRequest(opened.WorkspaceId, transaction.TransactionId, root.Id, ToAssembly: true),
				TestContext.Current.CancellationToken);
			await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

			var converted = Assert.Single((await manager.GetRootsAsync(
				new WorkspaceRequest(opened.WorkspaceId),
				TestContext.Current.CancellationToken)).Nodes);
			Assert.Equal("Probe", converted.Label);
			Assert.Equal("0.0.0.0", converted.AssemblyVersion);
			// The module row is untouched by any of this: it names the file it always did.
			Assert.Equal("Probe.netmodule", (await manager.GetNodeAsync(
				new NodeRequest(opened.WorkspaceId, module.Id),
				TestContext.Current.CancellationToken)).Label);

			await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
			Assert.Equal("Probe.netmodule", Assert.Single((await manager.GetRootsAsync(
				new WorkspaceRequest(opened.WorkspaceId),
				TestContext.Current.CancellationToken)).Nodes).Label);
		}
		finally {
			File.Delete(path);
		}
	}

	/// <summary>
	/// Each direction refuses what it does not apply to rather than quietly doing nothing, and a refusal
	/// leaves the tree exactly as it was.
	/// </summary>
	[Fact]
	public async Task ConvertModule_RefusesTheDirectionThatDoesNotApply() {
		var opened = await OpenContractsAssemblyAsync();
		var module = await FindModuleAsync(opened.WorkspaceId);
		var root = Assert.Single((await manager.GetRootsAsync(
			new WorkspaceRequest(opened.WorkspaceId),
			TestContext.Current.CancellationToken)).Nodes);
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);

		// The contracts assembly is an assembly already, so there is nothing for the other direction to give
		// it — and a row that is not a managed module has no module kind to write at all.
		foreach (var nodeId in new[] { module.Id, root.Id }) {
			var refused = await Assert.ThrowsAsync<RpcException>(() => manager.QueueConvertModuleAsync(
				new ConvertModuleRequest(opened.WorkspaceId, transaction.TransactionId, nodeId, ToAssembly: true),
				TestContext.Current.CancellationToken));
			Assert.Equal(ErrorCodes.EditValidationFailed, refused.Code);
		}

		Assert.Equal(root.Label, Assert.Single((await manager.GetRootsAsync(
			new WorkspaceRequest(opened.WorkspaceId),
			TestContext.Current.CancellationToken)).Nodes).Label);
	}

	[Fact]
	public async Task AddModules_AppendsToTheOpenWorkspaceWithoutDisturbingIt() {
		var opened = await OpenContractsAssemblyAsync();
		var getter = await FindRpcExceptionGetterAsync(opened.WorkspaceId);

		var added = await manager.AddModulesAsync(
			new AddModulesRequest(opened.WorkspaceId, [typeof(WorkspaceManagerTests).Assembly.Location]),
			TestContext.Current.CancellationToken);

		Assert.Equal(2, added.Modules.Count);
		Assert.Empty(added.Skipped);
		var roots = await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		Assert.Equal(2, roots.Nodes.Count);

		// The whole append design rests on the workspace instance being reused, so every node id it has
		// already handed out — and every id a client cached — still names the same node.
		var stillThere = await manager.GetNodeAsync(new NodeRequest(opened.WorkspaceId, getter.Id), TestContext.Current.CancellationToken);
		Assert.Equal(getter.Id, stillThere.Id);
		Assert.Equal(getter.Label, stillThere.Label);
	}

	[Fact]
	public async Task AddModules_SkipsFilesThatAreAlreadyOpen() {
		var opened = await OpenContractsAssemblyAsync();
		var path = opened.Modules[0].Path;

		var added = await manager.AddModulesAsync(
			new AddModulesRequest(opened.WorkspaceId, [path]),
			TestContext.Current.CancellationToken);

		// Adding a file twice is what dnSpy's drop handler is careful to avoid: it selects what is already
		// there rather than growing a second tree, so the answer is the file as skipped and no new module.
		Assert.Equal([path], added.Skipped);
		Assert.Single(added.Modules);
		var roots = await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		Assert.Single(roots.Nodes);
	}

	/// <summary>
	/// A file that is neither a managed assembly nor a PE image opens as an unknown document: the tree
	/// shows it under its file name and the tab holds that name, which is dnSpy's behaviour for anything it
	/// cannot read. Failing the whole command instead — which is what an ELF executable used to do — is the
	/// bug this pins down.
	/// </summary>
	[Fact]
	public async Task OpensAFileThatIsNeitherManagedNorPeAsAnUnknownDocument() {
		var path = Path.Combine(Path.GetTempPath(), $"dnspy-unknown-{Guid.NewGuid():N}");
		// An ELF header, the case that was reported. dnSpy's PE reader refuses it, so it never reaches the
		// managed path at all.
		await File.WriteAllBytesAsync(
			path,
			[0x7F, (byte)'E', (byte)'L', (byte)'F', 2, 1, 1, ..new byte[32]],
			TestContext.Current.CancellationToken);
		try {
			var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
			var root = Assert.Single((await manager.GetRootsAsync(
				new WorkspaceRequest(opened.WorkspaceId),
				TestContext.Current.CancellationToken)).Nodes);

			Assert.Equal("unknowndocument", root.Kind);
			Assert.Equal(Path.GetFileName(path), root.Label);
			Assert.Equal(path, root.Description);
			// dnSpy shows a document it could not read with DsImages.AssemblyError.
			Assert.Equal("AssemblyError", root.Icon);
			Assert.False(root.HasChildren);

			// It is in the module list too, so a session that is restored opens it again rather than
			// quietly dropping the file the user had.
			var module = Assert.Single(opened.Modules);
			Assert.Equal(path, module.Path);
			Assert.Equal(Path.GetFileName(path), module.Name);

			var document = await manager.DecompileAsync(
				new DecompileRequest(opened.WorkspaceId, root.Id, DecompilerLanguage.CSharp),
				TestContext.Current.CancellationToken);
			// NodeDecompiler.Decompile(UnknownDocumentNode) writes the file's full path, and nothing more.
			Assert.Equal($"// {path}", document.Text.TrimEnd());

			// dnSpy saves a file it can only show as bytes the way its hex editor does, so writing it back in place
			// with no patches on it leaves the file as it was.
			var before = await File.ReadAllBytesAsync(path, TestContext.Current.CancellationToken);
			var save = await manager.SaveModuleInPlaceAsync(
				new SaveModuleInPlaceRequest(opened.WorkspaceId, root.Id),
				TestContext.Current.CancellationToken);
			Assert.Equal(path, save.Path);
			Assert.Equal(before, await File.ReadAllBytesAsync(path, TestContext.Current.CancellationToken));
		}
		finally {
			File.Delete(path);
		}
	}

	/// <summary>
	/// One unreadable file in a multi-selection does not take the rest of it down: dnSpy opens every file
	/// it was given and keeps the ones it cannot read as unknown documents beside them.
	/// </summary>
	[Fact]
	public async Task OpeningAManagedAssemblyAndAnUnreadableFileKeepsBoth() {
		var path = Path.Combine(Path.GetTempPath(), $"dnspy-unknown-{Guid.NewGuid():N}");
		await File.WriteAllTextAsync(path, "not a managed assembly", TestContext.Current.CancellationToken);
		try {
			var assembly = typeof(HelloRequest).Assembly.Location;
			var opened = await manager.OpenAsync(
				new OpenWorkspaceRequest([assembly, path]),
				TestContext.Current.CancellationToken);
			var roots = (await manager.GetRootsAsync(
				new WorkspaceRequest(opened.WorkspaceId),
				TestContext.Current.CancellationToken)).Nodes;

			Assert.Equal(2, roots.Count);
			Assert.Equal(roots.Select(root => root.Id), opened.Modules.Select(module => module.Id));
			Assert.Single(roots, root => root.Kind == "assembly");
			Assert.Single(roots, root => root.Kind == "unknowndocument" && root.Label == Path.GetFileName(path));
		}
		finally {
			File.Delete(path);
		}
	}

	/// <summary>
	/// A PE image that is not a managed assembly is a PE document, named after its file, and its tab shows
	/// the header dnSpy's PE tab shows.
	/// </summary>
	[Fact]
	public async Task OpensANativePeFileAsAPeDocument() {
		var path = Path.Combine(Path.GetTempPath(), $"dnspy-native-{Guid.NewGuid():N}.exe");
		await File.WriteAllBytesAsync(path, MinimalNativePeImage(), TestContext.Current.CancellationToken);
		try {
			var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
			var root = Assert.Single((await manager.GetRootsAsync(
				new WorkspaceRequest(opened.WorkspaceId),
				TestContext.Current.CancellationToken)).Nodes);

			Assert.Equal("pedocument", root.Kind);
			Assert.Equal(Path.GetFileName(path), root.Label);
			Assert.Equal(path, root.Description);
			// dnSpy's PE document wears the image an assembly would, and this image is no DLL.
			Assert.Equal("AssemblyExe", root.Icon);

			// NodeDecompiler.Decompile(PEDocumentNode): the file's full path and the image's timestamp, in every
			// language — the headers are the PE node's document.
			var document = await manager.DecompileAsync(
				new DecompileRequest(opened.WorkspaceId, root.Id, DecompilerLanguage.CSharp),
				TestContext.Current.CancellationToken);
			var lines = document.Text.TrimEnd().Split('\n');
			Assert.Equal(2, lines.Length);
			Assert.Equal($"// {path}", lines[0]);
			Assert.StartsWith("// Timestamp: 60000000 (", lines[1], StringComparison.Ordinal);
			var il = await manager.DecompileAsync(
				new DecompileRequest(opened.WorkspaceId, root.Id, DecompilerLanguage.ILWithCSharp),
				TestContext.Current.CancellationToken);
			Assert.Equal(document.Text, il.Text);
			Assert.Equal("il", il.Language);
			var visualBasic = await manager.DecompileAsync(
				new DecompileRequest(opened.WorkspaceId, root.Id, DecompilerLanguage.VisualBasic),
				TestContext.Current.CancellationToken);
			Assert.StartsWith($"' {path}", visualBasic.Text, StringComparison.Ordinal);

			var pe = Assert.Single((await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, root.Id), TestContext.Current.CancellationToken)).Nodes, node => node.Kind == "pe");
			var headers = await manager.DecompileAsync(
				new DecompileRequest(opened.WorkspaceId, pe.Id, DecompilerLanguage.CSharp),
				TestContext.Current.CancellationToken);
			Assert.Contains("Machine:", headers.Text, StringComparison.Ordinal);
			Assert.Contains("(x86)", headers.Text, StringComparison.Ordinal);
			Assert.Contains("Windows Console", headers.Text, StringComparison.Ordinal);
			Assert.Contains(".text", headers.Text, StringComparison.Ordinal);
		}
		finally {
			File.Delete(path);
		}
	}

	/// <summary>
	/// The smallest thing dnlib accepts as a PE image: a DOS header, a PE32 optional header with no CLR
	/// data directory, and one .text section holding a <c>ret</c>. Nothing here is a managed assembly, which
	/// is the point — it is the native file the PE document exists for.
	/// </summary>
	static byte[] MinimalNativePeImage() {
		var data = new byte[0x400];
		void U16(int offset, ushort value) {
			data[offset] = (byte)value;
			data[offset + 1] = (byte)(value >> 8);
		}
		void U32(int offset, uint value) {
			for (var i = 0; i < 4; i++)
				data[offset + i] = (byte)(value >> (8 * i));
		}

		data[0] = (byte)'M';
		data[1] = (byte)'Z';
		U32(0x3C, 0x80);
		data[0x80] = (byte)'P';
		data[0x81] = (byte)'E';
		U16(0x84, 0x14C);           // Machine: I386
		U16(0x86, 1);               // NumberOfSections
		U32(0x88, 0x60000000);      // TimeDateStamp
		U16(0x94, 0xE0);            // SizeOfOptionalHeader
		U16(0x96, 0x0102);          // Characteristics: executable, 32-bit
		const int optional = 0x98;
		U16(optional, 0x10B);       // Magic: PE32
		U32(optional + 4, 0x200);   // SizeOfCode
		U32(optional + 16, 0x1000); // AddressOfEntryPoint
		U32(optional + 20, 0x1000); // BaseOfCode
		U32(optional + 28, 0x400000);   // ImageBase
		U32(optional + 32, 0x1000);     // SectionAlignment
		U32(optional + 36, 0x200);      // FileAlignment
		U16(optional + 40, 6);      // MajorOperatingSystemVersion
		U16(optional + 48, 6);      // MajorSubsystemVersion
		U32(optional + 56, 0x2000);     // SizeOfImage
		U32(optional + 60, 0x200);      // SizeOfHeaders
		U16(optional + 68, 3);      // Subsystem: Windows Console
		U32(optional + 72, 0x100000);   // SizeOfStackReserve
		U32(optional + 76, 0x1000);     // SizeOfStackCommit
		U32(optional + 80, 0x100000);   // SizeOfHeapReserve
		U32(optional + 84, 0x1000);     // SizeOfHeapCommit
		U32(optional + 92, 16);     // NumberOfRvaAndSizes — every directory stays zero, CLR included
		const int section = 0x178;
		foreach (var (index, value) in ".text\0\0\0"u8.ToArray().Index())
			data[section + index] = value;
		U32(section + 8, 0x100);        // VirtualSize
		U32(section + 12, 0x1000);      // VirtualAddress
		U32(section + 16, 0x200);       // SizeOfRawData
		U32(section + 20, 0x200);       // PointerToRawData
		U32(section + 36, 0x60000020);  // Characteristics: code, execute, read
		data[0x200] = 0xC3;
		return data;
	}

	[Fact]
	public async Task APeNodeListsTheStructuresOfTheImage() {
		var opened = await OpenContractsAssemblyAsync();
		var pe = await FindPeNodeAsync(opened.WorkspaceId);

		Assert.Equal("PE", pe.Label);
		Assert.Equal("BinaryFile", pe.Icon);
		Assert.True(pe.HasChildren);

		var structures = await ChildrenAsync(opened.WorkspaceId, pe.Id);
		// dnSpy's PENode.CreateChildren order: the two headers, the optional header, the sections, then the
		// CLR header and the metadata storage it points at.
		Assert.Equal("DOS Header", structures[0].Label);
		Assert.Equal("File Header", structures[1].Label);
		Assert.Matches(@"^Optional Header \((32|64)-bit\)$", structures[2].Label);
		Assert.StartsWith("Section #0: .", structures[3].Label, StringComparison.Ordinal);
		Assert.Contains(structures, node => node.Label == "Cor20 Header");
		Assert.Contains(structures, node => node.Label == "Storage Signature");
		Assert.Contains(structures, node => node.Label == "Storage Header");
		// One node per stream the metadata holds: the tables, the strings, the blobs, ...
		var streams = structures.Where(node => node.Label.StartsWith("Storage Stream #", StringComparison.Ordinal)).ToList();
		Assert.NotEmpty(streams);
		Assert.Contains(streams, node => node.Label.EndsWith(": #~", StringComparison.Ordinal));
		Assert.Contains(streams, node => node.Label.EndsWith(": #Strings", StringComparison.Ordinal));

		Assert.All(structures, node => Assert.Equal("pestructure", node.Kind));
		// Only the stream that holds the metadata tables expands, into dnSpy's Tables Stream node.
		Assert.All(structures, node => Assert.Equal(node.Label.EndsWith(": #~", StringComparison.Ordinal), node.HasChildren));
		// A structure belongs to the file it was read from, which is the tooltip dnSpy shows for them.
		Assert.All(structures, node => Assert.Equal(opened.Modules[0].Path, node.Description));
		Assert.All(structures, node => Assert.Equal("BinaryFile", node.Icon));
	}

	[Fact]
	public async Task APeStructureDocumentListsItsFields() {
		var opened = await OpenContractsAssemblyAsync();
		var pe = await FindPeNodeAsync(opened.WorkspaceId);
		var structures = await ChildrenAsync(opened.WorkspaceId, pe.Id);

		var dosHeader = await DocumentTextAsync(opened.WorkspaceId, Assert.Single(structures, node => node.Label == "DOS Header").Id);
		Assert.Contains("e_magic:", dosHeader, StringComparison.Ordinal);
		Assert.Contains("(MZ)", dosHeader, StringComparison.Ordinal);
		Assert.Contains("e_lfanew:", dosHeader, StringComparison.Ordinal);

		var fileHeader = await DocumentTextAsync(opened.WorkspaceId, Assert.Single(structures, node => node.Label == "File Header").Id);
		Assert.Contains("Machine:", fileHeader, StringComparison.Ordinal);
		Assert.Contains("NumberOfSections:", fileHeader, StringComparison.Ordinal);
		Assert.Contains("Characteristics:", fileHeader, StringComparison.Ordinal);

		// The optional header is where the CLR data directory — the thing that makes a file managed — is named.
		var optionalHeader = await DocumentTextAsync(
			opened.WorkspaceId,
			Assert.Single(structures, node => node.Label.StartsWith("Optional Header", StringComparison.Ordinal)).Id);
		Assert.Contains("ImageBase:", optionalHeader, StringComparison.Ordinal);
		Assert.Contains(".NET:", optionalHeader, StringComparison.Ordinal);
		Assert.Contains("DataDirectories:", optionalHeader, StringComparison.Ordinal);

		var section = await DocumentTextAsync(
			opened.WorkspaceId,
			Assert.Single(structures, node => node.Label.StartsWith("Section #0:", StringComparison.Ordinal)).Id);
		Assert.Contains("Name:", section, StringComparison.Ordinal);
		Assert.Contains("VirtualSize:", section, StringComparison.Ordinal);
		Assert.Contains("CNT_CODE", section, StringComparison.Ordinal);

		var cor20Header = await DocumentTextAsync(opened.WorkspaceId, Assert.Single(structures, node => node.Label == "Cor20 Header").Id);
		Assert.Contains("MetaData:", cor20Header, StringComparison.Ordinal);
		// A managed assembly built by the SDK is IL only.
		Assert.Contains("ILOnly", cor20Header, StringComparison.Ordinal);

		var storageSignature = await DocumentTextAsync(opened.WorkspaceId, Assert.Single(structures, node => node.Label == "Storage Signature").Id);
		Assert.Contains("BSJB", storageSignature, StringComparison.Ordinal);
		Assert.Contains("VersionString:", storageSignature, StringComparison.Ordinal);

		var storageStream = await DocumentTextAsync(
			opened.WorkspaceId,
			Assert.Single(structures, node => node.Label.EndsWith(": #~", StringComparison.Ordinal)).Id);
		Assert.Contains("Offset:", storageStream, StringComparison.Ordinal);
		Assert.Contains("Size:", storageStream, StringComparison.Ordinal);

		// A structure is a header of the image, not code, so the IL view names the node and says why it is
		// empty instead of failing or dumping IL that does not belong to it.
		var il = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, Assert.Single(structures, node => node.Label == "DOS Header").Id, DecompilerLanguage.ILWithCSharp),
			TestContext.Current.CancellationToken);
		Assert.Equal("// DOS Header", il.Text);
		Assert.Contains(il.Diagnostics, diagnostic => diagnostic.Message.Contains("no IL", StringComparison.Ordinal));
	}

	[Fact]
	public async Task ThePeNodeShowsEveryStructureInOneDocument() {
		var opened = await OpenContractsAssemblyAsync();
		var pe = await FindPeNodeAsync(opened.WorkspaceId);

		var text = await DocumentTextAsync(opened.WorkspaceId, pe.Id);

		Assert.Contains("DOS Header", text, StringComparison.Ordinal);
		Assert.Contains("Cor20 Header", text, StringComparison.Ordinal);
		Assert.Contains(": #~", text, StringComparison.Ordinal);
	}

	[Fact]
	public async Task ANativePeFileListsItsStructuresToo() {
		var path = Path.Combine(Path.GetTempPath(), $"dnspy-native-tree-{Guid.NewGuid():N}.exe");
		await File.WriteAllBytesAsync(path, MinimalNativePeImage(), TestContext.Current.CancellationToken);
		try {
			var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
			var root = Assert.Single(await ChildrenAsync(opened.WorkspaceId, Assert.Single(
				(await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Nodes).Id));
			Assert.Equal("pe", root.Kind);

			var structures = await ChildrenAsync(opened.WorkspaceId, root.Id);
			Assert.Equal("DOS Header", structures[0].Label);
			Assert.Contains(structures, node => node.Label == "Section #0: .text");
			// Nothing points at .NET metadata, so there is no CLR header to list and no heaps to walk.
			Assert.DoesNotContain(structures, node => node.Label == "Cor20 Header");
			Assert.DoesNotContain(structures, node => node.Label == "Storage Header");

			var section = await DocumentTextAsync(
				opened.WorkspaceId,
				Assert.Single(structures, node => node.Label == "Section #0: .text").Id);
			Assert.Contains("VirtualAddress:", section, StringComparison.Ordinal);
			Assert.Contains("0x60000020", section, StringComparison.Ordinal);
			Assert.Contains("CNT_CODE", section, StringComparison.Ordinal);
		}
		finally {
			File.Delete(path);
		}
	}

	/// <summary>
	/// The smallest ELF64 image that has all three tables: a header, a loadable segment and the stack marker
	/// as program headers, and four sections whose names live in a string table. It is what an ordinary Linux
	/// executable looks like to the reader, with a few bytes standing in for the section contents.
	/// </summary>
	static byte[] MinimalElf64Image() {
		var data = new byte[0x400];
		void U8(int offset, byte value) => data[offset] = value;
		void U16(int offset, ushort value) {
			data[offset] = (byte)value;
			data[offset + 1] = (byte)(value >> 8);
		}
		void U32(int offset, uint value) {
			for (var i = 0; i < 4; i++)
				data[offset + i] = (byte)(value >> (8 * i));
		}
		void U64(int offset, ulong value) {
			for (var i = 0; i < 8; i++)
				data[offset + i] = (byte)(value >> (8 * i));
		}

		data[0] = 0x7F;
		data[1] = (byte)'E';
		data[2] = (byte)'L';
		data[3] = (byte)'F';
		U8(4, 2);                   // ELFCLASS64
		U8(5, 1);                   // ELFDATA2LSB
		U8(6, 1);                   // EV_CURRENT
		U8(7, 0);                   // ELFOSABI_SYSV
		U16(0x10, 2);               // e_type: ET_EXEC
		U16(0x12, 62);              // e_machine: EM_X86_64
		U32(0x14, 1);               // e_version
		U64(0x18, 0x401000);        // e_entry
		U64(0x20, 64);              // e_phoff
		U64(0x28, 0x300);           // e_shoff
		U32(0x30, 0);               // e_flags
		U16(0x34, 64);              // e_ehsize
		U16(0x36, 56);              // e_phentsize
		U16(0x38, 2);               // e_phnum
		U16(0x3A, 64);              // e_shentsize
		U16(0x3C, 4);               // e_shnum
		U16(0x3E, 3);               // e_shstrndx

		const int program = 64;
		U32(program, 1);                // PT_LOAD
		U32(program + 4, 5);            // R | X
		U64(program + 16, 0x400000);    // p_vaddr
		U64(program + 24, 0x400000);    // p_paddr
		U64(program + 32, 0x200);       // p_filesz
		U64(program + 40, 0x200);       // p_memsz
		U64(program + 48, 0x1000);      // p_align
		const int stack = program + 56;
		U32(stack, 0x6474E551);         // PT_GNU_STACK
		U32(stack + 4, 6);              // R | W
		U64(stack + 48, 0x10);          // p_align

		"\0.text\0.data\0.shstrtab\0"u8.ToArray().CopyTo(data, 0x200);
		const int sections = 0x300;
		Section(0, 0, 0, 0, 0, 0);                      // section 0 has neither a name nor a type
		Section(1, 1, 0x6, 0x401000, 0x100, 4);         // .text: SHF_ALLOC | SHF_EXECINSTR
		Section(2, 7, 0x3, 0x402000, 0x104, 4);         // .data: SHF_WRITE | SHF_ALLOC
		Section(3, 13, 3, 0, 0x200, 23);                // .shstrtab: SHT_STRTAB

		void Section(int index, uint name, ulong flags, ulong address, ulong offset, ulong size) {
			var at = sections + index * 64;
			U32(at, name);
			U32(at + 4, index == 3 ? 3u : 1u);  // SHT_STRTAB for the name table, SHT_PROGBITS otherwise
			U64(at + 8, flags);
			U64(at + 16, address);
			U64(at + 24, offset);
			U64(at + 32, size);
		}

		data[0x100] = 0xC3;
		return data;
	}

	/// <summary>
	/// The same image in the 32-bit layout, where every field after e_ident sits at a different offset and the
	/// program header keeps its flags at the end.
	/// </summary>
	static byte[] MinimalElf32Image() {
		var data = new byte[0x300];
		void U16(int offset, ushort value) {
			data[offset] = (byte)value;
			data[offset + 1] = (byte)(value >> 8);
		}
		void U32(int offset, uint value) {
			for (var i = 0; i < 4; i++)
				data[offset + i] = (byte)(value >> (8 * i));
		}

		data[0] = 0x7F;
		data[1] = (byte)'E';
		data[2] = (byte)'L';
		data[3] = (byte)'F';
		data[4] = 1;                // ELFCLASS32
		data[5] = 1;                // ELFDATA2LSB
		data[6] = 1;                // EV_CURRENT
		U16(0x10, 2);               // ET_EXEC
		U16(0x12, 3);               // EM_386
		U32(0x14, 1);               // e_version
		U32(0x18, 0x8048000);       // e_entry
		U32(0x1C, 52);              // e_phoff
		U32(0x20, 0x200);           // e_shoff
		U16(0x28, 52);              // e_ehsize
		U16(0x2A, 32);              // e_phentsize
		U16(0x2C, 1);               // e_phnum
		U16(0x2E, 40);              // e_shentsize
		U16(0x30, 2);               // e_shnum
		U16(0x32, 1);               // e_shstrndx

		const int program = 52;
		U32(program, 1);            // PT_LOAD
		U32(program + 8, 0x8048000);    // p_vaddr
		U32(program + 16, 0x100);       // p_filesz
		U32(program + 20, 0x100);       // p_memsz
		U32(program + 24, 5);           // p_flags: R | X
		U32(program + 28, 0x1000);      // p_align

		"\0.shstrtab\0"u8.ToArray().CopyTo(data, 0x100);
		const int sections = 0x200;
		for (var index = 1; index <= 1; index++) {
			var at = sections + index * 40;
			U32(at, 1);             // sh_name: ".shstrtab", the only name in the table
			U32(at + 4, 3);         // SHT_STRTAB
			U32(at + 16, 0x100);    // sh_offset
			U32(at + 20, 11);       // sh_size
		}
		return data;
	}

	/// <summary>Writes a synthesized ELF image to a temp file and opens it; the caller deletes the file.</summary>
	async Task<(OpenWorkspaceResponse Opened, string Path)> OpenElfAsync(byte[] bytes) {
		var elfPath = Path.Combine(Path.GetTempPath(), $"dnspy-elf-{Guid.NewGuid():N}.elf");
		await File.WriteAllBytesAsync(elfPath, bytes, TestContext.Current.CancellationToken);
		try {
			return (await manager.OpenAsync(new OpenWorkspaceRequest([elfPath]), TestContext.Current.CancellationToken), elfPath);
		}
		catch {
			File.Delete(elfPath);
			throw;
		}
	}

	[Fact]
	public async Task AnElfFileGetsAnElfNodeWithItsHeaders() {
		var (opened, path) = await OpenElfAsync(MinimalElf64Image());
		try {
			var root = Assert.Single(
				(await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Nodes);
			Assert.Equal("elfdocument", root.Kind);
			Assert.Equal(Path.GetFileName(path), root.Label);
			Assert.Equal(path, root.Description);
			Assert.Equal("BinaryFile", root.Icon);
			Assert.True(root.HasChildren);

			var elf = Assert.Single(await ChildrenAsync(opened.WorkspaceId, root.Id));
			Assert.Equal("elf", elf.Kind);
			Assert.Equal("ELF", elf.Label);
			Assert.True(elf.HasChildren);

			// readelf's order: the file header, the program headers, then the section headers.
			var structures = await ChildrenAsync(opened.WorkspaceId, elf.Id);
			Assert.Equal("ELF Header", structures[0].Label);
			Assert.Equal("Program Header #0", structures[1].Label);
			Assert.Equal("Program Header #1", structures[2].Label);
			// Section 0 carries no name, which is how the file itself stores it.
			Assert.Equal("Section #0", structures[3].Label);
			Assert.Equal("Section #1: .text", structures[4].Label);
			Assert.Equal("Section #2: .data", structures[5].Label);
			Assert.Equal("Section #3: .shstrtab", structures[6].Label);

			Assert.All(structures, node => Assert.Equal("elfstructure", node.Kind));
			Assert.All(structures, node => Assert.False(node.HasChildren));
			Assert.All(structures, node => Assert.Equal(path, node.Description));
			Assert.All(structures, node => Assert.Equal("BinaryFile", node.Icon));

			// dnSpy saves a file it can only show as bytes the way its hex editor does, so writing it back in place
			// with no patches on it leaves the file as it was.
			var before = await File.ReadAllBytesAsync(path, TestContext.Current.CancellationToken);
			var save = await manager.SaveModuleInPlaceAsync(
				new SaveModuleInPlaceRequest(opened.WorkspaceId, root.Id),
				TestContext.Current.CancellationToken);
			Assert.Equal(path, save.Path);
			Assert.Equal(before, await File.ReadAllBytesAsync(path, TestContext.Current.CancellationToken));
		}
		finally {
			File.Delete(path);
		}
	}

	[Fact]
	public async Task ResolvingAHexTargetOnAnElfFileAnswersWithTheFileAndNoTarget() {
		var (opened, path) = await OpenElfAsync(MinimalElf64Image());
		try {
			var root = Assert.Single(
				(await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Nodes);
			var elf = Assert.Single(await ChildrenAsync(opened.WorkspaceId, root.Id));
			var length = new FileInfo(path).Length;

			// Selecting an ELF node asks the same question a managed module does. It answers with the file
			// and no member target rather than failing the query, so the commands that take a member have
			// nothing to point at and only the one that opens the file's bytes has — and the renderer never
			// has to swallow an error.
			foreach (var node in new[] { root, elf }) {
				var target = await manager.ResolveHexTargetAsync(
					new HexTargetRequest(opened.WorkspaceId, node.Id), TestContext.Current.CancellationToken);
				// Both the document and its structure name the file itself, as a managed member names its module.
				Assert.Equal(root.Id, target.ModuleId);
				Assert.Equal(length, target.FileLength);
				Assert.Null(target.Method);
				Assert.Null(target.FieldInitialValue);
				Assert.Null(target.Resource);
			}
		}
		finally {
			File.Delete(path);
		}
	}

	[Fact]
	public async Task AnElfStructureDocumentListsItsFields() {
		var (opened, path) = await OpenElfAsync(MinimalElf64Image());
		try {
			var root = Assert.Single(
				(await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Nodes);
			var elf = Assert.Single(await ChildrenAsync(opened.WorkspaceId, root.Id));
			var structures = await ChildrenAsync(opened.WorkspaceId, elf.Id);

			// The document the file itself opens as lists every structure, like the PE document does.
			var whole = await DocumentTextAsync(opened.WorkspaceId, root.Id);
			Assert.Contains($"// ELF File: {Path.GetFileName(path)}", whole, StringComparison.Ordinal);
			Assert.Contains("ELF Header", whole, StringComparison.Ordinal);
			Assert.Contains("Section #1: .text", whole, StringComparison.Ordinal);

			var header = await DocumentTextAsync(opened.WorkspaceId, Assert.Single(structures, node => node.Label == "ELF Header").Id);
			Assert.Contains("Class:", header, StringComparison.Ordinal);
			Assert.Contains("64-bit (ELFCLASS64)", header, StringComparison.Ordinal);
			Assert.Contains("Little endian (ELFDATA2LSB)", header, StringComparison.Ordinal);
			Assert.Contains("System V (ELFOSABI_SYSV)", header, StringComparison.Ordinal);
			Assert.Contains("Executable file (ET_EXEC)", header, StringComparison.Ordinal);
			Assert.Contains("x86-64 (EM_X86_64)", header, StringComparison.Ordinal);
			Assert.Contains("EntryPointAddress:", header, StringComparison.Ordinal);
			Assert.Contains("0x0000000000401000", header, StringComparison.Ordinal);
			Assert.Contains("NumberOfSectionHeaders:", header, StringComparison.Ordinal);

			var segment = await DocumentTextAsync(opened.WorkspaceId, Assert.Single(structures, node => node.Label == "Program Header #0").Id);
			Assert.Contains("Loadable segment (PT_LOAD)", segment, StringComparison.Ordinal);
			// The flags of a loadable segment read as a permission string, the way readelf prints them.
			Assert.Contains("(RX)", segment, StringComparison.Ordinal);
			Assert.Contains("VirtualAddress:", segment, StringComparison.Ordinal);

			var section = await DocumentTextAsync(opened.WorkspaceId, Assert.Single(structures, node => node.Label == "Section #1: .text").Id);
			Assert.Contains("Name:", section, StringComparison.Ordinal);
			Assert.Contains(".text", section, StringComparison.Ordinal);
			Assert.Contains("Program data (SHT_PROGBITS)", section, StringComparison.Ordinal);
			Assert.Contains("Occupies memory (SHF_ALLOC)", section, StringComparison.Ordinal);
			Assert.Contains("Executable (SHF_EXECINSTR)", section, StringComparison.Ordinal);

			// An ELF structure is a header, not code: the IL view names the node and says so.
			var il = await manager.DecompileAsync(
				new DecompileRequest(opened.WorkspaceId, Assert.Single(structures, node => node.Label == "ELF Header").Id, DecompilerLanguage.ILWithCSharp),
				TestContext.Current.CancellationToken);
			Assert.Equal("// ELF Header", il.Text);
			Assert.Contains(il.Diagnostics, diagnostic => diagnostic.Message.Contains("no IL", StringComparison.Ordinal));
		}
		finally {
			File.Delete(path);
		}
	}

	[Fact]
	public async Task A32BitElfImageReportsItsOwnLayout() {
		var (opened, path) = await OpenElfAsync(MinimalElf32Image());
		try {
			var root = Assert.Single(
				(await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Nodes);
			Assert.Equal("elfdocument", root.Kind);
			var elf = Assert.Single(await ChildrenAsync(opened.WorkspaceId, root.Id));
			var structures = await ChildrenAsync(opened.WorkspaceId, elf.Id);
			Assert.Equal("Program Header #0", structures[1].Label);
			Assert.Equal("Section #0", structures[2].Label);
			Assert.Equal("Section #1: .shstrtab", structures[3].Label);

			var header = await DocumentTextAsync(opened.WorkspaceId, structures[0].Id);
			Assert.Contains("32-bit (ELFCLASS32)", header, StringComparison.Ordinal);
			Assert.Contains("Intel 80386 (EM_386)", header, StringComparison.Ordinal);
			// A 32-bit image prints its addresses as eight digits, not sixteen.
			Assert.Contains("0x08048000", header, StringComparison.Ordinal);
			Assert.DoesNotContain("0x0000000008048000", header, StringComparison.Ordinal);

			var segment = await DocumentTextAsync(opened.WorkspaceId, structures[1].Id);
			Assert.Contains("Loadable segment (PT_LOAD)", segment, StringComparison.Ordinal);
			Assert.Contains("(RX)", segment, StringComparison.Ordinal);
		}
		finally {
			File.Delete(path);
		}
	}

	[Fact]
	public async Task AFileThatOnlyLooksLikeAnElfStaysAnUnknownDocument() {
		// The magic bytes and nothing behind them: some other format, or a damaged file, rather than an ELF.
		var (opened, path) = await OpenElfAsync([0x7F, 0x45, 0x4C, 0x46, 2, 1, 1, 0]);
		try {
			var root = Assert.Single(
				(await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Nodes);
			Assert.Equal("unknowndocument", root.Kind);
			Assert.False(root.HasChildren);
			// NodeDecompiler.Decompile(UnknownDocumentNode) writes the file's full path.
			Assert.Equal(
				$"// {path}",
				(await DocumentTextAsync(opened.WorkspaceId, root.Id)).TrimEnd());
		}
		finally {
			File.Delete(path);
		}
	}

	[Fact]
	public async Task AddModules_RejectsWhatTheOpenCommandWouldReject() {
		var opened = await OpenContractsAssemblyAsync();
		var missing = Path.Combine(Path.GetDirectoryName(opened.Modules[0].Path)!, "Missing.dll");

		// A path that is not there is still a rejection: dnSpy's Open command is handed paths that exist,
		// and ExpandPaths is what says so.
		var notFound = await Assert.ThrowsAsync<RpcException>(() => manager.AddModulesAsync(
			new AddModulesRequest(opened.WorkspaceId, [missing]),
			TestContext.Current.CancellationToken));
		Assert.Equal(ErrorCodes.FileNotFound, notFound.Code);

		// A file that is there but unreadable is not: it joins the tree as an unknown document, which is
		// what the Open command does with it too.
		var junkPath = Path.Combine(Path.GetTempPath(), $"dnspy-not-an-assembly-{Guid.NewGuid():N}.dll");
		await File.WriteAllTextAsync(junkPath, "not a managed assembly", TestContext.Current.CancellationToken);
		try {
			var added = await manager.AddModulesAsync(
				new AddModulesRequest(opened.WorkspaceId, [junkPath]),
				TestContext.Current.CancellationToken);
			Assert.Empty(added.Skipped);
			Assert.Equal(2, added.Modules.Count);
			Assert.Contains(added.Modules, module => module.Path == junkPath && module.Name == Path.GetFileName(junkPath));
		}
		finally {
			File.Delete(junkPath);
		}
	}

	/// <summary>
	/// Save, as opposed to Save As: no destination is named, so the module goes back over the file the
	/// workspace read it from and that file is what a later open sees.
	/// </summary>
	[Fact]
	public async Task SavingInPlaceWritesBackOverTheFileTheWorkspaceWasOpenedFrom() {
		var directory = CopyFixtureAssemblies();
		try {
			var path = Path.Combine(directory, "dnSpy.Backend.Contracts.dll");
			var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
			var moduleId = Assert.Single(opened.Modules).Id;
			var method = await FindRpcExceptionGetterAsync(opened.WorkspaceId);
			var target = await manager.ResolveHexTargetAsync(new HexTargetRequest(opened.WorkspaceId, method.Id), TestContext.Current.CancellationToken);
			var body = Assert.IsType<HexMethodTargetDto>(target.Method);
			await CommitHexPatchAsync(opened.WorkspaceId, method.Id, body.BodyOffset, [0x0A, 0x17, 0x2A]);

			var saved = await manager.SaveModuleInPlaceAsync(new SaveModuleInPlaceRequest(opened.WorkspaceId, moduleId), TestContext.Current.CancellationToken);
			Assert.Equal(path, saved.Path);
			Assert.True(saved.Length > 512);

			// Read back through the same path: the file on disk is the one that carries the edit.
			var reopened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
			var savedMethod = await FindRpcExceptionGetterAsync(reopened.WorkspaceId);
			var savedTarget = await manager.ResolveHexTargetAsync(new HexTargetRequest(reopened.WorkspaceId, savedMethod.Id), TestContext.Current.CancellationToken);
			var savedBody = Assert.IsType<HexMethodTargetDto>(savedTarget.Method);
			var bytes = Convert.FromBase64String((await manager.ReadHexAsync(
				new HexReadRequest(reopened.WorkspaceId, savedTarget.ModuleId, savedBody.BodyOffset, 3),
				TestContext.Current.CancellationToken)).Base64Data);
			Assert.Equal(new byte[] { 0x0A, 0x17, 0x2A }, bytes);
		}
		finally {
			Directory.Delete(directory, recursive: true);
		}
	}

	/// <summary>
	/// Save All walks the modules rather than the tree, and writes only the ones that carry edits: an
	/// untouched assembly is left exactly as it was on disk.
	/// </summary>
	[Fact]
	public async Task SaveAllWritesOnlyTheModulesWithUnsavedEdits() {
		var directory = CopyFixtureAssemblies();
		try {
			var editedPath = Path.Combine(directory, "dnSpy.Backend.Contracts.dll");
			var untouchedPath = Path.Combine(directory, "dnSpy.Backend.Tests.dll");
			var before = await File.ReadAllBytesAsync(untouchedPath, TestContext.Current.CancellationToken);
			var opened = await manager.OpenAsync(new OpenWorkspaceRequest([editedPath, untouchedPath]), TestContext.Current.CancellationToken);
			Assert.Empty((await manager.SaveAllModulesAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Saved);

			// The tree holds two modules, so the type is looked up under the one it belongs to.
			var helloRequest = await FindTypeInModuleAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", "dnSpy.Backend.Contracts", "HelloRequest");
			var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
			await manager.QueueRenameAsync(
				new RenameEditRequest(opened.WorkspaceId, transaction.TransactionId, helloRequest.Id, "HelloRequestRenamed"),
				TestContext.Current.CancellationToken);
			await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

			var saved = await manager.SaveAllModulesAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
			Assert.Equal(editedPath, Assert.Single(saved.Saved).Path);
			Assert.Equal(before, await File.ReadAllBytesAsync(untouchedPath, TestContext.Current.CancellationToken));

			// Saving clears the flag the walk selects on, so a second Save All has nothing left to write.
			Assert.Empty((await manager.SaveAllModulesAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Saved);
		}
		finally {
			Directory.Delete(directory, recursive: true);
		}
	}

	/// <summary>
	/// Reload All Assemblies is not Close followed by Open: the workspace object survives, so the id the
	/// client holds still resolves — but everything built on the old modules is gone with them.
	/// </summary>
	[Fact]
	public async Task ReloadAllRebuildsTheTreeUnderTheSameWorkspaceId() {
		var opened = await OpenContractsAssemblyAsync();
		var helloRequest = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", "HelloRequest");
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.QueueRenameAsync(
			new RenameEditRequest(opened.WorkspaceId, transaction.TransactionId, helloRequest.Id, "HelloRequestRenamed"),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var reloaded = await manager.ReloadAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);

		Assert.Equal(opened.WorkspaceId, reloaded.WorkspaceId);
		Assert.Equal(opened.Modules.Select(module => module.Path), reloaded.Modules.Select(module => module.Path));
		// The file was never written, so the rename dies with the modules it was made on. The node is a
		// different node — its id was issued again — but it is the same type, which is what the stable
		// key says and what lets the client recognise what it is looking at.
		var restored = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", "HelloRequest");
		Assert.Equal(helloRequest.Key, restored.Key);
		Assert.NotEqual(helloRequest.Id, restored.Id);
		Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Nodes);
		// The id the client cached before the reload names nothing now.
		await Assert.ThrowsAnyAsync<RpcException>(() => manager.GetNodeAsync(
			new NodeRequest(opened.WorkspaceId, helloRequest.Id), TestContext.Current.CancellationToken));
	}

	/// <summary>Sort Assemblies reorders the roots the workspace already has; it loads and drops nothing.</summary>
	[Fact]
	public async Task SortAssembliesOrdersTheRootsByDisplayName() {
		var directory = CopyFixtureAssemblies();
		try {
			// A workspace opens its files in path order, and the tree shows assembly names instead, so the
			// file names decide which order the tree is in before anything is sorted. These two are named to
			// put dnSpy.Backend.Tests first, which is the order the sort has to undo.
			var testsPath = Path.Combine(directory, "a-Debug.dll");
			var contractsPath = Path.Combine(directory, "z-Release.dll");
			File.Move(Path.Combine(directory, "dnSpy.Backend.Tests.dll"), testsPath);
			File.Move(Path.Combine(directory, "dnSpy.Backend.Contracts.dll"), contractsPath);
			var opened = await manager.OpenAsync(new OpenWorkspaceRequest([contractsPath, testsPath]), TestContext.Current.CancellationToken);
			var request = new WorkspaceRequest(opened.WorkspaceId);

			var before = (await manager.GetRootsAsync(request, TestContext.Current.CancellationToken)).Nodes;
			Assert.Equal(["dnSpy.Backend.Tests", "dnSpy.Backend.Contracts"], before.Select(AssemblyName));

			var sorted = await manager.SortAssembliesAsync(request, TestContext.Current.CancellationToken);
			Assert.Equal(["dnSpy.Backend.Contracts", "dnSpy.Backend.Tests"], sorted.Nodes.Select(AssemblyName));
			// Sorting is a view order, not a reopen: the nodes keep the ids the client already has, and the
			// order the sort produced is the one later reads of the tree see.
			Assert.Equal(before.Select(node => node.Id).OrderBy(id => id), sorted.Nodes.Select(node => node.Id).OrderBy(id => id));
			Assert.Equal(sorted.Nodes.Select(AssemblyName), (await manager.GetRootsAsync(request, TestContext.Current.CancellationToken)).Nodes.Select(AssemblyName));
			// The root list and the module list are the same order, which is what the client's explorer and
			// its per-module commands both walk.
			Assert.Equal(sorted.Nodes.Select(AssemblyName), opened.Modules
				.Select(module => module.Name)
				.OrderBy(name => name, StringComparer.OrdinalIgnoreCase));

			static string AssemblyName(TreeNodeDto node) {
				var versionStart = node.Label.IndexOf(" (", StringComparison.Ordinal);
				return versionStart < 0 ? node.Label : node.Label[..versionStart];
			}
		}
		finally {
			Directory.Delete(directory, recursive: true);
		}
	}

	/// <summary>
	/// A node id is a counter value issued in the order nodes are materialised, so it cannot be stored
	/// across sessions; the key that travels with it can. This is the regression test for that property:
	/// a key that quietly picked up a node id — as the resource keys once did — would fail here.
	/// </summary>
	[Fact]
	public async Task NodeKeys_AreStableAcrossReopeningTheSameFiles() {
		var before = await CollectKeysAsync();
		var after = await CollectKeysAsync();
		Assert.Equal(before, after);

		async Task<string[]> CollectKeysAsync() {
			var target = Path.GetFullPath(Path.Combine(
				AppContext.BaseDirectory,
				"..", "..", "..", "..", "BamlTarget", "bin", TestConfiguration, "net10.0-windows", "BamlTarget.dll"));
			Assert.True(File.Exists(target), $"BAML fixture was not built: {target}");
			var opened = await manager.OpenAsync(new OpenWorkspaceRequest([typeof(HelloRequest).Assembly.Location, target]), TestContext.Current.CancellationToken);
			try {
				var keys = new List<string>();
				var roots = await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
				foreach (var root in roots.Nodes)
					await CollectKeysAsync(root.Id);
				// A resource node is what the key stability of the resources tree turns on, and the fixture
				// has one; without it this test could pass while the resource keys still embedded an id.
				Assert.Contains(keys, key => key.StartsWith("resource:", StringComparison.Ordinal));
				return [.. keys];

				async Task CollectKeysAsync(string nodeId) {
					var node = await manager.GetNodeAsync(new NodeRequest(opened.WorkspaceId, nodeId), TestContext.Current.CancellationToken);
					keys.Add(node.Key!);
					if (!node.HasChildren)
						return;
					foreach (var child in await ChildrenAsync(opened.WorkspaceId, node.Id))
						await CollectKeysAsync(child.Id);
				}
			}
			finally {
				manager.Close(new WorkspaceRequest(opened.WorkspaceId));
			}
		}
	}

	/// <summary>
	/// The chain an explorer needs to put a node on screen. A client cannot build it itself: a member's
	/// node id names its module and token, not the type that declares it. The chain is built through the
	/// same keys the tree uses, which is what makes the ids on it the ids the tree already handed out.
	/// </summary>
	[Fact]
	public async Task NodePath_LeadsFromTheRootToTheNodeItself() {
		var opened = await OpenContractsAssemblyAsync();
		var assembly = Assert.Single(
			(await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Nodes);
		var module = Assert.Single(await ChildrenAsync(opened.WorkspaceId, assembly.Id));
		// The global <Module> type puts an empty namespace beside the named one, the way dnSpy lists it.
		var @namespace = Assert.Single(await ChildrenAsync(opened.WorkspaceId, module.Id), node => node.Kind == "namespace" && node.Label == "dnSpy.Backend.Contracts");
		var rpcException = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", "RpcException");
		var members = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, rpcException.Id), TestContext.Current.CancellationToken);
		var codeProperty = Assert.Single(members.Nodes, node => node.Kind == "property" && node.Label == "Code");
		var getCode = await FindAccessorAsync(opened.WorkspaceId, members.Nodes, "Code", "get_Code()");

		var path = await manager.GetNodePathAsync(
			new NodeRequest(opened.WorkspaceId, getCode.Id),
			TestContext.Current.CancellationToken);

		// The chain runs through the property the getter belongs to, since that is the row a client has to
		// open before the method's own row exists.
		Assert.Equal(new[] { "assembly", "module", "namespace", "type", "property", "method" }, path.Nodes.Select(node => node.Kind));
		Assert.Equal(new[] { assembly.Id, module.Id, @namespace.Id, rpcException.Id, codeProperty.Id, getCode.Id }, path.Nodes.Select(node => node.Id));
	}

	/// <summary>
	/// A property's accessors are the property's rows, not the type's: dnSpy shows get and set under the
	/// property they belong to, so the type lists one row for a property rather than one per accessor.
	/// </summary>
	[Fact]
	public async Task AccessorsAreListedUnderTheMemberThatDeclaresThem() {
		var opened = await OpenContractsAssemblyAsync();
		var rpcException = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", "RpcException");
		var members = await ChildrenAsync(opened.WorkspaceId, rpcException.Id);

		Assert.DoesNotContain(members, node => node.Label.StartsWith("get_Code", StringComparison.Ordinal));
		Assert.DoesNotContain(members, node => node.Label.StartsWith("get_DataValue", StringComparison.Ordinal));

		var code = Assert.Single(members, node => node.Kind == "property" && node.Label == "Code");
		Assert.True(code.HasChildren);

		var getter = Assert.Single(await ChildrenAsync(opened.WorkspaceId, code.Id), node => node.Label == "get_Code()");
		Assert.Equal("method", getter.Kind);
		Assert.Equal("int", getter.ReturnType);
	}

	/// <summary>
	/// An event's accessors are nested the same way. dnSpy's EventNodeImpl yields the adder, the remover and
	/// the raiser, but they share one MethodTreeNodeGroup, which sorts them by name — add_, raise_, remove_.
	/// No fixture assembly declares an event, so this one writes its own.
	/// </summary>
	[Fact]
	public async Task EventAccessorsAreListedUnderTheEvent() {
		var path = WriteModuleWithEvent();
		try {
			var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
			var type = await FindTypeAsync(opened.WorkspaceId, "Fixture", "Holder");
			var members = await ChildrenAsync(opened.WorkspaceId, type.Id);

			Assert.DoesNotContain(members, node => node.Label.StartsWith("add_Changed", StringComparison.Ordinal));
			Assert.DoesNotContain(members, node => node.Label.StartsWith("remove_Changed", StringComparison.Ordinal));
			Assert.DoesNotContain(members, node => node.Label.StartsWith("raise_Changed", StringComparison.Ordinal));

			var changed = Assert.Single(members, node => node.Kind == "event" && node.Label == "Changed");
			Assert.True(changed.HasChildren);
			Assert.Equal(
				new[] { "add_Changed(EventHandler)", "raise_Changed(EventHandler)", "remove_Changed(EventHandler)" },
				(await ChildrenAsync(opened.WorkspaceId, changed.Id)).Select(node => node.Label));
		}
		finally {
			File.Delete(path);
		}
	}

	/// <summary>
	/// A module holding one event and the three accessor methods it names.
	/// </summary>
	static string WriteModuleWithEvent() {
		var module = new ModuleDefUser("EventFixture.dll");
		var handler = new ClassSig(new TypeRefUser(module, "System", "EventHandler", new AssemblyRefUser("System.Runtime")));
		var signature = MethodSig.CreateInstance(handler, handler);
		var type = new TypeDefUser("Fixture", "Holder");
		module.Types.Add(type);

		var add = module.UpdateRowId(new MethodDefUser("add_Changed", signature));
		var remove = module.UpdateRowId(new MethodDefUser("remove_Changed", signature));
		var raise = module.UpdateRowId(new MethodDefUser("raise_Changed", signature));
		foreach (var method in new[] { add, remove, raise })
			type.Methods.Add(method);

		var @event = module.UpdateRowId(new EventDefUser("Changed", handler.ToTypeDefOrRef()) {
			AddMethod = add,
			RemoveMethod = remove,
			InvokeMethod = raise,
		});
		type.Events.Add(@event);

		var path = Path.Combine(Path.GetTempPath(), $"dnspy-event-{Guid.NewGuid():N}.dll");
		module.Write(path);
		return path;
	}

	/// <summary>
	/// The case the chain exists for: a node reached by its identity alone, whose ancestors nobody has
	/// listed yet. Asking for the path is what lets a client walk down to it afterwards.
	/// </summary>
	[Fact]
	public async Task NodePath_ReachesANodeNobodyHasListed() {
		var opened = await OpenContractsAssemblyAsync();
		// The type's own node, asked for by the identity a bookmark or a followed reference carries — the
		// namespace above it, and everything above that, has never been listed.
		var found = await manager.FindMemberAsync(
			new FindMemberRequest(opened.WorkspaceId, typeof(HelloRequest).Assembly.Location, unchecked((int)typeof(HelloRequest).MetadataToken)),
			TestContext.Current.CancellationToken);
		Assert.NotNull(found.NodeId);

		var path = await manager.GetNodePathAsync(
			new NodeRequest(opened.WorkspaceId, found.NodeId!),
			TestContext.Current.CancellationToken);

		Assert.Equal(new[] { "assembly", "module", "namespace", "type" }, path.Nodes.Select(node => node.Kind));
		Assert.Equal(found.NodeId, path.Nodes[^1].Id);
		Assert.Contains(await ChildrenAsync(opened.WorkspaceId, path.Nodes[2].Id), node => node.Label == nameof(HelloRequest));
	}

	/// <summary>A nested type is listed under the type that declares it, so the chain names that type first.</summary>
	[Fact]
	public async Task NodePath_NamesTheDeclaringTypesOfANestedType() {
		var opened = await manager.OpenAsync(
			new OpenWorkspaceRequest([typeof(WorkspaceManagerTests).Assembly.Location]),
			TestContext.Current.CancellationToken);
		var outer = await FindTypeAsync(opened.WorkspaceId, "dnSpy.Backend.Tests", nameof(BreakpointExpressionTests));
		var nested = Assert.Single(await ChildrenAsync(opened.WorkspaceId, outer.Id), node => node.Label == "Scope");

		var path = await manager.GetNodePathAsync(
			new NodeRequest(opened.WorkspaceId, nested.Id),
			TestContext.Current.CancellationToken);

		Assert.Equal(new[] { "assembly", "module", "namespace", "type", "type" }, path.Nodes.Select(node => node.Kind));
		Assert.Equal(outer.Id, path.Nodes[3].Id);
		Assert.Equal(nested.Id, path.Nodes[4].Id);
	}

	[Fact]
	public async Task NodePath_OfARootIsTheRootItself() {
		var opened = await OpenContractsAssemblyAsync();
		var assembly = Assert.Single(
			(await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Nodes);

		var path = await manager.GetNodePathAsync(new NodeRequest(opened.WorkspaceId, assembly.Id), TestContext.Current.CancellationToken);

		var only = Assert.Single(path.Nodes);
		Assert.Equal(assembly.Id, only.Id);
	}

	/// <summary>
	/// A structure read out of the image, or a resource, has no path from a root that names it — the PE
	/// node above it does, and the difference is the point: the client is told "no" and keeps its own tree
	/// rather than being handed a chain that leads nowhere.
	/// </summary>
	[Fact]
	public async Task NodePath_StopsAtTheKindsWithNoChain() {
		var opened = await OpenContractsAssemblyAsync();
		var pe = await FindPeNodeAsync(opened.WorkspaceId);
		var pePath = await manager.GetNodePathAsync(new NodeRequest(opened.WorkspaceId, pe.Id), TestContext.Current.CancellationToken);
		Assert.Equal(new[] { "assembly", "module", "pe" }, pePath.Nodes.Select(node => node.Kind));

		var structure = (await ChildrenAsync(opened.WorkspaceId, pe.Id))[0];
		var structurePath = await manager.GetNodePathAsync(new NodeRequest(opened.WorkspaceId, structure.Id), TestContext.Current.CancellationToken);
		Assert.Empty(structurePath.Nodes);
	}

	/// <summary>
	/// A reference into a module the workspace does not hold opens that module on demand, so the tree gains
	/// a root it never had — and the node the reference named was created without the tree listing one node
	/// of that module. The chain still has to name its way down from that new root.
	/// </summary>
	[Fact]
	public async Task NodePath_ReachesAModuleOpenedOnDemand() {
		var opened = await OpenContractsAssemblyAsync();
		var found = await manager.FindMemberAsync(
			new FindMemberRequest(opened.WorkspaceId, typeof(object).Assembly.Location, unchecked((int)typeof(Exception).MetadataToken)),
			TestContext.Current.CancellationToken);
		Assert.NotNull(found.NodeId);

		var path = await manager.GetNodePathAsync(
			new NodeRequest(opened.WorkspaceId, found.NodeId!),
			TestContext.Current.CancellationToken);

		Assert.Equal(new[] { "assembly", "module", "namespace", "type" }, path.Nodes.Select(node => node.Kind));
		Assert.Equal(found.NodeId, path.Nodes[^1].Id);
		var roots = (await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Nodes;
		Assert.Contains(path.Nodes[0].Id, roots.Select(node => node.Id));
	}

	[Fact]
	public async Task NodePath_RefusesANodeThatIsNotThere() {		var opened = await OpenContractsAssemblyAsync();

		var exception = await Assert.ThrowsAsync<RpcException>(() => manager.GetNodePathAsync(
			new NodeRequest(opened.WorkspaceId, "n999999"),
			TestContext.Current.CancellationToken));

		Assert.Equal(ErrorCodes.NodeNotFound, exception.Code);
	}

	/// <summary>Opens the debuggee and decompiles one of its method nodes, for the state machine tests.</summary>
	async Task<(string Path, OpenWorkspaceResponse Opened, TreeNodeDto Node, DecompileResponse Document)> OpenMethodDocumentAsync(string memberLabel) {
		var path = Path.Combine(AppContext.BaseDirectory, "DebugTarget.dll");
		Assert.True(File.Exists(path), $"The debuggee was not copied to the test output: {path}");
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
		var program = await FindTypeAsync(opened.WorkspaceId, "DebugTarget", "Program");
		var members = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, program.Id), TestContext.Current.CancellationToken);
		var node = Assert.Single(members.Nodes, member => member.Label.StartsWith(memberLabel, StringComparison.Ordinal));
		var document = await manager.DecompileAsync(new DecompileRequest(opened.WorkspaceId, node.Id, DecompilerLanguage.CSharp), TestContext.Current.CancellationToken);
		return (path, opened, node, document);
	}

	async Task<TreeNodeDto> FindModuleAsync(string workspaceId) {
		var root = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).Nodes);
		return root.Kind == "assembly"
			? Assert.Single(await ChildrenAsync(workspaceId, root.Id), node => node.Kind == "module")
			: root;
	}

	async Task<TreeNodeDto> FindNamespaceAsync(string workspaceId, string namespaceName) {
		var root = await FindModuleAsync(workspaceId);
		var rootChildren = await manager.GetChildrenAsync(new NodeRequest(workspaceId, root.Id), TestContext.Current.CancellationToken);
		return Assert.Single(rootChildren.Nodes, node => node.Label == namespaceName);
	}

	async Task<TreeNodeDto> FindTypeAsync(string workspaceId, string namespaceName, string typeName) {
		var @namespace = await FindNamespaceAsync(workspaceId, namespaceName);
		var types = await manager.GetChildrenAsync(new NodeRequest(workspaceId, @namespace.Id), TestContext.Current.CancellationToken);
		return Assert.Single(types.Nodes, node => node.Label == typeName);
	}

	/// <summary>A type node under a named module, for the tests whose workspace holds more than one.</summary>
	async Task<TreeNodeDto> FindTypeInModuleAsync(string workspaceId, string moduleLabel, string namespaceName, string typeName) {
		var root = Assert.Single(
			(await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).Nodes,
			node => node.Label == moduleLabel || node.Label.StartsWith(moduleLabel + " (", StringComparison.Ordinal));
		var module = root.Kind == "assembly"
			? Assert.Single(await ChildrenAsync(workspaceId, root.Id), node => node.Kind == "module")
			: root;
		var rootChildren = await manager.GetChildrenAsync(new NodeRequest(workspaceId, module.Id), TestContext.Current.CancellationToken);
		var @namespace = Assert.Single(rootChildren.Nodes, node => node.Label == namespaceName);
		var types = await manager.GetChildrenAsync(new NodeRequest(workspaceId, @namespace.Id), TestContext.Current.CancellationToken);
		return Assert.Single(types.Nodes, node => node.Label == typeName);
	}

	/// <summary>
	/// An accessor row, which dnSpy files under the property that declares it rather than beside it: the
	/// type's own children hold the property node, and the getter or setter is a child of that.
	/// </summary>
	async Task<TreeNodeDto> FindAccessorAsync(string workspaceId, IReadOnlyList<TreeNodeDto> typeChildren, string propertyLabel, string accessorLabel) {
		var property = Assert.Single(typeChildren, node => node.Kind == "property" && node.Label == propertyLabel);
		return Assert.Single(await ChildrenAsync(workspaceId, property.Id), node => node.Label == accessorLabel);
	}

	/// <summary>The one-liner getter the hex write commands are pointed at: <c>RpcException.get_Code()</c>.</summary>
	async Task<TreeNodeDto> FindRpcExceptionGetterAsync(string workspaceId) {
		var type = await FindTypeAsync(workspaceId, "dnSpy.Backend.Contracts", "RpcException");
		var members = await manager.GetChildrenAsync(new NodeRequest(workspaceId, type.Id), TestContext.Current.CancellationToken);
		return await FindAccessorAsync(workspaceId, members.Nodes, "Code", "get_Code()");
	}

	/// <summary>Writes one byte patch the way the hex commands do: in its own transaction, then committed.</summary>
	async Task<EditCommitResponse> CommitHexPatchAsync(string workspaceId, string nodeId, long offset, byte[] data) {
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), TestContext.Current.CancellationToken);
		await manager.QueueHexPatchAsync(
			new HexPatchRequest(workspaceId, transaction.TransactionId, nodeId, offset, Convert.ToBase64String(data)),
			TestContext.Current.CancellationToken);
		return await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);
	}

	async Task<OpenWorkspaceResponse> OpenContractsAssemblyAsync() => await manager.OpenAsync(
		new OpenWorkspaceRequest([typeof(HelloRequest).Assembly.Location]),
		TestContext.Current.CancellationToken);

	async Task<IReadOnlyList<TreeNodeDto>> ChildrenAsync(string workspaceId, string nodeId) =>
		(await manager.GetChildrenAsync(new NodeRequest(workspaceId, nodeId), TestContext.Current.CancellationToken)).Nodes;

	async Task<string> DocumentTextAsync(string workspaceId, string nodeId) =>
		(await manager.DecompileAsync(
			new DecompileRequest(workspaceId, nodeId, DecompilerLanguage.CSharp),
			TestContext.Current.CancellationToken)).Text;

	/// <summary>
	/// The PE node of an opened assembly. An assembly node sits at the root with the module under it and the
	/// PE node under that, so a caller walks that far down to reach the structures of the image.
	/// </summary>
	async Task<TreeNodeDto> FindPeNodeAsync(string workspaceId) {
		var assembly = Assert.Single(
			(await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).Nodes);
		var module = Assert.Single(await ChildrenAsync(workspaceId, assembly.Id));
		return Assert.Single(await ChildrenAsync(workspaceId, module.Id), node => node.Kind == "pe");
	}

	/// <summary>
	/// A throwaway copy of the test output, for the saves that write back over the file they read: the
	/// assemblies the rest of the suite opens must not be edited out from under it. Everything the test
	/// output holds is copied, so references resolve the same way in there as they do at home.
	/// </summary>
	string CopyFixtureAssemblies() {
		var directory = Path.Combine(Path.GetTempPath(), $"dnspy-save-{Guid.NewGuid():N}");
		Directory.CreateDirectory(directory);
		foreach (var file in Directory.EnumerateFiles(AppContext.BaseDirectory, "*.dll"))
			File.Copy(file, Path.Combine(directory, Path.GetFileName(file)), overwrite: true);
		return directory;
	}

	public void Dispose() => manager.Dispose();

	static string TestConfiguration => new DirectoryInfo(AppContext.BaseDirectory).Parent?.Name
		?? throw new InvalidOperationException("Could not determine the test configuration.");
}
