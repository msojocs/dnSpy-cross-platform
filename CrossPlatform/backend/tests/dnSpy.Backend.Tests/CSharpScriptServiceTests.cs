using System.Text.Json;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// Covers the REPL semantics the C# Interactive window depends on: a value submission prints its
/// result, variables outlive the submission that declared them, failures come back as error entries
/// instead of exceptions, and only <c>#reset</c> throws the session away.
/// </summary>
public sealed class CSharpScriptServiceTests : IDisposable {
	readonly CSharpScriptService service = new();

	public void Dispose() => service.Dispose();

	[Fact]
	public async Task EvaluatesAnExpressionAndFormatsTheResult() {
		var response = await service.EvaluateAsync("1 + 1", TestContext.Current.CancellationToken);

		var result = Assert.Single(response.Entries);
		Assert.Equal(ScriptOutputEntry.Result, result.Kind);
		Assert.Equal("2\n", result.Text);
	}

	[Fact]
	public async Task VariablesOutliveTheSubmissionThatDeclaredThem() {
		var declaration = await service.EvaluateAsync("var x = 41;", TestContext.Current.CancellationToken);
		// A declaration has no value of its own, so nothing is printed for it.
		Assert.Empty(declaration.Entries);

		var use = await service.EvaluateAsync("x + 1", TestContext.Current.CancellationToken);

		var result = Assert.Single(use.Entries);
		Assert.Equal(ScriptOutputEntry.Result, result.Kind);
		Assert.Equal("42\n", result.Text);
	}

	[Fact]
	public async Task ASyntaxErrorComesBackAsAnErrorEntry() {
		var response = await service.EvaluateAsync("1 +", TestContext.Current.CancellationToken);

		var error = Assert.Single(response.Entries);
		Assert.Equal(ScriptOutputEntry.Error, error.Kind);
		Assert.Contains("CS", error.Text, StringComparison.Ordinal);
	}

	[Fact]
	public async Task ARuntimeExceptionComesBackAsAnErrorEntryWithItsStack() {
		var response = await service.EvaluateAsync("throw new InvalidOperationException(\"boom\");", TestContext.Current.CancellationToken);

		var error = Assert.Single(response.Entries);
		Assert.Equal(ScriptOutputEntry.Error, error.Kind);
		Assert.Contains("boom", error.Text, StringComparison.Ordinal);
	}

	[Fact]
	public async Task ConsoleOutputIsCapturedInsteadOfReachingTheHost() {
		var response = await service.EvaluateAsync("Console.WriteLine(\"hello\");", TestContext.Current.CancellationToken);

		var output = Assert.Single(response.Entries);
		Assert.Equal(ScriptOutputEntry.Output, output.Kind);
		Assert.Equal("hello\n", output.Text);
	}

	[Fact]
	public async Task ConsoleWriteWithoutANewlineStillReportsItsText() {
		var response = await service.EvaluateAsync("Console.Write(\"partial\");", TestContext.Current.CancellationToken);

		var output = Assert.Single(response.Entries);
		Assert.Equal(ScriptOutputEntry.Output, output.Kind);
		Assert.Equal("partial", output.Text);
	}

	[Fact]
	public async Task TheScriptGlobalsCanPrintWithoutQualifying() {
		var response = await service.EvaluateAsync("PrintLine(\"from globals\");", TestContext.Current.CancellationToken);

		var output = Assert.Single(response.Entries);
		Assert.Equal(ScriptOutputEntry.Output, output.Kind);
		Assert.Equal("from globals\n", output.Text);
	}

	[Fact]
	public async Task PreviousSubmissionsAreVisibleToLaterOnes() {
		await service.EvaluateAsync("PrintLine(\"first\");", TestContext.Current.CancellationToken);

		var response = await service.EvaluateAsync("PrintLine(\"second\");", TestContext.Current.CancellationToken);

		var output = Assert.Single(response.Entries);
		Assert.Equal("second\n", output.Text);
	}

	[Fact]
	public async Task ResetDropsTheSessionAndReportsTheBannerAgain() {
		await service.EvaluateAsync("var x = 1;", TestContext.Current.CancellationToken);

		var reset = await service.ResetAsync(showBanner: true, cancellationToken: TestContext.Current.CancellationToken);

		var banner = Assert.Single(reset.Entries);
		Assert.Equal(ScriptOutputEntry.Banner, banner.Kind);
		Assert.Contains("Roslyn", banner.Text, StringComparison.Ordinal);

		// The old variable is gone, which is the whole point of #reset.
		var afterReset = await service.EvaluateAsync("x + 1", TestContext.Current.CancellationToken);
		var error = Assert.Single(afterReset.Entries);
		Assert.Equal(ScriptOutputEntry.Error, error.Kind);
		Assert.Contains("x", error.Text, StringComparison.Ordinal);
	}

	[Fact]
	public async Task AFileLoadedByHashLoadRunsInsideTheSession() {
		// The source resolver is based in the host's directory, so the script has to name the file
		// the way the C# Interactive window's help text tells the user to: an absolute path.
		var path = Path.Combine(Path.GetTempPath(), $"dnspy-script-{Guid.NewGuid():N}.csx");
		await File.WriteAllTextAsync(path, "var loaded = 42;", TestContext.Current.CancellationToken);
		try {
			var load = await service.EvaluateAsync($"#load \"{path}\"", TestContext.Current.CancellationToken);
			Assert.Empty(load.Entries);

			var response = await service.EvaluateAsync("loaded + 1", TestContext.Current.CancellationToken);

			var result = Assert.Single(response.Entries);
			Assert.Equal(ScriptOutputEntry.Result, result.Kind);
			Assert.Equal("43\n", result.Text);
		}
		finally {
			File.Delete(path);
		}
	}

	[Fact]
	public async Task TheSessionSurvivesTheBannerOnlyResetBeforeAnySubmission() {
		await service.ResetAsync(cancellationToken: TestContext.Current.CancellationToken);

		var response = await service.EvaluateAsync("2 * 21", TestContext.Current.CancellationToken);

		var result = Assert.Single(response.Entries);
		Assert.Equal("42\n", result.Text);
	}

	/// <summary>The colors the input gets, as (text, color) pairs, so a test reads like the code it colors.</summary>
	static (string Text, string Color)[] Colors(string code, ClassifyResponse response) =>
		response.Spans.Select(span => (code.Substring(span.Start, span.Length), span.Color)).ToArray();

	[Fact]
	public async Task InputIsColoredTheWayTheWpfWindowColorsIt() {
		const string code = "Console.WriteLine(\"a\" + 1); // done";
		var colors = Colors(code, await service.ClassifyAsync(code, TestContext.Current.CancellationToken));

		Assert.Contains(("Console", TextColors.StaticType), colors);
		Assert.Contains(("WriteLine", TextColors.StaticMethod), colors);
		Assert.Contains(("\"a\"", TextColors.String), colors);
		Assert.Contains(("1", TextColors.Number), colors);
		Assert.Contains(("+", TextColors.Operator), colors);
		Assert.Contains(("(", TextColors.Punctuation), colors);
		Assert.Contains(("// done", TextColors.Comment), colors);
	}

	[Fact]
	public async Task ANameThatBindsToNothingIsColoredAsAnError() {
		const string code = "undefinedName.Foo()";
		var colors = Colors(code, await service.ClassifyAsync(code, TestContext.Current.CancellationToken));

		Assert.Contains(("undefinedName", TextColors.Error), colors);
	}

	[Fact]
	public async Task AVariableAnEarlierSubmissionDeclaredIsColoredAsALocal() {
		await service.EvaluateAsync("var counter = 1; static int Twice(int value) => value * 2;", TestContext.Current.CancellationToken);

		const string code = "Twice(counter)";
		var colors = Colors(code, await service.ClassifyAsync(code, TestContext.Current.CancellationToken));

		Assert.Contains(("counter", TextColors.Local), colors);
		Assert.Contains(("Twice", TextColors.StaticMethod), colors);
	}

	[Fact]
	public async Task ClassifyingDoesNotRunTheInput() {
		await service.ClassifyAsync("var never = 1;", TestContext.Current.CancellationToken);

		var response = await service.EvaluateAsync("never", TestContext.Current.CancellationToken);

		var error = Assert.Single(response.Entries);
		Assert.Equal(ScriptOutputEntry.Error, error.Kind);
		Assert.Contains("CS0103", error.Text, StringComparison.Ordinal);
	}

	[Fact]
	public async Task EmptyInputHasNoColors() {
		var response = await service.ClassifyAsync(string.Empty, TestContext.Current.CancellationToken);

		Assert.Empty(response.Spans);
	}

	[Fact]
	public async Task PrintLeavesALineOpenForTheNextPrint() {
		var response = await service.EvaluateAsync("Print(\"a\"); Print(TextColor.Keyword, \"b\"); PrintLine();", TestContext.Current.CancellationToken);

		Assert.Equal("ab" + Environment.NewLine, string.Concat(response.Entries.Select(entry => entry.Text)));
		Assert.Equal(TextColors.Keyword, response.Entries[1].Color);
	}

	[Fact]
	public async Task PrintTakesFormatStringsAndValues() {
		var formatted = await service.EvaluateAsync("PrintLine(\"{0}+{1}\", 1, 2);", TestContext.Current.CancellationToken);
		Assert.Equal("1+2" + Environment.NewLine, Assert.Single(formatted.Entries).Text);

		var value = await service.EvaluateAsync("PrintLine(new[] { 1, 2 });", TestContext.Current.CancellationToken);
		Assert.Equal("int[2] { 1, 2 }" + Environment.NewLine, Assert.Single(value.Entries).Text);
	}

	[Fact]
	public async Task PrintErrorAndPrintLineErrorUseTheErrorColor() {
		var response = await service.EvaluateAsync("PrintError(\"bad\"); PrintLineError(\"worse\");", TestContext.Current.CancellationToken);

		Assert.All(response.Entries, entry => Assert.Equal(TextColors.Error, entry.Color));
		Assert.Equal("badworse" + Environment.NewLine, string.Concat(response.Entries.Select(entry => entry.Text)));
	}

	[Fact]
	public async Task PrintOptionsDecideHowValuesAreFormatted() {
		var radix = await service.EvaluateAsync("PrintOptions.NumberRadix = 16; PrintLine(42);", TestContext.Current.CancellationToken);
		Assert.Equal("0x0000002a" + Environment.NewLine, Assert.Single(radix.Entries).Text);

		var hidden = await service.EvaluateAsync("PrintOptions.MemberDisplayFormat = MemberDisplayFormat.Hidden; PrintLine(new System.Collections.Generic.List<int> { 1 });", TestContext.Current.CancellationToken);
		Assert.DoesNotContain("Count", Assert.Single(hidden.Entries).Text, StringComparison.Ordinal);
	}

	[Fact]
	public async Task PrintOptionsCapTheOutputLength() {
		var response = await service.EvaluateAsync("PrintOptions.MaximumOutputLength = 10; PrintLine(Enumerable.Range(0, 100).ToList());", TestContext.Current.CancellationToken);

		var text = Assert.Single(response.Entries).Text;
		Assert.Contains("…", text, StringComparison.Ordinal);
		Assert.DoesNotContain("99", text, StringComparison.Ordinal);
	}

	[Fact]
	public async Task ACachedWriterFlushesItsColoredTextAtOnce() {
		var response = await service.EvaluateAsync("""
			using (var writer = CreateWriter()) {
				writer.Print(TextColor.Keyword, "a");
				writer.PrintLine("b");
			}
			""", TestContext.Current.CancellationToken);

		Assert.Equal("ab" + Environment.NewLine, string.Concat(response.Entries.Select(entry => entry.Text)));
		Assert.Equal(TextColors.Keyword, response.Entries[0].Color);
	}

	[Fact]
	public async Task ACachedWriterIsAnOutputWriterAndPrintsErrorsLikeTheGlobals() {
		var response = await service.EvaluateAsync("""
			using (var writer = CreateWriter()) {
				writer.Write("a", TextColor.StaticType);
				writer.PrintError("b");
				writer.PrintLineError("c");
			}
			""", TestContext.Current.CancellationToken);

		Assert.Equal("abc" + Environment.NewLine, string.Concat(response.Entries.Select(entry => entry.Text)));
		Assert.Equal(TextColors.StaticType, response.Entries[0].Color);
		Assert.All(response.Entries.Skip(1), entry => Assert.Equal(TextColors.Error, entry.Color));
	}

	[Fact]
	public async Task ACachedWriterKeepsThePrintOptionsItWasCreatedWith() {
		// dnSpy's CachedWriter clones the globals' options when a script asks for it; changing them while the
		// writer is open must not change how the values it already formats are written.
		var response = await service.EvaluateAsync("""
			using (var writer = CreateWriter()) {
				PrintOptions.NumberRadix = 16;
				writer.PrintLine(42);
			}
			""", TestContext.Current.CancellationToken);

		Assert.Equal(42 + Environment.NewLine, Assert.Single(response.Entries).Text);
	}

	[Theory]
	[InlineData("1 + 1", true)]
	[InlineData("if (true) {", false)]
	[InlineData("var x = 1;", true)]
	[InlineData("class C {", false)]
	[InlineData("#help", true)]
	public void CompletenessIsTheWpfWindowsIsCompleteSubmission(string code, bool expected) =>
		Assert.Equal(expected, CSharpScriptService.IsCompleteSubmission(code));

	[Fact]
	public async Task ResetDoesNotPrintTheEngineBannerByDefault() {
		var reset = await service.ResetAsync(cancellationToken: TestContext.Current.CancellationToken);

		Assert.Empty(reset.Entries);
	}

	[Fact]
	public async Task TheResponseFileSuppliesImportsAndIsAnnounced() {
		var directory = Directory.CreateTempSubdirectory("dnspy-rsp-");
		try {
			await File.WriteAllTextAsync(Path.Combine(directory.FullName, "CSharpInteractive.rsp"), "/u:System.Text.RegularExpressions\n", TestContext.Current.CancellationToken);
			using var configured = new CSharpScriptService(null, new ScriptServiceOptions { ResponseFileDirectories = [directory.FullName] });

			var reset = await configured.ResetAsync(showBanner: true, cancellationToken: TestContext.Current.CancellationToken);
			Assert.Contains(reset.Entries, entry => entry.Text.Contains("Loading context from 'CSharpInteractive.rsp'.", StringComparison.Ordinal));
			Assert.Contains(reset.Entries, entry => entry.Kind == ScriptOutputEntry.Banner);

			var response = await configured.EvaluateAsync("Regex.IsMatch(\"a\", \"a\")", TestContext.Current.CancellationToken);
			Assert.Equal("true" + Environment.NewLine, Assert.Single(response.Entries).Text);
		}
		finally {
			directory.Delete(recursive: true);
		}
	}

	[Fact]
	public async Task ResetNoConfigStartsTheEngineWithoutTheResponseFile() {
		var directory = Directory.CreateTempSubdirectory("dnspy-rsp-");
		try {
			await File.WriteAllTextAsync(Path.Combine(directory.FullName, "CSharpInteractive.rsp"), "/u:System.Text.RegularExpressions\n", TestContext.Current.CancellationToken);
			using var configured = new CSharpScriptService(null, new ScriptServiceOptions { ResponseFileDirectories = [directory.FullName] });

			await configured.ResetAsync(loadConfig: false, cancellationToken: TestContext.Current.CancellationToken);
			var response = await configured.EvaluateAsync("Regex.IsMatch(\"a\", \"a\")", TestContext.Current.CancellationToken);

			Assert.Equal(ScriptOutputEntry.Error, Assert.Single(response.Entries).Kind);
		}
		finally {
			directory.Delete(recursive: true);
		}
	}

	[Fact]
	public async Task HashRAndHashLoadResolveAgainstTheSearchPaths() {
		var directory = Directory.CreateTempSubdirectory("dnspy-scripts-");
		try {
			CreateLibrary(directory.FullName, "namespace ScriptTestLib { public static class Value { public const int Answer = 42; } }");
			await File.WriteAllTextAsync(Path.Combine(directory.FullName, "loaded.csx"), "var loaded = 41;", TestContext.Current.CancellationToken);
			using var configured = new CSharpScriptService(null, new ScriptServiceOptions { ResponseFileDirectories = [], SearchPaths = [directory.FullName] });

			await configured.EvaluateAsync("#r \"ScriptTestLib.dll\"", TestContext.Current.CancellationToken);
			var reference = await configured.EvaluateAsync("ScriptTestLib.Value.Answer", TestContext.Current.CancellationToken);
			Assert.Equal("42" + Environment.NewLine, Assert.Single(reference.Entries).Text);

			await configured.EvaluateAsync("#load \"loaded.csx\"", TestContext.Current.CancellationToken);
			var loaded = await configured.EvaluateAsync("loaded + 1", TestContext.Current.CancellationToken);
			Assert.Equal("42" + Environment.NewLine, Assert.Single(loaded.Entries).Text);
		}
		finally {
			directory.Delete(recursive: true);
		}
	}

	[Fact]
	public async Task ResolveFindsTheServicesTheHostRegistered() {
		using var configured = new CSharpScriptService();
		configured.Services.Register(new ScriptPrintOptions { NumberRadix = 16 });

		var response = await configured.EvaluateAsync("Resolve<ScriptPrintOptions>().NumberRadix", TestContext.Current.CancellationToken);

		Assert.Equal("16" + Environment.NewLine, Assert.Single(response.Entries).Text);
	}

	[Fact]
	public async Task MessageBoxesAndInputBoxesReachTheClient() {
		var client = new RecordingClient {
			Answer = (method, _) => method switch {
				"script/messageBox" => Json("{\"button\":\"yes\"}"),
				_ => Json("{\"text\":\"42\"}"),
			},
		};
		using var configured = new CSharpScriptService(client);

		await configured.EvaluateAsync("PrintLine(ShowYesNo(\"ok?\").ToString()); PrintLine(Ask<int>(\"Number\"));", TestContext.Current.CancellationToken);

		Assert.Equal("Yes" + Environment.NewLine + "42" + Environment.NewLine, client.Text());
		Assert.Equal(["script/messageBox", "script/ask"], client.Requests.Select(request => request.Method));
	}

	[Fact]
	public async Task AskKeepsAskingUntilTheAnswerIsValid() {
		var answerCount = 0;
		var client = new RecordingClient {
			Answer = (method, _) => method == "script/ask" && answerCount++ == 0
				? Json("{\"text\":\"not a number\"}")
				: Json("{\"text\":\"7\"}"),
		};
		using var configured = new CSharpScriptService(client);

		await configured.EvaluateAsync("PrintLine(Ask<int>(\"Number\"));", TestContext.Current.CancellationToken);

		Assert.Equal("7" + Environment.NewLine, client.Text());
		Assert.Equal(2, client.Requests.Count);
		Assert.Contains("error", client.Requests[1].Parameters.GetRawText(), StringComparison.Ordinal);
	}

	[Fact]
	public async Task TheHostStreamsLinesWhileTheScriptStillRuns() {
		var client = new RecordingClient();
		using var configured = new CSharpScriptService(client);

		var evaluation = configured.EvaluateAsync("PrintLine(\"one\"); await System.Threading.Tasks.Task.Delay(300); PrintLine(\"two\");", TestContext.Current.CancellationToken);
		await WaitUntilAsync(() => client.Text().Contains("one" + Environment.NewLine, StringComparison.Ordinal));
		Assert.False(evaluation.IsCompleted);

		await evaluation;
		Assert.Contains("two" + Environment.NewLine, client.Text(), StringComparison.Ordinal);
	}

	[Fact]
	public async Task ResetDoesNotWaitForAScriptThatNeverEnds() {
		var client = new RecordingClient();
		using var configured = new CSharpScriptService(client);

		// The sleep runs on a pool thread that does not observe the token, so the old script really is still
		// alive when the reset answers — the case a reset that waited for the engine used to hang on.
		var stuck = configured.EvaluateAsync("PrintLine(\"started\"); await System.Threading.Tasks.Task.Run(() => { System.Threading.Thread.Sleep(1200); PrintLine(\"late\"); });", TestContext.Current.CancellationToken);
		await WaitUntilAsync(() => client.Text().Contains("started" + Environment.NewLine, StringComparison.Ordinal));

		// The reset has to answer while the old script is still sleeping, and the new engine has to run.
		var reset = await configured.ResetAsync(showBanner: true, cancellationToken: TestContext.Current.CancellationToken).WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
		Assert.Contains(reset.Entries, entry => entry.Kind == ScriptOutputEntry.Banner);
		var evaluation = await configured.EvaluateAsync("1 + 1", TestContext.Current.CancellationToken).WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
		await WaitUntilAsync(() => client.Entries.Any(entry => entry.Generation == evaluation.Generation && entry.Entry.Text == "2" + Environment.NewLine));

		// The old engine's late line belongs to the session the reset replaced and never reaches the new one.
		await Task.Delay(1400, TestContext.Current.CancellationToken);
		Assert.DoesNotContain(client.Entries, entry => entry.Generation == evaluation.Generation && entry.Entry.Text.Contains("late", StringComparison.Ordinal));
		await stuck;
	}

	[Fact]
	public async Task TheResettingEventLetsTheScriptUnregister() {
		var client = new RecordingClient();
		using var configured = new CSharpScriptService(client);

		await configured.EvaluateAsync("ScriptResetting += (sender, args) => PrintLine(\"resetting\"); PrintLine(\"ready\");", TestContext.Current.CancellationToken);
		await configured.ResetAsync(showBanner: true, cancellationToken: TestContext.Current.CancellationToken);

		var lines = string.Concat(client.Entries.Select(entry => entry.Entry.Text));
		Assert.Contains("resetting" + Environment.NewLine, lines, StringComparison.Ordinal);
	}

	static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement.Clone();

	static async Task WaitUntilAsync(Func<bool> condition) {
		for (int i = 0; i < 200 && !condition(); i++)
			await Task.Delay(25, TestContext.Current.CancellationToken);
		Assert.True(condition());
	}

	static void CreateLibrary(string directory, string source) {
		var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
			.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
			.Select(path => MetadataReference.CreateFromFile(path));
		var compilation = CSharpCompilation.Create("ScriptTestLib", [CSharpSyntaxTree.ParseText(source)], references,
			new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
		var result = compilation.Emit(Path.Combine(directory, "ScriptTestLib.dll"));
		Assert.True(result.Success);
	}

	/// <summary>A client that records what the window would see, and answers the boxes a script opens.</summary>
	sealed class RecordingClient : IScriptClient {
		readonly object gate = new();

		public List<(int Generation, ScriptOutputEntry Entry)> Entries { get; } = [];
		public List<(string Method, JsonElement Parameters)> Requests { get; } = [];
		public Func<string, JsonElement, JsonElement?>? Answer { get; set; }

		public void WriteOutput(int generation, ScriptOutputEntry entry) {
			lock (gate)
				Entries.Add((generation, entry));
		}

		public Task<JsonElement?> RequestAsync(string method, JsonElement parameters, CancellationToken cancellationToken) {
			lock (gate)
				Requests.Add((method, parameters.Clone()));
			return Task.FromResult(Answer?.Invoke(method, parameters));
		}

		public string Text() {
			lock (gate)
				return string.Concat(Entries.Select(entry => entry.Entry.Text));
		}
	}
}
