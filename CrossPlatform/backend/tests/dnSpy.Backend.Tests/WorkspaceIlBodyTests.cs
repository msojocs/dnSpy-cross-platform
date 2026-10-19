using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// A method the IL editor tests read: two locals and a catch clause, so the editor's three lists all
/// have something in them.
/// </summary>
static class IlBodyFixture {
	public static int WithLocalsAndHandler(int value) {
		try {
			var doubled = value * 2;
			var tripled = doubled + value;
			if (tripled > 100)
				throw new InvalidOperationException("too large");
			return tripled;
		}
		catch (InvalidOperationException) {
			return -1;
		}
	}
}

public sealed class WorkspaceIlBodyTests : IDisposable {
	readonly WorkspaceManager manager = new();

	[Fact]
	public async Task ReadsTheLocalsAndExceptionHandlersOfABody() {
		var opened = await OpenAsync();
		var method = await FindFixtureMethodAsync(opened.WorkspaceId, nameof(IlBodyFixture.WithLocalsAndHandler));

		var body = await manager.GetIlBodyAsync(
			new GetIlBodyRequest(opened.WorkspaceId, method.Id),
			TestContext.Current.CancellationToken);

		Assert.Equal(IlBodyTypes.Cil, body.BodyType);
		Assert.Equal((int)dnlib.DotNet.MethodImplAttributes.IL, body.CodeType);
		Assert.True(body.MaxStack > 0);
		Assert.True(body.Locals.Count >= 2, $"Expected the two locals of the fixture, got {body.Locals.Count}.");
		Assert.All(body.Locals, local => Assert.NotNull(local.Type));
		Assert.Contains(body.Instructions, instruction => instruction.OpCode == "ret");
		Assert.Contains(body.Instructions, instruction => instruction.OperandKind == IlOperandKinds.Local || instruction.OpCode.StartsWith("ldloc", StringComparison.Ordinal) || instruction.OpCode.StartsWith("stloc", StringComparison.Ordinal));
		Assert.Equal("value", body.ParameterNames[0]);
		var handler = Assert.Single(body.ExceptionHandlers);
		Assert.Equal("catch", handler.HandlerType);
		Assert.NotNull(handler.TryStart);
		Assert.NotNull(handler.HandlerStart);
		Assert.NotNull(handler.CatchType);
		Assert.Contains("InvalidOperationException", handler.CatchType!.Display, StringComparison.Ordinal);
		// Every position a handler names is one of the instruction labels.
		var labels = body.Instructions.Select(instruction => instruction.Label).ToHashSet(StringComparer.Ordinal);
		Assert.Contains(handler.TryStart!, labels);
		Assert.Contains(handler.HandlerStart!, labels);
	}

	[Fact]
	public async Task WritesAnEditedBodyBackWithItsExceptionHandler() {
		var opened = await OpenAsync();
		var method = await FindFixtureMethodAsync(opened.WorkspaceId, nameof(IlBodyFixture.WithLocalsAndHandler));
		var body = await manager.GetIlBodyAsync(new GetIlBodyRequest(opened.WorkspaceId, method.Id), TestContext.Current.CancellationToken);

		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.QueueIlBodyAsync(
			ToReplaceRequest(opened.WorkspaceId, transaction.TransactionId, method.Id, body),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(
			new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId),
			TestContext.Current.CancellationToken);

		var reread = await manager.GetIlBodyAsync(new GetIlBodyRequest(opened.WorkspaceId, method.Id), TestContext.Current.CancellationToken);
		Assert.Equal(body.Locals.Count, reread.Locals.Count);
		Assert.Equal(body.ExceptionHandlers.Count, reread.ExceptionHandlers.Count);
		Assert.Equal(body.Instructions.Count, reread.Instructions.Count);
		var decompiled = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, method.Id, DecompilerLanguage.CSharp),
			TestContext.Current.CancellationToken);
		Assert.True(decompiled.Text.Contains("catch", StringComparison.Ordinal), decompiled.Text);

		// Undo puts the original body back and the module is readable again.
		await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		var undone = await manager.GetIlBodyAsync(new GetIlBodyRequest(opened.WorkspaceId, method.Id), TestContext.Current.CancellationToken);
		Assert.Equal(IlBodyTypes.Cil, undone.BodyType);
		Assert.Single(undone.ExceptionHandlers);
	}

	[Fact]
	public async Task AddsABodyToAMethodThatHasNone() {
		var opened = await manager.OpenAsync(
			new OpenWorkspaceRequest([typeof(dnSpy.Backend.Contracts.HelloRequest).Assembly.Location]),
			TestContext.Current.CancellationToken);
		var method = await FindMethodAsync(opened.WorkspaceId, "dnSpy.Backend.Contracts", "IDebugSourceProvider", "GetMethodSourceAsync");
		var before = await manager.GetIlBodyAsync(new GetIlBodyRequest(opened.WorkspaceId, method.Id), TestContext.Current.CancellationToken);
		Assert.Equal(IlBodyTypes.None, before.BodyType);
		Assert.Empty(before.Instructions);

		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.QueueIlBodyAsync(
			new ReplaceIlBodyRequest(
				opened.WorkspaceId,
				transaction.TransactionId,
				method.Id,
				IlBodyTypes.Cil,
				(int)dnlib.DotNet.MethodImplAttributes.IL,
				1,
				false,
				true,
				0,
				[],
				[
					new IlBodyInstructionDto("L0", "ldnull", IlOperandKinds.None),
					new IlBodyInstructionDto("L1", "ret", IlOperandKinds.None),
				],
				[],
				0),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(
			new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId),
			TestContext.Current.CancellationToken);

		var after = await manager.GetIlBodyAsync(new GetIlBodyRequest(opened.WorkspaceId, method.Id), TestContext.Current.CancellationToken);
		Assert.Equal(IlBodyTypes.Cil, after.BodyType);
		Assert.Equal(2, after.Instructions.Count);
		// The C# text is still the interface declaration — ILSpy writes an interface member without a body —
		// so the new body is read back through the IL view, which shows what the method now holds.
		var decompiled = await manager.DecompileAsync(
			new DecompileRequest(opened.WorkspaceId, method.Id, DecompilerLanguage.IL),
			TestContext.Current.CancellationToken);
		Assert.Contains("ldnull", decompiled.Text, StringComparison.Ordinal);
	}

	[Fact]
	public async Task RemovesABodyAndUndoRestoresIt() {
		var opened = await OpenAsync();
		var method = await FindFixtureMethodAsync(opened.WorkspaceId, nameof(IlBodyFixture.WithLocalsAndHandler));
		var original = await manager.GetIlBodyAsync(new GetIlBodyRequest(opened.WorkspaceId, method.Id), TestContext.Current.CancellationToken);

		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.QueueIlBodyAsync(
			ToReplaceRequest(opened.WorkspaceId, transaction.TransactionId, method.Id, original) with { BodyType = IlBodyTypes.None },
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(
			new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId),
			TestContext.Current.CancellationToken);

		var removed = await manager.GetIlBodyAsync(new GetIlBodyRequest(opened.WorkspaceId, method.Id), TestContext.Current.CancellationToken);
		Assert.Equal(IlBodyTypes.None, removed.BodyType);

		await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		var restored = await manager.GetIlBodyAsync(new GetIlBodyRequest(opened.WorkspaceId, method.Id), TestContext.Current.CancellationToken);
		Assert.Equal(IlBodyTypes.Cil, restored.BodyType);
		Assert.Equal(original.Instructions.Count, restored.Instructions.Count);
	}

	[Fact]
	public async Task RunsTheSimplifyAndOptimizeCommands() {
		var opened = await OpenAsync();
		var method = await FindFixtureMethodAsync(opened.WorkspaceId, nameof(IlBodyFixture.WithLocalsAndHandler));
		IlBodyInstructionDto[] instructions = [
			new("L0", "ldc.i4.2", IlOperandKinds.None),
			new("L1", "ldloc.0", IlOperandKinds.None),
			new("L2", "stloc.1", IlOperandKinds.None),
			new("L3", "ldarg.1", IlOperandKinds.None),
			new("L4", "ret", IlOperandKinds.None),
		];

		var simplified = await manager.TransformIlBodyAsync(
			new TransformIlBodyRequest(opened.WorkspaceId, method.Id, IlTransformOperations.SimplifyAll, [], instructions, [], ["value"]),
			TestContext.Current.CancellationToken);
		Assert.Equal("ldc.i4", simplified.Instructions[0].OpCode);
		Assert.Equal("2", simplified.Instructions[0].Operand);
		Assert.Equal("ldloc", simplified.Instructions[1].OpCode);
		Assert.Equal("stloc", simplified.Instructions[2].OpCode);
		Assert.Equal(IlOperandKinds.Local, simplified.Instructions[2].OperandKind);
		Assert.Equal("ldarg", simplified.Instructions[3].OpCode);
		Assert.Equal(IlOperandKinds.Argument, simplified.Instructions[3].OperandKind);

		var optimized = await manager.TransformIlBodyAsync(
			new TransformIlBodyRequest(opened.WorkspaceId, method.Id, IlTransformOperations.OptimizeAll, [], simplified.Instructions, [], ["value"]),
			TestContext.Current.CancellationToken);
		Assert.Equal("ldc.i4.2", optimized.Instructions[0].OpCode);
		Assert.Equal("ldloc.0", optimized.Instructions[1].OpCode);
		Assert.Equal("stloc.1", optimized.Instructions[2].OpCode);
		Assert.Equal("ldarg.1", optimized.Instructions[3].OpCode);
	}

	[Fact]
	public async Task RunsTheBranchAndNopCommands() {
		var opened = await OpenAsync();
		var method = await FindFixtureMethodAsync(opened.WorkspaceId, nameof(IlBodyFixture.WithLocalsAndHandler));
		IlBodyInstructionDto[] instructions = [
			new("L0", "ldc.i4.1", IlOperandKinds.None),
			new("L1", "brfalse", IlOperandKinds.Branch, "L3", "L3"),
			new("L2", "ret", IlOperandKinds.None),
			new("L3", "ret", IlOperandKinds.None),
		];

		var inverted = await manager.TransformIlBodyAsync(
			new TransformIlBodyRequest(opened.WorkspaceId, method.Id, IlTransformOperations.InvertBranch, [], instructions, [1], ["value"]),
			TestContext.Current.CancellationToken);
		Assert.Equal("brtrue", inverted.Instructions[1].OpCode);
		Assert.Equal("L3", inverted.Instructions[1].Operand);

		var converted = await manager.TransformIlBodyAsync(
			new TransformIlBodyRequest(opened.WorkspaceId, method.Id, IlTransformOperations.ConvertBranchToUnconditional, [], instructions, [1], ["value"]),
			TestContext.Current.CancellationToken);
		Assert.Equal("pop", converted.Instructions[1].OpCode);
		Assert.Equal("br", converted.Instructions[2].OpCode);
		Assert.Equal("L3", converted.Instructions[2].Operand);

		var nopped = await manager.TransformIlBodyAsync(
			new TransformIlBodyRequest(opened.WorkspaceId, method.Id, IlTransformOperations.ReplaceWithNop, [], instructions, [0, 2], ["value"]),
			TestContext.Current.CancellationToken);
		Assert.Equal("nop", nopped.Instructions[0].OpCode);
		Assert.Equal("nop", nopped.Instructions[2].OpCode);
		Assert.Null(nopped.Instructions[0].Operand);
	}

	[Fact]
	public async Task RemovingAnInstructionPushesADefaultValueInItsPlace() {
		var opened = await OpenAsync();
		var method = await FindFixtureMethodAsync(opened.WorkspaceId, nameof(IlBodyFixture.WithLocalsAndHandler));
		var stringType = new TypeSigDto(TypeSigKinds.Type, new TypeRefDto("System.Runtime", "System", "String"));
		var toString = new MethodRefDto(stringType, "ToString", new MethodSigDto((int)dnlib.DotNet.CallingConvention.HasThis, stringType, []));
		IlBodyInstructionDto[] instructions = [
			new("L0", "ldstr", IlOperandKinds.String, "text", "text"),
			new("L1", "call", IlOperandKinds.Method, MethodRef: toString),
			new("L2", "pop", IlOperandKinds.None),
			new("L3", "ret", IlOperandKinds.None),
		];

		var result = await manager.TransformIlBodyAsync(
			new TransformIlBodyRequest(opened.WorkspaceId, method.Id, IlTransformOperations.RemoveAndAddPops, [], instructions, [1], ["value"]),
			TestContext.Current.CancellationToken);
		// The call pops its instance and pushes a string, so it becomes a pop and the default string.
		Assert.Equal("pop", result.Instructions[1].OpCode);
		Assert.Equal("ldnull", result.Instructions[2].OpCode);
		Assert.Equal(5, result.Instructions.Count);

		// dnSpy has no command for an instruction whose pushed value it cannot name — ldstr is one.
		var untouched = await manager.TransformIlBodyAsync(
			new TransformIlBodyRequest(opened.WorkspaceId, method.Id, IlTransformOperations.RemoveAndAddPops, [], instructions, [0], ["value"]),
			TestContext.Current.CancellationToken);
		Assert.Equal("ldstr", untouched.Instructions[0].OpCode);
	}

	async Task<OpenWorkspaceResponse> OpenAsync() => await manager.OpenAsync(
		new OpenWorkspaceRequest([typeof(IlBodyFixture).Assembly.Location]),
		TestContext.Current.CancellationToken);

	[Fact]
	public async Task AnInstructionPastedFromAnotherModuleHasWhatItNamesImported() {
		var opened = await manager.OpenAsync(
			new OpenWorkspaceRequest([typeof(IlBodyFixture).Assembly.Location, typeof(SearchTarget.Library).Assembly.Location]),
			TestContext.Current.CancellationToken);
		var source = await FindMethodInRootAsync(opened.WorkspaceId, typeof(IlBodyFixture).Assembly.Location, typeof(IlBodyFixture).Namespace!, nameof(IlBodyFixture), nameof(IlBodyFixture.WithLocalsAndHandler) + "(");
		var sourceBody = await manager.GetIlBodyAsync(new GetIlBodyRequest(opened.WorkspaceId, source.Id), TestContext.Current.CancellationToken);
		// `new InvalidOperationException("too large")`: a MemberRef of this test assembly, by its token there.
		var newobj = Assert.Single(sourceBody.Instructions, instruction => instruction.OpCode == "newobj");
		Assert.Equal(source.Id, newobj.TokenOwnerNodeId);
		Assert.NotNull(newobj.MemberRef);

		var target = await FindMethodInRootAsync(opened.WorkspaceId, typeof(SearchTarget.Library).Assembly.Location, "SearchTarget", "Library", "Ratio(");
		var targetBody = await manager.GetIlBodyAsync(new GetIlBodyRequest(opened.WorkspaceId, target.Id), TestContext.Current.CancellationToken);
		var pasted = targetBody with {
			Locals = [],
			ExceptionHandlers = [],
			Instructions = [
				new IlBodyInstructionDto("L0", "ldstr", IlOperandKinds.String, "pasted"),
				newobj with { Label = "L1" },
				new IlBodyInstructionDto("L2", "throw", IlOperandKinds.None),
			],
		};
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.QueueIlBodyAsync(ToReplaceRequest(opened.WorkspaceId, transaction.TransactionId, target.Id, pasted), TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var reread = await manager.GetIlBodyAsync(new GetIlBodyRequest(opened.WorkspaceId, target.Id), TestContext.Current.CancellationToken);
		var imported = Assert.Single(reread.Instructions, instruction => instruction.OpCode == "newobj");
		Assert.Contains("System.InvalidOperationException::.ctor(System.String)", imported.OperandDisplay, StringComparison.Ordinal);
		Assert.Equal(target.Id, imported.TokenOwnerNodeId);
	}

	[Fact]
	public async Task TheOperandDialogsMemberRefIsWrittenAsANewReference() {
		var opened = await OpenAsync();
		var method = await FindFixtureMethodAsync(opened.WorkspaceId, nameof(IlBodyFixture.WithLocalsAndHandler));
		var body = await manager.GetIlBodyAsync(new GetIlBodyRequest(opened.WorkspaceId, method.Id), TestContext.Current.CancellationToken);
		var newobj = Assert.Single(body.Instructions, instruction => instruction.OpCode == "newobj");
		var memberRef = newobj.MemberRef!;
		Assert.False(memberRef.IsField);
		Assert.Equal(".ctor", memberRef.Name);
		Assert.Equal(MemberRefParentKinds.Type, memberRef.Class!.Kind);
		// What the dialog hands back: the reference rebuilt from its class, name and signature, with no token.
		var edited = body with {
			Instructions = body.Instructions.Select(instruction => instruction.Label == newobj.Label
				? instruction with { Token = null, NodeId = null, TokenOwnerNodeId = null, MemberRef = memberRef }
				: instruction).ToArray(),
		};
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.QueueIlBodyAsync(ToReplaceRequest(opened.WorkspaceId, transaction.TransactionId, method.Id, edited), TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var reread = await manager.GetIlBodyAsync(new GetIlBodyRequest(opened.WorkspaceId, method.Id), TestContext.Current.CancellationToken);
		var rebuilt = Assert.Single(reread.Instructions, instruction => instruction.OpCode == "newobj");
		Assert.Equal(".ctor", rebuilt.MemberRef?.Name);
		Assert.Contains("InvalidOperationException", rebuilt.MemberRef?.Class?.Display, StringComparison.Ordinal);
		Assert.NotEqual(newobj.Token, rebuilt.Token);
	}

	[Fact]
	public async Task CopiesTheBytesOfInstructionsFromTheFileUntilTheBodyIsEdited() {
		var opened = await OpenAsync();
		var method = await FindFixtureMethodAsync(opened.WorkspaceId, nameof(IlBodyFixture.WithLocalsAndHandler));
		var body = await manager.GetIlBodyAsync(new GetIlBodyRequest(opened.WorkspaceId, method.Id), TestContext.Current.CancellationToken);
		var path = typeof(IlBodyFixture).Assembly.Location;
		var token = Convert.ToInt32(method.MetadataToken!.Value);
		var ldstr = Assert.Single(body.Instructions, instruction => instruction.OpCode == "ldstr");
		var ldstrOffset = Convert.ToInt32(ldstr.Label[3..], 16);

		var original = await manager.GetIlBytesAsync(new IlBytesRequest(opened.WorkspaceId, path, [new IlBytesInstructionDto(token, ldstrOffset)]), TestContext.Current.CancellationToken);
		// ldstr is 72 followed by the string's token, which the file knows.
		Assert.Matches("^72[0-9A-F]{6}70$", original.Hex);
		Assert.False(original.HasUnknownBytes);

		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		var edited = body with { Instructions = [new IlBodyInstructionDto("L0", "nop", IlOperandKinds.None), .. body.Instructions] };
		await manager.QueueIlBodyAsync(ToReplaceRequest(opened.WorkspaceId, transaction.TransactionId, method.Id, edited), TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var moved = await manager.GetIlBytesAsync(new IlBytesRequest(opened.WorkspaceId, path, [new IlBytesInstructionDto(token, 0), new IlBytesInstructionDto(token, ldstrOffset + 1)]), TestContext.Current.CancellationToken);
		// The nop, then the ldstr, whose string is only known once the module is saved.
		Assert.Equal("0072????????", moved.Hex);
		Assert.True(moved.HasUnknownBytes);
	}

	async Task<TreeNodeDto> FindMethodInRootAsync(string workspaceId, string path, string namespaceName, string typeName, string methodPrefix) {
		var root = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).Nodes, node => node.Description == path);
		var module = Assert.Single(await ChildrenAsync(workspaceId, root.Id), node => node.Kind == "module");
		var namespaces = await ChildrenAsync(workspaceId, module.Id);
		var @namespace = Assert.Single(namespaces, node => node.Label == namespaceName);
		var types = await ChildrenAsync(workspaceId, @namespace.Id);
		var type = Assert.Single(types, node => node.Label == typeName);
		return Assert.Single(await ChildrenAsync(workspaceId, type.Id), node => node.Kind == "method" && node.Label.StartsWith(methodPrefix, StringComparison.Ordinal));
	}

	async Task<IReadOnlyList<TreeNodeDto>> ChildrenAsync(string workspaceId, string nodeId) =>
		(await manager.GetChildrenAsync(new NodeRequest(workspaceId, nodeId), TestContext.Current.CancellationToken)).Nodes;

	async Task<TreeNodeDto> FindFixtureMethodAsync(string workspaceId, string name) =>
		await FindMethodAsync(workspaceId, typeof(IlBodyFixture).Namespace!, nameof(IlBodyFixture), name + "(");

	async Task<TreeNodeDto> FindMethodAsync(string workspaceId, string namespaceName, string typeName, string methodPrefix) {
		var root = Assert.Single(
			(await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).Nodes);
		var module = Assert.Single(await ChildrenAsync(workspaceId, root.Id), node => node.Kind == "module");
		var @namespace = Assert.Single(await ChildrenAsync(workspaceId, module.Id), node => node.Label == namespaceName);
		var type = Assert.Single(await ChildrenAsync(workspaceId, @namespace.Id), node => node.Label == typeName);
		var members = await ChildrenAsync(workspaceId, type.Id);
		return Assert.Single(members, node => node.Kind == "method" && node.Label.StartsWith(methodPrefix, StringComparison.Ordinal));
	}

	static ReplaceIlBodyRequest ToReplaceRequest(string workspaceId, string transactionId, string methodNodeId, IlMethodBodyDto body) => new(
		workspaceId,
		transactionId,
		methodNodeId,
		body.BodyType,
		body.CodeType,
		body.MaxStack,
		body.KeepOldMaxStack,
		body.InitLocals,
		body.LocalVarSigTok,
		body.Locals,
		body.Instructions,
		body.ExceptionHandlers,
		body.NativeRva);

	public void Dispose() => manager.Dispose();
}
