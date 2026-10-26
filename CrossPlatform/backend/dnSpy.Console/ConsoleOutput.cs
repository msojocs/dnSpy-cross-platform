using dnSpy.Backend.Core.Output;

namespace dnSpy.Cli;

/// <summary>
/// The WPF console's ColorProvider: the console color each of dnSpy's text colors is written in. A color that is not
/// here (text, operators, punctuation, numbers…) is written in the console's own.
/// </summary>
static class ConsoleColors {
	static readonly Dictionary<string, ConsoleColor> colors = new(StringComparer.Ordinal) {
		[BoxedTextColor.Comment] = ConsoleColor.Green,
		[BoxedTextColor.Keyword] = ConsoleColor.Cyan,
		[BoxedTextColor.String] = ConsoleColor.DarkYellow,
		[BoxedTextColor.VerbatimString] = ConsoleColor.DarkYellow,
		[BoxedTextColor.Char] = ConsoleColor.DarkYellow,
		[BoxedTextColor.Namespace] = ConsoleColor.Yellow,
		[BoxedTextColor.Type] = ConsoleColor.Magenta,
		[BoxedTextColor.SealedType] = ConsoleColor.Magenta,
		[BoxedTextColor.StaticType] = ConsoleColor.Magenta,
		[BoxedTextColor.Delegate] = ConsoleColor.Magenta,
		[BoxedTextColor.Enum] = ConsoleColor.Magenta,
		[BoxedTextColor.Interface] = ConsoleColor.Magenta,
		[BoxedTextColor.ValueType] = ConsoleColor.Green,
		[BoxedTextColor.Module] = ConsoleColor.DarkMagenta,
		[BoxedTextColor.TypeGenericParameter] = ConsoleColor.Magenta,
		[BoxedTextColor.MethodGenericParameter] = ConsoleColor.Magenta,
		[BoxedTextColor.InstanceMethod] = ConsoleColor.DarkYellow,
		[BoxedTextColor.StaticMethod] = ConsoleColor.DarkYellow,
		[BoxedTextColor.ExtensionMethod] = ConsoleColor.DarkYellow,
		[BoxedTextColor.InstanceField] = ConsoleColor.Magenta,
		[BoxedTextColor.EnumField] = ConsoleColor.Magenta,
		[BoxedTextColor.LiteralField] = ConsoleColor.Magenta,
		[BoxedTextColor.StaticField] = ConsoleColor.Magenta,
		[BoxedTextColor.InstanceEvent] = ConsoleColor.Magenta,
		[BoxedTextColor.StaticEvent] = ConsoleColor.Magenta,
		[BoxedTextColor.InstanceProperty] = ConsoleColor.Magenta,
		[BoxedTextColor.StaticProperty] = ConsoleColor.Magenta,
		[BoxedTextColor.Local] = ConsoleColor.White,
		[BoxedTextColor.Parameter] = ConsoleColor.White,
		[BoxedTextColor.PreprocessorKeyword] = ConsoleColor.Blue,
		[BoxedTextColor.Label] = ConsoleColor.DarkRed,
		[BoxedTextColor.OpCode] = ConsoleColor.Cyan,
		[BoxedTextColor.ILDirective] = ConsoleColor.Cyan,
		[BoxedTextColor.ILModule] = ConsoleColor.DarkMagenta,
		[BoxedTextColor.XmlDocCommentAttributeName] = ConsoleColor.DarkGreen,
		[BoxedTextColor.XmlDocCommentAttributeQuotes] = ConsoleColor.DarkGreen,
		[BoxedTextColor.XmlDocCommentAttributeValue] = ConsoleColor.DarkGreen,
		[BoxedTextColor.XmlDocCommentCDataSection] = ConsoleColor.DarkGreen,
		[BoxedTextColor.XmlDocCommentComment] = ConsoleColor.DarkGreen,
		[BoxedTextColor.XmlDocCommentDelimiter] = ConsoleColor.DarkGreen,
		[BoxedTextColor.XmlDocCommentEntityReference] = ConsoleColor.DarkGreen,
		[BoxedTextColor.XmlDocCommentName] = ConsoleColor.DarkGreen,
		[BoxedTextColor.XmlDocCommentProcessingInstruction] = ConsoleColor.DarkGreen,
		[BoxedTextColor.XmlDocCommentText] = ConsoleColor.DarkGreen,
		[BoxedTextColor.Error] = ConsoleColor.Red,
	};

	public static ConsoleColor? Of(object color) => color is string name && colors.TryGetValue(name, out var consoleColor) ? consoleColor : null;
}

/// <summary>
/// What the decompilers write a member to stdout through — the WPF console's ConsoleColorizerOutput and
/// TextWriterDecompilerOutput in one: the text with dnSpy's Indenter (a tab, or <c>--spaces</c> spaces, per level),
/// and with <c>colorize</c> each piece in its console color, the console's own color restored after it.
/// </summary>
sealed class ConsoleDecompilerOutput(TextWriter writer, bool colorize, string indentString) : IDecompilerOutput {
	bool addIndent = true;
	int indentLevel;
	int position;

	public int Length => position;
	public int NextPosition => position + (addIndent ? indentLevel * indentString.Length : 0);

	public void IncreaseIndent() => indentLevel++;
	public void DecreaseIndent() => indentLevel = Math.Max(0, indentLevel - 1);

	public void WriteLine() {
		var newLine = Environment.NewLine;
		writer.Write(newLine);
		position += newLine.Length;
		addIndent = true;
	}

	void AddIndent() {
		if (!addIndent)
			return;
		addIndent = false;
		for (var i = 0; i < indentLevel; i++) {
			writer.Write(indentString);
			position += indentString.Length;
		}
	}

	void AddText(string text, object color) {
		if (addIndent)
			AddIndent();
		if (colorize && ConsoleColors.Of(color) is { } consoleColor) {
			writer.Flush();
			Console.ForegroundColor = consoleColor;
			writer.Write(text);
			writer.Flush();
			Console.ResetColor();
		}
		else
			writer.Write(text);
		position += text.Length;
	}

	public void Write(string text, object color) => AddText(text, color);
	public void Write(string text, int index, int length, object color) => AddText(index == 0 && length == text.Length ? text : text.Substring(index, length), color);
	public void Write(string text, object? reference, DecompilerReferenceFlags flags, object color) => AddText(text, color);
	public void Write(string text, int index, int length, object? reference, DecompilerReferenceFlags flags, object color) => Write(text, index, length, color);

	public void AddBracePair(TextSpan start, TextSpan end, CodeBracesRangeFlags flags) { }
	public void AddLineSeparator(int position) { }
	public void AddDebugInfo(MethodDebugInfo debugInfo) { }
}
