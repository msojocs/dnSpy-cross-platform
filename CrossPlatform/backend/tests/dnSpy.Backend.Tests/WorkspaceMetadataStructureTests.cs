using dnlib.DotNet;
using dnlib.DotNet.MD;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// dnSpy's AsmEditor hex nodes as the client sees them: the tables stream, its tables and their rows in the tree, the
/// form of every PE header, the tables stream header and a row, the grid of a table, its Sort and Copy as Text, Go to
/// MD Table Row, and Show in Hex Editor — with every value read through the document's byte patches.
/// </summary>
public sealed class WorkspaceMetadataStructureTests : IDisposable {
	readonly WorkspaceManager manager = new();
	readonly List<string> files = [];

	static CancellationToken Token => TestContext.Current.CancellationToken;

	[Fact]
	public async Task TheTablesStreamHangsOffItsStorageStreamWithATablePerTableThatHasRows() {
		var (workspaceId, root, path) = await OpenCopyAsync();
		using var expected = ModuleDefMD.Load(path);
		var pe = await PeNodeAsync(workspaceId, root.Id);
		var structures = await ChildrenAsync(workspaceId, pe.Id);
		var storageStreams = structures.Where(node => node.Label.StartsWith("Storage Stream #", StringComparison.Ordinal)).ToArray();
		var tablesStorage = Assert.Single(storageStreams, node => node.Label.EndsWith(": #~", StringComparison.Ordinal));
		Assert.True(tablesStorage.HasChildren);
		// The heaps have nothing under them, and neither have the headers.
		Assert.All(storageStreams.Where(node => node.Id != tablesStorage.Id), node => Assert.False(node.HasChildren));
		Assert.All(structures.Where(node => !node.Label.StartsWith("Storage Stream #", StringComparison.Ordinal)), node => Assert.False(node.HasChildren));

		var tablesStream = Assert.Single(await ChildrenAsync(workspaceId, tablesStorage.Id));
		Assert.Equal("tablesstream", tablesStream.Kind);
		Assert.Equal("Tables Stream", tablesStream.Label);
		Assert.Equal("Metadata", tablesStream.Icon);
		Assert.True(tablesStream.HasChildren);

		var tables = await ChildrenAsync(workspaceId, tablesStream.Id);
		var withRows = expected.Metadata.TablesStream.MDTables.Where(table => table.Rows != 0).ToArray();
		Assert.Equal(withRows.Select(table => $"{(byte)table.Table:X2} {table.Table} ({table.Rows})"), tables.Select(node => node.Label));
		Assert.All(tables, node => {
			Assert.Equal("metadatatable", node.Kind);
			Assert.Equal("Metadata", node.Icon);
			Assert.True(node.HasChildren);
		});
		Assert.Equal("00 Module (1)", tables[0].Label);

		var typeDefTable = Assert.Single(tables, node => node.Label.StartsWith("02 TypeDef (", StringComparison.Ordinal));
		var rows = await ChildrenAsync(workspaceId, typeDefTable.Id);
		Assert.Equal((int)expected.Metadata.TablesStream.TypeDefTable.Rows, rows.Count);
		Assert.All(rows, node => {
			Assert.Equal("metadatarecord", node.Kind);
			Assert.Equal("Metadata", node.Icon);
			Assert.False(node.HasChildren);
		});
		// A type is written as its name, then its namespace — the global type has none.
		Assert.Equal("1 - <Module>", rows[0].Label);
		var library = expected.Find("SearchTarget.Library", isReflectionName: false)!;
		Assert.Equal($"{library.Rid} - Library - SearchTarget", rows[(int)library.Rid - 1].Label);

		// A table without an Info column labels its rows with the RID alone.
		var customAttributes = Assert.Single(tables, node => node.Label.StartsWith("0C CustomAttribute (", StringComparison.Ordinal));
		Assert.Equal("1", (await ChildrenAsync(workspaceId, customAttributes.Id))[0].Label);
	}

	[Fact]
	public async Task TheDosHeaderAndTheFileHeaderAreTheirFieldsAsDnSpyNamesAndFormatsThem() {
		var (workspaceId, root, _) = await OpenCopyAsync();
		var structures = await ChildrenAsync(workspaceId, (await PeNodeAsync(workspaceId, root.Id)).Id);

		var dos = await StructureAsync(workspaceId, structures.Single(node => node.Label == "DOS Header").Id);
		Assert.Equal("IMAGE_DOS_HEADER", dos.Name);
		Assert.Equal(0, dos.Offset);
		Assert.Equal(0x40, dos.Length);
		Assert.Equal(31, dos.Fields.Count);
		var magic = dos.Fields[0];
		Assert.Equal(("e_magic", 0L, 2, "uint16", 0x5A4DUL, "0x5A4D"), (magic.Name, magic.Offset, magic.Size, magic.Kind, magic.Value, magic.Text));
		Assert.Null(magic.Bits);
		Assert.Equal("e_res[0]", dos.Fields[14].Name);
		Assert.Equal("e_res2[9]", dos.Fields[29].Name);
		var lfanew = dos.Fields[30];
		Assert.Equal(("e_lfanew", 0x3CL, 4, "uint32"), (lfanew.Name, lfanew.Offset, lfanew.Size, lfanew.Kind));

		var fileHeader = await StructureAsync(workspaceId, structures.Single(node => node.Label == "File Header").Id);
		Assert.Equal("IMAGE_FILE_HEADER", fileHeader.Name);
		Assert.Equal((long)lfanew.Value + 4, fileHeader.Offset);
		var machine = fileHeader.Fields[0];
		Assert.Equal(("Machine", "uint16", 0x14CUL, "0x14C"), (machine.Name, machine.Kind, machine.Value, machine.Text));
		// dnSpy shows the machine as a single combo over all sixteen bits.
		var machineBits = Assert.Single(machine.Bits!);
		Assert.Equal(("Machine", 0, 16), (machineBits.Name, machineBits.Bit, machineBits.Count));
		Assert.Equal(new HexEnumValueDto(0x14C, "I386"), machineBits.Values![0]);
		Assert.Contains(new HexEnumValueDto(0, "Unknown"), machineBits.Values);
		// Small numbers are written in decimal, the time stamp has its date beside it.
		Assert.Equal("NumberOfSections", fileHeader.Fields[1].Name);
		Assert.Matches("^[0-9]$", fileHeader.Fields[1].Text);
		Assert.Equal("TimeDateStamp", fileHeader.Fields[2].Name);
		Assert.False(string.IsNullOrEmpty(fileHeader.Fields[2].Note));
		var characteristics = fileHeader.Fields[6];
		Assert.Equal(("Characteristics", "Characteristics"), (characteristics.Name, characteristics.Group));
		Assert.Equal(16, characteristics.Bits!.Count);
		Assert.Equal(new HexBitFieldDto("Executable Image", 1, 1, null), characteristics.Bits[1]);
	}

	[Fact]
	public async Task TheOtherHeadersFollowTheirViewModels() {
		var (workspaceId, root, path) = await OpenCopyAsync();
		using var expected = ModuleDefMD.Load(path);
		var structures = await ChildrenAsync(workspaceId, (await PeNodeAsync(workspaceId, root.Id)).Id);

		var optional = await StructureAsync(workspaceId, structures.Single(node => node.Label.StartsWith("Optional Header", StringComparison.Ordinal)).Id);
		Assert.Equal("IMAGE_OPTIONAL_HEADER32", optional.Name);
		Assert.Equal(("Magic", "0x10B"), (optional.Fields[0].Name, optional.Fields[0].Text));
		Assert.Equal("PE32", optional.Fields[0].Bits![0].Values![0].Name);
		// The linker version is shown in decimal, whatever its size.
		Assert.Equal(("MajorLinkerVersion", "byte"), (optional.Fields[1].Name, optional.Fields[1].Kind));
		Assert.Matches("^[0-9]+$", optional.Fields[1].Text);
		Assert.Equal("BaseOfData", optional.Fields[8].Name);
		var directories = optional.Fields.SkipWhile(field => field.Name != "NumberOfRvaAndSizes").Skip(1).ToArray();
		Assert.Equal(32, directories.Length);
		Assert.Equal(("Export.VirtualAddress", "Export"), (directories[0].Name, directories[0].Group));
		Assert.Equal(("Base Reloc.Size", "Base Reloc"), (directories[11].Name, directories[11].Group));
		Assert.Equal(".NET.VirtualAddress", directories[28].Name);
		Assert.Equal((ulong)expected.Metadata.PEImage.ImageNTHeaders.OptionalHeader.DataDirectories[14].VirtualAddress, directories[28].Value);

		var text = await StructureAsync(workspaceId, structures.Single(node => node.Label == "Section #0: .text").Id);
		Assert.Equal("IMAGE_SECTION_HEADER", text.Name);
		var name = text.Fields[0];
		Assert.Equal(("Name", 8, "string", 0UL, "\".text\\0\\0\\0\"", ".text"), (name.Name, name.Size, name.Kind, name.Value, name.Text, name.Note));
		var sectionCharacteristics = text.Fields[^1];
		Assert.Equal(new HexBitFieldDto("CNT_CODE", 5, 1, null), sectionCharacteristics.Bits![5]);
		var alignment = Assert.Single(sectionCharacteristics.Bits, bit => bit.Name == "Alignment");
		Assert.Equal((20, 4), (alignment.Bit, alignment.Count));

		var cor20 = await StructureAsync(workspaceId, structures.Single(node => node.Label == "Cor20 Header").Id);
		Assert.Equal("IMAGE_COR20_HEADER", cor20.Name);
		Assert.Equal(new[] { "cb", "MajorRuntimeVersion", "MinorRuntimeVersion", "MetaData.VirtualAddress", "MetaData.Size", "Flags", "EntryPointTokenOrRVA" }, cor20.Fields.Take(7).Select(field => field.Name));
		Assert.Equal("2", cor20.Fields[1].Text);
		Assert.Equal(("Flags", "IL Only"), (cor20.Fields[5].Group, cor20.Fields[5].Bits![0].Name));

		var signature = await StructureAsync(workspaceId, structures.Single(node => node.Label == "Storage Signature").Id);
		Assert.Equal("STORAGESIGNATURE", signature.Name);
		Assert.Equal(("lSignature", "0x424A5342"), (signature.Fields[0].Name, signature.Fields[0].Text));
		Assert.Equal(("VersionString", "string", expected.Metadata.VersionString), (signature.Fields[5].Name, signature.Fields[5].Kind, signature.Fields[5].Note));

		var storageHeader = await StructureAsync(workspaceId, structures.Single(node => node.Label == "Storage Header").Id);
		Assert.Equal(new[] { "fFlags", "pad", "iStreams" }, storageHeader.Fields.Select(field => field.Name));
		Assert.Equal("iExtraData", storageHeader.Fields[0].Bits![0].Name);

		var tablesStorage = structures.Single(node => node.Label.EndsWith(": #~", StringComparison.Ordinal));
		var stream = await StructureAsync(workspaceId, tablesStorage.Id);
		Assert.Equal("STORAGESTREAM", stream.Name);
		Assert.Equal(new[] { "iOffset", "iSize", "rcName" }, stream.Fields.Select(field => field.Name));
		Assert.Equal(("#~", 4), (stream.Fields[2].Note, stream.Fields[2].Size));
	}

	[Fact]
	public async Task TheTablesStreamHeaderListsTheRowCountsAndEndsWhereTheTablesStart() {
		var (workspaceId, root, path) = await OpenCopyAsync();
		using var expected = ModuleDefMD.Load(path);
		var (tablesStream, tables) = await TablesAsync(workspaceId, root.Id);
		var header = await StructureAsync(workspaceId, tablesStream.Id);
		Assert.Equal("MiniMdSchema", header.Name);
		Assert.Equal(new[] { "m_ulReserved", "m_major", "m_minor", "m_heaps", "m_rid", "m_maskvalid", "m_sorted" }, header.Fields.Take(7).Select(field => field.Name));
		Assert.Equal("2", header.Fields[1].Text);
		Assert.Equal(("Flags", "BigStrings"), (header.Fields[3].Group, header.Fields[3].Bits![0].Name));
		Assert.Equal(("uint64", "Valid", 64), (header.Fields[5].Kind, header.Fields[5].Group, header.Fields[5].Bits!.Count));
		Assert.Equal("Reserved 2D", header.Fields[5].Bits![0x2D].Name);
		Assert.Equal("Sorted", header.Fields[6].Group);
		var typeDefRows = Assert.Single(header.Fields, field => field.Name == "m_rows[02]");
		Assert.Equal(expected.Metadata.TablesStream.TypeDefTable.Rows, typeDefRows.Value);

		var module = await manager.GetMetadataTableAsync(new MetadataTableRequest(workspaceId, tables[0].Id), Token);
		Assert.Equal(module.Offset, header.Offset + header.Length);
		Assert.Equal(header.Fields[^1].Offset + 4, module.Offset);
	}

	[Fact]
	public async Task ARowIsAFieldPerColumnWithTheFlagColumnsSplitIntoBits() {
		var (workspaceId, root, path) = await OpenCopyAsync();
		using var expected = ModuleDefMD.Load(path);
		var library = expected.Find("SearchTarget.Library", isReflectionName: false)!;
		var row = await RecordAsync(workspaceId, root.Id, library.MDToken.Raw);
		var record = await StructureAsync(workspaceId, row);
		Assert.Equal($"TypeDef[{library.Rid:X6}]", record.Name);
		Assert.Equal(new[] { "Flags", "Name", "Namespace", "Extends", "FieldList", "MethodList" }, record.Fields.Select(field => field.Name));
		var flags = record.Fields[0];
		Assert.Equal(("uint32", (ulong)library.Attributes, "Flags"), (flags.Kind, flags.Value, flags.Group));
		Assert.Equal($"0x{(uint)library.Attributes:X}", flags.Text);
		var visibility = flags.Bits![0];
		Assert.Equal(("Visibility", 0, 3), (visibility.Name, visibility.Bit, visibility.Count));
		Assert.Equal(new HexEnumValueDto(1, "Public"), visibility.Values![1]);
		Assert.Equal(new HexBitFieldDto("Abstract", 7, 1, null), flags.Bits[3]);
		Assert.Equal(new HexBitFieldDto("BeforeFieldInit", 20, 1, null), Assert.Single(flags.Bits, bit => bit.Name == "BeforeFieldInit"));
		// Beside each column, what it refers to.
		Assert.Equal("Library (#Strings Heap Offset)", record.Fields[1].Note);
		Assert.Equal("SearchTarget (#Strings Heap Offset)", record.Fields[2].Note);
		Assert.StartsWith("System.Object (TypeDefOrRef: TypeRef[", record.Fields[3].Note, StringComparison.Ordinal);
		Assert.EndsWith("(Field RID)", record.Fields[4].Note, StringComparison.Ordinal);

		// A method's two flag columns and an assembly's versions.
		var describe = library.FindMethod("Describe");
		var method = await StructureAsync(workspaceId, await RecordAsync(workspaceId, root.Id, describe.MDToken.Raw));
		Assert.Equal(("ImplFlags", "ImplFlags", "CodeType"), (method.Fields[1].Name, method.Fields[1].Group, method.Fields[1].Bits![0].Name));
		Assert.Equal(("Flags", "Flags", "Access"), (method.Fields[2].Name, method.Fields[2].Group, method.Fields[2].Bits![0].Name));
		var assembly = await StructureAsync(workspaceId, await RecordAsync(workspaceId, root.Id, 0x20000001));
		Assert.Equal("Hash Algorithm", assembly.Fields[0].Bits![0].Name);
		Assert.Equal(("MajorVersion", "uint16"), (assembly.Fields[1].Name, assembly.Fields[1].Kind));
		Assert.Equal(expected.Assembly.Version.Major.ToString(System.Globalization.CultureInfo.InvariantCulture), assembly.Fields[1].Text);
	}

	[Fact]
	public async Task AHexPatchShowsInTheFormTheGridAndTheLabelAndUndoTakesItAway() {
		var (workspaceId, root, path) = await OpenCopyAsync();
		using var expected = ModuleDefMD.Load(path);
		var library = expected.Find("SearchTarget.Library", isReflectionName: false)!;
		var color = expected.Find("SearchTarget.Color", isReflectionName: false)!;
		var row = await RecordAsync(workspaceId, root.Id, library.MDToken.Raw);
		var before = await StructureAsync(workspaceId, row);
		var flags = before.Fields[0];
		var name = before.Fields[1];

		// Make the type sealed, and give it the name the Color row has.
		var colorRow = await StructureAsync(workspaceId, await RecordAsync(workspaceId, root.Id, color.MDToken.Raw));
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), Token);
		await manager.QueueHexPatchAsync(new HexPatchRequest(workspaceId, transaction.TransactionId, row, flags.Offset, Convert.ToBase64String(BitConverter.GetBytes((uint)flags.Value | 0x100))), Token);
		var nameBytes = BitConverter.GetBytes(colorRow.Fields[1].Value).Take(name.Size).ToArray();
		await manager.QueueHexPatchAsync(new HexPatchRequest(workspaceId, transaction.TransactionId, row, name.Offset, Convert.ToBase64String(nameBytes)), Token);
		await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), Token);

		var after = await StructureAsync(workspaceId, row);
		Assert.Equal(flags.Value | 0x100, after.Fields[0].Value);
		Assert.Equal("Color (#Strings Heap Offset)", after.Fields[1].Note);
		var rows = await manager.GetMetadataTableRowsAsync(new MetadataTableRowsRequest(workspaceId, row, library.Rid, 1), Token);
		Assert.Equal(flags.Value | 0x100, rows.Rows[0].Values[0]);
		Assert.Equal("SearchTarget.Color", rows.Rows[0].Info);
		Assert.Equal($"{library.Rid} - Color - SearchTarget", (await manager.GetNodeAsync(new NodeRequest(workspaceId, row), Token)).Label);

		await manager.UndoAsync(new WorkspaceRequest(workspaceId), Token);
		var undone = await StructureAsync(workspaceId, row);
		Assert.Equal(flags.Value, undone.Fields[0].Value);
		Assert.Equal("Library (#Strings Heap Offset)", undone.Fields[1].Note);
		Assert.Equal($"{library.Rid} - Library - SearchTarget", (await manager.GetNodeAsync(new NodeRequest(workspaceId, row), Token)).Label);
	}

	[Fact]
	public async Task ATableIsItsColumnsAndItsRowsComeWithTheInfoColumn() {
		var (workspaceId, root, path) = await OpenCopyAsync();
		using var expected = ModuleDefMD.Load(path);
		var (_, tables) = await TablesAsync(workspaceId, root.Id);
		var typeDefNode = tables.Single(node => node.Label.StartsWith("02 TypeDef", StringComparison.Ordinal));
		var typeDef = await manager.GetMetadataTableAsync(new MetadataTableRequest(workspaceId, typeDefNode.Id), Token);
		var mdTable = expected.Metadata.TablesStream.TypeDefTable;
		Assert.Equal((typeDefNode.Id, 2, "02 TypeDef", mdTable.Rows, (int)mdTable.RowSize, (long)(uint)mdTable.StartOffset, true, false),
			(typeDef.NodeId, typeDef.Table, typeDef.Name, typeDef.Rows, typeDef.RowSize, typeDef.Offset, typeDef.HasInfo, typeDef.CanSort));
		Assert.Equal(new[] { "Flags", "Name", "Namespace", "Extends", "FieldList", "MethodList" }, typeDef.Columns.Select(column => column.Name));
		Assert.Equal(0, typeDef.Columns[0].Offset);
		Assert.Equal(typeDef.RowSize, typeDef.Columns.Sum(column => column.Size));

		// The range is clamped to the table.
		var rows = await manager.GetMetadataTableRowsAsync(new MetadataTableRowsRequest(workspaceId, typeDefNode.Id, 0, 100_000), Token);
		Assert.Equal((int)mdTable.Rows, rows.Rows.Count);
		Assert.Equal((1u, 0x02000001u, typeDef.Offset, "<Module>"), (rows.Rows[0].Rid, rows.Rows[0].Token, rows.Rows[0].Offset, rows.Rows[0].Info));
		var library = expected.Find("SearchTarget.Library", isReflectionName: false)!;
		var libraryRow = rows.Rows[(int)library.Rid - 1];
		Assert.Equal("SearchTarget.Library", libraryRow.Info);
		Assert.Equal((ulong)library.Attributes, libraryRow.Values[0]);
		Assert.Equal(6, libraryRow.Values.Count);
		Assert.Empty((await manager.GetMetadataTableRowsAsync(new MetadataTableRowsRequest(workspaceId, typeDefNode.Id, mdTable.Rows + 1, 10), Token)).Rows);

		// A table with no Info column, which the runtime wants sorted; a row node names its table too.
		var customAttributeNode = tables.Single(node => node.Label.StartsWith("0C CustomAttribute", StringComparison.Ordinal));
		var firstRow = (await ChildrenAsync(workspaceId, customAttributeNode.Id))[0];
		var customAttribute = await manager.GetMetadataTableAsync(new MetadataTableRequest(workspaceId, firstRow.Id), Token);
		Assert.Equal((customAttributeNode.Id, "0C CustomAttribute", false, true), (customAttribute.NodeId, customAttribute.Name, customAttribute.HasInfo, customAttribute.CanSort));
		Assert.Null((await manager.GetMetadataTableRowsAsync(new MetadataTableRowsRequest(workspaceId, customAttributeNode.Id, 1, 1), Token)).Rows[0].Info);

		// Copy as Text: a header line, then the rows asked for that are in the table.
		var text = await manager.GetMetadataTableTextAsync(new MetadataTableTextRequest(workspaceId, typeDefNode.Id, [1, library.Rid, 100_000]), Token);
		var lines = text.Text.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);
		Assert.Equal(3, lines.Length);
		Assert.Equal("RID\tToken\tOffset\tFlags\tName\tNamespace\tExtends\tFieldList\tMethodList\tInfo", lines[0]);
		Assert.StartsWith($"1\t0x02000001\t0x{typeDef.Offset:X8}\t0\t", lines[1], StringComparison.Ordinal);
		Assert.EndsWith("\t<Module>", lines[1], StringComparison.Ordinal);
		Assert.StartsWith($"{library.Rid}\t0x{library.MDToken.Raw:X8}\t0x{libraryRow.Offset:X8}\t0x{(uint)library.Attributes:X}\t", lines[2], StringComparison.Ordinal);
		Assert.EndsWith("\tSearchTarget.Library", lines[2], StringComparison.Ordinal);
	}

	[Fact]
	public async Task SortingReturnsTheRowsInTheOrderTheRuntimeWants() {
		var (workspaceId, root, path) = await OpenCopyAsync();
		using var expected = ModuleDefMD.Load(path);
		var (_, tables) = await TablesAsync(workspaceId, root.Id);
		var customAttributeNode = tables.Single(node => node.Label.StartsWith("0C CustomAttribute", StringComparison.Ordinal));
		var table = await manager.GetMetadataTableAsync(new MetadataTableRequest(workspaceId, customAttributeNode.Id), Token);
		var original = await File.ReadAllBytesAsync(path, Token);
		var tableBytes = original.AsSpan((int)table.Offset, (int)(table.Rows * table.RowSize)).ToArray();

		// The compiler wrote the table sorted, so sorting it changes nothing.
		var sorted = await manager.SortMetadataTableAsync(new MetadataSortRequest(workspaceId, customAttributeNode.Id, 1, table.Rows), Token);
		Assert.Equal(table.Offset, sorted.Offset);
		Assert.Equal(tableBytes, Convert.FromBase64String(sorted.Base64Data));

		// Swap two rows with different parents, and sorting them puts them back.
		var rows = (await manager.GetMetadataTableRowsAsync(new MetadataTableRowsRequest(workspaceId, customAttributeNode.Id, 1, (int)table.Rows), Token)).Rows;
		var index = Enumerable.Range(0, rows.Count - 1).First(i => rows[i].Values[0] < rows[i + 1].Values[0]);
		var pair = tableBytes.AsSpan(index * table.RowSize, 2 * table.RowSize).ToArray();
		var swapped = pair[table.RowSize..].Concat(pair[..table.RowSize]).ToArray();
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), Token);
		await manager.QueueHexPatchAsync(new HexPatchRequest(workspaceId, transaction.TransactionId, customAttributeNode.Id, rows[index].Offset, Convert.ToBase64String(swapped)), Token);
		await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), Token);
		var resorted = await manager.SortMetadataTableAsync(new MetadataSortRequest(workspaceId, customAttributeNode.Id, (uint)index + 1, 2), Token);
		Assert.Equal(rows[index].Offset, resorted.Offset);
		Assert.Equal(pair, Convert.FromBase64String(resorted.Base64Data));

		// The TypeDef table is never sorted, and rows past the end are not the table's.
		var typeDefNode = tables.Single(node => node.Label.StartsWith("02 TypeDef", StringComparison.Ordinal));
		await Assert.ThrowsAsync<RpcException>(() => manager.SortMetadataTableAsync(new MetadataSortRequest(workspaceId, typeDefNode.Id, 1, 2), Token));
		await Assert.ThrowsAsync<RpcException>(() => manager.SortMetadataTableAsync(new MetadataSortRequest(workspaceId, customAttributeNode.Id, table.Rows, 2), Token));
	}

	[Fact]
	public async Task GoToMetadataTableRowFindsTheRowNodeAndTheNodesAboveIt() {
		var (workspaceId, root, path) = await OpenCopyAsync();
		using var expected = ModuleDefMD.Load(path);
		var library = expected.Find("SearchTarget.Library", isReflectionName: false)!;
		// Any node of the module will do — here, a type.
		var @namespace = Assert.Single(await ChildrenAsync(workspaceId, (await ModuleNodeAsync(workspaceId, root.Id)).Id), node => node.Label == "SearchTarget");
		var type = Assert.Single(await ChildrenAsync(workspaceId, @namespace.Id), node => node.Label == "Library");

		var found = await manager.FindMetadataRecordAsync(new MetadataFindRecordRequest(workspaceId, type.Id, library.MDToken.Raw), Token);
		Assert.Null(found.Error);
		Assert.NotNull(found.NodeId);
		var kinds = new List<string>();
		foreach (var id in found.Path)
			kinds.Add((await manager.GetNodeAsync(new NodeRequest(workspaceId, id), Token)).Kind);
		Assert.Equal(new[] { "assembly", "module", "pe", "pestructure", "tablesstream", "metadatatable" }, kinds);
		Assert.Equal(root.Id, found.Path[0]);
		Assert.Contains(await ChildrenAsync(workspaceId, found.Path[^1]), node => node.Id == found.NodeId);
		Assert.Equal($"{library.Rid} - Library - SearchTarget", (await manager.GetNodeAsync(new NodeRequest(workspaceId, found.NodeId!), Token)).Label);

		var invalid = await manager.FindMetadataRecordAsync(new MetadataFindRecordRequest(workspaceId, root.Id, 0x02FFFFFF), Token);
		Assert.Null(invalid.NodeId);
		Assert.Equal("Invalid metadata token: 0x02FFFFFF", invalid.Error);
		Assert.Empty(invalid.Path);
		Assert.Equal("Invalid metadata token: 0x70000001", (await manager.FindMetadataRecordAsync(new MetadataFindRecordRequest(workspaceId, root.Id, 0x70000001), Token)).Error);
	}

	[Fact]
	public async Task ARowFoundInAModuleThatWasNeverSavedDoesNotExist() {
		var workspace = manager.CreateWorkspace();
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspace.WorkspaceId), Token);
		var created = await manager.QueueCreateAssemblyAsync(new CreateAssemblyRequest(workspace.WorkspaceId, transaction.TransactionId,
			new AssemblyOptionsDto("InMemory", null, (int)AssemblyHashAlgorithm.SHA1, 0, string.Empty, 1, 0, 0, 0, [], [], string.Empty), ClrVersions.Clr40), Token);
		await manager.CommitEditAsync(new EditTransactionRequest(workspace.WorkspaceId, transaction.TransactionId), Token);

		// The token names the module's own row, but a document with no file has no PE node to find it under.
		var found = await manager.FindMetadataRecordAsync(new MetadataFindRecordRequest(workspace.WorkspaceId, created.NodeId, 0x00000001), Token);
		Assert.Null(found.NodeId);
		Assert.Equal("Token 00000001 doesn't exist in the metadata", found.Error);
	}

	[Fact]
	public async Task AFoundRowHasAPathAndADocumentEvenIfItsParentsWereNeverListed() {
		var (workspaceId, root, path) = await OpenCopyAsync();
		using var expected = ModuleDefMD.Load(path);
		var library = expected.Find("SearchTarget.Library", isReflectionName: false)!;
		// Straight from the root: no node between it and the row has been listed.
		var found = await manager.FindMetadataRecordAsync(new MetadataFindRecordRequest(workspaceId, root.Id, library.MDToken.Raw), Token);
		var nodePath = await manager.GetNodePathAsync(new NodeRequest(workspaceId, found.NodeId!), Token);
		Assert.Equal(new[] { "assembly", "module", "pe", "pestructure", "tablesstream", "metadatatable", "metadatarecord" }, nodePath.Nodes.Select(node => node.Kind));
		Assert.Equal(found.Path.Append(found.NodeId!), nodePath.Nodes.Select(node => node.Id));
		Assert.EndsWith(": #~", nodePath.Nodes[3].Label, StringComparison.Ordinal);
		// The table and the tables stream have their chains too.
		Assert.Equal(6, (await manager.GetNodePathAsync(new NodeRequest(workspaceId, found.Path[^1]), Token)).Nodes.Count);
		Assert.Equal(5, (await manager.GetNodePathAsync(new NodeRequest(workspaceId, found.Path[^2]), Token)).Nodes.Count);

		var row = await manager.GetNodeAsync(new NodeRequest(workspaceId, found.NodeId!), Token);
		Assert.Equal("metadatarecord", row.Kind);
		var document = await manager.DecompileAsync(new DecompileRequest(workspaceId, found.NodeId!, DecompilerLanguage.CSharp), Token);
		var lines = document.Text.Split('\n', StringSplitOptions.RemoveEmptyEntries);
		Assert.EndsWith($" {library.Rid} - Library - SearchTarget", lines[0], StringComparison.Ordinal);
		Assert.Contains($"// TypeDef[{library.Rid:X6}]:", lines);
		Assert.Contains(lines, line => line.EndsWith($" {(uint)library.Attributes:X8} = Flags", StringComparison.Ordinal));
		var tableDocument = await manager.DecompileAsync(new DecompileRequest(workspaceId, found.Path[^1], DecompilerLanguage.IL), Token);
		Assert.Contains("// RID\tToken\tOffset\tFlags\tName\tNamespace\tExtends\tFieldList\tMethodList\tInfo", tableDocument.Text);
		var header = await manager.DecompileAsync(new DecompileRequest(workspaceId, found.Path[^2], DecompilerLanguage.VisualBasic), Token);
		Assert.Contains("' MiniMdSchema:", header.Text);
	}

	[Fact]
	public async Task ShowInHexEditorPointsAtTheStructureAndShowDataAtWhatItDescribes() {
		var (workspaceId, root, path) = await OpenCopyAsync();
		using var expected = ModuleDefMD.Load(path);
		var pe = await PeNodeAsync(workspaceId, root.Id);
		Assert.Null((await TargetAsync(workspaceId, pe.Id)).Structure);
		var structures = await ChildrenAsync(workspaceId, pe.Id);

		var dos = await TargetAsync(workspaceId, structures.Single(node => node.Label == "DOS Header").Id);
		Assert.Equal(new HexRangeDto(0, 0x40), dos.Structure);
		Assert.Null(dos.StructureData);

		var text = await TargetAsync(workspaceId, structures.Single(node => node.Label == "Section #0: .text").Id);
		var section = expected.Metadata.PEImage.ImageSectionHeaders[0];
		Assert.Equal(new HexRangeDto((uint)section.StartOffset, 0x28), text.Structure);
		Assert.Equal(new HexRangeDto(section.PointerToRawData, section.SizeOfRawData), text.StructureData);

		var tablesStorage = structures.Single(node => node.Label.EndsWith(": #~", StringComparison.Ordinal));
		var storage = await TargetAsync(workspaceId, tablesStorage.Id);
		var tablesStream = expected.Metadata.TablesStream;
		Assert.Equal(new HexRangeDto((uint)tablesStream.StartOffset, tablesStream.StreamLength), storage.StructureData);
		Assert.Equal((uint)tablesStream.StreamHeader.StartOffset, storage.Structure!.Offset);

		var (tablesStreamNode, tables) = await TablesAsync(workspaceId, root.Id);
		var header = await StructureAsync(workspaceId, tablesStreamNode.Id);
		Assert.Equal(new HexRangeDto(header.Offset, header.Length), (await TargetAsync(workspaceId, tablesStreamNode.Id)).Structure);
		var typeDefNode = tables.Single(node => node.Label.StartsWith("02 TypeDef", StringComparison.Ordinal));
		var typeDef = tablesStream.TypeDefTable;
		Assert.Equal(new HexRangeDto((uint)typeDef.StartOffset, typeDef.Rows * typeDef.RowSize), (await TargetAsync(workspaceId, typeDefNode.Id)).Structure);
		var second = (await ChildrenAsync(workspaceId, typeDefNode.Id))[1];
		Assert.Equal(new HexRangeDto((uint)typeDef.StartOffset + typeDef.RowSize, typeDef.RowSize), (await TargetAsync(workspaceId, second.Id)).Structure);
	}

	[Fact]
	public async Task OnlyHexStructuresHaveAForm() {
		var (workspaceId, root, _) = await OpenCopyAsync();
		await Assert.ThrowsAsync<RpcException>(() => manager.GetHexStructureAsync(new HexStructureRequest(workspaceId, root.Id), Token));
		var (_, tables) = await TablesAsync(workspaceId, root.Id);
		await Assert.ThrowsAsync<RpcException>(() => manager.GetHexStructureAsync(new HexStructureRequest(workspaceId, tables[0].Id), Token));
		await Assert.ThrowsAsync<RpcException>(() => manager.GetMetadataTableAsync(new MetadataTableRequest(workspaceId, root.Id), Token));
	}

	Task<HexStructureDto> StructureAsync(string workspaceId, string nodeId) =>
		manager.GetHexStructureAsync(new HexStructureRequest(workspaceId, nodeId), Token);

	Task<HexTargetResponse> TargetAsync(string workspaceId, string nodeId) =>
		manager.ResolveHexTargetAsync(new HexTargetRequest(workspaceId, nodeId), Token);

	async Task<string> RecordAsync(string workspaceId, string nodeId, uint token) {
		var found = await manager.FindMetadataRecordAsync(new MetadataFindRecordRequest(workspaceId, nodeId, token), Token);
		Assert.Null(found.Error);
		return found.NodeId!;
	}

	async Task<(TreeNodeDto TablesStream, IReadOnlyList<TreeNodeDto> Tables)> TablesAsync(string workspaceId, string rootId) {
		var structures = await ChildrenAsync(workspaceId, (await PeNodeAsync(workspaceId, rootId)).Id);
		var tablesStorage = structures.Single(node => node.Label.EndsWith(": #~", StringComparison.Ordinal));
		var tablesStream = Assert.Single(await ChildrenAsync(workspaceId, tablesStorage.Id));
		return (tablesStream, await ChildrenAsync(workspaceId, tablesStream.Id));
	}

	async Task<IReadOnlyList<TreeNodeDto>> ChildrenAsync(string workspaceId, string nodeId) =>
		(await manager.GetChildrenAsync(new NodeRequest(workspaceId, nodeId), Token)).Nodes;

	async Task<TreeNodeDto> ModuleNodeAsync(string workspaceId, string rootId) =>
		Assert.Single(await ChildrenAsync(workspaceId, rootId), node => node.Kind == "module");

	async Task<TreeNodeDto> PeNodeAsync(string workspaceId, string rootId) =>
		Assert.Single(await ChildrenAsync(workspaceId, (await ModuleNodeAsync(workspaceId, rootId)).Id), node => node.Kind == "pe");

	async Task<(string WorkspaceId, TreeNodeDto Root, string Path)> OpenCopyAsync() {
		var copy = Path.Combine(Path.GetTempPath(), $"metadata-{Guid.NewGuid():N}.dll");
		files.Add(copy);
		File.Copy(typeof(SearchTarget.Library).Assembly.Location, copy);
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([copy]), Token);
		var root = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), Token)).Nodes);
		return (opened.WorkspaceId, root, copy);
	}

	public void Dispose() {
		manager.Dispose();
		foreach (var file in files) {
			try {
				File.Delete(file);
			}
			catch (IOException) {
			}
		}
	}
}
