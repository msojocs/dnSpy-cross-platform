using dnlib.DotNet;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core;

/// <summary>
/// The C# type names dnSpy's tree wears after " : " — the tree hands every type to the C#
/// decompiler (NodeFormatter.Write → IDecompiler.WriteType), which renders System.Int32 as "int",
/// System.Void as "void", writes generic instances with their arguments ("Task&lt;int&gt;"), arrays
/// as "int[]", byrefs as "ref"/"out"/"in" and open generics with their parameters ("Task&lt;T&gt;").
/// This is a port of that path against dnlib — ILSpy's AstBuilder.ConvertType (the ilspyv2 tree
/// dnSpy ships) with IncludeTypeParameterDefinitions and no namespace — so the client can compose
/// rows and tab titles the way the WPF tree does without carrying the decompiler. The same names can be
/// written in parts, each in the color class dnSpy's syntax highlighting gives it; <c>typeColor</c> picks a
/// type name's class, which only the caller can resolve a reference for.
/// </summary>
static class CSharpTypeName {
	// AstBuilder.MAX_CONVERTTYPE_DEPTH
	const int MaxDepth = 50;

	/// <summary>The ConvertTypeOptions flags besides IncludeTypeParameterDefinitions, which every caller here sets.</summary>
	[Flags]
	public enum Options {
		None = 0,
		IncludeNamespace = 1,
		DoNotUsePrimitiveTypeNames = 2,
		DoNotIncludeEnclosingType = 4,
	}

	// The System.* names AstBuilder.GetConvertType spells as keywords: matched on the bare name
	// inside the System namespace, exactly where AstBuilder does it.
	static readonly Dictionary<string, string> Keywords = new() {
		["SByte"] = "sbyte", ["Int16"] = "short", ["Int32"] = "int", ["Int64"] = "long",
		["Byte"] = "byte", ["UInt16"] = "ushort", ["UInt32"] = "uint", ["UInt64"] = "ulong",
		["String"] = "string", ["Single"] = "float", ["Double"] = "double", ["Decimal"] = "decimal",
		["Char"] = "char", ["Boolean"] = "bool", ["Void"] = "void", ["Object"] = "object",
	};

	const string CompilerServicesNamespace = "System.Runtime.CompilerServices";

	/// <summary>
	/// Writes a signature's type the way a tree row does. NodeFormatter feeds the decompiler
	/// ToTypeDefOrRef() of the signature's type — a TypeSpec, which round-trips the whole
	/// signature — so arrays, pointers and generic arguments all survive; only the top-level byref
	/// surfaces, spelled "ref"/"out"/"in" from the parameter's attributes. <paramref name="attributeProvider"/>
	/// is what a "dynamic" is read off: the member itself, or the return parameter for methods.
	/// </summary>
	public static string? Of(IHasCustomAttribute? attributeProvider, TypeSig? type) {
		if (type is null)
			return null;
		return Of(attributeProvider, type.ToTypeDefOrRef());
	}

	/// <summary>
	/// The same for a type that is already an ITypeDefOrRef — an event's handler type, which the
	/// WPF tree passes without wrapping.
	/// </summary>
	public static string? Of(IHasCustomAttribute? attributeProvider, ITypeDefOrRef? type) =>
		Of(attributeProvider, type, Options.None);

	/// <summary>
	/// The same with AstBuilder's ConvertTypeOptions. The analyzer writes a member's declaring type the way
	/// the decompiler's WriteType does with includeNamespace ("System.Collections.Generic.List&lt;T&gt;"), and a
	/// type row the way its FormatTypeName does ("Int32", a nested type without its outer type).
	/// </summary>
	public static string? Of(IHasCustomAttribute? attributeProvider, ITypeDefOrRef? type, Options options) {
		var output = new TextPartsBuilder();
		return Write(output, attributeProvider, type, options, null) ? output.ToString() : null;
	}

	/// <summary>The same in parts. Answers whether there was a type to write.</summary>
	public static bool Write(TextPartsBuilder output, IHasCustomAttribute? attributeProvider, TypeSig? type, Func<ITypeDefOrRef, string>? typeColor) =>
		type is not null && Write(output, attributeProvider, type.ToTypeDefOrRef(), Options.None, typeColor);

	/// <inheritdoc cref="Write(TextPartsBuilder, IHasCustomAttribute?, TypeSig?, Func{ITypeDefOrRef, string}?)"/>
	public static bool Write(TextPartsBuilder output, IHasCustomAttribute? attributeProvider, ITypeDefOrRef? type, Options options, Func<ITypeDefOrRef, string>? typeColor) {
		if (type is null)
			return false;
		var typeIndex = 0;
		var syntax = Convert(type, attributeProvider, ref typeIndex, includeParameterDefinitions: true, options, depth: 0);
		if (syntax is null)
			return false;
		// CSharpDecompiler.TypeToString spells a byref out in front (WriteRefIfByRef) and takes the
		// specifier the conversion put on the type itself back off.
		if (type.TryGetByRefSig() is not null) {
			syntax.ByRef = false;
			output.Write(TextColors.Keyword, RefKeyword(attributeProvider as ParamDef)).WriteSpace();
		}
		Write(output, syntax, typeColor);
		return true;
	}

	/// <summary>
	/// A method's parameter list the way the WPF tree and tab write it — each parameter through the
	/// same conversion, "ref"/"out"/"in" from the parameter's own attributes.
	/// </summary>
	public static string ParameterList(MethodDef method) {
		var output = new TextPartsBuilder();
		WriteParameterList(output, method, null);
		return output.ToString();
	}

	/// <summary>The same in parts.</summary>
	public static void WriteParameterList(TextPartsBuilder output, MethodDef method, Func<ITypeDefOrRef, string>? typeColor) {
		output.Write(TextColors.Punctuation, "(");
		var first = true;
		foreach (var parameter in method.Parameters) {
			if (parameter.IsHiddenThisParameter)
				continue;
			if (!first)
				output.WriteCommaSpace();
			first = false;
			Write(output, parameter.ParamDef, parameter.Type, typeColor);
		}
		output.Write(TextColors.Punctuation, ")");
	}

	/// <summary>
	/// A stack frame's name the way the WPF Call Stack window writes it — dnSpy's
	/// <c>CSharpStackFrameFormatter</c> with the default display settings, which are the ones the
	/// screenshot has to match: the declaring type chain in dotted form, the method name, and the
	/// parameters as "type name". The return type and the IL offset the formatter also knows are off
	/// there, and the "module!" prefix belongs to the caller, which is the only one that knows which
	/// module the frame lives in.
	/// </summary>
	public static string StackFrameName(MethodDef method) {
		var declaringType = DottedTypeName(method.DeclaringType);
		return declaringType.Length == 0
			? $"{method.Name}{NamedParameterList(method)}"
			: $"{declaringType}.{method.Name}{NamedParameterList(method)}";
	}

	/// <summary>
	/// The declaring types a frame's name carries, "Namespace.Outer.Inner": one dotted name, the way
	/// the formatter writes DeclaringTypes. Generic arity is never part of a name that is shown.
	/// </summary>
	static string DottedTypeName(ITypeDefOrRef? type) {
		if (type is null)
			return string.Empty;
		var name = SplitArity(type.Name.String);
		if (type.DeclaringType is not null)
			return $"{DottedTypeName(type.DeclaringType)}.{name}";
		return string.IsNullOrEmpty(type.Namespace) ? name : $"{type.Namespace}.{name}";
	}

	/// <summary>
	/// <see cref="ParameterList"/> with each parameter's own name behind its type — what a stack frame
	/// writes, because ShowParameterNames is on there and off in the tree. The name comes from the
	/// metadata's Param rows, so a parameter the compiler left unnamed keeps its type alone.
	/// </summary>
	static string NamedParameterList(MethodDef method) =>
		$"({string.Join(", ", method.Parameters.Where(p => !p.IsHiddenThisParameter).Select(NamedParameter))})";

	static string NamedParameter(Parameter parameter) {
		var type = Of(parameter.ParamDef, parameter.Type) ?? string.Empty;
		var name = parameter.ParamDef?.Name?.String;
		return string.IsNullOrEmpty(name) ? type : $"{type} {name}";
	}

	static Syntax? Convert(TypeSig? type, ref int typeIndex, bool includeParameterDefinitions, Options options, int depth) {
		if (type is null || ++depth > MaxDepth)
			return null;
		type = type.RemovePinned();
		if (type is null)
			return null;
		switch (type) {
			case ByRefSig byRefSig:
				// MakeRefType; the keyword in front is only written once, at the top level.
				typeIndex++;
				var referred = Convert(byRefSig.Next, ref typeIndex, includeParameterDefinitions, options, depth);
				if (referred is not null)
					referred.ByRef = true;
				return referred;
			case PtrSig ptrSig:
				typeIndex++;
				var pointee = Convert(ptrSig.Next, ref typeIndex, includeParameterDefinitions, options, depth);
				if (pointee is not null)
					pointee.Pointers++;
				return pointee;
			case ArraySigBase arraySig:
				typeIndex++;
				var element = Convert(arraySig.Next, ref typeIndex, includeParameterDefinitions, options, depth);
				if (element is not null)
					element.ArrayRanks.Add((int)arraySig.Rank);
				return element;
			case GenericInstSig generic when IsSystemNullable(generic):
				typeIndex++;
				var value = Convert(generic.GenericArguments[0], ref typeIndex, includeParameterDefinitions, options, depth);
				if (value is not null)
					value.Nullable = true;
				return value;
			case GenericInstSig generic:
				// The open generic is written without parameter definitions of its own; the actual
				// arguments are then distributed over the (possibly nested) name.
				var open = Convert(generic.GenericType?.TypeDefOrRef, null, ref typeIndex, includeParameterDefinitions: false, options, depth);
				if (open is null)
					return null;
				var arguments = new List<Syntax>(generic.GenericArguments.Count);
				foreach (var argument in generic.GenericArguments) {
					typeIndex++;
					// AstType.Null renders as nothing, so an unconvertible argument leaves a gap.
					arguments.Add(Convert(argument, ref typeIndex, includeParameterDefinitions, options, depth) ?? new Syntax());
				}
				ApplyTypeArguments(open, arguments);
				return open;
			case GenericSig genericSig:
				return new Syntax { Name = genericSig.GenericParam.Name.String, Color = genericSig.IsMethodVar ? TextColors.MethodGenericParameter : TextColors.TypeGenericParameter };
			case TypeDefOrRefSig typeDefOrRefSig:
				return Convert(typeDefOrRefSig.TypeDefOrRef, null, ref typeIndex, includeParameterDefinitions, options, depth);
			case ModifierSig modifierSig:
				typeIndex++;
				return Convert(modifierSig.Next, ref typeIndex, includeParameterDefinitions, options, depth);
			case FnPtrSig fnPtrSig:
				return FnPtr(fnPtrSig, ref typeIndex, includeParameterDefinitions, options, depth);
			default:
				return Convert(type.ToTypeDefOrRef(), null, ref typeIndex, includeParameterDefinitions, options, depth);
		}
	}

	static Syntax? Convert(ITypeDefOrRef? type, IHasCustomAttribute? attributeProvider, ref int typeIndex, bool includeParameterDefinitions, Options options, int depth) {
		if (type is null || ++depth > MaxDepth)
			return null;
		// A TypeSpec round-trips its signature, so the tree still shows "Task<int>" and "int[]"
		// though NodeFormatter only ever hands over ITypeDefOrRefs. A function pointer TypeSpec
		// without a signature is malformed and falls through to the name path below.
		if (type is TypeSpec typeSpec && !(typeSpec.TypeSig is FnPtrSig broken && broken.MethodSig is null))
			return Convert(typeSpec.TypeSig, ref typeIndex, includeParameterDefinitions, options, depth);

		// AstBuilder chains nested types through DeclaringType first, so "Outer.Inner" is one name.
		if (type.DeclaringType is not null && (options & Options.DoNotIncludeEnclosingType) == 0) {
			var enclosing = Convert(type.DeclaringType, attributeProvider, ref typeIndex, includeParameterDefinitions: false, options, depth);
			if (enclosing is null)
				return null;
			var member = new Syntax { Name = SplitArity(type.Name.String), Target = enclosing, Source = type };
			if (includeParameterDefinitions)
				AddTypeParameterDefinitions(type, member);
			return member;
		}

		if (type.Namespace == "System" && (options & Options.DoNotUsePrimitiveTypeNames) == 0) {
			if (type.Name == "Object" && HasDynamicAttribute(attributeProvider, typeIndex))
				return new Syntax { Name = "dynamic", Color = TextColors.Keyword };
			if (Keywords.TryGetValue(type.Name.String, out var keyword))
				// A keyword is returned before any <T> is added, exactly as AstBuilder does.
				return new Syntax { Name = keyword, Color = TextColors.Keyword };
		}
		var simple = new Syntax { Name = SplitArity(type.Name.String), Source = type };
		// A nested type keeps the namespace its outermost type was put in: metadata leaves a nested row's own
		// namespace empty, so only a type written without its enclosing chain has one here.
		if ((options & Options.IncludeNamespace) != 0 && !string.IsNullOrEmpty(type.Namespace))
			simple.Namespace = type.Namespace;
		if (includeParameterDefinitions)
			AddTypeParameterDefinitions(type, simple);
		return simple;
	}

	static Syntax FnPtr(FnPtrSig signature, ref int typeIndex, bool includeParameterDefinitions, Options options, int depth) {
		var methodSig = signature.MethodSig;
		// The calling conventions read off the return type's CallConv* modifiers, standard ones
		// from the signature itself when it is not plain managed.
		var returnType = methodSig?.GetRetType().RemovePinned();
		var customConventions = new List<ITypeDefOrRef>();
		while (returnType is ModifierSig modifier) {
			if (modifier.Modifier.Name.String.StartsWith("CallConv", StringComparison.Ordinal) && modifier.Modifier.Namespace == CompilerServicesNamespace) {
				returnType = modifier.Next.RemovePinned();
				customConventions.Add(modifier.Modifier);
			}
			else {
				break;
			}
		}
		var conventions = customConventions
			.Select(modifier => modifier.Name.String.StartsWith("CallConv", StringComparison.Ordinal) && modifier.Name.String.Length > 8
				? modifier.Name.String[8..]
				: modifier.Name.String)
			.ToList();
		if (methodSig is not null && !methodSig.IsUnmanaged && !methodSig.IsDefault) {
			conventions.Add((methodSig.CallingConvention & CallingConvention.Mask) switch {
				CallingConvention.C => "Cdecl",
				CallingConvention.StdCall => "Stdcall",
				CallingConvention.ThisCall => "Thiscall",
				CallingConvention.FastCall => "Fastcall",
				CallingConvention.VarArg => "Varargs",
				var other => other.ToString(),
			});
		}
		var fnPtr = new Syntax { Unmanaged = methodSig is not null && (methodSig.IsUnmanaged || conventions.Count > 0) };
		fnPtr.Conventions.AddRange(conventions);
		if (methodSig is not null) {
			fnPtr.Return = Convert(returnType, ref typeIndex, includeParameterDefinitions, options, depth) ?? new Syntax();
			foreach (var parameter in methodSig.Params) {
				typeIndex++;
				fnPtr.Parameters.Add(Convert(parameter, ref typeIndex, includeParameterDefinitions, options, depth) ?? new Syntax());
			}
		}
		return fnPtr;
	}

	// AstBuilder.AddTypeParameterDefininitionsTo: an open generic wears its own parameter names,
	// resolved off the type definition — "Task<T>".
	static void AddTypeParameterDefinitions(ITypeDefOrRef type, Syntax syntax) {
		var typeDef = type.ResolveTypeDef();
		if (typeDef is null || !typeDef.HasGenericParameters)
			return;
		ApplyTypeArguments(syntax, typeDef.GenericParameters.Select(p => new Syntax { Name = p.Name.String, Color = TextColors.TypeGenericParameter }).ToList());
	}

	// AstBuilder.ApplyTypeArgumentsTo: over a nested name, the parameters each link declared itself
	// stay on it, the ones it inherited bubble out to the enclosing types.
	static void ApplyTypeArguments(Syntax syntax, List<Syntax> typeArguments) {
		if (syntax.Target is null) {
			syntax.TypeArguments.AddRange(typeArguments);
			return;
		}
		int ownCount;
		var typeDef = syntax.Source?.ResolveTypeDef();
		if (typeDef is not null)
			ownCount = typeDef.DeclaringType is not null && typeDef.DeclaringType.HasGenericParameters
				? typeDef.GenericParameters.Count - typeDef.DeclaringType.GenericParameters.Count
				: typeDef.GenericParameters.Count;
		else
			// An unresolved reference only betrays its parameter count through the name's arity.
			ownCount = Arity(syntax.Source!.Name.String);
		if (ownCount > typeArguments.Count)
			ownCount = typeArguments.Count;
		syntax.TypeArguments.AddRange(typeArguments.GetRange(typeArguments.Count - ownCount, ownCount));
		typeArguments.RemoveRange(typeArguments.Count - ownCount, ownCount);
		if (typeArguments.Count > 0)
			ApplyTypeArguments(syntax.Target, typeArguments);
	}

	// WriteRefIfByRef: out (out-only parameter), in (readonly reference), ref everywhere else.
	static string RefKeyword(ParamDef? parameter) {
		if (parameter is not null && !parameter.IsIn && parameter.IsOut)
			return "out";
		if (parameter is not null && parameter.CustomAttributes.Any(a => a.AttributeType.Namespace == CompilerServicesNamespace && a.AttributeType.Name == "IsReadOnlyAttribute"))
			return "in";
		return "ref";
	}

	// DnlibExtensions.IsSystemNullable: System.Nullable`1 as a value type, matched without resolving.
	static bool IsSystemNullable(GenericInstSig generic) =>
		generic.GenericType is ValueTypeSig valueSig
		&& (valueSig.TypeDefOrRef is TypeDef definition
			? definition.Namespace == "System" && definition.Name == "Nullable`1"
			: valueSig.TypeDefOrRef is TypeRef reference && reference.Namespace == "System" && reference.Name == "Nullable`1");

	// AstBuilder.HasDynamicAttribute: an object wearing [DynamicAttribute] reads "dynamic"; the
	// attribute's bool list says which of several positions it is.
	static bool HasDynamicAttribute(IHasCustomAttribute? provider, int typeIndex) {
		if (provider is null)
			return false;
		foreach (var attribute in provider.CustomAttributes) {
			if (attribute.AttributeType.Namespace != CompilerServicesNamespace || attribute.AttributeType.Name != "DynamicAttribute")
				continue;
			if (attribute.ConstructorArguments.Count == 1
				&& attribute.ConstructorArguments[0].Value is IReadOnlyList<CAArgument> values
				&& typeIndex < values.Count
				&& values[typeIndex].Value is bool flag)
				return flag;
			return true;
		}
		return false;
	}

	/// <summary>Writes a converted type the way the C# output visitor prints its AstType: keywords, names in
	/// their type's color, namespaces and the dots between names, brackets and specifiers.</summary>
	static void Write(TextPartsBuilder output, Syntax syntax, Func<ITypeDefOrRef, string>? typeColor) {
		if (syntax.Return is not null) {
			output.Write(TextColors.Keyword, "delegate").Write(TextColors.Operator, "*");
			if (syntax.Unmanaged) {
				output.WriteSpace().Write(TextColors.Keyword, "unmanaged");
				if (syntax.Conventions.Count > 0) {
					output.Write(TextColors.Punctuation, "[");
					for (var index = 0; index < syntax.Conventions.Count; index++) {
						if (index > 0)
							output.WriteCommaSpace();
						output.Write(TextColors.Text, syntax.Conventions[index]);
					}
					output.Write(TextColors.Punctuation, "]");
				}
			}
			output.Write(TextColors.Punctuation, "<");
			foreach (var parameter in syntax.Parameters) {
				Write(output, parameter, typeColor);
				output.WriteCommaSpace();
			}
			if (syntax.Parameters.Count == 0)
				output.WriteCommaSpace();
			Write(output, syntax.Return, typeColor);
			output.Write(TextColors.Punctuation, ">");
			return;
		}
		if (syntax.ByRef)
			output.Write(TextColors.Keyword, "ref").WriteSpace();
		if (syntax.Target is not null) {
			Write(output, syntax.Target, typeColor);
			output.Write(TextColors.Operator, ".");
		}
		else if (syntax.Namespace is not null) {
			output.WriteNamespace(syntax.Namespace);
			output.Write(TextColors.Operator, ".");
		}
		output.Write(syntax.Color ?? (syntax.Source is not null && typeColor is not null ? typeColor(syntax.Source) : TextColors.Type), syntax.Name);
		if (syntax.TypeArguments.Count > 0) {
			output.Write(TextColors.Punctuation, "<");
			for (var index = 0; index < syntax.TypeArguments.Count; index++) {
				if (index > 0)
					output.WriteCommaSpace();
				Write(output, syntax.TypeArguments[index], typeColor);
			}
			output.Write(TextColors.Punctuation, ">");
		}
		for (var pointer = 0; pointer < syntax.Pointers; pointer++)
			output.Write(TextColors.Operator, "*");
		foreach (var rank in syntax.ArrayRanks) {
			// A jagged bracket is empty; a multidimensional one names its rows, the way the C#
			// output visitor writes them.
			output.Write(TextColors.Punctuation, "[");
			for (var dimension = 0; rank > 1 && dimension < rank; dimension++) {
				if (dimension > 0)
					output.Write(TextColors.Punctuation, ",");
				output.Write(TextColors.Text, "0...");
			}
			output.Write(TextColors.Punctuation, "]");
		}
		if (syntax.Nullable)
			output.Write(TextColors.Operator, "?");
	}

	// NRefactory ReflectionHelper.SplitTypeParameterCountFromReflectionName: the `N arity suffix
	// never belongs to the name that is shown.
	static string SplitArity(string name) {
		var arity = name.LastIndexOf('`');
		return arity < 0 ? name : name[..arity];
	}

	static int Arity(string name) {
		var arity = name.LastIndexOf('`');
		return arity < 0 || !int.TryParse(name[(arity + 1)..], out var count) ? 0 : count;
	}

	/// <summary>
	/// A minimal stand-in for the AstTypes the WPF conversion builds, so the generic-argument
	/// distribution can run the same walk before anything is rendered. What reads as an AstType:
	/// SimpleType (a name, maybe keyword), MemberType (nested), PrimitiveType, ComposedType
	/// (ref/pointer/array/nullable specifiers) and FunctionPointerAstType.
	/// </summary>
	sealed class Syntax {
		public string Name = string.Empty;
		// The class a keyword or a generic parameter is written in; a type's name takes its type's.
		public string? Color;
		// The namespace an IncludeNamespace conversion writes in front of a top-level name.
		public string? Namespace;
		// What a name names — a MemberType's parameter counts steer the argument distribution, and every
		// name is colored after it.
		public ITypeDefOrRef? Source;
		// The enclosing chain of a nested type.
		public Syntax? Target;
		public Syntax? Return;
		public List<Syntax> TypeArguments { get; } = new();
		public List<Syntax> Parameters { get; } = new();
		public List<string> Conventions { get; } = new();
		public List<int> ArrayRanks { get; } = new();
		public bool ByRef;
		public int Pointers;
		public bool Nullable;
		public bool Unmanaged;
	}
}
