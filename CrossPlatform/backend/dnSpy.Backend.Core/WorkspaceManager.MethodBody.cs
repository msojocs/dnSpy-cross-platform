using System.Globalization;
using System.Reflection;
using dnlib.DotNet;
using dnlib.DotNet.Emit;
using dnlib.DotNet.Pdb;
using dnlib.PE;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.Editing;

namespace dnSpy.Backend.Core;

/// <summary>
/// The IL method body editor — dnSpy's <c>MethodBodyDlg</c>. It reads a body into the model the three
/// tabs of that window work on (instructions, locals, exception handlers), writes an edited model back
/// through the usual edit transaction, and runs the instruction-list commands the window's context
/// menu offers.
/// </summary>
/// <remarks>
/// The commands are the ones WPF runs on its view model (<c>BodyUtils.SimplifyMacros</c> and friends).
/// They are answered here rather than in the client because two of them need the stack effect of each
/// instruction, which only dnlib's opcode tables and the operand's signature can say. They are pure:
/// nothing about the module changes until the dialog's OK queues the body.
/// </remarks>
public sealed partial class WorkspaceManager {
	public Task<IlMethodBodyDto> GetIlBodyAsync(GetIlBodyRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetIlBody(request.MethodNodeId), cancellationToken);

	public Task QueueIlBodyAsync(ReplaceIlBodyRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => {
			w.QueueIlBody(request);
			return true;
		}, cancellationToken);

	public Task<TransformIlBodyResponse> TransformIlBodyAsync(TransformIlBodyRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.TransformIlBody(request), cancellationToken);

	sealed partial class Workspace {
		public IlMethodBodyDto GetIlBody(string methodNodeId) {
			var node = GetNode(methodNodeId);
			if (node.Value is not MethodDef method)
				throw new RpcException(ErrorCodes.EditValidationFailed, "The selected item is not a method.");
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support method body editing.");
			var signatures = CreateEditContext(moduleEntry).Signatures;
			var cilBody = method.MethodBody as CilBody;
			var labels = cilBody is null
				? new Dictionary<Instruction, string>()
				: cilBody.Instructions.ToDictionary(instruction => instruction, instruction => $"IL_{instruction.Offset:X4}");

			uint headerRva = (uint)method.RVA;
			ulong headerFileOffset = 0;
			if (moduleEntry.Module is ModuleDefMD md) {
				try {
					headerFileOffset = (uint)md.Metadata.PEImage.ToFileOffset((RVA)headerRva);
				}
				catch (Exception) {
					// A method with no RVA (or a file without a PE image) has no offsets to show.
				}
			}
			var rva = headerRva;
			var fileOffset = headerFileOffset;
			if (cilBody is not null) {
				rva = headerRva + cilBody.HeaderSize;
				fileOffset = headerFileOffset + cilBody.HeaderSize;
			}

			return new IlMethodBodyDto(
				method.MethodBody switch {
					CilBody => IlBodyTypes.Cil,
					NativeMethodBody => IlBodyTypes.Native,
					_ => IlBodyTypes.None,
				},
				(int)method.CodeType,
				cilBody?.MaxStack ?? 0,
				cilBody?.KeepOldMaxStack ?? false,
				cilBody?.InitLocals ?? false,
				unchecked((int)(cilBody?.LocalVarSigTok ?? 0)),
				headerRva,
				headerFileOffset,
				rva,
				fileOffset,
				method.MethodBody is NativeMethodBody nativeBody ? (uint)nativeBody.RVA : 0,
				cilBody?.Variables.Select(local => new IlLocalDto(
					local.Name,
					signatures.ToDto(local.Type),
					local.Type is PinnedSig,
					(int)local.Attributes,
					DescribeLocal(local))).ToArray() ?? [],
				cilBody?.Instructions.Select(instruction => DescribeInstruction(method, signatures, instruction, labels)).ToArray() ?? [],
				cilBody?.ExceptionHandlers.Select(handler => DescribeExceptionHandler(signatures, handler)).ToArray() ?? [],
				method.Parameters.Select(parameter => parameter.Name ?? $"A_{parameter.Index}").ToArray());
		}

		static string DescribeLocal(Local local) {
			var name = string.IsNullOrEmpty(local.Name) ? $"V_{local.Index}" : local.Name;
			return $"{local.Type?.FullName ?? "null"} {name}";
		}

		IlBodyInstructionDto DescribeInstruction(MethodDef method, SignatureCodec signatures, Instruction instruction, IReadOnlyDictionary<Instruction, string> labels) {
			var opCode = instruction.OpCode.Name;
			var label = labels[instruction];
			switch (instruction.Operand) {
				case null:
					return new IlBodyInstructionDto(label, opCode, IlOperandKinds.None);
				case string text:
					return new IlBodyInstructionDto(label, opCode, IlOperandKinds.String, text, text);
				case Instruction target:
					return new IlBodyInstructionDto(label, opCode, IlOperandKinds.Branch, labels[target], labels[target]);
				case IList<Instruction> targets:
					return new IlBodyInstructionDto(
						label,
						opCode,
						IlOperandKinds.Switch,
						string.Join(',', targets.Select(target => labels[target])),
						string.Join(", ", targets.Select(target => labels[target])));
				case Local local:
					return new IlBodyInstructionDto(label, opCode, IlOperandKinds.Local, local.Index.ToString(CultureInfo.InvariantCulture), $"V_{local.Index}");
				case Parameter parameter:
					return new IlBodyInstructionDto(label, opCode, IlOperandKinds.Argument, method.Parameters.IndexOf(parameter).ToString(CultureInfo.InvariantCulture), parameter.Name ?? $"A_{parameter.Index}");
				case MethodSpec spec:
					return new IlBodyInstructionDto(
						label,
						opCode,
						IlOperandKinds.Method,
						TokenText(spec),
						spec.FullName,
						TokenText(spec),
						MethodRef: new MethodRefDto(
							signatures.ToDto(spec.Method.DeclaringType),
							spec.Method.Name,
							signatures.MethodToDto(spec.Method.MethodSig),
							spec.Method.FullName),
						MethodSpecArguments: spec.GenericInstMethodSig?.GenericArguments.Select(argument => signatures.ToDtoRequired(argument)).ToArray());
				case IMethod method2:
					return DescribeReference(label, opCode, IlOperandKinds.Method, method2);
				case IField field:
					return DescribeReference(label, opCode, IlOperandKinds.Field, field);
				case ITypeDefOrRef type:
					return DescribeReference(label, opCode, IlOperandKinds.Type, type);
				case MethodSig signature:
					return new IlBodyInstructionDto(
						label,
						opCode,
						IlOperandKinds.Signature,
						DnlibDisplay.Method(signature),
						DnlibDisplay.Method(signature),
						CallSiteSignature: signatures.MethodToDto(signature));
				case sbyte or byte or short or ushort or int or uint or long or ulong or float or double:
					var number = instruction.Operand switch {
						float value => value.ToString("R", CultureInfo.InvariantCulture),
						double value => value.ToString("R", CultureInfo.InvariantCulture),
						IFormattable value => value.ToString(null, CultureInfo.InvariantCulture),
						_ => instruction.Operand.ToString(),
					};
					return new IlBodyInstructionDto(label, opCode, IlOperandKinds.Number, number, number);
				default:
					throw new RpcException(ErrorCodes.EditValidationFailed, $"Operand type {instruction.Operand.GetType().Name} cannot be edited.");
			}
		}

		IlBodyInstructionDto DescribeReference(string label, string opCode, string kind, object value) {
			var token = value is IMDTokenProvider provider ? provider.MDToken.Raw : 0;
			return new IlBodyInstructionDto(
				label,
				opCode,
				kind,
				token == 0 ? null : token.ToString("X8", CultureInfo.InvariantCulture),
				OperandDisplayText(value),
				NodeIdOf(value),
				token == 0 ? null : token.ToString("X8", CultureInfo.InvariantCulture));
		}

		static string? OperandDisplayText(object value) => value switch {
			TypeSig signature => DnlibDisplay.Type(signature),
			ITypeDefOrRef type => type.FullName,
			IMethod method => method.FullName,
			IField field => field.FullName,
			MethodSig signature => DnlibDisplay.Method(signature),
			_ => value.ToString(),
		};

		static string TokenText(IMDTokenProvider provider) => provider.MDToken.Raw.ToString("X8", CultureInfo.InvariantCulture);

		/// <summary>
		/// The tree row a reference names, when the workspace holds the module that defines it. A reference
		/// to something external — a MemberRef, a TypeRef, anything in an assembly that was never opened —
		/// has no row, and its token is what the client sends back to name it.
		/// </summary>
		string? NodeIdOf(object value) {
			if (value is not IMDTokenProvider provider)
				return null;
			if (provider is not (TypeDef or MethodDef or FieldDef))
				return null;
			var module = ResolveModuleOf(provider);
			if (module is null)
				return null;
			return GetMemberNode(provider, module).Id;
		}

		ModuleEntry? ResolveModuleOf(IMDTokenProvider provider) {
			var module = provider switch {
				TypeDef type => type.Module,
				MethodDef method => method.Module,
				FieldDef field => field.Module,
				_ => null,
			};
			if (module is null)
				return null;
			foreach (var entry in modules.Values) {
				if (ReferenceEquals(entry.Module, module))
					return entry;
			}
			// A type or member of an assembly the decompiler resolved on its own: match it by name, the way
			// the tree matches an assembly reference.
			return module.Assembly is null
				? null
				: modules.Values.FirstOrDefault(entry => ReferenceEquals(entry.Module.Assembly, module.Assembly));
		}

		static IlExceptionHandlerDto DescribeExceptionHandler(SignatureCodec signatures, ExceptionHandler handler) => new(
			handler.HandlerType.ToString().ToLowerInvariant(),
			handler.TryStart is null ? null : LabelOf(handler.TryStart),
			handler.TryEnd is null ? null : LabelOf(handler.TryEnd),
			handler.FilterStart is null ? null : LabelOf(handler.FilterStart),
			handler.HandlerStart is null ? null : LabelOf(handler.HandlerStart),
			handler.HandlerEnd is null ? null : LabelOf(handler.HandlerEnd),
			signatures.ToDto(handler.CatchType),
			$"{handler.HandlerType} {handler.CatchType?.FullName}");

		// Offsets are the labels the instructions were read with, so a handler names the same rows.
		static string LabelOf(Instruction instruction) => $"IL_{instruction.Offset:X4}";

		public void QueueIlBody(ReplaceIlBodyRequest request) {
			var transaction = GetTransaction(request.TransactionId);
			var node = GetNode(request.MethodNodeId);
			if (node.Value is not MethodDef method)
				throw new RpcException(ErrorCodes.EditValidationFailed, "The selected item is not a method.");
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support method body editing.");

			dnlib.DotNet.Emit.MethodBody? newBody;
			switch (request.BodyType) {
				case IlBodyTypes.None:
					newBody = null;
					break;
				case IlBodyTypes.Native:
					newBody = new NativeMethodBody((RVA)request.NativeRva);
					break;
				case IlBodyTypes.Cil:
					newBody = BuildCilBody(moduleEntry, method, request);
					break;
				default:
					throw new RpcException(ErrorCodes.EditValidationFailed, $"Unknown method body type '{request.BodyType}'.");
			}

			transaction.Add(node.Id, moduleEntry, () => {
				var oldBody = method.MethodBody;
				var oldCodeType = method.CodeType;
				method.CodeType = (dnlib.DotNet.MethodImplAttributes)request.CodeType;
				method.MethodBody = newBody;
				return () => {
					method.MethodBody = oldBody;
					method.CodeType = oldCodeType;
				};
			});
		}

		CilBody BuildCilBody(ModuleEntry moduleEntry, MethodDef method, ReplaceIlBodyRequest request) {
			if (request.Instructions.Count == 0 || request.Instructions.Count > 100_000)
				throw new RpcException(ErrorCodes.EditValidationFailed, "A method body must contain between 1 and 100,000 instructions.");
			var context = CreateEditContext(moduleEntry);
			var body = new CilBody {
				KeepOldMaxStack = request.KeepOldMaxStack,
				InitLocals = request.InitLocals,
				MaxStack = (ushort)Math.Clamp(request.MaxStack, 0, ushort.MaxValue),
			};

			foreach (var local in request.Locals) {
				var type = context.Signatures.FromDto(local.Type)
					?? throw new RpcException(ErrorCodes.EditValidationFailed, "A local variable needs a type.");
				body.Variables.Add(new Local(local.IsPinned ? new PinnedSig(type) : type) {
					Name = local.Name,
					Attributes = (PdbLocalAttributes)local.Attributes,
				});
			}

			var instructions = new Dictionary<string, Instruction>(StringComparer.Ordinal);
			foreach (var source in request.Instructions) {
				if (string.IsNullOrWhiteSpace(source.Label))
					throw new RpcException(ErrorCodes.EditValidationFailed, "An instruction label is empty.");
				if (instructions.ContainsKey(source.Label))
					throw new RpcException(ErrorCodes.EditValidationFailed, $"Instruction label is duplicated: {source.Label}");
				var instruction = new Instruction(GetOpCode(source.OpCode));
				instructions.Add(source.Label, instruction);
				body.Instructions.Add(instruction);
			}

			for (var index = 0; index < request.Instructions.Count; index++) {
				var source = request.Instructions[index];
				body.Instructions[index].Operand = ParseIlOperand(method, body, context, body.Instructions[index].OpCode, source, instructions);
			}

			foreach (var handler in request.ExceptionHandlers) {
				var exceptionHandler = new ExceptionHandler(ParseHandlerType(handler.HandlerType)) {
					TryStart = ResolveLabel(handler.TryStart, instructions),
					TryEnd = ResolveLabel(handler.TryEnd, instructions),
					FilterStart = ResolveLabel(handler.FilterStart, instructions),
					HandlerStart = ResolveLabel(handler.HandlerStart, instructions),
					HandlerEnd = ResolveLabel(handler.HandlerEnd, instructions),
					CatchType = handler.CatchType is null ? null : context.Signatures.FromDtoRequired(handler.CatchType).ToTypeDefOrRef(),
				};
				ValidateExceptionHandler(exceptionHandler);
				body.ExceptionHandlers.Add(exceptionHandler);
			}

			body.UpdateInstructionOffsets();
			return body;
		}

		static ExceptionHandlerType ParseHandlerType(string text) => text.ToLowerInvariant() switch {
			"catch" => ExceptionHandlerType.Catch,
			"filter" => ExceptionHandlerType.Filter,
			"finally" => ExceptionHandlerType.Finally,
			"fault" => ExceptionHandlerType.Fault,
			_ => throw new RpcException(ErrorCodes.EditValidationFailed, $"Unknown exception handler type '{text}'."),
		};

		static Instruction? ResolveLabel(string? label, IReadOnlyDictionary<string, Instruction> instructions) {
			if (string.IsNullOrEmpty(label))
				return null;
			return instructions.TryGetValue(label, out var instruction)
				? instruction
				: throw new RpcException(ErrorCodes.EditValidationFailed, $"Branch target does not exist: {label}");
		}

		static void ValidateExceptionHandler(ExceptionHandler handler) {
			if (handler.TryStart is null || handler.HandlerStart is null)
				throw new RpcException(ErrorCodes.EditValidationFailed, "An exception handler needs a try block and a handler.");
			if (handler.HandlerType == ExceptionHandlerType.Catch && handler.CatchType is null)
				throw new RpcException(ErrorCodes.EditValidationFailed, "A catch clause needs a catch type.");
			if (handler.HandlerType == ExceptionHandlerType.Filter && handler.FilterStart is null)
				throw new RpcException(ErrorCodes.EditValidationFailed, "A filter clause needs a filter start.");
		}

		object? ParseIlOperand(
			MethodDef method,
			CilBody body,
			EditContext context,
			OpCode opCode,
			IlBodyInstructionDto source,
			IReadOnlyDictionary<string, Instruction> instructions) {
			var operandType = opCode.OperandType;
			if (source.CallSiteSignature is not null && operandType == OperandType.InlineSig)
				return context.Signatures.MethodFromDto(source.CallSiteSignature);
			try {
				return operandType switch {
					OperandType.InlineNone or OperandType.InlinePhi => null,
					OperandType.ShortInlineI => opCode.Code == Code.Ldc_I4_S
						? sbyte.Parse(RequiredOperand(source), NumberStyles.Integer, CultureInfo.InvariantCulture)
						: byte.Parse(RequiredOperand(source), NumberStyles.Integer, CultureInfo.InvariantCulture),
					OperandType.InlineI => int.Parse(RequiredOperand(source), NumberStyles.Integer, CultureInfo.InvariantCulture),
					OperandType.InlineI8 => long.Parse(RequiredOperand(source), NumberStyles.Integer, CultureInfo.InvariantCulture),
					OperandType.ShortInlineR => float.Parse(RequiredOperand(source), NumberStyles.Float, CultureInfo.InvariantCulture),
					OperandType.InlineR => double.Parse(RequiredOperand(source), NumberStyles.Float, CultureInfo.InvariantCulture),
					OperandType.InlineString => RequiredOperand(source),
					OperandType.ShortInlineBrTarget or OperandType.InlineBrTarget => GetTarget(RequiredOperand(source), instructions),
					OperandType.InlineSwitch => RequiredOperand(source)
						.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
						.Select(label => GetTarget(label, instructions))
						.ToArray(),
					OperandType.ShortInlineVar or OperandType.InlineVar => GetVariableOperand(method, body, source),
					OperandType.InlineType => ResolveTypeOperand(context, source),
					OperandType.InlineField => ResolveMemberOperand(context, source) as IField
						?? throw new RpcException(ErrorCodes.EditValidationFailed, "The operand is not a field."),
					OperandType.InlineMethod => ResolveMethodOperand(context, source),
					OperandType.InlineTok => ResolveTokenOperand(context, source),
					_ => throw new RpcException(ErrorCodes.EditValidationFailed, $"Operand type {operandType} is not supported by the IL editor."),
				};
			}
			catch (RpcException) {
				throw;
			}
			catch (Exception ex) when (ex is FormatException or OverflowException or ArgumentOutOfRangeException) {
				throw new RpcException(ErrorCodes.EditValidationFailed, $"The operand for {opCode.Name} is invalid.", null, ex);
			}
		}

		static string RequiredOperand(IlBodyInstructionDto source) =>
			source.Operand ?? throw new RpcException(ErrorCodes.EditValidationFailed, $"{source.OpCode} requires an operand.");

		static object GetVariableOperand(MethodDef method, CilBody body, IlBodyInstructionDto source) {
			var index = int.Parse(source.Operand ?? string.Empty, NumberStyles.None, CultureInfo.InvariantCulture);
			return source.OperandKind?.ToLowerInvariant() switch {
				IlOperandKinds.Argument when index >= 0 && index < method.Parameters.Count => method.Parameters[index],
				IlOperandKinds.Local when index >= 0 && index < body.Variables.Count => body.Variables[index],
				_ => throw new RpcException(ErrorCodes.EditValidationFailed, "Variable operands require a valid local or argument index."),
			};
		}

		ITypeDefOrRef ResolveTypeOperand(EditContext context, IlBodyInstructionDto source) {
			if (source.TypeSignature is not null) {
				return context.Signatures.FromDtoRequired(source.TypeSignature).ToTypeDefOrRef()
					?? throw new RpcException(ErrorCodes.EditValidationFailed, "The type signature names nothing that can be used here.");
			}
			return ResolveMemberOperand(context, source) as ITypeDefOrRef
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "The operand is not a type.");
		}

		object? ResolveMemberOperand(EditContext context, IlBodyInstructionDto source) {
			if (source.NodeId is { Length: > 0 })
				return GetNode(source.NodeId).Value;
			if (source.Token is { Length: > 0 }) {
				if (!uint.TryParse(source.Token, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var rawToken))
					throw new RpcException(ErrorCodes.EditValidationFailed, "The metadata token operand is invalid.");
				return context.Module.ResolveToken(rawToken)
					?? throw new RpcException(ErrorCodes.EditValidationFailed, "The metadata token operand could not be resolved.");
			}
			return null;
		}

		object ResolveTokenOperand(EditContext context, IlBodyInstructionDto source) {
			if (source.MethodRef is not null)
				return ResolveMethodOperand(context, source);
			if (source.TypeSignature is not null)
				return ResolveTypeOperand(context, source);
			return ResolveMemberOperand(context, source)
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "The operand names nothing.");
		}

		IMethod ResolveMethodOperand(EditContext context, IlBodyInstructionDto source) {
			IMethodDefOrRef method = source.MethodRef is not null
				? context.MethodRefs.FromDtoMethod(source.MethodRef)
				: ResolveMemberOperand(context, source) switch {
					IMethodDefOrRef resolved => resolved,
					_ => throw new RpcException(ErrorCodes.EditValidationFailed, "The operand is not a method."),
				};
			if (source.MethodSpecArguments is { Count: > 0 }) {
				var arguments = source.MethodSpecArguments.Select(argument => context.Signatures.FromDtoRequired(argument)).ToList();
				return new MethodSpecUser(method, new GenericInstMethodSig(arguments));
			}
			return method;
		}

		public TransformIlBodyResponse TransformIlBody(TransformIlBodyRequest request) {
			var node = GetNode(request.MethodNodeId);
			if (node.Value is not MethodDef method)
				throw new RpcException(ErrorCodes.EditValidationFailed, "The selected item is not a method.");
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support method body editing.");
			var locals = request.Locals.ToList();
			var instructions = request.Instructions.ToList();
			var selected = request.SelectedIndexes
				.Where(index => index >= 0 && index < instructions.Count)
				.Distinct()
				.OrderBy(index => index)
				.ToArray();
			var resolver = new TransformOperandResolver(
				moduleEntry.Module,
				CreateEditContext(moduleEntry).Signatures,
				nodeId => GetNode(nodeId).Value);
			switch (request.Operation) {
				case IlTransformOperations.SimplifyAll:
					for (var index = 0; index < instructions.Count; index++)
						instructions[index] = IlTransform.Simplify(instructions[index]);
					break;
				case IlTransformOperations.OptimizeAll:
					for (var index = 0; index < instructions.Count; index++)
						instructions[index] = IlTransform.Optimize(instructions[index]);
					IlTransform.OptimizeBranches(instructions);
					break;
				case IlTransformOperations.ReplaceWithNop:
					foreach (var index in selected)
						instructions[index] = IlTransform.AsNop(instructions[index]);
					break;
				case IlTransformOperations.ReplaceWithMultipleNops:
					foreach (var index in selected.Reverse()) {
						var size = IlTransform.Size(instructions[index]);
						for (var i = 1; i < size; i++)
							instructions.Insert(index + i, new IlBodyInstructionDto(NewLabel(instructions, "nop"), "nop", IlOperandKinds.None));
						instructions[index] = IlTransform.AsNop(instructions[index]);
					}
					break;
				case IlTransformOperations.InvertBranch:
					foreach (var index in selected)
						instructions[index] = IlTransform.Invert(instructions[index]);
					break;
				case IlTransformOperations.ConvertBranchToUnconditional:
					foreach (var index in selected.Reverse())
						IlTransform.ConvertBranchToUnconditional(instructions, index);
					break;
				case IlTransformOperations.RemoveAndAddPops:
					foreach (var index in selected.Reverse())
						IlTransform.RemoveAndAddPops(instructions, index, locals, resolver);
					break;
				default:
					throw new RpcException(ErrorCodes.InvalidParams, $"Unknown IL transform '{request.Operation}'.");
			}
			return new TransformIlBodyResponse(locals, instructions);
		}

		static string NewLabel(IReadOnlyList<IlBodyInstructionDto> instructions, string prefix) {
			var used = instructions.Select(instruction => instruction.Label).ToHashSet(StringComparer.Ordinal);
			for (var index = 0; ; index++) {
				var label = $"__{prefix}{index}";
				if (!used.Contains(label))
					return label;
			}
		}
	}
}

/// <summary>
/// The pure instruction-list commands of dnSpy's IL editor, ported from its <c>BodyUtils</c> macros.
/// Each one answers a rewritten instruction; nothing here talks to the module.
/// </summary>
static class IlTransform {
	public static IlBodyInstructionDto AsNop(IlBodyInstructionDto instruction) => instruction with {
		OpCode = "nop",
		OperandKind = IlOperandKinds.None,
		Operand = null,
		OperandDisplay = null,
		NodeId = null,
		Token = null,
		MethodRef = null,
		MethodSpecArguments = null,
		TypeSignature = null,
		CallSiteSignature = null,
	};

	public static IlBodyInstructionDto Simplify(IlBodyInstructionDto instruction) {
		switch (instruction.OpCode.ToLowerInvariant()) {
			case "beq.s": return instruction with { OpCode = "beq" };
			case "bge.s": return instruction with { OpCode = "bge" };
			case "bge.un.s": return instruction with { OpCode = "bge.un" };
			case "bgt.s": return instruction with { OpCode = "bgt" };
			case "bgt.un.s": return instruction with { OpCode = "bgt.un" };
			case "ble.s": return instruction with { OpCode = "ble" };
			case "ble.un.s": return instruction with { OpCode = "ble.un" };
			case "blt.s": return instruction with { OpCode = "blt" };
			case "blt.un.s": return instruction with { OpCode = "blt.un" };
			case "bne.un.s": return instruction with { OpCode = "bne.un" };
			case "br.s": return instruction with { OpCode = "br" };
			case "brfalse.s": return instruction with { OpCode = "brfalse" };
			case "brtrue.s": return instruction with { OpCode = "brtrue" };
			case "leave.s": return instruction with { OpCode = "leave" };
			case "ldarg.s": return instruction with { OpCode = "ldarg" };
			case "ldarga.s": return instruction with { OpCode = "ldarga" };
			case "ldloc.s": return instruction with { OpCode = "ldloc" };
			case "ldloca.s": return instruction with { OpCode = "ldloca" };
			case "starg.s": return instruction with { OpCode = "starg" };
			case "stloc.s": return instruction with { OpCode = "stloc" };
			case "ldarg.0": return instruction with { OpCode = "ldarg", OperandKind = IlOperandKinds.Argument, Operand = "0", OperandDisplay = "0" };
			case "ldarg.1": return instruction with { OpCode = "ldarg", OperandKind = IlOperandKinds.Argument, Operand = "1", OperandDisplay = "1" };
			case "ldarg.2": return instruction with { OpCode = "ldarg", OperandKind = IlOperandKinds.Argument, Operand = "2", OperandDisplay = "2" };
			case "ldarg.3": return instruction with { OpCode = "ldarg", OperandKind = IlOperandKinds.Argument, Operand = "3", OperandDisplay = "3" };
			case "ldc.i4.m1": return instruction with { OpCode = "ldc.i4", OperandKind = IlOperandKinds.Number, Operand = "-1", OperandDisplay = "-1" };
			case "ldc.i4.0": return instruction with { OpCode = "ldc.i4", OperandKind = IlOperandKinds.Number, Operand = "0", OperandDisplay = "0" };
			case "ldc.i4.1": return instruction with { OpCode = "ldc.i4", OperandKind = IlOperandKinds.Number, Operand = "1", OperandDisplay = "1" };
			case "ldc.i4.2": return instruction with { OpCode = "ldc.i4", OperandKind = IlOperandKinds.Number, Operand = "2", OperandDisplay = "2" };
			case "ldc.i4.3": return instruction with { OpCode = "ldc.i4", OperandKind = IlOperandKinds.Number, Operand = "3", OperandDisplay = "3" };
			case "ldc.i4.4": return instruction with { OpCode = "ldc.i4", OperandKind = IlOperandKinds.Number, Operand = "4", OperandDisplay = "4" };
			case "ldc.i4.5": return instruction with { OpCode = "ldc.i4", OperandKind = IlOperandKinds.Number, Operand = "5", OperandDisplay = "5" };
			case "ldc.i4.6": return instruction with { OpCode = "ldc.i4", OperandKind = IlOperandKinds.Number, Operand = "6", OperandDisplay = "6" };
			case "ldc.i4.7": return instruction with { OpCode = "ldc.i4", OperandKind = IlOperandKinds.Number, Operand = "7", OperandDisplay = "7" };
			case "ldc.i4.8": return instruction with { OpCode = "ldc.i4", OperandKind = IlOperandKinds.Number, Operand = "8", OperandDisplay = "8" };
			case "ldc.i4.s": return instruction with { OpCode = "ldc.i4", OperandKind = IlOperandKinds.Number };
			case "ldloc.0": return instruction with { OpCode = "ldloc", OperandKind = IlOperandKinds.Local, Operand = "0", OperandDisplay = "V_0" };
			case "ldloc.1": return instruction with { OpCode = "ldloc", OperandKind = IlOperandKinds.Local, Operand = "1", OperandDisplay = "V_1" };
			case "ldloc.2": return instruction with { OpCode = "ldloc", OperandKind = IlOperandKinds.Local, Operand = "2", OperandDisplay = "V_2" };
			case "ldloc.3": return instruction with { OpCode = "ldloc", OperandKind = IlOperandKinds.Local, Operand = "3", OperandDisplay = "V_3" };
			case "stloc.0": return instruction with { OpCode = "stloc", OperandKind = IlOperandKinds.Local, Operand = "0", OperandDisplay = "V_0" };
			case "stloc.1": return instruction with { OpCode = "stloc", OperandKind = IlOperandKinds.Local, Operand = "1", OperandDisplay = "V_1" };
			case "stloc.2": return instruction with { OpCode = "stloc", OperandKind = IlOperandKinds.Local, Operand = "2", OperandDisplay = "V_2" };
			case "stloc.3": return instruction with { OpCode = "stloc", OperandKind = IlOperandKinds.Local, Operand = "3", OperandDisplay = "V_3" };
			default: return instruction;
		}
	}

	public static IlBodyInstructionDto Optimize(IlBodyInstructionDto instruction) {
		var number = ParseNumber(instruction.Operand);
		IlBodyInstructionDto Macro(string name) => instruction with {
			OpCode = name,
			OperandKind = IlOperandKinds.None,
			Operand = null,
			OperandDisplay = null,
		};
		IlBodyInstructionDto Sized(string name, string kind, string text) => instruction with {
			OpCode = name,
			OperandKind = kind,
			Operand = text,
			OperandDisplay = text,
		};
		switch (instruction.OpCode.ToLowerInvariant()) {
			case "ldarg":
			case "ldarg.s":
				if (number is not { } argument)
					return instruction;
				return argument switch {
					0 => Macro("ldarg.0"),
					1 => Macro("ldarg.1"),
					2 => Macro("ldarg.2"),
					3 => Macro("ldarg.3"),
					>= byte.MinValue and <= byte.MaxValue => instruction with { OpCode = "ldarg.s" },
					_ => instruction,
				};
			case "ldarga":
			case "ldarga.s":
				return number is >= byte.MinValue and <= byte.MaxValue ? instruction with { OpCode = "ldarga.s" } : instruction;
			case "ldc.i4":
			case "ldc.i4.s":
				if (number is not { } value)
					return instruction;
				return value switch {
					-1 => Macro("ldc.i4.m1"),
					0 => Macro("ldc.i4.0"),
					1 => Macro("ldc.i4.1"),
					2 => Macro("ldc.i4.2"),
					3 => Macro("ldc.i4.3"),
					4 => Macro("ldc.i4.4"),
					5 => Macro("ldc.i4.5"),
					6 => Macro("ldc.i4.6"),
					7 => Macro("ldc.i4.7"),
					8 => Macro("ldc.i4.8"),
					>= sbyte.MinValue and <= sbyte.MaxValue => Sized("ldc.i4.s", IlOperandKinds.Number, value.ToString(CultureInfo.InvariantCulture)),
					_ => instruction with { OpCode = "ldc.i4" },
				};
			case "ldloc":
			case "ldloc.s":
				if (number is not { } local)
					return instruction;
				return local switch {
					0 => Macro("ldloc.0"),
					1 => Macro("ldloc.1"),
					2 => Macro("ldloc.2"),
					3 => Macro("ldloc.3"),
					>= byte.MinValue and <= byte.MaxValue => instruction with { OpCode = "ldloc.s" },
					_ => instruction,
				};
			case "ldloca":
			case "ldloca.s":
				return number is >= byte.MinValue and <= byte.MaxValue ? instruction with { OpCode = "ldloca.s" } : instruction;
			case "starg":
			case "starg.s":
				return number is >= byte.MinValue and <= byte.MaxValue ? instruction with { OpCode = "starg.s" } : instruction;
			case "stloc":
			case "stloc.s":
				if (number is not { } stored)
					return instruction;
				return stored switch {
					0 => Macro("stloc.0"),
					1 => Macro("stloc.1"),
					2 => Macro("stloc.2"),
					3 => Macro("stloc.3"),
					>= byte.MinValue and <= byte.MaxValue => instruction with { OpCode = "stloc.s" },
					_ => instruction,
				};
			default:
				return instruction;
		}
	}

	static int? ParseNumber(string? text) =>
		int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var value) ? value : null;

	/// <summary>
	/// dnSpy's <c>OptimizeBranches</c>: shorten a branch while its displacement still fits in a byte,
	/// repeating because every shortening moves the instructions after it.
	/// </summary>
	public static void OptimizeBranches(List<IlBodyInstructionDto> instructions) {
		var shortForms = new Dictionary<string, string>(StringComparer.Ordinal) {
			["beq"] = "beq.s",
			["bge"] = "bge.s",
			["bge.un"] = "bge.un.s",
			["bgt"] = "bgt.s",
			["bgt.un"] = "bgt.un.s",
			["ble"] = "ble.s",
			["ble.un"] = "ble.un.s",
			["blt"] = "blt.s",
			["blt.un"] = "blt.un.s",
			["bne.un"] = "bne.un.s",
			["br"] = "br.s",
			["brfalse"] = "brfalse.s",
			["brtrue"] = "brtrue.s",
			["leave"] = "leave.s",
		};
		for (var pass = 0; pass < 8; pass++) {
			var offsets = ComputeOffsets(instructions);
			var modified = false;
			for (var index = 0; index < instructions.Count; index++) {
				var instruction = instructions[index];
				if (!shortForms.TryGetValue(instruction.OpCode, out var shortOpCode))
					continue;
				var targetIndex = instruction.Operand is null ? -1 : instructions.FindIndex(other => other.Label == instruction.Operand);
				if (targetIndex < 0)
					continue;
				// The displacement is measured from the end of the short form, which is two bytes long.
				var afterShort = targetIndex >= index ? offsets[index] + Size(instruction) : offsets[index] + 2;
				var displacement = offsets[targetIndex] - afterShort;
				if (displacement is < sbyte.MinValue or > sbyte.MaxValue)
					continue;
				instructions[index] = instruction with { OpCode = shortOpCode };
				modified = true;
			}
			if (!modified)
				break;
		}
	}

	static List<int> ComputeOffsets(IReadOnlyList<IlBodyInstructionDto> instructions) {
		var offsets = new List<int>(instructions.Count);
		var offset = 0;
		foreach (var instruction in instructions) {
			offsets.Add(offset);
			offset += Size(instruction);
		}
		return offsets;
	}

	/// <summary>The number of bytes an instruction occupies — its opcode's size plus its operand's width.</summary>
	public static int Size(IlBodyInstructionDto instruction) {
		var opCode = OpCodesByName.TryGetValue(instruction.OpCode, out var found) ? found : OpCodes.Nop;
		return opCode.Size + opCode.OperandType switch {
			OperandType.InlineNone or OperandType.InlinePhi => 0,
			OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
			OperandType.InlineVar => 2,
			OperandType.InlineSwitch => 4 + 4 * (instruction.Operand?.Split(',', StringSplitOptions.RemoveEmptyEntries).Length ?? 0),
			OperandType.InlineI8 or OperandType.InlineR => 8,
			_ => 4,
		};
	}

	public static IlBodyInstructionDto Invert(IlBodyInstructionDto instruction) {
		var inverted = instruction.OpCode.ToLowerInvariant() switch {
			"beq" => "bne.un",
			"beq.s" => "bne.un.s",
			"bge" => "blt",
			"bge.s" => "blt.s",
			"bge.un" => "blt.un",
			"bge.un.s" => "blt.un.s",
			"bgt" => "ble",
			"bgt.s" => "ble.s",
			"bgt.un" => "ble.un",
			"bgt.un.s" => "ble.un.s",
			"ble" => "bgt",
			"ble.s" => "bgt.s",
			"ble.un" => "bgt.un",
			"ble.un.s" => "bgt.un.s",
			"blt" => "bge",
			"blt.s" => "bge.s",
			"blt.un" => "bge.un",
			"blt.un.s" => "bge.un.s",
			"bne.un" => "beq",
			"bne.un.s" => "beq.s",
			"brfalse" => "brtrue",
			"brfalse.s" => "brtrue.s",
			"brtrue" => "brfalse",
			"brtrue.s" => "brfalse.s",
			_ => null,
		};
		return inverted is null ? instruction : instruction with { OpCode = inverted };
	}

	public static void ConvertBranchToUnconditional(List<IlBodyInstructionDto> instructions, int index) {
		var instruction = instructions[index];
		var popCount = instruction.OpCode.ToLowerInvariant() switch {
			"beq" or "beq.s" or "bge" or "bge.s" or "bge.un" or "bge.un.s" or "bgt" or "bgt.s" or "bgt.un" or "bgt.un.s" or
			"ble" or "ble.s" or "ble.un" or "ble.un.s" or "blt" or "blt.s" or "blt.un" or "blt.un.s" or "bne.un" or "bne.un.s" => 2,
			"brfalse" or "brfalse.s" or "brtrue" or "brtrue.s" => 1,
			_ => 0,
		};
		if (popCount <= 0)
			return;
		var target = instruction.Operand;
		var display = instruction.OperandDisplay;
		instructions[index] = instruction with {
			OpCode = "pop",
			OperandKind = IlOperandKinds.None,
			Operand = null,
			OperandDisplay = null,
		};
		var insert = index + 1;
		for (var remaining = popCount - 1; remaining > 0; remaining--)
			instructions.Insert(insert++, new IlBodyInstructionDto($"__br{instructions.Count}_{insert}", "pop", IlOperandKinds.None));
		instructions.Insert(insert, new IlBodyInstructionDto($"__br{instructions.Count}_{insert}", "br", IlOperandKinds.Branch, target, display));
	}

	/// <summary>
	/// dnSpy's "Remove Instruction and Add Pops": takes out the instruction, pops what it popped and
	/// pushes a default value in place of what it pushed. An instruction whose stack effect cannot be
	/// modelled — <c>leave</c> — is left alone, exactly as WPF's CanExecute does.
	/// </summary>
	public static void RemoveAndAddPops(
		List<IlBodyInstructionDto> instructions,
		int index,
		List<IlLocalDto> locals,
		TransformOperandResolver resolver) {
		var instruction = instructions[index];
		if (instruction.OpCode.Equals("pop", StringComparison.OrdinalIgnoreCase) ||
			instruction.OpCode.Equals("nop", StringComparison.OrdinalIgnoreCase))
			return;
		var usage = resolver.CalculateStackUsage(instruction);
		// dnSpy's own CanExecute: an instruction that pushes something dnSpy cannot name a default for
		// (anything but a call, callvirt, calli or newobj) has no command.
		if (usage is not { } effect || effect.Pops < 0 || (effect.Pushes > 0 && effect.PushType is null))
			return;
		if (instruction.OpCode.Equals("callvirt", StringComparison.OrdinalIgnoreCase) && index >= 1 &&
			instructions[index - 1].OpCode.StartsWith("constrained.", StringComparison.OrdinalIgnoreCase)) {
			instructions[index - 1] = AsNop(instructions[index - 1]);
		}
		var replacement = new List<IlBodyInstructionDto>();
		if (effect.Pops == 0) {
			replacement.Add(AsNop(instruction));
		}
		else {
			replacement.Add(instruction with { OpCode = "pop", OperandKind = IlOperandKinds.None, Operand = null, OperandDisplay = null });
			for (var remaining = effect.Pops - 1; remaining > 0; remaining--)
				replacement.Add(new IlBodyInstructionDto($"__pop{instructions.Count}_{remaining}", "pop", IlOperandKinds.None));
		}
		if (effect.Pushes > 0)
			AddPushDefaultValue(replacement, effect.PushType, locals);
		instructions.RemoveAt(index);
		instructions.InsertRange(index, replacement);
	}

	static void AddPushDefaultValue(List<IlBodyInstructionDto> output, TypeSigDto? type, List<IlLocalDto> locals) {
		if (type is null)
			return;
		var seed = output.Count;
		string NextLabel(string prefix) => $"__{prefix}{seed}_{output.Count}";
		switch (ElementKind(type)) {
			case IlElementKind.Void:
				return;
			case IlElementKind.I4:
				output.Add(new IlBodyInstructionDto(NextLabel("d"), "ldc.i4.0", IlOperandKinds.None));
				return;
			case IlElementKind.I8:
				output.Add(new IlBodyInstructionDto(NextLabel("d"), "ldc.i4.0", IlOperandKinds.None));
				output.Add(new IlBodyInstructionDto(NextLabel("d"), "conv.i8", IlOperandKinds.None));
				return;
			case IlElementKind.R4:
				output.Add(new IlBodyInstructionDto(NextLabel("d"), "ldc.r4", IlOperandKinds.Number, string.Empty));
				return;
			case IlElementKind.R8:
				output.Add(new IlBodyInstructionDto(NextLabel("d"), "ldc.r8", IlOperandKinds.Number, string.Empty));
				return;
			case IlElementKind.I:
				output.Add(new IlBodyInstructionDto(NextLabel("d"), "ldc.i4.0", IlOperandKinds.None));
				output.Add(new IlBodyInstructionDto(NextLabel("d"), "conv.i", IlOperandKinds.None));
				return;
			case IlElementKind.U:
				output.Add(new IlBodyInstructionDto(NextLabel("d"), "ldc.i4.0", IlOperandKinds.None));
				output.Add(new IlBodyInstructionDto(NextLabel("d"), "conv.u", IlOperandKinds.None));
				return;
			case IlElementKind.ValueType:
			case IlElementKind.GenericVar:
				locals.Add(new IlLocalDto(null, type));
				var localIndex = (locals.Count - 1).ToString(CultureInfo.InvariantCulture);
				output.Add(new IlBodyInstructionDto(NextLabel("d"), "ldloca", IlOperandKinds.Local, localIndex, $"V_{localIndex}"));
				output.Add(new IlBodyInstructionDto(NextLabel("d"), "initobj", IlOperandKinds.Type, TypeText(type), TypeText(type), TypeSignature: type));
				output.Add(new IlBodyInstructionDto(NextLabel("d"), "ldloc", IlOperandKinds.Local, localIndex, $"V_{localIndex}"));
				return;
			default:
				output.Add(new IlBodyInstructionDto(NextLabel("d"), "ldnull", IlOperandKinds.None));
				return;
		}
	}

	static string TypeText(TypeSigDto type) => type.Display.Length > 0 ? type.Display : type.Type is null ? type.Kind : string.IsNullOrEmpty(type.Type.Namespace) ? type.Type.Name : $"{type.Type.Namespace}.{type.Type.Name}";

	enum IlElementKind { Void, Class, I4, I8, R4, R8, I, U, ValueType, GenericVar }

	static IlElementKind ElementKind(TypeSigDto type) {
		switch (type.Kind) {
			case TypeSigKinds.GenericInst:
				return type.ValueType == true ? IlElementKind.ValueType : IlElementKind.Class;
			case TypeSigKinds.SzArray:
			case TypeSigKinds.Array:
			case TypeSigKinds.ByRef:
				return IlElementKind.Class;
			case TypeSigKinds.Pointer:
			case TypeSigKinds.FnPtr:
				return IlElementKind.U;
			case TypeSigKinds.GenericVar:
			case TypeSigKinds.GenericMVar:
				return IlElementKind.GenericVar;
			case TypeSigKinds.Pinned:
			case TypeSigKinds.CModOpt:
			case TypeSigKinds.CModReqd:
				return type.Element is null ? IlElementKind.Class : ElementKind(type.Element);
			case TypeSigKinds.Type:
				if (type.ValueType != true)
					return TypeName(type) == "System.Void" ? IlElementKind.Void : IlElementKind.Class;
				return TypeName(type) switch {
					"System.Boolean" or "System.Char" or "System.SByte" or "System.Byte" or "System.Int16" or "System.UInt16" or "System.Int32" or "System.UInt32" => IlElementKind.I4,
					"System.Int64" or "System.UInt64" => IlElementKind.I8,
					"System.Single" => IlElementKind.R4,
					"System.Double" => IlElementKind.R8,
					"System.IntPtr" => IlElementKind.I,
					"System.UIntPtr" => IlElementKind.U,
					"System.Void" => IlElementKind.Void,
					_ => IlElementKind.ValueType,
				};
			default:
				return IlElementKind.Class;
		}
	}

	static string TypeName(TypeSigDto type) {
		if (type.Type is null)
			return type.Display;
		return string.IsNullOrEmpty(type.Type.Namespace) ? type.Type.Name : $"{type.Type.Namespace}.{type.Type.Name}";
	}

	static readonly IReadOnlyDictionary<string, OpCode> OpCodesByName = typeof(OpCodes)
		.GetFields(BindingFlags.Public | BindingFlags.Static)
		.Where(field => field.FieldType == typeof(OpCode))
		.Select(field => (OpCode)field.GetValue(null)!)
		.GroupBy(opCode => opCode.Name, StringComparer.OrdinalIgnoreCase)
		.ToDictionary(group => group.Key, group => group.First(), StringComparer.OrdinalIgnoreCase);
}

/// <summary>
/// Answers the stack effect of an instruction that is still a model — dnSpy's
/// <c>InstructionVM.CalculateStackUsage</c>. The method signature behind a call is the only thing the
/// opcode tables cannot say, so it is looked up from whichever way the operand names it.
/// </summary>
sealed class TransformOperandResolver(
	ModuleDef module,
	SignatureCodec signatures,
	Func<string, object?> resolveNode) {
	public (int Pops, int Pushes, TypeSigDto? PushType)? CalculateStackUsage(IlBodyInstructionDto instruction) {
		var opCode = OpCodesByName.TryGetValue(instruction.OpCode, out var found) ? found : OpCodes.Nop;
		var operand = ResolveOperand(instruction, opCode);
		if (operand is null && (opCode.OperandType is OperandType.InlineMethod or OperandType.InlineTok or OperandType.InlineField or OperandType.InlineType))
			return null;
		try {
			var scratch = operand is null ? new Instruction(opCode) : new Instruction(opCode, operand);
			scratch.CalculateStackUsage(out var pushes, out var pops);
			TypeSigDto? pushType = null;
			if (pushes == 1 && opCode.Code is Code.Call or Code.Callvirt or Code.Calli)
				pushType = ReturnTypeOf(instruction);
			else if (pushes == 1 && opCode.Code == Code.Newobj) {
				pushType = instruction.MethodRef?.DeclaringType;
				if (pushType is null && ResolveByNodeOrToken(instruction) is IMethod target)
					pushType = signatures.ToDto(target.DeclaringType);
			}
			return (pops, pushes, pushType);
		}
		catch (Exception) {
			return null;
		}
	}

	object? ResolveOperand(IlBodyInstructionDto instruction, OpCode opCode) {
		if (instruction.CallSiteSignature is not null)
			return signatures.MethodFromDto(instruction.CallSiteSignature);
		if (opCode.OperandType == OperandType.InlineMethod) {
			if (instruction.MethodRef is not null)
				return BuildMethodRef(instruction.MethodRef);
			return ResolveByNodeOrToken(instruction);
		}
		if (opCode.OperandType is OperandType.InlineField or OperandType.InlineTok or OperandType.InlineType)
			return ResolveByNodeOrToken(instruction);
		return null;
	}

	object? ResolveByNodeOrToken(IlBodyInstructionDto instruction) {
		if (instruction.NodeId is { Length: > 0 })
			return resolveNode(instruction.NodeId);
		if (instruction.Token is { Length: > 0 } && uint.TryParse(instruction.Token, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var token))
			return module.ResolveToken(token);
		return null;
	}

	IMethod BuildMethodRef(MethodRefDto reference) {
		// A scratch module keeps the stack question from creating rows in the module being edited.
		var scratch = new ModuleDefUser("transform");
		var scratchSignatures = new SignatureCodec(new EditContext(scratch));
		var signature = scratchSignatures.MethodFromDto(reference.Signature);
		var declaringType = scratchSignatures.FromDtoRequired(reference.DeclaringType).ToTypeDefOrRef()
			?? new TypeRefUser(scratch, reference.DeclaringType.Type?.Namespace ?? string.Empty, reference.DeclaringType.Type?.Name ?? "Object");
		return new MemberRefUser(scratch, reference.Name, signature, declaringType);
	}

	TypeSigDto? ReturnTypeOf(IlBodyInstructionDto instruction) {
		if (instruction.CallSiteSignature is not null)
			return instruction.CallSiteSignature.ReturnType;
		if (instruction.MethodRef is not null)
			return instruction.MethodRef.Signature.ReturnType;
		return ResolveByNodeOrToken(instruction) is IMethod method ? signatures.ToDto(method.MethodSig?.RetType) : null;
	}

	static readonly IReadOnlyDictionary<string, OpCode> OpCodesByName = typeof(OpCodes)
		.GetFields(BindingFlags.Public | BindingFlags.Static)
		.Where(field => field.FieldType == typeof(OpCode))
		.Select(field => (OpCode)field.GetValue(null)!)
		.GroupBy(opCode => opCode.Name, StringComparer.OrdinalIgnoreCase)
		.ToDictionary(group => group.Key, group => group.First(), StringComparer.OrdinalIgnoreCase);
}
