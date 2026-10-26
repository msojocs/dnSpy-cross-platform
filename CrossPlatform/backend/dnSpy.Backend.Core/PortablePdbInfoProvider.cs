using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using ICSharpCode.Decompiler.DebugInfo;
using DebugSequencePoint = ICSharpCode.Decompiler.DebugInfo.SequencePoint;

namespace dnSpy.Backend.Core;

/// <summary>
/// The portable PDB beside a module, read for the local variable names dnSpy's C# writes with UseDebugSymbols (its
/// default) — the names dnlib reads out of the same file for dnSpy's own decompiler. When there is no PDB the code is
/// still written, with the names the decompiler makes up.
/// </summary>
sealed class PortablePdbInfoProvider : IDebugInfoProvider, IDisposable {
	readonly MetadataReaderProvider provider;
	readonly MetadataReader reader;
	readonly string? sourceFileName;

	PortablePdbInfoProvider(MetadataReaderProvider provider) {
		this.provider = provider;
		reader = provider.GetMetadataReader();
		sourceFileName = reader.Documents.Count == 0 ? null : GetDocumentName(reader.GetDocument(reader.Documents.First()));
	}

	public static PortablePdbInfoProvider? TryCreate(string modulePath) {
		try {
			var pdbPath = Path.ChangeExtension(modulePath, ".pdb");
			if (!File.Exists(pdbPath))
				return null;
			var pdb = MetadataReaderProvider.FromPortablePdbStream(new MemoryStream(File.ReadAllBytes(pdbPath), writable: false));
			try {
				return new PortablePdbInfoProvider(pdb);
			}
			catch {
				pdb.Dispose();
				throw;
			}
		}
		catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or BadImageFormatException) {
			return null;
		}
	}

	public string? Description => "Portable PDB";
	public string? SourceFileName => sourceFileName;

	public IList<ICSharpCode.Decompiler.DebugInfo.SequencePoint> GetSequencePoints(MethodDefinitionHandle method) {
		var points = new List<DebugSequencePoint>();
		try {
			var debugInformation = reader.GetMethodDebugInformation(method);
			if (debugInformation.SequencePointsBlob.IsNil)
				return points;
			var sequencePoints = debugInformation.GetSequencePoints().ToArray();
			for (var i = 0; i < sequencePoints.Length; i++) {
				var point = sequencePoints[i];
				points.Add(new DebugSequencePoint {
					Offset = point.Offset,
					EndOffset = i + 1 < sequencePoints.Length ? sequencePoints[i + 1].Offset : point.Offset,
					StartLine = point.StartLine,
					StartColumn = point.StartColumn,
					EndLine = point.EndLine,
					EndColumn = point.EndColumn,
					DocumentUrl = point.Document.IsNil ? sourceFileName ?? string.Empty : GetDocumentName(reader.GetDocument(point.Document)),
				});
			}
		}
		catch (BadImageFormatException) {
		}
		return points;
	}

	public IList<Variable> GetVariables(MethodDefinitionHandle method) {
		var variables = new List<Variable>();
		try {
			foreach (var scopeHandle in reader.GetLocalScopes(method)) {
				var scope = reader.GetLocalScope(scopeHandle);
				foreach (var variableHandle in scope.GetLocalVariables()) {
					var variable = reader.GetLocalVariable(variableHandle);
					if (!variable.Name.IsNil)
						variables.Add(new Variable(variable.Index, reader.GetString(variable.Name)));
				}
			}
		}
		catch (BadImageFormatException) {
		}
		return variables;
	}

	public bool TryGetName(MethodDefinitionHandle method, int index, out string name) {
		foreach (var variable in GetVariables(method)) {
			if (variable.Index == index) {
				name = variable.Name;
				return true;
			}
		}
		name = string.Empty;
		return false;
	}

	public bool TryGetExtraTypeInfo(MethodDefinitionHandle method, int index, out PdbExtraTypeInfo extraTypeInfo) {
		extraTypeInfo = default;
		return false;
	}

	string GetDocumentName(Document document) =>
		document.Name.IsNil ? string.Empty : reader.GetString(document.Name);

	public void Dispose() => provider.Dispose();
}
