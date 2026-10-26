using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using dnlib.DotNet;
using dnlib.DotNet.Resources;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using dnSpy.Backend.Core.Baml;
using dnSpy.Backend.Core.Output;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// dnSpy's "Disassemble BAML" (BamlDisassembler): a BAML resource written as the listing of its records, one line
/// per record, every record inside an element indented one level deeper than the element.
/// </summary>
public sealed class BamlDisassemblerTests {
	// BamlNode.IsHeader / IsFooter / IsMatchHeaderAndFooter: the records that open and close a level.
	static readonly Dictionary<string, string> FooterOfHeader = new() {
		["ConstructorParametersStart"] = "ConstructorParametersEnd",
		["DocumentStart"] = "DocumentEnd",
		["ElementStart"] = "ElementEnd",
		["NamedElementStart"] = "ElementEnd",
		["KeyElementStart"] = "KeyElementEnd",
		["PropertyArrayStart"] = "PropertyArrayEnd",
		["PropertyComplexStart"] = "PropertyComplexEnd",
		["PropertyDictionaryStart"] = "PropertyDictionaryEnd",
		["PropertyListStart"] = "PropertyListEnd",
		["StaticResourceStart"] = "StaticResourceEnd",
	};

	static bool IsHeader(string record) => FooterOfHeader.ContainsKey(record);

	static bool IsFooter(string record) => FooterOfHeader.ContainsValue(record);

	static CancellationToken Token => TestContext.Current.CancellationToken;

	static string BamlTargetPath => Path.GetFullPath(Path.Combine(
		AppContext.BaseDirectory, "..", "..", "..", "..", "BamlTarget", "bin", TestConfiguration, "net10.0-windows", "BamlTarget.dll"));

	static string TestConfiguration => new DirectoryInfo(AppContext.BaseDirectory).Parent?.Name
		?? throw new InvalidOperationException("Could not determine the test configuration.");

	static ModuleDefMD LoadBamlTarget() {
		var path = BamlTargetPath;
		Assert.True(File.Exists(path), $"BAML fixture was not built: {path}");
		return ModuleDefMD.Load(path, ModuleDef.CreateModuleContext());
	}

	/// <summary>The .baml entry of the fixture's .g.resources, the way dnSpy's BamlResourceNodeProvider reads it.</summary>
	static byte[] ReadBaml(ModuleDef module) {
		var resources = (EmbeddedResource)Assert.Single(module.Resources, resource => resource.Name.String.EndsWith(".g.resources", StringComparison.OrdinalIgnoreCase));
		var set = ResourceReader.Read(module, resources.CreateReader());
		var element = Assert.Single(set.ResourceElements, element => element.Name.EndsWith(".baml", StringComparison.OrdinalIgnoreCase));
		return Assert.IsType<byte[]>(Assert.IsType<BuiltInResourceData>(element.ResourceData).Data);
	}

	static DocumentOutput Disassemble() {
		using var module = LoadBamlTarget();
		var output = new DocumentOutput();
		BamlDisassemblerEntry.Disassemble(module, ReadBaml(module), output, Token);
		return output;
	}

	static string[] LinesOf(DocumentOutput output) => output.ToString().Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');

	static string RecordName(string line) => line.TrimStart('\t').Split(' ')[0];

	static int Indentation(string line) => line.Length - line.TrimStart('\t').Length;

	/// <summary>The record lines: everything after the header's blank line, without the final line break.</summary>
	static string[] RecordLines(string[] lines) {
		var blank = Array.IndexOf(lines, "");
		Assert.True(blank > 0);
		var records = lines[(blank + 1)..];
		Assert.Equal("", records[^1]);
		return records[..^1];
	}

	[Fact]
	public void WritesTheHeaderAndThenOneLinePerRecord() {
		var lines = LinesOf(Disassemble());

		Assert.Equal("Signature:      \t\"MSBAML\"", lines[0]);
		Assert.Equal("Reader Version: \t[0x0000, 0x0060]", lines[1]);
		Assert.Equal("Updater Version:\t[0x0000, 0x0060]", lines[2]);
		Assert.Equal("Writer Version: \t[0x0000, 0x0060]", lines[3]);
		var count = Regex.Match(lines[4], @"^Record #:       \t(\d+)$");
		Assert.True(count.Success, lines[4]);
		Assert.Equal("", lines[5]);

		var records = RecordLines(lines);
		Assert.Equal(int.Parse(count.Groups[1].Value, CultureInfo.InvariantCulture), records.Length);
		Assert.Matches(@"^DocumentStart \[LoadAsync=false, MaxAsyncRecords=0x[0-9a-f]{8}, DebugBaml=(true|false)\]$", records[0]);
		Assert.Equal("DocumentEnd", records[^1]);
	}

	[Fact]
	public void WritesEveryRecordWithItsFields() {
		var records = RecordLines(LinesOf(Disassemble()));

		Assert.Contains("\tAssemblyInfo [AssemblyId=0x0000, AssemblyFullName=\"BamlTarget\"]", records);
		Assert.Contains("\tTypeInfo [TypeId=0x0000, AssemblyId=0x0000, TypeFullName=\"BamlTarget.SampleView\"]", records);
		// The root element is the type the XAML defines; flags are written as a number when there are none.
		Assert.Contains("\tElementStart [TypeId=0x0000, Flags=0x00]", records);
		Assert.Contains(records, line => Regex.IsMatch(line,
			@"^\t+AssemblyInfo \[AssemblyId=0x[0-9a-f]{4}, AssemblyFullName=""PresentationFramework, Version=[0-9.]+, Culture=neutral, PublicKeyToken=31bf3856ad364e35""\]$"));
		Assert.Contains(records, line => Regex.IsMatch(line,
			@"^\t+XmlnsProperty \[Prefix="""", XmlNamespace=""http://schemas\.microsoft\.com/winfx/2006/xaml/presentation"", AssemblyIds=\{0x[0-9a-f]{4}(, 0x[0-9a-f]{4})*\}\]$"));
		Assert.Contains(records, line => Regex.IsMatch(line,
			@"^\t+XmlnsProperty \[Prefix=""x"", XmlNamespace=""http://schemas\.microsoft\.com/winfx/2006/xaml"", AssemblyIds=\{0x[0-9a-f]{4}(, 0x[0-9a-f]{4})*\}\]$"));
		// Button's Name="sampleButton": a known attribute set through a known converter, both written as their ids.
		Assert.Contains(records, line => Regex.IsMatch(line,
			@"^\t+PropertyWithConverter \[AttributeId=0x[0-9a-f]{4}, Value=""sampleButton"", ConverterTypeId=0x[0-9a-f]{4}\]$"));
		Assert.Contains(records, line => Regex.IsMatch(line, @"^\t+ContentProperty \[AttributeId=0x[0-9a-f]{4}\]$"));
		// A record without fields is its name alone.
		Assert.Contains(records, line => line.TrimStart('\t') == "ElementEnd");
	}

	[Fact]
	public void EveryRecordInsideAnElementIsIndentedOneLevelDeeper() {
		var records = RecordLines(LinesOf(Disassemble()));
		var open = new Stack<string>();

		foreach (var line in records) {
			var name = RecordName(line);
			if (IsFooter(name)) {
				// The footer goes back to the level of its header.
				var header = open.Pop();
				Assert.Equal(FooterOfHeader[RecordName(header)], name);
				Assert.Equal(Indentation(header), Indentation(line));
			}
			else
				Assert.Equal(open.Count, Indentation(line));
			if (IsHeader(name))
				open.Push(line);
		}
		Assert.Empty(open);
		// UserControl > Grid > Button.
		Assert.Contains(records, line => Indentation(line) == 4);
	}

	[Fact]
	public void EachHeaderAndItsFooterAreABlock() {
		var output = Disassemble();
		var text = output.ToString();
		var headers = RecordLines(LinesOf(output)).Count(line => IsHeader(RecordName(line)));

		// The [ ] around the fields and the quotes are brace pairs without a block; only the records make blocks.
		Assert.Equal(headers, output.BlockStructures.Count);
		Assert.All(output.BlockStructures, block => {
			Assert.Equal("other", block.Kind);
			Assert.Equal(FooterOfHeader[RecordAt(text, block.Start)], RecordAt(text, block.End));
		});
		var document = Assert.Single(output.BlockStructures, block => RecordAt(text, block.Start) == "DocumentStart");
		Assert.Equal(text.IndexOf("DocumentStart", StringComparison.Ordinal), document.Start);
		Assert.Equal(text.LastIndexOf("DocumentEnd", StringComparison.Ordinal), document.End);
	}

	static string RecordAt(string text, int position) {
		var end = position;
		while (end < text.Length && char.IsAsciiLetter(text[end]))
			end++;
		return text[position..end];
	}

	[Fact]
	public void RecordNamesAndIdsAreReferencesInsideTheDocument() {
		var output = Disassemble();
		var text = output.ToString();
		var spans = output.Spans;

		TextSpanDto SpanAt(int position) => Assert.Single(spans, span => span.Start == position);
		int After(string line, string field) {
			var lineStart = text.IndexOf(line, StringComparison.Ordinal);
			Assert.True(lineStart >= 0, line);
			return lineStart + line.IndexOf(field, StringComparison.Ordinal) + field.Length;
		}

		// Every record name defines its record, which a DefAttributeKeyType or a DeferableContentStart refers to.
		var recordNames = 0;
		var position = text.IndexOf("DocumentStart", StringComparison.Ordinal);
		foreach (var line in RecordLines(LinesOf(output))) {
			var span = SpanAt(position + Indentation(line));
			Assert.Equal("definition", span.Kind);
			Assert.Equal(BoxedTextColor.Keyword, span.Color);
			Assert.Equal(RecordName(line).Length, span.Length);
			Assert.NotNull(span.LocalId);
			recordNames++;
			position += line.Length + Environment.NewLine.Length;
		}
		Assert.True(recordNames > 10);

		// The ids a TypeInfo and an AssemblyInfo define are the ids the records after them refer to.
		const string assemblyInfo = "AssemblyInfo [AssemblyId=0x0000, AssemblyFullName=\"BamlTarget\"]";
		const string typeInfo = "TypeInfo [TypeId=0x0000, AssemblyId=0x0000, TypeFullName=\"BamlTarget.SampleView\"]";
		const string elementStart = "ElementStart [TypeId=0x0000, Flags=0x00]";
		var assemblyDefinition = SpanAt(After(assemblyInfo, "AssemblyId="));
		var assemblyReference = SpanAt(After(typeInfo, "AssemblyId="));
		var typeDefinition = SpanAt(After(typeInfo, "TypeId="));
		var typeReference = SpanAt(After(elementStart, "TypeId="));
		Assert.Equal(("definition", "reference"), (assemblyDefinition.Kind, assemblyReference.Kind));
		Assert.Equal(assemblyDefinition.LocalId, assemblyReference.LocalId);
		Assert.Equal(("definition", "reference"), (typeDefinition.Kind, typeReference.Kind));
		Assert.Equal(typeDefinition.LocalId, typeReference.LocalId);
		Assert.NotEqual(assemblyDefinition.LocalId, typeDefinition.LocalId);
		Assert.All([assemblyDefinition, typeDefinition], span => Assert.Equal((6, BoxedTextColor.Number), (span.Length, span.Color)));
	}

	/// <summary>The listing with dnSpy's BAML tooltip provider behind it — the one a tab shows.</summary>
	static (DocumentOutput Output, string Text) DisassembleWithToolTips(DecompilerLanguage language = DecompilerLanguage.CSharp) {
		using var module = LoadBamlTarget();
		var output = new DocumentOutput(localToolTip: new BamlToolTipProvider(language, _ => TextColors.Type).Create);
		BamlDisassemblerEntry.Disassemble(module, ReadBaml(module), output, Token);
		return (output, output.ToString());
	}

	static string SpanText(string text, TextSpanDto span) => text.Substring(span.Start, span.Length);

	static string ToolTipText(TextSpanDto span) => string.Concat(span.ToolTip?.Select(part => part.Text) ?? []);

	static TextSpanDto ToolTipSpan(DocumentOutput output, Func<TextSpanDto, bool> predicate) {
		var matches = output.Spans.Where(span => span.ToolTip is not null && predicate(span)).ToList();
		Assert.True(matches.Count > 0, "No tooltip: " + string.Join(" | ", output.Spans.Where(span => span.ToolTip is not null)
			.Select(span => $"{span.ToolTipImage}:{string.Concat(span.ToolTip!.Select(part => part.Text))}")));
		return matches[0];
	}

	[Fact]
	public void ToolTipsNameWhatEachReferenceStandsFor() {
		var (output, text) = DisassembleWithToolTips();

		// An assembly id shows the assembly's full name.
		var assembly = ToolTipSpan(output, span => span.ToolTipImage == DotNetImages.Assembly && ToolTipText(span).StartsWith("BamlTarget", StringComparison.Ordinal));
		Assert.Equal("0x0000", SpanText(text, assembly));

		// A type id shows the type in the document's language — with its namespace, as dnSpy writes a type.
		var type = ToolTipSpan(output, span => span.ToolTipImage == DotNetImages.ClassPublic && ToolTipText(span).Contains("SampleView", StringComparison.Ordinal));
		Assert.Equal("BamlTarget.SampleView", ToolTipText(type));
		Assert.Equal(BoxedTextColor.Number, type.Color);

		// A string id shows the string literal, in the string color, with the string image. The fixture holds no
		// string ids — its strings are written inline — so that half of the provider is checked directly below.
		var stringReference = new BamlToolTipProvider(DecompilerLanguage.CSharp, _ => TextColors.Type)
			.Create(BamlStringReference.Create("\"Sample\""));
		Assert.NotNull(stringReference);
		Assert.Equal("String", stringReference.Value.Image);
		Assert.StartsWith("\"", Assert.Single(stringReference.Value.Parts).Text, StringComparison.Ordinal);
		Assert.Equal(TextColors.String, Assert.Single(stringReference.Value.Parts).Color);

		// A member id shows its declaring type and name, with the property image.
		var member = ToolTipSpan(output, span => span.ToolTipImage == DotNetImages.Property && span.ToolTip![^1].Color == TextColors.InstanceProperty);
		Assert.True(member.ToolTip!.Count >= 3);
		Assert.Equal((TextColors.Punctuation, "."), (member.ToolTip![^2].Color, member.ToolTip![^2].Text));
		Assert.Equal(TextColors.InstanceProperty, member.ToolTip![^1].Color);

		// A record name shows the record's type and, on a second line, its position.
		var record = ToolTipSpan(output, span => span.Color == BoxedTextColor.Keyword && span.ToolTipImage is "");
		Assert.Equal(SpanText(text, record), record.ToolTip![0].Text);
		Assert.Contains("Position: 0x", ToolTipText(record), StringComparison.Ordinal);
	}

	[Fact]
	public void KnownTypesAreNamedEvenWithoutTheWpfAssembliesInstalled() {
		var (output, text) = DisassembleWithToolTips();

		// A known WPF type's id has no TypeInfo record: its name comes from the BAML tables, and it is still a
		// reference, so its tooltip and its tie to the other records keep working here, where WPF is not installed.
		var known = ToolTipSpan(output, span => span.Color == BoxedTextColor.Number
			&& span.ToolTipImage == DotNetImages.ClassPublic
			&& Convert.ToInt32(SpanText(text, span)[2..], 16) > 0x7fff);
		Assert.Contains(".", ToolTipText(known), StringComparison.Ordinal);
		Assert.NotNull(known.LocalId);
	}

	[Fact]
	public void ToolTipsUseTheLanguageOfTheDocument() {
		string TypeNameOf(DecompilerLanguage language) =>
			ToolTipText(ToolTipSpan(DisassembleWithToolTips(language).Output,
				span => span.ToolTipImage == DotNetImages.ClassPublic && ToolTipText(span).Contains("SampleView", StringComparison.Ordinal)));

		Assert.Equal("BamlTarget.SampleView", TypeNameOf(DecompilerLanguage.CSharp));
		Assert.Equal("BamlTarget.SampleView", TypeNameOf(DecompilerLanguage.VisualBasic));
		Assert.StartsWith("class ", TypeNameOf(DecompilerLanguage.IL), StringComparison.Ordinal);
	}

	[Fact]
	public void ACanceledTokenStopsTheListing() {		using var module = LoadBamlTarget();
		var baml = ReadBaml(module);
		using var canceled = new CancellationTokenSource();
		canceled.Cancel();

		Assert.ThrowsAny<OperationCanceledException>(() => BamlDisassemblerEntry.Disassemble(module, baml, new DocumentOutput(), canceled.Token));
	}

	[Fact]
	public void DataWithoutTheBamlSignatureIsNotSupported() {
		using var module = LoadBamlTarget();
		using var stream = new MemoryStream();
		using (var writer = new BinaryWriter(stream, Encoding.Unicode, leaveOpen: true)) {
			writer.Write((uint)("NOBAML".Length * 2));
			writer.Write("NOBAML".ToCharArray());
		}

		Assert.Throws<NotSupportedException>(() => BamlDisassemblerEntry.Disassemble(module, stream.ToArray(), new DocumentOutput(), Token));
	}
}
