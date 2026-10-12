namespace AnalyzerTarget.Consumer;

// The other side of AnalyzerTarget's members: a subclass across the assembly boundary, a second
// implementation of its interface, and a friend that calls into its internals.

public class Ellipse : Circle {
	public Ellipse() : base(2) { }

	public override double Area() => base.Area() / 2;
}

public sealed class Blob : IShape {
	public double Area() => 0;

	public string Name => "blob";

	public event EventHandler? Changed { add { } remove { } }
}

public static class FriendCalls {
	public static void Hit(Circle circle) => circle.Hit();

	public static double Area(Circle circle) => circle.Area();
}
