using System.Runtime.InteropServices;
using ICorDebugSharp;
using ICorDebugSharp.Extensions;
using Microsoft.CodeAnalysis;

namespace dnSpy.Backend.Debugging.CorDebug.Evaluation;

/// <summary>
/// An <see cref="ICorDebugValue"/> that stays usable while the user is stopped. Every func-eval continues the
/// process and neuters the values read before it, so a reference is held as a strong handle — which the
/// runtime keeps valid — and anything else remembers how to read itself again.
/// </summary>
internal sealed class ValueRef {
	readonly CorDebugSession session;
	readonly Func<ICorDebugValue?>? refetch;
	readonly ICorDebugHandleValue? handle;
	ICorDebugValue? value;
	int generation;

	ValueRef(CorDebugSession session, ICorDebugValue? value, ICorDebugHandleValue? handle, Func<ICorDebugValue?>? refetch) {
		this.session = session;
		this.value = value;
		this.handle = handle;
		this.refetch = refetch;
		generation = session.Generation;
	}

	/// <summary>A value that is read again from where it came from once a func-eval has neutered it.</summary>
	public static ValueRef FromLocation(CorDebugSession session, ICorDebugValue value, Func<ICorDebugValue?> refetch) =>
		new(session, value, null, refetch);

	/// <summary>A heap object behind a strong handle, which survives every continue of the stop.</summary>
	public static ValueRef FromHandle(CorDebugSession session, ICorDebugHandleValue handle) =>
		new(session, null, handle, null);

	/// <summary>The handle the value is held by, which is also what is passed to a call as a reference.</summary>
	public ICorDebugHandleValue? Handle => handle;

	/// <summary>
	/// The value itself — for a handle, the object it refers to, read again once the generation it was read
	/// at has passed.
	/// </summary>
	public ICorDebugValue Get() {
		if (value is not null && generation == session.Generation)
			return value;
		ICorDebugValue? fresh;
		if (handle is not null)
			fresh = ValueReader.Dereference(handle);
		else
			fresh = refetch?.Invoke();
		value = fresh ?? throw new EvaluationException("The value is no longer valid.");
		generation = session.Generation;
		return value;
	}
}

/// <summary>A value the evaluator holds: one it computed, or one that lives in the debuggee.</summary>
internal abstract class EvalValue {
	/// <summary>The type the value has — its runtime type where the debuggee says, else the static one.</summary>
	public abstract ITypeSymbol Type { get; }

	/// <summary>True for a value a call threw rather than returned.</summary>
	public bool IsException { get; init; }

	public bool IsNull => this is ScalarValue { Value: null };
}

/// <summary>
/// An anonymous object the evaluator built itself: the type exists only in the expression's compilation,
/// so it has no image in the debuggee to func-eval a constructor from. Its properties are the values the
/// initializer supplied.
/// </summary>
internal sealed class AnonymousValue(ITypeSymbol type, IReadOnlyDictionary<string, EvalValue> members) : EvalValue {
	public override ITypeSymbol Type { get; } = type;

	public IReadOnlyDictionary<string, EvalValue> Members { get; } = members;
}

/// <summary>
/// A primitive, a string, a decimal, an enum or null: something the evaluator can hold as a .NET value and
/// compute with on its own. An enum holds its underlying integer and is typed as the enum.
/// </summary>
internal sealed class ScalarValue(ITypeSymbol type, object? value, RemoteValue? origin = null) : EvalValue {
	public override ITypeSymbol Type { get; } = type;

	public object? Value { get; } = value;

	/// <summary>The debuggee object the value was read from — a string, a boxed primitive — when there is one.</summary>
	public RemoteValue? Origin { get; } = origin;
}

/// <summary>An object, a struct or an array that lives in the debuggee.</summary>
internal sealed class RemoteValue(ITypeSymbol type, ICorDebugType? corType, ValueRef reference) : EvalValue {
	public override ITypeSymbol Type { get; } = type;

	public ICorDebugType? CorType { get; } = corType;

	public ValueRef Ref { get; } = reference;

	/// <summary>The object itself: the dereferenced value of a reference, the payload of a box.</summary>
	public ICorDebugValue Object => ValueReader.Unwrap(Ref.Get()) ?? throw new EvaluationException("The value is null.");
}

/// <summary>Reading <see cref="ICorDebugValue"/>s: following references, unboxing, copying primitives out.</summary>
internal static class ValueReader {
	/// <summary>Follows a reference to the object it points at; null for a null reference.</summary>
	public static ICorDebugValue? Dereference(ICorDebugValue value) {
		var current = value;
		for (var depth = 0; depth < 8 && current is ICorDebugReferenceValue reference; depth++) {
			if (reference.IsNull)
				return null;
			current = reference.Dereference();
			if (current is null)
				return null;
		}
		return current;
	}

	/// <summary>The object behind a value: dereferenced, and a box opened to the value inside it.</summary>
	public static ICorDebugValue? Unwrap(ICorDebugValue value) {
		var target = Dereference(value);
		if (target is ICorDebugBoxValue box) {
			try {
				return box.Object;
			}
			catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
				return target;
			}
		}
		return target;
	}

	public static bool IsNullReference(ICorDebugValue value) {
		try {
			return value is ICorDebugReferenceValue reference && reference.IsNull;
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return false;
		}
	}

	public static ICorDebugType? ExactType(ICorDebugValue value) {
		try {
			return value is ICorDebugValue2 value2 ? value2.ExactType : null;
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return null;
		}
	}

	/// <summary>The raw bytes of a primitive or of a whole struct, as the runtime copies them out.</summary>
	public static byte[] ReadBytes(ICorDebugValue value) {
		var size = Math.Max(value.Size, 1);
		var bytes = new byte[size];
		if (value is not ICorDebugGenericValue generic)
			throw new EvaluationException("The value cannot be read.");
		unsafe {
			fixed (byte* pointer = bytes) {
				var hr = generic.TryGetValue((IntPtr)pointer);
				if (hr < 0)
					throw new EvaluationException(CorDebugSession.DescribeFuncEvalFailure(hr));
			}
		}
		return bytes;
	}

	public static void WriteBytes(ICorDebugValue value, byte[] bytes) {
		if (value is not ICorDebugGenericValue generic)
			throw new EvaluationException("The value cannot be written.");
		unsafe {
			fixed (byte* pointer = bytes) {
				var hr = generic.TrySetValue((IntPtr)pointer);
				if (hr < 0)
					throw new EvaluationException($"The value could not be written: HRESULT 0x{hr:X8}.");
			}
		}
	}

	/// <summary>A primitive's bytes as the .NET value of its element type.</summary>
	public static object? DecodePrimitive(CorElementType element, byte[] bytes) => element switch {
		CorElementType.BOOLEAN => bytes[0] != 0,
		CorElementType.CHAR => (char)BitConverter.ToUInt16(bytes, 0),
		CorElementType.I1 => (sbyte)bytes[0],
		CorElementType.U1 => bytes[0],
		CorElementType.I2 => BitConverter.ToInt16(bytes, 0),
		CorElementType.U2 => BitConverter.ToUInt16(bytes, 0),
		CorElementType.I4 => BitConverter.ToInt32(bytes, 0),
		CorElementType.U4 => BitConverter.ToUInt32(bytes, 0),
		CorElementType.I8 => BitConverter.ToInt64(bytes, 0),
		CorElementType.U8 => BitConverter.ToUInt64(bytes, 0),
		CorElementType.R4 => BitConverter.ToSingle(bytes, 0),
		CorElementType.R8 => BitConverter.ToDouble(bytes, 0),
		CorElementType.I or CorElementType.PTR or CorElementType.FNPTR => bytes.Length >= 8 ? (nint)BitConverter.ToInt64(bytes, 0) : (nint)BitConverter.ToInt32(bytes, 0),
		CorElementType.U => bytes.Length >= 8 ? (nuint)BitConverter.ToUInt64(bytes, 0) : (nuint)BitConverter.ToUInt32(bytes, 0),
		_ => null,
	};

	/// <summary>The bytes of a .NET primitive, the way the runtime lays it out.</summary>
	public static byte[] EncodePrimitive(object value) => value switch {
		bool b => [b ? (byte)1 : (byte)0],
		char c => BitConverter.GetBytes(c),
		sbyte sb => [unchecked((byte)sb)],
		byte b => [b],
		short s => BitConverter.GetBytes(s),
		ushort us => BitConverter.GetBytes(us),
		int i => BitConverter.GetBytes(i),
		uint ui => BitConverter.GetBytes(ui),
		long l => BitConverter.GetBytes(l),
		ulong ul => BitConverter.GetBytes(ul),
		float f => BitConverter.GetBytes(f),
		double d => BitConverter.GetBytes(d),
		nint n => IntPtr.Size == 8 ? BitConverter.GetBytes((long)n) : BitConverter.GetBytes((int)n),
		nuint n => UIntPtr.Size == 8 ? BitConverter.GetBytes((ulong)n) : BitConverter.GetBytes((uint)n),
		decimal m => DecimalBytes(m),
		_ => throw new EvaluationException($"A value of type {value.GetType().Name} cannot be written to the debuggee."),
	};

	/// <summary>A decimal's bytes in the runtime's layout: flags, high 32 bits, low 64 bits.</summary>
	static byte[] DecimalBytes(decimal value) {
		var bytes = new byte[16];
		MemoryMarshal.Write(bytes, in value);
		return bytes;
	}

	public static decimal DecimalFromBytes(byte[] bytes) => MemoryMarshal.Read<decimal>(bytes);

	/// <summary>The element type a .NET primitive is created as in the debuggee.</summary>
	public static CorElementType ElementTypeOf(SpecialType type) => type switch {
		SpecialType.System_Boolean => CorElementType.BOOLEAN,
		SpecialType.System_Char => CorElementType.CHAR,
		SpecialType.System_SByte => CorElementType.I1,
		SpecialType.System_Byte => CorElementType.U1,
		SpecialType.System_Int16 => CorElementType.I2,
		SpecialType.System_UInt16 => CorElementType.U2,
		SpecialType.System_Int32 => CorElementType.I4,
		SpecialType.System_UInt32 => CorElementType.U4,
		SpecialType.System_Int64 => CorElementType.I8,
		SpecialType.System_UInt64 => CorElementType.U8,
		SpecialType.System_Single => CorElementType.R4,
		SpecialType.System_Double => CorElementType.R8,
		SpecialType.System_IntPtr => CorElementType.I,
		SpecialType.System_UIntPtr => CorElementType.U,
		SpecialType.System_String => CorElementType.STRING,
		_ => CorElementType.CLASS,
	};

	/// <summary>Reads a string's characters, at most <paramref name="max"/> of them.</summary>
	public static string ReadString(ICorDebugStringValue value) => value.String ?? string.Empty;

	/// <summary>The address a reference points at, which is what a reference is written as.</summary>
	public static ulong ReadReferenceAddress(ICorDebugValue value) {
		if (value is ICorDebugReferenceValue reference)
			return reference.IsNull ? 0 : reference.Value.Value;
		return value.Address.Value;
	}
}
