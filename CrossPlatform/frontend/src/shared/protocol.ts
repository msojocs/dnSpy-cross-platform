export const protocolVersion = 1

export interface HelloResponse {
  protocolVersion: number
  backendVersion: string
  nonce: string
  platform: string
  architecture: string
  capabilities: Record<string, boolean>
}

export interface OpenedModule {
  id: string
  name: string
  path: string
  hasPdb: boolean
  /** A file the workspace opened by itself to resolve a reference — dnSpy's auto-loaded documents, which a
   *  reload only brings back when a tab still shows something of them. */
  autoLoaded?: boolean
  /** A document Create Assembly or Create NetModule made, which has no file until it is saved: its path is the
   *  workspace's own name for it, and a saved list leaves it out. */
  inMemory?: boolean
}

export interface OpenWorkspaceResponse {
  workspaceId: string
  modules: OpenedModule[]
  stateId: string
}

/**
 * The answer to adding assemblies to an already open workspace. `modules` is the full list of what the
 * workspace holds now, not just what the call added, so a caller can set it straight over its own state.
 * `skipped` names the requested paths that were already open — a file added twice stays one tree.
 */
export interface AddModulesResponse {
  modules: OpenedModule[]
  skipped: string[]
  stateId: string
}

export interface TreeNode {
  id: string
  label: string
  kind: string
  hasChildren: boolean
  description?: string
  icon?: string
  /**
   * Module path and metadata token rather than a node id, so it survives a restart — node ids are issued
   * by a counter in the order nodes are first materialised, and a restored session only has the key to
   * name a node by. See `SavedSession` in the app store.
   */
  key?: string
  /**
   * The raw pieces the WPF-style row text is composed from: "name : RetType @06000004". The token is the
   * raw MDToken, present only on the rows dnSpy's NodeFormatter writes one for; the return type only on
   * members whose row names a type after the colon. The label stays the bare name — bookmarks and output
   * messages quote it.
   */
  metadataToken?: number
  returnType?: string
  /** The label and the return type cut where dnSpy's syntax highlighting changes color; absent on a row dnSpy
   *  writes in one plain color. */
  labelParts?: TextPart[] | null
  returnTypeParts?: TextPart[] | null
  /** The row's tooltip the way its WPF node writes one, a line per line. */
  toolTip?: string | null
  /** The address "Search MSDN" opens, present only on the public members and namespaces dnSpy offers it on. */
  msdnName?: string | null
  /** A member the C# and VB decompilers hide unless "show hidden compiler generated types and methods" is on. */
  compilerGenerated?: boolean
  /** A root the workspace opened by itself to resolve a reference, rather than one the user opened. */
  autoLoaded?: boolean
  /** The two parts an assembly row may write after its name, which the Assembly Explorer options pick from. */
  assemblyVersion?: string | null
  publicKeyToken?: string | null
  /** What "Copy Full Name" writes: the full name of the metadata row the node stands for — an assembly's
   *  display name, a module's name, a type's, a member's or a reference's. Absent where dnSpy has no such name. */
  fullName?: string | null
}

/** A stretch of a row's text, and the color class dnSpy's syntax highlighting writes it in — "keyword",
 *  "namespace", "interface", "staticMethod" and the rest of the backend's `TextColors`. */
export interface TextPart {
  text: string
  color: string
}

export interface TreeNodesResponse {
  nodes: TreeNode[]
}

/** Which of a module's two notable members a "Go to ..." command navigates to — the backend's
 *  `SpecialNodeKinds`. */
export type SpecialNodeKind = 'entryPoint' | 'globalCctor'

/** The node dnSpy's "Go to Entry Point" and "Go to Global Cctor" navigate to. Null when the module has
 *  no such member: an assembly with no entry point, or one with no global static constructor. */
export interface SpecialNodeResponse {
  nodeId: string | null
}

/** The node a metadata token names — dnSpy's "Go to Token". Null when the token names no row the tree
 *  shows, which is the same answer as a token the module has no row for. */
export interface FindByTokenResponse {
  nodeId: string | null
}

/** What is left after an assembly is removed, plus the ids of the tree nodes that went with it — what a
 *  client needs to drop the documents and the selection it was holding by node id. */
export interface RemoveModuleResponse {
  removedNodeIds: string[]
  roots: TreeNode[]
  /** The edit history after the removal. A document an edit in the undo history touched is removed by an
   *  edit of its own, which Undo reverses — dnSpy's RemoveAssemblyCommand. */
  canUndo?: boolean
  canRedo?: boolean
}

/** What is left after several assemblies are removed at once — dnSpy's Remove Assembly over a multiple
 *  selection, and its Close All Framework Assemblies / Close All Missing Files sweeps. */
export interface RemoveModulesResponse {
  removedNodeIds: string[]
  roots: TreeNode[]
  canUndo?: boolean
  canRedo?: boolean
}

/** The modules that hold edits that have not been saved — what dnSpy asks about before Reload All. */
export interface ModifiedModulesResponse {
  /** The files of the modified modules, among the ones the request named (every module when it named none). */
  paths: string[]
}

/** The roots dnSpy's two Close All sweeps would remove: the framework assemblies and the documents
 *  that are not PE images (a missing file is one of those). */
export interface CloseCandidatesResponse {
  frameworkNodeIds: string[]
  missingNodeIds: string[]
}

/** What activating a row — a double click, Enter — goes to: the definition a reference row names,
 *  or the assembly an assembly reference names, opened when it has to be. Null when the row is not
 *  one that activates to somewhere else. */
export interface ActivateNodeResponse {
  nodeId: string | null
  /** Whether the workspace had to open an assembly to reach the target, so the roots are worth reading again. */
  rootsChanged: boolean
}

/** The Assembly Explorer's dragged-items filter, which decides which of several dropped files are let in. */
export type DropFilter = 'all' | 'allSupported' | 'dotNetOnly'

/** Dropping files on the tree: the workspace (made by the drop when there was none), the modules it now
 *  holds, the files it added, and the root to select — the first new one, or else a dropped file that was
 *  open already. `allFiltered` says the filter turned every new file away. */
export interface DropFilesResponse {
  workspaceId: string | null
  modules: OpenedModule[]
  addedPaths: string[]
  selectNodeId: string | null
  allFiltered: boolean
  stateId: string | null
}

/** Every assembly in the global assembly caches on this machine. */
export interface GacListResponse {
  assemblies: GacAssemblyDto[]
}

export interface GacAssemblyDto {
  name: string
  version: string
  culture: string
  publicKeyToken: string
  path: string
}

/** The company and file version of one GAC file, which the dialog shows for its selection. */
export interface GacDetailsResponse {
  createdBy: string | null
  fileVersion: string | null
}

/** A list of files to open together, named the way dnSpy's Open List names one. */
export interface DocumentListDto {
  name: string
  files: string[]
}

export interface DocumentListsResponse {
  lists: DocumentListDto[]
}

/** The bytes several resource nodes hold — what Save Resource writes, one file per item. */
export interface ResourceItemsResponse {
  items: ResourceDataResponse[]
}

/** The names the resource nodes save under with Save (`names`) and Raw Save (`rawNames`), without the bytes —
 *  what the Save commands' headers count, and whether their "use sub dirs" variants are offered. */
export interface ResourceItemNamesResponse {
  names: string[]
  rawNames: string[]
}

/** The node a command line's `--select` names in the files it opened, or null when it names none. */
export interface SelectMemberResponse {
  nodeId: string | null
}

/** The resource node that holds the data a Resources property or method reads — dnSpy's Go to
 *  Resource. Null when the type is not a Resources class, the method body does not name a
 *  resource, or the .resources file is not in the tree. */
export interface FindResourceResponse {
  nodeId: string | null
}

/** The bytes one resource node holds, and the name a Save dialog should suggest for them. */
export interface ResourceDataResponse {
  name: string
  base64Data: string
}

export type DecompilerLanguage = 'cSharp' | 'visualBasic' | 'il' | 'ilWithCSharp'

export interface CSharpDecompilerSettings {
  anonymousMethods: boolean
  yieldReturn: boolean
  asyncAwait: boolean
  queryExpressions: boolean
  expressionTrees: boolean
  useDebugSymbols: boolean
  showXmlDocumentation: boolean
  sortCustomAttributes: boolean
  fullyQualifyAllTypes: boolean
  fullyQualifyAmbiguousTypeNames: boolean
  removeEmptyDefaultConstructors: boolean
  showTokenAndRvaComments: boolean
  sortMembers: boolean
  forceShowAllMembers: boolean
  sortSystemUsingStatementsFirst: boolean
  useSourceCodeOrder: boolean
  oneCustomAttributePerLine: boolean
  allowFieldInitializers: boolean
  typeAddInternalModifier: boolean
  memberAddPrivateModifier: boolean
  hexadecimalNumbers: boolean
  emitCalliAsInvocationExpression: boolean
  insertParenthesesForReadability: boolean
}

export interface ILDecompilerSettings {
  showXmlDocumentation: boolean
  showTokenAndRvaComments: boolean
  showILBytes: boolean
  showILComments: boolean
  sortMembers: boolean
  showPdbInfo: boolean
  hexadecimalNumbers: boolean
}

export interface BamlDecompilerSettings {
  newLineOnAttributes: boolean
  useTabs: boolean
}

export interface DecompilerSettings {
  cSharp?: CSharpDecompilerSettings
  il?: ILDecompilerSettings
  baml?: BamlDecompilerSettings
  decompileFullType: boolean
  useMemoryMappedIO: boolean
}

export interface DecompileRequest {
  workspaceId: string
  nodeId: string
  language: DecompilerLanguage
  settings?: DecompilerSettings
}

export interface TextSpan {
  start: number
  length: number
  kind: string
  targetNodeId?: string
  /**
   * A reference into a module the workspace does not hold: the file it lives in and the token it has
   * there, which `findMember` follows — opening that module on demand the way dnSpy does.
   */
  targetModulePath?: string
  targetMetadataToken?: number
  /** The dnSpy text color class the span is written in, e.g. `staticType` or `instanceMethod`. */
  color?: string | null
  /**
   * A local or parameter's identity, tying its uses to its declaration. It is stable within the one
   * decompiled document, which is all a click or the reference highlighter needs.
   */
  localId?: string | null
  /** A local's or parameter's Quick Info — "(local variable) int num" — carried by the first span of the local. */
  toolTip?: TextPart[] | null
  /** Whether the reference writes what it names, which the reference highlighter marks in a color of its own. */
  isWrite?: boolean
  /** An IL opcode: following it opens the opcode's documentation, and its Quick Info describes it. */
  opCode?: string | null
}

/**
 * Whether a span names somewhere to go. A reference inside the workspace carries the node; a reference
 * into a module the workspace does not hold carries that module's file and token instead, which the
 * backend follows on demand — so it is a target just the same, and the editor draws it as one. A local
 * or parameter names a place in this same document through its `localId`, and an opcode its page.
 */
export const isNavigableSpan = (span: TextSpan): boolean => Boolean(span.targetNodeId || span.targetModulePath || span.localId || span.opCode)

/** Whether the span is a local variable or a parameter rather than a metadata member. */
export const isLocalSpan = (span: TextSpan): boolean => Boolean(span.localId)

export interface Diagnostic {
  severity: string
  message: string
  start?: number
  length?: number
}

/**
 * One sequence point of a decompiled document: the line(s) it covers and the IL range it maps to.
 * The IL range is what the in-process debug engine turns into an IL-offset breakpoint, so a gutter
 * click can pick the statement under the cursor instead of only its owning method.
 */
export interface CodeStatement {
  startLine: number
  endLine: number
  startColumn: number
  endColumn: number
  ilOffset: number
  ilEndOffset: number
  /**
   * The start of the sequence point tiling the IL at `ilOffset`. The runtime only accepts a
   * breakpoint on a point boundary, so this is where the engine falls back to when the statement's
   * own start is refused — the two differ inside a state machine's field store, say.
   */
  sequencePointIlOffset: number
  modulePath: string
  metadataToken: number
  sourceMethodToken: number
  description: string
  isHidden: boolean
}

export interface DecompileResponse {
  title: string
  language: string
  text: string
  spans: TextSpan[]
  diagnostics: Diagnostic[]
  codeStatements?: CodeStatement[]
  /** The blocks dnSpy draws its block structure lines for. */
  blockStructures?: BlockStructure[] | null
  /** Where the procedure line separators go: each offset's line gets one below it. */
  lineSeparators?: number[] | null
  /** The keywords "Highlight related keywords" ties together. */
  relatedKeywords?: KeywordReference[] | null
}

/**
 * A block of a document: `start` lies in the line that opens it and `end` in the line that closes it. `kind`
 * is dnSpy's BlockStructureKind in camel case — `method`, `loop`, `conditional` — which picks its color.
 */
export interface BlockStructure {
  start: number
  end: number
  kind: string
}

/** A keyword of a group of related keywords; the keywords of one group share `group`. */
export interface KeywordReference {
  start: number
  length: number
  group: number
}

/** A reference's Quick Info: the member written the way the document's language writes it, and its documentation. */
export interface DocumentQuickInfoResponse {
  parts: TextPart[]
  documentation?: string | null
}

/** What a hover asks Quick Info for: the reference's target, or an IL opcode, in the document's language. */
export interface DocumentQuickInfoRequest {
  targetNodeId?: string | null
  modulePath?: string | null
  metadataToken?: number | null
  language: DecompilerLanguage
  opCode?: string | null
}

/**
 * A member looked up by the identity that outlives a node id: a module path plus a metadata token.
 * That is what a restored bookmark keeps, and what a `TextSpan` names when its target belongs to a
 * module the workspace does not hold — such a module is opened on demand, so the caller has to
 * refresh the roots after a hit. Every field is null when the file is not on this machine, is not a
 * managed module, or when the token no longer resolves.
 */
export interface FindMemberResponse {
  nodeId?: string
  label?: string
  description?: string
}

/**
 * Where a bookmark is, the way dnSpy's two .NET locations name it: a module and a metadata token, plus
 * the IL offset for a spot inside a method body (`DotNetMethodBodyBookmarkLocation`). Without the offset
 * it is the definition itself (`DotNetTokenBookmarkLocation`) — what a bookmark on a declaration line is.
 */
export interface BookmarkLocation {
  modulePath: string
  metadataToken: number
  ilOffset?: number | null
}

/** The Bookmarks window's display options — dnSpy's `BookmarkDisplaySettings`, which its Location column is
 *  written with. */
export interface BookmarkLocationFormat {
  showTokens: boolean
  showModuleNames: boolean
  showParameterTypes: boolean
  showParameterNames: boolean
  showDeclaringTypes: boolean
  showReturnTypes: boolean
  showNamespaces: boolean
  showIntrinsicTypeKeywords: boolean
}

/** One Location cell. `resolved` is false when the module could not be read or the token names nothing in
 *  it; the parts are then only the token, the way dnSpy writes a location it cannot resolve. */
export interface BookmarkLocationText {
  parts: TextPart[]
  resolved: boolean
}

/** A bookmark as dnSpy's bookmark files hold it — what the export writes and the import reads back. */
export interface BookmarkFileEntry extends BookmarkLocation {
  name: string
  labels: string[]
  enabled: boolean
  /** The member the token named when the file was written (dnSpy's `TokenString`), if the file says. */
  description?: string | null
}

export interface ImportBookmarksResponse {
  bookmarks: BookmarkFileEntry[]
  /** The entries the file holds that cannot be used: an in-memory module, or a token that names another member now. */
  skipped: number
}

/** The search window's "Search For" box — one entry of dnSpy's SearchType each. */
export type SearchType =
  | 'assembly' | 'module' | 'namespace' | 'type' | 'field' | 'method' | 'property' | 'event'
  | 'parameter' | 'local' | 'parameterLocal' | 'assemblyRef' | 'moduleRef' | 'resource'
  | 'genericType' | 'nonGenericType' | 'enum' | 'interface' | 'class' | 'struct' | 'delegate'
  | 'member' | 'any' | 'literal'

/** The box beside it — dnSpy's SearchLocation. */
export type SearchLocation = 'allFiles' | 'selectedFiles' | 'allFilesInSameDir' | 'selectedType'

/**
 * What the search window asks for: the query, the two boxes and the options. The locations other than all
 * files read the tree's selection, which `selectedNodeIds` names.
 */
export interface SearchRequest {
  query: string
  searchType: SearchType
  location: SearchLocation
  selectedNodeIds?: string[]
  caseSensitive: boolean
  matchWholeWords: boolean
  matchAnySearchTerm: boolean
  searchDecompiledData: boolean
  searchFrameworkAssemblies: boolean
  searchCompilerGeneratedMembers: boolean
  maxResults?: number
  /** The language the results are written through — the toolbar's. */
  language?: DecompilerLanguage
}

/**
 * One result, written the way dnSpy's search list writes it through the language the search was asked with.
 * `nodeId` is what following it opens — absent for a module reference, which the tree has no row for; `ilOffset`
 * is the instruction a match in a method body was found at, which following it puts the caret on. The tooltip's
 * lines are parted with a line break, in `toolTipParts` as in `toolTip`.
 */
export interface SearchResult {
  nodeId?: string | null
  kind: string
  name: string
  location: string
  nameParts?: TextPart[] | null
  locationParts?: TextPart[] | null
  icon?: string | null
  locationIcon?: string | null
  toolTip?: string | null
  ilOffset?: number | null
  toolTipParts?: TextPart[] | null
}

export interface SearchResponse {
  results: SearchResult[]
  /** The search stopped at the limit — dnSpy's "too many results". */
  truncated: boolean
  /** Where the first result stands among everything found: the ones sent ahead come before it. */
  start?: number
}

/** Results a search found while it was still running, for the request the renderer named `requestKey`. */
export interface SearchProgress {
  requestKey: string
  start: number
  results: SearchResult[]
}

/** dnSpy's StringReferenceKind, in the order its list sorts them. */
export type StringReferenceKind = 'il' | 'constant' | 'attribute'

/**
 * One row of dnSpy's String References window: a string and the member it is in. `formattedLiteral` is the
 * string as a C# literal (verbatim when `isVerbatim`); `token` is what the list sorts by after the kind, and
 * `ilOffset` the `ldstr` an IL reference is. `nodeId` is the tree node following the row opens.
 */
export interface StringReference {
  kind: StringReferenceKind
  literal: string
  formattedLiteral: string
  isVerbatim: boolean
  referrerParts: TextPart[]
  referrerIcon: string
  moduleName: string
  token: number
  nodeId: string | null
  ilOffset: number | null
}

export interface StringReferencesSearchRequest {
  /** Tree nodes whose assemblies are scanned, every module of each. */
  nodeIds?: string[]
  /** Modules an earlier scan read, which a refresh reads again. */
  modulePaths?: string[]
  /** The current language shows the members the compiler made (IL); C# and VB leave them out. */
  showAllMembers?: boolean
}

export interface StringReferencesSearchResponse {
  references: StringReference[]
  start: number
  /** The modules the scan read. */
  modulePaths: string[]
}

export interface StringReferencesProgress {
  requestKey: string
  start: number
  references: StringReference[]
}

/** The searches dnSpy's analyzer offers under a member, by the key a search row carries. */
export type AnalyzerSearchKind =
  | 'uses' | 'usedBy' | 'overrides' | 'overriddenBy' | 'implementedBy' | 'readBy' | 'assignedBy'
  | 'raisedBy' | 'appliedTo' | 'instantiatedBy' | 'exposedBy' | 'subtypes' | 'extensionMethods'

/**
 * A member a reference may name, written the way a `TextSpan` names its target: by node in a module the
 * workspace holds, by file and token in one it does not.
 */
export interface AnalyzerTarget {
  nodeId?: string | null
  modulePath?: string | null
  metadataToken?: number | null
}

/**
 * Where in a method body a search result was found — dnSpy's SourceRef. "Show Reference in Method" opens
 * the method and puts the caret on the reference the instruction at `ilOffset` makes to one of `targets`.
 * The offset is null for a result found in the method's locals or exception handlers.
 */
export interface AnalyzerSource {
  methodNodeId: string
  modulePath: string
  methodToken: number
  ilOffset?: number | null
  targets: AnalyzerTarget[]
}

/**
 * One row of dnSpy's analyzer tree: a member, an assembly or a module (`kind` as the tree names it), or a
 * row that runs a search (`kind: 'search'`). The label carries neither the token nor the "(hides)" prefix,
 * which the client adds; a search row's label is its English header.
 */
export interface AnalyzerNode {
  kind: string
  label: string
  hasChildren: boolean
  /** The tree node the row names; for a search row, the member the search is for. */
  nodeId?: string | null
  icon?: string | null
  metadataToken?: number | null
  search?: AnalyzerSearchKind | null
  /** The keyword an accessor row is written as: get, set, add, remove or raise. */
  accessor?: string | null
  /** Carried by a property's "set" row and its searches: the setter's "Used By" also looks at the
   * attributes that assign the property by name. */
  isSetter: boolean
  hidesParent: boolean
  fullName?: string | null
  isPublic: boolean
  source?: AnalyzerSource | null
  /** The label cut where dnSpy's syntax highlighting changes color; none on a search row. */
  labelParts?: TextPart[] | null
}

export interface AnalyzeNodesResponse {
  /** One row per node asked for, null where the node is not a member — or no longer is. */
  nodes: (AnalyzerNode | null)[]
}

export interface AnalyzeChildrenRequest {
  nodeId: string
  search?: AnalyzerSearchKind
  isSetter?: boolean
  /** The decompiler the rows are written through, C# when none is named. */
  language?: DecompilerLanguage
  /** With C#, whether a result found in a lambda or a state machine is listed as the method it was written in
   * — the C# decompiler's anonymous methods setting, which dnSpy's analyzer reads. */
  decompileAnonymousMethods?: boolean
  /** A limit the search stops at; dnSpy's has none, and none is the default. */
  maxResults?: number
}

export interface AnalyzeChildrenResponse {
  children: AnalyzerNode[]
  truncated: boolean
  /** Where the first row stands among everything the search found: the rows sent ahead come before it. */
  start?: number
}

/** Rows a search found while it was still running, for the request the renderer named `requestKey`. */
export interface AnalyzeProgress {
  requestKey: string
  /** Where the first row stands among everything the search found. */
  start: number
  children: AnalyzerNode[]
}

export interface HexLengthResponse {
  length: number
}

export interface HexReadResponse {
  offset: number
  base64Data: string
  endOfFile: boolean
}

/** A byte range of the module's file, as the hex editor addresses it. */
export interface HexRange {
  offset: number
  length: number
}

/**
 * The parts of a method the hex commands jump to: the whole body (header included, what "Show Method
 * Body" and the write commands overwrite) and the IL code that follows the header ("Show Instructions").
 * Each template is the exact bytes one of the write commands installs, base64 encoded; it is null when
 * that command does not apply to this method, which is what its menu entry keys off.
 */
export interface HexMethodTarget {
  bodyOffset: number
  bodySize: number
  codeOffset: number
  codeSize: number
  returnTrueBody: string | null
  returnFalseBody: string | null
  emptyBody: string | null
}

/**
 * Where the hex commands for one node point. Everything but the module and its length is null when the
 * node has no such target — spelled out on the wire rather than left off, so "no target" reads as null
 * here and never as a missing property.
 */
export interface HexTargetResponse {
  moduleId: string
  fileLength: number
  method: HexMethodTarget | null
  fieldInitialValue: HexRange | null
  resource: HexRange | null
  /** The bytes of a PE header, the tables stream header, a metadata table or one of its rows — what dnSpy's Show in
   *  Hex Editor shows for its hex nodes. */
  structure?: HexRange | null
  /** What a section header or a metadata stream header describes — dnSpy's Show Data in Hex Editor. */
  structureData?: HexRange | null
}

/** One bit field of a flags field: a check box, or — with values — a combo box over `count` bits. */
export interface HexBitField {
  name: string
  bit: number
  count: number
  values?: { value: number; name: string }[] | null
}

/**
 * One field of a PE or metadata structure, dnSpy's HexField: where it is in the file, its current value — read
 * through the document's patches — and, for a flags field, its bits. `text` is the value as dnSpy writes it; a
 * 64-bit value may not fit `value`, so the client reads the number from `text`.
 */
export interface HexField {
  name: string
  offset: number
  size: number
  kind: 'byte' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'uint64' | 'string'
  value: number
  text: string
  bits?: HexBitField[] | null
  /** What dnSpy shows beside the field, read only: a time stamp as a date, say. */
  note?: string | null
  /** The box dnSpy draws the field in — "Flags", a data directory's name. */
  group?: string | null
}

export interface HexStructure {
  nodeId: string
  name: string
  offset: number
  length: number
  fields: HexField[]
}

export interface MetadataColumn {
  name: string
  /** Where the column is in a row. */
  offset: number
  size: number
}

/** A metadata table as dnSpy's MetadataTableVM shows it. */
export interface MetadataTable {
  nodeId: string
  table: number
  name: string
  rows: number
  rowSize: number
  offset: number
  columns: MetadataColumn[]
  hasInfo: boolean
  canSort: boolean
}

export interface MetadataRow {
  rid: number
  token: number
  offset: number
  values: number[]
  info?: string | null
}

export interface MetadataFindRecordResponse {
  nodeId: string | null
  /** The rows from the document down to the table, which the tree opens to show the record. */
  path: string[]
  error: string | null
}

/** The bytes one statement of a code document covers, or null when it has none. The module is named
 * too, since a code document only knows the path it was decompiled from. */
export interface HexStatementResponse {
  moduleId: string | null
  range: HexRange | null
}

/** What Go to Position accepts: the hex editor's own address, a PE file offset, a relative virtual
 * address, or a delta from the position the dialog opened at. */
export type HexPositionKind = 'absolute' | 'file' | 'rva' | 'current'

export interface HexResolvePositionResponse {
  /** The file offset, or -1 when the file has no such position. */
  offset: number
}

/** What Go to Metadata accepts: a table token, a method or field RVA row's token, an index into one of
 * the metadata streams, or a 1-based GUID index. */
export type HexMetadataKind = 'table' | 'memberRva' | 'blob' | 'strings' | 'us' | 'guid'

export interface HexGoToMetadataResponse {
  range: HexRange | null
}

export interface HexFindResponse {
  /** The offset the pattern was found at, or -1 when it was not. */
  offset: number
}

export interface ModuleInfoResponse {
  name: string
  path: string
  runtimeVersion: string
  architecture: string
  moduleKind: string
  mvid: string
  entryPoint?: string
  typeCount: number
  resourceCount: number
  assemblyReferences: string[]
  peHeaders: Record<string, string>
  metadataTables: Record<string, number>
}

export interface BeginEditResponse {
  transactionId: string
  baseVersion: number
}

export interface IlInstruction {
  label: string
  opCode: string
  operandKind?: string
  operand?: string
  operandDisplay?: string
}

export interface MethodBodyResponse {
  maxStack: number
  initLocals: boolean
  locals: string[]
  instructions: IlInstruction[]
  hasExceptionHandlers: boolean
}

export interface IlLocal {
  name?: string | null
  type: TypeSigDto | null
  isPinned: boolean
  attributes: number
  display: string
}

export interface IlExceptionHandler {
  handlerType: 'catch' | 'filter' | 'finally' | 'fault'
  tryStart?: string | null
  tryEnd?: string | null
  filterStart?: string | null
  handlerStart?: string | null
  handlerEnd?: string | null
  catchType: TypeSigDto | null
  display: string
  /** The catch type's token, hexadecimal — what Copy MD Token copies. */
  catchTypeToken?: string | null
}

/**
 * One instruction of the IL editor. `operandKind` says which editor the operand needs; the value
 * travels as `operand` (a number, a string literal, a label or list of labels, or an index), or as one
 * of the references the editor may build — `methodRef`, `typeSignature`, or a `nodeId`/`token` naming
 * a row the module already holds.
 */
export interface IlBodyInstruction {
  label: string
  opCode: string
  operandKind?: string | null
  operand?: string | null
  operandDisplay?: string | null
  nodeId?: string | null
  token?: string | null
  methodRef?: MethodRefDto | null
  methodSpecArguments?: TypeSigDto[] | null
  typeSignature?: TypeSigDto | null
  callSiteSignature?: MethodSigDto | null
  /** A MemberRef the operand dialog built — or, read from a body, the MemberRef the operand is. */
  memberRef?: MemberRefDto | null
  /** The custom attributes of the MethodSpec the operand is. */
  methodSpecCustomAttributes?: CustomAttributeDto[] | null
  /** The method whose module `token` and `nodeId` belong to; a copy pasted into another module is imported. */
  tokenOwnerNodeId?: string | null
}

/** The class of a MemberRef — dnSpy's MemberRefVM.Class: a type, a TypeSpec, a method of the module or a module. */
export interface MemberRefParentDto {
  kind: 'type' | 'typeSpec' | 'methodDef' | 'moduleRef'
  type?: TypeSigDto | null
  nodeId?: string | null
  token?: string | null
  moduleName?: string | null
  display: string
}

/** A MemberRef as dnSpy's MemberRefDlg edits it. */
export interface MemberRefDto {
  isField: boolean
  class?: MemberRefParentDto | null
  name: string
  methodSignature?: MethodSigDto | null
  fieldType?: TypeSigDto | null
  customAttributes?: CustomAttributeDto[] | null
  display: string
}

/** A method body as dnSpy's Edit Method Body window models it — the three lists and the header. */
export interface IlMethodBody {
  bodyType: 'none' | 'cil' | 'native'
  codeType: number
  maxStack: number
  keepOldMaxStack: boolean
  initLocals: boolean
  localVarSigTok: number
  headerRva: number
  headerFileOffset: number
  rva: number
  fileOffset: number
  nativeRva: number
  locals: IlLocal[]
  instructions: IlBodyInstruction[]
  exceptionHandlers: IlExceptionHandler[]
  parameterNames: string[]
}

/** How a manifest resource is stored — the backend's ManifestResourceKinds. */
export type ResourceKind = 'embedded' | 'assemblyLinked' | 'linked'

/** The languages the compiler commands can be in — the backend's CompilerLanguages. */
export type CompilerLanguage = 'csharp' | 'visualBasic'

/** The Compiler options page's values for a language — the backend's CompilerSettingsDto. */
export interface CompilerSettings {
  preprocessorSymbols: string
  optimize: boolean
  checkOverflow: boolean
  allowUnsafe: boolean
  optionExplicit: boolean
  optionInfer: boolean
  optionStrict: boolean
  optionCompareBinary: boolean
  embedVisualBasicRuntime: boolean
}

/** The modes dnSpy's compiler commands run in — the backend's CompilerModes. */
export type CompilerMode = 'editMethod' | 'editClass' | 'addMembers' | 'addClass' | 'editAssembly'

export interface CompilerDiagnostic {
  severity: 'error' | 'warning' | 'info' | 'hidden'
  text: string
  id: string
  fileName?: string | null
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

export interface CompileSourceResponse {
  success: boolean
  diagnostics: CompilerDiagnostic[]
}

/** The writer options dnSpy's Save Module window offers. */
export interface SaveModuleOptions {
  preserveRids: boolean
  preserveUsOffsets: boolean
  preserveStringsOffsets: boolean
  preserveBlobOffsets: boolean
  keepWin32Resources: boolean
  shareMethodBodies: boolean
  addCheckSum: boolean
  addMvidSection: boolean
  writePdb: boolean
  keepExtraPeData: boolean
  mixedMode: boolean
  /** Overrides the module kind the file is written as; undefined keeps the module's own. */
  moduleKind?: number
}

/** An assembly as dnSpy's Edit Assembly window models it. */
export interface AssemblyOptions {
  name: string
  culture?: string | null
  hashAlgorithm: number
  attributes: number
  /** The public key as hexadecimal text, as dnSpy's HexStringVM holds it. */
  publicKey: string
  versionMajor: number
  versionMinor: number
  versionBuild: number
  versionRevision: number
  customAttributes: CustomAttributeDto[]
  declSecurities: DeclSecurityDto[]
  fullName: string
}

/** A module as dnSpy's Edit Module window models it. */
export interface ModuleOptions {
  name: string
  kind: number
  mvid: string
  encId: string
  encBaseId: string
  runtimeVersion?: string | null
  tablesHeaderVersion: number
  cor20HeaderRuntimeVersion?: string | null
  cor20HeaderFlags: number
  machine: number
  characteristics: number
  dllCharacteristics: number
  managedEntryPoint?: string | null
  nativeEntryPoint: number
  customAttributes: CustomAttributeDto[]
  display: string
}

export interface ResourceOptions {
  kind: ResourceKind
  name: string
  /** dnlib's ManifestResourceAttributes; the low two bits are the visibility. */
  attributes: number
  assemblyFullName?: string | null
  linkedFileName?: string | null
  fileContainsNoMetadata: boolean
  fileHash?: string | null
  customAttributes: CustomAttributeDto[]
  display: string
}

/** What one of dnSpy's Create Resource commands creates. */
export type ResourceCreateKind = 'file' | 'multiFile' | 'assemblyLinked' | 'fileLinked' | 'byteArray' | 'stream' | 'string'

/** The kinds the .resources element editor understands. */
export type ResourceElementKind =
  | 'null' | 'string' | 'boolean' | 'char' | 'byte' | 'sbyte' | 'int16' | 'uint16' | 'int32' | 'uint32'
  | 'int64' | 'uint64' | 'single' | 'double' | 'decimal' | 'dateTime' | 'timeSpan' | 'byteArray' | 'stream' | 'binary'
  /** A serialized System.Drawing.Bitmap or Icon, edited as the image file it holds. */
  | 'serializedImage'
  /** A serialized System.Windows.Forms.ImageListStreamer, edited as the "Data" bytes it holds. */
  | 'imageListStreamer'
  /** Image files made into serialized Bitmaps and Icons — dnSpy's Create System.Data.Bitmap/Icon Resource. */
  | 'imageFiles'

export interface ResourceElementOptions {
  kind: ResourceElementKind
  name: string
  text?: string | null
  base64Data?: string | null
  typeCode: number
  typeName?: string | null
  display: string
  /** A byte array or stream that holds an image file, which dnSpy edits with its image window. */
  isImage?: boolean
  /** How a serialized value is stored — dnlib's SerializationFormat — which an image is written back in. */
  serializationFormat?: string | null
}

/** An image file picked for a resource: its name and its bytes. */
export interface ResourceImageFile {
  name: string
  base64Data: string
}

export interface CreateResourceEntry {
  name: string
  base64Data?: string | null
  text?: string | null
}

/** The model one of the Create ... Resource commands writes. */
export interface CreateResourceOptions {
  kind: ResourceCreateKind
  name: string
  attributes: number
  base64Data?: string
  text?: string
  assemblyFullName?: string
  linkedFileName?: string
  fileContainsNoMetadata?: boolean
  entries?: CreateResourceEntry[]
}

/** A new entry of a .resources file. */
export interface CreateResourceElementOptions {
  kind: ResourceElementKind
  name: string
  text?: string
  base64Data?: string
  /** For `imageFiles`: the files, each an entry named after it. */
  images?: ResourceImageFile[]
}

export interface TransformIlBodyResponse {
  locals: IlLocal[]
  instructions: IlBodyInstruction[]
}

export interface EditCommitResponse {
  version: number
  stateId: string
  changedNodeIds: string[]
  canUndo: boolean
  canRedo: boolean
  /** Every module the workspace holds, sent only when the step changed which documents the tree holds —
   *  undoing or redoing a removal dnSpy recorded in the history. */
  modules?: OpenedModule[] | null
  /** The documents with unsaved changes once the step has run — dnSpy's modified documents, which undoing
   *  back to where a document was saved takes it off again. */
  modifiedDocuments?: ModifiedDocument[] | null
}

/**
 * A document with unsaved changes. `id` is what the save calls take — a root's id, or the module row of a net
 * module. A document Create Assembly made has no file yet (`inMemory`, empty `path`). `isHexDocument` is one
 * whose only changes are bytes written over its file, which dnSpy saves as a hex buffer, with a file name only.
 */
export interface ModifiedDocument {
  id: string
  name: string
  path: string
  inMemory: boolean
  isHexDocument: boolean
}

/**
 * The writer options dnSpy's Save Module window edits: dnlib's ModuleWriterOptions (NativeModuleWriterOptions
 * for a mixed-mode module) field for field. `null` is "what the writer would use" — an empty box in the
 * window, or every check box of a flags group left undecided.
 */
export interface WriterOptions {
  useMixedMode: boolean
  writePdb: boolean
  shareMethodBodies: boolean
  moduleKind: number
  addCheckSum: boolean
  addMvidSection: boolean
  keepExtraPeData: boolean
  keepWin32Resources: boolean
  /** dnlib's MetadataFlags. */
  metadataFlags: number
  preserveOtherMetadataStreams: boolean
  metadataSignature: number | null
  metadataMajorVersion: number | null
  metadataMinorVersion: number | null
  metadataReserved1: number | null
  metadataVersionString: string | null
  metadataStorageFlags: number | null
  metadataReserved2: number | null
  tablesReserved1: number | null
  tablesMajorVersion: number | null
  tablesMinorVersion: number | null
  tablesUseEnc: boolean | null
  tablesForceBigColumns: boolean | null
  tablesExtraData: number | null
  tablesLog2Rid: number | null
  tablesHasDeletedRows: boolean | null
  cor20MajorRuntimeVersion: number | null
  cor20MinorRuntimeVersion: number | null
  cor20Flags: number | null
  cor20EntryPoint: number | null
  machine: number
  subsystem: number
  timeDateStamp: number | null
  pointerToSymbolTable: number | null
  numberOfSymbols: number | null
  characteristics: number | null
  majorLinkerVersion: number | null
  minorLinkerVersion: number | null
  imageBase: number | null
  sectionAlignment: number | null
  fileAlignment: number | null
  majorOperatingSystemVersion: number | null
  minorOperatingSystemVersion: number | null
  majorImageVersion: number | null
  minorImageVersion: number | null
  majorSubsystemVersion: number | null
  minorSubsystemVersion: number | null
  win32VersionValue: number | null
  dllCharacteristics: number | null
  sizeOfStackReserve: number | null
  sizeOfStackCommit: number | null
  sizeOfHeapReserve: number | null
  sizeOfHeapCommit: number | null
  loaderFlags: number | null
  numberOfRvaAndSizes: number | null
}

/** What a document's save window starts from: the file and, for a module, the writer options. */
export interface DocumentSaveOptions {
  documentId: string
  name: string
  fileName: string
  isHexDocument: boolean
  canWritePdb: boolean
  canUseMixedMode: boolean
  isMixedModeModule: boolean
  writer: WriterOptions | null
}

/** One document of a save run: the file it goes to and the options it is written with. */
export interface SaveDocumentRequest {
  documentId: string
  fileName: string
  writer?: WriterOptions | null
}

/** How far a save run has got, both bars 0 to 1. */
export interface SaveDocumentsProgress {
  requestKey: string
  fileIndex: number
  fileName: string
  fileProgress: number
  totalProgress: number
}

export interface SaveDocumentResult {
  documentId: string
  fileName: string
  saved: boolean
  length: number
  sha256?: string | null
  log: string[]
  errorCount: number
  error?: string | null
}

export interface SaveDocumentsResponse {
  results: SaveDocumentResult[]
  canceled: boolean
  modifiedDocuments: ModifiedDocument[]
  /** Sent when a new document took a file of its own, which changes the module list. */
  modules?: OpenedModule[] | null
}

export interface SaveModuleResponse {
  path: string
  length: number
  sha256: string
}

export interface SaveAllResponse {
  saved: SaveModuleResponse[]
}

export interface BackendStatus {
  state: 'starting' | 'ready' | 'stopped' | 'error'
  message?: string
  capabilities?: Record<string, boolean>
}

// ---------------------------------------------------------------------------------------------
// The create/edit dialogs' models.
//
// These mirror the backend's DTO records (backend/dnSpy.Backend.Contracts/Protocol.cs) field for
// field, so a dialog can be read against the WPF options class it was ported from. Only what the
// port reads so far is declared — the member models arrive with their dialogs — and an interface
// that is a subset of what travels is safe here, because these values only ever come off the wire.
// ---------------------------------------------------------------------------------------------

/** A type as it is written into metadata: the assembly that declares it, then its namespace and name.
 * A nested type's name is its path from the outermost declaring type, written with `/`. */
export interface TypeRefDto {
  scope: string
  namespace: string
  name: string
  /** The explorer node it was picked from, which is what the backend resolves first. */
  nodeId?: string
}

export type TypeSigKind =
  | 'type' | 'genericInst' | 'szarray' | 'array' | 'ptr' | 'byref' | 'pinned'
  | 'cmodreqd' | 'cmodopt' | 'genericvar' | 'genericmvar' | 'fnptr' | 'empty'

/**
 * One node of a type signature. The wrapper kinds — `szarray`, `ptr`, `byref`, `pinned`, `array` —
 * carry the type they wrap in `element`; the two custom-modifier kinds put the modifier in `modifier`
 * and the type it modifies in `element`, which is the order dnlib's `CModReqdSig`/`CModOptSig` take.
 * `empty` is a slot a dialog has opened and not filled yet, which nothing writes.
 */
export interface TypeSigDto {
  kind: TypeSigKind
  type?: TypeRefDto
  /** Whether the type is a value type, when the DTO knows; unset leaves it to the definition. */
  valueType?: boolean
  element?: TypeSigDto
  modifier?: TypeSigDto
  arguments?: TypeSigDto[]
  rank?: number
  sizes?: number[]
  lowerBounds?: number[]
  genericParameterNumber?: number
  functionPointer?: MethodSigDto
  /** How the backend renders this signature. Kept for round-tripping; the editor shows its own text. */
  display?: string
}

/** `callingConvention` is dnlib's raw value: the low nibble is the convention and bits 4-6 carry
 * Generic/HasThis/ExplicitThis, which is exactly how dnSpy's method-signature dialog models it. */
export interface MethodSigDto {
  callingConvention: number
  returnType: TypeSigDto
  parameters: TypeSigDto[]
  varArgParameters?: TypeSigDto[]
  genericParameterCount?: number
  display?: string
}

export interface GenericParamDto {
  number: number
  flags: number
  name: string
  kind?: TypeSigDto
  constraints: GenericParamConstraintDto[]
  customAttributes: CustomAttributeDto[]
  display?: string
}

export interface GenericParamConstraintDto {
  constraint: TypeSigDto
  customAttributes: CustomAttributeDto[]
  display?: string
}

/** A type and the attributes on it, which is what an implemented interface is — the same row a generic
 * parameter's constraint is, under the field name dnSpy's `TypeDefOrRefAndCAOptions` uses. */
export interface TypeDefOrRefAndCaDto {
  typeDefOrRef: TypeSigDto
  customAttributes: CustomAttributeDto[]
  display?: string
}

/** A call target: the declaring type, the name, and the signature, which together identify it. */
export interface MethodRefDto {
  declaringType: TypeSigDto
  name: string
  signature: MethodSigDto
  display?: string
}

/**
 * A custom-attribute argument value, typed by the argument's own declared type. A primitive carries
 * its digits as invariant text — which keeps every numeric width intact through JSON — and
 * `elementType` says which of the boxes those digits are in, since an enum argument is declared as
 * its enum but holds an integer.
 */
export interface CaValueDto {
  kind: 'null' | 'primitive' | 'string' | 'type' | 'array' | 'struct'
  primitive?: string
  text?: string
  referencedType?: TypeSigDto
  elements?: CaArgumentDto[]
  elementType?: number
}

export interface CaArgumentDto {
  type: TypeSigDto
  value: CaValueDto
}

export interface CaNamedArgumentDto {
  isField: boolean
  name: string
  argument: CaArgumentDto
}

/** A custom attribute. The constructor's signature decides how many constructor arguments there are
 * and what type each one is, so the values are what is carried. */
export interface CustomAttributeDto {
  constructor: MethodRefDto
  constructorArguments: CaArgumentDto[]
  namedArguments: CaNamedArgumentDto[]
  display?: string
}

/** A Constant row; `elementType` is dnlib's `ElementType` as an int. */
export interface ConstantDto {
  elementType: number
  value?: string
  display?: string
}

/** A security attribute, which unlike a custom attribute has no constructor: the type is the
 * attribute itself and every value is a named field or property. */
export interface SecurityAttributeDto {
  attributeType: TypeSigDto
  namedArguments: CaNamedArgumentDto[]
  display?: string
}

export interface DeclSecurityDto {
  action: number
  customAttributes: CustomAttributeDto[]
  securityAttributes: SecurityAttributeDto[]
  v1XmlString?: string
  display?: string
}

export interface ImplMapDto {
  attributes: number
  name: string
  moduleName?: string
  display?: string
}

/** A MarshalType. `nativeType` picks which of the payload fields apply; a field left out is that
 * payload's own "not present" state. */
export interface MarshalTypeDto {
  nativeType: number
  rawData?: string
  size?: number
  variantType?: number
  userDefinedSubType?: TypeSigDto
  elementType?: number
  paramNumber?: number
  numberOfElements?: number
  flags?: number
  guid?: string
  nativeTypeName?: string
  customMarshaler?: TypeSigDto
  cookie?: string
  iidParamIndex?: number
  display?: string
}

export interface MethodOverrideDto {
  /** Left out while a dialog is drafting a new override — the row's body is then the method being
   * edited, which the backend fills in. */
  methodBody?: MethodRefDto
  methodDeclaration: MethodRefDto
  display?: string
}

export interface ParamDefDto {
  name: string
  sequence: number
  attributes: number
  constant?: ConstantDto
  marshalType?: MarshalTypeDto
  customAttributes: CustomAttributeDto[]
  display?: string
}

/**
 * A method's dialog model, which is dnSpy's `MethodDefOptions` field for field. `rva` is not edited
 * by any tab, but it travels with the model: the dialog sends the whole of it back, and the codec
 * writes every field it is given.
 */
export interface MethodOptionsDto {
  implAttributes: number
  attributes: number
  semanticsAttributes: number
  name: string
  methodSig?: MethodSigDto
  implMap?: ImplMapDto
  customAttributes: CustomAttributeDto[]
  declSecurities: DeclSecurityDto[]
  paramDefs: ParamDefDto[]
  genericParameters: GenericParamDto[]
  overrides: MethodOverrideDto[]
  rva?: number
  /** How many generic parameters the type declaring the method has. No page edits it: it is what the
   * signature editor's Var button is gated on, and dnSpy reads it off the live type instead of carrying
   * it. Read only, and left off on the way back. */
  ownerGenericParameterCount?: number
}

/** A field's dialog model. Declared here because the new-member defaults for other kinds are read
 * against it; the field dialog fills it in. */
export interface FieldOptionsDto {
  attributes: number
  name: string
  fieldSig?: TypeSigDto
  fieldOffset?: number
  marshalType?: MarshalTypeDto
  initialValue?: string
  implMap?: ImplMapDto
  constant?: ConstantDto
  customAttributes: CustomAttributeDto[]
  rva?: number
  /** How many generic parameters the type declaring the field has — the same read-only context the
   * method dialog carries, and what the type editor's Var button is gated on. */
  ownerGenericParameterCount?: number
}

export interface PropertySigDto {
  hasThis: boolean
  propertyType: TypeSigDto
  parameters: TypeSigDto[]
  display?: string
}

/** A property's dialog model. `getMethods`/`setMethods`/`otherMethods` are the accessor lists, which
 * dnSpy's `PropertyDefOptions` holds as three lists of methods. */
export interface PropertyOptionsDto {
  attributes: number
  name: string
  propertySig?: PropertySigDto
  constant?: ConstantDto
  getMethods: AccessorRefDto[]
  setMethods: AccessorRefDto[]
  otherMethods: AccessorRefDto[]
  customAttributes: CustomAttributeDto[]
  /** The read-only context the dialogs above also carry: how many generic parameters the declaring type
   * has, which is what the signature editor's Var button is gated on. */
  ownerGenericParameterCount?: number
}

export interface EventOptionsDto {
  attributes: number
  name: string
  eventType?: TypeSigDto
  addMethod?: AccessorRefDto
  invokeMethod?: AccessorRefDto
  removeMethod?: AccessorRefDto
  otherMethods: AccessorRefDto[]
  customAttributes: CustomAttributeDto[]
  /** The read-only context the method and field dialogs also carry: how many generic parameters the
   * declaring type has, which is what the type editor's Var button is gated on. */
  ownerGenericParameterCount?: number
}

/** A method something else is made of — a property's or an event's accessor. The node id names the row
 * the user picked and is what a freshly picked one carries; the token is what the backend puts there
 * when it read the row out of the model, so a value that came from it can be written straight back. */
export interface AccessorRefDto {
  name: string
  token?: number
  nodeId?: string
  display?: string
}

/**
 * A type's dialog model, which is the whole row: the attribute word the six combinations are carved out
 * of, the namespace and name, the layout, the base type, and the four collections dnSpy's window rebuilds
 * rather than merges.
 */
export interface TypeOptionsDto {
  attributes: number
  namespace: string
  name: string
  /** The class layout, absent when the type has none: dnSpy reads a packing size and class size of zero
   * as the row not being there at all. */
  packingSize?: number
  classSize?: number
  baseType?: TypeSigDto
  customAttributes: CustomAttributeDto[]
  declSecurities: DeclSecurityDto[]
  genericParameters: GenericParamDto[]
  interfaces: TypeDefOrRefAndCaDto[]
  /** How many generic parameters the type has itself, which is what the base type editor's Var button is
   * gated on. Absent while creating one, where dnSpy allows every Var. */
  typeGenericParameterCount?: number
  /** The simple name of the module's corlib: the scope a type from there is named with. The Kind combo
   * reads the base type back to tell a class from a struct, an enum and a delegate, and it has to know
   * which `System.Object` it is looking at to do that — a type of one's own with that name is a class. */
  corlibScope?: string
}

/** What a create or edit dialog opens with, discriminated by the kind it was opened for: only the
 * member matching `kind` is set. */
export interface NodeOptionsDto {
  kind: string
  type?: TypeOptionsDto
  method?: MethodOptionsDto
  field?: FieldOptionsDto
  property?: PropertyOptionsDto
  event?: EventOptionsDto
}

/** Which node a dialog's model is read for: an existing one, or a new one belonging to `ownerNodeId`. */
export interface NodeOptionsRequest {
  nodeId?: string
  ownerNodeId?: string
  isNew?: boolean
  /** Whether a type is being created inside another one, which only the type kind reads: Create Nested
   * Type puts it in the selected type, Create Type at the top level whatever is selected. */
  nested?: boolean
}

/** The node a create or edit was queued for, and the name it will have once committed. */
export interface EditNodeResponse {
  nodeId: string
  label: string
  kind: string
}

/**
 * A process Attach to Process offers — dnSpy's AttachableProcessInfo: the executable's file name, the window title
 * (none on Linux), the runtime as "CoreCLR <version>", the architecture, the executable's path and the command line.
 */
export interface DebugProcess {
  processId: number
  name: string
  title?: string
  runtimeName?: string
  architecture?: string
  executablePath?: string | null
  commandLine?: string
}

export interface DebugStartResponse {
  sessionId: string
  capabilities: Record<string, unknown>
}

/** A row of the Threads window — dnSpy's ThreadVM columns. */
export interface DebugThread {
  id: number
  name: string
  managedId?: number | null
  managedName?: string | null
  osName?: string | null
  /** Main, Finalizer, GC, ThreadPool, Worker or Terminated. */
  category?: string
  /** The thread's top frame, written the way the Call Stack window writes it. */
  location?: string | null
  priority?: number | null
  nice?: number | null
  affinityMask?: string | null
  suspendedCount?: number
  isFrozen?: boolean
  processId?: number
  processName?: string | null
  appDomainId?: number | null
  appDomainName?: string | null
  state?: string[]
  isMain?: boolean
}

export interface DebugSource {
  name?: string
  path?: string
  sourceReference?: number
}

export interface DebugStackFrame {
  id: number
  name: string
  line: number
  column: number
  source?: DebugSource
  /** The tree node the frame's location decompiles to, when the module is in the workspace. */
  nodeId?: string
  /** The name in the colours dnSpy's CSharpStackFrameFormatter writes it in. */
  nameParts?: TextPart[]
  description?: string | null
  metadataToken?: number
  ilOffset?: number
  nativeAddress?: number
  /** A native-to-managed transition or another frame without code of its own. */
  isInternal?: boolean
  /** False for a deep frame whose line is only looked up when the user switches to it. */
  locationResolved?: boolean
}

/** What a frame's row shows — dnSpy's CallStackDisplaySettings, plus the hex options it shares with the
 * variables windows. */
export interface DebugStackFrameFormat {
  showModuleNames: boolean
  showParameterTypes: boolean
  showParameterNames: boolean
  showParameterValues: boolean
  showFunctionOffset: boolean
  showReturnTypes: boolean
  showNamespaces: boolean
  showIntrinsicTypeKeywords: boolean
  showDeclaringTypes: boolean
  showTokens: boolean
  useHexadecimal: boolean
  useDigitSeparators: boolean
}

/** Where a frame decompiles to, read when the user switches to a frame the stack left unresolved. */
export interface DebugFrameLocation {
  line: number
  column: number
  endLine: number
  endColumn: number
  nodeId?: string | null
  description?: string | null
  modulePath: string
  metadataToken: number
  ilOffset: number
  isExternalModule: boolean
}

/** How a condition decides: the expression is true, or its value differs from the last hit's. */
export type BreakpointConditionKind = 'isTrue' | 'whenChanged'

export type BreakpointHitCountKind = 'equals' | 'multipleOf' | 'greaterThanOrEquals'

/**
 * The extra settings a breakpoint can carry, matching dnSpy's `DbgCodeBreakpointSettings` minus
 * `IsEnabled`, which the breakpoint already has of its own.
 */
export interface BreakpointSettings {
  /** An expression checked at the hit; the breakpoint only stops when it passes. */
  condition?: { kind: BreakpointConditionKind; expression: string }
  /** How many matching hits to let by before stopping. */
  hitCount?: { kind: BreakpointHitCountKind; count: number }
  /** An expression over the machine, process and thread, checked before the condition. */
  filter?: string
  /** A message printed at the hit; `continue` makes the breakpoint a tracepoint rather than a stop. */
  trace?: { message: string; continue: boolean }
  labels?: string[]
}

/** A breakpoint the client asked for, before or after the engine snapped it to a sequence point. */
export interface DebugBreakpointRequest {
  id: string
  nodeId: string
  line: number
  column?: number
  enabled: boolean
  /**
   * The IL identity the breakpoint was last resolved to, sent so a breakpoint restored from settings
   * can be resolved without a live node id — ids are issued per workspace and do not survive a restart.
   */
  modulePath?: string
  metadataToken?: number
  sourceMethodToken?: number
  ilOffset?: number
  settings?: BreakpointSettings
}

/** A method breakpoint, which the engine matches by name rather than by location. */
export interface DebugFunctionBreakpointRequest {
  /** The client's id for it, which the engine's reports name it by. */
  id?: string
  name: string
  settings?: BreakpointSettings
}

/** One category of exception types, eg. the CLR's own. */
export interface DebugExceptionCategory {
  name: string
  displayName: string
  shortDisplayName: string
  /** Whether the category's types are identified by a number rather than a name. */
  hasCode: boolean
  decimalCode: boolean
  unsignedCode: boolean
}

/** A module-name condition, the only kind the exception window offers. */
export interface DebugExceptionCondition {
  type: 'moduleNameEquals' | 'moduleNameNotEquals'
  value: string
}

/**
 * A type the engine can break on, as the Exception Settings window renders it. The defaults come from
 * the definition files and never change; `stopFirstChance` and the rest are what the user has made of
 * them. A row with no name and no code is the category's own default, which covers every type the
 * category does not name.
 */
export interface DebugExceptionSettings {
  /** Opaque; the client only round-trips it back in a diff. */
  key: string
  category: string
  name: string | null
  code: number | null
  description: string | null
  defaultStopFirstChance: boolean
  defaultStopSecondChance: boolean
  stopFirstChance: boolean
  stopSecondChance: boolean
  conditions: DebugExceptionCondition[]
}

/** The engine's whole exception list: the categories in display order, then every type in them. */
export interface DebugExceptionSettingsList {
  categories: DebugExceptionCategory[]
  exceptions: DebugExceptionSettings[]
}

/** One row of the diff the client stores: a change against the defaults, not a whole list. */
export interface DebugExceptionDiffEntry {
  category: string
  name?: string | null
  code?: number | null
  description?: string | null
  stopFirstChance?: boolean
  stopSecondChance?: boolean
  conditions?: DebugExceptionCondition[]
}

/** What the client persists and replays: the same Add/Remove/Update dnSpy's settings file holds. */
export interface DebugExceptionDiff {
  added?: DebugExceptionDiffEntry[]
  removed?: DebugExceptionDiffEntry[]
  updated?: DebugExceptionDiffEntry[]
}

/** The engine's answer: where the breakpoint really is, and whether it is armed. */
export interface DebugBreakpoint {
  id: string
  verified: boolean
  state: 'bound' | 'pending' | 'unbound'
  line: number
  endLine: number
  column: number
  message?: string
  modulePath?: string
  metadataToken: number
  /** The method a user navigates to — `metadataToken` except inside a state machine. */
  sourceMethodToken: number
  ilOffset: number
  description?: string
  enabled: boolean
  /** How many times the engine has reached the breakpoint and its condition and filter passed. */
  hitCount?: number
  /** dnSpy's bound message severity: a location the runtime refused is an error, one not bound for another reason a warning. */
  severity?: 'warning' | 'error' | null
}

/** A reference a debugger command acts on: a tree node, or a definition named by its module and token. */
export interface DebugCodeReference {
  nodeId?: string | null
  modulePath?: string | null
  metadataToken?: number | null
}

/** A method a breakpoint goes at the entry of. */
export interface DebugMethodTarget {
  modulePath: string
  metadataToken: number
  description: string
  /** False for an abstract method, which the commands collect and skip when they add the breakpoints. */
  hasBody: boolean
}

/** What a context menu's debugger commands act on — see `DebugCodeTargetsResponse` in the backend's protocol. */
export interface DebugCodeTargets {
  methods: DebugMethodTarget[]
  typeMethods?: DebugMethodTarget[] | null
  typeName?: string | null
  exceptionTypeName?: string | null
}

/** A code breakpoint as dnSpy's breakpoint file holds it. */
export interface BreakpointFileEntry {
  modulePath: string
  metadataToken: number
  ilOffset: number
  enabled: boolean
  settings?: {
    condition?: { kind: BreakpointConditionKind; expression: string } | null
    hitCount?: { kind: BreakpointHitCountKind; count: number } | null
    filter?: string | null
    trace?: { message: string; continue: boolean } | null
    labels?: string[] | null
  } | null
  method?: string | null
}

export interface DebugScope {
  name: string
  variablesReference: number
  expensive: boolean
}

/**
 * A row of a variables window (Locals, Autos, Watch): dnSpy's DbgValueNode, with its three columns in the
 * colours the value formatter writes them in. A non-zero `variablesReference` is a row that expands.
 */
export interface DebugVariable {
  name: string
  value: string
  type?: string
  variablesReference: number
  evaluateName?: string
  nameParts?: TextPart[]
  valueParts?: TextPart[]
  typeParts?: TextPart[]
  /** The row's PredefinedDbgValueNodeImageNames image, e.g. `Local`, `Field`, `Property`. */
  image?: string | null
  kind?: string | null
  isError?: boolean
  /** Whether the value column can be edited (a local, a field, an element, a settable property). */
  canEdit?: boolean
  /** A row that was not evaluated (side effects, a func-eval the options forbid) and offers a refresh. */
  needsRefresh?: boolean
  /** The `$N` object id the value has been given, if any. */
  objectId?: string | null
  /** The value as an expression that reads back to it, which an edit starts from. */
  editText?: string | null
}

/** The rows under an expanded row, a page at a time. */
export interface DebugVariablesPage {
  variables: DebugVariable[]
  totalCount?: number | null
}

/** A row of the Modules window — dnSpy's ModuleVM columns. */
export interface DebugModule {
  id: number | string
  name: string
  path?: string
  version?: string | null
  symbolStatus?: string
  isOptimized?: boolean | null
  isDynamic?: boolean
  isInMemory?: boolean
  isExe?: boolean
  order?: number
  timestamp?: string | null
  address?: number
  size?: number
  appDomainId?: number | null
  appDomainName?: string | null
  isJustMyCode?: boolean
  isProgramModule?: boolean
  processId?: number
}

/** The Processes window's row for a session's process. */
export interface DebugProcessInfo {
  id: number
  name?: string | null
  path?: string | null
  state: 'Running' | 'Paused' | 'Terminated'
  debugging: string
  architecture: string
  /** False for a process the debugger attached to: Stop detaches from it rather than killing it. */
  ownsDebuggee: boolean
}

/** Bytes of the debuggee: a readable flag per 4 KiB page, so an unmapped page shows as `??`. */
export interface DebugMemory {
  address: string
  /** Base64. */
  data: string
  readable: boolean[]
  pageSize: number
}

/** The Disassembly view's options: dnSpy's DisassemblyContentSettings and the dialect's code style. */
export interface DebugDisassemblyOptions {
  syntax: 'masm' | 'nasm' | 'gas' | 'intel'
  showInstructionAddress: boolean
  showInstructionBytes: boolean
  showILCode: boolean
  showCode: boolean
  emptyLineBetweenBasicBlocks: boolean
  addLabels: boolean
  codeStyle?: Record<string, unknown>
}

/** A method's native code as the JIT compiled it, one coloured line per row; `currentLine` is the frame's. */
export interface DebugDisassembly {
  title: string
  moduleName?: string | null
  methodName?: string | null
  /** The method's short name, which the Disassembly tab is titled with. */
  shortName?: string | null
  isOptimized?: boolean | null
  address: number
  size: number
  lines: TextPart[][]
  currentLine: number
}

export interface DebugEvent {
  sessionId: string
  event: string
  body?: Record<string, unknown>
}

/**
 * Start parameters collected by the "Debug Program" dialog. Mirrors the CoreCLR page of the
 * upstream `DebugProgramDlg` (executable, arguments, working directory, environment, break-at);
 * the backend's `DebugLaunchRequest` accepts every field.
 */
export interface DebugLaunchOptions {
  program: string
  arguments?: string[]
  workingDirectory?: string
  environment?: Record<string, string>
  /** `true` arms a breakpoint on the entry point, matching `PredefinedBreakKinds.EntryPoint`. */
  stopAtEntry?: boolean
  /** WPF-compatible startup break kind; omitted requests the legacy `stopAtEntry` behavior. */
  breakKind?: 'DontBreak' | 'CreateProcess' | 'EntryPoint' | 'ModuleCctorOrEntryPoint'
  /**
   * The upstream CoreCLR page's "Use host executable". `true` starts the target through `host`
   * (`host hostArguments program arguments`); `false` runs `program` itself, which must then be a
   * native host such as an apphost. Omitted keeps the engine's own extension guess — a .dll through
   * the `dotnet` host, anything else directly.
   */
  useHost?: boolean
  /** Path to the host (eg. `dotnet`), or omitted to let the backend find it on `PATH`. */
  host?: string
  /** Arguments for the host itself, eg. `['exec']` for the `dotnet` CLI. */
  hostArguments?: string[]
  workspaceId?: string
}

/**
 * One line of the C# Interactive log. Mirrors the backend's `ScriptOutputEntry`; `echo` and `help`
 * are the kinds the window itself produces, the rest come from the host.
 */
export type ScriptOutputKind = 'output' | 'result' | 'error' | 'banner' | 'echo' | 'help'

export interface ScriptOutputEntry {
  kind: ScriptOutputKind
  text: string
  /** A color class name the line carries of its own — what a script's `Print(TextColor, ...)` asks for. */
  color?: string | null
  /** An `echo` entry's semantic colors, the ones its input had when it was submitted. */
  colors?: ClassifiedSpan[]
}

export interface ScriptEvaluateResponse {
  entries: ScriptOutputEntry[]
  /** The session the submission ran in; a response from an older generation belongs to a reset engine. */
  generation: number
}

/** What `#reset` passes: `loadConfig` is the `noconfig` argument; `showBanner` is the window opening. */
export interface ScriptResetOptions {
  loadConfig?: boolean
  showBanner?: boolean
}

export interface ScriptResetResponse {
  entries: ScriptOutputEntry[]
  generation: number
}

/** A notification: one line a submission produced, sent while it still runs. */
export interface ScriptOutputNotification {
  generation: number
  entry: ScriptOutputEntry
}

/** A script's `Ask<T>`: the input box the window shows, and what it displays beside it. */
export interface ScriptAskRequest {
  id: string
  label: string
  defaultText?: string | null
  title?: string | null
  /** Why the previous answer was refused, or null for the first ask. */
  error?: string | null
}

/** The user interface languages: English and the cultures dnSpy ships a `*.Resources.<culture>.resx` for. */
export type UiLocale = 'cs' | 'de' | 'en' | 'es-ES' | 'fa' | 'fr' | 'hu' | 'it' | 'pt-BR' | 'pt-PT' | 'ru' | 'tr' | 'uk' | 'vi' | 'zh-CN'

/** dnSpy's AppCommandLineArgs, parsed the way it parses them. A second instance forwards its own to the first. */
export interface AppCommandLine {
  /** The files to open, made absolute against the directory the process was started in. */
  paths: string[]
  /** `--settings-file`: where the settings live instead of the profile directory. */
  settingsFile?: string
  /** False for `--multiple`, which never hands its arguments to a running instance. */
  singleInstance: boolean
  /** False for `--dont-activate`: a forwarded command line leaves the window where it is. */
  activate: boolean
  /** `-l`: the decompiler language, by name ("C#", "IL", "Visual Basic", "IL with C#"). */
  language?: string
  /** `--culture`: the user interface language, as a culture name such as `zh-CN`. */
  culture?: string
  /** `--select`: a token or an XML documentation id to follow in the files once they are open. */
  selectMember?: string
  /** `--new-tab`: open a new, empty tab. */
  newTab: boolean
  searchText?: string
  searchFor?: string
  searchIn?: string
  /** `--theme`: a theme's name or GUID. */
  theme?: string
  /** `--no-load-files` (dnSpy's `--dont-load-files`): leave the last session's files where they are. */
  noLoadFiles: boolean
  /** `--full-screen` is true and `--not-full-screen` false; neither leaves the window as it was. */
  fullScreen?: boolean
  /** Comma-separated tool window GUIDs, each optionally followed by `!` and a location. */
  showToolWindow?: string
  hideToolWindow?: string
  showStartupTime: boolean
  debugAttachPid?: number
  debugAttachProcess?: string
  extensionDirectory?: string
  /** Every other option, by name: `--name` or `--name:value`. dnSpy's `--settings[:guid]` is one of these. */
  userArgs: Record<string, string>
}

/** What the process was started with, and the window title it was given. */
export interface StartupOptions {
  commandLine: AppCommandLine
  /** dnSpy's "dnSpy <version> (64-bit, .NET, Administrator)". */
  title: string
  version: string
  /** When the main process started (epoch milliseconds), which `--show-startup-time` measures from. */
  processStartTime: number
}

/**
 * The options the main process keeps in a file of its own, because it has to know them before there is a
 * renderer to ask. The option store in the renderer is the one that is written; it hands these down so the
 * file stays a copy of what the user last chose.
 */
export interface AppMainSettings {
  /** dnSpy's AllowMoreThanOneInstance: the single instance lock is not taken when it is on, so a second
   * dnSpy starts beside this one instead of handing its command line over. Read at startup. */
  allowMoreThanOneInstance: boolean
}

/** One background image the renderer may draw: its file name, and its bytes as a data URL. */
export interface BackgroundImageData {
  name: string
  dataUrl: string
}

/** A `.dntheme` file of one of the Themes directories dnSpy reads its themes from, and where it was found. */
export interface ThemeFile {
  path: string
  text: string
}

export interface DnSpyApi {
  openAssemblies(): Promise<string[]>
  /** The `.dntheme` files of the Themes directories — next to the executable, then the user's — read before
   * the first paint, so a theme of the user's is on the window from the start, the way dnSpy loads them before
   * its window opens. Absent outside Electron. */
  themeFiles?: ThemeFile[]
  getStartupOptions(): Promise<StartupOptions>
  /** Narrows a remembered path list to the files still on disk. Used before restoring a session, where
   * one file that has since been deleted would otherwise fail the whole open. */
  filterExistingPaths(paths: string[]): Promise<string[]>
  openWorkspace(paths: string[]): Promise<OpenWorkspaceResponse>
  /** Adds assemblies to the workspace that is already open, the way dnSpy's Open command grows the tree
   * instead of replacing it. Paths already open come back in `skipped`. */
  addModules(workspaceId: string, paths: string[]): Promise<AddModulesResponse>
  closeWorkspace(workspaceId: string): Promise<void>
  /** Drops every assembly and loads the files the user opened again, discarding edits — dnSpy's Reload All
   * Assemblies. Of the files the workspace opened by itself only `autoLoadedPaths` come back, auto-loaded as they
   * were: the ones a tab still shows something of. The workspace keeps its id, but every node id is stale. */
  reloadWorkspace(workspaceId: string, autoLoadedPaths?: string[]): Promise<OpenWorkspaceResponse>
  /** Reorders the root nodes by name and answers with the tree in its new order — dnSpy's Sort Assemblies. */
  sortAssemblies(workspaceId: string): Promise<TreeNodesResponse>
  /** Removes one assembly from the tree — dnSpy's Remove Assembly — and answers with what is left. */
  removeModule(workspaceId: string, nodeId: string): Promise<RemoveModuleResponse>
  /** Removes several documents from the tree at once — dnSpy's Remove Assembly over a multiple
   *  selection, and its Close All Framework Assemblies / Close All Missing Files sweeps. */
  removeModules(workspaceId: string, nodeIds: string[]): Promise<RemoveModulesResponse>
  /** Which of the workspace's modules hold edits that have not been saved. */
  getModifiedModules(workspaceId: string, nodeIds?: string[]): Promise<ModifiedModulesResponse>
  /** The roots dnSpy's two Close All sweeps would remove: the framework assemblies and the
   *  documents that are not PE images (a missing file is one of those). */
  getCloseCandidates(workspaceId: string): Promise<CloseCandidatesResponse>
  /** Moves roots to another place in the tree — what dragging them does. */
  moveRoots(workspaceId: string, nodeIds: string[], index: number): Promise<TreeNodesResponse>
  /** What activating a row — a double click, Enter — goes to: the definition a reference row names,
   *  or the assembly an assembly reference names, opened when it has to be. */
  activateNode(workspaceId: string, nodeId: string): Promise<ActivateNodeResponse>
  /** Opens the files dropped on the tree at the place they were dropped, filtered the way the
   *  Assembly Explorer's "dragged items" option says. */
  dropFiles(workspaceId: string | null, paths: string[], index: number, filter: DropFilter): Promise<DropFilesResponse>
  /** The file a dropped `File` stands for. Electron no longer puts the path on the object itself, so the
   *  preload asks `webUtils` for it; a file that is not on disk answers with an empty string. */
  pathForFile(file: File): string
  /** Every assembly in the global assembly caches on this machine. */
  listGacAssemblies(): Promise<GacListResponse>
  /** The company and file version of one GAC file, which the dialog shows for its selection. */
  getGacDetails(path: string): Promise<GacDetailsResponse>
  /** The lists Open List offers beside the user's own: one per .NET shared framework on this machine. */
  listDefaultDocumentLists(): Promise<DocumentListsResponse>
  /** The bytes several resource nodes hold — what Save Resource writes, one file per item. */
  getResourceItems(workspaceId: string, nodeIds: string[], raw: boolean): Promise<ResourceItemsResponse>
  /** The names those files would have, both ways, for the Save commands' headers. */
  getResourceItemNames(workspaceId: string, nodeIds: string[]): Promise<ResourceItemNamesResponse>
  /** The node a command line's `--select` names in the files at `paths`: a token, "N:" and a namespace, or an
   *  XML documentation id. */
  selectMember(workspaceId: string, paths: string[], member: string): Promise<SelectMemberResponse>
  /** The resource node that holds the data a Resources property or method reads — dnSpy's Go to Resource. */
  findResource(workspaceId: string, nodeId: string): Promise<FindResourceResponse>
  /**
   * The module's entry point, or the static constructor of its global type — dnSpy's "Go to Entry
   * Point" and "Go to Global Cctor". The node names which module to look in; any node inside it does.
   */
  getSpecialNode(workspaceId: string, nodeId: string, kind: SpecialNodeKind): Promise<SpecialNodeResponse>
  /** The node a metadata token names, for dnSpy's "Go to Token". The token may carry its `0x`. */
  findByToken(workspaceId: string, nodeId: string, token: string): Promise<FindByTokenResponse>
  /**
   * Opens the assemblies a module's references name — dnSpy's Load Dependencies. The recursive form
   * follows the closure instead of stopping at the module's own references.
   */
  loadDependencies(workspaceId: string, nodeId: string, recursive: boolean): Promise<AddModulesResponse>
  /** Shows a file in the desktop's file manager — dnSpy's Open Containing Folder. */
  showItemInFolder(path: string): Promise<void>
  /**
   * dnSpy's Save and Raw Save over the selected resources: one file goes through a save dialog, several into
   * a folder the user picks. A .resources file saves as its entries, so even one resource can be several
   * files; `raw` writes an entry's serialized bytes instead of its value, and `useSubDirs` keeps the directories
   * in the names when several go into a folder. Answers the files written — none when a dialog was cancelled.
   */
  saveResource(workspaceId: string, nodeIds: string[], raw: boolean, useSubDirs?: boolean): Promise<string[]>
  /** dnSpy's "The file hasn't been saved yet. Do you want to save it before continuing?" for `count` files: save
   *  them first, let them go unsaved, or call the command off. */
  askSaveModified(count: number): Promise<'save' | 'discard' | 'cancel'>
  /** dnSpy's "There are {0} unsaved files. Do you want to save them before exiting?": Yes or No, and closing the
   *  box calls the exit off. */
  askExitUnsaved(count: number): Promise<'save' | 'discard' | 'cancel'>
  getRoots(workspaceId: string): Promise<TreeNodesResponse>
  getChildren(workspaceId: string, nodeId: string): Promise<TreeNodesResponse>
  getNode(workspaceId: string, nodeId: string): Promise<TreeNode>
  /**
   * The chain from a root down to a node, the root first and the node itself last — what the explorer
   * needs for a node it has never listed, since a node id alone does not name its ancestors. Empty for a
   * node that hangs off no root.
   */
  getNodePath(workspaceId: string, nodeId: string): Promise<TreeNodesResponse>
  decompile(workspaceId: string, nodeId: string, language: DecompilerLanguage, settings?: DecompilerSettings): Promise<DecompileResponse>
  /** Resolves a target by module path and token, since node ids are session-local. A module the workspace does not hold is opened on demand. */
  findMember(workspaceId: string, modulePath: string, metadataToken: number): Promise<FindMemberResponse>
  /** The Quick Info for a reference under the cursor: the member as the document's language writes it, and its XML documentation. */
  quickInfo(workspaceId: string, request: DocumentQuickInfoRequest): Promise<DocumentQuickInfoResponse>
  /**
   * The Bookmarks window's Location cells, written the way dnSpy's C# formatter writes them with the display
   * options given. A module the workspace does not hold is read from its file, so no workspace is needed.
   */
  formatBookmarkLocations(workspaceId: string | undefined, locations: BookmarkLocation[], format: BookmarkLocationFormat): Promise<BookmarkLocationText[]>
  /** The bookmarks as a dnSpy bookmark file (its settings XML), ready to be written out. */
  exportBookmarks(workspaceId: string | undefined, bookmarks: BookmarkFileEntry[]): Promise<string>
  /** Reads a dnSpy bookmark file — or a whole dnSpy settings file, which keeps them in the same section. */
  importBookmarks(workspaceId: string | undefined, xml: string): Promise<ImportBookmarksResponse>
  /** Runs a search; `requestKey` names it to `cancelSearch` and to the batches `onSearchProgress` hands over. */
  search(workspaceId: string, request: SearchRequest, requestKey: string): Promise<SearchResponse>
  cancelSearch(requestKey: string): Promise<void>
  /** Writes the results `count` from `start` of the search run as `requestKey` again, through `language`. */
  relabelSearch(workspaceId: string, requestKey: string, language: DecompilerLanguage, start: number, count: number): Promise<SearchResponse>
  /** The analyzer rows of tree nodes — what dnSpy's analyzer adds for a member it is asked to analyze — written
   * through the decompiler named, C# when none is. */
  analyzeNodes(workspaceId: string, nodeIds: string[], language?: DecompilerLanguage): Promise<AnalyzeNodesResponse>
  /**
   * What an analyzer row expands to: a member's searches and accessor rows, or what a search finds. A
   * search can run for a while; `requestKey` names it to `cancelAnalyze`, which a row collapsed while its
   * search is still running calls.
   */
  analyzeChildren(workspaceId: string, request: AnalyzeChildrenRequest, requestKey: string): Promise<AnalyzeChildrenResponse>
  cancelAnalyze(requestKey: string): Promise<void>
  getHexLength(workspaceId: string, moduleId: string): Promise<HexLengthResponse>
  readHex(workspaceId: string, moduleId: string, offset: number, count: number): Promise<HexReadResponse>
  /** Where the hex commands point for a selected node: a method's body and code, a field's initial
   * value, a resource's data. */
  resolveHexTarget(workspaceId: string, nodeId: string): Promise<HexTargetResponse>
  /** dnSpy's AsmEditor hex nodes: a PE header, the tables stream header or a metadata row as fields. */
  getHexStructure(workspaceId: string, nodeId: string): Promise<HexStructure>
  getMetadataTable(workspaceId: string, nodeId: string): Promise<MetadataTable>
  getMetadataTableRows(workspaceId: string, nodeId: string, startRid: number, count: number): Promise<{ rows: MetadataRow[] }>
  /** dnSpy's TableSorter over a run of rows: the rows' bytes in sorted order, which the client writes as a patch. */
  sortMetadataTable(workspaceId: string, nodeId: string, rid: number, count: number): Promise<{ offset: number; base64Data: string }>
  /** dnSpy's Copy as Text of a metadata table: its header and the rows. */
  getMetadataTableText(workspaceId: string, nodeId: string, rids: number[]): Promise<{ text: string }>
  /** The metadata row of a token in the document a node is in — dnSpy's Go to MD Table Row. */
  findMetadataRecord(workspaceId: string, nodeId: string, token: number): Promise<MetadataFindRecordResponse>
  /** Where a statement under the caret of a code document lives in the file. */
  resolveHexStatement(workspaceId: string, modulePath: string, metadataToken: number, ilOffset: number, ilEndOffset: number): Promise<HexStatementResponse>
  /** Queues a raw byte patch over the module's file image, undone and redone with the rest of the
   * transaction's edits. */
  patchHex(workspaceId: string, transactionId: string, nodeId: string, offset: number, base64Data: string): Promise<void>
  /** What the Go to Position dialog was given — "absolute", "file", "rva" or "current" — as a file
   * offset, or -1 when the file has no such position. */
  resolveHexPosition(workspaceId: string, moduleId: string, kind: HexPositionKind, value: number): Promise<HexResolvePositionResponse>
  /** What the Go to Metadata dialog was given as the file range it names, or null when the file has no
   * such item. */
  goToHexMetadata(workspaceId: string, moduleId: string, kind: HexMetadataKind, value: number): Promise<HexGoToMetadataResponse>
  /** One Find step: the offset the pattern was found at, or -1. */
  findHex(workspaceId: string, moduleId: string, base64Pattern: string, start: number, reverse: boolean, wrap: boolean): Promise<HexFindResponse>
  /** Saves a byte range of the file to a file the user picks — dnSpy's Save Selection. Answers the path
   * written, or undefined when the dialog was cancelled. */
  saveHexSelection(workspaceId: string, moduleId: string, offset: number, count: number, suggestedName?: string): Promise<string | undefined>
  getModuleInfo(workspaceId: string, moduleId: string): Promise<ModuleInfoResponse>
  beginEdit(workspaceId: string): Promise<BeginEditResponse>
  getMethodBody(workspaceId: string, methodNodeId: string): Promise<MethodBodyResponse>
  /** The full method-body model the Edit Method Body window works on. */
  getIlBody(workspaceId: string, methodNodeId: string): Promise<IlMethodBody>
  /** Writes an edited body back through the transaction; nothing changes until it is committed. */
  queueIlBody(workspaceId: string, transactionId: string, methodNodeId: string, body: IlMethodBody): Promise<void>
  /** Runs one of dnSpy's IL editor commands over a body that is still being edited. `operation` is one
   *  of the backend's IlTransformOperations names. */
  transformIlBody(workspaceId: string, methodNodeId: string, operation: string, locals: IlLocal[], instructions: IlBodyInstruction[], selectedIndexes: number[], parameterNames: string[]): Promise<TransformIlBodyResponse>
  /** The dialog model behind a node, which is what an Edit dialog opens with, or the defaults a create
   * dialog starts from when `isNew` is set. Read-only: nothing about it is queued until the dialog is
   * accepted. `ownerNodeId` is what tells the backend where a new member would go — which type it
   * belongs to, and with it whether a new type is nested or top-level. */
  getNodeOptions(workspaceId: string, kind: string, request: NodeOptionsRequest): Promise<NodeOptionsDto>
  /** Adds a type or a member to the node that owns it. The response names the row that was created,
   * which is the node the client reveals once the transaction is committed. */
  createNode(workspaceId: string, transactionId: string, ownerNodeId: string, options: NodeOptionsDto, nested?: boolean): Promise<EditNodeResponse>
  /** Writes a dialog's model over an existing type or member. */
  setNodeOptions(workspaceId: string, transactionId: string, nodeId: string, options: NodeOptionsDto): Promise<EditNodeResponse>
  queueRename(workspaceId: string, transactionId: string, nodeId: string, newName: string): Promise<void>
  /** Removes a type, member, resource, or every type of a namespace from its owner. */
  queueDelete(workspaceId: string, transactionId: string, nodeId: string): Promise<void>
  /** Renames a namespace, or moves its types to the empty namespace when `newName` is empty. */
  queueSetNamespace(workspaceId: string, transactionId: string, nodeId: string, newName: string): Promise<void>
  queueMethodBody(workspaceId: string, transactionId: string, methodNodeId: string, body: MethodBodyResponse, clearExceptionHandlers: boolean): Promise<void>
  /** Replaces a method body with the stub the backend derives from the method's signature. */
  queueMethodBodyStub(workspaceId: string, transactionId: string, methodNodeId: string): Promise<void>
  replaceResourceFromFile(workspaceId: string, transactionId: string, resourceNodeId: string): Promise<boolean>
  /** The manifest-resource model the Edit Resource dialog opens with. */
  /** Compiles C# source for an Edit Code window; with a transactionId and no errors, queues the import. */
  compileSource(workspaceId: string, nodeId: string, mode: CompilerMode, source: string, transactionId?: string, language?: CompilerLanguage, settings?: CompilerSettings): Promise<CompileSourceResponse>
  /** The assembly's attributes as C# source, which is what Edit Assembly Attributes opens with. */
  getAssemblyAttributesSource(workspaceId: string, nodeId: string, language?: CompilerLanguage): Promise<{ source: string }>
  /** Picks an assembly to merge into the module — dnSpy's Merge with Assembly. */
  mergeAssembly(workspaceId: string, transactionId: string, nodeId: string): Promise<boolean>
  getAssemblyOptions(workspaceId: string, nodeId: string): Promise<AssemblyOptions>
  setAssemblyOptions(workspaceId: string, transactionId: string, nodeId: string, options: AssemblyOptions): Promise<void>
  getModuleOptions(workspaceId: string, nodeId: string): Promise<ModuleOptions>
  setModuleOptions(workspaceId: string, transactionId: string, nodeId: string, options: ModuleOptions): Promise<void>
  getResourceOptions(workspaceId: string, resourceNodeId: string): Promise<ResourceOptions>
  setResourceOptions(workspaceId: string, transactionId: string, resourceNodeId: string, options: ResourceOptions): Promise<void>
  /** Creates a resource — one of dnSpy's Create ... Resource commands. */
  createResource(workspaceId: string, transactionId: string, ownerNodeId: string, options: { kind: ResourceCreateKind, name: string, attributes: number, base64Data?: string, text?: string, assemblyFullName?: string, linkedFileName?: string, fileContainsNoMetadata?: boolean, entries?: CreateResourceEntry[] }): Promise<{ nodeId: string, label: string }>
  /** The model of one .resources entry, and its write-back. */
  getResourceElementOptions(workspaceId: string, nodeId: string): Promise<ResourceElementOptions>
  setResourceElementOptions(workspaceId: string, transactionId: string, nodeId: string, options: ResourceElementOptions): Promise<void>
  createResourceElement(workspaceId: string, transactionId: string, resourceNodeId: string, options: { kind: ResourceElementKind, name: string, text?: string, base64Data?: string }): Promise<void>
  /** Turns the module into an assembly or back — dnSpy's two Convert commands. `toAssembly` picks the
   * direction; nothing is written until the transaction is committed. */
  convertModule(workspaceId: string, transactionId: string, nodeId: string, toAssembly: boolean): Promise<void>
  commitEdit(workspaceId: string, transactionId: string): Promise<EditCommitResponse>
  rollbackEdit(workspaceId: string, transactionId: string): Promise<void>
  undoEdit(workspaceId: string): Promise<EditCommitResponse>
  redoEdit(workspaceId: string): Promise<EditCommitResponse>
  saveModuleAs(workspaceId: string, moduleId: string, suggestedName: string, options?: SaveModuleOptions): Promise<SaveModuleResponse | undefined>
  /** Writes a module back over the file it was loaded from — dnSpy's Save. */
  saveModule(workspaceId: string, moduleId: string, options?: SaveModuleOptions): Promise<SaveModuleResponse>
  /** Writes every modified module back over its own file — dnSpy's Save All. */
  saveAllModules(workspaceId: string, options?: SaveModuleOptions): Promise<SaveAllResponse>
  /** The bytes of IL instructions, in the order named — dnSpy's Copy IL Bytes. "??" stands for a byte only a save
   *  can tell, which `hasUnknownBytes` reports. */
  getIlBytes(workspaceId: string, modulePath: string, instructions: { metadataToken: number; ilOffset: number }[]): Promise<{ hex: string; hasUnknownBytes: boolean }>
  /** An empty workspace, for a document a command makes before anything was opened. */
  createWorkspace(): Promise<OpenWorkspaceResponse>
  /** dnSpy's Create Assembly, queued in a transaction: the node the new document will be. */
  createAssembly(workspaceId: string, transactionId: string, options: AssemblyOptions, clrVersion: string): Promise<{ nodeId: string; label: string }>
  /** dnSpy's Create NetModule, queued in a transaction. */
  createNetModule(workspaceId: string, transactionId: string, name: string, mvid: string, clrVersion: string): Promise<{ nodeId: string; label: string }>
  /** dnSpy's Add New / Add Existing NetModule to Assembly: a new one from its options, or the file at `path`. */
  addNetModule(workspaceId: string, transactionId: string, assemblyNodeId: string, module: { name: string; mvid: string; clrVersion: string } | { path: string }): Promise<{ nodeId: string; label: string }>
  /** dnSpy's Remove NetModule from Assembly. */
  removeNetModule(workspaceId: string, transactionId: string, moduleNodeId: string): Promise<void>
  /** The .NET version a new net module of the assembly starts as. */
  getNetModuleDefaults(workspaceId: string, assemblyNodeId: string): Promise<{ clrVersion: string }>
  /** dnSpy's image pickers: several files for Create System.Data.Bitmap/Icon Resource (its ImagesFilter, with
   *  cursors), one for an image list's Add and Edit (the image list's own filter, without them). The files are read
   *  here, since the renderer may not read the disk. */
  pickImageFiles(multiple: boolean, includeCursors: boolean): Promise<ResourceImageFile[]>
  /** The picker of Add Existing NetModule: dnSpy's NetModuleFilter. */
  pickNetModuleFile(): Promise<string | undefined>
  /** The documents with unsaved changes — what Save All saves and what closing the window asks about. */
  getModifiedDocuments(workspaceId: string): Promise<ModifiedDocument[]>
  /** What a document's Save Module window opens with; `useMixedMode` re-reads the options for that writer. */
  getSaveOptions(workspaceId: string, documentId: string, useMixedMode?: boolean): Promise<DocumentSaveOptions>
  /** Writes the documents — dnSpy's Save Module and Save Modules windows. Progress arrives on `onSaveProgress`
   *  under `requestKey`, which `cancelSave` stops the run by. */
  saveDocuments(workspaceId: string, documents: SaveDocumentRequest[], requestKey: string): Promise<SaveDocumentsResponse>
  cancelSave(requestKey: string): Promise<void>
  onSaveProgress(callback: (progress: SaveDocumentsProgress) => void): () => void
  /** The save picker behind the "..." of the Save Module window's file name: a .NET module, or any file for a
   *  document saved as bytes. */
  pickSaveFileName(defaultPath: string, kind: 'module' | 'any', extension?: string): Promise<string | undefined>
  /** dnSpy's ValidateFileName for the window's file name: the message's template and the folder it names, or
   *  nothing when the name will do. */
  validateSaveFileName(fileName: string): Promise<{ template: string; folder?: string } | undefined>
  /** Writes text the user picks a file for — a decompiled document's code, or the Output window's log.
   *  `title` names the save box; without one it is the port's "Save Code". */
  saveCode(suggestedName: string, text: string, title?: string): Promise<string | undefined>
  /**
   * Picks a text file and returns its contents, or undefined when the picker was dismissed. `kind`
   * only titles the dialog — the two importers that use this read the same kind of JSON file.
   */
  readTextFile(kind?: 'bookmarks' | 'breakpoints'): Promise<string | undefined>
  /** Opens a directory chooser dialog for saving multiple resources. */
  selectDirectory(): Promise<string | undefined>
  /** Writes a file to the specified directory. Returns the full path if successful, undefined otherwise. */
  writeFile(directory: string, fileName: string, data: Uint8Array): Promise<string | undefined>
  chooseDebugTarget(): Promise<string | undefined>
  chooseDebugDirectory(): Promise<string | undefined>
  /** Picks the host executable for the Debug Program dialog's "Use host executable" field. */
  chooseDebugHost(): Promise<string | undefined>
  /** Where Save Module in the Modules window writes a module's image. */
  chooseDebugModuleSavePath(suggestedName: string): Promise<string | undefined>
  /** Whether a path names a file that is really on disk — the Debug Program dialog's live check on the
   * executable field, the port's `File.Exists`. */
  pathExists(path: string): Promise<boolean>
  listDebugProcesses(): Promise<DebugProcess[]>
  launchDebug(options: DebugLaunchOptions): Promise<DebugStartResponse>
  /** dnSpy's Start Without Debugging: the program runs on its own, and its process id comes back. */
  startWithoutDebugging(options: DebugLaunchOptions): Promise<number>
  attachDebug(processId: number, workspaceId?: string): Promise<DebugStartResponse>
  setBreakpoints(sessionId: string, breakpoints: DebugBreakpointRequest[]): Promise<DebugBreakpoint[]>
  /** What Add Method Breakpoint, Add Class Breakpoint and Break When Thrown act on for these references. */
  getDebugCodeTargets(workspaceId: string | undefined, references: DebugCodeReference[]): Promise<DebugCodeTargets>
  /** Writes breakpoints as dnSpy's breakpoint file. */
  exportBreakpoints(workspaceId: string | undefined, breakpoints: BreakpointFileEntry[]): Promise<string>
  /** Reads the breakpoints out of dnSpy's breakpoint file, and how many rows it dropped. */
  importBreakpoints(workspaceId: string | undefined, xml: string): Promise<{ breakpoints: BreakpointFileEntry[]; skipped: number }>
  setFunctionBreakpoints(sessionId: string, breakpoints: DebugFunctionBreakpointRequest[]): Promise<Record<string, unknown>>
  /** Releases a launch the engine held back until the client had armed its breakpoints. */
  configurationDone(sessionId: string): Promise<void>
  debugContinue(sessionId: string, threadId: number): Promise<Record<string, unknown>>
  debugPause(sessionId: string, threadId: number): Promise<Record<string, unknown>>
  debugNext(sessionId: string, threadId: number): Promise<Record<string, unknown>>
  debugStepIn(sessionId: string, threadId: number): Promise<Record<string, unknown>>
  debugStepOut(sessionId: string, threadId: number): Promise<Record<string, unknown>>
  getDebugThreads(sessionId: string): Promise<DebugThread[]>
  getDebugStackTrace(sessionId: string, threadId: number, format?: DebugStackFrameFormat): Promise<DebugStackFrame[]>
  getDebugScopes(sessionId: string, frameId: number): Promise<DebugScope[]>
  getDebugVariables(sessionId: string, variablesReference: number): Promise<DebugVariable[]>
  getDebugModules(sessionId: string): Promise<DebugModule[]>
  /** The exception types the engine can break on, with their default and current settings. */
  getExceptionSettings(): Promise<DebugExceptionSettingsList>
  /** Applies the client's stored diff against the defaults and answers with the resulting list. */
  applyExceptionSettings(diff: DebugExceptionDiff): Promise<DebugExceptionSettingsList>
  /** Drops every change and answers with the default list. */
  resetExceptionSettings(): Promise<DebugExceptionSettingsList>
  evaluateDebugExpression(sessionId: string, frameId: number, expression: string, options?: { allowSideEffects?: boolean; noFuncEval?: boolean }): Promise<DebugVariable>
  /** The engine's share of the debugger options: what it does on a stop and how it writes values. */
  setDebuggerOptions(options: Record<string, unknown>): Promise<void>
  getDebugFrameLocation(sessionId: string, frameId: number): Promise<DebugFrameLocation>
  getDebugChildren(sessionId: string, variablesReference: number, start?: number, count?: number): Promise<DebugVariablesPage>
  /** Writes a value: `expression` is the row's, `value` an expression in the debugger's language. */
  setDebugExpression(sessionId: string, frameId: number, expression: string, value: string): Promise<{ node: DebugVariable; error?: string | null }>
  getDebugAutos(sessionId: string, frameId: number): Promise<DebugVariable[]>
  getDebugStaticFields(sessionId: string, frameId: number): Promise<DebugVariable[]>
  makeDebugObjectId(sessionId: string, frameId: number, expression: string): Promise<string>
  deleteDebugObjectId(sessionId: string, id: string): Promise<void>
  /** Moves the stopped thread to another statement of its method: an editor location or a known IL offset. */
  setNextStatement(sessionId: string, threadId: number, location: { nodeId?: string; line?: number; column?: number; modulePath?: string; metadataToken?: number; ilOffset?: number }): Promise<void>
  runToDebugFrame(sessionId: string, frameId: number): Promise<void>
  /** The enabled rows of the Module Breakpoints window; a null field matches any module. */
  setDebugModuleBreakpoints(sessionId: string, breakpoints: { moduleName?: string; isDynamic?: boolean; isInMemory?: boolean; isLoaded?: boolean; order?: number; appDomainName?: string; processName?: string }[]): Promise<void>
  /** Continues to the statement under the caret: a temporary breakpoint there, on any thread. */
  runToDebugCursor(sessionId: string, location: { nodeId?: string; line?: number; column?: number; modulePath?: string; metadataToken?: number; ilOffset?: number }): Promise<void>
  freezeDebugThreads(sessionId: string, threadIds: number[], freeze: boolean): Promise<void>
  /** dnSpy's Reset Hit Count: the breakpoints, by the ids they were set with, count from 0 again. */
  resetDebugBreakpointHitCounts(sessionId: string, ids: string[]): Promise<void>
  /** Whether a breakpoint filter reads — null — or why not, for the settings dialog. */
  verifyBreakpointFilter(filter: string): Promise<string | null>
  renameDebugThread(sessionId: string, threadId: number, name: string | null): Promise<void>
  getDebugProcess(sessionId: string): Promise<DebugProcessInfo>
  readDebugMemory(sessionId: string, address: string, count: number): Promise<DebugMemory>
  writeDebugMemory(sessionId: string, address: string, data: string): Promise<void>
  disassembleDebugFrame(sessionId: string, target: { frameId: number } | { modulePath: string; metadataToken: number }, options: DebugDisassemblyOptions): Promise<DebugDisassembly>
  /** Writes a loaded module's image to `path`, or to a temporary file when there is none, and answers with it. */
  saveDebugModule(sessionId: string, moduleId: number, path?: string): Promise<string>
  disconnectDebug(sessionId: string, terminateDebuggee: boolean): Promise<void>
  /** Runs one submission in the C# Interactive session and returns the lines it produced. */
  evaluateScript(code: string): Promise<ScriptEvaluateResponse>
  /** Drops the C# Interactive session and builds a fresh one, reporting the engine banner. */
  resetScript(options?: ScriptResetOptions): Promise<ScriptResetResponse>
  /** Whether the C# Interactive input is a complete submission, which is what makes Enter run it. */
  isScriptComplete(code: string): Promise<{ complete: boolean }>
  /** Lines a submission prints while it is still running. */
  onScriptOutput(callback: (notification: ScriptOutputNotification) => void): () => void
  /** A script's `Ask<T>` box: answer with `respondScriptAsk`. */
  onScriptAsk(callback: (request: ScriptAskRequest) => void): () => void
  /** Answers the ask box; null is its Cancel button. */
  respondScriptAsk(id: string, text: string | null): Promise<void>
  minimizeWindow(): Promise<void>
  /** Restores and focuses the window, as the debugger does when the process breaks. */
  bringWindowToFront(): Promise<void>
  /** dnSpy's Give focus to debugged process: activates the process's window where the session allows it. */
  focusProcessWindow?(processId: number): Promise<boolean>
  toggleMaximizeWindow(): Promise<boolean>
  closeWindow(): Promise<void>
  isWindowMaximized(): Promise<boolean>
  setFullScreen(fullScreen: boolean): Promise<boolean>
  toggleFullScreen(): Promise<boolean>
  isFullScreen(): Promise<boolean>
  quit(): Promise<void>
  /** The images the Background Image window's paths name — files, and the images in the folders — read
   *  out as data URLs, since the renderer may not read the disk itself. */
  loadBackgroundImages(paths: string[]): Promise<BackgroundImageData[]>
  /** dnSpy's MsgBox: a message to read, with nothing to answer. */
  showMessage(message: string): Promise<void>
  /** dnSpy's ShowIgnorableMessage: a question with the buttons named, and a "Don't show again" box beside
   *  them. Answers the button that was chosen, and whether the box was ticked. */
  askMessage(message: string, buttons: string[]): Promise<{ button: string; dontShowAgain: boolean }>
  /** Reports whether there are unsaved edits, which the main process holds the close back over. */
  setUnsavedChanges(dirty: boolean): Promise<void>
  /** Answers the close the main process asked about: whether the window may go. */
  respondToClose(approved: boolean): Promise<void>
  /** Fired when the window is closing and there are unsaved edits to ask about. Answer with `respondToClose`. */
  onCloseRequested(callback: () => void): () => void
  /** dnSpy's Constants.IsRunningAsAdministrator: on Linux, uid 0. Hides "Restart as Administrator". */
  isRunningAsAdministrator(): Promise<boolean>
  /** Closes the app and starts an elevated copy in its place, the way dnSpy's runas restart does. */
  restartAsAdministrator(): Promise<void>
  getBackendStatus(): Promise<BackendStatus>
  getProcessId(): Promise<number>
  setLocale(locale: UiLocale): Promise<void>
  /** The font families installed on the machine, for when the renderer cannot list them itself. */
  listSystemFonts?(): Promise<string[]>
  /** Hands the main process the option values it keeps in a file of its own, for the next start to read. */
  updateMainSettings(settings: AppMainSettings): Promise<void>
  onWindowMaximizedChange(callback: (isMaximized: boolean) => void): () => void
  onFullScreenChange(callback: (isFullScreen: boolean) => void): () => void
  onBackendStatus(callback: (status: BackendStatus) => void): () => void
  onDebugEvent(callback: (event: DebugEvent) => void): () => void
  /** The command line a second process handed over — dnSpy's App.SwitchToOtherInstance — for this instance
   * to open the files in and follow the options of. */
  onCommandLine(callback: (commandLine: AppCommandLine) => void): () => void
  /** What an analyzer search found so far, sent while it still runs. */
  onAnalyzeProgress(callback: (progress: AnalyzeProgress) => void): () => void
  /** What a search window search found so far, sent while it still runs. */
  onSearchProgress(callback: (progress: SearchProgress) => void): () => void
  /** Scans modules for the strings dnSpy's String References window lists, sending batches named by `requestKey`. */
  searchStringReferences(workspaceId: string, request: StringReferencesSearchRequest, requestKey: string): Promise<StringReferencesSearchResponse>
  /** Calls off the scan started with `requestKey`. */
  cancelStringReferences(requestKey: string): Promise<void>
  /** What a string references search found so far, sent while it still runs. */
  onStringReferencesProgress(callback: (progress: StringReferencesProgress) => void): () => void

  /** The semantic colors of the C# Interactive window's input, compiled as the session's next submission. */
  classifyScript(code: string): Promise<ClassifyResponse>
  /** Opens a C# code document in a Roslyn workspace of its own; the other `codeDocument*` calls take its id. */
  openCodeDocument(request: CodeDocumentOpenRequest): Promise<CodeDocumentOpenResponse>
  updateCodeDocument(documentId: string, text: string): Promise<void>
  closeCodeDocument(documentId: string): Promise<void>
  classifyCodeDocument(documentId: string): Promise<ClassifyResponse>
  getCodeCompletion(documentId: string, position: number, triggerCharacter?: string | null): Promise<CodeCompletionResponse>
  getCodeCompletionDescription(documentId: string, resultId: number, index: number): Promise<CodeCompletionDescriptionResponse>
  getCodeQuickInfo(documentId: string, position: number): Promise<CodeQuickInfoResponse>
  getCodeSignatureHelp(documentId: string, position: number, triggerCharacter?: string | null): Promise<CodeSignatureHelpResponse>
  getCodeDiagnostics(documentId: string): Promise<CodeDiagnosticsResponse>
  getCodeIndentation(request: CodeIndentationRequest): Promise<CodeIndentationResponse>
  getCodeSelectionRanges(documentId: string, positions: number[]): Promise<CodeSelectionRangesResponse>
}

/** A stretch of code and the color class (one of the backend's TextColors) it is written in. */
export interface ClassifiedSpan {
  start: number
  length: number
  color: string
}

/** The colored stretches of a text, in order; text between them keeps the editor's own color. */
export interface ClassifyResponse {
  spans: ClassifiedSpan[]
}

/** What a code document compiles with — dnSpy's C# compiler settings, whose defaults the backend applies. */
export interface CodeCompilerOptions {
  optimize?: boolean
  checkOverflow?: boolean
  allowUnsafe?: boolean
  preprocessorSymbols?: string
}

export interface CodeDocumentOpenRequest {
  text: string
  /** The assemblies the code compiles against; absent means the framework the backend runs on. */
  references?: string[]
  options?: CodeCompilerOptions
}

export interface CodeDocumentOpenResponse {
  documentId: string
}

export interface CodeSpan {
  start: number
  length: number
}

export interface CodeTextEdit {
  start: number
  length: number
  newText: string
}

export interface CodeCompletionItem {
  index: number
  displayText: string
  displayTextPrefix: string
  displayTextSuffix: string
  inlineDescription: string
  filterText: string
  sortText: string
  insertText: string
  /** Roslyn's WellKnownTags: the kind ("Method") and accessibility ("Public") of the item. */
  tags: string[]
  matchPriority: number
  preselect: boolean
  /** The characters that commit the item as they are typed. */
  commitCharacters: string
  /** What committing does when it is more than putting `insertText` over the list's span. */
  edit?: CodeTextEdit | null
}

export interface CodeCompletionList {
  resultId: number
  span: CodeSpan
  /** Roslyn's builder mode: typing never commits an item. */
  suggestionMode: boolean
  items: CodeCompletionItem[]
}

export interface CodeCompletionResponse {
  list: CodeCompletionList | null
}

export interface CodeCompletionDescriptionResponse {
  parts: TextPart[]
}

export interface CodeQuickInfoSection {
  /** Roslyn's QuickInfoSectionKinds name: Description, DocumentationComments, Usage, TypeParameters, AnonymousTypes, Exception. */
  kind: string
  parts: TextPart[]
}

export interface CodeQuickInfo {
  span: CodeSpan
  /** The dnSpy image of the symbol. */
  glyph: string | null
  warning: boolean
  sections: CodeQuickInfoSection[]
}

export interface CodeQuickInfoResponse {
  quickInfo: CodeQuickInfo | null
}

export interface CodeSignatureParameter {
  name: string
  display: TextPart[]
  documentation: TextPart[]
  isOptional: boolean
}

/** A signature laid out the way Roslyn's SignatureHelpItem is: prefix, parameters joined by separator, suffix. */
export interface CodeSignature {
  prefix: TextPart[]
  separator: TextPart[]
  suffix: TextPart[]
  parameters: CodeSignatureParameter[]
  documentation: TextPart[]
  isVariadic: boolean
}

export interface CodeSignatureHelp {
  applicableSpan: CodeSpan
  argumentIndex: number
  argumentCount: number
  argumentName: string | null
  selectedItem: number
  items: CodeSignature[]
}

export interface CodeSignatureHelpResponse {
  help: CodeSignatureHelp | null
}

/** One compiler message; lines and columns are 0-based. */
export interface CodeDiagnostic {
  id: string
  severity: 'error' | 'warning' | 'info'
  message: string
  helpUri: string
  start: number
  length: number
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

export interface CodeDiagnosticsResponse {
  diagnostics: CodeDiagnostic[]
}

export interface CodeIndentationRequest {
  documentId: string
  /** 0-based. */
  line: number
  indentSize: number
  tabSize: number
  useTabs: boolean
}

export interface CodeIndentationResponse {
  /** The column the line's text should start at; null keeps the editor's own indentation. */
  indentation: number | null
}

export interface CodeSelectionRangesResponse {
  /** For each position asked about, the spans around it, innermost first. */
  ranges: CodeSpan[][]
}
