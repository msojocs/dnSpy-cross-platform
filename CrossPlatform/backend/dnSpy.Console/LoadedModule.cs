using dnlib.DotNet;
using ICSharpCode.Decompiler.Metadata;

namespace dnSpy.Cli;

/// <summary>
/// One file the console loaded: dnlib's view (what types are found through), ILSpy's view (what the
/// decompiler and the project exporter read), and the resolver both share.
/// </summary>
sealed class LoadedModule(string path, ModuleDefMD module, PEFile file, CliAssemblyResolver resolver) : IDisposable {
	public string Path { get; } = path;
	public ModuleDefMD Module { get; } = module;
	public PEFile File { get; } = file;
	public CliAssemblyResolver Resolver { get; } = resolver;

	public void Dispose() {
		File.Dispose();
		Module.Dispose();
	}
}
