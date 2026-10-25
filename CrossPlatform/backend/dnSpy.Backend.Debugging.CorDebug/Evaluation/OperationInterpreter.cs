using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;
using ICorDebugSharp;
using ICorDebugSharp.Extensions;

namespace dnSpy.Backend.Debugging.CorDebug.Evaluation;

/// <summary>
/// Runs a bound expression. The compiler has resolved every name, picked every overload, inserted every
/// conversion; what is left is to do what each node says against the debuggee — read the variable, load the
/// field, call the method — which is what dnSpy's IL interpreter does with the IL Roslyn's expression compiler
/// emits for the same expression.
/// </summary>
internal sealed class OperationInterpreter {
	readonly EvalRuntime runtime;
	readonly CompiledExpression compiled;
	readonly EvalContextShape shape;
	readonly bool isVisualBasic;
	readonly Stack<EvalValue> conditionalAccess = new();
	EvalValue? cachedFrameThis;

	public OperationInterpreter(EvalRuntime runtime, CompiledExpression compiled, EvalContextShape shape, EvalLanguage language) {
		this.runtime = runtime;
		this.compiled = compiled;
		this.shape = shape;
		isVisualBasic = language == EvalLanguage.VisualBasic;
	}

	public Task<EvalValue> EvaluateAsync() => EvalAsync(compiled.Operation ?? throw new EvaluationException(compiled.Error ?? "The expression could not be bound."));

	ITypeSymbol Bool => runtime.Special(SpecialType.System_Boolean);

	static ScalarValue Scalar(ITypeSymbol type, object? value) => new(type, value);

	async Task<EvalValue> EvalAsync(IOperation operation) {
		runtime.CancellationToken.ThrowIfCancellationRequested();
		// A constant the compiler folded needs nothing from the debuggee — except a constant of a conversion
		// that boxes or changes type, which is handled by the conversion itself.
		if (operation.ConstantValue.HasValue && operation is not IConversionOperation && operation.Type is not null)
			return Scalar(operation.Type, EvalRuntime.ConvertConstant(operation.ConstantValue.Value, operation.Type));
		switch (operation) {
			case IConversionOperation conversion when conversion.ConstantValue.HasValue && conversion.Type is not null:
				return Scalar(conversion.Type, EvalRuntime.ConvertConstant(conversion.ConstantValue.Value, conversion.Type));
			case IParenthesizedOperation parenthesized:
				return await EvalAsync(parenthesized.Operand).ConfigureAwait(false);
			case IParameterReferenceOperation parameter:
				return await ReadParameterAsync(parameter.Parameter).ConfigureAwait(false);
			case IInstanceReferenceOperation:
				return await ReadThisAsync().ConfigureAwait(false);
			case IFieldReferenceOperation field:
				return await runtime.ReadFieldAsync(field.Instance is null ? null : await EvalAsync(field.Instance).ConfigureAwait(false), field.Field).ConfigureAwait(false);
			case IPropertyReferenceOperation property:
				return await ReadPropertyAsync(property).ConfigureAwait(false);
			case IInvocationOperation invocation:
				return await InvokeAsync(invocation).ConfigureAwait(false);
			case IAnonymousObjectCreationOperation anonymous:
				return await CreateAnonymousObjectAsync(anonymous).ConfigureAwait(false);
			case IObjectCreationOperation creation:
				return await CreateObjectAsync(creation).ConfigureAwait(false);
			case IWithOperation with:
				return await CreateWithAsync(with).ConfigureAwait(false);
			case ICollectionExpressionOperation collection:
				return await CreateCollectionExpressionAsync(collection).ConfigureAwait(false);
			case IUtf8StringOperation utf8:
				return await CreateUtf8StringAsync(utf8).ConfigureAwait(false);
			case IArrayCreationOperation array:
				return await CreateArrayAsync(array).ConfigureAwait(false);
			case IArrayElementReferenceOperation element: {
				var array = await EvalAsync(element.ArrayReference).ConfigureAwait(false);
				return await runtime.ReadElementAsync(array, await IndicesAsync(element.Indices).ConfigureAwait(false)).ConfigureAwait(false);
			}
			case IConversionOperation conversion:
				return await ConvertAsync(await EvalAsync(conversion.Operand).ConfigureAwait(false), conversion).ConfigureAwait(false);
			case IUnaryOperation unary:
				return await UnaryAsync(unary).ConfigureAwait(false);
			case IBinaryOperation binary:
				return await BinaryAsync(binary).ConfigureAwait(false);
			case IConditionalOperation conditional: {
				var condition = await EvalBooleanAsync(conditional.Condition).ConfigureAwait(false);
				var branch = condition ? conditional.WhenTrue : conditional.WhenFalse;
				return branch is null ? Scalar(runtime.Special(SpecialType.System_Void), null) : await EvalAsync(branch).ConfigureAwait(false);
			}
			case ICoalesceOperation coalesce: {
				var value = await EvalAsync(coalesce.Value).ConfigureAwait(false);
				if (!IsNullValue(value))
					return UnwrapNullable(value);
				return await EvalAsync(coalesce.WhenNull).ConfigureAwait(false);
			}
			case IConditionalAccessOperation access: {
				var receiver = await EvalAsync(access.Operation).ConfigureAwait(false);
				if (IsNullValue(receiver))
					return Scalar(access.Type ?? runtime.Object, null);
				conditionalAccess.Push(UnwrapNullable(receiver));
				try {
					return await EvalAsync(access.WhenNotNull).ConfigureAwait(false);
				}
				finally {
					conditionalAccess.Pop();
				}
			}
			case IConditionalAccessInstanceOperation:
				return conditionalAccess.Count > 0 ? conditionalAccess.Peek() : throw new EvaluationException("Invalid conditional access.");
			case IIsTypeOperation isType: {
				var value = await EvalAsync(isType.ValueOperand).ConfigureAwait(false);
				var matches = !IsNullValue(value) && IsInstanceOf(value, isType.TypeOperand);
				return Scalar(Bool, isType.IsNegated ? !matches : matches);
			}
			case IIsPatternOperation isPattern: {
				var value = await EvalAsync(isPattern.Value).ConfigureAwait(false);
				return Scalar(Bool, await MatchAsync(value, isPattern.Pattern).ConfigureAwait(false));
			}
			case ISwitchExpressionOperation switchExpression: {
				var value = await EvalAsync(switchExpression.Value).ConfigureAwait(false);
				foreach (var arm in switchExpression.Arms) {
					if (!await MatchAsync(value, arm.Pattern).ConfigureAwait(false))
						continue;
					if (arm.Guard is not null && !await EvalBooleanAsync(arm.Guard).ConfigureAwait(false))
						continue;
					return await EvalAsync(arm.Value).ConfigureAwait(false);
				}
				throw new EvaluationException("The switch expression does not handle the value.");
			}
			case IDefaultValueOperation defaultValue:
				return await runtime.DefaultValueAsync(defaultValue.Type ?? runtime.Object).ConfigureAwait(false);
			case ITypeOfOperation typeOf:
				return await TypeObjectAsync(typeOf.TypeOperand).ConfigureAwait(false);
			case ISizeOfOperation sizeOf:
				return Scalar(runtime.Special(SpecialType.System_Int32), SizeOf(sizeOf.TypeOperand));
			case ISimpleAssignmentOperation assignment: {
				var value = await EvalAsync(assignment.Value).ConfigureAwait(false);
				await AssignAsync(assignment.Target, value).ConfigureAwait(false);
				return value;
			}
			case ICompoundAssignmentOperation compound: {
				var current = await EvalAsync(compound.Target).ConfigureAwait(false);
				var right = await EvalAsync(compound.Value).ConfigureAwait(false);
				var left = compound.InConversion.Exists && !compound.InConversion.IsIdentity && compound.Target.Type is not null
					? ConvertNumeric(current, compound.Value.Type ?? compound.Target.Type, compound.IsChecked)
					: current;
				var result = compound.OperatorMethod is not null
					? await runtime.CallAsync(compound.OperatorMethod, null, [left, right]).ConfigureAwait(false)
					: await ApplyBinaryAsync(compound.OperatorKind, left, right, compound.Value.Type ?? left.Type, compound.IsChecked, isNullLifted: false).ConfigureAwait(false);
				if (compound.Target.Type is not null && result is ScalarValue { Value: not null and not string } && compound.Target.Type.SpecialType != SpecialType.None)
					result = ConvertNumeric(result, compound.Target.Type, compound.IsChecked);
				await AssignAsync(compound.Target, result).ConfigureAwait(false);
				return result;
			}
			case IIncrementOrDecrementOperation increment: {
				var current = await EvalAsync(increment.Target).ConfigureAwait(false);
				var type = increment.Target.Type ?? current.Type;
				EvalValue updated;
				if (increment.OperatorMethod is not null)
					updated = await runtime.CallAsync(increment.OperatorMethod, null, [current]).ConfigureAwait(false);
				else {
					var raw = ((ScalarValue)current).Value ?? throw new EvaluationException("The value is null.");
					var one = Arithmetic.Convert(1, raw is char ? SpecialType.System_Int32 : SpecialTypeOfValue(raw), false);
					var kind = increment.Kind == OperationKind.Increment ? BinaryOperatorKind.Add : BinaryOperatorKind.Subtract;
					var left = raw is char c ? (int)c : raw;
					var result = Arithmetic.Binary(kind, left, raw is char ? 1 : one, increment.IsChecked);
					updated = Scalar(type, raw is char ? Arithmetic.Convert(result, SpecialType.System_Char, increment.IsChecked) : result);
				}
				await AssignAsync(increment.Target, updated).ConfigureAwait(false);
				return increment.IsPostfix ? current : updated;
			}
			case IInterpolatedStringOperation interpolated:
				return Scalar(runtime.String, await InterpolateAsync(interpolated).ConfigureAwait(false));
			case ITupleOperation tuple:
				return await CreateTupleAsync(tuple).ConfigureAwait(false);
			case INameOfOperation nameOf:
				return Scalar(runtime.String, nameOf.ConstantValue.Value);
			case IDynamicMemberReferenceOperation dynamicMember:
				return await ReadDynamicMemberAsync(await EvalAsync(dynamicMember.Instance!).ConfigureAwait(false), dynamicMember.MemberName).ConfigureAwait(false);
			case IDynamicIndexerAccessOperation dynamicIndexer: {
				var receiver = await EvalAsync(dynamicIndexer.Operation).ConfigureAwait(false);
				var arguments = new List<EvalValue>();
				foreach (var argument in dynamicIndexer.Arguments)
					arguments.Add(await EvalAsync(argument).ConfigureAwait(false));
				return await DynamicIndexAsync(receiver, arguments).ConfigureAwait(false);
			}
			case IDynamicInvocationOperation dynamicInvocation:
				return await InvokeDynamicAsync(dynamicInvocation).ConfigureAwait(false);
			case IAnonymousFunctionOperation or IDelegateCreationOperation or IMethodReferenceOperation:
				throw new EvaluationException("Expression cannot contain lambda expressions.");
			case IAwaitOperation:
				throw new EvaluationException("'await' cannot be used in an expression that is evaluated by the debugger.");
			case IThrowOperation:
				throw new EvaluationException("'throw' cannot be used in an expression that is evaluated by the debugger.");
			case IInvalidOperation invalid:
				return await EvalInvalidAsync(invalid).ConfigureAwait(false);
			case IArgumentOperation argument:
				return await EvalAsync(argument.Value).ConfigureAwait(false);
			case IObjectOrCollectionInitializerOperation:
				throw new EvaluationException("An initializer is only valid as part of an object creation.");
			default:
				throw new EvaluationException($"The expression contains a construct the debugger cannot evaluate ({operation.Kind}).");
		}
	}

	// ---------------------------------------------------------------- names

	async Task<EvalValue> ReadParameterAsync(IParameterSymbol parameter) {
		if (SymbolEqualityComparer.Default.Equals(parameter, compiled.ThisParameter))
			return await ReadThisAsync().ConfigureAwait(false);
		if (!compiled.Parameters.TryGetValue(parameter, out var variable))
			throw new EvaluationException($"The name '{parameter.Name}' does not exist in the current context.");
		return await ReadVariableAsync(variable).ConfigureAwait(false);
	}

	async Task<EvalValue> ReadVariableAsync(ContextVariable variable) => variable.Source switch {
		VariableSource.Local local => await runtime.ReadLocalAsync(local.Index, variable.Type).ConfigureAwait(false),
		VariableSource.Argument argument => await runtime.ReadArgumentAsync(argument.Index, variable.Type).ConfigureAwait(false),
		VariableSource.HoistedField hoisted => await runtime.ReadFieldAsync(await FrameThisAsync().ConfigureAwait(false), hoisted.Field).ConfigureAwait(false),
		VariableSource.Known value => value.Value,
		_ => throw new EvaluationException($"'{variable.Name}' cannot be read."),
	};

	/// <summary>The frame's own <c>this</c>: the closure or state machine a hoisted local lives in.</summary>
	async Task<EvalValue> FrameThisAsync() => cachedFrameThis ??= await runtime.ReadArgumentAsync(0, null).ConfigureAwait(false);

	Task<EvalValue> ReadThisAsync() {
		var source = shape.ThisSource ?? throw new EvaluationException("Keyword 'this' is not valid in a static context.");
		return ReadVariableAsync(new ContextVariable("this", shape.ThisType ?? runtime.Object, source));
	}

	internal async Task AssignAsync(IOperation target, EvalValue value) {
		switch (target) {
			case IParameterReferenceOperation parameter: {
				if (SymbolEqualityComparer.Default.Equals(parameter.Parameter, compiled.ThisParameter))
					throw new EvaluationException("Cannot assign to 'this'.");
				if (!compiled.Parameters.TryGetValue(parameter.Parameter, out var variable))
					throw new EvaluationException($"The name '{parameter.Parameter.Name}' does not exist in the current context.");
				switch (variable.Source) {
					case VariableSource.Local local:
						await runtime.WriteLocalAsync(local.Index, value).ConfigureAwait(false);
						return;
					case VariableSource.Argument argument:
						await runtime.WriteArgumentAsync(argument.Index, value).ConfigureAwait(false);
						return;
					case VariableSource.HoistedField hoisted:
						await runtime.WriteFieldAsync(await FrameThisAsync().ConfigureAwait(false), hoisted.Field, value).ConfigureAwait(false);
						return;
					default:
						throw new EvaluationException($"'{variable.Name}' cannot be assigned to.");
				}
			}
			case IFieldReferenceOperation field:
				await runtime.WriteFieldAsync(field.Instance is null ? null : await EvalAsync(field.Instance).ConfigureAwait(false), field.Field, value).ConfigureAwait(false);
				return;
			case IArrayElementReferenceOperation element: {
				var array = await EvalAsync(element.ArrayReference).ConfigureAwait(false);
				await runtime.WriteElementAsync(array, await IndicesAsync(element.Indices).ConfigureAwait(false), value).ConfigureAwait(false);
				return;
			}
			case IPropertyReferenceOperation property: {
				var setter = property.Property.SetMethod ?? throw new EvaluationException($"Property or indexer '{property.Property.Name}' cannot be assigned to -- it is read only.");
				var instance = property.Instance is null ? null : await EvalAsync(property.Instance).ConfigureAwait(false);
				var arguments = await ArgumentsAsync(property.Arguments).ConfigureAwait(false);
				arguments.Add(value);
				await runtime.CallAsync(setter, instance, arguments, property.Property.Name).ConfigureAwait(false);
				return;
			}
			case IConversionOperation conversion:
				await AssignAsync(conversion.Operand, value).ConfigureAwait(false);
				return;
			default:
				throw new EvaluationException("The left-hand side of an assignment must be a variable, property or indexer.");
		}
	}

	// ---------------------------------------------------------------- members and calls

	async Task<EvalValue> ReadPropertyAsync(IPropertyReferenceOperation property, EvalValue? instanceOverride = null) {
		var instance = property.Instance is null ? instanceOverride : await EvalAsync(property.Instance).ConfigureAwait(false);
		var symbol = property.Property;
		// An anonymous object is held by the evaluator: its properties are values it already has.
		if (instance is AnonymousValue anonymous && property.Arguments.Length == 0 && anonymous.Members.TryGetValue(symbol.Name, out var known))
			return known;
		// What the evaluator can answer without running code in the debuggee, it does: these are read by
		// every variables window, and a func-eval each would be both slow and needlessly intrusive.
		if (instance is not null && property.Arguments.Length == 0) {
			if (instance is ScalarValue { Value: string text } && symbol.Name == "Length" && symbol.ContainingType.SpecialType == SpecialType.System_String)
				return Scalar(runtime.Special(SpecialType.System_Int32), text.Length);
			if (instance is RemoteValue { Type: IArrayTypeSymbol } array && symbol.ContainingType.SpecialType == SpecialType.System_Array && symbol.Name is "Length" or "LongLength" or "Rank") {
				var (dimensions, _) = await runtime.ReadArrayShapeAsync(array).ConfigureAwait(false);
				return symbol.Name switch {
					"Rank" => Scalar(runtime.Special(SpecialType.System_Int32), dimensions.Length),
					"LongLength" => Scalar(runtime.Special(SpecialType.System_Int64), dimensions.Aggregate(1L, (total, length) => total * length)),
					_ => Scalar(runtime.Special(SpecialType.System_Int32), (int)dimensions.Aggregate(1L, (total, length) => total * length)),
				};
			}
			if (symbol.ContainingType.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T) {
				if (symbol.Name == "HasValue")
					return Scalar(Bool, !IsNullValue(instance));
				if (symbol.Name == "Value")
					return IsNullValue(instance) ? throw new EvaluationException("Nullable object must have a value.") : UnwrapNullable(instance);
			}
		}
		var getter = symbol.GetMethod ?? throw new EvaluationException($"The property or indexer '{symbol.Name}' cannot be used in this context because it lacks the get accessor.");
		var arguments = await ArgumentsAsync(property.Arguments).ConfigureAwait(false);
		return await runtime.CallAsync(getter, instance, arguments, symbol.Name).ConfigureAwait(false);
	}

	async Task<EvalValue> InvokeAsync(IInvocationOperation invocation) {
		var method = invocation.TargetMethod;
		var instance = invocation.Instance is null ? null : await EvalAsync(invocation.Instance).ConfigureAwait(false);
		var arguments = await ArgumentsAsync(invocation.Arguments).ConfigureAwait(false);
		// String.Concat and friends on values the evaluator already holds need no func-eval.
		if (method.ContainingType.SpecialType == SpecialType.System_String && method.IsStatic && method.Name == "Concat" && arguments.All(argument => argument is ScalarValue)) {
			var parts = new List<string>();
			foreach (var argument in arguments)
				parts.Add(await ToStringAsync(argument).ConfigureAwait(false));
			return Scalar(runtime.String, string.Concat(parts));
		}
		if (instance is not null && method.IsExtensionMethod && method.ReducedFrom is not null)
			return await runtime.CallAsync(method, instance, arguments, method.Name).ConfigureAwait(false);
		return await runtime.CallAsync(method, instance, arguments, method.Name).ConfigureAwait(false);
	}

	async Task<List<EvalValue>> ArgumentsAsync(IEnumerable<IArgumentOperation> arguments) {
		var values = new List<EvalValue>();
		// The bound arguments are in parameter order once named arguments are put in place.
		foreach (var argument in arguments.OrderBy(argument => argument.Parameter?.Ordinal ?? 0)) {
			if (argument.ArgumentKind == ArgumentKind.DefaultValue && argument.Value.ConstantValue.HasValue && argument.Value.Type is not null) {
				values.Add(Scalar(argument.Value.Type, EvalRuntime.ConvertConstant(argument.Value.ConstantValue.Value, argument.Value.Type)));
				continue;
			}
			values.Add(await EvalAsync(argument.Value).ConfigureAwait(false));
		}
		return values;
	}

	async Task<EvalValue> CreateObjectAsync(IObjectCreationOperation creation) {
		var type = creation.Type ?? throw new EvaluationException("The type of the new object is unknown.");
		EvalValue value;
		if (creation.Constructor is null || (type.IsValueType && creation.Constructor.Parameters.Length == 0 && creation.Constructor.IsImplicitlyDeclared))
			value = await runtime.DefaultValueAsync(type).ConfigureAwait(false);
		else {
			var arguments = await ArgumentsAsync(creation.Arguments).ConfigureAwait(false);
			value = await runtime.NewObjectAsync(creation.Constructor, arguments).ConfigureAwait(false);
		}
		// new Foo { X = 1 }, new List<int> { 1, 2 }: the constructor first, then the setters and Add calls.
		if (creation.Initializer is { Initializers.Length: > 0 } initializer)
			await ApplyInitializerAsync(value, initializer).ConfigureAwait(false);
		return value;
	}

	/// <summary>
	/// Runs an object or collection initializer over the object its constructor made. WPF's IL
	/// interpreter executes the same setters and Add calls the compiler emitted for these initializers.
	/// </summary>
	async Task ApplyInitializerAsync(EvalValue instance, IObjectOrCollectionInitializerOperation initializer) {
		foreach (var item in initializer.Initializers) {
			switch (item) {
				// Object initializer members are assignments whose target is the object under construction;
				// their Instance is not the frame's this, so the setters are called on it directly.
				case ISimpleAssignmentOperation assignment:
					await ApplyInitializerAssignmentAsync(instance, assignment).ConfigureAwait(false);
					break;
				case IFieldInitializerOperation field:
					if (field.InitializedFields.Length == 0)
						throw new EvaluationException("The field initializer names no field.");
					await runtime.WriteFieldAsync(instance, field.InitializedFields[0], await EvalAsync(field.Value).ConfigureAwait(false)).ConfigureAwait(false);
					break;
				case IPropertyInitializerOperation property: {
					if (property.InitializedProperties.Length == 0)
						throw new EvaluationException("The property initializer names no property.");
					var setter = property.InitializedProperties[0].SetMethod
						?? throw new EvaluationException($"Property '{property.InitializedProperties[0].Name}' is read only.");
					await runtime.CallAsync(setter, instance, [await EvalAsync(property.Value).ConfigureAwait(false)], property.InitializedProperties[0].Name).ConfigureAwait(false);
					break;
				}
				case IInvocationOperation add: {
					// A collection initializer's Add call has no receiver of its own; the object is the one made above.
					var arguments = await ArgumentsAsync(add.Arguments).ConfigureAwait(false);
					await runtime.CallAsync(add.TargetMethod, instance, arguments, add.TargetMethod.Name).ConfigureAwait(false);
					break;
				}
				case IObjectOrCollectionInitializerOperation nested: {
					// { { 1, 2 } } adds an element built by its own initializer: the matching Add takes a
					// collection whose element type we can instantiate, so build one and add it.
					var add = instance.Type.GetMembers("Add").OfType<IMethodSymbol>().FirstOrDefault(method => method.Parameters.Length == 1)
						?? throw new EvaluationException("The collection has no Add method.");
					var elementType = add.Parameters[0].Type;
					var element = elementType.IsValueType
						? await runtime.DefaultValueAsync(elementType).ConfigureAwait(false)
						: await runtime.NewObjectAsync((elementType as INamedTypeSymbol)?.InstanceConstructors.FirstOrDefault(candidate => candidate.Parameters.Length == 0) ?? throw new EvaluationException("The element type has no parameterless constructor."), []).ConfigureAwait(false);
					await ApplyInitializerAsync(element, nested).ConfigureAwait(false);
					await runtime.CallAsync(add, instance, [element], "Add").ConfigureAwait(false);
					break;
				}
				default:
					throw new EvaluationException($"The initializer contains an entry the debugger cannot evaluate ({item.Kind}).");
			}
		}
	}

	async Task ApplyInitializerAssignmentAsync(EvalValue instance, ISimpleAssignmentOperation assignment) {
		var value = await EvalAsync(assignment.Value).ConfigureAwait(false);
		switch (assignment.Target) {
			case IFieldReferenceOperation field:
				await runtime.WriteFieldAsync(instance, field.Field, value).ConfigureAwait(false);
				return;
			case IPropertyReferenceOperation property: {
				var setter = property.Property.SetMethod ?? throw new EvaluationException($"Property '{property.Property.Name}' is read only.");
				var arguments = await ArgumentsAsync(property.Arguments).ConfigureAwait(false);
				arguments.Add(value);
				await runtime.CallAsync(setter, instance, arguments, property.Property.Name).ConfigureAwait(false);
				return;
			}
			default:
				throw new EvaluationException($"The initializer assigns to a member the debugger cannot write ({assignment.Target.Kind}).");
		}
	}

	/// <summary>new { X = 1 }: an object the evaluator holds itself, since its type is not in the debuggee.</summary>
	async Task<EvalValue> CreateAnonymousObjectAsync(IAnonymousObjectCreationOperation anonymous) {
		var type = anonymous.Type ?? throw new EvaluationException("The anonymous type is unknown.");
		var members = new Dictionary<string, EvalValue>(StringComparer.Ordinal);
		foreach (var initializer in anonymous.Initializers) {
			var name = initializer switch {
				ISimpleAssignmentOperation assignment when assignment.Target is IPropertyReferenceOperation property => property.Property.Name,
				IPropertyReferenceOperation property => property.Property.Name,
				_ => null,
			};
			if (name is null)
				throw new EvaluationException("The anonymous type could not be created.");
			members[name] = await EvalAsync(initializer is ISimpleAssignmentOperation assignment2 ? assignment2.Value : initializer).ConfigureAwait(false);
		}
		return new AnonymousValue(type, members);
	}

	/// <summary>record with { X = 1 }: the clone method, then the initializer over the copy.</summary>
	async Task<EvalValue> CreateWithAsync(IWithOperation with) {
		var operand = await EvalAsync(with.Operand).ConfigureAwait(false);
		if (with.CloneMethod is null)
			throw new EvaluationException("The record's clone method is not available.");
		var clone = await runtime.CallAsync(with.CloneMethod, operand, [], "with").ConfigureAwait(false);
		if (with.Initializer is { Initializers.Length: > 0 } initializer)
			await ApplyInitializerAsync(clone, initializer).ConfigureAwait(false);
		return clone;
	}

	/// <summary>"abc"u8: the UTF-8 bytes as a byte[] the evaluator builds itself.</summary>
	async Task<EvalValue> CreateUtf8StringAsync(IUtf8StringOperation utf8) {
		var bytes = Encoding.UTF8.GetBytes(utf8.Value ?? string.Empty);
		var array = await runtime.NewArrayAsync(runtime.Special(SpecialType.System_Byte), [bytes.Length]).ConfigureAwait(false);
		for (var index = 0; index < bytes.Length; index++)
			await runtime.WriteElementAsync(array, [index], Scalar(runtime.Special(SpecialType.System_Byte), bytes[index])).ConfigureAwait(false);
		return array;
	}

	/// <summary>[1, 2, 3]: an array target is filled in place, a collection target gets its elements through Add.</summary>
	async Task<EvalValue> CreateCollectionExpressionAsync(ICollectionExpressionOperation collection) {
		var type = collection.Type ?? throw new EvaluationException("The collection type is unknown.");
		var values = new List<EvalValue>();
		foreach (var element in collection.Elements)
			values.Add(await EvalAsync(element).ConfigureAwait(false));
		if (type is IArrayTypeSymbol arrayType) {
			var array = await runtime.NewArrayAsync(arrayType.ElementType, [values.Count]).ConfigureAwait(false);
			for (var index = 0; index < values.Count; index++)
				await runtime.WriteElementAsync(array, [index], values[index]).ConfigureAwait(false);
			return array;
		}
		var constructor = (type as INamedTypeSymbol)?.InstanceConstructors.FirstOrDefault(candidate => candidate.Parameters.Length == 0)
			?? throw new EvaluationException("A collection expression needs a collection with a parameterless constructor.");
		var instance = await runtime.NewObjectAsync(constructor, []).ConfigureAwait(false);
		var add = type.GetMembers("Add").OfType<IMethodSymbol>().FirstOrDefault(method => method.Parameters.Length == 1)
			?? throw new EvaluationException("The collection has no Add method.");
		foreach (var value in values)
			await runtime.CallAsync(add, instance, [value], "Add").ConfigureAwait(false);
		return instance;
	}

	async Task<EvalValue> CreateArrayAsync(IArrayCreationOperation creation) {
		var arrayType = creation.Type as IArrayTypeSymbol ?? throw new EvaluationException("The array type is unknown.");
		var lengths = new List<int>();
		foreach (var size in creation.DimensionSizes) {
			var value = await EvalAsync(size).ConfigureAwait(false);
			lengths.Add((int)Arithmetic.Convert(((ScalarValue)value).Value ?? 0, SpecialType.System_Int32, true));
		}
		var array = await runtime.NewArrayAsync(arrayType.ElementType, lengths).ConfigureAwait(false);
		if (creation.Initializer is { } initializer)
			await FillArrayAsync(array, initializer, []).ConfigureAwait(false);
		return array;
	}

	async Task FillArrayAsync(EvalValue array, IArrayInitializerOperation initializer, List<long> prefix) {
		for (var index = 0; index < initializer.ElementValues.Length; index++) {
			var indices = new List<long>(prefix) { index };
			if (initializer.ElementValues[index] is IArrayInitializerOperation nested)
				await FillArrayAsync(array, nested, indices).ConfigureAwait(false);
			else
				await runtime.WriteElementAsync(array, indices, await EvalAsync(initializer.ElementValues[index]).ConfigureAwait(false)).ConfigureAwait(false);
		}
	}

	async Task<List<long>> IndicesAsync(IEnumerable<IOperation> indices) {
		var result = new List<long>();
		foreach (var index in indices) {
			var value = await EvalAsync(index).ConfigureAwait(false);
			result.Add((long)Arithmetic.Convert(((ScalarValue)value).Value ?? 0, SpecialType.System_Int64, true));
		}
		return result;
	}

	async Task<EvalValue> CreateTupleAsync(ITupleOperation tuple) {
		var type = tuple.Type as INamedTypeSymbol ?? throw new EvaluationException("The tuple type is unknown.");
		var underlying = type.TupleUnderlyingType ?? type;
		var constructor = underlying.InstanceConstructors.FirstOrDefault(ctor => ctor.Parameters.Length == tuple.Elements.Length)
			?? throw new EvaluationException("The tuple could not be created.");
		var elements = new List<EvalValue>();
		foreach (var element in tuple.Elements)
			elements.Add(await EvalAsync(element).ConfigureAwait(false));
		return await runtime.NewObjectAsync(constructor, elements).ConfigureAwait(false);
	}

	async Task<EvalValue> TypeObjectAsync(ITypeSymbol type) {
		var getType = runtime.Compilation.GetTypeByMetadataName("System.Type")?.GetMembers("GetType").OfType<IMethodSymbol>()
			.FirstOrDefault(method => method.IsStatic && method.Parameters.Length == 1 && method.Parameters[0].Type.SpecialType == SpecialType.System_String)
			?? throw new EvaluationException("System.Type is not available.");
		return await runtime.CallAsync(getType, null, [Scalar(runtime.String, ReflectionName(type, includeAssembly: true))], "typeof").ConfigureAwait(false);
	}

	/// <summary>The name <c>Type.GetType</c> reads a type back from.</summary>
	internal static string ReflectionName(ITypeSymbol type, bool includeAssembly) {
		switch (type) {
			case IArrayTypeSymbol array:
				return ReflectionName(array.ElementType, false) + (array.IsSZArray ? "[]" : "[" + new string(',', array.Rank - 1) + "]") + AssemblySuffix(array.ElementType, includeAssembly);
			case IPointerTypeSymbol pointer:
				return ReflectionName(pointer.PointedAtType, false) + "*" + AssemblySuffix(pointer.PointedAtType, includeAssembly);
			case INamedTypeSymbol named: {
				var definition = named.OriginalDefinition;
				var name = definition.MetadataName;
				var outer = definition.ContainingType;
				var full = outer is not null
					? ReflectionName(outer.OriginalDefinition, false) + "+" + name
					: (definition.ContainingNamespace is { IsGlobalNamespace: false } ns ? ns.ToDisplayString() + "." : string.Empty) + name;
				var arguments = DebuggeeTypeSystem.AllTypeArguments(named);
				if (arguments.Count > 0 && !SymbolEqualityComparer.Default.Equals(named, definition))
					full += "[" + string.Join(",", arguments.Select(argument => "[" + ReflectionName(argument, true) + "]")) + "]";
				return full + AssemblySuffix(named, includeAssembly);
			}
			default:
				return type.ToDisplayString();
		}
	}

	static string AssemblySuffix(ITypeSymbol type, bool includeAssembly) {
		if (!includeAssembly)
			return string.Empty;
		var element = type;
		while (element is IArrayTypeSymbol array)
			element = array.ElementType;
		return element.ContainingAssembly is { } assembly ? ", " + assembly.Identity.GetDisplayName() : string.Empty;
	}

	static int SizeOf(ITypeSymbol type) => type.SpecialType switch {
		SpecialType.System_Boolean or SpecialType.System_Byte or SpecialType.System_SByte => 1,
		SpecialType.System_Char or SpecialType.System_Int16 or SpecialType.System_UInt16 => 2,
		SpecialType.System_Int32 or SpecialType.System_UInt32 or SpecialType.System_Single => 4,
		SpecialType.System_Int64 or SpecialType.System_UInt64 or SpecialType.System_Double => 8,
		SpecialType.System_Decimal => 16,
		SpecialType.System_IntPtr or SpecialType.System_UIntPtr => IntPtr.Size,
		_ => throw new EvaluationException($"sizeof({type.ToDisplayString()}) is not a constant the debugger knows."),
	};

	// ---------------------------------------------------------------- dynamic

	/// <summary>
	/// A member of a value whose type the source could not name — a closure, a state machine, an anonymous
	/// type — looked up by name on its runtime type: a field first, then a property.
	/// </summary>
	async Task<EvalValue> ReadDynamicMemberAsync(EvalValue instance, string name) {
		if (IsNullValue(instance))
			throw new EvaluationException("Object reference not set to an instance of an object.");
		for (var type = instance.Type as INamedTypeSymbol; type is not null; type = type.BaseType) {
			foreach (var member in type.GetMembers()) {
				if (!string.Equals(member.Name, name, isVisualBasic ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
					continue;
				switch (member) {
					case IFieldSymbol field:
						return await runtime.ReadFieldAsync(instance, field).ConfigureAwait(false);
					case IPropertySymbol { GetMethod: { } getter, Parameters.Length: 0 }:
						return await runtime.CallAsync(getter, instance, [], name).ConfigureAwait(false);
				}
			}
			// An anonymous type's property is backed by "<Name>i__Field".
			var backing = type.GetMembers($"<{name}>i__Field").OfType<IFieldSymbol>().FirstOrDefault();
			if (backing is not null)
				return await runtime.ReadFieldAsync(instance, backing).ConfigureAwait(false);
		}
		throw new EvaluationException($"'{instance.Type.ToDisplayString()}' does not contain a definition for '{name}'.");
	}

	async Task<EvalValue> DynamicIndexAsync(EvalValue receiver, IReadOnlyList<EvalValue> arguments) {
		if (receiver.Type is IArrayTypeSymbol) {
			var indices = arguments.Select(argument => (long)Arithmetic.Convert(((ScalarValue)argument).Value ?? 0, SpecialType.System_Int64, true)).ToArray();
			return await runtime.ReadElementAsync(receiver, indices).ConfigureAwait(false);
		}
		for (var type = receiver.Type as INamedTypeSymbol; type is not null; type = type.BaseType) {
			var indexer = type.GetMembers().OfType<IPropertySymbol>().FirstOrDefault(property => property.IsIndexer && property.Parameters.Length == arguments.Count && property.GetMethod is not null);
			if (indexer is not null)
				return await runtime.CallAsync(indexer.GetMethod!, receiver, arguments, "this[]").ConfigureAwait(false);
		}
		throw new EvaluationException($"Cannot apply indexing to a value of type '{receiver.Type.ToDisplayString()}'.");
	}

	async Task<EvalValue> InvokeDynamicAsync(IDynamicInvocationOperation invocation) {
		if (invocation.Operation is not IDynamicMemberReferenceOperation member || member.Instance is null)
			throw new EvaluationException("The dynamic call cannot be evaluated.");
		var receiver = await EvalAsync(member.Instance).ConfigureAwait(false);
		var arguments = new List<EvalValue>();
		foreach (var argument in invocation.Arguments)
			arguments.Add(await EvalAsync(argument).ConfigureAwait(false));
		for (var type = receiver.Type as INamedTypeSymbol; type is not null; type = type.BaseType) {
			var method = type.GetMembers(member.MemberName).OfType<IMethodSymbol>().FirstOrDefault(candidate => candidate.Parameters.Length == arguments.Count && !candidate.IsGenericMethod);
			if (method is not null)
				return await runtime.CallAsync(method, method.IsStatic ? null : receiver, arguments, method.Name).ConfigureAwait(false);
		}
		throw new EvaluationException($"'{receiver.Type.ToDisplayString()}' does not contain a method '{member.MemberName}' taking {arguments.Count} argument(s).");
	}

	/// <summary>
	/// A member access Visual Basic refused only because the member is not accessible: the candidate the
	/// compiler found is still the one the user means.
	/// </summary>
	async Task<EvalValue> EvalInvalidAsync(IInvalidOperation invalid) {
		var model = compiled.Model;
		var info = model?.GetSymbolInfo(invalid.Syntax);
		var candidate = info?.Symbol ?? (info?.CandidateSymbols.Length == 1 ? info.Value.CandidateSymbols[0] : null);
		var children = invalid.ChildOperations.ToArray();
		if (candidate is not null && info?.CandidateReason is CandidateReason.Inaccessible or CandidateReason.None) {
			var instance = children.Length > 0 && !candidate.IsStatic ? await EvalAsync(children[0]).ConfigureAwait(false) : null;
			var arguments = new List<EvalValue>();
			foreach (var child in children.Skip(candidate.IsStatic ? 0 : 1))
				arguments.Add(await EvalAsync(child).ConfigureAwait(false));
			switch (candidate) {
				case IFieldSymbol field:
					return await runtime.ReadFieldAsync(instance, field).ConfigureAwait(false);
				case IPropertySymbol { GetMethod: { } getter } property:
					return await runtime.CallAsync(getter, instance, arguments, property.Name).ConfigureAwait(false);
				case IMethodSymbol method:
					return await runtime.CallAsync(method, instance, arguments, method.Name).ConfigureAwait(false);
			}
		}
		var diagnostic = model?.GetDiagnostics(invalid.Syntax.Span).FirstOrDefault(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);
		throw new EvaluationException(diagnostic?.GetMessage() ?? "The expression is not valid.");
	}

	// ---------------------------------------------------------------- operators

	async Task<bool> EvalBooleanAsync(IOperation operation) {
		var value = await EvalAsync(operation).ConfigureAwait(false);
		return value is ScalarValue { Value: bool b } ? b : throw new EvaluationException("The expression does not evaluate to a boolean.");
	}

	async Task<EvalValue> UnaryAsync(IUnaryOperation unary) {
		var operand = await EvalAsync(unary.Operand).ConfigureAwait(false);
		if (unary.OperatorMethod is not null)
			return await runtime.CallAsync(unary.OperatorMethod, null, [operand]).ConfigureAwait(false);
		if (IsNullValue(operand) && unary.IsLifted)
			return Scalar(unary.Type ?? operand.Type, null);
		var raw = (UnwrapNullable(operand) as ScalarValue)?.Value ?? throw new EvaluationException("The operand has no value.");
		var result = Arithmetic.Unary(unary.OperatorKind, raw, unary.IsChecked);
		var type = unary.Type ?? operand.Type;
		return Scalar(type is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } nullable ? nullable.TypeArguments[0] : type, result);
	}

	async Task<EvalValue> BinaryAsync(IBinaryOperation binary) {
		// && and || (AndAlso, OrElse) only look at their right side when they need to.
		if (binary.OperatorMethod is null && binary.OperatorKind is BinaryOperatorKind.ConditionalAnd or BinaryOperatorKind.ConditionalOr) {
			var left = await EvalBooleanAsync(binary.LeftOperand).ConfigureAwait(false);
			if (binary.OperatorKind == BinaryOperatorKind.ConditionalAnd && !left)
				return Scalar(Bool, false);
			if (binary.OperatorKind == BinaryOperatorKind.ConditionalOr && left)
				return Scalar(Bool, true);
			return Scalar(Bool, await EvalBooleanAsync(binary.RightOperand).ConfigureAwait(false));
		}
		var leftValue = await EvalAsync(binary.LeftOperand).ConfigureAwait(false);
		var rightValue = await EvalAsync(binary.RightOperand).ConfigureAwait(false);
		if (binary.OperatorMethod is { } method && !IsLocallyComputable(method))
			return await runtime.CallAsync(method, null, [leftValue, rightValue], method.Name).ConfigureAwait(false);
		return await ApplyBinaryAsync(binary.OperatorKind, leftValue, rightValue, binary.LeftOperand.Type ?? leftValue.Type, binary.IsChecked, binary.IsLifted, binary.Type).ConfigureAwait(false);
	}

	/// <summary>The operators of string and decimal, which the evaluator computes itself.</summary>
	static bool IsLocallyComputable(IMethodSymbol method) =>
		method.ContainingType.SpecialType is SpecialType.System_String or SpecialType.System_Decimal
		|| method.ContainingType.ToDisplayString() == "Microsoft.VisualBasic.CompilerServices.Operators";

	async Task<EvalValue> ApplyBinaryAsync(BinaryOperatorKind kind, EvalValue left, EvalValue right, ITypeSymbol operandType, bool isChecked, bool isNullLifted, ITypeSymbol? resultType = null) {
		var boolType = Bool;
		var isComparison = kind is BinaryOperatorKind.Equals or BinaryOperatorKind.NotEquals or BinaryOperatorKind.ObjectValueEquals or BinaryOperatorKind.ObjectValueNotEquals
			or BinaryOperatorKind.LessThan or BinaryOperatorKind.LessThanOrEqual or BinaryOperatorKind.GreaterThan or BinaryOperatorKind.GreaterThanOrEqual;
		// String concatenation: the + of C# and the & of Visual Basic.
		if (kind == BinaryOperatorKind.Concatenate || (kind == BinaryOperatorKind.Add && (left.Type.SpecialType == SpecialType.System_String || right.Type.SpecialType == SpecialType.System_String || operandType.SpecialType == SpecialType.System_String)))
			return Scalar(runtime.String, await ToStringAsync(left).ConfigureAwait(false) + await ToStringAsync(right).ConfigureAwait(false));
		// Reference equality and comparisons with null.
		if (kind is BinaryOperatorKind.Equals or BinaryOperatorKind.NotEquals or BinaryOperatorKind.ObjectValueEquals or BinaryOperatorKind.ObjectValueNotEquals) {
			var leftNull = IsNullValue(left);
			var rightNull = IsNullValue(right);
			if (leftNull || rightNull || left is RemoteValue || right is RemoteValue) {
				bool equal;
				if (leftNull || rightNull)
					equal = leftNull && rightNull;
				else if (left is ScalarValue { Value: string leftText } && right is ScalarValue { Value: string rightText })
					equal = string.Equals(leftText, rightText, StringComparison.Ordinal);
				else
					equal = await SameObjectAsync(left, right).ConfigureAwait(false);
				var negate = kind is BinaryOperatorKind.NotEquals or BinaryOperatorKind.ObjectValueNotEquals;
				return Scalar(boolType, negate ? !equal : equal);
			}
		}
		if (isNullLifted && (IsNullValue(left) || IsNullValue(right))) {
			// A lifted comparison with null is false (true for !=); lifted arithmetic is null.
			if (isComparison)
				return Scalar(boolType, kind is BinaryOperatorKind.NotEquals);
			return Scalar(resultType ?? operandType, null);
		}
		var leftRaw = (UnwrapNullable(left) as ScalarValue)?.Value;
		var rightRaw = (UnwrapNullable(right) as ScalarValue)?.Value;
		if (leftRaw is string leftString && rightRaw is string rightString) {
			var comparison = string.CompareOrdinal(leftString, rightString);
			return kind switch {
				BinaryOperatorKind.Equals or BinaryOperatorKind.ObjectValueEquals => Scalar(boolType, comparison == 0),
				BinaryOperatorKind.NotEquals or BinaryOperatorKind.ObjectValueNotEquals => Scalar(boolType, comparison != 0),
				BinaryOperatorKind.LessThan => Scalar(boolType, comparison < 0),
				BinaryOperatorKind.LessThanOrEqual => Scalar(boolType, comparison <= 0),
				BinaryOperatorKind.GreaterThan => Scalar(boolType, comparison > 0),
				BinaryOperatorKind.GreaterThanOrEqual => Scalar(boolType, comparison >= 0),
				_ => throw new EvaluationException($"Operator '{kind}' cannot be applied to strings."),
			};
		}
		if (leftRaw is null || rightRaw is null)
			throw new EvaluationException("The operands of the operator have no value.");
		// Visual Basic's / always divides as floating point, and its \ as integers; the bound tree already
		// converted the operands, so only the kind has to be honoured.
		var result = Arithmetic.Binary(kind, leftRaw, rightRaw, isChecked);
		if (isComparison)
			return Scalar(boolType, result);
		var type = resultType ?? operandType;
		if (type is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } nullable)
			type = nullable.TypeArguments[0];
		return Scalar(type, result);
	}

	/// <summary>Whether two values are the same object, which is what == means on references.</summary>
	async Task<bool> SameObjectAsync(EvalValue left, EvalValue right) {
		var leftRemote = left as RemoteValue ?? (left as ScalarValue)?.Origin;
		var rightRemote = right as RemoteValue ?? (right as ScalarValue)?.Origin;
		if (leftRemote is null || rightRemote is null)
			return false;
		return await runtime.OnDispatcher(() => {
			var leftAddress = leftRemote.Ref.Handle is { } leftHandle ? ValueReader.ReadReferenceAddress(leftHandle) : leftRemote.Object.Address.Value;
			var rightAddress = rightRemote.Ref.Handle is { } rightHandle ? ValueReader.ReadReferenceAddress(rightHandle) : rightRemote.Object.Address.Value;
			return leftAddress == rightAddress;
		}).ConfigureAwait(false);
	}

	// ---------------------------------------------------------------- conversions

	async Task<EvalValue> ConvertAsync(EvalValue value, IConversionOperation conversion) {
		var target = conversion.Type ?? throw new EvaluationException("The conversion has no type.");
		var common = conversion.Conversion;
		if (common.IsIdentity)
			return value;
		if (common.IsUserDefined && common.MethodSymbol is { } method) {
			if (IsNullValue(value) && conversion.Operand.Type?.IsValueType == false)
				return Scalar(target, null);
			return await runtime.CallAsync(method, null, [value], method.Name).ConfigureAwait(false);
		}
		var targetIsNullable = target is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T };
		if (IsNullValue(value)) {
			if (target.IsValueType && !targetIsNullable)
				throw new EvaluationException("Nullable object must have a value.");
			return Scalar(target, null);
		}
		value = UnwrapNullable(value);
		var underlyingTarget = targetIsNullable ? ((INamedTypeSymbol)target).TypeArguments[0] : target;
		// A conversion between numeric types (or a numeric type and an enum) computes the new value.
		if (value is ScalarValue { Value: not null and not string } scalar && IsNumericLike(underlyingTarget)) {
			if (scalar.Type.TypeKind == TypeKind.Enum && underlyingTarget.TypeKind == TypeKind.Enum)
				return Scalar(underlyingTarget, scalar.Value);
			var special = underlyingTarget.TypeKind == TypeKind.Enum && underlyingTarget is INamedTypeSymbol { EnumUnderlyingType: { } underlying }
				? underlying.SpecialType
				: underlyingTarget.SpecialType;
			if (special == SpecialType.System_Boolean && scalar.Value is bool)
				return Scalar(underlyingTarget, scalar.Value);
			var raw = scalar.Value is bool flag && isVisualBasic ? (flag ? -1 : 0) : scalar.Value;
			return Scalar(underlyingTarget, Arithmetic.Convert(raw, special, conversion.IsChecked, roundToEven: isVisualBasic));
		}
		// To a reference type — a box, an interface, a base class — the value is what it was; only a narrowing
		// conversion has to check that the object really is of the type.
		if (!target.IsValueType || target.TypeKind == TypeKind.TypeParameter) {
			if (!common.IsImplicit && !IsInstanceOf(value, target)) {
				if (conversion.IsTryCast)
					return Scalar(target, null);
				throw new EvaluationException($"Unable to cast object of type '{value.Type.ToDisplayString()}' to type '{target.ToDisplayString()}'.");
			}
			return value;
		}
		// From a reference to a value type: an unbox, which only checks the type.
		if (!IsInstanceOf(value, underlyingTarget))
			throw new EvaluationException($"Unable to cast object of type '{value.Type.ToDisplayString()}' to type '{target.ToDisplayString()}'.");
		return value;
	}

	static bool IsNumericLike(ITypeSymbol type) => type.TypeKind == TypeKind.Enum || type.SpecialType is
		SpecialType.System_Boolean or SpecialType.System_Char or SpecialType.System_SByte or SpecialType.System_Byte or SpecialType.System_Int16
		or SpecialType.System_UInt16 or SpecialType.System_Int32 or SpecialType.System_UInt32 or SpecialType.System_Int64 or SpecialType.System_UInt64
		or SpecialType.System_Single or SpecialType.System_Double or SpecialType.System_Decimal or SpecialType.System_IntPtr or SpecialType.System_UIntPtr;

	ScalarValue ConvertNumeric(EvalValue value, ITypeSymbol target, bool isChecked) {
		var raw = (value as ScalarValue)?.Value ?? throw new EvaluationException("The value is null.");
		var special = target.TypeKind == TypeKind.Enum && target is INamedTypeSymbol { EnumUnderlyingType: { } underlying } ? underlying.SpecialType : target.SpecialType;
		return Scalar(target, Arithmetic.Convert(raw, special, isChecked, isVisualBasic));
	}

	static SpecialType SpecialTypeOfValue(object value) => value switch {
		sbyte => SpecialType.System_SByte,
		byte => SpecialType.System_Byte,
		short => SpecialType.System_Int16,
		ushort => SpecialType.System_UInt16,
		int => SpecialType.System_Int32,
		uint => SpecialType.System_UInt32,
		long => SpecialType.System_Int64,
		ulong => SpecialType.System_UInt64,
		float => SpecialType.System_Single,
		double => SpecialType.System_Double,
		decimal => SpecialType.System_Decimal,
		nint => SpecialType.System_IntPtr,
		nuint => SpecialType.System_UIntPtr,
		char => SpecialType.System_Char,
		_ => SpecialType.System_Int32,
	};

	/// <summary>Whether a value's runtime type converts to <paramref name="type"/> without loss — what <c>is</c> asks.</summary>
	bool IsInstanceOf(EvalValue value, ITypeSymbol type) {
		var actual = value.Type;
		if (SymbolEqualityComparer.Default.Equals(actual, type))
			return true;
		if (type.SpecialType == SpecialType.System_Object)
			return true;
		if (type is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } nullable)
			return SymbolEqualityComparer.Default.Equals(actual, nullable.TypeArguments[0]);
		var conversion = runtime.Compilation.ClassifyCommonConversion(actual, type);
		return conversion.Exists && conversion.IsImplicit && (conversion.IsReference || conversion.IsIdentity || (actual.IsValueType && !type.IsValueType));
	}

	// ---------------------------------------------------------------- nullable

	static bool IsNullValue(EvalValue value) => value.IsNull;

	/// <summary>A Nullable&lt;T&gt; read from the debuggee is a struct; its value is what operators work on.</summary>
	EvalValue UnwrapNullable(EvalValue value) {
		if (value is RemoteValue { Type: INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } } nullable)
			return ReadNullable(nullable) ?? Scalar(nullable.Type, null);
		return value;
	}

	EvalValue? ReadNullable(RemoteValue nullable) {
		var type = (INamedTypeSymbol)nullable.Type;
		var hasValue = type.GetMembers().OfType<IFieldSymbol>().FirstOrDefault(field => field.Name == "hasValue");
		var valueField = type.GetMembers().OfType<IFieldSymbol>().FirstOrDefault(field => field.Name == "value");
		if (hasValue is null || valueField is null)
			return null;
		var has = runtime.ReadFieldAsync(nullable, hasValue).GetAwaiter().GetResult();
		if (has is ScalarValue { Value: false })
			return null;
		return runtime.ReadFieldAsync(nullable, valueField).GetAwaiter().GetResult();
	}

	// ---------------------------------------------------------------- patterns

	async Task<bool> MatchAsync(EvalValue value, IPatternOperation pattern) {
		switch (pattern) {
			case IConstantPatternOperation constant: {
				var expected = await EvalAsync(constant.Value).ConfigureAwait(false);
				if (IsNullValue(expected))
					return IsNullValue(value);
				if (IsNullValue(value))
					return false;
				var left = (UnwrapNullable(value) as ScalarValue)?.Value;
				var right = (expected as ScalarValue)?.Value;
				if (left is null || right is null)
					return false;
				if (left is string || right is string)
					return Equals(left, right);
				return Arithmetic.Binary(BinaryOperatorKind.Equals, left, Arithmetic.IsIntegral(left) && Arithmetic.IsIntegral(right) ? Arithmetic.Convert(right, SpecialTypeOfValue(left), false) : right, false) is true;
			}
			case ITypePatternOperation typePattern:
				return !IsNullValue(value) && IsInstanceOf(value, typePattern.MatchedType);
			case IDeclarationPatternOperation declaration:
				// A declaration in an expression scopes its name to that expression; matching the type is
				// all an evaluated expression can observe.
				return !IsNullValue(value) && (declaration.MatchedType is null || IsInstanceOf(value, declaration.MatchedType));
			case IRecursivePatternOperation recursive: {
				if (recursive.MatchedType is { } matchedType && (IsNullValue(value) || !IsInstanceOf(value, matchedType)))
					return false;
				if (recursive.DeconstructionSubpatterns.Length > 0)
					throw new EvaluationException("A positional pattern is not supported by the evaluator.");
				foreach (var subpattern in recursive.PropertySubpatterns) {
					var member = subpattern.Member switch {
						IPropertyReferenceOperation property => await ReadPropertyAsync(property, property.Instance is null ? value : null).ConfigureAwait(false),
						IFieldReferenceOperation field => await runtime.ReadFieldAsync(field.Instance is null ? value : await EvalAsync(field.Instance).ConfigureAwait(false), field.Field).ConfigureAwait(false),
						_ => throw new EvaluationException("The property pattern names a member the debugger cannot read."),
					};
					if (!await MatchAsync(member, subpattern.Pattern).ConfigureAwait(false))
						return false;
				}
				return true;
			}
			case INegatedPatternOperation negated:
				return !await MatchAsync(value, negated.Pattern).ConfigureAwait(false);
			case IBinaryPatternOperation binary:
				return binary.OperatorKind == BinaryOperatorKind.And
					? await MatchAsync(value, binary.LeftPattern).ConfigureAwait(false) && await MatchAsync(value, binary.RightPattern).ConfigureAwait(false)
					: await MatchAsync(value, binary.LeftPattern).ConfigureAwait(false) || await MatchAsync(value, binary.RightPattern).ConfigureAwait(false);
			case IRelationalPatternOperation relational: {
				var bound = await EvalAsync(relational.Value).ConfigureAwait(false);
				if (IsNullValue(value))
					return false;
				var left = (UnwrapNullable(value) as ScalarValue)?.Value;
				var right = (bound as ScalarValue)?.Value;
				if (left is null || right is null)
					return false;
				return Arithmetic.Binary(relational.OperatorKind, left, Arithmetic.IsIntegral(left) ? Arithmetic.Convert(right, SpecialTypeOfValue(left), false) : right, false) is true;
			}
			case IDiscardPatternOperation:
				return true;
			default:
				throw new EvaluationException("The pattern is not supported by the evaluator.");
		}
	}

	// ---------------------------------------------------------------- strings

	async Task<string> InterpolateAsync(IInterpolatedStringOperation interpolated) {
		var builder = new System.Text.StringBuilder();
		foreach (var part in interpolated.Parts) {
			switch (part) {
				case IInterpolatedStringTextOperation text:
					builder.Append(text.Text.ConstantValue.Value as string);
					break;
				case IInterpolationOperation interpolation: {
					var value = await EvalAsync(interpolation.Expression).ConfigureAwait(false);
					var format = interpolation.FormatString?.ConstantValue.Value as string;
					var text = value is ScalarValue { Value: IFormattable formattable } && format is not null
						? formattable.ToString(format, System.Globalization.CultureInfo.InvariantCulture)
						: await ToStringAsync(value).ConfigureAwait(false);
					if (interpolation.Alignment?.ConstantValue.Value is int alignment)
						text = alignment < 0 ? text.PadRight(-alignment) : text.PadLeft(alignment);
					builder.Append(text);
					break;
				}
			}
		}
		return builder.ToString();
	}

	/// <summary>What <c>ToString()</c> returns for a value: computed for what the evaluator holds, called otherwise.</summary>
	async Task<string> ToStringAsync(EvalValue value) {
		if (value is ScalarValue { Value: null })
			return string.Empty;
		if (value is ScalarValue { Value: string text })
			return text;
		if (value is ScalarValue scalar && scalar.Type.TypeKind != TypeKind.Enum)
			return Arithmetic.ToConcatenationString(scalar.Value);
		var toString = runtime.Object.GetMembers("ToString").OfType<IMethodSymbol>().First(method => method.Parameters.Length == 0);
		var result = await runtime.CallAsync(toString, value, [], "ToString").ConfigureAwait(false);
		return result is ScalarValue { Value: string converted } ? converted : string.Empty;
	}
}
