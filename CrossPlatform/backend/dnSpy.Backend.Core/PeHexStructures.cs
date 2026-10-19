using System.Globalization;
using System.Text;
using dnSpy.Backend.Contracts;
using dnlib.PE;

namespace dnSpy.Backend.Core;

/// <summary>
/// The editable form of each PE structure node — a port of dnSpy's AsmEditor view models (ImageDosHeaderVM,
/// ImageFileHeaderVM, ImageOptionalHeader32VM/64VM, ImageSectionHeaderVM, ImageCor20HeaderVM, StorageSignatureVM,
/// StorageHeaderVM and StorageStreamVM). The layout — where each structure is and how long — comes from the image
/// as dnlib read it, the way dnSpy lays its view models out once from the file; the values are read out of the
/// patched file every time, so an edit shows up as soon as it is made. Field names are the ones dnSpy's hex file
/// structures give them (dnSpy.Hex.Files), the bit fields and their order the ones each view model adds.
/// </summary>
internal static class PeHexStructures {
	/// <summary>The range a structure node stands for — dnSpy's HexNode.Span — or null when the image has no such structure.</summary>
	public static (long Offset, long Length)? Span(PeStructureSource source, PeStructureKind kind, int index) {
		var image = source.Image;
		switch (kind) {
		case PeStructureKind.DosHeader:
			return (0, 0x40);
		case PeStructureKind.FileHeader:
			return (Offset(image.ImageNTHeaders.FileHeader.StartOffset), 0x14);
		case PeStructureKind.OptionalHeader:
			return (Offset(image.ImageNTHeaders.FileHeader.StartOffset) + 0x14, image.ImageNTHeaders.FileHeader.SizeOfOptionalHeader);
		case PeStructureKind.Section:
			return index >= 0 && index < image.ImageSectionHeaders.Count ? (Offset(image.ImageSectionHeaders[index].StartOffset), 0x28) : null;
		case PeStructureKind.Cor20Header:
			return source.Metadata?.ImageCor20Header is { } cor20 ? (Offset(cor20.StartOffset), 0x48) : null;
		case PeStructureKind.StorageSignature:
			return source.Metadata?.MetadataHeader is { } signature ? (Offset(signature.StartOffset), 0x10 + (long)signature.StringLength) : null;
		case PeStructureKind.StorageHeader:
			return source.Metadata?.MetadataHeader is { } header ? (Offset(header.StorageHeaderOffset), 4) : null;
		case PeStructureKind.StorageStream:
			return GetStreamHeader(source, index) is { } stream ? (Offset(stream.StartOffset), Offset(stream.EndOffset) - Offset(stream.StartOffset)) : null;
		default:
			return null;
		}
	}

	/// <summary>
	/// What dnSpy's "Show Data in Hex Editor" opens for a structure node (ShowStorageStreamDataInHexEditorCommand):
	/// a section's raw data, or the data of the stream a storage stream header describes. Null for the rest.
	/// </summary>
	public static (long Offset, long Length)? DataSpan(PeStructureSource source, PeStructureKind kind, int index) {
		switch (kind) {
		case PeStructureKind.Section when index >= 0 && index < source.Image.ImageSectionHeaders.Count:
			var section = source.Image.ImageSectionHeaders[index];
			return (section.PointerToRawData, section.SizeOfRawData);
		case PeStructureKind.StorageStream when source.Metadata?.MetadataHeader is { } header && GetStreamHeader(source, index) is { } stream:
			return (Offset(header.StartOffset) + stream.Offset, stream.StreamSize);
		default:
			return null;
		}
	}

	/// <summary>The fields of one structure node, or null when the image has no such structure.</summary>
	public static HexStructureDto? Read(string nodeId, PeStructureSource source, PeStructureKind kind, int index, PatchedFileReader reader) {
		if (Span(source, kind, index) is not { } span)
			return null;
		var fields = new HexFieldList(reader);
		string name;
		switch (kind) {
		case PeStructureKind.DosHeader:
			name = "IMAGE_DOS_HEADER";
			ReadDosHeader(fields);
			break;
		case PeStructureKind.FileHeader:
			name = "IMAGE_FILE_HEADER";
			ReadFileHeader(fields, span.Offset, reader);
			break;
		case PeStructureKind.OptionalHeader:
			var is64Bit = source.Image.ImageNTHeaders.OptionalHeader is ImageOptionalHeader64;
			name = is64Bit ? "IMAGE_OPTIONAL_HEADER64" : "IMAGE_OPTIONAL_HEADER32";
			ReadOptionalHeader(fields, span.Offset, span.Length, is64Bit);
			break;
		case PeStructureKind.Section:
			name = "IMAGE_SECTION_HEADER";
			ReadSectionHeader(fields, span.Offset);
			break;
		case PeStructureKind.Cor20Header:
			name = "IMAGE_COR20_HEADER";
			ReadCor20Header(fields, span.Offset);
			break;
		case PeStructureKind.StorageSignature:
			name = "STORAGESIGNATURE";
			ReadStorageSignature(fields, span.Offset, span.Length - 0x10);
			break;
		case PeStructureKind.StorageHeader:
			name = "STORAGEHEADER";
			ReadStorageHeader(fields, span.Offset);
			break;
		case PeStructureKind.StorageStream:
			name = "STORAGESTREAM";
			fields.Number("iOffset", span.Offset, HexText.UInt32);
			fields.Number("iSize", span.Offset + 4, HexText.UInt32);
			fields.String("rcName", span.Offset + 8, (int)span.Length - 8, Encoding.ASCII);
			break;
		default:
			return null;
		}
		return new HexStructureDto(nodeId, name, span.Offset, span.Length, fields.Fields);
	}

	static readonly string[] DosFieldNames = [
		"e_magic", "e_cblp", "e_cp", "e_crlc", "e_cparhdr", "e_minalloc", "e_maxalloc", "e_ss", "e_sp", "e_csum", "e_ip", "e_cs", "e_lfarlc", "e_ovno",
	];

	/// <summary>ImageDosHeaderVM: every word, the two reserved arrays one element at a time.</summary>
	static void ReadDosHeader(HexFieldList fields) {
		for (var i = 0; i < DosFieldNames.Length; i++)
			fields.Number(DosFieldNames[i], i * 2, HexText.UInt16);
		for (var i = 0; i < 4; i++)
			fields.Number($"e_res[{i}]", 0x1C + i * 2, HexText.UInt16);
		fields.Number("e_oemid", 0x24, HexText.UInt16);
		fields.Number("e_oeminfo", 0x26, HexText.UInt16);
		for (var i = 0; i < 10; i++)
			fields.Number($"e_res2[{i}]", 0x28 + i * 2, HexText.UInt16);
		fields.Number("e_lfanew", 0x3C, HexText.UInt32);
	}

	/// <summary>ImageFileHeaderVM.MachineInfos, in its order — "Unknown" is dnSpy's resource string for zero.</summary>
	static readonly IReadOnlyList<HexBitFieldDto> MachineBits = [
		HexText.Choice("Machine", 0, 16,
			(0x014C, "I386"), (0x8664, "AMD64"), (0x0200, "IA64"), (0x01C4, "ARMNT"), (0xAA64, "ARM64"), (0, "Unknown"),
			(0x0162, "R3000"), (0x0166, "R4000"), (0x0168, "R10000"), (0x0169, "WCEMIPSV2"), (0x0184, "ALPHA"), (0x01A2, "SH3"),
			(0x01A3, "SH3DSP"), (0x01A4, "SH3E"), (0x01A6, "SH4"), (0x01A8, "SH5"), (0x01C0, "ARM"), (0x01C2, "THUMB"),
			(0x01D3, "AM33"), (0x01F0, "POWERPC"), (0x01F1, "POWERPCFP"), (0x0266, "MIPS16"), (0x0284, "ALPHA64"),
			(0x0366, "MIPSFPU"), (0x0466, "MIPSFPU16"), (0x0520, "TRICORE"), (0x0CEF, "CEF"), (0x0EBC, "EBC"),
			(0x9041, "M32R"), (0xC0EE, "CEE")),
	];

	static readonly IReadOnlyList<HexBitFieldDto> FileCharacteristicsBits = [
		HexText.Flag("Relocs Stripped", 0),
		HexText.Flag("Executable Image", 1),
		HexText.Flag("Line Nums Stripped", 2),
		HexText.Flag("Local Syms Stripped", 3),
		HexText.Flag("Aggressive WS Trim", 4),
		HexText.Flag("Large Address Aware", 5),
		HexText.Flag("Reserved 0040h", 6),
		HexText.Flag("Bytes Reversed Lo", 7),
		HexText.Flag("32-Bit Machine", 8),
		HexText.Flag("Debug Stripped", 9),
		HexText.Flag("Removable Run From Swap", 10),
		HexText.Flag("Net Run From Swap", 11),
		HexText.Flag("System", 12),
		HexText.Flag("Dll", 13),
		HexText.Flag("Up System Only", 14),
		HexText.Flag("Bytes Reversed Hi", 15),
	];

	static void ReadFileHeader(HexFieldList fields, long start, PatchedFileReader reader) {
		fields.Number("Machine", start, HexText.UInt16, bits: MachineBits);
		fields.Number("NumberOfSections", start + 2, HexText.UInt16);
		// The read-only date dnSpy shows under the time stamp (ImageFileHeaderVM.TimeDateStampString).
		var timeDateStamp = (uint)reader.ReadUInt(start + 4, 4);
		var date = DateTime.UnixEpoch.AddSeconds(timeDateStamp).ToLocalTime().ToString(CultureInfo.CurrentCulture.DateTimeFormat);
		fields.Number("TimeDateStamp", start + 4, HexText.UInt32, note: date);
		fields.Number("PointerToSymbolTable", start + 8, HexText.UInt32);
		fields.Number("NumberOfSymbols", start + 0x0C, HexText.UInt32);
		fields.Number("SizeOfOptionalHeader", start + 0x10, HexText.UInt16);
		fields.Number("Characteristics", start + 0x12, HexText.UInt16, bits: FileCharacteristicsBits, group: "Characteristics");
	}

	static readonly IReadOnlyList<HexBitFieldDto> MagicBits = [
		HexText.Choice("Magic", 0, 16, (0x10B, "PE32"), (0x107, "ROM image"), (0x20B, "PE32+")),
	];

	static readonly IReadOnlyList<HexBitFieldDto> SubsystemBits = [
		HexText.Choice("Subsystem", 0, 16,
			(0, "Unknown"), (1, "Native"), (2, "WindowsGui"), (3, "WindowsCui"), (5, "Os2Cui"), (7, "PosixCui"), (8, "NativeWindows"),
			(9, "WindowsCeGui"), (10, "EfiApplication"), (11, "EfiBootServiceDriver"), (12, "EfiRuntimeDriver"), (13, "EfiRom"),
			(14, "Xbox"), (16, "WindowsBootApplication"), (17, "XboxCodeCatalog")),
	];

	static readonly IReadOnlyList<HexBitFieldDto> DllCharacteristicsBits = [
		HexText.Flag("Reserved1", 0),
		HexText.Flag("Reserved2", 1),
		HexText.Flag("Reserved3", 2),
		HexText.Flag("Reserved4", 3),
		HexText.Flag("Reserved5", 4),
		HexText.Flag("High Entropy VA", 5),
		HexText.Flag("Dynamic Base", 6),
		HexText.Flag("Force Integrity", 7),
		HexText.Flag("NX Compat", 8),
		HexText.Flag("No Isolation", 9),
		HexText.Flag("No SEH", 10),
		HexText.Flag("No Bind", 11),
		HexText.Flag("AppContainer", 12),
		HexText.Flag("WDM Driver", 13),
		HexText.Flag("Guard CF", 14),
		HexText.Flag("Terminal Server Aware", 15),
	];

	/// <summary>The names ImageOptionalHeaderVM gives the sixteen data directories.</summary>
	static readonly string[] DataDirectoryNames = [
		"Export", "Import", "Resource", "Exception", "Security", "Base Reloc", "Debug", "Architecture",
		"Global Ptr", "TLS", "Load Config", "Bound Import", "IAT", "Delay Import", ".NET", "Reserved15",
	];

	/// <summary>
	/// ImageOptionalHeader32VM and ImageOptionalHeader64VM. The data directories are the ones the optional header's
	/// size leaves room for, at most sixteen (PeOptionalHeader32DataImpl.CreateDataDirectoryArray), each written as
	/// two fields named after the directory (DataDirectoryVM).
	/// </summary>
	static void ReadOptionalHeader(HexFieldList fields, long start, long size, bool is64Bit) {
		var wide = is64Bit ? HexText.UInt64 : HexText.UInt32;
		fields.Number("Magic", start, HexText.UInt16, bits: MagicBits);
		fields.Number("MajorLinkerVersion", start + 2, HexText.Byte, useDecimal: true);
		fields.Number("MinorLinkerVersion", start + 3, HexText.Byte, useDecimal: true);
		fields.Number("SizeOfCode", start + 4, HexText.UInt32);
		fields.Number("SizeOfInitializedData", start + 8, HexText.UInt32);
		fields.Number("SizeOfUninitializedData", start + 0x0C, HexText.UInt32);
		fields.Number("AddressOfEntryPoint", start + 0x10, HexText.UInt32);
		fields.Number("BaseOfCode", start + 0x14, HexText.UInt32);
		if (is64Bit) {
			fields.Number("ImageBase", start + 0x18, HexText.UInt64);
		}
		else {
			fields.Number("BaseOfData", start + 0x18, HexText.UInt32);
			fields.Number("ImageBase", start + 0x1C, HexText.UInt32);
		}
		fields.Number("SectionAlignment", start + 0x20, HexText.UInt32);
		fields.Number("FileAlignment", start + 0x24, HexText.UInt32);
		fields.Number("MajorOperatingSystemVersion", start + 0x28, HexText.UInt16, useDecimal: true);
		fields.Number("MinorOperatingSystemVersion", start + 0x2A, HexText.UInt16, useDecimal: true);
		fields.Number("MajorImageVersion", start + 0x2C, HexText.UInt16, useDecimal: true);
		fields.Number("MinorImageVersion", start + 0x2E, HexText.UInt16, useDecimal: true);
		fields.Number("MajorSubsystemVersion", start + 0x30, HexText.UInt16, useDecimal: true);
		fields.Number("MinorSubsystemVersion", start + 0x32, HexText.UInt16, useDecimal: true);
		fields.Number("Win32VersionValue", start + 0x34, HexText.UInt32, useDecimal: true);
		fields.Number("SizeOfImage", start + 0x38, HexText.UInt32);
		fields.Number("SizeOfHeaders", start + 0x3C, HexText.UInt32);
		fields.Number("CheckSum", start + 0x40, HexText.UInt32);
		fields.Number("Subsystem", start + 0x44, HexText.UInt16, bits: SubsystemBits);
		fields.Number("DllCharacteristics", start + 0x46, HexText.UInt16, bits: DllCharacteristicsBits, group: "DllCharacteristics");
		var step = HexText.SizeOf(wide);
		var position = start + 0x48;
		foreach (var name in new[] { "SizeOfStackReserve", "SizeOfStackCommit", "SizeOfHeapReserve", "SizeOfHeapCommit" }) {
			fields.Number(name, position, wide);
			position += step;
		}
		fields.Number("LoaderFlags", position, HexText.UInt32);
		fields.Number("NumberOfRvaAndSizes", position + 4, HexText.UInt32);
		var directories = position + 8;
		var count = (int)Math.Min(Math.Max(0, start + size - directories) / 8, 16);
		for (var i = 0; i < count; i++)
			DataDirectory(fields, DataDirectoryNames[i], directories + i * 8);
	}

	static void DataDirectory(HexFieldList fields, string name, long offset) {
		fields.Number(name + ".VirtualAddress", offset, HexText.UInt32, group: name);
		fields.Number(name + ".Size", offset + 4, HexText.UInt32, group: name);
	}

	/// <summary>ImageSectionHeaderVM's characteristics: a check box per bit but for the alignment, one combo over four bits.</summary>
	static readonly IReadOnlyList<HexBitFieldDto> SectionCharacteristicsBits = [
		HexText.Flag("TYPE_DSECT", 0),
		HexText.Flag("TYPE_NOLOAD", 1),
		HexText.Flag("TYPE_GROUP", 2),
		HexText.Flag("TYPE_NO_PAD", 3),
		HexText.Flag("TYPE_COPY", 4),
		HexText.Flag("CNT_CODE", 5),
		HexText.Flag("CNT_INITIALIZED_DATA", 6),
		HexText.Flag("CNT_UNINITIALIZED_DATA", 7),
		HexText.Flag("LNK_OTHER", 8),
		HexText.Flag("LNK_INFO", 9),
		HexText.Flag("TYPE_OVER", 10),
		HexText.Flag("LNK_REMOVE", 11),
		HexText.Flag("LNK_COMDAT", 12),
		HexText.Flag("RESERVED", 13),
		HexText.Flag("NO_DEFER_SPEC_EXC", 14),
		HexText.Flag("GPREL", 15),
		HexText.Flag("MEM_SYSHEAP", 16),
		HexText.Flag("MEM_PURGEABLE", 17),
		HexText.Flag("MEM_LOCKED", 18),
		HexText.Flag("MEM_PRELOAD", 19),
		HexText.Choice("Alignment", 20, 4,
			(0, "Default"), (1, "1 Byte"), (2, "2 Bytes"), (3, "4 Bytes"), (4, "8 Bytes"), (5, "16 Bytes"), (6, "32 Bytes"), (7, "64 Bytes"),
			(8, "128 Bytes"), (9, "256 Bytes"), (10, "512 Bytes"), (11, "1024 Bytes"), (12, "2048 Bytes"), (13, "4096 Bytes"),
			(14, "8192 Bytes"), (15, "Reserved")),
		HexText.Flag("LNK_NRELOC_OVFL", 24),
		HexText.Flag("MEM_DISCARDABLE", 25),
		HexText.Flag("MEM_NOT_CACHED", 26),
		HexText.Flag("MEM_NOT_PAGED", 27),
		HexText.Flag("MEM_SHARED", 28),
		HexText.Flag("MEM_EXECUTE", 29),
		HexText.Flag("MEM_READ", 30),
		HexText.Flag("MEM_WRITE", 31),
	];

	static void ReadSectionHeader(HexFieldList fields, long start) {
		fields.String("Name", start, 8, Encoding.ASCII);
		fields.Number("VirtualSize", start + 8, HexText.UInt32);
		fields.Number("VirtualAddress", start + 0x0C, HexText.UInt32);
		fields.Number("SizeOfRawData", start + 0x10, HexText.UInt32);
		fields.Number("PointerToRawData", start + 0x14, HexText.UInt32);
		fields.Number("PointerToRelocations", start + 0x18, HexText.UInt32);
		fields.Number("PointerToLinenumbers", start + 0x1C, HexText.UInt32);
		fields.Number("NumberOfRelocations", start + 0x20, HexText.UInt16);
		fields.Number("NumberOfLinenumbers", start + 0x22, HexText.UInt16);
		fields.Number("Characteristics", start + 0x24, HexText.UInt32, bits: SectionCharacteristicsBits, group: "Characteristics");
	}

	/// <summary>ImageCor20HeaderVM's flags, named by dnSpy's resource strings.</summary>
	static readonly IReadOnlyList<HexBitFieldDto> Cor20FlagsBits = [
		HexText.Flag("IL Only", 0),
		HexText.Flag("32-Bit Required", 1),
		HexText.Flag("IL Library", 2),
		HexText.Flag("Strong Name Signed", 3),
		HexText.Flag("Native EntryPoint", 4),
		HexText.Flag("Track Debug Data", 16),
		HexText.Flag("32-Bit Preferred", 17),
	];

	static void ReadCor20Header(HexFieldList fields, long start) {
		fields.Number("cb", start, HexText.UInt32);
		fields.Number("MajorRuntimeVersion", start + 4, HexText.UInt16, useDecimal: true);
		fields.Number("MinorRuntimeVersion", start + 6, HexText.UInt16, useDecimal: true);
		DataDirectory(fields, "MetaData", start + 8);
		fields.Number("Flags", start + 0x10, HexText.UInt32, bits: Cor20FlagsBits, group: "Flags");
		fields.Number("EntryPointTokenOrRVA", start + 0x14, HexText.UInt32);
		DataDirectory(fields, "Resources", start + 0x18);
		DataDirectory(fields, "StrongNameSignature", start + 0x20);
		DataDirectory(fields, "CodeManagerTable", start + 0x28);
		DataDirectory(fields, "VTableFixups", start + 0x30);
		DataDirectory(fields, "ExportAddressTableJumps", start + 0x38);
		DataDirectory(fields, "ManagedNativeHeader", start + 0x40);
	}

	static void ReadStorageSignature(HexFieldList fields, long start, long versionLength) {
		fields.Number("lSignature", start, HexText.UInt32);
		fields.Number("iMajorVer", start + 4, HexText.UInt16, useDecimal: true);
		fields.Number("iMinorVer", start + 6, HexText.UInt16, useDecimal: true);
		fields.Number("iExtraData", start + 8, HexText.UInt32);
		fields.Number("iVersionString", start + 0x0C, HexText.UInt32);
		fields.String("VersionString", start + 0x10, (int)versionLength, Encoding.UTF8);
	}

	/// <summary>StorageHeaderVM: its one flag is named after the signature's iExtraData field, which it governs.</summary>
	static readonly IReadOnlyList<HexBitFieldDto> StorageFlagsBits = [HexText.Flag("iExtraData", 0)];

	static void ReadStorageHeader(HexFieldList fields, long start) {
		fields.Number("fFlags", start, HexText.Byte, bits: StorageFlagsBits, group: "Flags");
		fields.Number("pad", start + 1, HexText.Byte);
		fields.Number("iStreams", start + 2, HexText.UInt16);
	}

	/// <summary>The header of a metadata stream, by the stream's index among all of the metadata's streams — which is
	/// the order of the headers, and the index a storage stream node carries.</summary>
	static dnlib.DotNet.MD.StreamHeader? GetStreamHeader(PeStructureSource source, int index) =>
		source.Metadata is { } metadata && index >= 0 && index < metadata.AllStreams.Count ? metadata.AllStreams[index].StreamHeader : null;

	internal static long Offset(dnlib.IO.FileOffset offset) => (long)(uint)offset;
}
