using dnlib.DotNet;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core;

/// <summary>
/// Text written a stretch at a time, each in the color class dnSpy's <c>ITextColorWriter</c> would give it —
/// what a tree row's syntax highlighting is made of. Stretches of one class in a row are kept as one.
/// </summary>
sealed class TextPartsBuilder {
	readonly List<TextPartDto> parts = [];

	public TextPartsBuilder Write(string color, string? text) {
		if (string.IsNullOrEmpty(text))
			return this;
		if (parts.Count > 0 && parts[^1].Color == color)
			parts[^1] = parts[^1] with { Text = parts[^1].Text + text };
		else
			parts.Add(new TextPartDto(text, color));
		return this;
	}

	public TextPartsBuilder WriteSpace() => Write(TextColors.Text, " ");

	public TextPartsBuilder WriteCommaSpace() => Write(TextColors.Punctuation, ",").WriteSpace();

	/// <summary>The " : " a member's row writes before its type.</summary>
	public TextPartsBuilder WriteColon() => WriteSpace().Write(TextColors.Punctuation, ":").WriteSpace();

	/// <summary>A namespace part by part, the dots between them operators — and the empty one as "-".</summary>
	public TextPartsBuilder WriteNamespace(string @namespace) {
		if (@namespace.Length == 0)
			return Write(TextColors.Punctuation, "-");
		var names = @namespace.Split('.');
		for (var index = 0; index < names.Length; index++) {
			if (index > 0)
				Write(TextColors.Operator, ".");
			Write(TextColors.Namespace, names[index]);
		}
		return this;
	}

	public TextPartsBuilder WriteVersion(Version? version) =>
		version is null ? Write(TextColors.Error, "?.?.?.?") : Write(TextColors.Number, version.ToString());

	/// <summary>The full name of an assembly or an assembly reference the way dnSpy writes an <c>IAssembly</c>.</summary>
	public TextPartsBuilder WriteAssembly(IAssembly assembly) {
		var isExe = assembly is AssemblyDef { ManifestModule: { } manifest } && (manifest.Characteristics & dnlib.PE.Characteristics.Dll) == 0;
		Write(isExe ? TextColors.AssemblyExe : TextColors.Assembly, assembly.Name.String);
		WriteCommaSpace();
		Write(TextColors.InstanceProperty, "Version").Write(TextColors.Operator, "=").WriteVersion(assembly.Version);
		WriteCommaSpace();
		Write(TextColors.InstanceProperty, "Culture").Write(TextColors.Operator, "=");
		Write(TextColors.EnumField, UTF8String.IsNullOrEmpty(assembly.Culture) ? "neutral" : assembly.Culture.String);
		WriteCommaSpace();
		var publicKey = PublicKeyBase.ToPublicKeyToken(assembly.PublicKeyOrToken);
		Write(TextColors.InstanceProperty, publicKey is null || publicKey is PublicKeyToken ? "PublicKeyToken" : "PublicKey").Write(TextColors.Operator, "=");
		if (PublicKeyBase.IsNullOrEmpty2(publicKey))
			Write(TextColors.Keyword, "null");
		else
			Write(TextColors.Number, publicKey!.ToString());
		if ((assembly.Attributes & AssemblyAttributes.Retargetable) != 0) {
			WriteCommaSpace();
			Write(TextColors.InstanceProperty, "Retargetable").Write(TextColors.Operator, "=").Write(TextColors.EnumField, "Yes");
		}
		if ((assembly.Attributes & AssemblyAttributes.ContentType_Mask) == AssemblyAttributes.ContentType_WindowsRuntime) {
			WriteCommaSpace();
			Write(TextColors.InstanceProperty, "ContentType").Write(TextColors.Operator, "=").Write(TextColors.EnumField, "WindowsRuntime");
		}
		return this;
	}

	/// <summary>A file name in its directory, name and extension parts — dnSpy's WriteFilename.</summary>
	public TextPartsBuilder WriteFilename(string fileName) {
		var parts = fileName.Replace('\\', '/').Split('/');
		for (var index = 0; index < parts.Length - 1; index++)
			Write(TextColors.DirectoryPart, parts[index]).Write(TextColors.Text, "/");
		var name = parts[^1];
		var dot = name.LastIndexOf('.');
		if (dot < 0)
			return Write(TextColors.FileNameNoExtension, name);
		return Write(TextColors.FileNameNoExtension, name[..dot]).Write(TextColors.Text, ".").Write(TextColors.FileExtension, name[(dot + 1)..]);
	}

	public IReadOnlyList<TextPartDto> ToParts() => parts.ToArray();

	public override string ToString() => string.Concat(parts.Select(part => part.Text));
}

/// <summary>
/// dnSpy's <c>MetadataTextColorProvider</c>: the color class a type or a member is written in. A type
/// reference is colored as the definition it names when that is at hand, and as a plain type when not.
/// </summary>
static class MetadataTextColors {
	public static string Of(TypeDef? type) {
		if (type is null)
			return TextColors.Text;
		if (type.IsInterface)
			return TextColors.Interface;
		if (type.IsEnum)
			return TextColors.Enum;
		if (type.IsValueType)
			return TextColors.ValueType;
		if (type.IsDelegate)
			return TextColors.Delegate;
		if (type.IsSealed && type.IsAbstract && type.BaseType is { } baseType && baseType.DefinitionAssembly.IsCorLib()
			&& baseType.Namespace == "System" && baseType.Name == "Object")
			return TextColors.StaticType;
		return type.IsSealed ? TextColors.SealedType : TextColors.Type;
	}

	public static string Of(ITypeDefOrRef? type, Func<ITypeDefOrRef, TypeDef?> resolve) => type switch {
		null => TextColors.Text,
		TypeDef definition => Of(definition),
		TypeSpec { TypeSig: GenericSig generic } => generic.IsMethodVar ? TextColors.MethodGenericParameter : TextColors.TypeGenericParameter,
		TypeSpec => TextColors.Type,
		_ => resolve(type) is { } resolved ? Of(resolved) : TextColors.Type,
	};

	/// <summary>A member's own name: a constructor wears its type's color, an accessor-backed member the
	/// color of its first accessor's static-ness.</summary>
	public static string Of(IMemberDef member) => member switch {
		TypeDef type => Of(type),
		MethodDef { IsConstructor: true } constructor => Of(constructor.DeclaringType),
		MethodDef method => !method.IsStatic ? TextColors.InstanceMethod
			: method.CustomAttributes.IsDefined("System.Runtime.CompilerServices.ExtensionAttribute") ? TextColors.ExtensionMethod
			: TextColors.StaticMethod,
		FieldDef field => field.DeclaringType?.IsEnum == true ? TextColors.EnumField
			: field.IsLiteral ? TextColors.LiteralField
			: field.IsStatic ? TextColors.StaticField
			: TextColors.InstanceField,
		PropertyDef property => (property.GetMethod ?? property.SetMethod)?.IsStatic == true ? TextColors.StaticProperty : TextColors.InstanceProperty,
		EventDef @event => (@event.AddMethod ?? @event.RemoveMethod ?? @event.InvokeMethod)?.IsStatic == true ? TextColors.StaticEvent : TextColors.InstanceEvent,
		_ => TextColors.Text,
	};
}
