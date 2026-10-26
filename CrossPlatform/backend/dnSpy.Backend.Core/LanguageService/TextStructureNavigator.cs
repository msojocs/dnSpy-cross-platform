using System.Globalization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using CS = Microsoft.CodeAnalysis.CSharp;
using VB = Microsoft.CodeAnalysis.VisualBasic;

namespace dnSpy.Backend.Core.LanguageService;

/// <summary>A word of the text and whether it is one the word commands stop at (white space is not).</summary>
readonly record struct TextExtent(TextSpan Span, bool IsSignificant);

/// <summary>
/// The words of a Roslyn code document — dnSpy's Roslyn text structure navigator
/// (<c>AbstractTextStructureNavigatorProvider.TextStructureNavigator</c> with the C# and Visual Basic providers):
/// a token is a word, a comment is one from its start, a string literal's quotes are words of their own, and the
/// rest falls back to dnSpy's natural-language navigator (<c>AnyTextStructureNavigator</c>, <c>WordParser</c>).
/// The word commands dnSpy's <c>EditorOperations</c> build on it are here too, so the editor asks for a command's
/// result rather than for every word it looks at.
/// </summary>
sealed class TextStructureNavigator {
	readonly SyntaxNode root;
	readonly SourceText text;
	readonly bool visualBasic;

	public TextStructureNavigator(SyntaxNode root, SourceText text) {
		this.root = root;
		this.text = text;
		visualBasic = root.Language == LanguageNames.VisualBasic;
	}

	TextLine LineOf(int position) => text.Lines.GetLineFromPosition(position);

	public TextExtent GetExtentOfWord(int position) {
		var textLength = text.Length;
		position = Math.Clamp(position, 0, textLength);
		if (textLength == 0)
			return GetNaturalExtentOfWord(position);
		// At the end of the file, go back one character so stuff works.
		if (position == textLength && position > 0)
			position--;
		// At the end of a line, the line break is the word.
		var line = LineOf(position);
		if (position >= line.End && position < line.EndIncludingLineBreak)
			return new TextExtent(TextSpan.FromBounds(line.End, line.EndIncludingLineBreak), false);

		var trivia = root.FindTrivia(position, findInsideTrivia: true);
		if (trivia != default && trivia.Span.Start == position && ShouldSelectEntireTriviaFromStart(trivia))
			return new TextExtent(trivia.Span, true);

		var token = root.FindToken(position, findInsideTrivia: true);
		// At the end of the file, go back a token.
		if (token.Span.Length == 0 && token.Span.Start == textLength)
			token = token.GetPreviousToken();
		if (token.Span.Length > 0 && token.Span.Contains(position))
			return visualBasic ? GetVisualBasicExtentOfWord(token, position) : GetCSharpExtentOfWord(token, position);
		return GetNaturalExtentOfWord(position);
	}

	bool ShouldSelectEntireTriviaFromStart(SyntaxTrivia trivia) => visualBasic
		? trivia.RawKind == (int)VB.SyntaxKind.CommentTrivia
		: trivia.RawKind is (int)CS.SyntaxKind.SingleLineCommentTrivia or (int)CS.SyntaxKind.MultiLineCommentTrivia
			or (int)CS.SyntaxKind.SingleLineDocumentationCommentTrivia or (int)CS.SyntaxKind.MultiLineDocumentationCommentTrivia;

	/// <summary>The C# provider's <c>GetExtentOfWordFromToken</c>.</summary>
	TextExtent GetCSharpExtentOfWord(SyntaxToken token, int position) {
		var kind = CS.CSharpExtensions.Kind(token);
		// Legacy behavior: the editor handles these.
		if (kind is CS.SyntaxKind.InterpolatedStringTextToken or CS.SyntaxKind.XmlTextLiteralToken)
			return GetNaturalExtentOfWord(position);
		// On the start of a char literal, the whole literal; elsewhere in it, the editor's word.
		if (kind is CS.SyntaxKind.CharacterLiteralToken)
			return token.SpanStart == position ? new TextExtent(token.Span, true) : GetNaturalExtentOfWord(position);

		var isNormalStringLiteral = kind is CS.SyntaxKind.StringLiteralToken or CS.SyntaxKind.Utf8StringLiteralToken;
		var isRawStringLiteral = kind is CS.SyntaxKind.SingleLineRawStringLiteralToken or CS.SyntaxKind.Utf8SingleLineRawStringLiteralToken or CS.SyntaxKind.MultiLineRawStringLiteralToken or CS.SyntaxKind.Utf8MultiLineRawStringLiteralToken;
		// Not a string literal: the whole token.
		if (!isNormalStringLiteral && !isRawStringLiteral)
			return new TextExtent(token.Span, true);

		// The opening quotes and the closing ones are words of their own; in between, the editor's word, kept inside.
		var start = token.Span.Start;
		var contentStart = start;
		if (CharAt(contentStart) == '@')
			contentStart++;
		if (CharAt(contentStart) == '"')
			contentStart++;
		if (isRawStringLiteral) {
			while (CharAt(contentStart) == '"')
				contentStart++;
		}
		var end = Math.Max(contentStart, token.Span.End);
		var contentEnd = end;
		if (CharAt(contentEnd - 1) == '8')
			contentEnd--;
		if (CharAt(contentEnd - 1) is 'u' or 'U')
			contentEnd--;
		if (CharAt(contentEnd - 1) == '"')
			contentEnd--;
		if (isRawStringLiteral) {
			while (CharAt(contentEnd - 1) == '"')
				contentEnd--;
		}
		// A naked '"' must not give invalid bounds.
		contentEnd = Math.Max(contentStart, contentEnd);
		var startSpan = TextSpan.FromBounds(start, contentStart);
		var contentSpan = TextSpan.FromBounds(contentStart, contentEnd);
		var endSpan = TextSpan.FromBounds(contentEnd, end);
		if (startSpan.Contains(position))
			return new TextExtent(startSpan, true);
		if (endSpan.Contains(position))
			return new TextExtent(endSpan, true);
		var naturalExtent = GetNaturalExtentOfWord(position);
		var intersectionStart = Math.Max(naturalExtent.Span.Start, contentSpan.Start);
		var intersectionEnd = Math.Min(naturalExtent.Span.End, contentSpan.End);
		return intersectionStart <= intersectionEnd ? new TextExtent(TextSpan.FromBounds(intersectionStart, intersectionEnd), naturalExtent.IsSignificant) : naturalExtent;

		char CharAt(int index) => index >= 0 && index < text.Length ? text[index] : '\0';
	}

	/// <summary>The Visual Basic provider's <c>GetExtentOfWordFromToken</c>.</summary>
	TextExtent GetVisualBasicExtentOfWord(SyntaxToken token, int position) {
		var kind = VB.VisualBasicExtensions.Kind(token);
		var closingQuote = kind == VB.SyntaxKind.StringLiteralToken && position == token.Span.End - 1 && token.Text.EndsWith('"');
		var withinNaturalLanguage = kind switch {
			// The closing quote is a word of its own, the way it was in VS2013.
			VB.SyntaxKind.StringLiteralToken => !closingQuote,
			// Before the opening quote is outside the character.
			VB.SyntaxKind.CharacterLiteralToken => position != token.SpanStart,
			VB.SyntaxKind.InterpolatedStringTextToken or VB.SyntaxKind.XmlTextLiteralToken => true,
			_ => false,
		};
		if (withinNaturalLanguage)
			return GetNaturalExtentOfWord(position);
		if (closingQuote)
			return new TextExtent(new TextSpan(position, 1), true);
		return new TextExtent(token.Span, true);
	}

	enum WordKind { Word, Whitespace, Other }

	static WordKind GetWordKind(char c) {
		if (char.IsLetterOrDigit(c) || c == '_' || c == '$')
			return WordKind.Word;
		if (char.IsWhiteSpace(c))
			return WordKind.Whitespace;
		if (char.IsSurrogate(c) || char.GetUnicodeCategory(c) == UnicodeCategory.NonSpacingMark)
			return WordKind.Word;
		return WordKind.Other;
	}

	/// <summary>dnSpy's <c>AnyTextStructureNavigator.GetExtentOfWord</c>: a run of characters of one kind on the line.</summary>
	TextExtent GetNaturalExtentOfWord(int position) {
		var line = LineOf(position);
		if (position == line.End)
			return new TextExtent(new TextSpan(position, 0), false);
		var kind = position >= text.Length ? WordKind.Whitespace : GetWordKind(text[position]);
		var start = position;
		while (start > line.Start && GetWordKind(text[start - 1]) == kind)
			start--;
		var end = position;
		for (; ; ) {
			if (end + 1 >= line.End) {
				end = line.End;
				break;
			}
			end++;
			if (GetWordKind(text[end]) != kind)
				break;
		}
		return new TextExtent(TextSpan.FromBounds(start, end), kind != WordKind.Whitespace);
	}

	// dnSpy's EditorOperations.

	TextExtent TryGetPreviousSignificantWord(TextExtent info) {
		info = GetExtentOfWord(info.Span.Start - 1);
		if (info.IsSignificant)
			return info;
		var line = LineOf(info.Span.Start);
		if (info.Span.Start == line.Start)
			return info;
		if (info.Span.Start == line.End) {
			info = GetExtentOfWord(info.Span.Start - 1);
			line = LineOf(info.Span.Start);
		}
		if (info.IsSignificant)
			return info;
		if (info.Span.Start == line.Start)
			return info;
		return GetExtentOfWord(info.Span.Start - 1);
	}

	/// <summary>The word Ctrl+Left moves to the start of (<c>GetSpanOfLeftWord</c>).</summary>
	public TextSpan GetSpanOfLeftWord(int position) {
		var line = LineOf(position);
		var info = GetExtentOfWord(position);
		var canGetNewInfo = true;
		if (info.Span.Start == 0)
			return info.Span;
		if (!info.IsSignificant) {
			if (position != line.Start && info.Span.Start == line.Start)
				return info.Span;
			info = TryGetPreviousSignificantWord(info);
			canGetNewInfo = false;
		}
		if (info.Span.Start == 0)
			return info.Span;
		if (info.Span.Start != position)
			return info.Span;
		if (canGetNewInfo)
			info = TryGetPreviousSignificantWord(info);
		return info.Span;
	}

	/// <summary>Where Ctrl+Right moves the caret to (<c>GetPointOfRightWord</c>).</summary>
	public int GetPointOfRightWord(int position) {
		var info = GetExtentOfWord(position);
		if (info.Span.End == text.Length)
			return info.Span.End;
		var line = LineOf(info.Span.End);
		if (line.End == info.Span.End) {
			if (position == line.End) {
				info = GetExtentOfWord(line.EndIncludingLineBreak);
				if (info.IsSignificant)
					return info.Span.Start;
				if (info.Span.Length == 0)
					return GetExtentOfWord(info.Span.End).Span.Start;
				return info.Span.End;
			}
			if (info.IsSignificant)
				return info.Span.End;
			return GetExtentOfWord(info.Span.End).Span.End;
		}
		if (!info.IsSignificant)
			return GetExtentOfWord(info.Span.End).Span.Start;
		var info2 = GetExtentOfWord(info.Span.End);
		if (info2.IsSignificant) {
			if (info2.Span.Start < info.Span.End)
				return info.Span.End;
			return info2.Span.Start;
		}
		return info2.Span.End;
	}

	/// <summary>
	/// The word Ctrl+W and a double click select (<c>SelectCurrentWord</c>): the one at the caret, or the one before
	/// it when that is already selected (the caret ends up after a selected word) or the caret is not in a word.
	/// </summary>
	public TextSpan GetCurrentWord(int caret, TextSpan selection) {
		var info = GetExtentOfWord(caret);
		var previous = info;
		if (caret - LineOf(caret).Start != 0)
			previous = GetExtentOfWord(caret - 1);
		if (selection == previous.Span)
			info = previous;
		else if (!info.IsSignificant && previous.IsSignificant)
			info = previous;
		return info.Span;
	}
}
