using System.Diagnostics.CodeAnalysis;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using dnSpy.Backend.Core;
using ICSharpCode.Decompiler.Metadata;

namespace dnSpy.Cli;

/// <summary>
/// The resolver the decompiler and the project exporter use. It is ICSharpCode.Decompiler's
/// UniversalAssemblyResolver over the module's directory and every --asm-path, with dnSpy's GAC rules
/// on top: --no-gac keeps the caches out, --user-gac directories count as caches (so a reference
/// found in one gets no HintPath), and the cache lookup falls back the way dnSpy's own resolver does.
/// A WPF or WinForms module of .NET finds the Windows Desktop assemblies in their reference pack where
/// the Windows Desktop runtime dnSpy would find them in is not installed.
/// </summary>
sealed class CliAssemblyResolver : IAssemblyResolver, IAssemblyReferenceClassifier {
	readonly UniversalAssemblyResolver inner;
	readonly IReadOnlyList<string> userGacPaths;
	readonly bool useGac;
	readonly string? targetFramework;

	/// <summary>The framework the module targets, as ILSpy detects it: ".NETCoreApp,Version=v10.0".</summary>
	public string? TargetFramework => targetFramework;

	CliAssemblyResolver(UniversalAssemblyResolver inner, IReadOnlyList<string> userGacPaths, bool useGac, string? targetFramework) {
		this.inner = inner;
		this.userGacPaths = userGacPaths;
		this.useGac = useGac;
		this.targetFramework = targetFramework;
	}

	public static CliAssemblyResolver Create(string modulePath, IEnumerable<string> searchPaths, IEnumerable<string> userGacPaths, bool useGac) {
		SetGacSearch(useGac);
		var targetFramework = DetectTargetFramework(modulePath);
		var inner = new UniversalAssemblyResolver(modulePath, throwOnError: false, targetFramework, runtimePack: null);
		foreach (var directory in searchPaths) {
			if (!string.IsNullOrEmpty(directory) && Directory.Exists(directory))
				inner.AddSearchDirectory(directory);
		}
		return new CliAssemblyResolver(inner, [.. userGacPaths], useGac, targetFramework);
	}

	static string? DetectTargetFramework(string modulePath) {
		try {
			using var file = new PEFile(modulePath);
			return file.DetectTargetFrameworkId();
		}
		catch (Exception) {
			return null;
		}
	}

	/// <summary>
	/// UniversalAssemblyResolver keeps the cache directories in a process-wide static list and has no
	/// switch to turn them off, so --no-gac empties that list. The list is saved the first time and put
	/// back when a later module wants the caches again, which keeps repeated in-process runs (the tests)
	/// independent of each other.
	/// </summary>
	static void SetGacSearch(bool enabled) {
		var field = typeof(UniversalAssemblyResolver).GetField("gac_paths", BindingFlags.NonPublic | BindingFlags.Static);
		if (field?.GetValue(null) is not IList<string> paths)
			return;
		gacPaths ??= [.. paths];
		if (enabled) {
			if (paths.Count == 0) {
				foreach (var path in gacPaths)
					paths.Add(path);
			}
		}
		else
			paths.Clear();
	}

	static List<string>? gacPaths;

	public MetadataFile? Resolve(IAssemblyReference reference) {
		try {
			if (inner.Resolve(reference) is { } file)
				return file;
		}
		catch (Exception) {
			// A missing reference answers null below; the decompiler reports it as it always does.
		}
		return ResolveFromDesktopPack(reference) ?? (useGac ? ResolveFromGac(reference) : null);
	}

	public async Task<MetadataFile?> ResolveAsync(IAssemblyReference reference) {
		try {
			if (await inner.ResolveAsync(reference).ConfigureAwait(false) is { } file)
				return file;
		}
		catch (Exception) {
		}
		return ResolveFromDesktopPack(reference) ?? (useGac ? ResolveFromGac(reference) : null);
	}

	public MetadataFile? ResolveModule(MetadataFile mainModule, string moduleName) => inner.ResolveModule(mainModule, moduleName);
	public Task<MetadataFile?> ResolveModuleAsync(MetadataFile mainModule, string moduleName) => inner.ResolveModuleAsync(mainModule, moduleName);
	public IDisposable? BeginSnapshot() => inner.BeginSnapshot();

	public bool IsGacAssembly(IAssemblyReference reference) {
		if (!useGac)
			return false;
		var file = FindAssemblyFile(reference);
		return file is not null && (GacInfo.IsGacPath(file) || IsUnderUserGac(file));
	}

	public bool IsSharedAssembly(IAssemblyReference reference, [NotNullWhen(true)] out string? runtimePack) {
		runtimePack = null;
		try {
			if (inner.IsSharedAssembly(reference, out runtimePack))
				return true;
		}
		catch (Exception) {
		}
		if (WindowsDesktopReferencePack.Find(reference.Name, targetFramework) is null)
			return false;
		runtimePack = "Microsoft.WindowsDesktop.App";
		return true;
	}

	public string? FindAssemblyFile(IAssemblyReference reference) {
		try {
			if (inner.FindAssemblyFile(reference) is { } file)
				return file;
		}
		catch (Exception) {
		}
		return WindowsDesktopReferencePack.Find(reference.Name, targetFramework)
			?? (useGac ? GacInfo.Resolve(new dnlib.DotNet.AssemblyNameInfo(reference.FullName)) : null);
	}

	MetadataFile? ResolveFromDesktopPack(IAssemblyReference reference) {
		if (WindowsDesktopReferencePack.Find(reference.Name, targetFramework) is not { } path)
			return null;
		try {
			return new PEFile(path, new MemoryStream(File.ReadAllBytes(path), writable: false), PEStreamOptions.PrefetchEntireImage);
		}
		catch (Exception ex) when (ex is BadImageFormatException or IOException or UnauthorizedAccessException or MetadataFileNotSupportedException) {
			return null;
		}
	}

	bool IsUnderUserGac(string file) {
		foreach (var path in userGacPaths) {
			if (IsSubPath(path, file))
				return true;
		}
		return false;
	}

	static bool IsSubPath(string directory, string file) {
		try {
			var fullDirectory = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
			return Path.GetFullPath(file).StartsWith(fullDirectory, StringComparison.Ordinal);
		}
		catch (Exception) {
			return false;
		}
	}

	MetadataFile? ResolveFromGac(IAssemblyReference reference) {
		try {
			if (GacInfo.Resolve(new dnlib.DotNet.AssemblyNameInfo(reference.FullName)) is not { } path)
				return null;
			return new PEFile(path, new MemoryStream(File.ReadAllBytes(path), writable: false), PEStreamOptions.PrefetchEntireImage);
		}
		catch (Exception ex) when (ex is BadImageFormatException or IOException or UnauthorizedAccessException or MetadataFileNotSupportedException or ArgumentException) {
			return null;
		}
	}
}
