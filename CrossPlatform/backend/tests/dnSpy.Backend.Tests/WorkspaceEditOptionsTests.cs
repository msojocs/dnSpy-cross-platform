using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The reading half of the edit feature: what the tree shows under an assembly reference, and the values
/// a create- or edit-dialog opens with. Both are read-only, so neither needs a transaction.
/// </summary>
public sealed class WorkspaceEditOptionsTests : IDisposable {
	readonly WorkspaceManager manager = new();

	/// <summary>
	/// dnSpy's AssemblyReferenceNodeImpl resolves the assembly a reference names and lists that assembly's own
	/// references — not its types: the assembly itself goes into the tree as a document the workspace loaded
	/// by itself, and its types are read there.
	/// </summary>
	[Fact]
	public async Task ExpandingAReferenceListsTheReferencesOfTheAssemblyItNames() {
		var workspaceId = await OpenTestAssemblyAsync();
		var reference = await FindReferenceAsync(workspaceId, "dnSpy.Backend.Core");
		Assert.True(reference.HasChildren);

		var children = await manager.GetChildrenAsync(new NodeRequest(workspaceId, reference.Id), TestContext.Current.CancellationToken);
		Assert.All(children.Nodes, node => Assert.Equal("assemblyreference", node.Kind));
		Assert.Contains(children.Nodes, node => node.Label == "dnlib");
		Assert.Contains(children.Nodes, node => node.Label == "dnSpy.Backend.Contracts");

		var roots = await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken);
		var core = Assert.Single(roots.Nodes, node => node.Kind == "assembly" && node.Label == "dnSpy.Backend.Core");
		Assert.True(core.AutoLoaded);
	}

	/// <summary>
	/// A reference to an assembly the workspace already holds resolves to that assembly, rather than loading
	/// the file a second time: its rows are the references of the module that is open, and no root is added.
	/// </summary>
	[Fact]
	public async Task AReferenceToAnOpenModuleExpandsToThatModulesOwnReferences() {
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([
			typeof(WorkspaceEditOptionsTests).Assembly.Location,
			typeof(WorkspaceManager).Assembly.Location,
		]), TestContext.Current.CancellationToken);
		var module = await FindModuleAsync(opened.WorkspaceId, "dnSpy.Backend.Core");
		var referring = await FindModuleAsync(opened.WorkspaceId, "dnSpy.Backend.Tests");
		var reference = await FindReferenceAsync(opened.WorkspaceId, "dnSpy.Backend.Core", referring);
		var rootsBefore = (await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Nodes.Count;

		var fromReference = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, reference.Id), TestContext.Current.CancellationToken);
		var moduleChildren = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, module.Id), TestContext.Current.CancellationToken);
		var referencesFolder = Assert.Single(moduleChildren.Nodes, node => node.Kind == "referencesgroup");
		var fromModule = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, referencesFolder.Id), TestContext.Current.CancellationToken);

		Assert.Equal(
			fromModule.Nodes.Where(node => node.Kind == "assemblyreference").Select(node => node.Label),
			fromReference.Nodes.Select(node => node.Label));
		Assert.Equal(rootsBefore, (await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Nodes.Count);
	}

	[Fact]
	public async Task AReferenceThatResolvesToNothingHasNothingToExpand() {
		var path = WriteModuleReferencing("No.Such.Assembly.Anywhere");
		try {
			var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
			var reference = await FindReferenceAsync(opened.WorkspaceId, "No.Such.Assembly.Anywhere");

			Assert.False(reference.HasChildren);
			var children = await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, reference.Id), TestContext.Current.CancellationToken);
			Assert.Empty(children.Nodes);
		}
		finally {
			File.Delete(path);
		}
	}

	[Fact]
	public async Task NewOptionsCarryTheDefaultsTheCreateCommandsUse() {
		var workspaceId = await OpenTestAssemblyAsync();
		var module = await FindModuleAsync(workspaceId);
		var moduleChildren = await manager.GetChildrenAsync(new NodeRequest(workspaceId, module.Id), TestContext.Current.CancellationToken);
		var @namespace = Assert.Single(moduleChildren.Nodes, node => node.Kind == "namespace" && node.Label == "dnSpy.Backend.Tests");
		var namespaceChildren = await manager.GetChildrenAsync(new NodeRequest(workspaceId, @namespace.Id), TestContext.Current.CancellationToken);
		var type = Assert.Single(namespaceChildren.Nodes, node => node.Label == "WorkspaceEditOptionsTests");

		var newType = await GetNewOptionsAsync(workspaceId, NodeOptionKinds.Type, @namespace.Id);
		var typeOptions = Assert.IsType<TypeOptionsDto>(newType.Type);
		Assert.Equal("MyType", typeOptions.Name);
		Assert.Equal("dnSpy.Backend.Tests", typeOptions.Namespace);
		Assert.Equal(TypeAttributes.Public | TypeAttributes.AutoLayout | TypeAttributes.Class | TypeAttributes.AnsiClass, (TypeAttributes)typeOptions.Attributes);
		Assert.Equal("System.Object", typeOptions.BaseType?.Display);
		// The corlib the base type comes from travels with the model, because the Kind combo reads the base
		// type back and a type is a static class only when its base type is the corlib's System.Object.
		Assert.Equal("System.Runtime", typeOptions.CorLibScope);
		// How many generic parameters the type has is the other thing the dialog cannot work out for
		// itself, and a type being created has none to allow a Var of.
		Assert.Null(typeOptions.TypeGenericParameterCount);

		var newMethod = await GetNewOptionsAsync(workspaceId, NodeOptionKinds.Method, type.Id);
		var methodOptions = Assert.IsType<MethodOptionsDto>(newMethod.Method);
		Assert.Equal("MyMethod", methodOptions.Name);
		Assert.Equal(MethodAttributes.Public | MethodAttributes.ReuseSlot | MethodAttributes.HideBySig, (MethodAttributes)methodOptions.Attributes);
		Assert.Equal(MethodImplAttributes.IL | MethodImplAttributes.Managed, (MethodImplAttributes)methodOptions.ImplAttributes);
		Assert.Equal("System.Void", methodOptions.MethodSig?.ReturnType.Display);

		var newField = await GetNewOptionsAsync(workspaceId, NodeOptionKinds.Field, type.Id);
		var fieldOptions = Assert.IsType<FieldOptionsDto>(newField.Field);
		Assert.Equal("MyField", fieldOptions.Name);
		Assert.Equal(FieldAttributes.Public, (FieldAttributes)fieldOptions.Attributes);
		Assert.Equal("System.Int32", fieldOptions.FieldSig?.Display);

		var newEvent = await GetNewOptionsAsync(workspaceId, NodeOptionKinds.Event, type.Id);
		var eventOptions = Assert.IsType<EventOptionsDto>(newEvent.Event);
		Assert.Equal("MyEvent", eventOptions.Name);
		Assert.Equal("System.EventHandler", eventOptions.EventType?.Display);
		Assert.Null(eventOptions.AddMethod);
	}

	[Fact]
	public async Task NewNestedTypeOptionsAreNestedAndHaveNoNamespaceOfTheirOwn() {
		var workspaceId = await OpenTestAssemblyAsync();
		var module = await FindModuleAsync(workspaceId);
		var moduleChildren = await manager.GetChildrenAsync(new NodeRequest(workspaceId, module.Id), TestContext.Current.CancellationToken);
		var @namespace = Assert.Single(moduleChildren.Nodes, node => node.Kind == "namespace" && node.Label == "dnSpy.Backend.Tests");
		var namespaceChildren = await manager.GetChildrenAsync(new NodeRequest(workspaceId, @namespace.Id), TestContext.Current.CancellationToken);
		var type = Assert.Single(namespaceChildren.Nodes, node => node.Label == "WorkspaceEditOptionsTests");

		var nested = Assert.IsType<TypeOptionsDto>((await GetNewOptionsAsync(workspaceId, NodeOptionKinds.Type, type.Id, nested: true)).Type);
		Assert.Equal("MyType", nested.Name);
		// A nested type carries no namespace: the one it is reached by is its declaring type's.
		Assert.Equal(string.Empty, nested.Namespace);
		Assert.Equal(
			TypeAttributes.NestedPublic | TypeAttributes.AutoLayout | TypeAttributes.Class | TypeAttributes.AnsiClass,
			(TypeAttributes)nested.Attributes);

		// The two commands answer from the same selection and differ only in that: Create Type files the
		// type where the selected type is filed, top-level.
		var flat = Assert.IsType<TypeOptionsDto>((await GetNewOptionsAsync(workspaceId, NodeOptionKinds.Type, type.Id)).Type);
		Assert.Equal("dnSpy.Backend.Tests", flat.Namespace);
		Assert.Equal(
			TypeAttributes.Public | TypeAttributes.AutoLayout | TypeAttributes.Class | TypeAttributes.AnsiClass,
			(TypeAttributes)flat.Attributes);
	}

	[Fact]
	public async Task OptionsForAnExistingNodeAreWhatThatNodeHolds() {
		var opened = await manager.OpenAsync(
			new OpenWorkspaceRequest([typeof(HelloRequest).Assembly.Location]),
			TestContext.Current.CancellationToken);
		var workspaceId = opened.WorkspaceId;
		var module = await FindModuleAsync(workspaceId);
		var moduleChildren = await manager.GetChildrenAsync(new NodeRequest(workspaceId, module.Id), TestContext.Current.CancellationToken);
		var @namespace = Assert.Single(moduleChildren.Nodes, node => node.Kind == "namespace" && node.Label == "dnSpy.Backend.Contracts");
		var types = await manager.GetChildrenAsync(new NodeRequest(workspaceId, @namespace.Id), TestContext.Current.CancellationToken);
		var exception = Assert.Single(types.Nodes, node => node.Label == "RpcException");
		var members = await manager.GetChildrenAsync(new NodeRequest(workspaceId, exception.Id), TestContext.Current.CancellationToken);
		var codeProperty = Assert.Single(members.Nodes, node => node.Kind == "property" && node.Label == "Code");
		// The getter is an accessor of that property, so dnSpy lists it under the property rather than here.
		var propertyMembers = await manager.GetChildrenAsync(new NodeRequest(workspaceId, codeProperty.Id), TestContext.Current.CancellationToken);
		var getCode = Assert.Single(propertyMembers.Nodes, node => node.Kind == "method" && node.Label.StartsWith("get_Code", StringComparison.Ordinal));

		var options = await manager.GetOptionsAsync(
			new GetNodeOptionsRequest(workspaceId, NodeOptionKinds.Method, getCode.Id),
			TestContext.Current.CancellationToken);
		var method = Assert.IsType<MethodOptionsDto>(options.Method);
		Assert.Equal("get_Code", method.Name);
		Assert.Equal(MethodAttributes.Public, (MethodAttributes)(method.Attributes & (int)MethodAttributes.MemberAccessMask));
		Assert.Equal("System.Int32", method.MethodSig?.ReturnType.Display);
		Assert.Empty(method.ParamDefs);

		var typeOptions = await manager.GetOptionsAsync(
			new GetNodeOptionsRequest(workspaceId, NodeOptionKinds.Type, exception.Id),
			TestContext.Current.CancellationToken);
		var type = Assert.IsType<TypeOptionsDto>(typeOptions.Type);
		Assert.Equal("RpcException", type.Name);
		Assert.Equal("dnSpy.Backend.Contracts", type.Namespace);
		Assert.Equal("System.Exception", type.BaseType?.Display);
		// Read-only context: how many generic parameters the type has, and which assembly the base type's
		// scope names when it is the corlib's. Neither is a page of the dialog, and both are what the base
		// type's editor gates its Var button on and what the Kind combo tells a class from a static class by.
		Assert.Equal(0, type.TypeGenericParameterCount);
		Assert.Equal("System.Runtime", type.CorLibScope);
	}

	[Fact]
	public async Task OptionsForANodeThatCannotBeEditedAreReported() {
		var workspaceId = await OpenTestAssemblyAsync();
		var module = await FindModuleAsync(workspaceId);

		var exception = await Assert.ThrowsAsync<RpcException>(() => manager.GetOptionsAsync(
			new GetNodeOptionsRequest(workspaceId, NodeOptionKinds.Type, module.Id),
			TestContext.Current.CancellationToken));
		Assert.Equal(ErrorCodes.EditValidationFailed, exception.Code);
	}

	async Task<NodeOptionsDto> GetNewOptionsAsync(string workspaceId, string kind, string ownerNodeId, bool nested = false) => await manager.GetOptionsAsync(
		new GetNodeOptionsRequest(workspaceId, kind, OwnerNodeId: ownerNodeId, IsNew: true, Nested: nested),
		TestContext.Current.CancellationToken);

	async Task<IReadOnlyList<TreeNodeDto>> ChildrenAsync(string workspaceId, string nodeId) =>
		(await manager.GetChildrenAsync(new NodeRequest(workspaceId, nodeId), TestContext.Current.CancellationToken)).Nodes;

	async Task<string> OpenTestAssemblyAsync() {
		var opened = await manager.OpenAsync(
			new OpenWorkspaceRequest([typeof(WorkspaceEditOptionsTests).Assembly.Location]),
			TestContext.Current.CancellationToken);
		return opened.WorkspaceId;
	}

	async Task<TreeNodeDto> FindModuleAsync(string workspaceId) {
		var root = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).Nodes);
		return root.Kind == "assembly"
			? Assert.Single(await ChildrenAsync(workspaceId, root.Id), node => node.Kind == "module")
			: root;
	}

	async Task<TreeNodeDto> FindModuleAsync(string workspaceId, string label) {
		var root = Assert.Single(
			(await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).Nodes,
			node => node.Label == label || node.Label.StartsWith(label + " (", StringComparison.Ordinal));
		return root.Kind == "assembly"
			? Assert.Single(await ChildrenAsync(workspaceId, root.Id), node => node.Kind == "module")
			: root;
	}

	/// <summary>The reference node the module is listed under, by the simple name it names.</summary>
	async Task<TreeNodeDto> FindReferenceAsync(string workspaceId, string assemblyName, TreeNodeDto? module = null) {
		module ??= await FindModuleAsync(workspaceId);
		var children = await manager.GetChildrenAsync(new NodeRequest(workspaceId, module.Id), TestContext.Current.CancellationToken);
		var references = Assert.Single(children.Nodes, node => node.Kind == "referencesgroup");
		var referenceNodes = await manager.GetChildrenAsync(new NodeRequest(workspaceId, references.Id), TestContext.Current.CancellationToken);
		var reference = Assert.Single(referenceNodes.Nodes, node =>
			node.Kind == "assemblyreference" && (node.Label == assemblyName || node.Label.StartsWith(assemblyName + " (", StringComparison.Ordinal)));
		return reference;
	}

	/// <summary>
	/// A module on disk with one assembly reference and nothing that resolves it. dnlib only writes a
	/// reference that something refers to, so the file holds a field typed by a type in the assembly the
	/// reference names — the same shape a real module has.
	/// </summary>
	static string WriteModuleReferencing(string assemblyName) {
		var module = new ModuleDefUser("ReferenceFixture.dll");
		var assemblyRef = new AssemblyRefUser(assemblyName);
		var type = new TypeDefUser("Fixture", "Holder");
		type.Fields.Add(new FieldDefUser("Value", new FieldSig(new ClassSig(new TypeRefUser(module, "No.Such", "Missing", assemblyRef)))));
		module.Types.Add(type);
		var path = Path.Combine(Path.GetTempPath(), $"dnspy-reference-{Guid.NewGuid():N}.dll");
		module.Write(path);
		return path;
	}

	public void Dispose() => manager.Dispose();
}
