using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>
/// The session's process as the Memory window's structures read it: its loaded modules the way dnSpy's
/// BufferFileCreator turns them into buffer files, and its memory.
/// </summary>
internal sealed partial class CorDebugSession : IDebugProcessMemory {
	string IDebugProcessMemory.SessionId => Id;

	int IDebugProcessMemory.ProcessId => TargetProcessId;

	int IDebugProcessMemory.ModuleListVersion => Modules.Version;

	/// <summary>
	/// The modules with an address (WPF's <c>DbgModule.HasAddress</c>), named as dnSpy's CorDebug ModuleCreator names
	/// them — the file's name, and the path the runtime gave — with the layout of their image (<see cref="ImageLayout"/>).
	/// </summary>
	IReadOnlyList<DebugProcessModule> IDebugProcessMemory.GetModules() =>
		Modules.Entries()
			.Where(entry => entry.Address != 0 && entry.Size != 0)
			.Select(entry => new DebugProcessModule(entry.Address, entry.Size, entry.Name, entry.Path, ImageLayout(entry)))
			.ToArray();

	readonly System.Runtime.CompilerServices.ConditionalWeakTable<ModuleTable.ModuleEntry, object> imageLayouts = new();

	/// <summary>
	/// dnSpy's CorDebug ModuleCreator.CalculateImageLayout: a dynamic module has no known layout and a module loaded from
	/// bytes is in file layout. A module loaded from disk is in memory layout under the Windows loader, which is all WPF
	/// knows; CoreCLR on Linux and macOS maps an IL-only file as it is (a flat layout, as long as the file) and only maps
	/// a ReadyToRun image section by section. So the image's own SizeOfImage decides: a module as long as its image
	/// was mapped, one that is not was not, and one whose file happens to be as long as its image too is left to the
	/// structure readers' guess, which looks for the .NET header where each layout puts it.
	/// </summary>
	DebugImageLayout ImageLayout(ModuleTable.ModuleEntry entry) {
		if (entry.IsDynamic)
			return DebugImageLayout.Unknown;
		if (entry.IsInMemory)
			return DebugImageLayout.File;
		if (imageLayouts.TryGetValue(entry, out var known))
			return (DebugImageLayout)known;
		var headers = new byte[0x200];
		// Headers that cannot be read now may be read later; the guess is only kept once they have been.
		if (((IDebugProcessMemory)this).ReadMemory(entry.Address, headers) != headers.Length)
			return DebugImageLayout.Unknown;
		var layout = SizeOfImage(headers) is not { } sizeOfImage ? DebugImageLayout.Unknown
			: sizeOfImage != entry.Size ? DebugImageLayout.File
			: FileLength(entry.Path) == entry.Size ? DebugImageLayout.Unknown
			: DebugImageLayout.Memory;
		imageLayouts.AddOrUpdate(entry, layout);
		return layout;
	}

	/// <summary>The optional header's SizeOfImage, at the same offset in PE32 and PE32+.</summary>
	static uint? SizeOfImage(byte[] headers) {
		if (headers[0] != (byte)'M' || headers[1] != (byte)'Z')
			return null;
		var ntHeaders = BitConverter.ToInt32(headers, 0x3C);
		if (ntHeaders < 0 || ntHeaders + 24 + 60 > headers.Length || BitConverter.ToUInt32(headers, ntHeaders) != 0x4550)
			return null;
		return BitConverter.ToUInt32(headers, ntHeaders + 24 + 56);
	}

	static long FileLength(string path) {
		try {
			return string.IsNullOrEmpty(path) ? -1 : new FileInfo(path).Length;
		}
		catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) {
			return -1;
		}
	}

	int IDebugProcessMemory.ReadMemory(ulong address, byte[] buffer) {
		ArgumentNullException.ThrowIfNull(buffer);
		if (disposed || HasExited || buffer.Length == 0)
			return 0;
		try {
			return Dispatcher.Invoke(() => {
				var bytes = ReadMemoryCore(address, buffer.Length);
				if (bytes is null)
					return 0;
				var count = Math.Min(bytes.Length, buffer.Length);
				Array.Copy(bytes, buffer, count);
				return count;
			});
		}
		catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException or TaskCanceledException) {
			// The session ended while the read was on its way.
			return 0;
		}
	}
}
