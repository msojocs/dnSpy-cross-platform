using System.Globalization;
using dnlib.DotNet;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core;

/// <summary>
/// A member written the way dnSpy's C# formatter writes one for a tool window — <c>CSharpFormatter.Write(IMemberRef)</c>
/// in dnSpy.Decompiler, which the Bookmarks window's Location column goes through: <c>void Program.Main(string[] args)</c>,
/// <c>int Program.Code { get; set; }</c>, a getter as <c>int Program.Code.get</c> — and <c>CSharpFormatter.WriteToolTip</c>,
/// which the search window's tooltips go through: <c>(constant) int Library.Answer = 0x00001092</c>. This is the part of
/// it definitions reach, ported against dnlib and written in the color classes dnSpy's syntax highlighting gives each
/// stretch. What a definition never needs (generic arguments of a reference, the formatter's own tokens, array sizes
/// of a reference's signature) is left out.
/// </summary>
sealed class CSharpMemberFormatter {
	/// <summary>The FormatterOptions flags the tool windows switch, with dnSpy's values; ShowTokens and ShowArrayValueSizes are never on.</summary>
	[Flags]
	public enum Options {
		None = 0,
		ModuleNames = 0x01,
		ParameterTypes = 0x02,
		ParameterNames = 0x04,
		DeclaringTypes = 0x08,
		ReturnTypes = 0x10,
		FieldTypes = 0x20,
		Namespaces = 0x40,
		IntrinsicTypeKeywords = 0x80,
		UseDecimal = 0x100,
		FieldLiteralValues = 0x800,
		ParameterLiteralValues = 0x1000,
		DigitSeparators = 0x2000,
	}

	// TypeFormatterUtils.MAX_RECURSION
	const int MaxRecursion = 200;
	// TypeFormatterUtils.MAX_OUTPUT_LEN: past it the text is cut short with "[...]" and the rest dropped.
	const int MaxOutputLength = 1024 * 4;

	// The English values of dnSpy.Decompiler.Resources.resx.
	const string DeprecatedMember = "deprecated";
	const string AwaitableMethod = "awaitable";
	const string ExtensionMethod = "extension";
	const string ConstantDescription = "constant";
	const string FieldDescription = "field";
	const string OneMethodOverload = "1 overload";
	const string MethodOverloadsFormat = "{0} overloads";

	const string RequiredMembersMarker = "Constructors of types with required members are not supported in this version of your compiler.";
	const string ByRefLikeMarker = "This type is for compiler use only and is not intended to be used directly from your code.";

	static readonly HashSet<string> Keywords = new(StringComparer.Ordinal) {
		"abstract", "as", "base", "bool", "break", "byte", "case", "catch",
		"char", "checked", "class", "const", "continue", "decimal", "default", "delegate",
		"do", "double", "else", "enum", "event", "explicit", "extern", "false",
		"finally", "fixed", "float", "for", "foreach", "goto", "if", "implicit",
		"in", "int", "interface", "internal", "is", "lock", "long", "namespace",
		"new", "null", "object", "operator", "out", "override", "params", "private",
		"protected", "public", "readonly", "ref", "return", "sbyte", "sealed", "short",
		"sizeof", "stackalloc", "static", "string", "struct", "switch", "this", "throw",
		"true", "try", "typeof", "uint", "ulong", "unchecked", "unsafe", "ushort",
		"using", "virtual", "void", "volatile", "while",
	};

	static readonly Dictionary<string, string[]> OperatorNames = new(StringComparer.Ordinal) {
		["op_Addition"] = ["operator", "+"],
		["op_BitwiseAnd"] = ["operator", "&"],
		["op_BitwiseOr"] = ["operator", "|"],
		["op_Decrement"] = ["operator", "--"],
		["op_Division"] = ["operator", "/"],
		["op_Equality"] = ["operator", "=="],
		["op_ExclusiveOr"] = ["operator", "^"],
		["op_Explicit"] = ["explicit", "operator"],
		["op_False"] = ["operator", "false"],
		["op_GreaterThan"] = ["operator", ">"],
		["op_GreaterThanOrEqual"] = ["operator", ">="],
		["op_Implicit"] = ["implicit", "operator"],
		["op_Increment"] = ["operator", "++"],
		["op_Inequality"] = ["operator", "!="],
		["op_LeftShift"] = ["operator", "<<"],
		["op_LessThan"] = ["operator", "<"],
		["op_LessThanOrEqual"] = ["operator", "<="],
		["op_LogicalNot"] = ["operator", "!"],
		["op_Modulus"] = ["operator", "%"],
		["op_Multiply"] = ["operator", "*"],
		["op_OnesComplement"] = ["operator", "~"],
		["op_RightShift"] = ["operator", ">>"],
		["op_Subtraction"] = ["operator", "-"],
		["op_True"] = ["operator", "true"],
		["op_UnaryNegation"] = ["operator", "-"],
		["op_UnaryPlus"] = ["operator", "+"],
	};

	readonly TextPartsBuilder output;
	readonly Func<ITypeDefOrRef, string> typeColor;
	// Not readonly: a type's tooltip switches namespaces and keywords for a stretch, as dnSpy's WriteType does.
	Options options;
	int recursion;
	int lineLength;
	bool outputLengthExceeded;

	CSharpMemberFormatter(TextPartsBuilder output, Options options, Func<ITypeDefOrRef, string>? typeColor) {
		this.output = output;
		this.options = options;
		this.typeColor = typeColor ?? DefaultTypeColor;
	}

	/// <summary>
	/// Writes a definition. <paramref name="typeColor"/> picks a type name's color class; without one a type is
	/// colored after its definition when that is in the same module, and as a plain type otherwise — resolving
	/// further would load assemblies only to color a row.
	/// </summary>
	public static void Write(TextPartsBuilder output, IMemberDef member, Options options, Func<ITypeDefOrRef, string>? typeColor = null) =>
		new CSharpMemberFormatter(output, options, typeColor).WriteMember(member);

	/// <summary>
	/// Writes a definition's tooltip — <c>CSharpFormatter.WriteToolTip(IMemberRef)</c>: the member as <see cref="Write"/>
	/// writes it, after "[deprecated]" and "(awaitable, extension)" where they apply and with "(field)", "(constant)",
	/// " (+ 2 overloads)" or a type's keyword around it. dnSpy writes a tooltip with FormatterOptions.Default and
	/// ShowParameterLiteralValues.
	/// </summary>
	public static void WriteToolTip(TextPartsBuilder output, IMemberDef member, Options options, Func<ITypeDefOrRef, string>? typeColor = null) =>
		new CSharpMemberFormatter(output, options, typeColor).WriteMemberToolTip(member);

	static string DefaultTypeColor(ITypeDefOrRef type) =>
		MetadataTextColors.Of(type, reference => reference as TypeDef ?? (reference is TypeRef typeRef ? typeRef.Module?.Find(typeRef) : null));

	bool Has(Options option) => (options & option) != 0;

	void WriteMember(IMemberDef member) {
		switch (member) {
			case MethodDef method:
				Write(method);
				break;
			case FieldDef field:
				Write(field, isToolTip: false);
				break;
			case PropertyDef property:
				Write(property, writeAccessors: true);
				break;
			case EventDef @event:
				Write(@event, writeAccessors: true);
				break;
			case TypeDef type:
				Write(type, Has(Options.ModuleNames));
				break;
			default:
				WriteError();
				break;
		}
	}

	// ---------------------------------------------------------------- tooltips

	void WriteMemberToolTip(IMemberDef member) {
		switch (member) {
			case MethodDef method:
				WriteToolTip(method);
				break;
			case FieldDef field:
				WriteDeprecated(IsDeprecated(field.CustomAttributes));
				Write(field, isToolTip: true);
				break;
			case PropertyDef property:
				WriteDeprecated(IsDeprecated(property.CustomAttributes));
				Write(property, writeAccessors: true);
				break;
			case EventDef @event:
				WriteDeprecated(IsDeprecated(@event.CustomAttributes));
				Write(@event, writeAccessors: true);
				break;
			case TypeDef type:
				WriteToolTip(type);
				break;
			default:
				WriteError();
				break;
		}
	}

	void WriteToolTip(MethodDef method) {
		WriteDeprecated(IsDeprecated(method.CustomAttributes));
		WriteSpecialFlags(GetMemberSpecialFlags(method));
		Write(method);
		if (method.DeclaringType is { } type && GetNumberOfOverloadsString(type, method) is { } overloads)
			OutputWrite(TextColors.Text, overloads);
	}

	/// <summary>A type's tooltip: its keyword, then the type with its namespace — a delegate as its Invoke method.</summary>
	void WriteToolTip(TypeDef type) {
		WriteDeprecated(IsDeprecated(type));
		WriteSpecialFlags(IsAwaitableType(type) ? SpecialFlags.Awaitable : SpecialFlags.None);

		if (IsDelegate(type) && type.FindMethod("Invoke") is { MethodSig: not null } invoke) {
			OutputWrite(TextColors.Keyword, "delegate");
			WriteSpace();
			WriteModuleName(invoke.Module);
			WriteReturnType(invoke, retTypeIsLastArgType: false, writeSpace: true, isReadOnly: IsReadOnlyMethod(invoke), force: false);
			// Always print the namespace here because that's what VS does
			WriteType(type, useNamespaces: true, Has(Options.IntrinsicTypeKeywords));
			if (invoke.MethodSig.GenParamCount > 0)
				WriteGenerics(invoke.GenericParameters, TextColors.MethodGenericParameter);
			WriteMethodParameterList(invoke, retTypeIsLastArgType: false, "(", ")");
			return;
		}

		WriteModuleName(type.Module);
		string keyword;
		if (type.IsEnum)
			keyword = "enum";
		else if (type.IsValueType) {
			if (HasIsReadOnlyAttribute(type.CustomAttributes)) {
				OutputWrite(TextColors.Keyword, "readonly");
				WriteSpace();
			}
			if (IsByRefLike(type)) {
				OutputWrite(TextColors.Keyword, "ref");
				WriteSpace();
			}
			keyword = "struct";
		}
		else if (type.IsInterface)
			keyword = "interface";
		else
			keyword = "class";
		OutputWrite(TextColors.Keyword, keyword);
		WriteSpace();
		// Always print the namespace here because that's what VS does
		WriteType(type, useNamespaces: true, useTypeKeywords: false);
	}

	/// <summary>
	/// A type with its own generic parameters — <c>CSharpFormatter.WriteType</c>, a tooltip's way of naming one, with
	/// namespaces and keywords as the caller says rather than as the options do.
	/// </summary>
	void WriteType(TypeDef type, bool useNamespaces, bool useTypeKeywords) {
		var oldOptions = options;
		if (type.GenericParameters.Count == 0 || (type.DeclaringType is not null && type.DeclaringType.GenericParameters.Count >= type.GenericParameters.Count)) {
			options &= ~(Options.Namespaces | Options.IntrinsicTypeKeywords);
			if (useNamespaces)
				options |= Options.Namespaces;
			if (useTypeKeywords)
				options |= Options.IntrinsicTypeKeywords;
			Write(type);
			options = oldOptions;
			return;
		}

		// A nested type's generic parameters start with its outer types' ones; only its own are written after it.
		var genericParameterCount = type.GenericParameters.Count;
		if (type.DeclaringType is not null) {
			options &= ~(Options.Namespaces | Options.IntrinsicTypeKeywords);
			if (useNamespaces)
				options |= Options.Namespaces;
			Write(type.DeclaringType);
			options = oldOptions;
			WritePeriod();
			genericParameterCount = Math.Max(0, genericParameterCount - type.DeclaringType.GenericParameters.Count);
		}
		else if (useNamespaces && !UTF8String.IsNullOrEmpty(type.Namespace)) {
			foreach (var part in type.Namespace.String.Split('.')) {
				WriteIdentifier(part, TextColors.Namespace);
				WritePeriod();
			}
		}
		WriteIdentifier(RemoveGenericTick(type.Name), typeColor(type));
		WriteGenerics(type.GenericParameters.Skip(type.GenericParameters.Count - genericParameterCount).ToArray(), TextColors.TypeGenericParameter);
	}

	void WriteDeprecated(bool isDeprecated) {
		if (!isDeprecated)
			return;
		OutputWrite(TextColors.Punctuation, "[");
		OutputWrite(TextColors.Text, DeprecatedMember);
		OutputWrite(TextColors.Punctuation, "]");
		WriteSpace();
	}

	/// <summary>TypeFormatterUtils' MemberSpecialFlags.</summary>
	[Flags]
	enum SpecialFlags {
		None = 0,
		Extension = 1,
		Awaitable = 2,
	}

	void WriteSpecialFlags(SpecialFlags flags) {
		if (flags == SpecialFlags.None)
			return;
		OutputWrite(TextColors.Punctuation, "(");
		var comma = false;
		if ((flags & SpecialFlags.Awaitable) != 0) {
			comma = true;
			OutputWrite(TextColors.Text, AwaitableMethod);
		}
		if ((flags & SpecialFlags.Extension) != 0) {
			if (comma)
				WriteCommaSpace();
			OutputWrite(TextColors.Text, ExtensionMethod);
		}
		OutputWrite(TextColors.Punctuation, ")");
		WriteSpace();
	}

	// ---------------------------------------------------------------- members

	void Write(MethodDef method) {
		// An accessor is written as the member it belongs to, then which accessor it is.
		foreach (var property in method.DeclaringType?.Properties ?? []) {
			if (method == property.GetMethod) {
				Write(property, writeAccessors: false);
				WriteAccessor("get");
				return;
			}
			if (method == property.SetMethod) {
				Write(property, writeAccessors: false);
				WriteAccessor(IsInitOnly(method) ? "init" : "set");
				return;
			}
		}
		foreach (var @event in method.DeclaringType?.Events ?? []) {
			if (method == @event.AddMethod || method == @event.RemoveMethod) {
				Write(@event, writeAccessors: false);
				WriteAccessor(method == @event.AddMethod ? "add" : "remove");
				return;
			}
		}

		WriteModuleName(method.Module);
		string[]? operatorInfo = method.IsConstructor && method.DeclaringType is not null ? null
			: method.Overrides.Count > 0 ? TryGetOperatorInfo(method.Overrides[0].MethodDeclaration.Name)
			: TryGetOperatorInfo(method.Name);
		var isConversion = operatorInfo is not null && operatorInfo[0] is "explicit" or "implicit";
		if (!isConversion)
			WriteReturnType(method, retTypeIsLastArgType: false, writeSpace: true, isReadOnly: IsReadOnlyMethod(method), force: false);
		if (Has(Options.DeclaringTypes)) {
			Write(method.DeclaringType);
			WritePeriod();
		}
		if (method.IsConstructor && method.DeclaringType is not null)
			WriteIdentifier(RemoveGenericTick(method.DeclaringType.Name), MetadataTextColors.Of(method));
		else if (method.Overrides.Count > 0)
			WriteMethodName(method, method.Overrides[0].MethodDeclaration.Name, operatorInfo);
		else
			WriteMethodName(method, method.Name, operatorInfo);
		if (isConversion) {
			WriteSpace();
			WriteReturnType(method, retTypeIsLastArgType: false, writeSpace: false, isReadOnly: IsReadOnlyMethod(method), force: true);
		}
		if (method.MethodSig?.GenParamCount > 0)
			WriteGenerics(method.GenericParameters, TextColors.MethodGenericParameter);
		WriteMethodParameterList(method, retTypeIsLastArgType: false, "(", ")");
	}

	void WriteMethodName(MethodDef method, string name, string[]? operatorInfo) {
		if (operatorInfo is null) {
			WriteIdentifier(name, MetadataTextColors.Of(method));
			return;
		}
		for (var index = 0; index < operatorInfo.Length; index++) {
			if (index > 0)
				WriteSpace();
			var part = operatorInfo[index];
			OutputWrite(char.IsAsciiLetterLower(part[0]) ? TextColors.Keyword : TextColors.Operator, part);
		}
	}

	void WriteAccessor(string keyword) {
		OutputWrite(TextColors.Operator, ".");
		OutputWrite(TextColors.Keyword, keyword);
	}

	/// <summary>
	/// A field: its type, owner and name, and " = value" for a constant. An enum's constants go without the type
	/// every one of them has; a tooltip says in front whether the field is a constant.
	/// </summary>
	void Write(FieldDef field, bool isToolTip) {
		var isEnumOwner = field.DeclaringType?.IsEnum == true;
		object? constant = null;
		var isConstant = (field.IsLiteral || (field.IsStatic && field.IsInitOnly)) && HasConstant(field, out var constantAttribute) && TryGetConstant(field, constantAttribute, out constant);
		if (!isEnumOwner || !field.IsLiteral) {
			if (isToolTip) {
				OutputWrite(TextColors.Punctuation, "(");
				OutputWrite(TextColors.Text, isConstant ? ConstantDescription : FieldDescription);
				OutputWrite(TextColors.Punctuation, ")");
				WriteSpace();
			}
			WriteModuleName(field.Module);
			if (Has(Options.FieldTypes)) {
				Write(field.FieldSig?.Type, ownerParameter: null, forceReadOnly: false, attributeProvider: field);
				WriteSpace();
			}
		}
		else
			WriteModuleName(field.Module);
		if (Has(Options.DeclaringTypes)) {
			Write(field.DeclaringType);
			WritePeriod();
		}
		WriteIdentifier(field.Name, MetadataTextColors.Of(field));
		if (Has(Options.FieldLiteralValues) && isConstant) {
			WriteSpace();
			OutputWrite(TextColors.Operator, "=");
			WriteSpace();
			WriteConstant(constant);
		}
	}

	void Write(PropertyDef property, bool writeAccessors) {
		var getter = property.GetMethods.FirstOrDefault();
		var setter = property.SetMethods.FirstOrDefault();
		var accessor = getter ?? setter;
		if (accessor is null) {
			WriteError();
			return;
		}
		// A property with only a setter has its type as the setter's last parameter.
		var retTypeIsLastArgType = accessor == setter;
		WriteModuleName(accessor.Module);
		WriteReturnType(accessor, retTypeIsLastArgType, writeSpace: true, isReadOnly: HasIsReadOnlyAttribute(property.CustomAttributes), force: false);
		if (Has(Options.DeclaringTypes)) {
			Write(property.DeclaringType);
			WritePeriod();
		}
		var overridden = accessor.Overrides.Count == 0 ? null : accessor.Overrides[0].MethodDeclaration;
		if (IsIndexer(property)) {
			OutputWrite(TextColors.Keyword, "this");
			if (accessor.MethodSig?.GenParamCount > 0)
				WriteGenerics(accessor.GenericParameters, TextColors.MethodGenericParameter);
			WriteMethodParameterList(accessor, retTypeIsLastArgType, "[", "]");
		}
		else if (overridden is not null && GetPropertyName(overridden) is { } overriddenName)
			WriteIdentifier(overriddenName, MetadataTextColors.Of(property));
		else
			WriteIdentifier(property.Name, MetadataTextColors.Of(property));

		if (!writeAccessors)
			return;
		WriteSpace();
		OutputWrite(TextColors.Punctuation, "{");
		if (property.GetMethods.Count > 0) {
			WriteSpace();
			OutputWrite(TextColors.Keyword, "get");
			OutputWrite(TextColors.Punctuation, ";");
		}
		if (property.SetMethods.Count > 0) {
			WriteSpace();
			OutputWrite(TextColors.Keyword, property.SetMethods.Count == 1 && IsInitOnly(property.SetMethod) ? "init" : "set");
			OutputWrite(TextColors.Punctuation, ";");
		}
		WriteSpace();
		OutputWrite(TextColors.Punctuation, "}");
	}

	void Write(EventDef @event, bool writeAccessors) {
		WriteModuleName(@event.Module);
		Write(@event.EventType, attributeProvider: @event);
		WriteSpace();
		if (Has(Options.DeclaringTypes)) {
			Write(@event.DeclaringType);
			WritePeriod();
		}
		WriteIdentifier(@event.Name, MetadataTextColors.Of(@event));
		if (!writeAccessors)
			return;
		WriteSpace();
		OutputWrite(TextColors.Punctuation, "{");
		if (@event.AddMethod is not null) {
			WriteSpace();
			OutputWrite(TextColors.Keyword, "add");
			OutputWrite(TextColors.Punctuation, ";");
		}
		if (@event.RemoveMethod is not null) {
			WriteSpace();
			OutputWrite(TextColors.Keyword, "remove");
			OutputWrite(TextColors.Punctuation, ";");
		}
		WriteSpace();
		OutputWrite(TextColors.Punctuation, "}");
	}

	void WriteReturnType(MethodDef method, bool retTypeIsLastArgType, bool writeSpace, bool isReadOnly, bool force) {
		if (!force && !Has(Options.ReturnTypes))
			return;
		if (method.IsConstructor)
			return;
		TypeSig? returnType;
		ParamDef? returnParameter;
		if (retTypeIsLastArgType) {
			returnType = method.MethodSig?.Params.LastOrDefault();
			returnParameter = method.Parameters.LastOrDefault()?.ParamDef;
		}
		else {
			returnType = method.MethodSig?.RetType;
			returnParameter = method.Parameters.ReturnParameter.ParamDef;
		}
		Write(returnType, returnParameter, isReadOnly, returnParameter);
		if (writeSpace)
			WriteSpace();
	}

	void WriteMethodParameterList(MethodDef method, bool retTypeIsLastArgType, string open, string close) {
		if (!Has(Options.ParameterTypes) && !Has(Options.ParameterNames))
			return;
		var signature = method.MethodSig ?? new MethodSig(CallingConvention.Default);
		OutputWrite(TextColors.Punctuation, open);
		var baseIndex = signature.HasThis ? 1 : 0;
		var count = signature.Params.Count;
		if (retTypeIsLastArgType)
			count--;
		for (var index = 0; index < count; index++) {
			if (index > 0)
				WriteCommaSpace();
			var parameter = baseIndex + index < method.Parameters.Count ? method.Parameters[baseIndex + index].ParamDef : null;
			// A parameter with a default value is written in brackets, the value itself only with literal values on.
			var isDefault = HasConstant(parameter, out var constantAttribute);
			if (isDefault)
				OutputWrite(TextColors.Punctuation, "[");
			var needSpace = false;
			if (Has(Options.ParameterTypes)) {
				needSpace = true;
				if (parameter is not null && parameter.CustomAttributes.IsDefined("System.ParamArrayAttribute")) {
					OutputWrite(TextColors.Keyword, "params");
					WriteSpace();
				}
				Write(signature.Params[index], parameter, forceReadOnly: false, parameter);
			}
			if (Has(Options.ParameterNames)) {
				if (needSpace)
					WriteSpace();
				needSpace = true;
				if (parameter is not null)
					WriteIdentifier(parameter.Name, TextColors.Parameter);
				else
					WriteIdentifier($"A_{(baseIndex + index).ToString(CultureInfo.InvariantCulture)}", TextColors.Parameter);
			}
			if (Has(Options.ParameterLiteralValues) && isDefault && TryGetConstant(parameter, constantAttribute, out var constant)) {
				// dnSpy writes a space before " = " as well, so a value follows its name after two.
				if (needSpace)
					WriteSpace();
				needSpace = true;
				WriteSpace();
				OutputWrite(TextColors.Operator, "=");
				WriteSpace();
				// A struct's default — a null constant for a value type — is "default", not "null".
				var type = signature.Params[index].RemovePinnedAndModifiers();
				if (type.GetElementType() == ElementType.ByRef)
					type = type.Next;
				if (constant is null && type is not null && type.IsValueType)
					OutputWrite(TextColors.Keyword, "default");
				else
					WriteConstant(constant);
			}
			if (isDefault)
				OutputWrite(TextColors.Punctuation, "]");
		}
		if (signature.IsVarArg) {
			if (count > 0)
				WriteCommaSpace();
			OutputWrite(TextColors.Keyword, "__arglist");
		}
		OutputWrite(TextColors.Punctuation, close);
	}

	void WriteGenerics(IList<GenericParam> parameters, string color) {
		if (parameters.Count == 0)
			return;
		OutputWrite(TextColors.Punctuation, "<");
		for (var index = 0; index < parameters.Count; index++) {
			if (index > 0)
				WriteCommaSpace();
			var parameter = parameters[index];
			if (parameter.IsCovariant) {
				OutputWrite(TextColors.Keyword, "out");
				WriteSpace();
			}
			else if (parameter.IsContravariant) {
				OutputWrite(TextColors.Keyword, "in");
				WriteSpace();
			}
			WriteIdentifier(parameter.Name, color);
		}
		OutputWrite(TextColors.Punctuation, ">");
	}

	void WriteModuleName(ModuleDef? module) {
		if (module is null || !Has(Options.ModuleNames))
			return;
		OutputWrite(TextColors.AssemblyModule, FilterName(GetFileName(module.Location ?? string.Empty)));
		OutputWrite(TextColors.Operator, "!");
	}

	// ---------------------------------------------------------------- types

	/// <summary>A type by name — its enclosing types, namespace when they are shown, never its generic parameters.</summary>
	void Write(ITypeDefOrRef? type, bool showModuleNames = false, IHasCustomAttribute? attributeProvider = null) {
		if (type is null) {
			WriteError();
			return;
		}
		if (recursion >= MaxRecursion)
			return;
		recursion++;
		try {
			if (type is TypeSpec typeSpec) {
				Write(typeSpec.TypeSig, null, forceReadOnly: false, attributeProvider);
				return;
			}
			if (type.DeclaringType is not null) {
				Write(type.DeclaringType);
				WritePeriod();
			}
			if (GetTypeKeyword(type) is { } keyword) {
				OutputWrite(TextColors.Keyword, keyword);
				return;
			}
			if (showModuleNames)
				WriteModuleName(type.ResolveTypeDef()?.Module);
			WriteNamespace(type.Namespace);
			WriteIdentifier(RemoveGenericTick(type.Name), typeColor(type));
		}
		finally {
			recursion--;
		}
	}

	void WriteNamespace(string? @namespace) {
		if (!Has(Options.Namespaces) || string.IsNullOrEmpty(@namespace))
			return;
		foreach (var part in @namespace.Split('.')) {
			OutputWrite(TextColors.Namespace, part);
			WritePeriod();
		}
	}

	string? GetTypeKeyword(ITypeDefOrRef type) {
		if (!Has(Options.IntrinsicTypeKeywords))
			return null;
		if (type.DeclaringType is not null || type.Namespace != "System" || !type.DefinitionAssembly.IsCorLib())
			return null;
		return type.TypeName switch {
			"Void" => "void",
			"Boolean" => "bool",
			"Byte" => "byte",
			"Char" => "char",
			"Decimal" => "decimal",
			"Double" => "double",
			"Int16" => "short",
			"Int32" => "int",
			"Int64" => "long",
			"Object" => "object",
			"SByte" => "sbyte",
			"Single" => "float",
			"String" => "string",
			"UInt16" => "ushort",
			"UInt32" => "uint",
			"UInt64" => "ulong",
			_ => null,
		};
	}

	/// <summary>Where a signature stands among the positions dnSpy's attribute flags index: dynamic, tuple names, nint.</summary>
	struct TypeState {
		public int DynamicTypeIndex;
		public int TupleNameIndex;
		public int NativeIntIndex;
	}

	/// <summary>A signature as a parameter or a return value wears it: a byref spelled out in front.</summary>
	void Write(TypeSig? type, ParamDef? ownerParameter, bool forceReadOnly, IHasCustomAttribute? attributeProvider) {
		var state = new TypeState();
		while (type.RemovePinned() is ModifierSig modifier) {
			state.DynamicTypeIndex++;
			type = modifier.Next;
		}
		if (type.RemovePinnedAndModifiers() is ByRefSig) {
			if (ownerParameter is not null && !ownerParameter.IsIn && ownerParameter.IsOut)
				OutputWrite(TextColors.Keyword, "out");
			else if (ownerParameter is not null && ownerParameter.IsIn && !ownerParameter.IsOut && HasIsReadOnlyAttribute(ownerParameter.CustomAttributes))
				OutputWrite(TextColors.Keyword, "in");
			else {
				OutputWrite(TextColors.Keyword, "ref");
				if (forceReadOnly) {
					WriteSpace();
					OutputWrite(TextColors.Keyword, "readonly");
				}
			}
			WriteSpace();
		}
		if (type is ByRefSig byRef) {
			state.DynamicTypeIndex++;
			type = byRef.Next;
		}
		Write(type, ref state, attributeProvider);
	}

	void Write(TypeSig? type, ref TypeState state, IHasCustomAttribute? attributeProvider) {
		if (type is null) {
			WriteError();
			return;
		}
		if (recursion >= MaxRecursion)
			return;
		recursion++;
		try {
			List<ArraySigBase>? arrays = null;
			while (type is not null && type.ElementType is ElementType.SZArray or ElementType.Array) {
				(arrays ??= []).Add((ArraySigBase)type);
				type = type.Next;
			}
			if (arrays is not null) {
				state.DynamicTypeIndex += arrays.Count;
				Write(arrays[^1].Next, ref state, attributeProvider);
				foreach (var array in arrays) {
					OutputWrite(TextColors.Punctuation, "[");
					if (array.ElementType == ElementType.Array) {
						var rank = array.Rank;
						if (rank == 0)
							OutputWrite(TextColors.Error, "<RANK0>");
						else {
							if (rank == 1)
								OutputWrite(TextColors.Operator, "*");
							for (uint dimension = 1; dimension < rank; dimension++)
								OutputWrite(TextColors.Punctuation, ",");
						}
					}
					OutputWrite(TextColors.Punctuation, "]");
				}
				return;
			}
			if (type is null)
				return;
			switch (type.ElementType) {
				case ElementType.Void: WriteSystemTypeKeyword("Void", "void", true); break;
				case ElementType.Boolean: WriteSystemTypeKeyword("Boolean", "bool", true); break;
				case ElementType.Char: WriteSystemTypeKeyword("Char", "char", true); break;
				case ElementType.I1: WriteSystemTypeKeyword("SByte", "sbyte", true); break;
				case ElementType.U1: WriteSystemTypeKeyword("Byte", "byte", true); break;
				case ElementType.I2: WriteSystemTypeKeyword("Int16", "short", true); break;
				case ElementType.U2: WriteSystemTypeKeyword("UInt16", "ushort", true); break;
				case ElementType.I4: WriteSystemTypeKeyword("Int32", "int", true); break;
				case ElementType.U4: WriteSystemTypeKeyword("UInt32", "uint", true); break;
				case ElementType.I8: WriteSystemTypeKeyword("Int64", "long", true); break;
				case ElementType.U8: WriteSystemTypeKeyword("UInt64", "ulong", true); break;
				case ElementType.R4: WriteSystemTypeKeyword("Single", "float", true); break;
				case ElementType.R8: WriteSystemTypeKeyword("Double", "double", true); break;
				case ElementType.String: WriteSystemTypeKeyword("String", "string", false); break;
				case ElementType.Object:
					if (HasDynamicAttribute(attributeProvider, state.DynamicTypeIndex))
						OutputWrite(TextColors.Keyword, "dynamic");
					else
						WriteSystemTypeKeyword("Object", "object", false);
					break;
				case ElementType.TypedByRef:
					WriteSystemType("TypedReference", true);
					break;
				case ElementType.I:
					if (HasNativeIntegerAttribute(attributeProvider, state.NativeIntIndex++))
						OutputWrite(TextColors.Keyword, "nint");
					else
						WriteSystemType("IntPtr", true);
					break;
				case ElementType.U:
					if (HasNativeIntegerAttribute(attributeProvider, state.NativeIntIndex++))
						OutputWrite(TextColors.Keyword, "nuint");
					else
						WriteSystemType("UIntPtr", true);
					break;
				case ElementType.Ptr:
					state.DynamicTypeIndex++;
					Write(type.Next, ref state, attributeProvider);
					OutputWrite(TextColors.Operator, "*");
					break;
				case ElementType.ByRef:
					state.DynamicTypeIndex++;
					OutputWrite(TextColors.Keyword, "ref");
					WriteSpace();
					Write(type.Next, ref state, attributeProvider);
					break;
				case ElementType.ValueType:
				case ElementType.Class:
					Write(((TypeDefOrRefSig)type).TypeDefOrRef);
					break;
				case ElementType.Var:
				case ElementType.MVar:
					var genericSig = (GenericSig)type;
					if (genericSig.GenericParam is { } genericParam)
						WriteIdentifier(genericParam.Name, genericSig.IsMethodVar ? TextColors.MethodGenericParameter : TextColors.TypeGenericParameter);
					else if (genericSig.IsMethodVar)
						OutputWrite(TextColors.MethodGenericParameter, $"!!{genericSig.Number.ToString(CultureInfo.InvariantCulture)}");
					else
						OutputWrite(TextColors.TypeGenericParameter, $"!{genericSig.Number.ToString(CultureInfo.InvariantCulture)}");
					break;
				case ElementType.GenericInst:
					WriteGenericInstance((GenericInstSig)type, ref state, attributeProvider);
					break;
				case ElementType.FnPtr:
					WriteFunctionPointer(((FnPtrSig)type).MethodSig, ref state, attributeProvider);
					break;
				case ElementType.CModReqd:
				case ElementType.CModOpt:
					state.DynamicTypeIndex++;
					Write(type.Next, ref state, attributeProvider);
					break;
				case ElementType.Pinned:
					Write(type.Next, ref state, attributeProvider);
					break;
			}
		}
		finally {
			recursion--;
		}
	}

	void WriteGenericInstance(GenericInstSig generic, ref TypeState state, IHasCustomAttribute? attributeProvider) {
		if (IsSystemNullable(generic)) {
			state.DynamicTypeIndex++;
			Write(generic.GenericArguments[0], ref state, attributeProvider);
			OutputWrite(TextColors.Operator, "?");
			return;
		}
		var cardinality = GetSystemValueTupleRank(generic);
		if (cardinality > 1) {
			var tupleNameIndex = state.TupleNameIndex;
			state.TupleNameIndex += cardinality;
			OutputWrite(TextColors.Punctuation, "(");
			var needComma = false;
			GenericInstSig? current = generic;
			for (var rest = 0; rest < 1000 && current is not null; rest++) {
				for (var index = 0; index < current.GenericArguments.Count && index < 7; index++) {
					if (needComma)
						WriteCommaSpace();
					needComma = true;
					state.DynamicTypeIndex++;
					var elementName = GetTupleElementNameAtIndex(attributeProvider, tupleNameIndex++);
					Write(current.GenericArguments[index], ref state, attributeProvider);
					if (elementName is not null) {
						WriteSpace();
						OutputWrite(TextColors.InstanceField, elementName);
					}
				}
				if (current.GenericArguments.Count != 8)
					break;
				current = current.GenericArguments[^1] as GenericInstSig;
				state.DynamicTypeIndex++;
				if (current is null) {
					WriteError();
					break;
				}
				state.TupleNameIndex += GetSystemValueTupleRank(current);
			}
			OutputWrite(TextColors.Punctuation, ")");
			return;
		}
		Write(generic.GenericType, ref state, attributeProvider);
		OutputWrite(TextColors.Punctuation, "<");
		for (var index = 0; index < generic.GenericArguments.Count; index++) {
			if (index > 0)
				WriteCommaSpace();
			state.DynamicTypeIndex++;
			Write(generic.GenericArguments[index], ref state, attributeProvider);
		}
		OutputWrite(TextColors.Punctuation, ">");
	}

	/// <summary>A function pointer, without the calling convention modifiers dnSpy spells out in brackets.</summary>
	void WriteFunctionPointer(MethodSig? signature, ref TypeState state, IHasCustomAttribute? attributeProvider) {
		OutputWrite(TextColors.Keyword, "delegate");
		OutputWrite(TextColors.Operator, "*");
		if (signature is null)
			return;
		if (signature.IsUnmanaged || !signature.IsDefault) {
			WriteSpace();
			OutputWrite(TextColors.Keyword, "unmanaged");
		}
		OutputWrite(TextColors.Punctuation, "<");
		state.DynamicTypeIndex++;
		foreach (var parameter in signature.Params) {
			state.DynamicTypeIndex++;
			var parameterType = parameter.RemovePinnedAndModifiers();
			if (parameterType is ByRefSig byRef) {
				OutputWrite(TextColors.Keyword, "ref");
				WriteSpace();
				parameterType = byRef.Next;
			}
			Write(parameterType, ref state, attributeProvider);
			WriteCommaSpace();
		}
		Write(signature.RetType.RemovePinnedAndModifiers(), ref state, attributeProvider);
		OutputWrite(TextColors.Punctuation, ">");
	}

	void WriteSystemTypeKeyword(string name, string keyword, bool isValueType) {
		if (Has(Options.IntrinsicTypeKeywords))
			OutputWrite(TextColors.Keyword, keyword);
		else
			WriteSystemType(name, isValueType);
	}

	void WriteSystemType(string name, bool isValueType) {
		if (Has(Options.Namespaces)) {
			OutputWrite(TextColors.Namespace, "System");
			WritePeriod();
		}
		OutputWrite(isValueType ? TextColors.ValueType : TextColors.Type, name);
	}

	// ---------------------------------------------------------------- output

	/// <summary>CSharpFormatter.OutputWrite: past MAX_OUTPUT_LEN characters a stretch is cut, "[...]" added and the rest dropped.</summary>
	void OutputWrite(string color, string text) {
		if (outputLengthExceeded)
			return;
		if (lineLength + text.Length > MaxOutputLength) {
			text = text[..(MaxOutputLength - lineLength)] + "[...]";
			outputLengthExceeded = true;
		}
		output.Write(color, text);
		lineLength += text.Length;
	}

	void WriteSpace() => OutputWrite(TextColors.Text, " ");

	void WriteCommaSpace() {
		OutputWrite(TextColors.Punctuation, ",");
		WriteSpace();
	}

	void WritePeriod() => OutputWrite(TextColors.Operator, ".");
	void WriteError() => OutputWrite(TextColors.Error, "???");

	// ---------------------------------------------------------------- constants

	/// <summary>A field's or a parameter's constant as C# writes it: integers in hex unless decimals are asked for.</summary>
	void WriteConstant(object? value) {
		switch (value) {
			case null:
				OutputWrite(TextColors.Keyword, "null");
				break;
			case bool boolean:
				OutputWrite(TextColors.Keyword, boolean ? "true" : "false");
				break;
			case char ch:
				OutputWrite(TextColors.Char, ToFormattedChar(ch));
				break;
			case sbyte number:
				WriteNumber(number, "X2");
				break;
			case byte number:
				WriteNumber(number, "X2");
				break;
			case short number:
				WriteNumber(number, "X4");
				break;
			case ushort number:
				WriteNumber(number, "X4");
				break;
			case int number:
				WriteNumber(number, "X8");
				break;
			case uint number:
				WriteNumber(number, "X8");
				break;
			case long number:
				WriteNumber(number, "X16");
				break;
			case ulong number:
				WriteNumber(number, "X16");
				break;
			case float number:
				OutputWrite(TextColors.Number, float.IsNaN(number) ? "NaN" : float.IsNegativeInfinity(number) ? "-Infinity"
					: float.IsPositiveInfinity(number) ? "Infinity" : number.ToString(CultureInfo.InvariantCulture));
				break;
			case double number:
				OutputWrite(TextColors.Number, double.IsNaN(number) ? "NaN" : double.IsNegativeInfinity(number) ? "-Infinity"
					: double.IsPositiveInfinity(number) ? "Infinity" : number.ToString(CultureInfo.InvariantCulture));
				break;
			case decimal number:
				OutputWrite(TextColors.Number, number.ToString(CultureInfo.InvariantCulture));
				break;
			case string text:
				if (CanUseVerbatimString(text))
					OutputWrite(TextColors.VerbatimString, GetFormattedVerbatimString(text));
				else
					OutputWrite(TextColors.String, GetFormattedString(text));
				break;
			default:
				OutputWrite(TextColors.Text, value.ToString() ?? "???");
				break;
		}
	}

	/// <summary>An integer in decimal (groups of 3) or in hex of its full width (groups of 4) after "0x".</summary>
	void WriteNumber<T>(T value, string hexFormat) where T : IFormattable {
		var useDecimal = Has(Options.UseDecimal);
		var number = useDecimal ? value.ToString(null, CultureInfo.InvariantCulture) : value.ToString(hexFormat, CultureInfo.InvariantCulture);
		if (Has(Options.DigitSeparators))
			number = AddDigitSeparators(number, useDecimal ? 3 : 4);
		OutputWrite(TextColors.Number, useDecimal ? number : "0x" + number);
	}

	/// <summary>TypeFormatterUtils.AddDigitSeparators: an "_" between every group counted from the right.</summary>
	static string AddDigitSeparators(string number, int digitGroupSize) {
		if (number.Length <= digitGroupSize)
			return number;
		var separated = new System.Text.StringBuilder();
		for (var index = 0; index < number.Length; index++) {
			var remaining = number.Length - index;
			if (index != 0 && remaining % digitGroupSize == 0 && number[index - 1] != '-')
				separated.Append('_');
			separated.Append(number[index]);
		}
		return separated.ToString();
	}

	static string ToFormattedChar(char value) {
		var formatted = new System.Text.StringBuilder();
		formatted.Append('\'');
		if (GetEscape(value) is { } escape)
			formatted.Append(escape);
		else if (value == '\'')
			formatted.Append(@"\'");
		else if (char.IsControl(value))
			formatted.Append(CultureInfo.InvariantCulture, $"\\u{(ushort)value:X4}");
		else
			formatted.Append(value);
		formatted.Append('\'');
		return formatted.ToString();
	}

	static string GetFormattedString(string value) {
		var formatted = new System.Text.StringBuilder();
		formatted.Append('"');
		foreach (var ch in value) {
			if (GetEscape(ch) is { } escape)
				formatted.Append(escape);
			else if (ch == '"')
				formatted.Append("\\\"");
			else if (char.IsControl(ch))
				formatted.Append(CultureInfo.InvariantCulture, $"\\u{(ushort)ch:X4}");
			else
				formatted.Append(ch);
		}
		formatted.Append('"');
		return formatted.ToString();
	}

	static string GetFormattedVerbatimString(string value) => "@\"" + value.Replace("\"", "\"\"") + "\"";

	/// <summary>The escapes a char and a string literal share.</summary>
	static string? GetEscape(char value) => value switch {
		'\a' => @"\a",
		'\b' => @"\b",
		'\f' => @"\f",
		'\n' => @"\n",
		'\r' => @"\r",
		'\t' => @"\t",
		'\v' => @"\v",
		'\\' => @"\\",
		'\0' => @"\0",
		_ => null,
	};

	/// <summary>A string goes verbatim when it has a backslash and nothing a verbatim string can't hold.</summary>
	static bool CanUseVerbatimString(string value) {
		var foundBackslash = false;
		foreach (var ch in value) {
			switch (ch) {
				case '"':
					break;
				case '\\':
					foundBackslash = true;
					break;
				case '\a' or '\b' or '\f' or '\n' or '\r' or '\t' or '\v' or '\0':
				// More newline chars
				case '\u0085' or '\u2028' or '\u2029':
					return false;
				default:
					if (char.IsControl(ch))
						return false;
					break;
			}
		}
		return foundBackslash;
	}

	/// <summary>TypeFormatterUtils.HasConstant: a constant in the table, or a [CustomConstant] / [DecimalConstant].</summary>
	static bool HasConstant(IHasConstant? owner, out CustomAttribute? constantAttribute) {
		constantAttribute = null;
		if (owner is null)
			return false;
		if (owner.Constant is not null)
			return true;
		foreach (var attribute in owner.CustomAttributes) {
			for (var type = attribute.AttributeType; type is not null; type = type.GetBaseType()) {
				var fullName = type.FullName;
				if (fullName is "System.Runtime.CompilerServices.CustomConstantAttribute" or "System.Runtime.CompilerServices.DecimalConstantAttribute") {
					constantAttribute = attribute;
					return true;
				}
			}
		}
		return false;
	}

	/// <summary>TypeFormatterUtils.TryGetConstant: of the attributes only [DecimalConstant] gives a value.</summary>
	static bool TryGetConstant(IHasConstant? owner, CustomAttribute? constantAttribute, out object? constant) {
		if (owner?.Constant is not null) {
			constant = owner.Constant.Value;
			return true;
		}
		if (constantAttribute?.TypeFullName == "System.Runtime.CompilerServices.DecimalConstantAttribute" && TryGetDecimalConstant(constantAttribute, out var value)) {
			constant = value;
			return true;
		}
		constant = null;
		return false;
	}

	static bool TryGetDecimalConstant(CustomAttribute attribute, out decimal value) {
		value = 0;
		var arguments = attribute.ConstructorArguments;
		if (arguments.Count != 5 || arguments[0].Value is not byte scale || arguments[1].Value is not byte sign)
			return false;
		int high, middle, low;
		if (arguments[2].Value is int && arguments[3].Value is int && arguments[4].Value is int) {
			high = (int)arguments[2].Value;
			middle = (int)arguments[3].Value;
			low = (int)arguments[4].Value;
		}
		else if (arguments[2].Value is uint && arguments[3].Value is uint && arguments[4].Value is uint) {
			high = (int)(uint)arguments[2].Value;
			middle = (int)(uint)arguments[3].Value;
			low = (int)(uint)arguments[4].Value;
		}
		else
			return false;
		try {
			value = new decimal(low, middle, high, sign > 0, scale);
			return true;
		}
		catch (ArgumentOutOfRangeException) {
			return false;
		}
	}

	// ---------------------------------------------------------------- pieces

	void WriteIdentifier(string? identifier, string color) {
		var text = FilterName(identifier);
		OutputWrite(color, Keywords.Contains(text) ? "@" + text : text);
	}

	static string[]? TryGetOperatorInfo(string? name) => name is not null && OperatorNames.TryGetValue(name, out var info) ? info : null;

	/// <summary>TypeFormatterUtils.GetNumberOfOverloadsString: the methods of the name in the type and, but for constructors, its base types.</summary>
	static string? GetNumberOfOverloadsString(TypeDef type, MethodDef method) {
		string name = method.Name;
		var checkBaseTypes = name is not (".ctor" or ".cctor");
		var methods = new HashSet<MethodDef>(MethodEqualityComparer.DontCompareDeclaringTypes);
		for (TypeDef? current = type; current is not null; current = current.BaseType.ResolveTypeDef()) {
			foreach (var candidate in current.Methods) {
				if (candidate.Name == name)
					methods.Add(candidate);
			}
			if (!checkBaseTypes)
				break;
		}
		var overloads = methods.Count - 1;
		if (overloads == 1)
			return $" (+ {OneMethodOverload})";
		if (overloads > 1)
			return $" (+ {string.Format(CultureInfo.InvariantCulture, MethodOverloadsFormat, overloads)})";
		return null;
	}

	/// <summary>TypeFormatterUtils.IsDeprecated of a member: [Obsolete] other than the one required members put on a constructor, or WinRT's [Deprecated].</summary>
	static bool IsDeprecated(CustomAttributeCollection attributes) {
		var foundRequiredMembersMarker = false;
		foreach (var attribute in attributes) {
			var fullName = attribute.TypeFullName;
			if (fullName == "Windows.Foundation.Metadata.DeprecatedAttribute")
				return true;
			if (fullName != "System.ObsoleteAttribute")
				continue;
			if (!IsCompilerMarker(attribute, RequiredMembersMarker))
				return true;
			foundRequiredMembersMarker = true;
		}
		return foundRequiredMembersMarker && !HasCompilerFeatureRequiredAttribute(attributes);
	}

	/// <summary>TypeFormatterUtils.IsDeprecated of a type: [Obsolete] other than the one the compiler puts on a ref struct.</summary>
	static bool IsDeprecated(TypeDef type) {
		var foundByRefLikeMarker = false;
		foreach (var attribute in type.CustomAttributes) {
			if (attribute.TypeFullName != "System.ObsoleteAttribute")
				continue;
			if (!IsCompilerMarker(attribute, ByRefLikeMarker))
				return true;
			foundByRefLikeMarker = true;
		}
		return foundByRefLikeMarker && !IsByRefLike(type);
	}

	/// <summary>An [Obsolete(marker, true)] the compiler writes to keep older compilers away.</summary>
	static bool IsCompilerMarker(CustomAttribute obsolete, string marker) =>
		obsolete.ConstructorArguments.Count == 2
		&& GetString(obsolete.ConstructorArguments[0].Value) == marker
		&& obsolete.ConstructorArguments[1].Value is true;

	static bool HasCompilerFeatureRequiredAttribute(CustomAttributeCollection attributes) =>
		attributes.Any(attribute => attribute.TypeFullName == "System.Runtime.CompilerServices.CompilerFeatureRequiredAttribute"
			&& attribute.ConstructorArguments.Count == 1 && GetString(attribute.ConstructorArguments[0].Value) == "RequiredMembers");

	static string? GetString(object? value) => (value as UTF8String)?.String ?? value as string;

	static bool IsByRefLike(TypeDef type) =>
		type.CustomAttributes.Any(attribute => attribute.TypeFullName == "System.Runtime.CompilerServices.IsByRefLikeAttribute");

	/// <summary>TypeFormatterUtils.GetMemberSpecialFlags of a method: an extension, and awaitable when it returns a task-like type.</summary>
	static SpecialFlags GetMemberSpecialFlags(MethodDef method) {
		var flags = SpecialFlags.None;
		if (method.CustomAttributes.Any(attribute => attribute.TypeFullName == "System.Runtime.CompilerServices.ExtensionAttribute"))
			flags |= SpecialFlags.Extension;
		if (IsAwaitableType(method.MethodSig.GetRetType().ToTypeDefOrRef().ResolveTypeDef()))
			flags |= SpecialFlags.Awaitable;
		return flags;
	}

	/// <summary>Roslyn's IsCustomTaskType as dnSpy reads it: Task, Task&lt;T&gt;, or a type with an [AsyncMethodBuilder].</summary>
	static bool IsAwaitableType(TypeDef? type) {
		if (type is null || type.GenericParameters.Count > 1)
			return false;
		if (type.Namespace == "System.Threading.Tasks" && type.Name.String is "Task" or "Task`1")
			return true;
		return type.CustomAttributes.Any(attribute => attribute.TypeFullName == "System.Runtime.CompilerServices.AsyncMethodBuilderAttribute"
			&& attribute.ConstructorArguments.Count == 1
			&& (attribute.ConstructorArguments[0].Type as ClassSig)?.TypeDefOrRef.FullName == "System.Type");
	}

	/// <summary>TypeFormatterUtils.IsDelegate: a type whose base is the core library's MulticastDelegate.</summary>
	static bool IsDelegate(TypeDef type) =>
		type.BaseType is { } baseType && baseType.FullName == "System.MulticastDelegate" && baseType.DefinitionAssembly.IsCorLib();

	/// <summary>TypeFormatterUtils.FilterName: control characters escaped, and a runaway name cut short.</summary>
	static string FilterName(string? name) {
		const int MaxNameLength = 0x100;
		if (name is null)
			return "<<NULL>>";
		var filtered = new System.Text.StringBuilder(Math.Min(name.Length, MaxNameLength));
		foreach (var ch in name) {
			if (filtered.Length >= MaxNameLength)
				break;
			if (ch >= ' ')
				filtered.Append(ch);
			else
				filtered.Append(CultureInfo.InvariantCulture, $"\\u{(ushort)ch:X4}");
		}
		if (filtered.Length > MaxNameLength)
			filtered.Length = MaxNameLength;
		return filtered.ToString();
	}

	static string RemoveGenericTick(string name) {
		var tick = name.LastIndexOf('`');
		// A compiler-generated name keeps its tick: "<>c__DisplayClass0_0`1" is not a generic arity.
		return tick < 0 || name.StartsWith('<') ? name : name[..tick];
	}

	static string GetFileName(string path) {
		var separator = Math.Max(path.LastIndexOf('/'), path.LastIndexOf('\\'));
		return separator < 0 ? path : path[(separator + 1)..];
	}

	static string? GetPropertyName(IMethod method) {
		var name = method.Name.String;
		return name.StartsWith("get_", StringComparison.Ordinal) || name.StartsWith("set_", StringComparison.Ordinal) ? name[4..] : null;
	}

	static bool IsInitOnly(MethodDef? setter) =>
		setter?.ReturnType is CModReqdSig modifier && modifier.Modifier.FullName == "System.Runtime.CompilerServices.IsExternalInit";

	static bool IsReadOnlyMethod(MethodDef method) =>
		!method.IsConstructor && HasIsReadOnlyAttribute(method.Parameters.ReturnParameter.ParamDef?.CustomAttributes);

	static bool HasIsReadOnlyAttribute(CustomAttributeCollection? attributes) =>
		attributes?.Any(attribute => attribute.AttributeType?.FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute" && attribute.AttributeType.DeclaringType is null) == true;

	/// <summary>An indexer is the property its type names in [DefaultMember] and takes parameters.</summary>
	static bool IsIndexer(PropertyDef property) {
		if (property.PropertySig.GetParamCount() == 0)
			return false;
		foreach (var attribute in property.DeclaringType?.CustomAttributes.FindAll("System.Reflection.DefaultMemberAttribute") ?? []) {
			if (attribute.ConstructorArguments.Count == 1 && attribute.ConstructorArguments[0].Value is { } value)
				return ((value as UTF8String)?.String ?? value as string) == property.Name.String;
		}
		return false;
	}


	static bool IsSystemNullable(GenericInstSig generic) =>
		generic.GenericType is ValueTypeSig { TypeDefOrRef: { } type } && type.DefinitionAssembly.IsCorLib() && type.FullName == "System.Nullable`1";

	static int GetSystemValueTupleRank(GenericInstSig generic) {
		var current = generic;
		var rank = 0;
		for (var depth = 0; depth < 1000; depth++) {
			var simple = GetValueTupleSimpleRank(current);
			if (simple < 0)
				return -1;
			if (simple < 8)
				return rank + simple;
			rank += simple - 1;
			if (current.GenericArguments[simple - 1] is not GenericInstSig next)
				return -1;
			current = next;
		}
		return -1;
	}

	static int GetValueTupleSimpleRank(GenericInstSig generic) {
		if (generic.GenericType is not ValueTypeSig { TypeDefOrRef: { } type } || type.Namespace != "System")
			return -1;
		var rank = type.Name.String switch {
			"ValueTuple`1" => 1,
			"ValueTuple`2" => 2,
			"ValueTuple`3" => 3,
			"ValueTuple`4" => 4,
			"ValueTuple`5" => 5,
			"ValueTuple`6" => 6,
			"ValueTuple`7" => 7,
			"ValueTuple`8" => 8,
			_ => -1,
		};
		return rank > 0 && generic.GenericArguments.Count == rank ? rank : -1;
	}

	static bool HasDynamicAttribute(IHasCustomAttribute? provider, int typeIndex) =>
		HasFlagAttribute(provider, "System.Runtime.CompilerServices.DynamicAttribute", typeIndex);

	static bool HasNativeIntegerAttribute(IHasCustomAttribute? provider, int typeIndex) =>
		HasFlagAttribute(provider, "System.Runtime.CompilerServices.NativeIntegerAttribute", typeIndex);

	/// <summary>dnSpy's reading of [Dynamic] and [NativeInteger]: no argument means every position, a bool list says which.</summary>
	static bool HasFlagAttribute(IHasCustomAttribute? provider, string attributeName, int typeIndex) {
		if (provider is null)
			return false;
		foreach (var attribute in provider.CustomAttributes) {
			if (attribute.AttributeType?.FullName != attributeName)
				continue;
			if (attribute.ConstructorArguments.Count == 0)
				return true;
			if (attribute.ConstructorArguments.Count == 1 && attribute.ConstructorArguments[0].Value is IList<CAArgument> values) {
				if (typeIndex >= values.Count)
					return true;
				if (values[typeIndex].Value is bool flag)
					return flag;
			}
		}
		return false;
	}

	static string? GetTupleElementNameAtIndex(IHasCustomAttribute? provider, int index) {
		if (provider is null)
			return null;
		foreach (var attribute in provider.CustomAttributes) {
			if (attribute.AttributeType?.FullName != "System.Runtime.CompilerServices.TupleElementNamesAttribute" || attribute.ConstructorArguments.Count != 1)
				continue;
			if (attribute.ConstructorArguments[0].Value is not IList<CAArgument> names || index >= names.Count)
				continue;
			return names[index].Value switch {
				UTF8String utf8 => utf8.String,
				string text => text,
				_ => null,
			};
		}
		return null;
	}
}
