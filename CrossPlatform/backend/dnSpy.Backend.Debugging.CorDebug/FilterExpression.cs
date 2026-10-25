using System.Collections.Concurrent;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>
/// The breakpoint filter's expression language: the C# of dnSpy's Roslyn filter evaluator, whose five
/// names are <c>MachineName</c>, <c>ProcessId</c>, <c>ProcessName</c>, <c>ThreadId</c> and
/// <c>ThreadName</c>. WPF binds the text against those five values and interprets the result; the port
/// compiles the same body in-process and calls it, so <c>ProcessName.Contains(".Tests")</c> and every
/// other expression WPF accepts work here too.
/// </summary>
internal static class FilterExpression {
	/// <summary>One compiled filter, or the compiler's message when it did not bind.</summary>
	sealed record Compiled(MethodInfo? Method, string? Error);

	static readonly ConcurrentDictionary<string, Compiled> cache = new(StringComparer.Ordinal);

	static readonly Lazy<IReadOnlyList<MetadataReference>> references = new(() => {
		var paths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
			?.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries) ?? [];
		// The filter can use the BCL the debugger itself runs on: string methods, LINQ and the rest. A
		// single-file host has no TPA list, so fall back to the assemblies this file itself references.
		if (paths.Length == 0)
			paths = [typeof(object).Assembly.Location, typeof(Enumerable).Assembly.Location, typeof(string).Assembly.Location];
		return paths.Where(path => !string.IsNullOrEmpty(path)).Distinct(StringComparer.OrdinalIgnoreCase).Select(path => (MetadataReference)MetadataReference.CreateFromFile(path)).ToArray();
	});

	static Compiled Compile(string text) => cache.GetOrAdd(text, static filter => {
		var source = $$"""
			using System;
			using System.Collections.Generic;
			using System.Linq;
			using System.Text;
			static class __dnSpy_Filter {
				public static bool __Evaluate(string MachineName, int ProcessId, string ProcessName, ulong ThreadId, string? ThreadName) => ({{filter}});
			}
			""";
		var tree = CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest));
		var compilation = CSharpCompilation.Create(
			"__dnSpy_Filter_" + Guid.NewGuid().ToString("N"),
			[tree],
			references.Value,
			new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable));
		using var stream = new MemoryStream();
		var result = compilation.Emit(stream);
		if (!result.Success) {
			var messages = result.Diagnostics
				.Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
				.Select(diagnostic => diagnostic.GetMessage())
				.Distinct(StringComparer.Ordinal)
				.ToArray();
			return new Compiled(null, messages.Length == 0 ? "The filter expression is not valid C#." : string.Join(Environment.NewLine, messages));
		}
		stream.Position = 0;
		var method = Assembly.Load(stream.ToArray()).GetType("__dnSpy_Filter")?.GetMethod("__Evaluate", BindingFlags.Public | BindingFlags.Static);
		return method is null
			? new Compiled(null, "The filter expression is not valid C#.")
			: new Compiled(method, null);
	});

	/// <summary>dnSpy's IsValidExpression: null when the filter binds, else the compiler's reason.</summary>
	public static string? Validate(string filter) => Compile(filter).Error;

	/// <summary>Runs the filter against one hit. Throws when it is not a bool or the expression throws.</summary>
	public static bool Evaluate(string filter, string machineName, int processId, string processName, ulong threadId, string? threadName) {
		var compiled = Compile(filter);
		if (compiled.Method is null)
			throw new BreakpointEvaluationException(compiled.Error ?? "The filter expression is not valid C#.");
		try {
			var value = compiled.Method.Invoke(null, [machineName, processId, processName, threadId, threadName]);
			return value is bool result
				? result
				: throw new BreakpointEvaluationException("The filter expression is not a boolean expression.");
		}
		catch (TargetInvocationException ex) {
			throw new BreakpointEvaluationException(ex.InnerException?.Message ?? ex.Message);
		}
	}
}
