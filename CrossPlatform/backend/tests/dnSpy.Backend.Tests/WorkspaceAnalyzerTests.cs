using System.Reflection;
using AnalyzerTarget;
using AnalyzerTarget.Consumer;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The analyzer tree against the AnalyzerTarget fixtures: what dnSpy's analyzer shows for a member, which
/// searches it offers, and what each of them finds — across the two assemblies, through the scope rules a
/// member's accessibility sets.
/// </summary>
public sealed class WorkspaceAnalyzerTests : IDisposable {
	const BindingFlags AnyMember = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
	readonly WorkspaceManager manager = new();

	static CancellationToken Token => TestContext.Current.CancellationToken;

	[Fact]
	public async Task WritesRowsTheWayTheWpfAnalyzerDoes() {
		var workspaceId = await OpenAsync();

		Assert.Equal("Circle", (await RootAsync(workspaceId, typeof(Circle))).Label);
		Assert.Equal("Box<T>", (await RootAsync(workspaceId, typeof(Box<>))).Label);
		Assert.Equal("AnalyzerTarget.Circle.Area() : double", (await RootAsync(workspaceId, Method<Circle>(nameof(Circle.Area)))).Label);
		Assert.Equal("AnalyzerTarget.Circle.Circle(double) : void", (await RootAsync(workspaceId, typeof(Circle).GetConstructors()[0])).Label);
		Assert.Equal("AnalyzerTarget.Circle.Radius : double", (await RootAsync(workspaceId, typeof(Circle).GetField(nameof(Circle.Radius))!)).Label);
		Assert.Equal("AnalyzerTarget.Circle.Name : string", (await RootAsync(workspaceId, typeof(Circle).GetProperty(nameof(Circle.Name), AnyMember)!)).Label);
		Assert.Equal("AnalyzerTarget.Shape.Changed : EventHandler", (await RootAsync(workspaceId, typeof(Shape).GetEvent(nameof(Shape.Changed))!)).Label);
		Assert.Equal("AnalyzerTarget.Box<T>.this[int] : T", (await RootAsync(workspaceId, typeof(Box<>).GetProperty("Item")!)).Label);
		Assert.Equal("AnalyzerTarget.Consumer.Ellipse.Area() : double", (await RootAsync(workspaceId, Method<Ellipse>(nameof(Ellipse.Area)))).Label);

		var area = Method<Circle>(nameof(Circle.Area));
		var row = await RootAsync(workspaceId, area);
		Assert.Equal("method", row.Kind);
		Assert.Equal("method", row.Icon);
		Assert.Equal(area.MetadataToken, row.MetadataToken);
		Assert.Equal(await NodeAsync(workspaceId, area), row.NodeId);
		Assert.True(row.HasChildren);
		Assert.True(row.IsPublic);
		Assert.Equal("class", (await RootAsync(workspaceId, typeof(Circle))).Icon);
		Assert.Equal("interface", (await RootAsync(workspaceId, typeof(IShape))).Icon);
	}

	[Fact]
	public async Task AnswersNullForANodeThatIsNotAMember() {
		var workspaceId = await OpenAsync();
		var circle = await NodeAsync(workspaceId, typeof(Circle));
		var assembly = (await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), Token)).Nodes[0];

		var rows = (await manager.AnalyzeNodesAsync(new AnalyzeNodesRequest(workspaceId, [assembly.Id, "n999999", circle]), Token)).Nodes;

		Assert.Null(rows[0]);
		Assert.Null(rows[1]);
		Assert.Equal("Circle", rows[2]?.Label);
	}

	[Fact]
	public async Task AnswersNullForAMemberAnEditDeleted() {
		var workspaceId = await OpenAsync();
		var describe = await NodeAsync(workspaceId, Method<Circle>(nameof(Circle.Describe)));
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), Token);
		await manager.QueueDeleteAsync(new DeleteEditRequest(workspaceId, transaction.TransactionId, describe), Token);
		await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), Token);

		Assert.Null(Assert.Single((await manager.AnalyzeNodesAsync(new AnalyzeNodesRequest(workspaceId, [describe]), Token)).Nodes));

		await manager.UndoAsync(new WorkspaceRequest(workspaceId), Token);
		Assert.NotNull(Assert.Single((await manager.AnalyzeNodesAsync(new AnalyzeNodesRequest(workspaceId, [describe]), Token)).Nodes));
	}

	[Fact]
	public async Task OffersTheSearchesEachMemberHas() {
		var workspaceId = await OpenAsync();

		Assert.Equal(["instantiatedBy", "usedBy", "exposedBy", "subtypes", "extensionMethods"], await SearchKeysAsync(workspaceId, typeof(Circle)));
		Assert.Equal(["appliedTo", "instantiatedBy", "usedBy", "exposedBy", "extensionMethods"], await SearchKeysAsync(workspaceId, typeof(MarkerAttribute)));
		Assert.Equal(["usedBy", "exposedBy", "subtypes", "extensionMethods"], await SearchKeysAsync(workspaceId, typeof(IShape)));
		Assert.Equal(["usedBy"], await SearchKeysAsync(workspaceId, typeof(ShapeExtensions)));
		Assert.Equal(["uses", "usedBy", "overrides", "overriddenBy"], await SearchKeysAsync(workspaceId, Method<Circle>(nameof(Circle.Area))));
		Assert.Equal(["usedBy", "implementedBy"], await SearchKeysAsync(workspaceId, Method<IShape>(nameof(IShape.Area))));
		Assert.Equal(["readBy", "assignedBy"], await SearchKeysAsync(workspaceId, typeof(Circle).GetField(nameof(Circle.Radius))!));
		// A constant is folded into its readers, so nothing can assign it.
		Assert.Equal(["readBy"], await SearchKeysAsync(workspaceId, typeof(Circle).GetField(nameof(Circle.Pi))!));

		var name = await ChildrenAsync(workspaceId, await NodeAsync(workspaceId, typeof(Circle).GetProperty(nameof(Circle.Name), AnyMember)!));
		Assert.Equal(["get", "Overrides", "Overridden By"], name.Select(row => row.Label));
		var getter = name[0];
		Assert.Equal("method", getter.Kind);
		Assert.Equal("get", getter.Accessor);
		Assert.Equal(await NodeAsync(workspaceId, typeof(Circle).GetProperty(nameof(Circle.Name), AnyMember)!.GetMethod!), getter.NodeId);
		Assert.Equal("search", name[1].Kind);
		Assert.Equal("search", name[1].Icon);

		var indexer = await ChildrenAsync(workspaceId, await NodeAsync(workspaceId, typeof(Box<>).GetProperty("Item")!));
		Assert.Equal(["get", "set"], indexer.Select(row => row.Label));
		Assert.Equal([false, true], indexer.Select(row => row.IsSetter));

		var changed = await ChildrenAsync(workspaceId, await NodeAsync(workspaceId, typeof(Shape).GetEvent(nameof(Shape.Changed))!));
		Assert.Equal(["add", "remove", "Raised By"], changed.Select(row => row.Label));
		var interfaceEvent = await ChildrenAsync(workspaceId, await NodeAsync(workspaceId, typeof(IShape).GetEvent(nameof(IShape.Changed))!));
		Assert.Equal(["add", "remove", "Implemented By"], interfaceEvent.Select(row => row.Label));
	}

	[Fact]
	public async Task RefusesASearchTheMemberDoesNotHave() {
		var workspaceId = await OpenAsync();
		var pi = await NodeAsync(workspaceId, typeof(Circle).GetField(nameof(Circle.Pi))!);

		var exception = await Assert.ThrowsAsync<RpcException>(() => manager.AnalyzeChildrenAsync(
			new AnalyzeChildrenRequest(workspaceId, pi, AnalyzerSearchKinds.AssignedBy), Token));

		Assert.Equal(ErrorCodes.InvalidParams, exception.Code);
	}

	[Fact]
	public async Task FindsTheCallersOfAVirtualMethodThroughTheSlotItOverrides() {
		var workspaceId = await OpenAsync();

		var rows = await SearchAsync(workspaceId, Method<Circle>(nameof(Circle.Area)), AnalyzerSearchKinds.UsedBy);

		// A call through Shape.Area may land in the override; one through IShape.Area is another slot.
		Assert.Contains("AnalyzerTarget.Usage.Sum(Shape) : double", Labels(rows));
		Assert.Contains("AnalyzerTarget.Consumer.FriendCalls.Area(Circle) : double", Labels(rows));
		Assert.Contains("AnalyzerTarget.Consumer.Ellipse.Area() : double", Labels(rows));
		Assert.DoesNotContain("AnalyzerTarget.Usage.Total(IShape) : double", Labels(rows));

		var sum = Assert.Single(rows, row => row.Label == "AnalyzerTarget.Usage.Sum(Shape) : double");
		Assert.NotNull(sum.Source);
		Assert.NotNull(sum.Source.IlOffset);
		Assert.Equal(Method(typeof(Usage), nameof(Usage.Sum)).MetadataToken, sum.Source.MethodToken);
		Assert.Equal(await NodeAsync(workspaceId, Method(typeof(Usage), nameof(Usage.Sum))), sum.Source.MethodNodeId);
		Assert.Equal(await NodeAsync(workspaceId, Method<Shape>(nameof(Shape.Area))), Assert.Single(sum.Source.Targets).NodeId);

		// The lambda's body is compiler-generated: dnSpy lists the method that holds it, with nowhere in that
		// method's own body to point at.
		var lambda = Assert.Single(rows, row => row.Label == "AnalyzerTarget.Usage.Lambda(Circle) : Func<double>");
		Assert.Null(lambda.Source);
	}

	[Fact]
	public async Task FindsTheCallersOfAConstructor() {
		var workspaceId = await OpenAsync();

		var rows = await SearchAsync(workspaceId, typeof(Circle).GetConstructors()[0], AnalyzerSearchKinds.UsedBy);

		Assert.Contains("AnalyzerTarget.Exposer.Make() : Circle", Labels(rows));
		Assert.Contains("AnalyzerTarget.Consumer.Ellipse.Ellipse() : void", Labels(rows));
	}

	[Fact]
	public async Task ListsEveryReferenceAMethodBodyMakes() {
		var workspaceId = await OpenAsync();

		var rows = await SearchAsync(workspaceId, Method<Circle>(nameof(Circle.Grow)), AnalyzerSearchKinds.Uses);

		// "Radius *= 2" loads the field and stores it back: two references, two rows.
		Assert.Equal(2, rows.Count(row => row.Label == "AnalyzerTarget.Circle.Radius : double"));
		Assert.Contains("AnalyzerTarget.Shape.OnChanged() : void", Labels(rows));
		Assert.All(rows, row => Assert.NotNull(row.Source?.IlOffset));
	}

	[Fact]
	public async Task FindsTheReadersAndWritersOfAField() {
		var workspaceId = await OpenAsync();
		var radius = typeof(Circle).GetField(nameof(Circle.Radius))!;

		var readBy = await SearchAsync(workspaceId, radius, AnalyzerSearchKinds.ReadBy);
		Assert.Contains("AnalyzerTarget.Circle.Area() : double", Labels(readBy));
		Assert.Contains("AnalyzerTarget.Circle.Grow() : void", Labels(readBy));
		Assert.Contains("AnalyzerTarget.ShapeExtensions.Diameter(Circle) : double", Labels(readBy));
		// The read is in the iterator's state machine, which dnSpy lists as the method that created it.
		Assert.Null(Assert.Single(readBy, row => row.Label == "AnalyzerTarget.Usage.Iterate(Circle) : IEnumerable<double>").Source);

		var assignedBy = await SearchAsync(workspaceId, radius, AnalyzerSearchKinds.AssignedBy);
		Assert.Equal(["AnalyzerTarget.Circle.Circle(double) : void", "AnalyzerTarget.Circle.Grow() : void"], Labels(assignedBy).Order(StringComparer.Ordinal));
	}

	[Fact]
	public async Task FindsOverridesBothWays() {
		var workspaceId = await OpenAsync();

		Assert.Equal(["AnalyzerTarget.Shape.Area() : double"], Labels(await SearchAsync(workspaceId, Method<Circle>(nameof(Circle.Area)), AnalyzerSearchKinds.Overrides)));
		Assert.Equal(["AnalyzerTarget.Shape.Name : string"], Labels(await SearchAsync(workspaceId, typeof(Circle).GetProperty(nameof(Circle.Name), AnyMember)!, AnalyzerSearchKinds.Overrides)));

		var overriddenBy = await SearchAsync(workspaceId, Method<Shape>(nameof(Shape.Area)), AnalyzerSearchKinds.OverriddenBy);
		Assert.Equal(["AnalyzerTarget.Circle.Area() : double", "AnalyzerTarget.Consumer.Ellipse.Area() : double"], Labels(overriddenBy).Order(StringComparer.Ordinal));
		Assert.All(overriddenBy, row => Assert.False(row.HidesParent));

		// A "new" method hides the virtual one rather than overriding it.
		var describe = Assert.Single(await SearchAsync(workspaceId, Method<Shape>(nameof(Shape.Describe)), AnalyzerSearchKinds.OverriddenBy));
		Assert.Equal("AnalyzerTarget.Circle.Describe() : void", describe.Label);
		Assert.True(describe.HidesParent);
	}

	[Fact]
	public async Task FindsTheImplementationsOfAnInterfaceMember() {
		var workspaceId = await OpenAsync();

		var area = Labels(await SearchAsync(workspaceId, Method<IShape>(nameof(IShape.Area)), AnalyzerSearchKinds.ImplementedBy));
		Assert.Contains("AnalyzerTarget.Circle.Area() : double", area);
		Assert.Contains("AnalyzerTarget.Square.AnalyzerTarget.IShape.Area() : double", area);
		Assert.Contains("AnalyzerTarget.Consumer.Ellipse.Area() : double", area);
		Assert.Contains("AnalyzerTarget.Consumer.Blob.Area() : double", area);
		// An abstract method implements nothing.
		Assert.DoesNotContain("AnalyzerTarget.Shape.Area() : double", area);

		var name = Labels(await SearchAsync(workspaceId, typeof(IShape).GetProperty(nameof(IShape.Name))!, AnalyzerSearchKinds.ImplementedBy));
		Assert.Contains("AnalyzerTarget.Shape.Name : string", name);
		Assert.Contains("AnalyzerTarget.Square.AnalyzerTarget.IShape.Name : string", name);
		Assert.Contains("AnalyzerTarget.Consumer.Blob.Name : string", name);

		var changed = Labels(await SearchAsync(workspaceId, typeof(IShape).GetEvent(nameof(IShape.Changed))!, AnalyzerSearchKinds.ImplementedBy));
		Assert.Contains("AnalyzerTarget.Shape.Changed : EventHandler", changed);
		Assert.Contains("AnalyzerTarget.Consumer.Blob.Changed : EventHandler", changed);
	}

	[Fact]
	public async Task FindsSubtypesAcrossAssemblies() {
		var workspaceId = await OpenAsync();

		Assert.Equal(["Circle", "Ellipse"], Labels(await SearchAsync(workspaceId, typeof(Shape), AnalyzerSearchKinds.Subtypes)).Order(StringComparer.Ordinal));
		// An interface is implemented by the type that lists it and by every type derived from that.
		Assert.Equal(["Blob", "Circle", "Ellipse", "Shape", "Square"], Labels(await SearchAsync(workspaceId, typeof(IShape), AnalyzerSearchKinds.Subtypes)).Order(StringComparer.Ordinal));
	}

	[Fact]
	public async Task FindsWhatInstantiatesAType() {
		var workspaceId = await OpenAsync();

		// Ellipse's constructor chains to Circle's, which is not an instantiation.
		var make = Assert.Single(await SearchAsync(workspaceId, typeof(Circle), AnalyzerSearchKinds.InstantiatedBy));
		Assert.Equal("AnalyzerTarget.Exposer.Make() : Circle", make.Label);
		Assert.NotNull(make.Source?.IlOffset);
		Assert.Equal(await NodeAsync(workspaceId, typeof(Circle).GetConstructors()[0]), Assert.Single(make.Source.Targets).NodeId);
	}

	[Fact]
	public async Task FindsWhereATypeIsUsedExposedAndExtended() {
		var workspaceId = await OpenAsync();

		var usedBy = Labels(await SearchAsync(workspaceId, typeof(Circle), AnalyzerSearchKinds.UsedBy));
		Assert.Contains("AnalyzerTarget.Exposer.Field : Circle", usedBy);
		Assert.Contains("AnalyzerTarget.Exposer.Make() : Circle", usedBy);
		Assert.Contains("Ellipse", usedBy);
		// The getter and the setter both use the type; the property is listed once.
		Assert.Single(usedBy, label => label == "AnalyzerTarget.Exposer.Property : Circle");
		// The type's own members are not uses of it.
		Assert.DoesNotContain(usedBy, label => label.StartsWith("AnalyzerTarget.Circle.", StringComparison.Ordinal));

		var exposedBy = Labels(await SearchAsync(workspaceId, typeof(Circle), AnalyzerSearchKinds.ExposedBy));
		Assert.Contains("AnalyzerTarget.Exposer.Field : Circle", exposedBy);
		Assert.Contains("AnalyzerTarget.Exposer.Property : Circle", exposedBy);
		Assert.Contains("AnalyzerTarget.Exposer.Make() : Circle", exposedBy);
		Assert.Contains("AnalyzerTarget.Consumer.FriendCalls.Hit(Circle) : void", exposedBy);

		Assert.Equal(["AnalyzerTarget.ShapeExtensions.Diameter(Circle) : double"], Labels(await SearchAsync(workspaceId, typeof(Circle), AnalyzerSearchKinds.ExtensionMethods)));
	}

	[Fact]
	public async Task FindsWhereAnAttributeIsAppliedAndWhatItsArgumentsAssign() {
		var workspaceId = await OpenAsync();
		var root = (await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), Token)).Nodes.Single(node => node.Label.StartsWith("AnalyzerTarget (", StringComparison.Ordinal));

		var appliedTo = await SearchAsync(workspaceId, typeof(MarkerAttribute), AnalyzerSearchKinds.AppliedTo);
		var assembly = Assert.Single(appliedTo, row => row.Kind == "assembly");
		Assert.Equal("AnalyzerTarget, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null", assembly.Label);
		Assert.Equal(root.Id, assembly.NodeId);
		Assert.False(assembly.HasChildren);
		Assert.Contains("Circle", Labels(appliedTo));
		Assert.Contains("AnalyzerTarget.Usage.Annotated() : void", Labels(appliedTo));

		// [Marker(Level = 1)] on Circle and [assembly: Marker(Level = 7)] call the setter by name. Only the
		// setter row's search looks for them — the flag the "set" row carries says so.
		var level = typeof(MarkerAttribute).GetProperty(nameof(MarkerAttribute.Level))!;
		var setter = Assert.Single(await ChildrenAsync(workspaceId, await NodeAsync(workspaceId, level)), row => row.Accessor == "set");
		var setterSearches = await ChildrenAsync(workspaceId, setter.NodeId!, isSetter: setter.IsSetter);
		var usedBy = Assert.Single(setterSearches, row => row.Search == AnalyzerSearchKinds.UsedBy);
		Assert.True(usedBy.IsSetter);
		var writes = (await manager.AnalyzeChildrenAsync(new AnalyzeChildrenRequest(workspaceId, usedBy.NodeId!, usedBy.Search, usedBy.IsSetter), Token)).Children;
		Assert.Equal(["AnalyzerTarget, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null", "Circle"], Labels(writes).Order(StringComparer.Ordinal));
		Assert.Empty((await manager.AnalyzeChildrenAsync(new AnalyzeChildrenRequest(workspaceId, usedBy.NodeId!, usedBy.Search), Token)).Children);

		Assert.Equal(["AnalyzerTarget.Usage.Annotated() : void"], Labels(await SearchAsync(workspaceId, typeof(MarkerAttribute).GetField(nameof(MarkerAttribute.Note))!, AnalyzerSearchKinds.AssignedBy)));
	}

	[Fact]
	public async Task FindsTheMethodsThatRaiseAnEvent() {
		var workspaceId = await OpenAsync();

		var raisedBy = Assert.Single(await SearchAsync(workspaceId, typeof(Shape).GetEvent(nameof(Shape.Changed))!, AnalyzerSearchKinds.RaisedBy));

		Assert.Equal("AnalyzerTarget.Shape.OnChanged() : void", raisedBy.Label);
		Assert.NotNull(raisedBy.Source?.IlOffset);
	}

	[Fact]
	public async Task FindsTheCallersOfADllImportByItsEntryPoint() {
		var workspaceId = await OpenAsync();

		Assert.Equal(["AnalyzerTarget.Usage.CallPid() : int"], Labels(await SearchAsync(workspaceId, Method(typeof(Usage), nameof(Usage.GetPid)), AnalyzerSearchKinds.UsedBy)));
	}

	[Fact]
	public async Task SearchesNoFurtherThanAMemberCanBeSeen() {
		var workspaceId = await OpenAsync();

		Assert.Equal(["AnalyzerTarget.Outer.Read() : int"], Labels(await SearchAsync(workspaceId, typeof(Outer).GetField("secret", AnyMember)!, AnalyzerSearchKinds.ReadBy)));
		var hidden = typeof(Outer).GetNestedType("Hidden", BindingFlags.NonPublic)!;
		Assert.Equal(["AnalyzerTarget.Outer.Use() : void"], Labels(await SearchAsync(workspaceId, Method(hidden, "Run"), AnalyzerSearchKinds.UsedBy)));
		// An internal member is seen from the assembly its InternalsVisibleTo names.
		Assert.Equal(["AnalyzerTarget.Consumer.FriendCalls.Hit(Circle) : void"], Labels(await SearchAsync(workspaceId, Method(typeof(Circle), "Hit"), AnalyzerSearchKinds.UsedBy)));
	}

	[Fact]
	public async Task FollowsAReferenceIntoTheFrameworkThroughItsFacade() {
		var workspaceId = await OpenAsync();

		// The fixture calls EventHandler.Invoke through System.Runtime, which forwards the type to the core
		// library: neither is open, so both are loaded the way dnSpy auto-loads an assembly.
		var invoke = Assert.Single(
			await SearchAsync(workspaceId, Method<Shape>("OnChanged"), AnalyzerSearchKinds.Uses),
			row => row.Label == "System.EventHandler.Invoke(object, EventArgs) : void");

		Assert.NotNull(invoke.NodeId);
		var target = Assert.Single(invoke.Source!.Targets);
		Assert.Null(target.NodeId);
		Assert.Equal(typeof(EventHandler).GetMethod(nameof(EventHandler.Invoke))!.MetadataToken, target.MetadataToken);
		Assert.Equal(typeof(EventHandler).Assembly.Location, target.ModulePath);
	}

	[Fact]
	public async Task StopsWhenTheRequestIsCanceled() {
		var workspaceId = await OpenAsync();
		var circle = await NodeAsync(workspaceId, typeof(Circle));

		await Assert.ThrowsAnyAsync<OperationCanceledException>(() => manager.AnalyzeChildrenAsync(
			new AnalyzeChildrenRequest(workspaceId, circle, AnalyzerSearchKinds.UsedBy), new CancellationToken(canceled: true)));
	}

	[Fact]
	public async Task StopsAtTheResultLimit() {
		var workspaceId = await OpenAsync();
		var circle = await NodeAsync(workspaceId, typeof(Circle));

		var response = await manager.AnalyzeChildrenAsync(new AnalyzeChildrenRequest(workspaceId, circle, AnalyzerSearchKinds.UsedBy, MaxResults: 1), Token);

		Assert.Single(response.Children);
		Assert.True(response.Truncated);
	}

	async Task<string> OpenAsync() {
		var target = typeof(Circle).Assembly.Location;
		var consumer = typeof(Ellipse).Assembly.Location;
		Assert.True(File.Exists(target) && File.Exists(consumer), "The analyzer fixtures were not copied to the test output.");
		return (await manager.OpenAsync(new OpenWorkspaceRequest([target, consumer]), Token)).WorkspaceId;
	}

	static MethodInfo Method<T>(string name) => Method(typeof(T), name);

	static MethodInfo Method(Type type, string name) => type.GetMethod(name, AnyMember)!;

	/// <summary>The tree node of a member, found the way a bookmark finds one: by its file and token.</summary>
	async Task<string> NodeAsync(string workspaceId, MemberInfo member) {
		var found = await manager.FindMemberAsync(new FindMemberRequest(workspaceId, member.Module.Assembly.Location, member.MetadataToken), Token);
		return found.NodeId ?? throw new InvalidOperationException($"No node for {member}.");
	}

	async Task<AnalyzerNodeDto> RootAsync(string workspaceId, MemberInfo member) {
		var nodeId = await NodeAsync(workspaceId, member);
		var row = Assert.Single((await manager.AnalyzeNodesAsync(new AnalyzeNodesRequest(workspaceId, [nodeId]), Token)).Nodes);
		return Assert.IsType<AnalyzerNodeDto>(row);
	}

	async Task<IReadOnlyList<AnalyzerNodeDto>> ChildrenAsync(string workspaceId, string nodeId, string? search = null, bool isSetter = false) =>
		(await manager.AnalyzeChildrenAsync(new AnalyzeChildrenRequest(workspaceId, nodeId, search, isSetter), Token)).Children;

	async Task<IReadOnlyList<string?>> SearchKeysAsync(string workspaceId, MemberInfo member) =>
		(await ChildrenAsync(workspaceId, await NodeAsync(workspaceId, member))).Select(row => row.Search).ToArray();

	async Task<IReadOnlyList<AnalyzerNodeDto>> SearchAsync(string workspaceId, MemberInfo member, string search) =>
		await ChildrenAsync(workspaceId, await NodeAsync(workspaceId, member), search);

	static IReadOnlyList<string> Labels(IEnumerable<AnalyzerNodeDto> rows) => rows.Select(row => row.Label).ToArray();

	public void Dispose() => manager.Dispose();
}
