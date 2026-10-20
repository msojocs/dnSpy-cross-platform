using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.CompilerServices;

namespace DebugTarget;

/// <summary>
/// The dynamic module fixture: with <c>--emit</c> the process builds a type with Reflection.Emit, runs it, and stops
/// in <see cref="Ready"/> before it exits — Main never runs, so nothing the other debugger tests pin moves. It is a
/// type of its own, after Program, so Program's tokens stay where they are.
/// </summary>
internal static class DynamicFixture {
	[ModuleInitializer]
	internal static void EmitWhenAsked() {
		if (!Environment.GetCommandLineArgs().Contains("--emit", StringComparer.Ordinal))
			return;
		var assembly = AssemblyBuilder.DefineDynamicAssembly(new AssemblyName("DynamicFixture"), AssemblyBuilderAccess.Run);
		var module = assembly.DefineDynamicModule("DynamicFixture");
		var type = module.DefineType("Dynamic.Greeter", TypeAttributes.Public | TypeAttributes.Class);
		var answer = type.DefineMethod("Answer", MethodAttributes.Public | MethodAttributes.Static, typeof(int), Type.EmptyTypes);
		var il = answer.GetILGenerator();
		var local = il.DeclareLocal(typeof(int));
		il.Emit(OpCodes.Ldc_I4_S, (sbyte)42);
		il.Emit(OpCodes.Stloc, local);
		il.BeginExceptionBlock();
		il.Emit(OpCodes.Ldloc, local);
		il.Emit(OpCodes.Pop);
		il.BeginFinallyBlock();
		il.EndExceptionBlock();
		il.Emit(OpCodes.Ldloc, local);
		il.Emit(OpCodes.Ret);
		var created = type.CreateType();
		Ready((int)created.GetMethod("Answer")!.Invoke(null, null)!);
		Environment.Exit(0);
	}

	[MethodImpl(MethodImplOptions.NoInlining)]
	internal static void Ready(int answer) => Console.WriteLine(answer);
}
