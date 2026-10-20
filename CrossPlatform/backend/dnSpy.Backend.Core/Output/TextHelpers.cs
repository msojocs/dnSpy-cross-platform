using System.Globalization;
using System.Text;

namespace dnSpy.Backend.Core.Output;

/// <summary>
/// NRefactory's <c>NumberFormatter</c> from dnSpy's fork: how its C# writer and its IL disassembler write an
/// integer — in decimal, or with the Hexadecimal numbers option in hex, where a value up to 9 stays a digit.
/// </summary>
abstract class NumberFormatter {
	public abstract string Format(sbyte value);
	public abstract string Format(byte value);
	public abstract string Format(short value);
	public abstract string Format(ushort value);
	public abstract string Format(int value);
	public abstract string Format(uint value);
	public abstract string Format(long value);
	public abstract string Format(ulong value);

	public static NumberFormatter GetCSharpInstance(bool hex, bool upper) {
		if (hex)
			return upper ? csharpHexUpper : csharpHexLower;
		return decimalFormatter;
	}

	public static NumberFormatter GetVBInstance(bool hex, bool upper) {
		if (hex)
			return upper ? vbHexUpper : vbHexLower;
		return decimalFormatter;
	}

	static readonly DecimalNumberFormatter decimalFormatter = new();
	static readonly HexNumberFormatter csharpHexUpper = new("0x", upper: true);
	static readonly HexNumberFormatter csharpHexLower = new("0x", upper: false);
	static readonly HexNumberFormatter vbHexUpper = new("&H", upper: true);
	static readonly HexNumberFormatter vbHexLower = new("&H", upper: false);

	sealed class DecimalNumberFormatter : NumberFormatter {
		public override string Format(sbyte value) => value.ToString(CultureInfo.InvariantCulture);
		public override string Format(byte value) => value.ToString(CultureInfo.InvariantCulture);
		public override string Format(short value) => value.ToString(CultureInfo.InvariantCulture);
		public override string Format(ushort value) => value.ToString(CultureInfo.InvariantCulture);
		public override string Format(int value) => value.ToString(CultureInfo.InvariantCulture);
		public override string Format(uint value) => value.ToString(CultureInfo.InvariantCulture);
		public override string Format(long value) => value.ToString(CultureInfo.InvariantCulture);
		public override string Format(ulong value) => value.ToString(CultureInfo.InvariantCulture);
	}

	sealed class HexNumberFormatter(string prefix, bool upper) : NumberFormatter {
		string Create(string s) => prefix + s;
		string Hex(ulong value) => value <= 9 ? value.ToString(CultureInfo.InvariantCulture) : Create(value.ToString(upper ? "X" : "x", CultureInfo.InvariantCulture));

		public override string Format(sbyte value) => value < 0 ? "-" + Format(unchecked((byte)-value)) : Format((byte)value);
		public override string Format(byte value) => Hex(value);
		public override string Format(short value) => value < 0 ? "-" + Format(unchecked((ushort)-value)) : Format((ushort)value);
		public override string Format(ushort value) => Hex(value);
		public override string Format(int value) => value < 0 ? "-" + Format(unchecked((uint)-value)) : Format((uint)value);
		public override string Format(uint value) => Hex(value);
		public override string Format(long value) => value < 0 ? "-" + Format(unchecked((ulong)-value)) : Format((ulong)value);
		public override string Format(ulong value) => Hex(value);
	}
}

/// <summary>dnSpy's <c>IdentifierEscaper</c>: a name as the decompilers write it — a character that would not read as part of
/// a name becomes a <c>\uXXXX</c> escape, an empty name a placeholder, and a very long name is cut short.</summary>
static class IdentifierEscaper {
	const int MAX_IDENTIFIER_LENGTH = 512;
	const string EMPTY_NAME = "<<EMPTY_NAME>>";

	public static string? Truncate(string? s) => Truncate(s, MAX_IDENTIFIER_LENGTH);

	public static string? Truncate(string? s, int maxLength) {
		if (s is null || s.Length <= maxLength)
			return s;
		return s[..maxLength] + "…";
	}

	public static string Escape(string? id) => Escape(id, false);

	public static string Escape(string? id, bool allowSpaces) => Escape(id, MAX_IDENTIFIER_LENGTH, allowSpaces);

	public static string Escape(string? id, int maxLength, bool allowSpaces) {
		if (string.IsNullOrEmpty(id))
			return EMPTY_NAME;
		var i = 0;
		if (id.Length <= maxLength) {
			for (; ; i++) {
				if (i >= id.Length)
					return id;
				if (!IsValidChar(id[i], allowSpaces))
					break;
			}
		}
		var sb = new StringBuilder(id.Length + 10);
		if (i != 0)
			sb.Append(id, 0, i);
		for (; i < id.Length; i++) {
			var c = id[i];
			if (!IsValidChar(c, allowSpaces)) {
				sb.Append(@"\u");
				sb.Append(((ushort)c).ToString("X4", CultureInfo.InvariantCulture));
			}
			else
				sb.Append(c);
			if (sb.Length >= maxLength)
				break;
		}
		if (sb.Length > maxLength) {
			sb.Length = maxLength;
			sb.Append('…');
		}
		return sb.ToString();
	}

	static bool IsValidChar(char c, bool allowSpaces) {
		if (0x21 <= c && c <= 0x7E)
			return true;
		if (c <= 0x20)
			return c == ' ' && allowSpaces;
		switch (char.GetUnicodeCategory(c)) {
		case UnicodeCategory.UppercaseLetter:
		case UnicodeCategory.LowercaseLetter:
		case UnicodeCategory.DecimalDigitNumber:
			return true;
		case UnicodeCategory.OtherLetter:
			// Hangul fillers render as nothing at all.
			return c != 0x115F && c != 0x1160 && c != 0x3164 && c != 0xFFA0;
		default:
			return false;
		}
	}
}

/// <summary>
/// dnSpy's <c>SimpleXmlParser</c>: one line of XML documentation split into the colors its tags, attribute values
/// and text are written in. It reads one line at a time and never fails, which a real XML reader would on a fragment.
/// </summary>
static class SimpleXmlParser {
	static readonly char[] specialChars = ['<'];
	static readonly char[] specialCharsTag = ['<', '>', '"'];

	public static IEnumerable<(string Text, string Color)> Parse(string text) {
		var inTag = true;
		var index = 0;
		while (index < text.Length) {
			var specialIndex = text.IndexOfAny(inTag ? specialCharsTag : specialChars, index);
			if (specialIndex < 0) {
				yield return (text[index..], BoxedTextColor.XmlDocCommentText);
				break;
			}

			var c = text[specialIndex];
			if (c == '>') {
				yield return (text.Substring(index, specialIndex - index + 1), BoxedTextColor.XmlDocCommentText);
				index = specialIndex + 1;
			}
			else {
				if (specialIndex - index > 0) {
					if (c == '<')
						yield return (text[index..specialIndex], BoxedTextColor.XmlDocCommentText);
					else
						yield return (text[index..specialIndex], inTag ? BoxedTextColor.XmlDocCommentName : BoxedTextColor.XmlDocCommentText);
				}

				index = specialIndex;
				var endIndex = text.IndexOf('>', index);
				endIndex = endIndex < 0 ? text.Length : endIndex + 1;

				while (index < endIndex) {
					var attrIndex = text.IndexOf('"', index, endIndex - index);
					if (attrIndex < 0) {
						yield return (text[index..endIndex], BoxedTextColor.XmlDocCommentName);
						break;
					}

					if (attrIndex - index > 0)
						yield return (text[index..attrIndex], BoxedTextColor.XmlDocCommentName);

					var endAttrIndex = text.IndexOf('"', attrIndex + 1, endIndex - attrIndex - 1);
					if (endAttrIndex < 0) {
						yield return (text[attrIndex..endIndex], BoxedTextColor.XmlDocCommentAttributeValue);
						break;
					}

					yield return (text.Substring(attrIndex, endAttrIndex - attrIndex + 1), BoxedTextColor.XmlDocCommentAttributeValue);
					index = endAttrIndex + 1;
				}

				index = endIndex;
			}
			inTag = false;
		}
	}
}
