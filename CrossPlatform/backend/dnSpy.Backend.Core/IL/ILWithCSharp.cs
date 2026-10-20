/*
    Copyright (C) 2014-2019 de4dot@gmail.com

    This file is part of dnSpy

    dnSpy is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    dnSpy is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with dnSpy.  If not, see <http://www.gnu.org/licenses/>.
*/

using System.Text;
using dnlib.DotNet;
using dnlib.DotNet.Emit;
using dnlib.DotNet.Pdb;
using dnSpy.Backend.Core.Output;

// dnSpy.Decompiler.ILSpy.Core/Mixed/SourceStatementProvider.cs and the CustomMethodBodyDisassembler of
// Mixed/ILWithCSharpDecompiler.cs: IL with C# writes, above the first instruction of each C# statement, the line(s)
// of C# the statement is on — and under the first of them a row of carets when the statement is only part of it.
namespace dnSpy.Backend.Core.IL;

/// <summary>
/// The C# a method body was decompiled to and the IL range of each of its statements. dnSpy reads it from the
/// method debug info its C# decompiler records; the port builds it from ILSpy's sequence points.
/// </summary>
struct SourceStatementProvider {
	readonly string? text;
	readonly IReadOnlyList<SourceStatement>? statements;
	SourceStatement? lastStatement;

	public SourceStatementProvider(string text, IReadOnlyList<SourceStatement> statements) {
		this.text = text;
		this.statements = statements;
		lastStatement = null;
	}

	/// <summary><c>MethodDebugInfo.GetSourceStatementByCodeOffset</c>: the first statement whose IL holds the offset.</summary>
	SourceStatement? GetSourceStatementByCodeOffset(uint ilOffset) {
		foreach (var statement in statements!) {
			if (statement.ILSpan.Start <= ilOffset && ilOffset < statement.ILSpan.End)
				return statement;
		}
		return null;
	}

	public (string? line, TextSpan span) GetStatement(uint ilOffset) {
		if (text is null || statements is null)
			return default;

		var lastStmt = lastStatement;
		var stmt = GetSourceStatementByCodeOffset(ilOffset);
		lastStatement = stmt;
		if (stmt is null)
			return default;
		if (lastStmt == stmt)
			return default;

		int startPos = stmt.Value.TextSpan.Start;
		while (startPos > 0 && text[startPos - 1] != '\n')
			startPos--;
		var endPos = stmt.Value.TextSpan.End;
		while (endPos < text.Length) {
			var c = text[endPos];
			if (c == '\r' || c == '\n')
				break;
			endPos++;
		}

		return (text.Substring(startPos, endPos - startPos), new TextSpan(stmt.Value.TextSpan.Start - startPos, stmt.Value.TextSpan.Length));
	}
}

sealed class CustomMethodBodyDisassembler(IDecompilerOutput output, bool detectControlStructure, DisassemblerOptions options, StringBuilder stringBuilder, Func<MethodDef, SourceStatementProvider> createSourceStatementProvider)
	: MethodBodyDisassembler(output, detectControlStructure, options, stringBuilder) {
	SourceStatementProvider statementProvider;

	public override void Disassemble(MethodDef method, MethodDebugInfoBuilder? builder, InstructionOperandConverter instructionOperandConverter) {
		statementProvider = createSourceStatementProvider(method);
		base.Disassemble(method, builder, instructionOperandConverter);
	}

	protected override int WriteInstruction(InstructionOperandConverter instructionOperandConverter, long baseOffs, IInstructionBytesReader? byteReader, PdbAsyncMethodCustomDebugInfo? pdbAsyncInfo, MethodDef method, Instruction inst) {
		var statement = statementProvider.GetStatement(inst.Offset);

		if (statement.line is null)
			return base.WriteInstruction(instructionOperandConverter, baseOffs, byteReader, pdbAsyncInfo, method, inst);

		output.WriteLine();

		int pos = 0;
		while (pos < statement.line.Length) {
			int nextLineOffset;
			int eol = statement.line.IndexOf('\n', pos);
			if (eol < 0) {
				eol = statement.line.Length;
				nextLineOffset = eol;
			}
			else {
				nextLineOffset = eol + 1;
				if (eol > 0 && statement.line[eol - 1] == '\r')
					eol--;
			}

			output.Write("// ", BoxedTextColor.XmlDocCommentText);
			output.Write(statement.line, pos, eol - pos, BoxedTextColor.XmlDocCommentText);
			output.WriteLine();

			if (pos == 0) {
				int nonSpace = FindNonSpace(statement.line, pos, eol);
				int stmtEnd = Math.Min(eol, statement.span.End);
				if (!(nonSpace >= statement.span.Start && stmtEnd == eol)) {
					output.Write("// ", BoxedTextColor.XmlDocCommentText);
					output.Write(new string(' ', statement.span.Start - pos), BoxedTextColor.XmlDocCommentText);
					output.Write(new string('^', Math.Max(0, stmtEnd - statement.span.Start)), BoxedTextColor.XmlDocCommentText);
					output.WriteLine();
				}
			}

			pos = nextLineOffset;
		}

		output.WriteLine();

		return base.WriteInstruction(instructionOperandConverter, baseOffs, byteReader, pdbAsyncInfo, method, inst);
	}

	static int FindNonSpace(string lines, int pos, int end) {
		while (pos < end) {
			if (!char.IsWhiteSpace(lines[pos]))
				return pos;
			pos++;
		}
		return -1;
	}
}
