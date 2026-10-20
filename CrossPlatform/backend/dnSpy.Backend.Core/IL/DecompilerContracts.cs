/*
    Copyright (C) 2014-2019 de4dot@gmail.com

    This file is part of dnSpy

    dnSpy is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    dnSpy is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with dnSpy.  If not, see <http://www.gnu.org/licenses/>.
*/

using System.Diagnostics.CodeAnalysis;
using dnlib.DotNet;
using dnlib.DotNet.Emit;

// The pieces of dnSpy.Contracts.Logic (Decompiler/InstructionReference.cs, IInstructionBytesReader.cs,
// MemberComparer.cs and Extensions.cs) the IL disassembler needs.
namespace dnSpy.Backend.Core.IL;

/// <summary>dnSpy's <c>InstructionReference</c>: an instruction of a method body, which an IL label names.</summary>
sealed class InstructionReference : IEquatable<InstructionReference?> {
	public MethodDef Method { get; }
	public Instruction Instruction { get; }

	public InstructionReference(MethodDef method, Instruction instruction) {
		Method = method ?? throw new ArgumentNullException(nameof(method));
		Instruction = instruction ?? throw new ArgumentNullException(nameof(instruction));
	}

	public bool Equals(InstructionReference? other) => other is not null && Method == other.Method && Instruction == other.Instruction;
	public override bool Equals(object? obj) => Equals(obj as InstructionReference);
	public override int GetHashCode() => Method.GetHashCode() ^ Instruction.GetHashCode();
}

/// <summary>dnSpy's <c>IInstructionBytesReader</c>: the bytes the IL view writes before an instruction.</summary>
interface IInstructionBytesReader {
	/// <summary>true if it's reading the original bytes, false if the method has been modified</summary>
	bool IsOriginalBytes { get; }

	/// <summary>Reads the next byte or returns a value less than 0 if the byte is unknown</summary>
	int ReadByte();

	/// <summary>Initializes the next instruction that should be read</summary>
	void SetInstruction(int index, uint offset);
}

/// <summary>dnSpy's <c>MemberRefComparer&lt;T&gt;</c>: Sort members orders by name, then by token.</summary>
abstract class MemberRefComparer<T> : IComparer<T> where T : class, IMemberRef {
	public int Compare([AllowNull] T x, [AllowNull] T y) {
		if ((object?)x == y)
			return 0;
		if (x is null)
			return -1;
		if (y is null)
			return 1;
		int c = StringComparer.OrdinalIgnoreCase.Compare(x.Name, y.Name);
		if (c != 0) return c;
		c = x.MDToken.Raw.CompareTo(y.MDToken.Raw);
		if (c != 0) return c;
		return x.GetHashCode().CompareTo(y.GetHashCode());
	}
}

sealed class TypeDefComparer : MemberRefComparer<TypeDef> {
	public static readonly TypeDefComparer Instance = new();
}

sealed class FieldDefComparer : MemberRefComparer<FieldDef> {
	public static readonly FieldDefComparer Instance = new();
}

sealed class EventDefComparer : MemberRefComparer<EventDef> {
	public static readonly EventDefComparer Instance = new();
}

sealed class PropertyDefComparer : MemberRefComparer<PropertyDef> {
	public static readonly PropertyDefComparer Instance = new();
}

sealed class MethodDefComparer : IComparer<MethodDef> {
	public static readonly MethodDefComparer Instance = new();

	public int Compare([AllowNull] MethodDef x, [AllowNull] MethodDef y) {
		if ((object?)x == y)
			return 0;
		if (x is null)
			return -1;
		if (y is null)
			return 1;
		int c = StringComparer.OrdinalIgnoreCase.Compare(x.Name, y.Name);
		if (c != 0)
			return c;
		c = x.MethodSig.GetParamCount().CompareTo(y.MethodSig.GetParamCount());
		if (c != 0) return c;
		c = x.MethodSig.GetGenParamCount().CompareTo(y.MethodSig.GetGenParamCount());
		if (c != 0) return c;
		c = x.MDToken.Raw.CompareTo(y.MDToken.Raw);
		if (c != 0) return c;
		return x.GetHashCode().CompareTo(y.GetHashCode());
	}
}

static class DecompilerExtensions {
	/// <summary>
	/// Gets the RVA and file offset of a member definition. Returns false if the RVA and
	/// file offsets aren't known or if there's no RVA (eg. there's no method body)
	/// </summary>
	public static bool GetRVA(this IMemberDef? member, out uint rva, out long fileOffset) {
		rva = 0;
		fileOffset = 0;

		if (member is MethodDef method)
			rva = (uint)method.RVA;
		else if (member is FieldDef field)
			rva = (uint)field.RVA;
		if (rva == 0)
			return false;

		var fo = member!.Module.ToFileOffset(rva);
		if (fo is null)
			return false;
		fileOffset = fo.Value;
		return true;
	}

	/// <summary>Converts an RVA to a file offset</summary>
	public static uint? ToFileOffset(this ModuleDef? module, uint rva) {
		var m = module as ModuleDefMD;
		if (m is null)
			return null;
		return (uint)m.Metadata.PEImage.ToFileOffset((dnlib.PE.RVA)rva);
	}

	/// <summary>Gets the size of the code in the method body</summary>
	public static int GetCodeSize(this CilBody? body) {
		if (body is null || body.Instructions.Count == 0)
			return 0;
		var instr = body.Instructions[body.Instructions.Count - 1];
		return (int)instr.Offset + instr.GetSize();
	}

	/// <summary>Returns true if the fields can be sorted and false if the original metadata order must be used</summary>
	public static bool CanSortFields(this TypeDef type) => type.IsAutoLayout;

	/// <summary>Returns true if the methods can be sorted and false if the original metadata order must be used</summary>
	public static bool CanSortMethods(this TypeDef type) => !(type.IsInterface && type.IsImport);
}
