using System.Text;
using System.Reflection.Metadata;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.CSharp.OutputVisitor;
using ICSharpCode.Decompiler.CSharp.Syntax;
using ICSharpCode.Decompiler.CSharp.Transforms;
using ICSharpCode.Decompiler.Disassembler;
using ICSharpCode.Decompiler.IL;
using ICSharpCode.Decompiler.Metadata;
using ICSharpCode.Decompiler.Semantics;
using ICSharpCode.Decompiler.TypeSystem;
using ICSharpCode.Decompiler.TypeSystem.Implementation;
using ICSharpCode.Decompiler.Util;

namespace dnSpy.Cli;

/// <summary>
/// A TextWriter that can switch the console's foreground colour. When colouring is off — redirected
/// output, --no-color, or a writer that is not the console — every call goes straight through.
/// </summary>
sealed class ColorTextWriter(TextWriter inner, bool colorEnabled) : TextWriter {
	ConsoleColor? currentColor;

	public override Encoding Encoding => inner.Encoding;

	/// <summary>A no-op writer for the tests and for redirected output.</summary>
	public static ColorTextWriter Plain(TextWriter inner) => new(inner, colorEnabled: false);

	public void SetColor(ConsoleColor? color) {
		if (!colorEnabled || currentColor == color)
			return;
		currentColor = color;
		if (color is null)
			Console.ResetColor();
		else
			Console.ForegroundColor = color.Value;
	}

	public void ResetColor() => SetColor(null);

	public override void Write(char value) => inner.Write(value);
	public override void Write(string? value) => inner.Write(value);
	public override void WriteLine() => inner.WriteLine();
	public override void WriteLine(string? value) => inner.WriteLine(value);
	public override void Flush() => inner.Flush();
	protected override void Dispose(bool disposing) {
		if (disposing)
			ResetColor();
		base.Dispose(disposing);
	}
}

/// <summary>
/// Colors the tokens of decompiled C#/VB the way dnSpy's console writer does: keywords, comments,
/// strings and preprocessor directives by token kind, and names by what they resolve to. The text and
/// the formatting are ICSharpCode.Decompiler's; only the colour is ours.
/// </summary>
sealed class ConsoleTokenWriter : TextWriterTokenWriter {
	readonly ColorTextWriter writer;
	readonly Stack<AstNode> nodeStack = new();

	public ConsoleTokenWriter(ColorTextWriter writer) : base(writer) => this.writer = writer;

	public override void StartNode(AstNode node) {
		base.StartNode(node);
		nodeStack.Push(node);
	}

	public override void EndNode(AstNode node) {
		base.EndNode(node);
		nodeStack.Pop();
	}

	public override void WriteIdentifier(Identifier identifier) {
		WriteColored(GetIdentifierColor(identifier), () => base.WriteIdentifier(identifier));
	}

	public override void WriteKeyword(string keyword) =>
		WriteColored(ConsoleColor.Cyan, () => base.WriteKeyword(keyword));

	public override void WritePrimitiveType(string type) =>
		WriteColored(ConsoleColor.Cyan, () => base.WritePrimitiveType(type));

	public override void WritePrimitiveValue(object? value, LiteralFormat format = LiteralFormat.None) =>
		WriteColored(ConsoleColor.DarkYellow, () => base.WritePrimitiveValue(value, format));

	public override void WriteInterpolatedText(string text) =>
		WriteColored(ConsoleColor.DarkYellow, () => base.WriteInterpolatedText(text));

	public override void WriteComment(CommentType commentType, string content) =>
		WriteColored(commentType == CommentType.Documentation ? ConsoleColor.DarkGreen : ConsoleColor.Green, () => base.WriteComment(commentType, content));

	public override void WritePreProcessorDirective(PreProcessorDirectiveType type, string? argument) =>
		WriteColored(ConsoleColor.Blue, () => base.WritePreProcessorDirective(type, argument));

	public override void WriteToken(string token) =>
		WriteColored(null, () => base.WriteToken(token));

	public override void Space() => WriteColored(null, base.Space);
	public override void NewLine() => WriteColored(null, base.NewLine);
	public override void Indent() => WriteColored(null, base.Indent);
	public override void Unindent() => WriteColored(null, base.Unindent);

	void WriteColored(ConsoleColor? color, Action write) {
		writer.SetColor(color);
		write();
		writer.ResetColor();
	}

	ConsoleColor? GetIdentifierColor(Identifier identifier) {
		if (nodeStack.Count == 0)
			return null;
		// A label is written as a plain identifier; dnSpy colours labels DarkRed.
		if (nodeStack.Peek() is LabelStatement or GotoStatement)
			return ConsoleColor.DarkRed;
		var definition = GetCurrentDefinition();
		if (ColorFor(definition) is { } definitionColor)
			return definitionColor;
		var reference = GetCurrentMemberReference();
		if (ColorFor(reference) is { } referenceColor)
			return referenceColor;
		if (GetCurrentLocalDefinition(identifier) is not null || GetCurrentLocalReference() is not null)
			return ConsoleColor.White;
		return null;
	}

	static ConsoleColor? ColorFor(ISymbol? symbol) => symbol switch {
		INamespace => ConsoleColor.Yellow,
		IType type => TypeColor(type),
		IMember member => MemberColor(member),
		_ => null,
	};

	internal static ConsoleColor? TypeColor(IType type) => type.Kind switch {
		TypeKind.Enum => ConsoleColor.Magenta,
		TypeKind.Interface => ConsoleColor.Magenta,
		TypeKind.Delegate => ConsoleColor.Magenta,
		TypeKind.Class => ConsoleColor.Magenta,
		TypeKind.Struct => ConsoleColor.Green,
		_ => null,
	};

	internal static ConsoleColor? MemberColor(IMember member) => member switch {
		IMethod => ConsoleColor.DarkYellow,
		IField => ConsoleColor.Magenta,
		IProperty => ConsoleColor.Magenta,
		IEvent => ConsoleColor.Magenta,
		_ => null,
	};

	// The symbol lookups below are ICSharpCode.Decompiler's TextTokenWriter's own; the writer only
	// exposes them privately, and they are what tells an identifier apart from a local and a keyword.
	ISymbol? GetCurrentDefinition() {
		if (nodeStack.Count == 0)
			return null;
		var node = nodeStack.Peek();
		if (node is Identifier)
			node = node.Parent!;
		if (TextTokenWriter.IsDefinition(ref node))
			return node.GetSymbol();
		return null;
	}

	ISymbol? GetCurrentMemberReference() {
		var node = nodeStack.Peek();
		var symbol = node.GetSymbol();
		if (symbol is null && node.Slot?.Kind == Slots.TargetExpression && node.Parent is InvocationExpression)
			symbol = node.Parent.GetSymbol();
		if (symbol is not null && node.Slot?.Kind == Slots.Type && node.Parent is ObjectCreateExpression && node.Parent.GetSymbol() is { } created)
			symbol = created;
		if (node is IdentifierExpression && node.Slot?.Kind == Slots.TargetExpression && node.Parent is InvocationExpression && symbol is IMember { DeclaringType.Kind: TypeKind.Delegate })
			return null;
		return symbol;
	}

	object? GetCurrentLocalReference() {
		var node = nodeStack.Peek();
		if (node.Annotation<ILVariableResolveResult>()?.Variable is { } variable)
			return variable;
		if (node.Annotation<LetIdentifierAnnotation>() is { } let)
			return let;
		if (node is GotoStatement gotoStatement) {
			var method = nodeStack.Select(n => n.GetSymbol() as IMethod).FirstOrDefault(m => m is not null);
			if (method is not null)
				return method + gotoStatement.Label;
		}
		return null;
	}

	object? GetCurrentLocalDefinition(Identifier identifier) {
		var node = nodeStack.Peek();
		if (node is Identifier && node.Parent is not null)
			node = node.Parent;
		if (node is ParameterDeclaration or VariableInitializer or CatchClause or VariableDesignation) {
			if (node.Annotation<ILVariableResolveResult>()?.Variable is { } variable)
				return variable;
		}
		if (identifier.Slot?.Kind == Slots.IntoIdentifier || identifier.Slot?.Kind == Slots.JoinIdentifier) {
			if (identifier.Annotation<ILVariableResolveResult>()?.Variable is { } into)
				return into;
		}
		if (node is QueryLetClause) {
			if (node.Annotation<LetIdentifierAnnotation>() is { } let)
				return let;
		}
		if (node is LabelStatement labelStatement) {
			var method = nodeStack.Select(n => n.GetSymbol() as IMethod).FirstOrDefault(m => m is not null);
			if (method is not null)
				return method + labelStatement.Label;
		}
		if (node is MethodDeclaration && node.Parent is LocalFunctionDeclarationStatement && node.Parent.GetResolveResult() is MemberResolveResult memberResult)
			return memberResult.Member.MemberDefinition;
		return null;
	}
}

/// <summary>
/// The output the IL disassembler writes into. It colours opcodes, members and labels, and it holds
/// one instruction line back until it is complete so that the sources of an "IL with C#" document can
/// be written in front of the instruction they decompile to.
/// </summary>
sealed class IlTextOutput(ColorTextWriter writer, string indentationString) : ITextOutput {
	readonly List<(string Text, ConsoleColor? Color)> line = [];
	int indentation;
	bool needsIndent = true;
	bool opcodeWritten;
	int? instructionOffset;
	Func<MethodDefinitionHandle, Func<int, IReadOnlyList<string>>>? sourceCommentFactory;
	Func<int, IReadOnlyList<string>>? sourceComments;

	public string IndentationString { get; set; } = indentationString;

	/// <summary>
	/// The sources of each method's instructions, by IL offset; null for plain IL. The disassembler
	/// announces each method it writes, which is where its provider is picked.
	/// </summary>
	public void SetSourceComments(Func<MethodDefinitionHandle, Func<int, IReadOnlyList<string>>>? factory) => sourceCommentFactory = factory;

	public void Indent() => indentation++;
	public void Unindent() => indentation = Math.Max(0, indentation - 1);

	public void Write(char ch) => Write(ch.ToString());
	public void Write(string text) {
		if (text.Length == 0)
			return;
		var start = 0;
		for (var i = 0; i < text.Length; i++) {
			if (text[i] != '\n')
				continue;
			var end = i > start && text[i - 1] == '\r' ? i - 1 : i;
			Append(text[start..end], null);
			EndLine();
			start = i + 1;
		}
		if (start < text.Length)
			Append(text[start..], null);
	}

	public void WriteLine() => EndLine();

	public void WriteReference(OpCodeInfo opCode, bool omitSuffix = false) {
		var name = opCode.Name ?? string.Empty;
		if (omitSuffix) {
			var dot = name.LastIndexOf('.');
			if (dot > 0)
				name = name.Remove(dot + 1);
		}
		opcodeWritten = true;
		AppendColored(name, ConsoleColor.Cyan);
	}

	public void WriteReference(MetadataFile metadata, Handle handle, string text, string protocol = "decompile", bool isDefinition = false) {
		if (isDefinition && text == ".method" && handle.Kind == HandleKind.MethodDefinition)
			sourceComments = sourceCommentFactory?.Invoke((MethodDefinitionHandle)handle);
		AppendColored(text, HandleColor(metadata, handle));
	}

	public void WriteReference(IType type, string text, bool isDefinition = false) =>
		AppendColored(text, ConsoleTokenWriter.TypeColor(type));

	public void WriteReference(IMember member, string text, bool isDefinition = false) =>
		AppendColored(text, ConsoleTokenWriter.MemberColor(member));

	public void WriteLocalReference(string text, object reference, bool isDefinition = false, bool isHoverOnly = false) {
		if (reference is int offset) {
			// The offset label comes before the opcode; the branch targets that follow one are local
			// references too and must not be mistaken for it.
			if (!opcodeWritten && text.StartsWith("IL_", StringComparison.Ordinal))
				instructionOffset = offset;
			AppendColored(text, ConsoleColor.DarkRed);
			return;
		}
		AppendColored(text, ConsoleColor.White);
	}

	public void MarkFoldStart(string collapsedText = "...", bool defaultCollapsed = false, bool isDefinition = false) { }
	public void MarkDefinitionStart() { }
	public void MarkFoldEnd() { }

	static ConsoleColor? HandleColor(MetadataFile metadata, Handle handle) => handle.Kind switch {
		HandleKind.TypeDefinition or HandleKind.TypeReference or HandleKind.TypeSpecification => ConsoleColor.Magenta,
		HandleKind.FieldDefinition or HandleKind.PropertyDefinition or HandleKind.EventDefinition => ConsoleColor.Magenta,
		HandleKind.MethodDefinition => ConsoleColor.DarkYellow,
		_ => null,
	};

	void AppendColored(string text, ConsoleColor? color) => Append(text, color);

	void Append(string text, ConsoleColor? color) {
		if (text.Length == 0)
			return;
		EnsureIndentation();
		line.Add((text, color));
	}

	void EnsureIndentation() {
		if (!needsIndent)
			return;
		needsIndent = false;
		for (var i = 0; i < indentation; i++)
			line.Add((IndentationString, null));
	}

	void EndLine() {
		// The mixed view sets the statements off from the instructions around them with blank lines,
		// the way dnSpy's IL with C# output does, and colours them like XML doc comments.
		if (instructionOffset is { } offset && sourceComments?.Invoke(offset) is { Count: > 0 } comments) {
			writer.WriteLine();
			foreach (var comment in comments) {
				writer.SetColor(ConsoleColor.DarkGreen);
				for (var i = 0; i < indentation; i++)
					writer.Write(IndentationString);
				writer.Write("// ");
				writer.Write(comment);
				writer.WriteLine();
				writer.ResetColor();
			}
			writer.WriteLine();
		}
		foreach (var (text, color) in line) {
			writer.SetColor(color);
			writer.Write(text);
		}
		writer.ResetColor();
		writer.WriteLine();
		line.Clear();
		instructionOffset = null;
		opcodeWritten = false;
		needsIndent = true;
	}
}

/// <summary>
/// A lightweight lexer for the text Visual Basic conversion produces: comments ('), strings and
/// keywords, the three things the console can tell apart without a VB parser.
/// </summary>
sealed class VisualBasicColorWriter(ColorTextWriter writer) {
	static readonly HashSet<string> keywords = new(StringComparer.OrdinalIgnoreCase) {
		"AddHandler", "AddressOf", "Alias", "And", "AndAlso", "As", "Boolean", "ByRef", "Byte", "ByVal",
		"Call", "Case", "Catch", "CBool", "CByte", "CChar", "CDate", "CDbl", "CDec", "Char", "CInt",
		"Class", "CLng", "CObj", "Const", "Continue", "CSByte", "CShort", "CSng", "CStr", "CType",
		"CUInt", "CULng", "CUShort", "Date", "Decimal", "Declare", "Default", "Delegate", "Dim",
		"DirectCast", "Do", "Double", "Each", "Else", "ElseIf", "End", "EndIf", "Enum", "Erase",
		"Error", "Event", "Exit", "False", "Finally", "For", "Friend", "Function", "Get", "GetType",
		"GetXMLNamespace", "Global", "GoSub", "GoTo", "Handles", "If", "Implements", "Imports", "In",
		"Inherits", "Integer", "Interface", "Is", "IsNot", "Let", "Lib", "Like", "Long", "Loop",
		"Me", "Mod", "Module", "MustInherit", "MustOverride", "MyBase", "MyClass", "Namespace",
		"Narrowing", "New", "Next", "Not", "Nothing", "NotInheritable", "NotOverridable", "Object",
		"Of", "On", "Operator", "Option", "Optional", "Or", "OrElse", "Overloads", "Overridable",
		"Overrides", "ParamArray", "Partial", "Private", "Property", "Protected", "Public",
		"RaiseEvent", "ReadOnly", "ReDim", "REM", "RemoveHandler", "Resume", "Return", "SByte",
		"Select", "Set", "Shadows", "Shared", "Short", "Single", "Static", "Step", "Stop", "String",
		"Structure", "Sub", "SyncLock", "Then", "Throw", "To", "True", "Try", "TryCast", "TypeOf",
		"UInteger", "ULong", "UShort", "Using", "Variant", "Wend", "When", "While", "Widening",
		"With", "WithEvents", "WriteOnly", "Xor",
	};

	public void Write(string text) {
		var index = 0;
		while (index < text.Length) {
			var ch = text[index];
			if (ch == '\'') {
				var end = text.IndexOf('\n', index);
				if (end < 0)
					end = text.Length;
				WriteColored(text[index..end], ConsoleColor.Green);
				index = end;
			}
			else if (ch == '"') {
				var end = index + 1;
				while (end < text.Length) {
					if (text[end] == '"') {
						if (end + 1 < text.Length && text[end + 1] == '"') {
							end += 2;
							continue;
						}
						end++;
						break;
					}
					end++;
				}
				WriteColored(text[index..end], ConsoleColor.DarkYellow);
				index = end;
			}
			else if (char.IsLetter(ch) || ch == '_') {
				var end = index + 1;
				while (end < text.Length && (char.IsLetterOrDigit(text[end]) || text[end] == '_'))
					end++;
				var word = text[index..end];
				WriteColored(word, keywords.Contains(word) ? ConsoleColor.Cyan : null);
				index = end;
			}
			else if (char.IsDigit(ch)) {
				var end = index + 1;
				while (end < text.Length && (char.IsLetterOrDigit(text[end]) || text[end] == '.' || text[end] == '_'))
					end++;
				WriteColored(text[index..end], ConsoleColor.DarkYellow);
				index = end;
			}
			else {
				WriteColored(ch.ToString(), null);
				index++;
			}
		}
	}

	void WriteColored(string text, ConsoleColor? color) {
		writer.SetColor(color);
		writer.Write(text);
		writer.ResetColor();
	}
}
