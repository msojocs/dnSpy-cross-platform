using System.Text;
using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.Output;
using dnSpy.Decompiler.Utils;

namespace dnSpy.Backend.Core;

/// <summary>
/// How dnSpy turns tree nodes into the text of a tab beyond decompiling one member: a tab that shows several nodes
/// (DocumentTreeNodeDecompiler), the nodes that are no code and write comments about what they hold
/// (NodeDecompiler), and where following a member reference goes (TreeNodeReferenceDocumentTabContentProvider).
/// </summary>
public sealed partial class WorkspaceManager {
	sealed partial class Workspace {
		/// <summary>
		/// dnSpy's DocumentTreeNodeDecompiler.Decompile over several nodes: each one is decompiled in turn into the
		/// same document, cancellation is checked before each, and an empty line — <c>output.WriteLine()</c> — goes
		/// between two of them. A node is written the way NodeDecompiler writes it, which for a resource is its short
		/// form (ResourceNode.WriteShort) rather than the document it shows on its own.
		/// </summary>
		public async Task<DecompileResponse> DecompileNodesAsync(DecompileNodesRequest request, CancellationToken cancellationToken) {
			if (request.NodeIds.Count == 0)
				throw new RpcException(ErrorCodes.InvalidParams, "A document needs at least one node.");
			var parts = new List<DecompileResponse>(request.NodeIds.Count);
			foreach (var nodeId in request.NodeIds) {
				cancellationToken.ThrowIfCancellationRequested();
				var single = new DecompileRequest(Id, nodeId, request.Language) { Settings = request.Settings };
				var part = request.NodeIds.Count > 1
					? await RunAsync(w => w.DecompileShortResource(nodeId, request.Language, request.Settings, cancellationToken), cancellationToken).ConfigureAwait(false)
					: null;
				parts.Add(part ?? await DecompileDocumentAsync(single, cancellationToken).ConfigureAwait(false));
			}
			cancellationToken.ThrowIfCancellationRequested();
			return DocumentConcatenation.Concat(parts, "\n", LanguageName(request.Language));
		}

		/// <summary>A resource row in a tab of several nodes: NodeDecompiler writes its WriteShort, never its own document.</summary>
		DecompileResponse? DecompileShortResource(string nodeId, DecompilerLanguage language, DecompilerSettingsDto? settings, CancellationToken cancellationToken) {
			var node = GetNode(nodeId);
			return node.Kind is NodeKind.Resource or NodeKind.ResourceEntry
				? DecompileResource(node, language, settings, cancellationToken, writeShort: true)
				: null;
		}

		/// <summary>
		/// The documents of the rows that are no code and that NodeDecompiler writes itself: the Resources folder (the
		/// short form of every resource in it), a PE file that is no .NET module and a file dnSpy could not read. Null
		/// for every other node.
		/// </summary>
		DecompileResponse? DecompileNodeDocument(NodeEntry node, DecompilerLanguage language, DecompilerSettingsDto? settings, CancellationToken cancellationToken) => node.Kind switch {
			NodeKind.ResourcesGroup => DecompileResourcesFolder(node, language, settings, cancellationToken),
			NodeKind.PEDocument when node.AsPeOnlyModuleEntry is { } peEntry => DecompilePEInfo(node, peEntry, language),
			NodeKind.UnknownDocument => DecompileUnknownFile(node, language),
			_ => null,
		};

		/// <summary>
		/// NodeDecompiler.Decompile(ResourcesFolderNode): every resource of the folder in its short form — a .resources
		/// file followed by the short form of each of its entries — one after another, with the pictures and Save
		/// buttons each one carries.
		/// </summary>
		DecompileResponse DecompileResourcesFolder(NodeEntry node, DecompilerLanguage language, DecompilerSettingsDto? settings, CancellationToken cancellationToken) {
			var output = new ResourceDocumentOutput(language, settings);
			foreach (var child in GetResourceChildren(node)) {
				cancellationToken.ThrowIfCancellationRequested();
				WriteResourceNode(output, child, cancellationToken);
			}
			return output.ToResponse(GetLabel(node));
		}

		/// <summary>
		/// NodeDecompiler.Decompile(PEDocumentNode), the same in every language: the file's full path and the image's
		/// timestamp, each a comment line. The headers themselves are the document of the PE node under it.
		/// </summary>
		DecompileResponse DecompilePEInfo(NodeEntry node, PeOnlyModuleEntry peEntry, DecompilerLanguage language = DecompilerLanguage.CSharp) {
			var output = new DocumentOutput();
			var writer = CommentWriter(language);
			writer.WriteCommentLine(output, peEntry.Path);
			writer.WriteCommentLine(output, "Timestamp: " + DecompilerBase.TimestampText(peEntry.PEImage.ImageNTHeaders.FileHeader.TimeDateStamp));
			return output.ToResponse(GetLabel(node), LanguageName(language), null);
		}

		/// <summary>NodeDecompiler.Decompile(UnknownDocumentNode): the file's full path, as a comment line.</summary>
		DecompileResponse DecompileUnknownFile(NodeEntry node, DecompilerLanguage language = DecompilerLanguage.CSharp) {
			var output = new DocumentOutput();
			CommentWriter(language).WriteCommentLine(output, ((IModuleEntry)node.Module).Path);
			return output.ToResponse(GetLabel(node), LanguageName(language), null);
		}

		static DecompilerBase CommentWriter(DecompilerLanguage language) =>
			language == DecompilerLanguage.VisualBasic ? DecompilerBase.VisualBasic : DecompilerBase.CSharp;

		/// <summary>
		/// A document of an assembly, a module or a namespace: <paramref name="Header"/> is written in the document's
		/// language; <paramref name="Attributes"/> is the C# of the assembly's or module's own attributes, which the
		/// Visual Basic document converts. A namespace has no attributes.
		/// </summary>
		internal sealed record ContainerDocument(DecompileResponse Header, DecompileResponse? Attributes);

		/// <summary>
		/// What dnSpy's C# and Visual Basic decompilers write for the rows above a type. A namespace is not decompiled:
		/// its document names it and lists its types, each a reference (DecompilerBase.DecompileNamespace). An assembly
		/// or a module is its header comments (WriteAssembly, WriteModule) followed by its own attributes only —
		/// CSharpDecompiler.Decompile(AssemblyDef/ModuleDef) calls <c>AstBuilder.AddAssembly</c> with
		/// <c>onlyAssemblyLevel</c> — never the code of its types. Null for any other row or language.
		/// </summary>
		ContainerDocument? DecompileContainer(string nodeId, DecompilerLanguage language, DecompilerSettingsDto? settingsDto, CancellationToken cancellationToken) {
			var node = GetNode(nodeId);
			if (language is not (DecompilerLanguage.CSharp or DecompilerLanguage.VisualBasic)
				|| node.Kind is not (NodeKind.Assembly or NodeKind.Module or NodeKind.Namespace)
				|| node.AsModuleEntry is not { } moduleEntry)
				return null;
			var writer = CommentWriter(language);
			var host = new AnalyzerHost(this, null, loadOnDemand: false);
			var header = new DocumentOutput((reference, flags, color, start, length) => ILSpanOf(moduleEntry, host, reference, flags, color, start, length));
			var title = GetDocumentTitle(node);
			string target;
			switch (node.Value) {
			case NamespaceValue ns:
				// The types as the tree lists them under the row, read live from the module (NodeDecompiler takes the
				// row's children).
				var types = GetNamespaceIndex(moduleEntry).Groups.TryGetValue(ns.Name, out var group) ? SortTypes(group).ToArray() : [];
				writer.DecompileNamespace(ns.Name, types, header);
				return new ContainerDocument(header.ToResponse(title, LanguageName(language), moduleEntry.Path), null);
			case AssemblyDef assembly:
				writer.WriteAssembly(assembly, header);
				target = "assembly";
				break;
			case ModuleDef module:
				writer.WriteModule(module, header);
				target = "module";
				break;
			default:
				return null;
			}
			var settings = language == DecompilerLanguage.VisualBasic ? settingsDto.ToVisualBasicSettings() : settingsDto.ToDecompilerSettings();
			using var session = CreateCSharpDecompilerSession(moduleEntry, settings, cancellationToken);
			var syntaxTree = session.Decompiler.DecompileModuleAndAssemblyAttributes();
			KeepAttributesOf(syntaxTree, target);
			var attributes = FinishCSharpDecompilation(node, session.Decompiler, syntaxTree, settings, cancellationToken);
			return new ContainerDocument(header.ToResponse(title, LanguageName(language), moduleEntry.Path), attributes);
		}

		/// <summary>The C# document of a container row: the header, then the attributes.</summary>
		static DecompileResponse CSharpContainerDocument(ContainerDocument container) =>
			container.Attributes is { } attributes && !string.IsNullOrWhiteSpace(attributes.Text)
				? DocumentConcatenation.Concat([container.Header, attributes], string.Empty, "csharp") with { Title = container.Header.Title }
				: container.Header;

		/// <summary>
		/// ILSpy decompiles the assembly's and the module's attributes together; dnSpy's assembly row shows only the
		/// <c>assembly:</c> ones and its module row only the <c>module:</c> ones. The using declarations ILSpy
		/// introduced for the attributes taken away go with them.
		/// </summary>
		static void KeepAttributesOf(ICSharpCode.Decompiler.CSharp.Syntax.SyntaxTree syntaxTree, string target) {
			foreach (var section in syntaxTree.Children.OfType<ICSharpCode.Decompiler.CSharp.Syntax.AttributeSection>().ToArray()) {
				if (section.AttributeTarget != target)
					section.Remove();
			}
			var namespaces = new HashSet<string>(StringComparer.Ordinal);
			foreach (var descendant in syntaxTree.Descendants) {
				switch (descendant.Annotation<ICSharpCode.Decompiler.Semantics.ResolveResult>()) {
				case ICSharpCode.Decompiler.Semantics.TypeOfResolveResult typeOf:
					AddNamespaces(typeOf.ReferencedType);
					AddNamespaces(typeOf.Type);
					break;
				case ICSharpCode.Decompiler.Semantics.MemberResolveResult member:
					AddNamespaces(member.Member.DeclaringType);
					AddNamespaces(member.Type);
					break;
				case { } resolveResult:
					AddNamespaces(resolveResult.Type);
					break;
				}
			}
			foreach (var usingDeclaration in syntaxTree.Children.OfType<ICSharpCode.Decompiler.CSharp.Syntax.UsingDeclaration>().ToArray()) {
				if (!namespaces.Contains(usingDeclaration.Namespace))
					usingDeclaration.Remove();
			}

			void AddNamespaces(ICSharpCode.Decompiler.TypeSystem.IType? type) {
				if (type is null)
					return;
				if (!string.IsNullOrEmpty(type.Namespace))
					namespaces.Add(type.Namespace);
				foreach (var argument in type.TypeArguments)
					AddNamespaces(argument);
				if (type is ICSharpCode.Decompiler.TypeSystem.ArrayType array)
					AddNamespaces(array.ElementType);
			}
		}

		/// <summary>The language name a document of the language is written in, which picks the viewer's colorizer.</summary>
		static string LanguageName(DecompilerLanguage language) => language switch {
			DecompilerLanguage.VisualBasic => "visual-basic",
			DecompilerLanguage.IL or DecompilerLanguage.ILWithCSharp => "il",
			_ => "csharp",
		};

		/// <summary>
		/// TreeNodeReferenceDocumentTabContentProvider.CreateMemberRefResult: a state machine's <c>MoveNext</c> is
		/// followed to its kickoff method (StateMachineHelpers.TryGetKickoffMethod), and with DecompileFullType on the
		/// tab shows the outermost type the member is declared in, with the caret on the member. Anything that is not
		/// a member is shown as itself.
		/// </summary>
		public ResolveDocumentNodeResponse ResolveDocumentNode(string nodeId, bool decompileFullType) {
			var node = GetNode(nodeId);
			if (node.AsModuleEntry is not { } module || node.Kind is not (NodeKind.Type or NodeKind.Method or NodeKind.Field or NodeKind.Property or NodeKind.Event)
				|| node.Value is not IMemberDef member)
				return new ResolveDocumentNodeResponse(node.Id, node.Id);
			var definition = member;
			if (member is MethodDef method && StateMachineHelpers.TryGetKickoffMethod(method, out var kickoff))
				definition = kickoff;
			var shown = definition;
			if (decompileFullType) {
				// dnSpy gives up after a hundred declaring types, which only a malformed module reaches.
				const int MAX = 100;
				for (var i = 0; i < MAX && shown.DeclaringType is not null; i++)
					shown = shown.DeclaringType;
			}
			var definitionNode = ReferenceEquals(definition, member) ? node : GetMemberNode(definition, module);
			var shownNode = ReferenceEquals(shown, definition) ? definitionNode : GetMemberNode(shown, module);
			return new ResolveDocumentNodeResponse(shownNode.Id, definitionNode.Id);
		}
	}
}

/// <summary>
/// Joins documents into one, the way dnSpy writes several nodes into one output: each document's text follows the
/// previous one after <c>separator</c>, and what was recorded beside each text moves along with it.
/// </summary>
static class DocumentConcatenation {
	// A hidden sequence point is written on this line, which stands for no line at all.
	const int HiddenLine = 0xFEEFEE;

	/// <summary>
	/// The documents as one: spans, diagnostics, block structures, line separators and related keywords move by the
	/// length of the text in front of them; statements and attachments by its lines. Locals stay apart by document,
	/// and so do the groups of related keywords. The title is every title, with ", " between them — dnSpy's tab title
	/// for several nodes — and <paramref name="language"/> is the language the whole document is written in.
	/// </summary>
	internal static DecompileResponse Concat(IReadOnlyList<DecompileResponse> parts, string separator, string language) {
		if (parts.Count == 1)
			return parts[0];
		var text = new StringBuilder();
		var spans = new List<TextSpanDto>();
		var diagnostics = new List<DiagnosticDto>();
		var statements = new List<CodeStatementDto>();
		var attachments = new List<DocumentAttachmentDto>();
		var blocks = new List<BlockStructureDto>();
		var lineSeparators = new List<int>();
		var keywords = new List<KeywordReferenceDto>();
		bool hasStatements = false, hasAttachments = false, hasBlocks = false, hasLineSeparators = false, hasKeywords = false;
		var lines = 0;
		var groupBase = 0;
		for (var index = 0; index < parts.Count; index++) {
			var part = parts[index];
			if (index > 0) {
				text.Append(separator);
				lines += CountLines(separator);
			}
			var offset = text.Length;
			var lineShift = lines;
			text.Append(part.Text);
			lines += CountLines(part.Text);
			var localPrefix = index == 0 ? string.Empty : $"{index.ToString(System.Globalization.CultureInfo.InvariantCulture)}:";
			foreach (var span in part.Spans)
				spans.Add(span with { Start = span.Start + offset, LocalId = span.LocalId is null ? null : localPrefix + span.LocalId });
			foreach (var diagnostic in part.Diagnostics)
				diagnostics.Add(diagnostic.Start is { } start ? diagnostic with { Start = start + offset } : diagnostic);
			if (part.CodeStatements is { } partStatements) {
				hasStatements = true;
				foreach (var statement in partStatements) {
					statements.Add(statement.StartLine == HiddenLine ? statement : statement with {
						StartLine = statement.StartLine + lineShift,
						EndLine = statement.EndLine == HiddenLine ? statement.EndLine : statement.EndLine + lineShift,
					});
				}
			}
			if (part.Attachments is { } partAttachments) {
				hasAttachments = true;
				attachments.AddRange(partAttachments.Select(attachment => attachment with { AfterLine = attachment.AfterLine + lineShift }));
			}
			if (part.BlockStructures is { } partBlocks) {
				hasBlocks = true;
				blocks.AddRange(partBlocks.Select(block => block with { Start = block.Start + offset, End = block.End + offset }));
			}
			if (part.LineSeparators is { } partSeparators) {
				hasLineSeparators = true;
				lineSeparators.AddRange(partSeparators.Select(position => position + offset));
			}
			if (part.RelatedKeywords is { } partKeywords && partKeywords.Count > 0) {
				hasKeywords = true;
				keywords.AddRange(partKeywords.Select(keyword => keyword with { Start = keyword.Start + offset, Group = keyword.Group + groupBase }));
				groupBase += partKeywords.Max(keyword => keyword.Group) + 1;
			}
		}
		return new DecompileResponse(string.Join(", ", parts.Select(part => part.Title)), language, text.ToString(), spans, diagnostics) {
			CodeStatements = hasStatements ? statements : null,
			Attachments = hasAttachments ? attachments : null,
			BlockStructures = hasBlocks ? blocks : null,
			LineSeparators = hasLineSeparators ? lineSeparators : null,
			RelatedKeywords = hasKeywords ? keywords : null,
		};
	}

	static int CountLines(string text) {
		var count = 0;
		foreach (var c in text) {
			if (c == '\n')
				count++;
		}
		return count;
	}
}
