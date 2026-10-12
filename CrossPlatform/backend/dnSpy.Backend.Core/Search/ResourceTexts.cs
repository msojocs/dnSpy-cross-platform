using System.Text;

namespace dnSpy.Backend.Core.Search;

/// <summary>
/// What dnSpy's resource nodes read a resource's text with — ResourceUtilities.TryGetString over
/// GuessFileType: a byte order mark, or bytes that are valid UTF-8 in their first 500 KB, make it text.
/// </summary>
static class ResourceTexts {
	public static string? TryGetString(byte[] data) {
		if (!IsText(data))
			return null;
		using var reader = new StreamReader(new MemoryStream(data, writable: false), detectEncodingFromByteOrderMarks: true);
		return reader.ReadToEnd();
	}

	static bool IsText(byte[] data) {
		if (data.Length < 2)
			return false;
		switch ((data[0] << 8) | data[1]) {
		// UTF-16 and UTF-32 byte order marks.
		case 0xfffe:
		case 0xfeff:
			return true;
		// The start of UTF-8's.
		case 0xefbb:
			return data.Length > 2 && data[2] == 0xbf;
		default:
			return IsUTF8(data);
		}
	}

	static bool IsUTF8(byte[] data) {
		const int ascii = 0, utf8 = 1, utf8Sequence = 2;
		var max = Math.Min(data.Length, 500_000);
		var state = ascii;
		var sequenceLength = 0;
		for (var index = 0; index < max; index++) {
			var b = data[index];
			if (b < 0x80) {
				if (state == utf8Sequence)
					return false;
			}
			else if (b < 0xc0) {
				// 10xxxxxx continues a sequence.
				if (state != utf8Sequence)
					return false;
				sequenceLength--;
				if (sequenceLength < 0)
					return false;
				if (sequenceLength == 0)
					state = utf8;
			}
			else if (b is >= 0xc2 and < 0xf5) {
				if (state is not (utf8 or ascii))
					return false;
				state = utf8Sequence;
				sequenceLength = b < 0xe0 ? 1 : b < 0xf0 ? 2 : 3;
			}
			else {
				// 0xc0, 0xc1 and 0xf5 to 0xff are never UTF-8 (RFC 3629).
				return false;
			}
		}
		return true;
	}

	/// <summary>dnSpy's IDsDocument.GetShortName: the file name without its extension.</summary>
	public static string ShortName(string path) {
		var name = Path.GetFileNameWithoutExtension(path);
		return string.IsNullOrWhiteSpace(name) ? Path.GetFileName(path) : name;
	}
}
