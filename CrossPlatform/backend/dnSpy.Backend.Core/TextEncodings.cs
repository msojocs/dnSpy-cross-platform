using System.Text;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core;

/// <summary>
/// The encodings of dnSpy's hex options page (GeneralAppSettingsPageBase's EncodingInfo list) and what typing or pasting
/// into the hex editor's ASCII column writes (HexViewOptions.TryGetEncoding, then Encoding.GetBytes).
/// </summary>
public static class TextEncodings {
	static TextEncodings() =>
		// .NET Framework, which dnSpy runs on, has every Windows code page; .NET has them once this provider is there.
		Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

	/// <summary>Every encoding, sorted by display name in the current culture, ignoring case, as dnSpy lists them.</summary>
	public static EncodingListResponse GetEncodings() {
		var encodings = Encoding.GetEncodings()
			.Select(info => new EncodingInfoDto(info.CodePage, info.Name, info.DisplayName))
			.OrderBy(info => info.DisplayName, StringComparer.CurrentCultureIgnoreCase)
			.ToArray();
		return new EncodingListResponse(encodings);
	}

	public static EncodeTextResponse Encode(EncodeTextRequest request) {
		ArgumentNullException.ThrowIfNull(request);
		Encoding encoding;
		try {
			encoding = Encoding.GetEncoding(request.CodePage);
		}
		catch (Exception ex) when (ex is ArgumentException or NotSupportedException) {
			throw new RpcException(ErrorCodes.InvalidParams, $"Unknown code page {request.CodePage}.", null, ex);
		}
		return new EncodeTextResponse(Convert.ToBase64String(encoding.GetBytes(request.Text ?? string.Empty)));
	}
}
