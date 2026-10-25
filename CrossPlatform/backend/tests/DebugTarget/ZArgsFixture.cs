using System.Runtime.CompilerServices;

namespace DebugTarget;

/// <summary>
/// Prints the arguments the process was started with when <c>--echo-args</c> is present. A module
/// initializer of its own keeps Program's pinned lines where they are.
/// </summary>
internal static class ArgsFixture {
	[ModuleInitializer]
	internal static void EchoWhenAsked() {
		var args = Environment.GetCommandLineArgs();
		if (!args.Contains("--echo-args", StringComparer.Ordinal))
			return;
		Console.WriteLine("ARGS:" + string.Join("|", args.Skip(1)));
		Console.Out.Flush();
	}
}
