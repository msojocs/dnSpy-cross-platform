namespace dnSpy.Contracts.AsmEditor.Compiler;

/// <summary>The severity of a compiler diagnostic — dnSpy's own enum, as Roslyn reports it.</summary>
public enum CompilerDiagnosticSeverity {
	Hidden,
	Info,
	Warning,
	Error,
}

/// <summary>A position in a source file, zero-based — dnSpy's <c>LineLocation</c>.</summary>
public readonly struct LineLocation(int line, int character) {
	public int Line { get; } = line;
	public int Character { get; } = character;
	public override string ToString() => $"({Line + 1},{Character + 1})";
}

/// <summary>The span between two source positions — dnSpy's <c>LineLocationSpan</c>.</summary>
public readonly struct LineLocationSpan(LineLocation startLinePosition, LineLocation endLinePosition) {
	public LineLocation StartLinePosition { get; } = startLinePosition;
	public LineLocation EndLinePosition { get; } = endLinePosition;
	public override string ToString() => $"{StartLinePosition}-{EndLinePosition}";
}

/// <summary>One diagnostic the compiler reported — dnSpy's <c>CompilerDiagnostic</c>.</summary>
public sealed class CompilerDiagnostic(
	CompilerDiagnosticSeverity severity,
	string description,
	string id,
	string? helpUri,
	string? filename,
	LineLocationSpan? lineLocationSpan) {
	public CompilerDiagnosticSeverity Severity { get; } = severity;
	public string Description { get; } = description ?? string.Empty;
	public string Id { get; } = id ?? string.Empty;
	public string? HelpUri { get; } = helpUri;
	public string? Filename { get; } = filename;
	public LineLocationSpan? LineLocationSpan { get; } = lineLocationSpan;

	public override string ToString() {
		var filename = Filename ?? "???";
		var position = LineLocationSpan is { } span ? span.StartLinePosition.ToString() : string.Empty;
		var severity = Severity switch {
			CompilerDiagnosticSeverity.Hidden => "hidden",
			CompilerDiagnosticSeverity.Info => "info",
			CompilerDiagnosticSeverity.Warning => "warning",
			_ => "error",
		};
		return $"{filename}{position}: {severity} {Id}: {Description}";
	}
}

/// <summary>The format of a compiled debug file — dnSpy's <c>DebugFileFormat</c>.</summary>
public enum DebugFileFormat {
	None,
	Pdb,
	PortablePdb,
	Embedded,
}

/// <summary>A compiled PDB — dnSpy's <c>DebugFileResult</c>.</summary>
public readonly struct DebugFileResult(DebugFileFormat format, byte[]? rawFile) {
	public byte[]? RawFile { get; } = rawFile;
	public DebugFileFormat Format { get; } = format;
}

/// <summary>What was compiled — dnSpy's <c>CompilationKind</c>.</summary>
public enum CompilationKind {
	EditAssembly,
	EditMethod,
	AddClass,
	EditClass,
	AddMembers,
}

/// <summary>The output of a compiler run — dnSpy's <c>CompilationResult</c>.</summary>
public readonly struct CompilationResult {
	public bool Success => RawFile is not null;
	public byte[]? RawFile { get; }
	public DebugFileResult DebugFile { get; }
	public CompilerDiagnostic[] Diagnostics { get; }

	public CompilationResult(byte[] rawFile, DebugFileResult? debugFile = null, CompilerDiagnostic[]? diagnostics = null) {
		RawFile = rawFile;
		DebugFile = debugFile ?? new DebugFileResult(DebugFileFormat.None, null);
		Diagnostics = diagnostics ?? [];
	}

	public CompilationResult(CompilerDiagnostic[] diagnostics) {
		RawFile = null;
		DebugFile = new DebugFileResult(DebugFileFormat.None, null);
		Diagnostics = diagnostics;
	}
}
