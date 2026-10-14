using dnSpy.Backend.Contracts;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace dnSpy.Backend.Core.LanguageService;

/// <summary>
/// Signature help for C# — what dnSpy reaches through Roslyn's internal <c>SignatureHelpService</c>
/// (<c>dnSpy.Roslyn.Internal/SignatureHelp</c>), which this Roslyn does not make public. It covers the same
/// providers: invocations, object creation (with and without a type), constructor initializers, primary
/// constructor base types, element access, attributes and generic names, built on the semantic model.
/// </summary>
static class SignatureHelpProvider {
	static readonly SymbolDisplayFormat typeFormat = SymbolDisplayFormat.MinimallyQualifiedFormat;

	static readonly SymbolDisplayFormat memberFormat = SymbolDisplayFormat.MinimallyQualifiedFormat
		.WithMemberOptions(SymbolDisplayMemberOptions.IncludeType | SymbolDisplayMemberOptions.IncludeContainingType | SymbolDisplayMemberOptions.IncludeRef | SymbolDisplayMemberOptions.IncludeExplicitInterface)
		.WithParameterOptions(SymbolDisplayParameterOptions.None);

	static readonly SymbolDisplayFormat parameterFormat = SymbolDisplayFormat.MinimallyQualifiedFormat
		.WithParameterOptions(SymbolDisplayParameterOptions.IncludeType | SymbolDisplayParameterOptions.IncludeName |
			SymbolDisplayParameterOptions.IncludeParamsRefOut | SymbolDisplayParameterOptions.IncludeDefaultValue | SymbolDisplayParameterOptions.IncludeModifiers);

	/// <summary>What one kind of argument list asks for: its symbols, and how to write them.</summary>
	sealed record ListInfo(SyntaxNode Owner, SyntaxToken Open, SyntaxToken Close, SeparatedSyntaxList<SyntaxNode> Arguments, IReadOnlyList<ISymbol> Symbols, ISymbol? Selected, bool TypeArguments = false);

	public static async Task<CodeSignatureHelpDto?> GetAsync(Document document, int position, string? triggerCharacter, CancellationToken cancellationToken) {
		var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
		var semanticModel = await document.GetSemanticModelAsync(cancellationToken).ConfigureAwait(false);
		if (root is null || semanticModel is null)
			return null;
		return Get(root, semanticModel, position, triggerCharacter, cancellationToken);
	}

	public static CodeSignatureHelpDto? Get(SyntaxNode root, SemanticModel semanticModel, int position, string? triggerCharacter, CancellationToken cancellationToken) {
		// The caret right after '(' sits at the start of the next token, which may lie outside the list.
		var token = root.FindToken(Math.Max(0, position - 1));
		for (var node = token.Parent; node is not null; node = node.Parent) {
			// A lambda or a statement inside an argument list starts a context of its own.
			if (node is StatementSyntax or MemberDeclarationSyntax or AnonymousFunctionExpressionSyntax && node.Parent is not GlobalStatementSyntax)
				break;
			var info = GetListInfo(node, semanticModel, position, cancellationToken);
			if (info is null)
				continue;
			if (triggerCharacter is "(" or "[" or "<" && info.Open.Span.End != position && info.Arguments.Count > 0)
				continue;
			return Create(info, semanticModel, position);
		}
		return null;
	}

	static bool IsInside(SyntaxToken open, SyntaxToken close, int position) =>
		!open.IsMissing && position >= open.Span.End && (close.IsMissing || position <= close.SpanStart);

	static ListInfo? GetListInfo(SyntaxNode node, SemanticModel model, int position, CancellationToken ct) {
		switch (node) {
		case ArgumentListSyntax list when IsInside(list.OpenParenToken, list.CloseParenToken, position):
			return list.Parent switch {
				InvocationExpressionSyntax invocation => Invocation(invocation, list, model, position, ct),
				BaseObjectCreationExpressionSyntax creation => Constructors(creation, list, model.GetTypeInfo(creation, ct).Type, model.GetSymbolInfo(creation, ct), model, position),
				ConstructorInitializerSyntax initializer => Constructors(initializer, list, GetInitializedType(initializer, model, ct), model.GetSymbolInfo(initializer, ct), model, position),
				PrimaryConstructorBaseTypeSyntax baseType => Constructors(baseType, list, model.GetTypeInfo(baseType.Type, ct).Type, model.GetSymbolInfo(baseType, ct), model, position),
				_ => null,
			};
		case BracketedArgumentListSyntax list when list.Parent is ElementAccessExpressionSyntax access && IsInside(list.OpenBracketToken, list.CloseBracketToken, position): {
			var indexers = model.GetIndexerGroup(access.Expression, ct).Where(p => model.IsAccessible(position, p)).Cast<ISymbol>().ToArray();
			if (indexers.Length == 0)
				return null;
			var info = model.GetSymbolInfo(access, ct);
			return new ListInfo(access, list.OpenBracketToken, list.CloseBracketToken, list.Arguments.ToSeparatedNodes(), indexers, info.Symbol ?? info.CandidateSymbols.FirstOrDefault());
		}
		case AttributeArgumentListSyntax list when list.Parent is AttributeSyntax attribute && IsInside(list.OpenParenToken, list.CloseParenToken, position): {
			var type = model.GetTypeInfo(attribute, ct).Type as INamedTypeSymbol;
			if (type is null || type.TypeKind == TypeKind.Error)
				return null;
			var constructors = type.InstanceConstructors.Where(c => model.IsAccessible(position, c)).Cast<ISymbol>().ToArray();
			var info = model.GetSymbolInfo(attribute, ct);
			return new ListInfo(attribute, list.OpenParenToken, list.CloseParenToken, list.Arguments.ToSeparatedNodes(), constructors, info.Symbol ?? info.CandidateSymbols.FirstOrDefault());
		}
		case TypeArgumentListSyntax list when list.Parent is GenericNameSyntax name && IsInside(list.LessThanToken, list.GreaterThanToken, position): {
			var arity = list.Arguments.Count;
			var symbols = model.LookupSymbols(name.SpanStart, name: name.Identifier.ValueText)
				.Where(s => s is INamedTypeSymbol { Arity: > 0 } or IMethodSymbol { Arity: > 0 })
				.Where(s => model.IsAccessible(position, s))
				.ToArray();
			if (symbols.Length == 0)
				return null;
			var info = model.GetSymbolInfo(name, ct);
			var selected = info.Symbol ?? info.CandidateSymbols.FirstOrDefault() ?? symbols.FirstOrDefault(s => GetTypeParameters(s).Length == arity);
			return new ListInfo(name, list.LessThanToken, list.GreaterThanToken, list.Arguments.ToSeparatedNodes(), symbols, selected, TypeArguments: true);
		}
		default:
			return null;
		}
	}

	static SeparatedSyntaxList<SyntaxNode> ToSeparatedNodes<T>(this SeparatedSyntaxList<T> list) where T : SyntaxNode =>
		SyntaxFactory.SeparatedList<SyntaxNode>(list.GetWithSeparators());

	static ListInfo? Invocation(InvocationExpressionSyntax invocation, ArgumentListSyntax list, SemanticModel model, int position, CancellationToken ct) {
		var symbols = model.GetMemberGroup(invocation.Expression, ct)
			.OfType<IMethodSymbol>()
			.Where(m => model.IsAccessible(position, m))
			.Cast<ISymbol>()
			.ToList();
		if (symbols.Count == 0) {
			// Calling a delegate: its Invoke method is the one signature there is.
			if (model.GetTypeInfo(invocation.Expression, ct).Type is INamedTypeSymbol { TypeKind: TypeKind.Delegate, DelegateInvokeMethod: { } invoke })
				symbols.Add(invoke);
			else
				return null;
		}
		var info = model.GetSymbolInfo(invocation, ct);
		return new ListInfo(invocation, list.OpenParenToken, list.CloseParenToken, list.Arguments.ToSeparatedNodes(), symbols, info.Symbol ?? info.CandidateSymbols.FirstOrDefault());
	}

	static ITypeSymbol? GetInitializedType(ConstructorInitializerSyntax initializer, SemanticModel model, CancellationToken ct) {
		if (initializer.Parent is not ConstructorDeclarationSyntax constructor || model.GetDeclaredSymbol(constructor, ct) is not { } symbol)
			return null;
		return initializer.IsKind(SyntaxKind.BaseConstructorInitializer) ? symbol.ContainingType.BaseType : symbol.ContainingType;
	}

	static ListInfo? Constructors(SyntaxNode owner, ArgumentListSyntax list, ITypeSymbol? type, SymbolInfo info, SemanticModel model, int position) {
		if (type is not INamedTypeSymbol named || named.TypeKind == TypeKind.Error)
			return null;
		List<ISymbol> symbols;
		if (named.TypeKind == TypeKind.Delegate && named.DelegateInvokeMethod is { } invoke)
			symbols = [invoke];
		else
			symbols = named.InstanceConstructors
				.Where(c => model.IsAccessible(position, c) && !(c.IsImplicitlyDeclared && c.Parameters.Length == 0 && named.IsValueType && named.InstanceConstructors.Length > 1))
				.Cast<ISymbol>()
				.ToList();
		if (symbols.Count == 0)
			return null;
		return new ListInfo(owner, list.OpenParenToken, list.CloseParenToken, list.Arguments.ToSeparatedNodes(), symbols, info.Symbol ?? info.CandidateSymbols.FirstOrDefault());
	}

	static CodeSignatureHelpDto Create(ListInfo info, SemanticModel model, int position) {
		var separators = info.Arguments.SeparatorCount;
		var argumentIndex = 0;
		for (var i = 0; i < separators; i++) {
			if (info.Arguments.GetSeparator(i).SpanStart < position)
				argumentIndex++;
		}
		var argumentCount = info.Arguments.Count == 0 ? 0 : separators + 1;
		string? argumentName = null;
		if (argumentIndex < info.Arguments.Count) {
			argumentName = info.Arguments[argumentIndex] switch {
				ArgumentSyntax { NameColon: { } nameColon } => nameColon.Name.Identifier.ValueText,
				AttributeArgumentSyntax { NameColon: { } nameColon } => nameColon.Name.Identifier.ValueText,
				_ => null,
			};
		}

		// Roslyn lists the overloads by their number of parameters, then as they read.
		var symbols = info.Symbols
			.Distinct(SymbolEqualityComparer.Default)
			.OrderBy(s => info.TypeArguments ? GetTypeParameters(s).Length : GetParameters(s).Count)
			.ThenBy(s => s.ToDisplayString(typeFormat), StringComparer.Ordinal)
			.ToArray();
		var items = symbols.Select(s => info.TypeArguments ? CreateTypeArgumentItem(s, model, position) : CreateItem(s, model, position)).ToArray();

		var selected = Array.FindIndex(symbols, s => Matches(s, info.Selected));
		if (selected < 0) {
			// Nothing binds yet: the first overload with room for the arguments typed so far (or the one named).
			selected = Array.FindIndex(symbols, s => {
				var count = info.TypeArguments ? GetTypeParameters(s).Length : GetParameters(s).Count;
				if (argumentName is not null && !info.TypeArguments)
					return GetParameters(s).Any(p => p.Name == argumentName);
				return count >= argumentCount || IsVariadic(s);
			});
			if (selected < 0)
				selected = 0;
		}

		var close = info.Close.IsMissing ? info.Owner.Span.End : info.Close.SpanStart;
		var span = TextSpan.FromBounds(info.Open.Span.End, Math.Max(info.Open.Span.End, close));
		return new CodeSignatureHelpDto(new CodeSpanDto(span.Start, span.Length), argumentIndex, argumentCount, argumentName, selected, items);
	}

	static bool Matches(ISymbol candidate, ISymbol? selected) {
		if (selected is null)
			return false;
		if (SymbolEqualityComparer.Default.Equals(candidate, selected))
			return true;
		// A constructed generic method (or a reduced extension) binds to a different symbol than the group lists.
		var a = candidate is IMethodSymbol m1 ? (ISymbol?)m1.ReducedFrom ?? m1.OriginalDefinition : candidate.OriginalDefinition;
		var b = selected is IMethodSymbol m2 ? (ISymbol?)m2.ReducedFrom ?? m2.OriginalDefinition : selected.OriginalDefinition;
		return SymbolEqualityComparer.Default.Equals(a, b) || SymbolEqualityComparer.Default.Equals(candidate.OriginalDefinition, selected.OriginalDefinition);
	}

	static IReadOnlyList<IParameterSymbol> GetParameters(ISymbol symbol) => symbol switch {
		IMethodSymbol method => method.Parameters,
		IPropertySymbol property => property.Parameters,
		_ => [],
	};

	static System.Collections.Immutable.ImmutableArray<ITypeParameterSymbol> GetTypeParameters(ISymbol symbol) => symbol switch {
		INamedTypeSymbol type => type.TypeParameters,
		IMethodSymbol method => method.TypeParameters,
		_ => [],
	};

	static bool IsVariadic(ISymbol symbol) => GetParameters(symbol) is { Count: > 0 } parameters && parameters[^1].IsParams;

	static CodeSignatureDto CreateItem(ISymbol symbol, SemanticModel model, int position) {
		var prefix = new List<TextPartDto>();
		var suffix = new List<TextPartDto>();
		var method = symbol as IMethodSymbol;
		if (method is { MethodKind: MethodKind.Constructor }) {
			RoslynTextParts.Add(prefix, method.ContainingType.ToMinimalDisplayParts(model, position, typeFormat));
			prefix.Add(new TextPartDto("(", TextColors.Punctuation));
			suffix.Add(new TextPartDto(")", TextColors.Punctuation));
		}
		else if (method is { MethodKind: MethodKind.DelegateInvoke }) {
			RoslynTextParts.Add(prefix, method.ReturnType.ToMinimalDisplayParts(model, position, typeFormat));
			prefix.Add(new TextPartDto(" ", TextColors.Text));
			RoslynTextParts.Add(prefix, method.ContainingType.ToMinimalDisplayParts(model, position, typeFormat));
			prefix.Add(new TextPartDto("(", TextColors.Punctuation));
			suffix.Add(new TextPartDto(")", TextColors.Punctuation));
		}
		else if (symbol is IPropertySymbol { IsIndexer: true } indexer) {
			RoslynTextParts.Add(prefix, indexer.Type.ToMinimalDisplayParts(model, position, typeFormat));
			prefix.Add(new TextPartDto(" ", TextColors.Text));
			RoslynTextParts.Add(prefix, indexer.ContainingType.ToMinimalDisplayParts(model, position, typeFormat));
			prefix.Add(new TextPartDto("[", TextColors.Punctuation));
			suffix.Add(new TextPartDto("]", TextColors.Punctuation));
		}
		else {
			if (method is { ReducedFrom: not null } or { IsExtensionMethod: true }) {
				prefix.Add(new TextPartDto("(", TextColors.Punctuation));
				prefix.Add(new TextPartDto("extension", TextColors.Text));
				prefix.Add(new TextPartDto(")", TextColors.Punctuation));
				prefix.Add(new TextPartDto(" ", TextColors.Text));
			}
			RoslynTextParts.Add(prefix, symbol.ToMinimalDisplayParts(model, position, memberFormat));
			prefix.Add(new TextPartDto("(", TextColors.Punctuation));
			suffix.Add(new TextPartDto(")", TextColors.Punctuation));
		}

		var docs = GetDocumentationXml(symbol);
		var parameters = GetParameters(symbol).Select(p => new CodeSignatureParameterDto(
			p.Name,
			RoslynTextParts.ToParts(p.ToMinimalDisplayParts(model, position, parameterFormat)),
			DocumentationText.Parameter(docs, p.Name),
			p.IsOptional || p.IsParams)).ToArray();
		return new CodeSignatureDto(prefix, Separator, suffix, parameters, DocumentationText.Summary(docs), IsVariadic(symbol));
	}

	static CodeSignatureDto CreateTypeArgumentItem(ISymbol symbol, SemanticModel model, int position) {
		var prefix = new List<TextPartDto>();
		if (symbol is IMethodSymbol method) {
			RoslynTextParts.Add(prefix, method.ReturnType.ToMinimalDisplayParts(model, position, typeFormat));
			prefix.Add(new TextPartDto(" ", TextColors.Text));
			RoslynTextParts.Add(prefix, method.ContainingType.ToMinimalDisplayParts(model, position, typeFormat));
			prefix.Add(new TextPartDto(".", TextColors.Operator));
			prefix.Add(new TextPartDto(method.Name, method.IsExtensionMethod ? TextColors.ExtensionMethod : TextColors.InstanceMethod));
		}
		else {
			var type = (INamedTypeSymbol)symbol;
			if (type.ContainingType is { } containing) {
				RoslynTextParts.Add(prefix, containing.ToMinimalDisplayParts(model, position, typeFormat));
				prefix.Add(new TextPartDto(".", TextColors.Operator));
			}
			prefix.Add(new TextPartDto(type.Name, GetTypeColor(type)));
		}
		prefix.Add(new TextPartDto("<", TextColors.Punctuation));
		var docs = GetDocumentationXml(symbol);
		var typeParameters = GetTypeParameters(symbol).Select(t => new CodeSignatureParameterDto(
			t.Name,
			[new TextPartDto(t.Name, symbol is IMethodSymbol ? TextColors.MethodGenericParameter : TextColors.TypeGenericParameter)],
			DocumentationText.TypeParameter(docs, t.Name),
			false)).ToArray();
		return new CodeSignatureDto(prefix, Separator, [new TextPartDto(">", TextColors.Punctuation)], typeParameters, DocumentationText.Summary(docs), false);
	}

	static string GetTypeColor(INamedTypeSymbol type) => type.TypeKind switch {
		TypeKind.Interface => TextColors.Interface,
		TypeKind.Struct => TextColors.ValueType,
		TypeKind.Delegate => TextColors.Delegate,
		TypeKind.Enum => TextColors.Enum,
		_ => type.IsStatic ? TextColors.StaticType : type.IsSealed ? TextColors.SealedType : TextColors.Type,
	};

	static readonly IReadOnlyList<TextPartDto> Separator = [new TextPartDto(",", TextColors.Punctuation), new TextPartDto(" ", TextColors.Text)];

	static string? GetDocumentationXml(ISymbol symbol) {
		// A reduced extension method and a constructed generic keep their documentation on the definition.
		var definition = symbol is IMethodSymbol { ReducedFrom: { } reducedFrom } ? reducedFrom : symbol.OriginalDefinition;
		var xml = definition.GetDocumentationCommentXml(expandIncludes: true);
		return string.IsNullOrEmpty(xml) ? null : xml;
	}
}
