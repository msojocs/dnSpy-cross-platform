using ICSharpCode.Decompiler;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core;

/// <summary>
/// Maps between the DTO decompiler settings and ICSharpCode.Decompiler's DecompilerSettings.
/// </summary>
internal static class DecompilerSettingsMapper {
	public static DecompilerSettings ToDecompilerSettings(this DecompilerSettingsDto? dto) {
		if (dto?.CSharp is null)
			return new DecompilerSettings();

		var cs = dto.CSharp;
		return new DecompilerSettings {
			AnonymousMethods = cs.AnonymousMethods,
			YieldReturn = cs.YieldReturn,
			AsyncAwait = cs.AsyncAwait,
			QueryExpressions = cs.QueryExpressions,
			ExpressionTrees = cs.ExpressionTrees,
			UseDebugSymbols = cs.UseDebugSymbols,
			ShowXmlDocumentation = cs.ShowXmlDocumentation,
			// The following properties are dnSpy-specific and not in the base ILSpy DecompilerSettings:
			// - SortCustomAttributes, FullyQualifyAllTypes, FullyQualifyAmbiguousTypeNames
			// - RemoveEmptyDefaultConstructors, ShowTokenAndRvaComments, SortMembers
			// - ForceShowAllMembers, SortSystemUsingStatementsFirst, UseSourceCodeOrder
			// - OneCustomAttributePerLine, AllowFieldInitializers, TypeAddInternalModifier
			// - MemberAddPrivateModifier, HexadecimalNumbers, EmitCalliAsInvocationExpression
			// - InsertParenthesesForReadability
			// These were part of WPF dnSpy's fork of ILSpy but aren't in the NuGet package.
			// For now, we use the available properties and the rest will be ignored.
		};
	}
}
