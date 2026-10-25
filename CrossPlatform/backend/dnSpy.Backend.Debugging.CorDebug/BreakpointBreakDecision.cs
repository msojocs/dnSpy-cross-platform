using System.Globalization;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>What checking a hit decided: whether to stop, and what to tell the user.</summary>
public readonly record struct BreakpointDecision(
	bool ShouldBreak,
	string? TraceMessage = null,
	string? ErrorMessage = null,
	bool HitCountChanged = false);

/// <summary>Everything checking a hit needs from the stopped debuggee.</summary>
public interface IBreakpointHitRuntime {
	/// <summary>The five names a filter knows: machine, process and thread.</summary>
	IBreakpointScope FilterScope { get; }

	/// <summary>The stopped frame's arguments and locals, which a condition reads.</summary>
	IBreakpointScope ConditionScope { get; }

	string RenderTrace(TracepointMessage message);

	/// <summary>
	/// The debugger's own expression evaluator, when the runtime has one: a condition is then any expression
	/// the language allows — member access, calls — rather than the subset <see cref="ConditionScope"/> reads.
	/// Null means the subset is all there is.
	/// </summary>
	Task<BreakpointValue>? EvaluateConditionAsync(string expression) => null;

	/// <summary>A tracepoint message whose <c>{expressions}</c> go through the expression evaluator.</summary>
	Task<string>? RenderTraceAsync(TracepointMessage message) => null;

	/// <summary>
	/// The debugger's filter evaluator, when the runtime has one: a filter is then any C# expression over
	/// the five values, not the subset <see cref="FilterScope"/> reads. Null means the subset is all there is.
	/// </summary>
	Task<bool>? EvaluateFilterAsync(string expression) => null;
}

/// <summary>A condition or a tracepoint expression the evaluator could not run.</summary>
public sealed class BreakpointEvaluationException(string message) : Exception(message);

/// <summary>
/// Decides whether a hit stops the debuggee, which is the port of WPF's
/// <c>BreakpointBreakChecker.ShouldBreak</c>.
/// </summary>
/// <remarks>
/// The order is WPF's and matters: the filter and the condition are gates that a failing hit does not
/// get counted by, the hit count is then raised unconditionally, and only after that does the hit
/// count itself decide. An error anywhere breaks rather than skips — a mistyped condition should be
/// noticed, not silently turn the breakpoint off.
/// <para>
/// Nothing here touches the runtime directly: the state is a plain object and the debuggee arrives as
/// an interface, so the whole decision is testable without a live process.
/// </para>
/// </remarks>
public static class BreakpointBreakDecision {
	public static BreakpointDecision Evaluate(bool enabled, BreakpointSettings settings, BreakpointHitState state, IBreakpointHitRuntime runtime) {
		if (!enabled)
			return new BreakpointDecision(false);

		if (settings.Filter is { Length: > 0 } filter) {
			try {
				if (!BreakpointExpression.ParseCached(filter).EvaluateAsBoolean(runtime.FilterScope))
					return new BreakpointDecision(false);
			}
			catch (BreakpointExpressionException ex) {
				return new BreakpointDecision(true, ErrorMessage: $"Breakpoint filter '{filter}': {ex.Message}");
			}
		}

		if (settings.Condition is { } condition) {
			try {
				if (!CheckCondition(condition, state, runtime))
					return new BreakpointDecision(false);
			}
			catch (BreakpointExpressionException ex) {
				return new BreakpointDecision(true, ErrorMessage: $"Breakpoint condition '{condition.Expression}': {ex.Message}");
			}
		}

		// This counts as a hit even when there is no hit count option, which is what makes the count
		// the pane shows mean "times this breakpoint was reached and wanted".
		state.HitCount++;

		if (settings.HitCount is { } hitCount) {
			var (matches, error) = CheckHitCount(hitCount, state.HitCount);
			if (error is not null)
				return new BreakpointDecision(true, ErrorMessage: error, HitCountChanged: true);
			if (!matches)
				return new BreakpointDecision(false, HitCountChanged: true);
		}

		if (settings.Trace is { } trace) {
			string message;
			try {
				message = runtime.RenderTrace(TracepointMessage.Parse(trace.Message));
			}
			catch (BreakpointExpressionException ex) {
				return new BreakpointDecision(true, ErrorMessage: $"Tracepoint message: {ex.Message}", HitCountChanged: true);
			}
			// Continue means print and keep running: the tracepoint never becomes a stop.
			return new BreakpointDecision(!trace.Continue, TraceMessage: message, HitCountChanged: true);
		}

		return new BreakpointDecision(true, HitCountChanged: true);
	}

	static bool CheckCondition(BreakpointCondition condition, BreakpointHitState state, IBreakpointHitRuntime runtime) {
		var expression = BreakpointExpression.ParseCached(condition.Expression);
		if (condition.Kind == BreakpointConditionKind.IsTrue)
			return expression.EvaluateAsBoolean(runtime.ConditionScope);

		var value = expression.Evaluate(runtime.ConditionScope).Describe();
		return RecordChange(state, value);
	}

	/// <summary>
	/// "When changed": the first hit has nothing to compare against, so it records the value and lets the
	/// program run on — the same answer WPF gives when its saved value is still null.
	/// </summary>
	static bool RecordChange(BreakpointHitState state, string value) {
		var changed = state.HasConditionValue && !string.Equals(state.LastConditionValue, value, StringComparison.Ordinal);
		state.LastConditionValue = value;
		state.HasConditionValue = true;
		return changed;
	}

	/// <summary>
	/// The same decision with the condition and the tracepoint's expressions run by the debugger's expression
	/// evaluator, which may call into the debuggee and so has to wait for it. The order and the error rules are
	/// <see cref="Evaluate"/>'s.
	/// </summary>
	public static async Task<BreakpointDecision> EvaluateAsync(bool enabled, BreakpointSettings settings, BreakpointHitState state, IBreakpointHitRuntime runtime) {
		if (!enabled)
			return new BreakpointDecision(false);

		if (settings.Filter is { Length: > 0 } filter) {
			try {
				var evaluation = runtime.EvaluateFilterAsync(filter);
				var pass = evaluation is null
					? BreakpointExpression.ParseCached(filter).EvaluateAsBoolean(runtime.FilterScope)
					: await evaluation.ConfigureAwait(false);
				if (!pass)
					return new BreakpointDecision(false);
			}
			catch (Exception ex) when (ex is BreakpointExpressionException or BreakpointEvaluationException) {
				return new BreakpointDecision(true, ErrorMessage: $"Breakpoint filter '{filter}': {ex.Message}");
			}
		}

		if (settings.Condition is { } condition) {
			try {
				var evaluation = runtime.EvaluateConditionAsync(condition.Expression);
				bool pass;
				if (evaluation is null)
					pass = CheckCondition(condition, state, runtime);
				else {
					var value = await evaluation.ConfigureAwait(false);
					pass = condition.Kind == BreakpointConditionKind.IsTrue
						? value.Kind == BreakpointValueKind.Bool ? value.Bool : throw new BreakpointEvaluationException("The condition is not a boolean expression.")
						: RecordChange(state, value.Describe());
				}
				if (!pass)
					return new BreakpointDecision(false);
			}
			catch (Exception ex) when (ex is BreakpointExpressionException or BreakpointEvaluationException) {
				return new BreakpointDecision(true, ErrorMessage: $"Breakpoint condition '{condition.Expression}': {ex.Message}");
			}
		}

		state.HitCount++;

		if (settings.HitCount is { } hitCount) {
			var (matches, error) = CheckHitCount(hitCount, state.HitCount);
			if (error is not null)
				return new BreakpointDecision(true, ErrorMessage: error, HitCountChanged: true);
			if (!matches)
				return new BreakpointDecision(false, HitCountChanged: true);
		}

		if (settings.Trace is { } trace) {
			string message;
			try {
				var parsed = TracepointMessage.Parse(trace.Message);
				message = runtime.RenderTraceAsync(parsed) is { } rendering ? await rendering.ConfigureAwait(false) : runtime.RenderTrace(parsed);
			}
			catch (Exception ex) when (ex is BreakpointExpressionException or BreakpointEvaluationException) {
				return new BreakpointDecision(true, ErrorMessage: $"Tracepoint message: {ex.Message}", HitCountChanged: true);
			}
			return new BreakpointDecision(!trace.Continue, TraceMessage: message, HitCountChanged: true);
		}

		return new BreakpointDecision(true, HitCountChanged: true);
	}

	static (bool Matches, string? Error) CheckHitCount(BreakpointHitCount hitCount, int current) => hitCount.Kind switch {
		BreakpointHitCountKind.Equals => (current == hitCount.Count, null),
		BreakpointHitCountKind.MultipleOf => hitCount.Count <= 0
			? (false, $"Invalid hit count value: {hitCount.Count.ToString(CultureInfo.InvariantCulture)}")
			: (current % hitCount.Count == 0, null),
		BreakpointHitCountKind.GreaterThanOrEquals => (current >= hitCount.Count, null),
		_ => (false, $"Unknown hit count kind: {hitCount.Kind}"),
	};
}
