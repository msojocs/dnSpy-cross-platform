using dnSpy.Backend.Contracts;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Classification;
using Microsoft.CodeAnalysis.Text;

namespace dnSpy.Backend.Core.LanguageService;

/// <summary>
/// dnSpy's <c>RoslynClassifier</c> (<c>dnSpy.Roslyn/Text/Classification/RoslynClassifier.cs</c>): Roslyn's
/// classified spans, with every name refined by the symbol it binds to into the color dnSpy's theme gives that
/// kind of symbol — a static class, an extension method, a literal field — instead of Roslyn's coarser names.
/// </summary>
public static class RoslynClassifier {
	/// <summary>
	/// Colors <paramref name="textSpan"/>. A span Roslyn names but that binds to nothing dnSpy has a color for
	/// gets <paramref name="defaultColor"/>, or is left out when that is null; the C# Interactive window passes
	/// <see cref="TextColors.Error"/>, so a name that does not bind shows red.
	/// </summary>
	public static IReadOnlyList<ClassifiedSpanDto> Classify(SemanticModel semanticModel, Workspace workspace, TextSpan textSpan, string? defaultColor, CancellationToken cancellationToken) {
		var syntaxRoot = semanticModel.SyntaxTree.GetRoot(cancellationToken);
		var result = new List<ClassifiedSpanDto>();
		// The non-obsolete API needs a Document, which the REPL's submission is not.
#pragma warning disable CS0618
		foreach (var cspan in Classifier.GetClassifiedSpans(semanticModel, textSpan, workspace, cancellationToken)) {
#pragma warning restore CS0618
			if (IsAdditiveClassification(cspan.ClassificationType))
				continue;
			var color = GetColor(cspan, syntaxRoot, semanticModel, cancellationToken) ?? defaultColor;
			if (color is not null)
				result.Add(new ClassifiedSpanDto(cspan.TextSpan.Start, cspan.TextSpan.Length, color));
		}
		return result;
	}

	static bool IsAdditiveClassification(string classification) {
		if (ClassificationTypeNames.AdditiveTypeNames.Contains(classification))
			return true;

		// The regex and JSON classifiers color the inside of a string a second time; the string's own span
		// already carries its color.
		return classification.StartsWith("regex - ", StringComparison.Ordinal) ||
			   classification.StartsWith("json - ", StringComparison.Ordinal) ||
			   classification == ClassificationTypeNames.StringEscapeCharacter;
	}

	static ISymbol? GetSymbol(TextSpan span, SyntaxNode syntaxRoot, SemanticModel semanticModel, CancellationToken cancellationToken) {
		var node = syntaxRoot.FindNode(span, findInsideTrivia: true, getInnermostNodeForTie: true);
		var symInfo = semanticModel.GetSymbolInfo(node, cancellationToken);
		return symInfo.Symbol ?? symInfo.CandidateSymbols.FirstOrDefault() ??
			semanticModel.GetDeclaredSymbol(node, cancellationToken);
	}

	/// <summary>The color of the symbol a name binds to — dnSpy's <c>GetClassificationType2</c>.</summary>
	static string? GetSymbolColor(TextSpan span, SyntaxNode syntaxRoot, SemanticModel semanticModel, CancellationToken cancellationToken) {
		var symbol = GetSymbol(span, syntaxRoot, semanticModel, cancellationToken);
		while (symbol is not null) {
			switch (symbol.Kind) {
			case SymbolKind.Alias:
				return TextColors.Namespace;

			case SymbolKind.Event:
				return symbol.IsStatic ? TextColors.StaticEvent : TextColors.InstanceEvent;

			case SymbolKind.Field:
				var field = (IFieldSymbol)symbol;
				// A script's top-level variables are fields of the script class; dnSpy shows them as locals.
				if (field.ContainingType?.IsScriptClass == true)
					return TextColors.Local;
				if (field.ContainingType?.TypeKind == TypeKind.Enum)
					return TextColors.EnumField;
				if (field.IsConst)
					return TextColors.LiteralField;
				if (field.IsStatic)
					return TextColors.StaticField;
				return TextColors.InstanceField;

			case SymbolKind.Label:
				return TextColors.Label;

			case SymbolKind.Local:
			case SymbolKind.RangeVariable:
				return TextColors.Local;

			case SymbolKind.Method:
				var method = (IMethodSymbol)symbol;
				switch (method.MethodKind) {
				case MethodKind.Constructor:
				case MethodKind.Destructor:
				case MethodKind.StaticConstructor:
					// A constructor is named after its type, and dnSpy writes the name in the type's color.
					symbol = method.ContainingType;
					continue;
				case MethodKind.ReducedExtension:
					return TextColors.ExtensionMethod;
				default:
					if (method.IsExtensionMethod)
						return TextColors.ExtensionMethod;
					return method.IsStatic ? TextColors.StaticMethod : TextColors.InstanceMethod;
				}

			case SymbolKind.NamedType:
				return GetTypeColor((INamedTypeSymbol)symbol);

			case SymbolKind.Namespace:
				return TextColors.Namespace;

			case SymbolKind.Parameter:
				return TextColors.Parameter;

			case SymbolKind.Property:
				return symbol.IsStatic ? TextColors.StaticProperty : TextColors.InstanceProperty;

			case SymbolKind.TypeParameter:
				return ((ITypeParameterSymbol)symbol).DeclaringMethod is not null ? TextColors.MethodGenericParameter : TextColors.TypeGenericParameter;

			default:
				// Arrays, pointers, dynamic, error types, discards, assemblies, modules and preprocessing
				// symbols have no color of their own.
				return null;
			}
		}
		return null;
	}

	static string? GetTypeColor(INamedTypeSymbol type) {
		switch (type.TypeKind) {
		case TypeKind.Class:
			if (type.IsStatic)
				return TextColors.StaticType;
			if (type.IsSealed)
				return TextColors.SealedType;
			return TextColors.Type;
		case TypeKind.Delegate:
			return TextColors.Delegate;
		case TypeKind.Enum:
			return TextColors.Enum;
		case TypeKind.Interface:
			return TextColors.Interface;
		case TypeKind.Struct:
			return TextColors.ValueType;
		default:
			return null;
		}
	}

	/// <summary>A class name's color: dnSpy tells static and sealed classes apart from the rest.</summary>
	static string GetClassColor(TextSpan span, SyntaxNode syntaxRoot, SemanticModel semanticModel, CancellationToken cancellationToken) {
		var symbol = GetSymbol(span, syntaxRoot, semanticModel, cancellationToken);
		if (symbol?.IsStatic == true)
			return TextColors.StaticType;
		if (symbol?.IsSealed == true)
			return TextColors.SealedType;
		return TextColors.Type;
	}

	/// <summary>dnSpy's <c>GetClassificationType</c>: Roslyn's name for a span, turned into dnSpy's color.</summary>
	static string? GetColor(ClassifiedSpan cspan, SyntaxNode syntaxRoot, SemanticModel semanticModel, CancellationToken cancellationToken) {
		switch (cspan.ClassificationType) {
		case ClassificationTypeNames.FieldName:
		case ClassificationTypeNames.PropertyName:
		case ClassificationTypeNames.EventName:
		case ClassificationTypeNames.MethodName:
		case ClassificationTypeNames.Identifier:
			return GetSymbolColor(cspan.TextSpan, syntaxRoot, semanticModel, cancellationToken);

		case ClassificationTypeNames.ConstantName:
			return TextColors.LiteralField;
		case ClassificationTypeNames.EnumMemberName:
			return TextColors.EnumField;
		case ClassificationTypeNames.LocalName:
			return TextColors.Local;
		case ClassificationTypeNames.ParameterName:
			return TextColors.Parameter;
		case ClassificationTypeNames.ExtensionMethodName:
			return TextColors.ExtensionMethod;

		case ClassificationTypeNames.ClassName:
		// Records postdate dnSpy's classifier, which leaves them uncolored; its tagged-text colors (TextTagsHelper)
		// treat a record as a class and a record struct as a struct, and so does this.
		case ClassificationTypeNames.RecordClassName:
			return GetClassColor(cspan.TextSpan, syntaxRoot, semanticModel, cancellationToken);
		case ClassificationTypeNames.RecordStructName:
		case ClassificationTypeNames.StructName:
			return TextColors.ValueType;

		case ClassificationTypeNames.Comment:
			return TextColors.Comment;
		case ClassificationTypeNames.DelegateName:
			return TextColors.Delegate;
		case ClassificationTypeNames.EnumName:
			return TextColors.Enum;
		case ClassificationTypeNames.ExcludedCode:
			return TextColors.ExcludedCode;
		case ClassificationTypeNames.InterfaceName:
			return TextColors.Interface;
		case ClassificationTypeNames.Keyword:
		case ClassificationTypeNames.ControlKeyword:
			return TextColors.Keyword;
		case ClassificationTypeNames.LabelName:
			return TextColors.Label;
		case ClassificationTypeNames.ModuleName:
			return TextColors.Module;
		case ClassificationTypeNames.NamespaceName:
			return TextColors.Namespace;
		case ClassificationTypeNames.NumericLiteral:
			return TextColors.Number;
		case ClassificationTypeNames.Operator:
		case ClassificationTypeNames.OperatorOverloaded:
			return TextColors.Operator;
		case ClassificationTypeNames.PreprocessorKeyword:
			return TextColors.PreprocessorKeyword;
		case ClassificationTypeNames.PreprocessorText:
			return TextColors.PreprocessorText;
		case ClassificationTypeNames.Punctuation:
			return TextColors.Punctuation;
		case ClassificationTypeNames.StringLiteral:
			return TextColors.String;
		case ClassificationTypeNames.VerbatimStringLiteral:
			return TextColors.VerbatimString;
		case ClassificationTypeNames.Text:
		case ClassificationTypeNames.WhiteSpace:
			return TextColors.Text;

		case ClassificationTypeNames.TypeParameterName:
			return GetSymbolColor(cspan.TextSpan, syntaxRoot, semanticModel, cancellationToken) ?? TextColors.TypeGenericParameter;

		case ClassificationTypeNames.XmlDocCommentAttributeName:
			return TextColors.XmlDocCommentAttributeName;
		case ClassificationTypeNames.XmlDocCommentAttributeQuotes:
			return TextColors.XmlDocCommentAttributeQuotes;
		case ClassificationTypeNames.XmlDocCommentAttributeValue:
			return TextColors.XmlDocCommentAttributeValue;
		case ClassificationTypeNames.XmlDocCommentCDataSection:
			return TextColors.XmlDocCommentCDataSection;
		case ClassificationTypeNames.XmlDocCommentComment:
			return TextColors.XmlDocCommentComment;
		case ClassificationTypeNames.XmlDocCommentDelimiter:
			return TextColors.XmlDocCommentDelimiter;
		case ClassificationTypeNames.XmlDocCommentEntityReference:
			return TextColors.XmlDocCommentEntityReference;
		case ClassificationTypeNames.XmlDocCommentName:
			return TextColors.XmlDocCommentName;
		case ClassificationTypeNames.XmlDocCommentProcessingInstruction:
			return TextColors.XmlDocCommentProcessingInstruction;
		case ClassificationTypeNames.XmlDocCommentText:
			return TextColors.XmlDocCommentText;

		default:
			// dnSpy's VB-only XML literal names never reach a C# classifier.
			return null;
		}
	}
}
