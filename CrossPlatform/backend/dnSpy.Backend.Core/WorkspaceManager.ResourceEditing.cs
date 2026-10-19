using System.Globalization;
using System.Resources.Extensions;
using dnlib.DotNet;
using dnlib.DotNet.Resources;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.Editing;

namespace dnSpy.Backend.Core;

/// <summary>
/// The resource half of dnSpy's AsmEditor: the Edit Resource window, the Create ... Resource commands,
/// and the element editor of a .resources file. Everything is queued through the ordinary edit
/// transaction, so a resource that is created, renamed or rewritten lands in the undo history.
/// </summary>
public sealed partial class WorkspaceManager {
	public Task<ResourceOptionsDto> GetResourceOptionsAsync(ResourceOptionsRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetResourceOptions(request.ResourceNodeId), cancellationToken);

	public Task QueueResourceOptionsAsync(SetResourceOptionsRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => {
			w.QueueResourceOptions(request);
			return true;
		}, cancellationToken);

	public Task<CreateResourceResponse> CreateResourceAsync(CreateResourceRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.QueueCreateResource(request), cancellationToken);

	public Task<ResourceElementOptionsDto> GetResourceElementOptionsAsync(ResourceElementOptionsRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetResourceElementOptions(request.NodeId), cancellationToken);

	public Task QueueResourceElementOptionsAsync(SetResourceElementOptionsRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => {
			w.QueueResourceElementOptions(request);
			return true;
		}, cancellationToken);

	public Task QueueCreateResourceElementAsync(CreateResourceElementRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => {
			w.QueueCreateResourceElement(request);
			return true;
		}, cancellationToken);

	sealed partial class Workspace {
		public ResourceOptionsDto GetResourceOptions(string resourceNodeId) {
			var node = GetNode(resourceNodeId);
			if (node.Value is not Resource resource)
				throw new RpcException(ErrorCodes.EditValidationFailed, "The selected item is not a resource.");
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support resource editing.");
			var attributes = CreateEditContext(moduleEntry).Attributes;
			return new ResourceOptionsDto(
				resource switch {
					AssemblyLinkedResource => ManifestResourceKinds.AssemblyLinked,
					LinkedResource => ManifestResourceKinds.Linked,
					_ => ManifestResourceKinds.Embedded,
				},
				resource.Name.String,
				(int)resource.Attributes,
				(resource as AssemblyLinkedResource)?.Assembly?.FullName,
				(resource as LinkedResource)?.File?.Name,
				(resource as LinkedResource)?.File?.ContainsNoMetadata == true,
				(resource as LinkedResource)?.File is { } file ? Convert.ToHexString(file.HashValue).ToLowerInvariant() : null,
				attributes.ToDtoList(resource.CustomAttributes),
				resource.Name.String);
		}

		public void QueueResourceOptions(SetResourceOptionsRequest request) {
			var transaction = GetTransaction(request.TransactionId);
			var node = GetNode(request.ResourceNodeId);
			if (node.Value is not Resource resource)
				throw new RpcException(ErrorCodes.EditValidationFailed, "The selected item is not a resource.");
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support resource editing.");
			var context = CreateEditContext(moduleEntry);
			if (string.IsNullOrWhiteSpace(request.Options.Name))
				throw new RpcException(ErrorCodes.EditValidationFailed, "The resource needs a name.");

			var oldAttributes = resource.Attributes;
			var oldName = resource.Name;
			var oldKey = node.Key;
			var newKey = ResourceKey(moduleEntry, request.Options.Name);
			var oldCustomAttributes = resource.CustomAttributes.ToArray();
			// The entries under the row name their file in their own keys, so they follow the rename too.
			var entryNodes = nodes.Values
				.Where(candidate => candidate.Value is ResourceEntryValue entry && ReferenceEquals(entry.Owner, resource))
				.Select(candidate => (Node: candidate, Key: candidate.Key, ((ResourceEntryValue)candidate.Value).Name, ((ResourceEntryValue)candidate.Value).Owner))
				.ToArray();
			var newAttributes = (ManifestResourceAttributes)request.Options.Attributes;
			var newName = new UTF8String(request.Options.Name);
			var customAttributes = context.Attributes.FromDtoList(request.Options.CustomAttributes).ToArray();
			AssemblyRef? assemblyRef = null;
			FileDef? fileDef = null;
			switch (resource) {
				case AssemblyLinkedResource:
					assemblyRef = ResolveAssemblyRef(moduleEntry.Module, request.Options.AssemblyFullName);
					break;
				case LinkedResource:
					fileDef = new FileDefUser(
						request.Options.LinkedFileName ?? throw new RpcException(ErrorCodes.EditValidationFailed, "A linked resource needs a file name."),
						request.Options.FileContainsNoMetadata ? dnlib.DotNet.FileAttributes.ContainsNoMetadata : dnlib.DotNet.FileAttributes.ContainsMetadata,
						ParseHash(request.Options.FileHash));
					break;
			}

			transaction.Add(node.Id, moduleEntry, () => {
				if (resource is AssemblyLinkedResource assemblyLinked)
					assemblyLinked.Assembly = assemblyRef!;
				else if (resource is LinkedResource linked)
					linked.File = fileDef!;
				nodeIdsByKey.Remove(oldKey);
				resource.Name = newName;
				node.Key = newKey;
				nodeIdsByKey[newKey] = node.Id;
				foreach (var entry in entryNodes) {
					nodeIdsByKey.Remove(entry.Key);
					entry.Node.Key = ResourceEntryKey(moduleEntry, resource as EmbeddedResource ?? entry.Owner, entry.Name);
					nodeIdsByKey[entry.Node.Key] = entry.Node.Id;
				}
				resource.Attributes = newAttributes;
				resource.CustomAttributes.Clear();
				foreach (var attribute in customAttributes)
					resource.CustomAttributes.Add(attribute);
				return () => {
					nodeIdsByKey.Remove(newKey);
					foreach (var entry in entryNodes) {
						nodeIdsByKey.Remove(entry.Node.Key);
						entry.Node.Key = entry.Key;
						nodeIdsByKey[entry.Key] = entry.Node.Id;
					}
					resource.Name = oldName;
					node.Key = oldKey;
					nodeIdsByKey[oldKey] = node.Id;
					resource.Attributes = oldAttributes;
					resource.CustomAttributes.Clear();
					foreach (var attribute in oldCustomAttributes)
						resource.CustomAttributes.Add(attribute);
				};
			});
		}

		static byte[] ParseHash(string? text) {
			if (string.IsNullOrWhiteSpace(text))
				return [];
			try {
				return Convert.FromHexString(text.Trim());
			}
			catch (FormatException ex) {
				throw new RpcException(ErrorCodes.EditValidationFailed, "The file hash is not hexadecimal.", null, ex);
			}
		}

		static AssemblyRef ResolveAssemblyRef(ModuleDef module, string? fullName) {
			if (string.IsNullOrWhiteSpace(fullName))
				throw new RpcException(ErrorCodes.EditValidationFailed, "An assembly-linked resource needs an assembly.");
			var existing = module.GetAssemblyRefs().FirstOrDefault(reference =>
				reference.FullName.Equals(fullName, StringComparison.OrdinalIgnoreCase) ||
				reference.Name.String.Equals(fullName, StringComparison.OrdinalIgnoreCase));
			if (existing is not null)
				return existing;
			try {
				return module.UpdateRowId(new AssemblyRefUser(new System.Reflection.AssemblyName(fullName)));
			}
			catch (Exception ex) when (ex is ArgumentException or FormatException) {
				throw new RpcException(ErrorCodes.EditValidationFailed, $"'{fullName}' is not an assembly name.", null, ex);
			}
		}

		public CreateResourceResponse QueueCreateResource(CreateResourceRequest request) {
			var transaction = GetTransaction(request.TransactionId);
			var owner = GetNode(request.OwnerNodeId);
			var moduleEntry = owner.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support creating resources.");
			if (string.IsNullOrWhiteSpace(request.Name))
				throw new RpcException(ErrorCodes.EditValidationFailed, "The resource needs a name.");
			var module = moduleEntry.Module;
			var attributes = (ManifestResourceAttributes)request.Attributes;
			Resource resource = request.Kind switch {
				ResourceCreateKinds.File => new EmbeddedResource(
					request.Name,
					Decode(request.Base64Data, "The resource data is not valid base64."),
					attributes),
				ResourceCreateKinds.MultiFile => new EmbeddedResource(
					request.Name,
					WriteResourceFile((request.Entries ?? []).Select(entry => new ResourceElement {
						Name = entry.Name,
						ResourceData = new BuiltInResourceData(ResourceTypeCode.ByteArray, Decode(entry.Base64Data, "A file's data is not valid base64.")),
					})),
					attributes),
				ResourceCreateKinds.ByteArray => new EmbeddedResource(
					request.Name,
					WriteResourceFile([Element(request.Name, new BuiltInResourceData(ResourceTypeCode.ByteArray, Decode(request.Base64Data, "The resource data is not valid base64.")))]),
					attributes),
				ResourceCreateKinds.Stream => new EmbeddedResource(
					request.Name,
					WriteResourceFile([Element(request.Name, new BuiltInResourceData(ResourceTypeCode.Stream, Decode(request.Base64Data, "The resource data is not valid base64.")))]),
					attributes),
				ResourceCreateKinds.String => new EmbeddedResource(
					request.Name,
					WriteResourceFile([Element(request.Name, new BuiltInResourceData(ResourceTypeCode.String, request.Text ?? string.Empty))]),
					attributes),
				ResourceCreateKinds.AssemblyLinked => new AssemblyLinkedResource(
					request.Name,
					ResolveAssemblyRef(module, request.AssemblyFullName),
					attributes),
				ResourceCreateKinds.FileLinked => new LinkedResource(
					request.Name,
					new FileDefUser(
						request.LinkedFileName ?? throw new RpcException(ErrorCodes.EditValidationFailed, "A file-linked resource needs a file name."),
						request.FileContainsNoMetadata ? dnlib.DotNet.FileAttributes.ContainsNoMetadata : dnlib.DotNet.FileAttributes.ContainsMetadata,
						[]),
					attributes),
				_ => throw new RpcException(ErrorCodes.EditValidationFailed, $"Unknown resource kind '{request.Kind}'."),
			};
			// A row id of its own, so the node that names it survives Undo and Redo.
			module.UpdateRowId(resource);
			var resourceNode = GetOrAddNode(ResourceKey(moduleEntry, resource), NodeKind.Resource, resource, moduleEntry);
			transaction.Add(owner.Id, moduleEntry, () => {
				module.Resources.Add(resource);
				return () => module.Resources.Remove(resource);
			});
			return new CreateResourceResponse(resourceNode.Id, resource.Name.String);
		}

		static byte[] Decode(string? base64, string message) {
			if (base64 is null)
				return [];
			try {
				return Convert.FromBase64String(base64);
			}
			catch (FormatException ex) {
				throw new RpcException(ErrorCodes.EditValidationFailed, message, null, ex);
			}
		}

		static ResourceElement Element(string name, IResourceData data) => new() { Name = name, ResourceData = data };

		public ResourceElementOptionsDto GetResourceElementOptions(string nodeId) {
			var node = GetNode(nodeId);
			if (node.Value is not ResourceEntryValue entry)
				throw new RpcException(ErrorCodes.EditValidationFailed, "The selected item is not a resource entry.");
			// dnSpy picks the window by the node a provider made for the entry: a byte array or stream holding an image
			// file, a serialized Bitmap or Icon whose image can be read, and an ImageListStreamer get windows of their own.
			if (entry.Element.ResourceData is BinaryResourceData serialized) {
				if (ImageResources.GetImageData(serialized) is { } image)
					return new ResourceElementOptionsDto(ResourceElementKinds.SerializedImage, UnescapeName(entry.Name), null, Convert.ToBase64String(image), (int)ResourceTypeCode.UserTypes, serialized.TypeName, DescribeResourceEntry(entry), SerializationFormat: serialized.Format.ToString());
				if (ImageResources.GetImageListStreamerData(serialized) is { } imageList)
					return new ResourceElementOptionsDto(ResourceElementKinds.ImageListStreamer, UnescapeName(entry.Name), null, Convert.ToBase64String(imageList), (int)ResourceTypeCode.UserTypes, serialized.TypeName, DescribeResourceEntry(entry), SerializationFormat: serialized.Format.ToString());
			}
			var (kind, text, bytes, code, typeName) = entry.Element.ResourceData switch {
				BuiltInResourceData builtIn => (KindOf(builtIn.Code), ValueText(builtIn), BytesOf(builtIn), (int)builtIn.Code, (string?)null),
				BinaryResourceData binary => (ResourceElementKinds.Binary, null, Convert.ToBase64String(binary.Data), (int)ResourceTypeCode.UserTypes, binary.TypeName),
				_ => (ResourceElementKinds.Binary, null, (string?)null, (int)ResourceTypeCode.UserTypes, (string?)null),
			};
			var isImage = entry.Element.ResourceData is BuiltInResourceData { Code: ResourceTypeCode.ByteArray or ResourceTypeCode.Stream, Data: byte[] data }
				&& ImageResources.CouldBeImage(entry.Name, data);
			return new ResourceElementOptionsDto(kind, UnescapeName(entry.Name), text, bytes, code, typeName, DescribeResourceEntry(entry), isImage);
		}

		static string KindOf(ResourceTypeCode code) => code switch {
			ResourceTypeCode.Null => ResourceElementKinds.Null,
			ResourceTypeCode.String => ResourceElementKinds.String,
			ResourceTypeCode.Boolean => ResourceElementKinds.Boolean,
			ResourceTypeCode.Char => ResourceElementKinds.Char,
			ResourceTypeCode.Byte => ResourceElementKinds.Byte,
			ResourceTypeCode.SByte => ResourceElementKinds.SByte,
			ResourceTypeCode.Int16 => ResourceElementKinds.Int16,
			ResourceTypeCode.UInt16 => ResourceElementKinds.UInt16,
			ResourceTypeCode.Int32 => ResourceElementKinds.Int32,
			ResourceTypeCode.UInt32 => ResourceElementKinds.UInt32,
			ResourceTypeCode.Int64 => ResourceElementKinds.Int64,
			ResourceTypeCode.UInt64 => ResourceElementKinds.UInt64,
			ResourceTypeCode.Single => ResourceElementKinds.Single,
			ResourceTypeCode.Double => ResourceElementKinds.Double,
			ResourceTypeCode.Decimal => ResourceElementKinds.Decimal,
			ResourceTypeCode.DateTime => ResourceElementKinds.DateTime,
			ResourceTypeCode.TimeSpan => ResourceElementKinds.TimeSpan,
			ResourceTypeCode.ByteArray => ResourceElementKinds.ByteArray,
			ResourceTypeCode.Stream => ResourceElementKinds.Stream,
			_ => ResourceElementKinds.Binary,
		};

		static string? ValueText(BuiltInResourceData data) => data.Code switch {
			ResourceTypeCode.String => data.Data as string,
			ResourceTypeCode.Boolean => (bool)data.Data! ? "true" : "false",
			ResourceTypeCode.Char => ((char)data.Data!).ToString(),
			ResourceTypeCode.DateTime => ((DateTime)data.Data!).ToString("o", CultureInfo.InvariantCulture),
			ResourceTypeCode.TimeSpan => ((TimeSpan)data.Data!).ToString("c", CultureInfo.InvariantCulture),
			ResourceTypeCode.Null or ResourceTypeCode.ByteArray or ResourceTypeCode.Stream => null,
			_ => Convert.ToString(data.Data, CultureInfo.InvariantCulture),
		};

		static string? BytesOf(BuiltInResourceData data) =>
			data.Code is ResourceTypeCode.ByteArray or ResourceTypeCode.Stream
				? Convert.ToBase64String((byte[])data.Data!)
				: null;

		public void QueueResourceElementOptions(SetResourceElementOptionsRequest request) {
			var transaction = GetTransaction(request.TransactionId);
			var node = GetNode(request.NodeId);
			if (node.Value is not ResourceEntryValue entry)
				throw new RpcException(ErrorCodes.EditValidationFailed, "The selected item is not a resource entry.");
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support resource editing.");
			if (string.IsNullOrWhiteSpace(request.Options.Name))
				throw new RpcException(ErrorCodes.EditValidationFailed, "The resource entry needs a name.");
			var replacement = CreateElement(request.Options);
			var resource = FindCurrentResource(moduleEntry, entry);
			if (!ResourceReader.Read(moduleEntry.Module, resource.CreateReader()).ResourceElements.Any(element => element.Name == entry.Name))
				throw new RpcException(ErrorCodes.EditValidationFailed, "The .resources file no longer holds this entry.");
			QueueReplaceResourceFile(transaction, node, moduleEntry, resource, elements => {
				var index = elements.FindIndex(element => element.Name == entry.Name);
				if (index < 0)
					throw new RpcException(ErrorCodes.EditValidationFailed, "The .resources file no longer holds this entry.");
				elements[index] = replacement;
				return replacement;
			});
		}

		public void QueueCreateResourceElement(CreateResourceElementRequest request) {
			var transaction = GetTransaction(request.TransactionId);
			var node = GetNode(request.ResourceNodeId);
			if (node.Value is not EmbeddedResource resource || ShapeOf(resource) != ResourceShape.ResourceSet)
				throw new RpcException(ErrorCodes.EditValidationFailed, "Only a .resources file can hold entries.");
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support resource editing.");
			var elements = ResourceReader.Read(moduleEntry.Module, resource.CreateReader()).ResourceElements.ToList();
			// dnSpy's Create System.Data.Bitmap/Icon Resource: every file picked becomes an entry, in one step.
			var created = request.Kind == ResourceElementKinds.ImageFiles
				? (request.Images ?? []).Select(image => ImageResources.CreateSerializedImage(image.Name, Decode(image.Base64Data, "An image file is not valid base64."))).ToList()
				: [CreateElement(new ResourceElementOptionsDto(request.Kind, request.Name, request.Text, request.Base64Data, 0, null))];
			if (created.Count == 0)
				throw new RpcException(ErrorCodes.EditValidationFailed, "Pick at least one image file.");
			void Check(IEnumerable<ResourceElement> existing) {
				foreach (var element in created) {
					if (string.IsNullOrWhiteSpace(element.Name))
						throw new RpcException(ErrorCodes.EditValidationFailed, "The resource entry needs a name.");
					if (existing.Any(other => other.Name == element.Name) || created.Count(other => other.Name == element.Name) > 1)
						throw new RpcException(ErrorCodes.EditValidationFailed, $"The .resources file already holds an entry named '{element.Name}'.");
				}
			}
			Check(elements);
			QueueReplaceResourceFile(transaction, node, moduleEntry, resource, current => {
				Check(current);
				current.AddRange(created);
				return created[0];
			});
		}

		static ResourceElement CreateElement(ResourceElementOptionsDto options) {
			// An image goes back as what it was: serialized in its own format — dnSpy's SerializedImageUtilities.Serialize.
			if (options.Kind == ResourceElementKinds.SerializedImage) {
				var format = Enum.TryParse<SerializationFormat>(options.SerializationFormat, out var parsed) ? parsed : SerializationFormat.BinaryFormatter;
				return ImageResources.Serialize(options.Name, Decode(options.Base64Data, "The image is not valid base64."), format);
			}
			if (options.Kind == ResourceElementKinds.ImageListStreamer)
				return ImageResources.SerializeImageListStreamer(options.Name, Decode(options.Base64Data, "The image list is not valid base64."));
			IResourceData data = options.Kind switch {
				ResourceElementKinds.Null => new BuiltInResourceData(ResourceTypeCode.Null, null),
				ResourceElementKinds.String => new BuiltInResourceData(ResourceTypeCode.String, options.Text ?? string.Empty),
				ResourceElementKinds.Boolean => new BuiltInResourceData(ResourceTypeCode.Boolean, bool.Parse(options.Text ?? "false")),
				ResourceElementKinds.Char => new BuiltInResourceData(ResourceTypeCode.Char, (options.Text ?? string.Empty).Length == 1 ? options.Text![0] : throw Invalid("A Char value is one character.")),
				ResourceElementKinds.Byte => new BuiltInResourceData(ResourceTypeCode.Byte, byte.Parse(options.Text ?? "0", CultureInfo.InvariantCulture)),
				ResourceElementKinds.SByte => new BuiltInResourceData(ResourceTypeCode.SByte, sbyte.Parse(options.Text ?? "0", CultureInfo.InvariantCulture)),
				ResourceElementKinds.Int16 => new BuiltInResourceData(ResourceTypeCode.Int16, short.Parse(options.Text ?? "0", CultureInfo.InvariantCulture)),
				ResourceElementKinds.UInt16 => new BuiltInResourceData(ResourceTypeCode.UInt16, ushort.Parse(options.Text ?? "0", CultureInfo.InvariantCulture)),
				ResourceElementKinds.Int32 => new BuiltInResourceData(ResourceTypeCode.Int32, int.Parse(options.Text ?? "0", CultureInfo.InvariantCulture)),
				ResourceElementKinds.UInt32 => new BuiltInResourceData(ResourceTypeCode.UInt32, uint.Parse(options.Text ?? "0", CultureInfo.InvariantCulture)),
				ResourceElementKinds.Int64 => new BuiltInResourceData(ResourceTypeCode.Int64, long.Parse(options.Text ?? "0", CultureInfo.InvariantCulture)),
				ResourceElementKinds.UInt64 => new BuiltInResourceData(ResourceTypeCode.UInt64, ulong.Parse(options.Text ?? "0", CultureInfo.InvariantCulture)),
				ResourceElementKinds.Single => new BuiltInResourceData(ResourceTypeCode.Single, float.Parse(options.Text ?? "0", CultureInfo.InvariantCulture)),
				ResourceElementKinds.Double => new BuiltInResourceData(ResourceTypeCode.Double, double.Parse(options.Text ?? "0", CultureInfo.InvariantCulture)),
				ResourceElementKinds.Decimal => new BuiltInResourceData(ResourceTypeCode.Decimal, decimal.Parse(options.Text ?? "0", CultureInfo.InvariantCulture)),
				ResourceElementKinds.DateTime => new BuiltInResourceData(ResourceTypeCode.DateTime, DateTime.Parse(options.Text ?? DateTime.MinValue.ToString("o", CultureInfo.InvariantCulture), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind)),
				ResourceElementKinds.TimeSpan => new BuiltInResourceData(ResourceTypeCode.TimeSpan, TimeSpan.Parse(options.Text ?? "00:00:00", CultureInfo.InvariantCulture)),
				ResourceElementKinds.ByteArray => new BuiltInResourceData(ResourceTypeCode.ByteArray, Decode(options.Base64Data, "The value is not valid base64.")),
				ResourceElementKinds.Stream => new BuiltInResourceData(ResourceTypeCode.Stream, Decode(options.Base64Data, "The value is not valid base64.")),
				ResourceElementKinds.Binary => new BinaryResourceData(
					new UserResourceType(options.TypeName ?? string.Empty, ResourceTypeCode.UserTypes),
					Decode(options.Base64Data, "The value is not valid base64."),
					SerializationFormat.BinaryFormatter),
				_ => throw Invalid($"Unknown resource element kind '{options.Kind}'."),
			};
			return new ResourceElement { Name = options.Name, ResourceData = data };
		}

		static RpcException Invalid(string message) => new(ErrorCodes.EditValidationFailed, message);

		EmbeddedResource FindCurrentResource(ModuleEntry moduleEntry, ResourceEntryValue entry) {
			var resource = moduleEntry.Module.Resources.FirstOrDefault(candidate => candidate.Name == entry.Owner.Name || ReferenceEquals(candidate, entry.Owner));
			return resource as EmbeddedResource
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "The .resources file no longer belongs to the module.");
		}

		/// <summary>
		/// Queues a rewrite of a .resources file: when the step runs, the entries the file holds then are read, changed
		/// by <paramref name="edit"/> — which answers the entry it edited or added — and written into a file that takes
		/// the old one's place. Reading them when the step runs is what lets several steps of one transaction edit the
		/// same file, each over what the one before it left. The node's own value follows the entry; undo puts the old
		/// file and the old value back.
		/// </summary>
		void QueueReplaceResourceFile(EditTransaction transaction, NodeEntry node, ModuleEntry moduleEntry, EmbeddedResource resource, Func<List<ResourceElement>, ResourceElement> edit) {
			var name = resource.Name;
			transaction.Add(node.Id, moduleEntry, () => {
				var current = moduleEntry.Module.Resources.FirstOrDefault(candidate => candidate.Name == name) as EmbeddedResource
					?? throw new RpcException(ErrorCodes.EditValidationFailed, "The .resources file no longer belongs to the module.");
				var index = moduleEntry.Module.Resources.IndexOf(current);
				var elements = ResourceReader.Read(moduleEntry.Module, current.CreateReader()).ResourceElements.ToList();
				var element = edit(elements);
				var replacement = new EmbeddedResource(current.Name, WriteResourceFile(elements), current.Attributes);
				moduleEntry.Module.UpdateRowId(replacement);
				var oldNodeValue = node.Value;
				// The resource row above the entries, when the tree already holds it, names the same file.
				var resourceNode = nodes.Values.FirstOrDefault(candidate =>
					ReferenceEquals(candidate.Module, moduleEntry) && candidate.Value is EmbeddedResource embedded && ReferenceEquals(embedded, current));
				var oldResourceNodeValue = resourceNode?.Value;
				moduleEntry.Module.Resources[index] = replacement;
				if (node.Value is ResourceEntryValue)
					node.Value = new ResourceEntryValue(replacement, element);
				if (resourceNode is not null)
					resourceNode.Value = replacement;
				return () => {
					moduleEntry.Module.Resources[index] = current;
					node.Value = oldNodeValue;
					if (resourceNode is not null)
						resourceNode.Value = oldResourceNodeValue!;
				};
			});
		}

		/// <summary>
		/// Writes a .resources file from the entries the set holds. The writer is the framework's own
		/// preserialized one, so a user-typed value keeps the serialized bytes it was read with.
		/// </summary>
		static byte[] WriteResourceFile(IEnumerable<ResourceElement> elements) {
			using var stream = new MemoryStream();
			using (var writer = new PreserializedResourceWriter(stream)) {
				foreach (var element in elements)
					WriteElement(writer, element);
			}
			return stream.ToArray();
		}

		static void WriteElement(PreserializedResourceWriter writer, ResourceElement element) {
			switch (element.ResourceData) {
				case BuiltInResourceData builtIn:
					switch (builtIn.Code) {
						case ResourceTypeCode.Null:
							writer.AddResource(element.Name, (string?)null);
							break;
						case ResourceTypeCode.String:
							writer.AddResource(element.Name, (string?)builtIn.Data);
							break;
						case ResourceTypeCode.ByteArray:
							writer.AddResource(element.Name, (byte[])builtIn.Data!);
							break;
						case ResourceTypeCode.Stream:
							writer.AddResource(element.Name, new MemoryStream((byte[])builtIn.Data!, writable: false), false);
							break;
						default:
							writer.AddResource(element.Name, builtIn.Data);
							break;
					}
					break;
				case BinaryResourceData binary:
#pragma warning disable SYSLIB0011 // The bytes are already serialized; nothing is serialized here.
					switch (binary.Format) {
						case SerializationFormat.TypeConverterByteArray:
						case SerializationFormat.TypeConverterString:
							writer.AddTypeConverterResource(element.Name, binary.Data, binary.TypeName);
							break;
						case SerializationFormat.ActivatorStream:
							writer.AddActivatorResource(element.Name, new MemoryStream(binary.Data, writable: false), binary.TypeName, closeAfterWrite: false);
							break;
						default:
							writer.AddBinaryFormattedResource(element.Name, binary.Data, binary.TypeName);
							break;
					}
#pragma warning restore SYSLIB0011
					break;
			}
		}
	}
}
