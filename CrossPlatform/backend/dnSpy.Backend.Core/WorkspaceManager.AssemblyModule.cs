using dnlib.DotNet;
using dnlib.DotNet.MD;
using dnlib.PE;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.Editing;

namespace dnSpy.Backend.Core;

/// <summary>
/// dnSpy's Edit Assembly and Edit Module windows — the two option models at the top of the assembly
/// tree. Both are queued through the ordinary edit transaction, so a rename or a version change is an
/// undoable step like any other.
/// </summary>
public sealed partial class WorkspaceManager {
	public Task<AssemblyOptionsDto> GetAssemblyOptionsAsync(AssemblyOptionsRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetAssemblyOptions(request.NodeId), cancellationToken);

	public Task QueueAssemblyOptionsAsync(SetAssemblyOptionsRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => {
			w.QueueAssemblyOptions(request);
			return true;
		}, cancellationToken);

	public Task<ModuleOptionsDto> GetModuleOptionsAsync(ModuleOptionsRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetModuleOptions(request.NodeId), cancellationToken);

	public Task QueueModuleOptionsAsync(SetModuleOptionsRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => {
			w.QueueModuleOptions(request);
			return true;
		}, cancellationToken);

	sealed partial class Workspace {
		AssemblyDef AssemblyOf(NodeEntry node) {
			var assembly = node.Value as AssemblyDef ?? ModuleOf(node)?.Module.Assembly;
			return assembly ?? throw new RpcException(ErrorCodes.EditValidationFailed, "The selected item is not an assembly.");
		}

		public AssemblyOptionsDto GetAssemblyOptions(string nodeId) {
			var node = GetNode(nodeId);
			var assembly = AssemblyOf(node);
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support assembly editing.");
			var context = CreateEditContext(moduleEntry);
			return new AssemblyOptionsDto(
				assembly.Name,
				assembly.Culture,
				(int)assembly.HashAlgorithm,
				(int)assembly.Attributes,
				Convert.ToHexString(assembly.PublicKey.Data).ToLowerInvariant(),
				(int)(assembly.Version?.Major ?? 0),
				(int)(assembly.Version?.Minor ?? 0),
				(int)(assembly.Version?.Build ?? 0),
				(int)(assembly.Version?.Revision ?? 0),
				context.Attributes.ToDtoList(assembly.CustomAttributes),
				context.DeclSecurities.ToDtoList(assembly.DeclSecurities),
				assembly.FullName);
		}

		public void QueueAssemblyOptions(SetAssemblyOptionsRequest request) {
			var transaction = GetTransaction(request.TransactionId);
			var node = GetNode(request.NodeId);
			var assembly = AssemblyOf(node);
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support assembly editing.");
			if (string.IsNullOrWhiteSpace(request.Options.Name))
				throw new RpcException(ErrorCodes.EditValidationFailed, "The assembly needs a name.");
			var context = CreateEditContext(moduleEntry);
			var options = request.Options;
			PublicKey publicKey;
			try {
				publicKey = new PublicKey(Convert.FromHexString(options.PublicKey ?? string.Empty));
			}
			catch (FormatException ex) {
				throw new RpcException(ErrorCodes.EditValidationFailed, "The public key is not hexadecimal.", null, ex);
			}
			var version = new Version(options.VersionMajor, options.VersionMinor, options.VersionBuild, options.VersionRevision);
			var customAttributes = context.Attributes.FromDtoList(options.CustomAttributes).ToArray();
			var declSecurities = context.DeclSecurities.FromDtoList(options.DeclSecurities).ToArray();

			var oldName = assembly.Name;
			var oldCulture = assembly.Culture;
			var oldHashAlgorithm = assembly.HashAlgorithm;
			var oldAttributes = assembly.Attributes;
			var oldPublicKey = assembly.PublicKey;
			var oldVersion = assembly.Version;
			var oldCustomAttributes = assembly.CustomAttributes.ToArray();
			var oldDeclSecurities = assembly.DeclSecurities.ToArray();
			var newName = new UTF8String(options.Name);
			var newCulture = string.IsNullOrEmpty(options.Culture) ? null : options.Culture;
			transaction.Add(node.Id, moduleEntry, () => {
				assembly.Name = newName;
				assembly.Culture = newCulture;
				assembly.HashAlgorithm = (AssemblyHashAlgorithm)options.HashAlgorithm;
				assembly.Attributes = (AssemblyAttributes)options.Attributes;
				assembly.PublicKey = publicKey;
				assembly.Version = version;
				assembly.CustomAttributes.Clear();
				foreach (var attribute in customAttributes)
					assembly.CustomAttributes.Add(attribute);
				assembly.DeclSecurities.Clear();
				foreach (var security in declSecurities)
					assembly.DeclSecurities.Add(security);
				return () => {
					assembly.Name = oldName;
					assembly.Culture = oldCulture;
					assembly.HashAlgorithm = oldHashAlgorithm;
					assembly.Attributes = oldAttributes;
					assembly.PublicKey = oldPublicKey;
					assembly.Version = oldVersion;
					assembly.CustomAttributes.Clear();
					foreach (var attribute in oldCustomAttributes)
						assembly.CustomAttributes.Add(attribute);
					assembly.DeclSecurities.Clear();
					foreach (var security in oldDeclSecurities)
						assembly.DeclSecurities.Add(security);
				};
			});
		}

		public ModuleOptionsDto GetModuleOptions(string nodeId) {
			var node = GetNode(nodeId);
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support module editing.");
			var module = moduleEntry.Module;
			var attributes = CreateEditContext(moduleEntry).Attributes;
			var managedEntryPoint = module.ManagedEntryPoint switch {
				MethodDef method => method.MDToken.Raw.ToString("X8", System.Globalization.CultureInfo.InvariantCulture),
				FileDef file => $"file:{file.Name}",
				_ => null,
			};
			return new ModuleOptionsDto(
				module.Name,
				(int)module.Kind,
				GuidText(module.Mvid),
				GuidText(module.EncId),
				GuidText(module.EncBaseId),
				module.RuntimeVersion,
				module.TablesHeaderVersion ?? 0,
				module.Cor20HeaderRuntimeVersion is { } runtimeVersion ? runtimeVersion.ToString("X8", System.Globalization.CultureInfo.InvariantCulture) : null,
				(int)module.Cor20HeaderFlags,
				(int)module.Machine,
				(int)module.Characteristics,
				(int)module.DllCharacteristics,
				managedEntryPoint,
				(uint)module.NativeEntryPoint,
				attributes.ToDtoList(module.CustomAttributes),
				module.Name.String);
		}

		static string GuidText(Guid? value) => value is null || value.Value == Guid.Empty ? string.Empty : value.Value.ToString("D");

		public void QueueModuleOptions(SetModuleOptionsRequest request) {
			var transaction = GetTransaction(request.TransactionId);
			var node = GetNode(request.NodeId);
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support module editing.");
			if (string.IsNullOrWhiteSpace(request.Options.Name))
				throw new RpcException(ErrorCodes.EditValidationFailed, "The module needs a name.");
			var module = moduleEntry.Module;
			var options = request.Options;
			Guid? ParseGuid(string? text, string field) {
				if (string.IsNullOrWhiteSpace(text))
					return null;
				return Guid.TryParse(text, out var value)
					? value
					: throw new RpcException(ErrorCodes.EditValidationFailed, $"{field} is not a GUID.");
			}
			IManagedEntryPoint? managedEntryPoint = null;
			if (!string.IsNullOrWhiteSpace(options.ManagedEntryPoint)) {
				var text = options.ManagedEntryPoint.Trim();
				if (text.StartsWith("file:", StringComparison.OrdinalIgnoreCase))
					managedEntryPoint = module.ManagedEntryPoint is FileDef file && file.Name == text[5..] ? file : null;
				else if (uint.TryParse(text, System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture, out var token))
					managedEntryPoint = module.ResolveToken(token) as MethodDef;
				if (managedEntryPoint is null)
					throw new RpcException(ErrorCodes.EditValidationFailed, "The managed entry point does not name a method or a file of this module.");
			}
			uint? cor20RuntimeVersion = null;
			if (!string.IsNullOrWhiteSpace(options.Cor20HeaderRuntimeVersion))
				cor20RuntimeVersion = uint.TryParse(options.Cor20HeaderRuntimeVersion, System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture, out var parsed)
					? parsed
					: throw new RpcException(ErrorCodes.EditValidationFailed, "The Cor20 runtime version is not hexadecimal.");
			var customAttributes = CreateEditContext(moduleEntry).Attributes.FromDtoList(options.CustomAttributes).ToArray();
			var mvid = ParseGuid(options.Mvid, "Mvid");
			var encId = ParseGuid(options.EncId, "EncId");
			var encBaseId = ParseGuid(options.EncBaseId, "EncBaseId");
			var newName = new UTF8String(options.Name);
			var newKind = (ModuleKind)options.Kind;
			var newCharacteristics = (Characteristics)options.Characteristics;
			var newDllCharacteristics = (DllCharacteristics)options.DllCharacteristics;
			var newMachine = (Machine)options.Machine;
			var newCor20Flags = (ComImageFlags)options.Cor20HeaderFlags;
			var newRuntimeVersion = options.RuntimeVersion;
			var newTablesHeaderVersion = options.TablesHeaderVersion == 0 ? (ushort?)null : (ushort)options.TablesHeaderVersion;

			var oldName = module.Name;
			var oldMvid = module.Mvid;
			var oldEncId = module.EncId;
			var oldEncBaseId = module.EncBaseId;
			var oldKind = module.Kind;
			var oldCharacteristics = module.Characteristics;
			var oldDllCharacteristics = module.DllCharacteristics;
			var oldRuntimeVersion = module.RuntimeVersion;
			var oldMachine = module.Machine;
			var oldCor20Flags = module.Cor20HeaderFlags;
			var oldCor20RuntimeVersion = module.Cor20HeaderRuntimeVersion;
			var oldTablesHeaderVersion = module.TablesHeaderVersion;
			var oldManagedEntryPoint = module.ManagedEntryPoint;
			var oldNativeEntryPoint = module.NativeEntryPoint;
			var oldCustomAttributes = module.CustomAttributes.ToArray();
			transaction.Add(node.Id, moduleEntry, () => {
				module.Name = newName;
				module.Mvid = mvid;
				module.EncId = encId;
				module.EncBaseId = encBaseId;
				module.Kind = newKind;
				module.Characteristics = newCharacteristics;
				module.DllCharacteristics = newDllCharacteristics;
				module.RuntimeVersion = newRuntimeVersion;
				module.Machine = newMachine;
				module.Cor20HeaderFlags = newCor20Flags;
				module.Cor20HeaderRuntimeVersion = cor20RuntimeVersion;
				module.TablesHeaderVersion = newTablesHeaderVersion;
				if (managedEntryPoint is not null)
					module.ManagedEntryPoint = managedEntryPoint;
				else
					module.NativeEntryPoint = (RVA)options.NativeEntryPoint;
				module.CustomAttributes.Clear();
				foreach (var attribute in customAttributes)
					module.CustomAttributes.Add(attribute);
				return () => {
					module.Name = oldName;
					module.Mvid = oldMvid;
					module.EncId = oldEncId;
					module.EncBaseId = oldEncBaseId;
					module.Kind = oldKind;
					module.Characteristics = oldCharacteristics;
					module.DllCharacteristics = oldDllCharacteristics;
					module.RuntimeVersion = oldRuntimeVersion;
					module.Machine = oldMachine;
					module.Cor20HeaderFlags = oldCor20Flags;
					module.Cor20HeaderRuntimeVersion = oldCor20RuntimeVersion;
					module.TablesHeaderVersion = oldTablesHeaderVersion;
					if (oldManagedEntryPoint is not null)
						module.ManagedEntryPoint = oldManagedEntryPoint;
					else
						module.NativeEntryPoint = oldNativeEntryPoint;
					module.CustomAttributes.Clear();
					foreach (var attribute in oldCustomAttributes)
						module.CustomAttributes.Add(attribute);
				};
			});
		}
	}
}
