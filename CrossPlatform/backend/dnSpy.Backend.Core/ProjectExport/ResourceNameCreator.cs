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

// Ported from dnSpy (dnSpy/dnSpy.Decompiler/MSBuild/ResourceNameCreator.cs).

using System.Globalization;
using System.Text;
using dnlib.DotNet;
using dnlib.DotNet.Emit;

namespace dnSpy.Backend.Core.ProjectExport;

/// <summary>
/// Where a resource goes in the project: a form's .resx beside the form, a strongly typed resource class's .resx
/// beside its Designer file, a XAML resource in the directories of the path it has in the .g.resources, and a raw
/// resource in the directories of the namespace its name starts with.
/// </summary>
sealed class ResourceNameCreator(ModuleDef module, FilenameCreator filenameCreator) {
	public string GetResxFilename(string resourceName, out string typeFullName) {
		const string RESOURCES_EXT = ".resources";
		const string RESX_EXT = ".resx";
		var n = resourceName;
		if (n.EndsWith(RESOURCES_EXT, StringComparison.OrdinalIgnoreCase))
			n = n[..^RESOURCES_EXT.Length];
		var type = module.Find(n, true);
		if (type is not null && DotNetUtils.IsWinForm(type)) {
			typeFullName = type.ReflectionFullName;
			return filenameCreator.CreateFromNamespaceName(RESX_EXT, type.Namespace, type.Name);
		}

		var resXType = GetResXType(type, n);
		if (resXType is not null) {
			typeFullName = resXType.ReflectionFullName;
			return filenameCreator.CreateFromNamespaceName(RESX_EXT, resXType.ReflectionNamespace, GetResxDesignerFilename(resXType.ReflectionNamespace, n));
		}

		typeFullName = n;
		return filenameCreator.Create(RESX_EXT, n);
	}

	static string GetResxDesignerFilename(string ns, string name) =>
		name.StartsWith(ns + ".", StringComparison.Ordinal) ? name[(ns.Length + 1)..] : name;

	TypeDef? GetResXType(TypeDef? type, string name) {
		if (type is not null && IsResXType(type, name))
			return type;
		return FindResXType(name);
	}

	TypeDef? FindResXType(string name) {
		if (resXNameToType is null) {
			var dict = new Dictionary<string, TypeDef>(StringComparer.Ordinal);
			foreach (var t in module.Types) {
				var s = GetResXString(t);
				if (s is not null)
					dict[s] = t;
			}
			resXNameToType = dict;
		}
		resXNameToType.TryGetValue(name, out var type);
		return type;
	}
	Dictionary<string, TypeDef>? resXNameToType;

	/// <summary>The resource name a ResXFileCodeGenerator class passes to its ResourceManager.</summary>
	static string? GetResXString(TypeDef type) {
		if (!type.Fields.Any(a => a.IsStatic && a.FieldType is not null && a.FieldType.ToString() == "System.Globalization.CultureInfo"))
			return null;
		if (!type.Fields.Any(a => a.IsStatic && a.FieldType is not null && a.FieldType.ToString() == "System.Resources.ResourceManager"))
			return null;
		foreach (var m in type.Methods) {
			if (m.Body is not { } body)
				continue;
			var instrs = body.Instructions;
			for (var i = 0; i + 2 < instrs.Count; i++) {
				if (instrs[i].OpCode.Code != Code.Ldstr)
					continue;
				if (instrs[i + 1].OpCode.Code != Code.Ldtoken)
					continue;
				if (instrs[i + 2].OpCode.Code != Code.Call)
					continue;
				if (instrs[i].Operand is not string s)
					continue;
				if (instrs[i + 2].Operand is not IMethod cm || cm.FullName != "System.Type System.Type::GetTypeFromHandle(System.RuntimeTypeHandle)")
					continue;
				return s;
			}
		}
		return null;
	}

	static bool IsResXType(TypeDef type, string name) {
		foreach (var m in type.Methods) {
			if (m.Body is not { } body)
				continue;
			if (body.Instructions.Any(a => a.Operand is string s && name.Equals(s, StringComparison.Ordinal)))
				return true;
		}
		return false;
	}

	public string GetXamlResourceFilename(string resourceName) => GetBamlResourceName(resourceName);

	string GetBamlResourceName(string resourceName) {
		Initialize();
		var ext = FileUtils.GetExtension(resourceName);
		var nameNoExt = resourceName[..^ext.Length];
		var ns = GetNamespace(resourceName);
		if (partialNamespaceMap!.TryGetValue(ns, out var fixedNs))
			nameNoExt = fixedNs.Replace('.', '/') + "/" + nameNoExt[(ns.Length + 1)..];
		return filenameCreator.CreateFromRelativePath(nameNoExt, ext);
	}

	static string GetNamespace(string name) {
		// name can contain illegal chars so don't use Path methods
		var i = name.LastIndexOf('/');
		return i < 0 ? string.Empty : name[..i].Replace('/', '.');
	}

	public string GetBamlResourceName(string resourceName, string? bamlTypeName, out string typeFullName) {
		Initialize();
		var name = CultureInfo.CurrentCulture.TextInfo.ToTitleCase(resourceName[..^".baml".Length]);
		var nameNoExt = name;
		name = name.Replace('/', '.');
		typeFullName = !string.IsNullOrWhiteSpace(bamlTypeName) ? bamlTypeName : GetFullName(name) ?? string.Empty;
		if (!string.IsNullOrEmpty(typeFullName))
			return filenameCreator.Create(".xaml", typeFullName);
		return GetBamlResourceName(nameNoExt + ".xaml");
	}

	string? GetFullName(string partialName) {
		var name = partialName;
		if (!string.IsNullOrEmpty(filenameCreator.DefaultNamespace))
			name = filenameCreator.DefaultNamespace + "." + name;
		if (typeToFullNameMap!.TryGetValue(name, out var fullName))
			return fullName;
		partialTypeToFullNameMap!.TryGetValue(partialName, out fullName);
		return fullName;
	}

	public string GetResourceFilename(string resourceName) {
		Initialize();
		var parts = resourceName.Split('.');
		var possibleNamespaces = new List<string>(parts.Length);
		var sb = new StringBuilder(resourceName.Length);
		for (var i = 0; i < parts.Length - 1; i++) {
			if (sb.Length > 0)
				sb.Append('.');
			sb.Append(parts[i]);
			var ns = sb.ToString();
			lowerCaseNsToReal!.TryGetValue(ns, out var realNs);
			possibleNamespaces.Add(realNs ?? ns);
		}

		for (var i = possibleNamespaces.Count - 1; i >= 0; i--) {
			var ns = possibleNamespaces[i];
			if (namespaces!.Contains(ns)) {
				var filename = resourceName[(ns.Length + 1)..];
				return filenameCreator.CreateFromNamespaceFilename(ns, filename);
			}
		}

		return filenameCreator.CreateName(resourceName);
	}

	void Initialize() {
		if (namespaces is not null)
			return;
		// Only include actual used namespaces, eg. if "ns1.ns2.Type1" is used, but there's no
		// "ns1.TypeX", don't include "ns1" as a valid namespace.
		var hash = new HashSet<string>(module.Types.Select(a => UTF8String.ToSystemStringOrEmpty(a.Namespace)));
		hash.Remove(string.Empty);
		var sb = new StringBuilder();
		var dict = new Dictionary<string, string>(StringComparer.InvariantCultureIgnoreCase);
		foreach (var ns in hash) {
			sb.Clear();
			foreach (var n in ns.Split('.')) {
				if (sb.Length > 0)
					sb.Append('.');
				sb.Append(n);
				var ns2 = sb.ToString();
				dict[ns2] = ns2;
			}
		}

		// XAML resources only include the last part of types, eg. BaseNS.NS1.Type1 => ns1/type1
		var pmap2 = new Dictionary<string, string>(StringComparer.InvariantCultureIgnoreCase);
		var pmap3 = new Dictionary<string, string>(StringComparer.InvariantCultureIgnoreCase);
		var pnsmap = new Dictionary<string, string>(StringComparer.InvariantCultureIgnoreCase);
		// Don't include nested types
		foreach (var t in module.Types) {
			var nsu = t.Namespace;
			var fullName = UTF8String.IsNullOrEmpty(nsu)
				? (t.Name ?? UTF8String.Empty).String
				: nsu!.String + "." + (t.Name ?? UTF8String.Empty).String;
			pmap3[fullName] = fullName;
			var name = fullName;
			while (name.Length > 0) {
				pmap2[name] = fullName;
				var index = name.IndexOf('.', StringComparison.Ordinal);
				if (index < 0)
					break;
				name = name[(index + 1)..];
			}

			var ns = (t.Namespace ?? UTF8String.Empty).String;
			while (ns.Length > 0) {
				pnsmap[ns] = ns;
				var index = ns.IndexOf('.', StringComparison.Ordinal);
				if (index < 0)
					break;
				ns = ns[(index + 1)..];
			}
		}

		partialNamespaceMap = pnsmap;
		partialTypeToFullNameMap = pmap2;
		typeToFullNameMap = pmap3;
		lowerCaseNsToReal = dict;
		namespaces = hash;
	}
	HashSet<string>? namespaces;
	Dictionary<string, string>? lowerCaseNsToReal;
	Dictionary<string, string>? partialNamespaceMap;
	Dictionary<string, string>? partialTypeToFullNameMap;
	Dictionary<string, string>? typeToFullNameMap;
}
