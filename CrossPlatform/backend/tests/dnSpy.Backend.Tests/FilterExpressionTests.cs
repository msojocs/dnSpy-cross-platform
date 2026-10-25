using dnSpy.Backend.Debugging.CorDebug;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The breakpoint filter's C#: dnSpy's Roslyn filter evaluator accepts any expression over the five
/// values, so the port compiles the same text instead of the old comparison-only subset.
/// </summary>
public sealed class FilterExpressionTests {
	[Fact]
	public void AcceptsTheExpressionsTheRoslynEvaluatorAccepts() {
		Assert.Null(FilterExpression.Validate("ProcessName.Contains(\".Tests\")"));
		Assert.Null(FilterExpression.Validate("MachineName.StartsWith(\"dev\") && ThreadId != 0"));
		Assert.Null(FilterExpression.Validate("ProcessId == 1234 || ThreadName == \"Main Thread\""));
	}

	[Fact]
	public void RejectsTextThatIsNotCSharp() {
		Assert.NotNull(FilterExpression.Validate("ProcessName."));
		Assert.NotNull(FilterExpression.Validate("Nope == 1"));
		Assert.NotNull(FilterExpression.Validate("ProcessName.Contains("));
	}

	[Fact]
	public void EvaluatesAgainstTheFiveFilterValues() {
		Assert.True(FilterExpression.Evaluate("ProcessName.Contains(\"app\")", "machine", 5, "/tmp/app.exe", 7, "Main Thread"));
		Assert.False(FilterExpression.Evaluate("ProcessName.StartsWith(\"dev\")", "machine", 5, "/tmp/app.exe", 7, "Main Thread"));
		Assert.True(FilterExpression.Evaluate("ProcessId == 5 && ThreadId == 7 && ThreadName == \"Main Thread\"", "machine", 5, "/tmp/app.exe", 7, "Main Thread"));
		Assert.True(FilterExpression.Evaluate("MachineName.Length > 0", "machine", 5, "/tmp/app.exe", 7, null));
	}

	[Fact]
	public void AnExpressionThatIsNotABooleanOrThatThrowsIsAnError() {
		Assert.Throws<BreakpointEvaluationException>(() => FilterExpression.Evaluate("ProcessId + 1", "machine", 5, "/tmp/app.exe", 7, null));
		Assert.Throws<BreakpointEvaluationException>(() => FilterExpression.Evaluate("ProcessName.Substring(100) == \"x\"", "machine", 5, "/tmp/app.exe", 7, null));
	}

	[Fact]
	public void TheSettingsDialogCheckUsesTheSameCompiler() {
		Assert.Null(CorDebugSessionManager.VerifyFilterExpression("ProcessName.Contains(\".Tests\")"));
		Assert.NotNull(CorDebugSessionManager.VerifyFilterExpression("ProcessName.Contains("));
	}
}
