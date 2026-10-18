namespace dnSpy.Backend.Core;

/// <summary>
/// dnSpy's <c>ResponseFileReader</c> (<c>Extensions/dnSpy.Scripting.Roslyn/Common/ResponseFileReader.cs</c>):
/// the <c>/option:argument</c> and <c>-option argument</c> lines of a script response file, comments and blank
/// lines skipped. A line whose option is not prefixed with '/' or '-' is not an option and is skipped.
/// </summary>
static class ResponseFileReader {
	public static IEnumerable<(string Command, string Arguments)> Read(string filename) {
		if (!File.Exists(filename))
			yield break;
		foreach (var tmp in File.ReadAllLines(filename)) {
			var line = tmp.TrimStart();
			if (string.IsNullOrEmpty(line))
				continue;
			if (line.StartsWith('#'))
				continue;
			var cmd = line;
			string arg1;
			int index = cmd.IndexOf(':');
			if (index < 0)
				arg1 = string.Empty;
			else {
				arg1 = cmd.Substring(index + 1);
				cmd = cmd.Substring(0, index);
			}
			if (cmd.Length == 0)
				continue;
			if (cmd[0] != '/' && cmd[0] != '-')
				continue;
			cmd = cmd.Substring(1);
			yield return (cmd.Trim(), arg1.Trim());
		}
	}
}

/// <summary>dnSpy's <c>RespFileUtils</c>: splits a response file's reference and import arguments.</summary>
static class RespFileUtils {
	public static IEnumerable<string> GetReferencePaths(string s) =>
		s.Split([';', ','], StringSplitOptions.RemoveEmptyEntries).Select(RemoveQuotes);

	public static IEnumerable<string> GetReferences(string s) {
		if (s.Length == 0)
			yield break;
		if (s[0] == '"') {
			yield return RemoveQuotes(s);
			yield break;
		}
		foreach (var x in s.Split([';'], StringSplitOptions.RemoveEmptyEntries))
			yield return x;
	}

	/// <summary>What <c>CSharpControlVM.InitializeUserScriptOptions</c> does with each option name.</summary>
	public static void Apply(string command, string arguments, UserScriptOptions options) {
		switch (command.ToLowerInvariant()) {
		case "r":
		case "reference":
			options.References.AddRange(GetReferences(arguments));
			break;

		case "u":
		case "using":
		case "usings":
		case "import":
		case "imports":
			options.Imports.AddRange(arguments.Split([';'], StringSplitOptions.RemoveEmptyEntries));
			break;

		case "lib":
		case "libpath":
		case "libpaths":
			options.LibPaths.AddRange(GetReferencePaths(arguments));
			break;

		case "loadpath":
		case "loadpaths":
			options.LoadPaths.AddRange(GetReferencePaths(arguments));
			break;
		}
	}

	static string RemoveQuotes(string s) {
		if (s.Length == 0 || s[0] != '"')
			return s;
		s = s.Substring(1);
		if (s.Length > 0 && s[^1] == '"')
			s = s.Substring(0, s.Length - 1);
		return s;
	}
}

/// <summary>What a response file asks the execution engine for, before it becomes <c>ScriptOptions</c>.</summary>
sealed class UserScriptOptions {
	public List<string> References { get; } = [];
	public List<string> Imports { get; } = [];
	public List<string> LibPaths { get; } = [];
	public List<string> LoadPaths { get; } = [];
}
