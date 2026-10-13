using dnlib.DotNet;
using dnlib.PE;

namespace dnSpy.Backend.Core;

/// <summary>
/// The images dnSpy's tree, search and analyzer rows wear, named after the files of its own image set
/// (<c>DsImages</c>) — "ClassPublic", "MethodPrivate", "EnumerationItemProtected". This is a port of WPF's
/// <c>DotNetImageService</c>: a type picks its shape from what it is (enum, struct, interface, delegate,
/// exception, VB module, generic, class) and its overlay from its visibility, a member from its access.
/// The client draws the image the name stands for; it never has to decide the shape itself.
/// </summary>
static class DotNetImages {
	public const string Assembly = "Assembly";
	public const string AssemblyExe = "AssemblyExe";
	public const string AssemblyError = "AssemblyError";
	public const string Module = "ModulePublic";
	public const string Namespace = "Namespace";
	public const string Reference = "Reference";
	public const string FolderClosed = "FolderClosed";
	public const string BinaryFile = "BinaryFile";
	public const string Type = "Type";
	public const string Template = "Template";
	public const string ClassPublic = "ClassPublic";
	public const string InterfacePublic = "InterfacePublic";
	public const string MethodPublic = "MethodPublic";
	public const string FieldPublic = "FieldPublic";
	public const string Property = "Property";
	public const string EventPublic = "EventPublic";
	public const string Search = "Search";

	/// <summary>An image file is an assembly with the gold "exe" overlay when it is not a DLL.</summary>
	public static string Of(Characteristics characteristics) =>
		(characteristics & Characteristics.Dll) == 0 ? AssemblyExe : Assembly;

	public static string Of(AssemblyDef assembly) => Of(assembly.ManifestModule?.Characteristics ?? Characteristics.Dll);

	public static string Of(TypeDef type) {
		var kind = type.IsValueType
			? type.IsEnum ? "Enumeration" : "Structure"
			: type.IsInterface ? "Interface"
			: IsDelegate(type) ? "Delegate"
			: IsException(type) ? "Exception"
			: IsVisualBasicModule(type) ? "Module"
			: type.GenericParameters.Count > 0 ? "Template"
			: "Class";
		var visibility = type.Visibility switch {
			TypeAttributes.Public or TypeAttributes.NestedPublic => "Public",
			TypeAttributes.NestedPrivate => "Private",
			TypeAttributes.NestedFamily => "Protected",
			TypeAttributes.NestedFamORAssem => "Shortcut",
			_ => "Internal",
		};
		// A VB module has no "protected internal" image; dnSpy shows the internal one. A public generic
		// type wears the plain template image, which has no "Public" twin.
		if (kind == "Module" && visibility == "Shortcut")
			visibility = "Internal";
		if (kind == "Template" && visibility == "Public")
			return Template;
		return kind + visibility;
	}

	public static string Of(FieldDef field) {
		var kind = field.DeclaringType is { IsEnum: true } && !field.IsSpecialName ? "EnumerationItem"
			: field.IsLiteral || (field.IsInitOnly && IsDecimalConstant(field)) ? "Constant"
			: "Field";
		return kind + Access((MethodAttributes)field.Access);
	}

	public static string Of(MethodDef method) {
		if (method.IsSpecialName && method.Name.StartsWith("op_", StringComparison.Ordinal))
			return "Operator" + Access(method.Access);
		if (method.IsStatic && method.CustomAttributes.IsDefined("System.Runtime.CompilerServices.ExtensionAttribute"))
			return "ExtensionMethod";
		return "Method" + Access(method.Access);
	}

	/// <summary>A property takes the access of its getter, or of its setter; a public one wears the plain
	/// property image, which has no "Public" twin.</summary>
	public static string Of(PropertyDef property) {
		var method = property.GetMethod ?? property.SetMethod;
		var access = method is null ? "Public" : Access(method.Access);
		return access == "Public" ? Property : "Property" + access;
	}

	public static string Of(EventDef @event) {
		var method = @event.AddMethod ?? @event.RemoveMethod;
		return "Event" + (method is null ? "Public" : Access(method.Access));
	}

	/// <summary>The image of whichever definition a node holds; anything else is drawn as a plain type.</summary>
	public static string Of(IMemberDef member) => member switch {
		TypeDef type => Of(type),
		MethodDef method => Of(method),
		FieldDef field => Of(field),
		PropertyDef property => Of(property),
		EventDef @event => Of(@event),
		_ => Type,
	};

	// FieldAttributes and MethodAttributes number their access the same way, so one switch reads both.
	static string Access(MethodAttributes access) => (access & MethodAttributes.MemberAccessMask) switch {
		MethodAttributes.Private => "Private",
		MethodAttributes.Family => "Protected",
		MethodAttributes.Assembly or MethodAttributes.FamANDAssem => "Internal",
		MethodAttributes.CompilerControlled => "Sealed",
		MethodAttributes.FamORAssem => "Shortcut",
		_ => "Public",
	};

	static bool IsVisualBasicModule(TypeDef type) =>
		type.DeclaringType is null && type.IsSealed && type.CustomAttributes.IsDefined("Microsoft.VisualBasic.CompilerServices.StandardModuleAttribute");

	static bool IsDelegate(TypeDef type) =>
		type.BaseType is { } baseType && baseType.FullName == "System.MulticastDelegate" && baseType.DefinitionAssembly.IsCorLib();

	/// <summary>Whether the type is System.Exception or derives from it, walking at most a thousand base
	/// types — dnSpy resolves each one, and a type it cannot resolve ends the walk.</summary>
	static bool IsException(TypeDef type) {
		if (IsSystemException(type))
			return true;
		TypeDef? current = type;
		for (var i = 0; i < 1000 && current is not null; i++) {
			if (IsSystemException(current.BaseType))
				return true;
			try {
				current = current.BaseType?.ScopeType.ResolveTypeDef();
			}
			catch {
				current = null;
			}
		}
		return false;
	}

	static bool IsSystemException(ITypeDefOrRef? type) =>
		type is not null && type.DeclaringType is null && type.Namespace == "System" && type.Name == "Exception" && type.DefinitionAssembly.IsCorLib();

	static bool IsDecimalConstant(FieldDef field) =>
		field.FieldType is { } type && type.DefinitionAssembly.IsCorLib() && type.FullName == "System.Decimal"
		&& field.CustomAttributes.IsDefined("System.Runtime.CompilerServices.DecimalConstantAttribute");
}
