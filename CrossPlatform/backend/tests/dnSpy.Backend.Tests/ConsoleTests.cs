using System.Text.RegularExpressions;
using System.Xml.Linq;
using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using dnSpy.Cli;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// dnSpy.Console's own behaviour: the switches it reads, the text it writes for each language, and
/// the project export it performs. The console is run in process, with no colouring and its output
/// captured, which is also how it runs when its stdout is a pipe.
/// </summary>
public sealed class ConsoleTests : IDisposable {
	readonly string temporaryDirectory = Path.Combine(Path.GetTempPath(), "dnspy-console-tests", Guid.NewGuid().ToString("N"));
	string TemporaryDirectory {
		get {
			Directory.CreateDirectory(temporaryDirectory);
			return temporaryDirectory;
		}
	}

	public void Dispose() {
		try {
			if (Directory.Exists(temporaryDirectory))
				Directory.Delete(temporaryDirectory, recursive: true);
		}
		catch (IOException) {
		}
	}

	// ---------------------------------------------------------------- Help and errors

	[Fact]
	public void NoArgumentsPrintTheHelpAndTheMissingOptionsError() {
		var result = Run();

		Assert.Equal(1, result.ExitCode);
		Assert.Contains("[options] [fileOrDir1]", result.Output, StringComparison.Ordinal);
		Assert.Contains("Languages:", result.Output, StringComparison.Ordinal);
		Assert.Contains("  C# ({4162dada-67c3-4de4-a5f3-6552c8353ece})", result.Output, StringComparison.Ordinal);
		Assert.Contains("  IL with C# ({ca52a515-12ae-4182-bc88-81ed037c3d32})", result.Output, StringComparison.Ordinal);
		Assert.Contains("Language options:", result.Output, StringComparison.Ordinal);
		Assert.Contains("Examples:", result.Output, StringComparison.Ordinal);
		Assert.EndsWith("ERROR: No options specified" + Environment.NewLine, result.Output, StringComparison.Ordinal);
	}

	[Fact]
	public void TheHelpListsEveryOptionOfTheTwoSettingsTheLanguagesShare() {
		var output = Run().Output;

		// CSharpVBDecompilerSettings: every option dnSpy's C# and Visual Basic decompilers have, in its order.
		string[] csharp = [
			"member-order", "anon-methods", "expr-trees", "yield", "async", "auto-props", "auto-events", "using-stmt",
			"foreach-stmt", "lock-stmt", "switch-string", "using-decl", "query-expr", "ambig-full-names", "full-names",
			"use-debug-syms", "obj-inits", "xml-doc", "remove-emtpy-ctors", "inc-dec", "make-assign-expr",
			"always-create-ex-var", "tokens", "sort-members", "show-all", "system-first", "max-array-elems",
			"max-string-length", "sort-custom-attrs", "src-order", "field-initializers", "one-ca-per-line",
			"internal-modifier-type", "private-modifier-member", "remove-new-delegate-class", "hex",
			"emit-calli-as-invoke", "insert-parentheses-for-readability",
		];
		// ILDecompilerSettings, which both IL languages share.
		string[] il = ["comments", "xml-doc", "tokens", "bytes", "sort-members", "pdb-info", "max-string-length", "hex"];

		var options = Section(output, "Language options:", "Examples:");
		var csharpGroup = Section(options, "  Visual Basic ({bba40092-76b2-4184-8e81-0f1e3ed14e72})", "  IL ({a4f35508");
		Assert.Equal(csharp, OptionNames(csharpGroup));
		var ilGroup = options[options.IndexOf("  IL with C# ({ca52a515-12ae-4182-bc88-81ed037c3d32})", StringComparison.Ordinal)..];
		Assert.Equal(il, OptionNames(ilGroup));

		// The type and the value of each, and its description, the way the WPF console prints them.
		Assert.Contains("    --member-order\t(String = mpeft) Decompilation order", csharpGroup, StringComparison.Ordinal);
		Assert.Contains("    --tokens\t(Boolean = True) Show tokens, RVAs and file offsets", csharpGroup, StringComparison.Ordinal);
		Assert.Contains("    --max-array-elems\t(Int32 = 10000) Max number of array elements to show", csharpGroup, StringComparison.Ordinal);
		Assert.Contains("    --hex\t(Boolean = False) Hexadecimal numbers", csharpGroup, StringComparison.Ordinal);
		Assert.Contains("    --comments\t(Boolean = False) Show IL opcode comments", ilGroup, StringComparison.Ordinal);
		Assert.Contains("    --max-string-length\t(Int32 = 20000) Max string length", ilGroup, StringComparison.Ordinal);
	}

	[Fact]
	public void TheHelpShowsTheValuesTheCommandLineSet() {
		// The options are set on the languages' shared settings before the missing output directory is found.
		var result = Run("--hex", "--no-tokens", "--member-order", "tfepm", ContractsAssembly);

		Assert.Equal(1, result.ExitCode);
		Assert.Contains("    --hex\t(Boolean = True)", result.Output, StringComparison.Ordinal);
		Assert.Contains("    --tokens\t(Boolean = False)", result.Output, StringComparison.Ordinal);
		Assert.Contains("    --member-order\t(String = tfepm)", result.Output, StringComparison.Ordinal);
		Assert.EndsWith("ERROR: Missing output directory" + Environment.NewLine, result.Output, StringComparison.Ordinal);
	}

	[Fact]
	public void ReportsAnUnknownTypeAnInvalidTokenAndAnInvalidNumber() {
		var unknownType = Run("--no-color", "-t", "NoSuchType", ContractsAssembly);
		Assert.Equal(1, unknownType.ExitCode);
		Assert.Contains("ERROR: Type NoSuchType couldn't be found", unknownType.Output, StringComparison.Ordinal);

		var invalidToken = Run("--no-color", "--md", "0x7FFFFFFF", ContractsAssembly);
		Assert.Equal(1, invalidToken.ExitCode);
		Assert.Contains("ERROR: Invalid metadata token", invalidToken.Output, StringComparison.Ordinal);

		// SimpleTypeConverter's messages.
		var notANumber = Run("--no-color", "--md", "token", ContractsAssembly);
		Assert.Contains("ERROR: The value is not a hexadecimal or decimal integer", notANumber.Output, StringComparison.Ordinal);
		var tooBig = Run("--no-color", "--md", "0x80000000", ContractsAssembly);
		Assert.Contains("ERROR: Value must be between -2147483648 (-0x80000000) and 2147483647 (0x7FFFFFFF) inclusive", tooBig.Output, StringComparison.Ordinal);

		var unknownOption = Run("--no-color", "--no-such-option", ContractsAssembly);
		Assert.Contains("ERROR: Invalid option: --no-such-option", unknownOption.Output, StringComparison.Ordinal);
		// The IL options are not the C# language's.
		var ilOption = Run("--no-color", "--pdb-info", ContractsAssembly);
		Assert.Contains("ERROR: Invalid option: --pdb-info", ilOption.Output, StringComparison.Ordinal);
	}

	[Fact]
	public void ReportsAFileThatIsNotManaged() {
		var file = Path.Combine(TemporaryDirectory, "not-managed.txt");
		File.WriteAllText(file, "not an assembly");

		var result = Run("--no-color", "-t", "X", file);

		Assert.Equal(1, result.ExitCode);
		Assert.Contains("is not a .NET file", result.Output, StringComparison.Ordinal);
	}

	// ---------------------------------------------------------------- One type or member to stdout

	[Fact]
	public void DecompilesATypeToStdoutInCSharp() {
		var result = Run("--no-color", "-t", "dnSpy.Backend.Contracts.RpcException", ContractsAssembly);

		Assert.Equal(0, result.ExitCode);
		Assert.False(result.Output.Contains('\u001b', StringComparison.Ordinal));
		var lines = Lines(result.Output);
		// The type inside its namespace block, the usings it needs first, each member after its token comment.
		Assert.Equal("using System;", lines[0]);
		Assert.Contains("namespace dnSpy.Backend.Contracts", lines);
		Assert.Contains("\tpublic sealed class RpcException : Exception", lines);
		Assert.Matches(@"^\t// Token: 0x0200[0-9A-F]{4} RID: \d+$", lines[lines.IndexOf("\tpublic sealed class RpcException : Exception") - 1]);
		Assert.Matches(@"^\t\t// Token: 0x06[0-9A-F]{6} RID: \d+ RVA: 0x[0-9A-F]{8} File Offset: 0x[0-9A-F]{8}$", lines[lines.FindIndex(line => line.Contains("public RpcException(", StringComparison.Ordinal)) - 1]);
		Assert.Contains("\t\t// (get) Token: ", result.Output, StringComparison.Ordinal);
	}

	[Fact]
	public void MembersAreWrittenInTheForksDecompilationOrder() {
		// The fork's order is methods, properties, events, fields, nested types.
		var defaultOrder = Run("--no-color", "-t", "dnSpy.Backend.Contracts.RpcException", ContractsAssembly).Output;
		Assert.True(defaultOrder.IndexOf("public RpcException(", StringComparison.Ordinal) < defaultOrder.IndexOf("public int Code", StringComparison.Ordinal));

		// Out of source order, the kinds come in the order asked for.
		var propertiesFirst = Run("--no-color", "--member-order", "tfepm", "--no-src-order", "-t", "dnSpy.Backend.Contracts.RpcException", ContractsAssembly).Output;
		Assert.True(propertiesFirst.IndexOf("public int Code", StringComparison.Ordinal) < propertiesFirst.IndexOf("public RpcException(", StringComparison.Ordinal));

		// Fields come after the methods.
		var fields = Run("--no-color", "-t", "GlobalMembers", SearchTargetAssembly).Output;
		Assert.True(fields.IndexOf("GlobalFunction()", StringComparison.Ordinal) < fields.IndexOf("GlobalField = 999", StringComparison.Ordinal));
	}

	[Fact]
	public void AMemberStartsWithItsDeclaringTypeAndAConstructorShowsTheFieldsItInitializes() {
		var method = Run("--no-color", "--md", Token(RpcExceptionCtorToken), ContractsAssembly);
		Assert.Equal(0, method.ExitCode);
		var lines = Lines(method.Output);
		Assert.Equal("// dnSpy.Backend.Contracts.RpcException", lines[0]);
		Assert.StartsWith("// Token: 0x06", lines[1], StringComparison.Ordinal);
		// A member's document has no using declarations: its types are written with their namespaces.
		Assert.DoesNotContain("using System;", method.Output, StringComparison.Ordinal);
		Assert.Contains("System.Exception? innerException = null", method.Output, StringComparison.Ordinal);

		// SelectCtorTransform: the constructor with the fields whose initializers it runs, the others left out.
		var constructor = Run("--no-color", "--md", Token(ProjectExportTargetToken("ProjectExportTarget.MainForm", ".ctor")), ProjectExportTargetAssembly).Output;
		Assert.StartsWith("// ProjectExportTarget.MainForm" + Environment.NewLine, constructor, StringComparison.Ordinal);
		Assert.Contains("private System.ComponentModel.IContainer? components = null;", constructor, StringComparison.Ordinal);
		Assert.Contains("public MainForm()", constructor, StringComparison.Ordinal);
		Assert.DoesNotContain("InitializeComponent()\n\t{", constructor, StringComparison.Ordinal);

		// SelectFieldTransform: a static field with the initializer the static constructor runs.
		using var search = ModuleDefMD.Load(SearchTargetAssembly);
		var field = search.GetTypes().Single(type => type.Name == "GlobalMembers").Fields.Single(f => f.Name == "GlobalField");
		var fieldOutput = Lines(Run("--no-color", "--md", Token(unchecked((int)field.MDToken.Raw)), SearchTargetAssembly).Output);
		Assert.Equal("// SearchTarget.GlobalMembers", fieldOutput[0]);
		Assert.Equal("internal static int GlobalField = 999;", fieldOutput[2]);
		Assert.Equal(3, fieldOutput.Count(line => line.Length > 0));
	}

	[Fact]
	public void DecompilesAMethodToStdoutInIL() {
		var result = Run("--no-color", "-l", "IL", "--md", Token(RpcExceptionCtorToken), ContractsAssembly);

		Assert.Equal(0, result.ExitCode);
		Assert.Contains(".method public hidebysig specialname rtspecialname", result.Output, StringComparison.Ordinal);
		Assert.Contains("} // end of method RpcException::.ctor", result.Output, StringComparison.Ordinal);
		// dnSpy's IL view: the instruction bytes, the token comment, and the PDB's line and file (pdb-info, on by default).
		Assert.Matches(@"/\* 0x[0-9A-F]{8} 02 +\*/ IL_0000: ldarg\.0", result.Output);
		Assert.Matches(@"// Token: 0x06[0-9A-F]{6} RID: \d+ RVA: ", result.Output);
		Assert.Matches(@"/\* \(\d+,\d+\)-\(\d+,\d+\) .*Protocol\.cs \*/", result.Output);
		Assert.Contains("call      instance void [System.Runtime]System.Exception::.ctor(string, class [System.Runtime]System.Exception)", result.Output, StringComparison.Ordinal);
	}

	[Fact]
	public void IlOptionsAreAcceptedWithNoAndDontPrefixes() {
		var result = Run("--no-color", "-l", "IL", "--dont-tokens", "--no-bytes", "--no-pdb-info", "--md", Token(RpcExceptionCtorToken), ContractsAssembly);
		Assert.Equal(0, result.ExitCode);
		Assert.DoesNotContain("/*", result.Output, StringComparison.Ordinal);
		Assert.DoesNotContain("// Token:", result.Output, StringComparison.Ordinal);
		Assert.Contains("\tIL_0000: ldarg.0", result.Output, StringComparison.Ordinal);

		var comments = Run("--no-color", "-l", "IL", "--comments", "--md", Token(RpcExceptionCtorToken), ContractsAssembly);
		Assert.Contains("IL_0000: ldarg.0\t// Loads the argument at index 0 onto the evaluation stack.", comments.Output, StringComparison.Ordinal);

		var hex = Run("--no-color", "-l", "IL", "--no-bytes", "--hex", "-t", "SearchTarget.Library", SearchTargetAssembly);
		Assert.Contains("ldc.i4    0x7A69", hex.Output, StringComparison.Ordinal);
	}

	[Fact]
	public void DecompilesAClassAndAMemberToStdoutInVisualBasic() {
		var type = Run("--no-color", "-l", "Visual Basic", "-t", "dnSpy.Backend.Contracts.RpcException", ContractsAssembly);
		Assert.Equal(0, type.ExitCode);
		Assert.Contains("Namespace dnSpy.Backend.Contracts", type.Output, StringComparison.Ordinal);
		// Indented the way dnSpy's C# is, a tab a level.
		Assert.Contains("\n\tPublic NotInheritable Class RpcException", type.Output, StringComparison.Ordinal);
		Assert.Contains("\t\tInherits Exception", type.Output, StringComparison.Ordinal);
		Assert.Matches(@"\t\t' Token: 0x06[0-9A-F]{6} RID: \d+ RVA: ", type.Output);

		var member = Lines(Run("--no-color", "-l", "Visual Basic", "--md", Token(RpcExceptionCtorToken), ContractsAssembly).Output);
		Assert.Equal("' dnSpy.Backend.Contracts.RpcException", member[0]);
		Assert.Contains(member, line => line.StartsWith("Public Sub New(code As Integer, message As String", StringComparison.Ordinal));
	}

	[Fact]
	public void IlWithCSharpShowsTheSourceStatementBeforeItsInstructions() {
		var result = Run("--no-color", "-l", "IL with C#", "--md", Token(RpcExceptionCtorToken), ContractsAssembly);

		Assert.Equal(0, result.ExitCode);
		// The statement's whole line, as ILWithCSharpDecompiler writes it, above its first instruction.
		Assert.Matches(@"\t// \tDataValue = data;\r?\n\r?\n\t/\* \(", result.Output);
		Assert.Contains("stfld     object dnSpy.Backend.Contracts.RpcException::'<DataValue>k__BackingField'", result.Output, StringComparison.Ordinal);

		// A type's document interleaves the statements of every method it holds.
		var type = Run("--no-color", "-l", "IL with C#", "-t", "dnSpy.Backend.Contracts.RpcException", ContractsAssembly);
		Assert.Equal(0, type.ExitCode);
		Assert.Contains("DataValue = data;", type.Output, StringComparison.Ordinal);
		Assert.Contains("\t// \treturn ", type.Output, StringComparison.Ordinal);
	}

	[Fact]
	public void SpacesControlsTheIndentation() {
		var csharp = Run("--no-color", "--spaces", "2", "-t", "dnSpy.Backend.Contracts.RpcException", ContractsAssembly);
		Assert.Equal(0, csharp.ExitCode);
		Assert.Contains("\n    public int Code", csharp.Output, StringComparison.Ordinal);
		Assert.DoesNotContain("\t", csharp.Output, StringComparison.Ordinal);

		var il = Run("--no-color", "-l", "IL", "--spaces", "3", "--md", Token(RpcExceptionCtorToken), ContractsAssembly);
		Assert.Contains("\n   instance void .ctor (", il.Output, StringComparison.Ordinal);

		var visualBasic = Run("--no-color", "-l", "Visual Basic", "--spaces", "2", "-t", "dnSpy.Backend.Contracts.RpcException", ContractsAssembly);
		Assert.Contains("\n  Public NotInheritable Class RpcException", visualBasic.Output, StringComparison.Ordinal);

		var invalid = Run("--no-color", "--spaces", "101", ContractsAssembly);
		Assert.Contains("ERROR: Number of spaces must be between 0 and 100", invalid.Output, StringComparison.Ordinal);
	}

	[Fact]
	public void TheForksCSharpOptionsTakeEffect() {
		var noTokens = Run("--no-color", "--no-tokens", "-t", "SearchTarget.Library", SearchTargetAssembly).Output;
		Assert.DoesNotContain("// Token:", noTokens, StringComparison.Ordinal);

		var hex = Run("--no-color", "--hex", "-t", "SearchTarget.Library", SearchTargetAssembly).Output;
		Assert.Contains("public const int Answer = 0x1092;", hex, StringComparison.Ordinal);
		Assert.Contains("count * 0x7A69", hex, StringComparison.Ordinal);

		var truncated = Run("--no-color", "--max-string-length", "4", "-t", "SearchTarget.Library", SearchTargetAssembly).Output;
		Assert.Contains("return \"body[...string is too long...]\"", truncated, StringComparison.Ordinal);

		var noPrivate = Run("--no-color", "--no-private-modifier-member", "-t", "GlobalMembers", SearchTargetAssembly).Output;
		Assert.Contains("internal static class GlobalMembers", noPrivate, StringComparison.Ordinal);
		var noInternal = Run("--no-color", "--dont-internal-modifier-type", "-t", "GlobalMembers", SearchTargetAssembly).Output;
		Assert.Contains("\tstatic class GlobalMembers", noInternal, StringComparison.Ordinal);

		var fullNames = Run("--no-color", "--full-names", "-t", "dnSpy.Backend.Contracts.RpcException", ContractsAssembly).Output;
		Assert.Contains("public sealed class RpcException : System.Exception", fullNames, StringComparison.Ordinal);
		Assert.Contains("using System;", fullNames, StringComparison.Ordinal);

		var noUsings = Run("--no-color", "--no-using-decl", "-t", "dnSpy.Backend.Contracts.RpcException", ContractsAssembly).Output;
		Assert.DoesNotContain("using System;", noUsings, StringComparison.Ordinal);
		var fullNamesNoUsings = Run("--no-color", "--full-names", "--no-using-decl", "-t", "dnSpy.Backend.Contracts.RpcException", ContractsAssembly).Output;
		Assert.Contains("RpcException : System.Exception", fullNamesNoUsings, StringComparison.Ordinal);
		Assert.DoesNotContain("using System;", fullNamesNoUsings, StringComparison.Ordinal);
	}

	[Fact]
	public void NoGacStillDecompilesAModuleWhoseReferencesAreBesideIt() {
		var result = Run("--no-color", "--no-gac", "-t", "dnSpy.Backend.Contracts.RpcException", ContractsAssembly);
		Assert.Equal(0, result.ExitCode);
		Assert.Contains("class RpcException", result.Output, StringComparison.Ordinal);
	}

	[Fact]
	public void LanguageCanBeSelectedByGuid() {
		// The unique guid of IL, then the generic guid both IL languages share (the first of them is used).
		var unique = Run("--no-color", "-l", "A4F35508-691F-4BD0-B74D-D5D5D1D0E8E6", "-t", "dnSpy.Backend.Contracts.RpcException", ContractsAssembly);
		Assert.Equal(0, unique.ExitCode);
		Assert.Contains(".class public auto ansi sealed beforefieldinit dnSpy.Backend.Contracts.RpcException", unique.Output, StringComparison.Ordinal);
		var generic = Run("--no-color", "-l", "{9EF276FD-3293-42A4-B48A-1D6A69086B3D}", "-t", "dnSpy.Backend.Contracts.RpcException", ContractsAssembly);
		Assert.Equal(unique.Output, generic.Output);

		var missing = Run("--no-color", "-l", "Cobol", ContractsAssembly);
		Assert.Contains("ERROR: Language 'Cobol' doesn't exist", missing.Output, StringComparison.Ordinal);
	}

	// ---------------------------------------------------------------- Project export

	[Fact]
	public void ExportsAnSdkProjectAndSolution() {
		var output = Path.Combine(TemporaryDirectory, "export");
		var result = Run("--sdk-project", "--project-guid", "11111111-2222-3333-4444-555555555555", "-o", output, ContractsAssembly);

		Assert.Equal(0, result.ExitCode);
		var projectDirectory = Path.Combine(output, "dnSpy.Backend.Contracts");
		var project = Path.Combine(projectDirectory, "dnSpy.Backend.Contracts.csproj");
		Assert.True(File.Exists(project), $"The project was not written: {project}");
		var document = XDocument.Load(project);
		Assert.Equal("Microsoft.NET.Sdk", document.Root!.Attribute("Sdk")?.Value);
		Assert.Equal("{11111111-2222-3333-4444-555555555555}", Value(document, "ProjectGuid"));
		Assert.Equal("dnSpy.Backend.Contracts", Value(document, "RootNamespace"));
		Assert.Equal("False", Value(document, "GenerateAssemblyInfo"));
		Assert.Equal("False", Value(document, "EnableDefaultItems"));
		Assert.StartsWith("net", Value(document, "TargetFramework"), StringComparison.Ordinal);

		// FilenameCreator: the default namespace is taken off a type's path; the attributes go to Properties.
		Assert.True(File.Exists(Path.Combine(projectDirectory, "HelloRequest.cs")));
		Assert.True(File.Exists(Path.Combine(projectDirectory, "Properties", "AssemblyInfo.cs")));
		Assert.Contains(document.Descendants(), element => element.Name.LocalName == "Compile" && (string?)element.Attribute("Include") == "HelloRequest.cs");
		Assert.Contains(document.Descendants(), element => element.Name.LocalName == "Compile" && (string?)element.Attribute("Include") == @"Properties\AssemblyInfo.cs");

		// dnSpy writes the files UTF-8 with a byte order mark, the namespace as a block, the token comments in.
		var code = File.ReadAllBytes(Path.Combine(projectDirectory, "HelloRequest.cs"));
		Assert.Equal([0xEF, 0xBB, 0xBF], code[..3]);
		var text = File.ReadAllText(Path.Combine(projectDirectory, "HelloRequest.cs"));
		Assert.Contains("namespace dnSpy.Backend.Contracts" + Environment.NewLine + "{", text, StringComparison.Ordinal);
		Assert.Contains("// Token: 0x02", text, StringComparison.Ordinal);
		// AssemblyInfoTransform: what the compiler writes itself is left out.
		var assemblyInfo = File.ReadAllText(Path.Combine(projectDirectory, "Properties", "AssemblyInfo.cs"));
		Assert.Contains("[assembly: AssemblyVersion(", assemblyInfo, StringComparison.Ordinal);
		Assert.DoesNotContain("TargetFramework(", assemblyInfo, StringComparison.Ordinal);
		Assert.DoesNotContain("CompilationRelaxations", assemblyInfo, StringComparison.Ordinal);
		Assert.DoesNotContain("RuntimeCompatibility", assemblyInfo, StringComparison.Ordinal);
		Assert.DoesNotContain("Debuggable", assemblyInfo, StringComparison.Ordinal);

		var solution = File.ReadAllText(Path.Combine(output, "solution.sln"));
		Assert.Contains("Project(\"{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}\") = \"dnSpy.Backend.Contracts\", \"dnSpy.Backend.Contracts\\dnSpy.Backend.Contracts.csproj\", \"{11111111-2222-3333-4444-555555555555}\"", solution, StringComparison.Ordinal);
		Assert.Contains("# Visual Studio 2010", solution, StringComparison.Ordinal);
	}

	[Fact]
	public void ExportedCSharpProjectBuilds() {
		var output = Path.Combine(TemporaryDirectory, "buildable");
		var result = Run("--sdk-project", "-o", output, SearchTargetAssembly);
		Assert.Equal(0, result.ExitCode);

		var projectDirectory = Path.Combine(output, "SearchTarget");
		// The resources: a .resources file as a .resx, another resource as the file it is, named after its namespace.
		Assert.True(File.Exists(Path.Combine(projectDirectory, "Strings.resx")));
		Assert.True(File.Exists(Path.Combine(projectDirectory, "notes.txt")));
		Assert.True(File.Exists(Path.Combine(projectDirectory, "Inner", "Deep.cs")));
		AssertBuilds(Path.Combine(projectDirectory, "SearchTarget.csproj"));
	}

	[Fact]
	public void ExportedWpfProjectBuilds() {
		var output = Path.Combine(TemporaryDirectory, "wpf-buildable");
		var result = Run("--sdk-project", "-o", output, BamlTargetAssembly);
		Assert.Equal(0, result.ExitCode);

		var project = XDocument.Load(Path.Combine(output, "BamlTarget", "BamlTarget.csproj"));
		Assert.Equal("Microsoft.NET.Sdk.WindowsDesktop", project.Root!.Attribute("Sdk")?.Value);
		Assert.Equal("True", Value(project, "UseWPF"));
		// A Windows desktop project needs the Windows targeting pack when it is built on Linux.
		AssertBuilds(Path.Combine(output, "BamlTarget", "BamlTarget.csproj"), "-p:EnableWindowsTargeting=true");
	}

	[Fact]
	public void DecompilesBamlToXaml() {
		var output = Path.Combine(TemporaryDirectory, "baml");
		var result = Run("--sdk-project", "-o", output, BamlTargetAssembly);
		Assert.Equal(0, result.ExitCode);

		var projectDirectory = Path.Combine(output, "BamlTarget");
		var xaml = Path.Combine(projectDirectory, "SampleView.xaml");
		Assert.True(File.Exists(xaml), $"The XAML was not written: {xaml}");
		Assert.Contains("<UserControl", File.ReadAllText(xaml), StringComparison.Ordinal);
		// XamlTypeProjectFile: the code-behind is partial, without the members the XAML build writes again.
		var codeBehind = File.ReadAllText(Path.Combine(projectDirectory, "SampleView.xaml.cs"));
		Assert.Contains("public partial class SampleView : UserControl", codeBehind, StringComparison.Ordinal);
		Assert.DoesNotContain("void InitializeComponent()", codeBehind, StringComparison.Ordinal);
		Assert.DoesNotContain("IComponentConnector", codeBehind, StringComparison.Ordinal);

		var project = XDocument.Load(Path.Combine(projectDirectory, "BamlTarget.csproj"));
		var page = Assert.Single(project.Descendants(), element => element.Name.LocalName == "Page");
		Assert.Equal("SampleView.xaml", (string?)page.Attribute("Include"));
		Assert.Equal("Designer", page.Elements().Single(element => element.Name.LocalName == "SubType").Value);
		Assert.Equal("MSBuild:Compile", page.Elements().Single(element => element.Name.LocalName == "Generator").Value);
		var compile = project.Descendants().Single(element => element.Name.LocalName == "Compile" && (string?)element.Attribute("Include") == "SampleView.xaml.cs");
		Assert.Equal("SampleView.xaml", compile.Elements().Single(element => element.Name.LocalName == "DependentUpon").Value);
	}

	[Fact]
	public void NoBamlKeepsTheCompiledBaml() {
		var output = Path.Combine(TemporaryDirectory, "no-baml");
		var result = Run("--sdk-project", "--no-baml", "-o", output, BamlTargetAssembly);
		Assert.Equal(0, result.ExitCode);

		Assert.True(File.Exists(Path.Combine(output, "BamlTarget", "sampleview.baml")));
		Assert.False(Directory.EnumerateFiles(output, "*.xaml", SearchOption.AllDirectories).Any());
		var project = File.ReadAllText(Path.Combine(output, "BamlTarget", "BamlTarget.csproj"));
		Assert.Contains("<Resource Include=\"sampleview.baml\" />", project, StringComparison.Ordinal);
	}

	[Fact]
	public void NoResourcesKeepsTheResourceContainer() {
		var output = Path.Combine(TemporaryDirectory, "no-resources");
		var result = Run("--sdk-project", "--no-resources", "-o", output, BamlTargetAssembly);
		Assert.Equal(0, result.ExitCode);

		// ResourceNameCreator: BamlTarget.g.resources in the directory of its namespace — the project's own.
		Assert.True(File.Exists(Path.Combine(output, "BamlTarget", "g.resources")));
		Assert.False(Directory.EnumerateFiles(output, "*.xaml", SearchOption.AllDirectories).Any());
		var project = File.ReadAllText(Path.Combine(output, "BamlTarget", "BamlTarget.csproj"));
		Assert.Contains("<EmbeddedResource Include=\"g.resources\" />", project, StringComparison.Ordinal);
	}

	[Fact]
	public void NoResXKeepsTheResourcesFile() {
		var output = Path.Combine(TemporaryDirectory, "no-resx");
		var result = Run("--sdk-project", "--no-resx", "-o", output, SearchTargetAssembly);
		Assert.Equal(0, result.ExitCode);

		Assert.True(File.Exists(Path.Combine(output, "SearchTarget", "Strings.resources")));
		Assert.False(File.Exists(Path.Combine(output, "SearchTarget", "Strings.resx")));
	}

	[Fact]
	public void ProjectReferencesReplaceReferencesToModulesBeingExported() {
		var output = Path.Combine(TemporaryDirectory, "references");
		var result = Run("--sdk-project", "--project-guid", "22222222-2222-3333-4444-555555555555", "-o", output, typeof(AnalyzerTarget.Shape).Assembly.Location, ConsumerAssembly);
		Assert.Equal(0, result.ExitCode);

		var project = XDocument.Load(Path.Combine(output, "AnalyzerTarget.Consumer", "AnalyzerTarget.Consumer.csproj"));
		var reference = Assert.Single(project.Descendants(), element => element.Name.LocalName == "ProjectReference");
		Assert.Equal(@"..\AnalyzerTarget\AnalyzerTarget.csproj", (string?)reference.Attribute("Include"));
		// The guids count on from the one given, in path order: AnalyzerTarget.Consumer.dll comes first.
		Assert.Equal("{22222222-2222-3333-4444-555555555556}", reference.Elements().Single(element => element.Name.LocalName == "Project").Value);
		Assert.Equal("AnalyzerTarget", reference.Elements().Single(element => element.Name.LocalName == "Name").Value);
		Assert.DoesNotContain(project.Descendants(), element => element.Name.LocalName == "Reference" && (string?)element.Attribute("Include") == "AnalyzerTarget");
	}

	[Fact]
	public void NoSlnLeavesTheSolutionOut() {
		var output = Path.Combine(TemporaryDirectory, "no-sln");
		var result = Run("--sdk-project", "--no-sln", "-o", output, SearchTargetAssembly);
		Assert.Equal(0, result.ExitCode);
		Assert.False(File.Exists(Path.Combine(output, "solution.sln")));
	}

	[Fact]
	public void SlnNameAndVsVersionAreUsed() {
		var sln = Path.Combine(TemporaryDirectory, "named-sln");
		Assert.Equal(0, Run("--sdk-project", "--sln-name", "custom.sln", "--vs", "2022", "-o", sln, SearchTargetAssembly).ExitCode);
		var text = File.ReadAllText(Path.Combine(sln, "custom.sln"));
		Assert.Contains("# Visual Studio Version 17" + "\r\n" + "VisualStudioVersion = 17.0.31903.59", text, StringComparison.Ordinal);

		var slnx = Path.Combine(TemporaryDirectory, "named-slnx");
		Assert.Equal(0, Run("--sdk-project", "--sln-name", "custom.slnx", "-o", slnx, SearchTargetAssembly).ExitCode);
		var document = XDocument.Load(Path.Combine(slnx, "custom.slnx"));
		Assert.Equal("Solution", document.Root!.Name.LocalName);
		Assert.Equal("SearchTarget/SearchTarget.csproj", (string?)Assert.Single(document.Root.Elements()).Attribute("Path"));

		var invalid = Run("--sln-name", "/rooted.sln", "-o", slnx, SearchTargetAssembly);
		Assert.Contains("ERROR: .sln name (/rooted.sln) must be relative to project directory", invalid.Output, StringComparison.Ordinal);
		var invalidVersion = Run("--vs", "2003", "-o", slnx, SearchTargetAssembly);
		Assert.Contains("ERROR: Invalid Visual Studio version: 2003", invalidVersion.Output, StringComparison.Ordinal);
	}

	[Fact]
	public void LegacyProjectUsesTheSelectedVisualStudioVersionAndProjectGuid() {
		var output = Path.Combine(TemporaryDirectory, "legacy");
		var result = Run("--vs", "2015", "--project-guid", "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", "-o", output, SearchTargetAssembly);
		Assert.Equal(0, result.ExitCode);

		var project = XDocument.Load(Path.Combine(output, "SearchTarget", "SearchTarget.csproj"));
		Assert.Equal("14.0", project.Root!.Attribute("ToolsVersion")?.Value);
		Assert.Equal("Build", project.Root.Attribute("DefaultTargets")?.Value);
		Assert.Equal("{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}", Value(project, "ProjectGuid"));
		Assert.Equal("Properties", Value(project, "AppDesignerFolder"));
		Assert.Equal("v10.0", Value(project, "TargetFrameworkVersion"));
		Assert.Equal(".NETCoreApp", Value(project, "TargetFrameworkIdentifier"));
		Assert.Contains(project.Descendants(), element => element.Name.LocalName == "AppDesigner" && (string?)element.Attribute("Include") == @"Properties\");
		Assert.Contains(project.Descendants(), element => element.Name.LocalName == "Import" && (string?)element.Attribute("Project") == @"$(MSBuildToolsPath)\Microsoft.CSharp.targets");
		Assert.Equal(2, project.Descendants().Count(element => element.Name.LocalName == "PlatformTarget" && element.Value == "AnyCPU"));

		// --no-stdlib: NoStdLib in both configurations.
		var noStdLib = Path.Combine(TemporaryDirectory, "no-stdlib");
		Assert.Equal(0, Run("--no-stdlib", "-o", noStdLib, SearchTargetAssembly).ExitCode);
		Assert.Equal(2, XDocument.Load(Path.Combine(noStdLib, "SearchTarget", "SearchTarget.csproj")).Descendants().Count(element => element.Name.LocalName == "NoStdLib"));
	}

	[Fact]
	public void ExportsAWinFormsApplicationTheWayVisualStudioLaysItOut() {
		var output = Path.Combine(TemporaryDirectory, "winforms");
		var result = Run("--sdk-project", "--threads", "1", "-o", output, ProjectExportTargetAssembly);
		Assert.Equal(0, result.ExitCode);
		var directory = Path.Combine(output, "ProjectExportTarget");
		var project = XDocument.Load(Path.Combine(directory, "ProjectExportTarget.csproj"));
		Assert.Equal("WinExe", Value(project, "OutputType"));
		Assert.Equal("True", Value(project, "UseWindowsForms"));
		Assert.Equal("True", Value(project, "AllowUnsafeBlocks"));
		Assert.Equal("ProjectExportTarget.Program", Value(project, "StartupObject"));

		// WinFormsProjectFile: the form, and its Designer file with InitializeComponent, Dispose and their fields.
		var form = File.ReadAllText(Path.Combine(directory, "MainForm.cs"));
		var designer = File.ReadAllText(Path.Combine(directory, "MainForm.Designer.cs"));
		Assert.Contains("public partial class MainForm : Form", form, StringComparison.Ordinal);
		Assert.Contains("private void Button1_Click(", form, StringComparison.Ordinal);
		Assert.DoesNotContain("InitializeComponent()\r", form.Replace(Environment.NewLine, "\r", StringComparison.Ordinal), StringComparison.Ordinal);
		Assert.DoesNotContain("button1", form, StringComparison.Ordinal);
		Assert.Contains("public partial class MainForm : System.Windows.Forms.Form", designer, StringComparison.Ordinal);
		Assert.Contains("private void InitializeComponent()", designer, StringComparison.Ordinal);
		Assert.Contains("protected override void Dispose(bool disposing)", designer, StringComparison.Ordinal);
		// Without using declarations: every type with its namespace, the handler's delegate kept.
		Assert.Contains("this.button1.Click += new System.EventHandler(this.Button1_Click);", designer, StringComparison.Ordinal);
		Assert.Contains("private System.Windows.Forms.Button button1", designer, StringComparison.Ordinal);
		Assert.DoesNotContain("using ", designer, StringComparison.Ordinal);
		Assert.Equal("Form", Item(project, "Compile", "MainForm.cs").Element(project.Root!.Name.Namespace + "SubType")?.Value);
		Assert.Equal("MainForm.cs", Item(project, "Compile", "MainForm.Designer.cs").Elements().Single(element => element.Name.LocalName == "DependentUpon").Value);
		Assert.Equal("MainForm.cs", Item(project, "EmbeddedResource", "MainForm.resx").Elements().Single(element => element.Name.LocalName == "DependentUpon").Value);

		// The strongly typed resource class: Strings.Designer.cs, generated from Strings.resx.
		var stringsDesigner = Item(project, "Compile", "Strings.Designer.cs");
		Assert.Equal(["Strings.resx", "True", "True"], stringsDesigner.Elements().Select(element => element.Value));
		var strings = Item(project, "EmbeddedResource", "Strings.resx");
		Assert.Equal(["ResXFileCodeGenerator", "Strings.Designer.cs"], strings.Elements().Select(element => element.Value));
		// The German satellite assembly's resources beside it.
		var german = File.ReadAllText(Path.Combine(directory, "Strings.de.resx"));
		Assert.Contains("<value>Hallo</value>", german, StringComparison.Ordinal);
		Item(project, "EmbeddedResource", "Strings.de.resx");
		var neutral = File.ReadAllText(Path.Combine(directory, "Strings.resx"));
		Assert.Contains("<resheader name=\"reader\">", neutral, StringComparison.Ordinal);
		Assert.Contains("System.Resources.ResXResourceReader, System.Windows.Forms, Version=", neutral, StringComparison.Ordinal);
		Assert.Contains("<data name=\"Greeting\" xml:space=\"preserve\">", neutral, StringComparison.Ordinal);

		// The settings class: Settings.settings, and the Designer file the generator writes from it.
		var settings = XDocument.Load(Path.Combine(directory, "Properties", "Settings.settings"));
		var setting = Assert.Single(settings.Descendants(), element => element.Name.LocalName == "Setting");
		Assert.Equal("Greeting", (string?)setting.Attribute("Name"));
		Assert.Equal("System.String", (string?)setting.Attribute("Type"));
		Assert.Equal("User", (string?)setting.Attribute("Scope"));
		Assert.Equal("Hello", setting.Elements().Single().Value);
		Assert.Equal("SettingsSingleFileGenerator", Item(project, "None", @"Properties\Settings.settings").Elements().First().Value);
		Assert.Contains("internal sealed partial class Settings : ApplicationSettingsBase", File.ReadAllText(Path.Combine(directory, "Properties", "Settings.Designer.cs")), StringComparison.Ordinal);
		// Nothing of the class is left for its own file, which is then not written.
		Assert.False(File.Exists(Path.Combine(directory, "Properties", "Settings.cs")));

		// The Win32 icon and manifest, and app.config.
		Assert.Equal("ProjectExportTarget.ico", Value(project, "ApplicationIcon"));
		Assert.Equal("app.manifest", Value(project, "ApplicationManifest"));
		Assert.True(new FileInfo(Path.Combine(directory, "ProjectExportTarget.ico")).Length > 22);
		Assert.Contains("ProjectExportTarget.app", File.ReadAllText(Path.Combine(directory, "app.manifest")), StringComparison.Ordinal);
		Assert.Contains("app-config-needle", File.ReadAllText(Path.Combine(directory, "app.config")), StringComparison.Ordinal);
		Item(project, "None", "app.config");
		Item(project, "None", "app.manifest");

		AssertBuilds(Path.Combine(directory, "ProjectExportTarget.csproj"), "-p:EnableWindowsTargeting=true");
	}

	[Fact]
	public void ExportsAVisualBasicProject() {
		var output = Path.Combine(TemporaryDirectory, "visual-basic");
		var result = Run("--sdk-project", "-l", "Visual Basic", "-o", output, SearchTargetAssembly);
		Assert.Equal(0, result.ExitCode);

		var directory = Path.Combine(output, "SearchTarget");
		var project = XDocument.Load(Path.Combine(directory, "SearchTarget.vbproj"));
		Assert.Equal("SearchTarget", Value(project, "RootNamespace"));
		Assert.Equal("41999,42016,42017,42018,42019,42020,42021,42022,42032,42036,42314", Value(project, "NoWarn"));
		Assert.True(File.Exists(Path.Combine(directory, "My Project", "AssemblyInfo.vb")));
		Assert.Contains("<Assembly: AssemblyVersion(\"1.0.0.0\")>", File.ReadAllText(Path.Combine(directory, "My Project", "AssemblyInfo.vb")), StringComparison.Ordinal);
		Assert.Empty(Directory.EnumerateFiles(directory, "*.cs", SearchOption.AllDirectories));
		// The project's root namespace is every file's; its types keep their names from the global one.
		var library = File.ReadAllText(Path.Combine(directory, "Library.vb"));
		Assert.Contains("Namespace Global.SearchTarget", library, StringComparison.Ordinal);
		Assert.Contains("\tPublic Class Library", library, StringComparison.Ordinal);
		Assert.Contains("Project(\"{F184B08F-C81C-45F6-A57F-5ABD9991F28F}\")", File.ReadAllText(Path.Combine(output, "solution.sln")), StringComparison.Ordinal);

		AssertBuilds(Path.Combine(directory, "SearchTarget.vbproj"));

		// A legacy Visual Basic project: My Project, the VB targets, no AppDesignerFolder.
		var legacy = Path.Combine(TemporaryDirectory, "visual-basic-legacy");
		Assert.Equal(0, Run("-l", "Visual Basic", "-o", legacy, ProjectExportTargetAssembly).ExitCode);
		var legacyProject = XDocument.Load(Path.Combine(legacy, "ProjectExportTarget", "ProjectExportTarget.vbproj"));
		Assert.Contains(legacyProject.Descendants(), element => element.Name.LocalName == "AppDesigner" && (string?)element.Attribute("Include") == @"My Project\");
		Assert.Contains(legacyProject.Descendants(), element => element.Name.LocalName == "Import" && (string?)element.Attribute("Project") == @"$(MSBuildToolsPath)\Microsoft.VisualBasic.targets");
		Assert.DoesNotContain(legacyProject.Descendants(), element => element.Name.LocalName == "AppDesignerFolder");
		Assert.True(File.Exists(Path.Combine(legacy, "ProjectExportTarget", "MainForm.Designer.vb")));
		Assert.True(File.Exists(Path.Combine(legacy, "ProjectExportTarget", "My Project", "AssemblyInfo.vb")));
	}

	[Fact]
	public void IlCannotBeExported() {
		var result = Run("-l", "IL", "-o", Path.Combine(TemporaryDirectory, "il"), SearchTargetAssembly);
		Assert.Equal(1, result.ExitCode);
		Assert.Contains("ERROR: Language IL doesn't support creating project files", result.Output, StringComparison.Ordinal);
	}

	[Fact]
	public void WildcardFindsTheAssembliesInADirectory() {
		var input = Path.Combine(TemporaryDirectory, "input");
		Directory.CreateDirectory(input);
		File.Copy(typeof(AnalyzerTarget.Shape).Assembly.Location, Path.Combine(input, "AnalyzerTarget.dll"));
		File.Copy(SearchTargetAssembly, Path.Combine(input, "SearchTarget.dll"));
		File.WriteAllText(Path.Combine(input, "ignored.txt"), "not managed");
		var output = Path.Combine(TemporaryDirectory, "wildcard");
		var result = Run("--sdk-project", "-o", output, Path.Combine(input, "*.dll"));

		Assert.Equal(0, result.ExitCode);
		Assert.True(Directory.Exists(Path.Combine(output, "AnalyzerTarget")));
		Assert.True(Directory.Exists(Path.Combine(output, "SearchTarget")));
	}

	// ---------------------------------------------------------------- Helpers

	static List<string> OptionNames(string section) =>
		[.. Regex.Matches(section, @"^    --(?<name>[a-z-]+)\t", RegexOptions.Multiline).Select(match => match.Groups["name"].Value)];

	static string Section(string text, string start, string end) {
		var startIndex = text.IndexOf(start, StringComparison.Ordinal);
		Assert.True(startIndex >= 0, $"'{start}' is not in the help.");
		startIndex += start.Length;
		var endIndex = text.IndexOf(end, startIndex, StringComparison.Ordinal);
		return text[startIndex..endIndex];
	}

	static List<string> Lines(string text) => [.. text.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n')];

	static string Value(XDocument project, string name) =>
		project.Descendants().First(element => element.Name.LocalName == name).Value;

	static XElement Item(XDocument project, string itemType, string include) =>
		project.Descendants().Single(element => element.Name.LocalName == itemType && (string?)element.Attribute("Include") == include);

	static void AssertBuilds(string project, params string[] arguments) {
		var startInfo = new System.Diagnostics.ProcessStartInfo {
			FileName = "dotnet",
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			UseShellExecute = false,
		};
		startInfo.ArgumentList.Add("build");
		startInfo.ArgumentList.Add(project);
		startInfo.ArgumentList.Add("-p:NuGetAudit=false");
		startInfo.ArgumentList.Add("-v:q");
		startInfo.ArgumentList.Add("-nologo");
		foreach (var argument in arguments)
			startInfo.ArgumentList.Add(argument);
		var build = System.Diagnostics.Process.Start(startInfo)!;
		var stdout = build.StandardOutput.ReadToEnd();
		var stderr = build.StandardError.ReadToEnd();
		build.WaitForExit();
		Assert.True(build.ExitCode == 0, $"The exported project did not build:\n{stdout}\n{stderr}");
	}

	static int RpcExceptionCtorToken {
		get {
			using var module = ModuleDefMD.Load(typeof(RpcException).Assembly.Location);
			var type = module.GetTypes().Single(type => type.Name == "RpcException");
			var ctor = type.Methods.First(method => method.IsConstructor && method.Parameters.Count > 0);
			return unchecked((int)ctor.MDToken.Raw);
		}
	}

	static int ProjectExportTargetToken(string typeName, string methodName) {
		using var module = ModuleDefMD.Load(ProjectExportTargetAssembly);
		var type = module.GetTypes().Single(type => type.FullName == typeName);
		return unchecked((int)type.Methods.First(method => method.Name == methodName).MDToken.Raw);
	}

	static string Token(int token) => "0x" + token.ToString("X8", System.Globalization.CultureInfo.InvariantCulture);

	static string ContractsAssembly => typeof(HelloRequest).Assembly.Location;
	static string SearchTargetAssembly => typeof(SearchTarget.Library).Assembly.Location;
	static string ConsumerAssembly => Path.Combine(AppContext.BaseDirectory, "AnalyzerTarget.Consumer.dll");

	static string BamlTargetAssembly => WindowsFixture("BamlTarget");
	static string ProjectExportTargetAssembly => WindowsFixture("ProjectExportTarget");

	static string WindowsFixture(string name) => Path.GetFullPath(Path.Combine(
		AppContext.BaseDirectory, "..", "..", "..", "..", name, "bin", TestConfiguration, "net10.0-windows", name + ".dll"));

	static string TestConfiguration => new DirectoryInfo(AppContext.BaseDirectory).Parent?.Name
		?? throw new InvalidOperationException("The test output directory has no configuration directory.");

	static (int ExitCode, string Output, string Error) Run(params string[] args) {
		var output = new StringWriter();
		var error = new StringWriter();
		var exitCode = new DnSpyConsole(output, error, colorizeDefault: false).Run(args);
		return (exitCode, output.ToString(), error.ToString());
	}
}
