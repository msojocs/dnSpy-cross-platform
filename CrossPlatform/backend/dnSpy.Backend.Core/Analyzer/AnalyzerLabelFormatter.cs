using System.Text;
using dnlib.DotNet;

namespace dnSpy.Backend.Core.Analyzer;

/// <summary>
/// The text of an analyzer row the way dnSpy's analyzer nodes write it through the C# decompiler: a type
/// by its own name (<c>List&lt;T&gt;</c>), a member after its declaring type with the namespace
/// (<c>NS.Outer.Inner.Method(int) : void</c>). The token and the "(hides)" prefix are the client's to add.
/// </summary>
static class AnalyzerLabelFormatter {
	public static string Label(IAnalyzerHost host, object entity) => entity switch {
		// IDecompiler.WriteName → FormatTypeName: no namespace, no enclosing type, no keywords.
		TypeDef type => CSharpTypeName.Of(null, type, CSharpTypeName.Options.DoNotUsePrimitiveTypeNames | CSharpTypeName.Options.DoNotIncludeEnclosingType) ?? type.Name.String,
		MethodDef method => $"{DeclaringType(method.DeclaringType)}.{Method(method)}",
		FieldDef field => $"{DeclaringType(field.DeclaringType)}.{field.Name} : {CSharpTypeName.Of(field, field.FieldSig?.Type) ?? "???"}",
		PropertyDef property => $"{DeclaringType(property.DeclaringType)}.{PropertyName(host, property)} : {CSharpTypeName.Of(property, property.PropertySig?.GetRetType())}",
		EventDef @event => $"{DeclaringType(@event.DeclaringType)}.{@event.Name} : {CSharpTypeName.Of(@event, @event.EventType)}",
		AssemblyDef assembly => Assembly(assembly),
		ModuleDef module => module.Name.String,
		_ => entity.ToString() ?? string.Empty,
	};

	/// <summary>The decompiler's WriteType with includeNamespace: "NS.Outer.Inner&lt;T&gt;".</summary>
	static string DeclaringType(TypeDef? type) =>
		CSharpTypeName.Of(null, type, CSharpTypeName.Options.IncludeNamespace) ?? string.Empty;

	/// <summary>
	/// NodeFormatter's method text: the name — a constructor named after its type — the parameter types,
	/// "..." for a vararg method, and the return type after a colon.
	/// </summary>
	public static string Method(MethodDef method) {
		var builder = new StringBuilder();
		builder.Append(method.Name == ".ctor" ? method.DeclaringType.Name.String : method.Name.String);
		builder.Append('(');
		var parameters = method.Parameters.Where(p => !p.IsHiddenThisParameter).ToList();
		builder.AppendJoin(", ", parameters.Select(p => CSharpTypeName.Of(p.ParamDef, p.Type) ?? string.Empty));
		var callConv = method.MethodSig is null ? 0 : method.MethodSig.CallingConvention & CallingConvention.Mask;
		if (callConv == CallingConvention.VarArg || callConv == CallingConvention.NativeVarArg) {
			if (method.MethodSig.GetParamCount() > 0)
				builder.Append(", ");
			builder.Append("...");
		}
		builder.Append(") : ");
		builder.Append(CSharpTypeName.Of(method.Parameters.ReturnParameter.ParamDef, method.ReturnType));
		return builder.ToString();
	}

	/// <summary>
	/// The decompiler's FormatPropertyName: an indexer is "this[...]", after the interface it implements
	/// explicitly when it does; any other property is its name.
	/// </summary>
	static string PropertyName(IAnalyzerHost host, PropertyDef property) {
		if (!property.IsIndexer(host))
			return property.Name.String;
		var builder = new StringBuilder();
		var accessor = property.GetMethod ?? property.SetMethod;
		if (accessor is not null && accessor.HasOverrides) {
			builder.Append(CSharpTypeName.Of(null, accessor.Overrides[0].MethodDeclaration?.DeclaringType, CSharpTypeName.Options.IncludeNamespace));
			builder.Append('.');
		}
		builder.Append("this[");
		builder.AppendJoin(", ", property.PropertySig.GetParams().Select(p => CSharpTypeName.Of(null, p.ToTypeDefOrRef(), CSharpTypeName.Options.IncludeNamespace) ?? string.Empty));
		builder.Append(']');
		return builder.ToString();
	}

	/// <summary>The full assembly name the way dnSpy writes an <c>IAssembly</c>.</summary>
	static string Assembly(AssemblyDef assembly) {
		var builder = new StringBuilder();
		builder.Append(assembly.Name.String);
		builder.Append(", Version=").Append(assembly.Version);
		builder.Append(", Culture=").Append(UTF8String.IsNullOrEmpty(assembly.Culture) ? "neutral" : assembly.Culture.String);
		var publicKey = PublicKeyBase.ToPublicKeyToken(assembly.PublicKeyOrToken);
		builder.Append(publicKey is null || publicKey is PublicKeyToken ? ", PublicKeyToken=" : ", PublicKey=");
		builder.Append(PublicKeyBase.IsNullOrEmpty2(publicKey) ? "null" : publicKey!.ToString());
		if ((assembly.Attributes & AssemblyAttributes.Retargetable) != 0)
			builder.Append(", Retargetable=Yes");
		if ((assembly.Attributes & AssemblyAttributes.ContentType_Mask) == AssemblyAttributes.ContentType_WindowsRuntime)
			builder.Append(", ContentType=WindowsRuntime");
		return builder.ToString();
	}
}
