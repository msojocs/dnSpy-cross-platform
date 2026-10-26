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

// Ported from dnSpy (dnSpy/dnSpy.Decompiler/MSBuild/SettingsProjectFile.cs).

using System.Text;
using System.Xml;
using System.Xml.Linq;
using System.Xml.XPath;
using dnlib.DotNet;

namespace dnSpy.Backend.Core.ProjectExport;

/// <summary>
/// The .settings file of an ApplicationSettingsBase class, rebuilt from the attributes on its properties — what
/// Visual Studio's settings designer generated the class from.
/// </summary>
sealed class SettingsProjectFile(TypeDef type, string filename) : ProjectFile {
	public override string Description => $"Create {Path.GetFileName(filename)}";
	public override BuildAction BuildAction => BuildAction.None;
	public override string Filename => filename;

	sealed class Setting {
		public string? Name { get; set; }
		public string? Description { get; set; }
		public string? Provider { get; set; }
		public bool Roaming { get; set; }
		public bool GenerateDefaultValueInCode { get; set; } = true;
		public string? Type { get; set; }
		public string? Scope { get; set; }
		public Value? Value { get; set; }
		public Value? DesignTimeValue { get; set; }
	}

	sealed class Value {
		public string? Profile { get; set; }
		public string? Text { get; set; }
	}

	// System.Configuration's SettingsManageability and SpecialSetting, which the runtime here does not carry.
	const int SettingsManageabilityRoaming = 0;
	const int SpecialSettingConnectionString = 0;
	const int SpecialSettingWebServiceUrl = 1;

	const string DEFAULT_PROFILE = "(Default)";

	protected override void Create(DecompileContext ctx) {
		var settings = new XmlWriterSettings {
			Encoding = Encoding.UTF8,
			Indent = true,
		};
		using (var writer = XmlWriter.Create(filename, settings)) {
			writer.WriteProcessingInstruction("xml", "version='1.0' encoding='utf-8'");
			writer.WriteStartElement("SettingsFile", "http://schemas.microsoft.com/VisualStudio/2004/01/settings");
			writer.WriteAttributeString("CurrentProfile", DEFAULT_PROFILE);
			writer.WriteAttributeString("GeneratedClassNamespace", type.ReflectionNamespace);
			writer.WriteAttributeString("GeneratedClassName", type.ReflectionName);
			writer.WriteStartElement("Profiles");
			writer.WriteEndElement();
			writer.WriteStartElement("Settings");
			foreach (var setting in FindSettings()) {
				writer.WriteStartElement("Setting");
				writer.WriteAttributeString("Name", setting.Name);
				if (!string.IsNullOrEmpty(setting.Description))
					writer.WriteAttributeString("Description", setting.Description);
				if (!string.IsNullOrEmpty(setting.Provider))
					writer.WriteAttributeString("Provider", setting.Provider);
				if (setting.Roaming)
					writer.WriteAttributeString("Roaming", "true");
				if (!setting.GenerateDefaultValueInCode)
					writer.WriteAttributeString("GenerateDefaultValueInCode", "false");
				writer.WriteAttributeString("Type", setting.Type);
				writer.WriteAttributeString("Scope", setting.Scope);
				if (setting.DesignTimeValue is not null) {
					writer.WriteStartElement("DesignTimeValue");
					writer.WriteAttributeString("Profile", setting.DesignTimeValue.Profile);
					writer.WriteString(setting.DesignTimeValue.Text);
					writer.WriteEndElement();
				}
				writer.WriteStartElement("Value");
				writer.WriteAttributeString("Profile", setting.Value?.Profile ?? "???");
				writer.WriteString(setting.Value?.Text ?? "???");
				writer.WriteEndElement();
				writer.WriteEndElement();
			}
			writer.WriteEndElement();
			writer.WriteEndElement();
			writer.WriteEndDocument();
		}
	}

	IEnumerable<Setting> FindSettings() {
		foreach (var prop in type.Properties) {
			var propType = prop.PropertySig.GetRetType().RemovePinnedAndModifiers();
			if (propType is null)
				continue;
			var settingsType = propType.ReflectionFullName;

			var ca = prop.CustomAttributes.Find("System.Configuration.DefaultSettingValueAttribute");
			if (ca is null || ca.ConstructorArguments.Count != 1)
				continue;
			var arg = ca.ConstructorArguments[0];
			if (arg.Type.RemovePinnedAndModifiers().GetElementType() != ElementType.String)
				continue;
			var defaultValue = (arg.Value as UTF8String)?.String ?? arg.Value as string;
			if (defaultValue is null)
				continue;

			var generateDefaultValueInCode = true;

			var hasUserScopedAttr = prop.CustomAttributes.IsDefined("System.Configuration.UserScopedSettingAttribute");
			var hasAppScopedAttr = prop.CustomAttributes.IsDefined("System.Configuration.ApplicationScopedSettingAttribute");
			if (!hasUserScopedAttr && !hasAppScopedAttr)
				continue;

			var roaming = false;
			ca = prop.CustomAttributes.Find("System.Configuration.SettingsManageabilityAttribute");
			if (ca is not null && ca.ConstructorArguments.Count == 1) {
				arg = ca.ConstructorArguments[0];
				var argType = arg.Type.RemovePinnedAndModifiers();
				if (argType is not null && argType.ReflectionFullName == "System.Configuration.SettingsManageability" && arg.Value is int v && v == SettingsManageabilityRoaming)
					roaming = true;
			}

			var setting = new Setting();

			ca = prop.CustomAttributes.Find("System.Configuration.SpecialSettingAttribute");
			if (ca is not null && ca.ConstructorArguments.Count == 1) {
				arg = ca.ConstructorArguments[0];
				var argType = arg.Type.RemovePinnedAndModifiers();
				if (argType is not null && argType.ReflectionFullName == "System.Configuration.SpecialSetting" && arg.Value is int v) {
					switch (v) {
					case SpecialSettingConnectionString:
						settingsType = "(Connection string)";
						var designTimeValue = GetConnectionStringDesignTimeValue(prop);
						if (designTimeValue is not null) {
							setting.DesignTimeValue = new Value {
								Profile = DEFAULT_PROFILE,
								Text = designTimeValue,
							};
						}
						break;
					case SpecialSettingWebServiceUrl:
						settingsType = "(Web Service URL)";
						break;
					}
				}
			}

			string? provider = null;
			ca = prop.CustomAttributes.Find("System.Configuration.SettingsProviderAttribute");
			if (ca is not null && ca.ConstructorArguments.Count == 1) {
				arg = ca.ConstructorArguments[0];
				var argType = arg.Type.RemovePinnedAndModifiers();
				if (argType.GetElementType() == ElementType.String)
					provider = (arg.Value as UTF8String)?.String ?? arg.Value as string;
				else if (argType is not null && argType.FullName == "System.Type" && arg.Value is TypeDefOrRefSig t && t.TypeDefOrRef is not null)
					provider = t.TypeDefOrRef.ReflectionFullName;
			}

			string? description = null;
			ca = prop.CustomAttributes.Find("System.Configuration.SettingsDescriptionAttribute");
			if (ca is not null && ca.ConstructorArguments.Count == 1) {
				arg = ca.ConstructorArguments[0];
				if (arg.Type.RemovePinnedAndModifiers().GetElementType() == ElementType.String)
					description = (arg.Value as UTF8String)?.String ?? arg.Value as string;
			}

			setting.Name = prop.Name;
			setting.Description = description;
			setting.Provider = provider;
			setting.Roaming = roaming;
			setting.GenerateDefaultValueInCode = generateDefaultValueInCode;
			setting.Type = settingsType;
			setting.Scope = hasUserScopedAttr ? "User" : "Application";
			setting.Value = new Value {
				Profile = DEFAULT_PROFILE,
				Text = defaultValue,
			};
			yield return setting;
		}
	}

	string? GetConnectionStringDesignTimeValue(PropertyDef prop) {
		toConnectionStringInfo ??= InitializeConnectionStringDesignTimeValues();
		if (!toConnectionStringInfo.TryGetValue(prop.Name, out var info))
			return null;
		return string.Format(System.Globalization.CultureInfo.InvariantCulture, connectionIdStringFormat, EscapeXmlString(info.String), EscapeXmlString(info.ProviderName));
	}
	Dictionary<string, (string String, string ProviderName)>? toConnectionStringInfo;
	const string connectionIdStringFormat = "<?xml version=\"1.0\" encoding=\"utf-16\"?>\r\n<SerializableConnectionString xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\">\r\n  <ConnectionString>{0}</ConnectionString>\r\n  <ProviderName>{1}</ProviderName>\r\n</SerializableConnectionString>";

	static string EscapeXmlString(string? s) {
		var el = new XmlDocument().CreateElement("a");
		el.InnerText = s ?? string.Empty;
		return el.InnerXml;
	}

	Dictionary<string, (string String, string ProviderName)> InitializeConnectionStringDesignTimeValues() {
		var result = new Dictionary<string, (string, string)>(StringComparer.Ordinal);
		var configFile = type.Module.Location + ".config";
		if (!File.Exists(configFile))
			return result;
		try {
			var doc = XDocument.Load(configFile, LoadOptions.None);
			var prefix = type.ReflectionFullName + ".";
			foreach (var e in doc.XPathSelectElements("/configuration/connectionStrings/add")) {
				var name = (string?)e.Attribute("name");
				if (name is null || !name.StartsWith(prefix, StringComparison.Ordinal))
					continue;
				var connectionString = (string?)e.Attribute("connectionString");
				var providerName = (string?)e.Attribute("providerName");
				if (connectionString is null || providerName is null)
					continue;
				result.TryAdd(name[prefix.Length..], (connectionString, providerName));
			}
		}
		catch (Exception ex) when (ex is IOException or XmlException or UnauthorizedAccessException or ArgumentException) {
		}
		return result;
	}
}
