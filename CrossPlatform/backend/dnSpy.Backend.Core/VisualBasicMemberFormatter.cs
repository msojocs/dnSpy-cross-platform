using System.Globalization;
using System.Text;
using dnlib.DotNet;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core;

/// <summary>
/// A member written the way dnSpy's Visual Basic formatter writes one — <c>VisualBasicFormatter</c> in
/// dnSpy.Decompiler, which the search window goes through with Visual Basic selected: <c>Write</c> for a result's
/// name (<c>Function Describe(Integer, [String], ParamArray Object()) As String</c>) and <c>WriteToolTip</c> for its
/// tooltip (<c>(constant) Library.Answer As Integer = &amp;H00001092</c>). Ported against dnlib for definitions, and
/// written in the color classes dnSpy's syntax highlighting gives each stretch. A definition's signature never
/// names a generic argument, so the generic-argument substitution of a reference is left out, as are the
/// formatter's tokens and array sizes, whose flags nothing here switches on.
/// </summary>
sealed class VisualBasicMemberFormatter {
	// TypeFormatterUtils.MAX_RECURSION and MAX_OUTPUT_LEN
	const int MaxRecursion = 200;
	const int MaxOutputLength = 1024 * 4;

	// The English values of dnSpy.Decompiler's resources the formatter writes.
	const string DeprecatedMember = "Deprecated";
	const string AwaitableMethod = "Awaitable";
	const string ExtensionMethod = "Extension";
	const string ConstantDescription = "constant";
	const string FieldDescription = "field";
	const string OneMethodOverload = "1 overload";
	const string MethodOverloads = "{0} overloads";

	static readonly HashSet<string> Keywords = new(StringComparer.OrdinalIgnoreCase) {
		"#Const", "#Else", "#ElseIf", "#End", "#If", "AddHandler", "AddressOf",
		"Alias", "And", "AndAlso", "As", "Boolean", "ByRef", "Byte", "ByVal",
		"Call", "Case", "Catch", "CBool", "CByte", "CChar", "CDate", "CDbl",
		"CDec", "Char", "CInt", "Class", "CLng", "CObj", "Const", "Continue",
		"CSByte", "CShort", "CSng", "CStr", "CType", "CUInt", "CULng", "CUShort",
		"Date", "Decimal", "Declare", "Default", "Delegate", "Dim", "DirectCast",
		"Do", "Double", "Each", "Else", "ElseIf", "End", "EndIf", "Enum", "Erase",
		"Error", "Event", "Exit", "False", "Finally", "For", "Friend", "Function",
		"Get", "GetType", "GetXMLNamespace", "Global", "GoSub", "GoTo", "Handles",
		"If", "Implements", "Imports", "In", "Inherits", "Integer", "Interface",
		"Is", "IsNot", "Let", "Lib", "Like", "Long", "Loop", "Me", "Mod", "Module",
		"MustInherit", "MustOverride", "MyBase", "MyClass", "Namespace", "Narrowing",
		"New", "Next", "Not", "Nothing", "NotInheritable", "NotOverridable", "Object",
		"Of", "On", "Operator", "Option", "Optional", "Or", "OrElse", "Out",
		"Overloads", "Overridable", "Overrides", "ParamArray", "Partial", "Private",
		"Property", "Protected", "Public", "RaiseEvent", "ReadOnly", "ReDim", "REM",
		"RemoveHandler", "Resume", "Return", "SByte", "Select", "Set", "Shadows",
		"Shared", "Short", "Single", "Static", "Step", "Stop", "String", "Structure",
		"Sub", "SyncLock", "Then", "Throw", "To", "True", "Try", "TryCast", "TypeOf",
		"UInteger", "ULong", "UShort", "Using", "Variant", "Wend", "When", "While",
		"Widening", "With", "WithEvents", "WriteOnly", "Xor",
	};

	// Every part but the last is written before the declaring type, the last one in the name's place.
	static readonly Dictionary<string, string[]> OperatorNames = new(StringComparer.Ordinal) {
		["op_UnaryPlus"] = ["Operator", "+"],
		["op_UnaryNegation"] = ["Operator", "-"],
		["op_False"] = ["Operator", "IsFalse"],
		["op_True"] = ["Operator", "IsTrue"],
		["op_OnesComplement"] = ["Operator", "Not"],
		["op_Addition"] = ["Operator", "+"],
		["op_Subtraction"] = ["Operator", "-"],
		["op_Multiply"] = ["Operator", "*"],
		["op_Division"] = ["Operator", "/"],
		["op_IntegerDivision"] = ["Operator", "\\"],
		["op_Concatenate"] = ["Operator", "&"],
		["op_Exponent"] = ["Operator", "^"],
		["op_RightShift"] = ["Operator", ">>"],
		["op_LeftShift"] = ["Operator", "<<"],
		["op_Equality"] = ["Operator", "="],
		["op_Inequality"] = ["Operator", "<>"],
		["op_GreaterThan"] = ["Operator", ">"],
		["op_GreaterThanOrEqual"] = ["Operator", ">="],
		["op_LessThan"] = ["Operator", "<"],
		["op_LessThanOrEqual"] = ["Operator", "<="],
		["op_BitwiseAnd"] = ["Operator", "And"],
		["op_Like"] = ["Operator", "Like"],
		["op_Modulus"] = ["Operator", "Mod"],
		["op_BitwiseOr"] = ["Operator", "Or"],
		["op_ExclusiveOr"] = ["Operator", "Xor"],
		["op_Implicit"] = ["Widening", "Operator", "CType"],
		["op_Explicit"] = ["Narrowing", "Operator", "CType"],
	};

	enum AccessorKind {
		None,
		Getter,
		Setter,
		Adder,
		Remover,
	}

	readonly TextPartsBuilder output;
	readonly Func<ITypeDefOrRef, string> typeColor;
	// WriteType switches the namespace and keyword flags for the type it writes, so they are not readonly.
	CSharpMemberFormatter.Options options;
	int recursion;
	int lineLength;
	bool outputLengthExceeded;

	VisualBasicMemberFormatter(TextPartsBuilder output, CSharpMemberFormatter.Options options, Func<ITypeDefOrRef, string>? typeColor) {
		this.output = output;
		this.options = options;
		this.typeColor = typeColor ?? DefaultTypeColor;
	}

	/// <summary>
	/// Writes a definition — <c>VisualBasicFormatter.Write(IMemberRef)</c>, what the search window's name column
	/// shows. <paramref name="typeColor"/> picks a type name's color class; without one a type is colored after its
	/// definition when that is in the same module, and as a plain type otherwise. A type that is a VB module is
	/// colored as one whenever its definition is at hand, whatever <paramref name="typeColor"/> says.
	/// </summary>
	public static void Write(TextPartsBuilder output, IMemberDef member, CSharpMemberFormatter.Options options, Func<ITypeDefOrRef, string>? typeColor = null) =>
		new VisualBasicMemberFormatter(output, options, typeColor).WriteMember(member);

	/// <summary>
	/// Writes a definition's tooltip — <c>VisualBasicFormatter.WriteToolTip(IMemberRef)</c>: the member with the
	/// "(Deprecated)", "&lt;Extension&gt;" and "(+ N overloads)" notes around it, a field with its "(field)" or
	/// "(constant)", a type with the keyword that declares it. These notes resolve what they look at (an overload in
	/// a base type, the type an awaitable method returns) through dnlib, as dnSpy does.
	/// </summary>
	public static void WriteToolTip(TextPartsBuilder output, IMemberDef member, CSharpMemberFormatter.Options options, Func<ITypeDefOrRef, string>? typeColor = null) =>
		new VisualBasicMemberFormatter(output, options, typeColor).WriteMemberToolTip(member);

	/// <summary>
	/// Writes a type reference the way <c>VisualBasicFormatter.Write(IMemberRef)</c> does: by name, after its
	/// enclosing types, and an instantiated generic with its arguments.
	/// </summary>
	public static void WriteType(TextPartsBuilder output, ITypeDefOrRef type, CSharpMemberFormatter.Options options, Func<ITypeDefOrRef, string>? typeColor = null) =>
		new VisualBasicMemberFormatter(output, options, typeColor).Write(type, (options & CSharpMemberFormatter.Options.ModuleNames) != 0);

	static string DefaultTypeColor(ITypeDefOrRef type) =>
		MetadataTextColors.Of(type, reference => reference as TypeDef ?? (reference is TypeRef typeRef ? typeRef.Module?.Find(typeRef) : null));

	bool Has(CSharpMemberFormatter.Options option) => (options & option) != 0;

	void WriteMember(IMemberDef member) {
		switch (member) {
			case MethodDef { MethodSig: not null } method:
				Write(method);
				break;
			case FieldDef { FieldSig: not null } field:
				Write(field, isToolTip: false);
				break;
			case PropertyDef { PropertySig: not null } property:
				Write(property, AccessorKind.None);
				break;
			case EventDef { EventType: not null } @event:
				Write(@event, AccessorKind.None);
				break;
			case TypeDef type:
				Write(type, Has(CSharpMemberFormatter.Options.ModuleNames));
				break;
			case GenericParam genericParam:
				WriteIdentifier(genericParam.Name, genericParam.DeclaringMethod is not null ? TextColors.MethodGenericParameter : TextColors.TypeGenericParameter);
				break;
			// dnSpy writes nothing for anything else.
		}
	}

	void WriteMemberToolTip(IMemberDef member) {
		switch (member) {
			case MethodDef { MethodSig: not null } method:
				WriteToolTip(method);
				break;
			case FieldDef { FieldSig: not null } field:
				WriteDeprecated(IsDeprecated(field.CustomAttributes));
				Write(field, isToolTip: true);
				break;
			case PropertyDef { PropertySig: not null } property:
				WriteDeprecated(IsDeprecated(property.CustomAttributes));
				Write(property, AccessorKind.None);
				break;
			case EventDef { EventType: not null } @event:
				WriteDeprecated(IsDeprecated(@event.CustomAttributes));
				Write(@event, AccessorKind.None);
				break;
			case TypeDef type:
				WriteToolTip(type);
				break;
		}
	}

	// ---------------------------------------------------------------- notes

	void WriteDeprecated(bool isDeprecated) {
		if (!isDeprecated)
			return;
		OutputWrite("(", TextColors.Punctuation);
		OutputWrite(DeprecatedMember, TextColors.Text);
		OutputWrite(")", TextColors.Punctuation);
		WriteSpace();
	}

	void WriteSpecialFlags(bool isAwaitable, bool isExtension) {
		if (!isAwaitable && !isExtension)
			return;
		OutputWrite("<", TextColors.Punctuation);
		if (isAwaitable)
			OutputWrite(AwaitableMethod, TextColors.Text);
		if (isExtension) {
			if (isAwaitable)
				WriteCommaSpace();
			OutputWrite(ExtensionMethod, TextColors.Text);
		}
		OutputWrite(">", TextColors.Punctuation);
		WriteSpace();
	}

	void WriteToolTip(MethodDef method) {
		WriteDeprecated(IsDeprecated(method.CustomAttributes));
		WriteSpecialFlags(IsAwaitableType(method.MethodSig.GetRetType()), IsExtension(method.CustomAttributes));
		Write(method);
		if (method.DeclaringType is { } declaringType && GetNumberOfOverloadsString(declaringType, method) is { } overloads)
			OutputWrite(overloads, TextColors.Text);
	}

	void WriteToolTip(TypeDef type) {
		WriteDeprecated(IsDeprecated(type));
		WriteSpecialFlags(IsAwaitableType(type), isExtension: false);

		if (IsDelegate(type) && type.FindMethod("Invoke") is { MethodSig: not null } invoke) {
			OutputWrite("Delegate", TextColors.Keyword);
			WriteSpace();
			WriteModuleName(invoke.Module, always: true);
			OutputWrite(IsSub(invoke, retTypeIsLastArgType: false) ? "Sub" : "Function", TextColors.Keyword);
			WriteSpace();
			// Always the namespace here, because that's what VS does.
			WriteType(type, useNamespaces: true, Has(CSharpMemberFormatter.Options.IntrinsicTypeKeywords));
			WriteGenericArguments(invoke);
			WriteMethodParameterList(invoke, retTypeIsLastArgType: false, includeReturnTypeInArgsList: false, "(", ")");
			WriteReturnType(invoke, retTypeIsLastArgType: false);
			return;
		}
		WriteModuleName(type.Module);

		string keyword;
		if (IsModule(type))
			keyword = "Module";
		else if (type.IsEnum)
			keyword = "Enum";
		else if (type.IsValueType)
			keyword = "Structure";
		else if (type.IsInterface)
			keyword = "Interface";
		else
			keyword = "Class";
		OutputWrite(keyword, TextColors.Keyword);
		WriteSpace();
		// Always the namespace here, because that's what VS does.
		WriteType(type, useNamespaces: true, useTypeKeywords: false);
	}

	// ---------------------------------------------------------------- members

	void Write(MethodDef method) {
		// An accessor is written as the member it belongs to, with the accessor's keyword.
		foreach (var property in method.DeclaringType?.Properties ?? []) {
			if (method == property.GetMethod) {
				Write(property, AccessorKind.Getter);
				return;
			}
			if (method == property.SetMethod) {
				Write(property, AccessorKind.Setter);
				return;
			}
		}
		foreach (var @event in method.DeclaringType?.Events ?? []) {
			if (method == @event.AddMethod) {
				Write(@event, AccessorKind.Adder);
				return;
			}
			if (method == @event.RemoveMethod) {
				Write(@event, AccessorKind.Remover);
				return;
			}
		}

		WriteModuleName(method.Module, always: true);
		var isConstructor = method.IsConstructor && method.DeclaringType is not null;
		var operatorInfo = isConstructor ? null
			: method.Overrides.Count > 0 ? TryGetOperatorInfo(method.Overrides[0].MethodDeclaration.Name)
			: TryGetOperatorInfo(method.Name);
		if (operatorInfo is not null) {
			for (var index = 0; index < operatorInfo.Length - 1; index++) {
				WriteOperatorInfoString(operatorInfo[index]);
				WriteSpace();
			}
		}
		else {
			OutputWrite(IsSub(method, retTypeIsLastArgType: false) ? "Sub" : "Function", TextColors.Keyword);
			WriteSpace();
		}

		if (Has(CSharpMemberFormatter.Options.DeclaringTypes)) {
			Write(method.DeclaringType);
			WritePeriod();
		}
		if (isConstructor)
			OutputWrite("New", TextColors.Keyword);
		else if (operatorInfo is not null)
			WriteOperatorInfoString(operatorInfo[^1]);
		else
			WriteIdentifier(method.Overrides.Count > 0 ? method.Overrides[0].MethodDeclaration.Name : method.Name, MetadataTextColors.Of(method));

		WriteGenericArguments(method);
		WriteMethodParameterList(method, retTypeIsLastArgType: false, includeReturnTypeInArgsList: false, "(", ")");
		WriteReturnType(method, retTypeIsLastArgType: false);
	}

	static string[]? TryGetOperatorInfo(string? name) => name is not null && OperatorNames.TryGetValue(name, out var info) ? info : null;

	// A word is a keyword ("Operator", "Widening", "CType", "Mod"), anything else an operator.
	void WriteOperatorInfoString(string part) => OutputWrite(part, char.IsAsciiLetterUpper(part[0]) ? TextColors.Keyword : TextColors.Operator);

	void WriteAccessor(AccessorKind kind) {
		OutputWrite(kind switch {
			AccessorKind.Getter => "Get",
			AccessorKind.Setter => "Set",
			AccessorKind.Adder => "Add",
			AccessorKind.Remover => "Remove",
			_ => throw new InvalidOperationException(),
		}, TextColors.Keyword);
		WriteSpace();
	}

	void Write(FieldDef field, bool isToolTip) {
		var isEnumOwner = field.DeclaringType?.IsEnum == true;
		object? constant = null;
		var isConstant = (field.IsLiteral || (field.IsStatic && field.IsInitOnly)) && HasConstant(field, out var constantAttribute) && TryGetConstant(field, constantAttribute, out constant);
		// An enum's constants go without the "(constant)" every one of them would have.
		if ((!isEnumOwner || !field.IsLiteral) && isToolTip) {
			OutputWrite("(", TextColors.Punctuation);
			OutputWrite(isConstant ? ConstantDescription : FieldDescription, TextColors.Text);
			OutputWrite(")", TextColors.Punctuation);
			WriteSpace();
		}
		WriteModuleName(field.Module);
		if (Has(CSharpMemberFormatter.Options.DeclaringTypes)) {
			Write(field.DeclaringType);
			WritePeriod();
		}
		WriteIdentifier(field.Name, MetadataTextColors.Of(field));
		// The type is written whatever FieldTypes says — dnSpy's VB formatter never looks at it — but an enum's
		// fields go without one.
		if (!isEnumOwner) {
			WriteSpace();
			OutputWrite("As", TextColors.Keyword);
			WriteSpace();
			Write(field.FieldSig.Type, field);
		}
		if (Has(CSharpMemberFormatter.Options.FieldLiteralValues) && isConstant) {
			WriteSpace();
			OutputWrite("=", TextColors.Operator);
			WriteSpace();
			WriteConstant(constant);
		}
	}

	void Write(PropertyDef property, AccessorKind accessorKind) {
		var getter = property.GetMethods.FirstOrDefault();
		var setter = property.SetMethods.FirstOrDefault();
		var accessor = getter ?? setter;
		if (accessor is null) {
			WriteError();
			return;
		}
		// dnSpy writes ReadOnly for a property without a setter, and nothing for one without a getter.
		if (setter is null) {
			OutputWrite("ReadOnly", TextColors.Keyword);
			WriteSpace();
		}
		OutputWrite("Property", TextColors.Keyword);
		WriteSpace();

		var signatureMethod = accessor;
		if (accessorKind != AccessorKind.None) {
			signatureMethod = accessorKind == AccessorKind.Getter ? getter ?? accessor : setter ?? accessor;
			WriteAccessor(accessorKind);
		}
		// A setter's type is its last parameter, which its own list writes too.
		var retTypeIsLastArgType = signatureMethod == setter;
		var includeReturnTypeInArgsList = accessorKind == AccessorKind.Setter;

		WriteModuleName(signatureMethod.Module, always: true);
		if (Has(CSharpMemberFormatter.Options.DeclaringTypes)) {
			Write(property.DeclaringType);
			WritePeriod();
		}
		var overridden = accessor.Overrides.Count == 0 ? null : accessor.Overrides[0].MethodDeclaration;
		if (overridden is not null && GetPropertyName(overridden) is { } overriddenName)
			WriteIdentifier(overriddenName, MetadataTextColors.Of(property));
		else
			WriteIdentifier(property.Name, MetadataTextColors.Of(property));
		WriteGenericArguments(signatureMethod);
		// An indexer has its parameters in parentheses, an accessor always.
		if (accessorKind != AccessorKind.None || property.PropertySig.GetParamCount() != 0)
			WriteMethodParameterList(signatureMethod, retTypeIsLastArgType, includeReturnTypeInArgsList, "(", ")");
		WriteReturnType(signatureMethod, retTypeIsLastArgType);
	}

	void Write(EventDef @event, AccessorKind accessorKind) {
		OutputWrite("Event", TextColors.Keyword);
		WriteSpace();
		if (accessorKind != AccessorKind.None)
			WriteAccessor(accessorKind);
		WriteModuleName(@event.Module);
		if (Has(CSharpMemberFormatter.Options.DeclaringTypes)) {
			Write(@event.DeclaringType);
			WritePeriod();
		}
		WriteIdentifier(@event.Name, MetadataTextColors.Of(@event));
		WriteSpace();
		OutputWrite("As", TextColors.Keyword);
		WriteSpace();
		Write(@event.EventType, attributeProvider: @event);
	}

	void WriteReturnType(MethodDef method, bool retTypeIsLastArgType) {
		if (!Has(CSharpMemberFormatter.Options.ReturnTypes))
			return;
		if (IsSub(method, retTypeIsLastArgType))
			return;
		if (method.IsConstructor)
			return;
		var (returnType, returnParameter) = GetReturnTypeInfo(method, retTypeIsLastArgType);
		WriteSpace();
		OutputWrite("As", TextColors.Keyword);
		WriteSpace();
		Write(returnType, returnParameter);
	}

	static bool IsSub(MethodDef method, bool retTypeIsLastArgType) =>
		GetReturnTypeInfo(method, retTypeIsLastArgType).ReturnType.RemovePinnedAndModifiers().GetElementType() == ElementType.Void;

	static (TypeSig? ReturnType, ParamDef? ReturnParameter) GetReturnTypeInfo(MethodDef method, bool retTypeIsLastArgType) {
		var signature = method.MethodSig ?? new MethodSig(CallingConvention.Default);
		if (retTypeIsLastArgType)
			return (signature.Params.LastOrDefault(), method.Parameters.LastOrDefault()?.ParamDef);
		return (signature.RetType, method.Parameters.ReturnParameter.ParamDef);
	}

	void WriteGenericArguments(MethodDef method) {
		if (method.MethodSig?.GenParamCount > 0)
			WriteGenerics(method.GenericParameters, TextColors.MethodGenericParameter);
	}

	void WriteMethodParameterList(MethodDef method, bool retTypeIsLastArgType, bool includeReturnTypeInArgsList, string open, string close) {
		var showTypes = Has(CSharpMemberFormatter.Options.ParameterTypes);
		var showNames = Has(CSharpMemberFormatter.Options.ParameterNames);
		if (!showTypes && !showNames)
			return;
		var signature = method.MethodSig ?? new MethodSig(CallingConvention.Default);
		OutputWrite(open, TextColors.Punctuation);
		var baseIndex = signature.HasThis ? 1 : 0;
		var count = signature.Params.Count;
		if (retTypeIsLastArgType && !includeReturnTypeInArgsList)
			count--;
		for (var index = 0; index < count; index++) {
			if (index > 0)
				WriteCommaSpace();
			var parameter = baseIndex + index < method.Parameters.Count ? method.Parameters[baseIndex + index].ParamDef : null;

			// An optional parameter is written in brackets, its value only with parameter literal values on.
			var isDefault = HasConstant(parameter, out var constantAttribute);
			if (isDefault)
				OutputWrite("[", TextColors.Punctuation);

			var needSpace = false;
			var parameterType = signature.Params[index];
			if (parameterType.GetElementType() == ElementType.ByRef) {
				parameterType = parameterType.Next;
				OutputWrite("ByRef", TextColors.Keyword);
				WriteSpace();
			}
			if (parameter is not null && parameter.CustomAttributes.IsDefined("System.ParamArrayAttribute")) {
				OutputWrite("ParamArray", TextColors.Keyword);
				needSpace = true;
			}

			if (showNames) {
				if (needSpace)
					WriteSpace();
				needSpace = true;
				if (parameter is not null)
					WriteIdentifier(parameter.Name, TextColors.Parameter);
				else
					WriteIdentifier($"A_{(baseIndex + index).ToString(CultureInfo.InvariantCulture)}", TextColors.Parameter);
			}
			if (showTypes) {
				if (showNames) {
					WriteSpace();
					OutputWrite("As", TextColors.Keyword);
				}
				if (needSpace)
					WriteSpace();
				needSpace = true;
				Write(parameterType, parameter);
			}
			if (Has(CSharpMemberFormatter.Options.ParameterLiteralValues) && isDefault && TryGetConstant(parameter, constantAttribute, out var constant)) {
				// dnSpy writes two spaces before the "=": the one owed to what came before, and its own.
				if (needSpace)
					WriteSpace();
				WriteSpace();
				OutputWrite("=", TextColors.Operator);
				WriteSpace();
				WriteConstant(constant);
			}

			if (isDefault)
				OutputWrite("]", TextColors.Punctuation);
		}
		if (signature.IsVarArg) {
			if (count > 0)
				WriteCommaSpace();
			OutputWrite("__ArgList", TextColors.Keyword);
		}
		OutputWrite(close, TextColors.Punctuation);
	}

	void WriteGenerics(IList<GenericParam> parameters, string color) {
		if (parameters.Count == 0)
			return;
		OutputWrite("(", TextColors.Punctuation);
		OutputWrite("Of", TextColors.Keyword);
		WriteSpace();
		for (var index = 0; index < parameters.Count; index++) {
			if (index > 0)
				WriteCommaSpace();
			var parameter = parameters[index];
			if (parameter.IsCovariant) {
				OutputWrite("Out", TextColors.Keyword);
				WriteSpace();
			}
			else if (parameter.IsContravariant) {
				OutputWrite("In", TextColors.Keyword);
				WriteSpace();
			}
			WriteIdentifier(parameter.Name, color);
		}
		OutputWrite(")", TextColors.Punctuation);
	}

	void WriteModuleName(ModuleDef? module, bool always = false) {
		if (!Has(CSharpMemberFormatter.Options.ModuleNames))
			return;
		// A method's module is written even when there is none, as an error; anything else's is skipped.
		if (module is null) {
			if (always) {
				OutputWrite("null module", TextColors.Error);
				OutputWrite("!", TextColors.Operator);
			}
			return;
		}
		OutputWrite(FilterName(GetFileName(module.Location ?? string.Empty)), TextColors.AssemblyModule);
		OutputWrite("!", TextColors.Operator);
	}

	// ---------------------------------------------------------------- types

	/// <summary>
	/// A type with its generic parameters — a type tooltip's name. <c>Write(ITypeDefOrRef)</c> stops at the name,
	/// so a generic one is written here a part at a time, its namespace and enclosing types in front.
	/// </summary>
	void WriteType(TypeDef type, bool useNamespaces, bool useTypeKeywords) {
		var declaringType = type.DeclaringType;
		if (type.GenericParameters.Count == 0 || (declaringType is not null && declaringType.GenericParameters.Count >= type.GenericParameters.Count)) {
			var oldOptions = options;
			options &= ~(CSharpMemberFormatter.Options.Namespaces | CSharpMemberFormatter.Options.IntrinsicTypeKeywords);
			if (useNamespaces)
				options |= CSharpMemberFormatter.Options.Namespaces;
			if (useTypeKeywords)
				options |= CSharpMemberFormatter.Options.IntrinsicTypeKeywords;
			Write(type);
			options = oldOptions;
			return;
		}

		var genericParameterCount = type.GenericParameters.Count;
		if (declaringType is not null) {
			var oldOptions = options;
			options &= ~(CSharpMemberFormatter.Options.Namespaces | CSharpMemberFormatter.Options.IntrinsicTypeKeywords);
			if (useNamespaces)
				options |= CSharpMemberFormatter.Options.Namespaces;
			Write(declaringType);
			options = oldOptions;
			WritePeriod();
			// The enclosing types' parameters are theirs; only the rest are this type's own.
			genericParameterCount = Math.Max(0, genericParameterCount - declaringType.GenericParameters.Count);
		}
		else if (useNamespaces && !UTF8String.IsNullOrEmpty(type.Namespace)) {
			foreach (var part in type.Namespace.String.Split('.')) {
				WriteIdentifier(part, TextColors.Namespace);
				WritePeriod();
			}
		}
		WriteIdentifier(RemoveGenericTick(type.Name), TypeColor(type));
		WriteGenerics(type.GenericParameters.Skip(type.GenericParameters.Count - genericParameterCount).ToArray(), TextColors.TypeGenericParameter);
	}

	/// <summary>A type by name — its enclosing types, its namespace when they are shown, never its generic parameters.</summary>
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
				Write(typeSpec.TypeSig, attributeProvider);
				return;
			}
			if (type.DeclaringType is not null) {
				Write(type.DeclaringType);
				WritePeriod();
			}
			if (GetTypeKeyword(type) is { } keyword) {
				OutputWrite(keyword, TextColors.Keyword);
				return;
			}
			if (showModuleNames)
				WriteModuleName(type.ResolveTypeDef()?.Module);
			WriteNamespace(type.Namespace);
			WriteIdentifier(RemoveGenericTick(type.Name), TypeColor(type));
		}
		finally {
			recursion--;
		}
	}

	/// <summary>dnSpy's VisualBasicMetadataTextColorProvider: a VB module is colored as one, any other type as usual.</summary>
	string TypeColor(ITypeDefOrRef type) {
		var definition = type as TypeDef ?? (type is TypeRef typeRef ? typeRef.Module?.Find(typeRef) : null);
		return IsModule(definition) ? TextColors.Module : typeColor(type);
	}

	void WriteNamespace(string? @namespace) {
		if (!Has(CSharpMemberFormatter.Options.Namespaces) || string.IsNullOrEmpty(@namespace))
			return;
		foreach (var part in @namespace.Split('.')) {
			OutputWrite(part, TextColors.Namespace);
			WritePeriod();
		}
	}

	string? GetTypeKeyword(ITypeDefOrRef type) {
		if (!Has(CSharpMemberFormatter.Options.IntrinsicTypeKeywords))
			return null;
		if (type.DeclaringType is not null || type.Namespace != "System" || !type.DefinitionAssembly.IsCorLib())
			return null;
		return type.TypeName switch {
			"Boolean" => "Boolean",
			"Byte" => "Byte",
			"Char" => "Char",
			"DateTime" => "Date",
			"Decimal" => "Decimal",
			"Double" => "Double",
			"Int16" => "Short",
			"Int32" => "Integer",
			"Int64" => "Long",
			"Object" => "Object",
			"SByte" => "SByte",
			"Single" => "Single",
			"String" => "String",
			"UInt16" => "UShort",
			"UInt32" => "UInteger",
			"UInt64" => "ULong",
			_ => null,
		};
	}

	void Write(TypeSig? type, IHasCustomAttribute? attributeProvider) {
		var tupleNameIndex = 0;
		Write(type, ref tupleNameIndex, attributeProvider);
	}

	void Write(TypeSig? type, ref int tupleNameIndex, IHasCustomAttribute? attributeProvider) {
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
				Write(arrays[^1].Next, ref tupleNameIndex, attributeProvider);
				foreach (var array in arrays) {
					OutputWrite("(", TextColors.Punctuation);
					if (array.ElementType == ElementType.Array) {
						// Without array sizes shown a one-dimensional array is "(*)" and a wider one "(,)".
						var rank = array.Rank;
						if (rank == 0)
							OutputWrite("<RANK0>", TextColors.Error);
						else {
							if (rank == 1)
								OutputWrite("*", TextColors.Operator);
							for (uint dimension = 1; dimension < rank; dimension++)
								OutputWrite(",", TextColors.Punctuation);
						}
					}
					OutputWrite(")", TextColors.Punctuation);
				}
				return;
			}
			if (type is null)
				return;
			switch (type.ElementType) {
				case ElementType.Void: WriteSystemType("Void", true); break;
				case ElementType.Boolean: WriteSystemTypeKeyword("Boolean", "Boolean", true); break;
				case ElementType.Char: WriteSystemTypeKeyword("Char", "Char", true); break;
				case ElementType.I1: WriteSystemTypeKeyword("SByte", "SByte", true); break;
				case ElementType.U1: WriteSystemTypeKeyword("Byte", "Byte", true); break;
				case ElementType.I2: WriteSystemTypeKeyword("Int16", "Short", true); break;
				case ElementType.U2: WriteSystemTypeKeyword("UInt16", "UShort", true); break;
				case ElementType.I4: WriteSystemTypeKeyword("Int32", "Integer", true); break;
				case ElementType.U4: WriteSystemTypeKeyword("UInt32", "UInteger", true); break;
				case ElementType.I8: WriteSystemTypeKeyword("Int64", "Long", true); break;
				case ElementType.U8: WriteSystemTypeKeyword("UInt64", "ULong", true); break;
				case ElementType.R4: WriteSystemTypeKeyword("Single", "Single", true); break;
				case ElementType.R8: WriteSystemTypeKeyword("Double", "Double", true); break;
				case ElementType.String: WriteSystemTypeKeyword("String", "String", false); break;
				case ElementType.Object: WriteSystemTypeKeyword("Object", "Object", false); break;
				case ElementType.TypedByRef: WriteSystemType("TypedReference", true); break;
				case ElementType.I: WriteSystemType("IntPtr", true); break;
				case ElementType.U: WriteSystemType("UIntPtr", true); break;
				case ElementType.Ptr:
					Write(type.Next, ref tupleNameIndex, attributeProvider);
					OutputWrite("*", TextColors.Operator);
					break;
				case ElementType.ByRef:
					OutputWrite("ByRef", TextColors.Keyword);
					WriteSpace();
					Write(type.Next, ref tupleNameIndex, attributeProvider);
					break;
				case ElementType.ValueType:
				case ElementType.Class:
					Write(((TypeDefOrRefSig)type).TypeDefOrRef);
					break;
				case ElementType.Var:
				case ElementType.MVar:
					// A definition's signature has no generic arguments to put in a parameter's place.
					var genericSig = (GenericSig)type;
					if (genericSig.GenericParam is { } genericParam)
						WriteIdentifier(genericParam.Name, genericParam.DeclaringMethod is not null && genericParam.DeclaringType is null ? TextColors.MethodGenericParameter : TextColors.TypeGenericParameter);
					else if (genericSig.IsMethodVar)
						OutputWrite($"!!{genericSig.Number.ToString(CultureInfo.InvariantCulture)}", TextColors.MethodGenericParameter);
					else
						OutputWrite($"!{genericSig.Number.ToString(CultureInfo.InvariantCulture)}", TextColors.TypeGenericParameter);
					break;
				case ElementType.GenericInst:
					WriteGenericInstance((GenericInstSig)type, ref tupleNameIndex, attributeProvider);
					break;
				case ElementType.FnPtr:
					var signature = ((FnPtrSig)type).MethodSig;
					Write(signature.RetType, ref tupleNameIndex, attributeProvider);
					WriteSpace();
					OutputWrite("(", TextColors.Punctuation);
					for (var index = 0; index < signature.Params.Count; index++) {
						if (index > 0)
							WriteCommaSpace();
						Write(signature.Params[index], ref tupleNameIndex, attributeProvider);
					}
					if (signature.ParamsAfterSentinel is not null) {
						if (signature.Params.Count > 0)
							WriteCommaSpace();
						OutputWrite("...", TextColors.Punctuation);
						foreach (var parameter in signature.ParamsAfterSentinel) {
							WriteCommaSpace();
							Write(parameter, ref tupleNameIndex, attributeProvider);
						}
					}
					OutputWrite(")", TextColors.Punctuation);
					break;
				case ElementType.CModReqd:
				case ElementType.CModOpt:
				case ElementType.Pinned:
					Write(type.Next, ref tupleNameIndex, attributeProvider);
					break;
			}
		}
		finally {
			recursion--;
		}
	}

	void WriteGenericInstance(GenericInstSig? generic, ref int tupleNameIndex, IHasCustomAttribute? attributeProvider) {
		if (IsSystemNullable(generic!)) {
			Write(generic!.GenericArguments[0], ref tupleNameIndex, attributeProvider);
			OutputWrite("?", TextColors.Operator);
			return;
		}
		var cardinality = GetSystemValueTupleRank(generic!);
		if (cardinality > 0) {
			var elementNameIndex = tupleNameIndex;
			tupleNameIndex += cardinality;
			// A one-element tuple is written as the generic type it is.
			if (cardinality > 1) {
				OutputWrite("(", TextColors.Punctuation);
				var needComma = false;
				for (var rest = 0; rest < 1000; rest++) {
					for (var index = 0; index < generic!.GenericArguments.Count && index < 7; index++) {
						if (needComma)
							WriteCommaSpace();
						needComma = true;
						if (GetTupleElementNameAtIndex(attributeProvider, elementNameIndex++) is { } elementName) {
							OutputWrite(elementName, TextColors.InstanceField);
							WriteSpace();
							OutputWrite("As", TextColors.Keyword);
							WriteSpace();
						}
						Write(generic.GenericArguments[index], ref tupleNameIndex, attributeProvider);
					}
					if (generic!.GenericArguments.Count != 8)
						break;
					generic = generic.GenericArguments[^1] as GenericInstSig;
					if (generic is null) {
						WriteError();
						break;
					}
					tupleNameIndex += GetSystemValueTupleRank(generic);
				}
				OutputWrite(")", TextColors.Punctuation);
				return;
			}
		}
		Write(generic!.GenericType, ref tupleNameIndex, attributeProvider);
		OutputWrite("(", TextColors.Punctuation);
		OutputWrite("Of", TextColors.Keyword);
		WriteSpace();
		for (var index = 0; index < generic.GenericArguments.Count; index++) {
			if (index > 0)
				WriteCommaSpace();
			Write(generic.GenericArguments[index], ref tupleNameIndex, attributeProvider);
		}
		OutputWrite(")", TextColors.Punctuation);
	}

	void WriteSystemTypeKeyword(string name, string keyword, bool isValueType) {
		if (Has(CSharpMemberFormatter.Options.IntrinsicTypeKeywords))
			OutputWrite(keyword, TextColors.Keyword);
		else
			WriteSystemType(name, isValueType);
	}

	void WriteSystemType(string name, bool isValueType) {
		if (Has(CSharpMemberFormatter.Options.Namespaces)) {
			OutputWrite("System", TextColors.Namespace);
			WritePeriod();
		}
		OutputWrite(name, isValueType ? TextColors.ValueType : TextColors.Type);
	}

	// ---------------------------------------------------------------- constants

	void WriteConstant(object? value) {
		switch (value) {
			case null: OutputWrite("Nothing", TextColors.Keyword); break;
			case bool boolean: OutputWrite(boolean ? "True" : "False", TextColors.Keyword); break;
			case char ch: WriteChar(ch); break;
			case sbyte number: WriteNumber(UseDecimal ? ToDecimal(number.ToString(CultureInfo.InvariantCulture)) : ToHex(number.ToString("X2", CultureInfo.InvariantCulture))); break;
			case byte number: WriteNumber(UseDecimal ? ToDecimal(number.ToString(CultureInfo.InvariantCulture)) : ToHex(number.ToString("X2", CultureInfo.InvariantCulture))); break;
			case short number: WriteNumber(UseDecimal ? ToDecimal(number.ToString(CultureInfo.InvariantCulture)) : ToHex(number.ToString("X4", CultureInfo.InvariantCulture))); break;
			case ushort number: WriteUInt16(number); break;
			case int number: WriteNumber(UseDecimal ? ToDecimal(number.ToString(CultureInfo.InvariantCulture)) : ToHex(number.ToString("X8", CultureInfo.InvariantCulture))); break;
			case uint number: WriteNumber(UseDecimal ? ToDecimal(number.ToString(CultureInfo.InvariantCulture)) : ToHex(number.ToString("X8", CultureInfo.InvariantCulture))); break;
			case long number: WriteNumber(UseDecimal ? ToDecimal(number.ToString(CultureInfo.InvariantCulture)) : ToHex(number.ToString("X16", CultureInfo.InvariantCulture))); break;
			case ulong number: WriteNumber(UseDecimal ? ToDecimal(number.ToString(CultureInfo.InvariantCulture)) : ToHex(number.ToString("X16", CultureInfo.InvariantCulture))); break;
			case float number:
				WriteNumber(float.IsNaN(number) ? "NaN" : float.IsNegativeInfinity(number) ? "-Infinity" : float.IsPositiveInfinity(number) ? "Infinity" : number.ToString(CultureInfo.InvariantCulture));
				break;
			case double number:
				WriteNumber(double.IsNaN(number) ? "NaN" : double.IsNegativeInfinity(number) ? "-Infinity" : double.IsPositiveInfinity(number) ? "Infinity" : number.ToString(CultureInfo.InvariantCulture));
				break;
			case decimal number: WriteNumber(number.ToString(CultureInfo.InvariantCulture)); break;
			case string text: WriteString(text); break;
			// A constant of any other kind is written as .NET prints it.
			default: OutputWrite(value.ToString() ?? "???", TextColors.Text); break;
		}
	}

	bool UseDecimal => Has(CSharpMemberFormatter.Options.UseDecimal);

	void WriteNumber(string number) => OutputWrite(number, TextColors.Number);

	void WriteUInt16(ushort number) =>
		WriteNumber(UseDecimal ? ToDecimal(number.ToString(CultureInfo.InvariantCulture)) : ToHex(number.ToString("X4", CultureInfo.InvariantCulture)));

	string ToDecimal(string number) => ToFormattedNumber(string.Empty, number, 3);
	string ToHex(string number) => ToFormattedNumber("&H", number, 4);

	/// <summary>TypeFormatterUtils.ToFormattedNumber: digits grouped by "_" with digit separators on, then the prefix.</summary>
	string ToFormattedNumber(string prefix, string number, int digitGroupSize) {
		if (Has(CSharpMemberFormatter.Options.DigitSeparators) && number.Length > digitGroupSize) {
			var separated = new StringBuilder();
			for (var index = 0; index < number.Length; index++) {
				var remaining = number.Length - index;
				if (index != 0 && remaining % digitGroupSize == 0 && number[index - 1] != '-')
					separated.Append('_');
				separated.Append(number[index]);
			}
			number = separated.ToString();
		}
		return prefix + number;
	}

	void WriteChar(char value) {
		switch (value) {
			case '\r': OutputWrite("vbCr", TextColors.LiteralField); break;
			case '\n': OutputWrite("vbLf", TextColors.LiteralField); break;
			case '\b': OutputWrite("vbBack", TextColors.LiteralField); break;
			case '\f': OutputWrite("vbFormFeed", TextColors.LiteralField); break;
			case '\t': OutputWrite("vbTab", TextColors.LiteralField); break;
			case '\v': OutputWrite("vbVerticalTab", TextColors.LiteralField); break;
			case '\0': OutputWrite("vbNullChar", TextColors.LiteralField); break;
			case '"': OutputWrite("\"\"\"\"c", TextColors.Char); break;
			default:
				if (char.IsControl(value))
					WriteCharW(value);
				else
					OutputWrite($"\"{value}\"c", TextColors.Char);
				break;
		}
	}

	void WriteCharW(char value) {
		OutputWrite("ChrW", TextColors.StaticMethod);
		OutputWrite("(", TextColors.Punctuation);
		WriteUInt16(value);
		OutputWrite(")", TextColors.Punctuation);
	}

	/// <summary>
	/// A string in quotes, a quote doubled; a line break, tab or other control character between the quoted runs
	/// as its vb constant or as ChrW(...), joined by "&amp;".
	/// </summary>
	void WriteString(string value) {
		if (value.Length == 0) {
			OutputWrite("\"\"", TextColors.String);
			return;
		}
		var index = 0;
		var needSeparator = false;
		while (index < value.Length) {
			var run = GetSubString(value, ref index);
			if (run.Length != 0) {
				if (needSeparator)
					WriteStringConcatOperator();
				OutputWrite($"\"{run}\"", TextColors.String);
				needSeparator = true;
			}
			if (index >= value.Length)
				continue;
			var ch = value[index];
			switch (ch) {
				case '\r':
					if (index + 1 < value.Length && value[index + 1] == '\n') {
						WriteSpecialConstantString("vbCrLf", ref needSeparator);
						index++;
					}
					else
						WriteSpecialConstantString("vbCr", ref needSeparator);
					break;
				case '\n': WriteSpecialConstantString("vbLf", ref needSeparator); break;
				case '\b': WriteSpecialConstantString("vbBack", ref needSeparator); break;
				case '\f': WriteSpecialConstantString("vbFormFeed", ref needSeparator); break;
				case '\t': WriteSpecialConstantString("vbTab", ref needSeparator); break;
				case '\v': WriteSpecialConstantString("vbVerticalTab", ref needSeparator); break;
				case '\0': WriteSpecialConstantString("vbNullChar", ref needSeparator); break;
				default:
					if (needSeparator)
						WriteStringConcatOperator();
					WriteCharW(ch);
					break;
			}
			index++;
			needSeparator = true;
		}
	}

	void WriteStringConcatOperator() {
		WriteSpace();
		OutputWrite("&", TextColors.Operator);
		WriteSpace();
	}

	void WriteSpecialConstantString(string constant, ref bool needSeparator) {
		if (needSeparator)
			WriteStringConcatOperator();
		OutputWrite(constant, TextColors.LiteralField);
		needSeparator = true;
	}

	/// <summary>The run of characters from <paramref name="index"/> that can stand inside quotes, a quote doubled.</summary>
	static string GetSubString(string value, ref int index) {
		var run = new StringBuilder();
		while (index < value.Length) {
			var ch = value[index];
			bool isSpecial;
			switch (ch) {
				case '"':
					run.Append(ch);
					isSpecial = false;
					break;
				case '\r':
				case '\n':
				case '\b':
				case '\f':
				case '\t':
				case '\v':
				case '\0':
				// More newline characters
				case '\u0085':
				case '\u2028':
				case '\u2029':
					isSpecial = true;
					break;
				default:
					isSpecial = char.IsControl(ch);
					break;
			}
			if (isSpecial)
				break;
			run.Append(ch);
			index++;
		}
		return run.ToString();
	}

	// ---------------------------------------------------------------- pieces

	/// <summary>
	/// Everything goes out through here: like dnSpy, once the text reaches 4K characters it is cut there, "[...]"
	/// written after it, and nothing more.
	/// </summary>
	void OutputWrite(string text, string color) {
		if (outputLengthExceeded)
			return;
		if (lineLength + text.Length > MaxOutputLength) {
			text = text[..(MaxOutputLength - lineLength)] + "[...]";
			outputLengthExceeded = true;
		}
		output.Write(color, text);
		lineLength += text.Length;
	}

	void WriteIdentifier(string? identifier, string color) {
		var escaped = EscapeIdentifier(identifier);
		OutputWrite(Keywords.Contains(identifier ?? string.Empty) ? $"[{escaped}]" : escaped, color);
	}

	void WriteSpace() => OutputWrite(" ", TextColors.Text);

	void WriteCommaSpace() {
		OutputWrite(",", TextColors.Punctuation);
		WriteSpace();
	}

	void WritePeriod() => OutputWrite(".", TextColors.Operator);
	void WriteError() => OutputWrite("???", TextColors.Error);

	/// <summary>
	/// dnSpy's IdentifierEscaper.Escape: a character that can't be shown as itself becomes \uXXXX, a name longer
	/// than 512 characters is cut with "…", and an empty one is written as &lt;&lt;EMPTY_NAME&gt;&gt;.
	/// </summary>
	static string EscapeIdentifier(string? identifier) {
		const int MaxLength = 512;
		if (string.IsNullOrEmpty(identifier))
			return "<<EMPTY_NAME>>";
		var index = 0;
		if (identifier.Length <= MaxLength) {
			for (; ; index++) {
				if (index >= identifier.Length)
					return identifier;
				if (!IsValidIdentifierChar(identifier[index]))
					break;
			}
		}
		var escaped = new StringBuilder(identifier.Length + 10);
		escaped.Append(identifier, 0, index);
		for (; index < identifier.Length; index++) {
			var ch = identifier[index];
			if (IsValidIdentifierChar(ch))
				escaped.Append(ch);
			else
				escaped.Append(CultureInfo.InvariantCulture, $"\\u{(ushort)ch:X4}");
			if (escaped.Length >= MaxLength)
				break;
		}
		if (escaped.Length > MaxLength) {
			escaped.Length = MaxLength;
			escaped.Append('…');
		}
		return escaped.ToString();
	}

	static bool IsValidIdentifierChar(char ch) {
		if (ch is >= (char)0x21 and <= (char)0x7E)
			return true;
		if (ch <= 0x20)
			return false;
		return char.GetUnicodeCategory(ch) switch {
			UnicodeCategory.UppercaseLetter or UnicodeCategory.LowercaseLetter or UnicodeCategory.DecimalDigitNumber => true,
			// Not the Hangul fillers
			UnicodeCategory.OtherLetter => ch is not ((char)0x115F or (char)0x1160 or (char)0x3164 or (char)0xFFA0),
			_ => false,
		};
	}

	/// <summary>TypeFormatterUtils.FilterName: control characters escaped, and a runaway name cut short.</summary>
	static string FilterName(string? name) {
		const int MaxNameLength = 0x100;
		if (name is null)
			return "<<NULL>>";
		var filtered = new StringBuilder(Math.Min(name.Length, MaxNameLength));
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

	// ---------------------------------------------------------------- TypeFormatterUtils

	/// <summary>A VB module: a sealed top-level type marked [StandardModule].</summary>
	static bool IsModule(TypeDef? type) =>
		type is { DeclaringType: null, IsSealed: true } && type.CustomAttributes.IsDefined("Microsoft.VisualBasic.CompilerServices.StandardModuleAttribute");

	static bool IsDelegate(TypeDef type) =>
		type.BaseType is { } baseType && new SigComparer().Equals(baseType, type.Module.CorLibTypes.GetTypeRef("System", "MulticastDelegate")) && baseType.DefinitionAssembly.IsCorLib();

	/// <summary>" (+ 1 overload)" or " (+ N overloads)": the other methods of that name, the base types' too but for a constructor.</summary>
	static string? GetNumberOfOverloadsString(TypeDef type, MethodDef method) {
		string name = method.Name;
		var checkBaseTypes = name is not (".ctor" or ".cctor");
		var methods = new HashSet<MethodDef>(MethodEqualityComparer.DontCompareDeclaringTypes);
		for (TypeDef? current = type; current is not null; current = checkBaseTypes ? current.BaseType.ResolveTypeDef() : null) {
			foreach (var candidate in current.Methods) {
				if (candidate.Name == name)
					methods.Add(candidate);
			}
		}
		var overloads = methods.Count - 1;
		if (overloads == 1)
			return $" (+ {OneMethodOverload})";
		if (overloads > 1)
			return $" (+ {string.Format(CultureInfo.InvariantCulture, MethodOverloads, overloads)})";
		return null;
	}

	const string ByRefLikeMarker = "This type is for compiler use only and is not intended to be used directly from your code.";
	const string RequiredMembersMarker = "Constructors of types with required members are not supported in this version of your compiler.";

	/// <summary>
	/// A type marked [Obsolete] — but not by the [Obsolete] the compiler puts on a ref struct, as long as the type
	/// is still one.
	/// </summary>
	static bool IsDeprecated(TypeDef type) {
		var foundByRefLikeMarker = false;
		foreach (var attribute in type.CustomAttributes) {
			if (attribute.TypeFullName != "System.ObsoleteAttribute")
				continue;
			if (!IsCompilerObsolete(attribute, ByRefLikeMarker))
				return true;
			foundByRefLikeMarker = true;
		}
		return foundByRefLikeMarker && !type.CustomAttributes.IsDefined("System.Runtime.CompilerServices.IsByRefLikeAttribute");
	}

	/// <summary>
	/// A member marked [Obsolete] or [Deprecated] — but not by the [Obsolete] the compiler puts on a constructor of
	/// a type with required members, as long as [CompilerFeatureRequired("RequiredMembers")] is there with it.
	/// </summary>
	static bool IsDeprecated(CustomAttributeCollection attributes) {
		var foundRequiredMembersMarker = false;
		foreach (var attribute in attributes) {
			var fullName = attribute.TypeFullName;
			if (fullName == "Windows.Foundation.Metadata.DeprecatedAttribute")
				return true;
			if (fullName != "System.ObsoleteAttribute")
				continue;
			if (!IsCompilerObsolete(attribute, RequiredMembersMarker))
				return true;
			foundRequiredMembersMarker = true;
		}
		return foundRequiredMembersMarker && !attributes.Any(attribute =>
			attribute.TypeFullName == "System.Runtime.CompilerServices.CompilerFeatureRequiredAttribute" && attribute.ConstructorArguments.Count == 1
			&& StringValue(attribute.ConstructorArguments[0].Value) == "RequiredMembers");
	}

	// [Obsolete(marker, true)]
	static bool IsCompilerObsolete(CustomAttribute attribute, string marker) =>
		attribute.ConstructorArguments.Count == 2 && StringValue(attribute.ConstructorArguments[0].Value) == marker && attribute.ConstructorArguments[1].Value is true;

	static string? StringValue(object? value) => value switch {
		UTF8String utf8 => utf8.String,
		string text => text,
		_ => null,
	};

	static bool IsExtension(CustomAttributeCollection attributes) => attributes.IsDefined("System.Runtime.CompilerServices.ExtensionAttribute");

	static bool IsAwaitableType(TypeSig? type) => type is not null && IsAwaitableType(type.ScopeType.ResolveTypeDef());

	/// <summary>Roslyn's IsCustomTaskType: Task, Task&lt;T&gt;, or a type with an [AsyncMethodBuilder].</summary>
	static bool IsAwaitableType(TypeDef? type) {
		if (type is null || type.GenericParameters.Count > 1)
			return false;
		if (type.Namespace == "System.Threading.Tasks" && (type.Name == "Task" || type.Name == "Task`1"))
			return true;
		foreach (var attribute in type.CustomAttributes) {
			if (attribute.TypeFullName != "System.Runtime.CompilerServices.AsyncMethodBuilderAttribute" || attribute.ConstructorArguments.Count != 1)
				continue;
			if ((attribute.ConstructorArguments[0].Type as ClassSig)?.TypeDefOrRef.FullName != "System.Type")
				continue;
			return true;
		}
		return false;
	}

	/// <summary>A constant, or a [DecimalConstant] or other [CustomConstant] attribute standing for one.</summary>
	static bool HasConstant(IHasConstant? owner, out CustomAttribute? constantAttribute) {
		constantAttribute = null;
		if (owner is null)
			return false;
		if (owner.Constant is not null)
			return true;
		foreach (var attribute in owner.CustomAttributes) {
			for (var type = attribute.AttributeType; type is not null; type = type.GetBaseType()) {
				if (type.FullName is "System.Runtime.CompilerServices.CustomConstantAttribute" or "System.Runtime.CompilerServices.DecimalConstantAttribute") {
					constantAttribute = attribute;
					return true;
				}
			}
		}
		return false;
	}

	/// <summary>The value: the constant's, or a [DecimalConstant]'s. Any other [CustomConstant] ([DateTimeConstant]) has none.</summary>
	static bool TryGetConstant(IHasConstant? owner, CustomAttribute? constantAttribute, out object? constant) {
		if (owner?.Constant is { } ownConstant) {
			constant = ownConstant.Value;
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

	static string? GetTupleElementNameAtIndex(IHasCustomAttribute? provider, int index) {
		if (provider is null)
			return null;
		foreach (var attribute in provider.CustomAttributes) {
			if (attribute.AttributeType?.FullName != "System.Runtime.CompilerServices.TupleElementNamesAttribute" || attribute.ConstructorArguments.Count != 1)
				continue;
			if (attribute.ConstructorArguments[0].Value is not IList<CAArgument> names || index >= names.Count)
				continue;
			return StringValue(names[index].Value);
		}
		return null;
	}
}
