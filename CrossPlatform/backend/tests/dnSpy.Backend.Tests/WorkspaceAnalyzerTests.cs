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
	// Every search here runs a type per slice, with the gate let go in between, and sends a batch after every
	// slice that found something: the cut-up run has to come to what one pass over the modules would.
	readonly WorkspaceManager manager = new() { AnalyzerSliceBudget = TimeSpan.Zero, AnalyzerProgressInterval = TimeSpan.Zero };

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
		// A type row wears the image of dnSpy's own set its kind and visibility pick (DotNetImageService).
		Assert.Equal("ClassPublic", (await RootAsync(workspaceId, typeof(Circle))).Icon);
		Assert.Equal("InterfacePublic", (await RootAsync(workspaceId, typeof(IShape))).Icon);
	}

	[Fact]
	public async Task WritesRowsThroughTheDecompilerThatIsSelected() {
		var workspaceId = await OpenAsync();
		async Task<string> LabelAsync(MemberInfo member, DecompilerLanguage language) =>
			Assert.IsType<AnalyzerNodeDto>(Assert.Single((await manager.AnalyzeNodesAsync(new AnalyzeNodesRequest(workspaceId, [await NodeAsync(workspaceId, member)], language), Token)).Nodes)).Label;

		// The VB decompiler writes the C# conversion of a type the VB way, and keeps the base FormatPropertyName,
		// which names an indexer by its metadata name.
		Assert.Equal("Box(Of T)", await LabelAsync(typeof(Box<>), DecompilerLanguage.VisualBasic));
		Assert.Equal("AnalyzerTarget.Circle.Area() : Double", await LabelAsync(Method<Circle>(nameof(Circle.Area)), DecompilerLanguage.VisualBasic));
		Assert.Equal("AnalyzerTarget.Circle.Circle(Double) : Void", await LabelAsync(typeof(Circle).GetConstructors()[0], DecompilerLanguage.VisualBasic));
		Assert.Equal("AnalyzerTarget.Circle.Name : String", await LabelAsync(typeof(Circle).GetProperty(nameof(Circle.Name), AnyMember)!, DecompilerLanguage.VisualBasic));
		Assert.Equal("AnalyzerTarget.Box(Of T).Item : T", await LabelAsync(typeof(Box<>).GetProperty("Item")!, DecompilerLanguage.VisualBasic));
		Assert.Equal("AnalyzerTarget.Usage.Indexed(Box(Of String)) : String", await LabelAsync(Method(typeof(Usage), nameof(Usage.Indexed)), DecompilerLanguage.VisualBasic));
		Assert.Equal("AnalyzerTarget.Usage.Lambda(Circle) : Func(Of Double)", await LabelAsync(Method(typeof(Usage), nameof(Usage.Lambda)), DecompilerLanguage.VisualBasic));

		// The IL decompiler: keywords of its own, a type row and a declaring type with the arity in the name, a
		// generic instance in signature syntax, a generic parameter by "!".
		foreach (var language in new[] { DecompilerLanguage.IL, DecompilerLanguage.ILWithCSharp }) {
			Assert.Equal("Box`1", await LabelAsync(typeof(Box<>), language));
			Assert.Equal("AnalyzerTarget.Circle.Area() : float64", await LabelAsync(Method<Circle>(nameof(Circle.Area)), language));
			Assert.Equal("AnalyzerTarget.Circle.Circle(float64) : void", await LabelAsync(typeof(Circle).GetConstructors()[0], language));
			Assert.Equal("AnalyzerTarget.Shape.Changed : EventHandler", await LabelAsync(typeof(Shape).GetEvent(nameof(Shape.Changed))!, language));
			Assert.Equal("AnalyzerTarget.Box`1.Item : !T", await LabelAsync(typeof(Box<>).GetProperty("Item")!, language));
			Assert.Equal("AnalyzerTarget.Usage.Indexed(class AnalyzerTarget.Box`1<string>) : string", await LabelAsync(Method(typeof(Usage), nameof(Usage.Indexed)), language));
			Assert.Equal("AnalyzerTarget.Consumer.FriendCalls.Hit(Circle) : void", await LabelAsync(Method(typeof(FriendCalls), nameof(FriendCalls.Hit)), language));
		}

		var indexed = await manager.AnalyzeNodesAsync(new AnalyzeNodesRequest(workspaceId, [await NodeAsync(workspaceId, Method(typeof(Usage), nameof(Usage.Indexed)))], DecompilerLanguage.IL), Token);
		var parts = Parts(Assert.IsType<AnalyzerNodeDto>(Assert.Single(indexed.Nodes)));
		Assert.Contains(("class", "keyword"), parts);
		Assert.Contains(("Box`1", "type"), parts);
		Assert.Contains(("string", "keyword"), parts);

		// A search writes what it finds in the language it was asked in, too.
		var circle = await NodeAsync(workspaceId, typeof(Circle));
		var exposedBy = (await manager.AnalyzeChildrenAsync(new AnalyzeChildrenRequest(workspaceId, circle, AnalyzerSearchKinds.ExposedBy, Language: DecompilerLanguage.VisualBasic), Token)).Children;
		Assert.Contains("AnalyzerTarget.Exposer.Make() : Circle", Labels(exposedBy));
		Assert.Contains("AnalyzerTarget.Exposer.Field : Circle", Labels(exposedBy));
	}

	[Fact]
	public async Task ListsTheLambdaItselfUnlessTheCSharpDecompilerShowsWhereItWasWritten() {
		var workspaceId = await OpenAsync();
		var area = await NodeAsync(workspaceId, Method<Circle>(nameof(Circle.Area)));
		async Task<IReadOnlyList<AnalyzerNodeDto>> UsedByAsync(DecompilerLanguage language, bool anonymousMethods) =>
			(await manager.AnalyzeChildrenAsync(new AnalyzeChildrenRequest(workspaceId, area, AnalyzerSearchKinds.UsedBy, Language: language, DecompileAnonymousMethods: anonymousMethods), Token)).Children;

		Assert.Contains("AnalyzerTarget.Usage.Lambda(Circle) : Func<double>", Labels(await UsedByAsync(DecompilerLanguage.CSharp, true)));

		// Any other decompiler, or C# with anonymous methods off, lists the compiler's method, with the place in
		// its body the call is at.
		foreach (var (language, anonymousMethods) in new[] { (DecompilerLanguage.CSharp, false), (DecompilerLanguage.VisualBasic, true), (DecompilerLanguage.IL, true) }) {
			var rows = await UsedByAsync(language, anonymousMethods);
			Assert.DoesNotContain(rows, row => row.Label.StartsWith("AnalyzerTarget.Usage.Lambda(", StringComparison.Ordinal));
			var lambda = Assert.Single(rows, row => row.Label.Contains("<Lambda>b__", StringComparison.Ordinal));
			Assert.NotNull(lambda.Source?.IlOffset);
		}
		Assert.Contains(await UsedByAsync(DecompilerLanguage.IL, true), row => row.Label.StartsWith("AnalyzerTarget.Usage/'<>c__DisplayClass", StringComparison.Ordinal));
	}

	[Fact]
	public async Task PutsAReferenceSpanOnWhatAnIlInstructionNames() {
		var workspaceId = await OpenAsync();
		var sum = Method(typeof(Usage), nameof(Usage.Sum));

		var document = await manager.DecompileAsync(new DecompileRequest(workspaceId, await NodeAsync(workspaceId, sum), DecompilerLanguage.IL), Token);

		// "callvirt System.Double AnalyzerTarget.Shape::Area()": the span covers the method's name and names the
		// target the analyzer's result for the call carries, so "Show Reference in Method" lands on it.
		var shapeArea = await NodeAsync(workspaceId, Method<Shape>(nameof(Shape.Area)));
		var reference = Assert.Single(document.Spans, span => span.Kind == "reference" && span.TargetNodeId == shapeArea);
		Assert.Equal("Area", document.Text.Substring(reference.Start, reference.Length));
		var row = Assert.Single(await SearchAsync(workspaceId, Method<Circle>(nameof(Circle.Area)), AnalyzerSearchKinds.UsedBy), row => row.Label == "AnalyzerTarget.Usage.Sum(Shape) : double");
		Assert.Contains(row.Source!.Targets, target => target.NodeId == reference.TargetNodeId);
		var statement = Assert.Single(document.CodeStatements!, statement => statement.IlOffset == row.Source.IlOffset);
		var line = document.Text.Split('\n')[statement.StartLine - 1];
		Assert.Contains("callvirt", line, StringComparison.Ordinal);
		Assert.Equal(1 + document.Text[..reference.Start].Count(ch => ch == '\n'), statement.StartLine);
	}

	[Fact]
	public async Task CutsARowsLabelWhereSyntaxHighlightingChangesColor() {
		var workspaceId = await OpenAsync();

		var total = await RootAsync(workspaceId, Method(typeof(Usage), nameof(Usage.Total)));
		Assert.Equal(total.Label, string.Concat(total.LabelParts!.Select(part => part.Text)));
		Assert.Equal([
			("AnalyzerTarget", "namespace"), (".", "operator"), ("Usage", "staticType"), (".", "operator"), ("Total", "staticMethod"),
			("(", "punctuation"), ("IShape", "interface"), (")", "punctuation"), (" ", "text"), (":", "punctuation"), (" ", "text"), ("double", "keyword"),
		], Parts(total));
		Assert.Equal([("Box", "type"), ("<", "punctuation"), ("T", "typeGenericParameter"), (">", "punctuation")], Parts(await RootAsync(workspaceId, typeof(Box<>))));
		Assert.Equal("instanceField", Assert.Single(Parts(await RootAsync(workspaceId, typeof(Circle).GetField(nameof(Circle.Radius))!)), part => part.Text == "Radius").Color);
		Assert.Equal("literalField", Assert.Single(Parts(await RootAsync(workspaceId, typeof(Circle).GetField(nameof(Circle.Pi))!)), part => part.Text == "Pi").Color);
		// An accessor row is its keyword alone.
		var getter = (await ChildrenAsync(workspaceId, await NodeAsync(workspaceId, typeof(Circle).GetProperty(nameof(Circle.Name), AnyMember)!)))[0];
		Assert.Equal([("get", "keyword")], Parts(getter));
		// A search row's header is the client's to translate, and carries none.
		Assert.Null(Assert.Single(await ChildrenAsync(workspaceId, await NodeAsync(workspaceId, typeof(Circle).GetField(nameof(Circle.Pi))!))).LabelParts);
	}

	[Fact]
	public async Task CutsATreeRowsTextWhereSyntaxHighlightingChangesColor() {
		var workspaceId = await OpenAsync();

		var total = await manager.GetNodeAsync(new NodeRequest(workspaceId, await NodeAsync(workspaceId, Method(typeof(Usage), nameof(Usage.Total)))), Token);
		Assert.Equal([("Total", "staticMethod"), ("(", "punctuation"), ("IShape", "interface"), (")", "punctuation")], total.LabelParts!.Select(part => (part.Text, part.Color)));
		Assert.Equal([("double", "keyword")], total.ReturnTypeParts!.Select(part => (part.Text, part.Color)));
		var root = (await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), Token)).Nodes.Single(node => node.Kind == "assembly" && node.Label == "AnalyzerTarget");
		Assert.Equal([("AnalyzerTarget", "assembly"), (" ", "text"), ("(", "punctuation"), ("1.0.0.0", "number"), (")", "punctuation")], root.LabelParts!.Select(part => (part.Text, part.Color)));
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
		var root = (await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), Token)).Nodes.Single(node => node.Kind == "assembly" && node.Label == "AnalyzerTarget");

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
		// The decompiler's resolver takes the lowest installed patch of the fixture's net10.0, which is not the
		// runtime this test runs on when a machine has several: the core library is that install's, and the
		// token is the one its own copy of EventHandler.Invoke has.
		Assert.Equal("System.Private.CoreLib.dll", Path.GetFileName(target.ModulePath));
		var frameworkDirectory = Path.GetDirectoryName(target.ModulePath)!;
		Assert.Equal("Microsoft.NETCore.App", Path.GetFileName(Path.GetDirectoryName(frameworkDirectory)));
		var frameworkVersion = Version.Parse(Path.GetFileName(frameworkDirectory));
		Assert.Equal((Environment.Version.Major, Environment.Version.Minor), (frameworkVersion.Major, frameworkVersion.Minor));
		using var coreLib = dnlib.DotNet.ModuleDefMD.Load(target.ModulePath!);
		Assert.Equal(coreLib.Find("System.EventHandler", isReflectionName: false)!.FindMethod("Invoke")!.MDToken.ToInt32(), target.MetadataToken);
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
		// dnSpy's searches have no limit of their own, and neither does one asked without.
		var unlimited = await manager.AnalyzeChildrenAsync(new AnalyzeChildrenRequest(workspaceId, circle, AnalyzerSearchKinds.UsedBy), Token);
		Assert.False(unlimited.Truncated);
		Assert.True(unlimited.Children.Count > 1);
	}

	[Fact]
	public async Task SendsWhatASearchFindsAheadOfItsAnswer() {
		var workspaceId = await OpenAsync();
		var circle = await NodeAsync(workspaceId, typeof(Circle));
		var whole = (await manager.AnalyzeChildrenAsync(new AnalyzeChildrenRequest(workspaceId, circle, AnalyzerSearchKinds.UsedBy), Token)).Children;

		var batches = new List<AnalyzeProgressNotification>();
		var response = await manager.AnalyzeChildrenAsync(
			new AnalyzeChildrenRequest(workspaceId, circle, AnalyzerSearchKinds.UsedBy, ProgressToken: "circle-used-by"),
			progress => {
				batches.Add(progress);
				return Task.CompletedTask;
			},
			Token);

		Assert.True(batches.Count > 1, $"Expected the search to send several batches, got {batches.Count}.");
		Assert.All(batches, batch => Assert.Equal("circle-used-by", batch.ProgressToken));
		// Each batch starts where the one before it ended, and the answer where the last one did; together
		// they are what the search finds in one go, in the same order.
		var position = 0;
		foreach (var batch in batches) {
			Assert.Equal(position, batch.Start);
			Assert.NotEmpty(batch.Children);
			position += batch.Children.Count;
		}
		Assert.Equal(position, response.Start);
		Assert.Equal(Labels(whole), Labels(batches.SelectMany(batch => batch.Children).Concat(response.Children)));

		// What a search only knows once every type was seen — the assembly [Marker] is applied to — comes in
		// the answer, after everything sent ahead.
		var marker = await NodeAsync(workspaceId, typeof(MarkerAttribute));
		var markerBatches = 0;
		var markerResponse = await manager.AnalyzeChildrenAsync(
			new AnalyzeChildrenRequest(workspaceId, marker, AnalyzerSearchKinds.UsedBy, ProgressToken: "marker-used-by"),
			_ => {
				markerBatches++;
				return Task.CompletedTask;
			},
			Token);
		Assert.True(markerBatches > 0);
		Assert.Equal("assembly", markerResponse.Children[^1].Kind);
	}

	[Fact]
	public async Task SendsNothingAheadWithoutAProgressToken() {
		var workspaceId = await OpenAsync();
		var circle = await NodeAsync(workspaceId, typeof(Circle));
		var sent = 0;

		var response = await manager.AnalyzeChildrenAsync(
			new AnalyzeChildrenRequest(workspaceId, circle, AnalyzerSearchKinds.UsedBy),
			_ => {
				sent++;
				return Task.CompletedTask;
			},
			Token);

		Assert.Equal(0, sent);
		Assert.Equal(0, response.Start);
		Assert.NotEmpty(response.Children);
	}

	[Fact]
	public async Task FindsTheSameRowsInTheSameOrderOnOneThreadAsOnMany() {
		using var oneThread = new WorkspaceManager { AnalyzerParallelism = 1 };
		using var manyThreads = new WorkspaceManager { AnalyzerParallelism = 8, AnalyzerSliceBudget = TimeSpan.Zero };
		// Two assemblies big enough for a batch of types to be spread over the threads, the second using the
		// first all over: the searches that drop duplicates — a type's, a method body's — are the ones a
		// thread finishing out of turn would upset.
		string[] paths = [typeof(HelloRequest).Assembly.Location, typeof(WorkspaceManager).Assembly.Location];
		(MemberInfo Member, string Search)[] searches = [
			(typeof(RpcException), AnalyzerSearchKinds.UsedBy),
			(typeof(RpcException), AnalyzerSearchKinds.InstantiatedBy),
			(typeof(TreeNodeDto), AnalyzerSearchKinds.UsedBy),
			(typeof(TreeNodeDto).GetConstructors().Single(), AnalyzerSearchKinds.UsedBy),
			(typeof(TreeNodeDto).GetProperty(nameof(TreeNodeDto.Label))!.GetMethod!, AnalyzerSearchKinds.UsedBy),
		];

		async Task<IReadOnlyList<string>> RunAsync(WorkspaceManager on, MemberInfo member, string search) {
			var workspaceId = (await on.OpenAsync(new OpenWorkspaceRequest(paths), Token)).WorkspaceId;
			var nodeId = (await on.FindMemberAsync(new FindMemberRequest(workspaceId, member.Module.Assembly.Location, member.MetadataToken), Token)).NodeId!;
			var rows = (await on.AnalyzeChildrenAsync(new AnalyzeChildrenRequest(workspaceId, nodeId, search), Token)).Children;
			on.Close(new WorkspaceRequest(workspaceId));
			return rows.Select(row => $"{row.Label} {row.Source?.IlOffset}").ToArray();
		}

		foreach (var (member, search) in searches) {
			var expected = await RunAsync(oneThread, member, search);
			Assert.True(expected.Count > 0, $"{member.Name} {search} found nothing.");
			Assert.Equal(expected, await RunAsync(manyThreads, member, search));
		}
	}

	[Fact]
	public async Task GivesUpWhenAnEditLandsBetweenTheSlicesOfASearch() {
		var workspaceId = await OpenAsync();
		var circle = await NodeAsync(workspaceId, typeof(Circle));
		var describe = await NodeAsync(workspaceId, Method<Circle>(nameof(Circle.Describe)));
		var edited = false;

		var exception = await Assert.ThrowsAsync<RpcException>(() => manager.AnalyzeChildrenAsync(
			new AnalyzeChildrenRequest(workspaceId, circle, AnalyzerSearchKinds.UsedBy, ProgressToken: "edited"),
			async _ => {
				if (edited)
					return;
				edited = true;
				// The search let the gate go to send its first batch, which is when an edit can get in.
				var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), Token);
				await manager.QueueRenameAsync(new RenameEditRequest(workspaceId, transaction.TransactionId, describe, "Portray"), Token);
				await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), Token);
			},
			Token));

		Assert.True(edited);
		Assert.Equal(ErrorCodes.EditConflict, exception.Code);
		// The model the search was looking at is gone; a search started now runs against the edited one.
		Assert.NotEmpty((await manager.AnalyzeChildrenAsync(new AnalyzeChildrenRequest(workspaceId, circle, AnalyzerSearchKinds.UsedBy), Token)).Children);
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

	static IReadOnlyList<(string Text, string Color)> Parts(AnalyzerNodeDto row) => row.LabelParts!.Select(part => (part.Text, part.Color)).ToArray();

	public void Dispose() => manager.Dispose();
}
