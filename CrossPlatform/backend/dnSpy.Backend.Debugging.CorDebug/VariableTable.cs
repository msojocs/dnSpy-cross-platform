using ICorDebugSharp;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>Something the client can ask for by <c>variablesReference</c>.</summary>
internal abstract record VariableEntry;

/// <summary>The arguments and locals of a frame, read at the moment the client asks.</summary>
internal sealed record FrameScopeEntry(int ThreadId, int FrameIndex) : VariableEntry;

/// <summary>A row of a variables window whose children the client can ask for.</summary>
internal sealed record NodeEntry(Evaluation.ValueNode Node, int ThreadId, int FrameIndex) : VariableEntry;

/// <summary>One array, whose elements are read one by one as the client expands them.</summary>
internal sealed record ArrayEntry(ICorDebugArrayValue Value, int Count) : VariableEntry;

/// <summary>
/// Hands out the references DAP uses to address a set of variables.
/// </summary>
/// <remarks>
/// Values are read lazily rather than when a stop happens: a stack with a thousand locals would
/// otherwise be walked in full for every stop, including the ones nobody looks at. A reference is
/// only valid while the process is stopped — the values it leads to are COM objects owned by the
/// runtime — so the table is cleared whenever the process is resumed.
/// </remarks>
internal sealed class VariableTable {
	readonly object gate = new();
	readonly Dictionary<int, VariableEntry> entries = new();
	int sequence;

	public int Add(VariableEntry entry) {
		lock (gate) {
			var reference = ++sequence;
			entries[reference] = entry;
			return reference;
		}
	}

	public VariableEntry? Find(int reference) {
		lock (gate)
			return entries.TryGetValue(reference, out var entry) ? entry : null;
	}

	public void Clear() {
		lock (gate)
			entries.Clear();
	}
}
