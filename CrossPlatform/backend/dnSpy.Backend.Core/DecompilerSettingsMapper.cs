using ICSharpCode.Decompiler;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core;

/// <summary>
/// Maps between the DTO decompiler settings and ICSharpCode.Decompiler's DecompilerSettings.
/// </summary>
internal static class DecompilerSettingsMapper {
	/// <summary>
	/// The C# page as the decompiler takes it: the options the package has set on it, and the ones only dnSpy's fork of
	/// ILSpy has carried in <see cref="DnSpyDecompilerSettings"/> for <see cref="DnSpyCSharpTransform"/>. No page is
	/// the page's defaults, which are the fork's.
	/// </summary>
	public static DecompilerSettings ToDecompilerSettings(this DecompilerSettingsDto? dto) {
		var cs = dto?.CSharp ?? new CSharpDecompilerSettingsDto();
		return new DnSpyDecompilerSettings {
			AnonymousMethods = cs.AnonymousMethods,
			YieldReturn = cs.YieldReturn,
			AsyncAwait = cs.AsyncAwait,
			QueryExpressions = cs.QueryExpressions,
			ExpressionTrees = cs.ExpressionTrees,
			UseDebugSymbols = cs.UseDebugSymbols,
			ShowXmlDocumentation = cs.ShowXmlDocumentation,
			SortCustomAttributes = cs.SortCustomAttributes,
			// The fork keeps the using declarations and writes every type with its namespace; the package qualifies
			// them only without usings, which the transform then puts back.
			UsingDeclarations = !cs.FullyQualifyAllTypes,
			// ForceShowAllMembers shows what the decompiler would fold away. The package hides compiler-generated
			// types and members unconditionally; what it can still show are the backing fields and accessors of
			// automatic properties and events.
			AutomaticProperties = !cs.ForceShowAllMembers,
			AutomaticEvents = !cs.ForceShowAllMembers,
			ShowTokenAndRvaComments = cs.ShowTokenAndRvaComments,
			SortMembers = cs.SortMembers,
			UseSourceCodeOrder = cs.UseSourceCodeOrder,
			OneCustomAttributePerLine = cs.OneCustomAttributePerLine,
			TypeAddInternalModifier = cs.TypeAddInternalModifier,
			MemberAddPrivateModifier = cs.MemberAddPrivateModifier,
			HexadecimalNumbers = cs.HexadecimalNumbers,
			SortSystemUsingStatementsFirst = cs.SortSystemUsingStatementsFirst,
			FullyQualifyAllTypes = cs.FullyQualifyAllTypes,
			RemoveEmptyDefaultConstructors = cs.RemoveEmptyDefaultConstructors && !cs.ForceShowAllMembers,
			InsertParenthesesForReadability = cs.InsertParenthesesForReadability,
			DecompilationOrder = cs.DecompilationOrder is { Count: > 0 } order ? order : DnSpyDecompilerSettings.DefaultDecompilationOrder,
			// Left as the package writes them, which it does not let change:
			// - FullyQualifyAmbiguousTypeNames: a name that would be ambiguous is always qualified.
			// - AllowFieldInitializers: a field's initializer is always moved out of the constructors.
			// - EmitCalliAsInvocationExpression: calli is always a function pointer call, never inline IL.
		};
	}

	/// <summary>
	/// The settings for the Visual Basic view, which is the C# one converted: dnSpy's VBDecompiler writes every
	/// access modifier whatever the page says, since VB's defaults differ from C#'s.
	/// </summary>
	public static DecompilerSettings ToVisualBasicSettings(this DecompilerSettingsDto? dto) {
		var settings = dto.ToDecompilerSettings();
		if (settings is DnSpyDecompilerSettings dnSpy) {
			dnSpy.TypeAddInternalModifier = true;
			dnSpy.MemberAddPrivateModifier = true;
		}
		return settings;
	}
}
