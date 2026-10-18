using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Text;
using System.Text.Json;
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

/// <summary>Where the session looks for its response file and for the scripts a <c>#load</c> or <c>#r</c> names.</summary>
public sealed record ScriptServiceOptions {
	/// <summary>The directories a <c>CSharpInteractive.rsp</c> is looked up in, in this order.</summary>
	public IReadOnlyList<string> ResponseFileDirectories { get; init; } = DefaultResponseFileDirectories();

	/// <summary>The directories a relative <c>#load</c> or <c>#r</c> path is resolved against.</summary>
	public IReadOnlyList<string> SearchPaths { get; init; } = DefaultSearchPaths();

	/// <summary>The response file's name, relative to one of <see cref="ResponseFileDirectories"/>.</summary>
	public string ResponseFileName { get; init; } = "CSharpInteractive.rsp";

	/// <summary>
	/// dnSpy's script directories (<c>ScriptControlVM.GetDefaultScriptFilePaths</c>): the user's
	/// <c>scripts</c> directory and home directory, then the data and binary directories' <c>scripts</c>.
	/// </summary>
	public static IReadOnlyList<string> DefaultSearchPaths() {
		const string SCRIPTS_DIR = "scripts";
		var result = new List<string>();
		var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
		if (!string.IsNullOrEmpty(userProfile)) {
			result.Add(Path.Combine(userProfile, SCRIPTS_DIR));
			result.Add(userProfile);
		}
		result.Add(Path.Combine(DataDirectory(), SCRIPTS_DIR));
		result.Add(Path.Combine(AppContext.BaseDirectory, SCRIPTS_DIR));
		return result;
	}

	/// <summary>dnSpy's <c>AppDirectories.GetDirectories</c>: the binary directory, then the data directory.</summary>
	public static IReadOnlyList<string> DefaultResponseFileDirectories() {
		var result = new List<string> { AppContext.BaseDirectory };
		var dataDirectory = DataDirectory();
		if (!StringComparer.OrdinalIgnoreCase.Equals(dataDirectory, AppContext.BaseDirectory))
			result.Add(dataDirectory);
		return result;
	}

	/// <summary>The host's settings directory, the counterpart of dnSpy's <c>%APPDATA%\dnSpy</c>.</summary>
	static string DataDirectory() {
		var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
		return string.IsNullOrEmpty(appData) ? AppContext.BaseDirectory : Path.Combine(appData, "dnSpy");
	}
}

/// <summary>
/// The services a script can resolve by name, dnSpy's <c>IServiceLocator</c>. The host registers the ones that
/// make sense without a Windows UI — the workspace, so a script can read the assemblies that are open.
/// </summary>
public sealed class ScriptServices {
	readonly ConcurrentDictionary<Type, object> services = new();

	/// <summary>Makes <paramref name="service"/> resolvable as <typeparamref name="T"/>.</summary>
	public void Register<T>(T service) where T : class => services[typeof(T)] = service;

	/// <summary>Forgets the service registered as <typeparamref name="T"/>.</summary>
	public void Unregister<T>() where T : class => services.TryRemove(typeof(T), out _);

	internal T? TryResolve<T>() where T : class => services.TryGetValue(typeof(T), out var service) ? (T)service : null;
}

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
	/// <summary>Namespaces the session imports even without a response file.</summary>
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
		// The colors Print takes, and the services Resolve returns.
		"dnSpy.Backend.Contracts",
		"dnSpy.Backend.Core",
	];

	/// <summary>Assemblies from this process's own directory that scripts can use without a <c>#r</c>.</summary>
	static readonly string[] defaultReferenceFiles = ["dnSpy.Backend.Contracts.dll", "dnSpy.Backend.Core.dll", "dnlib.dll"];

	/// <summary>The generation of the session the client is talking to, bumped by every session.</summary>
	int generation;

	readonly SemaphoreSlim gate = new(1, 1);
	readonly IScriptClient? client;
	readonly ScriptServiceOptions options;
	ScriptSession? current;
	bool disposed;

	/// <summary>The services a script's <c>Resolve&lt;T&gt;()</c> answers from.</summary>
	public ScriptServices Services { get; } = new();

	/// <summary>The banner the WPF REPL shows when it builds or rebuilds its engine.</summary>
	public static string Banner =>
		$"Microsoft (R) Roslyn C# Compiler version {FileVersionInfo.GetVersionInfo(typeof(CSharpScript).Assembly.Location).FileVersion}";

	/// <summary>
	/// <paramref name="client"/> is how the window sees output while it is still being produced, and how a
	/// script's message box reaches the user; without one the engine is headless and answers the UI methods as
	/// if the user had closed the box.
	/// </summary>
	public CSharpScriptService(IScriptClient? client = null, ScriptServiceOptions? options = null) {
		this.client = client;
		this.options = options ?? new ScriptServiceOptions();
		ConsoleRouter.Acquire();
	}

	public async Task<ScriptEvaluateResponse> EvaluateAsync(string code, CancellationToken cancellationToken) {
		ObjectDisposedException.ThrowIf(disposed, this);
		ArgumentException.ThrowIfNullOrWhiteSpace(code);
		var session = await GetSessionAsync(cancellationToken).ConfigureAwait(false);
		// A reset while this submission waited behind an earlier one cancels it rather than leaving it
		// queued behind a script that may never end.
		using var wait = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, session.Token);
		await session.Execution.WaitAsync(wait.Token).ConfigureAwait(false);
		var collected = new List<ScriptOutputEntry>();
		try {
			if (!session.Alive)
				return new ScriptEvaluateResponse([], session.Generation);
			using var evaluation = CancellationTokenSource.CreateLinkedTokenSource(wait.Token);
			session.BeginCollecting(collected);
			ConsoleRouter.Enter(session);
			try {
				var state = await session.State!.ContinueWithAsync(code, session.Options, evaluation.Token).ConfigureAwait(false);
				// A #reset while this submission was running replaced the session, so its result belongs to
				// an engine nobody is looking at any more. Publishing it would resurrect the old variables.
				if (session.Alive) {
					session.State = state;
					var value = state.ReturnValue;
					if (value is not null)
						session.PrintObject(ScriptOutputEntry.Result, value, session.Globals.PrintOptions, TextColor.ReplOutputText, newLine: true);
				}
			}
			catch (CompilationErrorException ex) {
				PrintDiagnostics(session, ex.Diagnostics);
			}
			catch (Exception ex) when (ex is not OperationCanceledException && ex is not ObjectDisposedException) {
				// Runtime failures carry their own stack, which is the only way to tell where a script threw.
				session.Write(ScriptOutputEntry.Error, CSharpObjectFormatter.Instance.FormatException(ex) + Environment.NewLine, ScriptTextColors.Name(TextColor.Error));
			}
			finally {
				session.FlushConsole();
				session.EndCollecting();
				ConsoleRouter.Exit();
			}
			// A client has already received every line as it was produced; the response is what a headless
			// caller (a test, or a host without a window) reads instead.
			return new ScriptEvaluateResponse(Client is null ? collected.ToArray() : [], session.Generation);
		}
		finally {
			session.Execution.Release();
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
			var script = session.State!.Script;
			var previous = (CSharpCompilation)script.GetCompilation();
			var syntaxTree = SyntaxFactory.ParseSyntaxTree(code, scriptParseOptions, cancellationToken: cancellationToken);
			var compilation = CSharpCompilation.CreateScriptCompilation("myasm", syntaxTree, null, previous.Options, previous, script.ReturnType, script.GlobalsType);
			var semanticModel = compilation.GetSemanticModel(syntaxTree);
			try {
				return new ClassifyResponse(RoslynClassifier.Classify(semanticModel, LanguageServiceHost.Workspace, new TextSpan(0, code.Length), ScriptTextColors.Name(TextColor.Error), cancellationToken));
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
	/// dnSpy's <c>ScriptControlVM.IsCommand</c>: whether Enter turns the input into a submission. A
	/// <c>#command</c> is one; so is code whose syntax is complete — <c>if (x) {</c> is not.
	/// </summary>
	public static bool IsCompleteSubmission(string code) =>
		SyntaxFactory.IsCompleteSubmission(SyntaxFactory.ParseSyntaxTree(code, scriptParseOptions));

	/// <summary>
	/// Drops the session and builds a new one, which is what <c>#reset</c> does: the WPF command cancels
	/// the running script and starts over, and so does this one. <paramref name="showBanner"/> is the window
	/// opening rather than a reset, which is the one case that prints the engine banner.
	/// </summary>
	public async Task<ScriptResetResponse> ResetAsync(bool loadConfig = true, bool showBanner = false, CancellationToken cancellationToken = default) {
		ObjectDisposedException.ThrowIf(disposed, this);
		await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try {
			var old = current;
			current = null;
			if (old is not null) {
				// dnSpy's order: cancel, let the script unregister (its output still reaches the window), and
				// only then is the old engine unreachable.
				old.Cancel();
				try {
					old.Globals.RaiseScriptResetting();
				}
				catch {
					// A script that unregisters badly must not stop the reset.
				}
				old.Shutdown();
			}
			var entries = new List<ScriptOutputEntry>();
			// The WPF window prints its Logo before the engine is built, and the response file's "Loading
			// context from ..." line comes from the build itself.
			if (showBanner)
				entries.Add(BannerEntry());
			try {
				var session = await CreateSessionAsync(loadConfig, entries, cancellationToken).ConfigureAwait(false);
				return new ScriptResetResponse(entries, session.Generation);
			}
			catch (OperationCanceledException) {
				throw;
			}
			catch (Exception ex) {
				// The WPF window prints the same line when its engine fails to start.
				entries.Add(new ScriptOutputEntry(ScriptOutputEntry.Error, $"Could not create the script:\n\n{ex}" + Environment.NewLine, ScriptTextColors.Name(TextColor.Error)));
				return new ScriptResetResponse(entries, generation);
			}
		}
		finally {
			gate.Release();
		}
	}

	static ScriptOutputEntry BannerEntry() =>
		new(ScriptOutputEntry.Banner, Banner + Environment.NewLine, ScriptTextColors.Name(TextColor.ReplOutputText));

	async Task<ScriptSession> GetSessionAsync(CancellationToken cancellationToken) {
		if (current is { } existing)
			return existing;
		await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try {
			return current ?? await CreateSessionAsync(loadConfig: true, startup: [], cancellationToken).ConfigureAwait(false);
		}
		finally {
			gate.Release();
		}
	}

	/// <summary>Builds the session that replaces the current one. The caller holds <see cref="gate"/>.</summary>
	async Task<ScriptSession> CreateSessionAsync(bool loadConfig, List<ScriptOutputEntry> startup, CancellationToken cancellationToken) {
		var userOptions = new UserScriptOptions();
		if (loadConfig) {
			userOptions.LibPaths.AddRange(options.SearchPaths);
			userOptions.LoadPaths.AddRange(options.SearchPaths);
			LoadResponseFile(startup, userOptions);
		}
		var searchPaths = userOptions.LibPaths.Concat(options.SearchPaths).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
		var referenceResolver = new ScriptAssemblyResolver(AppContext.BaseDirectory, searchPaths);
		var scriptOptions = ScriptOptions.Default
			.WithMetadataResolver(referenceResolver)
			.WithSourceResolver(ScriptSourceResolver.Default.WithBaseDirectory(AppContext.BaseDirectory).WithSearchPaths(userOptions.LoadPaths.Distinct(StringComparer.OrdinalIgnoreCase)))
			.WithImports(defaultImports.Concat(userOptions.Imports).Distinct(StringComparer.Ordinal))
			.WithReferences(CombineReferences(CreateDefaultReferences().Concat(CreateResponseFileReferences(userOptions.References, referenceResolver))));
		var session = new ScriptSession(this, ++generation, scriptOptions, startup);
		// The empty submission is what anchors the session: every later one is compiled against it,
		// which is how a variable declared in one submission stays in scope for the next.
		session.State = await CSharpScript.Create<object>(string.Empty, scriptOptions, typeof(ScriptGlobals))
			.RunAsync(session.Globals, cancellationToken).ConfigureAwait(false);
		return current = session;
	}

	/// <summary>Reads <c>CSharpInteractive.rsp</c> the way <c>CSharpControlVM.InitializeUserScriptOptions</c> does.</summary>
	void LoadResponseFile(List<ScriptOutputEntry> startup, UserScriptOptions userOptions) {
		foreach (var directory in options.ResponseFileDirectories) {
			var path = Path.Combine(directory, options.ResponseFileName);
			if (!File.Exists(path))
				continue;
			startup.Add(new ScriptOutputEntry(ScriptOutputEntry.Output,
				string.Format(CultureInfo.CurrentCulture, "Loading context from '{0}'.", Path.GetFileName(path)) + Environment.NewLine,
				ScriptTextColors.Name(TextColor.ReplOutputText)));
			foreach (var (command, arguments) in ResponseFileReader.Read(path))
				RespFileUtils.Apply(command, arguments, userOptions);
			return;
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

	/// <summary>One reference per file: the shipped response file names assemblies that are already default
	/// references, and the compilation must not see the same assembly twice.</summary>
	static IEnumerable<MetadataReference> CombineReferences(IEnumerable<MetadataReference> references) {
		var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
		foreach (var reference in references) {
			var key = (reference as PortableExecutableReference)?.FilePath ?? reference.Display ?? reference.GetHashCode().ToString();
			if (seen.Add(key))
				yield return reference;
		}
	}

	/// <summary>Resolves the response file's <c>/r</c> arguments through the session's own resolver.</summary>
	static IEnumerable<MetadataReference> CreateResponseFileReferences(IEnumerable<string> references, ScriptAssemblyResolver resolver) {
		foreach (var reference in references)
			foreach (var resolved in resolver.ResolveReference(reference, null, MetadataReferenceProperties.Assembly))
				yield return resolved;
	}

	void PrintDiagnostics(ScriptSession session, ImmutableArray<Diagnostic> diagnostics) {
		const int MAX_DIAGS = 5;
		for (int i = 0; i < diagnostics.Length && i < MAX_DIAGS; i++)
			session.Write(ScriptOutputEntry.Error, CSharpDiagnosticFormatter.Instance.Format(diagnostics[i], CultureInfo.CurrentCulture) + Environment.NewLine, ScriptTextColors.Name(TextColor.Error));
		int extraErrors = diagnostics.Length - MAX_DIAGS;
		if (extraErrors > 0) {
			var text = extraErrors == 1
				? string.Format(CultureInfo.CurrentCulture, "+ additional {0} error", extraErrors)
				: string.Format(CultureInfo.CurrentCulture, "+ additional {0} errors", extraErrors);
			session.Write(ScriptOutputEntry.Error, text + Environment.NewLine, ScriptTextColors.Name(TextColor.Error));
		}
	}

	/// <summary>Sends a request to the client's UI, or answers as if there were no UI to ask.</summary>
	internal JsonElement? Request(string method, JsonElement parameters, CancellationToken cancellationToken) {
		if (client is null)
			return null;
		try {
			// A script is synchronous; the box is modal, exactly as it is in the WPF window, so waiting here is
			// what the global's signature asks for.
#pragma warning disable VSTHRD002
			return client.RequestAsync(method, parameters, cancellationToken).GetAwaiter().GetResult();
#pragma warning restore VSTHRD002
		}
		catch (OperationCanceledException) {
			return null;
		}
		catch (Exception) {
			// A client that cannot answer is the same as one that closed the box.
			return null;
		}
	}

	internal IScriptClient? Client => client;

	void Dispose(bool disposing) {
		if (disposed)
			return;
		disposed = true;
		if (disposing) {
			current?.Shutdown();
			gate.Dispose();
			ConsoleRouter.Release();
		}
	}

	public void Dispose() {
		Dispose(true);
		GC.SuppressFinalize(this);
	}
}

/// <summary>One session: its generation, its state, and the output it is producing.</summary>
sealed class ScriptSession {
	readonly CSharpScriptService owner;
	readonly object lockObj = new();
	readonly StringBuilder consoleOutput = new();
	readonly StringBuilder consoleError = new();
	List<ScriptOutputEntry>? collecting;

	public ScriptSession(CSharpScriptService owner, int generation, ScriptOptions options, List<ScriptOutputEntry> startupEntries) {
		this.owner = owner;
		Generation = generation;
		Options = options;
		StartupEntries = startupEntries;
		Cancellation = new CancellationTokenSource();
		Globals = new ScriptGlobals(owner, this, Cancellation.Token);
	}

	public int Generation { get; }
	public ScriptOptions Options { get; }
	public List<ScriptOutputEntry> StartupEntries { get; }
	public CancellationTokenSource Cancellation { get; }
	public ScriptGlobals Globals { get; }
	public ScriptState<object>? State { get; set; }
	/// <summary>Serialises submissions; reset does not wait for this, so a script that never ends cannot
	/// keep the new engine from starting.</summary>
	public SemaphoreSlim Execution { get; } = new(1, 1);
	public bool Alive { get; private set; } = true;
	public CancellationToken Token => Cancellation.Token;

	/// <summary>The lines this submission has produced so far, for its response.</summary>
	public void BeginCollecting(List<ScriptOutputEntry> entries) {
		lock (lockObj)
			collecting = entries;
	}

	public void EndCollecting() {
		lock (lockObj)
			collecting = null;
	}

	/// <summary>
	/// Adds a line to the window. <paramref name="text"/> carries its own newline when it ends a line, so a
	/// script's <c>Print</c> can leave a line open for the next call.
	/// </summary>
	public void Write(string kind, string? text, string? color) {
		var entry = new ScriptOutputEntry(kind, text ?? string.Empty, color);
		lock (lockObj) {
			// Output of a session that was reset belongs to an engine nobody is looking at any more.
			if (!Alive)
				return;
			collecting?.Add(entry);
		}
		try {
			owner.Client?.WriteOutput(Generation, entry);
		}
		catch {
			// A client that has gone away must not take the script down with it.
		}
	}

	/// <summary>Formats a value with the session's print options and writes it.</summary>
	public void PrintObject(string kind, object value, ScriptPrintOptions printOptions, TextColor color, bool newLine) {
		if (printOptions.AutoColorizeObjects && value is IOutputWritable writable) {
			writable.WriteTo(new ScriptOutputWriter(this));
			if (newLine)
				Write(kind, Environment.NewLine, null);
			return;
		}
		var text = CSharpObjectFormatter.Instance.FormatObject(value, ScriptFormatting.ToRoslyn(printOptions));
		if (newLine)
			text += Environment.NewLine;
		Write(kind, text, ScriptTextColors.Name(color));
	}


	/// <summary>A console write of one character, buffered until its line ends.</summary>
	public void WriteConsole(bool error, char value) {
		lock (lockObj) {
			if (!Alive)
				return;
			var buffer = error ? consoleError : consoleOutput;
			if (value == '\n') {
				var line = buffer.ToString().TrimEnd('\r');
				buffer.Clear();
				Write(ScriptOutputEntry.Output, line + Environment.NewLine, error ? ScriptTextColors.Name(TextColor.Error) : null);
			}
			else
				buffer.Append(value);
		}
	}

	/// <summary>Emits the partial line a script left behind when the submission ended mid-line.</summary>
	public void FlushConsole() {
		lock (lockObj) {
			if (!Alive)
				return;
			if (consoleOutput.Length > 0) {
				Write(ScriptOutputEntry.Output, consoleOutput.ToString(), null);
				consoleOutput.Clear();
			}
			if (consoleError.Length > 0) {
				Write(ScriptOutputEntry.Output, consoleError.ToString(), ScriptTextColors.Name(TextColor.Error));
				consoleError.Clear();
			}
		}
	}

	/// <summary>Signals the token, which is what tells a running script to stop.</summary>
	public void Cancel() {
		try {
			Cancellation.Cancel();
		}
		catch (ObjectDisposedException) {
			// The submission finished between the check and the cancel; nothing left to stop.
		}
	}

	/// <summary>Stops this session: its output is dropped and its token is signalled.</summary>
	public void Shutdown() {
		lock (lockObj)
			Alive = false;
		Cancel();
	}

	/// <summary>Writes colored fragments of an <see cref="IOutputWritable"/> as they come.</summary>
	sealed class ScriptOutputWriter : IOutputWriter {
		readonly ScriptSession session;

		public ScriptOutputWriter(ScriptSession session) => this.session = session;

		public void Write(string? text, object? color = null) {
			if (string.IsNullOrEmpty(text))
				return;
			session.Write(ScriptOutputEntry.Output, text, ScriptGlobals.ColorName(color));
		}

		public void Write(string? text, TextColor color) => Write(text, (object)color);
	}
}

/// <summary>
/// The console a script sees. The host's stdout is the JSON-RPC channel, so a script that calls
/// <c>Console.WriteLine</c> must not write there; this writer sends the line to the session the calling thread
/// belongs to. A thread that belongs to none — the host's own, or a test's — writes through unchanged.
/// </summary>
sealed class ConsoleRouter : TextWriter {
	static readonly AsyncLocal<ScriptSession?> session = new();
	static readonly object installLock = new();
	static volatile ConsoleRouter? outRouter;
	static volatile ConsoleRouter? errorRouter;
	static TextWriter? originalOut;
	static TextWriter? originalError;
	static int users;

	readonly bool error;

	ConsoleRouter(bool error) => this.error = error;

	public override Encoding Encoding => Encoding.UTF8;

	/// <summary>Starts routing the console; the first user installs the router, the last one restores it.</summary>
	public static void Acquire() {
		lock (installLock) {
			users++;
			if (users > 1)
				return;
			originalOut = Console.Out;
			originalError = Console.Error;
			outRouter = new ConsoleRouter(false);
			errorRouter = new ConsoleRouter(true);
			Console.SetOut(outRouter);
			Console.SetError(errorRouter);
		}
	}

	/// <summary>Stops routing the console when the last service goes away.</summary>
	public static void Release() {
		lock (installLock) {
			if (users == 0 || --users > 0)
				return;
			if (originalOut is not null)
				Console.SetOut(originalOut);
			if (originalError is not null)
				Console.SetError(originalError);
			outRouter = null;
			errorRouter = null;
			originalOut = null;
			originalError = null;
		}
	}

	/// <summary>Makes the calling execution context write its console output to <paramref name="value"/>.</summary>
	public static void Enter(ScriptSession value) => session.Value = value;

	/// <summary>Stops routing the calling execution context's console output.</summary>
	public static void Exit() => session.Value = null;

	public override void Write(char value) {
		if (session.Value is { } target)
			target.WriteConsole(error, value);
		else
			Fallback().Write(value);
	}

	public override void Write(string? value) {
		if (value is null)
			return;
		if (session.Value is { } target) {
			foreach (var c in value)
				target.WriteConsole(error, c);
		}
		else
			Fallback().Write(value);
	}

	public override void Write(char[] buffer, int index, int count) {
		if (session.Value is { } target) {
			for (int i = 0; i < count; i++)
				target.WriteConsole(error, buffer[index + i]);
		}
		else
			Fallback().Write(buffer, index, count);
	}

	public override void WriteLine(string? value) => Write((value ?? string.Empty) + Environment.NewLine);

	TextWriter Fallback() => (error ? originalError : originalOut) ?? TextWriter.Null;
}

/// <summary>
/// The host object every script runs against, so a submission can call <c>PrintLine(...)</c> without
/// qualifying it. This is dnSpy's <c>IScriptGlobals</c> (<c>Extensions/dnSpy.Scripting.Roslyn/Common/ScriptGlobals.cs</c>),
/// with the WPF dispatcher and window types replaced by the client requests the window answers.
/// </summary>
public sealed class ScriptGlobals : ITextPrinter {
	readonly CSharpScriptService owner;
	readonly ScriptSession session;
	readonly CancellationToken token;

	internal ScriptGlobals(CSharpScriptService owner, ScriptSession session, CancellationToken token) {
		this.owner = owner;
		this.session = session;
		this.token = token;
	}

	/// <summary>Raised before the script gets reset, so a script can unregister from events.</summary>
	public event EventHandler? ScriptResetting;

	internal void RaiseScriptResetting() => ScriptResetting?.Invoke(this, EventArgs.Empty);

	/// <summary>Returns itself, so it can be passed into classes that can't access the globals.</summary>
	public ScriptGlobals Instance => this;

	/// <summary>Cancellation token that gets signalled when the script gets reset.</summary>
	public CancellationToken Token => token;

	/// <summary>The options that decide how values are printed.</summary>
	public ScriptPrintOptions PrintOptions { get; } = new();

	/// <summary>Writes text in the given color.</summary>
	public void Write(string? text, object? color) => WriteRaw(text, ColorName(color) ?? ScriptTextColors.Name(TextColor.ReplScriptOutputText));

	/// <summary>Writes text in the given color.</summary>
	public void Write(string? text, TextColor color) => Write(text, (object)color);

	/// <summary>Prints text in red.</summary>
	public void PrintError(string? text) => Print(TextColor.Error, text);
	/// <summary>Prints text in red.</summary>
	public void PrintError(string fmt, params object[] args) => Print(TextColor.Error, string.Format(CultureInfo.CurrentCulture, fmt, args));
	/// <summary>Prints text in red followed by a newline.</summary>
	public void PrintLineError(string? text) => PrintLine(TextColor.Error, text);
	/// <summary>Prints text in red followed by a newline.</summary>
	public void PrintLineError(string fmt, params object[] args) => PrintLine(TextColor.Error, string.Format(CultureInfo.CurrentCulture, fmt, args));

	/// <summary>Prints text in a color.</summary>
	public void Print(object? color, string? text) => WriteRaw(text, ColorName(color) ?? ScriptTextColors.Name(TextColor.ReplScriptOutputText));
	/// <summary>Prints text in a color.</summary>
	public void Print(TextColor color, string? text) => Print((object)color, text);
	/// <summary>Prints text.</summary>
	public void Print(string? text) => Print(TextColor.ReplScriptOutputText, text);
	/// <summary>Prints formatted text in a color.</summary>
	public void Print(object? color, string fmt, params object[] args) => Print(color, string.Format(CultureInfo.CurrentCulture, fmt, args));
	/// <summary>Prints formatted text in a color.</summary>
	public void Print(TextColor color, string fmt, params object[] args) => Print(color, string.Format(CultureInfo.CurrentCulture, fmt, args));
	/// <summary>Prints formatted text.</summary>
	public void Print(string fmt, params object[] args) => Print(TextColor.ReplScriptOutputText, fmt, args);

	/// <summary>Prints text followed by a newline, in a color.</summary>
	public void PrintLine(object? color, string? text) => WriteLineRaw(text, ColorName(color) ?? ScriptTextColors.Name(TextColor.ReplScriptOutputText));
	/// <summary>Prints text followed by a newline, in a color.</summary>
	public void PrintLine(TextColor color, string? text) => PrintLine((object)color, text);
	/// <summary>Prints text followed by a newline.</summary>
	public void PrintLine(string? text = null) => PrintLine(TextColor.ReplScriptOutputText, text);
	/// <summary>Prints formatted text followed by a newline, in a color.</summary>
	public void PrintLine(object? color, string fmt, params object[] args) => PrintLine(color, string.Format(CultureInfo.CurrentCulture, fmt, args));
	/// <summary>Prints formatted text followed by a newline, in a color.</summary>
	public void PrintLine(TextColor color, string fmt, params object[] args) => PrintLine(color, string.Format(CultureInfo.CurrentCulture, fmt, args));
	/// <summary>Prints formatted text followed by a newline.</summary>
	public void PrintLine(string fmt, params object[] args) => PrintLine(TextColor.ReplScriptOutputText, fmt, args);

	/// <summary>Formats and prints a value in a color.</summary>
	public void Print(object value, object? color) => PrintValue(value, color, newLine: false);
	/// <summary>Formats and prints a value.</summary>
	public void Print(object value, TextColor color = TextColor.ReplScriptOutputText) => Print(value, (object)color);
	/// <summary>Formats and prints a value followed by a newline, in a color.</summary>
	public void PrintLine(object value, object? color) => PrintValue(value, color, newLine: true);
	/// <summary>Formats and prints a value followed by a newline.</summary>
	public void PrintLine(object value, TextColor color = TextColor.ReplScriptOutputText) => PrintLine(value, (object)color);

	/// <summary>Formats and prints an exception in a color.</summary>
	public void Print(Exception ex, object? color) => WriteRaw(CSharpObjectFormatter.Instance.FormatException(ex), ColorName(color) ?? ScriptTextColors.Name(TextColor.Error));
	/// <summary>Formats and prints an exception.</summary>
	public void Print(Exception ex, TextColor color = TextColor.Error) => Print(ex, (object)color);
	/// <summary>Formats and prints an exception followed by a newline, in a color.</summary>
	public void PrintLine(Exception ex, object? color) => WriteLineRaw(CSharpObjectFormatter.Instance.FormatException(ex), ColorName(color) ?? ScriptTextColors.Name(TextColor.Error));
	/// <summary>Formats and prints an exception followed by a newline.</summary>
	public void PrintLine(Exception ex, TextColor color = TextColor.Error) => PrintLine(ex, (object)color);

	/// <summary>Creates a writer that buffers colored text and writes it all at once.</summary>
	public ICachedWriter CreateWriter() => new ScriptCachedWriter(this);

	/// <summary>Writes colored text fragments, in one go.</summary>
	public void Write(List<ColorAndText> list) {
		foreach (var item in list)
			WriteRaw(item.Text, ColorName(item.Color) ?? ScriptTextColors.Name(TextColor.ReplScriptOutputText));
	}

	/// <summary>Calls <see cref="Debugger.Break"/>; debug dnSpy to catch it.</summary>
	public void Break() => Debugger.Break();

	/// <summary>Resolves a service, and throws if it wasn't found.</summary>
	public T Resolve<T>() where T : class =>
		owner.Services.TryResolve<T>() ?? throw new InvalidOperationException($"Could not resolve the service '{typeof(T)}'.");

	/// <summary>Resolves a service or returns null if not found.</summary>
	public T? TryResolve<T>() where T : class => owner.Services.TryResolve<T>();

	/// <summary>Shows a message box.</summary>
	public MsgBoxButton Show(string message, MsgBoxButton buttons = MsgBoxButton.OK) =>
		ShowMessageBox(message, buttons);

	/// <summary>Shows a message box with OK and Cancel.</summary>
	public MsgBoxButton ShowOKCancel(string message) => Show(message, MsgBoxButton.OK | MsgBoxButton.Cancel);
	/// <summary>Shows a message box with OK and Cancel.</summary>
	public MsgBoxButton ShowOC(string message) => ShowOKCancel(message);
	/// <summary>Shows a message box with Yes and No.</summary>
	public MsgBoxButton ShowYesNo(string message) => Show(message, MsgBoxButton.Yes | MsgBoxButton.No);
	/// <summary>Shows a message box with Yes and No.</summary>
	public MsgBoxButton ShowYN(string message) => ShowYesNo(message);
	/// <summary>Shows a message box with Yes, No and Cancel.</summary>
	public MsgBoxButton ShowYesNoCancel(string message) => Show(message, MsgBoxButton.Yes | MsgBoxButton.No | MsgBoxButton.Cancel);
	/// <summary>Shows a message box with Yes, No and Cancel.</summary>
	public MsgBoxButton ShowYNC(string message) => ShowYesNoCancel(message);

	/// <summary>
	/// Asks the user for a value and returns it or the default value (eg. null or 0) if the user canceled
	/// the dialog box.
	/// </summary>
	public T? Ask<T>(string labelMessage, string? defaultText = null, string? title = null, Func<string, T>? converter = null, Func<string, string>? verifier = null) {
		var text = defaultText;
		var error = (string?)null;
		while (true) {
			text = AskText(labelMessage, text, title, error);
			if (text is null)
				return default;
			try {
				var value = converter is not null ? converter(text) : ConvertFromString<T>(text);
				var invalid = verifier?.Invoke(text);
				if (string.IsNullOrEmpty(invalid))
					return value;
				error = invalid;
			}
			catch (Exception ex) when (ex is FormatException or NotSupportedException or InvalidCastException or ArgumentException) {
				error = ex.Message;
			}
		}
	}

	static T? ConvertFromString<T>(string text) {
		if (typeof(T) == typeof(string))
			return (T)(object)text;
		var converter = TypeDescriptor.GetConverter(typeof(T));
		return (T?)converter.ConvertFromString(null, CultureInfo.CurrentCulture, text);
	}

	/// <summary>Shows an exception.</summary>
	public void Show(Exception exception, string? msg = null) {
		var text = msg is null ? exception.ToString() : msg + Environment.NewLine + Environment.NewLine + exception;
		ShowMessageBox(text, MsgBoxButton.OK);
	}

	MsgBoxButton ShowMessageBox(string message, MsgBoxButton buttons) {
		var names = ButtonNames(buttons);
		using var document = JsonDocument.Parse(JsonSerializer.Serialize(new { message, buttons = names }));
		var result = owner.Request("script/messageBox", document.RootElement.Clone(), token);
		var button = result is { } element && element.TryGetProperty("button", out var property) ? property.GetString() : null;
		return button switch {
			"ok" => MsgBoxButton.OK,
			"yes" => MsgBoxButton.Yes,
			"no" => MsgBoxButton.No,
			"cancel" => MsgBoxButton.Cancel,
			_ => MsgBoxButton.None,
		};
	}

	static string[] ButtonNames(MsgBoxButton buttons) {
		var names = new List<string>();
		if ((buttons & MsgBoxButton.OK) != 0)
			names.Add("ok");
		if ((buttons & MsgBoxButton.Yes) != 0)
			names.Add("yes");
		if ((buttons & MsgBoxButton.No) != 0)
			names.Add("no");
		if ((buttons & MsgBoxButton.Cancel) != 0)
			names.Add("cancel");
		if (names.Count == 0)
			names.Add("ok");
		return [.. names];
	}

	string? AskText(string label, string? defaultText, string? title, string? error) {
		using var document = JsonDocument.Parse(JsonSerializer.Serialize(new { label, defaultText, title, error }));
		var result = owner.Request("script/ask", document.RootElement.Clone(), token);
		if (result is not { } element || !element.TryGetProperty("text", out var property) || property.ValueKind == JsonValueKind.Null)
			return null;
		return property.GetString();
	}

	void PrintValue(object value, object? color, bool newLine) =>
		session.PrintObject(ScriptOutputEntry.Output, value, PrintOptions, ParseColor(color), newLine);

	void WriteRaw(string? text, string color) {
		if (string.IsNullOrEmpty(text))
			return;
		session.Write(ScriptOutputEntry.Output, text, color);
	}

	void WriteLineRaw(string? text, string color) =>
		WriteRaw((text ?? string.Empty) + Environment.NewLine, color);

	/// <summary>The theme's color class for a script's color argument.</summary>
	internal static string? ColorName(object? color) => color switch {
		null => null,
		TextColor textColor => ScriptTextColors.Name(textColor),
		string name => name,
		Enum value => JsonNamingPolicy.CamelCase.ConvertName(value.ToString()),
		_ => null,
	};

	static TextColor ParseColor(object? color) => color switch {
		TextColor textColor => textColor,
		string name => Enum.TryParse<TextColor>(name, ignoreCase: true, out var parsed) ? parsed : TextColor.ReplScriptOutputText,
		_ => TextColor.ReplScriptOutputText,
	};

	/// <summary>dnSpy's <c>CachedWriter</c>: text collected and written when the script flushes it.</summary>
	sealed class ScriptCachedWriter : ICachedWriter {
		readonly ScriptGlobals owner;
		readonly List<ColorAndText> cached = [];

		public ScriptCachedWriter(ScriptGlobals owner) => this.owner = owner;

		public ScriptPrintOptions PrintOptions => owner.PrintOptions;

		public void Flush() {
			owner.Write(new List<ColorAndText>(cached));
			cached.Clear();
		}

		public void Dispose() => Flush();

		public void Print(string? text) => Print(TextColor.ReplScriptOutputText, text);
		public void Print(string fmt, params object[] args) => Print(string.Format(CultureInfo.CurrentCulture, fmt, args));
		public void Print(object? color, string? text) => cached.Add(new ColorAndText(color, text ?? string.Empty));
		public void Print(TextColor color, string? text) => cached.Add(new ColorAndText(color, text ?? string.Empty));
		public void Print(object? color, string fmt, params object[] args) => Print(color, string.Format(CultureInfo.CurrentCulture, fmt, args));
		public void Print(TextColor color, string fmt, params object[] args) => Print(color, string.Format(CultureInfo.CurrentCulture, fmt, args));
		public void PrintLine(string? text = null) => PrintLine(TextColor.ReplScriptOutputText, text);
		public void PrintLine(string fmt, params object[] args) => PrintLine(string.Format(CultureInfo.CurrentCulture, fmt, args));
		public void PrintLine(object? color, string? text) => Print(color, (text ?? string.Empty) + Environment.NewLine);
		public void PrintLine(TextColor color, string? text) => PrintLine((object)color, text);
		public void PrintLine(object? color, string fmt, params object[] args) => PrintLine(color, string.Format(CultureInfo.CurrentCulture, fmt, args));
		public void PrintLine(TextColor color, string fmt, params object[] args) => PrintLine(color, string.Format(CultureInfo.CurrentCulture, fmt, args));
		public void Print(object value, object? color) => Print(color, FormatValue(value));
		public void Print(object value, TextColor color = TextColor.ReplScriptOutputText) => Print(value, (object)color);
		public void PrintLine(object value, object? color) => PrintLine(color, FormatValue(value));
		public void PrintLine(object value, TextColor color = TextColor.ReplScriptOutputText) => PrintLine(value, (object)color);
		public void Print(Exception ex, object? color) => Print(color, CSharpObjectFormatter.Instance.FormatException(ex));
		public void Print(Exception ex, TextColor color = TextColor.Error) => Print(ex, (object)color);
		public void PrintLine(Exception ex, object? color) => PrintLine(color, CSharpObjectFormatter.Instance.FormatException(ex));
		public void PrintLine(Exception ex, TextColor color = TextColor.Error) => PrintLine(ex, (object)color);

		string FormatValue(object value) =>
			CSharpObjectFormatter.Instance.FormatObject(value, ScriptFormatting.ToRoslyn(PrintOptions));
	}
}

/// <summary>Combines a metadata reference resolver with the formatting rules a script's print options ask for.</summary>
static class ScriptFormatting {
	/// <summary>The Roslyn print options a <see cref="ScriptPrintOptions"/> names.</summary>
	public static Microsoft.CodeAnalysis.Scripting.Hosting.PrintOptions ToRoslyn(ScriptPrintOptions options) => new() {
		Ellipsis = options.Ellipsis,
		EscapeNonPrintableCharacters = options.EscapeNonPrintableCharacters,
		MaximumOutputLength = options.MaximumOutputLength,
		MemberDisplayFormat = options.MemberDisplayFormat switch {
			dnSpy.Backend.Contracts.MemberDisplayFormat.SeparateLines => Microsoft.CodeAnalysis.Scripting.Hosting.MemberDisplayFormat.SeparateLines,
			dnSpy.Backend.Contracts.MemberDisplayFormat.Hidden => Microsoft.CodeAnalysis.Scripting.Hosting.MemberDisplayFormat.Hidden,
			_ => Microsoft.CodeAnalysis.Scripting.Hosting.MemberDisplayFormat.SingleLine,
		},
		NumberRadix = options.NumberRadix,
	};
}
