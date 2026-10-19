using ICSharpCode.Decompiler;

namespace dnSpy.Cli;

/// <summary>
/// The C# settings used to produce the text a language is written from. C# uses the console's
/// settings as they are; Visual Basic is a conversion of C#, and the converter cannot express C#'s
/// nullable-reference annotations, so those are decompiled away first.
/// </summary>
static class DecompilerSettingsFactory {
	public static DecompilerSettings ForLanguage(DecompilerSettings source, ConsoleLanguageKind language) {
		var settings = source.Clone();
		// The converter has no primary constructors of its own: turning ILSpy's syntax off only makes
		// it write the captured parameter as `<name>P`, which is not C# either, so the setting stays
		// on and the converter's own limits are what the VB output has.
		if (language == ConsoleLanguageKind.VisualBasic)
			settings.NullableReferenceTypes = false;
		return settings;
	}
}
