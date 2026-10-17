using System.Text.Json;
using System.Text.Json.Serialization;

namespace dnSpy.Backend.Contracts;

public static class ProtocolInfo {
	public const int Version = 1;
}

public static class RpcMethods {
	public const string Hello = "system/hello";
	public const string Shutdown = "system/shutdown";
	public const string Cancel = "system/cancel";
	public const string WorkspaceOpen = "workspace/open";
	public const string WorkspaceAddModules = "workspace/addModules";
	public const string WorkspaceClose = "workspace/close";
	public const string TreeGetRoots = "tree/getRoots";
	public const string TreeGetChildren = "tree/getChildren";
	public const string TreeGetNode = "tree/getNode";
	/// <summary>
	/// The chain of nodes from the workspace root down to a node, the root first and the node itself
	/// last, answered with the <see cref="TreeNodesResponse"/> the tree already uses. A client cannot
	/// derive the ancestors of a node it has never listed — a member's id names its module and token,
	/// not the type that declares it — so it asks for the chain instead. The list is empty for a node
	/// that cannot be reached from a root (a kind with no path, such as a PE or ELF structure), and the
	/// call fails with <see cref="ErrorCodes.NodeNotFound"/> when the id names no node at all.
	/// </summary>
	public const string TreeGetNodePath = "tree/getNodePath";
	public const string DocumentDecompile = "document/decompile";
	public const string DocumentFindMember = "document/findMember";
	public const string Search = "search/run";
	/// <summary>A notification: the results a search found since the last one, sent while it still runs
	/// when the request named a progress token.</summary>
	public const string SearchProgress = "search/progress";
	/// <summary>
	/// Writes what a search found again through another language — dnSpy's DecompilerChanged, which rewrites the
	/// search list's text and tooltips without searching again. Answered with a <see cref="SearchResponse"/>.
	/// </summary>
	public const string SearchRelabel = "search/relabel";
	public const string AnalyzeNodes = "analyze/nodes";
	public const string AnalyzeChildren = "analyze/children";
	/// <summary>
	/// A notification, not a request: the rows an analyzer search found since the last one, sent while it
	/// is still running when the request named a <see cref="AnalyzeChildrenRequest.ProgressToken"/> — what
	/// dnSpy's search nodes show as they go. The response then carries only what was not sent ahead.
	/// </summary>
	public const string AnalyzeProgress = "analyze/progress";
	public const string HexGetLength = "hex/getLength";
	public const string HexReadRange = "hex/readRange";
	public const string HexResolveTarget = "hex/resolveTarget";
	public const string HexResolveStatement = "hex/resolveStatement";
	public const string EditHexPatch = "edit/hexPatch";
	public const string ModuleGetInfo = "module/getInfo";
	public const string EditBegin = "edit/begin";
	public const string EditGetMethodBody = "edit/getMethodBody";
	public const string EditRename = "edit/rename";
	public const string EditDelete = "edit/delete";
	public const string EditSetNamespace = "edit/setNamespace";
	public const string EditReplaceMethodBody = "edit/replaceMethodBody";
	public const string EditReplaceMethodBodyWithStub = "edit/replaceMethodBodyWithStub";
	public const string EditReplaceResource = "edit/replaceResource";
	public const string EditGetOptions = "edit/getOptions";
	public const string EditCreate = "edit/create";
	public const string EditSetOptions = "edit/setOptions";
	public const string EditCommit = "edit/commit";
	public const string EditRollback = "edit/rollback";
	public const string EditUndo = "edit/undo";
	public const string EditRedo = "edit/redo";
	public const string ModuleSaveAs = "module/saveAs";
	public const string ModuleSave = "module/save";
	public const string ModuleSaveAll = "module/saveAll";
	public const string WorkspaceReload = "workspace/reload";
	public const string WorkspaceSortAssemblies = "workspace/sortAssemblies";
	/// <summary>Removes one assembly from the tree — dnSpy's Remove Assembly.</summary>
	public const string WorkspaceRemoveModule = "workspace/removeModule";
	/// <summary>The module's entry point or the static constructor of its global type, for dnSpy's two
	/// "Go to ..." commands.</summary>
	public const string ModuleGetSpecialNode = "module/getSpecialNode";
	/// <summary>The node a metadata token names, for dnSpy's "Go to Token".</summary>
	public const string TreeFindByToken = "tree/findByToken";
	/// <summary>The bytes a resource node holds, for dnSpy's Save Resource commands.</summary>
	public const string ResourceGetData = "resource/getData";
	/// <summary>Opens the assemblies a module's references name — dnSpy's Load Dependencies.</summary>
	public const string WorkspaceLoadDependencies = "workspace/loadDependencies";
	/// <summary>Turns a module into an assembly or back — dnSpy's two Convert commands.</summary>
	public const string EditConvertModule = "edit/convertModule";
	public const string DebugLaunch = "debug/launch";
	public const string DebugListProcesses = "debug/listProcesses";
	public const string DebugAttach = "debug/attach";
	public const string DebugRequest = "debug/request";
	public const string DebugDisconnect = "debug/disconnect";
	public const string DebugEvent = "debug/event";
	/// <summary>The debugger options the engine acts on, which apply to every session, running or not.</summary>
	public const string DebugSetOptions = "debug/setOptions";
	public const string ScriptEvaluate = "script/evaluate";
	public const string ScriptReset = "script/reset";
	/// <summary>The exception types the debug engine can break on, with their default and current settings.</summary>
	public const string ExceptionGet = "exceptions/get";
	/// <summary>Applies the client's Add/Remove/Update diff against the defaults and answers with the new list.</summary>
	public const string ExceptionApply = "exceptions/apply";
	/// <summary>Drops every change and answers with the default list.</summary>
	public const string ExceptionReset = "exceptions/reset";
	/// <summary>The Bookmarks window's Location column for a list of bookmark locations.</summary>
	public const string BookmarksFormatLocations = "bookmarks/formatLocations";
	/// <summary>Writes bookmarks as a WPF dnSpy bookmark file.</summary>
	public const string BookmarksExport = "bookmarks/export";
	/// <summary>Reads the bookmarks out of a WPF dnSpy bookmark (or settings) file.</summary>
	public const string BookmarksImport = "bookmarks/import";
	/// <summary>Removes several documents from the tree at once — dnSpy's Remove Assembly over a multiple
	/// selection, and its Close All Framework Assemblies / Close All Missing Files sweeps.</summary>
	public const string WorkspaceRemoveModules = "workspace/removeModules";
	/// <summary>Which of the workspace's modules hold edits that have not been saved.</summary>
	public const string WorkspaceGetModifiedModules = "workspace/getModifiedModules";
	/// <summary>The roots dnSpy's two Close All sweeps would remove: the framework assemblies and the
	/// documents that are not PE images (a missing file is one of those).</summary>
	public const string WorkspaceGetCloseCandidates = "workspace/getCloseCandidates";
	/// <summary>Moves roots to another place in the tree — what dragging them does.</summary>
	public const string WorkspaceMoveRoots = "workspace/moveRoots";
	/// <summary>Opens the files dropped on the tree at the place they were dropped, filtered the way the
	/// Assembly Explorer's "dragged items" option says.</summary>
	public const string WorkspaceDropFiles = "workspace/dropFiles";
	/// <summary>What activating a row — a double click, Enter — goes to: the definition a reference row names,
	/// or the assembly an assembly reference names, opened when it has to be.</summary>
	public const string TreeActivate = "tree/activate";
	/// <summary>Every assembly in the global assembly caches, for dnSpy's Open from GAC dialog.</summary>
	public const string GacList = "gac/list";
	/// <summary>The company and file version of one GAC file, which the dialog shows for its selection.</summary>
	public const string GacGetDetails = "gac/getDetails";
	/// <summary>The files one or more resource nodes save as — dnSpy's Save and Raw Save over a selection.</summary>
	public const string ResourceGetItems = "resource/getItems";
	/// <summary>The .resources entry a resource accessor reads — dnSpy's Go to Resource.</summary>
	public const string ResourceFind = "resource/find";
	/// <summary>The lists dnSpy's Open List dialog offers beside the ones the user saved: one per .NET shared
	/// framework installed on this machine.</summary>
	public const string DocumentListDefaults = "documentList/defaults";
	/// <summary>The names the resource nodes save under, both ways — what the Save commands' headers count
	/// and whether the "use sub dirs" variants are offered.</summary>
	public const string ResourceGetItemNames = "resource/getItemNames";
	/// <summary>The node a command line's <c>--select</c> names in the files it opened: a metadata token, or
	/// an XML documentation id ("T:", "M:", "N:" …).</summary>
	public const string TreeSelectMember = "tree/selectMember";
	/// <summary>Scans modules for all string references (ldstr, constants, custom attributes).</summary>
	public const string StringReferencesSearch = "stringReferences/search";
	/// <summary>A notification: the string references found since the last one, sent while it still runs
	/// when the request named a progress token.</summary>
	public const string StringReferencesProgress = "stringReferences/progress";
	/// <summary>The semantic colors of the C# Interactive window's input, compiled against the session the way
	/// the WPF window's RoslynClassifier colors it while it is being typed.</summary>
	public const string ScriptClassify = "script/classify";
	/// <summary>Opens a C# code document in a Roslyn workspace of its own — the document dnSpy's Edit Method
	/// (C#) editor types into — and answers with the id the other languageService/* methods take.</summary>
	public const string LanguageServiceOpen = "languageService/open";
	/// <summary>Replaces the text of an open code document.</summary>
	public const string LanguageServiceUpdate = "languageService/update";
	/// <summary>Drops an open code document and its workspace.</summary>
	public const string LanguageServiceClose = "languageService/close";
	/// <summary>The semantic colors of a whole code document (dnSpy's RoslynClassifier).</summary>
	public const string LanguageServiceClassify = "languageService/classify";
	/// <summary>The completion list at a position (dnSpy's Roslyn completion source).</summary>
	public const string LanguageServiceCompletion = "languageService/completion";
	/// <summary>The classified tooltip of one item of the last completion list.</summary>
	public const string LanguageServiceCompletionDescription = "languageService/completionDescription";
	/// <summary>The Quick Info of the symbol at a position.</summary>
	public const string LanguageServiceQuickInfo = "languageService/quickInfo";
	/// <summary>The signatures of the call, indexer, attribute or generic name around a position.</summary>
	public const string LanguageServiceSignatureHelp = "languageService/signatureHelp";
	/// <summary>What compiling the document reports, the way dnSpy's RoslynLanguageCompiler reports it.</summary>
	public const string LanguageServiceDiagnostics = "languageService/diagnostics";
	/// <summary>The indentation a line should get — dnSpy's Roslyn smart indent.</summary>
	public const string LanguageServiceIndentation = "languageService/indentation";
	/// <summary>The spans of the syntax around positions, innermost first — dnSpy's Roslyn text structure navigator.</summary>
	public const string LanguageServiceSelectionRanges = "languageService/selectionRanges";
}

public static class ErrorCodes {
	public const int ParseError = -32700;
	public const int InvalidRequest = -32600;
	public const int MethodNotFound = -32601;
	public const int InvalidParams = -32602;
	public const int InternalError = -32603;
	public const int WorkspaceNotFound = 1001;
	public const int NodeNotFound = 1002;
	public const int FileNotFound = 1003;
	public const int UnsupportedDocument = 1004;
	public const int RequestCanceled = 1005;
	public const int RangeTooLarge = 1006;
	public const int EditConflict = 1007;
	public const int EditTransactionNotFound = 1008;
	public const int EditValidationFailed = 1009;
	public const int SaveFailed = 1010;
}

public sealed record HelloRequest(int ProtocolVersion, string ClientVersion, string Nonce);

public sealed record HelloResponse(
	int ProtocolVersion,
	string BackendVersion,
	string Nonce,
	string Platform,
	string Architecture,
	IReadOnlyDictionary<string, bool> Capabilities);

public sealed record OpenWorkspaceRequest(IReadOnlyList<string> Paths);

public sealed record OpenWorkspaceResponse(string WorkspaceId, IReadOnlyList<OpenedModule> Modules, string StateId);

/// <summary>Adds assemblies to a workspace that is already open, the way dnSpy's Open command adds
/// them to the tree instead of replacing it. Paths that are already open are reported in
/// <see cref="Skipped"/> rather than loaded twice.</summary>
public sealed record AddModulesRequest(string WorkspaceId, IReadOnlyList<string> Paths);

public sealed record AddModulesResponse(IReadOnlyList<OpenedModule> Modules, IReadOnlyList<string> Skipped, string StateId);

/// <summary>One file the workspace holds. <paramref name="AutoLoaded"/> is set on a file the workspace opened
/// by itself to resolve a reference — dnSpy's auto-loaded documents, which a saved list leaves out.</summary>
public sealed record OpenedModule(string Id, string Name, string Path, bool HasPdb, bool AutoLoaded = false);

public sealed record WorkspaceRequest(string WorkspaceId);

public sealed record NodeRequest(string WorkspaceId, string NodeId);

public sealed record TreeNodesResponse(IReadOnlyList<TreeNodeDto> Nodes);

/// <summary>
/// <paramref name="Id"/> is a counter value that is issued in the order nodes are first materialised,
/// so it does not survive a restart. <paramref name="Key"/> does: it is built from the module's path
/// and the metadata token, which is what a client stores to find the same node in a later session.
/// <para><paramref name="MetadataToken"/> and <paramref name="ReturnType"/> are the raw pieces the
/// client composes the WPF tree text out of — "name : RetType @06000004" — so the label itself stays
/// the bare member name that bookmarks, output messages and tests quote. The token is the raw
/// <c>MDToken.Raw</c>, present only where the WPF tree writes one; the return type only on members
/// whose row names one after a colon.</para>
/// <para><paramref name="LabelParts"/> and <paramref name="ReturnTypeParts"/> are the same two texts cut
/// where dnSpy's syntax highlighting changes color; a row whose text dnSpy writes in one plain color — a
/// folder, a resource — carries none.</para>
/// <para><paramref name="Icon"/> names the picture in dnSpy's own image set ("ClassPublic",
/// "MethodPrivate"). <paramref name="ToolTip"/> is the row's tooltip, one line per line dnSpy writes.
/// <paramref name="MsdnName"/> is the address "Search MSDN" opens for the row, present only on the public
/// members and namespaces dnSpy offers the command on. <paramref name="CompilerGenerated"/> marks a member
/// the C# and VB decompilers hide unless their "show hidden compiler generated types and methods" option is
/// on. <paramref name="AutoLoaded"/> marks a root the workspace opened by itself to resolve a reference,
/// rather than one the user opened. <paramref name="AssemblyVersion"/> and <paramref name="PublicKeyToken"/>
/// are the two parts an assembly row may write after its name, which the client's options pick from.
/// <paramref name="FullName"/> is what "Copy Full Name" writes — the full name of the metadata row the node
/// stands for, present only on the rows dnSpy offers that command on.</para>
/// </summary>
public sealed record TreeNodeDto(
	string Id,
	string Label,
	string Kind,
	bool HasChildren,
	string? Description = null,
	string? Icon = null,
	string? Key = null,
	int? MetadataToken = null,
	string? ReturnType = null,
	IReadOnlyList<TextPartDto>? LabelParts = null,
	IReadOnlyList<TextPartDto>? ReturnTypeParts = null,
	string? ToolTip = null,
	string? MsdnName = null,
	bool CompilerGenerated = false,
	bool AutoLoaded = false,
	string? AssemblyVersion = null,
	string? PublicKeyToken = null,
	string? FullName = null);

public enum DecompilerLanguage {
	CSharp,
	VisualBasic,
	IL,
	ILWithCSharp,
}

public sealed record DecompileRequest(string WorkspaceId, string NodeId, DecompilerLanguage Language) {
	/// <summary>
	/// Decompiler settings to use for this request. When null, the backend uses default settings.
	/// </summary>
	public DecompilerSettingsDto? Settings { get; init; }
}

/// <summary>
/// C# and Visual Basic decompiler settings, matching ICSharpCode.Decompiler's DecompilerSettings.
/// </summary>
public sealed record CSharpDecompilerSettingsDto(
	bool AnonymousMethods = true,
	bool YieldReturn = true,
	bool AsyncAwait = true,
	bool QueryExpressions = true,
	bool ExpressionTrees = true,
	bool UseDebugSymbols = true,
	bool ShowXmlDocumentation = true,
	bool SortCustomAttributes = false,
	bool FullyQualifyAllTypes = false,
	bool FullyQualifyAmbiguousTypeNames = true,
	bool RemoveEmptyDefaultConstructors = true,
	bool ShowTokenAndRvaComments = false,
	bool SortMembers = false,
	bool ForceShowAllMembers = false,
	bool SortSystemUsingStatementsFirst = true,
	bool UseSourceCodeOrder = false,
	bool OneCustomAttributePerLine = false,
	bool AllowFieldInitializers = true,
	bool TypeAddInternalModifier = false,
	bool MemberAddPrivateModifier = false,
	bool HexadecimalNumbers = true,
	bool EmitCalliAsInvocationExpression = false,
	bool InsertParenthesesForReadability = true);

/// <summary>
/// IL decompiler settings.
/// </summary>
public sealed record ILDecompilerSettingsDto(
	bool ShowXmlDocumentation = true,
	bool ShowTokenAndRvaComments = true,
	bool ShowILBytes = true,
	bool ShowILComments = false,
	bool SortMembers = false,
	bool ShowPdbInfo = true,
	bool HexadecimalNumbers = false);

/// <summary>
/// BAML decompiler settings.
/// </summary>
public sealed record BamlDecompilerSettingsDto(
	bool NewLineOnAttributes = true,
	bool UseTabs = true);

/// <summary>
/// Combined decompiler settings for all languages.
/// </summary>
public sealed record DecompilerSettingsDto(
	CSharpDecompilerSettingsDto? CSharp = null,
	ILDecompilerSettingsDto? IL = null,
	BamlDecompilerSettingsDto? Baml = null,
	bool DecompileFullType = true,
	bool UseMemoryMappedIO = false);

/// <summary>
/// A piece of the decompiled text that names something. <paramref name="TargetNodeId"/> is the tree
/// node the piece points at, and is only set when the target's module is one the workspace holds.
/// A reference into a module the workspace does not hold carries the identity a
/// <see cref="FindMemberRequest"/> is answered from instead — the file it lives in and the token it
/// has there — so the client can follow it on demand rather than never.
/// </summary>
public sealed record TextSpanDto(
	int Start,
	int Length,
	string Kind,
	string? TargetNodeId = null,
	string? TargetModulePath = null,
	int? TargetMetadataToken = null);

/// <summary>
/// One sequence point of the decompiled text: the line(s) it covers and the IL range it maps to.
/// The IL range is what the in-process debug engine turns into an IL-offset breakpoint, so a
/// gutter click can select the statement under the cursor instead of only its owning method.
/// </summary>
/// <summary>
/// One statement of a decompiled body, in the IL terms a debug engine speaks. <paramref name="IlOffset"/>
/// is where the statement's own code starts, which is where a breakpoint on its line belongs;
/// <paramref name="SequencePointIlOffset"/> is the start of the point that tiles the IL there, which is
/// the offset the runtime is able to place a breakpoint on. They differ where the decompiler's own
/// statement begins inside code the sequence points charge to it.
/// </summary>
public sealed record CodeStatementDto(
	int StartLine,
	int EndLine,
	int StartColumn,
	int EndColumn,
	int IlOffset,
	int IlEndOffset,
	int SequencePointIlOffset,
	string ModulePath,
	int MetadataToken,
	int SourceMethodToken,
	string Description,
	bool IsHidden);

public sealed record DecompileResponse(
	string Title,
	string Language,
	string Text,
	IReadOnlyList<TextSpanDto> Spans,
	IReadOnlyList<DiagnosticDto> Diagnostics) {
	/// <summary>
	/// Per-statement IL mapping for the languages whose text can be mapped: C#, whose statements are the
	/// decompiler's sequence points, and IL (with or without C#), which has one statement per instruction
	/// the way dnSpy's disassembler records them. Visual Basic, a conversion of the C# text, has none.
	/// </summary>
	public IReadOnlyList<CodeStatementDto>? CodeStatements { get; init; }

	/// <summary>
	/// What dnSpy draws into a resource's document besides text: the image an image resource holds, and the
	/// Save button under a resource's line. Each sits between two lines of the text.
	/// </summary>
	public IReadOnlyList<DocumentAttachmentDto>? Attachments { get; init; }
}

/// <summary>
/// Something a document shows between its lines — dnSpy's <c>AddUIElement</c> and <c>AddButton</c>.
/// <paramref name="AfterLine"/> is the 1-based line it goes under (0 puts it above the first one).
/// <paramref name="Kind"/> is <see cref="DocumentAttachmentKinds.Image"/>, with the picture in
/// <paramref name="Base64Data"/> and its <paramref name="MimeType"/>, or <see cref="DocumentAttachmentKinds.SaveButton"/>,
/// which saves the resource <paramref name="NodeId"/> names.
/// </summary>
public sealed record DocumentAttachmentDto(int AfterLine, string Kind, string? Base64Data = null, string? MimeType = null, string? NodeId = null);

public static class DocumentAttachmentKinds {
	public const string Image = "image";
	public const string SaveButton = "saveButton";
}

public sealed record DiagnosticDto(string Severity, string Message, int? Start = null, int? Length = null);

/// <summary>
/// Looks a member up by the identity a client can keep across sessions. Node ids are handed out per
/// workspace and change on every open, so a persisted bookmark has to name its target by module path
/// and metadata token instead.
/// </summary>
/// <remarks>
/// A module the workspace does not hold is opened from the file the request names, the way dnSpy's own
/// reference navigation loads an assembly on demand. That adds a root to the workspace, so a caller
/// that got a node back has to refresh its roots with <see cref="WorkspaceRequest"/>.
/// </remarks>
public sealed record FindMemberRequest(string WorkspaceId, string ModulePath, int MetadataToken);

public sealed record FindMemberResponse(string? NodeId, string? Label, string? Description);

/// <summary>
/// dnSpy's search window. <paramref name="SearchType"/> is the "Search For" box — one of
/// <see cref="SearchTypes"/> — and <paramref name="Location"/> the box beside it, one of
/// <see cref="SearchLocations"/>; the locations other than all files read the tree nodes
/// <paramref name="SelectedNodeIds"/> names — the tree's selection. The query is split on spaces into terms that must all match
/// (any of them with <paramref name="MatchAnySearchTerm"/>), or is a regular expression between slashes.
/// A search asked with a <paramref name="ProgressToken"/> sends what it finds ahead, in
/// <see cref="RpcMethods.SearchProgress"/> notifications.
/// </summary>
public sealed record SearchRequest(
	string WorkspaceId,
	string Query,
	string SearchType = SearchTypes.Any,
	string Location = SearchLocations.AllFiles,
	IReadOnlyList<string>? SelectedNodeIds = null,
	bool CaseSensitive = false,
	bool MatchWholeWords = false,
	bool MatchAnySearchTerm = false,
	bool SearchDecompiledData = true,
	bool SearchFrameworkAssemblies = true,
	bool SearchCompilerGeneratedMembers = true,
	int MaxResults = 10_000,
	string? ProgressToken = null,
	DecompilerLanguage Language = DecompilerLanguage.CSharp);

/// <summary>
/// Asks for the results <paramref name="Count"/> from <paramref name="Start"/> of the search that was run with
/// <paramref name="ProgressToken"/>, written through <paramref name="Language"/>. The workspace keeps the last few
/// searches it ran for this; one it no longer has, or one the workspace changed under, fails with
/// <see cref="ErrorCodes.EditConflict"/>.
/// </summary>
public sealed record SearchRelabelRequest(string WorkspaceId, string ProgressToken, DecompilerLanguage Language, int Start = 0, int Count = int.MaxValue);

/// <summary>What a search found, in the order it found it. <paramref name="Truncated"/> says the search
/// stopped at the limit — dnSpy's "too many results". <paramref name="Start"/> is where the first result
/// stands among everything found: the ones sent ahead come before it.</summary>
public sealed record SearchResponse(IReadOnlyList<SearchResultDto> Results, bool Truncated, int Start = 0);

/// <summary>
/// One result of dnSpy's search window: what matched, written the way its list writes it, and where it
/// lives. <paramref name="NodeId"/> is the tree node following the result opens, absent for a module
/// reference, which the tree has no row for. A match in a method body names the instruction's
/// <paramref name="IlOffset"/>, which is where following it puts the caret. The texts are written through the
/// language the search was asked with, and <paramref name="ToolTipParts"/> is <paramref name="ToolTip"/> in its
/// color classes, a line break between its lines.
/// </summary>
public sealed record SearchResultDto(
	string? NodeId,
	string Kind,
	string Name,
	string Location,
	IReadOnlyList<TextPartDto>? NameParts = null,
	IReadOnlyList<TextPartDto>? LocationParts = null,
	string? Icon = null,
	string? LocationIcon = null,
	string? ToolTip = null,
	int? IlOffset = null,
	IReadOnlyList<TextPartDto>? ToolTipParts = null);

public sealed record HexLengthRequest(string WorkspaceId, string ModuleId);

public sealed record HexLengthResponse(long Length);

public sealed record HexReadRequest(string WorkspaceId, string ModuleId, long Offset, int Count);

public sealed record HexReadResponse(long Offset, string Base64Data, bool EndOfFile);

public sealed record HexTargetRequest(string WorkspaceId, string NodeId);

/// <summary>A byte range of the module's file, as the hex editor addresses it.</summary>
public sealed record HexRangeDto(long Offset, long Length);

/// <summary>
/// The parts of a method the hex commands jump to: the whole body (header included, what "Show Method
/// Body" and the write commands overwrite) and the IL code that follows the header ("Show Instructions").
/// The three template fields are the exact bytes dnSpy's write commands install, base64 encoded; each is
/// null when that command does not apply to this method, which is what its menu entry keys off.
/// </summary>
public sealed record HexMethodTargetDto(
	long BodyOffset,
	long BodySize,
	long CodeOffset,
	long CodeSize,
	string? ReturnTrueBody = null,
	string? ReturnFalseBody = null,
	string? EmptyBody = null);

/// <summary>
/// Where the hex commands for one node point. Everything but <paramref name="ModuleId"/> and
/// <paramref name="FileLength"/> is null when the node has no such target.
/// </summary>
public sealed record HexTargetResponse(
	string ModuleId,
	long FileLength,
	HexMethodTargetDto? Method = null,
	HexRangeDto? FieldInitialValue = null,
	HexRangeDto? Resource = null);

/// <summary>
/// A statement under the caret of a code document, named the way a bookmark names its target: the IL
/// offsets are relative to the method's code, so the range the hex editor shows is the code offset of
/// the statement's own method plus these.
/// </summary>
public sealed record HexStatementRequest(string WorkspaceId, string ModulePath, int MetadataToken, int IlOffset, int IlEndOffset);

/// <summary>The statement's bytes in the file, or null when it has none (a method with no body, say).
/// The module is named too, since a code document only knows the path it was decompiled from.</summary>
public sealed record HexStatementResponse(string? ModuleId, HexRangeDto? Range);

/// <summary>
/// One in-place byte patch, written over the module's file image. The client queues this in an edit
/// transaction like any other edit, so it undoes and redoes with the rest of them.
/// </summary>
public sealed record HexPatchRequest(string WorkspaceId, string TransactionId, string NodeId, long Offset, string Base64Data);

public sealed record ModuleInfoRequest(string WorkspaceId, string ModuleId);

public sealed record ModuleInfoResponse(
	string Name,
	string Path,
	string RuntimeVersion,
	string Architecture,
	string ModuleKind,
	Guid Mvid,
	string? EntryPoint,
	int TypeCount,
	int ResourceCount,
	IReadOnlyList<string> AssemblyReferences,
	IReadOnlyDictionary<string, string> PeHeaders,
	IReadOnlyDictionary<string, int> MetadataTables);

public sealed record BeginEditRequest(string WorkspaceId);

public sealed record BeginEditResponse(string TransactionId, int BaseVersion);

public sealed record RenameEditRequest(string WorkspaceId, string TransactionId, string NodeId, string NewName);

/// <summary>Removes one node from its owner: a type, a member, a resource, or every type of a namespace.</summary>
public sealed record DeleteEditRequest(string WorkspaceId, string TransactionId, string NodeId);

/// <summary>
/// Moves every top-level type of a namespace node to <paramref name="NewName"/>. An empty name is dnSpy's
/// "Move Types to Empty Namespace"; any other name is "Rename Namespace".
/// </summary>
public sealed record SetNamespaceEditRequest(string WorkspaceId, string TransactionId, string NodeId, string NewName);

public sealed record IlInstructionDto(
	string Label,
	string OpCode,
	string? OperandKind = null,
	string? Operand = null,
	string? OperandDisplay = null);

public sealed record MethodBodyRequest(string WorkspaceId, string MethodNodeId);

public sealed record MethodBodyResponse(
	int MaxStack,
	bool InitLocals,
	IReadOnlyList<string> Locals,
	IReadOnlyList<IlInstructionDto> Instructions,
	bool HasExceptionHandlers);

public sealed record ReplaceMethodBodyRequest(
	string WorkspaceId,
	string TransactionId,
	string MethodNodeId,
	IReadOnlyList<IlInstructionDto> Instructions,
	int? MaxStack = null,
	bool? InitLocals = null,
	bool ClearExceptionHandlers = false);

/// <summary>
/// Replaces a method body with dnSpy's generated stub. The body is built from the method's own
/// signature — a base-constructor call, defaults for <c>out</c> parameters and the return value — so
/// it cannot be expressed as a fixed instruction list the client sends.
/// </summary>
public sealed record ReplaceMethodBodyWithStubRequest(string WorkspaceId, string TransactionId, string MethodNodeId);

public sealed record ReplaceResourceRequest(
	string WorkspaceId,
	string TransactionId,
	string ResourceNodeId,
	string Base64Data);

public sealed record EditTransactionRequest(string WorkspaceId, string TransactionId);

/// <summary>
/// The history after an edit, an undo or a redo. <paramref name="Modules"/> is only set when the step changed
/// which documents the tree holds — undoing or redoing a removal — and is then every module the workspace holds.
/// </summary>
public sealed record EditCommitResponse(int Version, string StateId, IReadOnlyList<string> ChangedNodeIds, bool CanUndo, bool CanRedo, IReadOnlyList<OpenedModule>? Modules = null);

public sealed record SaveModuleRequest(string WorkspaceId, string ModuleId, string DestinationPath, bool Overwrite = false);

/// <summary>Saves one module back over the file it was loaded from — dnSpy's Save command, as opposed
/// to <see cref="SaveModuleRequest"/>'s Save As.</summary>
public sealed record SaveModuleInPlaceRequest(string WorkspaceId, string ModuleId);

/// <summary>Every module of the workspace that has unsaved edits, each written back over its own file.
/// The list is empty when nothing was modified, which is not an error.</summary>
public sealed record SaveAllResponse(IReadOnlyList<SaveModuleResponse> Saved);

// ---------------------------------------------------------------------------------------------
// AsmEditor option DTOs.
//
// These mirror dnSpy's `*Options` classes (Extensions/dnSpy.AsmEditor/{Types,Method,Field,Property,
// Event}/*DefOptions.cs) field for field, so each codec can be read against the WPF original. Two
// conventions run through all of them:
//
//  * Enum-valued fields travel as the raw dnlib integer. The WPF dialogs render them from named-flag
//    lists built off the enums, and this port does the same, so neither side has to agree on the
//    casing of an enum member's name.
//  * `Display` fields are filled in by the backend. They are what the dialogs show in read-only
//    previews and list rows — the same strings WPF's `FullName`-style properties produce — so the
//    client never formats a type or a signature itself.
// ---------------------------------------------------------------------------------------------

/// <summary>
/// A type as it is written into metadata: the assembly that declares it, its namespace, and its name.
/// An empty <paramref name="Scope"/> means "this module"; the codecs resolve that against the module
/// being edited before falling back to a reference.
/// </summary>
/// <remarks>
/// <paramref name="NodeId"/> is set when the type was picked out of the assembly explorer, and is what
/// the codecs try first: it names a type the workspace has already resolved, including one that lives in
/// a referenced assembly and would be expensive — or impossible — to look up by name. The three name
/// fields are the fallback and are always filled in, so the name alone is enough to rebuild the type.
/// </remarks>
public sealed record TypeRefDto(
	string Scope,
	string Namespace,
	string Name,
	string? NodeId = null);

/// <summary>
/// A method used by something other than itself — a property or event accessor. A node id names the row
/// the user picked and is preferred; the token is what the model itself can always answer with, which is
/// what lets a value the server produced be read back without asking the workspace again. A method that
/// has neither — one created by this very transaction and never assigned a row — is matched by name,
/// which two methods of one type can share, so it is only the last resort.
/// </summary>
public sealed record AccessorRefDto(
	string Name,
	uint Token = 0,
	string? NodeId = null,
	string Display = "");

public static class TypeSigKinds {
	public const string Type = "type";
	public const string GenericInst = "genericInst";
	public const string SzArray = "szarray";
	public const string Array = "array";
	public const string Pointer = "ptr";
	public const string ByRef = "byref";
	public const string Pinned = "pinned";
	public const string CModReqd = "cmodreqd";
	public const string CModOpt = "cmodopt";
	public const string GenericVar = "genericvar";
	public const string GenericMVar = "genericmvar";
	public const string FnPtr = "fnptr";

	/// <summary>
	/// A slot a dialog has opened but not filled — a generic argument the user has not picked a type for
	/// yet. Nothing produces one when reading, and one that is written back is rejected rather than
	/// written: dnSpy's creator likewise refuses to hand over an array of type signatures that is short
	/// of the count it asked for.
	/// </summary>
	public const string Empty = "empty";
}

/// <summary>
/// One node of a type signature, covering everything dnSpy's <c>TypeSigCreator</c> can build. The
/// wrapper kinds — <c>szarray</c>, <c>ptr</c>, <c>byref</c>, <c>pinned</c>, <c>array</c> — carry the
/// type they wrap in <paramref name="Element"/>; the two custom-modifier kinds put the modifier in
/// <paramref name="Modifier"/> and the type it modifies in <paramref name="Element"/>, which is the
/// order dnlib's <c>CModOptSig</c>/<c>CModReqdSig</c> take them in.
/// </summary>
/// <param name="ValueType">
/// Whether the type is a value type. A signature that was read says so; a dialog that has nothing but a
/// name to go on leaves it unset, and the type's own definition decides. Unset is not the same as false,
/// which is why this is not a plain <see cref="bool"/>.
/// </param>
public sealed record TypeSigDto(
	string Kind,
	TypeRefDto? Type = null,
	bool? ValueType = null,
	TypeSigDto? Element = null,
	TypeSigDto? Modifier = null,
	IReadOnlyList<TypeSigDto>? Arguments = null,
	int Rank = 0,
	IReadOnlyList<int>? Sizes = null,
	IReadOnlyList<int>? LowerBounds = null,
	int GenericParameterNumber = 0,
	MethodSigDto? FunctionPointer = null,
	string Display = "");

/// <summary>
/// A method signature. <paramref name="CallingConvention"/> is dnlib's <c>CallingConvention</c> as a
/// raw value: the low nibble is the calling convention and bits 4-6 carry Generic/HasThis/ExplicitThis,
/// which is exactly how <c>MethodSigCreatorVM</c> models it.
/// </summary>
public sealed record MethodSigDto(
	int CallingConvention,
	TypeSigDto ReturnType,
	IReadOnlyList<TypeSigDto> Parameters,
	IReadOnlyList<TypeSigDto>? VarArgParameters = null,
	int GenericParameterCount = 0,
	string Display = "");

/// <summary>A property signature: dnlib's <c>PropertySig</c>, whose return type is the property's type.</summary>
public sealed record PropertySigDto(
	bool HasThis,
	TypeSigDto PropertyType,
	IReadOnlyList<TypeSigDto> Parameters,
	string Display = "");

/// <summary>A call target: the declaring type, the name, and the signature, which together identify it.</summary>
public sealed record MethodRefDto(
	TypeSigDto DeclaringType,
	string Name,
	MethodSigDto Signature,
	string Display = "");

public static class CaValueKinds {
	public const string Null = "null";
	public const string Primitive = "primitive";
	public const string String = "string";
	public const string Type = "type";
	public const string Array = "array";
	public const string Struct = "struct";
}

/// <summary>
/// A custom-attribute argument value. dnlib types the value by the argument's own <c>Type</c>, so a
/// primitive only has to carry its digits — <paramref name="Primitive"/> holds them as invariant
/// text, which keeps every numeric width intact through JSON.
/// </summary>
/// <param name="ElementType">
/// For a <see cref="CaValueKinds.Primitive"/> value, dnlib's <c>ElementType</c> of the boxed value
/// itself. An enum argument is declared as the enum but holds a primitive, and a boxed one is declared
/// as <c>System.Object</c> and holds whatever was boxed, so the declared type alone does not say how to
/// read the digits back.
/// </param>
public sealed record CaValueDto(
	string Kind,
	string? Primitive = null,
	string? Text = null,
	TypeSigDto? ReferencedType = null,
	IReadOnlyList<CaArgumentDto>? Elements = null,
	int ElementType = 0);

public sealed record CaArgumentDto(TypeSigDto Type, CaValueDto Value);

public sealed record CaNamedArgumentDto(bool IsField, string Name, CaArgumentDto Argument);

/// <summary>
/// A custom attribute. The constructor's signature decides how many constructor arguments there are
/// and what type each one is — dnSpy's <c>CustomAttributeVM</c> rebuilds that list whenever the
/// constructor changes — so only the values are carried.
/// </summary>
public sealed record CustomAttributeDto(
	MethodRefDto Constructor,
	IReadOnlyList<CaArgumentDto> ConstructorArguments,
	IReadOnlyList<CaNamedArgumentDto> NamedArguments,
	string Display = "");

/// <summary>A Constant row. <paramref name="ElementType"/> is dnlib's <c>ElementType</c> as an int.</summary>
public sealed record ConstantDto(int ElementType, string? Value, string Display = "");

public sealed record GenericParamConstraintDto(
	TypeSigDto Constraint,
	IReadOnlyList<CustomAttributeDto> CustomAttributes,
	string Display = "");

public sealed record GenericParamDto(
	int Number,
	int Flags,
	string Name,
	TypeSigDto? Kind,
	IReadOnlyList<GenericParamConstraintDto> Constraints,
	IReadOnlyList<CustomAttributeDto> CustomAttributes,
	string Display = "");

/// <summary>
/// A security attribute as a <c>DeclSecurity</c> row stores it. Unlike a custom attribute it has no
/// constructor: the type is the attribute itself and every value is a named field or property.
/// </summary>
public sealed record SecurityAttributeDto(
	TypeSigDto AttributeType,
	IReadOnlyList<CaNamedArgumentDto> NamedArguments,
	string Display = "");

/// <summary>A DeclSecurity row: the action plus either the parsed attributes or the raw .NET 1.x XML.</summary>
public sealed record DeclSecurityDto(
	int Action,
	IReadOnlyList<CustomAttributeDto> CustomAttributes,
	IReadOnlyList<SecurityAttributeDto> SecurityAttributes,
	string? V1XmlString = null,
	string Display = "");

public sealed record ImplMapDto(
	int Attributes,
	string Name,
	string? ModuleName,
	string Display = "");

/// <summary>
/// A MarshalType. <paramref name="NativeType"/> is dnlib's <c>NativeType</c> and picks which of the
/// payload fields apply — the same eight cases <c>MarshalTypeVM</c> switches over. A null
/// <paramref name="Size"/>, <paramref name="ParamNumber"/>, <paramref name="NumberOfElements"/>,
/// <paramref name="Flags"/>, <paramref name="IidParamIndex"/> or <paramref name="VariantType"/> is the
/// field's own "not present" state, which dnlib reports through the matching <c>Is…Valid</c> property.
/// </summary>
public sealed record MarshalTypeDto(
	int NativeType,
	string? RawData = null,
	int? Size = null,
	int? VariantType = null,
	TypeSigDto? UserDefinedSubType = null,
	int? ElementType = null,
	int? ParamNumber = null,
	int? NumberOfElements = null,
	int? Flags = null,
	string? Guid = null,
	string? NativeTypeName = null,
	TypeSigDto? CustomMarshaler = null,
	string? Cookie = null,
	int? IidParamIndex = null,
	string Display = "");

/// <summary>
/// A <c>MethodImpl</c> row. The body may be left out: a dialog that adds one only knows which method is
/// being overridden, and the row's body is by construction the method being edited.
/// </summary>
public sealed record MethodOverrideDto(
	MethodRefDto? MethodBody,
	MethodRefDto MethodDeclaration,
	string Display = "");

public sealed record ParamDefDto(
	string Name,
	int Sequence,
	int Attributes,
	ConstantDto? Constant,
	MarshalTypeDto? MarshalType,
	IReadOnlyList<CustomAttributeDto> CustomAttributes,
	string Display = "");

public sealed record TypeDefOrRefAndCaDto(
	TypeSigDto TypeDefOrRef,
	IReadOnlyList<CustomAttributeDto> CustomAttributes,
	string Display = "");

public static class NodeOptionKinds {
	public const string Type = "type";
	public const string Method = "method";
	public const string Field = "field";
	public const string Property = "property";
	public const string Event = "event";
}

public sealed record TypeOptionsDto(
	int Attributes,
	string Namespace,
	string Name,
	uint? PackingSize,
	uint? ClassSize,
	TypeSigDto? BaseType,
	IReadOnlyList<CustomAttributeDto> CustomAttributes,
	IReadOnlyList<DeclSecurityDto> DeclSecurities,
	IReadOnlyList<GenericParamDto> GenericParameters,
	IReadOnlyList<TypeDefOrRefAndCaDto> Interfaces,
	// How many generic parameters the type has itself. No page edits it; it is read-only context the base
	// type's editor gates its Var button on — dnSpy hands the type being edited over as the signature
	// creator's OwnerType — and it is absent while creating one, where dnSpy hands over nothing and every
	// Var is allowed.
	int? TypeGenericParameterCount = null,
	// The simple name of the module's corlib, which is the scope a base type carries when it comes from
	// there. dnSpy's Kind combo reads the base type back to tell a class from a struct, an enum and a
	// delegate, and it asks whether that type's assembly is the corlib as it does so: a type that merely
	// happens to be called System.Object is a plain class, not a static one. The dialog cannot ask that
	// on its own, so the answer travels with the model.
	string? CorLibScope = null);

public sealed record MethodOptionsDto(
	int ImplAttributes,
	int Attributes,
	int SemanticsAttributes,
	string Name,
	MethodSigDto? MethodSig,
	ImplMapDto? ImplMap,
	IReadOnlyList<CustomAttributeDto> CustomAttributes,
	IReadOnlyList<DeclSecurityDto> DeclSecurities,
	IReadOnlyList<ParamDefDto> ParamDefs,
	IReadOnlyList<GenericParamDto> GenericParameters,
	IReadOnlyList<MethodOverrideDto> Overrides,
	uint Rva = 0,
	// How many generic parameters the declaring type has. No page edits it; it is read-only context the
	// signature editor needs, and dnSpy takes it from the live type rather than from its options class.
	int OwnerGenericParameterCount = 0);

public sealed record FieldOptionsDto(
	int Attributes,
	string Name,
	TypeSigDto? FieldSig,
	uint? FieldOffset,
	MarshalTypeDto? MarshalType,
	string? InitialValue,
	ImplMapDto? ImplMap,
	ConstantDto? Constant,
	IReadOnlyList<CustomAttributeDto> CustomAttributes,
	uint Rva = 0,
	// How many generic parameters the declaring type has. Read-only context for the signature editor, and
	// read off the live type the way the method dialog's copy of it is.
	int OwnerGenericParameterCount = 0);

public sealed record PropertyOptionsDto(
	int Attributes,
	string Name,
	PropertySigDto? PropertySig,
	ConstantDto? Constant,
	IReadOnlyList<AccessorRefDto> GetMethods,
	IReadOnlyList<AccessorRefDto> SetMethods,
	IReadOnlyList<AccessorRefDto> OtherMethods,
	IReadOnlyList<CustomAttributeDto> CustomAttributes,
	// How many generic parameters the declaring type has. Read-only context for the signature editor, and
	// read off the live type the way the method and field dialogs' copies of it are.
	int OwnerGenericParameterCount = 0);

public sealed record EventOptionsDto(
	int Attributes,
	string Name,
	TypeSigDto? EventType,
	AccessorRefDto? AddMethod,
	AccessorRefDto? InvokeMethod,
	AccessorRefDto? RemoveMethod,
	IReadOnlyList<AccessorRefDto> OtherMethods,
	IReadOnlyList<CustomAttributeDto> CustomAttributes,
	// How many generic parameters the declaring type has, read off the live type the way the method and
	// field dialogs' copies of it are: the event type's editor gates its Var button on it.
	int OwnerGenericParameterCount = 0);

/// <summary>
/// Every dialog's model, discriminated by <paramref name="Kind"/>. Only the member matching the kind
/// is set; the others are null.
/// </summary>
public sealed record NodeOptionsDto(
	string Kind,
	TypeOptionsDto? Type = null,
	MethodOptionsDto? Method = null,
	FieldOptionsDto? Field = null,
	PropertyOptionsDto? Property = null,
	EventOptionsDto? Event = null)
{
	public static NodeOptionsDto OfType(TypeOptionsDto options) => new(NodeOptionKinds.Type, Type: options);
	public static NodeOptionsDto OfMethod(MethodOptionsDto options) => new(NodeOptionKinds.Method, Method: options);
	public static NodeOptionsDto OfField(FieldOptionsDto options) => new(NodeOptionKinds.Field, Field: options);
	public static NodeOptionsDto OfProperty(PropertyOptionsDto options) => new(NodeOptionKinds.Property, Property: options);
	public static NodeOptionsDto OfEvent(EventOptionsDto options) => new(NodeOptionKinds.Event, Event: options);
}

public sealed record GetNodeOptionsRequest(
	string WorkspaceId,
	string Kind,
	string? NodeId = null,
	string? OwnerNodeId = null,
	bool IsNew = false,
	// Whether the type is being created inside another one, which only the type kind reads. dnSpy has a
	// command for each: Create Type puts a type at the top level whatever is selected, while Create Nested
	// Type puts it in the selected type — or in the type the selected member belongs to — and gives it no
	// namespace of its own.
	bool Nested = false);

public sealed record CreateNodeRequest(
	string WorkspaceId,
	string TransactionId,
	string OwnerNodeId,
	NodeOptionsDto Options,
	// The same flag the dialog was opened with: it is what says which list the new type joins.
	bool Nested = false);

public sealed record SetNodeOptionsRequest(
	string WorkspaceId,
	string TransactionId,
	string NodeId,
	NodeOptionsDto Options);

/// <summary>
/// The node a create- or edit-command was queued for, and the name it will have. Sent back by the
/// queue calls so the client can reveal the node it just created once the commit lands.
/// </summary>
public sealed record EditNodeResponse(string NodeId, string Label, string Kind);

public sealed record SaveModuleResponse(string Path, long Length, string Sha256);

/// <summary>
/// A launch request from the client. The host fields mirror the upstream CoreCLR page's
/// "Use host executable" checkbox: <paramref name="UseHost"/> true starts the target through
/// <paramref name="Host"/> as <c>host hostArgs program args</c>, false runs <paramref name="Program"/>
/// itself (which must then be a native host, eg. an apphost), and null keeps the engine's own
/// extension guess — a .dll through the host, anything else directly. <paramref name="HostArguments"/>
/// are the host's own arguments, eg. <c>exec</c> for the <c>dotnet</c> CLI.
/// </summary>
public sealed record DebugLaunchRequest(
	string Program,
	IReadOnlyList<string>? Arguments = null,
	string? WorkingDirectory = null,
	bool StopAtEntry = false,
	IReadOnlyDictionary<string, string>? Environment = null,
	string? WorkspaceId = null,
	string? BreakKind = null,
	bool? UseHost = null,
	string? Host = null,
	IReadOnlyList<string>? HostArguments = null);

public sealed record DebugProcessDto(int ProcessId, string Name, string? ExecutablePath);

public sealed record DebugModuleDto(string Id, string Name, string Path, string? Version = null, string? SymbolStatus = null);

public sealed record DebugAttachRequest(int ProcessId, string? WorkspaceId = null);

public sealed record DebugStartResponse(string SessionId, JsonElement Capabilities);

public sealed record DebugAdapterRequest(string SessionId, string Command, JsonElement? Arguments = null);

public sealed record DebugAdapterResponse(JsonElement? Body);

public sealed record DebugDisconnectRequest(string SessionId, bool TerminateDebuggee = false);

public sealed record DebugEventNotification(string SessionId, string Event, JsonElement? Body);

public sealed record ScriptEvaluateRequest(string Code);

/// <summary>
/// One line of the C# Interactive window. <paramref name="Kind"/> is one of the
/// <see cref="ScriptOutputEntry"/> constants and picks the colour the client paints it in.
/// </summary>
public sealed record ScriptOutputEntry(string Kind, string Text) {
	/// <summary>Something the script printed — <c>PrintLine</c>, or the script's own <c>Console</c>.</summary>
	public const string Output = "output";

	/// <summary>The value a submission evaluated to, formatted by the C# object formatter.</summary>
	public const string Result = "result";

	/// <summary>A compiler diagnostic or a runtime exception.</summary>
	public const string Error = "error";

	/// <summary>The engine banner shown when the session is built or rebuilt.</summary>
	public const string Banner = "banner";
}

public sealed record ScriptEvaluateResponse(IReadOnlyList<ScriptOutputEntry> Entries);

/// <summary>
/// A breakpoint the client asked for, expressed in decompiled-source coordinates. A breakpoint that
/// outlived the workspace which issued its <see cref="NodeId"/> — one restored from settings, or one
/// imported from a file — also carries the IL identity it was saved with, so it can be resolved
/// without the node id ever having been valid in this workspace.
/// </summary>
public sealed record BreakpointQuery(
	string Id,
	string NodeId,
	int Line,
	int? Column = null,
	string? ModulePath = null,
	int? MetadataToken = null,
	int? SourceMethodToken = null,
	int? IlOffset = null);

/// <summary>The IL identity of a breakpoint, after snapping the requested line to a sequence point.</summary>
public sealed record ResolvedBreakpoint(
	string Id,
	bool Bound,
	string? Reason,
	string? ModulePath,
	int? MetadataToken,
	int? SourceMethodToken,
	int? IlOffset,
	int? SequencePointIlOffset,
	int StartLine,
	int EndLine,
	int StartColumn,
	int EndColumn,
	string? Description);

public sealed record ResolveBreakpointsRequest(string WorkspaceId, IReadOnlyList<BreakpointQuery> Queries);

public sealed record ResolveBreakpointsResponse(IReadOnlyList<ResolvedBreakpoint> Breakpoints);

/// <summary>The decompiled line(s) a stopped IL location maps to, so the client can reveal it.</summary>
/// <param name="Description">
/// The method's dnlib full name, which the breakpoint UI parses; <paramref name="StackFrameName"/> is
/// the same method the way the Call Stack window writes it, for display only.
/// </param>
public sealed record ResolvedIlLocation(
	string? NodeId,
	string? Description,
	string StackFrameName,
	string ModulePath,
	int MetadataToken,
	int StartLine,
	int EndLine,
	int StartColumn,
	int EndColumn,
	int IlOffset,
	int IlEndOffset,
	bool IsHidden,
	bool IsExternalModule);

/// <summary>The IL identity of a method, used for method-level (function) breakpoints.</summary>
public sealed record MethodIlInfoResponse(
	string? NodeId,
	string Description,
	string ModulePath,
	int SourceMethodToken,
	int BodyMetadataToken,
	int FirstIlOffset,
	int CodeSize,
	bool HasBody);

/// <summary>
/// One local or argument of a method body, named the way the decompiler prints it. Debuggees without
/// a PDB carry no names at all, so the engine matches these by slot instead of by symbol.
/// </summary>
/// <param name="Index">
/// The index the engine uses: a local slot for a local, an argument index for an argument — where 0
/// is the first argument and, in an instance method, <c>this</c>.
/// </param>
public sealed record DebugVariableNameDto(string Name, string TypeName, int Index, bool IsArgument);

/// <summary>An IL location a step can land on, spelled the way the engine arms a breakpoint.</summary>
public sealed record SteppingTarget(string ModulePath, int MetadataToken, int IlOffset);

/// <summary>
/// Where a step out of a given location can land: the statements of the body it is in, and — for a
/// step into — the statements of each method the location calls. Stepping is driven by breakpoints on
/// these locations rather than by stepping one IL instruction at a time, because without symbols the
/// runtime stops inside statements rather than between them.
/// </summary>
/// <param name="Targets">
/// Every statement a step may land on, whether it is ahead of the location in IL or behind it: the
/// runtime reports the one the thread reaches first, which is the only order a loop obeys.
/// </param>
/// <param name="LeavesMethod">
/// Set when no statement of the body can run again before the method returns, so the step has to
/// leave it — the statements a caller resumes at are not the ones a body maps to.
/// </param>
public sealed record SteppingTargetsResponse(IReadOnlyList<SteppingTarget> Targets, bool LeavesMethod = false);

/// <summary>
/// Bridges the debug engine to the decompiler: the engine speaks IL offsets and metadata tokens,
/// the client speaks tree node IDs and decompiled line numbers.
/// </summary>
public interface IDebugSymbolResolver {
	/// <summary>Snaps requested source lines to the sequence point that owns them.</summary>
	Task<ResolveBreakpointsResponse> ResolveBreakpointsAsync(string workspaceId, IReadOnlyList<BreakpointQuery> queries, CancellationToken cancellationToken);

	/// <summary>Maps a stopped <c>(module, token, IL offset)</c> back to decompiled coordinates for highlighting.</summary>
	Task<ResolvedIlLocation?> ResolveIlLocationAsync(string? workspaceId, string modulePath, int metadataToken, int ilOffset, CancellationToken cancellationToken);

	/// <summary>Returns the IL identity of a method when the module is known.</summary>
	Task<MethodIlInfoResponse?> GetMethodIlInfoAsync(string workspaceId, string modulePath, int metadataToken, CancellationToken cancellationToken);

	/// <summary>Finds methods by decompiled name, for method-level (function) breakpoints.</summary>
	Task<IReadOnlyList<MethodIlInfoResponse>> FindMethodsAsync(string? workspaceId, string name, CancellationToken cancellationToken);

	/// <summary>The local and argument names of a method body, so a value can be shown by name.</summary>
	Task<IReadOnlyList<DebugVariableNameDto>> GetVariableNamesAsync(string? workspaceId, string modulePath, int metadataToken, CancellationToken cancellationToken);

	/// <summary>
	/// The sequence points a step from <paramref name="ilOffset"/> can land on, plus the methods that
	/// location calls when <paramref name="stepInto"/> is set. Returns <c>null</c> when the location
	/// cannot be mapped, in which case the engine falls back to asking the runtime to step.
	/// </summary>
	Task<SteppingTargetsResponse?> GetSteppingTargetsAsync(string? workspaceId, string modulePath, int metadataToken, int ilOffset, bool stepInto, CancellationToken cancellationToken);

	/// <summary>
	/// True when a module is one of the workspace's own — code the user opened. Frames elsewhere are
	/// named from their metadata, and their decompiled line is never looked up.
	/// </summary>
	Task<bool> IsWorkspaceModuleAsync(string? workspaceId, string modulePath, CancellationToken cancellationToken);
}

public sealed class RpcRequest {
	[JsonPropertyName("jsonrpc")]
	public string JsonRpc { get; init; } = "2.0";

	[JsonPropertyName("id")]
	public JsonElement? Id { get; init; }

	[JsonPropertyName("method")]
	public string Method { get; init; } = string.Empty;

	[JsonPropertyName("params")]
	public JsonElement? Params { get; init; }
}

public sealed record RpcError(int Code, string Message, object? Data = null);

public sealed class RpcResponse {
	[JsonPropertyName("jsonrpc")]
	public string JsonRpc { get; init; } = "2.0";

	[JsonPropertyName("id")]
	public JsonElement? Id { get; init; }

	[JsonPropertyName("result")]
	[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
	public object? Result { get; init; }

	[JsonPropertyName("error")]
	[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
	public RpcError? Error { get; init; }
}

public sealed class RpcException : Exception {
	public RpcException(int code, string message, object? data = null, Exception? innerException = null)
		: base(message, innerException) {
		Code = code;
		DataValue = data;
	}

	public int Code { get; }
	public object? DataValue { get; }
}

// The records below are appended to this file on purpose. This assembly is also the file the end-to-end
// tests open as a fixture, so its metadata tokens are pinned in assertions ("HelloRequest @02000005",
// "get_Code() : int @06000896"): a type or a method added *before* those rows would shift every token
// after it and break them, while one added here — after every type in the file — cannot.

/// <summary>Which of a module's two notable members the caller wants the node of.</summary>
public static class SpecialNodeKinds {
	/// <summary>The module's entry point method.</summary>
	public const string EntryPoint = "entryPoint";
	/// <summary>The static constructor of the module's global type.</summary>
	public const string GlobalCctor = "globalCctor";
}

/// <summary>Asks for one of a module's special nodes — what dnSpy's "Go to Entry Point" and "Go to
/// Global Cctor" navigate to. The node names the module, and any node inside it will do.</summary>
public sealed record SpecialNodeRequest(string WorkspaceId, string NodeId, string Kind);

/// <summary>The node that was asked for, or null when the module has none: an assembly with no entry
/// point, or one whose global type carries no static constructor.</summary>
public sealed record SpecialNodeResponse(string? NodeId);

/// <summary>Asks for the node a metadata token names — dnSpy's "Go to Token". The token is accepted the
/// way the tree writes it ("0x06000001") or as bare hexadecimal.</summary>
public sealed record FindByTokenRequest(string WorkspaceId, string NodeId, string Token);

/// <summary>The node the token names, or null when it names no row the tree shows — and then the
/// message dnSpy's box shows for it: an invalid token, or a reference that does not resolve.</summary>
public sealed record FindByTokenResponse(string? NodeId, string? Error = null);

/// <summary>
/// What is left after an assembly is removed, plus the ids of the nodes that went with it. A client holds
/// documents and a selection by node id, so it needs to be told which of them the removal took; the ids
/// are never handed out again, so one the client still holds names nothing rather than something else.
/// </summary>
/// <summary>
/// What a removal took out of the tree. A document an edit in the undo history touched is not let go: its
/// removal is recorded as an edit of its own, which Undo reverses, the way dnSpy's RemoveAssemblyCommand
/// does — <see cref="CanUndo"/> and <see cref="CanRedo"/> are the history after the removal.
/// </summary>
public sealed record RemoveModuleResponse(IReadOnlyList<string> RemovedNodeIds, IReadOnlyList<TreeNodeDto> Roots, bool CanUndo = false, bool CanRedo = false);

/// <summary>Asks for the bytes one resource node holds, for dnSpy's two Save commands. The node may be
/// the resource itself or a single entry inside a .resources file.</summary>
public sealed record ResourceDataRequest(string WorkspaceId, string NodeId, bool Raw = false);

/// <summary>The bytes to save, and the name the file should be saved under. The bytes travel base64
/// because a resource is not text and JSON-RPC carries strings.</summary>
public sealed record ResourceDataResponse(string Name, string Base64Data);

/// <summary>Asks for the assemblies a module's references name to be opened as documents of their own —
/// dnSpy's Load Dependencies. The recursive form follows the closure instead of stopping at the module's
/// own references. The node names which module to start from; any node inside it will do.</summary>
public sealed record LoadDependenciesRequest(string WorkspaceId, string NodeId, bool Recursive);

/// <summary>Queues one of dnSpy's two Convert commands. `ToAssembly` says which way: true gives a module
/// without an assembly a fresh one named after its file, false detaches an assembly's only module and
/// leaves it a net module. The node names the module to convert; any node inside it will do.</summary>
public sealed record ConvertModuleRequest(string WorkspaceId, string TransactionId, string NodeId, bool ToAssembly);

/// <summary>
/// The searches dnSpy's analyzer offers under a member, by the key a search row carries. Which of them a
/// member gets follows the member's kind and shape — WPF's <c>CanShow</c> rules — and the backend says so
/// by listing exactly those rows; a key that does not apply to the member is refused.
/// </summary>
public static class AnalyzerSearchKinds {
	public const string Uses = "uses";
	public const string UsedBy = "usedBy";
	public const string Overrides = "overrides";
	public const string OverriddenBy = "overriddenBy";
	public const string ImplementedBy = "implementedBy";
	public const string ReadBy = "readBy";
	public const string AssignedBy = "assignedBy";
	public const string RaisedBy = "raisedBy";
	public const string AppliedTo = "appliedTo";
	public const string InstantiatedBy = "instantiatedBy";
	public const string ExposedBy = "exposedBy";
	public const string Subtypes = "subtypes";
	public const string ExtensionMethods = "extensionMethods";
}

/// <summary>Asks for the analyzer rows of tree nodes — what dnSpy adds to its analyzer when a member is
/// analyzed. Several are asked at once so a client can check every row it holds after the workspace
/// changed, or write them anew in another language. <see cref="Language"/> is the decompiler the rows are
/// written through, the way dnSpy's analyzer nodes write themselves through the one selected.</summary>
public sealed record AnalyzeNodesRequest(string WorkspaceId, IReadOnlyList<string> NodeIds, DecompilerLanguage Language = DecompilerLanguage.CSharp);

/// <summary>One row per node asked for, in the same order. A node that cannot be analyzed — it is not a
/// member, or the member it named is gone — answers null rather than failing the whole request.</summary>
public sealed record AnalyzeNodesResponse(IReadOnlyList<AnalyzerNodeDto?> Nodes);

/// <summary>
/// Asks for what an analyzer row expands to. Without <see cref="Search"/> that is the member's own rows —
/// its searches and, for a property or an event, its accessors; with one, it is what that search finds.
/// <see cref="IsSetter"/> is the flag the property's "set" row carries, which widens the setter's "Used
/// By" to the attributes that assign the property by name. A search asked with a
/// <see cref="ProgressToken"/> sends what it finds ahead, in <see cref="RpcMethods.AnalyzeProgress"/>
/// notifications that carry the token back. A search has no limit of its own, as dnSpy's has none;
/// <see cref="MaxResults"/> is for a client that wants one.
/// <see cref="Language"/> is the decompiler the rows are written through, and with
/// <see cref="DecompileAnonymousMethods"/> it decides what a result found in a lambda or a state machine is
/// shown as: the method the code was written in, which only the C# decompiler with that setting on shows.
/// </summary>
public sealed record AnalyzeChildrenRequest(string WorkspaceId, string NodeId, string? Search = null, bool IsSetter = false, int MaxResults = int.MaxValue, string? ProgressToken = null, DecompilerLanguage Language = DecompilerLanguage.CSharp, bool DecompileAnonymousMethods = true);

/// <summary>The rows, in the order the search found them, and whether the search stopped at the limit.
/// <see cref="Start"/> is where the first of them stands among everything the search found: the rows
/// sent ahead in progress notifications come before it.</summary>
public sealed record AnalyzeChildrenResponse(IReadOnlyList<AnalyzerNodeDto> Children, bool Truncated, int Start = 0);

/// <summary>
/// One row of dnSpy's analyzer tree.
/// </summary>
/// <param name="Kind">type, method, field, property, event, assembly, module, or search for a row that runs a search.</param>
/// <param name="Label">The row's text without the token or the "(hides)" prefix, which the client adds. A search row carries its English header.</param>
/// <param name="HasChildren">Whether the row can be expanded: every member and search row, never an assembly or a module.</param>
/// <param name="NodeId">The tree node of the member the row names; for a search row, the member it searches for. Null when the row names something the tree has no node for.</param>
/// <param name="Search">The search a search row runs.</param>
/// <param name="Accessor">The keyword an accessor row is written as: get, set, add, remove or raise.</param>
/// <param name="IsSetter">Carried by a property's "set" row and the searches under it.</param>
/// <param name="HidesParent">The member hides the one it was found for rather than overriding it.</param>
/// <param name="FullName">The member's full name, for Copy Full Name and Search MSDN.</param>
/// <param name="IsPublic">Whether the member is visible outside its assembly, which is when dnSpy offers Search MSDN.</param>
/// <param name="Source">Where in a method body the row was found, when it was found there.</param>
/// <param name="LabelParts">The label cut where dnSpy's syntax highlighting changes color; none for a search row.</param>
public sealed record AnalyzerNodeDto(
	string Kind,
	string Label,
	bool HasChildren,
	string? NodeId = null,
	string? Icon = null,
	int? MetadataToken = null,
	string? Search = null,
	string? Accessor = null,
	bool IsSetter = false,
	bool HidesParent = false,
	string? FullName = null,
	bool IsPublic = false,
	AnalyzerSourceDto? Source = null,
	IReadOnlyList<TextPartDto>? LabelParts = null);

/// <summary>
/// The place in a method body a search result was found at — dnSpy's SourceRef. The method is the document
/// "Show Reference in Method" opens; the offset is the instruction, absent when the result was found in the
/// method's locals or handlers rather than in an instruction. <see cref="Targets"/> are what that instruction
/// refers to, written the way a decompiled document's spans write their targets, so the caret can be put on
/// the reference itself.
/// </summary>
public sealed record AnalyzerSourceDto(string MethodNodeId, string ModulePath, int MethodToken, int? IlOffset, IReadOnlyList<AnalyzerTargetDto> Targets);

/// <summary>A member a reference may name: by node when it lives in a module the workspace holds, by file and
/// token when it does not — the two ways <see cref="TextSpanDto"/> names a target.</summary>
public sealed record AnalyzerTargetDto(string? NodeId, string? ModulePath = null, int? MetadataToken = null);

/// <summary>
/// The params of an <see cref="RpcMethods.AnalyzeProgress"/> notification: rows a search found while it was
/// still running, for the request that named <see cref="ProgressToken"/>. <see cref="Start"/> is where the
/// first of them stands among everything the search found, so a client can tell a batch it already holds.
/// </summary>
public sealed record AnalyzeProgressNotification(string ProgressToken, int Start, IReadOnlyList<AnalyzerNodeDto> Children);

/// <summary>A stretch of a row's text, and the color class dnSpy's syntax highlighting writes it in — one of
/// <see cref="TextColors"/>.</summary>
public sealed record TextPartDto(string Text, string Color);

/// <summary>
/// The color classes of dnSpy's tree text, named after its <c>BoxedTextColor</c> members: what a keyword,
/// a namespace, a type of each kind or a member of each kind is written in. The client maps them to the
/// colors of its theme.
/// </summary>
public static class TextColors {
	public const string Text = "text";
	public const string Punctuation = "punctuation";
	public const string Operator = "operator";
	public const string Keyword = "keyword";
	public const string Number = "number";
	public const string Error = "error";
	public const string Namespace = "namespace";
	public const string Type = "type";
	public const string SealedType = "sealedType";
	public const string StaticType = "staticType";
	public const string Interface = "interface";
	public const string ValueType = "valueType";
	public const string Enum = "enum";
	public const string Delegate = "delegate";
	public const string TypeGenericParameter = "typeGenericParameter";
	public const string MethodGenericParameter = "methodGenericParameter";
	public const string InstanceMethod = "instanceMethod";
	public const string StaticMethod = "staticMethod";
	public const string ExtensionMethod = "extensionMethod";
	public const string InstanceField = "instanceField";
	public const string EnumField = "enumField";
	public const string LiteralField = "literalField";
	public const string StaticField = "staticField";
	public const string InstanceProperty = "instanceProperty";
	public const string StaticProperty = "staticProperty";
	public const string InstanceEvent = "instanceEvent";
	public const string StaticEvent = "staticEvent";
	public const string Assembly = "assembly";
	public const string AssemblyExe = "assemblyExe";
	public const string AssemblyModule = "assemblyModule";
	/// <summary>The "[System.Runtime]" the IL decompiler writes in front of a type of another assembly.</summary>
	public const string ILModule = "ilModule";
	public const string Parameter = "parameter";
	public const string String = "string";
	public const string Char = "char";
	/// <summary>An IL instruction's opcode, and the label ("IL_0000") before it is <see cref="Label"/>.</summary>
	public const string OpCode = "opCode";
	/// <summary>A disassembler directive: ".property", ".event".</summary>
	public const string ILDirective = "ilDirective";
	public const string DirectoryPart = "directoryPart";
	public const string FileNameNoExtension = "fileNameNoExtension";
	public const string FileExtension = "fileExtension";
	// The colors only code has, which Roslyn's classifier and its tagged text use beside the ones above.
	/// <summary>The gray of the words dnSpy writes between names ("parameter", "attribute").</summary>
	public const string DarkGray = "darkGray";
	public const string Comment = "comment";
	public const string Local = "local";
	public const string Label = "label";
	public const string Module = "module";
	public const string VerbatimString = "verbatimString";
	public const string PreprocessorKeyword = "preprocessorKeyword";
	public const string PreprocessorText = "preprocessorText";
	public const string ExcludedCode = "excludedCode";
	public const string XmlDocCommentAttributeName = "xmlDocCommentAttributeName";
	public const string XmlDocCommentAttributeQuotes = "xmlDocCommentAttributeQuotes";
	public const string XmlDocCommentAttributeValue = "xmlDocCommentAttributeValue";
	public const string XmlDocCommentCDataSection = "xmlDocCommentCDataSection";
	public const string XmlDocCommentComment = "xmlDocCommentComment";
	public const string XmlDocCommentDelimiter = "xmlDocCommentDelimiter";
	public const string XmlDocCommentEntityReference = "xmlDocCommentEntityReference";
	public const string XmlDocCommentName = "xmlDocCommentName";
	public const string XmlDocCommentProcessingInstruction = "xmlDocCommentProcessingInstruction";
	public const string XmlDocCommentText = "xmlDocCommentText";
}

/// <summary>The keys of the search window's "Search For" box, one per entry of dnSpy's SearchType.</summary>
public static class SearchTypes {
	public const string Assembly = "assembly";
	public const string Module = "module";
	public const string Namespace = "namespace";
	public const string Type = "type";
	public const string Field = "field";
	public const string Method = "method";
	public const string Property = "property";
	public const string Event = "event";
	public const string Parameter = "parameter";
	public const string Local = "local";
	public const string ParameterLocal = "parameterLocal";
	public const string AssemblyRef = "assemblyRef";
	public const string ModuleRef = "moduleRef";
	public const string Resource = "resource";
	public const string GenericType = "genericType";
	public const string NonGenericType = "nonGenericType";
	public const string Enum = "enum";
	public const string Interface = "interface";
	public const string Class = "class";
	public const string Struct = "struct";
	public const string Delegate = "delegate";
	public const string Member = "member";
	public const string Any = "any";
	public const string Literal = "literal";
}

/// <summary>The search window's location box — dnSpy's SearchLocation.</summary>
public static class SearchLocations {
	public const string AllFiles = "allFiles";
	public const string SelectedFiles = "selectedFiles";
	public const string AllFilesInSameDir = "allFilesInSameDir";
	public const string SelectedType = "selectedType";
}

/// <summary>The params of a <see cref="RpcMethods.SearchProgress"/> notification: results a search found
/// while it was still running. <see cref="Start"/> is where the first of them stands among everything found.</summary>
public sealed record SearchProgressNotification(string ProgressToken, int Start, IReadOnlyList<SearchResultDto> Results);

/// <summary>
/// Where a bookmark sits, the way WPF dnSpy names it: a module and a metadata token, plus the IL offset for a
/// spot inside a method body (dnSpy's <c>DotNetMethodBody</c> location). Without an offset it is the member
/// itself — the <c>DotNetToken</c> location a bookmark on a declaration line gets.
/// </summary>
public sealed record BookmarkLocationDto(string ModulePath, int MetadataToken, int? IlOffset);

/// <summary>The Bookmarks window's display options (dnSpy's BookmarkDisplaySettings), which the Location column is written with.</summary>
public sealed record BookmarkLocationFormatDto(
	bool ShowTokens,
	bool ShowModuleNames,
	bool ShowParameterTypes,
	bool ShowParameterNames,
	bool ShowDeclaringTypes,
	bool ShowReturnTypes,
	bool ShowNamespaces,
	bool ShowIntrinsicTypeKeywords);

/// <summary>
/// The Location column of the Bookmarks window for each of <see cref="Locations"/>. A module the workspace
/// holds is read through it, any other one from its file — a bookmark is listed whether or not its
/// assembly is open, and so is a request without a workspace.
/// </summary>
public sealed record FormatBookmarkLocationsRequest(string? WorkspaceId, IReadOnlyList<BookmarkLocationDto> Locations, BookmarkLocationFormatDto Format);

/// <summary>One location written out, in syntax-highlighting parts. <see cref="Resolved"/> is false when the
/// member could not be read — the text is then the token alone (or the token and "???"), as dnSpy writes it.</summary>
public sealed record BookmarkLocationTextDto(IReadOnlyList<TextPartDto> Parts, bool Resolved);

/// <summary>The locations of a <see cref="FormatBookmarkLocationsRequest"/>, in the order they were asked for.</summary>
public sealed record FormatBookmarkLocationsResponse(IReadOnlyList<BookmarkLocationTextDto> Locations);

/// <summary>
/// A bookmark as a bookmark file holds it. <paramref name="IlOffset"/> is null for a token location; the
/// description is what the file says the token named (WPF's TokenString) and is only read, never written.
/// </summary>
public sealed record BookmarkFileEntryDto(
	string ModulePath,
	int MetadataToken,
	int? IlOffset,
	string Name,
	IReadOnlyList<string> Labels,
	bool Enabled,
	string? Description = null);

/// <summary>Writes bookmarks in WPF dnSpy's XML settings format, so its Import Bookmarks reads the file back.</summary>
public sealed record ExportBookmarksRequest(string? WorkspaceId, IReadOnlyList<BookmarkFileEntryDto> Bookmarks);

public sealed record ExportBookmarksResponse(string Xml);

/// <summary>Reads a bookmark file WPF dnSpy exported — or its whole settings file, which holds the same section.</summary>
public sealed record ImportBookmarksRequest(string? WorkspaceId, string Xml);

/// <summary>The bookmarks a file held. <see cref="Skipped"/> counts the ones this port cannot take: in-memory or
/// dynamic modules, unknown location kinds, missing data, and tokens that no longer name what they named.</summary>
public sealed record ImportBookmarksResponse(IReadOnlyList<BookmarkFileEntryDto> Bookmarks, int Skipped);

/// <summary>Removes the documents the nodes belong to. Every node has to be a root — an assembly, a module
/// standing on its own, a PE, ELF or unknown document — the rule dnSpy's Remove command has.</summary>
public sealed record RemoveModulesRequest(string WorkspaceId, IReadOnlyList<string> NodeIds);

/// <summary>Asks which modules hold unsaved edits: those the nodes belong to, or all of them when no node is
/// named. dnSpy asks before a Remove or a Reload throws such edits away.</summary>
public sealed record ModifiedModulesRequest(string WorkspaceId, IReadOnlyList<string>? NodeIds = null);

/// <summary>The files of the modified modules the request was about.</summary>
public sealed record ModifiedModulesResponse(IReadOnlyList<string> Paths);

/// <summary>The roots the two Close All sweeps would remove: <see cref="FrameworkNodeIds"/> are the framework
/// DLLs (dnSpy's FrameworkFileUtils), <see cref="MissingNodeIds"/> the unknown documents — a file that is not
/// there any more, or one that is not a PE image.</summary>
public sealed record CloseCandidatesResponse(IReadOnlyList<string> FrameworkNodeIds, IReadOnlyList<string> MissingNodeIds);

/// <summary>Moves roots so they sit in front of the root that is at <see cref="Index"/> now, keeping their own
/// order — what dropping them there does. An index at the end, or past it, moves them to the end.</summary>
public sealed record MoveRootsRequest(string WorkspaceId, IReadOnlyList<string> NodeIds, int Index);

/// <summary>The dragged-items filter of the Assembly Explorer options: every file, every file that is a PE
/// image (dnSpy's default), or only .NET modules.</summary>
public static class DropFilters {
	public const string All = "all";
	public const string AllSupported = "allSupported";
	public const string DotNetOnly = "dotNetOnly";
}

/// <summary>
/// Files dropped on the tree. A directory stands for every file under it. The files are inserted in front of
/// the root at <see cref="Index"/>, sorted by name; a file that is open already is not opened again. With
/// more than one file the <see cref="Filter"/> leaves out what it does not accept. No workspace yet means
/// the drop opens one.
/// </summary>
public sealed record DropFilesRequest(string? WorkspaceId, IReadOnlyList<string> Paths, int Index, string Filter);

/// <summary>What the drop did: the workspace (made by the drop when there was none), the modules it now
/// holds, the files it added (which go on the recent files list), the root to select — the first file that
/// was added, or else the first dropped one that was open already — and whether the filter turned every
/// file away.</summary>
public sealed record DropFilesResponse(string? WorkspaceId, IReadOnlyList<OpenedModule> Modules, IReadOnlyList<string> AddedPaths, string? SelectNodeId, bool AllFiltered, string? StateId);

/// <summary>What activating a row leads to: the row to select instead, which may sit in a module the
/// workspace had to open first (<see cref="RootsChanged"/>). No node means the row is its own target.</summary>
public sealed record ActivateNodeResponse(string? NodeId, bool RootsChanged);

/// <summary>One assembly of a global assembly cache, read off the directory it sits in.</summary>
public sealed record GacAssemblyDto(string Name, string Version, string Culture, string PublicKeyToken, string Path);

public sealed record GacListResponse(IReadOnlyList<GacAssemblyDto> Assemblies);

public sealed record GacDetailsRequest(string Path);

/// <summary>Who made a GAC file and its file version, the two lines dnSpy's dialog adds for its selection.</summary>
public sealed record GacDetailsResponse(string? CreatedBy, string? FileVersion);

/// <summary>A list of files to open together, named the way dnSpy's DotnetReferenceFileFinder names one:
/// "Microsoft.NETCore.App 10.0.2 (x64)". The files are sorted by name.</summary>
public sealed record DocumentListDto(string Name, IReadOnlyList<string> Files);

public sealed record DocumentListsResponse(IReadOnlyList<DocumentListDto> Lists);

/// <summary>
/// The files the resource nodes save as. <see cref="Raw"/> is dnSpy's Raw Save: the bytes as they are stored —
/// the whole .resources file, an entry the way the resource writer encodes it. Without it an entry is saved as
/// its value (a string as UTF-8 text, an image as the image file, BAML as XAML) and a .resources file as one
/// file per entry. A resources folder stands for every resource in it.
/// </summary>
public sealed record ResourceItemsRequest(string WorkspaceId, IReadOnlyList<string> NodeIds, bool Raw);

/// <summary>The files to write; a name may carry a directory part, which the "use sub dirs" variant keeps.</summary>
public sealed record ResourceItemsResponse(IReadOnlyList<ResourceDataResponse> Items);

/// <summary>
/// What Go to Resource starts from: a property or method of a strongly typed resources class, as a node or —
/// for a reference in decompiled text — as the module and token it has there.
/// </summary>
public sealed record FindResourceRequest(string WorkspaceId, string? NodeId, string? ModulePath = null, int? MetadataToken = null);

/// <summary>The .resources entry the member reads, or null when it reads none this workspace can find.</summary>
public sealed record FindResourceResponse(string? NodeId);

/// <summary>The names the nodes save under with dnSpy's Save (<see cref="Names"/>) and Raw Save
/// (<see cref="RawNames"/>), without the bytes — the menu counts them and looks for a directory in them.</summary>
public sealed record ResourceItemNamesResponse(IReadOnlyList<string> Names, IReadOnlyList<string> RawNames);

/// <summary>
/// Reloads every file the user opened. A file the workspace opened by itself to resolve a reference comes back
/// only when it is one of <see cref="AutoLoadedPaths"/> — the ones a tab still shows something of, which dnSpy's
/// DocumentListLoader adds back so the tab can be restored.
/// </summary>
public sealed record ReloadWorkspaceRequest(string WorkspaceId, IReadOnlyList<string>? AutoLoadedPaths = null);

/// <summary>
/// The member a command line's <c>--select</c> names, looked up in the modules of the files it opened — dnSpy's
/// AppCommandLineArgsHandler: a number (decimal, or hexadecimal after "0x") is a token in the first of them; "N:"
/// names a namespace; anything else is an XML documentation id, read the Roslyn way and then the MSVC way.
/// </summary>
public sealed record SelectMemberRequest(string WorkspaceId, IReadOnlyList<string> Paths, string Member);

/// <summary>The node to follow, or null when the member names nothing in those files.</summary>
public sealed record SelectMemberResponse(string? NodeId);

/// <summary>
/// Scans for the strings dnSpy's String References window lists. <paramref name="NodeIds"/> are tree nodes whose
/// assemblies are scanned, every module of each; <paramref name="ModulePaths"/> are modules a scan read before,
/// which a refresh reads again. <paramref name="ShowAllMembers"/> is set when the current language shows the members
/// the compiler made (IL); C# and VB leave them out, as dnSpy's decompilers do.
/// </summary>
public sealed record StringReferencesSearchRequest(
	string WorkspaceId,
	IReadOnlyList<string>? NodeIds = null,
	IReadOnlyList<string>? ModulePaths = null,
	bool ShowAllMembers = false,
	string? ProgressToken = null);

/// <summary>
/// What a scan found, in the order it found it. <paramref name="Start"/> is where the first of them stands among
/// everything found: the ones sent ahead come before it. <paramref name="ModulePaths"/> are the modules scanned.
/// </summary>
public sealed record StringReferencesSearchResponse(IReadOnlyList<StringReferenceDto> References, int Start, IReadOnlyList<string> ModulePaths);

/// <summary>The params of a <see cref="RpcMethods.StringReferencesProgress"/> notification.</summary>
public sealed record StringReferencesProgressNotification(string ProgressToken, int Start, IReadOnlyList<StringReferenceDto> References);

/// <summary>dnSpy's StringReferenceKind, in its order.</summary>
public static class StringReferenceKinds {
	public const string IL = "il";
	public const string Constant = "constant";
	public const string Attribute = "attribute";
}

/// <summary>
/// One string and where it is. <paramref name="FormattedLiteral"/> is the string as a C# literal, verbatim when
/// <paramref name="IsVerbatim"/>. <paramref name="Token"/> is what the list sorts by after the kind — the method of
/// an <c>ldstr</c>, the member or parameter of a constant, the owner of an attribute — and <paramref name="IlOffset"/>
/// the instruction of an <c>ldstr</c>. <paramref name="NodeId"/> is the tree node following the row opens.
/// </summary>
public sealed record StringReferenceDto(
	string Kind,
	string Literal,
	string FormattedLiteral,
	bool IsVerbatim,
	IReadOnlyList<TextPartDto> ReferrerParts,
	string ReferrerIcon,
	string ModuleName,
	int Token,
	string? NodeId,
	int? IlOffset);

/// <summary>The C# Interactive window's input, to be colored against the session it will run in.</summary>
public sealed record ScriptClassifyRequest(string Code);

/// <summary>A stretch of code and the color class it is written in, one of <see cref="TextColors"/>.</summary>
public sealed record ClassifiedSpanDto(int Start, int Length, string Color);

/// <summary>The colored stretches of a text, in order; text between them keeps the editor's own color.</summary>
public sealed record ClassifyResponse(IReadOnlyList<ClassifiedSpanDto> Spans);

/// <summary>
/// What a code document compiles with — dnSpy's C# compiler settings page, whose defaults these are.
/// <paramref name="PreprocessorSymbols"/> is a list separated by ';' or ','.
/// </summary>
public sealed record CodeCompilerOptionsDto(
	bool Optimize = true,
	bool CheckOverflow = false,
	bool AllowUnsafe = true,
	string PreprocessorSymbols = "TRACE");

/// <summary>
/// Opens a C# code document. <paramref name="References"/> are the assemblies it compiles against; null means
/// the framework the host runs on, read from its reference pack when one is installed so that symbols have
/// their XML documentation.
/// </summary>
public sealed record CodeDocumentOpenRequest(string Text, IReadOnlyList<string>? References = null, CodeCompilerOptionsDto? Options = null);

public sealed record CodeDocumentOpenResponse(string DocumentId);

public sealed record CodeDocumentUpdateRequest(string DocumentId, string Text);

public sealed record CodeDocumentRequest(string DocumentId);

/// <summary>A document and an offset into its text.</summary>
public sealed record CodePositionRequest(string DocumentId, int Position);

/// <summary>A span of a document's text.</summary>
public sealed record CodeSpanDto(int Start, int Length);

/// <summary>Replace <paramref name="Length"/> characters at <paramref name="Start"/> with <paramref name="NewText"/>.</summary>
public sealed record CodeTextEditDto(int Start, int Length, string NewText);

/// <summary>
/// Asks for the completion list at <paramref name="Position"/>. <paramref name="TriggerCharacter"/> is the
/// character just typed; null means the list was asked for (Ctrl+Space). A typed character that Roslyn would
/// not open a list for gets an empty one.
/// </summary>
public sealed record CodeCompletionRequest(string DocumentId, int Position, string? TriggerCharacter = null);

/// <summary>
/// One completion item. <paramref name="Index"/> names it to <see cref="RpcMethods.LanguageServiceCompletionDescription"/>.
/// <paramref name="Edit"/> is what committing it does when that is more than putting <paramref name="InsertText"/>
/// over the list's span (an override, a member that needs a using); <paramref name="CommitCharacters"/> are the
/// characters that commit it as they are typed. <paramref name="Tags"/> are Roslyn's WellKnownTags.
/// </summary>
public sealed record CodeCompletionItemDto(
	int Index,
	string DisplayText,
	string DisplayTextPrefix,
	string DisplayTextSuffix,
	string InlineDescription,
	string FilterText,
	string SortText,
	string InsertText,
	IReadOnlyList<string> Tags,
	int MatchPriority,
	bool Preselect,
	string CommitCharacters,
	CodeTextEditDto? Edit = null);

/// <summary>
/// The completion list: <paramref name="Span"/> is the text the items replace and filter on.
/// <paramref name="SuggestionMode"/> is Roslyn's builder mode (a lambda parameter, a name being declared), where
/// typing never commits an item. <paramref name="ResultId"/> names the list to the description request.
/// </summary>
public sealed record CodeCompletionListDto(int ResultId, CodeSpanDto Span, bool SuggestionMode, IReadOnlyList<CodeCompletionItemDto> Items);

public sealed record CodeCompletionResponse(CodeCompletionListDto? List);

public sealed record CodeCompletionDescriptionRequest(string DocumentId, int ResultId, int Index);

/// <summary>An item's tooltip, in the colors of its tagged text; empty when the list is gone.</summary>
public sealed record CodeCompletionDescriptionResponse(IReadOnlyList<TextPartDto> Parts);

/// <summary>
/// One part of a Quick Info: <paramref name="Kind"/> is Roslyn's QuickInfoSectionKinds name — "Description",
/// "DocumentationComments", "TypeParameters", "AnonymousTypes", "Usage", "Exception" — the parts dnSpy shows.
/// </summary>
public sealed record CodeQuickInfoSectionDto(string Kind, IReadOnlyList<TextPartDto> Parts);

/// <summary>
/// What hovering over <paramref name="Span"/> shows. <paramref name="Glyph"/> is the dnSpy image of the symbol,
/// and <paramref name="Warning"/> is set when the symbol is not available in every target the code builds for.
/// </summary>
public sealed record CodeQuickInfoDto(CodeSpanDto Span, string? Glyph, bool Warning, IReadOnlyList<CodeQuickInfoSectionDto> Sections);

public sealed record CodeQuickInfoResponse(CodeQuickInfoDto? QuickInfo);

/// <summary>Asks for signature help; <paramref name="TriggerCharacter"/> is the character just typed, if any.</summary>
public sealed record CodeSignatureHelpRequest(string DocumentId, int Position, string? TriggerCharacter = null);

public sealed record CodeSignatureParameterDto(string Name, IReadOnlyList<TextPartDto> Display, IReadOnlyList<TextPartDto> Documentation, bool IsOptional);

/// <summary>
/// One signature, laid out the way Roslyn's SignatureHelpItem is: <paramref name="Prefix"/>, the parameters
/// joined by <paramref name="Separator"/>, then <paramref name="Suffix"/>.
/// </summary>
public sealed record CodeSignatureDto(
	IReadOnlyList<TextPartDto> Prefix,
	IReadOnlyList<TextPartDto> Separator,
	IReadOnlyList<TextPartDto> Suffix,
	IReadOnlyList<CodeSignatureParameterDto> Parameters,
	IReadOnlyList<TextPartDto> Documentation,
	bool IsVariadic);

/// <summary>
/// The signatures around a position. <paramref name="ApplicableSpan"/> is the argument list the session lasts
/// for; <paramref name="ArgumentIndex"/> is the argument the caret is in, <paramref name="ArgumentName"/> its
/// name when it is a named argument, and <paramref name="SelectedItem"/> the overload the arguments pick.
/// </summary>
public sealed record CodeSignatureHelpDto(
	CodeSpanDto ApplicableSpan,
	int ArgumentIndex,
	int ArgumentCount,
	string? ArgumentName,
	int SelectedItem,
	IReadOnlyList<CodeSignatureDto> Items);

public sealed record CodeSignatureHelpResponse(CodeSignatureHelpDto? Help);

/// <summary>
/// One compiler message, the way dnSpy's code editor lists it: <paramref name="Severity"/> is "error",
/// "warning" or "info", <paramref name="HelpUri"/> the page the id links to. Lines and columns are 0-based.
/// </summary>
public sealed record CodeDiagnosticDto(
	string Id,
	string Severity,
	string Message,
	string HelpUri,
	int Start,
	int Length,
	int StartLine,
	int StartColumn,
	int EndLine,
	int EndColumn);

public sealed record CodeDiagnosticsResponse(IReadOnlyList<CodeDiagnosticDto> Diagnostics);

/// <summary>Asks how far a line (0-based) should be indented, in the editor's indentation settings.</summary>
public sealed record CodeIndentationRequest(string DocumentId, int Line, int IndentSize = 4, int TabSize = 4, bool UseTabs = false);

/// <summary>The column the line's text should start at, or null to keep the editor's own indentation.</summary>
public sealed record CodeIndentationResponse(int? Indentation);

public sealed record CodeSelectionRangesRequest(string DocumentId, IReadOnlyList<int> Positions);

/// <summary>For each position, the spans of the token and of every node around it, innermost first.</summary>
public sealed record CodeSelectionRangesResponse(IReadOnlyList<IReadOnlyList<CodeSpanDto>> Ranges);

/// <summary>One statement of a method body as the decompiler writes it, with the IL it covers.</summary>
public sealed record SourceStatementDto(int IlOffset, int IlEndOffset, int MetadataToken, string Text, bool IsHidden);

/// <summary>One IL instruction of a method body, written the way the IL view writes it.</summary>
public sealed record IlLineDto(int Offset, string Text);

/// <summary>
/// A method body's source and IL, for what the debugger shows beside native code — the Disassembly view's
/// comments — and for the Autos window, which reads the names the current statements use.
/// </summary>
public sealed record MethodSourceDto(string Name, IReadOnlyList<SourceStatementDto> Statements, IReadOnlyList<IlLineDto> Instructions);

/// <summary>
/// The decompiler services the debugger needs beyond <see cref="IDebugSymbolResolver"/>: a body's statements
/// as text. Kept apart so a resolver without a decompiler can still implement the engine's core contract.
/// </summary>
public interface IDebugSourceProvider {
	/// <summary>The statements and IL of a method body, or null when the module or method cannot be read.</summary>
	Task<MethodSourceDto?> GetMethodSourceAsync(string? workspaceId, string modulePath, int metadataToken, CancellationToken cancellationToken);
}
