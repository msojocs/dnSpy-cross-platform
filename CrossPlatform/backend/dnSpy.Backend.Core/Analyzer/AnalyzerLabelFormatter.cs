using dnlib.DotNet;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core.Analyzer;

/// <summary>
/// The text of an analyzer row the way dnSpy's analyzer nodes write it through the decompiler that is
/// selected: a type by its own name (<c>List&lt;T&gt;</c>), a member after its declaring type with the
/// namespace (<c>NS.Outer.Inner.Method(int) : void</c>) — each stretch in the color class dnSpy's syntax
/// highlighting gives it. The names are NodeFormatter's and the same in every language; the types are the
/// decompiler's own (<c>Integer</c> in VB, <c>int32</c> in IL), and so is a type row and an indexer's name.
/// The token and the "(hides)" prefix are the client's to add.
/// </summary>
static class AnalyzerLabelFormatter {
	public static void Write(TextPartsBuilder output, IAnalyzerHost host, object entity, DecompilerLanguage language, Func<ITypeDefOrRef, string>? typeColor) {
		switch (entity) {
		case TypeDef type:
			WriteTypeName(output, type, language, typeColor);
			break;
		case MethodDef method:
			WriteDeclaringType(output, method.DeclaringType, language, typeColor);
			Method(output, method, language, typeColor);
			break;
		case FieldDef field:
			WriteDeclaringType(output, field.DeclaringType, language, typeColor);
			output.Write(MetadataTextColors.Of(field), field.Name.String).WriteColon();
			if (!WriteType(output, field, field.FieldSig?.Type?.ToTypeDefOrRef(), language, typeColor))
				output.Write(TextColors.Error, "???");
			break;
		case PropertyDef property:
			WriteDeclaringType(output, property.DeclaringType, language, typeColor);
			PropertyName(output, host, property, language, typeColor);
			output.WriteColon();
			WriteType(output, property, property.PropertySig?.GetRetType()?.ToTypeDefOrRef(), language, typeColor);
			break;
		case EventDef @event:
			WriteDeclaringType(output, @event.DeclaringType, language, typeColor);
			output.Write(MetadataTextColors.Of(@event), @event.Name.String).WriteColon();
			WriteType(output, @event, @event.EventType, language, typeColor);
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

	/// <summary>
	/// IDecompiler.WriteName → FormatTypeName. C# and VB convert the type without its namespace, its enclosing
	/// type or a keyword for its name; the IL decompiler leaves FormatTypeName alone and writes the name as the
	/// metadata has it, arity and all.
	/// </summary>
	static void WriteTypeName(TextPartsBuilder output, TypeDef type, DecompilerLanguage language, Func<ITypeDefOrRef, string>? typeColor) {
		const CSharpTypeName.Options options = CSharpTypeName.Options.DoNotUsePrimitiveTypeNames | CSharpTypeName.Options.DoNotIncludeEnclosingType;
		var written = language switch {
			DecompilerLanguage.CSharp => CSharpTypeName.Write(output, null, type, options, typeColor),
			DecompilerLanguage.VisualBasic => CSharpTypeName.WriteVisualBasic(output, null, type, options, typeColor),
			_ => false,
		};
		if (!written)
			output.Write(MetadataTextColors.Of(type), type.Name.String);
	}

	/// <summary>The decompiler's WriteType with includeNamespace — "NS.Outer.Inner&lt;T&gt;" in C#,
	/// "NS.Outer/Inner`1" in IL — and the dot before the member's name.</summary>
	static void WriteDeclaringType(TextPartsBuilder output, TypeDef? type, DecompilerLanguage language, Func<ITypeDefOrRef, string>? typeColor) {
		switch (language) {
		case DecompilerLanguage.CSharp:
			CSharpTypeName.Write(output, null, type, CSharpTypeName.Options.IncludeNamespace, typeColor);
			break;
		case DecompilerLanguage.VisualBasic:
			CSharpTypeName.WriteVisualBasic(output, null, type, CSharpTypeName.Options.IncludeNamespace, typeColor);
			break;
		default:
			ILTypeName.Write(output, type, ILTypeName.Syntax.TypeName, typeColor);
			break;
		}
		output.Write(TextColors.Operator, ".");
	}

	/// <summary>The decompiler's WriteType without the namespace, which NodeFormatter writes every type of a
	/// member's signature with. Answers whether there was a type to write.</summary>
	static bool WriteType(TextPartsBuilder output, IHasCustomAttribute? attributeProvider, ITypeDefOrRef? type, DecompilerLanguage language, Func<ITypeDefOrRef, string>? typeColor) {
		switch (language) {
		case DecompilerLanguage.CSharp:
			return CSharpTypeName.Write(output, attributeProvider, type, CSharpTypeName.Options.None, typeColor);
		case DecompilerLanguage.VisualBasic:
			return CSharpTypeName.WriteVisualBasic(output, attributeProvider, type, CSharpTypeName.Options.None, typeColor);
		default:
			if (type is null)
				return false;
			ILTypeName.Write(output, type, ILTypeName.Syntax.ShortTypeName, typeColor);
			return true;
		}
	}

	/// <summary>
	/// NodeFormatter's method text: the name — a constructor named after its type — the parameter types,
	/// "..." for a vararg method, and the return type after a colon.
	/// </summary>
	static void Method(TextPartsBuilder output, MethodDef method, DecompilerLanguage language, Func<ITypeDefOrRef, string>? typeColor) {
		output.Write(MetadataTextColors.Of(method), method.Name == ".ctor" ? method.DeclaringType.Name.String : method.Name.String);
		output.Write(TextColors.Punctuation, "(");
		var first = true;
		foreach (var parameter in method.Parameters) {
			if (parameter.IsHiddenThisParameter)
				continue;
			if (!first)
				output.WriteCommaSpace();
			first = false;
			WriteType(output, parameter.ParamDef, parameter.Type?.ToTypeDefOrRef(), language, typeColor);
		}
		var callConv = method.MethodSig is null ? 0 : method.MethodSig.CallingConvention & CallingConvention.Mask;
		if (callConv == CallingConvention.VarArg || callConv == CallingConvention.NativeVarArg) {
			if (method.MethodSig!.GetParamCount() > 0)
				output.WriteCommaSpace();
			output.Write(TextColors.Operator, "...");
		}
		output.Write(TextColors.Punctuation, ")").WriteColon();
		WriteType(output, method.Parameters.ReturnParameter.ParamDef, method.ReturnType?.ToTypeDefOrRef(), language, typeColor);
	}

	/// <summary>
	/// The decompiler's FormatPropertyName. The C# one writes an indexer as "this[...]", after the interface it
	/// implements explicitly when it does; VB and IL keep the base one, which is the property's name.
	/// </summary>
	static void PropertyName(TextPartsBuilder output, IAnalyzerHost host, PropertyDef property, DecompilerLanguage language, Func<ITypeDefOrRef, string>? typeColor) {
		if (language != DecompilerLanguage.CSharp || !property.IsIndexer(host)) {
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
