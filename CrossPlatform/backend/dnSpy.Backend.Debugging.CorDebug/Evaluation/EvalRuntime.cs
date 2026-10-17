using System.Globalization;
using ICorDebugSharp;
using ICorDebugSharp.Extensions;
using Microsoft.CodeAnalysis;

namespace dnSpy.Backend.Debugging.CorDebug.Evaluation;

/// <summary>Thrown when a call made on the user's behalf threw; the value is the exception object.</summary>
internal sealed class EvaluationThrownException(EvalValue exception, string? member) : Exception("The evaluation threw an exception.") {
	public EvalValue ExceptionValue { get; } = exception;

	/// <summary>What was being called, for "'X' threw an exception of type 'Y'".</summary>
	public string? Member { get; } = member;
}

/// <summary>
/// What the evaluator does to the debuggee: read a frame's variables, a field, an array element; call a
/// method, create an object, a string, an array; box a value. dnSpy's <c>DbgDotNetRuntime</c>, over
/// ICorDebug. Every call is a func-eval on the evaluating thread, so the frame and the values read before it
/// are read again afterwards (see <see cref="ValueRef"/>).
/// </summary>
internal sealed class EvalRuntime {
	public EvalRuntime(CorDebugSession session, DebuggeeTypeSystem types, int threadId, int frameIndex, bool allowFuncEval, CancellationToken cancellationToken) {
		Session = session;
		Types = types;
		ThreadId = threadId;
		FrameIndex = frameIndex;
		AllowFuncEval = allowFuncEval;
		CancellationToken = cancellationToken;
	}

	public CorDebugSession Session { get; }

	public DebuggeeTypeSystem Types { get; }

	public Compilation Compilation => Types.Compilation;

	public int ThreadId { get; }

	public int FrameIndex { get; }

	/// <summary>Whether calls may be made at all — the "property evaluation" option, or a <c>nse</c> specifier.</summary>
	public bool AllowFuncEval { get; set; }

	public CancellationToken CancellationToken { get; }

	/// <summary>Runs <paramref name="action"/> on the session's COM thread.</summary>
	public Task<T> OnDispatcher<T>(Func<T> action) => Session.Dispatcher.RunAsync(() => {
		try {
			return action();
		}
		catch (System.Runtime.InteropServices.COMException ex) {
			throw new EvaluationException(CorDebugSession.DescribeFuncEvalFailure(ex.HResult), ex);
		}
	});

	public ICorDebugFrame? Frame => Session.GetFrame(ThreadId, FrameIndex);

	public ICorDebugILFrame? ILFrame => Frame as ICorDebugILFrame;

	public ICorDebugAppDomain AppDomain {
		get {
			var thread = Session.Threads.Find(ThreadId) ?? throw new EvaluationException($"There is no thread with id {ThreadId}.");
			return thread.AppDomain;
		}
	}

	public ITypeSymbol Object => Compilation.GetSpecialType(SpecialType.System_Object);

	public ITypeSymbol String => Compilation.GetSpecialType(SpecialType.System_String);

	public ITypeSymbol Special(SpecialType type) => Compilation.GetSpecialType(type);

	// ---------------------------------------------------------------- wrapping

	/// <summary>
	/// Turns a value the runtime handed over into one the evaluator holds. Primitives, strings and enums are
	/// copied out; objects and arrays are held by a strong handle; a struct remembers how to read itself
	/// again through <paramref name="refetch"/>.
	/// </summary>
	public EvalValue Wrap(ICorDebugValue raw, ITypeSymbol? staticType, Func<ICorDebugValue?>? refetch) {
		if (raw is ICorDebugReferenceValue reference && reference.IsNull) {
			var nullType = staticType ?? Types.GetSymbol(ValueReader.ExactType(raw)) ?? Object;
			return new ScalarValue(nullType, null);
		}
		var target = ValueReader.Dereference(raw);
		if (target is null)
			return new ScalarValue(staticType ?? Object, null);
		var isHeap = !ReferenceEquals(target, raw) || target is ICorDebugHeapValue2;
		var corType = ValueReader.ExactType(target);
		var type = Types.GetSymbol(corType) ?? staticType ?? Object;

		if (target is ICorDebugStringValue text) {
			var handle = isHeap ? Session.CreateStopHandle(target) : null;
			var origin = handle is null ? null : new RemoteValue(String, corType, ValueRef.FromHandle(Session, handle));
			return new ScalarValue(String, ValueReader.ReadString(text), origin);
		}

		if (target is ICorDebugBoxValue box) {
			var handle = Session.CreateStopHandle(target);
			var payload = box.Object;
			var payloadType = Types.GetSymbol(ValueReader.ExactType(payload)) ?? type;
			var boxRef = handle is not null ? ValueRef.FromHandle(Session, handle) : ValueRef.FromLocation(Session, target, () => refetch?.Invoke() is { } again ? ValueReader.Dereference(again) : null);
			var boxed = new RemoteValue(payloadType, ValueReader.ExactType(payload), boxRef);
			if (TryReadScalar(payload, payloadType, out var scalar))
				return new ScalarValue(scalar.Type, scalar.Value, boxed);
			return boxed;
		}

		if (target is ICorDebugArrayValue || (isHeap && target is ICorDebugObjectValue { IsValueClass: false })) {
			var handle = Session.CreateStopHandle(target);
			if (handle is not null)
				return new RemoteValue(type, corType, ValueRef.FromHandle(Session, handle));
		}

		if (TryReadScalar(target, type, out var value))
			return value;

		// A Nullable<T> reads as its value or as null, which is how every window shows one.
		if (type is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } nullable && target is ICorDebugObjectValue nullableObject && TryUnwrapNullable(nullable, nullableObject, refetch) is { } unwrapped)
			return unwrapped;

		var location = refetch is null
			? ValueRef.FromLocation(Session, target, () => null)
			: ValueRef.FromLocation(Session, target, () => refetch() is { } again ? ValueReader.Dereference(again) : null);
		return new RemoteValue(type, corType, location);
	}

	/// <summary>
	/// The value inside a Nullable&lt;T&gt;, or a typed null when it has none; null when the struct's fields
	/// cannot be read, which leaves it shown as the struct it is.
	/// </summary>
	EvalValue? TryUnwrapNullable(INamedTypeSymbol nullable, ICorDebugObjectValue value, Func<ICorDebugValue?>? refetch) {
		var definition = nullable.OriginalDefinition;
		var hasValueField = definition.GetMembers("hasValue").OfType<IFieldSymbol>().FirstOrDefault();
		var valueField = definition.GetMembers("value").OfType<IFieldSymbol>().FirstOrDefault();
		var cls = Types.GetClass(nullable);
		if (hasValueField is null || valueField is null || cls is null)
			return null;
		try {
			var hasValue = value.GetFieldValue(cls, hasValueField.MetadataToken);
			if (ValueReader.ReadBytes(hasValue)[0] == 0)
				return new ScalarValue(nullable, null);
			var inner = value.GetFieldValue(cls, valueField.MetadataToken);
			return Wrap(inner, nullable.TypeArguments[0], refetch is null ? null : () =>
				refetch() is { } again && ValueReader.Dereference(again) is ICorDebugObjectValue outer ? outer.GetFieldValue(cls, valueField.MetadataToken) : null);
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex) || ex is EvaluationException) {
			return null;
		}
	}

	/// <summary>Copies a primitive, a decimal or an enum out of the debuggee.</summary>
	bool TryReadScalar(ICorDebugValue target, ITypeSymbol type, out ScalarValue scalar) {
		scalar = null!;
		try {
			var element = target.Type;
			if (DebuggeeTypeSystem.SpecialTypeOf(element) is { } special && special != SpecialType.System_String && special != SpecialType.System_Object && special != SpecialType.System_TypedReference && special != SpecialType.System_Void) {
				scalar = new ScalarValue(type.TypeKind == TypeKind.Enum ? type : Special(special), ValueReader.DecodePrimitive(element, ValueReader.ReadBytes(target)));
				return true;
			}
			if (element == CorElementType.PTR || element == CorElementType.FNPTR) {
				scalar = new ScalarValue(type, ValueReader.DecodePrimitive(element, ValueReader.ReadBytes(target)));
				return true;
			}
			if (type.SpecialType == SpecialType.System_Decimal) {
				scalar = new ScalarValue(type, ValueReader.DecimalFromBytes(ValueReader.ReadBytes(target)));
				return true;
			}
			if (type.TypeKind == TypeKind.Enum && type is INamedTypeSymbol { EnumUnderlyingType: { } underlying }) {
				var underlyingElement = ValueReader.ElementTypeOf(underlying.SpecialType);
				scalar = new ScalarValue(type, ValueReader.DecodePrimitive(underlyingElement, ValueReader.ReadBytes(target)));
				return true;
			}
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
		}
		return false;
	}

	// ---------------------------------------------------------------- frame variables

	public Task<EvalValue> ReadArgumentAsync(int index, ITypeSymbol? declaredType) => OnDispatcher(() => {
		var frame = ILFrame ?? throw new EvaluationException("The frame has no IL arguments.");
		var raw = frame.GetArgument(index);
		return Wrap(raw, declaredType, () => ILFrame?.GetArgument(index));
	});

	public Task<EvalValue> ReadLocalAsync(int index, ITypeSymbol? declaredType) => OnDispatcher(() => {
		var frame = ILFrame ?? throw new EvaluationException("The frame has no IL locals.");
		var raw = frame.GetLocalVariable(index);
		return Wrap(raw, declaredType, () => ILFrame?.GetLocalVariable(index));
	});

	/// <summary>Writes into a frame slot.</summary>
	public Task WriteArgumentAsync(int index, EvalValue value) => WriteToAsync(() => ILFrame?.GetArgument(index), value);

	public Task WriteLocalAsync(int index, EvalValue value) => WriteToAsync(() => ILFrame?.GetLocalVariable(index), value);

	// ---------------------------------------------------------------- fields

	public async Task<EvalValue> ReadFieldAsync(EvalValue? instance, IFieldSymbol field) {
		if (field.HasConstantValue)
			return new ScalarValue(field.Type, ConvertConstant(field.ConstantValue, field.Type));
		if (field.IsStatic)
			return await ReadStaticFieldAsync(field).ConfigureAwait(false);
		if (instance is null)
			throw new EvaluationException($"An object reference is required for the non-static field '{field.Name}'.");
		if (instance.IsNull)
			throw new EvaluationException("Object reference not set to an instance of an object.");
		var remote = instance as RemoteValue ?? (instance as ScalarValue)?.Origin
			?? throw new EvaluationException($"'{field.Name}' cannot be read from this value.");
		return await OnDispatcher(() => {
			var cls = Types.GetClass(field.ContainingType) ?? throw new EvaluationException($"The type of '{field.Name}' is not loaded.");
			ICorDebugValue? Read() => remote.Object is ICorDebugObjectValue obj ? obj.GetFieldValue(cls, field.OriginalDefinition.MetadataToken) : null;
			var raw = Read() ?? throw new EvaluationException($"'{field.Name}' cannot be read from this value.");
			return Wrap(raw, field.Type, Read);
		}).ConfigureAwait(false);
	}

	Task<EvalValue> ReadStaticFieldAsync(IFieldSymbol field) => OnDispatcher(() => {
		var type = Types.GetCorType(field.ContainingType, AppDomain) ?? throw new EvaluationException($"The type '{field.ContainingType.Name}' is not loaded.");
		ICorDebugValue? Read() {
			// The frame is what a thread-static field is read through; any frame of the thread will do.
			var frame = Frame;
			var hr = type.TryGetStaticFieldValue(field.OriginalDefinition.MetadataToken, frame!, out var value);
			if (hr < 0)
				throw new EvaluationException(hr == unchecked((int)0x80131303) || hr == unchecked((int)0x8013130E)
					? $"The static field '{field.Name}' is not available yet: its type has not been initialized."
					: $"The static field '{field.Name}' cannot be read: HRESULT 0x{hr:X8}.");
			return value;
		}
		var raw = Read() ?? throw new EvaluationException($"The static field '{field.Name}' cannot be read.");
		return Wrap(raw, field.Type, Read);
	});

	public async Task WriteFieldAsync(EvalValue? instance, IFieldSymbol field, EvalValue value) {
		if (field.IsConst)
			throw new EvaluationException($"The left-hand side of an assignment must be a variable, property or indexer.");
		if (field.IsStatic) {
			var type = await OnDispatcher(() => Types.GetCorType(field.ContainingType, AppDomain)).ConfigureAwait(false)
				?? throw new EvaluationException($"The type '{field.ContainingType.Name}' is not loaded.");
			await WriteToAsync(() => type.GetStaticFieldValue(field.OriginalDefinition.MetadataToken, Frame!), value).ConfigureAwait(false);
			return;
		}
		if (instance is not RemoteValue remote)
			throw new EvaluationException($"'{field.Name}' cannot be written on this value.");
		var cls = await OnDispatcher(() => Types.GetClass(field.ContainingType)).ConfigureAwait(false) ?? throw new EvaluationException($"The type of '{field.Name}' is not loaded.");
		await WriteToAsync(() => remote.Object is ICorDebugObjectValue obj ? obj.GetFieldValue(cls, field.OriginalDefinition.MetadataToken) : null, value).ConfigureAwait(false);
	}

	// ---------------------------------------------------------------- arrays

	public Task<EvalValue> ReadElementAsync(EvalValue array, IReadOnlyList<long> indices) {
		var remote = array as RemoteValue ?? throw new EvaluationException("The value is not an array.");
		var elementType = (array.Type as IArrayTypeSymbol)?.ElementType;
		return OnDispatcher(() => {
			ICorDebugValue? Read() {
				if (remote.Object is not ICorDebugArrayValue value)
					return null;
				return ReadElement(value, indices);
			}
			var raw = Read() ?? throw new EvaluationException("The value is not an array.");
			return Wrap(raw, elementType, Read);
		});
	}

	static ICorDebugValue ReadElement(ICorDebugArrayValue array, IReadOnlyList<long> indices) {
		var rank = (int)array.Rank;
		if (indices.Count != rank)
			throw new EvaluationException($"Wrong number of indices inside []; expected {rank}.");
		var dimensions = array.GetDimensions(rank);
		var baseIndices = array.HasBaseIndicies() ? array.GetBaseIndicies(rank) : new uint[rank];
		var position = 0L;
		for (var dimension = 0; dimension < rank; dimension++) {
			var index = indices[dimension] - baseIndices[dimension];
			if (index < 0 || index >= dimensions[dimension])
				throw new EvaluationException("Index was outside the bounds of the array.");
			position = position * dimensions[dimension] + index;
		}
		return array.GetElementAtPosition((int)position);
	}

	public Task WriteElementAsync(EvalValue array, IReadOnlyList<long> indices, EvalValue value) {
		var remote = array as RemoteValue ?? throw new EvaluationException("The value is not an array.");
		return WriteToAsync(() => remote.Object is ICorDebugArrayValue arrayValue ? ReadElement(arrayValue, indices) : null, value);
	}

	/// <summary>The length of each dimension of an array.</summary>
	public Task<(uint[] Dimensions, uint[] LowerBounds)> ReadArrayShapeAsync(RemoteValue array) => OnDispatcher(() => {
		if (array.Object is not ICorDebugArrayValue value)
			throw new EvaluationException("The value is not an array.");
		var rank = (int)value.Rank;
		var dimensions = value.GetDimensions(rank);
		var bounds = value.HasBaseIndicies() ? value.GetBaseIndicies(rank) : new uint[rank];
		return (dimensions, bounds);
	});

	// ---------------------------------------------------------------- writing

	/// <summary>
	/// Writes a value into a location the runtime hands out: a primitive or a struct by its bytes, a reference
	/// by the address of the object it now points at.
	/// </summary>
	async Task WriteToAsync(Func<ICorDebugValue?> location, EvalValue value) {
		// A string written into a variable has to exist in the debuggee first.
		var prepared = await PrepareAsync(value, null).ConfigureAwait(false);
		await OnDispatcher(() => {
			var target = location() ?? throw new EvaluationException("The location cannot be written.");
			switch (prepared) {
				case PreparedValue.Reference reference:
					if (target is not ICorDebugReferenceValue targetReference)
						throw new EvaluationException("Cannot assign a reference to a value type location.");
					targetReference.Value = new CORDB_ADDRESS(ValueReader.ReadReferenceAddress(reference.Handle));
					break;
				case PreparedValue.Null:
					if (target is not ICorDebugReferenceValue nullReference)
						throw new EvaluationException("Cannot assign null to a value type location.");
					nullReference.Value = new CORDB_ADDRESS(0);
					break;
				case PreparedValue.Primitive primitive:
					ValueReader.WriteBytes(ValueReader.Unwrap(target) ?? target, primitive.Bytes);
					break;
				case PreparedValue.Struct structure:
					ValueReader.WriteBytes(ValueReader.Unwrap(target) ?? target, ValueReader.ReadBytes(structure.Value.Object));
					break;
			}
			return true;
		}).ConfigureAwait(false);
	}

	// ---------------------------------------------------------------- calls

	/// <summary>How an argument is handed to a call once it exists in the debuggee.</summary>
	abstract record PreparedValue {
		public sealed record Reference(ICorDebugHandleValue Handle) : PreparedValue;
		public sealed record Null : PreparedValue;
		public sealed record Primitive(CorElementType Element, byte[] Bytes) : PreparedValue;
		public sealed record Struct(RemoteValue Value) : PreparedValue;
	}

	/// <summary>
	/// Makes a value something a call can take: a string is created in the debuggee, a value passed where a
	/// reference is wanted is boxed, a primitive is created from its bytes when the call is made.
	/// </summary>
	async Task<PreparedValue> PrepareAsync(EvalValue value, ITypeSymbol? parameterType) {
		var wantsReference = parameterType is not null && !parameterType.IsValueType && parameterType.TypeKind != TypeKind.Pointer && parameterType.TypeKind != TypeKind.TypeParameter;
		switch (value) {
			case ScalarValue { Value: null }:
				return new PreparedValue.Null();
			case ScalarValue { Value: string text } scalar:
				if (scalar.Origin?.Ref.Handle is { } existing)
					return new PreparedValue.Reference(existing);
				return new PreparedValue.Reference(await NewStringHandleAsync(text).ConfigureAwait(false));
			case ScalarValue scalar:
				if (wantsReference) {
					if (scalar.Origin?.Ref.Handle is { } boxedAlready && SymbolEqualityComparer.Default.Equals(scalar.Origin.Type, scalar.Type))
						return new PreparedValue.Reference(boxedAlready);
					return new PreparedValue.Reference(await BoxAsync(scalar.Type, ValueReader.EncodePrimitive(scalar.Value!)).ConfigureAwait(false));
				}
				if (scalar.Value is decimal decimalValue)
					return new PreparedValue.Struct((RemoteValue)await CreateStructAsync(scalar.Type, ValueReader.EncodePrimitive(decimalValue)).ConfigureAwait(false));
				var element = scalar.Type.TypeKind == TypeKind.Enum && scalar.Type is INamedTypeSymbol { EnumUnderlyingType: { } underlying }
					? ValueReader.ElementTypeOf(underlying.SpecialType)
					: ValueReader.ElementTypeOf(scalar.Type.SpecialType);
				if (scalar.Type.TypeKind == TypeKind.Enum)
					return new PreparedValue.Struct((RemoteValue)await CreateStructAsync(scalar.Type, ValueReader.EncodePrimitive(scalar.Value!)).ConfigureAwait(false));
				return new PreparedValue.Primitive(element, ValueReader.EncodePrimitive(scalar.Value!));
			case RemoteValue remote when remote.Ref.Handle is { } handle && !remote.Type.IsValueType:
				return new PreparedValue.Reference(handle);
			case RemoteValue remote when remote.Ref.Handle is { } boxHandle:
				// A boxed struct: passed boxed where a reference is wanted, and by value otherwise.
				return wantsReference ? new PreparedValue.Reference(boxHandle) : new PreparedValue.Struct(remote);
			case RemoteValue remote:
				if (wantsReference) {
					var bytes = await OnDispatcher(() => ValueReader.ReadBytes(remote.Object)).ConfigureAwait(false);
					return new PreparedValue.Reference(await BoxAsync(remote.Type, bytes).ConfigureAwait(false));
				}
				return new PreparedValue.Struct(remote);
			default:
				throw new EvaluationException("The value cannot be passed to a method.");
		}
	}

	static ICorDebugValue Materialize(ICorDebugEval eval, PreparedValue prepared) {
		switch (prepared) {
			case PreparedValue.Reference reference:
				return reference.Handle;
			case PreparedValue.Null:
				return eval.CreateValue(CorElementType.CLASS, null!);
			case PreparedValue.Primitive primitive: {
				var value = eval.CreateValue(primitive.Element, null!);
				ValueReader.WriteBytes(value, primitive.Bytes);
				return value;
			}
			case PreparedValue.Struct structure:
				return structure.Value.Ref.Get();
			default:
				throw new InvalidOperationException();
		}
	}

	void RequireFuncEval(string? what) {
		if (!AllowFuncEval)
			throw new EvaluationException(what is null
				? "Implicit function evaluation is turned off by the user."
				: $"Evaluation of '{what}' requires a function evaluation, which is turned off by the user.");
	}

	/// <summary>Calls a method — virtual dispatch on the instance, as the runtime does for a func-eval.</summary>
	public async Task<EvalValue> CallAsync(IMethodSymbol method, EvalValue? instance, IReadOnlyList<EvalValue> arguments, string? displayName = null) {
		RequireFuncEval(displayName);
		var definition = method.ReducedFrom ?? method;
		var callArguments = new List<(EvalValue Value, ITypeSymbol? Type)>();
		if (!definition.IsStatic) {
			if (instance is null)
				throw new EvaluationException($"An object reference is required for the non-static member '{method.Name}'.");
			if (instance.IsNull)
				throw new EvaluationException("Object reference not set to an instance of an object.");
			// A struct's own instance method takes the struct, and one inherited from object takes it boxed.
			callArguments.Add((instance, method.ContainingType));
		}
		else if (method.ReducedFrom is not null && instance is not null) {
			callArguments.Add((instance, definition.Parameters[0].Type));
		}
		var parameters = definition.Parameters;
		var offset = callArguments.Count - (definition.IsStatic ? 0 : 1);
		for (var index = 0; index < arguments.Count; index++) {
			var parameter = index + offset < parameters.Length ? parameters[index + offset] : null;
			if (parameter is not null && parameter.RefKind != RefKind.None && parameter.RefKind != RefKind.In)
				throw new EvaluationException("Methods with ref or out parameters cannot be called by the evaluator.");
			callArguments.Add((arguments[index], parameter?.Type));
		}
		var prepared = new List<PreparedValue>();
		foreach (var (value, type) in callArguments)
			prepared.Add(await PrepareAsync(value, type).ConfigureAwait(false));
		var (function, typeArguments) = await OnDispatcher(() => ResolveCall(method)).ConfigureAwait(false);
		var result = await Session.FuncEvalAsync(ThreadId, eval => {
			var values = prepared.Select(value => Materialize(eval, value)).ToArray();
			((ICorDebugEval2)eval).CallParameterizedFunction(function, typeArguments.Length, typeArguments, values.Length, values);
		}, CancellationToken).ConfigureAwait(false);
		return await WrapResultAsync(result, method.ReturnsVoid ? Special(SpecialType.System_Void) : method.ReturnType, displayName ?? method.Name).ConfigureAwait(false);
	}

	(ICorDebugFunction Function, ICorDebugType[] TypeArguments) ResolveCall(IMethodSymbol method) {
		var definition = method.ReducedFrom is { } reduced ? (method.ReducedFrom.IsGenericMethod ? reduced.Construct(ReducedTypeArguments(method)) : reduced) : method;
		var function = Types.GetFunction(definition) ?? throw new EvaluationException($"The method '{method.Name}' is not loaded in the debuggee.");
		var appDomain = AppDomain;
		var arguments = new List<ITypeSymbol>();
		arguments.AddRange(DebuggeeTypeSystem.AllTypeArguments(definition.ContainingType));
		arguments.AddRange(definition.TypeArguments);
		var corArguments = arguments.Select(argument => Types.GetCorType(argument, appDomain) ?? throw new EvaluationException($"The type '{argument.ToDisplayString()}' is not loaded in the debuggee.")).ToArray();
		return (function, corArguments);
	}

	static ITypeSymbol[] ReducedTypeArguments(IMethodSymbol method) {
		// A reduced extension method keeps its own type arguments; the inferred receiver type comes first.
		var reduced = method.ReducedFrom!;
		var arguments = new ITypeSymbol[reduced.Arity];
		for (var index = 0; index < reduced.TypeParameters.Length; index++)
			arguments[index] = method.GetTypeInferredDuringReduction(reduced.TypeParameters[index]) ?? method.TypeArguments.ElementAtOrDefault(index - (reduced.Arity - method.Arity)) ?? reduced.TypeParameters[index];
		return arguments;
	}

	/// <summary>Creates an object through one of its constructors.</summary>
	public async Task<EvalValue> NewObjectAsync(IMethodSymbol constructor, IReadOnlyList<EvalValue> arguments) {
		RequireFuncEval(constructor.ContainingType.Name);
		var prepared = new List<PreparedValue>();
		for (var index = 0; index < arguments.Count; index++)
			prepared.Add(await PrepareAsync(arguments[index], index < constructor.Parameters.Length ? constructor.Parameters[index].Type : null).ConfigureAwait(false));
		var (function, typeArguments) = await OnDispatcher(() => ResolveCall(constructor)).ConfigureAwait(false);
		var result = await Session.FuncEvalAsync(ThreadId, eval => {
			var values = prepared.Select(value => Materialize(eval, value)).ToArray();
			((ICorDebugEval2)eval).NewParameterizedObject(function, typeArguments.Length, typeArguments, values.Length, values);
		}, CancellationToken).ConfigureAwait(false);
		return await WrapResultAsync(result, constructor.ContainingType, constructor.ContainingType.Name).ConfigureAwait(false);
	}

	/// <summary>The zero value of a type: <c>default(T)</c>, a struct with every field cleared.</summary>
	public async Task<EvalValue> DefaultValueAsync(ITypeSymbol type) {
		if (!type.IsValueType || type.TypeKind == TypeKind.TypeParameter)
			return new ScalarValue(type, null);
		if (type.SpecialType is not SpecialType.None and not SpecialType.System_Nullable_T)
			return new ScalarValue(type, DefaultScalar(type.SpecialType));
		if (type.TypeKind == TypeKind.Enum && type is INamedTypeSymbol { EnumUnderlyingType: { } underlying })
			return new ScalarValue(type, DefaultScalar(underlying.SpecialType));
		return await CreateStructAsync(type, null).ConfigureAwait(false);
	}

	static object? DefaultScalar(SpecialType type) => type switch {
		SpecialType.System_Boolean => false,
		SpecialType.System_Char => '\0',
		SpecialType.System_SByte => (sbyte)0,
		SpecialType.System_Byte => (byte)0,
		SpecialType.System_Int16 => (short)0,
		SpecialType.System_UInt16 => (ushort)0,
		SpecialType.System_Int32 => 0,
		SpecialType.System_UInt32 => 0u,
		SpecialType.System_Int64 => 0L,
		SpecialType.System_UInt64 => 0UL,
		SpecialType.System_Single => 0f,
		SpecialType.System_Double => 0d,
		SpecialType.System_Decimal => 0m,
		SpecialType.System_IntPtr => (nint)0,
		SpecialType.System_UIntPtr => (nuint)0,
		_ => null,
	};

	/// <summary>A struct of <paramref name="type"/> made from <paramref name="bytes"/>, or cleared when there are none.</summary>
	async Task<EvalValue> CreateStructAsync(ITypeSymbol type, byte[]? bytes) {
		// The struct is created boxed so it has a home the handle can keep across further calls.
		var box = await BoxAsync(type, bytes).ConfigureAwait(false);
		return await OnDispatcher(() => {
			var payload = ValueReader.Unwrap(box) ?? throw new EvaluationException("The value could not be created.");
			var corType = ValueReader.ExactType(payload);
			return (EvalValue)new RemoteValue(type, corType, ValueRef.FromHandle(Session, box));
		}).ConfigureAwait(false);
	}

	/// <summary>Boxes a value of <paramref name="type"/>: a new box, with the value's bytes copied into it.</summary>
	public async Task<ICorDebugHandleValue> BoxAsync(ITypeSymbol type, byte[]? bytes) {
		RequireFuncEval(null);
		var (cls, typeArguments) = await OnDispatcher(() => {
			var named = type as INamedTypeSymbol ?? throw new EvaluationException($"A value of type '{type.ToDisplayString()}' cannot be boxed.");
			var appDomain = AppDomain;
			var cls = Types.GetClass(named) ?? throw new EvaluationException($"The type '{type.ToDisplayString()}' is not loaded in the debuggee.");
			var arguments = DebuggeeTypeSystem.AllTypeArguments(named).Select(argument => Types.GetCorType(argument, appDomain) ?? throw new EvaluationException($"The type '{argument.ToDisplayString()}' is not loaded in the debuggee.")).ToArray();
			return (cls, arguments);
		}).ConfigureAwait(false);
		var result = await Session.FuncEvalAsync(ThreadId, eval =>
			((ICorDebugEval2)eval).NewParameterizedObjectNoConstructor(cls, typeArguments.Length, typeArguments), CancellationToken).ConfigureAwait(false);
		if (result.IsException || result.Value is null)
			throw new EvaluationException($"A value of type '{type.ToDisplayString()}' could not be created.");
		return await OnDispatcher(() => {
			var handle = Session.CreateStopHandle(ValueReader.Dereference(result.Value) ?? result.Value) ?? throw new EvaluationException("The value could not be kept.");
			if (bytes is not null) {
				var payload = ValueReader.Unwrap(handle) ?? throw new EvaluationException("The value could not be created.");
				ValueReader.WriteBytes(payload, bytes);
			}
			return handle;
		}).ConfigureAwait(false);
	}

	/// <summary>Creates a string in the debuggee.</summary>
	public async Task<ICorDebugHandleValue> NewStringHandleAsync(string text) {
		RequireFuncEval(null);
		var result = await Session.FuncEvalAsync(ThreadId, eval => ((ICorDebugEval2)eval).NewStringWithLength(text, text.Length), CancellationToken).ConfigureAwait(false);
		if (result.Value is null)
			throw new EvaluationException("The string could not be created.");
		return await OnDispatcher(() => Session.CreateStopHandle(ValueReader.Dereference(result.Value) ?? result.Value)
			?? throw new EvaluationException("The string could not be kept.")).ConfigureAwait(false);
	}

	/// <summary>Creates an array of <paramref name="elementType"/> with the given lengths.</summary>
	public async Task<EvalValue> NewArrayAsync(ITypeSymbol elementType, IReadOnlyList<int> lengths) {
		RequireFuncEval(null);
		var corElement = await OnDispatcher(() => Types.GetCorType(elementType, AppDomain)).ConfigureAwait(false)
			?? throw new EvaluationException($"The type '{elementType.ToDisplayString()}' is not loaded in the debuggee.");
		var dimensions = lengths.Select(length => (uint)length).ToArray();
		var result = await Session.FuncEvalAsync(ThreadId, eval =>
			((ICorDebugEval2)eval).NewParameterizedArray(corElement, dimensions.Length, dimensions, new uint[dimensions.Length]), CancellationToken).ConfigureAwait(false);
		var arrayType = lengths.Count == 1 ? Compilation.CreateArrayTypeSymbol(elementType) : Compilation.CreateArrayTypeSymbol(elementType, lengths.Count);
		return await WrapResultAsync(result, arrayType, null).ConfigureAwait(false);
	}

	async Task<EvalValue> WrapResultAsync(FuncEvalResult result, ITypeSymbol staticType, string? displayName) {
		if (result.Value is null) {
			if (result.IsException)
				throw new EvaluationException("The function evaluation was aborted.");
			return new ScalarValue(staticType, null);
		}
		var value = await OnDispatcher(() => {
			var eval = result.Eval;
			if (staticType.SpecialType == SpecialType.System_Void)
				return new ScalarValue(staticType, null);
			// A struct result lives in the eval object, which is kept alive by this closure.
			return Wrap(result.Value, staticType, () => {
				GC.KeepAlive(eval);
				return eval.Result;
			});
		}).ConfigureAwait(false);
		if (result.IsException)
			throw new EvaluationThrownException(value, displayName);
		return value;
	}

	// ---------------------------------------------------------------- helpers

	/// <summary>A constant the compiler folded, converted to the .NET type the evaluator computes with.</summary>
	public static object? ConvertConstant(object? constant, ITypeSymbol type) {
		if (constant is null)
			return null;
		var special = type.TypeKind == TypeKind.Enum && type is INamedTypeSymbol { EnumUnderlyingType: { } underlying } ? underlying.SpecialType : type.SpecialType;
		return special switch {
			SpecialType.System_Boolean => Convert.ToBoolean(constant, CultureInfo.InvariantCulture),
			SpecialType.System_Char => Convert.ToChar(constant, CultureInfo.InvariantCulture),
			SpecialType.System_SByte => Convert.ToSByte(constant, CultureInfo.InvariantCulture),
			SpecialType.System_Byte => Convert.ToByte(constant, CultureInfo.InvariantCulture),
			SpecialType.System_Int16 => Convert.ToInt16(constant, CultureInfo.InvariantCulture),
			SpecialType.System_UInt16 => Convert.ToUInt16(constant, CultureInfo.InvariantCulture),
			SpecialType.System_Int32 => Convert.ToInt32(constant, CultureInfo.InvariantCulture),
			SpecialType.System_UInt32 => Convert.ToUInt32(constant, CultureInfo.InvariantCulture),
			SpecialType.System_Int64 => Convert.ToInt64(constant, CultureInfo.InvariantCulture),
			SpecialType.System_UInt64 => Convert.ToUInt64(constant, CultureInfo.InvariantCulture),
			SpecialType.System_Single => Convert.ToSingle(constant, CultureInfo.InvariantCulture),
			SpecialType.System_Double => Convert.ToDouble(constant, CultureInfo.InvariantCulture),
			SpecialType.System_Decimal => Convert.ToDecimal(constant, CultureInfo.InvariantCulture),
			SpecialType.System_String => constant as string,
			_ => constant,
		};
	}
}
