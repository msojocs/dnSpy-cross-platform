using System.Runtime.InteropServices;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using dnSpy.Backend.Debugging.CorDebug;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The Memory window's buffer over a process's whole address space: the regions the system says are readable
/// (HexProcessSimpleBufferStream.GetSpanInfo), dnSpy's GetNextValidSpan / GetPreviousValidSpan over them, and the hex
/// search that only reads the readable ones.
/// </summary>
public sealed class DebugMemoryRegionTests : IDisposable {
	readonly WorkspaceManager manager = new();

	static CancellationToken Token => TestContext.Current.CancellationToken;

	public void Dispose() => manager.Dispose();

	/// <summary>A 32-bit process with readable regions at 0x1000-0x3000, 0x3000-0x4000 (one run) and 0x8000-0x9000.</summary>
	sealed class FakeProcess : IDebugMemoryProvider, IDebugProcessMemory, IDebugProcessMemoryRegions {
		public readonly DebugMemoryRegion[] Mapped = [new(0x1000, 0x3000, true), new(0x3000, 0x4000, true), new(0x6000, 0x7000, false), new(0x8000, 0x9000, true)];

		public string SessionId => "fake";
		public string? WorkspaceId => null;
		public int ProcessId => 4321;
		public bool IsStopped => true;
		public int Generation => 1;
		public int ModuleListVersion => 1;
		public IReadOnlyList<DebugProcessModule> GetModules() => [];

		public ulong AddressSpaceEnd => 1UL << 32;

		public DebugMemoryRegion? GetRegion(ulong address) => CorDebugSession.RegionAt(Mapped, address, AddressSpaceEnd);

		/// <summary>A readable byte is its address's low byte; a read stops at the first byte that cannot be read.</summary>
		public int ReadMemory(ulong address, byte[] buffer) {
			for (var i = 0; i < buffer.Length; i++) {
				if (GetRegion(address + (ulong)i) is not { IsReadable: true })
					return i;
				buffer[i] = (byte)(address + (ulong)i);
			}
			return buffer.Length;
		}

		public IDebugProcessMemory? FindProcessMemory(string sessionId) => sessionId == SessionId ? this : null;

		public event EventHandler<string>? SessionEnded { add { } remove { } }
	}

	FakeProcess CreateProcess() {
		var process = new FakeProcess();
		manager.DebugMemory = process;
		return process;
	}

	Task<DebugMemoryValidSpanResponse> SpanAsync(long position, long bounds, bool forward, bool fullSpan = false) =>
		manager.GetDebugMemoryValidSpanAsync(new DebugMemoryValidSpanRequest("fake", position, bounds, forward, fullSpan), Token);

	[Fact]
	public void LinuxMappingsAreReadAsRegionsWithTheGapsBetweenThem() {
		var regions = CorDebugSession.ParseLinuxMappings([
			"00400000-00452000 r-xp 00000000 08:02 173521      /usr/bin/dbus-daemon",
			"00651000-00652000 ---p 00051000 08:02 173521      /usr/bin/dbus-daemon",
			"00652000-00655000 rw-p 00052000 08:02 173521      /usr/bin/dbus-daemon",
			"ffffffffff600000-ffffffffff601000 --xp 00000000 00:00 0                  [vsyscall]",
		], 1UL << 47);

		Assert.Equal([new DebugMemoryRegion(0x400000, 0x452000, true), new DebugMemoryRegion(0x651000, 0x652000, false), new DebugMemoryRegion(0x652000, 0x655000, true)], regions);
		Assert.Equal(new DebugMemoryRegion(0, 0x400000, false), CorDebugSession.RegionAt(regions, 0x1234, 1UL << 47));
		Assert.Equal(new DebugMemoryRegion(0x452000, 0x651000, false), CorDebugSession.RegionAt(regions, 0x500000, 1UL << 47));
		Assert.Equal(new DebugMemoryRegion(0x652000, 0x655000, true), CorDebugSession.RegionAt(regions, 0x654FFF, 1UL << 47));
		Assert.Equal(new DebugMemoryRegion(0x655000, 1UL << 47, false), CorDebugSession.RegionAt(regions, 0x655000, 1UL << 47));
	}

	[Fact]
	public void TheRegionOfThisProcessHoldingAPinnedArrayIsReadable() {
		if (!OperatingSystem.IsLinux())
			return;
		var data = new byte[64];
		var handle = GCHandle.Alloc(data, GCHandleType.Pinned);
		try {
			var address = (ulong)handle.AddrOfPinnedObject();
			var regions = CorDebugSession.ReadLinuxMappings(Environment.ProcessId, ulong.MaxValue);
			Assert.NotNull(regions);
			var region = CorDebugSession.RegionAt(regions, address, ulong.MaxValue);
			Assert.True(region.IsReadable);
			Assert.InRange(address, region.Start, region.End - 1);
		}
		finally {
			handle.Free();
		}
	}

	[Fact]
	public async Task TheBufferIsTheAddressSpace() {
		CreateProcess();
		var space = await manager.GetDebugMemorySpaceAsync(new DebugMemorySpaceRequest("fake"), Token);
		Assert.Equal(1L << 32, space.End);
	}

	[Fact]
	public async Task NextValidSpansMergeConsecutiveRegions() {
		CreateProcess();
		Assert.Equal(new DebugMemoryValidSpanResponse(0x1000, 0x4000), await SpanAsync(0, 1L << 32, forward: true));
		// Inside a run the span still starts at the run's region, unless the full span is asked for.
		Assert.Equal(new DebugMemoryValidSpanResponse(0x3000, 0x4000), await SpanAsync(0x3800, 1L << 32, forward: true));
		Assert.Equal(new DebugMemoryValidSpanResponse(0x1000, 0x4000), await SpanAsync(0x3800, 1L << 32, forward: true, fullSpan: true));
		Assert.Equal(new DebugMemoryValidSpanResponse(0x8000, 0x9000), await SpanAsync(0x4000, 1L << 32, forward: true));
		// Nothing readable before the bounds, or after the last region.
		Assert.Equal(new DebugMemoryValidSpanResponse(null, null), await SpanAsync(0x4000, 0x8000, forward: true));
		Assert.Equal(new DebugMemoryValidSpanResponse(null, null), await SpanAsync(0x9000, 1L << 32, forward: true));
	}

	[Fact]
	public async Task PreviousValidSpansGoBackToTheStartOfTheRun() {
		CreateProcess();
		Assert.Equal(new DebugMemoryValidSpanResponse(0x1000, 0x3000), await SpanAsync(0x2000, 0, forward: false));
		Assert.Equal(new DebugMemoryValidSpanResponse(0x1000, 0x4000), await SpanAsync(0x3800, 0, forward: false));
		Assert.Equal(new DebugMemoryValidSpanResponse(0x1000, 0x4000), await SpanAsync(0x7000, 0, forward: false));
		Assert.Equal(new DebugMemoryValidSpanResponse(null, null), await SpanAsync(0xFFF, 0, forward: false));
	}

	static DebugMemorySearchRequest Search(byte[] pattern, long start, bool reverse = false, bool wrap = false, int maxResults = 100) =>
		new("fake", Convert.ToBase64String(pattern), null, null, null, 0, 1L << 32, start, reverse, wrap, false, maxResults);

	[Fact]
	public async Task SearchReadsOnlyTheReadableMemory() {
		CreateProcess();
		// 0x00 0x01 is at the start of every 256 bytes that can be read; the zeros past the regions are not searched.
		var forward = await manager.SearchDebugMemoryAsync(Search([0x00, 0x01], 0), Token);
		Assert.Equal(Enumerable.Range(0, 0x30).Select(i => 0x1000L + i * 0x100).Concat(Enumerable.Range(0, 0x10).Select(i => 0x8000L + i * 0x100)), forward.Offsets);

		// A match may lie across two regions of one run, but not across a gap.
		var acrossRun = await manager.SearchDebugMemoryAsync(Search([0xFF, 0x00], 0x2F00), Token);
		Assert.Contains(0x2FFFL, acrossRun.Offsets);
		Assert.DoesNotContain(0x3FFFL, acrossRun.Offsets);

		var reverse = await manager.SearchDebugMemoryAsync(Search([0x00, 0x01], 0x8101, reverse: true, maxResults: 3), Token);
		Assert.Equal([0x8100L, 0x8000L, 0x3F00L], reverse.Offsets);
	}
}
