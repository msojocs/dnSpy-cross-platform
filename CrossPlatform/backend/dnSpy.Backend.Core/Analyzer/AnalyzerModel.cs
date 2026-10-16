using dnlib.DotNet;

namespace dnSpy.Backend.Core.Analyzer;

/// <summary>
/// What the analyzer's searches need from the workspace: the modules there are to search, and a resolver
/// that reaches across them. The workspace loads every module on its own, without a shared assembly
/// resolver, so dnlib's own <c>Resolve*()</c> stops at the module boundary; every lookup WPF hands to
/// dnlib's resolver comes here instead, and this one finds the definition among the open modules and the
/// assemblies their references name, loading the latter on demand the way dnSpy auto-loads them.
/// </summary>
interface IAnalyzerHost {
	/// <summary>Every module a search may look at — dnSpy's <c>IDsDocumentService.GetDocuments()</c>.</summary>
	IReadOnlyList<ModuleDef> Documents { get; }

	/// <summary>The definition a type names. A TypeSpec or a signature names its scope type — the generic
	/// type of an instance, the element type of an array — which is what dnlib's ResolveTypeDef resolves.</summary>
	TypeDef? ResolveTypeDef(IType? type);

	/// <summary>The method a MethodDef, MemberRef or MethodSpec names, found the way dnlib's resolver
	/// finds it: in the declaring type, then up its base types.</summary>
	MethodDef? ResolveMethodDef(IMethod? method);

	/// <summary>The field a FieldDef or a field MemberRef names.</summary>
	FieldDef? ResolveFieldDef(IField? field);

	/// <summary>Whether a result found in compiler-generated code is listed as the user method it was written
	/// in — what dnSpy's GetOriginalCodeLocation does for the C# decompiler with anonymous methods on, and
	/// for no other.</summary>
	bool ShowsOriginalCodeLocation { get; }
}

/// <summary>
/// The place in a method body a search found its result — dnSpy's SourceRef. The offset is absent when
/// the method uses the member somewhere other than in an instruction (a local's type, a catch clause);
/// <see cref="Reference"/> is the instruction's operand, which is what the caret is put on.
/// </summary>
readonly record struct AnalyzerSourceRef(MethodDef Method, uint? IlOffset, IMDTokenProvider? Reference);

/// <summary>
/// One thing a search found: a <see cref="TypeDef"/>, <see cref="MethodDef"/>, <see cref="FieldDef"/>,
/// <see cref="PropertyDef"/>, <see cref="EventDef"/>, or — for an attribute applied at that level — an
/// <see cref="AssemblyDef"/> or a <see cref="ModuleDef"/>.
/// </summary>
sealed record AnalyzerHit(object Entity, AnalyzerSourceRef? Source = null, bool HidesParent = false) {
	/// <summary>The member a hit names, which is what WPF compares when it drops duplicates; an assembly
	/// or a module names none.</summary>
	public IMemberRef? Member => Entity as IMemberRef;
}
