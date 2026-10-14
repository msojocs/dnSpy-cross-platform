using dnlib.DotNet;
using dnlib.DotNet.Emit;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

public sealed class DecompilationConcurrencyTests : IDisposable {
	readonly WorkspaceManager manager = new();
	readonly string directory = Path.Combine(Path.GetTempPath(), $"dnspy-decompile-{Guid.NewGuid():N}");

	[Fact]
	public async Task TreeRequestsCompleteWhileAssemblyDecompilationIsRunning() {
		var (workspace, root) = await OpenLargeAssemblyAsync();
		var module = Assert.Single((await manager.GetChildrenAsync(new NodeRequest(workspace, root.Id), TestContext.Current.CancellationToken)).Nodes);
		var space = Assert.Single((await manager.GetChildrenAsync(new NodeRequest(workspace, module.Id), TestContext.Current.CancellationToken)).Nodes, node => node.Kind == "namespace" && node.Label == "Slow");
		using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
		var decompilation = manager.DecompileAsync(new DecompileRequest(workspace, root.Id, DecompilerLanguage.CSharp), cancellation.Token);
		try {
			var children = await manager.GetChildrenAsync(new NodeRequest(workspace, space.Id), TestContext.Current.CancellationToken)
				.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
			Assert.Equal("ManyMethods", Assert.Single(children.Nodes).Label);
			Assert.False(decompilation.IsCompleted, "The tree must respond before the assembly document finishes.");
		}
		finally {
			await cancellation.CancelAsync();
			await Assert.ThrowsAnyAsync<OperationCanceledException>(() => decompilation.WaitAsync(TestContext.Current.CancellationToken));
		}
	}

	[Fact]
	public async Task EditDuringDecompilationRejectsTheOutdatedDocument() {
		var (workspace, root) = await OpenLargeAssemblyAsync();
		var module = Assert.Single((await manager.GetChildrenAsync(new NodeRequest(workspace, root.Id), TestContext.Current.CancellationToken)).Nodes);
		var space = Assert.Single((await manager.GetChildrenAsync(new NodeRequest(workspace, module.Id), TestContext.Current.CancellationToken)).Nodes, node => node.Kind == "namespace" && node.Label == "Slow");
		var type = Assert.Single((await manager.GetChildrenAsync(new NodeRequest(workspace, space.Id), TestContext.Current.CancellationToken)).Nodes);
		using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
		var decompilation = manager.DecompileAsync(new DecompileRequest(workspace, root.Id, DecompilerLanguage.CSharp), cancellation.Token);
		try {
			var edit = await manager.BeginEditAsync(new BeginEditRequest(workspace), TestContext.Current.CancellationToken);
			await manager.QueueRenameAsync(new RenameEditRequest(workspace, edit.TransactionId, type.Id, "Renamed"), TestContext.Current.CancellationToken);
			await manager.CommitEditAsync(new EditTransactionRequest(workspace, edit.TransactionId), TestContext.Current.CancellationToken);
			await Assert.ThrowsAnyAsync<OperationCanceledException>(() => decompilation.WaitAsync(TestContext.Current.CancellationToken));
			var types = await manager.GetChildrenAsync(new NodeRequest(workspace, space.Id), TestContext.Current.CancellationToken);
			Assert.Equal("Renamed", Assert.Single(types.Nodes).Label);
		}
		finally {
			await cancellation.CancelAsync();
			try { await decompilation; } catch (OperationCanceledException) { }
		}
	}

	async Task<(string Workspace, TreeNodeDto Root)> OpenLargeAssemblyAsync() {
		Directory.CreateDirectory(directory);
		var path = Path.Combine(directory, "Large.dll");
		// Retain the current runtime's references and TargetFrameworkAttribute so ILSpy can resolve the
		// framework on Linux as well as Windows, without requiring .NET Framework/Mono to be installed.
		using (var module = ModuleDefMD.Load(typeof(OpenWorkspaceRequest).Assembly.Location)) {
			module.Name = "Large.dll";
			module.Assembly!.Name = "Large";
			foreach (var existing in module.Types.Where(t => !t.IsGlobalModuleType).ToArray())
				module.Types.Remove(existing);
			var type = new TypeDefUser("Slow", "ManyMethods", module.CorLibTypes.Object.TypeDefOrRef) { Attributes = TypeAttributes.Public };
			module.Types.Add(type);
			// Enough independent bodies to keep ILSpy active while a tree read or edit runs. No sleeps or
			// timing hooks are needed in the implementation to exercise the actual decompilation path.
			for (var i = 0; i < 5000; i++) {
				var method = new MethodDefUser($"Method{i}", MethodSig.CreateStatic(module.CorLibTypes.Int32, module.CorLibTypes.Int32), MethodAttributes.Public | MethodAttributes.Static) { Body = new CilBody() };
				method.Body.Instructions.Add(Instruction.Create(OpCodes.Ldarg_0));
				method.Body.Instructions.Add(Instruction.Create(OpCodes.Ldc_I4, i));
				method.Body.Instructions.Add(Instruction.Create(OpCodes.Add));
				method.Body.Instructions.Add(Instruction.Create(OpCodes.Ret));
				type.Methods.Add(method);
			}
			module.Write(path);
		}
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
		return (opened.WorkspaceId, Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), TestContext.Current.CancellationToken)).Nodes));
	}

	public void Dispose() {
		manager.Dispose();
		if (Directory.Exists(directory))
			Directory.Delete(directory, recursive: true);
	}
}
