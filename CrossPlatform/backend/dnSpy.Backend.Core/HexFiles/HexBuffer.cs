using System.Buffers.Binary;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core.HexFiles {
	/// <summary>
	/// The bytes the hex structure model reads, cut down to what <c>dnSpy.Hex.Files</c> reads of dnSpy's WPF
	/// <c>HexBuffer</c>: a read-only buffer over a <see cref="HexBufferSource"/> — a document's file with its hex patches
	/// laid over it (<see cref="FileHexBufferSource"/>), or a debugged process's memory (<see cref="ProcessMemoryHexBufferSource"/>),
	/// the Memory window's buffer.
	/// </summary>
	/// <remarks>
	/// The source is read a page at a time, and a page is read once: a model is cached only for as long as the bytes
	/// it was built from stay what they were, so a page holds them as they were when it was read. A page the source
	/// cannot read is remembered as unreadable: its bytes read as zeros and <see cref="TryReadByte"/> answers -1 for
	/// them, as WPF's cached buffer stream does for memory it could not read.
	/// </remarks>
	sealed class HexBuffer {
		readonly HexBufferSource source;
		readonly int pageShift;
		readonly ulong pageSize;
		readonly Dictionary<ulong, byte[]?> pages = [];

		public HexBuffer(WorkspaceManager.IModuleEntry entry)
			: this(new FileHexBufferSource(entry)) {
		}

		public HexBuffer(HexBufferSource source) {
			this.source = source ?? throw new ArgumentNullException(nameof(source));
			pageShift = source.PageShift;
			pageSize = 1UL << pageShift;
			Span = source.Span;
			Name = source.Name;
		}

		/// <summary>dnSpy's <c>HexBuffer.Properties</c>, where the services built over a buffer keep themselves.</summary>
		public PropertyCollection Properties { get; } = new PropertyCollection();

		/// <summary>The positions the buffer has: a file buffer starts at 0 and is as long as the file; a process's
		/// buffer is its whole address space.</summary>
		public HexSpan Span { get; }

		public string Name { get; }

		/// <summary>Whether the buffer is a process's memory, where a PE image is normally in memory layout.</summary>
		public bool IsMemory => source.IsMemory;

		/// <summary>
		/// dnSpy's <c>HexBuffer.GetSpanInfo</c>: the span around a position whose bytes are all readable or all not. A
		/// file's every byte is there to be read (<c>ByteArrayHexBufferStream.GetSpanInfo</c>); a process's memory is
		/// answered a page at a time, readable when the page could be read.
		/// </summary>
		public HexSpanInfo GetSpanInfo(HexPosition position) {
			if (position >= HexPosition.MaxEndPosition)
				throw new ArgumentOutOfRangeException(nameof(position));
			if (position >= Span.End)
				return new HexSpanInfo(HexSpan.FromBounds(Span.End, HexPosition.MaxEndPosition), HexSpanInfoFlags.None);
			if (position < Span.Start)
				return new HexSpanInfo(HexSpan.FromBounds(HexPosition.Zero, Span.Start), HexSpanInfoFlags.None);
			if (!source.HasUnreadableBytes)
				return new HexSpanInfo(Span, HexSpanInfoFlags.HasData);
			var index = position.ToUInt64() >> pageShift;
			var pageStart = new HexPosition(index << pageShift);
			var pageEnd = HexPosition.Min(pageStart + pageSize, Span.End);
			var start = HexPosition.Max(pageStart, Span.Start);
			return new HexSpanInfo(HexSpan.FromBounds(start, pageEnd), GetPage(index) is null ? HexSpanInfoFlags.None : HexSpanInfoFlags.HasData);
		}

		public int TryReadByte(HexPosition position) {
			if (position >= Span.End || position < Span.Start)
				return -1;
			var offset = position.ToUInt64();
			var page = GetPage(offset >> pageShift);
			var index = (int)(offset & (pageSize - 1));
			return page is null || index >= page.Length ? -1 : page[index];
		}

		public byte ReadByte(HexPosition position) {
			var value = TryReadByte(position);
			return value < 0 ? (byte)0 : (byte)value;
		}

		public sbyte ReadSByte(HexPosition position) => (sbyte)ReadByte(position);

		public char ReadChar(HexPosition position) => (char)ReadUInt16(position);

		public short ReadInt16(HexPosition position) {
			Span<byte> data = stackalloc byte[2];
			Read(position, data);
			return BinaryPrimitives.ReadInt16LittleEndian(data);
		}

		public ushort ReadUInt16(HexPosition position) {
			Span<byte> data = stackalloc byte[2];
			Read(position, data);
			return BinaryPrimitives.ReadUInt16LittleEndian(data);
		}

		public int ReadInt32(HexPosition position) {
			Span<byte> data = stackalloc byte[4];
			Read(position, data);
			return BinaryPrimitives.ReadInt32LittleEndian(data);
		}

		public uint ReadUInt32(HexPosition position) {
			Span<byte> data = stackalloc byte[4];
			Read(position, data);
			return BinaryPrimitives.ReadUInt32LittleEndian(data);
		}

		public long ReadInt64(HexPosition position) {
			Span<byte> data = stackalloc byte[8];
			Read(position, data);
			return BinaryPrimitives.ReadInt64LittleEndian(data);
		}

		public ulong ReadUInt64(HexPosition position) {
			Span<byte> data = stackalloc byte[8];
			Read(position, data);
			return BinaryPrimitives.ReadUInt64LittleEndian(data);
		}

		public float ReadSingle(HexPosition position) {
			Span<byte> data = stackalloc byte[4];
			Read(position, data);
			return BinaryPrimitives.ReadSingleLittleEndian(data);
		}

		public double ReadDouble(HexPosition position) {
			Span<byte> data = stackalloc byte[8];
			Read(position, data);
			return BinaryPrimitives.ReadDoubleLittleEndian(data);
		}

		public byte[] ReadBytes(HexPosition position, long length) {
			if (length < 0)
				throw new ArgumentOutOfRangeException(nameof(length));
			return ReadBytes(position, (ulong)length);
		}

		public byte[] ReadBytes(HexPosition position, ulong length) {
			if (length > int.MaxValue)
				throw new ArgumentOutOfRangeException(nameof(length));
			var result = new byte[(int)length];
			Read(position, result);
			return result;
		}

		public byte[] ReadBytes(HexSpan span) => ReadBytes(span.Start, span.Length.ToUInt64());

		public void ReadBytes(HexPosition position, byte[] destination) {
			ArgumentNullException.ThrowIfNull(destination);
			Read(position, destination);
		}

		public void ReadBytes(HexPosition position, byte[] destination, long destinationIndex, long length) {
			ArgumentNullException.ThrowIfNull(destination);
			if (destinationIndex < 0 || length < 0 || destinationIndex + length > destination.LongLength)
				throw new ArgumentOutOfRangeException(nameof(destinationIndex));
			Read(position, destination.AsSpan((int)destinationIndex, (int)length));
		}

		/// <summary>Fills <paramref name="destination"/> from <paramref name="position"/> on; whatever lies outside the
		/// buffer or in a page that could not be read reads as zeros.</summary>
		public void Read(HexPosition position, Span<byte> destination) {
			destination.Clear();
			var done = 0;
			while (done < destination.Length) {
				var at = position + (ulong)done;
				if (at >= Span.End)
					break;
				var offset = at.ToUInt64();
				var index = (int)(offset & (pageSize - 1));
				var count = (int)Math.Min((ulong)(destination.Length - done), pageSize - (ulong)index);
				if (at >= Span.Start && GetPage(offset >> pageShift) is { } page && index < page.Length)
					page.AsSpan(index, Math.Min(count, page.Length - index)).CopyTo(destination[done..]);
				done += count;
			}
		}

		byte[]? GetPage(ulong index) {
			if (pages.TryGetValue(index, out var page))
				return page;
			page = source.ReadPage(new HexPosition(index << pageShift), (int)pageSize);
			pages.Add(index, page);
			return page;
		}
	}

	/// <summary>Where a <see cref="HexBuffer"/>'s bytes come from.</summary>
	abstract class HexBufferSource {
		/// <summary>The positions the buffer has.</summary>
		public abstract HexSpan Span { get; }

		public abstract string Name { get; }

		public abstract bool IsMemory { get; }

		/// <summary>The size of the pages the source is read in, as a power of two.</summary>
		public abstract int PageShift { get; }

		/// <summary>False when every byte of <see cref="Span"/> can be read.</summary>
		public abstract bool HasUnreadableBytes { get; }

		/// <summary>The bytes of the page at <paramref name="start"/> (at most <paramref name="size"/> of them, fewer at
		/// the end of a file), or null when the page cannot be read.</summary>
		public abstract byte[]? ReadPage(HexPosition start, int size);
	}

	/// <summary>
	/// One document's file with its hex patches laid over it, the same image <see cref="PatchedFileReader"/> and every
	/// other reader of the document see. dnSpy's WPF hex editor reads its structures out of the <c>HexBuffer</c> that holds
	/// the user's edits (a <c>ByteArrayHexBufferStream</c> over the whole file). A read past the end of the file reads
	/// zeros, which is what <c>ByteArrayHexBufferStream</c> answers too. The file is opened for each page it reads rather
	/// than held open, so a cached model never keeps a handle on a file a save wants to replace.
	/// </summary>
	sealed class FileHexBufferSource : HexBufferSource {
		readonly WorkspaceManager.IModuleEntry entry;
		readonly string path;
		readonly long length;

		public FileHexBufferSource(WorkspaceManager.IModuleEntry entry) {
			this.entry = entry;
			path = entry.Path;
			length = Math.Max(0, entry.FileLength);
			Span = new HexSpan(HexPosition.Zero, (ulong)length);
		}

		public override HexSpan Span { get; }

		public override string Name => path;

		/// <summary>A file is never a process's memory, so its PE image is always in file layout.</summary>
		public override bool IsMemory => false;

		public override int PageShift => 16;

		public override bool HasUnreadableBytes => false;

		public override byte[] ReadPage(HexPosition start, int size) {
			var offset = (long)start.ToUInt64();
			var page = new byte[(int)Math.Clamp(length - offset, 0, size)];
			if (page.Length == 0)
				return page;
			try {
				using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 4096, FileOptions.RandomAccess);
				stream.Position = offset;
				stream.ReadAtLeast(page, page.Length, throwOnEndOfStream: false);
			}
			catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) {
				throw new RpcException(ErrorCodes.SaveFailed, $"The file could not be read: {ex.Message}");
			}
			HexPatchList.Overlay(entry, offset, page);
			return page;
		}
	}

	/// <summary>
	/// A debugged process's memory — the Memory window's buffer (WPF's <c>HexProcessSimpleBufferStream</c> behind a
	/// cached stream). Its span is the whole address space; a page is readable when the process gave all of it, which
	/// is how the debugger's own <c>readMemory</c> answers too. WPF asks the OS for the memory regions; a page is what
	/// the debugger can ask about here.
	/// </summary>
	sealed class ProcessMemoryHexBufferSource(IDebugProcessMemory memory) : HexBufferSource {
		public override HexSpan Span { get; } = HexSpan.FromBounds(HexPosition.Zero, HexPosition.MaxEndPosition);

		public override string Name { get; } = $"<MEMORY: pid {memory.ProcessId}>";

		public override bool IsMemory => true;

		public override int PageShift => 12;

		public override bool HasUnreadableBytes => true;

		public override byte[]? ReadPage(HexPosition start, int size) {
			var page = new byte[size];
			return memory.ReadMemory(start.ToUInt64(), page) == size ? page : null;
		}
	}
}
