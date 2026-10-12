using dnlib.DotNet;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core.Search;

/// <summary>
/// The text of a search result the way dnSpy's search list writes it — SearchResult.CreateUI through the C#
/// decompiler's member formatter with its default options, less the parameter names, the declaring types and
/// the field values: "void Main(string[])", "string Nonce { get; init; }", a type by its name or, as a
/// location, with its namespace.
/// </summary>
static class SearchResultFormatter {
	static readonly Dictionary<string, string[]> operatorNames = new(StringComparer.Ordinal) {
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

	public static void Write(TextPartsBuilder output, object? value, bool includeNamespace, Func<ITypeDefOrRef, string> typeColor) {
		switch (value) {
		case SearchNamespace ns:
			output.WriteNamespace(ns.Name);
			break;
		case TypeDef type:
			// IDecompiler.WriteType: the type the way the decompiler names it, with its namespace as a location.
			if (!CSharpTypeName.Write(output, null, type, includeNamespace ? CSharpTypeName.Options.IncludeNamespace : CSharpTypeName.Options.None, typeColor))
				output.Write(MetadataTextColors.Of(type), type.Name.String);
			break;
		case MethodDef method:
			WriteMethod(output, method, typeColor);
			if (method.ImplMap is { } implMap && !UTF8String.IsNullOrEmpty(implMap.Name) && implMap.Name != method.Name) {
				output.WriteSpace().Write(TextColors.Punctuation, "(");
				output.Write(MetadataTextColors.Of(method), implMap.Name.String);
				output.Write(TextColors.Punctuation, ")");
			}
			break;
		case FieldDef field:
			WriteField(output, field, typeColor);
			break;
		case PropertyDef property:
			WriteProperty(output, property, writeAccessors: true, typeColor);
			break;
		case EventDef @event:
			WriteEvent(output, @event, writeAccessors: true, typeColor);
			break;
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

	/// <summary>CSharpFormatter.Write(IMethod): an accessor as its property or event and the keyword, an
	/// operator by its symbol, the return type ahead of the name, and the parameter types.</summary>
	static void WriteMethod(TextPartsBuilder output, MethodDef method, Func<ITypeDefOrRef, string> typeColor) {
		foreach (var property in method.DeclaringType.Properties) {
			if (property.GetMethod == method) {
				WriteProperty(output, property, writeAccessors: false, typeColor);
				output.Write(TextColors.Operator, ".").Write(TextColors.Keyword, "get");
				return;
			}
			if (property.SetMethod == method) {
				WriteProperty(output, property, writeAccessors: false, typeColor);
				output.Write(TextColors.Operator, ".").Write(TextColors.Keyword, IsInitOnly(method) ? "init" : "set");
				return;
			}
		}
		foreach (var @event in method.DeclaringType.Events) {
			if (@event.AddMethod == method || @event.RemoveMethod == method) {
				WriteEvent(output, @event, writeAccessors: false, typeColor);
				output.Write(TextColors.Operator, ".").Write(TextColors.Keyword, @event.AddMethod == method ? "add" : "remove");
				return;
			}
		}

		string[]? operatorInfo = null;
		if (!method.IsConstructor) {
			var name = method.Overrides.Count > 0 ? method.Overrides[0].MethodDeclaration.Name.String : method.Name.String;
			operatorNames.TryGetValue(name, out operatorInfo);
		}
		var isConversion = operatorInfo is ["explicit" or "implicit", ..];
		if (!isConversion && !method.IsConstructor) {
			CSharpTypeName.Write(output, method.Parameters.ReturnParameter.ParamDef, method.ReturnType, typeColor);
			output.WriteSpace();
		}
		if (method.IsConstructor)
			output.Write(MetadataTextColors.Of(method), RemoveGenericTick(method.DeclaringType.Name.String));
		else if (operatorInfo is not null) {
			for (var index = 0; index < operatorInfo.Length; index++) {
				if (index > 0)
					output.WriteSpace();
				var word = operatorInfo[index];
				output.Write(char.IsAsciiLetterLower(word[0]) ? TextColors.Keyword : TextColors.Operator, word);
			}
		}
		else
			output.Write(MetadataTextColors.Of(method), method.Overrides.Count > 0 ? method.Overrides[0].MethodDeclaration.Name.String : method.Name.String);
		if (isConversion) {
			output.WriteSpace();
			CSharpTypeName.Write(output, method.Parameters.ReturnParameter.ParamDef, method.ReturnType, typeColor);
		}
		if (method.GenericParameters.Count > 0) {
			output.Write(TextColors.Punctuation, "<");
			for (var index = 0; index < method.GenericParameters.Count; index++) {
				if (index > 0)
					output.WriteCommaSpace();
				output.Write(TextColors.MethodGenericParameter, method.GenericParameters[index].Name.String);
			}
			output.Write(TextColors.Punctuation, ">");
		}
		WriteParameters(output, method, "(", ")", lastIsValue: false, typeColor);
	}

	/// <summary>The parameter types: a defaulted one in brackets, a params array after its keyword.</summary>
	static void WriteParameters(TextPartsBuilder output, MethodDef method, string open, string close, bool lastIsValue, Func<ITypeDefOrRef, string> typeColor) {
		output.Write(TextColors.Punctuation, open);
		var parameters = method.Parameters.Where(parameter => !parameter.IsHiddenThisParameter).ToList();
		// A setter's last parameter is the value, which an indexer's list leaves out.
		if (lastIsValue && parameters.Count > 0)
			parameters.RemoveAt(parameters.Count - 1);
		for (var index = 0; index < parameters.Count; index++) {
			if (index > 0)
				output.WriteCommaSpace();
			var paramDef = parameters[index].ParamDef;
			var isDefault = paramDef is not null && HasConstant(paramDef);
			if (isDefault)
				output.Write(TextColors.Punctuation, "[");
			if (paramDef is not null && paramDef.CustomAttributes.IsDefined("System.ParamArrayAttribute"))
				output.Write(TextColors.Keyword, "params").WriteSpace();
			CSharpTypeName.Write(output, paramDef, parameters[index].Type, typeColor);
			if (isDefault)
				output.Write(TextColors.Punctuation, "]");
		}
		if (method.MethodSig?.IsVarArg == true) {
			if (parameters.Count > 0)
				output.WriteCommaSpace();
			output.Write(TextColors.Keyword, "__arglist");
		}
		output.Write(TextColors.Punctuation, close);
	}

	static void WriteField(TextPartsBuilder output, FieldDef field, Func<ITypeDefOrRef, string> typeColor) {
		// An enum's constants are written without the type every one of them has.
		if (field.DeclaringType?.IsEnum != true || !field.IsLiteral) {
			CSharpTypeName.Write(output, field, field.FieldSig?.Type, typeColor);
			output.WriteSpace();
		}
		output.Write(MetadataTextColors.Of(field), field.Name.String);
	}

	static void WriteProperty(TextPartsBuilder output, PropertyDef property, bool writeAccessors, Func<ITypeDefOrRef, string> typeColor) {
		var getter = property.GetMethods.FirstOrDefault();
		var setter = property.SetMethods.FirstOrDefault();
		var accessor = getter ?? setter;
		if (accessor is null) {
			output.Write(TextColors.Error, "???");
			return;
		}
		if (accessor == setter) {
			var value = accessor.Parameters.LastOrDefault(parameter => !parameter.IsHiddenThisParameter);
			CSharpTypeName.Write(output, value?.ParamDef, value?.Type, typeColor);
		}
		else
			CSharpTypeName.Write(output, accessor.Parameters.ReturnParameter.ParamDef, accessor.ReturnType, typeColor);
		output.WriteSpace();
		var overridden = accessor.Overrides.Count == 0 ? null : accessor.Overrides[0].MethodDeclaration;
		if (property.PropertySig?.GetParamCount() > 0) {
			output.Write(TextColors.Keyword, "this");
			WriteParameters(output, accessor, "[", "]", lastIsValue: accessor == setter, typeColor);
		}
		else if (overridden is not null && PropertyName(overridden) is { } name)
			output.Write(MetadataTextColors.Of(property), name);
		else
			output.Write(MetadataTextColors.Of(property), property.Name.String);
		if (!writeAccessors)
			return;
		output.WriteSpace().Write(TextColors.Punctuation, "{");
		if (property.GetMethods.Count > 0)
			output.WriteSpace().Write(TextColors.Keyword, "get").Write(TextColors.Punctuation, ";");
		if (property.SetMethods.Count > 0)
			output.WriteSpace().Write(TextColors.Keyword, property.SetMethods.Count == 1 && IsInitOnly(property.SetMethod) ? "init" : "set").Write(TextColors.Punctuation, ";");
		output.WriteSpace().Write(TextColors.Punctuation, "}");
	}

	static void WriteEvent(TextPartsBuilder output, EventDef @event, bool writeAccessors, Func<ITypeDefOrRef, string> typeColor) {
		CSharpTypeName.Write(output, @event, @event.EventType, CSharpTypeName.Options.None, typeColor);
		output.WriteSpace();
		output.Write(MetadataTextColors.Of(@event), @event.Name.String);
		if (!writeAccessors)
			return;
		output.WriteSpace().Write(TextColors.Punctuation, "{");
		if (@event.AddMethod is not null)
			output.WriteSpace().Write(TextColors.Keyword, "add").Write(TextColors.Punctuation, ";");
		if (@event.RemoveMethod is not null)
			output.WriteSpace().Write(TextColors.Keyword, "remove").Write(TextColors.Punctuation, ";");
		output.WriteSpace().Write(TextColors.Punctuation, "}");
	}

	/// <summary>TypeFormatterUtils.HasConstant: a default value, or the attribute a decimal or a custom constant
	/// is written as — DecimalConstantAttribute, or CustomConstantAttribute and the framework's subclasses of it.</summary>
	static bool HasConstant(ParamDef parameter) =>
		parameter.Constant is not null || parameter.CustomAttributes.Any(attribute => attribute.AttributeType?.FullName is
			"System.Runtime.CompilerServices.DecimalConstantAttribute" or
			"System.Runtime.CompilerServices.CustomConstantAttribute" or
			"System.Runtime.CompilerServices.DateTimeConstantAttribute" or
			"System.Runtime.CompilerServices.IDispatchConstantAttribute" or
			"System.Runtime.CompilerServices.IUnknownConstantAttribute");

	/// <summary>The init accessor C# 9 writes: a setter returning void modreq(IsExternalInit).</summary>
	static bool IsInitOnly(MethodDef? setter) =>
		setter?.ReturnType is CModReqdSig modifier && modifier.Modifier.FullName == "System.Runtime.CompilerServices.IsExternalInit";

	static string? PropertyName(IMethod method) {
		var name = method.Name.String;
		return name.StartsWith("get_", StringComparison.Ordinal) || name.StartsWith("set_", StringComparison.Ordinal) ? name[4..] : null;
	}

	static string RemoveGenericTick(string name) {
		var tick = name.IndexOf('`');
		return tick < 0 ? name : name[..tick];
	}
}
