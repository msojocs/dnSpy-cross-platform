using dnlib.DotNet;
using dnlib.DotNet.Emit;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The IL and IL with C# documents: dnSpy's IL decompilers over the port of its ILSpy fork's disassembler — the
/// ilasm text, the IL settings, the documents of an assembly, a module and a namespace, the C# above the
/// instructions, and what the viewer gets beside the text (statements, labels, token and address comments).
/// </summary>
public sealed class ILDisassemblerTests : IDisposable {
	static readonly string DebugTargetPath = Path.Combine(AppContext.BaseDirectory, "DebugTarget.dll");
	readonly WorkspaceManager manager = new();
	readonly List<string> temporaryDirectories = [];

	static CancellationToken Token => TestContext.Current.CancellationToken;

	static int TokenOf(string typeName, string? methodName = null) {
		using var module = ModuleDefMD.Load(DebugTargetPath);
		var type = module.Find(typeName, isReflectionName: true) ?? throw new InvalidOperationException($"No type {typeName}.");
		return unchecked((int)(methodName is null ? type.MDToken.Raw : type.FindMethod(methodName).MDToken.Raw));
	}

	async Task<(string WorkspaceId, string NodeId)> OpenAsync(string typeName, string? methodName = null, string? path = null) {
		path ??= DebugTargetPath;
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), Token);
		var found = await manager.FindMemberAsync(new FindMemberRequest(opened.WorkspaceId, path, TokenOf(typeName, methodName)), Token);
		return (opened.WorkspaceId, found.NodeId ?? throw new InvalidOperationException("The member has no node."));
	}

	Task<DecompileResponse> DecompileAsync(string workspaceId, string nodeId, DecompilerLanguage language = DecompilerLanguage.IL, ILDecompilerSettingsDto? il = null) =>
		manager.DecompileAsync(new DecompileRequest(workspaceId, nodeId, language) { Settings = il is null ? null : new DecompilerSettingsDto(IL: il) }, Token);

	async Task<DecompileResponse> MethodAsync(string methodName, DecompilerLanguage language = DecompilerLanguage.IL, ILDecompilerSettingsDto? il = null) {
		var (workspaceId, nodeId) = await OpenAsync("DebugTarget.Program", methodName);
		return await DecompileAsync(workspaceId, nodeId, language, il);
	}

	static string TextOf(DecompileResponse document, TextSpanDto span) => document.Text.Substring(span.Start, span.Length);

	static string[] LinesOf(DecompileResponse document) => document.Text.Split('\n').Select(line => line.TrimEnd('\r')).ToArray();

	static string LineWith(DecompileResponse document, string text) => Assert.Single(LinesOf(document), line => line.Contains(text, StringComparison.Ordinal));

	static MethodDef LoadMethod(ModuleDefMD module, string methodName) => module.Find("DebugTarget.Program", isReflectionName: true)!.FindMethod(methodName);

	[Fact]
	public async Task WritesAMethodTheWayDnSpysDisassemblerDoes() {
		var document = await MethodAsync("Calculate");

		Assert.Equal("il", document.Language);
		var lines = LinesOf(document);
		using var module = ModuleDefMD.Load(DebugTargetPath);
		var calculate = LoadMethod(module, "Calculate");
		// The token comment, the header split over two lines, the parameters one per line.
		Assert.Equal($"// Token: 0x{calculate.MDToken.Raw:X8} RID: {calculate.MDToken.Rid} RVA: 0x{(uint)calculate.RVA:X8} File Offset: 0x{(uint)module.Metadata.PEImage.ToFileOffset(calculate.RVA):X8}", lines[0]);
		Assert.Equal(".method private hidebysig static ", lines[1]);
		Assert.Equal("\tint32 Calculate (", lines[2]);
		Assert.Equal("\t\tint32 left,", lines[3]);
		Assert.Equal("\t\tint32 right", lines[4]);
		Assert.StartsWith("\t) cil managed", lines[5], StringComparison.Ordinal);
		Assert.Equal("{", lines[6]);
		Assert.Contains("\t// Header Size: 12 bytes", lines);
		Assert.Contains("\t.maxstack 2", lines);
		Assert.Contains("\t.locals init (", lines);
		Assert.Contains("\t\t[0] int32 sum,", lines);
		Assert.Contains("} // end of method Program::Calculate", lines);
		// A loop is indented under the comments the disassembler finds it by.
		Assert.Contains("\t// loop start (head: IL_000F)", lines);
		Assert.Contains("\t// end loop", lines);
		// Every instruction: its file offset and bytes, then the label, the opcode and the operand ten columns on.
		Assert.Matches(@"^\t/\* 0x[0-9A-F]{8} 2A {11}\*/ IL_001C: ret$", LineWith(document, "IL_001C:"));
		Assert.Matches(@"IL_0005: br\.s {6}IL_000F$", LineWith(document, "IL_0005:"));
	}

	[Fact]
	public async Task WritesTryBlocksAndTheirHandlers() {
		var document = await MethodAsync("ThrowAndCatch");

		var lines = LinesOf(document);
		Assert.Contains("\t.try", lines);
		Assert.Contains("\t} // end .try", lines);
		Assert.Contains("\tcatch [System.Runtime]System.InvalidOperationException", lines);
		Assert.Contains("\t} // end handler", lines);
		Assert.Equal(["try", "catch", "method"], document.BlockStructures!.Select(block => block.Kind).ToArray());
		// The instructions inside a block are indented one more level.
		Assert.StartsWith("\t\t/* ", LineWith(document, "IL_0002:"), StringComparison.Ordinal);
		// The method's line separator is under the line its closing brace is on.
		var method = document.BlockStructures![^1];
		var separator = Assert.Single(document.LineSeparators!);
		Assert.Equal(document.Text[..method.End].Count(ch => ch == '\n'), document.Text[..separator].Count(ch => ch == '\n'));
	}

	[Fact]
	public async Task TokenAndRvaCommentsFollowTheirSetting() {
		var on = await MethodAsync("Calculate", il: new ILDecompilerSettingsDto(ShowILBytes: false, ShowPdbInfo: false));
		Assert.Contains("// Token: 0x", on.Text, StringComparison.Ordinal);
		Assert.Contains("// Code Size: 29 (0x1D) bytes", on.Text, StringComparison.Ordinal);
		Assert.Contains("// LocalVarSig Token: 0x11", on.Text, StringComparison.Ordinal);
		Assert.Matches(@"^\t/\* 0x[0-9A-F]{8} \*/ IL_001C: ret$", LineWith(on, "IL_001C:"));

		var off = await MethodAsync("Calculate", il: new ILDecompilerSettingsDto(ShowTokenAndRvaComments: false, ShowILBytes: false, ShowPdbInfo: false));
		Assert.DoesNotContain("// Token:", off.Text, StringComparison.Ordinal);
		Assert.DoesNotContain("// Header Size", off.Text, StringComparison.Ordinal);
		Assert.DoesNotContain("/*", off.Text, StringComparison.Ordinal);
		Assert.Equal("\tIL_001C: ret", LineWith(off, "IL_001C:"));
		Assert.DoesNotContain(off.Spans, span => span.Address is not null);
	}

	[Fact]
	public async Task IlBytesFollowTheirSetting() {
		var bytes = await MethodAsync("Calculate", il: new ILDecompilerSettingsDto(ShowTokenAndRvaComments: false, ShowPdbInfo: false));
		// The bytes are padded to six, the longest common instruction.
		Assert.Equal("\t/* 2A           */ IL_001C: ret", LineWith(bytes, "IL_001C:"));
		Assert.Equal("\t/* 2B08         */ IL_0005: br.s      IL_000F", LineWith(bytes, "IL_0005:"));
	}

	[Fact]
	public async Task PdbInfoFollowsItsSetting() {
		var on = await MethodAsync("Calculate", il: new ILDecompilerSettingsDto(ShowTokenAndRvaComments: false, ShowILBytes: false));
		Assert.Contains(LinesOf(on), line => line.StartsWith("\t/* (", StringComparison.Ordinal) && line.EndsWith("Program.cs */", StringComparison.Ordinal));
		Assert.Contains("/* (hidden)-(hidden) ", on.Text, StringComparison.Ordinal);

		var off = await MethodAsync("Calculate", il: new ILDecompilerSettingsDto(ShowTokenAndRvaComments: false, ShowILBytes: false, ShowPdbInfo: false));
		Assert.DoesNotContain("/* (", off.Text, StringComparison.Ordinal);
		// The statements are the instructions' whatever the comments above them.
		Assert.Equal(on.CodeStatements!.Select(statement => statement.IlOffset), off.CodeStatements!.Select(statement => statement.IlOffset));
	}

	[Fact]
	public async Task IlCommentsFollowTheirSetting() {
		var off = await MethodAsync("Calculate", il: new ILDecompilerSettingsDto(ShowTokenAndRvaComments: false, ShowILBytes: false, ShowPdbInfo: false));
		Assert.Equal("\tIL_001C: ret", LineWith(off, "IL_001C:"));

		var (workspaceId, _) = await OpenAsync("DebugTarget.Program");
		var info = await manager.GetQuickInfoAsync(new DocumentQuickInfoRequest(workspaceId, OpCode: "ret"), Token);
		var on = await MethodAsync("Calculate", il: new ILDecompilerSettingsDto(ShowTokenAndRvaComments: false, ShowILBytes: false, ShowPdbInfo: false, ShowILComments: true));
		var ret = LineWith(on, "IL_001C:");
		// The comment is the framework's documentation of the opcode, which this machine may not have.
		var summary = string.Concat(info.Parts.Select(part => part.Text)).Split(" - ", 2) is [_, var text] ? text : null;
		if (summary is null)
			Assert.Equal("\tIL_001C: ret", ret);
		else
			Assert.Equal("\tIL_001C: ret\t// " + summary, ret);
	}

	[Fact]
	public async Task HexadecimalNumbersFollowTheirSetting() {
		var decimalNumbers = await MethodAsync("Evaluate", il: new ILDecompilerSettingsDto(ShowTokenAndRvaComments: false, ShowILBytes: false, ShowPdbInfo: false));
		Assert.Contains(LinesOf(decimalNumbers), line => line.EndsWith("ldc.i4.s  125", StringComparison.Ordinal));
		Assert.Contains(LinesOf(decimalNumbers), line => line.EndsWith("ldc.i4.s  9", StringComparison.Ordinal));

		var hex = await MethodAsync("Evaluate", il: new ILDecompilerSettingsDto(ShowTokenAndRvaComments: false, ShowILBytes: false, ShowPdbInfo: false, HexadecimalNumbers: true));
		Assert.Contains(LinesOf(hex), line => line.EndsWith("ldc.i4.s  0x7D", StringComparison.Ordinal));
		// A number up to nine stays a digit.
		Assert.Contains(LinesOf(hex), line => line.EndsWith("ldc.i4.s  9", StringComparison.Ordinal));
	}

	[Fact]
	public async Task SortMembersFollowsItsSetting() {
		var (workspaceId, nodeId) = await OpenAsync("DebugTarget.Program");
		int IndexOfDefinition(DecompileResponse document, string name) =>
			document.Spans.First(span => span.Kind == "definition" && span.LocalId is null && TextOf(document, span) == name).Start;

		var metadataOrder = await DecompileAsync(workspaceId, nodeId, il: new ILDecompilerSettingsDto(ShowTokenAndRvaComments: false, ShowILBytes: false, ShowPdbInfo: false));
		Assert.True(IndexOfDefinition(metadataOrder, "Main") < IndexOfDefinition(metadataOrder, "Calculate"));

		var sorted = await DecompileAsync(workspaceId, nodeId, il: new ILDecompilerSettingsDto(ShowTokenAndRvaComments: false, ShowILBytes: false, ShowPdbInfo: false, SortMembers: true));
		Assert.True(IndexOfDefinition(sorted, "Calculate") < IndexOfDefinition(sorted, "Main"));
	}

	[Fact]
	public async Task XmlDocumentationFollowsItsSetting() {
		// A copy of the fixture with documentation beside it, the way a build that generates it leaves them.
		var directory = Path.Combine(Path.GetTempPath(), "dnspy-il-xmldoc-" + Guid.NewGuid().ToString("N"));
		Directory.CreateDirectory(directory);
		temporaryDirectories.Add(directory);
		var path = Path.Combine(directory, "DebugTarget.dll");
		File.Copy(DebugTargetPath, path);
		File.WriteAllText(Path.ChangeExtension(path, ".xml"), """
			<?xml version="1.0"?>
			<doc>
			    <assembly><name>DebugTarget</name></assembly>
			    <members>
			        <member name="M:DebugTarget.Program.Calculate(System.Int32,System.Int32)">
			            <summary>
			            Adds <paramref name="left"/> to itself.
			            </summary>
			            <param name="left">The value.</param>
			        </member>
			    </members>
			</doc>
			""");
		var (workspaceId, nodeId) = await OpenAsync("DebugTarget.Program", "Calculate", path);

		var on = await DecompileAsync(workspaceId, nodeId, il: new ILDecompilerSettingsDto(ShowTokenAndRvaComments: false));
		var lines = LinesOf(on);
		Assert.Equal("/// <summary>", lines[0]);
		// The documentation is the member element's inner XML as an XML reader writes it back, the way dnSpy reads it.
		Assert.Equal("/// Adds <paramref name=\"left\" /> to itself.", lines[1]);
		Assert.Equal("/// </summary>", lines[2]);
		Assert.Equal("/// <param name=\"left\">The value.</param>", lines[3]);
		Assert.StartsWith(".method", lines[4], StringComparison.Ordinal);

		var off = await DecompileAsync(workspaceId, nodeId, il: new ILDecompilerSettingsDto(ShowTokenAndRvaComments: false, ShowXmlDocumentation: false));
		Assert.DoesNotContain("///", off.Text, StringComparison.Ordinal);
	}

	[Fact]
	public async Task AnAssemblyIsItsLocationEntryPointAndHeader() {
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([DebugTargetPath]), Token);
		var root = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), Token)).Nodes);

		var document = await DecompileAsync(opened.WorkspaceId, root.Id);

		var lines = LinesOf(document);
		Assert.Equal("// " + DebugTargetPath, lines[0]);
		Assert.Equal("// Entry point: DebugTarget.Program.Main", lines[1]);
		Assert.Equal("", lines[2]);
		Assert.Equal(".assembly DebugTarget", lines[3]);
		Assert.Equal("{", lines[4]);
		Assert.Contains(lines, line => line.StartsWith("\t.custom instance void [System.Runtime]System.Runtime.CompilerServices.CompilationRelaxationsAttribute::.ctor(int32) = (", StringComparison.Ordinal));
		Assert.Contains("\t.hash algorithm 32772 // SHA1", lines);
		Assert.Contains("\t.ver 1:0:0:0", lines);
		// The entry point names each part of itself.
		var main = Assert.Single(document.Spans, span => span.Start < lines[0].Length + lines[1].Length + 2 && TextOf(document, span) == "Main");
		Assert.NotNull(main.TargetNodeId);
	}

	[Fact]
	public async Task AModuleIsItsLocationEntryPointAndHeader() {
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([DebugTargetPath]), Token);
		var root = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), Token)).Nodes);
		var module = Assert.Single((await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, root.Id), Token)).Nodes, node => node.Kind == "module");

		var document = await DecompileAsync(opened.WorkspaceId, module.Id);

		var lines = LinesOf(document);
		Assert.Equal("// " + DebugTargetPath, lines[0]);
		Assert.Equal("// Entry point: DebugTarget.Program.Main", lines[1]);
		Assert.Equal(["", ""], lines[2..4]);
		Assert.Equal(".module DebugTarget.dll", lines[4]);
		Assert.Matches(@"^// MVID: \{[0-9A-F-]{36}\}$", lines[5]);
		Assert.Contains(lines, line => line.StartsWith(".imagebase ", StringComparison.Ordinal));
		Assert.Contains(lines, line => line.StartsWith(".file alignment ", StringComparison.Ordinal));
		Assert.Contains(lines, line => line.StartsWith(".corflags 1 // ILOnly", StringComparison.Ordinal));
	}

	[Fact]
	public async Task ANamespaceListsItsTypes() {
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([DebugTargetPath]), Token);
		var root = Assert.Single((await manager.GetRootsAsync(new WorkspaceRequest(opened.WorkspaceId), Token)).Nodes);
		var module = Assert.Single((await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, root.Id), Token)).Nodes, node => node.Kind == "module");
		var @namespace = Assert.Single((await manager.GetChildrenAsync(new NodeRequest(opened.WorkspaceId, module.Id), Token)).Nodes, node => node.Kind == "namespace" && node.Label == "DebugTarget");

		foreach (var language in new[] { DecompilerLanguage.IL, DecompilerLanguage.ILWithCSharp }) {
			var document = await DecompileAsync(opened.WorkspaceId, @namespace.Id, language);

			var lines = LinesOf(document);
			Assert.Equal(["// DebugTarget", "// ", "// Types:", "// "], lines[..4]);
			Assert.Contains("// Program", lines);
			Assert.DoesNotContain(".class", document.Text, StringComparison.Ordinal);
			var program = Assert.Single(document.Spans, span => TextOf(document, span) == "Program");
			Assert.Equal((await manager.FindMemberAsync(new FindMemberRequest(opened.WorkspaceId, DebugTargetPath, TokenOf("DebugTarget.Program")), Token)).NodeId, program.TargetNodeId);
		}
	}

	[Fact]
	public async Task IlWithCSharpWritesEachStatementAboveItsFirstInstruction() {
		var document = await MethodAsync("Calculate", DecompilerLanguage.ILWithCSharp, new ILDecompilerSettingsDto(ShowTokenAndRvaComments: false, ShowILBytes: false, ShowPdbInfo: false));

		var lines = LinesOf(document);
		var assignment = Array.IndexOf(lines, "\t// \tint num = 0;");
		Assert.True(assignment > 0, document.Text);
		Assert.Equal(["", "\tIL_0001: ldc.i4.0"], lines[(assignment + 1)..(assignment + 3)]);
		// A statement that is only part of its line is pointed at under it.
		var forInitializer = Array.IndexOf(lines, "\t// \tfor (int i = 0; i < right; i++)");
		Assert.True(forInitializer > 0, document.Text);
		Assert.Equal("\t//       ^^^^^^^^^", lines[forInitializer + 1]);
		Assert.Equal("\tIL_0003: ldc.i4.0", lines[forInitializer + 3]);
		// The statement after the loop is written above its own code, not above the loop's condition.
		Assert.Equal("\tIL_0017: ldloc.0", lines[Array.IndexOf(lines, "\t// \treturn num;") + 2]);
		// The C# lines are comments: the statements are still one per instruction.
		using var module = ModuleDefMD.Load(DebugTargetPath);
		Assert.Equal(LoadMethod(module, "Calculate").Body.Instructions.Count, document.CodeStatements!.Count);
	}

	[Fact]
	public async Task IlWithCSharpShowsAStateMachineAsTheMethodItWasWrittenAs() {
		using var module = ModuleDefMD.Load(DebugTargetPath);
		var stateMachine = module.Find("DebugTarget.Program", isReflectionName: true)!.NestedTypes.Single(type => type.Name.String.Contains("AddAsync", StringComparison.Ordinal));
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([DebugTargetPath]), Token);
		var found = await manager.FindMemberAsync(new FindMemberRequest(opened.WorkspaceId, DebugTargetPath, unchecked((int)stateMachine.FindMethod("MoveNext").MDToken.Raw)), Token);

		var document = await DecompileAsync(opened.WorkspaceId, found.NodeId!, DecompilerLanguage.ILWithCSharp);

		Assert.Contains("// \tawait System.Threading.Tasks.Task.Yield();", document.Text, StringComparison.Ordinal);
		Assert.Contains("// \tint sum = left + right;", document.Text, StringComparison.Ordinal);
	}

	[Fact]
	public async Task LabelsTieABranchToItsTarget() {
		var document = await MethodAsync("Calculate", il: new ILDecompilerSettingsDto(ShowTokenAndRvaComments: false, ShowILBytes: false, ShowPdbInfo: false));

		var labels = document.Spans.Where(span => TextOf(document, span) == "IL_000F").ToArray();
		var definition = Assert.Single(labels, span => span.Kind == "definition");
		Assert.Equal(TextColors.Label, definition.Color);
		Assert.NotNull(definition.LocalId);
		// The branch and the loop comment both name it.
		Assert.Equal(2, labels.Count(span => span.Kind == "reference" && span.LocalId == definition.LocalId));
		// Every instruction's label is its own definition, at the start of its statement.
		Assert.All(document.CodeStatements!, statement => {
			var line = LinesOf(document)[statement.StartLine - 1];
			Assert.StartsWith($"IL_{statement.IlOffset:X4}", line[(statement.StartColumn - 1)..], StringComparison.Ordinal);
		});
		// A local is written by its name and tied to its declaration.
		var locals = document.Spans.Where(span => span.LocalId is not null && TextOf(document, span) == "sum").ToArray();
		Assert.Contains(locals, span => span.Kind == "definition");
	}

	[Fact]
	public async Task TokenAndAddressCommentsAreReferences() {
		var (workspaceId, nodeId) = await OpenAsync("DebugTarget.Program", "Calculate");
		var document = await DecompileAsync(workspaceId, nodeId, il: new ILDecompilerSettingsDto(ShowPdbInfo: false));
		using var module = ModuleDefMD.Load(DebugTargetPath);
		var calculate = LoadMethod(module, "Calculate");

		// The token names the method it is the token of.
		var token = Assert.Single(document.Spans, span => TextOf(document, span) == $"0x{calculate.MDToken.Raw:X8}");
		Assert.Equal(nodeId, token.TargetNodeId);
		Assert.Equal(TextColors.Comment, token.Color);
		// The RVA and the file offset are addresses the hex editor opens at.
		var rva = Assert.Single(document.Spans, span => span.Address is { IsRva: true });
		Assert.Equal((long)(uint)calculate.RVA, rva.Address!.Address);
		Assert.Equal(DebugTargetPath, rva.Address.ModulePath);
		var fileOffset = (long)(uint)module.Metadata.PEImage.ToFileOffset(calculate.RVA);
		Assert.Contains(document.Spans, span => span.Address is { IsRva: false } address && address.Address == fileOffset);
		// An instruction's offset covers the instruction's bytes.
		var ret = calculate.Body.Instructions[^1];
		var retOffset = fileOffset + calculate.Body.HeaderSize + ret.Offset;
		var retAddress = Assert.Single(document.Spans, span => span.Address is { IsRva: false } address && address.Address == retOffset);
		Assert.Equal(ret.GetSize(), retAddress.Address!.Length);
		Assert.Equal($"0x{retOffset:X8}", TextOf(document, retAddress));
	}

	public void Dispose() {
		manager.Dispose();
		foreach (var directory in temporaryDirectories) {
			try {
				Directory.Delete(directory, recursive: true);
			}
			catch (IOException) {
			}
			catch (UnauthorizedAccessException) {
			}
		}
	}
}
