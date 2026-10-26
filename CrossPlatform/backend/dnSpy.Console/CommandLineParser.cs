using System.Globalization;
using dnSpy.Backend.Core;
using dnSpy.Backend.Core.ProjectExport;

namespace dnSpy.Cli;

/// <summary>A command line error; like dnSpy's ErrorException, it makes the console print the help.</summary>
sealed class ConsoleErrorException(string message) : Exception(message);

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
	/// <summary>The C# and Visual Basic languages' settings: those of dnSpy's ILSpy fork, with its defaults.</summary>
	public DnSpyDecompilerSettings Settings { get; } = CreateSettings();
	public IlDecompilerOptions IlOptions { get; } = new();

	/// <summary>
	/// The C# settings as the decompiler takes them, which is how the GUI's mapper reads the C# page: showing all members
	/// shows the automatic properties' and events' backing fields and the empty constructors too, and every type written
	/// with its namespace is what the package's UsingDeclarations off does, the fork's using-decl kept apart.
	/// </summary>
	public DnSpyDecompilerSettings EffectiveSettings() {
		var settings = (DnSpyDecompilerSettings)Settings.Clone();
		if (settings.ForceShowAllMembers) {
			settings.AutomaticProperties = false;
			settings.AutomaticEvents = false;
			settings.RemoveEmptyDefaultConstructors = false;
		}
		if (settings.FullyQualifyAllTypes) {
			settings.FullyQualifiedTypesKeepUsings = settings.UsingDeclarations;
			settings.UsingDeclarations = false;
		}
		return settings;
	}

	/// <summary>
	/// A new CSharpVBDecompilerSettings — what DecompilerSettingsService gives the console: the fork's
	/// DecompilerSettings defaults, whose decompilation order is methods, properties, events, fields, nested types, and
	/// whose namespaces are blocks (it predates file-scoped ones).
	/// </summary>
	static DnSpyDecompilerSettings CreateSettings() => new() {
		DecompilationOrder = ["methods", "properties", "events", "fields", "nestedTypes"],
		FileScopedNamespaces = false,
		ThrowOnAssemblyResolveErrors = false,
	};
}

/// <summary>
/// Parses the switches the WPF console accepts. Every switch and every message comes from
/// dnSpy.Console's Program.cs: the same short and long forms, the same "last one wins", the same
/// language-specific switches that change with <c>-l</c>, and the same errors.
/// </summary>
static class CommandLineParser {
	const string BOOLEAN_NO_PREFIX = "no-";
	const string BOOLEAN_DONT_PREFIX = "dont-";

	/// <summary>Fills in <paramref name="options"/>, which the help reads the options' values from if it fails.</summary>
	public static void Parse(string[] args, CommandLineOptions options) {
		if (args.Length == 0)
			throw new ConsoleErrorException(ConsoleStrings.MissingOptions);

		bool canParseCommands = true;
		Dictionary<string, (LanguageOption Option, Action<string> SetValue)>? languageOptions = null;
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
					var hasArg = entry.Option.Type != typeof(bool);
					if (hasArg && next is null)
						throw new ConsoleErrorException(ConsoleStrings.MissingOptionArgument);
					if (hasArg)
						i++;
					entry.SetValue(next ?? string.Empty);
					break;
				}
			}
			else
				options.Files.Add(arg);
		}
	}

	/// <summary>
	/// CreateDecompilerOptionsDictionary: a boolean option is three switches — the name sets it, no- and dont- clear
	/// it — and an Int32 or String option one switch that takes the next argument.
	/// </summary>
	static Dictionary<string, (LanguageOption Option, Action<string> SetValue)> CreateLanguageOptions(CommandLineOptions options) {
		var dict = new Dictionary<string, (LanguageOption, Action<string>)>(StringComparer.Ordinal);
		foreach (var option in LanguageOptions.For(options.Language, options)) {
			if (option.Type == typeof(bool)) {
				dict[GetOptionName(option)] = (option, _ => option.Value = true);
				dict[GetOptionName(option, BOOLEAN_NO_PREFIX)] = (option, _ => option.Value = false);
				dict[GetOptionName(option, BOOLEAN_DONT_PREFIX)] = (option, _ => option.Value = false);
			}
			else if (option.Type == typeof(int))
				dict[GetOptionName(option)] = (option, value => option.Value = ParseInt32(value));
			else
				dict[GetOptionName(option)] = (option, value => option.Value = value);
		}
		return dict;
	}

	/// <summary>
	/// GetOptionName: the option's name as a switch, or its guid where the name is one of the console's own switches.
	/// </summary>
	public static string GetOptionName(LanguageOption option, string? extraPrefix = null) {
		var prefix = "--" + extraPrefix;
		var name = prefix + FixInvalidSwitchChars(option.Name);
		if (reservedOptions.Contains(name))
			name = prefix + FixInvalidSwitchChars(option.Guid.ToString());
		return name;
	}

	static string FixInvalidSwitchChars(string value) => value.Replace(' ', '-');

	// Don't include 'no-' and 'dont-'
	static readonly string[] ourOptions = [
		"recursive",
		"output-dir",
		"lang",
		"sdk-project",
		"asm-path",
		"user-gac",
		"gac",
		"stdlib",
		"sln",
		"sln-name",
		"threads",
		"vs",
		"resources",
		"resx",
		"baml",
		"color",
		"spaces",
		"type",
		"md",
		"gac-file",
		"project-guid",
	];

	static readonly HashSet<string> reservedOptions = CreateReservedOptions();

	static HashSet<string> CreateReservedOptions() {
		var hash = new HashSet<string>(StringComparer.Ordinal);
		foreach (var a in ourOptions) {
			hash.Add("--" + a);
			hash.Add("--" + BOOLEAN_NO_PREFIX + a);
			hash.Add("--" + BOOLEAN_DONT_PREFIX + a);
		}
		return hash;
	}

	/// <summary>dnSpy's SimpleTypeConverter.ParseInt32: decimal or 0x/&amp;H hex, '_' separators allowed, a leading '-'.</summary>
	static int ParseInt32(string value) {
		var error = TryParseInt32(value, out var result);
		if (error is not null)
			throw new ConsoleErrorException(error);
		return result;
	}

	static string? TryParseInt32(string s, out int result) {
		result = 0;
		s = s.Trim().Replace("_", string.Empty, StringComparison.Ordinal);
		var isSigned = s.StartsWith('-');
		if (isSigned)
			s = s[1..];
		bool isValid;
		ulong value2 = 0;
		if (s.Trim() != s)
			isValid = false;
		else if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase) || s.StartsWith("&H", StringComparison.OrdinalIgnoreCase)) {
			var s2 = s[2..];
			isValid = s2.Trim() == s2 && ulong.TryParse(s2, NumberStyles.HexNumber, CultureInfo.CurrentCulture, out value2);
		}
		else
			isValid = ulong.TryParse(s, NumberStyles.Integer, CultureInfo.CurrentCulture, out value2);
		if (!isValid)
			return "The value is not a hexadecimal or decimal integer";
		long value;
		if (isSigned) {
			if (value2 > (ulong)long.MaxValue + 1)
				return "The value is too small";
			value = unchecked(-(long)value2);
		}
		else {
			if (value2 > long.MaxValue)
				return "The value is too big";
			value = (long)value2;
		}
		if (value < int.MinValue || value > int.MaxValue)
			return string.Format(CultureInfo.CurrentCulture, "Value must be between {0} ({2}0x{0:X}) and {1} (0x{1:X}) inclusive", int.MinValue, int.MaxValue, "-");
		result = (int)value;
		return null;
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
