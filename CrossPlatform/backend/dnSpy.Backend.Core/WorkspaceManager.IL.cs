using System.Collections.Concurrent;
using System.Text;
using System.Xml;
using dnlib.DotNet;
using dnlib.DotNet.Emit;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.IL;
using dnSpy.Backend.Core.Output;
using dnSpy.Decompiler.Utils;

namespace dnSpy.Backend.Core;

/// <summary>
/// The IL and IL with C# documents: dnSpy's <c>ILDecompiler</c> and <c>ILWithCSharpDecompiler</c>, which write the
/// structured IL of its ILSpy fork's disassembler (ported to <see cref="dnSpy.Backend.Core.IL"/>) through a
/// <see cref="DocumentOutput"/>. Every member the document declares is a definition span (node, module and token —
/// where a token bookmark sits); every member an instruction names a reference span, resolved the way the
/// analyzer resolves it so Show Reference in Method lands on it; every instruction a statement, which a
/// breakpoint, a bookmark, a search hit and the current statement are placed on.
/// </summary>
public sealed partial class WorkspaceManager {
	sealed partial class Workspace {
		/// <summary>dnSpy's <c>NodeDecompiler</c> for the IL languages: a document per node kind, the way WPF dispatches it.</summary>
		DecompileResponse DecompileILDocument(NodeEntry node, DecompilerSettingsDto? settingsDto, bool withCSharp, CancellationToken cancellationToken) {
			var moduleEntry = node.AsModuleEntry ?? throw new RpcException(ErrorCodes.UnsupportedDocument, "This tree node has no IL representation.");
			var settings = ToILSettings(settingsDto?.IL);
			// What the instructions name is found the way the analyzer finds it, among what is loaded: drawing a
			// method does not load the assemblies its calls go to.
			var host = new AnalyzerHost(this, null, loadOnDemand: false);
			var output = new DocumentOutput((reference, flags, color, start, length) => ILSpanOf(moduleEntry, host, reference, flags, color, start, length));
			CSharpDecompilerSession? csharp = null;
			try {
				var csharpSettings = ILWithCSharpSettings(settingsDto);
				if (withCSharp)
					csharp = CreateCSharpDecompilerSession(moduleEntry, csharpSettings, cancellationToken);
				var context = new ILDecompilationContext {
					CancellationToken = cancellationToken,
					IsBodyModified = method => IsBodyModified(moduleEntry, method),
					GetXmlDocumentation = (module, key) => RawXmlDocumentation(module, key),
					GetFrameworkDocumentation = FrameworkDocumentation,
					CreateSourceStatementProvider = csharp is null ? null : method => CreateSourceStatementProvider(csharp.Decompiler, csharpSettings, method, cancellationToken),
				};
				var decompiler = new ILDecompiler(settings, context);
				using (MetadataTextColorProvider.UseResolver(new HostMetadataResolver(this, host))) {
					switch (node.Value) {
					case AssemblyDef assembly:
						decompiler.Decompile(assembly, output);
						break;
					case ModuleDef module:
						decompiler.Decompile(module, output);
						break;
					case NamespaceValue ns:
						// The row's types as the tree lists them, read live: an edit changes the module, not the snapshot.
						ILDecompiler.DecompileNamespace(ns.Name, GetNamespaceIndex(moduleEntry).Groups.TryGetValue(ns.Name, out var group) ? SortTypes(group).ToArray() : [], output);
						break;
					case TypeDef type:
						decompiler.Decompile(type, output);
						break;
					case MethodDef method:
						decompiler.Decompile(method, output);
						break;
					case FieldDef field:
						decompiler.Decompile(field, output);
						break;
					case PropertyDef property:
						decompiler.Decompile(property, output);
						break;
					case EventDef @event:
						decompiler.Decompile(@event, output);
						break;
					default:
						throw new RpcException(ErrorCodes.UnsupportedDocument, "This tree node has no IL representation.");
					}
				}
				var diagnostics = csharp is null
					? Array.Empty<DiagnosticDto>()
					: csharp.Decompiler.Errors.Select(error => new DiagnosticDto("warning", error.ToString())).ToArray();
				return output.ToResponse(GetDocumentTitle(node), "il", moduleEntry.Path, diagnostics);
			}
			finally {
				csharp?.Dispose();
			}
		}

		/// <summary>The IL settings the client sent, or dnSpy's defaults (<c>ILSettings</c>) when it sent none.</summary>
		static ILDecompilerSettings ToILSettings(ILDecompilerSettingsDto? dto) {
			dto ??= new ILDecompilerSettingsDto();
			return new ILDecompilerSettings {
				ShowXmlDocumentation = dto.ShowXmlDocumentation,
				ShowTokenAndRvaComments = dto.ShowTokenAndRvaComments,
				ShowILBytes = dto.ShowILBytes,
				ShowILComments = dto.ShowILComments,
				SortMembers = dto.SortMembers,
				ShowPdbInfo = dto.ShowPdbInfo,
				HexadecimalNumbers = dto.HexadecimalNumbers,
				MaxStringLength = dto.MaxStringLength,
			};
		}

		/// <summary>
		/// The C# decompiler settings IL with C# decompiles a body with: dnSpy clones the C# settings and turns using
		/// declarations off, since only the statements are shown.
		/// </summary>
		static ICSharpCode.Decompiler.DecompilerSettings ILWithCSharpSettings(DecompilerSettingsDto? settingsDto) {
			var settings = settingsDto.ToDecompilerSettings();
			settings.UsingDeclarations = false;
			return settings;
		}

		/// <summary>
		/// The span a reference the disassembler wrote becomes. A member the document declares is a definition with
		/// its node, module and token; a member an instruction or a signature names is a reference to it; a label,
		/// a generic parameter and a field's data label tie their uses together inside the document the way a local
		/// does; a token comment names the member it is the token of.
		/// </summary>
		TextSpanDto? ILSpanOf(ModuleEntry moduleEntry, AnalyzerHost host, object reference, DecompilerReferenceFlags flags, string color, int start, int length) {
			var kind = (flags & DecompilerReferenceFlags.Definition) != 0 ? "definition" : "reference";
			switch (reference) {
			case InstructionReference instruction:
				return LocalSpan($"IL:{instruction.Method.MDToken.Raw:X8}:{instruction.Instruction.Offset:X4}");
			case GenericParam genericParam:
				return LocalSpan($"GP:{genericParam.MDToken.Raw:X8}");
			case Tuple<FieldDef, dnlib.PE.RVA> data:
				return LocalSpan($"RVA:{data.Item1.MDToken.Raw:X8}");
			case TokenReference token:
				return TokenSpan(token);
			case IMemberDef member when kind == "definition":
				return DefinitionSpan(member);
			case ExportedType exportedType:
				return ReferenceSpan(exportedType.ToTypeRef());
			case IMemberRef member:
				return ReferenceSpan(member);
			default:
				return null;
			}

			TextSpanDto LocalSpan(string id) => new(start, length, kind) { Color = color, LocalId = id };

			TextSpanDto? DefinitionSpan(IMemberDef member) {
				if (member.Module != moduleEntry.Module || ResolveInModule(moduleEntry, member.MDToken.Raw) is not { } target)
					return null;
				return new TextSpanDto(start, length, "definition", target.NodeId, target.ModulePath, target.MetadataToken) { Color = color };
			}

			TextSpanDto? ReferenceSpan(object member) {
				if (ILReferenceTarget(host, member) is not { } target)
					return null;
				return new TextSpanDto(start, length, "reference", target.NodeId, target.ModulePath, target.MetadataToken) { Color = color };
			}

			// dnSpy's TokenReference: the token of a member names the member, so Copy MD Token and Go to Definition
			// work on it; a token of anything else (a signature, an assembly reference) is only text.
			TextSpanDto? TokenSpan(TokenReference token) {
				IMDTokenProvider? provider;
				try {
					provider = token.Module.ResolveToken(token.Token);
				}
				catch (Exception) {
					return null;
				}
				if (provider is IMemberDef definition && definition.Module == moduleEntry.Module && ResolveInModule(moduleEntry, token.Token) is { } target)
					return new TextSpanDto(start, length, "reference", target.NodeId, target.ModulePath, target.MetadataToken) { Color = color };
				return provider is IMemberRef memberRef and (ITypeDefOrRef or IMethod or IField) ? ReferenceSpan(memberRef) : null;
			}
		}

		/// <summary>
		/// dnSpy's <c>DecompilationContext.IsBodyModified</c>: whether a body is no longer the one the file holds, which
		/// decides whether its instruction bytes are read from the file or encoded from the instructions. The port
		/// keeps no per-body edit history, so a body counts as modified when its encoding disagrees with the file's
		/// bytes — the comparison Copy IL Bytes makes.
		/// </summary>
		static bool IsBodyModified(ModuleEntry moduleEntry, MethodDef method) {
			if (!moduleEntry.HasModelEdits || method.Body is not { } body)
				return false;
			if (!HexTargets.TryGetMethodBody(method, out _, out _, out var codeOffset, out var codeSize))
				return true;
			var encoded = new List<short>();
			foreach (var instruction in body.Instructions) {
				AddOpCode(encoded, instruction.OpCode);
				AddOperand(encoded, moduleEntry.Module, instruction.Offset + (uint)instruction.OpCode.Size, instruction.OpCode, instruction.Operand);
			}
			if (encoded.Count != codeSize)
				return true;
			try {
				var reader = moduleEntry.Module.Metadata.PEImage.CreateReader();
				reader.Position = (uint)codeOffset;
				var original = reader.ReadBytes((int)codeSize);
				for (var i = 0; i < original.Length; i++) {
					if (encoded[i] >= 0 && encoded[i] != original[i])
						return true;
				}
				return false;
			}
			catch (Exception ex) when (ex is IOException or ArgumentException or InvalidOperationException) {
				return true;
			}
		}

		/// <summary>
		/// dnSpy's <c>ILWithCSharpDecompiler.GetDebugInfo</c>: the C# a body decompiles to and the IL of each of its
		/// statements. The body of a state machine's MoveNext is shown as the async or iterator method it was written
		/// as; when that does not decompile to it, MoveNext is decompiled by itself with the state machines left as
		/// they are.
		/// </summary>
		internal static SourceStatementProvider CreateSourceStatementProvider(ICSharpCode.Decompiler.CSharp.CSharpDecompiler decompiler, ICSharpCode.Decompiler.DecompilerSettings settings, MethodDef method, CancellationToken cancellationToken) {
			if (!method.HasBody)
				return default;
			try {
				if (StateMachineHelpers.TryGetKickoffMethod(method, out var kickoffMethod)
					&& TryCreateSourceStatementProvider(decompiler, settings, kickoffMethod, method, cancellationToken) is { } fromKickoff)
					return fromKickoff;
				var (asyncAwait, yieldReturn) = (settings.AsyncAwait, settings.YieldReturn);
				settings.AsyncAwait = false;
				settings.YieldReturn = false;
				try {
					return TryCreateSourceStatementProvider(decompiler, settings, method, method, cancellationToken) ?? default;
				}
				finally {
					settings.AsyncAwait = asyncAwait;
					settings.YieldReturn = yieldReturn;
				}
			}
			catch (OperationCanceledException) {
				throw;
			}
			catch (Exception) {
				// A body ILSpy cannot decompile is still IL; it only has no C# above it.
				return default;
			}
		}

		static SourceStatementProvider? TryCreateSourceStatementProvider(ICSharpCode.Decompiler.CSharp.CSharpDecompiler decompiler, ICSharpCode.Decompiler.DecompilerSettings settings, MethodDef decompiled, MethodDef body, CancellationToken cancellationToken) {
			cancellationToken.ThrowIfCancellationRequested();
			var syntaxTree = decompiler.Decompile([ToEntityHandle(decompiled)]);
			var output = new SpanTextOutput(_ => null);
			RenderWithLocations(syntaxTree, output, settings);
			var text = output.ToString();
			var lineStarts = new List<int> { 0 };
			for (var i = 0; i < text.Length; i++) {
				if (text[i] == '\n')
					lineStarts.Add(i + 1);
			}
			int OffsetOf(int line, int column) {
				if (line < 1 || line > lineStarts.Count)
					return -1;
				var lineStart = lineStarts[line - 1];
				var lineEnd = line < lineStarts.Count ? lineStarts[line] - 1 : text.Length;
				return Math.Min(lineStart + Math.Max(column, 1) - 1, lineEnd);
			}
			var bodyToken = body.MDToken.Raw;
			var statements = new List<SourceStatement>();
			var statementStarts = StatementIlRanges.Collect(syntaxTree);
			foreach (var (function, points) in decompiler.CreateSequencePoints(syntaxTree)) {
				if (GetBodyMethodToken(function) != bodyToken)
					continue;
				statementStarts.TryGetValue(function, out var starts);
				foreach (var point in points) {
					if (point.IsHidden || point.EndOffset <= point.Offset)
						continue;
					var startOffset = OffsetOf(point.StartLine, point.StartColumn);
					var endOffset = OffsetOf(point.EndLine, point.EndColumn);
					if (startOffset < 0 || endOffset < startOffset)
						continue;
					// ILSpy labels a node before the writer indents its line, so a statement that starts a line starts
					// at the indentation — and a lone brace ends there too. dnSpy's statement starts at its code.
					if (startOffset == lineStarts[point.StartLine - 1]) {
						var indentation = 0;
						while (startOffset + indentation < text.Length && text[startOffset + indentation] is ' ' or '\t')
							indentation++;
						startOffset += indentation;
						if (endOffset <= startOffset && point.EndLine == point.StartLine)
							endOffset = Math.Min(endOffset + indentation, OffsetOf(point.StartLine, int.MaxValue / 2));
						if (endOffset < startOffset)
							continue;
					}
					// The points tile the body's IL; the statement's own code starts where the tree says it does,
					// which is where dnSpy's statement starts — so the C# is written above the instruction it begins with.
					var ilStart = StatementIlRanges.StartWithin(starts, point.Offset, point.EndOffset);
					statements.Add(new SourceStatement(ILSpan.FromBounds((uint)ilStart, (uint)point.EndOffset), TextSpan.FromBounds(startOffset, endOffset)));
				}
			}
			if (statements.Count == 0)
				return null;
			statements.Sort(static (left, right) => left.ILSpan.Start.CompareTo(right.ILSpan.Start));
			return new SourceStatementProvider(text, statements);
		}

		/// <summary>The summary the framework's reference documentation gives an id — what dnSpy reads out of mscorlib's.</summary>
		internal static string? FrameworkDocumentation(string id) {
			foreach (var assembly in new[] { "System.Reflection.Primitives", "System.Runtime" }) {
				if (ReferencePackDocumentation(assembly) is { } path && LoadXmlDocumentation(path) is { } document && SummaryOf(document, id) is { } summary)
					return summary;
			}
			return null;
		}

		// A module's XML documentation as dnSpy's XmlDocumentationProvider reads it for the IL view: the inner XML of
		// each member element, its line breaks and indentation kept, by documentation id. The Quick Info reads the same
		// files through an XDocument, which drops the whitespace the /// lines are cut by.
		static readonly ConcurrentDictionary<string, IReadOnlyDictionary<string, string>?> rawXmlDocumentation = new(StringComparer.Ordinal);

		internal static string? RawXmlDocumentation(ModuleDef module, string key) {
			if (string.IsNullOrEmpty(module.Location) || XmlDocumentationPath(module.Location) is not { } path)
				return null;
			var members = rawXmlDocumentation.GetOrAdd(path, static file => {
				try {
					var result = new Dictionary<string, string>(StringComparer.Ordinal);
					using var stream = File.OpenRead(file);
					using var reader = XmlReader.Create(stream, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null });
					while (!reader.EOF) {
						if (reader.NodeType == XmlNodeType.Element && reader.Name == "member") {
							var name = reader.GetAttribute("name");
							var inner = reader.ReadInnerXml();
							if (name is not null)
								result.TryAdd(name, inner);
							continue;
						}
						reader.Read();
					}
					return result;
				}
				catch (Exception) {
					return null;
				}
			});
			return members is not null && members.TryGetValue(key, out var documentation) ? documentation : null;
		}

		/// <summary>The disassembler's colors, looked up among what the workspace has loaded.</summary>
		sealed class HostMetadataResolver(Workspace workspace, AnalyzerHost host) : IMetadataResolver {
			public TypeDef? ResolveTypeDef(ITypeDefOrRef type) => workspace.FindLoadedType(type, 0) ?? host.ResolveTypeDef(type);
			public MethodDef? ResolveMethodDef(IMethod method) => host.ResolveMethodDef(method);
			public FieldDef? ResolveFieldDef(IField field) => host.ResolveFieldDef(field);
		}
	}
}
