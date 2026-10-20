using System.Globalization;
using System.Text;
using dnlib.DotNet;
using dnlib.DotNet.Resources;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// dnSpy's hex structure model (dnSpy.Hex.Files) over a document's patched bytes: the tooltip and the fields a hover
/// highlights, what the hex view's commands select, copy, follow and edit, the hex search services' FindAll, and the
/// hex range of a resource element. The expected tooltip text is what dnSpy's HexFieldFormatterImpl writes with the
/// options its tooltip creator uses (HexCSharp values padded to the field's width followed by the decimal value in
/// parentheses, minimum-digit array indexes).
/// </summary>
public sealed class HexStructureTests : IDisposable {
	readonly WorkspaceManager manager = new();
	readonly List<string> files = [];

	static CancellationToken Token => TestContext.Current.CancellationToken;

	[Fact]
	public async Task ADosHeaderFieldHasItsStructureTooltipAndTheWholeHeaderAsItsStructure() {
		var (workspaceId, moduleId, _) = await OpenCopyAsync();
		var info = await ToolTipAsync(workspaceId, moduleId, 1);

		var toolTip = Assert.IsType<HexToolTipDto>(info.ToolTip);
		Assert.Equal("FieldPublic", toolTip.Image);
		var section = Assert.Single(toolTip.Sections);
		Assert.Equal("IMAGE_DOS_HEADER.e_magic = 0x5A4D (23117)", Text(section));
		// StructureName is drawn as a value type and Field as an instance field (ToolTipObjectFactoryImpl.GetColor).
		Assert.Equal(
			[("IMAGE_DOS_HEADER", TextColors.ValueType), (".", TextColors.Operator), ("e_magic", TextColors.InstanceField), (" ", TextColors.Text), ("=", TextColors.Operator),
			(" ", TextColors.Text), ("0x5A4D", TextColors.Number), (" ", TextColors.Text), ("(", TextColors.Punctuation), ("23117", TextColors.Number), (")", TextColors.Punctuation)],
			section.Select(part => (part.Text, part.Color)));
		// The DOS header has no sub-structures, so the whole of it is the structure around the current field.
		Assert.Equal([new HexStructureFieldSpanDto(0, 2, "currentField"), new HexStructureFieldSpanDto(0, 0x40, "structure")], info.Fields);
	}

	[Fact]
	public async Task APositionInNoStructureHasNoTooltipAndNoFields() {
		var (workspaceId, moduleId, path) = await OpenCopyAsync();
		using var module = ModuleDefMD.Load(path);
		// The DOS stub between the DOS header and the NT headers belongs to no structure.
		var info = await ToolTipAsync(workspaceId, moduleId, 0x40);
		Assert.Null(info.ToolTip);
		Assert.Empty(info.Fields);
		var beyond = await ToolTipAsync(workspaceId, moduleId, new FileInfo(path).Length);
		Assert.Null(beyond.ToolTip);
		Assert.Empty(beyond.Fields);
	}

	[Fact]
	public async Task AStringsColumnOfATableRowEndsWithTheStringItNames() {
		var (workspaceId, moduleId, path) = await OpenCopyAsync();
		using var module = ModuleDefMD.Load(path);
		var tables = module.Metadata.TablesStream;
		var typeDefs = tables.TypeDefTable;
		Assert.True(tables.TryReadTypeDefRow(2, out var row));
		var name = module.Metadata.StringsStream.ReadNoNull(row.Name).String;
		var column = typeDefs.Columns[1];
		var rowStart = Offset(typeDefs.StartOffset) + typeDefs.RowSize;
		var position = rowStart + column.Offset;

		var info = await ToolTipAsync(workspaceId, moduleId, position);
		var toolTip = Assert.IsType<HexToolTipDto>(info.ToolTip);
		Assert.Equal("ClassPublic", toolTip.Image);
		var digits = column.Size == 2 ? "X4" : "X8";
		Assert.Equal(
			$"TypeDef[2].Name = 0x{row.Name.ToString(digits, CultureInfo.InvariantCulture)} ({row.Name}) (\"{name}\")",
			Text(Assert.Single(toolTip.Sections)));
		Assert.Contains(Assert.Single(toolTip.Sections), part => part.Text == $"\"{name}\"" && part.Color == TextColors.String);
		Assert.Equal(
			[new HexStructureFieldSpanDto(position, column.Size, "currentField"), new HexStructureFieldSpanDto(rowStart, typeDefs.RowSize, "structure")],
			info.Fields);

		// The column is an index into #Strings, so Follow Field Value Reference selects the string, terminator included.
		var positionInfo = await PositionAsync(workspaceId, moduleId, position);
		Assert.Equal(new HexRangeDto(Offset(module.Metadata.StringsStream.StartOffset) + row.Name, Encoding.UTF8.GetByteCount(name) + 1), positionInfo.FieldReference);
		Assert.Equal(new HexRangeDto(rowStart, typeDefs.RowSize), positionInfo.Structure);
	}

	[Fact]
	public async Task AMethodBodyNamesItsMethodAndGoesToItsCode() {
		var (workspaceId, moduleId, path) = await OpenCopyAsync();
		using var module = ModuleDefMD.Load(path);
		var method = module.Find("SearchTarget.Library", isReflectionName: false)!.FindMethod("Describe");
		var body = (long)(uint)module.Metadata.PEImage.ToFileOffset(method.RVA);
		Assert.True(method.Body.IsBigHeader);
		var code = body + 12;
		var codeSize = method.Body.Instructions.Sum(instruction => instruction.GetSize());

		var header = await ToolTipAsync(workspaceId, moduleId, body);
		var toolTip = Assert.IsType<HexToolTipDto>(header.ToolTip);
		Assert.Equal("MethodPublic", toolTip.Image);
		Assert.Equal(2, toolTip.Sections.Count);
		Assert.Equal($"Method 0x{method.MDToken.Raw:X8}", Text(toolTip.Sections[0]));
		Assert.StartsWith("IMAGE_COR_ILMETHOD_FAT.Flags = ", Text(toolTip.Sections[1]), StringComparison.Ordinal);
		// A fat body without exception handlers is two sub-structures: the header and the code (DotNetHexFileStructureInfoProvider).
		Assert.Equal(
			[new HexStructureFieldSpanDto(body, 2, "currentField"), new HexStructureFieldSpanDto(body, 12, "subStructure"), new HexStructureFieldSpanDto(code, codeSize, "subStructure")],
			header.Fields);

		// F12 in the header goes to the method; in the code, to the instruction.
		var inHeader = Assert.IsType<HexCodeReferenceDto>((await PositionAsync(workspaceId, moduleId, body + 1)).Reference);
		Assert.Equal(new HexCodeReferenceDto("method", null, path, unchecked((int)method.MDToken.Raw), null), inHeader);
		var second = method.Body.Instructions[1].Offset;
		var inCode = await PositionAsync(workspaceId, moduleId, code + second);
		Assert.Equal(new HexCodeReferenceDto("method", null, path, unchecked((int)method.MDToken.Raw), (int)second), inCode.Reference);
		Assert.Equal((long)(uint)method.RVA + 12 + second, inCode.Rva);
		Assert.Equal(code + second, inCode.FileOffset);
		Assert.Equal(new HexRangeDto(body, 12 + codeSize), inCode.Structure);
	}

	[Fact]
	public async Task AStringsHeapRecordNamesItsHeapOffsetAndTokens() {
		var (workspaceId, moduleId, path) = await OpenCopyAsync();
		using var module = ModuleDefMD.Load(path);
		var strings = Offset(module.Metadata.StringsStream.StartOffset);
		var info = await ToolTipAsync(workspaceId, moduleId, strings + 1);
		var toolTip = Assert.IsType<HexToolTipDto>(info.ToolTip);
		Assert.Equal("String", toolTip.Image);
		Assert.Equal(("#Strings", TextColors.HexTableName), (toolTip.Sections[0][0].Text, toolTip.Sections[0][0].Color));
		Assert.StartsWith("#Strings, offset 0x00000001 (1)", Text(toolTip.Sections[0]), StringComparison.Ordinal);
		var first = module.Metadata.StringsStream.ReadNoNull(1).String;
		Assert.Equal($"StringZ.String = \"{first}\"", Text(toolTip.Sections[1]));
		// A string and its terminator are the record's two sub-structures.
		var length = Encoding.UTF8.GetByteCount(first);
		Assert.Equal(
			[new HexStructureFieldSpanDto(strings + 1, length, "currentField"), new HexStructureFieldSpanDto(strings + 1, length, "subStructure"), new HexStructureFieldSpanDto(strings + 1 + length, 1, "subStructure")],
			info.Fields);
	}

	[Fact]
	public async Task ADosHeaderFieldIsInTheFileTheStructureAndTheDosHeaderNode() {
		var (workspaceId, moduleId, path) = await OpenCopyAsync();
		var info = await PositionAsync(workspaceId, moduleId, 0x3C);
		var length = new FileInfo(path).Length;
		Assert.Equal(new HexRangeDto(0, length), info.File);
		Assert.Equal(new HexRangeDto(0, length), info.NestedFile);
		Assert.Equal(new HexRangeDto(0, 0x40), info.Structure);
		// The headers are in no section, so they have no RVA (PeHeadersImpl.BufferPositionToRva).
		Assert.Equal(0, info.Rva);
		Assert.Equal(0x3C, info.FileOffset);
		Assert.Null(info.EditField);
		// e_lfanew is a file offset: following it goes to the NT headers.
		using var module = ModuleDefMD.Load(path);
		Assert.Equal(new HexRangeDto(Offset(module.Metadata.PEImage.ImageNTHeaders.StartOffset), 0), info.FieldReference);

		// F12 goes to the PE tree's DOS Header node, which the tree can walk to.
		var reference = Assert.IsType<HexCodeReferenceDto>(info.Reference);
		Assert.Equal("node", reference.Kind);
		var nodePath = (await manager.GetNodePathAsync(new NodeRequest(workspaceId, reference.NodeId!), Token)).Nodes;
		Assert.Equal(["assembly", "module", "pe", "pestructure"], nodePath.Select(node => node.Kind));
		Assert.Equal("DOS Header", nodePath[^1].Label);
		Assert.Equal(reference.NodeId, nodePath[^1].Id);
		Assert.Contains(await ChildrenAsync(workspaceId, nodePath[^2].Id), node => node.Id == reference.NodeId);
	}

	[Fact]
	public async Task AMetadataTableRowGoesToItsRecordNode() {
		var (workspaceId, moduleId, path) = await OpenCopyAsync();
		using var module = ModuleDefMD.Load(path);
		var typeDefs = module.Metadata.TablesStream.TypeDefTable;
		var info = await PositionAsync(workspaceId, moduleId, Offset(typeDefs.StartOffset) + 2L * typeDefs.RowSize + 1);
		var reference = Assert.IsType<HexCodeReferenceDto>(info.Reference);
		Assert.Equal("node", reference.Kind);
		var nodePath = (await manager.GetNodePathAsync(new NodeRequest(workspaceId, reference.NodeId!), Token)).Nodes;
		Assert.Equal("metadatarecord", nodePath[^1].Kind);
		Assert.StartsWith("3 - ", nodePath[^1].Label, StringComparison.Ordinal);
		Assert.Equal("metadatatable", nodePath[^2].Kind);
		Assert.StartsWith("02 TypeDef", nodePath[^2].Label, StringComparison.Ordinal);
	}

	[Fact]
	public async Task TheMetadataDirectoryOfTheClrHeaderFollowsToTheMetadata() {
		var (workspaceId, moduleId, path) = await OpenCopyAsync();
		using var module = ModuleDefMD.Load(path);
		var cor20 = module.Metadata.ImageCor20Header;
		var directory = Offset(cor20.StartOffset) + 8;
		var info = await PositionAsync(workspaceId, moduleId, directory);
		Assert.Equal(new HexRangeDto((long)(uint)module.Metadata.PEImage.ToFileOffset(cor20.Metadata.VirtualAddress), cor20.Metadata.Size), info.FieldReference);
		Assert.Equal(new HexRangeDto(Offset(cor20.StartOffset), 0x48), info.Structure);

		var toolTip = Assert.IsType<HexToolTipDto>((await ToolTipAsync(workspaceId, moduleId, directory)).ToolTip);
		Assert.StartsWith("IMAGE_COR20_HEADER.MetaData.VirtualAddress = ", Text(Assert.Single(toolTip.Sections)), StringComparison.Ordinal);
	}

	[Fact]
	public async Task TheFileHeaderCharacteristicsAreAFlagsFieldToEdit() {
		var (workspaceId, moduleId, path) = await OpenCopyAsync();
		using var module = ModuleDefMD.Load(path);
		var fileHeader = module.Metadata.PEImage.ImageNTHeaders.FileHeader;
		var position = Offset(fileHeader.StartOffset) + 0x12;
		var info = await PositionAsync(workspaceId, moduleId, position);

		var field = Assert.IsType<HexEditFieldDto>(info.EditField);
		Assert.Equal((position, 2, "flags"), (field.Offset, field.Size, field.Kind));
		Assert.Equal(((ushort)fileHeader.Characteristics).ToString(CultureInfo.InvariantCulture), field.Value);
		// Every IMAGE_FILE_HEADER flag is a toggle of its own bit, in bit order.
		Assert.Equal(16, field.Items.Count);
		Assert.Equal(new HexEditFieldItemDto("RELOCS_STRIPPED", "1", "1", true), field.Items[0]);
		Assert.Equal(new HexEditFieldItemDto("DLL", "8192", "8192", true), field.Items[13]);
		Assert.All(field.Items, item => Assert.True(item.IsFlag));
	}

	[Fact]
	public async Task AMethodHeadersFormatIsAnEnumPartOfItsFlags() {
		var (workspaceId, moduleId, path) = await OpenCopyAsync();
		using var module = ModuleDefMD.Load(path);
		var method = module.Find("SearchTarget.Library", isReflectionName: false)!.FindMethod("Describe");
		var body = (long)(uint)module.Metadata.PEImage.ToFileOffset(method.RVA);
		var field = Assert.IsType<HexEditFieldDto>((await PositionAsync(workspaceId, moduleId, body)).EditField);
		Assert.Equal("flags", field.Kind);
		// The format is an enum inside the flags: its values are not toggles, and its name entry is left out.
		Assert.Equal(new HexEditFieldItemDto("FatFormat", "7", "3", false), Assert.Single(field.Items, item => item.Name == "FatFormat"));
		Assert.Equal(new HexEditFieldItemDto("InitLocals", "16", "16", true), Assert.Single(field.Items, item => item.Name == "InitLocals"));
	}

	[Fact]
	public async Task AHexPatchShowsInTheModelAndUndoTakesItAway() {
		var (workspaceId, moduleId, path) = await OpenCopyAsync();
		// e_cblp, which no reader of the image checks, so the patched file is still a PE image.
		var original = BitConverter.ToUInt16(File.ReadAllBytes(path), 2);
		var before = $"IMAGE_DOS_HEADER.e_cblp = 0x{original:X4} ({original})";
		Assert.Equal(before, await ToolTipTextAsync(workspaceId, moduleId, 2));

		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), Token);
		await manager.QueueHexPatchAsync(new HexPatchRequest(workspaceId, transaction.TransactionId, moduleId, 2, Convert.ToBase64String(BitConverter.GetBytes((ushort)0x1234))), Token);
		await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), Token);
		Assert.Equal("IMAGE_DOS_HEADER.e_cblp = 0x1234 (4660)", await ToolTipTextAsync(workspaceId, moduleId, 2));

		await manager.UndoAsync(new WorkspaceRequest(workspaceId), Token);
		Assert.Equal(before, await ToolTipTextAsync(workspaceId, moduleId, 2));
		await manager.RedoAsync(new WorkspaceRequest(workspaceId), Token);
		Assert.Equal("IMAGE_DOS_HEADER.e_cblp = 0x1234 (4660)", await ToolTipTextAsync(workspaceId, moduleId, 2));

		// A patch that breaks the DOS signature leaves the file no PE image, and so with no structures at all.
		transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), Token);
		await manager.QueueHexPatchAsync(new HexPatchRequest(workspaceId, transaction.TransactionId, moduleId, 0, Convert.ToBase64String("ZM"u8.ToArray())), Token);
		await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), Token);
		Assert.Null((await ToolTipAsync(workspaceId, moduleId, 2)).ToolTip);
		Assert.Null((await PositionAsync(workspaceId, moduleId, 2)).Rva);
	}

	async Task<string?> ToolTipTextAsync(string workspaceId, string moduleId, long position) =>
		(await ToolTipAsync(workspaceId, moduleId, position)).ToolTip is { } toolTip ? Text(toolTip.Sections[0]) : null;

	[Fact]
	public async Task AResourceElementShowsItsDataWhileItsSetIsReadFromTheFile() {
		var (workspaceId, moduleId, path) = await OpenCopyAsync();
		var root = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), Token)).Nodes);
		var moduleNode = Assert.Single(await ChildrenAsync(workspaceId, root.Id), node => node.Kind == "module");
		var resources = Assert.Single(await ChildrenAsync(workspaceId, moduleNode.Id), node => node.Kind == "resourcesgroup");
		var set = Assert.Single(await ChildrenAsync(workspaceId, resources.Id), node => node.Label == "SearchTarget.Strings.resources");
		var entry = Assert.Single(await ChildrenAsync(workspaceId, set.Id), node => node.Label == "Greeting Text");

		using var module = ModuleDefMD.Load(path);
		var embedded = (EmbeddedResource)module.Resources.Single(resource => resource.Name == "SearchTarget.Strings.resources");
		var element = ResourceReader.Read(module, embedded.CreateReader()).ResourceElements.Single(e => e.Name == "Greeting%20Text");
		var data = element.ResourceData;

		var target = await manager.ResolveHexTargetAsync(new HexTargetRequest(workspaceId, entry.Id), Token);
		Assert.Equal(new HexRangeDto((uint)data.StartOffset, (uint)data.EndOffset - (uint)data.StartOffset), target.Resource);
		var setReader = embedded.CreateReader();
		Assert.InRange(target.Resource!.Offset, (long)setReader.StartOffset, (long)setReader.StartOffset + setReader.Length - target.Resource.Length);
		// The data starts with the element's type code: a string.
		var bytes = Convert.FromBase64String((await manager.ReadHexAsync(new HexReadRequest(workspaceId, moduleId, target.Resource.Offset, 1), Token)).Base64Data);
		Assert.Equal((byte)ResourceTypeCode.String, bytes[0]);

		// An element added to the set rewrites it in memory, and the offsets of the file no longer name its elements.
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), Token);
		await manager.QueueCreateResourceElementAsync(
			new CreateResourceElementRequest(workspaceId, transaction.TransactionId, set.Id, ResourceElementKinds.String, "added", "value"), Token);
		await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), Token);
		var rewritten = Assert.Single(await ChildrenAsync(workspaceId, set.Id), node => node.Label == "Greeting Text");
		Assert.Null((await manager.ResolveHexTargetAsync(new HexTargetRequest(workspaceId, rewritten.Id), Token)).Resource);
		// Undo puts the file's resource back, and its elements' offsets with it.
		await manager.UndoAsync(new WorkspaceRequest(workspaceId), Token);
		Assert.Equal(target.Resource, (await manager.ResolveHexTargetAsync(new HexTargetRequest(workspaceId, entry.Id), Token)).Resource);
	}

	// The search data: "AB" at 2, 6 and 8; "AAAAA" at 16; "HeLLo" at 24, "hello" at 32; "Äb" at 40, "äB" at 44.
	static byte[] SearchData() {
		var data = new byte[64];
		data.AsSpan().Fill((byte)'.');
		"AB"u8.CopyTo(data.AsSpan(2));
		"AB"u8.CopyTo(data.AsSpan(6));
		"AB"u8.CopyTo(data.AsSpan(8));
		"AAAAA"u8.CopyTo(data.AsSpan(16));
		"HeLLo"u8.CopyTo(data.AsSpan(24));
		"hello"u8.CopyTo(data.AsSpan(32));
		"Äb"u8.CopyTo(data.AsSpan(40));
		"äB"u8.CopyTo(data.AsSpan(44));
		return data;
	}

	[Fact]
	public async Task AByteSearchFindsForwardThenWrapsToWhatLiesBeforeTheStart() {
		var (workspaceId, moduleId) = await OpenDataAsync(SearchData());
		var ab = "AB"u8.ToArray();
		Assert.Equal([6, 8, 2], await SearchAsync(workspaceId, moduleId, ab, start: 5, wrap: true));
		Assert.Equal([6, 8], await SearchAsync(workspaceId, moduleId, ab, start: 5, wrap: false));
		// A match straddling the start is not in the first block (it starts before it) but lies entirely before
		// start + length - 1, so the wrap finds it.
		Assert.Equal([8, 2, 6], await SearchAsync(workspaceId, moduleId, ab, start: 7, wrap: true));
		// Only the range is searched.
		Assert.Equal([6], await SearchAsync(workspaceId, moduleId, ab, start: 5, wrap: true, rangeStart: 4, rangeEnd: 8));
		Assert.Equal([6], await SearchAsync(workspaceId, moduleId, ab, start: 5, wrap: true, maxResults: 1));
	}

	[Fact]
	public async Task AMaskedByteSearchIgnoresTheMaskedBits() {
		var (workspaceId, moduleId) = await OpenDataAsync(SearchData());
		// "A?" — any byte after an 'A'.
		Assert.Equal([2, 6, 8, 16, 17, 18, 19, 20], await SearchAsync(workspaceId, moduleId, [(byte)'A', 0x12], mask: [0xFF, 0x00], start: 0, wrap: false));
		// The upper nibble of the second byte only: 'A' and 'B' are 0x41 and 0x42, so 0x4? matches both, and the '.'
		// after the last 'A' (0x2E) does not.
		Assert.Equal([2, 6, 8, 16, 17, 18, 19], await SearchAsync(workspaceId, moduleId, [(byte)'A', 0x40], mask: [0xFF, 0xF0], start: 0, wrap: false));
	}

	[Fact]
	public async Task AReverseSearchEndsAtTheStartThenWrapsFromTheEnd() {
		var (workspaceId, moduleId) = await OpenDataAsync(SearchData());
		var ab = "AB"u8.ToArray();
		// Start is the last byte a match may end on: the match at 6 ends exactly on 7.
		Assert.Equal([6, 2], await SearchAsync(workspaceId, moduleId, ab, start: 7, reverse: true, wrap: false));
		Assert.Equal([2], await SearchAsync(workspaceId, moduleId, ab, start: 6, reverse: true, wrap: false));
		// The wrap searches [start - (length - 1), end) from the end, which holds the match ending on the start once
		// more — dnSpy's FindAllCoreReverse does the same.
		Assert.Equal([6, 2, 8, 6], await SearchAsync(workspaceId, moduleId, ab, start: 7, reverse: true, wrap: true));
		Assert.Equal([2, 8, 6], await SearchAsync(workspaceId, moduleId, ab, start: 6, reverse: true, wrap: true));
		// Overlapping matches are all found going backwards too.
		Assert.Equal([19, 18, 17, 16], await SearchAsync(workspaceId, moduleId, "AA"u8.ToArray(), start: 63, reverse: true, wrap: false, rangeStart: 10, rangeEnd: 64));
	}

	[Fact]
	public async Task NoOverlapsSkipsAMatchThatOverlapsThePreviousOne() {
		var (workspaceId, moduleId) = await OpenDataAsync(SearchData());
		var aa = "AA"u8.ToArray();
		Assert.Equal([16, 17, 18, 19], await SearchAsync(workspaceId, moduleId, aa, start: 10, wrap: false));
		Assert.Equal([16, 18], await SearchAsync(workspaceId, moduleId, aa, start: 10, wrap: false, noOverlaps: true));
		Assert.Equal([19, 17], await SearchAsync(workspaceId, moduleId, aa, start: 20, reverse: true, wrap: false, noOverlaps: true));
		// With a wrap, the second block stops short of the first match of the first block.
		Assert.Equal([17, 19], await SearchAsync(workspaceId, moduleId, aa, start: 17, wrap: true, noOverlaps: true));
		Assert.Equal([17, 18, 19, 16], await SearchAsync(workspaceId, moduleId, aa, start: 17, wrap: true));
		Assert.Equal([17], await SearchAsync(workspaceId, moduleId, aa, start: 18, reverse: true, wrap: true, noOverlaps: true, rangeStart: 16, rangeEnd: 20));
	}

	[Fact]
	public async Task ACaseInsensitiveStringSearchMatchesEachCharacterInEitherCase() {
		var (workspaceId, moduleId) = await OpenDataAsync(SearchData());
		Assert.Equal([24, 32], await StringSearchAsync(workspaceId, moduleId, "hello", start: 0));
		Assert.Equal([32, 24], await StringSearchAsync(workspaceId, moduleId, "hello", start: 30));
		// 'ä' and 'Ä' are two bytes each in UTF-8; each character matches in either case on its own.
		Assert.Equal([40, 44], await StringSearchAsync(workspaceId, moduleId, "äb", start: 0));
		Assert.Equal([44, 40], await StringSearchAsync(workspaceId, moduleId, "äb", start: 63, reverse: true));
	}

	[Fact]
	public async Task ACharacterOfAStringSearchMatchesInOneCaseOrTheOtherNotAMixOfBoth() {
		// One two-byte character whose cases are 10 20 and 30 40: 30 40 is a match, 10 40 (half of each) is not.
		byte[] data = [0x10, 0x40, 0x00, 0x30, 0x40, 0x00];
		var (workspaceId, moduleId) = await OpenDataAsync(data);
		Assert.Equal([3], await RawStringSearchAsync(workspaceId, moduleId, [0x10, 0x20], [0x30, 0x40], [2], data.Length));
		// As two one-byte characters, each byte matches on its own.
		Assert.Equal([0, 3], await RawStringSearchAsync(workspaceId, moduleId, [0x10, 0x20], [0x30, 0x40], [1, 1], data.Length));
	}

	[Fact]
	public async Task ASearchSeesTheHexPatches() {
		var (workspaceId, moduleId) = await OpenDataAsync(SearchData());
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), Token);
		await manager.QueueHexPatchAsync(new HexPatchRequest(workspaceId, transaction.TransactionId, moduleId, 50, Convert.ToBase64String("AB"u8.ToArray())), Token);
		await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), Token);
		Assert.Equal([50, 2], await SearchAsync(workspaceId, moduleId, "AB"u8.ToArray(), start: 10, wrap: true, maxResults: 2));
	}

	async Task<IReadOnlyList<long>> SearchAsync(string workspaceId, string moduleId, byte[] pattern, long start, bool wrap = false, bool reverse = false,
		bool noOverlaps = false, byte[]? mask = null, long rangeStart = 0, long rangeEnd = 64, int maxResults = 100) =>
		(await manager.SearchHexAsync(new HexSearchRequest(workspaceId, moduleId, Convert.ToBase64String(pattern), mask is null ? null : Convert.ToBase64String(mask), null, null,
			rangeStart, rangeEnd, start, reverse, wrap, noOverlaps, maxResults), Token)).Offsets;

	/// <summary>Utf8StringHexSearchService's pattern: the lower- and upper-case encodings and each character's byte count.</summary>
	Task<IReadOnlyList<long>> StringSearchAsync(string workspaceId, string moduleId, string text, long start, bool reverse = false) =>
		RawStringSearchAsync(workspaceId, moduleId, Encoding.UTF8.GetBytes(text.ToLowerInvariant()), Encoding.UTF8.GetBytes(text.ToUpperInvariant()),
			text.Select(ch => Encoding.UTF8.GetByteCount(ch.ToString())).ToArray(), 64, start, reverse);

	async Task<IReadOnlyList<long>> RawStringSearchAsync(string workspaceId, string moduleId, byte[] lower, byte[] upper, int[] charLengths, long rangeEnd, long start = 0, bool reverse = false) =>
		(await manager.SearchHexAsync(new HexSearchRequest(workspaceId, moduleId, Convert.ToBase64String(lower), null, Convert.ToBase64String(upper), charLengths,
			0, rangeEnd, start, reverse, true, false, 100), Token)).Offsets;

	async Task<HexToolTipInfoResponse> ToolTipAsync(string workspaceId, string moduleId, long position) =>
		await manager.GetHexToolTipInfoAsync(new HexToolTipInfoRequest(workspaceId, moduleId, position), Token);

	async Task<HexPositionInfoResponse> PositionAsync(string workspaceId, string moduleId, long position) =>
		await manager.GetHexPositionInfoAsync(new HexPositionInfoRequest(workspaceId, moduleId, position), Token);

	async Task<IReadOnlyList<TreeNodeDto>> ChildrenAsync(string workspaceId, string nodeId) =>
		(await manager.GetChildrenAsync(new NodeRequest(workspaceId, nodeId), Token)).Nodes;

	static string Text(IEnumerable<TextPartDto> parts) => string.Concat(parts.Select(part => part.Text));

	static long Offset(dnlib.IO.FileOffset offset) => (long)(uint)offset;

	async Task<(string WorkspaceId, string ModuleId, string Path)> OpenCopyAsync() {
		var copy = Path.Combine(Path.GetTempPath(), $"hexstructure-{Guid.NewGuid():N}.dll");
		files.Add(copy);
		File.Copy(typeof(SearchTarget.Library).Assembly.Location, copy);
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([copy]), Token);
		return (opened.WorkspaceId, Assert.Single(opened.Modules).Id, copy);
	}

	async Task<(string WorkspaceId, string ModuleId)> OpenDataAsync(byte[] data) {
		var path = Path.Combine(Path.GetTempPath(), $"hexsearch-{Guid.NewGuid():N}.bin");
		files.Add(path);
		await File.WriteAllBytesAsync(path, data, Token);
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), Token);
		return (opened.WorkspaceId, Assert.Single(opened.Modules).Id);
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
