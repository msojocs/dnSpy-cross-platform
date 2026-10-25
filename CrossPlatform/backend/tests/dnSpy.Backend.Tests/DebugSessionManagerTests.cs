using System.Diagnostics;
using System.Text.Json;
using dnlib.DotNet;
using dnlib.DotNet.Emit;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using dnSpy.Backend.Debugging.CorDebug;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The in-process engine against a real debuggee. Both tests are whole-process ones, so they are skipped
/// rather than failed where the machine cannot host them: <c>libdbgshim.so</c> arrives with the build (it
/// is a package reference), and without it there is no engine to test.
/// </summary>
public sealed class DebugSessionManagerTests {
	/// <summary>
	/// The CoreCLR page's Timeout: five seconds when the dialog left it alone, the number it shows
	/// otherwise, and never a negative duration for a hand-written request.
	/// </summary>
	[Fact]
	public void ConnectionTimeoutIsTheCoreClrPagesTimeout() {
		Assert.Equal(TimeSpan.FromSeconds(5), CorDebugSession.GetConnectionTimeout(new DebugLaunchRequest("DebugTarget.dll")));
		Assert.Equal(TimeSpan.FromSeconds(12), CorDebugSession.GetConnectionTimeout(new DebugLaunchRequest("DebugTarget.dll", ConnectionTimeout: 12)));
		Assert.Equal(TimeSpan.Zero, CorDebugSession.GetConnectionTimeout(new DebugLaunchRequest("DebugTarget.dll", ConnectionTimeout: 0)));
		Assert.Equal(TimeSpan.Zero, CorDebugSession.GetConnectionTimeout(new DebugLaunchRequest("DebugTarget.dll", ConnectionTimeout: -1)));
	}

	[Fact(Timeout = 60_000)]
	public async Task LaunchesCoreClrAndProvidesThreadsStackAndVariables() {
		using var workspaceManager = new WorkspaceManager();
		await using var manager = CreateManager(workspaceManager);
		var target = FindTarget();
		var opened = await workspaceManager.OpenAsync(new OpenWorkspaceRequest([target]), TestContext.Current.CancellationToken);
		var stoppedEvents = new Queue<DebugEventNotification>();
		var eventSignal = new SemaphoreSlim(0);
		manager.EventReceived += (_, notification) => {
			if (notification.Event == "stopped") {
				lock (stoppedEvents)
					stoppedEvents.Enqueue(notification);
				eventSignal.Release();
			}
		};

		var started = await manager.LaunchAsync(
			new DebugLaunchRequest(target, StopAtEntry: true, WorkspaceId: opened.WorkspaceId),
			TestContext.Current.CancellationToken);
		await eventSignal.WaitAsync(TestContext.Current.CancellationToken);
		var entryStop = Dequeue(stoppedEvents);
		Assert.Equal("entry", entryStop.Body?.GetProperty("reason").GetString());

		var functionBreakpoints = JsonSerializer.SerializeToElement(new {
			breakpoints = new[] { new { name = "DebugTarget.Program.Calculate" } },
		});
		var breakpointResponse = await manager.RequestAsync(
			new DebugAdapterRequest(started.SessionId, "setFunctionBreakpoints", functionBreakpoints),
			TestContext.Current.CancellationToken);
		var breakpoint = breakpointResponse.Body?.GetProperty("breakpoints")[0]
			?? throw new InvalidOperationException("No breakpoint was returned.");
		// A function breakpoint is armed at the first statement's sequence point, so it binds as soon as the
		// module is loaded — which, at an entry stop, it is.
		Assert.True(breakpoint.GetProperty("verified").GetBoolean(), breakpoint.GetProperty("message").GetString());

		var entryThreadId = entryStop.Body?.GetProperty("threadId").GetInt32() ?? throw new InvalidOperationException("Stopped event has no thread ID.");
		await manager.RequestAsync(
			new DebugAdapterRequest(started.SessionId, "continue", JsonSerializer.SerializeToElement(new { threadId = entryThreadId })),
			TestContext.Current.CancellationToken);
		await eventSignal.WaitAsync(TestContext.Current.CancellationToken);
		var breakpointStop = Dequeue(stoppedEvents);
		Assert.Equal("breakpoint", breakpointStop.Body?.GetProperty("reason").GetString());
		var threadId = breakpointStop.Body?.GetProperty("threadId").GetInt32() ?? entryThreadId;

		var threads = await manager.RequestAsync(
			new DebugAdapterRequest(started.SessionId, "threads", JsonSerializer.SerializeToElement(new { })),
			TestContext.Current.CancellationToken);
		Assert.NotEmpty(threads.Body?.GetProperty("threads").EnumerateArray() ?? []);

		var stack = await manager.RequestAsync(
			new DebugAdapterRequest(started.SessionId, "stackTrace", JsonSerializer.SerializeToElement(new { threadId, startFrame = 0, levels = 20 })),
			TestContext.Current.CancellationToken);
		var frame = stack.Body?.GetProperty("stackFrames")[0] ?? throw new InvalidOperationException("No stack frame was returned.");
		Assert.Contains("Calculate", frame.GetProperty("name").GetString(), StringComparison.Ordinal);

		var scopes = await manager.RequestAsync(
			new DebugAdapterRequest(started.SessionId, "scopes", JsonSerializer.SerializeToElement(new { frameId = frame.GetProperty("id").GetInt32() })),
			TestContext.Current.CancellationToken);
		var localScope = scopes.Body?.GetProperty("scopes").EnumerateArray().First(scope => scope.GetProperty("name").GetString() == "Locals")
			?? throw new InvalidOperationException("No locals scope was returned.");
		var variables = await manager.RequestAsync(
			new DebugAdapterRequest(started.SessionId, "variables", JsonSerializer.SerializeToElement(new { variablesReference = localScope.GetProperty("variablesReference").GetInt32() })),
			TestContext.Current.CancellationToken);
		var variableNames = variables.Body?.GetProperty("variables").EnumerateArray().Select(variable => variable.GetProperty("name").GetString()).ToArray() ?? [];
		Assert.Contains("left", variableNames);
		Assert.Contains("right", variableNames);

		var modules = await manager.RequestAsync(
			new DebugAdapterRequest(started.SessionId, "modules", JsonSerializer.SerializeToElement(new { startModule = 0, moduleCount = 1000 })),
			TestContext.Current.CancellationToken);
		Assert.NotEmpty(modules.Body?.GetProperty("modules").EnumerateArray() ?? []);

		await manager.DisconnectAsync(
			new DebugDisconnectRequest(started.SessionId, TerminateDebuggee: true),
			TestContext.Current.CancellationToken);
	}

	[Fact(Timeout = 60_000)]
	public async Task BreaksAtModuleCctorOrEntryPoint() {
		using var workspaceManager = new WorkspaceManager();
		await using var manager = CreateManager(workspaceManager);
		var target = FindTarget();
		var opened = await workspaceManager.OpenAsync(new OpenWorkspaceRequest([target]), TestContext.Current.CancellationToken);
		var stopped = new TaskCompletionSource<DebugEventNotification>(TaskCreationOptions.RunContinuationsAsynchronously);
		manager.EventReceived += (_, notification) => {
			if (notification.Event == "stopped")
				stopped.TrySetResult(notification);
		};

		var started = await manager.LaunchAsync(
			new DebugLaunchRequest(target, BreakKind: "ModuleCctorOrEntryPoint", WorkspaceId: opened.WorkspaceId),
			TestContext.Current.CancellationToken);
		var stop = await stopped.Task.WaitAsync(TestContext.Current.CancellationToken);
		Assert.Equal("entry", stop.Body?.GetProperty("reason").GetString());

		var threadId = stop.Body?.GetProperty("threadId").GetInt32() ?? throw new InvalidOperationException("Stopped event has no thread ID.");
		var stack = await manager.RequestAsync(
			new DebugAdapterRequest(started.SessionId, "stackTrace", JsonSerializer.SerializeToElement(new { threadId, startFrame = 0, levels = 20 })),
			TestContext.Current.CancellationToken);
		var frames = stack.Body?.GetProperty("stackFrames").EnumerateArray().ToArray() ?? [];
		// The Call Stack window writes a constructor — the module's static one included — by its type's name,
		// the way WPF's CSharpStackFrameFormatter does; the frame's description names the .cctor itself.
		Assert.Contains(frames, frame => frame.GetProperty("name").GetString()?.Contains("<Module>.<Module>()", StringComparison.Ordinal) == true
			&& frame.GetProperty("description").GetString()?.Contains(".cctor", StringComparison.Ordinal) == true);

		await manager.DisconnectAsync(
			new DebugDisconnectRequest(started.SessionId, TerminateDebuggee: true),
			TestContext.Current.CancellationToken);
	}

	[Fact(Timeout = 60_000)]
	public async Task BreaksAtCreateProcess() {
		using var workspaceManager = new WorkspaceManager();
		await using var manager = CreateManager(workspaceManager);
		var target = FindTarget();
		var opened = await workspaceManager.OpenAsync(new OpenWorkspaceRequest([target]), TestContext.Current.CancellationToken);
		var stopped = new TaskCompletionSource<DebugEventNotification>(TaskCreationOptions.RunContinuationsAsynchronously);
		manager.EventReceived += (_, notification) => {
			if (notification.Event == "stopped")
				stopped.TrySetResult(notification);
		};

		var started = await manager.LaunchAsync(
			new DebugLaunchRequest(target, BreakKind: "CreateProcess", WorkspaceId: opened.WorkspaceId),
			TestContext.Current.CancellationToken);
		var stop = await stopped.Task.WaitAsync(TestContext.Current.CancellationToken);
		Assert.Equal("create-process", stop.Body?.GetProperty("reason").GetString());
		Assert.Equal(JsonValueKind.Number, stop.Body?.GetProperty("threadId").ValueKind);

		await manager.DisconnectAsync(
			new DebugDisconnectRequest(started.SessionId, TerminateDebuggee: true),
			TestContext.Current.CancellationToken);
	}

	[Fact(Timeout = 60_000)]
	public async Task AttachesToAndDetachesFromExistingCoreClrProcess() {
		// A workspace has to be open for the engine to resolve the module the process has already loaded:
		// it is the decompiler, not a symbol file, that names the code a frame is in.
		using var workspaceManager = new WorkspaceManager();
		var targetPath = FindTarget();
		var opened = await workspaceManager.OpenAsync(new OpenWorkspaceRequest([targetPath]), TestContext.Current.CancellationToken);
		await using var manager = CreateManager(workspaceManager);
		using var target = new Process {
			StartInfo = new ProcessStartInfo {
				FileName = "dotnet",
				UseShellExecute = false,
				RedirectStandardOutput = true,
				RedirectStandardError = true,
				CreateNoWindow = true,
			},
		};
		target.StartInfo.ArgumentList.Add(targetPath);
		target.StartInfo.ArgumentList.Add("--wait");
		Assert.True(target.Start());
		try {
			var ready = await target.StandardOutput.ReadLineAsync(TestContext.Current.CancellationToken);
			Assert.Equal("READY", ready);
			// Attach to Process offers the processes running CoreCLR, and this one is.
			var listed = Assert.Single(manager.ListProcesses(), process => process.ProcessId == target.Id);
			// The columns dnSpy's dialog shows: the runtime as "CoreCLR <version>", the architecture, the command line.
			Assert.Equal("CoreCLR " + Environment.Version.ToString(3), listed.RuntimeName);
			Assert.Equal(System.Runtime.InteropServices.RuntimeInformation.OSArchitecture == System.Runtime.InteropServices.Architecture.Arm64 ? "ARM64" : "x64", listed.Architecture);
			Assert.Contains("DebugTarget.dll --wait", listed.CommandLine, StringComparison.Ordinal);
			Assert.Equal(Path.GetFileName(listed.ExecutablePath), listed.Name);
			var stopped = new TaskCompletionSource<DebugEventNotification>(TaskCreationOptions.RunContinuationsAsynchronously);
			manager.EventReceived += (_, notification) => {
				if (notification.Event == "stopped") stopped.TrySetResult(notification);
			};
			var attached = await manager.AttachAsync(new DebugAttachRequest(target.Id, opened.WorkspaceId), TestContext.Current.CancellationToken);
			var threads = await manager.RequestAsync(
				new DebugAdapterRequest(attached.SessionId, "threads", JsonSerializer.SerializeToElement(new { })),
				TestContext.Current.CancellationToken);
			var thread = threads.Body?.GetProperty("threads")[0] ?? throw new InvalidOperationException("No target thread was returned.");
			var threadId = thread.GetProperty("id").GetInt32();
			await manager.RequestAsync(
				new DebugAdapterRequest(attached.SessionId, "pause", JsonSerializer.SerializeToElement(new { threadId })),
				TestContext.Current.CancellationToken);
			var stop = await stopped.Task.WaitAsync(TestContext.Current.CancellationToken);
			Assert.Equal("pause", stop.Body?.GetProperty("reason").GetString());
			var stack = await manager.RequestAsync(
				new DebugAdapterRequest(attached.SessionId, "stackTrace", JsonSerializer.SerializeToElement(new { threadId, startFrame = 0, levels = 20 })),
				TestContext.Current.CancellationToken);
			Assert.NotEmpty(stack.Body?.GetProperty("stackFrames").EnumerateArray() ?? []);
			await manager.DisconnectAsync(
				new DebugDisconnectRequest(attached.SessionId, TerminateDebuggee: false),
				TestContext.Current.CancellationToken);
			Assert.False(target.HasExited);
		}
		finally {
			if (!target.HasExited) {
				target.Kill(entireProcessTree: true);
				await target.WaitForExitAsync(TestContext.Current.CancellationToken);
			}
		}
	}

	[Fact(Timeout = 60_000)]
	public async Task LaunchesCoreClrAppHostDirectly() {
		using var workspaceManager = new WorkspaceManager();
		var target = FindTarget();
		var appHost = FindAppHost(target);
		var opened = await workspaceManager.OpenAsync(new OpenWorkspaceRequest([target]), TestContext.Current.CancellationToken);
		await using var manager = CreateManager(workspaceManager);

		var started = await manager.LaunchAsync(
			new DebugLaunchRequest(appHost, ["--wait"], StopAtEntry: false, WorkspaceId: opened.WorkspaceId),
			TestContext.Current.CancellationToken);
		await manager.RequestAsync(
			new DebugAdapterRequest(started.SessionId, "configurationDone", JsonSerializer.SerializeToElement(new { })),
			TestContext.Current.CancellationToken);
		await manager.DisconnectAsync(
			new DebugDisconnectRequest(started.SessionId, TerminateDebuggee: true),
			TestContext.Current.CancellationToken);
	}

	/// <summary>
	/// dnSpy's Break all processes when one process breaks: two processes are debugged, and the one still running is
	/// paused the moment the other stops.
	/// </summary>
	[Fact(Timeout = 60_000)]
	public async Task AProcessThatBreaksPausesTheOthers() {
		using var workspaceManager = new WorkspaceManager();
		var target = FindTarget();
		var opened = await workspaceManager.OpenAsync(new OpenWorkspaceRequest([target]), TestContext.Current.CancellationToken);
		await using var manager = CreateManager(workspaceManager);
		var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
		var stops = new System.Collections.Concurrent.ConcurrentQueue<DebugEventNotification>();
		var stopSignal = new SemaphoreSlim(0);
		manager.EventReceived += (_, notification) => {
			if (notification.Event == "output" && notification.Body?.GetProperty("output").GetString()?.Contains("READY", StringComparison.Ordinal) == true)
				ready.TrySetResult();
			if (notification.Event == "stopped") {
				stops.Enqueue(notification);
				stopSignal.Release();
			}
		};

		var running = await manager.LaunchAsync(
			new DebugLaunchRequest(target, ["--wait"], StopAtEntry: false, WorkspaceId: opened.WorkspaceId),
			TestContext.Current.CancellationToken);
		await manager.RequestAsync(
			new DebugAdapterRequest(running.SessionId, "configurationDone", JsonSerializer.SerializeToElement(new { })),
			TestContext.Current.CancellationToken);
		await ready.Task.WaitAsync(TestContext.Current.CancellationToken);

		var breaking = await manager.LaunchAsync(
			new DebugLaunchRequest(target, StopAtEntry: true, WorkspaceId: opened.WorkspaceId),
			TestContext.Current.CancellationToken);
		var seen = new List<DebugEventNotification>();
		while (!seen.Any(stop => stop.SessionId == running.SessionId)) {
			await stopSignal.WaitAsync(TestContext.Current.CancellationToken);
			while (stops.TryDequeue(out var stop))
				seen.Add(stop);
		}
		Assert.Equal("entry", seen.First(stop => stop.SessionId == breaking.SessionId).Body?.GetProperty("reason").GetString());
		Assert.Equal("pause", seen.First(stop => stop.SessionId == running.SessionId).Body?.GetProperty("reason").GetString());

		await manager.DisconnectAsync(new DebugDisconnectRequest(breaking.SessionId, TerminateDebuggee: true), TestContext.Current.CancellationToken);
		await manager.DisconnectAsync(new DebugDisconnectRequest(running.SessionId, TerminateDebuggee: true), TestContext.Current.CancellationToken);
	}

	/// <summary>
	/// dnSpy's dynamic modules: a module Reflection.Emit built has no file, and Open Module from Memory still gets one —
	/// the metadata the runtime saved for the debugger, with every method's body read out of the process.
	/// </summary>
	[Fact(Timeout = 60_000)]
	public async Task SavesADynamicModuleWithItsMethodBodies() {
		using var workspaceManager = new WorkspaceManager();
		var target = FindTarget();
		var opened = await workspaceManager.OpenAsync(new OpenWorkspaceRequest([target]), TestContext.Current.CancellationToken);
		await using var manager = CreateManager(workspaceManager);
		var stops = new System.Collections.Concurrent.ConcurrentQueue<DebugEventNotification>();
		var stopSignal = new SemaphoreSlim(0);
		var classLoads = new System.Collections.Concurrent.ConcurrentQueue<DebugEventNotification>();
		manager.EventReceived += (_, notification) => {
			if (notification.Event == "stopped") {
				stops.Enqueue(notification);
				stopSignal.Release();
			}
			if (notification.Event == "module" && notification.Body?.GetProperty("reason").GetString() == "classLoaded")
				classLoads.Enqueue(notification);
		};
		var started = await manager.LaunchAsync(new DebugLaunchRequest(target, ["--emit"], StopAtEntry: false, WorkspaceId: opened.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.RequestAsync(
			new DebugAdapterRequest(started.SessionId, "setFunctionBreakpoints", JsonSerializer.SerializeToElement(new { breakpoints = new[] { new { name = "DebugTarget.DynamicFixture.Ready" } } })),
			TestContext.Current.CancellationToken);
		await manager.RequestAsync(new DebugAdapterRequest(started.SessionId, "configurationDone", JsonSerializer.SerializeToElement(new { })), TestContext.Current.CancellationToken);
		await stopSignal.WaitAsync(TestContext.Current.CancellationToken);

		var modules = await manager.RequestAsync(
			new DebugAdapterRequest(started.SessionId, "modules", JsonSerializer.SerializeToElement(new { startModule = 0, moduleCount = 1000 })),
			TestContext.Current.CancellationToken);
		var dynamic = modules.Body!.Value.GetProperty("modules").EnumerateArray().Single(module => module.GetProperty("isDynamic").GetBoolean());
		// dnSpy's ClassLoader is told of the type CreateType made, in the module it was made in.
		Assert.Contains(classLoads, load => load.Body!.Value.GetProperty("module").GetProperty("id").GetInt32() == dynamic.GetProperty("id").GetInt32());
		string? path = null;
		try {
			// Open Module from Memory's copy: under the memory modules directory, named as the module is.
			var saved = await manager.RequestAsync(
				new DebugAdapterRequest(started.SessionId, "saveModule", JsonSerializer.SerializeToElement(new { moduleId = dynamic.GetProperty("id").GetInt32() })),
				TestContext.Current.CancellationToken);
			path = saved.Body!.Value.GetProperty("path").GetString()!;
			Assert.True(MemoryModuleFiles.Contains(path));
			Assert.Equal(dynamic.GetProperty("name").GetString(), Path.GetFileName(path));
			using var module = ModuleDefMD.Load(path);
			var answer = module.Find("Dynamic.Greeter", isReflectionName: true)?.FindMethod("Answer") ?? throw new InvalidOperationException("The emitted method is not in the saved module.");
			Assert.True(answer.HasBody);
			Assert.Equal(Code.Ldc_I4_S, answer.Body.Instructions[0].OpCode.Code);
			Assert.Equal((sbyte)42, answer.Body.Instructions[0].Operand);
			Assert.Equal(Code.Ret, answer.Body.Instructions[^1].OpCode.Code);
			Assert.Single(answer.Body.Variables);
			// The finally block came from the section after the IL.
			Assert.Equal(ExceptionHandlerType.Finally, Assert.Single(answer.Body.ExceptionHandlers).HandlerType);
			// And System.Reflection.Metadata, which the decompiler reads through, finds the same body.
			using (var pe = new System.Reflection.PortableExecutable.PEReader(File.OpenRead(path))) {
				var reader = System.Reflection.Metadata.PEReaderExtensions.GetMetadataReader(pe);
				var handle = reader.MethodDefinitions.Single(candidate => reader.GetString(reader.GetMethodDefinition(candidate).Name) == "Answer");
				var body = System.Reflection.Metadata.PEReaderExtensions.GetMethodBody(pe, reader.GetMethodDefinition(handle).RelativeVirtualAddress);
				Assert.Single(body.ExceptionRegions);
			}
			// The copy in the workspace is where a stop in the process's module is shown: the engine names the module by
			// the process's path for it, and the copy answers for that name.
			await workspaceManager.AddModulesAsync(new AddModulesRequest(opened.WorkspaceId, [path]), TestContext.Current.CancellationToken);
			var location = await workspaceManager.ResolveIlLocationAsync(opened.WorkspaceId, dynamic.GetProperty("path").GetString()!, unchecked((int)answer.MDToken.Raw), 0, TestContext.Current.CancellationToken);
			Assert.NotNull(location?.NodeId);
		}
		finally {
			await manager.DisconnectAsync(new DebugDisconnectRequest(started.SessionId, TerminateDebuggee: true), TestContext.Current.CancellationToken);
			if (path is not null)
				File.Delete(path);
		}
	}

	/// <summary>
	/// ClassLoader.LoadNewClasses and MemoryModuleDefDocument.UpdateMemory update the document the workspace
	/// already holds: a type emitted after the copy was read appears under the same module, and the rows the
	/// module already had keep their node ids, so their tabs stay open.
	/// </summary>
	[Fact(Timeout = 60_000)]
	public async Task ReloadingADynamicModuleKeepsItsNodeIdsAndAddsNewTypes() {
		using var workspaceManager = new WorkspaceManager();
		var target = FindTarget();
		var opened = await workspaceManager.OpenAsync(new OpenWorkspaceRequest([target]), TestContext.Current.CancellationToken);
		await using var manager = CreateManager(workspaceManager);
		var stopSignal = new SemaphoreSlim(0);
		manager.EventReceived += (_, notification) => {
			if (notification.Event == "stopped")
				stopSignal.Release();
		};
		var started = await manager.LaunchAsync(new DebugLaunchRequest(target, ["--emit"], StopAtEntry: false, WorkspaceId: opened.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.RequestAsync(
			new DebugAdapterRequest(started.SessionId, "setFunctionBreakpoints", JsonSerializer.SerializeToElement(new { breakpoints = new[] { new { name = "DebugTarget.DynamicFixture.Ready" } } })),
			TestContext.Current.CancellationToken);
		await manager.RequestAsync(new DebugAdapterRequest(started.SessionId, "configurationDone", JsonSerializer.SerializeToElement(new { })), TestContext.Current.CancellationToken);
		await stopSignal.WaitAsync(TestContext.Current.CancellationToken);

		var modules = await manager.RequestAsync(
			new DebugAdapterRequest(started.SessionId, "modules", JsonSerializer.SerializeToElement(new { startModule = 0, moduleCount = 1000 })),
			TestContext.Current.CancellationToken);
		var dynamic = modules.Body!.Value.GetProperty("modules").EnumerateArray().Single(module => module.GetProperty("isDynamic").GetBoolean());
		string? path = null;
		try {
			var saved = await manager.RequestAsync(
				new DebugAdapterRequest(started.SessionId, "saveModule", JsonSerializer.SerializeToElement(new { moduleId = dynamic.GetProperty("id").GetInt32() })),
				TestContext.Current.CancellationToken);
			path = saved.Body!.Value.GetProperty("path").GetString()!;
			var added = await workspaceManager.AddModulesAsync(new AddModulesRequest(opened.WorkspaceId, [path]), TestContext.Current.CancellationToken);
			var moduleId = added.Modules.Single(module => module.Path == path).Id;
			var greeter = await workspaceManager.FindByTokenAsync(new FindByTokenRequest(opened.WorkspaceId, moduleId, "0x02000002"), TestContext.Current.CancellationToken);
			Assert.NotNull(greeter.NodeId);

			// The program creates Dynamic.Late after the first stop and calls Ready again.
			var threadId = await manager.RequestAsync(new DebugAdapterRequest(started.SessionId, "threads", JsonSerializer.SerializeToElement(new { })), TestContext.Current.CancellationToken);
			var mainThread = threadId.Body!.Value.GetProperty("threads")[0].GetProperty("id").GetInt32();
			await manager.RequestAsync(new DebugAdapterRequest(started.SessionId, "continue", JsonSerializer.SerializeToElement(new { threadId = mainThread })), TestContext.Current.CancellationToken);
			await stopSignal.WaitAsync(TestContext.Current.CancellationToken);

			// The same copy is written again, as the ClassLoader's stop-time refresh does, and the module is
			// refreshed in place instead of being removed and opened afresh.
			await manager.RequestAsync(
				new DebugAdapterRequest(started.SessionId, "saveModule", JsonSerializer.SerializeToElement(new { moduleId = dynamic.GetProperty("id").GetInt32() })),
				TestContext.Current.CancellationToken);
			var reloaded = await workspaceManager.ReloadModuleAsync(new ReloadModuleRequest(opened.WorkspaceId, moduleId), TestContext.Current.CancellationToken);
			Assert.DoesNotContain(greeter.NodeId, reloaded.RemovedNodeIds);
			Assert.Contains(greeter.NodeId, reloaded.ChangedNodeIds);
			var greeterAfter = await workspaceManager.FindByTokenAsync(new FindByTokenRequest(opened.WorkspaceId, moduleId, "0x02000002"), TestContext.Current.CancellationToken);
			Assert.Equal(greeter.NodeId, greeterAfter.NodeId);
			var late = await workspaceManager.FindByTokenAsync(new FindByTokenRequest(opened.WorkspaceId, moduleId, "0x02000003"), TestContext.Current.CancellationToken);
			Assert.NotNull(late.NodeId);
		}
		finally {
			await manager.DisconnectAsync(new DebugDisconnectRequest(started.SessionId, TerminateDebuggee: true), TestContext.Current.CancellationToken);
			if (path is not null)
				File.Delete(path);
		}
	}

	/// <summary>
	/// The upstream CoreCLR page's "Use host executable": with the choice made the target is started
	/// through the host as <c>host hostArgs program</c> — here the <c>dotnet</c> CLI with its
	/// <c>exec</c> verb — rather than run on its own.
	/// </summary>
	[Fact(Timeout = 60_000)]
	public async Task LaunchesThroughTheHostWithItsArguments() {
		using var workspaceManager = new WorkspaceManager();
		await using var manager = CreateManager(workspaceManager);
		var target = FindTarget();
		var opened = await workspaceManager.OpenAsync(new OpenWorkspaceRequest([target]), TestContext.Current.CancellationToken);
		var stopped = new TaskCompletionSource<DebugEventNotification>(TaskCreationOptions.RunContinuationsAsynchronously);
		manager.EventReceived += (_, notification) => {
			if (notification.Event == "stopped")
				stopped.TrySetResult(notification);
		};

		var started = await manager.LaunchAsync(
			new DebugLaunchRequest(target, StopAtEntry: true, WorkspaceId: opened.WorkspaceId, UseHost: true, HostArguments: ["exec"]),
			TestContext.Current.CancellationToken);
		var stop = await stopped.Task.WaitAsync(TestContext.Current.CancellationToken);
		Assert.Equal("entry", stop.Body?.GetProperty("reason").GetString());

		await manager.DisconnectAsync(
			new DebugDisconnectRequest(started.SessionId, TerminateDebuggee: true),
			TestContext.Current.CancellationToken);
	}

	static DebugEventNotification Dequeue(Queue<DebugEventNotification> events) {
		lock (events)
			return events.Dequeue();
	}

	/// <summary>
	/// "Step into" from a call has to land on the first statement of what the call runs, and the stop
	/// it reports has to be the callee's frame — a step that only moves the marker down the caller is
	/// a step into that never happened.
	/// </summary>
	[Fact(Timeout = 120_000)]
	public async Task StepIntoEntersTheCalledMethod() {
		var target = FindTarget();
		await using var harness = await StepHarness.StartAsync(target, TestContext.Current.CancellationToken);
		var entry = await harness.NextStopAsync();
		Assert.Equal("entry", Reason(entry));

		await harness.SetLineBreakpointAsync(await harness.CallStatementAsync());
		var atCall = await harness.ContinueAsync(ThreadId(entry));
		Assert.Equal("breakpoint", Reason(atCall));
		Assert.Contains("Main", await harness.DescribeFramesAsync(ThreadId(atCall)), StringComparison.Ordinal);

		var stepped = await harness.StepAsync("stepIn", ThreadId(atCall));

		Assert.Equal("step", Reason(stepped));
		var after = await harness.DescribeFramesAsync(ThreadId(stepped));
		Assert.True(after.Contains("Calculate", StringComparison.Ordinal), $"After step into: {after}");
	}

	/// <summary>
	/// A step out of Calculate lands in Main right after the call, which is still the call's statement — dnSpy shows
	/// the statement the instruction pointer is in — and a step into from there finishes that statement and stops on
	/// the next one, the framework call it cannot walk into being stepped over.
	/// </summary>
	[Fact(Timeout = 120_000)]
	public async Task StepsOutToTheCallThenOnToTheNextStatement() {
		var target = FindTarget();
		await using var harness = await StepHarness.StartAsync(target, TestContext.Current.CancellationToken);
		var entry = await harness.NextStopAsync();
		var call = await harness.CallStatementAsync();
		var next = await harness.CallStatementAsync("WriteLine", callee => callee.MethodSig is { Params.Count: 1 } signature && signature.Params[0].ElementType == ElementType.I4);
		await harness.SetLineBreakpointAsync(await harness.StatementAsync("Calculate", "+= left"));
		var inCallee = await harness.ContinueAsync(ThreadId(entry));
		Assert.Equal("breakpoint", Reason(inCallee));

		var outStop = await harness.StepAsync("stepOut", ThreadId(inCallee));
		var afterOut = await harness.TopFrameAsync(ThreadId(outStop));
		Assert.Contains("Main", afterOut.Name, StringComparison.Ordinal);
		Assert.Equal(call.Line, afterOut.Line);

		var intoStop = await harness.StepAsync("stepIn", ThreadId(outStop));
		var afterInto = await harness.TopFrameAsync(ThreadId(intoStop));
		Assert.True(next.Line == afterInto.Line, $"Expected line {next.Line} ({await harness.DescribeFramesAsync(ThreadId(intoStop))}).");
	}

	/// <summary>
	/// "Step over" from the same place has to stay in the caller: the call runs, but the stop is the
	/// caller's next statement.
	/// </summary>
	[Fact(Timeout = 120_000)]
	public async Task StepOverStaysInTheCaller() {
		var target = FindTarget();
		await using var harness = await StepHarness.StartAsync(target, TestContext.Current.CancellationToken);
		var entry = await harness.NextStopAsync();

		var call = await harness.CallStatementAsync();
		await harness.SetLineBreakpointAsync(call);
		var atCall = await harness.ContinueAsync(ThreadId(entry));
		Assert.Equal("breakpoint", Reason(atCall));

		var stepped = await harness.StepAsync("next", ThreadId(atCall));

		Assert.Equal("step", Reason(stepped));
		var after = await harness.DescribeFramesAsync(ThreadId(stepped));
		Assert.True(after.Contains("Main", StringComparison.Ordinal), $"After step over: {after}");
		var (_, line) = await harness.TopFrameAsync(ThreadId(stepped));
		Assert.True(line > call.Line, $"Step over landed on line {line}, not past the call on line {call.Line}.");
	}

	/// <summary>
	/// dnSpy's async stepping: a step over the await lands on the statement after it however the method resumes, and a
	/// step over the method's last statement goes back to the code that waits for its task — not into the task
	/// plumbing the state machine returns to.
	/// </summary>
	[Fact(Timeout = 120_000)]
	public async Task StepsAcrossAnAwaitAndBackToTheAwaiter() {
		var target = FindTarget();
		await using var harness = await StepHarness.StartAsync(target, TestContext.Current.CancellationToken);
		var entry = await harness.NextStopAsync();
		var first = await harness.StatementAsync("AddAsync", "= left + right;");
		var awaitLine = (await harness.StatementAsync("AddAsync", "await Task.Yield();")).Line;
		var returnLine = (await harness.StatementAsync("AddAsync", "return sum;")).Line;
		var caller = await harness.CallStatementAsync("AddAsync");

		await harness.SetLineBreakpointAsync(first);
		var atFirst = await harness.ContinueAsync(ThreadId(entry));
		Assert.Equal("breakpoint", Reason(atFirst));

		var atAwait = await harness.StepAsync("next", ThreadId(atFirst));
		Assert.Equal("step", Reason(atAwait));
		Assert.Equal(awaitLine, (await harness.TopFrameAsync(ThreadId(atAwait))).Line);

		var atReturn = await harness.StepAsync("next", ThreadId(atAwait));
		Assert.Equal("step", Reason(atReturn));
		var (returnFrame, line) = await harness.TopFrameAsync(ThreadId(atReturn));
		Assert.Contains("AddAsync", returnFrame, StringComparison.Ordinal);
		Assert.Equal(returnLine, line);

		// The task completes on the thread the method resumed on; the awaiter is Main, waiting for it.
		var back = await harness.StepAsync("next", ThreadId(atReturn));
		Assert.Equal("step", Reason(back));
		var frames = await harness.DescribeFramesAsync(ThreadId(back));
		var (backFrame, backLine) = await harness.TopFrameAsync(ThreadId(back));
		Assert.True(backFrame.Contains("Main", StringComparison.Ordinal), $"Back to the awaiter landed in: {frames}");
		Assert.Equal(caller.Line, backLine);
	}

	/// <summary>
	/// A step out of an async method before it has ever suspended still goes back to the awaiter: the builder makes its
	/// task when it is told to notify the debugger, and that task is the one the method completes.
	/// </summary>
	[Fact(Timeout = 120_000)]
	public async Task StepsOutOfAnAsyncMethodToItsAwaiter() {
		var target = FindTarget();
		await using var harness = await StepHarness.StartAsync(target, TestContext.Current.CancellationToken);
		var entry = await harness.NextStopAsync();
		var caller = await harness.CallStatementAsync("AddAsync");
		await harness.SetLineBreakpointAsync(await harness.StatementAsync("AddAsync", "= left + right;"));
		var atFirst = await harness.ContinueAsync(ThreadId(entry));
		Assert.Equal("breakpoint", Reason(atFirst));

		var back = await harness.StepAsync("stepOut", ThreadId(atFirst));

		Assert.Equal("step", Reason(back));
		var (name, line) = await harness.TopFrameAsync(ThreadId(back));
		Assert.True(name.Contains("Main", StringComparison.Ordinal), $"Step out landed in: {await harness.DescribeFramesAsync(ThreadId(back))}");
		Assert.Equal(caller.Line, line);
	}

	/// <summary>The statement that runs <c>Calculate</c>, named the way the decompiled document shows it.</summary>
	sealed record CallStatement(int MetadataToken, int Line);

	/// <summary>
	/// Stepping into the call of an <c>async</c> method has to land inside the body the user wrote. The
	/// body's IL is a generated <c>MoveNext</c>, so the statement armed is in another method than the
	/// one the call names — but the frame the stop reports still has to read as the user's method.
	/// </summary>
	[Fact(Timeout = 120_000)]
	public async Task StepIntoEntersAnAsyncMethodBody() {
		var target = FindTarget();
		await using var harness = await StepHarness.StartAsync(target, TestContext.Current.CancellationToken);
		var entry = await harness.NextStopAsync();

		await harness.SetLineBreakpointAsync(await harness.CallStatementAsync("AddAsync"));
		var atCall = await harness.ContinueAsync(ThreadId(entry));
		Assert.Equal("breakpoint", Reason(atCall));

		var stepped = await harness.StepAsync("stepIn", ThreadId(atCall));

		Assert.Equal("step", Reason(stepped));
		var after = await harness.DescribeFramesAsync(ThreadId(stepped));
		Assert.True(after.Contains("AddAsync", StringComparison.Ordinal), $"After step into: {after}");
	}
	/// <summary>
	/// A step into a call into another assembly has to land inside it. The callee's module is not one the
	/// workspace holds, so nothing of it is armed from a workspace's own tree — it is read from disk to
	/// find the callee's statements, which is how dnSpy's own engine steps: it asks its decompiler for the
	/// method and the decompiler loads the module. The stop then belongs to the callee's frame, and the
	/// module it is in is named, which is what the client needs to open it.
	/// </summary>
	[Fact(Timeout = 120_000)]
	public async Task StepIntoEntersAFrameworkMethod() {
		var target = FindTarget();
		await using var harness = await StepHarness.StartAsync(target, TestContext.Current.CancellationToken);
		var entry = await harness.NextStopAsync();

		// The fixture writes to the console from a branch as well, so the overload is what picks the call
		// the thread actually reaches: the main path writes the number it computed.
		var call = await harness.CallStatementAsync("WriteLine", callee => callee.MethodSig is { Params.Count: 1 } signature && signature.Params[0].ElementType == ElementType.I4);
		await harness.SetLineBreakpointAsync(call);
		var atCall = await harness.ContinueAsync(ThreadId(entry));
		Assert.Equal("breakpoint", Reason(atCall));
		Assert.True((await harness.DescribeFramesAsync(ThreadId(atCall))).Contains("Main", StringComparison.Ordinal));

		var stepped = await harness.StepAsync("stepIn", ThreadId(atCall));

		Assert.Equal("step", Reason(stepped));
		var (name, _) = await harness.TopFrameAsync(ThreadId(stepped));
		Assert.True(name.StartsWith("System.Console", StringComparison.Ordinal), $"Step into landed on {name}.");
	}

	/// <summary>
	/// A step into lands in the method the statement calls, whether the call names a generic
	/// instantiation or comes after a call the workspace cannot enter at all: <c>ViaDelegate</c>'s
	/// statement constructs its delegate through a framework constructor the debuggee's reference only
	/// forwards, and that constructor has no body to step into. Treating that body-less first call as the
	/// whole statement turned the step into a step over; the step has to keep looking for a call it can
	/// enter.
	/// </summary>
	[Theory(Timeout = 120_000)]
	[InlineData("Identity")]
	[InlineData("ViaDelegate")]
	public async Task StepIntoEntersTheCalleeTheStatementCalls(string callee) {
		var target = FindTarget();
		await using var harness = await StepHarness.StartAsync(target, TestContext.Current.CancellationToken);
		var entry = await harness.NextStopAsync();

		await harness.SetLineBreakpointAsync(await harness.CallStatementAsync(callee));
		var atCall = await harness.ContinueAsync(ThreadId(entry));
		Assert.Equal("breakpoint", Reason(atCall));

		var stepped = await harness.StepAsync("stepIn", ThreadId(atCall));

		Assert.Equal("step", Reason(stepped));
		var after = await harness.DescribeFramesAsync(ThreadId(stepped));
		Assert.True(after.Contains(callee, StringComparison.Ordinal), $"After step into {callee}: {after}");
	}

	/// <summary>
	/// An exception nothing catches stops the debuggee, even though its type is not set to break when
	/// thrown: that is the rule the exception list applies to an unhandled one. The name in the event is
	/// what the client shows, and it comes from the module's metadata rather than from symbols.
	/// </summary>
	[Fact(Timeout = 120_000)]
	public async Task StopsOnAnUnhandledException() {
		var target = FindTarget();
		await using var harness = await StepHarness.StartAsync(target, TestContext.Current.CancellationToken, ["--throw"]);
		var entry = await harness.NextStopAsync();

		var stop = await harness.ContinueAsync(ThreadId(entry));

		Assert.Equal("exception", Reason(stop));
		Assert.Equal("System.InvalidOperationException", stop.Body?.GetProperty("exceptionName").GetString());
		Assert.True(stop.Body?.GetProperty("unhandled").GetBoolean());
	}

	/// <summary>
	/// A caught exception is not a stop under the defaults, and turning on "break when thrown" for its
	/// type is what makes the first chance stop. Both halves matter: the first says the settings are read
	/// at all, the second says they are read per type.
	/// </summary>
	[Fact(Timeout = 120_000)]
	public async Task StopsOnAFirstChanceExceptionOnceItsTypeIsSetToBreak() {
		var target = FindTarget();
		await using var harness = await StepHarness.StartAsync(target, TestContext.Current.CancellationToken, ["--catch"]);
		var entry = await harness.NextStopAsync();

		harness.SetBreakWhenThrown("System.InvalidOperationException", stopFirstChance: true);
		var stop = await harness.ContinueAsync(ThreadId(entry));

		Assert.Equal("exception", Reason(stop));
		Assert.Equal("System.InvalidOperationException", stop.Body?.GetProperty("exceptionName").GetString());
		Assert.False(stop.Body?.GetProperty("unhandled").GetBoolean());
	}

	/// <summary>
	/// The same debuggee with nothing changed. The exception is caught by the fixture, so the run walks
	/// straight to the breakpoint after it: had the first chance stopped, that is the stop the client
	/// would have been handed instead.
	/// </summary>
	[Fact(Timeout = 120_000)]
	public async Task ACaughtExceptionIsNotAStopByDefault() {
		var target = FindTarget();
		await using var harness = await StepHarness.StartAsync(target, TestContext.Current.CancellationToken, ["--catch"]);
		var entry = await harness.NextStopAsync();

		await harness.SetLineBreakpointAsync(await harness.CallStatementAsync("Calculate"));
		var stop = await harness.ContinueAsync(ThreadId(entry));

		Assert.Equal("breakpoint", Reason(stop));
	}

	/// <summary>
	/// Steps, as a client drives them: the target is stopped at the statement that calls a method in
	/// the same module, and each step has to end on the statement the user meant.
	/// </summary>
	sealed class StepHarness : IAsyncDisposable {
		readonly WorkspaceManager workspaceManager;
		readonly CorDebugSessionManager manager;
		readonly Queue<DebugEventNotification> stopped = new();
		readonly SemaphoreSlim signal = new(0);

		public string SessionId { get; private set; } = string.Empty;
		string target = string.Empty;
		string workspaceId = string.Empty;

		StepHarness(WorkspaceManager workspaceManager, CorDebugSessionManager manager) {
			this.workspaceManager = workspaceManager;
			this.manager = manager;
		}

		public static async Task<StepHarness> StartAsync(string target, CancellationToken cancellationToken, IReadOnlyList<string>? arguments = null) {
			var workspaceManager = new WorkspaceManager();
			var manager = CreateManager(workspaceManager);
			var harness = new StepHarness(workspaceManager, manager) { target = target };
			manager.EventReceived += (_, notification) => {
				if (notification.Event != "stopped")
					return;
				lock (harness.stopped)
					harness.stopped.Enqueue(notification);
				harness.signal.Release();
			};
			try {
				var opened = await workspaceManager.OpenAsync(new OpenWorkspaceRequest([target]), cancellationToken);
				harness.workspaceId = opened.WorkspaceId;
				var started = await manager.LaunchAsync(
					new DebugLaunchRequest(target, Arguments: arguments, StopAtEntry: true, WorkspaceId: opened.WorkspaceId),
					cancellationToken);
				harness.SessionId = started.SessionId;
				return harness;
			}
			catch {
				await harness.DisposeAsync();
				throw;
			}
		}

		public async Task<DebugEventNotification> NextStopAsync() {
			await signal.WaitAsync(TestContext.Current.CancellationToken);
			lock (stopped)
				return stopped.Dequeue();
		}

		public async Task<JsonElement?> RequestAsync(string command, object arguments) {
			var response = await manager.RequestAsync(
				new DebugAdapterRequest(SessionId, command, JsonSerializer.SerializeToElement(arguments)),
				TestContext.Current.CancellationToken);
			return response.Body;
		}

		/// <summary>
		/// The line the client shows for the call. The decompiled document numbers its own lines, and they
		/// are not the file's, so the statement is found by the IL offset of the call instead of by a
		/// hard-coded line number. The callee is matched by name, which reaches across assemblies: the
		/// operand of a call into another module is a member reference, not the method itself.
		/// </summary>
		/// <param name="match">Which overload to take when the body calls the name more than once. The
		/// first call that answers it is the one the main path reaches, since the IL is in source order.</param>
		public async Task<CallStatement> CallStatementAsync(string calleeName = "Calculate", Func<IMethod, bool>? match = null) {
			using var module = ModuleDefMD.Load(target);
			var main = module.GetTypes().Single(type => type.Name == "Program").Methods.Single(method => method.Name == "Main");
			var metadataToken = unchecked((int)main.MDToken.Raw);
			var callOffset = (int)main.Body.Instructions
				.First(instruction => instruction.Operand is IMethod callee && callee.Name == calleeName && (match is null || match(callee)))
				.Offset;
			var member = await workspaceManager.FindMemberAsync(
				new FindMemberRequest(workspaceId, target, metadataToken),
				TestContext.Current.CancellationToken);
			var document = await workspaceManager.DecompileAsync(
				new DecompileRequest(workspaceId, member.NodeId!, DecompilerLanguage.CSharp),
				TestContext.Current.CancellationToken);
			var statement = (document.CodeStatements ?? [])
				.Where(statement => !statement.IsHidden)
				.Single(statement => statement.IlOffset <= callOffset && callOffset < statement.IlEndOffset);
			return new CallStatement(metadataToken, statement.StartLine);
		}

		/// <summary>The line of a statement of one of the fixture's methods, found by the text the document writes it with.</summary>
		public async Task<CallStatement> StatementAsync(string methodName, string text) {
			using var module = ModuleDefMD.Load(target);
			var method = module.GetTypes().Single(type => type.Name == "Program").Methods.Single(candidate => candidate.Name == methodName);
			var metadataToken = unchecked((int)method.MDToken.Raw);
			var member = await workspaceManager.FindMemberAsync(new FindMemberRequest(workspaceId, target, metadataToken), TestContext.Current.CancellationToken);
			var document = await workspaceManager.DecompileAsync(new DecompileRequest(workspaceId, member.NodeId!, DecompilerLanguage.CSharp), TestContext.Current.CancellationToken);
			var lines = document.Text.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
			var line = Array.FindIndex(lines, candidate => candidate.Contains(text, StringComparison.Ordinal)) + 1;
			Assert.True(line > 0, $"No line of {methodName} reads '{text}'.");
			return new CallStatement(metadataToken, line);
		}

		public Task SetLineBreakpointAsync(CallStatement call) =>
			RequestAsync("setBreakpoints", new {
				breakpoints = new[] { new { id = "bp1", modulePath = target, metadataToken = call.MetadataToken, line = call.Line } },
			});

		/// <summary>
		/// Turns "break when thrown" on for a type, through the same diff the Exception Settings window
		/// sends. The list is engine-wide, so this reaches the session the harness already started.
		/// </summary>
		public void SetBreakWhenThrown(string name, bool stopFirstChance) =>
			manager.ApplyExceptionSettings(JsonSerializer.SerializeToElement(new {
				updated = new[] {
					new { category = "DotNet", name, code = (int?)null, stopFirstChance, stopSecondChance = false },
				},
			}));

		public async Task<DebugEventNotification> ContinueAsync(int threadId) {
			await RequestAsync("continue", new { threadId });
			return await NextStopAsync();
		}

		public async Task<(string Name, int Line)> TopFrameAsync(int threadId) {
			var stack = await RequestAsync("stackTrace", new { threadId, startFrame = 0, levels = 20 });
			var top = stack?.GetProperty("stackFrames")[0] ?? throw new InvalidOperationException("The stack is empty.");
			return (top.GetProperty("name").GetString() ?? string.Empty, top.GetProperty("line").GetInt32());
		}

		public async Task<string> DescribeFramesAsync(int threadId) {
			var stack = await RequestAsync("stackTrace", new { threadId, startFrame = 0, levels = 20 });
			var described = new List<string>();
			foreach (var frame in stack?.GetProperty("stackFrames").EnumerateArray() ?? default)
				described.Add($"{frame.GetProperty("name").GetString()} @{frame.GetProperty("line").GetInt32()}");
			return string.Join(" | ", described);
		}

		public async Task<DebugEventNotification> StepAsync(string kind, int threadId) {
			await RequestAsync(kind, new { threadId });
			return await NextStopAsync();
		}

		public async ValueTask DisposeAsync() {
			if (!string.IsNullOrEmpty(SessionId)) {
				try {
					await manager.DisconnectAsync(
						new DebugDisconnectRequest(SessionId, TerminateDebuggee: true),
						CancellationToken.None);
				}
				catch {
					// The debuggee may already be gone; nothing left to clean up.
				}
			}
			await manager.DisposeAsync();
			workspaceManager.Dispose();
			signal.Dispose();
		}
	}

	static int ThreadId(DebugEventNotification notification) =>
		notification.Body?.GetProperty("threadId").GetInt32() ?? throw new InvalidOperationException("The stop has no thread ID.");

	static string Reason(DebugEventNotification notification) =>
		notification.Body?.GetProperty("reason").GetString() ?? string.Empty;

	/// <summary>
	/// The session manager loads <c>libdbgshim.so</c> as it is constructed, so a machine without it cannot
	/// run these tests at all — that is a missing dependency, not a failure of the engine.
	/// </summary>
	static CorDebugSessionManager CreateManager(IDebugSymbolResolver symbols) {
		try {
			return new CorDebugSessionManager(symbols);
		}
		catch (FileNotFoundException ex) {
			Assert.Skip($"The dbgshim native library is not available: {ex.Message}");
			throw;
		}
	}

	static string FindTarget() {
		var path = Path.GetFullPath(Path.Combine(
			AppContext.BaseDirectory,
			"..", "..", "..", "..", "DebugTarget", "bin", TestConfiguration, "net10.0", "DebugTarget.dll"));
		return File.Exists(path) ? path : throw new FileNotFoundException("The debug target was not built.", path);
	}

	static string FindAppHost(string target) {
		var directory = Path.GetDirectoryName(target) ?? throw new InvalidOperationException("The debug target has no directory.");
		var name = Path.GetFileNameWithoutExtension(target);
		string[] candidates = OperatingSystem.IsWindows()
			? [Path.Combine(directory, name + ".exe"), Path.Combine(directory, name)]
			: [Path.Combine(directory, name), Path.Combine(directory, name + ".exe")];
		return candidates.FirstOrDefault(File.Exists) ?? throw new FileNotFoundException("The debug target apphost was not built.", candidates[0]);
	}

	static string TestConfiguration => new DirectoryInfo(AppContext.BaseDirectory).Parent?.Name
		?? throw new InvalidOperationException("Could not determine the test configuration.");
}
