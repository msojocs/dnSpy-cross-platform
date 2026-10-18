using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>The type the compiler tests edit. Its method's body is replaced by the compiled source.</summary>
public class CompilerFixture {
	private int _value = 5;

	public int Value() => 1;

	public int UsesField() => _value;
}

public sealed class WorkspaceCompilerTests : IDisposable {
	readonly WorkspaceManager manager = new();

	[Fact]
	public async Task EditsAMethodBodyFromCSharpSource() {
		var opened = await OpenAsync();
		var type = await FindTypeAsync(opened.WorkspaceId, nameof(CompilerFixture));
		var members = await ChildrenAsync(opened.WorkspaceId, type.Id);
		var method = Assert.Single(members, node => node.Kind == "method" && node.Label.StartsWith("Value(", StringComparison.Ordinal));

		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		var result = await manager.CompileSourceAsync(
			new CompileSourceRequest(opened.WorkspaceId, method.Id, CompilerModes.EditMethod, Source("return 42;"), transaction.TransactionId),
			TestContext.Current.CancellationToken);
		Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics.Select(diagnostic => diagnostic.Text)));
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var il = await manager.DecompileAsync(new DecompileRequest(opened.WorkspaceId, method.Id, DecompilerLanguage.CSharp), TestContext.Current.CancellationToken);
		Assert.Contains("42", il.Text, StringComparison.Ordinal);

		await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		var undone = await manager.DecompileAsync(new DecompileRequest(opened.WorkspaceId, method.Id, DecompilerLanguage.CSharp), TestContext.Current.CancellationToken);
		Assert.DoesNotContain("42", undone.Text, StringComparison.Ordinal);
	}

	[Fact]
	public async Task CompilesCodeThatUsesTheTypesOwnMembers() {
		var opened = await OpenAsync();
		var type = await FindTypeAsync(opened.WorkspaceId, nameof(CompilerFixture));
		var method = Assert.Single(await ChildrenAsync(opened.WorkspaceId, type.Id), node => node.Kind == "method" && node.Label.StartsWith("UsesField(", StringComparison.Ordinal));

		var source = """
			namespace dnSpy.Backend.Tests;

			public class CompilerFixture
			{
				private int _value = 5;
				public int UsesField() { return _value * 2; }
			}
			""";
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		var result = await manager.CompileSourceAsync(
			new CompileSourceRequest(opened.WorkspaceId, method.Id, CompilerModes.EditMethod, source, transaction.TransactionId),
			TestContext.Current.CancellationToken);
		Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics.Select(diagnostic => diagnostic.Text)));
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var il = await manager.DecompileAsync(new DecompileRequest(opened.WorkspaceId, method.Id, DecompilerLanguage.IL), TestContext.Current.CancellationToken);
		Assert.Contains("ldfld", il.Text, StringComparison.Ordinal);
		Assert.Contains("ldc.i4.2", il.Text, StringComparison.Ordinal);
	}

	[Fact]
	public async Task AddsANewClassAndUndoRemovesIt() {
		var opened = await OpenAsync();
		var root = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Nodes);
		var source = """
			namespace dnSpy.Backend.Tests;

			public class AddedByCompiler
			{
				public int X => 3;
			}
			""";
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		var result = await manager.CompileSourceAsync(
			new CompileSourceRequest(opened.WorkspaceId, root.Id, CompilerModes.AddClass, source, transaction.TransactionId),
			TestContext.Current.CancellationToken);
		Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics.Select(diagnostic => diagnostic.Text)));
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var added = await FindTypeAsync(opened.WorkspaceId, "AddedByCompiler");
		await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		var module = Assert.Single(await ChildrenAsync(opened.WorkspaceId, root.Id), node => node.Kind == "module");
		var @namespace = Assert.Single(await ChildrenAsync(opened.WorkspaceId, module.Id), node => node.Label == "dnSpy.Backend.Tests");
		Assert.DoesNotContain(await ChildrenAsync(opened.WorkspaceId, @namespace.Id), node => node.Id == added.Id);
	}

	[Fact]
	public async Task AnswersCompileErrorsWithoutTouchingTheModule() {
		var opened = await OpenAsync();
		var type = await FindTypeAsync(opened.WorkspaceId, nameof(CompilerFixture));
		var method = Assert.Single(await ChildrenAsync(opened.WorkspaceId, type.Id), node => node.Kind == "method" && node.Label.StartsWith("Value(", StringComparison.Ordinal));

		var result = await manager.CompileSourceAsync(
			new CompileSourceRequest(opened.WorkspaceId, method.Id, CompilerModes.EditMethod, Source("return notANumber;")),
			TestContext.Current.CancellationToken);

		Assert.False(result.Success);
		Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Severity == "error" && diagnostic.Id == "CS0103");
		// A compile-only request queues nothing, so the method is unchanged.
		var il = await manager.DecompileAsync(new DecompileRequest(opened.WorkspaceId, method.Id, DecompilerLanguage.IL), TestContext.Current.CancellationToken);
		Assert.Contains("ldc.i4.1", il.Text, StringComparison.Ordinal);
	}

	[Fact]
	public async Task AddsAMemberToAnExistingClass() {
		var opened = await OpenAsync();
		var type = await FindTypeAsync(opened.WorkspaceId, nameof(CompilerFixture));

		var source = """
			namespace dnSpy.Backend.Tests;

			public class CompilerFixture
			{
				public int Value() => 1;
				public int Added() => 7;
			}
			""";
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		var result = await manager.CompileSourceAsync(
			new CompileSourceRequest(opened.WorkspaceId, type.Id, CompilerModes.AddMembers, source, transaction.TransactionId),
			TestContext.Current.CancellationToken);
		Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics.Select(diagnostic => diagnostic.Text)));
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var members = await ChildrenAsync(opened.WorkspaceId, type.Id);
		var added = Assert.Single(members, node => node.Kind == "method" && node.Label.StartsWith("Added(", StringComparison.Ordinal));

		await manager.UndoAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		members = await ChildrenAsync(opened.WorkspaceId, type.Id);
		Assert.DoesNotContain(members, node => node.Id == added.Id);
	}

	static string Source(string body) => $$"""
		namespace dnSpy.Backend.Tests;

		public class CompilerFixture
		{
			public int Value() { {{body}} }
		}
		""";

	async Task<OpenWorkspaceResponse> OpenAsync() => await manager.OpenAsync(
		new OpenWorkspaceRequest([typeof(CompilerFixture).Assembly.Location]),
		TestContext.Current.CancellationToken);

	async Task<IReadOnlyList<TreeNodeDto>> ChildrenAsync(string workspaceId, string nodeId) =>
		(await manager.GetChildrenAsync(new NodeRequest(workspaceId, nodeId), TestContext.Current.CancellationToken)).Nodes;

	async Task<TreeNodeDto> FindTypeAsync(string workspaceId, string name) {
		var root = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).Nodes);
		var module = Assert.Single(await ChildrenAsync(workspaceId, root.Id), node => node.Kind == "module");
		var @namespace = Assert.Single(await ChildrenAsync(workspaceId, module.Id), node => node.Label == "dnSpy.Backend.Tests");
		return Assert.Single(await ChildrenAsync(workspaceId, @namespace.Id), node => node.Label == name);
	}

	public void Dispose() => manager.Dispose();
}
