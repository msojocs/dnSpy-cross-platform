using System.Globalization;
using System.Text;
using System.Xml;
using dnlib.DotNet;
using dnlib.DotNet.Emit;
using dnlib.DotNet.Resources;
using dnlib.IO;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.Output;
using ICSharpCode.BamlDecompiler;

namespace dnSpy.Backend.Core;

public sealed partial class WorkspaceManager {
	sealed partial class Workspace {
		/// <summary>The value of a .resources entry row: the entry, and the embedded resource it was read from.</summary>
		sealed record ResourceEntryValue(EmbeddedResource Owner, ResourceElement Element) {
			public string Name => Element.Name;
		}

		/// <summary>
		/// Which of dnSpy's resource nodes a resource or an entry becomes — the first of its node providers that
		/// takes it, in the order DocumentTreeViewConstants gives them: a .resources file (by its magic number,
		/// not its name), an image (by extension or magic number), a serialized System.Drawing image, BAML, an
		/// ImageListStreamer, another serialized object, and the built-in kinds or an unknown file last.
		/// </summary>
		enum ResourceShape {
			ResourceSet,
			Image,
			SerializedImage,
			Baml,
			ImageList,
			UnknownSerialized,
			BuiltIn,
			Unknown,
		}

		static ResourceShape ShapeOf(Resource resource) {
			if (resource is not EmbeddedResource embedded)
				return ResourceShape.Unknown;
			var reader = embedded.CreateReader();
			if (ResourceReader.CouldBeResourcesFile(reader))
				return ResourceShape.ResourceSet;
			return CouldBeImage(embedded.Name, embedded.CreateReader().ToArray()) ? ResourceShape.Image : ResourceShape.Unknown;
		}

		static ResourceShape ShapeOf(ResourceElement element) {
			switch (element.ResourceData) {
				case BuiltInResourceData { Code: ResourceTypeCode.ByteArray or ResourceTypeCode.Stream, Data: byte[] data }:
					if (CouldBeImage(element.Name, data))
						return ResourceShape.Image;
					return IsBaml(data) ? ResourceShape.Baml : ResourceShape.BuiltIn;
				case BinaryResourceData binary:
					if (ImageResources.GetImageData(binary) is not null)
						return ResourceShape.SerializedImage;
					// SerializedImageListStreamerResourceElementNodeProvider takes the entry only when its "Data"
					// field can be read out of it; any other ImageListStreamer is just another serialized object.
					return ImageResources.GetImageListStreamerData(binary) is not null ? ResourceShape.ImageList : ResourceShape.UnknownSerialized;
				default:
					return ResourceShape.BuiltIn;
			}
		}

		static readonly string[] ImageExtensions = [".png", ".gif", ".bmp", ".dib", ".jpg", ".jpeg", ".jpe", ".jif", ".jfif", ".jfi", ".ico", ".cur"];

		/// <summary>dnSpy's ImageResourceNodeProvider.CouldBeImage: an image file extension, or the header of a
		/// BMP, GIF, PNG, ICO or CUR file. A JPEG file is known by its extension only.</summary>
		static bool CouldBeImage(string name, byte[] data) {
			foreach (var extension in ImageExtensions) {
				if (name.EndsWith(extension, StringComparison.OrdinalIgnoreCase))
					return true;
			}
			return ImageMimeType(data) is { } mime && mime != "image/jpeg";
		}

		/// <summary>The image format a file's header names, as a MIME type, or null when it names none. JPEG has
		/// no check in dnSpy's provider — it goes by extension — but a browser needs to be told what it gets.</summary>
		static string? ImageMimeType(byte[] data) {
			if (data.Length < 0x16)
				return data.Length >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF ? "image/jpeg" : null;
			var magic = BitConverter.ToUInt32(data, 0);
			if ((ushort)magic == 0x4D42) {
				var size = BitConverter.ToUInt32(data, 2);
				var offset = BitConverter.ToUInt32(data, 10);
				return size <= data.Length && offset < size ? "image/bmp" : null;
			}
			if (magic == 0x38464947) {
				var version = BitConverter.ToUInt16(data, 4);
				return version is 0x6139 or 0x6137 ? "image/gif" : null;
			}
			if (magic == 0x474E5089)
				return BitConverter.ToUInt32(data, 4) == 0x0A1A0A0D ? "image/png" : null;
			if (magic is 0x00010000 or 0x00020000) {
				int count = BitConverter.ToUInt16(data, 4);
				if (count <= 0)
					return null;
				var size = BitConverter.ToUInt32(data, 14);
				var offset = BitConverter.ToUInt32(data, 18);
				var end = unchecked(offset + size);
				return offset <= end && end <= data.Length ? "image/x-icon" : null;
			}
			if (data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF)
				return "image/jpeg";
			return null;
		}

		/// <summary>BamlReader.IsBamlHeader: a length-prefixed UTF-16 "MSBAML".</summary>
		static bool IsBaml(byte[] data) {
			const string signature = "MSBAML";
			if (data.Length < 4 + signature.Length * 2)
				return false;
			if (BitConverter.ToUInt32(data, 0) >> 1 != signature.Length)
				return false;
			return Encoding.Unicode.GetString(data, 4, signature.Length * 2) == signature;
		}

		/// <summary>The Resources folder, sorted the way dnSpy's ResourceTreeNodeGroup sorts it: by name, then by
		/// the manifest resource's row.</summary>
		IReadOnlyList<NodeEntry> GetResourceChildren(NodeEntry node) => ((ModuleDefMD)node.Value)
			.Resources
			.OrderBy(resource => resource.Name.String, StringComparer.OrdinalIgnoreCase)
			.ThenBy(resource => resource.MDToken.Raw)
			.Select(resource => GetOrAddNode(ResourceKey(node.AsModuleEntry!, resource), NodeKind.Resource, resource, node.Module))
			.ToArray();

		/// <summary>
		/// The key a resource row is known by. It names the resource rather than its place in the sorted
		/// list, so adding or deleting a resource does not renumber the rows around it — the row keeps the
		/// id a tab or a selection is holding.
		/// </summary>
		static string ResourceKey(ModuleEntry module, Resource resource) => ResourceKey(module, resource.Name.String);
		static string ResourceKey(ModuleEntry module, string name) => $"resource:{module.Path}:{name}";

		/// <summary>
		/// The entries of a .resources file, read with dnlib's resource reader — which decodes the built-in
		/// types and keeps every serialized object as the bytes it is, so nothing is instantiated to list them.
		/// Sorted the way dnSpy's ResourceElementTreeNodeGroup sorts them: by name, then by type code.
		/// </summary>
		IReadOnlyList<NodeEntry> GetEmbeddedResourceChildren(NodeEntry node) {
			if (node.Value is not EmbeddedResource embedded || ShapeOf(embedded) != ResourceShape.ResourceSet)
				return [];
			var set = ResourceReader.Read(node.AsModuleEntry!.Module, embedded.CreateReader());
			return set.ResourceElements
				.OrderBy(element => element.Name, StringComparer.OrdinalIgnoreCase)
				.ThenBy(element => (int)FixUserType(element.ResourceData.Code))
				.Select(element => GetOrAddNode(ResourceEntryKey(node.AsModuleEntry!, embedded, element.Name), NodeKind.ResourceEntry, new ResourceEntryValue(embedded, element), node.Module))
				.ToArray();
		}

		static ResourceTypeCode FixUserType(ResourceTypeCode code) => code < ResourceTypeCode.UserTypes ? code : ResourceTypeCode.UserTypes;

		static string ResourceEntryKey(ModuleEntry module, EmbeddedResource resource, string name) => $"resource-entry:{module.Path}:{resource.Name}:{name}";

		/// <summary>ResourceUtilities.TryGetImageReference: the image a name's extension picks.</summary>
		static string? ImageByExtension(string name) {
			var dot = name.LastIndexOf('.');
			return dot < 0 ? null : name[(dot + 1)..].ToUpperInvariant() switch {
				"CS" or "CSX" => "CSFileNode",
				"VB" or "VBX" => "VBFileNode",
				"TXT" => "TextFile",
				"XAML" or "BAML" => "WPFFile",
				"XML" => "XMLFile",
				"XSD" => "XMLSchema",
				"XSLT" => "XSLTransform",
				_ => null,
			};
		}

		static string ResourceIcon(NodeEntry node) {
			if (node.Value is ResourceEntryValue entry) {
				return ShapeOf(entry.Element) switch {
					ResourceShape.Image or ResourceShape.SerializedImage or ResourceShape.ImageList => "Image",
					ResourceShape.Baml => "WPFFile",
					ResourceShape.UnknownSerialized => "UserDefinedDataType",
					_ => entry.Element.ResourceData.Code == ResourceTypeCode.String ? "String"
						: entry.Element.ResourceData.Code >= ResourceTypeCode.UserTypes ? "UserDefinedDataType"
						: ImageByExtension(entry.Name) ?? "Binary",
				};
			}
			var resource = (Resource)node.Value;
			return ShapeOf(resource) switch {
				ResourceShape.ResourceSet => "SourceFileGroup",
				ResourceShape.Image => "Image",
				_ => ImageByExtension(resource.Name) ?? "Dialog",
			};
		}

		static string ResourceLabel(NodeEntry node) => node.Value switch {
			ResourceEntryValue entry => UnescapeName(entry.Name),
			Resource resource => resource.Name.String,
			_ => string.Empty,
		};

		static string UnescapeName(string name) {
			try {
				return Uri.UnescapeDataString(name);
			}
			catch (UriFormatException) {
				return name;
			}
		}

		/// <summary>A resource row's tooltip: its name, the resource an entry was read from, and the module's file.</summary>
		string ResourceToolTip(NodeEntry node) => node.Value is ResourceEntryValue entry
			? Lines(UnescapeName(entry.Name), entry.Owner.Name.String, (node.Module as IModuleEntry)?.Path)
			: Lines(ResourceLabel(node), (node.Module as IModuleEntry)?.Path);

		/// <summary>
		/// A resource's line without the comment syntax and the offset — ResourceNode.WriteShort: the escaped name,
		/// then its size or where it lives, its kind and its attributes — "name (1234 bytes, Embedded, Public)".
		/// </summary>
		static string DescribeResource(Resource resource) => IdentifierEscaper.Escape(resource.Name) + ResourceLineTail(resource);

		/// <summary>What ResourceNode.WriteShort writes after a resource's name.</summary>
		static string ResourceLineTail(Resource resource) {
			var extra = resource switch {
				EmbeddedResource embedded => string.Format(CultureInfo.CurrentCulture, "{0} bytes", embedded.Length),
				AssemblyLinkedResource linked => linked.Assembly?.FullName,
				LinkedResource linked => $"{linked.File?.Name}, {(linked.File?.ContainsNoMetadata == true ? "ContainsNoMetaData" : "ContainsMetaData")}, {SimpleTypeConverter.ByteArrayToString(linked.File?.HashValue)}",
				_ => null,
			};
			return $" ({(extra is null ? string.Empty : $"{extra}, ")}{resource.ResourceType}, {resource.Attributes})";
		}

		/// <summary>
		/// ResourceElementNode.ValueString: what an entry is, after its name and an equals sign — written the way
		/// dnSpy's SimpleTypeConverter writes a value: a string or a char quoted and escaped, an integer in hex above 9,
		/// an array by its length and a serialized object by its length and its type.
		/// </summary>
		static string EntryValueString(ResourceElement element) {
			var data = element.ResourceData;
			if (data is BuiltInResourceData builtIn) {
				var value = builtIn.Data;
				return builtIn.Code switch {
					ResourceTypeCode.Null => "null",
					ResourceTypeCode.String => SimpleTypeConverter.ToString((string)value, false),
					ResourceTypeCode.Boolean => SimpleTypeConverter.ToString((bool)value),
					ResourceTypeCode.Char => SimpleTypeConverter.ToString((char)value),
					ResourceTypeCode.Byte => SimpleTypeConverter.ToString((byte)value),
					ResourceTypeCode.SByte => SimpleTypeConverter.ToString((sbyte)value),
					ResourceTypeCode.Int16 => SimpleTypeConverter.ToString((short)value),
					ResourceTypeCode.UInt16 => SimpleTypeConverter.ToString((ushort)value),
					ResourceTypeCode.Int32 => SimpleTypeConverter.ToString((int)value),
					ResourceTypeCode.UInt32 => SimpleTypeConverter.ToString((uint)value),
					ResourceTypeCode.Int64 => SimpleTypeConverter.ToString((long)value),
					ResourceTypeCode.UInt64 => SimpleTypeConverter.ToString((ulong)value),
					ResourceTypeCode.Single => SimpleTypeConverter.ToString((float)value),
					ResourceTypeCode.Double => SimpleTypeConverter.ToString((double)value),
					ResourceTypeCode.Decimal => SimpleTypeConverter.ToString((decimal)value),
					ResourceTypeCode.DateTime => SimpleTypeConverter.ToString((DateTime)value),
					ResourceTypeCode.TimeSpan => SimpleTypeConverter.ToString((TimeSpan)value),
					ResourceTypeCode.ByteArray or ResourceTypeCode.Stream => string.Format(CultureInfo.CurrentCulture, "{0} bytes", ((byte[])value).Length),
					_ => data.ToString() ?? string.Empty,
				};
			}
			if (data is BinaryResourceData binary)
				return string.Format(CultureInfo.CurrentCulture, "{0} bytes, Type = {1}", binary.Data.Length, binary.TypeName);
			return data.ToString() ?? string.Empty;
		}

		/// <summary>An entry's line without the comment syntax and the offset — ResourceElementNode.WriteShort.</summary>
		static string DescribeResourceEntry(ResourceEntryValue value) => $"{IdentifierEscaper.Escape(value.Name)} = {IdentifierEscaper.Truncate(EntryValueString(value.Element), 50000)}";

		// An image attachment travels base64 inside one JSON-RPC message, which the host bounds at 32 MB; a 16 MB
		// picture and the document it rides with still fit. WPF itself has no limit — it reads the picture from
		// memory — so this is the transport's bound, not the viewer's.
		const int MaxAttachedImageLength = 16 * 1024 * 1024;

		/// <summary>
		/// The document a resource row shows — NodeDecompiler for a resource node. A row that can show itself
		/// does (IDecompileSelf): text is shown as text, BAML as XAML. Everything else writes its WriteShort line —
		/// with the picture an image holds, the Save button under a resource's line — and a .resources file adds
		/// the line of every entry it holds (see WorkspaceManager.ResourceDocuments.cs).
		/// </summary>
		/// <remarks><paramref name="writeShort"/> asks for the resource's short form alone (ResourceNode.WriteShort), the
		/// way NodeDecompiler writes a resource into the Resources folder's document or a tab of several nodes: a row
		/// that would show itself writes its line instead.</remarks>
		DecompileResponse DecompileResource(NodeEntry node, DecompilerLanguage language, DecompilerSettingsDto? settings, CancellationToken cancellationToken, bool writeShort = false) {
			var title = GetLabel(node);
			var output = new ResourceDocumentOutput(language, settings);
			if (node.Value is ResourceEntryValue value) {
				var shape = ShapeOf(value.Element);
				if (!writeShort && shape == ResourceShape.Baml)
					return DecompileBaml(node, value, settings?.Baml, language, cancellationToken);
				if (!writeShort && shape == ResourceShape.BuiltIn && value.Element.ResourceData is BuiltInResourceData builtIn) {
					if (builtIn.Code == ResourceTypeCode.String)
						return new DecompileResponse(title, "plaintext", (string)builtIn.Data, [], []);
					if (builtIn.Code is ResourceTypeCode.ByteArray or ResourceTypeCode.Stream && TextDocument(title, value.Name, (byte[])builtIn.Data) is { } textDocument)
						return textDocument;
				}
				WriteResourceEntry(output, node);
			}
			else {
				var resource = (Resource)node.Value;
				if (!writeShort && ShapeOf(resource) == ResourceShape.Unknown && resource is EmbeddedResource textual && TextDocument(title, resource.Name, ReadResourceBytes(textual)) is { } textDocument)
					return textDocument;
				WriteResourceNode(output, node, cancellationToken);
			}
			return output.ToResponse(title);
		}

		/// <summary>
		/// ResourceUtilities.Decompile: data of at most 500 KB that GuessFileType reads as text is shown as text —
		/// as XML when it parses as XML, otherwise in the language its extension names. Anything else is not text.
		/// </summary>
		static DecompileResponse? TextDocument(string title, string name, byte[] data) {
			if (data.Length > 500 * 1024 || Search.ResourceTexts.TryGetString(data) is not { } content)
				return null;
			var language = IsXml(content) ? "xml" : GuessResourceLanguage(name);
			return new DecompileResponse(title, language, content, [], []);
		}

		static bool IsXml(string content) {
			try {
				using var reader = XmlReader.Create(new StringReader(content), new XmlReaderSettings { XmlResolver = null, DtdProcessing = DtdProcessing.Ignore });
				reader.MoveToContent();
				return true;
			}
			catch (XmlException) {
				return false;
			}
		}

		/// <summary>
		/// ContentTypesHelper.TryGetContentTypeStringByExtension over the cleaned name's extension: the languages dnSpy
		/// has a viewer for, and plain text for any other file.
		/// </summary>
		static string GuessResourceLanguage(string name) {
			string extension;
			try {
				extension = Path.GetExtension(CleanName(name));
			}
			catch (ArgumentException) {
				extension = ".txt";
			}
			return extension.ToUpperInvariant() switch {
				".XAML" or ".XML" => "xml",
				".CS" or ".CSX" => "csharp",
				".VB" or ".VBX" => "visual-basic",
				".IL" => "il",
				_ => "plaintext",
			};
		}

		/// <summary>
		/// BamlResourceElementNode.Decompile: with Disassemble BAML on, the BAML's records (dnSpy's BamlDnSpy content
		/// type, language <c>baml</c>); otherwise the XAML it decompiles to, written the way the BAML page asks
		/// (XamlOutputCreator; dnSpy's Xaml content type, language <c>xaml</c>).
		/// </summary>
		DecompileResponse DecompileBaml(NodeEntry node, ResourceEntryValue value, BamlDecompilerSettingsDto? settings, DecompilerLanguage language, CancellationToken cancellationToken) {
			var title = GetLabel(node);
			var baml = (byte[])((BuiltInResourceData)value.Element.ResourceData).Data;
			if (settings?.DisassembleBaml == true) {
				try {
					var output = DisassembleBaml(node.AsModuleEntry!, baml, language, cancellationToken);
					return output.ToResponse(title, "baml", null);
				}
				catch (Exception ex) when (ex is not OperationCanceledException) {
					return new DecompileResponse(title, "baml", string.Empty, [], [new DiagnosticDto("error", ex.Message)]);
				}
			}
			try {
				return new DecompileResponse(title, "xaml", DecompileBamlToXaml(node.AsModuleEntry!, baml, settings, cancellationToken), [], []);
			}
			catch (Exception ex) when (ex is not OperationCanceledException) {
				return new DecompileResponse(title, "xaml", string.Empty, [], [new DiagnosticDto("error", ex.Message)]);
			}
		}

		/// <summary>
		/// dnSpy's BamlDisassembler over the BAML's records, every write in the color it was written in. An id a record
		/// defines and the records that use it are tied together inside the document, and hovering one shows what it
		/// names (dnSpy's BamlDocumentViewerToolTipProvider, in the document's language).
		/// </summary>
		DocumentOutput DisassembleBaml(ModuleEntry module, byte[] baml, DecompilerLanguage language, CancellationToken cancellationToken) {
			var host = new AnalyzerHost(this, null, loadOnDemand: false);
			var toolTips = new Baml.BamlToolTipProvider(language, TypeColor);
			var output = new DocumentOutput((reference, flags, color, start, length) => ILSpanOf(module, host, reference, flags, color, start, length), toolTips.Create) { ColorsEveryWrite = true };
			Baml.BamlDisassemblerEntry.Disassemble(module.Module, baml, output, cancellationToken);
			return output;
		}

		static string DecompileBamlToXaml(ModuleEntry module, byte[] baml, BamlDecompilerSettingsDto? settings, CancellationToken cancellationToken) {
			var decompiler = new XamlDecompiler(module.Path, new BamlDecompilerSettings { ThrowOnAssemblyResolveErrors = false }) {
				CancellationToken = cancellationToken,
			};
			using var stream = new MemoryStream(baml, writable: false);
			return XamlOutputCreator.CreateText(decompiler.Decompile(stream).Xaml, settings);
		}

		/// <summary>
		/// BamlResourceElementNode.GetFilename: a BAML entry saves as <c>.baml</c> when it is disassembled and as
		/// <c>.xaml</c> otherwise — the other one of the two extensions is replaced, any other name gets it added.
		/// </summary>
		static string BamlFileName(string name, bool disassemble) {
			var (otherExtension, targetExtension) = disassemble ? (".xaml", ".baml") : (".baml", ".xaml");
			if (name.EndsWith(otherExtension, StringComparison.OrdinalIgnoreCase))
				return name[..^otherExtension.Length] + targetExtension;
			if (name.EndsWith(targetExtension, StringComparison.OrdinalIgnoreCase))
				return name;
			return name + targetExtension;
		}

		/// <summary>
		/// The manifest resource's bytes as they sit in the module. They are read out of the in-memory module
		/// rather than off the file, so an edit that has not been saved yet is what gets saved.
		/// </summary>
		static byte[] ReadResourceBytes(EmbeddedResource resource) => resource.CreateReader().ToArray();

		/// <summary>
		/// The files the nodes save as — dnSpy's Save and Raw Save (SaveResources over IResourceDataProvider). A
		/// resources folder on its own stands for the resources in it.
		/// </summary>
		public ResourceItemsResponse GetResourceItems(IReadOnlyList<string> nodeIds, bool raw, CancellationToken cancellationToken, BamlDecompilerSettingsDto? baml = null) {
			var selected = nodeIds.Select(GetNode).ToList();
			if (selected is [{ Kind: NodeKind.ResourcesGroup } folder])
				selected = [.. GetResourceChildren(folder)];
			var items = new List<ResourceDataResponse>();
			foreach (var node in selected) {
				cancellationToken.ThrowIfCancellationRequested();
				foreach (var (name, data) in ResourceItems(node, raw, cancellationToken, baml))
					items.Add(new ResourceDataResponse(name, Convert.ToBase64String(data)));
			}
			return new ResourceItemsResponse(items);
		}

		/// <summary>
		/// The names the nodes save under, both ways, without reading what they hold — the headers of dnSpy's Save
		/// commands count these (SaveResourcesCommand.GetHeaderInternal), and the "use sub dirs" variants are only
		/// offered when there are several and one of them has a directory in it.
		/// </summary>
		public ResourceItemNamesResponse GetResourceItemNames(IReadOnlyList<string> nodeIds) {
			var selected = nodeIds.Select(GetNode).ToList();
			if (selected is [{ Kind: NodeKind.ResourcesGroup } folder])
				selected = [.. GetResourceChildren(folder)];
			return new ResourceItemNamesResponse(
				[.. selected.SelectMany(node => ResourceItemNames(node, raw: false))],
				[.. selected.SelectMany(node => ResourceItemNames(node, raw: true))]);
		}

		/// <summary>The names <see cref="ResourceItems"/> gives its files, item for item.</summary>
		IEnumerable<string> ResourceItemNames(NodeEntry node, bool raw) {
			switch (node.Value) {
				case ResourceEntryValue entry when raw:
					yield return entry.Name;
					break;
				case ResourceEntryValue entry:
					yield return DeserializedEntryName(entry);
					break;
				case EmbeddedResource resource when !raw && ShapeOf(resource) == ResourceShape.ResourceSet:
					foreach (var child in GetEmbeddedResourceChildren(node))
						yield return DeserializedEntryName((ResourceEntryValue)child.Value);
					break;
				case EmbeddedResource resource:
					yield return resource.Name.String;
					break;
			}
		}

		/// <summary>A BAML entry saves as the XAML it decompiles to; every other entry under its own name.</summary>
		static string DeserializedEntryName(ResourceEntryValue entry) =>
			ShapeOf(entry.Element) == ResourceShape.Baml ? Path.ChangeExtension(entry.Name, ".xaml") : entry.Name;

		IEnumerable<(string Name, byte[] Data)> ResourceItems(NodeEntry node, bool raw, CancellationToken cancellationToken, BamlDecompilerSettingsDto? baml = null) {
			switch (node.Value) {
				case ResourceEntryValue entry when raw:
					yield return (entry.Name, SerializedEntryBytes(entry.Element));
					break;
				case ResourceEntryValue entry:
					yield return DeserializedEntry(node, entry, cancellationToken, baml);
					break;
				case EmbeddedResource resource when !raw && ShapeOf(resource) == ResourceShape.ResourceSet:
					foreach (var child in GetEmbeddedResourceChildren(node))
						yield return DeserializedEntry(child, (ResourceEntryValue)child.Value, cancellationToken, baml);
					break;
				case EmbeddedResource resource:
					yield return (resource.Name.String, ReadResourceBytes(resource));
					break;
			}
		}

		/// <summary>
		/// An entry saved as its value: a string as UTF-8 text with a byte order mark (dnSpy writes it through a
		/// StreamWriter), bytes as they are, an image as its file, BAML as the XAML it decompiles to (its records, as
		/// .baml, with Disassemble BAML on), a serialized object as its serialized bytes and any other value as the
		/// text dnSpy shows for it.
		/// </summary>
		(string, byte[]) DeserializedEntry(NodeEntry node, ResourceEntryValue entry, CancellationToken cancellationToken, BamlDecompilerSettingsDto? baml = null) {
			var element = entry.Element;
			switch (ShapeOf(element)) {
				case ResourceShape.Baml:
					var bamlData = (byte[])((BuiltInResourceData)element.ResourceData).Data;
					var disassemble = baml?.DisassembleBaml == true;
					try {
						var text = disassemble
							? DisassembleBaml(node.AsModuleEntry!, bamlData, DecompilerLanguage.CSharp, cancellationToken).ToString()
							: DecompileBamlToXaml(node.AsModuleEntry!, bamlData, baml, cancellationToken);
						return (BamlFileName(entry.Name, disassemble), Utf8WithBom(text));
					}
					catch (Exception ex) when (ex is not OperationCanceledException) {
						return (entry.Name, (byte[])((BuiltInResourceData)element.ResourceData).Data);
					}
				case ResourceShape.SerializedImage:
					return (entry.Name, ImageResources.GetImageData((BinaryResourceData)element.ResourceData) ?? ((BinaryResourceData)element.ResourceData).Data);
				// SerializedImageListStreamerResourceElementNodeImpl saves the list's "Data" bytes, not the serialized object.
				case ResourceShape.ImageList:
					return (entry.Name, ImageResources.GetImageListStreamerData((BinaryResourceData)element.ResourceData)!);
			}
			return element.ResourceData switch {
				BuiltInResourceData { Code: ResourceTypeCode.Null } => (entry.Name, []),
				BuiltInResourceData { Code: ResourceTypeCode.String, Data: string text } => (entry.Name, Utf8WithBom(text)),
				BuiltInResourceData { Code: ResourceTypeCode.ByteArray or ResourceTypeCode.Stream, Data: byte[] bytes } => (entry.Name, bytes),
				BinaryResourceData binary => (entry.Name, binary.Data),
				_ => (entry.Name, Utf8WithBom(EntryValueString(element))),
			};
		}

		static byte[] Utf8WithBom(string text) => [.. Encoding.UTF8.GetPreamble(), .. Encoding.UTF8.GetBytes(text)];

		/// <summary>ResourceElementNode.GetSerializedData: an entry the way a resource writer stores it.</summary>
		static byte[] SerializedEntryBytes(ResourceElement element) {
			using var stream = new MemoryStream();
			using (var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: true)) {
				switch (element.ResourceData) {
					case BuiltInResourceData builtIn:
						switch (builtIn.Code) {
							case ResourceTypeCode.Null: break;
							case ResourceTypeCode.String: writer.Write((string)builtIn.Data); break;
							case ResourceTypeCode.Boolean: writer.Write((bool)builtIn.Data); break;
							case ResourceTypeCode.Char: writer.Write((ushort)(char)builtIn.Data); break;
							case ResourceTypeCode.Byte: writer.Write((byte)builtIn.Data); break;
							case ResourceTypeCode.SByte: writer.Write((sbyte)builtIn.Data); break;
							case ResourceTypeCode.Int16: writer.Write((short)builtIn.Data); break;
							case ResourceTypeCode.UInt16: writer.Write((ushort)builtIn.Data); break;
							case ResourceTypeCode.Int32: writer.Write((int)builtIn.Data); break;
							case ResourceTypeCode.UInt32: writer.Write((uint)builtIn.Data); break;
							case ResourceTypeCode.Int64: writer.Write((long)builtIn.Data); break;
							case ResourceTypeCode.UInt64: writer.Write((ulong)builtIn.Data); break;
							case ResourceTypeCode.Single: writer.Write((float)builtIn.Data); break;
							case ResourceTypeCode.Double: writer.Write((double)builtIn.Data); break;
							case ResourceTypeCode.Decimal: writer.Write((decimal)builtIn.Data); break;
							case ResourceTypeCode.DateTime: writer.Write(((DateTime)builtIn.Data).ToBinary()); break;
							case ResourceTypeCode.TimeSpan: writer.Write(((TimeSpan)builtIn.Data).Ticks); break;
							// The array's length is not written, only its bytes.
							case ResourceTypeCode.ByteArray or ResourceTypeCode.Stream: writer.Write((byte[])builtIn.Data); break;
						}
						break;
					case BinaryResourceData binary:
						writer.Write(binary.Data);
						break;
				}
			}
			return stream.ToArray();
		}

		/// <summary>
		/// The bytes a resource node holds, for the single-node Save Resource RPC — the first item of the same
		/// list Save writes, raw or not.
		/// </summary>
		public ResourceDataResponse GetResourceData(ResourceDataRequest request) {
			var node = GetNode(request.NodeId);
			if (node.Kind is not (NodeKind.Resource or NodeKind.ResourceEntry))
				throw new RpcException(ErrorCodes.InvalidParams, "The selected node is not a resource.");
			var (name, data) = ResourceItems(node, request.Raw, CancellationToken.None).FirstOrDefault();
			return name is null
				? throw new RpcException(ErrorCodes.InvalidParams, "The selected resource has no data in this module.")
				: new ResourceDataResponse(name, Convert.ToBase64String(data));
		}

		// ---------------------------------------------------------------- Go to Resource

		/// <summary>
		/// dnSpy's Go to Resource. A member of a strongly typed resources class — a getter-only property or a
		/// method whose body loads a name and asks the class's ResourceManager for it — leads to the entry of that
		/// name in the .resources file the ResourceManager is built over.
		/// </summary>
		public FindResourceResponse FindResource(FindResourceRequest request) {
			object? member = null;
			if (request.NodeId is not null)
				member = GetNode(request.NodeId).Value;
			else if (request.ModulePath is not null && request.MetadataToken is { } token && FindModuleEntry(request.ModulePath) is { } module) {
				try {
					member = module.Module.ResolveToken(unchecked((uint)token));
				}
				catch {
					member = null;
				}
			}
			if (ResourceReferenceOf(member) is not var (owner, fileName, resourceName) || ModuleEntryOf(owner) is not { } entry)
				return new FindResourceResponse(null);
			var moduleNode = GetOrAddNode($"module:{entry.Path}", NodeKind.Module, entry.Module, entry);
			var folder = GetOrAddNode($"{moduleNode.Key}:resources", NodeKind.ResourcesGroup, entry.Module, entry);
			var resource = GetResourceChildren(folder).FirstOrDefault(child => child.Value is EmbeddedResource embedded && embedded.Name == fileName && ShapeOf(embedded) == ResourceShape.ResourceSet);
			if (resource is null)
				return new FindResourceResponse(null);
			var element = GetEmbeddedResourceChildren(resource).FirstOrDefault(child => ((ResourceEntryValue)child.Value).Name == resourceName);
			return new FindResourceResponse(element?.Id);
		}

		/// <summary>ResourceRef.TryCreate: the declaring type, the .resources file and the entry a member reads.</summary>
		static (TypeDef, string, string)? ResourceReferenceOf(object? member) {
			if (member is PropertyDef property) {
				if (property.SetMethod is not null)
					return null;
				member = property.GetMethod;
			}
			if (member is not MethodDef { DeclaringType: { } type } method || !IsResourcesClass(type))
				return null;
			if (ResourceNameReadBy(method) is not { } resourceName || ResourcesFileName(type) is not { } fileName)
				return null;
			return (type, fileName, resourceName);
		}

		static bool IsResourcesClass(TypeDef type) {
			if (type.BaseType?.FullName != "System.Object" || type.Fields.Count != 2)
				return false;
			var hasCulture = false;
			var hasManager = false;
			foreach (var field in type.Fields) {
				if (!field.IsStatic)
					continue;
				var fieldType = field.FieldType?.FullName;
				hasCulture |= fieldType == "System.Globalization.CultureInfo";
				hasManager |= fieldType == "System.Resources.ResourceManager";
			}
			return hasCulture && hasManager;
		}

		/// <summary>The name the member's body loads before it asks the ResourceManager for an object, a stream
		/// or a string.</summary>
		static string? ResourceNameReadBy(MethodDef method) {
			if (method.Body is not { } body)
				return null;
			string? name = null;
			foreach (var instruction in body.Instructions) {
				if (instruction.OpCode.Code == Code.Ldstr) {
					name = instruction.Operand as string;
					continue;
				}
				if (instruction.OpCode.Code == Code.Callvirt && instruction.Operand is IMethod call
					&& call.Name.String is "GetObject" or "GetStream" or "GetString"
					&& call.DeclaringType?.FullName == "System.Resources.ResourceManager")
					return name;
			}
			return null;
		}

		/// <summary>
		/// The .resources file the class's ResourceManager reads: the base name its static getter passes to
		/// ResourceManager(string, Assembly[, Type]), or the type ResourceManager(Type) is given — which dnSpy
		/// never recognised, since it never kept the type its ldtoken loads.
		/// </summary>
		static string? ResourcesFileName(TypeDef type) {
			foreach (var method in type.Methods) {
				if (!method.IsStatic || method.MethodSig.GetParamCount() != 0 || method.MethodSig.GetRetType()?.FullName != "System.Resources.ResourceManager" || method.Body is not { } body)
					continue;
				string? baseName = null;
				ITypeDefOrRef? resourceType = null;
				foreach (var instruction in body.Instructions) {
					switch (instruction.OpCode.Code) {
						case Code.Ldstr:
							baseName = instruction.Operand as string;
							break;
						case Code.Ldtoken when instruction.Operand is ITypeDefOrRef loaded:
							resourceType = loaded;
							break;
						case Code.Newobj when instruction.Operand is IMethod constructor && constructor.DeclaringType?.FullName == "System.Resources.ResourceManager":
							var signature = constructor.FullName;
							if (signature == "System.Void System.Resources.ResourceManager::.ctor(System.Type)")
								return resourceType is null ? null : resourceType.ReflectionFullName + ".resources";
							if (signature is "System.Void System.Resources.ResourceManager::.ctor(System.String,System.Reflection.Assembly)"
								or "System.Void System.Resources.ResourceManager::.ctor(System.String,System.Reflection.Assembly,System.Type)")
								return baseName is null ? null : baseName + ".resources";
							break;
					}
				}
			}
			return null;
		}
	}
}
