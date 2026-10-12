using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

[assembly: InternalsVisibleTo("AnalyzerTarget.Consumer")]
[assembly: AnalyzerTarget.Marker(Level = 7)]

namespace AnalyzerTarget;

// Every shape here exists for a search the analyzer tests run against it; a member that looks unused is
// what some search is expected to find, or not to find.

[AttributeUsage(AttributeTargets.All)]
public sealed class MarkerAttribute : Attribute {
	public int Level { get; set; }
	public string? Note;
}

public interface IShape {
	double Area();
	string Name { get; }
	event EventHandler? Changed;
}

public abstract class Shape : IShape {
	public abstract double Area();
	public virtual string Name => "shape";
	public event EventHandler? Changed;
	protected void OnChanged() => Changed?.Invoke(this, EventArgs.Empty);
	public virtual void Describe() { }
}

[Marker(Level = 1)]
public class Circle : Shape {
	public const double Pi = 3.14;
	public double Radius;
	internal int hits;

	public Circle(double radius) => Radius = radius;

	public override double Area() => Pi * Radius * Radius;

	public override string Name => "circle";

	public new void Describe() { }

	internal void Hit() => hits++;

	public void Grow() {
		Radius *= 2;
		OnChanged();
	}
}

public sealed class Square : IShape {
	double IShape.Area() => 4;
	string IShape.Name => "square";
	event EventHandler? IShape.Changed { add { } remove { } }
}

public static class ShapeExtensions {
	public static double Diameter(this Circle circle) => circle.Radius * 2;
}

public class Exposer {
	public Circle? Field;
	public Circle? Property { get; set; }
	public Circle Make() => new Circle(1);
}

public static class Usage {
	public static double Total(IShape shape) => shape.Area();
	public static double Sum(Shape shape) => shape.Area();
	public static Func<double> Lambda(Circle circle) => () => circle.Area();

	public static IEnumerable<double> Iterate(Circle circle) {
		yield return circle.Radius;
	}

	[Marker(Note = "annotated")]
	public static void Annotated() { }

	[DllImport("libc", EntryPoint = "getpid")]
	public static extern int GetPid();

	public static int CallPid() => GetPid();

	public static string Indexed(Box<string> box) => box[0];
}

public class Box<T> {
	readonly T[] items = new T[1];

	public T this[int index] {
		get => items[index];
		set => items[index] = value;
	}
}

public class Outer {
	int secret = 1;

	public int Read() => secret;

	public void Use() => new Hidden().Run();

	sealed class Hidden {
		public void Run() { }
	}
}
