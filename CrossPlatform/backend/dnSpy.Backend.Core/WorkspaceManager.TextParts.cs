using dnlib.DotNet;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core;

public sealed partial class WorkspaceManager {
	sealed partial class Workspace {
		const int MaxForwarderDepth = 8;

		/// <summary>
		/// The color class a type's name is written in: its definition's when one is at hand without loading
		/// anything — in its own module, a module the workspace holds, or one a reference already loaded —
		/// and a plain type's otherwise. dnSpy's resolver would load the assembly to tell an interface from a
		/// class; coloring a row is not worth a load here.
		/// </summary>
		string TypeColor(ITypeDefOrRef type) => MetadataTextColors.Of(type, reference => FindLoadedType(reference, 0));

		TypeDef? FindLoadedType(ITypeDefOrRef type, int depth) {
			if (type is not TypeRef typeRef || depth > MaxForwarderDepth)
				return type as TypeDef;
			switch (typeRef.ResolutionScope) {
			case TypeRef outer:
				return FindLoadedType(outer, depth + 1)?.NestedTypes.FirstOrDefault(nested => nested.Name == typeRef.Name);
			case AssemblyRef assemblyRef:
				return FindLoadedType(assemblyRef.Name.String, typeRef.FullName, depth);
			default:
				return typeRef.Module?.Find(typeRef.FullName, isReflectionName: false);
			}
		}

		TypeDef? FindLoadedType(string assemblyName, string fullName, int depth) {
			ModuleDef? module = null;
			foreach (var entry in modules.Values) {
				if (string.Equals(entry.Module.Assembly?.Name.String ?? entry.Module.Name.String, assemblyName, StringComparison.OrdinalIgnoreCase)) {
					if (GetTypeIndex(entry).TryGetValue(fullName, out var indexed))
						return indexed;
					module = entry.Module;
				}
			}
			if (module is null && referenceModules.TryGetValue(assemblyName, out var loaded)) {
				if (loaded.Module.Find(fullName, isReflectionName: false) is { } found)
					return found;
				module = loaded.Module;
			}
			// A facade forwards the type to the assembly that defines it.
			foreach (var exportedType in module?.ExportedTypes ?? []) {
				if (exportedType.MovedToAnotherAssembly && exportedType.FullName == fullName && exportedType.Implementation is AssemblyRef target)
					return depth < MaxForwarderDepth ? FindLoadedType(target.Name.String, fullName, depth + 1) : null;
			}
			return null;
		}

		/// <summary>
		/// A tree row's label cut where dnSpy's syntax highlighting changes color — what its NodeFormatter
		/// writes for the node. Rows it writes in one plain color, and the folders the client words itself,
		/// have none.
		/// </summary>
		IReadOnlyList<TextPartDto>? GetLabelParts(NodeEntry node) {
			var output = new TextPartsBuilder();
			switch (node.Kind) {
			case NodeKind.Assembly when node.Value is AssemblyDef assembly:
				var isExe = assembly.ManifestModule is { } manifest && (manifest.Characteristics & dnlib.PE.Characteristics.Dll) == 0;
				output.Write(isExe ? TextColors.AssemblyExe : TextColors.Assembly, assembly.Name.String);
				if (assembly.Version is { } version)
					output.WriteSpace().Write(TextColors.Punctuation, "(").WriteVersion(version).Write(TextColors.Punctuation, ")");
				break;
			case NodeKind.Assembly or NodeKind.Module:
				output.Write(TextColors.AssemblyModule, GetLabel(node));
				break;
			case NodeKind.Namespace:
				output.WriteNamespace(((NamespaceValue)node.Value).Name);
				break;
			case NodeKind.AssemblyReference:
				var reference = (AssemblyRef)node.Value;
				output.Write(TextColors.Text, reference.Name.String);
				if (reference.Version is { } referenceVersion)
					output.WriteSpace().Write(TextColors.Punctuation, "(").WriteVersion(referenceVersion).Write(TextColors.Punctuation, ")");
				break;
			case NodeKind.Type or NodeKind.DerivedType:
				output.Write(MetadataTextColors.Of((TypeDef)node.Value), GetLabel(node));
				break;
			case NodeKind.Method:
				// The same row name the label is — a constructor wears its type's name — in its colours.
				WriteMethodRowName(output, (MethodDef)node.Value, TypeColor);
				break;
			case NodeKind.Field or NodeKind.Property or NodeKind.Event:
				output.Write(MetadataTextColors.Of((IMemberDef)node.Value), GetLabel(node));
				break;
			case NodeKind.BaseType:
				var baseType = ((BaseTypeValue)node.Value).TypeDefOrRef;
				if (!CSharpTypeName.Write(output, null, baseType, CSharpTypeName.Options.None, TypeColor))
					output.Write(TypeColor(baseType), baseType.Name.String);
				break;
			default:
				return null;
			}
			return output.ToParts();
		}

		/// <summary><see cref="GetMemberReturnType"/> in parts.</summary>
		IReadOnlyList<TextPartDto>? GetMemberReturnTypeParts(NodeEntry node) {
			var output = new TextPartsBuilder();
			var written = node.Value switch {
				MethodDef method => CSharpTypeName.Write(output, method.Parameters.ReturnParameter.ParamDef, method.ReturnType, TypeColor),
				FieldDef field => CSharpTypeName.Write(output, field, field.FieldSig?.Type, TypeColor),
				PropertyDef property => CSharpTypeName.Write(output, property, property.PropertySig?.GetRetType(), TypeColor),
				EventDef @event => CSharpTypeName.Write(output, @event, @event.EventType, CSharpTypeName.Options.None, TypeColor),
				_ => false,
			};
			return written ? output.ToParts() : null;
		}
	}
}
