using System.Globalization;
using dnlib.DotNet;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core;

/// <summary>
/// A member's tooltip the way dnSpy's IL decompiler writes one — ILDecompilerUtils.Write, which ILDecompiler.WriteToolTip
/// calls for anything but a type: a method as ILSpy's DisassemblerHelpers.WriteMethodTo writes a call's operand
/// (<c>instance void NS.Type::Name(int32)</c>), a field as WriteFieldTo does (<c>int32 NS.Type::Name</c>), and a
/// property or an event as the header ReflectionDisassembler.DisassembleProperty / DisassembleEvent writes with
/// <c>full</c> off (<c>.property instance string Title() { .get; .set; }</c>).
/// </summary>
static class ILMemberFormatter {
	/// <summary>Writes the tooltip; false for a type, which the IL decompiler hands to the C# formatter.</summary>
	public static bool WriteToolTip(TextPartsBuilder output, IMemberDef member, Func<ITypeDefOrRef, string>? typeColor) {
		switch (member) {
		case MethodDef method:
			WriteMethod(output, method, typeColor);
			return true;
		case FieldDef field:
			WriteField(output, field, typeColor);
			return true;
		case PropertyDef property:
			WriteProperty(output, property, typeColor);
			return true;
		case EventDef @event:
			WriteEvent(output, @event, typeColor);
			return true;
		default:
			return false;
		}
	}

	/// <summary>DisassemblerHelpers.Write(MethodSig, IMethod).</summary>
	static void WriteMethod(TextPartsBuilder output, MethodDef method, Func<ITypeDefOrRef, string>? typeColor) {
		var signature = method.MethodSig;
		if (signature is null)
			return;
		if (signature.ExplicitThis)
			output.Write(TextColors.Keyword, "instance").WriteSpace().Write(TextColors.Keyword, "explicit").WriteSpace();
		else if (signature.HasThis)
			output.Write(TextColors.Keyword, "instance").WriteSpace();
		if (signature.CallingConvention == CallingConvention.VarArg)
			output.Write(TextColors.Keyword, "vararg").WriteSpace();
		ILTypeName.Write(output, signature.RetType, ILTypeName.Syntax.SignatureNoNamedTypeParameters, typeColor);
		output.WriteSpace();
		if (method.DeclaringType is not null) {
			ILTypeName.Write(output, method.DeclaringType, ILTypeName.Syntax.TypeName, typeColor);
			output.Write(TextColors.Operator, "::");
		}
		// A compiler-controlled method shares its name with others, which ILDasm tells apart by the token.
		var name = method.IsCompilerControlled
			? method.Name.String + "$PST" + method.MDToken.ToInt32().ToString("X8", CultureInfo.InvariantCulture)
			: method.Name.String;
		output.Write(MetadataTextColors.Of(method), ILTypeName.Escape(name));
		output.Write(TextColors.Punctuation, "(");
		// DnlibExtensions.GetParameters: a vararg call site's extra arguments after the sentinel.
		var parameters = signature.ParamsAfterSentinel is { } extra ? [.. signature.Params, new SentinelSig(), .. extra] : signature.Params.ToList();
		for (var index = 0; index < parameters.Count; index++) {
			if (index > 0)
				output.WriteCommaSpace();
			ILTypeName.Write(output, parameters[index], ILTypeName.Syntax.SignatureNoNamedTypeParameters, typeColor);
		}
		output.Write(TextColors.Punctuation, ")");
	}

	/// <summary>DisassemblerHelpers.WriteFieldTo.</summary>
	static void WriteField(TextPartsBuilder output, FieldDef field, Func<ITypeDefOrRef, string>? typeColor) {
		if (field.FieldSig is null)
			return;
		ILTypeName.Write(output, field.FieldSig.Type, ILTypeName.Syntax.SignatureNoNamedTypeParameters, typeColor);
		output.WriteSpace();
		ILTypeName.Write(output, field.DeclaringType, ILTypeName.Syntax.TypeName, typeColor);
		output.Write(TextColors.Operator, "::");
		output.Write(MetadataTextColors.Of(field), ILTypeName.Escape(field.Name.String));
	}

	/// <summary>
	/// ReflectionDisassembler.DisassembleProperty with <c>full</c> off. An indexer's parameters go a line each,
	/// indented a tab the way the disassembler's output indents them; a marshal descriptor on one of them, which
	/// no compiler writes there, is left out.
	/// </summary>
	static void WriteProperty(TextPartsBuilder output, PropertyDef property, Func<ITypeDefOrRef, string>? typeColor) {
		output.Write(TextColors.ILDirective, ".property").WriteSpace();
		if ((property.Attributes & PropertyAttributes.SpecialName) != 0)
			output.Write(TextColors.Keyword, "specialname").WriteSpace();
		if ((property.Attributes & PropertyAttributes.RTSpecialName) != 0)
			output.Write(TextColors.Keyword, "rtspecialname").WriteSpace();
		var unknown = (int)property.Attributes & ~(int)(PropertyAttributes.SpecialName | PropertyAttributes.RTSpecialName | PropertyAttributes.HasDefault);
		if (unknown != 0)
			output.Write(TextColors.Keyword, "flags(" + unknown.ToString("x4", CultureInfo.InvariantCulture) + ")").WriteSpace();
		if (property.PropertySig is { HasThis: true })
			output.Write(TextColors.Keyword, "instance").WriteSpace();
		ILTypeName.Write(output, property.PropertySig?.GetRetType(), ILTypeName.Syntax.Signature, typeColor);
		output.WriteSpace();
		output.Write(MetadataTextColors.Of(property), ILTypeName.Escape(property.Name.String));
		output.Write(TextColors.Punctuation, "(");
		var parameters = PropertyParameters(property);
		if (parameters.Any(parameter => !parameter.IsHiddenThisParameter)) {
			output.Write(TextColors.Text, "\n");
			for (var index = 0; index < parameters.Count; index++) {
				var parameter = parameters[index];
				if (parameter.IsHiddenThisParameter)
					continue;
				output.Write(TextColors.Text, "\t");
				if (parameter.ParamDef is { } paramDef) {
					if (paramDef.IsIn)
						output.Write(TextColors.Punctuation, "[").Write(TextColors.Keyword, "in").Write(TextColors.Punctuation, "]").WriteSpace();
					if (paramDef.IsOut)
						output.Write(TextColors.Punctuation, "[").Write(TextColors.Keyword, "out").Write(TextColors.Punctuation, "]").WriteSpace();
					if (paramDef.IsOptional)
						output.Write(TextColors.Punctuation, "[").Write(TextColors.Keyword, "opt").Write(TextColors.Punctuation, "]").WriteSpace();
				}
				ILTypeName.Write(output, parameter.Type, ILTypeName.Syntax.Signature, typeColor);
				output.WriteSpace();
				output.Write(TextColors.Parameter, ILTypeName.Escape(parameter.Name));
				if (index < parameters.Count - 1)
					output.Write(TextColors.Punctuation, ",");
				output.Write(TextColors.Text, "\n");
			}
		}
		output.Write(TextColors.Punctuation, ")");
		if (property.HasConstant) {
			output.WriteSpace().Write(TextColors.Operator, "=").WriteSpace();
			WriteConstant(output, property.Constant.Value);
		}
		output.WriteSpace().Write(TextColors.Punctuation, "{");
		if (property.GetMethods.Count > 0)
			output.WriteSpace().Write(TextColors.Keyword, ".get").Write(TextColors.Punctuation, ";");
		if (property.SetMethods.Count > 0)
			output.WriteSpace().Write(TextColors.Keyword, ".set").Write(TextColors.Punctuation, ";");
		output.WriteSpace().Write(TextColors.Punctuation, "}");
	}

	/// <summary>ReflectionDisassembler.DisassembleEvent with <c>full</c> off.</summary>
	static void WriteEvent(TextPartsBuilder output, EventDef @event, Func<ITypeDefOrRef, string>? typeColor) {
		output.Write(TextColors.ILDirective, ".event").WriteSpace();
		if ((@event.Attributes & EventAttributes.SpecialName) != 0)
			output.Write(TextColors.Keyword, "specialname").WriteSpace();
		if ((@event.Attributes & EventAttributes.RTSpecialName) != 0)
			output.Write(TextColors.Keyword, "rtspecialname").WriteSpace();
		var unknown = (int)@event.Attributes & ~(int)(EventAttributes.SpecialName | EventAttributes.RTSpecialName);
		if (unknown != 0)
			output.Write(TextColors.Keyword, "flags(" + unknown.ToString("x4", CultureInfo.InvariantCulture) + ")").WriteSpace();
		ILTypeName.Write(output, @event.EventType, ILTypeName.Syntax.TypeName, typeColor);
		output.WriteSpace();
		output.Write(MetadataTextColors.Of(@event), ILTypeName.Escape(@event.Name.String));
		output.WriteSpace().Write(TextColors.Punctuation, "{");
		if (@event.AddMethod is not null)
			output.WriteSpace().Write(TextColors.Keyword, ".addon").Write(TextColors.Punctuation, ";");
		if (@event.RemoveMethod is not null)
			output.WriteSpace().Write(TextColors.Keyword, ".removeon").Write(TextColors.Punctuation, ";");
		if (@event.InvokeMethod is not null)
			output.WriteSpace().Write(TextColors.Keyword, ".fire").Write(TextColors.Punctuation, ";");
		output.WriteSpace().Write(TextColors.Punctuation, "}");
	}

	/// <summary>
	/// The parameters ILSpy's DnlibExtensions.GetParameters gives a property: its getter's, or its setter's less
	/// the value, or — with neither — the signature's, unnamed.
	/// </summary>
	static List<Parameter> PropertyParameters(PropertyDef property) {
		if (property.GetMethod is { } getter)
			return [.. getter.Parameters];
		if (property.SetMethod is { } setter) {
			var last = setter.Parameters.Count - 1;
			return [.. setter.Parameters.Where(parameter => parameter.Index != last)];
		}
		var types = property.PropertySig?.GetParams() ?? [];
		return [.. types.Select((type, index) => new Parameter(index, index, type))];
	}

	/// <summary>ReflectionDisassembler.WriteConstant: a primitive as its IL type around the value, a string
	/// quoted, a null as "nullref".</summary>
	static void WriteConstant(TextPartsBuilder output, object? constant) {
		switch (constant) {
		case null:
			output.Write(TextColors.Keyword, "nullref");
			return;
		case string text:
			output.Write(TextColors.String, "\"" + text.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal) + "\"");
			return;
		}
		var keyword = constant switch {
			bool => "bool",
			char => "char",
			sbyte => "int8",
			byte => "uint8",
			short => "int16",
			ushort => "uint16",
			int => "int32",
			uint => "uint32",
			long => "int64",
			ulong => "uint64",
			float => "float32",
			double => "float64",
			_ => null,
		};
		if (keyword is null) {
			output.Write(TextColors.Text, Convert.ToString(constant, CultureInfo.InvariantCulture));
			return;
		}
		output.Write(TextColors.Keyword, keyword).Write(TextColors.Punctuation, "(");
		var written = constant switch {
			bool value => value ? "true" : "false",
			char value => ((int)value).ToString(CultureInfo.InvariantCulture),
			float value when float.IsNaN(value) || float.IsInfinity(value) => "0x" + BitConverter.SingleToUInt32Bits(value).ToString("X8", CultureInfo.InvariantCulture),
			double value when double.IsNaN(value) || double.IsInfinity(value) => "0x" + BitConverter.DoubleToUInt64Bits(value).ToString("X16", CultureInfo.InvariantCulture),
			float value => value.ToString("R", CultureInfo.InvariantCulture),
			double value => value.ToString("R", CultureInfo.InvariantCulture),
			IFormattable value => value.ToString(null, CultureInfo.InvariantCulture),
			_ => constant.ToString(),
		};
		output.Write(constant is bool ? TextColors.Keyword : TextColors.Number, written);
		output.Write(TextColors.Punctuation, ")");
	}
}
