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

	[Fact]
	public void NoArgumentsPrintTheHelpAndTheMissingOptionsError() {
		var result = Run();

		Assert.Equal(1, result.ExitCode);
		Assert.Contains("[options] [fileOrDir1]", result.Output, StringComparison.Ordinal);
		Assert.Contains("Languages:", result.Output, StringComparison.Ordinal);
		Assert.Contains("Language options:", result.Output, StringComparison.Ordinal);
		Assert.Contains("C# (", result.Output, StringComparison.Ordinal);
		Assert.Contains("--xml-doc", result.Output, StringComparison.Ordinal);
		Assert.Contains("Examples:", result.Output, StringComparison.Ordinal);
		Assert.Contains("ERROR: No options specified", result.Output, StringComparison.Ordinal);
	}

	[Fact]
	public void DecompilesATypeToStdoutInCSharp() {
		var result = Run("--no-color", "-t", "dnSpy.Backend.Contracts.HelloRequest", ContractsAssembly);

		Assert.Equal(0, result.ExitCode);
		Assert.Contains("record HelloRequest", result.Output, StringComparison.Ordinal);
		Assert.False(result.Output.Contains('\u001b', StringComparison.Ordinal));
	}

	[Fact]
	public void DecompilesAMethodToStdoutInIL() {
		var result = Run("--no-color", "-l", "IL", "--md", Token(RpcExceptionCtorToken), ContractsAssembly);

		Assert.Equal(0, result.ExitCode);
		Assert.Contains(".method", result.Output, StringComparison.Ordinal);
		Assert.Contains("IL_0000:", result.Output, StringComparison.Ordinal);
		Assert.Contains("System.Exception::.ctor", result.Output, StringComparison.Ordinal);
		// The PDB beside the fixture supplies the IL view's line numbers (--pdb-info, on by default).
		Assert.Contains("// sequence point:", result.Output, StringComparison.Ordinal);
	}

	[Fact]
	public void DecompilesAClassToStdoutInVisualBasic() {
		var result = Run("--no-color", "-l", "Visual Basic", "-t", "dnSpy.Backend.Contracts.RpcException", ContractsAssembly);

		Assert.Equal(0, result.ExitCode);
		Assert.Contains("Class RpcException", result.Output, StringComparison.Ordinal);
		Assert.Contains("Inherits Exception", result.Output, StringComparison.Ordinal);
	}

	[Fact]
	public void IlWithCSharpShowsTheSourceStatementBeforeItsInstructions() {
		var result = Run("--no-color", "-l", "IL with C#", "--md", Token(RpcExceptionCtorToken), ContractsAssembly);

		Assert.Equal(0, result.ExitCode);
		Assert.Contains("// DataValue = data;", result.Output, StringComparison.Ordinal);
		Assert.Contains("stfld object dnSpy.Backend.Contracts.RpcException", result.Output, StringComparison.Ordinal);

		// A type's document interleaves the statements of every method it holds.
		var type = Run("--no-color", "-l", "IL with C#", "-t", "dnSpy.Backend.Contracts.RpcException", ContractsAssembly);
		Assert.Equal(0, type.ExitCode);
		Assert.Contains("// DataValue = data;", type.Output, StringComparison.Ordinal);
		Assert.Contains("// return ", type.Output, StringComparison.Ordinal);
	}

	[Fact]
	public void SpacesControlsTheIndentation() {
		var result = Run("--no-color", "--spaces", "2", "-t", "dnSpy.Backend.Contracts.RpcException", ContractsAssembly);

		Assert.Equal(0, result.ExitCode);
		Assert.Contains("\n  public int Code", result.Output, StringComparison.Ordinal);
		Assert.DoesNotContain("\n\tpublic int Code", result.Output, StringComparison.Ordinal);
	}

	[Fact]
	public void ReportsAnUnknownTypeAndAnInvalidToken() {
		var unknownType = Run("--no-color", "-t", "NoSuchType", ContractsAssembly);
		Assert.Equal(1, unknownType.ExitCode);
		Assert.Contains("ERROR: Type NoSuchType couldn't be found", unknownType.Output, StringComparison.Ordinal);

		var invalidToken = Run("--no-color", "--md", "0x7FFFFFFF", ContractsAssembly);
		Assert.Equal(1, invalidToken.ExitCode);
		Assert.Contains("ERROR: Invalid metadata token", invalidToken.Output, StringComparison.Ordinal);
	}

	[Fact]
	public void ReportsAFileThatIsNotManaged() {
		var file = Path.Combine(TemporaryDirectory, "not-managed.txt");
		File.WriteAllText(file, "not an assembly");

		var result = Run("--no-color", "-t", "X", file);

		Assert.Equal(1, result.ExitCode);
		Assert.Contains("is not a .NET file", result.Output, StringComparison.Ordinal);
	}

	[Fact]
	public void ExportsAnSdkProjectAndSolution() {
		var output = Path.Combine(TemporaryDirectory, "export");
		var result = Run("--sdk-project", "--project-guid", "11111111-2222-3333-4444-555555555555", "-o", output, ContractsAssembly);

		Assert.Equal(0, result.ExitCode);
		var project = Path.Combine(output, "dnSpy.Backend.Contracts", "dnSpy.Backend.Contracts.csproj");
		Assert.True(File.Exists(project), $"The project was not written: {project}");
		var document = XDocument.Load(project);
		Assert.Equal("Project", document.Root!.Name.LocalName);
		Assert.Contains(document.Descendants(), element => element.Name.LocalName == "ProjectGuid" && element.Value == "{11111111-2222-3333-4444-555555555555}");
		Assert.Contains(document.Descendants(), element => element.Name.LocalName == "TargetFramework" && element.Value.StartsWith("net", StringComparison.Ordinal));

		var solution = File.ReadAllText(Path.Combine(output, "solution.sln"));
		Assert.Contains("{11111111-2222-3333-4444-555555555555}", solution, StringComparison.Ordinal);
		Assert.Contains("Microsoft Visual Studio Solution File", solution, StringComparison.Ordinal);
		Assert.True(File.Exists(Path.Combine(output, "dnSpy.Backend.Contracts", "dnSpy.Backend.Contracts", "HelloRequest.cs"))
			|| Directory.EnumerateFiles(Path.Combine(output, "dnSpy.Backend.Contracts"), "HelloRequest.cs", SearchOption.AllDirectories).Any());
	}

	[Fact]
	public void ExportedCSharpProjectBuilds() {
		var output = Path.Combine(TemporaryDirectory, "buildable");
		var result = Run("--sdk-project", "-o", output, typeof(SearchTarget.Library).Assembly.Location);
		Assert.Equal(0, result.ExitCode);

		AssertBuilds(Path.Combine(output, "SearchTarget", "SearchTarget.csproj"));
	}

	[Fact]
	public void ExportedWpfProjectBuilds() {
		var output = Path.Combine(TemporaryDirectory, "wpf-buildable");
		var result = Run("--sdk-project", "-o", output, BamlTargetAssembly);
		Assert.Equal(0, result.ExitCode);

		// A Windows desktop project needs the Windows targeting pack when it is built on Linux.
		AssertBuilds(Path.Combine(output, "BamlTarget", "BamlTarget.csproj"), "-p:EnableWindowsTargeting=true");
	}

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

	[Fact]
	public void ProjectReferencesReplaceReferencesToModulesBeingExported() {
		var output = Path.Combine(TemporaryDirectory, "references");
		var result = Run("--sdk-project", "-o", output, typeof(AnalyzerTarget.Shape).Assembly.Location, ConsumerAssembly);
		Assert.Equal(0, result.ExitCode);

		var project = Path.Combine(output, "AnalyzerTarget.Consumer", "AnalyzerTarget.Consumer.csproj");
		var text = File.ReadAllText(project);
		Assert.Contains("ProjectReference", text, StringComparison.Ordinal);
		Assert.Contains("AnalyzerTarget.csproj", text, StringComparison.Ordinal);
		Assert.DoesNotContain("<Reference Include=\"AnalyzerTarget\"", text, StringComparison.Ordinal);
	}

	[Fact]
	public void NoSlnLeavesTheSolutionOut() {
		var output = Path.Combine(TemporaryDirectory, "no-sln");
		var result = Run("--sdk-project", "--no-sln", "-o", output, typeof(SearchTarget.Library).Assembly.Location);
		Assert.Equal(0, result.ExitCode);
		Assert.False(File.Exists(Path.Combine(output, "solution.sln")));
	}

	[Fact]
	public void SlnNameAndVsVersionAreUsed() {
		var output = Path.Combine(TemporaryDirectory, "named-sln");
		var result = Run("--sdk-project", "--sln-name", "custom.slnx", "--vs", "2022", "-o", output, typeof(SearchTarget.Library).Assembly.Location);
		Assert.Equal(0, result.ExitCode);
		var solution = Path.Combine(output, "custom.slnx");
		Assert.True(File.Exists(solution), "The .slnx solution was not written.");
		var document = XDocument.Load(solution);
		Assert.Equal("Solution", document.Root!.Name.LocalName);
		Assert.Contains(document.Descendants(), element => element.Name.LocalName == "Project");
	}

	[Fact]
	public void DecompilesBamlToXaml() {
		var output = Path.Combine(TemporaryDirectory, "baml");
		var result = Run("--sdk-project", "-o", output, BamlTargetAssembly);
		Assert.Equal(0, result.ExitCode);

		var xaml = Path.Combine(output, "BamlTarget", "BamlTarget", "SampleView.xaml");
		Assert.True(File.Exists(xaml), $"The XAML was not written: {xaml}");
		Assert.Contains("<UserControl", File.ReadAllText(xaml), StringComparison.Ordinal);
		var project = File.ReadAllText(Path.Combine(output, "BamlTarget", "BamlTarget.csproj"));
		Assert.Contains("<Page", project, StringComparison.Ordinal);
	}

	[Fact]
	public void NoBamlKeepsTheCompiledBaml() {
		var output = Path.Combine(TemporaryDirectory, "no-baml");
		var result = Run("--sdk-project", "--no-baml", "-o", output, BamlTargetAssembly);
		Assert.Equal(0, result.ExitCode);

		Assert.True(File.Exists(Path.Combine(output, "BamlTarget", "sampleview.baml")));
		Assert.False(Directory.EnumerateFiles(output, "*.xaml", SearchOption.AllDirectories).Any());
		var project = File.ReadAllText(Path.Combine(output, "BamlTarget", "BamlTarget.csproj"));
		Assert.Contains("<Resource", project, StringComparison.Ordinal);
	}

	[Fact]
	public void NoResourcesKeepsTheResourceContainer() {
		var output = Path.Combine(TemporaryDirectory, "no-resources");
		var result = Run("--sdk-project", "--no-resources", "-o", output, BamlTargetAssembly);
		Assert.Equal(0, result.ExitCode);

		Assert.True(File.Exists(Path.Combine(output, "BamlTarget", "BamlTarget.g.resources")));
		Assert.False(Directory.EnumerateFiles(output, "*.xaml", SearchOption.AllDirectories).Any());
		var project = File.ReadAllText(Path.Combine(output, "BamlTarget", "BamlTarget.csproj"));
		Assert.Contains("BamlTarget.g.resources", project, StringComparison.Ordinal);
		Assert.Contains("LogicalName", project, StringComparison.Ordinal);
	}

	[Fact]
	public void LegacyProjectUsesTheSelectedVisualStudioVersionAndProjectGuid() {
		var output = Path.Combine(TemporaryDirectory, "legacy");
		var result = Run("--vs", "2015", "--project-guid", "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", "-o", output, typeof(SearchTarget.Library).Assembly.Location);
		Assert.Equal(0, result.ExitCode);

		var project = XDocument.Load(Path.Combine(output, "SearchTarget", "SearchTarget.csproj"));
		Assert.Equal("14.0", project.Root!.Attribute("ToolsVersion")?.Value);
		Assert.Contains(project.Descendants(), element => element.Name.LocalName == "ProjectGuid" && element.Value == "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}");
	}

	[Fact]
	public void WildcardFindsTheAssembliesInADirectory() {
		var input = Path.Combine(TemporaryDirectory, "input");
		Directory.CreateDirectory(input);
		File.Copy(typeof(AnalyzerTarget.Shape).Assembly.Location, Path.Combine(input, "AnalyzerTarget.dll"));
		File.Copy(typeof(SearchTarget.Library).Assembly.Location, Path.Combine(input, "SearchTarget.dll"));
		File.WriteAllText(Path.Combine(input, "ignored.txt"), "not managed");
		var output = Path.Combine(TemporaryDirectory, "wildcard");
		var result = Run("--sdk-project", "-o", output, Path.Combine(input, "*.dll"));

		Assert.Equal(0, result.ExitCode);
		Assert.True(Directory.Exists(Path.Combine(output, "AnalyzerTarget")));
		Assert.True(Directory.Exists(Path.Combine(output, "SearchTarget")));
	}

	[Fact]
	public void NoGacStillDecompilesAModuleWhoseReferencesAreBesideIt() {
		var result = Run("--no-color", "--no-gac", "-t", "dnSpy.Backend.Contracts.RpcException", ContractsAssembly);
		Assert.Equal(0, result.ExitCode);
		Assert.Contains("class RpcException", result.Output, StringComparison.Ordinal);
	}

	[Fact]
	public void LanguageCanBeSelectedByGuid() {
		var result = Run("--no-color", "-l", "A4F35508-691F-4BD0-B74D-D5D5D1D0E8E6", "-t", "dnSpy.Backend.Contracts.RpcException", ContractsAssembly);
		Assert.Equal(0, result.ExitCode);
		Assert.Contains(".class", result.Output, StringComparison.Ordinal);
	}

	[Fact]
	public void LanguageOptionsAreAcceptedWithNoAndDontPrefixes() {
		var result = Run("--no-color", "-l", "IL", "--dont-tokens", "--no-bytes", "--sort-members", "-t", "dnSpy.Backend.Contracts.RpcException", ContractsAssembly);
		Assert.Equal(0, result.ExitCode);
		// The RVA/byte comments the default IL view writes come from those two options.
		Assert.DoesNotContain("/* 0x", result.Output, StringComparison.Ordinal);
	}

	int RpcExceptionCtorToken {
		get {
			using var module = ModuleDefMD.Load(typeof(RpcException).Assembly.Location);
			var type = module.GetTypes().Single(type => type.Name == "RpcException");
			var ctor = type.Methods.First(method => method.IsConstructor && method.Parameters.Count > 0);
			return unchecked((int)ctor.MDToken.Raw);
		}
	}

	string Token(int token) => "0x" + token.ToString("X8", System.Globalization.CultureInfo.InvariantCulture);

	static string ContractsAssembly => typeof(HelloRequest).Assembly.Location;
	static string ConsumerAssembly => Path.Combine(AppContext.BaseDirectory, "AnalyzerTarget.Consumer.dll");

	static string BamlTargetAssembly => Path.GetFullPath(Path.Combine(
		AppContext.BaseDirectory, "..", "..", "..", "..", "BamlTarget", "bin", TestConfiguration, "net10.0-windows", "BamlTarget.dll"));

	static string TestConfiguration => new DirectoryInfo(AppContext.BaseDirectory).Parent?.Name
		?? throw new InvalidOperationException("The test output directory has no configuration directory.");

	static (int ExitCode, string Output, string Error) Run(params string[] args) {
		var output = new StringWriter();
		var error = new StringWriter();
		var exitCode = new DnSpyConsole(output, error, colorizeDefault: false).Run(args);
		return (exitCode, output.ToString(), error.ToString());
	}
}
