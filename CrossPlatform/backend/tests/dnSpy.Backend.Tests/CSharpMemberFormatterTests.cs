using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using SearchTarget;
using Xunit;
using Options = dnSpy.Backend.Core.CSharpMemberFormatter.Options;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The C# member formatter against what WPF dnSpy's CSharpFormatter writes: a search result's name
/// (FormatterOptions.Default without parameter names, declaring types and literal values) and a member's
/// tooltip (FormatterOptions.Default with ShowParameterLiteralValues), on the SearchTarget fixture, the core
/// library and System.Linq, and on members built in memory for the constants no fixture has.
/// </summary>
public sealed class CSharpMemberFormatterTests {
	// SearchResult: Default & ~(ShowParameterNames | ShowDeclaringTypes | ShowFieldLiteralValues).
	const Options NameOptions = Options.ParameterTypes | Options.ReturnTypes | Options.FieldTypes | Options.IntrinsicTypeKeywords;
	// DecompilerBase.WriteToolTip: Default | ShowParameterLiteralValues.
	const Options ToolTipOptions = Options.ParameterTypes | Options.ParameterNames | Options.DeclaringTypes | Options.ReturnTypes
		| Options.FieldTypes | Options.IntrinsicTypeKeywords | Options.FieldLiteralValues | Options.ParameterLiteralValues;

	static readonly Lazy<ModuleDefMD> Target = new(() => ModuleDefMD.Load(typeof(Library).Assembly.Location));
	static readonly Lazy<ModuleDefMD> CoreLib = new(() => ModuleDefMD.Load(typeof(object).Assembly.Location));
	static readonly Lazy<ModuleDefMD> Linq = new(() => ModuleDefMD.Load(typeof(Enumerable).Assembly.Location));

	static TypeDef Type(ModuleDef module, string reflectionName) => module.Find(reflectionName, isReflectionName: true) ?? throw new InvalidOperationException(reflectionName);
	static TypeDef TargetType(string name) => Type(Target.Value, "SearchTarget." + name);
	static MethodDef Method(TypeDef type, string name) => type.Methods.Single(method => method.Name == name);

	static string Name(IMemberDef member, Options options = NameOptions) {
		var output = new TextPartsBuilder();
		CSharpMemberFormatter.Write(output, member, options);
		return output.ToString();
	}

	static string ToolTip(IMemberDef member, Options options = ToolTipOptions) => ToolTipParts(member, options).ToString();

	static TextPartsBuilder ToolTipParts(IMemberDef member, Options options = ToolTipOptions) {
		var output = new TextPartsBuilder();
		CSharpMemberFormatter.WriteToolTip(output, member, options);
		return output;
	}

	[Fact]
	public void WritesSearchResultNames() {
		var library = TargetType("Library");
		Assert.Equal("string Describe(int, [string], params object[])", Name(Method(library, "Describe")));
		Assert.Equal("int Answer", Name(library.FindField("Answer")));
		Assert.Equal("string Greeting", Name(library.FindField("Greeting")));
		// An enum's constants go without the type every one of them has, a static field of one keeps it.
		Assert.Equal("Red", Name(TargetType("Color").FindField("Red")));
		Assert.Equal("int value__", Name(TargetType("Color").FindField("value__")));
		Assert.Equal("int X", Name(TargetType("Point").FindField("X")));
		Assert.Equal("T Value", Name(Type(Target.Value, "SearchTarget.Library+Nested`1").FindField("Value")));
		Assert.Equal("string Title { get; init; }", Name(library.FindProperty("Title")));
		Assert.Equal("EventHandler Opened { add; remove; }", Name(library.FindEvent("Opened")));
	}

	[Fact]
	public void WritesMethodToolTips() {
		var library = TargetType("Library");
		// dnSpy writes " = " after the space that follows a parameter's name, so a default value sits two spaces away.
		Assert.Equal("string Library.Describe(int count, [string label  = \"x\"], params object[] rest)", ToolTip(Method(library, "Describe")));
		Assert.Equal("Library Library.operator +(Library left, Library right)", ToolTip(Method(library, "op_Addition")));
		Assert.Equal("Library.implicit operator string(Library value)", ToolTip(Method(library, "op_Implicit")));
		Assert.Equal("Library.Library()", ToolTip(Method(library, ".ctor")));
		Assert.Equal("string Library.Title.get", ToolTip(Method(library, "get_Title")));
		Assert.Equal("string Library.Title.init", ToolTip(Method(library, "set_Title")));
		// An event's accessor is the event, its type in front, then which accessor it is.
		Assert.Equal("EventHandler Library.Opened.add", ToolTip(Method(library, "add_Opened")));
	}

	[Fact]
	public void WritesDeprecatedAwaitableAndExtensionMethodsWithTheirOverloads() {
		var stream = Type(CoreLib.Value, "System.IO.Stream");
		var readAsync = stream.Methods.Single(method => method.Name == "ReadAsync" && method.MethodSig.Params.Count == 2);
		// A struct parameter's null default is "default"; Stream has three ReadAsync methods.
		Assert.Equal("(awaitable) ValueTask<int> Stream.ReadAsync(Memory<byte> buffer, [CancellationToken cancellationToken  = default]) (+ 2 overloads)",
			ToolTip(readAsync));
		Assert.Equal("ValueTask<int> ReadAsync(Memory<byte>, [CancellationToken])", Name(readAsync));

		var where = Type(Linq.Value, "System.Linq.Enumerable").Methods.Single(method => method.Name == "Where"
			&& method.MethodSig.Params[1] is GenericInstSig { GenericArguments.Count: 2 });
		Assert.Equal("(extension) IEnumerable<TSource> Enumerable.Where<TSource>(IEnumerable<TSource> source, Func<TSource, bool> predicate) (+ 1 overload)",
			ToolTip(where));

		var unwrap = Type(CoreLib.Value, "System.Threading.Tasks.TaskExtensions").Methods.Single(method => method.Name == "Unwrap" && !method.HasGenericParameters);
		Assert.Equal("(awaitable, extension) Task TaskExtensions.Unwrap(Task<Task> task) (+ 1 overload)", ToolTip(unwrap));

		var copy = Method(Type(CoreLib.Value, "System.String"), "Copy");
		Assert.Equal("[deprecated] string string.Copy(string str)", ToolTip(copy));
		Assert.Equal(
			[
				new TextPartDto("[", TextColors.Punctuation),
				new TextPartDto("deprecated", TextColors.Text),
				new TextPartDto("]", TextColors.Punctuation),
				new TextPartDto(" ", TextColors.Text),
				new TextPartDto("string", TextColors.Keyword),
				new TextPartDto(" ", TextColors.Text),
				new TextPartDto("string", TextColors.Keyword),
				new TextPartDto(".", TextColors.Operator),
				new TextPartDto("Copy", TextColors.StaticMethod),
				new TextPartDto("(", TextColors.Punctuation),
				new TextPartDto("string", TextColors.Keyword),
				new TextPartDto(" ", TextColors.Text),
				new TextPartDto("str", TextColors.Parameter),
				new TextPartDto(")", TextColors.Punctuation),
			],
			ToolTipParts(copy).ToParts());

		var awaitableParts = ToolTipParts(unwrap).ToParts();
		Assert.Equal(
			[
				new TextPartDto("(", TextColors.Punctuation),
				new TextPartDto("awaitable", TextColors.Text),
				new TextPartDto(",", TextColors.Punctuation),
				new TextPartDto(" extension", TextColors.Text),
				new TextPartDto(")", TextColors.Punctuation),
				new TextPartDto(" ", TextColors.Text),
			],
			awaitableParts.Take(6));
		Assert.Equal(new TextPartDto("Unwrap", TextColors.ExtensionMethod), Assert.Single(awaitableParts, part => part.Text == "Unwrap"));
		Assert.Equal(new TextPartDto(" (+ 1 overload)", TextColors.Text), awaitableParts[^1]);
	}

	[Fact]
	public void WritesFieldToolTips() {
		var library = TargetType("Library");
		Assert.Equal("(constant) int Library.Answer = 0x00001092", ToolTip(library.FindField("Answer")));
		Assert.Equal("(constant) string Library.Greeting = \"field-literal-needle\"", ToolTip(library.FindField("Greeting")));
		Assert.Equal("Color.Red = 0x00000000", ToolTip(TargetType("Color").FindField("Red")));
		Assert.Equal("Color.Green = 0x00000001", ToolTip(TargetType("Color").FindField("Green")));
		Assert.Equal("(field) int Point.X", ToolTip(TargetType("Point").FindField("X")));
		Assert.Equal("(field) int GlobalMembers.GlobalField", ToolTip(TargetType("GlobalMembers").FindField("GlobalField")));
		Assert.Equal("(field) T Library.Nested.Value", ToolTip(Type(Target.Value, "SearchTarget.Library+Nested`1").FindField("Value")));

		Assert.Equal(
			[
				new TextPartDto("(", TextColors.Punctuation),
				new TextPartDto("constant", TextColors.Text),
				new TextPartDto(")", TextColors.Punctuation),
				new TextPartDto(" ", TextColors.Text),
				new TextPartDto("int", TextColors.Keyword),
				new TextPartDto(" ", TextColors.Text),
				new TextPartDto("Library", TextColors.Type),
				new TextPartDto(".", TextColors.Operator),
				new TextPartDto("Answer", TextColors.LiteralField),
				new TextPartDto(" ", TextColors.Text),
				new TextPartDto("=", TextColors.Operator),
				new TextPartDto(" ", TextColors.Text),
				new TextPartDto("0x00001092", TextColors.Number),
			],
			ToolTipParts(library.FindField("Answer")).ToParts());
		Assert.Equal(new TextPartDto("\"field-literal-needle\"", TextColors.String), ToolTipParts(library.FindField("Greeting")).ToParts()[^1]);

		// A static readonly decimal's value is in its [DecimalConstant].
		var @decimal = Type(CoreLib.Value, "System.Decimal");
		Assert.Equal("(constant) decimal decimal.MaxValue = 79228162514264337593543950335", ToolTip(@decimal.FindField("MaxValue")));
		Assert.Equal("(constant) decimal decimal.MinusOne = -1", ToolTip(@decimal.FindField("MinusOne")));
		Assert.Equal("(constant) char char.MinValue = '\\0'", ToolTip(Type(CoreLib.Value, "System.Char").FindField("MinValue")));
		Assert.Equal("(constant) double Math.PI = 3.141592653589793", ToolTip(Type(CoreLib.Value, "System.Math").FindField("PI")));
		Assert.Equal("(constant) double double.NaN = NaN", ToolTip(Type(CoreLib.Value, "System.Double").FindField("NaN")));
		Assert.Equal("(constant) double double.NegativeInfinity = -Infinity", ToolTip(Type(CoreLib.Value, "System.Double").FindField("NegativeInfinity")));
	}

	[Fact]
	public void WritesPropertyAndEventToolTips() {
		var library = TargetType("Library");
		Assert.Equal("string Library.Title { get; init; }", ToolTip(library.FindProperty("Title")));
		Assert.Equal("int Library.this[int index] { get; }", ToolTip(library.FindProperty("Item")));
		Assert.Equal("EventHandler Library.Opened { add; remove; }", ToolTip(library.FindEvent("Opened")));
		Assert.Equal("[deprecated] ApartmentState Thread.ApartmentState { get; set; }",
			ToolTip(Type(CoreLib.Value, "System.Threading.Thread").FindProperty("ApartmentState")));
	}

	[Fact]
	public void WritesTypeToolTips() {
		Assert.Equal("class SearchTarget.Library", ToolTip(TargetType("Library")));
		Assert.Equal("class SearchTarget.Library.Nested<T>", ToolTip(Type(Target.Value, "SearchTarget.Library+Nested`1")));
		Assert.Equal("class SearchTarget.Generic<TKey, TValue>", ToolTip(TargetType("Generic`2")));
		Assert.Equal("enum SearchTarget.Color", ToolTip(TargetType("Color")));
		Assert.Equal("interface SearchTarget.IThing", ToolTip(TargetType("IThing")));
		Assert.Equal("struct SearchTarget.Point", ToolTip(TargetType("Point")));
		Assert.Equal("delegate void SearchTarget.Handler()", ToolTip(TargetType("Handler")));
		Assert.Equal("delegate TResult System.Func<out TResult>()", ToolTip(Type(CoreLib.Value, "System.Func`1")));
		Assert.Equal("readonly struct System.DateTime", ToolTip(Type(CoreLib.Value, "System.DateTime")));
		// A type's keyword is never used for its name.
		Assert.Equal("class System.String", ToolTip(Type(CoreLib.Value, "System.String")));
		Assert.Equal("(awaitable) class System.Threading.Tasks.Task<TResult>", ToolTip(Type(CoreLib.Value, "System.Threading.Tasks.Task`1")));
	}

	[Fact]
	public void FormatsConstantsTheWayCSharpFormatterDoes() {
		var (_, type) = NewType();
		FieldDef Constant(string name, object? value, TypeSig fieldType) {
			var field = new FieldDefUser(name, new FieldSig(fieldType), FieldAttributes.Public | FieldAttributes.Static | FieldAttributes.Literal | FieldAttributes.HasDefault) {
				Constant = value is null ? new ConstantUser(null, ElementType.Class) : new ConstantUser(value),
			};
			type.Fields.Add(field);
			return field;
		}
		var corLib = type.Module.CorLibTypes;
		string Value(FieldDef field, Options extra = Options.None) => ToolTip(field, ToolTipOptions | extra)["(constant) ".Length..];

		var minusOne = Constant("MinusOne", (sbyte)-1, corLib.SByte);
		Assert.Equal("sbyte C.MinusOne = 0xFF", Value(minusOne));
		Assert.Equal("sbyte C.MinusOne = -1", Value(minusOne, Options.UseDecimal));
		var big = Constant("Big", -1234567L, corLib.Int64);
		Assert.Equal("long C.Big = 0xFFFFFFFFFFED2979", Value(big));
		Assert.Equal("long C.Big = 0xFFFF_FFFF_FFED_2979", Value(big, Options.DigitSeparators));
		Assert.Equal("long C.Big = -1_234_567", Value(big, Options.UseDecimal | Options.DigitSeparators));
		Assert.Equal("ushort C.Small = 0x002A", Value(Constant("Small", (ushort)42, corLib.UInt16), Options.DigitSeparators));
		Assert.Equal("bool C.Yes = true", Value(Constant("Yes", true, corLib.Boolean)));
		Assert.Equal("object C.Nothing = null", Value(Constant("Nothing", null, corLib.Object)));
		Assert.Equal("float C.Ratio = 2.5", Value(Constant("Ratio", 2.5f, corLib.Single)));
		Assert.Equal("char C.Quote = '\\''", Value(Constant("Quote", '\'', corLib.Char)));
		Assert.Equal("char C.Bell = '\\u0001'", Value(Constant("Bell", '\u0001', corLib.Char)));
		Assert.Equal("char C.DoubleQuote = '\"'", Value(Constant("DoubleQuote", '"', corLib.Char)));
		// A string with a backslash and nothing a verbatim string can't hold is written verbatim.
		var path = Constant("Path", "C:\\dir \"x\"", corLib.String);
		Assert.Equal("string C.Path = @\"C:\\dir \"\"x\"\"\"", Value(path));
		Assert.Equal(new TextPartDto("@\"C:\\dir \"\"x\"\"\"", TextColors.VerbatimString), ToolTipParts(path).ToParts()[^1]);
		Assert.Equal("string C.Lines = \"a\\\\b\\n\\t\\\"\\u0001\"", Value(Constant("Lines", "a\\b\n\t\"\u0001", corLib.String)));
		Assert.Equal("string C.Plain = \"it's\"", Value(Constant("Plain", "it's", corLib.String)));

		// Without the flag a constant is only its type and name; field types go with their own flag.
		Assert.Equal("(constant) C.Yes", ToolTip(type.FindField("Yes"), Options.DeclaringTypes));
		Assert.Equal("Yes", Name(type.FindField("Yes"), Options.None));
	}

	[Fact]
	public void WritesParameterDefaultValues() {
		var (module, type) = NewType();
		var corLib = module.CorLibTypes;
		var method = new MethodDefUser("Run", MethodSig.CreateStatic(corLib.Void, corLib.Int32, corLib.String, corLib.Boolean, corLib.Int32),
			MethodAttributes.Public | MethodAttributes.Static);
		type.Methods.Add(method);
		method.ParamDefs.Add(new ParamDefUser("count", 1, ParamAttributes.Optional | ParamAttributes.HasDefault) { Constant = new ConstantUser(5) });
		method.ParamDefs.Add(new ParamDefUser("label", 2, ParamAttributes.Optional | ParamAttributes.HasDefault) { Constant = new ConstantUser(null, ElementType.Class) });
		method.ParamDefs.Add(new ParamDefUser("flag", 3, ParamAttributes.Optional | ParamAttributes.HasDefault) { Constant = new ConstantUser(true) });
		method.ParamDefs.Add(new ParamDefUser("plain", 4));
		method.Parameters.UpdateParameterTypes();

		Assert.Equal("void C.Run([int count  = 0x00000005], [string label  = null], [bool flag  = true], int plain)", ToolTip(method));
		Assert.Equal("void C.Run([int count  = 5], [string label  = null], [bool flag  = true], int plain)", ToolTip(method, ToolTipOptions | Options.UseDecimal));
		Assert.Equal("Run([int  = 0x00000005], [string  = null], [bool  = true], int)", Name(method, Options.ParameterTypes | Options.IntrinsicTypeKeywords | Options.ParameterLiteralValues));
		Assert.Equal("Run([count  = 0x00000005], [label  = null], [flag  = true], plain)", Name(method, Options.ParameterNames | Options.ParameterLiteralValues));
		Assert.Equal("Run([int count], [string label], [bool flag], int plain)", Name(method, Options.ParameterTypes | Options.ParameterNames | Options.IntrinsicTypeKeywords));
	}

	[Fact]
	public void CutsTheTextShortPastFourThousandCharacters() {
		var (_, type) = NewType();
		var text = new string('a', 5000);
		var field = new FieldDefUser("Long", new FieldSig(type.Module.CorLibTypes.String), FieldAttributes.Public | FieldAttributes.Static | FieldAttributes.Literal | FieldAttributes.HasDefault) {
			Constant = new ConstantUser(text),
		};
		type.Fields.Add(field);

		var parts = ToolTipParts(field).ToParts();
		var full = "(constant) string C.Long = \"" + text + "\"";
		Assert.Equal(full[..4096] + "[...]", string.Concat(parts.Select(part => part.Text)));
		Assert.Equal(TextColors.String, parts[^1].Color);
	}

	static (ModuleDef Module, TypeDef Type) NewType() {
		var module = new ModuleDefUser("Memory.dll");
		new AssemblyDefUser("Memory").Modules.Add(module);
		var type = new TypeDefUser("", "C", module.CorLibTypes.Object.TypeDefOrRef) { Attributes = TypeAttributes.Public | TypeAttributes.Abstract | TypeAttributes.Sealed };
		module.Types.Add(type);
		return (module, type);
	}
}
