using System;

namespace dnSpy.Backend.Contracts;

// The value types the C# Interactive window's scripts print with. They mirror
// dnSpy.Contracts.Logic's TextColor, Scripting/IPrintOptions and Scripting.IOutputWriter, since a script
// compiled against the backend's contracts can only see this assembly.

/// <summary>
/// dnSpy's <c>TextColor</c> (<c>dnSpy.Contracts.Logic/Text/TextColor.cs</c>): the colors a script can pass to
/// <c>Print</c>. The names are the theme's color names in camel case, so <c>TextColor.StaticType</c> is the
/// same color class the decompiler uses for a static type.
/// </summary>
public enum TextColor {
	// IMPORTANT: The order must match dnSpy.Contracts.Themes.ColorType

	#pragma warning disable CS1591 // Missing XML comment for publicly visible type or member
	Text,
	Operator,
	Punctuation,
	Number,
	Comment,
	Keyword,
	String,
	VerbatimString,
	Char,
	Namespace,
	Type,
	SealedType,
	StaticType,
	Delegate,
	Enum,
	Interface,
	ValueType,
	Module,
	TypeGenericParameter,
	MethodGenericParameter,
	InstanceMethod,
	StaticMethod,
	ExtensionMethod,
	InstanceField,
	EnumField,
	LiteralField,
	StaticField,
	InstanceEvent,
	StaticEvent,
	InstanceProperty,
	StaticProperty,
	Local,
	Parameter,
	PreprocessorKeyword,
	PreprocessorText,
	Label,
	OpCode,
	ILDirective,
	ILModule,
	ExcludedCode,
	XmlDocCommentAttributeName,
	XmlDocCommentAttributeQuotes,
	XmlDocCommentAttributeValue,
	XmlDocCommentCDataSection,
	XmlDocCommentComment,
	XmlDocCommentDelimiter,
	XmlDocCommentEntityReference,
	XmlDocCommentName,
	XmlDocCommentProcessingInstruction,
	XmlDocCommentText,
	XmlLiteralAttributeName,
	XmlLiteralAttributeQuotes,
	XmlLiteralAttributeValue,
	XmlLiteralCDataSection,
	XmlLiteralComment,
	XmlLiteralDelimiter,
	XmlLiteralEmbeddedExpression,
	XmlLiteralEntityReference,
	XmlLiteralName,
	XmlLiteralProcessingInstruction,
	XmlLiteralText,
	XmlAttribute,
	XmlAttributeQuotes,
	XmlAttributeValue,
	XmlCDataSection,
	XmlComment,
	XmlDelimiter,
	XmlKeyword,
	XmlName,
	XmlProcessingInstruction,
	XmlText,
	XamlAttribute,
	XamlAttributeQuotes,
	XamlAttributeValue,
	XamlCDataSection,
	XamlComment,
	XamlDelimiter,
	XamlKeyword,
	XamlMarkupExtensionClass,
	XamlMarkupExtensionParameterName,
	XamlMarkupExtensionParameterValue,
	XamlName,
	XamlProcessingInstruction,
	XamlText,
	XmlDocToolTipHeader,
	Assembly,
	AssemblyExe,
	AssemblyModule,
	DirectoryPart,
	FileNameNoExtension,
	FileExtension,
	Error,
	ToStringEval,
	ReplPrompt1,
	ReplPrompt2,
	ReplOutputText,
	ReplScriptOutputText,
	Black,
	Blue,
	Cyan,
	DarkBlue,
	DarkCyan,
	DarkGray,
	DarkGreen,
	DarkMagenta,
	DarkRed,
	DarkYellow,
	Gray,
	Green,
	Magenta,
	Red,
	White,
	Yellow,
	InvBlack,
	InvBlue,
	InvCyan,
	InvDarkBlue,
	InvDarkCyan,
	InvDarkGray,
	InvDarkGreen,
	InvDarkMagenta,
	InvDarkRed,
	InvDarkYellow,
	InvGray,
	InvGreen,
	InvMagenta,
	InvRed,
	InvWhite,
	InvYellow,
	DebugLogExceptionHandled,
	DebugLogExceptionUnhandled,
	DebugLogStepFiltering,
	DebugLogLoadModule,
	DebugLogUnloadModule,
	DebugLogExitProcess,
	DebugLogExitThread,
	DebugLogProgramOutput,
	DebugLogMDA,
	DebugLogTimestamp,
	LineNumber,
	ReplLineNumberInput1,
	ReplLineNumberInput2,
	ReplLineNumberOutput,
	VisibleWhitespace,
	SelectedText,
	InactiveSelectedText,
	HighlightedReference,
	HighlightedWrittenReference,
	HighlightedDefinition,
	CurrentStatement,
	CurrentStatementMarker,
	CallReturn,
	CallReturnMarker,
	ActiveStatementMarker,
	BreakpointStatement,
	BreakpointStatementMarker,
	SelectedBreakpointStatementMarker,
	DisabledBreakpointStatementMarker,
	CurrentLine,
	CurrentLineNoFocus,
	HexText,
	HexOffset,
	HexByte0,
	HexByte1,
	HexByteError,
	HexAscii,
	HexCaret,
	HexInactiveCaret,
	HexSelection,
	GlyphMargin,
	BraceMatching,
	LineSeparator,
	FindMatchHighlightMarker,
	BlockStructureNamespace,
	BlockStructureType,
	BlockStructureModule,
	BlockStructureValueType,
	BlockStructureInterface,
	BlockStructureMethod,
	BlockStructureAccessor,
	BlockStructureAnonymousMethod,
	BlockStructureConstructor,
	BlockStructureDestructor,
	BlockStructureOperator,
	BlockStructureConditional,
	BlockStructureLoop,
	BlockStructureProperty,
	BlockStructureEvent,
	BlockStructureTry,
	BlockStructureCatch,
	BlockStructureFilter,
	BlockStructureFinally,
	BlockStructureFault,
	BlockStructureLock,
	BlockStructureUsing,
	BlockStructureFixed,
	BlockStructureSwitch,
	BlockStructureCase,
	BlockStructureLocalFunction,
	BlockStructureOther,
	BlockStructureXml,
	BlockStructureXaml,
	CompletionMatchHighlight,
	CompletionSuffix,
	SignatureHelpDocumentation,
	SignatureHelpCurrentParameter,
	SignatureHelpParameter,
	SignatureHelpParameterDocumentation,
	Url,
	HexPeDosHeader,
	HexPeFileHeader,
	HexPeOptionalHeader32,
	HexPeOptionalHeader64,
	HexPeSection,
	HexPeSectionName,
	HexCor20Header,
	HexStorageSignature,
	HexStorageHeader,
	HexStorageStream,
	HexStorageStreamName,
	HexStorageStreamNameInvalid,
	HexTablesStream,
	HexTableName,
	DocumentListMatchHighlight,
	GacMatchHighlight,
	AppSettingsTreeViewNodeMatchHighlight,
	AppSettingsTextMatchHighlight,
	HexCurrentLine,
	HexCurrentLineNoFocus,
	HexInactiveSelectedText,
	HexColumnLine0,
	HexColumnLine1,
	HexColumnLineGroup0,
	HexColumnLineGroup1,
	HexHighlightedValuesColumn,
	HexHighlightedAsciiColumn,
	HexGlyphMargin,
	HexCurrentValueCell,
	HexCurrentAsciiCell,
	OutputWindowText,
	HexFindMatchHighlightMarker,
	HexToolTipServiceField0,
	HexToolTipServiceField1,
	HexToolTipServiceCurrentField,
	ListFindMatchHighlight,
	AdvancedBreakpointStatement,
	AdvancedBreakpointStatementMarker,
	SelectedAdvancedBreakpointStatementMarker,
	DisabledAdvancedBreakpointStatement,
	DisabledAdvancedBreakpointStatementMarker,
	SelectedDisabledAdvancedBreakpointStatementMarker,
	BreakpointWarningStatement,
	BreakpointWarningStatementMarker,
	SelectedBreakpointWarningStatementMarker,
	BreakpointErrorStatement,
	BreakpointErrorStatementMarker,
	SelectedBreakpointErrorStatementMarker,
	AdvancedBreakpointWarningStatement,
	AdvancedBreakpointWarningStatementMarker,
	SelectedAdvancedBreakpointWarningStatementMarker,
	AdvancedBreakpointErrorStatement,
	AdvancedBreakpointErrorStatementMarker,
	SelectedAdvancedBreakpointErrorStatementMarker,
	TracepointStatement,
	TracepointStatementMarker,
	SelectedTracepointStatementMarker,
	DisabledTracepointStatement,
	DisabledTracepointStatementMarker,
	SelectedDisabledTracepointStatementMarker,
	AdvancedTracepointStatement,
	AdvancedTracepointStatementMarker,
	SelectedAdvancedTracepointStatementMarker,
	DisabledAdvancedTracepointStatement,
	DisabledAdvancedTracepointStatementMarker,
	SelectedDisabledAdvancedTracepointStatementMarker,
	TracepointWarningStatement,
	TracepointWarningStatementMarker,
	SelectedTracepointWarningStatementMarker,
	TracepointErrorStatement,
	TracepointErrorStatementMarker,
	SelectedTracepointErrorStatementMarker,
	AdvancedTracepointWarningStatement,
	AdvancedTracepointWarningStatementMarker,
	SelectedAdvancedTracepointWarningStatementMarker,
	AdvancedTracepointErrorStatement,
	AdvancedTracepointErrorStatementMarker,
	SelectedAdvancedTracepointErrorStatementMarker,
	BookmarkName,
	ActiveBookmarkName,
	DebugLogTrace,
	DebugLogExtensionMessage,
	DebuggerValueChangedHighlight,
	DebugExceptionName,
	DebugStowedExceptionName,
	DebugReturnValueName,
	DebugVariableName,
	DebugObjectIdName,
	DebuggerDisplayAttributeEval,
	DebuggerNoStringQuotesEval,
	DebugViewPropertyName,
	AsmComment,
	AsmDirective,
	AsmPrefix,
	AsmMnemonic,
	AsmKeyword,
	AsmOperator,
	AsmPunctuation,
	AsmNumber,
	AsmRegister,
	AsmSelectorValue,
	AsmLabelAddress,
	AsmFunctionAddress,
	AsmLabel,
	AsmFunction,
	AsmData,
	AsmAddress,
	AsmHexBytes,

	/// <summary>
	/// Must be last
	/// </summary>
	Last,
#pragma warning restore CS1591 // Missing XML comment for publicly visible type or member
}

/// <summary>The color class name dnSpy's theme gives a <see cref="TextColor"/>.</summary>
public static class ScriptTextColors {
	public static string Name(TextColor color) => System.Text.Json.JsonNamingPolicy.CamelCase.ConvertName(color.ToString());
}

/// <summary>dnSpy's <c>MemberDisplayFormat</c>: how an object's members are printed.</summary>
public enum MemberDisplayFormat {
	/// <summary>Everything on one line.</summary>
	SingleLine,
	/// <summary>One member per line.</summary>
	SeparateLines,
	/// <summary>Only the type name.</summary>
	Hidden,
}

/// <summary>
/// dnSpy's <c>PrintOptions</c>: the options that decide how <c>Print(value)</c> formats an object.
/// </summary>
public sealed class ScriptPrintOptions {
	/// <summary>Printed in place of members that were not printed.</summary>
	public string Ellipsis { get; set; } = "\u2026";

	/// <summary>Escape non-printable characters instead of writing them.</summary>
	public bool EscapeNonPrintableCharacters { get; set; } = true;

	/// <summary>The longest output a value produces before it is cut off.</summary>
	public int MaximumOutputLength { get; set; } = 10_000;

	/// <summary>How an object's members are printed.</summary>
	public MemberDisplayFormat MemberDisplayFormat { get; set; } = MemberDisplayFormat.SingleLine;

	/// <summary>The radix numbers are printed in; 10 or 16.</summary>
	public int NumberRadix { get; set; } = 10;

	/// <summary>
	/// When true, a value that implements <see cref="IOutputWritable"/> writes itself in color instead of being
	/// formatted by the C# object formatter.
	/// </summary>
	public bool AutoColorizeObjects { get; set; } = true;

	/// <summary>A copy, which dnSpy's <c>CachedWriter</c> takes when it is created.</summary>
	public ScriptPrintOptions Clone() => new() {
		Ellipsis = Ellipsis,
		EscapeNonPrintableCharacters = EscapeNonPrintableCharacters,
		MaximumOutputLength = MaximumOutputLength,
		MemberDisplayFormat = MemberDisplayFormat,
		NumberRadix = NumberRadix,
		AutoColorizeObjects = AutoColorizeObjects,
	};
}

/// <summary>A stretch of text and the color to write it in: a <see cref="TextColor"/>, or a color class name.</summary>
public readonly struct ColorAndText {
	/// <summary>Color; a <see cref="TextColor"/>, a color class name, or null for the plain output color.</summary>
	public object? Color { get; }

	/// <summary>Text.</summary>
	public string Text { get; }

	/// <summary>Constructor.</summary>
	public ColorAndText(object? color, string text) {
		Color = color;
		Text = text;
	}

	/// <summary>Constructor.</summary>
	public ColorAndText(TextColor color, string text) {
		Color = color;
		Text = text;
	}
}

/// <summary>dnSpy's <c>IOutputWriter</c>: writes colored text, one stretch at a time.</summary>
public interface IOutputWriter {
	/// <summary>Writes text in the given color.</summary>
	void Write(string? text, object? color = null);

	/// <summary>Writes text in the given color.</summary>
	void Write(string? text, TextColor color);
}

/// <summary>Extension methods.</summary>
public static class OutputWriterExtensions {
	/// <summary>Writes text followed by a newline.</summary>
	public static void WriteLine(this IOutputWriter writer, string text, object? color) {
		writer.Write(text, color);
		writer.Write(Environment.NewLine, TextColor.ReplScriptOutputText);
	}

	/// <summary>Writes text followed by a newline.</summary>
	public static void WriteLine(this IOutputWriter writer, string text, TextColor color = TextColor.ReplScriptOutputText) {
		writer.Write(text, color);
		writer.Write(Environment.NewLine, TextColor.ReplScriptOutputText);
	}
}

/// <summary>dnSpy's <c>IOutputWritable</c>: an object that writes itself in color.</summary>
public interface IOutputWritable {
	/// <summary>Writes itself to <paramref name="output"/>.</summary>
	void WriteTo(IOutputWriter output);
}

/// <summary>Extension methods.</summary>
public static class OutputWritableExtensions {
	/// <summary>Writes text followed by a newline.</summary>
	public static void WriteLineTo(this IOutputWritable obj, IOutputWriter output) {
		obj.WriteTo(output);
		output.Write(Environment.NewLine, TextColor.ReplScriptOutputText);
	}
}

/// <summary>
/// dnSpy's <c>ITextPrinter</c>: the printing part of the script globals. Both the globals and
/// <see cref="ICachedWriter"/> are one.
/// </summary>
public interface ITextPrinter : IOutputWriter {
	/// <summary>Print options.</summary>
	ScriptPrintOptions PrintOptions { get; }

	/// <summary>Prints text in the error color.</summary>
	void PrintError(string? text);
	/// <summary>Prints formatted text in the error color.</summary>
	void PrintError(string fmt, params object[] args);
	/// <summary>Prints text in the error color followed by a newline.</summary>
	void PrintLineError(string? text);
	/// <summary>Prints formatted text in the error color followed by a newline.</summary>
	void PrintLineError(string fmt, params object[] args);

	/// <summary>Prints text.</summary>
	void Print(string? text);
	/// <summary>Prints text.</summary>
	void Print(string fmt, params object[] args);
	/// <summary>Prints text in a color.</summary>
	void Print(object? color, string? text);
	/// <summary>Prints text in a color.</summary>
	void Print(TextColor color, string? text);
	/// <summary>Prints text in a color.</summary>
	void Print(object? color, string fmt, params object[] args);
	/// <summary>Prints text in a color.</summary>
	void Print(TextColor color, string fmt, params object[] args);
	/// <summary>Prints text followed by a newline.</summary>
	void PrintLine(string? text = null);
	/// <summary>Prints text followed by a newline.</summary>
	void PrintLine(string fmt, params object[] args);
	/// <summary>Prints text followed by a newline.</summary>
	void PrintLine(object? color, string? text);
	/// <summary>Prints text followed by a newline.</summary>
	void PrintLine(TextColor color, string? text);
	/// <summary>Prints text followed by a newline.</summary>
	void PrintLine(object? color, string fmt, params object[] args);
	/// <summary>Prints text followed by a newline.</summary>
	void PrintLine(TextColor color, string fmt, params object[] args);
	/// <summary>Formats and prints a value.</summary>
	void Print(object value, object? color);
	/// <summary>Formats and prints a value.</summary>
	void Print(object value, TextColor color = TextColor.ReplScriptOutputText);
	/// <summary>Formats and prints a value followed by a newline.</summary>
	void PrintLine(object value, object? color);
	/// <summary>Formats and prints a value followed by a newline.</summary>
	void PrintLine(object value, TextColor color = TextColor.ReplScriptOutputText);
	/// <summary>Formats and prints an exception.</summary>
	void Print(Exception ex, object? color);
	/// <summary>Formats and prints an exception.</summary>
	void Print(Exception ex, TextColor color = TextColor.Error);
	/// <summary>Formats and prints an exception followed by a newline.</summary>
	void PrintLine(Exception ex, object? color);
	/// <summary>Formats and prints an exception followed by a newline.</summary>
	void PrintLine(Exception ex, TextColor color = TextColor.Error);
}

/// <summary>
/// dnSpy's <c>ICachedWriter</c>: writes text to a buffer and flushes it all at once, for a script that runs in
/// the background and prints when it is done.
/// </summary>
public interface ICachedWriter : ITextPrinter, IDisposable {
	/// <summary>Flushes the buffered output. <see cref="IDisposable.Dispose"/> calls it automatically.</summary>
	void Flush();
}

/// <summary>dnSpy's <c>MsgBoxButton</c>: the buttons a script's message box offers.</summary>
[Flags]
public enum MsgBoxButton {
	/// <summary>None, eg. the user closed the box.</summary>
	None = 0,
	/// <summary>OK.</summary>
	OK = 1,
	/// <summary>Yes.</summary>
	Yes = 2,
	/// <summary>No.</summary>
	No = 4,
	/// <summary>Cancel.</summary>
	Cancel = 8,
}
