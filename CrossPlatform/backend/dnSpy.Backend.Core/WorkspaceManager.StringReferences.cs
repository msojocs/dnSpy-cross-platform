using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using dnlib.DotNet;
using dnlib.DotNet.Emit;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core;

public sealed partial class WorkspaceManager {
	public StringReferencesSearchResponse StringReferencesSearch(StringReferencesSearchRequest request) {
		var workspace = GetWorkspace(request.WorkspaceId);
		var moduleIds = request.ModuleIds?.ToHashSet() ?? new HashSet<string>();
		var searchAllModules = moduleIds.Count == 0;

		var results = new List<StringReferenceDto>();
		var searchCompilerGenerated = request.SearchCompilerGeneratedMembers;

		foreach (var entry in workspace.Entries) {
			if (!searchAllModules && !moduleIds.Contains(entry.Id))
				continue;

			if (entry.Module is not ModuleDef module)
				continue;

			// Scan module-level custom attributes
			ScanCustomAttributes(results, module, module, module, searchCompilerGenerated);

			// Scan assembly custom attributes if this is the manifest module
			if (module.IsManifestModule && module.Assembly is AssemblyDef assembly) {
				ScanCustomAttributes(results, assembly, assembly, module, searchCompilerGenerated);
			}

			// Scan all types
			foreach (var type in module.GetTypes()) {
				if (!searchCompilerGenerated && IsCompilerGenerated(type))
					continue;

				ScanType(results, type, module, searchCompilerGenerated);
			}
		}

		return new StringReferencesSearchResponse(results);
	}

	private void ScanType(List<StringReferenceDto> results, TypeDef type, ModuleDef module, bool searchCompilerGenerated) {
		// Type custom attributes
		ScanCustomAttributes(results, type, type, module, searchCompilerGenerated);

		// Generic parameters
		foreach (var gp in type.GenericParameters) {
			ScanCustomAttributes(results, gp, type, module, searchCompilerGenerated);
		}

		// Fields
		foreach (var field in type.Fields) {
			if (!searchCompilerGenerated && IsCompilerGenerated(field))
				continue;

			ScanCustomAttributes(results, field, field, module, searchCompilerGenerated);

			// Field constant
			if (field.HasConstant && field.Constant is string strConst) {
				results.Add(CreateConstantReference(strConst, field, module));
			}
		}

		// Methods
		foreach (var method in type.Methods) {
			if (!searchCompilerGenerated && IsCompilerGenerated(method))
				continue;

			ScanMethod(results, method, module, searchCompilerGenerated);
		}

		// Properties
		foreach (var property in type.Properties) {
			if (!searchCompilerGenerated && IsCompilerGenerated(property))
				continue;

			ScanCustomAttributes(results, property, property, module, searchCompilerGenerated);

			// Property constant
			if (property.HasConstant && property.Constant is string strConst) {
				results.Add(CreateConstantReference(strConst, property, module));
			}
		}

		// Events
		foreach (var evt in type.Events) {
			if (!searchCompilerGenerated && IsCompilerGenerated(evt))
				continue;

			ScanCustomAttributes(results, evt, evt, module, searchCompilerGenerated);
		}
	}

	private void ScanMethod(List<StringReferenceDto> results, MethodDef method, ModuleDef module, bool searchCompilerGenerated) {
		// Method custom attributes
		ScanCustomAttributes(results, method, method, module, searchCompilerGenerated);

		// Generic parameters
		foreach (var gp in method.GenericParameters) {
			ScanCustomAttributes(results, gp, method, module, searchCompilerGenerated);
		}

		// Parameters
		foreach (var param in method.Parameters) {
			if (param.ParamDef is ParamDef paramDef) {
				ScanCustomAttributes(results, paramDef, method, module, searchCompilerGenerated);

				// Parameter default value
				if (paramDef.HasConstant && paramDef.Constant is string strConst) {
					results.Add(CreateConstantReference(strConst, paramDef, method, module));
				}
			}
		}

		// Return parameter
		if (method.Parameters.ReturnParameter.ParamDef is ParamDef retParam) {
			ScanCustomAttributes(results, retParam, method, module, searchCompilerGenerated);

			if (retParam.HasConstant && retParam.Constant is string strConst) {
				results.Add(CreateConstantReference(strConst, retParam, method, module));
			}
		}

		// Method body IL strings
		if (method.HasBody && method.Body.Instructions is { } instructions) {
			for (int i = 0; i < instructions.Count; i++) {
				var instr = instructions[i];
				if (instr.OpCode.Code == Code.Ldstr && instr.Operand is string str) {
					results.Add(CreateILReference(str, method, (uint)instr.Offset, module));
				}
			}
		}
	}

	private void ScanCustomAttributes(
		List<StringReferenceDto> results,
		IHasCustomAttribute target,
		IMDTokenProvider container,
		ModuleDef module,
		bool searchCompilerGenerated) {

		if (!target.HasCustomAttributes)
			return;

		foreach (var ca in target.CustomAttributes) {
			// Constructor arguments
			if (ca.HasConstructorArguments) {
				for (int i = 0; i < ca.ConstructorArguments.Count; i++) {
					var arg = ca.ConstructorArguments[i];
					ScanCustomAttributeArgument(results, arg, ca, container, module, $"arg{i}", searchCompilerGenerated);
				}
			}

			// Named arguments
			if (ca.HasNamedArguments) {
				foreach (var namedArg in ca.NamedArguments) {
					ScanCustomAttributeArgument(results, namedArg.Argument, ca, container, module, namedArg.Name, searchCompilerGenerated);
				}
			}
		}
	}

	private void ScanCustomAttributeArgument(
		List<StringReferenceDto> results,
		CAArgument arg,
		CustomAttribute ca,
		IMDTokenProvider container,
		ModuleDef module,
		string argumentName,
		bool searchCompilerGenerated) {

		if (arg.Value is string str) {
			results.Add(CreateAttributeReference(str, ca, container, module, argumentName));
		}
		else if (arg.Value is CAArgument[] array) {
			// Handle array arguments
			foreach (var elem in array) {
				ScanCustomAttributeArgument(results, elem, ca, container, module, argumentName, searchCompilerGenerated);
			}
		}
	}

	private StringReferenceDto CreateILReference(string literal, MethodDef method, uint offset, ModuleDef module) {
		var nodeId = NodeKeyOf(method);
		var label = FormatMemberReference(method);
		var labelParts = FormatMemberTextParts(method);

		return new StringReferenceDto(
			Literal: literal,
			Kind: "IL",
			ReferrerLabel: $"{label}+IL_{offset:X4}",
			ModuleName: module.Name,
			NodeId: nodeId,
			MetadataToken: (int)method.MDToken.Raw,
			IlOffset: (int)offset,
			ReferrerLabelParts: labelParts,
			Icon: GetIconName(method),
			ToolTip: null
		);
	}

	private StringReferenceDto CreateConstantReference(string literal, IHasConstant member, ModuleDef module) {
		var container = member switch {
			FieldDef or PropertyDef => member as IMDTokenProvider,
			ParamDef param => param.DeclaringMethod,
			_ => null
		};

		if (container is null)
			return new StringReferenceDto(literal, "Constant", "Unknown", module.Name);

		var nodeId = NodeKeyOf(container);
		var label = container switch {
			FieldDef f => FormatMemberReference(f),
			PropertyDef p => FormatMemberReference(p),
			MethodDef m => FormatMemberReference(m),
			_ => container.ToString() ?? "Unknown"
		};

		var labelParts = container switch {
			FieldDef f => FormatMemberTextParts(f),
			PropertyDef p => FormatMemberTextParts(p),
			MethodDef m => FormatMemberTextParts(m),
			_ => null
		};

		if (member is ParamDef param) {
			var paramName = param == param.DeclaringMethod?.Parameters?.ReturnParameter?.ParamDef
				? "return"
				: param.Name;
			label += $" (parameter {paramName})";
		}

		return new StringReferenceDto(
			Literal: literal,
			Kind: "Constant",
			ReferrerLabel: label,
			ModuleName: module.Name,
			NodeId: nodeId,
			MetadataToken: (int)container.MDToken.Raw,
			IlOffset: null,
			ReferrerLabelParts: labelParts,
			Icon: GetIconName(container),
			ToolTip: null
		);
	}

	private StringReferenceDto CreateConstantReference(string literal, ParamDef param, MethodDef method, ModuleDef module) {
		var nodeId = NodeKeyOf(method);
		var label = FormatMemberReference(method);
		var labelParts = FormatMemberTextParts(method);

		var paramName = param == method.Parameters?.ReturnParameter?.ParamDef
			? "return"
			: param.Name;

		return new StringReferenceDto(
			Literal: literal,
			Kind: "Constant",
			ReferrerLabel: $"{label} (parameter {paramName})",
			ModuleName: module.Name,
			NodeId: nodeId,
			MetadataToken: (int)method.MDToken.Raw,
			IlOffset: null,
			ReferrerLabelParts: labelParts,
			Icon: GetIconName(method),
			ToolTip: null
		);
	}

	private StringReferenceDto CreateAttributeReference(
		string literal,
		CustomAttribute ca,
		IMDTokenProvider container,
		ModuleDef module,
		string argumentName) {

		var nodeId = NodeKeyOf(container);
		var label = container switch {
			ModuleDef m => m.Name,
			AssemblyDef a => a.FullName,
			TypeDef t => FormatMemberReference(t),
			MethodDef m => FormatMemberReference(m),
			FieldDef f => FormatMemberReference(f),
			PropertyDef p => FormatMemberReference(p),
			EventDef e => FormatMemberReference(e),
			_ => container.ToString() ?? "Unknown"
		};

		var labelParts = container switch {
			TypeDef t => FormatMemberTextParts(t),
			MethodDef m => FormatMemberTextParts(m),
			FieldDef f => FormatMemberTextParts(f),
			PropertyDef p => FormatMemberTextParts(p),
			EventDef e => FormatMemberTextParts(e),
			_ => null
		};

		var attrTypeName = ca.AttributeType?.Name ?? "Attribute";
		label += $" (attribute {attrTypeName}.{argumentName})";

		return new StringReferenceDto(
			Literal: literal,
			Kind: "Attribute",
			ReferrerLabel: label,
			ModuleName: module.Name,
			NodeId: nodeId,
			MetadataToken: (int)container.MDToken.Raw,
			IlOffset: null,
			ReferrerLabelParts: labelParts,
			Icon: GetIconName(container),
			ToolTip: null
		);
	}

	private static bool IsCompilerGenerated(IHasCustomAttribute member) {
		if (member?.CustomAttributes is null)
			return false;

		foreach (var ca in member.CustomAttributes) {
			if (ca.TypeFullName == "System.Runtime.CompilerServices.CompilerGeneratedAttribute")
				return true;
		}

		return false;
	}

	private string FormatMemberReference(IMemberDef member) {
		return member?.FullName ?? "Unknown";
	}

	private IReadOnlyList<TextPartDto>? FormatMemberTextParts(IMemberDef member) {
		// For now, return null - we can enhance this later with syntax coloring
		return null;
	}

	private string? GetIconName(object obj) {
		// Map to dnSpy icon names
		return obj switch {
			MethodDef => "Method",
			FieldDef => "Field",
			PropertyDef => "Property",
			EventDef => "Event",
			TypeDef => "Class",
			_ => null
		};
	}
}
