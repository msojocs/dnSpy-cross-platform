using System.Collections.Concurrent;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Host.Mef;

namespace dnSpy.Backend.Core.LanguageService;

/// <summary>
/// The Roslyn services every language feature runs on — dnSpy's <c>RoslynMefHostServices</c>: the workspace
/// and feature assemblies composed once, because composing them is the slow part of the first request.
/// </summary>
public static class LanguageServiceHost {
	static readonly Lazy<MefHostServices> services = new(Create);
	static readonly Lazy<AdhocWorkspace> workspace = new(() => new AdhocWorkspace(services.Value));

	public static MefHostServices Services => services.Value;

	/// <summary>A workspace with no documents, for the APIs that only want its services (the classifier).</summary>
	public static Workspace Workspace => workspace.Value;

	/// <summary>
	/// Roslyn's default parts, less the Pythia signature help provider: it imports an implementation only its host
	/// supplies, which would fail the composition of every signature help provider. dnSpy exports an implementation
	/// that has no signatures to give (<c>PythiaSignatureHelpProviderImplementation</c>); leaving the provider out
	/// gives the same signatures.
	/// </summary>
	static MefHostServices Create() {
		var parts = MefHostServices.DefaultAssemblies
			.SelectMany(assembly => assembly.DefinedTypes)
			.Where(type => type.FullName != "Microsoft.CodeAnalysis.ExternalAccess.Pythia.PythiaSignatureHelpProvider")
			.Select(type => type.AsType());
		return MefHostServices.Create(new System.Composition.Hosting.ContainerConfiguration().WithParts(parts).CreateContainer());
	}
}

/// <summary>
/// The assemblies a code document compiles against, with their XML documentation — what dnSpy's
/// <c>RoslynDocumentationProviderFactory</c> pairs every metadata reference with.
/// </summary>
public static class ReferenceAssemblies {
	static readonly ConcurrentDictionary<string, MetadataReference> cache = new(StringComparer.Ordinal);
	static readonly Lazy<IReadOnlyList<string>> framework = new(FindFramework);

	/// <summary>The framework the host runs on: its reference pack when one is installed, else the runtime itself.</summary>
	public static IReadOnlyList<string> Framework => framework.Value;

	public static IReadOnlyList<MetadataReference> Create(IEnumerable<string> paths) {
		var references = new List<MetadataReference>();
		foreach (var path in paths.Distinct(StringComparer.OrdinalIgnoreCase)) {
			if (!File.Exists(path))
				continue;
			references.Add(cache.GetOrAdd(path, static p => MetadataReference.CreateFromFile(p, documentation: FindDocumentation(p))));
		}
		return references;
	}

	static DocumentationProvider? FindDocumentation(string assemblyPath) {
		var xml = Path.ChangeExtension(assemblyPath, ".xml");
		if (File.Exists(xml))
			return XmlDocumentationProvider.CreateFromFile(xml);
		// A localized copy sits in a culture directory beside the assembly when the English one is missing.
		var dir = Path.GetDirectoryName(assemblyPath);
		if (dir is not null) {
			foreach (var culture in new[] { System.Globalization.CultureInfo.CurrentUICulture.Name, System.Globalization.CultureInfo.CurrentUICulture.TwoLetterISOLanguageName }) {
				if (culture.Length == 0)
					continue;
				var localized = Path.Combine(dir, culture, Path.GetFileName(xml));
				if (File.Exists(localized))
					return XmlDocumentationProvider.CreateFromFile(localized);
			}
		}
		return null;
	}

	/// <summary>
	/// The runtime's assemblies have no XML documentation, and System.Private.CoreLib is not what a symbol's
	/// documentation is filed under, so a document compiles against the matching reference pack — the way a
	/// project would — whenever the SDK that installed this runtime left one behind.
	/// </summary>
	static IReadOnlyList<string> FindFramework() {
		var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location) ?? string.Empty;
		var version = Environment.Version;
		// <root>/shared/Microsoft.NETCore.App/<version>
		var root = Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(runtimeDir)));
		if (root is not null) {
			var packs = Path.Combine(root, "packs", "Microsoft.NETCore.App.Ref");
			if (Directory.Exists(packs)) {
				var tfm = $"net{version.Major}.{version.Minor}";
				var refDir = Directory.EnumerateDirectories(packs)
					.Select(dir => (dir, version: Version.TryParse(Path.GetFileName(dir).Split('-')[0], out var v) ? v : null))
					.Where(p => p.version is not null && p.version.Major == version.Major && p.version.Minor == version.Minor)
					.OrderByDescending(p => p.version)
					.Select(p => Path.Combine(p.dir, "ref", tfm))
					.FirstOrDefault(Directory.Exists);
				if (refDir is not null)
					return Directory.GetFiles(refDir, "*.dll");
			}
		}
		if (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") is string trusted)
			return trusted.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
				.Where(path => string.Equals(Path.GetDirectoryName(path)?.TrimEnd(Path.DirectorySeparatorChar), runtimeDir, StringComparison.Ordinal))
				.ToArray();
		return [];
	}
}
