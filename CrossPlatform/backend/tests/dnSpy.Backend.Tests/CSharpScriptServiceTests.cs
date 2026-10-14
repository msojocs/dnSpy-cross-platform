using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
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
		Assert.Equal("2", result.Text);
	}

	[Fact]
	public async Task VariablesOutliveTheSubmissionThatDeclaredThem() {
		var declaration = await service.EvaluateAsync("var x = 41;", TestContext.Current.CancellationToken);
		// A declaration has no value of its own, so nothing is printed for it.
		Assert.Empty(declaration.Entries);

		var use = await service.EvaluateAsync("x + 1", TestContext.Current.CancellationToken);

		var result = Assert.Single(use.Entries);
		Assert.Equal(ScriptOutputEntry.Result, result.Kind);
		Assert.Equal("42", result.Text);
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
		Assert.Equal("hello", output.Text);
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
		Assert.Equal("from globals", output.Text);
	}

	[Fact]
	public async Task PreviousSubmissionsAreVisibleToLaterOnes() {
		await service.EvaluateAsync("PrintLine(\"first\");", TestContext.Current.CancellationToken);

		var response = await service.EvaluateAsync("PrintLine(\"second\");", TestContext.Current.CancellationToken);

		var output = Assert.Single(response.Entries);
		Assert.Equal("second", output.Text);
	}

	[Fact]
	public async Task ResetDropsTheSessionAndReportsTheBannerAgain() {
		await service.EvaluateAsync("var x = 1;", TestContext.Current.CancellationToken);

		var reset = await service.ResetAsync();

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
			Assert.Equal("43", result.Text);
		}
		finally {
			File.Delete(path);
		}
	}

	[Fact]
	public async Task TheSessionSurvivesTheBannerOnlyResetBeforeAnySubmission() {
		await service.ResetAsync();

		var response = await service.EvaluateAsync("2 * 21", TestContext.Current.CancellationToken);

		var result = Assert.Single(response.Entries);
		Assert.Equal("42", result.Text);
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
}
