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
	/// <summary>
	/// With FullyQualifyAllTypes, whether the namespaces of the types are still imported — the fork's UsingDeclarations,
	/// which the package's own switch of that name cannot be while it is what qualifies the types.
	/// </summary>
	public bool FullyQualifiedTypesKeepUsings { get; set; } = true;
	/// <summary>
	/// FullyQualifyAmbiguousTypeNames: whether a name that would be ambiguous in the using scope keeps its
	/// namespace. The package always qualifies such a name (its IntroduceUsingDeclarations' last pass); when this is
	/// off, <see cref="DnSpyCSharpTransform"/> puts the simple name back, as the fork's transform does by not
	/// running that pass.
	/// </summary>
	public bool FullyQualifyAmbiguousTypeNames { get; set; } = true;
	/// <summary>
	/// AllowFieldInitializers: whether a leading assignment of a constructor is written as the field's (or
	/// auto-property's) initializer. The package always moves such an assignment; when this is off,
	/// <see cref="DnSpyCSharpTransform"/> moves it back into the constructors.
	/// </summary>
	public bool AllowFieldInitializers { get; set; } = true;
	/// <summary>
	/// EmitCalliAsInvocationExpression: whether calli is a function pointer call or, off, the fork's inline
	/// listing <c>calli(signature, pointer, args…)</c>. The package only writes the former.
	/// </summary>
	public bool EmitCalliAsInvocationExpression { get; set; }
	/// <summary>
	/// ForceShowAllMembers: whether compiler-generated types, methods and fields the decompiler would fold away
	/// are written too. The decompiler hides them through the feature settings (AnonymousMethods, AsyncAwait, …),
	/// which also drive its transforms, so the hidden members come from a second decompilation of the same nodes
	/// with those settings off; see WorkspaceManager's MergeHiddenMembers.
	/// </summary>
	public bool ForceShowAllMembers { get; set; }
	public bool RemoveEmptyDefaultConstructors { get; set; } = true;
	public bool InsertParenthesesForReadability { get; set; } = true;
	/// <summary>
	/// AlwaysGenerateExceptionVariableForCatchBlocksUnlessTypeIsObject: a catch clause whose exception is not used
	/// still names it (ex_XX, XX its handler's IL offset), as the fork's ILAstBuilder does, unless it catches object.
	/// </summary>
	public bool AlwaysGenerateExceptionVariableForCatchBlocksUnlessTypeIsObject { get; set; }
	/// <summary>
	/// MaxArrayElements: an array initializer of constants longer than this keeps this many elements, the last one
	/// replaced by the fork's "Not showing all elements" string (InitializerPeepholeTransforms).
	/// </summary>
	public int MaxArrayElements { get; set; } = 10000;
	/// <summary>MaxStringLength: a longer string literal is cut and ends with "[...string is too long...]".</summary>
	public int MaxStringLength { get; set; } = DefaultMaxStringLength;
	/// <summary>
	/// RemoveNewDelegateClass: <c>new EventHandler(M)</c> written as <c>M</c>. The package writes the method group
	/// wherever the conversion is implicit (UseImplicitMethodGroupConversion), which is the switch this one sets, and
	/// <see cref="DnSpyCSharpTransform"/> where a handler is added or removed, as the fork does; off, every delegate
	/// creation keeps its <c>new</c>, as the fork writes them with the option off.
	/// </summary>
	public bool RemoveNewDelegateClass {
		get => UseImplicitMethodGroupConversion;
		set => UseImplicitMethodGroupConversion = value;
	}

	/// <summary>The fork's DecompilerSettings.ConstMaxStringLength.</summary>
	public const int DefaultMaxStringLength = 20000;
	/// <summary>DecompilerSettings.DecompilationObjects: the order a type's members are written in, by kind.</summary>
	public IReadOnlyList<string> DecompilationOrder { get; set; } = DefaultDecompilationOrder;

	public static readonly IReadOnlyList<string> DefaultDecompilationOrder = ["nestedTypes", "fields", "events", "properties", "methods"];

	/// <summary>
	/// The settings a second decompilation runs with when ForceShowAllMembers is on: every feature whose switch
	/// also hides the compiler-generated types and members behind it is turned off, so the decompiler writes them.
	/// Only the members the first decompilation left out are taken from that tree, which is why turning the
	/// transforms off does not change the rest of the document.
	/// </summary>
	public DnSpyDecompilerSettings ForShowAllMembers() {
		var settings = (DnSpyDecompilerSettings)Clone();
		settings.AnonymousMethods = false;
		settings.YieldReturn = false;
		settings.AsyncAwait = false;
		settings.AsyncEnumerator = false;
		settings.LocalFunctions = false;
		settings.AnonymousTypes = false;
		settings.Dynamic = false;
		settings.FixedBuffers = false;
		settings.InlineArrays = false;
		settings.ExtensionMembers = false;
		settings.ArrayInitializers = false;
		settings.AutomaticProperties = false;
		settings.AutomaticEvents = false;
		settings.GetterOnlyAutomaticProperties = false;
		settings.SwitchStatementOnString = false;
		settings.FieldKeyword = false;
		settings.UsePrimaryConstructorSyntaxForNonRecordTypes = false;
		return settings;
	}
}

/// <summary>
/// The types written as simple names before ICSharpCode.Decompiler's <c>IntroduceUsingDeclarations</c> runs. Its
/// last pass replaces the names it finds ambiguous with namespace-qualified names; this is what tells that pass's
/// replacements from names the decompiler itself wrote qualified, so
/// <see cref="DnSpyCSharpTransform"/> can put the simple names back when FullyQualifyAmbiguousTypeNames is off.
/// </summary>
sealed class SimpleTypeCollector : IAstTransform {
	public HashSet<ICSharpCode.Decompiler.TypeSystem.IType> Types { get; } = [];

	public void Run(DecompilerAstNode rootNode, TransformContext context) {
		foreach (var simpleType in rootNode.DescendantsAndSelf.OfType<SimpleType>()) {
			if (simpleType.Annotation<TypeResolveResult>()?.Type is { } type)
				Types.Add(type);
		}
	}
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
sealed partial class DnSpyCSharpTransform(ModuleDef module, SimpleTypeCollector? simpleTypes = null) : IAstTransform {
	// The module being decompiled, in ILSpy's type system: only its entities are rows of `module`.
	ICSharpCode.Decompiler.TypeSystem.IModule? mainModule;

	public void Run(DecompilerAstNode rootNode, TransformContext context) {
		if (context.Settings is not DnSpyDecompilerSettings settings)
			return;
		mainModule = context.TypeSystem.MainModule;
		// The package always removes an empty parameterless constructor; putting it back first lets the
		// field-initializer pass below put its assignments into that one rather than making a second.
		if (!settings.RemoveEmptyDefaultConstructors) {
			foreach (var type in rootNode.DescendantsAndSelf.OfType<TypeDeclaration>().ToArray()) {
				if (Resolve(type) is TypeDef typeDef)
					AddRemovedConstructors(type, typeDef, context);
			}
		}
		if (!settings.AllowFieldInitializers) {
			foreach (var type in rootNode.DescendantsAndSelf.OfType<TypeDeclaration>().ToArray()) {
				if (Resolve(type) is TypeDef typeDef)
					MoveFieldInitializersBack(type, typeDef, context);
			}
		}
		foreach (var type in rootNode.DescendantsAndSelf.OfType<TypeDeclaration>().ToArray()) {
			if (Resolve(type) is not TypeDef typeDef)
				continue;
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
		if (!settings.EmitCalliAsInvocationExpression)
			WriteCalliAsInlineAssembly(rootNode);
		if (settings.RemoveNewDelegateClass)
			RemoveNewDelegateClass(rootNode);
		if (settings.AlwaysGenerateExceptionVariableForCatchBlocksUnlessTypeIsObject)
			NameUnusedExceptionVariables(rootNode);
		TruncateArrayInitializers(rootNode, settings.MaxArrayElements);
		if (settings.MaxStringLength > 0)
			TruncateStrings(rootNode, settings.MaxStringLength);
		if (!settings.FullyQualifyAmbiguousTypeNames && !settings.FullyQualifyAllTypes && simpleTypes is not null)
			RemoveAmbiguousTypeQualifications(rootNode, simpleTypes);
		if (settings.HexadecimalNumbers)
			WriteNumbersInHex(rootNode);
		if (settings.FullyQualifyAllTypes && settings.FullyQualifiedTypesKeepUsings)
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

	/// <summary>
	/// ConvertConstructorCallIntoInitializer without AllowFieldInitializers: the package has already moved a
	/// constructor's leading assignments to the field (or automatic property, or event) declarations. They are
	/// moved back to the start of the constructors that ran them — every instance constructor that does not chain
	/// to another with <c>this(...)</c>, the static constructor (made where the package removed an empty one). A
	/// constant's initializer is not a constructor assignment and stays.
	/// </summary>
	void MoveFieldInitializersBack(TypeDeclaration type, TypeDef typeDef, TransformContext context) {
		if (type.ClassType is ClassType.Interface or ClassType.Enum)
			return;
		var instanceAssignments = new List<Statement>();
		var staticAssignments = new List<Statement>();
		foreach (var member in type.Members.ToArray()) {
			switch (member) {
			case FieldDeclaration field:
				if (field.HasModifier(Modifiers.Const))
					break;
				foreach (var variable in field.Variables) {
					if (variable.Initializer is not { } initializer)
						continue;
					var isStatic = field.HasModifier(Modifiers.Static);
					(isStatic ? staticAssignments : instanceAssignments).Add(Assignment(type, variable.Name, initializer.Detach(), isStatic));
				}
				break;
			case PropertyDeclaration property when property.Initializer is not null && property.IsAutomaticProperty:
				var isStaticProperty = property.HasModifier(Modifiers.Static);
				(isStaticProperty ? staticAssignments : instanceAssignments).Add(Assignment(type, property.Name, property.Initializer.Detach(), isStaticProperty));
				break;
			case EventDeclaration @event:
				foreach (var variable in @event.Variables) {
					if (variable.Initializer is not { } initializer)
						continue;
					var isStaticEvent = @event.HasModifier(Modifiers.Static);
					(isStaticEvent ? staticAssignments : instanceAssignments).Add(Assignment(type, variable.Name, initializer.Detach(), isStaticEvent));
				}
				break;
			}
		}
		if (instanceAssignments.Count > 0) {
			var constructors = type.Members.OfType<ConstructorDeclaration>()
				.Where(constructor => !constructor.HasModifier(Modifiers.Static) && constructor.Initializer?.ConstructorInitializerType != ConstructorInitializerType.This)
				.ToList();
			if (constructors.Count == 0 && FindConstructor(typeDef, isStatic: false) is { } definition
				&& AddConstructor(type, definition, context) is { } added)
				constructors.Add(added);
			foreach (var constructor in constructors)
				Prepend(constructor, instanceAssignments);
		}
		if (staticAssignments.Count > 0) {
			var constructor = type.Members.OfType<ConstructorDeclaration>().FirstOrDefault(candidate => candidate.HasModifier(Modifiers.Static));
			if (constructor is null && FindConstructor(typeDef, isStatic: true) is { } definition)
				constructor = AddConstructor(type, definition, context);
			if (constructor is not null)
				Prepend(constructor, staticAssignments);
		}
	}

	/// <summary>The metadata constructor the package removed: the parameterless instance one or the static one.</summary>
	static MethodDef? FindConstructor(TypeDef type, bool isStatic) =>
		type.Methods.FirstOrDefault(method => isStatic
			? method.IsStaticConstructor
			: method.IsConstructor && !method.IsStatic && method.Parameters.Count(parameter => parameter.IsNormalMethodParameter) == 0);

	/// <summary>An empty declaration of a metadata constructor, as <see cref="AddRemovedConstructors"/> writes one.</summary>
	ConstructorDeclaration? AddConstructor(TypeDeclaration type, MethodDef definition, TransformContext context) {
		if (context.TypeSystem.MainModule is not ICSharpCode.Decompiler.TypeSystem.MetadataModule metadataModule)
			return null;
		ICSharpCode.Decompiler.TypeSystem.IMethod method;
		try {
			method = definition.IsStaticConstructor
				? metadataModule.GetDefinition(MetadataTokens.MethodDefinitionHandle((int)definition.Rid))
				: metadataModule.GetDefinition(MetadataTokens.MethodDefinitionHandle((int)definition.Rid));
		}
		catch (Exception) {
			return null;
		}
		if (context.TypeSystemAstBuilder.ConvertEntity(method) is not ConstructorDeclaration declaration)
			return null;
		declaration.Body = new BlockStatement();
		type.Members.Add(declaration);
		return declaration;
	}

	/// <summary>The assignments at the start of a constructor body, in the order the declarations had them.</summary>
	static void Prepend(ConstructorDeclaration constructor, IReadOnlyList<Statement> assignments) {
		constructor.Body ??= new BlockStatement();
		for (var i = assignments.Count - 1; i >= 0; i--)
			constructor.Body.Statements.InsertAfter(null, assignments[i]);
	}

	/// <summary>The assignment the initialization would have been: this.field = value, Type.field = value.</summary>
	static Statement Assignment(TypeDeclaration type, string name, Expression value, bool isStatic) {
		Expression target = isStatic
			? new MemberReferenceExpression(new TypeReferenceExpression { Type = TypeReference(type) }, name)
			: new MemberReferenceExpression(new ThisReferenceExpression(), name);
		return new ExpressionStatement(new AssignmentExpression(target, value));
	}

	/// <summary>The type's own name as it is written inside itself: Sample, Sample&lt;T&gt;.</summary>
	static AstType TypeReference(TypeDeclaration type) {
		if (type.TypeParameters.Count == 0)
			return new SimpleType(Identifier.Create(type.Name));
		var reference = new SimpleType(Identifier.Create(type.Name));
		foreach (var parameter in type.TypeParameters)
			reference.TypeArguments.Add(new SimpleType(Identifier.Create(parameter.Name)));
		return reference;
	}

	// ---------------------------------------------------------------- calli

	/// <summary>
	/// InlineAssembly for calli: without EmitCalliAsInvocationExpression the fork writes the signature as the first
	/// argument of an identifier named <c>calli</c> — <c>calli(System.Void(System.IntPtr), ptr, args…)</c> — instead
	/// of the function pointer invocation the package writes.
	/// </summary>
	static void WriteCalliAsInlineAssembly(DecompilerAstNode root) {
		foreach (var invocation in root.DescendantsAndSelf.OfType<InvocationExpression>().ToArray()) {
			if (invocation.Annotation<ICSharpCode.Decompiler.IL.CallIndirect>() is not { } calli)
				continue;
			var inline = new InvocationExpression(new IdentifierExpression("calli"));
			inline.Arguments.Add(new IdentifierExpression(CalliSignature(calli.FunctionPointerType)));
			// The fork's InlineAssembly: the arguments in IL stack order, the function pointer on top last.
			foreach (var argument in invocation.Arguments.ToArray())
				inline.Arguments.Add(argument.Detach());
			inline.Arguments.Add(invocation.Target.Detach());
			invocation.ReplaceWith(inline);
		}
	}

	/// <summary>
	/// Dnlib's GetMethodSigFullName: the return type and parameters with their full names —
	/// <c>System.Void(System.IntPtr)</c>.
	/// </summary>
	static string CalliSignature(ICSharpCode.Decompiler.TypeSystem.FunctionPointerType type) {
		var text = new System.Text.StringBuilder();
		text.Append(FullName(type.ReturnType)).Append('(');
		for (var i = 0; i < type.ParameterTypes.Length; i++) {
			if (i > 0)
				text.Append(',');
			text.Append(FullName(type.ParameterTypes[i]));
		}
		return text.Append(')').ToString();
	}

	/// <summary>The full name dnlib's FullNameFactory writes for a type: System.Int32, System.Int32[], …</summary>
	static string FullName(ICSharpCode.Decompiler.TypeSystem.IType type) {
		switch (type) {
		case ICSharpCode.Decompiler.TypeSystem.ByReferenceType byReference:
			return FullName(byReference.ElementType) + "&";
		case ICSharpCode.Decompiler.TypeSystem.PointerType pointer:
			return FullName(pointer.ElementType) + "*";
		case ICSharpCode.Decompiler.TypeSystem.ArrayType array:
			return FullName(array.ElementType) + "[" + new string(',', Math.Max(0, array.Dimensions - 1)) + "]";
		case ICSharpCode.Decompiler.TypeSystem.ParameterizedType parameterized:
			return FullName(parameterized.GenericType) + "<" + string.Join(",", parameterized.TypeArguments.Select(FullName)) + ">";
		case ICSharpCode.Decompiler.TypeSystem.ITypeParameter parameter:
			return parameter.OwnerType == ICSharpCode.Decompiler.TypeSystem.SymbolKind.Method ? "!!" + parameter.Index : "!" + parameter.Index;
		case ICSharpCode.Decompiler.TypeSystem.FunctionPointerType functionPointer:
			return CalliSignature(functionPointer);
		case ICSharpCode.Decompiler.TypeSystem.ITypeDefinition definition:
			return DefinitionName(definition);
		default:
			return type.FullName;
		}
	}

	static string DefinitionName(ICSharpCode.Decompiler.TypeSystem.ITypeDefinition definition) {
		var declaringType = definition.DeclaringTypeDefinition;
		if (declaringType is not null)
			return DefinitionName(declaringType) + "." + definition.Name;
		return string.IsNullOrEmpty(definition.Namespace) ? definition.Name : definition.Namespace + "." + definition.Name;
	}

	// ---------------------------------------------------------------- Delegates, catch variables, arrays and strings

	/// <summary>
	/// RemoveNewDelegateClass: DelegateConstruction writes the method group alone where a handler is added or removed —
	/// <c>button.Click += Button_Click</c> — which the package keeps as <c>new EventHandler(Button_Click)</c>.
	/// </summary>
	static void RemoveNewDelegateClass(DecompilerAstNode root) {
		foreach (var assignment in root.Descendants.OfType<AssignmentExpression>().ToArray()) {
			if (assignment.Operator is not (AssignmentOperatorType.Add or AssignmentOperatorType.Subtract))
				continue;
			if (assignment.Right is not ObjectCreateExpression { Arguments.Count: 1 } creation)
				continue;
			if (creation.GetResolveResult() is not ConversionResolveResult { Conversion.IsMethodGroupConversion: true })
				continue;
			var method = creation.Arguments.Single();
			method.Remove();
			creation.ReplaceWith(method);
		}
	}

	/// <summary>
	/// AlwaysGenerateExceptionVariableForCatchBlocksUnlessTypeIsObject: ILAstBuilder.ConvertExceptionVariable names the
	/// exception of a handler that only pops it <c>ex_XX</c>, XX the handler's IL offset in hex, when the clause catches
	/// something other than object. The package leaves such a clause without a name.
	/// </summary>
	static void NameUnusedExceptionVariables(DecompilerAstNode root) {
		foreach (var clause in root.Descendants.OfType<CatchClause>()) {
			if (!string.IsNullOrEmpty(clause.VariableName) || clause.Type is null)
				continue;
			if (clause.Type is PrimitiveType { Keyword: "object" })
				continue;
			if (clause.Annotation<ICSharpCode.Decompiler.IL.TryCatchHandler>() is not { } handler)
				continue;
			var offset = handler.StartILOffset;
			if (offset == 0 && handler.Body is { } body)
				offset = body.StartILOffset;
			clause.VariableName = "ex_" + offset.ToString("X2", CultureInfo.InvariantCulture);
		}
	}

	/// <summary>
	/// MaxArrayElements: InitializerPeepholeTransforms decodes at most that many elements of an array's initial data;
	/// when there were more, the last one it keeps is the message that says so. The data arrays are the initializers
	/// of constants, which is what this cuts.
	/// </summary>
	static void TruncateArrayInitializers(DecompilerAstNode root, int maxElements) {
		var limit = Math.Max(0, maxElements);
		foreach (var creation in root.Descendants.OfType<ArrayCreateExpression>().ToArray()) {
			if (creation.Initializer is not { } initializer)
				continue;
			var elements = initializer.Elements;
			if (elements.Count <= limit || !elements.All(IsConstant))
				continue;
			var count = elements.Count;
			foreach (var element in elements.Skip(limit).ToArray())
				element.Remove();
			if (limit > 0)
				elements.Last().ReplaceWith(new PrimitiveExpression(string.Format(CultureInfo.InvariantCulture, "Not showing all elements because this array is too big ({0} elements)", count)));
		}

		static bool IsConstant(Expression expression) => expression switch {
			PrimitiveExpression => true,
			UnaryOperatorExpression { Operator: UnaryOperatorType.Minus, Expression: PrimitiveExpression } => true,
			_ => false,
		};
	}

	/// <summary>
	/// MaxStringLength: TextTokenWriter.WritePrimitiveValue writes a longer string's first characters and
	/// "[...string is too long...]" after them (ConvertStringMaxLength).
	/// </summary>
	static void TruncateStrings(DecompilerAstNode root, int maxLength) {
		foreach (var primitive in root.Descendants.OfType<PrimitiveExpression>()) {
			if (primitive.Value is string text && text.Length > maxLength)
				primitive.Value = text[..maxLength] + "[...string is too long...]";
		}
	}

	// ---------------------------------------------------------------- Ambiguous type names

	/// <summary>
	/// FullyQualifyAmbiguousTypeNames off: the package's IntroduceUsingDeclarations qualifies every simple type name
	/// that its pass finds ambiguous. It runs after <see cref="SimpleTypeCollector"/>, so the names that were simple
	/// before it are known; their qualified replacements are written simple again, the way the fork's transform
	/// writes them when the option is off. The namespace is already one of the using declarations.
	/// </summary>
	static void RemoveAmbiguousTypeQualifications(DecompilerAstNode root, SimpleTypeCollector simpleTypes) {
		if (simpleTypes.Types.Count == 0)
			return;
		foreach (var type in root.DescendantsAndSelf.OfType<AstType>().Where(node => node.Parent is not AstType).ToArray()) {
			if (type.Annotation<TypeResolveResult>()?.Type is not { } resolved || !simpleTypes.Types.Contains(resolved))
				continue;
			if (StripNamespace(type, resolved.Namespace) is { } replacement)
				type.ReplaceWith(replacement);
		}
	}

	/// <summary>
	/// The type with its namespace segments removed, or null when the node is not written namespace-qualified.
	/// The type-name segments themselves (nested types included) and their type arguments and annotations stay.
	/// </summary>
	static AstType? StripNamespace(AstType type, string? @namespace) {
		if (string.IsNullOrEmpty(@namespace))
			return null;
		var names = new List<string>();
		for (var node = type; ;) {
			switch (node) {
			case MemberType memberNode:
				names.Add(memberNode.MemberName);
				node = memberNode.Target;
				break;
			case SimpleType simpleNode when simpleNode.Identifier is { } identifier:
				names.Add(identifier);
				node = null;
				break;
			default:
				return null;
			}
			if (node is null)
				break;
		}
		var parts = @namespace.Split('.');
		if (names.Count <= parts.Length)
			return null;
		for (var i = 0; i < parts.Length; i++) {
			if (names[names.Count - 1 - i] != parts[i])
				return null;
		}
		// Rebuild the type-name segments, innermost first: the namespace-qualified chain is
		// Ns.Outer.Inner, so the last `parts.Length` names are the namespace.
		var segments = new List<AstType>();
		for (var node = type; segments.Count < names.Count - parts.Length; node = ((MemberType)node).Target)
			segments.Add(node);
		AstType rebuilt;
		var innermost = segments[^1];
		rebuilt = innermost is MemberType innermostMember
			? new SimpleType(Identifier.Create(innermostMember.MemberName))
			: new SimpleType(Identifier.Create(((SimpleType)innermost).Identifier!));
		Copy(innermost, rebuilt);
		for (var i = segments.Count - 2; i >= 0; i--) {
			var segment = (MemberType)segments[i];
			var memberType = new MemberType { Target = rebuilt, MemberName = segment.MemberName, IsDoubleColon = segment.IsDoubleColon };
			Copy(segment, memberType);
			rebuilt = memberType;
		}
		return rebuilt;
	}

	/// <summary>The annotations and type arguments of a type-name segment, which carry its references and colors.</summary>
	static void Copy(AstType from, AstType to) {
		to.CopyAnnotationsFrom(from);
		var arguments = from switch {
			SimpleType simple => simple.TypeArguments,
			MemberType member => member.TypeArguments,
			_ => null,
		};
		var target = to switch {
			SimpleType simple => simple.TypeArguments,
			MemberType member => member.TypeArguments,
			_ => null,
		};
		if (arguments is null || target is null)
			return;
		foreach (var argument in arguments.ToArray())
			target.Add(argument.Detach());
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
	/// The pipeline this transform belongs to: the simple-name collector ahead of ICSharpCode.Decompiler's
	/// IntroduceUsingDeclarations when FullyQualifyAmbiguousTypeNames is off, and the transform itself last.
	/// </summary>
	public static void AddTo(CSharpDecompiler decompiler, ModuleDef module, DecompilerSettings settings) {
		SimpleTypeCollector? collector = null;
		if (settings is DnSpyDecompilerSettings { FullyQualifyAmbiguousTypeNames: false }) {
			collector = new SimpleTypeCollector();
			var transforms = decompiler.AstTransforms;
			var index = -1;
			for (var i = 0; i < transforms.Count; i++) {
				if (transforms[i] is ICSharpCode.Decompiler.CSharp.Transforms.IntroduceUsingDeclarations) {
					index = i;
					break;
				}
			}
			transforms.Insert(index < 0 ? transforms.Count : index, collector);
		}
		decompiler.AstTransforms.Add(new DnSpyCSharpTransform(module, collector));
	}

	/// <summary>
	/// IntroduceUsingDeclarations' order: with SortSystemUsingStatementsFirst, the System namespaces first and each
	/// half alphabetically; without it, all of them alphabetically — both ignoring case.
	/// </summary>
	internal static void SortUsings(DecompilerAstNode root, bool systemFirst) {
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
