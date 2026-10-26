using System.Text;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace dnSpy.Backend.Core.ProjectExport;

/// <summary>
/// The textual fixes around the C#-to-VB converter. Nullable-reference attributes are metadata
/// bookkeeping that VB has no syntax for, and the converter fails on event fields that carry them;
/// VB refuses a ParamArray parameter beside Optional ones, or a default value on a parameter that is
/// not Optional; and ILSpy's `base..ctor()` spelling for a base constructor without a declared type
/// reaches the converter as a member access it writes back as `MyBase._002Ector()`. None of the
/// changes affects what the code does. Shared by the project export (console and GUI) and the
/// console's Visual Basic output.
/// </summary>
public static partial class VisualBasicConverterFixes {
	// Attributes Visual Basic has no form for: the nullability metadata, and the compiler-reserved members a
	// record or a required member carries (VB rejects those outright: "for compiler use only").
	const string MetadataAttributePattern = @"(?:System\.Runtime\.CompilerServices\.)?(?:" +
		@"Nullable(?:Context)?(?:Attribute)?\s*\([^)]*\)" +
		@"|RequiredMember(?:Attribute)?(?:\s*\([^)]*\))?" +
		@"|CompilerFeatureRequired(?:Attribute)?(?:\s*\([^)]*\))?" +
		@"|SetsRequiredMembers(?:Attribute)?(?:\s*\([^)]*\))?" +
		@")";

	[GeneratedRegex(MetadataAttributePattern, RegexOptions.CultureInvariant)]
	private static partial Regex NullableAttribute();

	[GeneratedRegex(@"^\[(?:[a-z]+:\s*)?" + MetadataAttributePattern + @"\]$", RegexOptions.CultureInvariant)]
	private static partial Regex NullableAttributeLine();

	// A section that holds only the attribute, in front of a parameter or a return type: `[Nullable(2)] string s`.
	[GeneratedRegex(@"\[(?:[a-z]+:\s*)?" + MetadataAttributePattern + @"\]\s*", RegexOptions.CultureInvariant)]
	private static partial Regex NullableAttributeSection();

	// The attribute among others in one section: `[Foo, Nullable(1)]`, `[Nullable(1), Foo]`.
	[GeneratedRegex(@"\s*,\s*" + MetadataAttributePattern + @"|" + MetadataAttributePattern + @"\s*,\s*", RegexOptions.CultureInvariant)]
	private static partial Regex NullableAttributeInList();

	// ILSpy writes a base constructor call with no declared type as `base..ctor()`, which the converter
	// passes through as `MyBase._002Ector()`; VB has no such member.
	// A marker comment may follow on the same line when the GUI's decompiler wrote it (it keeps the statement map).
	[GeneratedRegex(@"^\s*MyBase\._002Ector\(\)(?:\s*'.*)?\s*$", RegexOptions.CultureInvariant)]
	private static partial Regex BaseCtorLine();

	[GeneratedRegex(@"^\s*MyBase\.New\(\)(?:\s*'.*)?\s*$", RegexOptions.CultureInvariant)]
	private static partial Regex BaseNewLine();

	// ILSpy writes a base constructor call with no declared type as `base..ctor()`, which the converter reads as a
	// range expression. Visual Basic calls the parameterless base constructor implicitly, so the call is dropped
	// from the C# input too — as an empty statement, which keeps the line and the statement marker on it.
	[GeneratedRegex(@"\bbase\.\.ctor\(\)\s*;", RegexOptions.CultureInvariant)]
	private static partial Regex BaseCtorCall();

	// The C# compiler's own names for the members it generates, which ILSpy writes when it does not fold them
	// away (a record decompiled as a class shows <X>k__BackingField): <Make>b__0_0, <>c__DisplayClass0_0,
	// <Main>g__Local|0_0. Angle brackets and the pipe are not identifier characters in Visual Basic.
	[GeneratedRegex(@"(?<![\w>)])<([A-Za-z_][A-Za-z0-9_]*)>(?=[A-Za-z0-9_])", RegexOptions.CultureInvariant)]
	private static partial Regex GeneratedMemberName();

	[GeneratedRegex(@"(?<![\w>)])<>(?=[A-Za-z0-9_])", RegexOptions.CultureInvariant)]
	private static partial Regex GeneratedAnonymousName();

	[GeneratedRegex(@"(g__[A-Za-z0-9_]*)\|", RegexOptions.CultureInvariant)]
	private static partial Regex GeneratedNamePipe();

	const string PrivateImplementationDetails = "<PrivateImplementationDetails>";


	/// <summary>
	/// Drops the metadata attributes from the C# source before it is converted — a section that holds nothing else
	/// with its brackets and the whole line, one among others with its comma. An attribute line is removed rather
	/// than blanked: Visual Basic attaches an attribute to the declaration on the next line, and a blank line
	/// between them breaks it.
	/// </summary>
	public static string PrepareCSharp(string text) {
		var lines = text.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n');
		var kept = new List<string>(lines.Length);
		foreach (var original in lines) {
			var line = SanitizeGeneratedNames(original);
			if (line.Contains("base..ctor", StringComparison.Ordinal))
				line = BaseCtorCall().Replace(line, ";");
			if (line.Contains('[', StringComparison.Ordinal)) {
				if (NullableAttributeLine().IsMatch(line.Trim()))
					continue;
				line = NullableAttributeSection().Replace(line, string.Empty);
				line = NullableAttributeInList().Replace(line, string.Empty);
				line = NullableAttribute().Replace(line, string.Empty);
			}
			kept.Add(line);
		}
		return PrepareCSharpSyntax(string.Join('\n', kept));
	}

	/// <summary>
	/// The C# repairs a Visual Basic document needs before it is converted: a readonly field loses the modifier
	/// (Visual Basic does not let a constructor assign one, and dnSpy's VBDecompiler never writes it), and a local
	/// whose name differs from a type or member it uses by case only is renamed — Visual Basic is case-insensitive,
	/// so <c>var colors = Colors.Red | Colors.Blue</c> would otherwise read the local in both places.
	/// </summary>
	static string PrepareCSharpSyntax(string text) {
		var root = CSharpSyntaxTree.ParseText(text).GetRoot();
		root = root.ReplaceNodes(root.DescendantNodes().OfType<FieldDeclarationSyntax>(),
			(_, rewritten) => rewritten.WithModifiers(SyntaxFactory.TokenList(rewritten.Modifiers.Where(modifier => !modifier.IsKind(SyntaxKind.ReadOnlyKeyword)))));
		root = new LocalFunctionHoister().Visit(root)!;
		root = new DeconstructionAsDeconstructCall().Visit(root)!;
		root = AddMissingCompilerGeneratedFields(root);
		var scopes = root.DescendantNodes().Where(node => node is MethodDeclarationSyntax or ConstructorDeclarationSyntax or DestructorDeclarationSyntax or AccessorDeclarationSyntax).ToArray();
		var renames = new Dictionary<SyntaxNode, List<(string Old, string New)>>();
		foreach (var scope in scopes) {
			if (CSharpScopeNames(scope) is not { Count: > 0 } names)
				continue;
			var tokens = scope.DescendantTokens().Where(token => token.IsKind(SyntaxKind.IdentifierToken)).Select(token => token.ValueText).ToArray();
			List<(string, string)>? renamed = null;
			foreach (var name in names) {
				if (!tokens.Any(token => token != name && string.Equals(token, name, StringComparison.OrdinalIgnoreCase)))
					continue;
				var newName = name + "_";
				while (tokens.Contains(newName, StringComparer.OrdinalIgnoreCase))
					newName += "_";
				(renamed ??= []).Add((name, newName));
			}
			if (renamed is not null)
				renames[scope] = renamed;
		}
		if (renames.Count > 0)
			root = root.ReplaceNodes(renames.Keys, (original, rewritten) => new LocalRenamer(renames[original]).Visit(rewritten)!);
		return root.ToFullString();
	}

	/// <summary>
	/// A local function as a delegate local: the converter has no Visual Basic form for a local function, and a
	/// lambda is the same code. The declaration and the assignment are two statements so the lambda can call
	/// itself. A generic, <c>ref</c>/<c>out</c>/<c>params</c>, iterator or pointer-parameter one stays as it is —
	/// no lambda expresses it — and the converter comments it out.
	/// </summary>
	static (LocalDeclarationStatementSyntax Declaration, StatementSyntax Assignment)? LocalFunctionAsDelegate(LocalFunctionStatementSyntax function) {
		if (function.TypeParameterList is not null || function.Body is null && function.ExpressionBody is null)
			return null;
		if (function.Body is { } body && body.DescendantNodes().OfType<YieldStatementSyntax>().Any())
			return null;
		var parameters = function.ParameterList.Parameters;
		if (parameters.Any(parameter => parameter.Type is null || parameter.Default is not null
				|| parameter.Modifiers.Any(modifier => !modifier.IsKind(SyntaxKind.ThisKeyword) && !modifier.IsKind(SyntaxKind.StaticKeyword))))
			return null;
		var parameterTypes = string.Join(", ", parameters.Select(parameter => parameter.Type!.ToString()));
		var isVoid = function.ReturnType is PredefinedTypeSyntax { Keyword.RawKind: (int)SyntaxKind.VoidKeyword };
		var isAsync = function.Modifiers.Any(modifier => modifier.IsKind(SyntaxKind.AsyncKeyword));
		var delegateType = isVoid
			? parameterTypes.Length == 0 ? "System.Action" : $"System.Action<{parameterTypes}>"
			: parameterTypes.Length == 0 ? $"System.Func<{function.ReturnType}>" : $"System.Func<{parameterTypes}, {function.ReturnType}>";
		var declaration = SyntaxFactory.LocalDeclarationStatement(
			SyntaxFactory.VariableDeclaration(SyntaxFactory.ParseTypeName(delegateType),
				SyntaxFactory.SingletonSeparatedList(SyntaxFactory.VariableDeclarator(function.Identifier.WithoutTrivia()))));
		var lambdaParameterList = SyntaxFactory.ParameterList(SyntaxFactory.SeparatedList(
			parameters.Select(parameter => SyntaxFactory.Parameter(parameter.Identifier.WithoutTrivia()).WithType(parameter.Type!))));
		CSharpSyntaxNode lambdaBody = function.ExpressionBody is { } arrow ? arrow.Expression : function.Body!;
		var lambda = SyntaxFactory.ParenthesizedLambdaExpression(lambdaParameterList, lambdaBody);
		if (isAsync)
			lambda = lambda.WithAsyncKeyword(SyntaxFactory.Token(SyntaxKind.AsyncKeyword));
		var assignment = SyntaxFactory.ExpressionStatement(SyntaxFactory.AssignmentExpression(
			SyntaxKind.SimpleAssignmentExpression, SyntaxFactory.IdentifierName(function.Identifier.WithoutTrivia()), lambda))
			.WithLeadingTrivia(function.GetLeadingTrivia());
		return (declaration, assignment);
	}

	/// <summary>
	/// Hoists the delegate form of every local function to just before the first statement that names it — the
	/// converter has no local function, and Visual Basic, unlike C#, wants the delegate declared before its use.
	/// A local function the lambda cannot express stays where it is and is commented out by the converter.
	/// </summary>
	sealed class LocalFunctionHoister : CSharpSyntaxRewriter {
		public override SyntaxNode? VisitBlock(BlockSyntax node) {
			var rewritten = (BlockSyntax)base.VisitBlock(node)!;
			return rewritten.WithStatements(Hoist(rewritten.Statements));
		}

		public override SyntaxNode? VisitSwitchSection(SwitchSectionSyntax node) {
			var rewritten = (SwitchSectionSyntax)base.VisitSwitchSection(node)!;
			return rewritten.WithStatements(Hoist(rewritten.Statements));
		}

		static SyntaxList<StatementSyntax> Hoist(SyntaxList<StatementSyntax> statements) {
			var functions = statements.OfType<LocalFunctionStatementSyntax>().ToList();
			if (functions.Count == 0)
				return statements;
			var converted = new Dictionary<LocalFunctionStatementSyntax, (LocalDeclarationStatementSyntax Declaration, StatementSyntax Assignment)>();
			var insertAt = new Dictionary<int, List<(LocalDeclarationStatementSyntax, StatementSyntax)>>();
			foreach (var function in functions) {
				if (LocalFunctionAsDelegate(function) is not { } pair)
					continue;
				converted[function] = pair;
				var useIndex = -1;
				for (var i = 0; i < statements.Count; i++) {
					if (statements[i] != function && Names(statements[i], function.Identifier.ValueText)) {
						useIndex = i;
						break;
					}
				}
				if (useIndex < 0)
					useIndex = statements.IndexOf(function);
				if (!insertAt.TryGetValue(useIndex, out var pairs))
					insertAt[useIndex] = pairs = [];
				pairs.Add(pair);
			}
			if (converted.Count == 0)
				return statements;
			var result = new List<StatementSyntax>(statements.Count + converted.Count * 2);
			for (var i = 0; i < statements.Count; i++) {
				if (insertAt.TryGetValue(i, out var pairs)) {
					foreach (var (declaration, assignment) in pairs)
						result.AddRange([declaration, assignment]);
				}
				if (statements[i] is LocalFunctionStatementSyntax function && converted.ContainsKey(function))
					continue;
				result.Add(statements[i]);
			}
			return SyntaxFactory.List(result);
		}

		static bool Names(SyntaxNode node, string name) =>
			node.DescendantTokens().Any(token => token.IsKind(SyntaxKind.IdentifierToken) && token.ValueText == name);
	}

	/// <summary>
	/// A deconstruction as the call it stands for: <c>var (a, b) = t;</c> becomes
	/// <c>t.Deconstruct(out var a, out var b);</c>, which the converter turns into two declared locals. The
	/// converter's own deconstruction declares a tuple local and then uses names it never declares.
	/// </summary>
	sealed class DeconstructionAsDeconstructCall : CSharpSyntaxRewriter {
		int temp;

		public override SyntaxNode? VisitBlock(BlockSyntax node) {
			var rewritten = (BlockSyntax)base.VisitBlock(node)!;
			var statements = rewritten.Statements.ToList();
			var expanded = false;
			for (var i = 0; i < statements.Count; i++) {
				if (statements[i] is not ExpressionStatementSyntax statement)
					continue;
				// The declarations a tuple expression's type comes from — a parameter, a local, a field — are not
				// all in the block; the type around it holds them.
				var replacement = Expand(statement, statement.FirstAncestorOrSelf<TypeDeclarationSyntax>() ?? (SyntaxNode)rewritten);
				if (replacement is null)
					continue;
				statements.RemoveAt(i);
				statements.InsertRange(i, replacement);
				i += replacement.Count - 1;
				expanded = true;
			}
			return expanded ? rewritten.WithStatements(SyntaxFactory.List(statements)) : rewritten;
		}

		/// <summary>What a deconstruction statement becomes: one statement per target, and the tuple in a local first.</summary>
		List<StatementSyntax>? Expand(ExpressionStatementSyntax statement, SyntaxNode scope) {
			if (statement.Expression is not AssignmentExpressionSyntax { Right: { } target } assignment)
				return null;
			List<ExpressionSyntax> targets;
			bool isDeclaration;
			switch (assignment.Left) {
			case DeclarationExpressionSyntax { Designation: ParenthesizedVariableDesignationSyntax designation }
					when designation.Variables.All(designation => designation is SingleVariableDesignationSyntax):
				targets = [.. designation.Variables.Cast<SingleVariableDesignationSyntax>().Select(designation => (ExpressionSyntax)SyntaxFactory.IdentifierName(designation.Identifier.WithoutTrivia()))];
				isDeclaration = true;
				break;
			case TupleExpressionSyntax tuple when tuple.Arguments.All(argument => argument.Expression is IdentifierNameSyntax or MemberAccessExpressionSyntax):
				targets = [.. tuple.Arguments.Select(argument => argument.Expression.WithoutTrivia())];
				isDeclaration = false;
				break;
			default:
				return null;
			}
			var result = new List<StatementSyntax>();
			if (IsTuple(target, scope)) {
				var name = $"__dnSpyTuple{temp++}";
				while (scope.DescendantTokens().Any(token => token.IsKind(SyntaxKind.IdentifierToken) && token.ValueText == name))
					name = $"__dnSpyTuple{temp++}";
				result.Add(SyntaxFactory.ParseStatement($"var {name} = {target.WithoutTrivia()};"));
				for (var i = 0; i < targets.Count; i++) {
					var value = SyntaxFactory.MemberAccessExpression(SyntaxKind.SimpleMemberAccessExpression,
						SyntaxFactory.IdentifierName(name), SyntaxFactory.IdentifierName($"Item{i + 1}"));
					var declaration = isDeclaration
						? SyntaxFactory.ParseStatement($"var {((IdentifierNameSyntax)targets[i]).Identifier.ValueText} = {value};")
						: SyntaxFactory.ExpressionStatement(SyntaxFactory.AssignmentExpression(SyntaxKind.SimpleAssignmentExpression, targets[i], value));
					result.Add(declaration);
				}
				result[0] = result[0].WithLeadingTrivia(statement.GetLeadingTrivia());
				return result;
			}
			// A type with a Deconstruct method: the call is the deconstruction. The declarations the converter
			// makes from the out arguments are left to it (Dim a = Nothing, …).
			var arguments = targets.Select(target => SyntaxFactory.Argument(
					isDeclaration
						? SyntaxFactory.DeclarationExpression(
							SyntaxFactory.IdentifierName(SyntaxFactory.Identifier("var").WithTrailingTrivia(SyntaxFactory.Space)),
							SyntaxFactory.SingleVariableDesignation(((IdentifierNameSyntax)target).Identifier.WithoutTrivia()))
						: target)
				.WithRefKindKeyword(SyntaxFactory.Token(SyntaxKind.OutKeyword).WithTrailingTrivia(SyntaxFactory.Space)));
			result.Add(SyntaxFactory.ExpressionStatement(SyntaxFactory.InvocationExpression(
				SyntaxFactory.MemberAccessExpression(SyntaxKind.SimpleMemberAccessExpression,
					SyntaxFactory.ParenthesizedExpression(target.WithoutTrivia()), SyntaxFactory.IdentifierName("Deconstruct")),
				SyntaxFactory.ArgumentList(SyntaxFactory.SeparatedList(arguments)))));
			result[0] = result[0].WithLeadingTrivia(statement.GetLeadingTrivia());
			return result;
		}

		/// <summary>Whether the expression is a tuple — a tuple literal, or a local, parameter or field of tuple type.</summary>
		static bool IsTuple(ExpressionSyntax expression, SyntaxNode scope) {
			if (expression is TupleExpressionSyntax)
				return true;
			if (expression is not IdentifierNameSyntax identifier)
				return false;
			var name = identifier.Identifier.ValueText;
			foreach (var node in scope.DescendantNodes()) {
				switch (node) {
				case ParameterSyntax parameter when parameter.Identifier.ValueText == name:
					return parameter.Type is TupleTypeSyntax;
				case VariableDeclaratorSyntax { Parent: VariableDeclarationSyntax declaration } variable when variable.Identifier.ValueText == name:
					return declaration.Type is TupleTypeSyntax
						|| declaration.Type.IsVar && declaration.Variables.Count == 1 && variable.Initializer?.Value is TupleExpressionSyntax;
				case PropertyDeclarationSyntax property when property.Identifier.ValueText == name:
					return property.Type is TupleTypeSyntax;
				}
			}
			return false;
		}
	}

	/// <summary>
	/// The compiler-generated fields ILSpy hides but still refers to: a primary constructor's
	/// <c>&lt;seed&gt;P</c> (written <c>seed_P</c> here) has no declaration in the C# output, so the converted
	/// Visual Basic would call a field it never declares. The field takes the constructor parameter's type; a
	/// missing accessor backing field takes its property's.
	/// </summary>
	static SyntaxNode AddMissingCompilerGeneratedFields(SyntaxNode root) {
		var types = root.DescendantNodesAndSelf().OfType<TypeDeclarationSyntax>().ToArray();
		return root.ReplaceNodes(types, (_, rewritten) => AddMissingFields(rewritten));
	}

	static TypeDeclarationSyntax AddMissingFields(TypeDeclarationSyntax type) {
		if (type is InterfaceDeclarationSyntax)
			return type;
		var declared = type.Members.SelectMany(MemberNames).ToHashSet(StringComparer.Ordinal);
		var references = type.Members.Where(member => member is not TypeDeclarationSyntax)
			.SelectMany(member => member.DescendantTokens())
			.Where(token => token.IsKind(SyntaxKind.IdentifierToken))
			.Select(token => token.ValueText)
			.Where(name => !declared.Contains(name))
			.ToHashSet(StringComparer.Ordinal);
		List<FieldDeclarationSyntax>? fields = null;
		foreach (var name in references.Order(StringComparer.Ordinal)) {
			if (!TryGeneratedFieldType(type, name, out var fieldType))
				continue;
			(fields ??= []).Add(SyntaxFactory.ParseMemberDeclaration($"private {fieldType} {name};") as FieldDeclarationSyntax
				?? throw new InvalidOperationException($"Cannot write the field {name}."));
		}
		return fields is null ? type : type.WithMembers(SyntaxFactory.List(fields.Concat(type.Members)));
	}

	static bool TryGeneratedFieldType(TypeDeclarationSyntax type, string name, out string fieldType) {
		fieldType = string.Empty;
		const string backingSuffix = "_k__BackingField";
		if (name.EndsWith(backingSuffix, StringComparison.Ordinal)) {
			var propertyName = name[..^backingSuffix.Length];
			if (type.Members.OfType<PropertyDeclarationSyntax>().FirstOrDefault(property => property.Identifier.ValueText == propertyName) is { Type: { } propertyType })
				fieldType = propertyType.ToString();
			return fieldType.Length > 0;
		}
		const string primarySuffix = "_P";
		if (name.EndsWith(primarySuffix, StringComparison.Ordinal)) {
			var parameterName = name[..^primarySuffix.Length];
			foreach (var constructor in type.Members.OfType<ConstructorDeclarationSyntax>()) {
				if (constructor.ParameterList.Parameters.FirstOrDefault(parameter => parameter.Identifier.ValueText == parameterName) is { Type: { } parameterType }) {
					fieldType = parameterType.ToString();
					return true;
				}
			}
		}
		return false;
	}

	static IEnumerable<string> MemberNames(MemberDeclarationSyntax member) => member switch {
		FieldDeclarationSyntax field => field.Declaration.Variables.Select(variable => variable.Identifier.ValueText),
		EventFieldDeclarationSyntax eventField => eventField.Declaration.Variables.Select(variable => variable.Identifier.ValueText),
		PropertyDeclarationSyntax property => [property.Identifier.ValueText],
		EventDeclarationSyntax eventDeclaration => [eventDeclaration.Identifier.ValueText],
		MethodDeclarationSyntax method => [method.Identifier.ValueText],
		ConstructorDeclarationSyntax constructor => [constructor.Identifier.ValueText],
		DelegateDeclarationSyntax @delegate => [@delegate.Identifier.ValueText],
		BaseTypeDeclarationSyntax baseType => [baseType.Identifier.ValueText],
		_ => [],
	};

	/// <summary>The locals a method body declares, with the names of any it declares by deconstruction.</summary>
	static List<string> CSharpScopeNames(SyntaxNode scope) {
		var names = new List<string>();
		foreach (var declarator in scope.DescendantNodes().OfType<VariableDeclaratorSyntax>()) {
			if (declarator.FirstAncestorOrSelf<FieldDeclarationSyntax>() is not null || declarator.FirstAncestorOrSelf<EventFieldDeclarationSyntax>() is not null)
				continue;
			names.Add(declarator.Identifier.ValueText);
		}
		foreach (var designation in scope.DescendantNodes().OfType<SingleVariableDesignationSyntax>())
			names.Add(designation.Identifier.ValueText);
		return names;
	}

	/// <summary>Renames one local's exact-case references, leaving the differently-cased type or member alone.</summary>
	sealed class LocalRenamer(List<(string Old, string New)> renames) : CSharpSyntaxRewriter {
		public override SyntaxNode? VisitIdentifierName(IdentifierNameSyntax node) =>
			Renamed(node.Identifier.ValueText) is { } name
				? node.WithIdentifier(SyntaxFactory.Identifier(node.Identifier.LeadingTrivia, name, node.Identifier.TrailingTrivia))
				: base.VisitIdentifierName(node);

		public override SyntaxNode? VisitVariableDeclarator(VariableDeclaratorSyntax node) {
			var rewritten = (VariableDeclaratorSyntax)base.VisitVariableDeclarator(node)!;
			return Renamed(rewritten.Identifier.ValueText) is { } name
				? rewritten.WithIdentifier(SyntaxFactory.Identifier(rewritten.Identifier.LeadingTrivia, name, rewritten.Identifier.TrailingTrivia))
				: rewritten;
		}

		public override SyntaxNode? VisitSingleVariableDesignation(SingleVariableDesignationSyntax node) =>
			Renamed(node.Identifier.ValueText) is { } name
				? node.WithIdentifier(SyntaxFactory.Identifier(node.Identifier.LeadingTrivia, name, node.Identifier.TrailingTrivia))
				: base.VisitSingleVariableDesignation(node);

		string? Renamed(string name) {
			foreach (var (oldName, newName) in renames) {
				if (name == oldName)
					return newName;
			}
			return null;
		}
	}

	/// <summary>
	/// The compiler-generated member names written as identifiers Visual Basic (and C#) accept — the record
	/// backing fields a class-form record shows keep their own name with the brackets taken off.
	/// </summary>
	static string SanitizeGeneratedNames(string line) {
		if (line.Contains('<', StringComparison.Ordinal)) {
			line = line.Replace(PrivateImplementationDetails, "PrivateImplementationDetails_", StringComparison.Ordinal);
			line = GeneratedMemberName().Replace(line, "$1_");
			line = GeneratedAnonymousName().Replace(line, "_");
		}
		if (line.Contains('|', StringComparison.Ordinal))
			line = GeneratedNamePipe().Replace(line, "$1_");
		return line;
	}

	/// <summary>
	/// Comments out what the converter could not convert. It writes the error as a Visual Basic comment whose text
	/// includes the C# node it failed on; only the first line keeps the comment mark, so the rest would be read as
	/// Visual Basic. Every line of the error — the exception, the <c>Input:</c> heading and the quoted node, which
	/// ends where its braces close — becomes a comment.
	/// </summary>
	static string CommentConversionErrors(string text) {
		var lines = text.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n');
		for (var i = 0; i < lines.Length; i++) {
			var trimmed = lines[i].TrimStart();
			if (!trimmed.StartsWith("''' Cannot convert ", StringComparison.Ordinal) && !trimmed.Contains("CONVERSION ERROR", StringComparison.Ordinal))
				continue;
			var end = ErrorBlockEnd(lines, i);
			for (var j = i + 1; j <= end && j < lines.Length; j++) {
				if (!lines[j].TrimStart().StartsWith('\''))
					lines[j] = "' " + lines[j];
			}
			i = end;
		}
		return string.Join('\n', lines);
	}

	static int ErrorBlockEnd(string[] lines, int start) {
		var end = start;
		var found = false;
		for (var index = start + 1; index < lines.Length;) {
			var trimmed = lines[index].TrimStart();
			if (!trimmed.StartsWith("Input:", StringComparison.Ordinal) && !trimmed.StartsWith("Context:", StringComparison.Ordinal)) {
				// The exception's own text comes first; after an input block the error is over.
				if (found)
					break;
				end = index++;
				continue;
			}
			found = true;
			end = index;
			index++;
			while (index < lines.Length && lines[index].Trim().Length == 0)
				end = index++;
			var depth = 0;
			var brace = false;
			var state = RawTextState.Code;
			while (index < lines.Length) {
				end = index;
				var lastCode = ScanCode(lines[index], ref depth, ref brace, ref state);
				index++;
				if (brace ? depth == 0 : lastCode is ';' or '}')
					break;
			}
		}
		return found ? end : start;
	}

	enum RawTextState {
		Code,
		String,
		VerbatimString,
		Char,
		LineComment,
		BlockComment,
	}

	/// <summary>
	/// Counts the braces of one line of quoted C#, ignoring the ones in strings, characters and comments, and
	/// answers the last character outside them — the ';' or '}' that ends a node with no brace of its own.
	/// </summary>
	static char ScanCode(string line, ref int depth, ref bool brace, ref RawTextState state) {
		var lastCode = '\0';
		for (var i = 0; i < line.Length; i++) {
			var ch = line[i];
			switch (state) {
			case RawTextState.LineComment:
				state = RawTextState.Code;
				return lastCode;
			case RawTextState.BlockComment:
				if (ch == '*' && i + 1 < line.Length && line[i + 1] == '/') {
					state = RawTextState.Code;
					i++;
				}
				continue;
			case RawTextState.String:
				if (ch == '\\') {
					i++;
					continue;
				}
				if (ch == '"')
					state = RawTextState.Code;
				continue;
			case RawTextState.VerbatimString:
				if (ch != '"')
					continue;
				if (i + 1 < line.Length && line[i + 1] == '"') {
					i++;
					continue;
				}
				state = RawTextState.Code;
				continue;
			case RawTextState.Char:
				if (ch == '\\') {
					i++;
					continue;
				}
				if (ch == '\'')
					state = RawTextState.Code;
				continue;
			}
			if (ch == '/' && i + 1 < line.Length) {
				if (line[i + 1] == '/') {
					state = RawTextState.LineComment;
					continue;
				}
				if (line[i + 1] == '*') {
					state = RawTextState.BlockComment;
					i++;
					continue;
				}
			}
			if (ch == '"') {
				state = i > 0 && line[i - 1] == '@' ? RawTextState.VerbatimString : RawTextState.String;
				continue;
			}
			if (ch == '\'') {
				state = RawTextState.Char;
				continue;
			}
			if (ch == '{') {
				depth++;
				brace = true;
			}
			else if (ch == '}' && depth > 0)
				depth--;
			if (!char.IsWhiteSpace(ch))
				lastCode = ch;
		}
		if (state == RawTextState.LineComment)
			state = RawTextState.Code;
		return lastCode;
	}

	/// <summary>Drops the calls the converter writes for a base constructor the metadata does not declare.</summary>
	public static string PrepareConvertedVB(string text) {
		var lines = CommentConversionErrors(text).Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n');
		for (var i = 0; i < lines.Length; i++) {
			if (BaseCtorLine().IsMatch(lines[i]) || BaseNewLine().IsMatch(lines[i]))
				lines[i] = string.Empty;
		}
		return string.Join('\n', lines);
	}

	/// <summary>Drops Optional and its default value from a parameter list that has a ParamArray.</summary>
	public static string PrepareVB(string text) {
		if (!text.Contains("ParamArray", StringComparison.Ordinal))
			return text;
		var ranges = new List<(int Start, int End)>();
		var index = 0;
		while ((index = text.IndexOf("ParamArray", index, StringComparison.Ordinal)) >= 0) {
			var open = FindOpenParenthesis(text, index);
			var close = open >= 0 ? FindCloseParenthesis(text, open) : -1;
			if (open >= 0 && close > open && !ranges.Contains((open + 1, close)))
				ranges.Add((open + 1, close));
			index += "ParamArray".Length;
		}
		if (ranges.Count == 0)
			return text;
		var builder = new StringBuilder(text);
		foreach (var (start, end) in ranges.OrderByDescending(range => range.Start)) {
			var parameters = builder.ToString(start, end - start);
			builder.Remove(start, end - start).Insert(start, RemoveOptionalAndDefaults(parameters));
		}
		return builder.ToString();
	}

	static int FindOpenParenthesis(string text, int from) {
		var depth = 0;
		for (var i = from - 1; i >= 0; i--) {
			switch (text[i]) {
			case ')':
				depth++;
				break;
			case '(' when depth == 0:
				return i;
			case '(':
				depth--;
				break;
			}
		}
		return -1;
	}

	static int FindCloseParenthesis(string text, int open) {
		var depth = 0;
		for (var i = open; i < text.Length; i++) {
			switch (text[i]) {
			case '(':
				depth++;
				break;
			case ')':
				if (--depth == 0)
					return i;
				break;
			}
		}
		return -1;
	}

	static string RemoveOptionalAndDefaults(string parameters) {
		var result = new StringBuilder(parameters.Length);
		var depth = 0;
		for (var i = 0; i < parameters.Length;) {
			var ch = parameters[i];
			if (ch == '"') {
				var end = SkipString(parameters, i);
				result.Append(parameters, i, end - i);
				i = end;
				continue;
			}
			if (ch == '\'') {
				var end = parameters.IndexOf('\n', i);
				if (end < 0)
					end = parameters.Length;
				result.Append(parameters, i, end - i);
				i = end;
				continue;
			}
			if (ch is '(' or '[' or '{' or '<') {
				depth++;
				result.Append(ch);
				i++;
				continue;
			}
			if (ch is ')' or ']' or '}' or '>') {
				depth = Math.Max(0, depth - 1);
				result.Append(ch);
				i++;
				continue;
			}
			if (depth == 0 && IsWordAt(parameters, i, "Optional")) {
				i += "Optional".Length;
				while (i < parameters.Length && parameters[i] == ' ')
					i++;
				continue;
			}
			if (depth == 0 && ch == '=' && (i + 1 >= parameters.Length || parameters[i + 1] != '>')) {
				i++;
				while (i < parameters.Length) {
					var current = parameters[i];
					if (current == '"') {
						i = SkipString(parameters, i);
						continue;
					}
					if (current == '(') {
						var close = FindCloseParenthesis(parameters, i);
						i = close < 0 ? parameters.Length : close + 1;
						continue;
					}
					if (current == ',')
						break;
					i++;
				}
				continue;
			}
			result.Append(ch);
			i++;
		}
		return result.ToString();
	}

	static int SkipString(string text, int start) {
		var i = start + 1;
		while (i < text.Length) {
			if (text[i] == '"') {
				if (i + 1 < text.Length && text[i + 1] == '"') {
					i += 2;
					continue;
				}
				return i + 1;
			}
			i++;
		}
		return text.Length;
	}

	static bool IsWordAt(string text, int index, string word) =>
		index + word.Length <= text.Length &&
		text.AsSpan(index, word.Length).SequenceEqual(word) &&
		(index == 0 || !char.IsLetterOrDigit(text[index - 1])) &&
		(index + word.Length == text.Length || !char.IsLetterOrDigit(text[index + word.Length]));
}
