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
		using System.Diagnostics;

		namespace OptionsTarget {
			public class Empty {
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
			new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
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

	public void Dispose() {
		manager.Dispose();
		try {
			Directory.Delete(directory, recursive: true);
		}
		catch (IOException) {
		}
	}
}
