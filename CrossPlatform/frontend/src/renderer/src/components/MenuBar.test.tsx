import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setSystemHighContrast } from '../theme-service'
import { MenuBar } from './MenuBar'
import { useMetadataTableCommands } from '../metadata-table'

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
  recentFiles: [],
  canUndo: false,
  canRedo: false,
  theme: 'dark',
  wordWrap: false,
  highlightCurrentLine: true,
  fullScreen: false,
  elevated: false,
  onOpen: vi.fn(),
  onOpenFromGac: vi.fn(),
  onOpenList: vi.fn(),
  onOpenRecent: vi.fn(),
  onCloseAll: vi.fn(),
  onCloseAllFramework: vi.fn(),
  onCloseAllMissing: vi.fn(),
  dirty: false,
  onSave: vi.fn(),
  onSaveModule: vi.fn(),
  onSaveAll: vi.fn(),
  onReloadAll: vi.fn(),
  onSortAssemblies: vi.fn(),
  onFind: vi.fn(),
  onSearchAssemblies: vi.fn(),
  onFindStringReferences: vi.fn(),
  onUndo: vi.fn(),
  onRedo: vi.fn(),
  onEditMethodBody: vi.fn(),
  onEditResource: vi.fn(),
  onEditAssembly: vi.fn(),
  onEditModule: vi.fn(),
  onEditMethodCode: vi.fn(),
  onEditClassCode: vi.fn(),
  onAddClassMembersCode: vi.fn(),
  onAddClassCode: vi.fn(),
  onEditAssemblyAttributesCode: vi.fn(),
  onMergeAssembly: vi.fn(),
  onCreateResource: vi.fn(),
  onCreateResourceElement: vi.fn(),
  onCreateImageResources: vi.fn(),
  onCreateImageList: vi.fn(),
  onDelete: vi.fn(),
  onRenameNamespace: vi.fn(),
  onMoveTypesToEmptyNamespace: vi.fn(),
  onConvertModule: vi.fn(),
  onLoadDependencies: vi.fn(),
  onReplaceMethodBodyWithStub: vi.fn(),
  onOpenHex: vi.fn(),
  onShowHex: vi.fn(),
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
    // Nothing modified, nothing recently opened, no module left over from a process and nothing exportable selected,
    // which is the state that greys Export to Project, Save, Save All, Recent Files and Close Old In-Memory Modules.
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
    for (const name of [/^Export to Project/, /^SaveCtrl/, /^Save All/, /^Recent Files/, /^Close Old In-Memory/])
      expect(screen.getByRole('menuitem', { name })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: /^Open\.\.\./ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Open from GAC/ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Open List/ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Save Module\.\.\./ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Reload All Assemblies/ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Close All$/ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Close All Framework/ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Close All Missing/ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Sort Assemblies/ })).toBeEnabled()
    // dnSpy never greys the restart entry — it is clickable or not there at all.
    expect(screen.getByRole('menuitem', { name: /^Restart as Administrator/ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Exit/ })).toBeEnabled()
  })

  it('exports the selection to a project when it names a module, as dnSpy\'s ExportProjectCommand does', () => {
    const onExportToProject = vi.fn()
    renderMenuWith({ canExportToProject: true, onExportToProject })
    openMenu('File')
    const entry = screen.getByRole('menuitem', { name: /^Export to Project/ })
    expect(entry).toBeEnabled()
    fireEvent.click(entry)
    expect(onExportToProject).toHaveBeenCalledTimes(1)
  })

  it('greys Export to Project when the selection names no module', () => {
    renderMenuWith({ canExportToProject: false, onExportToProject: vi.fn() })
    openMenu('File')
    expect(screen.getByRole('menuitem', { name: /^Export to Project/ })).toBeDisabled()
  })

  it('closes the modules read out of a process that is no longer debugged, as dnSpy\'s Close Old In-Memory Modules does', () => {
    const onCloseOldInMemoryModules = vi.fn()
    render(<MenuBar {...baseProps()} hasOldInMemoryModules={true} onCloseOldInMemoryModules={onCloseOldInMemoryModules} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Close Old In-Memory Modules/ }))
    expect(onCloseOldInMemoryModules).toHaveBeenCalledTimes(1)
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

  it('lists the recent files under the Recent Files submenu, numbered, by their whole path', () => {
    const onOpenRecent = vi.fn()
    const longPath = `/very/${'long/'.repeat(30)}Four.dll`
    renderMenuWith({ recentFiles: ['/tmp/a/One.dll', '/tmp/b/Two.dll', longPath], onOpenRecent })
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
    expect(screen.getByRole('menuitem', { name: /^Recent Files/ })).toBeEnabled()
    fireEvent.pointerEnter(screen.getByRole('menuitem', { name: /^Recent Files/ }))
    const submenu = screen.getAllByRole('menu')[1]
    // dnSpy's RecentFilesCommand keeps the last hundred characters of a longer path.
    expect(within(submenu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      '1 /tmp/a/One.dll', '2 /tmp/b/Two.dll', `3 [...]${longPath.slice(-100)}`,
    ])
    fireEvent.click(within(submenu).getByRole('menuitem', { name: /Two\.dll/ }))
    expect(onOpenRecent).toHaveBeenCalledWith('/tmp/b/Two.dll')
  })

  it('enables CoreCLR commands only when the backend reports support', () => {
    renderMenu(false)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Debug' }))
    expect(screen.getByRole('menuitem', { name: /^Start Debugging/ })).toBeDisabled()

    cleanup()
    renderMenu(true)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Debug' }))
    expect(screen.getByRole('menuitem', { name: /^Start Debugging/ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Attach to Process\.\.\./ })).toBeEnabled()
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
    // The submenu is the second `role="menu"` in document order, nested inside the View popup. ThemesMenu
    // lists VisibleThemes, which leaves the high-contrast theme out while the system is not in high contrast.
    const entries = within(screen.getAllByRole('menu')[1]).getAllByRole('menuitem')
    expect(entries.map((item) => item.textContent)).toEqual(['Blue', 'Dark', 'Light'])
    expect(entries[0].getAttribute('aria-checked')).toBe('false')
    expect(entries[1].getAttribute('aria-checked')).toBe('true')
  })

  it('lists the high-contrast theme while the system is in high contrast', () => {
    setSystemHighContrast(true)
    try {
      renderMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))
      fireEvent.pointerEnter(screen.getByRole('menuitem', { name: /^Theme$/ }))
      const entries = within(screen.getAllByRole('menu')[1]).getAllByRole('menuitem')
      expect(entries.map((item) => item.textContent)).toEqual(['Blue', 'Dark', 'Light', 'High Contrast'])
    } finally {
      setSystemHighContrast(false)
    }
  })

  it('lists the languages the way dnSpy does: System, then every language by its native name', () => {
    const onSetLanguage = vi.fn()
    renderMenuWith({ onSetLanguage })
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }))
    fireEvent.pointerEnter(screen.getByRole('menuitem', { name: /^Language$/ }))
    const entries = within(screen.getAllByRole('menu')[1]).getAllByRole('menuitem')
    expect(entries.map((item) => item.textContent)).toEqual([
      'System',
      'čeština',
      'Deutsch',
      'English',
      'español (España)',
      'français',
      'italiano',
      'magyar',
      'português (Brasil)',
      'português (Portugal)',
      'Tiếng Việt',
      'Türkçe',
      'русский',
      'українська',
      'فارسی',
      '中文（中国）',
    ])
    // Nothing was chosen, so the operating system's language is the one checked.
    expect(entries[0].getAttribute('aria-checked')).toBe('true')
    expect(entries.slice(1).every((item) => item.getAttribute('aria-checked') === 'false')).toBe(true)
    fireEvent.click(entries[2])
    expect(onSetLanguage).toHaveBeenCalledWith('de')
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
    expect(screen.queryByRole('menuitem', { name: /^Break All/ })).not.toBeInTheDocument()
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
    expect(screen.getByRole('menuitem', { name: /^Break All/ })).toBeInTheDocument()
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

  // The menu this renders carries every tool window's entry, and rendering it takes several seconds on a
  // loaded machine — well past the five the runner allows by default.
  it('exposes individual callbacks to re-open each closable tool window', { timeout: 30_000 }, () => {
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
      recentFiles={[]}
      canUndo={false}
      canRedo={false}
      theme="dark"
      wordWrap={false}
      highlightCurrentLine={true}
      fullScreen={false}
      elevated={false}
      visibleToolWindows={new Set(['explorer'])}
      onOpen={vi.fn()}
      onOpenFromGac={vi.fn()}
      onOpenList={vi.fn()}
      onOpenRecent={vi.fn()}
      onCloseAll={vi.fn()}
      onCloseAllFramework={vi.fn()}
      onCloseAllMissing={vi.fn()}
      dirty={false}
      onSave={vi.fn()}
      onSaveModule={vi.fn()}
      onSaveAll={vi.fn()}
      onReloadAll={vi.fn()}
      onSortAssemblies={vi.fn()}
      onFind={vi.fn()}
      onSearchAssemblies={vi.fn()}
      onFindStringReferences={vi.fn()}
      onUndo={vi.fn()}
      onRedo={vi.fn()}
      onEditMethodBody={vi.fn()}
      onEditResource={vi.fn()}
      onEditAssembly={vi.fn()}
      onEditModule={vi.fn()}
      onEditMethodCode={vi.fn()}
      onEditClassCode={vi.fn()}
      onAddClassMembersCode={vi.fn()}
      onAddClassCode={vi.fn()}
      onEditAssemblyAttributesCode={vi.fn()}
      onMergeAssembly={vi.fn()}
      onCreateResource={vi.fn()}
      onCreateResourceElement={vi.fn()}
      onCreateImageResources={vi.fn()}
      onCreateImageList={vi.fn()}
      onDelete={vi.fn()}
      onRenameNamespace={vi.fn()}
      onMoveTypesToEmptyNamespace={vi.fn()}
      onConvertModule={vi.fn()}
      onLoadDependencies={vi.fn()}
      onReplaceMethodBodyWithStub={vi.fn()}
      onOpenHex={vi.fn()}
      onShowHex={vi.fn()}
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
      let item = screen.getByRole('menuitem', { name: new RegExp('^' + label) })
      // Watch and Memory are submenus of their four numbered windows, as dnSpy's are; the first is the callback's.
      if (label === 'Watch' || label === 'Memory') {
        fireEvent.pointerEnter(item)
        item = screen.getByRole('menuitem', { name: new RegExp(`^${label} 1`) })
      }
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
      recentFiles={[]}
      canUndo={false}
      canRedo={false}
      theme="dark"
      wordWrap={true}
      highlightCurrentLine={true}
      fullScreen={true}
      elevated={false}
      onOpen={vi.fn()}
      onOpenFromGac={vi.fn()}
      onOpenList={vi.fn()}
      onOpenRecent={vi.fn()}
      onCloseAll={vi.fn()}
      onCloseAllFramework={vi.fn()}
      onCloseAllMissing={vi.fn()}
      dirty={false}
      onSave={vi.fn()}
      onSaveModule={vi.fn()}
      onSaveAll={vi.fn()}
      onReloadAll={vi.fn()}
      onSortAssemblies={vi.fn()}
      onFind={vi.fn()}
      onSearchAssemblies={vi.fn()}
      onFindStringReferences={vi.fn()}
      onUndo={vi.fn()}
      onRedo={vi.fn()}
      onEditMethodBody={vi.fn()}
      onEditResource={vi.fn()}
      onEditAssembly={vi.fn()}
      onEditModule={vi.fn()}
      onEditMethodCode={vi.fn()}
      onEditClassCode={vi.fn()}
      onAddClassMembersCode={vi.fn()}
      onAddClassCode={vi.fn()}
      onEditAssemblyAttributesCode={vi.fn()}
      onMergeAssembly={vi.fn()}
      onCreateResource={vi.fn()}
      onCreateResourceElement={vi.fn()}
      onCreateImageResources={vi.fn()}
      onCreateImageList={vi.fn()}
      onDelete={vi.fn()}
      onRenameNamespace={vi.fn()}
      onMoveTypesToEmptyNamespace={vi.fn()}
      onConvertModule={vi.fn()}
      onLoadDependencies={vi.fn()}
      onReplaceMethodBodyWithStub={vi.fn()}
      onOpenHex={vi.fn()}
      onShowHex={vi.fn()}
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
      // The hex group follows Settings and contributes nothing here: no code document is open, and a
      // method row names no file for the command that opens the hex editor.
    ])
    expect(screen.getAllByRole('separator')).toHaveLength(4)
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
    // Nothing selected: only Undo/Redo, the find commands, Create Assembly and Create NetModule survive —
    // dnSpy's two create commands that need no node. The rest of the Create group needs one.
    expect(openMenu('Edit')).toEqual([
      'UndoCtrl+Z',
      'RedoCtrl+Y',
      'FindCtrl+F',
      'Search AssembliesCtrl+Shift+K',
      'Create Assembly...',
      'Create NetModule...',
    ])
    expect(screen.getAllByRole('separator')).toHaveLength(2)
  })

  it('offers the net module commands on an assembly\'s module rows, the manifest one not removable', () => {
    const onRemoveNetModule = vi.fn()
    const onAddNewNetModule = vi.fn()
    renderMenuWith({ selectionKind: 'module', selectionLabel: 'Extra.netmodule', selectionParentKind: 'assembly', selectionParentIcon: 'AssemblyFile', selectionIndexInParent: 1, onRemoveNetModule, onAddNewNetModule })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Remove NetModule from Assembly/ }))
    expect(onRemoveNetModule).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Add New NetModule to Assembly\.\.\./ }))
    expect(onAddNewNetModule).toHaveBeenCalled()
    cleanup()

    renderMenuWith({ selectionKind: 'module', selectionLabel: 'Host.dll', selectionParentKind: 'assembly', selectionParentIcon: 'AssemblyFile', selectionIndexInParent: 0, onRemoveNetModule })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.getByRole('menuitem', { name: /^Remove NetModule from Assembly/ })).toBeDisabled()
    cleanup()

    // A module standing on its own has no assembly to add a net module to.
    renderMenuWith({ selectionKind: 'module', selectionLabel: 'Alone.netmodule', selectionParentKind: 'assembly', selectionParentIcon: 'ModulePublic' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.queryByRole('menuitem', { name: /^Add New NetModule to Assembly/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Remove NetModule from Assembly/ })).not.toBeInTheDocument()
  })

  it('lists the Edit commands the port has not implemented yet as disabled', () => {
    renderMenuWith({ selectionKind: 'type', selectionLabel: 'HelloRequest' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    // Delete, the type's two create commands, its own editor, the four member dialogs and the C#
    // compiler commands are all wired up now; only Merge with Assembly is still a placeholder, and it
    // is not offered for a type at all.
    expect(screen.getByRole('menuitem', { name: /^Delete HelloRequest/ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Create Type\.\.\./ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Create Nested Type\.\.\./ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Edit Type\.\.\./ })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Edit Class \(C#\)\.\.\./ })).toBeEnabled()
    expect(screen.queryByRole('menuitem', { name: /^Edit Method Body/ })).not.toBeInTheDocument()
  })

  it('finds the string references of the selection\'s module, for any row in a .NET module', () => {
    const onFindStringReferences = vi.fn()
    renderMenuWith({ selectionKind: 'type', selectionLabel: 'HelloRequest', onFindStringReferences })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Find String References in Module/ }))
    expect(onFindStringReferences).toHaveBeenCalledOnce()

    cleanup()
    renderMenuWith({ selectionKind: 'pedocument', selectionLabel: 'native.dll' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.queryByRole('menuitem', { name: /^Find String References in Module/ })).not.toBeInTheDocument()
  })

  // One case per command: each renders the menu bar and opens the Edit menu, which is slow enough in jsdom
  // that the eleven of them in one test ran past the timeout on CI.
  it.each([
    { label: 'Create Type...', create: 'type' },
    { label: 'Create Nested Type...', create: 'type', nested: true },
    { label: 'Create Method...', create: 'method' },
    { label: 'Create Field...', create: 'field' },
    { label: 'Create Property...', create: 'property' },
    { label: 'Create Event...', create: 'event' },
  ])('runs $label, whose dialog the port has built', entry => {
    const onCreateMember = vi.fn()
    renderMenuWith({ selectionKind: 'type', selectionLabel: 'HelloRequest', onCreateMember })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${entry.label.replace('.', '\\.')}`) }))
    // The kind is what the dialog is for, and the nested flag is what tells the type's two commands
    // apart — the other four leave it off, having only one form; which type it goes into is the
    // selection's business.
    expect(onCreateMember).toHaveBeenCalledWith(...(entry.nested === true ? [entry.create, true] : [entry.create]))
  })

  it.each([
    { kind: 'type', label: 'Edit Type...' },
    { kind: 'method', label: 'Edit Method...' },
    { kind: 'field', label: 'Edit Field...' },
    { kind: 'property', label: 'Edit Property...' },
    { kind: 'event', label: 'Edit Event...' },
  ])('runs $label for a selected $kind', entry => {
    const onEditNode = vi.fn()
    renderMenuWith({ selectionKind: entry.kind, selectionLabel: 'Target', onEditNode })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${entry.label.replace('.', '\\.')}`) }))
    expect(onEditNode).toHaveBeenCalledTimes(1)
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

  it('converts a module under an assembly into a net module', () => {
    const onConvertModule = vi.fn()
    renderMenuWith({ selectionKind: 'module', selectionLabel: 'Example.dll', selectionParentKind: 'assembly', onConvertModule })

    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Convert Assembly to NetModule' }))
    expect(onConvertModule).toHaveBeenCalledWith(false)

    // A module that still belongs to an assembly has nothing to convert back.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.queryByRole('menuitem', { name: /^Convert NetModule to Assembly/ })).not.toBeInTheDocument()
  })

  it('converts a net module that has no assembly above it back into one', () => {
    const onConvertModule = vi.fn()
    renderMenuWith({ selectionKind: 'module', selectionLabel: 'Example.netmodule', selectionParentKind: undefined, onConvertModule })

    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Convert NetModule to Assembly' }))
    expect(onConvertModule).toHaveBeenCalledWith(true)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.queryByRole('menuitem', { name: /^Convert Assembly to NetModule/ })).not.toBeInTheDocument()
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
    // A hex tab is neither a code document viewer nor a row of the assembly tree, so the hex group has no
    // file to open and no target to point at.
    renderMenuWith({ activeDocument: 'hex' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.queryByRole('menuitem', { name: /^Open Hex Editor/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Sort Table/ })).not.toBeInTheDocument()

    // The port's Module Information tab is not a metadata table.
    cleanup()
    renderMenuWith({ activeDocument: 'module-info' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.queryByRole('menuitem', { name: /^Sort Table/ })).not.toBeInTheDocument()

    // A metadata table runs the commands of the table view that last had the focus.
    cleanup()
    const commands = {
      canSort: true, canSortSelection: false, hasSelection: true, canShowInHex: true,
      sortTable: vi.fn(), sortSelection: vi.fn(), goToRid: vi.fn(), showInHex: vi.fn(), copyAsText: vi.fn(), copy: vi.fn(), paste: vi.fn(),
    }
    useMetadataTableCommands.setState({ active: { viewId: 'v', commands } })
    renderMenuWith({ activeDocument: 'md-table' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.getByRole('menuitem', { name: /^Sort Selection/ })).toBeDisabled()
    expect(screen.queryByRole('menuitem', { name: /^Open Hex Editor/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: /^Sort Table/ }))
    expect(commands.sortTable).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Copy as Text/ }))
    expect(commands.copyAsText).toHaveBeenCalledTimes(1)
    useMetadataTableCommands.setState({ active: undefined })
  })

  it('goes to a metadata table row asked for, or to the selected row\'s own', () => {
    const onGoToMdTableRow = vi.fn()
    renderMenuWith({ selectionKind: 'method', canGoToMdTableRow: true, mdTableRowToken: 0x06000002, onGoToMdTableRow })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Go to MD Table Row\.\.\./ }))
    expect(onGoToMdTableRow).toHaveBeenLastCalledWith()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Go to MD Table Row (06000002)' }))
    expect(onGoToMdTableRow).toHaveBeenLastCalledWith(0x06000002)

    cleanup()
    renderMenuWith({ selectionKind: 'method', canGoToMdTableRow: false, onGoToMdTableRow })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.queryByRole('menuitem', { name: /^Go to MD Table Row/ })).not.toBeInTheDocument()
  })

  it('opens the hex editor for the file the context names', () => {
    // dnSpy's file command reads the context the Edit menu was given: the tree's selected row when that is a file
    // (an assembly, a module, a PE-only or unknown file), or the file of the document in front of the viewer.
    const onOpenHex = vi.fn()
    renderMenuWith({ selectionKind: 'module', selectionLabel: 'Example.dll', hex: { hexCreator: 'tree', hexFileModuleId: 'file-1' }, onOpenHex })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Open Hex Editor/ }))
    expect(onOpenHex).toHaveBeenCalledWith('file-1')

    // A context with no file — a part inside one, or the focus in neither the tree nor a viewer — has no entry.
    cleanup()
    renderMenuWith({ selectionKind: 'namespace', selectionLabel: 'N', hex: { hexCreator: 'tree' } })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.queryByRole('menuitem', { name: /^Open Hex Editor/ })).not.toBeInTheDocument()

    cleanup()
    renderMenuWith({ activeDocument: 'code' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.queryByRole('menuitem', { name: /^Open Hex Editor/ })).not.toBeInTheDocument()
  })

  it('offers the method hex commands once the backend has resolved a method target', () => {
    const onShowHex = vi.fn()
    const onHexWriteBody = vi.fn()
    const onHexCopyBody = vi.fn()
    const onHexPasteBody = vi.fn()
    const method = { bodyOffset: 0x200, bodySize: 3, codeOffset: 0x201, codeSize: 2, returnTrueBody: 'Chcq', returnFalseBody: 'ChYq', emptyBody: null }
    renderMenuWith({
      selectionKind: 'method',
      selectionLabel: 'Run',
      hex: {
        hexCreator: 'tree',
        // What the backend sends for a method: the templates it does not have are nulls, not missing keys.
        hexTarget: {
          moduleId: 'm',
          fileLength: 4096,
          method,
          fieldInitialValue: null,
          resource: null,
        },
        hexTargetNodeId: 'n-run',
        clipboardHexLength: 2,
      },
      onShowHex,
      onHexWriteBody,
      onHexCopyBody,
      onHexPasteBody,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    // The statement command and the method command share a header; only the method one is on screen.
    expect(screen.getAllByRole('menuitem', { name: /^Show Instructions in Hex Editor/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('menuitem', { name: /^Show Instructions in Hex Editor/ }))
    expect(onShowHex).toHaveBeenCalledWith('m', { offset: 0x201, length: 2 })

    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Show Method Body in Hex Editor/ }))
    expect(onShowHex).toHaveBeenCalledWith('m', { offset: 0x200, length: 3 })

    const target = { nodeId: 'n-run', moduleId: 'm', method }
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Hex Write 'return true' Body/ }))
    expect(onHexWriteBody).toHaveBeenCalledWith('returnTrue', target)

    // No empty-body template was resolved (none fits this body), so the entry is not on screen at all —
    // and neither are the field's or the resource's, whose parts of the target came back as nulls.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.queryByRole('menuitem', { name: /^Hex Write Empty Body/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Show Initial Value in Hex Editor/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Show in Hex Editor/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: /^Hex Copy Method Body/ }))
    expect(onHexCopyBody).toHaveBeenCalledWith(target)

    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Hex Paste Method Body/ }))
    expect(onHexPasteBody).toHaveBeenCalledWith(target)
  })

  it('shows the statement hex command only while no method definition is under the caret', () => {
    renderMenuWith({ activeDocument: 'code', hex: { hexCreator: 'code', hexFileModuleId: 'm', hexStatement: { moduleId: 'm', range: { offset: 0x201, length: 2 } } } })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.getAllByRole('menuitem', { name: /^Show Instructions in Hex Editor/ })).toHaveLength(1)
    // dnSpy builds this command and the file one from the same tree node and shows only the more specific
    // of the two, so the code document being open does not also put "Open Hex Editor" on the menu.
    expect(screen.queryByRole('menuitem', { name: /^Open Hex Editor/ })).not.toBeInTheDocument()

    cleanup()
    renderMenuWith({
      hex: {
        hexCreator: 'code',
        hexStatement: { moduleId: 'm', range: { offset: 0x201, length: 2 } },
        hexTarget: {
          moduleId: 'm',
          fileLength: 4096,
          method: { bodyOffset: 0x200, bodySize: 3, codeOffset: 0x201, codeSize: 2, returnTrueBody: null, returnFalseBody: null, emptyBody: null },
          fieldInitialValue: null,
          resource: null,
        },
        hexTargetNodeId: 'n-run',
      },
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    // Both would resolve to the same header; the method wins and the caret's statement entry goes away.
    expect(screen.getAllByRole('menuitem', { name: /^Show Instructions in Hex Editor/ })).toHaveLength(1)
    expect(screen.queryByRole('menuitem', { name: /^Show Method Body in Hex Editor/ })).toBeInTheDocument()
  })

  it('wears Go to MD Table Row\'s Shift+Alt+R for a context the tree or a viewer built', () => {
    renderMenuWith({ selectionKind: 'method', mdTableRowToken: 0x06000002, onGoToMdTableRow: vi.fn(), hex: { hexCreator: 'tree' } })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.getByRole('menuitem', { name: /^Go to MD Table Row \(06000002\)/ })).toHaveTextContent('Shift+Alt+R')

    cleanup()
    renderMenuWith({ selectionKind: 'method', mdTableRowToken: 0x06000002, onGoToMdTableRow: vi.fn() })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.getByRole('menuitem', { name: /^Go to MD Table Row \(06000002\)/ })).not.toHaveTextContent('Shift+Alt+R')
  })

  it('drops the menu bar down with Alt, and puts it away with Alt again', async () => {
    renderMenu()

    fireEvent.keyDown(document.body, { key: 'Alt' })
    // WPF opens the menu when Alt is let go.
    expect(screen.queryByRole('menuitem', { name: /^Open\.\.\./ })).not.toBeInTheDocument()
    fireEvent.keyUp(document.body, { key: 'Alt' })
    // The first menu's entries are up: the File menu is the one the bar opens on.
    expect(await screen.findByRole('menuitem', { name: /^Open\.\.\./ })).toBeInTheDocument()

    fireEvent.keyDown(document.body, { key: 'Alt' })
    fireEvent.keyUp(document.body, { key: 'Alt' })
    expect(screen.queryByRole('menuitem', { name: /^Open\.\.\./ })).not.toBeInTheDocument()
  })

  it('opens no menu for Alt held with a key a view took for itself', () => {
    renderMenu()

    fireEvent.keyDown(document.body, { key: 'Alt' })
    const key = new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', altKey: true, bubbles: true, cancelable: true })
    key.preventDefault()
    document.body.dispatchEvent(key)
    fireEvent.keyUp(document.body, { key: 'Alt' })

    expect(screen.queryByRole('menuitem', { name: /^Undo/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Open\.\.\./ })).not.toBeInTheDocument()
  })

  it('opens a menu from the mnemonic its header carries', async () => {
    renderMenu()

    // Alt+H is the Help menu: it drops down with the entries the menu has.
    fireEvent.keyDown(document.body, { key: 'h', code: 'KeyH', altKey: true })
    expect(await screen.findByRole('menuitem', { name: 'About dnSpy' })).toBeInTheDocument()
  })

  it('walks along the open menus with the left and right arrows, and closes on Escape', async () => {
    renderMenu()

    fireEvent.keyDown(document.body, { key: 'Alt' })
    fireEvent.keyUp(document.body, { key: 'Alt' })
    expect(await screen.findByRole('menuitem', { name: /^Open\.\.\./ })).toBeInTheDocument()

    // The next menu along is Edit, so the File menu's entries go and its own take their place.
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(await screen.findByRole('menuitem', { name: /^Undo/ })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Open\.\.\./ })).not.toBeInTheDocument()

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('menuitem', { name: /^Undo/ })).not.toBeInTheDocument()
  })

  it.each([
    ['Latest Release', 'https://github.com/msojocs/dnSpy/releases/latest'],
    ['Issues', 'https://github.com/msojocs/dnSpy/issues'],
    ['Wiki', 'https://github.com/msojocs/dnSpy/wiki'],
    ['Source Code', 'https://github.com/msojocs/dnSpy'],
  ])('opens %s in the system browser', (label, url) => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    renderMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Help' }))
    fireEvent.click(screen.getByRole('menuitem', { name: label }))

    expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer')
  })
})
