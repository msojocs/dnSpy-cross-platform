using System.Globalization;
using System.Text;

namespace dnSpy.Backend.Core;

/// <summary>
/// The formatting half of dnSpy's <c>SimpleTypeConverter</c> (dnSpy.Contracts.Logic/Utilities): how dnSpy writes a
/// value it shows as text — a resource entry's value after its name, a linked resource's hash. Strings and chars are
/// quoted and escaped the C# way, integers go through the 64-bit overloads (decimal up to 9, hex above it), and the
/// floating point, decimal and date values are written in the current culture, the way dnSpy's own ToString() calls are.
/// </summary>
static class SimpleTypeConverter {
	public static string ByteArrayToString(IList<byte>? value, bool upper = true) {
		if (value is null)
			return string.Empty;
		var chars = new char[value.Count * 2];
		for (int i = 0, j = 0; i < value.Count; i++) {
			var b = value[i];
			chars[j++] = ToHexChar(b >> 4, upper);
			chars[j++] = ToHexChar(b & 0x0F, upper);
		}
		return new string(chars);
	}

	static char ToHexChar(int value, bool upper) => value <= 9 ? (char)('0' + value) : (char)(value - 10 + (upper ? 'A' : 'a'));

	// dnSpy calls these with every integer type: C# picks the long overload for all of them but ulong.
	public static string ToString(long value) {
		if (-9 <= value && value <= 9)
			return value.ToString(CultureInfo.CurrentCulture);
		if (value < 0)
			return string.Create(CultureInfo.InvariantCulture, $"-0x{unchecked(-value):X}");
		return string.Create(CultureInfo.InvariantCulture, $"0x{value:X}");
	}

	public static string ToString(ulong value) =>
		value <= 9 ? value.ToString(CultureInfo.CurrentCulture) : string.Create(CultureInfo.InvariantCulture, $"0x{value:X}");

	public static string ToString(float value) => value.ToString("R", CultureInfo.CurrentCulture);

	public static string ToString(double value) => value.ToString("R", CultureInfo.CurrentCulture);

	public static string ToString(decimal value) => value.ToString(CultureInfo.CurrentCulture);

	public static string ToString(DateTime value) => value.ToString(CultureInfo.CurrentCulture);

	public static string ToString(TimeSpan value) => value.ToString();

	/// <summary>Boolean.ToString: "True" or "False".</summary>
	public static string ToString(bool value) => value.ToString();

	public static string ToString(char value) {
		var sb = new StringBuilder(8);
		sb.Append('\'');
		AppendEscaped(sb, value, '\'');
		sb.Append('\'');
		return sb.ToString();
	}

	public static string ToString(string? s, bool canHaveNull) {
		if (s is null)
			return canHaveNull ? "null" : string.Empty;
		var sb = new StringBuilder(s.Length + 10);
		sb.Append('"');
		foreach (var c in s)
			AppendEscaped(sb, c, '"');
		sb.Append('"');
		return sb.ToString();
	}

	static void AppendEscaped(StringBuilder sb, char c, char quote) {
		switch (c) {
		case '\a': sb.Append(@"\a"); return;
		case '\b': sb.Append(@"\b"); return;
		case '\f': sb.Append(@"\f"); return;
		case '\n': sb.Append(@"\n"); return;
		case '\r': sb.Append(@"\r"); return;
		case '\t': sb.Append(@"\t"); return;
		case '\v': sb.Append(@"\v"); return;
		case '\\': sb.Append(@"\\"); return;
		case '\0': sb.Append(@"\0"); return;
		case ' ':
		case '_':
		case '`':
		case '^':
			// ASCII characters dnSpy allows directly in the output even though it escapes other Unicode
			// characters of the same category.
			sb.Append(c);
			return;
		case '\ufffd':
			AppendUnicodeEscape(sb, c);
			return;
		}
		if (c == quote) {
			sb.Append('\\').Append(c);
			return;
		}
		switch (char.GetUnicodeCategory(c)) {
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
			AppendUnicodeEscape(sb, c);
			return;
		default:
			sb.Append(c);
			return;
		}
	}

	static void AppendUnicodeEscape(StringBuilder sb, char c) => sb.Append(@"\u").Append(((ushort)c).ToString("X4", CultureInfo.InvariantCulture));
}
