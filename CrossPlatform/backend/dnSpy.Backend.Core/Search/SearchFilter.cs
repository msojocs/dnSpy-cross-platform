using dnlib.DotNet;
using dnlib.DotNet.Emit;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core.Search;

/// <summary>dnSpy's VisibleMembersFlags: which kinds of tree node a search looks for.</summary>
[Flags]
enum VisibleMembersFlags {
	AssemblyDef = 0x00000001,
	ModuleDef = 0x00000002,
	Namespace = 0x00000004,
	TypeDef = 0x00000008,
	FieldDef = 0x00000010,
	MethodDef = 0x00000020,
	PropertyDef = 0x00000040,
	EventDef = 0x00000080,
	AssemblyRef = 0x00000100,
	BaseTypes = 0x00000200,
	DerivedTypes = 0x00000400,
	ModuleRef = 0x00000800,
	ResourceList = 0x00001000,
	NonNetFile = 0x00002000,
	GenericTypeDef = 0x00004000,
	NonGenericTypeDef = 0x00008000,
	EnumTypeDef = 0x00010000,
	InterfaceTypeDef = 0x00020000,
	ClassTypeDef = 0x00040000,
	StructTypeDef = 0x00080000,
	DelegateTypeDef = 0x00100000,
	MethodBody = 0x00200000,
	InstanceConstructor = 0x00400000,
	ParamDefs = 0x00800000,
	ParamDef = 0x01000000,
	Locals = 0x02000000,
	Local = 0x04000000,
	Resource = 0x08000000,
	ResourceElement = 0x10000000,
	Other = 0x20000000,
	Attributes = 0x40000000,
	TypeDefOther = GenericTypeDef | NonGenericTypeDef | EnumTypeDef | InterfaceTypeDef | ClassTypeDef | StructTypeDef | DelegateTypeDef,
	AnyTypeDef = TypeDef | TypeDefOther,
	TreeViewAll = AssemblyDef | ModuleDef | Namespace | TypeDef |
		FieldDef | MethodDef | PropertyDef | EventDef |
		AssemblyRef | BaseTypes | DerivedTypes | ModuleRef |
		ResourceList | NonNetFile | Resource | ResourceElement |
		Other,
}

/// <summary>Whether a node is skipped with everything under it, looked inside, or shown.</summary>
enum FilterType {
	Default,
	Hide,
	Visible,
	CheckChildren,
}

readonly record struct SearchFilterResult(FilterType FilterType, bool IsMatch);

/// <summary>
/// dnSpy's FlagsDocumentTreeNodeFilter: for each kind of node, whether the search type looks for it and
/// whether what it looks for can be found under it.
/// </summary>
sealed class SearchFilter(VisibleMembersFlags flags) {
	/// <summary>The flags each "Search For" entry stands for — SearchControlVM's list.</summary>
	public static VisibleMembersFlags FlagsOf(string searchType) => searchType switch {
		SearchTypes.Assembly => VisibleMembersFlags.AssemblyDef,
		SearchTypes.Module => VisibleMembersFlags.ModuleDef,
		SearchTypes.Namespace => VisibleMembersFlags.Namespace,
		SearchTypes.Type => VisibleMembersFlags.TypeDef,
		SearchTypes.Field => VisibleMembersFlags.FieldDef,
		SearchTypes.Method => VisibleMembersFlags.MethodDef,
		SearchTypes.Property => VisibleMembersFlags.PropertyDef,
		SearchTypes.Event => VisibleMembersFlags.EventDef,
		SearchTypes.Parameter => VisibleMembersFlags.ParamDef,
		SearchTypes.Local => VisibleMembersFlags.Local,
		SearchTypes.ParameterLocal => VisibleMembersFlags.ParamDef | VisibleMembersFlags.Local,
		SearchTypes.AssemblyRef => VisibleMembersFlags.AssemblyRef,
		SearchTypes.ModuleRef => VisibleMembersFlags.ModuleRef,
		SearchTypes.Resource => VisibleMembersFlags.Resource | VisibleMembersFlags.ResourceElement,
		SearchTypes.GenericType => VisibleMembersFlags.GenericTypeDef,
		SearchTypes.NonGenericType => VisibleMembersFlags.NonGenericTypeDef,
		SearchTypes.Enum => VisibleMembersFlags.EnumTypeDef,
		SearchTypes.Interface => VisibleMembersFlags.InterfaceTypeDef,
		SearchTypes.Class => VisibleMembersFlags.ClassTypeDef,
		SearchTypes.Struct => VisibleMembersFlags.StructTypeDef,
		SearchTypes.Delegate => VisibleMembersFlags.DelegateTypeDef,
		SearchTypes.Member => VisibleMembersFlags.MethodDef | VisibleMembersFlags.FieldDef | VisibleMembersFlags.PropertyDef | VisibleMembersFlags.EventDef,
		SearchTypes.Literal => VisibleMembersFlags.MethodBody | VisibleMembersFlags.FieldDef | VisibleMembersFlags.ParamDef | VisibleMembersFlags.PropertyDef |
			VisibleMembersFlags.Resource | VisibleMembersFlags.ResourceElement | VisibleMembersFlags.Attributes,
		SearchTypes.Any => VisibleMembersFlags.TreeViewAll | VisibleMembersFlags.ParamDef | VisibleMembersFlags.Local,
		_ => throw new RpcException(ErrorCodes.InvalidParams, $"Unknown search type \"{searchType}\"."),
	};

	SearchFilterResult Has(VisibleMembersFlags flag) {
		var isMatch = (flags & flag) != 0;
		return new(isMatch ? FilterType.Visible : FilterType.Hide, isMatch);
	}

	/// <summary>A node the search type names itself, or one something it names may be under.</summary>
	SearchFilterResult Container(VisibleMembersFlags thisFlag, VisibleMembersFlags visibleFlags, FilterType otherwise) {
		var isMatch = (flags & thisFlag) != 0;
		if ((flags & visibleFlags) == 0)
			return new(FilterType.Hide, isMatch);
		return new(isMatch ? FilterType.Visible : otherwise, isMatch);
	}

	const VisibleMembersFlags FileContents = VisibleMembersFlags.Namespace | VisibleMembersFlags.AnyTypeDef |
		VisibleMembersFlags.FieldDef | VisibleMembersFlags.MethodDef | VisibleMembersFlags.InstanceConstructor |
		VisibleMembersFlags.PropertyDef | VisibleMembersFlags.EventDef | VisibleMembersFlags.AssemblyRef |
		VisibleMembersFlags.BaseTypes | VisibleMembersFlags.DerivedTypes | VisibleMembersFlags.ModuleRef |
		VisibleMembersFlags.ResourceList | VisibleMembersFlags.MethodBody | VisibleMembersFlags.ParamDefs |
		VisibleMembersFlags.ParamDef | VisibleMembersFlags.Locals | VisibleMembersFlags.Local |
		VisibleMembersFlags.Resource | VisibleMembersFlags.ResourceElement | VisibleMembersFlags.Other |
		VisibleMembersFlags.Attributes;

	public SearchFilterResult GetResult(AssemblyDef assembly) =>
		Container(VisibleMembersFlags.AssemblyDef, VisibleMembersFlags.AssemblyDef | VisibleMembersFlags.ModuleDef | FileContents, FilterType.Default);

	public SearchFilterResult GetResult(ModuleDef module) =>
		Container(VisibleMembersFlags.ModuleDef, VisibleMembersFlags.ModuleDef | FileContents, FilterType.Default);

	/// <summary>A file that is not a .NET module.</summary>
	public SearchFilterResult GetResultNonNetFile() =>
		Container(VisibleMembersFlags.NonNetFile, VisibleMembersFlags.NonNetFile | VisibleMembersFlags.Other | VisibleMembersFlags.Attributes, FilterType.Default);

	public SearchFilterResult GetResult(AssemblyRef assemblyRef) => Has(VisibleMembersFlags.AssemblyRef);

	public SearchFilterResult GetResult(ModuleRef moduleRef) => Has(VisibleMembersFlags.ModuleRef);

	public SearchFilterResult GetResultReferencesFolder() =>
		(flags & (VisibleMembersFlags.AssemblyRef | VisibleMembersFlags.ModuleRef)) == 0 ? new(FilterType.Hide, false) : new(FilterType.Default, false);

	public SearchFilterResult GetResultResourcesFolder() =>
		Container(VisibleMembersFlags.ResourceList, VisibleMembersFlags.ResourceList | VisibleMembersFlags.Resource | VisibleMembersFlags.ResourceElement | VisibleMembersFlags.Attributes, FilterType.CheckChildren);

	public SearchFilterResult GetResultResource() =>
		Container(VisibleMembersFlags.Resource, VisibleMembersFlags.Resource | VisibleMembersFlags.ResourceElement | VisibleMembersFlags.Attributes, FilterType.CheckChildren);

	public SearchFilterResult GetResultResourceElement() => Has(VisibleMembersFlags.ResourceElement);

	public SearchFilterResult GetResult(string ns) =>
		Container(VisibleMembersFlags.Namespace, VisibleMembersFlags.Namespace | VisibleMembersFlags.AnyTypeDef | VisibleMembersFlags.FieldDef |
			VisibleMembersFlags.MethodDef | VisibleMembersFlags.InstanceConstructor | VisibleMembersFlags.PropertyDef |
			VisibleMembersFlags.EventDef | VisibleMembersFlags.BaseTypes | VisibleMembersFlags.DerivedTypes |
			VisibleMembersFlags.MethodBody | VisibleMembersFlags.ParamDefs | VisibleMembersFlags.ParamDef |
			VisibleMembersFlags.Locals | VisibleMembersFlags.Local | VisibleMembersFlags.Attributes, FilterType.CheckChildren);

	public SearchFilterResult GetResult(EventDef @event) =>
		Container(VisibleMembersFlags.EventDef, VisibleMembersFlags.EventDef | VisibleMembersFlags.MethodDef | VisibleMembersFlags.MethodBody |
			VisibleMembersFlags.ParamDefs | VisibleMembersFlags.ParamDef | VisibleMembersFlags.Locals | VisibleMembersFlags.Local |
			VisibleMembersFlags.Attributes, FilterType.CheckChildren);

	public SearchFilterResult GetResult(FieldDef field) =>
		Container(VisibleMembersFlags.FieldDef, VisibleMembersFlags.FieldDef | VisibleMembersFlags.Attributes, FilterType.CheckChildren);

	public SearchFilterResult GetResult(PropertyDef property) =>
		Container(VisibleMembersFlags.PropertyDef, VisibleMembersFlags.PropertyDef | VisibleMembersFlags.MethodDef | VisibleMembersFlags.MethodBody |
			VisibleMembersFlags.ParamDefs | VisibleMembersFlags.ParamDef | VisibleMembersFlags.Locals | VisibleMembersFlags.Local |
			VisibleMembersFlags.Attributes, FilterType.CheckChildren);

	public SearchFilterResult GetResult(MethodDef method) {
		const VisibleMembersFlags childrenFlags = VisibleMembersFlags.MethodBody | VisibleMembersFlags.ParamDefs |
			VisibleMembersFlags.ParamDef | VisibleMembersFlags.Locals | VisibleMembersFlags.Local | VisibleMembersFlags.Attributes;
		const VisibleMembersFlags visibleFlags = childrenFlags | VisibleMembersFlags.MethodDef | VisibleMembersFlags.InstanceConstructor;
		var isMatch = (flags & VisibleMembersFlags.MethodDef) != 0 ||
			(method.IsInstanceConstructor && (flags & VisibleMembersFlags.InstanceConstructor) != 0);
		if ((flags & visibleFlags) == 0)
			return new(FilterType.Hide, false);
		if (isMatch)
			return new(FilterType.Visible, true);
		if ((flags & childrenFlags) == 0)
			return new(FilterType.Hide, false);
		return new(FilterType.CheckChildren, false);
	}

	public SearchFilterResult GetResult(TypeDef type) {
		const VisibleMembersFlags childrenFlags = VisibleMembersFlags.AnyTypeDef | VisibleMembersFlags.FieldDef |
			VisibleMembersFlags.MethodDef | VisibleMembersFlags.InstanceConstructor | VisibleMembersFlags.PropertyDef |
			VisibleMembersFlags.EventDef | VisibleMembersFlags.BaseTypes | VisibleMembersFlags.DerivedTypes |
			VisibleMembersFlags.MethodBody | VisibleMembersFlags.ParamDefs | VisibleMembersFlags.ParamDef |
			VisibleMembersFlags.Locals | VisibleMembersFlags.Local | VisibleMembersFlags.Attributes;
		if ((flags & childrenFlags) == 0)
			return new(FilterType.Hide, false);
		if ((flags & VisibleMembersFlags.GenericTypeDef) != 0 && type.GenericParameters.Count > 0)
			return new(FilterType.Visible, true);
		if ((flags & VisibleMembersFlags.NonGenericTypeDef) != 0 && type.GenericParameters.Count == 0)
			return new(FilterType.Visible, true);
		if ((flags & VisibleMembersFlags.EnumTypeDef) != 0 && type.IsEnum)
			return new(FilterType.Visible, true);
		if ((flags & VisibleMembersFlags.InterfaceTypeDef) != 0 && type.IsInterface)
			return new(FilterType.Visible, true);
		if ((flags & VisibleMembersFlags.ClassTypeDef) != 0 && !type.IsValueType && !type.IsInterface)
			return new(FilterType.Visible, true);
		if ((flags & VisibleMembersFlags.StructTypeDef) != 0 && type.IsValueType && !type.IsEnum)
			return new(FilterType.Visible, true);
		if ((flags & VisibleMembersFlags.DelegateTypeDef) != 0 && IsDelegate(type))
			return new(FilterType.Visible, true);
		if ((flags & VisibleMembersFlags.TypeDef) != 0)
			return new(FilterType.Visible, true);

		var checkChildren = new SearchFilterResult(FilterType.CheckChildren, false);
		if (type.HasNestedTypes)
			return checkChildren;
		if ((flags & VisibleMembersFlags.FieldDef) != 0 && type.HasFields)
			return checkChildren;
		if ((flags & VisibleMembersFlags.MethodDef) != 0 && type.HasMethods)
			return checkChildren;
		if ((flags & VisibleMembersFlags.InstanceConstructor) != 0 && type.Methods.Any(m => m.IsInstanceConstructor))
			return checkChildren;
		if ((flags & VisibleMembersFlags.PropertyDef) != 0 && type.HasProperties)
			return checkChildren;
		if ((flags & VisibleMembersFlags.EventDef) != 0 && type.HasEvents)
			return checkChildren;
		if ((flags & (VisibleMembersFlags.BaseTypes | VisibleMembersFlags.DerivedTypes)) != 0)
			return checkChildren;
		if ((flags & VisibleMembersFlags.MethodBody) != 0 && type.Methods.Any(m => m.Body is not null))
			return checkChildren;
		if ((flags & (VisibleMembersFlags.ParamDefs | VisibleMembersFlags.ParamDef)) != 0 && type.Methods.Any(m => m.HasParamDefs))
			return checkChildren;
		if ((flags & (VisibleMembersFlags.Locals | VisibleMembersFlags.Local)) != 0 && type.Methods.Any(m => m.Body is { HasVariables: true }))
			return checkChildren;
		return new(FilterType.Hide, false);
	}

	static bool IsDelegate(TypeDef type) =>
		type.BaseType is not null && type.BaseType.FullName == "System.MulticastDelegate" && type.BaseType.DefinitionAssembly.IsCorLib();

	public SearchFilterResult GetResultBody(MethodDef method) => Has(VisibleMembersFlags.MethodBody);

	public SearchFilterResult GetResultParamDefs(MethodDef method) =>
		Container(VisibleMembersFlags.ParamDefs, VisibleMembersFlags.ParamDefs | VisibleMembersFlags.ParamDef | VisibleMembersFlags.Attributes, FilterType.CheckChildren);

	public SearchFilterResult GetResult(MethodDef method, ParamDef param) =>
		Container(VisibleMembersFlags.ParamDef, VisibleMembersFlags.ParamDef | VisibleMembersFlags.Attributes, FilterType.CheckChildren);

	public SearchFilterResult GetResultLocals(MethodDef method) =>
		Container(VisibleMembersFlags.Locals, VisibleMembersFlags.Locals | VisibleMembersFlags.Local, FilterType.CheckChildren);

	public SearchFilterResult GetResult(MethodDef method, Local local) => Has(VisibleMembersFlags.Local);

	public SearchFilterResult GetResultAttributes(IHasCustomAttribute hca) => Has(VisibleMembersFlags.Attributes);
}
