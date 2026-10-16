using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using SearchTarget;
using Xunit;
using Options = dnSpy.Backend.Core.CSharpMemberFormatter.Options;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The Visual Basic member formatter against what dnSpy's VisualBasicFormatter prints: a search result's name
/// (the search window's flags) and its tooltip (the decompiler's), for the fixtures, the framework, and a module
/// built here for the shapes no fixture has — literals of every kind, optional and ByRef parameters, a VB module.
/// </summary>
public sealed class VisualBasicMemberFormatterTests : IDisposable {
	// SearchResult.DefaultFormatterOptions: FormatterOptions.Default without parameter names, declaring types and field literal values.
	const Options SearchOptions = Options.ParameterTypes | Options.ReturnTypes | Options.FieldTypes | Options.IntrinsicTypeKeywords;

	// DecompilerBase.DefaultFormatterOptions: FormatterOptions.Default with parameter literal values.
	const Options ToolTipOptions = Options.ParameterTypes | Options.ParameterNames | Options.DeclaringTypes | Options.ReturnTypes
		| Options.FieldTypes | Options.IntrinsicTypeKeywords | Options.FieldLiteralValues | Options.ParameterLiteralValues;

	// One resolver for every module, so a type another assembly defines resolves the way it does in dnSpy.
	readonly ModuleContext context = CreateContext();
	readonly List<ModuleDef> modules = [];

	public void Dispose() {
		foreach (var module in modules)
			module.Dispose();
	}

	static ModuleContext CreateContext() {
		var context = ModuleDef.CreateModuleContext();
		var resolver = (AssemblyResolver)context.AssemblyResolver;
		resolver.PreSearchPaths.Add(Path.GetDirectoryName(typeof(object).Assembly.Location)!);
		resolver.PreSearchPaths.Add(AppContext.BaseDirectory);
		return context;
	}

	ModuleDef Load(string path) {
		var module = ModuleDefMD.Load(path, context);
		modules.Add(module);
		return module;
	}

	ModuleDef SearchTarget => Load(typeof(Library).Assembly.Location);
	ModuleDef AnalyzerTarget => Load(typeof(AnalyzerTarget.Circle).Assembly.Location);
	ModuleDef DebugTarget => Load(Path.Combine(AppContext.BaseDirectory, "DebugTarget.dll"));
	ModuleDef CoreLib => Load(typeof(object).Assembly.Location);
	ModuleDef Linq => Load(typeof(Enumerable).Assembly.Location);

	static TypeDef Type(ModuleDef module, string fullName) =>
		module.Find(fullName, isReflectionName: true) ?? throw new InvalidOperationException($"No type {fullName}");

	static string Write(IMemberDef member, Options options = SearchOptions) {
		var output = new TextPartsBuilder();
		VisualBasicMemberFormatter.Write(output, member, options);
		return output.ToString();
	}

	static string ToolTip(IMemberDef member, Options options = ToolTipOptions) {
		var output = new TextPartsBuilder();
		VisualBasicMemberFormatter.WriteToolTip(output, member, options);
		return output.ToString();
	}

	static IEnumerable<(string Text, string Color)> Parts(Action<TextPartsBuilder> write) {
		var output = new TextPartsBuilder();
		write(output);
		return output.ToParts().Select(part => (part.Text, part.Color));
	}

	[Fact]
	public void WritesMethodsLikeTheSearchListDoes() {
		var library = Type(SearchTarget, "SearchTarget.Library");
		MethodDef Method(string name) => library.FindMethod(name);

		Assert.Equal("Function Describe(Integer, [String], ParamArray Object()) As String", Write(Method("Describe")));
		Assert.Equal("Sub Raise()", Write(Method("Raise")));
		Assert.Equal("Sub New()", Write(Method(".ctor")));
		Assert.Equal("Operator +(Library, Library) As Library", Write(Method("op_Addition")));
		Assert.Equal("Widening Operator CType(Library) As String", Write(Method("op_Implicit")));
		Assert.Equal("Function Counter() As IEnumerable(Of Integer)", Write(Method("Counter")));
		Assert.Equal("Function Lambda() As Func(Of Integer)", Write(Method("Lambda")));
		// An accessor is the member it belongs to; a setter's type is its last parameter.
		Assert.Equal("Property Get Title() As String", Write(Method("get_Title")));
		Assert.Equal("Property Set Title(String) As String", Write(Method("set_Title")));
		Assert.Equal("Event Add Opened As EventHandler", Write(Method("add_Opened")));

		var program = Type(DebugTarget, "DebugTarget.Program");
		Assert.Equal("Function Identity(Of T)(T) As T", Write(program.FindMethod("Identity")));
		Assert.Equal("Sub Main(String())", Write(program.FindMethod("Main")));

		Assert.Equal("Function Any(Of TSource)(IEnumerable(Of TSource)) As Boolean",
			Write(Type(Linq, "System.Linq.Enumerable").Methods.Single(method => method.Name == "Any" && method.Parameters.Count == 1)));
		Assert.Equal("Function Compare(Of T)(T?, T?) As Integer", Write(Type(CoreLib, "System.Nullable").FindMethod("Compare")));
		Assert.Equal("Function Increment(ByRef Integer) As Integer",
			Write(Type(CoreLib, "System.Threading.Interlocked").Methods.Single(method => method.Name == "Increment" && method.MethodSig.Params[0].Next.ElementType == ElementType.I4)));
	}

	[Fact]
	public void WritesPropertiesEventsFieldsAndTypesLikeTheSearchListDoes() {
		var library = Type(SearchTarget, "SearchTarget.Library");

		Assert.Equal("Property Title As String", Write(library.FindProperty("Title")));
		Assert.Equal("ReadOnly Property Item(Integer) As Integer", Write(library.FindProperty("Item")));
		Assert.Equal("Event Opened As EventHandler", Write(library.FindEvent("Opened")));
		// No literal value in the search list, and an enum's constants go without a type.
		Assert.Equal("Answer As Integer", Write(library.FindField("Answer")));
		Assert.Equal("Red", Write(Type(SearchTarget, "SearchTarget.Color").FindField("Red")));
		Assert.Equal("Value As T", Write(Type(SearchTarget, "SearchTarget.Library+Nested`1").FindField("Value")));

		// A type is its name and its enclosing types', without generic parameters.
		Assert.Equal("Library", Write(library));
		Assert.Equal("Library.Nested", Write(Type(SearchTarget, "SearchTarget.Library+Nested`1")));
		Assert.Equal("Generic", Write(Type(SearchTarget, "SearchTarget.Generic`2")));

		var box = Type(AnalyzerTarget, "AnalyzerTarget.Box`1");
		Assert.Equal("Property Item(Integer) As T", Write(box.FindProperty("Item")));
		Assert.Equal("Property Set Item(Integer, T) As T", Write(box.FindMethod("set_Item")));
		// A name that is a keyword is bracketed; an explicit implementation goes by the name it implements.
		Assert.Equal("Property [Property] As Circle", Write(Type(AnalyzerTarget, "AnalyzerTarget.Exposer").FindProperty("Property")));
		Assert.Equal("ReadOnly Property Name As String", Write(Type(AnalyzerTarget, "AnalyzerTarget.Square").Properties.Single()));
	}

	[Fact]
	public void WritesToolTipsLikeTheDecompilerDoes() {
		var library = Type(SearchTarget, "SearchTarget.Library");
		MethodDef Method(string name) => library.FindMethod(name);

		// A default value goes in brackets, two spaces before its "=".
		Assert.Equal("Function Library.Describe(count As Integer, [label As String  = \"x\"], ParamArray rest As Object()) As String", ToolTip(Method("Describe")));
		Assert.Equal("Sub Library.New()", ToolTip(Method(".ctor")));
		Assert.Equal("Operator Library.+(left As Library, right As Library) As Library", ToolTip(Method("op_Addition")));
		Assert.Equal("Widening Operator Library.CType(value As Library) As String", ToolTip(Method("op_Implicit")));
		Assert.Equal("Property Get Library.Title() As String", ToolTip(Method("get_Title")));
		Assert.Equal("Property Set Library.Title(value As String) As String", ToolTip(Method("set_Title")));
		Assert.Equal("Property Library.Title As String", ToolTip(library.FindProperty("Title")));
		Assert.Equal("ReadOnly Property Library.Item(index As Integer) As Integer", ToolTip(library.FindProperty("Item")));
		Assert.Equal("Event Library.Opened As EventHandler", ToolTip(library.FindEvent("Opened")));
		Assert.Equal("(constant) Library.Answer As Integer = &H00001092", ToolTip(library.FindField("Answer")));
		Assert.Equal("(constant) Library.Greeting As String = \"field-literal-needle\"", ToolTip(library.FindField("Greeting")));
		Assert.Equal("Color.Green = &H00000001", ToolTip(Type(SearchTarget, "SearchTarget.Color").FindField("Green")));
		Assert.Equal("(field) Point.X As Integer", ToolTip(Type(SearchTarget, "SearchTarget.Point").FindField("X")));
		Assert.Equal("(field) Library.Nested.Value As T", ToolTip(Type(SearchTarget, "SearchTarget.Library+Nested`1").FindField("Value")));

		Assert.Equal("<Extension> Function ShapeExtensions.Diameter(circle As Circle) As Double", ToolTip(Type(AnalyzerTarget, "AnalyzerTarget.ShapeExtensions").FindMethod("Diameter")));
		Assert.Equal("Sub Circle.New(radius As Double)", ToolTip(Type(AnalyzerTarget, "AnalyzerTarget.Circle").FindMethod(".ctor")));
		Assert.Equal("(constant) Circle.Pi As Double = 3.14", ToolTip(Type(AnalyzerTarget, "AnalyzerTarget.Circle").FindField("Pi")));
		Assert.Equal("<Awaitable> Function Program.AddAsync(left As Integer, right As Integer) As Task(Of Integer)", ToolTip(Type(DebugTarget, "DebugTarget.Program").FindMethod("AddAsync")));
	}

	[Fact]
	public void WritesTheFrameworksToolTipsLikeTheDecompilerDoes() {
		Assert.Equal("(Deprecated) Sub Thread.Abort() (+ 1 overload)", ToolTip(Type(CoreLib, "System.Threading.Thread").Methods.Single(method => method.Name == "Abort" && method.MethodSig.Params.Count == 0)));
		Assert.Equal("(Deprecated) ReadOnly Property Encoding.UTF7 As Encoding", ToolTip(Type(CoreLib, "System.Text.Encoding").FindProperty("UTF7")));
		Assert.Equal("ReadOnly Property Date.Now As Date", ToolTip(Type(CoreLib, "System.DateTime").FindProperty("Now")));
		Assert.Equal("(constant) Integer.MaxValue As Integer = &H7FFFFFFF", ToolTip(Type(CoreLib, "System.Int32").FindField("MaxValue")));
		Assert.Equal("(constant) Decimal.MaxValue As Decimal = 79228162514264337593543950335", ToolTip(Type(CoreLib, "System.Decimal").FindField("MaxValue")));
		Assert.Equal("(constant) Double.NaN As Double = NaN", ToolTip(Type(CoreLib, "System.Double").FindField("NaN")));
		Assert.Equal("(constant) Double.NegativeInfinity As Double = -Infinity", ToolTip(Type(CoreLib, "System.Double").FindField("NegativeInfinity")));

		// Hex unless UseDecimal; digit separators group four hex digits, three decimal ones, never after a minus.
		var maxValue = Type(CoreLib, "System.Int32").FindField("MaxValue");
		var minValue = Type(CoreLib, "System.Int64").FindField("MinValue");
		Assert.Equal("MaxValue As Integer = &H7FFF_FFFF", Write(maxValue, Options.FieldLiteralValues | Options.IntrinsicTypeKeywords | Options.DigitSeparators));
		Assert.Equal("MaxValue As Integer = 2_147_483_647", Write(maxValue, Options.FieldLiteralValues | Options.IntrinsicTypeKeywords | Options.DigitSeparators | Options.UseDecimal));
		Assert.Equal("MinValue As Long = -9_223_372_036_854_775_808", Write(minValue, Options.FieldLiteralValues | Options.IntrinsicTypeKeywords | Options.DigitSeparators | Options.UseDecimal));
		Assert.Equal("MinValue As Int64 = &H8000000000000000", Write(minValue, Options.FieldLiteralValues));

		// A type's tooltip always has its namespace, and the keyword that declares it.
		Assert.Equal("Interface System.Collections.Generic.IEnumerable(Of Out T)", ToolTip(Type(CoreLib, "System.Collections.Generic.IEnumerable`1")));
		Assert.Equal("Delegate Function System.Func(Of In T, Out TResult)(arg As T) As TResult", ToolTip(Type(CoreLib, "System.Func`2")));
		Assert.Equal("<Awaitable> Class System.Threading.Tasks.Task(Of TResult)", ToolTip(Type(CoreLib, "System.Threading.Tasks.Task`1")));
		Assert.Equal("Class SearchTarget.Library", ToolTip(Type(SearchTarget, "SearchTarget.Library")));
		Assert.Equal("Class SearchTarget.Library.Nested(Of T)", ToolTip(Type(SearchTarget, "SearchTarget.Library+Nested`1")));
		Assert.Equal("Class SearchTarget.Generic(Of TKey, TValue)", ToolTip(Type(SearchTarget, "SearchTarget.Generic`2")));
		Assert.Equal("Enum SearchTarget.Color", ToolTip(Type(SearchTarget, "SearchTarget.Color")));
		Assert.Equal("Structure SearchTarget.Point", ToolTip(Type(SearchTarget, "SearchTarget.Point")));
		Assert.Equal("Interface SearchTarget.IThing", ToolTip(Type(SearchTarget, "SearchTarget.IThing")));
		Assert.Equal("Delegate Sub SearchTarget.Handler()", ToolTip(Type(SearchTarget, "SearchTarget.Handler")));
	}

	[Fact]
	public void WritesLiteralsTheWayVisualBasicSpellsThem() {
		var (_, constants, _) = CreateModule();
		string Constant(string name, Options options = ToolTipOptions) => ToolTip(constants.FindField(name), options);

		// A quote doubled, a control character between the quoted runs as its vb constant or as ChrW.
		Assert.Equal("(constant) Constants.Text As String = \"a\"\"b\" & vbCrLf & \"c\" & vbTab & \"d\" & ChrW(&H0001)", Constant("Text"));
		Assert.Equal("(constant) Constants.Lines As String = vbLf & \"x\" & vbCr", Constant("Lines"));
		Assert.Equal("(constant) Constants.Empty As String = \"\"", Constant("Empty"));
		// A name that is a keyword in any casing is bracketed.
		Assert.Equal("(constant) Constants.[Nothing] As String = Nothing", Constant("Nothing"));
		Assert.Equal("(constant) Constants.Letter As Char = \"A\"c", Constant("Letter"));
		Assert.Equal("(constant) Constants.Quote As Char = \"\"\"\"c", Constant("Quote"));
		Assert.Equal("(constant) Constants.Tab As Char = vbTab", Constant("Tab"));
		Assert.Equal("(constant) Constants.Bell As Char = ChrW(&H0007)", Constant("Bell"));
		Assert.Equal("(constant) Constants.Yes As Boolean = True", Constant("Yes"));
		Assert.Equal("(constant) Constants.Half As Single = 1.5", Constant("Half"));
		Assert.Equal("(constant) Constants.MinusOne As SByte = &HFF", Constant("MinusOne"));
		Assert.Equal("(constant) Constants.MinusOne As SByte = -1", Constant("MinusOne", ToolTipOptions | Options.UseDecimal));
		Assert.Equal("(constant) Constants.Small As Short = &HFFFE", Constant("Small"));
		Assert.Equal("(constant) Constants.Huge As ULong = &HFFFFFFFFFFFFFFFF", Constant("Huge"));
		Assert.Equal("(constant) Constants.Huge As ULong = &HFFFF_FFFF_FFFF_FFFF", Constant("Huge", ToolTipOptions | Options.DigitSeparators));
	}

	[Fact]
	public void WritesParametersAndTypesTheWayVisualBasicSpellsThem() {
		var (_, constants, helpers) = CreateModule();

		Assert.Equal("Sub M(ByRef Integer, [String], [Char])", Write(constants.FindMethod("M")));
		Assert.Equal("Sub Constants.M(ByRef r As Integer, [o As String  = Nothing], [c As Char  = \"x\"c])", ToolTip(constants.FindMethod("M")));
		// Without parameter literal values an optional parameter is only its brackets.
		Assert.Equal("Sub Constants.M(ByRef r As Integer, [o As String], [c As Char])", ToolTip(constants.FindMethod("M"), ToolTipOptions & ~Options.ParameterLiteralValues));
		Assert.Equal("Function Constants.Shapes([error] As Integer(,), p As Integer*, v As Integer(*)) As (Count As Integer, Name As String)", ToolTip(constants.FindMethod("Shapes")));
		Assert.Equal("Sub Va(Integer, __ArgList)", Write(constants.FindMethod("Va")));
		Assert.Equal("Sub Constants.Over() (+ 2 overloads)", ToolTip(constants.FindMethod("Over")));
		// Module names: a method's in front of its keyword, a field's after its "(constant)".
		Assert.Equal("Literals.dll!Sub Over()", Write(constants.FindMethod("Over"), SearchOptions | Options.ModuleNames));
		Assert.Equal("Module Lits.Helpers", ToolTip(helpers));
		Assert.Equal("Sub Helpers.Run()", ToolTip(helpers.FindMethod("Run")));
	}

	[Fact]
	public void ColorsWhatItWritesTheWayDnSpyDoes() {
		var describe = Type(SearchTarget, "SearchTarget.Library").FindMethod("Describe");
		Assert.Equal(
			[("Function", TextColors.Keyword), (" ", TextColors.Text), ("Describe", TextColors.InstanceMethod), ("(", TextColors.Punctuation),
				("Integer", TextColors.Keyword), (",", TextColors.Punctuation), (" ", TextColors.Text), ("[", TextColors.Punctuation),
				("String", TextColors.Keyword), ("],", TextColors.Punctuation), (" ", TextColors.Text),
				("ParamArray", TextColors.Keyword), (" ", TextColors.Text), ("Object", TextColors.Keyword), ("())", TextColors.Punctuation),
				(" ", TextColors.Text), ("As", TextColors.Keyword), (" ", TextColors.Text), ("String", TextColors.Keyword)],
			Parts(output => VisualBasicMemberFormatter.Write(output, describe, SearchOptions)));

		var answer = Type(SearchTarget, "SearchTarget.Library").FindField("Answer");
		Assert.Equal(
			[("(", TextColors.Punctuation), ("constant", TextColors.Text), (")", TextColors.Punctuation), (" ", TextColors.Text),
				("Library", TextColors.Type), (".", TextColors.Operator), ("Answer", TextColors.LiteralField), (" ", TextColors.Text),
				("As", TextColors.Keyword), (" ", TextColors.Text), ("Integer", TextColors.Keyword), (" ", TextColors.Text),
				("=", TextColors.Operator), (" ", TextColors.Text), ("&H00001092", TextColors.Number)],
			Parts(output => VisualBasicMemberFormatter.WriteToolTip(output, answer, ToolTipOptions)));

		var addition = Type(SearchTarget, "SearchTarget.Library").FindMethod("op_Addition");
		Assert.Equal([("Operator", TextColors.Keyword), (" ", TextColors.Text), ("+", TextColors.Operator), ("(", TextColors.Punctuation)],
			Parts(output => VisualBasicMemberFormatter.Write(output, addition, SearchOptions)).Take(4));

		// A VB module is colored as one; a control character as a call to ChrW.
		var (_, constants, helpers) = CreateModule();
		Assert.Equal([("Module", TextColors.Keyword), (" ", TextColors.Text), ("Lits", TextColors.Namespace), (".", TextColors.Operator), ("Helpers", TextColors.Module)],
			Parts(output => VisualBasicMemberFormatter.WriteToolTip(output, helpers, ToolTipOptions)));
		Assert.Equal([("ChrW", TextColors.StaticMethod), ("(", TextColors.Punctuation), ("&H0007", TextColors.Number), (")", TextColors.Punctuation)],
			Parts(output => VisualBasicMemberFormatter.Write(output, constants.FindField("Bell"), Options.FieldLiteralValues)).TakeLast(4));
	}

	/// <summary>A module with what no fixture has: constants of every kind, optional and ByRef parameters, a VB module.</summary>
	static (ModuleDef Module, TypeDef Constants, TypeDef Helpers) CreateModule() {
		var module = new ModuleDefUser("Literals.dll") { Location = "/tmp/Literals.dll" };
		var corLib = module.CorLibTypes;
		var constants = new TypeDefUser("Lits", "Constants", corLib.Object.TypeDefOrRef) { Attributes = TypeAttributes.Public };
		module.Types.Add(constants);

		void AddConstant(string name, TypeSig type, object? value) =>
			constants.Fields.Add(new FieldDefUser(name, new FieldSig(type), FieldAttributes.Public | FieldAttributes.Static | FieldAttributes.Literal | FieldAttributes.HasDefault) {
				Constant = value is null ? new ConstantUser(null, ElementType.Class) : new ConstantUser(value),
			});
		AddConstant("Text", corLib.String, "a\"b\r\nc\td\u0001");
		AddConstant("Lines", corLib.String, "\nx\r");
		AddConstant("Empty", corLib.String, "");
		AddConstant("Nothing", corLib.String, null);
		AddConstant("Letter", corLib.Char, 'A');
		AddConstant("Quote", corLib.Char, '"');
		AddConstant("Tab", corLib.Char, '\t');
		AddConstant("Bell", corLib.Char, '\a');
		AddConstant("Yes", corLib.Boolean, true);
		AddConstant("Half", corLib.Single, 1.5f);
		AddConstant("MinusOne", corLib.SByte, (sbyte)-1);
		AddConstant("Small", corLib.Int16, (short)-2);
		AddConstant("Huge", corLib.UInt64, ulong.MaxValue);

		MethodDefUser AddMethod(string name, MethodSig signature, params ParamDefUser[] parameters) {
			var method = new MethodDefUser(name, signature, MethodImplAttributes.IL, MethodAttributes.Public | MethodAttributes.Static);
			constants.Methods.Add(method);
			foreach (var parameter in parameters)
				method.ParamDefs.Add(parameter);
			return method;
		}
		AddMethod("M", MethodSig.CreateStatic(corLib.Void, new ByRefSig(corLib.Int32), corLib.String, corLib.Char),
			new ParamDefUser("r", 1),
			new ParamDefUser("o", 2, ParamAttributes.Optional | ParamAttributes.HasDefault) { Constant = new ConstantUser(null, ElementType.Class) },
			new ParamDefUser("c", 3, ParamAttributes.Optional | ParamAttributes.HasDefault) { Constant = new ConstantUser('x') });

		// A named tuple, a two-dimensional array, a pointer, a one-dimensional non-vector array.
		var valueTuple = new TypeRefUser(module, "System", "ValueTuple`2", corLib.AssemblyRef);
		var tupleNames = new TypeRefUser(module, "System.Runtime.CompilerServices", "TupleElementNamesAttribute", corLib.AssemblyRef);
		var tupleNamesConstructor = new MemberRefUser(module, ".ctor", MethodSig.CreateInstance(corLib.Void, new SZArraySig(corLib.String)), tupleNames);
		var returnParameter = new ParamDefUser(null, 0);
		returnParameter.CustomAttributes.Add(new CustomAttribute(tupleNamesConstructor, [
			new CAArgument(new SZArraySig(corLib.String), new List<CAArgument> { new(corLib.String, new UTF8String("Count")), new(corLib.String, new UTF8String("Name")) }),
		]));
		AddMethod("Shapes", MethodSig.CreateStatic(new GenericInstSig(new ValueTypeSig(valueTuple), corLib.Int32, corLib.String),
				new ArraySig(corLib.Int32, 2), new PtrSig(corLib.Int32), new ArraySig(corLib.Int32, 1)),
			returnParameter, new ParamDefUser("error", 1), new ParamDefUser("p", 2), new ParamDefUser("v", 3));

		var varArg = MethodSig.CreateStatic(corLib.Void, corLib.Int32);
		varArg.CallingConvention = CallingConvention.VarArg;
		AddMethod("Va", varArg);
		AddMethod("Over", MethodSig.CreateStatic(corLib.Void));
		AddMethod("Over", MethodSig.CreateStatic(corLib.Void, corLib.Int32));
		AddMethod("Over", MethodSig.CreateStatic(corLib.Void, corLib.String));

		var standardModule = new TypeRefUser(module, "Microsoft.VisualBasic.CompilerServices", "StandardModuleAttribute",
			new AssemblyRefUser("Microsoft.VisualBasic"));
		var helpers = new TypeDefUser("Lits", "Helpers", corLib.Object.TypeDefOrRef) { Attributes = TypeAttributes.Public | TypeAttributes.Sealed };
		helpers.CustomAttributes.Add(new CustomAttribute(new MemberRefUser(module, ".ctor", MethodSig.CreateInstance(corLib.Void), standardModule)));
		module.Types.Add(helpers);
		helpers.Methods.Add(new MethodDefUser("Run", MethodSig.CreateStatic(corLib.Void), MethodImplAttributes.IL, MethodAttributes.Public | MethodAttributes.Static));
		return (module, constants, helpers);
	}
}
