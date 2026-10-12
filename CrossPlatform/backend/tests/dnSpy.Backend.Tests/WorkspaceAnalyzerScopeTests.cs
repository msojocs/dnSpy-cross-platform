using dnlib.DotNet;
using dnlib.DotNet.Emit;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The analyzer's scope rules against assemblies written for the case: who may see an internal member, the
/// DllImports that count as one method, and the pseudo attributes no module names in its type references.
/// The AnalyzerTarget fixtures are compiled C#, which cannot express all of these.
/// </summary>
public sealed class WorkspaceAnalyzerScopeTests : IDisposable {
	readonly WorkspaceManager manager = new();
	readonly DirectoryInfo directory = Directory.CreateTempSubdirectory("dnspy-analyzer-");

	static CancellationToken Token => TestContext.Current.CancellationToken;

	[Fact]
	public async Task SeesAnInternalMemberFromAnAssemblyThatIgnoresAccessChecksToIt_AndNotFromAStranger() {
		var lib = WriteAssembly("Lib", module => {
			var api = AddType(module, "Lib", "Api");
			api.Methods.Add(StaticMethod(module, "Secret", MethodAttributes.Assembly));
		});
		var stranger = WriteAssembly("Stranger", module => AddCaller(module, "Stranger", SecretRef(module)));
		var ignorer = WriteAssembly("Ignorer", module => {
			AddCaller(module, "Ignorer", SecretRef(module));
			// The runtime honours [IgnoresAccessChecksTo] wherever the attribute type comes from, and so does dnSpy.
			var attributeType = new TypeRefUser(module, "System.Runtime.CompilerServices", "IgnoresAccessChecksToAttribute", module.CorLibTypes.AssemblyRef);
			var constructor = new MemberRefUser(module, ".ctor", MethodSig.CreateInstance(module.CorLibTypes.Void, module.CorLibTypes.String), attributeType);
			module.Assembly.CustomAttributes.Add(new CustomAttribute(constructor, [new CAArgument(module.CorLibTypes.String, "Lib")]));
		});
		var workspaceId = await OpenAsync(lib, stranger, ignorer);

		var usedBy = await SearchAsync(workspaceId, lib, "Lib.Api", "Secret", AnalyzerSearchKinds.UsedBy);

		// Both call it; only the one that may is listed, the way dnSpy leaves out an assembly that is no friend.
		Assert.Equal(["Ignorer.Caller.Call() : void"], usedBy);
	}

	[Fact]
	public async Task FindsTheCallersOfADllImportOfTheSameEntryPointDeclaredInAnotherAssembly() {
		var native = WriteAssembly("NativeCalls", module => {
			var interop = AddType(module, "NativeCalls", "Interop");
			// "libc.so" and the fixture's "libc" name the same native module once the platform's decoration is off.
			var pid = PInvoke(module, "Pid", "libc.so", "getpid");
			interop.Methods.Add(pid);
			interop.Methods.Add(StaticMethod(module, "UsePid", MethodAttributes.Public, OpCodes.Call.ToInstruction(pid), OpCodes.Pop.ToInstruction()));
			// Another entry point of the same module is another method.
			var ppid = PInvoke(module, "ParentPid", "libc.so", "getppid");
			interop.Methods.Add(ppid);
			interop.Methods.Add(StaticMethod(module, "UseParentPid", MethodAttributes.Public, OpCodes.Call.ToInstruction(ppid), OpCodes.Pop.ToInstruction()));
		});
		var target = typeof(AnalyzerTarget.Usage).Assembly.Location;
		var workspaceId = await OpenAsync(target, native);

		var usedBy = await SearchAsync(workspaceId, target, "AnalyzerTarget.Usage", nameof(AnalyzerTarget.Usage.GetPid), AnalyzerSearchKinds.UsedBy);

		Assert.Equal(["AnalyzerTarget.Usage.CallPid() : int", "NativeCalls.Interop.UsePid() : void"], usedBy.Order(StringComparer.Ordinal));
	}

	[Fact]
	public async Task LooksForAPseudoAttributeInModulesThatNeverNameIt() {
		// [DllImport] is not a custom attribute in metadata but a flag and an ImplMap row, so a module that uses
		// it has no reference to the attribute type at all: dnSpy searches every module for such a type.
		// The pseudo attribute is written against the core library the module names, so the attribute type
		// lives in a core library of the test's own: one named mscorlib, which is what an assembly written by
		// dnlib names.
		var corLib = WriteAssembly("mscorlib", module => {
			var @object = new TypeDefUser("System", "Object") { Attributes = TypeAttributes.Public | TypeAttributes.Class };
			module.Types.Add(@object);
			var attribute = new TypeDefUser("System", "Attribute", @object) { Attributes = TypeAttributes.Public | TypeAttributes.Abstract };
			module.Types.Add(attribute);
			module.Types.Add(new TypeDefUser("System.Runtime.InteropServices", "DllImportAttribute", attribute) { Attributes = TypeAttributes.Public | TypeAttributes.Sealed });
		}, new Version(4, 0, 0, 0));
		var pinvoker = WriteAssembly("PInvoker", module => AddType(module, "PInvoker", "Native").Methods.Add(PInvoke(module, "Pid", "libc", "getpid")));
		var workspaceId = await OpenAsync(corLib, pinvoker);

		var usedBy = await SearchAsync(workspaceId, corLib, "System.Runtime.InteropServices.DllImportAttribute", null, AnalyzerSearchKinds.UsedBy);

		Assert.Contains("PInvoker.Native.Pid() : int", usedBy);
	}

	async Task<string> OpenAsync(params string[] paths) =>
		(await manager.OpenAsync(new OpenWorkspaceRequest(paths), Token)).WorkspaceId;

	/// <summary>Runs a search on a type, or on one of its methods, and answers the rows' labels.</summary>
	async Task<IReadOnlyList<string>> SearchAsync(string workspaceId, string path, string typeName, string? methodName, string search) {
		int token;
		using (var module = ModuleDefMD.Load(path)) {
			var type = module.Find(typeName, isReflectionName: false) ?? throw new InvalidOperationException($"No {typeName} in {path}.");
			token = methodName is null ? type.MDToken.ToInt32() : type.Methods.Single(method => method.Name == methodName).MDToken.ToInt32();
		}
		var nodeId = (await manager.FindMemberAsync(new FindMemberRequest(workspaceId, path, token), Token)).NodeId
			?? throw new InvalidOperationException($"No node for {typeName}.{methodName}.");
		var response = await manager.AnalyzeChildrenAsync(new AnalyzeChildrenRequest(workspaceId, nodeId, search), Token);
		return response.Children.Select(row => row.Label).ToArray();
	}

	string WriteAssembly(string name, Action<ModuleDef> build, Version? version = null) {
		var module = new ModuleDefUser($"{name}.dll") { Kind = ModuleKind.Dll };
		new AssemblyDefUser(name, version ?? new Version(1, 0, 0, 0)).Modules.Add(module);
		build(module);
		var path = Path.Combine(directory.FullName, $"{name}.dll");
		module.Write(path);
		return path;
	}

	static TypeDef AddType(ModuleDef module, string @namespace, string name, TypeAttributes attributes = TypeAttributes.Public | TypeAttributes.Abstract | TypeAttributes.Sealed) {
		var type = new TypeDefUser(@namespace, name, module.CorLibTypes.Object.TypeDefOrRef) { Attributes = attributes };
		module.Types.Add(type);
		return type;
	}

	/// <summary>A static void method whose body runs the instructions given and returns.</summary>
	static MethodDef StaticMethod(ModuleDef module, string name, MethodAttributes access, params Instruction[] instructions) {
		var method = new MethodDefUser(name, MethodSig.CreateStatic(module.CorLibTypes.Void), access | MethodAttributes.Static | MethodAttributes.HideBySig) {
			Body = new CilBody(),
		};
		foreach (var instruction in instructions)
			method.Body.Instructions.Add(instruction);
		method.Body.Instructions.Add(OpCodes.Ret.ToInstruction());
		return method;
	}

	static MethodDef PInvoke(ModuleDef module, string name, string nativeModule, string entryPoint) =>
		new MethodDefUser(name, MethodSig.CreateStatic(module.CorLibTypes.Int32), MethodImplAttributes.PreserveSig,
			MethodAttributes.Public | MethodAttributes.Static | MethodAttributes.HideBySig | MethodAttributes.PinvokeImpl) {
			ImplMap = new ImplMapUser(new ModuleRefUser(module, nativeModule), entryPoint, PInvokeAttributes.CallConvWinapi),
		};

	/// <summary>A reference to Lib.Api.Secret, the way another assembly's call names it.</summary>
	static MemberRef SecretRef(ModuleDef module) =>
		new MemberRefUser(module, "Secret", MethodSig.CreateStatic(module.CorLibTypes.Void),
			new TypeRefUser(module, "Lib", "Api", new AssemblyRefUser("Lib", new Version(1, 0, 0, 0))));

	static void AddCaller(ModuleDef module, string @namespace, MemberRef callee) =>
		AddType(module, @namespace, "Caller").Methods.Add(StaticMethod(module, "Call", MethodAttributes.Public, OpCodes.Call.ToInstruction(callee)));

	public void Dispose() {
		manager.Dispose();
		directory.Delete(recursive: true);
	}
}
