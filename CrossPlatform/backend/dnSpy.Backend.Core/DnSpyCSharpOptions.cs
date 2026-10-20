using System.Globalization;
using System.Reflection.Metadata.Ecma335;
using System.Text.RegularExpressions;
using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.IL;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.CSharp.OutputVisitor;
using ICSharpCode.Decompiler.CSharp.Syntax;
using ICSharpCode.Decompiler.CSharp.Transforms;
using ICSharpCode.Decompiler.Semantics;
using ICSharpCode.Decompiler.TypeSystem;
using DecompilerAstNode = ICSharpCode.Decompiler.CSharp.Syntax.AstNode;

namespace dnSpy.Backend.Core;

/// <summary>
/// The C# page's options that dnSpy's fork of ILSpy has and ICSharpCode.Decompiler 11 does not
/// (dnSpy.Decompiler.ILSpy.Core's CSharpVBDecompilerSettings over the fork's DecompilerSettings). They ride along
/// with the package's settings — a clone keeps them, since DecompilerSettings.Clone is a MemberwiseClone — and
/// <see cref="DnSpyCSharpTransform"/> applies them to the syntax tree the way the fork's AstBuilder and its
/// transforms write them. The defaults are the fork's.
/// </summary>
sealed class DnSpyDecompilerSettings : DecompilerSettings {
	public bool ShowTokenAndRvaComments { get; set; } = true;
	public bool SortMembers { get; set; }
	public bool UseSourceCodeOrder { get; set; } = true;
	public bool OneCustomAttributePerLine { get; set; } = true;
	public bool TypeAddInternalModifier { get; set; } = true;
	public bool MemberAddPrivateModifier { get; set; } = true;
	public bool HexadecimalNumbers { get; set; }
	public bool SortSystemUsingStatementsFirst { get; set; } = true;
	public bool FullyQualifyAllTypes { get; set; }
	public bool RemoveEmptyDefaultConstructors { get; set; } = true;
	public bool InsertParenthesesForReadability { get; set; } = true;
	/// <summary>DecompilerSettings.DecompilationObjects: the order a type's members are written in, by kind.</summary>
	public IReadOnlyList<string> DecompilationOrder { get; set; } = DefaultDecompilationOrder;

	public static readonly IReadOnlyList<string> DefaultDecompilationOrder = ["nestedTypes", "fields", "events", "properties", "methods"];
}

/// <summary>
/// The fork's C# output on top of ICSharpCode.Decompiler 11's syntax tree, run as the last AST transform: token and
/// RVA comments (AstBuilder.AddComment), member order (AstBuilder.AddTypeMembers with SortMembers,
/// UseSourceCodeOrder and the decompilation order), the implied <c>internal</c>/<c>private</c> left out
/// (ConvertModifiers), attributes of a member in one section (ConvertCustomAttributes), the using order
/// (IntroduceUsingDeclarations), empty default constructors kept (ConvertConstructorCallIntoInitializer) and
/// hexadecimal numbers (TextTokenWriter.WritePrimitiveValue). Does nothing unless the settings are
/// <see cref="DnSpyDecompilerSettings"/>.
/// </summary>
sealed partial class DnSpyCSharpTransform(ModuleDef module) : IAstTransform {
	// The module being decompiled, in ILSpy's type system: only its entities are rows of `module`.
	ICSharpCode.Decompiler.TypeSystem.IModule? mainModule;

	public void Run(DecompilerAstNode rootNode, TransformContext context) {
		if (context.Settings is not DnSpyDecompilerSettings settings)
			return;
		mainModule = context.TypeSystem.MainModule;
		foreach (var type in rootNode.DescendantsAndSelf.OfType<TypeDeclaration>().ToArray()) {
			if (Resolve(type) is not TypeDef typeDef)
				continue;
			if (!settings.RemoveEmptyDefaultConstructors)
				AddRemovedConstructors(type, typeDef, context);
			if (type.ClassType != ClassType.Enum)
				SortMembers(type, typeDef, settings);
		}
		foreach (var entity in rootNode.DescendantsAndSelf.OfType<EntityDeclaration>().ToArray()) {
			if (!settings.TypeAddInternalModifier || !settings.MemberAddPrivateModifier)
				RemoveImpliedModifiers(entity, settings);
			if (!settings.OneCustomAttributePerLine)
				MergeAttributeSections(entity);
			if (settings.ShowTokenAndRvaComments)
				AddTokenComments(entity);
		}
		if (settings.HexadecimalNumbers)
			WriteNumbersInHex(rootNode);
		if (settings.FullyQualifyAllTypes)
			AddUsingsOfQualifiedTypes(rootNode);
		SortUsings(rootNode, settings.SortSystemUsingStatementsFirst);
	}

	/// <summary>The row of `module` a declaration declares — null for one of another module or none.</summary>
	IMemberDef? Resolve(DecompilerAstNode node) {
		var symbol = node.GetSymbol()
			?? (node as FieldDeclaration)?.Variables.FirstOrDefault()?.GetSymbol()
			?? (node as EventDeclaration)?.Variables.FirstOrDefault()?.GetSymbol();
		if (symbol is not IEntity entity || entity.MetadataToken.IsNil || entity.ParentModule != mainModule)
			return null;
		try {
			return module.ResolveToken(unchecked((uint)MetadataTokens.GetToken(entity.MetadataToken))) as IMemberDef;
		}
		catch (Exception) {
			return null;
		}
	}

	// ---------------------------------------------------------------- Token and RVA comments

	/// <summary>
	/// AstBuilder.AddComment: a comment line naming the member's token, row and, for a member with a body or data,
	/// its RVA and file offset — on a property and an event also one per accessor, on a delegate one for Invoke.
	/// They follow the XML documentation and come before the attributes: the declaration's leading trivia, after
	/// the documentation comments the package put there.
	/// </summary>
	void AddTokenComments(EntityDeclaration entity) {
		if (entity is Accessor || Resolve(entity) is not { } member)
			return;
		AddComment(entity, member, null);
		switch (member) {
		case PropertyDef property:
			AddComment(entity, property.GetMethod, "get");
			AddComment(entity, property.SetMethod, "set");
			break;
		case EventDef @event:
			AddComment(entity, @event.AddMethod, "add");
			AddComment(entity, @event.RemoveMethod, "remove");
			break;
		case TypeDef type when entity is DelegateDeclaration:
			AddComment(entity, type.FindMethod("Invoke"), "Invoke");
			break;
		}
	}

	static void AddComment(DecompilerAstNode node, IMemberDef? member, string? text) {
		if (member is null)
			return;
		node.AddLeadingTrivia(new Comment(TokenCommentText(member, text), CommentType.SingleLine));
	}

	/// <summary>The text of a token comment, after the comment's start: " (get) Token: 0x06000001 RID: 1 RVA: 0x00002050 File Offset: 0x00000250".</summary>
	internal static string TokenCommentText(IMemberDef member, string? text) {
		var comment = new System.Text.StringBuilder(" ");
		if (text is not null)
			comment.Append('(').Append(text).Append(") ");
		comment.Append("Token: ").Append(Hex(member.MDToken.Raw)).Append(" RID: ").Append(member.MDToken.Rid.ToString(CultureInfo.InvariantCulture));
		if (member.GetRVA(out var rva, out var fileOffset))
			comment.Append(" RVA: ").Append(Hex(rva)).Append(" File Offset: ").Append(Hex(unchecked((uint)fileOffset)));
		return comment.ToString();
	}

	static string Hex(uint value) => "0x" + value.ToString("X8", CultureInfo.InvariantCulture);

	// ---------------------------------------------------------------- Member order

	/// <summary>
	/// AstBuilder.AddTypeMembers: the kinds in the decompilation order; nested types and fields in metadata order or,
	/// with SortMembers, by name; methods, properties and events by name with SortMembers, otherwise — with
	/// UseSourceCodeOrder, or for a type whose methods cannot be sorted — all three together in the order of their
	/// first method (ShowAllMethods), where the first of the three kinds stands in the order. A member the tree has
	/// that the metadata does not name keeps its place after them.
	/// </summary>
	void SortMembers(TypeDeclaration type, TypeDef typeDef, DnSpyDecompilerSettings settings) {
		var order = new Dictionary<IMemberDef, int>();
		void Add(IMemberDef member) => order.TryAdd(member, order.Count);
		var shownMethods = false;
		foreach (var kind in settings.DecompilationOrder) {
			switch (kind) {
			case "nestedTypes":
				foreach (var nested in settings.UseSourceCodeOrder ? typeDef.NestedTypes : typeDef.GetNestedTypes(settings.SortMembers))
					Add(nested);
				break;
			case "fields":
				foreach (var field in settings.UseSourceCodeOrder ? typeDef.Fields : typeDef.GetFields(settings.SortMembers))
					Add(field);
				break;
			case "events" or "properties" or "methods":
				if (shownMethods)
					break;
				if (settings.UseSourceCodeOrder || !typeDef.CanSortMethods()) {
					foreach (var member in NonSortedMethodsPropertiesEvents(typeDef)) {
						Add(member);
						if (member is PropertyDef property)
							foreach (var other in property.OtherMethods.Where(method => method.DeclaringType == typeDef))
								Add(other);
						if (member is EventDef @event) {
							if (@event.InvokeMethod is { } invoke && invoke.DeclaringType == typeDef)
								Add(invoke);
							foreach (var other in @event.OtherMethods.Where(method => method.DeclaringType == typeDef))
								Add(other);
						}
					}
					shownMethods = true;
					break;
				}
				if (kind == "events")
					foreach (var @event in typeDef.GetEvents(settings.SortMembers))
						Add(@event);
				else if (kind == "properties")
					foreach (var property in typeDef.GetProperties(settings.SortMembers))
						Add(property);
				else
					foreach (var method in typeDef.GetMethods(settings.SortMembers))
						Add(method);
				break;
			}
		}

		var members = type.Members.ToList();
		if (members.Count < 2)
			return;
		// A member's comments are its leading trivia and move with it.
		var sorted = members
			.Select((member, index) => (Member: member, Key: Resolve(member) is { } def && order.TryGetValue(def, out var position) ? position : int.MaxValue, Index: index))
			.OrderBy(entry => entry.Key).ThenBy(entry => entry.Index)
			.Select(entry => entry.Member)
			.ToList();
		if (sorted.SequenceEqual(members))
			return;
		foreach (var member in members)
			member.Remove();
		foreach (var member in sorted)
			type.Members.Add(member);
	}

	/// <summary>dnSpy's GetNonSortedMethodsPropertiesEvents: methods, properties and events in the order of their first method.</summary>
	static IEnumerable<IMemberDef> NonSortedMethodsPropertiesEvents(TypeDef type) {
		var hash = new HashSet<MethodDef>();
		var defs = new List<(IMemberDef Def, List<MethodDef> Methods)>();
		foreach (var property in type.Properties) {
			var methods = property.GetMethods.Concat(property.SetMethods).Concat(property.OtherMethods).ToList();
			foreach (var method in methods)
				hash.Add(method);
			methods.Sort((a, b) => a.MDToken.Raw.CompareTo(b.MDToken.Raw));
			defs.Add((property, methods));
		}
		foreach (var @event in type.Events) {
			var methods = new[] { @event.AddMethod, @event.RemoveMethod, @event.InvokeMethod }.OfType<MethodDef>().Concat(@event.OtherMethods).ToList();
			foreach (var method in methods)
				hash.Add(method);
			methods.Sort((a, b) => a.MDToken.Raw.CompareTo(b.MDToken.Raw));
			defs.Add((@event, methods));
		}
		foreach (var method in type.Methods) {
			if (!hash.Contains(method))
				defs.Add((method, [method]));
		}
		// List.Sort is not stable; dnSpy's isn't either, but its ties (members without methods) are rare enough that
		// the declaration order is the one kept here.
		return defs.Select((def, index) => (def, index))
			.OrderBy(entry => entry.def.Methods.Count == 0 ? 1 : 0)
			.ThenBy(entry => entry.def.Methods.Count == 0 ? 0 : entry.def.Methods[0].MDToken.Raw)
			.ThenBy(entry => entry.index)
			.Select(entry => entry.def.Def);
	}

	// ---------------------------------------------------------------- Modifiers and attributes

	/// <summary>
	/// AstBuilder.ConvertModifiers: without TypeAddInternalModifier a type that is not nested and not public gets no
	/// <c>internal</c>; without MemberAddPrivateModifier a private member — a nested type too — gets no <c>private</c>.
	/// An interface's private member keeps it, since leaving it out there would make it public.
	/// </summary>
	void RemoveImpliedModifiers(EntityDeclaration entity, DnSpyDecompilerSettings settings) {
		if (entity is Accessor || Resolve(entity) is not { } member)
			return;
		var modifiers = entity.Modifiers;
		if (member is TypeDef { IsNested: false }) {
			if (!settings.TypeAddInternalModifier && (modifiers & Modifiers.Internal) != 0 && (modifiers & Modifiers.Protected) == 0)
				entity.Modifiers = modifiers & ~Modifiers.Internal;
			return;
		}
		if (!settings.MemberAddPrivateModifier && (modifiers & Modifiers.Private) != 0 && (modifiers & Modifiers.Protected) == 0
			&& member.DeclaringType is { IsInterface: false })
			entity.Modifiers = modifiers & ~Modifiers.Private;
	}

	/// <summary>
	/// ConvertCustomAttributes without OneCustomAttributePerLine: a member's attributes in one section — those of the
	/// return value in one of their own. A parameter's are written one per section either way.
	/// </summary>
	static void MergeAttributeSections(EntityDeclaration entity) {
		var sections = entity.Attributes.ToList();
		foreach (var group in sections.GroupBy(section => section.AttributeTarget ?? string.Empty)) {
			var first = group.First();
			foreach (var section in group.Skip(1)) {
				foreach (var attribute in section.Attributes.ToList()) {
					attribute.Remove();
					first.Attributes.Add(attribute);
				}
				section.Remove();
			}
		}
	}

	// ---------------------------------------------------------------- Constructors

	/// <summary>
	/// ConvertConstructorCallIntoInitializer without RemoveEmptyDefaultConstructors: the constructors ILSpy left out
	/// because they do nothing — the only parameterless instance constructor and an empty static one — written
	/// back with an empty body.
	/// </summary>
	void AddRemovedConstructors(TypeDeclaration type, TypeDef typeDef, TransformContext context) {
		if (type.ClassType is ClassType.Interface or ClassType.Enum)
			return;
		var present = type.Members.Select(member => Resolve(member)).OfType<MethodDef>().ToHashSet();
		foreach (var constructor in typeDef.Methods.Where(method => method.IsConstructor || method.IsStaticConstructor)) {
			if (present.Contains(constructor) || constructor.Parameters.Count(parameter => parameter.IsNormalMethodParameter) != 0)
				continue;
			if (context.TypeSystem.MainModule is not ICSharpCode.Decompiler.TypeSystem.MetadataModule metadataModule)
				continue;
			ICSharpCode.Decompiler.TypeSystem.IMethod definition;
			try {
				definition = metadataModule.GetDefinition(MetadataTokens.MethodDefinitionHandle((int)constructor.Rid));
			}
			catch (Exception) {
				continue;
			}
			if (context.TypeSystemAstBuilder.ConvertEntity(definition) is not ConstructorDeclaration declaration)
				continue;
			declaration.Body = new BlockStatement();
			// Where it goes among the others is the member order's to say.
			type.Members.Add(declaration);
		}
	}

	// ---------------------------------------------------------------- Numbers and usings

	/// <summary>
	/// HexadecimalNumbers: every integer written the way dnSpy's C# NumberFormatter writes it — up to nine in
	/// decimal, anything larger in upper case hexadecimal, a negative one as a minus in front of that.
	/// </summary>
	static void WriteNumbersInHex(DecompilerAstNode root) {
		foreach (var primitive in root.Descendants.OfType<PrimitiveExpression>().ToArray()) {
			if (primitive.Format != LiteralFormat.None || !TryMagnitude(primitive.Value, out var magnitude, out var negative, out var positive) || magnitude <= 9)
				continue;
			if (!negative) {
				primitive.Format = LiteralFormat.HexadecimalNumber;
				continue;
			}
			var replacement = new UnaryOperatorExpression(UnaryOperatorType.Minus, new PrimitiveExpression(positive!, LiteralFormat.HexadecimalNumber));
			foreach (var annotation in primitive.Annotations)
				replacement.AddAnnotation(annotation);
			primitive.ReplaceWith(replacement);
		}
	}

	static bool TryMagnitude(object? value, out ulong magnitude, out bool negative, out object? positive) {
		magnitude = 0;
		negative = false;
		positive = null;
		switch (value) {
		case byte v: magnitude = v; positive = v; break;
		case ushort v: magnitude = v; positive = v; break;
		case uint v: magnitude = v; positive = v; break;
		case ulong v: magnitude = v; positive = v; break;
		case sbyte v when v != sbyte.MinValue: magnitude = (ulong)Math.Abs(v); negative = v < 0; positive = (sbyte)Math.Abs(v); break;
		case short v when v != short.MinValue: magnitude = (ulong)Math.Abs(v); negative = v < 0; positive = (short)Math.Abs(v); break;
		case int v when v != int.MinValue: magnitude = (ulong)Math.Abs(v); negative = v < 0; positive = Math.Abs(v); break;
		case long v when v != long.MinValue: magnitude = (ulong)Math.Abs(v); negative = v < 0; positive = Math.Abs(v); break;
		}
		return positive is not null;
	}

	/// <summary>
	/// FullyQualifyAllTypes writes every type with its namespace and still imports the namespaces it names
	/// (IntroduceUsingDeclarations collects them either way); ILSpy 11 qualifies them only without using
	/// declarations, so the imports are put back.
	/// </summary>
	static void AddUsingsOfQualifiedTypes(DecompilerAstNode root) {
		if (root is not SyntaxTree tree || tree.Children.OfType<UsingDeclaration>().Any())
			return;
		var declared = tree.Descendants.OfType<NamespaceDeclaration>().Select(ns => ns.FullName).ToHashSet(StringComparer.Ordinal);
		var namespaces = new SortedSet<string>(StringComparer.Ordinal);
		// A keyword type (string, int) names no namespace in the text.
		foreach (var type in tree.Descendants.OfType<AstType>().Where(type => type is not PrimitiveType)) {
			if (type.Annotation<TypeResolveResult>()?.Type is { Kind: not TypeKind.TypeParameter } resolved && !string.IsNullOrEmpty(resolved.Namespace) && !declared.Contains(resolved.Namespace))
				namespaces.Add(resolved.Namespace);
		}
		var first = tree.Members.FirstOrDefault();
		foreach (var ns in namespaces) {
			var declaration = new UsingDeclaration(ns);
			if (first is null)
				tree.Members.Add(declaration);
			else
				tree.Members.InsertBefore(first, declaration);
		}
	}

	/// <summary>
	/// IntroduceUsingDeclarations' order: with SortSystemUsingStatementsFirst, the System namespaces first and each
	/// half alphabetically; without it, all of them alphabetically — both ignoring case.
	/// </summary>
	static void SortUsings(DecompilerAstNode root, bool systemFirst) {
		foreach (var container in root.DescendantsAndSelf.Where(node => node is SyntaxTree or NamespaceDeclaration)) {
			var usings = container.Children.OfType<UsingDeclaration>().ToList();
			if (usings.Count < 2)
				continue;
			var sorted = usings.OrderBy(declaration => systemFirst && IsSystem(declaration.Namespace) ? 0 : 1)
				.ThenBy(declaration => declaration.Namespace, StringComparer.OrdinalIgnoreCase)
				.ToList();
			if (sorted.SequenceEqual(usings))
				continue;
			var members = container is SyntaxTree tree ? tree.Members : ((NamespaceDeclaration)container).Members;
			var anchor = usings[^1].NextSibling;
			foreach (var declaration in usings)
				declaration.Remove();
			foreach (var declaration in sorted) {
				if (anchor is null)
					members.Add(declaration);
				else
					members.InsertBefore(anchor, declaration);
			}
		}

		static bool IsSystem(string ns) => ns == "System" || ns.StartsWith("System.", StringComparison.Ordinal);
	}

	// ---------------------------------------------------------------- After ILSpy's own passes

	/// <summary>
	/// InsertParenthesesForReadability off: ILSpy always adds the parentheses that only help a reader, after the
	/// transforms ran, so they are taken out again here — every one, then the ones the grammar needs put back.
	/// </summary>
	public static void AfterDecompile(SyntaxTree syntaxTree, DecompilerSettings settings) {
		if (settings is not DnSpyDecompilerSettings { InsertParenthesesForReadability: false })
			return;
		foreach (var parenthesized in syntaxTree.Descendants.OfType<ParenthesizedExpression>().ToArray()) {
			var inner = parenthesized.Expression;
			inner.Remove();
			parenthesized.ReplaceWith(inner);
		}
		syntaxTree.AcceptVisitor(new InsertParenthesesVisitor { InsertParenthesesForReadability = false });
	}

	// ---------------------------------------------------------------- Spans

	[GeneratedRegex(@"^[ \t]*(?://|')[ ](?:\((?:get|set|add|remove|Invoke)\)[ ])?Token:[ ](?<token>0x[0-9A-F]{8})[ ]RID:[ ]\d+(?:[ ]RVA:[ ](?<rva>0x[0-9A-F]{8})[ ]File[ ]Offset:[ ](?<offset>0x[0-9A-F]{8}))?[ \t]*\r?$", RegexOptions.Multiline | RegexOptions.CultureInvariant)]
	private static partial Regex TokenCommentPattern();

	/// <summary>
	/// The references a token comment writes (CommentReferencesCreator): the token names its member, the RVA and the
	/// file offset are addresses the hex editor opens. Spans of a document written in either C# or Visual Basic.
	/// </summary>
	internal static IEnumerable<TextSpanDto> TokenCommentSpans(string text, string? modulePath, Func<int, TextSpanDto?> tokenSpan) {
		foreach (Match match in TokenCommentPattern().Matches(text)) {
			var token = match.Groups["token"];
			var value = int.Parse(token.Value.AsSpan(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
			if (tokenSpan(value) is { } span)
				yield return span with { Start = token.Index, Length = token.Length, Color = TextColors.Comment };
			if (match.Groups["rva"] is { Success: true } rva)
				yield return Address(rva, true);
			if (match.Groups["offset"] is { Success: true } offset)
				yield return Address(offset, false);
		}

		TextSpanDto Address(Group group, bool isRva) => new(group.Index, group.Length, "reference") {
			Color = TextColors.Comment,
			Address = new AddressDto(modulePath, isRva, long.Parse(group.Value.AsSpan(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture), 0),
		};
	}
}
