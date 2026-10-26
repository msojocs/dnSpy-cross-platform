using System.Globalization;
using dnSpy.Backend.Core;

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

	/// <summary>Whether the language's options are the IL page's (ILDecompilerSettings) rather than the C# page's.</summary>
	public bool UsesILOptions => Kind is ConsoleLanguageKind.IL or ConsoleLanguageKind.ILWithCSharp;

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

/// <summary>
/// The IL page's settings (dnSpy.Decompiler.ILSpy.Core's ILSettings), which the IL and the IL with C# languages
/// share. The disassembler takes them as Core's <see cref="dnSpy.Backend.Core.IL.ILDecompilerSettings"/>.
/// </summary>
internal sealed class IlDecompilerOptions {
	public bool ShowILComments { get; set; }
	public bool ShowXmlDocumentation { get; set; } = true;
	public bool ShowTokenAndRvaComments { get; set; } = true;
	public bool ShowILBytes { get; set; } = true;
	public bool SortMembers { get; set; }
	public bool ShowPdbInfo { get; set; } = true;
	public int MaxStringLength { get; set; } = DnSpyDecompilerSettings.DefaultMaxStringLength;
	public bool HexadecimalNumbers { get; set; }

	public dnSpy.Backend.Core.IL.ILDecompilerSettings ToSettings() => new() {
		ShowILComments = ShowILComments,
		ShowXmlDocumentation = ShowXmlDocumentation,
		ShowTokenAndRvaComments = ShowTokenAndRvaComments,
		ShowILBytes = ShowILBytes,
		SortMembers = SortMembers,
		ShowPdbInfo = ShowPdbInfo,
		MaxStringLength = MaxStringLength,
		HexadecimalNumbers = HexadecimalNumbers,
	};
}

/// <summary>
/// One option a language's settings expose — dnSpy's <c>IDecompilerOption</c>: the guid and the name its switch is
/// made of, the value's type, the description the help prints, and the setting it reads and writes.
/// </summary>
internal sealed class LanguageOption(Guid guid, string name, Type type, string description, Func<object> get, Action<object> set) {
	public Guid Guid { get; } = guid;
	public string Name { get; } = name;
	public Type Type { get; } = type;
	public string Description { get; } = description;
	public object Value {
		get => get();
		set => set(value);
	}

	public static LanguageOption Boolean(string guid, string name, string description, Func<bool> get, Action<bool> set) =>
		new(new Guid(guid), name, typeof(bool), description, () => get(), value => set((bool)value));

	public static LanguageOption Int32(string guid, string name, string description, Func<int> get, Action<int> set) =>
		new(new Guid(guid), name, typeof(int), description, () => get(), value => set((int)value));

	public static LanguageOption String(string guid, string name, string description, Func<string> get, Action<string> set) =>
		new(new Guid(guid), name, typeof(string), description, () => get(), value => set((string)value));

	/// <summary>The value the way the help writes it: {opt.Value} formatted by string.Format.</summary>
	public string ValueText => Convert.ToString(Value, CultureInfo.CurrentCulture) ?? string.Empty;
}

/// <summary>
/// The options of the two settings objects the WPF console's languages share, in the order and with the guids, names
/// and descriptions of dnSpy's <c>CSharpVBDecompilerSettings.CreateOptions</c> and <c>ILDecompilerSettings.CreateOptions</c>.
/// </summary>
static class LanguageOptions {
	/// <summary>The C# and Visual Basic options (CSharpVBDecompilerSettings).</summary>
	public static IReadOnlyList<LanguageOption> ForCSharp(DnSpyDecompilerSettings s) => [
		LanguageOption.String("8E6FE77A-2BCB-4F34-A41B-7F097560A211", "member-order", "Decompilation order",
			() => MemberOrder.Get(s), value => MemberOrder.Set(s, value)),
		LanguageOption.Boolean("74BBA9E7-CD43-4C81-9A7C-9F49D4BDA3D9", "anon-methods", "Decompile anonymous methods/lambdas",
			() => s.AnonymousMethods, value => s.AnonymousMethods = value),
		LanguageOption.Boolean("DDF1B2BA-AD71-4A7A-ADCB-690D5F54FAF8", "expr-trees", "Decompile expression trees",
			() => s.ExpressionTrees, value => s.ExpressionTrees = value),
		LanguageOption.Boolean("07FD6290-2B5B-424E-B7E5-B64B32881F81", "yield", "Decompile enumerators (yield return)",
			() => s.YieldReturn, value => s.YieldReturn = value),
		LanguageOption.Boolean("A85EDBC5-88C4-417F-9BE0-3AC3CB8107B7", "async", "Decompile async methods (async/await)",
			() => s.AsyncAwait, value => s.AsyncAwait = value),
		LanguageOption.Boolean("F6B11911-94BF-486B-AB8E-100B6A1B71FC", "auto-props", "Decompile automatic properties",
			() => s.AutomaticProperties, value => s.AutomaticProperties = value),
		LanguageOption.Boolean("36D8D33E-4E5B-44E4-B638-6A4791F16024", "auto-events", "Decompile automatic events",
			() => s.AutomaticEvents, value => s.AutomaticEvents = value),
		LanguageOption.Boolean("24511B87-F19D-4AAC-80FC-A7E67D92A40E", "using-stmt", "Decompile using statements",
			() => s.UsingStatement, value => s.UsingStatement = value),
		LanguageOption.Boolean("60ADA4EC-B7D1-407A-AE07-35D651956014", "foreach-stmt", "Decompile foreach statements",
			() => s.ForEachStatement, value => s.ForEachStatement = value),
		LanguageOption.Boolean("E1BD857F-B895-43C7-8844-5CF9F874E8C0", "lock-stmt", "Decompile lock statements",
			() => s.LockStatement, value => s.LockStatement = value),
		LanguageOption.Boolean("E0FC32C0-74DA-4D8C-886C-3182D7A77C16", "switch-string", "Decompile switch on string",
			() => s.SwitchStatementOnString, value => s.SwitchStatementOnString = value),
		LanguageOption.Boolean("DAC40A5C-C867-4EF2-8DA3-9AFA285A47CE", "using-decl", "Add using declarations",
			() => s.UsingDeclarations, value => s.UsingDeclarations = value),
		LanguageOption.Boolean("CFB4D69F-0A98-4763-A863-6227159A0BD6", "query-expr", "Decompile query expressions",
			() => s.QueryExpressions, value => s.QueryExpressions = value),
		LanguageOption.Boolean("C60EA9B7-D469-4FA4-BF85-4DF755B521A3", "ambig-full-names", "Add a namespace to types with the same name",
			() => s.FullyQualifyAmbiguousTypeNames, value => s.FullyQualifyAmbiguousTypeNames = value),
		LanguageOption.Boolean("916F3D3C-00E1-4D1D-ABFD-EA7092DF5028", "full-names", "Add namespaces to all types",
			() => s.FullyQualifyAllTypes, value => s.FullyQualifyAllTypes = value),
		LanguageOption.Boolean("D8E085BF-9A1B-463C-96C6-894979DD131D", "use-debug-syms", "Use variable names from debug symbols, if available",
			() => s.UseDebugSymbols, value => s.UseDebugSymbols = value),
		LanguageOption.Boolean("1CD4E962-2DF0-4681-A631-E0A2F6DD641E", "obj-inits", "Decompile object or collection initializers",
			() => s.ObjectOrCollectionInitializers, value => s.ObjectOrCollectionInitializers = value),
		LanguageOption.Boolean("6D50BA49-D76C-4EDD-BF5A-F81B894CCD2C", "xml-doc", "Show XML documentation in decompiled code",
			() => s.ShowXmlDocumentation, value => s.ShowXmlDocumentation = value),
		LanguageOption.Boolean("79DEF757-13D3-413A-9524-4104F2F179BE", "remove-emtpy-ctors", "Remove empty default constructors",
			() => s.RemoveEmptyDefaultConstructors, value => s.RemoveEmptyDefaultConstructors = value),
		LanguageOption.Boolean("A7A2255B-3089-448E-BF3E-CB2AB2050D8F", "inc-dec", "Use increment and decrement operators",
			() => s.IntroduceIncrementAndDecrement, value => s.IntroduceIncrementAndDecrement = value),
		LanguageOption.Boolean("6FFF99B5-D59A-4EB0-87A9-D297176D51B9", "make-assign-expr", "Use assignment expressions such as in while ((count = Do()) != 0) ;",
			() => s.MakeAssignmentExpressions, value => s.MakeAssignmentExpressions = value),
		LanguageOption.Boolean("5303AAB5-CAFF-469A-B19C-CE4FBAC88CC3", "always-create-ex-var", "Always generate exception variables in catch blocks unless type is Object",
			() => s.AlwaysGenerateExceptionVariableForCatchBlocksUnlessTypeIsObject, value => s.AlwaysGenerateExceptionVariableForCatchBlocksUnlessTypeIsObject = value),
		LanguageOption.Boolean("99475485-C462-4D60-AF90-C14008577A9D", "tokens", "Show tokens, RVAs and file offsets",
			() => s.ShowTokenAndRvaComments, value => s.ShowTokenAndRvaComments = value),
		LanguageOption.Boolean("51FEEFED-5353-4637-A75E-7CA87EFA3998", "sort-members", "Sort methods, fields, properties, events and types",
			() => s.SortMembers, value => s.SortMembers = value),
		LanguageOption.Boolean("237BFCDA-07A5-493C-9ACF-8698EBF395FA", "show-all", "Show hidden compiler generated types and methods",
			() => s.ForceShowAllMembers, value => s.ForceShowAllMembers = value),
		LanguageOption.Boolean("48BF91F6-A186-45B9-8A79-EEFEA5E5BAB1", "system-first", "Place 'System' directives first when sorting usings",
			() => s.SortSystemUsingStatementsFirst, value => s.SortSystemUsingStatementsFirst = value),
		LanguageOption.Int32("E0DEC360-EE40-4F61-9106-D9F142F4CC9A", "max-array-elems", "Max number of array elements to show",
			() => s.MaxArrayElements, value => s.MaxArrayElements = value),
		LanguageOption.Int32("405901FA-47E5-497F-A4DF-0FE5C3677287", "max-string-length", "Max string length",
			() => s.MaxStringLength, value => s.MaxStringLength = value),
		LanguageOption.Boolean("8E3E8009-AC00-436E-B476-08B2E697AD32", "sort-custom-attrs", "Sort custom attributes",
			() => s.SortCustomAttributes, value => s.SortCustomAttributes = value),
		LanguageOption.Boolean("11B1D294-1D85-4A5B-B9E9-B2A8AB889F51", "src-order", "Order members in source code order",
			() => s.UseSourceCodeOrder, value => s.UseSourceCodeOrder = value),
		LanguageOption.Boolean("148CE5B9-95EC-441A-BDC8-1EAFFC02B097", "field-initializers", "Allow field initializers",
			() => s.AllowFieldInitializers, value => s.AllowFieldInitializers = value),
		LanguageOption.Boolean("DFFAF5AE-2A25-4A3A-A82E-779B58DA734A", "one-ca-per-line", "Show one custom attribute per line",
			() => s.OneCustomAttributePerLine, value => s.OneCustomAttributePerLine = value),
		LanguageOption.Boolean("354FAA68-7CDC-478E-9414-5C066C45C3F3", "internal-modifier-type", "Add 'internal' modifier to types",
			() => s.TypeAddInternalModifier, value => s.TypeAddInternalModifier = value),
		LanguageOption.Boolean("2E764781-2075-47DC-BEE5-7F5F560BA726", "private-modifier-member", "Add 'private' modifier to type members",
			() => s.MemberAddPrivateModifier, value => s.MemberAddPrivateModifier = value),
		LanguageOption.Boolean("BEC534D0-A231-4F65-BE2E-5CCC4A7CE1B2", "remove-new-delegate-class", "Replace 'new delegate-class(xxx)' with 'xxx'",
			() => s.RemoveNewDelegateClass, value => s.RemoveNewDelegateClass = value),
		LanguageOption.Boolean("CFBE77DA-3139-4E8C-91DF-3D546480F535", "hex", "Hexadecimal numbers",
			() => s.HexadecimalNumbers, value => s.HexadecimalNumbers = value),
		LanguageOption.Boolean("BB0F4E9E-51F5-4C0B-B769-FB3B01EE4D20", "emit-calli-as-invoke", "Decompile calli to invocation expression",
			() => s.EmitCalliAsInvocationExpression, value => s.EmitCalliAsInvocationExpression = value),
		LanguageOption.Boolean("F3F0DC5E-CC1E-4515-80D1-165383B33300", "insert-parentheses-for-readability", "Insert parentheses for readability",
			() => s.InsertParenthesesForReadability, value => s.InsertParenthesesForReadability = value),
	];

	/// <summary>The IL options (ILDecompilerSettings), which both IL languages share.</summary>
	public static IReadOnlyList<LanguageOption> ForIL(IlDecompilerOptions o) => [
		LanguageOption.Boolean("241A61B8-0F12-438C-A431-029B9FAEB124", "comments", "Show IL opcode comments",
			() => o.ShowILComments, value => o.ShowILComments = value),
		LanguageOption.Boolean("6D50BA49-D76C-4EDD-BF5A-F81B894CCD2C", "xml-doc", "Show XML documentation in decompiled code",
			() => o.ShowXmlDocumentation, value => o.ShowXmlDocumentation = value),
		LanguageOption.Boolean("99475485-C462-4D60-AF90-C14008577A9D", "tokens", "Show tokens, RVAs and file offsets",
			() => o.ShowTokenAndRvaComments, value => o.ShowTokenAndRvaComments = value),
		LanguageOption.Boolean("E03DA52E-927C-4AA0-8FDE-9607125B606C", "bytes", "Show IL instruction bytes",
			() => o.ShowILBytes, value => o.ShowILBytes = value),
		LanguageOption.Boolean("51FEEFED-5353-4637-A75E-7CA87EFA3998", "sort-members", "Sort methods, fields, properties, events and types",
			() => o.SortMembers, value => o.SortMembers = value),
		LanguageOption.Boolean("2E19D17C-1994-4CA3-914B-1D690E3EA29E", "pdb-info", "Show line numbers and filenames if available",
			() => o.ShowPdbInfo, value => o.ShowPdbInfo = value),
		LanguageOption.Int32("405901FA-47E5-497F-A4DF-0FE5C3677287", "max-string-length", "Max string length",
			() => o.MaxStringLength, value => o.MaxStringLength = value),
		LanguageOption.Boolean("CFBE77DA-3139-4E8C-91DF-3D546480F535", "hex", "Hexadecimal numbers",
			() => o.HexadecimalNumbers, value => o.HexadecimalNumbers = value),
	];

	public static IReadOnlyList<LanguageOption> For(ConsoleLanguage language, CommandLineOptions options) =>
		language.UsesILOptions ? ForIL(options.IlOptions) : ForCSharp(options.Settings);
}

/// <summary>
/// The member-order option: the five kinds of the decompilation order, a letter each — t(ypes), f(ields),
/// e(vents), p(roperties), m(ethods) — the way CSharpVBDecompilerSettings writes and reads them.
/// </summary>
static class MemberOrder {
	static readonly (char Letter, string Kind)[] kinds = [
		('t', "nestedTypes"),
		('f', "fields"),
		('e', "events"),
		('p', "properties"),
		('m', "methods"),
	];

	public static string Get(DnSpyDecompilerSettings settings) {
		var text = new System.Text.StringBuilder();
		foreach (var kind in settings.DecompilationOrder) {
			var letter = kinds.FirstOrDefault(entry => entry.Kind == kind).Letter;
			text.Append(letter == default ? '?' : letter);
		}
		return text.ToString();
	}

	/// <summary>
	/// SetMemberOrder: a string of five letters assigns each position in turn; a letter that names no kind keeps the
	/// position as it is, and a kind that moves swaps places with the one that was there (SetDecompilationObject).
	/// </summary>
	public static void Set(DnSpyDecompilerSettings settings, string value) {
		if (value is null || value.Length != 5)
			return;
		var order = settings.DecompilationOrder.ToArray();
		for (var index = 0; index < 5; index++) {
			var kind = kinds.FirstOrDefault(entry => entry.Letter == value[index]).Kind;
			if (kind is null || order[index] == kind)
				continue;
			var otherIndex = Array.IndexOf(order, kind);
			if (otherIndex >= 0) {
				order[otherIndex] = order[index];
				order[index] = kind;
			}
		}
		settings.DecompilationOrder = order;
	}
}
