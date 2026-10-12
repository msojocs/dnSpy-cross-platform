using dnlib.DotNet;
using dnlib.DotNet.Emit;

namespace dnSpy.Backend.Core.Analyzer.Searches;

/// <summary>
/// What a search that reads method bodies keeps while it runs: the methods already listed, since dnSpy
/// lists a method once however many of its instructions match — and lists the user method a lambda or a
/// state machine came from in place of the compiler's method, without a place in its body to go to.
/// </summary>
abstract class BodySearch(IAnalyzerHost host) : ScopedSearch(host) {
	readonly HashSet<MethodDef> foundMethods = [];

	protected bool HasAlreadyBeenFound(MethodDef method) => !foundMethods.Add(method);

	protected AnalyzerHit? BodyHit(MethodDef method, Instruction foundInstr) {
		var codeLocation = GetOriginalCodeLocation(method);
		if (HasAlreadyBeenFound(codeLocation))
			return null;
		return new AnalyzerHit(codeLocation, codeLocation == method ? new AnalyzerSourceRef(method, foundInstr.Offset, foundInstr.Operand as IMDTokenProvider) : null);
	}

	/// <summary>
	/// The attributes that assign the property a setter belongs to by name, which dnSpy counts as uses of
	/// the setter: in the type, minus the methods the body search already listed.
	/// </summary>
	protected IEnumerable<AnalyzerHit> NamedArgumentWritesInType(TypeDef type, IMemberRef member) {
		foreach (var hit in NamedArgumentWrites.Find(type, member)) {
			if (hit.Entity is MethodDef method && HasAlreadyBeenFound(method))
				continue;
			yield return hit;
		}
	}

	/// <summary>The same at the assembly and module level, for every module the search looked at.</summary>
	protected IEnumerable<AnalyzerHit> NamedArgumentWritesInModules(IMemberRef member) {
		var assemblies = new HashSet<AssemblyDef>();
		foreach (var module in AllModules) {
			if (module.Assembly is { } asm && assemblies.Add(asm)) {
				foreach (var hit in NamedArgumentWrites.Find(asm, member))
					yield return hit;
			}
			foreach (var hit in NamedArgumentWrites.Find(module, member))
				yield return hit;
		}
	}
}

/// <summary>"Uses": the fields and methods the analyzed method's body refers to, one row per instruction.</summary>
sealed class MethodUsesSearch(IAnalyzerHost host, MethodDef analyzedMethod) : AnalyzerSearch(host) {
	public override IReadOnlyList<AnalyzerScanUnit> Prepare(CancellationToken cancellationToken) => [];

	public override List<AnalyzerHit> Finish(List<AnalyzerHit> hits) {
		// WPF's Distinct() compares the definition and the place it was found, which is a different place
		// for every instruction — so every reference keeps its own row.
		foreach (var instr in analyzedMethod.Body.Instructions) {
			if (instr.Operand is IField fr && !fr.IsMethod && Host.ResolveFieldDef(fr) is { } def)
				hits.Add(new AnalyzerHit(def, new AnalyzerSourceRef(analyzedMethod, instr.Offset, instr.Operand as IMDTokenProvider)));
		}
		foreach (var instr in analyzedMethod.Body.Instructions) {
			if (instr.Operand is IMethod mr && !mr.IsField && Host.ResolveMethodDef(mr) is { } def)
				hits.Add(new AnalyzerHit(def, new AnalyzerSourceRef(analyzedMethod, instr.Offset, instr.Operand as IMDTokenProvider)));
		}
		return hits;
	}
}

/// <summary>"Used By" for a method that is not virtual: the methods that call it — or, for a DllImport,
/// call any DllImport of the same entry point in the same native module.</summary>
sealed class MethodUsedBySearch : BodySearch {
	readonly MethodDef analyzedMethod;
	readonly bool isSetter;
	readonly UTF8String? implMapName;
	readonly string? implMapModule;
	PropertyDef? property;

	public MethodUsedBySearch(IAnalyzerHost host, MethodDef analyzedMethod, bool isSetter) : base(host) {
		this.analyzedMethod = analyzedMethod;
		this.isSetter = isSetter;
		if (analyzedMethod.ImplMap is ImplMap implMap) {
			implMapName = GetDllImportMethodName(analyzedMethod, implMap);
			implMapModule = NormalizeModuleName(implMap.Module?.Name);
		}
	}

	static UTF8String GetDllImportMethodName(MethodDef method, ImplMap implMap) =>
		!UTF8String.IsNullOrEmpty(implMap.Name) ? implMap.Name : method.Name;

	/// <summary>The native module a DllImport names, without the decoration the platforms add to it.</summary>
	static string NormalizeModuleName(string? name) {
		if (string.IsNullOrEmpty(name))
			return string.Empty;
		if (name.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
			return name[..^4];
		if (name.StartsWith("lib", StringComparison.Ordinal))
			name = name[3..];
		if (name.EndsWith(".so", StringComparison.Ordinal))
			name = name[..^3];
		else if (name.EndsWith(".dylib", StringComparison.OrdinalIgnoreCase))
			name = name[..^6];
		else if (name.EndsWith(".a", StringComparison.Ordinal))
			name = name[..^2];
		else if (name.EndsWith(".sl", StringComparison.Ordinal))
			name = name[..^3];
		return name;
	}

	protected override ScopedWhereUsedAnalyzer CreateAnalyzer() {
		if (isSetter)
			property = analyzedMethod.DeclaringType.Properties.FirstOrDefault(a => a.SetMethod == analyzedMethod);
		var includeAllModules = (property is not null && CustomAttributesUtils.IsPseudoCustomAttributeType(analyzedMethod.DeclaringType, Host)) || implMapName is not null;
		var options = ScopedWhereUsedAnalyzerOptions.None;
		if (includeAllModules)
			options |= ScopedWhereUsedAnalyzerOptions.IncludeAllModules;
		if (implMapName is not null)
			options |= ScopedWhereUsedAnalyzerOptions.ForcePublic;
		return new ScopedWhereUsedAnalyzer(Host, analyzedMethod, options);
	}

	protected override IEnumerable<AnalyzerHit> FindReferencesInType(TypeDef type) {
		var name = analyzedMethod.Name;
		foreach (var method in type.Methods) {
			if (!method.HasBody)
				continue;
			Instruction? foundInstr = null;
			if (implMapName is not null) {
				foreach (var instr in method.Body.Instructions) {
					// DllImport methods are the same if module + func name are identical
					if (instr.Operand is IMethod mr && !mr.IsField &&
						Host.ResolveMethodDef(mr) is MethodDef md &&
						md.ImplMap is ImplMap otherImplMap &&
						implMapName == GetDllImportMethodName(md, otherImplMap) &&
						StringComparer.OrdinalIgnoreCase.Equals(implMapModule, NormalizeModuleName(otherImplMap.Module?.Name))) {
						foundInstr = instr;
						break;
					}
				}
			}
			else {
				foreach (var instr in method.Body.Instructions) {
					if (instr.Operand is IMethod mr && !mr.IsField && mr.Name == name &&
						AnalyzerHelpers.IsReferencedBy(analyzedMethod.DeclaringType, mr.DeclaringType) &&
						CheckEquals(Host.ResolveMethodDef(mr), analyzedMethod)) {
						foundInstr = instr;
						break;
					}
				}
			}
			if (foundInstr is not null && BodyHit(method, foundInstr) is { } hit)
				yield return hit;
		}
		if (property is not null) {
			foreach (var hit in NamedArgumentWritesInType(type, property))
				yield return hit;
		}
	}

	public override List<AnalyzerHit> Finish(List<AnalyzerHit> hits) {
		if (property is not null)
			hits.AddRange(NamedArgumentWritesInModules(property));
		return hits;
	}
}

/// <summary>"Used By" for a virtual method: the calls to it, and the virtual calls through the method
/// that introduced its slot, which may end up in it.</summary>
sealed class VirtualMethodUsedBySearch(IAnalyzerHost host, MethodDef analyzedMethod, bool isSetter) : BodySearch(host) {
	PropertyDef? property;
	MethodDef? baseMethod;

	protected override ScopedWhereUsedAnalyzer CreateAnalyzer() {
		var baseMethods = TypesHierarchyHelpers.FindBaseMethods(Host, analyzedMethod).ToArray();
		baseMethod = baseMethods.Length > 0 ? baseMethods[^1] : analyzedMethod;
		if (isSetter)
			property = analyzedMethod.DeclaringType.Properties.FirstOrDefault(a => a.SetMethod == analyzedMethod);
		var includeAllModules = property is not null && CustomAttributesUtils.IsPseudoCustomAttributeType(analyzedMethod.DeclaringType, Host);
		return new ScopedWhereUsedAnalyzer(Host, analyzedMethod, includeAllModules ? ScopedWhereUsedAnalyzerOptions.IncludeAllModules : ScopedWhereUsedAnalyzerOptions.None);
	}

	protected override IEnumerable<AnalyzerHit> FindReferencesInType(TypeDef type) {
		var name = analyzedMethod.Name;
		foreach (var method in type.Methods) {
			if (!method.HasBody)
				continue;
			Instruction? foundInstr = null;
			foreach (var instr in method.Body.Instructions) {
				if (instr.Operand is not IMethod mr || mr.IsField)
					continue;
				if (mr.Name != name)
					continue;
				MethodDef? md = null;
				// explicit call to the requested method
				if (AnalyzerHelpers.IsReferencedBy(analyzedMethod.DeclaringType, mr.DeclaringType)
					&& CheckEquals(md = Host.ResolveMethodDef(mr), analyzedMethod)) {
					foundInstr = instr;
					break;
				}
				// virtual call to base method
				if (instr.OpCode.Code == Code.Callvirt || instr.OpCode.Code == Code.Ldvirtftn) {
					md ??= Host.ResolveMethodDef(mr);
					if (md is null) {
						// cannot resolve the operand, so ignore this method
						break;
					}
					if (CheckEquals(md, baseMethod)) {
						foundInstr = instr;
						break;
					}
				}
			}
			if (foundInstr is not null && BodyHit(method, foundInstr) is { } hit)
				yield return hit;
		}
		if (property is not null) {
			foreach (var hit in NamedArgumentWritesInType(type, property))
				yield return hit;
		}
	}

	public override List<AnalyzerHit> Finish(List<AnalyzerHit> hits) {
		if (property is not null)
			hits.AddRange(NamedArgumentWritesInModules(property));
		return hits;
	}
}

/// <summary>"Overrides": the base method the analyzed method overrides — what its .override names, or
/// the nearest virtual method of a base type with its signature.</summary>
sealed class MethodOverriddenSearch(IAnalyzerHost host, MethodDef analyzedMethod) : AnalyzerSearch(host) {
	public override IReadOnlyList<AnalyzerScanUnit> Prepare(CancellationToken cancellationToken) => [];

	public override List<AnalyzerHit> Finish(List<AnalyzerHit> hits) {
		foreach (var o in analyzedMethod.Overrides) {
			if (Host.ResolveMethodDef(o.MethodDeclaration) is MethodDef method && (method.IsVirtual || method.IsAbstract))
				hits.Add(new AnalyzerHit(method));
		}
		if (hits.Count > 0)
			return hits;
		foreach (var method in TypesHierarchyHelpers.FindBaseMethods(Host, analyzedMethod, analyzedMethod.DeclaringType)) {
			if (!(method.IsVirtual || method.IsAbstract))
				continue;
			hits.Add(new AnalyzerHit(method));
			break;
		}
		return hits;
	}

	public static bool CanShow(MethodDef method) =>
		method.DeclaringType.BaseType is not null &&
		(method.IsVirtual || method.IsAbstract) && method.IsReuseSlot;
}

/// <summary>"Overridden By": the methods of derived types that override or hide the analyzed method.</summary>
sealed class MethodOverridesSearch(IAnalyzerHost host, MethodDef analyzedMethod) : ScopedSearch(host) {
	protected override ScopedWhereUsedAnalyzer CreateAnalyzer() => new(Host, analyzedMethod);

	protected override IEnumerable<AnalyzerHit> FindReferencesInType(TypeDef type) {
		if (!TypesHierarchyHelpers.IsBaseType(Host, analyzedMethod.DeclaringType, type, resolveTypeArguments: false))
			yield break;
		foreach (var method in type.Methods) {
			if (TypesHierarchyHelpers.IsBaseMethod(Host, analyzedMethod, method)) {
				var hidesParent = !method.IsVirtual ^ method.IsNewSlot;
				yield return new AnalyzerHit(method, HidesParent: hidesParent);
				yield break;
			}
			foreach (var o in method.Overrides) {
				if (Host.ResolveMethodDef(o.MethodDeclaration) is MethodDef methodDecl && CheckEquals(methodDecl, analyzedMethod)) {
					yield return new AnalyzerHit(method);
					yield break;
				}
			}
		}
	}

	public static bool CanShow(MethodDef method) =>
		method.IsVirtual &&
		!method.IsFinal &&
		!method.DeclaringType.IsSealed &&
		!method.DeclaringType.IsInterface;  // interface methods are definitions not implementations - cannot be overridden
}

/// <summary>"Implemented By": the methods of the types implementing the analyzed interface method, by an
/// explicit .override or by name and signature.</summary>
sealed class InterfaceMethodImplementedBySearch(IAnalyzerHost host, MethodDef analyzedMethod) : ScopedSearch(host) {
	protected override ScopedWhereUsedAnalyzer CreateAnalyzer() => new(Host, analyzedMethod);

	protected override IEnumerable<AnalyzerHit> FindReferencesInType(TypeDef type) {
		if (type.IsInterface)
			yield break;
		var implementedInterfaceRef = GetInterface(Host, type, analyzedMethod.DeclaringType);

		foreach (var method in type.Methods) {
			// Don't include abstract methods, they don't implement anything
			if ((!method.IsVirtual && !method.IsStatic) || method.IsAbstract)
				continue;
			if (method.HasOverrides && method.Overrides.Any(m => CheckEquals(Host.ResolveMethodDef(m.MethodDeclaration), analyzedMethod))) {
				yield return new AnalyzerHit(method);
				yield break;
			}
		}

		if (implementedInterfaceRef is not null) {
			foreach (var method in type.Methods) {
				// Don't include abstract methods, they don't implement anything
				if ((!method.IsVirtual && !method.IsStatic) || method.IsAbstract)
					continue;
				if (method.Name != analyzedMethod.Name)
					continue;
				if (TypesHierarchyHelpers.MatchInterfaceMethod(method, analyzedMethod, implementedInterfaceRef)) {
					yield return new AnalyzerHit(method);
					yield break;
				}
			}
		}
	}

	/// <summary>The interface a type implements, as the type or one of its bases names it — with the
	/// type's own generic arguments substituted in — or null when the type does not implement it.</summary>
	internal static ITypeDefOrRef? GetInterface(IAnalyzerHost host, TypeDef type, TypeDef interfaceType) {
		foreach (var t in TypesHierarchyHelpers.GetTypeAndBaseTypes(host, type)) {
			var td = host.ResolveTypeDef(t);
			if (td is null)
				break;
			foreach (var ii in td.Interfaces) {
				var genericArgs = (t as GenericInstSig)?.GenericArguments;
				var iface = GenericArgumentResolver.Resolve(ii.Interface.ToTypeSig(), genericArgs, null);
				if (iface is null)
					continue;
				if (new SigComparer().Equals(ii.Interface.GetScopeType(), interfaceType))
					return iface.ToTypeDefOrRef();
			}
		}
		return null;
	}

	public static bool CanShow(MethodDef method) => method.DeclaringType.IsInterface && (method.IsVirtual || method.IsAbstract);
}
