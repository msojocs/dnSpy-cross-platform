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

// Ported from dnSpy (dnSpy/dnSpy.Decompiler/MSBuild/SatelliteAssemblyFinder.cs).

using System.Globalization;
using System.Xml;
using dnlib.DotNet;

namespace dnSpy.Backend.Core.ProjectExport;

/// <summary>
/// The satellite assemblies of a module: Name.resources.dll in a culture's directory beside it (or beside one of the
/// private paths its .config probes), whose name and public key token are the module's assembly's. Their resources
/// are folded into the main project as Name.culture.resx files.
/// </summary>
sealed class SatelliteAssemblyFinder : IDisposable {
	readonly HashSet<string> cultures = new(CultureInfo.GetCultures(CultureTypes.AllCultures).Select(a => a.Name), StringComparer.OrdinalIgnoreCase);
	readonly Dictionary<string, ModuleDef?> openedModules = new(StringComparer.OrdinalIgnoreCase);

	bool IsValidCulture(string name) => !string.IsNullOrEmpty(name) && cultures.Contains(name);

	public IEnumerable<ModuleDef> GetSatelliteAssemblies(ModuleDef module) {
		var asm = module.Assembly;
		if (asm is null)
			yield break;
		var satAsmName = new AssemblyNameInfo(asm);
		satAsmName.Name = asm.Name + ".resources";
		foreach (var filename in GetFiles(asm, module)) {
			if (!File.Exists(filename))
				continue;
			var satAsm = TryOpenAssembly(filename);
			if (satAsm is null || !AssemblyNameComparer.NameAndPublicKeyTokenOnly.Equals(satAsmName, satAsm))
				continue;
			yield return satAsm.ManifestModule;
		}
	}

	IEnumerable<string> GetFiles(AssemblyDef asm, ModuleDef mod) {
		var baseDir = GetBaseDirectory(mod);
		if (string.IsNullOrEmpty(baseDir))
			yield break;
		var baseDirs = new List<string> { baseDir };
		var configName = mod.Location + ".config";
		if (File.Exists(configName))
			baseDirs.AddRange(GetPrivatePaths(configName));
		foreach (var bd in baseDirs) {
			foreach (var dir in GetDirectories(bd)) {
				var name = Path.GetFileName(dir);
				if (!IsValidCulture(name))
					continue;
				yield return Path.Combine(dir, asm.Name + ".resources.dll");
				yield return Path.Combine(dir, asm.Name, asm.Name + ".resources.dll");
			}
		}
	}

	static List<string> GetPrivatePaths(string configFileName) {
		var searchPaths = new List<string>();
		try {
			var dirName = Path.GetDirectoryName(Path.GetFullPath(configFileName));
			if (dirName is null)
				return searchPaths;
			using var xmlStream = File.OpenRead(configFileName);
			var doc = new XmlDocument();
			doc.Load(XmlReader.Create(xmlStream, new XmlReaderSettings { XmlResolver = null, DtdProcessing = DtdProcessing.Prohibit }));
			foreach (var tmp in doc.GetElementsByTagName("probing")) {
				if (tmp is not XmlElement probingElem)
					continue;
				var privatePath = probingElem.GetAttribute("privatePath");
				if (string.IsNullOrEmpty(privatePath))
					continue;
				foreach (var item in privatePath.Split(';')) {
					var path = item.Trim();
					if (string.IsNullOrEmpty(path))
						continue;
					var newPath = Path.GetFullPath(Path.Combine(dirName, path.Replace('\\', Path.DirectorySeparatorChar)));
					if (Directory.Exists(newPath) && newPath.StartsWith(dirName + Path.DirectorySeparatorChar, StringComparison.Ordinal))
						searchPaths.Add(newPath);
				}
			}
		}
		catch (Exception ex) when (ex is ArgumentException or IOException or XmlException or UnauthorizedAccessException) {
		}
		return searchPaths;
	}

	static string? GetBaseDirectory(ModuleDef mod) {
		if (string.IsNullOrEmpty(mod.Location))
			return null;
		try {
			return Path.GetDirectoryName(mod.Location);
		}
		catch (ArgumentException) {
			return null;
		}
	}

	static string[] GetDirectories(string dir) {
		try {
			return Directory.GetDirectories(dir);
		}
		catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) {
			return [];
		}
	}

	AssemblyDef? TryOpenAssembly(string filename) {
		lock (openedModules) {
			if (openedModules.TryGetValue(filename, out var mod))
				return mod?.Assembly;
			openedModules[filename] = null;
			if (!File.Exists(filename))
				return null;
			try {
				mod = ModuleDefMD.Load(filename);
				if (mod.Assembly is null || UTF8String.IsNullOrEmpty(mod.Assembly.Culture)) {
					mod.Dispose();
					return null;
				}
				openedModules[filename] = mod;
				return mod.Assembly;
			}
			catch (Exception ex) when (ex is BadImageFormatException or IOException or UnauthorizedAccessException) {
				return null;
			}
		}
	}

	public void Dispose() {
		lock (openedModules) {
			foreach (var mod in openedModules.Values)
				mod?.Dispose();
			openedModules.Clear();
		}
	}
}
