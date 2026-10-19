namespace dnSpy.Cli;

/// <summary>
/// The text dnSpy.Console prints. It is the WPF console's resource set (dnSpy.Console.Resources),
/// kept in one place so the options, the help and the errors say what the Windows build says.
/// </summary>
static class ConsoleStrings {
	public const string Error1 = "ERROR: {0}";
	public const string UsageHeader = "[options] [fileOrDir1] [fileOrDir2] [...]";
	public const string Languages = "Languages:";
	public const string LanguageOptions = "Language options:";
	public const string LanguageOptionsDesc = "All boolean options can be disabled by using 'no-' or 'dont-', eg. --dont-sort-members";
	public const string ExamplesHeader = "Examples:";

	public const string FileOrDirDoesNotExist = "File/directory '{0}' doesn't exist";
	public const string InvalidOption = "Invalid option: {0}";
	public const string InvalidSolutionName = ".sln name ({0}) must be relative to project directory";
	public const string InvalidToken = "Invalid metadata token";
	public const string InvalidVSVersion = "Invalid Visual Studio version: {0}";
	public const string LanguageDoesNotExist = "Language '{0}' doesn't exist";
	public const string LanguageXDoesNotExist = "Language {0} does not exist";
	public const string MissingAsmSearchPath = "Missing assembly search path";
	public const string MissingDotNetFilename = "Missing .NET filename";
	public const string MissingLanguageName = "Missing language name";
	public const string MissingMDToken = "Missing metadata token";
	public const string MissingNumberOfThreads = "Missing number of threads";
	public const string MissingOptions = "No options specified";
	public const string MissingOutputDir = "Missing output directory";
	public const string MissingSolutionName = "Missing .sln name";
	public const string MissingVSVersion = "Missing Visual Studio version";
	public const string NoLanguagesFound = "No languages were found. Make sure that the language dll files exist in the same folder as this program.";
	public const string NotDotNetFile = "{0} is not a .NET file";
	public const string OnlyOneFileCanBeDecompiled = "Only one file can be decompiled when using --md";
	public const string MissingUserGacPath = "Missing user GAC path";
	public const string InvalidMemberToDecompile = "Only types, methods, fields, events and properties can be decompiled";
	public const string CouldNotFindTypeX = "Type {0} couldn't be found";
	public const string CouldNotResolveGacFileX = "Couldn't resolve GAC assembly '{0}'";
	public const string MissingGacFile = "Missing GAC assembly name";
	public const string MissingTypeName = "Missing full name of type";
	public const string LanguageXDoesNotSupportProjects = "Language {0} doesn't support creating project files";
	public const string MissingOptionArgument = "Missing option argument";
	public const string InvalidGuid = "Invalid GUID";
	public const string InvalidSpacesArgument = "Number of spaces must be between {0} and {1}";
	public const string MissingArgument = "Missing argument";

	public const string CmdLineAssembly = "assembly";
	public const string CmdLineDescription_AsmPath = "assembly search path. Paths can be separated with '{0}' or you can use multiple --asm-path's";
	public const string CmdLineDescription_GACFile = "decompile an assembly from the GAC. Use full assembly name to use an exact version.";
	public const string CmdLineDescription_Language = "set language, default is C#. Guids can be used.";
	public const string CmdLineDescription_MDToken = "decompile the member with metadata token N to stdout";
	public const string CmdLineDescription_NoBAML = "don't decompile baml to xaml";
	public const string CmdLineDescription_NoGAC = "don't use the GAC to look up assemblies. Useful with --no-stdlib";
	public const string CmdLineDescription_NoResources = "don't unpack resources";
	public const string CmdLineDescription_NoResX = "don't create .resx files";
	public const string CmdLineDescription_NoSLN = "don't create a .sln file";
	public const string CmdLineDescription_NoStdLib = "projects don't reference mscorlib";
	public const string CmdLineDescription_NumberOfThreads = "number of worker threads. Default is to use one thread per CPU core";
	public const string CmdLineDescription_OutputDirectory = "output directory";
	public const string CmdLineDescription_ProjectGUID = "project guid";
	public const string CmdLineDescription_RecursiveSearch = "recursive search for .NET files to decompile";
	public const string CmdLineDescription_SlnName = "name of the .sln file";
	public const string CmdLineDescription_Type1 = "decompile the type with the specified name to stdout. Either Namespace.Name or Name, case insensitive";
	public const string CmdLineDescription_Type2 = "same as -t";
	public const string CmdLineDescription_UserGAC = "user GAC path. Paths can be separated with '{0}' or you can use multiple --user-gac's";
	public const string CmdLineDescription_VSVersion = "Visual Studio version, 2005, 2008, ..., {0}";
	public const string CmdLineDescription_NoColor = "don't colorize the text";
	public const string CmdLineDescription_Spaces = "Size of a tab in spaces or 0 to use one tab";
	public const string CmdLineDescription_SdkProject = "generate SDK style project files";

	public const string CmdLineLanguage = "lang";
	public const string CmdLineName = "name";
	public const string CmdLineOutputDir = "outdir";
	public const string CmdLinePath = "path";

	public const string ExampleDescription1 = "Decompiles all .NET files in the above directory and saves files to /out/path";
	public const string ExampleDescription2 = "Decompiles all .NET files in the above directory and all sub directories";
	public const string ExampleDescription3 = "Decompiles all *.dll .NET files in the above directory and saves files to /out/path";
	public const string ExampleDescription4 = "Decompiles the member with token 0x06000123";
	public const string ExampleDescription5 = "Decompiles System.Int32 from mscorlib";
}
