using System.Globalization;
using System.Text.Json;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Debugging.CorDebug.Evaluation;
using ICorDebugSharp;
using ICorDebugSharp.Extensions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>
/// The variables windows and expression evaluation: Locals, Autos, Watch, Static Fields, the value of an
/// expression, editing a value, object ids. Every request runs under the evaluation lock, reads the frame it
/// is about on the dispatcher, binds and formats off it, and makes calls into the debuggee through func-eval.
/// </summary>
internal sealed partial class CorDebugSession {
	DebuggeeTypeSystem? typeSystem;
	ExpressionCompiler? expressionCompiler;
	readonly ObjectIdTable objectIds = new();

	/// <summary>The options the manager last received; sessions read them, they never own them.</summary>
	public DebuggerEngineOptions Options { get; set; } = DebuggerEngineOptions.Default;

	internal DebuggeeTypeSystem TypeSystem => typeSystem ??= new DebuggeeTypeSystem(Modules, ReadModuleImage);

	ExpressionCompiler Compiler => expressionCompiler ??= new ExpressionCompiler(TypeSystem);

	/// <summary>A module loaded from a byte array has no file; its image is read out of the process.</summary>
	byte[]? ReadModuleImage(ModuleTable.ModuleEntry entry) {
		if (entry.Address == 0 || entry.Size == 0)
			return null;
		return Dispatcher.Invoke(() => ReadMemoryCore(entry.Address, (int)entry.Size));
	}

	internal byte[]? ReadMemoryCore(ulong address, int size) {
		if (process is null)
			return null;
		try {
			var (bytes, read) = process.ReadMemory(new CORDB_ADDRESS(address), size);
			if (bytes is null)
				return null;
			var count = (int)read;
			return count == bytes.Length ? bytes : bytes.AsSpan(0, Math.Max(0, Math.Min(count, bytes.Length))).ToArray();
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return null;
		}
	}

	/// <summary>One request's view of a frame: the runtime to read it with, its names, and how to write values.</summary>
	internal sealed record EvaluationScope(EvalRuntime Runtime, FrameContext Frame, ValueFormatOptions FormatOptions, NodeFactory Factory);

	/// <summary>The formatter options the engine options and the window ask for.</summary>
	ValueFormatOptions FormatOptions() {
		var options = Options;
		return new ValueFormatOptions {
			Language = options.Language,
			Hexadecimal = options.UseHexadecimal,
			DigitSeparators = options.UseDigitSeparators,
			ShowNamespaces = options.ShowNamespaces,
			IntrinsicTypeKeywords = options.ShowIntrinsicTypeKeywords,
			ShowTokens = options.ShowTokens,
			FuncEval = options.PropertyEvalAndFunctionCalls,
			UseToString = options.PropertyEvalAndFunctionCalls && options.UseStringConversionFunction,
			ShowOnlyPublicMembers = options.ShowOnlyPublicMembers,
			HideCompilerGeneratedMembers = options.HideCompilerGeneratedMembers,
			RespectHideMemberAttributes = options.RespectHideMemberAttributes,
			HideDeprecatedError = options.HideDeprecatedError,
			RawView = options.ShowRawStructureOfObjects,
		};
	}

	/// <summary>
	/// Reads a frame and builds what evaluating in it needs. The frame is read on the dispatcher; its names
	/// come from the decompiler, off it.
	/// </summary>
	internal async Task<EvaluationScope> OpenScopeAsync(int threadId, int frameIndex, bool allowFuncEval, CancellationToken cancellationToken) {
		if (!IsStopped && !deciding)
			throw new EvaluationException("The process is running.");
		var types = TypeSystem;
		// The compilation is built here, off the dispatcher, so a module image never has to be read while
		// the dispatcher waits on itself.
		_ = types.BuiltVersion;
		var raw = await Dispatcher.RunAsync(() => ReadRawFrame(types, threadId, frameIndex)).ConfigureAwait(false);
		IReadOnlyList<DebugVariableNameDto> names = [];
		if (SymbolResolver is not null && raw.Module is not null && !Options.ShowRawLocals)
			names = await SymbolResolver.GetVariableNamesAsync(WorkspaceId, raw.Module.Path, raw.MethodToken, cancellationToken).ConfigureAwait(false);
		var runtime = new EvalRuntime(this, types, threadId, frameIndex, allowFuncEval && Options.PropertyEvalAndFunctionCalls, cancellationToken);
		var aliases = await BuildAliasesAsync(runtime).ConfigureAwait(false);
		var frame = FrameContext.Build(types, raw, names, Options.ShowRawLocals, aliases);
		var options = FormatOptions() with { FuncEval = runtime.AllowFuncEval };
		var factory = new NodeFactory(runtime, options, (text, value) => EvaluateInObjectAsync(runtime, text, value), objectIds);
		return new EvaluationScope(runtime, frame, options, factory);
	}

	FrameContext.RawFrame ReadRawFrame(DebuggeeTypeSystem types, int threadId, int frameIndex) {
		var frame = GetFrame(threadId, frameIndex);
		if (frame is null)
			return new FrameContext.RawFrame(null, 0, -1, 0, 0, [], [], "The frame is no longer available.");
		var (modulePath, token) = FrameIdentity(frame);
		var entry = string.IsNullOrEmpty(modulePath) ? null : Modules.FindEntry(frame.Function.Module) ?? Modules.FindEntry(modulePath);
		var argumentCount = 0;
		var localCount = 0;
		var classArguments = new List<ITypeSymbol>();
		var methodArguments = new List<ITypeSymbol>();
		if (frame is ICorDebugILFrame ilFrame) {
			try {
				argumentCount = ilFrame.Arguments.Length;
			}
			catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			}
			try {
				localCount = ilFrame.LocalVariables.Length;
			}
			catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			}
			if (entry is not null && ilFrame is ICorDebugILFrame2 frame2) {
				try {
					var parameters = frame2.TypeParameters;
					var definition = types.GetMember(entry, token) as IMethodSymbol;
					var classArity = definition is null ? 0 : DebuggeeTypeSystem.AllTypeArguments(definition.ContainingType).Count;
					for (var index = 0; index < parameters.Length; index++) {
						var symbol = types.GetSymbol(parameters[index]) ?? types.Compilation.GetSpecialType(SpecialType.System_Object);
						if (index < classArity)
							classArguments.Add(symbol);
						else
							methodArguments.Add(symbol);
					}
				}
				catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
				}
			}
		}
		return new FrameContext.RawFrame(entry, token, ReadIlOffset(frame), argumentCount, localCount, classArguments, methodArguments, null);
	}

	/// <summary>The <c>$</c> names an expression can use: the thrown exception, the return values, the object ids.</summary>
	async Task<IReadOnlyList<ContextVariable>> BuildAliasesAsync(EvalRuntime runtime) {
		var aliases = new List<ContextVariable>();
		var exception = await ReadCurrentExceptionAsync(runtime).ConfigureAwait(false);
		if (exception is not null)
			aliases.Add(new ContextVariable("$exception", exception.Type, new VariableSource.Known(exception)));
		var returned = returnValues;
		for (var index = 0; index < returned.Count; index++) {
			var value = returned[index].Value;
			aliases.Add(new ContextVariable("$ReturnValue" + (index + 1).ToString(CultureInfo.InvariantCulture), value.Type, new VariableSource.Known(value)));
		}
		if (returned.Count > 0)
			aliases.Add(new ContextVariable("$ReturnValue", returned[^1].Value.Type, new VariableSource.Known(returned[^1].Value)));
		foreach (var (id, handle, type) in objectIds.Snapshot()) {
			var value = await runtime.OnDispatcher(() => runtime.Wrap(handle, type, null)).ConfigureAwait(false);
			aliases.Add(new ContextVariable("$" + id.ToString(CultureInfo.InvariantCulture), value.Type, new VariableSource.Known(value)));
		}
		return aliases;
	}

	Task<EvalValue?> ReadCurrentExceptionAsync(EvalRuntime runtime) => runtime.OnDispatcher(() => {
		var thread = Threads.Find(runtime.ThreadId);
		if (thread is null)
			return null;
		try {
			var exception = thread.CurrentException;
			if (exception is null || ValueReader.IsNullReference(exception))
				return null;
			return (EvalValue?)runtime.Wrap(exception, null, () => Threads.Find(runtime.ThreadId)?.CurrentException);
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return null;
		}
	});

	// ---------------------------------------------------------------- evaluating

	/// <summary>Binds and runs an expression in a frame, and answers with its value and format specifiers.</summary>
	internal async Task<(EvalValue Value, CompiledExpression Compiled)> EvaluateAsync(EvaluationScope scope, string text) {
		var compiled = Compiler.Compile(text, Options.Language, scope.Frame.Shape);
		if (compiled.Error is not null)
			throw new EvaluationException(compiled.Error);
		var value = await new OperationInterpreter(scope.Runtime, compiled, scope.Frame.Shape, Options.Language).EvaluateAsync().ConfigureAwait(false);
		return (value, compiled);
	}

	/// <summary>
	/// Evaluates an expression with an object as <c>this</c>, which is what a DebuggerDisplay's
	/// <c>{expression}</c> is: the object's members by bare name, nothing of the frame.
	/// </summary>
	async Task<(EvalValue Value, IReadOnlyList<string> Specifiers)> EvaluateInObjectAsync(EvalRuntime runtime, string text, EvalValue value) {
		var type = value.Type as INamedTypeSymbol;
		var shape = new EvalContextShape {
			ContextType = type,
			ThisType = value.Type,
			ThisSource = new VariableSource.Known(value),
			CacheKey = "object:" + value.Type.ToDisplayString(),
		};
		var compiled = Compiler.Compile(text, Options.Language, shape);
		if (compiled.Error is not null)
			throw new EvaluationException(compiled.Error);
		var result = await new OperationInterpreter(runtime, compiled, shape, Options.Language).EvaluateAsync().ConfigureAwait(false);
		return (result, compiled.FormatSpecifiers);
	}

	(int ThreadId, int FrameIndex) ResolveFrameArgument(JsonElement args) {
		var frameId = GetInt(args, "frameId");
		if (frameId is { } id && frameTable.Find(id) is { } entry)
			return (entry.ThreadId, entry.Index);
		var threadId = GetInt(args, "threadId") ?? StoppedThreadId ?? throw new RpcException(ErrorCodes.InvalidParams, "There is no frame to evaluate in.");
		return (threadId, GetInt(args, "frameIndex") ?? 0);
	}

	/// <summary>
	/// <c>evaluate</c>: one expression's row — the Watch window's, a tooltip's, Add Watch's. An expression with
	/// side effects is only run when the client says so, since a watch is re-run at every stop.
	/// </summary>
	internal async Task<JsonElement> EvaluateRequestAsync(JsonElement? arguments, CancellationToken cancellationToken) {
		var args = arguments is { ValueKind: JsonValueKind.Object } value ? value : default;
		var expression = GetString(args, "expression") ?? string.Empty;
		var allowSideEffects = GetBool(args, "allowSideEffects") ?? true;
		var noFuncEval = GetBool(args, "noFuncEval") ?? false;
		var (threadId, frameIndex) = ResolveFrameArgument(args);
		using var _ = await EnterEvaluationAsync(cancellationToken).ConfigureAwait(false);
		var node = await EvaluateNodeAsync(threadId, frameIndex, expression, allowSideEffects, !noFuncEval, cancellationToken).ConfigureAwait(false);
		return DebugJson.Serialize(ToDto(node, threadId, frameIndex));
	}

	async Task<ValueNode> EvaluateNodeAsync(int threadId, int frameIndex, string expression, bool allowSideEffects, bool allowFuncEval, CancellationToken cancellationToken) {
		var name = NodeFactory.PlainName(expression);
		EvaluationScope scope;
		try {
			scope = await OpenScopeAsync(threadId, frameIndex, allowFuncEval, cancellationToken).ConfigureAwait(false);
		}
		catch (EvaluationException ex) {
			return NodeFactory.Error(name, expression, ex.Message);
		}
		var compiled = Compiler.Compile(expression, Options.Language, scope.Frame.Shape);
		if (compiled.Error is not null)
			return NodeFactory.Error(name, expression, compiled.Error);
		if (compiled.HasSideEffects && !allowSideEffects) {
			return new ValueNode {
				Name = name,
				Value = NodeFactory.Text(TextColors.Text, "This expression causes side effects and will not be evaluated"),
				Expression = expression,
				Image = "StatusWarning",
				Kind = "sideEffects",
				NeedsRefresh = true,
			};
		}
		var options = scope.FormatOptions.WithSpecifiers(compiled.FormatSpecifiers);
		var (image, canEdit) = DescribeOperation(compiled.Operation);
		try {
			var value = await new OperationInterpreter(scope.Runtime, compiled, scope.Frame.Shape, Options.Language).EvaluateAsync().ConfigureAwait(false);
			var node = await scope.Factory.CreateAsync(name, expression, value, compiled.Operation?.Type, image, "expression", canEdit, options).ConfigureAwait(false);
			node.EditText = await EditTextAsync(scope, value).ConfigureAwait(false);
			return node;
		}
		catch (EvaluationThrownException thrown) {
			return await scope.Factory.CreateThrownAsync(name, expression, thrown, image).ConfigureAwait(false);
		}
		catch (EvaluationException ex) {
			return NodeFactory.Error(name, expression, ex.Message);
		}
	}

	/// <summary>The image and editability of an expression's row, from what the expression is.</summary>
	static (string Image, bool CanEdit) DescribeOperation(IOperation? operation) {
		while (operation is IConversionOperation or IParenthesizedOperation) {
			operation = operation switch {
				IConversionOperation conversion => conversion.Operand,
				IParenthesizedOperation parenthesized => parenthesized.Operand,
				_ => operation,
			};
		}
		return operation switch {
			IParameterReferenceOperation => ("FieldPublic", true),
			IFieldReferenceOperation field => (ObjectChildren.FieldImage(field.Field), !field.Field.IsConst && !field.Field.IsReadOnly),
			IPropertyReferenceOperation property => (ObjectChildren.PropertyImage(property.Property), property.Property.SetMethod is not null),
			IArrayElementReferenceOperation => ("FieldPublic", true),
			IInvocationOperation => ("MethodPublic", false),
			_ => ("FieldPublic", false),
		};
	}

	/// <summary>What the value reads as in the edit box: a literal the language can read back.</summary>
	static async Task<string?> EditTextAsync(EvaluationScope scope, EvalValue value) {
		if (value is not ScalarValue)
			return null;
		var formatter = scope.Factory.Formatter(scope.FormatOptions with { Edit = true, FullString = true, NoStringQuotes = false });
		return ColorTextWriter.ToText(await formatter.FormatValueAsync(value).ConfigureAwait(false));
	}

	/// <summary>
	/// <c>setExpression</c>: edits a value — a variable, a field, an element, a property — by evaluating the new
	/// value and assigning it to what the row's expression names. Answers with the row read again.
	/// </summary>
	internal async Task<JsonElement> SetExpressionAsync(JsonElement? arguments, CancellationToken cancellationToken) {
		var args = arguments is { ValueKind: JsonValueKind.Object } value ? value : default;
		var expression = GetString(args, "expression") ?? throw new RpcException(ErrorCodes.InvalidParams, "An expression is required.");
		var newValue = GetString(args, "value") ?? throw new RpcException(ErrorCodes.InvalidParams, "A value is required.");
		var (threadId, frameIndex) = ResolveFrameArgument(args);
		using var _ = await EnterEvaluationAsync(cancellationToken).ConfigureAwait(false);
		string? error = null;
		try {
			var scope = await OpenScopeAsync(threadId, frameIndex, allowFuncEval: true, cancellationToken).ConfigureAwait(false);
			var target = Compiler.Compile(expression, Options.Language, scope.Frame.Shape);
			if (target.Error is not null)
				throw new EvaluationException(target.Error);
			var (assigned, _) = await EvaluateAsync(scope, newValue).ConfigureAwait(false);
			var interpreter = new OperationInterpreter(scope.Runtime, target, scope.Frame.Shape, Options.Language);
			await interpreter.AssignAsync(target.Operation!, assigned).ConfigureAwait(false);
		}
		catch (EvaluationException ex) {
			error = ex.Message;
		}
		catch (EvaluationThrownException thrown) {
			error = ValueFormatter.DescribeThrown(thrown);
		}
		var node = await EvaluateNodeAsync(threadId, frameIndex, expression, allowSideEffects: true, allowFuncEval: true, cancellationToken).ConfigureAwait(false);
		var dto = ToDto(node, threadId, frameIndex);
		return DebugJson.Serialize(new { node = dto, error });
	}

	// ---------------------------------------------------------------- the windows

	/// <summary>
	/// <c>variables</c>: the rows under a reference — a frame's Locals, or the children of an expanded row.
	/// </summary>
	internal async Task<JsonElement> VariablesAsync(JsonElement? arguments, CancellationToken cancellationToken) {
		var args = arguments is { ValueKind: JsonValueKind.Object } value ? value : default;
		var reference = GetInt(args, "variablesReference") ?? 0;
		var start = Math.Max(GetInt(args, "start") ?? 0, 0);
		var count = GetInt(args, "count") is { } requested && requested > 0 ? requested : int.MaxValue;
		if (!IsStopped)
			throw new RpcException(ErrorCodes.InvalidParams, RunningReason);
		var entry = variableTable.Find(reference) ?? throw new RpcException(ErrorCodes.InvalidParams, $"There is no variable set with reference {reference}; it belongs to an earlier stop.");
		using var _ = await EnterEvaluationAsync(cancellationToken).ConfigureAwait(false);
		IReadOnlyList<ValueNode> nodes;
		int threadId;
		int frameIndex;
		int? total = null;
		switch (entry) {
			case FrameScopeEntry scopeEntry:
				threadId = scopeEntry.ThreadId;
				frameIndex = scopeEntry.FrameIndex;
				nodes = await LocalsAsync(threadId, frameIndex, cancellationToken).ConfigureAwait(false);
				break;
			case NodeEntry nodeEntry:
				threadId = nodeEntry.ThreadId;
				frameIndex = nodeEntry.FrameIndex;
				var scope = await OpenScopeAsync(threadId, frameIndex, allowFuncEval: true, cancellationToken).ConfigureAwait(false);
				var children = nodeEntry.Node.Children;
				if (children is null) {
					nodes = [];
					break;
				}
				try {
					total = await children.CountAsync(scope.Factory).ConfigureAwait(false);
					nodes = await children.CreateAsync(scope.Factory, start, count).ConfigureAwait(false);
				}
				catch (EvaluationException ex) {
					nodes = [NodeFactory.Error(NodeFactory.PlainName("Error"), string.Empty, ex.Message)];
				}
				break;
			default:
				throw new RpcException(ErrorCodes.InvalidParams, $"Reference {reference} names no variables.");
		}
		return DebugJson.Serialize(new {
			variables = nodes.Select(node => ToDto(node, threadId, frameIndex)).ToArray(),
			totalCount = total,
		});
	}

	/// <summary>
	/// The Locals window, dnSpy's <c>LocalsVariablesWindowValueNodesProvider</c>: the exception, the return
	/// values, the object ids, then the variables sorted as the options ask, then the type variables.
	/// </summary>
	async Task<IReadOnlyList<ValueNode>> LocalsAsync(int threadId, int frameIndex, CancellationToken cancellationToken) {
		EvaluationScope scope;
		try {
			scope = await OpenScopeAsync(threadId, frameIndex, allowFuncEval: true, cancellationToken).ConfigureAwait(false);
		}
		catch (EvaluationException ex) {
			return [NodeFactory.Error(NodeFactory.Text(TextColors.Text, "<error>"), string.Empty, ex.Message)];
		}
		var factory = scope.Factory;
		var nodes = new List<ValueNode>();
		var isCSharp = Options.Language == EvalLanguage.CSharp;
		foreach (var alias in scope.Frame.Shape.Aliases) {
			if (alias.Source is not VariableSource.Known { Value: var value })
				continue;
			if (alias.Name == "$exception")
				nodes.Add(await factory.CreateAsync(NodeFactory.Text(ColorTextWriter.DebugExceptionName, "$exception"), "$exception", value, null, "ExceptionPublic", "exception", canEdit: false).ConfigureAwait(false));
		}
		if (Options.ShowReturnValues) {
			for (var index = 0; index < returnValues.Count; index++) {
				var info = returnValues[index];
				var name = new ColorTextWriter();
				var formatter = factory.Formatter();
				name.Write(formatter.FormatTypeName(info.Method.ContainingType));
				name.Write(TextColors.Operator, ".");
				name.Write(ValueFormatter.ColorOf(info.Method), formatter.EscapeIdentifier(info.Method.Name));
				name.Write(TextColors.Text, " ");
				name.Write(ColorTextWriter.DebugReturnValueName, "returned");
				var expression = "$ReturnValue" + (index + 1).ToString(CultureInfo.InvariantCulture);
				nodes.Add(await factory.CreateAsync(name.ToList(), expression, info.Value, info.Method.ReturnType, "FieldPublic", "returnValue", canEdit: false).ConfigureAwait(false));
			}
		}
		foreach (var alias in scope.Frame.Shape.Aliases) {
			if (alias.Name.Length > 1 && alias.Name[0] == '$' && char.IsDigit(alias.Name[1]) && alias.Source is VariableSource.Known { Value: var objectValue })
				nodes.Add(await factory.CreateAsync(NodeFactory.Text(ColorTextWriter.DebugObjectIdName, alias.Name), alias.Name, objectValue, null, "FieldPublic", "objectId", canEdit: false).ConfigureAwait(false));
		}
		var variables = scope.Frame.Variables.Where(variable => Options.ShowCompilerGeneratedVariables || !variable.IsCompilerGenerated).ToList();
		variables = SortVariables(variables);
		var interpreter = new FrameVariableReader(scope);
		foreach (var variable in variables) {
			var isThis = variable.Kind == FrameVariableKind.This;
			var name = isThis
				? NodeFactory.Text(TextColors.Keyword, isCSharp ? "this" : "Me")
				: NodeFactory.Text(variable.Kind == FrameVariableKind.Parameter ? TextColors.Parameter : TextColors.Local, factory.Formatter().EscapeIdentifier(variable.Name));
			var expression = isThis ? (isCSharp ? "this" : "Me") : factory.Formatter().EscapeIdentifier(variable.Name);
			nodes.Add(await factory.CreateSafeAsync(name, expression, () => interpreter.ReadAsync(variable.Source, variable.Type), variable.Type, "FieldPublic", isThis ? "this" : variable.Kind == FrameVariableKind.Parameter ? "parameter" : "local", canEdit: !isThis).ConfigureAwait(false));
		}
		if (scope.Frame.TypeVariables.Count > 0) {
			var children = new List<ValueNode>();
			foreach (var (parameter, argument) in scope.Frame.TypeVariables) {
				children.Add(new ValueNode {
					Name = NodeFactory.Text(parameter.TypeParameterKind == TypeParameterKind.Method ? TextColors.MethodGenericParameter : TextColors.TypeGenericParameter, parameter.Name),
					Value = factory.Formatter().FormatTypeName(argument),
					Type = factory.Formatter().FormatTypeName(argument),
					Image = parameter.TypeParameterKind == TypeParameterKind.Method ? "FieldPublic" : "FieldPublic",
					Kind = "typeVariable",
				});
			}
			nodes.Add(new ValueNode {
				Name = NodeFactory.PlainName("Type variables"),
				Image = "FieldPublic",
				Kind = "typeVariables",
				Children = new FixedChildren(children),
			});
		}
		return nodes;
	}

	List<FrameVariable> SortVariables(List<FrameVariable> variables) {
		if (!Options.SortParameters && !Options.SortLocals)
			return variables;
		var comparer = StringComparer.OrdinalIgnoreCase;
		var thisRows = variables.Where(variable => variable.Kind == FrameVariableKind.This).ToList();
		if (Options.GroupParametersAndLocalsTogether)
			return [.. thisRows, .. variables.Where(variable => variable.Kind != FrameVariableKind.This).OrderBy(variable => variable.Name, comparer)];
		var parameters = variables.Where(variable => variable.Kind == FrameVariableKind.Parameter).ToList();
		var locals = variables.Where(variable => variable.Kind == FrameVariableKind.Local).ToList();
		if (Options.SortParameters)
			parameters = parameters.OrderBy(variable => variable.Name, comparer).ToList();
		if (Options.SortLocals)
			locals = locals.OrderBy(variable => variable.Name, comparer).ToList();
		return [.. thisRows, .. parameters, .. locals];
	}

	/// <summary>Reads a frame variable the same way an expression naming it would.</summary>
	sealed class FrameVariableReader(EvaluationScope scope) {
		EvalValue? frameThis;

		public async Task<EvalValue> ReadAsync(VariableSource source, ITypeSymbol type) => source switch {
			VariableSource.Local local => await scope.Runtime.ReadLocalAsync(local.Index, type).ConfigureAwait(false),
			VariableSource.Argument argument => await scope.Runtime.ReadArgumentAsync(argument.Index, type).ConfigureAwait(false),
			VariableSource.HoistedField hoisted => await scope.Runtime.ReadFieldAsync(frameThis ??= await scope.Runtime.ReadArgumentAsync(0, null).ConfigureAwait(false), hoisted.Field).ConfigureAwait(false),
			VariableSource.Known value => value.Value,
			_ => throw new EvaluationException("The variable cannot be read."),
		};
	}

	/// <summary>
	/// The Static Fields window, dnSpy's <c>DbgEngineStaticFieldsProviderImpl</c>: the static fields the frame's
	/// method touches, and every static field of the type it is declared in.
	/// </summary>
	internal async Task<JsonElement> StaticFieldsAsync(JsonElement? arguments, CancellationToken cancellationToken) {
		var args = arguments is { ValueKind: JsonValueKind.Object } value ? value : default;
		var (threadId, frameIndex) = ResolveFrameArgument(args);
		using var _ = await EnterEvaluationAsync(cancellationToken).ConfigureAwait(false);
		var scope = await OpenScopeAsync(threadId, frameIndex, allowFuncEval: true, cancellationToken).ConfigureAwait(false);
		var fields = new List<IFieldSymbol>();
		var method = scope.Frame.Method;
		if (method is not null) {
			var entry = Modules.FindEntry(scope.Frame.ModulePath);
			if (entry is not null)
				fields.AddRange(StaticFieldsInBody(scope.Runtime.Types, entry, scope.Frame.MethodToken, method));
			foreach (var field in method.ContainingType.GetMembers().OfType<IFieldSymbol>()) {
				if (field.IsStatic && !field.IsConst && !fields.Any(existing => SymbolEqualityComparer.Default.Equals(existing.OriginalDefinition, field.OriginalDefinition)))
					fields.Add(field);
			}
		}
		var nodes = new List<ValueNode>();
		var factory = scope.Factory;
		foreach (var field in fields) {
			var formatter = factory.Formatter(scope.FormatOptions with { ShowNamespaces = true, IntrinsicTypeKeywords = true });
			var name = new ColorTextWriter();
			name.Write(formatter.FormatTypeName(field.ContainingType));
			name.Write(TextColors.Punctuation, ".");
			name.Write(ValueFormatter.ColorOf(field), formatter.EscapeIdentifier(field.Name));
			var expression = factory.TypeExpression(field.ContainingType) + "." + formatter.EscapeIdentifier(field.Name);
			var captured = field;
			nodes.Add(await factory.CreateSafeAsync(name.ToList(), expression, () => scope.Runtime.ReadFieldAsync(null, captured), field.Type, ObjectChildren.FieldImage(field), "static", canEdit: !field.IsReadOnly).ConfigureAwait(false));
		}
		return DebugJson.Serialize(new { variables = nodes.Select(node => ToDto(node, threadId, frameIndex)).ToArray() });
	}

	/// <summary>The static fields a method body loads, stores or takes the address of.</summary>
	static IEnumerable<IFieldSymbol> StaticFieldsInBody(DebuggeeTypeSystem types, ModuleTable.ModuleEntry entry, int methodToken, IMethodSymbol method) {
		var reader = types.GetReader(entry);
		if (reader is null)
			yield break;
		System.Reflection.Metadata.MethodBodyBlock? body = null;
		try {
			var definition = reader.GetMethodDefinition(System.Reflection.Metadata.Ecma335.MetadataTokens.MethodDefinitionHandle(methodToken & 0x00FFFFFF));
			if (definition.RelativeVirtualAddress != 0)
				body = types.GetMethodBody(entry, definition.RelativeVirtualAddress);
		}
		catch (BadImageFormatException) {
		}
		if (body is null)
			yield break;
		var il = body.GetILBytes() ?? [];
		var seen = new HashSet<int>();
		foreach (var (opcode, operand) in ILScanner.Scan(il)) {
			// ldsfld, ldsflda, stsfld.
			if (opcode is not (0x7E or 0x7F or 0x80) || !seen.Add(operand))
				continue;
			var field = ResolveField(types, entry, reader, operand, method);
			if (field is not null && field.IsStatic && !field.IsConst)
				yield return field;
		}
	}

	static IFieldSymbol? ResolveField(DebuggeeTypeSystem types, ModuleTable.ModuleEntry entry, System.Reflection.Metadata.MetadataReader reader, int token, IMethodSymbol method) {
		var handle = System.Reflection.Metadata.Ecma335.MetadataTokens.EntityHandle(token);
		if (handle.Kind == System.Reflection.Metadata.HandleKind.FieldDefinition)
			return types.GetMember(entry, token) as IFieldSymbol;
		if (handle.Kind != System.Reflection.Metadata.HandleKind.MemberReference)
			return null;
		var reference = reader.GetMemberReference((System.Reflection.Metadata.MemberReferenceHandle)handle);
		var name = reader.GetString(reference.Name);
		var context = new SignatureContext(DebuggeeTypeSystem.AllTypeArguments(method.ContainingType), method.TypeArguments);
		ITypeSymbol? parent = reference.Parent.Kind switch {
			System.Reflection.Metadata.HandleKind.TypeReference => new RoslynSignatureProvider(types, entry).GetTypeFromReference(reader, (System.Reflection.Metadata.TypeReferenceHandle)reference.Parent, 0),
			System.Reflection.Metadata.HandleKind.TypeDefinition => new RoslynSignatureProvider(types, entry).GetTypeFromDefinition(reader, (System.Reflection.Metadata.TypeDefinitionHandle)reference.Parent, 0),
			System.Reflection.Metadata.HandleKind.TypeSpecification => new RoslynSignatureProvider(types, entry).GetTypeFromSpecification(reader, context, (System.Reflection.Metadata.TypeSpecificationHandle)reference.Parent, 0),
			_ => null,
		};
		return parent?.GetMembers(name).OfType<IFieldSymbol>().FirstOrDefault();
	}

	/// <summary><c>makeObjectId</c>: gives the object a row or an expression stands for an id that outlives the stop.</summary>
	internal async Task<JsonElement> MakeObjectIdAsync(JsonElement? arguments, CancellationToken cancellationToken) {
		var args = arguments is { ValueKind: JsonValueKind.Object } value ? value : default;
		using var gate = await EnterEvaluationAsync(cancellationToken).ConfigureAwait(false);
		EvalValue? target = null;
		if (GetInt(args, "variablesReference") is { } reference && variableTable.Find(reference) is NodeEntry node)
			target = node.Node.EvalValue;
		if (target is null && GetString(args, "expression") is { } expression) {
			var (threadId, frameIndex) = ResolveFrameArgument(args);
			var scope = await OpenScopeAsync(threadId, frameIndex, allowFuncEval: true, cancellationToken).ConfigureAwait(false);
			(target, _) = await EvaluateAsync(scope, expression).ConfigureAwait(false);
		}
		var remote = target as RemoteValue ?? (target as ScalarValue)?.Origin
			?? throw new RpcException(ErrorCodes.InvalidParams, "Only objects can be given an object ID.");
		var id = await Dispatcher.RunAsync(() => {
			var heap = remote.Ref.Handle is { } handle ? ValueReader.Dereference(handle) : ValueReader.Dereference(remote.Ref.Get());
			if (heap is not ICorDebugHeapValue2 heapValue)
				throw new RpcException(ErrorCodes.InvalidParams, "Only objects can be given an object ID.");
			var persistent = heapValue.CreateHandle(CorDebugHandleType.HANDLE_STRONG);
			return objectIds.Add(persistent, remote.Type);
		}).ConfigureAwait(false);
		return DebugJson.Serialize(new { id = "$" + id.ToString(CultureInfo.InvariantCulture) });
	}

	internal async Task<JsonElement> DeleteObjectIdAsync(JsonElement? arguments) {
		var args = arguments is { ValueKind: JsonValueKind.Object } value ? value : default;
		var text = (GetString(args, "id") ?? string.Empty).TrimStart('$');
		if (!uint.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var id))
			throw new RpcException(ErrorCodes.InvalidParams, "An object ID such as $1 is required.");
		var handle = objectIds.Remove(id);
		if (handle is not null) {
			await Dispatcher.RunAsync(() => {
				try {
					handle.Dispose();
				}
				catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
				}
			}).ConfigureAwait(false);
		}
		return EmptyJson();
	}

	/// <summary>A row as the client reads it; a row with children is filed so the client can ask for them.</summary>
	object ToDto(ValueNode node, int threadId, int frameIndex) {
		var reference = node.Children is null ? 0 : variableTable.Add(new NodeEntry(node, threadId, frameIndex));
		return new {
			name = ColorTextWriter.ToText(node.Name),
			nameParts = node.Name,
			value = ColorTextWriter.ToText(node.Value),
			valueParts = node.Value,
			type = ColorTextWriter.ToText(node.Type),
			typeParts = node.Type,
			variablesReference = reference,
			evaluateName = node.Expression,
			image = node.Image,
			kind = node.Kind,
			isError = node.IsError,
			canEdit = node.CanEditValue,
			needsRefresh = node.NeedsRefresh,
			objectId = node.ObjectId,
			editText = node.EditText,
		};
	}

	// ---------------------------------------------------------------- return values

	/// <summary>A value a method the user stepped over returned, for the Locals window and <c>$ReturnValue</c>.</summary>
	internal sealed record ReturnValueInfo(IMethodSymbol Method, EvalValue Value);

	List<ReturnValueInfo> returnValues = new();
}

/// <summary>Walks IL one instruction at a time, enough to find the operands of the field, call and variable instructions.</summary>
internal static class ILScanner {
	public static IEnumerable<(int OpCode, int Operand)> Scan(byte[] il) =>
		ScanWithOffsets(il).Select(instruction => (instruction.OpCode, instruction.Operand));

	/// <summary>Every instruction with its offset; a 1- or 2-byte operand is zero-extended, an 8-byte one truncated.</summary>
	public static IEnumerable<(int Offset, int OpCode, int Operand)> ScanWithOffsets(byte[] il) {
		var offset = 0;
		while (offset < il.Length) {
			var start = offset;
			int opcode = il[offset++];
			if (opcode == 0xFE && offset < il.Length)
				opcode = 0xFE00 | il[offset++];
			var size = OperandSize(opcode, il, offset);
			if (size < 0 || offset + Math.Min(size, 4) > il.Length)
				yield break;
			var operand = size switch {
				1 => il[offset],
				2 => BitConverter.ToUInt16(il, offset),
				>= 4 => BitConverter.ToInt32(il, offset),
				_ => 0,
			};
			yield return (start, opcode, operand);
			offset += size;
		}
	}

	static int OperandSize(int opcode, byte[] il, int offset) {
		switch (opcode) {
			case 0x45: // switch
				if (offset + 4 > il.Length)
					return -1;
				return 4 + BitConverter.ToInt32(il, offset) * 4;
			case >= 0x2B and <= 0x37: // short branches
			case 0x0E or 0x0F or 0x10 or 0x11 or 0x12 or 0x13: // ldarg.s ... stloc.s
			case 0x1F: // ldc.i4.s
			case 0xDE: // leave.s
				return 1;
			case 0xFE09 or 0xFE0A or 0xFE0B or 0xFE0C or 0xFE0D or 0xFE0E: // ldarg ... stloc
				return 2;
			case 0xFE12 or 0xFE19: // unaligned., no.
				return 1;
			case 0x21 or 0x23: // ldc.i8, ldc.r8
				return 8;
			case 0x20 or 0x22: // ldc.i4, ldc.r4
			case >= 0x38 and <= 0x44: // long branches
			case 0xDD: // leave
			case 0x27 or 0x28 or 0x29 or 0x6F or 0x70 or 0x71 or 0x72 or 0x73 or 0x74 or 0x75 or 0x79 or 0x7B or 0x7C or 0x7D or 0x7E or 0x7F or 0x80 or 0x81:
			case 0x8C or 0x8D or 0x8F or 0xA3 or 0xA4 or 0xA5 or 0xC2 or 0xC6 or 0xD0:
			case 0xFE06 or 0xFE07 or 0xFE15 or 0xFE16 or 0xFE1C:
				return 4;
			default:
				return 0;
		}
	}
}
