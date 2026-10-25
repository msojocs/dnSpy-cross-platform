using System.Globalization;
using dnSpy.Backend.Contracts;
using ICorDebugSharp;
using ICorDebugSharp.Extensions;
using Microsoft.CodeAnalysis;

namespace dnSpy.Backend.Debugging.CorDebug.Evaluation;

/// <summary>
/// One row of a variables window — Locals, Autos, Watch, Static Fields — the port of dnSpy's
/// <c>DbgValueNode</c>: a name, a value and a type, each as coloured text, the expression the row stands for,
/// and the rows it expands to.
/// </summary>
internal sealed class ValueNode {
	public required List<TextPartDto> Name { get; init; }

	public List<TextPartDto> Value { get; set; } = [];

	public List<TextPartDto> Type { get; set; } = [];

	/// <summary>The expression the row re-evaluates as: what Add Watch and Copy Expression use. Empty for a group row.</summary>
	public string Expression { get; init; } = string.Empty;

	/// <summary>The dnSpy image the row is drawn with (<c>FieldPublic</c>, <c>Property</c>, <c>Local</c>…).</summary>
	public string Image { get; init; } = "FieldPublic";

	public string Kind { get; init; } = "data";

	public EvalValue? EvalValue { get; init; }

	/// <summary>The type the slot is declared as, which the Type column writes before an actual type that differs.</summary>
	public ITypeSymbol? DeclaredType { get; init; }

	public bool IsError { get; init; }

	/// <summary>The row's value can be edited: it is a variable, a field, an array element or a settable property.</summary>
	public bool CanEditValue { get; init; }

	/// <summary>The value was not computed because the expression has side effects; the row offers a refresh instead.</summary>
	public bool NeedsRefresh { get; init; }

	public NodeChildren? Children { get; set; }

	/// <summary>The object id the value has been given, "$1", when it has one.</summary>
	public string? ObjectId { get; set; }

	/// <summary>The value as Copy Value writes it.</summary>
	public string? EditText { get; set; }

	/// <summary>The address of the value's raw bytes, when the runtime gives one — what Save and Show in
	/// Memory Window act on. Hex, because a 64-bit address does not survive a JSON number.</summary>
	public string? Address { get; set; }

	/// <summary>How many bytes the value occupies, with <see cref="Address"/>.</summary>
	public int? Size { get; set; }
}

/// <summary>How a row's children are made, run when the row is expanded.</summary>
internal abstract class NodeChildren {
	public abstract Task<IReadOnlyList<ValueNode>> CreateAsync(NodeFactory factory, int start, int count);

	/// <summary>How many children there are, when that is known without making them (an array's length).</summary>
	public virtual Task<int?> CountAsync(NodeFactory factory) => Task.FromResult<int?>(null);
}

/// <summary>
/// Makes rows out of values. It knows the language the rows are written in, the window's display options, and
/// how to evaluate an expression against an object for its DebuggerDisplay.
/// </summary>
internal sealed class NodeFactory {
	public NodeFactory(EvalRuntime runtime, ValueFormatOptions options, Func<string, EvalValue, Task<(EvalValue Value, IReadOnlyList<string> Specifiers)>> evaluateInObject, ObjectIdTable objectIds) {
		Runtime = runtime;
		Options = options;
		EvaluateInObject = evaluateInObject;
		ObjectIds = objectIds;
	}

	public EvalRuntime Runtime { get; }

	public ValueFormatOptions Options { get; }

	public Func<string, EvalValue, Task<(EvalValue Value, IReadOnlyList<string> Specifiers)>> EvaluateInObject { get; }

	public ObjectIdTable ObjectIds { get; }

	public bool IsCSharp => Options.Language == EvalLanguage.CSharp;

	public ValueFormatter Formatter(ValueFormatOptions? options = null) => new(Runtime, options ?? Options, EvaluateInObject);

	public NodeFactory With(ValueFormatOptions options) => new(Runtime, options, EvaluateInObject, ObjectIds);

	// ---------------------------------------------------------------- text

	public static List<TextPartDto> Text(string color, string text) => [new TextPartDto(text, color)];

	public static List<TextPartDto> PlainName(string text) => Text(TextColors.Text, text);

	/// <summary>The expression without its format specifiers, so a member access can be appended to it.</summary>
	public static string StripSpecifiers(string expression, EvalLanguage language) =>
		ExpressionCompiler.SplitFormatSpecifiers(expression, language).Expression;

	/// <summary>Parentheses around an expression that a member access would otherwise bind into.</summary>
	static string Parenthesize(string expression) {
		foreach (var c in expression) {
			if (!(char.IsLetterOrDigit(c) || c is '_' or '.' or '$' or '[' or ']' or '@'))
				return "(" + expression + ")";
		}
		return expression;
	}

	public string MemberExpression(string parent, string member, ITypeSymbol? castTo) {
		if (parent.Length == 0)
			return string.Empty;
		var receiver = StripSpecifiers(parent, Options.Language);
		if (castTo is not null)
			receiver = IsCSharp
				? $"(({TypeExpression(castTo)}){receiver})"
				: $"DirectCast({receiver}, {TypeExpression(castTo)})";
		else
			receiver = Parenthesize(receiver);
		return receiver + "." + Formatter().EscapeIdentifier(member);
	}

	public string ElementExpression(string parent, IReadOnlyList<long> indices) {
		if (parent.Length == 0)
			return string.Empty;
		var list = string.Join(", ", indices.Select(index => index.ToString(CultureInfo.InvariantCulture)));
		return Parenthesize(StripSpecifiers(parent, Options.Language)) + (IsCSharp ? "[" + list + "]" : "(" + list + ")");
	}

	/// <summary>A type as source text: namespaces and keywords, so the expression binds wherever it is pasted.</summary>
	public string TypeExpression(ITypeSymbol type) =>
		ColorTextWriter.ToText(With(Options with { ShowNamespaces = true, IntrinsicTypeKeywords = true, ShowTokens = false }).Formatter().FormatTypeName(type));

	// ---------------------------------------------------------------- rows

	/// <summary>A row for a value: its value and type text, and what it expands to.</summary>
	public async Task<ValueNode> CreateAsync(List<TextPartDto> name, string expression, EvalValue value, ITypeSymbol? declaredType, string image, string kind, bool canEdit, ValueFormatOptions? options = null) {
		var factory = options is null ? this : With(options);
		var formatter = factory.Formatter();
		var valueText = await formatter.FormatValueAsync(value).ConfigureAwait(false);
		var typeText = await factory.FormatTypeColumnAsync(value, declaredType).ConfigureAwait(false);
		var node = new ValueNode {
			Name = name,
			Value = valueText,
			Type = typeText,
			Expression = expression,
			Image = value.IsException ? "ExceptionPublic" : image,
			Kind = kind,
			EvalValue = value,
			DeclaredType = declaredType,
			CanEditValue = canEdit && expression.Length > 0,
			Children = factory.ChildrenOf(value, expression),
		};
		if (value is RemoteValue remote) {
			node.ObjectId = ObjectIds.Find(Runtime, remote);
			SetAddress(node, remote.Object);
		}
		else if (value is ScalarValue { Origin: { } origin }) {
			node.ObjectId = ObjectIds.Find(Runtime, origin);
			SetAddress(node, origin.Object);
		}
		return node;
	}

	/// <summary>GetRawAddressValue: the address and size of the value itself, never of the reference to it.</summary>
	static void SetAddress(ValueNode node, ICorDebugValue value) {
		try {
			node.Address = "0x" + value.Address.Value.ToString("X", CultureInfo.InvariantCulture);
			node.Size = (int)value.Size;
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
		}
	}

	/// <summary>A row that could not be evaluated: the error is its value.</summary>
	public static ValueNode Error(List<TextPartDto> name, string expression, string message, string image = "StatusError") => new() {
		Name = name,
		Value = Text(TextColors.Error, message),
		Expression = expression,
		Image = image,
		Kind = "error",
		IsError = true,
	};

	/// <summary>A row for a call that threw: "'X' threw an exception of type 'Y'", expandable to the exception.</summary>
	public async Task<ValueNode> CreateThrownAsync(List<TextPartDto> name, string expression, EvaluationThrownException thrown, string image) {
		var node = await CreateAsync(name, expression, thrown.ExceptionValue, null, image, "exception", false).ConfigureAwait(false);
		node.Value = Text(TextColors.Error, ValueFormatter.DescribeThrown(thrown));
		return node;
	}

	/// <summary>Evaluates one member or element and makes its row, catching what the evaluation throws.</summary>
	public async Task<ValueNode> CreateSafeAsync(List<TextPartDto> name, string expression, Func<Task<EvalValue>> read, ITypeSymbol? declaredType, string image, string kind, bool canEdit) {
		try {
			var value = await read().ConfigureAwait(false);
			return await CreateAsync(name, expression, value, declaredType, image, kind, canEdit).ConfigureAwait(false);
		}
		catch (EvaluationThrownException thrown) {
			return await CreateThrownAsync(name, expression, thrown, image).ConfigureAwait(false);
		}
		catch (EvaluationException ex) {
			var node = Error(name, expression, ex.Message, image);
			return node;
		}
	}

	/// <summary>
	/// The Type column: the declared type, then the actual one in braces when it differs —
	/// <c>object {int}</c>, <c>IWorker {Worker}</c>.
	/// </summary>
	public async Task<List<TextPartDto>> FormatTypeColumnAsync(EvalValue value, ITypeSymbol? declaredType) {
		var formatter = Formatter();
		if (value is RemoteValue remote && Options.FuncEval && Options.UseDebuggerDisplay) {
			var custom = new ColorTextWriter();
			if (await formatter.TryFormatDebuggerDisplayAsync(custom, remote, ValueFormatter.DisplayPart.Type).ConfigureAwait(false))
				return custom.ToList();
		}
		var actual = value.Type;
		// A Nullable<T> shows as its value, and its type as the nullable type it is declared as.
		if (declaredType is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } nullable && SymbolEqualityComparer.Default.Equals(nullable.TypeArguments[0], actual))
			return formatter.FormatTypeName(declaredType);
		if (declaredType is null || declaredType is IDynamicTypeSymbol || SymbolEqualityComparer.Default.Equals(declaredType, actual) || value.IsNull)
			return await formatter.FormatTypeAsync(declaredType is not null && value.IsNull ? declaredType : actual, value, showArraySizes: false).ConfigureAwait(false);
		var output = new ColorTextWriter();
		output.Write(formatter.FormatTypeName(declaredType));
		output.Write(TextColors.Text, " ");
		output.Write(TextColors.Punctuation, "{");
		output.Write(await formatter.FormatTypeAsync(actual, value, showArraySizes: false).ConfigureAwait(false));
		output.Write(TextColors.Punctuation, "}");
		return output.ToList();
	}

	// ---------------------------------------------------------------- children

	/// <summary>dnSpy's <c>DbgDotNetValueNodeProviderFactory.CreateCore</c>: what a value expands to.</summary>
	public NodeChildren? ChildrenOf(EvalValue value, string expression) {
		if (value is not RemoteValue remote || value.IsNull)
			return null;
		var type = remote.Type;
		if (Options.ResultsViewOnly)
			return EnumerableTypeOf(type) is { } enumerable ? new ResultsViewChildren(remote, enumerable, expression) : null;
		if (Options.DynamicViewOnly)
			return IsDynamicViewType(type) ? new DynamicViewChildren(remote, expression) : null;
		if (type is IArrayTypeSymbol)
			return new ArrayChildren(remote, expression);
		if (type is IPointerTypeSymbol)
			return null;
		return new ObjectChildren(remote, expression, Options.RawView);
	}

	/// <summary>The IEnumerable a type implements, generic one preferred — what the Results View enumerates.</summary>
	public INamedTypeSymbol? EnumerableTypeOf(ITypeSymbol type) {
		if (type is IArrayTypeSymbol || type.SpecialType == SpecialType.System_String)
			return null;
		INamedTypeSymbol? nonGeneric = null;
		foreach (var candidate in new[] { type }.Concat(type.AllInterfaces)) {
			if (candidate is not INamedTypeSymbol named)
				continue;
			if (named.OriginalDefinition.SpecialType == SpecialType.System_Collections_Generic_IEnumerable_T)
				return named;
			if (named.SpecialType == SpecialType.System_Collections_IEnumerable)
				nonGeneric = named;
		}
		return nonGeneric;
	}

	public static bool IsDynamicViewType(ITypeSymbol type) =>
		type.AllInterfaces.Any(candidate => candidate.ContainingType is null && candidate.Name == "IDynamicMetaObjectProvider" && candidate.ContainingNamespace?.ToDisplayString() == "System.Dynamic");
}

/// <summary>An array's elements, <c>[0]</c> to <c>[n-1]</c>, or <c>[0, 0]</c>… for a multi-dimensional one.</summary>
internal sealed class ArrayChildren(RemoteValue array, string expression) : NodeChildren {
	public override async Task<int?> CountAsync(NodeFactory factory) {
		var (dimensions, _) = await factory.Runtime.ReadArrayShapeAsync(array).ConfigureAwait(false);
		return (int)dimensions.Aggregate(1L, (total, length) => total * length);
	}

	public override async Task<IReadOnlyList<ValueNode>> CreateAsync(NodeFactory factory, int start, int count) {
		var (dimensions, lowerBounds) = await factory.Runtime.ReadArrayShapeAsync(array).ConfigureAwait(false);
		var total = dimensions.Aggregate(1L, (product, length) => product * length);
		var elementType = (array.Type as IArrayTypeSymbol)?.ElementType;
		var nodes = new List<ValueNode>();
		for (var position = (long)start; position < total && position < (long)start + count; position++) {
			// The position in row-major order, turned back into one index per dimension.
			var indices = new long[dimensions.Length];
			var rest = position;
			for (var dimension = dimensions.Length - 1; dimension >= 0; dimension--) {
				indices[dimension] = rest % dimensions[dimension] + lowerBounds[dimension];
				rest /= dimensions[dimension];
			}
			var name = new ColorTextWriter();
			name.Write(TextColors.Punctuation, factory.IsCSharp ? "[" : "(");
			for (var dimension = 0; dimension < indices.Length; dimension++) {
				if (dimension > 0)
					name.Write(TextColors.Punctuation, ",").Write(TextColors.Text, " ");
				name.Write(TextColors.Number, indices[dimension].ToString(CultureInfo.InvariantCulture));
			}
			name.Write(TextColors.Punctuation, factory.IsCSharp ? "]" : ")");
			var captured = indices;
			nodes.Add(await factory.CreateSafeAsync(name.ToList(), factory.ElementExpression(expression, captured), () => factory.Runtime.ReadElementAsync(array, captured), elementType, "FieldPublic", "arrayElement", canEdit: true).ConfigureAwait(false));
		}
		return nodes;
	}
}

/// <summary>One field or property row's facts, the port of dnSpy's <c>MemberValueNodeInfo</c>.</summary>
internal sealed record MemberInfo(ISymbol Member, int InheritanceLevel, bool IsPublic, bool IsCompilerGenerated, bool BrowsableNever, bool BrowsableRootHidden, bool DeprecatedError, bool NeedCast);

/// <summary>
/// An object's members: its properties, then its fields, inherited ones included, with a "Static members"
/// row for its statics and a "Results View" when it is enumerable — or what its DebuggerTypeProxy shows,
/// with the object's own members behind a "Raw View" row.
/// </summary>
internal sealed class ObjectChildren(RemoteValue value, string expression, bool rawView, bool publicOnly = false, bool skipProxy = false) : NodeChildren {
	public override async Task<IReadOnlyList<ValueNode>> CreateAsync(NodeFactory factory, int start, int count) {
		var nodes = new List<ValueNode>();
		var options = factory.Options;
		var type = value.Type;
		// A tuple shows its elements by name, then everything else behind Raw View.
		if (!rawView && ValueFormatter.TupleArity(type) > 0 && type is INamedTypeSymbol tuple) {
			var index = 0;
			foreach (var path in ValueFormatter.TupleFields(tuple)) {
				index++;
				var itemName = "Item" + index.ToString(CultureInfo.InvariantCulture);
				var itemExpression = factory.MemberExpression(expression, itemName, null);
				var fields = path;
				nodes.Add(await factory.CreateSafeAsync(NodeFactory.Text(TextColors.InstanceField, itemName), itemExpression, async () => {
					EvalValue current = value;
					foreach (var field in fields)
						current = await factory.Runtime.ReadFieldAsync(current, field).ConfigureAwait(false);
					return current;
				}, fields[^1].Type, "FieldPublic", "field", canEdit: true).ConfigureAwait(false));
			}
			nodes.Add(RawViewRow(factory));
			return Page(nodes, start, count);
		}
		if (!rawView && !skipProxy && options.FuncEval && FindProxyConstructor(type) is { } proxyConstructor) {
			try {
				var proxy = await factory.Runtime.NewObjectAsync(proxyConstructor, [value]).ConfigureAwait(false);
				if (proxy is RemoteValue remoteProxy) {
					var proxyExpression = $"new {factory.TypeExpression(proxyConstructor.ContainingType)}({NodeFactory.StripSpecifiers(expression, options.Language)})";
					var proxyChildren = new ObjectChildren(remoteProxy, expression.Length == 0 ? string.Empty : proxyExpression, rawView: false, publicOnly: true, skipProxy: true);
					nodes.AddRange(await proxyChildren.CreateAsync(factory, 0, int.MaxValue).ConfigureAwait(false));
					nodes.Add(RawViewRow(factory));
					return Page(nodes, start, count);
				}
			}
			catch (EvaluationException) {
			}
			catch (EvaluationThrownException) {
			}
		}
		var (instanceMembers, staticMembers) = CollectMembers(type, options, rawView, publicOnly);
		var hasHidden = !rawView && (instanceMembers.Any(member => member.BrowsableRootHidden) || HadNever);
		foreach (var member in instanceMembers) {
			if (!rawView && member.BrowsableRootHidden) {
				// A RootHidden member shows its own children in its place.
				try {
					var hiddenValue = await ReadAsync(factory, member, value).ConfigureAwait(false);
					var hiddenExpression = MemberExpressionOf(factory, member);
					if (factory.ChildrenOf(hiddenValue, hiddenExpression) is { } hiddenChildren)
						nodes.AddRange(await hiddenChildren.CreateAsync(factory, 0, int.MaxValue).ConfigureAwait(false));
				}
				catch (EvaluationException) {
				}
				catch (EvaluationThrownException) {
				}
				continue;
			}
			nodes.Add(await MemberRowAsync(factory, member).ConfigureAwait(false));
		}
		if (staticMembers.Count > 0)
			nodes.Add(StaticMembersRow(factory, type, staticMembers));
		if (factory.EnumerableTypeOf(type) is { } enumerable && options.FuncEval)
			nodes.Add(ResultsViewRow(factory, enumerable));
		if (NodeFactory.IsDynamicViewType(type) && options.FuncEval)
			nodes.Add(DynamicViewRow(factory));
		if (hasHidden)
			nodes.Add(RawViewRow(factory));
		return Page(nodes, start, count);
	}

	bool HadNever { get; set; }

	static IReadOnlyList<ValueNode> Page(List<ValueNode> nodes, int start, int count) =>
		start <= 0 && count >= nodes.Count ? nodes : nodes.Skip(start).Take(count).ToArray();

	ValueNode RawViewRow(NodeFactory factory) => new() {
		Name = NodeFactory.PlainName("Raw View"),
		Expression = expression.Length == 0 ? string.Empty : NodeFactory.StripSpecifiers(expression, factory.Options.Language) + ", raw",
		Image = "FieldPublic",
		Kind = "rawView",
		Children = new ObjectChildren(value, expression.Length == 0 ? string.Empty : NodeFactory.StripSpecifiers(expression, factory.Options.Language) + ", raw", rawView: true),
	};

	ValueNode StaticMembersRow(NodeFactory factory, ITypeSymbol type, IReadOnlyList<MemberInfo> members) => new() {
		Name = NodeFactory.PlainName(factory.IsCSharp ? "Static members" : "Shared members"),
		Expression = string.Empty,
		Image = "ClassPublic",
		Kind = "staticMembers",
		Children = new StaticMembersChildren(type, members),
	};

	ValueNode ResultsViewRow(NodeFactory factory, INamedTypeSymbol enumerable) => new() {
		Name = NodeFactory.Text(ColorTextWriter.DebugViewPropertyName, "Results View"),
		Value = NodeFactory.Text(TextColors.Text, "Expanding the Results View will enumerate the IEnumerable"),
		Expression = expression.Length == 0 ? string.Empty : NodeFactory.StripSpecifiers(expression, factory.Options.Language) + ", results",
		Image = "MethodPublic",
		Kind = "resultsView",
		Children = new ResultsViewChildren(value, enumerable, expression),
	};

	ValueNode DynamicViewRow(NodeFactory factory) => new() {
		Name = NodeFactory.Text(ColorTextWriter.DebugViewPropertyName, "Dynamic View"),
		Value = NodeFactory.Text(TextColors.Text, "Expanding the Dynamic View will get the dynamic members for the object"),
		Expression = expression.Length == 0 ? string.Empty : NodeFactory.StripSpecifiers(expression, factory.Options.Language) + ", dynamic",
		Image = "MethodPublic",
		Kind = "dynamicView",
		Children = new DynamicViewChildren(value, expression),
	};

	string MemberExpressionOf(NodeFactory factory, MemberInfo member) =>
		factory.MemberExpression(expression, member.Member.Name, member.NeedCast ? member.Member.ContainingType : null);

	async Task<ValueNode> MemberRowAsync(NodeFactory factory, MemberInfo member) {
		var name = new ColorTextWriter();
		var formatter = factory.Formatter();
		name.Write(ValueFormatter.ColorOf(member.Member), formatter.EscapeIdentifier(member.Member.Name));
		if (member.NeedCast) {
			name.Write(TextColors.Text, " ").Write(TextColors.Punctuation, "(");
			name.Write(formatter.FormatTypeName(member.Member.ContainingType));
			name.Write(TextColors.Punctuation, ")");
		}
		var memberExpression = MemberExpressionOf(factory, member);
		var (image, memberType, canEdit) = member.Member switch {
			IFieldSymbol field => (FieldImage(field), field.Type, !field.IsConst && !field.IsReadOnly),
			IPropertySymbol property => (PropertyImage(property), property.Type, property.SetMethod is not null),
			_ => ("FieldPublic", null as ITypeSymbol, false),
		};
		if (member.Member is IPropertySymbol && !factory.Options.FuncEval)
			return NodeFactory.Error(name.ToList(), memberExpression, "Implicit function evaluation is turned off by the user.", image);
		return await factory.CreateSafeAsync(name.ToList(), memberExpression, () => ReadAsync(factory, member, value), memberType, image, member.Member is IFieldSymbol ? "field" : "property", canEdit).ConfigureAwait(false);
	}

	internal static async Task<EvalValue> ReadAsync(NodeFactory factory, MemberInfo member, EvalValue? instance) => member.Member switch {
		IFieldSymbol field => await factory.Runtime.ReadFieldAsync(field.IsStatic ? null : instance, field).ConfigureAwait(false),
		IPropertySymbol { GetMethod: { } getter } property => await factory.Runtime.CallAsync(getter, property.IsStatic ? null : instance, [], property.Name).ConfigureAwait(false),
		_ => throw new EvaluationException("The member cannot be read."),
	};

	internal static string FieldImage(IFieldSymbol field) {
		var prefix = field.IsConst ? (field.ContainingType.TypeKind == TypeKind.Enum ? "EnumerationItem" : "Constant") : "Field";
		return prefix + AccessSuffix(field.DeclaredAccessibility, prefix == "Field" ? "FieldPublic" : prefix + "Public");
	}

	internal static string PropertyImage(IPropertySymbol property) {
		var accessor = property.GetMethod ?? property.SetMethod;
		return accessor?.DeclaredAccessibility switch {
			Accessibility.Public => "Property",
			Accessibility.Private => "PropertyPrivate",
			Accessibility.Protected => "PropertyProtected",
			Accessibility.Internal or Accessibility.ProtectedAndInternal => "PropertyInternal",
			Accessibility.ProtectedOrInternal => "PropertyShortcut",
			_ => "Property",
		};
	}

	static string AccessSuffix(Accessibility accessibility, string publicImage) {
		var prefix = publicImage.EndsWith("Public", StringComparison.Ordinal) ? publicImage[..^"Public".Length] : publicImage;
		return accessibility switch {
			Accessibility.Public => publicImage[prefix.Length..],
			Accessibility.Private => "Private",
			Accessibility.Protected => "Protected",
			Accessibility.Internal or Accessibility.ProtectedAndInternal => "Internal",
			Accessibility.ProtectedOrInternal => "Shortcut",
			_ => publicImage[prefix.Length..],
		};
	}

	/// <summary>
	/// The members a row lists, dnSpy's <c>CreateTypeStateCore</c> and <c>Filter</c>: fields and properties
	/// without parameters, inherited ones included, sorted properties first and then by name; hidden by
	/// <c>DebuggerBrowsable(Never)</c>, by being compiler generated or non-public, as the options say.
	/// </summary>
	(IReadOnlyList<MemberInfo> Instance, IReadOnlyList<MemberInfo> Static) CollectMembers(ITypeSymbol type, ValueFormatOptions options, bool raw, bool onlyPublic) {
		var instance = new List<MemberInfo>();
		var statics = new List<MemberInfo>();
		var level = 0;
		var showOnlyPublic = onlyPublic || options.ShowOnlyPublicMembers;
		var seenProperties = new HashSet<string>(StringComparer.Ordinal);
		for (var current = type; current is not null; current = current.BaseType, level++) {
			foreach (var member in current.GetMembers()) {
				if (member is IFieldSymbol field) {
					if (level > 0 && field.IsStatic)
						continue;
				}
				else if (member is IPropertySymbol property) {
					if (property.Parameters.Length != 0 || property.GetMethod is null)
						continue;
					// An override is the same property as the one it overrides.
					if (!seenProperties.Add(property.Name) && property.IsOverride)
						continue;
					if (level > 0 && property.IsStatic)
						continue;
				}
				else
					continue;
				var info = Describe(member, level, current);
				if (showOnlyPublic && !info.IsPublic)
					continue;
				if (!raw && options.RespectHideMemberAttributes && info.BrowsableNever) {
					HadNever = true;
					continue;
				}
				if (info.BrowsableNever)
					HadNever = true;
				if (options.HideCompilerGeneratedMembers && info.IsCompilerGenerated)
					continue;
				if (options.HideDeprecatedError && info.DeprecatedError)
					continue;
				if (member.IsStatic)
					statics.Add(info);
				else
					instance.Add(info);
			}
		}
		return (Sort(MarkOverloaded(instance)), Sort(MarkOverloaded(statics)));
	}

	static MemberInfo Describe(ISymbol member, int level, ITypeSymbol owner) {
		var accessibility = member is IPropertySymbol property ? (property.GetMethod ?? property.SetMethod)?.DeclaredAccessibility ?? member.DeclaredAccessibility : member.DeclaredAccessibility;
		var browsable = member.GetAttributes().FirstOrDefault(attribute => attribute.AttributeClass?.ToDisplayString() == "System.Diagnostics.DebuggerBrowsableAttribute");
		var state = browsable?.ConstructorArguments.Length == 1 && browsable.ConstructorArguments[0].Value is int value ? value : 2;
		var obsolete = member.GetAttributes().FirstOrDefault(attribute => attribute.AttributeClass?.ToDisplayString() == "System.ObsoleteAttribute");
		var deprecatedError = obsolete?.ConstructorArguments.Length == 2 && obsolete.ConstructorArguments[1].Value is true;
		return new MemberInfo(
			member,
			level,
			accessibility == Accessibility.Public,
			IsCompilerGeneratedName(member.Name),
			state == 0,
			state == 3,
			deprecatedError,
			NeedCast: level > 0 && accessibility == Accessibility.Private);
	}

	/// <summary>Roslyn's <c>GeneratedMetadataNames.IsCompilerGenerated</c>: a name with angle brackets.</summary>
	static bool IsCompilerGeneratedName(string name) => name.Contains('<', StringComparison.Ordinal) || name.StartsWith("CS$", StringComparison.Ordinal) || name.StartsWith("VB$", StringComparison.Ordinal);

	/// <summary>Two members of one name in a hierarchy: the less derived one is written with its type, and read through a cast.</summary>
	static List<MemberInfo> MarkOverloaded(List<MemberInfo> members) {
		foreach (var group in members.GroupBy(member => member.Member.Name).Where(group => group.Count() > 1)) {
			var first = group.OrderBy(member => member.InheritanceLevel).First();
			foreach (var member in group) {
				if (!ReferenceEquals(member, first) && !SymbolEqualityComparer.Default.Equals(member.Member.ContainingType, first.Member.ContainingType)) {
					var index = members.IndexOf(member);
					members[index] = member with { NeedCast = true };
				}
			}
		}
		return members;
	}

	static IReadOnlyList<MemberInfo> Sort(List<MemberInfo> members) =>
		members
			.OrderBy(member => member.Member is IPropertySymbol ? 0 : 1)
			.ThenBy(member => member.Member.Name, StringComparer.OrdinalIgnoreCase)
			.ThenByDescending(member => member.InheritanceLevel)
			.ThenBy(member => member.Member.MetadataToken)
			.ToArray();

	/// <summary>dnSpy's <c>DebuggerTypeProxyFinder</c>: the type's DebuggerTypeProxy, or one its assembly names for it.</summary>
	static IMethodSymbol? FindProxyConstructor(ITypeSymbol type) {
		if (type is not INamedTypeSymbol named || named.TypeKind == TypeKind.Interface)
			return null;
		for (INamedTypeSymbol? current = named; current is not null; current = current.BaseType) {
			var attribute = current.GetAttributes().FirstOrDefault(candidate => candidate.AttributeClass?.ToDisplayString() == "System.Diagnostics.DebuggerTypeProxyAttribute");
			var proxyType = attribute?.ConstructorArguments.Length == 1 ? ProxyTypeOf(attribute.ConstructorArguments[0].Value, current) : null;
			proxyType ??= AssemblyProxyFor(current);
			if (proxyType is null)
				continue;
			var constructor = proxyType.InstanceConstructors.FirstOrDefault(candidate => candidate.Parameters.Length == 1);
			if (constructor is not null)
				return constructor;
		}
		return null;
	}

	static INamedTypeSymbol? ProxyTypeOf(object? argument, INamedTypeSymbol target) {
		var proxy = argument as INamedTypeSymbol;
		if (proxy is null && argument is string name)
			proxy = target.ContainingAssembly.GetTypeByMetadataName(name.Split(',')[0].Trim());
		if (proxy is null)
			return null;
		// An open generic proxy is instantiated with the arguments of the type it shows.
		if (proxy.IsUnboundGenericType || (proxy.IsGenericType && SymbolEqualityComparer.Default.Equals(proxy, proxy.OriginalDefinition))) {
			var arguments = DebuggeeTypeSystem.AllTypeArguments(target);
			if (arguments.Count == DebuggeeTypeSystem.AllTypeArguments(proxy.OriginalDefinition).Count)
				return DebuggeeTypeSystem.Construct(proxy.OriginalDefinition, arguments);
			return null;
		}
		return proxy;
	}

	static INamedTypeSymbol? AssemblyProxyFor(INamedTypeSymbol target) {
		foreach (var attribute in target.ContainingAssembly.GetAttributes()) {
			if (attribute.AttributeClass?.ToDisplayString() != "System.Diagnostics.DebuggerTypeProxyAttribute" || attribute.ConstructorArguments.Length != 1)
				continue;
			var targetArgument = attribute.NamedArguments.FirstOrDefault(argument => argument.Key is "Target" or "TargetTypeName").Value.Value;
			var named = targetArgument as INamedTypeSymbol;
			if (named is null && targetArgument is string targetName)
				named = target.ContainingAssembly.GetTypeByMetadataName(targetName.Split(',')[0].Trim());
			if (named is null || !SymbolEqualityComparer.Default.Equals(named.OriginalDefinition, target.OriginalDefinition))
				continue;
			return ProxyTypeOf(attribute.ConstructorArguments[0].Value, target);
		}
		return null;
	}
}

/// <summary>The static fields and properties of a type, read through the type rather than an instance.</summary>
internal sealed class StaticMembersChildren(ITypeSymbol type, IReadOnlyList<MemberInfo> members) : NodeChildren {
	public override async Task<IReadOnlyList<ValueNode>> CreateAsync(NodeFactory factory, int start, int count) {
		var nodes = new List<ValueNode>();
		var typeExpression = factory.TypeExpression(type);
		foreach (var member in members.Skip(start).Take(count)) {
			var formatter = factory.Formatter();
			var name = new ColorTextWriter().Write(ValueFormatter.ColorOf(member.Member), formatter.EscapeIdentifier(member.Member.Name)).ToList();
			var expression = typeExpression + "." + formatter.EscapeIdentifier(member.Member.Name);
			var (image, memberType, canEdit) = member.Member switch {
				IFieldSymbol field => (ObjectChildren.FieldImage(field), field.Type, !field.IsConst && !field.IsReadOnly),
				IPropertySymbol property => (ObjectChildren.PropertyImage(property), property.Type, property.SetMethod is not null),
				_ => ("FieldPublic", null as ITypeSymbol, false),
			};
			nodes.Add(await factory.CreateSafeAsync(name, expression, () => ObjectChildren.ReadAsync(factory, member, null), memberType, image, "static", canEdit).ConfigureAwait(false));
		}
		return nodes;
	}
}

/// <summary>
/// The items an enumerable yields — dnSpy's Results View, which copies them into a list and reads it back as
/// an array, so enumerating happens once and the rows can be addressed by index.
/// </summary>
internal sealed class ResultsViewChildren(RemoteValue value, INamedTypeSymbol enumerable, string expression) : NodeChildren {
	RemoteValue? items;

	async Task<RemoteValue> ItemsAsync(NodeFactory factory) {
		if (items is not null)
			return items;
		var compilation = factory.Runtime.Compilation;
		IMethodSymbol? constructor;
		IMethodSymbol? toArray;
		if (enumerable.IsGenericType) {
			var list = compilation.GetSpecialType(SpecialType.System_Object).ContainingAssembly.GetTypeByMetadataName("System.Collections.Generic.List`1")?.Construct(enumerable.TypeArguments[0]);
			constructor = list?.InstanceConstructors.FirstOrDefault(candidate => candidate.Parameters.Length == 1 && SymbolEqualityComparer.Default.Equals(candidate.Parameters[0].Type, enumerable));
			toArray = list?.GetMembers("ToArray").OfType<IMethodSymbol>().FirstOrDefault(candidate => candidate.Parameters.Length == 0);
		}
		else {
			var arrayList = compilation.GetSpecialType(SpecialType.System_Object).ContainingAssembly.GetTypeByMetadataName("System.Collections.ArrayList");
			constructor = arrayList?.InstanceConstructors.FirstOrDefault(candidate => candidate.Parameters.Length == 1 && candidate.Parameters[0].Type.Name == "ICollection");
			toArray = arrayList?.GetMembers("ToArray").OfType<IMethodSymbol>().FirstOrDefault(candidate => candidate.Parameters.Length == 0);
			if (constructor is not null && !value.Type.AllInterfaces.Any(candidate => candidate.Name == "ICollection" && candidate.ContainingNamespace.ToDisplayString() == "System.Collections"))
				constructor = null;
		}
		if (constructor is null || toArray is null)
			throw new EvaluationException("Only types implementing IEnumerable can be evaluated with Results View.");
		var copy = await factory.Runtime.NewObjectAsync(constructor, [value]).ConfigureAwait(false);
		var array = await factory.Runtime.CallAsync(toArray, copy, [], "ToArray").ConfigureAwait(false);
		items = array as RemoteValue ?? throw new EvaluationException("Enumeration yielded no results");
		return items;
	}

	public override async Task<int?> CountAsync(NodeFactory factory) {
		try {
			return await new ArrayChildren(await ItemsAsync(factory).ConfigureAwait(false), string.Empty).CountAsync(factory).ConfigureAwait(false);
		}
		catch (EvaluationException) {
			return null;
		}
	}

	public override async Task<IReadOnlyList<ValueNode>> CreateAsync(NodeFactory factory, int start, int count) {
		RemoteValue array;
		try {
			array = await ItemsAsync(factory).ConfigureAwait(false);
		}
		catch (EvaluationException ex) {
			return [NodeFactory.Error(NodeFactory.PlainName("Error"), string.Empty, ex.Message)];
		}
		catch (EvaluationThrownException thrown) {
			return [await factory.CreateThrownAsync(NodeFactory.PlainName("Error"), string.Empty, thrown, "ExceptionPublic").ConfigureAwait(false)];
		}
		var (dimensions, _) = await factory.Runtime.ReadArrayShapeAsync(array).ConfigureAwait(false);
		if (dimensions.Length == 1 && dimensions[0] == 0)
			return [new ValueNode { Name = NodeFactory.PlainName("Empty"), Value = NodeFactory.Text(TextColors.Text, "Enumeration yielded no results"), Image = "StatusInformation", Kind = "information" }];
		var elementExpression = expression.Length == 0 ? string.Empty : NodeFactory.StripSpecifiers(expression, factory.Options.Language) + ", results";
		var elements = await new ArrayChildren(array, string.Empty).CreateAsync(factory, start, count).ConfigureAwait(false);
		// The rows are addressed through the Results View itself, which has no element syntax of its own.
		_ = elementExpression;
		return elements;
	}
}

/// <summary>The dynamic members of an IDynamicMetaObjectProvider, read through Microsoft.CSharp's debug view.</summary>
internal sealed class DynamicViewChildren(RemoteValue value, string expression) : NodeChildren {
	public override async Task<IReadOnlyList<ValueNode>> CreateAsync(NodeFactory factory, int start, int count) {
		var view = factory.Runtime.Types.FindAssembly("Microsoft.CSharp")?.GetTypeByMetadataName("Microsoft.CSharp.RuntimeBinder.DynamicMetaObjectProviderDebugView");
		var constructor = view?.InstanceConstructors.FirstOrDefault(candidate => candidate.Parameters.Length == 1);
		var itemsProperty = view?.GetMembers("Items").OfType<IPropertySymbol>().FirstOrDefault();
		if (constructor is null || itemsProperty?.GetMethod is null)
			return [NodeFactory.Error(NodeFactory.PlainName("Error"), string.Empty, "Dynamic View requires Microsoft.CSharp.dll to be loaded in the debuggee.")];
		try {
			var debugView = await factory.Runtime.NewObjectAsync(constructor, [value]).ConfigureAwait(false);
			var items = await factory.Runtime.CallAsync(itemsProperty.GetMethod, debugView, [], "Items").ConfigureAwait(false);
			if (items is not RemoteValue array)
				return [new ValueNode { Name = NodeFactory.PlainName("Empty"), Value = NodeFactory.Text(TextColors.Text, "Dynamic View has no members"), Image = "StatusInformation", Kind = "information" }];
			var nodes = new List<ValueNode>();
			foreach (var element in await new ArrayChildren(array, string.Empty).CreateAsync(factory, start, count).ConfigureAwait(false)) {
				// Each item is a name and a value; the row is named after the member it stands for.
				if (element.EvalValue is RemoteValue item && item.Type.GetMembers("Name").OfType<IFieldSymbol>().FirstOrDefault() is { } nameField
					&& item.Type.GetMembers("Value").OfType<IFieldSymbol>().FirstOrDefault() is { } valueField) {
					var memberName = await factory.Runtime.ReadFieldAsync(item, nameField).ConfigureAwait(false);
					var memberText = (memberName as ScalarValue)?.Value as string ?? "?";
					nodes.Add(await factory.CreateSafeAsync(NodeFactory.Text(TextColors.InstanceProperty, memberText), string.Empty, () => factory.Runtime.ReadFieldAsync(item, valueField), null, "Property", "dynamicMember", canEdit: false).ConfigureAwait(false));
				}
				else
					nodes.Add(element);
			}
			return nodes;
		}
		catch (EvaluationException ex) {
			return [NodeFactory.Error(NodeFactory.PlainName("Error"), string.Empty, ex.Message)];
		}
		catch (EvaluationThrownException thrown) {
			return [await factory.CreateThrownAsync(NodeFactory.PlainName("Error"), string.Empty, thrown, "ExceptionPublic").ConfigureAwait(false)];
		}
		finally {
			_ = expression;
		}
	}
}

/// <summary>Rows made up front, which a group row (Type variables, a frame's locals) lists.</summary>
internal sealed class FixedChildren(IReadOnlyList<ValueNode> nodes) : NodeChildren {
	public override Task<IReadOnlyList<ValueNode>> CreateAsync(NodeFactory factory, int start, int count) =>
		Task.FromResult<IReadOnlyList<ValueNode>>(start <= 0 && count >= nodes.Count ? nodes : nodes.Skip(start).Take(count).ToArray());
}

/// <summary>
/// The ids the user gave objects (Make Object ID): each holds a strong handle, so <c>$1</c> keeps naming the
/// same object across stops until it is deleted or the session ends — dnSpy's <c>DbgObjectIdService</c>.
/// </summary>
internal sealed class ObjectIdTable {
	readonly object gate = new();
	readonly List<(uint Id, ICorDebugSharp.ICorDebugHandleValue Handle, ITypeSymbol Type)> ids = new();
	uint next = 1;

	public uint Add(ICorDebugSharp.ICorDebugHandleValue handle, ITypeSymbol type) {
		lock (gate) {
			var id = next++;
			ids.Add((id, handle, type));
			return id;
		}
	}

	public ICorDebugSharp.ICorDebugHandleValue? Remove(uint id) {
		lock (gate) {
			var index = ids.FindIndex(entry => entry.Id == id);
			if (index < 0)
				return null;
			var handle = ids[index].Handle;
			ids.RemoveAt(index);
			return handle;
		}
	}

	public IReadOnlyList<(uint Id, ICorDebugSharp.ICorDebugHandleValue Handle, ITypeSymbol Type)> Snapshot() {
		lock (gate)
			return ids.ToArray();
	}

	public void Clear() {
		lock (gate)
			ids.Clear();
	}

	/// <summary>The id an object has, matched by address, or null.</summary>
	public string? Find(EvalRuntime runtime, RemoteValue value) {
		if (value.Type.IsValueType || value.Ref.Handle is null)
			return null;
		var snapshot = Snapshot();
		if (snapshot.Count == 0)
			return null;
		try {
			var address = ValueReader.ReadReferenceAddress(value.Ref.Handle);
			foreach (var (id, handle, _) in snapshot) {
				if (ValueReader.ReadReferenceAddress(handle) == address)
					return "$" + id.ToString(CultureInfo.InvariantCulture);
			}
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
		}
		_ = runtime;
		return null;
	}
}
