/*
    Copyright (C) 2014-2019 de4dot@gmail.com

    This file is part of dnSpy

    dnSpy is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    dnSpy is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with dnSpy.  If not, see <http://www.gnu.org/licenses/>.
*/

// Ported from dnSpy (dnSpy/dnSpy.Decompiler/MSBuild/Project.cs).

using System.Text;
using dnlib.DotNet;
using dnlib.DotNet.Emit;
using dnlib.DotNet.Resources;
using dnlib.PE;
using ICSharpCode.BamlDecompiler;

namespace dnSpy.Backend.Core.ProjectExport;

/// <summary>
/// One module's project: the files it gets — AssemblyInfo, a file per type (a form with its Designer file, a XAML
/// code-behind with its .xaml, a settings class with its .settings and Designer file, a .resx class with its .resx),
/// the resources, the satellite assemblies' .resx files, app.config, the icon and the manifest — and what the
/// project file says of them.
/// </summary>
sealed class Project {
	public ProjectExportModule ExportModule { get; }
	public ProjectExportOptions Options { get; }
	public ProjectDecompiler Decompiler { get; }
	public string DefaultNamespace { get; }
	public string AssemblyName { get; }
	public ModuleDef Module => ExportModule.Module;
	public List<ProjectFile> Files { get; } = [];
	public Guid Guid => ExportModule.ProjectGuid;
	public Guid LanguageGuid { get; }
	public string Filename { get; }
	public string Directory { get; }
	public string? Platform { get; set; }
	public HashSet<Guid> ProjectTypeGuids { get; } = [];
	public HashSet<string> ExtraAssemblyReferences { get; } = [];
	public string? StartupObject { get; private set; }
	public bool AllowUnsafeBlocks { get; private set; }
	public string PropertiesFolder { get; }
	public ApplicationIcon? ApplicationIcon { get; private set; }
	public ApplicationManifest? ApplicationManifest { get; private set; }

	public static readonly Guid CSharpLanguageGuid = new("FAE04EC0-301F-11D3-BF4B-00C04F79EFBC");
	public static readonly Guid VisualBasicLanguageGuid = new("F184B08F-C81C-45F6-A57F-5ABD9991F28F");

	readonly SatelliteAssemblyFinder satelliteAssemblyFinder;

	public Project(ProjectExportOptions options, ProjectExportModule module, string projDir, SatelliteAssemblyFinder satelliteAssemblyFinder) {
		Options = options;
		ExportModule = module;
		Directory = projDir;
		this.satelliteAssemblyFinder = satelliteAssemblyFinder;
		Decompiler = new ProjectDecompiler(options, module);
		DefaultNamespace = new DefaultNamespaceFinder(module.Module).Find();
		Decompiler.RootNamespace = string.IsNullOrEmpty(DefaultNamespace) ? (module.Module.Assembly?.Name.String ?? string.Empty) : DefaultNamespace;
		Filename = Path.Combine(projDir, Path.GetFileName(projDir) + Decompiler.ProjectFileExtension);
		AssemblyName = module.Module.Assembly is null ? string.Empty : module.Module.Assembly.Name.String;
		PropertiesFolder = Decompiler.IsVisualBasic ? "My Project" : "Properties";
		LanguageGuid = Decompiler.IsVisualBasic ? VisualBasicLanguageGuid : CSharpLanguageGuid;
	}

	public void CreateProjectFiles(DecompileContext ctx) {
		var filenameCreator = new FilenameCreator(Directory, DefaultNamespace);
		var resourceNameCreator = new ResourceNameCreator(Module, filenameCreator);

		AllowUnsafeBlocks = DotNetUtils.IsUnsafe(Module);
		InitializeSplashScreen();
		var assemblyInfoFilename = filenameCreator.CreateFromRelativePath(Path.Combine(PropertiesFolder, "AssemblyInfo"), Decompiler.FileExtension);
		Files.Add(new AssemblyInfoProjectFile(assemblyInfoFilename, Decompiler));

		var ep = Module.EntryPoint;
		if (ep is not null && ep.DeclaringType is not null)
			StartupObject = ep.DeclaringType.ReflectionFullName;

		var win32Resources = (Module as ModuleDefMD)?.Win32Resources;
		ApplicationManifest = ApplicationManifest.TryCreate(win32Resources, filenameCreator);
		if (ApplicationManifest is not null)
			Files.Add(new ApplicationManifestProjectFile(ApplicationManifest.Filename));

		foreach (var rsrc in Module.Resources) {
			ctx.CancellationToken.ThrowIfCancellationRequested();
			switch (rsrc.ResourceType) {
			case ResourceType.Embedded:
				foreach (var file in CreateEmbeddedResourceFiles(resourceNameCreator, (EmbeddedResource)rsrc)) {
					Files.Add(file);
					Files.AddRange(CreateSatelliteFiles(rsrc.Name, filenameCreator, file));
				}
				break;

			case ResourceType.AssemblyLinked:
				//TODO: What should be created here?
				break;

			case ResourceType.Linked:
				//TODO: What should be created here?
				break;
			}
		}
		InitializeXaml();
		InitializeResX();
		foreach (var type in Module.Types) {
			ctx.CancellationToken.ThrowIfCancellationRequested();
			if (!DecompileType(type))
				continue;
			Files.Add(CreateTypeProjectFile(type, filenameCreator));
		}
		CreateEmptyAppXamlFile();

		var existingAppConfig = Module.Location + ".config";
		if (File.Exists(existingAppConfig))
			Files.Add(new AppConfigProjectFile(filenameCreator.CreateName("app.config"), existingAppConfig));

		ApplicationIcon = ApplicationIcon.TryCreate(win32Resources, Path.GetFileName(Directory), filenameCreator);

		var dirs = new HashSet<string>(Files.Select(a => GetDirectoryName(a.Filename)).OfType<string>(), StringComparer.OrdinalIgnoreCase);
		var errors = 0;
		foreach (var dir in dirs) {
			ctx.CancellationToken.ThrowIfCancellationRequested();
			try {
				System.IO.Directory.CreateDirectory(dir);
			}
			catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) {
				if (errors++ < 20)
					ctx.Logger($"Couldn't create directory {dir}, Error: {ex.Message}");
			}
		}
	}

	static string? GetDirectoryName(string s) {
		try {
			return Path.GetDirectoryName(s);
		}
		catch (Exception ex) when (ex is ArgumentException or PathTooLongException) {
			return null;
		}
	}

	void InitializeSplashScreen() {
		var ep = Module.EntryPoint;
		if (ep?.Body is null)
			return;
		var instrs = ep.Body.Instructions;
		for (var i = 0; i + 1 < instrs.Count; i++) {
			var newobj = instrs[i + 1];
			if (newobj.OpCode.Code != Code.Newobj)
				continue;
			if (instrs[i].Operand is not string s)
				continue;
			if (newobj.Operand is not IMethod ctor || ctor.MethodSig is null)
				continue;
			if (ctor.FullName != "System.Void System.Windows.SplashScreen::.ctor(System.String)" &&
				ctor.FullName != "System.Void System.Windows.SplashScreen::.ctor(System.Reflection.Assembly,System.String)")
				continue;
			splashScreenImageName = s;
			break;
		}
	}
	string? splashScreenImageName;

	ProjectFile CreateTypeProjectFile(TypeDef type, FilenameCreator filenameCreator) {
		var bamlFile = TryGetBamlFile(type);
		if (bamlFile is not null) {
			var filename = filenameCreator.Create(GetTypeExtension(type), type.FullName);
			TypeProjectFile newFile = new XamlTypeProjectFile(type, filename, Decompiler);
			newFile.DependentUpon = bamlFile;
			var isAppType = DotNetUtils.IsSystemWindowsApplication(type);
			if (isAppType && DotNetUtils.IsStartUpClass(type)) {
				bamlFile.IsAppDef = true;
				StartupObject = null;
			}
			if (isAppType)
				appTypeProjFile = newFile;
			return newFile;
		}

		const string DESIGNER = ".Designer";
		var resxFile = TryGetResXFile(type);
		if (DotNetUtils.IsWinForm(type)) {
			var fname = resxFile is not null ? Path.GetFileNameWithoutExtension(resxFile.Filename) : type.Name.String;
			var filename = filenameCreator.CreateFromNamespaceName(GetTypeExtension(type), type.ReflectionNamespace, fname);
			var dname = filenameCreator.CreateFromNamespaceName(GetTypeExtension(type), type.ReflectionNamespace, fname + DESIGNER);

			var newFile = new WinFormsProjectFile(type, filename, Decompiler);
			if (resxFile is not null)
				resxFile.DependentUpon = newFile;
			var winFormsDesignerFile = new WinFormsDesignerProjectFile(newFile, dname) {
				DependentUpon = newFile,
			};
			Files.Add(winFormsDesignerFile);
			return newFile;
		}
		else if (resxFile is not null) {
			var filename = filenameCreator.CreateFromNamespaceName(GetTypeExtension(type), type.ReflectionNamespace, Path.GetFileNameWithoutExtension(resxFile.Filename) + DESIGNER);
			var newFile = new TypeProjectFile(type, filename, Decompiler) {
				DependentUpon = resxFile,
				AutoGen = true,
				DesignTime = true,
			};
			resxFile.Generator = type.IsPublic ? "PublicResXFileCodeGenerator" : "ResXFileCodeGenerator";
			resxFile.LastGenOutput = newFile;
			return newFile;
		}

		var bt = type.BaseType;
		if (bt is not null && bt.FullName == "System.Configuration.ApplicationSettingsBase") {
			var designerFilename = filenameCreator.Create(DESIGNER + GetTypeExtension(type), type.FullName);
			var settingsFilename = filenameCreator.Create(".settings", type.FullName);
			var typeFilename = filenameCreator.Create(GetTypeExtension(type), type.FullName);
			var settingsTypeFile = new SettingsTypeProjectFile(type, typeFilename, Decompiler);
			var designerTypeFile = new SettingsDesignerTypeProjectFile(settingsTypeFile, designerFilename);
			Files.Add(settingsTypeFile);
			var settingsFile = new SettingsProjectFile(type, settingsFilename);
			designerTypeFile.DependentUpon = settingsFile;
			designerTypeFile.AutoGen = true;
			designerTypeFile.DesignTimeSharedInput = true;
			settingsFile.Generator = type.IsPublic ? "PublicSettingsSingleFileGenerator" : "SettingsSingleFileGenerator";
			settingsFile.LastGenOutput = designerTypeFile;
			Files.Add(settingsFile);
			return designerTypeFile;
		}

		var newFilename = filenameCreator.Create(GetTypeExtension(type), type.FullName);
		return new TypeProjectFile(type, newFilename, Decompiler);
	}

	void CreateEmptyAppXamlFile() {
		if (!hasXamlClasses || appTypeProjFile is not null)
			return;
		if ((Module.Characteristics & Characteristics.Dll) != 0)
			return;

		var file = Files.OfType<TypeProjectFile>().FirstOrDefault(a => DotNetUtils.IsSystemWindowsApplication(a.Type));
		if (file is null || file.DependentUpon is not null)
			return;

		Files.Remove(file);

		var filename = file.Filename;
		var name = Path.GetFileNameWithoutExtension(file.Filename);
		filename = Path.Combine(Path.GetDirectoryName(filename)!, name + ".xaml");

		var newFile = new XamlTypeProjectFile(file.Type, filename + Decompiler.FileExtension, Decompiler);
		Files.Add(newFile);
		var bamlFile = new AppBamlResourceProjectFile(filename, file.Type, Decompiler);
		newFile.DependentUpon = bamlFile;
		Files.Add(bamlFile);
	}
	TypeProjectFile? appTypeProjFile;

	void InitializeXaml() {
		typeFullNameToBamlFile = new Dictionary<string, BamlResourceProjectFile>(StringComparer.OrdinalIgnoreCase);
		foreach (var xamlFile in Files.OfType<BamlResourceProjectFile>()) {
			hasXamlClasses = true;
			if (!string.IsNullOrEmpty(xamlFile.TypeFullName) && !xamlFile.IsSatelliteFile)
				typeFullNameToBamlFile[xamlFile.TypeFullName] = xamlFile;
		}
		if (hasXamlClasses) {
			ExtraAssemblyReferences.Add("WindowsBase");
			ExtraAssemblyReferences.Add("PresentationCore");
			ExtraAssemblyReferences.Add("PresentationFramework");
			if (!Module.IsClr1x && !Module.IsClr20)
				ExtraAssemblyReferences.Add("System.Xaml");
		}

		if (hasXamlClasses || ReferencesWPFClasses()) {
			ProjectTypeGuids.Add(new Guid("60DC8134-EBA5-43B8-BCC9-BB4BC16C2548"));
			ProjectTypeGuids.Add(LanguageGuid);
		}
	}
	Dictionary<string, BamlResourceProjectFile>? typeFullNameToBamlFile;
	bool hasXamlClasses;

	bool ReferencesWPFClasses() {
		foreach (var asmRef in Module.GetAssemblyRefs()) {
			switch (asmRef.Name) {
			case "WindowsBase":
			case "PresentationCore":
			case "PresentationFramework":
				return true;
			}
		}
		return false;
	}

	BamlResourceProjectFile? TryGetBamlFile(TypeDef type) {
		typeFullNameToBamlFile!.TryGetValue(type.FullName, out var bamlFile);
		return bamlFile;
	}

	void InitializeResX() {
		typeFullNameToResXFile = new Dictionary<string, ResXProjectFile>(StringComparer.Ordinal);
		foreach (var resxFile in Files.OfType<ResXProjectFile>()) {
			if (!string.IsNullOrEmpty(resxFile.TypeFullName) && !resxFile.IsSatelliteFile)
				typeFullNameToResXFile[resxFile.TypeFullName] = resxFile;
		}
	}
	Dictionary<string, ResXProjectFile>? typeFullNameToResXFile;

	ResXProjectFile? TryGetResXFile(TypeDef type) {
		typeFullNameToResXFile!.TryGetValue(type.FullName, out var resxFile);
		return resxFile;
	}

	string GetTypeExtension(TypeDef type) {
		if (typeFullNameToBamlFile!.ContainsKey(type.FullName))
			return ".xaml" + Decompiler.FileExtension;
		return Decompiler.FileExtension;
	}

	IEnumerable<ProjectFile> CreateEmbeddedResourceFiles(ResourceNameCreator resourceNameCreator, EmbeddedResource er) {
		if (!Options.UnpackResources) {
			yield return CreateRawEmbeddedResourceProjectFile(resourceNameCreator, er);
			yield break;
		}

		if (ResourceReader.CouldBeResourcesFile(er.CreateReader())) {
			var files = TryCreateResourceFiles(resourceNameCreator, er);
			if (files is not null) {
				foreach (var file in files)
					yield return file;
				yield break;
			}
		}

		yield return CreateRawEmbeddedResourceProjectFile(resourceNameCreator, er);
	}

	List<ProjectFile>? TryCreateResourceFiles(ResourceNameCreator resourceNameCreator, EmbeddedResource er) {
		var set = TryCreateResourceElementSet(Module, er);
		if (set is null)
			return null;
		if (IsXamlResource(Module, er.Name, set))
			return [.. CreateXamlResourceFiles(resourceNameCreator, set)];
		if (Options.CreateResX) {
			var filename = resourceNameCreator.GetResxFilename(er.Name, out var typeFullName);
			return [CreateResXFile(Module, set, filename, typeFullName, false)];
		}

		return null;
	}

	static bool IsXamlResource(ModuleDef module, string name, ResourceElementSet set) {
		var asm = module.Assembly;
		if (asm is null || !module.IsManifestModule)
			return false;

		var culture = UTF8String.IsNullOrEmpty(asm.Culture) ? string.Empty : "." + asm.Culture;
		if (!StringComparer.OrdinalIgnoreCase.Equals(asm.Name + ".g" + culture + ".resources", name))
			return false;

		var elems = set.ResourceElements.ToArray();
		if (elems.Length == 0)
			return false;
		foreach (var e in elems) {
			if (!(e.ResourceData.Code == ResourceTypeCode.ByteArray || e.ResourceData.Code == ResourceTypeCode.Stream))
				return false;
		}
		return true;
	}

	IEnumerable<ProjectFile> CreateXamlResourceFiles(ResourceNameCreator resourceNameCreator, ResourceElementSet set) {
		var decompileBaml = Options.DecompileBaml;
		foreach (var e in set.ResourceElements) {
			var data = (byte[])((BuiltInResourceData)e.ResourceData).Data;
			var rsrcName = Uri.UnescapeDataString(e.Name);
			if (decompileBaml && rsrcName.EndsWith(".baml", StringComparison.OrdinalIgnoreCase)) {
				var bamlTypeName = DecompileBamlTypeName(data);
				var filename = resourceNameCreator.GetBamlResourceName(rsrcName, bamlTypeName, out var typeFullName);
				yield return new BamlResourceProjectFile(filename, data, typeFullName, DecompileBaml);
			}
			else if (StringComparer.InvariantCultureIgnoreCase.Equals(splashScreenImageName, e.Name)) {
				var filename = resourceNameCreator.GetXamlResourceFilename(rsrcName);
				yield return new SplashScreenProjectFile(filename, data, e.Name);
			}
			else {
				var filename = resourceNameCreator.GetXamlResourceFilename(rsrcName);
				yield return new ResourceProjectFile(filename, data, e.Name);
			}
		}
	}

	// ICSharpCode.BamlDecompiler stands in for dnSpy's: the x:Class a BAML file names, found when the project's files are
	// laid out, and the XAML it decompiles to, written when its job runs. The first decompilation is kept for the second.
	readonly Dictionary<byte[], BamlDecompilationResult?> bamlResults = new(ReferenceEqualityComparer.Instance);

	BamlDecompilationResult? DecompileBamlCore(byte[] data, CancellationToken cancellationToken) {
		lock (bamlResults) {
			if (bamlResults.TryGetValue(data, out var cached))
				return cached;
		}
		BamlDecompilationResult? result;
		try {
			var decompiler = new XamlDecompiler(ExportModule.File, ExportModule.Resolver, new BamlDecompilerSettings { ThrowOnAssemblyResolveErrors = false }) {
				CancellationToken = cancellationToken,
			};
			result = decompiler.Decompile(new MemoryStream(data, writable: false));
		}
		catch (Exception ex) when (ex is not OperationCanceledException) {
			result = null;
		}
		lock (bamlResults)
			bamlResults[data] = result;
		return result;
	}

	string? DecompileBamlTypeName(byte[] data) => DecompileBamlCore(data, CancellationToken.None)?.TypeName?.ReflectionName;

	IList<string> DecompileBaml(byte[] data, Stream stream, CancellationToken cancellationToken) {
		var result = DecompileBamlCore(data, cancellationToken) ?? throw new InvalidOperationException("The BAML could not be decompiled.");
		lock (bamlResults)
			bamlResults.Remove(data);
		// BamlDecompiler.Decompile: the XAML as XamlOutputCreator writes it, UTF-8 without a byte order mark.
		var bytes = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes(XamlOutputCreator.CreateText(result.Xaml, Options.XamlOutput));
		stream.Write(bytes, 0, bytes.Length);
		return result.AssemblyReferences;
	}

	static ResXProjectFile CreateResXFile(ModuleDef module, ResourceElementSet set, string filename, string typeFullName, bool isSatellite) =>
		new(module, filename, typeFullName, set) { IsSatelliteFile = isSatellite };

	static RawEmbeddedResourceProjectFile CreateRawEmbeddedResourceProjectFile(ResourceNameCreator resourceNameCreator, EmbeddedResource er) =>
		new(resourceNameCreator.GetResourceFilename(er.Name), er);

	bool DecompileType(TypeDef type) {
		if (!Decompiler.ShowMember(type))
			return false;

		if (type.IsGlobalModuleType && type.Methods.Count == 0 && type.Fields.Count == 0 &&
			type.Properties.Count == 0 && type.Events.Count == 0 && type.NestedTypes.Count == 0)
			return false;

		if (type.Namespace == "XamlGeneratedNamespace" && type.Name == "GeneratedInternalTypeHelper")
			return false;

		return true;
	}

	IEnumerable<ProjectFile> CreateSatelliteFiles(string rsrcName, FilenameCreator filenameCreator, ProjectFile nonSatFile) {
		foreach (var satMod in satelliteAssemblyFinder.GetSatelliteAssemblies(Module)) {
			var satFile = TryCreateSatelliteFile(satMod, rsrcName, filenameCreator, nonSatFile);
			if (satFile is not null)
				yield return satFile;
		}
	}

	ProjectFile? TryCreateSatelliteFile(ModuleDef module, string rsrcName, FilenameCreator filenameCreator, ProjectFile nonSatFile) {
		if (!Options.CreateResX)
			return null;
		var asm = module.Assembly;
		if (asm is null || UTF8String.IsNullOrEmpty(asm.Culture))
			return null;
		var name = FileUtils.RemoveExtension(rsrcName);
		var ext = FileUtils.GetExtension(rsrcName);
		var locName = name + "." + asm.Culture + ext;
		var er = module.Resources.OfType<EmbeddedResource>().FirstOrDefault(a => StringComparer.Ordinal.Equals(a.Name, locName));
		var set = TryCreateResourceElementSet(module, er);
		if (set is null)
			return null;

		var dirName = Path.GetDirectoryName(nonSatFile.Filename)!;
		var dir = Directory.Length + 1 > dirName.Length ? string.Empty : dirName[(Directory.Length + 1)..];
		name = Path.GetFileNameWithoutExtension(nonSatFile.Filename);
		ext = Path.GetExtension(nonSatFile.Filename);
		var filename = filenameCreator.CreateFromRelativePath(Path.Combine(dir, name) + "." + asm.Culture, ext);
		return CreateResXFile(module, set, filename, string.Empty, true);
	}

	static ResourceElementSet? TryCreateResourceElementSet(ModuleDef module, EmbeddedResource? er) {
		if (er is null)
			return null;
		if (!ResourceReader.CouldBeResourcesFile(er.CreateReader()))
			return null;
		try {
			return ResourceReader.Read(module, er.CreateReader());
		}
		catch (Exception ex) when (ex is not OperationCanceledException) {
			return null;
		}
	}

	public IEnumerable<IJob> GetJobs() {
		if (ApplicationIcon is not null)
			yield return ApplicationIcon;
		if (ApplicationManifest is not null)
			yield return ApplicationManifest;
		foreach (var f in Files)
			yield return f;
	}

	/// <summary>Before the project file is written: the assemblies the XAML files name besides the module's own.</summary>
	public void OnWrite() {
		var asmName = Module.Assembly is not null && Module.IsManifestModule ? Module.Assembly.Name.String : null;
		foreach (var bamlFile in Files.OfType<BamlResourceProjectFile>()) {
			foreach (var asmRef in bamlFile.AssemblyReferences) {
				if (asmName is not null && !StringComparer.Ordinal.Equals(asmName, asmRef.Name))
					ExtraAssemblyReferences.Add(asmRef.Name);
			}
		}
	}
}
