using System.Reflection.Metadata;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp.OutputVisitor;
using ICSharpCode.Decompiler.CSharp.Syntax;
using ICSharpCode.Decompiler.Disassembler;
using ICSharpCode.Decompiler.Semantics;
using DecompilerILVariable = ICSharpCode.Decompiler.IL.ILVariable;
using DecompilerIMember = ICSharpCode.Decompiler.TypeSystem.IMember;
using DecompilerIType = ICSharpCode.Decompiler.TypeSystem.IType;
using DecompilerMetadataFile = ICSharpCode.Decompiler.Metadata.MetadataFile;

namespace dnSpy.Backend.Core.Output;

/// <summary>
/// dnSpy's C# writer (the fork's TextTokenWriter) over ICSharpCode.Decompiler's syntax tree: every token goes to an
/// <see cref="IDecompilerOutput"/> in the color class dnSpy writes it in — keywords, literals, comments, XML
/// documentation, preprocessor directives, namespaces, labels, and each name in the color of what it names, the way
/// the document view colors a reference. It is how dnSpy.Console writes C# to a terminal.
/// </summary>
sealed class CSharpOutputWriter : TextTokenWriter {
	readonly ColoredTextOutput text;
	readonly Stack<AstNode> nodes = new();

	CSharpOutputWriter(ColoredTextOutput text, DecompilerSettings settings) : base(text, settings) => this.text = text;

	/// <summary>Prints <paramref name="syntaxTree"/> to <paramref name="output"/>, after the fork's last passes over it.</summary>
	public static void Write(SyntaxTree syntaxTree, IDecompilerOutput output, DecompilerSettings settings) {
		DnSpyCSharpTransform.AfterDecompile(syntaxTree, settings);
		var writer = TokenWriter.InsertRequiredSpaces(new CSharpOutputWriter(new ColoredTextOutput(output), settings));
		syntaxTree.AcceptVisitor(new CSharpOutputVisitor(writer, settings.CSharpFormattingOptions));
	}

	public override void StartNode(AstNode node) {
		nodes.Push(node);
		base.StartNode(node);
	}

	public override void EndNode(AstNode node) {
		base.EndNode(node);
		nodes.Pop();
	}

	public override void WriteIdentifier(Identifier identifier) =>
		Colored(IdentifierColor(), () => base.WriteIdentifier(identifier));

	/// <summary>A label and a namespace name have a color of their own; any other name takes its reference's.</summary>
	string? IdentifierColor() {
		if (nodes.Count == 0)
			return null;
		var node = nodes.Peek();
		if (node is Identifier && node.Parent is not null)
			node = node.Parent;
		if (node is LabelStatement or GotoStatement)
			return BoxedTextColor.Label;
		if (node.Annotation<NamespaceResolveResult>() is not null || node is NamespaceDeclaration || IsInsideUsing(node))
			return BoxedTextColor.Namespace;
		return null;
	}

	/// <summary>The names in a using directive are namespaces, unless one names a type (an alias for a type).</summary>
	static bool IsInsideUsing(AstNode node) {
		for (var current = node; current is not null; current = current.Parent) {
			if (current is UsingDeclaration or UsingAliasDeclaration)
				return node.Annotation<TypeResolveResult>() is null;
			if (current is EntityDeclaration or Statement or Expression)
				return false;
		}
		return false;
	}

	public override void WriteKeyword(string keyword) => Colored(BoxedTextColor.Keyword, () => base.WriteKeyword(keyword));

	public override void WritePrimitiveType(string type) => Colored(BoxedTextColor.Keyword, () => base.WritePrimitiveType(type));

	public override void WriteToken(string token) => Colored(IsOperator(token) ? BoxedTextColor.Operator : BoxedTextColor.Punctuation, () => base.WriteToken(token));

	static bool IsOperator(string token) => token switch {
		"(" or ")" or "{" or "}" or "[" or "]" or ";" or "," or "." or "::" => false,
		_ => token.Length > 0 && !char.IsLetterOrDigit(token[0]) && token[0] != '_',
	};

	public override void WritePrimitiveValue(object? value, LiteralFormat format = LiteralFormat.None) {
		var color = value switch {
			string => format == LiteralFormat.VerbatimStringLiteral ? BoxedTextColor.VerbatimString : BoxedTextColor.String,
			char => BoxedTextColor.Char,
			null or bool => BoxedTextColor.Keyword,
			_ => BoxedTextColor.Number,
		};
		Colored(color, () => base.WritePrimitiveValue(value, format));
	}

	public override void WriteInterpolatedText(string text) => Colored(BoxedTextColor.String, () => base.WriteInterpolatedText(text));

	public override void WriteComment(CommentType commentType, string content) {
		switch (commentType) {
		case CommentType.Documentation:
			// The fork's WriteXmlDoc: the delimiter, then the XML in the colors its SimpleXmlParser gives it.
			text.Output.Write("///", BoxedTextColor.XmlDocCommentDelimiter);
			text.Output.WriteXmlDoc(content);
			text.Output.WriteLine();
			break;
		case CommentType.InactiveCode:
			Colored(BoxedTextColor.ExcludedCode, () => base.WriteComment(commentType, content));
			break;
		default:
			Colored(BoxedTextColor.Comment, () => base.WriteComment(commentType, content));
			break;
		}
	}

	public override void WritePreProcessorDirective(PreProcessorDirectiveType type, string? argument) {
		text.Output.Write("#" + type.ToString().ToLowerInvariant(), BoxedTextColor.PreprocessorKeyword);
		if (!string.IsNullOrEmpty(argument)) {
			text.Output.Write(" ", BoxedTextColor.Text);
			text.Output.Write(argument, BoxedTextColor.PreprocessorText);
		}
		text.Output.WriteLine();
	}

	void Colored(string? color, Action write) {
		var previous = text.Color;
		text.Color = color;
		try {
			write();
		}
		finally {
			text.Color = previous;
		}
	}

	/// <summary>
	/// The text output ILSpy's writer talks to, forwarding to dnSpy's: the color is the token's when the writer knows
	/// it, else the color of what the reference names.
	/// </summary>
	sealed class ColoredTextOutput(IDecompilerOutput output) : ITextOutput {
		public IDecompilerOutput Output => output;

		/// <summary>The color of the token being written, set by the token writer; null for a name.</summary>
		public string? Color { get; set; }

		public string IndentationString { get; set; } = "\t";

		public void Indent() => output.IncreaseIndent();
		public void Unindent() => output.DecreaseIndent();
		public void Write(char ch) => Write(ch.ToString());
		public void Write(string text) => output.Write(text, Color ?? BoxedTextColor.Text);
		public void WriteLine() => output.WriteLine();

		public void WriteReference(OpCodeInfo opCode, bool omitSuffix = false) =>
			Write(omitSuffix ? opCode.Name ?? string.Empty : opCode.ToString() ?? string.Empty);

		public void WriteReference(DecompilerMetadataFile metadata, Handle handle, string text, string protocol = "decompile", bool isDefinition = false) =>
			Reference(text, null, isDefinition);

		public void WriteReference(DecompilerIType type, string text, bool isDefinition = false) => Reference(text, type, isDefinition);

		public void WriteReference(DecompilerIMember member, string text, bool isDefinition = false) => Reference(text, member, isDefinition);

		public void WriteLocalReference(string text, object reference, bool isDefinition = false, bool isHoverOnly = false) {
			var color = Color ?? reference switch {
				DecompilerILVariable or DecompilerIMember or DecompilerIType => WorkspaceManager.SharedDecompilers.SpanColorOf(reference),
				// A label is named by the method it is in and its name.
				string => BoxedTextColor.Label,
				_ => null,
			};
			var flags = DecompilerReferenceFlags.Local | (isDefinition ? DecompilerReferenceFlags.Definition : DecompilerReferenceFlags.None);
			output.Write(text, reference, flags, color ?? BoxedTextColor.Text);
		}

		void Reference(string text, object? reference, bool isDefinition) {
			var color = Color ?? (reference is null ? null : WorkspaceManager.SharedDecompilers.SpanColorOf(reference));
			output.Write(text, reference, isDefinition ? DecompilerReferenceFlags.Definition : DecompilerReferenceFlags.None, color ?? BoxedTextColor.Text);
		}

		public void MarkFoldStart(string collapsedText = "...", bool defaultCollapsed = false, bool isDefinition = false) { }
		public void MarkFoldEnd() { }
		public void MarkDefinitionStart() { }
	}
}
