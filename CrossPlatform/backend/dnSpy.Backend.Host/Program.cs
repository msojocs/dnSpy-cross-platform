using System.Diagnostics;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using dnSpy.Backend.Core.LanguageService;
using dnSpy.Backend.Debugging.CorDebug;
using dnSpy.Backend.Host;

var options = HostOptions.Parse(args);
using var shutdown = new CancellationTokenSource();
using var workspaceManager = new WorkspaceManager();
using var scriptService = new CSharpScriptService();
using var languageService = new RoslynLanguageService();
// The workspace manager resolves decompiled-source breakpoints to IL for the debug engine, so the
// engine is created after it and handed the interface. A null engine means the host runs without
// debugging (see DebugManagerFactory).
await using var debugManager = DebugManagerFactory.TryCreate(workspaceManager);
using var cancelHandler = new ConsoleCancelHandler(shutdown);

if (options.ParentProcessId is int parentProcessId)
	_ = ParentProcessMonitor.StopWhenParentExitsAsync(parentProcessId, shutdown);

var server = new JsonRpcServer(
	Console.OpenStandardInput(),
	Console.OpenStandardOutput(),
	workspaceManager,
	scriptService,
	languageService,
	debugManager,
	options,
	shutdown);

try {
	await server.RunAsync(shutdown.Token).ConfigureAwait(false);
	return 0;
}
catch (OperationCanceledException) when (shutdown.IsCancellationRequested) {
	return 0;
}
catch (Exception ex) {
	HostLog.Error("host-failed", ex);
	return 1;
}

namespace dnSpy.Backend.Host {
	internal sealed record HostOptions(string? Nonce, int? ParentProcessId) {
		public static HostOptions Parse(string[] args) {
			string? nonce = null;
			int? parentProcessId = null;
			for (var i = 0; i < args.Length; i++) {
				switch (args[i]) {
					case "--nonce" when i + 1 < args.Length:
						nonce = args[++i];
						break;
					case "--parent-pid" when i + 1 < args.Length && int.TryParse(args[++i], out var pid):
						parentProcessId = pid;
						break;
				}
			}
			return new HostOptions(nonce, parentProcessId);
		}
	}

	internal sealed class ConsoleCancelHandler : IDisposable {
		readonly CancellationTokenSource shutdown;

		public ConsoleCancelHandler(CancellationTokenSource shutdown) {
			this.shutdown = shutdown;
			Console.CancelKeyPress += OnCancelKeyPress;
		}

		void OnCancelKeyPress(object? sender, ConsoleCancelEventArgs e) {
			e.Cancel = true;
			shutdown.Cancel();
		}

		public void Dispose() => Console.CancelKeyPress -= OnCancelKeyPress;
	}

	internal static class ParentProcessMonitor {
		public static async Task StopWhenParentExitsAsync(int parentProcessId, CancellationTokenSource shutdown) {
			try {
				using var parent = Process.GetProcessById(parentProcessId);
				await parent.WaitForExitAsync(shutdown.Token).ConfigureAwait(false);
				await shutdown.CancelAsync().ConfigureAwait(false);
			}
			catch (ArgumentException) {
				await shutdown.CancelAsync().ConfigureAwait(false);
			}
			catch (OperationCanceledException) {
			}
			catch (Exception ex) {
				HostLog.Error("parent-monitor-failed", ex);
			}
		}
	}

	internal static class DebugManagerFactory {
		/// <param name="symbols">
		/// Resolves decompiled-source breakpoints to IL identities. Supplied by the workspace
		/// manager once it implements <see cref="IDebugSymbolResolver"/>.
		/// </param>
		public static CorDebugSessionManager? TryCreate(IDebugSymbolResolver? symbols = null) {
			try {
				return new CorDebugSessionManager(symbols);
			}
			catch (FileNotFoundException ex) {
				// libdbgshim.so is missing: the host still runs, but reports debug.coreclr.* as false.
				HostLog.Error("debugger-unavailable", ex);
				return null;
			}
		}
	}
}
