using System.Globalization;
using System.Security;
using System.Text;
using dnlib.DotNet;
using dnSpy.Backend.Core;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.Metadata;

namespace dnSpy.Cli;

/// <summary>
/// dnSpy.Console's entry point, kept free of <see cref="Console"/> so the tests can run it in
/// process. It finds the files, opens them, and either writes one member to stdout or exports
/// projects; the exit code is the WPF console's: 0 when nothing went wrong, 1 otherwise.
/// </summary>
sealed class DnSpyConsole(TextWriter output, TextWriter error, bool colorizeDefault) {
	readonly ModuleContext moduleContext = ModuleDef.CreateModuleContext();
	readonly HashSet<string> addedPaths = new(StringComparer.OrdinalIgnoreCase);
	int errors;

	public DnSpyConsole(TextWriter output, TextWriter error) : this(output, error, !Console.IsOutputRedirected) {
	}

	AssemblyResolver Resolver => (AssemblyResolver)moduleContext.AssemblyResolver;

	public int Run(string[] args) {
		try {
			var options = CommandLineParser.Parse(args, colorizeDefault);
			Decompile(options);
		}
		catch (ConsoleErrorException ex) {
			PrintHelp(output);
			output.WriteLine();
			output.WriteLine(ConsoleStrings.Error1, ex.Message);
			return 1;
		}
		catch (Exception ex) {
			Dump(ex);
			return 1;
		}
		return errors == 0 ? 0 : 1;
	}

	void Decompile(CommandLineOptions options) {
		foreach (var directory in options.AssemblySearchPaths.Concat(options.UserGacPaths))
			AddSearchPath(directory);
		Resolver.UseGAC = options.UseGac;

		var loaded = new List<LoadedModule>();
		try {
			var modules = LoadModules(options, loaded);
			if (options.MdToken != 0 || options.TypeName is not null) {
				DecompileToStdout(options, modules);
				return;
			}
			Export(options, modules);
		}
		finally {
			foreach (var module in loaded)
				module.Dispose();
		}
	}

	List<LoadedModule> LoadModules(CommandLineOptions options, List<LoadedModule> loaded) {
		var moduleDefs = new List<(string Path, ModuleDefMD Module)>();
		foreach (var (path, module) in GetDotNetModules(options))
			moduleDefs.Add((path, module));
		foreach (var gacFile in options.GacFiles) {
			var path = ResolveGacFile(gacFile, options);
			if (path is null)
				throw new ConsoleErrorException(string.Format(CultureInfo.CurrentCulture, ConsoleStrings.CouldNotResolveGacFileX, gacFile));
			var module = OpenNetFile(path);
			if (module is null)
				throw new Exception(string.Format(CultureInfo.CurrentCulture, ConsoleStrings.NotDotNetFile, path));
			moduleDefs.Add((path, module));
		}

		var searchPaths = options.AssemblySearchPaths
			.Concat(options.UserGacPaths)
			.Concat(moduleDefs.Select(moduleDef => Path.GetDirectoryName(moduleDef.Path) ?? string.Empty))
			.ToArray();
		foreach (var (path, module) in moduleDefs) {
			var file = new PEFile(path);
			var resolver = CliAssemblyResolver.Create(path, searchPaths, options.UserGacPaths, options.UseGac);
			var loadedModule = new LoadedModule(path, module, file, resolver);
			loaded.Add(loadedModule);
		}
		return loaded;
	}

	/// <summary>
	/// The files the command line names: a file, a directory (its .NET files), or a directory with a
	/// wildcard. Directories are searched recursively only with -r, as dnSpy searches them.
	/// </summary>
	IEnumerable<(string Path, ModuleDefMD Module)> GetDotNetModules(CommandLineOptions options) {
		foreach (var name in options.Files) {
			if (File.Exists(name)) {
				var module = OpenNetFile(name);
				// dnSpy throws a plain exception here, so a file the user named by hand is reported
				// with its stack rather than with the help text.
				if (module is null)
					throw new Exception(string.Format(CultureInfo.CurrentCulture, ConsoleStrings.NotDotNetFile, name));
				yield return (Path.GetFullPath(name), module);
			}
			else if (Directory.Exists(name)) {
				foreach (var entry in DumpDirectory(name, "*", options.IsRecursive))
					yield return entry;
			}
			else {
				var directory = Path.GetDirectoryName(name);
				var pattern = Path.GetFileName(name);
				if (!string.IsNullOrEmpty(directory) && Directory.Exists(directory)) {
					foreach (var entry in DumpDirectory(directory, pattern, options.IsRecursive))
						yield return entry;
				}
				else
					throw new ConsoleErrorException(string.Format(CultureInfo.CurrentCulture, ConsoleStrings.FileOrDirDoesNotExist, name));
			}
		}
	}

	IEnumerable<(string Path, ModuleDefMD Module)> DumpDirectory(string path, string pattern, bool recursive) {
		var stack = new Stack<string>();
		stack.Push(path);
		while (stack.Count > 0) {
			var current = stack.Pop();
			foreach (var file in EnumerateFiles(current, pattern)) {
				var module = OpenNetFile(file);
				if (module is not null)
					yield return (Path.GetFullPath(file), module);
			}
			if (!recursive)
				continue;
			foreach (var directory in EnumerateDirectories(current))
				stack.Push(directory);
		}
	}

	static IEnumerable<string> EnumerateFiles(string path, string pattern) {
		IEnumerable<FileSystemInfo>? entries = null;
		try {
			entries = new DirectoryInfo(path).EnumerateFileSystemInfos(pattern, SearchOption.TopDirectoryOnly);
		}
		catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or SecurityException) {
		}
		if (entries is null)
			yield break;
		foreach (var entry in entries) {
			if ((entry.Attributes & System.IO.FileAttributes.Directory) != 0)
				continue;
			yield return entry.FullName;
		}
	}

	static IEnumerable<string> EnumerateDirectories(string path) {
		IEnumerable<FileSystemInfo>? entries = null;
		try {
			entries = new DirectoryInfo(path).EnumerateFileSystemInfos("*", SearchOption.TopDirectoryOnly);
		}
		catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or SecurityException) {
		}
		if (entries is null)
			yield break;
		foreach (var entry in entries) {
			if ((entry.Attributes & System.IO.FileAttributes.Directory) == 0)
				continue;
			yield return entry.FullName;
		}
	}

	ModuleDefMD? OpenNetFile(string file) {
		try {
			file = Path.GetFullPath(file);
			if (!File.Exists(file))
				return null;
			var module = ModuleDefMD.Load(file, moduleContext);
			module.EnableTypeDefFindCache = true;
			Resolver.AddToCache(module);
			AddSearchPath(Path.GetDirectoryName(module.Location)!);
			return module;
		}
		catch (Exception) {
			return null;
		}
	}

	string? ResolveGacFile(string name, CommandLineOptions options) {
		// --gac-file accepts a partial name ("mscorlib, Version=4.0.0.0"), which is why dnSpy turns
		// exact matching off while it resolves one.
		var oldFindExactMatch = Resolver.FindExactMatch;
		try {
			Resolver.FindExactMatch = false;
			if (Resolver.Resolve(new AssemblyNameInfo(name), null) is { } assembly)
				return assembly.ManifestModule.Location;
		}
		catch (Exception) {
		}
		finally {
			Resolver.FindExactMatch = oldFindExactMatch;
		}

		var simpleName = name.Split(',')[0].Trim();
		if (TryFindInDirectories(simpleName, options.AssemblySearchPaths) is { } fromSearchPath)
			return fromSearchPath;
		if (TryFindInDirectories(simpleName, options.UserGacPaths) is { } fromUserGac)
			return fromUserGac;
		// --no-gac means the caches are not searched at all, here as much as in the resolver.
		if (!options.UseGac)
			return null;
		var wanted = ParseAssemblyIdentity(name);
		foreach (var file in GacInfo.GetAssemblies()) {
			if (!file.Name.Equals(simpleName, StringComparison.OrdinalIgnoreCase))
				continue;
			if (wanted.Version is not null && file.Version != wanted.Version)
				continue;
			if (!string.IsNullOrEmpty(wanted.Culture) && !file.Culture.Equals(wanted.Culture, StringComparison.OrdinalIgnoreCase))
				continue;
			if (!string.IsNullOrEmpty(wanted.Token) && !file.PublicKeyToken.Equals(wanted.Token, StringComparison.OrdinalIgnoreCase))
				continue;
			return file.Path;
		}
		return null;
	}

	static string? TryFindInDirectories(string simpleName, IEnumerable<string> directories) {
		foreach (var directory in directories) {
			foreach (var extension in new[] { ".dll", ".exe" }) {
				try {
					var file = Path.Combine(directory, simpleName + extension);
					if (File.Exists(file))
						return file;
				}
				catch (ArgumentException) {
				}
			}
		}
		return null;
	}

	static (Version? Version, string Culture, string Token) ParseAssemblyIdentity(string name) {
		Version? version = null;
		var culture = string.Empty;
		var token = string.Empty;
		foreach (var part in name.Split(',').Skip(1)) {
			var pair = part.Split('=', 2);
			if (pair.Length != 2)
				continue;
			var key = pair[0].Trim();
			var value = pair[1].Trim();
			if (key.Equals("Version", StringComparison.OrdinalIgnoreCase))
				Version.TryParse(value, out version);
			else if (key.Equals("Culture", StringComparison.OrdinalIgnoreCase) && !value.Equals("neutral", StringComparison.OrdinalIgnoreCase))
				culture = value;
			else if (key.Equals("PublicKeyToken", StringComparison.OrdinalIgnoreCase) && !value.Equals("null", StringComparison.OrdinalIgnoreCase))
				token = value;
		}
		return (version, culture, token);
	}

	void DecompileToStdout(CommandLineOptions options, List<LoadedModule> modules) {
		if (modules.Count == 0)
			throw new ConsoleErrorException(ConsoleStrings.MissingDotNetFilename);
		if (modules.Count != 1)
			throw new ConsoleErrorException(ConsoleStrings.OnlyOneFileCanBeDecompiled);

		var module = modules[0];
		IMemberDef? member;
		if (options.TypeName is not null)
			member = FindType(module.Module, options.TypeName);
		else
			member = ResolveToken(module.Module, options.MdToken);
		if (member is null) {
			if (options.TypeName is not null)
				throw new ConsoleErrorException(string.Format(CultureInfo.CurrentCulture, ConsoleStrings.CouldNotFindTypeX, options.TypeName));
			throw new ConsoleErrorException(ConsoleStrings.InvalidToken);
		}
		if (member is not (TypeDef or MethodDef or FieldDef or PropertyDef or EventDef))
			throw new ConsoleErrorException(ConsoleStrings.InvalidMemberToDecompile);

		var writer = new ColorTextWriter(output, options.ColorizeOutput);
		new DecompilerRunner(module, options).WriteTo(member, writer);
		writer.Flush();
	}

	void Export(CommandLineOptions options, List<LoadedModule> modules) {
		if (string.IsNullOrEmpty(options.OutputDirectory))
			throw new ConsoleErrorException(ConsoleStrings.MissingOutputDir);
		if (options.Language.ProjectFileExtension is null)
			throw new ConsoleErrorException(string.Format(CultureInfo.CurrentCulture, ConsoleStrings.LanguageXDoesNotSupportProjects, options.Language.Name));
		new ProjectExporter(options, modules, Error).Export();
	}

	static IMemberDef? ResolveToken(ModuleDef module, int token) {
		try {
			return module.ResolveToken(unchecked((uint)token)) as IMemberDef;
		}
		catch (Exception) {
			return null;
		}
	}

	static TypeDef? FindType(ModuleDef module, string name) =>
		FindTypeFullName(module, name, StringComparer.Ordinal) ??
		FindTypeFullName(module, name, StringComparer.OrdinalIgnoreCase) ??
		FindTypeName(module, name, StringComparer.Ordinal) ??
		FindTypeName(module, name, StringComparer.OrdinalIgnoreCase);

	static TypeDef? FindTypeFullName(ModuleDef module, string name, StringComparer comparer) {
		var builder = new StringBuilder();
		return module.GetTypes().FirstOrDefault(type => {
			builder.Clear();
			var withoutGenericArity = FullNameFactory.FullName(type, false, null, builder);
			if (comparer.Equals(withoutGenericArity, name))
				return true;
			builder.Clear();
			var withGenericArity = FullNameFactory.FullName(type, true, null, builder);
			if (comparer.Equals(withGenericArity, name))
				return true;
			return comparer.Equals(CleanTypeName(withoutGenericArity), name) || comparer.Equals(CleanTypeName(withGenericArity), name);
		});
	}

	static TypeDef? FindTypeName(ModuleDef module, string name, StringComparer comparer) {
		var builder = new StringBuilder();
		return module.GetTypes().FirstOrDefault(type => {
			builder.Clear();
			var withoutGenericArity = FullNameFactory.Name(type, false, builder);
			if (comparer.Equals(withoutGenericArity, name))
				return true;
			builder.Clear();
			var withGenericArity = FullNameFactory.Name(type, true, builder);
			if (comparer.Equals(withGenericArity, name))
				return true;
			return comparer.Equals(CleanTypeName(withoutGenericArity), name) || comparer.Equals(CleanTypeName(withGenericArity), name);
		});
	}

	static string CleanTypeName(string name) {
		var index = name.LastIndexOf('`');
		return index < 0 ? name : name[..index];
	}

	void AddSearchPath(string directory) {
		try {
			if (!string.IsNullOrEmpty(directory) && Directory.Exists(directory) && addedPaths.Add(Path.GetFullPath(directory)))
				Resolver.PreSearchPaths.Add(directory);
		}
		catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException) {
		}
	}

	void Error(string message) {
		errors++;
		error.WriteLine(string.Format(CultureInfo.CurrentCulture, ConsoleStrings.Error1, message));
	}

	// dnSpy's Dump: the error type, message and stack of the exception and of everything it wraps,
	// written to stdout the way the WPF console writes them.
	void Dump(Exception? exception) {
		while (exception is not null) {
			output.WriteLine(ConsoleStrings.Error1, exception.GetType());
			output.WriteLine("  {0}", exception.Message);
			output.WriteLine("  {0}", exception.StackTrace);
			exception = exception.InnerException;
		}
	}

	static string GetProgramBaseName() => GetBaseName(Environment.GetCommandLineArgs()[0]);

	static string GetBaseName(string name) {
		var index = name.LastIndexOf(Path.DirectorySeparatorChar);
		return index < 0 ? name : name[(index + 1)..];
	}

	internal static void PrintHelp(TextWriter writer) {
		var programName = GetProgramBaseName();
		writer.WriteLine(programName + " " + ConsoleStrings.UsageHeader);
		writer.WriteLine();
		foreach (var info in usageInfos) {
			var argument = info.OptionArgument is null ? info.Option : info.Option + " " + info.OptionArgument;
			writer.WriteLine("  {0,-12}   {1}", argument, string.Format(CultureInfo.CurrentCulture, info.Description, Path.PathSeparator));
		}
		writer.WriteLine();
		writer.WriteLine(ConsoleStrings.Languages);
		foreach (var language in ConsoleLanguage.All)
			writer.WriteLine("  {0} ({1})", language.Name, language.UniqueGuid.ToString("B"));

		var groups = new (ConsoleLanguage[] Languages, Func<IReadOnlyList<LanguageOption>> Options)[] {
			([ConsoleLanguage.CSharp, ConsoleLanguage.VisualBasic], () => LanguageOptions.ForCSharp(new DecompilerSettings())),
			([ConsoleLanguage.IL, ConsoleLanguage.ILWithCSharp], () => LanguageOptions.ForIL(new IlDecompilerOptions())),
		};
		var hasOptions = groups.Any(group => group.Options().Count > 0);
		if (hasOptions) {
			writer.WriteLine();
			writer.WriteLine(ConsoleStrings.LanguageOptions);
			writer.WriteLine(ConsoleStrings.LanguageOptionsDesc);
			foreach (var group in groups) {
				var options = group.Options();
				if (options.Count == 0)
					continue;
				writer.WriteLine();
				foreach (var language in group.Languages)
					writer.WriteLine("  {0} ({1})", language.Name, language.UniqueGuid.ToString("B"));
				foreach (var option in options)
					writer.WriteLine("    --{0}\t({1} = {2}) {3}", option.Name, option.TypeName, option.DefaultValueText, option.Description);
			}
		}

		writer.WriteLine();
		writer.WriteLine(ConsoleStrings.ExamplesHeader);
		foreach (var info in helpInfos) {
			writer.WriteLine("  " + programName + " " + info.CommandLine);
			writer.WriteLine("      " + info.Description);
		}
	}

	readonly record struct UsageInfo(string Option, string? OptionArgument, string Description);

	static readonly UsageInfo[] usageInfos = [
		new("--sdk-project", null, ConsoleStrings.CmdLineDescription_SdkProject),
		new("--asm-path", ConsoleStrings.CmdLinePath, ConsoleStrings.CmdLineDescription_AsmPath),
		new("--user-gac", ConsoleStrings.CmdLinePath, ConsoleStrings.CmdLineDescription_UserGAC),
		new("--no-gac", null, ConsoleStrings.CmdLineDescription_NoGAC),
		new("--no-stdlib", null, ConsoleStrings.CmdLineDescription_NoStdLib),
		new("--no-sln", null, ConsoleStrings.CmdLineDescription_NoSLN),
		new("--sln-name", ConsoleStrings.CmdLineName, ConsoleStrings.CmdLineDescription_SlnName),
		new("--threads", "N", ConsoleStrings.CmdLineDescription_NumberOfThreads),
		new("--no-resources", null, ConsoleStrings.CmdLineDescription_NoResources),
		new("--no-resx", null, ConsoleStrings.CmdLineDescription_NoResX),
		new("--no-baml", null, ConsoleStrings.CmdLineDescription_NoBAML),
		new("--no-color", null, ConsoleStrings.CmdLineDescription_NoColor),
		new("--spaces", "N", ConsoleStrings.CmdLineDescription_Spaces),
		new("--vs", "N", string.Format(CultureInfo.InvariantCulture, ConsoleStrings.CmdLineDescription_VSVersion, 2017)),
		new("--project-guid", "N", ConsoleStrings.CmdLineDescription_ProjectGUID),
		new("-t", ConsoleStrings.CmdLineName, ConsoleStrings.CmdLineDescription_Type1),
		new("--type", ConsoleStrings.CmdLineName, ConsoleStrings.CmdLineDescription_Type2),
		new("--md", "N", ConsoleStrings.CmdLineDescription_MDToken),
		new("--gac-file", ConsoleStrings.CmdLineAssembly, ConsoleStrings.CmdLineDescription_GACFile),
		new("-r", null, ConsoleStrings.CmdLineDescription_RecursiveSearch),
		new("-o", ConsoleStrings.CmdLineOutputDir, ConsoleStrings.CmdLineDescription_OutputDirectory),
		new("-l", ConsoleStrings.CmdLineLanguage, ConsoleStrings.CmdLineDescription_Language),
	];

	readonly record struct HelpInfo(string Description, string CommandLine);

	static readonly HelpInfo[] helpInfos = [
		new(ConsoleStrings.ExampleDescription1, "-o /out/path /some/path"),
		new(ConsoleStrings.ExampleDescription2, "-o /out/path -r /some/path"),
		new(ConsoleStrings.ExampleDescription3, "-o /out/path /some/path/*.dll"),
		new(ConsoleStrings.ExampleDescription4, "--md 0x06000123 file.dll"),
		new(ConsoleStrings.ExampleDescription5, "-t system.int32 --gac-file \"mscorlib, Version=4.0.0.0\""),
	];
}
