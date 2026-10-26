using System.Globalization;
using dnSpy.Backend.Contracts;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.VisualBasic;

namespace dnSpy.Backend.Core.LanguageService;

/// <summary>
/// What dnSpy.Roslyn's <c>CSharpLanguageCompiler</c> and <c>VisualBasicLanguageCompiler</c> compile with, from the
/// Compiler page's settings. The Edit Code window's Compile and the language service of its editor both use these,
/// so the editor reports what compiling reports.
/// </summary>
public static class RoslynCompilerOptions {
	/// <summary>The C# symbols: dnSpy splits the page's text on ';' and ',' and drops what is empty.</summary>
	public static string[] CSharpPreprocessorSymbols(string text) =>
		text.Split([';', ','], StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);

	/// <summary>
	/// The Visual Basic symbols, which carry values: "K=V" gives V as a boolean, an integer, a number or a string —
	/// tried in that order, the quotes taken off a string — and a bare K is True.
	/// </summary>
	public static IEnumerable<KeyValuePair<string, object>> VisualBasicPreprocessorSymbols(string text) {
		foreach (var entry in CSharpPreprocessorSymbols(text)) {
			var separator = entry.IndexOf('=', StringComparison.Ordinal);
			if (separator < 0) {
				yield return new KeyValuePair<string, object>(entry, true);
				continue;
			}
			var name = entry[..separator].Trim();
			var value = entry[(separator + 1)..].Trim();
			object parsed = bool.TryParse(value, out var flag) ? flag
				: int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number) ? number
				: double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var real) ? real
				: value.Length >= 2 && value[0] == '"' && value[^1] == '"' ? value[1..^1]
				: value;
			if (name.Length > 0)
				yield return new KeyValuePair<string, object>(name, parsed);
		}
	}

	public static CSharpParseOptions CSharpParseOptions(CompilerSettingsDto settings) =>
		new(Microsoft.CodeAnalysis.CSharp.LanguageVersion.Latest, preprocessorSymbols: CSharpPreprocessorSymbols(settings.PreprocessorSymbols));

	public static VisualBasicParseOptions VisualBasicParseOptions(CompilerSettingsDto settings) =>
		new(Microsoft.CodeAnalysis.VisualBasic.LanguageVersion.Latest, preprocessorSymbols: VisualBasicPreprocessorSymbols(settings.PreprocessorSymbols));

	/// <summary>The C# page's options: optimized or not, checked arithmetic, unsafe code.</summary>
	public static CSharpCompilationOptions CSharpCompilationOptions(CompilerSettingsDto settings) =>
		new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
			.WithOptimizationLevel(settings.Optimize ? OptimizationLevel.Release : OptimizationLevel.Debug)
			.WithOverflowChecks(settings.CheckOverflow)
			.WithAllowUnsafe(settings.AllowUnsafe)
			.WithNullableContextOptions(NullableContextOptions.Enable)
			.WithDeterministic(true);

	/// <summary>
	/// The Visual Basic page's options; <paramref name="embedRuntime"/> is whether the runtime is compiled into the
	/// assembly rather than referenced (<see cref="CompilerReferences.EmbedVisualBasicRuntime"/>).
	/// </summary>
	public static VisualBasicCompilationOptions VisualBasicCompilationOptions(CompilerSettingsDto settings, bool embedRuntime) =>
		new VisualBasicCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
			.WithOptimizationLevel(settings.Optimize ? OptimizationLevel.Release : OptimizationLevel.Debug)
			.WithOverflowChecks(settings.CheckOverflow)
			.WithOptionExplicit(settings.OptionExplicit)
			.WithOptionInfer(settings.OptionInfer)
			.WithOptionStrict(settings.OptionStrict ? OptionStrict.On : OptionStrict.Off)
			.WithOptionCompareText(!settings.OptionCompareBinary)
			.WithEmbedVbCoreRuntime(embedRuntime)
			.WithDeterministic(true);
}

/// <summary>
/// The assemblies an edited module's code compiles against, and whether Visual Basic code embeds its runtime
/// instead of referencing it — what dnSpy's <c>GetRequiredAssemblyReferences</c> decides.
/// </summary>
public sealed record CompilerReferences(IReadOnlyList<string> Paths, bool EmbedVisualBasicRuntime);
