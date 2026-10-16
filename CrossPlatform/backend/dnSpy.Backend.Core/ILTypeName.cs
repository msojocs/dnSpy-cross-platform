using System.Globalization;
using System.Reflection;
using System.Text;
using dnlib.DotNet;
using dnlib.DotNet.Emit;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core;

/// <summary>
/// The IL decompiler's type names — ILSpy's DisassemblerHelpers.WriteTo as dnSpy's ILDecompiler.TypeToString
/// calls it: a built-in type as its IL keyword ("int32", "string"), a type of another assembly in a signature
/// as "class [System.Runtime]System.Collections.Generic.List`1&lt;string&gt;", a nested type as
/// "Outer/Inner", a generic parameter as "!T" or "!!T", and a name the assembler could not read back quoted.
/// </summary>
static class ILTypeName {
	/// <summary>ILSpy's ILNameSyntax.</summary>
	public enum Syntax {
		/// <summary>class/valuetype + TypeName (built-in types use keyword syntax).</summary>
		Signature,
		/// <summary>Like Signature, but type parameters are always written by their position.</summary>
		SignatureNoNamedTypeParameters,
		/// <summary>[assembly]Full.Type.Name, even for built-in types.</summary>
		TypeName,
		/// <summary>The name alone, built-in types as keywords.</summary>
		ShortTypeName,
	}

	enum ThreeState : byte {
		Unknown,
		No,
		Yes,
	}

	// DisassemblerHelpers.MAX_CONVERTTYPE_DEPTH
	const int MaxDepth = 50;

	static readonly char[] ValidNonLetterIdentifierCharacters = ['_', '$', '@', '?', '`', '.'];

	static readonly HashSet<string> Keywords = BuildKeywords(
		"abstract", "algorithm", "alignment", "ansi", "any", "arglist",
		"array", "as", "assembly", "assert", "at", "auto", "autochar", "beforefieldinit",
		"blob", "blob_object", "bool", "brnull", "brnull.s", "brzero", "brzero.s", "bstr",
		"bytearray", "byvalstr", "callmostderived", "carray", "catch", "cdecl", "cf",
		"char", "cil", "class", "clsid", "const", "currency", "custom", "date", "decimal",
		"default", "demand", "deny", "endmac", "enum", "error", "explicit", "extends", "extern",
		"false", "famandassem", "family", "famorassem", "fastcall", "fault", "field", "filetime",
		"filter", "final", "finally", "fixed", "float", "float32", "float64", "forwardref",
		"fromunmanaged", "handler", "hidebysig", "hresult", "idispatch", "il", "illegal",
		"implements", "implicitcom", "implicitres", "import", "in", "inheritcheck", "init",
		"initonly", "instance", "int", "int16", "int32", "int64", "int8", "interface", "internalcall",
		"iunknown", "lasterr", "lcid", "linkcheck", "literal", "localloc", "lpstr", "lpstruct", "lptstr",
		"lpvoid", "lpwstr", "managed", "marshal", "method", "modopt", "modreq", "native", "nested",
		"newslot", "noappdomain", "noinlining", "nomachine", "nomangle", "nometadata", "noncasdemand",
		"noncasinheritance", "noncaslinkdemand", "noprocess", "not", "not_in_gc_heap", "notremotable",
		"notserialized", "null", "nullref", "object", "objectref", "opt", "optil", "out",
		"permitonly", "pinned", "pinvokeimpl", "prefix1", "prefix2", "prefix3", "prefix4", "prefix5", "prefix6",
		"prefix7", "prefixref", "prejitdeny", "prejitgrant", "preservesig", "private", "privatescope", "protected",
		"public", "record", "refany", "reqmin", "reqopt", "reqrefuse", "reqsecobj", "request", "retval",
		"rtspecialname", "runtime", "safearray", "sealed", "sequential", "serializable", "special", "specialname",
		"static", "stdcall", "storage", "stored_object", "stream", "streamed_object", "string", "struct",
		"synchronized", "syschar", "sysstring", "tbstr", "thiscall", "tls", "to", "true", "typedref",
		"unicode", "unmanaged", "unmanagedexp", "unsigned", "unused", "userdefined", "value", "valuetype",
		"vararg", "variant", "vector", "virtual", "void", "wchar", "winapi", "with", "wrapper",
		// Not keywords in the spec, but ILAsm treats them as such.
		"property", "type", "flags", "codelabel", "callconv", "strict",
		// ILDasm writes the unsigned integers with these.
		"uint8", "uint16", "uint32", "uint64");

	// The opcode names are keywords too.
	static HashSet<string> BuildKeywords(params string[] keywords) {
		var set = new HashSet<string>(keywords, StringComparer.Ordinal);
		foreach (var field in typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static)) {
			if (field.GetValue(null) is OpCode opCode && opCode.OpCodeType != OpCodeType.Nternal)
				set.Add(opCode.Name);
		}
		return set;
	}

	/// <summary>A type the way the IL decompiler's TypeToString writes it.</summary>
	public static void Write(TextPartsBuilder output, ITypeDefOrRef? type, Syntax syntax, Func<ITypeDefOrRef, string>? typeColor) =>
		Write(output, type, syntax, ThreeState.Unknown, 0, typeColor);

	static void Write(TextPartsBuilder output, TypeSig? type, Syntax syntax, int depth, Func<ITypeDefOrRef, string>? typeColor) {
		if (type is null || depth++ > MaxDepth)
			return;
		var elementSyntax = syntax == Syntax.SignatureNoNamedTypeParameters ? syntax : Syntax.Signature;
		switch (type) {
		case PinnedSig pinned:
			Write(output, pinned.Next, elementSyntax, depth, typeColor);
			output.WriteSpace().Write(TextColors.Keyword, "pinned");
			break;
		case ArraySig array:
			Write(output, array.Next, elementSyntax, depth, typeColor);
			output.Write(TextColors.Punctuation, "[");
			for (var dimension = 0; dimension < array.Rank; dimension++) {
				if (dimension > 0)
					output.WriteCommaSpace();
				if (dimension < array.LowerBounds.Count || dimension < array.Sizes.Count) {
					var lower = dimension < array.LowerBounds.Count ? array.LowerBounds[dimension] : 0;
					output.Write(TextColors.Number, lower.ToString(CultureInfo.InvariantCulture)).Write(TextColors.Operator, "...");
					if (dimension < array.Sizes.Count)
						output.Write(TextColors.Number, (lower + (int)array.Sizes[dimension] - 1).ToString(CultureInfo.InvariantCulture));
				}
			}
			output.Write(TextColors.Punctuation, "]");
			break;
		case SZArraySig vector:
			Write(output, vector.Next, elementSyntax, depth, typeColor);
			output.Write(TextColors.Punctuation, "[]");
			break;
		case GenericSig generic: {
			output.Write(TextColors.Operator, generic.IsMethodVar ? "!!" : "!");
			var name = generic.GenericParam?.Name.String;
			if (string.IsNullOrEmpty(name) || name[0] == '!' || syntax == Syntax.SignatureNoNamedTypeParameters)
				output.Write(TextColors.Number, generic.Number.ToString(CultureInfo.InvariantCulture));
			else
				output.Write(generic.IsMethodVar ? TextColors.MethodGenericParameter : TextColors.TypeGenericParameter, Escape(name));
			break;
		}
		case ByRefSig byRef:
			Write(output, byRef.Next, elementSyntax, depth, typeColor);
			output.Write(TextColors.Operator, "&");
			break;
		case PtrSig pointer:
			Write(output, pointer.Next, elementSyntax, depth, typeColor);
			output.Write(TextColors.Operator, "*");
			break;
		case GenericInstSig instance:
			Write(output, instance.GenericType, elementSyntax, depth, typeColor);
			output.Write(TextColors.Punctuation, "<");
			for (var index = 0; index < instance.GenericArguments.Count; index++) {
				if (index > 0)
					output.WriteCommaSpace();
				Write(output, instance.GenericArguments[index], elementSyntax, depth, typeColor);
			}
			output.Write(TextColors.Punctuation, ">");
			break;
		case CModOptSig optional:
			WriteModifier(output, optional.Next, "modopt", optional.Modifier, syntax, depth, typeColor);
			break;
		case CModReqdSig required:
			WriteModifier(output, required.Next, "modreq", required.Modifier, syntax, depth, typeColor);
			break;
		case SentinelSig:
			output.Write(TextColors.Operator, "...");
			break;
		case FnPtrSig functionPointer:
			WriteFunctionPointer(output, functionPointer.MethodSig, syntax, depth, typeColor);
			break;
		case TypeDefOrRefSig typeDefOrRef: {
			var isValueType = typeDefOrRef switch {
				ClassSig => ThreeState.No,
				ValueTypeSig => ThreeState.Yes,
				CorLibTypeSig corLib => IsValueType(corLib),
				_ => ThreeState.Unknown,
			};
			Write(output, typeDefOrRef.TypeDefOrRef, syntax, isValueType, depth, typeColor);
			break;
		}
		}
	}

	static void WriteModifier(TextPartsBuilder output, TypeSig? next, string keyword, ITypeDefOrRef? modifier, Syntax syntax, int depth, Func<ITypeDefOrRef, string>? typeColor) {
		Write(output, next, syntax, depth, typeColor);
		output.WriteSpace().Write(TextColors.Keyword, keyword).Write(TextColors.Punctuation, "(");
		Write(output, modifier, Syntax.TypeName, ThreeState.Unknown, depth, typeColor);
		output.Write(TextColors.Punctuation, ")").WriteSpace();
	}

	static void WriteFunctionPointer(TextPartsBuilder output, MethodSig? signature, Syntax syntax, int depth, Func<ITypeDefOrRef, string>? typeColor) {
		output.Write(TextColors.Keyword, "method").WriteSpace();
		if (signature is null)
			return;
		if (signature.ExplicitThis)
			output.Write(TextColors.Keyword, "instance").WriteSpace().Write(TextColors.Keyword, "explicit").WriteSpace();
		else if (signature.HasThis)
			output.Write(TextColors.Keyword, "instance").WriteSpace();
		var convention = signature.CallingConvention & CallingConvention.Mask;
		if (convention != CallingConvention.Default) {
			WriteKeyword(output, convention switch {
				CallingConvention.C => "unmanaged cdecl",
				CallingConvention.StdCall => "unmanaged stdcall",
				CallingConvention.ThisCall => "unmanaged thiscall",
				CallingConvention.FastCall => "unmanaged fastcall",
				CallingConvention.VarArg => "vararg",
				CallingConvention.Unmanaged => "unmanaged",
				_ => convention.ToString().ToLowerInvariant(),
			});
			output.WriteSpace();
		}
		Write(output, signature.RetType, syntax, depth, typeColor);
		output.WriteSpace().Write(TextColors.Operator, "*").Write(TextColors.Punctuation, "(");
		var parameters = signature.GetParams();
		for (var index = 0; index < parameters.Count; index++) {
			if (index > 0)
				output.WriteCommaSpace();
			Write(output, parameters[index], Syntax.SignatureNoNamedTypeParameters, 0, typeColor);
		}
		output.Write(TextColors.Punctuation, ")");
	}

	static void Write(TextPartsBuilder output, ITypeDefOrRef? type, Syntax syntax, ThreeState isValueType, int depth, Func<ITypeDefOrRef, string>? typeColor) {
		if (type is null || depth++ > MaxDepth)
			return;
		if (type is TypeSpec typeSpec) {
			Write(output, typeSpec.TypeSig, syntax, depth, typeColor);
			return;
		}
		var fullName = type.FullName;
		var name = type.Name.String;
		var keyword = type.DefinitionAssembly.IsCorLib() ? PrimitiveTypeName(fullName) : null;
		string Color() => typeColor?.Invoke(type) ?? TextColors.Type;
		if (syntax == Syntax.ShortTypeName) {
			if (keyword is not null)
				WriteKeyword(output, keyword);
			else
				output.Write(Color(), Escape(name));
			return;
		}
		if (syntax is Syntax.Signature or Syntax.SignatureNoNamedTypeParameters && keyword is not null) {
			WriteKeyword(output, keyword);
			return;
		}
		if (syntax is Syntax.Signature or Syntax.SignatureNoNamedTypeParameters) {
			var valueType = isValueType != ThreeState.Unknown ? isValueType == ThreeState.Yes : type.IsValueType;
			output.Write(TextColors.Keyword, valueType ? "valuetype" : "class").WriteSpace();
		}
		if (type.DeclaringType is not null) {
			Write(output, type.DeclaringType, Syntax.TypeName, ThreeState.Unknown, depth, typeColor);
			output.Write(TextColors.Operator, "/");
			if (WriteNamespace(output, type.Namespace))
				output.Write(TextColors.Operator, ".");
			output.Write(Color(), Escape(name));
			return;
		}
		if (type is not TypeDef && type.Scope is { } scope)
			output.Write(TextColors.Punctuation, "[").Write(TextColors.ILModule, Escape(scope.ScopeName)).Write(TextColors.Punctuation, "]");
		if (MustEscape(fullName)) {
			output.Write(Color(), Escape(fullName));
			return;
		}
		if (WriteNamespace(output, type.Namespace))
			output.Write(TextColors.Operator, ".");
		output.Write(Color(), name);
	}

	/// <summary>A namespace part by part, the dots between them operators. Answers whether there was one.</summary>
	static bool WriteNamespace(TextPartsBuilder output, string? @namespace) {
		if (string.IsNullOrEmpty(@namespace))
			return false;
		var names = @namespace.Split('.');
		for (var index = 0; index < names.Length; index++) {
			if (index > 0)
				output.Write(TextColors.Operator, ".");
			output.Write(TextColors.Namespace, names[index]);
		}
		return true;
	}

	// "native int" is two keywords with a space between them.
	static void WriteKeyword(TextPartsBuilder output, string keyword) {
		var words = keyword.Split(' ');
		for (var index = 0; index < words.Length; index++) {
			if (index > 0)
				output.WriteSpace();
			output.Write(TextColors.Keyword, words[index]);
		}
	}

	static string? PrimitiveTypeName(string fullName) => fullName switch {
		"System.SByte" => "int8",
		"System.Int16" => "int16",
		"System.Int32" => "int32",
		"System.Int64" => "int64",
		"System.Byte" => "uint8",
		"System.UInt16" => "uint16",
		"System.UInt32" => "uint32",
		"System.UInt64" => "uint64",
		"System.Single" => "float32",
		"System.Double" => "float64",
		"System.Void" => "void",
		"System.Boolean" => "bool",
		"System.String" => "string",
		"System.Char" => "char",
		"System.Object" => "object",
		"System.IntPtr" => "native int",
		"System.UIntPtr" => "native unsigned int",
		"System.TypedReference" => "typedref",
		_ => null,
	};

	static ThreeState IsValueType(CorLibTypeSig corLib) => corLib.ElementType switch {
		ElementType.Void or ElementType.Boolean or ElementType.Char or ElementType.I1 or ElementType.U1 or ElementType.I2
			or ElementType.U2 or ElementType.I4 or ElementType.U4 or ElementType.I8 or ElementType.U8 or ElementType.R4
			or ElementType.R8 or ElementType.TypedByRef or ElementType.I or ElementType.U or ElementType.R => ThreeState.Yes,
		ElementType.String or ElementType.Object => ThreeState.No,
		_ => ThreeState.Unknown,
	};

	static bool MustEscape(string identifier) => !IsValidIdentifier(identifier);

	static bool IsValidIdentifier(string identifier) {
		if (string.IsNullOrEmpty(identifier))
			return false;
		var first = identifier[0];
		if (char.IsDigit(first))
			return false;
		// .ctor and .cctor are valid despite starting with a dot.
		if (first == '.')
			return identifier is ".ctor" or ".cctor";
		if (identifier.Contains("..", StringComparison.Ordinal))
			return false;
		if (Keywords.Contains(identifier))
			return false;
		foreach (var ch in identifier) {
			if (!char.IsLetterOrDigit(ch) && Array.IndexOf(ValidNonLetterIdentifierCharacters, ch) < 0)
				return false;
		}
		return true;
	}

	/// <summary>
	/// A name the assembler could read back as it is, or the name in single quotes — escaped the way a C#
	/// string literal is, with a quote of its own as <c>\'</c>, which is what ILDasm writes.
	/// </summary>
	public static string Escape(string identifier) {
		if (!MustEscape(identifier))
			return identifier;
		var escaped = new StringBuilder(identifier.Length + 2).Append('\'');
		foreach (var ch in identifier) {
			switch (ch) {
			case '\'': escaped.Append(@"\'"); break;
			case '"': escaped.Append("\\\""); break;
			case '\\': escaped.Append(@"\\"); break;
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
					escaped.Append(@"\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
				else
					escaped.Append(ch);
				break;
			}
		}
		return escaped.Append('\'').ToString();
	}
}
