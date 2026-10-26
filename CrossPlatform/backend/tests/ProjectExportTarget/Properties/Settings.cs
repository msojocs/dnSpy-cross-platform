using System.Configuration;

namespace ProjectExportTarget.Properties;

// What SettingsSingleFileGenerator writes for Settings.settings.
internal sealed class Settings : ApplicationSettingsBase {
	private static readonly Settings defaultInstance = (Settings)Synchronized(new Settings());

	public static Settings Default => defaultInstance;

	[UserScopedSetting]
	[DefaultSettingValue("Hello")]
	public string Greeting {
		get => (string)this["Greeting"];
		set => this["Greeting"] = value;
	}
}
