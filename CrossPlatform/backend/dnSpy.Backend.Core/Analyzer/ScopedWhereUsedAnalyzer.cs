using dnlib.DotNet;

namespace dnSpy.Backend.Core.Analyzer;

[Flags]
enum ScopedWhereUsedAnalyzerOptions {
	None = 0,
	/// <summary>Search all modules, eg. used for DllImport methods.</summary>
	IncludeAllModules = 0x00000001,
	/// <summary>Force accessibility to public, eg. used by DllImport methods since DllImport methods with
	/// the same name and module are considered to be the same method.</summary>
	ForcePublic = 0x00000002,
}

/// <summary>
/// Where a member can be used from, and so where a search for its uses has to look — dnSpy's
/// <c>ScopedWhereUsedAnalyzer</c>. A private member is only seen from its own type; a member of a
/// private nested type from the type around it; an internal one from its own assembly and the assemblies
/// it made friends; anything else from every module that references the type at all.
/// </summary>
sealed class ScopedWhereUsedAnalyzer {
	readonly IAnalyzerHost host;
	readonly TypeDef analyzedType;
	readonly ScopedWhereUsedAnalyzerOptions options;
	readonly Accessibility memberAccessibility = Accessibility.Public;
	TypeDef typeScope;
	Accessibility typeAccessibility = Accessibility.Public;

	public List<ModuleDef> AllModules { get; } = [];

	public ScopedWhereUsedAnalyzer(IAnalyzerHost host, TypeDef analyzedType, ScopedWhereUsedAnalyzerOptions options = ScopedWhereUsedAnalyzerOptions.None) {
		this.host = host;
		this.analyzedType = analyzedType;
		typeScope = analyzedType;
		this.options = options;
	}

	public ScopedWhereUsedAnalyzer(IAnalyzerHost host, MethodDef method, ScopedWhereUsedAnalyzerOptions options = ScopedWhereUsedAnalyzerOptions.None)
		: this(host, method.DeclaringType, options) => memberAccessibility = GetMethodAccessibility(method, options);

	public ScopedWhereUsedAnalyzer(IAnalyzerHost host, PropertyDef property, ScopedWhereUsedAnalyzerOptions options = ScopedWhereUsedAnalyzerOptions.None)
		: this(host, property.DeclaringType, options) {
		var getterAccessibility = property.GetMethod is null ? Accessibility.Private : GetMethodAccessibility(property.GetMethod, options);
		var setterAccessibility = property.SetMethod is null ? Accessibility.Private : GetMethodAccessibility(property.SetMethod, options);
		memberAccessibility = (Accessibility)Math.Max((int)getterAccessibility, (int)setterAccessibility);
	}

	public ScopedWhereUsedAnalyzer(IAnalyzerHost host, EventDef eventDef, ScopedWhereUsedAnalyzerOptions options = ScopedWhereUsedAnalyzerOptions.None)
		: this(host, eventDef.DeclaringType, options) {
		var adderAccessibility = eventDef.AddMethod is null ? Accessibility.Private : GetMethodAccessibility(eventDef.AddMethod, options);
		var removerAccessibility = eventDef.RemoveMethod is null ? Accessibility.Private : GetMethodAccessibility(eventDef.RemoveMethod, options);
		var invokerAccessibility = eventDef.InvokeMethod is null ? Accessibility.Private : GetMethodAccessibility(eventDef.InvokeMethod, options);
		memberAccessibility = (Accessibility)Math.Max(Math.Max((int)adderAccessibility, (int)removerAccessibility), (int)invokerAccessibility);
	}

	public ScopedWhereUsedAnalyzer(IAnalyzerHost host, FieldDef field, ScopedWhereUsedAnalyzerOptions options = ScopedWhereUsedAnalyzerOptions.None)
		: this(host, field.DeclaringType, options) {
		memberAccessibility = ((options & ScopedWhereUsedAnalyzerOptions.ForcePublic) != 0 ? FieldAttributes.Public : field.Attributes & FieldAttributes.FieldAccessMask) switch {
			FieldAttributes.FamANDAssem => Accessibility.FamilyAndInternal,
			FieldAttributes.Assembly => Accessibility.Internal,
			FieldAttributes.PrivateScope or FieldAttributes.Family => Accessibility.Family,
			FieldAttributes.FamORAssem => Accessibility.FamilyOrInternal,
			FieldAttributes.Public => Accessibility.Public,
			_ => Accessibility.Private,
		};
	}

	static Accessibility GetMethodAccessibility(MethodDef? method, ScopedWhereUsedAnalyzerOptions options) {
		if (method is null)
			return 0;
		if ((options & ScopedWhereUsedAnalyzerOptions.ForcePublic) != 0)
			return Accessibility.Public;
		return (method.Attributes & MethodAttributes.MemberAccessMask) switch {
			MethodAttributes.FamANDAssem => Accessibility.FamilyAndInternal,
			MethodAttributes.PrivateScope or MethodAttributes.Family => Accessibility.Family,
			MethodAttributes.Assembly => Accessibility.Internal,
			MethodAttributes.FamORAssem => Accessibility.FamilyOrInternal,
			MethodAttributes.Public => Accessibility.Public,
			_ => Accessibility.Private,
		};
	}

	/// <summary>
	/// The stretches of types the search has to walk. Where the scope is modules, <see cref="AllModules"/>
	/// lists them; where it is a single type's nest, it stays empty, as WPF's does.
	/// </summary>
	public IReadOnlyList<AnalyzerScanUnit> GetUnits(CancellationToken cancellationToken) {
		if (memberAccessibility == Accessibility.Private)
			return [AnalyzerScanUnit.ForType(typeScope)];

		DetermineTypeAccessibility();

		if (typeAccessibility == Accessibility.Private)
			return [AnalyzerScanUnit.ForType(typeScope.DeclaringType)];

		IEnumerable<ModuleDef> modules;
		if (memberAccessibility == Accessibility.Internal ||
			memberAccessibility == Accessibility.FamilyAndInternal ||
			typeAccessibility == Accessibility.Internal ||
			typeAccessibility == Accessibility.FamilyAndInternal)
			modules = (options & ScopedWhereUsedAnalyzerOptions.IncludeAllModules) != 0 ? host.Documents : GetModuleAndAnyFriends(analyzedType.Module, cancellationToken);
		else
			modules = (options & ScopedWhereUsedAnalyzerOptions.IncludeAllModules) != 0 ? host.Documents : GetReferencingModules(analyzedType.Module, cancellationToken);
		AllModules.AddRange(modules);
		return AllModules.Select(module => AnalyzerScanUnit.ForModule(module)).ToList();
	}

	void DetermineTypeAccessibility() {
		while (typeScope.IsNested) {
			var accessibility = GetNestedTypeAccessibility(typeScope);
			if ((int)typeAccessibility > (int)accessibility) {
				typeAccessibility = accessibility;
				if (typeAccessibility == Accessibility.Private)
					return;
			}
			typeScope = typeScope.DeclaringType;
		}

		if (GetTypeAccessibility(typeScope) == Accessibility.Internal &&
			((int)typeAccessibility > (int)Accessibility.Internal)) {
			typeAccessibility = Accessibility.Internal;
		}
	}

	Accessibility GetTypeAccessibility(TypeDef type) {
		if ((options & ScopedWhereUsedAnalyzerOptions.ForcePublic) != 0)
			return Accessibility.Public;
		return type.IsNotPublic ? Accessibility.Internal : Accessibility.Public;
	}

	Accessibility GetNestedTypeAccessibility(TypeDef type) {
		if ((options & ScopedWhereUsedAnalyzerOptions.ForcePublic) != 0)
			return Accessibility.Public;
		return (type.Attributes & TypeAttributes.VisibilityMask) switch {
			// Public is invalid for a nested type but sometimes emitted by obfuscators.
			TypeAttributes.NestedPublic or TypeAttributes.Public => Accessibility.Public,
			TypeAttributes.NestedPrivate => Accessibility.Private,
			TypeAttributes.NestedFamily => Accessibility.Family,
			// NotPublic is invalid for a nested type but sometimes emitted by obfuscators.
			TypeAttributes.NestedAssembly or TypeAttributes.NotPublic => Accessibility.Internal,
			TypeAttributes.NestedFamANDAssem => Accessibility.FamilyAndInternal,
			TypeAttributes.NestedFamORAssem => Accessibility.FamilyOrInternal,
			_ => throw new InvalidOperationException(),
		};
	}

	/// <summary>The effective accessibility of a member.</summary>
	enum Accessibility {
		Private,
		FamilyAndInternal,
		Internal,
		Family,
		FamilyOrInternal,
		Public,
	}

	IEnumerable<ModuleDef> GetReferencingModules(ModuleDef mod, CancellationToken cancellationToken) {
		var asm = mod.Assembly;
		if (asm is null) {
			yield return mod;
			yield break;
		}

		foreach (var m in asm.Modules)
			yield return m;

		foreach (var module in host.Documents.Where(a => AnalyzerHelpers.CanIncludeModule(mod, a))) {
			cancellationToken.ThrowIfCancellationRequested();
			if (ModuleReferencesScopeType(module))
				yield return module;
		}
	}

	IEnumerable<ModuleDef> GetModuleAndAnyFriends(ModuleDef mod, CancellationToken cancellationToken) {
		var asm = mod.Assembly;
		if (asm is null) {
			yield return mod;
			yield break;
		}

		foreach (var m in asm.Modules)
			yield return m;

		var friendAssemblies = AnalyzerHelpers.GetFriendAssemblies(host, mod, out var modules);
		if (friendAssemblies.Count > 0) {
			foreach (var module in modules) {
				cancellationToken.ThrowIfCancellationRequested();
				if ((module.Assembly is null || friendAssemblies.Contains(module.Assembly.Name)) && ModuleReferencesScopeType(module))
					yield return module;
			}
		}
	}

	bool ModuleReferencesScopeType(ModuleDef mod) {
		foreach (var typeRef in mod.GetTypeRefs()) {
			if (new SigComparer().Equals(typeScope, typeRef))
				return true;
		}
		foreach (var exportedType in mod.ExportedTypes) {
			if (!exportedType.MovedToAnotherAssembly)
				continue;
			if (new SigComparer().Equals(typeScope, exportedType))
				return true;
		}
		return false;
	}
}
