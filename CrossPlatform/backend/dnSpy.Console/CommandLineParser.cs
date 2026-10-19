using System.Globalization;
using ICSharpCode.Decompiler;

namespace dnSpy.Cli;

/// <summary>A command line error; like dnSpy's ErrorException, it makes the console print the help.</summary>
sealed class ConsoleErrorException(string message) : Exception(message);

internal enum ProjectVersion {
	VS2005,
	VS2008,
	VS2010,
	VS2012,
	VS2013,
	VS2015,
	VS2017,
	VS2019,
	VS2022,
}

internal sealed class CommandLineOptions {
	public bool IsRecursive;
	public bool UseGac = true;
	public bool AddCorlibReference = true;
	public bool CreateSolutionFile = true;
	public bool UnpackResources = true;
	public bool CreateResX = true;
	public bool DecompileBaml = true;
	public bool ColorizeOutput;
	public bool SdkProject;
	public Guid ProjectGuid = Guid.NewGuid();
	public int NumberOfThreads;
	public int MdToken;
	public int Spaces;
	public string? TypeName;
	public ProjectVersion ProjectVersion = ProjectVersion.VS2010;
	public string? OutputDirectory;
	public string SolutionName = "solution.sln";
	public List<string> Files { get; } = [];
	public List<string> AssemblySearchPaths { get; } = [];
	public List<string> UserGacPaths { get; } = [];
	public List<string> GacFiles { get; } = [];
	public ConsoleLanguage Language { get; set; } = ConsoleLanguage.CSharp;
	public DecompilerSettings Settings { get; } = new();
	public IlDecompilerOptions IlOptions { get; } = new();
}

/// <summary>
/// Parses the switches the WPF console accepts. Every switch and every message comes from
/// dnSpy.Console's Program.cs: the same short and long forms, the same "last one wins", the same
/// language-specific switches that change with <c>-l</c>, and the same errors.
/// </summary>
static class CommandLineParser {
	const string BOOLEAN_NO_PREFIX = "no-";
	const string BOOLEAN_DONT_PREFIX = "dont-";

	public static CommandLineOptions Parse(string[] args, bool defaultColorize) {
		if (args.Length == 0)
			throw new ConsoleErrorException(ConsoleStrings.MissingOptions);

		var options = new CommandLineOptions { ColorizeOutput = defaultColorize };
		bool canParseCommands = true;
		Dictionary<string, (LanguageOption Option, bool? BooleanValue)>? languageOptions = null;
		for (int i = 0; i < args.Length; i++) {
			languageOptions ??= CreateLanguageOptions(options);
			var arg = args[i];
			var next = i + 1 < args.Length ? args[i + 1] : null;
			if (arg.Length == 0)
				continue;

			if (canParseCommands && arg[0] == '-') {
				switch (arg) {
				case "--":
					canParseCommands = false;
					break;

				case "-r":
				case "--recursive":
					options.IsRecursive = true;
					break;

				case "--sdk-project":
					options.SdkProject = true;
					break;

				case "-o":
				case "--output-dir":
					if (next is null)
						throw new ConsoleErrorException(ConsoleStrings.MissingOutputDir);
					options.OutputDirectory = Path.GetFullPath(next);
					i++;
					break;

				case "-l":
				case "--lang":
					if (next is null)
						throw new ConsoleErrorException(ConsoleStrings.MissingLanguageName);
					var language = ConsoleLanguage.Find(next) ?? throw new ConsoleErrorException(string.Format(CultureInfo.CurrentCulture, ConsoleStrings.LanguageDoesNotExist, next));
					options.Language = language;
					i++;
					languageOptions = null;
					break;

				case "--asm-path":
					if (next is null)
						throw new ConsoleErrorException(ConsoleStrings.MissingAsmSearchPath);
					options.AssemblySearchPaths.AddRange(next.Split([Path.PathSeparator], StringSplitOptions.RemoveEmptyEntries));
					i++;
					break;

				case "--user-gac":
					if (next is null)
						throw new ConsoleErrorException(ConsoleStrings.MissingUserGacPath);
					options.UserGacPaths.AddRange(next.Split([Path.PathSeparator], StringSplitOptions.RemoveEmptyEntries));
					i++;
					break;

				case "--no-gac":
					options.UseGac = false;
					break;

				case "--no-stdlib":
					options.AddCorlibReference = false;
					break;

				case "--no-sln":
					options.CreateSolutionFile = false;
					break;

				case "--sln-name":
					if (next is null)
						throw new ConsoleErrorException(ConsoleStrings.MissingSolutionName);
					options.SolutionName = next;
					i++;
					if (Path.IsPathRooted(options.SolutionName))
						throw new ConsoleErrorException(string.Format(CultureInfo.CurrentCulture, ConsoleStrings.InvalidSolutionName, options.SolutionName));
					break;

				case "--threads":
					if (next is null)
						throw new ConsoleErrorException(ConsoleStrings.MissingNumberOfThreads);
					i++;
					options.NumberOfThreads = ParseInt32(next);
					break;

				case "--vs":
					if (next is null)
						throw new ConsoleErrorException(ConsoleStrings.MissingVSVersion);
					i++;
					options.ProjectVersion = ParseProjectVersion(next);
					break;

				case "--no-resources":
					options.UnpackResources = false;
					break;

				case "--no-resx":
					options.CreateResX = false;
					break;

				case "--no-baml":
					options.DecompileBaml = false;
					break;

				case "--no-color":
					options.ColorizeOutput = false;
					break;

				case "--spaces":
					if (next is null)
						throw new ConsoleErrorException(ConsoleStrings.MissingArgument);
					const int MIN_SPACES = 0, MAX_SPACES = 100;
					if (!int.TryParse(next, NumberStyles.Integer, CultureInfo.InvariantCulture, out options.Spaces) || options.Spaces < MIN_SPACES || options.Spaces > MAX_SPACES)
						throw new ConsoleErrorException(string.Format(CultureInfo.CurrentCulture, ConsoleStrings.InvalidSpacesArgument, MIN_SPACES, MAX_SPACES));
					i++;
					break;

				case "-t":
				case "--type":
					if (next is null)
						throw new ConsoleErrorException(ConsoleStrings.MissingTypeName);
					i++;
					options.TypeName = next;
					break;

				case "--md":
					if (next is null)
						throw new ConsoleErrorException(ConsoleStrings.MissingMDToken);
					i++;
					options.MdToken = ParseInt32(next);
					break;

				case "--gac-file":
					if (next is null)
						throw new ConsoleErrorException(ConsoleStrings.MissingGacFile);
					i++;
					options.GacFiles.Add(next);
					break;

				case "--project-guid":
					if (next is null || !Guid.TryParse(next, out var projectGuid))
						throw new ConsoleErrorException(ConsoleStrings.InvalidGuid);
					options.ProjectGuid = projectGuid;
					i++;
					break;

				default:
					if (!languageOptions.TryGetValue(arg, out var entry))
						throw new ConsoleErrorException(string.Format(CultureInfo.CurrentCulture, ConsoleStrings.InvalidOption, arg));
					if (entry.Option.Type == LanguageOptionType.Boolean) {
						entry.Option.Set(entry.BooleanValue ?? true);
						break;
					}
					if (next is null)
						throw new ConsoleErrorException(ConsoleStrings.MissingOptionArgument);
					i++;
					entry.Option.Set(entry.Option.Type switch {
						LanguageOptionType.Int32 => ParseInt32(next),
						_ => next,
					});
					break;
				}
			}
			else
				options.Files.Add(arg);
		}
		return options;
	}

	static Dictionary<string, (LanguageOption Option, bool? BooleanValue)> CreateLanguageOptions(CommandLineOptions options) {
		var dict = new Dictionary<string, (LanguageOption, bool?)>(StringComparer.Ordinal);
		foreach (var option in LanguageOptions.For(options.Language, options.Settings, options.IlOptions)) {
			var name = "--" + FixInvalidSwitchChars(option.Name);
			if (option.Type == LanguageOptionType.Boolean) {
				dict[name] = (option, true);
				dict["--" + BOOLEAN_NO_PREFIX + FixInvalidSwitchChars(option.Name)] = (option, false);
				dict["--" + BOOLEAN_DONT_PREFIX + FixInvalidSwitchChars(option.Name)] = (option, false);
			}
			else
				dict[name] = (option, null);
		}
		return dict;
	}

	static string FixInvalidSwitchChars(string value) => value.Replace(' ', '-');

	static int ParseInt32(string value) {
		if (TryParseInt32(value, out var result))
			return result;
		throw new ConsoleErrorException(string.Format(CultureInfo.CurrentCulture, "Invalid number: {0}", value));
	}

	/// <summary>Accepts what dnSpy's SimpleTypeConverter accepts: decimal, and 0x-prefixed hex.</summary>
	static bool TryParseInt32(string value, out int result) {
		if (value.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) {
			if (uint.TryParse(value[2..], NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var hex)) {
				result = unchecked((int)hex);
				return true;
			}
		}
		else if (value.StartsWith("-0x", StringComparison.OrdinalIgnoreCase)) {
			if (uint.TryParse(value[3..], NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var hex)) {
				result = unchecked(-(int)hex);
				return true;
			}
		}
		else if (int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out result)) {
			return true;
		}
		result = 0;
		return false;
	}

	static ProjectVersion ParseProjectVersion(string value) {
		var version = ParseInt32(value);
		return version switch {
			2005 => ProjectVersion.VS2005,
			2008 => ProjectVersion.VS2008,
			2010 => ProjectVersion.VS2010,
			2012 => ProjectVersion.VS2012,
			2013 => ProjectVersion.VS2013,
			2015 => ProjectVersion.VS2015,
			2017 => ProjectVersion.VS2017,
			2019 => ProjectVersion.VS2019,
			2022 => ProjectVersion.VS2022,
			_ => throw new ConsoleErrorException(string.Format(CultureInfo.CurrentCulture, ConsoleStrings.InvalidVSVersion, version)),
		};
	}
}
