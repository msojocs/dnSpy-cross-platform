using System.Globalization;
using System.Runtime.InteropServices;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>
/// The process's address space as WPF's HexProcessSimpleBufferStream sees it: its span (GetDefaultSpan) and the region
/// around an address (GetSpanInfo). Windows asks VirtualQueryEx as WPF does; Linux reads the process's mappings, a
/// region being readable when it is mapped with read access. Elsewhere the system is not asked and the Memory window
/// falls back on reading a page at a time.
/// </summary>
internal sealed partial class CorDebugSession : IDebugProcessMemoryRegions {
	ulong? addressSpaceEnd;

	/// <summary>
	/// GetDefaultSpan: 2^32 for a 32-bit process; for a 64-bit one the highest user address rounded up to an even
	/// address, which is 2^47 on x64 (Windows and Linux alike) and 2^48 with ARM64's 48-bit user space.
	/// </summary>
	ulong IDebugProcessMemoryRegions.AddressSpaceEnd => addressSpaceEnd ??= CorDebugSessionManager.ReadArchitecture(TargetProcessId) switch {
		"x86" or "ARM" => 1UL << 32,
		"ARM64" => 1UL << 48,
		_ => 1UL << 47,
	};

	/// <summary>The mappings read for one stop: while the process is stopped they stay what they were.</summary>
	volatile LinuxMappings? linuxMappings;

	sealed record LinuxMappings(int Generation, int ModuleListVersion, DebugMemoryRegion[] Regions);

	DebugMemoryRegion? IDebugProcessMemoryRegions.GetRegion(ulong address) {
		var end = ((IDebugProcessMemoryRegions)this).AddressSpaceEnd;
		if (address >= end)
			return new DebugMemoryRegion(end, ulong.MaxValue, false);
		if (disposed || HasExited)
			return new DebugMemoryRegion(0, end, false);
		if (OperatingSystem.IsWindows())
			return WindowsRegion(address, end);
		if (OperatingSystem.IsLinux())
			return LinuxRegion(address, end);
		return null;
	}

	DebugMemoryRegion? LinuxRegion(ulong address, ulong end) {
		var mappings = linuxMappings;
		if (mappings is null || mappings.Generation != Generation || mappings.ModuleListVersion != Modules.Version || !IsStopped) {
			var regions = ReadLinuxMappings(TargetProcessId, end);
			if (regions is null)
				return null;
			mappings = new LinuxMappings(Generation, Modules.Version, regions);
			linuxMappings = IsStopped ? mappings : null;
		}
		return RegionAt(mappings.Regions, address, end);
	}

	/// <summary>The region holding an address among sorted mappings, or the gap between two of them.</summary>
	internal static DebugMemoryRegion RegionAt(DebugMemoryRegion[] regions, ulong address, ulong end) {
		int lo = 0, hi = regions.Length - 1;
		while (lo <= hi) {
			var mid = lo + (hi - lo) / 2;
			if (address < regions[mid].Start)
				hi = mid - 1;
			else if (address >= regions[mid].End)
				lo = mid + 1;
			else
				return regions[mid];
		}
		// lo is the first mapping after the address: the gap runs from the one before it to it.
		var gapStart = lo > 0 ? regions[lo - 1].End : 0;
		var gapEnd = lo < regions.Length ? regions[lo].Start : end;
		return new DebugMemoryRegion(gapStart, gapEnd, false);
	}

	/// <summary>
	/// <c>/proc/&lt;pid&gt;/maps</c>: each line <c>start-end perms offset dev inode [path]</c>, in address order. A mapping
	/// with <c>r</c> access can be read. Mappings past the user space (the vsyscall page) are left out.
	/// </summary>
	internal static DebugMemoryRegion[]? ReadLinuxMappings(int processId, ulong end) {
		try {
			return ParseLinuxMappings(File.ReadLines($"/proc/{processId}/maps"), end);
		}
		catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) {
			return null;
		}
	}

	internal static DebugMemoryRegion[] ParseLinuxMappings(IEnumerable<string> lines, ulong end) {
		var regions = new List<DebugMemoryRegion>();
		foreach (var line in lines) {
			var dash = line.IndexOf('-');
			var space = line.IndexOf(' ');
			if (dash <= 0 || space <= dash || space + 1 >= line.Length)
				continue;
			if (!ulong.TryParse(line.AsSpan(0, dash), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var start)
				|| !ulong.TryParse(line.AsSpan(dash + 1, space - dash - 1), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var stop)
				|| stop <= start || start >= end)
				continue;
			stop = Math.Min(stop, end);
			if (regions.Count > 0 && start < regions[^1].End)
				continue;
			regions.Add(new DebugMemoryRegion(start, stop, line[space + 1] == 'r'));
		}
		return regions.ToArray();
	}

	DebugMemoryRegion? WindowsRegion(ulong address, ulong end) {
		var process = OpenProcess(PROCESS_QUERY_INFORMATION, false, (uint)TargetProcessId);
		if (process == IntPtr.Zero)
			return null;
		try {
			if (VirtualQueryEx(process, (IntPtr)(long)address, out var info, (IntPtr)Marshal.SizeOf<MEMORY_BASIC_INFORMATION64>()) == IntPtr.Zero)
				return new DebugMemoryRegion(0, end, false);
			// GetSpanInfo: committed memory that is neither no-access nor a guard page has data.
			var access = info.Protect & 0xFF;
			var readable = info.State == MEM_COMMIT && access != PAGE_NOACCESS && (info.Protect & PAGE_GUARD) == 0;
			return new DebugMemoryRegion(info.BaseAddress, info.BaseAddress + info.RegionSize, readable);
		}
		finally {
			CloseHandle(process);
		}
	}

	const uint PROCESS_QUERY_INFORMATION = 0x0400;
	const uint MEM_COMMIT = 0x1000;
	const uint PAGE_NOACCESS = 0x01;
	const uint PAGE_GUARD = 0x100;

	[StructLayout(LayoutKind.Sequential)]
	struct MEMORY_BASIC_INFORMATION64 {
		public ulong BaseAddress;
		public ulong AllocationBase;
		public uint AllocationProtect;
		public uint __alignment1;
		public ulong RegionSize;
		public uint State;
		public uint Protect;
		public uint Type;
		public uint __alignment2;
	}

	[DllImport("kernel32", SetLastError = true)]
	static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

	[DllImport("kernel32", SetLastError = true)]
	static extern bool CloseHandle(IntPtr hObject);

	[DllImport("kernel32", SetLastError = true)]
	static extern IntPtr VirtualQueryEx(IntPtr hProcess, IntPtr lpAddress, out MEMORY_BASIC_INFORMATION64 lpBuffer, IntPtr dwLength);
}
