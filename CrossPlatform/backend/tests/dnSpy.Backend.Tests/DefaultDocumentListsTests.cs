using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The lists Open List offers on its own. dnSpy's DotnetReferenceFileFinder makes one per shared framework
/// version of every .NET install, holding the managed DLLs of it; a fake install pins what goes in.
/// </summary>
public sealed class DefaultDocumentListsTests : IDisposable {
	readonly string root = Directory.CreateTempSubdirectory("dnspy-dotnet-").FullName;

	public void Dispose() => Directory.Delete(root, recursive: true);

	string AddFiles(string framework, string version, params string[] names) {
		var directory = Directory.CreateDirectory(Path.Combine(root, "shared", framework, version)).FullName;
		foreach (var name in names)
			File.WriteAllBytes(Path.Combine(directory, name), []);
		return directory;
	}

	[Fact]
	public void ListsEachSharedFrameworkVersionWithItsManagedFiles() {
		var directory = AddFiles("Microsoft.NETCore.App", "10.0.2",
			"System.Runtime.dll", "mscorlib.dll", "netstandard.dll", "System.Linq.dll",
			// Native libraries and the two native DLLs dnSpy names stay out, and so does anything not a DLL.
			"libcoreclr.so", "libclrjit.so", "Microsoft.DiaSymReader.Native.amd64.dll", "createdump", "System.Runtime.xml");
		AddFiles("Microsoft.AspNetCore.App", "10.0.2", "Microsoft.AspNetCore.dll");
		// A directory that is no framework version, such as a runtime's leftover, is passed over.
		AddFiles("Microsoft.NETCore.App", "current", "System.Runtime.dll");

		var lists = DefaultDocumentLists.FindIn([root, root + Path.DirectorySeparatorChar]);

		Assert.Equal(2, lists.Count);
		var core = Assert.Single(lists, list => list.Name.StartsWith("Microsoft.NETCore.App 10.0.2 (", StringComparison.Ordinal));
		Assert.Equal(["mscorlib.dll", "netstandard.dll", "System.Linq.dll", "System.Runtime.dll"], core.Files.Select(Path.GetFileName));
		Assert.All(core.Files, file => Assert.Equal(directory, Path.GetDirectoryName(file)));
		Assert.Contains(lists, list => list.Name.StartsWith("Microsoft.AspNetCore.App 10.0.2 (", StringComparison.Ordinal));
	}

	[Fact]
	public void AnInstallWithoutASharedDirectoryHasNoLists() =>
		Assert.Empty(DefaultDocumentLists.FindIn([root, Path.Combine(root, "missing")]));
}
