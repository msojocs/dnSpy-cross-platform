using ICSharpCode.Decompiler;

namespace dnSpy.Cli;

internal enum ConsoleLanguageKind {
	CSharp,
	VisualBasic,
	IL,
	ILWithCSharp,
}

/// <summary>
/// One decompiler language, as the WPF console learns them from dnSpy.Decompiler.ILSpy.Core's
/// <c>IDecompilerProvider</c>: the same name, the same two guids, the same file extensions, in the same
/// order. The release ILSpy provider has no debug languages, so the four below are its complete list.
/// </summary>
internal sealed class ConsoleLanguage(
	string name,
	Guid uniqueGuid,
	Guid genericGuid,
	string fileExtension,
	string? projectFileExtension,
	ConsoleLanguageKind kind) {
	public string Name { get; } = name;
	public Guid UniqueGuid { get; } = uniqueGuid;
	public Guid GenericGuid { get; } = genericGuid;
	public string FileExtension { get; } = fileExtension;
	public string? ProjectFileExtension { get; } = projectFileExtension;
	public ConsoleLanguageKind Kind { get; } = kind;

	public static readonly ConsoleLanguage CSharp = new(
		"C#",
		new Guid("4162DADA-67C3-4DE4-A5F3-6552C8353ECE"),
		new Guid("F5A318D4-4B2A-48D2-AE33-F4D2B1EFF4B0"),
		".cs",
		".csproj",
		ConsoleLanguageKind.CSharp);

	public static readonly ConsoleLanguage VisualBasic = new(
		"Visual Basic",
		new Guid("BBA40092-76B2-4184-8E81-0F1E3ED14E72"),
		new Guid("B6849618-8239-4FBB-8DFF-D45EB023C193"),
		".vb",
		".vbproj",
		ConsoleLanguageKind.VisualBasic);

	public static readonly ConsoleLanguage IL = new(
		"IL",
		new Guid("A4F35508-691F-4BD0-B74D-D5D5D1D0E8E6"),
		new Guid("9EF276FD-3293-42A4-B48A-1D6A69086B3D"),
		".il",
		null,
		ConsoleLanguageKind.IL);

	public static readonly ConsoleLanguage ILWithCSharp = new(
		"IL with C#",
		new Guid("CA52A515-12AE-4182-BC88-81ED037C3D32"),
		new Guid("9EF276FD-3293-42A4-B48A-1D6A69086B3D"),
		".il",
		null,
		ConsoleLanguageKind.ILWithCSharp);

	public static readonly ConsoleLanguage[] All = [CSharp, VisualBasic, IL, ILWithCSharp];

	/// <summary>Matches a unique name, a unique guid or a generic guid, case insensitively.</summary>
	public static ConsoleLanguage? Find(string value) {
		var hasGuid = Guid.TryParse(value, out var guid);
		foreach (var language in All) {
			if (StringComparer.OrdinalIgnoreCase.Equals(value, language.Name))
				return language;
			if (hasGuid && (guid.Equals(language.UniqueGuid) || guid.Equals(language.GenericGuid)))
				return language;
		}
		return null;
	}
}

/// <summary>The IL disassembler's own settings; dnSpy keeps them apart from the C#/VB settings.</summary>
internal sealed class IlDecompilerOptions {
	public bool ShowTokenAndRvaComments { get; set; } = true;
	public bool ShowILBytes { get; set; } = true;
	public bool SortMembers { get; set; }
	public bool ShowPdbInfo { get; set; } = true;
}

internal enum LanguageOptionType {
	Boolean,
	Int32,
	String,
}

/// <summary>
/// One switch a language accepts. The WPF console builds these from <c>IDecompiler.Settings.Options</c>;
/// this decompiler offers the subset that maps onto ICSharpCode.Decompiler's own settings, under the
/// same switch names, so a script written for the Windows console keeps working for those options.
/// </summary>
internal sealed class LanguageOption(
	string name,
	LanguageOptionType type,
	object defaultValue,
	string description,
	Func<object> get,
	Action<object> set) {
	public string Name { get; } = name;
	public LanguageOptionType Type { get; } = type;
	public object DefaultValue { get; } = defaultValue;
	public string Description { get; } = description;
	public Func<object> Get { get; } = get;
	public Action<object> Set { get; } = set;

	public static LanguageOption Boolean(string name, bool defaultValue, string description, Func<bool> get, Action<bool> set) =>
		new(name, LanguageOptionType.Boolean, defaultValue, description, () => get(), value => set((bool)value));

	public static LanguageOption Int32(string name, int defaultValue, string description, Func<int> get, Action<int> set) =>
		new(name, LanguageOptionType.Int32, defaultValue, description, () => get(), value => set((int)value));

	public static LanguageOption String(string name, string defaultValue, string description, Func<string> get, Action<string> set) =>
		new(name, LanguageOptionType.String, defaultValue, description, () => get(), value => set((string)value));

	public string TypeName => Type switch {
		LanguageOptionType.Boolean => "Boolean",
		LanguageOptionType.Int32 => "Int32",
		_ => "String",
	};

	public string DefaultValueText => DefaultValue is bool boolean
		? (boolean ? "True" : "False")
		: Convert.ToString(DefaultValue, System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty;
}

static class LanguageOptions {
	/// <summary>The C# and Visual Basic switches, the ones the shared CSharpVBDecompilerSettings has.</summary>
	public static IReadOnlyList<LanguageOption> ForCSharp(DecompilerSettings settings) => [
		LanguageOption.Boolean("xml-doc", settings.ShowXmlDocumentation, "Show XML documentation in decompiled code",
			() => settings.ShowXmlDocumentation, value => settings.ShowXmlDocumentation = value),
		LanguageOption.Boolean("anon-methods", settings.AnonymousMethods, "Decompile anonymous methods/lambdas",
			() => settings.AnonymousMethods, value => settings.AnonymousMethods = value),
		LanguageOption.Boolean("expr-trees", settings.ExpressionTrees, "Decompile expression trees",
			() => settings.ExpressionTrees, value => settings.ExpressionTrees = value),
		LanguageOption.Boolean("yield", settings.YieldReturn, "Decompile enumerators (yield return)",
			() => settings.YieldReturn, value => settings.YieldReturn = value),
		LanguageOption.Boolean("async", settings.AsyncAwait, "Decompile async methods (async/await)",
			() => settings.AsyncAwait, value => settings.AsyncAwait = value),
		LanguageOption.Boolean("auto-props", settings.AutomaticProperties, "Decompile automatic properties",
			() => settings.AutomaticProperties, value => settings.AutomaticProperties = value),
		LanguageOption.Boolean("auto-events", settings.AutomaticEvents, "Decompile automatic events",
			() => settings.AutomaticEvents, value => settings.AutomaticEvents = value),
		LanguageOption.Boolean("using-stmt", settings.UsingStatement, "Decompile using statements",
			() => settings.UsingStatement, value => settings.UsingStatement = value),
		LanguageOption.Boolean("foreach-stmt", settings.ForEachStatement, "Decompile foreach statements",
			() => settings.ForEachStatement, value => settings.ForEachStatement = value),
		LanguageOption.Boolean("lock-stmt", settings.LockStatement, "Decompile lock statements",
			() => settings.LockStatement, value => settings.LockStatement = value),
		LanguageOption.Boolean("switch-string", settings.SwitchStatementOnString, "Decompile switch on string",
			() => settings.SwitchStatementOnString, value => settings.SwitchStatementOnString = value),
		LanguageOption.Boolean("using-decl", settings.UsingDeclarations, "Add using declarations",
			() => settings.UsingDeclarations, value => settings.UsingDeclarations = value),
		LanguageOption.Boolean("query-expr", settings.QueryExpressions, "Decompile query expressions",
			() => settings.QueryExpressions, value => settings.QueryExpressions = value),
		LanguageOption.Boolean("obj-inits", settings.ObjectOrCollectionInitializers, "Decompile object or collection initializers",
			() => settings.ObjectOrCollectionInitializers, value => settings.ObjectOrCollectionInitializers = value),
		LanguageOption.Boolean("inc-dec", settings.IntroduceIncrementAndDecrement, "Use increment and decrement operators",
			() => settings.IntroduceIncrementAndDecrement, value => settings.IntroduceIncrementAndDecrement = value),
		LanguageOption.Boolean("make-assign-expr", settings.MakeAssignmentExpressions, "Use assignment expressions such as in while ((count = Do()) != 0) ;",
			() => settings.MakeAssignmentExpressions, value => settings.MakeAssignmentExpressions = value),
		LanguageOption.Boolean("sort-custom-attrs", settings.SortCustomAttributes, "Sort custom attributes",
			() => settings.SortCustomAttributes, value => settings.SortCustomAttributes = value),
		LanguageOption.Boolean("use-debug-syms", settings.UseDebugSymbols, "Use variable names from debug symbols, if available",
			() => settings.UseDebugSymbols, value => settings.UseDebugSymbols = value),
	];

	/// <summary>The IL switches; both IL languages share them, as dnSpy's two IL decompilers share ILSettings.</summary>
	public static IReadOnlyList<LanguageOption> ForIL(IlDecompilerOptions options) => [
		LanguageOption.Boolean("tokens", options.ShowTokenAndRvaComments, "Show tokens, RVAs and file offsets",
			() => options.ShowTokenAndRvaComments, value => options.ShowTokenAndRvaComments = value),
		LanguageOption.Boolean("bytes", options.ShowILBytes, "Show IL instruction bytes",
			() => options.ShowILBytes, value => options.ShowILBytes = value),
		LanguageOption.Boolean("sort-members", options.SortMembers, "Sort methods, fields, properties, events and types",
			() => options.SortMembers, value => options.SortMembers = value),
		LanguageOption.Boolean("pdb-info", options.ShowPdbInfo, "Show line numbers and filenames if available",
			() => options.ShowPdbInfo, value => options.ShowPdbInfo = value),
	];

	public static IReadOnlyList<LanguageOption> For(ConsoleLanguage language, DecompilerSettings settings, IlDecompilerOptions ilOptions) =>
		language.Kind is ConsoleLanguageKind.IL or ConsoleLanguageKind.ILWithCSharp
			? ForIL(ilOptions)
			: ForCSharp(settings);
}
