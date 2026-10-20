using System.Diagnostics.CodeAnalysis;
using dnlib.DotNet;

namespace dnSpy.Backend.Core.Output;

/// <summary>
/// dnSpy's <c>IDecompilerOutput</c> (dnSpy.Contracts.Decompiler): what its decompilers, its IL disassembler and its
/// BAML decompiler write to. Text is written in a color, and a piece of it may name something — a member, a
/// local, an opcode, an address — which is what the document viewer follows and highlights. The code ported from
/// dnSpy writes to this interface unchanged; <see cref="DocumentOutput"/> turns what it writes into a document.
/// </summary>
interface IDecompilerOutput {
	/// <summary>The length of the text written so far.</summary>
	int Length { get; }

	/// <summary>Where the next character lands — the length plus the indentation not yet written.</summary>
	int NextPosition { get; }

	void IncreaseIndent();
	void DecreaseIndent();
	void WriteLine();
	void Write(string text, object color);
	void Write(string text, int index, int length, object color);
	void Write(string text, object? reference, DecompilerReferenceFlags flags, object color);
	void Write(string text, int index, int length, object? reference, DecompilerReferenceFlags flags, object color);

	/// <summary>dnSpy's <c>AddCustomData(PredefinedCustomDataIds.CodeBracesRange, ...)</c>.</summary>
	void AddBracePair(TextSpan start, TextSpan end, CodeBracesRangeFlags flags);

	/// <summary>dnSpy's <c>AddCustomData(PredefinedCustomDataIds.LineSeparator, ...)</c>.</summary>
	void AddLineSeparator(int position);

	/// <summary>dnSpy's <c>AddCustomData(PredefinedCustomDataIds.DebugInfo, ...)</c>: the statements of one method body.</summary>
	void AddDebugInfo(MethodDebugInfo debugInfo);
}

static class DecompilerOutputExtensions {
	public static void WriteLine(this IDecompilerOutput output, string text, object color) {
		output.Write(text, color);
		output.WriteLine();
	}

	/// <summary>dnSpy's <c>WriteXmlDoc</c>: an XML documentation line, colored the way its <c>SimpleXmlParser</c> colors it.</summary>
	public static void WriteXmlDoc(this IDecompilerOutput output, string xmlDocText) {
		foreach (var (text, color) in SimpleXmlParser.Parse(xmlDocText))
			output.Write(text, color);
	}
}

/// <summary>dnSpy's <c>DecompilerReferenceFlags</c>.</summary>
[Flags]
enum DecompilerReferenceFlags {
	None = 0,
	/// <summary>The text defines what it names.</summary>
	Definition = 0x00000001,
	/// <summary>A reference that only means something inside this document: a local, a parameter, a label, a number.</summary>
	Local = 0x00000002,
	/// <summary>The reference writes what it names.</summary>
	IsWrite = 0x00000004,
	/// <summary>Highlighted together with the other uses, but not shown as a link.</summary>
	Hidden = 0x00000008,
	/// <summary>Not followed when clicked.</summary>
	NoFollow = 0x00000010,
}

/// <summary>dnSpy's <c>CodeBracesRangeFlags</c>: the kind of brace and the kind of block a brace pair opens.</summary>
enum CodeBracesRangeFlags {
	BraceKind_None = 0,
	BraceKind_Parentheses = 0x00000001,
	BraceKind_CurlyBraces = 0x00000002,
	BraceKind_SquareBrackets = 0x00000003,
	BraceKind_AngleBrackets = 0x00000004,
	BraceKind_DoubleQuotes = 0x00000005,
	BraceKind_SingleQuotes = 0x00000006,
	BraceKind_OtherBraces = 0x00000007,

	BlockKind_None = 0,
	BlockKind_Namespace = 0x00000100,
	BlockKind_Type = 0x00000200,
	BlockKind_Module = 0x00000300,
	BlockKind_ValueType = 0x00000400,
	BlockKind_Interface = 0x00000500,
	BlockKind_Method = 0x00000600,
	BlockKind_Accessor = 0x00000700,
	BlockKind_AnonymousMethod = 0x00000800,
	BlockKind_Constructor = 0x00000900,
	BlockKind_Destructor = 0x00000A00,
	BlockKind_Operator = 0x00000B00,
	BlockKind_Conditional = 0x00000C00,
	BlockKind_Loop = 0x00000D00,
	BlockKind_Property = 0x00000E00,
	BlockKind_Event = 0x00000F00,
	BlockKind_Try = 0x00001000,
	BlockKind_Catch = 0x00001100,
	BlockKind_Filter = 0x00001200,
	BlockKind_Finally = 0x00001300,
	BlockKind_Fault = 0x00001400,
	BlockKind_Lock = 0x00001500,
	BlockKind_Using = 0x00001600,
	BlockKind_Fixed = 0x00001700,
	BlockKind_Switch = 0x00001800,
	BlockKind_Case = 0x00001900,
	BlockKind_LocalFunction = 0x00001A00,
	BlockKind_Other = 0x00001B00,
	BlockKind_Xml = 0x00001C00,
	BlockKind_Xaml = 0x00001D00,

	NamespaceBraces = BraceKind_CurlyBraces | BlockKind_Namespace,
	TypeBraces = BraceKind_CurlyBraces | BlockKind_Type,
	ModuleBraces = BraceKind_CurlyBraces | BlockKind_Module,
	ValueTypeBraces = BraceKind_CurlyBraces | BlockKind_ValueType,
	InterfaceBraces = BraceKind_CurlyBraces | BlockKind_Interface,
	MethodBraces = BraceKind_CurlyBraces | BlockKind_Method,
	AccessorBraces = BraceKind_CurlyBraces | BlockKind_Accessor,
	AnonymousMethodBraces = BraceKind_CurlyBraces | BlockKind_AnonymousMethod,
	ConstructorBraces = BraceKind_CurlyBraces | BlockKind_Constructor,
	DestructorBraces = BraceKind_CurlyBraces | BlockKind_Destructor,
	OperatorBraces = BraceKind_CurlyBraces | BlockKind_Operator,
	ConditionalBraces = BraceKind_CurlyBraces | BlockKind_Conditional,
	LoopBraces = BraceKind_CurlyBraces | BlockKind_Loop,
	PropertyBraces = BraceKind_CurlyBraces | BlockKind_Property,
	EventBraces = BraceKind_CurlyBraces | BlockKind_Event,
	TryBraces = BraceKind_CurlyBraces | BlockKind_Try,
	CatchBraces = BraceKind_CurlyBraces | BlockKind_Catch,
	FilterBraces = BraceKind_CurlyBraces | BlockKind_Filter,
	FinallyBraces = BraceKind_CurlyBraces | BlockKind_Finally,
	FaultBraces = BraceKind_CurlyBraces | BlockKind_Fault,
	LockBraces = BraceKind_CurlyBraces | BlockKind_Lock,
	UsingBraces = BraceKind_CurlyBraces | BlockKind_Using,
	FixedBraces = BraceKind_CurlyBraces | BlockKind_Fixed,
	SwitchBraces = BraceKind_CurlyBraces | BlockKind_Switch,
	CaseBraces = BraceKind_CurlyBraces | BlockKind_Case,
	LocalFunctionBraces = BraceKind_CurlyBraces | BlockKind_LocalFunction,
	OtherBlockBraces = BraceKind_CurlyBraces | BlockKind_Other,
	XmlBlockBraces = BraceKind_OtherBraces | BlockKind_Xml,
	XamlBlockBraces = BraceKind_OtherBraces | BlockKind_Xaml,
	SingleQuotes = BraceKind_SingleQuotes | BlockKind_None,
	DoubleQuotes = BraceKind_DoubleQuotes | BlockKind_None,
	Parentheses = BraceKind_Parentheses | BlockKind_None,
	AngleBrackets = BraceKind_AngleBrackets | BlockKind_None,
	SquareBrackets = BraceKind_SquareBrackets | BlockKind_None,
	CurlyBraces = BraceKind_CurlyBraces | BlockKind_None,
	OtherBraces = BraceKind_OtherBraces | BlockKind_None,
}

static class CodeBracesRangeFlagsHelper {
	const CodeBracesRangeFlags BraceKindMask = (CodeBracesRangeFlags)0x00000007;
	const CodeBracesRangeFlags BlockKindMask = (CodeBracesRangeFlags)0x00001F00;

	public static CodeBracesRangeFlags ToBraceKind(this CodeBracesRangeFlags flags) => flags & BraceKindMask;
	public static CodeBracesRangeFlags ToBlockKind(this CodeBracesRangeFlags flags) => flags & BlockKindMask;
	public static bool IsBraces(this CodeBracesRangeFlags flags) => (flags & BraceKindMask) != CodeBracesRangeFlags.BraceKind_None;
	public static bool IsBlock(this CodeBracesRangeFlags flags) => (flags & BlockKindMask) != CodeBracesRangeFlags.BlockKind_None;

	/// <summary>The block kind the way <see cref="dnSpy.Backend.Contracts.BlockStructureDto"/> names it: dnSpy's
	/// <c>BlockKind_*</c> name in camel case, which picks the color of the block structure line.</summary>
	public static string? ToBlockKindName(this CodeBracesRangeFlags flags) {
		var name = flags.ToBlockKind() switch {
			CodeBracesRangeFlags.BlockKind_None => null,
			var kind => kind.ToString(),
		};
		if (name is null || !name.StartsWith("BlockKind_", StringComparison.Ordinal))
			return null;
		name = name["BlockKind_".Length..];
		return char.ToLowerInvariant(name[0]) + name[1..];
	}
}

/// <summary>dnSpy's <c>TextSpan</c>: a stretch of the output text.</summary>
readonly struct TextSpan : IEquatable<TextSpan> {
	public int Start { get; }
	public int End { get; }
	public int Length => End - Start;
	public bool IsEmpty => End == Start;

	public TextSpan(int start, int length) {
		ArgumentOutOfRangeException.ThrowIfNegative(start);
		ArgumentOutOfRangeException.ThrowIfNegative(length);
		Start = start;
		End = start + length;
	}

	public static TextSpan FromBounds(int start, int end) => new(start, end - start);
	public bool Contains(int position) => Start <= position && position < End;
	public bool Equals(TextSpan other) => Start == other.Start && End == other.End;
	public override bool Equals([NotNullWhen(true)] object? obj) => obj is TextSpan other && Equals(other);
	public override int GetHashCode() => HashCode.Combine(Start, End);
	public static bool operator ==(TextSpan left, TextSpan right) => left.Equals(right);
	public static bool operator !=(TextSpan left, TextSpan right) => !left.Equals(right);
	public override string ToString() => $"[{Start},{End})";
}

/// <summary>dnSpy's <c>ILSpan</c>: a range of a method body's IL offsets.</summary>
readonly struct ILSpan : IEquatable<ILSpan> {
	public uint Start { get; }
	public uint End { get; }
	public uint Length => End - Start;
	public bool IsEmpty => End == Start;

	public ILSpan(uint start, uint length) {
		Start = start;
		End = start + length;
	}

	public static ILSpan FromBounds(uint start, uint end) {
		ArgumentOutOfRangeException.ThrowIfLessThan(end, start);
		return new ILSpan(start, end - start);
	}

	public bool Equals(ILSpan other) => Start == other.Start && End == other.End;
	public override bool Equals([NotNullWhen(true)] object? obj) => obj is ILSpan other && Equals(other);
	public override int GetHashCode() => HashCode.Combine(Start, End);
	public static bool operator ==(ILSpan left, ILSpan right) => left.Equals(right);
	public static bool operator !=(ILSpan left, ILSpan right) => !left.Equals(right);
	public override string ToString() => $"[{Start:X4},{End:X4})";
}

/// <summary>dnSpy's <c>SourceStatement</c>: the IL a stretch of the text stands for.</summary>
readonly record struct SourceStatement(ILSpan ILSpan, TextSpan TextSpan);

/// <summary>
/// dnSpy's <c>MethodDebugInfo</c>, as much of it as a document needs: the statements of one body. <paramref name="Method"/>
/// is the body the IL is in; <paramref name="KickoffMethod"/> the method the user wrote when that body is a state
/// machine's, which is what a breakpoint is named after.
/// </summary>
sealed record MethodDebugInfo(MethodDef Method, MethodDef? KickoffMethod, IReadOnlyList<SourceStatement> Statements);

/// <summary>dnSpy's <c>MethodDebugInfoBuilder</c>.</summary>
sealed class MethodDebugInfoBuilder(MethodDef method, MethodDef? kickoffMethod = null) {
	readonly List<SourceStatement> statements = [];

	public void Add(SourceStatement statement) => statements.Add(statement);

	public MethodDebugInfo Create() => new(method, kickoffMethod, statements.ToArray());
}

/// <summary>dnSpy's <c>TokenReference</c>: a metadata token written in a comment, which Copy MD Token copies.</summary>
sealed record TokenReference(ModuleDef Module, uint Token) {
	public TokenReference(IMemberRef member) : this(member.Module, member.MDToken.Raw) { }
}

/// <summary>dnSpy's <c>AddressReference</c>: an RVA or a file offset written in a comment, which the hex editor opens at.</summary>
sealed record AddressReference(string? Filename, bool IsRVA, ulong Address, ulong Length);

/// <summary>dnSpy's <c>NamespaceReference</c>: a namespace written in a comment.</summary>
sealed record NamespaceReference(IAssembly? Assembly, string? Namespace);

/// <summary>dnSpy's <c>SourceLocal</c>: a local as the IL view names it.</summary>
sealed class SourceLocal(dnlib.DotNet.Emit.Local? local, string name, TypeSig type) {
	public dnlib.DotNet.Emit.Local? Local { get; } = local;
	public string Name { get; } = name;
	public TypeSig Type { get; } = type;
}

/// <summary>dnSpy's <c>SourceParameter</c>: a parameter as the IL view names it.</summary>
sealed class SourceParameter(Parameter parameter, string name, TypeSig type) {
	public Parameter Parameter { get; } = parameter;
	public string Name { get; } = name;
	public TypeSig Type { get; } = type;
}
