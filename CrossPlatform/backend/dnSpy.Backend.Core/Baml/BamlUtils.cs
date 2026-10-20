// Ported unchanged from dnSpy (Extensions/dnSpy.BamlDecompiler/Baml/BamlUtils.cs); written before nullable annotations.
#nullable disable

namespace dnSpy.Backend.Core.Baml {
	static class BamlUtils {
		internal static short GetKnownResourceIdFromBamlId(ushort bamlId, out bool isKey) {
			short resourceId = unchecked((short)-bamlId);
			isKey = true;
			if (resourceId > 232 && resourceId < 464) {
				resourceId -= 232;
				isKey = false;
			}
			else if (resourceId > 464 && resourceId < 467) {
				resourceId -= 231;
			}
			else if (resourceId > 467 && resourceId < 470) {
				resourceId -= 234;
				isKey = false;
			}
			return resourceId;
		}
	}
}
