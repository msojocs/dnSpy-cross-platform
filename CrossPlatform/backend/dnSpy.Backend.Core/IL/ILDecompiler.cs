/*
    Copyright (C) 2014-2019 de4dot@gmail.com

    This file is part of dnSpy

    dnSpy is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    dnSpy is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with dnSpy.  If not, see <http://www.gnu.org/licenses/>.
*/

using System.Text;
using dnlib.DotNet;
using dnSpy.Backend.Core.Output;

namespace dnSpy.Backend.Core.IL;

/// <summary>
/// dnSpy's IL settings (dnSpy.Decompiler.ILSpy.Core/Settings/ILSettings.cs), with its defaults: XML documentation,
/// token and RVA comments, IL bytes and PDB info on; IL comments, sorted members and hexadecimal numbers off.
/// </summary>
sealed record ILDecompilerSettings {
	public bool ShowILComments { get; init; }
	public bool ShowXmlDocumentation { get; init; } = true;
	public bool ShowTokenAndRvaComments { get; init; } = true;
	public bool ShowILBytes { get; init; } = true;
	public bool SortMembers { get; init; }
	public bool ShowPdbInfo { get; init; } = true;
	public int MaxStringLength { get; init; } = 20000;
	public bool HexadecimalNumbers { get; init; }
}

/// <summary>
/// What dnSpy's <c>DecompilationContext</c> and its services give the IL decompilers, answered by the workspace:
/// whether a body was edited since it was read (which bytes "Show IL instruction bytes" writes), a member's XML
/// documentation, the framework's documentation for "Show IL comments", and — for IL with C# — the C# statement
/// each instruction belongs to.
/// </summary>
sealed class ILDecompilationContext {
	public CancellationToken CancellationToken { get; init; }

	public Func<MethodDef, bool>? IsBodyModified { get; init; }

	/// <summary>The inner XML of the <c>member</c> element a documentation id names in a module's XML documentation file.</summary>
	public Func<ModuleDef, string, string?>? GetXmlDocumentation { get; init; }

	/// <summary>The summary the framework's documentation gives a documentation id.</summary>
	public Func<string, string?>? GetFrameworkDocumentation { get; init; }

	/// <summary>The C# a method body decompiles to, for IL with C#; null for the IL view.</summary>
	public Func<MethodDef, SourceStatementProvider>? CreateSourceStatementProvider { get; init; }
}

/// <summary>
/// dnSpy's IL decompilers: <c>ILDecompiler</c> (dnSpy.Decompiler.ILSpy.Core/IL/ILDecompiler.cs) and, with a source
/// statement provider, <c>ILWithCSharpDecompiler</c> (Mixed/ILWithCSharpDecompiler.cs). Both write the structured
/// IL of dnSpy's ILSpy fork's disassembler; the second puts each instruction's C# statement above it.
/// </summary>
sealed class ILDecompiler(ILDecompilerSettings settings, ILDecompilationContext context) {
	static readonly DecompilerBase decompilerBase = DecompilerBase.CSharp;

	ReflectionDisassembler CreateReflectionDisassembler(IDecompilerOutput output, ModuleDef? ownerModule) {
		var disOpts = new DisassemblerOptions(context.CancellationToken, ownerModule);
		if (settings.ShowILComments && context.GetFrameworkDocumentation is { } frameworkDocumentation)
			disOpts.GetOpCodeDocumentation = code => ILLanguageHelper.GetOpCodeDocumentation(code, frameworkDocumentation);
		var sb = new StringBuilder();
		if (settings.ShowXmlDocumentation && context.GetXmlDocumentation is { } xmlDocumentation)
			disOpts.GetXmlDocComments = a => GetXmlDocComments(a, sb, xmlDocumentation);
		disOpts.CreateInstructionBytesReader = m => InstructionBytesReader.Create(m, context.IsBodyModified is not null && context.IsBodyModified(m));
		disOpts.ShowTokenAndRvaComments = settings.ShowTokenAndRvaComments;
		disOpts.ShowILBytes = settings.ShowILBytes;
		disOpts.SortMembers = settings.SortMembers;
		disOpts.ShowPdbInfo = settings.ShowPdbInfo;
		disOpts.MaxStringLength = settings.MaxStringLength;
		disOpts.HexadecimalNumbers = settings.HexadecimalNumbers;
		if (context.CreateSourceStatementProvider is { } createSourceStatementProvider)
			return new ReflectionDisassembler(output, disOpts, new CustomMethodBodyDisassembler(output, true, disOpts, sb, createSourceStatementProvider), sb);
		return new ReflectionDisassembler(output, true, disOpts, sb);
	}

	/// <summary><c>ILDecompiler.GetXmlDocComments</c>: the member's documentation, a line at a time, its common indentation removed.</summary>
	static IEnumerable<string> GetXmlDocComments(IMemberRef? mr, StringBuilder sb, Func<ModuleDef, string, string?> xmlDocumentation) {
		if (mr is null || mr.Module is null)
			yield break;
		var doc = Documentation(mr, sb, XmlDocCompiler.RoslynOrLegacy, xmlDocumentation) ?? Documentation(mr, sb, XmlDocCompiler.MSVC, xmlDocumentation);
		if (string.IsNullOrEmpty(doc))
			yield break;

		foreach (var info in new XmlDocLine(doc)) {
			sb.Clear();
			if (info is not null) {
				sb.Append(' ');
				info.Value.WriteTo(sb);
			}
			yield return sb.ToString();
		}
	}

	static string? Documentation(IMemberRef mr, StringBuilder sb, XmlDocCompiler compiler, Func<ModuleDef, string, string?> xmlDocumentation) {
		sb.Clear();
		var key = XmlDocKeyProvider.GetKey(mr, sb, compiler)?.ToString();
		return key is null ? null : xmlDocumentation(mr.Module, key);
	}

	public void Decompile(MethodDef method, IDecompilerOutput output) {
		var dis = CreateReflectionDisassembler(output, method.Module);
		dis.DisassembleMethod(method, true);
	}

	public void Decompile(FieldDef field, IDecompilerOutput output) {
		var dis = CreateReflectionDisassembler(output, field.Module);
		dis.DisassembleField(field, false);
	}

	public void Decompile(PropertyDef property, IDecompilerOutput output) {
		var rd = CreateReflectionDisassembler(output, property.Module);
		rd.DisassembleProperty(property, addLineSep: true);
		if (property.GetMethod is not null) {
			output.WriteLine();
			rd.DisassembleMethod(property.GetMethod, true);
		}
		if (property.SetMethod is not null) {
			output.WriteLine();
			rd.DisassembleMethod(property.SetMethod, true);
		}
		foreach (var m in property.OtherMethods) {
			output.WriteLine();
			rd.DisassembleMethod(m, true);
		}
	}

	public void Decompile(EventDef ev, IDecompilerOutput output) {
		var rd = CreateReflectionDisassembler(output, ev.Module);
		rd.DisassembleEvent(ev, addLineSep: true);
		if (ev.AddMethod is not null) {
			output.WriteLine();
			rd.DisassembleMethod(ev.AddMethod, true);
		}
		if (ev.RemoveMethod is not null) {
			output.WriteLine();
			rd.DisassembleMethod(ev.RemoveMethod, true);
		}
		foreach (var m in ev.OtherMethods) {
			output.WriteLine();
			rd.DisassembleMethod(m, true);
		}
	}

	public void Decompile(TypeDef type, IDecompilerOutput output) {
		var dis = CreateReflectionDisassembler(output, type.Module);
		dis.DisassembleType(type, true);
	}

	public void Decompile(AssemblyDef asm, IDecompilerOutput output) {
		output.WriteLine("// " + asm.ManifestModule.Location, BoxedTextColor.Comment);
		decompilerBase.PrintEntryPoint(asm.ManifestModule, output);
		output.WriteLine();

		var rd = CreateReflectionDisassembler(output, asm.ManifestModule);
		rd.WriteAssemblyHeader(asm);
	}

	public void Decompile(ModuleDef mod, IDecompilerOutput output) {
		output.WriteLine("// " + mod.Location, BoxedTextColor.Comment);
		decompilerBase.PrintEntryPoint(mod, output);
		output.WriteLine();

		var rd = CreateReflectionDisassembler(output, mod);
		output.WriteLine();
		rd.WriteModuleHeader(mod);
	}

	/// <summary><c>DecompilerBase.DecompileNamespace</c>: the namespace's name and its types, not their code.</summary>
	public static void DecompileNamespace(string @namespace, IEnumerable<TypeDef> types, IDecompilerOutput output) =>
		decompilerBase.DecompileNamespace(@namespace, types, output);
}
