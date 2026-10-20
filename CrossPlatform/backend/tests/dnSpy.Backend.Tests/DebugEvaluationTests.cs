using System.Text.Json;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using dnSpy.Backend.Debugging.CorDebug;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The expression evaluator against a real debuggee: the fixture stops on a Debugger.Break() in a method whose
/// locals are one value of each kind the variables windows show, and each test reads them the way a window
/// would — through <c>evaluate</c>, <c>variables</c> and <c>setExpression</c>.
/// </summary>
public sealed class DebugEvaluationTests {
	/// <summary>A debuggee stopped in the fixture's Evaluate method, with decimal numbers and C# as the language.</summary>
	sealed class Stopped : IAsyncDisposable {
		readonly WorkspaceManager workspaceManager;
		readonly CorDebugSessionManager manager;
		readonly Queue<DebugEventNotification> stops = new();
		readonly SemaphoreSlim signal = new(0);

		public string SessionId { get; private set; } = string.Empty;

		public int ThreadId { get; private set; }

		public int FrameId { get; private set; }

		/// <summary>The stack's row for the fixture's frame, as the client gets it.</summary>
		public JsonElement Frame { get; private set; }

		Stopped(WorkspaceManager workspaceManager, CorDebugSessionManager manager) {
			this.workspaceManager = workspaceManager;
			this.manager = manager;
		}

		public static async Task<Stopped> StartAsync(object? options = null) {
			var workspaceManager = new WorkspaceManager();
			var manager = DebugTestEnvironment.CreateManager(workspaceManager);
			var harness = new Stopped(workspaceManager, manager);
			manager.EventReceived += (_, notification) => {
				if (notification.Event != "stopped")
					return;
				lock (harness.stops)
					harness.stops.Enqueue(notification);
				harness.signal.Release();
			};
			try {
				manager.SetOptions(JsonSerializer.SerializeToElement(options ?? new { useHexadecimal = false }));
				var target = DebugTestEnvironment.FindTarget();
				var opened = await workspaceManager.OpenAsync(new OpenWorkspaceRequest([target]), TestContext.Current.CancellationToken);
				var started = await manager.LaunchAsync(
					new DebugLaunchRequest(target, Arguments: ["--evaluate"], StopAtEntry: false, WorkspaceId: opened.WorkspaceId),
					TestContext.Current.CancellationToken);
				harness.SessionId = started.SessionId;
				await harness.RequestAsync("configurationDone", new { });
				var stop = await harness.NextStopAsync();
				Assert.Equal("user-break", stop.Body?.GetProperty("reason").GetString());
				harness.ThreadId = stop.Body!.Value.GetProperty("threadId").GetInt32();
				var stack = await harness.RequestAsync("stackTrace", new { threadId = harness.ThreadId, startFrame = 0, levels = 20 });
				// Debugger.Break() is a call: the frame the user is in is the first one in the fixture's module.
				var frame = stack!.Value.GetProperty("stackFrames").EnumerateArray().First(candidate => candidate.GetProperty("name").GetString()!.Contains("Evaluate", StringComparison.Ordinal));
				harness.FrameId = frame.GetProperty("id").GetInt32();
				harness.Frame = frame.Clone();
				return harness;
			}
			catch {
				await harness.DisposeAsync();
				throw;
			}
		}

		public async Task<DebugEventNotification> NextStopAsync() {
			await signal.WaitAsync(TestContext.Current.CancellationToken);
			lock (stops)
				return stops.Dequeue();
		}

		public async Task<JsonElement?> RequestAsync(string command, object arguments) {
			var response = await manager.RequestAsync(
				new DebugAdapterRequest(SessionId, command, JsonSerializer.SerializeToElement(arguments)),
				TestContext.Current.CancellationToken);
			return response.Body;
		}

		public async Task<JsonElement> EvaluateAsync(string expression) =>
			(await RequestAsync("evaluate", new { expression, frameId = FrameId, context = "watch" }))!.Value;

		public async Task<string> ValueAsync(string expression) {
			var node = await EvaluateAsync(expression);
			return node.GetProperty("value").GetString()!;
		}

		public async Task<JsonElement[]> ChildrenAsync(int reference) {
			var body = await RequestAsync("variables", new { variablesReference = reference });
			return body!.Value.GetProperty("variables").EnumerateArray().ToArray();
		}

		public async ValueTask DisposeAsync() {
			if (!string.IsNullOrEmpty(SessionId)) {
				try {
					await manager.DisconnectAsync(new DebugDisconnectRequest(SessionId, TerminateDebuggee: true), CancellationToken.None);
				}
				catch {
				}
			}
			await manager.DisposeAsync();
			workspaceManager.Dispose();
			signal.Dispose();
		}
	}

	[Fact(Timeout = 120_000)]
	public async Task EvaluatesLocalsMembersAndOperators() {
		await using var stopped = await Stopped.StartAsync();

		Assert.Equal("2", await stopped.ValueAsync("factor"));
		Assert.Equal("3", await stopped.ValueAsync("numbers.Length"));
		Assert.Equal("6", await stopped.ValueAsync("numbers[0] + numbers[1] + numbers[2]"));
		Assert.Equal("true", await stopped.ValueAsync("numbers[2] == 3 && factor > 1"));
		Assert.Equal("\"square\"", await stopped.ValueAsync("shape.Name"));
		// A private field, read without a func-eval, and arithmetic on it.
		Assert.Equal("41", await stopped.ValueAsync("shape.secret + 1"));
		Assert.Equal("null", await stopped.ValueAsync("nothing"));
		Assert.Equal("12.5", await stopped.ValueAsync("money"));
		Assert.Equal("Red | Blue", await stopped.ValueAsync("colors"));
		Assert.Equal("7", await stopped.ValueAsync("maybe"));
		Assert.Equal("9", await stopped.ValueAsync("grid[1, 2]"));
		Assert.Equal("\"x-y\"", await stopped.ValueAsync("list[0] + \"-\" + list[1]"));
	}

	[Fact(Timeout = 120_000)]
	public async Task CallsPropertiesAndMethodsThroughFuncEval() {
		await using var stopped = await Stopped.StartAsync();

		Assert.Equal("16", await stopped.ValueAsync("shape.Area"));
		Assert.Equal("12", await stopped.ValueAsync("shape.Scale(3)"));
		Assert.Equal("2", await stopped.ValueAsync("list.Count"));
		Assert.Equal("\"square:4\"", await stopped.ValueAsync("shape.ToString()"));
		Assert.Equal("1", await stopped.ValueAsync("DebugTarget.Program.Shape.Created"));
		// The object itself reads as its DebuggerDisplay.
		Assert.Equal("Shape \"square\" with 4 sides", await stopped.ValueAsync("shape"));
	}

	[Fact(Timeout = 120_000)]
	public async Task FormatsValuesTheWayTheVariablesWindowsDo() {
		await using var stopped = await Stopped.StartAsync(new { useHexadecimal = true });

		Assert.Equal("0x00000002", await stopped.ValueAsync("factor"));
		Assert.Equal("2", await stopped.ValueAsync("factor, d"));
		Assert.Equal("x", await stopped.ValueAsync("list[0], nq"));
		Assert.Equal("{int[3]}", (await stopped.ValueAsync("numbers")).Replace("0x00000003", "3", StringComparison.Ordinal));
		Assert.Equal("(0x00000002, \"two\")", await stopped.ValueAsync("pair"));
		var boxed = await stopped.EvaluateAsync("boxed");
		Assert.Equal("object {int}", boxed.GetProperty("type").GetString());
		// A boxed primitive reads as the primitive in it, the way dnSpy's formatter writes one.
		Assert.Equal("0x0000002A", boxed.GetProperty("value").GetString());
		Assert.Equal("\"42\"", await stopped.ValueAsync("boxed.ToString()"));
	}

	[Fact(Timeout = 120_000)]
	public async Task ExpandsObjectsAndEditsValues() {
		await using var stopped = await Stopped.StartAsync();

		var shape = await stopped.EvaluateAsync("shape");
		var children = await stopped.ChildrenAsync(shape.GetProperty("variablesReference").GetInt32());
		var names = children.Select(child => child.GetProperty("name").GetString()).ToArray();
		Assert.Contains("Area", names);
		Assert.Contains("Name", names);
		Assert.Contains("secret", names);
		Assert.Contains("Static members", names);
		Assert.Equal("16", children.Single(child => child.GetProperty("name").GetString() == "Area").GetProperty("value").GetString());

		var edited = await stopped.RequestAsync("setExpression", new { expression = "shape.Sides", value = "5", frameId = stopped.FrameId });
		Assert.Equal("5", edited!.Value.GetProperty("node").GetProperty("value").GetString());
		Assert.Equal("25", await stopped.ValueAsync("shape.Area"));

		await stopped.RequestAsync("setExpression", new { expression = "factor", value = "factor * 10", frameId = stopped.FrameId });
		Assert.Equal("20", await stopped.ValueAsync("factor"));
	}

	[Fact(Timeout = 120_000)]
	public async Task ReportsErrorsAsValues() {
		await using var stopped = await Stopped.StartAsync();

		var unknown = await stopped.EvaluateAsync("doesNotExist");
		Assert.True(unknown.GetProperty("isError").GetBoolean());
		var outside = await stopped.EvaluateAsync("numbers[10]");
		Assert.True(outside.GetProperty("isError").GetBoolean());
		Assert.Contains("bounds", outside.GetProperty("value").GetString(), StringComparison.OrdinalIgnoreCase);
	}

	[Fact(Timeout = 120_000)]
	public async Task ListsTheFrameInTheLocalsWindow() {
		await using var stopped = await Stopped.StartAsync();

		var scopes = await stopped.RequestAsync("scopes", new { frameId = stopped.FrameId });
		var reference = scopes!.Value.GetProperty("scopes")[0].GetProperty("variablesReference").GetInt32();
		var locals = await stopped.ChildrenAsync(reference);
		var names = locals.Select(local => local.GetProperty("name").GetString()).ToArray();
		Assert.Contains("factor", names);
		Assert.Contains("shape", names);
		Assert.Contains("numbers", names);
		var numbers = locals.Single(local => local.GetProperty("name").GetString() == "numbers");
		var elements = await stopped.ChildrenAsync(numbers.GetProperty("variablesReference").GetInt32());
		Assert.Equal(new[] { "[0]", "[1]", "[2]" }, elements.Select(element => element.GetProperty("name").GetString() ?? string.Empty).ToArray());
	}

	[Fact(Timeout = 120_000)]
	public async Task ShowsStaticFieldsAutosAndObjectIds() {
		await using var stopped = await Stopped.StartAsync();

		var autos = await stopped.RequestAsync("autos", new { frameId = stopped.FrameId });
		var autoNames = autos!.Value.GetProperty("variables").EnumerateArray().Select(node => node.GetProperty("name").GetString()).ToArray();
		// The statement before the Debugger.Break() writes into grid.
		Assert.Contains("grid", autoNames);

		var made = await stopped.RequestAsync("makeObjectId", new { expression = "shape", frameId = stopped.FrameId });
		Assert.Equal("$1", made!.Value.GetProperty("id").GetString());
		Assert.Equal("\"square\"", await stopped.ValueAsync("$1.Name"));
		var shape = await stopped.EvaluateAsync("shape");
		Assert.Equal("$1", shape.GetProperty("objectId").GetString());

		var exception = await stopped.EvaluateAsync("$exception");
		Assert.True(exception.GetProperty("isError").GetBoolean());
	}

	[Fact(Timeout = 120_000)]
	public async Task ReadsMemoryAndDisassemblesTheFrame() {
		await using var stopped = await Stopped.StartAsync();

		var disassembly = await stopped.RequestAsync("disassemble", new { frameId = stopped.FrameId, options = new { syntax = "masm", showCode = true } });
		var lines = disassembly!.Value.GetProperty("lines").EnumerateArray().ToArray();
		Assert.NotEmpty(lines);
		Assert.True(disassembly.Value.GetProperty("currentLine").GetInt32() >= 0);
		var text = string.Join("\n", lines.Select(line => string.Concat(line.EnumerateArray().Select(part => part.GetProperty("text").GetString()))));
		Assert.Contains("call", text, StringComparison.Ordinal);

		var address = disassembly.Value.GetProperty("address").GetUInt64();
		var memory = await stopped.RequestAsync("readMemory", new { address = "0x" + address.ToString("X"), count = 16 });
		var bytes = Convert.FromBase64String(memory!.Value.GetProperty("data").GetString()!);
		Assert.Equal(16, bytes.Length);
		Assert.True(memory.Value.GetProperty("readable")[0].GetBoolean());
	}

	[Fact(Timeout = 120_000)]
	public async Task ShowsThreadsAndTheirManagedFacts() {
		await using var stopped = await Stopped.StartAsync();

		var threads = await stopped.RequestAsync("threads", new { });
		var main = threads!.Value.GetProperty("threads").EnumerateArray().Single(thread => thread.GetProperty("id").GetInt32() == stopped.ThreadId);
		Assert.Equal("Main", main.GetProperty("category").GetString());
		var frames = await stopped.RequestAsync("stackTrace", new { threadId = stopped.ThreadId, format = new { showParameterValues = true, useHexadecimal = false } });
		var names = frames!.Value.GetProperty("stackFrames").EnumerateArray().Select(frame => frame.GetProperty("name").GetString()).ToArray();
		Assert.Contains(names, name => name!.Contains("Evaluate(int factor = 2)", StringComparison.Ordinal));
	}

	[Fact(Timeout = 120_000)]
	public async Task RunsToTheStatementUnderTheCursor() {
		await using var stopped = await Stopped.StartAsync();
		var nodeId = stopped.Frame.GetProperty("nodeId").GetString();
		var line = stopped.Frame.GetProperty("line").GetInt32();
		Assert.False(string.IsNullOrEmpty(nodeId));

		// Two statements on: the GC.KeepAlive calls after the Debugger.Break().
		await stopped.RequestAsync("runToCursor", new { nodeId, line = line + 2 });
		var stop = await stopped.NextStopAsync();
		Assert.Equal("run-to-cursor", stop.Body?.GetProperty("reason").GetString());
		var stack = await stopped.RequestAsync("stackTrace", new { threadId = stopped.ThreadId, startFrame = 0, levels = 1 });
		Assert.Equal(line + 2, stack!.Value.GetProperty("stackFrames")[0].GetProperty("line").GetInt32());
	}

	[Fact(Timeout = 120_000)]
	public async Task StopsWhenAModuleBreakpointMatchesALoad() {
		using var workspaceManager = new WorkspaceManager();
		await using var manager = DebugTestEnvironment.CreateManager(workspaceManager);
		var stops = System.Threading.Channels.Channel.CreateUnbounded<DebugEventNotification>();
		manager.EventReceived += (_, notification) => {
			if (notification.Event == "stopped")
				stops.Writer.TryWrite(notification);
		};
		var target = DebugTestEnvironment.FindTarget();
		var started = await manager.LaunchAsync(new DebugLaunchRequest(target, StopAtEntry: false), TestContext.Current.CancellationToken);
		async Task<JsonElement?> RequestAsync(string command, object arguments) =>
			(await manager.RequestAsync(new DebugAdapterRequest(started.SessionId, command, JsonSerializer.SerializeToElement(arguments)), TestContext.Current.CancellationToken)).Body;
		try {
			// System.Console loads on the fixture's first WriteLine, after the launch is released.
			await RequestAsync("setModuleBreakpoints", new { breakpoints = new[] { new { moduleName = "*CONSOLE.dll" } } });
			await RequestAsync("configurationDone", new { });
			var stop = await stops.Reader.ReadAsync(TestContext.Current.CancellationToken);
			Assert.Equal("module-breakpoint", stop.Body?.GetProperty("reason").GetString());
			Assert.Equal("System.Console.dll", stop.Body?.GetProperty("module").GetString());
		}
		finally {
			await manager.DisconnectAsync(new DebugDisconnectRequest(started.SessionId, TerminateDebuggee: true), CancellationToken.None);
		}
	}

	[Fact(Timeout = 120_000)]
	public async Task ShowsWhatTheCallsAStepWentOverReturned() {
		await using var stopped = await Stopped.StartAsync();

		// The fixture's statements after the break are void calls, then one that throws away what Scale returns:
		// stepping over them one at a time, the step over that one is the stop with a "returned" row.
		for (var step = 0; step < 16; step++) {
			await stopped.RequestAsync("next", new { threadId = stopped.ThreadId });
			Assert.Equal("step", (await stopped.NextStopAsync()).Body?.GetProperty("reason").GetString());
			var stack = await stopped.RequestAsync("stackTrace", new { threadId = stopped.ThreadId, startFrame = 0, levels = 1 });
			var frameId = stack!.Value.GetProperty("stackFrames")[0].GetProperty("id").GetInt32();
			var scopes = await stopped.RequestAsync("scopes", new { frameId });
			var locals = await stopped.ChildrenAsync(scopes!.Value.GetProperty("scopes")[0].GetProperty("variablesReference").GetInt32());
			var returned = locals.FirstOrDefault(local => local.GetProperty("name").GetString()!.EndsWith("Scale returned", StringComparison.Ordinal));
			if (returned.ValueKind == JsonValueKind.Undefined)
				continue;
			Assert.Equal("12", returned.GetProperty("value").GetString());
			var alias = await stopped.RequestAsync("evaluate", new { expression = "$ReturnValue", frameId, context = "watch" });
			Assert.Equal("12", alias!.Value.GetProperty("value").GetString());
			return;
		}
		Assert.Fail("No step showed what Scale returned.");
	}

	[Fact(Timeout = 120_000)]
	public async Task SetsTheNextStatementWithinTheMethod() {
		await using var stopped = await Stopped.StartAsync();
		var nodeId = stopped.Frame.GetProperty("nodeId").GetString();
		var line = stopped.Frame.GetProperty("line").GetInt32();

		// Back to the statement that fills in the grid: it runs again from there.
		await stopped.RequestAsync("setNextStatement", new { threadId = stopped.ThreadId, nodeId, line = line - 1 });
		var stop = await stopped.NextStopAsync();
		Assert.Equal(stopped.ThreadId, stop.Body?.GetProperty("threadId").GetInt32());
		var stack = await stopped.RequestAsync("stackTrace", new { threadId = stopped.ThreadId, startFrame = 0, levels = 1 });
		Assert.Equal(line - 1, stack!.Value.GetProperty("stackFrames")[0].GetProperty("line").GetInt32());
	}
}

/// <summary>What the debugger tests share: the manager, and the fixture's path.</summary>
static class DebugTestEnvironment {
	public static CorDebugSessionManager CreateManager(IDebugSymbolResolver symbols) {
		try {
			return new CorDebugSessionManager(symbols);
		}
		catch (FileNotFoundException ex) {
			Assert.Skip($"The dbgshim native library is not available: {ex.Message}");
			throw;
		}
	}

	public static string FindTarget() {
		var path = Path.GetFullPath(Path.Combine(
			AppContext.BaseDirectory,
			"..", "..", "..", "..", "DebugTarget", "bin", TestConfiguration, "net10.0", "DebugTarget.dll"));
		return File.Exists(path) ? path : throw new FileNotFoundException("The debug target was not built.", path);
	}

	static string TestConfiguration => new DirectoryInfo(AppContext.BaseDirectory).Parent?.Name
		?? throw new InvalidOperationException("Could not determine the test configuration.");
}
