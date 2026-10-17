using System.Globalization;
using System.Numerics;

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace dnSpy.Backend.Debugging.CorDebug.Evaluation;

/// <summary>
/// .NET arithmetic with the compiler's semantics: the conversions a cast performs, checked or not, and the
/// built-in operators of the numeric types, booleans, characters and strings. Operands arrive already
/// converted to the operator's type — the bound tree carries those conversions — so each operator only has
/// to know the one type it works on.
/// </summary>
internal static class Arithmetic {
	public static bool IsIntegral(object value) => value is sbyte or byte or short or ushort or int or uint or long or ulong or char or nint or nuint;

	static Int128 ToInt128(object value) => value switch {
		sbyte v => v,
		byte v => v,
		short v => v,
		ushort v => v,
		int v => v,
		uint v => v,
		long v => v,
		ulong v => v,
		char v => v,
		nint v => v,
		nuint v => v,
		bool v => v ? 1 : 0,
		_ => throw new EvaluationException("The value is not an integer."),
	};

	/// <summary>A numeric conversion, the way a cast performs it.</summary>
	public static object Convert(object value, SpecialType target, bool isChecked, bool roundToEven = false) {
		try {
			switch (value) {
				case double d:
					return FromDouble(roundToEven && IsIntegralType(target) ? Math.Round(d, MidpointRounding.ToEven) : d, target, isChecked);
				case float f:
					return target == SpecialType.System_Single ? f : FromDouble(roundToEven && IsIntegralType(target) ? Math.Round(f, MidpointRounding.ToEven) : f, target, isChecked);
				case decimal m:
					return FromDecimal(roundToEven && IsIntegralType(target) ? Math.Round(m, MidpointRounding.ToEven) : m, target);
				default:
					return FromInteger(ToInt128(value), target, isChecked);
			}
		}
		catch (OverflowException) {
			throw new EvaluationException("Arithmetic operation resulted in an overflow.");
		}
	}

	static bool IsIntegralType(SpecialType type) => type is SpecialType.System_SByte or SpecialType.System_Byte or SpecialType.System_Int16 or SpecialType.System_UInt16
		or SpecialType.System_Int32 or SpecialType.System_UInt32 or SpecialType.System_Int64 or SpecialType.System_UInt64 or SpecialType.System_Char
		or SpecialType.System_IntPtr or SpecialType.System_UIntPtr;

	static object FromInteger(Int128 value, SpecialType target, bool isChecked) => target switch {
		SpecialType.System_SByte => isChecked ? checked((sbyte)value) : unchecked((sbyte)value),
		SpecialType.System_Byte => isChecked ? checked((byte)value) : unchecked((byte)value),
		SpecialType.System_Int16 => isChecked ? checked((short)value) : unchecked((short)value),
		SpecialType.System_UInt16 => isChecked ? checked((ushort)value) : unchecked((ushort)value),
		SpecialType.System_Int32 => isChecked ? checked((int)value) : unchecked((int)value),
		SpecialType.System_UInt32 => isChecked ? checked((uint)value) : unchecked((uint)value),
		SpecialType.System_Int64 => isChecked ? checked((long)value) : unchecked((long)value),
		SpecialType.System_UInt64 => isChecked ? checked((ulong)value) : unchecked((ulong)value),
		SpecialType.System_Char => isChecked ? checked((char)value) : unchecked((char)value),
		SpecialType.System_IntPtr => isChecked ? checked((nint)(long)value) : unchecked((nint)(long)value),
		SpecialType.System_UIntPtr => isChecked ? checked((nuint)(ulong)value) : unchecked((nuint)(ulong)value),
		SpecialType.System_Single => (float)value,
		SpecialType.System_Double => (double)value,
		SpecialType.System_Decimal => (decimal)value,
		SpecialType.System_Boolean => value != 0,
		_ => throw new EvaluationException("Unsupported numeric conversion."),
	};

	static object FromDouble(double value, SpecialType target, bool isChecked) => target switch {
		SpecialType.System_SByte => isChecked ? checked((sbyte)value) : unchecked((sbyte)value),
		SpecialType.System_Byte => isChecked ? checked((byte)value) : unchecked((byte)value),
		SpecialType.System_Int16 => isChecked ? checked((short)value) : unchecked((short)value),
		SpecialType.System_UInt16 => isChecked ? checked((ushort)value) : unchecked((ushort)value),
		SpecialType.System_Int32 => isChecked ? checked((int)value) : unchecked((int)value),
		SpecialType.System_UInt32 => isChecked ? checked((uint)value) : unchecked((uint)value),
		SpecialType.System_Int64 => isChecked ? checked((long)value) : unchecked((long)value),
		SpecialType.System_UInt64 => isChecked ? checked((ulong)value) : unchecked((ulong)value),
		SpecialType.System_Char => isChecked ? checked((char)value) : unchecked((char)value),
		SpecialType.System_IntPtr => isChecked ? checked((nint)value) : unchecked((nint)value),
		SpecialType.System_UIntPtr => isChecked ? checked((nuint)value) : unchecked((nuint)value),
		SpecialType.System_Single => (float)value,
		SpecialType.System_Double => value,
		SpecialType.System_Decimal => (decimal)value,
		_ => throw new EvaluationException("Unsupported numeric conversion."),
	};

	static object FromDecimal(decimal value, SpecialType target) => target switch {
		SpecialType.System_SByte => (sbyte)value,
		SpecialType.System_Byte => (byte)value,
		SpecialType.System_Int16 => (short)value,
		SpecialType.System_UInt16 => (ushort)value,
		SpecialType.System_Int32 => (int)value,
		SpecialType.System_UInt32 => (uint)value,
		SpecialType.System_Int64 => (long)value,
		SpecialType.System_UInt64 => (ulong)value,
		SpecialType.System_Char => (char)value,
		SpecialType.System_Single => (float)value,
		SpecialType.System_Double => (double)value,
		SpecialType.System_Decimal => value,
		_ => throw new EvaluationException("Unsupported numeric conversion."),
	};

	public static object Unary(UnaryOperatorKind kind, object value, bool isChecked) {
		try {
			return (kind, value) switch {
				(UnaryOperatorKind.Plus, _) => value,
				(UnaryOperatorKind.Not, bool b) => !b,
				(UnaryOperatorKind.Minus, int v) => isChecked ? checked(-v) : unchecked(-v),
				(UnaryOperatorKind.Minus, long v) => isChecked ? checked(-v) : unchecked(-v),
				(UnaryOperatorKind.Minus, uint v) => -(long)v,
				(UnaryOperatorKind.Minus, float v) => -v,
				(UnaryOperatorKind.Minus, double v) => -v,
				(UnaryOperatorKind.Minus, decimal v) => -v,
				(UnaryOperatorKind.Minus, nint v) => isChecked ? checked(-v) : unchecked(-v),
				(UnaryOperatorKind.BitwiseNegation, int v) => ~v,
				(UnaryOperatorKind.BitwiseNegation, uint v) => ~v,
				(UnaryOperatorKind.BitwiseNegation, long v) => ~v,
				(UnaryOperatorKind.BitwiseNegation, ulong v) => ~v,
				(UnaryOperatorKind.BitwiseNegation, nint v) => ~v,
				(UnaryOperatorKind.BitwiseNegation, nuint v) => ~v,
				// Visual Basic's Not is bitwise on integers.
				(UnaryOperatorKind.Not, int v) => ~v,
				(UnaryOperatorKind.Not, long v) => ~v,
				(UnaryOperatorKind.Not, uint v) => ~v,
				(UnaryOperatorKind.Not, ulong v) => ~v,
				(UnaryOperatorKind.Not, short v) => (short)~v,
				(UnaryOperatorKind.Not, ushort v) => (ushort)~v,
				(UnaryOperatorKind.Not, byte v) => (byte)~v,
				(UnaryOperatorKind.Not, sbyte v) => (sbyte)~v,
				(UnaryOperatorKind.Minus, short v) => (short)-v,
				(UnaryOperatorKind.Minus, sbyte v) => (sbyte)-v,
				_ => throw new EvaluationException($"Operator '{kind}' cannot be applied to an operand of type '{value.GetType().Name}'."),
			};
		}
		catch (OverflowException) {
			throw new EvaluationException("Arithmetic operation resulted in an overflow.");
		}
	}

	/// <summary>A built-in binary operator on two operands of the same type.</summary>
	public static object Binary(BinaryOperatorKind kind, object left, object right, bool isChecked) {
		try {
			return (left, right) switch {
				(int l, int r) => Integer(kind, l, r, isChecked),
				(uint l, uint r) => Integer(kind, l, r, isChecked),
				(long l, long r) => Integer(kind, l, r, isChecked),
				(ulong l, ulong r) => Integer(kind, l, r, isChecked),
				(nint l, nint r) => Integer(kind, l, r, isChecked),
				(nuint l, nuint r) => Integer(kind, l, r, isChecked),
				(short l, short r) => Integer(kind, (int)l, r, isChecked) is var s && s is int si && kind is not (BinaryOperatorKind.Equals or BinaryOperatorKind.NotEquals or BinaryOperatorKind.LessThan or BinaryOperatorKind.LessThanOrEqual or BinaryOperatorKind.GreaterThan or BinaryOperatorKind.GreaterThanOrEqual) ? (short)si : s,
				(byte l, byte r) => Integer(kind, (int)l, r, isChecked) is var b && b is int bi && kind is not (BinaryOperatorKind.Equals or BinaryOperatorKind.NotEquals or BinaryOperatorKind.LessThan or BinaryOperatorKind.LessThanOrEqual or BinaryOperatorKind.GreaterThan or BinaryOperatorKind.GreaterThanOrEqual) ? (byte)bi : b,
				(float l, float r) => Floating(kind, l, r),
				(double l, double r) => Floating(kind, l, r),
				(decimal l, decimal r) => DecimalOp(kind, l, r),
				(bool l, bool r) => Boolean(kind, l, r),
				(char l, char r) => Integer(kind, (int)l, r, isChecked),
				// A shift takes an int count whatever the left operand is.
				(int l, _) when kind is BinaryOperatorKind.LeftShift or BinaryOperatorKind.RightShift or BinaryOperatorKind.UnsignedRightShift => Integer(kind, l, (int)Convert(right, SpecialType.System_Int32, false), isChecked),
				(uint l, _) when kind is BinaryOperatorKind.LeftShift or BinaryOperatorKind.RightShift or BinaryOperatorKind.UnsignedRightShift => Integer(kind, l, (uint)(int)Convert(right, SpecialType.System_Int32, false), isChecked),
				(long l, _) when kind is BinaryOperatorKind.LeftShift or BinaryOperatorKind.RightShift or BinaryOperatorKind.UnsignedRightShift => Integer(kind, l, (long)(int)Convert(right, SpecialType.System_Int32, false), isChecked),
				(ulong l, _) when kind is BinaryOperatorKind.LeftShift or BinaryOperatorKind.RightShift or BinaryOperatorKind.UnsignedRightShift => Integer(kind, l, (ulong)(int)Convert(right, SpecialType.System_Int32, false), isChecked),
				_ when IsIntegral(left) && IsIntegral(right) => Integer(kind, (long)ToInt128(left), (long)ToInt128(right), isChecked),
				_ => throw new EvaluationException($"Operator '{kind}' cannot be applied to operands of type '{left.GetType().Name}' and '{right.GetType().Name}'."),
			};
		}
		catch (OverflowException) {
			throw new EvaluationException("Arithmetic operation resulted in an overflow.");
		}
		catch (DivideByZeroException) {
			throw new EvaluationException("Attempted to divide by zero.");
		}
	}

	static object Integer<T>(BinaryOperatorKind kind, T left, T right, bool isChecked) where T : IBinaryInteger<T> {
		return kind switch {
			BinaryOperatorKind.Add => isChecked ? checked(left + right) : unchecked(left + right),
			BinaryOperatorKind.Subtract => isChecked ? checked(left - right) : unchecked(left - right),
			BinaryOperatorKind.Multiply => isChecked ? checked(left * right) : unchecked(left * right),
			BinaryOperatorKind.Divide or BinaryOperatorKind.IntegerDivide => left / right,
			BinaryOperatorKind.Remainder => left % right,
			BinaryOperatorKind.And or BinaryOperatorKind.ConditionalAnd => left & right,
			BinaryOperatorKind.Or or BinaryOperatorKind.ConditionalOr => left | right,
			BinaryOperatorKind.ExclusiveOr => left ^ right,
			BinaryOperatorKind.LeftShift => left << int.CreateTruncating(right),
			BinaryOperatorKind.RightShift => left >> int.CreateTruncating(right),
			BinaryOperatorKind.UnsignedRightShift => left >>> int.CreateTruncating(right),
			BinaryOperatorKind.Equals or BinaryOperatorKind.ObjectValueEquals => left == right,
			BinaryOperatorKind.NotEquals or BinaryOperatorKind.ObjectValueNotEquals => left != right,
			BinaryOperatorKind.LessThan => left < right,
			BinaryOperatorKind.LessThanOrEqual => left <= right,
			BinaryOperatorKind.GreaterThan => left > right,
			BinaryOperatorKind.GreaterThanOrEqual => left >= right,
			BinaryOperatorKind.Power => Math.Pow(double.CreateTruncating(left), double.CreateTruncating(right)),
			_ => throw new EvaluationException($"Operator '{kind}' is not supported for integers."),
		};
	}

	static object Floating<T>(BinaryOperatorKind kind, T left, T right) where T : IFloatingPoint<T> {
		return kind switch {
			BinaryOperatorKind.Add => left + right,
			BinaryOperatorKind.Subtract => left - right,
			BinaryOperatorKind.Multiply => left * right,
			BinaryOperatorKind.Divide => left / right,
			BinaryOperatorKind.Remainder => left % right,
			BinaryOperatorKind.Equals or BinaryOperatorKind.ObjectValueEquals => left == right,
			BinaryOperatorKind.NotEquals or BinaryOperatorKind.ObjectValueNotEquals => left != right,
			BinaryOperatorKind.LessThan => left < right,
			BinaryOperatorKind.LessThanOrEqual => left <= right,
			BinaryOperatorKind.GreaterThan => left > right,
			BinaryOperatorKind.GreaterThanOrEqual => left >= right,
			BinaryOperatorKind.Power => Math.Pow(double.CreateTruncating(left), double.CreateTruncating(right)),
			BinaryOperatorKind.IntegerDivide => Math.Truncate(double.CreateTruncating(left) / double.CreateTruncating(right)),
			_ => throw new EvaluationException($"Operator '{kind}' is not supported for floating point numbers."),
		};
	}

	static object DecimalOp(BinaryOperatorKind kind, decimal left, decimal right) => kind switch {
		BinaryOperatorKind.Add => left + right,
		BinaryOperatorKind.Subtract => left - right,
		BinaryOperatorKind.Multiply => left * right,
		BinaryOperatorKind.Divide => left / right,
		BinaryOperatorKind.Remainder => left % right,
		BinaryOperatorKind.Equals or BinaryOperatorKind.ObjectValueEquals => left == right,
		BinaryOperatorKind.NotEquals or BinaryOperatorKind.ObjectValueNotEquals => left != right,
		BinaryOperatorKind.LessThan => left < right,
		BinaryOperatorKind.LessThanOrEqual => left <= right,
		BinaryOperatorKind.GreaterThan => left > right,
		BinaryOperatorKind.GreaterThanOrEqual => left >= right,
		_ => throw new EvaluationException($"Operator '{kind}' is not supported for decimals."),
	};

	static object Boolean(BinaryOperatorKind kind, bool left, bool right) => kind switch {
		BinaryOperatorKind.And or BinaryOperatorKind.ConditionalAnd => left & right,
		BinaryOperatorKind.Or or BinaryOperatorKind.ConditionalOr => left | right,
		BinaryOperatorKind.ExclusiveOr => left ^ right,
		BinaryOperatorKind.Equals or BinaryOperatorKind.ObjectValueEquals => left == right,
		BinaryOperatorKind.NotEquals or BinaryOperatorKind.ObjectValueNotEquals => left != right,
		_ => throw new EvaluationException($"Operator '{kind}' is not supported for booleans."),
	};

	/// <summary>How a value reads when it is concatenated into a string.</summary>
	public static string ToConcatenationString(object? value) => value switch {
		null => string.Empty,
		string s => s,
		bool b => b ? "True" : "False",
		IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture),
		_ => value.ToString() ?? string.Empty,
	};
}
