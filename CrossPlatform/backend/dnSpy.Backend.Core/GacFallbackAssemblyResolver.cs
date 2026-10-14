using System.Diagnostics.CodeAnalysis;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using ICSharpCode.Decompiler.Metadata;
using AssemblyNameInfo = dnlib.DotNet.AssemblyNameInfo;

namespace dnSpy.Backend.Core;

/// <summary>
/// The decompiler's resolver with dnSpy's last resort behind it: a reference the module's directory and its
/// target framework's directories do not provide is looked up in the global assembly caches, the way dnSpy's
/// AssemblyResolver does for a module that targets .NET Framework, .NET Standard or nothing it can tell. A .NET
/// (Core) module never reaches the caches — dnSpy does not search them for one either. Everything else is the
/// wrapped resolver's, so a reference it finds resolves exactly as it did before.
/// </summary>
sealed class GacFallbackAssemblyResolver(UniversalAssemblyResolver inner, string? targetFramework) : IAssemblyResolver, IAssemblyReferenceClassifier {
	readonly bool searchesGac = SearchesGac(targetFramework);

	/// <summary>The resolver the decompiler builds for a module, with the caches behind it.</summary>
	public static GacFallbackAssemblyResolver Create(string modulePath, MetadataFile module, bool throwOnError, PEStreamOptions streamOptions = PEStreamOptions.Default, MetadataReaderOptions metadataOptions = MetadataReaderOptions.Default) {
		var targetFramework = module.DetectTargetFrameworkId();
		return new GacFallbackAssemblyResolver(
			new UniversalAssemblyResolver(modulePath, throwOnError, targetFramework, module.DetectRuntimePack(), streamOptions, metadataOptions),
			targetFramework);
	}

	/// <summary>dnSpy's FrameworkKind switch: only a .NET (Core) target leaves the caches out of the search.</summary>
	public static bool SearchesGac(string? targetFramework) =>
		targetFramework is null || !targetFramework.StartsWith(".NETCoreApp", StringComparison.OrdinalIgnoreCase);

	/// <summary>The file the reference resolves to: the wrapped resolver's answer, else the caches'.</summary>
	public string? FindAssemblyFile(IAssemblyReference reference) {
		try {
			if (inner.FindAssemblyFile(reference) is { } file)
				return file;
		}
		catch (Exception) {
			// A reference the search cannot make sense of may still sit in a cache under its exact identity.
		}
		return FindInGac(reference);
	}

	public MetadataFile? Resolve(IAssemblyReference reference) {
		MetadataFile? file;
		try {
			file = inner.Resolve(reference);
		}
		catch (Exception) {
			// A resolver told to throw on a missing reference throws here; the caches get their say first.
			if (LoadFromGac(reference) is { } fromGac)
				return fromGac;
			throw;
		}
		return file ?? LoadFromGac(reference);
	}

	public async Task<MetadataFile?> ResolveAsync(IAssemblyReference reference) {
		MetadataFile? file;
		try {
			file = await inner.ResolveAsync(reference).ConfigureAwait(false);
		}
		catch (Exception) {
			if (LoadFromGac(reference) is { } fromGac)
				return fromGac;
			throw;
		}
		return file ?? LoadFromGac(reference);
	}

	public MetadataFile? ResolveModule(MetadataFile mainModule, string moduleName) => inner.ResolveModule(mainModule, moduleName);

	public Task<MetadataFile?> ResolveModuleAsync(MetadataFile mainModule, string moduleName) => inner.ResolveModuleAsync(mainModule, moduleName);

	public IDisposable? BeginSnapshot() => inner.BeginSnapshot();

	public bool IsGacAssembly(IAssemblyReference reference) => inner.IsGacAssembly(reference);

	public bool IsSharedAssembly(IAssemblyReference reference, [NotNullWhen(true)] out string? runtimePack) => inner.IsSharedAssembly(reference, out runtimePack);

	string? FindInGac(IAssemblyReference reference) {
		if (!searchesGac)
			return null;
		try {
			return GacInfo.Resolve(new AssemblyNameInfo(reference.FullName));
		}
		catch (ArgumentException) {
			// A display name dnlib cannot parse names nothing a cache could hold.
			return null;
		}
	}

	MetadataFile? LoadFromGac(IAssemblyReference reference) {
		if (FindInGac(reference) is not { } path)
			return null;
		try {
			return new PEFile(path, new MemoryStream(File.ReadAllBytes(path), writable: false), PEStreamOptions.PrefetchEntireImage);
		}
		catch (Exception ex) when (ex is BadImageFormatException or IOException or UnauthorizedAccessException or MetadataFileNotSupportedException) {
			return null;
		}
	}
}
