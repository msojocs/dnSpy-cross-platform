using dnlib.DotNet;
using dnlib.PE;

namespace dnSpy.Backend.Core;

/// <summary>
/// The framework a module was built for and the platform it runs on, the two lines dnSpy's assembly and
/// module tooltips carry under the full name — a port of WPF's <c>TargetFrameworkInfo</c> and
/// <c>TargetFrameworkUtils.GetArchString</c>. The framework is read from the assembly's
/// TargetFrameworkAttribute; a module without one is named after the CLR version its metadata targets.
/// </summary>
static class TargetFrameworkInfo {
	/// <summary>The display name, ".NET 8.0", ".NET Framework 4.7.2" or ".NET Standard 2.0", with the profile
	/// in parentheses when there is one; null for an attribute that names a framework dnSpy cannot word.</summary>
	public static string? DisplayName(ModuleDef module) {
		var (framework, version, profile) = Create(module);
		var name = FrameworkDisplayName(framework, version);
		if (name is null)
			return null;
		return string.IsNullOrEmpty(profile) ? name : $"{name} ({profile})";
	}

	/// <summary>"x86", "x64", "AnyCPU (64-bit preferred)" and so on — what the image's machine and
	/// 32-bit flags say about where it can run.</summary>
	public static string ArchString(ModuleDef module) {
		if (module.Machine.IsI386()) {
			var flags = (module.Is32BitRequired ? 2 : 0) + (module.Is32BitPreferred ? 1 : 0);
			switch (flags) {
			case 0:
				return module.IsILOnly ? "AnyCPU (64-bit preferred)" : "x86";
			case 1:
				return "???";
			case 2:
				return "x86";
			case 3:
				return "AnyCPU (32-bit preferred)";
			}
		}
		return ArchString(module.Machine);
	}

	static string ArchString(Machine machine) {
		if (machine.IsI386())
			return "x86";
		if (machine.IsAMD64())
			return "x64";
		if (machine == Machine.IA64)
			return "IA-64";
		if (machine.IsARMNT())
			return "ARM";
		if (machine.IsARM64())
			return "ARM64";
		return machine.ToString();
	}

	static (string Framework, string Version, string? Profile) Create(ModuleDef module) {
		if (module.Assembly is { } assembly && module.IsManifestModule && FromAttribute(assembly) is { } info)
			return info;
		const string framework = ".NETFramework";
		if (module.IsClr10)
			return (framework, "1.0", null);
		if (module.IsClr11)
			return (framework, "1.1", null);
		if (module.IsClr20)
			return (framework, DotNetVersion2035(module), null);
		return (framework, "4.0", null);
	}

	static (string, string, string?)? FromAttribute(AssemblyDef assembly) {
		var attribute = assembly.CustomAttributes.Find("System.Runtime.Versioning.TargetFrameworkAttribute");
		if (attribute is null || attribute.ConstructorArguments.Count != 1)
			return null;
		var argument = attribute.ConstructorArguments[0];
		if (argument.Type.GetElementType() != ElementType.String)
			return null;
		var text = argument.Value switch {
			UTF8String utf8 when !UTF8String.IsNullOrEmpty(utf8) => utf8.String,
			string value => value,
			_ => null,
		};
		return text is null ? null : FromAttributeString(text);
	}

	// See BinaryCompatibility.cs in the runtime: "Framework,Version=v4.5[,Profile=Client]".
	static (string, string, string?)? FromAttributeString(string text) {
		var values = text.Split(',');
		if (values.Length is < 2 or > 3)
			return null;
		var framework = values[0].Trim();
		if (framework.Length == 0)
			return null;
		string? versionText = null;
		string? profile = null;
		for (var i = 1; i < values.Length; i++) {
			var pair = values[i].Split('=');
			if (pair.Length != 2)
				return null;
			var key = pair[0].Trim();
			var value = pair[1].Trim();
			if (key.Equals("Version", StringComparison.OrdinalIgnoreCase)) {
				if (value.StartsWith('v') || value.StartsWith('V'))
					value = value[1..];
				versionText = value;
				if (!Version.TryParse(value, out _))
					return null;
			}
			else if (key.Equals("Profile", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrEmpty(value)) {
				profile = value;
			}
		}
		return string.IsNullOrEmpty(versionText) ? null : (framework, versionText, profile);
	}

	static string? FrameworkDisplayName(string framework, string version) {
		static bool IsCore(string version) => version.StartsWith("1.", StringComparison.Ordinal) || version.StartsWith("2.", StringComparison.Ordinal) || version.StartsWith("3.", StringComparison.Ordinal);
		return framework switch {
			".NETFramework" => ".NET Framework " + (version == "4.0" ? "4" : version),
			".NETPortable" => ".NET Portable " + version,
			".NETCore" => "Windows Universal " + version,
			".NETCoreApp" => (IsCore(version) ? ".NET Core " : ".NET ") + version,
			".NETPlatform" => ".NET Platform " + version,
			".NETStandard" => ".NET Standard " + version,
			".NETStandardApp" => ".NET Standard App " + version,
			"DNX" => "DNX " + version,
			"DNXCore" => "DNX Core " + version,
			"WindowsPhone" => "Windows Phone " + version,
			"WindowsPhoneApp" => "Windows Phone App " + version,
			"UAP" => "Universal App " + version,
			"Silverlight" => "Silverlight " + version,
			".NETMicroFramework" => ".NET Micro Framework " + version,
			"WinRT" => "WinRT " + version,
			"Windows" => "Windows " + version,
			"CoreCLR" => "Core CLR " + version,
			"ASP.Net" or "ASP.NET" => "ASP.NET " + version,
			"ASP.NetCore" or "ASP.NETCore" => "ASP.NET Core " + version,
			"native" => "native " + version,
			"MonoAndroid" => "Mono Android " + version,
			"MonoTouch" => "Mono Touch " + version,
			"MonoMac" => "Mono Mac " + version,
			"Xamarin.iOS" => "Xamarin iOS " + version,
			"Xamarin.Mac" => "Xamarin Mac " + version,
			"Xamarin.PlayStation3" => "Xamarin PlayStation 3 " + version,
			"Xamarin.PlayStation4" => "Xamarin PlayStation 4 " + version,
			"Xamarin.PlayStationVita" => "Xamarin PlayStation Vita " + version,
			"Xamarin.Xbox360" => "Xamarin Xbox 360 " + version,
			"Xamarin.XboxOne" => "Xamarin Xbox One " + version,
			"Xamarin.TVOS" => "Xamarin TVOS " + version,
			"Xamarin.WatchOS" => "Xamarin WatchOS " + version,
			_ => framework.Length > 20 ? null : framework + " " + version,
		};
	}

	// A CLR 2.0 module is .NET 2.0, 3.0 or 3.5: which one is told by the assemblies it references (and the
	// assembly it is), looked up in the lists of the assemblies 3.0 and 3.5 added. Unlike dnSpy this does not
	// resolve the references to look at theirs; the module's own are what decides it nearly always.
	static string DotNetVersion2035(ModuleDef module) {
		var version = "2.0";
		foreach (var reference in module.GetAssemblyRefs()) {
			if (DotNet35Assemblies.Contains(reference.FullName))
				return "3.5";
			if (DotNet30Assemblies.Contains(reference.FullName))
				version = "3.0";
		}
		if (module.Assembly is { } assembly && module.IsManifestModule) {
			if (DotNet35Assemblies.Contains(assembly.FullName))
				return "3.5";
			if (DotNet30Assemblies.Contains(assembly.FullName))
				version = "3.0";
		}
		return version;
	}

	static readonly HashSet<string> DotNet30Assemblies = new(StringComparer.OrdinalIgnoreCase) {
		"ComSvcConfig, Version=3.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
		"infocard, Version=3.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"Microsoft.Transactions.Bridge, Version=3.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
		"Microsoft.Transactions.Bridge.Dtc, Version=3.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
		"PresentationBuildTasks, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"PresentationCFFRasterizer, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"PresentationCore, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"PresentationFramework, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"PresentationFramework.Aero, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"PresentationFramework.Classic, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"PresentationFramework.Luna, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"PresentationFramework.Royale, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"PresentationUI, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"ReachFramework, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"ServiceModelReg, Version=3.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
		"SMSvcHost, Version=3.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
		"System.IdentityModel, Version=3.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"System.IdentityModel.Selectors, Version=3.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"System.IO.Log, Version=3.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
		"System.Printing, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"System.Runtime.Serialization, Version=3.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"System.ServiceModel, Version=3.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"System.ServiceModel.Install, Version=3.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"System.ServiceModel.WasHosting, Version=3.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"System.Speech, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"System.Workflow.Activities, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"System.Workflow.ComponentModel, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"System.Workflow.Runtime, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"UIAutomationClient, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"UIAutomationClientsideProviders, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"UIAutomationProvider, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"UIAutomationTypes, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"WindowsBase, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"WindowsFormsIntegration, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"WsatConfig, Version=3.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
	};

	static readonly HashSet<string> DotNet35Assemblies = new(StringComparer.OrdinalIgnoreCase) {
		"AddInProcess, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"AddInProcess32, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"AddInUtil, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"DataSvcUtil, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"EdmGen, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"Microsoft.Build.Conversion.v3.5, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
		"Microsoft.Build.Engine, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
		"Microsoft.Build.Framework, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
		"Microsoft.Build.Tasks.v3.5, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
		"Microsoft.Build.Utilities.v3.5, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
		"Microsoft.Data.Entity.Build.Tasks, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
		"Microsoft.VisualC.STLCLR, Version=1.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
		"MSBuild, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
		"Sentinel.v3.5Client, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
		"System.AddIn, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"System.AddIn.Contract, Version=2.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
		"System.ComponentModel.DataAnnotations, Version=3.5.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"System.Core, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"System.Data.DataSetExtensions, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"System.Data.Entity, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"System.Data.Entity.Design, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"System.Data.Linq, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"System.Data.Services, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"System.Data.Services.Client, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"System.Data.Services.Design, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"System.DirectoryServices.AccountManagement, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"System.Management.Instrumentation, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"System.Net, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a",
		"System.ServiceModel.Web, Version=3.5.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"System.Web.Abstractions, Version=3.5.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"System.Web.DynamicData, Version=3.5.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"System.Web.DynamicData.Design, Version=3.5.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"System.Web.Entity, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"System.Web.Entity.Design, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"System.Web.Extensions, Version=3.5.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"System.Web.Extensions.Design, Version=3.5.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"System.Web.Routing, Version=3.5.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"System.Windows.Presentation, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
		"System.WorkflowServices, Version=3.5.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35",
		"System.Xml.Linq, Version=3.5.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089",
	};
}
