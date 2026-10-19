using System.Globalization;
using System.Text;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core;

/// <summary>
/// The bytes of a document's file the way every reader of the document sees them: the file with its hex patches
/// laid over it (<see cref="HexPatchList.Overlay(WorkspaceManager.IModuleEntry, long, byte[])"/>). dnSpy's hex
/// structure view models read their values out of the HexBuffer, which holds the edits, so a byte patch shows up
/// in every structure and table at once; this is that buffer for one request. The file is read in pages, each
/// once, so a request that reads many rows — or the same #Strings heap over and over for their names — reads the
/// file only as far as it has to.
/// </summary>
internal sealed class PatchedFileReader(WorkspaceManager.IModuleEntry entry) : IDisposable {
	const int PageSize = 0x10000;
	readonly Dictionary<long, byte[]> pages = [];
	FileStream? stream;

	public WorkspaceManager.IModuleEntry Entry { get; } = entry;

	public long Length => Entry.FileLength;

	/// <summary>The byte at <paramref name="offset"/>, or -1 past either end of the file — dnSpy's HexBuffer.TryReadByte.</summary>
	public int TryReadByte(long offset) {
		if (offset < 0 || offset >= Length)
			return -1;
		var page = GetPage(offset / PageSize);
		var index = (int)(offset % PageSize);
		return index < page.Length ? page[index] : -1;
	}

	/// <summary>The bytes of a range; whatever of it lies outside the file reads as zeros.</summary>
	public byte[] ReadBytes(long offset, int count) {
		var result = new byte[count];
		var done = 0;
		while (done < count) {
			var position = offset + done;
			if (position < 0) {
				done++;
				continue;
			}
			if (position >= Length)
				break;
			var page = GetPage(position / PageSize);
			var index = (int)(position % PageSize);
			if (index >= page.Length)
				break;
			var chunk = Math.Min(count - done, page.Length - index);
			Array.Copy(page, index, result, done, chunk);
			done += chunk;
		}
		return result;
	}

	/// <summary>A little-endian unsigned number of <paramref name="size"/> bytes (1, 2, 4 or 8).</summary>
	public ulong ReadUInt(long offset, int size) {
		var bytes = ReadBytes(offset, size);
		ulong value = 0;
		for (var i = size - 1; i >= 0; i--)
			value = (value << 8) | bytes[i];
		return value;
	}

	byte[] GetPage(long index) {
		if (pages.TryGetValue(index, out var page))
			return page;
		var start = index * PageSize;
		var length = (int)Math.Clamp(Length - start, 0, PageSize);
		page = new byte[length];
		if (length > 0) {
			try {
				stream ??= new FileStream(Entry.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 4096, FileOptions.RandomAccess);
				stream.Position = start;
				stream.ReadAtLeast(page, page.Length, throwOnEndOfStream: false);
			}
			catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) {
				throw new RpcException(ErrorCodes.SaveFailed, $"The file could not be read: {ex.Message}");
			}
			HexPatchList.Overlay(Entry, start, page);
		}
		pages.Add(index, page);
		return page;
	}

	public void Dispose() => stream?.Dispose();
}

/// <summary>
/// How dnSpy writes the values of its hex fields: SimpleTypeConverter for the text boxes, and the fixed-width hex
/// of HexField.FormattedValue for the comment lines a hex node decompiles to.
/// </summary>
internal static class HexText {
	public const string Byte = "byte";
	public const string Int16 = "int16";
	public const string UInt16 = "uint16";
	public const string Int32 = "int32";
	public const string UInt32 = "uint32";
	public const string UInt64 = "uint64";
	public const string String = "string";

	public static int SizeOf(string kind) => kind switch {
		Byte => 1,
		Int16 or UInt16 => 2,
		Int32 or UInt32 => 4,
		UInt64 => 8,
		_ => throw new ArgumentOutOfRangeException(nameof(kind)),
	};

	/// <summary>SimpleTypeConverter.ToString for an unsigned number: decimal when the field asks for it or the value
	/// is a single digit, "0x" and upper-case hex without padding otherwise.</summary>
	public static string Unsigned(ulong value, bool useDecimal) =>
		useDecimal || value <= 9
			? value.ToString(CultureInfo.InvariantCulture)
			: "0x" + value.ToString("X", CultureInfo.InvariantCulture);

	/// <summary>SimpleTypeConverter.ToString for a signed number: a negative hex value keeps its sign.</summary>
	public static string Signed(long value, bool useDecimal) {
		if (useDecimal || (value >= -9 && value <= 9))
			return value.ToString(CultureInfo.InvariantCulture);
		return value < 0
			? "-0x" + ((ulong)(-(value + 1)) + 1).ToString("X", CultureInfo.InvariantCulture)
			: "0x" + value.ToString("X", CultureInfo.InvariantCulture);
	}

	/// <summary>A field's text box value: the number as dnSpy's DataFieldVM writes it.</summary>
	public static string Format(string kind, ulong value, bool useDecimal) => kind switch {
		Int16 => Signed(unchecked((short)value), useDecimal),
		Int32 => Signed(unchecked((int)value), useDecimal),
		_ => Unsigned(value, useDecimal),
	};

	/// <summary>HexField.FormattedValue: the value in as many hex digits as the field has.</summary>
	public static string Fixed(HexFieldDto field) => field.Kind == String
		? field.Note ?? string.Empty
		: field.Value.ToString("X" + (field.Size * 2).ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);

	/// <summary>
	/// SimpleTypeConverter.ToString(string, false): the string as a quoted C# literal, with the control characters,
	/// the marks, the separators and the other characters that do not show escaped. This is how dnSpy's StringVM
	/// shows a string field and how the metadata views quote a name out of the #Strings heap.
	/// </summary>
	public static string Quote(string text) {
		var builder = new StringBuilder(text.Length + 10);
		builder.Append('"');
		foreach (var ch in text) {
			switch (ch) {
			case '\a': builder.Append(@"\a"); break;
			case '\b': builder.Append(@"\b"); break;
			case '\f': builder.Append(@"\f"); break;
			case '\n': builder.Append(@"\n"); break;
			case '\r': builder.Append(@"\r"); break;
			case '\t': builder.Append(@"\t"); break;
			case '\v': builder.Append(@"\v"); break;
			case '\\': builder.Append(@"\\"); break;
			case '\0': builder.Append(@"\0"); break;
			case '"': builder.Append("\\\""); break;
			case ' ' or '_' or '`' or '^':
				builder.Append(ch);
				break;
			case '\ufffd':
				builder.Append(@"\u").Append(((ushort)ch).ToString("X4", CultureInfo.InvariantCulture));
				break;
			default:
				switch (char.GetUnicodeCategory(ch)) {
				case UnicodeCategory.NonSpacingMark:
				case UnicodeCategory.SpacingCombiningMark:
				case UnicodeCategory.EnclosingMark:
				case UnicodeCategory.LineSeparator:
				case UnicodeCategory.ParagraphSeparator:
				case UnicodeCategory.Control:
				case UnicodeCategory.Format:
				case UnicodeCategory.Surrogate:
				case UnicodeCategory.PrivateUse:
				case UnicodeCategory.ConnectorPunctuation:
				case UnicodeCategory.ModifierSymbol:
				case UnicodeCategory.OtherNotAssigned:
				case UnicodeCategory.SpaceSeparator:
					builder.Append(@"\u").Append(((ushort)ch).ToString("X4", CultureInfo.InvariantCulture));
					break;
				default:
					builder.Append(ch);
					break;
				}
				break;
			}
		}
		return builder.Append('"').ToString();
	}

	/// <summary>A string quoted the way <see cref="Quote"/> does it, without the quotes — what the metadata views
	/// write for a name (MetadataTableRecordVM.ReadStringsHeap).</summary>
	public static string Escape(string text) {
		var quoted = Quote(text);
		return quoted.Substring(1, quoted.Length - 2);
	}

	/// <summary>StringHexField.StringZ: the bytes up to the first NUL, with what would not show escaped.</summary>
	public static string StringZ(byte[] data, Encoding encoding) {
		var count = Array.IndexOf(data, (byte)0);
		var text = encoding.GetString(data, 0, count < 0 ? data.Length : count);
		var builder = new StringBuilder(text.Length);
		foreach (var ch in text) {
			if (ch == 0)
				builder.Append(@"\0");
			else if (ch < 0x20)
				builder.Append(@"\u").Append(((ushort)ch).ToString("X4", CultureInfo.InvariantCulture));
			else
				builder.Append(ch);
		}
		return builder.ToString();
	}

	public static HexBitFieldDto Flag(string name, int bit) => new(name, bit, 1, null);

	public static HexBitFieldDto Choice(string name, int bit, int count, params (ulong Value, string Name)[] values) =>
		new(name, bit, count, values.Select(value => new HexEnumValueDto(value.Value, value.Name)).ToArray());
}

/// <summary>
/// The fields of one structure as they are added, in dnSpy's HexFields order, each read out of the patched file.
/// </summary>
internal sealed class HexFieldList(PatchedFileReader reader) {
	readonly List<HexFieldDto> fields = [];

	public IReadOnlyList<HexFieldDto> Fields => fields;

	public HexFieldDto Number(string name, long offset, string kind, bool useDecimal = false, IReadOnlyList<HexBitFieldDto>? bits = null, string? group = null, string? note = null) {
		var size = HexText.SizeOf(kind);
		var value = reader.ReadUInt(offset, size);
		var field = new HexFieldDto(name, offset, size, kind, value, HexText.Format(kind, value, useDecimal), bits, note, group);
		fields.Add(field);
		return field;
	}

	/// <summary>A fixed-size string field — dnSpy's StringHexField. The text is the whole run decoded and quoted, NULs
	/// and all, which is what its text box edits; the note is the string up to its first NUL.</summary>
	public HexFieldDto String(string name, long offset, int size, Encoding encoding) {
		var data = reader.ReadBytes(offset, size);
		var field = new HexFieldDto(name, offset, size, HexText.String, 0, HexText.Quote(encoding.GetString(data)), null, HexText.StringZ(data, encoding));
		fields.Add(field);
		return field;
	}
}
