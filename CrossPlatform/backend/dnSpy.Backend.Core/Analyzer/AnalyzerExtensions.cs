using dnlib.DotNet;

namespace dnSpy.Backend.Core.Analyzer;

/// <summary>The parts of dnSpy's <c>dnSpy.Contracts.Decompiler.Extensions</c> the analyzer uses.</summary>
static class AnalyzerExtensions {
	/// <summary>The type a TypeSpec is built on: the generic type of an instance, the type itself for a
	/// plain signature. Unlike dnlib's ScopeType an array stays the TypeSpec it is.</summary>
	public static ITypeDefOrRef? GetScopeType(this ITypeDefOrRef? type) {
		if (type is TypeSpec ts) {
			var sig = ts.TypeSig.RemovePinnedAndModifiers();
			if (sig is GenericInstSig gis)
				return gis.GenericType?.TypeDefOrRef;
			if (sig is TypeDefOrRefSig tdrs)
				return tdrs.TypeDefOrRef;
		}
		return type;
	}

	public static IType? GetScopeType(this IType? type) {
		if (type is TypeDef td)
			return td;
		if (type is TypeRef tr)
			return tr;
		if (type is not TypeSig sig) {
			if (type is not TypeSpec ts)
				return type;
			sig = ts.TypeSig;
		}
		sig = sig.RemovePinnedAndModifiers();
		if (sig is GenericInstSig gis)
			return gis.GenericType?.TypeDefOrRef;
		if (sig is TypeDefOrRefSig tdrs)
			return tdrs.TypeDefOrRef;
		return type;
	}

	public static bool IsDefined(this IHasCustomAttribute? provider, UTF8String? @namespace, UTF8String? name) {
		if (provider is null || provider.CustomAttributes.Count == 0)
			return false;
		foreach (var ca in provider.CustomAttributes) {
			if (ca.AttributeType is TypeRef tr) {
				if (tr.Namespace == @namespace && tr.Name == name)
					return true;
				continue;
			}
			if (ca.AttributeType is TypeDef td) {
				if (td.Namespace == @namespace && td.Name == name)
					return true;
				continue;
			}
			if (ca.AttributeType is TypeSpec ts && ts.ScopeType is { } scopeType) {
				if (scopeType.Namespace == @namespace && scopeType.Name == name)
					return true;
			}
		}
		return false;
	}

	public static IList<Parameter> GetParameters(this IMethod? method) {
		if (method is null || method.MethodSig is null)
			return new List<Parameter>();
		if (method is MethodDef md)
			return md.Parameters;
		var list = new List<Parameter>();
		int paramIndex = 0, methodSigIndex = 0;
		if (method.MethodSig.HasThis)
			list.Add(new Parameter(paramIndex++, Parameter.HIDDEN_THIS_METHOD_SIG_INDEX, method.DeclaringType.ToTypeSig()));
		foreach (var type in method.MethodSig.GetParams())
			list.Add(new Parameter(paramIndex++, methodSigIndex++, type));
		return list;
	}

	/// <summary>Whether a property is the type's indexer: it has parameters and is the member the type's
	/// [DefaultMember] names — the base property's type for an explicit implementation.</summary>
	public static bool IsIndexer(this PropertyDef? property, IAnalyzerHost? host) {
		if (property is null || property.PropertySig.GetParamCount() == 0)
			return false;
		var accessor = property.GetMethod ?? property.SetMethod;
		var basePropDef = property;
		if (accessor is not null && accessor.HasOverrides) {
			var baseAccessor = host?.ResolveMethodDef(accessor.Overrides[0].MethodDeclaration);
			if (baseAccessor is null)
				return false;
			foreach (var baseProp in baseAccessor.DeclaringType.Properties) {
				if (baseProp.GetMethod == baseAccessor || baseProp.SetMethod == baseAccessor) {
					basePropDef = baseProp;
					break;
				}
			}
		}
		return GetDefaultMemberName(basePropDef.DeclaringType) == basePropDef.Name;
	}

	static string? GetDefaultMemberName(TypeDef? type) {
		if (type is null)
			return null;
		foreach (var ca in type.CustomAttributes.FindAll("System.Reflection.DefaultMemberAttribute")) {
			if (ca.Constructor is not null && ca.Constructor.FullName == "System.Void System.Reflection.DefaultMemberAttribute::.ctor(System.String)" &&
				ca.ConstructorArguments.Count == 1) {
				var value = ca.ConstructorArguments[0].Value;
				var memberName = (value as UTF8String)?.String ?? value as string;
				if (memberName is not null)
					return memberName;
			}
		}
		return null;
	}
}
