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

// Ported from dnSpy (dnSpy/dnSpy.Decompiler/MSBuild/DefaultNamespaceFinder.cs and DotNetUtils.cs).

using System.Text;
using dnlib.DotNet;

namespace dnSpy.Backend.Core.ProjectExport;

/// <summary>
/// The project's default namespace (its RootNamespace): the namespace the module's types share, or the assembly's
/// name when that is where they start. A system assembly with several unrelated namespaces has none.
/// </summary>
readonly struct DefaultNamespaceFinder(ModuleDef module) {
	readonly record struct Info(string? FirstPart, string? CommonPrefix, string[]? Namespaces);

	public string Find() {
		var nss = new HashSet<string>(module.Types.Select(a => a.Namespace.String).Where(IsValidNamespace), StringComparer.Ordinal);
		var infos = new List<Info>();
		foreach (var f in nss.Select(GetFirstPart).Distinct()) {
			var ary = nss.Where(a => a.Equals(f, StringComparison.Ordinal) || a.StartsWith(f + ".", StringComparison.Ordinal)).ToArray();
			infos.Add(new Info(f, GetCommon(ary), ary));
		}
		var info2 = PickNamespace(infos);
		var modNs = GetModuleNamespace(module);
		var foundNs = info2.CommonPrefix;
		if (!string.IsNullOrEmpty(modNs) && foundNs is not null && foundNs.StartsWith(modNs + ".", StringComparison.Ordinal))
			foundNs = modNs;
		return foundNs ?? string.Empty;
	}

	Info PickNamespace(List<Info> infos) {
		if (infos.Count == 0)
			return default;
		if (infos.Count == 1)
			return infos[0];
		var modNs = GetModuleNamespace(module);
		var info = infos.FirstOrDefault(a => modNs.Equals(a.CommonPrefix, StringComparison.Ordinal) || a.CommonPrefix!.StartsWith(modNs, StringComparison.Ordinal));
		if (info.CommonPrefix is not null)
			return info;
		// Here if it's eg. mscorlib, System.Xml or other system assemblies with several different namespaces.
		return default;
	}

	static string GetCommon(string[] namespaces) {
		string? foundNs = null;
		var sb = new StringBuilder();
		foreach (var ns in namespaces)
			foundNs = foundNs is null ? ns : GetCommonNamespace(sb, foundNs, ns);
		return foundNs ?? string.Empty;
	}

	static string GetFirstPart(string ns) {
		var i = ns.IndexOf('.', StringComparison.Ordinal);
		return i < 0 ? ns : ns[..i];
	}

	static bool IsValidNamespace(string ns) => !string.IsNullOrEmpty(ns) && ns != "XamlGeneratedNamespace";

	static string GetCommonNamespace(StringBuilder sb, string a, string b) {
		sb.Clear();
		var na = a.Split('.');
		var nb = b.Split('.');
		for (var i = 0; i < na.Length && i < nb.Length; i++) {
			if (!StringComparer.Ordinal.Equals(na[i], nb[i]))
				break;
			if (sb.Length > 0)
				sb.Append('.');
			sb.Append(na[i]);
		}
		return sb.ToString();
	}

	static string GetModuleNamespace(ModuleDef module) {
		string s;
		if (module.Assembly is { } asm && module.IsManifestModule)
			s = asm.Name;
		else {
			s = module.Name;
			if (s.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || s.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
				s = s[..^4];
			if (s.EndsWith(".netmodule", StringComparison.OrdinalIgnoreCase))
				s = s[..^10];
			else
				s = string.Empty;
		}
		return s.Replace('-', '_');
	}
}

/// <summary>What the project creator asks of a module's types: is it a form, an application class, unsafe.</summary>
static class DotNetUtils {
	/// <summary>Whether a base type, followed through the resolver, is <paramref name="typeFullName"/>.</summary>
	static bool IsType(TypeDef? type, string typeFullName) {
		while (type is not null) {
			var bt = type.BaseType;
			if (bt is null)
				break;
			if (bt.FullName == typeFullName)
				return true;
			var resolved = bt.ResolveTypeDef();
			// System.Windows.Forms is no part of the runtime on Linux or macOS, so the chain of a form usually breaks at
			// its first framework base type. Those are the ones Windows Forms derives every control from.
			if (resolved is null)
				return typeFullName == "System.Windows.Forms.Control" && IsWindowsFormsControl(bt);
			type = resolved;
		}
		return false;
	}

	static readonly HashSet<string> windowsFormsControls = new(StringComparer.Ordinal) {
		"Form", "UserControl", "Control", "ContainerControl", "ScrollableControl", "Panel", "GroupBox",
		"TabPage", "SplitContainer", "FlowLayoutPanel", "TableLayoutPanel", "ToolStripContainer",
	};

	static bool IsWindowsFormsControl(ITypeDefOrRef type) =>
		type.Namespace == "System.Windows.Forms" && windowsFormsControls.Contains(type.Name) &&
		type.DefinitionAssembly?.Name == "System.Windows.Forms";

	public static bool IsWinForm(TypeDef type) => IsType(type, "System.Windows.Forms.Control") && type.Methods.Any(x => x.Name == "InitializeComponent");
	public static bool IsSystemWindowsApplication(TypeDef type) => IsType(type, "System.Windows.Application");
	public static bool IsStartUpClass(TypeDef type) => type.Module.EntryPoint is not null && type.Module.EntryPoint.DeclaringType == type;
	public static bool IsUnsafe(ModuleDef module) => module.CustomAttributes.IsDefined("System.Security.UnverifiableCodeAttribute");

	public static IEnumerable<FieldDef> GetFields(MethodDef method) => GetDefs(method).OfType<FieldDef>();

	public static IEnumerable<IMemberDef> GetDefs(MethodDef method) {
		if (method.Body is not { } body)
			yield break;
		foreach (var instr in body.Instructions) {
			if (instr.Operand is IMemberDef def && def.DeclaringType == method.DeclaringType)
				yield return def;
		}
	}

	public static IEnumerable<IMemberDef> GetDefs(PropertyDef prop) {
		foreach (var g in prop.GetMethods) {
			foreach (var d in GetDefs(g))
				yield return d;
		}
	}

	public static IEnumerable<IMemberDef> GetMethodsAndSelf(PropertyDef p) {
		yield return p;
		foreach (var m in p.GetMethods)
			yield return m;
		foreach (var m in p.SetMethods)
			yield return m;
		foreach (var m in p.OtherMethods)
			yield return m;
	}
}
