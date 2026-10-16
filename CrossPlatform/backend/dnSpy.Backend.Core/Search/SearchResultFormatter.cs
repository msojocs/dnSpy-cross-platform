using System.Globalization;
using dnlib.DotNet;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core.Search;

/// <summary>
/// The text of a search result the way dnSpy's search list writes it through the decompiler that is selected —
/// SearchResult.CreateUI and CreateToolTipUI. A member goes through the decompiler's Write with its default options
/// less the parameter names, the declaring types and the field values: the C# formatter for C# and both IL views,
/// which do not override it ("void Main(string[])"), and the Visual Basic one for VB ("Sub Main(String())"). A type
/// goes through the decompiler's WriteType: by its name, or as a location with its namespace — "List&lt;T&gt;" in C#,
/// "List(Of T)" in VB, "System.Collections.Generic.List`1" in IL.
/// </summary>
static class SearchResultFormatter {
	/// <summary>FormatterOptions.Default &amp; ~(ShowParameterNames | ShowDeclaringTypes | ShowFieldLiteralValues).</summary>
	const CSharpMemberFormatter.Options NameOptions =
		CSharpMemberFormatter.Options.ParameterTypes | CSharpMemberFormatter.Options.ReturnTypes
		| CSharpMemberFormatter.Options.FieldTypes | CSharpMemberFormatter.Options.IntrinsicTypeKeywords;

	/// <summary>DecompilerBase's DefaultFormatterOptions — FormatterOptions.Default | ShowParameterLiteralValues — which
	/// a decompiler's WriteToolTip writes with.</summary>
	const CSharpMemberFormatter.Options ToolTipOptions =
		CSharpMemberFormatter.Options.ParameterTypes | CSharpMemberFormatter.Options.ParameterNames | CSharpMemberFormatter.Options.DeclaringTypes
		| CSharpMemberFormatter.Options.ReturnTypes | CSharpMemberFormatter.Options.FieldTypes | CSharpMemberFormatter.Options.IntrinsicTypeKeywords
		| CSharpMemberFormatter.Options.FieldLiteralValues | CSharpMemberFormatter.Options.ParameterLiteralValues;

	/// <summary>SearchResult.CreateUI.</summary>
	public static void Write(TextPartsBuilder output, object? value, bool includeNamespace, DecompilerLanguage language, Func<ITypeDefOrRef, string> typeColor) {
		switch (value) {
		case SearchNamespace ns:
			output.WriteNamespace(ns.Name);
			break;
		case TypeDef type:
			WriteType(output, type, includeNamespace, language, typeColor);
			break;
		case MethodDef method:
			WriteMember(output, method, language, typeColor);
			if (method.ImplMap is { } implMap && !UTF8String.IsNullOrEmpty(implMap.Name) && implMap.Name != method.Name) {
				output.WriteSpace().Write(TextColors.Punctuation, "(");
				output.Write(MetadataTextColors.Of(method), implMap.Name.String);
				output.Write(TextColors.Punctuation, ")");
			}
			break;
		case IMemberDef member:
			WriteMember(output, member, language, typeColor);
			break;
		default:
			WriteOther(output, value);
			break;
		}
	}

	/// <summary>
	/// SearchResult.CreateToolTipUI: a member through the decompiler's WriteToolTip — the IL views write one the
	/// way their disassembler does — then, for a match in a method body, the instruction it was found at; and last
	/// <paramref name="assemblyLocation"/>, the file the result is in (SearchResult.GetAssemblyLocation). The lines are
	/// parted with a line break.
	/// </summary>
	public static void WriteToolTip(TextPartsBuilder output, SearchHit hit, string? assemblyLocation, DecompilerLanguage language, Func<ITypeDefOrRef, string> typeColor) {
		switch (hit.NameObject) {
		case SearchNamespace ns:
			output.WriteNamespace(ns.Name);
			break;
		case TypeDef type:
			WriteType(output, type, includeNamespace: false, language, typeColor);
			break;
		case IMemberDef member:
			WriteMemberToolTip(output, member, language, typeColor);
			if (hit.Body is { } body) {
				output.Write(TextColors.Text, "\n");
				output.Write(TextColors.Label, "IL_" + body.ILOffset.ToString("X4", CultureInfo.InvariantCulture));
				output.Write(TextColors.Punctuation, ":").WriteSpace();
				output.Write(TextColors.OpCode, body.OpCode.Name).WriteSpace();
				WriteOperand(output, body.Operand, typeColor);
			}
			break;
		default:
			WriteOther(output, hit.NameObject);
			break;
		}
		if (assemblyLocation is not null)
			output.Write(TextColors.Text, "\n").WriteFilename(assemblyLocation);
	}

	/// <summary>The part of CreateUI every language writes alike.</summary>
	static void WriteOther(TextPartsBuilder output, object? value) {
		switch (value) {
		case AssemblyDef assembly:
			output.WriteAssembly(assembly);
			break;
		case ModuleDef module:
			output.Write(TextColors.AssemblyModule, module.FullName);
			break;
		case AssemblyRef assemblyRef:
			output.WriteAssembly(assemblyRef);
			break;
		case ModuleRef moduleRef:
			output.Write(TextColors.AssemblyModule, moduleRef.FullName);
			break;
		case ParamDef parameter:
			output.Write(TextColors.Parameter, parameter.Name.String);
			break;
		case GenericParam genericParam:
			output.Write(genericParam.DeclaringMethod is not null ? TextColors.MethodGenericParameter : TextColors.TypeGenericParameter, genericParam.Name.String);
			break;
		case Resource resource:
			output.WriteFilename(resource.Name.String);
			break;
		case SearchResourceElement element:
			output.WriteFilename(element.Element.Name);
			break;
		case WorkspaceManager.IModuleEntry file:
			// A file that is not a .NET module.
			output.Write(TextColors.Text, ResourceTexts.ShortName(file.Path));
			break;
		}
	}

	/// <summary>IDecompiler.WriteType: C#'s and VB's own conversion of the type, the IL decompiler's ILSpy name.</summary>
	static void WriteType(TextPartsBuilder output, TypeDef type, bool includeNamespace, DecompilerLanguage language, Func<ITypeDefOrRef, string> typeColor) {
		var options = includeNamespace ? CSharpTypeName.Options.IncludeNamespace : CSharpTypeName.Options.None;
		switch (language) {
		case DecompilerLanguage.CSharp:
			if (!CSharpTypeName.Write(output, null, type, options, typeColor))
				output.Write(MetadataTextColors.Of(type), type.Name.String);
			break;
		case DecompilerLanguage.VisualBasic:
			if (!CSharpTypeName.WriteVisualBasic(output, null, type, options, typeColor))
				output.Write(MetadataTextColors.Of(type), type.Name.String);
			break;
		default:
			ILTypeName.Write(output, type, includeNamespace ? ILTypeName.Syntax.TypeName : ILTypeName.Syntax.ShortTypeName, typeColor);
			break;
		}
	}

	/// <summary>IDecompiler.Write: only Visual Basic has a formatter of its own.</summary>
	static void WriteMember(TextPartsBuilder output, IMemberDef member, DecompilerLanguage language, Func<ITypeDefOrRef, string> typeColor) {
		if (language == DecompilerLanguage.VisualBasic)
			VisualBasicMemberFormatter.Write(output, member, NameOptions, typeColor);
		else
			CSharpMemberFormatter.Write(output, member, NameOptions, typeColor);
	}

	/// <summary>IDecompiler.WriteToolTip: the IL decompilers write what their disassembler would, VB its formatter's.</summary>
	static void WriteMemberToolTip(TextPartsBuilder output, IMemberDef member, DecompilerLanguage language, Func<ITypeDefOrRef, string> typeColor) {
		switch (language) {
		case DecompilerLanguage.VisualBasic:
			VisualBasicMemberFormatter.WriteToolTip(output, member, ToolTipOptions, typeColor);
			break;
		case DecompilerLanguage.IL or DecompilerLanguage.ILWithCSharp when ILMemberFormatter.WriteToolTip(output, member, typeColor):
			break;
		default:
			CSharpMemberFormatter.WriteToolTip(output, member, ToolTipOptions, typeColor);
			break;
		}
	}

	/// <summary>SearchResult.WriteOperand: a string quoted and escaped, a float in its round-trip form — a zero with
	/// its sign, an infinity or a NaN as its bytes — and anything else as dnlib writes it.</summary>
	static void WriteOperand(TextPartsBuilder output, object? operand, Func<ITypeDefOrRef, string> typeColor) {
		switch (operand) {
		case null:
			return;
		case string text:
			output.Write(TextColors.String, "\"" + EscapeString(text) + "\"");
			return;
		case float value:
			output.Write(TextColors.Number, value == 0 ? (1 / value == float.NegativeInfinity ? "-0.0" : "0.0")
				: float.IsInfinity(value) || float.IsNaN(value) ? string.Join(" ", BitConverter.GetBytes(value).Select(b => b.ToString("X2", CultureInfo.InvariantCulture)))
				: value.ToString("R", CultureInfo.InvariantCulture));
			return;
		case double value:
			output.Write(TextColors.Number, value == 0 ? (1 / value == double.NegativeInfinity ? "-0.0" : "0.0")
				: double.IsInfinity(value) || double.IsNaN(value) ? string.Join(" ", BitConverter.GetBytes(value).Select(b => b.ToString("X2", CultureInfo.InvariantCulture)))
				: value.ToString("R", CultureInfo.InvariantCulture));
			return;
		}
		output.Write(OperandColor(operand, typeColor), Convert.ToString(operand, CultureInfo.InvariantCulture));
	}

	/// <summary>MetadataTextColorProvider.GetColor(object). A literal search only stops at an instruction that loads
	/// a number or a string, so a member operand is colored by what it is without resolving it.</summary>
	static string OperandColor(object operand, Func<ITypeDefOrRef, string> typeColor) => operand switch {
		sbyte or byte or short or ushort or int or uint or long or ulong or nint or nuint => TextColors.Number,
		IMemberDef member => MetadataTextColors.Of(member),
		ITypeDefOrRef type => typeColor(type),
		IMethod => TextColors.InstanceMethod,
		IField => TextColors.InstanceField,
		Parameter => TextColors.Parameter,
		dnlib.DotNet.Emit.Local => TextColors.Local,
		_ => TextColors.Text,
	};

	/// <summary>IdentifierEscaper.Escape(str, true): the escapes a C# string literal takes.</summary>
	static string EscapeString(string text) {
		var escaped = new System.Text.StringBuilder(text.Length);
		foreach (var ch in text) {
			switch (ch) {
			case '\\': escaped.Append(@"\\"); break;
			case '"': escaped.Append("\\\""); break;
			case '\0': escaped.Append(@"\0"); break;
			case '\a': escaped.Append(@"\a"); break;
			case '\b': escaped.Append(@"\b"); break;
			case '\f': escaped.Append(@"\f"); break;
			case '\n': escaped.Append(@"\n"); break;
			case '\r': escaped.Append(@"\r"); break;
			case '\t': escaped.Append(@"\t"); break;
			case '\v': escaped.Append(@"\v"); break;
			default:
				if (char.IsControl(ch) || char.IsSurrogate(ch) || char.GetUnicodeCategory(ch) is UnicodeCategory.Format or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator)
					escaped.Append(@"\u").Append(((int)ch).ToString("X4", CultureInfo.InvariantCulture));
				else
					escaped.Append(ch);
				break;
			}
		}
		return escaped.ToString();
	}
}
