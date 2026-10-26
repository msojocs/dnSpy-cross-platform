using System.Globalization;
using System.Resources;

namespace ProjectExportTarget;

// What ResXFileCodeGenerator writes for Strings.resx.
internal class Strings {
	private static ResourceManager? resourceMan;
	private static CultureInfo? resourceCulture;

	internal static ResourceManager ResourceManager {
		get {
			if (resourceMan is null)
				resourceMan = new ResourceManager("ProjectExportTarget.Strings", typeof(Strings).Assembly);
			return resourceMan;
		}
	}

	internal static CultureInfo? Culture {
		get => resourceCulture;
		set => resourceCulture = value;
	}

	internal static string Greeting => ResourceManager.GetString("Greeting", resourceCulture) ?? string.Empty;
}
