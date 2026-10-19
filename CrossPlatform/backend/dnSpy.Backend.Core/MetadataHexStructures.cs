using System.Globalization;
using System.Numerics;
using System.Text;
using dnSpy.Backend.Contracts;
using dnlib.DotNet;
using dnlib.DotNet.MD;

namespace dnSpy.Backend.Core;

/// <summary>
/// The tables stream of a module the way dnSpy's AsmEditor shows it: the stream's header (TablesStreamVM), each
/// table (MetadataTableVM, MetadataTableNode) and each row (MetadataTableRecordVM, MetadataTableRecordNode). The
/// layout — where the header, every table and every row is, how wide each column — is dnlib's, read once with
/// the module, which is how dnSpy lays its view models out; every value, every name a row's label or Info column
/// shows and every description beside a column is read out of the patched file, so a byte patch over a row or
/// over the #Strings heap shows up wherever the row does.
/// </summary>
internal sealed class MetadataTablesReader(Metadata metadata, PatchedFileReader reader) {
	public Metadata Metadata { get; } = metadata;

	public PatchedFileReader Reader { get; } = reader;

	TablesStream Tables => Metadata.TablesStream;

	public static long Offset(dnlib.IO.FileOffset offset) => (long)(uint)offset;

	/// <summary>The file offset of a row; <paramref name="rid"/> counts from one.</summary>
	public static long RowOffset(MDTable table, uint rid) => Offset(table.StartOffset) + (long)(rid - 1) * table.RowSize;

	/// <summary>The range the stream's header covers — dnSpy's TablesHeap.HeaderSpan: the fixed part, a row count for
	/// every table the valid mask names, and the extra data word when the header's flags say there is one.</summary>
	public static (long Offset, long Length) HeaderSpan(TablesStream tables) =>
		(Offset(tables.StartOffset), 0x18 + 4L * BitOperations.PopCount(tables.ValidMask) + (tables.HasExtraData ? 4 : 0));

	/// <summary>dnSpy's name for a table, "02 TypeDef" — MetadataTableVM.Name.</summary>
	public static string TableName(Table table) => $"{(byte)table:X2} {table}";

	/// <summary>What a table node is labelled: its name and its row count, "02 TypeDef (5)".</summary>
	public static string TableLabel(MDTable table) => $"{TableName(table.Table)} ({table.Rows.ToString(CultureInfo.InvariantCulture)})";

	/// <summary>The name a row's view model has, "TypeDef[000002]" — MetadataTableRecordVM.Name.</summary>
	public static string RecordName(Table table, uint rid) => $"{table}[{rid:X6}]";

	public static uint Token(Table table, uint rid) => ((uint)table << 24) | rid;

	public uint ReadColumn(MDTable table, uint rid, ColumnInfo column) =>
		(uint)Reader.ReadUInt(RowOffset(table, rid) + column.Offset, column.Size);

	/// <summary>
	/// MetadataTableVM.ReadStringsHeap: the UTF-8 string at an offset of the #Strings heap, read up to its NUL or the
	/// end of the heap and cut at 0x200 bytes with "..." after it. Offset 0 is the empty string.
	/// </summary>
	public string ReadStringsHeap(uint offset, uint maxLength = 0x200) {
		if (offset == 0 || Metadata.StringsStream is not { } heap)
			return string.Empty;
		var end = Offset(heap.StartOffset) + heap.StreamLength;
		var position = Offset(heap.StartOffset) + offset;
		var bytes = new List<byte>();
		var tooLong = false;
		while (position < end) {
			var b = Reader.TryReadByte(position);
			if (b <= 0)
				break;
			if (bytes.Count >= maxLength) {
				tooLong = true;
				break;
			}
			bytes.Add((byte)b);
			position++;
		}
		var text = Encoding.UTF8.GetString(bytes.ToArray());
		return tooLong ? text + "..." : text;
	}

	/// <summary>A name out of the #Strings heap the way the metadata views write it, escaped but not quoted.</summary>
	public string Name(uint offset) => HexText.Escape(ReadStringsHeap(offset));

	/// <summary>MetadataTableVM.ReadGuidHeap: the GUID at a one-based index of the #GUID heap, or null.</summary>
	public Guid? ReadGuidHeap(uint index) {
		if (index == 0 || Metadata.GuidStream is not { } heap)
			return null;
		var start = Offset(heap.StartOffset) + (index - 1L) * 16;
		if (start + 16 > Offset(heap.StartOffset) + heap.StreamLength)
			return null;
		return new Guid(Reader.ReadBytes(start, 16));
	}

	/// <summary>
	/// The columns the label of a row and the Info column of its table are made of
	/// (MetadataTableRecordNode.GetInfoTuple, the record view models' InfoColumnIndexes); null for a table whose rows
	/// have neither.
	/// </summary>
	static int[]? InfoColumns(Table table) => table switch {
		Table.Module => [1],
		Table.TypeRef or Table.TypeDef => [1, 2],
		Table.Field => [1],
		Table.Method => [3],
		Table.Param => [2],
		Table.MemberRef => [1],
		Table.Event => [1],
		Table.Property => [1],
		Table.ModuleRef => [0],
		Table.ImplMap => [2],
		Table.Assembly => [7],
		Table.AssemblyRef => [6],
		Table.File => [1],
		Table.ExportedType => [2, 3],
		Table.ManifestResource => [2],
		Table.GenericParam => [3],
		_ => null,
	};

	/// <summary>Whether a table's grid has an Info column — MetadataTableVM.HasInfo.</summary>
	public static bool HasInfo(Table table) => InfoColumns(table) is not null;

	string ColumnName(MDTable table, uint rid, int column) =>
		column < table.Columns.Count ? Name(ReadColumn(table, rid, table.Columns[column])) : string.Empty;

	/// <summary>
	/// The Info column of a row (MetadataTableRecordVM.Info): the name it defines, a type's namespace and name joined
	/// with a dot. Empty for a table that has no such column.
	/// </summary>
	public string Info(MDTable table, uint rid) => table.Table switch {
		Table.TypeRef or Table.TypeDef => TypeString(ColumnName(table, rid, 2), ColumnName(table, rid, 1)),
		Table.ExportedType => TypeString(ColumnName(table, rid, 3), ColumnName(table, rid, 2)),
		_ => InfoColumns(table.Table) is [var column] ? ColumnName(table, rid, column) : string.Empty,
	};

	/// <summary>
	/// What a row node writes after its RID (MetadataTableRecordNode.WriteCore): the same name as the Info column, but
	/// a type written as its name, then " - " and its namespace. Null for a row that has no such text.
	/// </summary>
	public string? LabelInfo(MDTable table, uint rid) => table.Table switch {
		Table.TypeRef or Table.TypeDef => NameAndNamespace(ColumnName(table, rid, 2), ColumnName(table, rid, 1)),
		Table.ExportedType => NameAndNamespace(ColumnName(table, rid, 3), ColumnName(table, rid, 2)),
		_ => InfoColumns(table.Table) is [var column] ? ColumnName(table, rid, column) : null,
	};

	/// <summary>A row node's label: "2" or "2 - Library - SearchTarget".</summary>
	public string RecordLabel(MDTable table, uint rid) {
		var rowText = rid.ToString(CultureInfo.InvariantCulture);
		return LabelInfo(table, rid) is { } info ? $"{rowText} - {info}" : rowText;
	}

	static string TypeString(string ns, string name) => string.IsNullOrEmpty(ns) ? name : $"{ns}.{name}";

	static string NameAndNamespace(string ns, string name) => string.IsNullOrEmpty(ns) ? name : $"{name} - {ns}";

	/// <summary>The Info of another table's row, empty when the table has no such row (GetMetadataTableRecordVM).</summary>
	string InfoOf(Table table, uint rid) =>
		rid != 0 && Tables.Get(table) is { Rows: > 0 } target && rid <= target.Rows ? Info(target, rid) : string.Empty;

	/// <summary>
	/// The read-only text dnSpy shows beside a column of a row (MetadataTableRecordVM.GetFieldDescription): what a
	/// RID, a coded token, a #Strings offset or a #GUID index refers to, or the column's type.
	/// </summary>
	public string Description(MDTable table, uint rid, ColumnInfo column) {
		var size = column.ColumnSize;
		if (RidTable(size) is { } target)
			return Describe(target, ReadValue(table, rid, column));
		switch (size) {
		case ColumnSize.Byte: return "Byte";
		case ColumnSize.Int16: return "Int16";
		case ColumnSize.UInt16: return "UInt16";
		case ColumnSize.Int32: return "Int32";
		case ColumnSize.UInt32: return "UInt32";
		case ColumnSize.Strings:
			var text = Name(ReadValue(table, rid, column));
			return string.IsNullOrEmpty(text) ? "#Strings Heap Offset" : $"{text} (#Strings Heap Offset)";
		case ColumnSize.GUID:
			return ReadGuidHeap(ReadValue(table, rid, column)) is { } guid ? $"{guid} (#GUID Heap Index)" : "#GUID Heap Index";
		case ColumnSize.Blob:
			return "#Blob Heap Offset";
		}
		if (CodedTokenOf(size) is not { } codedToken)
			return string.Empty;
		var name = size.ToString();
		if (!codedToken.Decode(ReadValue(table, rid, column), out MDToken token))
			return $"Invalid {name} Coded Token";
		var info = InfoOf(token.Table, token.Rid);
		var reference = $"{name}: {token.Table}[{token.Rid.ToString(CultureInfo.InvariantCulture)}], 0x{token.Raw:X8}";
		return string.IsNullOrEmpty(info) ? reference : $"{info} ({reference})";
	}

	string Describe(Table target, uint rid) {
		var info = InfoOf(target, rid);
		return string.IsNullOrEmpty(info) ? $"{target} RID" : $"{info} ({target} RID)";
	}

	/// <summary>A column's value as the descriptions read it: two or four bytes, and nothing for a byte column.</summary>
	uint ReadValue(MDTable table, uint rid, ColumnInfo column) =>
		column.Size is 2 or 4 ? ReadColumn(table, rid, column) : 0;

	static readonly Dictionary<ColumnSize, Table> RidTables = Enum.GetValues<Table>()
		.Where(table => Enum.TryParse<ColumnSize>(table.ToString(), out _))
		.ToDictionary(table => Enum.Parse<ColumnSize>(table.ToString()), table => table);

	/// <summary>The table a RID column points into; dnlib names those column sizes after their tables.</summary>
	static Table? RidTable(ColumnSize size) => RidTables.TryGetValue(size, out var table) ? table : null;

	static CodedToken? CodedTokenOf(ColumnSize size) => size switch {
		ColumnSize.TypeDefOrRef => CodedToken.TypeDefOrRef,
		ColumnSize.HasConstant => CodedToken.HasConstant,
		ColumnSize.HasCustomAttribute => CodedToken.HasCustomAttribute,
		ColumnSize.HasFieldMarshal => CodedToken.HasFieldMarshal,
		ColumnSize.HasDeclSecurity => CodedToken.HasDeclSecurity,
		ColumnSize.MemberRefParent => CodedToken.MemberRefParent,
		ColumnSize.HasSemantic => CodedToken.HasSemantic,
		ColumnSize.MethodDefOrRef => CodedToken.MethodDefOrRef,
		ColumnSize.MemberForwarded => CodedToken.MemberForwarded,
		ColumnSize.Implementation => CodedToken.Implementation,
		ColumnSize.CustomAttributeType => CodedToken.CustomAttributeType,
		ColumnSize.ResolutionScope => CodedToken.ResolutionScope,
		ColumnSize.TypeOrMethodDef => CodedToken.TypeOrMethodDef,
		ColumnSize.HasCustomDebugInformation => CodedToken.HasCustomDebugInformation,
		_ => null,
	};

	/// <summary>
	/// The fields of one row, a field per column named after it. Most columns are plain numbers of the column's
	/// width; the record view models turn the flag columns into bit fields and show version numbers in decimal, and
	/// those are the columns <see cref="Special"/> lists. With <paramref name="withNotes"/> every field carries the
	/// description dnSpy shows beside it.
	/// </summary>
	public IReadOnlyList<HexFieldDto> RecordFields(MDTable table, uint rid, bool withNotes = true) {
		var fields = new HexFieldList(Reader);
		var start = RowOffset(table, rid);
		foreach (var column in table.Columns) {
			var note = withNotes ? Description(table, rid, column) : null;
			var offset = start + column.Offset;
			if (Special(table.Table, column.Index) is { } special)
				fields.Number(column.Name, offset, special.Kind, special.UseDecimal, special.Bits, special.Group, note);
			else
				fields.Number(column.Name, offset, DefaultKind(column), note: note);
		}
		return fields.Fields;
	}

	/// <summary>MetadataTableRecordVM.CreateField: a signed column is read signed, any other by its width.</summary>
	static string DefaultKind(ColumnInfo column) => column.ColumnSize switch {
		ColumnSize.Int16 => HexText.Int16,
		ColumnSize.Int32 => HexText.Int32,
		_ => column.Size switch {
			1 => HexText.Byte,
			2 => HexText.UInt16,
			_ => HexText.UInt32,
		},
	};

	sealed record ColumnSpec(string Kind, bool UseDecimal = false, IReadOnlyList<HexBitFieldDto>? Bits = null, string? Group = null);

	/// <summary>The columns a record view model creates its own field for, with the bit fields it adds and the box
	/// its form lays them out in.</summary>
	static ColumnSpec? Special(Table table, int column) => (table, column) switch {
		(Table.TypeDef or Table.ExportedType, 0) => new(HexText.UInt32, Bits: TypeAttributesBits, Group: "Flags"),
		(Table.Field, 0) => new(HexText.UInt16, Bits: FieldAttributesBits, Group: "Flags"),
		(Table.Method, 1) => new(HexText.UInt16, Bits: MethodImplAttributesBits, Group: "ImplFlags"),
		(Table.Method, 2) => new(HexText.UInt16, Bits: MethodAttributesBits, Group: "Flags"),
		(Table.Param, 0) => new(HexText.UInt16, Bits: ParamAttributesBits, Group: "Flags"),
		(Table.DeclSecurity, 0) => new(HexText.UInt16, Bits: SecurityActionBits),
		(Table.Event, 0) => new(HexText.UInt16, Bits: EventAttributesBits, Group: "Flags"),
		(Table.Property, 0) => new(HexText.UInt16, Bits: PropertyAttributesBits, Group: "Flags"),
		(Table.MethodSemantics, 0) => new(HexText.UInt16, Bits: MethodSemanticsBits, Group: "Flags"),
		(Table.ImplMap, 0) => new(HexText.UInt16, Bits: PInvokeAttributesBits, Group: "Flags"),
		(Table.Assembly, 0) => new(HexText.UInt32, Bits: HashAlgorithmBits),
		(Table.Assembly, >= 1 and <= 4) => new(HexText.UInt16, UseDecimal: true),
		(Table.Assembly, 5) => new(HexText.UInt32, Bits: AssemblyAttributesBits, Group: "Flags"),
		(Table.AssemblyOS or Table.AssemblyRefOS, >= 1 and <= 2) => new(HexText.UInt32, UseDecimal: true),
		(Table.AssemblyRef, >= 0 and <= 3) => new(HexText.UInt16, UseDecimal: true),
		(Table.AssemblyRef, 4) => new(HexText.UInt32, Bits: AssemblyAttributesBits, Group: "Flags"),
		(Table.File, 0) => new(HexText.UInt32, Bits: FileAttributesBits, Group: "Flags"),
		(Table.ManifestResource, 1) => new(HexText.UInt32, Bits: ManifestResourceAttributesBits),
		(Table.GenericParam, 1) => new(HexText.UInt16, Bits: GenericParamAttributesBits, Group: "Constraints"),
		_ => null,
	};

	static readonly (ulong, string)[] AccessValues = [
		(0, "PrivateScope"), (1, "Private"), (2, "Family and Assembly"), (3, "Assembly"), (4, "Family"), (5, "Family or Assembly"), (6, "Public"),
	];

	static readonly IReadOnlyList<HexBitFieldDto> TypeAttributesBits = [
		HexText.Choice("Visibility", 0, 3,
			(0, "NotPublic"), (1, "Public"), (2, "Nested Public"), (3, "Nested Private"), (4, "Nested Family"), (5, "Nested Assembly"),
			(6, "Nested Family and Assembly"), (7, "Nested Family or Assembly")),
		HexText.Choice("Layout", 3, 2, (0, "Auto"), (1, "Sequential"), (2, "Explicit"), (3, "Extended")),
		HexText.Choice("Semantics", 5, 1, (0, "Class"), (1, "Interface")),
		HexText.Flag("Abstract", 7),
		HexText.Flag("Sealed", 8),
		HexText.Flag("SpecialName", 10),
		HexText.Flag("RTSpecialName", 11),
		HexText.Flag("Import", 12),
		HexText.Flag("Serializable", 13),
		HexText.Flag("WindowsRuntime", 14),
		HexText.Choice("String", 16, 2, (0, "Ansi"), (1, "Unicode"), (2, "Auto"), (3, "CustomFormat")),
		HexText.Flag("HasSecurity", 18),
		HexText.Flag("BeforeFieldInit", 20),
		HexText.Flag("Forwarder", 21),
		HexText.Choice("Custom", 22, 2, (0, "Value0"), (1, "Value1"), (2, "Value2"), (3, "Value3")),
	];

	static readonly IReadOnlyList<HexBitFieldDto> FieldAttributesBits = [
		HexText.Choice("Access", 0, 3, AccessValues),
		HexText.Flag("Static", 4),
		HexText.Flag("InitOnly", 5),
		HexText.Flag("Literal", 6),
		HexText.Flag("NotSerialized", 7),
		HexText.Flag("HasFieldRVA", 8),
		HexText.Flag("SpecialName", 9),
		HexText.Flag("RTSpecialName", 10),
		HexText.Flag("HasFieldMarshal", 12),
		HexText.Flag("PinvokeImpl", 13),
		HexText.Flag("HasDefault", 15),
	];

	static readonly IReadOnlyList<HexBitFieldDto> MethodImplAttributesBits = [
		HexText.Choice("CodeType", 0, 2, (0, "IL"), (1, "Native"), (2, "OPTIL"), (3, "Runtime")),
		HexText.Choice("ManagedType", 2, 1, (0, "Managed"), (1, "Unmanaged")),
		HexText.Flag("NoInlining", 3),
		HexText.Flag("ForwardRef", 4),
		HexText.Flag("Synchronized", 5),
		HexText.Flag("NoOptimization", 6),
		HexText.Flag("PreserveSig", 7),
		HexText.Flag("AggressiveInlining", 8),
		HexText.Flag("AggressiveOptimization", 9),
		HexText.Flag("SecurityMitigations", 10),
		HexText.Flag("InternalCall", 12),
		HexText.Flag("Async", 13),
	];

	static readonly IReadOnlyList<HexBitFieldDto> MethodAttributesBits = [
		HexText.Choice("Access", 0, 3, AccessValues),
		HexText.Flag("UnmanagedExport", 3),
		HexText.Flag("Static", 4),
		HexText.Flag("Final", 5),
		HexText.Flag("Virtual", 6),
		HexText.Flag("HideBySig", 7),
		HexText.Choice("VtableLayout", 8, 1, (0, "ReuseSlot"), (1, "NewSlot")),
		HexText.Flag("CheckAccessOnOverride", 9),
		HexText.Flag("Abstract", 10),
		HexText.Flag("SpecialName", 11),
		HexText.Flag("RTSpecialName", 12),
		HexText.Flag("PinvokeImpl", 13),
		HexText.Flag("HasSecurity", 14),
		HexText.Flag("RequireSecObject", 15),
	];

	static readonly IReadOnlyList<HexBitFieldDto> ParamAttributesBits = [
		HexText.Flag("In", 0),
		HexText.Flag("Out", 1),
		HexText.Flag("Lcid", 2),
		HexText.Flag("Retval", 3),
		HexText.Flag("Optional", 4),
		HexText.Flag("HasDefault", 12),
		HexText.Flag("HasFieldMarshal", 13),
	];

	static readonly IReadOnlyList<HexBitFieldDto> SecurityActionBits = [
		HexText.Choice("Action", 0, 16,
			(0x0000, "ActionNil"), (0x0001, "Request"), (0x0002, "Demand"), (0x0003, "Assert"), (0x0004, "Deny"), (0x0005, "PermitOnly"),
			(0x0006, "LinktimeCheck"), (0x0007, "InheritanceCheck"), (0x0008, "RequestMinimum"), (0x0009, "RequestOptional"),
			(0x000A, "RequestRefuse"), (0x000B, "PrejitGrant"), (0x000C, "PrejitDenied"), (0x000D, "NonCasDemand"),
			(0x000E, "NonCasLinkDemand"), (0x000F, "NonCasInheritance")),
	];

	static readonly IReadOnlyList<HexBitFieldDto> EventAttributesBits = [
		HexText.Flag("SpecialName", 9),
		HexText.Flag("RTSpecialName", 10),
	];

	static readonly IReadOnlyList<HexBitFieldDto> PropertyAttributesBits = [
		HexText.Flag("SpecialName", 9),
		HexText.Flag("RTSpecialName", 10),
		HexText.Flag("HasDefault", 12),
	];

	static readonly IReadOnlyList<HexBitFieldDto> MethodSemanticsBits = [
		HexText.Flag("Setter", 0),
		HexText.Flag("Getter", 1),
		HexText.Flag("Other", 2),
		HexText.Flag("AddOn", 3),
		HexText.Flag("RemoveOn", 4),
		HexText.Flag("Fire", 5),
	];

	static readonly IReadOnlyList<HexBitFieldDto> PInvokeAttributesBits = [
		HexText.Flag("NoMangle", 0),
		HexText.Choice("CharSet", 1, 2, (0, "NotSpec"), (1, "Ansi"), (2, "Unicode"), (3, "Auto")),
		HexText.Choice("BestFit", 4, 2, (0, "UseAssem"), (1, "Enabled"), (2, "Disabled")),
		HexText.Flag("SupportsLastError", 6),
		HexText.Choice("CallConv", 8, 3, (1, "Winapi"), (2, "Cdecl"), (3, "Stdcall"), (4, "Thiscall"), (5, "Fastcall")),
		HexText.Choice("ThrowOnUnmappableChar", 12, 2, (0, "UseAssem"), (1, "Enabled"), (2, "Disabled")),
	];

	static readonly IReadOnlyList<HexBitFieldDto> HashAlgorithmBits = [
		HexText.Choice("Hash Algorithm", 0, 32,
			(0, "None"), (0x8001, "MD2"), (0x8002, "MD4"), (0x8003, "MD5"), (0x8004, "SHA1"), (0x8005, "MAC"), (0x8008, "SSL3_SHAMD5"),
			(0x8009, "HMAC"), (0x800A, "TLS1PRF"), (0x800B, "HASH_REPLACE_OWF"), (0x800C, "SHA_256"), (0x800D, "SHA_384"), (0x800E, "SHA_512")),
	];

	static readonly IReadOnlyList<HexBitFieldDto> AssemblyAttributesBits = [
		HexText.Flag("PublicKey", 0),
		HexText.Choice("Processor Arch", 4, 3, (0, "None"), (1, "MSIL"), (2, "x86"), (3, "IA64"), (4, "AMD64"), (5, "ARM"), (7, "NoPlatform")),
		HexText.Flag("Processor Arch Specified", 7),
		HexText.Flag("Retargetable", 8),
		HexText.Choice("ContentType", 9, 3, (0, "Default"), (1, "WindowsRuntime")),
		HexText.Flag("DisableJITcompileOptimizer", 14),
		HexText.Flag("EnableJITcompileTracking", 15),
	];

	static readonly IReadOnlyList<HexBitFieldDto> FileAttributesBits = [HexText.Flag("ContainsNoMetaData", 0)];

	static readonly IReadOnlyList<HexBitFieldDto> ManifestResourceAttributesBits = [
		HexText.Choice("Visibility", 0, 3, (1, "Public"), (2, "Private")),
	];

	static readonly IReadOnlyList<HexBitFieldDto> GenericParamAttributesBits = [
		HexText.Choice("Variance", 0, 2, (0, "NonVariant"), (1, "Covariant"), (2, "Contravariant")),
		HexText.Flag("Reference", 2),
		HexText.Flag("Struct", 3),
		HexText.Flag("Default ctor", 4),
		HexText.Flag("Allows ByRefLike", 5),
	];

	static readonly IReadOnlyList<HexBitFieldDto> HeapsBits = [
		HexText.Flag("BigStrings", 0),
		HexText.Flag("BigGUID", 1),
		HexText.Flag("BigBlob", 2),
		HexText.Flag("Padding", 3),
		HexText.Flag("Reserved", 4),
		HexText.Flag("DeltaOnly", 5),
		HexText.Flag("ExtraData", 6),
		HexText.Flag("HasDelete", 7),
	];

	/// <summary>TablesStreamVM.AddTableFlags: a check box per table, the unused ones named after their number.</summary>
	static readonly IReadOnlyList<HexBitFieldDto> TableBits = Enumerable.Range(0, 64)
		.Select(bit => HexText.Flag(bit switch {
			0x2D or 0x2E or 0x2F or >= 0x38 => $"Reserved {bit:X2}",
			_ => ((Table)bit).ToString(),
		}, bit))
		.ToArray();

	/// <summary>
	/// TablesStreamVM: the header's fixed fields, then the row count of every table the valid mask names — written
	/// "m_rows[02]" after the table's number — and the extra data word when the header has one.
	/// </summary>
	public HexStructureDto TablesHeader(string nodeId) {
		var tables = Tables;
		var (start, length) = HeaderSpan(tables);
		var fields = new HexFieldList(Reader);
		fields.Number("m_ulReserved", start, HexText.UInt32);
		fields.Number("m_major", start + 4, HexText.Byte, useDecimal: true);
		fields.Number("m_minor", start + 5, HexText.Byte, useDecimal: true);
		fields.Number("m_heaps", start + 6, HexText.Byte, bits: HeapsBits, group: "Flags");
		fields.Number("m_rid", start + 7, HexText.Byte);
		fields.Number("m_maskvalid", start + 8, HexText.UInt64, bits: TableBits, group: "Valid");
		fields.Number("m_sorted", start + 0x10, HexText.UInt64, bits: TableBits, group: "Sorted");
		var position = start + 0x18;
		var valid = tables.ValidMask;
		for (var i = 0; i < 64; i++, valid >>= 1) {
			if ((valid & 1) == 0)
				continue;
			fields.Number($"m_rows[{i:X2}]", position, HexText.UInt32);
			position += 4;
		}
		if (tables.HasExtraData)
			fields.Number("m_ulExtra", position, HexText.UInt32);
		return new HexStructureDto(nodeId, "MiniMdSchema", start, length, fields.Fields);
	}

	/// <summary>One row as a structure: its fields, with what each refers to beside it.</summary>
	public HexStructureDto Record(string nodeId, MDTable table, uint rid) =>
		new(nodeId, RecordName(table.Table, rid), RowOffset(table, rid), table.RowSize, RecordFields(table, rid));

	/// <summary>The tab-separated header line of dnSpy's Copy as Text (MetadataTableNode.WriteHeader).</summary>
	public static string TextHeader(MDTable table) {
		var builder = new StringBuilder("RID\tToken\tOffset");
		foreach (var column in table.Columns)
			builder.Append('\t').Append(column.Name);
		if (HasInfo(table.Table))
			builder.Append("\tInfo");
		return builder.ToString();
	}

	/// <summary>One row the way dnSpy's Copy as Text writes it (MetadataTableNode.Write): what each field's text box shows.</summary>
	public string TextRow(MDTable table, uint rid) {
		var builder = new StringBuilder();
		builder.Append(rid.ToString(CultureInfo.InvariantCulture))
			.Append('\t').Append($"0x{Token(table.Table, rid):X8}")
			.Append('\t').Append($"0x{RowOffset(table, rid):X8}");
		foreach (var field in RecordFields(table, rid, withNotes: false))
			builder.Append('\t').Append(field.Text);
		if (HasInfo(table.Table))
			builder.Append('\t').Append(Info(table, rid));
		return builder.ToString();
	}
}

/// <summary>
/// dnSpy's TableSorter: which metadata tables the runtime wants sorted, and the order it wants — by the key column
/// (or columns) the ECMA spec names, ties kept in the order they were in.
/// </summary>
internal static class MetadataTableSorter {
	public static bool CanSort(Table table) => table switch {
		Table.InterfaceImpl or Table.Constant or Table.CustomAttribute or Table.FieldMarshal or Table.DeclSecurity
			or Table.ClassLayout or Table.FieldLayout or Table.EventMap or Table.PropertyMap or Table.MethodSemantics
			or Table.MethodImpl or Table.ImplMap or Table.FieldRVA or Table.NestedClass or Table.GenericParam
			or Table.GenericParamConstraint or Table.LocalScope or Table.StateMachineMethod or Table.CustomDebugInformation => true,
		_ => false,
	};

	/// <summary>Sorts whole rows of <paramref name="table"/> in place; <paramref name="data"/> holds a whole number of them.</summary>
	public static void Sort(MDTable table, byte[] data) {
		var rowSize = (int)table.RowSize;
		var rows = new (int Index, byte[] Data)[data.Length / rowSize];
		for (var i = 0; i < rows.Length; i++)
			rows[i] = (i, data.AsSpan(i * rowSize, rowSize).ToArray());

		// Each key is (column, descending); the original index breaks every tie, so the sort is stable.
		(int Column, bool Descending)[] keys = table.Table switch {
			Table.CustomAttribute or Table.FieldMarshal or Table.EventMap or Table.PropertyMap or Table.MethodImpl
				or Table.NestedClass or Table.GenericParamConstraint or Table.StateMachineMethod or Table.CustomDebugInformation => [(0, false)],
			Table.DeclSecurity or Table.FieldLayout or Table.ImplMap or Table.FieldRVA => [(1, false)],
			// The Constant table's parent is column 2: a padding byte sits between its type and its parent.
			Table.Constant or Table.ClassLayout or Table.MethodSemantics => [(2, false)],
			Table.InterfaceImpl => [(0, false), (1, false)],
			Table.GenericParam => [(2, false), (0, false)],
			Table.LocalScope => [(0, false), (4, false), (5, true)],
			_ => throw new RpcException(ErrorCodes.EditValidationFailed, "This metadata table cannot be sorted."),
		};
		Array.Sort(rows, (a, b) => {
			foreach (var (column, descending) in keys) {
				var left = Read(table, a.Data, column);
				var right = Read(table, b.Data, column);
				if (left != right)
					return descending ? right.CompareTo(left) : left.CompareTo(right);
			}
			return a.Index.CompareTo(b.Index);
		});
		for (var i = 0; i < rows.Length; i++)
			rows[i].Data.CopyTo(data, i * rowSize);
	}

	static uint Read(MDTable table, byte[] row, int column) {
		var info = table.Columns[column];
		return info.Size switch {
			2 => BitConverter.ToUInt16(row, info.Offset),
			4 => BitConverter.ToUInt32(row, info.Offset),
			_ => throw new InvalidOperationException(),
		};
	}
}
