using System.Text;
using System.Text.RegularExpressions;

namespace dnSpy.Cli;

/// <summary>
/// The textual fixes around the C#-to-VB converter. Nullable-reference attributes are metadata
/// bookkeeping that VB has no syntax for, and the converter fails on event fields that carry them;
/// VB refuses a ParamArray parameter beside Optional ones, or a default value on a parameter that is
/// not Optional; and ILSpy's `base..ctor()` spelling for a base constructor without a declared type
/// reaches the converter as a member access it writes back as `MyBase._002Ector()`. None of the
/// changes affects what the code does.
/// </summary>
static partial class VisualBasicConversion {
	[GeneratedRegex(@"(?:System\.Runtime\.CompilerServices\.)?@?Nullable(?:Context)?(?:Attribute)?\s*\([^)]*\)", RegexOptions.CultureInvariant)]
	private static partial Regex NullableAttribute();

	[GeneratedRegex(@"^\[(?:[a-z]+:\s*)?(?:System\.Runtime\.CompilerServices\.)?@?Nullable(?:Context)?(?:Attribute)?\s*\([^)]*\)\]$", RegexOptions.CultureInvariant)]
	private static partial Regex NullableAttributeLine();

	// ILSpy writes a base constructor call with no declared type as `base..ctor()`, which the converter
	// passes through as `MyBase._002Ector()`; VB has no such member.
	[GeneratedRegex(@"^\s*MyBase\._002Ector\(\)\s*$", RegexOptions.CultureInvariant)]
	private static partial Regex BaseCtorLine();

	[GeneratedRegex(@"^\s*MyBase\.New\(\)\s*$", RegexOptions.CultureInvariant)]
	private static partial Regex BaseNewLine();


	/// <summary>Drops the nullability attributes from the C# source before it is converted.</summary>
	public static string PrepareCSharp(string text) {
		var lines = text.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n');
		for (var i = 0; i < lines.Length; i++) {
			if (lines[i].Contains("Nullable", StringComparison.Ordinal)) {
				if (NullableAttributeLine().IsMatch(lines[i].Trim()))
					lines[i] = string.Empty;
				else
					lines[i] = NullableAttribute().Replace(lines[i], string.Empty);
			}
		}
		return string.Join('\n', lines);
	}

	/// <summary>Drops the calls the converter writes for a base constructor the metadata does not declare.</summary>
	public static string PrepareConvertedVB(string text) {
		var lines = text.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n');
		for (var i = 0; i < lines.Length; i++) {
			if (BaseCtorLine().IsMatch(lines[i]) || BaseNewLine().IsMatch(lines[i]))
				lines[i] = string.Empty;
		}
		return string.Join('\n', lines);
	}

	/// <summary>Drops Optional and its default value from a parameter list that has a ParamArray.</summary>
	public static string PrepareVB(string text) {
		if (!text.Contains("ParamArray", StringComparison.Ordinal))
			return text;
		var ranges = new List<(int Start, int End)>();
		var index = 0;
		while ((index = text.IndexOf("ParamArray", index, StringComparison.Ordinal)) >= 0) {
			var open = FindOpenParenthesis(text, index);
			var close = open >= 0 ? FindCloseParenthesis(text, open) : -1;
			if (open >= 0 && close > open && !ranges.Contains((open + 1, close)))
				ranges.Add((open + 1, close));
			index += "ParamArray".Length;
		}
		if (ranges.Count == 0)
			return text;
		var builder = new StringBuilder(text);
		foreach (var (start, end) in ranges.OrderByDescending(range => range.Start)) {
			var parameters = builder.ToString(start, end - start);
			builder.Remove(start, end - start).Insert(start, RemoveOptionalAndDefaults(parameters));
		}
		return builder.ToString();
	}

	static int FindOpenParenthesis(string text, int from) {
		var depth = 0;
		for (var i = from - 1; i >= 0; i--) {
			switch (text[i]) {
			case ')':
				depth++;
				break;
			case '(' when depth == 0:
				return i;
			case '(':
				depth--;
				break;
			}
		}
		return -1;
	}

	static int FindCloseParenthesis(string text, int open) {
		var depth = 0;
		for (var i = open; i < text.Length; i++) {
			switch (text[i]) {
			case '(':
				depth++;
				break;
			case ')':
				if (--depth == 0)
					return i;
				break;
			}
		}
		return -1;
	}

	static string RemoveOptionalAndDefaults(string parameters) {
		var result = new StringBuilder(parameters.Length);
		var depth = 0;
		for (var i = 0; i < parameters.Length;) {
			var ch = parameters[i];
			if (ch == '"') {
				var end = SkipString(parameters, i);
				result.Append(parameters, i, end - i);
				i = end;
				continue;
			}
			if (ch == '\'') {
				var end = parameters.IndexOf('\n', i);
				if (end < 0)
					end = parameters.Length;
				result.Append(parameters, i, end - i);
				i = end;
				continue;
			}
			if (ch is '(' or '[' or '{' or '<') {
				depth++;
				result.Append(ch);
				i++;
				continue;
			}
			if (ch is ')' or ']' or '}' or '>') {
				depth = Math.Max(0, depth - 1);
				result.Append(ch);
				i++;
				continue;
			}
			if (depth == 0 && IsWordAt(parameters, i, "Optional")) {
				i += "Optional".Length;
				while (i < parameters.Length && parameters[i] == ' ')
					i++;
				continue;
			}
			if (depth == 0 && ch == '=' && (i + 1 >= parameters.Length || parameters[i + 1] != '>')) {
				i++;
				while (i < parameters.Length) {
					var current = parameters[i];
					if (current == '"') {
						i = SkipString(parameters, i);
						continue;
					}
					if (current == '(') {
						var close = FindCloseParenthesis(parameters, i);
						i = close < 0 ? parameters.Length : close + 1;
						continue;
					}
					if (current == ',')
						break;
					i++;
				}
				continue;
			}
			result.Append(ch);
			i++;
		}
		return result.ToString();
	}

	static int SkipString(string text, int start) {
		var i = start + 1;
		while (i < text.Length) {
			if (text[i] == '"') {
				if (i + 1 < text.Length && text[i + 1] == '"') {
					i += 2;
					continue;
				}
				return i + 1;
			}
			i++;
		}
		return text.Length;
	}

	static bool IsWordAt(string text, int index, string word) =>
		index + word.Length <= text.Length &&
		text.AsSpan(index, word.Length).SequenceEqual(word) &&
		(index == 0 || !char.IsLetterOrDigit(text[index - 1])) &&
		(index + word.Length == text.Length || !char.IsLetterOrDigit(text[index + word.Length]));
}
