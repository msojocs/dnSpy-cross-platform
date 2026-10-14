using System.Reflection;

[assembly: AssemblyMetadata("assembly key", "assembly value")]
[module: StringTarget.Note("module note")]

namespace StringTarget;

[AttributeUsage(AttributeTargets.All, AllowMultiple = true)]
public sealed class NoteAttribute(string text) : Attribute {
	public string Text { get; } = text;
	public string? Extra { get; set; }
	public string[]? Many { get; set; }
}

[Note("type note", Extra = "named extra", Many = ["first of many", "second of many"])]
public class Holder<[Note("generic note")] T> {
	public const string Constant = "field constant";

	[Note("field note")]
	public int Field;

	public string Greet(string name = "default name") => "Hello, " + name;

	public string Path() => @"C:\temp\file.txt";

	public string Escaped() => "line\nbreak \"quoted\"";

	[return: Note("return note")]
	public Func<string> Later() => () => "inside lambda";

	public string Empty() => "";
}
