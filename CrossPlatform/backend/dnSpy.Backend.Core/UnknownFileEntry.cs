namespace dnSpy.Backend.Core;

/// <summary>
/// A file dnSpy could not read as a managed module, a PE image or an ELF image: a script, some other
/// binary format, a file that is not there any more. dnSpy keeps it open as an unknown document — the tree
/// shows it under its file name — so this entry carries the path the tree and the document need and
/// nothing else.
/// </summary>
internal sealed class UnknownFileEntry : WorkspaceManager.IModuleEntry {
	public string Id { get; set; } = string.Empty;
	public string Path { get; }
	public long FileLength { get; }

	/// <inheritdoc/>
	public long SavedHistoryId { get; set; }

	/// <inheritdoc/>
	public List<HexPatch> HexPatches { get; } = [];

	/// <inheritdoc/>
	public List<HexPatch> HexBase { get; } = [];

	public UnknownFileEntry(string path) {
		Path = path;
		FileLength = GetFileLength(path);
	}

	/// <summary>
	/// The file may well be gone, since a file that cannot be read is one reason to end up here, and dnSpy
	/// keeps the document open when it is. A missing file reports no length rather than throwing while the
	/// tree is being built.
	/// </summary>
	static long GetFileLength(string path) {
		try {
			return new FileInfo(path).Length;
		}
		catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) {
			return 0;
		}
	}
}
