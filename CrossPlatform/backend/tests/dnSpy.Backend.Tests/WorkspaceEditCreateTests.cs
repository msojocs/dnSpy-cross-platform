using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The writing half of the create/edit dialogs: a dialog's model is queued, committed, and has to leave the
/// module in a state that saves and reopens — and that undo and redo can walk back and forth over.
/// </summary>
public sealed class WorkspaceEditCreateTests : IDisposable {
	readonly WorkspaceManager manager = new();

	[Fact]
	public async Task CreatingAMethodPutsItInTheOwnerTypeAndNamesItsNode() {
		var workspaceId = await OpenContractsAssemblyAsync();
		var type = await FindTypeAsync(workspaceId, "dnSpy.Backend.Contracts.RpcException");
		var options = await NewOptionsAsync(workspaceId, NodeOptionKinds.Method, type.Id);
		var created = await CreateAsync(workspaceId, type.Id, options);

		Assert.Equal("method", created.Kind);
		var members = await MembersAsync(workspaceId, type.Id);
		var method = Assert.Single(members, node => node.Id == created.NodeId);
		// A method with no parameters is named with its empty parameter list, the way the tree names every
		// method — which is also what tells us the row really is in the type now.
		Assert.Equal("MyMethod()", method.Label);
		Assert.Equal("method", method.Kind);
	}

	[Fact]
	public async Task CreatingATypePutsItAtTheTopLevelOfTheNamespaceItIsFiledUnder() {
		var workspaceId = await OpenContractsAssemblyAsync();
		var type = await FindTypeAsync(workspaceId, "dnSpy.Backend.Contracts.RpcException");
		var @namespace = await NamespaceOfAsync(workspaceId, type);

		var created = await CreateAsync(workspaceId, @namespace.Id, await NewOptionsAsync(workspaceId, NodeOptionKinds.Type, @namespace.Id));

		Assert.Equal("type", created.Kind);
		Assert.Equal("MyType", created.Label);
		var types = await ChildrenAsync(workspaceId, @namespace.Id);
		Assert.Contains(types, node => node.Id == created.NodeId);
		// A top-level type is not a nested one, so the type it was created from is untouched.
		var nestedInSelected = await ChildrenAsync(workspaceId, type.Id);
		Assert.DoesNotContain(nestedInSelected, node => node.Id == created.NodeId);

		// Create Type says top-level whatever is selected, so a type node is not an instruction to nest in
		// it — dnSpy's own command reads the selection's nearest namespace ancestor instead, and a type's is
		// the namespace its name is written with.
		var fromAType = await CreateAsync(workspaceId, type.Id, await NewOptionsAsync(workspaceId, NodeOptionKinds.Type, type.Id));
		Assert.Equal("MyType", fromAType.Label);
		Assert.Contains(await ChildrenAsync(workspaceId, @namespace.Id), node => node.Id == fromAType.NodeId);
		Assert.DoesNotContain(await ChildrenAsync(workspaceId, type.Id), node => node.Id == fromAType.NodeId);
	}

	[Fact]
	public async Task CreatingANestedTypePutsItInTheSelectedTypeAndNowhereElse() {
		var workspaceId = await OpenContractsAssemblyAsync();
		var type = await FindTypeAsync(workspaceId, "dnSpy.Backend.Contracts.RpcException");
		var @namespace = await NamespaceOfAsync(workspaceId, type);

		var nested = await CreateAsync(workspaceId, type.Id, await NewOptionsAsync(workspaceId, NodeOptionKinds.Type, type.Id, nested: true), nested: true);

		Assert.Equal("type", nested.Kind);
		// A nested type has no namespace of its own: its name is its declaring type's and the hash-marked
		// one the metadata gives it.
		Assert.Equal("RpcException+MyType", nested.Label);
		Assert.Contains(await ChildrenAsync(workspaceId, type.Id), node => node.Id == nested.NodeId);
		Assert.DoesNotContain(await ChildrenAsync(workspaceId, @namespace.Id), node => node.Id == nested.NodeId);

		// Which is also what a member selection nests in: the type the member belongs to, since a method
		// cannot hold a type.
		var member = await FindMethodAsync(workspaceId, type.Id);
		var fromAMember = await CreateAsync(workspaceId, member.Id, await NewOptionsAsync(workspaceId, NodeOptionKinds.Type, member.Id, nested: true), nested: true);
		Assert.Equal("RpcException+MyType", fromAMember.Label);
		Assert.Contains(await ChildrenAsync(workspaceId, type.Id), node => node.Id == fromAMember.NodeId);
	}

	[Fact]
	public async Task ACreatedTypeIsWrittenWithTheAttributesTheCommandsUse() {
		var workspaceId = await OpenContractsAssemblyAsync();
		var type = await FindTypeAsync(workspaceId, "dnSpy.Backend.Contracts.RpcException");
		var @namespace = await NamespaceOfAsync(workspaceId, type);

		var flat = await CreateAsync(workspaceId, @namespace.Id, await NewOptionsAsync(workspaceId, NodeOptionKinds.Type, @namespace.Id));
		var nested = await CreateAsync(workspaceId, type.Id, await NewOptionsAsync(workspaceId, NodeOptionKinds.Type, type.Id, nested: true), nested: true);

		var flatOptions = Assert.IsType<TypeOptionsDto>((await manager.GetOptionsAsync(
			new GetNodeOptionsRequest(workspaceId, NodeOptionKinds.Type, flat.NodeId), TestContext.Current.CancellationToken)).Type);
		var nestedOptions = Assert.IsType<TypeOptionsDto>((await manager.GetOptionsAsync(
			new GetNodeOptionsRequest(workspaceId, NodeOptionKinds.Type, nested.NodeId), TestContext.Current.CancellationToken)).Type);

		Assert.Equal(
			TypeAttributes.Public | TypeAttributes.AutoLayout | TypeAttributes.Class | TypeAttributes.AnsiClass,
			(TypeAttributes)flatOptions.Attributes);
		Assert.Equal(
			TypeAttributes.NestedPublic | TypeAttributes.AutoLayout | TypeAttributes.Class | TypeAttributes.AnsiClass,
			(TypeAttributes)nestedOptions.Attributes);
		Assert.Equal("System.Object", flatOptions.BaseType?.Display);
		Assert.Equal("System.Object", nestedOptions.BaseType?.Display);
	}

	[Fact]
	public async Task ACreatedTypeIsFiledInTheNamespaceTheDialogWasOpenedWith() {
		var workspaceId = await OpenContractsAssemblyAsync();
		var type = await FindTypeAsync(workspaceId, "dnSpy.Backend.Contracts.RpcException");

		// The dialog's namespace box is writable, so what it was changed to is what files the type: the
		// module holds it either way, and nothing else is keyed by the namespace.
		var options = await NewOptionsAsync(workspaceId, NodeOptionKinds.Type, type.Id);
		var renamed = options with { Type = options.Type! with { Name = "Widget", Namespace = "Other.Place" } };
		var created = await CreateAsync(workspaceId, type.Id, renamed);

		Assert.Equal("Widget", created.Label);
		var module = await FindModuleAsync(workspaceId);
		var @namespace = Assert.Single(await ChildrenAsync(workspaceId, module.Id), node => node.Kind == "namespace" && node.Label == "Other.Place");
		Assert.Single(await ChildrenAsync(workspaceId, @namespace.Id), node => node.Id == created.NodeId);
	}

	[Fact]
	public async Task UndoingACreationTakesTheRowOutAndRedoPutsTheSameOneBack() {
		var workspaceId = await OpenContractsAssemblyAsync();
		var type = await FindTypeAsync(workspaceId, "dnSpy.Backend.Contracts.RpcException");
		var created = await CreateAsync(workspaceId, type.Id, await NewOptionsAsync(workspaceId, NodeOptionKinds.Method, type.Id));

		await manager.UndoAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken);
		var afterUndo = await MembersAsync(workspaceId, type.Id);
		Assert.DoesNotContain(afterUndo, node => node.Id == created.NodeId);

		await manager.RedoAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken);
		var afterRedo = await MembersAsync(workspaceId, type.Id);
		// The node id is the module, the kind and the row's token, so a node id that survived the round trip
		// is the same row in the metadata — not a second one that happens to look like it.
		var restored = Assert.Single(afterRedo, node => node.Id == created.NodeId);
		Assert.Equal(created.Label, restored.Label);
	}

	[Fact]
	public async Task ANewMethodHasNoBodyUntilOneIsWritten() {
		var workspaceId = await OpenContractsAssemblyAsync();
		var type = await FindTypeAsync(workspaceId, "dnSpy.Backend.Contracts.RpcException");
		var created = await CreateAsync(workspaceId, type.Id, await NewOptionsAsync(workspaceId, NodeOptionKinds.Method, type.Id));

		var exception = await Assert.ThrowsAsync<RpcException>(() => manager.GetMethodBodyAsync(
			new MethodBodyRequest(workspaceId, created.NodeId),
			TestContext.Current.CancellationToken));
		Assert.Equal(ErrorCodes.EditValidationFailed, exception.Code);

		// Which "Replace Method Body with stub..." can fix, since the method is a real row in the type.
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), TestContext.Current.CancellationToken);
		await manager.QueueMethodBodyStubAsync(
			new ReplaceMethodBodyWithStubRequest(workspaceId, transaction.TransactionId, created.NodeId),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var body = await manager.GetMethodBodyAsync(new MethodBodyRequest(workspaceId, created.NodeId), TestContext.Current.CancellationToken);
		Assert.NotEmpty(body.Instructions);
	}

	[Fact]
	public async Task EditingARowWritesTheWholeModelOverItAndUndoRestoresWhatItHeld() {
		var workspaceId = await OpenContractsAssemblyAsync();
		var type = await FindTypeAsync(workspaceId, "dnSpy.Backend.Contracts.RpcException");
		var member = await FindMethodAsync(workspaceId, type.Id);
		var before = await manager.GetOptionsAsync(
			new GetNodeOptionsRequest(workspaceId, NodeOptionKinds.Method, member.Id),
			TestContext.Current.CancellationToken);

		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), TestContext.Current.CancellationToken);
		await manager.QueueSetOptionsAsync(
			new SetNodeOptionsRequest(workspaceId, transaction.TransactionId, member.Id, before with { Method = before.Method! with { Name = "Renamed" } }),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		// The accessor lives under the property that declares it, and renaming the method does not move the
		// property, so the renamed row is read from the property's children.
		var property = Assert.Single(await MembersAsync(workspaceId, type.Id), node => node.Kind == "property" && node.Label == "Code");
		var renamed = Assert.Single(await ChildrenAsync(workspaceId, property.Id), node => node.Id == member.Id);
		Assert.StartsWith("Renamed", renamed.Label, StringComparison.Ordinal);
		// The node itself is the same row throughout: an edit changes what a row says, not which row it is.
		var after = await manager.GetOptionsAsync(
			new GetNodeOptionsRequest(workspaceId, NodeOptionKinds.Method, member.Id),
			TestContext.Current.CancellationToken);
		Assert.Equal("Renamed", after.Method?.Name);
		Assert.Equal(before.Method?.MethodSig?.Display, after.Method?.MethodSig?.Display);

		await manager.UndoAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken);
		var restored = Assert.Single(await ChildrenAsync(workspaceId, property.Id), node => node.Id == member.Id);
		Assert.Equal(member.Label, restored.Label);
	}

	[Fact]
	public async Task ACreatedMethodIsInTheFileThatIsSavedAndReopened() {
		var workspaceId = await OpenContractsAssemblyAsync();
		var type = await FindTypeAsync(workspaceId, "dnSpy.Backend.Contracts.RpcException");
		var created = await CreateAsync(workspaceId, type.Id, await NewOptionsAsync(workspaceId, NodeOptionKinds.Method, type.Id));
		var moduleId = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).Nodes).Id;

		var destination = Path.Combine(Path.GetTempPath(), $"dnspy-created-{Guid.NewGuid():N}.dll");
		try {
			await manager.SaveModuleAsync(new SaveModuleRequest(workspaceId, moduleId, destination), TestContext.Current.CancellationToken);

			var reopened = await manager.OpenAsync(new OpenWorkspaceRequest([destination]), TestContext.Current.CancellationToken);
			var results = await manager.SearchAsync(
				new SearchRequest(reopened.WorkspaceId, "MyMethod", SearchTypes.Method),
				TestContext.Current.CancellationToken);
			var found = Assert.Single(results.Results);
			// The search list writes the return type ahead of the tree's "name(params)".
			Assert.Equal($"void {created.Label}", found.Name);
			Assert.Equal("dnSpy.Backend.Contracts.RpcException", found.Location);
		}
		finally {
			File.Delete(destination);
		}
	}

	[Fact]
	public async Task ACreationThatCannotBeAppliedIsRejectedBeforeAnythingIsBuilt() {
		var workspaceId = await OpenContractsAssemblyAsync();
		var module = await FindModuleAsync(workspaceId);
		var type = await FindTypeAsync(workspaceId, "dnSpy.Backend.Contracts.RpcException");
		var options = await NewOptionsAsync(workspaceId, NodeOptionKinds.Method, type.Id);
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), TestContext.Current.CancellationToken);
		var before = await MembersAsync(workspaceId, type.Id);

		// A module holds types, not methods, so this owner cannot take the row the dialog offers.
		var exception = await Assert.ThrowsAsync<RpcException>(() => manager.QueueCreateAsync(
			new CreateNodeRequest(workspaceId, transaction.TransactionId, module.Id, options),
			TestContext.Current.CancellationToken));
		Assert.Equal(ErrorCodes.EditValidationFailed, exception.Code);

		await manager.RollbackEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);
		Assert.Equal(before.Select(node => node.Id), (await MembersAsync(workspaceId, type.Id)).Select(node => node.Id));
	}

	[Fact]
	public async Task EditingATypeWritesTheWholeModelOverItAndUndoRestoresWhatItHeld() {
		var workspaceId = await OpenContractsAssemblyAsync();
		var type = await FindTypeAsync(workspaceId, "dnSpy.Backend.Contracts.RpcException");
		var before = await manager.GetOptionsAsync(
			new GetNodeOptionsRequest(workspaceId, NodeOptionKinds.Type, type.Id),
			TestContext.Current.CancellationToken);

		// Every page of the window at once: the name, the layout, an interface, a generic parameter and a
		// security row. The collections are rebuilt rather than merged, so one write has to carry them all.
		var edited = before.Type! with {
			Name = "Renamed",
			PackingSize = 8,
			ClassSize = 0x40,
			Interfaces = [new TypeDefOrRefAndCaDto(new TypeSigDto("type", new TypeRefDto("System.Runtime", "System", "IDisposable"), ValueType: false), [])],
			GenericParameters = [new GenericParamDto(0, 0, "T", null, [], [])],
			DeclSecurities = [new DeclSecurityDto(2, [], [])],
		};
		await WriteOptionsAsync(workspaceId, type.Id, NodeOptionsDto.OfType(edited));

		// The tree says so where the type is listed, which is the namespace the name files it under.
		var @namespace = await NamespaceOfAsync(workspaceId, type);
		var renamed = Assert.Single(await ChildrenAsync(workspaceId, @namespace.Id), node => node.Id == type.Id);
		Assert.Equal("Renamed", renamed.Label);

		var after = Assert.IsType<TypeOptionsDto>((await manager.GetOptionsAsync(
			new GetNodeOptionsRequest(workspaceId, NodeOptionKinds.Type, type.Id), TestContext.Current.CancellationToken)).Type);
		Assert.Equal(8u, after.PackingSize);
		Assert.Equal(0x40u, after.ClassSize);
		Assert.Equal("System.IDisposable", Assert.Single(after.Interfaces).Display);
		Assert.Equal("T", Assert.Single(after.GenericParameters).Name);
		Assert.Equal(2, Assert.Single(after.DeclSecurities).Action);
		Assert.Equal(before.Type?.BaseType?.Display, after.BaseType?.Display);

		await manager.UndoAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken);
		var restored = Assert.IsType<TypeOptionsDto>((await manager.GetOptionsAsync(
			new GetNodeOptionsRequest(workspaceId, NodeOptionKinds.Type, type.Id), TestContext.Current.CancellationToken)).Type);
		Assert.Equal("RpcException", restored.Name);
		Assert.Null(restored.PackingSize);
		Assert.Empty(restored.Interfaces);
		Assert.Empty(restored.GenericParameters);
		Assert.Empty(restored.DeclSecurities);
	}

	[Fact]
	public async Task ATypeEditIsInTheFileThatIsSavedAndReopened() {
		var workspaceId = await OpenContractsAssemblyAsync();
		var type = await FindTypeAsync(workspaceId, "dnSpy.Backend.Contracts.RpcException");
		var before = await manager.GetOptionsAsync(
			new GetNodeOptionsRequest(workspaceId, NodeOptionKinds.Type, type.Id),
			TestContext.Current.CancellationToken);
		await WriteOptionsAsync(workspaceId, type.Id, NodeOptionsDto.OfType(before.Type! with {
			Name = "Renamed",
			PackingSize = 8,
			ClassSize = 0x40,
			GenericParameters = [new GenericParamDto(0, 0, "T", null, [], [])],
		}));
		var moduleId = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).Nodes).Id;

		var destination = Path.Combine(Path.GetTempPath(), $"dnspy-edited-type-{Guid.NewGuid():N}.dll");
		try {
			await manager.SaveModuleAsync(new SaveModuleRequest(workspaceId, moduleId, destination), TestContext.Current.CancellationToken);

			// The row's own fields and its generic parameter have to be in the file, not merely in the tree:
			// a layout and a parameter list are metadata rows of their own, and it is the file that says
			// whether they were written.
			using var saved = ModuleDefMD.Load(destination);
			var savedType = saved.Find("dnSpy.Backend.Contracts.Renamed", isReflectionName: true);
			Assert.Equal((ushort?)8, savedType.ClassLayout?.PackingSize);
			Assert.Equal((uint?)0x40, savedType.ClassLayout?.ClassSize);
			Assert.Equal("T", Assert.Single(savedType.GenericParameters).Name);
		}
		finally {
			File.Delete(destination);
		}
	}

	[Fact]
	public async Task AnEditWithTheWrongKindOfOptionsIsRejected() {
		var workspaceId = await OpenContractsAssemblyAsync();
		var type = await FindTypeAsync(workspaceId, "dnSpy.Backend.Contracts.RpcException");
		var member = await FindMethodAsync(workspaceId, type.Id);
		var fieldOptions = await NewOptionsAsync(workspaceId, NodeOptionKinds.Field, type.Id);
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), TestContext.Current.CancellationToken);

		var exception = await Assert.ThrowsAsync<RpcException>(() => manager.QueueSetOptionsAsync(
			new SetNodeOptionsRequest(workspaceId, transaction.TransactionId, member.Id, fieldOptions),
			TestContext.Current.CancellationToken));
		Assert.Equal(ErrorCodes.EditValidationFailed, exception.Code);
		await manager.RollbackEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);
	}

	/// <summary>Queues an edit of the node's options and commits it, which is what accepting one of the
	/// dialogs does.</summary>
	async Task WriteOptionsAsync(string workspaceId, string nodeId, NodeOptionsDto options) {
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), TestContext.Current.CancellationToken);
		await manager.QueueSetOptionsAsync(
			new SetNodeOptionsRequest(workspaceId, transaction.TransactionId, nodeId, options),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);
	}

	async Task<EditNodeResponse> CreateAsync(string workspaceId, string ownerNodeId, NodeOptionsDto options, bool nested = false) {
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), TestContext.Current.CancellationToken);
		var created = await manager.QueueCreateAsync(
			new CreateNodeRequest(workspaceId, transaction.TransactionId, ownerNodeId, options, nested),
			TestContext.Current.CancellationToken);
		var committed = await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);
		// What the client reveals after a create is this id, so it has to be in the response the commit gives back.
		Assert.Contains(created.NodeId, committed.ChangedNodeIds);
		return created;
	}

	Task<NodeOptionsDto> NewOptionsAsync(string workspaceId, string kind, string ownerNodeId, bool nested = false) => manager.GetOptionsAsync(
		new GetNodeOptionsRequest(workspaceId, kind, OwnerNodeId: ownerNodeId, IsNew: true, Nested: nested),
		TestContext.Current.CancellationToken);

	async Task<IReadOnlyList<TreeNodeDto>> ChildrenAsync(string workspaceId, string nodeId) =>
		(await manager.GetChildrenAsync(new NodeRequest(workspaceId, nodeId), TestContext.Current.CancellationToken)).Nodes;

	Task<IReadOnlyList<TreeNodeDto>> MembersAsync(string workspaceId, string typeNodeId) => ChildrenAsync(workspaceId, typeNodeId);

	/// <summary>
	/// One method of the type, which is the `Code` property's getter in the fixture the tests use. dnSpy
	/// files an accessor under the property that declares it, so the row hangs off the property node rather
	/// than off the type.
	/// </summary>
	async Task<TreeNodeDto> FindMethodAsync(string workspaceId, string typeNodeId) {
		var property = Assert.Single(await MembersAsync(workspaceId, typeNodeId), node => node.Kind == "property" && node.Label == "Code");
		return Assert.Single(await ChildrenAsync(workspaceId, property.Id), node => node.Label.StartsWith("get_Code", StringComparison.Ordinal));
	}

	async Task<TreeNodeDto> FindTypeAsync(string workspaceId, string fullName) {
		var module = await FindModuleAsync(workspaceId);
		var @namespace = fullName[..fullName.LastIndexOf('.')];
		var typeName = fullName[(fullName.LastIndexOf('.') + 1)..];
		foreach (var node in await ChildrenAsync(workspaceId, module.Id)) {
			if (node.Kind != "namespace" || node.Label != @namespace)
				continue;
			return Assert.Single(await ChildrenAsync(workspaceId, node.Id), candidate => candidate.Label == typeName);
		}
		throw new InvalidOperationException($"The module has no namespace '{@namespace}'.");
	}

	async Task<TreeNodeDto> NamespaceOfAsync(string workspaceId, TreeNodeDto type) {
		var module = await FindModuleAsync(workspaceId);
		// Type labels carry no namespace now, so take it off the tooltip (full name).
		var description = type.Description!;
		var @namespace = description[..description.LastIndexOf('.')];
		return Assert.Single(await ChildrenAsync(workspaceId, module.Id), node => node.Kind == "namespace" && node.Label == @namespace);
	}

	async Task<string> OpenContractsAssemblyAsync() {
		var opened = await manager.OpenAsync(
			new OpenWorkspaceRequest([typeof(HelloRequest).Assembly.Location]),
			TestContext.Current.CancellationToken);
		return opened.WorkspaceId;
	}

	async Task<TreeNodeDto> FindModuleAsync(string workspaceId) {
		var root = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).Nodes);
		return root.Kind == "assembly"
			? Assert.Single(await ChildrenAsync(workspaceId, root.Id), node => node.Kind == "module")
			: root;
	}

	public void Dispose() => manager.Dispose();
}
