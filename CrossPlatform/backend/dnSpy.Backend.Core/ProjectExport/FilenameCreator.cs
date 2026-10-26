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

// Ported from dnSpy (dnSpy/dnSpy.Decompiler/MSBuild/FilenameCreator.cs, FileUtils.cs and dnSpy.Decompiler/FilenameUtils.cs).

using System.Globalization;
using dnlib.DotNet;

namespace dnSpy.Backend.Core.ProjectExport;

/// <summary>
/// The names of a project's directory and files: a type's file sits in the directories of its namespace with the
/// project's default namespace taken off, every part cleaned of characters a file name cannot hold and cut to a
/// length, and a name already used gets ".2", ".3"… before its extension.
/// </summary>
sealed class FilenameCreator {
	// Max length of a filename, excluding extension
	const int MaxNameLength = 60;
	// Max length of a directory name part
	const int MaxDirNameLength = 40;

	public string DefaultNamespace { get; }

	readonly HashSet<string> usedNames = new(StringComparer.OrdinalIgnoreCase);
	readonly string baseDir;

	public FilenameCreator(string baseDir, string defaultNamespace = "") {
		this.baseDir = baseDir;
		DefaultNamespace = defaultNamespace;
	}

	public string Create(string fileExt, string fullName) {
		var name = StripDefaultNamespace(fullName);
		if (string.IsNullOrEmpty(name))
			name = fullName;
		return Create(name.Split('.'), fileExt);
	}

	public string CreateFromNamespaceName(string fileExt, string ns, string name) {
		var list = GetNamespaceParts(ns);
		list.Add(name);
		return Create([.. list], fileExt);
	}

	List<string> GetNamespaceParts(string ns) {
		ns = StripDefaultNamespace(ns);
		var list = new List<string>();
		if (!string.IsNullOrEmpty(ns))
			list.AddRange(ns.Split('.'));
		return list;
	}

	string StripDefaultNamespace(string name) {
		if (DefaultNamespace.Equals(name, StringComparison.Ordinal))
			return string.Empty;
		if (name.StartsWith(DefaultNamespace + ".", StringComparison.Ordinal))
			return name[(DefaultNamespace.Length + 1)..];
		return name;
	}

	public string CreateFromRelativePath(string relPath, string fileExt) {
		relPath = relPath.Replace('\\', Path.DirectorySeparatorChar).Replace(Path.AltDirectorySeparatorChar, Path.DirectorySeparatorChar);
		return Create(relPath.Split(Path.DirectorySeparatorChar), fileExt);
	}

	string Create(string[] parts, string fileExt) {
		fileExt = FilenameUtils.CleanName(fileExt);
		var tempName = string.Empty;
		for (var i = 0; i < parts.Length; i++) {
			var maxLen = i == parts.Length - 1 ? MaxNameLength : MaxDirNameLength;
			tempName = Path.Combine(tempName, FixLongName(FilenameUtils.CleanName(parts[i]), maxLen));
		}
		tempName = Path.Combine(baseDir, tempName);
		var newName = tempName + fileExt;
		if (usedNames.Contains(newName)) {
			for (var i = 2; ; i++) {
				newName = tempName + "." + i.ToString(CultureInfo.InvariantCulture) + fileExt;
				if (!usedNames.Contains(newName))
					break;
			}
		}
		usedNames.Add(newName);
		return newName;
	}

	/// <summary>A project's directory: the assembly's name for the manifest module, else the module's file name.</summary>
	public string Create(ModuleDef module) {
		var name = module.Assembly is { } assembly && module.IsManifestModule ? assembly.Name.String : FileUtils.GetFilename(module.Name);
		return Create(name);
	}

	string Create(string name) {
		name = Path.Combine(baseDir, FixLongName(FilenameUtils.CleanName(name), MaxNameLength));
		if (usedNames.Contains(name)) {
			var tempName = name;
			for (var i = 2; ; i++) {
				name = tempName + "." + i.ToString(CultureInfo.InvariantCulture);
				if (!usedNames.Contains(name))
					break;
			}
		}
		usedNames.Add(name);
		return name;
	}

	static string FixLongName(string name, int maxLen) => name.Length <= maxLen ? name : name[..maxLen];

	public string CreateFromNamespaceFilename(string @namespace, string filename) {
		var fileExt = FileUtils.GetExtension(filename);
		var relPath = filename[..^fileExt.Length];
		ExtractNamespace(relPath, out var ns, out var filenameNoExt);
		if (!string.IsNullOrEmpty(ns)) {
			if (string.IsNullOrEmpty(@namespace))
				@namespace = ns;
			else
				@namespace += "." + ns;
		}
		var parts = GetNamespaceParts(@namespace);
		parts.Add(FileUtils.GetFileNameWithoutExtension(filenameNoExt));
		return Create([.. parts], fileExt);
	}

	static void ExtractNamespace(string relPath, out string ns, out string name) {
		var i = relPath.LastIndexOf('.');
		if (i < 0) {
			ns = string.Empty;
			name = relPath;
		}
		else {
			ns = relPath[..i];
			name = relPath[(i + 1)..];
		}
	}

	public string CreateName(string nameOnly) {
		var fileExt = FileUtils.GetExtension(nameOnly);
		return Create([FileUtils.GetFileNameWithoutExtension(nameOnly)], fileExt);
	}
}

/// <summary>Name helpers that do not rely on Path, which can throw if the input contains invalid characters.</summary>
static class FileUtils {
	static readonly char[] dirSepChars = ['\\', '/'];

	public static string GetFilename(string name) {
		var i = name.LastIndexOfAny(dirSepChars);
		return i >= 0 ? name[(i + 1)..] : name;
	}

	public static string GetExtension(string name) {
		var i = name.LastIndexOf('.');
		return i < 0 ? string.Empty : name[i..];
	}

	public static string GetFileNameWithoutExtension(string name) {
		var i = name.LastIndexOfAny(dirSepChars);
		if (i >= 0)
			name = name[i..];
		i = name.LastIndexOf('.');
		return i < 0 ? name : name[..i];
	}

	public static string RemoveExtension(string name) {
		var i = name.LastIndexOf('.');
		return i < 0 ? name : name[..i];
	}
}

/// <summary>dnSpy's FilenameUtils: a name made safe for a file, and a path written relative to a directory.</summary>
static class FilenameUtils {
	static readonly HashSet<string> ReservedFileNames = new(StringComparer.OrdinalIgnoreCase) {
		"CON", "PRN", "AUX", "NUL",
		"COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
		"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
	};

	// The characters Windows refuses in a file name, so a project written here opens there too.
	static readonly HashSet<char> invalidFileNameChars = [
		'"', '<', '>', '|', '\0', ':', '*', '?', '\\', '/',
		.. Enumerable.Range(1, 31).Select(c => (char)c),
	];

	public static string CleanName(string text) {
		var pos = text.IndexOf(':', StringComparison.Ordinal);
		if (pos > 0)
			text = text[..pos];
		pos = text.IndexOf('`', StringComparison.Ordinal);
		if (pos > 0)
			text = text[..pos];
		text = text.Trim();
		char[]? textChars = null;
		for (var i = 0; i < text.Length; i++) {
			if (invalidFileNameChars.Contains(text[i])) {
				textChars ??= text.ToCharArray();
				textChars[i] = '-';
			}
		}
		if (textChars is not null)
			text = new string(textChars);
		if (ReservedFileNames.Contains(text))
			text += "_";
		return text;
	}

	// ("/dir1/dir2/dir3", "/dir1/dirA/dirB/file.dll") = "../../dirA/dirB/file.dll"
	// ("/dir1/dir2/dir3", "/dir1/dir2/dir3/dir4/dir5/file.dll") = "dir4/dir5/file.dll"
	public static string GetRelativePath(string sourceDir, string destFile) {
		sourceDir = Path.GetFullPath(sourceDir);
		destFile = Path.GetFullPath(destFile);
		if (!string.Equals(Path.GetPathRoot(sourceDir), Path.GetPathRoot(destFile), StringComparison.OrdinalIgnoreCase))
			return destFile;
		var sourceDirs = GetPathNames(sourceDir);
		var destDirs = GetPathNames(Path.GetDirectoryName(destFile)!);
		var hintPath = string.Empty;
		int i;
		for (i = 0; i < sourceDirs.Count && i < destDirs.Count; i++) {
			if (!sourceDirs[i].Equals(destDirs[i], StringComparison.OrdinalIgnoreCase))
				break;
		}
		for (var j = i; j < sourceDirs.Count; j++)
			hintPath = Path.Combine(hintPath, "..");
		for (; i < destDirs.Count; i++)
			hintPath = Path.Combine(hintPath, destDirs[i]);
		return Path.Combine(hintPath, Path.GetFileName(destFile));
	}

	static List<string> GetPathNames(string path) {
		var list = new List<string>();
		var root = Path.GetPathRoot(path);
		while (path != root && !string.IsNullOrEmpty(path)) {
			list.Add(Path.GetFileName(path));
			path = Path.GetDirectoryName(path)!;
		}
		list.Add(root ?? string.Empty);
		list.Reverse();
		return list;
	}
}
