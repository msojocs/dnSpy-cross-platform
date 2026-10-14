using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Text;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.LanguageService;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Scripting;
using Microsoft.CodeAnalysis.CSharp.Scripting.Hosting;
using Microsoft.CodeAnalysis.Scripting;
using Microsoft.CodeAnalysis.Scripting.Hosting;
using Microsoft.CodeAnalysis.Text;

namespace dnSpy.Backend.Core;

/// <summary>
/// The engine behind the C# Interactive window: one long-lived Roslyn script session whose variables
/// survive from one submission to the next, the way the WPF REPL keeps a single <c>ScriptState</c>
/// alive for the lifetime of its tool window.
/// </summary>
/// <remarks>
/// The session is global rather than per-workspace, matching the WPF window, and it references the BCL
/// plus this host's own contract assemblies — the cross-platform counterpart of
/// <c>Extensions/dnSpy.Scripting.Roslyn/CSharpInteractive.rsp</c>. Anything else is pulled in by the
/// script itself with <c>#r</c>.
/// </remarks>
public sealed class CSharpScriptService : IDisposable {
	/// <summary>Namespaces the rsp imports, so a submission can use <c>List&lt;int&gt;</c> unqualified.</summary>
	static readonly string[] defaultImports = [
		"System",
		"System.IO",
		"System.Collections.Generic",
		"System.Diagnostics",
		"System.Dynamic",
		"System.Linq",
		"System.Linq.Expressions",
		"System.Text",
		"System.Threading.Tasks",
	];

	/// <summary>Assemblies from this process's own directory that scripts can use without a <c>#r</c>.</summary>
	static readonly string[] defaultReferenceFiles = ["dnSpy.Backend.Contracts.dll", "dnlib.dll"];

	/// <summary>Serialises submissions, because the console redirection below is process-wide state.</summary>
	readonly SemaphoreSlim execution = new(1, 1);
	readonly SemaphoreSlim gate = new(1, 1);
	ScriptSession? current;
	bool disposed;

	/// <summary>Where the running submission writes; null while nothing is running.</summary>
	List<ScriptOutputEntry>? sink;

	/// <summary>The banner the WPF REPL shows when it builds or rebuilds its engine.</summary>
	public static string Banner =>
		$"Microsoft (R) Roslyn C# Compiler version {FileVersionInfo.GetVersionInfo(typeof(CSharpScript).Assembly.Location).FileVersion}";

	public async Task<ScriptEvaluateResponse> EvaluateAsync(string code, CancellationToken cancellationToken) {
		ObjectDisposedException.ThrowIf(disposed, this);
		ArgumentException.ThrowIfNullOrWhiteSpace(code);
		await execution.WaitAsync(cancellationToken).ConfigureAwait(false);
		try {
			var session = await GetSessionAsync(cancellationToken).ConfigureAwait(false);
			var entries = new List<ScriptOutputEntry>();
			using var evaluation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
			session.Evaluation = evaluation;
			sink = entries;
			var previousOut = Console.Out;
			var previousError = Console.Error;
			var stdout = new ScriptOutputWriter(this, ScriptOutputEntry.Output);
			var stderr = new ScriptOutputWriter(this, ScriptOutputEntry.Error);
			try {
				// A script that prints with Console.WriteLine would otherwise write straight into the host's
				// stdout, which is the JSON-RPC channel — one such line and the protocol is corrupt. The
				// server already holds its own handle on the real stream, so redirecting is safe.
				Console.SetOut(stdout);
				Console.SetError(stderr);
				var state = await session.State!.ContinueWithAsync(code, session.Options, evaluation.Token).ConfigureAwait(false);
				// A #reset while this submission was running replaced the session, so its result belongs to
				// an engine nobody is looking at any more. Publishing it would resurrect the old variables.
				if (ReferenceEquals(current, session))
					session.State = state;
				var value = state.ReturnValue;
				if (value is not null)
					entries.Add(new ScriptOutputEntry(ScriptOutputEntry.Result, Format(value)));
			}
			catch (CompilationErrorException ex) {
				// The formatter the WPF window uses, spelled out: in this Roslyn the two-argument overload
				// is the only public one, and passing the current culture keeps the message localized.
				foreach (var diagnostic in ex.Diagnostics)
					entries.Add(new ScriptOutputEntry(ScriptOutputEntry.Error, CSharpDiagnosticFormatter.Instance.Format(diagnostic, CultureInfo.CurrentCulture)));
			}
			catch (Exception ex) when (ex is not OperationCanceledException && ex is not ObjectDisposedException) {
				// Runtime failures carry their own stack, which is the only way to tell where a script threw.
				entries.Add(new ScriptOutputEntry(ScriptOutputEntry.Error, CSharpObjectFormatter.Instance.FormatException(ex)));
			}
			finally {
				// A script that ended without a newline (Console.Write, or a failure mid-line) still has
				// text sitting in the writer. This is not TextWriter.Flush, which the analyzers forbid
				// calling synchronously; it just emits that trailing partial line.
				stdout.WritePending();
				stderr.WritePending();
				sink = null;
				if (ReferenceEquals(session.Evaluation, evaluation))
					session.Evaluation = null;
				Console.SetOut(previousOut);
				Console.SetError(previousError);
			}
			return new ScriptEvaluateResponse(entries);
		}
		finally {
			execution.Release();
		}
	}

	/// <summary>
	/// The semantic colors of input that has not been submitted yet — the WPF window's
	/// <c>OnCommandUpdatedAsync</c>. The input is compiled as the next submission of the session, so a variable an
	/// earlier submission declared is colored as a local and a name that binds to nothing as an error.
	/// </summary>
	/// <remarks>
	/// It does not wait for a running submission: the session's state is replaced, never changed, so reading it
	/// while a submission runs sees the state from before that submission.
	/// </remarks>
	public async Task<ClassifyResponse> ClassifyAsync(string code, CancellationToken cancellationToken) {
		ObjectDisposedException.ThrowIf(disposed, this);
		ArgumentNullException.ThrowIfNull(code);
		if (code.Length == 0)
			return new ClassifyResponse([]);
		var session = await GetSessionAsync(cancellationToken).ConfigureAwait(false);
		return await Task.Run(() => {
			var script = session.State.Script;
			var previous = (CSharpCompilation)script.GetCompilation();
			var syntaxTree = SyntaxFactory.ParseSyntaxTree(code, scriptParseOptions, cancellationToken: cancellationToken);
			var compilation = CSharpCompilation.CreateScriptCompilation("myasm", syntaxTree, null, previous.Options, previous, script.ReturnType, script.GlobalsType);
			var semanticModel = compilation.GetSemanticModel(syntaxTree);
			try {
				return new ClassifyResponse(RoslynClassifier.Classify(semanticModel, LanguageServiceHost.Workspace, new TextSpan(0, code.Length), TextColors.Error, cancellationToken));
			}
			catch (Exception ex) when (ex is not OperationCanceledException) {
				// The WPF window shows uncolored input when the classifier fails; a broken classification
				// must not be what stops the user from running the code.
				return new ClassifyResponse([]);
			}
		}, cancellationToken).ConfigureAwait(false);
	}

	static readonly CSharpParseOptions scriptParseOptions = new(languageVersion: LanguageVersion.Latest, kind: SourceCodeKind.Script);

	/// <summary>
	/// Drops the session and builds a new one, which is what <c>#reset</c> does: the WPF command cancels
	/// the running script and starts over, and so does this one.
	/// </summary>
	public async Task<ScriptEvaluateResponse> ResetAsync() {
		ObjectDisposedException.ThrowIf(disposed, this);
		current?.Cancel();
		await gate.WaitAsync().ConfigureAwait(false);
		try {
			current = null;
		}
		finally {
			gate.Release();
		}
		return new ScriptEvaluateResponse([new ScriptOutputEntry(ScriptOutputEntry.Banner, Banner)]);
	}

	async Task<ScriptSession> GetSessionAsync(CancellationToken cancellationToken) {
		if (current is { } existing)
			return existing;
		await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try {
			if (current is { } raced)
				return raced;
			var options = ScriptOptions.Default
				.WithMetadataResolver(ScriptMetadataResolver.Default.WithBaseDirectory(AppContext.BaseDirectory))
				.WithSourceResolver(ScriptSourceResolver.Default.WithBaseDirectory(AppContext.BaseDirectory))
				.WithImports(defaultImports)
				.WithReferences(CreateDefaultReferences());
			var globals = new ScriptGlobals(this);
			// The empty submission is what anchors the session: every later one is compiled against it,
			// which is how a variable declared in one submission stays in scope for the next.
			var state = await CSharpScript.Create<object>(string.Empty, options, typeof(ScriptGlobals))
				.RunAsync(globals, cancellationToken).ConfigureAwait(false);
			return current = new ScriptSession(options, state);
		}
		finally {
			gate.Release();
		}
	}

	static IEnumerable<MetadataReference> CreateDefaultReferences() {
		var paths = new List<string>();
		if (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") is string trusted)
			paths.AddRange(trusted.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries));
		foreach (var file in defaultReferenceFiles) {
			var path = Path.Combine(AppContext.BaseDirectory, file);
			if (File.Exists(path))
				paths.Add(path);
		}
		return paths
			.Distinct(StringComparer.OrdinalIgnoreCase)
			.Select(path => MetadataReference.CreateFromFile(path));
	}

	/// <summary>Prints a value the way the WPF window does, with the C# object formatter.</summary>
	internal string Format(object value) => CSharpObjectFormatter.Instance.FormatObject(value);

	internal void Write(string kind, string? text) => sink?.Add(new ScriptOutputEntry(kind, text ?? string.Empty));

	void Dispose(bool disposing) {
		if (disposed)
			return;
		disposed = true;
		if (disposing) {
			current?.Cancel();
			execution.Dispose();
			gate.Dispose();
		}
	}

	public void Dispose() {
		Dispose(true);
		GC.SuppressFinalize(this);
	}

	sealed class ScriptSession {
		public ScriptSession(ScriptOptions options, ScriptState<object> state) {
			Options = options;
			State = state;
		}

		public ScriptOptions Options { get; }
		public ScriptState<object> State { get; set; }

		/// <summary>The cancellation source of the submission currently running, if any.</summary>
		public CancellationTokenSource? Evaluation { get; set; }

		public void Cancel() {
			try {
				Evaluation?.Cancel();
			}
			catch (ObjectDisposedException) {
				// The submission finished between the check and the cancel; nothing left to stop.
			}
		}
	}

	/// <summary>Appends every line a script writes to the console to the submission's output.</summary>
	sealed class ScriptOutputWriter : TextWriter {
		readonly CSharpScriptService owner;
		readonly string kind;
		readonly StringBuilder line = new();

		public ScriptOutputWriter(CSharpScriptService owner, string kind) {
			this.owner = owner;
			this.kind = kind;
		}

		public override Encoding Encoding => Encoding.UTF8;

		public override void Write(char value) {
			if (value == '\n') {
				owner.Write(kind, line.ToString().TrimEnd('\r'));
				line.Clear();
				return;
			}
			line.Append(value);
		}

		/// <summary>
		/// Emits the partial line a script left behind when the submission ended mid-line. Kept separate
		/// from <see cref="Flush"/> so the evaluation path can call it without tripping the analyzer that
		/// bans synchronous <c>Flush</c>.
		/// </summary>
		public void WritePending() {
			if (line.Length == 0)
				return;
			owner.Write(kind, line.ToString());
			line.Clear();
		}

		public override void Flush() => WritePending();
	}
}

/// <summary>
/// The host object every script runs against, so a submission can call <c>PrintLine(...)</c> without
/// qualifying it. This is the printing part of the WPF window's <c>IScriptGlobals</c>; the parts that
/// need a WPF dispatcher, message boxes or a service locator have no counterpart here.
/// </summary>
public sealed class ScriptGlobals {
	readonly CSharpScriptService owner;

	internal ScriptGlobals(CSharpScriptService owner) => this.owner = owner;

	public void Print(string? text) => owner.Write(ScriptOutputEntry.Output, text);
	public void Print(object? value) => owner.Write(ScriptOutputEntry.Output, Format(value));
	public void PrintLine(string? text = null) => owner.Write(ScriptOutputEntry.Output, text);
	public void PrintLine(object? value) => owner.Write(ScriptOutputEntry.Output, Format(value));
	public void PrintError(string? text) => owner.Write(ScriptOutputEntry.Error, text);
	public void PrintError(object? value) => owner.Write(ScriptOutputEntry.Error, Format(value));
	public void PrintLineError(string? text = null) => owner.Write(ScriptOutputEntry.Error, text);
	public void PrintLineError(object? value) => owner.Write(ScriptOutputEntry.Error, Format(value));

	string Format(object? value) => value is null ? string.Empty : owner.Format(value);
}
