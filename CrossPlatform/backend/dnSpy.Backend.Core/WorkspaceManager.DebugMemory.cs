using System.Collections.Concurrent;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.HexFiles;
using dnSpy.Backend.Core.HexFiles.DnSpy;
using dnSpy.Backend.Core.HexFiles.DotNet;
using dnSpy.Backend.Core.HexFiles.PE;
using dnSpy.Backend.Core.HexFiles.ToolTips;
using dnlib.PE;
using HexTable = dnSpy.Backend.Core.HexFiles.DotNet.Table;

namespace dnSpy.Backend.Core;

/// <summary>
/// The debugger's Memory window gets the hex view's structure services too: dnSpy's dnSpy.Hex.Files model over the
/// process's memory, with a top-level file for each loaded module the way its BufferFileCreator creates them, so Quick
/// Info, Go to Code or Structure, Follow Field Value Reference, Edit Field, Select File/Nested File/Structure, Copy
/// RVA/File Offset, Go to Position and Go to Metadata work there as in a document's hex view. Every position is an
/// address of the process.
/// </summary>
public sealed partial class WorkspaceManager {
	IDebugMemoryProvider? debugMemory;

	/// <summary>
	/// The model each debug session's Memory window reads, built the first time an address of it is asked about. It is
	/// kept while the process is stopped and neither its memory (<see cref="IDebugProcessMemory.Generation"/>: every
	/// continue, every write) nor its modules (<see cref="IDebugProcessMemory.ModuleListVersion"/>) have changed, and
	/// dropped when the session ends.
	/// </summary>
	readonly ConcurrentDictionary<string, DebugMemoryModelCache> debugMemoryModels = new(StringComparer.Ordinal);

	/// <summary>The debug sessions whose processes the Memory window shows. Set by the host once both exist.</summary>
	public IDebugMemoryProvider? DebugMemory {
		get => debugMemory;
		set {
			if (debugMemory is not null)
				debugMemory.SessionEnded -= DebugMemory_SessionEnded;
			debugMemory = value;
			if (value is not null)
				value.SessionEnded += DebugMemory_SessionEnded;
			debugMemoryModels.Clear();
		}
	}

	void DebugMemory_SessionEnded(object? sender, string sessionId) => debugMemoryModels.TryRemove(sessionId, out _);

	/// <summary>F5 refreshes the process's structure bytes too, including changes made while it remained stopped.</summary>
	public void RefreshDebugMemory(DebugMemoryRefreshRequest request) {
		var provider = debugMemory ?? throw new RpcException(ErrorCodes.InvalidRequest, "The CoreCLR debug adapter is not installed.");
		if (provider.FindProcessMemory(request.SessionId) is null)
			throw new RpcException(ErrorCodes.InvalidParams, "The debug session no longer exists.");
		// Removing the entry also prevents an already-running query from republishing its old model.
		debugMemoryModels.TryRemove(request.SessionId, out _);
	}

	sealed class DebugMemoryModelCache {
		public object Gate { get; } = new();
		public IDebugProcessMemory? Memory { get; set; }
		public DebugMemoryModelVersion? Version { get; set; }
		public HexStructureModel? Model { get; set; }
	}

	sealed record DebugMemoryModelVersion(int ProcessId, int ModuleListVersion, int Generation);

	/// <summary>
	/// Runs a question against a session's Memory window model, off the caller's thread: reading the process waits for
	/// the debugger's own thread. Questions about one session take turns, as the model is not thread safe.
	/// </summary>
	Task<T> AskDebugMemoryAsync<T>(string sessionId, Func<IDebugProcessMemory, HexStructureModel, T> ask, T fallback, CancellationToken cancellationToken) {
		var provider = debugMemory ?? throw new RpcException(ErrorCodes.InvalidRequest, "The CoreCLR debug adapter is not installed.");
		return Task.Run(() => {
			var memory = provider.FindProcessMemory(sessionId);
			if (memory is null) {
				debugMemoryModels.TryRemove(sessionId, out _);
				throw new RpcException(ErrorCodes.InvalidParams, "The debug session no longer exists.");
			}
			var cache = debugMemoryModels.GetOrAdd(sessionId, _ => new DebugMemoryModelCache());
			T answer;
			lock (cache.Gate) {
				var version = new DebugMemoryModelVersion(memory.ProcessId, memory.ModuleListVersion, memory.Generation);
				var model = cache.Model;
				if (model is null || !ReferenceEquals(cache.Memory, memory) || cache.Version != version || !memory.IsStopped)
					model = CreateDebugMemoryModel(memory);
				// A running process's memory changes under the model, so it is only kept while the process is stopped.
				cache.Memory = memory.IsStopped ? memory : null;
				cache.Version = memory.IsStopped ? version : null;
				cache.Model = memory.IsStopped ? model : null;
				answer = Workspace.AskModel(() => ask(memory, model), fallback);
			}
			// The session may have ended while the model was being built; its end has already cleared the cache.
			if (provider.FindProcessMemory(sessionId) is null)
				debugMemoryModels.TryRemove(sessionId, out _);
			return answer;
		}, cancellationToken);
	}

	/// <summary>
	/// The model over a process: the debugger's BufferFileCreator.ModuleListener makes a file of every module with an
	/// address, named by the module's name and file name and tagged with its image layout, so the PE headers reader
	/// reads an RVA of a module the loader mapped as an offset from its base. Modules at the same address share one
	/// file (the listener's reference counts).
	/// </summary>
	static HexStructureModel CreateDebugMemoryModel(IDebugProcessMemory memory) {
		var buffer = new HexBuffer(new ProcessMemoryHexBufferSource(memory));
		return new HexStructureModel(buffer, DebugMemoryPeField, _ => DebugMemoryFiles(memory.GetModules()));
	}

	static BufferFileOptions[] DebugMemoryFiles(IReadOnlyList<DebugProcessModule> modules) {
		var files = new List<BufferFileOptions>();
		var starts = new HashSet<ulong>();
		foreach (var module in modules) {
			if (module.Address == 0 || module.Size == 0)
				continue;
			var start = new HexPosition(module.Address);
			var end = start + module.Size;
			if (end > HexPosition.MaxEndPosition || !starts.Add(module.Address))
				continue;
			string[] tags = module.ImageLayout switch {
				DebugImageLayout.File => [PredefinedBufferFileTags.FileLayout],
				DebugImageLayout.Memory => [PredefinedBufferFileTags.MemoryLayout],
				_ => [],
			};
			files.Add(new BufferFileOptions(HexSpan.FromBounds(start, end), module.Name, module.Filename, tags));
		}
		return files.ToArray();
	}

	/// <summary>
	/// What AsmEditor's provider answers in the Memory window: the PE structure under a position of a module, whose
	/// node AsmEditor's HexReferenceConverterImpl finds in the document opened from the module's file
	/// (BufferToDocumentNodeService.FindPENode). The structures are this port's PE tree's, read from that document,
	/// so the position is kept as the place in the module it is and the document answers once the reference is followed.
	/// </summary>
	static object? DebugMemoryPeField(HexBufferFile file, HexPosition position) {
		if (file.Filename.Length == 0 || file.GetHeaders<PeHeaders>() is not { } peHeaders)
			return null;
		return peHeaders.IsFileLayout
			? new DebugMemoryPeFieldPosition(file.Filename, false, (ulong)(position - file.Span.Start).ToUInt64())
			: new DebugMemoryPeFieldPosition(file.Filename, true, peHeaders.BufferPositionToRva(position));
	}

	/// <summary>A position of a module's image: an RVA, or an offset of its file when the image is in file layout.</summary>
	internal sealed record DebugMemoryPeFieldPosition(string Filename, bool IsRva, ulong Value);

	static long Address(HexPosition position) => (long)position.ToUInt64();

	public Task<HexToolTipInfoResponse> GetDebugMemoryToolTipInfoAsync(DebugMemoryPositionRequest request, CancellationToken cancellationToken) {
		var empty = new HexToolTipInfoResponse(Array.Empty<HexStructureFieldSpanDto>(), null);
		if (request.Address < 0)
			return Task.FromResult(empty);
		var position = new HexPosition((ulong)request.Address);
		return AskDebugMemoryAsync(request.SessionId, (_, model) => {
			var fields = new List<HexStructureFieldSpanDto>();
			object? toolTip = null;
			foreach (var field in model.StructureInfoProvider.GetFields(position)) {
				var span = field.BufferSpan.Span;
				fields.Add(new HexStructureFieldSpanDto(Address(span.Start), (long)span.Length.ToUInt64(), Workspace.FieldKind(field.Kind)));
				if (field.IsCurrentField)
					toolTip = model.StructureInfoProvider.GetToolTip(position);
			}
			return new HexToolTipInfoResponse(fields, toolTip is HexToolTipContent content ? Workspace.ToToolTipDto(content) : null);
		}, empty, cancellationToken);
	}

	public async Task<HexPositionInfoResponse> GetDebugMemoryPositionInfoAsync(DebugMemoryPositionRequest request, CancellationToken cancellationToken) {
		var empty = new HexPositionInfoResponse(null, null, null, null, null, request.Address, null, null);
		if (request.Address < 0)
			return empty;
		var position = new HexPosition((ulong)request.Address);
		string? workspaceId = null;
		object? reference = null;
		var info = await AskDebugMemoryAsync(request.SessionId, (memory, model) => {
			workspaceId = memory.WorkspaceId;
			var fileService = model.FileService;
			var file = fileService.GetFile(position, checkNestedFiles: false);
			var nestedFile = fileService.GetFile(position, checkNestedFiles: true);
			var found = fileService.GetFileAndStructure(position);
			var peHeaders = file?.GetHeaders<PeHeaders>();
			long? rva = peHeaders is null ? null : peHeaders.BufferPositionToRva(position);
			long fileOffset = peHeaders is not null ? (long)peHeaders.BufferPositionToFilePosition(position)
				: file is not null ? (long)(position - file.Span.Start).ToUInt64()
				: request.Address;
			reference = model.StructureInfoProvider.GetReference(position);
			return new HexPositionInfoResponse(
				Workspace.Range(file?.Span),
				Workspace.Range(nestedFile?.Span),
				Workspace.Range(found?.Structure.Span.Span),
				found is { } value ? Workspace.GetEditField(value.Structure, position) : null,
				rva,
				fileOffset,
				Workspace.Range(model.InfoService.GetFieldReferenceSpan(position)),
				null);
		}, empty, cancellationToken).ConfigureAwait(false);
		return info with { Reference = await ConvertDebugMemoryReferenceAsync(workspaceId, reference, cancellationToken).ConfigureAwait(false) };
	}

	/// <summary>
	/// dnSpy's HexReferenceConverters in the Memory window. A method body is the method of the module the file was loaded
	/// from, which the client finds by the module's path; a PE structure is the node of the session's workspace's
	/// document opened from that path, when there is one.
	/// </summary>
	async Task<HexCodeReferenceDto?> ConvertDebugMemoryReferenceAsync(string? workspaceId, object? reference, CancellationToken cancellationToken) {
		switch (reference) {
		case HexMethodReference method when method.File.Filename.Length > 0:
			return new HexCodeReferenceDto("method", null, method.File.Filename, unchecked((int)method.Token), method.Offset is { } offset ? unchecked((int)offset) : null);
		case DebugMemoryPeFieldPosition field when workspaceId is not null && workspaces.TryGetValue(workspaceId, out var workspace):
			return await workspace.RunAsync(w => w.FindDebugMemoryPeFieldNode(field), cancellationToken).ConfigureAwait(false);
		default:
			return null;
		}
	}

	/// <summary>
	/// dnSpy's Go to Position in the Memory window (HexCommandOperationsImpl.ToBufferPosition): a file offset or an RVA
	/// goes through the PE headers of the top-level file at the caret. Without them the answer is -1, and the client
	/// takes the value as an address, as WPF does.
	/// </summary>
	public Task<HexResolvePositionResponse> ResolveDebugMemoryPositionAsync(DebugMemoryResolvePositionRequest request, CancellationToken cancellationToken) {
		if (request.Kind is not ("file" or "rva"))
			throw new RpcException(ErrorCodes.InvalidParams, $"Unknown position kind '{request.Kind}'.");
		var none = new HexResolvePositionResponse(-1);
		if (request.CaretAddress < 0 || request.Value < 0)
			return Task.FromResult(none);
		var caret = new HexPosition((ulong)request.CaretAddress);
		return AskDebugMemoryAsync(request.SessionId, (_, model) => {
			if (model.FileService.GetFile(caret, checkNestedFiles: false)?.GetHeaders<PeHeaders>() is not { } peHeaders)
				return none;
			HexPosition position;
			if (request.Kind == "file")
				position = peHeaders.FilePositionToBufferPosition((ulong)request.Value);
			else if (request.Value <= uint.MaxValue)
				position = peHeaders.RvaToBufferPosition((uint)request.Value);
			else
				return none;
			return new HexResolvePositionResponse(position.ToUInt64() > long.MaxValue ? -1 : Address(position));
		}, none, cancellationToken);
	}

	/// <summary>Whether the top-level file at an address has .NET metadata and PE headers — what decides whether dnSpy's
	/// Go to Metadata (HexCommandOperationsImpl.GoToMetadata) and its Method Body kind can run there.</summary>
	public Task<DebugMemoryFileInfoResponse> GetDebugMemoryFileInfoAsync(DebugMemoryFileInfoRequest request, CancellationToken cancellationToken) {
		var none = new DebugMemoryFileInfoResponse(false, false);
		if (request.Address < 0)
			return Task.FromResult(none);
		var position = new HexPosition((ulong)request.Address);
		return AskDebugMemoryAsync(request.SessionId, (_, model) => {
			var file = model.FileService.GetFile(position, checkNestedFiles: false);
			return file is null ? none : new DebugMemoryFileInfoResponse(file.GetHeaders<DotNetMetadataHeaders>() is not null, file.GetHeaders<PeHeaders>() is not null);
		}, none, cancellationToken);
	}

	/// <summary>
	/// dnSpy's Go to Metadata in the Memory window: the value is checked the way GoToMetadataVM's OffsetTokenVM checks it
	/// and turned into a span by HexCommandOperationsImpl.GetGoToMetadataSpan, over the metadata headers of the top-level
	/// file at the caret.
	/// </summary>
	public Task<HexGoToMetadataResponse> GoToDebugMemoryMetadataAsync(DebugMemoryGoToMetadataRequest request, CancellationToken cancellationToken) {
		if (request.Kind is not ("table" or "memberRva" or "blob" or "strings" or "us" or "guid"))
			throw new RpcException(ErrorCodes.InvalidParams, $"Unknown metadata kind '{request.Kind}'.");
		var none = new HexGoToMetadataResponse(null);
		if (request.CaretAddress < 0 || request.Value < 0 || request.Value > uint.MaxValue)
			return Task.FromResult(none);
		var caret = new HexPosition((ulong)request.CaretAddress);
		var value = (uint)request.Value;
		return AskDebugMemoryAsync(request.SessionId, (_, model) => {
			var file = model.FileService.GetFile(caret, checkNestedFiles: false);
			if (file?.GetHeaders<DotNetMetadataHeaders>() is not { } mdHeaders)
				return none;
			var span = GetGoToMetadataSpan(model.Buffer, mdHeaders, file.GetHeaders<PeHeaders>(), value, request.Kind);
			return new HexGoToMetadataResponse(span is { } found ? new HexRangeDto(Address(found.Start), (long)found.Length.ToUInt64()) : null);
		}, none, cancellationToken);
	}

	static HexSpan? GetGoToMetadataSpan(HexBuffer buffer, DotNetMetadataHeaders mdHeaders, PeHeaders? peHeaders, uint value, string kind) {
		MDTable? mdTable;
		switch (kind) {
		case "blob":
			if (mdHeaders.BlobStream is not { } blob || value >= blob.Span.Length)
				return null;
			return new HexSpan(blob.Span.Span.Start + value, 0);
		case "strings":
			if (mdHeaders.StringsStream is not { } strings || value >= strings.Span.Length)
				return null;
			return new HexSpan(strings.Span.Span.Start + value, 0);
		case "us":
			// The dialog takes a string token as well as an offset.
			if ((value >> 24) == 0x70)
				value &= 0x00FFFFFF;
			if (mdHeaders.USStream is not { } us || value >= us.Span.Length)
				return null;
			return new HexSpan(us.Span.Span.Start + (value & 0x00FFFFFF), 0);
		case "guid":
			if (value == 0 || mdHeaders.GUIDStream is not { } guid || !guid.IsValidIndex(value))
				return null;
			return new HexSpan(guid.Span.Span.Start + (value - 1) * 16UL, 16);
		case "table":
			mdTable = GetMDTable(mdHeaders, value);
			if (mdTable is null)
				return null;
			return new HexSpan(mdTable.Span.Start + (ulong)(MDToken.ToRID(value) - 1) * mdTable.RowSize, mdTable.RowSize);
		case "memberRva":
			if (peHeaders is null)
				return null;
			mdTable = GetMDTable(mdHeaders, value);
			if (mdTable is null || (mdTable.Table != HexTable.Method && mdTable.Table != HexTable.FieldRVA))
				return null;
			// Column 0 is the RVA in both Method and FieldRVA tables
			var rva = buffer.ReadUInt32(mdTable.Span.Start + (ulong)(MDToken.ToRID(value) - 1) * mdTable.RowSize);
			if (rva == 0)
				return null;
			return new HexSpan(peHeaders.RvaToBufferPosition(rva), 0);
		default:
			return null;
		}
	}

	static MDTable? GetMDTable(DotNetMetadataHeaders mdHeaders, uint token) {
		var tablesStream = mdHeaders.TablesStream;
		if (tablesStream is null)
			return null;
		var table = (uint)MDToken.ToTable(token);
		if (table >= (uint)tablesStream.MDTables.Count)
			return null;
		var mdTable = tablesStream.MDTables[(int)table];
		return mdTable?.IsValidRID(MDToken.ToRID(token)) == true ? mdTable : null;
	}

	sealed partial class Workspace {
		/// <summary>
		/// AsmEditor's BufferToDocumentNodeService.FindPENode and PENode.FindNode for a structure of a module in the Memory
		/// window: the document opened from the module's file, and the node of the structure at the same place of it.
		/// </summary>
		internal HexCodeReferenceDto? FindDebugMemoryPeFieldNode(DebugMemoryPeFieldPosition position) {
			IModuleEntry? entry;
			try {
				entry = (IModuleEntry?)FindModuleEntry(position.Filename) ?? FindPeModuleEntry(position.Filename);
			}
			catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException) {
				return null;
			}
			if (entry is null)
				return null;
			var offset = position.Value;
			if (position.IsRva) {
				if (GetPeImage(entry) is not { } peImage || offset >= peImage.ImageNTHeaders.OptionalHeader.SizeOfImage)
					return null;
				try {
					offset = (ulong)peImage.ToFileOffset((RVA)(uint)offset);
				}
				catch (Exception ex) when (ex is ArgumentException or InvalidOperationException) {
					return null;
				}
			}
			if (offset >= (ulong)entry.FileLength)
				return null;
			return AskModel(() => FindPeField(entry, new HexPosition(offset)) is PeFieldReference field && FindPeFieldNode(entry, field) is { } node
				? new HexCodeReferenceDto("node", node.Id, null, null, null)
				: null, null);
		}
	}
}
