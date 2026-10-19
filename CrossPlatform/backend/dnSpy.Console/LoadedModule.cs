using dnlib.DotNet;
using ICSharpCode.Decompiler.Metadata;

namespace dnSpy.Cli;

/// <summary>
/// One file the console loaded: dnlib's view (what types are found through), ILSpy's view (what the
/// decompiler and the project exporter read), and the resolver both share. ProjectDirectoryName and
/// ProjectGuid are filled in when an export starts.
/// </summary>
sealed class LoadedModule(string path, ModuleDefMD module, PEFile file, CliAssemblyResolver resolver) : IDisposable {
	public string Path { get; } = path;
	public ModuleDefMD Module { get; } = module;
	public PEFile File { get; } = file;
	public CliAssemblyResolver Resolver { get; } = resolver;
	public string ProjectDirectoryName { get; set; } = string.Empty;
	public Guid ProjectGuid { get; set; }
	public string PlatformName { get; set; } = "AnyCPU";

	public bool IsDll => (Module.Characteristics & dnlib.PE.Characteristics.Dll) != 0;

	/// <summary>The name a project directory and a project file get, as dnSpy names them.</summary>
	public string AssemblyOrModuleName =>
		Module.Assembly is { } assembly && Module.IsManifestModule
			? assembly.Name.String
			: System.IO.Path.GetFileNameWithoutExtension(Module.Name.String);

	public void Dispose() {
		File.Dispose();
		Module.Dispose();
	}
}
