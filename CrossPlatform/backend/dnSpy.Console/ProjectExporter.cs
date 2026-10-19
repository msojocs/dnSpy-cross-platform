using System.Globalization;
using System.Text;
using System.Xml.Linq;
using ICSharpCode.BamlDecompiler;
using ICSharpCode.CodeConverter;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.CSharp.ProjectDecompiler;
using ICSharpCode.Decompiler.CSharp.Syntax;
using ICSharpCode.Decompiler.CSharp.Transforms;
using ICSharpCode.Decompiler.DebugInfo;
using ICSharpCode.Decompiler.Metadata;
using ICSharpCode.Decompiler.TypeSystem;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;

namespace dnSpy.Cli;

/// <summary>
/// Exports the loaded modules the way dnSpy's MSBuildProjectCreator does: one directory and project
/// per module, the decompiled files inside, a solution beside them. The files themselves come from
/// ICSharpCode.Decompiler's project decompiler; the switches dnSpy's exporter has and ILSpy's does
/// not — resources kept raw, .resx off, BAML decompiled to XAML, project references between the
/// decompiled modules, the solution's project guids — are applied here.
/// </summary>
sealed class ProjectExporter(CommandLineOptions options, IReadOnlyList<LoadedModule> modules, Action<string> error) {
	public void Export() {
		var outputDirectory = options.OutputDirectory ?? throw new ConsoleErrorException(ConsoleStrings.MissingOutputDir);
		Directory.CreateDirectory(outputDirectory);
		AssignProjectNames();
		AssignProjectGuids();
		foreach (var module in modules) {
			try {
				ExportModule(module, outputDirectory);
			}
			catch (ConsoleErrorException) {
				throw;
			}
			catch (Exception ex) {
				error(string.Format(CultureInfo.CurrentCulture, "Failed to create project for '{0}': {1}", module.Path, ex.Message));
			}
		}
		if (options.CreateSolutionFile && !string.IsNullOrEmpty(options.SolutionName))
			new SolutionWriter(options, modules, error).Write(Path.Combine(outputDirectory, options.SolutionName));
	}

	void AssignProjectNames() {
		var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
		foreach (var module in modules) {
			var name = SanitizeName(module.AssemblyOrModuleName);
			if (!used.Add(name)) {
				for (var i = 2; ; i++) {
					var candidate = name + "." + i.ToString(CultureInfo.InvariantCulture);
					if (used.Add(candidate)) {
						name = candidate;
						break;
					}
				}
			}
			module.ProjectDirectoryName = name;
		}
	}

	static string SanitizeName(string name) {
		var sanitized = WholeProjectDecompiler.SanitizeFileName(name);
		if (sanitized.Length > 60)
			sanitized = sanitized[..60];
		return string.IsNullOrWhiteSpace(sanitized) ? "module" : sanitized;
	}

	void AssignProjectGuids() {
		var guidText = options.ProjectGuid.ToString();
		var number = uint.Parse(guidText.Substring(28, 8), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
		var format = guidText[..28] + "{0:X8}";
		foreach (var module in modules.OrderBy(module => module.Path, StringComparer.InvariantCultureIgnoreCase))
			module.ProjectGuid = new Guid(string.Format(CultureInfo.InvariantCulture, format, number++));
	}

	void ExportModule(LoadedModule module, string outputDirectory) {
		var projectDirectory = Path.Combine(outputDirectory, module.ProjectDirectoryName);
		Directory.CreateDirectory(projectDirectory);
		var settings = DecompilerSettingsFactory.ForLanguage(options.Settings, options.Language.Kind);
		settings.UseSdkStyleProjectFormat = options.SdkProject;
		settings.CSharpFormattingOptions.IndentationString = options.Spaces <= 0 ? "\t" : new string(' ', options.Spaces);
		settings.ThrowOnAssemblyResolveErrors = false;
		IProjectFileWriter projectWriter = options.SdkProject ? ProjectFileWriterSdkStyle.Default : ProjectFileWriterDefault.Instance;
		var decompiler = new CliWholeProjectDecompiler(settings, module.Resolver, projectWriter, module.Resolver, null, options);
		if (options.NumberOfThreads != 0)
			decompiler.MaxDegreeOfParallelism = options.NumberOfThreads;

		var projectFileName = module.ProjectDirectoryName + options.Language.ProjectFileExtension;
		var projectPath = Path.Combine(projectDirectory, projectFileName);
		var projectText = new StringWriter();
		var projectId = decompiler.DecompileProject(module.File, projectDirectory, projectText, CancellationToken.None);
		module.PlatformName = string.IsNullOrEmpty(projectId.PlatformName) ? "AnyCPU" : projectId.PlatformName;
		foreach (var decompilerError in decompiler.Errors)
			error(decompilerError.Message);
		foreach (var extraError in decompiler.ExtraErrors)
			error(extraError);

		var document = PostProcessProject(projectText.ToString(), module);
		if (options.Language.Kind == ConsoleLanguageKind.VisualBasic) {
			ConvertToVisualBasic(module, projectDirectory, document);
			var vbProjectPath = Path.ChangeExtension(projectPath, ".vbproj");
			File.WriteAllText(vbProjectPath, document.ToString(), new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
			return;
		}
		File.WriteAllText(projectPath, document.ToString(), new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
	}

	XDocument PostProcessProject(string text, LoadedModule module) {
		var document = XDocument.Parse(text);
		var root = document.Root ?? throw new InvalidOperationException("The project file is empty.");
		var ns = root.Name.Namespace;
		var siblings = modules
			.Where(sibling => sibling != module)
			.ToDictionary(sibling => sibling.AssemblyOrModuleName, StringComparer.OrdinalIgnoreCase);

		var propertyGroup = root.Elements(ns + "PropertyGroup").FirstOrDefault();
		if (propertyGroup is null) {
			propertyGroup = new XElement(ns + "PropertyGroup");
			root.AddFirst(propertyGroup);
		}
		var projectGuid = module.ProjectGuid.ToString("B").ToUpperInvariant();
		var existingGuid = propertyGroup.Element(ns + "ProjectGuid");
		if (existingGuid is null)
			propertyGroup.AddFirst(new XElement(ns + "ProjectGuid", projectGuid));
		else
			existingGuid.Value = projectGuid;
		if (!options.SdkProject) {
			var toolsVersion = ToolsVersion(options.ProjectVersion);
			if (toolsVersion is null)
				root.Attribute("ToolsVersion")?.Remove();
			else
				root.SetAttributeValue("ToolsVersion", toolsVersion);
		}

		var projectReferences = new List<XElement>();
		foreach (var itemGroup in root.Elements(ns + "ItemGroup").ToArray()) {
			foreach (var reference in itemGroup.Elements(ns + "Reference").ToArray()) {
				var include = (string?)reference.Attribute("Include");
				var simpleName = include?.Split(',')[0].Trim() ?? string.Empty;
				if (siblings.TryGetValue(simpleName, out var sibling)) {
					reference.Remove();
					projectReferences.Add(new XElement(ns + "ProjectReference",
						new XAttribute("Include", Path.Combine("..", sibling.ProjectDirectoryName, sibling.ProjectDirectoryName + options.Language.ProjectFileExtension))));
					continue;
				}
				if (!options.AddCorlibReference && IsCorlib(simpleName))
					reference.Remove();
			}
			if (!itemGroup.Elements().Any())
				itemGroup.Remove();
		}
		if (projectReferences.Count > 0) {
			var itemGroup = new XElement(ns + "ItemGroup");
			foreach (var projectReference in projectReferences)
				itemGroup.Add(projectReference);
			root.Add(itemGroup);
		}
		return document;
	}

	static bool IsCorlib(string name) =>
		name.Equals("mscorlib", StringComparison.OrdinalIgnoreCase) ||
		name.Equals("System.Runtime", StringComparison.OrdinalIgnoreCase) ||
		name.Equals("System.Private.CoreLib", StringComparison.OrdinalIgnoreCase) ||
		name.Equals("netstandard", StringComparison.OrdinalIgnoreCase);

	static string? ToolsVersion(ProjectVersion version) => version switch {
		ProjectVersion.VS2005 => null,
		ProjectVersion.VS2008 => "3.5",
		ProjectVersion.VS2010 or ProjectVersion.VS2012 => "4.0",
		ProjectVersion.VS2013 => "12.0",
		ProjectVersion.VS2015 => "14.0",
		_ => "15.0",
	};

	/// <summary>
	/// The VB export dnSpy has and ICSharpCode.Decompiler does not: each C# file is run through the
	/// same converter the GUI's VB documents use, and the project is rewritten as a VB one. The result
	/// is as good as that converter is — the code is faithful, but designer code and XAML code-behind
	/// are best-effort.
	/// </summary>
	void ConvertToVisualBasic(LoadedModule module, string projectDirectory, XDocument document) {
		foreach (var csFile in Directory.EnumerateFiles(projectDirectory, "*.cs", SearchOption.AllDirectories).ToArray()) {
			var vbFile = Path.ChangeExtension(csFile, ".vb");
			try {
				var text = VisualBasicConversion.PrepareCSharp(File.ReadAllText(csFile));
				var conversion = CodeConverter.ConvertAsync(new CodeWithOptions(text).WithTypeReferences(), CancellationToken.None).GetAwaiter().GetResult();
				if (conversion.Success)
					File.WriteAllText(vbFile, VisualBasicConversion.PrepareVB(VisualBasicConversion.PrepareConvertedVB(conversion.ConvertedCode)), new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
				else {
					File.WriteAllText(vbFile, "' " + string.Join("\n' ", conversion.GetExceptionsAsString().Split('\n')), new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
					error(string.Format(CultureInfo.CurrentCulture, "Failed to convert '{0}' to Visual Basic: {1}", csFile, conversion.GetExceptionsAsString()));
				}
			}
			catch (Exception ex) {
				error(string.Format(CultureInfo.CurrentCulture, "Failed to convert '{0}' to Visual Basic: {1}", csFile, ex.Message));
				File.WriteAllText(vbFile, "' Visual Basic conversion failed: " + ex.Message, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
			}
			File.Delete(csFile);
		}

		var root = document.Root!;
		var ns = root.Name.Namespace;
		var propertyGroup = root.Elements(ns + "PropertyGroup").FirstOrDefault();
		if (propertyGroup is null) {
			propertyGroup = new XElement(ns + "PropertyGroup");
			root.AddFirst(propertyGroup);
		}
		// The converted files keep their original namespace declarations, so the project must not
		// prefix them again. VB projects default RootNamespace to the project name; an empty one
		// turns that off and leaves the names exactly as the metadata has them.
		foreach (var rootNamespace in root.Descendants(ns + "RootNamespace").ToArray())
			rootNamespace.Remove();
		propertyGroup.Add(new XElement(ns + "RootNamespace", string.Empty));
		// LangVersion, unsafe and overflow checks are the C# ones the exporter wrote; VB rejects them.
		foreach (var element in root.Descendants(ns + "LangVersion").Concat(root.Descendants(ns + "AllowUnsafeBlocks")).Concat(root.Descendants(ns + "CheckForOverflowUnderflow")).ToArray())
			element.Remove();

		var hasXaml = Directory.EnumerateFiles(projectDirectory, "*.xaml", SearchOption.AllDirectories).Any();
		var hasWinForms = module.Module.GetAssemblyRefs().Any(reference => reference.Name == "System.Windows.Forms");
		if (options.SdkProject) {
			if (hasXaml && propertyGroup.Element(ns + "UseWPF") is null)
				propertyGroup.Add(new XElement(ns + "UseWPF", "true"));
			if (hasWinForms && propertyGroup.Element(ns + "UseWindowsForms") is null)
				propertyGroup.Add(new XElement(ns + "UseWindowsForms", "true"));
		}
		else {
			foreach (var compile in root.Descendants(ns + "Compile")) {
				var include = (string?)compile.Attribute("Include");
				if (include is not null && include.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
					compile.SetAttributeValue("Include", Path.ChangeExtension(include, ".vb"));
			}
			foreach (var import in root.Descendants(ns + "Import")) {
				var project = (string?)import.Attribute("Project");
				if (project is not null && project.EndsWith("Microsoft.CSharp.targets", StringComparison.OrdinalIgnoreCase))
					import.SetAttributeValue("Project", project[..^"Microsoft.CSharp.targets".Length] + "Microsoft.VisualBasic.targets");
			}
			var guids = propertyGroup.Element(ns + "ProjectTypeGuids");
			var vbGuid = "{F184B08F-C81C-45F6-A57F-5ABD9991F28F}";
			if (guids is null)
				propertyGroup.Add(new XElement(ns + "ProjectTypeGuids", vbGuid));
			else if (!guids.Value.Contains(vbGuid, StringComparison.OrdinalIgnoreCase))
				guids.Value = vbGuid + ";" + guids.Value;
		}
	}

	/// <summary>
	/// The decompiler the export runs: ICSharpCode.Decompiler's, with the resource and BAML choices
	/// dnSpy's exporter exposes. BAML entries become XAML pages, which is what dnSpy's project export
	/// does and what makes the exported WPF project build without the original .baml files.
	/// </summary>
	sealed class CliWholeProjectDecompiler(
		DecompilerSettings settings,
		IAssemblyResolver resolver,
		IProjectFileWriter projectWriter,
		IAssemblyReferenceClassifier classifier,
		IDebugInfoProvider? debugInfoProvider,
		CommandLineOptions options)
		: WholeProjectDecompiler(settings, resolver, projectWriter, classifier, debugInfoProvider) {
		MetadataFile? module;
		string? entryPointType;
		readonly HashSet<string> generatedNames = new(StringComparer.OrdinalIgnoreCase);

		/// <summary>The types whose XAML this export wrote. Their code-behind is decompiled as a partial
		/// class without the members the XAML build generates, the way dnSpy's XamlTypeProjectFile does.</summary>
		readonly HashSet<string> xamlTypes = new(StringComparer.Ordinal);

		/// <summary>What failed inside the overrides; the base class keeps its own list private.</summary>
		public List<string> ExtraErrors { get; } = [];

		protected override CSharpDecompiler CreateDecompiler(DecompilerTypeSystem ts) {
			var decompiler = base.CreateDecompiler(ts);
			if (xamlTypes.Count > 0)
				decompiler.AstTransforms.Add(new RemoveXamlGeneratedMembers(xamlTypes));
			return decompiler;
		}

		protected override IEnumerable<ProjectItemInfo> WriteResourceFilesInProject(MetadataFile metadataFile) {
			module = metadataFile;
			entryPointType = GetEntryPointType(metadataFile);
			if (!options.UnpackResources) {
				foreach (var item in WriteRawResources(metadataFile))
					yield return item;
				yield break;
			}
			foreach (var item in base.WriteResourceFilesInProject(metadataFile))
				yield return item;
		}

		IEnumerable<ProjectItemInfo> WriteRawResources(MetadataFile metadataFile) {
			foreach (var resource in metadataFile.Resources.Where(resource => resource.ResourceType == ResourceType.Embedded)) {
				var name = Reserve(SanitizeFileName(resource.Name));
				using var stream = resource.TryOpenStream();
				if (stream is null)
					continue;
				ProjectItemInfo? item = null;
				try {
					using (var destination = File.Create(Path.Combine(TargetDirectory, name)))
						stream.CopyTo(destination);
					item = new ProjectItemInfo("EmbeddedResource", name).With("LogicalName", resource.Name);
				}
				catch (Exception ex) when (ex is not OperationCanceledException) {
					ExtraErrors.Add(ex.ToString());
				}
				if (item is { } created)
					yield return created;
			}
		}

		protected override IEnumerable<ProjectItemInfo> WriteResourceToFile(string fileName, string resourceName, Stream entryStream) {
			if (options.DecompileBaml && fileName.EndsWith(".baml", StringComparison.OrdinalIgnoreCase)) {
				if (TryDecompileBaml(fileName, entryStream, out var xamlItems))
					return xamlItems;
				return base.WriteResourceToFile(fileName, resourceName, entryStream);
			}
			if (!options.CreateResX && fileName.EndsWith(".resources", StringComparison.OrdinalIgnoreCase)) {
				entryStream.Position = 0;
				var name = Reserve(fileName);
				using (var destination = File.Create(Path.Combine(TargetDirectory, name)))
					entryStream.CopyTo(destination);
				return [new ProjectItemInfo("EmbeddedResource", name).With("LogicalName", resourceName)];
			}
			return base.WriteResourceToFile(fileName, resourceName, entryStream);
		}

		bool TryDecompileBaml(string fileName, Stream entryStream, out IEnumerable<ProjectItemInfo> items) {
			items = [];
			if (module is null)
				return false;
			try {
				entryStream.Position = 0;
				var decompiler = new XamlDecompiler(module.FileName, AssemblyResolver, new BamlDecompilerSettings { ThrowOnAssemblyResolveErrors = false });
				var result = decompiler.Decompile(entryStream);
				var xamlName = BamlFileName(fileName, result.TypeName);
				var xamlDirectory = Path.GetDirectoryName(xamlName);
				if (!string.IsNullOrEmpty(xamlDirectory))
					CreateDirectory(Path.Combine(TargetDirectory, xamlDirectory));
				var path = Path.Combine(TargetDirectory, xamlName);
				using (var writer = new StreamWriter(path, append: false, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false)))
					result.Xaml.Save(writer);
				var isApplicationDefinition = result.TypeName is { } typeName && entryPointType is not null && string.Equals(typeName.FullName, entryPointType, StringComparison.Ordinal);
				if (result.TypeName is { } codeBehind)
					xamlTypes.Add(codeBehind.FullName);
				items = [new ProjectItemInfo(isApplicationDefinition ? "ApplicationDefinition" : "Page", xamlName)];
				return true;
			}
			catch (Exception ex) when (ex is not OperationCanceledException) {
				ExtraErrors.Add(ex.ToString());
				return false;
			}
		}

		string BamlFileName(string bamlFileName, FullTypeName? typeName) {
			if (typeName is not { } name)
				return Reserve(Path.ChangeExtension(SanitizeFileName(bamlFileName), ".xaml"));
			var xaml = WholeProjectDecompiler.GetFileNameForType(name.TopLevelTypeName.Namespace, name.Name, ".xaml", Settings.UseNestedDirectoriesForNamespaces);
			return Reserve(xaml);
		}

		string Reserve(string name) {
			if (generatedNames.Add(name))
				return name;
			var directory = Path.GetDirectoryName(name) ?? string.Empty;
			var baseName = Path.GetFileNameWithoutExtension(name);
			var extension = Path.GetExtension(name);
			for (var i = 2; ; i++) {
				var candidate = Path.Combine(directory, baseName + "_" + i.ToString(CultureInfo.InvariantCulture) + extension);
				if (generatedNames.Add(candidate))
					return candidate;
			}
		}

		static string? GetEntryPointType(MetadataFile metadataFile) {
			try {
				if (metadataFile is not PEFile peFile)
					return null;
				var token = peFile.Reader.PEHeaders.CorHeader?.EntryPointTokenOrRelativeVirtualAddress ?? 0;
				// A file entry point is a token; a native one is an RVA and cannot name a managed type.
				if (token >> 24 != 0x06)
					return null;
				var method = metadataFile.Metadata.GetMethodDefinition(MetadataTokens.MethodDefinitionHandle(token & 0xFFFFFF));
				var type = metadataFile.Metadata.GetTypeDefinition(method.GetDeclaringType());
				var ns = metadataFile.Metadata.GetString(type.Namespace);
				var name = metadataFile.Metadata.GetString(type.Name);
				return ns.Length == 0 ? name : ns + "." + name;
			}
			catch (Exception) {
				return null;
			}
		}
	}
}

/// <summary>Writes the .sln the project export puts beside its projects, or the .slnx form.</summary>
sealed class SolutionWriter(CommandLineOptions options, IReadOnlyList<LoadedModule> modules, Action<string> error) {
	public void Write(string filename) {
		try {
			var directory = Path.GetDirectoryName(filename);
			if (!string.IsNullOrEmpty(directory))
				Directory.CreateDirectory(directory);
			if (Path.GetExtension(filename).Equals(".slnx", StringComparison.OrdinalIgnoreCase))
				WriteXml(filename);
			else
				WriteVisualStudioSolution(filename);
		}
		catch (Exception ex) when (ex is not OperationCanceledException) {
			error(string.Format(CultureInfo.CurrentCulture, "Failed to create solution file '{0}': {1}", filename, ex.Message));
		}
	}

	void WriteVisualStudioSolution(string filename) {
		const string crlf = "\r\n";
		var projects = SortedProjects();
		var platforms = Platforms();
		using var writer = new StreamWriter(filename, append: false, Encoding.UTF8);
		writer.Write(crlf);
		switch (options.ProjectVersion) {
		case ProjectVersion.VS2005:
			writer.Write("Microsoft Visual Studio Solution File, Format Version 9.00" + crlf);
			writer.Write("# Visual Studio 2005" + crlf);
			break;
		case ProjectVersion.VS2008:
			writer.Write("Microsoft Visual Studio Solution File, Format Version 10.00" + crlf);
			writer.Write("# Visual Studio 2008" + crlf);
			break;
		case ProjectVersion.VS2010:
			writer.Write("Microsoft Visual Studio Solution File, Format Version 11.00" + crlf);
			writer.Write("# Visual Studio 2010" + crlf);
			break;
		case ProjectVersion.VS2012:
			writer.Write("Microsoft Visual Studio Solution File, Format Version 12.00" + crlf);
			writer.Write("# Visual Studio 2012" + crlf);
			break;
		case ProjectVersion.VS2013:
			writer.Write("Microsoft Visual Studio Solution File, Format Version 12.00" + crlf);
			writer.Write("# Visual Studio 2013" + crlf);
			writer.Write("VisualStudioVersion = 12.0.21005.1" + crlf);
			writer.Write("MinimumVisualStudioVersion = 10.0.40219.1" + crlf);
			break;
		case ProjectVersion.VS2015:
			writer.Write("Microsoft Visual Studio Solution File, Format Version 12.00" + crlf);
			writer.Write("# Visual Studio 14" + crlf);
			writer.Write("VisualStudioVersion = 14.0.23107.0" + crlf);
			writer.Write("MinimumVisualStudioVersion = 10.0.40219.1" + crlf);
			break;
		case ProjectVersion.VS2017:
			writer.Write("Microsoft Visual Studio Solution File, Format Version 12.00" + crlf);
			writer.Write("# Visual Studio 15" + crlf);
			writer.Write("VisualStudioVersion = 15.0.26228.4" + crlf);
			writer.Write("MinimumVisualStudioVersion = 10.0.40219.1" + crlf);
			break;
		case ProjectVersion.VS2019:
			writer.Write("Microsoft Visual Studio Solution File, Format Version 12.00" + crlf);
			writer.Write("# Visual Studio Version 16" + crlf);
			writer.Write("VisualStudioVersion = 16.0.28729.10" + crlf);
			writer.Write("MinimumVisualStudioVersion = 10.0.40219.1" + crlf);
			break;
		case ProjectVersion.VS2022:
			writer.Write("Microsoft Visual Studio Solution File, Format Version 12.00" + crlf);
			writer.Write("# Visual Studio Version 17" + crlf);
			writer.Write("VisualStudioVersion = 17.0.31903.59" + crlf);
			writer.Write("MinimumVisualStudioVersion = 10.0.40219.1" + crlf);
			break;
		}
		foreach (var project in projects) {
			writer.Write("Project(\"{0}\") = \"{1}\", \"{1}\\{2}\", \"{3}\"" + crlf,
				project.LanguageGuid.ToString("B").ToUpperInvariant(),
				project.DirectoryName,
				project.FileName,
				project.Guid.ToString("B").ToUpperInvariant());
			writer.Write("EndProject" + crlf);
		}
		writer.Write("Global" + crlf);
		writer.Write("\tGlobalSection(SolutionConfigurationPlatforms) = preSolution" + crlf);
		foreach (var configuration in new[] { "Debug", "Release" }) {
			foreach (var platform in platforms)
				writer.Write("\t\t{0}|{1} = {0}|{1}" + crlf, configuration, platform);
		}
		writer.Write("\tEndGlobalSection" + crlf);
		writer.Write("\tGlobalSection(ProjectConfigurationPlatforms) = postSolution" + crlf);
		foreach (var project in projects) {
			var guid = project.Guid.ToString("B").ToUpperInvariant();
			var projectPlatform = project.Platform == "AnyCPU" ? "Any CPU" : project.Platform;
			foreach (var configuration in new[] { "Debug", "Release" }) {
				foreach (var platform in platforms) {
					writer.Write("\t\t{0}.{1}|{2}.ActiveCfg = {1}|{3}" + crlf, guid, configuration, platform, projectPlatform);
					writer.Write("\t\t{0}.{1}|{2}.Build.0 = {1}|{3}" + crlf, guid, configuration, platform, projectPlatform);
				}
			}
		}
		writer.Write("\tEndGlobalSection" + crlf);
		writer.Write("\tGlobalSection(SolutionProperties) = preSolution" + crlf);
		writer.Write("\t\tHideSolutionNode = FALSE" + crlf);
		writer.Write("\tEndGlobalSection" + crlf);
		writer.Write("EndGlobal" + crlf);
	}

	void WriteXml(string filename) {
		var document = new XDocument(new XElement("Solution"));
		var platforms = Platforms();
		if (platforms.Length != 1 || platforms[0] != "Any CPU") {
			var configurations = new XElement("Configurations");
			foreach (var platform in platforms.Where(platform => platform != "Mixed Platforms"))
				configurations.Add(new XElement("Platform", new XAttribute("Name", platform)));
			document.Root!.Add(configurations);
		}
		foreach (var project in SortedProjects())
			document.Root!.Add(new XElement("Project", new XAttribute("Path", project.DirectoryName + "/" + project.FileName)));
		using var writer = new StreamWriter(filename, append: false, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
		document.Save(writer);
	}

	string[] Platforms() {
		var platforms = new List<string> { "Any CPU" };
		var others = modules.Select(module => module.PlatformName).Where(platform => platform != "AnyCPU").Distinct().ToArray();
		if (others.Length > 0)
			platforms.Add("Mixed Platforms");
		platforms.AddRange(others);
		return [.. platforms];
	}

	SolutionProject[] SortedProjects() {
		var languageGuid = options.Language.Kind == ConsoleLanguageKind.VisualBasic
			? new Guid("F184B08F-C81C-45F6-A57F-5ABD9991F28F")
			: new Guid("FAE04EC0-301F-11D3-BF4B-00C04F79EFBC");
		var projectExtension = options.Language.ProjectFileExtension ?? ".csproj";
		return [.. modules
			.OrderBy(module => module.IsDll ? 1 : 0)
			.ThenBy(module => module.ProjectDirectoryName, StringComparer.OrdinalIgnoreCase)
			.Select(module => new SolutionProject(
				module.ProjectDirectoryName,
				module.ProjectDirectoryName + projectExtension,
				module.ProjectGuid,
				languageGuid,
				module.PlatformName))];
	}

	readonly record struct SolutionProject(string DirectoryName, string FileName, Guid Guid, Guid LanguageGuid, string Platform);
}

/// <summary>
/// The code-behind of a XAML file is decompiled the way dnSpy's XamlTypeProjectFile does it: the type
/// is partial, and the members the XAML build generates — InitializeComponent, the connector that
/// assigns the named fields, the delegate helper and the fields they set — are left out, because the
/// build writes them again from the .xaml. Keeping them makes the exported project fail to compile
/// with duplicate members, which is why the XAML code-behind needs this and no other type does.
/// </summary>
sealed class RemoveXamlGeneratedMembers(HashSet<string> xamlTypes) : IAstTransform {
	public void Run(AstNode root, TransformContext context) {
		foreach (var typeDeclaration in root.Descendants.OfType<TypeDeclaration>().ToArray()) {
			if (!xamlTypes.Contains(GetFullName(typeDeclaration)))
				continue;
			typeDeclaration.Modifiers |= Modifiers.Partial;
			foreach (var baseType in typeDeclaration.BaseTypes.OfType<SimpleType>().ToArray()) {
				if (baseType.Identifier is "IComponentConnector" or "IStyleConnector")
					baseType.Remove();
			}

			var generatedFields = new HashSet<string>(StringComparer.Ordinal);
			foreach (var method in typeDeclaration.Members.OfType<MethodDeclaration>().ToArray()) {
				if (!IsGenerated(method))
					continue;
				foreach (var reference in method.Descendants.OfType<IdentifierExpression>())
					generatedFields.Add(reference.Identifier);
				method.Remove();
			}
			foreach (var field in typeDeclaration.Members.OfType<FieldDeclaration>().ToArray()) {
				if (field.Variables.All(variable => generatedFields.Contains(variable.Name)))
					field.Remove();
			}
		}
	}

	static bool IsGenerated(MethodDeclaration method) =>
		method.Name == "InitializeComponent" ||
		method.Name == "_CreateDelegate" ||
		(method.Name == "Connect" && method.PrivateImplementationType is not null);

	static string GetFullName(TypeDeclaration declaration) {
		var parts = new List<string> { declaration.Name };
		for (var parent = declaration.Parent; parent is not null; parent = parent.Parent) {
			if (parent is TypeDeclaration nested)
				parts.Insert(0, nested.Name);
			else if (parent is NamespaceDeclaration @namespace && !string.IsNullOrEmpty(@namespace.Name))
				parts.Insert(0, @namespace.Name);
		}
		return string.Join('.', parts);
	}
}
