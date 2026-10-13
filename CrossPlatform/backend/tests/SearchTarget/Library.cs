using System.Runtime.InteropServices;

[assembly: SearchTarget.Note("assembly-note-needle")]

namespace SearchTarget;

// Global functions and fields for testing search. These are in a static class to make them accessible
// but they will appear in the <Module> type in the compiled assembly.
static class GlobalMembers {
	internal static int GlobalField = 999;
	internal static string GlobalFunction() => "global-function-needle";
}

// Every member here is something a search test expects to find, or expects not to find; the names and the
// literals are what the tests look for.

[AttributeUsage(AttributeTargets.All)]
public sealed class NoteAttribute(string text) : Attribute {
	public string Text => text;
}

public class Library {
	public const int Answer = 4242;
	public const string Greeting = "field-literal-needle";

	public string Title { get; init; } = "";

	public int this[int index] => index;

	public event EventHandler? Opened;

	public static Library operator +(Library left, Library right) => left;

	public static implicit operator string(Library value) => value.Title;

	public string Describe(int count, [Note("param-note-needle")] string label = "x", params object[] rest) {
		var describedCount = count * 31337;
		return "body-literal-needle" + describedCount + label + rest.Length;
	}

	public double Ratio() => 2.718;

	public IEnumerable<int> Counter() {
		yield return 1;
	}

	public Func<int> Lambda() => () => 9001;

	[DllImport("libsearch", EntryPoint = "native_entry")]
	public static extern int NativeCall();

	public void Raise() => Opened?.Invoke(this, EventArgs.Empty);

	public class Nested<T> {
		public T? Value;
	}
}

public enum Color {
	Red,
	Green,
}

public interface IThing {
}

public struct Point {
	public int X;
}

public delegate void Handler();

public class Generic<TKey, TValue> {
}
