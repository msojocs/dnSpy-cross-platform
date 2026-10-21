using System.Buffers.Binary;
using System.Reflection.PortableExecutable;
using System.Text;
using System.Text.Json;
using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using dnSpy.Backend.Debugging.CorDebug;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The debugger's Memory window structures: dnSpy's dnSpy.Hex.Files model over a process's memory with a file for every
/// loaded module (the debugger's BufferFileCreator), first over a fake process holding the fixture's image the way the
/// loader maps it, then over a real stopped debuggee.
/// </summary>
public sealed class DebugMemoryStructureTests : IDisposable {
	const ulong Base = 0x7F12_3400_0000;
	const ulong FileLayoutBase = 0x7F12_5600_0000;

	readonly WorkspaceManager manager = new();

	static CancellationToken Token => TestContext.Current.CancellationToken;

	public void Dispose() => manager.Dispose();

	/// <summary>A process whose memory is a set of byte runs; everything else cannot be read.</summary>
	sealed class FakeProcess : IDebugMemoryProvider, IDebugProcessMemory {
		public readonly List<(ulong Address, byte[] Bytes)> Regions = [];
		public readonly List<DebugProcessModule> Modules = [];
		public bool Ended;

		public string SessionId => "fake";
		public string? WorkspaceId { get; set; }
		public int ProcessId => 1234;
		public bool IsStopped { get; set; } = true;
		public int Generation { get; set; }
		public int ModuleListVersion { get; set; }
		public Action? BeforeRead { get; set; }
		public IReadOnlyList<DebugProcessModule> GetModules() => Modules.ToArray();

		public int ReadMemory(ulong address, byte[] buffer) {
			BeforeRead?.Invoke();
			foreach (var (start, bytes) in Regions) {
				if (address >= start && address + (ulong)buffer.Length <= start + (ulong)bytes.Length) {
					Array.Copy(bytes, (long)(address - start), buffer, 0, buffer.Length);
					return buffer.Length;
				}
			}
			return 0;
		}

		public IDebugProcessMemory? FindProcessMemory(string sessionId) => !Ended && sessionId == SessionId ? this : null;

		public event EventHandler<string>? SessionEnded;

		public void End() {
			Ended = true;
			SessionEnded?.Invoke(this, SessionId);
		}
	}

	/// <summary>The fixture's image as the OS loader maps it: the headers, then each section at its RVA.</summary>
	static byte[] MapImage(byte[] file, out PEHeaders headers) {
		using var reader = new PEReader(new MemoryStream(file));
		headers = reader.PEHeaders;
		var image = new byte[headers.PEHeader!.SizeOfImage];
		Array.Copy(file, image, headers.PEHeader.SizeOfHeaders);
		foreach (var section in headers.SectionHeaders)
			Array.Copy(file, section.PointerToRawData, image, section.VirtualAddress, Math.Min(section.SizeOfRawData, image.Length - section.VirtualAddress));
		return image;
	}

	(FakeProcess Process, string Path, byte[] File, byte[] Image, PEHeaders Headers) CreateProcess() {
		var path = DebugTestEnvironment.FindTarget();
		var file = File.ReadAllBytes(path);
		var image = MapImage(file, out var headers);
		var process = new FakeProcess();
		process.Regions.Add((Base, image));
		process.Regions.Add((FileLayoutBase, file));
		process.Modules.Add(new DebugProcessModule(Base, (ulong)image.Length, Path.GetFileName(path), path, DebugImageLayout.Memory));
		// A module loaded from bytes lies in the process the way its file stores it.
		process.Modules.Add(new DebugProcessModule(FileLayoutBase, (ulong)file.Length, "bytes", string.Empty, DebugImageLayout.File));
		manager.DebugMemory = process;
		return (process, path, file, image, headers);
	}

	static string Text(IEnumerable<TextPartDto> parts) => string.Concat(parts.Select(part => part.Text));

	Task<HexToolTipInfoResponse> ToolTipAsync(ulong address) =>
		manager.GetDebugMemoryToolTipInfoAsync(new DebugMemoryPositionRequest("fake", (long)address), Token);

	Task<HexPositionInfoResponse> PositionAsync(ulong address) =>
		manager.GetDebugMemoryPositionInfoAsync(new DebugMemoryPositionRequest("fake", (long)address), Token);

	[Fact]
	public async Task AModuleMappedByTheLoaderHasItsHeadersAtItsBase() {
		CreateProcess();
		var info = await ToolTipAsync(Base);

		var toolTip = Assert.IsType<HexToolTipDto>(info.ToolTip);
		Assert.Equal("IMAGE_DOS_HEADER.e_magic = 0x5A4D (23117)", Text(Assert.Single(toolTip.Sections)));
		Assert.Equal([new HexStructureFieldSpanDto((long)Base, 2, "currentField"), new HexStructureFieldSpanDto((long)Base, 0x40, "structure")], info.Fields);

		// No module, no structure: the memory around the modules is not read as one.
		var outside = await ToolTipAsync(Base - 0x1000);
		Assert.Null(outside.ToolTip);
		Assert.Empty(outside.Fields);
	}

	[Fact]
	public async Task APositionOfAMemoryLayoutModuleIsAnRvaFromItsBase() {
		var (_, _, _, image, headers) = CreateProcess();
		var section = headers.SectionHeaders[0];
		var address = Base + (ulong)section.VirtualAddress + 0x10;

		var info = await PositionAsync(address);
		Assert.Equal(new HexRangeDto((long)Base, image.Length), info.File);
		Assert.Equal(new HexRangeDto((long)Base, image.Length), info.NestedFile);
		Assert.Equal(section.VirtualAddress + 0x10, info.Rva);
		// Copy File Offset goes back through the section table.
		Assert.Equal(section.PointerToRawData + 0x10, info.FileOffset);

		var header = await PositionAsync(Base);
		Assert.Equal(0, header.Rva);
		Assert.Equal(new HexRangeDto((long)Base, 0x40), header.Structure);

		// Outside every module the address is all there is.
		var outside = await PositionAsync(Base - 0x1000);
		Assert.Null(outside.File);
		Assert.Null(outside.Rva);
		Assert.Equal((long)(Base - 0x1000), outside.FileOffset);
	}

	[Fact]
	public async Task GoToPositionReadsFileOffsetsAndRvasThroughTheModuleAtTheCaret() {
		var (_, _, file, _, headers) = CreateProcess();
		var section = headers.SectionHeaders[0];

		var rva = await manager.ResolveDebugMemoryPositionAsync(new DebugMemoryResolvePositionRequest("fake", (long)Base + 4, "rva", section.VirtualAddress + 8), Token);
		Assert.Equal((long)Base + section.VirtualAddress + 8, rva.Offset);
		var fileOffset = await manager.ResolveDebugMemoryPositionAsync(new DebugMemoryResolvePositionRequest("fake", (long)Base, "file", section.PointerToRawData + 8), Token);
		Assert.Equal((long)Base + section.VirtualAddress + 8, fileOffset.Offset);

		// A module in file layout: an RVA goes through the section table, a file offset is one from its base.
		var fileRva = await manager.ResolveDebugMemoryPositionAsync(new DebugMemoryResolvePositionRequest("fake", (long)FileLayoutBase, "rva", section.VirtualAddress + 8), Token);
		Assert.Equal((long)FileLayoutBase + section.PointerToRawData + 8, fileRva.Offset);
		var fileFile = await manager.ResolveDebugMemoryPositionAsync(new DebugMemoryResolvePositionRequest("fake", (long)FileLayoutBase, "file", 0x80), Token);
		Assert.Equal((long)FileLayoutBase + 0x80, fileFile.Offset);
		Assert.True(file.Length > 0x80);

		// No module at the caret: the client takes the value as an address.
		var none = await manager.ResolveDebugMemoryPositionAsync(new DebugMemoryResolvePositionRequest("fake", 0x1000, "rva", 0x2000), Token);
		Assert.Equal(-1, none.Offset);
		await Assert.ThrowsAsync<RpcException>(() => manager.ResolveDebugMemoryPositionAsync(new DebugMemoryResolvePositionRequest("fake", (long)Base, "absolute", 1), Token));
	}

	[Fact]
	public async Task GoToMetadataFindsARowAndAMethodBodyInTheModuleAtTheCaret() {
		var (_, path, file, _, _) = CreateProcess();
		using var module = ModuleDefMD.Load(file);
		var typeDefs = module.Metadata.TablesStream.TypeDefTable;
		var rowFileOffset = (int)(uint)typeDefs.StartOffset + (int)typeDefs.RowSize;
		var rowRva = (uint)module.Metadata.PEImage.ToRVA((dnlib.IO.FileOffset)(uint)rowFileOffset);

		var row = await manager.GoToDebugMemoryMetadataAsync(new DebugMemoryGoToMetadataRequest("fake", (long)Base, "table", 0x02000002), Token);
		Assert.Equal(new HexRangeDto((long)(Base + rowRva), typeDefs.RowSize), row.Range);

		var main = module.EntryPoint!;
		var body = await manager.GoToDebugMemoryMetadataAsync(new DebugMemoryGoToMetadataRequest("fake", (long)Base, "memberRva", main.MDToken.Raw), Token);
		Assert.Equal(new HexRangeDto((long)(Base + (uint)main.RVA), 0), body.Range);

		// A token naming no row, and a kind the dialog does not have.
		Assert.Null((await manager.GoToDebugMemoryMetadataAsync(new DebugMemoryGoToMetadataRequest("fake", (long)Base, "table", 0x02FFFFFF), Token)).Range);
		Assert.Null((await manager.GoToDebugMemoryMetadataAsync(new DebugMemoryGoToMetadataRequest("fake", 0x1000, "table", 0x02000002), Token)).Range);
		await Assert.ThrowsAsync<RpcException>(() => manager.GoToDebugMemoryMetadataAsync(new DebugMemoryGoToMetadataRequest("fake", (long)Base, "nothing", 1), Token));

		Assert.Equal(new DebugMemoryFileInfoResponse(true, true), await manager.GetDebugMemoryFileInfoAsync(new DebugMemoryFileInfoRequest("fake", (long)Base + 0x100), Token));
		Assert.Equal(new DebugMemoryFileInfoResponse(false, false), await manager.GetDebugMemoryFileInfoAsync(new DebugMemoryFileInfoRequest("fake", 0x1000), Token));

		// F12 in a method body goes to the method of the module the process loaded it from.
		var inBody = await PositionAsync(Base + (uint)main.RVA + 0x10);
		var reference = Assert.IsType<HexCodeReferenceDto>(inBody.Reference);
		Assert.Equal("method", reference.Kind);
		Assert.Equal(path, reference.ModulePath);
		Assert.Equal((int)main.MDToken.Raw, reference.MetadataToken);
	}

	[Fact]
	public async Task F12OnAPeHeaderFieldGoesToTheNodeOfTheDocumentOpenedFromTheModulesFile() {
		var (process, path, _, _, _) = CreateProcess();
		var info = await PositionAsync(Base);
		// Without a workspace there is no document to find a node in.
		Assert.Null(info.Reference);

		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), Token);
		process.WorkspaceId = opened.WorkspaceId;
		var withDocument = await PositionAsync(Base);
		var reference = Assert.IsType<HexCodeReferenceDto>(withDocument.Reference);
		Assert.Equal("node", reference.Kind);
		Assert.NotNull(reference.NodeId);
	}

	[Fact]
	public async Task TheModelIsReadAgainOnlyOnceTheProcessHasRunOrItsModulesChanged() {
		var (process, _, _, image, _) = CreateProcess();
		Assert.Equal("IMAGE_DOS_HEADER.e_cblp = 0x0090 (144)", Text(Assert.Single((await ToolTipAsync(Base + 2)).ToolTip!.Sections)));

		BinaryPrimitives.WriteUInt16LittleEndian(image.AsSpan(2), 0x1234);
		// The process has not run: the bytes read at this stop still stand.
		Assert.Equal("IMAGE_DOS_HEADER.e_cblp = 0x0090 (144)", Text(Assert.Single((await ToolTipAsync(Base + 2)).ToolTip!.Sections)));
		process.Generation++;
		Assert.Equal("IMAGE_DOS_HEADER.e_cblp = 0x1234 (4660)", Text(Assert.Single((await ToolTipAsync(Base + 2)).ToolTip!.Sections)));

		// A module that goes away takes its structures with it.
		process.Modules.RemoveAt(0);
		process.ModuleListVersion++;
		Assert.Null((await ToolTipAsync(Base + 2)).ToolTip);

		// A running process is read afresh every time.
		process.Modules.Add(new DebugProcessModule(Base, (ulong)image.Length, "again", string.Empty, DebugImageLayout.Memory));
		process.ModuleListVersion++;
		process.IsStopped = false;
		Assert.NotNull((await ToolTipAsync(Base + 2)).ToolTip);
		BinaryPrimitives.WriteUInt16LittleEndian(image.AsSpan(2), 0x5678);
		Assert.Equal("IMAGE_DOS_HEADER.e_cblp = 0x5678 (22136)", Text(Assert.Single((await ToolTipAsync(Base + 2)).ToolTip!.Sections)));

		process.End();
		await Assert.ThrowsAsync<RpcException>(() => ToolTipAsync(Base));
	}

	[Fact]
	public async Task RefreshReadsWritesMadeOutsideTheDebuggerWhileTheProcessRemainsStopped() {
		var (process, _, _, image, _) = CreateProcess();
		Assert.Equal("IMAGE_DOS_HEADER.e_cblp = 0x0090 (144)", Text(Assert.Single((await ToolTipAsync(Base + 2)).ToolTip!.Sections)));
		BinaryPrimitives.WriteUInt16LittleEndian(image.AsSpan(2), 0x1234);
		Assert.Equal("IMAGE_DOS_HEADER.e_cblp = 0x0090 (144)", Text(Assert.Single((await ToolTipAsync(Base + 2)).ToolTip!.Sections)));

		manager.RefreshDebugMemory(new DebugMemoryRefreshRequest(process.SessionId));
		Assert.Equal("IMAGE_DOS_HEADER.e_cblp = 0x1234 (4660)", Text(Assert.Single((await ToolTipAsync(Base + 2)).ToolTip!.Sections)));
		Assert.Equal(0, process.Generation);
		Assert.True(process.IsStopped);
		process.End();
		Assert.Throws<RpcException>(() => manager.RefreshDebugMemory(new DebugMemoryRefreshRequest(process.SessionId)));
	}

	[Fact]
	public async Task ARefreshCannotRepublishTheModelOfAQueryAlreadyInFlight() {
		var (process, _, _, image, _) = CreateProcess();
		using var entered = new ManualResetEventSlim();
		using var release = new ManualResetEventSlim();
		var firstRead = 0;
		process.BeforeRead = () => {
			if (Interlocked.Exchange(ref firstRead, 1) != 0)
				return;
			entered.Set();
			release.Wait(Token);
		};
		var pending = ToolTipAsync(Base + 2);
		try {
			Assert.True(entered.Wait(TimeSpan.FromSeconds(10), Token));
			manager.RefreshDebugMemory(new DebugMemoryRefreshRequest(process.SessionId));
		}
		finally {
			release.Set();
		}
		await pending;
		BinaryPrimitives.WriteUInt16LittleEndian(image.AsSpan(2), 0x1234);
		Assert.Equal("IMAGE_DOS_HEADER.e_cblp = 0x1234 (4660)", Text(Assert.Single((await ToolTipAsync(Base + 2)).ToolTip!.Sections)));
	}

	[Fact]
	public async Task AModuleHasItsHeadersWhereverTheLoaderPutIt() {
		var path = DebugTestEnvironment.FindTarget();
		var image = MapImage(File.ReadAllBytes(path), out _);
		var process = new FakeProcess();
		// dnSpy counts the sections the header names against the first section's file offset; the module's address
		// must not come into it.
		for (var i = 0UL; i < 16; i++) {
			var address = 0x7000_0000_0000 + i * 0x1_2345_6000;
			process.Regions.Add((address, image));
			process.Modules.Add(new DebugProcessModule(address, (ulong)image.Length, Path.GetFileName(path), path, DebugImageLayout.Memory));
		}
		manager.DebugMemory = process;
		foreach (var module in process.Modules)
			Assert.Equal(new DebugMemoryFileInfoResponse(true, true), await manager.GetDebugMemoryFileInfoAsync(new DebugMemoryFileInfoRequest("fake", (long)module.Address), Token));
	}

	[Fact]
	public async Task AModuleWhoseMemoryCannotBeReadHasNoStructures() {
		var process = new FakeProcess();
		process.Modules.Add(new DebugProcessModule(Base, 0x10000, "gone.dll", "/gone.dll", DebugImageLayout.Memory));
		manager.DebugMemory = process;
		var info = await ToolTipAsync(Base);
		Assert.Null(info.ToolTip);
		Assert.Empty(info.Fields);
		var position = await PositionAsync(Base);
		Assert.Equal(new HexRangeDto((long)Base, 0x10000), position.File);
		Assert.Null(position.Rva);
	}

	[Fact]
	public async Task APartlyUnreadableImageKeepsReadableHeadersAndReportsTheUnreadablePageAsMissing() {
		var (process, _, _, image, _) = CreateProcess();
		// Only the header page is readable; an unreadable later page must not erase its structures.
		process.Regions[0] = (Base, image[..4096]);
		Assert.Equal("IMAGE_DOS_HEADER.e_magic = 0x5A4D (23117)", Text(Assert.Single((await ToolTipAsync(Base)).ToolTip!.Sections)));
		var missing = await ToolTipAsync(Base + 0x1000);
		Assert.Null(missing.ToolTip);
	}

	[Fact]
	public async Task ADamagedPeHeaderIsNotReplacedByTheModulesFileOnDisk() {
		var (_, _, _, image, _) = CreateProcess();
		image[0] = 0;
		var info = await manager.GetDebugMemoryFileInfoAsync(new DebugMemoryFileInfoRequest("fake", (long)Base), Token);
		Assert.Equal(new DebugMemoryFileInfoResponse(false, false), info);
		Assert.Null((await ToolTipAsync(Base)).ToolTip);
	}

	// ---------------------------------------------------------------- a real debuggee

	[Fact(Timeout = 120_000)]
	public async Task ANaturallyExitedProcessDropsItsMemoryModelWithoutWaitingForDisconnect() {
		await using var debugManager = DebugTestEnvironment.CreateManager(manager);
		manager.DebugMemory = debugManager;
		var ended = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
		debugManager.SessionEnded += (_, sessionId) => ended.TrySetResult(sessionId);
		var target = DebugTestEnvironment.FindTarget();
		var started = await debugManager.LaunchAsync(new DebugLaunchRequest(target, StopAtEntry: false), Token);
		try {
			Assert.NotNull(debugManager.FindProcessMemory(started.SessionId));
			await manager.GetDebugMemoryFileInfoAsync(new DebugMemoryFileInfoRequest(started.SessionId, 0), Token);
			await debugManager.RequestAsync(new DebugAdapterRequest(started.SessionId, "configurationDone", JsonSerializer.SerializeToElement(new { })), Token);
			Assert.Equal(started.SessionId, await ended.Task.WaitAsync(Token));
			Assert.Null(debugManager.FindProcessMemory(started.SessionId));
			await Assert.ThrowsAsync<RpcException>(() => manager.GetDebugMemoryToolTipInfoAsync(new DebugMemoryPositionRequest(started.SessionId, 0), Token));
		}
		finally {
			await debugManager.DisconnectAsync(new DebugDisconnectRequest(started.SessionId, TerminateDebuggee: true), CancellationToken.None);
		}
	}

	[Fact(Timeout = 120_000)]
	public async Task TheModulesOfAStoppedDebuggeeHaveTheirStructures() {
		var debugManager = DebugTestEnvironment.CreateManager(manager);
		await using var debugScope = debugManager;
		manager.DebugMemory = debugManager;
		var stopped = new SemaphoreSlim(0);
		debugManager.EventReceived += (sender, notification) => {
			if (notification.Event == "stopped")
				stopped.Release();
		};
		var target = DebugTestEnvironment.FindTarget();
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([target]), Token);
		var started = await debugManager.LaunchAsync(new DebugLaunchRequest(target, Arguments: ["--evaluate"], StopAtEntry: false, WorkspaceId: opened.WorkspaceId), Token);
		var sessionId = started.SessionId;
		try {
			await debugManager.RequestAsync(new DebugAdapterRequest(sessionId, "configurationDone", JsonSerializer.SerializeToElement(new { })), Token);
			await stopped.WaitAsync(Token);
			// The Memory window opens at address zero, where no page is mapped.
			var unmapped = (await debugManager.RequestAsync(new DebugAdapterRequest(sessionId, "readMemory", JsonSerializer.SerializeToElement(new { address = "0x0", count = 8192 })), Token)).Body!.Value;
			Assert.Equal(new byte[8192], Convert.FromBase64String(unmapped.GetProperty("data").GetString()!));
			Assert.Equal([false, false], unmapped.GetProperty("readable").EnumerateArray().Select(flag => flag.GetBoolean()));
			var modules = (await debugManager.RequestAsync(new DebugAdapterRequest(sessionId, "modules", JsonSerializer.SerializeToElement(new { })), Token)).Body!.Value;
			var row = modules.GetProperty("modules").EnumerateArray().Single(m => m.GetProperty("name").GetString() == "DebugTarget.dll");
			var address = row.GetProperty("address").GetUInt64();
			var size = row.GetProperty("size").GetUInt32();

			var toolTip = await manager.GetDebugMemoryToolTipInfoAsync(new DebugMemoryPositionRequest(sessionId, (long)address), Token);
			Assert.Equal("IMAGE_DOS_HEADER.e_magic = 0x5A4D (23117)", Text(Assert.Single(Assert.IsType<HexToolTipDto>(toolTip.ToolTip).Sections)));

			var info = await manager.GetDebugMemoryPositionInfoAsync(new DebugMemoryPositionRequest(sessionId, (long)address), Token);
			Assert.Equal(new HexRangeDto((long)address, size), info.File);
			// The workspace has the module's file open, so F12 goes to its DOS header node.
			Assert.Equal("node", info.Reference?.Kind);

			// CoreCLR on Linux maps an IL-only file as it is, and the engine says so; a mapped image is read by RVA.
			var layout = debugManager.FindProcessMemory(sessionId)!.GetModules().Single(m => m.Address == address).ImageLayout;
			if (OperatingSystem.IsLinux())
				Assert.Equal(DebugImageLayout.File, layout);
			using var module = ModuleDefMD.Load(target);
			var peImage = module.Metadata.PEImage;
			long Place(uint rva) => (long)address + (layout == DebugImageLayout.File ? (uint)peImage.ToFileOffset((dnlib.PE.RVA)rva) : rva);
			var section = peImage.ImageSectionHeaders[0];
			var rva = await manager.ResolveDebugMemoryPositionAsync(new DebugMemoryResolvePositionRequest(sessionId, (long)address, "rva", (uint)section.VirtualAddress + 8), Token);
			Assert.Equal(Place((uint)section.VirtualAddress + 8), rva.Offset);

			var typeDefs = module.Metadata.TablesStream.TypeDefTable;
			var range = (await manager.GoToDebugMemoryMetadataAsync(new DebugMemoryGoToMetadataRequest(sessionId, (long)address, "table", 0x02000001), Token)).Range;
			Assert.Equal(new HexRangeDto(Place((uint)peImage.ToRVA(typeDefs.StartOffset)), typeDefs.RowSize), range);
			Assert.Equal(new DebugMemoryFileInfoResponse(true, true), await manager.GetDebugMemoryFileInfoAsync(new DebugMemoryFileInfoRequest(sessionId, (long)address), Token));

			// A ReadyToRun framework assembly is mapped section by section: an RVA is an offset from its base.
			var coreLib = debugManager.FindProcessMemory(sessionId)!.GetModules().Single(m => m.Name == "System.Private.CoreLib.dll");
			Assert.Equal(DebugImageLayout.Memory, coreLib.ImageLayout);
			var coreLibRva = await manager.ResolveDebugMemoryPositionAsync(new DebugMemoryResolvePositionRequest(sessionId, (long)coreLib.Address, "rva", 0x2008), Token);
			Assert.Equal((long)coreLib.Address + 0x2008, coreLibRva.Offset);
			var coreLibToolTip = await manager.GetDebugMemoryToolTipInfoAsync(new DebugMemoryPositionRequest(sessionId, (long)coreLib.Address), Token);
			Assert.Equal("IMAGE_DOS_HEADER.e_magic = 0x5A4D (23117)", Text(Assert.Single(Assert.IsType<HexToolTipDto>(coreLibToolTip.ToolTip).Sections)));
			Assert.Equal(new DebugMemoryFileInfoResponse(true, true), await manager.GetDebugMemoryFileInfoAsync(new DebugMemoryFileInfoRequest(sessionId, (long)coreLib.Address + 0x10), Token));
		}
		finally {
			await debugManager.DisconnectAsync(new DebugDisconnectRequest(sessionId, TerminateDebuggee: true), CancellationToken.None);
		}
		// The session has ended, and its model with it.
		await Assert.ThrowsAsync<RpcException>(() => manager.GetDebugMemoryToolTipInfoAsync(new DebugMemoryPositionRequest(sessionId, 0), Token));
	}

	// ---------------------------------------------------------------- encodings

	[Fact]
	public void TheEncodingListHasEveryCodePageSortedByDisplayName() {
		var encodings = TextEncodings.GetEncodings().Encodings;
		Assert.Contains(encodings, encoding => encoding.CodePage == 65001);
		// The Windows code pages .NET Framework has are there too.
		Assert.Contains(encodings, encoding => encoding.CodePage == 1252);
		Assert.Contains(encodings, encoding => encoding.CodePage == 936);
		var names = encodings.Select(encoding => encoding.DisplayName).ToArray();
		Assert.Equal(names.Order(StringComparer.CurrentCultureIgnoreCase), names);
	}

	[Fact]
	public void TextIsEncodedWithTheCodePage() {
		Assert.Equal([0x80], Bytes(TextEncodings.Encode(new EncodeTextRequest(1252, "€"))));
		Assert.Equal([0xD6, 0xD0], Bytes(TextEncodings.Encode(new EncodeTextRequest(936, "中"))));
		Assert.Equal([0x00, 0x41, 0x4E, 0x2D], Bytes(TextEncodings.Encode(new EncodeTextRequest(1201, "A中"))));
		Assert.Equal(Encoding.UTF8.GetBytes("é"), Bytes(TextEncodings.Encode(new EncodeTextRequest(65001, "é"))));
		var error = Assert.Throws<RpcException>(() => TextEncodings.Encode(new EncodeTextRequest(123456, "x")));
		Assert.Equal(ErrorCodes.InvalidParams, error.Code);
	}

	[Theory]
	[InlineData(20127, "A😀中")]
	[InlineData(28591, "A😀中")]
	[InlineData(1200, "A\uD800")]
	[InlineData(65001, "A\uD800")]
	[InlineData(932, "日本語")]
	public void EncodingUsesTheDotNetReplacementFallback(int codePage, string text) {
		var response = TextEncodings.Encode(new EncodeTextRequest(codePage, text));
		Assert.Equal(Encoding.GetEncoding(codePage).GetBytes(text), Bytes(response));
	}

	static byte[] Bytes(EncodeTextResponse response) => Convert.FromBase64String(response.Base64Data);
}
