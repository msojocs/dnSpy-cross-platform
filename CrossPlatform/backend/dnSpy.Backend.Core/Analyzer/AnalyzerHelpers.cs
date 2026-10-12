using dnlib.DotNet;

namespace dnSpy.Backend.Core.Analyzer;

/// <summary>
/// The shared pieces of dnSpy's analyzer searches: its <c>Helpers</c>, the statics of its <c>SearchNode</c>
/// and the tree walk of <c>TreeTraversal</c>.
/// </summary>
static class AnalyzerHelpers {
	/// <summary>Whether a reference names the type: an instance's generic type counts as the type.</summary>
	public static bool IsReferencedBy(TypeDef? type, ITypeDefOrRef? typeRef) => new SigComparer().Equals(type, typeRef.GetScopeType());

	public static bool CheckEquals(IMemberRef? mr1, IMemberRef? mr2) =>
		new SigComparer(SigComparerOptions.CompareDeclaringTypes | SigComparerOptions.PrivateScopeIsComparable |
						SigComparerOptions.ReferenceCompareForMemberDefsInSameModule).Equals(mr1, mr2);

	/// <summary>
	/// The method a result found in compiler-generated code is shown as: the user method a lambda, an
	/// iterator or an async state machine was written in. One level only, and the method itself when no
	/// such method is found — what the C# decompiler shows with its anonymous methods setting on.
	/// </summary>
	public static MethodDef GetOriginalCodeLocation(IAnalyzerHost host, MethodDef method) {
		if (IsCompilerGenerated(method))
			return FindMethodUsageInType(host, method.DeclaringType, method) ?? method;
		return GetOriginalCodeLocation(host, method.DeclaringType) ?? method;
	}

	/// <summary>The method a compiler-generated nested type is used by — the parent method of a lambda's
	/// closure class or of a state machine.</summary>
	static MethodDef? GetOriginalCodeLocation(IAnalyzerHost host, TypeDef? type) {
		if (type is not null && type.DeclaringType is not null && IsCompilerGenerated(type)) {
			if (type.IsValueType) {
				// Value types might not have any constructor; but they must be stored in a local var
				// because 'initobj' (or 'call .ctor') expects a managed ref.
				return FindVariableOfTypeUsageInType(host, type.DeclaringType, type);
			}
			var constructor = type.FindConstructors().FirstOrDefault();
			if (constructor is null)
				return null;
			return FindMethodUsageInType(host, type.DeclaringType, constructor);
		}
		return null;
	}

	static MethodDef? FindMethodUsageInType(IAnalyzerHost host, TypeDef type, MethodDef analyzedMethod) {
		var name = analyzedMethod.Name;
		foreach (var method in type.Methods) {
			if (!method.HasBody)
				continue;
			foreach (var instr in method.Body.Instructions) {
				if (instr.Operand is IMethod mr && !mr.IsField && mr.Name == name &&
					IsReferencedBy(analyzedMethod.DeclaringType, mr.DeclaringType) &&
					CheckEquals(host.ResolveMethodDef(mr), analyzedMethod))
					return method;
			}
		}
		return null;
	}

	static MethodDef? FindVariableOfTypeUsageInType(IAnalyzerHost host, TypeDef type, TypeDef variableType) {
		foreach (var method in type.Methods) {
			if (!method.HasBody)
				continue;
			foreach (var v in method.Body.Variables) {
				if (ResolveWithinSameModule(host, v.Type.ToTypeDefOrRef()) == variableType)
					return method;
			}
		}
		return null;
	}

	static TypeDef? ResolveWithinSameModule(IAnalyzerHost host, ITypeDefOrRef? type) {
		if (type is null)
			return null;
		if (type is TypeDef typeDef)
			return typeDef;
		var scope = type.Scope;
		if (scope is null || scope == type.Module)
			return host.ResolveTypeDef(type);
		return null;
	}

	static bool IsCompilerGenerated(IHasCustomAttribute? hca) =>
		hca is not null && hca.CustomAttributes.IsDefined("System.Runtime.CompilerServices.CompilerGeneratedAttribute");

	/// <summary>Whether a search may look in <paramref name="module"/> beside the analyzed member's own:
	/// a module of another assembly.</summary>
	public static bool CanIncludeModule(ModuleDef targetModule, ModuleDef? module) {
		if (module is null)
			return false;
		if (targetModule == module)
			return false;
		if (targetModule.Assembly is not null && targetModule.Assembly == module.Assembly)
			return false;
		return true;
	}

	/// <summary>
	/// The assemblies that may see the internals of the analyzed module's assembly: the ones its
	/// [InternalsVisibleTo] names, and the ones whose [IgnoresAccessChecksTo] names it. Also hands back the
	/// documents a friend can be among, which is every module of another assembly.
	/// </summary>
	public static HashSet<string> GetFriendAssemblies(IAnalyzerHost host, ModuleDef mod, out ModuleDef[] modules) {
		var asm = mod.Assembly!;
		var friendAssemblies = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
		foreach (var attribute in asm.CustomAttributes.FindAll("System.Runtime.CompilerServices.InternalsVisibleToAttribute")) {
			if (FriendName(attribute) is { } assemblyName)
				friendAssemblies.Add(assemblyName);
		}
		modules = host.Documents.Where(a => CanIncludeModule(mod, a)).ToArray();
		foreach (var module in modules) {
			var asm2 = module.Assembly;
			if (asm2 is null)
				continue;
			foreach (var attribute in asm2.CustomAttributes.FindAll("System.Runtime.CompilerServices.IgnoresAccessChecksToAttribute")) {
				if (FriendName(attribute) is { } assemblyName && StringComparer.OrdinalIgnoreCase.Equals(asm.Name.String, assemblyName))
					friendAssemblies.Add(asm2.Name);
			}
		}
		return friendAssemblies;
	}

	static string? FriendName(CustomAttribute attribute) {
		if (attribute.ConstructorArguments.Count == 0)
			return null;
		var value = attribute.ConstructorArguments[0].Value;
		var assemblyName = (value as UTF8String)?.String ?? value as string;
		return assemblyName is null ? null : new AssemblyNameInfo(assemblyName).Name;
	}

	/// <summary>A pre-order walk of a forest — every type of a module and the types nested in it, outer
	/// types before the ones they hold.</summary>
	public static IEnumerable<T> PreOrder<T>(IEnumerable<T> input, Func<T, IEnumerable<T>?> recursion) {
		var stack = new Stack<IEnumerator<T>>();
		try {
			stack.Push(input.GetEnumerator());
			while (stack.Count > 0) {
				while (stack.Peek().MoveNext()) {
					var element = stack.Peek().Current;
					yield return element;
					var children = recursion(element);
					if (children is not null)
						stack.Push(children.GetEnumerator());
				}
				stack.Pop().Dispose();
			}
		}
		finally {
			while (stack.Count > 0)
				stack.Pop().Dispose();
		}
	}

	public static IEnumerable<T> PreOrder<T>(T root, Func<T, IEnumerable<T>?> recursion) => PreOrder(new[] { root }, recursion);
}
