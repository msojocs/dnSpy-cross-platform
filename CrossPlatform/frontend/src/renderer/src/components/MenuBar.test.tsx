import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MenuBar } from './MenuBar'

type DebugState = 'inactive' | 'starting' | 'running' | 'stopped'
type MenuBarProps = ComponentProps<typeof MenuBar>

const baseProps = (breakpoints: { canToggle?: boolean; onToggle?: () => void; items?: { name: string; enabled: boolean }[] } = {}): MenuBarProps => ({
  hasWorkspace: true,
  hasModule: true,
  selectionKind: undefined,
  selectionLabel: undefined,
  hasEmptyNamespaceSibling: false,
  activeDocument: null,
  canShowCode: false,
  debugAvailable: false,
  debugState: 'inactive',
  recentWorkspaces: [],
  canUndo: false,
  canRedo: false,
  theme: 'dark',
  wordWrap: false,
  highlightCurrentLine: true,
  fullScreen: false,
  elevated: false,
  onOpen: vi.fn(),
  onOpenRecent: vi.fn(),
  onCloseAll: vi.fn(),
  dirty: false,
  onSave: vi.fn(),
  onSaveModule: vi.fn(),
  onSaveAll: vi.fn(),
  onReloadAll: vi.fn(),
  onSortAssemblies: vi.fn(),
  onFind: vi.fn(),
  onSearchAssemblies: vi.fn(),
  onUndo: vi.fn(),
  onRedo: vi.fn(),
  onEditMethodBody: vi.fn(),
  onEditResource: vi.fn(),
  onDelete: vi.fn(),
  onRenameNamespace: vi.fn(),
  onMoveTypesToEmptyNamespace: vi.fn(),
  onConvertModule: vi.fn(),
  onLoadDependencies: vi.fn(),
  onReplaceMethodBodyWithStub: vi.fn(),
  onOpenHex: vi.fn(),
  onShowHexAt: vi.fn(),
  onHexWriteBody: vi.fn(),
  onHexCopyBody: vi.fn(),
  onHexPasteBody: vi.fn(),
  onCreateMember: vi.fn(),
  onEditNode: vi.fn(),
  onShowCode: vi.fn(),
  onCollapseTreeViewNodes: vi.fn(),
  onStartDebug: vi.fn(),
  onAttachDebug: vi.fn(),
  onContinueDebug: vi.fn(),
  onPauseDebug: vi.fn(),
  onStepIn: vi.fn(),
  onStepOver: vi.fn(),
  onStepOut: vi.fn(),
  onStopDebug: vi.fn(),
  canToggleBreakpoint: breakpoints.canToggle ?? false,
  hasFunctionBreakpoints: (breakpoints.items ?? []).length > 0,
  canEnableAllBreakpoints: (breakpoints.items ?? []).some((item) => !item.enabled),
  canDisableAllBreakpoints: (breakpoints.items ?? []).some((item) => item.enabled),
  onToggleBreakpoint: breakpoints.onToggle ?? vi.fn(),
  onDeleteAllBreakpoints: vi.fn(),
  onEnableAllBreakpoints: vi.fn(),
  onDisableAllBreakpoints: vi.fn(),
  visibleToolWindows: new Set(['explorer', 'output', 'locals', 'watch', 'callstack', 'breakpoints', 'threads', 'modules']),
  onShowExplorer: vi.fn(),
  onShowOutput: vi.fn(),
  onShowCSharpInteractive: vi.fn(),
  bookmarksCount: 0,
  canEnableAllBookmarks: false,
  canDisableAllBookmarks: false,
  onShowBookmarks: vi.fn(),
  onToggleBookmark: vi.fn(),
  onEnableBookmark: vi.fn(),
  onEnableAllBookmarks: vi.fn(),
  onDisableAllBookmarks: vi.fn(),
  onPreviousBookmark: vi.fn(),
  onNextBookmark: vi.fn(),
  onPreviousBookmarkWithSameLabel: vi.fn(),
  onNextBookmarkWithSameLabel: vi.fn(),
  onPreviousBookmarkInDocument: vi.fn(),
  onNextBookmarkInDocument: vi.fn(),
  onClearBookmarks: vi.fn(),
  onClearBookmarksInDocument: vi.fn(),
  onShowModuleBreakpoints: vi.fn(),
  onShowExceptionSettings: vi.fn(),
  onShowAutos: vi.fn(),
  onShowStaticFields: vi.fn(),
  onShowProcesses: vi.fn(),
  onShowMemory: vi.fn(),
  onShowDisassembly: vi.fn(),
  onShowLocals: vi.fn(),
  onShowWatch: vi.fn(),
  onShowCallStack: vi.fn(),
  onShowBreakpoints: vi.fn(),
  onShowThreads: vi.fn(),
  onShowModules: vi.fn(),
  onTheme: vi.fn(),
  onToggleWordWrap: vi.fn(),
  onToggleHighlightCurrentLine: vi.fn(),
  onToggleFullScreen: vi.fn(),
  onSetLanguage: vi.fn(),
  onAbout: vi.fn(),
  onRestartAsAdministrator: vi.fn(),
  onQuit: vi.fn(),
  onShowOptions: vi.fn(),
})

const renderMenu = (
  debugAvailable = false,
  onAbout = vi.fn(),
  debugState: DebugState = 'inactive',
  onShowOptions = vi.fn(),
  breakpoints: { canToggle?: boolean; onToggle?: () => void; items?: { name: string; enabled: boolean }[] } = {},
): void => {
  render(<MenuBar {...baseProps(breakpoints)} debugAvailable={debugAvailable} debugState={debugState} onAbout={onAbout} onShowOptions={onShowOptions} />)
}

/** Render with a few props swapped out — for tests that only care about one menu entry. */
const renderMenuWith = (overrides: Partial<MenuBarProps>): void => {
  render(<MenuBar {...baseProps()} {...overrides} />)
}

/** Opens the View menu and hovers its Bookmarks entry, leaving the submenu on screen. */
const openBookmarksMenu = (): void => {
  if (!screen.queryByRole('menuitem', { name: /^Bookmarks Window/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))
  fireEvent.pointerEnter(screen.getByRole('menuitem', { name: /^Bookmarks$/ }))
}

/** The labels of the open top-level popup, in render order. */
const openMenu = (name: string): string[] => {
  fireEvent.click(screen.getByRole('menuitem', { name }))
  return within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent ?? '')
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('MenuBar', () => {
  it('mirrors the upstream File menu layout', () => {
    // Nothing modified and nothing recently opened, which is the state that greys Save, Save All and
    // Recent Files. The commands dnSpy has and this port does not stay in place, disabled.
    renderMenuWith({ dirty: false })
    expect(openMenu('File')).toEqual([
      'Export to Project...',
      'SaveCtrl+S',
      'Save Module...',
      'Save All...Ctrl+Shift+S',
      'Open...Ctrl+O',
      'Open from GAC...Ctrl+Shift+O',
      'Open List...',
      'Recent Files',
      'Reload All Assemblies',
      'Close All',
      'Close Old In-Memory Modules',
      'Close All Framework Assemblies',
      'Close All Missing Files',
      'Sort Assemblies',
      'Restart as Administrator',
      'ExitAlt+F4',
    ])
    for (const name of [/^Export to Project/, /^SaveCtrl/, /^Save All/, /^Open from GAC/, /^Open List/, /^Recent Files/, /^Close Old In-Memory/, /^Close All Framework/, /^Close All Missing/])
      expect(screen.getByRole('menuitem', { name })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: /^Open\.\.\./ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Save Module\.\.\./ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Reload All Assemblies/ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Close All$/ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Sort Assemblies/ })).toBeEnabled()
    // dnSpy never greys the restart entry — it is clickable or not there at all.
    expect(screen.getByRole('menuitem', { name: /^Restart as Administrator/ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Exit/ })).toBeEnabled()
  })

  it('drops the restart entry altogether once the app is already elevated', () => {
    // dnSpy's IsVisible: RestartAsAdministratorCommand is shown only while not running as admin.
    render(<MenuBar {...baseProps()} elevated={true} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
    expect(screen.queryByRole('menuitem', { name: /^Restart as Administrator/ })).not.toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Exit/ })).toBeEnabled()
  })

  it('asks the app to restart with elevation when the entry is chosen', () => {
    const onRestartAsAdministrator = vi.fn()
    render(<MenuBar {...baseProps()} onRestartAsAdministrator={onRestartAsAdministrator} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Restart as Administrator/ }))
    expect(onRestartAsAdministrator).toHaveBeenCalledOnce()
  })

  it('enables Save and Save All only once something is modified', () => {
    renderMenuWith({ dirty: true })
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
    expect(screen.getByRole('menuitem', { name: /^SaveCtrl/ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Save All/ })).toBeEnabled()
  })

  it('lists the recent workspaces under the Recent Files submenu', () => {
    const onOpenRecent = vi.fn()
    renderMenuWith({ recentWorkspaces: [['/tmp/a/One.dll'], ['/tmp/b/Two.dll', '/tmp/b/Three.dll']], onOpenRecent })
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
    expect(screen.getByRole('menuitem', { name: /^Recent Files/ })).toBeEnabled()
    fireEvent.pointerEnter(screen.getByRole('menuitem', { name: /^Recent Files/ }))
    const submenu = screen.getAllByRole('menu')[1]
    expect(within(submenu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['1  One.dll', '2  Two.dll +1'])
    fireEvent.click(within(submenu).getByRole('menuitem', { name: /Two\.dll/ }))
    expect(onOpenRecent).toHaveBeenCalledWith(['/tmp/b/Two.dll', '/tmp/b/Three.dll'])
  })

  it('enables CoreCLR commands only when the backend reports support', () => {
    renderMenu(false)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Debug' }))
    expect(screen.getByRole('menuitem', { name: /^Start Debugging/ })).toBeDisabled()

    cleanup()
    renderMenu(true)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Debug' }))
    expect(screen.getByRole('menuitem', { name: /^Start Debugging/ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: 'Attach to Process...' })).toBeEnabled()
  })

  it('hides Window commands whose WPF CanExecute value is false', () => {
    renderMenuWith({
      canNewWindow: false,
      canCloseWindow: false,
      canNewHorizontalTabGroup: false,
      canNewVerticalTabGroup: false,
      canMoveToNextTabGroup: false,
      canMoveToPreviousTabGroup: false,
      canCloseTabGroup: false,
      canCloseAllTabGroupsButThis: false,
      canMoveTabGroupAfterNext: false,
      canMoveTabGroupBeforePrevious: false,
      canMergeAllTabGroups: false,
      canUseVerticalTabGroups: false,
      canUseHorizontalTabGroups: false,
    })
    // Like the WPF menu, New Window and Close stay visible and are merely disabled; Close All Tabs
    // stays visible too (its WPF IsVisible always returns true) even when the rest of the tab-group
    // commands are gone — this is the single-tab-in-a-single-group state.
    const hiddenMenu = openMenu('Window')
    expect(hiddenMenu).toEqual(['New WindowCtrl+N', 'CloseCtrl+F4', 'Close All Tabs'])
    expect(screen.getByRole('menuitem', { name: /^New Window/ })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: /^CloseCtrl/ })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Close All Tabs' })).toBeDisabled()

    cleanup()
    renderMenuWith({
      canCloseWindow: true,
      canNewHorizontalTabGroup: true,
      canNewVerticalTabGroup: true,
      canMoveToNextTabGroup: true,
      canMoveToPreviousTabGroup: true,
      canCloseTabGroup: true,
      canCloseAllTabGroupsButThis: true,
      canMoveTabGroupAfterNext: true,
      canMoveTabGroupBeforePrevious: true,
      canMergeAllTabGroups: true,
      canUseVerticalTabGroups: true,
      canUseHorizontalTabGroups: true,
    })
    const visibleMenu = openMenu('Window')
    expect(visibleMenu).toContain('CloseCtrl+F4')
    expect(visibleMenu).toContain('New Horizontal Tab Group')
    expect(visibleMenu).toContain('Move All to Previous Tab Group')
    expect(visibleMenu).toContain('Merge All Tab Groups')
    expect(visibleMenu).toContain('Use Horizontal Tab Groups')
  })

  it('mirrors the upstream View menu layout', () => {
    renderMenu()
    // Upstream sorts the View menu by group and then by item order, so the options come first
    // (Word Wrap … Collapse Tree View Nodes, Theme, Language), then the tool windows — Bookmarks,
    // at order 40, is the last of those — and then Options.
    expect(openMenu('View')).toEqual([
      'Word WrapCtrl+E, Ctrl+W',
      'Highlight Current Line',
      'Full ScreenShift+Alt+Enter',
      'Collapse Tree View NodesCtrl+Shift+P',
      'Theme',
      'Language',
      'CodeCtrl+Alt+0',
      'Assembly ExplorerCtrl+Alt+L',
      'OutputAlt+2',
      'C# InteractiveCtrl+Alt+N',
      'Bookmarks',
      'Options...',
    ])
    // Items that exist only in the cross-platform build must not leak back in.
    expect(screen.queryByRole('menuitem', { name: /^Search/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Analyzer/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Hex View/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Module Information/ })).not.toBeInTheDocument()
  })

  it('orders the Theme submenu like upstream and marks the active theme', () => {
    renderMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))
    fireEvent.pointerEnter(screen.getByRole('menuitem', { name: /^Theme$/ }))
    // The submenu is the second `role="menu"` in document order, nested inside the View popup.
    const entries = within(screen.getAllByRole('menu')[1]).getAllByRole('menuitem')
    expect(entries.map((item) => item.textContent)).toEqual(['Blue', 'Dark', 'Light', 'High Contrast'])
    expect(entries[0].getAttribute('aria-checked')).toBe('false')
    expect(entries[1].getAttribute('aria-checked')).toBe('true')
  })

  it('leaves Code disabled until a document tab is active', () => {
    renderMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))
    expect(screen.getByRole('menuitem', { name: /^Code/ })).toBeDisabled()
  })

  it('lists the bookmark commands with their chords', () => {
    renderMenuWith({ bookmarksCount: 2, canEnableAllBookmarks: true, canDisableAllBookmarks: true })
    openBookmarksMenu()
    const entries = within(screen.getAllByRole('menu')[1]).getAllByRole('menuitem')
    expect(entries.map((item) => item.textContent)).toEqual([
      'Bookmarks WindowCtrl+K, Ctrl+W',
      'Toggle BookmarkCtrl+K, Ctrl+K',
      'Enable All Bookmarks',
      'Enable/Disable BookmarkCtrl+K, Ctrl+E',
      'Previous BookmarkCtrl+K, Ctrl+P',
      'Next BookmarkCtrl+K, Ctrl+N',
      'Clear BookmarksCtrl+K, Ctrl+L',
      'Previous Bookmark With Same Label',
      'Next Bookmark With Same Label',
      'Previous Bookmark In Document',
      'Next Bookmark In Document',
      'Clear All Bookmarks In Document',
    ])
    // The window entry is checked while its tab is open, the way the other tool windows are shown.
    fireEvent.pointerEnter(screen.getByRole('menuitem', { name: /^Bookmarks Window/ }))
    expect(entries[0].getAttribute('aria-checked')).toBe('false')
  })

  it('offers one Enable/Disable All entry, reading the way upstream writes it', () => {
    // Everything is on, so the one entry offers to turn the lot off…
    renderMenuWith({ bookmarksCount: 2, canEnableAllBookmarks: false, canDisableAllBookmarks: true })
    openBookmarksMenu()
    const menu = () => screen.getAllByRole('menu')[1]
    const enableDisableAll = (): HTMLElement | undefined => within(menu()).queryAllByRole('menuitem')
      .find((item) => /^(Enable|Disable) All Bookmarks$/.test(item.textContent ?? ''))
    expect(enableDisableAll()?.textContent).toBe('Disable All Bookmarks')

    // …and with nothing to enable, upstream leaves the entry out entirely.
    cleanup()
    renderMenuWith({ bookmarksCount: 0, canEnableAllBookmarks: false, canDisableAllBookmarks: false })
    openBookmarksMenu()
    expect(enableDisableAll()).toBeUndefined()
  })

  it('disables the bookmark navigation while there are no bookmarks', () => {
    renderMenuWith({ bookmarksCount: 0 })
    openBookmarksMenu()
    const menu = screen.getAllByRole('menu')[1]
    expect(within(menu).getByRole('menuitem', { name: /^Next BookmarkCtrl/ })).toBeDisabled()
    expect(within(menu).getByRole('menuitem', { name: /^Clear BookmarksCtrl/ })).toBeDisabled()
    expect(within(menu).getByRole('menuitem', { name: /^Toggle BookmarkCtrl/ })).toBeEnabled()
  })

  it('runs the bookmark commands from the View menu', () => {
    const onToggleBookmark = vi.fn()
    const onNextBookmark = vi.fn()
    const onShowBookmarks = vi.fn()
    renderMenuWith({ bookmarksCount: 1, onToggleBookmark, onNextBookmark, onShowBookmarks })
    openBookmarksMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /^Toggle BookmarkCtrl/ }))
    // Picking an entry closes the whole popup, so it has to be opened again for the next one.
    openBookmarksMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /^Next BookmarkCtrl/ }))
    openBookmarksMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /^Bookmarks WindowCtrl/ }))
    expect(onToggleBookmark).toHaveBeenCalledOnce()
    expect(onNextBookmark).toHaveBeenCalledOnce()
    expect(onShowBookmarks).toHaveBeenCalledOnce()
  })

  it('invokes the Code handler once a document tab is active', () => {
    const onShowCode = vi.fn()
    renderMenuWith({ canShowCode: true, onShowCode })
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))
    const code = screen.getByRole('menuitem', { name: /^Code/ })
    expect(code).toBeEnabled()
    fireEvent.click(code)
    expect(onShowCode).toHaveBeenCalledOnce()
  })

  it('invokes the C# Interactive handler from the View menu', () => {
    const onShowCSharpInteractive = vi.fn()
    renderMenuWith({ onShowCSharpInteractive })
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^C# Interactive/ }))
    expect(onShowCSharpInteractive).toHaveBeenCalledOnce()
  })

  it('invokes the collapse handler from the View menu', () => {
    const onCollapseTreeViewNodes = vi.fn()
    renderMenuWith({ onCollapseTreeViewNodes })
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Collapse Tree View Nodes/ }))
    expect(onCollapseTreeViewNodes).toHaveBeenCalledOnce()
  })

  it('shows only the always-available tool windows before debugging starts', () => {
    renderMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Debug' }))
    const windows = screen.getByRole('menuitem', { name: 'Window' })
    fireEvent.pointerEnter(windows)
    // Upstream keeps Breakpoints, Module Breakpoints, Exception Settings and Output in the
    // Windows submenu even before a debug session exists.
    expect(screen.getByRole('menuitem', { name: /^Breakpoints/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Module Breakpoints/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Exception Settings/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Output/ })).toBeInTheDocument()
    // Debug-only tool windows (Watch, Memory, Disassembly, etc.) must stay hidden.
    expect(screen.queryByRole('menuitem', { name: /^Watch/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Autos/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Locals/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /^Static Fields/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /^Call Stack/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /^Threads/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /^Modules/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /^Processes/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /^Memory/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /^Disassembly/ })).toBeNull()
    // Stepping / pause / stop controls only show while a debug session is active.
    fireEvent.pointerLeave(windows)
    expect(screen.queryByRole('menuitem', { name: /^Pause/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Step Into/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Step Over/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Stop Debugging/ })).not.toBeInTheDocument()
  })

  it('mirrors the upstream Debug → Windows menu layout while debugging', () => {
    renderMenu(false, vi.fn(), 'stopped')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Debug' }))
    const windows = screen.getByRole('menuitem', { name: 'Window' })
    fireEvent.pointerEnter(windows)
    // Upstream Debug → Windows menu has 14 entries (4 settings + 4 values + 4 info + 2 memory).
    expect(screen.getByRole('menuitem', { name: /^Breakpoints/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Module Breakpoints/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Exception Settings/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Output/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Watch/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Autos/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Locals/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Static Fields/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Call Stack/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Threads/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Modules/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Processes/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Memory/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Disassembly/ })).toBeInTheDocument()
    // Pause / Step / Stop controls become available during a debug session.
    fireEvent.pointerLeave(windows)
    expect(screen.getByRole('menuitem', { name: /^Pause/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Step Into/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Step Over/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Stop Debugging/ })).toBeInTheDocument()
  })

  it('marks currently visible tool windows in the Debug → Window submenu', () => {
    renderMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Debug' }))
    const windows = screen.getByRole('menuitem', { name: 'Window' })
    fireEvent.pointerEnter(windows)
    expect(screen.getByRole('menuitem', { name: /^Output/ }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitem', { name: /^Breakpoints/ }).getAttribute('aria-checked')).toBe('true')
  })

  it('exposes individual callbacks to re-open each closable tool window', () => {
    const onShowOutput = vi.fn()
    const onShowLocals = vi.fn()
    const onShowWatch = vi.fn()
    const onShowCallStack = vi.fn()
    const onShowBreakpoints = vi.fn()
    const onShowThreads = vi.fn()
    const onShowModules = vi.fn()
    const onShowModuleBreakpoints = vi.fn()
    const onShowExceptionSettings = vi.fn()
    const onShowAutos = vi.fn()
    const onShowStaticFields = vi.fn()
    const onShowProcesses = vi.fn()
    const onShowMemory = vi.fn()
    const onShowDisassembly = vi.fn()
    render(<MenuBar
      hasWorkspace={true}
      hasModule={true}
      selectionKind={undefined}
      selectionLabel={undefined}
      hasEmptyNamespaceSibling={false}
      activeDocument={null}
      canShowCode={true}
      debugAvailable={false}
      debugState="stopped"
      recentWorkspaces={[]}
      canUndo={false}
      canRedo={false}
      theme="dark"
      wordWrap={false}
      highlightCurrentLine={true}
      fullScreen={false}
      elevated={false}
      visibleToolWindows={new Set(['explorer'])}
      onOpen={vi.fn()}
      onOpenRecent={vi.fn()}
      onCloseAll={vi.fn()}
      dirty={false}
      onSave={vi.fn()}
      onSaveModule={vi.fn()}
      onSaveAll={vi.fn()}
      onReloadAll={vi.fn()}
      onSortAssemblies={vi.fn()}
      onFind={vi.fn()}
      onSearchAssemblies={vi.fn()}
      onUndo={vi.fn()}
      onRedo={vi.fn()}
      onEditMethodBody={vi.fn()}
      onEditResource={vi.fn()}
      onDelete={vi.fn()}
      onRenameNamespace={vi.fn()}
      onMoveTypesToEmptyNamespace={vi.fn()}
      onConvertModule={vi.fn()}
      onLoadDependencies={vi.fn()}
      onReplaceMethodBodyWithStub={vi.fn()}
      onOpenHex={vi.fn()}
      onShowHexAt={vi.fn()}
      onHexWriteBody={vi.fn()}
      onHexCopyBody={vi.fn()}
      onHexPasteBody={vi.fn()}
      onCreateMember={vi.fn()}
      onEditNode={vi.fn()}
      onShowCode={vi.fn()}
      onCollapseTreeViewNodes={vi.fn()}
      onStartDebug={vi.fn()}
      onAttachDebug={vi.fn()}
      onContinueDebug={vi.fn()}
      onPauseDebug={vi.fn()}
      onStepIn={vi.fn()}
      onStepOver={vi.fn()}
      onStepOut={vi.fn()}
      onStopDebug={vi.fn()}
      canToggleBreakpoint={false}
      hasFunctionBreakpoints={false}
      canEnableAllBreakpoints={false}
      canDisableAllBreakpoints={false}
      onToggleBreakpoint={vi.fn()}
      onDeleteAllBreakpoints={vi.fn()}
      onEnableAllBreakpoints={vi.fn()}
      onDisableAllBreakpoints={vi.fn()}
      onShowExplorer={vi.fn()}
      onShowOutput={onShowOutput}
      onShowCSharpInteractive={vi.fn()}
      onShowModuleBreakpoints={onShowModuleBreakpoints}
      onShowExceptionSettings={onShowExceptionSettings}
      onShowAutos={onShowAutos}
      onShowStaticFields={onShowStaticFields}
      onShowProcesses={onShowProcesses}
      onShowMemory={onShowMemory}
      onShowDisassembly={onShowDisassembly}
      onShowLocals={onShowLocals}
      onShowWatch={onShowWatch}
      onShowCallStack={onShowCallStack}
      onShowBreakpoints={onShowBreakpoints}
      onShowThreads={onShowThreads}
      onShowModules={onShowModules}
      bookmarksCount={0}
      canEnableAllBookmarks={false}
      canDisableAllBookmarks={false}
      onShowBookmarks={vi.fn()}
      onToggleBookmark={vi.fn()}
      onEnableBookmark={vi.fn()}
      onEnableAllBookmarks={vi.fn()}
      onDisableAllBookmarks={vi.fn()}
      onPreviousBookmark={vi.fn()}
      onNextBookmark={vi.fn()}
      onPreviousBookmarkWithSameLabel={vi.fn()}
      onNextBookmarkWithSameLabel={vi.fn()}
      onPreviousBookmarkInDocument={vi.fn()}
      onNextBookmarkInDocument={vi.fn()}
      onClearBookmarks={vi.fn()}
      onClearBookmarksInDocument={vi.fn()}
      onTheme={vi.fn()}
      onToggleWordWrap={vi.fn()}
      onToggleHighlightCurrentLine={vi.fn()}
      onToggleFullScreen={vi.fn()}
      onSetLanguage={vi.fn()}
      onAbout={vi.fn()}
      onRestartAsAdministrator={vi.fn()}
      onQuit={vi.fn()}
      onShowOptions={vi.fn()}
    />)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Debug' }))
    const windows = screen.getByRole('menuitem', { name: 'Window' })
    fireEvent.pointerEnter(windows)
    const labels = ['Breakpoints', 'Module Breakpoints', 'Exception Settings', 'Output', 'Watch', 'Autos', 'Locals', 'Static Fields', 'Call Stack', 'Threads', 'Modules', 'Processes', 'Memory', 'Disassembly']
    const callbacks = [
      onShowBreakpoints,
      onShowModuleBreakpoints,
      onShowExceptionSettings,
      onShowOutput,
      onShowWatch,
      onShowAutos,
      onShowLocals,
      onShowStaticFields,
      onShowCallStack,
      onShowThreads,
      onShowModules,
      onShowProcesses,
      onShowMemory,
      onShowDisassembly,
    ]
    labels.forEach((label, index) => {
      const item = screen.getByRole('menuitem', { name: new RegExp('^' + label) })
      expect(item.getAttribute('aria-checked')).not.toBe('true')
      fireEvent.click(item)
      expect(callbacks[index]).toHaveBeenCalledOnce()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Debug' }))
      fireEvent.pointerEnter(screen.getByRole('menuitem', { name: 'Window' }))
    })
  })

  it('exposes View toggles in their checked state', () => {
    render(<MenuBar
      hasWorkspace={true}
      hasModule={true}
      selectionKind={undefined}
      selectionLabel={undefined}
      hasEmptyNamespaceSibling={false}
      activeDocument={null}
      canShowCode={true}
      debugAvailable={false}
      debugState="inactive"
      recentWorkspaces={[]}
      canUndo={false}
      canRedo={false}
      theme="dark"
      wordWrap={true}
      highlightCurrentLine={true}
      fullScreen={true}
      elevated={false}
      onOpen={vi.fn()}
      onOpenRecent={vi.fn()}
      onCloseAll={vi.fn()}
      dirty={false}
      onSave={vi.fn()}
      onSaveModule={vi.fn()}
      onSaveAll={vi.fn()}
      onReloadAll={vi.fn()}
      onSortAssemblies={vi.fn()}
      onFind={vi.fn()}
      onSearchAssemblies={vi.fn()}
      onUndo={vi.fn()}
      onRedo={vi.fn()}
      onEditMethodBody={vi.fn()}
      onEditResource={vi.fn()}
      onDelete={vi.fn()}
      onRenameNamespace={vi.fn()}
      onMoveTypesToEmptyNamespace={vi.fn()}
      onConvertModule={vi.fn()}
      onLoadDependencies={vi.fn()}
      onReplaceMethodBodyWithStub={vi.fn()}
      onOpenHex={vi.fn()}
      onShowHexAt={vi.fn()}
      onHexWriteBody={vi.fn()}
      onHexCopyBody={vi.fn()}
      onHexPasteBody={vi.fn()}
      onCreateMember={vi.fn()}
      onEditNode={vi.fn()}
      onShowCode={vi.fn()}
      onCollapseTreeViewNodes={vi.fn()}
      onStartDebug={vi.fn()}
      onAttachDebug={vi.fn()}
      onContinueDebug={vi.fn()}
      onPauseDebug={vi.fn()}
      onStepIn={vi.fn()}
      onStepOver={vi.fn()}
      onStepOut={vi.fn()}
      onStopDebug={vi.fn()}
      canToggleBreakpoint={false}
      hasFunctionBreakpoints={false}
      canEnableAllBreakpoints={false}
      canDisableAllBreakpoints={false}
      onToggleBreakpoint={vi.fn()}
      onDeleteAllBreakpoints={vi.fn()}
      onEnableAllBreakpoints={vi.fn()}
      onDisableAllBreakpoints={vi.fn()}
      visibleToolWindows={new Set(['explorer', 'output', 'locals', 'watch', 'callstack', 'breakpoints', 'threads', 'modules'])}
      onShowExplorer={vi.fn()}
      onShowOutput={vi.fn()}
      onShowCSharpInteractive={vi.fn()}
      onShowModuleBreakpoints={vi.fn()}
      onShowExceptionSettings={vi.fn()}
      onShowAutos={vi.fn()}
      onShowStaticFields={vi.fn()}
      onShowProcesses={vi.fn()}
      onShowMemory={vi.fn()}
      onShowDisassembly={vi.fn()}
      onShowLocals={vi.fn()}
      onShowWatch={vi.fn()}
      onShowCallStack={vi.fn()}
      onShowBreakpoints={vi.fn()}
      onShowThreads={vi.fn()}
      onShowModules={vi.fn()}
      bookmarksCount={0}
      canEnableAllBookmarks={false}
      canDisableAllBookmarks={false}
      onShowBookmarks={vi.fn()}
      onToggleBookmark={vi.fn()}
      onEnableBookmark={vi.fn()}
      onEnableAllBookmarks={vi.fn()}
      onDisableAllBookmarks={vi.fn()}
      onPreviousBookmark={vi.fn()}
      onNextBookmark={vi.fn()}
      onPreviousBookmarkWithSameLabel={vi.fn()}
      onNextBookmarkWithSameLabel={vi.fn()}
      onPreviousBookmarkInDocument={vi.fn()}
      onNextBookmarkInDocument={vi.fn()}
      onClearBookmarks={vi.fn()}
      onClearBookmarksInDocument={vi.fn()}
      onTheme={vi.fn()}
      onToggleWordWrap={vi.fn()}
      onToggleHighlightCurrentLine={vi.fn()}
      onToggleFullScreen={vi.fn()}
      onSetLanguage={vi.fn()}
      onAbout={vi.fn()}
      onRestartAsAdministrator={vi.fn()}
      onQuit={vi.fn()}
      onShowOptions={vi.fn()}
    />)

    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))
    const wordWrap = screen.getByRole('menuitem', { name: /^Word Wrap/ })
    const highlight = screen.getByRole('menuitem', { name: /^Highlight Current Line/ })
    const fullScreen = screen.getByRole('menuitem', { name: /^Full Screen/ })
    expect(wordWrap.getAttribute('aria-checked')).toBe('true')
    expect(highlight.getAttribute('aria-checked')).toBe('true')
    // Upstream keeps the "Full Screen" label in both states and only toggles the check mark.
    expect(fullScreen.getAttribute('aria-checked')).toBe('true')
    expect(fullScreen).toHaveTextContent('Full Screen')
    expect(screen.queryByRole('menuitem', { name: /Exit Full Screen/ })).not.toBeInTheDocument()
  })

  it('opens the About dialog from the Help menu', () => {
    const onAbout = vi.fn()
    renderMenu(false, onAbout)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Help' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'About dnSpy' }))

    expect(onAbout).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menuitem', { name: 'About dnSpy' })).not.toBeInTheDocument()
  })

  it('opens the Debug → Options dialog from the Debug menu', () => {
    const onShowOptions = vi.fn()
    renderMenu(false, vi.fn(), 'inactive', onShowOptions)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Debug' }))
    const optionsItem = screen.getByRole('menuitem', { name: /^Options\.\.\.$/ })
    // Upstream keeps Options as a separator-less, always-enabled entry at the bottom of the Debug menu.
    expect(optionsItem).toBeEnabled()

    fireEvent.click(optionsItem)
    expect(onShowOptions).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menuitem', { name: /^Options\.\.\.$/ })).not.toBeInTheDocument()
  })

  it('keeps Debug → Options available while a debug session is running', () => {
    const onShowOptions = vi.fn()
    renderMenu(true, vi.fn(), 'running', onShowOptions)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Debug' }))
    // Options stays present and reachable during a live debug session, matching upstream.
    expect(screen.getByRole('menuitem', { name: /^Options\.\.\.$/ })).toBeInTheDocument()
  })

  it('mirrors the upstream Debug breakpoint commands', () => {
    renderMenu(false, vi.fn(), 'inactive', vi.fn(), { items: [{ name: 'Ns.Type.Method', enabled: true }] })

    fireEvent.click(screen.getByRole('menuitem', { name: 'Debug' }))
    // Upstream shows Toggle Breakpoint unconditionally (F9) and hides the other three when they have nothing to act on.
    expect(screen.getByRole('menuitem', { name: /^Toggle Breakpoint/ })).toBeDisabled()
    expect(screen.getByText('F9')).toBeVisible()
    expect(screen.getByRole('menuitem', { name: /^Delete All Breakpoints/ })).toBeInTheDocument()
    expect(screen.getByText('Ctrl+Shift+F9')).toBeVisible()
    expect(screen.getByRole('menuitem', { name: /^Disable All Breakpoints/ })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Enable All Breakpoints/ })).not.toBeInTheDocument()
  })

  it('enables Toggle Breakpoint only when a method is current and invokes the handler', () => {
    const onToggle = vi.fn()
    renderMenu(false, vi.fn(), 'inactive', vi.fn(), { canToggle: true, onToggle })

    fireEvent.click(screen.getByRole('menuitem', { name: 'Debug' }))
    const toggle = screen.getByRole('menuitem', { name: /^Toggle Breakpoint/ })
    expect(toggle).toBeEnabled()
    fireEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('hides the breakpoint commands that have nothing to act on', () => {
    renderMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Debug' }))
    expect(screen.queryByRole('menuitem', { name: /^Delete All Breakpoints/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Enable All Breakpoints/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Disable All Breakpoints/ })).not.toBeInTheDocument()
  })

  it('mirrors the upstream Edit menu layout for a selected method', () => {
    renderMenuWith({ selectionKind: 'method', selectionLabel: 'get_Code()' })
    // Upstream sorts by group prefix then item order and puts one separator between each non-empty
    // group, so the method commands follow Delete. The Create group keeps its member entries — dnSpy
    // offers those for a member of a type as well — but drops Create Type, which needs a type,
    // namespace or module.
    expect(openMenu('Edit')).toEqual([
      'UndoCtrl+Z',
      'RedoCtrl+Y',
      'FindCtrl+F',
      'Search AssembliesCtrl+Shift+K',
      'Find String References in Module',
      'Delete get_Code()Del',
      'Create Nested Type...',
      'Create Method...',
      'Create Field...',
      'Create Property...',
      'Create Event...',
      'Edit Method...Alt+Enter',
      'Edit Method (C#)...',
      'Edit Class (C#)...',
      'Add Class Members (C#)...',
      'Add Class (C#)...',
      'Merge with Assembly...',
      'Edit Method Body...',
      'Replace Method Body with stub...',
      'Load Dependencies',
      'Load Dependencies Recursively',
      // The hex group follows Settings; only "Open Hex Editor" shows without a resolved method target.
      'Open Hex EditorCtrl+X',
    ])
    expect(screen.getAllByRole('separator')).toHaveLength(5)
  })

  it('offers the member-creating commands for a type and for each kind of member', () => {
    // dnSpy's CanExecute for all five is "the selection is a type or its parent is one", and every
    // member in this port's tree hangs off a type, so all five show up for each of these kinds.
    for (const kind of ['type', 'method', 'field', 'property', 'event']) {
      cleanup()
      renderMenuWith({ selectionKind: kind, selectionLabel: 'Target' })
      const items = openMenu('Edit')
      for (const label of ['Create Nested Type...', 'Create Method...', 'Create Field...', 'Create Property...', 'Create Event...'])
        expect(items, `for a selected ${kind}`).toContain(label)
    }
  })

  it('hides the member-creating commands away from a type', () => {
    // Create Type is the only one a namespace or module gets; a reference gets none of them.
    cleanup()
    renderMenuWith({ selectionKind: 'namespace', selectionLabel: 'Ns' })
    const namespaceItems = openMenu('Edit')
    expect(namespaceItems).toContain('Create Type...')
    expect(namespaceItems).not.toContain('Create Nested Type...')

    cleanup()
    renderMenuWith({ selectionKind: 'assemblyreference', selectionLabel: 'System.Runtime' })
    const items = openMenu('Edit')
    for (const label of ['Create Type...', 'Create Nested Type...', 'Create Method...'])
      expect(items).not.toContain(label)
  })

  it('drops the Edit entries that have nothing to act on', () => {
    renderMenu()
    // Nothing selected: only Undo/Redo, the find commands and Create Assembly survive. The Create
    // group's other entries need a node, so the group still shows but keeps only its first entry.
    expect(openMenu('Edit')).toEqual([
      'UndoCtrl+Z',
      'RedoCtrl+Y',
      'FindCtrl+F',
      'Search AssembliesCtrl+Shift+K',
      'Create Assembly...',
    ])
    expect(screen.getAllByRole('separator')).toHaveLength(2)
  })

  it('lists the Edit commands the port has not implemented yet as disabled', () => {
    renderMenuWith({ selectionKind: 'type', selectionLabel: 'HelloRequest' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    // Delete, the type's two create commands, its own editor and the four member dialogs are wired up;
    // what is left of the group is the C#-scripting commands and the dependency and reference searches.
    expect(screen.getByRole('menuitem', { name: /^Delete HelloRequest/ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Create Type\.\.\./ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Create Nested Type\.\.\./ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Edit Type\.\.\./ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Edit Class \(C#\)\.\.\./ })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: /^Find String References in Module/ })).toBeDisabled()
    expect(screen.queryByRole('menuitem', { name: /^Edit Method Body/ })).not.toBeInTheDocument()
  })

  it('runs the create and edit commands whose dialogs the port has built', () => {
    const cases: { label: string, create: string, nested?: boolean }[] = [
      { label: 'Create Type...', create: 'type' },
      { label: 'Create Nested Type...', create: 'type', nested: true },
      { label: 'Create Method...', create: 'method' },
      { label: 'Create Field...', create: 'field' },
      { label: 'Create Property...', create: 'property' },
      { label: 'Create Event...', create: 'event' },
    ]
    for (const entry of cases) {
      const onCreateMember = vi.fn()
      renderMenuWith({ selectionKind: 'type', selectionLabel: 'HelloRequest', onCreateMember })
      fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
      fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${entry.label.replace('.', '\\.')}`) }))
      // The kind is what the dialog is for, and the nested flag is what tells the type's two commands
      // apart — the other four leave it off, having only one form; which type it goes into is the
      // selection's business.
      expect(onCreateMember).toHaveBeenCalledWith(...(entry.nested === true ? [entry.create, true] : [entry.create]))
      cleanup()
    }

    const edits: { kind: string, label: string }[] = [
      { kind: 'type', label: 'Edit Type...' },
      { kind: 'method', label: 'Edit Method...' },
      { kind: 'field', label: 'Edit Field...' },
      { kind: 'property', label: 'Edit Property...' },
      { kind: 'event', label: 'Edit Event...' },
    ]
    for (const entry of edits) {
      const onEditNode = vi.fn()
      renderMenuWith({ selectionKind: entry.kind, selectionLabel: 'Target', onEditNode })
      fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
      fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${entry.label.replace('.', '\\.')}`) }))
      expect(onEditNode, `for a selected ${entry.kind}`).toHaveBeenCalledTimes(1)
      cleanup()
    }
  })

  it('runs Delete and the stub replacement for a selected method', () => {
    const onDelete = vi.fn()
    renderMenuWith({ selectionKind: 'method', selectionLabel: 'M()', onDelete })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Delete M\(\)/ }))
    expect(onDelete).toHaveBeenCalledTimes(1)

    cleanup()
    const onReplaceMethodBodyWithStub = vi.fn()
    renderMenuWith({ selectionKind: 'method', onReplaceMethodBodyWithStub })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Replace Method Body with stub\.\.\./ }))
    expect(onReplaceMethodBodyWithStub).toHaveBeenCalledTimes(1)
  })

  it('runs the namespace commands for a selected namespace', () => {
    const onDelete = vi.fn()
    const onRenameNamespace = vi.fn()
    const onMoveTypesToEmptyNamespace = vi.fn()
    renderMenuWith({
      selectionKind: 'namespace',
      selectionLabel: 'Ns',
      hasEmptyNamespaceSibling: true,
      onDelete,
      onRenameNamespace,
      onMoveTypesToEmptyNamespace,
    })

    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Delete Namespace/ }))
    expect(onDelete).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename Namespace' }))
    expect(onRenameNamespace).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move Types to Empty Namespace' }))
    expect(onMoveTypesToEmptyNamespace).toHaveBeenCalledTimes(1)
  })

  it('runs the conversion the Edit menu offers on a module', () => {
    const onConvertModule = vi.fn()
    renderMenuWith({ selectionKind: 'module', selectionLabel: 'Example.dll', onConvertModule })

    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Convert Assembly to NetModule' }))
    expect(onConvertModule).toHaveBeenCalledTimes(1)

    // The other direction is dnSpy's, but this tree never puts a module on its own, so it never shows.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.queryByRole('menuitem', { name: /^Convert NetModule to Assembly/ })).not.toBeInTheDocument()
  })

  it('runs the two Load Dependencies commands on whatever the tree has selected, the assembly root included', () => {
    const onLoadDependencies = vi.fn()
    // dnSpy's CanExecute asks for the module of the selected node, and its helper hands back the module
    // child of an assembly root as readily as the module row itself.
    renderMenuWith({ selectionKind: 'assembly', selectionLabel: 'Example', onLoadDependencies })

    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Load Dependencies' }))
    expect(onLoadDependencies).toHaveBeenLastCalledWith(false)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Load Dependencies Recursively' }))
    expect(onLoadDependencies).toHaveBeenLastCalledWith(true)
    expect(onLoadDependencies).toHaveBeenCalledTimes(2)
  })

  it('leaves the two Load Dependencies commands out when the selection names no module', () => {
    renderMenuWith({ selectionKind: undefined, selectionLabel: undefined })
    expect(openMenu('Edit').filter((label) => label.startsWith('Load Dependencies'))).toEqual([])
  })

  it('offers Move Types to Empty Namespace only when there is an empty namespace to move into', () => {
    renderMenuWith({ selectionKind: 'namespace', selectionLabel: 'Ns', hasEmptyNamespaceSibling: false })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    // The view keeps its WPF shape either way: the entry is gone, not greyed out.
    expect(screen.queryByRole('menuitem', { name: 'Move Types to Empty Namespace' })).not.toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Rename Namespace' })).toBeEnabled()
  })

  it('enables Find only for a code document and runs it', () => {
    const onFind = vi.fn()
    renderMenuWith({ activeDocument: 'code', onFind })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.getByRole('menuitem', { name: /^FindCtrl\+F/ })).toBeEnabled()
    fireEvent.click(screen.getByRole('menuitem', { name: /^FindCtrl\+F/ }))
    expect(onFind).toHaveBeenCalledTimes(1)

    cleanup()
    renderMenuWith({ activeDocument: 'hex' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.getByRole('menuitem', { name: /^FindCtrl\+F/ })).toBeDisabled()
  })

  it('runs Edit Method Body and Edit Resource from the Edit menu', () => {
    const onEditMethodBody = vi.fn()
    renderMenuWith({ selectionKind: 'method', onEditMethodBody })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Edit Method Body\.\.\./ }))
    expect(onEditMethodBody).toHaveBeenCalledTimes(1)

    cleanup()
    const onEditResource = vi.fn()
    renderMenuWith({ selectionKind: 'resource', selectionLabel: 'res', onEditResource })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Edit Resource\.\.\./ }))
    expect(onEditResource).toHaveBeenCalledTimes(1)
  })

  it('shows the metadata-table Edit groups only for those documents', () => {
    // A hex tab with nothing selected offers none of the hex commands — they follow the selection, not
    // which document happens to hold the focus.
    renderMenuWith({ activeDocument: 'hex' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.queryByRole('menuitem', { name: /^Open Hex Editor/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Sort Table/ })).not.toBeInTheDocument()

    cleanup()
    renderMenuWith({ activeDocument: 'module-info' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.getByRole('menuitem', { name: /^Sort Table/ })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: /^Copy as Text/ })).toBeDisabled()
    expect(screen.queryByRole('menuitem', { name: /^Open Hex Editor/ })).not.toBeInTheDocument()
  })

  it('opens the hex editor for a selection that lives in a module', () => {
    const onOpenHex = vi.fn()
    renderMenuWith({ selectionKind: 'namespace', selectionLabel: 'N', onOpenHex })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Open Hex Editor/ }))
    expect(onOpenHex).toHaveBeenCalledTimes(1)

    // Upstream's rule is "a selected node inside a module", so with nothing selected there is no entry
    // even while a code document has the focus.
    cleanup()
    renderMenuWith({ activeDocument: 'code' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.queryByRole('menuitem', { name: /^Open Hex Editor/ })).not.toBeInTheDocument()
  })

  it('offers the method hex commands once the backend has resolved a method target', () => {
    const onShowHexAt = vi.fn()
    const onHexWriteBody = vi.fn()
    const onHexCopyBody = vi.fn()
    const onHexPasteBody = vi.fn()
    renderMenuWith({
      selectionKind: 'method',
      selectionLabel: 'Run',
      // What the backend sends for a method: the templates it does not have are nulls, not missing keys.
      hexTarget: {
        moduleId: 'm',
        fileLength: 4096,
        method: { bodyOffset: 0x200, bodySize: 3, codeOffset: 0x201, codeSize: 2, returnTrueBody: 'Chcq', returnFalseBody: 'ChYq', emptyBody: null },
        fieldInitialValue: null,
        resource: null,
      },
      onShowHexAt,
      onHexWriteBody,
      onHexCopyBody,
      onHexPasteBody,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    // The statement command and the method command share a header; only the method one is on screen.
    expect(screen.getAllByRole('menuitem', { name: /^Show Instructions in Hex Editor/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('menuitem', { name: /^Show Instructions in Hex Editor/ }))
    expect(onShowHexAt).toHaveBeenCalledWith('instructions')

    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Show Method Body in Hex Editor/ }))
    expect(onShowHexAt).toHaveBeenCalledWith('body')

    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Hex Write 'return true' Body/ }))
    expect(onHexWriteBody).toHaveBeenCalledWith('returnTrue')

    // No empty-body template was resolved (none fits this body), so the entry is not on screen at all —
    // and neither are the field's or the resource's, whose parts of the target came back as nulls.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.queryByRole('menuitem', { name: /^Hex Write Empty Body/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Show Initial Value in Hex Editor/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Show in Hex Editor/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: /^Hex Copy Method Body/ }))
    expect(onHexCopyBody).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Hex Paste Method Body/ }))
    expect(onHexPasteBody).toHaveBeenCalledTimes(1)
  })

  it('shows the statement hex command only while no method target is resolved', () => {
    renderMenuWith({ activeDocument: 'code', hexStatement: { moduleId: 'm', range: { offset: 0x201, length: 2 } } })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.getAllByRole('menuitem', { name: /^Show Instructions in Hex Editor/ })).toHaveLength(1)

    cleanup()
    renderMenuWith({
      hexStatement: { moduleId: 'm', range: { offset: 0x201, length: 2 } },
      hexTarget: {
        moduleId: 'm',
        fileLength: 4096,
        method: { bodyOffset: 0x200, bodySize: 3, codeOffset: 0x201, codeSize: 2, returnTrueBody: null, returnFalseBody: null, emptyBody: null },
        fieldInitialValue: null,
        resource: null,
      },
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    // Both would resolve to the same header; the selected method wins and the caret's entry goes away.
    expect(screen.getAllByRole('menuitem', { name: /^Show Instructions in Hex Editor/ })).toHaveLength(1)
    expect(screen.queryByRole('menuitem', { name: /^Show Method Body in Hex Editor/ })).toBeInTheDocument()
  })

  it.each([
    ['Latest Release', 'https://github.com/msojocs/dnSpy/releases/latest'],
    ['Report Bug', 'https://github.com/msojocs/dnSpy/issues/new'],
    ['Source Code', 'https://github.com/msojocs/dnSpy'],
  ])('opens %s in the system browser', (label, url) => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    renderMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Help' }))
    fireEvent.click(screen.getByRole('menuitem', { name: label }))

    expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer')
  })
})
