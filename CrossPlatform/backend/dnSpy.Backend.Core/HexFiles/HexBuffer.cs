using System.Buffers.Binary;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core.HexFiles {
	/// <summary>
	/// The bytes the hex structure model reads: one document's file with its hex patches laid over it, the same
	/// image <see cref="PatchedFileReader"/> and every other reader of the document see. dnSpy's WPF hex editor reads
	/// its structures out of the <c>HexBuffer</c> that holds the user's edits (a <c>ByteArrayHexBufferStream</c> over
	/// the whole file); this is that buffer cut down to what <c>dnSpy.Hex.Files</c> reads — a read-only file buffer
	/// whose span is the file and whose every byte is valid. A read past the end of the file reads zeros, which is
	/// what <c>ByteArrayHexBufferStream</c> answers too.
	/// </summary>
	/// <remarks>
	/// The file is read a page at a time, and a page is read once: the model is cached for as long as the document's
	/// bytes stay what they were (<see cref="HexStructureModel"/>), so a page holds the patches as they were when it
	/// was read. The file is opened for each page it reads rather than held open, so a cached model never keeps a
	/// handle on a file a save wants to replace.
	/// </remarks>
	sealed class HexBuffer {
		const int PageShift = 16;
		const int PageSize = 1 << PageShift;
		readonly WorkspaceManager.IModuleEntry entry;
		readonly string path;
		readonly long length;
		readonly Dictionary<long, byte[]> pages = [];

		public HexBuffer(WorkspaceManager.IModuleEntry entry) {
			this.entry = entry;
			path = entry.Path;
			length = Math.Max(0, entry.FileLength);
			Span = new HexSpan(HexPosition.Zero, (ulong)length);
			Name = path;
		}

		/// <summary>dnSpy's <c>HexBuffer.Properties</c>, where the services built over a buffer keep themselves.</summary>
		public PropertyCollection Properties { get; } = new PropertyCollection();

		/// <summary>The whole file: a file buffer starts at 0 and is as long as the file.</summary>
		public HexSpan Span { get; }

		public string Name { get; }

		/// <summary>A file is never a process's memory, so its PE image is always in file layout.</summary>
		public bool IsMemory => false;

		/// <summary>Every byte inside the file is there to be read (<c>ByteArrayHexBufferStream.GetSpanInfo</c>).</summary>
		public HexSpanInfo GetSpanInfo(HexPosition position) {
			if (position >= HexPosition.MaxEndPosition)
				throw new ArgumentOutOfRangeException(nameof(position));
			if (position >= Span.End)
				return new HexSpanInfo(HexSpan.FromBounds(Span.End, HexPosition.MaxEndPosition), HexSpanInfoFlags.None);
			return new HexSpanInfo(Span, HexSpanInfoFlags.HasData);
		}

		public int TryReadByte(HexPosition position) {
			if (position >= Span.End)
				return -1;
			var offset = (long)position.ToUInt64();
			return GetPage(offset >> PageShift)[(int)(offset & (PageSize - 1))];
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

		/// <summary>Fills <paramref name="destination"/> from <paramref name="position"/> on; whatever lies past the end of
		/// the file reads as zeros.</summary>
		public void Read(HexPosition position, Span<byte> destination) {
			destination.Clear();
			if (position >= Span.End)
				return;
			var offset = (long)position.ToUInt64();
			var done = 0;
			while (done < destination.Length && offset + done < length) {
				var at = offset + done;
				var page = GetPage(at >> PageShift);
				var index = (int)(at & (PageSize - 1));
				var count = Math.Min(destination.Length - done, page.Length - index);
				if (count <= 0)
					break;
				page.AsSpan(index, count).CopyTo(destination[done..]);
				done += count;
			}
		}

		byte[] GetPage(long index) {
			if (pages.TryGetValue(index, out var page))
				return page;
			var start = index << PageShift;
			var size = (int)Math.Clamp(length - start, 0, PageSize);
			page = new byte[size];
			if (size > 0) {
				try {
					using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 4096, FileOptions.RandomAccess);
					stream.Position = start;
					stream.ReadAtLeast(page, page.Length, throwOnEndOfStream: false);
				}
				catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) {
					throw new RpcException(ErrorCodes.SaveFailed, $"The file could not be read: {ex.Message}");
				}
				HexPatchList.Overlay(entry, start, page);
			}
			pages.Add(index, page);
			return page;
		}
	}
}
