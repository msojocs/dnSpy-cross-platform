using System.Text.Json;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>
/// The debugger options the engine itself acts on — the half of WPF's <c>DebuggerSettings</c> that is not
/// purely a matter of display. The client sends the whole set with <c>debug/setOptions</c> whenever the
/// Options dialog changes it, and every session reads the current copy when it needs one, so a change takes
/// effect without restarting the debuggee wherever the runtime allows that.
/// </summary>
public sealed record DebuggerEngineOptions {
	public static readonly DebuggerEngineOptions Default = new();

	/// <summary>Run past <c>Debugger.Break()</c> and the IL <c>break</c> instruction.</summary>
	public bool IgnoreBreakInstructions { get; init; }

	/// <summary>Never stop on an unhandled exception; the process dies the way it would without a debugger.</summary>
	public bool IgnoreUnhandledExceptions { get; init; }

	/// <summary>Load framework modules without JIT optimization, so their locals and statements survive.</summary>
	public bool SuppressJitOptimizationSystemModules { get; init; } = true;

	/// <summary>Load the program's own modules without JIT optimization.</summary>
	public bool SuppressJitOptimizationProgramModules { get; init; } = true;

	/// <summary>Just My Code: steps never stop in code that is not the user's.</summary>
	public bool EnableJustMyCode { get; init; }

	/// <summary>With Just My Code, framework modules are not the user's code.</summary>
	public bool StepOverCodeInSystemModules { get; init; }

	/// <summary>With Just My Code, only the first program module loaded is the user's code.</summary>
	public bool OnlyStepIntoCodeInPrimaryModule { get; init; }

	/// <summary>Hide the debugger from <c>System.Diagnostics.Debugger.IsAttached</c> and friends.</summary>
	public bool PreventManagedDebuggerDetection { get; init; } = true;

	/// <summary>Property getters and other implicit calls may run while the variables windows read values.</summary>
	public bool PropertyEvalAndFunctionCalls { get; init; } = true;

	/// <summary>A variables window may call <c>ToString()</c> to describe an object.</summary>
	public bool UseStringConversionFunction { get; init; } = true;

	/// <summary>A step into does not enter property accessors and operator methods.</summary>
	public bool StepOverPropertiesAndOperators { get; init; } = true;

	/// <summary>A step over an <c>await</c> lands on the statement after it, wherever the continuation runs.</summary>
	public bool AsyncDebugging { get; init; } = true;

	/// <summary>When one process breaks, every other process being debugged breaks with it.</summary>
	public bool BreakAllProcesses { get; init; } = true;

	/// <summary>The Locals window lists the values the methods just stepped over returned.</summary>
	public bool ShowReturnValues { get; init; } = true;

	/// <summary>A GUI program's console output is captured into the Output window too.</summary>
	public bool RedirectGuiConsoleOutput { get; init; } = true;

	// The variables windows' display options: DebuggerSettings.UseHexadecimal and friends, and the
	// formatter settings the windows' context menus switch (DbgEvalFormatterSettings).

	public bool UseHexadecimal { get; init; } = true;

	public bool UseDigitSeparators { get; init; }

	public bool ShowNamespaces { get; init; } = true;

	public bool ShowIntrinsicTypeKeywords { get; init; } = true;

	public bool ShowTokens { get; init; }

	public bool ShowOnlyPublicMembers { get; init; }

	public bool HideCompilerGeneratedMembers { get; init; } = true;

	public bool RespectHideMemberAttributes { get; init; } = true;

	public bool HideDeprecatedError { get; init; }

	public bool ShowRawStructureOfObjects { get; init; }

	public bool SortParameters { get; init; }

	public bool SortLocals { get; init; }

	public bool GroupParametersAndLocalsTogether { get; init; }

	public bool ShowCompilerGeneratedVariables { get; init; }

	public bool ShowDecompilerGeneratedVariables { get; init; } = true;

	public bool ShowRawLocals { get; init; }

	/// <summary>The language expressions are written and values are shown in: "C#" or "Visual Basic".</summary>
	public Evaluation.EvalLanguage Language { get; init; } = Evaluation.EvalLanguage.CSharp;

	public static DebuggerEngineOptions Parse(JsonElement element) {
		if (element.ValueKind != JsonValueKind.Object)
			return Default;
		bool Read(string name, bool fallback) =>
			element.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False ? value.GetBoolean() : fallback;
		return new DebuggerEngineOptions {
			IgnoreBreakInstructions = Read("ignoreBreakInstructions", Default.IgnoreBreakInstructions),
			IgnoreUnhandledExceptions = Read("ignoreUnhandledExceptions", Default.IgnoreUnhandledExceptions),
			SuppressJitOptimizationSystemModules = Read("suppressJitOptimizationSystemModules", Default.SuppressJitOptimizationSystemModules),
			SuppressJitOptimizationProgramModules = Read("suppressJitOptimizationProgramModules", Default.SuppressJitOptimizationProgramModules),
			EnableJustMyCode = Read("enableJustMyCodeDebugging", Default.EnableJustMyCode),
			StepOverCodeInSystemModules = Read("stepOverCodeInSystemModules", Default.StepOverCodeInSystemModules),
			OnlyStepIntoCodeInPrimaryModule = Read("onlyStepIntoCodeInPrimaryModule", Default.OnlyStepIntoCodeInPrimaryModule),
			PreventManagedDebuggerDetection = Read("preventManagedDebuggerDetection", Default.PreventManagedDebuggerDetection),
			PropertyEvalAndFunctionCalls = Read("propertyEvalAndFunctionCalls", Default.PropertyEvalAndFunctionCalls),
			UseStringConversionFunction = Read("useStringConversionFunction", Default.UseStringConversionFunction),
			StepOverPropertiesAndOperators = Read("stepOverPropertiesAndOperators", Default.StepOverPropertiesAndOperators),
			AsyncDebugging = Read("asyncDebugging", Default.AsyncDebugging),
			BreakAllProcesses = Read("breakAllProcesses", Default.BreakAllProcesses),
			ShowReturnValues = Read("showReturnValues", Default.ShowReturnValues),
			RedirectGuiConsoleOutput = Read("redirectGuiConsoleOutput", Default.RedirectGuiConsoleOutput),
			UseHexadecimal = Read("useHexadecimal", Default.UseHexadecimal),
			UseDigitSeparators = Read("useDigitSeparators", Default.UseDigitSeparators),
			ShowNamespaces = Read("showNamespaces", Default.ShowNamespaces),
			ShowIntrinsicTypeKeywords = Read("showIntrinsicTypeKeywords", Default.ShowIntrinsicTypeKeywords),
			ShowTokens = Read("showTokens", Default.ShowTokens),
			ShowOnlyPublicMembers = Read("showOnlyPublicMembers", Default.ShowOnlyPublicMembers),
			HideCompilerGeneratedMembers = Read("hideCompilerGeneratedMembers", Default.HideCompilerGeneratedMembers),
			RespectHideMemberAttributes = Read("respectHideMemberAttributes", Default.RespectHideMemberAttributes),
			HideDeprecatedError = Read("hideDeprecatedError", Default.HideDeprecatedError),
			ShowRawStructureOfObjects = Read("showRawStructureOfObjects", Default.ShowRawStructureOfObjects),
			SortParameters = Read("sortParameters", Default.SortParameters),
			SortLocals = Read("sortLocals", Default.SortLocals),
			GroupParametersAndLocalsTogether = Read("groupParametersAndLocalsTogether", Default.GroupParametersAndLocalsTogether),
			ShowCompilerGeneratedVariables = Read("showCompilerGeneratedVariables", Default.ShowCompilerGeneratedVariables),
			ShowDecompilerGeneratedVariables = Read("showDecompilerGeneratedVariables", Default.ShowDecompilerGeneratedVariables),
			ShowRawLocals = Read("showRawLocals", Default.ShowRawLocals),
			Language = element.TryGetProperty("debugLanguage", out var language) && language.ValueKind == JsonValueKind.String && language.GetString() == "Visual Basic"
				? Evaluation.EvalLanguage.VisualBasic
				: Evaluation.EvalLanguage.CSharp,
		};
	}
}
