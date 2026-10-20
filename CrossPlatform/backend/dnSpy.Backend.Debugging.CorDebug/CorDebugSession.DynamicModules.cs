using System.Buffers.Binary;
using System.Collections.Immutable;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Runtime.InteropServices;
using ICorDebugSharp;
using ICorDebugSharp.Extensions;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>
/// A Reflection.Emit module as a file — what dnSpy's DynamicModuleDefDocument shows of one. A dynamic module has no
/// image in the process: the runtime keeps a saved copy of its metadata for the debugger (ReflectionModule's
/// CaptureModuleMetaDataToMemory), which is the scope the module's metadata interfaces read, and every method body
/// sits in the process behind its IL, with the fat header SetMethodIL always gives it. The two are put together into a
/// PE image with one section: the CLI header, the bodies, and the metadata with each method's RVA pointing at its body.
/// </summary>
internal sealed partial class CorDebugSession {
	const int FatHeaderSize = 12;
	const uint SectionRva = 0x2000;
	const int FileAlignment = 0x200;
	const int SectionAlignment = 0x2000;
	const int HeadersSize = 0x200;

	byte[]? ReadDynamicModuleImage(ModuleTable.ModuleEntry entry) {
		var metadata = ReadSavedMetadata(entry.Module);
		if (metadata is null)
			return null;
		using var provider = MetadataReaderProvider.FromMetadataImage(ImmutableArray.Create(metadata));
		MetadataReader reader;
		try {
			reader = provider.GetMetadataReader();
		}
		catch (BadImageFormatException) {
			return null;
		}

		// The section: CLI header, then the method bodies, then the metadata — each four-byte aligned.
		var text = new List<byte>(new byte[72]);
		var methodRvas = new Dictionary<int, uint>();
		foreach (var handle in reader.MethodDefinitions) {
			var definition = reader.GetMethodDefinition(handle);
			if ((definition.ImplAttributes & System.Reflection.MethodImplAttributes.CodeTypeMask) != System.Reflection.MethodImplAttributes.IL ||
				(definition.Attributes & System.Reflection.MethodAttributes.Abstract) != 0)
				continue;
			var token = MetadataTokens.GetToken(handle);
			if (ReadDynamicMethodBody(entry.Module, token) is not { } body)
				continue;
			Align(text, 4);
			methodRvas[MetadataTokens.GetRowNumber(handle)] = SectionRva + (uint)text.Count;
			text.AddRange(body);
		}
		Align(text, 4);
		var metadataRva = SectionRva + (uint)text.Count;
		var patched = (byte[])metadata.Clone();
		PatchRvas(reader, patched, methodRvas);
		text.AddRange(patched);

		var section = text.ToArray();
		// IMAGE_COR20_HEADER: cb, runtime 2.5, the metadata directory, COMIMAGE_FLAGS_ILONLY.
		BinaryPrimitives.WriteUInt32LittleEndian(section.AsSpan(0), 72);
		BinaryPrimitives.WriteUInt16LittleEndian(section.AsSpan(4), 2);
		BinaryPrimitives.WriteUInt16LittleEndian(section.AsSpan(6), 5);
		BinaryPrimitives.WriteUInt32LittleEndian(section.AsSpan(8), metadataRva);
		BinaryPrimitives.WriteUInt32LittleEndian(section.AsSpan(12), (uint)patched.Length);
		BinaryPrimitives.WriteUInt32LittleEndian(section.AsSpan(16), 1);
		return WritePeImage(section);
	}

	/// <summary>The metadata the module's scope was opened on: IMetaDataTables2.GetMetaDataStorage, copied out.</summary>
	static byte[]? ReadSavedMetadata(ICorDebugModule module) {
		try {
			if (module.GetMetaDataInterface<IMetaDataTables2>() is not { } tables)
				return null;
			if (tables.TryGetMetaDataStorage(out var storage, out var size) < 0 || storage == IntPtr.Zero || size == 0)
				return null;
			var bytes = new byte[size];
			Marshal.Copy(storage, bytes, 0, (int)size);
			// A saved scope starts with the metadata root's signature, "BSJB".
			return BinaryPrimitives.ReadUInt32LittleEndian(bytes) == 0x424A5342 ? bytes : null;
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex) || ex is InvalidCastException) {
			return null;
		}
	}

	/// <summary>
	/// A method's body as the process holds it: the fat header in front of the IL (CorModuleDefHelper.TryCreateBodyReader),
	/// the IL, and the exception sections after it.
	/// </summary>
	byte[]? ReadDynamicMethodBody(ICorDebugModule module, int token) {
		try {
			var code = module.GetFunctionFromToken(token).ILCode;
			var address = (ulong)code.Address.Value;
			var size = (int)code.Size;
			if (address < FatHeaderSize || size <= 0)
				return null;
			var start = address - FatHeaderSize;
			var header = ReadMemoryCore(start, FatHeaderSize);
			if (header is null || header.Length < FatHeaderSize || (header[0] & 0x3) != 0x3 || BinaryPrimitives.ReadInt32LittleEndian(header.AsSpan(4)) != size)
				return null;
			var body = new List<byte>(header);
			body.AddRange(ReadMemoryCore(address, size) ?? []);
			if (body.Count != FatHeaderSize + size)
				return null;
			// CorILMethod_MoreSects: the exception sections follow the code, four-byte aligned, each saying whether another follows.
			var more = (header[0] & 0x8) != 0;
			var position = address + (ulong)size;
			while (more) {
				var padding = (int)((4 - position % 4) % 4);
				var sectionStart = position + (ulong)padding;
				var kind = ReadMemoryCore(sectionStart, 4);
				if (kind is null || kind.Length < 4)
					return null;
				var fat = (kind[0] & 0x40) != 0;
				var length = fat ? kind[1] | (kind[2] << 8) | (kind[3] << 16) : kind[1];
				var data = length >= 4 ? ReadMemoryCore(sectionStart, length) : null;
				if (data is null || data.Length != length)
					return null;
				body.AddRange(new byte[padding]);
				body.AddRange(data);
				more = (kind[0] & 0x80) != 0;
				position = sectionStart + (ulong)length;
			}
			return body.ToArray();
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return null;
		}
	}

	/// <summary>
	/// Points every MethodDef row at its body, or at nothing, and every FieldRVA row at nothing: the RVAs the saved
	/// metadata holds are offsets into the runtime's own buffers, which the image does not have.
	/// </summary>
	static void PatchRvas(MetadataReader reader, byte[] metadata, IReadOnlyDictionary<int, uint> methodRvas) {
		var methods = reader.GetTableMetadataOffset(TableIndex.MethodDef);
		var methodRowSize = reader.GetTableRowSize(TableIndex.MethodDef);
		for (var row = 1; row <= reader.GetTableRowCount(TableIndex.MethodDef); row++)
			BinaryPrimitives.WriteUInt32LittleEndian(metadata.AsSpan(methods + (row - 1) * methodRowSize), methodRvas.GetValueOrDefault(row));
		var fields = reader.GetTableMetadataOffset(TableIndex.FieldRva);
		var fieldRowSize = reader.GetTableRowSize(TableIndex.FieldRva);
		for (var row = 1; row <= reader.GetTableRowCount(TableIndex.FieldRva); row++)
			BinaryPrimitives.WriteUInt32LittleEndian(metadata.AsSpan(fields + (row - 1) * fieldRowSize), 0);
	}

	static void Align(List<byte> bytes, int alignment) {
		while (bytes.Count % alignment != 0)
			bytes.Add(0);
	}

	static int AlignUp(int value, int alignment) => (value + alignment - 1) / alignment * alignment;

	/// <summary>A PE32 image, IL only, with the one section at <see cref="SectionRva"/>.</summary>
	static byte[] WritePeImage(byte[] section) {
		var rawSize = AlignUp(section.Length, FileAlignment);
		var image = new byte[HeadersSize + rawSize];
		var span = image.AsSpan();
		// The DOS header: "MZ" and where the PE header is.
		span[0] = (byte)'M';
		span[1] = (byte)'Z';
		BinaryPrimitives.WriteInt32LittleEndian(span[0x3C..], 0x80);
		var pe = 0x80;
		span[pe] = (byte)'P';
		span[pe + 1] = (byte)'E';
		// IMAGE_FILE_HEADER: i386, one section, a PE32 optional header, an executable DLL for a 32-bit machine.
		var file = pe + 4;
		BinaryPrimitives.WriteUInt16LittleEndian(span[file..], 0x14C);
		BinaryPrimitives.WriteUInt16LittleEndian(span[(file + 2)..], 1);
		BinaryPrimitives.WriteUInt16LittleEndian(span[(file + 16)..], 0xE0);
		BinaryPrimitives.WriteUInt16LittleEndian(span[(file + 18)..], 0x2102);
		var optional = file + 20;
		BinaryPrimitives.WriteUInt16LittleEndian(span[optional..], 0x10B);
		span[optional + 2] = 8;
		BinaryPrimitives.WriteInt32LittleEndian(span[(optional + 4)..], rawSize);
		BinaryPrimitives.WriteUInt32LittleEndian(span[(optional + 20)..], SectionRva);
		BinaryPrimitives.WriteUInt32LittleEndian(span[(optional + 28)..], 0x10000000);
		BinaryPrimitives.WriteInt32LittleEndian(span[(optional + 32)..], SectionAlignment);
		BinaryPrimitives.WriteInt32LittleEndian(span[(optional + 36)..], FileAlignment);
		BinaryPrimitives.WriteUInt16LittleEndian(span[(optional + 40)..], 4);
		BinaryPrimitives.WriteUInt16LittleEndian(span[(optional + 48)..], 4);
		BinaryPrimitives.WriteInt32LittleEndian(span[(optional + 56)..], (int)SectionRva + AlignUp(section.Length, SectionAlignment));
		BinaryPrimitives.WriteInt32LittleEndian(span[(optional + 60)..], HeadersSize);
		BinaryPrimitives.WriteUInt16LittleEndian(span[(optional + 68)..], 3);
		BinaryPrimitives.WriteUInt16LittleEndian(span[(optional + 70)..], 0x8540);
		BinaryPrimitives.WriteUInt32LittleEndian(span[(optional + 72)..], 0x100000);
		BinaryPrimitives.WriteUInt32LittleEndian(span[(optional + 76)..], 0x1000);
		BinaryPrimitives.WriteUInt32LittleEndian(span[(optional + 80)..], 0x100000);
		BinaryPrimitives.WriteUInt32LittleEndian(span[(optional + 84)..], 0x1000);
		BinaryPrimitives.WriteUInt32LittleEndian(span[(optional + 92)..], 16);
		// Data directory 14: the CLI header, at the start of the section.
		var directories = optional + 96;
		BinaryPrimitives.WriteUInt32LittleEndian(span[(directories + 14 * 8)..], SectionRva);
		BinaryPrimitives.WriteUInt32LittleEndian(span[(directories + 14 * 8 + 4)..], 72);
		// The section header: .text, readable and executable code.
		var header = optional + 0xE0;
		".text"u8.CopyTo(span[header..]);
		BinaryPrimitives.WriteInt32LittleEndian(span[(header + 8)..], section.Length);
		BinaryPrimitives.WriteUInt32LittleEndian(span[(header + 12)..], SectionRva);
		BinaryPrimitives.WriteInt32LittleEndian(span[(header + 16)..], rawSize);
		BinaryPrimitives.WriteInt32LittleEndian(span[(header + 20)..], HeadersSize);
		BinaryPrimitives.WriteUInt32LittleEndian(span[(header + 36)..], 0x60000020);
		section.CopyTo(span[HeadersSize..]);
		return image;
	}
}
