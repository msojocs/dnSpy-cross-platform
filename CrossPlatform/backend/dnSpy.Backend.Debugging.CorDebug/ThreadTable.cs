using System.Globalization;
using System.Runtime.InteropServices;
using ICorDebugSharp;
using ICorDebugSharp.Extensions;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>
/// Tracks the threads the runtime reports through <c>CreateThread</c>/<c>ExitThread</c>.
/// Lookups are by the runtime's thread id, which is what the client uses in stack trace requests.
/// </summary>
internal sealed class ThreadTable {
	readonly object gate = new();
	readonly Dictionary<int, ICorDebugThread> threads = new();
	/// <summary>The names the user gave threads in the Threads window, which win over the program's own.</summary>
	readonly Dictionary<int, string> userNames = new();
	/// <summary>The order threads were first seen in: the first one is the main thread.</summary>
	readonly Dictionary<int, int> creationOrder = new();
	int order;

	public void Add(ICorDebugThread thread) {
		if (TryGetId(thread) is not int id)
			return;
		lock (gate) {
			threads[id] = thread;
			if (!creationOrder.ContainsKey(id))
				creationOrder[id] = ++order;
		}
	}

	public void Remove(ICorDebugThread thread) {
		if (TryGetId(thread) is not int id)
			return;
		lock (gate) {
			threads.Remove(id);
			userNames.Remove(id);
		}
	}

	public IReadOnlyList<(int Id, ICorDebugThread Thread)> Snapshot() {
		lock (gate)
			return threads.OrderBy(pair => creationOrder.GetValueOrDefault(pair.Key)).ThenBy(pair => pair.Key).Select(pair => (pair.Key, pair.Value)).ToArray();
	}

	public ICorDebugThread? Find(int id) {
		lock (gate)
			return threads.TryGetValue(id, out var thread) ? thread : null;
	}

	/// <summary>True for the first thread the process had, which the Threads window calls the main thread.</summary>
	public bool IsMainThread(int id) {
		lock (gate)
			return creationOrder.Count > 0 && creationOrder.TryGetValue(id, out var position) && position == creationOrder.Values.Min();
	}

	public void SetUserName(int id, string? name) {
		lock (gate) {
			if (string.IsNullOrEmpty(name))
				userNames.Remove(id);
			else
				userNames[id] = name;
		}
	}

	public string? GetUserName(int id) {
		lock (gate)
			return userNames.TryGetValue(id, out var name) ? name : null;
	}

	public void Clear() {
		lock (gate) {
			threads.Clear();
			userNames.Clear();
			creationOrder.Clear();
		}
	}

	public static string Describe(int id) => $"Thread {id.ToString(CultureInfo.InvariantCulture)}";

	/// <summary>Reads the runtime thread id, or <c>null</c> if the thread has already gone away.</summary>
	internal static int? TryGetId(ICorDebugThread thread) {
		try {
			return thread.Id;
		}
		catch (Exception ex) when (ex is COMException or InvalidCastException or InvalidOperationException or NotSupportedException) {
			return null;
		}
	}
}
