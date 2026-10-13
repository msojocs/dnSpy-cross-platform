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
}

/** The bytes one resource node holds, and the name a Save dialog should suggest for them. */
export interface ResourceDataResponse {
  name: string
  base64Data: string
}

export type DecompilerLanguage = 'cSharp' | 'visualBasic' | 'il' | 'ilWithCSharp'

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
}

/**
 * Whether a span names somewhere to go. A reference inside the workspace carries the node; a reference
 * into a module the workspace does not hold carries that module's file and token instead, which the
 * backend follows on demand — so it is a target just the same, and the editor draws it as one.
 */
export const isNavigableSpan = (span: TextSpan): boolean => Boolean(span.targetNodeId ?? span.targetModulePath)

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
}

/**
 * One result, written the way dnSpy's search list writes it. `nodeId` is what following it opens — absent for
 * a module reference, which the tree has no row for; `ilOffset` is the instruction a match in a method body
 * was found at, which following it puts the caret on.
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
}

/** The bytes one statement of a code document covers, or null when it has none. The module is named
 * too, since a code document only knows the path it was decompiled from. */
export interface HexStatementResponse {
  moduleId: string | null
  range: HexRange | null
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

export interface EditCommitResponse {
  version: number
  stateId: string
  changedNodeIds: string[]
  canUndo: boolean
  canRedo: boolean
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

export interface DebugProcess {
  processId: number
  name: string
  executablePath?: string
}

export interface DebugStartResponse {
  sessionId: string
  capabilities: Record<string, unknown>
}

export interface DebugThread {
  id: number
  name: string
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
}

export interface DebugScope {
  name: string
  variablesReference: number
  expensive: boolean
}

export interface DebugVariable {
  name: string
  value: string
  type?: string
  variablesReference: number
  evaluateName?: string
}

export interface DebugModule {
  id: number | string
  name: string
  path?: string
  version?: string
  symbolStatus?: string
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
}

export interface ScriptEvaluateResponse {
  entries: ScriptOutputEntry[]
}

export type UiLocale = 'en' | 'zh-CN'

/** What the process was started with: files named on the command line, and whether the session from the
 * last run should be left alone (`--no-load-files`). */
export interface StartupOptions {
  initialPaths: string[]
  noLoadFiles: boolean
}

export interface DnSpyApi {
  openAssemblies(): Promise<string[]>
  getStartupOptions(): Promise<StartupOptions>
  /** Narrows a remembered path list to the files still on disk. Used before restoring a session, where
   * one file that has since been deleted would otherwise fail the whole open. */
  filterExistingPaths(paths: string[]): Promise<string[]>
  openWorkspace(paths: string[]): Promise<OpenWorkspaceResponse>
  /** Adds assemblies to the workspace that is already open, the way dnSpy's Open command grows the tree
   * instead of replacing it. Paths already open come back in `skipped`. */
  addModules(workspaceId: string, paths: string[]): Promise<AddModulesResponse>
  closeWorkspace(workspaceId: string): Promise<void>
  /** Drops every assembly and loads the same files again, discarding edits — dnSpy's Reload All
   * Assemblies. The workspace keeps its id, but every node id the client held is stale. */
  reloadWorkspace(workspaceId: string): Promise<OpenWorkspaceResponse>
  /** Reorders the root nodes by name and answers with the tree in its new order — dnSpy's Sort Assemblies. */
  sortAssemblies(workspaceId: string): Promise<TreeNodesResponse>
  /** Removes one assembly from the tree — dnSpy's Remove Assembly — and answers with what is left. */
  removeModule(workspaceId: string, nodeId: string): Promise<RemoveModuleResponse>
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
   * Writes one resource node's bytes to a file the user picks, and answers with the path it wrote — or
   * nothing when the dialog was cancelled. `raw` asks for the resource's own bytes rather than the value
   * a .resources entry decodes to; the port holds no separate serialized form, so both write the same
   * bytes today, and the flag is kept because dnSpy's two commands differ.
   */
  saveResource(workspaceId: string, nodeId: string, raw: boolean): Promise<string | undefined>
  getRoots(workspaceId: string): Promise<TreeNodesResponse>
  getChildren(workspaceId: string, nodeId: string): Promise<TreeNodesResponse>
  getNode(workspaceId: string, nodeId: string): Promise<TreeNode>
  /**
   * The chain from a root down to a node, the root first and the node itself last — what the explorer
   * needs for a node it has never listed, since a node id alone does not name its ancestors. Empty for a
   * node that hangs off no root.
   */
  getNodePath(workspaceId: string, nodeId: string): Promise<TreeNodesResponse>
  decompile(workspaceId: string, nodeId: string, language: DecompilerLanguage): Promise<DecompileResponse>
  /** Resolves a target by module path and token, since node ids are session-local. A module the workspace does not hold is opened on demand. */
  findMember(workspaceId: string, modulePath: string, metadataToken: number): Promise<FindMemberResponse>
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
  /** The analyzer rows of tree nodes — what dnSpy's analyzer adds for a member it is asked to analyze. */
  analyzeNodes(workspaceId: string, nodeIds: string[]): Promise<AnalyzeNodesResponse>
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
  /** Where a statement under the caret of a code document lives in the file. */
  resolveHexStatement(workspaceId: string, modulePath: string, metadataToken: number, ilOffset: number, ilEndOffset: number): Promise<HexStatementResponse>
  /** Queues a raw byte patch over the module's file image, undone and redone with the rest of the
   * transaction's edits. */
  patchHex(workspaceId: string, transactionId: string, nodeId: string, offset: number, base64Data: string): Promise<void>
  getModuleInfo(workspaceId: string, moduleId: string): Promise<ModuleInfoResponse>
  beginEdit(workspaceId: string): Promise<BeginEditResponse>
  getMethodBody(workspaceId: string, methodNodeId: string): Promise<MethodBodyResponse>
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
  /** Turns the module into an assembly or back — dnSpy's two Convert commands. `toAssembly` picks the
   * direction; nothing is written until the transaction is committed. */
  convertModule(workspaceId: string, transactionId: string, nodeId: string, toAssembly: boolean): Promise<void>
  commitEdit(workspaceId: string, transactionId: string): Promise<EditCommitResponse>
  rollbackEdit(workspaceId: string, transactionId: string): Promise<void>
  undoEdit(workspaceId: string): Promise<EditCommitResponse>
  redoEdit(workspaceId: string): Promise<EditCommitResponse>
  saveModuleAs(workspaceId: string, moduleId: string, suggestedName: string): Promise<SaveModuleResponse | undefined>
  /** Writes a module back over the file it was loaded from — dnSpy's Save. */
  saveModule(workspaceId: string, moduleId: string): Promise<SaveModuleResponse>
  /** Writes every modified module back over its own file — dnSpy's Save All. */
  saveAllModules(workspaceId: string): Promise<SaveAllResponse>
  saveCode(suggestedName: string, text: string): Promise<string | undefined>
  /**
   * Picks a text file and returns its contents, or undefined when the picker was dismissed. `kind`
   * only titles the dialog — the two importers that use this read the same kind of JSON file.
   */
  readTextFile(kind?: 'bookmarks' | 'breakpoints'): Promise<string | undefined>
  chooseDebugTarget(): Promise<string | undefined>
  chooseDebugDirectory(): Promise<string | undefined>
  /** Picks the host executable for the Debug Program dialog's "Use host executable" field. */
  chooseDebugHost(): Promise<string | undefined>
  /** Whether a path names a file that is really on disk — the Debug Program dialog's live check on the
   * executable field, the port's `File.Exists`. */
  pathExists(path: string): Promise<boolean>
  listDebugProcesses(): Promise<DebugProcess[]>
  launchDebug(options: DebugLaunchOptions): Promise<DebugStartResponse>
  attachDebug(processId: number, workspaceId?: string): Promise<DebugStartResponse>
  setBreakpoints(sessionId: string, breakpoints: DebugBreakpointRequest[]): Promise<DebugBreakpoint[]>
  setFunctionBreakpoints(sessionId: string, breakpoints: DebugFunctionBreakpointRequest[]): Promise<Record<string, unknown>>
  /** Releases a launch the engine held back until the client had armed its breakpoints. */
  configurationDone(sessionId: string): Promise<void>
  debugContinue(sessionId: string, threadId: number): Promise<Record<string, unknown>>
  debugPause(sessionId: string, threadId: number): Promise<Record<string, unknown>>
  debugNext(sessionId: string, threadId: number): Promise<Record<string, unknown>>
  debugStepIn(sessionId: string, threadId: number): Promise<Record<string, unknown>>
  debugStepOut(sessionId: string, threadId: number): Promise<Record<string, unknown>>
  getDebugThreads(sessionId: string): Promise<DebugThread[]>
  getDebugStackTrace(sessionId: string, threadId: number): Promise<DebugStackFrame[]>
  getDebugScopes(sessionId: string, frameId: number): Promise<DebugScope[]>
  getDebugVariables(sessionId: string, variablesReference: number): Promise<DebugVariable[]>
  getDebugModules(sessionId: string): Promise<DebugModule[]>
  /** The exception types the engine can break on, with their default and current settings. */
  getExceptionSettings(): Promise<DebugExceptionSettingsList>
  /** Applies the client's stored diff against the defaults and answers with the resulting list. */
  applyExceptionSettings(diff: DebugExceptionDiff): Promise<DebugExceptionSettingsList>
  /** Drops every change and answers with the default list. */
  resetExceptionSettings(): Promise<DebugExceptionSettingsList>
  evaluateDebugExpression(sessionId: string, frameId: number, expression: string): Promise<DebugVariable>
  disconnectDebug(sessionId: string, terminateDebuggee: boolean): Promise<void>
  /** Runs one submission in the C# Interactive session and returns the lines it produced. */
  evaluateScript(code: string): Promise<ScriptEvaluateResponse>
  /** Drops the C# Interactive session and builds a fresh one, reporting the engine banner. */
  resetScript(): Promise<ScriptEvaluateResponse>
  minimizeWindow(): Promise<void>
  toggleMaximizeWindow(): Promise<boolean>
  closeWindow(): Promise<void>
  isWindowMaximized(): Promise<boolean>
  setFullScreen(fullScreen: boolean): Promise<boolean>
  toggleFullScreen(): Promise<boolean>
  isFullScreen(): Promise<boolean>
  quit(): Promise<void>
  /** dnSpy's Constants.IsRunningAsAdministrator: on Linux, uid 0. Hides "Restart as Administrator". */
  isRunningAsAdministrator(): Promise<boolean>
  /** Closes the app and starts an elevated copy in its place, the way dnSpy's runas restart does. */
  restartAsAdministrator(): Promise<void>
  getBackendStatus(): Promise<BackendStatus>
  getProcessId(): Promise<number>
  setLocale(locale: UiLocale): Promise<void>
  onWindowMaximizedChange(callback: (isMaximized: boolean) => void): () => void
  onFullScreenChange(callback: (isFullScreen: boolean) => void): () => void
  onBackendStatus(callback: (status: BackendStatus) => void): () => void
  onDebugEvent(callback: (event: DebugEvent) => void): () => void
  /** What an analyzer search found so far, sent while it still runs. */
  onAnalyzeProgress(callback: (progress: AnalyzeProgress) => void): () => void
  /** What a search window search found so far, sent while it still runs. */
  onSearchProgress(callback: (progress: SearchProgress) => void): () => void
}
