using dnSpy.Backend.Core.HexFiles.DnSpy;
using dnSpy.Backend.Core.HexFiles.DotNet;
using dnSpy.Backend.Core.HexFiles.PE;
using dnSpy.Backend.Core.HexFiles.ToolTips;

namespace dnSpy.Backend.Core.HexFiles {
	/// <summary>
	/// The hex structure model of one document: dnSpy's WPF hex view services built over the document's bytes, with
	/// MEF taken out and the exports wired by hand in the order their [Order] attributes give them.
	/// <list type="bullet">
	/// <item>A <see cref="HexBuffer"/> over the patched file, and the <see cref="HexBufferFileService"/> of it with the one
	/// top-level file AsmEditor's HexBufferFileBufferServiceListener creates for every buffer —
	/// <c>CreateFile(buffer.Span, buffer.Name, buffer.Name, [])</c>; or a <see cref="HexBuffer"/> over a debugged
	/// process's memory with a top-level file for each loaded module, the way the debugger's BufferFileCreator creates
	/// them for the Memory window. The structure providers create the nested files (embedded resources, the elements
	/// of a multi-file .resources) as they initialize.</item>
	/// <item>The structure providers: PE, then .NET (<c>Order(After = PE)</c>), then the multi-file resource one.
	/// No BufferFileHeadersProviderFactory or PeFileLayoutProvider is exported in dnSpy, so there are none here
	/// either; a module of a process says its layout with a <see cref="PredefinedBufferFileTags"/> tag.</item>
	/// <item>The HexFileStructureInfoService's providers. All of them are ordered <c>Before = Default</c> and claim
	/// different structures, so their order among themselves only shows where two answer the same question, which
	/// none does: dnSpy-DotNet (tooltips and references of the .NET structures), PE and DotNet (field references and
	/// sub-structures), AsmEditor (the PE tree node a PE header field or a metadata table row is shown by), then
	/// Default (every other tooltip).</item>
	/// <item>dnSpy's DefaultHexStructureInfoProvider over that service — the only HexStructureInfoProvider a hex view
	/// has, so it is what the hex view's structure aggregator (HexStructureInfoAggregator) asks.</item>
	/// </list>
	/// </summary>
	sealed class HexStructureModel {
		public HexBuffer Buffer { get; }
		public HexBufferFileService FileService { get; }
		public HexFileStructureInfoService InfoService { get; }
		public HexStructureInfoProvider StructureInfoProvider { get; }

		/// <param name="entry">The document whose file the buffer is.</param>
		/// <param name="peField">What AsmEditor's provider answers for a position of the top-level PE file
		/// (<see cref="AsmEditorHexFileStructureInfoProvider"/>), or null for a document that has no PE tree.</param>
		public HexStructureModel(WorkspaceManager.IModuleEntry entry, Func<HexPosition, object?>? peField)
			: this(new HexBuffer(entry), peField is null ? null : (_, position) => peField(position), buffer => [new BufferFileOptions(buffer.Span, buffer.Name, buffer.Name, [])]) {
		}

		/// <param name="buffer">The bytes.</param>
		/// <param name="peField">What AsmEditor's provider answers for a position of a PE file, or null when there is no
		/// PE tree to find a node in.</param>
		/// <param name="files">The top-level files: a document's one file, or the modules a process has loaded
		/// (the debugger's BufferFileCreator).</param>
		public HexStructureModel(HexBuffer buffer, Func<HexBufferFile, HexPosition, object?>? peField, Func<HexBuffer, BufferFileOptions[]> files) {
			Buffer = buffer;
			StructureProviderFactory[] structureProviderFactories = [
				new PeStructureProviderFactory(),
				new DotNetStructureProviderFactory(),
				new MultiResourceStructureProviderFactory(),
			];
			FileService = new HexBufferFileServiceImpl(Buffer, structureProviderFactories, []);
			var options = files(Buffer);
			if (options.Length > 0)
				FileService.CreateFiles(options);
			var toolTipCreatorFactory = new ToolTipCreatorFactoryImpl();
			HexFileStructureInfoProvider[] providers = [
				new DnSpy.DotNetHexFileStructureInfoProvider(toolTipCreatorFactory),
				new PeHexFileStructureInfoProvider(),
				new DotNet.DotNetHexFileStructureInfoProvider(),
				new AsmEditorHexFileStructureInfoProvider(peField),
				new DefaultHexFileStructureInfoProvider(toolTipCreatorFactory, [new DotNetHexFileImageReferenceProvider()]),
			];
			InfoService = new HexFileStructureInfoServiceImpl(FileService, providers);
			StructureInfoProvider = new DefaultHexStructureInfoProvider(FileService, InfoService);
		}
	}

	/// <summary>
	/// dnSpy.AsmEditor's HexFileStructureInfoProviderImpl. Its GetReference answers, for a position in a visible field
	/// of a PE header, of a section header, of the CLR header, of the metadata headers or of a metadata table row, the
	/// structure the field belongs to (its PEStructure.GetField); dnSpy's AsmEditor HexReferenceConverterImpl then
	/// opens the PE tree node showing that structure. The structures live in this port's PE tree rather than in
	/// AsmEditor's view models, so the workspace answers the question (<paramref name="peField"/>) and turns the
	/// answer into a node when the reference is followed.
	/// </summary>
	sealed class AsmEditorHexFileStructureInfoProvider(Func<HexBufferFile, HexPosition, object?>? peField) : HexFileStructureInfoProvider {
		public override object? GetReference(HexBufferFile file, ComplexData structure, HexPosition position) {
			// PEStructure.TryCreate: only a file the PE structure provider read headers out of has the structures.
			if (peField is null || file.GetHeaders<PeHeaders>() is null)
				return null;
			return peField(file, position);
		}

		public override HexIndexes[]? GetSubStructureIndexes(HexBufferFile file, ComplexData structure, HexPosition position) {
			if (structure is PeSectionsData)
				return [];
			return null;
		}
	}
}
