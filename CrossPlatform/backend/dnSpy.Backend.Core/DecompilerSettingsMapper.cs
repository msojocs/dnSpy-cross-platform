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
			// types and members through the feature settings; the automatic-property and -event backing fields are
			// the two it can show by itself, the rest are added from a second decompilation (WorkspaceManager's
			// MergeHiddenMembers).
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
			FullyQualifyAmbiguousTypeNames = cs.FullyQualifyAmbiguousTypeNames,
			AllowFieldInitializers = cs.AllowFieldInitializers,
			EmitCalliAsInvocationExpression = cs.EmitCalliAsInvocationExpression,
			ForceShowAllMembers = cs.ForceShowAllMembers,
			RemoveEmptyDefaultConstructors = cs.RemoveEmptyDefaultConstructors && !cs.ForceShowAllMembers,
			InsertParenthesesForReadability = cs.InsertParenthesesForReadability,
			DecompilationOrder = cs.DecompilationOrder is { Count: > 0 } order ? order : DnSpyDecompilerSettings.DefaultDecompilationOrder,
		};
	}

	/// <summary>
	/// The settings for the Visual Basic view, which is the C# one converted: dnSpy's VBDecompiler writes every
	/// access modifier whatever the page says, since VB's defaults differ from C#'s, and turns off the C# spellings
	/// its own converter (NRefactory.VB) never had to handle. The same switches keep the modern C# syntax the
	/// converter has no VB form for out of the text: records, primary constructors, switch expressions, patterns,
	/// required/init members and file-scoped namespaces are written the way dnSpy's older C# view wrote them.
	/// </summary>
	public static DecompilerSettings ToVisualBasicSettings(this DecompilerSettingsDto? dto) =>
		dto.ToDecompilerSettings().ToVisualBasicSettings();

	/// <summary>
	/// The settings a Visual Basic view decompiles its C# with: dnSpy's VBDecompiler writes every access modifier
	/// whatever the page says, since VB's defaults differ from C#'s, and turns off the C# spellings its own
	/// converter (NRefactory.VB) never had to handle. The same switches keep the modern C# syntax the converter has
	/// no VB form for out of the text: records, primary constructors, switch expressions, patterns, required/init
	/// members and file-scoped namespaces are written the way dnSpy's older C# view wrote them.
	/// </summary>
	public static T ToVisualBasicSettings<T>(this T settings) where T : DecompilerSettings {
		if (settings is DnSpyDecompilerSettings dnSpy) {
			dnSpy.TypeAddInternalModifier = true;
			dnSpy.MemberAddPrivateModifier = true;
		}
		// dnSpy's VBDecompiler.CreateAstBuilder.
		settings.IntroduceIncrementAndDecrement = false;
		settings.MakeAssignmentExpressions = false;
		settings.QueryExpressions = false;
		// The C# the VB view is converted from stays in the syntax dnSpy's Visual Basic decompiler knew.
		settings.NullableReferenceTypes = false;
		settings.RecordClasses = false;
		settings.RecordStructs = false;
		settings.UsePrimaryConstructorSyntax = false;
		settings.UsePrimaryConstructorSyntaxForNonRecordTypes = false;
		settings.RequiredMembers = false;
		settings.InitAccessors = false;
		settings.FileScopedNamespaces = false;
		settings.SwitchExpressions = false;
		settings.Ranges = false;
		settings.PatternMatching = false;
		settings.RecursivePatternMatching = false;
		settings.PatternCombinators = false;
		settings.RelationalPatterns = false;
		settings.WithExpressions = false;
		settings.UseEnhancedUsing = false;
		settings.Utf8StringLiterals = false;
		settings.ParamsCollections = false;
		settings.StackAllocInitializers = false;
		settings.StructDefaultConstructorsAndFieldInitializers = false;
		settings.FunctionPointers = false;
		return settings;
	}
}
