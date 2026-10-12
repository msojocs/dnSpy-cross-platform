using dnlib.DotNet;

namespace dnSpy.Backend.Core.Analyzer;

/// <summary>
/// dnSpy's <c>TypesHierarchyHelpers</c>: which members a member overrides or hides, and which types a
/// type derives from. Every step up a hierarchy resolves a base type through the analyzer's host, since
/// the base usually lives in another assembly than the type that names it.
/// </summary>
static class TypesHierarchyHelpers {
	public static bool IsBaseType(IAnalyzerHost host, TypeDef? baseType, TypeDef? derivedType, bool resolveTypeArguments) {
		if (baseType is null || derivedType is null)
			return false;
		if (resolveTypeArguments)
			return BaseTypes(host, derivedType).Any(t => new SigComparer().Equals(host.ResolveTypeDef(t), baseType));
		while (derivedType.BaseType is not null) {
			var resolvedBaseType = host.ResolveTypeDef(derivedType.BaseType);
			if (resolvedBaseType is null)
				return false;
			if (new SigComparer().Equals(baseType, resolvedBaseType))
				return true;
			derivedType = resolvedBaseType;
		}
		return false;
	}

	/// <summary>Whether <paramref name="childMethod"/> overrides or hides <paramref name="parentMethod"/>.</summary>
	public static bool IsBaseMethod(IAnalyzerHost host, MethodDef? parentMethod, MethodDef? childMethod) {
		if (parentMethod is null || childMethod is null)
			return false;
		if (parentMethod.Name != childMethod.Name)
			return false;
		var parentParams = parentMethod.MethodSig.GetParamCount();
		var childParams = childMethod.MethodSig.GetParamCount();
		if (parentParams > 0 || childParams > 0)
			if (parentParams == 0 || childParams == 0 || parentParams != childParams)
				return false;
		return FindBaseMethods(host, childMethod).Any(m => CheckEquals(m, parentMethod));
	}

	static bool CheckEquals(IMemberRef? mr1, IMemberRef? mr2) =>
		new SigComparer(SigComparerOptions.CompareDeclaringTypes | SigComparerOptions.PrivateScopeIsComparable).Equals(mr1, mr2);

	/// <summary>Whether <paramref name="childProperty"/> overrides or hides <paramref name="parentProperty"/>.</summary>
	public static bool IsBaseProperty(IAnalyzerHost host, PropertyDef? parentProperty, PropertyDef? childProperty) {
		if (parentProperty is null || childProperty is null)
			return false;
		if (parentProperty.Name != childProperty.Name)
			return false;
		var parentParams = parentProperty.PropertySig.GetParamCount();
		var childParams = childProperty.PropertySig.GetParamCount();
		if (parentParams > 0 || childParams > 0)
			if (parentParams == 0 || childParams == 0 || parentParams != childParams)
				return false;
		return FindBaseProperties(host, childProperty).Any(m => CheckEquals(m, parentProperty));
	}

	public static bool IsBaseEvent(IAnalyzerHost host, EventDef? parentEvent, EventDef childEvent) {
		if (parentEvent is null || parentEvent.Name != childEvent.Name)
			return false;
		return FindBaseEvents(host, childEvent).Any(m => CheckEquals(m, parentEvent));
	}

	/// <summary>The methods of the base types <paramref name="method"/> overrides or hides, nearest first,
	/// stopping at the one that introduced the slot.</summary>
	public static IEnumerable<MethodDef> FindBaseMethods(IAnalyzerHost host, MethodDef? method, bool compareReturnType = true) =>
		FindBaseMethods(host, method, method?.DeclaringType, compareReturnType);

	public static IEnumerable<MethodDef> FindBaseMethods(IAnalyzerHost host, MethodDef? method, TypeDef? declType, bool compareReturnType = true) {
		if (method is null || declType is null)
			yield break;
		foreach (var baseType in BaseTypes(host, declType)) {
			var baseTypeDef = host.ResolveTypeDef(baseType);
			if (baseTypeDef is null)
				continue;
			foreach (var baseMethod in baseTypeDef.Methods) {
				if (MatchMethod(baseMethod, Resolve(baseMethod.MethodSig, baseType), method, compareReturnType) && IsVisibleFromDerived(baseMethod, declType)) {
					yield return baseMethod;
					if (baseMethod.IsNewSlot == baseMethod.IsVirtual)
						yield break;
				}
			}
		}
	}

	static bool MatchMethod(MethodDef? mCandidate, MethodBaseSig? mCandidateSig, MethodDef? mMethod, bool compareReturnType = true) =>
		MatchMethod(mCandidate, mCandidateSig, mMethod, mMethod?.MethodSig, compareReturnType);

	static bool MatchMethod(MethodDef? mCandidate, MethodBaseSig? mCandidateSig, MethodDef? mMethod, MethodBaseSig? mMethodSig, bool compareReturnType = true) {
		if (mCandidate is null || mCandidateSig is null || mMethod is null)
			return false;
		if (mCandidate.Name != mMethod.Name)
			return false;
		var options = compareReturnType ? 0 : SigComparerOptions.DontCompareReturnType;
		return new SigComparer(options).Equals(mCandidateSig, mMethodSig);
	}

	/// <summary>Whether <paramref name="candidate"/> has the shape of the interface method
	/// <paramref name="method"/>, read through the interface instance the candidate's type implements.</summary>
	public static bool MatchInterfaceMethod(MethodDef? candidate, MethodDef? method, ITypeDefOrRef interfaceContextType) {
		var genericInstSig = interfaceContextType.TryGetGenericInstSig();
		if (genericInstSig is not null)
			return MatchMethod(candidate, candidate?.MethodSig, method, GenericArgumentResolver.Resolve(method?.MethodSig, genericInstSig.GenericArguments, null));
		return MatchMethod(candidate, candidate?.MethodSig, method);
	}

	public static IEnumerable<PropertyDef> FindBaseProperties(IAnalyzerHost host, PropertyDef? property) =>
		FindBaseProperties(host, property, property?.DeclaringType);

	public static IEnumerable<PropertyDef> FindBaseProperties(IAnalyzerHost host, PropertyDef? property, TypeDef? declType) {
		if (property is null)
			yield break;
		bool isIndexer = property.IsIndexer(host);
		foreach (var baseType in BaseTypes(host, declType)) {
			var baseTypeDef = host.ResolveTypeDef(baseType);
			if (baseTypeDef is null)
				continue;
			foreach (var baseProperty in baseTypeDef.Properties) {
				if (MatchProperty(baseProperty, Resolve(baseProperty.PropertySig, baseType), property)
						&& IsVisibleFromDerived(baseProperty, declType)) {
					if (isIndexer != baseProperty.IsIndexer(host))
						continue;
					yield return baseProperty;
					var anyPropertyAccessor = baseProperty.GetMethod ?? baseProperty.SetMethod;
					if (anyPropertyAccessor is not null && anyPropertyAccessor.IsNewSlot == anyPropertyAccessor.IsVirtual)
						yield break;
				}
			}
		}
	}

	static bool MatchProperty(PropertyDef? mCandidate, MethodBaseSig? mCandidateSig, PropertyDef? mProperty) {
		if (mCandidate is null || mCandidateSig is null || mProperty is null)
			return false;
		if (mCandidate.Name != mProperty.Name)
			return false;
		return new SigComparer().Equals(mCandidateSig, mProperty.PropertySig);
	}

	public static IEnumerable<EventDef> FindBaseEvents(IAnalyzerHost host, EventDef? eventDef) =>
		FindBaseEvents(host, eventDef, eventDef?.DeclaringType);

	public static IEnumerable<EventDef> FindBaseEvents(IAnalyzerHost host, EventDef? eventDef, TypeDef? declType) {
		if (eventDef is null)
			yield break;
		var eventType = eventDef.EventType.ToTypeSig();
		foreach (var baseType in BaseTypes(host, declType)) {
			var baseTypeDef = host.ResolveTypeDef(baseType);
			if (baseTypeDef is null)
				continue;
			foreach (var baseEvent in baseTypeDef.Events) {
				if (MatchEvent(baseEvent, Resolve(baseEvent.EventType.ToTypeSig(), baseType), eventDef, eventType) &&
					IsVisibleFromDerived(baseEvent, declType)) {
					yield return baseEvent;
					var anyEventAccessor = baseEvent.AddMethod ?? baseEvent.RemoveMethod ?? baseEvent.InvokeMethod;
					if (anyEventAccessor is not null && anyEventAccessor.IsNewSlot == anyEventAccessor.IsVirtual)
						yield break;
				}
			}
		}
	}

	static bool MatchEvent(EventDef? mCandidate, TypeSig? mCandidateType, EventDef? mEvent, TypeSig? mEventType) {
		if (mCandidate is null || mCandidateType is null || mEvent is null || mEventType is null)
			return false;
		if (mCandidate.Name != mEvent.Name)
			return false;
		return new SigComparer().Equals(mCandidateType, mEventType);
	}

	/// <summary>Whether a base type's member can be seen from a derived type: not private, and an internal
	/// one only from the same module or an assembly the base's assembly made a friend of.</summary>
	public static bool IsVisibleFromDerived(IMemberDef? baseMember, TypeDef? derivedType) {
		if (baseMember is null || derivedType is null)
			return false;
		var attrs = GetAccessAttributes(baseMember) & MethodAttributes.MemberAccessMask;
		if (attrs == MethodAttributes.Private)
			return false;
		if (baseMember.DeclaringType.Module == derivedType.Module)
			return true;
		if (attrs == MethodAttributes.Assembly || attrs == MethodAttributes.FamANDAssem) {
			var derivedTypeAsm = derivedType.Module.Assembly;
			var asm = baseMember.DeclaringType.Module.Assembly;
			if (derivedTypeAsm is not null && asm is not null) {
				foreach (var attribute in asm.CustomAttributes) {
					if (!Compare(attribute.AttributeType, SystemRuntimeCompilerServices, InternalsVisibleToAttribute))
						continue;
					if (FriendName(attribute) is { } assemblyName && StringComparer.OrdinalIgnoreCase.Equals(assemblyName, derivedTypeAsm.Name))
						return true;
				}
				foreach (var attribute in derivedTypeAsm.CustomAttributes) {
					if (!Compare(attribute.AttributeType, SystemRuntimeCompilerServices, IgnoresAccessChecksToAttribute))
						continue;
					if (FriendName(attribute) is { } assemblyName && StringComparer.OrdinalIgnoreCase.Equals(assemblyName, asm.Name))
						return true;
				}
			}
			return false;
		}
		return true;
	}

	static string? FriendName(CustomAttribute attribute) {
		if (attribute.ConstructorArguments.Count == 0)
			return null;
		var value = attribute.ConstructorArguments[0].Value;
		var assemblyName = (value as UTF8String)?.String ?? value as string;
		return assemblyName is null ? null : new AssemblyNameInfo(assemblyName).Name;
	}

	static readonly UTF8String SystemRuntimeCompilerServices = new("System.Runtime.CompilerServices");
	static readonly UTF8String InternalsVisibleToAttribute = new("InternalsVisibleToAttribute");
	static readonly UTF8String IgnoresAccessChecksToAttribute = new("IgnoresAccessChecksToAttribute");

	static bool Compare(ITypeDefOrRef? type, UTF8String expNs, UTF8String expName) => type switch {
		TypeRef tr => tr.Namespace == expNs && tr.Name == expName,
		TypeDef td => td.Namespace == expNs && td.Name == expName,
		_ => false,
	};

	static MethodAttributes GetAccessAttributes(IMemberDef member) {
		if (member is FieldDef fld)
			return (MethodAttributes)fld.Attributes;
		if (member is MethodDef method)
			return method.Attributes;
		if (member is PropertyDef prop) {
			var accMeth = prop.GetMethod ?? prop.SetMethod;
			return accMeth is null ? 0 : accMeth.Attributes;
		}
		if (member is EventDef evnt) {
			var m = evnt.AddMethod ?? evnt.RemoveMethod ?? evnt.InvokeMethod;
			return m is null ? 0 : m.Attributes;
		}
		if (member is TypeDef nestedType) {
			if (nestedType.IsNestedPrivate)
				return MethodAttributes.Private;
			if (nestedType.IsNestedAssembly || nestedType.IsNestedFamilyAndAssembly)
				return MethodAttributes.Assembly;
			return MethodAttributes.Public;
		}
		return 0;
	}

	/// <summary>The base types of a type, each written in the derived type's terms: <c>Base&lt;int&gt;</c>
	/// for <c>Derived : Base&lt;int&gt;</c>, then that type's own base with the same substitution.</summary>
	static IEnumerable<TypeSig> BaseTypes(IAnalyzerHost host, TypeDef? typeDef) {
		if (typeDef?.BaseType is null)
			yield break;
		TypeSig? baseType = typeDef.ToTypeSig();
		do {
			var genericArgs = baseType is GenericInstSig gis ? gis.GenericArguments : null;
			baseType = GenericArgumentResolver.Resolve(typeDef.BaseType.ToTypeSig(), genericArgs, null);
			if (baseType is null)
				yield break;
			yield return baseType;
			typeDef = host.ResolveTypeDef(typeDef.BaseType);
			if (typeDef is null)
				break;
		} while (typeDef.BaseType is not null);
	}

	public static IEnumerable<TypeSig> GetTypeAndBaseTypes(IAnalyzerHost host, TypeDef? type) {
		if (type is null)
			yield break;
		yield return type.ToTypeSig();
		foreach (var baseType in BaseTypes(host, type))
			yield return baseType;
	}

	static TypeSig? Resolve(TypeSig? type, TypeSig? typeContext) =>
		GenericArgumentResolver.Resolve(type, (typeContext as GenericInstSig)?.GenericArguments, null);

	static MethodBaseSig? Resolve(MethodBaseSig? method, TypeSig? typeContext) =>
		GenericArgumentResolver.Resolve(method, (typeContext as GenericInstSig)?.GenericArguments, null);
}
