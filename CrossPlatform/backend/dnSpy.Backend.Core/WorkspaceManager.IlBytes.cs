using System.Text;
using dnlib.DotNet;
using dnlib.DotNet.Emit;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core;

/// <summary>
/// dnSpy's Copy IL Bytes: the bytes the selected instructions are encoded as. A body that is still the one the file
/// holds is read from the file; an edited one is encoded from its instructions, the way dnSpy's
/// ModifiedInstructionBytesReader does, with "??" for what is only known once the module has been saved — the token
/// of a row an edit added, and every string's.
/// </summary>
public sealed partial class WorkspaceManager {
	public Task<IlBytesResponse> GetIlBytesAsync(IlBytesRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetIlBytes(request), cancellationToken);

	sealed partial class Workspace {
		public IlBytesResponse GetIlBytes(IlBytesRequest request) {
			var module = FindModuleEntry(request.ModulePath)
				?? throw new RpcException(ErrorCodes.NodeNotFound, "The module is no longer open.");
			var text = new StringBuilder();
			var unknown = false;
			var cache = new Dictionary<MethodDef, (CilBody Body, IReadOnlyList<short> Bytes)>();
			foreach (var item in request.Instructions) {
				if (module.Module.ResolveToken(unchecked((uint)item.MetadataToken)) is not MethodDef { Body: { } body } method)
					continue;
				if (!cache.TryGetValue(method, out var encoded)) {
					encoded = (body, EncodeBody(method, body, module.Module));
					cache.Add(method, encoded);
				}
				var instruction = body.Instructions.FirstOrDefault(candidate => candidate.Offset == (uint)item.IlOffset);
				if (instruction is null)
					continue;
				var start = (int)instruction.Offset;
				var size = instruction.GetSize();
				for (var i = start; i < start + size && i < encoded.Bytes.Count; i++) {
					var value = encoded.Bytes[i];
					if (value < 0) {
						text.Append("??");
						unknown = true;
					}
					else {
						text.Append(value.ToString("X2", System.Globalization.CultureInfo.InvariantCulture));
					}
				}
			}
			return new IlBytesResponse(text.ToString(), unknown);
		}

		/// <summary>
		/// The body's code, one entry per byte, -1 for a byte that cannot be known. A body whose encoding agrees with
		/// the code the file holds at every byte it can say anything about is still the one read from the file, and
		/// the file's bytes — the strings' offsets among them — are the answer; dnSpy's OriginalInstructionBytesReader.
		/// </summary>
		static IReadOnlyList<short> EncodeBody(MethodDef method, CilBody body, ModuleDefMD module) {
			var encoded = new List<short>();
			foreach (var instruction in body.Instructions) {
				AddOpCode(encoded, instruction.OpCode);
				AddOperand(encoded, module, instruction.Offset + (uint)instruction.OpCode.Size, instruction.OpCode, instruction.Operand);
			}
			if (HexTargets.TryGetMethodBody(method, out _, out _, out var codeOffset, out var codeSize) && codeSize == encoded.Count) {
				try {
					var reader = module.Metadata.PEImage.CreateReader();
					reader.Position = (uint)codeOffset;
					var original = reader.ReadBytes((int)codeSize);
					var same = true;
					for (var i = 0; i < original.Length && same; i++)
						same = encoded[i] < 0 || encoded[i] == original[i];
					if (same)
						return original.Select(value => (short)value).ToArray();
				}
				catch (Exception ex) when (ex is IOException or ArgumentException or InvalidOperationException) {
					// A file that cannot be read for this has the encoding to go on.
				}
			}
			return encoded;
		}

		static void AddOpCode(List<short> bytes, OpCode opCode) {
			var value = (ushort)opCode.Value;
			if (opCode.Size == 2)
				bytes.Add((short)(value >> 8));
			bytes.Add((short)(value & 0xFF));
		}

		static void AddUnknown(List<short> bytes, int count) {
			for (var i = 0; i < count; i++)
				bytes.Add(-1);
		}

		static void AddInt(List<short> bytes, long value, int count) {
			for (var i = 0; i < count; i++)
				bytes.Add((short)((value >> (8 * i)) & 0xFF));
		}

		static void AddToken(List<short> bytes, ModuleDefMD module, uint token) {
			if (token == 0 || module.ResolveToken(token) is null)
				AddUnknown(bytes, 4);
			else
				AddInt(bytes, token, 4);
		}

		/// <summary>dnSpy's InstructionUtils.AddOperand.</summary>
		static void AddOperand(List<short> bytes, ModuleDefMD module, uint offset, OpCode opCode, object operand) {
			switch (opCode.OperandType) {
				case OperandType.InlineBrTarget:
					if (operand is Instruction target)
						AddInt(bytes, unchecked((int)target.Offset - (int)(offset + 4)), 4);
					else
						AddUnknown(bytes, 4);
					break;
				case OperandType.InlineField or OperandType.InlineMethod or OperandType.InlineTok or OperandType.InlineType:
					AddToken(bytes, module, operand is IMDTokenProvider provider ? provider.MDToken.Raw : 0);
					break;
				case OperandType.InlineSig:
					AddToken(bytes, module, operand is MethodSig signature ? signature.OriginalToken : 0);
					break;
				case OperandType.InlineString:
					AddUnknown(bytes, 4);
					break;
				case OperandType.InlineI:
					if (operand is int i4)
						AddInt(bytes, i4, 4);
					else
						AddUnknown(bytes, 4);
					break;
				case OperandType.InlineI8:
					if (operand is long i8)
						AddInt(bytes, i8, 8);
					else
						AddUnknown(bytes, 8);
					break;
				case OperandType.InlineR:
					if (operand is double r8)
						AddInt(bytes, BitConverter.DoubleToInt64Bits(r8), 8);
					else
						AddUnknown(bytes, 8);
					break;
				case OperandType.ShortInlineR:
					if (operand is float r4)
						AddInt(bytes, BitConverter.SingleToInt32Bits(r4), 4);
					else
						AddUnknown(bytes, 4);
					break;
				case OperandType.InlineSwitch:
					if (operand is IList<Instruction> targets) {
						var after = offset + 4 + (uint)targets.Count * 4;
						AddInt(bytes, targets.Count, 4);
						foreach (var switchTarget in targets) {
							if (switchTarget is null)
								AddUnknown(bytes, 4);
							else
								AddInt(bytes, unchecked((int)switchTarget.Offset - (int)after), 4);
						}
					}
					else {
						AddUnknown(bytes, 4);
					}
					break;
				case OperandType.InlineVar:
					if (operand is IVariable { Index: >= 0 and <= ushort.MaxValue } variable)
						AddInt(bytes, variable.Index, 2);
					else
						AddUnknown(bytes, 2);
					break;
				case OperandType.ShortInlineVar:
					if (operand is IVariable { Index: >= 0 and <= byte.MaxValue } shortVariable)
						AddInt(bytes, shortVariable.Index, 1);
					else
						AddUnknown(bytes, 1);
					break;
				case OperandType.ShortInlineBrTarget:
					if (operand is Instruction shortTarget && unchecked((int)shortTarget.Offset - (int)(offset + 1)) is >= sbyte.MinValue and <= sbyte.MaxValue and var displacement)
						AddInt(bytes, displacement, 1);
					else
						AddUnknown(bytes, 1);
					break;
				case OperandType.ShortInlineI:
					if (operand is sbyte s1)
						AddInt(bytes, s1, 1);
					else if (operand is byte u1)
						AddInt(bytes, u1, 1);
					else
						AddUnknown(bytes, 1);
					break;
			}
		}
	}
}
