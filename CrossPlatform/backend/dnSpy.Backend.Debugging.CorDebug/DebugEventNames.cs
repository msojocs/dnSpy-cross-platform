namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>Debug event names, mirroring the vocabulary the client already understands.</summary>
internal static class DebugEventNames {
	public const string Stopped = "stopped";
	public const string Continued = "continued";
	public const string Output = "output";
	public const string Exited = "exited";
	public const string Terminated = "terminated";
	public const string Breakpoint = "breakpoint";
	public const string Process = "process";
	public const string Module = "module";
	public const string Thread = "thread";
	/// <summary>An exception was thrown, whether or not it stopped the debuggee — the Output window logs it.</summary>
	public const string Exception = "exception";
	/// <summary>Debugger.Break() or the IL break instruction.</summary>
	public const string UserBreak = "user-break";
	/// <summary>A Run to Cursor reached its location.</summary>
	public const string RunToCursor = "run-to-cursor";
	/// <summary>A module breakpoint matched a module that loaded.</summary>
	public const string ModuleBreakpoint = "module-breakpoint";
}

/// <summary>Why the process stopped, as reported in a <c>stopped</c> event.</summary>
internal static class StopReasons {
	public const string Breakpoint = "breakpoint";
	public const string Step = "step";
	public const string Pause = "pause";
	public const string Entry = "entry";
	public const string CreateProcess = "create-process";
	public const string Exception = "exception";
	/// <summary>Debugger.Break() or the IL break instruction.</summary>
	public const string UserBreak = "user-break";
	/// <summary>A Run to Cursor reached its location.</summary>
	public const string RunToCursor = "run-to-cursor";
	/// <summary>A module breakpoint matched a module that loaded.</summary>
	public const string ModuleBreakpoint = "module-breakpoint";
}
