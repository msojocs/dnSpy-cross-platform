namespace DebugTarget;

/// <summary>
/// Methods the evaluator tests call by reference: C# cannot call them through ICorDebug's func-eval, so they
/// exercise the reflection path the evaluator uses for ref/out arguments and for stack allocations.
/// </summary>
internal static class EvalHelpers {
	public static int Counter = 0;

	public static bool TryHalve(int value, out int half) {
		if (value % 2 != 0) {
			half = 0;
			return false;
		}
		half = value / 2;
		return true;
	}

	public static bool TryMakeText(out object value) {
		value = "made";
		return true;
	}

	public static bool TryMakeNumber(out object value) {
		value = 42;
		return true;
	}

	public static int Increment(ref int value) => ++value;

	public static bool ThrowsOut(out int value) {
		value = 0;
		throw new InvalidOperationException("out-boom");
	}

	public static bool TryGetNullable(bool hasValue, out int? value) {
		value = hasValue ? 5 : null;
		return true;
	}

	public static bool TryIncrementNullable(ref int? value) {
		value = (value ?? 0) + 1;
		return true;
	}

	public static bool TryEchoNullable(int? value, out int? echoed) {
		echoed = value;
		return true;
	}

	public static bool TryGetDefault<T>(out T value) {
		value = default!;
		return true;
	}

	public static int SumSpan(Span<int> values) {
		var sum = 0;
		foreach (var value in values)
			sum += value;
		return sum;
	}
}

/// <summary>A constructor with an out parameter: the reflection path also has to create objects.</summary>
internal sealed class EvalBox {
	public int Value { get; }

	public EvalBox(out int value) {
		value = 3;
		Value = value;
	}
}

/// <summary>A record struct: its Deconstruct is an instance method whose receiver is a value type.</summary>
internal readonly record struct PairStruct(int A, int B);
