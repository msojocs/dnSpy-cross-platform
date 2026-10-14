using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core;

/// <summary>
/// The lists dnSpy's Open List dialog finds on its own (DotnetReferenceFileFinder): one per shared framework
/// of every .NET install on this machine — "Microsoft.NETCore.App 10.0.2 (x64)" — holding the framework's
/// managed DLLs. The installs are found where DotNetPathProvider looks for them on Linux and macOS, plus the
/// one this process runs on, which is how a user-local or package-manager install is found too.
/// </summary>
public static class DefaultDocumentLists {
	static readonly Regex FrameworkVersionPattern = new(@"^\d+\.\d+\.\d+(-.*)?$", RegexOptions.Compiled);

	public static DocumentListsResponse Find() => new(FindIn(BaseDirectoryCandidates()));

	/// <summary>The lists the installs under these directories hold, a directory named twice counted once.</summary>
	public static IReadOnlyList<DocumentListDto> FindIn(IEnumerable<string> baseDirectories) {
		var lists = new List<DocumentListDto>();
		var seen = new HashSet<string>(StringComparer.Ordinal);
		foreach (var candidate in baseDirectories) {
			string baseDirectory;
			try {
				baseDirectory = Path.TrimEndingDirectorySeparator(Path.GetFullPath(candidate));
			}
			catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException) {
				continue;
			}
			if (!seen.Add(baseDirectory))
				continue;
			var sharedDirectory = Path.Combine(baseDirectory, "shared");
			foreach (var frameworkDirectory in Directories(sharedDirectory)) {
				foreach (var versionDirectory in Directories(frameworkDirectory)) {
					var version = Path.GetFileName(versionDirectory);
					if (!FrameworkVersionPattern.IsMatch(version))
						continue;
					var files = Files(versionDirectory)
						.Where(IsManagedFrameworkFile)
						.OrderBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase)
						.ToArray();
					if (files.Length > 0)
						lists.Add(new DocumentListDto($"{Path.GetFileName(frameworkDirectory)} {version} ({Bitness()})", files));
				}
			}
		}
		return lists;
	}

	/// <summary>
	/// DotnetReferenceFileFinder.FilterFiles: the official managed assemblies start with an uppercase letter,
	/// less the native ones that sit beside them; of the lowercase names only mscorlib and netstandard are
	/// managed. On Linux the native libraries are "lib*.so", which the same rule leaves out.
	/// </summary>
	static bool IsManagedFrameworkFile(string file) {
		if (!file.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
			return false;
		var name = Path.GetFileNameWithoutExtension(file);
		if (name.Length == 0)
			return false;
		if (char.IsAsciiLetterUpper(name[0]))
			return !name.StartsWith("Microsoft.DiaSymReader.Native.", StringComparison.Ordinal)
				&& !name.StartsWith("D3DCompiler_", StringComparison.Ordinal)
				&& name is not ("PenImc_cor3" or "PresentationNative_cor3");
		if (char.IsAsciiLetterLower(name[0]))
			return name is "mscorlib" or "netstandard";
		return true;
	}

	/// <summary>DotNetPathProvider.GetDotNetBaseDirCandidates on Linux and macOS, and the install the running
	/// runtime belongs to — its corlib sits in &lt;install&gt;/shared/&lt;framework&gt;/&lt;version&gt;.</summary>
	static IEnumerable<string> BaseDirectoryCandidates() {
		if (Environment.GetEnvironmentVariable("DOTNET_ROOT") is { Length: > 0 } dotnetRoot)
			yield return dotnetRoot;
		if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) {
			foreach (var folder in new[] { Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86 }) {
				if (Environment.GetFolderPath(folder) is { Length: > 0 } programFiles)
					yield return Path.Combine(programFiles, "dotnet");
			}
		}
		else {
			yield return "/usr/share/dotnet";
			yield return "/usr/local/share/dotnet";
			yield return "/opt/dotnet";
			yield return "/usr/lib/dotnet";
		}
		var runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location);
		if (Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(runtimeDirectory))) is { Length: > 0 } install)
			yield return install;
	}

	static string Bitness() => RuntimeInformation.OSArchitecture switch {
		Architecture.X86 => "x86",
		Architecture.Arm64 => "arm64",
		Architecture.Arm => "arm",
		_ => "x64",
	};

	static IEnumerable<string> Directories(string path) {
		try {
			return Directory.Exists(path) ? Directory.GetDirectories(path).Order(StringComparer.Ordinal).ToArray() : [];
		}
		catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) {
			return [];
		}
	}

	static IEnumerable<string> Files(string path) {
		try {
			return Directory.GetFiles(path);
		}
		catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) {
			return [];
		}
	}
}
