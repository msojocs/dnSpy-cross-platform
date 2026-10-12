using System.Globalization;
using System.Text.RegularExpressions;
using dnlib.DotNet;

namespace dnSpy.Backend.Core.Search;

/// <summary>
/// What a search query matches — dnSpy's ISearchComparer. A name is offered as <c>text</c>; a constant, a
/// literal operand or a resource value as <c>obj</c>, which only the literal comparers look at.
/// </summary>
interface ISearchComparer {
	bool IsMatch(string? text, object? obj);
}

/// <summary>dnSpy's SearchComparerFactory: the query as terms, a regular expression between slashes, or —
/// for the literal search — a number or a string.</summary>
static class SearchComparerFactory {
	public static ISearchComparer Create(string searchText, bool caseSensitive, bool matchWholeWords, bool matchAnyWords) {
		if (TryCreateRegEx(searchText, caseSensitive) is { } regex)
			return new RegExSearchComparer(regex);
		var searchTerms = searchText.Split(' ', StringSplitOptions.RemoveEmptyEntries);
		return matchAnyWords
			? new OrSearchComparer(searchTerms, caseSensitive, matchWholeWords)
			: new AndSearchComparer(searchTerms, caseSensitive, matchWholeWords);
	}

	public static ISearchComparer CreateLiteral(string searchText, bool caseSensitive, bool matchWholeWords, bool matchAnyWords) {
		var s = searchText.Trim();
		if (TryParseInt64(s) is { } val64)
			return new IntegerLiteralSearchComparer(val64);
		if (TryParseUInt64(s) is { } uval64)
			return new IntegerLiteralSearchComparer(unchecked((long)uval64));
		if (double.TryParse(s, out var dbl))
			return new DoubleLiteralSearchComparer(dbl);
		if (s.Length >= 2 && s[0] == '"' && s[^1] == '"')
			s = s[1..^1];
		else if (TryCreateRegEx(s, caseSensitive) is { } regex)
			return new RegExStringLiteralSearchComparer(regex);
		return new StringLiteralSearchComparer(s, caseSensitive, matchWholeWords);
	}

	static Regex? TryCreateRegEx(string s, bool caseSensitive) {
		s = s.Trim();
		if (s.Length > 2 && s[0] == '/' && s[^1] == '/') {
			var options = RegexOptions.Compiled;
			if (!caseSensitive)
				options |= RegexOptions.IgnoreCase;
			try {
				return new Regex(s[1..^1], options);
			}
			catch (ArgumentException) {
			}
		}
		return null;
	}

	static long? TryParseInt64(string s) {
		var isSigned = s.StartsWith('-');
		if (isSigned)
			s = s[1..];
		if (s != s.Trim())
			return null;
		ulong value;
		if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) {
			s = s[2..];
			if (s != s.Trim() || !ulong.TryParse(s, NumberStyles.HexNumber, null, out value))
				return null;
		}
		else if (!ulong.TryParse(s, out value))
			return null;
		if (isSigned)
			return value > (ulong)long.MaxValue + 1 ? null : unchecked(-(long)value);
		return value > long.MaxValue ? null : (long)value;
	}

	static ulong? TryParseUInt64(string s) {
		ulong value;
		if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) {
			s = s[2..];
			if (s != s.Trim() || !ulong.TryParse(s, NumberStyles.HexNumber, null, out value))
				return null;
		}
		else if (!ulong.TryParse(s, out value))
			return null;
		return value;
	}

	/// <summary>A field's or a parameter's default value stands for the member it is the constant of.</summary>
	internal static object? Unwrap(object? obj) => obj is IHasConstant { Constant: { } constant } ? constant.Value : obj;
}

sealed class RegExStringLiteralSearchComparer(Regex regex) : ISearchComparer {
	public bool IsMatch(string? text, object? obj) => SearchComparerFactory.Unwrap(obj) is string s && regex.IsMatch(s);
}

sealed class StringLiteralSearchComparer(string str, bool caseSensitive = false, bool matchWholeString = false) : ISearchComparer {
	readonly StringComparison comparison = caseSensitive ? StringComparison.InvariantCulture : StringComparison.InvariantCultureIgnoreCase;

	public bool IsMatch(string? text, object? obj) {
		if (SearchComparerFactory.Unwrap(obj) is not string s)
			return false;
		return matchWholeString ? s.Equals(str, comparison) : s.Contains(str, comparison);
	}
}

sealed class IntegerLiteralSearchComparer(long searchValue) : ISearchComparer {
	public bool IsMatch(string? text, object? obj) => SearchComparerFactory.Unwrap(obj) switch {
		char value => searchValue == value,
		sbyte value => searchValue == value,
		byte value => searchValue == value,
		short value => searchValue == value,
		ushort value => searchValue == value,
		int value => searchValue == value,
		uint value => searchValue == value,
		long value => searchValue == value,
		ulong value => searchValue == unchecked((long)value),
		float value => searchValue == value,
		double value => searchValue == value,
		decimal value => searchValue == value,
		DateTime value => new DateTime(searchValue) == value,
		_ => false,
	};
}

sealed class DoubleLiteralSearchComparer(double searchValue) : ISearchComparer {
	public bool IsMatch(string? text, object? obj) => SearchComparerFactory.Unwrap(obj) switch {
		char value => searchValue == value,
		sbyte value => searchValue == value,
		byte value => searchValue == value,
		short value => searchValue == value,
		ushort value => searchValue == value,
		int value => searchValue == value,
		uint value => searchValue == value,
		long value => searchValue == value,
		ulong value => searchValue == value,
		float value => searchValue == value,
		double value => searchValue == value,
		_ => false,
	};
}

sealed class RegExSearchComparer(Regex regex) : ISearchComparer {
	public bool IsMatch(string? text, object? obj) => text is not null && regex.IsMatch(text);
}

sealed class AndSearchComparer(string[] searchTerms, bool caseSensitive = false, bool matchWholeWords = false) : ISearchComparer {
	readonly StringComparison comparison = caseSensitive ? StringComparison.InvariantCulture : StringComparison.InvariantCultureIgnoreCase;

	public bool IsMatch(string? text, object? obj) {
		if (text is null)
			return false;
		foreach (var searchTerm in searchTerms) {
			if (matchWholeWords ? !text.Equals(searchTerm, comparison) : !text.Contains(searchTerm, comparison))
				return false;
		}
		return true;
	}
}

sealed class OrSearchComparer(string[] searchTerms, bool caseSensitive = false, bool matchWholeWords = false) : ISearchComparer {
	readonly StringComparison comparison = caseSensitive ? StringComparison.InvariantCulture : StringComparison.InvariantCultureIgnoreCase;

	public bool IsMatch(string? text, object? obj) {
		if (text is null)
			return false;
		foreach (var searchTerm in searchTerms) {
			if (matchWholeWords ? text.Equals(searchTerm, comparison) : text.Contains(searchTerm, comparison))
				return true;
		}
		return false;
	}
}
