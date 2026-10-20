using Microsoft.Win32.SafeHandles;

namespace dnSpy.Backend.Core.HexFiles {
	/// <summary>
	/// What one search looks for — the pattern of dnSpy's ByteHexSearchService (bytes and a mask) or of its
	/// StringHexSearchService (the lower- and upper-case encodings of a string and the bytes each character takes,
	/// which Utf8StringHexSearchService and Utf16StringHexSearchService fill in). The client encodes the text the user
	/// typed; this is the matcher.
	/// </summary>
	sealed class HexSearchPattern {
		readonly byte[] pattern;
		readonly byte[]? mask;
		readonly byte[]? upper;
		readonly int[]? charLengths;

		/// <summary>A byte search: a byte matches when <c>(data &amp; mask) == (pattern &amp; mask)</c>.</summary>
		public HexSearchPattern(byte[] pattern, byte[]? mask) {
			ArgumentNullException.ThrowIfNull(pattern);
			if (pattern.Length == 0)
				throw new ArgumentOutOfRangeException(nameof(pattern));
			if (mask is not null && mask.Length != pattern.Length)
				throw new ArgumentOutOfRangeException(nameof(mask));
			// ByteHexSearchService compares the masked data with the pattern as it was parsed, which is already masked.
			if (mask is not null && mask.All(b => b == 0xFF))
				mask = null;
			this.pattern = mask is null ? pattern : pattern.Select((b, i) => (byte)(b & mask[i])).ToArray();
			this.mask = mask;
		}

		/// <summary>A case-insensitive string search: every character equals either its lower- or its upper-case bytes.</summary>
		public HexSearchPattern(byte[] lower, byte[] upper, int[] charLengths) {
			ArgumentNullException.ThrowIfNull(lower);
			ArgumentNullException.ThrowIfNull(upper);
			ArgumentNullException.ThrowIfNull(charLengths);
			if (lower.Length == 0)
				throw new ArgumentOutOfRangeException(nameof(lower));
			if (upper.Length != lower.Length)
				throw new ArgumentOutOfRangeException(nameof(upper));
			if (charLengths.Length == 0 || charLengths.Any(length => length <= 0) || charLengths.Sum(length => (long)length) != lower.Length)
				throw new ArgumentOutOfRangeException(nameof(charLengths));
			pattern = lower;
			this.upper = upper;
			this.charLengths = charLengths;
		}

		public int Length => pattern.Length;

		/// <summary>Whether a match starts at <paramref name="index"/> of <paramref name="data"/>, which has the room for one.</summary>
		public bool IsMatch(ReadOnlySpan<byte> data, int index) {
			var candidate = data.Slice(index, pattern.Length);
			if (upper is not null) {
				// StringHexSearchService.FindCore: per character, the bytes are all the lower-case ones or all the upper-case ones.
				for (int i = 0, bi = 0; i < charLengths!.Length; i++) {
					var length = charLengths[i];
					var bytes = candidate.Slice(bi, length);
					if (!bytes.SequenceEqual(pattern.AsSpan(bi, length)) && !bytes.SequenceEqual(upper.AsSpan(bi, length)))
						return false;
					bi += length;
				}
				return true;
			}
			if (mask is null)
				return candidate.SequenceEqual(pattern);
			for (var i = 0; i < pattern.Length; i++) {
				if ((candidate[i] & mask[i]) != pattern[i])
					return false;
			}
			return true;
		}

		/// <summary>The first index in <c>[from, last]</c> a match starts at, or -1.</summary>
		public int IndexOf(ReadOnlySpan<byte> data, int from, int last) {
			while (from <= last) {
				var index = NextCandidate(data, from, last);
				if (index < 0)
					return -1;
				if (IsMatch(data, index))
					return index;
				from = index + 1;
			}
			return -1;
		}

		/// <summary>The last index in <c>[first, from]</c> a match starts at, or -1.</summary>
		public int LastIndexOf(ReadOnlySpan<byte> data, int from, int first) {
			while (from >= first) {
				var index = PreviousCandidate(data, from, first);
				if (index < 0)
					return -1;
				if (IsMatch(data, index))
					return index;
				from = index - 1;
			}
			return -1;
		}

		// The first byte narrows the candidates down the way ByteHexSearchService.PositionAfter1/2 do with Array.IndexOf.
		int NextCandidate(ReadOnlySpan<byte> data, int from, int last) {
			var window = data[from..(last + 1)];
			int index;
			if (upper is not null)
				index = window.IndexOfAny(pattern[0], upper[0]);
			else if (mask is null)
				index = window.IndexOf(pattern[0]);
			else if (mask[0] == 0xFF)
				index = window.IndexOf(pattern[0]);
			else
				return from;
			return index < 0 ? -1 : from + index;
		}

		int PreviousCandidate(ReadOnlySpan<byte> data, int from, int first) {
			var window = data[first..(from + 1)];
			int index;
			if (upper is not null)
				index = window.LastIndexOfAny(pattern[0], upper[0]);
			else if (mask is null || mask[0] == 0xFF)
				index = window.LastIndexOf(pattern[0]);
			else
				return from;
			return index < 0 ? -1 : first + index;
		}
	}

	/// <summary>
	/// dnSpy's hex search services' FindAll (ByteHexSearchService.FindAllCore/FindAllCoreReverse, and the same blocks in
	/// StringHexSearchService) over a document's patched file. The file is read in chunks that overlap by the
	/// pattern's length less one, so a match straddling two chunks is still found, and only as far as the search has to
	/// go: a find-next stops at its first match, a highlight at the last one it was asked for.
	/// </summary>
	sealed class HexSearcher : IDisposable {
		const int ChunkSize = 1024 * 1024;
		readonly WorkspaceManager.IModuleEntry entry;
		readonly SafeFileHandle handle;
		readonly long fileLength;
		readonly HexSearchPattern pattern;
		readonly bool noOverlaps;
		readonly int maxResults;
		readonly CancellationToken cancellationToken;
		readonly List<long> results = [];
		byte[]? buffer;

		public HexSearcher(WorkspaceManager.IModuleEntry entry, HexSearchPattern pattern, bool noOverlaps, int maxResults, CancellationToken cancellationToken) {
			this.entry = entry;
			this.pattern = pattern;
			this.noOverlaps = noOverlaps;
			this.maxResults = maxResults;
			this.cancellationToken = cancellationToken;
			fileLength = entry.FileLength;
			handle = File.OpenHandle(entry.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, FileOptions.Asynchronous | FileOptions.RandomAccess);
		}

		bool IsFull => results.Count >= maxResults;

		/// <summary>
		/// The matches inside <c>[rangeStart, rangeEnd)</c> in the order FindAll yields them. Forward: those starting at
		/// <paramref name="start"/> or later, then (wrap) those lying entirely inside
		/// <c>[rangeStart, min(rangeEnd, start + length - 1))</c>. Reverse: those lying entirely inside
		/// <c>[rangeStart, start]</c>, from the last, then (wrap) those lying entirely inside
		/// <c>[max(rangeStart, start - (length - 1)), rangeEnd)</c>, from the end. With no overlaps, the second block also
		/// stops short of the first match of the first block.
		/// </summary>
		public async Task<IReadOnlyList<long>> FindAllAsync(long rangeStart, long rangeEnd, long start, bool reverse, bool wrap) {
			rangeStart = Math.Clamp(rangeStart, 0, fileLength);
			rangeEnd = Math.Clamp(rangeEnd, rangeStart, fileLength);
			// ByteHexSearchService.FindAll requires the starting position to be inside the range.
			start = Math.Clamp(start, rangeStart, rangeEnd);
			if (rangeStart == rangeEnd || maxResults <= 0)
				return results;
			var length = (long)pattern.Length;
			if (!reverse) {
				var first = await ForwardAsync(start, rangeEnd).ConfigureAwait(false);
				if (wrap && !IsFull) {
					var upperBounds = Math.Min(rangeEnd, start + length - 1);
					if (noOverlaps && first is { } firstStart && upperBounds > firstStart)
						upperBounds = firstStart;
					await ForwardAsync(rangeStart, upperBounds).ConfigureAwait(false);
				}
			}
			else {
				// GetValidSpansReverse(startingPosition, ...): the bytes up to and including the starting position.
				var first = await ReverseAsync(rangeStart, Math.Min(start + 1, rangeEnd)).ConfigureAwait(false);
				if (wrap && !IsFull) {
					var lowerBounds = start >= length - 1 ? start - (length - 1) : 0;
					if (lowerBounds < rangeStart)
						lowerBounds = rangeStart;
					if (noOverlaps && first is { } firstStart && lowerBounds < firstStart + length)
						lowerBounds = firstStart + length;
					await ReverseAsync(lowerBounds, rangeEnd).ConfigureAwait(false);
				}
			}
			return results;
		}

		/// <summary>FindAllCore(state, span, options): the matches lying entirely inside <c>[lo, hi)</c>, ascending. A match
		/// is followed by the next one starting after it, or — overlapping matches being wanted — one byte later.</summary>
		async Task<long?> ForwardAsync(long lo, long hi) {
			long? first = null;
			var length = pattern.Length;
			var lastStart = hi - length;
			var next = lo;
			for (var chunkStart = lo; chunkStart <= lastStart && !IsFull; chunkStart += ChunkSize) {
				var count = (int)Math.Min(ChunkSize + (long)length - 1, hi - chunkStart);
				var data = await ReadAsync(chunkStart, count).ConfigureAwait(false);
				var lastIndex = (int)(Math.Min(chunkStart + ChunkSize - 1, lastStart) - chunkStart);
				while (!IsFull && next <= chunkStart + lastIndex) {
					var index = pattern.IndexOf(data.AsSpan(0, count), (int)(Math.Max(next, chunkStart) - chunkStart), lastIndex);
					if (index < 0)
						break;
					var found = chunkStart + index;
					results.Add(found);
					first ??= found;
					next = noOverlaps ? found + length : found + 1;
				}
			}
			return first;
		}

		/// <summary>FindAllCoreReverse(state, span, options): the matches lying entirely inside <c>[lo, hi)</c>, descending.
		/// A match is followed by the last one ending before it, or — overlapping matches being wanted — starting one byte
		/// before it.</summary>
		async Task<long?> ReverseAsync(long lo, long hi) {
			long? first = null;
			var length = pattern.Length;
			var limit = hi - length;
			while (limit >= lo && !IsFull) {
				var chunkStart = Math.Max(lo, limit - ChunkSize + 1);
				var count = (int)(limit - chunkStart + length);
				var data = await ReadAsync(chunkStart, count).ConfigureAwait(false);
				while (!IsFull && limit >= chunkStart) {
					var index = pattern.LastIndexOf(data.AsSpan(0, count), (int)(limit - chunkStart), 0);
					if (index < 0) {
						limit = chunkStart - 1;
						break;
					}
					var found = chunkStart + index;
					results.Add(found);
					first ??= found;
					limit = noOverlaps ? found - length : found - 1;
				}
			}
			return first;
		}

		/// <summary>The patched bytes of <c>[offset, offset + count)</c>, which lies inside the file.</summary>
		async Task<byte[]> ReadAsync(long offset, int count) {
			cancellationToken.ThrowIfCancellationRequested();
			if (buffer is null || buffer.Length < count)
				buffer = new byte[Math.Max(count, Math.Min(ChunkSize + pattern.Length - 1, (int)Math.Min(int.MaxValue, fileLength)))];
			var memory = buffer.AsMemory(0, count);
			var done = 0;
			while (done < count) {
				var read = await RandomAccess.ReadAsync(handle, memory[done..], offset + done, cancellationToken).ConfigureAwait(false);
				if (read == 0)
					break;
				done += read;
			}
			buffer.AsSpan(done, count - done).Clear();
			// The patches only ever cover what the tab shows; past `count` the buffer holds nothing the search reads.
			HexPatchList.Overlay(entry, offset, buffer);
			return buffer;
		}

		public void Dispose() => handle.Dispose();
	}
}
