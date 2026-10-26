using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
using System.Xml;
using System.Xml.Linq;
using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp.OutputVisitor;
using ICSharpCode.Decompiler.CSharp.Syntax;
using ICSharpCode.Decompiler.Disassembler;
using DecompilerAstNode = ICSharpCode.Decompiler.CSharp.Syntax.AstNode;
using DecompilerILVariable = ICSharpCode.Decompiler.IL.ILVariable;
using DecompilerIMember = ICSharpCode.Decompiler.TypeSystem.IMember;
using DecompilerIType = ICSharpCode.Decompiler.TypeSystem.IType;
using DecompilerMetadataFile = ICSharpCode.Decompiler.Metadata.MetadataFile;
using DecompilerTypeKind = ICSharpCode.Decompiler.TypeSystem.TypeKind;
using DecompilerVariableKind = ICSharpCode.Decompiler.IL.VariableKind;

namespace dnSpy.Backend.Core;

public sealed partial class WorkspaceManager {
	/// <summary>
	/// A member's Quick Info: the decompiler tooltip signature plus its XML documentation. The viewer's
	/// hover asks for it when the caret is over a reference, the way dnSpy's tooltips read the decompiler's
	/// own data rather than the decompiled text.
	/// </summary>
	public Task<DocumentQuickInfoResponse> GetQuickInfoAsync(DocumentQuickInfoRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetQuickInfo(request), cancellationToken);

	sealed partial class Workspace {
		const CSharpMemberFormatter.Options QuickInfoOptions =
			CSharpMemberFormatter.Options.ParameterTypes | CSharpMemberFormatter.Options.ParameterNames | CSharpMemberFormatter.Options.DeclaringTypes
			| CSharpMemberFormatter.Options.ReturnTypes | CSharpMemberFormatter.Options.Namespaces | CSharpMemberFormatter.Options.IntrinsicTypeKeywords;

		/// <summary>
		/// dnSpy's Quick Info (<c>DnlibReferenceDocumentViewerToolTipProvider</c>): the decompiler's tooltip for
		/// the member a reference names, in the document's language, with the summary of its XML documentation
		/// where the module has any. The viewer asks for it on hover rather than carrying a tooltip on every span
		/// of the document.
		/// </summary>
		public DocumentQuickInfoResponse GetQuickInfo(DocumentQuickInfoRequest request) {
			if (!string.IsNullOrEmpty(request.OpCode))
				return OpCodeQuickInfo(request.OpCode);
			ModuleEntry? module = null;
			IMemberDef? member = null;
			if (!string.IsNullOrEmpty(request.TargetNodeId)) {
				var node = GetNode(request.TargetNodeId);
				module = ModuleOf(node);
				member = node.Value as IMemberDef;
			}
			else if (!string.IsNullOrEmpty(request.ModulePath) && request.MetadataToken is int token) {
				module = modules.Values.FirstOrDefault(candidate => SameFile(candidate.Path, request.ModulePath!))
					?? FindOpenModuleByName(Path.GetFileNameWithoutExtension(request.ModulePath!));
				try {
					member = module?.Module.ResolveToken(unchecked((uint)token)) as IMemberDef;
				}
				catch (Exception) {
					member = null;
				}
				// A module the workspace does not hold is read from its file, the way a bookmark's location is.
				if (member is null && module is null && File.Exists(request.ModulePath)) {
					try {
						using var external = ModuleDefMD.Load(request.ModulePath);
						member = external.ResolveToken(unchecked((uint)token)) as IMemberDef;
						return member is null ? new DocumentQuickInfoResponse([], null) : QuickInfoOf(member, request.Language, request.ModulePath);
					}
					catch (Exception) {
						return new DocumentQuickInfoResponse([], null);
					}
				}
			}
			if (member is null)
				return new DocumentQuickInfoResponse([], null);
			return QuickInfoOf(member, request.Language, module?.Path);
		}

		DocumentQuickInfoResponse QuickInfoOf(IMemberDef member, DecompilerLanguage language, string? modulePath) {
			var output = new TextPartsBuilder();
			switch (language) {
				case DecompilerLanguage.VisualBasic:
					VisualBasicMemberFormatter.WriteToolTip(output, member, QuickInfoOptions, TypeColor);
					break;
				// dnSpy's IL decompiler writes its tooltips in IL; a member it has no IL form for falls back to C#.
				case DecompilerLanguage.IL or DecompilerLanguage.ILWithCSharp when ILMemberFormatter.WriteToolTip(output, member, TypeColor):
					break;
				default:
					CSharpMemberFormatter.WriteToolTip(output, member, QuickInfoOptions, TypeColor);
					break;
			}
			var documentation = modulePath is null ? null : XmlDocumentationOf(modulePath, member);
			// CodeToolTipProvider.SetImage: the member's own image, the one the tree shows it with.
			return new DocumentQuickInfoResponse(output.ToParts(), documentation, DotNetImages.Of(member));
		}

		/// <summary>
		/// The summary dnSpy's tooltip shows for a member: the member's own, or — for an accessor that has none
		/// — the property's or the event's, which is where a compiler writes them.
		/// </summary>
		static string? XmlDocumentationOf(string modulePath, IMemberDef member) {
			var documentation = XmlDocumentation(modulePath);
			if (documentation is null)
				return null;
			if (SummaryOf(documentation, member) is { } summary)
				return summary;
			if (member is not MethodDef { DeclaringType: { } declaringType } method)
				return null;
			IMemberDef? owner = method.Name.String switch {
				var name when name.StartsWith("get_", StringComparison.Ordinal) || name.StartsWith("set_", StringComparison.Ordinal) =>
					declaringType.Properties.FirstOrDefault(property => property.GetMethod == method || property.SetMethod == method),
				var name when name.StartsWith("add_", StringComparison.Ordinal) => declaringType.Events.FirstOrDefault(@event => @event.AddMethod == method),
				var name when name.StartsWith("remove_", StringComparison.Ordinal) => declaringType.Events.FirstOrDefault(@event => @event.RemoveMethod == method),
				_ => null,
			};
			return owner is null ? null : SummaryOf(documentation, owner);
		}

		static string? SummaryOf(XDocument documentation, IMemberDef member) {
			var key = XmlDocKeyProvider.GetKey(member, new StringBuilder())?.ToString();
			return key is null ? null : SummaryOf(documentation, key);
		}

		static string? SummaryOf(XDocument documentation, string key) {
			if (documentation.Root is not { } root)
				return null;
			var summary = root.Descendants("member").FirstOrDefault(element => (string?)element.Attribute("name") == key)?.Element("summary");
			if (summary is null)
				return null;
			// dnSpy's XmlDocRenderer: a cref is written as the name it points at, and the text's own line
			// breaks and runs of spaces come out as single spaces.
			var text = new StringBuilder();
			foreach (var node in summary.Nodes()) {
				switch (node) {
					case XText textNode:
						text.Append(textNode.Value);
						break;
					case XElement { Name.LocalName: "see" or "seealso" } reference:
						text.Append(CrefName((string?)reference.Attribute("cref") ?? (string?)reference.Attribute("langword") ?? reference.Value));
						break;
					case XElement { Name.LocalName: "paramref" or "typeparamref" } reference:
						text.Append((string?)reference.Attribute("name"));
						break;
					case XElement { Name.LocalName: "para" or "br" } paragraph:
						text.Append('\n').Append(paragraph.Value).Append('\n');
						break;
					case XElement element:
						text.Append(element.Value);
						break;
				}
			}
			var lines = text.ToString().Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n')
				.Select(line => string.Join(' ', line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)))
				.Where(line => line.Length > 0)
				.ToList();
			return lines.Count == 0 ? null : string.Join('\n', lines);
		}

		/// <summary>The name a cref is shown as: what follows its kind prefix and the last dot, without the parameters.</summary>
		static string CrefName(string cref) {
			var name = cref.Length > 2 && cref[1] == ':' ? cref[2..] : cref;
			var parameters = name.IndexOf('(', StringComparison.Ordinal);
			if (parameters >= 0)
				name = name[..parameters];
			var dot = name.LastIndexOf('.');
			return dot >= 0 && dot + 1 < name.Length ? name[(dot + 1)..] : name;
		}

		// Parsed XML documentation files, by path. A module's file is read once however many references the
		// user hovers over; a file that cannot be read is remembered as absent.
		static readonly ConcurrentDictionary<string, XDocument?> xmlDocumentation = new(StringComparer.Ordinal);

		static XDocument? XmlDocumentation(string modulePath) =>
			XmlDocumentationPath(modulePath) is { } path ? LoadXmlDocumentation(path) : null;

		static XDocument? LoadXmlDocumentation(string path) =>
			xmlDocumentation.GetOrAdd(path, static file => {
				try {
					using var stream = File.OpenRead(file);
					using var reader = XmlReader.Create(stream, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null });
					return XDocument.Load(reader);
				}
				catch (Exception) {
					return null;
				}
			});

		/// <summary>
		/// The XML documentation file of a module, looked for the way dnSpy's <c>XmlDocLoader</c> does: beside the
		/// module, in a culture directory beside it, and — for an assembly of the framework, whose runtime copy
		/// ships without one — in the reference pack of the .NET installation.
		/// </summary>
		static string? XmlDocumentationPath(string modulePath) {
			var xml = Path.ChangeExtension(modulePath, ".xml");
			if (File.Exists(xml))
				return xml;
			var directory = Path.GetDirectoryName(xml);
			if (directory is not null) {
				foreach (var culture in new[] { CultureInfo.CurrentUICulture.Name, CultureInfo.CurrentUICulture.TwoLetterISOLanguageName }) {
					if (culture.Length == 0)
						continue;
					var localized = Path.Combine(directory, culture, Path.GetFileName(xml));
					if (File.Exists(localized))
						return localized;
				}
			}
			var name = Path.GetFileNameWithoutExtension(modulePath);
			return ReferencePackDocumentation(name)
				// The runtime's core library is documented under the reference assembly that forwards to it.
				?? (string.Equals(name, "System.Private.CoreLib", StringComparison.OrdinalIgnoreCase) || string.Equals(name, "mscorlib", StringComparison.OrdinalIgnoreCase)
					? ReferencePackDocumentation("System.Runtime")
					: null);
		}

		static readonly Lazy<string[]> referencePackDirectories = new(() => {
			try {
				// <dotnet>/shared/Microsoft.NETCore.App/<version>/System.Private.CoreLib.dll
				var runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location);
				var root = runtimeDirectory is null ? null : Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(runtimeDirectory)));
				var packs = root is null ? null : Path.Combine(root, "packs", "Microsoft.NETCore.App.Ref");
				if (packs is null || !Directory.Exists(packs))
					return [];
				return Directory.GetDirectories(packs)
					.OrderByDescending(path => Version.TryParse(Path.GetFileName(path).Split('-')[0], out var version) ? version : new Version())
					.SelectMany(path => Directory.Exists(Path.Combine(path, "ref"))
						? Directory.GetDirectories(Path.Combine(path, "ref")).OrderByDescending(Path.GetFileName, StringComparer.Ordinal)
						: Enumerable.Empty<string>())
					.ToArray();
			}
			catch (Exception) {
				return [];
			}
		});

		static string? ReferencePackDocumentation(string assemblyName) {
			foreach (var directory in referencePackDirectories.Value) {
				var path = Path.Combine(directory, assemblyName + ".xml");
				if (File.Exists(path))
					return path;
			}
			return null;
		}

		/// <summary>
		/// dnSpy's opcode tooltip: the opcode, its value, and the summary the framework's documentation gives the
		/// <c>OpCodes</c> field of the same name.
		/// </summary>
		public static DocumentQuickInfoResponse OpCodeQuickInfo(string name) {
			var opCode = typeof(dnlib.DotNet.Emit.OpCodes).GetFields()
				.Select(field => field.GetValue(null))
				.OfType<dnlib.DotNet.Emit.OpCode>()
				.FirstOrDefault(code => code.Name == name);
			if (opCode is null)
				return new DocumentQuickInfoResponse([], null);
			var output = new TextPartsBuilder()
				.Write(TextColors.OpCode, opCode.Name)
				.Write(TextColors.Text, " ")
				.Write(TextColors.Punctuation, "(")
				.Write(TextColors.Number, opCode.Size > 1 ? $"0x{(ushort)opCode.Value:X4}" : $"0x{(byte)opCode.Value:X2}")
				.Write(TextColors.Punctuation, ")");
			string? documentation = null;
			foreach (var assembly in new[] { "System.Reflection.Primitives", "System.Runtime" }) {
				if (ReferencePackDocumentation(assembly) is { } path && LoadXmlDocumentation(path) is { } document
					&& SummaryOf(document, "F:System.Reflection.Emit.OpCodes." + opCode.Code) is { } summary) {
					documentation = summary;
					break;
				}
			}
			if (documentation is not null)
				output.Write(TextColors.Text, " - ").Write(TextColors.Text, documentation.Replace('\n', ' '));
			return new DocumentQuickInfoResponse(output.ToParts(), null);
		}

		/// <summary>
		/// The color class a reference is written in, the way dnSpy's decompiler records it beside the text
		/// it emits: the symbol's kind decides it, so a static field and an instance field are different
		/// colors even though both are written as a field.
		/// </summary>
		internal static string? SpanColorOf(object reference) => reference switch {
			DecompilerILVariable variable => variable.Kind == DecompilerVariableKind.Parameter ? TextColors.Parameter : TextColors.Local,
			DecompilerIMember member => MemberColorOf(member),
			DecompilerIType type => TypeColorOf(type),
			_ => null,
		};

		internal static string MemberColorOf(DecompilerIMember member) => member switch {
			ICSharpCode.Decompiler.TypeSystem.IMethod { IsConstructor: true } constructor => TypeColorOf(constructor.DeclaringType),
			ICSharpCode.Decompiler.TypeSystem.IMethod method =>
				method.IsExtensionMethod ? TextColors.ExtensionMethod
				: method.IsStatic ? TextColors.StaticMethod
				: TextColors.InstanceMethod,
			ICSharpCode.Decompiler.TypeSystem.IField field when field.DeclaringTypeDefinition?.Kind == DecompilerTypeKind.Enum => TextColors.EnumField,
			ICSharpCode.Decompiler.TypeSystem.IField field when field.IsConst => TextColors.LiteralField,
			ICSharpCode.Decompiler.TypeSystem.IField field => field.IsStatic ? TextColors.StaticField : TextColors.InstanceField,
			ICSharpCode.Decompiler.TypeSystem.IProperty property => property.IsStatic ? TextColors.StaticProperty : TextColors.InstanceProperty,
			ICSharpCode.Decompiler.TypeSystem.IEvent @event => @event.IsStatic ? TextColors.StaticEvent : TextColors.InstanceEvent,
			_ => TextColors.Text,
		};

		internal static string TypeColorOf(DecompilerIType type) {
			if (type is ICSharpCode.Decompiler.TypeSystem.ITypeParameter parameter)
				return parameter.OwnerType == ICSharpCode.Decompiler.TypeSystem.SymbolKind.Method ? TextColors.MethodGenericParameter : TextColors.TypeGenericParameter;
			var definition = type.GetDefinition();
			if (definition is null)
				return TextColors.Type;
			return definition.Kind switch {
				DecompilerTypeKind.Interface => TextColors.Interface,
				DecompilerTypeKind.Enum => TextColors.Enum,
				DecompilerTypeKind.Struct => TextColors.ValueType,
				DecompilerTypeKind.Delegate => TextColors.Delegate,
				DecompilerTypeKind.Class when definition.IsStatic => TextColors.StaticType,
				DecompilerTypeKind.Class when definition.IsSealed => TextColors.SealedType,
				_ => TextColors.Type,
			};
		}

		static readonly CSharpAmbience localTypeAmbience = new();

		/// <summary>
		/// A local's or parameter's Quick Info — dnSpy's <c>CSharpFormatter.WriteToolTip(ISourceVariable)</c>:
		/// "(local variable)" or "(parameter)", then the type and the name.
		/// </summary>
		static IReadOnlyList<TextPartDto>? LocalToolTipOf(object reference) {
			if (reference is not DecompilerILVariable variable)
				return null;
			var isParameter = variable.Kind == DecompilerVariableKind.Parameter;
			var output = new TextPartsBuilder()
				.Write(TextColors.Punctuation, "(")
				.Write(TextColors.Text, isParameter ? "parameter" : "local variable")
				.Write(TextColors.Punctuation, ")")
				.Write(TextColors.Text, " ")
				.Write(TypeColorOf(variable.Type), localTypeAmbience.ConvertType(variable.Type))
				.Write(TextColors.Text, " ")
				.Write(isParameter ? TextColors.Parameter : TextColors.Local, variable.Name ?? string.Empty);
			return output.ToParts();
		}

		/// <summary>
		/// The decompiled text and what dnSpy's decompiler output records beside it: the references (members by
		/// their target, locals by an identity that ties the uses of one together), the blocks the writer opened
		/// and closed, the line separators under members, and the keywords that belong together.
		/// </summary>
		internal sealed class SpanTextOutput(
			Func<object, SpanTarget?> resolveTarget,
			Func<object, string?>? colorOf = null,
			Func<object, IReadOnlyList<TextPartDto>?>? localToolTipOf = null) : ITextOutput {
			readonly StringBuilder builder = new();
			readonly List<TextSpanDto> spans = [];
			readonly List<BlockStructureDto> blockStructures = [];
			readonly List<int> lineSeparators = [];
			readonly List<KeywordReferenceDto> relatedKeywords = [];
			// A local is one ILVariable however often it is written, which is what ties its uses together.
			readonly Dictionary<object, string> localIds = new(ReferenceEqualityComparer.Instance);
			readonly Stack<(int Start, string? Kind)> openBlocks = new();
			int indentation;
			int line = 1;
			int column = 1;
			bool needsIndentation = true;

			public string IndentationString { get; set; } = "\t";
			public IReadOnlyList<TextSpanDto> Spans => spans;
			public IReadOnlyList<BlockStructureDto> BlockStructures => blockStructures;
			public IReadOnlyList<int> LineSeparators => lineSeparators;
			public IReadOnlyList<KeywordReferenceDto> RelatedKeywords => relatedKeywords;
			public int Position => builder.Length;

			/// <summary>Whether the reference about to be written is one that writes what it names; the token
			/// writer sets it from the syntax tree for the identifier it is about to write.</summary>
			public bool NextReferenceIsWrite { get; set; }

			/// <summary>Where the next character will land. ILSpy reads this to label the syntax tree.</summary>
			public TextLocation Location => new(line, column);

			public void Indent() => indentation++;
			public void Unindent() => indentation = Math.Max(0, indentation - 1);
			public void Write(char ch) => Write(ch.ToString());
			public void Write(string text) {
				EnsureIndentation();
				Append(text);
			}
			public void WriteLine() {
				Append(Environment.NewLine);
				needsIndentation = true;
			}
			public void WriteReference(OpCodeInfo opCode, bool omitSuffix = false) => Write(omitSuffix ? opCode.Name ?? string.Empty : opCode.ToString() ?? string.Empty);
			public void WriteReference(DecompilerMetadataFile metadata, System.Reflection.Metadata.Handle handle, string text, string protocol = "decompile", bool isDefinition = false) =>
				WriteReferenceCore(new MetadataReference(metadata, handle), text, isDefinition);
			public void WriteReference(DecompilerIType type, string text, bool isDefinition = false) => WriteReferenceCore(type, text, isDefinition);
			public void WriteReference(DecompilerIMember member, string text, bool isDefinition = false) => WriteReferenceCore(member, text, isDefinition);

			/// <summary>
			/// A local or parameter use. dnSpy records these as references too — flagged local — which is
			/// what lets a click move the caret to the declaration and what the reference highlighter marks.
			/// The identity ties the use to its declaration inside this one document; the first span of a local
			/// carries its Quick Info.
			/// </summary>
			public void WriteLocalReference(string text, object reference, bool isDefinition = false, bool isHoverOnly = false) {
				EnsureIndentation();
				var start = builder.Length;
				Append(text);
				var isWrite = NextReferenceIsWrite;
				NextReferenceIsWrite = false;
				if (text.Length == 0 || isHoverOnly)
					return;
				var color = colorOf?.Invoke(reference);
				if (reference is not DecompilerILVariable) {
					// A local function, a label: colored, but nothing a click follows inside the document.
					if (color is not null)
						spans.Add(new TextSpanDto(start, text.Length, isDefinition ? "definition" : "reference") { Color = color });
					return;
				}
				var first = !localIds.TryGetValue(reference, out var localId);
				if (first) {
					localId = $"L{localIds.Count}";
					localIds.Add(reference, localId);
				}
				spans.Add(new TextSpanDto(start, text.Length, isDefinition ? "definition" : "reference") {
					Color = color,
					LocalId = localId,
					ToolTip = first ? localToolTipOf?.Invoke(reference) : null,
					IsWrite = isWrite && !isDefinition,
				});
			}

			// dnSpy's document viewer has no folding, so the fold marks ILSpy's writer makes are not recorded.
			public void MarkFoldStart(string collapsedText = "...", bool defaultCollapsed = false, bool isDefinition = false) { }
			public void MarkFoldEnd() { }
			public void MarkDefinitionStart() { }

			/// <summary>The writer has just written a block's opening brace; <paramref name="kind"/> is null for
			/// braces that open no block dnSpy draws a line for — an initializer's, a pattern's.</summary>
			public void OpenBlock(string? kind) => openBlocks.Push((builder.Length - 1, kind));

			/// <summary>
			/// The writer has just written a block's closing brace. A member's body that spans lines gets dnSpy's
			/// procedure line separator under the line of its closing brace.
			/// </summary>
			public void CloseBlock() {
				if (openBlocks.Count == 0)
					return;
				var (start, kind) = openBlocks.Pop();
				var end = builder.Length - 1;
				if (kind is null)
					return;
				blockStructures.Add(new BlockStructureDto(start, end, kind));
				if (kind is "method" or "constructor" or "destructor" or "operator" or "property" or "event" && SpansLines(start, end))
					lineSeparators.Add(end);
			}

			bool SpansLines(int start, int end) {
				for (var index = start; index < end; index++) {
					if (builder[index] == '\n')
						return true;
				}
				return false;
			}

			/// <summary>The writer has just written a keyword that belongs to <paramref name="group"/>.</summary>
			public void AddRelatedKeyword(string keyword, int group) {
				var start = builder.Length - keyword.Length;
				if (start >= 0 && builder.ToString(start, keyword.Length) == keyword)
					relatedKeywords.Add(new KeywordReferenceDto(start, keyword.Length, group));
			}

			void WriteReferenceCore(object reference, string text, bool isDefinition) {
				EnsureIndentation();
				var start = builder.Length;
				Append(text);
				var isWrite = NextReferenceIsWrite;
				NextReferenceIsWrite = false;
				// A reference the resolver could not place has no span: the text still renders, but a click
				// on it has nowhere to go — dnSpy's own output writer skips the reference the same way.
				if (text.Length == 0 || resolveTarget(reference) is not { } target)
					return;
				// A definition is where dnSpy's token bookmark sits, and a bookmark is written down as module and
				// token — so a definition keeps both beside its node id. A reference into the workspace only
				// needs the node; the module and token are what a reference outside it is followed by.
				if (!isDefinition && target.NodeId is not null)
					target = target with { ModulePath = null, MetadataToken = null };
				spans.Add(new TextSpanDto(start, text.Length, isDefinition ? "definition" : "reference", target.NodeId, target.ModulePath, target.MetadataToken) {
					Color = colorOf?.Invoke(reference),
					IsWrite = isWrite && !isDefinition,
				});
			}

			// Every append goes through here so the line/column the syntax tree is labelled with stays in step
			// with the text the editor will show.
			void Append(string text) {
				for (var i = 0; i < text.Length; i++) {
					var ch = text[i];
					if (ch == '\r') {
						if (i + 1 < text.Length && text[i + 1] == '\n')
							i++;
					}
					else if (ch != '\n') {
						column++;
						continue;
					}
					line++;
					column = 1;
				}
				builder.Append(text);
			}

			void EnsureIndentation() {
				if (!needsIndentation)
					return;
				for (var i = 0; i < indentation; i++)
					Append(IndentationString);
				needsIndentation = false;
			}

			public override string ToString() => builder.ToString();
		}

		/// <summary>
		/// ILSpy only writes line/column information into the syntax tree while a writer that reports its own
		/// position (ILocatable) prints it; CreateSequencePoints has nothing to work with otherwise. The writer
		/// that turns identifiers into the reference spans the editor navigates with — TextTokenWriter — is not
		/// ILocatable, so this one reports the position of the output buffer instead of tracking its own.
		/// It also records what dnSpy's own C# writer records beside the text and ILSpy's does not: which block
		/// each brace opens, which keywords belong together, and which references write what they name.
		/// </summary>
		internal sealed class LocationTokenWriter(SpanTextOutput output, DecompilerSettings settings) : TextTokenWriter(output, settings), ILocatable {
			readonly Stack<DecompilerAstNode> nodes = new();
			readonly Dictionary<DecompilerAstNode, int> keywordGroups = new(ReferenceEqualityComparer.Instance);

			public TextLocation Location => output.Location;

			public int Length => output.Position;

			public override void StartNode(DecompilerAstNode node) {
				base.StartNode(node);
				nodes.Push(node);
			}

			public override void EndNode(DecompilerAstNode node) {
				base.EndNode(node);
				nodes.Pop();
			}

			public override void WriteIdentifier(Identifier identifier) {
				output.NextReferenceIsWrite = nodes.Count > 0 && IsWrite(nodes.Peek());
				base.WriteIdentifier(identifier);
				output.NextReferenceIsWrite = false;
			}

			public override void WriteToken(string token) {
				base.WriteToken(token);
				var node = nodes.Count > 0 ? nodes.Peek() : null;
				// An interpolation's braces are part of a string, not a block.
				if (node is Interpolation)
					return;
				if (token == "{")
					output.OpenBlock(node is null ? null : BlockKindOf(node));
				else if (token == "}")
					output.CloseBlock();
			}

			public override void WriteKeyword(string keyword) {
				base.WriteKeyword(keyword);
				if (nodes.Count > 0 && KeywordGroupOf(nodes.Peek(), keyword) is { } group) {
					if (!keywordGroups.TryGetValue(group, out var id)) {
						id = keywordGroups.Count;
						keywordGroups.Add(group, id);
					}
					output.AddRelatedKeyword(keyword, id);
				}
			}

			/// <summary>Whether the expression an identifier is written for is the target of a write: an
			/// assignment's left side, an increment or decrement, an <c>out</c> or <c>ref</c> argument.</summary>
			static bool IsWrite(DecompilerAstNode node) => node.Parent switch {
				AssignmentExpression assignment => assignment.Left == node,
				UnaryOperatorExpression unary => unary.Operator is UnaryOperatorType.Increment or UnaryOperatorType.Decrement
					or UnaryOperatorType.PostIncrement or UnaryOperatorType.PostDecrement,
				DirectionExpression direction => direction.FieldDirection is FieldDirection.Out or FieldDirection.Ref,
				_ => false,
			};

			/// <summary>dnSpy's <c>CodeBracesRangeFlags</c> block kind for the braces the node writes, named the way
			/// the viewer's block structure colors are.</summary>
			static string? BlockKindOf(DecompilerAstNode node) => node switch {
				NamespaceDeclaration => "namespace",
				TypeDeclaration type => type.ClassType switch {
					ClassType.Interface => "interface",
					ClassType.Struct or ClassType.RecordStruct or ClassType.Enum => "valueType",
					_ => "type",
				},
				PropertyDeclaration or IndexerDeclaration => "property",
				CustomEventDeclaration => "event",
				SwitchStatement => "switch",
				BlockStatement block => block.Parent switch {
					MethodDeclaration => "method",
					ConstructorDeclaration => "constructor",
					DestructorDeclaration => "destructor",
					OperatorDeclaration => "operator",
					Accessor => "accessor",
					AnonymousMethodExpression or LambdaExpression => "anonymousMethod",
					LocalFunctionDeclarationStatement => "localFunction",
					IfElseStatement => "conditional",
					ForStatement or ForeachStatement or WhileStatement or DoWhileStatement => "loop",
					TryCatchStatement tryCatch => tryCatch.FinallyBlock == block ? "finally" : "try",
					CatchClause => "catch",
					LockStatement => "lock",
					UsingStatement => "using",
					FixedStatement => "fixed",
					SwitchSection => "case",
					_ => "other",
				},
				_ => null,
			};

			/// <summary>
			/// The node a keyword shares with the keywords related to it — dnSpy's "Highlight related keywords":
			/// an <c>if</c> chain and its <c>else</c>s, a loop and the <c>break</c>s and <c>continue</c>s that
			/// leave it, a <c>switch</c> and its labels, a <c>try</c> and its handlers, the <c>return</c>s of a method.
			/// </summary>
			static DecompilerAstNode? KeywordGroupOf(DecompilerAstNode node, string keyword) => node switch {
				IfElseStatement ifElse when keyword is "if" or "else" => IfChainOf(ifElse),
				ReturnStatement or YieldReturnStatement or YieldBreakStatement when keyword is "return" or "yield" or "break" => FunctionOf(node),
				ForStatement or ForeachStatement or WhileStatement or DoWhileStatement when keyword is "for" or "foreach" or "while" or "do" => node,
				ContinueStatement => Ancestor(node, static ancestor => ancestor is ForStatement or ForeachStatement or WhileStatement or DoWhileStatement),
				BreakStatement => Ancestor(node, static ancestor => ancestor is ForStatement or ForeachStatement or WhileStatement or DoWhileStatement or SwitchStatement),
				SwitchStatement when keyword == "switch" => node,
				CaseLabel or GotoCaseStatement or GotoDefaultStatement when keyword is "case" or "default" or "goto" => Ancestor(node, static ancestor => ancestor is SwitchStatement),
				TryCatchStatement when keyword is "try" or "finally" => node,
				CatchClause clause when keyword is "catch" or "when" => clause.Parent,
				_ => null,
			};

			static DecompilerAstNode IfChainOf(IfElseStatement statement) {
				DecompilerAstNode current = statement;
				while (current.Parent is IfElseStatement parent && parent.FalseStatement == current)
					current = parent;
				return current;
			}

			static DecompilerAstNode? FunctionOf(DecompilerAstNode node) =>
				Ancestor(node, static ancestor => ancestor is MethodDeclaration or ConstructorDeclaration or DestructorDeclaration or OperatorDeclaration
					or Accessor or LambdaExpression or AnonymousMethodExpression or LocalFunctionDeclarationStatement);

			// The nearest enclosing node that matches, not leaving the function the keyword is in.
			static DecompilerAstNode? Ancestor(DecompilerAstNode node, Func<DecompilerAstNode, bool> matches) {
				for (var current = node.Parent; current is not null; current = current.Parent) {
					if (matches(current))
						return current;
					if (current is EntityDeclaration or LambdaExpression or AnonymousMethodExpression or LocalFunctionDeclarationStatement)
						return null;
				}
				return null;
			}
		}
	}
}
