using dnSpy.Backend.Core.ProjectExport;
using ICSharpCode.Decompiler;

namespace dnSpy.Cli;

/// <summary>
/// The C# settings used to produce the text a language is written from: the project export's rule, so a
/// member written to stdout reads as it does in an exported project.
/// </summary>
static class DecompilerSettingsFactory {
	public static DecompilerSettings ForLanguage(DecompilerSettings source, ConsoleLanguageKind language) =>
		ProjectExporter.SettingsForLanguage(source, language == ConsoleLanguageKind.VisualBasic);
}
