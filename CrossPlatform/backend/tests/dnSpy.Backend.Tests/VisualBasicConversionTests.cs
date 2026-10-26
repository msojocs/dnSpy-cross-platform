using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.VisualBasic;
using Xunit;
using VbSyntaxTree = Microsoft.CodeAnalysis.VisualBasic.VisualBasicSyntaxTree;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The Visual Basic view: a C# document the converter turns into Visual Basic that compiles — records and primary
/// constructors as classes, switch expressions as <c>Select Case</c>, collection and range expressions, patterns,
/// deconstructions, using declarations, local functions as delegate locals, case-colliding locals renamed, and the
/// compiler's own member names made identifiers. A construct no Visual Basic form exists for is commented out,
/// never left as bare C#.
/// </summary>
public sealed class VisualBasicConversionTests : IDisposable {
	const string Source = """
		using System;
		using System.Collections.Generic;
		using System.IO;
		using System.Linq;

		namespace VbTarget {
			public record Person(string Name, int Age);

			public class Primary(int seed) {
				public int Seed => seed;
				public string Describe(int x) => x switch { 0 => "zero", 1 => "one", _ => "many" };
				public int[] Numbers() => [seed, seed + 1, seed + 2];
				public string Text(object o) => o is Person { Age: > 18 } p ? p.Name : "minor";
			}

			public class Fields {
				private readonly int value = 42;
				public int P { get; init; }
				public required string Q { get; init; }
				public int Sum(int[] values) => values.Sum();
			}

			public enum Colors { None, Red, Blue }

			public class More {
				public int UseDecl() {
					using var stream = new MemoryStream();
					stream.WriteByte(1);
					return (int)stream.Length;
				}

				public int Pattern(object o) {
					if (o is string { Length: > 3 } s) return s.Length;
					if (o is int n and > 0) return n;
					return 0;
				}

				public int Local(int x) {
					return F(x);
					static int F(int y) => y * 2;
				}

				public int[] Range(int[] a) => a[1..^1];

				public (int A, int B) Tuple() => (1, 2);

				public int Deconstruct((int A, int B) t) {
					var (a, b) = t;
					return a + b;
				}

				public bool OutVar(string s) => int.TryParse(s, out var v);

				public string ThrowExpr(string s) => s ?? throw new ArgumentNullException(nameof(s));

				public int NullProp(string? s) => s?.Length ?? 0;

				public string Interp(int x) => $"value {x}";

				public int Collides() {
					var colors = Colors.Red | Colors.Blue;
					return (int)colors;
				}
			}

			public class Unsupported {
				public int GenericLocal(int x) {
					T F<T>(T v) {
						Console.WriteLine("{");
						return v;
					}
					return F(x);
				}

				public int After() => 1;
			}
		}
		""";

	readonly WorkspaceManager manager = new();
	readonly string directory = Path.Combine(Path.GetTempPath(), $"dnspy-vb-{Guid.NewGuid():N}");
	readonly string path;

	public VisualBasicConversionTests() {
		Directory.CreateDirectory(directory);
		path = Path.Combine(directory, "VbTarget.dll");
		var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
			.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
			.Select(reference => MetadataReference.CreateFromFile(reference));
		var compilation = CSharpCompilation.Create("VbTarget", [CSharpSyntaxTree.ParseText(Source)], references,
			new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
		var result = compilation.Emit(path);
		Assert.True(result.Success, string.Join("\n", result.Diagnostics));
	}

	static CancellationToken Token => TestContext.Current.CancellationToken;

	async Task<DecompileResponse> DecompileAsync(string typeName) {
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), Token);
		using var module = dnlib.DotNet.ModuleDefMD.Load(path);
		var type = module.Find("VbTarget." + typeName, isReflectionName: true);
		var found = await manager.FindMemberAsync(new FindMemberRequest(opened.WorkspaceId, path, unchecked((int)type.MDToken.Raw)), Token);
		return await manager.DecompileAsync(new DecompileRequest(opened.WorkspaceId, found.NodeId!, DecompilerLanguage.VisualBasic), Token);
	}

	[Theory]
	[InlineData("Person")]
	[InlineData("Primary")]
	[InlineData("Fields")]
	[InlineData("More")]
	public async Task TheConvertedDocumentCompiles(string typeName) {
		var document = await DecompileAsync(typeName);
		var diagnostics = CompileVisualBasic(document.Text, path);
		Assert.True(diagnostics.Length == 0, document.Text + "\n\n" + string.Join("\n", diagnostics));
		Assert.DoesNotContain("CONVERSION ERROR", document.Text, StringComparison.Ordinal);
		Assert.DoesNotContain("<", document.Text.Split('\n').FirstOrDefault(line => line.Contains("k__BackingField", StringComparison.Ordinal)) ?? string.Empty, StringComparison.Ordinal);
	}

	[Fact]
	public async Task ARecordBecomesAClass() {
		var text = (await DecompileAsync("Person")).Text;

		// dnSpy's own Visual Basic decompiler predates records; the converter gets the class form ILSpy writes.
		Assert.Contains("Class Person", text, StringComparison.Ordinal);
		Assert.DoesNotContain("Cannot convert", text, StringComparison.Ordinal);
		Assert.DoesNotContain("<Person>", text, StringComparison.Ordinal);
	}

	[Fact]
	public async Task ALocalFunctionWhoseLambdaCannotExpressItIsCommentedOut() {
		var text = (await DecompileAsync("Unsupported")).Text;

		// The converter has no local function; the generic one has no lambda form either. Its C# is commented —
		// no line of it is left as Visual Basic code.
		var lines = text.Split('\n').Select(line => line.TrimEnd('\r')).ToArray();
		var input = Array.FindIndex(lines, line => line.Contains("Input:", StringComparison.Ordinal));
		Assert.True(input >= 0, text);
		var bad = lines[(input + 1)..].TakeWhile(line => !line.TrimStart().StartsWith("End Function", StringComparison.Ordinal))
			.Where(line => line.Length != 0 && !line.TrimStart().StartsWith('\'')).ToArray();
		Assert.True(bad.Length == 0, string.Join(" | ", bad));
		// The brace in the quoted string did not swallow the rest of the document.
		Assert.Contains(lines, line => line.TrimStart().StartsWith("Public Function After", StringComparison.Ordinal));
	}

	/// <summary>The diagnostics of compiling the document as a Visual Basic project does, with its default imports.</summary>
	static string[] CompileVisualBasic(string text, string modulePath) {
		var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
			.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
			.Select(reference => MetadataReference.CreateFromFile(reference))
			.Append(MetadataReference.CreateFromFile(modulePath))
			.ToArray();
		var options = new VisualBasicCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
			.WithGlobalImports(GlobalImport.Parse("Microsoft.VisualBasic", "System", "System.Collections", "System.Collections.Generic",
				"System.Diagnostics", "System.Linq", "System.Xml.Linq", "System.Threading.Tasks"));
		var compilation = VisualBasicCompilation.Create("Probe", [VbSyntaxTree.ParseText(text)], references, options);
		using var stream = new MemoryStream();
		compilation.Emit(stream);
		return compilation.GetDiagnostics(Token)
			.Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
			.Select(diagnostic => diagnostic.ToString())
			.ToArray();
	}

	public void Dispose() {
		manager.Dispose();
		try {
			Directory.Delete(directory, recursive: true);
		}
		catch {
			// The temporary folder is only a fixture.
		}
	}
}
