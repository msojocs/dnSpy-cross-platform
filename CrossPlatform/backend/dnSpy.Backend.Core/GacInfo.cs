using System.Text.RegularExpressions;
using dnlib.DotNet;

namespace dnSpy.Backend.Core;

/// <summary>One assembly the GAC holds: its identity, read off the directory it sits in, and its file.</summary>
public sealed record GacFile(string Name, Version Version, string Culture, string PublicKeyToken, string Path);

/// <summary>
/// Where the global assembly caches are and what is in them — a port of dnSpy's <c>GacInfo</c>, which the
/// Open from GAC dialog lists, the framework sweep checks a file against and the assembly resolver searches.
/// On Windows those are the .NET Framework caches under %WINDIR%. dnSpy reads Mono's caches only while it
/// runs on Mono itself; this port runs on .NET everywhere, so Mono's caches are read wherever they are
/// installed — which is where a GAC exists at all on Linux and macOS. Each layout is read with the
/// directory pattern it actually uses: dnSpy matched Mono's caches with the .NET 4 pattern, which
/// expects a "v4.0_" prefix Mono never writes, and so listed none of their assemblies.
/// </summary>
public static class GacInfo {
	sealed record GacDirectory(int Version, string Path, string[] SubDirectories, Regex Pattern);

	static readonly Regex Gac2Pattern = new("^([^_]+)_([^_]*)_([a-fA-F0-9]{16})$", RegexOptions.Compiled);
	static readonly Regex Gac4Pattern = new("^v[^_]+_([^_]+)_([^_]*)_([a-fA-F0-9]{16})$", RegexOptions.Compiled);

	// The reference assembly directories Mono keeps beside its cache. They are not the cache, but a file
	// in one of them is a framework file all the same.
	static readonly string[] MonoVersionDirectories = [
		"4.5", "4.5/Facades", "4.5-api", "4.5-api/Facades", "4.0", "4.0-api",
		"3.5", "3.5-api", "3.0", "3.0-api", "2.0", "2.0-api", "1.1", "1.0",
	];

	static readonly Lazy<(GacDirectory[] Caches, string[] OtherPaths)> Directories = new(() =>
		FindDirectories(MonoPrefixes(), Environment.GetEnvironmentVariable("WINDIR"), Environment.GetEnvironmentVariable("MONO_PATH")));

	/// <summary>Every directory a cache or one of Mono's reference directories lives in.</summary>
	public static IReadOnlyList<string> Paths => [.. Directories.Value.Caches.Select(cache => cache.Path), .. Directories.Value.OtherPaths];

	/// <summary>Every assembly in every cache, the .NET 4 cache before the .NET 2 one — the order dnSpy
	/// enumerates them in, which decides which of two identical entries counts as the duplicate.</summary>
	public static IEnumerable<GacFile> GetAssemblies() {
		foreach (var cache in Directories.Value.Caches.OrderByDescending(cache => cache.Version)) {
			foreach (var file in GetAssemblies(cache))
				yield return file;
		}
	}

	/// <summary>Whether a file lives in a GAC or in one of Mono's reference directories.</summary>
	public static bool IsGacPath(string fileName) {
		if (!File.Exists(fileName))
			return false;
		foreach (var path in Paths) {
			if (IsSubPath(path, fileName))
				return true;
		}
		return false;
	}

	/// <summary>
	/// The file a reference resolves to in a global assembly cache, or null when none has it — what dnSpy's
	/// AssemblyResolver falls back on for a .NET Framework, .NET Standard or unknown target once the
	/// referencing module's own search paths came up empty: the cache entry with the reference's exact identity,
	/// then a file of that name in one of Mono's reference directories whose identity — version and public key
	/// token included — is the one asked for.
	/// </summary>
	public static string? Resolve(IAssembly? assembly) => Resolve(assembly, Directories.Value);

	/// <summary>The same search over the caches a Mono install under <paramref name="monoPrefix"/> has and nothing
	/// else, which is how a cache standing in a directory of its own is searched.</summary>
	public static string? ResolveUnder(IAssembly? assembly, string monoPrefix) =>
		Resolve(assembly, FindDirectories([monoPrefix], windir: null, monoPath: null));

	static string? Resolve(IAssembly? assembly, (GacDirectory[] Caches, string[] OtherPaths) directories) {
		if (assembly is null || string.IsNullOrEmpty(UTF8String.ToSystemStringOrEmpty(assembly.Name)))
			return null;
		if (FindInGac(assembly, directories.Caches) is { } file)
			return file;
		foreach (var path in directories.OtherPaths) {
			if (FindInDirectory(assembly, path) is { } found)
				return found;
		}
		return null;
	}

	/// <summary>The file a strong-named reference resolves to in a cache, or null when no cache has it.</summary>
	static string? FindInGac(IAssembly assembly, GacDirectory[] caches) {
		var token = PublicKeyBase.ToPublicKeyToken(assembly.PublicKeyOrToken);
		if (PublicKeyBase.IsNullOrEmpty2(token))
			return null;
		var culture = UTF8String.ToSystemStringOrEmpty(assembly.Culture);
		if (culture.Equals("neutral", StringComparison.OrdinalIgnoreCase))
			culture = string.Empty;
		var name = UTF8String.ToSystemStringOrEmpty(assembly.Name);
		foreach (var cache in caches.OrderByDescending(cache => cache.Version)) {
			var prefix = cache.Pattern == Gac4Pattern ? "v4.0_" : string.Empty;
			foreach (var subDirectory in cache.SubDirectories) {
				string file;
				try {
					file = System.IO.Path.Combine(cache.Path, subDirectory, name, $"{prefix}{assembly.Version}_{culture}_{token}", name + ".dll");
				}
				catch (ArgumentException) {
					// A name or a culture with characters no path may hold.
					return null;
				}
				if (File.Exists(file))
					return file;
			}
		}
		return null;
	}

	/// <summary>
	/// dnSpy's TryLoadFromDir over one of Mono's reference directories: "name.dll", else "name.exe", and only
	/// when the assembly in it is the one the reference names. A file dnlib cannot read is no match.
	/// </summary>
	static string? FindInDirectory(IAssembly assembly, string directory) {
		string baseName;
		try {
			baseName = System.IO.Path.Combine(directory, UTF8String.ToSystemStringOrEmpty(assembly.Name));
		}
		catch (ArgumentException) {
			return null;
		}
		return Matching(baseName + ".dll") ?? Matching(baseName + ".exe");

		string? Matching(string file) {
			if (!File.Exists(file))
				return null;
			try {
				using var module = ModuleDefMD.Load(file);
				return module.Assembly is { } found && new AssemblyNameComparer(AssemblyNameComparerFlags.All).Equals(assembly, found) ? file : null;
			}
			catch (Exception ex) when (ex is BadImageFormatException or IOException or UnauthorizedAccessException) {
				return null;
			}
		}
	}

	static IEnumerable<GacFile> GetAssemblies(GacDirectory cache) {
		foreach (var subDirectory in cache.SubDirectories) {
			foreach (var assemblyDirectory in GetDirectories(System.IO.Path.Combine(cache.Path, subDirectory))) {
				foreach (var versionDirectory in GetDirectories(assemblyDirectory)) {
					var match = cache.Pattern.Match(System.IO.Path.GetFileName(versionDirectory));
					if (!match.Success || !Version.TryParse(match.Groups[1].Value, out var version))
						continue;
					var token = match.Groups[3].Value.ToLowerInvariant();
					var name = System.IO.Path.GetFileName(assemblyDirectory);
					var file = System.IO.Path.Combine(versionDirectory, name) + ".dll";
					if (!File.Exists(file)) {
						file = System.IO.Path.Combine(versionDirectory, name) + ".exe";
						if (!File.Exists(file))
							continue;
					}
					yield return new GacFile(name, version, match.Groups[2].Value, token, file);
				}
			}
		}
	}

	static (GacDirectory[], string[]) FindDirectories(IEnumerable<string> monoPrefixes, string? windir, string? monoPath) {
		var caches = new List<GacDirectory>();
		var others = new List<string>();
		// GAC_32 comes first in a 32-bit process and GAC_64 in a 64-bit one; the .NET 2 cache has one more.
		string[] subDirectories4 = Environment.Is64BitProcess ? ["GAC_64", "GAC_32", "GAC_MSIL"] : ["GAC_32", "GAC_64", "GAC_MSIL"];
		string[] subDirectories2 = [.. subDirectories4, "GAC"];
		if (!string.IsNullOrEmpty(windir)) {
			var gac2 = System.IO.Path.Combine(windir, "assembly");
			if (File.Exists(System.IO.Path.Combine(gac2, "GAC_32", "mscorlib", "2.0.0.0__b77a5c561934e089", "mscorlib.dll"))
				|| File.Exists(System.IO.Path.Combine(gac2, "GAC_64", "mscorlib", "2.0.0.0__b77a5c561934e089", "mscorlib.dll")))
				caches.Add(new GacDirectory(2, gac2, subDirectories2, Gac2Pattern));
			var gac4 = System.IO.Path.Combine(windir, "Microsoft.NET", "assembly");
			if (Directory.Exists(gac4))
				caches.Add(new GacDirectory(4, gac4, subDirectories4, Gac4Pattern));
		}
		var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
		foreach (var prefix in monoPrefixes) {
			var lib = System.IO.Path.Combine(prefix, "lib", "mono");
			if (!seen.Add(lib))
				continue;
			// Mono's cache keeps one directory per assembly with "version_culture_token" directories under it,
			// the .NET 2 layout with no GAC_* level in between.
			if (Directory.Exists(System.IO.Path.Combine(lib, "gac")))
				caches.Add(new GacDirectory(4, lib, ["gac"], Gac2Pattern));
			foreach (var versionDirectory in MonoVersionDirectories) {
				var path = System.IO.Path.Combine(lib, versionDirectory);
				if (Directory.Exists(path))
					others.Add(path);
			}
		}
		if (monoPath is not null) {
			foreach (var entry in monoPath.Split(System.IO.Path.PathSeparator)) {
				var path = entry.Trim();
				if (path.Length != 0 && Directory.Exists(path))
					others.Add(path);
			}
		}
		return ([.. caches], [.. others]);
	}

	static IEnumerable<string> MonoPrefixes() {
		if (Environment.GetEnvironmentVariable("MONO_GAC_PREFIX") is { } prefixes) {
			foreach (var entry in prefixes.Split(System.IO.Path.PathSeparator)) {
				var prefix = entry.Trim();
				if (prefix.Length != 0)
					yield return prefix;
			}
		}
		if (OperatingSystem.IsWindows())
			yield break;
		yield return "/usr";
		yield return "/usr/local";
		yield return "/opt/mono";
		if (OperatingSystem.IsMacOS())
			yield return "/Library/Frameworks/Mono.framework/Versions/Current";
	}

	static bool IsSubPath(string path, string fileName) {
		var directory = System.IO.Path.GetFullPath(System.IO.Path.GetDirectoryName(fileName)!);
		var root = System.IO.Path.GetPathRoot(directory);
		while (!string.IsNullOrEmpty(directory) && !StringComparer.OrdinalIgnoreCase.Equals(directory, root)) {
			if (StringComparer.OrdinalIgnoreCase.Equals(path, directory))
				return true;
			directory = System.IO.Path.GetDirectoryName(directory);
		}
		return false;
	}

	static string[] GetDirectories(string directory) {
		try {
			return Directory.GetDirectories(directory);
		}
		catch {
			return [];
		}
	}
}
