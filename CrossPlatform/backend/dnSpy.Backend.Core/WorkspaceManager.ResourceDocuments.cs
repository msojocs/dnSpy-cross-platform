using dnlib.DotNet;
using dnlib.DotNet.Resources;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.Output;

namespace dnSpy.Backend.Core;

public sealed partial class WorkspaceManager {
	sealed partial class Workspace {
		/// <summary>
		/// dnSpy's <c>IDocumentViewerOutput</c> as a resource node's document writes to it: the text, in the comment
		/// syntax of the language the tab shows (C# and IL write <c>//</c>, Visual Basic <c>'</c>), and the WPF elements
		/// its <c>AddUIElement</c> and <c>AddButton</c> put into that text — an image, the images of an image list, a
		/// Save button. Those become attachments the viewer draws between the lines: dnSpy puts an element at a
		/// position on a line, the viewer puts it above that line.
		/// </summary>
		sealed class ResourceDocumentOutput : IDecompilerOutput {
			readonly DocumentOutput output = new();
			readonly List<DocumentAttachmentDto> attachments = [];
			// The 1-based line the next character lands on.
			int line = 1;

			public ResourceDocumentOutput(DecompilerLanguage language, DecompilerSettingsDto? settings) {
				Decompiler = language == DecompilerLanguage.VisualBasic ? DecompilerBase.VisualBasic : DecompilerBase.CSharp;
				LanguageName = language switch {
					DecompilerLanguage.VisualBasic => "visual-basic",
					DecompilerLanguage.IL or DecompilerLanguage.ILWithCSharp => "il",
					_ => "csharp",
				};
				// NodeDecompiler passes the decompiler's "Show tokens, RVAs and file offsets" option to WriteShort:
				// the C# settings' for C# and Visual Basic, the IL settings' for both IL languages.
				ShowOffset = language is DecompilerLanguage.IL or DecompilerLanguage.ILWithCSharp
					? (settings?.IL ?? new ILDecompilerSettingsDto()).ShowTokenAndRvaComments
					: (settings?.CSharp ?? new CSharpDecompilerSettingsDto()).ShowTokenAndRvaComments;
			}

			public DecompilerBase Decompiler { get; }

			/// <summary>Whether a line starts with the file offset of what it describes (WriteOffsetComment).</summary>
			public bool ShowOffset { get; }

			/// <summary>The language the document is highlighted in: the decompiler's own.</summary>
			public string LanguageName { get; }

			public int Length => output.Length;
			public int NextPosition => output.NextPosition;
			public void IncreaseIndent() => output.IncreaseIndent();
			public void DecreaseIndent() => output.DecreaseIndent();

			public void WriteLine() {
				output.WriteLine();
				line++;
			}

			public void Write(string text, object color) => Write(text, 0, text.Length, color);

			public void Write(string text, int index, int length, object color) {
				output.Write(text, index, length, color);
				CountLines(text, index, length);
			}

			public void Write(string text, object? reference, DecompilerReferenceFlags flags, object color) => Write(text, 0, text.Length, reference, flags, color);

			public void Write(string text, int index, int length, object? reference, DecompilerReferenceFlags flags, object color) {
				output.Write(text, index, length, reference, flags, color);
				CountLines(text, index, length);
			}

			public void AddBracePair(TextSpan start, TextSpan end, CodeBracesRangeFlags flags) => output.AddBracePair(start, end, flags);
			public void AddLineSeparator(int position) => output.AddLineSeparator(position);
			public void AddDebugInfo(MethodDebugInfo debugInfo) => output.AddDebugInfo(debugInfo);

			void CountLines(string text, int index, int length) {
				for (var i = index; i < index + length; i++) {
					if (text[i] == '\n')
						line++;
				}
			}

			/// <summary>AddUIElement with a WPF Image of the picture: the viewer shows it at its own size.</summary>
			public void AddImage(byte[]? data, string name) {
				if (data is null)
					return;
				// dnSpy hands the bytes to WPF, which reads any format WIC knows; a browser reads the formats the
				// MIME type names. A picture in another format WPF decodes — TIFF, mostly — is converted to PNG.
				var mime = ImageMimeType(data) ?? (HasJpegExtension(name) ? "image/jpeg" : null);
				if (mime is null && ImageResources.TryConvertToPng(data) is { } png) {
					data = png;
					mime = "image/png";
				}
				if (mime is not null && data.Length <= MaxAttachedImageLength)
					attachments.Add(new DocumentAttachmentDto(line - 1, DocumentAttachmentKinds.Image, Convert.ToBase64String(data), mime));
			}

			/// <summary>
			/// One AddUIElement per image of an ImageListStreamer, a space between two of them. The images are the
			/// list's "Data" bytes, which the viewer decodes the way WinForms' ImageList reads them.
			/// </summary>
			public void AddImageList(byte[] data) {
				if (data.Length <= MaxAttachedImageLength)
					attachments.Add(new DocumentAttachmentDto(line - 1, DocumentAttachmentKinds.ImageList, Convert.ToBase64String(data)));
			}

			/// <summary>AddButton(SaveResourceButton): saves the node the way the tree's Save command does.</summary>
			public void AddSaveButton(string nodeId) => attachments.Add(new DocumentAttachmentDto(line - 1, DocumentAttachmentKinds.SaveButton, NodeId: nodeId));

			public DecompileResponse ToResponse(string title) => output.ToResponse(title, LanguageName, null) with { Attachments = attachments };
		}

		static bool HasJpegExtension(string name) =>
			name.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".jpeg", StringComparison.OrdinalIgnoreCase)
			|| name.EndsWith(".jpe", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".jif", StringComparison.OrdinalIgnoreCase)
			|| name.EndsWith(".jfif", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".jfi", StringComparison.OrdinalIgnoreCase);

		/// <summary>
		/// NodeDecompiler.Decompile(ResourceNode): a .resources file writes its own line and then the line of every
		/// entry in it; any other resource writes its line. This is what a Resources folder's document writes for
		/// each resource in it, too.
		/// </summary>
		void WriteResourceNode(ResourceDocumentOutput output, NodeEntry node, CancellationToken cancellationToken) {
			var resource = (Resource)node.Value;
			var shape = ShapeOf(resource);
			// ImageResourceNodeImpl.WriteShort: the picture, then the line.
			if (shape == ResourceShape.Image)
				output.AddImage(ReadResourceBytes((EmbeddedResource)resource), resource.Name);
			WriteResourceLine(output, node, resource);
			// ResourceElementSetNodeImpl, ImageResourceNodeImpl and UnknownResourceNodeImpl (every resource but a
			// .resources file's entries) add a Save button under their line and leave a blank line after it.
			output.AddSaveButton(node.Id);
			output.WriteLine();
			output.WriteLine();
			if (shape == ResourceShape.ResourceSet) {
				foreach (var child in GetEmbeddedResourceChildren(node)) {
					cancellationToken.ThrowIfCancellationRequested();
					WriteResourceEntry(output, child);
				}
			}
		}

		/// <summary>
		/// ResourceNode.WriteShort: <c>// 0x00001234: name (123 bytes, Embedded, Public)</c> — the file offset when the
		/// option asks for it, the name as a definition, then what the resource is and where it lives.
		/// </summary>
		static void WriteResourceLine(ResourceDocumentOutput output, NodeEntry node, Resource resource) {
			output.Decompiler.WriteCommentBegin(output, true);
			if (resource is EmbeddedResource embedded)
				WriteOffsetComment(output, node, embedded.CreateReader().StartOffset, embedded.Length);
			output.Write(IdentifierEscaper.Escape(resource.Name), resource, DecompilerReferenceFlags.Local | DecompilerReferenceFlags.Definition, BoxedTextColor.Comment);
			output.Write(ResourceLineTail(resource), BoxedTextColor.Comment);
			DecompilerBase.WriteCommentEnd(output, true);
			output.WriteLine();
		}

		/// <summary>
		/// ResourceElementNode.WriteShort and the overrides of the image nodes: <c>// 0x00001234: name = value</c>, an
		/// image entry's picture with its name after it, the images of an image list before the line of the list.
		/// </summary>
		void WriteResourceEntry(ResourceDocumentOutput output, NodeEntry node) {
			var entry = (ResourceEntryValue)node.Value;
			var element = entry.Element;
			switch (ShapeOf(element)) {
			case ResourceShape.Image:
				// ImageResourceElementNodeImpl.WriteShort: the picture where the name would go, then " = " and the
				// name. (dnSpy ends the name with a left-to-right mark, which the viewer would draw as a box.)
				output.Decompiler.WriteCommentBegin(output, true);
				WriteEntryOffsetComment(output, node, entry);
				output.AddImage((byte[])((BuiltInResourceData)element.ResourceData).Data, entry.Name);
				output.Write(" = ", BoxedTextColor.Comment);
				output.Write(CleanName(entry.Name), entry, DecompilerReferenceFlags.Local | DecompilerReferenceFlags.Definition, BoxedTextColor.Comment);
				DecompilerBase.WriteCommentEnd(output, true);
				output.WriteLine();
				return;
			case ResourceShape.SerializedImage:
				output.AddImage(ImageResources.GetImageData((BinaryResourceData)element.ResourceData), entry.Name);
				break;
			case ResourceShape.ImageList:
				output.AddImageList(ImageResources.GetImageListStreamerData((BinaryResourceData)element.ResourceData)!);
				break;
			}
			output.Decompiler.WriteCommentBegin(output, true);
			WriteEntryOffsetComment(output, node, entry);
			output.Write(IdentifierEscaper.Escape(entry.Name), entry, DecompilerReferenceFlags.Local | DecompilerReferenceFlags.Definition, BoxedTextColor.Comment);
			output.Write($" = {IdentifierEscaper.Truncate(EntryValueString(element), 50000)}", BoxedTextColor.Comment);
			DecompilerBase.WriteCommentEnd(output, true);
			output.WriteLine();
		}

		// An entry's offset is where its data sits in the module's file. Once an edit has rewritten the .resources
		// file it lives in memory rather than in the file, and an offset into it would lead the hex editor astray.
		static void WriteEntryOffsetComment(ResourceDocumentOutput output, NodeEntry node, ResourceEntryValue entry) {
			if (entry.Owner.CreateReader().StartOffset == 0)
				return;
			var data = entry.Element.ResourceData;
			WriteOffsetComment(output, node, (uint)data.StartOffset, (uint)data.EndOffset - (uint)data.StartOffset);
		}

		/// <summary>
		/// ResourceUtilities.WriteOffsetComment: <c>0x00001234: </c>, the offset a reference the hex editor opens at.
		/// A resource that is not in the file (an offset of 0) has none.
		/// </summary>
		static void WriteOffsetComment(ResourceDocumentOutput output, NodeEntry node, uint fileOffset, uint length) {
			if (!output.ShowOffset || fileOffset == 0)
				return;
			var filename = (node.Module as IModuleEntry)?.Path;
			output.Write($"0x{fileOffset:X8}", new AddressReference(filename, false, fileOffset, length), DecompilerReferenceFlags.None, BoxedTextColor.Comment);
			output.Write(": ", BoxedTextColor.Comment);
		}

		/// <summary>NameUtilities.CleanName: at most 256 characters, a control character made '_'.</summary>
		static string CleanName(string name) {
			if (name.Length > 0x100)
				name = name[..0x100];
			return string.Create(name.Length, name, static (chars, source) => {
				for (var i = 0; i < source.Length; i++)
					chars[i] = source[i] < 0x20 ? '_' : source[i];
			});
		}
	}
}
