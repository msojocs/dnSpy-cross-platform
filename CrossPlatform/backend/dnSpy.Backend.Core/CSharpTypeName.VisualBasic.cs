using dnlib.DotNet;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core;

/// <summary>
/// The Visual Basic decompiler's type names. dnSpy's VBDecompiler.TypeToString builds the C# AstType first —
/// the same AstBuilder.ConvertType this class ports — then runs it through NRefactory's
/// CSharpToVBConverterVisitor and prints it with the VB output visitor, so the walk over the signature is the
/// C# one and only the way the result is written differs: "Integer" for "int", "List(Of T)" for
/// "List&lt;T&gt;", "Integer()" for "int[]", and a name that is a VB keyword in brackets ("[String]").
/// </summary>
static partial class CSharpTypeName {
	// CSharpToVBConverterVisitor.VisitPrimitiveType. "dynamic" has no case there and comes out as "unknown";
	// it is what VB calls an object, so it is written as one.
	static readonly Dictionary<string, string> VisualBasicKeywords = new() {
		["object"] = "Object", ["bool"] = "Boolean", ["char"] = "Char", ["sbyte"] = "SByte", ["byte"] = "Byte",
		["short"] = "Short", ["ushort"] = "UShort", ["int"] = "Integer", ["uint"] = "UInteger", ["long"] = "Long",
		["ulong"] = "ULong", ["float"] = "Single", ["double"] = "Double", ["decimal"] = "Decimal", ["string"] = "String",
		["void"] = "Void", ["dynamic"] = "Object",
	};

	// The VB output visitor's unconditionalKeywords: an identifier spelled like one of them is bracketed.
	static readonly HashSet<string> VisualBasicReservedWords = new(StringComparer.OrdinalIgnoreCase) {
		"AddHandler", "AddressOf", "Alias", "And", "AndAlso", "As", "Boolean", "ByRef", "Byte",
		"ByVal", "Call", "Case", "Catch", "CBool", "CByte", "CChar", "CInt", "Class", "CLng",
		"CObj", "Const", "Continue", "CSByte", "CShort", "CSng", "CStr", "CType", "CUInt",
		"CULng", "CUShort", "Date", "Decimal", "Declare", "Default", "Delegate", "Dim",
		"DirectCast", "Do", "Double", "Each", "Else", "ElseIf", "End", "EndIf", "Enum", "Erase",
		"Error", "Event", "Exit", "False", "Finally", "For", "Friend", "Function", "Get",
		"GetType", "GetXmlNamespace", "Global", "GoSub", "GoTo", "Handles", "If", "Implements",
		"Imports", "In", "Inherits", "Integer", "Interface", "Is", "IsNot", "Let", "Lib", "Like",
		"Long", "Loop", "Me", "Mod", "Module", "MustInherit", "MustOverride", "MyBase", "MyClass",
		"Namespace", "Narrowing", "New", "Next", "Not", "Nothing", "NotInheritable", "NotOverridable",
		"Object", "Of", "On", "Operator", "Option", "Optional", "Or", "OrElse", "Overloads",
		"Overridable", "Overrides", "ParamArray", "Partial", "Private", "Property", "Protected",
		"Public", "RaiseEvent", "ReadOnly", "ReDim", "REM", "RemoveHandler", "Resume", "Return",
		"SByte", "Select", "Set", "Shadows", "Shared", "Short", "Single", "Static", "Step", "Stop",
		"String", "Structure", "Sub", "SyncLock", "Then", "Throw", "To", "True", "Try", "TryCast",
		"TypeOf", "UInteger", "ULong", "UShort", "Using", "Variant", "Wend", "When", "While",
		"Widening", "With", "WithEvents", "WriteOnly", "Xor",
	};

	/// <summary>A signature's type the way the VB decompiler writes it after " : ".</summary>
	public static bool WriteVisualBasic(TextPartsBuilder output, IHasCustomAttribute? attributeProvider, TypeSig? type, Func<ITypeDefOrRef, string>? typeColor) =>
		type is not null && WriteVisualBasic(output, attributeProvider, type.ToTypeDefOrRef(), Options.None, typeColor);

	/// <summary>
	/// The VB decompiler's TypeToString: the C# conversion, then "ByRef " in front of a byref instead of the
	/// specifier the conversion put on the type.
	/// </summary>
	public static bool WriteVisualBasic(TextPartsBuilder output, IHasCustomAttribute? attributeProvider, ITypeDefOrRef? type, Options options, Func<ITypeDefOrRef, string>? typeColor) {
		if (type is null)
			return false;
		var typeIndex = 0;
		var syntax = Convert(type, attributeProvider, ref typeIndex, includeParameterDefinitions: true, options, depth: 0);
		if (syntax is null)
			return false;
		if (type.TryGetByRefSig() is not null) {
			syntax.ByRef = false;
			output.Write(TextColors.Keyword, "ByRef").WriteSpace();
		}
		WriteVisualBasic(output, syntax, typeColor);
		return true;
	}

	/// <summary>
	/// A converted type as the converter and the VB output visitor leave it. A byref the conversion kept
	/// becomes the converter's <c>__ByRef(Of T)</c>, each pointer level a <c>__Pointer(Of T)</c> round the
	/// array or nullable it applies to, and a function pointer the bare word "method".
	/// </summary>
	static void WriteVisualBasic(TextPartsBuilder output, Syntax syntax, Func<ITypeDefOrRef, string>? typeColor) {
		if (syntax.Return is not null) {
			output.Write(TextColors.Type, "method");
			return;
		}
		if (syntax.ByRef)
			WriteVisualBasicWrapper(output, "__ByRef", () => WriteVisualBasicPointers(output, syntax, syntax.Pointers, typeColor));
		else
			WriteVisualBasicPointers(output, syntax, syntax.Pointers, typeColor);
	}

	static void WriteVisualBasicPointers(TextPartsBuilder output, Syntax syntax, int pointers, Func<ITypeDefOrRef, string>? typeColor) {
		if (pointers > 0) {
			WriteVisualBasicWrapper(output, "__Pointer", () => WriteVisualBasicPointers(output, syntax, pointers - 1, typeColor));
			return;
		}
		WriteVisualBasicName(output, syntax, typeColor);
		if (syntax.Nullable)
			output.Write(TextColors.Punctuation, "?");
		foreach (var rank in syntax.ArrayRanks) {
			output.Write(TextColors.Punctuation, "(");
			for (var comma = 1; comma < rank; comma++)
				output.Write(TextColors.Punctuation, ",");
			output.Write(TextColors.Punctuation, ")");
		}
	}

	static void WriteVisualBasicWrapper(TextPartsBuilder output, string name, Action writeArgument) {
		output.Write(TextColors.Keyword, name).Write(TextColors.Punctuation, "(").Write(TextColors.Keyword, "Of").WriteSpace();
		writeArgument();
		output.Write(TextColors.Punctuation, ")");
	}

	static void WriteVisualBasicName(TextPartsBuilder output, Syntax syntax, Func<ITypeDefOrRef, string>? typeColor) {
		if (syntax.Color == TextColors.Keyword) {
			output.Write(TextColors.Keyword, VisualBasicKeywords.TryGetValue(syntax.Name, out var keyword) ? keyword : syntax.Name);
			return;
		}
		if (syntax.Target is not null) {
			WriteVisualBasic(output, syntax.Target, typeColor);
			output.Write(TextColors.Operator, ".");
		}
		else if (syntax.Namespace is not null) {
			var names = syntax.Namespace.Split('.');
			for (var index = 0; index < names.Length; index++) {
				if (index > 0)
					output.Write(TextColors.Operator, ".");
				output.Write(TextColors.Namespace, VisualBasicIdentifier(names[index]));
			}
			output.Write(TextColors.Operator, ".");
		}
		output.Write(syntax.Color ?? (syntax.Source is not null && typeColor is not null ? typeColor(syntax.Source) : TextColors.Type), VisualBasicIdentifier(syntax.Name));
		if (syntax.TypeArguments.Count > 0) {
			output.Write(TextColors.Punctuation, "(").Write(TextColors.Keyword, "Of").WriteSpace();
			for (var index = 0; index < syntax.TypeArguments.Count; index++) {
				if (index > 0)
					output.WriteCommaSpace();
				WriteVisualBasic(output, syntax.TypeArguments[index], typeColor);
			}
			output.Write(TextColors.Punctuation, ")");
		}
	}

	static string VisualBasicIdentifier(string name) => VisualBasicReservedWords.Contains(name) ? $"[{name}]" : name;
}
