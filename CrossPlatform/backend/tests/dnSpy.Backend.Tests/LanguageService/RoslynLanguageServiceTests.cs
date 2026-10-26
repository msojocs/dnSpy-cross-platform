using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.LanguageService;
using Xunit;

namespace dnSpy.Backend.Tests.LanguageService;

/// <summary>
/// Covers the Roslyn language service a C# or Visual Basic code editor runs on — the features of dnSpy's Edit Code
/// editor: semantic colors, completion with its images, colors, filters and tooltips, Quick Info, signature help from
/// Roslyn's providers, compiler messages, smart indentation and the words of the text structure navigator.
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
		Assert.Contains('(', list.CommitCharacters);

		var description = await service.GetCompletionDescriptionAsync(new CodeCompletionDescriptionRequest(id, list.ResultId, writeLine.Index), Token);
		Assert.Contains("Console.WriteLine", Text(description.Parts), StringComparison.Ordinal);
		Assert.Contains(description.Parts, p => p.Text == "WriteLine" && p.Color == TextColors.InstanceMethod);
	}

	[Fact]
	public async Task CompletionItemsHaveDnSpysImagesColorsAndFilters() {
		const string code = "using System.Collections.Generic; class C { int count; void M(int value) { } }";
		var id = Open(code);

		var list = (await service.GetCompletionAsync(new CodeCompletionRequest(id, At(code, "{ }", 2)), Token)).List;

		Assert.NotNull(list);
		var generic = list.Items.First(i => i.DisplayText == "List" && i.DisplayTextSuffix == "<>");
		Assert.Equal("ClassPublic", generic.Glyph);
		Assert.Equal([new TextPartDto("List", TextColors.Type), new TextPartDto("<>", TextColors.Punctuation)], generic.DisplayParts);
		var field = Assert.Single(list.Items, i => i.DisplayText == "count");
		Assert.Equal("FieldPrivate", field.Glyph);
		Assert.Equal([new TextPartDto("count", TextColors.InstanceField)], field.DisplayParts);
		var parameter = Assert.Single(list.Items, i => i.DisplayText == "value");
		Assert.Equal("LocalVariable", parameter.Glyph);
		Assert.Equal(TextColors.Parameter, Assert.Single(parameter.DisplayParts).Color);
		var keyword = Assert.Single(list.Items, i => i.DisplayText == "while" && i.Tags.Contains("Keyword"));
		Assert.Equal("IntellisenseKeyword", keyword.Glyph);
		// The buttons are those some item passes, in dnSpy's order.
		string[] expected = ["locals", "fields", "methods", "classes", "namespaces", "keywords"];
		Assert.Equal(expected, list.Filters.Intersect(expected));
		Assert.DoesNotContain("modules", list.Filters);
		// C#'s rules: Enter commits without a new line, and '(' commits the selected item.
		Assert.Equal("never", list.DefaultEnterKeyRule);
		Assert.Contains('(', list.CommitCharacters);
	}

	[Fact]
	public async Task ALetterOpensAListOnlyWhereRoslynWouldOpenOne() {
		const string code = "class C { void M() { S } }";
		var id = Open(code);

		var typed = (await service.GetCompletionAsync(new CodeCompletionRequest(id, At(code, "S }", 1), "S", "insertion"), Token)).List;
		var deleted = (await service.GetCompletionAsync(new CodeCompletionRequest(id, At(code, "S }", 1), "x", "deletion"), Token)).List;

		Assert.NotNull(typed);
		Assert.Contains(typed.Items, i => i.DisplayText == "System");
		// C# does not open a list on a deleted character.
		Assert.Null(deleted);
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
		// Roslyn's span starts with the invocation, not with its argument list.
		Assert.Equal(At(code, "Add(1, 2)"), help.ApplicableSpan.Start);
		Assert.Equal(1, help.SelectedParameter);
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
	public async Task SignatureHelpMarksOptionalParametersAndTheirDocumentation() {
		const string code = """
			class C {
				/// <param name="b">The second.</param>
				static void F(int a, int b = 2) { }
				void M() { F(1, b: 3); }
			}
			""";
		var id = Open(code);

		var help = (await service.GetSignatureHelpAsync(new CodeSignatureHelpRequest(id, At(code, "b: 3")), Token)).Help;

		Assert.NotNull(help);
		Assert.Equal("b", help.ArgumentName);
		Assert.Equal(1, help.SelectedParameter);
		var parameter = help.Items[help.SelectedItem].Parameters[1];
		Assert.True(parameter.IsOptional);
		Assert.Equal("int b = 2", Text(parameter.Display));
		Assert.Equal("The second.", Text(parameter.Documentation).Trim());
	}

	[Fact]
	public async Task ACharacterNoProviderTriggersOnStartsNoSession() {
		const string code = "class C { void M() { System.Console.WriteLine(1); } }";
		var opened = service.Open(new CodeDocumentOpenRequest(code));

		var typed = (await service.GetSignatureHelpAsync(new CodeSignatureHelpRequest(opened.DocumentId, At(code, "(1", 2), "1", "typeChar"), Token)).Help;
		var retriggered = (await service.GetSignatureHelpAsync(new CodeSignatureHelpRequest(opened.DocumentId, At(code, "(1", 2), null, "retrigger"), Token)).Help;

		Assert.Null(typed);
		Assert.NotNull(retriggered);
		Assert.Contains('(', opened.SignatureHelpTriggerCharacters);
		Assert.Contains(',', opened.SignatureHelpTriggerCharacters);
		Assert.Contains(')', opened.SignatureHelpRetriggerCharacters);
	}

	[Fact]
	public async Task SignatureHelpWorksAtTheEndOfAMemberBeingTypedAtTheEndOfTheFile() {
		// Typed a character at a time, with the completion lists in between that make Roslyn keep the body's
		// semantic model for the edits that follow.
		const string start = "class C { }\n";
		const string typed = "class D { void M(int count) { System.Console.WriteLine(";
		var id = Open(start);
		for (var i = 1; i <= typed.Length; i++) {
			var text = start + typed[..i];
			service.Update(new CodeDocumentUpdateRequest(id, text));
			if (char.IsLetter(typed[i - 1]) || typed[i - 1] == '.')
				await service.GetCompletionAsync(new CodeCompletionRequest(id, text.Length, typed[i - 1].ToString(), "insertion"), Token);
		}

		var help = (await service.GetSignatureHelpAsync(new CodeSignatureHelpRequest(id, (start + typed).Length, "(", "typeChar"), Token)).Help;

		Assert.NotNull(help);
		Assert.Contains(help.Items, item => Text(item.Prefix).Contains("WriteLine(", StringComparison.Ordinal));
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

	[Theory]
	// Ctrl+Right stops at the start of the next word, after the white space.
	[InlineData("class C { int value; }", "nextWord", 0, 6, 6)]
	[InlineData("class C { int value; }", "nextWord", 14, 19, 19)]
	// Ctrl+Left goes to the start of the word the caret is in or after.
	[InlineData("class C { int value; }", "previousWord", 19, 14, 14)]
	[InlineData("class C { int value; }", "previousWord", 14, 10, 10)]
	// A token is a word, however many of the editor's words it holds.
	[InlineData("class C { int value2_x; }", "currentWord", 16, 14, 22)]
	// The quotes of a string are words of their own; inside it, the editor's words.
	[InlineData("class C { string s = \"hello world\"; }", "currentWord", 21, 21, 22)]
	[InlineData("class C { string s = \"hello world\"; }", "currentWord", 29, 28, 33)]
	[InlineData("class C { string s = \"hello world\"; }", "currentWord", 33, 33, 34)]
	// A comment is one word from its start.
	[InlineData("class C { } // a comment", "currentWord", 12, 12, 24)]
	public async Task WordCommandsFollowRoslynsWords(string code, string command, int position, int start, int end) {
		var id = Open(code);

		var result = await service.GetWordNavigationAsync(new CodeWordNavigationRequest(id, command, position, position, position), Token);

		Assert.Equal((start, end), (result.Start, result.End));
	}

	[Fact]
	public async Task SelectingTheCurrentWordKeepsTheWordAlreadySelected() {
		const string code = "class C { int value; }";
		var id = Open(code);
		var value = At(code, "value");

		// The caret is after a selected word: the word, not the ';' after it.
		var result = await service.GetWordNavigationAsync(new CodeWordNavigationRequest(id, "currentWord", value + 5, value, value + 5), Token);
		// The caret is on white space after a word: the word.
		var afterWord = await service.GetWordNavigationAsync(new CodeWordNavigationRequest(id, "currentWord", At(code, "C {", 1), 0, 0), Token);

		Assert.Equal((value, value + 5), (result.Start, result.End));
		Assert.Equal((At(code, "C {"), At(code, "C {", 1)), (afterWord.Start, afterWord.End));
	}

	string OpenVisualBasic(string text) => service.Open(new CodeDocumentOpenRequest(text, Language: CompilerLanguages.VisualBasic)).DocumentId;

	[Fact]
	public async Task VisualBasicDocumentsHaveTheSameServices() {
		const string code = """
			Imports System
			Class C
				''' <summary>Runs it.</summary>
				Sub Run(count As Integer)
					Console.WriteLine(count)

				End Sub
			End Class
			""";
		var id = OpenVisualBasic(code);

		var spans = (await service.ClassifyAsync(new CodeDocumentRequest(id), Token)).Spans;
		Assert.Contains(spans, s => code.Substring(s.Start, s.Length) == "Class" && s.Color == TextColors.Keyword);
		Assert.Contains(spans, s => code.Substring(s.Start, s.Length) == "count" && s.Color == TextColors.Parameter);

		var list = (await service.GetCompletionAsync(new CodeCompletionRequest(id, At(code, "Console.", 8), ".", "insertion"), Token)).List;
		Assert.NotNull(list);
		Assert.Contains(list.Items, i => i.DisplayText == "WriteLine" && i.Glyph == "MethodPublic");
		// Visual Basic's rules: Enter commits and starts a new line.
		Assert.Equal("always", list.DefaultEnterKeyRule);

		var info = (await service.GetQuickInfoAsync(new CodePositionRequest(id, At(code, "Run(", 1)), Token)).QuickInfo;
		Assert.NotNull(info);
		Assert.Contains("Sub C.Run(count As Integer)", Text(Assert.Single(info.Sections, s => s.Kind == "Description").Parts), StringComparison.Ordinal);

		var help = (await service.GetSignatureHelpAsync(new CodeSignatureHelpRequest(id, At(code, "(count)", 1), "(", "typeChar"), Token)).Help;
		Assert.NotNull(help);
		Assert.True(help.Items.Count > 1);
		Assert.StartsWith("Console.WriteLine(", Text(help.Items[help.SelectedItem].Prefix), StringComparison.Ordinal);

		// The empty line in the Sub is indented one level past it.
		var indentation = await service.GetIndentationAsync(new CodeIndentationRequest(id, 5), Token);
		Assert.Equal(8, indentation.Indentation);
	}

	[Fact]
	public async Task VisualBasicDiagnosticsLinkToTheVisualBasicPages() {
		var id = OpenVisualBasic("Class C\n\tSub M()\n\t\tDim x As Integer = undefinedName\n\tEnd Sub\nEnd Class");

		var diagnostics = (await service.GetDiagnosticsAsync(new CodeDocumentRequest(id), Token)).Diagnostics;

		var diagnostic = Assert.Single(diagnostics, d => d.Severity == "error");
		Assert.Equal("BC30451", diagnostic.Id);
		Assert.Equal($"https://docs.microsoft.com/dotnet/visual-basic/misc/{diagnostic.Id.ToLowerInvariant()}", diagnostic.HelpUri);
	}

	[Fact]
	public async Task VisualBasicWordsKeepTheClosingQuoteApart() {
		const string code = "Class C\n\tDim s As String = \"ab\"\nEnd Class";
		var id = OpenVisualBasic(code);
		var closing = At(code, "\"\n");

		var result = await service.GetWordNavigationAsync(new CodeWordNavigationRequest(id, "currentWord", closing, closing, closing), Token);

		Assert.Equal((closing, closing + 1), (result.Start, result.End));
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
		var withSymbol = service.Open(new CodeDocumentOpenRequest(code, Settings: new CompilerSettingsDto(PreprocessorSymbols: "TRACE;DNSPY"))).DocumentId;
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
