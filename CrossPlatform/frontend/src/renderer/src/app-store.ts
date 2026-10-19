import { Actions, TabNode, TabSetNode, type Model } from 'flexlayout-react'
import { create } from 'zustand'
import type {
  BackendStatus,
  BookmarkFileEntry,
  BreakpointConditionKind,
  BreakpointHitCountKind,
  BreakpointSettings,
  CodeStatement,
  DecompilerLanguage,
  DecompileResponse,
  DebugBreakpoint,
  DebugEvent,
  DebugExceptionCategory,
  DebugExceptionCondition,
  DebugExceptionDiff,
  DebugExceptionDiffEntry,
  DebugExceptionSettings,
  DebugLaunchOptions,
  DebugModule,
  DebugProcessInfo,
  DebugStackFrame,
  DebugStackFrameFormat,
  DebugThread,
  DebugVariable,
  DropFilter,
  EditCommitResponse,
  HexRange,
  HexTargetResponse,
  NodeOptionsDto,
  OpenedModule,
  ClassifiedSpan,
  ScriptOutputEntry,
  ScriptOutputNotification,
  SpecialNodeKind,
  TextSpan,
  AssemblyOptions, CompilerDiagnostic, CompilerLanguage, CompilerMode, CompilerSettings, ModuleOptions, SaveModuleOptions, TreeNode, CreateResourceEntry, CreateResourceOptions, CreateResourceElementOptions, ResourceElementOptions, ResourceOptions,
  DocumentSaveOptions, ModifiedDocument, SaveDocumentsResponse} from '../../shared/protocol'
import { lineColumnOfOffset, offsetOfLineColumn } from './analyzer-model'
import { getActiveLocale, translate as t } from './localization'
import { formatDateTime } from './dotnet-date-format'
import { askIgnorableMessage } from './message-box'
import { loadAppOptions } from './components/app-options'
import { spansOfTrimmed } from './roslyn-classification'

export type { BreakpointConditionKind, BreakpointHitCountKind, BreakpointSettings }

export interface DocumentState extends DecompileResponse {
  nodeId: string
  loading: boolean
  requestedLanguage: DecompilerLanguage
  cursorLine?: number
  cursorColumn?: number
  scrollTop?: number
}

export interface FunctionBreakpoint {
  name: string
  enabled: boolean
  settings?: BreakpointSettings
  hitCount?: number
}

/**
 * A line breakpoint as the client tracks it. `identity` is the IL identity the click resolved to —
 * available before the first backend round trip because the decompiled document already carries the
 * IL range of every statement — and is what makes a second click on the snapped line a toggle
 * rather than a second breakpoint.
 */
export interface LineBreakpoint {
  id: string
  nodeId: string
  identity: string
  requestedLine: number
  line: number
  endLine: number
  state: 'bound' | 'pending' | 'unbound'
  message?: string
  enabled: boolean
  description?: string
  modulePath?: string
  metadataToken?: number
  /** The method a user navigates to — `metadataToken` except inside a state machine. */
  sourceMethodToken?: number
  ilOffset?: number
  /** The condition, hit count, filter, trace and labels attached to it, absent when it has none. */
  settings?: BreakpointSettings
  /** How many hits the engine has counted, which only a live session knows and nothing stores. */
  hitCount?: number
}

/**
 * A line breakpoint as it is written to disk, the port's answer to WPF dnSpy's
 * `DbgDotNetCodeLocation`: module, token and IL offset, which is everything the engine needs and
 * nothing the session owns. The node id is deliberately absent — it is issued by a per-workspace
 * counter — so a restored breakpoint is resolved back from its IL identity instead.
 */
export interface LineBreakpointEntry {
  modulePath: string
  metadataToken: number
  sourceMethodToken: number
  ilOffset: number
  /** Last known decompiled line, so the pane reads right before the document has been opened again. */
  line: number
  enabled: boolean
  /** The method's signature, which is what the pane labels the row with. */
  description?: string
  /** Omitted when the breakpoint has no settings, so an ordinary row stays the size it was. */
  settings?: BreakpointSettings
}

/** Everything the breakpoint settings hold, which is also the shape the export file is written in. */
export interface StoredBreakpoints {
  breakpoints: LineBreakpointEntry[]
  functions: FunctionBreakpoint[]
}

/**
 * Where the debugger is stopped, in decompiled-source terms. The node is the document the location has to be shown
 * in — a frame in a module the workspace does not hold has no node, and then there is nothing to navigate to.
 */
export interface StoppedLocation {
  nodeId?: string
  line: number
  column?: number
  name: string
  /** Identifies one reveal request: the view positions the caret once per token, not once per render. */
  token: number
  /** Whether the caret — not only the marker — follows the request into the editor. */
  caret?: boolean
}

/**
 * Which of dnSpy's two .NET locations a bookmark is: a spot inside a method body, named by module, token
 * and IL offset (`DotNetMethodBodyBookmarkLocation`), or a definition, named by module and token alone
 * (`DotNetTokenBookmarkLocation`) — what a declaration line gets. `line` is this port's own: a line of a
 * document that carries neither a statement map nor definitions (Visual Basic), which only this session
 * can find again.
 */
export type BookmarkKind = 'body' | 'token' | 'line'

/**
 * A bookmark as the client tracks it, modelled on dnSpy's .NET bookmark locations: named by module and
 * token (and IL offset) so it can be found again after a restart. `nodeId` is only valid for the workspace
 * that handed it out, so it is a cache — `identity` is the truth.
 */
export interface Bookmark {
  id: string
  kind: BookmarkKind
  nodeId: string
  /** `modulePath|token|ilOffset` (`modulePath|token|definition` for a definition), the stable key a restored
   * bookmark is matched back on. */
  identity: string
  modulePath: string
  metadataToken: number
  /** The IL offset inside the method body; 0 for a definition or a line. */
  ilOffset: number
  /** Line the marker is drawn on, refreshed from the IL map every time the document is decompiled. */
  line: number
  /** Signatures of the method the location belongs to, so a row still reads right while it is closed. */
  description: string
  name: string
  labels: string[]
  enabled: boolean
  /** Insertion order, the tool window's default sort until a column is picked. */
  order: number
}

/**
 * Asks the editor showing `documentId` to move its caret — to a bookmark's line, or to the reference an
 * analyzer row was found at. `viewId` names one tab when the document is open in more than one; without it
 * every view of the document moves. The token changes on every request, so asking twice for the same place
 * still moves the caret back.
 */
export interface CaretReveal {
  documentId: string
  viewId?: string
  line: number
  column: number
  token: number
  /** Where the view is scrolled to, which going back in a tab's history restores along with the caret. */
  scrollTop?: number
  /**
   * The member whose definition the caret goes to — dnSpy's MoveCaretToReference after a followed reference:
   * the view finds it among the spans of the document it shows, and `line`/`column` is where the caret goes
   * when the document has no definition of it.
   */
  definitionNodeId?: string
  /** Whether the view scrolls the place to its middle, which dnSpy does when the document is new to the tab. */
  center?: boolean
}

/** Where the caret is, for "next bookmark" to mean "the next one after where I am". */
export interface CaretPosition {
  documentId: string
  line: number
  column?: number
}

/**
 * A bookmark as it is written to disk. Everything session-local is left out — there is no node id to
 * save, and the line is recomputed from the IL map when the document is opened again.
 */
export interface BookmarkEntry {
  /** A definition; a row without one is a spot in a method body, the only kind the first version stored. */
  kind?: 'token'
  modulePath: string
  metadataToken: number
  /** Where in the method body; a definition has none. */
  ilOffset?: number
  description: string
  name: string
  labels: string[]
  enabled: boolean
}

/** The save windows a `requestSave` put up: `options` is the Save Module window of a single document, `run` the
 *  window that writes — one document (`single`) or the Save Modules list (`multiple`). */
export interface SaveRequest {
  id: number
  documents: DocumentSaveOptions[]
  mode: 'single' | 'multiple'
  phase: 'options' | 'run'
}

/** How `openPaths` treats the files it opens. */
export interface OpenPathsOptions {
  /** Put each file on the Recent Files list. */
  remember?: boolean
  /** Select the root of the last file, as dnSpy's OpenDocumentsHelper does. On by default. */
  select?: boolean
}

interface AppState {
  backendStatus: BackendStatus
  workspaceId?: string
  /** Closing invalidates work that started before the user's Close All command, including startup. */
  workspaceGeneration: number
  modules: OpenedModule[]
  roots: TreeNode[]
  children: Record<string, TreeNode[]>
  parents: Record<string, string>
  expanded: Record<string, boolean>
  loadingNodes: Record<string, boolean>
  selectedNode?: TreeNode
  /** Multiple selected nodes for batch operations. The first one is the primary selection (selectedNode). */
  selectedNodes: TreeNode[]
  /** Where a Shift range starts — the ListBox anchor dnSpy's tree keeps: the row last selected on its own, or
   *  toggled with Ctrl. A range leaves it where it is, so it can be grown and shrunk from the same row. */
  selectionAnchorId?: string
  documents: Record<string, DocumentState>
  /** The document tabs in the order the layout shows them, and the one that is selected. The shell owns
   * the layout and reports both here, because a restored session has to put the tabs back as they were. */
  documentOrder: string[]
  activeDocumentId?: string
  /** True while the previous session is being put back. The churn that causes — a workspace arriving,
   * tabs being rebuilt — is not the user's state and must not be written over the archive. */
  restoringSession: boolean
  /**
   * The language a document is decompiled in when nothing else says, which is dnSpy's
   * IDecompilerService.Decompiler. `-l` on the command line is the one thing that sets it.
   */
  defaultLanguage: DecompilerLanguage
  /**
   * Counts the times the user changed which assemblies the workspace holds — added some, loaded a module's
   * dependencies, removed one. dnSpy's analyzer starts its searches over then; an assembly opened on demand
   * to follow a reference is not counted, since dnSpy leaves the analyzer alone for those.
   */
  assemblyListRevision: number
  /** The Output window's own pane: what the port reports of its work (opening, saving, editing, failures). */
  output: OutputLine[]
  /** The Output window's Debug pane, dnSpy's OutputLogger: what the debugger and the debuggee write. */
  debugOutput: OutputLine[]
  /** The pane "Show output from" has selected. */
  outputPane: OutputPaneId
  busy: boolean
  /** Whether any document has unsaved changes — `modifiedDocuments` is not empty. */
  dirty: boolean
  /** dnSpy's modified documents: undoing back to where one was saved takes it off, the way its undo service does. */
  modifiedDocuments: ModifiedDocument[]
  /** The save windows on screen: the Save Module window for one document, then the window that writes it, or the
   *  Save Modules window for several. `requestSave` puts one up and answers once it is gone. */
  saveRequest?: SaveRequest
  workspaceStateId?: string
  savedStateId?: string
  canUndo: boolean
  canRedo: boolean
  /** dnSpy's Recent Files: the files the user opened, most recent first. */
  recentFiles: string[]
  debugSessionId?: string
  debugState: 'inactive' | 'starting' | 'running' | 'stopped'
  debugThreads: DebugThread[]
  debugFrames: DebugStackFrame[]
  debugVariables: DebugVariable[]
  debugModules: DebugModule[]
  selectedDebugThreadId?: number
  /** The row the user highlighted, which is only a highlight until they switch to it. */
  selectedDebugFrameId?: number
  /** The frame the debugger is working in: what Locals, Watch and the ">" marker read. */
  activeDebugFrameId?: number
  stoppedReason?: string
  /** The statement the active frame is stopped at, once it has been resolved to a document line. */
  stoppedLocation?: StoppedLocation
  watches: string[]
  watchValues: DebugVariable[]
  /** The expressions of Watch 2, 3 and 4 — dnSpy has four Watch windows, each a list of its own. */
  otherWatches: Record<number, string[]>
  otherWatchValues: Record<number, DebugVariable[]>
  /** Bumped on every stop, frame switch and edit: the windows that read the stopped process read it again. */
  debugGeneration: number
  /** The session's process, for the Processes window. */
  debugProcess?: DebugProcessInfo
  /** Where the caret of a code editor is, which Set Next Statement and Run to Cursor act on. */
  codeCaret?: CaretPosition
  /** The Module Breakpoints window's rows. */
  moduleBreakpoints: ModuleBreakpoint[]
  functionBreakpoints: FunctionBreakpoint[]
  lineBreakpoints: LineBreakpoint[]
  bookmarks: Bookmark[]
  /** The bookmark navigation steps from; set by the last go-to, so next/previous continue from there. */
  activeBookmarkId?: string
  caretReveal?: CaretReveal
  /** Moves the caret of the editor showing `documentId` — of the tab `viewId`, when one is named. */
  revealCaret(documentId: string, line: number, column: number, viewId?: string): void
  /** Asks the view of a document for a caret request carrying more than a place — a scroll, a definition. */
  requestCaret(request: Omit<CaretReveal, 'token'>): void
  /**
   * The exception list as the engine has it, refreshed whenever it changes. The engine owns the
   * list — the client stores only `exceptionDiff`, and replays it to get here.
   */
  exceptionCategories: DebugExceptionCategory[]
  exceptionSettings: DebugExceptionSettings[]
  /** What the client has changed against the engine's defaults, which is what it persists. */
  exceptionDiff: DebugExceptionDiff
  /** Set once the engine has answered the first request, so the pane can tell empty from unloaded. */
  exceptionSettingsLoaded: boolean
  /** Why the list could not be read — an engine that will not load has no exception types to offer. */
  exceptionSettingsError?: string
  /** What the engine says it can do; drives which debug UI stays enabled. */
  debugCapabilities: Record<string, unknown>
  /** Lines of the C# Interactive window, oldest first. */
  scriptEntries: ScriptOutputEntry[]
  /** Set while a submission is running, which is what locks the input box. */
  scriptRunning: boolean
  /** Submissions already run, oldest first, for Alt+Up / Alt+Down. */
  scriptHistory: string[]
  /** Set once the session has been built, so reopening the window does not rebuild it. */
  scriptStarted: boolean
  /** The generation of the session; a line streamed by an older one belongs to a reset engine and is dropped. */
  scriptGeneration: number
  /**
   * Where the hex commands point for the selected node: a method's body and code, a field's initial
   * value, a resource's data. Resolved when the selection changes, since the Edit menu has to know
   * what it can offer before it is opened.
   */
  hexTarget?: HexTargetResponse
  /** The statement under the caret of the focused code document, resolved to its bytes in the file. */
  hexStatement?: { moduleId: string; range: HexRange }
  /** A hex command asking a hex tab to show a range. The tab watches it, jumps to the page holding
   * the range and highlights it; `nonce` makes asking for the same range twice work. */
  hexNavigation?: { moduleId: string; offset: number; length: number; nonce: number }
  error?: string
  setBackendStatus(status: BackendStatus): void
  chooseAndOpen(): Promise<void>
  /**
   * Opens files into the tree — dnSpy's DsDocumentLoader. `remember` puts each on the Recent Files list, the way
   * the Open dialog, Open from GAC, a drop and the command line do and a restored session or Open List does not;
   * `select` selects the root of the last file, which is what dnSpy's OpenDocumentsHelper selects.
   */
  openPaths(paths: string[], options?: OpenPathsOptions): Promise<void>
  /** dnSpy's Recent Files entry: opens that one file into the tree as it stands, and selects it. */
  openRecentFile(path: string): Promise<void>
  closeWorkspace(): Promise<void>
  toggleNode(node: TreeNode): Promise<void>
  /** Expands a node unconditionally, unlike `toggleNode` which collapses an expanded one. A restore has to
   * expand nodes that the tree may have expanded on its own, and a toggle there would close them instead. */
  expandNode(node: TreeNode): Promise<void>
  /** Materialises a node's children without expanding it, which is how a restore rebuilds the collapsed
   * branches that hold a restored tab or selection. Does nothing when they are already loaded. */
  loadChildren(node: TreeNode): Promise<void>
  /**
   * Selects a row — on its own, or with Ctrl (`toggle`) in or out of the selection, or with Shift (`range`) every
   * row from the anchor to it. `rows` are the rows the tree shows, top to bottom, which is what a range spans;
   * without them it spans the rows the store has loaded and expanded.
   */
  selectNode(node: TreeNode, options?: { toggle?: boolean; range?: boolean; rows?: readonly TreeNode[] }): void
  /** Selects the rows given, `primary` the one the commands act on — dnSpy's Select All (Ctrl+A) in the tree. */
  selectNodes(nodes: readonly TreeNode[], primary?: TreeNode): void
  /** Collapse every expanded node except the selected node and its ancestors. */
  collapseTreeViewNodes(): void
  /** Decompiles a node into its document — and makes it the tree's selection unless `select` is false. */
  openDocument(node: TreeNode, language?: DecompilerLanguage, select?: boolean): Promise<string>
  /**
   * dnSpy's language box: the decompiler every document is shown in. The open tabs are decompiled again in it
   * (RedecompileTabs), the documents opened from now on use it, and it is remembered for the next start. The
   * shell, which owns the layout, names the documents its tabs show; the recorded tab order stands in otherwise.
   */
  changeLanguage(language: DecompilerLanguage, openDocumentIds?: string[]): Promise<void>
  changeDocumentLanguage(nodeId: string, language: DecompilerLanguage): Promise<void>
  /** Updates the editor state (cursor position and scroll) for a document, which session restore reads back. */
  updateDocumentEditorState(nodeId: string, cursorLine?: number, cursorColumn?: number, scrollTop?: number): void
  renameNode(node: TreeNode, newName: string): Promise<boolean>
  /** Adds the type or member a create dialog assembled to the node that owns it, and selects the new
   * node. Says whether it was created; a refused one has already been reported. */
  createNode(ownerNodeId: string, options: NodeOptionsDto, nested?: boolean): Promise<boolean>
  /** Writes an edit dialog's model over the node it was opened for. */
  applyNodeOptions(nodeId: string, options: NodeOptionsDto): Promise<boolean>
  /** Opens the tree down to a node and selects it, which is what makes a new node visible. */
  revealNode(nodeId: string): Promise<void>
  /** Removes the node from its owner — a type, member, resource, or every type of a namespace. */
  deleteNode(node: TreeNode): Promise<boolean>
  /** dnSpy's Copy IL Bytes: the instructions' bytes as hex on the clipboard, and why some of them are "??". */
  copyIlBytes(instructions: { modulePath: string; metadataToken: number; ilOffset: number }[]): Promise<void>
  /** Deletes the rows as one undo step — dnSpy's delete commands over a selection of one kind. */
  deleteNodes(nodes: TreeNode[]): Promise<boolean>
  /** Renames a namespace; an empty name moves its types to the empty namespace. */
  renameNamespace(node: TreeNode, newName: string): Promise<boolean>
  moveTypesToEmptyNamespace(node: TreeNode): Promise<boolean>
  /** Replaces a method body with the stub the backend derives from the method's signature. */
  replaceMethodBodyWithStub(node: TreeNode): Promise<boolean>
  /** Resolves where the hex commands point for a node, which is what decides the Edit menu's hex
   * entries. Passing nothing clears it. */
  resolveHexTarget(node?: TreeNode): Promise<void>
  /** Records the statement under a code document's caret, which is what "Show Instructions in Hex
   * Editor" acts on. Passing nothing clears it. */
  setCodeCaret(position?: CaretPosition): Promise<void>
  /** Asks the hex tab showing `moduleId` to jump to a range. */
  showHexAt(moduleId: string, offset: number, length: number): void
  /** Writes one of dnSpy's canned method bodies over the selected method's body bytes. */
  hexWriteMethodBody(kind: HexBodyKind): Promise<boolean>
  /** Puts the selected method's body bytes on the clipboard as hexadecimal text. */
  hexCopyMethodBody(): Promise<boolean>
  /** Writes the clipboard's hexadecimal text over the selected method's body. */
  hexPasteMethodBody(): Promise<boolean>
  /** Writes bytes straight into the file image of a hex tab — what typing, pasting, deleting and filling in
   * the hex editor do. The patch undoes and redoes like any other edit; a file that is not a managed module
   * refuses it. */
  hexWriteBytes(moduleId: string, offset: number, data: Uint8Array, message?: string): Promise<boolean>
  replaceResource(node: TreeNode): Promise<boolean>
  /** Compiles C# source and, when it is free of errors, imports it into the module as one undoable edit.
   *  Answers the diagnostics either way, so the editor can show why it failed. */
  compileCode(node: TreeNode, mode: CompilerMode, source: string, language?: CompilerLanguage): Promise<{ ok: boolean, diagnostics: CompilerDiagnostic[] }>
  /** Merges an assembly the user picks into the module, as one undoable edit. */
  mergeAssembly(node: TreeNode): Promise<boolean>
  /** Writes the Edit Assembly model over the assembly the node belongs to. */
  applyAssemblyOptions(node: TreeNode, options: AssemblyOptions): Promise<boolean>
  /** A workspace to make a document in: the open one, or a new empty one when nothing is open — dnSpy's Create
   *  Assembly works with no document loaded. */
  ensureWorkspace(): Promise<string | undefined>
  /** dnSpy's Create Assembly: an assembly with no file, at the end of the tree, selected. */
  createAssembly(options: AssemblyOptions, clrVersion: string): Promise<boolean>
  /** dnSpy's Create NetModule: a net module of its own with no file. */
  createNetModule(name: string, mvid: string, clrVersion: string): Promise<boolean>
  /** dnSpy's Add New / Add Existing NetModule to Assembly, for the assembly a node is in. */
  addNetModule(node: TreeNode, module: { name: string; mvid: string; clrVersion: string } | { path: string }): Promise<boolean>
  /** dnSpy's Remove NetModule from Assembly. */
  removeNetModule(node: TreeNode): Promise<boolean>
  /** Writes the Edit Module model over the module the node stands for. */
  applyModuleOptions(node: TreeNode, options: ModuleOptions): Promise<boolean>
  /** Writes the Edit Resource model over the resource the node stands for. */
  applyResourceOptions(node: TreeNode, options: ResourceOptions): Promise<boolean>
  /** Creates a resource through one of dnSpy's Create ... Resource commands. */
  createResource(owner: TreeNode, options: CreateResourceOptions): Promise<boolean>
  /** Writes the element editor's model over a .resources entry. */
  applyResourceElementOptions(node: TreeNode, options: ResourceElementOptions): Promise<boolean>
  /** Adds an entry to a .resources file. */
  createResourceElement(resourceNode: TreeNode, options: CreateResourceElementOptions): Promise<boolean>
  /** dnSpy's Create System.Data.Bitmap/Icon Resource: the image files picked, each an entry named after it, in one step. */
  createImageResources(resourceNode: TreeNode): Promise<boolean>
  /** The same as `saveModule`: dnSpy's Save Module window is where the file is picked. */
  saveModuleAs(): Promise<boolean>
  /** dnSpy's Save Module...: the selection's documents — its modified ones when it has any — through the save windows. */
  saveModule(): Promise<boolean>
  /** dnSpy's Save All...: every modified document through the save windows. */
  saveAllModules(): Promise<boolean>
  /**
   * Writes the modules at `paths` back over their own files — dnSpy's DocumentSaver.Save for the documents a
   * command is about to let go of. The workspace stays modified while any other module still is. Answers whether
   * every one of them was written.
   */
  saveModules(paths: string[]): Promise<boolean>
  /**
   * dnSpy's DocumentSaver.Save over the documents the ids name — any node inside a document names it: one
   * document gets its Save Module window and then the window that writes it, several get the Save Modules window.
   * Answers whether every one of them was written.
   */
  requestSave(ids: string[]): Promise<boolean>
  /** The Save Module window's OK: its options are what the document is written with. */
  acceptSaveOptions(options: DocumentSaveOptions): void
  /** A save window went away — after a run, or before one started (`response` undefined). */
  finishSave(response: SaveDocumentsResponse | undefined): Promise<void>
  /** Reads the modified documents again — after something only the backend saw changed them. */
  refreshModifiedDocuments(): Promise<void>
  /**
   * Drops every assembly and reopens the files the user opened, discarding edits — dnSpy's Reload All
   * Assemblies. Of the files the workspace opened by itself only `autoLoadedPaths` come back: the ones a tab
   * still shows something of. Putting the tabs back is the shell's, which owns them.
   */
  reloadAllAssemblies(autoLoadedPaths?: string[]): Promise<boolean>
  /** Reorders the tree's root nodes by name — dnSpy's Sort Assemblies. */
  sortAssemblies(): Promise<boolean>
  /**
   * Removes one assembly from the tree — dnSpy's Remove Assembly — and answers with the document ids it
   * took with it, so the shell can close the tabs still showing them. Everything the client held by node
   * id for that assembly is dropped here; nothing else can name those ids again.
   */
  removeModule(node: TreeNode): Promise<string[]>
  /**
   * Removes several assemblies from the tree at once — dnSpy's Remove Assembly over a multiple selection,
   * and its Close All Framework Assemblies / Close All Missing Files sweeps. Returns the node ids that
   * were removed.
   */
  removeModules(nodeIds: string[]): Promise<string[]>
  /**
   * The files of the modules that hold edits not yet saved, among the ones the nodes belong to — what
   * dnSpy asks about before it lets an assembly go.
   */
  getModifiedModules(nodeIds?: string[]): Promise<string[]>
  /**
   * The roots dnSpy's two Close All sweeps would remove: the framework assemblies and the documents that
   * are not PE images (a missing file is one of those).
   */
  getCloseCandidates(): Promise<{ frameworkNodeIds: string[]; missingNodeIds: string[] }>
  /**
   * Moves roots to another place in the tree — what dragging them does: in front of the root at `index`,
   * or at the end. Returns the new root list.
   */
  moveRoots(nodeIds: string[], index: number): Promise<TreeNode[]>
  /**
   * dnSpy's DocumentTabService.NodeActivated: a row that names something elsewhere — an assembly reference,
   * a base, derived or referenced type, a member reference — selects what it names, opening the assembly
   * it lives in when it has to. Answers whether the row went somewhere, so the caller knows not to open it.
   */
  activateNode(node: TreeNode): Promise<boolean>
  /**
   * Opens the files dropped on the tree in front of the root at `index` — dnSpy's OnDropFiles. A dropped
   * directory stands for every file under it, and with several new files the Assembly Explorer's
   * dragged-items filter picks which go in. The first new root, or a dropped file already open, is selected.
   */
  dropFiles(paths: string[], index: number, filter: DropFilter): Promise<void>
  /**
   * Brings the module's entry point, or the static constructor of its global type, into view — dnSpy's
   * two "Go to ..." commands. Answers false when the module has no such member.
   */
  goToSpecialNode(node: TreeNode, kind: SpecialNodeKind): Promise<boolean>
  /** Brings the node a metadata token names into view — dnSpy's "Go to Token". Answers false when the
   *  token names no row the tree shows. */
  goToToken(node: TreeNode, token: string): Promise<boolean>
  /** dnSpy's Go to MD Table Row: the row of the metadata table a token names, in the PE tree of the module a node
   *  is in. Answers why there is none — dnSpy's message — or nothing once the row is shown. */
  goToMetadataRecord(node: TreeNode, token: number): Promise<string | undefined>
  /**
   * Writes one resource node's bytes to a file the user picks — dnSpy's Save Resource. `raw` picks the
   * command that was run; both write the bytes the workspace holds. Answers false when the dialog was
   * cancelled or the write failed.
   */
  saveResource(nodes: TreeNode[], raw: boolean, useSubDirs?: boolean): Promise<boolean>
  /** The files the resource nodes would save as, both ways — what the Save commands' headers are made of.
   *  Nothing to save when the backend cannot say. */
  getResourceItemNames(nodeIds: string[]): Promise<{ names: string[]; rawNames: string[] }>
  /**
   * The resource node that holds the data a Resources property or method reads — dnSpy's Go to Resource.
   * Returns null when the type is not a Resources class, the method body does not name a resource, or the
   * .resources file is not in the tree.
   */
  findResource(nodeId: string): Promise<string | null>
  /**
   * dnSpy's Go to Resource: selects the .resources entry a strongly typed Resources property or method
   * reads, and opens it the way FollowReference does. Answers false when the member reads none.
   */
  goToResource(node: TreeNode): Promise<boolean>
  /**
   * Opens every assembly the module's references name — dnSpy's Load Dependencies. `recursive` follows the
   * closure instead of stopping at the module's own references. Nothing is edited, so the dirty flag and
   * the undo stack are left alone and the tree simply grows by the assemblies that were not open before.
   * Answers false when nothing new could be resolved, or when the lookup failed.
   */
  loadDependencies(node: TreeNode, recursive: boolean): Promise<boolean>
  /**
   * Turns an assembly into a net module — dnSpy's Convert Assembly to NetModule. The assembly definition is
   * detached and the module row's own label is all that is left above it. A queued edit, so Undo is the way
   * back and nothing is written until the module is saved.
   */
  convertModule(node: TreeNode, toAssembly?: boolean): Promise<boolean>
  /**
   * Reads the tree's roots again. Following a reference into a module the workspace did not hold opens
   * that module, so the backend's root list grows without the client having asked it to.
   */
  refreshRoots(): Promise<void>
  saveCode(documentId: string): Promise<boolean>
  methodBodyChanged(node: TreeNode, result: EditCommitResponse): Promise<void>
  /** Undoes the last edit. Answers the node ids the step took out of the tree — a removal redone takes a whole
   *  document — so the shell can close the tabs that showed them. */
  undoEdit(): Promise<string[]>
  redoEdit(): Promise<string[]>
  launchDebug(options: DebugLaunchOptions): Promise<void>
  /** Executable the "Debug Program" dialog should prefill: the selected module, else the first one opened. */
  defaultDebugTarget(): string | undefined
  attachDebug(processId: number): Promise<void>
  handleDebugEvent(event: DebugEvent): Promise<void>
  continueDebug(): Promise<void>
  pauseDebug(): Promise<void>
  stepDebug(kind: 'next' | 'stepIn' | 'stepOut'): Promise<void>
  stopDebug(): Promise<void>
  selectDebugFrame(frameId: number): Promise<void>
  /**
   * Makes a frame the one the debugger is working in — dnSpy's SwitchToFrame: the frame the Locals and
   * Watch windows read, the one the ">" marker sits on, and the one whose document is brought forward.
   */
  switchToDebugFrame(frameId: number): Promise<void>
  selectDebugThread(threadId: number): Promise<void>
  /**
   * Marks the line the active frame stopped on and brings its document to the front. `caret` is for the
   * navigations the user asked for — a frame switch, Show Next Statement — where the caret follows;
   * a step only scrolls, so it does not take the focus away from what the user was doing.
   */
  revealStoppedLocation(options?: { caret?: boolean }): Promise<void>
  /** Adds an expression to a Watch window: Watch 1 unless another is named. */
  addWatch(expression: string, window?: number): Promise<void>
  removeWatch(expression: string, window?: number): void
  /** Replaces a watch's expression in place — the Watch window's edit of its Name column. */
  editWatch(expression: string, replacement: string, window?: number): Promise<void>
  /** Every watch gone — the Watch window's Clear All. */
  clearWatches(window?: number): void
  /** Hands the engine the debugger options — what it does on a stop and how it writes values — and, when
   *  stopped, reads the windows again in the new format. */
  applyDebuggerOptions(): Promise<void>
  /** Writes a value through an expression in the debugger's language; answers the error, if any. */
  setDebugValue(expression: string, value: string): Promise<string | undefined>
  /** dnSpy's Make Object ID: the value gets a `$N` name that outlives the stop. */
  makeDebugObjectId(expression: string): Promise<void>
  deleteDebugObjectId(id: string): Promise<void>
  /** dnSpy's Set Next Statement: the stopped thread continues from the statement under the caret. */
  setNextStatement(): Promise<void>
  /** dnSpy's Run to Cursor: from the editor, a one-shot breakpoint at the caret; from the Call Stack, the frame's return. */
  runToCursor(frameId?: number): Promise<void>
  freezeDebugThreads(threadIds: number[], freeze: boolean): Promise<void>
  renameDebugThread(threadId: number, name: string | null): Promise<void>
  addModuleBreakpoint(breakpoint?: Partial<ModuleBreakpoint>): Promise<void>
  updateModuleBreakpoint(id: string, change: Partial<ModuleBreakpoint>): Promise<void>
  removeModuleBreakpoints(ids: string[]): Promise<void>
  /** dnSpy's Restart: the launched program is stopped and started again the way it was the last time. */
  restartDebug(): Promise<void>
  /** Detaches from the debuggee without killing it — dnSpy's Detach All. */
  detachDebug(): Promise<void>
  /** Kills the debuggee — dnSpy's Terminate All, the Stop Debugging of a launched process. */
  terminateDebug(): Promise<void>
  addFunctionBreakpoint(name: string): Promise<void>
  removeFunctionBreakpoint(name: string): Promise<void>
  toggleFunctionBreakpoint(name: string): Promise<void>
  /**
   * Adds a function breakpoint for every method of a type — dnSpy's "Add Class Breakpoint", which puts
   * one breakpoint at the entry of each method of the type the row names. With settings it is "Add Class
   * Tracepoint": every breakpoint it adds carries them.
   */
  addClassBreakpoint(node: TreeNode, settings?: BreakpointSettings): Promise<void>
  /**
   * dnSpy's "Add Method Breakpoint": a breakpoint at the entry of each method named — a property's or an
   * event's accessors for one of those. It only adds; a method that already has one keeps it.
   */
  addMethodBreakpoints(targets: MethodBreakpointTarget[]): Promise<void>
  setFunctionBreakpointEnabled(name: string, enabled: boolean): Promise<void>
  /** Attaches a condition, hit count, filter, trace and labels; `undefined` clears them all. */
  setFunctionBreakpointSettings(name: string, settings: BreakpointSettings | undefined): Promise<void>
  deleteAllFunctionBreakpoints(): Promise<void>
  setAllFunctionBreakpointsEnabled(enabled: boolean): Promise<void>
  toggleLineBreakpoint(nodeId: string, line: number, column?: number): Promise<void>
  removeLineBreakpoint(id: string): Promise<void>
  setLineBreakpointEnabled(id: string, enabled: boolean): Promise<void>
  /** Attaches a condition, hit count, filter, trace and labels; `undefined` clears them all. */
  setLineBreakpointSettings(id: string, settings: BreakpointSettings | undefined): Promise<void>
  deleteAllBreakpoints(): Promise<void>
  /** Merges an imported breakpoint file into the current set, answering how many rows it added. */
  importBreakpoints(stored: Partial<StoredBreakpoints>): Promise<number>
  setAllLineBreakpointsEnabled(enabled: boolean): Promise<void>
  /**
   * Opens the document a node id names, in a tab. Set by the shell, which owns the tab layout; the
   * store itself can only fill in document content.
   */
  openNodeById?: (nodeId: string) => Promise<string | undefined>
  setOpenNodeById(open: ((nodeId: string) => Promise<string | undefined>) | undefined): void
  /**
   * Opens the document a node id names in a tab of its own, even when a tab already shows it — what
   * dnSpy's "Open in New Tab" asks for. Set by the shell, which owns the tab layout, like
   * `openNodeById`.
   */
  openNodeInNewTabById?: (nodeId: string) => Promise<string | undefined>
  setOpenNodeInNewTabById(open: ((nodeId: string) => Promise<string | undefined>) | undefined): void
  /**
   * Brings a node's document to the front without decompiling it again — the shell selects the tab it
   * already has, and only a node with no tab is opened the slow way. Set by the shell, like the two
   * callbacks around it, because the tab layout is its to read.
   */
  revealDocument?: (nodeId: string) => Promise<void>
  setRevealDocument(open: ((nodeId: string) => Promise<void>) | undefined): void
  /**
   * Follows a reference the user clicked in decompiled text — dnSpy's Go To Reference. A reference
   * inside the workspace names its target's node; one into a module the workspace does not hold names
   * the file and token it has there, and the backend opens that module on demand to answer for it.
   * `newTab` is dnSpy's Follow Reference in New Tab: the target gets a tab of its own instead of the
   * tab a plain follow would reuse.
   */
  openReferenceTarget(target: TextSpan, newTab?: boolean): Promise<void>
  /**
   * The node a reference names, as `openReferenceTarget` finds it: a reference into a module the
   * workspace does not hold opens that module first. Undefined when the reference names nothing; a
   * module that does not answer for the token throws, with the module's path as the message.
   */
  resolveReferenceTarget(target: TextSpan): Promise<string | undefined>
  /** Records the tab order and the selected tab, which the shell reads off the layout it owns. */
  setDocumentOrder(order: string[], active?: string): void
  setRestoringSession(value: boolean): void
  /** dnSpy's `-l` and the language box: the language the next document is decompiled in, remembered for the
   * next start the way dnSpy's DecompilerServiceSettings remembers it. */
  setDefaultLanguage(language: DecompilerLanguage): void
  /** Brings a tool window to the front. Set by the shell, which owns the layout. */
  openToolWindow?: (tabId: string) => void
  setOpenToolWindow(open: ((tabId: string) => void) | undefined): void
  /** Adds a bookmark on the line, or removes the one already there — dnSpy's Toggle Bookmark. */
  toggleBookmark(nodeId: string, line: number): void
  /** Flips the enabled state of the bookmark on the line — dnSpy's Enable Bookmark. */
  toggleBookmarkEnabledAt(nodeId: string, line: number): void
  removeBookmark(id: string): void
  removeBookmarks(ids: string[]): void
  removeAllBookmarksInDocument(nodeId: string): void
  /** Removes every bookmark — dnSpy's Clear Bookmarks. */
  clearBookmarks(): void
  setBookmarkEnabled(id: string, enabled: boolean): void
  setBookmarksEnabled(ids: string[], enabled: boolean): void
  setAllBookmarksEnabled(enabled: boolean): void
  renameBookmark(id: string, name: string): void
  setBookmarkLabels(id: string, labels: string[]): void
  /** Merges bookmarks read from a file, skipping the identities already known; returns how many were added. */
  importBookmarks(entries: BookmarkEntry[]): number
  /** Shows the bookmark's place — in a tab of its own with `newTab`, dnSpy's Ctrl/Shift+double-click. */
  goToBookmark(id: string, newTab?: boolean): Promise<void>
  /** The Breakpoints window's Go To Source Code: the breakpoint's method opened, the caret on its line. */
  goToLineBreakpoint(id: string, newTab?: boolean): Promise<void>
  selectNextBookmark(position?: CaretPosition): Promise<void>
  selectPreviousBookmark(position?: CaretPosition): Promise<void>
  selectNextBookmarkInDocument(documentId: string, line?: number): Promise<void>
  selectPreviousBookmarkInDocument(documentId: string, line?: number): Promise<void>
  selectNextBookmarkWithSameLabel(): Promise<void>
  selectPreviousBookmarkWithSameLabel(): Promise<void>
  /** Reads the stored diff back into the engine and shows the list that comes out of it. */
  loadExceptionSettings(): Promise<void>
  /** Turns "break when thrown" on or off for the types named by key. */
  setExceptionBreakWhenThrown(keys: string[], value: boolean): Promise<void>
  /** Adds a type the definition files do not name, so it can be broken on anyway. */
  addExceptionDefinition(entry: { category: string; name?: string; code?: number; description?: string }): Promise<void>
  removeExceptionDefinitions(keys: string[]): Promise<void>
  setExceptionConditions(keys: string[], conditions: DebugExceptionCondition[]): Promise<void>
  /** Throws the diff away and puts the engine back to the settings the definition files name. */
  restoreDefaultExceptionSettings(): Promise<void>
  /** Writes a message to an Output pane, a line at a time, each with a timestamp while the option asks for one. */
  appendOutput(message: string, pane?: OutputPaneId): void
  /** Empties an Output pane, the selected one by default — dnSpy's Clear All. */
  clearOutput(pane?: OutputPaneId): void
  selectOutputPane(pane: OutputPaneId): void
  clearError(): void
  /** Builds the C# Interactive session the first time the window is opened, printing the banner. */
  startScript(): Promise<void>
  /** Runs one submission, echoing it first; `#`-commands are handled here rather than by the host. */
  /**
   * Runs a submission. `colors` are the semantic colors the input had (against `code` as typed), which its echo in
   * the log keeps, as dnSpy's REPL keeps a submitted command's colors; without them the echo is classified first.
   */
  evaluateScript(code: string, colors?: ClassifiedSpan[]): Promise<void>
  /** Rebuilds the session, which is what `#reset` does and what drops the script's variables.
   *  `loadConfig` is false for `#reset noconfig`. */
  resetScript(loadConfig?: boolean): Promise<void>
  /** Appends a line the host streamed while a submission runs. */
  appendScriptOutput(notification: ScriptOutputNotification): void
  clearScriptOutput(): void
  /** Reprints the `#help` text without going near the host. */
  showScriptHelp(): void
}

/** The panes the Output window's "Show output from" lists: the port's own log, and the debugger's. */
export type OutputPaneId = 'dnSpy' | 'debug'

/** One line of an Output pane: its text, and the timestamp OutputBufferVM wrote in front of it, if any. */
export interface OutputLine {
  timestamp?: string
  text: string
}

/**
 * OutputBufferVM.WriteInternal: every line a message makes starts with the time it was written, in the format
 * the Output window's options give, while "Show timestamps" is on — a line written with it off keeps none.
 */
const outputLines = (message: string): OutputLine[] => {
  const { showTimestamps, timestampDateTimeFormat } = loadAppOptions().output.general
  const timestamp = showTimestamps && timestampDateTimeFormat.trim() ? formatDateTime(new Date(), timestampDateTimeFormat, getActiveLocale()) : undefined
  return message.split(/\r\n|\r|\n/).map((text) => timestamp === undefined ? { text } : { timestamp, text })
}

/** How many lines a pane keeps before the oldest go. */
const OUTPUT_LIMIT = 10000

/**
 * The module a File-menu save acts on: the one the tree has selected, or the first the workspace holds
 * when the selection is not a module. dnSpy saves the active document, which is this selection here.
 */
/**
 * The module a File-menu save acts on: the one above the selected row. A module is keyed by the id of the
 * root row that holds it — the assembly, or the module itself when it has no assembly — so a selected row
 * is followed up the parents until that root is reached. A module row names its file in the description,
 * which is what resolves it: its own id is not the root's.
 */
const currentModule = (state: Pick<AppState, 'modules' | 'selectedNode' | 'parents' | 'roots' | 'children'>): OpenedModule | undefined => {
  if (!state.selectedNode)
    return state.modules[0]
  let id = state.selectedNode.id
  for (let guard = 0; guard < 256; guard++) {
    const node = findNode(state, id)
    if (node?.kind === 'module') {
      const byPath = state.modules.find((module) => module.path === node.description)
      if (byPath)
        return byPath
    }
    const root = state.modules.find((module) => module.id === id)
    if (root)
      return root
    const parentId = state.parents[id]
    if (!parentId)
      break
    id = parentId
  }
  return state.modules[0]
}

const loadBool = (key: string, fallback: boolean): boolean => {
  if (typeof localStorage === 'undefined')
    return fallback
  const saved = localStorage.getItem(key)
  return saved === null ? fallback : saved === 'true'
}

// Declared up here rather than beside its readers: the initial state calls `loadBookmarks()` while the
// module is still evaluating, so a `const` further down would still be in its temporal dead zone.
const bookmarksStorageKey = 'dnspy.bookmarks.v1'

// dnSpy's DecompilerServiceSettings.LanguageGuid: the decompiler chosen last, which the next start opens with.
// Up here for the same reason as the bookmark key.
const decompilerLanguageStorageKey = 'dnspy.decompilerLanguage'
const decompilerLanguages: readonly DecompilerLanguage[] = ['cSharp', 'visualBasic', 'il', 'ilWithCSharp']

const loadDefaultLanguage = (): DecompilerLanguage => {
  if (typeof localStorage === 'undefined')
    return 'cSharp'
  const saved = localStorage.getItem(decompilerLanguageStorageKey)
  return decompilerLanguages.find((language) => language === saved) ?? 'cSharp'
}

// dnSpy's AssemblyExplorerMostRecentlyUsedList, and the list of file sets this port kept before it — read once to
// carry the files over. Up here for the same reason as the bookmark key: `loadRecentFiles()` runs at module eval.
const recentFilesStorageKey = 'dnspy.recentFiles.v1'
const legacyRecentWorkspacesStorageKey = 'dnspy.recentWorkspaces.v1'

// Where the breakpoints WPF dnSpy would have written to its settings service go. Declared up here for
// the same reason the bookmark key is.
const breakpointsStorageKey = 'dnspy.breakpoints.v1'

// Ids and ordering only have to be unique within the running client, so they are handed out from
// counters rather than derived from the persisted data.
let bookmarkSequence = 0
let bookmarkOrder = 0
let caretRevealToken = 0

/** Shows a node in the active tab when the shell can — which selects it in the tree too — and only selects it otherwise. */
const showOrReveal = async (get: () => AppState, nodeId: string): Promise<void> => {
  const open = get().openNodeById
  if (open && await open(nodeId))
    return
  await get().revealNode(nodeId)
}
// Each stop, step and frame switch asks the editor to show a line; the token tells a second request for
// the same line apart from a re-render of the first, which is what keeps the caret from being reset.
let stoppedRevealToken = 0
// Up here for the same reason: `loadBreakpoints()` mints ids while the module is still evaluating.
let lineBreakpointSequence = 0

export const useAppStore = create<AppState>((set, get) => ({
  backendStatus: { state: 'starting' },
  workspaceGeneration: 0,
  modules: [],
  roots: [],
  children: {},
  parents: {},
  expanded: {},
  loadingNodes: {},
  selectedNodes: [],
  documents: {},
  documentOrder: [],
  restoringSession: false,
  defaultLanguage: loadDefaultLanguage(),
  assemblyListRevision: 0,
  output: [],
  debugOutput: [],
  outputPane: 'dnSpy',
  scriptEntries: [],
  scriptRunning: false,
  scriptHistory: [],
  scriptStarted: false,
  scriptGeneration: 0,
  busy: false,
  dirty: false,
  modifiedDocuments: [],
  canUndo: false,
  canRedo: false,
  recentFiles: loadRecentFiles(),
  debugState: 'inactive',
  debugThreads: [],
  debugFrames: [],
  debugVariables: [],
  debugModules: [],
  watches: [],
  otherWatches: {},
  otherWatchValues: {},
  watchValues: [],
  debugGeneration: 0,
  moduleBreakpoints: [],
  functionBreakpoints: [],
  lineBreakpoints: [],
  bookmarks: [],
  exceptionCategories: [],
  exceptionSettings: [],
  exceptionDiff: {},
  exceptionSettingsLoaded: false,
  debugCapabilities: {},

  setBackendStatus: (status) => {
    set({ backendStatus: status })
    get().appendOutput(status.message
      ? t('Backend: {state} - {message}', { state: t(status.state), message: status.message })
      : t('Backend: {state}', { state: t(status.state) }))
  },

  chooseAndOpen: async () => {
    const paths = await window.dnSpy.openAssemblies()
    if (paths.length > 0)
      await get().openPaths(paths, { remember: true })
  },

  openPaths: async (paths, options = {}) => {
    const generation = get().workspaceGeneration
    const isCurrent = (): boolean => get().workspaceGeneration === generation
    const select = options.select !== false
    set({ busy: true, error: undefined })
    try {
      const previousWorkspace = get().workspaceId
      if (previousWorkspace) {
        // dnSpy's Open command grows the tree rather than replacing it, and a file it already has is
        // selected rather than loaded a second time. Nothing is torn down here: the same workspace
        // serves both sets of modules, so the node ids the client has cached still name their nodes,
        // and the tabs, expanded branches and undo stack all stay.
        const previousModules = get().modules
        const added = await window.dnSpy.addModules(previousWorkspace, paths)
        if (!isCurrent()) return
        const roots = await window.dnSpy.getRoots(previousWorkspace)
        if (!isCurrent()) return
        set((state) => {
          const known = new Set(state.roots.map((root) => root.id))
          // dnSpy selects the last file it loaded, whether it was there already or not; failing that, the
          // first root that was not there before is one the user just added.
          const newSelection = select ? rootOfPath(roots.nodes, added.modules, paths.at(-1)) ?? roots.nodes.find((root) => !known.has(root.id)) ?? state.selectedNode : state.selectedNode
          return {
            modules: added.modules,
            roots: roots.nodes,
            selectedNode: newSelection,
            selectedNodes: newSelection ? [newSelection] : state.selectedNodes,
            workspaceStateId: added.stateId,
            savedStateId: added.stateId,
            recentFiles: options.remember ? rememberRecentFiles(paths) : state.recentFiles,
            assemblyListRevision: state.assemblyListRevision + 1,
          }
        })
        const count = added.modules.length - previousModules.length
        get().appendOutput(count === 0
          ? t('Skipped {count} module(s) that are already open.', { count: added.skipped.length })
          : t('Opened {count} module(s).', { count }))
        return
      }
      const opened = await window.dnSpy.openWorkspace(paths)
      if (!isCurrent()) {
        await window.dnSpy.closeWorkspace(opened.workspaceId)
        return
      }
      const roots = await window.dnSpy.getRoots(opened.workspaceId)
      if (!isCurrent()) {
        await window.dnSpy.closeWorkspace(opened.workspaceId)
        return
      }
      const selected = select ? rootOfPath(roots.nodes, opened.modules, paths.at(-1)) ?? roots.nodes[0] : undefined
      set({
        workspaceId: opened.workspaceId,
        modules: opened.modules,
        roots: roots.nodes,
        children: {},
        parents: {},
        expanded: {},
        loadingNodes: {},
        selectedNode: selected,
        selectedNodes: selected ? [selected] : [],
        documents: {},
        documentOrder: [],
        activeDocumentId: undefined,
        dirty: false,
        modifiedDocuments: [],
        workspaceStateId: opened.stateId,
        savedStateId: opened.stateId,
        canUndo: false,
        canRedo: false,
        ...(options.remember ? { recentFiles: rememberRecentFiles(paths) } : {}),
      })
      get().appendOutput(t('Opened {count} module(s).', { count: opened.modules.length }))
    } catch (error) {
      if (!isCurrent()) return
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Open failed: {message}', { message }))
    } finally {
      if (isCurrent())
        set({ busy: false })
    }
  },

  // dnSpy's RecentFilesCommand.OpenFile: the file comes back into the tree as it stands — the files beside it
  // stay — goes to the top of the list, and its root is selected.
  openRecentFile: async (path) => {
    await get().openPaths([path], { remember: true })
  },

  closeWorkspace: async () => {
    const workspaceId = get().workspaceId
    // Close All is a user decision, even while startup is rebuilding the session. Save the empty
    // state now, before backend cleanup, and invalidate every continuation of that old workspace.
    enableSessionPersistence()
    set({
      workspaceGeneration: get().workspaceGeneration + 1,
      workspaceId: undefined,
      modules: [],
      roots: [],
      children: {},
      parents: {},
      expanded: {},
      loadingNodes: {},
      selectedNode: undefined,
      selectedNodes: [],
      documents: {},
      documentOrder: [],
      activeDocumentId: undefined,
      restoringSession: false,
      busy: false,
      error: undefined,
      dirty: false,
      modifiedDocuments: [],
      workspaceStateId: undefined,
      savedStateId: undefined,
      canUndo: false,
      canRedo: false,
    })
    get().appendOutput(t('Workspace closed.'))
    if (workspaceId)
      await window.dnSpy.closeWorkspace(workspaceId)
  },

  toggleNode: async (node) => {
    if (!node.hasChildren)
      return
    if (get().expanded[node.id]) {
      set((state) => ({ expanded: { ...state.expanded, [node.id]: false } }))
      return
    }
    await get().expandNode(node)
  },

  expandNode: async (node) => {
    if (!node.hasChildren)
      return
    set((state) => ({
      expanded: { ...state.expanded, [node.id]: true },
      loadingNodes: { ...state.loadingNodes, [node.id]: !state.children[node.id] },
    }))
    await get().loadChildren(node)
  },

  loadChildren: async (node) => {
    if (!node.hasChildren || get().children[node.id])
      return
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return
    try {
      const response = await window.dnSpy.getChildren(workspaceId, node.id)
      if (get().workspaceId !== workspaceId) return
      set((state) => ({
        children: { ...state.children, [node.id]: response.nodes },
        parents: {
          ...state.parents,
          ...Object.fromEntries(response.nodes.map((child) => [child.id, node.id])),
        },
        loadingNodes: { ...state.loadingNodes, [node.id]: false },
      }))
    } catch (error) {
      if (get().workspaceId !== workspaceId) return
      const message = error instanceof Error ? error.message : String(error)
      set((state) => ({
        error: message,
        loadingNodes: { ...state.loadingNodes, [node.id]: false },
      }))
      get().appendOutput(t('Tree load failed: {message}', { message }))
    }
  },

  selectNode: (node, options) => {
    const current = get()

    // Toggle selection with Ctrl/Cmd click
    if (options?.toggle) {
      const isSelected = current.selectedNodes.some((n) => n.id === node.id)
      if (isSelected) {
        // Remove from selection
        const newSelection = current.selectedNodes.filter((n) => n.id !== node.id)
        set({
          selectedNodes: newSelection,
          selectedNode: newSelection[0],
          selectionAnchorId: node.id,
        })
      } else {
        // Add to selection
        set({
          selectedNodes: [...current.selectedNodes, node],
          selectedNode: node,
          selectionAnchorId: node.id,
        })
      }
      return
    }

    // Range selection with Shift: from the anchor — the row last picked on its own — to this one. An anchor the
    // selection no longer holds, which a selection the app made itself leaves behind, gives way to the selection.
    if (options?.range && current.selectedNode) {
      const allNodes = options.rows ?? collectVisibleNodes(current)
      const anchorId = current.selectionAnchorId !== undefined && current.selectedNodes.some((n) => n.id === current.selectionAnchorId)
        ? current.selectionAnchorId
        : current.selectedNode.id
      const startIndex = allNodes.findIndex((n) => n.id === anchorId)
      const endIndex = allNodes.findIndex((n) => n.id === node.id)

      if (startIndex >= 0 && endIndex >= 0) {
        const [from, to] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex]
        const rangeNodes = allNodes.slice(from, to + 1)
        set({
          selectedNodes: rangeNodes,
          selectedNode: node,
          selectionAnchorId: anchorId,
        })
        return
      }
    }

    // Single selection (default)
    set({ selectedNode: node, selectedNodes: [node], selectionAnchorId: node.id })
  },

  selectNodes: (nodes, primary) => {
    if (nodes.length === 0)
      return
    const selected = primary && nodes.some((node) => node.id === primary.id) ? primary : nodes[0]
    set({ selectedNodes: [...nodes], selectedNode: selected })
  },

  collapseTreeViewNodes: () => {
    const { selectedNode, parents, expanded, children } = get()
    const keep = new Set<string>()
    if (selectedNode) {
      keep.add(selectedNode.id)
      let id = parents[selectedNode.id]
      while (id && !keep.has(id)) {
        keep.add(id)
        id = parents[id]
      }
    }
    const next: Record<string, boolean> = {}
    for (const id of Object.keys(expanded))
      next[id] = keep.has(id)
    // An ancestor on the path to the selection may never have been toggled, so it is absent from
    // `expanded`; mark it expanded to keep the selection visible. Only when its children are
    // already loaded — re-expanding a node with cached children needs no backend round trip.
    for (const id of keep) {
      if (id === selectedNode?.id || children[id])
        next[id] = true
    }
    set({ expanded: next })
  },

  openDocument: async (node, language = get().defaultLanguage, select = true) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      throw new Error(t('No workspace is open.'))
    const documentId = node.id
    set((state) => ({
      ...(select ? { selectedNode: node, selectedNodes: [node] } : {}),
      documents: {
        ...state.documents,
        [documentId]: {
          nodeId: node.id,
          title: node.label,
          language: language === 'cSharp' ? 'csharp' : language === 'visualBasic' ? 'visual-basic' : 'il',
          text: '',
          spans: [],
          diagnostics: [],
          codeStatements: [],
          loading: true,
          requestedLanguage: language,
        },
      },
    }))
    try {
      // Pass decompiler settings from app options to the backend
      const appOptions = await import('./components/app-options').then(m => m.loadAppOptions())
      const settings = {
        cSharp: {
          anonymousMethods: appOptions.decompiler.cSharp.anonymousMethods,
          yieldReturn: appOptions.decompiler.cSharp.yieldReturn,
          asyncAwait: appOptions.decompiler.cSharp.asyncAwait,
          queryExpressions: appOptions.decompiler.cSharp.queryExpressions,
          expressionTrees: appOptions.decompiler.cSharp.expressionTrees,
          useDebugSymbols: appOptions.decompiler.cSharp.useDebugSymbols,
          showXmlDocumentation: appOptions.decompiler.cSharp.showXmlDocumentation,
          sortCustomAttributes: appOptions.decompiler.cSharp.sortCustomAttributes,
          fullyQualifyAllTypes: appOptions.decompiler.cSharp.fullyQualifyAllTypes,
          fullyQualifyAmbiguousTypeNames: appOptions.decompiler.cSharp.fullyQualifyAmbiguousTypeNames,
          removeEmptyDefaultConstructors: appOptions.decompiler.cSharp.removeEmptyDefaultConstructors,
          showTokenAndRvaComments: appOptions.decompiler.cSharp.showTokenAndRvaComments,
          sortMembers: appOptions.decompiler.cSharp.sortMembers,
          forceShowAllMembers: appOptions.decompiler.cSharp.forceShowAllMembers,
          sortSystemUsingStatementsFirst: appOptions.decompiler.cSharp.sortSystemUsingStatementsFirst,
          useSourceCodeOrder: appOptions.decompiler.cSharp.useSourceCodeOrder,
          oneCustomAttributePerLine: appOptions.decompiler.cSharp.oneCustomAttributePerLine,
          allowFieldInitializers: appOptions.decompiler.cSharp.allowFieldInitializers,
          typeAddInternalModifier: appOptions.decompiler.cSharp.typeAddInternalModifier,
          memberAddPrivateModifier: appOptions.decompiler.cSharp.memberAddPrivateModifier,
          hexadecimalNumbers: appOptions.decompiler.cSharp.hexadecimalNumbers,
          emitCalliAsInvocationExpression: appOptions.decompiler.cSharp.emitCalliAsInvocationExpression,
          insertParenthesesForReadability: appOptions.decompiler.cSharp.insertParenthesesForReadability,
        },
        il: {
          showXmlDocumentation: appOptions.decompiler.il.showXmlDocumentation,
          showTokenAndRvaComments: appOptions.decompiler.il.showTokenAndRvaComments,
          showILBytes: appOptions.decompiler.il.showILBytes,
          showILComments: appOptions.decompiler.il.showILComments,
          sortMembers: appOptions.decompiler.il.sortMembers,
          showPdbInfo: appOptions.decompiler.il.showPdbInfo,
          hexadecimalNumbers: appOptions.decompiler.il.hexadecimalNumbers,
        },
        baml: {
          newLineOnAttributes: appOptions.baml.newLineOnAttributes,
          useTabs: appOptions.baml.useTabs,
        },
        decompileFullType: appOptions.environmentGeneral.decompileFullType,
        useMemoryMappedIO: appOptions.environmentGeneral.useMemoryMappedIO,
      }
      const document = await window.dnSpy.decompile(workspaceId, node.id, language, settings)
      if (get().workspaceId !== workspaceId) return documentId
      if (get().documents[documentId]?.requestedLanguage === language) {
        set((state) => ({
          documents: {
            ...state.documents,
            [documentId]: {
              ...document,
              codeStatements: document.codeStatements ?? [],
              nodeId: node.id,
              loading: false,
              requestedLanguage: language,
            },
          },
        }))
        // The document is what turns a bookmark's location back into a line and a node id.
        attachBookmarks(set, documentId, document)
        // And the same for a breakpoint restored from settings, whose node id died with its workspace. Only a
        // C# line is what the backend resolves a breakpoint's line against, so an IL view's statements —
        // one per instruction — must not become its line.
        if (document.language === 'csharp')
          attachLineBreakpoints(set, documentId, document.codeStatements)
      }
    } catch (error) {
      if (get().workspaceId !== workspaceId) return documentId
      const message = error instanceof Error ? error.message : String(error)
      set((state) => ({
        error: message,
        documents: {
          ...state.documents,
          [documentId]: {
            ...state.documents[documentId],
            loading: false,
            diagnostics: [{ severity: 'error', message }],
          },
        },
      }))
      get().appendOutput(t('Decompile failed: {message}', { message }))
    }
    return documentId
  },

  changeLanguage: async (language, openDocumentIds) => {
    get().setDefaultLanguage(language)
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return
    // The tabs are decompiled again where they are; the tree keeps the selection it has. A document still
    // being decompiled is one a tab is about to show, and is asked for again in the new language too.
    const loading = Object.keys(get().documents).filter((documentId) => get().documents[documentId].loading)
    const stale = [...new Set([...(openDocumentIds ?? get().documentOrder), ...loading])].filter((documentId) => {
      const document = get().documents[documentId]
      return document && document.requestedLanguage !== language
    })
    await Promise.all(stale.map(async (documentId) => {
      const nodeId = get().documents[documentId]?.nodeId ?? documentId
      const node = findNode(get(), nodeId) ?? await window.dnSpy.getNode(workspaceId, nodeId).catch(() => undefined)
      if (node && get().workspaceId === workspaceId)
        await get().openDocument(node, language, false)
    }))
  },

  changeDocumentLanguage: async (nodeId, language) => {
    const existing = get().documents[nodeId]
    const node = findNode(get(), nodeId)
    if (existing && node)
      await get().openDocument(node, language)
  },

  updateDocumentEditorState: (nodeId, cursorLine, cursorColumn, scrollTop) => {
    const existing = get().documents[nodeId]
    if (!existing)
      return
    set((state) => ({
      documents: {
        ...state.documents,
        [nodeId]: {
          ...existing,
          cursorLine,
          cursorColumn,
          scrollTop,
        },
      },
    }))
  },

  renameNode: async (node, newName) => {
    const workspaceId = get().workspaceId
    if (!workspaceId || !newName.trim())
      return false
    set({ busy: true, error: undefined })
    let transactionId: string | undefined
    try {
      transactionId = (await window.dnSpy.beginEdit(workspaceId)).transactionId
      await window.dnSpy.queueRename(workspaceId, transactionId, node.id, newName.trim())
      const committed = await window.dnSpy.commitEdit(workspaceId, transactionId)
      const parentId = get().parents[node.id]
      if (parentId) {
        const refreshed = await window.dnSpy.getChildren(workspaceId, parentId)
        set((state) => ({ children: { ...state.children, [parentId]: refreshed.nodes } }))
      }
      set((state) => ({
        ...modifiedFrom(committed, state),
        workspaceStateId: committed.stateId,
        canUndo: committed.canUndo,
        canRedo: committed.canRedo,
        selectedNode: state.selectedNode?.id === node.id ? { ...state.selectedNode, label: newName.trim() } : state.selectedNode,
        documents: state.documents[node.id]
          ? { ...state.documents, [node.id]: { ...state.documents[node.id], title: newName.trim() } }
          : state.documents,
      }))
      get().appendOutput(t('Renamed {oldName} to {newName}.', { oldName: node.label, newName: newName.trim() }))
      return true
    } catch (error) {
      if (transactionId) {
        try { await window.dnSpy.rollbackEdit(workspaceId, transactionId) } catch { /* already committed or invalidated */ }
      }
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Rename failed: {message}', { message }))
      return false
    } finally {
      set({ busy: false })
    }
  },

  createNode: async (ownerNodeId, options, nested) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return false
    set({ busy: true, error: undefined })
    let transactionId: string | undefined
    try {
      transactionId = (await window.dnSpy.beginEdit(workspaceId)).transactionId
      const created = await window.dnSpy.createNode(workspaceId, transactionId, ownerNodeId, options, nested)
      const committed = await window.dnSpy.commitEdit(workspaceId, transactionId)
      // The commit reloads the list of whichever node holds a changed one, and it finds that owner in the
      // parents map — which a node that has just been created is not in, since nothing has listed it yet.
      // Its owner is the one the caller named, so the link is written down here: the same pass then
      // refetches the owner's children, and revealNode can walk up from the new node to the module.
      set((state) => ({ parents: { ...state.parents, [created.nodeId]: ownerNodeId } }))
      await refreshAfterEdit(get, set, committed)
      await get().revealNode(created.nodeId)
      get().appendOutput(t('Created {name}.', { name: created.label }))
      return true
    } catch (error) {
      if (transactionId) {
        try { await window.dnSpy.rollbackEdit(workspaceId, transactionId) } catch { /* already committed or invalidated */ }
      }
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Create failed: {message}', { message }))
      return false
    } finally {
      set({ busy: false })
    }
  },

  applyNodeOptions: async (nodeId, options) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return false
    set({ busy: true, error: undefined })
    let transactionId: string | undefined
    try {
      transactionId = (await window.dnSpy.beginEdit(workspaceId)).transactionId
      await window.dnSpy.setNodeOptions(workspaceId, transactionId, nodeId, options)
      const committed = await window.dnSpy.commitEdit(workspaceId, transactionId)
      await refreshAfterEdit(get, set, committed)
      get().appendOutput(t('Edited {name}.', { name: options.method?.name ?? options.field?.name ?? options.type?.name ?? '' }))
      return true
    } catch (error) {
      if (transactionId) {
        try { await window.dnSpy.rollbackEdit(workspaceId, transactionId) } catch { /* already committed or invalidated */ }
      }
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Edit failed: {message}', { message }))
      return false
    } finally {
      set({ busy: false })
    }
  },

  revealNode: async (nodeId) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return
    // Every ancestor has to be open for the node to be on screen, and its children have to be loaded for
    // the tree to have a row to select — a created member's own row is in the list its owner loads.
    const ancestors: string[] = []
    // A node the client has never listed has no recorded ancestor: a member's node id names its module
    // and token but not the type that declares it, so only the backend can say what it hangs off. Asking
    // for the chain also records it, so the walk answers for this node from then on.
    if (get().parents[nodeId] === undefined) {
      let path: TreeNode[]
      try {
        path = (await window.dnSpy.getNodePath(workspaceId, nodeId)).nodes
      } catch {
        // A node the backend no longer has stays unselected rather than selected-and-blank.
        return
      }
      if (path.length === 0)
        return
      ancestors.push(...path.slice(0, -1).map((ancestor) => ancestor.id))
      set((state) => ({
        parents: {
          ...state.parents,
          ...Object.fromEntries(path.slice(1).map((node, index) => [node.id, path[index].id])),
        },
      }))
    } else {
      for (let id = get().parents[nodeId]; id !== undefined; id = get().parents[id])
        ancestors.unshift(id)
    }
    // Already where the tree is looking — dnSpy's own tree does nothing in this case either, which keeps
    // the reveal the shell runs on every tab change from re-reading a tree that is already right. The
    // selection alone does not say that: opening a document selects the node it opens, and the node a
    // reference into an unopened module named has no row until its ancestors are opened above it.
    if (get().selectedNode?.id === nodeId && ancestors.every((id) => get().expanded[id]))
      return
    set((state) => ({ expanded: { ...state.expanded, ...Object.fromEntries(ancestors.map((id) => [id, true])) } }))
    for (const ancestorId of ancestors) {
      if (get().children[ancestorId])
        continue
      try {
        const response = await window.dnSpy.getChildren(workspaceId, ancestorId)
        set((state) => ({
          children: { ...state.children, [ancestorId]: response.nodes },
          parents: { ...state.parents, ...Object.fromEntries(response.nodes.map((child) => [child.id, ancestorId])) },
        }))
      } catch {
        // The ancestor is gone; there is nothing left to reveal the node in.
      }
    }
    try {
      const node = await window.dnSpy.getNode(workspaceId, nodeId)
      set({ selectedNode: node, selectedNodes: [node] })
    } catch {
      // A node the backend would not describe stays unselected rather than selected-and-blank.
    }
  },

  copyIlBytes: async (instructions) => {
    const workspaceId = get().workspaceId
    const modulePath = instructions[0]?.modulePath
    if (!workspaceId || !modulePath)
      return
    try {
      const bytes = await window.dnSpy.getIlBytes(workspaceId, modulePath, instructions.filter((instruction) => instruction.modulePath === modulePath))
      await navigator.clipboard.writeText(bytes.hex).catch(() => undefined)
      if (bytes.hasUnknownBytes)
        await askIgnorableMessage(UNKNOWN_IL_BYTES_ID, t('Some of the copied bytes are unknown because the method has been edited. New tokens and string offsets are only known once the file has been saved to disk and re-opened.'), [t('OK')])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      get().appendOutput(t('Copy failed: {message}', { message }))
    }
  },

  deleteNode: async (node) => get().deleteNodes([node]),

  deleteNodes: async (nodes) => {
    const workspaceId = get().workspaceId
    if (!workspaceId || nodes.length === 0)
      return false
    set({ busy: true, error: undefined })
    let transactionId: string | undefined
    try {
      transactionId = (await window.dnSpy.beginEdit(workspaceId)).transactionId
      for (const node of nodes)
        await window.dnSpy.queueDelete(workspaceId, transactionId, node.id)
      const committed = await window.dnSpy.commitEdit(workspaceId, transactionId)
      await refreshAfterEdit(get, set, committed)
      // A removed node has no view model left, so refreshAfterEdit leaves the selection as it was;
      // dropping it here is what stops the shell from acting on a node that is gone.
      const removed = new Set(nodes.map((node) => node.id))
      set((state) => ({
        selectedNode: state.selectedNode && removed.has(state.selectedNode.id) ? undefined : state.selectedNode,
        selectedNodes: state.selectedNodes.filter((n) => !removed.has(n.id)),
      }))
      for (const node of nodes)
        get().appendOutput(t('Deleted {name}.', { name: node.label }))
      return true
    } catch (error) {
      if (transactionId) {
        try { await window.dnSpy.rollbackEdit(workspaceId, transactionId) } catch { /* already committed or invalidated */ }
      }
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Delete failed: {message}', { message }))
      return false
    } finally {
      set({ busy: false })
    }
  },

  renameNamespace: async (node, newName) => setNamespaceEdit(get, set, node, newName.trim()),

  moveTypesToEmptyNamespace: async (node) => setNamespaceEdit(get, set, node, ''),

  replaceMethodBodyWithStub: async (node) => {
    const workspaceId = get().workspaceId
    if (!workspaceId || node.kind !== 'method')
      return false
    set({ busy: true, error: undefined })
    let transactionId: string | undefined
    try {
      transactionId = (await window.dnSpy.beginEdit(workspaceId)).transactionId
      await window.dnSpy.queueMethodBodyStub(workspaceId, transactionId, node.id)
      const committed = await window.dnSpy.commitEdit(workspaceId, transactionId)
      await get().methodBodyChanged(node, committed)
      return true
    } catch (error) {
      if (transactionId) {
        try { await window.dnSpy.rollbackEdit(workspaceId, transactionId) } catch { /* already committed or invalidated */ }
      }
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('IL edit failed: {message}', { message }))
      return false
    } finally {
      set({ busy: false })
    }
  },

  resolveHexTarget: async (node) => {
    const workspaceId = get().workspaceId
    if (!workspaceId || !node) {
      set({ hexTarget: undefined })
      return
    }
    try {
      const target = await window.dnSpy.resolveHexTarget(workspaceId, node.id)
      // A selection can change faster than the round trip, so a stale answer is dropped rather than
      // left to drive the menu for a node that is no longer selected.
      if (get().selectedNode?.id === node.id)
        set({ hexTarget: target })
    } catch {
      if (get().selectedNode?.id === node.id)
        set({ hexTarget: undefined })
    }
  },

  setCodeCaret: async (position) => {
    set({ codeCaret: position })
    const workspaceId = get().workspaceId
    if (!workspaceId || !position) {
      set({ hexStatement: undefined })
      return
    }
    const statements = get().documents[position.documentId]?.codeStatements
    const statement = codeStatementAt(statements, position.line, position.column)
    if (!statement) {
      set({ hexStatement: undefined })
      return
    }
    try {
      const resolved = await window.dnSpy.resolveHexStatement(workspaceId, statement.modulePath, statement.metadataToken, statement.ilOffset, statement.ilEndOffset)
      set({ hexStatement: resolved.moduleId && resolved.range ? { moduleId: resolved.moduleId, range: resolved.range } : undefined })
    } catch {
      set({ hexStatement: undefined })
    }
  },

  showHexAt: (moduleId, offset, length) => {
    set({ hexNavigation: { moduleId, offset, length, nonce: ++hexNavigationToken } })
  },

  hexWriteMethodBody: async (kind) => {
    const { hexTarget, selectedNode } = get()
    const method = hexTarget?.method
    const encoded = kind === 'returnTrue' ? method?.returnTrueBody : kind === 'returnFalse' ? method?.returnFalseBody : method?.emptyBody
    if (!selectedNode || !method || !encoded)
      return false
    return writeHexPatch(get, set, selectedNode.id, method.bodyOffset, encoded, t('Updated method body bytes for {name}.', { name: selectedNode.label }))
  },

  hexCopyMethodBody: async () => {
    const { workspaceId, hexTarget, selectedNode } = get()
    const method = hexTarget?.method
    if (!workspaceId || !selectedNode || !method)
      return false
    try {
      const response = await window.dnSpy.readHex(workspaceId, hexTarget.moduleId, method.bodyOffset, method.bodySize)
      await navigator.clipboard.writeText(bytesToHex(decodeBase64(response.base64Data)))
      get().appendOutput(t('Copied the method body of {name}.', { name: selectedNode.label }))
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Copy failed: {message}', { message }))
      return false
    }
  },

  hexPasteMethodBody: async () => {
    const { hexTarget, selectedNode } = get()
    const method = hexTarget?.method
    if (!selectedNode || !method)
      return false
    let text: string
    try {
      text = await navigator.clipboard.readText()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Paste failed: {message}', { message }))
      return false
    }
    const data = parseHexText(text)
    if (!data) {
      set({ error: t('The clipboard does not hold hexadecimal bytes.') })
      get().appendOutput(t('Paste failed: the clipboard does not hold hexadecimal bytes.'))
      return false
    }
    // dnSpy writes the pasted bytes over the body only when they fit in it, which is the same test its
    // canned bodies pass.
    if (data.length > method.bodySize) {
      set({ error: t('The pasted bytes do not fit in the method body.') })
      get().appendOutput(t('Paste failed: the pasted bytes do not fit in the method body.'))
      return false
    }
    return writeHexPatch(get, set, selectedNode.id, method.bodyOffset, bytesToBase64(data), t('Updated method body bytes for {name}.', { name: selectedNode.label }))
  },

  /**
   * A byte write from the hex editor. The tab acts on the module it shows, which is the node the patch is
   * aimed at; the backend bounds it by the file alone, since a write outside a member has no member to stay
   * inside of. The message the user gets is dnSpy's own wording for each command.
   */
  hexWriteBytes: async (moduleId, offset, data, message) => {
    if (data.length === 0)
      return false
    return writeHexPatch(get, set, moduleId, offset, bytesToBase64(data), message ?? t('Wrote {count} byte(s) at 0x{offset}.', { count: data.length, offset: offset.toString(16).toUpperCase() }))
  },

  replaceResource: async (node) => {
    const workspaceId = get().workspaceId
    if (!workspaceId || node.kind !== 'resource')
      return false
    set({ busy: true, error: undefined })
    let transactionId: string | undefined
    try {
      transactionId = (await window.dnSpy.beginEdit(workspaceId)).transactionId
      const selected = await window.dnSpy.replaceResourceFromFile(workspaceId, transactionId, node.id)
      if (!selected) {
        await window.dnSpy.rollbackEdit(workspaceId, transactionId)
        return false
      }
      const committed = await window.dnSpy.commitEdit(workspaceId, transactionId)
      const parentId = get().parents[node.id]
      if (parentId) {
        const refreshed = await window.dnSpy.getChildren(workspaceId, parentId)
        set((state) => ({ children: { ...state.children, [parentId]: refreshed.nodes } }))
      }
      set((state) => ({
        ...modifiedFrom(committed, state),
        workspaceStateId: committed.stateId,
        canUndo: committed.canUndo,
        canRedo: committed.canRedo,
      }))
      get().appendOutput(t('Replaced resource {name}.', { name: node.label }))
      return true
    } catch (error) {
      if (transactionId) {
        try { await window.dnSpy.rollbackEdit(workspaceId, transactionId) } catch { /* already committed or invalidated */ }
      }
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Resource replacement failed: {message}', { message }))
      return false
    } finally {
      set({ busy: false })
    }
  },

  mergeAssembly: async (node) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return false
    set({ busy: true, error: undefined })
    let transactionId: string | undefined
    try {
      transactionId = (await window.dnSpy.beginEdit(workspaceId)).transactionId
      const merged = await window.dnSpy.mergeAssembly(workspaceId, transactionId, node.id)
      if (!merged) {
        await window.dnSpy.rollbackEdit(workspaceId, transactionId)
        return false
      }
      const committed = await window.dnSpy.commitEdit(workspaceId, transactionId)
      await refreshAfterEdit(get, set, committed)
      get().appendOutput(t('Merged an assembly into {name}.', { name: node.label }))
      return true
    } catch (error) {
      if (transactionId) {
        try { await window.dnSpy.rollbackEdit(workspaceId, transactionId) } catch { /* already committed or invalidated */ }
      }
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Merge failed: {message}', { message }))
      return false
    } finally {
      set({ busy: false })
    }
  },

  compileCode: async (node, mode, source, language = 'csharp') => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return { ok: false, diagnostics: [] }
    set({ busy: true, error: undefined })
    let transactionId: string | undefined
    try {
      transactionId = (await window.dnSpy.beginEdit(workspaceId)).transactionId
      const result = await window.dnSpy.compileSource(workspaceId, node.id, mode, source, transactionId, language, compilerSettingsFor(language))
      if (!result.success) {
        await window.dnSpy.rollbackEdit(workspaceId, transactionId)
        return { ok: false, diagnostics: result.diagnostics }
      }
      const committed = await window.dnSpy.commitEdit(workspaceId, transactionId)
      await refreshAfterEdit(get, set, committed)
      if (node.kind === 'type') {
        const parentId = get().parents[node.id]
        if (parentId)
          await refreshChildren(get, set, parentId)
        await refreshChildren(get, set, node.id)
      }
      get().appendOutput(t('Compiled {name}.', { name: node.label }))
      return { ok: true, diagnostics: result.diagnostics }
    } catch (error) {
      if (transactionId) {
        try { await window.dnSpy.rollbackEdit(workspaceId, transactionId) } catch { /* already committed or invalidated */ }
      }
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Compile failed: {message}', { message }))
      return { ok: false, diagnostics: [{ severity: 'error', id: '', text: message, startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }] }
    } finally {
      set({ busy: false })
    }
  },

  ensureWorkspace: async () => {
    const existing = get().workspaceId
    if (existing)
      return existing
    try {
      const created = await window.dnSpy.createWorkspace()
      set({
        workspaceId: created.workspaceId,
        modules: created.modules,
        roots: [],
        children: {},
        parents: {},
        expanded: {},
        dirty: false,
        modifiedDocuments: [],
        workspaceStateId: created.stateId,
        savedStateId: created.stateId,
        canUndo: false,
        canRedo: false,
      })
      return created.workspaceId
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      return undefined
    }
  },

  createAssembly: async (options, clrVersion) => {
    const workspaceId = await get().ensureWorkspace()
    if (!workspaceId)
      return false
    return queueDocumentEdit(get, set, workspaceId, (transactionId) => window.dnSpy.createAssembly(workspaceId, transactionId, options, clrVersion), t('Create Assembly'))
  },

  createNetModule: async (name, mvid, clrVersion) => {
    const workspaceId = await get().ensureWorkspace()
    if (!workspaceId)
      return false
    return queueDocumentEdit(get, set, workspaceId, (transactionId) => window.dnSpy.createNetModule(workspaceId, transactionId, name, mvid, clrVersion), t('Create NetModule'))
  },

  addNetModule: async (node, module) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return false
    const assemblyId = rootIdOf(get(), node.id)
    return queueDocumentEdit(get, set, workspaceId, (transactionId) => window.dnSpy.addNetModule(workspaceId, transactionId, node.id, module),
      'path' in module ? t('Add Existing NetModule to Assembly') : t('Add New NetModule to Assembly'), assemblyId)
  },

  removeNetModule: async (node) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return false
    const assemblyId = rootIdOf(get(), node.id)
    const removed = await queueDocumentEdit(get, set, workspaceId, async (transactionId) => {
      await window.dnSpy.removeNetModule(workspaceId, transactionId, node.id)
      return undefined
    }, t('Remove NetModule from Assembly'), assemblyId)
    if (removed)
      set((state) => ({
        selectedNode: state.selectedNode?.id === node.id ? undefined : state.selectedNode,
        selectedNodes: state.selectedNodes.filter((selected) => selected.id !== node.id),
      }))
    return removed
  },

  applyAssemblyOptions: async (node, options) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return false
    set({ busy: true, error: undefined })
    let transactionId: string | undefined
    try {
      transactionId = (await window.dnSpy.beginEdit(workspaceId)).transactionId
      await window.dnSpy.setAssemblyOptions(workspaceId, transactionId, node.id, options)
      const committed = await window.dnSpy.commitEdit(workspaceId, transactionId)
      await refreshAfterEdit(get, set, committed)
      get().appendOutput(t('Edited assembly {name}.', { name: options.name }))
      return true
    } catch (error) {
      if (transactionId) {
        try { await window.dnSpy.rollbackEdit(workspaceId, transactionId) } catch { /* already committed or invalidated */ }
      }
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Assembly edit failed: {message}', { message }))
      return false
    } finally {
      set({ busy: false })
    }
  },

  applyModuleOptions: async (node, options) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return false
    set({ busy: true, error: undefined })
    let transactionId: string | undefined
    try {
      transactionId = (await window.dnSpy.beginEdit(workspaceId)).transactionId
      await window.dnSpy.setModuleOptions(workspaceId, transactionId, node.id, options)
      const committed = await window.dnSpy.commitEdit(workspaceId, transactionId)
      await refreshAfterEdit(get, set, committed)
      get().appendOutput(t('Edited module {name}.', { name: options.name }))
      return true
    } catch (error) {
      if (transactionId) {
        try { await window.dnSpy.rollbackEdit(workspaceId, transactionId) } catch { /* already committed or invalidated */ }
      }
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Module edit failed: {message}', { message }))
      return false
    } finally {
      set({ busy: false })
    }
  },

  applyResourceOptions: async (node, options) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return false
    set({ busy: true, error: undefined })
    let transactionId: string | undefined
    try {
      transactionId = (await window.dnSpy.beginEdit(workspaceId)).transactionId
      await window.dnSpy.setResourceOptions(workspaceId, transactionId, node.id, options)
      const committed = await window.dnSpy.commitEdit(workspaceId, transactionId)
      await refreshAfterEdit(get, set, committed)
      get().appendOutput(t('Edited resource {name}.', { name: options.name }))
      return true
    } catch (error) {
      if (transactionId) {
        try { await window.dnSpy.rollbackEdit(workspaceId, transactionId) } catch { /* already committed or invalidated */ }
      }
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Resource edit failed: {message}', { message }))
      return false
    } finally {
      set({ busy: false })
    }
  },

  createResource: async (owner, options) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return false
    set({ busy: true, error: undefined })
    let transactionId: string | undefined
    try {
      transactionId = (await window.dnSpy.beginEdit(workspaceId)).transactionId
      const created = await window.dnSpy.createResource(workspaceId, transactionId, owner.id, options)
      const committed = await window.dnSpy.commitEdit(workspaceId, transactionId)
      await refreshAfterEdit(get, set, committed)
      await get().revealNode(created.nodeId)
      get().appendOutput(t('Created resource {name}.', { name: created.label }))
      return true
    } catch (error) {
      if (transactionId) {
        try { await window.dnSpy.rollbackEdit(workspaceId, transactionId) } catch { /* already committed or invalidated */ }
      }
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Create resource failed: {message}', { message }))
      return false
    } finally {
      set({ busy: false })
    }
  },

  applyResourceElementOptions: async (node, options) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return false
    set({ busy: true, error: undefined })
    let transactionId: string | undefined
    try {
      transactionId = (await window.dnSpy.beginEdit(workspaceId)).transactionId
      await window.dnSpy.setResourceElementOptions(workspaceId, transactionId, node.id, options)
      const committed = await window.dnSpy.commitEdit(workspaceId, transactionId)
      await refreshAfterEdit(get, set, committed)
      const parentId = get().parents[node.id]
      if (parentId)
        await refreshChildren(get, set, parentId)
      get().appendOutput(t('Edited resource element {name}.', { name: options.name }))
      return true
    } catch (error) {
      if (transactionId) {
        try { await window.dnSpy.rollbackEdit(workspaceId, transactionId) } catch { /* already committed or invalidated */ }
      }
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Resource element edit failed: {message}', { message }))
      return false
    } finally {
      set({ busy: false })
    }
  },

  createImageResources: async (resourceNode) => {
    const images = await window.dnSpy.pickImageFiles(true, true)
    if (images.length === 0)
      return false
    return get().createResourceElement(resourceNode, { kind: 'imageFiles', name: images.map((image) => image.name).join(', '), images })
  },
  createResourceElement: async (resourceNode, options) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return false
    set({ busy: true, error: undefined })
    let transactionId: string | undefined
    try {
      transactionId = (await window.dnSpy.beginEdit(workspaceId)).transactionId
      await window.dnSpy.createResourceElement(workspaceId, transactionId, resourceNode.id, options)
      const committed = await window.dnSpy.commitEdit(workspaceId, transactionId)
      await refreshAfterEdit(get, set, committed)
      await refreshChildren(get, set, resourceNode.id)
      get().appendOutput(t('Created resource element {name}.', { name: options.name }))
      return true
    } catch (error) {
      if (transactionId) {
        try { await window.dnSpy.rollbackEdit(workspaceId, transactionId) } catch { /* already committed or invalidated */ }
      }
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Create resource element failed: {message}', { message }))
      return false
    } finally {
      set({ busy: false })
    }
  },

  // dnSpy's File > Save Module...: the documents of the selected rows, the modified ones among them when any are,
  // and every one of them otherwise — the same command saves an unmodified module when it is asked to.
  saveModuleAs: async () => get().saveModule(),

  saveModule: async () => {
    const { workspaceId, selectedNodes, selectedNode, modifiedDocuments } = get()
    const module = currentModule(get())
    const nodeIds = selectedNodes.length > 0 ? selectedNodes.map((node) => node.id) : selectedNode ? [selectedNode.id] : module ? [module.id] : []
    if (!workspaceId || nodeIds.length === 0)
      return false
    const documents = await resolveSaveDocuments(get, set, nodeIds)
    if (documents === undefined)
      return false
    const modified = new Set(modifiedDocuments.map((document) => document.id))
    const chosen = documents.some((document) => modified.has(document.documentId)) ? documents.filter((document) => modified.has(document.documentId)) : documents
    return showSave(get, set, chosen)
  },

  // dnSpy's Save All: every modified document.
  saveAllModules: async () => {
    if (!get().workspaceId)
      return false
    await get().refreshModifiedDocuments()
    return get().requestSave(get().modifiedDocuments.map((document) => document.id))
  },

  // The documents a command is about to let go of, named by their files.
  saveModules: async (paths) => {
    if (!get().workspaceId)
      return false
    await get().refreshModifiedDocuments()
    const wanted = new Set(paths)
    return get().requestSave(get().modifiedDocuments.filter((document) => wanted.has(document.path)).map((document) => document.id))
  },

  requestSave: async (ids) => {
    if (!get().workspaceId || ids.length === 0)
      return true
    const documents = await resolveSaveDocuments(get, set, ids)
    return documents === undefined ? false : showSave(get, set, documents)
  },

  acceptSaveOptions: (options) => set((state) => state.saveRequest
    ? { saveRequest: { ...state.saveRequest, documents: [options], phase: 'run' } }
    : {}),

  finishSave: async (response) => {
    const request = get().saveRequest
    set({ saveRequest: undefined })
    if (!request)
      return
    let savedAll = false
    if (response) {
      for (const result of response.results) {
        if (result.saved)
          get().appendOutput(t('Saved {path} ({length} bytes, SHA-256 {sha256}).', { path: result.fileName, length: result.length.toLocaleString(getActiveLocale()), sha256: result.sha256 ?? '' }))
        else if (result.error)
          get().appendOutput(t('Save failed: {message}', { message: result.error }))
      }
      set({ modifiedDocuments: response.modifiedDocuments, dirty: response.modifiedDocuments.length > 0 })
      // A new document saved for the first time has a file now, and the module list and the root's label say so.
      if (response.modules) {
        const workspaceId = get().workspaceId
        const roots = workspaceId ? await window.dnSpy.getRoots(workspaceId) : undefined
        set({ modules: response.modules, ...(roots ? { roots: roots.nodes } : {}) })
      }
      savedAll = !response.canceled
        && response.results.length === request.documents.length
        && response.results.every((result) => result.saved)
    }
    saveResolvers.get(request.id)?.(savedAll)
    saveResolvers.delete(request.id)
  },

  refreshModifiedDocuments: async () => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return
    try {
      const modifiedDocuments = await window.dnSpy.getModifiedDocuments(workspaceId)
      if (get().workspaceId === workspaceId)
        set({ modifiedDocuments, dirty: modifiedDocuments.length > 0 })
    } catch {
      // A workspace that went away has nothing modified left to report.
    }
  },

  reloadAllAssemblies: async (autoLoadedPaths) => {
    const { workspaceId } = get()
    if (!workspaceId)
      return false
    set({ busy: true, error: undefined })
    try {
      const reloaded = await window.dnSpy.reloadWorkspace(workspaceId, autoLoadedPaths)
      const roots = await window.dnSpy.getRoots(workspaceId)
      // Every node id the workspace handed out is gone with the reload, so the tabs, the expanded
      // branches and the selection all name nodes that no longer exist and are dropped with them. The
      // workspace id survives, which is what lets the reload stay inside the same session.
      set((state) => ({
        modules: reloaded.modules,
        roots: roots.nodes,
        children: {},
        parents: {},
        expanded: {},
        loadingNodes: {},
        selectedNode: roots.nodes[0],
        selectedNodes: roots.nodes[0] ? [roots.nodes[0]] : [],
        documents: {},
        documentOrder: [],
        activeDocumentId: undefined,
        hexTarget: undefined,
        dirty: false,
        modifiedDocuments: [],
        workspaceStateId: reloaded.stateId,
        savedStateId: reloaded.stateId,
        canUndo: false,
        canRedo: false,
        assemblyListRevision: state.assemblyListRevision + 1,
      }))
      get().appendOutput(t('Reloaded {count} module(s).', { count: reloaded.modules.length }))
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Reload failed: {message}', { message }))
      return false
    } finally {
      set({ busy: false })
    }
  },

  sortAssemblies: async () => {
    const { workspaceId } = get()
    if (!workspaceId)
      return false
    try {
      const roots = await window.dnSpy.sortAssemblies(workspaceId)
      set({ roots: roots.nodes })
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Sort failed: {message}', { message }))
      return false
    }
  },

  removeModule: async (node) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return []
    try {
      const response = await window.dnSpy.removeModule(workspaceId, node.id)
      set((state) => ({ ...withoutRemovedRoots(state, response), assemblyListRevision: state.assemblyListRevision + 1 }))
      return response.removedNodeIds
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Remove failed: {message}', { message }))
      return []
    }
  },

  removeModules: async (nodeIds) => {
    const workspaceId = get().workspaceId
    if (!workspaceId || nodeIds.length === 0)
      return []
    try {
      const response = await window.dnSpy.removeModules(workspaceId, nodeIds)
      set((state) => ({ ...withoutRemovedRoots(state, response), assemblyListRevision: state.assemblyListRevision + 1 }))
      // A document that goes takes its unsaved changes with it.
      await get().refreshModifiedDocuments()
      return response.removedNodeIds
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Remove failed: {message}', { message }))
      return []
    }
  },

  getModifiedModules: async (nodeIds) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return []
    try {
      const response = await window.dnSpy.getModifiedModules(workspaceId, nodeIds)
      return response.paths
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      return []
    }
  },

  getCloseCandidates: async () => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return { frameworkNodeIds: [], missingNodeIds: [] }
    try {
      return await window.dnSpy.getCloseCandidates(workspaceId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      return { frameworkNodeIds: [], missingNodeIds: [] }
    }
  },

  moveRoots: async (nodeIds, index) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return []
    try {
      const response = await window.dnSpy.moveRoots(workspaceId, nodeIds, index)
      set({ roots: response.nodes, assemblyListRevision: get().assemblyListRevision + 1 })
      return response.nodes
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      return []
    }
  },

  activateNode: async (node) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return false
    try {
      const response = await window.dnSpy.activateNode(workspaceId, node.id)
      // Following the row may have opened the assembly its target lives in, which is a new root.
      if (response.rootsChanged)
        await get().refreshRoots()
      if (!response.nodeId)
        return false
      await get().revealNode(response.nodeId)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      return false
    }
  },

  dropFiles: async (paths, index, filter) => {
    if (paths.length === 0)
      return
    const generation = get().workspaceGeneration
    const workspaceId = get().workspaceId
    set({ busy: true, error: undefined })
    try {
      const response = await window.dnSpy.dropFiles(workspaceId ?? null, paths, index, filter)
      if (get().workspaceGeneration !== generation)
        return
      // A drop on an empty tree is what opens the workspace; one the filter turned away entirely opens none.
      const dropWorkspace = response.workspaceId ?? workspaceId
      if (!dropWorkspace)
        return
      const roots = await window.dnSpy.getRoots(dropWorkspace)
      if (get().workspaceGeneration !== generation)
        return
      const selected = roots.nodes.find((root) => root.id === response.selectNodeId)
      set((state) => ({
        workspaceId: dropWorkspace,
        modules: response.modules,
        roots: roots.nodes,
        selectedNode: selected ?? state.selectedNode,
        selectedNodes: selected ? [selected] : state.selectedNodes,
        ...(workspaceId ? {} : { workspaceStateId: response.stateId ?? undefined, savedStateId: response.stateId ?? undefined }),
        // dnSpy's OnDropFiles puts each file it added on the Recent Files list, and only those.
        recentFiles: response.addedPaths.length > 0 ? rememberRecentFiles(response.addedPaths) : state.recentFiles,
        assemblyListRevision: state.assemblyListRevision + 1,
      }))
      if (response.addedPaths.length > 0)
        get().appendOutput(t('Opened {count} module(s).', { count: response.addedPaths.length }))
    } catch (error) {
      if (get().workspaceGeneration !== generation)
        return
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Open failed: {message}', { message }))
    } finally {
      if (get().workspaceGeneration === generation)
        set({ busy: false })
    }
  },

  goToSpecialNode: async (node, kind) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return false
    try {
      const response = await window.dnSpy.getSpecialNode(workspaceId, node.id, kind)
      if (!response.nodeId)
        return false
      // dnSpy follows the member in the active tab, which brings the tree's selection along.
      await showOrReveal(get, response.nodeId)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      return false
    }
  },

  goToMetadataRecord: async (node, token) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return undefined
    try {
      const response = await window.dnSpy.findMetadataRecord(workspaceId, node.id, token)
      if (!response.nodeId)
        return response.error ?? t("Token {token} doesn't exist in the metadata", { token: (token >>> 0).toString(16).toUpperCase().padStart(8, '0') })
      await showOrReveal(get, response.nodeId)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  },

  goToToken: async (node, token) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return false
    const response = await window.dnSpy.findByToken(workspaceId, node.id, token)
    if (!response.nodeId)
      return false
    await showOrReveal(get, response.nodeId)
    return true
  },

  saveResource: async (nodes, raw, useSubDirs = false) => {
    const workspaceId = get().workspaceId
    if (!workspaceId || nodes.length === 0)
      return false
    try {
      const paths = await window.dnSpy.saveResource(workspaceId, nodes.map((node) => node.id), raw, useSubDirs)
      // A cancelled dialog is not a failure, and dnSpy says nothing about it either.
      if (paths.length === 0)
        return false
      for (const path of paths)
        get().appendOutput(t('Saved {name} to {path}.', { name: path.split(/[\\/]/).at(-1) ?? path, path }))
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Save failed: {message}', { message }))
      return false
    }
  },

  getResourceItemNames: async (nodeIds) => {
    const workspaceId = get().workspaceId
    if (!workspaceId || nodeIds.length === 0)
      return { names: [], rawNames: [] }
    try {
      return await window.dnSpy.getResourceItemNames(workspaceId, nodeIds)
    } catch {
      // The menu asks this of every resource it opens on; a node the backend has dropped since has nothing to save.
      return { names: [], rawNames: [] }
    }
  },

  goToResource: async (node) => {
    const resourceId = await get().findResource(node.id)
    if (!resourceId)
      return false
    await get().revealNode(resourceId)
    const resource = get().selectedNode
    if (resource?.id === resourceId)
      await get().openDocument(resource)
    return true
  },

  findResource: async (nodeId) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return null
    try {
      const response = await window.dnSpy.findResource(workspaceId, nodeId)
      return response.nodeId
    } catch {
      // The context menu asks this of every method it opens on; a node the backend has dropped since
      // simply reads no resource, which is no error worth a banner.
      return null
    }
  },

  /**
   * Turns an assembly into a net module — dnSpy's Convert Assembly to NetModule. The module's definition
   * survives; what goes is the assembly wrapping it, so this is a queued edit and Undo is the way back.
   * The row that named the assembly falls back to naming the file, which is why the roots are read again
   * rather than patched. The other direction is not offered by this port's tree: dnSpy shows it on a module
   * document standing on its own, and a module here always hangs off an assembly row.
   */
  convertModule: async (node, toAssembly = false) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return false
    set({ busy: true, error: undefined })
    let transactionId: string | undefined
    try {
      transactionId = (await window.dnSpy.beginEdit(workspaceId)).transactionId
      await window.dnSpy.convertModule(workspaceId, transactionId, node.id, toAssembly)
      const committed = await window.dnSpy.commitEdit(workspaceId, transactionId)
      await refreshAfterEdit(get, set, committed)
      get().appendOutput(t('Converted {name} to a net module.', { name: node.label }))
      return true
    } catch (error) {
      if (transactionId) {
        try { await window.dnSpy.rollbackEdit(workspaceId, transactionId) } catch { /* already committed or invalidated */ }
      }
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Convert failed: {message}', { message }))
      return false
    } finally {
      set({ busy: false })
    }
  },

  loadDependencies: async (node, recursive) => {
    const workspaceId = get().workspaceId
    if (!workspaceId)
      return false
    // Counted by difference because the response lists every module the workspace holds, not just the ones
    // that arrived, exactly as opening assemblies does.
    const previousModules = get().modules
    set({ busy: true, error: undefined })
    try {
      const added = await window.dnSpy.loadDependencies(workspaceId, node.id, recursive)
      const roots = await window.dnSpy.getRoots(workspaceId)
      set((state) => {
        const known = new Set(state.roots.map((root) => root.id))
        const newSelection = roots.nodes.find((root) => !known.has(root.id)) ?? state.selectedNode
        return {
          modules: added.modules,
          roots: roots.nodes,
          // The first root the tree did not have before is one of the assemblies that just arrived; when
          // nothing could be resolved the selection stays on the row the command was run on.
          selectedNode: newSelection,
          selectedNodes: newSelection ? [newSelection] : state.selectedNodes,
          assemblyListRevision: state.assemblyListRevision + 1,
        }
      })
      const count = added.modules.length - previousModules.length
      if (count > 0)
        get().appendOutput(t('Loaded {count} dependency module(s).', { count }))
      else
        get().appendOutput(t('No dependencies were found for {name}.', { name: node.label }))
      return count > 0
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Load failed: {message}', { message }))
      return false
    } finally {
      set({ busy: false })
    }
  },

  refreshRoots: async () => {
    const { workspaceId, workspaceGeneration } = get()
    if (!workspaceId)
      return
    try {
      const roots = await window.dnSpy.getRoots(workspaceId)
      // The workspace may have been replaced while the roots were on the way, and those roots belong to
      // the one that is gone.
      if (get().workspaceGeneration !== workspaceGeneration)
        return
      set({ roots: roots.nodes })
    } catch {
      // A read of a workspace that has closed under the call needs no reporting; the tree it belonged to
      // is already gone.
    }
  },

  openReferenceTarget: async (target, newTab = false) => {
    // dnSpy's two follow commands differ only in where the target goes: a plain follow reuses the tab
    // the target already has, while Follow Reference in New Tab always gives it one of its own. Which
    // callback the shell registered is the whole of the difference.
    const open = newTab ? get().openNodeInNewTabById : get().openNodeById
    if (!open)
      return
    try {
      const nodeId = await get().resolveReferenceTarget(target)
      if (nodeId)
        await open(nodeId)
    } catch (reason) {
      get().appendOutput(t('Navigation failed: {message}', { message: reason instanceof Error ? reason.message : String(reason) }))
    }
  },

  resolveReferenceTarget: async (target) => {
    if (target.targetNodeId)
      return target.targetNodeId
    // Inside the workspace a span carries the node itself. A reference into a module the workspace does
    // not hold carries the file and token it has there instead: asking the backend for that pair opens
    // the module on demand, which is how dnSpy follows a reference into an assembly the tree does not
    // have. Opening one adds a root, so the tree is read again — and read first, so the root is there
    // by the time the caller acts on the node.
    const workspaceId = get().workspaceId
    if (!workspaceId || !target.targetModulePath || target.targetMetadataToken === undefined)
      return undefined
    const found = await window.dnSpy.findMember(workspaceId, target.targetModulePath, target.targetMetadataToken)
    if (!found.nodeId)
      throw new Error(target.targetModulePath)
    await get().refreshRoots()
    return found.nodeId
  },

  saveCode: async (documentId) => {
    const { busy, documents } = get()
    const document = documents[documentId]
    if (busy || !document || document.loading)
      return false
    set({ busy: true, error: undefined })
    try {
      const savedPath = await window.dnSpy.saveCode(suggestCodeFilename(document.title, document.language), document.text)
      if (!savedPath)
        return false
      get().appendOutput(t('Saved code to {path}.', { path: savedPath }))
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ error: message })
      get().appendOutput(t('Save code failed: {message}', { message }))
      return false
    } finally {
      set({ busy: false })
    }
  },

  methodBodyChanged: async (node, result) => {
    set((state) => ({
      ...modifiedFrom(result, state),
      workspaceStateId: result.stateId,
      canUndo: result.canUndo,
      canRedo: result.canRedo,
    }))
    if (get().documents[node.id])
      await get().openDocument(node, 'il')
    get().appendOutput(t('Updated IL body for {name}.', { name: node.label }))
  },

  undoEdit: async () => {
    const workspaceId = get().workspaceId
    if (!workspaceId || !get().canUndo) return []
    try {
      const result = await window.dnSpy.undoEdit(workspaceId)
      const removed = await refreshAfterEdit(get, set, result)
      get().appendOutput(t('Undo completed.'))
      return removed
    } catch (error) {
      get().appendOutput(t('Undo failed: {message}', { message: error instanceof Error ? error.message : String(error) }))
      return []
    }
  },

  redoEdit: async () => {
    const workspaceId = get().workspaceId
    if (!workspaceId || !get().canRedo) return []
    try {
      const result = await window.dnSpy.redoEdit(workspaceId)
      const removed = await refreshAfterEdit(get, set, result)
      get().appendOutput(t('Redo completed.'))
      return removed
    } catch (error) {
      get().appendOutput(t('Redo failed: {message}', { message: error instanceof Error ? error.message : String(error) }))
      return []
    }
  },

  defaultDebugTarget: () => {
    const { modules, selectedNode, parents } = get()
    // A module node carries its own path; anything else walks up the parents chain to the module it belongs
    // to, which is the closest the tree gets to upstream's "debug the current document".
    let nodeId = selectedNode?.id
    const visited = new Set<string>()
    while (nodeId && !visited.has(nodeId)) {
      visited.add(nodeId)
      const path = modules.find((module) => module.id === nodeId)?.path
      if (path) return path
      nodeId = parents[nodeId]
    }
    return modules[0]?.path
  },

  launchDebug: async (options) => {
    if (!options.program) return
    lastLaunchOptions = options
    // OutputLogger, as the debugger starts: the Debug pane is emptied and shown.
    set({ debugState: 'starting', error: undefined, debugOutput: [], outputPane: 'debug' })
    let sessionId: string | undefined
    try {
      await pushDebuggerOptions()
      // The workspace id travels with the launch: it is how the engine turns a decompiled line into an IL offset.
      const started = await window.dnSpy.launchDebug({ ...options, workspaceId: get().workspaceId })
      sessionId = started.sessionId
      set({ debugSessionId: sessionId, debugCapabilities: started.capabilities })
      const breakpointRequests = enabledFunctionBreakpointRequests(get().functionBreakpoints)
      if (breakpointRequests.length > 0)
        await window.dnSpy.setFunctionBreakpoints(sessionId, breakpointRequests)
      if (get().lineBreakpoints.length > 0)
        await syncLineBreakpoints(get, set)
      await syncModuleBreakpoints(get)
      // The exception list lives in the engine rather than in the session, and it outlives every
      // session, so the stored diff goes back in before the debuggee is released: a run started
      // without the Exception Settings window ever being opened still honors what it holds.
      await get().loadExceptionSettings()
      // A launch that does not break during startup is held by the engine until this lands: the
      // debuggee would otherwise run to completion in the time the launch request alone takes.
      await window.dnSpy.configurationDone(sessionId)
      get().appendOutput(t('Started debugging {target}.', { target: options.program }), 'debug')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A launch that was never released would sit suspended forever, so a failure here stops the
      // session rather than leaving the debuggee behind.
      if (sessionId) await get().stopDebug()
      set({ debugState: 'inactive', error: message })
      get().appendOutput(t('Debug launch failed: {message}', { message }), 'debug')
    }
  },

  attachDebug: async (processId) => {
    // OutputLogger, as the debugger starts: the Debug pane is emptied and shown.
    set({ debugState: 'starting', error: undefined, debugOutput: [], outputPane: 'debug' })
    try {
      await pushDebuggerOptions()
      const started = await window.dnSpy.attachDebug(processId, get().workspaceId)
      set({ debugSessionId: started.sessionId, debugCapabilities: started.capabilities })
      if (get().lineBreakpoints.length > 0)
        await syncLineBreakpoints(get, set)
      await syncModuleBreakpoints(get)
      await get().loadExceptionSettings()
      get().appendOutput(t('Attached to process {processId}.', { processId }), 'debug')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ debugState: 'inactive', error: message })
      get().appendOutput(t('Debug attach failed: {message}', { message }), 'debug')
    }
  },

  handleDebugEvent: async (event) => {
    if (event.event === 'stopped') {
      const threadId = typeof event.body?.threadId === 'number' ? event.body.threadId : undefined
      set({
        debugSessionId: event.sessionId,
        debugState: 'starting',
        selectedDebugThreadId: threadId,
        stoppedReason: typeof event.body?.reason === 'string' ? event.body.reason : 'stopped',
      })
      const reason = typeof event.body?.reason === 'string' ? event.body.reason : 'unknown'
      // An exception stop carries what was thrown, which is the one thing the Output window has to
      // say beyond "stopped": the reason alone does not name the type.
      const exceptionName = typeof event.body?.exceptionName === 'string' ? event.body.exceptionName : undefined
      const exceptionModule = typeof event.body?.exceptionModule === 'string' ? event.body.exceptionModule : undefined
      if (exceptionName)
        get().appendOutput(exceptionModule
          ? t('Exception thrown: {name} in {module}.', { name: exceptionName, module: exceptionModule })
          : t('Exception thrown: {name}.', { name: exceptionName }), 'debug')
      get().appendOutput(t('Debugger stopped: {reason}.', { reason: t(reason) }), 'debug')
      // DebuggerSettings.FocusDebuggerWhenProcessBreaks: the window comes to the front on a break.
      if (loadAppOptions().debugger.focusDebuggerWhenProcessBreaks)
        void window.dnSpy.bringWindowToFront?.().catch(() => undefined)
      await refreshDebugState(get, set, threadId)
      set({ debugState: 'stopped' })
      await get().revealStoppedLocation()
    } else if (event.event === 'breakpoint') {
      // The engine binds late — a module loads, or it refuses an offset we thought was good — so a breakpoint's
      // state can change without the client asking. This is the channel that keeps the gutter honest.
      const body = event.body?.breakpoint as DebugBreakpoint | undefined
      if (body?.id)
        set((state) => ({
          lineBreakpoints: state.lineBreakpoints.map((breakpoint) => breakpoint.id === body.id ? applyBreakpointResult(breakpoint, body) : breakpoint),
        }))
    } else if (event.event === 'continued') {
      set({ debugState: 'running', debugFrames: [], debugVariables: [], watchValues: [], otherWatchValues: {}, stoppedLocation: undefined, selectedDebugFrameId: undefined, activeDebugFrameId: undefined })
    } else if (event.event === 'output') {
      const output = typeof event.body?.output === 'string' ? event.body.output.trimEnd() : ''
      if (output) get().appendOutput(output, 'debug')
    } else if (event.event === 'exception') {
      // OutputLogger's exception messages: every first chance the engine reports, and the unhandled one.
      const body = event.body ?? {}
      const name = typeof body.name === 'string' ? body.name : '?'
      const module = typeof body.module === 'string' ? body.module : '?'
      const message = typeof body.message === 'string' ? body.message : undefined
      if (body.unhandled === true)
        get().appendOutput(t('An unhandled exception of type \'{name}\' occurred in {module}', { name, module }), 'debug')
      else
        get().appendOutput(t('Exception thrown: \'{name}\' in {module}', { name, module }), 'debug')
      if (message)
        get().appendOutput(t('Additional information: {message}', { message }), 'debug')
    } else if (event.event === 'module') {
      const module = event.body?.module as DebugModule | undefined
      if (!module) return
      const process = get().debugProcess?.name ?? ''
      const domain = module.appDomainName ?? 'clrhost'
      const prefix = `'${process}' (CoreCLR: ${domain}): `
      if (event.body?.reason === 'removed') {
        set((state) => ({ debugModules: state.debugModules.filter((candidate) => candidate.id !== module.id) }))
        get().appendOutput(prefix + t('Unloaded \'{path}\'.', { path: module.path ?? module.name }), 'debug')
      } else {
        set((state) => ({ debugModules: [...state.debugModules.filter((candidate) => candidate.id !== module.id), module].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) }))
        get().appendOutput(prefix + t('Loaded \'{path}\'.', { path: module.path ?? module.name }), 'debug')
      }
    } else if (event.event === 'thread') {
      // OutputLogger's DebugLogExitThread.
      if (event.body?.reason === 'exited' && typeof event.body.threadId === 'number') {
        const code = typeof event.body.exitCode === 'number' ? event.body.exitCode : 0
        get().appendOutput(t('The thread 0x{id} has exited with code {code} (0x{hex}).', { id: event.body.threadId.toString(16), code, hex: (code >>> 0).toString(16) }), 'debug')
      }
      if (get().debugState === 'stopped' && get().debugSessionId)
        set({ debugThreads: await window.dnSpy.getDebugThreads(get().debugSessionId!).catch(() => get().debugThreads) })
    } else if (event.event === 'process') {
      if (get().debugSessionId)
        set({ debugProcess: await window.dnSpy.getDebugProcess?.(get().debugSessionId!).catch(() => get().debugProcess) })
    } else if (event.event === 'terminated' || event.event === 'exited') {
      const processName = get().debugProcess?.name
      set({
        debugState: 'inactive',
        debugSessionId: undefined,
        debugThreads: [],
        debugFrames: [],
        debugVariables: [],
        debugModules: [],
        watchValues: [],
        otherWatchValues: {},
        debugProcess: undefined,
        stoppedLocation: undefined,
        selectedDebugFrameId: undefined,
        activeDebugFrameId: undefined,
      })
      // OutputLogger's DebugLogExitProcess: "The program '[pid] name' has exited with code N (0xN)."
      const code = typeof event.body?.exitCode === 'number' ? event.body.exitCode : undefined
      get().appendOutput(event.event === 'exited'
        ? code !== undefined && processName
          ? t('The program \'{name}\' has exited with code {code} (0x{hex}).', { name: processName, code, hex: (code >>> 0).toString(16) })
          : t('Debug target exited with code {code}.', { code: String(event.body?.exitCode ?? '') })
        : t('Debug session terminated.'), 'debug')
    }
  },

  continueDebug: async () => {
    const { debugSessionId, selectedDebugThreadId } = get()
    if (!debugSessionId || selectedDebugThreadId === undefined) return
    await window.dnSpy.debugContinue(debugSessionId, selectedDebugThreadId)
    set({ debugState: 'running', debugFrames: [], debugVariables: [], watchValues: [], otherWatchValues: {}, stoppedLocation: undefined, selectedDebugFrameId: undefined, activeDebugFrameId: undefined })
  },

  pauseDebug: async () => {
    const { debugSessionId, selectedDebugThreadId } = get()
    if (!debugSessionId || selectedDebugThreadId === undefined) return
    await window.dnSpy.debugPause(debugSessionId, selectedDebugThreadId)
  },

  stepDebug: async (kind) => {
    const { debugSessionId, selectedDebugThreadId } = get()
    if (!debugSessionId || selectedDebugThreadId === undefined) return
    const command = kind === 'next' ? window.dnSpy.debugNext : kind === 'stepIn' ? window.dnSpy.debugStepIn : window.dnSpy.debugStepOut
    await command(debugSessionId, selectedDebugThreadId)
    set({ debugState: 'running', debugFrames: [], debugVariables: [], watchValues: [], otherWatchValues: {}, stoppedLocation: undefined, selectedDebugFrameId: undefined, activeDebugFrameId: undefined })
  },

  // dnSpy's Stop Debugging is DbgManager.StopDebuggingAll: a process the debugger started is terminated, one it
  // attached to is detached from, and keeps running.
  stopDebug: async () => {
    await endDebugSession(get, set, get().debugProcess?.ownsDebuggee !== false)
  },

  restartDebug: async () => {
    const options = lastLaunchOptions
    if (!options || get().debugProcess?.ownsDebuggee === false) return
    await endDebugSession(get, set, true)
    await get().launchDebug(options)
  },

  detachDebug: async () => {
    await endDebugSession(get, set, false)
  },

  terminateDebug: async () => {
    await endDebugSession(get, set, true)
  },

  // Highlighting a row costs nothing else: the frame the debugger reads only changes when the user
  // switches to one, which is the double click the Call Stack pane sends to SwitchToFrame.
  selectDebugFrame: async (frameId) => {
    set({ selectedDebugFrameId: frameId })
  },

  switchToDebugFrame: async (frameId) => {
    // dnSpy's SwitchToFrame: the frame becomes the active one, so Locals and Watch read it and the
    // editor follows the statement it is stopped at.
    set({ selectedDebugFrameId: frameId, activeDebugFrameId: frameId })
    // A deep frame comes without its line — the stack only resolves the frames near the top — so the engine is
    // asked for it now, when the user goes there.
    const frame = get().debugFrames.find((candidate) => candidate.id === frameId)
    const sessionId = get().debugSessionId
    if (frame && frame.locationResolved === false && sessionId) {
      try {
        const location = await window.dnSpy.getDebugFrameLocation(sessionId, frameId)
        set((state) => ({
          debugFrames: state.debugFrames.map((candidate) => candidate.id === frameId
            ? { ...candidate, line: location.line, column: location.column, nodeId: location.nodeId ?? undefined, description: location.description, locationResolved: true }
            : candidate),
        }))
      } catch {
        // The frame keeps no line; the switch still happens.
      }
    }
    await refreshDebugVariables(get, set, frameId)
    await get().revealStoppedLocation({ caret: true })
  },

  revealStoppedLocation: async (options) => {
    let { debugFrames, activeDebugFrameId } = get()
    let frame = debugFrames.find((candidate) => candidate.id === activeDebugFrameId) ?? debugFrames[0]
    // A stop in a module the workspace does not hold has neither a line nor a document: the engine only
    // resolves a frame against a module the workspace has. dnSpy loads the document when the debugger
    // stops at it, so the module is opened now — once per path — and the stack is read again, because
    // that read is what turns the frame into a line. Stepping into the framework looks like it did
    // nothing without this: the stop happens, and the editor has nowhere to show it.
    if (frame && frame.line <= 0 && frame.source?.path &&
      await openDebugModule(get, set, frame.source.path, frame.source.name ?? frame.source.path)) {
      debugFrames = get().debugFrames
      frame = debugFrames.find((candidate) => candidate.id === frame!.id) ?? debugFrames[0]
    }
    // A frame the decompiler could not place has no line to mark. Clearing the marker is what keeps a
    // highlight from a finished stop lingering over the next one.
    if (!frame || frame.line <= 0 || !frame.nodeId) {
      set({ stoppedLocation: undefined })
      return
    }
    set({
      stoppedLocation: {
        nodeId: frame.nodeId,
        line: frame.line,
        column: frame.column,
        name: frame.name,
        token: ++stoppedRevealToken,
        caret: options?.caret,
      },
    })
    // Only decompile when the document is not already showing this source: the engine resolves a
    // frame against the C# method document, so a doc open in IL is not the one the line belongs to.
    const node = findNode(get(), frame.nodeId)
    if (node && get().workspaceId && get().documents[frame.nodeId]?.language !== 'csharp')
      await get().openDocument(node, 'cSharp')
    // Filling in the store is not showing anything: the document only becomes visible when the shell
    // brings its tab forward, which is also what opens one for a method the user never visited.
    await get().revealDocument?.(frame.nodeId)
  },

  selectDebugThread: async (threadId) => {
    set({ selectedDebugThreadId: threadId })
    await refreshDebugState(get, set, threadId)
  },

  addWatch: async (expression, window = 1) => {
    const trimmed = expression.trim()
    if (!trimmed || watchList(get(), window).includes(trimmed)) return
    set((state) => withWatchList(state, window, [...watchList(state, window), trimmed]))
    await refreshWatches(get, set)
  },

  removeWatch: (expression, window = 1) => set((state) => ({
    ...withWatchList(state, window, watchList(state, window).filter((watch) => watch !== expression)),
    ...withWatchValues(state, window, watchValueList(state, window).filter((watch) => watch.name !== expression)),
  })),

  editWatch: async (expression, replacement, window = 1) => {
    const trimmed = replacement.trim()
    if (!trimmed) {
      get().removeWatch(expression, window)
      return
    }
    set((state) => withWatchList(state, window, watchList(state, window).map((watch) => watch === expression ? trimmed : watch).filter((watch, index, all) => all.indexOf(watch) === index)))
    await refreshWatches(get, set)
  },

  clearWatches: (window = 1) => set((state) => ({ ...withWatchList(state, window, []), ...withWatchValues(state, window, []) })),

  applyDebuggerOptions: async () => {
    await pushDebuggerOptions()
    if (get().debugState === 'stopped' && get().debugSessionId) {
      const { selectedDebugThreadId, activeDebugFrameId } = get()
      await refreshDebugState(get, set, selectedDebugThreadId, { keepFrame: activeDebugFrameId })
    }
  },

  setDebugValue: async (expression, value) => {
    const { debugSessionId, activeDebugFrameId } = get()
    if (!debugSessionId || activeDebugFrameId === undefined) return t('The process is not paused.')
    try {
      const result = await window.dnSpy.setDebugExpression(debugSessionId, activeDebugFrameId, expression, value)
      // Writing one value can change any other — a field two rows share, a property computed from it — so the
      // windows read the frame again, as dnSpy's value nodes all refresh after an edit.
      await refreshDebugVariables(get, set, activeDebugFrameId)
      return result?.error ?? undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  },

  makeDebugObjectId: async (expression) => {
    const { debugSessionId, activeDebugFrameId } = get()
    if (!debugSessionId || activeDebugFrameId === undefined) return
    try {
      await window.dnSpy.makeDebugObjectId(debugSessionId, activeDebugFrameId, expression)
      await refreshDebugVariables(get, set, activeDebugFrameId)
    } catch (error) {
      get().appendOutput(error instanceof Error ? error.message : String(error), 'debug')
    }
  },

  deleteDebugObjectId: async (id) => {
    const { debugSessionId, activeDebugFrameId } = get()
    if (!debugSessionId) return
    await window.dnSpy.deleteDebugObjectId(debugSessionId, id).catch(() => undefined)
    if (activeDebugFrameId !== undefined)
      await refreshDebugVariables(get, set, activeDebugFrameId)
  },

  setNextStatement: async () => {
    const { debugSessionId, selectedDebugThreadId, codeCaret, documents } = get()
    if (!debugSessionId || selectedDebugThreadId === undefined || !codeCaret || get().debugState !== 'stopped') return
    const statement = codeStatementAt(documents[codeCaret.documentId]?.codeStatements, codeCaret.line, codeCaret.column)
    try {
      // The statement the editor already resolved names its IL; the engine snaps a bare line itself.
      await window.dnSpy.setNextStatement(debugSessionId, selectedDebugThreadId, statement
        ? { modulePath: statement.modulePath, metadataToken: statement.metadataToken, ilOffset: statement.ilOffset }
        : { nodeId: codeCaret.documentId, line: codeCaret.line, column: codeCaret.column })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      get().appendOutput(t('Could not set the next statement: {message}', { message }), 'debug')
      await window.dnSpy.showMessage?.(message)
    }
  },

  runToCursor: async (frameId) => {
    const { debugSessionId, codeCaret, documents } = get()
    if (!debugSessionId || get().debugState !== 'stopped') return
    try {
      if (frameId !== undefined) {
        await window.dnSpy.runToDebugFrame(debugSessionId, frameId)
      } else {
        if (!codeCaret) return
        // dnSpy's Run to Cursor from the editor: a temporary breakpoint at the caret's statement, then Continue.
        const statement = codeStatementAt(documents[codeCaret.documentId]?.codeStatements, codeCaret.line, codeCaret.column)
        await window.dnSpy.runToDebugCursor(debugSessionId, statement
          ? { modulePath: statement.modulePath, metadataToken: statement.metadataToken, ilOffset: statement.ilOffset }
          : { nodeId: codeCaret.documentId, line: codeCaret.line, column: codeCaret.column })
      }
      set({ debugState: 'running', debugFrames: [], debugVariables: [], watchValues: [], otherWatchValues: {}, stoppedLocation: undefined, selectedDebugFrameId: undefined, activeDebugFrameId: undefined })
    } catch (error) {
      get().appendOutput(error instanceof Error ? error.message : String(error), 'debug')
    }
  },

  addModuleBreakpoint: async (breakpoint) => {
    const row: ModuleBreakpoint = { id: `module-bp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, enabled: true, moduleName: '', ...breakpoint }
    set((state) => ({ moduleBreakpoints: [...state.moduleBreakpoints, row] }))
    await syncModuleBreakpoints(get)
  },

  updateModuleBreakpoint: async (id, change) => {
    set((state) => ({ moduleBreakpoints: state.moduleBreakpoints.map((row) => row.id === id ? { ...row, ...change, id } : row) }))
    await syncModuleBreakpoints(get)
  },

  removeModuleBreakpoints: async (ids) => {
    set((state) => ({ moduleBreakpoints: state.moduleBreakpoints.filter((row) => !ids.includes(row.id)) }))
    await syncModuleBreakpoints(get)
  },

  freezeDebugThreads: async (threadIds, freeze) => {
    const sessionId = get().debugSessionId
    if (!sessionId) return
    await window.dnSpy.freezeDebugThreads(sessionId, threadIds, freeze)
    set({ debugThreads: await window.dnSpy.getDebugThreads(sessionId) })
  },

  renameDebugThread: async (threadId, name) => {
    const sessionId = get().debugSessionId
    if (!sessionId) return
    await window.dnSpy.renameDebugThread(sessionId, threadId, name)
    set({ debugThreads: await window.dnSpy.getDebugThreads(sessionId) })
  },

  addFunctionBreakpoint: async (name) => {
    const trimmed = name.trim()
    if (!trimmed || get().functionBreakpoints.some((breakpoint) => breakpoint.name === trimmed)) return
    set((state) => ({ functionBreakpoints: [...state.functionBreakpoints, { name: trimmed, enabled: true }] }))
    await syncFunctionBreakpoints(get)
  },

  removeFunctionBreakpoint: async (name) => {
    set((state) => ({ functionBreakpoints: state.functionBreakpoints.filter((breakpoint) => breakpoint.name !== name) }))
    await syncFunctionBreakpoints(get)
  },

  toggleFunctionBreakpoint: async (name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    if (get().functionBreakpoints.some((breakpoint) => breakpoint.name === trimmed))
      await get().removeFunctionBreakpoint(trimmed)
    else
      await get().addFunctionBreakpoint(trimmed)
  },

  // dnSpy's Add Class Breakpoint puts a breakpoint at the entry of every method the type owns, skipping
  // the ones that already carry one. This port's breakpoints are function breakpoints — matched by name —
  // so the methods come from the tree row rather than from the type directly, and a method with no body
  // simply never matches at launch, which is the same outcome as dnSpy's `IsAbstract || Body is null` skip.
  addClassBreakpoint: async (node, settings) => {
    await get().loadChildren(node)
    const members = get().children[node.id] ?? []
    // `type.Methods` is what dnSpy walks, and that holds a property's getter and setter too — the rows
    // the tree nests under the property, which is why the members below them are read as well.
    const accessorOwners = members.filter((member) => member.kind === 'property' || member.kind === 'event')
    for (const owner of accessorOwners)
      await get().loadChildren(owner)
    const methods = [
      ...members,
      ...accessorOwners.flatMap((owner) => get().children[owner.id] ?? []),
    ].filter((member) => member.kind === 'method')
    // A method name here is the declaring type plus the method, with no parameter list, so two overloads
    // answer to the same breakpoint; the engine breaks in whichever of them it binds the name to.
    const seen = new Set(get().functionBreakpoints.map((breakpoint) => breakpoint.name))
    const names: string[] = []
    for (const method of methods) {
      const name = methodBreakpointName(method.description)
      if (name === undefined || seen.has(name))
        continue
      seen.add(name)
      names.push(name)
    }
    if (names.length === 0) {
      get().appendOutput(t('{name} has no method left to break on.', { name: node.label }))
      return
    }
    const normalized = normalizeBreakpointSettings(settings)
    set((state) => ({ functionBreakpoints: [...state.functionBreakpoints, ...names.map((name) => ({ name, enabled: true, ...(normalized ? { settings: normalized } : {}) }))] }))
    await syncFunctionBreakpoints(get)
    get().appendOutput(t('Added {count} breakpoint(s) for {name}.', { count: names.length, name: node.label }))
  },

  // dnSpy's MethodBreakpointsService.Add, which every "Add Method Breakpoint" runs — the tree's, the code
  // viewer's, the analyzer's and the search window's: the methods a property or an event stands for are its
  // accessors, the rows the tree nests under it, and a method that already has a breakpoint keeps the one it
  // has rather than losing it, the way dnSpy skips an existing location.
  addMethodBreakpoints: async (targets) => {
    const candidates: (string | undefined)[] = []
    for (const target of targets) {
      if (typeof target === 'string')
        candidates.push(target)
      else if (target.kind === 'method')
        candidates.push(methodBreakpointName(target.description))
      else if (target.kind === 'property' || target.kind === 'event') {
        await get().loadChildren(target)
        for (const child of get().children[target.id] ?? []) {
          if (child.kind === 'method')
            candidates.push(methodBreakpointName(child.description))
        }
      }
    }
    const seen = new Set(get().functionBreakpoints.map((breakpoint) => breakpoint.name))
    const names: string[] = []
    for (const name of candidates) {
      if (name === undefined || seen.has(name))
        continue
      seen.add(name)
      names.push(name)
    }
    if (names.length === 0)
      return
    set((state) => ({ functionBreakpoints: [...state.functionBreakpoints, ...names.map((name) => ({ name, enabled: true }))] }))
    await syncFunctionBreakpoints(get)
  },

  setFunctionBreakpointEnabled: async (name, enabled) => {
    if (!get().functionBreakpoints.some((breakpoint) => breakpoint.name === name && breakpoint.enabled !== enabled)) return
    set((state) => ({
      functionBreakpoints: state.functionBreakpoints.map((breakpoint) => breakpoint.name === name ? { ...breakpoint, enabled } : breakpoint),
    }))
    await syncFunctionBreakpoints(get)
  },

  setFunctionBreakpointSettings: async (name, settings) => {
    const normalized = normalizeBreakpointSettings(settings)
    if (!get().functionBreakpoints.some((breakpoint) => breakpoint.name === name)) return
    set((state) => ({
      functionBreakpoints: state.functionBreakpoints.map((breakpoint) => breakpoint.name === name ? { ...breakpoint, settings: normalized } : breakpoint),
    }))
    await syncFunctionBreakpoints(get)
  },

  deleteAllFunctionBreakpoints: async () => {    if (get().functionBreakpoints.length === 0) return
    set({ functionBreakpoints: [] })
    await syncFunctionBreakpoints(get)
  },

  setAllFunctionBreakpointsEnabled: async (enabled) => {
    if (!get().functionBreakpoints.some((breakpoint) => breakpoint.enabled !== enabled)) return
    set((state) => ({ functionBreakpoints: state.functionBreakpoints.map((breakpoint) => ({ ...breakpoint, enabled })) }))
    await syncFunctionBreakpoints(get)
  },

  toggleLineBreakpoint: async (nodeId, line, column) => {
    const statement = codeStatementAt(breakpointStatementsOf(get().documents[nodeId]), line, column)
    // The document already carries the IL range of every statement, so the identity is known before the backend
    // confirms it — which is what lets a second click on the snapped line remove the breakpoint it just created.
    const identity = statement
      ? statementIdentity(statement.modulePath, statement.metadataToken, statement.ilOffset)
      : `${nodeId}|${line}`
    const existing = get().lineBreakpoints.find((breakpoint) => breakpoint.identity === identity)
    if (existing) {
      set((state) => ({ lineBreakpoints: state.lineBreakpoints.filter((breakpoint) => breakpoint.id !== existing.id) }))
    } else {
      set((state) => ({
        lineBreakpoints: [...state.lineBreakpoints, {
          id: `line${++lineBreakpointSequence}`,
          nodeId,
          identity,
          requestedLine: line,
          line: statement?.startLine ?? line,
          endLine: statement?.endLine ?? line,
          state: 'pending',
          enabled: true,
          description: statement?.description,
          modulePath: statement?.modulePath,
          metadataToken: statement?.metadataToken,
          sourceMethodToken: statement?.sourceMethodToken,
          ilOffset: statement?.ilOffset,
        }],
      }))
    }
    await syncLineBreakpoints(get, set)
  },

  removeLineBreakpoint: async (id) => {
    if (!get().lineBreakpoints.some((breakpoint) => breakpoint.id === id)) return
    set((state) => ({ lineBreakpoints: state.lineBreakpoints.filter((breakpoint) => breakpoint.id !== id) }))
    await syncLineBreakpoints(get, set)
  },

  setLineBreakpointEnabled: async (id, enabled) => {
    if (!get().lineBreakpoints.some((breakpoint) => breakpoint.id === id && breakpoint.enabled !== enabled)) return
    set((state) => ({
      lineBreakpoints: state.lineBreakpoints.map((breakpoint) => breakpoint.id === id ? { ...breakpoint, enabled } : breakpoint),
    }))
    await syncLineBreakpoints(get, set)
  },

  setLineBreakpointSettings: async (id, settings) => {
    const normalized = normalizeBreakpointSettings(settings)
    if (!get().lineBreakpoints.some((breakpoint) => breakpoint.id === id)) return
    set((state) => ({
      lineBreakpoints: state.lineBreakpoints.map((breakpoint) => breakpoint.id === id ? { ...breakpoint, settings: normalized } : breakpoint),
    }))
    await syncLineBreakpoints(get, set)
  },

  deleteAllBreakpoints: async () => {    if (get().lineBreakpoints.length === 0 && get().functionBreakpoints.length === 0) return
    set({ lineBreakpoints: [], functionBreakpoints: [] })
    await Promise.all([syncLineBreakpoints(get, set), syncFunctionBreakpoints(get)])
  },

  importBreakpoints: async (stored) => {
    // Importing adds to what is already there, the way dnSpy's bookmark import does: an entry already
    // present — same IL location, same method name — is skipped rather than duplicated.
    const knownLines = new Set(get().lineBreakpoints.map((breakpoint) => breakpoint.identity))
    const imported: LineBreakpoint[] = []
    for (const entry of stored.breakpoints ?? []) {
      const breakpoint = lineBreakpointFromEntry(entry)
      if (knownLines.has(breakpoint.identity)) continue
      knownLines.add(breakpoint.identity)
      imported.push(breakpoint)
    }
    const knownFunctions = new Set(get().functionBreakpoints.map((breakpoint) => breakpoint.name))
    const functions = (stored.functions ?? []).filter((breakpoint) => !knownFunctions.has(breakpoint.name))
    if (imported.length === 0 && functions.length === 0)
      return 0
    set((state) => ({
      lineBreakpoints: [...state.lineBreakpoints, ...imported],
      functionBreakpoints: [...state.functionBreakpoints, ...functions],
    }))
    await Promise.all([syncLineBreakpoints(get, set), syncFunctionBreakpoints(get)])
    return imported.length + functions.length
  },

  setAllLineBreakpointsEnabled: async (enabled) => {
    if (!get().lineBreakpoints.some((breakpoint) => breakpoint.enabled !== enabled)) return
    set((state) => ({ lineBreakpoints: state.lineBreakpoints.map((breakpoint) => ({ ...breakpoint, enabled })) }))
    await syncLineBreakpoints(get, set)
  },

  setOpenNodeById: (open) => set({ openNodeById: open }),
  setOpenNodeInNewTabById: (open) => set({ openNodeInNewTabById: open }),
  setRevealDocument: (open) => set({ revealDocument: open }),
  setOpenToolWindow: (open) => set({ openToolWindow: open }),

  setDocumentOrder: (order, active) => set((state) => (
    order.length === state.documentOrder.length && order.every((id, index) => id === state.documentOrder[index]) && active === state.activeDocumentId
      ? state
      : { documentOrder: order, activeDocumentId: active }
  )),

  setRestoringSession: (value) => set({ restoringSession: value }),

  setDefaultLanguage: (language) => {
    if (typeof localStorage !== 'undefined')
      localStorage.setItem(decompilerLanguageStorageKey, language)
    set({ defaultLanguage: language })
  },

  toggleBookmark: (nodeId, line) => {
    // dnSpy names the bookmark after what the line holds — the statement on it, or the definition that
    // starts there (or after it) — so a second toggle on the line where the marker is drawn finds it again.
    const place = bookmarkPlaceAt(nodeId, get().documents[nodeId], line)
    if (!place)
      return
    const existing = get().bookmarks.find((bookmark) => bookmark.identity === place.identity)
    if (existing) {
      set((state) => ({
        bookmarks: state.bookmarks.filter((bookmark) => bookmark.id !== existing.id),
        activeBookmarkId: state.activeBookmarkId === existing.id ? undefined : state.activeBookmarkId,
      }))
      return
    }
    const order = ++bookmarkOrder
    const created: Bookmark = {
      id: `bookmark${++bookmarkSequence}`,
      kind: place.kind,
      nodeId,
      identity: place.identity,
      modulePath: place.modulePath,
      metadataToken: place.metadataToken,
      ilOffset: place.ilOffset,
      line: place.line,
      description: place.description,
      name: t('Bookmark {number}', { number: order }),
      labels: [],
      enabled: true,
      order,
    }
    set((state) => ({ bookmarks: [...state.bookmarks, created], activeBookmarkId: created.id }))
  },

  toggleBookmarkEnabledAt: (nodeId, line) => {
    const place = bookmarkPlaceAt(nodeId, get().documents[nodeId], line)
    const existing = place && get().bookmarks.find((bookmark) => bookmark.identity === place.identity)
    if (existing)
      get().setBookmarkEnabled(existing.id, !existing.enabled)
  },

  removeBookmark: (id) => {
    if (!get().bookmarks.some((bookmark) => bookmark.id === id)) return
    set((state) => ({
      bookmarks: state.bookmarks.filter((bookmark) => bookmark.id !== id),
      activeBookmarkId: state.activeBookmarkId === id ? undefined : state.activeBookmarkId,
    }))
  },

  removeBookmarks: (ids) => {
    const removing = new Set(ids)
    if (removing.size === 0) return
    set((state) => ({
      bookmarks: state.bookmarks.filter((bookmark) => !removing.has(bookmark.id)),
      activeBookmarkId: state.activeBookmarkId && removing.has(state.activeBookmarkId) ? undefined : state.activeBookmarkId,
    }))
  },

  removeAllBookmarksInDocument: (nodeId) => {
    if (!get().bookmarks.some((bookmark) => bookmark.nodeId === nodeId)) return
    set((state) => {
      const bookmarks = state.bookmarks.filter((bookmark) => bookmark.nodeId !== nodeId)
      return {
        bookmarks,
        activeBookmarkId: bookmarks.some((bookmark) => bookmark.id === state.activeBookmarkId) ? state.activeBookmarkId : undefined,
      }
    })
  },

  clearBookmarks: () => {
    if (get().bookmarks.length === 0) return
    set({ bookmarks: [], activeBookmarkId: undefined })
  },

  setBookmarkEnabled: (id, enabled) => {
    if (!get().bookmarks.some((bookmark) => bookmark.id === id && bookmark.enabled !== enabled)) return
    set((state) => ({
      bookmarks: state.bookmarks.map((bookmark) => bookmark.id === id ? { ...bookmark, enabled } : bookmark),
    }))
  },

  setBookmarksEnabled: (ids, enabled) => {
    const target = new Set(ids)
    if (!get().bookmarks.some((bookmark) => target.has(bookmark.id) && bookmark.enabled !== enabled)) return
    set((state) => ({
      bookmarks: state.bookmarks.map((bookmark) => target.has(bookmark.id) ? { ...bookmark, enabled } : bookmark),
    }))
  },

  setAllBookmarksEnabled: (enabled) => {
    if (!get().bookmarks.some((bookmark) => bookmark.enabled !== enabled)) return
    set((state) => ({ bookmarks: state.bookmarks.map((bookmark) => ({ ...bookmark, enabled })) }))
  },

  renameBookmark: (id, name) => {
    const trimmed = name.trim()
    if (!trimmed || !get().bookmarks.some((bookmark) => bookmark.id === id && bookmark.name !== trimmed)) return
    set((state) => ({
      bookmarks: state.bookmarks.map((bookmark) => bookmark.id === id ? { ...bookmark, name: trimmed } : bookmark),
    }))
  },

  setBookmarkLabels: (id, labels) => {
    const normalized = [...new Set(labels.map((label) => label.trim()).filter(Boolean))]
    const existing = get().bookmarks.find((bookmark) => bookmark.id === id)
    if (!existing || sameLabels(existing.labels, normalized)) return
    set((state) => ({
      bookmarks: state.bookmarks.map((bookmark) => bookmark.id === id ? { ...bookmark, labels: normalized } : bookmark),
    }))
  },

  importBookmarks: (entries) => {
    const known = new Set(get().bookmarks.map((bookmark) => bookmark.identity))
    const imported: Bookmark[] = []
    for (const entry of entries) {
      const bookmark = bookmarkFromEntry(entry, 0)
      if (known.has(bookmark.identity)) continue
      known.add(bookmark.identity)
      imported.push({ ...bookmark, order: ++bookmarkOrder })
    }
    if (imported.length > 0)
      set((state) => ({ bookmarks: [...state.bookmarks, ...imported] }))
    return imported.length
  },

  goToBookmark: async (id, newTab = false) => {
    const bookmark = get().bookmarks.find((candidate) => candidate.id === id)
    if (!bookmark) return
    set({ activeBookmarkId: id })
    const documentId = await openBookmarkDocument(get, set, bookmark, newTab)
    if (!documentId) {
      // dnSpy shows a bookmark for a module that is not loaded too; it just cannot go there yet.
      get().appendOutput(t('Bookmark "{name}" is in a module that is not loaded.', { name: bookmark.name }))
      return
    }
    // dnSpy puts the caret where the location starts: the statement, or the definition's name.
    const document = get().documents[documentId]
    const position = bookmarkPositionInDocument(documentId, document, bookmark) ?? { line: bookmark.line, column: 1 }
    get().revealCaret(documentId, position.line, position.column)
  },

  goToLineBreakpoint: async (id, newTab = false) => {
    const breakpoint = get().lineBreakpoints.find((candidate) => candidate.id === id)
    if (!breakpoint) return
    const open = newTab ? get().openNodeInNewTabById : get().openNodeById
    if (!open) return
    let nodeId = breakpoint.nodeId
    // A breakpoint read back from storage names its method by token: the node is found again first.
    const workspaceId = get().workspaceId
    if (!nodeId && workspaceId && breakpoint.modulePath && (breakpoint.sourceMethodToken ?? breakpoint.metadataToken) !== undefined) {
      const found = await window.dnSpy.findMember(workspaceId, breakpoint.modulePath, breakpoint.sourceMethodToken ?? breakpoint.metadataToken!)
      nodeId = found.nodeId ?? ''
    }
    if (!nodeId) {
      get().appendOutput(t('The breakpoint is in a module that is not loaded.'))
      return
    }
    const documentId = await open(nodeId)
    if (documentId)
      get().revealCaret(documentId, breakpoint.line, 1)
  },

  revealCaret: (documentId, line, column, viewId) => {
    set({ caretReveal: { documentId, viewId, line, column, token: ++caretRevealToken } })
  },

  requestCaret: (request) => {
    set({ caretReveal: { ...request, token: ++caretRevealToken } })
  },

  selectNextBookmark: async (position) => { await stepBookmark(get, 1, { position }) },
  selectPreviousBookmark: async (position) => { await stepBookmark(get, -1, { position }) },
  selectNextBookmarkInDocument: async (documentId, line) => { await stepBookmark(get, 1, { documentId, position: { documentId, line: line ?? 0 } }) },
  selectPreviousBookmarkInDocument: async (documentId, line) => { await stepBookmark(get, -1, { documentId, position: { documentId, line: line ?? 0 } }) },
  selectNextBookmarkWithSameLabel: async () => { await stepBookmark(get, 1, { sameLabel: true }) },
  selectPreviousBookmarkWithSameLabel: async () => { await stepBookmark(get, -1, { sameLabel: true }) },

  loadExceptionSettings: async () => {
    const diff = get().exceptionDiff
    try {
      // The engine's list is the truth; the stored diff is only how the client gets its own changes
      // back into it, and it goes in as one request rather than one per row.
      const list = hasExceptionDiff(diff)
        ? await window.dnSpy.applyExceptionSettings(diff)
        : await window.dnSpy.getExceptionSettings()
      set({ exceptionCategories: list.categories, exceptionSettings: list.exceptions, exceptionSettingsLoaded: true, exceptionSettingsError: undefined })
    } catch (error) {
      // A failed launch must not be turned into a failed read: the window reports the engine instead.
      set({ exceptionSettingsError: error instanceof Error ? error.message : String(error) })
    }
  },

  setExceptionBreakWhenThrown: async (keys, value) => {
    await applyExceptionChange(get, set, keys, (diff, rows) =>
      rows.reduce((current, row) => withExceptionSetting(current, row, { stopFirstChance: value }), diff))
  },

  addExceptionDefinition: async (entry) => {
    const diff = get().exceptionDiff
    set({ exceptionDiff: pruneExceptionDiff({ ...diff, added: [...(diff.added ?? []), {
      category: entry.category,
      name: entry.name ?? null,
      code: entry.code ?? null,
      description: entry.description ?? null,
      // A type added to the list is one the user wants to break on — WPF's AddExceptionVM sets both flags.
      stopFirstChance: true,
      stopSecondChance: true,
      conditions: [],
    }] }) })
    await get().loadExceptionSettings()
  },

  removeExceptionDefinitions: async (keys) => {
    await applyExceptionChange(get, set, keys, (diff, rows) =>
      rows.reduce((current, row) => withoutException(current, row), diff))
  },

  setExceptionConditions: async (keys, conditions) => {
    // WPF's Edit Conditions turns Break When Thrown on along with the conditions, so a condition the
    // user just wrote cannot end up on a row that never stops.
    await applyExceptionChange(get, set, keys, (diff, rows) =>
      rows.reduce((current, row) => withExceptionSetting(current, row, { conditions, stopFirstChance: true }), diff))
  },

  restoreDefaultExceptionSettings: async () => {
    set({ exceptionDiff: {} })
    try {
      const list = await window.dnSpy.resetExceptionSettings()
      set({ exceptionCategories: list.categories, exceptionSettings: list.exceptions, exceptionSettingsLoaded: true, exceptionSettingsError: undefined })
    } catch (error) {
      set({ exceptionSettingsError: error instanceof Error ? error.message : String(error) })
    }
  },

  appendOutput: (message, pane = 'dnSpy') => set((state) => {
    const key = pane === 'debug' ? 'debugOutput' : 'output'
    return { [key]: [...state[key], ...outputLines(message)].slice(-OUTPUT_LIMIT) }
  }),

  clearOutput: (pane) => set((state) => (pane ?? state.outputPane) === 'debug' ? { debugOutput: [] } : { output: [] }),

  selectOutputPane: (outputPane) => set({ outputPane }),

  clearError: () => set({ error: undefined }),

  startScript: async () => {
    if (get().scriptStarted) return
    set({ scriptStarted: true })
    subscribeScriptOutput()
    // Opening the window is the one case that prints the engine banner: the WPF window's Logo comes from
    // OnVisible, not from Reset.
    await rebuildScriptSession(set, { loadConfig: true, showBanner: true })
    appendScriptEntries(set, [{ kind: 'help', text: t('Type "#help" for more information.') }])
  },

  resetScript: async (loadConfig = true) => {
    // The window narrates every explicit reset — the toolbar button and `#reset` alike, as the
    // upstream command does. Opening the window is the one case that prints the banner alone.
    appendScriptEntries(set, [{ kind: 'output', text: t('Resetting execution engine.') }])
    await rebuildScriptSession(set, { loadConfig, showBanner: false })
  },

  appendScriptOutput: (notification) => set((state) => {
    // A line from the engine a reset replaced belongs to a session nobody is looking at any more.
    if (notification.generation < state.scriptGeneration)
      return {}
    return {
      scriptGeneration: notification.generation,
      scriptEntries: [...state.scriptEntries, notification.entry].slice(-MAX_SCRIPT_ENTRIES),
    }
  }),

  evaluateScript: async (code, colors) => {
    const submission = code.trim()
    if (!submission || get().scriptRunning) return
    const history = get().scriptHistory
    // Colors asked for here are worked out before the submission runs, so they are the input's, not the ones
    // the code would get once its own declarations exist.
    const echoColors = colors ? spansOfTrimmed(code, colors) : await classifySubmission(submission)
    const echo: ScriptOutputEntry = echoColors && echoColors.length > 0 ? { kind: 'echo', text: submission, colors: echoColors } : { kind: 'echo', text: submission }
    set((state) => ({
      scriptEntries: [...state.scriptEntries, echo].slice(-MAX_SCRIPT_ENTRIES),
      // Pressing Enter twice on the same line should not fill the history with copies of it.
      scriptHistory: history[history.length - 1] === submission ? history : [...history, submission].slice(-MAX_SCRIPT_HISTORY),
    }))
    const command = scriptCommandOf(submission)
    switch (command?.name) {
      case 'clear':
      case 'cls':
        get().clearScriptOutput()
        return
      case 'help':
        get().showScriptHelp()
        return
      case 'reset':
        // `#reset noconfig` starts the engine without its response file, as dnSpy's ResetCommand does.
        await get().resetScript(!command.args.includes('noconfig'))
        return
    }
    set({ scriptRunning: true })
    try {
      const response = await window.dnSpy.evaluateScript(submission)
      // A host with a client streams every line as it is produced and answers with none; a headless one
      // (or a test) answers with the whole batch instead.
      appendScriptEntries(set, response.entries)
      // A response that arrives after a reset belongs to the engine the reset replaced; its generation must
      // not move the window back to that session.
      if (response.generation > get().scriptGeneration)
        set({ scriptGeneration: response.generation })
    } catch (error) {
      appendScriptEntries(set, [scriptFailureEntry(error)])
    } finally {
      set({ scriptRunning: false })
    }
  },

  clearScriptOutput: () => set({ scriptEntries: [] }),

  showScriptHelp: () => appendScriptEntries(set, scriptHelpEntries()),
}))

/**
 * The node a tree cache holds, by id. A `TextSpan` names its target as a node id, so this is what turns
 * "the caret is on a reference" into the node a command can act on.
 */
export const findNode = (state: Pick<AppState, 'roots' | 'children'>, nodeId: string): TreeNode | undefined => {
  for (const node of state.roots) {
    if (node.id === nodeId)
      return node
  }
  for (const nodes of Object.values(state.children)) {
    const found = nodes.find((node) => node.id === nodeId)
    if (found)
      return found
  }
  return undefined
}

/** Collects all visible nodes in tree order (for range selection with Shift+click). */
const collectVisibleNodes = (state: Pick<AppState, 'roots' | 'children' | 'expanded'>): TreeNode[] => {
  const result: TreeNode[] = []
  const visit = (nodes: TreeNode[]): void => {
    for (const node of nodes) {
      result.push(node)
      if (state.expanded[node.id] && state.children[node.id])
        visit(state.children[node.id])
    }
  }
  visit(state.roots)
  return result
}


export const suggestCodeFilename = (title: string, language: string): string => {
  const extension = language === 'csharp'
    ? '.cs'
    : language === 'visual-basic'
      ? '.vb'
      : language === 'il'
        ? '.il'
        : language === 'xml'
          ? '.xml'
          : '.txt'
  const baseName = title
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  return `${baseName || 'code'}${extension}`
}

const lastTopLevelSpace = (value: string): number => {
  let depth = 0
  let index = -1
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char === '<' || char === '[')
      depth++
    else if (char === '>' || char === ']')
      depth--
    else if (char === ' ' && depth === 0)
      index = i
  }
  return index
}

/** What "Add Method Breakpoint" is handed: a node — a method, or a property or an event for its
 * accessors — or a method already named the way a function breakpoint names one. */
export type MethodBreakpointTarget = TreeNode | string

// Tree node descriptions are dnlib's MethodDef.FullName, e.g. "System.Void Ns.Type::Method(System.Int32)".
// Debug adapters want "Ns.Type.Method", so drop the return type and the parameter list, and turn the "::"
// and nested-type "/" separators into ".". A description that is already in dotted form is returned as is.
// Generic arity ("Ns.Type`1") is kept: stripping it is a dnSpy search-filter concern, not a breakpoint one.
export const methodBreakpointName = (description?: string): string | undefined => {
  const trimmed = description?.trim()
  if (!trimmed)
    return undefined
  const parameterStart = trimmed.indexOf('(')
  const withoutParameters = (parameterStart < 0 ? trimmed : trimmed.slice(0, parameterStart)).trim()
  const separator = withoutParameters.indexOf('::')
  if (separator < 0)
    return withoutParameters || undefined
  const declaring = withoutParameters.slice(0, separator).trim()
  const typeName = declaring.slice(lastTopLevelSpace(declaring) + 1).replace(/\//g, '.')
  const methodName = withoutParameters.slice(separator + 2).trim()
  return typeName && methodName ? `${typeName}.${methodName}` : undefined
}

// A gutter click has to land on a sequence point the engine can bind, so the statement whose line range covers the
// click wins; a click on a blank line, a brace or a comment falls back to the nearest statement below it, and only
// then to the nearest one above. Statements nest (a lambda body lives inside the method that declares it), so among
// candidates the one that starts latest — the innermost — is the one the user aimed at.
export const codeStatementAt = (
  statements: CodeStatement[] | undefined,
  line: number,
  column?: number,
): CodeStatement | undefined => {
  const visible = (statements ?? []).filter((statement) => !statement.isHidden)
  let covering: CodeStatement | undefined
  for (const statement of visible) {
    if (line < statement.startLine || line > statement.endLine)
      continue
    // A column only narrows a single-line statement; a multi-line one covers its whole range.
    if (column !== undefined && statement.startLine === statement.endLine && (column < statement.startColumn - 1 || column > statement.endColumn))
      continue
    if (!covering || statement.startLine > covering.startLine)
      covering = statement
  }
  if (covering)
    return covering
  let nearest: CodeStatement | undefined
  for (const statement of visible) {
    if (!nearest || isCloserStatement(statement, nearest, line))
      nearest = statement
  }
  return nearest
}

const statementDistance = (statement: CodeStatement, line: number): number => line < statement.startLine
  ? statement.startLine - line
  : line > statement.endLine ? line - statement.endLine : 0

// Distance first; a tie goes to the statement below the click, matching what the backend's snapping does.
const isCloserStatement = (candidate: CodeStatement, current: CodeStatement, line: number): boolean => {
  const distance = statementDistance(candidate, line)
  const currentDistance = statementDistance(current, line)
  return distance === currentDistance ? candidate.startLine > current.startLine : distance < currentDistance
}

/**
 * The statements a line breakpoint is placed by. The backend resolves a breakpoint's line against the C#
 * statement map, so an IL view's statements — one per instruction, there for bookmarks, the hex commands and
 * the analyzer — are not offered to the breakpoint commands; those keep working off the C# view alone.
 */
export const breakpointStatementsOf = (document: { language: string; codeStatements?: CodeStatement[] } | undefined): CodeStatement[] | undefined =>
  document?.language === 'csharp' ? document.codeStatements : undefined

// The IL identity a statement maps to. Two clicks that land on the same sequence point produce the same key, which
// is what makes the second click a toggle even after the first one was snapped to a different line.
export const statementIdentity = (modulePath: string, metadataToken: number, ilOffset: number): string =>
  `${modulePath}|${metadataToken}|${ilOffset}`

// Where each breakpoint draws its dot. Markers are derived from the document on screen rather than stored on the
// breakpoint, so breakpoints created elsewhere (the Breakpoints pane, F9) show up here too, and a document whose
// language has no IL map simply draws nothing. A breakpoint is matched by IL identity, falling back to the node it
// was requested from while the backend has not confirmed the snap yet.
const breakpointLineInDocument = (
  nodeId: string,
  statements: CodeStatement[] | undefined,
  breakpoint: LineBreakpoint,
): number | undefined => {
  const statement = breakpoint.modulePath !== undefined && breakpoint.ilOffset !== undefined
    ? (statements ?? []).find((candidate) => statementIdentity(candidate.modulePath, candidate.metadataToken, candidate.ilOffset) === breakpoint.identity)
    : undefined
  if (statement)
    return statement.startLine
  // Until the engine has named the module, the requested line is the only place the dot can go. Once it has, an
  // identity this document does not contain means the breakpoint belongs to some other document entirely.
  return breakpoint.modulePath === undefined && breakpoint.nodeId === nodeId ? breakpoint.requestedLine : undefined
}

export const lineBreakpointMarkers = (
  nodeId: string,
  statements: CodeStatement[] | undefined,
  breakpoints: LineBreakpoint[],
): { line: number; enabled: boolean; state: LineBreakpoint['state']; message?: string; description?: string }[] => {
  const markers: { line: number; enabled: boolean; state: LineBreakpoint['state']; message?: string; description?: string }[] = []
  for (const breakpoint of breakpoints) {
    const line = breakpointLineInDocument(nodeId, statements, breakpoint)
    if (line !== undefined)
      markers.push({ line, enabled: breakpoint.enabled, state: breakpoint.state, message: breakpoint.message, description: breakpoint.description })
  }
  return markers
}

// The breakpoint whose dot a line carries, which is what the code viewer's context menu names in its
// commands: the inverse of `lineBreakpointMarkers`, and wrong in the same way if the two disagree. Several
// breakpoints can share a line only through the fallback below, so the first match is the one the dots merge.
export const lineBreakpointAt = (
  nodeId: string,
  statements: CodeStatement[] | undefined,
  breakpoints: LineBreakpoint[],
  line: number,
): LineBreakpoint | undefined =>
  breakpoints.find((breakpoint) => breakpointLineInDocument(nodeId, statements, breakpoint) === line)

// A body bookmark is named by the method it sits in and the IL offset inside it, which is what dnSpy's
// `DotNetMethodBodyBookmarkLocation` stores. The *source* method token is the one that matters: inside a
// state machine a statement belongs to `MoveNext`, whose token resolves to a method nobody navigates to.
const bookmarkIdentityOf = (statement: CodeStatement): string =>
  statementIdentity(statement.modulePath, statement.sourceMethodToken, statement.ilOffset)

// A definition is named by its module and token alone — dnSpy's `DotNetTokenBookmarkLocation`.
const definitionIdentity = (modulePath: string, metadataToken: number): string => `${modulePath}|${metadataToken}|definition`

/** What of a decompiled document places a bookmark: its statement map, its definitions and its text. */
export interface BookmarkDocument {
  text: string
  spans: TextSpan[]
  codeStatements?: CodeStatement[]
}

/** Where a toggle on a line puts a bookmark, before there is one. */
interface BookmarkPlace {
  kind: BookmarkKind
  identity: string
  modulePath: string
  metadataToken: number
  ilOffset: number
  line: number
  description: string
}

const isDefinitionSpan = (span: TextSpan): boolean =>
  span.kind === 'definition' && !!span.targetModulePath && !!span.targetMetadataToken

/**
 * The statement a line holds, the way dnSpy's `FindByTextPosition` reads it from the start of the line: one
 * that began on an earlier line covers the line whole, and otherwise the first one that starts on it. A
 * statement on another line is no answer — a bookmark goes where the user put it.
 */
const statementOnLine = (statements: CodeStatement[] | undefined, line: number): CodeStatement | undefined => {
  let covering: CodeStatement | undefined
  let first: CodeStatement | undefined
  for (const statement of statements ?? []) {
    if (statement.isHidden || line < statement.startLine || line > statement.endLine)
      continue
    if (statement.startLine < line) {
      if (!covering || statement.startLine > covering.startLine)
        covering = statement
    } else if (!first || statement.startColumn < first.startColumn) {
      first = statement
    }
  }
  return covering ?? first
}

/**
 * dnSpy's `TextViewBookmarkService.GetLocation`: the method body location of the statement on the line, or
 * the definition location of the first member defined from the start of the line on — whichever starts
 * first. A declaration line has no statement, so it gets its member; a blank line gets the next one.
 */
export const bookmarkLocationAt = (document: BookmarkDocument | undefined, line: number): BookmarkPlace | undefined => {
  if (!document)
    return undefined
  const lineStart = offsetOfLineColumn(document.text, line, 1)
  const statement = statementOnLine(document.codeStatements, line)
  const statementStart = statement ? offsetOfLineColumn(document.text, statement.startLine, statement.startColumn) : Infinity
  let definition: TextSpan | undefined
  for (const span of document.spans) {
    if (isDefinitionSpan(span) && span.start >= lineStart && (!definition || span.start < definition.start))
      definition = span
  }
  if (definition && definition.start < statementStart) {
    const modulePath = definition.targetModulePath ?? ''
    const metadataToken = definition.targetMetadataToken ?? 0
    return {
      kind: 'token',
      identity: definitionIdentity(modulePath, metadataToken),
      modulePath,
      metadataToken,
      ilOffset: 0,
      line: lineColumnOfOffset(document.text, definition.start).line,
      description: document.text.slice(definition.start, definition.start + definition.length),
    }
  }
  if (!statement)
    return undefined
  return {
    kind: 'body',
    identity: bookmarkIdentityOf(statement),
    modulePath: statement.modulePath,
    metadataToken: statement.sourceMethodToken,
    ilOffset: statement.ilOffset,
    line: statement.startLine,
    description: statement.description,
  }
}

/** Whether a document can name any location at all — Visual Basic, a resource or a header cannot. */
const hasBookmarkLocations = (document: BookmarkDocument | undefined): boolean =>
  !!document && ((document.codeStatements ?? []).some((statement) => !statement.isHidden) || document.spans.some(isDefinitionSpan))

/**
 * Where a toggle on a line puts a bookmark. In a document with nothing to name a location by, the line
 * itself is all there is — such a bookmark lives for this session only. A document that can name locations
 * but has none from this line on gets nothing, as in dnSpy.
 */
const bookmarkPlaceAt = (nodeId: string, document: BookmarkDocument | undefined, line: number): BookmarkPlace | undefined => {
  if (hasBookmarkLocations(document))
    return bookmarkLocationAt(document, line)
  return { kind: 'line', identity: `${nodeId}|${line}`, modulePath: '', metadataToken: 0, ilOffset: 0, line, description: '' }
}

/**
 * The statement a body bookmark shows on: the one it was made on, or — for a spot another view made, an IL
 * instruction inside a C# statement — the statement whose IL holds the offset, as dnSpy's
 * `GetSourceStatementByCodeOffset` finds it. A state machine's statements live in another body, where the
 * offset means something else, so only the exact match counts there.
 */
const bookmarkStatementIn = (statements: CodeStatement[] | undefined, bookmark: Bookmark): CodeStatement | undefined => {
  let holding: CodeStatement | undefined
  for (const statement of statements ?? []) {
    if (statement.isHidden || statement.sourceMethodToken !== bookmark.metadataToken || statement.modulePath !== bookmark.modulePath)
      continue
    if (statement.ilOffset === bookmark.ilOffset)
      return statement
    if (statement.metadataToken === statement.sourceMethodToken && statement.sequencePointIlOffset <= bookmark.ilOffset && bookmark.ilOffset < statement.ilEndOffset
      && (!holding || statement.sequencePointIlOffset > holding.sequencePointIlOffset))
      holding = statement
  }
  return holding
}

const bookmarkDefinitionIn = (spans: TextSpan[] | undefined, bookmark: Bookmark): TextSpan | undefined =>
  spans?.find((span) => isDefinitionSpan(span) && span.targetModulePath === bookmark.modulePath && span.targetMetadataToken === bookmark.metadataToken)

/** Where a bookmark is in a document — the start of its statement or of its definition's name — if there. */
export const bookmarkPositionInDocument = (
  nodeId: string,
  document: BookmarkDocument | undefined,
  bookmark: Bookmark,
): { line: number; column: number } | undefined => {
  switch (bookmark.kind) {
    case 'line':
      return bookmark.nodeId === nodeId && bookmark.line > 0 ? { line: bookmark.line, column: 1 } : undefined
    case 'token': {
      const definition = bookmarkDefinitionIn(document?.spans, bookmark)
      return definition && document ? lineColumnOfOffset(document.text, definition.start) : undefined
    }
    default: {
      const statement = bookmarkStatementIn(document?.codeStatements, bookmark)
      return statement ? { line: statement.startLine, column: statement.startColumn } : undefined
    }
  }
}

// Where a bookmark's marker goes: the document's own maps decide, so a bookmark whose method or member this
// document does not contain draws nothing. A bookmark restored from disk has no line until its document has
// been opened.
export const bookmarkLineInDocument = (nodeId: string, document: BookmarkDocument | undefined, bookmark: Bookmark): number | undefined =>
  bookmarkPositionInDocument(nodeId, document, bookmark)?.line

export const bookmarkMarkers = (
  nodeId: string,
  document: BookmarkDocument | undefined,
  bookmarks: Bookmark[],
): { line: number; enabled: boolean; message: string }[] => {
  const markers: { line: number; enabled: boolean; message: string }[] = []
  for (const bookmark of bookmarks) {
    const line = bookmarkLineInDocument(nodeId, document, bookmark)
    if (line !== undefined)
      markers.push({ line, enabled: bookmark.enabled, message: bookmark.name })
  }
  return markers
}

// The tool window's search box: whitespace separates terms and all of them have to match, each either
// anywhere in the row or — with a one-letter prefix — in one field of it. The Location column is matched as
// the window writes it, which only the window knows; without that the stored description stands in.
export const filterBookmarks = (bookmarks: Bookmark[], query: string, locationOf?: (bookmark: Bookmark) => string): Bookmark[] => {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return terms.length === 0 ? bookmarks : bookmarks.filter((bookmark) => terms.every((term) => matchesBookmarkTerm(bookmark, term, locationOf)))
}

const matchesBookmarkTerm = (bookmark: Bookmark, term: string, locationOf?: (bookmark: Bookmark) => string): boolean => {
  const prefix = term.length > 1 && term[1] === ':' && 'nlom'.includes(term[0]) ? term[0] : ''
  const text = prefix ? term.slice(2) : term
  if (!text) return true
  const inName = bookmark.name.toLowerCase().includes(text)
  const inLabels = bookmark.labels.some((label) => label.toLowerCase().includes(text))
  const inLocation = (locationOf?.(bookmark) ?? bookmark.description).toLowerCase().includes(text)
  const inModule = bookmark.modulePath.toLowerCase().includes(text)
  switch (prefix) {
    case 'n': return inName
    case 'l': return inLabels
    case 'o': return inLocation
    case 'm': return inModule
    default: return inName || inLabels || inLocation || inModule
  }
}

// Document order: module, then line, then the order the bookmarks were made, so "next bookmark" means
// the same thing in every document.
const compareBookmarks = (left: Bookmark, right: Bookmark): number =>
  left.modulePath.localeCompare(right.modulePath) || left.line - right.line || left.order - right.order

/** The first bookmark the caret has not passed yet, in the direction of travel; wraps when there is none. */
const pickBookmarkFromCaret = (candidates: Bookmark[], direction: 1 | -1, line?: number): Bookmark | undefined => {
  if (line !== undefined) {
    const ahead = direction > 0
      ? candidates.find((bookmark) => bookmark.line > line)
      : [...candidates].reverse().find((bookmark) => bookmark.line < line)
    if (ahead)
      return ahead
  }
  return direction > 0 ? candidates[0] : candidates[candidates.length - 1]
}

/**
 * Walks the enabled bookmarks in one direction, wrapping — dnSpy's bookmark navigator. With a caret it
 * starts after the caret, without one it continues past the bookmark the last go-to landed on.
 */
const stepBookmark = async (
  get: StoreGet,
  direction: 1 | -1,
  options: { documentId?: string; position?: CaretPosition; sameLabel?: boolean },
): Promise<void> => {
  const { bookmarks, activeBookmarkId } = get()
  let candidates = bookmarks.filter((bookmark) => bookmark.enabled)
  if (options.documentId)
    candidates = candidates.filter((bookmark) => bookmark.nodeId === options.documentId)
  if (options.sameLabel) {
    const active = bookmarks.find((bookmark) => bookmark.id === activeBookmarkId)
    if (!active || active.labels.length === 0)
      return
    candidates = candidates.filter((bookmark) => bookmark.labels.some((label) => active.labels.includes(label)))
  }
  if (candidates.length === 0)
    return
  candidates = [...candidates].sort(compareBookmarks)
  const activeIndex = candidates.findIndex((bookmark) => bookmark.id === activeBookmarkId)
  const target = options.position
    ? pickBookmarkFromCaret(candidates, direction, options.position.line)
    : activeIndex >= 0
      ? candidates[(activeIndex + direction + candidates.length) % candidates.length]
      : pickBookmarkFromCaret(candidates, direction)
  if (target)
    await get().goToBookmark(target.id)
}

/** Whether a document that has just been opened is the one a bookmark's identity belongs to. */
const documentHasBookmark = (get: StoreGet, documentId: string, bookmark: Bookmark): boolean => {
  const document = get().documents[documentId]
  // A document that names no locations — a Visual Basic view, a resource — cannot contradict the node id.
  if (bookmark.kind === 'line' || !hasBookmarkLocations(document))
    return true
  return bookmarkLineInDocument(documentId, document, bookmark) !== undefined
}

/**
 * Brings a bookmark's document up, resolving the target first. The node id is only a hint — it dies
 * with the workspace that issued it — so a miss is answered by asking the backend to look the module
 * and token up again in the current one. An id that still resolves is not proof either, because ids
 * are reissued from the same counter: the bookmark's own identity has the final say. A new tab is only
 * opened once the node is known to be right, so a stale id never leaves a stray tab behind.
 */
const openBookmarkDocument = async (
  get: StoreGet,
  set: StoreSet,
  bookmark: Bookmark,
  newTab: boolean,
): Promise<string | undefined> => {
  const open = newTab ? get().openNodeInNewTabById : get().openNodeById
  if (!open)
    return undefined
  if (newTab) {
    if (bookmark.kind === 'line' || (bookmark.nodeId && get().documents[bookmark.nodeId] && documentHasBookmark(get, bookmark.nodeId, bookmark)))
      return await open(bookmark.nodeId)
  } else {
    const direct = await open(bookmark.nodeId)
    if (direct && documentHasBookmark(get, direct, bookmark))
      return direct
  }
  const workspaceId = get().workspaceId
  if (!workspaceId || bookmark.kind === 'line')
    return undefined
  const found = await window.dnSpy.findMember(workspaceId, bookmark.modulePath, bookmark.metadataToken)
  if (!found.nodeId)
    return undefined
  const nodeId = found.nodeId
  set((state) => ({
    bookmarks: state.bookmarks.map((candidate) => candidate.id === bookmark.id ? { ...candidate, nodeId } : candidate),
  }))
  return await open(nodeId)
}

/**
 * Relinks the bookmarks to a document that has just been decompiled. Only the document's own maps count,
 * so a bookmark for another method is left alone even though this document is now the open one.
 */
const attachBookmarks = (set: StoreSet, nodeId: string, document: BookmarkDocument): void => {
  if (!hasBookmarkLocations(document))
    return
  set((state) => {
    let changed = false
    const bookmarks = state.bookmarks.map((bookmark) => {
      if (bookmark.kind === 'line')
        return bookmark
      const line = bookmarkLineInDocument(nodeId, document, bookmark)
      if (line === undefined || (bookmark.nodeId === nodeId && bookmark.line === line))
        return bookmark
      changed = true
      return { ...bookmark, nodeId, line }
    })
    return changed ? { bookmarks } : {}
  })
}

/**
 * Relinks the line breakpoints to a document that has just been decompiled. A breakpoint restored from
 * settings has no node id and the line its last run decompiled to; this is what makes the pane read
 * right and the dot land in the right place again, without waiting for a debug session. Only identity
 * matches count, so a breakpoint in another method is left alone.
 */
const attachLineBreakpoints = (set: StoreSet, nodeId: string, statements: CodeStatement[] | undefined): void => {
  if (!statements || statements.length === 0)
    return
  const byIdentity = new Map<string, CodeStatement>()
  for (const statement of statements) {
    // A hidden point's line is 0xFEEFEE, not somewhere a dot can go.
    if (!statement.isHidden)
      byIdentity.set(statementIdentity(statement.modulePath, statement.metadataToken, statement.ilOffset), statement)
  }
  set((state) => {
    let changed = false
    const lineBreakpoints = state.lineBreakpoints.map((breakpoint) => {
      const statement = byIdentity.get(breakpoint.identity)
      if (!statement || (breakpoint.nodeId === nodeId && breakpoint.line === statement.startLine))
        return breakpoint
      changed = true
      return {
        ...breakpoint,
        nodeId,
        requestedLine: statement.startLine,
        line: statement.startLine,
        endLine: statement.endLine,
        description: statement.description || breakpoint.description,
        sourceMethodToken: breakpoint.sourceMethodToken ?? statement.sourceMethodToken,
      }
    })
    return changed ? { lineBreakpoints } : {}
  })
}

/**
 * Reads bookmarks out of stored settings or an imported file. Both shapes are accepted — a bare array
 * and the `{ bookmarks: [...] }` wrapper the export writes — and a row that is not usable is dropped
 * rather than failing the whole load.
 */
export const parseBookmarkEntries = (value: unknown): BookmarkEntry[] => {
  if (Array.isArray(value))
    return value.flatMap((entry) => {
      const parsed = toBookmarkEntry(entry)
      return parsed ? [parsed] : []
    })
  const wrapped = typeof value === 'object' && value !== null ? (value as { bookmarks?: unknown }).bookmarks : undefined
  return wrapped === undefined ? [] : parseBookmarkEntries(wrapped)
}

function loadBookmarks(): Bookmark[] {
  try {
    const stored = JSON.parse(localStorage.getItem(bookmarksStorageKey) ?? '[]') as unknown
    return parseBookmarkEntries(stored).map((entry) => bookmarkFromEntry(entry, ++bookmarkOrder))
  } catch {
    return []
  }
}

/**
 * The bookmarks in the shape they are stored and exported. A bookmark with no location only exists for
 * this session — there is nothing on disk to point at — so it is left out rather than written as a row
 * that could never navigate anywhere.
 */
export const bookmarkEntries = (bookmarks: Bookmark[]): BookmarkEntry[] => bookmarks
  .filter((bookmark) => bookmark.kind !== 'line' && bookmark.modulePath !== '' && bookmark.metadataToken !== 0)
  .map((bookmark) => ({
    ...(bookmark.kind === 'token' ? { kind: 'token' as const } : {}),
    modulePath: bookmark.modulePath,
    metadataToken: bookmark.metadataToken,
    ...(bookmark.kind === 'token' ? {} : { ilOffset: bookmark.ilOffset }),
    description: bookmark.description,
    name: bookmark.name,
    labels: bookmark.labels,
    enabled: bookmark.enabled,
  }))

function saveBookmarks(bookmarks: Bookmark[]): void {
  localStorage.setItem(bookmarksStorageKey, JSON.stringify(bookmarkEntries(bookmarks)))
}

const bookmarkFromEntry = (entry: BookmarkEntry, order: number): Bookmark => {
  const isToken = entry.kind === 'token'
  return {
    id: `bookmark${++bookmarkSequence}`,
    kind: isToken ? 'token' : 'body',
    nodeId: '',
    identity: isToken ? definitionIdentity(entry.modulePath, entry.metadataToken) : statementIdentity(entry.modulePath, entry.metadataToken, entry.ilOffset ?? 0),
    modulePath: entry.modulePath,
    metadataToken: entry.metadataToken,
    ilOffset: isToken ? 0 : entry.ilOffset ?? 0,
    line: 0,
    description: entry.description,
    name: entry.name,
    labels: entry.labels,
    enabled: entry.enabled,
    order,
  }
}

/** A row read off disk, or undefined when it is damaged beyond the point of being worth keeping. */
const toBookmarkEntry = (value: unknown): BookmarkEntry | undefined => {
  if (typeof value !== 'object' || value === null)
    return undefined
  const entry = value as Record<string, unknown>
  const isToken = entry.kind === 'token'
  // A module and a token are what a row is found by later, and a spot in a method body needs its offset
  // too; without them there is nothing to navigate to, which is the same test `bookmarkEntries` applies
  // when it writes a row out.
  if (typeof entry.modulePath !== 'string' || entry.modulePath === '' || typeof entry.metadataToken !== 'number' || entry.metadataToken === 0)
    return undefined
  if (!isToken && typeof entry.ilOffset !== 'number')
    return undefined
  const name = typeof entry.name === 'string' ? entry.name.trim() : ''
  return {
    ...(isToken ? { kind: 'token' as const } : {}),
    modulePath: entry.modulePath,
    metadataToken: entry.metadataToken,
    ...(isToken ? {} : { ilOffset: entry.ilOffset as number }),
    description: typeof entry.description === 'string' ? entry.description : '',
    name: name || t('Bookmark'),
    labels: Array.isArray(entry.labels) ? entry.labels.filter((label): label is string => typeof label === 'string') : [],
    enabled: entry.enabled !== false,
  }
}

/** A row of a dnSpy bookmark file, in the shape the store keeps. */
export const bookmarkEntryOfFile = (entry: BookmarkFileEntry): BookmarkEntry => ({
  ...(entry.ilOffset == null ? { kind: 'token' as const } : {}),
  modulePath: entry.modulePath,
  metadataToken: entry.metadataToken,
  ...(entry.ilOffset == null ? {} : { ilOffset: entry.ilOffset }),
  description: entry.description ?? '',
  name: entry.name.trim() || t('Bookmark'),
  labels: entry.labels,
  enabled: entry.enabled,
})

/** The bookmarks as a dnSpy bookmark file holds them, in the order they were made. */
export const bookmarkFileEntries = (bookmarks: Bookmark[]): BookmarkFileEntry[] => bookmarkEntries([...bookmarks].sort((left, right) => left.order - right.order))
  .map((entry) => ({
    modulePath: entry.modulePath,
    metadataToken: entry.metadataToken,
    ilOffset: entry.kind === 'token' ? null : entry.ilOffset ?? 0,
    name: entry.name,
    labels: entry.labels,
    enabled: entry.enabled,
    description: entry.description || null,
  }))

const sameLabels = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((label, index) => label === right[index])

// The stored bookmarks are read back once the module has finished evaluating. The state initializer runs
// before `loadBookmarks` and the helpers it needs are declared, so reading them from up there would only
// ever hit the temporal dead zone — and the bookmark list is empty for the rest of the session.
useAppStore.setState({ bookmarks: loadBookmarks() })

// The tool window has no commit step, so there is no natural moment to ask "save?"; every change goes
// straight to storage, the way dnSpy's settings service writes each bookmark change out.
useAppStore.subscribe((state, previous) => {
  if (state.bookmarks !== previous.bookmarks)
    saveBookmarks(state.bookmarks)
})

/**
 * The line breakpoints in the shape they are stored and exported. A breakpoint the engine has not
 * named a module and an offset for only exists for this session — there is nothing on disk to point
 * at — so it is left out, which is the test WPF dnSpy's `BreakpointsSerializer.Save` applies when it
 * asks whether a location can be serialized at all.
 */
export const lineBreakpointEntries = (breakpoints: LineBreakpoint[]): LineBreakpointEntry[] => breakpoints
  .filter((breakpoint) => !!breakpoint.modulePath && !!breakpoint.metadataToken && breakpoint.ilOffset !== undefined)
  .map((breakpoint) => ({
    modulePath: breakpoint.modulePath!,
    metadataToken: breakpoint.metadataToken!,
    sourceMethodToken: breakpoint.sourceMethodToken ?? breakpoint.metadataToken!,
    ilOffset: breakpoint.ilOffset!,
    line: breakpoint.line,
    enabled: breakpoint.enabled,
    description: breakpoint.description,
    // Omitted when there is nothing to say, the way WPF's `BreakpointsSerializer` only writes the
    // sections that differ from the default.
    ...(normalizeBreakpointSettings(breakpoint.settings) ? { settings: breakpoint.settings } : {}),
  }))

/**
 * The settings as they are worth keeping: `undefined` when every part of them is empty. A breakpoint
 * whose dialog was opened and closed again should be indistinguishable from one that never was.
 */
export const normalizeBreakpointSettings = (settings: BreakpointSettings | undefined): BreakpointSettings | undefined => {
  if (!settings)
    return undefined
  const condition = settings.condition?.expression ? settings.condition : undefined
  const hitCount = settings.hitCount
  const filter = settings.filter || undefined
  const trace = settings.trace?.message ? settings.trace : undefined
  const labels = settings.labels?.filter((label) => label !== '') ?? []
  if (!condition && !hitCount && !filter && !trace && labels.length === 0)
    return undefined
  return {
    ...(condition ? { condition } : {}),
    ...(hitCount ? { hitCount } : {}),
    ...(filter ? { filter } : {}),
    ...(trace ? { trace } : {}),
    ...(labels.length > 0 ? { labels } : {}),
  }
}

const conditionKinds: BreakpointConditionKind[] = ['isTrue', 'whenChanged']
const hitCountKinds: BreakpointHitCountKind[] = ['equals', 'multipleOf', 'greaterThanOrEquals']

/**
 * Reads settings off a stored row. Each part is read on its own, so a damaged condition costs the
 * breakpoint its condition rather than its hit count — or the breakpoint itself.
 */
export const parseBreakpointSettings = (value: unknown): BreakpointSettings | undefined => {
  if (typeof value !== 'object' || value === null)
    return undefined
  const stored = value as Record<string, unknown>
  const settings: BreakpointSettings = {}

  const condition = stored.condition as Record<string, unknown> | undefined
  if (typeof condition?.expression === 'string' && condition.expression !== '') {
    settings.condition = {
      kind: conditionKinds.find((kind) => kind === condition.kind) ?? 'isTrue',
      expression: condition.expression,
    }
  }

  const hitCount = stored.hitCount as Record<string, unknown> | undefined
  if (typeof hitCount?.count === 'number' && Number.isInteger(hitCount.count)) {
    settings.hitCount = {
      kind: hitCountKinds.find((kind) => kind === hitCount.kind) ?? 'equals',
      count: hitCount.count,
    }
  }

  if (typeof stored.filter === 'string' && stored.filter !== '')
    settings.filter = stored.filter

  const trace = stored.trace as Record<string, unknown> | undefined
  if (typeof trace?.message === 'string' && trace.message !== '')
    settings.trace = { message: trace.message, continue: trace.continue !== false }

  if (Array.isArray(stored.labels)) {
    const labels = stored.labels.filter((label): label is string => typeof label === 'string' && label !== '')
    if (labels.length > 0)
      settings.labels = labels
  }

  return normalizeBreakpointSettings(settings)
}

/**
 * How the breakpoints pane sums up a breakpoint's settings, ported from WPF's
 * `BreakpointConditionsFormatter`. WPF gives each part its own column; the pane here has one row, so
 * the parts that have something to say are joined and the rest stay silent.
 */
export const breakpointConditionsSummary = (settings: BreakpointSettings | undefined, hitCount?: number): string => {
  const normalized = normalizeBreakpointSettings(settings)
  if (!normalized)
    return ''
  const parts: string[] = []

  if (normalized.condition) {
    const { kind, expression } = normalized.condition
    parts.push(kind === 'whenChanged'
      ? t("when '{expression}' has changed", { expression })
      : t("when '{expression}' is true", { expression }))
  }

  if (normalized.hitCount) {
    const { kind, count } = normalized.hitCount
    const text = kind === 'multipleOf'
      ? t('when hit count is a multiple of {count}', { count })
      : kind === 'greaterThanOrEquals'
        ? t('when hit count is greater than or equal to {count}', { count })
        : t('when hit count is equal to {count}', { count })
    // The live count only exists while a session is running, which is also the only time it is useful.
    parts.push(hitCount === undefined ? text : `${text} (${t('currently {count}', { count: hitCount })})`)
  }

  if (normalized.filter)
    parts.push(t('when {filter}', { filter: normalized.filter }))

  if (normalized.trace) {
    const { message, continue: keepGoing } = normalized.trace
    parts.push(keepGoing
      ? t("print message '{message}'", { message })
      : t("break and print message '{message}'", { message }))
  }

  if (normalized.labels?.length)
    parts.push(normalized.labels.join(', '))

  return parts.join(', ')
}

/** A stored row, or undefined when it is damaged past the point of being worth keeping. */
const toLineBreakpointEntry = (value: unknown): LineBreakpointEntry | undefined => {
  if (typeof value !== 'object' || value === null)
    return undefined
  const entry = value as Record<string, unknown>
  // The same three fields `lineBreakpointEntries` insists on writing: without them there is no
  // location to bind, and the row could never become a breakpoint again.
  if (typeof entry.modulePath !== 'string' || entry.modulePath === '' ||
    typeof entry.metadataToken !== 'number' || entry.metadataToken === 0 ||
    typeof entry.ilOffset !== 'number')
    return undefined
  return {
    modulePath: entry.modulePath,
    metadataToken: entry.metadataToken,
    // Rows written before the source method was tracked fall back to the body's own token, which is
    // the right answer everywhere except inside a state machine.
    sourceMethodToken: typeof entry.sourceMethodToken === 'number' && entry.sourceMethodToken !== 0
      ? entry.sourceMethodToken
      : entry.metadataToken,
    ilOffset: entry.ilOffset,
    line: typeof entry.line === 'number' ? entry.line : 0,
    enabled: entry.enabled !== false,
    description: typeof entry.description === 'string' ? entry.description : undefined,
    settings: parseBreakpointSettings(entry.settings),
  }
}

/**
 * Reads line breakpoints out of stored settings or an imported file. Both shapes are accepted — a bare
 * array and the `{ breakpoints: [...] }` wrapper the export writes — and a row that is not usable is
 * dropped rather than failing the whole load.
 */
export const parseLineBreakpointEntries = (value: unknown): LineBreakpointEntry[] => {
  if (Array.isArray(value))
    return value.flatMap((entry) => {
      const parsed = toLineBreakpointEntry(entry)
      return parsed ? [parsed] : []
    })
  const wrapped = typeof value === 'object' && value !== null ? (value as { breakpoints?: unknown }).breakpoints : undefined
  return wrapped === undefined ? [] : parseLineBreakpointEntries(wrapped)
}

/** Function breakpoints are named by the method they match, so a row only has to carry that. */
export const parseFunctionBreakpoints = (value: unknown): FunctionBreakpoint[] => {
  if (!Array.isArray(value))
    return []
  const seen = new Set<string>()
  return value.flatMap((candidate) => {
    if (typeof candidate !== 'object' || candidate === null)
      return []
    const entry = candidate as Record<string, unknown>
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (name === '' || seen.has(name))
      return []
    seen.add(name)
    return [{ name, enabled: entry.enabled !== false, settings: parseBreakpointSettings(entry.settings) }]
  })
}

/** Turns a stored row back into a breakpoint. The node id died with the workspace that issued it, so
 * it starts empty: the IL identity is what the backend resolves the location from, and what
 * `attachLineBreakpoints` matches on once the document is decompiled again. */
const lineBreakpointFromEntry = (entry: LineBreakpointEntry): LineBreakpoint => ({
  id: `line${++lineBreakpointSequence}`,
  nodeId: '',
  identity: statementIdentity(entry.modulePath, entry.metadataToken, entry.ilOffset),
  requestedLine: entry.line,
  line: entry.line,
  endLine: entry.line,
  state: 'pending',
  enabled: entry.enabled,
  description: entry.description,
  modulePath: entry.modulePath,
  metadataToken: entry.metadataToken,
  sourceMethodToken: entry.sourceMethodToken,
  ilOffset: entry.ilOffset,
  settings: entry.settings,
})

const emptyBreakpoints = (): Pick<AppState, 'lineBreakpoints' | 'functionBreakpoints'> =>
  ({ lineBreakpoints: [], functionBreakpoints: [] })

function loadBreakpoints(): Pick<AppState, 'lineBreakpoints' | 'functionBreakpoints'> {
  if (typeof localStorage === 'undefined')
    return emptyBreakpoints()
  try {
    const stored = JSON.parse(localStorage.getItem(breakpointsStorageKey) ?? 'null') as unknown
    if (typeof stored !== 'object' || stored === null)
      return emptyBreakpoints()
    const { breakpoints, functions } = stored as Record<string, unknown>
    return {
      lineBreakpoints: parseLineBreakpointEntries(breakpoints).map(lineBreakpointFromEntry),
      functionBreakpoints: parseFunctionBreakpoints(functions),
    }
  } catch {
    return emptyBreakpoints()
  }
}

/** The file an export writes, which is also what `loadBreakpoints` reads back. */
export const breakpointsFile = (state: Pick<AppState, 'lineBreakpoints' | 'functionBreakpoints'>): StoredBreakpoints & { version: number } => ({
  version: 1,
  breakpoints: lineBreakpointEntries(state.lineBreakpoints),
  functions: state.functionBreakpoints,
})

function saveBreakpoints(state: Pick<AppState, 'lineBreakpoints' | 'functionBreakpoints'>): void {
  if (typeof localStorage !== 'undefined')
    localStorage.setItem(breakpointsStorageKey, JSON.stringify(breakpointsFile(state)))
}

// Same timing as the bookmarks above: read back once the module has finished evaluating, because the
// state initializer runs while `loadBreakpoints` is still in its temporal dead zone.
useAppStore.setState(loadBreakpoints())

// dnSpy writes its breakpoints when the main window closes; a renderer has no equally reliable moment
// — a crash or a kill takes the window with it — so every change goes straight to storage instead.
useAppStore.subscribe((state, previous) => {
  if (state.lineBreakpoints !== previous.lineBreakpoints ||
    state.functionBreakpoints !== previous.functionBreakpoints)
    saveBreakpoints(state)
})

const exceptionDiffStorageKey = 'dnspy.exceptions.v1'

/** Whether the client has changed anything at all against the engine's defaults. */
const hasExceptionDiff = (diff: DebugExceptionDiff): boolean =>
  (diff.added?.length ?? 0) > 0 || (diff.removed?.length ?? 0) > 0 || (diff.updated?.length ?? 0) > 0

/** Drops the parts of a diff that ended up empty, so what is stored says only what was changed. */
const pruneExceptionDiff = (diff: DebugExceptionDiff): DebugExceptionDiff => ({
  added: diff.added?.length ? diff.added : undefined,
  removed: diff.removed?.length ? diff.removed : undefined,
  updated: diff.updated?.length ? diff.updated : undefined,
})

/** Whether two rows name the same type: by name when it has one, otherwise by code. */
const sameException = (
  a: { category: string; name?: string | null; code?: number | null },
  b: { category: string; name?: string | null; code?: number | null },
): boolean => a.category === b.category && (a.name ?? null) === (b.name ?? null) && (a.code ?? null) === (b.code ?? null)

/** A row stated as the diff states it: everything the engine would apply. */
const exceptionDiffEntry = (row: DebugExceptionSettings, changes: Partial<DebugExceptionDiffEntry>): DebugExceptionDiffEntry => ({
  category: row.category,
  name: row.name,
  code: row.code,
  description: row.description,
  stopFirstChance: row.stopFirstChance,
  stopSecondChance: row.stopSecondChance,
  conditions: row.conditions,
  ...changes,
})

/**
 * Puts a row's new settings into the diff. A type the user added is stated in `added`, where it is also
 * what creates it; one the definition files name only needs its changed settings in `updated`.
 */
const withExceptionSetting = (diff: DebugExceptionDiff, row: DebugExceptionSettings, changes: Partial<DebugExceptionDiffEntry>): DebugExceptionDiff => {
  if ((diff.added ?? []).some((entry) => sameException(entry, row)))
    return pruneExceptionDiff({ ...diff, added: (diff.added ?? []).map((entry) => sameException(entry, row) ? { ...entry, ...changes } : entry) })
  return pruneExceptionDiff({
    ...diff,
    updated: [...(diff.updated ?? []).filter((entry) => !sameException(entry, row)), exceptionDiffEntry(row, changes)],
  })
}

/** Takes a row off the list: a type the user added simply goes, a defined one has to be removed. */
const withoutException = (diff: DebugExceptionDiff, row: DebugExceptionSettings): DebugExceptionDiff => {
  if ((diff.added ?? []).some((entry) => sameException(entry, row)))
    return pruneExceptionDiff({ ...diff, added: (diff.added ?? []).filter((entry) => !sameException(entry, row)) })
  return pruneExceptionDiff({
    ...diff,
    removed: [...(diff.removed ?? []).filter((entry) => !sameException(entry, row)), exceptionDiffEntry(row, {})],
    updated: (diff.updated ?? []).filter((entry) => !sameException(entry, row)),
  })
}

/**
 * Applies one change to the stored diff, hands the whole diff to the engine and shows the list that
 * comes back. The engine answers with the list rather than the change, so the pane never has to guess
 * what a row ended up as — a category default it fell back to, say, or a removal that took.
 */
async function applyExceptionChange(
  get: StoreGet,
  set: StoreSet,
  keys: string[],
  change: (diff: DebugExceptionDiff, rows: DebugExceptionSettings[]) => DebugExceptionDiff,
): Promise<void> {
  const state = get()
  const rows = state.exceptionSettings.filter((row) => keys.includes(row.key))
  const diff = change(state.exceptionDiff, rows)
  set({ exceptionDiff: diff })
  try {
    const list = await window.dnSpy.applyExceptionSettings(diff)
    set({ exceptionCategories: list.categories, exceptionSettings: list.exceptions, exceptionSettingsError: undefined })
  } catch (error) {
    set({ exceptionSettingsError: error instanceof Error ? error.message : String(error) })
  }
}

const parseExceptionDiffEntries = (value: unknown): DebugExceptionDiffEntry[] | undefined => {
  if (!Array.isArray(value))
    return undefined
  const entries = value.flatMap((candidate): DebugExceptionDiffEntry[] => {
    if (typeof candidate !== 'object' || candidate === null || typeof (candidate as DebugExceptionDiffEntry).category !== 'string')
      return []
    const entry = candidate as DebugExceptionDiffEntry
    return [{
      category: entry.category,
      name: typeof entry.name === 'string' ? entry.name : null,
      code: typeof entry.code === 'number' ? entry.code : null,
      description: typeof entry.description === 'string' ? entry.description : null,
      stopFirstChance: entry.stopFirstChance === true,
      stopSecondChance: entry.stopSecondChance === true,
      conditions: Array.isArray(entry.conditions)
        ? entry.conditions.filter((condition) => condition.type === 'moduleNameEquals' || condition.type === 'moduleNameNotEquals')
        : [],
    }]
  })
  return entries.length > 0 ? entries : undefined
}

/** Reads the stored diff back. Anything damaged reads as "no changes", which is the default list. */
function loadExceptionDiff(): DebugExceptionDiff {
  if (typeof localStorage === 'undefined')
    return {}
  try {
    const stored = JSON.parse(localStorage.getItem(exceptionDiffStorageKey) ?? 'null') as unknown
    if (typeof stored !== 'object' || stored === null)
      return {}
    const { added, removed, updated } = stored as Record<string, unknown>
    return { added: parseExceptionDiffEntries(added), removed: parseExceptionDiffEntries(removed), updated: parseExceptionDiffEntries(updated) }
  } catch {
    return {}
  }
}

// Read back after the module has finished evaluating, for the same reason the breakpoints are.
useAppStore.setState({ exceptionDiff: loadExceptionDiff() })

useAppStore.subscribe((state, previous) => {
  if (state.exceptionDiff !== previous.exceptionDiff && typeof localStorage !== 'undefined')
    localStorage.setItem(exceptionDiffStorageKey, JSON.stringify(state.exceptionDiff))
})

const sessionStorageKey = 'dnspy.session.v1'

/** A node a restored session has to materialise, and whether the user actually had it open. */
export interface SavedSessionNode {
  key: string
  expanded: boolean
}

export interface SavedSessionDocument {
  key: string
  language: DecompilerLanguage
  cursorLine?: number
  cursorColumn?: number
  scrollTop?: number
}

/**
 * What one run leaves for the next: the assemblies that were open, the branches that held anything
 * visible, and the tabs in order. Node ids are deliberately absent — they come from a counter in the
 * order nodes are first materialised, so they mean nothing after a restart. Everything here names a
 * node by its key instead.
 */
export interface SavedSession {
  version: 1
  paths: string[]
  /** Ancestors before descendants, so replaying the list top-down can always materialise a parent first. */
  nodes: SavedSessionNode[]
  documents: SavedSessionDocument[]
  activeDocument?: string
  selectedNode?: string
}

/** Expanded nodes this far into a session are beyond anything a person opens by hand; the cut keeps a
 * pathological tree from filling the store. Ancestors and documents are never dropped to meet it. */
const MAX_SESSION_NODES = 2000

/** `undefined` rather than an empty session, so the caller can tell "nothing saved" from "saved empty". */
export function loadSession(): SavedSession | undefined {
  try {
    const parsed = JSON.parse(localStorage.getItem(sessionStorageKey) ?? 'null') as Partial<SavedSession> | null
    if (typeof parsed !== 'object' || parsed === null || parsed.version !== 1)
      return undefined
    return {
      version: 1,
      paths: Array.isArray(parsed.paths) ? parsed.paths.filter((path): path is string => typeof path === 'string') : [],
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes.flatMap(toSavedNode) : [],
      documents: Array.isArray(parsed.documents) ? parsed.documents.flatMap(toSavedDocument) : [],
      activeDocument: typeof parsed.activeDocument === 'string' ? parsed.activeDocument : undefined,
      selectedNode: typeof parsed.selectedNode === 'string' ? parsed.selectedNode : undefined,
    }
  } catch {
    // A session that cannot be read is the same as one that was never written; starting clean is the
    // only sensible answer, and it must not stop the app from starting.
    return undefined
  }
}

const toSavedNode = (value: unknown): SavedSessionNode[] => {
  const node = value as { key?: unknown; expanded?: unknown } | null
  return typeof node?.key === 'string' && node.key !== '' ? [{ key: node.key, expanded: node.expanded === true }] : []
}

const toSavedDocument = (value: unknown): SavedSessionDocument[] => {
  const document = value as { key?: unknown; language?: unknown; cursorLine?: unknown; cursorColumn?: unknown; scrollTop?: unknown } | null
  if (typeof document?.key !== 'string' || document.key === '')
    return []
  const language = document.language
  return [{
    key: document.key,
    language: language === 'visualBasic' || language === 'il' || language === 'ilWithCSharp' ? language : 'cSharp',
    cursorLine: typeof document.cursorLine === 'number' ? document.cursorLine : undefined,
    cursorColumn: typeof document.cursorColumn === 'number' ? document.cursorColumn : undefined,
    scrollTop: typeof document.scrollTop === 'number' ? document.scrollTop : undefined,
  }]
}

/** The parts of the state a session is built from, named so the builder can be tested without a store. */
export type SessionSource = Pick<AppState,
  'modules' | 'roots' | 'children' | 'parents' | 'expanded' | 'selectedNode' | 'documents' | 'documentOrder' | 'activeDocumentId'>

/**
 * The session the current state would be restored from. Every node named here — a restored tab, the
 * selection, an expanded branch — is recorded along with the ancestors above it, since a node cannot
 * exist after a restart without its parent having been materialised first. The result is sorted by
 * depth so replaying it in order always finds the parent it needs.
 */
export function buildSession(state: SessionSource): SavedSession {
  const nodesById = nodesByIdOf(state.roots, state.children)

  // The key a node is recorded under, and the parent above it. Roots have no parent entry, which is
  // exactly where the walk stops.
  const parentOf = (node: TreeNode): TreeNode | undefined => {
    const parentId = state.parents[node.id]
    return parentId ? nodesById.get(parentId) : undefined
  }
  const depthOf = (node: TreeNode): number => {
    let depth = 0
    for (let parent = parentOf(node); parent !== undefined; parent = parentOf(parent))
      depth++
    return depth
  }

  const wanted = new Map<string, { node: TreeNode; expanded: boolean; depth: number }>()
  const include = (node: TreeNode, expanded: boolean): void => {
    let current: TreeNode | undefined = node
    let currentExpanded = expanded
    let depth = depthOf(node)
    while (current) {
      const entry = current.key ? wanted.get(current.key) : undefined
      if (current.key) {
        if (entry)
          entry.expanded ||= currentExpanded
        else
          wanted.set(current.key, { node: current, expanded: currentExpanded, depth })
      }
      // Only the node itself was ever open; the branch that carries it comes back collapsed.
      currentExpanded = false
      current = parentOf(current)
      depth--
    }
  }

  if (state.selectedNode)
    include(state.selectedNode, false)
  for (const documentId of state.documentOrder) {
    const node = nodesById.get(documentId)
    if (node)
      include(node, false)
  }
  let budget = MAX_SESSION_NODES
  for (const [id, open] of Object.entries(state.expanded)) {
    const node = open ? nodesById.get(id) : undefined
    if (!node?.key)
      continue
    if (!wanted.has(node.key) && budget-- <= 0)
      break
    include(node, true)
  }

  const activeNode = state.activeDocumentId ? nodesById.get(state.activeDocumentId) : undefined
  return {
    version: 1,
    // A document with no file has nothing to be opened from next time.
    paths: state.modules.filter((module) => !module.inMemory).map((module) => module.path),
    nodes: [...wanted.values()]
      .sort((left, right) => left.depth - right.depth)
      .map((entry) => ({ key: entry.node.key as string, expanded: entry.expanded })),
    documents: state.documentOrder.flatMap((documentId) => {
      const node = nodesById.get(documentId)
      const doc = state.documents[documentId]
      if (!node?.key)
        return []
      return [{
        key: node.key,
        language: doc?.requestedLanguage ?? 'cSharp',
        cursorLine: doc?.cursorLine,
        cursorColumn: doc?.cursorColumn,
        scrollTop: doc?.scrollTop,
      }]
    }),
    activeDocument: activeNode?.key,
    selectedNode: state.selectedNode?.key,
  }
}

function saveSession(session: SavedSession): void {
  try {
    localStorage.setItem(sessionStorageKey, JSON.stringify(session))
  } catch {
    // A full or unavailable store must not take a running session down with it.
  }
}

// Expanding a branch updates the store twice: once to show the spinner and once when the backend
// returns its children. Serialising the complete cached tree synchronously for either update blocks the
// renderer before it can paint the expanded branch. Coalesce writes once a real tree is present and do
// the tree walk after the current render has had a chance to finish. Tiny states stay synchronous so a
// freshly opened workspace is persisted immediately.
let pendingSessionSource: SessionSource | undefined
let sessionSaveTimer: ReturnType<typeof setTimeout> | undefined
const MAX_SYNC_SESSION_CHILDREN = 16

const scheduleSessionSave = (state: SessionSource): void => {
  let cachedNodeCount = 0
  for (const children of Object.values(state.children))
    cachedNodeCount += children.length
  if (cachedNodeCount <= MAX_SYNC_SESSION_CHILDREN) {
    if (sessionSaveTimer !== undefined) {
      clearTimeout(sessionSaveTimer)
      sessionSaveTimer = undefined
    }
    pendingSessionSource = undefined
    saveSession(buildSession(state))
    return
  }
  pendingSessionSource = state
  if (sessionSaveTimer !== undefined)
    return
  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = undefined
    const source = pendingSessionSource
    pendingSessionSource = undefined
    if (source)
      saveSession(buildSession(source))
  }, 50)
}

/**
 * The document tabs of a layout in the order they appear, and the selected one, both named by document
 * id. The shell reports these through `setDocumentOrder` because the layout is the shell's to read.
 */
export function orderedDocumentKeys(model: Model): { order: string[]; active?: string } {
  const order: string[] = []
  model.visitNodes((node) => {
    if (!(node instanceof TabNode) || node.getComponent() !== 'document')
      return
    const documentId = (node.getConfig() as { documentId?: string } | undefined)?.documentId
    if (documentId)
      order.push(documentId)
  })
  const documentIdOf = (tab: TabNode | undefined): string | undefined => tab?.getComponent() === 'document'
    ? (tab.getConfig() as { documentId?: string } | undefined)?.documentId
    : undefined
  let active = documentIdOf(model.getActiveTabset()?.getSelectedNode())
  // Clicking a tool window makes its tab set the active one, and it holds no document. The selected tab
  // of the first group that does stand in, so the session keeps the document that was being read.
  if (active === undefined) {
    model.visitNodes((node) => {
      if (active === undefined && node instanceof TabSetNode)
        active = documentIdOf(node.getSelectedNode())
    })
  }
  return { order, active }
}

/**
 * A dock of one window is not a tab group, so it shows no tab row of its own: the window's caption is the
 * only bar over it. Dragging a second window in beside it makes it a group, and the strip comes back along
 * the bottom edge of the pane, where the docks carry it, to switch between the two.
 *
 * The editor always shows its strip, including for a single document. Reserved document tab sets keep
 * it even while empty, for example when closing the last document or rebuilding a saved session.
 * Explicitly re-enable it for documents so a hidden strip from an older layout or dock is repaired.
 */
export function syncDockTabStrips(model: Model, documentComponents: readonly string[], documentTabSetIds: readonly string[] = []): void {
  const hides: string[] = []
  const shows: string[] = []
  model.visitNodes((node) => {
    if (!(node instanceof TabSetNode))
      return
    const children = node.getChildren()
    const isDocumentTabSet = documentTabSetIds.includes(node.getId()) || children.some((child) => {
      const component = child instanceof TabNode ? child.getComponent() : undefined
      return component !== undefined && documentComponents.includes(component)
    })
    const wanted = isDocumentTabSet || children.length > 1
    if (node.isEnableTabStrip() !== wanted)
      (wanted ? shows : hides).push(node.getId())
  })
  // The walk above reads the tree the actions below change, so the ids are collected first and the tab
  // sets that are already right are left untouched — which is also what keeps this from running twice.
  for (const id of hides)
    model.doAction(Actions.updateNodeAttributes(id, { enableTabStrip: false }))
  for (const id of shows)
    model.doAction(Actions.updateNodeAttributes(id, { enableTabStrip: true }))
}

/**
 * Persistence stays off until the startup code has decided what to do with the stored session. Without
 * that gate the store's own empty state — written the moment the module finishes evaluating — would be
 * the first thing saved, over the archive it is about to read.
 */
let sessionPersistenceEnabled = false

export const enableSessionPersistence = (): void => {
  sessionPersistenceEnabled = true
}

// The session has no commit step either, so every change that could survive a restart is written
// straight away. A restore is the exception: while one is in flight the layout is being rebuilt and
// none of that half-built state is worth keeping — only the moment it ends is.
//
// One archive for one window: a second window would share this localStorage and the two would overwrite
// each other's session. That matches where the app is today — `window-all-closed` quits on every
// platform — and a window-scoped key is the change to make if it ever keeps more than one open.
useAppStore.subscribe((state, previous) => {
  if (!sessionPersistenceEnabled || state.restoringSession)
    return
  const changed = state.workspaceId !== previous.workspaceId
    || state.modules !== previous.modules
    || state.roots !== previous.roots
    || state.children !== previous.children
    || state.parents !== previous.parents
    || state.expanded !== previous.expanded
    || state.selectedNode !== previous.selectedNode
    || state.documents !== previous.documents
    || state.documentOrder !== previous.documentOrder
    || state.activeDocumentId !== previous.activeDocumentId
    || state.restoringSession !== previous.restoringSession
  if (changed)
    scheduleSessionSave(state)
})

/** dnSpy's list holds this many files; the oldest go first. */
const MAX_RECENT_FILES = 30

/** dnSpy compares the files on its list without regard to case. */
const sameRecentFile = (left: string, right: string): boolean => left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0

/**
 * The Recent Files list, most recent first. A profile from before the list held single files kept the sets of
 * files each open made; those are read once, in order, so nothing the user opened is forgotten in the move.
 */
export function loadRecentFiles(): string[] {
  if (typeof localStorage === 'undefined')
    return []
  try {
    const stored = localStorage.getItem(recentFilesStorageKey)
    if (stored !== null) {
      const value = JSON.parse(stored) as unknown
      return Array.isArray(value) ? addRecentFiles([], value.filter((entry): entry is string => typeof entry === 'string').reverse()) : []
    }
    const legacy = JSON.parse(localStorage.getItem(legacyRecentWorkspacesStorageKey) ?? '[]') as unknown
    if (!Array.isArray(legacy))
      return []
    const files = legacy.flatMap((entry: unknown) => Array.isArray(entry) ? entry.filter((path): path is string => typeof path === 'string') : [])
    return addRecentFiles([], files.reverse())
  } catch {
    return []
  }
}

/** dnSpy's AssemblyExplorerMostRecentlyUsedList.Add, once per file in the order they were opened, so the last
 *  of them ends up first. */
const addRecentFiles = (list: readonly string[], paths: readonly string[]): string[] => {
  let files = [...list]
  for (const path of paths) {
    if (!path)
      continue
    files = [path, ...files.filter((file) => !sameRecentFile(file, path))].slice(0, MAX_RECENT_FILES)
  }
  return files
}

/** Puts the files on the Recent Files list and saves it. */
export function rememberRecentFiles(paths: readonly string[]): string[] {
  const files = addRecentFiles(loadRecentFiles(), paths)
  try {
    localStorage.setItem(recentFilesStorageKey, JSON.stringify(files))
  } catch {
    // A full or unavailable store keeps the list for this run only.
  }
  return files
}

/** The root a file opened as: the module's own row, which carries the module's id. */
const rootOfPath = (roots: readonly TreeNode[], modules: readonly OpenedModule[], path: string | undefined): TreeNode | undefined => {
  if (path === undefined)
    return undefined
  const module = modules.find((candidate) => candidate.path === path)
  return module ? roots.find((root) => root.id === module.id) : undefined
}

/**
 * The store without anything it held by node id for the documents a removal took — their documents, the rows
 * the tree listed under them, the selection on them — and with the roots and the edit history the removal left.
 * dnSpy leaves the tree on another document rather than on nothing at all.
 */
const withoutRemovedRoots = (state: AppState, response: { removedNodeIds: string[]; roots: TreeNode[]; canUndo?: boolean; canRedo?: boolean }): Partial<AppState> => {
  const removed = new Set(response.removedNodeIds)
  // The ids are never handed out again unless an undo puts the very same document back, so leaving any of
  // them behind would be a leak that could never be named, not a row that could come back.
  const withoutRemoved = <T,>(entries: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(entries).filter(([id]) => !removed.has(id)))
  const selectionWent = state.selectedNode !== undefined && removed.has(state.selectedNode.id)
  const newSelection = selectionWent ? response.roots[0] : state.selectedNode
  return {
    roots: response.roots,
    modules: state.modules.filter((module) => response.roots.some((root) => root.id === module.id)),
    documents: withoutRemoved(state.documents),
    children: withoutRemoved(state.children),
    parents: withoutRemoved(state.parents),
    expanded: withoutRemoved(state.expanded),
    loadingNodes: withoutRemoved(state.loadingNodes),
    selectedNode: newSelection,
    selectedNodes: selectionWent ? (newSelection ? [newSelection] : []) : state.selectedNodes.filter((n) => !removed.has(n.id)),
    hexTarget: selectionWent ? undefined : state.hexTarget,
    ...(response.canUndo !== undefined ? { canUndo: response.canUndo, canRedo: response.canRedo ?? false } : {}),
  }
}

// A REPL left open all day must not grow without bound; the oldest lines go first.
const MAX_SCRIPT_ENTRIES = 2000
const MAX_SCRIPT_HISTORY = 100

/** The `#`-commands the window answers itself; anything else goes to the host as code. */
const SCRIPT_COMMANDS = ['clear', 'cls', 'help', 'reset']

/**
 * The `#command` a submission is, or `undefined` when it is code to compile. Matched
 * case-sensitively and only as the first word, exactly like the window's `#` parser, so `#Help`
 * reaches the compiler and fails the way it does upstream.
 */
const scriptCommandOf = (submission: string): { name: string; args: string[] } | undefined => {
  if (!submission.startsWith('#')) return undefined
  const [name, ...args] = submission.slice(1).trimStart().split(/\s+/)
  return name !== undefined && SCRIPT_COMMANDS.includes(name) ? { name, args } : undefined
}

const appendScriptEntries = (set: StoreSet, entries: ScriptOutputEntry[]): void => {
  set((state) => ({ scriptEntries: [...state.scriptEntries, ...entries].slice(-MAX_SCRIPT_ENTRIES) }))
}

/** Throws the host's session away and reports the banner of the engine that replaced it. */
/** The semantic colors of a submission whose input had none yet; a failure only costs the echo its colors. */
const classifySubmission = async (submission: string): Promise<ClassifiedSpan[] | undefined> => {
  try {
    return (await window.dnSpy.classifyScript(submission)).spans
  } catch {
    return undefined
  }
}

/**
 * Listens for the lines the host streams while a submission runs. The window shows them as they arrive,
 * which is how a script that prints for a minute fills the log instead of answering all at once; the
 * subscription outlives every reset, since a new session streams the same way.
 */
let scriptOutputSubscribed = false
const subscribeScriptOutput = (): void => {
  if (scriptOutputSubscribed || typeof window === 'undefined' || !window.dnSpy?.onScriptOutput)
    return
  scriptOutputSubscribed = true
  window.dnSpy.onScriptOutput((notification) => useAppStore.getState().appendScriptOutput(notification))
}

const rebuildScriptSession = async (set: StoreSet, options: { loadConfig: boolean; showBanner: boolean }): Promise<void> => {
  set({ scriptRunning: true })
  try {
    const response = await window.dnSpy.resetScript(options)
    appendScriptEntries(set, response.entries)
    set({ scriptGeneration: response.generation })
  } catch (error) {
    appendScriptEntries(set, [scriptFailureEntry(error)])
  } finally {
    set({ scriptRunning: false })
  }
}

const scriptFailureEntry = (error: unknown): ScriptOutputEntry => ({
  kind: 'error',
  text: t('Script failed: {message}', { message: error instanceof Error ? error.message : String(error) }),
})

/** A row of `#help`, padded to the two-column layout the window prints. */
const helpRow = (command: string, description: string): ScriptOutputEntry => ({
  kind: 'output',
  text: `  ${command}${' '.repeat(Math.max(1, 21 - command.length))}${description}`,
})

/** The `#help` text, in the order and wording of dnSpy's HelpCommand. */
const scriptHelpEntries = (): ScriptOutputEntry[] => [
  { kind: 'help', text: t('Keyboard shortcuts:') },
  helpRow('Enter', t('Execute the command')),
  helpRow('Ctrl+Enter', t('Execute the command')),
  helpRow('Shift+Enter', t('Insert a new line')),
  helpRow('Esc', t('Clear current input')),
  helpRow('Alt+Up Arrow', t('Show previous command')),
  helpRow('Alt+Down Arrow', t('Show next command')),
  helpRow('Ctrl+Alt+Up Arrow', t('Show previous command matching the current input text')),
  helpRow('Ctrl+Alt+Down Arrow', t('Show next command matching the current input text')),
  helpRow('Ctrl+A', t('Select input text. Press again to select all text')),
  { kind: 'help', text: t('REPL commands:') },
  helpRow('#clear, #cls', t('Clear the script editor')),
  helpRow('#help', t('Display the help')),
  helpRow('#reset', t('Reset the execution environment')),
  { kind: 'help', text: t('Script directives:') },
  helpRow('#r', t('Add a reference, either an assembly or a path to a file on disk, #r "myfile.dll"')),
  helpRow('#load', t('Load and execute a script, #load "myscript.csx"')),
]

type StoreGet = () => AppState
type StoreSet = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void

/** The canned bodies dnSpy's three hex write commands install. */
export type HexBodyKind = 'returnTrue' | 'returnFalse' | 'empty'

/** Bumped for every jump request, so asking for the same range twice still moves the caret. */
let hexNavigationToken = 0

const decodeBase64 = (data: string): Uint8Array => {
  const binary = atob(data)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

const bytesToBase64 = (data: Uint8Array): string => {
  let binary = ''
  for (const byte of data)
    binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** dnSpy's hexadecimal text: two uppercase digits per byte and nothing in between. */
export const bytesToHex = (data: Uint8Array): string =>
  Array.from(data, (value) => value.toString(16).toUpperCase().padStart(2, '0')).join('')

/**
 * Parses dnSpy's hexadecimal text back into bytes. `?` is a zero nibble, as in dnSpy's own parser, and
 * anything that is not an even run of hexadecimal digits is refused — the same rules its paste applies.
 */
export const parseHexText = (text: string): Uint8Array | undefined => {
  if (text.length === 0 || text.length % 2 !== 0)
    return undefined
  const data = new Uint8Array(text.length / 2)
  for (let index = 0; index < text.length; index += 2) {
    const high = parseNibble(text[index])
    const low = parseNibble(text[index + 1])
    if (high < 0 || low < 0)
      return undefined
    data[index / 2] = (high << 4) | low
  }
  return data
}

const parseNibble = (character: string): number => {
  if (character === '?')
    return 0
  const value = Number.parseInt(character, 16)
  return Number.isFinite(value) && value >= 0 && value <= 15 ? value : -1
}

/** Queues one byte patch and commits it, which is how every hex write command lands. */
const writeHexPatch = async (
  get: StoreGet,
  set: StoreSet,
  nodeId: string,
  offset: number,
  base64Data: string,
  message: string,
): Promise<boolean> => {
  const workspaceId = get().workspaceId
  if (!workspaceId)
    return false
  set({ busy: true, error: undefined })
  let transactionId: string | undefined
  try {
    transactionId = (await window.dnSpy.beginEdit(workspaceId)).transactionId
    await window.dnSpy.patchHex(workspaceId, transactionId, nodeId, offset, base64Data)
    const committed = await window.dnSpy.commitEdit(workspaceId, transactionId)
    await refreshAfterEdit(get, set, committed)
    get().appendOutput(message)
    return true
  } catch (error) {
    if (transactionId) {
      try { await window.dnSpy.rollbackEdit(workspaceId, transactionId) } catch { /* already committed or invalidated */ }
    }
    const reason = error instanceof Error ? error.message : String(error)
    set({ error: reason })
    get().appendOutput(t('Hex edit failed: {message}', { message: reason }))
    return false
  } finally {
    set({ busy: false })
  }
}

// The modules a debug stop has already asked for, kept per workspace: a file that cannot be opened must
// not be asked for again on every stop, and a workspace the user opens next deserves a fresh question.
let autoOpenedModules: { workspaceId?: string; paths: Set<string> } = { paths: new Set() }

/**
 * Opens a module a stop landed in, and reads the stack again so the frames that were in it resolve to
 * lines. Answers whether the frames were read again, which is only ever true when a module was really
 * added — a path already asked for, or one the backend could not open, answers false.
 */
const openDebugModule = async (get: StoreGet, set: StoreSet, path: string, name: string): Promise<boolean> => {
  const { workspaceId } = get()
  if (!workspaceId) return false
  if (autoOpenedModules.workspaceId !== workspaceId)
    autoOpenedModules = { workspaceId, paths: new Set() }
  if (autoOpenedModules.paths.has(path)) return false
  autoOpenedModules.paths.add(path)
  try {
    const added = await window.dnSpy.addModules(workspaceId, [path])
    const roots = await window.dnSpy.getRoots(workspaceId)
    set({ modules: added.modules, roots: roots.nodes })
    get().appendOutput(t('Loaded {name} for the stopped location.', { name }))
  } catch {
    // The file is gone, or is not a module dnSpy can read. The stop keeps the identity it has — a
    // module and a token — and nothing else changes.
    return false
  }
  // The frame the user switched to stays the active one: the module was opened for it.
  await refreshDebugState(get, set, get().selectedDebugThreadId, { keepFrame: get().activeDebugFrameId })
  return true
}

/** dnSpy's DbgModuleBreakpointSettings: a row of the Module Breakpoints window. Empty text matches anything. */
export interface ModuleBreakpoint {
  id: string
  enabled: boolean
  moduleName: string
  isDynamic?: boolean
  isInMemory?: boolean
  isLoaded?: boolean
  order?: number
  appDomainName?: string
  processName?: string
}

/** What the last launch was started with, for Restart. */
let lastLaunchOptions: DebugLaunchOptions | undefined

const moduleBreakpointsStorageKey = 'dnspy.moduleBreakpoints.v1'

const syncModuleBreakpoints = async (get: StoreGet): Promise<void> => {
  const { debugSessionId, moduleBreakpoints } = get()
  if (!debugSessionId) return
  try {
    await window.dnSpy.setDebugModuleBreakpoints?.(debugSessionId, moduleBreakpoints.filter((row) => row.enabled).map(({ id: _id, enabled: _enabled, ...settings }) => settings))
  } catch {
    // An engine without module breakpoints just never stops on a load.
  }
}

const loadModuleBreakpoints = (): ModuleBreakpoint[] => {
  if (typeof localStorage === 'undefined') return []
  try {
    const stored = JSON.parse(localStorage.getItem(moduleBreakpointsStorageKey) ?? '[]') as unknown
    return Array.isArray(stored)
      ? stored.filter((row): row is ModuleBreakpoint => typeof row === 'object' && row !== null && typeof (row as ModuleBreakpoint).id === 'string')
      : []
  } catch {
    return []
  }
}

// Read back after the module has finished evaluating, for the same reason the breakpoints are.
queueMicrotask(() => {
  useAppStore.setState({ moduleBreakpoints: loadModuleBreakpoints() })
  useAppStore.subscribe((state, previous) => {
    if (state.moduleBreakpoints !== previous.moduleBreakpoints && typeof localStorage !== 'undefined')
      localStorage.setItem(moduleBreakpointsStorageKey, JSON.stringify(state.moduleBreakpoints))
  })
})

/** The engine's share of the Options dialog's Debugger page, and the variables windows' display toggles. */
const pushDebuggerOptions = async (): Promise<void> => {
  try {
    await window.dnSpy.setDebuggerOptions?.({ ...loadAppOptions().debugger })
  } catch {
    // An engine that cannot take options keeps its defaults, which are dnSpy's.
  }
}

/** What the Call Stack window asks the engine to write: its own display settings and the shared hex toggles. */
const stackFrameFormat = (): DebugStackFrameFormat => {
  const options = loadAppOptions()
  return { ...options.callStack, useHexadecimal: options.debugger.useHexadecimal, useDigitSeparators: options.debugger.useDigitSeparators }
}

const endDebugSession = async (get: StoreGet, set: StoreSet, terminateDebuggee: boolean): Promise<void> => {
  const sessionId = get().debugSessionId
  if (!sessionId) return
  try { await window.dnSpy.disconnectDebug(sessionId, terminateDebuggee) } catch { /* adapter may exit before replying */ }
  set({ debugState: 'inactive', debugSessionId: undefined, debugThreads: [], debugFrames: [], debugVariables: [], debugModules: [], watchValues: [], otherWatchValues: {}, debugProcess: undefined, stoppedLocation: undefined, selectedDebugFrameId: undefined, activeDebugFrameId: undefined })
}

const refreshDebugState = async (get: StoreGet, set: StoreSet, preferredThreadId?: number, options?: { keepFrame?: number }): Promise<void> => {
  const sessionId = get().debugSessionId
  if (!sessionId) return
  try {
    const threads = await window.dnSpy.getDebugThreads(sessionId)
    const threadId = preferredThreadId ?? threads[0]?.id
    const [frames, modules, process] = await Promise.all([
      threadId === undefined ? Promise.resolve([]) : window.dnSpy.getDebugStackTrace(sessionId, threadId, stackFrameFormat()),
      window.dnSpy.getDebugModules(sessionId).catch(() => []),
      window.dnSpy.getDebugProcess?.(sessionId).catch(() => undefined),
    ])
    // Every stop starts on the frame the runtime is in, which is the one the user has to switch away from
    // to read a caller — WPF's ActiveFrameIndex is reset the same way. Re-reading the same stop in a new
    // format keeps the frame the user switched to: the ids of a stop are stable until the process runs.
    const frameId = options?.keepFrame !== undefined && frames.some((frame) => frame.id === options.keepFrame) ? options.keepFrame : frames[0]?.id
    set({ debugThreads: threads, selectedDebugThreadId: threadId, debugFrames: frames, selectedDebugFrameId: frameId, activeDebugFrameId: frameId, debugModules: modules, debugProcess: process ?? get().debugProcess })
    if (frameId !== undefined)
      await refreshDebugVariables(get, set, frameId)
  } catch (error) {
    get().appendOutput(t('Could not refresh debugger state: {message}', { message: error instanceof Error ? error.message : String(error) }))
  }
}

const refreshDebugVariables = async (get: StoreGet, set: StoreSet, frameId: number): Promise<void> => {
  const sessionId = get().debugSessionId
  if (!sessionId) return
  const scopes = await window.dnSpy.getDebugScopes(sessionId, frameId)
  const localScope = scopes.find((scope) => scope.name === 'Locals') ?? scopes.find((scope) => !scope.expensive)
  const variables = localScope ? await window.dnSpy.getDebugVariables(sessionId, localScope.variablesReference) : []
  set((state) => ({ debugVariables: variables, debugGeneration: state.debugGeneration + 1 }))
  await refreshWatches(get, set)
}

// One empty list for every window that has none, so a selector reading it answers the same array each time.
const NO_WATCHES: string[] = []
const NO_WATCH_VALUES: DebugVariable[] = []

/** The expressions of one Watch window. */
export const watchList = (state: Pick<AppState, 'watches' | 'otherWatches'>, window: number): string[] =>
  window === 1 ? state.watches : state.otherWatches[window] ?? NO_WATCHES

/** The values of one Watch window, as the last stop read them. */
export const watchValueList = (state: Pick<AppState, 'watchValues' | 'otherWatchValues'>, window: number): DebugVariable[] =>
  window === 1 ? state.watchValues : state.otherWatchValues[window] ?? NO_WATCH_VALUES

const withWatchList = (state: AppState, window: number, list: string[]): Partial<AppState> =>
  window === 1 ? { watches: list } : { otherWatches: { ...state.otherWatches, [window]: list } }

const withWatchValues = (state: AppState, window: number, list: DebugVariable[]): Partial<AppState> =>
  window === 1 ? { watchValues: list } : { otherWatchValues: { ...state.otherWatchValues, [window]: list } }

const refreshWatches = async (get: StoreGet, set: StoreSet): Promise<void> => {
  const { debugSessionId, activeDebugFrameId, watches, otherWatches } = get()
  if (!debugSessionId || activeDebugFrameId === undefined || get().debugState !== 'stopped') return
  // The Watch window's name column is the expression as the user typed it, whatever the engine names the row.
  const evaluate = (expressions: string[]): Promise<DebugVariable[]> => Promise.all(expressions.map(async (expression): Promise<DebugVariable> => {
    try {
      const value = await window.dnSpy.evaluateDebugExpression(debugSessionId, activeDebugFrameId, expression)
      return { ...value, name: expression, nameParts: undefined, evaluateName: value.evaluateName ?? expression }
    } catch (error) {
      return { name: expression, value: error instanceof Error ? error.message : String(error), variablesReference: 0, isError: true }
    }
  }))
  const others = await Promise.all(Object.entries(otherWatches).map(async ([key, list]) => [Number(key), await evaluate(list)] as const))
  set({ watchValues: await evaluate(watches), otherWatchValues: Object.fromEntries(others) })
}

// Disabled breakpoints are deliberately left out of what we send: the debug adapter only knows
// about the breakpoints it was last given, so omitting them is what "disables" them.
const enabledFunctionBreakpointRequests = (breakpoints: FunctionBreakpoint[]): { name: string; settings?: BreakpointSettings }[] =>
  breakpoints.filter((breakpoint) => breakpoint.enabled).map((breakpoint) => ({ name: breakpoint.name, settings: breakpoint.settings }))

const syncFunctionBreakpoints = async (get: StoreGet): Promise<void> => {
  const { debugSessionId, functionBreakpoints } = get()
  if (debugSessionId)
    await window.dnSpy.setFunctionBreakpoints(debugSessionId, enabledFunctionBreakpointRequests(functionBreakpoints))
}

// Line breakpoints are sent as the whole set every time, including the disabled ones: the engine can arm and disarm
// a breakpoint in place, so "disabled" does not have to mean "forgotten", and re-enabling one does not have to be
// resolved from scratch. The reply is what the editor draws — the snapped line, and whether it bound at all.
const syncLineBreakpoints = async (get: StoreGet, set: StoreSet): Promise<void> => {
  const { debugSessionId, lineBreakpoints } = get()
  if (!debugSessionId) return
  const requested = lineBreakpoints.map((breakpoint) => ({
    id: breakpoint.id,
    nodeId: breakpoint.nodeId,
    line: breakpoint.requestedLine,
    enabled: breakpoint.enabled,
    // A breakpoint restored from settings has no node id left — it belonged to the workspace that saved
    // it — so the location it was saved with goes along for the backend to resolve from instead.
    modulePath: breakpoint.modulePath,
    metadataToken: breakpoint.metadataToken,
    sourceMethodToken: breakpoint.sourceMethodToken,
    ilOffset: breakpoint.ilOffset,
    settings: breakpoint.settings,
  }))
  const results = await window.dnSpy.setBreakpoints(debugSessionId, requested)
  const byId = new Map(results.map((result) => [result.id, result]))
  set((state) => ({
    lineBreakpoints: state.lineBreakpoints.map((breakpoint) => {
      const result = byId.get(breakpoint.id)
      return result ? applyBreakpointResult(breakpoint, result) : breakpoint
    }),
  }))
}

const applyBreakpointResult = (breakpoint: LineBreakpoint, result: DebugBreakpoint): LineBreakpoint => {
  const modulePath = result.modulePath || breakpoint.modulePath
  const ilOffset = result.ilOffset >= 0 ? result.ilOffset : breakpoint.ilOffset
  return {
    ...breakpoint,
    // Once the engine has named the module and offset, matching by IL identity is what keeps a later click on the
    // snapped line pointing at this same breakpoint.
    identity: modulePath !== undefined && ilOffset !== undefined
      ? statementIdentity(modulePath, result.metadataToken, ilOffset)
      : breakpoint.identity,
    line: result.line || breakpoint.requestedLine,
    endLine: result.endLine || result.line || breakpoint.requestedLine,
    state: result.state,
    message: result.message,
    enabled: result.enabled,
    description: result.description ?? breakpoint.description,
    modulePath,
    metadataToken: result.metadataToken || breakpoint.metadataToken,
    sourceMethodToken: result.sourceMethodToken || breakpoint.sourceMethodToken,
    ilOffset,
    // The count lives in the engine, which carries it across a re-send, so the client only mirrors it.
    hitCount: result.hitCount ?? breakpoint.hitCount,
  }
}

/**
 * Renames a namespace, or empties its types into the unnamed namespace when `newName` is blank — dnSpy
 * reaches both through the same backend operation, so the two menu commands share this one path.
 */
const setNamespaceEdit = async (get: StoreGet, set: StoreSet, node: TreeNode, newName: string): Promise<boolean> => {
  const workspaceId = get().workspaceId
  if (!workspaceId)
    return false
  set({ busy: true, error: undefined })
  let transactionId: string | undefined
  try {
    transactionId = (await window.dnSpy.beginEdit(workspaceId)).transactionId
    await window.dnSpy.queueSetNamespace(workspaceId, transactionId, node.id, newName)
    const committed = await window.dnSpy.commitEdit(workspaceId, transactionId)
    await refreshAfterEdit(get, set, committed)
    // The namespace node is keyed by its name, so the renamed one is a different node from here on and
    // the stale entry keeps the old label; relabelling keeps the selection pane matching the tree.
    set((state) => ({
      selectedNode: state.selectedNode?.id === node.id
        ? { ...state.selectedNode, label: newName === '' ? '-' : newName }
        : state.selectedNode,
    }))
    get().appendOutput(newName === ''
      ? t('Moved the types of {name} to the empty namespace.', { name: node.label })
      : t('Renamed namespace {oldName} to {newName}.', { oldName: node.label, newName }))
    return true
  } catch (error) {
    if (transactionId) {
      try { await window.dnSpy.rollbackEdit(workspaceId, transactionId) } catch { /* already committed or invalidated */ }
    }
    const message = error instanceof Error ? error.message : String(error)
    set({ error: message })
    get().appendOutput(t('Namespace edit failed: {message}', { message }))
    return false
  } finally {
    set({ busy: false })
  }
}

/** Node kinds that can only live inside a type. */
const MEMBER_KINDS = new Set(['method', 'field', 'property', 'event'])

/** Every node the tree has listed, by id. A walk up the parent chain needs the kinds of what it passes. */
export function nodesByIdOf(roots: TreeNode[], children: Record<string, TreeNode[]>): Map<string, TreeNode> {
  const nodes = new Map<string, TreeNode>()
  for (const root of roots)
    nodes.set(root.id, root)
  for (const list of Object.values(children))
    for (const node of list)
      nodes.set(node.id, node)
  return nodes
}

/**
 * The type a create-member command acts on. dnSpy offers those commands for a selected type *or* any
 * member of one, and a member's owner is the type that declares it — whatever the tree nests it under,
 * so a getter listed beneath its property still resolves to the type that holds both. Undefined for
 * anything else — a namespace, a reference, or no selection at all.
 */
export const ownerTypeIdOf = (
  nodesById: Map<string, TreeNode>,
  parents: Record<string, string>,
  node: TreeNode | undefined,
): string | undefined => {
  if (!node)
    return undefined
  if (node.kind === 'type')
    return node.id
  if (!MEMBER_KINDS.has(node.kind))
    return undefined
  for (let id = parents[node.id]; id !== undefined; id = parents[id]) {
    const ancestor = nodesById.get(id)
    if (ancestor?.kind === 'type')
      return id
    // A node the tree has not listed — a member reached by its identity before its owner was expanded.
    if (ancestor === undefined || !MEMBER_KINDS.has(ancestor.kind))
      return undefined
  }
  return undefined
}

const refreshChildren = async (get: StoreGet, set: StoreSet, nodeId: string): Promise<void> => {
  const workspaceId = get().workspaceId
  if (!workspaceId) return
  const refreshed = await window.dnSpy.getChildren(workspaceId, nodeId)
  set((state) => ({ children: { ...state.children, [nodeId]: refreshed.nodes } }))
}

/**
 * What an edit, undo or redo leaves modified: the documents the backend names, which an undo back to where a
 * document was saved takes off again. An answer without them — a step that never reached the backend's history —
 * keeps the workspace-wide comparison the port had before documents were tracked one by one.
 */
const modifiedFrom = (result: Pick<EditCommitResponse, 'stateId' | 'modifiedDocuments'>, state: Pick<AppState, 'savedStateId' | 'modifiedDocuments'>): Pick<AppState, 'dirty' | 'modifiedDocuments'> =>
  result.modifiedDocuments
    ? { modifiedDocuments: result.modifiedDocuments, dirty: result.modifiedDocuments.length > 0 }
    : { modifiedDocuments: state.modifiedDocuments, dirty: result.stateId !== state.savedStateId }

const refreshAfterEdit = async (get: StoreGet, set: StoreSet, result: EditCommitResponse): Promise<string[]> => {
  const { workspaceId } = get()
  if (!workspaceId) return []
  set({
    workspaceStateId: result.stateId,
    ...modifiedFrom(result, get()),
    canUndo: result.canUndo,
    canRedo: result.canRedo,
  })
  const parentIds = new Set<string>()
  for (const nodeId of result.changedNodeIds) {
    const parentId = get().parents[nodeId]
    if (parentId) parentIds.add(parentId)
    try {
      const node = await window.dnSpy.getNode(workspaceId, nodeId)
      if (get().selectedNode?.id === nodeId) {
        set({ selectedNode: node, selectedNodes: [node] })
      }
      const document = get().documents[nodeId]
      if (document)
        await get().openDocument(node, document.requestedLanguage)
    } catch {
      // A removed metadata item may no longer have a view model.
    }
  }
  for (const parentId of parentIds) {
    const refreshed = await window.dnSpy.getChildren(workspaceId, parentId)
    set((state) => ({ children: { ...state.children, [parentId]: refreshed.nodes } }))
  }
  // A root row's label is read off the document it names, and an edit can change what that is — converting
  // an assembly to a net module leaves the row above the module with no assembly left to name. The roots
  // are read back for every edit rather than guessed at, so undo and redo move the label with the state.
  const roots = await window.dnSpy.getRoots(workspaceId)
  const modules = result.modules
  if (!modules) {
    set({ roots: roots.nodes })
    return []
  }
  // A step that took a whole document out of the tree, or put one back — a removal dnSpy recorded in the
  // history. What the client held for a document that went is dropped the way the removal itself drops it; a
  // document that came back is the very same one, under the ids it had, and simply lists its rows again.
  const kept = new Set(roots.nodes.map((root) => root.id))
  const gone = get().roots.filter((root) => !kept.has(root.id)).map((root) => root.id)
  const removed = nodeIdsUnder(get(), gone)
  set((state) => ({
    ...withoutRemovedRoots(state, { removedNodeIds: removed, roots: roots.nodes }),
    modules,
    assemblyListRevision: state.assemblyListRevision + 1,
  }))
  return removed
}

/**
 * The Compiler options page's values for a language, as the backend's compiler takes them. dnSpy reads them when an
 * Edit Code window builds its compiler, so a change on the page applies to the next window opened.
 */
export const compilerSettingsFor = (language: CompilerLanguage): CompilerSettings => {
  const page = loadAppOptions().compiler[language === 'visualBasic' ? 'visualBasic' : 'cSharp']
  return {
    preprocessorSymbols: page.preprocessorSymbols,
    optimize: page.optimize,
    checkOverflow: page.checkOverflow,
    allowUnsafe: page.allowUnsafe,
    optionExplicit: page.optionExplicit,
    optionInfer: page.optionInfer,
    optionStrict: page.optionStrict,
    optionCompareBinary: page.optionCompareBinary,
    embedVisualBasicRuntime: page.embedVBRuntime,
  }
}

/** The language dnSpy's compiler commands use: the decompiler's when it has a compiler, C# otherwise —
 *  EditCodeVMCreator.TryGetUsedLanguage. */
export const compilerLanguageFor = (language: DecompilerLanguage): CompilerLanguage => language === 'visualBasic' ? 'visualBasic' : 'csharp'

/** The id dnSpy's Copy IL Bytes gives its "some bytes are unknown" message, which "don't show again" silences. */
const UNKNOWN_IL_BYTES_ID = '141A1744-13CD-4835-A804-08D93D8E0D2B'

/** The root a node hangs under, by the parent links the tree has read. */
const rootIdOf = (state: Pick<AppState, 'parents'>, nodeId: string): string => {
  let current = nodeId
  for (let parent = state.parents[current]; parent !== undefined; parent = state.parents[current])
    current = parent
  return current
}

/**
 * One of the commands that make a document or change an assembly's modules, run as one undoable step: queued,
 * committed, the tree read again — the roots, and the children of `refreshId` when a row was added under it — and the
 * new row, when there is one, selected the way dnSpy's FollowReference selects it.
 */
const queueDocumentEdit = async (
  get: StoreGet,
  set: StoreSet,
  workspaceId: string,
  queue: (transactionId: string) => Promise<{ nodeId: string; label: string } | undefined>,
  description: string,
  refreshId?: string,
): Promise<boolean> => {
  set({ busy: true, error: undefined })
  let transactionId: string | undefined
  try {
    transactionId = (await window.dnSpy.beginEdit(workspaceId)).transactionId
    const created = await queue(transactionId)
    const committed = await window.dnSpy.commitEdit(workspaceId, transactionId)
    await refreshAfterEdit(get, set, committed)
    if (refreshId)
      await refreshChildren(get, set, refreshId)
    if (created) {
      await get().revealNode(created.nodeId)
    }
    get().appendOutput(t('{command}: {name}.', { command: description, name: created?.label ?? '' }))
    return true
  } catch (error) {
    if (transactionId) {
      try { await window.dnSpy.rollbackEdit(workspaceId, transactionId) } catch { /* already committed or invalidated */ }
    }
    const message = error instanceof Error ? error.message : String(error)
    set({ error: message })
    get().appendOutput(t('{command} failed: {message}', { command: description, message }))
    return false
  } finally {
    set({ busy: false })
  }
}

/** Who is waiting for a save window to go, by the request it put up. */
const saveResolvers = new Map<number, (savedAll: boolean) => void>()
let nextSaveRequestId = 0

/** The save options of the documents the ids name, each document once however many of its rows were named. */
const resolveSaveDocuments = async (get: StoreGet, set: StoreSet, ids: string[]): Promise<DocumentSaveOptions[] | undefined> => {
  const workspaceId = get().workspaceId
  if (!workspaceId)
    return undefined
  try {
    const resolved = await Promise.all(ids.map((id) => window.dnSpy.getSaveOptions(workspaceId, id)))
    const seen = new Set<string>()
    return resolved.filter((document) => !seen.has(document.documentId) && seen.add(document.documentId) !== undefined)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    set({ error: message })
    get().appendOutput(t('Save failed: {message}', { message }))
    return undefined
  }
}

/** Puts the save windows up for the documents and answers once they are gone: dnSpy's DocumentSaver.Save. */
const showSave = (get: StoreGet, set: StoreSet, documents: DocumentSaveOptions[]): Promise<boolean> => {
  if (documents.length === 0)
    return Promise.resolve(true)
  // One window at a time, as dnSpy's are modal: a second request is answered as not saved.
  if (get().saveRequest)
    return Promise.resolve(false)
  const id = ++nextSaveRequestId
  return new Promise((resolve) => {
    saveResolvers.set(id, resolve)
    set({ saveRequest: documents.length === 1
      ? { id, documents, mode: 'single', phase: 'options' }
      : { id, documents, mode: 'multiple', phase: 'run' } })
  })
}

/** The roots and every node the client has listed under them. */
const nodeIdsUnder = (state: Pick<AppState, 'parents' | 'documents'>, rootIds: readonly string[]): string[] => {
  const roots = new Set(rootIds)
  if (roots.size === 0)
    return []
  const rootOf = (id: string): string => {
    let current = id
    for (let parent = state.parents[current]; parent !== undefined; parent = state.parents[current])
      current = parent
    return current
  }
  const ids = new Set(rootIds)
  for (const id of [...Object.keys(state.parents), ...Object.keys(state.documents)]) {
    if (roots.has(rootOf(id)))
      ids.add(id)
  }
  return [...ids]
}
