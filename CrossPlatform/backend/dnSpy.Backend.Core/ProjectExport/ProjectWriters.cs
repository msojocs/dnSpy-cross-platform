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

// Ported from dnSpy (dnSpy/dnSpy.Decompiler/MSBuild/ProjectWriterBase.cs, DefaultProjectWriter.cs and SdkProjectWriter.cs).

using System.Globalization;
using System.Text;
using System.Xml;
using dnlib.DotNet;
using dnlib.PE;
using dnSpy.Backend.Core.Output;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.CSharp.ProjectDecompiler;
using ICSharpCode.Decompiler.Metadata;

namespace dnSpy.Backend.Core.ProjectExport;

/// <summary>What the two project formats share: the platform, the output type, the references and the paths.</summary>
abstract class ProjectWriterBase(Project project, ProjectVersion projectVersion, IList<Project> allProjects, IReadOnlyList<string> userGACPaths) {
	protected readonly Project project = project;
	protected readonly ProjectVersion projectVersion = projectVersion;
	protected readonly IList<Project> allProjects = allProjects;
	protected readonly IReadOnlyList<string> userGACPaths = userGACPaths;

	public abstract void Write();

	protected static string GetRelativePath(string sourceDir, string destFile) =>
		FilenameUtils.GetRelativePath(sourceDir, destFile).Replace(Path.DirectorySeparatorChar, '\\').Replace(Path.AltDirectorySeparatorChar, '\\');

	protected string GetRelativePath(string filename) => GetRelativePath(project.Directory, filename);

	protected static string ToString(BuildAction buildAction) => buildAction switch {
		BuildAction.None => "None",
		BuildAction.Compile => "Compile",
		BuildAction.EmbeddedResource => "EmbeddedResource",
		BuildAction.ApplicationDefinition => "ApplicationDefinition",
		BuildAction.Page => "Page",
		BuildAction.Resource => "Resource",
		BuildAction.SplashScreen => "SplashScreen",
		_ => throw new InvalidOperationException(),
	};

	protected string GetPlatformString() {
		var machine = project.Module.Machine;
		if (machine.IsI386()) {
			var c = (project.Module.Is32BitRequired ? 2 : 0) + (project.Module.Is32BitPreferred ? 1 : 0);
			switch (c) {
			case 0: // no special meaning, MachineType and ILONLY flag determine image requirements
				if (!project.Module.IsILOnly)
					return "x86";
				return "AnyCPU";
			case 1: // illegal, reserved for future use
				break;
			case 2: // image is x86-specific
				return "x86";
			case 3: // image is project.Platform neutral and prefers to be loaded 32-bit when possible
				return "AnyCPU";
			}
			return "AnyCPU";
		}
		if (machine.IsAMD64())
			return "x64";
		if (machine == Machine.IA64)
			return "Itanium";
		if (machine.IsARMNT())
			return "ARM";
		if (machine.IsARM64())
			return "ARM64";
		return machine.ToString();
	}

	protected string GetOutputType() {
		if (project.Module.IsWinMD)
			return "WinMDObj";
		return project.Module.Kind switch {
			ModuleKind.Console => "Exe",
			ModuleKind.Windows => "WinExe",
			ModuleKind.Dll => "Library",
			ModuleKind.NetModule => "Module",
			_ => "Library",
		};
	}

	protected string? GetNoWarnList() =>
		project.Decompiler.IsVisualBasic ? "41999,42016,42017,42018,42019,42020,42021,42022,42032,42036,42314" : null;

	protected string GetRootNamespace() => string.IsNullOrEmpty(project.DefaultNamespace) ? GetAssemblyName() : project.DefaultNamespace;

	protected string GetAssemblyName() => project.AssemblyName;

	protected string GetFileAlignment() {
		if (project.Module is ModuleDefMD mod)
			return mod.Metadata.PEImage.ImageNTHeaders.OptionalHeader.FileAlignment.ToString(CultureInfo.InvariantCulture);
		return "512";
	}

	/// <summary>
	/// The C# version the files need when the framework's own default is older: dnSpy's decompiler wrote what every
	/// compiler takes, ICSharpCode.Decompiler writes the newest syntax it may. A Visual Basic project names none.
	/// </summary>
	protected string? GetLanguageVersion(string framework, string version) {
		if (project.Decompiler.IsVisualBasic)
			return null;
		var required = project.Decompiler.LanguageVersion;
		if (required is LanguageVersion.Preview)
			return "preview";
		if (required is LanguageVersion.Latest || (int)required <= (int)DefaultLanguageVersion(framework, version))
			return null;
		return LanguageVersionString(required);
	}

	static LanguageVersion DefaultLanguageVersion(string framework, string version) {
		if (framework == ".NETCoreApp" && Version.TryParse(version, out var core)) {
			return core.Major switch {
				< 3 => LanguageVersion.CSharp7_3,
				3 or 4 => LanguageVersion.CSharp8_0,
				5 => LanguageVersion.CSharp9_0,
				6 => LanguageVersion.CSharp10_0,
				7 => LanguageVersion.CSharp11_0,
				8 => LanguageVersion.CSharp12_0,
				9 => LanguageVersion.CSharp13_0,
				_ => LanguageVersion.CSharp14_0,
			};
		}
		if (framework == ".NETStandard" && version == "2.1")
			return LanguageVersion.CSharp8_0;
		return LanguageVersion.CSharp7_3;
	}

	static string LanguageVersionString(LanguageVersion version) =>
		version.ToString().Replace("CSharp", string.Empty, StringComparison.Ordinal).Replace('_', '.');

	protected string? GetHintPath(AssemblyDef? asm) {
		if (asm is null)
			return null;
		if (IsGacPath(asm.ManifestModule.Location))
			return null;
		if (ExistsInProject(asm.ManifestModule.Location))
			return null;
		return GetRelativePath(asm.ManifestModule.Location);
	}

	bool IsGacPath(string file) => GacInfo.IsGacPath(file) || IsUserGacPath(file);

	bool IsUserGacPath(string file) {
		file = file.Replace(Path.AltDirectorySeparatorChar, Path.DirectorySeparatorChar);
		foreach (var dir in userGACPaths) {
			if (file.StartsWith(dir.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
				return true;
		}
		return false;
	}

	protected bool ExistsInProject(string filename) => FindOtherProject(filename) is not null;

	protected bool AssemblyExistsInProject(string asmSimpleName) =>
		allProjects.Any(a => StringComparer.OrdinalIgnoreCase.Equals(a.AssemblyName, asmSimpleName));

	protected Project? FindOtherProject(string filename) {
		if (string.IsNullOrEmpty(filename))
			return null;
		var fullName = Path.GetFullPath(filename);
		return allProjects.FirstOrDefault(f => !string.IsNullOrEmpty(f.Module.Location) && StringComparer.OrdinalIgnoreCase.Equals(Path.GetFullPath(f.Module.Location), fullName));
	}

	/// <summary>The assembly a reference names, as the module's own resolver finds it.</summary>
	protected AssemblyDef? Resolve(AssemblyRef reference) {
		try {
			return project.Module.Context.AssemblyResolver.Resolve(reference, project.Module);
		}
		catch (Exception ex) when (ex is not OperationCanceledException) {
			return null;
		}
	}

	/// <summary>The other projects this one references, in file name order.</summary>
	protected Project[] GetProjectReferences() =>
		project.Module.GetAssemblyRefs()
			.Select(Resolve)
			.Select(a => a is null ? null : FindOtherProject(a.ManifestModule.Location))
			.OfType<Project>()
			.Distinct()
			.OrderBy(a => a.Filename, StringComparer.OrdinalIgnoreCase)
			.ToArray();

	protected void Write(XmlWriter writer, BuildAction buildAction) {
		var files = project.Files.Where(a => a.BuildAction == buildAction).OrderBy(a => a.Filename, StringComparer.OrdinalIgnoreCase).ToArray();
		if (files.Length == 0)
			return;
		writer.WriteStartElement("ItemGroup");
		foreach (var file in files) {
			writer.WriteStartElement(ToString(buildAction));
			writer.WriteAttributeString("Include", GetRelativePath(file.Filename));
			if (file.DependentUpon is not null)
				writer.WriteElementString("DependentUpon", GetRelativePath(Path.GetDirectoryName(file.Filename)!, file.DependentUpon.Filename));
			if (file.SubType is not null)
				writer.WriteElementString("SubType", file.SubType);
			if (file.Generator is not null)
				writer.WriteElementString("Generator", file.Generator);
			if (file.LastGenOutput is not null)
				writer.WriteElementString("LastGenOutput", GetRelativePath(Path.GetDirectoryName(file.Filename)!, file.LastGenOutput.Filename));
			if (file.AutoGen)
				writer.WriteElementString("AutoGen", "True");
			if (file.DesignTime)
				writer.WriteElementString("DesignTime", "True");
			if (file.DesignTimeSharedInput)
				writer.WriteElementString("DesignTimeSharedInput", "True");
			writer.WriteEndElement();
		}
		writer.WriteEndElement();
	}
}

/// <summary>A legacy project file, as Visual Studio <see cref="ProjectVersion"/> writes one.</summary>
sealed class DefaultProjectWriter(Project project, ProjectVersion projectVersion, IList<Project> allProjects, IReadOnlyList<string> userGACPaths)
	: ProjectWriterBase(project, projectVersion, allProjects, userGACPaths) {
	public override void Write() {
		project.OnWrite();
		var settings = new XmlWriterSettings {
			Encoding = Encoding.UTF8,
			Indent = true,
		};
		if (projectVersion == ProjectVersion.VS2005)
			settings.OmitXmlDeclaration = true;
		using var writer = XmlWriter.Create(project.Filename, settings);
		project.Platform = GetPlatformString();

		writer.WriteStartDocument();
		writer.WriteStartElement("Project", "http://schemas.microsoft.com/developer/msbuild/2003");
		var toolsVersion = GetToolsVersion();
		if (toolsVersion is not null)
			writer.WriteAttributeString("ToolsVersion", toolsVersion);
		if (projectVersion <= ProjectVersion.VS2015)
			writer.WriteAttributeString("DefaultTargets", "Build");
		if (projectVersion >= ProjectVersion.VS2012) {
			writer.WriteStartElement("Import");
			writer.WriteAttributeString("Project", @"$(MSBuildExtensionsPath)\$(MSBuildToolsVersion)\Microsoft.Common.props");
			writer.WriteAttributeString("Condition", @"Exists('$(MSBuildExtensionsPath)\$(MSBuildToolsVersion)\Microsoft.Common.props')");
			writer.WriteEndElement();
		}

		// Default property group
		writer.WriteStartElement("PropertyGroup");

		writer.WriteStartElement("Configuration");
		writer.WriteAttributeString("Condition", " '$(Configuration)' == '' ");
		writer.WriteString("Debug");
		writer.WriteEndElement();

		writer.WriteStartElement("Platform");
		writer.WriteAttributeString("Condition", " '$(Platform)' == '' ");
		writer.WriteString(project.Platform);
		writer.WriteEndElement();

		writer.WriteElementString("ProjectGuid", project.Guid.ToString("B").ToUpperInvariant());
		writer.WriteElementString("OutputType", GetOutputType());
		var appDesignFolder = GetAppDesignerFolder();
		if (appDesignFolder is not null)
			writer.WriteElementString("AppDesignerFolder", appDesignFolder);
		writer.WriteElementString("RootNamespace", GetRootNamespace());
		var asmName = GetAssemblyName();
		if (!string.IsNullOrEmpty(asmName))
			writer.WriteElementString("AssemblyName", GetAssemblyName());
		var (framework, version, profile) = TargetFrameworkInfo.Get(project.Module);
		var isDotNetFramework = framework == ".NETFramework";
		if (projectVersion > ProjectVersion.VS2005 || !isDotNetFramework || version != "2.0")
			writer.WriteElementString("TargetFrameworkVersion", "v" + version);
		if (!string.IsNullOrEmpty(profile))
			writer.WriteElementString("TargetFrameworkProfile", profile);
		if (!isDotNetFramework)
			writer.WriteElementString("TargetFrameworkIdentifier", framework);
		writer.WriteElementString("FileAlignment", GetFileAlignment());
		if (project.ProjectTypeGuids.Count != 0) {
			var text = string.Join(";", project.ProjectTypeGuids.Select(a => a.ToString("B").ToUpperInvariant()));
			writer.WriteElementString("ProjectTypeGuids", text);
		}
		//TODO: VB includes a "MyType"
		if (project.ApplicationManifest is not null)
			writer.WriteElementString("ApplicationManifest", GetRelativePath(project.ApplicationManifest.Filename));
		if (project.ApplicationIcon is not null)
			writer.WriteElementString("ApplicationIcon", GetRelativePath(project.ApplicationIcon.Filename));
		if (project.StartupObject is not null)
			writer.WriteElementString("StartupObject", project.StartupObject);
		if (GetLanguageVersion(framework, version) is { } langVersion)
			writer.WriteElementString("LangVersion", langVersion);
		writer.WriteEndElement();

		// Debug property group
		var noWarnList = GetNoWarnList();
		writer.WriteStartElement("PropertyGroup");
		writer.WriteAttributeString("Condition", $" '$(Configuration)|$(Platform)' == 'Debug|{project.Platform}' ");
		writer.WriteElementString("PlatformTarget", project.Platform);
		writer.WriteElementString("DebugSymbols", "true");
		writer.WriteElementString("DebugType", "full");
		writer.WriteElementString("Optimize", "false");
		writer.WriteElementString("OutputPath", @"bin\Debug\");
		writer.WriteElementString("DefineConstants", "DEBUG;TRACE");
		writer.WriteElementString("ErrorReport", "prompt");
		writer.WriteElementString("WarningLevel", "4");
		if (!project.Options.AddCorlibReference)
			writer.WriteElementString("NoStdLib", "true");
		if (project.AllowUnsafeBlocks)
			writer.WriteElementString("AllowUnsafeBlocks", "true");
		if (noWarnList is not null)
			writer.WriteElementString("NoWarn", noWarnList);
		writer.WriteEndElement();

		// Release property group
		writer.WriteStartElement("PropertyGroup");
		writer.WriteAttributeString("Condition", $" '$(Configuration)|$(Platform)' == 'Release|{project.Platform}' ");
		writer.WriteElementString("PlatformTarget", project.Platform);
		writer.WriteElementString("DebugType", "pdbonly");
		writer.WriteElementString("Optimize", "true");
		writer.WriteElementString("OutputPath", @"bin\Release\");
		writer.WriteElementString("DefineConstants", "TRACE");
		writer.WriteElementString("ErrorReport", "prompt");
		writer.WriteElementString("WarningLevel", "4");
		if (!project.Options.AddCorlibReference)
			writer.WriteElementString("NoStdLib", "true");
		if (project.AllowUnsafeBlocks)
			writer.WriteElementString("AllowUnsafeBlocks", "true");
		if (noWarnList is not null)
			writer.WriteElementString("NoWarn", noWarnList);
		writer.WriteEndElement();

		// GAC references
		var gacRefs = project.Module.GetAssemblyRefs().Where(a => a.Name != "mscorlib").OrderBy(a => a.Name.String, StringComparer.OrdinalIgnoreCase).ToArray();
		if (gacRefs.Length > 0 || project.ExtraAssemblyReferences.Count > 0) {
			writer.WriteStartElement("ItemGroup");
			var hash = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
			foreach (var r in gacRefs) {
				var asm = Resolve(r);
				if (asm is not null && ExistsInProject(asm.ManifestModule.Location))
					continue;
				hash.Add(r.Name);
				writer.WriteStartElement("Reference");
				writer.WriteAttributeString("Include", IdentifierEscaper.Escape(r.Name));
				var hintPath = GetHintPath(asm);
				if (hintPath is not null)
					writer.WriteElementString("HintPath", hintPath);
				writer.WriteEndElement();
			}
			foreach (var r in project.ExtraAssemblyReferences) {
				if (hash.Contains(r) || AssemblyExistsInProject(r))
					continue;
				hash.Add(r);
				writer.WriteStartElement("Reference");
				writer.WriteAttributeString("Include", IdentifierEscaper.Escape(r));
				writer.WriteEndElement();
			}
			writer.WriteEndElement();
		}

		writer.WriteStartElement("ItemGroup");
		writer.WriteStartElement("AppDesigner");
		writer.WriteAttributeString("Include", project.PropertiesFolder + "\\");
		writer.WriteEndElement();
		writer.WriteEndElement();

		Write(writer, BuildAction.Compile);
		Write(writer, BuildAction.EmbeddedResource);

		// Project references
		var projRefs = GetProjectReferences();
		if (projRefs.Length > 0) {
			writer.WriteStartElement("ItemGroup");
			foreach (var otherProj in projRefs) {
				writer.WriteStartElement("ProjectReference");
				writer.WriteAttributeString("Include", GetRelativePath(otherProj.Filename));
				writer.WriteStartElement("Project");
				var guidString = otherProj.Guid.ToString("B");
				if (projectVersion < ProjectVersion.VS2012)
					guidString = guidString.ToUpperInvariant();
				writer.WriteString(guidString);
				writer.WriteEndElement();
				writer.WriteStartElement("Name");
				writer.WriteString(IdentifierEscaper.Escape(otherProj.Module.Assembly is null ? string.Empty : otherProj.Module.Assembly.Name.String));
				writer.WriteEndElement();
				writer.WriteEndElement();
			}
			writer.WriteEndElement();
		}

		Write(writer, BuildAction.None);
		Write(writer, BuildAction.ApplicationDefinition);
		Write(writer, BuildAction.Page);
		Write(writer, BuildAction.Resource);
		Write(writer, BuildAction.SplashScreen);

		writer.WriteStartElement("Import");
		writer.WriteAttributeString("Project", GetLanguageTargets());
		writer.WriteEndElement();

		writer.WriteEndElement();
		writer.WriteEndDocument();
	}

	string? GetToolsVersion() => projectVersion switch {
		ProjectVersion.VS2005 => null,
		ProjectVersion.VS2008 => "3.5",
		ProjectVersion.VS2010 => "4.0",
		ProjectVersion.VS2012 => "4.0",
		ProjectVersion.VS2013 => "12.0",
		ProjectVersion.VS2015 => "14.0",
		ProjectVersion.VS2017 => "15.0",
		ProjectVersion.VS2019 => "15.0",
		ProjectVersion.VS2022 => "15.0",
		_ => throw new InvalidOperationException(),
	};

	string? GetAppDesignerFolder() {
		if (project.Decompiler.IsVisualBasic)
			return null;
		if (projectVersion >= ProjectVersion.VS2017)
			return null;
		return project.PropertiesFolder;
	}

	string GetLanguageTargets() => project.Decompiler.IsVisualBasic
		? @"$(MSBuildToolsPath)\Microsoft.VisualBasic.targets"
		: @"$(MSBuildToolsPath)\Microsoft.CSharp.targets";
}

/// <summary>An SDK-style project file.</summary>
sealed class SdkProjectWriter(Project project, ProjectVersion projectVersion, IList<Project> allProjects, IReadOnlyList<string> userGACPaths)
	: ProjectWriterBase(project, projectVersion, allProjects, userGACPaths) {
	static readonly HashSet<string> implicitReferences = [
		"mscorlib",
		"netstandard",
		"PresentationFramework",
		"System",
		"System.Diagnostics.Debug",
		"System.Diagnostics.Tools",
		"System.Drawing",
		"System.Runtime",
		"System.Runtime.Extensions",
		"System.Windows.Forms",
		"System.Xaml",
	];

	enum ProjectType : byte {
		Default,
		WinForms,
		Wpf,
		Web,
	}

	public override void Write() {
		project.OnWrite();
		var settings = new XmlWriterSettings {
			Encoding = Encoding.UTF8,
			Indent = true,
			OmitXmlDeclaration = true,
		};
		using var writer = XmlWriter.Create(project.Filename, settings);
		project.Platform = GetPlatformString();

		writer.WriteStartElement("Project");

		var possibleProjectTypes = GetPossibleProjectTypes();
		var projectType = DetermineProjectType(possibleProjectTypes);
		writer.WriteAttributeString("Sdk", GetSdkString(projectType));

		writer.WriteStartElement("PropertyGroup");

		writer.WriteElementString("ProjectGuid", project.Guid.ToString("B").ToUpperInvariant());
		writer.WriteElementString("OutputType", GetOutputType());
		writer.WriteElementString("RootNamespace", GetRootNamespace());
		var asmName = GetAssemblyName();
		if (!string.IsNullOrEmpty(asmName))
			writer.WriteElementString("AssemblyName", asmName);
		writer.WriteElementString("GenerateAssemblyInfo", "False");

		writer.WriteElementString("FileAlignment", GetFileAlignment());

		var (framework, version, _) = TargetFrameworkInfo.Get(project.Module);
		var moniker = TargetFrameworkInfo.Moniker(framework, version)
			?? throw new NotSupportedException("This assembly cannot be decompiled to a SDK style project.");
		var targetPlatform = GetTargetPlatform(framework, version, possibleProjectTypes);
		writer.WriteElementString("TargetFramework", targetPlatform is null ? moniker : moniker + "-" + targetPlatform);
		if (targetPlatform is not null && GetTargetPlatformMinVersion(targetPlatform) is { } minVersion)
			writer.WriteElementString("TargetPlatformMinVersion", minVersion);

		if (possibleProjectTypes.Contains(ProjectType.Wpf))
			writer.WriteElementString("UseWPF", "True");
		if (possibleProjectTypes.Contains(ProjectType.WinForms))
			writer.WriteElementString("UseWindowsForms", "True");

		if (project.Platform != "AnyCPU")
			writer.WriteElementString("PlatformTarget", project.Platform);
		else if (project.Module.Is32BitPreferred)
			writer.WriteElementString("Prefer32Bit", "True");

		var noWarnList = GetNoWarnList();
		if (noWarnList is not null)
			writer.WriteElementString("NoWarn", noWarnList);

		if (GetLanguageVersion(framework, version) is { } langVersion)
			writer.WriteElementString("LangVersion", langVersion);

		writer.WriteEndElement();

		writer.WriteStartElement("PropertyGroup");
		if (!project.Options.AddCorlibReference)
			writer.WriteElementString("NoStdLib", "True");
		if (project.AllowUnsafeBlocks)
			writer.WriteElementString("AllowUnsafeBlocks", "True");
		writer.WriteElementString("EnableDefaultItems", "False");
		writer.WriteEndElement();

		writer.WriteStartElement("PropertyGroup");
		if (project.ApplicationManifest is not null)
			writer.WriteElementString("ApplicationManifest", GetRelativePath(project.ApplicationManifest.Filename));
		if (project.ApplicationIcon is not null)
			writer.WriteElementString("ApplicationIcon", GetRelativePath(project.ApplicationIcon.Filename));
		if (project.StartupObject is not null)
			writer.WriteElementString("StartupObject", project.StartupObject);
		writer.WriteEndElement();

		Write(writer, BuildAction.Compile);
		Write(writer, BuildAction.EmbeddedResource);

		// Project references
		var projRefs = GetProjectReferences();
		if (projRefs.Length > 0) {
			writer.WriteStartElement("ItemGroup");
			foreach (var otherProj in projRefs) {
				writer.WriteStartElement("ProjectReference");
				writer.WriteAttributeString("Include", GetRelativePath(otherProj.Filename));
				writer.WriteStartElement("Project");
				writer.WriteString(otherProj.Guid.ToString("B").ToUpperInvariant());
				writer.WriteEndElement();
				writer.WriteStartElement("Name");
				writer.WriteString(IdentifierEscaper.Escape(otherProj.Module.Assembly is null ? string.Empty : otherProj.Module.Assembly.Name.String));
				writer.WriteEndElement();
				writer.WriteEndElement();
			}
			writer.WriteEndElement();
		}

		var isNetCoreApp = framework == ".NETCoreApp";
		var targetPacks = new HashSet<string>();
		if (isNetCoreApp) {
			targetPacks.Add("Microsoft.NETCore.App");
			switch (projectType) {
			case ProjectType.WinForms:
			case ProjectType.Wpf:
				targetPacks.Add("Microsoft.WindowsDesktop.App");
				break;
			case ProjectType.Web:
				targetPacks.Add("Microsoft.AspNetCore.App");
				targetPacks.Add("Microsoft.AspNetCore.All");
				break;
			}
		}

		// dnSpy asks its DotNetPathProvider which runtime pack ships an assembly; the module's resolver knows the
		// runtime packs of the framework the module targets.
		bool ReferenceFilter(string refName) {
			if (isNetCoreApp)
				return !IsInTargetPack(refName, targetPacks);
			return !implicitReferences.Contains(refName);
		}

		var gacRefs = project.Module.GetAssemblyRefs().Where(a => ReferenceFilter(a.Name)).OrderBy(a => a.Name.String, StringComparer.OrdinalIgnoreCase).ToArray();
		var extraRefsWithoutImplicitRefs = project.ExtraAssemblyReferences.Where(ReferenceFilter).ToArray();
		if (gacRefs.Length > 0 || extraRefsWithoutImplicitRefs.Length > 0) {
			writer.WriteStartElement("ItemGroup");
			var hash = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
			foreach (var r in gacRefs) {
				var asm = Resolve(r);
				if (asm is not null && ExistsInProject(asm.ManifestModule.Location))
					continue;
				hash.Add(r.Name);
				writer.WriteStartElement("Reference");
				writer.WriteAttributeString("Include", IdentifierEscaper.Escape(r.Name));
				var hintPath = GetHintPath(asm);
				if (hintPath is not null)
					writer.WriteElementString("HintPath", hintPath);
				writer.WriteEndElement();
			}
			foreach (var r in extraRefsWithoutImplicitRefs) {
				if (hash.Contains(r) || AssemblyExistsInProject(r))
					continue;
				hash.Add(r);
				writer.WriteStartElement("Reference");
				writer.WriteAttributeString("Include", IdentifierEscaper.Escape(r));
				writer.WriteEndElement();
			}
			writer.WriteEndElement();
		}

		Write(writer, BuildAction.None);
		Write(writer, BuildAction.ApplicationDefinition);
		Write(writer, BuildAction.Page);
		Write(writer, BuildAction.Resource);
		Write(writer, BuildAction.SplashScreen);

		writer.WriteEndElement();
	}

	bool IsInTargetPack(string assemblyName, HashSet<string> targetPacks) {
		try {
			if (project.ExportModule.Classifier.IsSharedAssembly(AssemblyNameReference.Parse(assemblyName), out var runtimePack) && targetPacks.Contains(runtimePack))
				return true;
		}
		catch (Exception ex) when (ex is not OperationCanceledException) {
		}
		// dnSpy finds these in the Windows Desktop runtime it is installed with; outside Windows there is none to look in.
		return targetPacks.Contains("Microsoft.WindowsDesktop.App") && WindowsDesktopReferencePack.IsDesktopAssembly(assemblyName);
	}

	/// <summary>
	/// The platform of a .NET 5+ moniker ("windows7.0" in "net10.0-windows7.0"): the assembly's TargetPlatform, or
	/// Windows for a WPF or WinForms project, which a current SDK builds only for that platform. Older frameworks
	/// take none — dnSpy's moniker predates them.
	/// </summary>
	string? GetTargetPlatform(string framework, string version, IReadOnlyCollection<ProjectType> possibleProjectTypes) {
		if (framework != ".NETCoreApp" || !Version.TryParse(version, out var parsed) || parsed.Major < 5)
			return null;
		var platform = TargetServices.DetectTargetPlatform(project.ExportModule.File);
		if (platform is null && (possibleProjectTypes.Contains(ProjectType.Wpf) || possibleProjectTypes.Contains(ProjectType.WinForms)))
			platform = "Windows";
		return platform?.ToLowerInvariant();
	}

	/// <summary>The lowest platform version the assembly supports, when it is lower than the one it targets.</summary>
	string? GetTargetPlatformMinVersion(string platform) {
		var supported = TargetServices.DetectSupportedOSPlatform(project.ExportModule.File)?.ToLowerInvariant();
		if (supported is null)
			return null;
		var (supportedName, supportedVersion) = SplitPlatform(supported);
		var (targetName, targetVersion) = SplitPlatform(platform);
		if (supportedName != targetName || supportedVersion.Length == 0 || supportedVersion == targetVersion)
			return null;
		return supportedVersion;

		static (string Name, string Version) SplitPlatform(string text) {
			var i = 0;
			while (i < text.Length && !char.IsDigit(text[i]))
				i++;
			return (text[..i], text[i..]);
		}
	}

	static string GetSdkString(ProjectType projectType) => projectType switch {
		ProjectType.WinForms or ProjectType.Wpf => "Microsoft.NET.Sdk.WindowsDesktop",
		ProjectType.Web => "Microsoft.NET.Sdk.Web",
		_ => "Microsoft.NET.Sdk",
	};

	IReadOnlyCollection<ProjectType> GetPossibleProjectTypes() {
		var hashSet = new HashSet<ProjectType>();
		foreach (var assemblyRef in project.Module.GetAssemblyRefs()) {
			if (assemblyRef.Name.StartsWith("Microsoft.AspNetCore", StringComparison.Ordinal))
				hashSet.Add(ProjectType.Web);
			else if (assemblyRef.Name == "PresentationFramework" || assemblyRef.Name == "PresentationCore" || assemblyRef.Name == "WindowsBase")
				hashSet.Add(ProjectType.Wpf);
			else if (assemblyRef.Name == "System.Windows.Forms")
				hashSet.Add(ProjectType.WinForms);
		}
		return hashSet;
	}

	static ProjectType DetermineProjectType(IReadOnlyCollection<ProjectType> possibleProjectTypes) {
		// If only one of the project types was detected, use it
		if (possibleProjectTypes.Count == 1)
			return possibleProjectTypes.Single();
		ProjectType[] preferredProjectTypes = [ProjectType.Wpf, ProjectType.WinForms, ProjectType.Web];
		foreach (var preferredProjectType in preferredProjectTypes) {
			if (possibleProjectTypes.Contains(preferredProjectType))
				return preferredProjectType;
		}
		return ProjectType.Default;
	}
}
