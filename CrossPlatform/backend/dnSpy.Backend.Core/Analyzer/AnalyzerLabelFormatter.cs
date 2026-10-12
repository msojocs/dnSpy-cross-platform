using dnlib.DotNet;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core.Analyzer;

/// <summary>
/// The text of an analyzer row the way dnSpy's analyzer nodes write it through the C# decompiler: a type
/// by its own name (<c>List&lt;T&gt;</c>), a member after its declaring type with the namespace
/// (<c>NS.Outer.Inner.Method(int) : void</c>) — each stretch in the color class dnSpy's syntax highlighting
/// gives it. The token and the "(hides)" prefix are the client's to add.
/// </summary>
static class AnalyzerLabelFormatter {
	public static void Write(TextPartsBuilder output, IAnalyzerHost host, object entity, Func<ITypeDefOrRef, string>? typeColor) {
		switch (entity) {
		case TypeDef type:
			// IDecompiler.WriteName → FormatTypeName: no namespace, no enclosing type, no keywords.
			if (!CSharpTypeName.Write(output, null, type, CSharpTypeName.Options.DoNotUsePrimitiveTypeNames | CSharpTypeName.Options.DoNotIncludeEnclosingType, typeColor))
				output.Write(MetadataTextColors.Of(type), type.Name.String);
			break;
		case MethodDef method:
			WriteDeclaringType(output, method.DeclaringType, typeColor);
			Method(output, method, typeColor);
			break;
		case FieldDef field:
			WriteDeclaringType(output, field.DeclaringType, typeColor);
			output.Write(MetadataTextColors.Of(field), field.Name.String).WriteColon();
			if (!CSharpTypeName.Write(output, field, field.FieldSig?.Type, typeColor))
				output.Write(TextColors.Error, "???");
			break;
		case PropertyDef property:
			WriteDeclaringType(output, property.DeclaringType, typeColor);
			PropertyName(output, host, property, typeColor);
			output.WriteColon();
			CSharpTypeName.Write(output, property, property.PropertySig?.GetRetType(), typeColor);
			break;
		case EventDef @event:
			WriteDeclaringType(output, @event.DeclaringType, typeColor);
			output.Write(MetadataTextColors.Of(@event), @event.Name.String).WriteColon();
			CSharpTypeName.Write(output, @event, @event.EventType, CSharpTypeName.Options.None, typeColor);
			break;
		case AssemblyDef assembly:
			output.WriteAssembly(assembly);
			break;
		case ModuleDef module:
			output.Write(TextColors.AssemblyModule, module.Name.String);
			break;
		default:
			output.Write(TextColors.Text, entity.ToString());
			break;
		}
	}

	/// <summary>The decompiler's WriteType with includeNamespace — "NS.Outer.Inner&lt;T&gt;" — and the dot
	/// before the member's name.</summary>
	static void WriteDeclaringType(TextPartsBuilder output, TypeDef? type, Func<ITypeDefOrRef, string>? typeColor) {
		CSharpTypeName.Write(output, null, type, CSharpTypeName.Options.IncludeNamespace, typeColor);
		output.Write(TextColors.Operator, ".");
	}

	/// <summary>
	/// NodeFormatter's method text: the name — a constructor named after its type — the parameter types,
	/// "..." for a vararg method, and the return type after a colon.
	/// </summary>
	static void Method(TextPartsBuilder output, MethodDef method, Func<ITypeDefOrRef, string>? typeColor) {
		output.Write(MetadataTextColors.Of(method), method.Name == ".ctor" ? method.DeclaringType.Name.String : method.Name.String);
		output.Write(TextColors.Punctuation, "(");
		var first = true;
		foreach (var parameter in method.Parameters) {
			if (parameter.IsHiddenThisParameter)
				continue;
			if (!first)
				output.WriteCommaSpace();
			first = false;
			CSharpTypeName.Write(output, parameter.ParamDef, parameter.Type, typeColor);
		}
		var callConv = method.MethodSig is null ? 0 : method.MethodSig.CallingConvention & CallingConvention.Mask;
		if (callConv == CallingConvention.VarArg || callConv == CallingConvention.NativeVarArg) {
			if (method.MethodSig!.GetParamCount() > 0)
				output.WriteCommaSpace();
			output.Write(TextColors.Operator, "...");
		}
		output.Write(TextColors.Punctuation, ")").WriteColon();
		CSharpTypeName.Write(output, method.Parameters.ReturnParameter.ParamDef, method.ReturnType, typeColor);
	}

	/// <summary>
	/// The decompiler's FormatPropertyName: an indexer is "this[...]", after the interface it implements
	/// explicitly when it does; any other property is its name.
	/// </summary>
	static void PropertyName(TextPartsBuilder output, IAnalyzerHost host, PropertyDef property, Func<ITypeDefOrRef, string>? typeColor) {
		if (!property.IsIndexer(host)) {
			output.Write(MetadataTextColors.Of(property), property.Name.String);
			return;
		}
		var accessor = property.GetMethod ?? property.SetMethod;
		if (accessor is not null && accessor.HasOverrides) {
			CSharpTypeName.Write(output, null, accessor.Overrides[0].MethodDeclaration?.DeclaringType, CSharpTypeName.Options.IncludeNamespace, typeColor);
			output.Write(TextColors.Operator, ".");
		}
		output.Write(TextColors.Keyword, "this").Write(TextColors.Punctuation, "[");
		var first = true;
		foreach (var parameter in property.PropertySig.GetParams()) {
			if (!first)
				output.WriteCommaSpace();
			first = false;
			CSharpTypeName.Write(output, null, parameter.ToTypeDefOrRef(), CSharpTypeName.Options.IncludeNamespace, typeColor);
		}
		output.Write(TextColors.Punctuation, "]");
	}
}
