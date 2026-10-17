using System.Text.Json;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>
/// How the engine writes its replies: camel-cased like the rest of the protocol, so a record nested in a body —
/// a <c>TextPartDto</c> in a value's coloured parts — reaches the client as <c>{ text, color }</c>.
/// </summary>
static class DebugJson {
	public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

	public static JsonElement Serialize<T>(T value) => JsonSerializer.SerializeToElement(value, Options);
}
