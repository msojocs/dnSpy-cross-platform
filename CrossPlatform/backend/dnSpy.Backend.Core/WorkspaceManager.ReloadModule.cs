using System.Globalization;
using dnlib.DotNet;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core;

/// <summary>
/// The debugger's in-place module refresh: a dynamic module or a module read out of the process is
/// written to its copy again, and the workspace gives the document it already has the new metadata
/// instead of removing the module and opening it afresh. WPF's <c>ClassLoader.LoadNewClasses</c> and
/// <c>MemoryModuleDefDocument.UpdateMemory</c> extend the open document the same way, so the types the
/// program emitted since the last read appear under the namespace rows that are already expanded and
/// the tabs open on the module's types stay open.
/// </summary>
public sealed partial class WorkspaceManager {
	sealed partial class Workspace {
		/// <summary>
		/// Reads the module's file again and swaps it into the existing <see cref="ModuleEntry"/>. Every
		/// node the new metadata still has is given the new metadata's object and keeps its id; a node
		/// whose token or name is gone is dropped, and the client closes what showed it. Caches built
		/// from the old metadata — namespace/type indexes, the reference resolver, the statement maps
		/// and the debug symbols — are invalidated so the next read builds them from the new module.
		/// </summary>
		public ReloadModuleResponse ReloadModule(string nodeId) {
			var node = GetNode(nodeId);
			var module = ModuleOf(node)
				?? throw new RpcException(ErrorCodes.InvalidParams, "The selected node is not part of a managed assembly.");
			if (module.IsExternal)
				throw new RpcException(ErrorCodes.InvalidParams, "The module is not open in the workspace.");
			// A model edit cannot survive a re-read: the edit lives on the old dnlib objects, and the file
			// the process wrote over does not have it. Refusing is better than discarding the user's work
			// without a word; the debugger's automatic refresh leaves such a module alone.
			if (module.HasModelEdits || module.HexPatches.Count > 0)
				throw new RpcException(ErrorCodes.EditConflict, "The module has unsaved edits, so it was not refreshed.");
			if (!File.Exists(module.Path))
				throw new RpcException(ErrorCodes.FileNotFound, "The module's file no longer exists.");

			var loaded = LoadEntry(Path.GetFullPath(module.Path)) as ModuleEntry
				?? throw new RpcException(ErrorCodes.InvalidParams, "The module's file is not a managed module.");
			var replacement = loaded.Module;
			var previous = module.Module;
			module.Module = replacement;
			module.FileLength = loaded.FileLength;

			var changed = new List<string>();
			var removed = new List<string>();
			foreach (var entry in nodes.Values.Where(candidate => ReferenceEquals(candidate.Module, module)).ToArray()) {
				if (RemapNode(entry, module, replacement))
					changed.Add(entry.Id);
				else {
					nodeIdsByKey.Remove(entry.Key);
					nodes.Remove(entry.Id);
					removed.Add(entry.Id);
				}
			}

			ForgetModuleCaches(module, netModules.Values.Where(candidate => candidate.Id == module.Id).ToArray());
			codeStatementsByNode.Clear();
			cachedStatementsStateId = string.Empty;
			stateId = Guid.NewGuid().ToString("N");
			version++;
			NoteModelChanged();
			// Nothing a node holds points at the old model any more, and the reference resolver that did
			// was disposed above, so the old module can go.
			previous.Dispose();
			return new ReloadModuleResponse(CreateOpenResponse().Modules, removed, changed,
				undoHistory.Count > 0, redoHistory.Count > 0, stateId);
		}

		/// <summary>
		/// Gives <paramref name="node"/> the new module's object for what its key names, or false when
		/// the new metadata no longer has it. Nodes that describe a place in the old image — a PE
		/// structure, a base-type row, a resource entry — are not remapped: the rows above them are
		/// recreated from the new module on the next read, with the new ids such a row gets.
		/// </summary>
		static bool RemapNode(NodeEntry node, ModuleEntry module, ModuleDefMD newModule) {
			switch (node.Kind) {
				case NodeKind.Assembly:
					node.Value = newModule.Assembly ?? (object)newModule;
					return true;
				case NodeKind.Module:
				case NodeKind.TypeReferencesGroup:
				case NodeKind.ReferencesGroup:
				case NodeKind.ResourcesGroup:
					node.Value = newModule;
					return true;
				case NodeKind.PE:
					if (newModule.Metadata?.PEImage is not { } peImage)
						return false;
					node.Value = peImage;
					return true;
				case NodeKind.Namespace:
					// The node holds the namespace name, which a re-read cannot change; its children are
					// read live from the module's type list, so the new types show up under it.
					return true;
				case NodeKind.Type or NodeKind.Method or NodeKind.Field or NodeKind.Property or NodeKind.Event: {
					var token = TokenOfKey(node.Key);
					if (token is null || newModule.ResolveToken(token.Value) is not { } member)
						return false;
					node.Value = member;
					return true;
				}
				case NodeKind.AssemblyReference or NodeKind.ModuleReference: {
					var token = TokenOfKey(node.Key);
					if (token is null)
						return false;
					var reference = newModule.ResolveToken(token.Value);
					if (node.Kind == NodeKind.AssemblyReference ? reference is not AssemblyRef : reference is not ModuleRef)
						return false;
					node.Value = reference!;
					return true;
				}
				case NodeKind.Resource: {
					// ResourceKey: "resource:{module path}:{name}"; the name is the manifest resource's.
					var prefix = $"resource:{module.Path}:";
					if (!node.Key.StartsWith(prefix, StringComparison.Ordinal))
						return false;
					var name = node.Key[prefix.Length..];
					var resource = newModule.Resources.FirstOrDefault(candidate => candidate.Name.String == name);
					if (resource is null)
						return false;
					node.Value = resource;
					return true;
				}
				default:
					return false;
			}
		}

		/// <summary>The metadata token at the end of a member key, <c>{module path}:{kind}:{token:X8}</c>.</summary>
		static uint? TokenOfKey(string key) {
			var colon = key.LastIndexOf(':');
			return colon < 0 ? null
				: uint.TryParse(key[(colon + 1)..], NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var token) ? token : null;
		}
	}
}
