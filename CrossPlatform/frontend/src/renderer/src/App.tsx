import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Actions, DockLocation, I18nLabelDefaults, Layout, Model, Orientation, RowNode, TabNode, TabSetNode, type IJsonModel } from 'flexlayout-react'
import { AlertCircle, FolderOpen, X } from 'lucide-react'
import type { DecompilerLanguage, TextSpan, TreeNode } from '../../shared/protocol'
import { enableSessionPersistence, loadSession, methodBreakpointName, nodesByIdOf, orderedDocumentKeys, ownerTypeIdOf, syncDockTabStrips, useAppStore, type SavedSession } from './app-store'
import { clearBookmarks, clearBookmarksInDocument, showBookmarksWindow, stepBookmark, toggleBookmarkAtCaret, toggleBookmarkEnabledAtCaret } from './bookmark-commands'
import { loadAppOptions } from './components/app-options'
import { AssemblyExplorer } from './components/AssemblyExplorer'
import { hasEmptyNamespaceSibling as namespaceHasEmptySibling, type AssemblyExplorerCommands } from './components/AssemblyExplorerContextMenu'
import { MenuBar, type ThemeName } from './components/MenuBar'
import { ToolBar } from './components/ToolBar'
import { AnalysisPane, DebugPlaceholder, OutputPane, SearchPane } from './components/ToolWindows'
import { CSharpInteractive } from './components/CSharpInteractive'
import { GoToTokenDialog, MethodBodyEditor, RenameDialog, RenameNamespaceDialog } from './components/EditDialogs'
import { HexView, ModuleInfoView } from './components/SpecialDocuments'
import { BreakpointsPane, CallStackPane, LocalsPane, ModulesPane, ThreadsPane, WatchPane } from './components/DebugToolWindows'
import { ExceptionSettingsPane } from './components/ExceptionSettingsPane'
import { BookmarksPane } from './components/BookmarksPane'
import { AttachDialog } from './components/AttachDialog'
import { DebugProgramDialog } from './components/DebugProgramDialog'
import { AboutDialog } from './components/AboutDialog'
import { WindowsDialog, type WindowTabEntry } from './components/WindowsDialog'
import { NodeOptionsDialog } from './components/NodeOptionsDialog'
import { OptionsDialog } from './components/OptionsDialog'
import { cloneDocumentTab, closeAllDocumentTabs, closeDocumentTab, closeDocumentTabsFor, createDocumentTabGroup, getDocumentTabMenuState, getDocumentTabSets, getDocumentTabs, showDocumentTabContextMenu } from './components/DocumentTabContextMenu'
import { DockPane } from './components/DockPane'
// Only the interface: the component itself is loaded lazily, when a document tab first draws one.
import type { DocumentViewCommands } from './components/DocumentView'
import type { ActiveDocument, CreatedKind, HexShowKind } from './components/edit-menu'
import { findInActiveDocumentEditor, focusDocumentEditor } from './editor-registry'
import { translate, useLanguage } from './localization'

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
const DOCUMENT_COMPONENTS = ['document', 'hex', 'module-info', 'start']

/** The tabs the View menu can bring back, with the label and component each one needs. The explorer opens
 * in the column on the left; everything else belongs to the tool window tab set. */
const restorableTabs: Record<string, { name: string; component: string }> = {
  explorer: { name: 'Assembly Explorer', component: 'explorer' },
  output: { name: 'Output', component: 'output' },
  'csharp-interactive': { name: 'C# Interactive', component: 'csharp-interactive' },
  search: { name: 'Search', component: 'search' },
  analysis: { name: 'Analyzer', component: 'analysis' },
  locals: { name: 'Locals', component: 'locals' },
  'exception-settings': { name: 'Exception Settings', component: 'exception-settings' },
  watch: { name: 'Watch 1', component: 'watch' },
  callstack: { name: 'Call Stack', component: 'callstack' },
  breakpoints: { name: 'Breakpoints', component: 'breakpoints' },
  bookmarks: { name: 'Bookmarks', component: 'bookmarks' },
  threads: { name: 'Threads', component: 'threads' },
  modules: { name: 'Modules', component: 'modules' },
  'module-breakpoints': { name: 'Module Breakpoints', component: 'module-breakpoints' },
  autos: { name: 'Autos', component: 'autos' },
  'static-fields': { name: 'Static Fields', component: 'static-fields' },
  processes: { name: 'Processes', component: 'processes' },
  memory: { name: 'Memory', component: 'memory' },
  disassembly: { name: 'Disassembly', component: 'disassembly' },
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

// The second key of a Ctrl+K chord, as dnSpy binds it: Ctrl+K Ctrl+K toggles, Ctrl+K Ctrl+P and Ctrl+K
// Ctrl+N walk the bookmarks, Ctrl+K Ctrl+L clears them, Ctrl+K Ctrl+E enables or disables the one under
// the caret, and Ctrl+K Ctrl+W opens the window — the same keys Visual Studio uses.
const bookmarkChords: Record<string, () => void> = {
  k: toggleBookmarkAtCaret,
  p: () => stepBookmark(-1),
  n: () => stepBookmark(1),
  l: clearBookmarks,
  e: toggleBookmarkEnabledAtCaret,
  w: showBookmarksWindow,
}

// The kinds dnSpy confirms before deleting, with its own wording (`AskDeleteType` and friends). Every
// other deletable kind — property, event, resource, namespace — is removed without a prompt.
const DELETE_CONFIRMATIONS: Record<string, string> = {
  type: 'There could be code in some assembly that references this type. Are you sure you want to delete the type?',
  method: 'There could be code in some assembly that references this method. Are you sure you want to delete the method?',
  field: 'There could be code in some assembly that references this field. Are you sure you want to delete the field?',
}

// The node kinds the Edit menu offers a Delete command for, and which the Del key therefore removes.
const DELETABLE_KINDS = ['type', 'method', 'field', 'property', 'event', 'namespace', 'resource']

// The node kinds whose Edit command — and Alt+Enter with it — opens a dialog: every one dnSpy has a
// settings command for that the port has built the window of.
const EDITABLE_KINDS = new Set<string>(['type', 'method', 'field', 'property', 'event'])
const isEditableKind = (kind: string): kind is CreatedKind => EDITABLE_KINDS.has(kind)

const loadTheme = (): ThemeName => {
  const saved = localStorage.getItem('dnspy.theme')
  return saved === 'light' || saved === 'dark' || saved === 'hc' || saved === 'blue' ? saved : 'dark'
}

export const App = (): React.JSX.Element => {
  const [model] = useState(loadLayout)
  const [theme, setTheme] = useState<ThemeName>(loadTheme)
  const wordWrap = useAppStore((state) => state.wordWrap)
  const setWordWrap = useAppStore((state) => state.setWordWrap)
  const highlightCurrentLine = useAppStore((state) => state.highlightCurrentLine)
  const setHighlightCurrentLine = useAppStore((state) => state.setHighlightCurrentLine)
  const [fullScreen, setFullScreen] = useState<boolean>(false)
  // dnSpy reads this once at startup and never again; elevation can't change under a running app.
  const [elevated, setElevated] = useState<boolean>(false)
  const [renameNode, setRenameNode] = useState<TreeNode>()
  const [renameNamespaceNode, setRenameNamespaceNode] = useState<TreeNode>()
  const [editMethodNode, setEditMethodNode] = useState<TreeNode>()
  // dnSpy's Go to Token box. It is opened from the tree, and the node it was opened over is what names
  // the module the token is looked up in.
  const [tokenNode, setTokenNode] = useState<TreeNode>()
  // The create or edit dialog the Edit menu opened, over the node it acts on: `nodeId` is what is being
  // edited, and is left off when a new node is being created in `ownerNodeId` instead.
  const [editNode, setEditNode] = useState<{ kind: CreatedKind, nodeId?: string, ownerNodeId?: string, nested?: boolean }>()
  const [attachDialogOpen, setAttachDialogOpen] = useState(false)
  const [debugProgramDialogOpen, setDebugProgramDialogOpen] = useState(false)
  const [aboutDialogOpen, setAboutDialogOpen] = useState(false)
  const [windowsDialogOpen, setWindowsDialogOpen] = useState(false)
  const [optionsDialogCategory, setOptionsDialogCategory] = useState<'environment' | 'decompiler' | 'debugger' | undefined>(undefined)
  const [navigation, setNavigation] = useState<{ items: TreeNode[]; index: number }>({ items: [], index: -1 })
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
    return component === 'document' ? 'code' : component === 'hex' || component === 'module-info' ? component : null
  }, [model, layoutVersion])
  const canShowCode = activeDocument === 'code'
  // When a Ctrl+K chord stops waiting for its second key, as a timestamp so it needs no timer.
  const bookmarkChord = useRef(0)
  const workspaceId = useAppStore((state) => state.workspaceId)
  const backendStatus = useAppStore((state) => state.backendStatus)
  const busy = useAppStore((state) => state.busy)
  const error = useAppStore((state) => state.error)
  const selectedNode = useAppStore((state) => state.selectedNode)
  const modules = useAppStore((state) => state.modules)
  const chooseAndOpen = useAppStore((state) => state.chooseAndOpen)
  const closeWorkspace = useAppStore((state) => state.closeWorkspace)
  const dirty = useAppStore((state) => state.dirty)
  const recentWorkspaces = useAppStore((state) => state.recentWorkspaces)
  const openPaths = useAppStore((state) => state.openPaths)
  const canUndo = useAppStore((state) => state.canUndo)
  const canRedo = useAppStore((state) => state.canRedo)
  const undoEdit = useAppStore((state) => state.undoEdit)
  const redoEdit = useAppStore((state) => state.redoEdit)
  const activeDocumentId = useAppStore((state) => state.activeDocumentId)
  const activeDocumentLanguage = useAppStore((state) => state.activeDocumentId ? state.documents[state.activeDocumentId]?.requestedLanguage : undefined)
  const changeDocumentLanguage = useAppStore((state) => state.changeDocumentLanguage)
  const saveModuleAs = useAppStore((state) => state.saveModuleAs)
  const saveModule = useAppStore((state) => state.saveModule)
  const saveAllModules = useAppStore((state) => state.saveAllModules)
  const reloadAllAssemblies = useAppStore((state) => state.reloadAllAssemblies)
  const sortAssemblies = useAppStore((state) => state.sortAssemblies)
  const removeModule = useAppStore((state) => state.removeModule)
  const goToSpecialNode = useAppStore((state) => state.goToSpecialNode)
  const goToToken = useAppStore((state) => state.goToToken)
  const saveCode = useAppStore((state) => state.saveCode)
  const replaceResource = useAppStore((state) => state.replaceResource)
  const saveResource = useAppStore((state) => state.saveResource)
  const loadDependencies = useAppStore((state) => state.loadDependencies)
  const convertModule = useAppStore((state) => state.convertModule)
  const addClassBreakpoint = useAppStore((state) => state.addClassBreakpoint)
  const deleteNode = useAppStore((state) => state.deleteNode)
  const renameNamespace = useAppStore((state) => state.renameNamespace)
  const moveTypesToEmptyNamespace = useAppStore((state) => state.moveTypesToEmptyNamespace)
  const replaceMethodBodyWithStub = useAppStore((state) => state.replaceMethodBodyWithStub)
  const hexTarget = useAppStore((state) => state.hexTarget)
  const hexStatement = useAppStore((state) => state.hexStatement)
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
  const analyzeNode = useAppStore((state) => state.analyzeNode)
  const setBackendStatus = useAppStore((state) => state.setBackendStatus)
  const clearError = useAppStore((state) => state.clearError)
  const debugState = useAppStore((state) => state.debugState)
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
  const toggleFunctionBreakpoint = useAppStore((state) => state.toggleFunctionBreakpoint)
  const deleteAllBreakpointsAction = useAppStore((state) => state.deleteAllBreakpoints)
  const setAllFunctionBreakpointsEnabled = useAppStore((state) => state.setAllFunctionBreakpointsEnabled)
  const setAllLineBreakpointsEnabled = useAppStore((state) => state.setAllLineBreakpointsEnabled)
  const { locale, setLanguage, t } = useLanguage()

  // "Toggle Breakpoint" acts on the current item. With the tree focused that item is a method, so the entry still
  // means "break wherever this method starts"; in the editor F9 is handled by Monaco, which knows the cursor line
  // and can therefore set a line breakpoint instead.
  const breakpointTarget = useMemo(
    () => (selectedNode?.kind === 'method' ? methodBreakpointName(selectedNode.description) : undefined),
    [selectedNode],
  )
  const toggleBreakpointHere = (): void => {
    if (breakpointTarget) void toggleFunctionBreakpoint(breakpointTarget)
  }
  const deleteAllBreakpoints = (): void => {
    if (window.confirm(t('Do you want to delete all breakpoints?')))
      void deleteAllBreakpointsAction()
  }

  // dnSpy's "Move Types to Empty Namespace" is offered only when the module already has an empty
  // namespace node for the types to land in; the module's children are loaded whenever one of its
  // namespaces is selectable, so the sibling list is the tree the user is looking at.
  const hasEmptyNamespaceSibling = useMemo(
    () => namespaceHasEmptySibling(selectedNode, treeChildren, treeParents),
    [selectedNode, treeChildren, treeParents],
  )

  /** Removes a node, defaulting to the selected one. A menu that carries its own node — the code
   *  viewer's context menu, whose selection is the reference under the caret — hands that one over. */
  const deleteSelected = (node = selectedNode): void => {
    if (!node)
      return
    // dnSpy asks before removing a type, method or field — each of those can be referenced from code
    // that this edit cannot see. Property, event, resource and namespace removals go through unasked.
    const question = DELETE_CONFIRMATIONS[node.kind]
    if (question && !window.confirm(t(question)))
      return
    void deleteNode(node).then((deleted) => {
      if (deleted)
        closeDocumentTabsFor(model, node.id)
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

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('dnspy.theme', theme)
  }, [theme])

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
      callstack: t('Call Stack'),
      breakpoints: t('Breakpoints'),
      bookmarks: t('Bookmarks'),
      threads: t('Threads'),
      modules: t('Modules'),
      'module-breakpoints': t('Module Breakpoints'),
      autos: t('Autos'),
      'static-fields': t('Static Fields'),
      processes: t('Processes'),
      memory: t('Memory'),
      disassembly: t('Disassembly'),
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

  /** Brings a docked tab forward, adding it back when it has been closed. The explorer returns to a column
   * of its own on the left, the height of everything beside it; every other tool window lives in the tab
   * set under the editor. */
  const showToolWindow = (tabId: string): void => {
    const tab = model.getNodeById(tabId)
    if (tab instanceof TabNode) {
      model.doAction(Actions.selectTab(tabId))
      forceLayoutUpdate((value) => value + 1)
      return
    }
    const spec = restorableTabs[tabId]
    if (!spec) return
    if (tabId === 'explorer') {
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
  const moveActiveTabToGroup = (offset: -1 | 1, all: boolean): void => {
    const tab = activeDocumentTab()
    if (!tab) return
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
  const moveActiveGroup = (after: boolean): void => {
    const tab = activeDocumentTab()
    const groups = documentTabSets()
    const source = tab?.getParent()
    if (!(source instanceof TabSetNode)) return
    const index = groups.indexOf(source)
    const target = groups[index + (after ? 1 : -1)]
    if (!target) return
    model.doAction(Actions.moveNode(source.getId(), target.getId(), after ? DockLocation.RIGHT : DockLocation.LEFT, -1, false))
    refreshLayout()
  }
  const closeActiveTabGroup = (): void => {
    const tab = activeDocumentTab()
    const group = tab?.getParent()
    if (!(group instanceof TabSetNode)) return
    for (const item of group.getTabNodes())
      if (item.isCloseable()) model.doAction(Actions.deleteTab(item.getId()))
    refreshLayout()
  }
  const closeOtherTabGroups = (): void => {
    const tab = activeDocumentTab()
    const current = tab?.getParent()
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
  const windowTabs = useMemo(() => getDocumentTabs(model).map((tab) => ({
    id: tab.getId(),
    label: tab.getName(),
    checked: tab.isSelected(),
  })), [model, layoutVersion])
  // The Windows dialog's rows: the module column walks the tree up from the document's node, which
  // works for the members documents usually show; special tabs fall back to the single loaded module.
  const windowsDialogTabs = useMemo<WindowTabEntry[]>(() => windowTabs.map((tab) => {
    let moduleId: string | undefined
    let ancestor = tab.id
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
  const windowGroupsAreHorizontal = commonWindowGroupParent instanceof RowNode
    && commonWindowGroupParent.getOrientation() === Orientation.HORZ

  const showCode = async (): Promise<void> => {
    const tab = model.getActiveTabset()?.getSelectedNode()
    if (!(tab instanceof TabNode) || tab.getComponent() !== 'document')
      return
    const documentId = (tab.getConfig() as { documentId?: string } | undefined)?.documentId
    if (!documentId)
      return
    const state = useAppStore.getState()
    if (state.documents[documentId]?.requestedLanguage !== 'cSharp')
      await state.changeDocumentLanguage(documentId, 'cSharp')
    focusDocumentEditor(tab.getId())
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
      // The bookmark commands are two-key chords: Ctrl+K arms them and the second key runs one. Monaco
      // binds the same chords while the code editor has focus and stops the event there, so this path
      // is the one that answers when the focus is in the tree, a tool window or the menu bar.
      if (!editingText && !event.shiftKey && !event.altKey && event.ctrlKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        bookmarkChord.current = Date.now() + 2000
        return
      }
      if (!editingText && bookmarkChord.current > Date.now() && event.ctrlKey && !event.shiftKey && !event.altKey) {
        const chord = bookmarkChords[event.key.toLowerCase()]
        if (chord) {
          bookmarkChord.current = 0
          event.preventDefault()
          chord()
          return
        }
      }
      bookmarkChord.current = 0
      if (event.ctrlKey && event.key.toLowerCase() === 'o') {
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
          void saveModule()
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
      } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        collapseTreeViewNodes()
      } else if (event.ctrlKey && event.altKey && (event.code === 'Digit0' || event.code === 'Numpad0')) {
        event.preventDefault()
        void showCode()
      } else if (event.ctrlKey && event.altKey && event.code === 'KeyN') {
        event.preventDefault()
        showToolWindow('csharp-interactive')
      } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'k' && workspaceId) {
        event.preventDefault()
        showToolWindow('search')
      } else if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'f' && activeDocument === 'code') {
        event.preventDefault()
        findInActiveDocumentEditor()
      } else if (event.ctrlKey && event.key.toLowerCase() === 'z' && canUndo && !editingText) {
        event.preventDefault()
        void undoEdit()
      } else if (event.ctrlKey && event.key.toLowerCase() === 'y' && canRedo && !editingText) {
        event.preventDefault()
        void redoEdit()
      } else if (event.altKey && event.key === 'Enter' && !editingText) {
        // dnSpy's Alt+Enter: the settings command of the selected node, which its menu lists beside
        // Edit Method...
        event.preventDefault()
        openEditNode()
      } else if (event.key === 'F2' && selectedNode && !editingText && ['type', 'method', 'field', 'property', 'event'].includes(selectedNode.kind)) {
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
      } else if (event.shiftKey && event.key === 'F5' && debugState !== 'inactive' && !editingText) {
        event.preventDefault()
        void stopDebug()
      } else if (event.key === 'F5' && !editingText) {
        event.preventDefault()
        if (debugState === 'stopped') void continueDebug()
        // Upstream's F5 is ContinueOrDebugProgram: with no session it is the Start button, dialog and all.
        else if (debugState === 'inactive') setDebugProgramDialogOpen(true)
      } else if (event.key === 'F10' && debugState === 'stopped' && !editingText) {
        event.preventDefault()
        void stepDebug('next')
      } else if (event.shiftKey && event.key === 'F11' && debugState === 'stopped' && !editingText) {
        event.preventDefault()
        void stepDebug('stepOut')
      } else if (event.key === 'F11' && !event.shiftKey && debugState === 'stopped' && !editingText) {
        event.preventDefault()
        void stepDebug('stepIn')
      } else if (event.key === 'F11' && !event.shiftKey && !editingText) {
        event.preventDefault()
        void window.dnSpy.toggleFullScreen()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeDocument, canRedo, canUndo, chooseAndOpen, collapseTreeViewNodes, continueDebug, debugState, deleteAllBreakpoints, deleteSelected, model, openEditNode, redoEdit, saveAllModules, saveCode, saveModule, saveModuleAs, selectedNode, showToolWindow, showCode, stepDebug, stopDebug, toggleBreakpointHere, undoEdit, workspaceId])

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
    setNavigation({ items: [], index: -1 })
    // A restore opens the workspace itself, and the tabs it puts back are the ones this would otherwise
    // delete a moment later; it clears the stale ones and adds Start where it needs them.
    if (useAppStore.getState().restoringSession)
      return
    closeDocumentTabs()
    showStartTab()
    forceLayoutUpdate((value) => value + 1)
  }, [model, workspaceId, t])

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (dirty) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty])

  const addDocumentTab = async (node: TreeNode, recordHistory = true, language?: DecompilerLanguage, newTab = false): Promise<void> => {
    const { workspaceId, workspaceGeneration } = useAppStore.getState()
    if (recordHistory) {
      setNavigation((current) => {
        if (current.items[current.index]?.id === node.id)
          return current
        const items = [...current.items.slice(0, current.index + 1), node].slice(-100)
        return { items, index: items.length - 1 }
      })
    }
    const documentId = await openDocument(node, language)
    const current = useAppStore.getState()
    if (current.workspaceId !== workspaceId || current.workspaceGeneration !== workspaceGeneration)
      return
    const tabId = `doc:${documentId}`
    // A method's tab shows the title the backend decompiled it under — "name(params) : return" — not
    // the tree label, which drops the return type. Anything else already labels the two the same way.
    const tabName = current.documents[documentId]?.title ?? node.label
    if (model.getNodeById(tabId)) {
      model.doAction(Actions.selectTab(tabId))
      const existing = model.getNodeById(tabId)
      if (existing instanceof TabNode && existing.getName() !== tabName)
        model.doAction(Actions.renameTab(tabId, tabName))
      // "Open in New Tab" keeps the tab the document already had and adds a second one beside it, which
      // is what cloneDocumentTab draws — the same document under a new tab id.
      if (newTab && existing instanceof TabNode)
        cloneDocumentTab(existing)
    } else {
      const targetTabSet = getTargetDocumentTabSet(model)
      if (!targetTabSet) return
      model.doAction(Actions.addNode({
        type: 'tab',
        id: tabId,
        name: tabName,
        component: 'document',
        config: { documentId },
      }, targetTabSet.getId(), DockLocation.CENTER, -1, true))
      if (model.getNodeById('start'))
        model.doAction(Actions.deleteTab('start'))
    }
    forceLayoutUpdate((value) => value + 1)
  }

  // Where the previous session comes back. Every node the saved session names is looked up by key —
  // walking down from the roots, materialising each branch on the way, because only the module roots
  // exist after a restart — and whatever no longer resolves is passed over so the rest still restores.
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
        if (!isCurrent()) return
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
        await addDocumentTab(node, false, document.language)
        if (!isCurrent()) return
        restoredDocuments++
      }
      // Opening a document takes the Start tab away, so one only comes back when nothing was restored
      // to take its place.
      if (restoredDocuments === 0)
        showStartTab()
      const active = session.activeDocument ? byKey.get(session.activeDocument) : undefined
      if (active) {
        model.doAction(Actions.selectTab(`doc:${active.id}`))
        forceLayoutUpdate((value) => value + 1)
      }
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

  const openNodeId = async (nodeId: string): Promise<void> => {
    if (!workspaceId) return
    try {
      const node = await window.dnSpy.getNode(workspaceId, nodeId)
      await addDocumentTab(node)
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
      const node = await window.dnSpy.getNode(workspaceId, nodeId)
      await addDocumentTab(node)
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
      const node = await window.dnSpy.getNode(workspaceId, nodeId)
      await addDocumentTab(node, true, undefined, true)
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
    const tabId = `doc:${nodeId}`
    const tab = model.getNodeById(tabId)
    if (tab instanceof TabNode) {
      // Selecting the tab that is already selected would still count as a layout change, and a step
      // asks for this on every stop.
      if (!tab.isSelected()) {
        model.doAction(Actions.selectTab(tabId))
        forceLayoutUpdate((value) => value + 1)
      }
      return
    }
    await shellCallbacksRef.current.openBookmarkTarget(nodeId)
  }

  // The store cannot open tabs or tool windows itself, so it calls back into the shell. Handlers are
  // read through a ref because both close over the current workspace and layout.
  const shellCallbacksRef = useRef({ openBookmarkTarget, openNodeInNewTab, showToolWindow, restoreSession, revealDocumentTarget })
  shellCallbacksRef.current = { openBookmarkTarget, openNodeInNewTab, showToolWindow, restoreSession, revealDocumentTarget }
  useEffect(() => {
    setOpenNodeById((nodeId) => shellCallbacksRef.current.openBookmarkTarget(nodeId))
    setOpenNodeInNewTabById((nodeId) => shellCallbacksRef.current.openNodeInNewTab(nodeId))
    setOpenToolWindow((tabId) => shellCallbacksRef.current.showToolWindow(tabId))
    setRevealDocument((nodeId) => shellCallbacksRef.current.revealDocumentTarget(nodeId))
    return () => {
      setOpenNodeById(undefined)
      setOpenNodeInNewTabById(undefined)
      setOpenToolWindow(undefined)
      setRevealDocument(undefined)
    }
  }, [setOpenNodeById, setOpenNodeInNewTabById, setOpenToolWindow, setRevealDocument])

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
    void useAppStore.getState().revealNode(activeDocumentId)
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
      const options = await window.dnSpy.getStartupOptions()
      const session = options.noLoadFiles ? undefined : loadSession()
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
      if (options.initialPaths.length > 0)
        await openPaths(options.initialPaths)
    })()
  }, [backendStatus.state, openPaths])

  const goBack = (): void => {
    if (navigation.index <= 0) return
    const index = navigation.index - 1
    const node = navigation.items[index]
    setNavigation((current) => ({ ...current, index }))
    void addDocumentTab(node, false)
  }

  const goForward = (): void => {
    if (navigation.index >= navigation.items.length - 1) return
    const index = navigation.index + 1
    const node = navigation.items[index]
    setNavigation((current) => ({ ...current, index }))
    void addDocumentTab(node, false)
  }

  const openAnalysis = async (node: TreeNode): Promise<void> => {
    await analyzeNode(node)
    showToolWindow('analysis')
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
  const addSpecialTab = (component: 'hex' | 'module-info', module: { id: string; label: string }): void => {
    const tabId = `${component}:${module.id}`
    if (model.getNodeById(tabId)) {
      model.doAction(Actions.selectTab(tabId))
    } else {
      const targetTabSet = getTargetDocumentTabSet(model)
      if (!targetTabSet) return
      model.doAction(Actions.addNode({
        type: 'tab',
        id: tabId,
        name: component === 'hex' ? `${module.label} [${t('Hex')}]` : `${module.label} [${t('Info')}]`,
        component,
        config: { moduleId: module.id },
      }, targetTabSet.getId(), DockLocation.CENTER, -1, true))
      if (model.getNodeById('start')) model.doAction(Actions.deleteTab('start'))
    }
    forceLayoutUpdate((value) => value + 1)
  }

  // The hex commands name their module by node id, and the tab needs a label with it. Both come from the
  // store rather than from the render, because a menu built for a freshly clicked node runs its commands
  // after the click that showed it — by which time the target it was built from is the current one.
  const moduleTabTarget = (moduleId: string): { id: string; label: string } | undefined => {
    const node = useAppStore.getState().roots.find((root) => root.id === moduleId)
    return node ? { id: node.id, label: node.label } : undefined
  }

  const openHex = (): void => {
    const target = useAppStore.getState().hexTarget
    const tab = target ? moduleTabTarget(target.moduleId) : undefined
    if (tab)
      addSpecialTab('hex', tab)
  }

  /** Opens the hex tab on the bytes one of the "Show ... in Hex Editor" commands names. */
  const showSelectionInHex = (kind: HexShowKind): void => {
    const hexTarget = useAppStore.getState().hexTarget
    if (kind === 'statement') {
      const statement = useAppStore.getState().hexStatement
      const target = statement ? moduleTabTarget(statement.moduleId) : undefined
      if (!statement || !target) return
      showHexAt(statement.moduleId, statement.range.offset, statement.range.length)
      addSpecialTab('hex', target)
      return
    }
    const range = !hexTarget ? undefined
      : kind === 'instructions' ? hexTarget.method && { offset: hexTarget.method.codeOffset, length: hexTarget.method.codeSize }
      : kind === 'body' ? hexTarget.method && { offset: hexTarget.method.bodyOffset, length: hexTarget.method.bodySize }
      : kind === 'fieldInitialValue' ? hexTarget.fieldInitialValue
      : hexTarget.resource
    const target = hexTarget ? moduleTabTarget(hexTarget.moduleId) : undefined
    if (!hexTarget || !target || !range) return
    showHexAt(hexTarget.moduleId, range.offset, range.length)
    addSpecialTab('hex', target)
  }

  const closeCurrentWorkspace = (): void => {
    if (!dirty || window.confirm(t('Discard unsaved changes and close the workspace?')))
      void closeWorkspace()
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
  const explorerCommands: AssemblyExplorerCommands = {
    onOpenNode: (node) => { void addDocumentTab(node) },
    onOpenInNewTab: (node) => { void openNodeInNewTab(node.id) },
    onDeleteNode: (node) => deleteSelected(node),
    onEditNode: (node) => openEditNode(node),
    onCreateMember: (kind, nested, node) => createMember(kind, nested, node),
    onEditMethodBody: (node) => { if (node.kind === 'method') setEditMethodNode(node) },
    onReplaceMethodBodyWithStub: (node) => { if (node.kind === 'method') void replaceMethodBodyWithStub(node) },
    onEditResource: (node) => { void replaceResource(node) },
    onSaveResource: (node, raw) => { void saveResource(node, raw) },
    onLoadDependencies: (node, recursive) => { void loadDependencies(node, recursive) },
    onConvertModule: (node) => { void convertModule(node) },
    onRenameNamespace: (node) => setRenameNamespaceNode(node),
    onMoveTypesToEmptyNamespace: (node) => { void moveTypesToEmptyNamespace(node) },
    onSortAssemblies: () => { void sortAssemblies() },
    onRemoveAssembly: (node) => {
      // The assembly's documents go with it, so the tabs still showing them are closed here rather than
      // left pointing at nodes the backend no longer has.
      void removeModule(node).then((removedNodeIds) => {
        for (const nodeId of removedNodeIds)
          closeDocumentTabsFor(model, nodeId)
      })
    },
    onOpenContainingFolder: (node) => { if (node.description) void window.dnSpy.showItemInFolder(node.description) },
    onGoToEntryPoint: (node) => { void goToSpecialNode(node, 'entryPoint') },
    onGoToGlobalCctor: (node) => { void goToSpecialNode(node, 'globalCctor') },
    onGoToToken: (node) => { setTokenNode(node) },
    onToggleMethodBreakpoint: (name) => { void toggleFunctionBreakpoint(name) },
    onAddClassBreakpoint: (node) => { void addClassBreakpoint(node) },
    onAnalyze: (node) => { void openAnalysis(node) },
    onOpenUrl: (url) => { window.open(url, '_blank', 'noopener,noreferrer') },
    copyText: (text) => {
      void navigator.clipboard.writeText(text).catch((error: unknown) => {
        appendOutput(t('Copy failed: {message}', { message: error instanceof Error ? error.message : String(error) }))
      })
    },
    onShowModuleInfo: (node) => addSpecialTab('module-info', node),
    onOpenHex: openHex,
    onShowHexAt: showSelectionInHex,
    onHexWriteBody: (kind) => void hexWriteMethodBody(kind),
    onHexCopyBody: () => void hexCopyMethodBody(),
    onHexPasteBody: () => void hexPasteMethodBody(),
  }

  /**
   * The commands a code viewer's context menu cannot run itself. It draws the menu — dnSpy's grouping,
   * with the node the caret is on — but opening a tab, a dialog or a tool window belongs to the shell, so
   * the viewer is handed the callbacks instead of reaching for the layout model. The node each command
   * acts on is the one the menu picked, never the explorer's selection: the two are usually different.
   */
  const documentViewCommands = (): DocumentViewCommands => ({
    // dnSpy's document viewer "Open in New Tab" follows the reference under the caret, and the reference
    // goes to a tab of its own rather than the one a plain follow would reuse.
    onOpenInNewTab: (target) => { void useAppStore.getState().openReferenceTarget(target, true) },
    onStartDebug: () => setDebugProgramDialogOpen(true),
    canStartDebug: backendStatus.capabilities?.['debug.coreclr.launch'] === true,
    onShowDisassembly: () => showToolWindow('disassembly'),
    onDeleteNode: (node) => deleteSelected(node),
    onEditNode: (node) => openEditNode(node),
    onCreateMember: (kind, nested, node) => createMember(kind, nested, node),
    onEditMethodBody: (node) => { if (node.kind === 'method') setEditMethodNode(node) },
    onReplaceMethodBodyWithStub: (node) => { if (node.kind === 'method') void replaceMethodBodyWithStub(node) },
    onAnalyze: (node) => void openAnalysis(node),
    onAnalyzeReference: (target) => void analyzeReference(target),
    onOpenUrl: (url) => { window.open(url, '_blank', 'noopener,noreferrer') },
    onOpenHex: openHex,
    onShowHexAt: showSelectionInHex,
    onHexWriteBody: (kind) => void hexWriteMethodBody(kind),
    onHexCopyBody: () => void hexCopyMethodBody(),
    onHexPasteBody: () => void hexPasteMethodBody(),
  })

  /** What a tab's component draws, before the caption a docked pane wears is put round it. */
  const paneContent = (node: TabNode): React.ReactNode => {
    switch (node.getComponent()) {
      case 'explorer': return <AssemblyExplorer commands={explorerCommands} />
      case 'document': return <Suspense fallback={<div className="loading-state">{t('Loading')}</div>}><DocumentView documentId={(node.getConfig() as { documentId: string }).documentId} viewId={node.getId()} theme={theme} onNavigate={(target) => void useAppStore.getState().openReferenceTarget(target)} commands={documentViewCommands()} /></Suspense>
      case 'output': return <OutputPane />
      case 'csharp-interactive': return <CSharpInteractive theme={theme} />
      case 'search': return <SearchPane onOpenNodeId={(nodeId) => void openNodeId(nodeId)} />
      case 'analysis': return <AnalysisPane onOpenNodeId={(nodeId) => void openNodeId(nodeId)} />
      case 'hex': return <HexView moduleId={(node.getConfig() as { moduleId: string }).moduleId} />
      case 'module-info': return <ModuleInfoView moduleId={(node.getConfig() as { moduleId: string }).moduleId} />
      case 'locals': return <LocalsPane />
      case 'exception-settings': return <ExceptionSettingsPane />
      case 'watch': return <WatchPane />
      case 'callstack': return <CallStackPane />
      case 'breakpoints': return <BreakpointsPane />
      case 'bookmarks': return <BookmarksPane />
      case 'threads': return <ThreadsPane />
      case 'modules': return <ModulesPane />
      // These debugger windows do not have a backend model yet, but they still need to behave like
      // real dockable windows: opening them from Debug > Window adds a closable pane and preserves
      // the layout. The placeholder keeps the command useful until the corresponding data providers
      // are implemented.
      case 'module-breakpoints': return <DebugPlaceholder label={t('Module Breakpoints')} />
      case 'autos': return <DebugPlaceholder label={t('Autos')} />
      case 'static-fields': return <DebugPlaceholder label={t('Static Fields')} />
      case 'processes': return <DebugPlaceholder label={t('Processes')} />
      case 'memory': return <DebugPlaceholder label={t('Memory')} />
      case 'disassembly': return <DebugPlaceholder label={t('Disassembly')} />
      case 'start': return (
        <div className="start-view">
          <button className="command-button" disabled={backendStatus.state !== 'ready'} onClick={() => void chooseAndOpen()}>
            <FolderOpen size={16} /> {t('Open Assembly')}
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
        hasEmptyNamespaceSibling={hasEmptyNamespaceSibling}
        activeDocument={activeDocument}
        canShowCode={canShowCode}
        debugAvailable={backendStatus.capabilities?.['debug.coreclr.launch'] === true}
        debugState={debugState}
        recentWorkspaces={recentWorkspaces}
        canUndo={canUndo}
        canRedo={canRedo}
        theme={theme}
        onOpen={() => void chooseAndOpen()}
        onOpenRecent={(paths) => void openPaths(paths)}
        onCloseAll={closeCurrentWorkspace}
        dirty={dirty}
        onSave={() => void saveModule()}
        onSaveModule={() => void saveModuleAs()}
        onSaveAll={() => void saveAllModules()}
        onReloadAll={() => void reloadAllAssemblies()}
        onSortAssemblies={() => void sortAssemblies()}
        onFind={() => { findInActiveDocumentEditor() }}
        onSearchAssemblies={() => showToolWindow('search')}
        onUndo={() => void undoEdit()}
        onRedo={() => void redoEdit()}
        onEditMethodBody={() => { if (selectedNode?.kind === 'method') setEditMethodNode(selectedNode) }}
        onEditResource={() => { if (selectedNode) void replaceResource(selectedNode) }}
        onDelete={deleteSelected}
        onRenameNamespace={() => { if (selectedNode?.kind === 'namespace') setRenameNamespaceNode(selectedNode) }}
        onMoveTypesToEmptyNamespace={() => { if (selectedNode?.kind === 'namespace') void moveTypesToEmptyNamespace(selectedNode) }}
        onConvertModule={() => { if (selectedNode?.kind === 'module') void convertModule(selectedNode) }}
        onLoadDependencies={(recursive) => { if (selectedNode) void loadDependencies(selectedNode, recursive) }}
        onReplaceMethodBodyWithStub={() => { if (selectedNode?.kind === 'method') void replaceMethodBodyWithStub(selectedNode) }}
        hexTarget={hexTarget}
        hexStatement={hexStatement}
        onOpenHex={openHex}
        onShowHexAt={showSelectionInHex}
        onHexWriteBody={(kind) => void hexWriteMethodBody(kind)}
        onHexCopyBody={() => void hexCopyMethodBody()}
        onHexPasteBody={() => void hexPasteMethodBody()}
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
        onStopDebug={() => void stopDebug()}
        canToggleBreakpoint={Boolean(breakpointTarget)}
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
        onShowDisassembly={() => showToolWindow('disassembly')}
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
        onMoveToNextTabGroup={() => moveActiveTabToGroup(1, false)}
        onMoveAllToNextTabGroup={() => moveActiveTabToGroup(1, true)}
        canMoveToPreviousTabGroup={currentWindowGroupIndex > 0}
        canMoveAllToPreviousTabGroup={currentWindowGroup instanceof TabSetNode && currentWindowGroup.getTabNodes().length > 1 && currentWindowGroupIndex > 0}
        onMoveToPreviousTabGroup={() => moveActiveTabToGroup(-1, false)}
        onMoveAllToPreviousTabGroup={() => moveActiveTabToGroup(-1, true)}
        canCloseAllTabs={windowTabs.some((tab) => model.getNodeById(tab.id)?.isCloseable())}
        onCloseAllTabs={() => { closeAllDocumentTabs(model); refreshLayout() }}
        canCloseTabGroup={hasOtherWindowGroup}
        onCloseTabGroup={closeActiveTabGroup}
        canCloseAllTabGroupsButThis={hasOtherWindowGroup}
        onCloseAllTabGroupsButThis={closeOtherTabGroups}
        canMoveTabGroupAfterNext={currentWindowGroupIndex >= 0 && currentWindowGroupIndex < windowGroups.length - 1}
        onMoveTabGroupAfterNext={() => moveActiveGroup(true)}
        canMoveTabGroupBeforePrevious={currentWindowGroupIndex > 0}
        onMoveTabGroupBeforePrevious={() => moveActiveGroup(false)}
        canMergeAllTabGroups={hasOtherWindowGroup}
        onMergeAllTabGroups={mergeTabGroups}
        canUseVerticalTabGroups={hasOtherWindowGroup && windowGroupsAreHorizontal}
        onUseVerticalTabGroups={() => arrangeTabGroups(false)}
        canUseHorizontalTabGroups={hasOtherWindowGroup && !windowGroupsAreHorizontal}
        onUseHorizontalTabGroups={() => arrangeTabGroups(true)}
        onShowWindowsDialog={() => setWindowsDialogOpen(true)}
        visibleToolWindows={visibleToolWindows}
        onTheme={setTheme}
        wordWrap={wordWrap}
        highlightCurrentLine={highlightCurrentLine}
        fullScreen={fullScreen}
        elevated={elevated}
        onToggleWordWrap={() => setWordWrap(!wordWrap)}
        onToggleHighlightCurrentLine={() => setHighlightCurrentLine(!highlightCurrentLine)}
        onToggleFullScreen={() => void window.dnSpy.toggleFullScreen()}
        onSetLanguage={setLanguage}
        onAbout={() => setAboutDialogOpen(true)}
        onRestartAsAdministrator={restartAsAdministrator}
        onQuit={() => void window.dnSpy.quit()}
        onShowOptions={(category) => setOptionsDialogCategory(category ?? 'environment')}
      />
      <ToolBar
        hasWorkspace={Boolean(workspaceId)} busy={busy} onOpen={() => void chooseAndOpen()} onSave={() => void saveModuleAs()} onSearch={() => showToolWindow('search')}
        canGoBack={navigation.index > 0} canGoForward={navigation.index >= 0 && navigation.index < navigation.items.length - 1} onBack={goBack} onForward={goForward}
        canUndo={canUndo} canRedo={canRedo} onUndo={() => void undoEdit()} onRedo={() => void redoEdit()}
        decompilerLanguage={activeDocumentLanguage} onLanguageChange={(language) => { if (activeDocumentId) void changeDocumentLanguage(activeDocumentId, language) }}
        debugAvailable={backendStatus.capabilities?.['debug.coreclr.launch'] === true} debugState={debugState}
        onStart={() => setDebugProgramDialogOpen(true)} onContinue={() => void continueDebug()} onPause={() => void pauseDebug()}
        onRestart={() => { void stopDebug().then(() => setDebugProgramDialogOpen(true)) }}
        onShowNextStatement={() => void revealStoppedLocation()} onStepInto={() => void stepDebug('stepIn')}
        onStepOver={() => void stepDebug('next')} onStepOut={() => void stepDebug('stepOut')} onStop={() => void stopDebug()}
      />
      {error && (
        <div className="error-banner" role="alert">
          <AlertCircle size={15} />
          <span>{error}</span>
          <button className="icon-button" aria-label={t('Dismiss')} onClick={clearError}><X size={14} /></button>
        </div>
      )}
      <main className="workspace-host">
        <Layout
          model={model}
          factory={factory}
          onModelChange={(nextModel) => {
            localStorage.setItem(layoutStorageKey, JSON.stringify(nextModel.toJson()))
            // Every layout change comes through here, which makes it the one place that knows the tab
            // order — and the tab order is part of the session the next run restores.
            const { order, active } = orderedDocumentKeys(nextModel)
            setDocumentOrder(order, active)
            forceLayoutUpdate((value) => value + 1)
          }}
          onContextMenu={(node, event) => {
            if (!(node instanceof TabNode)) return
            showDocumentTabContextMenu(node, event, {
              t,
              canSave: (tab) => {
                if (tab.getComponent() !== 'document') return false
                const config = tab.getConfig() as { documentId?: string } | undefined
                const state = useAppStore.getState()
                const document = config?.documentId ? state.documents[config.documentId] : undefined
                return Boolean(document && !document.loading && !state.busy)
              },
              canClone: (tab) => tab.getComponent() === 'document',
              onSave: (tab) => {
                const config = tab.getConfig() as { documentId?: string } | undefined
                if (config?.documentId) void saveCode(config.documentId)
              },
              onModelChanged: () => forceLayoutUpdate((value) => value + 1),
            })
          }}
          i18nTranslator={(key) => t(I18nLabelDefaults[key] ?? key)}
        />
      </main>
      <footer className="status-bar">
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
      {editMethodNode && <MethodBodyEditor node={editMethodNode} onClose={() => setEditMethodNode(undefined)} />}
      {tokenNode && <GoToTokenDialog node={tokenNode} onClose={() => setTokenNode(undefined)} />}
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
      {aboutDialogOpen && <AboutDialog onClose={() => setAboutDialogOpen(false)} />}
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
