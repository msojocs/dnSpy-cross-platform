using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The C# page's options dnSpy's fork of ILSpy has and ICSharpCode.Decompiler 11 does not, as the documents write
/// them: token and RVA comments, the member order (UseSourceCodeOrder, SortMembers, the decompilation order), the
/// implied modifiers, attributes per line, hexadecimal numbers, empty default constructors, readability
/// parentheses, using order and fully qualified types — with the fork's defaults when the client sends no page.
/// </summary>
public sealed class CSharpDecompilerOptionsTests : IDisposable {
	const string Source = """
		using System;
		using System.Collections.Generic;
		using System.Diagnostics;
		using System.Threading.Tasks;
		using Ambiguous.One;
		using Ambiguous.Two;

		namespace Ambiguous.One {
			public class Thing { }
		}

		namespace Ambiguous.Two {
			public class Thing { }
		}

		namespace OptionsTarget {
			public class Empty {
			}

			internal class Ambiguity {
				public Ambiguous.One.Thing One() => new Ambiguous.One.Thing();
				public Ambiguous.Two.Thing Two() => new Ambiguous.Two.Thing();
			}

			internal class Fields {
				private int value = Compute();
				private static int other = Compute() + 1;

				static Fields() {
					Console.WriteLine("static");
				}

				public Fields() {
					Console.WriteLine("instance");
				}

				private static int Compute() => 1;
			}

			internal class StaticFields {
				private static int other = Compute() + 1;
				private static int Compute() => 1;
			}

			internal static unsafe class Calls {
				public static int Invoke(delegate*<int, int> function) => function(42);
			}

			internal class Hidden {
				public Func<int, int> Make() => x => x + 1;

				public async Task<int> Later() {
					await Task.Yield();
					return 1;
				}

				public IEnumerable<int> Items() {
					yield return 1;
				}
			}

			internal class Sample {
				private int value = 255;
				public int Zeta;
				public int Alpha;

				public bool Mixed(bool a, bool b, bool c) => a && b || c;

				[Obsolete("x"), DebuggerNonUserCode]
				private int Twice() => value * 2 + 12;

				public int Negative() => -300;
			}
		}
		""";

	readonly WorkspaceManager manager = new();
	readonly string directory = Path.Combine(Path.GetTempPath(), $"dnspy-options-{Guid.NewGuid():N}");
	readonly string path;

	public CSharpDecompilerOptionsTests() {
		Directory.CreateDirectory(directory);
		path = Path.Combine(directory, "OptionsTarget.dll");
		var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
			.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
			.Select(reference => MetadataReference.CreateFromFile(reference));
		var compilation = CSharpCompilation.Create("OptionsTarget", [CSharpSyntaxTree.ParseText(Source)], references,
			new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, allowUnsafe: true));
		var result = compilation.Emit(path);
		Assert.True(result.Success, string.Join("\n", result.Diagnostics));
	}

	static CancellationToken Token => TestContext.Current.CancellationToken;

	async Task<(string WorkspaceId, string NodeId)> TypeAsync(string name) {
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), Token);
		using var module = dnlib.DotNet.ModuleDefMD.Load(path);
		var type = module.Find("OptionsTarget." + name, isReflectionName: true);
		var found = await manager.FindMemberAsync(new FindMemberRequest(opened.WorkspaceId, path, unchecked((int)type.MDToken.Raw)), Token);
		return (opened.WorkspaceId, found.NodeId!);
	}

	async Task<DecompileResponse> DecompileAsync(string name, CSharpDecompilerSettingsDto? page = null, DecompilerLanguage language = DecompilerLanguage.CSharp) {
		var (workspaceId, nodeId) = await TypeAsync(name);
		return await manager.DecompileAsync(new DecompileRequest(workspaceId, nodeId, language) { Settings = page is null ? null : new DecompilerSettingsDto(CSharp: page) }, Token);
	}

	static string[] Lines(DecompileResponse document) => document.Text.Split('\n').Select(line => line.TrimEnd('\r').Trim()).ToArray();

	static int IndexOf(string[] lines, string text) {
		var index = Array.FindIndex(lines, line => line.Contains(text, StringComparison.Ordinal));
		Assert.True(index >= 0, $"No line has '{text}'.");
		return index;
	}

	[Fact]
	public async Task WritesTheForksDefaults() {
		var (workspaceId, nodeId) = await TypeAsync("Sample");
		var document = await manager.DecompileAsync(new DecompileRequest(workspaceId, nodeId, DecompilerLanguage.CSharp), Token);
		var lines = Lines(document);
		using var module = dnlib.DotNet.ModuleDefMD.Load(path);
		var sample = module.Find("OptionsTarget.Sample", isReflectionName: true);
		var mixed = sample.FindMethod("Mixed");

		// ShowTokenAndRvaComments: the type's token and row; a method's with its RVA and file offset.
		Assert.Equal($"// Token: 0x{sample.MDToken.Raw:X8} RID: {sample.MDToken.Rid}", lines[IndexOf(lines, "class Sample") - 1]);
		var mixedComment = lines[IndexOf(lines, "public bool Mixed(") - 1];
		Assert.Equal($"// Token: 0x{mixed.MDToken.Raw:X8} RID: {mixed.MDToken.Rid} RVA: 0x{(uint)mixed.RVA:X8} File Offset: 0x{(uint)module.Metadata.PEImage.ToFileOffset(mixed.RVA):X8}", mixedComment);
		// TypeAddInternalModifier and MemberAddPrivateModifier are on.
		Assert.Contains("internal class Sample", lines);
		Assert.Contains("private int value = 255;", lines);
		// OneCustomAttributePerLine.
		Assert.Contains("[Obsolete(\"x\")]", lines);
		Assert.Contains("[DebuggerNonUserCode]", lines);
		// Decimal numbers, readability parentheses.
		Assert.Contains("return value * 2 + 12;", lines);
		// The optimized `a && b || c` is `(a & b) | c`; the parentheses only help a reader.
		Assert.Contains("return (a & b) | c;", lines);
		// UseSourceCodeOrder: the fields in metadata order, then the methods in theirs.
		Assert.True(IndexOf(lines, "int value") < IndexOf(lines, "int Zeta") && IndexOf(lines, "int Zeta") < IndexOf(lines, "int Alpha"));
		Assert.True(IndexOf(lines, "int Alpha") < IndexOf(lines, "Mixed(") && IndexOf(lines, "Mixed(") < IndexOf(lines, "Twice()") && IndexOf(lines, "Twice()") < IndexOf(lines, "Negative()"));

		// The token names its member; the RVA and the file offset are addresses of the file.
		var commentStart = document.Text.IndexOf(mixedComment, StringComparison.Ordinal);
		var spans = document.Spans.Where(span => span.Start >= commentStart && span.Start < commentStart + mixedComment.Length).ToList();
		Assert.Equal(3, spans.Count);
		var mixedNode = await manager.FindMemberAsync(new FindMemberRequest(workspaceId, path, unchecked((int)mixed.MDToken.Raw)), Token);
		Assert.Equal(("reference", mixedNode.NodeId), (spans[0].Kind, spans[0].TargetNodeId));
		Assert.Equal(new AddressDto(path, true, (uint)mixed.RVA, 0), spans[1].Address);
		Assert.Equal(new AddressDto(path, false, (long)module.Metadata.PEImage.ToFileOffset(mixed.RVA), 0), spans[2].Address);
	}

	[Fact]
	public async Task LeavesTheEmptyDefaultConstructorOutByDefaultAndKeepsItWhenAsked() {
		Assert.DoesNotContain("public Empty()", Lines(await DecompileAsync("Empty")));
		var kept = Lines(await DecompileAsync("Empty", new CSharpDecompilerSettingsDto(RemoveEmptyDefaultConstructors: false)));
		Assert.Contains("public Empty()", kept);
		// ForceShowAllMembers keeps it too.
		Assert.Contains("public Empty()", Lines(await DecompileAsync("Empty", new CSharpDecompilerSettingsDto(ForceShowAllMembers: true))));
	}

	[Fact]
	public async Task WritesThePageAsItIsSet() {
		var lines = Lines(await DecompileAsync("Sample", new CSharpDecompilerSettingsDto(
			ShowTokenAndRvaComments: false,
			TypeAddInternalModifier: false,
			MemberAddPrivateModifier: false,
			OneCustomAttributePerLine: false,
			HexadecimalNumbers: true,
			InsertParenthesesForReadability: false,
			UseSourceCodeOrder: false,
			SortMembers: true)));

		Assert.DoesNotContain(lines, line => line.Contains("Token:", StringComparison.Ordinal));
		Assert.Contains("class Sample", lines);
		Assert.Contains("int value = 0xFF;", lines);
		Assert.Contains("[Obsolete(\"x\"), DebuggerNonUserCode]", lines);
		Assert.Contains("int Twice()", lines);
		Assert.Contains("return value * 2 + 0xC;", lines);
		Assert.Contains("return -0x12C;", lines);
		Assert.Contains("return a & b | c;", lines);
		// SortMembers: each kind by name.
		Assert.True(IndexOf(lines, "int Alpha") < IndexOf(lines, "int value") && IndexOf(lines, "int value") < IndexOf(lines, "int Zeta"));
		Assert.True(IndexOf(lines, "Mixed(") < IndexOf(lines, "Negative()") && IndexOf(lines, "Negative()") < IndexOf(lines, "Twice()"));
	}

	[Fact]
	public async Task WritesTheKindsInTheDecompilationOrder() {
		var lines = Lines(await DecompileAsync("Sample", new CSharpDecompilerSettingsDto(DecompilationOrder: ["methods", "properties", "events", "fields", "nestedTypes"])));
		Assert.True(IndexOf(lines, "Negative()") < IndexOf(lines, "int value"));
	}

	[Fact]
	public async Task FullyQualifiesEveryTypeAndStillImportsItsNamespace() {
		var document = await DecompileAsync("Sample", new CSharpDecompilerSettingsDto(FullyQualifyAllTypes: true));
		var lines = Lines(document);
		Assert.Contains("[System.Obsolete(\"x\")]", lines);
		Assert.Contains("using System;", lines);
		Assert.Contains("using System.Diagnostics;", lines);
		// SortSystemUsingStatementsFirst.
		Assert.True(IndexOf(lines, "using System;") < IndexOf(lines, "using System.Diagnostics;"));
	}

	[Fact]
	public async Task TheVisualBasicViewCarriesTheTokenCommentsToo() {
		var document = await DecompileAsync("Sample", language: DecompilerLanguage.VisualBasic);
		var lines = Lines(document);
		var comment = Assert.Single(lines, line => line.StartsWith("' Token: ", StringComparison.Ordinal) && line.Contains("RVA:", StringComparison.Ordinal) && lines[Array.IndexOf(lines, line) + 1].Contains("Mixed(", StringComparison.Ordinal));
		var start = document.Text.IndexOf(comment, StringComparison.Ordinal);
		Assert.Contains(document.Spans, span => span.Start > start && span.Start < start + comment.Length && span.TargetNodeId is not null);
	}

	[Fact]
	public async Task WritesAmbiguousTypeNamesWithoutTheirNamespaceWhenAsked() {
		// Both usings are imported and both types are used, so the package qualifies each reference; the fork
		// writes the simple name unless FullyQualifyAmbiguousTypeNames is on.
		var qualified = Lines(await DecompileAsync("Ambiguity"));
		Assert.Contains(qualified, line => line.Contains("Ambiguous.One.Thing", StringComparison.Ordinal));
		Assert.Contains(qualified, line => line.Contains("Ambiguous.Two.Thing", StringComparison.Ordinal));

		var simple = Lines(await DecompileAsync("Ambiguity", new CSharpDecompilerSettingsDto(FullyQualifyAmbiguousTypeNames: false)));
		Assert.Contains(simple, line => line.Contains("public Thing One()", StringComparison.Ordinal));
		Assert.Contains(simple, line => line.Contains("public Thing Two()", StringComparison.Ordinal));
		Assert.DoesNotContain(simple, line => line.Contains("Ambiguous.One.Thing", StringComparison.Ordinal));
		Assert.Contains("using Ambiguous.One;", simple);
		Assert.Contains("using Ambiguous.Two;", simple);
	}

	[Fact]
	public async Task MovesFieldInitializersBackIntoConstructorsWhenTheyAreNotAllowed() {
		var moved = Lines(await DecompileAsync("Fields"));
		Assert.Contains("private int value = Compute();", moved);
		// The explicit static constructor keeps its assignment where it is: the package only moves a static
		// field initializer out of a type that has no explicit one.
		Assert.Contains("other = Compute() + 1;", moved);
		Assert.DoesNotContain(moved, line => line.Contains("private static int other =", StringComparison.Ordinal));

		var inConstructors = Lines(await DecompileAsync("Fields", new CSharpDecompilerSettingsDto(AllowFieldInitializers: false)));
		Assert.DoesNotContain(inConstructors, line => line.Contains("int value =", StringComparison.Ordinal));
		Assert.True(IndexOf(inConstructors, "this.value = Compute();") < IndexOf(inConstructors, "Console.WriteLine(\"instance\")"));
		Assert.True(IndexOf(inConstructors, "other = Compute() + 1;") < IndexOf(inConstructors, "Console.WriteLine(\"static\")"));

		// Without an explicit static constructor, the package moves the initializer and removes the .cctor; the
		// fork's option keeps both the field and the constructor.
		var staticMoved = Lines(await DecompileAsync("StaticFields"));
		Assert.Contains("private static int other = Compute() + 1;", staticMoved);
		var staticBack = Lines(await DecompileAsync("StaticFields", new CSharpDecompilerSettingsDto(AllowFieldInitializers: false)));
		Assert.Contains(staticBack, line => line.Contains("private static int other;", StringComparison.Ordinal));
		Assert.Contains(staticBack, line => line.Contains("static StaticFields()", StringComparison.Ordinal));
		Assert.Contains("StaticFields.other = Compute() + 1;", staticBack);
	}

	[Fact]
	public async Task WritesCalliAsInlineAssemblyUnlessInvocationExpressionsAreAsked() {
		var inline = Lines(await DecompileAsync("Calls"));
		Assert.Contains(inline, line => line.Contains("calli(System.Int32(System.Int32), 42, function)", StringComparison.Ordinal));

		var invocation = Lines(await DecompileAsync("Calls", new CSharpDecompilerSettingsDto(EmitCalliAsInvocationExpression: true)));
		Assert.DoesNotContain(invocation, line => line.Contains("calli(", StringComparison.Ordinal));
		Assert.Contains(invocation, line => line.Contains("function(42)", StringComparison.Ordinal));
	}

	[Fact]
	public async Task ShowsTheMembersTheDecompilerFoldsAwayWhenForced() {
		var hidden = Lines(await DecompileAsync("Hidden"));
		Assert.DoesNotContain(hidden, line => line.Contains("<Make>b__", StringComparison.Ordinal));
		Assert.DoesNotContain(hidden, line => line.Contains("MoveNext", StringComparison.Ordinal));

		var shown = Lines(await DecompileAsync("Hidden", new CSharpDecompilerSettingsDto(ForceShowAllMembers: true)));
		Assert.Contains(shown, line => line.Contains("<Make>b__", StringComparison.Ordinal));
		// The state machines the async and iterator methods compile to, as dnSpy's ForceShowAllMembers writes them.
		Assert.Contains(shown, line => line.Contains("MoveNext", StringComparison.Ordinal));
		Assert.Contains(shown, line => line.Contains("<Items>d__", StringComparison.Ordinal));
	}

	public void Dispose() {
		manager.Dispose();
		try {
			Directory.Delete(directory, recursive: true);
		}
		catch (IOException) {
		}
	}
}
