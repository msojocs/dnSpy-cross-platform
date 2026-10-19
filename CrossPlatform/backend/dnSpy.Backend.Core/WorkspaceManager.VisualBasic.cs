using System.Text;
using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.LanguageService;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.VisualBasic;
using Microsoft.CodeAnalysis.VisualBasic.Syntax;
using RoslynMetadataReference = Microsoft.CodeAnalysis.MetadataReference;
using RoslynWorkspace = Microsoft.CodeAnalysis.AdhocWorkspace;
using VbSyntaxKind = Microsoft.CodeAnalysis.VisualBasic.SyntaxKind;

namespace dnSpy.Backend.Core;

/// <summary>
/// What dnSpy's Visual Basic decompiler records beside its text, recovered from the converted text: the port's
/// Visual Basic is the C# document run through a converter, which keeps no references. The text is compiled
/// against the module and the assemblies it references, and every name Roslyn binds is matched back to the
/// metadata member it names by its documentation id — the key dnSpy's XML documentation lookup uses too.
/// Locals and parameters are tied together by the symbol they bind to, and the blocks, the line separators
/// and the related keywords come from the syntax tree.
/// </summary>
public sealed partial class WorkspaceManager {
	sealed partial class Workspace {
		/// <summary>A name of the Visual Basic text and what it binds to, before it is matched to the workspace.</summary>
		sealed record VisualBasicName(
			int Start,
			int Length,
			bool IsDefinition,
			bool IsWrite,
			string? Color,
			// The member's assembly and documentation id; a null assembly is the text's own, which is the module's.
			string? AssemblyName,
			string? DocumentationId,
			string? LocalId,
			IReadOnlyList<TextPartDto>? ToolTip,
			// A member the text declares itself, which is matched by its place rather than by its id: the converter
			// writes the types without the namespace they have in the module, and renames a member whose name only
			// differs in case from another's — so a declaration's documentation id is not the member's.
			VisualBasicSourceMember? SourceMember = null);

		/// <summary>A member the text declares: its type's namespace as written, the type and the types around
		/// it by metadata name, and — for a member of the type — its kind, metadata name and parameter types.</summary>
		sealed record VisualBasicSourceMember(string Namespace, IReadOnlyList<string> TypeChain, string? Kind, string? Name, IReadOnlyList<string>? ParameterTypes);

		sealed record VisualBasicAnalysis(
			IReadOnlyList<VisualBasicName> Names,
			IReadOnlyList<BlockStructureDto> BlockStructures,
			IReadOnlyList<int> LineSeparators,
			IReadOnlyList<KeywordReferenceDto> RelatedKeywords);

		const string VisualBasicAssemblyName = "dnSpy.VisualBasicDocument";

		/// <summary>
		/// The Visual Basic document of a node with its references, block structure, line separators and related
		/// keywords filled in. A document that cannot be analyzed is returned as it is: the text is what matters,
		/// and dnSpy's own viewer shows text without references the same way.
		/// </summary>
		internal async Task<DecompileResponse> AnalyzeVisualBasicAsync(DecompileResponse document, string nodeId, CancellationToken cancellationToken) {
			if (document.Language != "visual-basic" || document.Text.Length == 0)
				return document;
			var references = await RunAsync(w => w.VisualBasicReferences(nodeId), cancellationToken).ConfigureAwait(false);
			if (references is null)
				return document;
			VisualBasicAnalysis analysis;
			try {
				analysis = await Task.Run(() => AnalyzeVisualBasic(document.Text, references, cancellationToken), cancellationToken).ConfigureAwait(false);
			}
			catch (OperationCanceledException) {
				throw;
			}
			catch (Exception) {
				return document;
			}
			var spans = await RunAsync(w => w.VisualBasicSpans(nodeId, analysis.Names), cancellationToken).ConfigureAwait(false);
			return document with {
				Spans = spans,
				BlockStructures = analysis.BlockStructures,
				LineSeparators = analysis.LineSeparators,
				RelatedKeywords = analysis.RelatedKeywords,
			};
		}

		/// <summary>
		/// The files the converted text is compiled against: the module itself and every assembly it references
		/// that resolves on this machine — what dnSpy's own decompiler would have resolved its names in.
		/// </summary>
		IReadOnlyList<string>? VisualBasicReferences(string nodeId) {
			if (!nodes.TryGetValue(nodeId, out var node) || node.AsModuleEntry is not { } module)
				return null;
			var paths = new List<string> { module.Path };
			foreach (var reference in module.Module.GetAssemblyRefs()) {
				if (ReferencePath(module, reference) is { } path)
					paths.Add(path);
			}
			return paths;
		}

		// The runtime's own copies of what the converted text cannot do without — the core library, and the
		// Visual Basic runtime the converter's helpers live in — for a module whose references do not resolve.
		static readonly Lazy<RoslynMetadataReference[]> runtimeReferences = new(() => {
			var directory = Path.GetDirectoryName(typeof(object).Assembly.Location);
			if (directory is null)
				return [];
			return new[] { "System.Private.CoreLib.dll", "System.Runtime.dll", "Microsoft.VisualBasic.Core.dll", "System.Collections.dll", "System.Linq.dll" }
				.Select(name => Path.Combine(directory, name))
				.Where(File.Exists)
				.Select(path => (RoslynMetadataReference)RoslynMetadataReference.CreateFromFile(path))
				.ToArray();
		});

		static readonly HashSet<string> coreLibraryNames = new(StringComparer.OrdinalIgnoreCase) { "mscorlib", "System.Runtime", "netstandard", "System.Private.CoreLib" };

		static VisualBasicAnalysis AnalyzeVisualBasic(string text, IReadOnlyList<string> referencePaths, CancellationToken cancellationToken) {
			var tree = VisualBasicSyntaxTree.ParseText(text, cancellationToken: cancellationToken);
			var references = new List<RoslynMetadataReference>();
			foreach (var path in referencePaths.Distinct(StringComparer.Ordinal)) {
				try {
					references.Add(RoslynMetadataReference.CreateFromFile(path));
				}
				catch (Exception ex) when (ex is IOException or BadImageFormatException or UnauthorizedAccessException) {
					// A reference that cannot be read leaves its names unbound, as an unresolved one does.
				}
			}
			if (!referencePaths.Any(path => coreLibraryNames.Contains(Path.GetFileNameWithoutExtension(path))))
				references.AddRange(runtimeReferences.Value);
			var compilation = VisualBasicCompilation.Create(VisualBasicAssemblyName, [tree], references,
				new VisualBasicCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
			var model = compilation.GetSemanticModel(tree);
			var root = tree.GetRoot(cancellationToken);

			var colors = new Dictionary<int, string>();
			try {
				using var workspace = new RoslynWorkspace();
				foreach (var span in RoslynClassifier.Classify(model, workspace, root.FullSpan, null, cancellationToken))
					colors[span.Start] = span.Color;
			}
			catch (Exception ex) when (ex is not OperationCanceledException) {
				// The names keep the lexical colors the editor gives them.
			}

			var names = new List<VisualBasicName>();
			var localIds = new Dictionary<ISymbol, string>(SymbolEqualityComparer.Default);
			foreach (var token in root.DescendantTokens()) {
				cancellationToken.ThrowIfCancellationRequested();
				if (!token.IsKind(VbSyntaxKind.IdentifierToken) || token.Parent is not { } parent)
					continue;
				var declared = model.GetDeclaredSymbol(parent, cancellationToken);
				var isDefinition = declared is not null && declared.Locations.Any(location => location.SourceTree == tree && location.SourceSpan.Contains(token.Span));
				var symbol = isDefinition ? declared : BoundSymbol(model, parent, cancellationToken);
				if (symbol is null)
					continue;
				colors.TryGetValue(token.SpanStart, out var color);
				switch (symbol) {
					case ILocalSymbol or IParameterSymbol or IRangeVariableSymbol: {
						var key = symbol is IParameterSymbol { ContainingSymbol: IMethodSymbol { MethodKind: MethodKind.PropertyGet or MethodKind.PropertySet } } ? symbol : symbol.OriginalDefinition;
						var first = !localIds.TryGetValue(key, out var localId);
						if (first) {
							localId = $"L{localIds.Count}";
							localIds.Add(key, localId);
						}
						names.Add(new VisualBasicName(token.SpanStart, token.Span.Length, isDefinition, !isDefinition && IsWrite(parent), color,
							null, null, localId, first ? LocalToolTip(symbol) : null));
						break;
					}
					case INamedTypeSymbol or IMethodSymbol or IPropertySymbol or IFieldSymbol or IEventSymbol: {
						var member = symbol is IMethodSymbol { ReducedFrom: { } reduced } ? reduced : symbol;
						member = member.OriginalDefinition;
						if (member.GetDocumentationCommentId() is not { } documentationId)
							continue;
						var assembly = member.ContainingAssembly?.Name;
						var isSource = assembly == VisualBasicAssemblyName;
						names.Add(new VisualBasicName(token.SpanStart, token.Span.Length, isDefinition, !isDefinition && IsWrite(parent), color,
							isSource ? null : assembly, documentationId, null, null, isSource ? SourceMemberOf(member) : null));
						break;
					}
				}
			}

			var structure = new VisualBasicStructureWalker();
			structure.Visit(root);
			return new VisualBasicAnalysis(names, structure.BlockStructures, structure.LineSeparators, structure.RelatedKeywords);
		}

		static VisualBasicSourceMember? SourceMemberOf(ISymbol member) {
			var type = member as INamedTypeSymbol ?? member.ContainingType;
			if (type is null)
				return null;
			var chain = new List<string>();
			for (var current = type; current is not null; current = current.ContainingType)
				chain.Insert(0, current.MetadataName);
			var outermost = type;
			while (outermost.ContainingType is { } containing)
				outermost = containing;
			var @namespace = outermost.ContainingNamespace is { IsGlobalNamespace: false } containingNamespace ? containingNamespace.ToDisplayString() : string.Empty;
			if (member is INamedTypeSymbol)
				return new VisualBasicSourceMember(@namespace, chain, null, null, null);
			(string Kind, string Name, IEnumerable<IParameterSymbol>? Parameters)? described = member switch {
				IMethodSymbol { MethodKind: MethodKind.Constructor } method => ("method", ".ctor", method.Parameters),
				IMethodSymbol { MethodKind: MethodKind.StaticConstructor } => ("method", ".cctor", []),
				IMethodSymbol method => ("method", method.MetadataName, method.Parameters),
				IPropertySymbol property => ("property", property.MetadataName, property.Parameters),
				IFieldSymbol field => ("field", field.MetadataName, null),
				IEventSymbol @event => ("event", @event.MetadataName, null),
				_ => null,
			};
			if (described is not { } value)
				return null;
			return new VisualBasicSourceMember(@namespace, chain, value.Kind, value.Name, value.Parameters?.Select(parameter => SimpleTypeName(parameter.Type)).ToArray());
		}

		/// <summary>A parameter type by the name its definition has, which both sides can write: an array as its
		/// element's name and brackets, a type parameter as a wildcard.</summary>
		static string SimpleTypeName(ITypeSymbol type) => type switch {
			IArrayTypeSymbol array => SimpleTypeName(array.ElementType) + "[]",
			IPointerTypeSymbol pointer => SimpleTypeName(pointer.PointedAtType) + "*",
			ITypeParameterSymbol => "*",
			_ => type.MetadataName,
		};

		static string SimpleTypeName(TypeSig? signature) {
			signature = signature?.RemovePinnedAndModifiers();
			return signature switch {
				null => "*",
				ByRefSig byRef => SimpleTypeName(byRef.Next),
				SZArraySig array => SimpleTypeName(array.Next) + "[]",
				ArraySig array => SimpleTypeName(array.Next) + "[]",
				PtrSig pointer => SimpleTypeName(pointer.Next) + "*",
				GenericVar or GenericMVar => "*",
				GenericInstSig generic => generic.GenericType?.TypeDefOrRef.Name.String ?? "*",
				TypeDefOrRefSig named => named.TypeDefOrRef.Name.String,
				_ => signature.TypeName,
			};
		}

		/// <summary>The module's member a text declaration stands for, found by its type's place and its own name.</summary>
		static IMemberDef? SourceMemberDef(ModuleDef module, VisualBasicSourceMember source, string? preferredNamespace) {
			var candidates = module.GetTypes().Where(type => {
				var chain = new List<string>();
				for (var current = type; current is not null; current = current.DeclaringType)
					chain.Insert(0, current.Name.String);
				return chain.SequenceEqual(source.TypeChain, StringComparer.Ordinal);
			}).ToList();
			string NamespaceOf(TypeDef type) {
				while (type.DeclaringType is { } declaring)
					type = declaring;
				return type.Namespace.String;
			}
			var typeDef = candidates.FirstOrDefault(type => NamespaceOf(type) == source.Namespace)
				?? candidates.FirstOrDefault(type => source.Namespace.Length > 0 && NamespaceOf(type).EndsWith("." + source.Namespace, StringComparison.Ordinal))
				?? candidates.FirstOrDefault(type => NamespaceOf(type) == preferredNamespace)
				?? candidates.FirstOrDefault();
			if (typeDef is null || source.Kind is null)
				return typeDef;
			bool ParametersMatch(IList<TypeSig> parameters) =>
				source.ParameterTypes is null
				|| (parameters.Count == source.ParameterTypes.Count
					&& parameters.Select(SimpleTypeName).Zip(source.ParameterTypes).All(pair => pair.First == "*" || pair.Second == "*" || pair.First == pair.Second));
			return source.Kind switch {
				"method" => typeDef.Methods.FirstOrDefault(method => method.Name == source.Name && ParametersMatch(method.MethodSig?.Params ?? []))
					?? typeDef.Methods.FirstOrDefault(method => method.Name == source.Name),
				"property" => typeDef.Properties.FirstOrDefault(property => property.Name == source.Name && ParametersMatch(property.PropertySig?.Params ?? []))
					?? typeDef.Properties.FirstOrDefault(property => property.Name == source.Name),
				"field" => typeDef.Fields.FirstOrDefault(field => field.Name == source.Name),
				"event" => typeDef.Events.FirstOrDefault(@event => @event.Name == source.Name),
				_ => null,
			};
		}

		static ISymbol? BoundSymbol(SemanticModel model, SyntaxNode node, CancellationToken cancellationToken) {
			var info = model.GetSymbolInfo(node, cancellationToken);
			return info.Symbol ?? info.CandidateSymbols.FirstOrDefault();
		}

		/// <summary>Whether the name is written to: an assignment's target, or a <c>ByRef</c> argument is not
		/// told apart here, so only assignments count.</summary>
		static bool IsWrite(SyntaxNode node) {
			SyntaxNode current = node;
			while (current.Parent is MemberAccessExpressionSyntax access && access.Name == current)
				current = access;
			return current.Parent is AssignmentStatementSyntax assignment && assignment.Left == current;
		}

		/// <summary>dnSpy's <c>VisualBasicFormatter.WriteToolTip(ISourceVariable)</c>: "(local variable) name As Type".</summary>
		static IReadOnlyList<TextPartDto> LocalToolTip(ISymbol symbol) {
			var isParameter = symbol is IParameterSymbol;
			var type = symbol switch {
				ILocalSymbol local => local.Type,
				IParameterSymbol parameter => parameter.Type,
				_ => null,
			};
			var output = new TextPartsBuilder()
				.Write(TextColors.Punctuation, "(")
				.Write(TextColors.Text, isParameter ? "parameter" : "local variable")
				.Write(TextColors.Punctuation, ")")
				.Write(TextColors.Text, " ");
			if (symbol is IParameterSymbol { RefKind: not RefKind.None })
				output.Write(TextColors.Keyword, "ByRef").Write(TextColors.Text, " ");
			output.Write(isParameter ? TextColors.Parameter : TextColors.Local, symbol.Name);
			if (type is not null) {
				output.Write(TextColors.Text, " ").Write(TextColors.Keyword, "As").Write(TextColors.Text, " ")
					.Write(TextColors.Type, type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat));
			}
			return output.ToParts();
		}

		/// <summary>
		/// The names matched to the workspace: a member of a module the tree holds goes to its node, one of a
		/// module it does not hold to the file and token it has there, which is how C#'s references are written.
		/// </summary>
		IReadOnlyList<TextSpanDto> VisualBasicSpans(string nodeId, IReadOnlyList<VisualBasicName> names) {
			if (!nodes.TryGetValue(nodeId, out var node) || node.AsModuleEntry is not { } module)
				return [];
			// A declaration the converter wrote outside any namespace is looked for in the node's own first.
			var preferredNamespace = node.Value switch {
				TypeDef type => type.Namespace.String,
				IMemberDef { DeclaringType: { } declaring } => declaring.Namespace.String,
				NamespaceValue ns => ns.Name,
				_ => null,
			};
			var indexes = new Dictionary<string, Dictionary<string, IMemberDef>?>(StringComparer.Ordinal);
			var entries = new Dictionary<string, ModuleEntry?>(StringComparer.Ordinal);
			ModuleEntry? EntryOf(string? assemblyName) {
				if (assemblyName is null)
					return module;
				if (entries.TryGetValue(assemblyName, out var cached))
					return cached;
				var entry = FindOpenModuleByName(assemblyName);
				if (entry is null) {
					var reference = module.Module.GetAssemblyRefs().FirstOrDefault(candidate => candidate.Name.String == assemblyName);
					entry = reference is null ? null : LoadReferenceModule(module, reference);
				}
				entries[assemblyName] = entry;
				return entry;
			}
			IMemberDef? MemberOf(ModuleEntry entry, string documentationId) {
				if (!indexes.TryGetValue(entry.Path, out var index))
					indexes[entry.Path] = index = DocumentationIndex(entry.Module);
				return index is not null && index.TryGetValue(documentationId, out var member) ? member : null;
			}

			var spans = new List<TextSpanDto>(names.Count);
			foreach (var name in names) {
				if (name.LocalId is not null) {
					spans.Add(new TextSpanDto(name.Start, name.Length, name.IsDefinition ? "definition" : "reference") {
						Color = name.Color,
						LocalId = name.LocalId,
						ToolTip = name.ToolTip,
						IsWrite = name.IsWrite,
					});
					continue;
				}
				if (EntryOf(name.AssemblyName) is not { } entry)
					continue;
				var member = name.SourceMember is { } source
					? SourceMemberDef(entry.Module, source, preferredNamespace)
					: name.DocumentationId is { } documentationId ? MemberOf(entry, documentationId) : null;
				if (member is null)
					continue;
				var token = unchecked((int)member.MDToken.Raw);
				var target = IsOpenModule(entry)
					? new SpanTarget(GetMemberNode(member, entry).Id, name.IsDefinition ? entry.Path : null, name.IsDefinition ? token : null)
					: new SpanTarget(null, entry.Path, token);
				spans.Add(new TextSpanDto(name.Start, name.Length, name.IsDefinition ? "definition" : "reference", target.NodeId, target.ModulePath, target.MetadataToken) {
					Color = name.Color,
					IsWrite = name.IsWrite,
				});
			}
			return spans;
		}

		/// <summary>Every type and member of a module by the documentation id Roslyn gives its symbol.</summary>
		static Dictionary<string, IMemberDef>? DocumentationIndex(ModuleDef module) {
			var index = new Dictionary<string, IMemberDef>(StringComparer.Ordinal);
			var builder = new StringBuilder();
			void Add(IMemberDef member) {
				builder.Clear();
				if (XmlDocKeyProvider.GetKey(member, builder) is { } key)
					index.TryAdd(key.ToString(), member);
			}
			try {
				foreach (var type in module.GetTypes()) {
					Add(type);
					foreach (var method in type.Methods)
						Add(method);
					foreach (var field in type.Fields)
						Add(field);
					foreach (var property in type.Properties)
						Add(property);
					foreach (var @event in type.Events)
						Add(@event);
				}
			}
			catch (Exception) {
				return null;
			}
			return index;
		}

		/// <summary>
		/// The block structure, procedure line separators and related keywords of a Visual Basic text — what
		/// dnSpy's Visual Basic writer records as it writes each block statement and its <c>End</c>.
		/// </summary>
		sealed class VisualBasicStructureWalker() : VisualBasicSyntaxWalker(SyntaxWalkerDepth.Node) {
			readonly Dictionary<SyntaxNode, int> groups = new(ReferenceEqualityComparer.Instance);
			public List<BlockStructureDto> BlockStructures { get; } = [];
			public List<int> LineSeparators { get; } = [];
			public List<KeywordReferenceDto> RelatedKeywords { get; } = [];

			void Block(SyntaxNode? begin, SyntaxNode? end, string kind) {
				if (begin is not null && end is not null && !end.IsMissing)
					BlockStructures.Add(new BlockStructureDto(begin.SpanStart, end.SpanStart, kind));
			}

			void Keyword(SyntaxNode group, SyntaxToken token) {
				if (token.IsMissing || token.Span.Length == 0)
					return;
				if (!groups.TryGetValue(group, out var id)) {
					id = groups.Count;
					groups.Add(group, id);
				}
				RelatedKeywords.Add(new KeywordReferenceDto(token.SpanStart, token.Span.Length, id));
			}

			void End(SyntaxNode group, EndBlockStatementSyntax? end) {
				if (end is null)
					return;
				Keyword(group, end.EndKeyword);
				Keyword(group, end.BlockKeyword);
			}

			public override void Visit(SyntaxNode? node) {
				switch (node) {
					case NamespaceBlockSyntax block:
						Block(block.NamespaceStatement, block.EndNamespaceStatement, "namespace");
						break;
					case ModuleBlockSyntax block:
						Block(block.BlockStatement, block.EndBlockStatement, "module");
						break;
					case StructureBlockSyntax block:
						Block(block.BlockStatement, block.EndBlockStatement, "valueType");
						break;
					case InterfaceBlockSyntax block:
						Block(block.BlockStatement, block.EndBlockStatement, "interface");
						break;
					case TypeBlockSyntax block:
						Block(block.BlockStatement, block.EndBlockStatement, "type");
						break;
					case EnumBlockSyntax block:
						Block(block.EnumStatement, block.EndEnumStatement, "valueType");
						break;
					case MethodBlockSyntax block:
						Method(block, "method");
						Keyword(block, block.SubOrFunctionStatement.SubOrFunctionKeyword);
						break;
					case ConstructorBlockSyntax block:
						Method(block, "constructor");
						Keyword(block, block.SubNewStatement.SubKeyword);
						break;
					case OperatorBlockSyntax block:
						Method(block, "operator");
						Keyword(block, block.OperatorStatement.OperatorKeyword);
						break;
					case AccessorBlockSyntax block:
						Block(block.BlockStatement, block.EndBlockStatement, "accessor");
						Keyword(block, block.AccessorStatement.AccessorKeyword);
						End(block, block.EndBlockStatement);
						break;
					case PropertyBlockSyntax block:
						Block(block.PropertyStatement, block.EndPropertyStatement, "property");
						LineSeparators.Add(block.EndPropertyStatement.SpanStart);
						break;
					case EventBlockSyntax block:
						Block(block.EventStatement, block.EndEventStatement, "event");
						LineSeparators.Add(block.EndEventStatement.SpanStart);
						break;
					case MultiLineLambdaExpressionSyntax lambda:
						Block(lambda.SubOrFunctionHeader, lambda.EndSubOrFunctionStatement, "anonymousMethod");
						Keyword(lambda, lambda.SubOrFunctionHeader.SubOrFunctionKeyword);
						End(lambda, lambda.EndSubOrFunctionStatement);
						break;
					case MultiLineIfBlockSyntax block:
						Block(block.IfStatement, block.EndIfStatement, "conditional");
						Keyword(block, block.IfStatement.IfKeyword);
						foreach (var elseIf in block.ElseIfBlocks)
							Keyword(block, elseIf.ElseIfStatement.ElseIfKeyword);
						if (block.ElseBlock is { } elseBlock)
							Keyword(block, elseBlock.ElseStatement.ElseKeyword);
						End(block, block.EndIfStatement);
						break;
					case ForBlockSyntax block:
						Block(block.ForStatement, block.NextStatement, "loop");
						Keyword(block, block.ForStatement.ForKeyword);
						if (block.NextStatement is { } forNext)
							Keyword(block, forNext.NextKeyword);
						break;
					case ForEachBlockSyntax block:
						Block(block.ForEachStatement, block.NextStatement, "loop");
						Keyword(block, block.ForEachStatement.ForKeyword);
						Keyword(block, block.ForEachStatement.EachKeyword);
						if (block.NextStatement is { } forEachNext)
							Keyword(block, forEachNext.NextKeyword);
						break;
					case WhileBlockSyntax block:
						Block(block.WhileStatement, block.EndWhileStatement, "loop");
						Keyword(block, block.WhileStatement.WhileKeyword);
						End(block, block.EndWhileStatement);
						break;
					case DoLoopBlockSyntax block:
						Block(block.DoStatement, block.LoopStatement, "loop");
						Keyword(block, block.DoStatement.DoKeyword);
						Keyword(block, block.LoopStatement.LoopKeyword);
						break;
					case TryBlockSyntax block:
						Block(block.TryStatement, block.EndTryStatement, "try");
						Keyword(block, block.TryStatement.TryKeyword);
						foreach (var handler in block.CatchBlocks)
							Keyword(block, handler.CatchStatement.CatchKeyword);
						if (block.FinallyBlock is { } finallyBlock)
							Keyword(block, finallyBlock.FinallyStatement.FinallyKeyword);
						End(block, block.EndTryStatement);
						break;
					case SelectBlockSyntax block:
						Block(block.SelectStatement, block.EndSelectStatement, "switch");
						Keyword(block, block.SelectStatement.SelectKeyword);
						Keyword(block, block.SelectStatement.CaseKeyword);
						foreach (var caseBlock in block.CaseBlocks)
							Keyword(block, caseBlock.CaseStatement.CaseKeyword);
						End(block, block.EndSelectStatement);
						break;
					case UsingBlockSyntax block:
						Block(block.UsingStatement, block.EndUsingStatement, "using");
						break;
					case SyncLockBlockSyntax block:
						Block(block.SyncLockStatement, block.EndSyncLockStatement, "lock");
						break;
					case WithBlockSyntax block:
						Block(block.WithStatement, block.EndWithStatement, "other");
						break;
					case ExitStatementSyntax exit when ExitTarget(exit, exit.BlockKeyword) is { } target:
						Keyword(target, exit.ExitKeyword);
						Keyword(target, exit.BlockKeyword);
						break;
					case ContinueStatementSyntax @continue when ExitTarget(@continue, @continue.BlockKeyword) is { } target:
						Keyword(target, @continue.ContinueKeyword);
						Keyword(target, @continue.BlockKeyword);
						break;
					case ReturnStatementSyntax @return when FunctionOf(@return) is { } function:
						Keyword(function, @return.ReturnKeyword);
						break;
				}
				base.Visit(node);
			}

			void Method(MethodBlockBaseSyntax block, string kind) {
				Block(block.BlockStatement, block.EndBlockStatement, kind);
				End(block, block.EndBlockStatement);
				LineSeparators.Add(block.EndBlockStatement.SpanStart);
			}

			/// <summary>The block an <c>Exit</c> or <c>Continue</c> leaves: the nearest one its keyword names.</summary>
			static SyntaxNode? ExitTarget(SyntaxNode statement, SyntaxToken blockKeyword) {
				for (var current = statement.Parent; current is not null; current = current.Parent) {
					var matches = blockKeyword.Kind() switch {
						VbSyntaxKind.ForKeyword => current is ForBlockSyntax or ForEachBlockSyntax,
						VbSyntaxKind.DoKeyword => current is DoLoopBlockSyntax,
						VbSyntaxKind.WhileKeyword => current is WhileBlockSyntax,
						VbSyntaxKind.SelectKeyword => current is SelectBlockSyntax,
						VbSyntaxKind.TryKeyword => current is TryBlockSyntax,
						VbSyntaxKind.SubKeyword or VbSyntaxKind.FunctionKeyword or VbSyntaxKind.PropertyKeyword or VbSyntaxKind.OperatorKeyword =>
							current is MethodBlockBaseSyntax or MultiLineLambdaExpressionSyntax,
						_ => false,
					};
					if (matches)
						return current;
					if (current is MethodBlockBaseSyntax or MultiLineLambdaExpressionSyntax)
						return null;
				}
				return null;
			}

			static SyntaxNode? FunctionOf(SyntaxNode statement) {
				for (var current = statement.Parent; current is not null; current = current.Parent) {
					if (current is MethodBlockBaseSyntax or MultiLineLambdaExpressionSyntax)
						return current;
				}
				return null;
			}
		}
	}
}
