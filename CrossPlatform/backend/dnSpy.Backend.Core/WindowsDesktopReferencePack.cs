namespace dnSpy.Backend.Core;

/// <summary>
/// The Windows Desktop reference assemblies (WPF, WinForms) of a .NET target, for a system without the Windows Desktop
/// runtime: dnSpy runs on Windows, where its resolver finds them in the installed runtime; elsewhere the reference pack
/// an SDK build with EnableWindowsTargeting downloaded — into the dotnet directory's packs or the NuGet cache — has
/// the same types.
/// </summary>
static class WindowsDesktopReferencePack {
	const string PackName = "Microsoft.WindowsDesktop.App.Ref";

	/// <summary>
	/// The reference assembly named <paramref name="simpleName"/> for a module of <paramref name="targetFramework"/>,
	/// when it is one of the Windows Desktop runtime's own.
	/// </summary>
	public static string? Find(string simpleName, string? targetFramework) {
		if (!IsDesktopAssembly(simpleName) || Directory(targetFramework) is not { } directory)
			return null;
		var file = Path.Combine(directory, simpleName + ".dll");
		return File.Exists(file) ? file : null;
	}

	/// <summary>The directory of the pack's reference assemblies for <paramref name="targetFramework"/>, if there is one.</summary>
	public static string? Directory(string? targetFramework) =>
		targetFramework is null ? null : directories.GetOrAdd(targetFramework, static framework =>
			ParseNetCoreVersion(framework) is { } version ? ReferenceDirectories(version).FirstOrDefault() : null);

	static readonly System.Collections.Concurrent.ConcurrentDictionary<string, string?> directories = new(StringComparer.OrdinalIgnoreCase);

	/// <summary>Whether an assembly is one of Microsoft.WindowsDesktop.App's that Microsoft.NETCore.App does not have.</summary>
	public static bool IsDesktopAssembly(string simpleName) => desktopAssemblies.Contains(simpleName);

	static readonly HashSet<string> desktopAssemblies = new(StringComparer.OrdinalIgnoreCase) {
		"Accessibility", "Microsoft.VisualBasic.Forms", "Microsoft.Win32.Registry.AccessControl", "Microsoft.Win32.SystemEvents",
		"PresentationCore", "PresentationFramework", "PresentationFramework.Aero", "PresentationFramework.Aero2",
		"PresentationFramework.AeroLite", "PresentationFramework.Classic", "PresentationFramework.Luna",
		"PresentationFramework.Royale", "PresentationUI", "ReachFramework", "System.CodeDom",
		"System.Configuration.ConfigurationManager", "System.Design", "System.Diagnostics.EventLog",
		"System.Diagnostics.PerformanceCounter", "System.DirectoryServices", "System.Drawing.Common", "System.Drawing.Design",
		"System.IO.Packaging", "System.Printing", "System.Resources.Extensions", "System.Security.Cryptography.Pkcs",
		"System.Security.Cryptography.ProtectedData", "System.Security.Cryptography.Xml", "System.Security.Permissions",
		"System.Threading.AccessControl", "System.Windows.Controls.Ribbon", "System.Windows.Extensions", "System.Windows.Forms",
		"System.Windows.Forms.Design", "System.Windows.Forms.Design.Editors", "System.Windows.Forms.Primitives",
		"System.Windows.Input.Manipulations", "System.Windows.Presentation", "System.Windows.Primitives", "System.Xaml",
		"UIAutomationClient", "UIAutomationClientSideProviders", "UIAutomationProvider", "UIAutomationTypes", "WindowsBase",
		"WindowsFormsIntegration",
	};

	// ".NETCoreApp,Version=v10.0" — what ILSpy's DetectTargetFrameworkId writes, a platform suffix included or not.
	static Version? ParseNetCoreVersion(string? targetFramework) {
		const string Prefix = ".NETCoreApp,Version=v";
		if (targetFramework is null || !targetFramework.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase))
			return null;
		var text = targetFramework[Prefix.Length..];
		var end = text.IndexOfAny([',', '-']);
		if (end >= 0)
			text = text[..end];
		return Version.TryParse(text, out var version) && version.Major >= 3 ? version : null;
	}

	/// <summary>The packs' ref directories for the version, the closest pack version first.</summary>
	static IEnumerable<string> ReferenceDirectories(Version version) {
		var monikers = version.Major >= 5 ? new[] { $"net{version.Major}.{version.Minor}" } : [$"netcoreapp{version.Major}.{version.Minor}"];
		var packs = new List<(Version Version, string Directory)>();
		foreach (var root in PackRoots()) {
			string[] versionDirectories;
			try {
				versionDirectories = System.IO.Directory.GetDirectories(root);
			}
			catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) {
				continue;
			}
			foreach (var versionDirectory in versionDirectories) {
				var name = Path.GetFileName(versionDirectory);
				var dash = name.IndexOf('-', StringComparison.Ordinal);
				if (!Version.TryParse(dash < 0 ? name : name[..dash], out var packVersion))
					continue;
				foreach (var moniker in monikers) {
					var refDirectory = Path.Combine(versionDirectory, "ref", moniker);
					if (System.IO.Directory.Exists(refDirectory))
						packs.Add((packVersion, refDirectory));
				}
			}
		}
		return packs
			.OrderBy(pack => pack.Version.Major == version.Major && pack.Version.Minor == version.Minor ? 0 : 1)
			.ThenByDescending(pack => pack.Version)
			.Select(pack => pack.Directory);
	}

	static IEnumerable<string> PackRoots() {
		var dotnetRoot = Environment.GetEnvironmentVariable("DOTNET_ROOT");
		if (string.IsNullOrEmpty(dotnetRoot))
			dotnetRoot = Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(typeof(object).Assembly.Location))));
		if (!string.IsNullOrEmpty(dotnetRoot))
			yield return Path.Combine(dotnetRoot, "packs", PackName);
		var nugetPackages = Environment.GetEnvironmentVariable("NUGET_PACKAGES");
		if (string.IsNullOrEmpty(nugetPackages)) {
			var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
			if (!string.IsNullOrEmpty(home))
				nugetPackages = Path.Combine(home, ".nuget", "packages");
		}
		if (!string.IsNullOrEmpty(nugetPackages))
			yield return Path.Combine(nugetPackages, PackName.ToLowerInvariant());
	}
}
