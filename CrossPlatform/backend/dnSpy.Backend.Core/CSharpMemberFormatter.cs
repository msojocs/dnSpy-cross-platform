using System.Globalization;
using dnlib.DotNet;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core;

/// <summary>
/// A member written the way dnSpy's C# formatter writes one for a tool window — <c>CSharpFormatter.Write(IMemberRef)</c>
/// in dnSpy.Decompiler, which the Bookmarks window's Location column goes through: <c>void Program.Main(string[] args)</c>,
/// <c>int Program.Code { get; set; }</c>, a getter as <c>int Program.Code.get</c>. This is the part of it the bookmark
/// window reaches — definitions, with the flags its display options switch — ported against dnlib and written in the
/// color classes dnSpy's syntax highlighting gives each stretch. What a definition never needs (generic arguments of a
/// reference, literal values, field types, the formatter's own tokens) is left out.
/// </summary>
sealed class CSharpMemberFormatter {
	/// <summary>The FormatterOptions flags a bookmark location can switch; every other one is off there.</summary>
	[Flags]
	public enum Options {
		None = 0,
		ModuleNames = 0x01,
		ParameterTypes = 0x02,
		ParameterNames = 0x04,
		DeclaringTypes = 0x08,
		ReturnTypes = 0x10,
		Namespaces = 0x40,
		IntrinsicTypeKeywords = 0x80,
	}

	// TypeFormatterUtils.MAX_RECURSION
	const int MaxRecursion = 200;

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
	readonly Options options;
	int recursion;

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

	static string DefaultTypeColor(ITypeDefOrRef type) =>
		MetadataTextColors.Of(type, reference => reference as TypeDef ?? (reference is TypeRef typeRef ? typeRef.Module?.Find(typeRef) : null));

	bool Has(Options option) => (options & option) != 0;

	void WriteMember(IMemberDef member) {
		switch (member) {
			case MethodDef method:
				Write(method);
				break;
			case FieldDef field:
				Write(field);
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
			output.Write(char.IsAsciiLetterLower(part[0]) ? TextColors.Keyword : TextColors.Operator, part);
		}
	}

	void WriteAccessor(string keyword) {
		output.Write(TextColors.Operator, ".");
		output.Write(TextColors.Keyword, keyword);
	}

	void Write(FieldDef field) {
		// Field types and literal values are off for a bookmark, so a field is its module, owner and name.
		WriteModuleName(field.Module);
		if (Has(Options.DeclaringTypes)) {
			Write(field.DeclaringType);
			WritePeriod();
		}
		WriteIdentifier(field.Name, MetadataTextColors.Of(field));
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
			output.Write(TextColors.Keyword, "this");
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
		output.Write(TextColors.Punctuation, "{");
		if (property.GetMethods.Count > 0) {
			WriteSpace();
			output.Write(TextColors.Keyword, "get");
			output.Write(TextColors.Punctuation, ";");
		}
		if (property.SetMethods.Count > 0) {
			WriteSpace();
			output.Write(TextColors.Keyword, property.SetMethods.Count == 1 && IsInitOnly(property.SetMethod) ? "init" : "set");
			output.Write(TextColors.Punctuation, ";");
		}
		WriteSpace();
		output.Write(TextColors.Punctuation, "}");
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
		output.Write(TextColors.Punctuation, "{");
		if (@event.AddMethod is not null) {
			WriteSpace();
			output.Write(TextColors.Keyword, "add");
			output.Write(TextColors.Punctuation, ";");
		}
		if (@event.RemoveMethod is not null) {
			WriteSpace();
			output.Write(TextColors.Keyword, "remove");
			output.Write(TextColors.Punctuation, ";");
		}
		WriteSpace();
		output.Write(TextColors.Punctuation, "}");
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
		output.Write(TextColors.Punctuation, open);
		var baseIndex = signature.HasThis ? 1 : 0;
		var count = signature.Params.Count;
		if (retTypeIsLastArgType)
			count--;
		for (var index = 0; index < count; index++) {
			if (index > 0)
				WriteCommaSpace();
			var parameter = baseIndex + index < method.Parameters.Count ? method.Parameters[baseIndex + index].ParamDef : null;
			// A parameter with a default value is written in brackets, the value itself only with literal values on.
			var isDefault = HasConstant(parameter);
			if (isDefault)
				output.Write(TextColors.Punctuation, "[");
			var needSpace = false;
			if (Has(Options.ParameterTypes)) {
				needSpace = true;
				if (parameter is not null && parameter.CustomAttributes.IsDefined("System.ParamArrayAttribute")) {
					output.Write(TextColors.Keyword, "params");
					WriteSpace();
				}
				Write(signature.Params[index], parameter, forceReadOnly: false, parameter);
			}
			if (Has(Options.ParameterNames)) {
				if (needSpace)
					WriteSpace();
				if (parameter is not null)
					WriteIdentifier(parameter.Name, TextColors.Parameter);
				else
					WriteIdentifier($"A_{(baseIndex + index).ToString(CultureInfo.InvariantCulture)}", TextColors.Parameter);
			}
			if (isDefault)
				output.Write(TextColors.Punctuation, "]");
		}
		if (signature.IsVarArg) {
			if (count > 0)
				WriteCommaSpace();
			output.Write(TextColors.Keyword, "__arglist");
		}
		output.Write(TextColors.Punctuation, close);
	}

	void WriteGenerics(IList<GenericParam> parameters, string color) {
		if (parameters.Count == 0)
			return;
		output.Write(TextColors.Punctuation, "<");
		for (var index = 0; index < parameters.Count; index++) {
			if (index > 0)
				WriteCommaSpace();
			var parameter = parameters[index];
			if (parameter.IsCovariant) {
				output.Write(TextColors.Keyword, "out");
				WriteSpace();
			}
			else if (parameter.IsContravariant) {
				output.Write(TextColors.Keyword, "in");
				WriteSpace();
			}
			WriteIdentifier(parameter.Name, color);
		}
		output.Write(TextColors.Punctuation, ">");
	}

	void WriteModuleName(ModuleDef? module) {
		if (module is null || !Has(Options.ModuleNames))
			return;
		output.Write(TextColors.AssemblyModule, FilterName(GetFileName(module.Location ?? string.Empty)));
		output.Write(TextColors.Operator, "!");
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
				output.Write(TextColors.Keyword, keyword);
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
			output.Write(TextColors.Namespace, part);
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
				output.Write(TextColors.Keyword, "out");
			else if (ownerParameter is not null && ownerParameter.IsIn && !ownerParameter.IsOut && HasIsReadOnlyAttribute(ownerParameter.CustomAttributes))
				output.Write(TextColors.Keyword, "in");
			else {
				output.Write(TextColors.Keyword, "ref");
				if (forceReadOnly) {
					WriteSpace();
					output.Write(TextColors.Keyword, "readonly");
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
					output.Write(TextColors.Punctuation, "[");
					if (array.ElementType == ElementType.Array) {
						var rank = array.Rank;
						if (rank == 0)
							output.Write(TextColors.Error, "<RANK0>");
						else {
							if (rank == 1)
								output.Write(TextColors.Operator, "*");
							for (uint dimension = 1; dimension < rank; dimension++)
								output.Write(TextColors.Punctuation, ",");
						}
					}
					output.Write(TextColors.Punctuation, "]");
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
						output.Write(TextColors.Keyword, "dynamic");
					else
						WriteSystemTypeKeyword("Object", "object", false);
					break;
				case ElementType.TypedByRef:
					WriteSystemType("TypedReference", true);
					break;
				case ElementType.I:
					if (HasNativeIntegerAttribute(attributeProvider, state.NativeIntIndex++))
						output.Write(TextColors.Keyword, "nint");
					else
						WriteSystemType("IntPtr", true);
					break;
				case ElementType.U:
					if (HasNativeIntegerAttribute(attributeProvider, state.NativeIntIndex++))
						output.Write(TextColors.Keyword, "nuint");
					else
						WriteSystemType("UIntPtr", true);
					break;
				case ElementType.Ptr:
					state.DynamicTypeIndex++;
					Write(type.Next, ref state, attributeProvider);
					output.Write(TextColors.Operator, "*");
					break;
				case ElementType.ByRef:
					state.DynamicTypeIndex++;
					output.Write(TextColors.Keyword, "ref");
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
						output.Write(TextColors.MethodGenericParameter, $"!!{genericSig.Number.ToString(CultureInfo.InvariantCulture)}");
					else
						output.Write(TextColors.TypeGenericParameter, $"!{genericSig.Number.ToString(CultureInfo.InvariantCulture)}");
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
			output.Write(TextColors.Operator, "?");
			return;
		}
		var cardinality = GetSystemValueTupleRank(generic);
		if (cardinality > 1) {
			var tupleNameIndex = state.TupleNameIndex;
			state.TupleNameIndex += cardinality;
			output.Write(TextColors.Punctuation, "(");
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
						output.Write(TextColors.InstanceField, elementName);
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
			output.Write(TextColors.Punctuation, ")");
			return;
		}
		Write(generic.GenericType, ref state, attributeProvider);
		output.Write(TextColors.Punctuation, "<");
		for (var index = 0; index < generic.GenericArguments.Count; index++) {
			if (index > 0)
				WriteCommaSpace();
			state.DynamicTypeIndex++;
			Write(generic.GenericArguments[index], ref state, attributeProvider);
		}
		output.Write(TextColors.Punctuation, ">");
	}

	/// <summary>A function pointer, without the calling convention modifiers dnSpy spells out in brackets.</summary>
	void WriteFunctionPointer(MethodSig? signature, ref TypeState state, IHasCustomAttribute? attributeProvider) {
		output.Write(TextColors.Keyword, "delegate");
		output.Write(TextColors.Operator, "*");
		if (signature is null)
			return;
		if (signature.IsUnmanaged || !signature.IsDefault) {
			WriteSpace();
			output.Write(TextColors.Keyword, "unmanaged");
		}
		output.Write(TextColors.Punctuation, "<");
		state.DynamicTypeIndex++;
		foreach (var parameter in signature.Params) {
			state.DynamicTypeIndex++;
			var parameterType = parameter.RemovePinnedAndModifiers();
			if (parameterType is ByRefSig byRef) {
				output.Write(TextColors.Keyword, "ref");
				WriteSpace();
				parameterType = byRef.Next;
			}
			Write(parameterType, ref state, attributeProvider);
			WriteCommaSpace();
		}
		Write(signature.RetType.RemovePinnedAndModifiers(), ref state, attributeProvider);
		output.Write(TextColors.Punctuation, ">");
	}

	void WriteSystemTypeKeyword(string name, string keyword, bool isValueType) {
		if (Has(Options.IntrinsicTypeKeywords))
			output.Write(TextColors.Keyword, keyword);
		else
			WriteSystemType(name, isValueType);
	}

	void WriteSystemType(string name, bool isValueType) {
		if (Has(Options.Namespaces)) {
			output.Write(TextColors.Namespace, "System");
			WritePeriod();
		}
		output.Write(isValueType ? TextColors.ValueType : TextColors.Type, name);
	}

	// ---------------------------------------------------------------- pieces

	void WriteIdentifier(string? identifier, string color) {
		var text = FilterName(identifier);
		output.Write(color, Keywords.Contains(text) ? "@" + text : text);
	}

	void WriteSpace() => output.WriteSpace();
	void WriteCommaSpace() => output.WriteCommaSpace();
	void WritePeriod() => output.Write(TextColors.Operator, ".");
	void WriteError() => output.Write(TextColors.Error, "???");

	static string[]? TryGetOperatorInfo(string? name) => name is not null && OperatorNames.TryGetValue(name, out var info) ? info : null;

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

	static bool HasConstant(ParamDef? parameter) {
		if (parameter is null)
			return false;
		if (parameter.Constant is not null)
			return true;
		foreach (var attribute in parameter.CustomAttributes) {
			for (var type = attribute.AttributeType; type is not null; type = type.GetBaseType()) {
				var fullName = type.FullName;
				if (fullName is "System.Runtime.CompilerServices.CustomConstantAttribute" or "System.Runtime.CompilerServices.DecimalConstantAttribute")
					return true;
			}
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
