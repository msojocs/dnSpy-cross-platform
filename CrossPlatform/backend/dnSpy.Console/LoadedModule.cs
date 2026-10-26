using dnlib.DotNet;
using dnSpy.Backend.Core;
using ICSharpCode.Decompiler.Metadata;

namespace dnSpy.Cli;

/// <summary>
/// One file the console loaded: dnlib's view (what types are found through, what the IL is disassembled and the
/// project's files are found from), ILSpy's view (what the C# decompiler reads), and the resolver both share.
/// </summary>
sealed class LoadedModule(string path, ModuleDefMD module, PEFile file, CliAssemblyResolver resolver) : IDisposable {
	readonly Lazy<PortablePdbInfoProvider?> debugInfo = new(() => PortablePdbInfoProvider.TryCreate(path));

	public string Path { get; } = path;
	public ModuleDefMD Module { get; } = module;
	public PEFile File { get; } = file;
	public CliAssemblyResolver Resolver { get; } = resolver;

	/// <summary>The PDB beside the file, whose local names the C# decompiler uses with use-debug-syms.</summary>
	public PortablePdbInfoProvider? DebugInfo => debugInfo.Value;

	public void Dispose() {
		if (debugInfo.IsValueCreated)
			debugInfo.Value?.Dispose();
		File.Dispose();
		Module.Dispose();
	}
}
