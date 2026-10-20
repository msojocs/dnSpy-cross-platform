using System.Globalization;
using System.Runtime.CompilerServices;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.HexFiles;
using dnSpy.Backend.Core.HexFiles.DnSpy;
using dnSpy.Backend.Core.HexFiles.PE;
using dnSpy.Backend.Core.HexFiles.ToolTips;
using dnlib.DotNet;
using dnlib.DotNet.MD;

namespace dnSpy.Backend.Core;

/// <summary>
/// The hex view's structure services — dnSpy's dnSpy.Hex.Files model (<see cref="HexStructureModel"/>) over a hex
/// document's patched bytes: the tooltip and the highlighted fields of a position (DefaultHexStructureInfoProvider
/// behind HexToolTipStructureSpanTagger), what the context menu commands select, copy and follow, and the hex search
/// services' FindAll.
/// </summary>
public sealed partial class WorkspaceManager {
	public Task<HexToolTipInfoResponse> GetHexToolTipInfoAsync(HexToolTipInfoRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetHexToolTipInfo(request), cancellationToken);

	public Task<HexPositionInfoResponse> GetHexPositionInfoAsync(HexPositionInfoRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetHexPositionInfo(request), cancellationToken);

	public Task<HexSearchResponse> SearchHexAsync(HexSearchRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.SearchHexAsync(request, cancellationToken), cancellationToken);

	sealed partial class Workspace {
		/// <summary>
		/// The model of each hex document, built the first time a position of it is asked about and kept while its bytes
		/// stay what they were. In dnSpy the model listens to its buffer's edits; here the bytes are the file and the
		/// patches over it, so the model is rebuilt whenever either may have changed: a patch added, undone or redone
		/// (the patch lists), a save that rewrote or patched the file (its length and time stamp, the base list), a
		/// Save As (its path). A document that is closed or reloaded is a new entry, and its old model goes with the
		/// old entry.
		/// </summary>
		readonly ConditionalWeakTable<IModuleEntry, CachedHexStructureModel> hexStructureModels = new();

		sealed record CachedHexStructureModel(HexModelVersion Version, HexStructureModel Model);

		/// <summary>Everything the bytes a model was built from depend on.</summary>
		sealed record HexModelVersion(string Path, long FileLength, DateTime LastWriteTimeUtc, HexPatch[] Patches, HexPatch[] Base) {
			public bool IsSameAs(HexModelVersion other) =>
				Path == other.Path && FileLength == other.FileLength && LastWriteTimeUtc == other.LastWriteTimeUtc &&
				Patches.AsSpan().SequenceEqual(other.Patches) && Base.AsSpan().SequenceEqual(other.Base);

			public static HexModelVersion Of(IModuleEntry entry) {
				DateTime lastWrite;
				try {
					lastWrite = File.GetLastWriteTimeUtc(entry.Path);
				}
				catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) {
					lastWrite = default;
				}
				return new HexModelVersion(entry.Path, entry.FileLength, lastWrite, [.. entry.HexPatches], [.. entry.HexBase]);
			}
		}

		HexStructureModel GetHexStructureModel(IModuleEntry entry) {
			var version = HexModelVersion.Of(entry);
			if (hexStructureModels.TryGetValue(entry, out var cached) && cached.Version.IsSameAs(version))
				return cached.Model;
			// AsmEditor's provider only answers for a document that has a PE tree to find a node in.
			var model = new HexStructureModel(entry, GetPeStructureSource(entry) is not null ? position => FindPeField(entry, position) : null);
			hexStructureModels.AddOrUpdate(entry, new CachedHexStructureModel(version, model));
			return model;
		}

		/// <summary>
		/// Runs a question against a document's model. dnSpy's readers assert on a malformed file and carry on, and a
		/// file broken in a way they did not foresee can still make one throw; the hex view then shows no structure
		/// there rather than failing the request, which is what a position outside every structure gets anyway.
		/// </summary>
		static T AskModel<T>(Func<T> ask, T fallback) {
			try {
				return ask();
			}
			catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or IndexOutOfRangeException or OverflowException or NullReferenceException or InvalidCastException or KeyNotFoundException) {
				return fallback;
			}
		}

		public HexToolTipInfoResponse GetHexToolTipInfo(HexToolTipInfoRequest request) {
			var entry = GetHexEntry(request.ModuleId);
			var empty = new HexToolTipInfoResponse(Array.Empty<HexStructureFieldSpanDto>(), null);
			if (request.Position < 0 || request.Position >= entry.FileLength)
				return empty;
			var model = GetHexStructureModel(entry);
			var position = new HexPosition((ulong)request.Position);
			return AskModel(() => {
				// HexToolTipStructureSpanTagger: every field the structure info provider yields is highlighted, and the
				// tooltip is the one of the current field.
				var fields = new List<HexStructureFieldSpanDto>();
				object? toolTip = null;
				foreach (var field in model.StructureInfoProvider.GetFields(position)) {
					var span = field.BufferSpan.Span;
					fields.Add(new HexStructureFieldSpanDto((long)span.Start.ToUInt64(), (long)span.Length.ToUInt64(), FieldKind(field.Kind)));
					if (field.IsCurrentField)
						toolTip = model.StructureInfoProvider.GetToolTip(position);
				}
				return new HexToolTipInfoResponse(fields, toolTip is HexToolTipContent content ? ToToolTipDto(content) : null);
			}, empty);
		}

		static string FieldKind(HexStructureFieldKind kind) => kind switch {
			HexStructureFieldKind.CurrentField => "currentField",
			HexStructureFieldKind.SubStructure => "subStructure",
			HexStructureFieldKind.Structure => "structure",
			HexStructureFieldKind.Field => "field",
			_ => "other",
		};

		/// <summary>
		/// What dnSpy's ToolTipObjectFactoryImpl draws, as data: the image, and each writer's text in the colors its
		/// GetColor gives the classified text tags. An empty section after the first is left out, as the WPF tooltip
		/// leaves it out; parts of one color next to each other are joined.
		/// </summary>
		static HexToolTipDto ToToolTipDto(HexToolTipContent content) {
			var sections = new List<IReadOnlyList<TextPartDto>>(content.Text.Length);
			for (var i = 0; i < content.Text.Length; i++) {
				var text = content.Text[i];
				if (i > 0 && text.Count == 0)
					continue;
				var parts = new List<TextPartDto>(text.Count);
				foreach (var part in text) {
					if (part.Text.Length == 0)
						continue;
					var color = ToolTipColor(part.Tag);
					if (parts.Count > 0 && parts[^1].Color == color)
						parts[^1] = parts[^1] with { Text = parts[^1].Text + part.Text };
					else
						parts.Add(new TextPartDto(part.Text, color));
				}
				sections.Add(parts);
			}
			return new HexToolTipDto((content.Image as ImageReference?)?.Name, sections);
		}

		/// <summary>ToolTipObjectFactoryImpl.GetColor, onto the protocol's color classes.</summary>
		static string ToolTipColor(string tag) => tag switch {
			PredefinedClassifiedTextTags.Text => TextColors.Text,
			PredefinedClassifiedTextTags.Error => TextColors.Error,
			PredefinedClassifiedTextTags.Keyword => TextColors.Keyword,
			PredefinedClassifiedTextTags.Number => TextColors.Number,
			PredefinedClassifiedTextTags.String => TextColors.String,
			PredefinedClassifiedTextTags.Char => TextColors.Char,
			PredefinedClassifiedTextTags.Operator => TextColors.Operator,
			PredefinedClassifiedTextTags.Punctuation => TextColors.Punctuation,
			PredefinedClassifiedTextTags.ArrayName => TextColors.Type,
			PredefinedClassifiedTextTags.StructureName => TextColors.ValueType,
			PredefinedClassifiedTextTags.ValueType => TextColors.ValueType,
			PredefinedClassifiedTextTags.Enum => TextColors.Enum,
			PredefinedClassifiedTextTags.EnumField => TextColors.EnumField,
			PredefinedClassifiedTextTags.Field => TextColors.InstanceField,
			PredefinedClassifiedTextTags.PathName => TextColors.DirectoryPart,
			PredefinedClassifiedTextTags.PathSeparator => TextColors.Text,
			PredefinedClassifiedTextTags.Filename => TextColors.FileNameNoExtension,
			PredefinedClassifiedTextTags.FileDot => TextColors.Text,
			PredefinedClassifiedTextTags.FileExtension => TextColors.FileExtension,
			PredefinedClassifiedTextTags.DotNetHeapName => TextColors.HexTableName,
			_ => TextColors.Text,
		};

		public HexPositionInfoResponse GetHexPositionInfo(HexPositionInfoRequest request) {
			var entry = GetHexEntry(request.ModuleId);
			var empty = new HexPositionInfoResponse(null, null, null, null, null, request.Position, null, null);
			if (request.Position < 0 || request.Position >= entry.FileLength)
				return empty;
			var model = GetHexStructureModel(entry);
			var position = new HexPosition((ulong)request.Position);
			var fileService = model.FileService;
			return AskModel(() => {
				// HexEditorOperationsImpl.SelectFile/SelectNestedFile/SelectStructure.
				var file = fileService.GetFile(position, checkNestedFiles: false);
				var nestedFile = fileService.GetFile(position, checkNestedFiles: true);
				var info = fileService.GetFileAndStructure(position);
				// CopyRVA and CopyFileOffset ask the top-level file for its PE headers.
				var peHeaders = file?.GetHeaders<PeHeaders>();
				long? rva = peHeaders is null ? null : peHeaders.BufferPositionToRva(position);
				long fileOffset = peHeaders is not null ? (long)peHeaders.BufferPositionToFilePosition(position)
					: file is not null ? (long)(position - file.Span.Start).ToUInt64()
					: request.Position;
				return new HexPositionInfoResponse(
					Range(file?.Span),
					Range(nestedFile?.Span),
					Range(info?.Structure.Span.Span),
					info is { } found ? GetEditField(found.Structure, position) : null,
					rva,
					fileOffset,
					Range(model.InfoService.GetFieldReferenceSpan(position)),
					ConvertHexReference(entry, model.StructureInfoProvider.GetReference(position)));
			}, empty);
		}

		static HexRangeDto? Range(HexSpan? span) =>
			span is { } value ? new HexRangeDto((long)value.Start.ToUInt64(), (long)value.Length.ToUInt64()) : null;

		/// <summary>
		/// EditFieldCommand: only a flags or an enum field has the submenu. A flags field lists every flag but the names
		/// of its enum-like parts, each a toggle unless its mask is one of those parts; an enum field lists its values.
		/// </summary>
		static HexEditFieldDto? GetEditField(ComplexData structure, HexPosition position) {
			if (structure.GetSimpleField(position)?.Data is not SimpleData field || field is not (FlagsData or EnumData))
				return null;
			var span = field.Span;
			var size = (int)span.Length.ToUInt64();
			var buffer = span.Buffer;
			var start = span.Span.Start;
			ulong value = size switch {
				1 => buffer.ReadByte(start),
				2 => buffer.ReadUInt16(start),
				4 => buffer.ReadUInt32(start),
				8 => buffer.ReadUInt64(start),
				_ => 0,
			};
			if (size is not (1 or 2 or 4 or 8))
				return null;
			var items = new List<HexEditFieldItemDto>();
			string kind;
			if (field is FlagsData flags) {
				kind = "flags";
				var enumMasks = new HashSet<ulong>();
				foreach (var info in flags.FlagInfos) {
					if (info.IsEnumName)
						enumMasks.Add(info.Mask);
				}
				foreach (var info in flags.FlagInfos) {
					if (info.IsEnumName)
						continue;
					items.Add(new HexEditFieldItemDto(info.Name, Decimal(info.Mask), Decimal(info.Value), !enumMasks.Contains(info.Mask)));
				}
			}
			else {
				kind = "enum";
				var allBits = size == 8 ? ulong.MaxValue : (1UL << (size * 8)) - 1;
				foreach (var info in ((EnumData)field).EnumFieldInfos)
					items.Add(new HexEditFieldItemDto(info.Name, Decimal(allBits), Decimal(info.Value), false));
			}
			return new HexEditFieldDto((long)start.ToUInt64(), size, Decimal(value), kind, items);
		}

		static string Decimal(ulong value) => value.ToString(CultureInfo.InvariantCulture);

		/// <summary>
		/// What dnSpy's HexReferenceConverters make of the reference F12 follows (HexStructureInfoAggregator.GetReferences
		/// asks the one structure info provider, which asks the file structure providers in turn). dnSpy.Hex.Files'
		/// HexReferenceConverterImpl turns a method body into a MethodStatementReference on the module the file was
		/// opened from; AsmEditor's turns a PE structure field into the PE tree node showing it
		/// (BufferToDocumentNodeService.FindPENode, then PENode.FindNode or FindTokenNode).
		/// </summary>
		HexCodeReferenceDto? ConvertHexReference(IModuleEntry entry, object? reference) {
			switch (reference) {
			case HexMethodReference method:
				if (entry is not ModuleEntry module || module.Module.ResolveToken(method.Token) is not MethodDef)
					return null;
				return new HexCodeReferenceDto("method", null, module.Path, unchecked((int)method.Token), method.Offset is { } offset ? unchecked((int)offset) : null);
			case PeFieldReference field when FindPeFieldNode(entry, field) is { } node:
				return new HexCodeReferenceDto("node", node.Id, null, null, null);
			default:
				return null;
			}
		}

		/// <summary>
		/// The structure AsmEditor's HexFileStructureInfoProviderImpl puts a position in: the first of its PE structures —
		/// the DOS, file and optional headers, the CLR header, the storage signature and header, the tables stream
		/// header, the section headers, the storage stream headers, in its order — that has a visible field there, or
		/// else the metadata table row there.
		/// </summary>
		object? FindPeField(IModuleEntry entry, HexPosition position) {
			if (GetPeStructureSource(entry) is not { } source)
				return null;
			var offset = (long)position.ToUInt64();
			var structures = new List<PeStructureValue> {
				new(PeStructureKind.DosHeader, -1),
				new(PeStructureKind.FileHeader, -1),
				new(PeStructureKind.OptionalHeader, -1),
				new(PeStructureKind.Cor20Header, -1),
				new(PeStructureKind.StorageSignature, -1),
				new(PeStructureKind.StorageHeader, -1),
			};
			var tablesStreamIndex = structures.Count;
			for (var i = 0; i < source.Image.ImageSectionHeaders.Count; i++)
				structures.Add(new PeStructureValue(PeStructureKind.Section, i));
			if (source.Metadata?.MetadataHeader is not null) {
				for (var i = 0; i < source.Metadata.AllStreams.Count; i++)
					structures.Add(new PeStructureValue(PeStructureKind.StorageStream, i));
			}
			return ReadPatched(entry, reader => {
				for (var i = 0; i < structures.Count; i++) {
					if (i == tablesStreamIndex && source.Metadata is { TablesStream: { } tables } tablesMetadata) {
						var (headerStart, headerLength) = MetadataTablesReader.HeaderSpan(tables);
						if (offset >= headerStart && offset < headerStart + headerLength &&
							HasField(new MetadataTablesReader(tablesMetadata, reader).TablesHeader(string.Empty), offset))
							return new PeFieldReference(null, true, null, 0);
					}
					var value = structures[i];
					if (PeHexStructures.Span(source, value.Kind, value.Index) is not { } span || offset < span.Offset || offset >= span.Offset + span.Length)
						continue;
					if (PeHexStructures.Read(string.Empty, source, value.Kind, value.Index, reader) is { } structure && HasField(structure, offset))
						return new PeFieldReference(value, false, null, 0);
				}
				// Every column of a row is a visible field, so a position in a table is in one of its rows' fields.
				if (source.Metadata?.TablesStream is { } tablesStream) {
					foreach (var table in tablesStream.MDTables) {
						if (table.Rows == 0)
							continue;
						var start = MetadataTablesReader.Offset(table.StartOffset);
						if (offset < start || offset >= start + (long)table.Rows * table.RowSize)
							continue;
						return new PeFieldReference(null, false, table.Table, (uint)((offset - start) / table.RowSize) + 1);
					}
				}
				return (object?)null;
			});
		}

		static bool HasField(HexStructureDto structure, long offset) =>
			structure.Fields.Any(field => offset >= field.Offset && offset < field.Offset + field.Size);

		/// <summary>
		/// The node AsmEditor's PENode.FindNode returns for a structure — the node of the structure itself, the tables
		/// stream node for its header — or PENode.FindTokenNode for a row. The nodes from the PE node down are made on the
		/// way, so the client can walk to the one returned (tree/getNodePath) the way Go to MD Table Row does.
		/// </summary>
		NodeEntry? FindPeFieldNode(IModuleEntry entry, PeFieldReference field) {
			if (field.Table is { } table) {
				if (entry is not ModuleEntry module || FindTablesStreamNode(module) is not { } tablesStreamNode)
					return null;
				var mdTable = module.Module.Metadata?.TablesStream?.Get(table);
				if (mdTable is null || !mdTable.IsValidRID(field.Rid))
					return null;
				return MetadataRecordNode(MetadataTableNode(tablesStreamNode, table), table, field.Rid);
			}
			if (field.IsTablesStream)
				return entry is ModuleEntry tablesModule ? FindTablesStreamNode(tablesModule) : null;
			if (field.Structure is not { } structure || FindPeNode(entry) is not { } peNode)
				return null;
			return PeStructureNode(peNode, structure);
		}

		/// <summary>The PE node of a document opened from a file: under its module node, or under a native PE document's root.</summary>
		NodeEntry? FindPeNode(IModuleEntry entry) {
			switch (entry) {
			case ModuleEntry { InMemory: false } module when module.Module.Metadata?.PEImage is { } peImage:
				var moduleNode = GetOrAddNode($"module:{module.Path}", NodeKind.Module, module.Module, module);
				return GetOrAddNode($"{moduleNode.Key}:pe", NodeKind.PE, peImage, module);
			case PeOnlyModuleEntry peOnly when nodeIdsByKey.TryGetValue($"pe:{peOnly.Path}", out var rootId) && nodes.TryGetValue(rootId, out var root):
				return GetOrAddNode($"{root.Key}:pe", NodeKind.PE, peOnly.PEImage, peOnly);
			default:
				return null;
			}
		}

		/// <summary>AsmEditor's HexFieldReference, said in this port's terms: a PE structure, the tables stream header, or a row.</summary>
		sealed record PeFieldReference(PeStructureValue? Structure, bool IsTablesStream, Table? Table, uint Rid);

		/// <summary>
		/// One hex search (HexViewSearchService over the hex search services). The pattern is what the client parsed the
		/// search text into; the matching and the order of the results are those of dnSpy's FindAll.
		/// </summary>
		public async Task<HexSearchResponse> SearchHexAsync(HexSearchRequest request, CancellationToken cancellationToken) {
			var entry = GetHexEntry(request.ModuleId);
			if (request.MaxResults <= 0)
				throw new RpcException(ErrorCodes.InvalidParams, "A hex search has to ask for at least one result.");
			var pattern = DecodeSearchPattern(request);
			if (entry.FileLength < pattern.Length)
				return new HexSearchResponse(Array.Empty<long>());
			try {
				using var searcher = new HexSearcher(entry, pattern, request.NoOverlaps, request.MaxResults, cancellationToken);
				var offsets = await searcher.FindAllAsync(request.RangeStart, request.RangeEnd, request.Start, request.Reverse, request.Wrap).ConfigureAwait(false);
				return new HexSearchResponse(offsets.ToArray());
			}
			catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) {
				throw new RpcException(ErrorCodes.SaveFailed, $"The file could not be read: {ex.Message}");
			}
		}

		static HexSearchPattern DecodeSearchPattern(HexSearchRequest request) {
			byte[] pattern;
			byte[]? mask = null;
			byte[]? alternate = null;
			try {
				pattern = Convert.FromBase64String(request.Base64Pattern);
				if (request.Base64Mask is not null)
					mask = Convert.FromBase64String(request.Base64Mask);
				if (request.Base64Alternate is not null)
					alternate = Convert.FromBase64String(request.Base64Alternate);
			}
			catch (FormatException ex) {
				throw new RpcException(ErrorCodes.InvalidParams, "The search pattern is not valid base64.", null, ex);
			}
			if (pattern.Length == 0)
				throw new RpcException(ErrorCodes.InvalidParams, "The search pattern is empty.");
			try {
				if (alternate is null)
					return new HexSearchPattern(pattern, mask);
				if (request.CharLengths is not { } charLengths)
					throw new RpcException(ErrorCodes.InvalidParams, "A string search needs the length of each character.");
				return new HexSearchPattern(pattern, alternate, [.. charLengths]);
			}
			catch (ArgumentOutOfRangeException ex) {
				throw new RpcException(ErrorCodes.InvalidParams, "The search pattern, its mask, its upper-case form and its character lengths do not agree.", null, ex);
			}
		}
	}
}
