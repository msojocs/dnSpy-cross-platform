import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Actions, DockLocation, I18nLabelDefaults, Layout, Model, Orientation, RowNode, TabNode, TabSetNode, type IJsonModel } from 'flexlayout-react'
import { isLocalSpan, type AddressReference, type AppCommandLine, type CompilerMode, type DecompilerLanguage, type HexRange, type ResourceCreateKind, type SearchLocation, type SearchType, type TextSpan, type TreeNode } from '../../shared/protocol'
import { resolveCultureArgument } from '../../shared/ui-locales'
import { buildSession, clipboardHexLength, codeHexContextOf, debugSessionIds, enableSessionPersistence, findNode, loadSession, methodBreakpointName, nodesByIdOf, orderedDocumentKeys, ownerTypeIdOf, syncDockTabStrips, useAppStore, type SavedSession, codeStatementAt, type MethodBreakpointTarget, type BreakpointSettings, type HexBodyKind } from './app-store'
import { useShallow } from 'zustand/react/shallow'
import { bookmarkChords, clearBookmarks, clearBookmarksInDocument, showBookmarksWindow, stepBookmark, toggleBookmarkAtCaret, toggleBookmarkEnabledAtCaret } from './bookmark-commands'
import { parseToolWindowInfos, resolveDecompilerLanguage, resolveSearchLocation, resolveSearchType, resolveThemeName, toolWindowIdForGuid, type ToolWindowLocation } from './command-line-options'
import { askDeleteAllBreakpointsId, askIgnorableMessage } from './message-box'
import { DELETE_COMMANDS, DELETE_QUESTION_ID, deletionTargets } from './components/delete-commands'
import { normalizeZoom, zoomIn, zoomOut } from './zoom'
import { CloseGlyph } from './components/DsGlyphs'
import { DsIcon } from './components/DsIcon'
import { APP_OPTIONS_CHANGED_EVENT, loadAppOptions, saveAppOptions, useAppOptions } from './components/app-options'
import { AssemblyExplorer, GROUP_FOLDER_KINDS, resolveAnalyzeTargets } from './components/AssemblyExplorer'
import { hasEmptyNamespaceSibling as namespaceHasEmptySibling, type AssemblyExplorerCommands } from './components/AssemblyExplorerContextMenu'
import { MenuBar } from './components/MenuBar'
import type { ThemeName } from './components/app-options'
import { applyTheme, resolveTheme, themeKey, useThemes } from './theme-service'
import { ToolBar } from './components/ToolBar'
import { OutputPane } from './components/ToolWindows'
import { SearchPane, type SearchPaneCommands } from './components/SearchPane'
import { AnalyzerPane, type AnalyzerPaneCommands } from './components/AnalyzerPane'
import { isAnalyzableNode } from './components/CodeEditorContextMenu'
import { useAnalyzerStore } from './analyzer-store'
import { useSearchStore, updateSearchSettings } from './search-store'
import { useStringReferencesStore } from './string-references-store'
import { CSharpInteractive } from './components/CSharpInteractive'
import { GoToTokenDialog, RenameDialog, RenameNamespaceDialog } from './components/EditDialogs'
import { MethodBodyDialog } from './components/MethodBodyDialog'
import { CreateResourceDialog, CreateImageListDialog, CreateResourceElementDialog, ResourceElementDialog, ResourceOptionsDialog } from './components/ResourceDialogs'
import { AssemblyOptionsDialog, ModuleOptionsDialog } from './components/AssemblyModuleDialogs'
import { SaveModuleOptionsDialog } from './components/SaveModuleOptionsDialog'
import { SaveModulesDialog } from './components/SaveModulesDialog'
import { NetModuleOptionsDialog } from './components/NetModuleOptionsDialog'
import { ExportToProjectDialog } from './components/ExportToProjectDialog'
import { canExportToProject } from './components/export-project'
import { EditCodeDialog } from './components/EditCodeDialog'
import { BreakpointSettingsDialog } from './components/BreakpointSettingsDialog'
import { HexView, ModuleInfoView } from './components/SpecialDocuments'
import type { HexViewUiState } from './components/HexEditor'
import { HEX_STRUCTURE_KINDS, HexStructureView } from './components/HexStructureView'
import { MetadataTableView } from './components/MetadataTableView'
import { AskDialog } from './components/AskDialog'
import { hasMetadataTables } from './metadata-table'
import { AutosPane, BreakpointsPane, CallStackPane, LocalsPane, ModuleBreakpointsPane, ModulesPane, ProcessesPane, StaticFieldsPane, ThreadsPane, WatchPane } from './components/DebugToolWindows'
import { DisassemblyDocumentView, MemoryPane } from './components/DebugNativeWindows'
import { ExceptionSettingsPane } from './components/ExceptionSettingsPane'
import { StringReferencesPane, type StringReferencesPaneCommands } from './components/StringReferencesPane'
import { BookmarksPane } from './components/BookmarksPane'
import { AttachDialog } from './components/AttachDialog'
import { DebugProgramDialog } from './components/DebugProgramDialog'
import { AboutDialog } from './components/AboutDialog'
import { OpenFromGacDialog } from './components/OpenFromGacDialog'
import { OpenListDialog } from './components/OpenListDialog'
import { loadDocumentLists, rememberCurrentDocuments, saveDocumentLists, type DocumentList, type StoredDocumentLists } from './document-lists'
import { WindowsDialog, type WindowTabEntry } from './components/WindowsDialog'
import { NodeOptionsDialog } from './components/NodeOptionsDialog'
import { OptionsDialog } from './components/OptionsDialog'
import { BackgroundImage } from './components/BackgroundImage'
import { HEX_FILE_PREFIX, cloneDocumentTab, closeAllDocumentTabs, closeDocumentTab, closeDocumentTabsFor, createDocumentTabGroup, getDocumentTabMenuState, getDocumentTabSets, getDocumentTabs, isToolWindowTab, showDocumentTabContextMenu } from './components/DocumentTabContextMenu'
import { showToolWindowTabContextMenu } from './components/ToolWindowTabContextMenu'
import { DockPane } from './components/DockPane'
// Only the interface: the component itself is loaded lazily, when a document tab first draws one.
import type { DocumentViewCommands } from './components/DocumentView'
import type { ActiveDocument, CreatedKind } from './components/edit-menu'
import { treeHexContext, type HexBodyTarget, type HexContextParts } from './components/hex-menu'
import { caretPosition, documentEditorScrollTop, findInActiveDocumentEditor, focusDocumentEditor } from './editor-registry'
import { setDocumentViewerZoom, toggleDocumentViewerOption } from './components/document-viewer-options'
import { positionAt } from './document-viewer'
import { translate, useLanguage } from './localization'
import { documentIdOf, documentTitleOf, documentToolTipOf, nodeIdsOfDocument, topLevelSelection } from './document-ids'

/**
 * What a document tab draws for the node it shows: dnSpy's AsmEditor hex nodes are not text — a PE header, the
 * tables stream header and a metadata row are forms of fields, and a metadata table is a grid — while every other
 * node is decompiled into the code viewer.
 */
const DocumentPane = ({ documentId, zoomStyle, onShowHex, renderCode }: {
  documentId: string
  zoomStyle: React.CSSProperties
  onShowHex(moduleId: string, offset: number, length: number): void
  renderCode(): React.ReactNode
}): React.ReactNode => {
  // A hex structure shows itself only in a tab of its own; beside other nodes it is text (IDecompileSelf is asked
  // of a lone node only).
  const nodeId = useAppStore((state) => (state.documents[documentId]?.nodeIds?.length ?? 1) === 1 ? state.documents[documentId]?.nodeId : undefined)
  const kind = useAppStore((state) => {
    const id = (state.documents[documentId]?.nodeIds?.length ?? 1) === 1 ? state.documents[documentId]?.nodeId : undefined
    return id ? findNode(state, id)?.kind : undefined
  })
  if (nodeId && kind && HEX_STRUCTURE_KINDS.has(kind))
    return <div className="tab-zoom" style={zoomStyle}><HexStructureView key={nodeId} nodeId={nodeId} /></div>
  if (nodeId && kind === 'metadatatable')
    return <div className="tab-zoom" style={zoomStyle}><MetadataTableView key={nodeId} nodeId={nodeId} onShowHex={onShowHex} /></div>
  return renderCode()
}

const DocumentView = lazy(async () => {
  const module = await import('./components/DocumentView')
  return { default: module.DocumentView }
})

/** The three columns the window is made of: the Assembly Explorer down the left edge, and — beside it —
 * the editor with the tool windows under it. None of them is a border: a border carries its tabs down the
 * outer edge of the window, while dnSpy's explorer wears its title across the top of its own column. */
const EXPLORER_TABSET_ID = 'explorer-dock'
const DOCUMENT_TABSET_ID = 'documents'
const TOOL_WINDOW_TABSET_ID = 'toolwindows'
/** The column the editor and the tool windows share. The explorer goes back in to the left of it, which
 * is the only way to ask for a column the height of both of them. */
const EDITOR_COLUMN_ID = 'editor-column'
/** What the explorer's column weighs against the 100 the rest of the window weighs — a little under a
 * third of the width. */
const EXPLORER_WEIGHT = 43

/** What the window opens in its editor, as against what it docks: dnSpy's editor gives a document its title
 * in the tab strip and nothing else, so these are the panes that go without a caption over them. */
const DOCUMENT_COMPONENTS = ['document', 'hex', 'module-info', 'disassembly-document', 'start']

/** The tabs the View menu can bring back, with the label and component each one needs. The explorer opens
 * in the column on the left; everything else belongs to the tool window tab set. */
const restorableTabs: Record<string, { name: string; component: string }> = {
  explorer: { name: 'Assembly Explorer', component: 'explorer' },
  output: { name: 'Output', component: 'output' },
  'csharp-interactive': { name: 'C# Interactive', component: 'csharp-interactive' },
  search: { name: 'Search', component: 'search' },
  analysis: { name: 'Analyzer', component: 'analysis' },
  'string-references': { name: 'String References', component: 'string-references' },
  locals: { name: 'Locals', component: 'locals' },
  'exception-settings': { name: 'Exception Settings', component: 'exception-settings' },
  watch: { name: 'Watch 1', component: 'watch' },
  'watch-2': { name: 'Watch 2', component: 'watch' },
  'watch-3': { name: 'Watch 3', component: 'watch' },
  'watch-4': { name: 'Watch 4', component: 'watch' },
  callstack: { name: 'Call Stack', component: 'callstack' },
  breakpoints: { name: 'Breakpoints', component: 'breakpoints' },
  bookmarks: { name: 'Bookmarks', component: 'bookmarks' },
  threads: { name: 'Threads', component: 'threads' },
  modules: { name: 'Modules', component: 'modules' },
  'module-breakpoints': { name: 'Module Breakpoints', component: 'module-breakpoints' },
  autos: { name: 'Autos', component: 'autos' },
  'static-fields': { name: 'Static Fields', component: 'static-fields' },
  processes: { name: 'Processes', component: 'processes' },
  memory: { name: 'Memory 1', component: 'memory' },
  'memory-2': { name: 'Memory 2', component: 'memory' },
  'memory-3': { name: 'Memory 3', component: 'memory' },
  'memory-4': { name: 'Memory 4', component: 'memory' },
}

// The default window, laid out the way dnSpy's is: the Assembly Explorer fills the left edge top to
// bottom, and what is left splits between the editor over the tool windows.
const createDefaultLayout = (): IJsonModel => ({
  global: {
    tabEnableRename: false,
    tabEnableFloat: false,
    // No ⤢ on a tab set: dnSpy's panes wear a caption instead — the pane's title with its own dropdown
    // and close button at the end of it — so the maximise button has nothing left to do.
    tabSetEnableMaximize: false,
    tabSetEnableDeleteWhenEmpty: true,
    tabSetMinWidth: 120,
    tabSetMinHeight: 80,
  },
  layout: {
    // A row's orientation alternates with its depth, so the outer row lays the explorer beside everything
    // else and the row inside it stacks the editor over the tool windows.
    type: 'row',
    children: [
      {
        type: 'tabset',
        id: EXPLORER_TABSET_ID,
        weight: EXPLORER_WEIGHT,
        selected: 0,
        // The explorer is one window, so it shows no tab row — a window on its own is not a group; the
        // caption over the pane carries its title and its dropdown. A second window dragged in beside it
        // makes it a group, and the strip that comes back with it runs along the bottom edge of the column,
        // under the pane, where the tool windows' does. See `syncDockTabStrips`.
        tabLocation: 'bottom',
        // Not kept when its tab closes: the column would be a hole the width of the explorer with nothing
        // in it, so closing it hands that width back to the editor. The View menu builds it again.
        children: [{ type: 'tab', id: 'explorer', name: translate('Assembly Explorer'), component: 'explorer', enableClose: true }],
      },
      {
        type: 'row',
        id: EDITOR_COLUMN_ID,
        weight: 100,
        children: [
          {
            type: 'tabset',
            id: DOCUMENT_TABSET_ID,
            weight: 100,
            selected: 0,
            // Kept when its last tab closes: a tab set of its own is where a document always lands, and one
            // flexlayout makes on the fly comes back with an id nothing here knows.
            enableDeleteWhenEmpty: false,
            children: [{ type: 'tab', id: 'start', name: translate('Start'), component: 'start', enableClose: false }],
          },
          {
            type: 'tabset',
            id: TOOL_WINDOW_TABSET_ID,
            // The tool windows hold the lower two fifths of the column, as they do in dnSpy's window.
            weight: 65,
            selected: 0,
            // dnSpy's docked tool windows read left to right along the bottom edge of their panel, in this
            // order, with the Locals grid showing until a debugger session says otherwise. Only these six
            // open with the window; the View menu carries the rest.
            tabLocation: 'bottom',
            enableDeleteWhenEmpty: false,
            children: [
              { type: 'tab', id: 'locals', name: translate('Locals'), component: 'locals', enableClose: true },
              { type: 'tab', id: 'exception-settings', name: translate('Exception Settings'), component: 'exception-settings', enableClose: true },
              { type: 'tab', id: 'callstack', name: translate('Call Stack'), component: 'callstack', enableClose: true },
              { type: 'tab', id: 'search', name: translate('Search'), component: 'search', enableClose: true },
              { type: 'tab', id: 'analysis', name: translate('Analyzer'), component: 'analysis', enableClose: true },
              { type: 'tab', id: 'watch', name: translate('Watch 1'), component: 'watch', enableClose: true },
            ],
          },
        ],
      },
    ],
  },
})

const layoutStorageKey = 'dnspy.layout.v3'

const loadLayout = (): Model => {
  try {
    const saved = localStorage.getItem(layoutStorageKey)
    const model = Model.fromJson(saved ? JSON.parse(saved) as IJsonModel : createDefaultLayout())
    // Everything the shell adds a tab to is one of these two; a layout without them is from before this
    // shape and has nothing left to restore, so the default layout takes its place. The explorer's column
    // is not asked for: closing the explorer takes it away, and that is a layout worth keeping.
    if (!(model.getNodeById(DOCUMENT_TABSET_ID) instanceof TabSetNode) || !(model.getNodeById(TOOL_WINDOW_TABSET_ID) instanceof TabSetNode))
      return Model.fromJson(createDefaultLayout())
    // A saved layout brings the global attributes of whatever run wrote it, which is how a run from
    // before the panes grew captions brings the ⤢ back. The two the shell itself relies on are put back
    // here — no ⤢ on a tab set, and a tab set that outlives its last tab — and the rest of the saved
    // globals are left as that run set them.
    model.doAction(Actions.updateModelAttributes({ tabSetEnableDeleteWhenEmpty: true, tabSetEnableMaximize: false }))
    // Both docks carry their window's tab strip along the bottom edge of the pane, the way dnSpy's do; a
    // layout from before that, or one whose strip was moved to the top, is put back. Whether the strip
    // shows at all is settled below by the number of windows the dock holds.
    const docks = [model.getNodeById('explorer')?.getParent(), model.getNodeById(TOOL_WINDOW_TABSET_ID)]
    for (const dock of docks)
      if (dock instanceof TabSetNode)
        model.doAction(Actions.updateNodeAttributes(dock.getId(), { tabLocation: 'bottom' }))
    // Normalize saved strip visibility. The editor keeps its strip even while empty during restoration;
    // each tool window dock shows one only when it holds multiple windows.
    syncDockTabStrips(model, DOCUMENT_COMPONENTS, [DOCUMENT_TABSET_ID])
    // Disassembly was a tool window once; it is a document now, and a Disassembly tab is a snapshot of a process
    // that is gone by the next start — dnSpy does not save one either.
    const disassemblyTabs: string[] = []
    model.visitNodes((node) => {
      if (node instanceof TabNode && (node.getId() === 'disassembly' || node.getComponent() === 'disassembly' || node.getComponent() === 'disassembly-document'))
        disassemblyTabs.push(node.getId())
    })
    for (const id of disassemblyTabs)
      model.doAction(Actions.deleteTab(id))
    // Migrate older layouts where the docked tabs were marked non-closable.
    for (const id of Object.keys(restorableTabs)) {
      const node = model.getNodeById(id)
      if (node && !node.isCloseable())
        model.doAction(Actions.updateNodeAttributes(id, { enableClose: true }))
    }
    return model
  } catch {
    return Model.fromJson(createDefaultLayout())
  }
}

/** Where a new document tab goes. The active tab set can be either of the docks — clicking one of their
 * tabs makes it the active one — so it is only taken while it is neither of them. */
const getTargetDocumentTabSet = (model: Model): TabSetNode | undefined => {
  const active = model.getActiveTabset()
  if (active && active.getId() !== TOOL_WINDOW_TABSET_ID && active.getId() !== EXPLORER_TABSET_ID)
    return active
  const documents = model.getNodeById(DOCUMENT_TABSET_ID)
  return documents instanceof TabSetNode ? documents : model.getFirstTabSet()
}

// The kinds dnSpy confirms before deleting, with its own wording (`AskDeleteType` and friends). Every
// other deletable kind — property, event, resource, namespace — is removed without a prompt.
// The node kinds the Edit menu offers a Delete command for, and which the Del key therefore removes.
const DELETABLE_KINDS = ['type', 'method', 'field', 'property', 'event', 'namespace', 'resource', 'resourceentry', 'module', 'assembly', 'pedocument', 'elfdocument', 'unknowndocument']

// The rows that stand for a whole file: the tree's roots, which Remove Assembly takes out of it.
const DOCUMENT_ROOT_KINDS = ['assembly', 'pedocument', 'elfdocument', 'unknowndocument']

// The node kinds whose Edit command — and Alt+Enter with it — opens a dialog: every one dnSpy has a
// settings command for that the port has built the window of.
const EDITABLE_KINDS = new Set<string>(['type', 'method', 'field', 'property', 'event'])
const isEditableKind = (kind: string): kind is CreatedKind => EDITABLE_KINDS.has(kind)

/**
 * The theme the option store holds. dnSpy keeps the theme in its settings file with everything else, which is
 * this port's option store; a theme an older build left in a key of its own is moved into the options and that
 * key dropped, so the View menu and the Environment › General page stop disagreeing about it.
 */
/**
 * The tab content's zoom, as a percentage. dnSpy keeps it on each tab view (TabElementZoomer); this port has
 * one editor area, so one zoom covers whatever tab is showing in it, and it is remembered between runs.
 */
const loadDocumentZoom = (): number => {
  const saved = localStorage.getItem('dnspy.zoom')
  return saved === null ? 100 : normalizeZoom(Number(saved))
}

/** Writes the theme where the rest of the options live, leaving the others as they are. The options store is
 *  the one place the theme is kept, which is what makes the View menu and the Environment › General page the
 *  same setting rather than two that happen to agree. */
const saveThemeOption = (theme: ThemeName): void => {
  const options = loadAppOptions()
  if (options.environmentGeneral.theme === theme)
    return
  saveAppOptions({ ...options, environmentGeneral: { ...options.environmentGeneral, theme } })
}

/** Moves a theme an older build left in a key of its own into the options, before anything reads them. */
export const migrateLegacyTheme = (): void => {
  const legacy = localStorage.getItem('dnspy.theme')
  if (legacy !== 'light' && legacy !== 'dark' && legacy !== 'hc' && legacy !== 'blue')
    return
  localStorage.removeItem('dnspy.theme')
  saveThemeOption(legacy)
}

/**
 * The two-key chords the View menu shows and nothing else binds. Word Wrap wears dnSpy's Ctrl+E, Ctrl+W;
 * like the bookmark chords it is armed by the first key and run by the second, so it is listed beside them.
 */
const viewChords = [
  { prefix: 'e', key: 'w', plain: true, run: () => toggleDocumentViewerOption('wordWrap') },
]

/** One step of a tab's history — dnSpy's TabHistory entry: the document the tab showed, in which language, and
 *  where its caret and its scroll were; or the file a hex view showed (HexViewDocumentTabContent) with the view
 *  state it was left in (its HexViewUIState). */
type TabHistoryEntry = {
  kind?: 'document'
  documentId: string
  language?: DecompilerLanguage
  line?: number
  column?: number
  scrollTop?: number
} | {
  kind: 'hex'
  moduleId: string
  state?: HexViewUiState
}

interface TabHistory {
  back: TabHistoryEntry[]
  forward: TabHistoryEntry[]
}

// The id a new document tab gets. Tabs show one document after another, so an id names the tab and not what
// it shows; the counter keeps two tabs opened in the same millisecond apart.
let documentTabCounter = 0
const newDocumentTabId = (): string => `doc:${Date.now().toString(36)}:${++documentTabCounter}`

/** The document a tab shows, when it is a document tab. */
const documentIdOfTab = (tab: TabNode | undefined): string | undefined =>
  tab?.getComponent() === 'document' ? (tab.getConfig() as { documentId?: string } | undefined)?.documentId : undefined

export const App = (): React.JSX.Element => {
  const [model] = useState(loadLayout)
  const [fullScreen, setFullScreen] = useState<boolean>(false)
  const [documentZoom, setDocumentZoom] = useState<number>(loadDocumentZoom)
  // dnSpy reads this once at startup and never again; elevation can't change under a running app.
  const [elevated, setElevated] = useState<boolean>(false)
  // The saved options, subscribed to so a save in the Options dialog reaches the parts of the shell that
  // read them — the theme, the main process's few settings, and the tool windows' widths among others.
  const options = useAppOptions()
  // The View menu's Word Wrap and Highlight Current Line are the Text Viewer's options, as they are in dnSpy.
  const wordWrap = options.documentViewer.general.wordWrap
  const highlightCurrentLine = options.documentViewer.general.highlightCurrentLine
  // The debugger's settings reach the engine when they change — in the Options dialog or from a debugger
  // window's context menu — and a stopped process is read again in the new format, as dnSpy's windows redraw.
  const debuggerOptionsKey = JSON.stringify([options.debugger, options.callStack])
  useEffect(() => {
    void useAppStore.getState().applyDebuggerOptions()
  }, [debuggerOptionsKey])
  // dnSpy's theme lives in its settings file with everything else, which is this port's option store: the
  // shell reads it from there and writes it back, so there is one copy of it rather than a state of its own
  // that the options would have to be kept in step with.
  // The theme service's ThemeService.Initialize: the theme the options name when the service has it, its
  // dark theme otherwise, and the high-contrast theme whenever the system is in high contrast.
  const { highContrast: systemHighContrast } = useThemes()
  const activeTheme = resolveTheme(options.environmentGeneral.theme)
  const theme = themeKey(activeTheme)
  const setTheme = (next: ThemeName): void => saveThemeOption(next)
  // Whether a background picture is up, which is what decides whether the editor goes without a background
  // of its own for the picture to be seen through.
  const backgroundImageOn = options.backgroundImage.isEnabled && options.backgroundImage.images.trim().length > 0
  const [renameNode, setRenameNode] = useState<TreeNode>()
  const [renameNamespaceNode, setRenameNamespaceNode] = useState<TreeNode>()
  const [editMethodBody, setEditMethodBody] = useState<{ node: TreeNode; selection?: { start: number; end: number } }>()
  const [resourceDialog, setResourceDialog] = useState<
    | { mode: 'options' | 'element' | 'createElement' | 'createImageList'; node: TreeNode }
    | { mode: 'create'; node: TreeNode; kind: ResourceCreateKind }
  >()
  const [assemblyModuleDialog, setAssemblyModuleDialog] = useState<{ mode: 'assembly' | 'module'; node: TreeNode }>()
  // dnSpy's Create Assembly window, and its NetModuleOptionsDlg for Create NetModule and Add New NetModule.
  const [createAssemblyOpen, setCreateAssemblyOpen] = useState(false)
  const [netModuleDialog, setNetModuleDialog] = useState<{ assemblyNode?: TreeNode }>()
  // dnSpy remembers the writer options between saves; the Save Module window edits this copy.
  const [codeDialog, setCodeDialog] = useState<{ node: TreeNode; mode: CompilerMode; sourceNodeId?: string }>()
  // dnSpy's Go to Token box. It is opened from the tree, and the node it was opened over is what names
  // the module the token is looked up in.
  const [tokenNode, setTokenNode] = useState<TreeNode>()
  // dnSpy's Go to MD Table Row window, and the node whose module it looks in.
  const [mdRowNode, setMdRowNode] = useState<TreeNode>()
  // The type "Add Class Tracepoint" asked for, while the breakpoint settings dialog it opens is up.
  const [classTracepointNode, setClassTracepointNode] = useState<MethodBreakpointTarget>()
  const breakpointSettingsRequest = useAppStore((state) => state.breakpointSettingsRequest)
  const editBreakpointSettings = useAppStore((state) => state.editBreakpointSettings)
  const locationTracepointRequest = useAppStore((state) => state.locationTracepointRequest)
  const requestLocationTracepoint = useAppStore((state) => state.requestLocationTracepoint)
  const addLocationBreakpoint = useAppStore((state) => state.addLocationBreakpoint)
  const setBreakpointsSettings = useAppStore((state) => state.setBreakpointsSettings)
  const breakpointSettingsOf = (id: string | undefined): BreakpointSettings | undefined => {
    const state = useAppStore.getState()
    return id?.startsWith('fn:')
      ? state.functionBreakpoints.find((breakpoint) => `fn:${breakpoint.name}` === id)?.settings
      : state.lineBreakpoints.find((breakpoint) => breakpoint.id === id)?.settings
  }
  // The create or edit dialog the Edit menu opened, over the node it acts on: `nodeId` is what is being
  // edited, and is left off when a new node is being created in `ownerNodeId` instead.
  const [editNode, setEditNode] = useState<{ kind: CreatedKind, nodeId?: string, ownerNodeId?: string, nested?: boolean }>()
  const [attachDialogOpen, setAttachDialogOpen] = useState(false)
  const [debugProgramDialogOpen, setDebugProgramDialogOpen] = useState(false)
  // Start Without Debugging opens the same dialog, to run the program rather than debug it.
  const [runProgramDialogOpen, setRunProgramDialogOpen] = useState(false)
  const [aboutDialogOpen, setAboutDialogOpen] = useState(false)
  const [gacDialogOpen, setGacDialogOpen] = useState(false)
  // dnSpy's Export to Project, with the tree's selection it was started on.
  const [exportProjectNodeIds, setExportProjectNodeIds] = useState<string[]>()
  const [openListDialogOpen, setOpenListDialogOpen] = useState(false)
  const [windowsDialogOpen, setWindowsDialogOpen] = useState(false)
  const [optionsDialogCategory, setOptionsDialogCategory] = useState<'environment' | 'decompiler' | 'debugger' | undefined>(undefined)
  // dnSpy's TabHistory, one per tab, by tab id; the version is what tells React the Back and Forward buttons
  // may have changed, since the histories themselves are kept outside its state.
  const tabHistories = useRef(new Map<string, TabHistory>())
  const [historyVersion, setHistoryVersion] = useState(0)
  const [layoutVersion, forceLayoutUpdate] = useState(0)
  const previousWorkspaceId = useRef<string | undefined | null>(null)
  // The tabs from the saved layout name document ids from the run that wrote it, so they are torn down
  // and rebuilt from the restored session instead.
  const startupHandled = useRef(false)
  const visibleToolWindows = useMemo(() => {
    const visible = new Set<string>()
    for (const id of Object.keys(restorableTabs)) {
      if (model.getNodeById(id))
        visible.add(id)
    }
    return visible
  }, [model, layoutVersion])
  // Which document the Edit menu keys off: dnSpy shows its hex and metadata-table groups for the
  // document kind that has focus, and this port's hex/info views are the same two components.
  const activeDocument = useMemo<ActiveDocument>(() => {
    const tab = model.getActiveTabset()?.getSelectedNode()
    if (!(tab instanceof TabNode))
      return null
    const component = tab.getComponent()
    if (component === 'document') {
      // A metadata table is a document of its own kind, whose commands the Edit menu's metadata groups run.
      const state = useAppStore.getState()
      const documentId = (tab.getConfig() as { documentId?: string } | undefined)?.documentId
      const nodeId = documentId ? state.documents[documentId]?.nodeId : undefined
      return nodeId && findNode(state, nodeId)?.kind === 'metadatatable' ? 'md-table' : 'code'
    }
    return component === 'hex' || component === 'module-info' ? component : null
  }, [model, layoutVersion])
  // dnSpy's Show Code is there whenever a tab is: it only puts the focus in the one in front.
  const canShowCode = useMemo(() => {
    const selected = getTargetDocumentTabSet(model)?.getSelectedNode()
    return selected instanceof TabNode && DOCUMENT_COMPONENTS.includes(selected.getComponent() ?? '')
  }, [model, layoutVersion])
  // The bookmark chord waiting for its second key — Ctrl+K or Ctrl+B — and, as a timestamp so it needs no
  // timer, when it stops waiting.
  const bookmarkChord = useRef<{ prefix: string; until: number } | undefined>(undefined)
  // The debugger windows' chords: Ctrl+Alt+W then 1–4 for a Watch window, Ctrl+Alt+M then 1–4 for a Memory
  // window, Ctrl+Alt+V then A or L for Autos and Locals — dnSpy's gestures for the numbered windows.
  const debugWindowChord = useRef<{ prefix: string; until: number } | undefined>(undefined)
  const workspaceId = useAppStore((state) => state.workspaceId)
  const backendStatus = useAppStore((state) => state.backendStatus)
  const busy = useAppStore((state) => state.busy)
  const error = useAppStore((state) => state.error)
  const selectedNode = useAppStore((state) => state.selectedNode)
  const selectedNodes = useAppStore((state) => state.selectedNodes)
  const modules = useAppStore((state) => state.modules)
  const chooseAndOpen = useAppStore((state) => state.chooseAndOpen)
  const closeWorkspace = useAppStore((state) => state.closeWorkspace)
  const dirty = useAppStore((state) => state.dirty)
  const recentFiles = useAppStore((state) => state.recentFiles)
  const openPaths = useAppStore((state) => state.openPaths)
  const openRecentFile = useAppStore((state) => state.openRecentFile)
  const canUndo = useAppStore((state) => state.canUndo)
  const canRedo = useAppStore((state) => state.canRedo)
  const undoEdit = useAppStore((state) => state.undoEdit)
  const redoEdit = useAppStore((state) => state.redoEdit)
  const activeDocumentId = useAppStore((state) => state.activeDocumentId)
  // dnSpy's language box names the one decompiler every document is shown in.
  const defaultLanguage = useAppStore((state) => state.defaultLanguage)
  const changeLanguage = useAppStore((state) => state.changeLanguage)
  const saveRequest = useAppStore((state) => state.saveRequest)
  const acceptSaveOptions = useAppStore((state) => state.acceptSaveOptions)
  const finishSave = useAppStore((state) => state.finishSave)
  const saveModule = useAppStore((state) => state.saveModule)
  const saveAllModules = useAppStore((state) => state.saveAllModules)
  const reloadAllAssemblies = useAppStore((state) => state.reloadAllAssemblies)
  const sortAssemblies = useAppStore((state) => state.sortAssemblies)
  const goToResource = useAppStore((state) => state.goToResource)
  const removeModules = useAppStore((state) => state.removeModules)
  // The modules read out of a process the debugger no longer debugs — what Close Old In-Memory Modules closes.
  const memoryModules = useAppStore((state) => state.memoryModules)
  const liveDebugSessions = useAppStore(useShallow((state) => debugSessionIds(state)))
  const oldInMemoryModuleIds = useMemo(() => modules
    .filter((module) => memoryModules[module.path] !== undefined && !liveDebugSessions.includes(memoryModules[module.path].sessionId))
    .map((module) => module.id), [modules, memoryModules, liveDebugSessions])
  const getModifiedModules = useAppStore((state) => state.getModifiedModules)
  const getCloseCandidates = useAppStore((state) => state.getCloseCandidates)
  const goToSpecialNode = useAppStore((state) => state.goToSpecialNode)
  const goToToken = useAppStore((state) => state.goToToken)
  const saveCode = useAppStore((state) => state.saveCode)
  const replaceResource = useAppStore((state) => state.replaceResource)
  const mergeAssembly = useAppStore((state) => state.mergeAssembly)
  // dnSpy's Edit Resource opens the properties dialog for a resource, and the element editor for one
  // of a .resources file's rows; the byte-for-byte replacement the port grew earlier is kept for the
  // document's Save button, which is where dnSpy writes a resource out.
  const editResource = (node: TreeNode): void => setResourceDialog({ mode: node.kind === 'resourceentry' ? 'element' : 'options', node })
  const createResource = (kind: ResourceCreateKind, node: TreeNode): void => setResourceDialog({ mode: 'create', node, kind })
  // The .resources file a resource entry is in, which is where dnSpy's Create ... commands add theirs.
  const resourcesFileOf = (node: TreeNode): TreeNode | undefined => {
    const parentId = node.kind === 'resourceentry' ? useAppStore.getState().parents[node.id] : undefined
    return parentId ? findNode(useAppStore.getState(), parentId) : node
  }
  const createResourceElement = (node: TreeNode): void => {
    const resourceNode = resourcesFileOf(node)
    if (resourceNode)
      setResourceDialog({ mode: 'createElement', node: resourceNode })
  }
  const createImageResourcesAction = useAppStore((state) => state.createImageResources)
  const createImageResources = (node: TreeNode): void => {
    const resourceNode = resourcesFileOf(node)
    if (resourceNode)
      void createImageResourcesAction(resourceNode)
  }
  const createImageList = (node: TreeNode): void => {
    const resourceNode = resourcesFileOf(node)
    if (resourceNode)
      setResourceDialog({ mode: 'createImageList', node: resourceNode })
  }
  const saveResource = useAppStore((state) => state.saveResource)
  const loadDependencies = useAppStore((state) => state.loadDependencies)
  const convertModule = useAppStore((state) => state.convertModule)
  const ensureWorkspace = useAppStore((state) => state.ensureWorkspace)
  const addNetModule = useAppStore((state) => state.addNetModule)
  const removeNetModule = useAppStore((state) => state.removeNetModule)
  const addClassBreakpoint = useAppStore((state) => state.addClassBreakpoint)
  const addMethodBreakpoints = useAppStore((state) => state.addMethodBreakpoints)
  const deleteNodes = useAppStore((state) => state.deleteNodes)
  const renameNamespace = useAppStore((state) => state.renameNamespace)
  const moveTypesToEmptyNamespace = useAppStore((state) => state.moveTypesToEmptyNamespace)
  const replaceMethodBodyWithStub = useAppStore((state) => state.replaceMethodBodyWithStub)
  // What the Edit menu's hex group is built from, subscribed to so the menu follows them: the tree selection's target
  // and the code viewer's caret.
  useAppStore((state) => state.hexTarget)
  useAppStore((state) => state.hexStatement)
  useAppStore((state) => state.codeHexContext)
  useAppStore((state) => state.codeCaret)
  /**
   * The pane dnSpy's HexMenuCommand.CreateContext reads its context from: the one with the keyboard focus. A WPF
   * menu takes no focus, so the focus is still in the pane while its Edit menu is open; here the menu bar takes
   * it, and the pane that had it last stands in. A dialog or a menu passes the focus back to where it was.
   */
  const [hexFocus, setHexFocus] = useState<'code' | 'tree' | 'other'>('other')
  useEffect(() => {
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target instanceof Element ? event.target : undefined
      if (!target || target.closest('[role="menubar"], [role="menu"], [role="dialog"]'))
        return
      setHexFocus(target.closest('.document-view:not(.disassembly-document)') ? 'code' : target.closest('.assembly-tree:not(.analyzer-tree)') ? 'tree' : 'other')
    }
    window.addEventListener('focusin', onFocusIn)
    return () => window.removeEventListener('focusin', onFocusIn)
  }, [])
  // Hex Paste Method Body is on the Edit menu only while the clipboard holds hexadecimal bytes that fit, which is
  // read as the menu bar is reached for — by the pointer or by Alt.
  const [menuClipboardHexLength, setMenuClipboardHexLength] = useState<number>()
  useEffect(() => {
    const refresh = (): void => { void clipboardHexLength().then(setMenuClipboardHexLength) }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest('.menu-bar'))
        refresh()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.altKey)
        refresh()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])
  const resolveHexTarget = useAppStore((state) => state.resolveHexTarget)
  const showHexAt = useAppStore((state) => state.showHexAt)
  const hexWriteMethodBody = useAppStore((state) => state.hexWriteMethodBody)
  const hexCopyMethodBody = useAppStore((state) => state.hexCopyMethodBody)
  const hexPasteMethodBody = useAppStore((state) => state.hexPasteMethodBody)
  const treeChildren = useAppStore((state) => state.children)
  const treeParents = useAppStore((state) => state.parents)
  const treeRoots = useAppStore((state) => state.roots)
  const treeNodesById = useMemo(() => nodesByIdOf(treeRoots, treeChildren), [treeRoots, treeChildren])
  const openDocument = useAppStore((state) => state.openDocument)
  const expandNode = useAppStore((state) => state.expandNode)
  const loadChildren = useAppStore((state) => state.loadChildren)
  const selectNode = useAppStore((state) => state.selectNode)
  const setRestoringSession = useAppStore((state) => state.setRestoringSession)
  const setDocumentOrder = useAppStore((state) => state.setDocumentOrder)
  const appendOutput = useAppStore((state) => state.appendOutput)
  const setOpenNodeById = useAppStore((state) => state.setOpenNodeById)
  const setOpenNodeInNewTabById = useAppStore((state) => state.setOpenNodeInNewTabById)
  const setRevealDocument = useAppStore((state) => state.setRevealDocument)
  const setOpenToolWindow = useAppStore((state) => state.setOpenToolWindow)
  const bookmarks = useAppStore((state) => state.bookmarks)
  const setAllBookmarksEnabled = useAppStore((state) => state.setAllBookmarksEnabled)
  const clearBookmarksAction = useAppStore((state) => state.clearBookmarks)
  const setBackendStatus = useAppStore((state) => state.setBackendStatus)
  const clearError = useAppStore((state) => state.clearError)
  const debugState = useAppStore((state) => state.debugState)
  const activeDebugFrameId = useAppStore((state) => state.activeDebugFrameId)
  const debugProcess = useAppStore((state) => state.debugProcess)
  const debugSessionId = useAppStore((state) => state.debugSessionId)
  const stoppedReason = useAppStore((state) => state.stoppedReason)
  const handleDebugEvent = useAppStore((state) => state.handleDebugEvent)
  const continueDebug = useAppStore((state) => state.continueDebug)
  const pauseDebug = useAppStore((state) => state.pauseDebug)
  const stepDebug = useAppStore((state) => state.stepDebug)
  const revealStoppedLocation = useAppStore((state) => state.revealStoppedLocation)
  const stopDebug = useAppStore((state) => state.stopDebug)
  const functionBreakpoints = useAppStore((state) => state.functionBreakpoints)
  const lineBreakpoints = useAppStore((state) => state.lineBreakpoints)
  const deleteAllBreakpointsAction = useAppStore((state) => state.deleteAllBreakpoints)
  const setAllFunctionBreakpointsEnabled = useAppStore((state) => state.setAllFunctionBreakpointsEnabled)
  const setAllLineBreakpointsEnabled = useAppStore((state) => state.setAllLineBreakpointsEnabled)
  const { locale, setLanguage, t } = useLanguage()

  // dnSpy's Debug > Toggle Breakpoint is the code viewer's ToggleCreateBreakpoint at the caret of the document in front:
  // there is something to do wherever the caret is on a statement, or on a breakpoint's line.
  const codeCaret = useAppStore((state) => state.codeCaret)
  const toggleLineBreakpoint = useAppStore((state) => state.toggleLineBreakpoint)
  const canToggleBreakpointHere = useMemo(() => {
    if (!codeCaret) return false
    const statements = useAppStore.getState().documents[codeCaret.documentId]?.codeStatements
    return (statements?.length ?? 0) > 0 || lineBreakpoints.some((breakpoint) => breakpoint.nodeId === codeCaret.documentId)
  }, [codeCaret, lineBreakpoints])
  const toggleBreakpointHere = (): void => {
    if (codeCaret) void toggleLineBreakpoint(codeCaret.documentId, codeCaret.line, codeCaret.column)
  }
  // dnSpy's DeleteAllBreakpointsAskUser: the question carries a "Don't show again" box, and a suppressed
  // one is taken as a yes — the user asked not to be troubled over it again.
  const deleteAllBreakpoints = (): void => {
    void (async () => {
      const yes = t('Yes')
      const answer = await askIgnorableMessage(askDeleteAllBreakpointsId, t('Do you want to delete all breakpoints?'), [yes, t('No')])
      if (answer !== undefined && answer !== yes)
        return
      await deleteAllBreakpointsAction()
    })()
  }

  // dnSpy's "Move Types to Empty Namespace" is offered only when the module already has an empty
  // namespace node for the types to land in; the module's children are loaded whenever one of its
  // namespaces is selectable, so the sibling list is the tree the user is looking at.
  const hasEmptyNamespaceSibling = useMemo(
    () => namespaceHasEmptySibling(selectedNode, treeChildren, treeParents),
    [selectedNode, treeChildren, treeParents],
  )

  /** dnSpy's Create Assembly: the window's type and attribute pickers need a workspace, which nothing open means
   *  there is none of yet. */
  const createAssemblyCommand = async (): Promise<void> => {
    if (await ensureWorkspace())
      setCreateAssemblyOpen(true)
  }

  /** dnSpy's Add Existing NetModule to Assembly: a file picked, and a box saying so when it is no net module. */
  const addExistingNetModule = async (node: TreeNode): Promise<void> => {
    const path = await window.dnSpy.pickNetModuleFile()
    if (!path)
      return
    if (!await addNetModule(node, { path }))
      await window.dnSpy.showMessage(useAppStore.getState().error ?? t('{path} is not a NetModule', { path }))
  }

  /** dnSpy's Remove NetModule from Assembly, which asks about the net module's unsaved changes first. */
  /** Closes what showed a removed node; a hex tab keeps its view state as it goes on showing the file. */
  const closeTabsFor = (nodeId: string): void => closeDocumentTabsFor(model, nodeId, (oldId, newId) => {
    const kept = useAppStore.getState().hexTabs.find((tab) => tab.moduleId === oldId)?.state
    if (kept)
      useAppStore.getState().setHexTabState(newId, kept)
  })

  const removeNetModuleCommand = async (node: TreeNode): Promise<void> => {
    const modified = await getModifiedModules([node.id])
    if (modified.length > 0) {
      const answer = await window.dnSpy.askSaveModified(modified.length)
      if (answer === 'cancel' || (answer === 'save' && !await useAppStore.getState().saveModules(modified)))
        return
    }
    if (await removeNetModule(node))
      closeTabsFor(node.id)
  }

  /** Where a row is among its parent's rows, which tells an assembly's manifest module from its net modules. */
  const indexInParent = (nodeId: string): number | undefined => {
    const state = useAppStore.getState()
    const parentId = state.parents[nodeId]
    const index = parentId ? (state.children[parentId] ?? []).findIndex((child) => child.id === nodeId) : -1
    return index < 0 ? undefined : index
  }

  /** Removes a node, defaulting to the selected one. A menu that carries its own node — the code
   *  viewer's context menu, whose selection is the reference under the caret — hands that one over. */
  const deleteSelected = (node = selectedNode): void => {
    if (!node)
      return
    // A root row is a document, and Del or Edit > Remove takes it out of the tree — with every other
    // selected root, the way RemoveAssemblyCommand acts on the whole selection.
    // A net module of an assembly is taken out of it — dnSpy binds Del to Remove NetModule from Assembly there.
    if (node.kind === 'module') {
      const state = useAppStore.getState()
      const parent = state.parents[node.id] ? findNode(state, state.parents[node.id]) : undefined
      if (parent?.kind === 'assembly' && parent.icon !== 'ModulePublic' && (indexInParent(node.id) ?? 0) > 0)
        void removeNetModuleCommand(node)
      return
    }
    if (DOCUMENT_ROOT_KINDS.includes(node.kind)) {
      const selection = useAppStore.getState().selectedNodes
      const roots = selection.some((selected) => selected.id === node.id) && selection.every((selected) => DOCUMENT_ROOT_KINDS.includes(selected.kind)) ? selection : [node]
      void removeDocuments(roots.map((root) => root.id), () => removeModules(roots.map((root) => root.id)))
      return
    }
    // dnSpy's delete commands take the whole selection when it is all of the node's kind, as one undo step. A
    // type, method or field can be referenced from code this edit cannot see, so dnSpy asks first — once for the
    // command, and not again once its "don't show again" was ticked. The others go through unasked.
    const state = useAppStore.getState()
    const targets = deletionTargets(node, state.selectedNodes, state.parents)
    if (targets.length === 0)
      return
    void (async () => {
      const question = DELETE_COMMANDS[node.kind]?.question
      if (question) {
        const answer = await askIgnorableMessage(DELETE_QUESTION_ID, t(question), [t('Yes'), t('No')])
        if (answer !== undefined && answer !== t('Yes'))
          return
      }
      if (await deleteNodes(targets)) {
        for (const target of targets)
          closeTabsFor(target.id)
      }
    })()
  }
  /** Undo and Redo, which can take a whole document out of the tree again — a removal dnSpy recorded in the
   *  history — and then the tabs that showed anything of it go with it, the way the removal closed them. */
  const undo = (): void => {
    void undoEdit().then((removed) => {
      for (const nodeId of removed)
        closeTabsFor(nodeId)
    })
  }
  const redo = (): void => {
    void redoEdit().then((removed) => {
      for (const nodeId of removed)
        closeTabsFor(nodeId)
    })
  }
  const enableAllBreakpoints = (enabled: boolean): void => {
    void setAllLineBreakpointsEnabled(enabled)
    void setAllFunctionBreakpointsEnabled(enabled)
  }
  const anyBreakpointEnabled = lineBreakpoints.some((breakpoint) => breakpoint.enabled) || functionBreakpoints.some((breakpoint) => breakpoint.enabled)
  const anyBreakpointDisabled = lineBreakpoints.some((breakpoint) => !breakpoint.enabled) || functionBreakpoints.some((breakpoint) => !breakpoint.enabled)

  // The Edit menu's hex entries are built from where the selection points, so the answer is refreshed
  // whenever the selection changes rather than being asked for when the menu opens.
  useEffect(() => {
    void resolveHexTarget(selectedNode)
  }, [selectedNode, resolveHexTarget])

  useEffect(() => {
    const unsubscribe = window.dnSpy.onBackendStatus(setBackendStatus)
    void window.dnSpy.getBackendStatus().then(setBackendStatus)
    return unsubscribe
  }, [setBackendStatus])
  useEffect(() => window.dnSpy.onDebugEvent((event) => { void handleDebugEvent(event) }), [handleDebugEvent])

  // dnSpy's SwitchToDebuggedProcess: once the process has been running for a second (DelayedIsRunningChanged), its
  // window gets the focus when Give focus to debugged process is on — except before the session's first break,
  // when the system gives a new process the focus by itself.
  const debuggeeHasBroken = useRef(false)
  useEffect(() => {
    if (debugState === 'inactive') {
      debuggeeHasBroken.current = false
      return
    }
    if (debugState === 'stopped') {
      debuggeeHasBroken.current = true
      return
    }
    if (debugState !== 'running' || !debuggeeHasBroken.current)
      return
    const timer = setTimeout(() => {
      const processId = useAppStore.getState().debugProcess?.id
      if (processId && useAppStore.getState().debugState === 'running' && loadAppOptions().debugger.focusActiveProcess)
        void window.dnSpy.focusProcessWindow?.(processId).catch(() => false)
    }, 1000)
    return () => clearTimeout(timer)
  }, [debugState])

  // Upstream opens the Locals window from `AutoShowLocalsWindow`, which hangs off `DbgManager_IsDebuggingChanged`:
  // it is shown once, when a debugging session starts, and the Debugger options' "Show the Locals window when the
  // debugger starts" can turn it off. Breaking, stepping and continuing all leave the session — and its
  // `debugSessionId` — as it was, so they must not move the dock's tabs; only a session that has just started may.
  useEffect(() => {
    if (!debugSessionId || !loadAppOptions().debugger.autoOpenLocalsWindow)
      return
    const locals = model.getNodeById('locals')
    if (locals instanceof TabNode && !locals.isSelected()) {
      model.doAction(Actions.selectTab('locals'))
      forceLayoutUpdate((value) => value + 1)
    }
  }, [debugSessionId, model])

  // The editor keeps its row even when empty. A dock's row follows what it holds: one window shows none, and a
  // second window — dragged in, or brought back by the View menu — is and does. The change this makes comes
  // back through `onModelChange`, which counts as a layout change, and the pass over the model after it
  // finds every dock already the way it should be and stops.
  useEffect(() => {
    syncDockTabStrips(model, DOCUMENT_COMPONENTS, [DOCUMENT_TABSET_ID])
  }, [model, layoutVersion])

  // dnSpy writes the theme it settled on back to its settings (the Theme setter saves ThemeSettings.ThemeGuid),
  // which is what makes a missing theme, or the switch high contrast forces, stick.
  useLayoutEffect(() => {
    applyTheme(activeTheme)
    if (options.environmentGeneral.theme !== theme)
      saveThemeOption(theme)
  }, [activeTheme, options.environmentGeneral.theme, theme, systemHighContrast])

  // dnSpy's TabElementZoomer scales the content of a tab that is not a text view — the hex dump, the module's
  // information, the start page; a document viewer zooms its own text instead (its ZoomLevel option).
  useEffect(() => {
    localStorage.setItem('dnspy.zoom', String(documentZoom))
  }, [documentZoom])

  // Ctrl+wheel over a tab steps its zoom, one level per notch, in both directions. A document viewer takes the
  // wheel itself, so what reaches here is over any other tab.
  useEffect(() => {
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey || event.deltaY === 0)
        return
      const target = event.target as HTMLElement | null
      if (!target?.closest('.workspace-host') || target.closest('.document-view'))
        return
      event.preventDefault()
      setDocumentZoom((current) => normalizeZoom(event.deltaY < 0 ? zoomIn(current) : zoomOut(current)))
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [])

  // dnSpy's AppSettings.AllowMoreThanOneInstance is read before there is a window to ask, so the options
  // store — which is where the user sets it — hands it to the main process, which keeps it for the next start.
  useEffect(() => {
    void window.dnSpy.updateMainSettings({ allowMoreThanOneInstance: options.environmentGeneral.allowMoreThanOneInstance })
  }, [options.environmentGeneral.allowMoreThanOneInstance])

  useEffect(() => {
    let mounted = true
    void window.dnSpy.isFullScreen().then((value) => {
      if (mounted) setFullScreen(value)
    })
    const unsubscribe = window.dnSpy.onFullScreenChange(setFullScreen)
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    let mounted = true
    void window.dnSpy.isRunningAsAdministrator().then((value) => {
      if (mounted) setElevated(value)
    })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    const names: Record<string, string> = {
      explorer: t('Assembly Explorer'),
      output: t('Output'),
      'csharp-interactive': t('C# Interactive'),
      search: t('Search'),
      analysis: t('Analyzer'),
      locals: t('Locals'),
      'exception-settings': t('Exception Settings'),
      watch: t('Watch 1'),
      'watch-2': t('Watch {number}', { number: 2 }),
      'watch-3': t('Watch {number}', { number: 3 }),
      'watch-4': t('Watch {number}', { number: 4 }),
      callstack: t('Call Stack'),
      breakpoints: t('Breakpoints'),
      bookmarks: t('Bookmarks'),
      threads: t('Threads'),
      modules: t('Modules'),
      'module-breakpoints': t('Module Breakpoints'),
      autos: t('Autos'),
      'static-fields': t('Static Fields'),
      processes: t('Processes'),
      memory: t('Memory {number}', { number: 1 }),
      'memory-2': t('Memory {number}', { number: 2 }),
      'memory-3': t('Memory {number}', { number: 3 }),
      'memory-4': t('Memory {number}', { number: 4 }),
      start: t('Start'),
    }
    for (const [id, name] of Object.entries(names)) {
      const node = model.getNodeById(id)
      if (node instanceof TabNode && node.getName() !== name)
        model.doAction(Actions.renameTab(id, name))
    }
    localStorage.setItem(layoutStorageKey, JSON.stringify(model.toJson()))
    forceLayoutUpdate((value) => value + 1)
  }, [locale, model, t])

  /** The tab set already docked at an edge of the editor's column — dnSpy's dock for that edge — or undefined
   * when nothing is there yet. The explorer's column is the one on the left; the right has to be made. */
  const dockAtEdge = (edge: 'left' | 'right'): TabSetNode | undefined => {
    const editorColumn = model.getNodeById(EDITOR_COLUMN_ID)
    const parent = editorColumn?.getParent()
    if (!editorColumn || !(parent instanceof RowNode))
      return undefined
    const index = parent.getChildren().indexOf(editorColumn)
    const sibling = parent.getChildren()[edge === 'left' ? index - 1 : index + 1]
    return sibling instanceof TabSetNode ? sibling : undefined
  }

  /**
   * dnSpy's IDsToolWindowService.Move: puts a tool window in the dock at the edge the location names. This
   * port's docks are the explorer's column on the left, the tool windows' tab set under the editor, and
   * whichever further docks the moves themselves have made — a window moved to an edge that has no dock is
   * put in one made beside the editor's column. dnSpy's two "default" locations are where it puts a window
   * that has never been given one: the bottom dock, or the vertical dock down the left.
   */
  const moveToolWindow = (tab: TabNode, location: ToolWindowLocation): void => {
    const editorColumn = model.getNodeById(EDITOR_COLUMN_ID)
    if (location === 'left' || location === 'default-vertical') {
      const dock = dockAtEdge('left')
      if (dock)
        model.doAction(Actions.moveNode(tab.getId(), dock.getId(), DockLocation.CENTER, -1, true))
      else if (editorColumn)
        model.doAction(Actions.moveNode(tab.getId(), editorColumn.getId(), DockLocation.LEFT, -1, true))
      return
    }
    if (location === 'right') {
      const dock = dockAtEdge('right')
      if (dock)
        model.doAction(Actions.moveNode(tab.getId(), dock.getId(), DockLocation.CENTER, -1, true))
      else if (editorColumn)
        model.doAction(Actions.moveNode(tab.getId(), editorColumn.getId(), DockLocation.RIGHT, -1, true))
      return
    }
    if (location === 'top') {
      const documents = model.getNodeById(DOCUMENT_TABSET_ID)
      if (documents)
        model.doAction(Actions.moveNode(tab.getId(), documents.getId(), DockLocation.TOP, -1, true))
      return
    }
    const toolWindows = model.getNodeById(TOOL_WINDOW_TABSET_ID)
    if (toolWindows && tab.getParent() !== toolWindows)
      model.doAction(Actions.moveNode(tab.getId(), TOOL_WINDOW_TABSET_ID, DockLocation.CENTER, -1, true))
  }

  /** dnSpy's Move over a whole group: every window the dock holds goes to the same edge, one by one, which
   * is what its group.MoveTo does — the dock the first one makes is where the rest follow it. */
  const moveToolWindowGroup = (tab: TabNode, location: ToolWindowLocation): void => {
    const group = tab.getParent()
    if (!(group instanceof TabSetNode))
      return
    for (const item of [...group.getTabNodes()])
      moveToolWindow(item, location)
  }

  /** The tab set docked at an edge — dnSpy's dock for that location — or undefined when nothing is there yet.
   * The top dock is made by the first move to it, so until then there is nothing between the window and the
   * editor's own tabs to count as one. */
  const dockAt = (location: ToolWindowLocation): TabSetNode | undefined => {
    if (location === 'left' || location === 'default-vertical')
      return dockAtEdge('left')
    if (location === 'right')
      return dockAtEdge('right')
    if (location === 'top') {
      const first = model.getNodeById(EDITOR_COLUMN_ID)?.getChildren()[0]
      return first instanceof TabSetNode && first.getId() !== DOCUMENT_TABSET_ID ? first : undefined
    }
    const toolWindows = model.getNodeById(TOOL_WINDOW_TABSET_ID)
    return toolWindows instanceof TabSetNode ? toolWindows : undefined
  }

  /** dnSpy's IDsToolWindowService.CanMove: a window can be moved to an edge unless its dock is already that
   * one — which is why a window in the leftmost dock has the Move Left command greyed out. */
  const canMoveToolWindow = (tab: TabNode, location: ToolWindowLocation): boolean => {
    const parent = tab.getParent()
    return parent instanceof TabSetNode && parent !== dockAt(location)
  }

  /**
   * Brings a docked tab forward, adding it back when it has been closed. The explorer returns to a column
   * of its own on the left, the height of everything beside it; every other tool window lives in the tab
   * set under the editor, unless a command line names another edge for it.
   */
  const showToolWindow = (tabId: string, location?: ToolWindowLocation): void => {
    const tab = model.getNodeById(tabId)
    if (tab instanceof TabNode) {
      model.doAction(Actions.selectTab(tabId))
      if (location)
        moveToolWindow(tab, location)
      forceLayoutUpdate((value) => value + 1)
      return
    }
    const spec = restorableTabs[tabId]
    if (!spec) return
    if (tabId === 'explorer' || location === 'default-vertical') {
      // Docking to the left of the editor's column rather than of its tab set: a tab set would put the
      // explorer beside the editor instead of beside both the editor and the tool windows.
      const column = model.getNodeById(EDITOR_COLUMN_ID) ?? model.getNodeById(DOCUMENT_TABSET_ID)
      if (!column) return
      model.doAction(Actions.addNode({
        type: 'tab',
        id: tabId,
        name: t(spec.name),
        component: spec.component,
        enableClose: true,
      }, column.getId(), DockLocation.LEFT, 0, true))
      const restored = model.getNodeById(tabId)?.getParent()
      // Splitting a column wraps it in a row of its own, so both sides are looked up again — by what they
      // hold, not by the ids they started with — and put back to the shares the default layout gives
      // them: the explorer's 43 against the editor column's 100. The tab set flexlayout made for the tab
      // is given the explorer's attributes back too, where its strip would run once a second window joins
      // it; the strip itself stays away while the dock holds this one window.
      const beside = restored?.getParent()?.getChildren().find((child) => child.getId() !== restored.getId())
      if (restored) model.doAction(Actions.updateNodeAttributes(restored.getId(), { weight: EXPLORER_WEIGHT, tabLocation: 'bottom' }))
      if (beside) model.doAction(Actions.updateNodeAttributes(beside.getId(), { weight: 100 }))
      forceLayoutUpdate((value) => value + 1)
      return
    }
    if (!model.getNodeById(TOOL_WINDOW_TABSET_ID)) return
    model.doAction(Actions.addNode({
      type: 'tab',
      id: tabId,
      name: t(spec.name),
      component: spec.component,
      enableClose: true,
    }, TOOL_WINDOW_TABSET_ID, DockLocation.CENTER, -1, true))
    // A command line may name the edge the window is to be docked at; a window that has never been shown
    // before is added where the tool windows live and moved from there, so the move is the same one the
    // Move commands make.
    const added = model.getNodeById(tabId)
    if (added instanceof TabNode && location)
      moveToolWindow(added, location)
    forceLayoutUpdate((value) => value + 1)
  }

  // dnSpy's Search Assemblies shows the search window and hands its text box the focus.
  const showSearch = (): void => {
    showToolWindow('search')
    useSearchStore.getState().requestFocus()
  }

  // dnSpy's Find String References in Module: shows the String References window, which takes the focus, and
  // scans every module of the assemblies the nodes are in.
  const findStringReferences = (nodes: TreeNode[]): void => {
    if (nodes.length === 0)
      return
    showToolWindow('string-references')
    useStringReferencesStore.getState().analyze(nodes.map((node) => node.id))
    // A context menu hands the focus back to the row it was opened on as it closes, which happens after
    // its command ran; the window asks for the focus once that is done.
    setTimeout(() => useStringReferencesStore.getState().requestFocus(), 0)
  }

  // dnSpy's Open Empty Tab (Ctrl+T is taken; the View menu and `--new-tab` are what reach it): a tab with
  // nothing in it, which is where the next document goes rather than beside the one showing now.
  const openEmptyTab = (): void => {
    const targetTabSet = getTargetDocumentTabSet(model)
    if (!targetTabSet)
      return
    model.doAction(Actions.addNode({
      type: 'tab',
      id: `empty:${Date.now()}`,
      name: t('Start'),
      component: 'start',
      enableClose: true,
    }, targetTabSet.getId(), DockLocation.CENTER, -1, true))
    // A live Start tab shows the same nothing and is what the layout expects to find; one left open beside
    // the empty tab would be two tabs saying the same thing.
    if (model.getNodeById('start'))
      model.doAction(Actions.deleteTab('start'))
    forceLayoutUpdate((value) => value + 1)
  }

  // Window-menu commands operate on document tabs only. Tool-window docks are deliberately excluded,
  // matching dnSpy's tab-group commands and preventing "Close All Tabs" from hiding the debugger panes.
  const activeDocumentTab = (): TabNode | undefined => {
    const activeTabSet = model.getActiveTabset()
    if (!activeTabSet || !getDocumentTabSets(model).includes(activeTabSet))
      return undefined
    const selected = activeTabSet.getSelectedNode()
    return selected instanceof TabNode && DOCUMENT_COMPONENTS.includes(selected.getComponent() ?? '') ? selected : undefined
  }
  const documentTabSets = (): TabSetNode[] => getDocumentTabSets(model).filter((tabSet) => tabSet.getTabNodes().length > 0)
  const refreshLayout = (): void => forceLayoutUpdate((value) => value + 1)
  // dnSpy's tab group commands, over the group a given tab is in. The Window menu runs them for the active
  // document and the tab menu runs them for the tab that was right-clicked, which is why they take the tab
  // rather than looking one up — the two menus offer the same commands over different tabs.
  const moveTabToGroup = (tab: TabNode, offset: -1 | 1, all: boolean): void => {
    const groups = documentTabSets()
    const source = tab.getParent()
    if (!(source instanceof TabSetNode)) return
    const target = groups[groups.indexOf(source) + offset]
    if (!target) return
    const ids = all ? source.getTabNodes().map((item) => item.getId()) : [tab.getId()]
    for (const id of ids) {
      if (model.getNodeById(id))
        model.doAction(Actions.moveNode(id, target.getId(), DockLocation.CENTER, -1, true))
    }
    refreshLayout()
  }
  const moveTabGroup = (tab: TabNode, after: boolean): void => {
    const groups = documentTabSets()
    const source = tab.getParent()
    if (!(source instanceof TabSetNode)) return
    const index = groups.indexOf(source)
    const target = groups[index + (after ? 1 : -1)]
    if (!target) return
    model.doAction(Actions.moveNode(source.getId(), target.getId(), after ? DockLocation.RIGHT : DockLocation.LEFT, -1, false))
    refreshLayout()
  }
  const closeTabGroup = (tab: TabNode): void => {
    const group = tab.getParent()
    if (!(group instanceof TabSetNode)) return
    for (const item of group.getTabNodes())
      if (item.isCloseable()) model.doAction(Actions.deleteTab(item.getId()))
    refreshLayout()
  }
  const closeOtherTabGroups = (tab: TabNode): void => {
    const current = tab.getParent()
    if (!(current instanceof TabSetNode)) return
    for (const group of documentTabSets()) {
      if (group === current) continue
      for (const item of group.getTabNodes())
        if (item.isCloseable()) model.doAction(Actions.deleteTab(item.getId()))
    }
    refreshLayout()
  }
  const mergeTabGroups = (): void => {
    const groups = documentTabSets()
    const target = activeDocumentTab()?.getParent()
    if (!(target instanceof TabSetNode)) return
    for (const group of groups) {
      if (group === target) continue
      for (const item of group.getTabNodes())
        model.doAction(Actions.moveNode(item.getId(), target.getId(), DockLocation.CENTER, -1, false))
    }
    refreshLayout()
  }
  const arrangeTabGroups = (horizontal: boolean): void => {
    const groups = documentTabSets()
    const target = groups[0]
    if (!target || groups.length < 2) return
    for (const group of groups.slice(1))
      if (model.getNodeById(group.getId()))
        model.doAction(Actions.moveNode(group.getId(), target.getId(), horizontal ? DockLocation.BOTTOM : DockLocation.RIGHT, -1, false))
    refreshLayout()
  }
  /** dnSpy's Window menu's own spelling of the commands above: it always acts on the active document's group. */
  const withActiveTab = (run: (tab: TabNode) => void): void => {
    const tab = activeDocumentTab()
    if (tab) run(tab)
  }
  /** dnSpy's Select Next/Previous Tab (Ctrl+Tab and Ctrl+Shift+Tab): the tab beside the active one in its own
   *  group, wrapping round at either end, and only when the group holds more than one tab. */
  const selectTabInGroup = (offset: -1 | 1): void => {
    const tabSet = model.getActiveTabset() ?? (model.getNodeById(DOCUMENT_TABSET_ID) as TabSetNode | undefined)
    const tabs = tabSet?.getTabNodes() ?? []
    if (tabs.length < 2) return
    const index = tabs.findIndex((tab) => tab.isSelected())
    const next = tabs[(index + offset + tabs.length) % tabs.length]
    model.doAction(Actions.selectTab(next.getId()))
    refreshLayout()
  }
  const windowTabs = useMemo(() => getDocumentTabs(model).map((tab) => ({
    id: tab.getId(),
    label: tab.getName(),
    checked: tab.isSelected(),
    documentId: documentIdOfTab(tab),
  })), [model, layoutVersion])
  // The Windows dialog's rows: the module column walks the tree up from the document's node, which
  // works for the members documents usually show; special tabs fall back to the single loaded module.
  const windowsDialogTabs = useMemo<WindowTabEntry[]>(() => windowTabs.map((tab) => {
    let moduleId: string | undefined
    let ancestor = tab.documentId ?? tab.id
    const seen = new Set<string>()
    while (!seen.has(ancestor)) {
      seen.add(ancestor)
      const parentId = treeParents[ancestor]
      if (!parentId) break
      if (modules.some((module) => module.id === parentId)) {
        moduleId = parentId
        break
      }
      ancestor = parentId
    }
    const module = modules.find((candidate) => candidate.id === moduleId) ?? (modules.length === 1 ? modules[0] : undefined)
    return { id: tab.id, name: tab.label, moduleName: module?.name ?? '', modulePath: module?.path ?? '' }
  }), [windowTabs, modules, treeParents])
  const currentWindowTab = activeDocumentTab()
  const currentWindowGroup = currentWindowTab?.getParent()
  const windowGroups = documentTabSets()
  const currentWindowGroupIndex = currentWindowGroup instanceof TabSetNode ? windowGroups.indexOf(currentWindowGroup) : -1
  const hasOtherWindowGroup = windowGroups.length > 1
  const canCloneWindow = currentWindowTab?.getComponent() === 'document'
  // The WPF tab-group service exposes separate CanExecute values for horizontal and vertical splits.
  // Reuse the context-menu calculation so the application menu hides only the direction that cannot
  // be created in the current layout.
  const windowTabMenuState = currentWindowTab
    ? getDocumentTabMenuState(currentWindowTab, false, canCloneWindow)
    : undefined
  const commonWindowGroupParent = windowGroups.length > 0
    && windowGroups.every((group) => group.getParent() === windowGroups[0].getParent())
    ? windowGroups[0].getParent()
    : undefined
  // dnSpy names the two arrangements after the split line rather than after the stacking: the groups laid
  // out in a row are what "use vertical tab groups" would make of them, so that command is offered while
  // they are stacked instead, and the other way round.
  const windowGroupsAreSideBySide = commonWindowGroupParent instanceof RowNode
    && commonWindowGroupParent.getOrientation() === Orientation.HORZ

  /** The tab in front of the editor area — dnSpy's DocumentTabService.ActiveTab — whatever has the focus now. */
  const frontDocumentTab = (): TabNode | undefined => {
    const selected = getTargetDocumentTabSet(model)?.getSelectedNode()
    return selected instanceof TabNode && DOCUMENT_COMPONENTS.includes(selected.getComponent() ?? '') ? selected : undefined
  }

  // dnSpy's Show Code (View › Code, F7, Esc, Ctrl+Alt+0): the focus goes to the tab in front, which is all it does.
  const showCode = async (): Promise<void> => {
    const tab = frontDocumentTab()
    if (!tab)
      return
    if (tab.getComponent() === 'document')
      focusDocumentEditor(tab.getId())
    else
      model.doAction(Actions.selectTab(tab.getId()))
  }

  const collapseTreeViewNodes = (): void => useAppStore.getState().collapseTreeViewNodes()

  /** dnSpy's settings command for a node — Edit Method... and its Alt+Enter. A node whose dialog has not
   *  been built yet has no shortcut, since there is nothing for it to open. */
  const openEditNode = (node = selectedNode): void => {
    if (node !== undefined && isEditableKind(node.kind))
      setEditNode({ kind: node.kind, nodeId: node.id })
  }

  /**
   * The five create commands. A member goes into the type the node belongs to, which is the node itself or
   * the type a member hangs off. A type is the one of them with two forms: a nested one goes into that same
   * type, while a top-level one is filed by whoever the node is — a namespace by its own name, a type by the
   * namespace it is already in, and a module by nothing at all. dnSpy reaches the first through the
   * namespace ancestor of the node and the second through the node itself, which is why the owner is picked
   * differently here. The node defaults to the selection, which is what the menus carry; the code viewer's
   * context menu is the exception, running them off the reference under the caret instead.
   */
  const createMember = (kind: CreatedKind, nested = false, node: TreeNode | undefined = selectedNode): void => {
    const ownerNodeId = kind === 'type' && !nested ? node?.id : ownerTypeIdOf(treeNodesById, treeParents, node)
    if (ownerNodeId !== undefined)
      setEditNode({ kind, ownerNodeId, nested })
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const editingText = target?.matches('input, textarea, select, [contenteditable="true"]') ?? false
      // The debugger's keys are global in dnSpy, the document viewer included: its text is read-only, so the
      // textarea Monaco keeps the focus in is no text being typed into.
      const debugKeysBlocked = editingText && target?.closest('.document-view') === null
      // The bookmark commands are two-key chords: Ctrl+K or Ctrl+B arms them and the second key runs one.
      // Monaco binds the same chords while the code editor has focus and stops the event there, so this
      // path is the one that answers when the focus is in the tree, a tool window or the menu bar. The
      // armed chord is read first, so Ctrl+K Ctrl+K toggles rather than arming again; a modifier pressed on
      // its own between the two keys leaves the chord waiting.
      const key = event.key.toLowerCase()
      const debugArmed = debugWindowChord.current
      if (!editingText && debugArmed && debugArmed.until > Date.now() && !['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
        debugWindowChord.current = undefined
        const digit = /^(?:Digit|Numpad)([1-4])$/.exec(event.code)?.[1]
        const target = debugArmed.prefix === 'v'
          ? event.code === 'KeyA' ? 'autos' : event.code === 'KeyL' ? 'locals' : undefined
          : digit === undefined ? undefined : debugArmed.prefix === 'w'
            ? digit === '1' ? 'watch' : `watch-${digit}`
            : digit === '1' ? 'memory' : `memory-${digit}`
        if (target) {
          event.preventDefault()
          showToolWindow(target)
          return
        }
      }
      if (!editingText && event.ctrlKey && event.altKey && !event.shiftKey && (event.code === 'KeyW' || event.code === 'KeyM' || event.code === 'KeyV')) {
        event.preventDefault()
        debugWindowChord.current = { prefix: event.code.slice(3).toLowerCase(), until: Date.now() + 2000 }
        return
      }
      if (!editingText && event.altKey && !event.ctrlKey && !event.shiftKey && (event.code === 'Digit6' || event.code === 'Numpad6')) {
        // dnSpy's Memory 1, Alt+6.
        event.preventDefault()
        showToolWindow('memory')
        return
      }
      const armed = bookmarkChord.current
      if (!editingText && armed && armed.until > Date.now() && !event.shiftKey && !event.altKey) {
        const chord = [...bookmarkChords, ...viewChords].find((candidate) => candidate.prefix === armed.prefix && candidate.key === key && (event.ctrlKey || candidate.plain))
        if (chord) {
          bookmarkChord.current = undefined
          event.preventDefault()
          chord.run()
          return
        }
      }
      if (!editingText && !event.shiftKey && !event.altKey && event.ctrlKey && (key === 'k' || key === 'b' || key === 'e')) {
        event.preventDefault()
        bookmarkChord.current = { prefix: key, until: Date.now() + 2000 }
        return
      }
      if (!['Control', 'Shift', 'Alt', 'Meta'].includes(event.key))
        bookmarkChord.current = undefined
      // The zoom keys act on the tab in front: a document viewer's text zoom, or the zoom of any other tab's content.
      const zoomTab = (step: (current: number) => number): void => {
        if (documentIdOfTab(activeDocumentTab()))
          setDocumentViewerZoom(step)
        else
          setDocumentZoom((current) => normalizeZoom(step(current)))
      }
      if (event.ctrlKey && !event.altKey && (event.code === 'Equal' || event.code === 'NumpadAdd')) {
        // dnSpy's Zoom In, which its ZoomSelector steps through a list of levels rather than by a fixed step.
        event.preventDefault()
        zoomTab(zoomIn)
      } else if (event.ctrlKey && !event.altKey && (event.code === 'Minus' || event.code === 'NumpadSubtract')) {
        event.preventDefault()
        zoomTab(zoomOut)
      } else if (event.ctrlKey && !event.altKey && !event.shiftKey && (event.code === 'Digit0' || event.code === 'Numpad0')) {
        // dnSpy's Zoom Reset. Ctrl+Alt+0 is "Show Code" and is read further down, so the two do not meet.
        event.preventDefault()
        zoomTab(() => 100)
      } else if (event.altKey && !event.ctrlKey && !event.shiftKey && event.key === 'ArrowLeft' && !editingText) {
        // dnSpy's Back and Forward: Alt+Left and Backspace, Alt+Right and Shift+Backspace.
        event.preventDefault()
        void goBack()
      } else if (event.altKey && !event.ctrlKey && !event.shiftKey && event.key === 'ArrowRight' && !editingText) {
        event.preventDefault()
        void goForward()
      } else if (event.key === 'Backspace' && !event.ctrlKey && !event.altKey && !editingText) {
        event.preventDefault()
        if (event.shiftKey) void goForward()
        else void goBack()
      } else if ((event.key === 'F7' || (event.key === 'Escape' && !editingText && !target?.closest('[role="dialog"], [role="menu"]'))) && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        // dnSpy's Show Code: F7 and Esc, which put the focus in the tab in front.
        event.preventDefault()
        void showCode()
      } else if (event.ctrlKey && event.shiftKey && event.key === 'Tab') {
        // dnSpy's Select Previous Tab: the tab before the active one in its own group, wrapping round.
        event.preventDefault()
        selectTabInGroup(-1)
      } else if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault()
        selectTabInGroup(1)
      } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'o') {
        // dnSpy's Open from GAC, the gesture its File menu shows.
        event.preventDefault()
        setGacDialogOpen(true)
      } else if (event.ctrlKey && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        void chooseAndOpen()
      } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 's') {
        // dnSpy's Save All. Save Module... is the one without a gesture, so it moves no other binding.
        event.preventDefault()
        void saveAllModules()
      } else if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 's') {
        // dnSpy's Save: the active document. A code tab is a document of its own here, and the tab menu
        // advertises this key for its "Save Code..."; with no such tab the command falls to the module.
        const tab = model.getActiveTabset()?.getSelectedNode()
        const config = tab?.getComponent() === 'document'
          ? tab.getConfig() as { documentId?: string } | undefined
          : undefined
        const document = config?.documentId ? useAppStore.getState().documents[config.documentId] : undefined
        if (config?.documentId && document && !document.loading) {
          event.preventDefault()
          void saveCode(config.documentId)
        } else if (!editingText) {
          event.preventDefault()
          void saveActiveDocument()
        }
      } else if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 't') {
        const tab = model.getActiveTabset()?.getSelectedNode()
        if (tab?.getComponent() === 'document') {
          event.preventDefault()
          cloneDocumentTab(tab)
          forceLayoutUpdate((value) => value + 1)
        }
      } else if (event.ctrlKey && !event.shiftKey && event.key === 'F4') {
        const tab = model.getActiveTabset()?.getSelectedNode()
        if (tab?.isCloseable()) {
          event.preventDefault()
          closeDocumentTab(tab)
          forceLayoutUpdate((value) => value + 1)
        }
      } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'r') {
        // dnSpy's Analyze. The code viewer and the analyzer bind the key themselves; from the assembly tree
        // it analyzes the member the first selected row names, and anywhere else — or for a row that names
        // none, such as a base type that does not resolve — it brings an open analyzer forward.
        event.preventDefault()
        const first = useAppStore.getState().selectedNodes[0] ?? selectedNode
        const showAnalyzer = (): void => { if (model.getNodeById('analysis')) showToolWindow('analysis') }
        if (target?.closest('.assembly-tree:not(.analyzer-tree)') && isAnalyzableNode(first))
          void resolveAnalyzeTargets([first]).then(([node]) => node ? openAnalysis(node) : showAnalyzer())
        else
          showAnalyzer()
      } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        collapseTreeViewNodes()
      } else if (event.ctrlKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'd' && !editingText) {
        // dnSpy's Go to MD Table Row, in the module of the open code document or of the selection.
        const target = mdTableRowTarget()
        if (target) {
          event.preventDefault()
          setMdRowNode(target)
        }
      } else if (event.shiftKey && event.altKey && !event.ctrlKey && event.code === 'KeyR' && !editingText) {
        // dnSpy's Go to MD Table Row for the selected row's own token.
        if (selectedNode?.metadataToken !== undefined && hasMetadataTables(useAppStore.getState(), selectedNode.id)) {
          event.preventDefault()
          goToMdTableRow(selectedNode, selectedNode.metadataToken)
        }
      } else if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'd' && !editingText) {
        // dnSpy's Go to Token, which its tree and its document viewer both bind to Ctrl+D.
        event.preventDefault()
        setTokenNode(selectedNode)
      } else if (event.ctrlKey && event.altKey && !event.shiftKey && event.code === 'KeyL') {
        event.preventDefault()
        showToolWindow('explorer')
      } else if (event.ctrlKey && event.altKey && !event.shiftKey && event.code === 'KeyP') {
        // dnSpy's Attach to Process. The dialog is what the gesture opens; the process is chosen in it.
        event.preventDefault()
        setAttachDialogOpen(true)
      } else if (event.ctrlKey && event.altKey && !event.shiftKey && (event.code === 'Digit2' || event.code === 'Numpad2')) {
        event.preventDefault()
        showToolWindow('output')
      } else if (event.ctrlKey && event.altKey && !event.shiftKey && (event.code === 'Digit4' || event.code === 'Numpad4')) {
        event.preventDefault()
        showToolWindow('locals')
      } else if (event.altKey && !event.shiftKey && (event.code === 'Digit8' || event.code === 'Numpad8')) {
        event.preventDefault()
        showActiveFrameDisassembly()
      } else if (event.ctrlKey && event.altKey && !event.shiftKey && event.code === 'KeyB') {
        event.preventDefault()
        showToolWindow('breakpoints')
      } else if (event.ctrlKey && event.altKey && !event.shiftKey && event.code === 'KeyE') {
        event.preventDefault()
        showToolWindow('exception-settings')
      } else if (event.ctrlKey && event.altKey && !event.shiftKey && event.code === 'KeyC') {
        event.preventDefault()
        showToolWindow('callstack')
      } else if (event.ctrlKey && event.altKey && !event.shiftKey && event.code === 'KeyH') {
        event.preventDefault()
        showToolWindow('threads')
      } else if (event.ctrlKey && event.altKey && !event.shiftKey && event.code === 'KeyU') {
        event.preventDefault()
        showToolWindow('modules')
      } else if (event.ctrlKey && event.altKey && !event.shiftKey && event.code === 'KeyZ') {
        event.preventDefault()
        showToolWindow('processes')
      } else if (event.ctrlKey && event.altKey && event.code === 'Break' && debugState === 'running') {
        // dnSpy's Break, which is what its Debug menu shows against Ctrl+Alt+Break.
        event.preventDefault()
        void pauseDebug()
      } else if (event.ctrlKey && event.altKey && (event.code === 'Digit0' || event.code === 'Numpad0')) {
        event.preventDefault()
        void showCode()
      } else if (event.ctrlKey && event.altKey && event.code === 'KeyN') {
        event.preventDefault()
        showToolWindow('csharp-interactive')
      } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'k' && workspaceId) {
        event.preventDefault()
        showSearch()
      } else if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'f' && activeDocument === 'code') {
        event.preventDefault()
        findInActiveDocumentEditor()
      } else if (event.ctrlKey && event.key.toLowerCase() === 'z' && canUndo && !editingText) {
        event.preventDefault()
        undo()
      } else if (event.ctrlKey && event.key.toLowerCase() === 'y' && canRedo && !editingText) {
        event.preventDefault()
        redo()
      } else if (event.shiftKey && event.altKey && event.key === 'Enter') {
        // dnSpy's Full Screen, Shift+Alt+Enter. It is read before Alt+Enter, which would otherwise take it
        // for the selected node's settings command.
        event.preventDefault()
        void window.dnSpy.toggleFullScreen()
      } else if (event.altKey && event.key === 'Enter' && !event.shiftKey && !editingText) {
        // dnSpy's Alt+Enter: the settings command of the selected node, which its menu lists beside
        // Edit Method...
        event.preventDefault()
        openEditNode()
      } else if (event.key === 'F2' && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && selectedNode && !editingText && ['type', 'method', 'field', 'property', 'event'].includes(selectedNode.kind)) {
        event.preventDefault()
        setRenameNode(selectedNode)
      } else if (event.key === 'Delete' && selectedNode && !editingText && DELETABLE_KINDS.includes(selectedNode.kind)) {
        event.preventDefault()
        deleteSelected()
      } else if (event.ctrlKey && event.shiftKey && event.key === 'F9') {
        event.preventDefault()
        deleteAllBreakpoints()
      } else if (event.key === 'F9' && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && !editingText) {
        event.preventDefault()
        toggleBreakpointHere()
      } else if (event.ctrlKey && event.shiftKey && event.key === 'F5' && debugState !== 'inactive' && !debugKeysBlocked) {
        // dnSpy's Restart: the program goes and comes back the way it was started.
        event.preventDefault()
        void useAppStore.getState().restartDebug()
      } else if (event.ctrlKey && event.altKey && (event.key === 'F10' || event.key === 'F11') && debugState === 'stopped' && !debugKeysBlocked && !loadAppOptions().debugger.breakAllProcesses) {
        // dnSpy's Step Into/Over/Out (Current Process): Ctrl+Alt+F11, Ctrl+Alt+F10 and Ctrl+Shift+Alt+F11.
        event.preventDefault()
        void stepDebug(event.key === 'F10' ? 'next' : event.shiftKey ? 'stepOut' : 'stepIn', true)
      } else if (event.ctrlKey && event.shiftKey && event.key === 'F10' && debugState === 'stopped' && !debugKeysBlocked) {
        // dnSpy's Set Next Statement, from the statement under the caret.
        event.preventDefault()
        void useAppStore.getState().setNextStatement()
      } else if (event.ctrlKey && !event.shiftKey && event.key === 'F10' && debugState === 'stopped' && !debugKeysBlocked) {
        // dnSpy's Run to Cursor.
        event.preventDefault()
        void useAppStore.getState().runToCursor()
      } else if (event.shiftKey && event.key === 'F5' && debugState !== 'inactive' && !debugKeysBlocked) {
        event.preventDefault()
        void stopDebug()
      } else if (event.altKey && event.code === 'NumpadMultiply' && debugState === 'stopped' && !debugKeysBlocked) {
        // dnSpy's Show Next Statement, which its Debug menu shows with Alt+Numpad* against it.
        event.preventDefault()
        void revealStoppedLocation()
      } else if (event.ctrlKey && !event.shiftKey && event.key === 'F5' && !debugKeysBlocked) {
        // dnSpy's Start Without Debugging.
        event.preventDefault()
        setRunProgramDialogOpen(true)
      } else if (event.key === 'F5' && !debugKeysBlocked) {
        event.preventDefault()
        if (debugState === 'stopped') void continueDebug()
        // Upstream's F5 is ContinueOrDebugProgram: with no session it is the Start button, dialog and all.
        else if (debugState === 'inactive') setDebugProgramDialogOpen(true)
      } else if (event.key === 'F10' && debugState === 'stopped' && !debugKeysBlocked) {
        event.preventDefault()
        void stepDebug('next')
      } else if (event.shiftKey && event.key === 'F11' && debugState === 'stopped' && !debugKeysBlocked) {
        event.preventDefault()
        void stepDebug('stepOut')
      } else if (event.key === 'F11' && !event.shiftKey && debugState === 'stopped' && !debugKeysBlocked) {
        event.preventDefault()
        void stepDebug('stepIn')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeDocument, canRedo, canUndo, chooseAndOpen, collapseTreeViewNodes, continueDebug, debugState, deleteAllBreakpoints, deleteSelected, model, openEditNode, pauseDebug, redoEdit, saveAllModules, saveCode, saveModule, selectedNode, showToolWindow, showCode, stepDebug, stopDebug, toggleBreakpointHere, undoEdit, workspaceId])

  // Closing the workspace's documents is also the first thing a restore does, so the two share it.
  const closeDocumentTabs = (): void => {
    const tabsToClose: string[] = []
    model.visitNodes((node) => {
      if (node instanceof TabNode && ['document', 'hex', 'module-info'].includes(node.getComponent() ?? ''))
        tabsToClose.push(node.getId())
    })
    for (const tabId of tabsToClose)
      model.doAction(Actions.deleteTab(tabId))
  }

  const showStartTab = (): void => {
    const targetTabSet = getTargetDocumentTabSet(model)
    if (!model.getNodeById('start') && targetTabSet)
      model.doAction(Actions.addNode({ type: 'tab', id: 'start', name: t('Start'), component: 'start', enableClose: false }, targetTabSet.getId(), DockLocation.CENTER, -1, true))
  }

  useEffect(() => {
    if (previousWorkspaceId.current === workspaceId)
      return
    previousWorkspaceId.current = workspaceId
    tabHistories.current.clear()
    setHistoryVersion((value) => value + 1)
    // A restore opens the workspace itself, and the tabs it puts back are the ones this would otherwise
    // delete a moment later; it clears the stale ones and adds Start where it needs them.
    if (useAppStore.getState().restoringSession)
      return
    closeDocumentTabs()
    showStartTab()
    forceLayoutUpdate((value) => value + 1)
  }, [model, workspaceId, t])

  // dnSpy's exit question, put to the window as it closes: unsaved files are offered to be saved first, "No" lets
  // them go unsaved, and closing the box — or a save that did not write every file — keeps the window open. The
  // Open List is written last, as dnSpy writes the files that are open on exit.
  const closeRequested = async (): Promise<void> => {
    const state = useAppStore.getState()
    if (state.workspaceId)
      await state.refreshModifiedDocuments()
    const modified = useAppStore.getState().modifiedDocuments
    if (modified.length > 0) {
      // dnSpy's AppWindow_MainWindowClosing: Yes goes through the save windows — one document's Save Module
      // window, several documents' Save Modules window — and the exit only happens when every file was written.
      const answer = await window.dnSpy.askExitUnsaved(modified.length)
      if (answer === 'cancel' || (answer === 'save' && !await state.requestSave(modified.map((document) => document.id)))) {
        await window.dnSpy.respondToClose(false)
        return
      }
    }
    rememberCurrentDocuments(useAppStore.getState().modules.filter((module) => !module.inMemory).map((module) => module.path))
    await window.dnSpy.respondToClose(true)
  }

  // The main process holds the close back while the window has unsaved work — it cannot see what that work
  // is, so it asks here — and calls this off entirely when there was none to ask about.
  useEffect(() => {
    return window.dnSpy.onCloseRequested(() => {
      void shellCallbacksRef.current.closeRequested()
    })
  }, [])

  useEffect(() => {
    // dnSpy saves what is open as the window closes, and the main process needs to know whether there is
    // anything to ask about before it lets the close through.
    void window.dnSpy.setUnsavedChanges(dirty)
  }, [dirty])

  /** A tab's history, made the first time it is asked for. */
  const historyOf = (tabId: string): TabHistory => {
    let history = tabHistories.current.get(tabId)
    if (!history) {
      history = { back: [], forward: [] }
      tabHistories.current.set(tabId, history)
    }
    return history
  }

  /** Where a document tab is now: the document, its language, and the caret and scroll of its view — or the file
   *  its hex view shows, and where that view is. */
  const currentHistoryEntry = (tab: TabNode): TabHistoryEntry | undefined => {
    if (tab.getComponent() === 'hex') {
      const moduleId = (tab.getConfig() as { moduleId?: string } | undefined)?.moduleId
      return moduleId ? { kind: 'hex', moduleId, state: useAppStore.getState().hexTabs.find((candidate) => candidate.moduleId === moduleId)?.state } : undefined
    }
    const documentId = documentIdOfTab(tab)
    if (!documentId)
      return undefined
    const document = useAppStore.getState().documents[documentId]
    const caret = caretPosition(tab.getId())
    return {
      documentId,
      language: document?.requestedLanguage,
      line: caret?.line ?? document?.cursorLine,
      column: caret?.column ?? document?.cursorColumn,
      scrollTop: documentEditorScrollTop(tab.getId()) ?? document?.scrollTop,
    }
  }

  /** dnSpy's TabHistory.SetCurrent with saveCurrent: where the tab is goes on its back list, and its forward
   *  list is dropped, the way a new navigation drops it. */
  const recordTabHistory = (tab: TabNode): void => {
    const entry = currentHistoryEntry(tab)
    if (!entry)
      return
    const history = historyOf(tab.getId())
    history.back.push(entry)
    history.forward = []
    setHistoryVersion((value) => value + 1)
  }

  /**
   * dnSpy's DocumentTabService.ShowNodes / FollowReference: a node is shown in the tab in front — its content
   * replaced, and where it was kept in its history — or, with `newTab`, in a tab of its own. A tab that shows
   * no document (the start page, a hex view) takes the document in its place. Answers with the id of the tab
   * the document ended up in, which is the view a caret placed afterwards has to land in.
   */
  const addDocumentTab = async (shownNodes: TreeNode | TreeNode[], recordHistory = true, language?: DecompilerLanguage, newTab = false, intoTab?: TabNode): Promise<string | undefined> => {
    // dnSpy's tab shows an array of nodes: the top-level selection decompiles into one document.
    const nodes = Array.isArray(shownNodes) ? shownNodes : [shownNodes]
    if (nodes.length === 0)
      return undefined
    const { workspaceId, workspaceGeneration } = useAppStore.getState()
    const front = intoTab ?? (newTab ? undefined : frontDocumentTab())
    const target = front && DOCUMENT_COMPONENTS.includes(front.getComponent() ?? '') && front.getComponent() !== 'start' ? front : undefined
    const shown = documentIdOfTab(target)
    const shownDocument = shown ? useAppStore.getState().documents[shown] : undefined
    const documentId = documentIdOf(nodes.map((node) => node.id))
    // The node the tab already shows, in the language asked for, is not decompiled again: there is nothing to
    // show that it does not show already, or will once the decompilation under way is done. A document whose
    // decompilation was canceled or failed is decompiled again, the way dnSpy shows a node anew.
    const alreadyShown = shown === documentId && shownDocument !== undefined
      && (language === undefined || shownDocument.requestedLanguage === language)
      && shownDocument.failure === undefined
      && (shownDocument.loading === true || shownDocument.diagnostics.every((diagnostic) => diagnostic.severity !== 'error'))
    // A hex view the document takes the place of is a step of the history too (dnSpy's tab content, whatever it is).
    if (target && recordHistory && (shown ? shown !== documentId : target.getComponent() === 'hex'))
      recordTabHistory(target)
    // A tab that moves on to another document calls off what it was still decompiling — unless another tab
    // shows that document too.
    if (target && shown && shown !== documentId && useAppStore.getState().documents[shown]?.loading
      && !getDocumentTabs(model).some((tab) => tab !== target && documentIdOfTab(tab) === shown))
      useAppStore.getState().cancelDocument(shown)
    // The document goes into its tab at once, loading — dnSpy shows a tab decompiling — so whatever asks for it
    // next finds it there rather than opening it a second time.
    const opening = alreadyShown ? Promise.resolve(documentId) : useAppStore.getState().openNodesDocument(nodes, language)
    // A group folder is labelled from dnSpy's resources, in the UI language, in its tab as in the tree.
    const titleOf = (): string => nodes.length === 1 && GROUP_FOLDER_KINDS.has(nodes[0].kind)
      ? t(nodes[0].label)
      : useAppStore.getState().documents[documentId]?.title || documentTitleOf(nodes)
    const toolTipOf = (): string => useAppStore.getState().documents[documentId]?.toolTip ?? documentToolTipOf(nodes)
    let tabId: string
    if (target) {
      tabId = target.getId()
      if (shown !== documentId || target.getComponent() !== 'document')
        model.doAction(Actions.updateNodeAttributes(tabId, { name: titleOf(), helpText: toolTipOf(), component: 'document', config: { documentId } }))
      if (!target.isSelected())
        model.doAction(Actions.selectTab(tabId))
    } else {
      // A new tab goes beside the one in front — or in place of the start page that was in front.
      const targetTabSet = (front?.getParent() instanceof TabSetNode ? front.getParent() as TabSetNode : undefined) ?? getTargetDocumentTabSet(model)
      if (!targetTabSet) return undefined
      tabId = newDocumentTabId()
      model.doAction(Actions.addNode({
        type: 'tab',
        id: tabId,
        name: titleOf(),
        helpText: toolTipOf(),
        component: 'document',
        config: { documentId },
      }, targetTabSet.getId(), DockLocation.CENTER, -1, true))
      if (front?.getComponent() === 'start' && front.isCloseable() && model.getNodeById(front.getId()))
        model.doAction(Actions.deleteTab(front.getId()))
      if (model.getNodeById('start'))
        model.doAction(Actions.deleteTab('start'))
    }
    forceLayoutUpdate((value) => value + 1)
    await opening
    const current = useAppStore.getState()
    if (current.workspaceId !== workspaceId || current.workspaceGeneration !== workspaceGeneration)
      return undefined
    // A method's tab shows the title the backend decompiled it under — "name(params) : return" — not
    // the tree label, which drops the return type. Anything else already labels the two the same way.
    const tab = model.getNodeById(tabId)
    if (!(tab instanceof TabNode) || documentIdOfTab(tab) !== documentId)
      return undefined
    if (tab.getName() !== titleOf()) {
      model.doAction(Actions.renameTab(tabId, titleOf()))
      forceLayoutUpdate((value) => value + 1)
    }
    return tabId
  }

  /**
   * dnSpy's FollowReference to a member — TreeNodeReferenceDocumentTabContentProvider: a state machine's MoveNext
   * stands for the method it was made from, and with DecompileFullType on the document is the outermost type the
   * member is declared in, with the caret on the member's definition. Answers the document and the tab it went to.
   */
  const followNode = async (nodeId: string, newTab: boolean, intoTab?: TabNode): Promise<{ documentId: string; viewId: string } | undefined> => {
    const workspaceId = useAppStore.getState().workspaceId
    if (!workspaceId)
      return undefined
    const decompileFullType = loadAppOptions().environmentGeneral.decompileFullType
    const resolved = await window.dnSpy.resolveDocumentNode(workspaceId, nodeId, decompileFullType)
      .catch(() => ({ documentNodeId: nodeId, definitionNodeId: nodeId }))
    const node = findNode(useAppStore.getState(), resolved.documentNodeId) ?? await window.dnSpy.getNode(workspaceId, resolved.documentNodeId)
    const viewId = await addDocumentTab(node, true, undefined, newTab, newTab ? undefined : intoTab)
    if (!viewId)
      return undefined
    useAppStore.getState().requestCaret({ documentId: node.id, viewId, line: 1, column: 1, definitionNodeId: resolved.definitionNodeId, center: true })
    return { documentId: node.id, viewId }
  }

  /** The nodes a document id names — one, or the nodes of a multi-selection — read from the tree or the backend. */
  const nodesOfDocument = async (workspaceId: string, documentId: string): Promise<TreeNode[]> => {
    const nodes: TreeNode[] = []
    for (const nodeId of nodeIdsOfDocument(documentId))
      nodes.push(findNode(useAppStore.getState(), nodeId) ?? await window.dnSpy.getNode(workspaceId, nodeId))
    return nodes
  }

  /** The document tab that shows a node, the one in front first — where a step of the debugger lands. */
  const tabShowing = (documentId: string): TabNode | undefined => {
    const tabs = getDocumentTabs(model).filter((tab) => documentIdOfTab(tab) === documentId)
    return tabs.find((tab) => tab.isSelected()) ?? tabs[0]
  }

  /**
   * dnSpy's FollowReference from a document viewer. A local goes to a copy of the document in a new tab, with
   * the caret on its declaration. A member is shown in the viewer's own tab — or a new one — and the caret is
   * put on its definition; with DecompileFullType on, the document is the whole type the member is in, the
   * outermost one, which is what dnSpy decompiles for a reference.
   */
  const followReference = async (span: TextSpan, newTab: boolean, viewId: string): Promise<void> => {
    const sourceTab = model.getNodeById(viewId)
    const source = sourceTab instanceof TabNode ? sourceTab : undefined
    if (isLocalSpan(span)) {
      const documentId = documentIdOfTab(source)
      const document = documentId ? useAppStore.getState().documents[documentId] : undefined
      if (!source || !documentId || !document)
        return
      const definition = document.spans.find((candidate) => candidate.localId === span.localId && candidate.kind === 'definition') ?? span
      const clone = cloneDocumentTab(source)
      if (!clone)
        return
      const { line, column } = positionAt(document.text, definition.start + definition.length)
      useAppStore.getState().requestCaret({ documentId, viewId: clone.getId(), line, column })
      forceLayoutUpdate((value) => value + 1)
      return
    }
    const state = useAppStore.getState()
    const workspaceId = state.workspaceId
    if (!workspaceId)
      return
    try {
      const nodeId = await state.resolveReferenceTarget(span)
      if (!nodeId)
        return
      await followNode(nodeId, newTab, source)
    } catch (reason) {
      appendOutput(t('Navigation failed: {message}', { message: reason instanceof Error ? reason.message : String(reason) }))
    }
  }

  /** Records where a viewer's caret is before it moves the caret within its document — a step dnSpy's history keeps. */
  const recordViewHistory = (viewId: string): void => {
    const tab = model.getNodeById(viewId)
    if (tab instanceof TabNode)
      recordTabHistory(tab)
  }

  /**
   * dnSpy's Back and Forward (NavigationCommands.BrowseBack/BrowseForward) over the history of the tab in front:
   * the tab shows the document it showed then, in the language it was in, with the caret and the scroll where
   * they were — and where it was until now goes on the other list.
   */
  const stepHistory = async (back: boolean): Promise<void> => {
    const tab = frontDocumentTab()
    if (!tab)
      return
    const history = historyOf(tab.getId())
    const entry = back ? history.back.pop() : history.forward.pop()
    if (!entry)
      return
    const current = currentHistoryEntry(tab)
    if (current)
      (back ? history.forward : history.back).push(current)
    setHistoryVersion((value) => value + 1)
    if (entry.kind === 'hex') {
      // The view comes back where it was left rather than on the bytes the last hex command asked for.
      useAppStore.getState().clearHexNavigation()
      await showHexContent(entry.moduleId, { intoTab: tab, recordHistory: false, state: entry.state })
      return
    }
    const workspaceId = useAppStore.getState().workspaceId
    if (!workspaceId)
      return
    try {
      const nodes = await nodesOfDocument(workspaceId, entry.documentId)
      const viewId = await addDocumentTab(nodes, false, entry.language, false, tab)
      if (viewId)
        useAppStore.getState().requestCaret({ documentId: entry.documentId, viewId, line: entry.line ?? 1, column: entry.column ?? 1, scrollTop: entry.scrollTop })
    } catch (reason) {
      appendOutput(t('Navigation failed: {message}', { message: reason instanceof Error ? reason.message : String(reason) }))
    }
  }

  /**
   * dnSpy's hex tabs come back by file (HexViewDocumentTabContentFactory.Deserialize), each with the view state it
   * was left in, at the place among the other tabs it was saved at. A file the workspace does not hold is shown as
   * it is on disk, as dnSpy's hex buffer of the file would be.
   */
  const restoreHexTabs = async (tabs: { path: string; state?: HexViewUiState; index?: number }[]): Promise<number> => {
    let restored = 0
    // In the order they were saved at, so each lands where it was among the tabs restored before it.
    const ordered = [...tabs].sort((left, right) => (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER))
    for (const tab of ordered) {
      const state = useAppStore.getState()
      const module = state.modules.find((candidate) => candidate.path === tab.path)
      const root = module ? state.roots.find((candidate) => candidate.id === module.id) : undefined
      if (await showHexContent(root?.id ?? `${HEX_FILE_PREFIX}${tab.path}`, { newTab: true, recordHistory: false, select: false, state: tab.state, index: tab.index }))
        restored++
    }
    return restored
  }

  /**
   * Puts the branches, the selection and the tabs a session names back on the tree the workspace holds now.
   * Every node the session names is looked up by key — walking down from the roots, materialising each branch on
   * the way, because only the roots exist after the files were opened — and whatever no longer resolves is passed
   * over so the rest still comes back. Answers how many tabs came back, or undefined when the workspace changed
   * under it.
   */
  const restoreTreeAndTabs = async (session: SavedSession, isCurrent: () => boolean): Promise<number | undefined> => {
    const byKey = new Map<string, TreeNode>()
    for (const root of useAppStore.getState().roots) {
      if (root.key)
        byKey.set(root.key, root)
    }
    for (const reference of session.nodes) {
      const node = byKey.get(reference.key)
      if (!node)
        continue
      // The list is ordered parents-first, so a node it names has its parent already in the map.
      // Expanding is not a toggle here: the explorer expands every fresh root on its own, and a
      // toggle would close the root it just opened.
      if (reference.expanded)
        await expandNode(node)
      else
        await loadChildren(node)
      if (!isCurrent()) return undefined
      for (const child of useAppStore.getState().children[node.id] ?? []) {
        if (child.key)
          byKey.set(child.key, child)
      }
    }
    const selected = session.selectedNode ? byKey.get(session.selectedNode) : undefined
    if (selected)
      selectNode(selected)
    let restoredDocuments = 0
    for (const document of session.documents) {
      const node = byKey.get(document.key)
      if (!node)
        continue
      // Each document the session held comes back in a tab of its own, in the order they were in.
      await addDocumentTab(node, false, document.language, true)
      if (!isCurrent()) return undefined
      restoredDocuments++
    }
    const active = session.activeDocument ? byKey.get(session.activeDocument) : undefined
    const activeTab = active ? tabShowing(active.id) : undefined
    if (activeTab) {
      model.doAction(Actions.selectTab(activeTab.getId()))
      forceLayoutUpdate((value) => value + 1)
    }
    return restoredDocuments
  }

  // Where the previous session comes back: the files it held are opened, and then its tree and tabs.
  const restoreSession = async (session: SavedSession): Promise<void> => {
    if (session.paths.length === 0)
      return
    const generation = useAppStore.getState().workspaceGeneration
    const isCurrent = (): boolean => useAppStore.getState().workspaceGeneration === generation
    setRestoringSession(true)
    try {
      // The saved layout still holds tabs from the run that wrote it, named by document ids that died
      // with it. They are rebuilt from the session below instead.
      closeDocumentTabs()
      const paths = await window.dnSpy.filterExistingPaths(session.paths)
      if (!isCurrent()) return
      if (paths.length < session.paths.length)
        appendOutput(t('{count} file(s) from the previous session are no longer on disk.', { count: session.paths.length - paths.length }))
      if (paths.length === 0) {
        showStartTab()
        forceLayoutUpdate((value) => value + 1)
        return
      }
      await openPaths(paths)
      if (!isCurrent()) return
      if (!useAppStore.getState().workspaceId)
        return // openPaths has already reported why
      const restoredDocuments = await restoreTreeAndTabs(session, isCurrent)
      if (restoredDocuments === undefined) return
      const restoredHexTabs = await restoreHexTabs(session.hexTabs ?? [])
      // Opening a document takes the Start tab away, so one only comes back when nothing was restored
      // to take its place.
      if (restoredDocuments === 0 && restoredHexTabs === 0)
        showStartTab()
      appendOutput(t('Restored the previous session.'))
    } catch (error) {
      if (!isCurrent()) return
      const message = error instanceof Error ? error.message : String(error)
      appendOutput(t('Could not restore the previous session: {message}', { message }))
      showStartTab()
      forceLayoutUpdate((value) => value + 1)
    } finally {
      // Enabled before the flag drops: the change that ends the restore is the one write that captures
      // everything it put back.
      if (isCurrent()) {
        enableSessionPersistence()
        setRestoringSession(false)
      }
    }
  }

  /**
   * dnSpy's Reload All Assemblies (DocumentListLoader.Reload). Unsaved edits are asked about first, with dnSpy's
   * question; the tabs are remembered and closed; the files the user opened are read again, with the ones the
   * workspace had opened by itself that a tab showed something of; and the tabs, the branches and the selection
   * are put back on the new tree — a module's hex and information tabs by the file they show.
   */
  const reloadAll = async (): Promise<void> => {
    const state = useAppStore.getState()
    if (!state.workspaceId)
      return
    const modified = await getModifiedModules()
    if (modified.length > 0) {
      const unsaved = modified.length === 1 ? t('There is an unsaved file.') : t('There are {count} unsaved files.', { count: modified.length })
      if (!window.confirm(`${unsaved} ${t('Are you sure you want to reload all assemblies and lose all changes?')}`))
        return
    }
    const current = useAppStore.getState()
    const session = buildSession(current)
    // A module tab names its module by the root's id, which the reload issues again; the file is what stays.
    const moduleTabs: { component: 'hex' | 'module-info'; path: string; state?: HexViewUiState; index?: number }[] = []
    model.visitNodes((node) => {
      const component = node instanceof TabNode ? node.getComponent() : undefined
      if (node instanceof TabNode && (component === 'hex' || component === 'module-info')) {
        const moduleId = (node.getConfig() as { moduleId?: string } | undefined)?.moduleId
        const module = current.modules.find((candidate) => candidate.id === moduleId)
        const hexTab = component === 'hex' ? current.hexTabs.find((tab) => tab.moduleId === moduleId) : undefined
        if (module)
          moduleTabs.push({ component, path: module.path, state: hexTab?.state, index: hexTab?.index })
      }
    })
    // DocumentListLoader adds back the auto-loaded documents a tab shows something of, auto-loaded as they were.
    const rootIdOf = (id: string): string => {
      let rootId = id
      for (let parent = current.parents[rootId]; parent !== undefined; parent = current.parents[rootId])
        rootId = parent
      return rootId
    }
    const shownRoots = new Set(current.documentOrder.map(rootIdOf))
    const autoLoaded = current.modules
      .filter((module) => module.autoLoaded && (shownRoots.has(module.id) || moduleTabs.some((tab) => tab.path === module.path)))
      .map((module) => module.path)
    const generation = current.workspaceGeneration
    const isCurrent = (): boolean => useAppStore.getState().workspaceGeneration === generation
    setRestoringSession(true)
    try {
      closeDocumentTabs()
      if (!await reloadAllAssemblies(autoLoaded) || !isCurrent()) {
        if (isCurrent())
          showStartTab()
        return
      }
      const restoredDocuments = await restoreTreeAndTabs(session, isCurrent)
      if (restoredDocuments === undefined) return
      let restoredModuleTabs = await restoreHexTabs(moduleTabs.filter((tab) => tab.component === 'hex'))
      for (const tab of moduleTabs) {
        const target = useAppStore.getState().modules.find((module) => module.path === tab.path)
        const root = target ? useAppStore.getState().roots.find((candidate) => candidate.id === target.id) : undefined
        if (root && tab.component === 'module-info') {
          addSpecialTab(tab.component, root)
          restoredModuleTabs++
        }
      }
      if (restoredDocuments === 0 && restoredModuleTabs === 0)
        showStartTab()
      forceLayoutUpdate((value) => value + 1)
    } finally {
      if (isCurrent())
        setRestoringSession(false)
    }
  }

  /**
   * dnSpy's AppCommandLineArgsHandler, once the files a command line named are open: the member `--select` names
   * in them is followed — opened in a tab and selected — and, failing that, the first assembly of those files, or
   * else the first of them the tree holds at all.
   */
  const followCommandLine = async (paths: string[], member: string | undefined): Promise<void> => {
    const { workspaceId: currentWorkspace } = useAppStore.getState()
    if (!currentWorkspace)
      return
    if (member) {
      try {
        const { nodeId } = await window.dnSpy.selectMember(currentWorkspace, paths, member)
        if (nodeId) {
          await shellCallbacksRef.current.openBookmarkTarget(nodeId)
          return
        }
      } catch {
        // A member that cannot be looked up is the same as one that names nothing: the files are shown instead.
      }
    }
    const { roots, modules: openModules } = useAppStore.getState()
    const opened = paths.flatMap((path) => {
      const module = openModules.find((candidate) => candidate.path === path)
      const root = module ? roots.find((candidate) => candidate.id === module.id) : undefined
      return root ? [root] : []
    })
    const target = opened.find((root) => root.kind === 'assembly') ?? opened[0]
    if (target)
      await addDocumentTab(target)
  }

  /**
   * dnSpy's App.HandleAppArgs: what a command line asks of a window that is already up. It is used for the
   * line this process was started with and for one a second process handed over, which is why it is handed a
   * parsed command line rather than reading this one's. The order is dnSpy's: the language and the window
   * state first, then the new tab, then the files — whose member `--select` names can only be followed once
   * they are in the tree — and the tool windows and the search window last.
   */
  const applyCommandLine = async (commandLine: AppCommandLine): Promise<void> => {
    const theme = resolveThemeName(commandLine.theme)
    if (theme)
      setTheme(theme)
    const culture = resolveCultureArgument(commandLine.culture)
    if (culture)
      setLanguage(culture)
    const language = resolveDecompilerLanguage(commandLine.language)
    if (language)
      useAppStore.getState().setDefaultLanguage(language)
    if (commandLine.fullScreen !== undefined)
      await window.dnSpy.setFullScreen(commandLine.fullScreen)
    if (commandLine.newTab)
      openEmptyTab()
    // dnSpy's AppCommandLineArgsHandler: the windows to close first, then the ones to show, each of which
    // may name the edge it is to be docked at.
    for (const info of parseToolWindowInfos(commandLine.hideToolWindow)) {
      const id = toolWindowIdForGuid(info.guid)
      if (id && model.getNodeById(id))
        model.doAction(Actions.deleteTab(id))
    }
    for (const info of parseToolWindowInfos(commandLine.showToolWindow)) {
      const id = toolWindowIdForGuid(info.guid)
      if (id)
        showToolWindow(id, info.location)
    }
    if (commandLine.paths.length > 0) {
      await openPaths(commandLine.paths, { remember: true, select: false })
      await shellCallbacksRef.current.followCommandLine(commandLine.paths, commandLine.selectMember)
    }
    // dnSpy's search window: whichever of the three a command line gives is put in its box, and the window
    // is brought forward for any one of them. The query is searched for at once rather than after the typing
    // delay — nothing is going to type another letter.
    const searchType = resolveSearchType(commandLine.searchFor)
    const searchLocation = resolveSearchLocation(commandLine.searchIn)
    if (searchType || searchLocation || commandLine.searchText !== undefined) {
      const settings: { searchType?: SearchType; location?: SearchLocation; query?: string } = {}
      if (searchType) settings.searchType = searchType
      if (searchLocation) settings.location = searchLocation
      if (searchType || searchLocation)
        updateSearchSettings(settings)
      if (commandLine.searchText !== undefined)
        useSearchStore.getState().setQuery(commandLine.searchText)
      showSearch()
    }
    // The debugger's AppCommandLineArgsHandler: `-p` attaches to the process with that id, `-pn` to the first
    // attachable one of that name — Process.GetProcessesByName's name, with no extension, in any case.
    if (commandLine.debugAttachPid || commandLine.debugAttachProcess)
      void attachFromCommandLine(commandLine.debugAttachPid, commandLine.debugAttachProcess)
    forceLayoutUpdate((value) => value + 1)
  }

  const attachFromCommandLine = async (pid: number | undefined, processName: string | undefined): Promise<void> => {
    let processes: Awaited<ReturnType<typeof window.dnSpy.listDebugProcesses>>
    try {
      processes = await window.dnSpy.listDebugProcesses()
    } catch {
      return
    }
    const baseName = (value: string): string => (value.split(/[\\/]/).at(-1) ?? value).replace(/\.exe$/i, '').toLowerCase()
    const target = pid
      ? processes.find((process) => process.processId === pid)
      : processes.find((process) => baseName(process.name) === baseName(processName!) || (!!process.executablePath && baseName(process.executablePath) === baseName(processName!)))
    if (target)
      await useAppStore.getState().attachDebug(target.processId)
  }

  const openNodeId = async (nodeId: string): Promise<void> => {
    if (!workspaceId) return
    try {
      await addDocumentTab(await nodesOfDocument(workspaceId, nodeId))
    } catch (reason) {
      useAppStore.getState().appendOutput(t('Navigation failed: {message}', { message: reason instanceof Error ? reason.message : String(reason) }))
    }
  }

  // A bookmark restores to a node id that died with its workspace, so it opens by asking for one and
  // reports back whether that worked; the store falls back to looking the module and token up again.
  const openBookmarkTarget = async (nodeId: string): Promise<string | undefined> => {
    if (!workspaceId)
      return undefined
    try {
      // A bookmark set in a tab of several nodes names that tab's document.
      await addDocumentTab(await nodesOfDocument(workspaceId, nodeId))
      return nodeId
    } catch {
      return undefined
    }
  }

  // dnSpy's Follow Reference in New Tab, which the code viewer's "Open in New Tab" runs: the target gets
  // a tab of its own, so asking twice leaves the document showing in as many tabs as it was asked for.
  const openNodeInNewTab = async (nodeId: string): Promise<string | undefined> => {
    if (!workspaceId)
      return undefined
    try {
      await addDocumentTab(await nodesOfDocument(workspaceId, nodeId), true, undefined, true)
      return nodeId
    } catch (reason) {
      useAppStore.getState().appendOutput(t('Navigation failed: {message}', { message: reason instanceof Error ? reason.message : String(reason) }))
      return undefined
    }
  }

  // Debug navigation — a frame switch, Show Next Statement — brings a document that is already in the
  // store to the front without decompiling it again, which is what a step cannot afford. Only a node
  // with no tab at all pays for the lookup and the tab the bookmark path builds.
  const revealDocumentTarget = async (nodeId: string): Promise<void> => {
    const tab = tabShowing(nodeId)
    if (tab) {
      // Selecting the tab that is already selected would still count as a layout change, and a step
      // asks for this on every stop.
      if (!tab.isSelected()) {
        model.doAction(Actions.selectTab(tab.getId()))
        forceLayoutUpdate((value) => value + 1)
      }
      return
    }
    await shellCallbacksRef.current.openBookmarkTarget(nodeId)
  }

  /**
   * dnSpy's DisassemblyViewerService.Show: a tab of its own when the Disassembler option says so, otherwise the
   * Disassembly tab in front, which takes the new code — and a new tab when the one in front shows something else.
   */
  const openDisassemblyTab = (id: string): void => {
    const document = useAppStore.getState().disassemblyDocuments[id]
    if (!document) return
    const front = getTargetDocumentTabSet(model)?.getSelectedNode()
    if (!loadAppOptions().disassembler.newTab && front instanceof TabNode && front.getComponent() === 'disassembly-document') {
      model.doAction(Actions.updateNodeAttributes(front.getId(), { name: document.title, helpText: document.toolTip, config: { disassemblyId: id } }))
      model.doAction(Actions.selectTab(front.getId()))
    } else {
      const targetTabSet = getTargetDocumentTabSet(model)
      if (!targetTabSet) return
      model.doAction(Actions.addNode({
        type: 'tab',
        id: `disassembly:${id}`,
        name: document.title,
        helpText: document.toolTip,
        component: 'disassembly-document',
        config: { disassemblyId: id },
      }, targetTabSet.getId(), DockLocation.CENTER, -1, true))
      if (model.getNodeById('start')) model.doAction(Actions.deleteTab('start'))
    }
    forceLayoutUpdate((value) => value + 1)
  }

  // Debug > Windows > Disassembly and its Alt+8: the active frame's code (DisassemblyOperations.ShowDisassembly_CurrentFrame).
  const showActiveFrameDisassembly = (): void => {
    const { activeDebugFrameId: frameId, debugState: state } = useAppStore.getState()
    if (state === 'stopped' && frameId !== undefined)
      void useAppStore.getState().showDisassembly({ frameId })
  }

  // The code viewer's Go To Disassembly: the code of the method the statement under the caret is in.
  const showCaretDisassembly = (): void => {
    const state = useAppStore.getState()
    const caret = state.codeCaret
    const statement = caret ? codeStatementAt(state.documents[caret.documentId]?.codeStatements, caret.line, caret.column) : undefined
    if (statement)
      void state.showDisassembly({ modulePath: statement.modulePath, metadataToken: statement.metadataToken })
  }

  // The store cannot open tabs or tool windows itself, so it calls back into the shell. Handlers are
  // read through a ref because both close over the current workspace and layout.
  const shellCallbacksRef = useRef({ openBookmarkTarget, openNodeInNewTab, showToolWindow, restoreSession, revealDocumentTarget, followCommandLine, applyCommandLine, closeRequested, openDisassemblyTab, followNode })
  shellCallbacksRef.current = { openBookmarkTarget, openNodeInNewTab, showToolWindow, restoreSession, revealDocumentTarget, followCommandLine, applyCommandLine, closeRequested, openDisassemblyTab, followNode }

  // dnSpy's App.SwitchToOtherInstance, seen from the window that keeps the single instance lock: the second
  // process's command line arrives here the way this one's did, and is carried out on the window that is up.
  useEffect(() => {
    return window.dnSpy.onCommandLine((commandLine) => {
      void shellCallbacksRef.current.applyCommandLine(commandLine)
    })
  }, [])

  useEffect(() => {
    setOpenNodeById((nodeId) => shellCallbacksRef.current.openBookmarkTarget(nodeId))
    useAppStore.getState().setFollowNodeById((nodeId) => shellCallbacksRef.current.followNode(nodeId, false).then((opened) => opened?.documentId).catch(() => undefined))
    setOpenNodeInNewTabById((nodeId) => shellCallbacksRef.current.openNodeInNewTab(nodeId))
    setOpenToolWindow((tabId) => shellCallbacksRef.current.showToolWindow(tabId))
    setRevealDocument((nodeId) => shellCallbacksRef.current.revealDocumentTarget(nodeId))
    useAppStore.getState().setOpenDisassemblyTab((id) => shellCallbacksRef.current.openDisassemblyTab(id))
    useAppStore.getState().setOpenAttachDialog(() => setAttachDialogOpen(true))
    return () => {
      useAppStore.getState().setOpenDisassemblyTab(undefined)
      useAppStore.getState().setOpenAttachDialog(undefined)
      setOpenNodeById(undefined)
      useAppStore.getState().setFollowNodeById(undefined)
      setOpenNodeInNewTabById(undefined)
      setOpenToolWindow(undefined)
      setRevealDocument(undefined)
    }
  }, [setOpenNodeById, setOpenNodeInNewTabById, setOpenToolWindow, setRevealDocument])

  // dnSpy's DecompilerAppSettingsModifiedListener and BamlRefresher: once the options dialog saved, the tabs whose
  // decompiler reads a page that changed are decompiled again.
  useEffect(() => {
    let previous = loadAppOptions()
    const optionsChanged = (): void => {
      const before = previous
      previous = loadAppOptions()
      void useAppStore.getState().refreshDocumentsForOptions(before, previous, orderedDocumentKeys(model).order)
    }
    window.addEventListener(APP_OPTIONS_CHANGED_EVENT, optionsChanged)
    return () => window.removeEventListener(APP_OPTIONS_CHANGED_EVENT, optionsChanged)
  }, [model])

  // dnSpy selects a document's nodes in the explorer whenever its tab comes to the front, and that is
  // what follows a reference the user clicked, a bookmark, a search result or a step: each of them just
  // makes its document the current one, so the rule lives here rather than in every one of them. The tree
  // is left alone while the pane is not on screen, and while the previous session is still coming back —
  // the selection that restore puts back is the one to keep.
  useEffect(() => {
    if (!activeDocumentId)
      return
    if (useAppStore.getState().restoringSession)
      return
    const explorer = model.getNodeById('explorer')
    if (!(explorer instanceof TabNode) || !explorer.isSelected())
      return
    const nodeIds = nodeIdsOfDocument(activeDocumentId)
    if (nodeIds.length === 1) {
      void useAppStore.getState().revealNode(activeDocumentId)
      return
    }
    // A tab of several nodes selects all of them (OnNewTabContentShownDelay), unless they are the selection already.
    const selected = new Set(useAppStore.getState().selectedNodes.map((node) => node.id))
    if (nodeIds.every((nodeId) => selected.has(nodeId)))
      return
    void (async () => {
      for (const nodeId of nodeIds)
        await useAppStore.getState().revealNode(nodeId)
      const state = useAppStore.getState()
      const nodes = nodeIds.flatMap((nodeId) => findNode(state, nodeId) ?? [])
      if (nodes.length > 0)
        state.selectNodes(nodes, nodes[0])
    })()
  }, [activeDocumentId, model])

  // The one place the previous session comes back. It runs once the backend can answer, and puts the
  // assemblies, the branches, the tabs and the selection back before anything else looks at the state.
  // Files named on the command line are opened afterwards, which — because Open appends — grows the
  // restored tree exactly the way the same command behaves in a running window.
  useEffect(() => {
    if (backendStatus.state !== 'ready' || startupHandled.current)
      return
    startupHandled.current = true
    void (async () => {
      const startupOptions = await window.dnSpy.getStartupOptions()
      // dnSpy's RestoreTabs option: with it off the window starts clean however the last run ended, which is
      // a different thing from `--no-load-files` — that one leaves the saved session alone for the next run.
      const restoringTabs = loadAppOptions().environmentGeneral.restoreTabs
      const session = startupOptions.commandLine.noLoadFiles || !restoringTabs ? undefined : loadSession()
      if (session && session.paths.length > 0) {
        await shellCallbacksRef.current.restoreSession(session)
      } else {
        // Nothing comes back: the tabs the saved layout still holds name documents from a run that is
        // over, so the window starts on a clean page rather than on tabs that lead nowhere.
        closeDocumentTabs()
        showStartTab()
        forceLayoutUpdate((value) => value + 1)
      }
      enableSessionPersistence()
      // dnSpy's command line: the theme, the language and the window state it names, the files it lists —
      // which go on the Recent Files list, with the member `--select` names shown of them — and the tool
      // windows and search window it asks for.
      await shellCallbacksRef.current.applyCommandLine(startupOptions.commandLine)
      // dnSpy's ShowElapsedTime: what the app took to load, in a box, since `--show-startup-time` asks for it.
      // Its ticks are a Stopwatch's — ten million to the second — so the milliseconds are what they count off.
      if (startupOptions.commandLine.showStartupTime) {
        const elapsed = Date.now() - startupOptions.processStartTime
        await window.dnSpy.showMessage(`${elapsed} ms, ${elapsed * 10_000} ticks`)
      }
    })()
  }, [backendStatus.state, openPaths])

  const goBack = (): Promise<void> => stepHistory(true)
  const goForward = (): Promise<void> => stepHistory(false)
  // The Back and Forward buttons follow the tab in front.
  const frontHistory = useMemo(() => {
    const tab = frontDocumentTab()
    const history = tab ? tabHistories.current.get(tab.getId()) : undefined
    return { canGoBack: (history?.back.length ?? 0) > 0, canGoForward: (history?.forward.length ?? 0) > 0 }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyVersion, layoutVersion, model])

  // dnSpy shows its analyzer before it adds the member, so the row lands in a window that is already there.
  const openAnalysis = async (node: TreeNode): Promise<void> => {
    showToolWindow('analysis')
    await useAnalyzerStore.getState().analyze(node.id)
  }

  // Analyze over a selection adds a root per member, in the order they were selected.
  const openAnalyses = async (nodes: TreeNode[]): Promise<void> => {
    for (const node of nodes)
      await openAnalysis(node)
  }

  // dnSpy resolves the member a reference names only when Analyze runs, which for a member of a module the
  // workspace does not hold means opening that module first — the way following the reference would.
  const analyzeReference = async (target: TextSpan): Promise<void> => {
    if (!workspaceId) return
    try {
      const nodeId = await useAppStore.getState().resolveReferenceTarget(target)
      if (nodeId)
        await openAnalysis(await window.dnSpy.getNode(workspaceId, nodeId))
    } catch (reason) {
      appendOutput(t('Analysis failed: {message}', { message: reason instanceof Error ? reason.message : String(reason) }))
    }
  }

  // A module node and the module a hex command names are the same node id, but a command only has the
  // id, so the tab builder takes the two fields it needs rather than the whole tree node.
  // dnSpy's Save saves the active tab's document: a hex tab's is its file, saved the way a hex buffer is — under
  // a file name and nothing else. Any other tab falls to the selected module.
  const saveActiveDocument = (): Promise<boolean> => {
    const tab = model.getActiveTabset()?.getSelectedNode()
    if (tab instanceof TabNode && tab.getComponent() === 'hex') {
      const moduleId = (tab.getConfig() as { moduleId?: string } | undefined)?.moduleId
      if (moduleId)
        return useAppStore.getState().requestSave([moduleId])
    }
    return saveModule()
  }

  /** A module's information tab: one per module, brought forward when it is open already. */
  const addSpecialTab = (component: 'module-info', module: { id: string; label: string }): void => {
    const tabId = `${component}:${module.id}`
    if (model.getNodeById(tabId)) {
      model.doAction(Actions.selectTab(tabId))
    } else {
      const targetTabSet = getTargetDocumentTabSet(model)
      if (!targetTabSet) return
      model.doAction(Actions.addNode({
        type: 'tab',
        id: tabId,
        name: `${module.label} [${t('Info')}]`,
        component,
        config: { moduleId: module.id },
      }, targetTabSet.getId(), DockLocation.CENTER, -1, true))
      if (model.getNodeById('start')) model.doAction(Actions.deleteTab('start'))
    }
    forceLayoutUpdate((value) => value + 1)
  }

  /**
   * The file a hex view shows, named the way HexViewDocumentTabContent names it: the tab after the file, the tooltip
   * its path. The hex commands name a file by its document root's id, or — for a net module, whose file is its own —
   * by the net module's row, which may not be in the tree yet and is then asked for.
   */
  const hexFileOf = async (moduleId: string): Promise<{ name: string; path?: string } | undefined> => {
    if (moduleId.startsWith(HEX_FILE_PREFIX)) {
      const path = moduleId.slice(HEX_FILE_PREFIX.length)
      return { name: path.split(/[\\/]/).pop() || path, path }
    }
    const state = useAppStore.getState()
    const root = state.roots.find((candidate) => candidate.id === moduleId)
    if (root) {
      const path = state.modules.find((candidate) => candidate.id === moduleId)?.path
      return { name: path?.split(/[\\/]/).pop() || root.label, path }
    }
    let row = findNode(state, moduleId)
    if (!row && state.workspaceId) {
      try {
        row = await window.dnSpy.getNode(state.workspaceId, moduleId)
      } catch {
        return undefined
      }
    }
    if (row?.kind !== 'module')
      return undefined
    const path = row.key?.startsWith('module:') ? row.key.slice('module:'.length) : row.description
    return { name: path?.split(/[\\/]/).pop() || row.label, path }
  }

  /**
   * dnSpy's FollowReference(AddressReference) with no new tab (DocumentTabService.FollowReference and
   * HexAddressReferenceFileTabContentProvider): the file's hex view takes the place of what the tab in front shows,
   * which goes on that tab's history so Back returns to it. With no tab in front — or with `newTab` — the view gets
   * a tab of its own. A tab already showing the file keeps showing it: only where its view is changes. `range` is
   * the bytes the view selects, with the caret on the first (HexAddressReferenceFileTabContentCreator's
   * InitializeHexView); `state` is the view state a step of the history left it in. Answers with the tab the view
   * is in.
   */
  const showHexContent = async (
    moduleId: string,
    options: { intoTab?: TabNode; newTab?: boolean; recordHistory?: boolean; range?: HexRange; state?: HexViewUiState; select?: boolean; index?: number } = {},
  ): Promise<string | undefined> => {
    const file = await hexFileOf(moduleId)
    if (!file)
      return undefined
    if (options.range)
      showHexAt(moduleId, options.range.offset, options.range.length)
    if (options.state)
      useAppStore.getState().setHexTabState(moduleId, options.state)
    const front = options.intoTab ?? (options.newTab ? undefined : frontDocumentTab())
    const target = front && front.getComponent() !== 'start' && model.getNodeById(front.getId()) ? front : undefined
    let tabId: string
    if (target) {
      tabId = target.getId()
      const showsIt = target.getComponent() === 'hex' && (target.getConfig() as { moduleId?: string } | undefined)?.moduleId === moduleId
      if (!showsIt) {
        if (options.recordHistory !== false)
          recordTabHistory(target)
        // A tab that moves on from a document calls off what it was still decompiling — unless another tab shows
        // that document too.
        const shown = documentIdOfTab(target)
        if (shown && useAppStore.getState().documents[shown]?.loading && !getDocumentTabs(model).some((tab) => tab !== target && documentIdOfTab(tab) === shown))
          useAppStore.getState().cancelDocument(shown)
        model.doAction(Actions.updateNodeAttributes(tabId, { name: file.name, helpText: file.path, component: 'hex', config: { moduleId } }))
      }
      if (!target.isSelected())
        model.doAction(Actions.selectTab(tabId))
    } else {
      const targetTabSet = (front?.getParent() instanceof TabSetNode ? front.getParent() as TabSetNode : undefined) ?? getTargetDocumentTabSet(model)
      if (!targetTabSet)
        return undefined
      tabId = newDocumentTabId()
      model.doAction(Actions.addNode({
        type: 'tab',
        id: tabId,
        name: file.name,
        helpText: file.path,
        component: 'hex',
        config: { moduleId },
      }, targetTabSet.getId(), DockLocation.CENTER, options.index === undefined ? -1 : Math.min(options.index, targetTabSet.getChildren().length), options.select !== false || targetTabSet.getChildren().length === 0))
      if (front?.getComponent() === 'start' && front.isCloseable() && model.getNodeById(front.getId()))
        model.doAction(Actions.deleteTab(front.getId()))
      if (model.getNodeById('start'))
        model.doAction(Actions.deleteTab('start'))
    }
    forceLayoutUpdate((value) => value + 1)
    return tabId
  }

  /**
   * Opens a file's hex view on a range, which it selects with the caret on its first byte — what every "Show ... in
   * Hex Editor" command, an address reference and the metadata table's Show in Hex Editor do.
   */
  const showHexRange = (moduleId: string, offset: number, length: number): void => {
    void showHexContent(moduleId, { range: { offset, length } })
  }

  /**
   * dnSpy's HexAddressReferenceFileTabContentCreator: following an RVA or a file offset a token comment writes opens
   * the hex editor of the file it names on it — an RVA turned into the file offset its section puts it at. A file
   * the workspace does not hold, or an RVA no section holds, goes nowhere.
   */
  const followAddress = async (address: AddressReference): Promise<void> => {
    const state = useAppStore.getState()
    const normalize = (path: string): string => path.replaceAll('\\', '/').toLowerCase()
    const module = address.modulePath ? state.modules.find((candidate) => normalize(candidate.path) === normalize(address.modulePath!)) : undefined
    if (!module || !state.workspaceId)
      return
    let offset = address.address
    if (address.isRva) {
      try {
        offset = (await window.dnSpy.resolveHexPosition(state.workspaceId, module.id, 'rva', address.address)).offset
      }
      catch (error) {
        appendOutput(t('Navigation failed: {message}', { message: error instanceof Error ? error.message : String(error) }))
        return
      }
    }
    if (offset >= 0)
      showHexRange(module.id, offset, address.length)
  }

  /** The node whose module Go to MD Table Row looks in: the open code document's, else the selection's. */
  const mdTableRowTarget = (): TreeNode | undefined => {
    const state = useAppStore.getState()
    const documentNodeId = activeDocument === 'code' && state.activeDocumentId ? state.documents[state.activeDocumentId]?.nodeId : undefined
    const node = (documentNodeId ? findNode(state, documentNodeId) : undefined) ?? state.selectedNode
    return node && hasMetadataTables(state, node.id) ? node : undefined
  }

  /** dnSpy's two Go to MD Table Row commands: the window that asks for a token, or the row of the one given. */
  const goToMdTableRow = (node: TreeNode, token?: number): void => {
    if (token === undefined) {
      setMdRowNode(node)
      return
    }
    void useAppStore.getState().goToMetadataRecord(node, token).then((error) => {
      if (error)
        appendOutput(error)
    })
  }

  /**
   * dnSpy's OpenHexEditorCommand.ExecuteInternal: the file opens at its start with nothing selected — unless the tab
   * in front is a hex view already, which the command leaves as it is.
   */
  const openHex = (moduleId: string): void => {
    if (frontDocumentTab()?.getComponent() === 'hex')
      return
    showHexRange(moduleId, 0, 0)
  }

  /**
   * The hex group's context for the Edit menu — dnSpy's HexMenuCommand.CreateContext: the code viewer in front when
   * it had the focus last, the tree when that had it, and when neither did, the viewer as long as the tree has a
   * selection; otherwise nothing. A metadata table document is no viewer.
   */
  const editMenuHexContext = (): HexContextParts => {
    const state = useAppStore.getState()
    const front = frontDocumentTab()
    const documentId = documentIdOfTab(front)
    const nodeId = documentId ? state.documents[documentId]?.nodeId : undefined
    const viewer = documentId && !(nodeId && findNode(state, nodeId)?.kind === 'metadatatable') ? documentId : undefined
    if (hexFocus === 'code' && viewer)
      return codeHexContextOf(state, viewer)
    if (hexFocus === 'tree') {
      const selection = topLevelSelection(state.selectedNodes, state.parents)
      return treeHexContext(selection, state.hexTargetNodeId === selection[0]?.id ? state.hexTarget : undefined)
    }
    if (state.selectedNodes.length > 0 && viewer)
      return codeHexContextOf(state, viewer)
    return {}
  }

  const closeCurrentWorkspace = (): void => {
    if (!dirty || window.confirm(t('Discard unsaved changes and close the workspace?')))
      void closeWorkspace()
  }

  /**
   * dnSpy's Remove Assembly, which its two File menu sweeps run as well: the documents go, the tabs still
   * showing anything inside them close, and unsaved edits in them are asked about first — dnSpy's
   * AskUserToSaveIfModified, which saves them when told to and calls the removal off when a save fails.
   */
  const removeDocuments = async (nodeIds: string[], remove: () => Promise<string[]>): Promise<void> => {
    if (nodeIds.length === 0)
      return
    const modified = await getModifiedModules(nodeIds)
    if (modified.length > 0) {
      const answer = await window.dnSpy.askSaveModified(modified.length)
      if (answer === 'cancel')
        return
      if (answer === 'save' && !await useAppStore.getState().saveModules(modified))
        return
    }
    for (const nodeId of await remove())
      closeTabsFor(nodeId)
  }

  const closeAllFrameworkAssemblies = async (): Promise<void> => {
    const { frameworkNodeIds } = await getCloseCandidates()
    await removeDocuments(frameworkNodeIds, () => removeModules(frameworkNodeIds))
  }

  // dnSpy's CloseOldInMemoryModulesCommand: the modules read out of a process that is no longer debugged
  // (IInMemoryDocument.IsActive is false), removed the way Remove Assembly removes them.
  const closeOldInMemoryModules = async (): Promise<void> => {
    const ids = oldInMemoryModuleIds
    if (ids.length > 0)
      await removeDocuments(ids, () => removeModules(ids))
  }

  const closeAllMissingFiles = async (): Promise<void> => {
    const { missingNodeIds } = await getCloseCandidates()
    await removeDocuments(missingNodeIds, () => removeModules(missingNodeIds))
  }

  // dnSpy's Open List keeps the open files in the selected list, so they are written into it before the
  // dialog reads the lists — DocumentListLoader.SaveCurrentDocumentsToList.
  const showOpenList = (): void => {
    rememberCurrentDocuments(modules.filter((module) => !module.inMemory).map((module) => module.path))
    setOpenListDialogOpen(true)
  }

  /**
   * OK in Open List: the lists are saved as the dialog left them, and a list other than the one the open
   * files belong to replaces them — DocumentListLoader.Load, which closes what is open and opens the list.
   * Unsaved edits are asked about first, the way the close does.
   */
  const openDocumentList = async (stored: StoredDocumentLists, chosen: DocumentList | undefined): Promise<void> => {
    const previous = loadDocumentLists().selected
    if (chosen && chosen.name !== previous && dirty && !window.confirm(t('Discard unsaved changes and close the workspace?')))
      return
    saveDocumentLists(stored)
    if (!chosen || chosen.name === previous)
      return
    await closeWorkspace()
    const paths = await window.dnSpy.filterExistingPaths(chosen.files)
    if (paths.length > 0)
      await openPaths(paths)
  }

  // dnSpy's restart goes through the ordinary close, so unsaved edits still get their say first;
  // the confirm stands in for that prompt and a "no" leaves the app, and the edits, alone.
  const restartAsAdministrator = (): void => {
    if (!dirty || window.confirm(t('Discard unsaved changes and restart with elevated rights?')))
      void window.dnSpy.restartAsAdministrator()
  }

  /**
   * The commands the assembly explorer's rows run. A command that opens a dialog, a tool window or a tab
   * belongs to the shell rather than to the tree, so the tree is handed the callbacks instead of reaching
   * for the layout model. The object is rebuilt every render — each callback closes over the shell's
   * current handlers — and the tree reads it through a ref, which is what keeps its memoized rows stable.
   * The commands this port has no plumbing for yet are simply left out: their menu entries show up the
   * moment one is supplied.
   */
  /**
   * The C# compiler commands open dnSpy's Edit Code window. The source decompiled into it is the
   * outermost type's — a nested type or a member's method is edited inside the type that declares it,
   * which is the unit the importer merges back.
   */
  const openCodeDialog = (node: TreeNode, mode: CompilerMode): void => {
    let sourceNodeId: string | undefined
    if (mode === 'editMethod' || mode === 'editClass' || mode === 'addMembers') {
      const state = useAppStore.getState()
      let typeNode = node.kind === 'type' ? node : findNode(state, state.parents[node.id] ?? '')
      while (typeNode?.kind === 'type') {
        sourceNodeId = typeNode.id
        const parent = findNode(state, state.parents[typeNode.id] ?? '')
        if (parent?.kind !== 'type')
          break
        typeNode = parent
      }
      if (!sourceNodeId)
        return
    }
    setCodeDialog({ node, mode, sourceNodeId })
  }

  // The tree's selection, shown in the tab in front — dnSpy's DocumentTabService.ShowNodes. A key held down walks
  // the rows faster than they decompile, so the row the selection settles on is the one shown.
  const showSelectionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const showSelectedNode = (node: TreeNode): void => showSelectedNodes([node])
  // DocumentTabService.DocumentTreeView_SelectionChanged: the whole top-level selection is shown, as one document.
  const showSelectedNodes = (nodes: TreeNode[]): void => {
    clearTimeout(showSelectionTimer.current)
    const wanted = documentIdOf(nodes.map((node) => node.id))
    showSelectionTimer.current = setTimeout(() => {
      const state = useAppStore.getState()
      const selected = topLevelSelection(state.selectedNodes, state.parents)
      if (selected.length > 0 && documentIdOf(selected.map((node) => node.id)) === wanted)
        void addDocumentTab(selected)
    }, 30)
  }

  /** The hex group's commands, which the Edit menu, the tree's menu and the code viewer's run alike. */
  const hexCommands = {
    onOpenHex: openHex,
    onShowHex: (moduleId: string, range: HexRange) => showHexRange(moduleId, range.offset, range.length),
    onHexWriteBody: (kind: HexBodyKind, target: HexBodyTarget) => { void hexWriteMethodBody(kind, target) },
    onHexCopyBody: (target: HexBodyTarget) => { void hexCopyMethodBody(target) },
    onHexPasteBody: (target: HexBodyTarget) => { void hexPasteMethodBody(target) },
  }

  const explorerCommands: AssemblyExplorerCommands = {
    // dnSpy's NodeActivated: the node is in the tab in front already — the selection put it there — and the
    // focus goes to it.
    onOpenNode: (node) => { void addDocumentTab(node).then((tabId) => { if (tabId) focusDocumentEditor(tabId) }) },
    onShowNode: (node) => showSelectedNode(node),
    onShowNodes: (nodes) => showSelectedNodes(nodes),
    onOpenInNewTab: (node) => { void openNodeInNewTab(node.id) },
    onDeleteNode: (node) => deleteSelected(node),
    onEditNode: (node) => openEditNode(node),
    onCreateMember: (kind, nested, node) => createMember(kind, nested, node),
    onEditMethodBody: (node) => { if (node.kind === 'method') setEditMethodBody({ node }) },
    onReplaceMethodBodyWithStub: (node) => { if (node.kind === 'method') void replaceMethodBodyWithStub(node) },
    onEditResource: (node) => editResource(node),
    onEditAssembly: (node) => setAssemblyModuleDialog({ mode: 'assembly', node }),
    onEditModule: (node) => setAssemblyModuleDialog({ mode: 'module', node }),
    onMergeAssembly: (node) => { void mergeAssembly(node) },
    onEditMethodCode: (node) => openCodeDialog(node, 'editMethod'),
    onEditClassCode: (node) => openCodeDialog(node, 'editClass'),
    onAddClassMembersCode: (node) => openCodeDialog(node, 'addMembers'),
    onAddClassCode: (node) => openCodeDialog(node, 'addClass'),
    onEditAssemblyAttributesCode: (node) => openCodeDialog(node, 'editAssembly'),
    onCreateResource: (kind, node) => createResource(kind, node),
    onCreateResourceElement: (node) => createResourceElement(node),
    onCreateImageResources: (node) => createImageResources(node),
    onCreateImageList: (node) => createImageList(node),
    onSaveResource: (nodes, raw, useSubDirs) => { void saveResource(nodes, raw, useSubDirs) },
    onLoadDependencies: (node, recursive) => { void loadDependencies(node, recursive) },
    onConvertModule: (node, toAssembly) => { void convertModule(node, toAssembly) },
    onCreateAssembly: () => void createAssemblyCommand(),
    onCreateNetModule: () => setNetModuleDialog({}),
    onAddNewNetModule: (node) => setNetModuleDialog({ assemblyNode: node }),
    onAddExistingNetModule: (node) => void addExistingNetModule(node),
    onRemoveNetModule: (node) => void removeNetModuleCommand(node),
    onRenameNamespace: (node) => setRenameNamespaceNode(node),
    onMoveTypesToEmptyNamespace: (node) => { void moveTypesToEmptyNamespace(node) },
    onSortAssemblies: () => { void sortAssemblies() },
    // The documents' tabs go with them, so they are closed rather than left on nodes the backend dropped.
    onRemoveAssembly: (nodes) => { void removeDocuments(nodes.map((node) => node.id), () => removeModules(nodes.map((node) => node.id))) },
    onGoToResource: (node) => { void goToResource(node) },
    onOpenContainingFolder: (node) => { if (node.description) void window.dnSpy.showItemInFolder(node.description) },
    onGoToEntryPoint: (node) => { void goToSpecialNode(node, 'entryPoint') },
    onGoToGlobalCctor: (node) => { void goToSpecialNode(node, 'globalCctor') },
    onGoToToken: (node) => { setTokenNode(node) },
    onGoToMdTableRow: (node, token) => goToMdTableRow(node, token),
    onAddMethodBreakpoints: (targets) => { void addMethodBreakpoints(targets) },
    onAddClassBreakpoint: (node) => { void addClassBreakpoint(node) },
    onAddClassTracepoint: (node) => setClassTracepointNode(node),
    onAnalyze: (nodes) => { void openAnalyses(nodes) },
    onFindStringReferences: (nodes) => findStringReferences(nodes),
    onOpenUrl: (url) => { window.open(url, '_blank', 'noopener,noreferrer') },
    copyText: (text) => {
      void navigator.clipboard.writeText(text).catch((error: unknown) => {
        appendOutput(t('Copy failed: {message}', { message: error instanceof Error ? error.message : String(error) }))
      })
    },
    onShowModuleInfo: (node) => addSpecialTab('module-info', node),
    ...hexCommands,
  }

  /**
   * The commands a code viewer's context menu cannot run itself. It draws the menu — dnSpy's grouping,
   * with the node the caret is on — but opening a tab, a dialog or a tool window belongs to the shell, so
   * the viewer is handed the callbacks instead of reaching for the layout model. The node each command
   * acts on is the one the menu picked, never the explorer's selection: the two are usually different.
   */
  /**
   * dnSpy's "Edit IL Instructions": the statement under the caret names the method by its token, and the
   * body editor opens on it with the instructions the statement covers selected. The node may not have
   * been listed yet — a body's method need not be expanded in the tree — so the backend is asked for it
   * and the roots are read again before the dialog is handed the node.
   */
  const editIlInstructions = async (statement: { modulePath: string; metadataToken: number; ilOffset: number; ilEndOffset: number }): Promise<void> => {
    const workspaceId = useAppStore.getState().workspaceId
    if (!workspaceId)
      return
    try {
      const found = await window.dnSpy.findMember(workspaceId, statement.modulePath, statement.metadataToken)
      if (!found.nodeId)
        return
      await useAppStore.getState().refreshRoots()
      const node = findNode(useAppStore.getState(), found.nodeId)
      if (node?.kind === 'method')
        setEditMethodBody({ node, selection: { start: statement.ilOffset, end: statement.ilEndOffset } })
    }
    catch (error) {
      appendOutput(t('Navigation failed: {message}', { message: error instanceof Error ? error.message : String(error) }))
    }
  }

  const documentViewCommands = (viewId: string): DocumentViewCommands => ({
    // dnSpy's document viewer follows a reference into its own tab, or — Ctrl, Ctrl+F12, "Open in New Tab" —
    // into a tab of its own.
    onFollowReference: (target, newTab) => { void followReference(target, newTab, viewId) },
    onFollowAddress: (address) => { void followAddress(address) },
    onRecordHistory: () => recordViewHistory(viewId),
    onGoToEntryPoint: (node) => { void goToSpecialNode(node, 'entryPoint') },
    onGoToGlobalCctor: (node) => { void goToSpecialNode(node, 'globalCctor') },
    onGoToToken: (node) => setTokenNode(node),
    onGoToMdTableRow: (node, token) => goToMdTableRow(node, token),
    onStartDebug: () => setDebugProgramDialogOpen(true),
    canStartDebug: backendStatus.capabilities?.['debug.coreclr.launch'] === true,
    onShowDisassembly: () => showCaretDisassembly(),
    onDeleteNode: (node) => deleteSelected(node),
    onEditNode: (node) => openEditNode(node),
    onCreateMember: (kind, nested, node) => createMember(kind, nested, node),
    onEditMethodBody: (node) => { if (node.kind === 'method') setEditMethodBody({ node }) },
    onEditIlInstructions: (statement) => { void editIlInstructions(statement) },
    onReplaceMethodBodyWithStub: (node) => { if (node.kind === 'method') void replaceMethodBodyWithStub(node) },
    onAnalyze: (node) => void openAnalysis(node),
    onAddClassBreakpoint: (node) => { void addClassBreakpoint(node) },
    onAddClassTracepoint: (node) => setClassTracepointNode(node),
    onAnalyzeReference: (target) => void analyzeReference(target),
    onOpenUrl: (url) => { window.open(url, '_blank', 'noopener,noreferrer') },
    onGoToResource: (node) => { void goToResource(node) },
    ...hexCommands,
  })

  /** The tree nodes the analyzer's and the search window's commands name by id; one that cannot be read is
   * reported and left out. */
  const readNodes = async (nodeIds: string[]): Promise<TreeNode[]> => {
    if (!workspaceId)
      return []
    const nodes: TreeNode[] = []
    for (const nodeId of nodeIds) {
      try {
        nodes.push(await window.dnSpy.getNode(workspaceId, nodeId))
      } catch (reason) {
        appendOutput(t('Navigation failed: {message}', { message: reason instanceof Error ? reason.message : String(reason) }))
      }
    }
    return nodes
  }

  // The analyzer goes to a row's member, or to the method it was found in, through the same tabs the tree
  // opens documents in; the caret it then places needs the tab the document landed in.
  const analyzerCommands: AnalyzerPaneCommands = {
    // dnSpy follows a row's member the way it follows any reference: DecompileFullType and a state machine's
    // MoveNext decide what the tab shows, and the caret goes to the member.
    openNode: async (nodeId, newTab) => {
      if (!workspaceId)
        return undefined
      try {
        return await followNode(nodeId, newTab)
      } catch (reason) {
        appendOutput(t('Navigation failed: {message}', { message: reason instanceof Error ? reason.message : String(reason) }))
        return undefined
      }
    },
    copyText: (text) => explorerCommands.copyText?.(text),
    openUrl: (url) => { window.open(url, '_blank', 'noopener,noreferrer') },
    addClassBreakpoint: (nodeId) => { void readNodes([nodeId]).then(([node]) => node && addClassBreakpoint(node)) },
    addClassTracepoint: (nodeId) => { void readNodes([nodeId]).then(([node]) => node && setClassTracepointNode(node)) },
    addMethodBreakpoints: (nodeIds) => { void readNodes(nodeIds).then((nodes) => addMethodBreakpoints(nodes)) },
  }

  // A search result names its node by id; the commands that act on more than following it read the node.
  // Following one opens it the way the analyzer opens a row, since a match in a body places the caret after.
  const searchCommands: SearchPaneCommands = {
    openNode: analyzerCommands.openNode,
    getNode: async (nodeId) => (await readNodes([nodeId]))[0],
    analyze: (node) => { void openAnalysis(node) },
    copyText: (text) => explorerCommands.copyText?.(text),
    openUrl: (url) => { window.open(url, '_blank', 'noopener,noreferrer') },
    addClassBreakpoint: (node) => { void addClassBreakpoint(node) },
    addClassTracepoint: (node) => setClassTracepointNode(node),
    addMethodBreakpoints: (nodes) => { void addMethodBreakpoints(nodes) },
  }

  const stringReferencesCommands: StringReferencesPaneCommands = {
    openNode: analyzerCommands.openNode,
    copyText: (text) => explorerCommands.copyText?.(text),
  }

  // A zoomed element is laid out at its own size and drawn scaled, so it is made as much smaller as it is scaled
  // up — which leaves it filling the tab at any zoom.
  const tabZoomStyle: React.CSSProperties = { zoom: documentZoom / 100, width: `${10000 / documentZoom}%`, height: `${10000 / documentZoom}%` }

  /** What a tab's component draws, before the caption a docked pane wears is put round it. */
  const paneContent = (node: TabNode): React.ReactNode => {
    switch (node.getComponent()) {
      case 'explorer': return <AssemblyExplorer commands={explorerCommands} />
      // A tab shows one document after another, and each gets a view of its own: the key makes the switch a
      // new view rather than the old one reloading in place.
      case 'document': {
        const documentId = (node.getConfig() as { documentId: string }).documentId
        return (
          <DocumentPane
            documentId={documentId}
            zoomStyle={tabZoomStyle}
            onShowHex={showHexRange}
            renderCode={() => <Suspense fallback={<div className="loading-state">{t('Loading')}</div>}><DocumentView key={documentId} documentId={documentId} viewId={node.getId()} theme={theme} transparentBackground={backgroundImageOn} commands={documentViewCommands(node.getId())} /></Suspense>}
          />
        )
      }
      case 'output': return <OutputPane />
      case 'csharp-interactive': return <CSharpInteractive theme={theme} transparentBackground={backgroundImageOn} />
      case 'search': return <SearchPane commands={searchCommands} />
      case 'analysis': return <AnalyzerPane commands={analyzerCommands} />
      case 'string-references': return <StringReferencesPane commands={stringReferencesCommands} />
      // dnSpy's TabElementZoomer: a tab that is not a text view is scaled as a whole.
      case 'hex': {
        // The hex view zooms with its own option (dnSpy's ZoomLevel of the hex group), not the tab's.
        const moduleId = (node.getConfig() as { moduleId: string }).moduleId
        return <HexView key={moduleId} moduleId={moduleId} initialState={useAppStore.getState().hexTabs.find((tab) => tab.moduleId === moduleId)?.state} commands={{ onStateChange: (state) => useAppStore.getState().setHexTabState(moduleId, state) }} />
      }
      case 'module-info': return <div className="tab-zoom" style={tabZoomStyle}><ModuleInfoView moduleId={(node.getConfig() as { moduleId: string }).moduleId} /></div>
      case 'locals': return <LocalsPane />
      case 'exception-settings': return <ExceptionSettingsPane />
      case 'watch': return <WatchPane window={node.getId().startsWith('watch-') ? Number(node.getId().slice('watch-'.length)) : 1} />
      case 'callstack': return <CallStackPane />
      case 'breakpoints': return <BreakpointsPane />
      case 'bookmarks': return <BookmarksPane />
      case 'threads': return <ThreadsPane />
      case 'modules': return <ModulesPane />
      // These debugger windows do not have a backend model yet, but they still need to behave like
      // real dockable windows: opening them from Debug > Window adds a closable pane and preserves
      // the layout. The placeholder keeps the command useful until the corresponding data providers
      // are implemented.
      case 'module-breakpoints': return <ModuleBreakpointsPane />
      case 'autos': return <AutosPane />
      case 'static-fields': return <StaticFieldsPane />
      case 'processes': return <ProcessesPane />
      case 'memory': return <MemoryPane />
      case 'disassembly-document': return <div className="tab-zoom" style={tabZoomStyle}><DisassemblyDocumentView id={(node.getConfig() as { disassemblyId: string }).disassemblyId} theme={theme} transparentBackground={backgroundImageOn} /></div>
      case 'start': return (
        <div className="start-view">
          <button className="command-button" disabled={backendStatus.state !== 'ready'} onClick={() => void chooseAndOpen()}>
            {/* The command the toolbar's first button runs, with that button's image (DsImages.OpenFolder). */}
            <DsIcon name="OpenFolder" /> {t('Open Assembly')}
          </button>
        </div>
      )
      default: return null
    }
  }

  const factory = (node: TabNode): React.ReactNode => {
    const content = paneContent(node)
    if (content === null || DOCUMENT_COMPONENTS.includes(node.getComponent() ?? ''))
      return content
    return <DockPane tab={node}>{content}</DockPane>
  }

  return (
    <div className="app-shell">
      <MenuBar
        hasWorkspace={Boolean(workspaceId)}
        hasModule={modules.length > 0}
        selectionKind={selectedNode?.kind}
        selectionLabel={selectedNode?.label}
        selection={selectedNodes}
        parents={treeParents}
        hasEmptyNamespaceSibling={hasEmptyNamespaceSibling}
        activeDocument={activeDocument}
        canShowCode={canShowCode}
        debugAvailable={backendStatus.capabilities?.['debug.coreclr.launch'] === true}
        debugState={debugState}
        recentFiles={recentFiles}
        canUndo={canUndo}
        canRedo={canRedo}
        theme={theme}
        onOpen={() => void chooseAndOpen()}
        onOpenFromGac={() => setGacDialogOpen(true)}
        onOpenList={showOpenList}
        onOpenRecent={(path) => void openRecentFile(path)}
        onCloseAll={closeCurrentWorkspace}
        onCloseAllFramework={() => void closeAllFrameworkAssemblies()}
        onCloseAllMissing={() => void closeAllMissingFiles()}
        onCloseOldInMemoryModules={() => void closeOldInMemoryModules()}
        hasOldInMemoryModules={oldInMemoryModuleIds.length > 0}
        dirty={dirty}
        canExportToProject={Boolean(workspaceId) && canExportToProject(selectedNodes, treeParents, treeRoots)}
        onExportToProject={() => setExportProjectNodeIds(useAppStore.getState().selectedNodes.map((node) => node.id))}
        onSave={() => void saveActiveDocument()}
        onSaveModule={() => void saveModule()}
        onSaveAll={() => void saveAllModules()}
        onReloadAll={() => void reloadAll()}
        onSortAssemblies={() => void sortAssemblies()}
        onFind={() => { findInActiveDocumentEditor() }}
        onSearchAssemblies={showSearch}
        onFindStringReferences={() => findStringReferences(useAppStore.getState().selectedNodes)}
        onUndo={undo}
        onRedo={redo}
        onEditMethodBody={() => { if (selectedNode?.kind === 'method') setEditMethodBody({ node: selectedNode }) }}
        onEditResource={() => { if (selectedNode) editResource(selectedNode) }}
        onEditAssembly={() => { if (selectedNode) setAssemblyModuleDialog({ mode: 'assembly', node: selectedNode }) }}
        onEditModule={() => { if (selectedNode) setAssemblyModuleDialog({ mode: 'module', node: selectedNode }) }}
        onEditMethodCode={() => { if (selectedNode) openCodeDialog(selectedNode, 'editMethod') }}
        onEditClassCode={() => { if (selectedNode) openCodeDialog(selectedNode, 'editClass') }}
        onAddClassMembersCode={() => { if (selectedNode) openCodeDialog(selectedNode, 'addMembers') }}
        onAddClassCode={() => { if (selectedNode) openCodeDialog(selectedNode, 'addClass') }}
        onEditAssemblyAttributesCode={() => { if (selectedNode) openCodeDialog(selectedNode, 'editAssembly') }}
        onMergeAssembly={() => { if (selectedNode) void mergeAssembly(selectedNode) }}
        onCreateResource={(kind) => { if (selectedNode) createResource(kind, selectedNode) }}
        onCreateResourceElement={() => { if (selectedNode) createResourceElement(selectedNode) }}
        onCreateImageResources={() => { if (selectedNode) createImageResources(selectedNode) }}
        onCreateImageList={() => { if (selectedNode) createImageList(selectedNode) }}
        selectionIcon={selectedNode?.icon}
        onDelete={deleteSelected}
        onRenameNamespace={() => { if (selectedNode?.kind === 'namespace') setRenameNamespaceNode(selectedNode) }}
        onMoveTypesToEmptyNamespace={() => { if (selectedNode?.kind === 'namespace') void moveTypesToEmptyNamespace(selectedNode) }}
        onConvertModule={(toAssembly) => { if (selectedNode?.kind === 'module') void convertModule(selectedNode, toAssembly) }}
        onCreateAssembly={() => void createAssemblyCommand()}
        onCreateNetModule={() => setNetModuleDialog({})}
        onAddNewNetModule={() => { if (selectedNode) setNetModuleDialog({ assemblyNode: selectedNode }) }}
        onAddExistingNetModule={() => { if (selectedNode) void addExistingNetModule(selectedNode) }}
        onRemoveNetModule={() => { if (selectedNode) void removeNetModuleCommand(selectedNode) }}
        selectionParentIcon={selectedNode && useAppStore.getState().parents[selectedNode.id] ? findNode(useAppStore.getState(), useAppStore.getState().parents[selectedNode.id])?.icon : undefined}
        selectionIndexInParent={selectedNode ? indexInParent(selectedNode.id) : undefined}
        selectionParentKind={selectedNode && useAppStore.getState().parents[selectedNode.id] ? findNode(useAppStore.getState(), useAppStore.getState().parents[selectedNode.id])?.kind : undefined}
        onLoadDependencies={(recursive) => { if (selectedNode) void loadDependencies(selectedNode, recursive) }}
        onReplaceMethodBodyWithStub={() => { if (selectedNode?.kind === 'method') void replaceMethodBodyWithStub(selectedNode) }}
        hex={{ ...editMenuHexContext(), clipboardHexLength: menuClipboardHexLength }}
        onShowAddress={(address) => { void followAddress(address) }}
        canGoToMdTableRow={mdTableRowTarget() !== undefined}
        mdTableRowToken={selectedNodes.length <= 1 && selectedNode && hasMetadataTables(useAppStore.getState(), selectedNode.id) ? selectedNode.metadataToken : undefined}
        onGoToMdTableRow={(token) => {
          const node = token === undefined ? mdTableRowTarget() : selectedNode
          if (node)
            goToMdTableRow(node, token)
        }}
        {...hexCommands}
        onCreateMember={createMember}
        onEditNode={openEditNode}
        onShowCode={() => void showCode()}
        onCollapseTreeViewNodes={collapseTreeViewNodes}
        onStartDebug={() => setDebugProgramDialogOpen(true)}
        onAttachDebug={() => setAttachDialogOpen(true)}
        onContinueDebug={() => void continueDebug()}
        onPauseDebug={() => void pauseDebug()}
        onStepIn={() => void stepDebug('stepIn')}
        onStepOver={() => void stepDebug('next')}
        onStepOut={() => void stepDebug('stepOut')}
        onStepCurrentProcess={(kind) => void stepDebug(kind, true)}
        showCurrentProcessSteps={!options.debugger.breakAllProcesses}
        onStopDebug={() => void stopDebug()}
        onStartWithoutDebugging={() => setRunProgramDialogOpen(true)}
        onDetachDebug={() => void useAppStore.getState().detachDebug()}
        onTerminateDebug={() => void useAppStore.getState().terminateDebug()}
        onRestartDebug={() => void useAppStore.getState().restartDebug()}
        onShowNextStatement={() => void revealStoppedLocation({ caret: true })}
        canRestartDebug={debugProcess?.ownsDebuggee !== false}
        canToggleBreakpoint={canToggleBreakpointHere}
        hasFunctionBreakpoints={lineBreakpoints.length > 0 || functionBreakpoints.length > 0}
        canEnableAllBreakpoints={anyBreakpointDisabled}
        canDisableAllBreakpoints={anyBreakpointEnabled}
        onToggleBreakpoint={toggleBreakpointHere}
        onDeleteAllBreakpoints={deleteAllBreakpoints}
        onEnableAllBreakpoints={() => enableAllBreakpoints(true)}
        onDisableAllBreakpoints={() => enableAllBreakpoints(false)}
        bookmarksCount={bookmarks.length}
        canEnableAllBookmarks={bookmarks.some((bookmark) => !bookmark.enabled)}
        canDisableAllBookmarks={bookmarks.some((bookmark) => bookmark.enabled)}
        onShowBookmarks={showBookmarksWindow}
        onToggleBookmark={toggleBookmarkAtCaret}
        onEnableBookmark={toggleBookmarkEnabledAtCaret}
        onEnableAllBookmarks={() => setAllBookmarksEnabled(true)}
        onDisableAllBookmarks={() => setAllBookmarksEnabled(false)}
        onPreviousBookmark={() => stepBookmark(-1)}
        onNextBookmark={() => stepBookmark(1)}
        onPreviousBookmarkWithSameLabel={() => stepBookmark(-1, 'label')}
        onNextBookmarkWithSameLabel={() => stepBookmark(1, 'label')}
        onPreviousBookmarkInDocument={() => stepBookmark(-1, 'document')}
        onNextBookmarkInDocument={() => stepBookmark(1, 'document')}
        onClearBookmarks={clearBookmarks}
        onClearBookmarksInDocument={clearBookmarksInDocument}
        onShowExplorer={() => showToolWindow('explorer')}
        onShowOutput={() => showToolWindow('output')}
        onShowCSharpInteractive={() => showToolWindow('csharp-interactive')}
        onShowLocals={() => showToolWindow('locals')}
        onShowWatch={() => showToolWindow('watch')}
        onShowToolWindow={(id) => showToolWindow(id)}
        onShowCallStack={() => showToolWindow('callstack')}
        onShowBreakpoints={() => showToolWindow('breakpoints')}
        onShowThreads={() => showToolWindow('threads')}
        onShowModules={() => showToolWindow('modules')}
        onShowModuleBreakpoints={() => showToolWindow('module-breakpoints')}
        onShowExceptionSettings={() => showToolWindow('exception-settings')}
        onShowAutos={() => showToolWindow('autos')}
        onShowStaticFields={() => showToolWindow('static-fields')}
        onShowProcesses={() => showToolWindow('processes')}
        onShowMemory={() => showToolWindow('memory')}
        onShowDisassembly={showActiveFrameDisassembly}
        canShowDisassembly={debugState === 'stopped' && activeDebugFrameId !== undefined}
        windowTabs={windowTabs}
        onSelectWindowTab={(tabId) => {
          if (model.getNodeById(tabId)) {
            model.doAction(Actions.selectTab(tabId))
            refreshLayout()
          }
        }}
        canNewWindow={canCloneWindow}
        onNewWindow={() => { if (currentWindowTab && canCloneWindow) { cloneDocumentTab(currentWindowTab); refreshLayout() } }}
        canCloseWindow={Boolean(currentWindowTab?.isCloseable())}
        onCloseWindow={() => { if (currentWindowTab) { closeDocumentTab(currentWindowTab); refreshLayout() } }}
        canCreateTabGroup={Boolean(windowTabMenuState?.canCreateHorizontalGroup || windowTabMenuState?.canCreateVerticalGroup)}
        canNewHorizontalTabGroup={windowTabMenuState?.canCreateHorizontalGroup ?? false}
        canNewVerticalTabGroup={windowTabMenuState?.canCreateVerticalGroup ?? false}
        onNewHorizontalTabGroup={() => { if (currentWindowTab) { createDocumentTabGroup(currentWindowTab, true); refreshLayout() } }}
        onNewVerticalTabGroup={() => { if (currentWindowTab) { createDocumentTabGroup(currentWindowTab, false); refreshLayout() } }}
        canMoveToNextTabGroup={currentWindowGroupIndex >= 0 && currentWindowGroupIndex < windowGroups.length - 1}
        canMoveAllToNextTabGroup={currentWindowGroup instanceof TabSetNode && currentWindowGroup.getTabNodes().length > 1 && currentWindowGroupIndex >= 0 && currentWindowGroupIndex < windowGroups.length - 1}
        onMoveToNextTabGroup={() => withActiveTab((tab) => moveTabToGroup(tab, 1, false))}
        onMoveAllToNextTabGroup={() => withActiveTab((tab) => moveTabToGroup(tab, 1, true))}
        canMoveToPreviousTabGroup={currentWindowGroupIndex > 0}
        canMoveAllToPreviousTabGroup={currentWindowGroup instanceof TabSetNode && currentWindowGroup.getTabNodes().length > 1 && currentWindowGroupIndex > 0}
        onMoveToPreviousTabGroup={() => withActiveTab((tab) => moveTabToGroup(tab, -1, false))}
        onMoveAllToPreviousTabGroup={() => withActiveTab((tab) => moveTabToGroup(tab, -1, true))}
        canCloseAllTabs={windowTabs.some((tab) => model.getNodeById(tab.id)?.isCloseable())}
        onCloseAllTabs={() => { closeAllDocumentTabs(model); refreshLayout() }}
        canCloseTabGroup={hasOtherWindowGroup}
        onCloseTabGroup={() => withActiveTab(closeTabGroup)}
        canCloseAllTabGroupsButThis={hasOtherWindowGroup}
        onCloseAllTabGroupsButThis={() => withActiveTab(closeOtherTabGroups)}
        canMoveTabGroupAfterNext={currentWindowGroupIndex >= 0 && currentWindowGroupIndex < windowGroups.length - 1}
        onMoveTabGroupAfterNext={() => withActiveTab((tab) => moveTabGroup(tab, true))}
        canMoveTabGroupBeforePrevious={currentWindowGroupIndex > 0}
        onMoveTabGroupBeforePrevious={() => withActiveTab((tab) => moveTabGroup(tab, false))}
        canMergeAllTabGroups={hasOtherWindowGroup}
        onMergeAllTabGroups={mergeTabGroups}
        canUseVerticalTabGroups={hasOtherWindowGroup && !windowGroupsAreSideBySide}
        onUseVerticalTabGroups={() => arrangeTabGroups(false)}
        canUseHorizontalTabGroups={hasOtherWindowGroup && windowGroupsAreSideBySide}
        onUseHorizontalTabGroups={() => arrangeTabGroups(true)}
        onShowWindowsDialog={() => setWindowsDialogOpen(true)}
        visibleToolWindows={visibleToolWindows}
        onTheme={setTheme}
        wordWrap={wordWrap}
        highlightCurrentLine={highlightCurrentLine}
        fullScreen={fullScreen}
        elevated={elevated}
        onToggleWordWrap={() => toggleDocumentViewerOption('wordWrap')}
        onToggleHighlightCurrentLine={() => toggleDocumentViewerOption('highlightCurrentLine')}
        onToggleFullScreen={() => void window.dnSpy.toggleFullScreen()}
        onSetLanguage={setLanguage}
        onAbout={() => setAboutDialogOpen(true)}
        onRestartAsAdministrator={restartAsAdministrator}
        onQuit={() => void window.dnSpy.quit()}
        onShowOptions={(category) => setOptionsDialogCategory(category ?? 'environment')}
      />
      <ToolBar
        hasWorkspace={Boolean(workspaceId)} busy={busy} onOpen={() => void chooseAndOpen()} onSaveAll={() => void saveAllModules()} onSearch={showSearch}
        fullScreen={fullScreen} onToggleFullScreen={() => void window.dnSpy.toggleFullScreen()}
        canGoBack={frontHistory.canGoBack} canGoForward={frontHistory.canGoForward} onBack={() => void goBack()} onForward={() => void goForward()}
        canUndo={canUndo} canRedo={canRedo} onUndo={undo} onRedo={redo}
        decompilerLanguage={defaultLanguage} onLanguageChange={(language) => { void changeLanguage(language, orderedDocumentKeys(model).order) }}
        debugAvailable={backendStatus.capabilities?.['debug.coreclr.launch'] === true} debugState={debugState}
        onStart={() => setDebugProgramDialogOpen(true)} onContinue={() => void continueDebug()} onPause={() => void pauseDebug()}
        onRestart={() => { void stopDebug().then(() => setDebugProgramDialogOpen(true)) }}
        onShowNextStatement={() => void revealStoppedLocation()} onStepInto={() => void stepDebug('stepIn')}
        onStepOver={() => void stepDebug('next')} onStepOut={() => void stepDebug('stepOut')} onStop={() => void stopDebug()}
      />
      {error && (
        <div className="error-banner" role="alert">
          {/* dnSpy reports these in a message box; the banner wears its StatusError image and its close cross. */}
          <DsIcon name="StatusError" />
          <span>{error}</span>
          <button className="icon-button" aria-label={t('Dismiss')} onClick={clearError}><CloseGlyph /></button>
        </div>
      )}
      <main className="workspace-host">
        {/* The Background Image window's picture, under the tabs — dnSpy draws it inside its text views,
            which is what the editor's own background is taken away for while it is up. */}
        <BackgroundImage />
        <Layout
          model={model}
          factory={factory}
          onModelChange={(nextModel) => {
            localStorage.setItem(layoutStorageKey, JSON.stringify(nextModel.toJson()))
            // Every layout change comes through here, which makes it the one place that knows the tab
            // order — and the tab order is part of the session the next run restores.
            const { order, active } = orderedDocumentKeys(nextModel)
            setDocumentOrder(order, active)
            // The hex tabs too: dnSpy keeps a hex tab and its view state in the session, in its place among the
            // document tabs, which are what a session restores along with it.
            const hexTabs: { moduleId: string; index: number }[] = []
            let tabIndex = 0
            nextModel.visitNodes((node) => {
              if (!(node instanceof TabNode) || !['document', 'hex'].includes(node.getComponent() ?? ''))
                return
              const moduleId = node.getComponent() === 'hex' ? (node.getConfig() as { moduleId?: string } | undefined)?.moduleId : undefined
              if (moduleId)
                hexTabs.push({ moduleId, index: tabIndex })
              tabIndex++
            })
            useAppStore.getState().setHexTabs(hexTabs)
            // Closing dnSpy's analyzer window throws away what it held; opening it again starts empty.
            if (!nextModel.getNodeById('analysis'))
              useAnalyzerStore.getState().clear()
            // Closing the search window stops and clears any running search.
            if (!nextModel.getNodeById('search'))
              useSearchStore.getState().clear()
            forceLayoutUpdate((value) => value + 1)
          }}
          onContextMenu={(node, event) => {
            if (!(node instanceof TabNode)) return
            // A tool window's tab gets the window menu — Hide, Hide All and the two Move groups — and a
            // document's gets the tab menu, which is dnSpy's split between the two kinds of tab.
            if (isToolWindowTab(node)) {
              showToolWindowTabContextMenu(node, event, {
                t,
                canMove: canMoveToolWindow,
                onMove: (tab, location) => { moveToolWindow(tab, location) },
                onMoveGroup: (tab, location) => { moveToolWindowGroup(tab, location) },
                onModelChanged: () => forceLayoutUpdate((value) => value + 1),
              })
              return
            }
            showDocumentTabContextMenu(node, event, {
              t,
              canSave: (tab) => {
                if (tab.getComponent() !== 'document') return false
                const config = tab.getConfig() as { documentId?: string } | undefined
                const state = useAppStore.getState()
                const document = config?.documentId ? state.documents[config.documentId] : undefined
                return Boolean(document && !document.loading && !state.busy)
              },
              // BamlTabSaver.MenuHeader: a BAML entry's tab saves its XAML, or its records when disassembled.
              saveHeader: (tab) => {
                const config = tab.getConfig() as { documentId?: string } | undefined
                const language = config?.documentId ? useAppStore.getState().documents[config.documentId]?.language : undefined
                return language === 'xaml' ? t('Save XAML...') : language === 'baml' ? t('Save BAML...') : undefined
              },
              canClone: (tab) => tab.getComponent() === 'document',
              onSave: (tab) => {
                const config = tab.getConfig() as { documentId?: string } | undefined
                if (config?.documentId) void saveCode(config.documentId)
              },
              onModelChanged: () => forceLayoutUpdate((value) => value + 1),
              moveTabToGroup: (tab, offset, all) => moveTabToGroup(tab, offset, all),
              moveGroup: (tab, after) => moveTabGroup(tab, after),
              closeGroup: (tab) => closeTabGroup(tab),
              closeOtherGroups: (tab) => closeOtherTabGroups(tab),
              mergeGroups: () => mergeTabGroups(),
              arrangeGroups: (horizontal) => arrangeTabGroups(horizontal),
            })
          }}
          i18nTranslator={(key) => t(I18nLabelDefaults[key] ?? key)}
        />
      </main>
      <footer className={`status-bar${debugState !== 'inactive' ? ' status-bar-debugging' : ''}`}>
        <span className={`status-indicator status-${backendStatus.state}`} />
        <span>{backendStatus.state === 'ready' ? t('Ready') : backendStatus.message ?? t(backendStatus.state)}</span>
        <span className="status-spacer" />
        {selectedNode && <span title={selectedNode.description}>{selectedNode.kind === 'referencesgroup' ? t('Assembly References') : selectedNode.kind === 'resourcesgroup' ? t('Resources') : selectedNode.label}</span>}
        {workspaceId && <span>{t('Workspace')}</span>}
        {dirty && <span className="dirty-indicator">{t('Modified')}</span>}
        {debugState !== 'inactive' && <span>{debugState === 'stopped' ? t('Stopped: {reason}', { reason: t(stoppedReason ?? 'unknown') }) : t(debugState)}</span>}
      </footer>
      {renameNode && <RenameDialog node={renameNode} onClose={() => setRenameNode(undefined)} />}
      {renameNamespaceNode && <RenameNamespaceDialog node={renameNamespaceNode} onClose={() => setRenameNamespaceNode(undefined)} />}
      {editMethodBody && <MethodBodyDialog node={editMethodBody.node} selection={editMethodBody.selection} onClose={() => setEditMethodBody(undefined)} />}
      {codeDialog && <EditCodeDialog node={codeDialog.node} mode={codeDialog.mode} sourceNodeId={codeDialog.sourceNodeId} theme={theme} onClose={() => setCodeDialog(undefined)} />}
      {saveRequest && workspaceId && saveRequest.phase === 'options' && saveRequest.documents[0] && (
        <SaveModuleOptionsDialog
          key={saveRequest.id}
          workspaceId={workspaceId}
          options={saveRequest.documents[0]}
          onAccept={acceptSaveOptions}
          onClose={() => void finishSave(undefined)}
        />
      )}
      {saveRequest && workspaceId && saveRequest.phase === 'run' && (
        <SaveModulesDialog
          key={saveRequest.id}
          workspaceId={workspaceId}
          documents={saveRequest.documents}
          mode={saveRequest.mode}
          onClose={(response) => void finishSave(response)}
        />
      )}
      {assemblyModuleDialog?.mode === 'assembly' && <AssemblyOptionsDialog node={assemblyModuleDialog.node} onClose={() => setAssemblyModuleDialog(undefined)} />}
      {createAssemblyOpen && <AssemblyOptionsDialog create onClose={() => setCreateAssemblyOpen(false)} />}
      {netModuleDialog && <NetModuleOptionsDialog assemblyNode={netModuleDialog.assemblyNode} onClose={() => setNetModuleDialog(undefined)} />}
      {assemblyModuleDialog?.mode === 'module' && <ModuleOptionsDialog node={assemblyModuleDialog.node} onClose={() => setAssemblyModuleDialog(undefined)} />}
      {resourceDialog?.mode === 'options' && <ResourceOptionsDialog node={resourceDialog.node} onClose={() => setResourceDialog(undefined)} />}
      {resourceDialog?.mode === 'element' && <ResourceElementDialog node={resourceDialog.node} onClose={() => setResourceDialog(undefined)} />}
      {resourceDialog?.mode === 'create' && <CreateResourceDialog owner={resourceDialog.node} kind={resourceDialog.kind} onClose={() => setResourceDialog(undefined)} />}
      {resourceDialog?.mode === 'createElement' && <CreateResourceElementDialog resourceNode={resourceDialog.node} onClose={() => setResourceDialog(undefined)} />}
      {resourceDialog?.mode === 'createImageList' && <CreateImageListDialog resourceNode={resourceDialog.node} onClose={() => setResourceDialog(undefined)} />}
      {tokenNode && <GoToTokenDialog node={tokenNode} onClose={() => setTokenNode(undefined)} />}
      {mdRowNode && (
        <AskDialog
          title="Go to MD Table Row"
          label={t('Metadata token')}
          validate={(text) => {
            const trimmed = text.trim()
            const hexadecimal = /^(0x|&h)/i.test(trimmed)
            const digits = hexadecimal ? trimmed.slice(2) : trimmed
            if (!(hexadecimal ? /^[0-9a-f]+$/i : /^\d+$/).test(digits))
              return t('The value is not a hexadecimal or decimal integer')
            return parseInt(digits, hexadecimal ? 16 : 10) > 0xFFFFFFFF
              ? t('Value must be between {min} and {max} (0x{maxHex}) inclusive', { min: 0, max: 0xFFFFFFFF, maxHex: 'FFFFFFFF' })
              : undefined
          }}
          onAccept={(text) => {
            const trimmed = text.trim()
            const token = /^(0x|&h)/i.test(trimmed) ? parseInt(trimmed.slice(2), 16) : parseInt(trimmed, 10)
            return useAppStore.getState().goToMetadataRecord(mdRowNode, token).then((error) => {
              if (!error)
                setMdRowNode(undefined)
              return error
            })
          }}
          onClose={() => setMdRowNode(undefined)}
        />
      )}
      {/* dnSpy's Add Class Tracepoint asks for the settings first, with the trace already switched on, and only
          then puts a breakpoint on every method of the type — each carrying what the dialog said. */}
      {classTracepointNode && (
        <BreakpointSettingsDialog
          settings={{ trace: { message: '', continue: true } }}
          onClose={() => setClassTracepointNode(undefined)}
          onSave={(settings) => {
            const node = classTracepointNode
            setClassTracepointNode(undefined)
            void addClassBreakpoint(node, settings)
          }}
        />
      )}
      {/* The Call Stack window's Insert Tracepoint asks for the settings the same way, for the frame's location. */}
      {locationTracepointRequest && (
        <BreakpointSettingsDialog
          settings={{ trace: { message: '', continue: true } }}
          onClose={() => requestLocationTracepoint(undefined)}
          onSave={(settings) => {
            const location = locationTracepointRequest
            requestLocationTracepoint(undefined)
            void addLocationBreakpoint(location, settings)
          }}
        />
      )}
      {/* dnSpy's ShowCodeBreakpointSettingsService.Edit: the first breakpoint's settings, given to every one of them. */}
      {breakpointSettingsRequest && (
        <BreakpointSettingsDialog
          settings={breakpointSettingsOf(breakpointSettingsRequest.ids[0])}
          onClose={() => editBreakpointSettings(undefined)}
          onSave={(settings) => { void setBreakpointsSettings(breakpointSettingsRequest.ids, settings) }}
        />
      )}
      {editNode && workspaceId && (
        <NodeOptionsDialog
          key={`${editNode.kind}:${editNode.nodeId ?? editNode.ownerNodeId}:${editNode.nested === true}`}
          workspaceId={workspaceId}
          kind={editNode.kind}
          nodeId={editNode.nodeId}
          ownerNodeId={editNode.ownerNodeId}
          nested={editNode.nested}
          onClose={() => setEditNode(undefined)}
        />
      )}
      {attachDialogOpen && <AttachDialog onClose={() => setAttachDialogOpen(false)} />}
      {debugProgramDialogOpen && <DebugProgramDialog onClose={() => setDebugProgramDialogOpen(false)} />}
      {runProgramDialogOpen && <DebugProgramDialog mode="run" onClose={() => setRunProgramDialogOpen(false)} />}
      {aboutDialogOpen && <AboutDialog onClose={() => setAboutDialogOpen(false)} />}
      {exportProjectNodeIds && workspaceId && (
        <ExportToProjectDialog
          workspaceId={workspaceId}
          nodeIds={exportProjectNodeIds}
          language={defaultLanguage}
          onClose={() => setExportProjectNodeIds(undefined)}
        />
      )}
      {gacDialogOpen && (
        <OpenFromGacDialog
          onClose={() => setGacDialogOpen(false)}
          onOpen={(paths) => void openPaths(paths, { remember: true })}
        />
      )}
      {openListDialogOpen && (
        <OpenListDialog
          onClose={() => setOpenListDialogOpen(false)}
          onOpen={(stored, chosen) => void openDocumentList(stored, chosen)}
        />
      )}
      {windowsDialogOpen && (
        <WindowsDialog
          tabs={windowsDialogTabs}
          onActivate={(tabId) => {
            if (model.getNodeById(tabId)) {
              model.doAction(Actions.selectTab(tabId))
              refreshLayout()
            }
            setWindowsDialogOpen(false)
          }}
          canSave={(tabId) => {
            const tab = model.getNodeById(tabId)
            if (!(tab instanceof TabNode) || tab.getComponent() !== 'document') return false
            const config = tab.getConfig() as { documentId?: string } | undefined
            const state = useAppStore.getState()
            const document = config?.documentId ? state.documents[config.documentId] : undefined
            return Boolean(document && !document.loading && !state.busy)
          }}
          onSave={(tabId) => {
            const tab = model.getNodeById(tabId)
            const config = tab instanceof TabNode ? tab.getConfig() as { documentId?: string } | undefined : undefined
            if (config?.documentId) void saveCode(config.documentId)
          }}
          onCloseTabs={(tabIds) => {
            for (const tabId of tabIds) {
              const tab = model.getNodeById(tabId)
              if (tab instanceof TabNode && tab.isCloseable())
                model.doAction(Actions.deleteTab(tabId))
            }
            refreshLayout()
          }}
          onClose={() => setWindowsDialogOpen(false)}
        />
      )}
      {optionsDialogCategory !== undefined && (
        <OptionsDialog initialCategory={optionsDialogCategory} onClose={() => setOptionsDialogCategory(undefined)} />
      )}
    </div>
  )
}
