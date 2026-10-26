using dnlib.DotNet;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.Metadata;
using IAssemblyResolver = ICSharpCode.Decompiler.Metadata.IAssemblyResolver;

namespace dnSpy.Backend.Core.ProjectExport;

/// <summary>dnSpy's ProjectVersion (dnSpy.Decompiler/MSBuild/ProjectVersion.cs), in its order: the Visual Studio a
/// legacy project's ToolsVersion and the solution's header are written for. VS2003 uses another project format.</summary>
public enum ProjectVersion {
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

/// <summary>The languages a project can be exported in — the decompilers whose ProjectFileExtension is not null.</summary>
public enum ProjectExportLanguage {
	CSharp,
	VisualBasic,
}

/// <summary>
/// dnSpy's ProjectCreatorOptions and ProjectModuleOptions in one: where the projects go, the solution beside them,
/// the format, and the switches the Export to Project dialog and dnSpy.Console's command line share.
/// </summary>
public sealed class ProjectExportOptions {
	public required string Directory { get; init; }
	/// <summary>The solution's file name inside <see cref="Directory"/>, or null to write none. A name ending in
	/// <c>.slnx</c> gets the XML solution format.</summary>
	public string? SolutionFilename { get; init; }
	public ProjectVersion ProjectVersion { get; init; } = ProjectVersion.VS2010;
	public bool SdkProject { get; init; }
	public ProjectExportLanguage Language { get; init; }
	/// <summary>The first project's guid; the next modules (in path order) count on from it, the way dnSpy numbers
	/// them. Null gives every project a new guid — the dialog's empty Project GUID.</summary>
	public Guid? ProjectGuid { get; init; }
	public bool UnpackResources { get; init; } = true;
	public bool CreateResX { get; init; } = true;
	public bool DecompileBaml { get; init; } = true;
	/// <summary>
	/// How the XAML files are written (dnSpy's XamlOutputOptions): the BAML page's layout in the GUI, which the
	/// export dialog takes from IXamlOutputOptionsProvider; null is the console's tabs and one attribute per line.
	/// </summary>
	public dnSpy.Backend.Contracts.BamlDecompilerSettingsDto? XamlOutput { get; init; }
	/// <summary>The opposite of dnSpy's DontReferenceStdLib: false drops the core library references.</summary>
	public bool AddCorlibReference { get; init; } = true;
	/// <summary>How many files are decompiled at once; 0 is one per processor.</summary>
	public int NumberOfThreads { get; init; }
	public string IndentationString { get; init; } = "\t";
	/// <summary>
	/// ProjectCreatorOptions.UserGACPaths: directories whose assemblies count as cache assemblies, so a reference
	/// to one is written without a HintPath.
	/// </summary>
	public IReadOnlyList<string> UserGacPaths { get; init; } = [];
	/// <summary>The C# decompiler's settings. The exporter works on a copy.</summary>
	public DecompilerSettings Settings { get; init; } = new();

	public string FileExtension => Language == ProjectExportLanguage.VisualBasic ? ".vb" : ".cs";
	public string ProjectFileExtension => Language == ProjectExportLanguage.VisualBasic ? ".vbproj" : ".csproj";
}

/// <summary>
/// dnSpy's IMSBuildProgressListener: the export says how many steps it has once it knows, then how many it has
/// done. It may be called from several threads; a value lower than one already received is to be ignored.
/// </summary>
public interface IProjectExportProgress {
	void SetMaxProgress(int maxProgress);
	void SetProgress(int progress);
}

/// <summary>
/// One module to export — dnSpy's ProjectModuleOptions.Module: its dnlib model, which the project's files are found
/// in (types, resources, the Win32 icon and manifest), and the file ICSharpCode.Decompiler reads the code from, with
/// the resolver its references are found with. The model's assembly resolver is what tells a WinForms form or a
/// settings class by its base types, as dnSpy's does. The caller owns the file and the model and disposes of them.
/// </summary>
public sealed class ProjectExportModule(string path, PEFile file, ModuleDef module, IAssemblyResolver resolver, IAssemblyReferenceClassifier classifier) {
	public string Path { get; } = path;
	public PEFile File { get; } = file;
	public ModuleDef Module { get; } = module;
	public IAssemblyResolver Resolver { get; } = resolver;
	public IAssemblyReferenceClassifier Classifier { get; } = classifier;

	/// <summary>The project's guid, which the exporter assigns when it starts.</summary>
	internal Guid ProjectGuid { get; set; }
}
