using System.Collections.Immutable;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Operations;
using CS = Microsoft.CodeAnalysis.CSharp.Syntax;
using VB = Microsoft.CodeAnalysis.VisualBasic.Syntax;
using VBFactory = Microsoft.CodeAnalysis.VisualBasic.SyntaxFactory;

namespace dnSpy.Backend.Debugging.CorDebug.Evaluation;

/// <summary>The language an expression is written in, which is the debugger's Language option.</summary>
public enum EvalLanguage {
	CSharp,
	VisualBasic,
}

/// <summary>Where a name the user can write reads its value from.</summary>
internal abstract record VariableSource {
	/// <summary>A local slot of the frame.</summary>
	public sealed record Local(int Index) : VariableSource;

	/// <summary>An argument slot of the frame; 0 is <c>this</c> in an instance method.</summary>
	public sealed record Argument(int Index) : VariableSource;

	/// <summary>A local the compiler hoisted into a field of the frame's own <c>this</c> (a state machine, a closure).</summary>
	public sealed record HoistedField(IFieldSymbol Field) : VariableSource;

	/// <summary>A value the debugger already has: an alias such as <c>$exception</c>, or the object a DebuggerDisplay describes.</summary>
	public sealed record Known(EvalValue Value) : VariableSource;
}

/// <summary>One name the expression can use, the type it is declared as, and where its value lives.</summary>
internal sealed record ContextVariable(string Name, ITypeSymbol Type, VariableSource Source, bool IsParameter = false);

/// <summary>
/// Everything an expression is bound against: the <c>this</c> the user sees, the variables in scope, the
/// type whose members a bare name can mean, and the generic arguments the frame was instantiated with.
/// </summary>
internal sealed class EvalContextShape {
	public INamedTypeSymbol? ContextType { get; init; }

	/// <summary>The type of the user-visible <c>this</c>, and where its value comes from; null in a static context.</summary>
	public ITypeSymbol? ThisType { get; init; }

	public VariableSource? ThisSource { get; init; }

	public IReadOnlyList<ContextVariable> Variables { get; init; } = [];

	/// <summary>Values named <c>$...</c>: <c>$exception</c>, <c>$ReturnValue</c>, object ids.</summary>
	public IReadOnlyList<ContextVariable> Aliases { get; init; } = [];

	/// <summary>Type parameter names of the frame's method and type, and what they are instantiated with.</summary>
	public IReadOnlyList<(string Name, ITypeSymbol Type)> TypeArguments { get; init; } = [];

	/// <summary>A key that is equal for two shapes an expression binds the same way against.</summary>
	public string CacheKey { get; init; } = string.Empty;
}

/// <summary>An expression bound and ready to run, or the error that stopped it binding.</summary>
internal sealed class CompiledExpression {
	public required string Text { get; init; }

	public required IReadOnlyList<string> FormatSpecifiers { get; init; }

	public IOperation? Operation { get; init; }

	public SemanticModel? Model { get; init; }

	/// <summary>The parameters of the synthesized method, by symbol, and the context names they stand for.</summary>
	public IReadOnlyDictionary<IParameterSymbol, ContextVariable> Parameters { get; init; } = new Dictionary<IParameterSymbol, ContextVariable>(SymbolEqualityComparer.Default);

	/// <summary>The parameter standing for <c>this</c>, if the context has one.</summary>
	public IParameterSymbol? ThisParameter { get; init; }

	public string? Error { get; init; }

	/// <summary>True when the expression writes something — an assignment, a call — so it is not evaluated implicitly.</summary>
	public bool HasSideEffects { get; init; }
}

/// <summary>
/// Binds what the user typed. The text is wrapped in a method whose parameters are the frame's variables and
/// <c>this</c>, compiled against the debuggee's modules (<see cref="DebuggeeTypeSystem"/>), and the bound tree
/// of the expression is what the interpreter then runs. A bare name that means a member of <c>this</c> — which
/// a static helper method cannot see — is rewritten to go through <c>this</c> and the expression bound again;
/// that is the scoping Roslyn's own expression evaluator gets by binding inside the method itself.
/// </summary>
internal sealed class ExpressionCompiler {
	const string ThisName = "__dnSpy_this";
	const string AliasPrefix = "__dnSpy_alias_";
	const string HostTypeName = "__dnSpy_Evaluator";
	const string HostMethodName = "__dnSpy_Evaluate";

	readonly DebuggeeTypeSystem types;
	readonly Dictionary<string, CompiledExpression> cache = new(StringComparer.Ordinal);
	int cacheVersion = -1;

	public ExpressionCompiler(DebuggeeTypeSystem types) => this.types = types;

	public CompiledExpression Compile(string text, EvalLanguage language, EvalContextShape shape) {
		var version = types.BuiltVersion;
		lock (cache) {
			if (version != cacheVersion) {
				cache.Clear();
				cacheVersion = version;
			}
			var key = $"{(int)language}\u0001{shape.CacheKey}\u0001{text}";
			if (cache.TryGetValue(key, out var cached))
				return cached;
			var compiled = CompileCore(text, language, shape);
			if (cache.Count > 512)
				cache.Clear();
			cache[key] = compiled;
			return compiled;
		}
	}

	CompiledExpression CompileCore(string text, EvalLanguage language, EvalContextShape shape) {
		var (expressionText, specifiers) = SplitFormatSpecifiers(text, language);
		if (string.IsNullOrWhiteSpace(expressionText))
			return new CompiledExpression { Text = text, FormatSpecifiers = specifiers, Error = "Expected expression" };
		string rewritten;
		try {
			rewritten = ReplaceAliases(expressionText, language);
		}
		catch (EvaluationException ex) {
			return new CompiledExpression { Text = text, FormatSpecifiers = specifiers, Error = ex.Message };
		}
		return language == EvalLanguage.CSharp
			? CompileCSharp(text, rewritten, specifiers, shape)
			: CompileVisualBasic(text, rewritten, specifiers, shape);
	}

	// ---------------------------------------------------------------- text preprocessing

	/// <summary>
	/// Splits <c>expr, h, nq</c> into the expression and its format specifiers. Only commas outside brackets
	/// and literals count, and only when everything after them is a list of identifiers.
	/// </summary>
	internal static (string Expression, IReadOnlyList<string> Specifiers) SplitFormatSpecifiers(string text, EvalLanguage language) {
		var depth = 0;
		var commas = new List<int>();
		for (var index = 0; index < text.Length; index++) {
			var c = text[index];
			if (c == '"' || (c == '\'' && language == EvalLanguage.CSharp)) {
				index = SkipLiteral(text, index, c, language);
				continue;
			}
			if (c is '(' or '[' or '{')
				depth++;
			else if (c is ')' or ']' or '}')
				depth--;
			else if (c == ',' && depth == 0)
				commas.Add(index);
		}
		if (commas.Count == 0)
			return (text.Trim(), []);
		var specifiers = new List<string>();
		var expressionEnd = text.Length;
		// Walk back from the last comma: every piece after a comma must look like a specifier.
		for (var position = commas.Count - 1; position >= 0; position--) {
			var piece = text.Substring(commas[position] + 1, expressionEnd - commas[position] - 1).Trim();
			if (piece.Length == 0 || !piece.All(ch => char.IsLetterOrDigit(ch) || ch == '_'))
				break;
			specifiers.Insert(0, piece);
			expressionEnd = commas[position];
		}
		return (text[..expressionEnd].Trim(), specifiers);
	}

	static int SkipLiteral(string text, int start, char quote, EvalLanguage language) {
		for (var index = start + 1; index < text.Length; index++) {
			if (language == EvalLanguage.CSharp && text[index] == '\\') {
				index++;
				continue;
			}
			if (text[index] == quote) {
				if (language == EvalLanguage.VisualBasic && index + 1 < text.Length && text[index + 1] == quote) {
					index++;
					continue;
				}
				return index;
			}
		}
		return text.Length;
	}

	/// <summary>
	/// <c>$exception</c>, <c>$ReturnValue2</c> and <c>$1</c> are not identifiers in either language, so they are
	/// renamed to ones before the text is parsed. <c>$"..."</c> — an interpolated string — is left alone.
	/// </summary>
	internal static string ReplaceAliases(string text, EvalLanguage language) {
		var builder = new StringBuilder(text.Length);
		for (var index = 0; index < text.Length; index++) {
			var c = text[index];
			if (c == '"' || (c == '\'' && language == EvalLanguage.CSharp)) {
				var end = SkipLiteral(text, index, c, language);
				builder.Append(text, index, Math.Min(end, text.Length - 1) - index + 1);
				index = end;
				continue;
			}
			if (c == '$' && index + 1 < text.Length && (char.IsLetterOrDigit(text[index + 1]) || text[index + 1] == '_')) {
				var end = index + 1;
				while (end < text.Length && (char.IsLetterOrDigit(text[end]) || text[end] == '_'))
					end++;
				builder.Append(AliasPrefix).Append(text, index + 1, end - index - 1);
				index = end - 1;
				continue;
			}
			builder.Append(c);
		}
		return builder.ToString();
	}

	/// <summary>The identifier an alias is declared as in the synthesized method.</summary>
	internal static string AliasIdentifier(string alias) => AliasPrefix + alias.TrimStart('$');

	/// <summary>The alias name a parameter stands for, for error messages.</summary>
	static string Unmangle(string message) => message.Replace(AliasPrefix, "$", StringComparison.Ordinal).Replace(ThisName, "this", StringComparison.Ordinal);

	// ---------------------------------------------------------------- types as source text

	/// <summary>
	/// Whether a type can be written in source: a compiler-generated type (a closure, a state machine, an
	/// anonymous type) cannot, and is declared <c>dynamic</c> instead so its members are looked up at run time.
	/// </summary>
	internal static bool IsSpeakable(ITypeSymbol type) => type switch {
		IArrayTypeSymbol array => IsSpeakable(array.ElementType),
		IPointerTypeSymbol pointer => IsSpeakable(pointer.PointedAtType),
		INamedTypeSymbol named => !named.IsAnonymousType
			&& (named.ContainingType is null || IsSpeakable(named.ContainingType))
			&& named.CanBeReferencedByName
			&& named.TypeArguments.All(IsSpeakable),
		ITypeParameterSymbol => false,
		IDynamicTypeSymbol => true,
		_ => type.TypeKind != TypeKind.Error,
	};

	static readonly SymbolDisplayFormat CSharpTypeFormat = SymbolDisplayFormat.FullyQualifiedFormat
		.WithMiscellaneousOptions(SymbolDisplayMiscellaneousOptions.EscapeKeywordIdentifiers | SymbolDisplayMiscellaneousOptions.UseSpecialTypes);

	static readonly SymbolDisplayFormat VisualBasicTypeFormat = new(
		globalNamespaceStyle: SymbolDisplayGlobalNamespaceStyle.Included,
		typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameAndContainingTypesAndNamespaces,
		genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters,
		miscellaneousOptions: SymbolDisplayMiscellaneousOptions.EscapeKeywordIdentifiers | SymbolDisplayMiscellaneousOptions.UseSpecialTypes);

	static string TypeText(ITypeSymbol type, EvalLanguage language) {
		if (!IsSpeakable(type))
			return language == EvalLanguage.CSharp ? "dynamic" : "Object";
		return language == EvalLanguage.CSharp ? type.ToDisplayString(CSharpTypeFormat) : Microsoft.CodeAnalysis.VisualBasic.SymbolDisplay.ToDisplayString(type, VisualBasicTypeFormat);
	}

	static string EscapeCSharp(string name) => SyntaxFacts.GetKeywordKind(name) != SyntaxKind.None
		? "@" + name
		: name;

	static string EscapeVisualBasic(string name) => Microsoft.CodeAnalysis.VisualBasic.SyntaxFacts.GetKeywordKind(name) != Microsoft.CodeAnalysis.VisualBasic.SyntaxKind.None
		? "[" + name + "]"
		: name;

	static bool IsValidIdentifier(string name, EvalLanguage language) => language == EvalLanguage.CSharp
		? SyntaxFacts.IsValidIdentifier(name)
		: Microsoft.CodeAnalysis.VisualBasic.SyntaxFacts.IsValidIdentifier(name);

	// ---------------------------------------------------------------- C#

	CompiledExpression CompileCSharp(string originalText, string text, IReadOnlyList<string> specifiers, EvalContextShape shape) {
		var parsedExpression = SyntaxFactory.ParseExpression(text, options: new CSharpParseOptions(LanguageVersion.Latest));
		var parseErrors = parsedExpression.GetDiagnostics().Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error).ToArray();
		if (parseErrors.Length > 0 || parsedExpression.FullSpan.Length < text.Length)
			return Failed(originalText, specifiers, parseErrors.Length > 0 ? Unmangle(parseErrors[0].GetMessage()) : "Invalid expression");
		CS.ExpressionSyntax expression = parsedExpression;
		expression = (CS.ExpressionSyntax)new CSharpThisRewriter().Visit(expression)!;
		for (var pass = 0; pass < 3; pass++) {
			var (tree, root) = BuildCSharpTree(expression, shape);
			var compilation = types.CSharp.AddSyntaxTrees(tree);
			var model = compilation.GetSemanticModel(tree);
			var body = root.DescendantNodes().OfType<CS.MethodDeclarationSyntax>().First().Body!;
			var statement = (CS.ExpressionStatementSyntax)body.Statements[0];
			var diagnostics = model.GetDiagnostics(statement.Span).Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error && !IgnoredCSharpErrors.Contains(diagnostic.Id)).ToArray();
			if (diagnostics.Length > 0) {
				var rewrite = TryRewriteUnboundNames(expression, statement.Expression, model, shape);
				if (rewrite is not null && pass < 2) {
					expression = rewrite;
					continue;
				}
				return Failed(originalText, specifiers, Unmangle(diagnostics[0].GetMessage()));
			}
			var operation = model.GetOperation(statement.Expression);
			if (operation is null)
				return Failed(originalText, specifiers, "The expression could not be bound.");
			return Bound(originalText, specifiers, model, operation, root.DescendantNodes().OfType<CS.MethodDeclarationSyntax>().First(), shape);
		}
		return Failed(originalText, specifiers, "The expression could not be bound.");
	}

	/// <summary>
	/// Errors that are about the synthesized statement rather than the expression: a value used as a statement
	/// is fine, it is the value the user wants.
	/// </summary>
	static readonly HashSet<string> IgnoredCSharpErrors = new(StringComparer.Ordinal) {
		"CS0201",
	};

	/// <summary><c>this</c> and <c>base</c> become the parameter that stands for the frame's <c>this</c>.</summary>
	sealed class CSharpThisRewriter : CSharpSyntaxRewriter {
		public override SyntaxNode? VisitThisExpression(CS.ThisExpressionSyntax node) =>
			SyntaxFactory.IdentifierName(ThisName).WithTriviaFrom(node);

		public override SyntaxNode? VisitBaseExpression(CS.BaseExpressionSyntax node) =>
			SyntaxFactory.IdentifierName(ThisName).WithTriviaFrom(node);
	}

	(SyntaxTree Tree, SyntaxNode Root) BuildCSharpTree(CS.ExpressionSyntax expression, EvalContextShape shape) {
		var builder = new StringBuilder();
		builder.Append("#nullable disable\n#pragma warning disable\nstatic class ").Append(HostTypeName).Append(" {\n\tstatic unsafe void ").Append(HostMethodName).Append('(');
		var parameters = new List<string>();
		if (shape.ThisType is not null)
			parameters.Add($"{TypeText(shape.ThisType, EvalLanguage.CSharp)} {ThisName}");
		foreach (var variable in shape.Variables.Concat(shape.Aliases)) {
			var name = variable.Name.StartsWith('$') ? AliasIdentifier(variable.Name) : variable.Name;
			if (!IsValidIdentifier(name, EvalLanguage.CSharp))
				continue;
			parameters.Add($"{TypeText(variable.Type, EvalLanguage.CSharp)} {EscapeCSharp(name)}");
		}
		builder.Append(string.Join(", ", parameters)).Append(") {\n\t\t");
		var prefix = builder.Length;
		builder.Append(expression.ToFullString()).Append(";\n\t}\n}\n");
		var tree = CSharpSyntaxTree.ParseText(builder.ToString(), new CSharpParseOptions(LanguageVersion.Latest));
		_ = prefix;
		return (tree, tree.GetRoot());
	}

	/// <summary>
	/// The names the first binding could not find, rewritten to what they mean in the frame: a member of the
	/// frame's <c>this</c>, a static member of the frame's type or one it is nested in, a type parameter of the
	/// frame. Returns null when there is nothing to rewrite, which leaves the binding error as the answer.
	/// </summary>
	CS.ExpressionSyntax? TryRewriteUnboundNames(CS.ExpressionSyntax original, CS.ExpressionSyntax bound, SemanticModel model, EvalContextShape shape) {
		var replacements = new Dictionary<int, CS.ExpressionSyntax>();
		var boundNames = bound.DescendantNodesAndSelf().OfType<CS.SimpleNameSyntax>().ToArray();
		var originalNames = original.DescendantNodesAndSelf().OfType<CS.SimpleNameSyntax>().ToArray();
		if (boundNames.Length != originalNames.Length)
			return null;
		for (var index = 0; index < boundNames.Length; index++) {
			var name = boundNames[index];
			// Only a name that stands on its own: the right side of a member access is the member's name.
			if (name.Parent is CS.MemberAccessExpressionSyntax access && access.Name == name)
				continue;
			if (name.Parent is CS.QualifiedNameSyntax qualified && qualified.Right == name)
				continue;
			var info = model.GetSymbolInfo(name);
			if (info.Symbol is not null || info.CandidateSymbols.Length > 0)
				continue;
			if (model.GetTypeInfo(name).Type is { TypeKind: not TypeKind.Error })
				continue;
			var identifier = name.Identifier.ValueText;
			var replacement = ResolveImplicitName(identifier, name, shape);
			if (replacement is not null)
				replacements[originalNames[index].SpanStart] = replacement;
		}
		if (replacements.Count == 0)
			return null;
		return original.ReplaceNodes(
			originalNames.Where(name => replacements.ContainsKey(name.SpanStart)),
			(node, _) => {
				var replacement = replacements[node.SpanStart];
				if (node is CS.GenericNameSyntax generic && replacement is CS.MemberAccessExpressionSyntax memberAccess)
					return memberAccess.WithName(generic).WithTriviaFrom(node);
				return replacement.WithTriviaFrom(node);
			});
	}

	CS.ExpressionSyntax? ResolveImplicitName(string identifier, CS.SimpleNameSyntax name, EvalContextShape shape) {
		foreach (var (typeParameter, type) in shape.TypeArguments) {
			if (typeParameter == identifier && name is CS.IdentifierNameSyntax)
				return SyntaxFactory.ParseTypeName(TypeText(type, EvalLanguage.CSharp));
		}
		// The frame's own type and its bases: an instance member through this, a static one through the type.
		if (shape.ThisType is INamedTypeSymbol thisType && FindMember(thisType, identifier) is { } instanceMember) {
			if (!instanceMember.IsStatic)
				return SyntaxFactory.MemberAccessExpression(SyntaxKind.SimpleMemberAccessExpression, SyntaxFactory.IdentifierName(ThisName), SyntaxFactory.IdentifierName(identifier));
			return StaticAccess(instanceMember.ContainingType, identifier);
		}
		for (var type = shape.ContextType; type is not null; type = type.ContainingType) {
			var member = FindMember(type, identifier);
			if (member is null)
				continue;
			if (member.IsStatic || member is INamedTypeSymbol)
				return StaticAccess(member.ContainingType, identifier);
		}
		return null;
	}

	CS.ExpressionSyntax? StaticAccess(INamedTypeSymbol type, string identifier) {
		if (!IsSpeakable(type))
			return null;
		return SyntaxFactory.MemberAccessExpression(SyntaxKind.SimpleMemberAccessExpression, SyntaxFactory.ParseExpression(TypeText(type, EvalLanguage.CSharp)), SyntaxFactory.IdentifierName(identifier));
	}

	static ISymbol? FindMember(INamedTypeSymbol type, string name) {
		for (ITypeSymbol? current = type; current is not null; current = current.BaseType) {
			var member = current.GetMembers(name).FirstOrDefault(symbol => symbol.CanBeReferencedByName && symbol is IFieldSymbol or IPropertySymbol or IMethodSymbol or IEventSymbol or INamedTypeSymbol);
			if (member is not null)
				return member;
		}
		return null;
	}

	// ---------------------------------------------------------------- Visual Basic

	CompiledExpression CompileVisualBasic(string originalText, string text, IReadOnlyList<string> specifiers, EvalContextShape shape) {
		var parsedExpression = VBFactory.ParseExpression(text);
		var parseErrors = parsedExpression.GetDiagnostics().Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error).ToArray();
		if (parseErrors.Length > 0 || parsedExpression.FullSpan.Length < text.Length)
			return Failed(originalText, specifiers, parseErrors.Length > 0 ? Unmangle(parseErrors[0].GetMessage()) : "Invalid expression");
		VB.ExpressionSyntax expression = (VB.ExpressionSyntax)new VisualBasicThisRewriter().Visit(parsedExpression)!;
		for (var pass = 0; pass < 3; pass++) {
			var tree = BuildVisualBasicTree(expression, shape);
			var compilation = types.VisualBasic.AddSyntaxTrees(tree);
			var model = compilation.GetSemanticModel(tree);
			var root = tree.GetRoot();
			var method = root.DescendantNodes().OfType<VB.MethodBlockSyntax>().First();
			var declarator = method.DescendantNodes().OfType<VB.VariableDeclaratorSyntax>().First();
			var value = declarator.Initializer!.Value;
			var diagnostics = model.GetDiagnostics(value.Span).Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error && !IgnoredVisualBasicErrors.Contains(diagnostic.Id)).ToArray();
			// Visual Basic has no switch to ignore accessibility; an inaccessible member still binds to its
			// candidate, which the interpreter reads anyway, so that error is not one that stops evaluation.
			var blocking = diagnostics.Where(diagnostic => diagnostic.Id is not ("BC30390" or "BC31429" or "BC30389")).ToArray();
			if (blocking.Length > 0) {
				var rewrite = TryRewriteUnboundNamesVisualBasic(expression, value, model, shape);
				if (rewrite is not null && pass < 2) {
					expression = rewrite;
					continue;
				}
				return Failed(originalText, specifiers, Unmangle(blocking[0].GetMessage()));
			}
			var operation = model.GetOperation(value);
			if (operation is null)
				return Failed(originalText, specifiers, "The expression could not be bound.");
			return Bound(originalText, specifiers, model, operation, method, shape);
		}
		return Failed(originalText, specifiers, "The expression could not be bound.");
	}

	/// <summary>"Expression does not produce a value": a Sub called for its effect is still what the user meant.</summary>
	static readonly HashSet<string> IgnoredVisualBasicErrors = new(StringComparer.Ordinal) {
		"BC30491",
	};

	sealed class VisualBasicThisRewriter : Microsoft.CodeAnalysis.VisualBasic.VisualBasicSyntaxRewriter {
		public override SyntaxNode? VisitMeExpression(VB.MeExpressionSyntax node) => VBFactory.IdentifierName(ThisName).WithTriviaFrom(node);

		public override SyntaxNode? VisitMyBaseExpression(VB.MyBaseExpressionSyntax node) => VBFactory.IdentifierName(ThisName).WithTriviaFrom(node);

		public override SyntaxNode? VisitMyClassExpression(VB.MyClassExpressionSyntax node) => VBFactory.IdentifierName(ThisName).WithTriviaFrom(node);
	}

	SyntaxTree BuildVisualBasicTree(VB.ExpressionSyntax expression, EvalContextShape shape) {
		var builder = new StringBuilder();
		builder.Append("Module ").Append(HostTypeName).Append('\n').Append("Sub ").Append(HostMethodName).Append('(');
		var parameters = new List<string>();
		if (shape.ThisType is not null)
			parameters.Add($"{ThisName} As {TypeText(shape.ThisType, EvalLanguage.VisualBasic)}");
		foreach (var variable in shape.Variables.Concat(shape.Aliases)) {
			var name = variable.Name.StartsWith('$') ? AliasIdentifier(variable.Name) : variable.Name;
			if (!IsValidIdentifier(name, EvalLanguage.VisualBasic) || parameters.Any(parameter => string.Equals(parameter.Split(' ')[0], EscapeVisualBasic(name), StringComparison.OrdinalIgnoreCase)))
				continue;
			parameters.Add($"{EscapeVisualBasic(name)} As {TypeText(variable.Type, EvalLanguage.VisualBasic)}");
		}
		builder.Append(string.Join(", ", parameters)).Append(")\nDim __dnSpy_result = ").Append(expression.ToFullString()).Append("\nEnd Sub\nEnd Module\n");
		return Microsoft.CodeAnalysis.VisualBasic.VisualBasicSyntaxTree.ParseText(builder.ToString());
	}

	VB.ExpressionSyntax? TryRewriteUnboundNamesVisualBasic(VB.ExpressionSyntax original, VB.ExpressionSyntax bound, SemanticModel model, EvalContextShape shape) {
		var boundNames = bound.DescendantNodesAndSelf().OfType<VB.SimpleNameSyntax>().ToArray();
		var originalNames = original.DescendantNodesAndSelf().OfType<VB.SimpleNameSyntax>().ToArray();
		if (boundNames.Length != originalNames.Length)
			return null;
		var replacements = new Dictionary<int, VB.ExpressionSyntax>();
		for (var index = 0; index < boundNames.Length; index++) {
			var name = boundNames[index];
			if (name.Parent is VB.MemberAccessExpressionSyntax access && access.Name == name)
				continue;
			if (name.Parent is VB.QualifiedNameSyntax qualified && qualified.Right == name)
				continue;
			var info = model.GetSymbolInfo(name);
			if (info.Symbol is not null || info.CandidateSymbols.Length > 0)
				continue;
			var identifier = name.Identifier.ValueText;
			VB.ExpressionSyntax? replacement = null;
			foreach (var (typeParameter, type) in shape.TypeArguments) {
				if (string.Equals(typeParameter, identifier, StringComparison.OrdinalIgnoreCase))
					replacement = VBFactory.ParseTypeName(TypeText(type, EvalLanguage.VisualBasic));
			}
			if (replacement is null && shape.ThisType is INamedTypeSymbol thisType && FindMemberIgnoreCase(thisType, identifier) is { } member) {
				replacement = member.IsStatic
					? VBFactory.ParseExpression($"{TypeText(member.ContainingType, EvalLanguage.VisualBasic)}.{EscapeVisualBasic(member.Name)}")
					: VBFactory.ParseExpression($"{ThisName}.{EscapeVisualBasic(member.Name)}");
			}
			for (var type = shape.ContextType; replacement is null && type is not null; type = type.ContainingType) {
				if (FindMemberIgnoreCase(type, identifier) is { IsStatic: true } staticMember && IsSpeakable(staticMember.ContainingType))
					replacement = VBFactory.ParseExpression($"{TypeText(staticMember.ContainingType, EvalLanguage.VisualBasic)}.{EscapeVisualBasic(staticMember.Name)}");
			}
			if (replacement is not null)
				replacements[originalNames[index].SpanStart] = replacement;
		}
		if (replacements.Count == 0)
			return null;
		return original.ReplaceNodes(
			originalNames.Where(name => replacements.ContainsKey(name.SpanStart)),
			(node, _) => replacements[node.SpanStart].WithTriviaFrom(node));
	}

	static ISymbol? FindMemberIgnoreCase(INamedTypeSymbol type, string name) {
		for (ITypeSymbol? current = type; current is not null; current = current.BaseType) {
			var member = current.GetMembers().FirstOrDefault(symbol => symbol.CanBeReferencedByName && string.Equals(symbol.Name, name, StringComparison.OrdinalIgnoreCase) && symbol is IFieldSymbol or IPropertySymbol or IMethodSymbol);
			if (member is not null)
				return member;
		}
		return null;
	}

	// ---------------------------------------------------------------- results

	static CompiledExpression Failed(string text, IReadOnlyList<string> specifiers, string error) =>
		new() { Text = text, FormatSpecifiers = specifiers, Error = error };

	static CompiledExpression Bound(string text, IReadOnlyList<string> specifiers, SemanticModel model, IOperation operation, SyntaxNode method, EvalContextShape shape) {
		var methodSymbol = (IMethodSymbol)model.GetDeclaredSymbol(method)!;
		var parameters = new Dictionary<IParameterSymbol, ContextVariable>(SymbolEqualityComparer.Default);
		IParameterSymbol? thisParameter = null;
		var byName = new Dictionary<string, ContextVariable>(StringComparer.OrdinalIgnoreCase);
		foreach (var variable in shape.Variables.Concat(shape.Aliases)) {
			var name = variable.Name.StartsWith('$') ? AliasIdentifier(variable.Name) : variable.Name;
			byName.TryAdd(name, variable);
		}
		foreach (var parameter in methodSymbol.Parameters) {
			if (parameter.Name == ThisName) {
				thisParameter = parameter;
				continue;
			}
			if (byName.TryGetValue(parameter.Name, out var variable))
				parameters[parameter] = variable;
		}
		return new CompiledExpression {
			Text = text,
			FormatSpecifiers = specifiers,
			Operation = operation,
			Model = model,
			Parameters = parameters,
			ThisParameter = thisParameter,
			HasSideEffects = HasSideEffects(operation),
		};
	}

	/// <summary>
	/// Whether running the expression changes the debuggee: an assignment, an increment, a call that is not
	/// a property getter. Such an expression is not re-run behind the user's back when a window refreshes.
	/// </summary>
	static bool HasSideEffects(IOperation operation) =>
		operation.DescendantsAndSelf().Any(node => node is IAssignmentOperation or IIncrementOrDecrementOperation or IInvocationOperation or IObjectCreationOperation or IArrayCreationOperation or IDynamicInvocationOperation);
}
