using dnlib.DotNet;
using dnSpy.Backend.Core.IL;

namespace dnSpy.Backend.Core;

public sealed partial class WorkspaceManager {
	/// <summary>
	/// The parts of the workspace's document decompilers that need no workspace: what dnSpy.Console writes a type or
	/// a member with, and what the project export converts a file with.
	/// </summary>
	internal static class SharedDecompilers {
		/// <summary>The color class of what a reference in decompiled C# names.</summary>
		public static string? SpanColorOf(object reference) => Workspace.SpanColorOf(reference);

		/// <summary>IL with C#'s statements of a method body.</summary>
		public static SourceStatementProvider CreateSourceStatementProvider(ICSharpCode.Decompiler.CSharp.CSharpDecompiler decompiler, ICSharpCode.Decompiler.DecompilerSettings settings, MethodDef method, CancellationToken cancellationToken) =>
			Workspace.CreateSourceStatementProvider(decompiler, settings, method, cancellationToken);

		/// <summary>The summary the framework's documentation gives a documentation id (the IL view's opcode comments).</summary>
		public static string? FrameworkDocumentation(string id) => Workspace.FrameworkDocumentation(id);

		/// <summary>The inner XML a module's XML documentation file has for a documentation id.</summary>
		public static string? RawXmlDocumentation(ModuleDef module, string key) => Workspace.RawXmlDocumentation(module, key);

		/// <summary>The colors of Visual Basic text compiled against <paramref name="referencePaths"/>.</summary>
		public static IReadOnlyList<dnSpy.Backend.Contracts.ClassifiedSpanDto> ClassifyVisualBasic(string text, IReadOnlyList<string> referencePaths, CancellationToken cancellationToken) =>
			Workspace.ClassifyVisualBasic(text, referencePaths, cancellationToken);

		/// <summary>C# that is only attributes as Visual Basic.</summary>
		public static Task<string> AttributesToVisualBasicAsync(string source, CancellationToken cancellationToken) =>
			Workspace.AttributesToVisualBasicAsync(source, cancellationToken);
	}
}
