namespace dnSpy.Backend.Core;

/// <summary>
/// One in-place byte patch: the bytes written at <paramref name="Offset"/> in the file the reader
/// saw, and what that offset is measured from. It never changes the file's length.
/// </summary>
internal sealed record HexPatch(string NodeId, long Offset, byte[] After, HexPatchTarget Target);

/// <summary>
/// What a hex patch is aimed at. dnSpy keeps a hex-edited file in a document of its own, so its
/// patches never have to survive a rewrite of the module that produced it; here the two share a
/// document, and keeping the member alongside the offset is what lets a patch be written to the
/// right place in a file dnlib laid out afresh.
/// </summary>
internal abstract record HexPatchTarget {
	public static readonly HexPatchTarget Raw = new RawTarget();

	/// <summary>A patch on nothing in particular, whose offset only means anything against the layout it was read with.</summary>
	public sealed record RawTarget : HexPatchTarget;

	/// <summary>Relative to the start of a method's body, header included.</summary>
	public sealed record MethodBody(uint Token, long Delta) : HexPatchTarget;

	/// <summary>Relative to the start of a field's initial value.</summary>
	public sealed record FieldInitialValue(uint Token, long Delta) : HexPatchTarget;

	/// <summary>Relative to the start of an embedded resource's data.</summary>
	public sealed record Resource(string Name, long Delta) : HexPatchTarget;
}

/// <summary>
/// The patches of one file — dnSpy's HexBuffer edits, kept beside the file instead of in a copy of it.
/// Every kind of document the tree holds can carry them: a native PE image, an ELF image and a file
/// nothing could read are edited byte-wise the way dnSpy's hex editor edits any file it opens.
/// </summary>
internal static class HexPatchList {
	/// <summary>Records a patch on nothing but its offset and hands back the undo.</summary>
	public static Action ApplyRaw(List<HexPatch> patches, string nodeId, long offset, byte[] data) {
		var patch = new HexPatch(nodeId, offset, data, HexPatchTarget.Raw);
		patches.Add(patch);
		return () => patches.Remove(patch);
	}

	/// <summary>The document's bytes over a range of its file: what the file held before a save wrote patches into
	/// it, then the patches.</summary>
	public static void Overlay(WorkspaceManager.IModuleEntry entry, long offset, byte[] buffer) {
		Overlay(entry.HexBase, offset, buffer);
		Overlay(entry.HexPatches, offset, buffer);
	}

	/// <summary>
	/// Before a save writes the patches into the file itself: what the file holds at each patched place, read as the
	/// document reads it, becomes part of its base — so undoing a patch afterwards still shows the bytes it replaced.
	/// </summary>
	public static void Rebase(WorkspaceManager.IModuleEntry entry, Stream file) {
		var added = new List<HexPatch>();
		foreach (var patch in entry.HexPatches) {
			var before = new byte[patch.After.Length];
			file.Position = patch.Offset;
			file.ReadExactly(before);
			Overlay(entry.HexBase, patch.Offset, before);
			added.Add(patch with { After = before, Target = HexPatchTarget.Raw });
		}
		entry.HexBase.AddRange(added);
	}

	/// <summary>Copies the patches that fall inside the range into <paramref name="buffer"/>, the later ones over
	/// the earlier ones, which is the order they were written in.</summary>
	public static void Overlay(IReadOnlyList<HexPatch> patches, long offset, byte[] buffer) {
		foreach (var patch in patches) {
			var start = Math.Max(patch.Offset, offset);
			var end = Math.Min(patch.Offset + patch.After.Length, offset + buffer.Length);
			for (var i = start; i < end; i++)
				buffer[i - offset] = patch.After[i - patch.Offset];
		}
	}
}
