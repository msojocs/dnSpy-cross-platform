using System.Globalization;
using System.Text;
using dnlib.DotNet;
using dnlib.DotNet.Resources;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The documents of resource rows, the way dnSpy's resource nodes write them (WriteShort): a manifest resource's
/// line, a .resources file's line and the lines of its entries, the values written the way SimpleTypeConverter
/// writes them, the file offsets the "Show tokens, RVAs and file offsets" option adds, and the pictures and Save
/// buttons dnSpy puts into the text, which travel beside it as attachments.
/// </summary>
public sealed class WorkspaceResourceDocumentTests : IDisposable {
	readonly WorkspaceManager manager = new();

	// A 1×1 PNG.
	static readonly byte[] png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==");

	[Fact]
	public async Task WritesEveryEntryValueTheWayDnSpyFormatsIt() {
		var opened = await OpenAsync();
		var resources = await FindResourcesFolderAsync(opened.WorkspaceId);
		var created = await CreateResourcesFileAsync(opened.WorkspaceId, resources.Id, "values.resources",
			(ResourceElementKinds.String, "text", "a\tb\"c", null),
			(ResourceElementKinds.Boolean, "flag", "true", null),
			(ResourceElementKinds.Char, "letter", "x", null),
			(ResourceElementKinds.Int32, "small", "7", null),
			(ResourceElementKinds.Int32, "answer", "42", null),
			(ResourceElementKinds.Int32, "negative", "-42", null),
			(ResourceElementKinds.UInt64, "big", "18446744073709551615", null),
			(ResourceElementKinds.Byte, "byte", "255", null),
			(ResourceElementKinds.Double, "ratio", "1.5", null),
			(ResourceElementKinds.TimeSpan, "span", "01:02:03", null),
			(ResourceElementKinds.Null, "nothing", null, null),
			(ResourceElementKinds.ByteArray, "blob", null, Convert.ToBase64String(new byte[] { 0, 1, 2 })),
			(ResourceElementKinds.Binary, "custom", null, Convert.ToBase64String(new byte[] { 9, 9, 9, 9 })));

		var document = await DecompileAsync(opened.WorkspaceId, created.NodeId, DecompilerLanguage.CSharp);

		var lines = Lines(document.Text);
		Assert.Matches(@"^// values\.resources \(\d+ bytes, Embedded, Public\)$", lines[0]);
		// ResourceElementSetNodeImpl adds the Save button under its line and leaves a blank line after it.
		Assert.Equal(["", ""], lines[1..3]);
		var ratio = 1.5.ToString("R", CultureInfo.CurrentCulture);
		Assert.Equal([
			"// answer = 0x2A",
			"// big = 0xFFFFFFFFFFFFFFFF",
			"// blob = 3 bytes",
			"// byte = 0xFF",
			"// custom = 4 bytes, Type = ",
			"// flag = True",
			"// letter = 'x'",
			"// negative = -0x2A",
			"// nothing = null",
			$"// ratio = {ratio}",
			"// small = 7",
			"// span = 01:02:03",
			"// text = \"a\\tb\\\"c\"",
		], lines[3..]);
		var save = Assert.Single(document.Attachments!);
		Assert.Equal(new DocumentAttachmentDto(1, DocumentAttachmentKinds.SaveButton, NodeId: created.NodeId), save);
		Assert.Equal("csharp", document.Language);

		// Every name is the definition of something the document ties together, in the comment's color.
		var answer = Assert.Single(document.Spans, span => document.Text.Substring(span.Start, span.Length) == "answer");
		Assert.Equal("definition", answer.Kind);
		Assert.NotNull(answer.LocalId);
		Assert.Equal("comment", answer.Color);
		var name = Assert.Single(document.Spans, span => document.Text.Substring(span.Start, span.Length) == "values.resources");
		Assert.Equal("definition", name.Kind);
	}

	[Fact]
	public async Task AnEntryWritesItsLineInTheCommentsOfTheLanguageShown() {
		var opened = await OpenAsync();
		var resources = await FindResourcesFolderAsync(opened.WorkspaceId);
		var created = await CreateResourcesFileAsync(opened.WorkspaceId, resources.Id, "one.resources", (ResourceElementKinds.Int32, "answer", "42", null));
		var entry = Assert.Single(await ChildrenAsync(opened.WorkspaceId, created.NodeId));

		var csharp = await DecompileAsync(opened.WorkspaceId, entry.Id, DecompilerLanguage.CSharp);
		Assert.Equal($"// answer = 0x2A{Environment.NewLine}", csharp.Text);
		Assert.Empty(csharp.Attachments!);
		var visualBasic = await DecompileAsync(opened.WorkspaceId, entry.Id, DecompilerLanguage.VisualBasic);
		Assert.Equal($"' answer = 0x2A{Environment.NewLine}", visualBasic.Text);
		Assert.Equal("visual-basic", visualBasic.Language);
		var il = await DecompileAsync(opened.WorkspaceId, entry.Id, DecompilerLanguage.IL);
		Assert.Equal($"// answer = 0x2A{Environment.NewLine}", il.Text);
		Assert.Equal("il", il.Language);

		// A value that is not a string, an array or a serialized object saves as the text dnSpy shows for it.
		var saved = await manager.GetResourceDataAsync(new ResourceDataRequest(opened.WorkspaceId, entry.Id), TestContext.Current.CancellationToken);
		Assert.Equal([.. Encoding.UTF8.GetPreamble(), .. "0x2A"u8], Convert.FromBase64String(saved.Base64Data));
	}

	[Fact]
	public async Task WritesFileOffsetsWhenTheLanguagesOptionAsksForThem() {
		var path = Path.Combine(AppContext.BaseDirectory, "SearchTarget.dll");
		var opened = await manager.OpenAsync(new OpenWorkspaceRequest([path]), TestContext.Current.CancellationToken);
		var resources = await FindResourcesFolderAsync(opened.WorkspaceId);
		var set = Assert.Single(await ChildrenAsync(opened.WorkspaceId, resources.Id), node => node.Label == "SearchTarget.Strings.resources");
		var entry = Assert.Single(await ChildrenAsync(opened.WorkspaceId, set.Id));

		uint resourceOffset, resourceLength, entryOffset, entryLength;
		using (var module = ModuleDefMD.Load(path)) {
			var embedded = (EmbeddedResource)module.Resources.Single(resource => resource.Name == "SearchTarget.Strings.resources");
			resourceOffset = embedded.CreateReader().StartOffset;
			resourceLength = embedded.Length;
			var element = ResourceReader.Read(module, embedded.CreateReader()).ResourceElements.Single();
			entryOffset = (uint)element.ResourceData.StartOffset;
			entryLength = (uint)element.ResourceData.EndOffset - entryOffset;
		}
		// The offset is where the entry's value is in the file.
		var file = await File.ReadAllBytesAsync(path, TestContext.Current.CancellationToken);
		Assert.Contains("resx-value-needle", Encoding.UTF8.GetString(file, (int)entryOffset, (int)entryLength), StringComparison.Ordinal);

		// Both options are on by default, as dnSpy's are (its ILSpy fork's ShowTokenAndRvaComments and ILSettings').
		var plain = await DecompileAsync(opened.WorkspaceId, set.Id, DecompilerLanguage.CSharp, new DecompilerSettingsDto(CSharp: new CSharpDecompilerSettingsDto(ShowTokenAndRvaComments: false)));
		Assert.Equal([
			$"// SearchTarget.Strings.resources ({resourceLength} bytes, Embedded, Public)",
			"",
			"",
			"// Greeting%20Text = \"resx-value-needle\"",
		], Lines(plain.Text));
		Assert.DoesNotContain(plain.Spans, span => span.Address is not null);

		var withOffsets = await DecompileAsync(opened.WorkspaceId, set.Id, DecompilerLanguage.CSharp);
		var expectedLines = new[] {
			$"// 0x{resourceOffset:X8}: SearchTarget.Strings.resources ({resourceLength} bytes, Embedded, Public)",
			"",
			"",
			$"// 0x{entryOffset:X8}: Greeting%20Text = \"resx-value-needle\"",
		};
		Assert.Equal(expectedLines, Lines(withOffsets.Text));
		var addresses = withOffsets.Spans.Where(span => span.Address is not null).ToList();
		Assert.Equal([$"0x{resourceOffset:X8}", $"0x{entryOffset:X8}"], addresses.Select(span => withOffsets.Text.Substring(span.Start, span.Length)));
		Assert.Equal(new AddressDto(path, false, resourceOffset, resourceLength), addresses[0].Address);
		Assert.Equal(new AddressDto(path, false, entryOffset, entryLength), addresses[1].Address);

		var il = await DecompileAsync(opened.WorkspaceId, set.Id, DecompilerLanguage.IL);
		Assert.Equal(expectedLines, Lines(il.Text));
		var ilOff = await DecompileAsync(opened.WorkspaceId, set.Id, DecompilerLanguage.IL, new DecompilerSettingsDto(IL: new ILDecompilerSettingsDto(ShowTokenAndRvaComments: false)));
		Assert.Equal(Lines(plain.Text), Lines(ilOff.Text));

		// A string entry shows itself: its document is the string, as text (BuiltInResourceElementNodeImpl.Decompile).
		var text = await DecompileAsync(opened.WorkspaceId, entry.Id, DecompilerLanguage.IL);
		Assert.Equal(("plaintext", "resx-value-needle"), (text.Language, text.Text));
	}

	[Fact]
	public async Task ShowsThePicturesOfImageEntriesAndSavesWhatTheyHold() {
		var opened = await OpenAsync();
		var resources = await FindResourcesFolderAsync(opened.WorkspaceId);
		var created = await CreateResourcesFileAsync(opened.WorkspaceId, resources.Id, "images.resources");
		var listData = new byte[] { (byte)'M', (byte)'S', (byte)'F', (byte)'t', 3, 0x49 };
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.QueueCreateResourceElementAsync(
			new CreateResourceElementRequest(opened.WorkspaceId, transaction.TransactionId, created.NodeId, ResourceElementKinds.ImageFiles, string.Empty,
				Images: [new ResourceImageFileDto("dot.png", Convert.ToBase64String(png))]),
			TestContext.Current.CancellationToken);
		await manager.QueueCreateResourceElementAsync(
			new CreateResourceElementRequest(opened.WorkspaceId, transaction.TransactionId, created.NodeId, ResourceElementKinds.ImageListStreamer, "list.ImageStream", Base64Data: Convert.ToBase64String(listData)),
			TestContext.Current.CancellationToken);
		await manager.QueueCreateResourceElementAsync(
			new CreateResourceElementRequest(opened.WorkspaceId, transaction.TransactionId, created.NodeId, ResourceElementKinds.ByteArray, "logo.png", Base64Data: Convert.ToBase64String(png)),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);
		var entries = await ChildrenAsync(opened.WorkspaceId, created.NodeId);

		var document = await DecompileAsync(opened.WorkspaceId, created.NodeId, DecompilerLanguage.CSharp);
		var lines = Lines(document.Text);
		Assert.Equal(6, lines.Length);
		Assert.StartsWith("// dot.png = ", lines[3], StringComparison.Ordinal);
		Assert.EndsWith(", Type = System.Drawing.Bitmap, System.Drawing, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a", lines[3], StringComparison.Ordinal);
		Assert.StartsWith("// list.ImageStream = ", lines[4], StringComparison.Ordinal);
		Assert.EndsWith(", Type = System.Windows.Forms.ImageListStreamer, System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089", lines[4], StringComparison.Ordinal);
		// ImageResourceElementNodeImpl: the picture where the name would go, then " = " and the name.
		Assert.Equal("//  = logo.png", lines[5]);
		// Each picture goes above the line dnSpy puts it on (lines 4, 5 and 6); the Save button under the set's line.
		Assert.Equal([
			new DocumentAttachmentDto(1, DocumentAttachmentKinds.SaveButton, NodeId: created.NodeId),
			new DocumentAttachmentDto(3, DocumentAttachmentKinds.Image, Convert.ToBase64String(png), "image/png"),
			new DocumentAttachmentDto(4, DocumentAttachmentKinds.ImageList, Convert.ToBase64String(listData)),
			new DocumentAttachmentDto(5, DocumentAttachmentKinds.Image, Convert.ToBase64String(png), "image/png"),
		], document.Attachments);

		// An entry's own document is its line, with its picture above it.
		var logo = await DecompileAsync(opened.WorkspaceId, entries.Single(entry => entry.Label == "logo.png").Id, DecompilerLanguage.CSharp);
		Assert.Equal($"//  = logo.png{Environment.NewLine}", logo.Text);
		Assert.Equal([new DocumentAttachmentDto(0, DocumentAttachmentKinds.Image, Convert.ToBase64String(png), "image/png")], logo.Attachments);
		var list = await DecompileAsync(opened.WorkspaceId, entries.Single(entry => entry.Label == "list.ImageStream").Id, DecompilerLanguage.CSharp);
		Assert.Equal([new DocumentAttachmentDto(0, DocumentAttachmentKinds.ImageList, Convert.ToBase64String(listData))], list.Attachments);

		// An image list saves as its "Data" bytes, a serialized image as the image file it holds.
		var savedList = await manager.GetResourceDataAsync(new ResourceDataRequest(opened.WorkspaceId, entries.Single(entry => entry.Label == "list.ImageStream").Id), TestContext.Current.CancellationToken);
		Assert.Equal(listData, Convert.FromBase64String(savedList.Base64Data));
		var savedImage = await manager.GetResourceDataAsync(new ResourceDataRequest(opened.WorkspaceId, entries.Single(entry => entry.Label == "dot.png").Id), TestContext.Current.CancellationToken);
		Assert.Equal(png, Convert.FromBase64String(savedImage.Base64Data));
	}

	[Fact]
	public async Task AnImageListWhoseDataCannotBeReadIsJustASerializedObject() {
		var opened = await OpenAsync();
		var resources = await FindResourcesFolderAsync(opened.WorkspaceId);
		var created = await CreateResourcesFileAsync(opened.WorkspaceId, resources.Id, "broken.resources");
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		await manager.QueueCreateResourceElementAsync(
			new CreateResourceElementRequest(opened.WorkspaceId, transaction.TransactionId, created.NodeId, ResourceElementKinds.Binary, "list.ImageStream", Base64Data: Convert.ToBase64String(new byte[] { 1, 2, 3 })),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);
		var entry = Assert.Single(await ChildrenAsync(opened.WorkspaceId, created.NodeId));

		var document = await DecompileAsync(opened.WorkspaceId, entry.Id, DecompilerLanguage.CSharp);
		Assert.Empty(document.Attachments!);
		Assert.Equal("UserDefinedDataType", entry.Icon);
	}

	[Fact]
	public async Task AManifestResourceWritesItsLineWithItsPictureAndASaveButton() {
		var opened = await OpenAsync();
		var resources = await FindResourcesFolderAsync(opened.WorkspaceId);
		// JPEG bytes without a JPEG name: dnSpy knows a JPEG by its name only, so this is not an image.
		var jpegBytes = new byte[] { 0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 };
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		var picture = await CreateResourceAsync(opened.WorkspaceId, transaction.TransactionId, resources.Id, ResourceCreateKinds.File, "pic.png", Convert.ToBase64String(png));
		var photo = await CreateResourceAsync(opened.WorkspaceId, transaction.TransactionId, resources.Id, ResourceCreateKinds.File, "photo.bin", Convert.ToBase64String(jpegBytes));
		var assemblyLinked = await manager.CreateResourceAsync(
			new CreateResourceRequest(opened.WorkspaceId, transaction.TransactionId, resources.Id, ResourceCreateKinds.AssemblyLinked, "linked.assembly", 2,
				AssemblyFullName: "System.Runtime, Version=10.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a"),
			TestContext.Current.CancellationToken);
		var fileLinked = await manager.CreateResourceAsync(
			new CreateResourceRequest(opened.WorkspaceId, transaction.TransactionId, resources.Id, ResourceCreateKinds.FileLinked, "linked.file", 1, LinkedFileName: "linked.dat"),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var image = await DecompileAsync(opened.WorkspaceId, picture.NodeId, DecompilerLanguage.CSharp);
		Assert.Equal($"// pic.png ({png.Length} bytes, Embedded, Public){Environment.NewLine}{Environment.NewLine}{Environment.NewLine}", image.Text);
		Assert.Equal([
			new DocumentAttachmentDto(0, DocumentAttachmentKinds.Image, Convert.ToBase64String(png), "image/png"),
			new DocumentAttachmentDto(1, DocumentAttachmentKinds.SaveButton, NodeId: picture.NodeId),
		], image.Attachments);

		var binary = await DecompileAsync(opened.WorkspaceId, photo.NodeId, DecompilerLanguage.CSharp);
		Assert.Equal($"// photo.bin ({jpegBytes.Length} bytes, Embedded, Public)", Lines(binary.Text)[0]);
		Assert.Equal([new DocumentAttachmentDto(1, DocumentAttachmentKinds.SaveButton, NodeId: photo.NodeId)], binary.Attachments);

		// A linked resource is an unknown resource to dnSpy, which gives it a Save button too.
		var assembly = await DecompileAsync(opened.WorkspaceId, assemblyLinked.NodeId, DecompilerLanguage.VisualBasic);
		Assert.Equal("' linked.assembly (System.Runtime, Version=10.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a, AssemblyLinked, Private)", Lines(assembly.Text)[0]);
		Assert.EndsWith($"Private){Environment.NewLine}{Environment.NewLine}{Environment.NewLine}", assembly.Text, StringComparison.Ordinal);
		Assert.Equal([new DocumentAttachmentDto(1, DocumentAttachmentKinds.SaveButton, NodeId: assemblyLinked.NodeId)], assembly.Attachments);
		var file = await DecompileAsync(opened.WorkspaceId, fileLinked.NodeId, DecompilerLanguage.CSharp);
		Assert.Equal("// linked.file (linked.dat, ContainsMetaData, , Linked, Public)", Lines(file.Text)[0]);
	}

	[Fact]
	public async Task TextResourcesAreHighlightedOnlyInTheLanguagesDnSpyHasAViewerFor() {
		var opened = await OpenAsync();
		var resources = await FindResourcesFolderAsync(opened.WorkspaceId);
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(opened.WorkspaceId), TestContext.Current.CancellationToken);
		var json = await CreateResourceAsync(opened.WorkspaceId, transaction.TransactionId, resources.Id, ResourceCreateKinds.File, "data.json", Convert.ToBase64String("{ \"a\": 1 }"u8.ToArray()));
		var code = await CreateResourceAsync(opened.WorkspaceId, transaction.TransactionId, resources.Id, ResourceCreateKinds.File, "Code.CSX", Convert.ToBase64String("class C { }"u8.ToArray()));
		var basic = await CreateResourceAsync(opened.WorkspaceId, transaction.TransactionId, resources.Id, ResourceCreateKinds.File, "module.vb", Convert.ToBase64String("Module M\nEnd Module"u8.ToArray()));
		await manager.CommitEditAsync(new EditTransactionRequest(opened.WorkspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);

		var jsonDocument = await DecompileAsync(opened.WorkspaceId, json.NodeId, DecompilerLanguage.CSharp);
		Assert.Equal(("plaintext", "{ \"a\": 1 }"), (jsonDocument.Language, jsonDocument.Text));
		Assert.Equal("csharp", (await DecompileAsync(opened.WorkspaceId, code.NodeId, DecompilerLanguage.IL)).Language);
		Assert.Equal("visual-basic", (await DecompileAsync(opened.WorkspaceId, basic.NodeId, DecompilerLanguage.CSharp)).Language);
	}

	static string[] Lines(string text) => text.Replace("\r\n", "\n", StringComparison.Ordinal).TrimEnd('\n').Split('\n');

	Task<DecompileResponse> DecompileAsync(string workspaceId, string nodeId, DecompilerLanguage language, DecompilerSettingsDto? settings = null) =>
		manager.DecompileAsync(new DecompileRequest(workspaceId, nodeId, language) { Settings = settings }, TestContext.Current.CancellationToken);

	Task<CreateResourceResponse> CreateResourceAsync(string workspaceId, string transactionId, string resourcesNodeId, string kind, string name, string base64Data) =>
		manager.CreateResourceAsync(new CreateResourceRequest(workspaceId, transactionId, resourcesNodeId, kind, name, 1, base64Data), TestContext.Current.CancellationToken);

	async Task<CreateResourceResponse> CreateResourcesFileAsync(string workspaceId, string resourcesNodeId, string name, params (string Kind, string Name, string? Text, string? Base64Data)[] entries) {
		var transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), TestContext.Current.CancellationToken);
		var created = await manager.CreateResourceAsync(
			new CreateResourceRequest(workspaceId, transaction.TransactionId, resourcesNodeId, ResourceCreateKinds.MultiFile, name, 1),
			TestContext.Current.CancellationToken);
		await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);
		if (entries.Length == 0)
			return created;
		transaction = await manager.BeginEditAsync(new BeginEditRequest(workspaceId), TestContext.Current.CancellationToken);
		foreach (var (kind, entryName, text, base64Data) in entries) {
			await manager.QueueCreateResourceElementAsync(
				new CreateResourceElementRequest(workspaceId, transaction.TransactionId, created.NodeId, kind, entryName, text, base64Data),
				TestContext.Current.CancellationToken);
		}
		await manager.CommitEditAsync(new EditTransactionRequest(workspaceId, transaction.TransactionId), TestContext.Current.CancellationToken);
		return created;
	}

	async Task<OpenWorkspaceResponse> OpenAsync() => await manager.OpenAsync(
		new OpenWorkspaceRequest([typeof(WorkspaceResourceDocumentTests).Assembly.Location]),
		TestContext.Current.CancellationToken);

	async Task<IReadOnlyList<TreeNodeDto>> ChildrenAsync(string workspaceId, string nodeId) =>
		(await manager.GetChildrenAsync(new NodeRequest(workspaceId, nodeId), TestContext.Current.CancellationToken)).Nodes;

	async Task<TreeNodeDto> FindResourcesFolderAsync(string workspaceId) {
		var root = Assert.Single(
			(await manager.GetRootsAsync(new WorkspaceRequest(workspaceId), TestContext.Current.CancellationToken)).Nodes);
		var module = Assert.Single(await ChildrenAsync(workspaceId, root.Id), node => node.Kind == "module");
		return Assert.Single(await ChildrenAsync(workspaceId, module.Id), node => node.Kind == "resourcesgroup");
	}

	public void Dispose() => manager.Dispose();
}
