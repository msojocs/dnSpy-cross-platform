using dnlib.DotNet;

namespace dnSpy.Backend.Core.Analyzer.Searches;

/// <summary>"Overrides" for a property: the base property it overrides.</summary>
sealed class PropertyOverriddenSearch(IAnalyzerHost host, PropertyDef analyzedProperty) : AnalyzerSearch(host) {
	public override IReadOnlyList<AnalyzerScanUnit> Prepare(CancellationToken cancellationToken) => [];

	public override void Finish(List<AnalyzerHit> hits) {
		var analyzedAccessor = GetVirtualAccessor(analyzedProperty.GetMethod) ?? GetVirtualAccessor(analyzedProperty.SetMethod);
		if (analyzedAccessor is not null) {
			foreach (var o in analyzedAccessor.Overrides) {
				if (Host.ResolveMethodDef(o.MethodDeclaration) is MethodDef method && (method.IsVirtual || method.IsAbstract)) {
					if (method.DeclaringType.Properties.FirstOrDefault(a => (object?)a.GetMethod == method || (object?)a.SetMethod == method) is PropertyDef property)
						hits.Add(new AnalyzerHit(property));
				}
			}
			if (hits.Count > 0)
				return;
		}
		foreach (var property in TypesHierarchyHelpers.FindBaseProperties(Host, analyzedProperty, analyzedProperty.DeclaringType)) {
			var anyAccessor = GetVirtualAccessor(property.GetMethod) ?? GetVirtualAccessor(property.SetMethod);
			if (anyAccessor is null || !(anyAccessor.IsVirtual || anyAccessor.IsAbstract))
				continue;
			hits.Add(new AnalyzerHit(property));
			break;
		}
	}

	public static bool CanShow(PropertyDef property) =>
		(GetAccessor(property.GetMethod) ?? GetAccessor(property.SetMethod)) is not null;

	static MethodDef? GetAccessor(MethodDef? accessor) =>
		accessor is not null && accessor.DeclaringType.BaseType is not null &&
		(accessor.IsVirtual || accessor.IsAbstract) && accessor.IsReuseSlot ? accessor : null;

	static MethodDef? GetVirtualAccessor(MethodDef? accessor) =>
		accessor is not null && (accessor.IsVirtual || accessor.IsAbstract) ? accessor : null;
}

/// <summary>"Overridden By" for a property: the properties of derived types that override or hide it.</summary>
sealed class PropertyOverridesSearch(IAnalyzerHost host, PropertyDef analyzedProperty) : ScopedSearch(host) {
	protected override ScopedWhereUsedAnalyzer CreateAnalyzer() => new(Host, analyzedProperty);

	protected override IEnumerable<AnalyzerHit> FindReferencesInType(TypeDef type) {
		if (!TypesHierarchyHelpers.IsBaseType(Host, analyzedProperty.DeclaringType, type, resolveTypeArguments: false))
			yield break;
		foreach (var property in type.Properties) {
			if (TypesHierarchyHelpers.IsBaseProperty(Host, analyzedProperty, property)) {
				var anyAccessor = property.GetMethod ?? property.SetMethod;
				if (anyAccessor is null)
					continue;
				var hidesParent = !anyAccessor.IsVirtual ^ anyAccessor.IsNewSlot;
				yield return new AnalyzerHit(property, HidesParent: hidesParent);
			}
		}
	}

	public static bool CanShow(PropertyDef property) {
		var accessor = property.GetMethod ?? property.SetMethod;
		return accessor is not null && accessor.IsVirtual && !accessor.IsFinal && !accessor.DeclaringType.IsInterface;
	}
}

/// <summary>"Implemented By" for an interface property: the property each implementing type has for it,
/// matched through the getter, or the setter of a write-only property.</summary>
sealed class InterfacePropertyImplementedBySearch : ScopedSearch {
	readonly PropertyDef analyzedProperty;
	readonly MethodDef? analyzedMethod;
	readonly bool isGetter;

	public InterfacePropertyImplementedBySearch(IAnalyzerHost host, PropertyDef analyzedProperty) : base(host) {
		this.analyzedProperty = analyzedProperty;
		if (analyzedProperty.GetMethod is not null) {
			analyzedMethod = analyzedProperty.GetMethod;
			isGetter = true;
		}
		else {
			analyzedMethod = analyzedProperty.SetMethod;
			isGetter = false;
		}
	}

	public override IReadOnlyList<AnalyzerScanUnit> Prepare(CancellationToken cancellationToken) =>
		analyzedMethod is null ? [] : base.Prepare(cancellationToken);

	protected override ScopedWhereUsedAnalyzer CreateAnalyzer() => new(Host, analyzedMethod!);

	protected override IEnumerable<AnalyzerHit> FindReferencesInType(TypeDef type) {
		if (analyzedMethod is null || type.IsInterface)
			yield break;
		var implementedInterfaceRef = InterfaceMethodImplementedBySearch.GetInterface(Host, type, analyzedMethod.DeclaringType);
		if (implementedInterfaceRef is null)
			yield break;

		foreach (var property in type.Properties.Where(e => e.Name.EndsWith(analyzedProperty.Name))) {
			var accessor = isGetter ? property.GetMethod : property.SetMethod;
			// Don't include abstract accessors, they don't implement anything
			if (accessor is null || (!accessor.IsVirtual && !accessor.IsStatic) || accessor.IsAbstract)
				continue;
			if (accessor.HasOverrides && accessor.Overrides.Any(m => CheckEquals(Host.ResolveMethodDef(m.MethodDeclaration), analyzedMethod))) {
				yield return new AnalyzerHit(property);
				yield break;
			}
		}

		foreach (var property in type.Properties.Where(e => e.Name == analyzedProperty.Name)) {
			var accessor = isGetter ? property.GetMethod : property.SetMethod;
			// Don't include abstract accessors, they don't implement anything
			if (accessor is null || (!accessor.IsVirtual && !accessor.IsStatic) || accessor.IsAbstract)
				continue;
			if (TypesHierarchyHelpers.MatchInterfaceMethod(accessor, analyzedMethod, implementedInterfaceRef)) {
				yield return new AnalyzerHit(property);
				yield break;
			}
		}
	}

	public static bool CanShow(PropertyDef property) =>
		property.DeclaringType.IsInterface && (property.GetMethod ?? property.SetMethod) is MethodDef accessor && (accessor.IsVirtual || accessor.IsAbstract);
}
