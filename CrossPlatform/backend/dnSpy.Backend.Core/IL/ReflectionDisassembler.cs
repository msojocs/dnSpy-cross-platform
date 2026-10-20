// Copyright (c) 2011 AlphaSierraPapa for the SharpDevelop Team
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this
// software and associated documentation files (the "Software"), to deal in the Software
// without restriction, including without limitation the rights to use, copy, modify, merge,
// publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
// to whom the Software is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
// PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
// FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.

using System.Globalization;
using System.Text;
using dnlib.DotNet;
using dnlib.DotNet.Emit;
using dnlib.PE;
using dnSpy.Backend.Core.Output;

namespace dnSpy.Backend.Core.IL;

/// <summary>Names a method body's locals the way the IL view writes them: their own name, or V_ and the index.</summary>
sealed class InstructionOperandConverter {
	readonly Dictionary<object, object> dict = [];
	readonly List<SourceLocal> sourceLocals = [];

	public object? Convert(object? obj) {
		if (obj is not null && dict.TryGetValue(obj, out var other))
			return other;
		return obj;
	}

	public void Clear() {
		dict.Clear();
		sourceLocals.Clear();
	}

	public SourceLocal[] GetSourceLocals() => sourceLocals.ToArray();

	public void Add(MethodDef method) {
		var body = method.Body;
		if (body is null)
			return;
		for (int i = 0; i < body.Variables.Count; i++) {
			var local = body.Variables[i];
			var sourceLocal = new SourceLocal(local, CreateLocalName(local), local.Type);
			sourceLocals.Add(sourceLocal);
			dict.Add(local, sourceLocal);
		}
	}

	static string CreateLocalName(Local local) {
		var name = local.Name;
		if (!string.IsNullOrEmpty(name))
			return name;
		return "V_" + local.Index.ToString(CultureInfo.InvariantCulture);
	}
}

/// <summary>An opening brace written now and its closing one later, recorded as a pair — and, for a block, as one.</summary>
readonly struct BracePairHelper {
	readonly IDecompilerOutput? output;
	readonly CodeBracesRangeFlags flags;
	readonly int leftStart, leftEnd;

	BracePairHelper(IDecompilerOutput output, int leftStart, int leftEnd, CodeBracesRangeFlags flags) {
		this.output = output;
		this.leftStart = leftStart;
		this.leftEnd = leftEnd;
		this.flags = flags;
	}

	public static BracePairHelper Create(IDecompilerOutput output, string s, CodeBracesRangeFlags flags) {
		int start = output.NextPosition;
		output.Write(s, BoxedTextColor.Punctuation);
		return new BracePairHelper(output, start, output.NextPosition, flags);
	}

	public void Write(string s) {
		if (output is null)
			return;
		int start = output.NextPosition;
		output.Write(s, BoxedTextColor.Punctuation);
		output.AddBracePair(new TextSpan(leftStart, leftEnd - leftStart), new TextSpan(start, output.NextPosition - start), flags);
	}
}

/// <summary>dnSpy's <c>DisassemblerOptions</c>: what the IL settings turn on.</summary>
sealed class DisassemblerOptions(CancellationToken cancellationToken, ModuleDef? ownerModule) {
	public ModuleDef? OwnerModule { get; } = ownerModule;

	public CancellationToken CancellationToken { get; } = cancellationToken;

	/// <summary>null if we shouldn't add opcode documentation. It returns null if no doc was found</summary>
	public Func<OpCode, string?>? GetOpCodeDocumentation { get; set; }

	/// <summary>null if we shouldn't add XML doc comments.</summary>
	public Func<IMemberRef, IEnumerable<string>>? GetXmlDocComments { get; set; }

	/// <summary>Creates a <see cref="IInstructionBytesReader"/> instance</summary>
	public Func<MethodDef, IInstructionBytesReader>? CreateInstructionBytesReader { get; set; }

	/// <summary>Show tokens, RVAs, file offsets</summary>
	public bool ShowTokenAndRvaComments { get; set; }

	/// <summary>Show IL instruction bytes</summary>
	public bool ShowILBytes { get; set; }

	/// <summary>Sort members if true</summary>
	public bool SortMembers { get; set; }

	/// <summary>Shows line numbers if a PDB file has been loaded</summary>
	public bool ShowPdbInfo { get; set; }

	/// <summary>Max length of a string</summary>
	public int MaxStringLength { get; set; } = int.MaxValue;

	/// <summary>Use hexadecimal numbers</summary>
	public bool HexadecimalNumbers { get; set; }
}

/// <summary>
/// Disassembles type and member definitions: dnSpy's ILSpy fork's <c>ReflectionDisassembler</c>
/// (ICSharpCode.Decompiler/Disassembler/ReflectionDisassembler.cs), writing to the port's <see cref="IDecompilerOutput"/>.
/// </summary>
sealed partial class ReflectionDisassembler {
	readonly IDecompilerOutput output;
	readonly DisassemblerOptions options;
	readonly InstructionOperandConverter instructionOperandConverter;
	readonly NumberFormatter numberFormatter;
	readonly StringBuilder sb;
	readonly MethodBodyDisassembler methodBodyDisassembler;

	const DecompilerReferenceFlags numberFlags = DecompilerReferenceFlags.Local | DecompilerReferenceFlags.Hidden | DecompilerReferenceFlags.NoFollow;

	public ReflectionDisassembler(IDecompilerOutput output, bool detectControlStructure, DisassemblerOptions options, StringBuilder? sb = null) {
		this.output = output ?? throw new ArgumentNullException(nameof(output));
		this.options = options;
		this.sb = sb ?? new StringBuilder();
		methodBodyDisassembler = new MethodBodyDisassembler(output, detectControlStructure, options, this.sb);
		instructionOperandConverter = new InstructionOperandConverter();
		numberFormatter = NumberFormatter.GetCSharpInstance(hex: options.HexadecimalNumbers, upper: true);
	}

	public ReflectionDisassembler(IDecompilerOutput output, DisassemblerOptions options, MethodBodyDisassembler methodBodyDisassembler, StringBuilder sb) {
		this.output = output ?? throw new ArgumentNullException(nameof(output));
		this.options = options;
		this.sb = sb;
		this.methodBodyDisassembler = methodBodyDisassembler;
		instructionOperandConverter = new InstructionOperandConverter();
		numberFormatter = NumberFormatter.GetCSharpInstance(hex: options.HexadecimalNumbers, upper: true);
	}

	#region Disassemble Method
	readonly EnumNameCollection<MethodAttributes> methodAttributeFlags = new() {
		{ MethodAttributes.Final, "final" },
		{ MethodAttributes.HideBySig, "hidebysig" },
		{ MethodAttributes.SpecialName, "specialname" },
		{ MethodAttributes.PinvokeImpl, null }, // handled separately
		{ MethodAttributes.UnmanagedExport, "unmanagedexp" },
		{ MethodAttributes.RTSpecialName, "rtspecialname" },
		{ MethodAttributes.RequireSecObject, "reqsecobj" },
		{ MethodAttributes.NewSlot, "newslot" },
		{ MethodAttributes.CheckAccessOnOverride, "strict" },
		{ MethodAttributes.Abstract, "abstract" },
		{ MethodAttributes.Virtual, "virtual" },
		{ MethodAttributes.Static, "static" },
		{ MethodAttributes.HasSecurity, null }, // ?? also invisible in ILDasm
	};

	readonly EnumNameCollection<MethodAttributes> methodVisibility = new() {
		{ MethodAttributes.Private, "private" },
		{ MethodAttributes.FamANDAssem, "famandassem" },
		{ MethodAttributes.Assembly, "assembly" },
		{ MethodAttributes.Family, "family" },
		{ MethodAttributes.FamORAssem, "famorassem" },
		{ MethodAttributes.Public, "public" },
	};

	readonly EnumNameCollection<CallingConvention> callingConvention = new() {
		{ CallingConvention.C, "unmanaged cdecl" },
		{ CallingConvention.StdCall, "unmanaged stdcall" },
		{ CallingConvention.ThisCall, "unmanaged thiscall" },
		{ CallingConvention.FastCall, "unmanaged fastcall" },
		{ CallingConvention.VarArg, "vararg" },
		{ CallingConvention.NativeVarArg, "nativevararg" },
		{ CallingConvention.Unmanaged, "unmanaged" },
		{ CallingConvention.Generic, null },
	};

	readonly EnumNameCollection<MethodImplAttributes> methodCodeType = new() {
		{ MethodImplAttributes.IL, "cil" },
		{ MethodImplAttributes.Native, "native" },
		{ MethodImplAttributes.OPTIL, "optil" },
		{ MethodImplAttributes.Runtime, "runtime" },
	};

	readonly EnumNameCollection<MethodImplAttributes> methodImpl = new() {
		{ MethodImplAttributes.Synchronized, "synchronized" },
		{ MethodImplAttributes.NoInlining, "noinlining" },
		{ MethodImplAttributes.NoOptimization, "nooptimization" },
		{ MethodImplAttributes.PreserveSig, "preservesig" },
		{ MethodImplAttributes.InternalCall, "internalcall" },
		{ MethodImplAttributes.ForwardRef, "forwardref" },
		{ MethodImplAttributes.AggressiveInlining, "aggressiveinlining" },
		{ MethodImplAttributes.AggressiveOptimization, "aggressiveoptimization" },
		{ MethodImplAttributes.SecurityMitigations, "securitymitigations" },
	};

	void WriteXmlDocComment(IMemberDef mr) {
		if (options.GetXmlDocComments is null)
			return;
		foreach (var line in options.GetXmlDocComments(mr)) {
			output.Write("///", BoxedTextColor.XmlDocCommentDelimiter);
			output.WriteXmlDoc(line);
			output.WriteLine();
		}
	}

	public void DisassembleMethod(MethodDef method, bool addLineSep = true) {
		// write method header
		WriteXmlDocComment(method);
		AddComment(method);
		int methodStartPosition = output.NextPosition;
		output.Write(".method", BoxedTextColor.ILDirective);
		output.Write(" ", BoxedTextColor.Text);
		DisassembleMethodInternal(method, addLineSep, methodStartPosition);
	}

	void DisassembleMethodInternal(MethodDef method, bool addLineSep, int methodStartPosition) {
		//    .method public hidebysig  specialname
		//               instance default class [mscorlib]System.IO.TextWriter get_BaseWriter ()  cil managed
		//

		//emit flags
		WriteEnum(method.Attributes & MethodAttributes.MemberAccessMask, methodVisibility);
		WriteFlags(method.Attributes & ~MethodAttributes.MemberAccessMask, methodAttributeFlags);
		if (method.IsCompilerControlled) {
			output.Write("privatescope", BoxedTextColor.Keyword);
			output.Write(" ", BoxedTextColor.Text);
		}

		if (method.IsPinvokeImpl) {
			output.Write("pinvokeimpl", BoxedTextColor.Keyword);
			var bh2 = BracePairHelper.Create(output, "(", CodeBracesRangeFlags.Parentheses);
			if (method.HasImplMap)
				WriteImplMap(method.ImplMap, method.Name);
			bh2.Write(")");
			output.Write(" ", BoxedTextColor.Text);
		}

		output.WriteLine();
		output.IncreaseIndent();
		if (method.ExplicitThis) {
			output.Write("instance", BoxedTextColor.Keyword);
			output.Write(" ", BoxedTextColor.Text);
			output.Write("explicit", BoxedTextColor.Keyword);
			output.Write(" ", BoxedTextColor.Text);
		}
		else if (method.HasThis) {
			output.Write("instance", BoxedTextColor.Keyword);
			output.Write(" ", BoxedTextColor.Text);
		}

		//call convention
		WriteEnum(method.CallingConvention, callingConvention);

		//return type
		method.ReturnType.WriteTo(output, sb);
		output.Write(" ", BoxedTextColor.Text);
		if (method.Parameters.ReturnParameter.HasParamDef && method.Parameters.ReturnParameter.ParamDef.HasMarshalType)
			WriteMarshalInfo(method.Parameters.ReturnParameter.ParamDef.MarshalType);

		if (method.IsCompilerControlled)
			output.Write(DisassemblerHelpers.Escape(method.Name + "$PST" + method.MDToken.ToInt32().ToString("X8", CultureInfo.InvariantCulture)), method, DecompilerReferenceFlags.Definition, CSharpMetadataTextColorProvider.Instance.GetColor(method));
		else
			output.Write(DisassemblerHelpers.Escape(method.Name), method, DecompilerReferenceFlags.Definition, CSharpMetadataTextColorProvider.Instance.GetColor(method));

		WriteTypeParameters(method);

		//( params )
		output.Write(" ", BoxedTextColor.Text);
		var bh3 = BracePairHelper.Create(output, "(", CodeBracesRangeFlags.Parentheses);
		if (method.Parameters.GetNumberOfNormalParameters() > 0) {
			output.WriteLine();
			output.IncreaseIndent();
			WriteParameters(method.Parameters);
			output.DecreaseIndent();
		}
		bh3.Write(")");
		output.Write(" ", BoxedTextColor.Text);
		//cil managed
		WriteEnum(method.ImplAttributes & MethodImplAttributes.CodeTypeMask, methodCodeType);
		if ((method.ImplAttributes & MethodImplAttributes.ManagedMask) == MethodImplAttributes.Managed)
			output.Write("managed", BoxedTextColor.Keyword);
		else
			output.Write("unmanaged", BoxedTextColor.Keyword);
		output.Write(" ", BoxedTextColor.Text);
		WriteFlags(method.ImplAttributes & ~(MethodImplAttributes.CodeTypeMask | MethodImplAttributes.ManagedMask), methodImpl);

		output.DecreaseIndent();
		var bh1 = OpenBlock(flags: CodeBracesRangeFlags.MethodBraces);
		WriteAttributes(method.CustomAttributes);
		if (method.HasOverrides) {
			for (int i = 0; i < method.Overrides.Count; i++) {
				output.Write(".override", BoxedTextColor.ILDirective);
				output.Write(" ", BoxedTextColor.Text);
				output.Write("method", BoxedTextColor.Keyword);
				output.Write(" ", BoxedTextColor.Text);
				method.Overrides[i].MethodDeclaration.WriteMethodTo(output, sb);
				output.WriteLine();
			}
		}

		for (int i = 0; i < method.GenericParameters.Count; i++)
			WriteGenericParameterAttributes(method.GenericParameters[i]);

		WriteParameterAttributes(0, method.Parameters.ReturnParameter);
		for (int i = 0; i < method.Parameters.Count; i++) {
			var p = method.Parameters[i];
			if (p.IsHiddenThisParameter)
				continue;
			WriteParameterAttributes(p.MethodSigIndex + 1, p);
		}
		WriteSecurityDeclarations(method);

		MethodDebugInfoBuilder? builder = null;
		if (method.HasBody) {
			instructionOperandConverter.Clear();
			instructionOperandConverter.Add(method);
			builder = new MethodDebugInfoBuilder(method);
			methodBodyDisassembler.Disassemble(method, builder, instructionOperandConverter);
		}

		CloseBlock(bh1, addLineSep, "end of method " + DisassemblerHelpers.Escape(method.DeclaringType?.Name) + "::" + DisassemblerHelpers.Escape(method.Name));

		if (builder is not null)
			output.AddDebugInfo(builder.Create());
	}
	#endregion
}
