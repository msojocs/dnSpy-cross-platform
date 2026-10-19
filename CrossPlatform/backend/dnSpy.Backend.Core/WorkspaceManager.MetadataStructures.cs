using System.Globalization;
using System.Text;
using dnSpy.Backend.Contracts;
using dnlib.DotNet;
using dnlib.DotNet.MD;

namespace dnSpy.Backend.Core;

/// <summary>
/// dnSpy's AsmEditor hex nodes as a form and a grid: the fields of every PE header and of the tables stream header,
/// the rows of every metadata table, the Sort, Go to MD Table Row and Copy as Text commands. The nodes under the
/// tables stream — the stream itself, a node per table that has rows and a node per row — are built here; the PE
/// headers above them are the PE structure nodes. Nothing here writes: an edit in the form or the grid is a byte
/// patch the client sends through edit/hexPatch, and every value read here goes through the document's patches.
/// </summary>
public sealed partial class WorkspaceManager {
	public Task<HexStructureDto> GetHexStructureAsync(HexStructureRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetHexStructure(request.NodeId), cancellationToken);

	public Task<MetadataTableDto> GetMetadataTableAsync(MetadataTableRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetMetadataTable(request.NodeId), cancellationToken);

	public Task<MetadataTableRowsResponse> GetMetadataTableRowsAsync(MetadataTableRowsRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetMetadataTableRows(request), cancellationToken);

	public Task<MetadataSortResponse> SortMetadataTableAsync(MetadataSortRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.SortMetadataTable(request), cancellationToken);

	public Task<MetadataFindRecordResponse> FindMetadataRecordAsync(MetadataFindRecordRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.FindMetadataRecord(request.NodeId, request.Token), cancellationToken);

	public Task<MetadataTableTextResponse> GetMetadataTableTextAsync(MetadataTableTextRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetMetadataTableText(request), cancellationToken);

	sealed partial class Workspace {
		/// <summary>The tables stream node under the storage stream that holds the tables (TablesStreamNode).</summary>
		sealed record TablesStreamValue(NodeEntry StorageStream);

		/// <summary>A metadata table node (MetadataTableNode), under the tables stream node.</summary>
		sealed record MetadataTableValue(NodeEntry TablesStream, Table Table);

		/// <summary>One row of a metadata table (MetadataTableRecordNode), under its table's node.</summary>
		sealed record MetadataRecordValue(NodeEntry Table, Table TableKind, uint Rid);

		/// <summary>
		/// The reader a call that reads many rows shares — a table node's children label every row with a name out of
		/// the #Strings heap — so the file is read once for all of them rather than once per row.
		/// </summary>
		PatchedFileReader? sharedReader;

		/// <summary>Reads through the shared reader when one is open for the document, through one of its own otherwise.</summary>
		T ReadPatched<T>(IModuleEntry entry, Func<PatchedFileReader, T> read) {
			if (sharedReader is { } shared && ReferenceEquals(shared.Entry, entry))
				return read(shared);
			using var reader = new PatchedFileReader(entry);
			return read(reader);
		}

		/// <summary>Opens the shared reader for the length of a call; the reader that was open before comes back after it.</summary>
		IDisposable ShareReader(IModuleEntry entry) {
			var previous = sharedReader;
			var reader = new PatchedFileReader(entry);
			sharedReader = reader;
			return new SharedReaderScope(() => {
				reader.Dispose();
				sharedReader = previous;
			});
		}

		sealed class SharedReaderScope(Action close) : IDisposable {
			public void Dispose() => close();
		}

		/// <summary>The metadata a node of a managed module reads its tables from, or null for any other document.</summary>
		static Metadata? MetadataOf(NodeEntry node) => node.AsModuleEntry?.Module.Metadata;

		/// <summary>Whether a PE structure node is the header of the stream that holds the tables — the storage stream
		/// dnSpy hangs the tables stream node off (TablesStorageStreamNode).</summary>
		static bool IsTablesStorageStream(NodeEntry node) =>
			node.Value is PeStructureValue { Kind: PeStructureKind.StorageStream, Index: var index }
				&& MetadataOf(node) is { TablesStream: { } tables } metadata
				&& index >= 0 && index < metadata.AllStreams.Count
				&& ReferenceEquals(metadata.AllStreams[index], tables);

		IReadOnlyList<NodeEntry> GetPeStructureChildren(NodeEntry node) =>
			IsTablesStorageStream(node) ? [TablesStreamNode(node)] : Array.Empty<NodeEntry>();

		NodeEntry TablesStreamNode(NodeEntry storageStream) =>
			GetOrAddNode($"{storageStream.Key}:tablesstream", NodeKind.TablesStream, new TablesStreamValue(storageStream), storageStream.Module);

		/// <summary>A node per table that has rows, in table order — the tables dnSpy's PEStructureProvider makes a view model for.</summary>
		IReadOnlyList<NodeEntry> GetTablesStreamChildren(NodeEntry node) {
			if (MetadataOf(node)?.TablesStream is not { } tables)
				return Array.Empty<NodeEntry>();
			return tables.MDTables
				.Where(table => table.Rows != 0)
				.Select(table => MetadataTableNode(node, table.Table))
				.ToArray();
		}

		NodeEntry MetadataTableNode(NodeEntry tablesStream, Table table) =>
			GetOrAddNode($"{tablesStream.Key}:table:{(byte)table:X2}", NodeKind.MetadataTable, new MetadataTableValue(tablesStream, table), tablesStream.Module);

		/// <summary>A node per row. A table can hold tens of thousands of them, so they are only made when the table is
		/// opened, and their labels share one read of the file.</summary>
		IReadOnlyList<NodeEntry> GetMetadataTableChildren(NodeEntry node) {
			if (GetMdTable(node) is not { } table)
				return Array.Empty<NodeEntry>();
			var rows = new NodeEntry[table.Rows];
			for (uint rid = 1; rid <= table.Rows; rid++)
				rows[rid - 1] = MetadataRecordNode(node, table.Table, rid);
			return rows;
		}

		NodeEntry MetadataRecordNode(NodeEntry tableNode, Table table, uint rid) =>
			GetOrAddNode($"{tableNode.Key}:{rid.ToString(CultureInfo.InvariantCulture)}", NodeKind.MetadataRecord, new MetadataRecordValue(tableNode, table, rid), tableNode.Module);

		/// <summary>The table a table or row node stands for, as dnlib laid it out.</summary>
		static MDTable? GetMdTable(NodeEntry node) {
			var table = node.Value switch {
				MetadataTableValue value => value.Table,
				MetadataRecordValue value => value.TableKind,
				_ => (Table?)null,
			};
			return table is { } kind && MetadataOf(node)?.TablesStream?.Get(kind) is { } mdTable ? mdTable : null;
		}

		bool HasMetadataChildren(NodeEntry node) => node.Kind switch {
			NodeKind.PeStructure => IsTablesStorageStream(node),
			NodeKind.TablesStream => MetadataOf(node)?.TablesStream?.MDTables.Any(table => table.Rows != 0) == true,
			NodeKind.MetadataTable => GetMdTable(node) is { Rows: > 0 },
			_ => false,
		};

		string GetMetadataNodeLabel(NodeEntry node) {
			switch (node.Kind) {
			case NodeKind.TablesStream:
				return "Tables Stream";
			case NodeKind.MetadataTable:
				return GetMdTable(node) is { } table ? MetadataTablesReader.TableLabel(table) : node.Kind.ToString();
			default:
				var record = (MetadataRecordValue)node.Value;
				var ridText = record.Rid.ToString(CultureInfo.InvariantCulture);
				if (GetMdTable(node) is not { } mdTable || MetadataOf(node) is not { } metadata)
					return ridText;
				try {
					return ReadPatched(node.AsModuleEntry!, reader => new MetadataTablesReader(metadata, reader).RecordLabel(mdTable, record.Rid));
				}
				catch (RpcException) {
					// A file that can no longer be read still has its rows; they are only missing their names.
					return ridText;
				}
			}
		}

		/// <summary>
		/// The file range a hex structure node stands for — dnSpy's HexNode.Span — and the data "Show Data in Hex Editor"
		/// opens for it. Null for a node that is no hex structure; the PE node itself is not one in dnSpy either.
		/// </summary>
		(HexRangeDto? Structure, HexRangeDto? Data) GetHexStructureRanges(NodeEntry node) {
			switch (node.Kind) {
			case NodeKind.PeStructure when GetPeStructureSource((IModuleEntry)node.Module) is { } source:
				var value = (PeStructureValue)node.Value;
				return (Range(PeHexStructures.Span(source, value.Kind, value.Index)), Range(PeHexStructures.DataSpan(source, value.Kind, value.Index)));
			case NodeKind.TablesStream when MetadataOf(node)?.TablesStream is { } tables:
				return (Range(MetadataTablesReader.HeaderSpan(tables)), null);
			case NodeKind.MetadataTable when GetMdTable(node) is { } table:
				return (new HexRangeDto(MetadataTablesReader.Offset(table.StartOffset), (long)table.Rows * table.RowSize), null);
			case NodeKind.MetadataRecord when GetMdTable(node) is { } table:
				var rid = ((MetadataRecordValue)node.Value).Rid;
				return (new HexRangeDto(MetadataTablesReader.RowOffset(table, rid), table.RowSize), null);
			default:
				return (null, null);
			}
		}

		static HexRangeDto? Range((long Offset, long Length)? span) => span is { } value ? new HexRangeDto(value.Offset, value.Length) : null;

		/// <summary>
		/// The fields of a PE structure, of the tables stream header or of one row — the form dnSpy shows for the node.
		/// Any other node has none.
		/// </summary>
		public HexStructureDto GetHexStructure(string nodeId) {
			var node = GetNode(nodeId);
			var entry = node.Module as IModuleEntry ?? throw new RpcException(ErrorCodes.NodeNotFound, "The selected tree node no longer exists.");
			switch (node.Kind) {
			case NodeKind.PeStructure when GetPeStructureSource(entry) is { } source:
				var value = (PeStructureValue)node.Value;
				return ReadPatched(entry, reader => PeHexStructures.Read(node.Id, source, value.Kind, value.Index, reader))
					?? throw new RpcException(ErrorCodes.UnsupportedDocument, "The image has no such structure.");
			case NodeKind.TablesStream when MetadataOf(node) is { TablesStream: not null } metadata:
				return ReadPatched(entry, reader => new MetadataTablesReader(metadata, reader).TablesHeader(node.Id));
			case NodeKind.MetadataRecord when GetMdTable(node) is { } table && MetadataOf(node) is { } metadata:
				var rid = ((MetadataRecordValue)node.Value).Rid;
				return ReadPatched(entry, reader => new MetadataTablesReader(metadata, reader).Record(node.Id, table, rid));
			default:
				throw new RpcException(ErrorCodes.UnsupportedDocument, "The selected tree node is not a PE or metadata structure.");
			}
		}

		/// <summary>The table node a table or row node names, with its table.</summary>
		(NodeEntry Node, MDTable Table, Metadata Metadata) GetTableNode(string nodeId) {
			var node = GetNode(nodeId);
			if (node.Value is MetadataRecordValue record)
				node = record.Table;
			if (node.Kind != NodeKind.MetadataTable || GetMdTable(node) is not { } table || MetadataOf(node) is not { } metadata)
				throw new RpcException(ErrorCodes.UnsupportedDocument, "The selected tree node is not a metadata table.");
			return (node, table, metadata);
		}

		public MetadataTableDto GetMetadataTable(string nodeId) {
			var (node, table, _) = GetTableNode(nodeId);
			return new MetadataTableDto(
				node.Id,
				(int)table.Table,
				MetadataTablesReader.TableName(table.Table),
				table.Rows,
				(int)table.RowSize,
				MetadataTablesReader.Offset(table.StartOffset),
				table.Columns.Select(column => new MetadataColumnDto(column.Name, column.Offset, column.Size)).ToArray(),
				MetadataTablesReader.HasInfo(table.Table),
				MetadataTableSorter.CanSort(table.Table));
		}

		/// <summary>A run of rows for the table's grid, clamped to the rows the table has.</summary>
		public MetadataTableRowsResponse GetMetadataTableRows(MetadataTableRowsRequest request) {
			var (node, table, metadata) = GetTableNode(request.NodeId);
			var first = Math.Max(1u, request.StartRid);
			if (request.Count <= 0 || first > table.Rows)
				return new MetadataTableRowsResponse(Array.Empty<MetadataRowDto>());
			var last = (uint)Math.Min(table.Rows, first + (ulong)request.Count - 1);
			var hasInfo = MetadataTablesReader.HasInfo(table.Table);
			return ReadPatched(node.AsModuleEntry!, reader => {
				var tables = new MetadataTablesReader(metadata, reader);
				var rows = new List<MetadataRowDto>((int)(last - first + 1));
				for (var rid = first; rid <= last; rid++) {
					var values = table.Columns.Select(column => (ulong)tables.ReadColumn(table, rid, column)).ToArray();
					rows.Add(new MetadataRowDto(
						rid,
						MetadataTablesReader.Token(table.Table, rid),
						MetadataTablesReader.RowOffset(table, rid),
						values,
						hasInfo ? tables.Info(table, rid) : null));
				}
				return new MetadataTableRowsResponse(rows);
			});
		}

		/// <summary>
		/// dnSpy's Sort and Sort Selection (SortMDTableCommand.SortTable): the rows read through the patches, sorted the
		/// way TableSorter sorts them. The client writes the bytes back as one patch, so the sort is one undo step.
		/// </summary>
		public MetadataSortResponse SortMetadataTable(MetadataSortRequest request) {
			var (node, table, _) = GetTableNode(request.NodeId);
			if (!MetadataTableSorter.CanSort(table.Table))
				throw new RpcException(ErrorCodes.EditValidationFailed, $"The {table.Table} table cannot be sorted.");
			if (request.Rid == 0 || request.Count == 0 || request.Rid - 1 + (ulong)request.Count > table.Rows)
				throw new RpcException(ErrorCodes.InvalidParams, "The rows to sort are not all in the table.");
			var offset = MetadataTablesReader.RowOffset(table, request.Rid);
			var data = ReadPatched(node.AsModuleEntry!, reader => reader.ReadBytes(offset, checked((int)(request.Count * (ulong)table.RowSize))));
			MetadataTableSorter.Sort(table, data);
			return new MetadataSortResponse(offset, Convert.ToBase64String(data));
		}

		/// <summary>dnSpy's Copy as Text over rows of a table: the header line, then a line per row that is in the table.</summary>
		public MetadataTableTextResponse GetMetadataTableText(MetadataTableTextRequest request) {
			var (node, table, metadata) = GetTableNode(request.NodeId);
			var text = ReadPatched(node.AsModuleEntry!, reader => {
				var tables = new MetadataTablesReader(metadata, reader);
				var builder = new StringBuilder();
				builder.AppendLine(MetadataTablesReader.TextHeader(table));
				foreach (var rid in request.Rids) {
					if (rid != 0 && rid <= table.Rows)
						builder.AppendLine(tables.TextRow(table, rid));
				}
				return builder.ToString();
			});
			return new MetadataTableTextResponse(text);
		}

		/// <summary>
		/// dnSpy's Go to MD Table Row (GoToMDTableRowUIHexEditorCommand): a token is valid when it resolves to a member
		/// of the module or names a row of its tables (AskForDef), and it is found when the module has the hex nodes the
		/// row hangs off — a module that has never been saved has no PE node, so nothing in it can be found. The nodes
		/// from the PE node down to the row are made on the way, so the client can expand them in turn.
		/// </summary>
		public MetadataFindRecordResponse FindMetadataRecord(string nodeId, uint token) {
			var node = GetNode(nodeId);
			var module = ModuleOf(node)
				?? throw new RpcException(ErrorCodes.UnsupportedDocument, "Only a .NET module has metadata tables.");
			var mdToken = new MDToken(token);
			var tables = module.Module.Metadata?.TablesStream;
			if (module.Module.ResolveToken(token) is null && tables?.Get(mdToken.Table)?.IsValidRID(mdToken.Rid) != true)
				return new MetadataFindRecordResponse(null, Array.Empty<string>(), string.Format(CultureInfo.InvariantCulture, "Invalid metadata token: 0x{0:X8}", token));
			var notFound = new MetadataFindRecordResponse(null, Array.Empty<string>(), string.Format(CultureInfo.InvariantCulture, "Token {0:X8} doesn't exist in the metadata", token));
			if (FindTablesStreamNode(module) is not { } tablesStreamNode || tables?.Get(mdToken.Table) is not { Rows: > 0 } table || mdToken.Rid == 0 || mdToken.Rid > table.Rows)
				return notFound;
			var tableNode = MetadataTableNode(tablesStreamNode, table.Table);
			var record = MetadataRecordNode(tableNode, table.Table, mdToken.Rid);
			var path = GetMetadataNodePath(tableNode);
			return new MetadataFindRecordResponse(record.Id, path.Select(entry => entry.Id).ToArray(), null);
		}

		/// <summary>The tables stream node of a module opened from a file, reached the way the tree reaches it — through its
		/// module node's PE node and the storage stream that holds the tables.</summary>
		NodeEntry? FindTablesStreamNode(ModuleEntry module) {
			if (module.InMemory || module.Module.Metadata is not { PEImage: not null, TablesStream: { } tables } metadata)
				return null;
			var moduleNode = GetOrAddNode($"module:{module.Path}", NodeKind.Module, module.Module, module);
			var peNode = GetOrAddNode($"{moduleNode.Key}:pe", NodeKind.PE, metadata.PEImage, module);
			var index = metadata.AllStreams.IndexOf(tables);
			if (index < 0)
				return null;
			var storageStream = PeStructureNode(peNode, new PeStructureValue(PeStructureKind.StorageStream, index));
			return TablesStreamNode(storageStream);
		}

		/// <summary>
		/// The chain from the document's root down to a node under the tables stream: the chain to the PE node, the
		/// storage stream header, the tables stream, the table and the row. Each node names the one above it, so the
		/// chain is there for a node the client was handed without listing its parents. Empty when the PE node has no
		/// chain of its own.
		/// </summary>
		IReadOnlyList<NodeEntry> GetMetadataNodePath(NodeEntry node) {
			var below = new List<NodeEntry>();
			var current = node;
			while (true) {
				below.Insert(0, current);
				if (current.Value is MetadataRecordValue record)
					current = record.Table;
				else if (current.Value is MetadataTableValue table)
					current = table.TablesStream;
				else if (current.Value is TablesStreamValue stream)
					current = stream.StorageStream;
				else
					break;
			}
			// The storage stream node's key is its PE node's key and the structure it stands for.
			var storageStream = below[0];
			var cut = storageStream.Key.LastIndexOf(":storagestream:", StringComparison.Ordinal);
			if (cut < 0 || !nodeIdsByKey.TryGetValue(storageStream.Key[..cut], out var peId))
				return [];
			var above = GetNodePathCore(nodes[peId]);
			return above.Count == 0 ? [] : [.. above, .. below];
		}

		/// <summary>
		/// What a tables stream, table or row node decompiles to — dnSpy's HexNode.Decompile, the same comment lines in
		/// whatever language: the range the node covers and its label, then its fields one per line ("offset range,
		/// value, name"). A table writes the Copy as Text lines of all its rows instead (MetadataTableNode.DecompileFields).
		/// </summary>
		DecompileResponse DecompileMetadataStructure(NodeEntry node, DecompilerLanguage language) {
			var comment = language == DecompilerLanguage.VisualBasic ? "'" : "//";
			var builder = new StringBuilder();
			void Line(string text) => builder.Append(comment).Append(text.Length == 0 ? string.Empty : " " + text).Append('\n');
			var (structure, _) = GetHexStructureRanges(node);
			if (structure is not null)
				Line($"{structure.Offset:X8} - {structure.Offset + structure.Length - 1:X8} {GetLabel(node)}");
			if (node.Kind == NodeKind.MetadataTable) {
				var (_, table, metadata) = GetTableNode(node.Id);
				Line(string.Empty);
				ReadPatched(node.AsModuleEntry!, reader => {
					var tables = new MetadataTablesReader(metadata, reader);
					Line(MetadataTablesReader.TextHeader(table));
					for (uint rid = 1; rid <= table.Rows; rid++)
						Line(tables.TextRow(table, rid));
					return 0;
				});
			}
			else {
				var hex = GetHexStructure(node.Id);
				Line(string.Empty);
				Line($"{hex.Name}:");
				foreach (var field in hex.Fields)
					Line($"{field.Offset:X8} - {field.Offset + field.Size - 1:X8} {HexText.Fixed(field)} = {field.Name}");
			}
			var languageName = language switch {
				DecompilerLanguage.VisualBasic => "visual-basic",
				DecompilerLanguage.IL or DecompilerLanguage.ILWithCSharp => "il",
				_ => "csharp",
			};
			return new DecompileResponse(GetLabel(node), languageName, builder.ToString(), Array.Empty<TextSpanDto>(), Array.Empty<DiagnosticDto>());
		}
	}
}
