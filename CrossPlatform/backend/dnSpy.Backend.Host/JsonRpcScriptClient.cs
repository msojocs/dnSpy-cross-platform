using System.Text.Json;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Host;

/// <summary>
/// The script engine's client: the frames the host writes for it. The engine needs the server before the
/// server exists — it is one of the server's own dependencies — so <see cref="Server"/> is attached after
/// both are built.
/// </summary>
internal sealed class JsonRpcScriptClient : IScriptClient {
	public JsonRpcServer? Server { get; set; }

	/// <summary>
	/// Streams one line. The write is synchronous because it happens on the script's own thread, between the
	/// script's statements: the line has to be on the wire before the submission that printed it can finish, or
	/// a client would see output after the result it led to.
	/// </summary>
	public void WriteOutput(int generation, ScriptOutputEntry entry) {
		if (Server is null || inWrite)
			return;
		inWrite = true;
		try {
#pragma warning disable VSTHRD002 // The frame write completes synchronously; see JsonRpcServer.WriteNotificationAsync.
			Server.WriteScriptOutputAsync(new ScriptOutputNotification(generation, entry)).GetAwaiter().GetResult();
#pragma warning restore VSTHRD002
		}
		finally {
			inWrite = false;
		}
	}

	/// <summary>
	/// A write that fails while the host is already writing a line must not log through the console the script's
	/// output has been routed to — that would call this method again, forever. Only the one frame is lost.
	/// </summary>
	[ThreadStatic]
	static bool inWrite;

	/// <summary>Asks the window a question; without a server, there is no window and the box is closed.</summary>
	public Task<JsonElement?> RequestAsync(string method, JsonElement parameters, CancellationToken cancellationToken) =>
		Server?.RequestClientAsync(method, parameters, cancellationToken) ?? Task.FromResult<JsonElement?>(null);
}
