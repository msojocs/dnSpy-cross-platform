using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Scripting;

namespace dnSpy.Backend.Core;

/// <summary>
/// The metadata reference resolver of the script engine. The WPF REPL hands <c>#r</c> to Roslyn's
/// <c>ScriptMetadataResolver</c>, which knows the GAC; a .NET host instead has the running framework's
/// assemblies and the host's own directory, and a script's <c>#r "System.Xml.Linq"</c> must find those. A
/// path is resolved against the search paths first; a simple name against the platform's assemblies; anything
/// else is left to Roslyn's resolver.
/// </summary>
sealed class ScriptAssemblyResolver : MetadataReferenceResolver {
	readonly ScriptMetadataResolver fallback;
	readonly IReadOnlyDictionary<string, string> knownAssemblies;
	readonly string baseDirectory;
	readonly IReadOnlyList<string> searchPaths;

	public ScriptAssemblyResolver(string baseDirectory, IReadOnlyList<string> searchPaths) {
		this.baseDirectory = baseDirectory;
		this.searchPaths = searchPaths;
		fallback = ScriptMetadataResolver.Default.WithBaseDirectory(baseDirectory).WithSearchPaths(searchPaths);
		knownAssemblies = CreateKnownAssemblies();
	}

	static IReadOnlyDictionary<string, string> CreateKnownAssemblies() {
		var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
		void Add(string path) {
			var name = Path.GetFileNameWithoutExtension(path);
			if (name.Length > 0)
				map.TryAdd(name, path);
		}
		if (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") is string trusted) {
			foreach (var path in trusted.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
				Add(path);
		}
		// The host's own directory holds dnlib and dnSpy's own assemblies, which are what a script resolves
		// most often — dnSpy.Backend.Contracts is referenced by default and the others by a #r.
		try {
			foreach (var path in Directory.EnumerateFiles(AppContext.BaseDirectory, "*.dll"))
				Add(path);
		}
		catch (IOException) {
		}
		catch (UnauthorizedAccessException) {
		}
		return map;
	}

	public override ImmutableArray<PortableExecutableReference> ResolveReference(string reference, string? baseFilePath, MetadataReferenceProperties properties) {
		if (reference.Length == 0)
			return [];
		var isPath = reference.IndexOfAny(['/', '\\']) >= 0 || reference.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) ||
			reference.EndsWith(".exe", StringComparison.OrdinalIgnoreCase);
		if (isPath) {
			foreach (var candidate in Candidates(reference, baseFilePath)) {
				if (File.Exists(candidate))
					return [MetadataReference.CreateFromFile(candidate, properties)];
			}
		}
		var simpleName = Path.GetFileNameWithoutExtension(reference);
		if (knownAssemblies.TryGetValue(simpleName, out var known))
			return [MetadataReference.CreateFromFile(known, properties)];
		return fallback.ResolveReference(reference, baseFilePath, properties);
	}

	IEnumerable<string> Candidates(string reference, string? baseFilePath) {
		if (Path.IsPathRooted(reference)) {
			yield return reference;
			yield break;
		}
		var baseDir = baseFilePath is null ? baseDirectory : Path.GetDirectoryName(baseFilePath) ?? baseDirectory;
		yield return Path.Combine(baseDir, reference);
		yield return Path.Combine(baseDirectory, reference);
		foreach (var searchPath in searchPaths)
			yield return Path.Combine(searchPath, reference);
	}

	public override bool Equals(object? other) =>
		other is ScriptAssemblyResolver resolver && resolver.baseDirectory == baseDirectory &&
		resolver.searchPaths.SequenceEqual(searchPaths, StringComparer.OrdinalIgnoreCase);

	public override int GetHashCode() => baseDirectory.GetHashCode() ^ searchPaths.Count;
}
