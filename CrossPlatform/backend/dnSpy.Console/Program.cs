using System.Text;

namespace dnSpy.Cli;

/// <summary>
/// The executable the WPF build ships beside dnSpy.exe. It exports a project or writes one type or
/// member to stdout; see <see cref="DnSpyConsole"/> for the switches (dnSpy.Console's own).
/// </summary>
static class Program {
	static int Main(string[] args) {
		if (!dnlib.Settings.IsThreadSafe) {
			Console.WriteLine("dnlib wasn't compiled with THREAD_SAFE defined");
			return 1;
		}

		var oldEncoding = Console.OutputEncoding;
		try {
			// Russian and Chinese names in the metadata and in the help must survive the console.
			Console.OutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
			return new DnSpyConsole(Console.Out, Console.Error).Run(args);
		}
		catch (Exception ex) {
			Console.Error.WriteLine(ex);
			return 1;
		}
		finally {
			Console.OutputEncoding = oldEncoding;
		}
	}
}
