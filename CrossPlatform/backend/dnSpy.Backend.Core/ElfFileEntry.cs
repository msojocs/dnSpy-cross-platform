namespace dnSpy.Backend.Core;

/// <summary>
/// An entry for a file that is an ELF image. Nothing on Linux makes one of these a managed assembly, so
/// there is nothing to edit or save about it — but its headers are worth reading, and this entry is what
/// the tree node and the document behind it are built from.
/// </summary>
internal sealed class ElfFileEntry : WorkspaceManager.IModuleEntry {
	public string Id { get; set; } = string.Empty;
	public string Path { get; }
	public ElfImage Elf { get; }
	public long FileLength => Elf.FileLength;

	/// <inheritdoc/>
	public long SavedHistoryId { get; set; }

	/// <inheritdoc/>
	public List<HexPatch> HexPatches { get; } = [];

	/// <inheritdoc/>
	public List<HexPatch> HexBase { get; } = [];

	public ElfFileEntry(string path, ElfImage elf) {
		Path = path;
		Elf = elf;
	}
}
