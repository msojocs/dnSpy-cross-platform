using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.LanguageService;
using Xunit;

namespace dnSpy.Backend.Tests.LanguageService;

/// <summary>
/// Covers the Roslyn language service a C# code editor runs on — the features of dnSpy's Edit Code editor:
/// semantic colors, completion with its tooltips, Quick Info, signature help, compiler messages, smart
/// indentation and the syntax spans structure navigation walks.
/// </summary>
public sealed class RoslynLanguageServiceTests : IDisposable {
	readonly RoslynLanguageService service = new();

	public void Dispose() => service.Dispose();

	static CancellationToken Token => TestContext.Current.CancellationToken;

	string Open(string text) => service.Open(new CodeDocumentOpenRequest(text)).DocumentId;

	/// <summary>The offset of the <paramref name="occurrence"/>th <paramref name="marker"/>, plus <paramref name="delta"/>.</summary>
	static int At(string text, string marker, int delta = 0, int occurrence = 1) {
		var index = -1;
		for (var i = 0; i < occurrence; i++) {
			index = text.IndexOf(marker, index + 1, StringComparison.Ordinal);
			Assert.True(index >= 0, $"'{marker}' is not in the text");
		}
		return index + delta;
	}

	static string Text(IEnumerable<TextPartDto> parts) => string.Concat(parts.Select(p => p.Text));

	[Fact]
	public async Task SymbolsAreColoredByWhatTheyAre() {
		const string code = """
			using System;
			static class Util { public const int Limit = 3; public static int Count; }
			sealed class Leaf { }
			struct Point { public int X; }
			enum Kind { First }
			interface IShape { event EventHandler Changed; }
			class Program<T> {
				int field;
				int Property { get; set; }
				void Run(int value, T item) {
					var local = value + Util.Limit + Util.Count + field + Property;
					Kind kind = Kind.First;
					Console.WriteLine("text");
				}
			}
			""";
		var id = Open(code);
		var spans = (await service.ClassifyAsync(new CodeDocumentRequest(id), Token)).Spans;
		var colors = spans.Select(s => (code.Substring(s.Start, s.Length), s.Color)).ToHashSet();

		Assert.Contains(("Util", TextColors.StaticType), colors);
		Assert.Contains(("Leaf", TextColors.SealedType), colors);
		Assert.Contains(("Program", TextColors.Type), colors);
		Assert.Contains(("Point", TextColors.ValueType), colors);
		Assert.Contains(("Kind", TextColors.Enum), colors);
		Assert.Contains(("First", TextColors.EnumField), colors);
		Assert.Contains(("IShape", TextColors.Interface), colors);
		Assert.Contains(("Changed", TextColors.InstanceEvent), colors);
		Assert.Contains(("Limit", TextColors.LiteralField), colors);
		Assert.Contains(("Count", TextColors.StaticField), colors);
		Assert.Contains(("field", TextColors.InstanceField), colors);
		Assert.Contains(("Property", TextColors.InstanceProperty), colors);
		Assert.Contains(("Run", TextColors.InstanceMethod), colors);
		Assert.Contains(("WriteLine", TextColors.StaticMethod), colors);
		Assert.Contains(("value", TextColors.Parameter), colors);
		Assert.Contains(("local", TextColors.Local), colors);
		Assert.Contains(("T", TextColors.TypeGenericParameter), colors);
		Assert.Contains(("System", TextColors.Namespace), colors);
		Assert.Contains(("\"text\"", TextColors.String), colors);
		Assert.Contains(("class", TextColors.Keyword), colors);
	}

	[Fact]
	public async Task UpdatingADocumentReplacesItsText() {
		var id = Open("class A { }");
		service.Update(new CodeDocumentUpdateRequest(id, "static class B { }"));

		var spans = (await service.ClassifyAsync(new CodeDocumentRequest(id), Token)).Spans;

		Assert.Contains(spans, s => s.Start == 13 && s.Length == 1 && s.Color == TextColors.StaticType);
	}

	[Fact]
	public async Task AClosedDocumentIsGone() {
		var id = Open("class A { }");
		service.Close(new CodeDocumentRequest(id));

		var error = await Assert.ThrowsAsync<RpcException>(() => service.ClassifyAsync(new CodeDocumentRequest(id), Token));
		Assert.Equal(ErrorCodes.InvalidParams, error.Code);
	}

	[Fact]
	public async Task CompletionAfterADotListsTheMembersWithTheirTooltips() {
		const string code = "class C { void M() { System.Console. } }";
		var id = Open(code);
		var position = At(code, "Console.", "Console.".Length);

		var list = (await service.GetCompletionAsync(new CodeCompletionRequest(id, position, "."), Token)).List;

		Assert.NotNull(list);
		Assert.Equal(position, list.Span.Start);
		var writeLine = Assert.Single(list.Items, i => i.DisplayText == "WriteLine");
		Assert.Contains("Method", writeLine.Tags);
		Assert.Equal("WriteLine", writeLine.InsertText);
		Assert.Contains('(', writeLine.CommitCharacters);

		var description = await service.GetCompletionDescriptionAsync(new CodeCompletionDescriptionRequest(id, list.ResultId, writeLine.Index), Token);
		Assert.Contains("Console.WriteLine", Text(description.Parts), StringComparison.Ordinal);
		Assert.Contains(description.Parts, p => p.Text == "WriteLine" && p.Color == TextColors.InstanceMethod);
	}

	[Fact]
	public async Task AGenericTypeIsInsertedWithoutItsBrackets() {
		const string code = "using System.Collections.Generic; class C { void M() { Lis } }";
		var id = Open(code);

		var list = (await service.GetCompletionAsync(new CodeCompletionRequest(id, At(code, "Lis", 3)), Token)).List;

		Assert.NotNull(list);
		var item = Assert.Single(list.Items, i => i.DisplayText == "List" && i.DisplayTextSuffix == "<>");
		Assert.Equal("List", item.InsertText);
	}

	[Fact]
	public async Task ACharacterThatOpensNoListGetsNone() {
		const string code = "class C { void M() { int x = 1; } }";
		var id = Open(code);

		var list = (await service.GetCompletionAsync(new CodeCompletionRequest(id, At(code, ";", 1), ";"), Token)).List;

		Assert.Null(list);
	}

	[Fact]
	public async Task ADescriptionOfAnOutdatedListIsEmpty() {
		const string code = "class C { void M() { System.Console. } }";
		var id = Open(code);
		var list = (await service.GetCompletionAsync(new CodeCompletionRequest(id, At(code, "Console.", 8), "."), Token)).List;
		Assert.NotNull(list);
		service.Update(new CodeDocumentUpdateRequest(id, code));

		var description = await service.GetCompletionDescriptionAsync(new CodeCompletionDescriptionRequest(id, list.ResultId, 0), Token);

		Assert.Empty(description.Parts);
	}

	[Fact]
	public async Task QuickInfoShowsTheSymbolWithItsGlyph() {
		const string code = "class C { /// <summary>Does it.</summary>\nvoid Run(int count) { Run(count); } }";
		var id = Open(code);

		var info = (await service.GetQuickInfoAsync(new CodePositionRequest(id, At(code, "Run(count)", 1)), Token)).QuickInfo;

		Assert.NotNull(info);
		Assert.Equal(At(code, "Run(count)"), info.Span.Start);
		Assert.Equal("MethodPrivate", info.Glyph);
		Assert.False(info.Warning);
		var description = Assert.Single(info.Sections, s => s.Kind == "Description");
		Assert.Contains("void C.Run(int count)", Text(description.Parts), StringComparison.Ordinal);
		Assert.Contains(description.Parts, p => p.Text == "int" && p.Color == TextColors.Keyword);
		var documentation = Assert.Single(info.Sections, s => s.Kind == "DocumentationComments");
		Assert.Equal("Does it.", Text(documentation.Parts).Trim());
	}

	[Fact]
	public async Task QuickInfoOverWhiteSpaceIsNothing() {
		const string code = "class C {      }";
		var id = Open(code);

		var info = (await service.GetQuickInfoAsync(new CodePositionRequest(id, 12), Token)).QuickInfo;

		Assert.Null(info);
	}

	[Fact]
	public async Task SignatureHelpPicksTheOverloadTheArgumentsBindTo() {
		const string code = """
			class C {
				/// <summary>Adds.</summary>
				/// <param name="a">The first.</param>
				/// <param name="b">The second.</param>
				static int Add(int a, int b) => a + b;
				static int Add(int a) => a;
				void M() { Add(1, 2); }
			}
			""";
		var id = Open(code);

		var help = (await service.GetSignatureHelpAsync(new CodeSignatureHelpRequest(id, At(code, "2)")), Token)).Help;

		Assert.NotNull(help);
		Assert.Equal(2, help.Items.Count);
		Assert.Equal(1, help.ArgumentIndex);
		Assert.Equal(2, help.ArgumentCount);
		var selected = help.Items[help.SelectedItem];
		Assert.Equal(["a", "b"], selected.Parameters.Select(p => p.Name));
		Assert.Equal("int C.Add(", Text(selected.Prefix));
		Assert.Equal("int b", Text(selected.Parameters[1].Display));
		Assert.Equal("Adds.", Text(selected.Documentation));
		Assert.Equal("The second.", Text(selected.Parameters[1].Documentation));
		Assert.Equal(")", Text(selected.Suffix));
		Assert.Equal(At(code, "(1, 2)", 1), help.ApplicableSpan.Start);
	}

	[Fact]
	public async Task SignatureHelpBeforeAnyArgumentSelectsAnOverloadThatFits() {
		const string code = "class C { static void F(int a) { } static void F(int a, int b) { } void M() { F( } }";
		var id = Open(code);

		var help = (await service.GetSignatureHelpAsync(new CodeSignatureHelpRequest(id, At(code, "F( ", 2), "("), Token)).Help;

		Assert.NotNull(help);
		Assert.Equal(0, help.ArgumentIndex);
		Assert.Equal(2, help.Items.Count);
	}

	[Fact]
	public async Task SignatureHelpCoversConstructorsIndexersAttributesAndGenericNames() {
		const string code = """
			using System;
			using System.Collections.Generic;
			class C {
				[Obsolete("x")]
				void M() {
					var sb = new System.Text.StringBuilder(16);
					var d = new Dictionary<string, int>();
					var v = d["k"];
					List<int> list = null;
				}
			}
			""";
		var id = Open(code);

		var constructor = (await service.GetSignatureHelpAsync(new CodeSignatureHelpRequest(id, At(code, "(16", 1)), Token)).Help;
		Assert.NotNull(constructor);
		Assert.True(constructor.Items.Count > 1);
		// Not imported here, so it is written the way it has to be named at that place.
		Assert.Equal("System.Text.StringBuilder(", Text(constructor.Items[constructor.SelectedItem].Prefix));

		var indexer = (await service.GetSignatureHelpAsync(new CodeSignatureHelpRequest(id, At(code, "[\"k\"", 1)), Token)).Help;
		Assert.NotNull(indexer);
		var item = indexer.Items[indexer.SelectedItem];
		Assert.Equal("]", Text(item.Suffix));
		Assert.Equal("string key", Text(item.Parameters[0].Display));

		var attribute = (await service.GetSignatureHelpAsync(new CodeSignatureHelpRequest(id, At(code, "(\"x\"", 1)), Token)).Help;
		Assert.NotNull(attribute);
		Assert.StartsWith("ObsoleteAttribute(", Text(attribute.Items[attribute.SelectedItem].Prefix), StringComparison.Ordinal);

		var generic = (await service.GetSignatureHelpAsync(new CodeSignatureHelpRequest(id, At(code, "<int>", 1)), Token)).Help;
		Assert.NotNull(generic);
		var list = generic.Items[generic.SelectedItem];
		Assert.Equal("List<", Text(list.Prefix));
		Assert.Equal("T", Assert.Single(list.Parameters).Name);
	}

	[Fact]
	public async Task SignatureHelpOutsideAnArgumentListIsNothing() {
		const string code = "class C { void M() { int x = 1; } }";
		var id = Open(code);

		var help = (await service.GetSignatureHelpAsync(new CodeSignatureHelpRequest(id, At(code, "= 1", 2)), Token)).Help;

		Assert.Null(help);
	}

	[Fact]
	public async Task DiagnosticsAreWhatCompilingReports() {
		const string code = "class C {\n\tvoid M() { int x = \"s\"; }\n}";
		var id = Open(code);

		var diagnostics = (await service.GetDiagnosticsAsync(new CodeDocumentRequest(id), Token)).Diagnostics;

		var error = Assert.Single(diagnostics, d => d.Severity == "error");
		Assert.Equal("CS0029", error.Id);
		Assert.Equal("https://docs.microsoft.com/dotnet/csharp/language-reference/compiler-messages/cs0029", error.HelpUri);
		Assert.Equal(1, error.StartLine);
		Assert.Equal(At(code, "\"s\""), error.Start);
		Assert.Equal(3, error.Length);
	}

	[Fact]
	public async Task CodeThatCompilesHasNoErrors() {
		var id = Open("using System; public class C { public static void Main() => Console.WriteLine(1); }");

		var diagnostics = (await service.GetDiagnosticsAsync(new CodeDocumentRequest(id), Token)).Diagnostics;

		Assert.DoesNotContain(diagnostics, d => d.Severity == "error");
	}

	[Fact]
	public void HelpUrisFollowDnSpysTable() {
		Assert.Equal("https://docs.microsoft.com/dotnet/csharp/misc/cs0012", RoslynLanguageService.GetHelpUri("CS0012"));
		Assert.Equal("https://docs.microsoft.com/dotnet/csharp/misc/compiler-warning-cs3024", RoslynLanguageService.GetHelpUri("CS3024"));
	}

	[Theory]
	// An empty line inside a method body, inside a class body, and after an if without braces.
	[InlineData("class C\n{\n    void M()\n    {\n\n    }\n}", 4, 8)]
	[InlineData("class C\n{\n\n}", 2, 4)]
	[InlineData("class C\n{\n    void M()\n    {\n        if (true)\n\n    }\n}", 5, 12)]
	// A line whose text is a closing brace lines up with the opening one.
	[InlineData("class C\n{\n    void M()\n    {\n            }\n}", 4, 4)]
	public async Task SmartIndentationIsWhereTheFormatterPutsTheLine(string code, int line, int expected) {
		var id = Open(code);

		var response = await service.GetIndentationAsync(new CodeIndentationRequest(id, line), Token);

		Assert.Equal(expected, response.Indentation);
	}

	[Fact]
	public async Task SmartIndentationCountsTabs() {
		var id = Open("class C\n{\n\tvoid M()\n\t{\n\n\t}\n}");

		var response = await service.GetIndentationAsync(new CodeIndentationRequest(id, 4, IndentSize: 4, TabSize: 4, UseTabs: true), Token);

		Assert.Equal(8, response.Indentation);
	}

	[Fact]
	public async Task SelectionRangesGrowFromTheTokenOutwards() {
		const string code = "class C { void M() { System.Console.WriteLine(1); } }";
		var id = Open(code);
		var position = At(code, "Console", 2);

		var ranges = Assert.Single((await service.GetSelectionRangesAsync(new CodeSelectionRangesRequest(id, [position]), Token)).Ranges);

		var texts = ranges.Select(r => code.Substring(r.Start, r.Length)).ToArray();
		Assert.Equal("Console", texts[0]);
		Assert.Equal("System.Console", texts[1]);
		Assert.Equal("System.Console.WriteLine", texts[2]);
		Assert.Equal("System.Console.WriteLine(1)", texts[3]);
		Assert.Equal("System.Console.WriteLine(1);", texts[4]);
		Assert.Equal(code, texts[^1]);
		// Every range holds the one before it.
		for (var i = 1; i < ranges.Count; i++)
			Assert.True(ranges[i].Start <= ranges[i - 1].Start && ranges[i].Start + ranges[i].Length >= ranges[i - 1].Start + ranges[i - 1].Length);
	}

	[Fact]
	public async Task ACaretRightAfterAWordSelectsTheWord() {
		const string code = "class C { int value; }";
		var id = Open(code);

		var ranges = Assert.Single((await service.GetSelectionRangesAsync(new CodeSelectionRangesRequest(id, [At(code, "value", 5)]), Token)).Ranges);

		Assert.Equal("value", code.Substring(ranges[0].Start, ranges[0].Length));
	}

	[Fact]
	public async Task ReferencesComeFromTheRequestWhenItNamesThem() {
		var mscorlib = typeof(object).Assembly.Location;
		var id = service.Open(new CodeDocumentOpenRequest("class C { System.Text.StringBuilder sb; }", [mscorlib])).DocumentId;

		var diagnostics = (await service.GetDiagnosticsAsync(new CodeDocumentRequest(id), Token)).Diagnostics;

		// StringBuilder lives in System.Private.CoreLib, the only reference given, so it binds.
		Assert.DoesNotContain(diagnostics, d => d.Id == "CS0246");
	}

	[Fact]
	public async Task PreprocessorSymbolsComeFromTheCompilerOptions() {
		const string code = "class C {\n#if DNSPY\n  int x = \"s\";\n#endif\n}";
		var withSymbol = service.Open(new CodeDocumentOpenRequest(code, Options: new CodeCompilerOptionsDto(PreprocessorSymbols: "TRACE;DNSPY"))).DocumentId;
		var withoutSymbol = Open(code);

		Assert.Contains((await service.GetDiagnosticsAsync(new CodeDocumentRequest(withSymbol), Token)).Diagnostics, d => d.Id == "CS0029");
		Assert.DoesNotContain((await service.GetDiagnosticsAsync(new CodeDocumentRequest(withoutSymbol), Token)).Diagnostics, d => d.Id == "CS0029");
	}

	[Fact]
	public async Task FrameworkSymbolsHaveTheirDocumentationWhenAReferencePackIsInstalled() {
		if (!ReferenceAssemblies.Framework.Any(path => path.Contains($"{Path.DirectorySeparatorChar}packs{Path.DirectorySeparatorChar}", StringComparison.Ordinal)))
			Assert.Skip("No Microsoft.NETCore.App.Ref pack beside this runtime.");
		const string code = "class C { void M() { System.Console.WriteLine(1); } }";
		var id = Open(code);

		var info = (await service.GetQuickInfoAsync(new CodePositionRequest(id, At(code, "WriteLine", 2)), Token)).QuickInfo;
		var help = (await service.GetSignatureHelpAsync(new CodeSignatureHelpRequest(id, At(code, "(1", 1)), Token)).Help;

		Assert.NotNull(info);
		Assert.Contains(info.Sections, s => s.Kind == "DocumentationComments" && s.Parts.Count > 0);
		Assert.NotNull(help);
		Assert.NotEmpty(help.Items[help.SelectedItem].Documentation);
	}
}
