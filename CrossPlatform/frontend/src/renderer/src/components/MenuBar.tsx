import { useEffect, useRef, useState } from 'react'
import { languageChoices, useLanguage, type LanguagePreference } from '../localization'
import { buildEditMenu, type ActiveDocument, type CreatedKind, type HexShowKind, type MenuItem } from './edit-menu'
import { buildFileMenu } from './file-menu'
import type { HexBodyKind } from '../app-store'
import type { HexRange, HexTargetResponse, ResourceCreateKind, TreeNode } from '../../../shared/protocol'
import { WindowControls } from './WindowControls'
import { MenuEntryIcon } from './DsIcon'
import { SubmenuArrowGlyph } from './DsGlyphs'
import { themeKey, themeMenuName, useThemes } from '../theme-service'
import { useMetadataTableCommands } from '../metadata-table'

/** A theme by the key the theme service gives it (theme-service.ts). */
export type ThemeName = string

const repositoryUrl = 'https://github.com/msojocs/dnSpy'

const openExternal = (url: string): void => {
  window.open(url, '_blank', 'noopener,noreferrer')
}

interface MenuBarProps {
  hasWorkspace: boolean
  /** Whether the workspace holds a module, which is what the File menu's "Save Module..." acts on. */
  hasModule: boolean
  /** `selectedNode.kind` / `selectedNode.label` from the assembly explorer, feeding the Edit menu. */
  selectionKind?: string
  selectionLabel?: string
  /** `selectedNode.icon`, which tells a .resources file from any other resource. */
  selectionIcon?: string
  selectionParentKind?: string
  selectionParentIcon?: string
  selectionIndexInParent?: number
  /** Every selected row and the tree's parent links, which the delete commands act on and count. */
  selection?: TreeNode[]
  parents?: Record<string, string>
  /** Whether the selected namespace's module already has an empty namespace to move its types into. */
  hasEmptyNamespaceSibling: boolean
  /** Which document the Edit menu's hex groups key off. */
  activeDocument: ActiveDocument
  canShowCode: boolean
  debugAvailable: boolean
  debugState: 'inactive' | 'starting' | 'running' | 'stopped'
  recentFiles: string[]
  canUndo: boolean
  canRedo: boolean
  theme: ThemeName
  wordWrap: boolean
  highlightCurrentLine: boolean
  fullScreen: boolean
  /** Whether the app already has elevated rights, which is what hides the File menu's restart entry. */
  elevated: boolean
  visibleToolWindows: ReadonlySet<string>
  onOpen(): void
  onOpenFromGac(): void
  onOpenList(): void
  onOpenRecent(path: string): void
  onCloseAll(): void
  onCloseAllFramework(): void
  onCloseAllMissing(): void
  /** dnSpy's Close Old In-Memory Modules, and whether there is one to close. */
  onCloseOldInMemoryModules?(): void
  hasOldInMemoryModules?: boolean
  /** Whether an edit is unsaved, which is what enables the File menu's Save and Save All. */
  dirty: boolean
  /** dnSpy's ExportProjectCommand.IsEnabled, and the command itself. */
  canExportToProject?: boolean
  onExportToProject?(): void
  onSave(): void
  onSaveModule(): void
  onSaveAll(): void
  onReloadAll(): void
  onSortAssemblies(): void
  onFind(): void
  onSearchAssemblies(): void
  /** dnSpy's Find String References in Module: scans the assemblies of the tree's selection. */
  onFindStringReferences(): void
  onUndo(): void
  onRedo(): void
  onEditMethodBody(): void
  onEditResource(): void
  onEditAssembly(): void
  onEditModule(): void
  onEditMethodCode(): void
  onEditClassCode(): void
  onAddClassMembersCode(): void
  onAddClassCode(): void
  onEditAssemblyAttributesCode(): void
  onMergeAssembly(): void
  onCreateResource(kind: ResourceCreateKind): void
  onCreateResourceElement(): void
  onCreateImageResources(): void
  onCreateImageList(): void
  onDelete(): void
  onRenameNamespace(): void
  onMoveTypesToEmptyNamespace(): void
  /** Converts the selected module into a net module — dnSpy's Convert Assembly to NetModule. */
  onConvertModule(toAssembly?: boolean): void
  onCreateAssembly?(): void
  onCreateNetModule?(): void
  onAddNewNetModule?(): void
  onAddExistingNetModule?(): void
  onRemoveNetModule?(): void
  /** Opens the assemblies the selected module's references name — dnSpy's two Load Dependencies
   *  commands, which it registers on this menu as well as on the assembly explorer's. */
  onLoadDependencies(recursive: boolean): void
  onReplaceMethodBodyWithStub(): void
  /** Where the hex commands point for the selection, and for the code document's caret. */
  hexTarget?: HexTargetResponse
  hexStatement?: { moduleId: string; range: HexRange }
  onOpenHex(): void
  onShowHexAt(kind: HexShowKind): void
  onHexWriteBody(kind: HexBodyKind): void
  onHexCopyBody(): void
  onHexPasteBody(): void
  /** dnSpy's Go to MD Table Row: whether there is a module to ask about, the selected row's token for the entry
   *  that goes to it directly, and the command — asking for a token when it is given none. */
  canGoToMdTableRow?: boolean
  mdTableRowToken?: number
  onGoToMdTableRow?(token?: number): void
  onCreateMember(kind: CreatedKind): void
  onEditNode(): void
  onShowCode(): void
  onCollapseTreeViewNodes(): void
  onStartDebug(): void
  onAttachDebug(): void
  onContinueDebug(): void
  onPauseDebug(): void
  onStepIn(): void
  onStepOver(): void
  onStepOut(): void
  /**
   * dnSpy's Step Into, Over and Out (Current Process), which leave the other processes paused. The menu has them
   * while debugging when Break all processes is off — with it on, every step breaks the others again anyway.
   */
  onStepCurrentProcess?(kind: 'next' | 'stepIn' | 'stepOut'): void
  showCurrentProcessSteps?: boolean
  onStopDebug(): void
  /** dnSpy's Start Without Debugging: the Debug Program dialog, to run the program on its own. */
  onStartWithoutDebugging?(): void
  /** dnSpy's Detach All: the debugger lets go of the process, which keeps running. */
  onDetachDebug?(): void
  /** dnSpy's Terminate All: the process is killed, whether the debugger started it or attached to it. */
  onTerminateDebug?(): void
  /** dnSpy's Restart: the launched program is stopped and started again. */
  onRestartDebug?(): void
  /** dnSpy's Show Next Statement. */
  onShowNextStatement?(): void
  /** Whether the session's process is one the debugger started, which is what Restart needs. */
  canRestartDebug?: boolean
  canToggleBreakpoint: boolean
  hasFunctionBreakpoints: boolean
  canEnableAllBreakpoints: boolean
  canDisableAllBreakpoints: boolean
  onToggleBreakpoint(): void
  onDeleteAllBreakpoints(): void
  onEnableAllBreakpoints(): void
  onDisableAllBreakpoints(): void
  onShowExplorer(): void
  onShowOutput(): void
  onShowCSharpInteractive(): void
  bookmarksCount: number
  canEnableAllBookmarks: boolean
  canDisableAllBookmarks: boolean
  onShowBookmarks(): void
  onToggleBookmark(): void
  onEnableBookmark(): void
  onEnableAllBookmarks(): void
  onDisableAllBookmarks(): void
  onPreviousBookmark(): void
  onNextBookmark(): void
  onPreviousBookmarkWithSameLabel(): void
  onNextBookmarkWithSameLabel(): void
  onPreviousBookmarkInDocument(): void
  onNextBookmarkInDocument(): void
  onClearBookmarks(): void
  onClearBookmarksInDocument(): void
  onShowModuleBreakpoints(): void
  onShowExceptionSettings(): void
  onShowAutos(): void
  onShowStaticFields(): void
  onShowProcesses(): void
  onShowMemory(): void
  onShowDisassembly(): void
  /** Whether a frame is active in a paused process — the Disassembly entry's IsEnabled. */
  canShowDisassembly?: boolean
  onShowLocals(): void
  onShowWatch(): void
  /** Opens one of the numbered debugger windows — Watch 2–4, Memory 1–4 — by its tab id. */
  onShowToolWindow?(id: string): void
  onShowCallStack(): void
  onShowBreakpoints(): void
  onShowThreads(): void
  onShowModules(): void
  /** Commands in the top-level Window menu. They are optional for lightweight menu consumers. */
  windowTabs?: ReadonlyArray<{ id: string; label: string; checked: boolean }>
  onSelectWindowTab?(id: string): void
  onNewWindow?(): void
  onCloseWindow?(): void
  onNewHorizontalTabGroup?(): void
  onNewVerticalTabGroup?(): void
  onMoveToNextTabGroup?(): void
  onMoveAllToNextTabGroup?(): void
  onMoveToPreviousTabGroup?(): void
  onMoveAllToPreviousTabGroup?(): void
  onCloseAllTabs?(): void
  onCloseTabGroup?(): void
  onCloseAllTabGroupsButThis?(): void
  onMoveTabGroupAfterNext?(): void
  onMoveTabGroupBeforePrevious?(): void
  onMergeAllTabGroups?(): void
  onUseVerticalTabGroups?(): void
  onUseHorizontalTabGroups?(): void
  canNewWindow?: boolean
  canCloseWindow?: boolean
  canCreateTabGroup?: boolean
  canNewHorizontalTabGroup?: boolean
  canNewVerticalTabGroup?: boolean
  canMoveToNextTabGroup?: boolean
  canMoveAllToNextTabGroup?: boolean
  canMoveToPreviousTabGroup?: boolean
  canMoveAllToPreviousTabGroup?: boolean
  canCloseAllTabs?: boolean
  canCloseTabGroup?: boolean
  canCloseAllTabGroupsButThis?: boolean
  canMoveTabGroupAfterNext?: boolean
  canMoveTabGroupBeforePrevious?: boolean
  canMergeAllTabGroups?: boolean
  canUseVerticalTabGroups?: boolean
  canUseHorizontalTabGroups?: boolean
  /** Opens the Windows dialog that lists every document tab (WPF's TabsDlg). */
  onShowWindowsDialog?(): void
  onTheme(theme: ThemeName): void
  onToggleWordWrap(): void
  onToggleHighlightCurrentLine(): void
  onToggleFullScreen(): void
  onSetLanguage(language: LanguagePreference): void
  onAbout(): void
  onRestartAsAdministrator(): void
  onQuit(): void
  onShowOptions(category?: 'environment' | 'decompiler' | 'debugger'): void
}

export const MenuBar = ({
  hasWorkspace,
  hasModule,
  selectionKind,
  selectionLabel,
  selectionIcon,
  selectionParentKind,
  selectionParentIcon,
  selectionIndexInParent,
  selection,
  parents,
  hasEmptyNamespaceSibling,
  activeDocument,
  canShowCode,
  debugAvailable,
  debugState,
  recentFiles,
  canUndo,
  canRedo,
  theme,
  wordWrap,
  highlightCurrentLine,
  fullScreen,
  elevated,
  onOpen,
  onOpenFromGac,
  onOpenList,
  onOpenRecent,
  onCloseAll,
  onCloseAllFramework,
  onCloseAllMissing,
  onCloseOldInMemoryModules,
  hasOldInMemoryModules,
  dirty,
  canExportToProject,
  onExportToProject,
  onSave,
  onSaveModule,
  onSaveAll,
  onReloadAll,
  onSortAssemblies,
  onFind,
  onSearchAssemblies,
  onFindStringReferences,
  onUndo,
  onRedo,
  onEditMethodBody,
  onEditResource,
  onEditAssembly,
  onEditModule,
  onEditMethodCode,
  onEditClassCode,
  onAddClassMembersCode,
  onAddClassCode,
  onEditAssemblyAttributesCode,
  onMergeAssembly,
  onCreateResource,
  onCreateResourceElement,
  onCreateImageResources,
  onCreateImageList,
  onDelete,
  onRenameNamespace,
  onMoveTypesToEmptyNamespace,
  onConvertModule,
  onCreateAssembly,
  onCreateNetModule,
  onAddNewNetModule,
  onAddExistingNetModule,
  onRemoveNetModule,
  onLoadDependencies,
  onReplaceMethodBodyWithStub,
  hexTarget,
  hexStatement,
  canGoToMdTableRow,
  mdTableRowToken,
  onGoToMdTableRow,
  onOpenHex,
  onShowHexAt,
  onHexWriteBody,
  onHexCopyBody,
  onHexPasteBody,
  onCreateMember,
  onEditNode,
  onShowCode,
  onCollapseTreeViewNodes,
  onStartDebug,
  onAttachDebug,
  onContinueDebug,
  onPauseDebug,
  onStepIn,
  onStepOver,
  onStepOut,
  onStepCurrentProcess,
  showCurrentProcessSteps = false,
  onStopDebug,
  onStartWithoutDebugging,
  onDetachDebug,
  onTerminateDebug,
  onRestartDebug,
  onShowNextStatement,
  canRestartDebug = false,
  canToggleBreakpoint,
  hasFunctionBreakpoints,
  canEnableAllBreakpoints,
  canDisableAllBreakpoints,
  onToggleBreakpoint,
  onDeleteAllBreakpoints,
  onEnableAllBreakpoints,
  onDisableAllBreakpoints,
  visibleToolWindows,
  onShowExplorer,
  onShowOutput,
  onShowCSharpInteractive,
  bookmarksCount,
  canEnableAllBookmarks,
  canDisableAllBookmarks,
  onShowBookmarks,
  onToggleBookmark,
  onEnableBookmark,
  onEnableAllBookmarks,
  onDisableAllBookmarks,
  onPreviousBookmark,
  onNextBookmark,
  onPreviousBookmarkWithSameLabel,
  onNextBookmarkWithSameLabel,
  onPreviousBookmarkInDocument,
  onNextBookmarkInDocument,
  onClearBookmarks,
  onClearBookmarksInDocument,
  onShowModuleBreakpoints,
  onShowExceptionSettings,
  onShowAutos,
  onShowStaticFields,
  onShowProcesses,
  onShowMemory,
  onShowDisassembly,
  canShowDisassembly,
  onShowLocals,
  onShowWatch,
  onShowToolWindow,
  onShowCallStack,
  onShowBreakpoints,
  onShowThreads,
  onShowModules,
  windowTabs = [],
  onSelectWindowTab,
  onNewWindow,
  onCloseWindow,
  onNewHorizontalTabGroup,
  onNewVerticalTabGroup,
  onMoveToNextTabGroup,
  onMoveAllToNextTabGroup,
  onMoveToPreviousTabGroup,
  onMoveAllToPreviousTabGroup,
  onCloseAllTabs,
  onCloseTabGroup,
  onCloseAllTabGroupsButThis,
  onMoveTabGroupAfterNext,
  onMoveTabGroupBeforePrevious,
  onMergeAllTabGroups,
  onUseVerticalTabGroups,
  onUseHorizontalTabGroups,
  canNewWindow = false,
  canCloseWindow = false,
  canCreateTabGroup = false,
  canNewHorizontalTabGroup = canCreateTabGroup,
  canNewVerticalTabGroup = canCreateTabGroup,
  canMoveToNextTabGroup = false,
  canMoveAllToNextTabGroup = canMoveToNextTabGroup,
  canMoveToPreviousTabGroup = false,
  canMoveAllToPreviousTabGroup = canMoveToPreviousTabGroup,
  canCloseAllTabs = false,
  canCloseTabGroup = false,
  canCloseAllTabGroupsButThis = false,
  canMoveTabGroupAfterNext = false,
  canMoveTabGroupBeforePrevious = false,
  canMergeAllTabGroups = false,
  canUseVerticalTabGroups = false,
  canUseHorizontalTabGroups = false,
  onShowWindowsDialog,
  onTheme,
  onToggleWordWrap,
  onToggleHighlightCurrentLine,
  onToggleFullScreen,
  onSetLanguage,
  onAbout,
  onRestartAsAdministrator,
  onQuit,
  onShowOptions,
}: MenuBarProps): React.JSX.Element => {
  // The metadata table document the Edit menu acts on, which registers its commands when it gets the focus.
  const mdTableCommands = useMetadataTableCommands((state) => state.active?.commands)
  const [openMenu, setOpenMenu] = useState<string>()
  const host = useRef<HTMLDivElement>(null)
  const { language, t } = useLanguage()
  const { visible: visibleThemes } = useThemes()
  const isDebugging = debugState !== 'inactive'
  // dnSpy's GetEnableAllBookmarksKind: an empty list gets no entry at all, every bookmark on gets
  // "Disable All", and one bookmark off is enough for "Enable All". Those first two kinds are what
  // App hands over as the two flags, so "all of them are on" is nothing left to enable.
  const allBookmarksEnabled = !canEnableAllBookmarks && canDisableAllBookmarks
  // Window commands are grouped the same way as dnSpy's WPF menu. Commands whose CanExecute state
  // also controls IsVisible are omitted here; commands such as New Window and Close All Tabs stay in
  // the menu and only become disabled when their action is unavailable.
  const windowTabGroupItems: MenuItem[] = [
    ...(canNewHorizontalTabGroup ? [
      { label: t('New Horizontal Tab Group'), icon: 'SplitScreenHorizontally', action: onNewHorizontalTabGroup },
    ] : []),
    ...(canNewVerticalTabGroup ? [
      { label: t('New Vertical Tab Group'), icon: 'SplitScreenVertically', action: onNewVerticalTabGroup },
    ] : []),
    ...(canMoveToNextTabGroup ? [{ label: t('Move to Next Tab Group'), action: onMoveToNextTabGroup }] : []),
    ...(canMoveAllToNextTabGroup ? [
      { label: t('Move All to Next Tab Group'), action: onMoveAllToNextTabGroup },
    ] : []),
    ...(canMoveToPreviousTabGroup ? [{ label: t('Move to Previous Tab Group'), action: onMoveToPreviousTabGroup }] : []),
    ...(canMoveAllToPreviousTabGroup ? [
      { label: t('Move All to Previous Tab Group'), action: onMoveAllToPreviousTabGroup },
    ] : []),
  ]
  // In WPF, Close All Tabs belongs to GROUP_APP_MENU_WINDOW_TABGROUPS (Order 60) and its IsVisible
  // always returns true: it stays in the menu even with a single tab in a single group — when every
  // split and move command is gone — and is controlled by IsEnabled alone.
  const windowTabGroupItemsWithCloseAll: MenuItem[] = [
    ...windowTabGroupItems,
    { label: t('Close All Tabs'), icon: 'CloseDocumentGroup', disabled: !canCloseAllTabs, action: onCloseAllTabs },
  ]
  const windowTabGroupCloseItems: MenuItem[] = [
    ...(canCloseTabGroup ? [{ label: t('Close Tab Group'), action: onCloseTabGroup }] : []),
    ...(canCloseAllTabGroupsButThis ? [{ label: t('Close All Tab Groups But This'), action: onCloseAllTabGroupsButThis }] : []),
    ...(canMoveTabGroupAfterNext ? [{ label: t('Move Tab Group After Next Tab Group'), action: onMoveTabGroupAfterNext }] : []),
    ...(canMoveTabGroupBeforePrevious ? [{ label: t('Move Tab Group Before Previous Tab Group'), action: onMoveTabGroupBeforePrevious }] : []),
    ...(canMergeAllTabGroups ? [{ label: t('Merge All Tab Groups'), action: onMergeAllTabGroups }] : []),
  ]
  const windowTabGroupOrientationItems: MenuItem[] = [
    ...(canUseVerticalTabGroups ? [{ label: t('Use Vertical Tab Groups'), icon: 'SplitScreenVertically', action: onUseVerticalTabGroups }] : []),
    ...(canUseHorizontalTabGroups ? [{ label: t('Use Horizontal Tab Groups'), icon: 'SplitScreenHorizontally', action: onUseHorizontalTabGroups }] : []),
  ]
  // WPF shows up to 10 tabs directly in the Window menu, numbered 1 through 10, followed by a
  // "Windows..." entry that opens a dialog with all tabs. Match WPF's limit and structure.
  const MAX_WINDOW_TABS = 10
  const windowTabItems: MenuItem[] = windowTabs.slice(0, MAX_WINDOW_TABS).map((tab, index) => {
    const num = index + 1
    return { label: `${num} ${tab.label}`, checked: tab.checked, action: () => onSelectWindowTab?.(tab.id) }
  })
  // Add "Windows..." entry at the end if there are any tabs (even if ≤10, WPF always shows it)
  if (windowTabs.length > 0) {
    windowTabItems.push({ label: t('Windows...'), action: () => onShowWindowsDialog?.() })
  }
  // Every entry wears the image its ExportMenuItem names (Icon = DsImagesAttribute.X) and an entry dnSpy
  // gives none to stays blank; a checked entry draws the check mark in the same column instead.
  const menus: Record<string, MenuItem[]> = {
    // dnSpy's File menu in full: see file-menu.ts for the ordering and the disabled entries.
    [t('File')]: buildFileMenu({
      t,
      hasWorkspace,
      hasModule,
      dirty,
      elevated,
      recentFiles,
      canExportToProject,
      onExportToProject,
      onOpen,
      onOpenFromGac,
      onOpenList,
      onOpenRecent,
      onSave,
      onSaveModule,
      onSaveAll,
      onReloadAll,
      onCloseAll,
      onCloseAllFramework,
      onCloseAllMissing,
      onCloseOldInMemoryModules,
      hasOldInMemoryModules,
      onSortAssemblies,
      onRestartAsAdministrator,
      onQuit,
    }),
    // dnSpy's Edit menu in full: see edit-menu.ts for the ordering and visibility rules.
    [t('Edit')]: buildEditMenu({
      t,
      hasWorkspace,
      selectionKind,
      selectionLabel,
      selectionIcon,
      selectionParentKind,
      selectionParentIcon,
      selectionIndexInParent,
      selection,
      parents,
      hasEmptyNamespaceSibling,
      activeDocument,
      documentAvailable: activeDocument === 'code',
      canUndo,
      canRedo,
      onUndo,
      onRedo,
      onFind,
      onSearchAssemblies,
      onFindStringReferences,
      onEditMethodBody,
      onEditResource,
      onEditAssembly,
      onEditModule,
      onEditMethodCode,
      onEditClassCode,
      onAddClassMembersCode,
      onAddClassCode,
      onEditAssemblyAttributesCode,
      onMergeAssembly,
      onCreateResource,
      onCreateResourceElement,
      onCreateImageResources,
      onCreateImageList,
      onDelete,
      onRenameNamespace,
      onMoveTypesToEmptyNamespace,
      onConvertModule,
      onCreateAssembly,
      onCreateNetModule,
      onAddNewNetModule,
      onAddExistingNetModule,
      onRemoveNetModule,
      onLoadDependencies,
      onReplaceMethodBodyWithStub,
      hexTarget,
      hexStatement,
      mdTable: activeDocument === 'md-table' ? mdTableCommands : undefined,
      canGoToMdTableRow,
      mdTableRowToken,
      onGoToMdTableRow,
      onOpenHex,
      onShowHexAt,
      onHexWriteBody,
      onHexCopyBody,
      onHexPasteBody,
      onCreateMember,
      onEditNode,
    }),
    [t('View')]: [
      { label: t('Word Wrap'), icon: 'WordWrap', shortcut: 'Ctrl+E, Ctrl+W', checked: wordWrap, action: onToggleWordWrap },
      { label: t('Highlight Current Line'), checked: highlightCurrentLine, action: onToggleHighlightCurrentLine },
      { label: t('Full Screen'), icon: 'AutoSizeOptimize', shortcut: 'Shift+Alt+Enter', checked: fullScreen, action: onToggleFullScreen },
      { label: t('Collapse Tree View Nodes'), icon: 'OneLevelUp', shortcut: 'Ctrl+Shift+P', action: onCollapseTreeViewNodes },
      {
        label: t('Theme'),
        // dnSpy's ThemesMenu: every theme the theme service shows, in its order, the one in use checked.
        submenu: visibleThemes.map((item) => ({
          label: themeMenuName(item, t),
          checked: themeKey(item) === theme,
          action: () => onTheme(themeKey(item)),
        })),
      },
      {
        label: t('Language'),
        // dnSpy's ShowSupportedLanguagesCommand: "System" and then the languages by their native names.
        submenu: languageChoices().map((option) => ({
          label: option.label,
          checked: language === option.value,
          action: () => onSetLanguage(option.value),
        })),
      },
      { separator: true },
      { label: t('Code'), icon: 'MarkupTag', shortcut: 'Ctrl+Alt+0', disabled: !canShowCode, action: onShowCode },
      { label: t('Assembly Explorer'), icon: 'Assembly', shortcut: 'Ctrl+Alt+L', checked: visibleToolWindows.has('explorer'), action: onShowExplorer },
      { label: t('Output'), icon: 'Output', shortcut: 'Alt+2', checked: visibleToolWindows.has('output'), action: onShowOutput },
      { label: t('C# Interactive'), icon: 'CSInteractiveWindow', shortcut: 'Ctrl+Alt+N', checked: visibleToolWindows.has('csharp-interactive'), action: onShowCSharpInteractive },
      {
        // dnSpy's bookmark commands, in the order its View menu group and sort orders give them: the
        // window, the commands, then the labelled and in-document walks. Enable/Disable All is a single
        // entry whose header follows the bookmarks around it, which is how dnSpy writes it.
        label: t('Bookmarks'),
        icon: 'BookmarkMainMenuItem',
        submenu: [
          { label: t('Bookmarks Window'), icon: 'BookmarkMainMenuItem', shortcut: 'Ctrl+K, Ctrl+W', checked: visibleToolWindows.has('bookmarks'), action: onShowBookmarks },
          { separator: true },
          { label: t('Toggle Bookmark'), icon: 'Bookmark', shortcut: 'Ctrl+K, Ctrl+K', action: onToggleBookmark },
          ...(bookmarksCount > 0 ? [{
            label: t(allBookmarksEnabled ? 'Disable All Bookmarks' : 'Enable All Bookmarks'),
            icon: 'BookmarkDisabled',
            action: allBookmarksEnabled ? onDisableAllBookmarks : onEnableAllBookmarks,
          }] : []),
          { label: t('Enable/Disable Bookmark'), icon: 'Bookmark', shortcut: 'Ctrl+K, Ctrl+E', action: onEnableBookmark },
          { label: t('Previous Bookmark'), icon: 'PreviousBookmark', shortcut: 'Ctrl+K, Ctrl+P', disabled: bookmarksCount === 0, action: onPreviousBookmark },
          { label: t('Next Bookmark'), icon: 'NextBookmark', shortcut: 'Ctrl+K, Ctrl+N', disabled: bookmarksCount === 0, action: onNextBookmark },
          { label: t('Clear Bookmarks'), icon: 'ClearBookmark', shortcut: 'Ctrl+K, Ctrl+L', disabled: bookmarksCount === 0, action: onClearBookmarks },
          { separator: true },
          { label: t('Previous Bookmark With Same Label'), icon: 'PreviousBookmarkInFolder', disabled: bookmarksCount === 0, action: onPreviousBookmarkWithSameLabel },
          { label: t('Next Bookmark With Same Label'), icon: 'NextBookmarkInFolder', disabled: bookmarksCount === 0, action: onNextBookmarkWithSameLabel },
          { separator: true },
          { label: t('Previous Bookmark In Document'), icon: 'PreviousBookmarkInFile', disabled: bookmarksCount === 0, action: onPreviousBookmarkInDocument },
          { label: t('Next Bookmark In Document'), icon: 'NextBookmarkInFile', disabled: bookmarksCount === 0, action: onNextBookmarkInDocument },
          { label: t('Clear All Bookmarks In Document'), disabled: bookmarksCount === 0, action: onClearBookmarksInDocument },
        ],
      },
      { separator: true },
      { label: t('Options...'), icon: 'Settings', action: () => onShowOptions('environment') },
    ],
    [t('Debug')]: [
      {
        label: t('Window'),
        submenu: [
          { label: t('Breakpoints'), icon: 'BreakpointsWindow', shortcut: 'Ctrl+Alt+B', checked: visibleToolWindows.has('breakpoints'), action: onShowBreakpoints },
          { label: t('Module Breakpoints'), icon: 'ModulePublic', checked: visibleToolWindows.has('module-breakpoints'), action: onShowModuleBreakpoints },
          { label: t('Exception Settings'), icon: 'ExceptionSettings', shortcut: 'Ctrl+Alt+E', checked: visibleToolWindows.has('exception-settings'), action: onShowExceptionSettings },
          { label: t('Output'), icon: 'Output', shortcut: 'Alt+2', checked: visibleToolWindows.has('output'), action: onShowOutput },
          ...(isDebugging ? [
            { separator: true },
            // dnSpy's Watch and Memory entries are submenus of their four numbered windows.
            {
              label: t('Watch'),
              icon: 'Watch',
              submenu: [1, 2, 3, 4].map((number) => {
                const id = number === 1 ? 'watch' : `watch-${number}`
                return { label: t('Watch {number}', { number }), icon: 'Watch', shortcut: `Ctrl+Alt+W, ${number}`, checked: visibleToolWindows.has(id), action: number === 1 ? onShowWatch : () => onShowToolWindow?.(id) }
              }),
            },
            { label: t('Autos'), icon: 'AutosWindow', shortcut: 'Ctrl+Alt+V, A', checked: visibleToolWindows.has('autos'), action: onShowAutos },
            { label: t('Locals'), icon: 'LocalsWindow', shortcut: 'Alt+4', checked: visibleToolWindows.has('locals'), action: onShowLocals },
            { label: t('Static Fields'), icon: 'FieldShortcut', checked: visibleToolWindows.has('static-fields'), action: onShowStaticFields },
            { separator: true },
            { label: t('Call Stack'), icon: 'CallStackWindow', shortcut: 'Ctrl+Alt+C', checked: visibleToolWindows.has('callstack'), action: onShowCallStack },
            { label: t('Threads'), icon: 'Thread', shortcut: 'Ctrl+Alt+H', checked: visibleToolWindows.has('threads'), action: onShowThreads },
            { label: t('Modules'), icon: 'ModulesWindow', shortcut: 'Ctrl+Alt+U', checked: visibleToolWindows.has('modules'), action: onShowModules },
            { label: t('Processes'), icon: 'Process', shortcut: 'Ctrl+Alt+Z', checked: visibleToolWindows.has('processes'), action: onShowProcesses },
            { separator: true },
            {
              label: t('Memory'),
              icon: 'MemoryWindow',
              submenu: [1, 2, 3, 4].map((number) => {
                const id = number === 1 ? 'memory' : `memory-${number}`
                return { label: t('Memory {number}', { number }), icon: 'MemoryWindow', shortcut: number === 1 ? 'Alt+6' : `Ctrl+Alt+M, ${number}`, checked: visibleToolWindows.has(id), action: number === 1 ? onShowMemory : () => onShowToolWindow?.(id) }
              }),
            },
            { label: t('Disassembly'), icon: 'DisassemblyWindow', shortcut: 'Alt+8', disabled: canShowDisassembly === false, action: onShowDisassembly },
          ] : []),
        ],
      },
      { separator: true },
      { label: debugState === 'stopped' ? t('Continue') : t('Start Debugging...'), icon: 'Run', shortcut: 'F5', disabled: !debugAvailable || (debugState !== 'inactive' && debugState !== 'stopped'), action: debugState === 'stopped' ? onContinueDebug : onStartDebug },
      ...(onStartWithoutDebugging ? [{ label: t('Start Without Debugging...'), icon: 'RunOutline', shortcut: 'Ctrl+F5', disabled: false, action: onStartWithoutDebugging }] : []),
      // Attach to Process is always there: in the start group before debugging, after Restart while debugging.
      ...(!isDebugging ? [{ label: t('Attach to Process...'), icon: 'Process', shortcut: 'Ctrl+Alt+P', disabled: !debugAvailable, action: onAttachDebug }] : []),
      // DebuggerMenuCommands' continue group: the commands that act on the session as a whole, shown while one runs.
      ...(isDebugging ? [
        { label: t('Break All'), icon: 'Pause', shortcut: 'Ctrl+Alt+Break', disabled: debugState !== 'running', action: onPauseDebug },
        { label: t('Stop Debugging'), icon: 'Stop', shortcut: 'Shift+F5', disabled: false, action: onStopDebug },
        ...(onDetachDebug ? [{ label: t('Detach All'), disabled: false, action: onDetachDebug }] : []),
        ...(onTerminateDebug ? [{ label: t('Terminate All'), icon: 'TerminateProcess', disabled: false, action: onTerminateDebug }] : []),
        ...(onRestartDebug ? [{ label: t('Restart'), icon: 'Restart', shortcut: 'Ctrl+Shift+F5', disabled: !canRestartDebug, action: onRestartDebug }] : []),
        { label: t('Attach to Process...'), icon: 'Process', shortcut: 'Ctrl+Alt+P', disabled: !debugAvailable, action: onAttachDebug },
        { separator: true },
        ...(onStepCurrentProcess && showCurrentProcessSteps ? [
          { label: t('Step Into (Current Process)'), icon: 'StepInto', shortcut: 'Ctrl+Alt+F11', disabled: debugState !== 'stopped', action: () => onStepCurrentProcess('stepIn') },
          { label: t('Step Over (Current Process)'), icon: 'StepOver', shortcut: 'Ctrl+Alt+F10', disabled: debugState !== 'stopped', action: () => onStepCurrentProcess('next') },
          { label: t('Step Out (Current Process)'), icon: 'StepOut', shortcut: 'Ctrl+Shift+Alt+F11', disabled: debugState !== 'stopped', action: () => onStepCurrentProcess('stepOut') },
          { separator: true },
        ] : []),
        ...(onShowNextStatement ? [{ label: t('Show Next Statement'), icon: 'GoToNext', shortcut: 'Alt+Num *', disabled: debugState !== 'stopped', action: onShowNextStatement }] : []),
        { label: t('Step Into'), icon: 'StepInto', shortcut: 'F11', disabled: debugState !== 'stopped', action: onStepIn },
        { label: t('Step Over'), icon: 'StepOver', shortcut: 'F10', disabled: debugState !== 'stopped', action: onStepOver },
        { label: t('Step Out'), icon: 'StepOut', shortcut: 'Shift+F11', disabled: debugState !== 'stopped', action: onStepOut },
      ] : []),
      { separator: true },
      { label: t('Toggle Breakpoint'), shortcut: 'F9', disabled: !canToggleBreakpoint, action: onToggleBreakpoint },
      ...(hasFunctionBreakpoints ? [
        { label: t('Delete All Breakpoints'), icon: 'ClearBreakpointGroup', shortcut: 'Ctrl+Shift+F9', action: onDeleteAllBreakpoints },
      ] : []),
      ...(canEnableAllBreakpoints ? [
        { label: t('Enable All Breakpoints'), icon: 'EnableAllBreakpoints', action: onEnableAllBreakpoints },
      ] : []),
      ...(canDisableAllBreakpoints ? [
        { label: t('Disable All Breakpoints'), icon: 'DisableAllBreakpoints', action: onDisableAllBreakpoints },
      ] : []),
      { separator: true },
      { label: t('Options...'), icon: 'Settings', action: () => onShowOptions('debugger') },
    ],
    [t('Window')]: [
      { label: t('New Window'), icon: 'NewWindow', shortcut: 'Ctrl+N', disabled: !canNewWindow, action: onNewWindow },
      { label: t('Close'), shortcut: 'Ctrl+F4', disabled: !canCloseWindow, action: onCloseWindow },
      // Close All Tabs keeps its group non-empty, so this separator is unconditional like WPF's.
      { separator: true },
      ...windowTabGroupItemsWithCloseAll,
      ...(windowTabGroupCloseItems.length > 0 ? [{ separator: true }, ...windowTabGroupCloseItems] : []),
      ...(windowTabGroupOrientationItems.length > 0 ? [{ separator: true }, ...windowTabGroupOrientationItems] : []),
      ...(windowTabItems.length > 0 ? [{ separator: true }, ...windowTabItems] : []),
    ],
    [t('Help')]: [
      // dnSpy's Help menu, in its order and with its wording: the release, the issues, the wiki and the
      // source, then About at the end (AboutCommands).
      { label: t('Latest Release'), action: () => openExternal(`${repositoryUrl}/releases/latest`) },
      { label: t('Issues'), action: () => openExternal(`${repositoryUrl}/issues`) },
      { label: t('Wiki'), action: () => openExternal(`${repositoryUrl}/wiki`) },
      { label: t('Source Code'), action: () => openExternal(repositoryUrl) },
      { separator: true },
      { label: t('About dnSpy'), action: onAbout },
    ],
  }

  useEffect(() => {
    const close = (event: PointerEvent): void => {
      if (!host.current?.contains(event.target as Node))
        setOpenMenu(undefined)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [])

  // The menu bar is operated from the keyboard the way dnSpy's is (a WPF menu, so the whole of it): Alt
  // opens the first menu and closes whatever is open, Alt and a letter opens the menu that letter names, the
  // left and right arrows walk along the open menus, and Escape closes. Inside a menu the entries are
  // buttons, so Tab walks them and Enter runs one.
  const menuNamesRef = useRef<string[]>([])
  menuNamesRef.current = Object.keys(menus)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const editingText = (event.target as HTMLElement | null)?.matches('input, textarea, [contenteditable="true"]') ?? false
      if (editingText)
        return
      const names = menuNamesRef.current
      if (openMenu) {
        if (event.key === 'Escape') {
          event.preventDefault()
          setOpenMenu(undefined)
          return
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          const step = event.key === 'ArrowRight' ? 1 : -1
          const index = names.indexOf(openMenu)
          event.preventDefault()
          setOpenMenu(names[(index + step + names.length) % names.length])
          return
        }
      }
      // A bare Alt drops the menu bar down; pressing it again puts it away, as the same key does in WPF.
      if (event.key === 'Alt' && !event.ctrlKey && !event.shiftKey) {
        event.preventDefault()
        setOpenMenu((current) => (current ? undefined : names[0]))
        return
      }
      // Alt and a letter — the mnemonics dnSpy's menu headers carry — opens the menu it names.
      if (!event.altKey || event.ctrlKey || !event.code.startsWith('Key'))
        return
      const letter = event.code.slice(3).toLowerCase()
      const target = names.find((name) => name.toLowerCase().startsWith(letter))
      if (!target)
        return
      event.preventDefault()
      setOpenMenu(target)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openMenu])

  const closeMenu = (): void => setOpenMenu(undefined)

  return (
    <div className="menu-bar" role="menubar" ref={host}>
      {Object.entries(menus).map(([name, items]) => (
        <div
          className="menu-root"
          key={name}
          // The debugger's legacy Windows submenu and the top-level Window menu share a label. Hide the
          // inactive top-level entry from the accessibility tree while Debug is open so keyboard and
          // screen-reader navigation follows the submenu that is currently displayed.
          aria-hidden={openMenu === t('Debug') && name === t('Window') ? true : undefined}
        >
          <button
            role="menuitem"
            className={openMenu === name ? 'active' : ''}
            onClick={() => setOpenMenu(openMenu === name ? undefined : name)}
            onPointerEnter={() => { if (openMenu) setOpenMenu(name) }}
          >
            {name}
          </button>
          {openMenu === name && (
            <MenuPopup items={items} onClose={closeMenu} />
          )}
        </div>
      ))}
      <WindowControls />
    </div>
  )
}

export const MenuPopup = ({ items, onClose, depth = 0 }: { items: MenuItem[]; onClose: () => void; depth?: number }): React.JSX.Element => {
  const [openIndex, setOpenIndex] = useState<number | undefined>()
  return (
    <div className={depth === 0 ? 'menu-popup' : 'menu-popup menu-submenu'} role="menu">
      {items.map((item, index) => {
        if (item.separator)
          return <div className="menu-separator" role="separator" key={`sep:${depth}:${index}`} />
        if (item.submenu) {
          return (
            <div className="menu-item-row" key={`sub:${depth}:${index}`} onPointerEnter={() => setOpenIndex(index)} onPointerLeave={() => setOpenIndex(undefined)}>
              <button
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={openIndex === index}
                className={`menu-item${openIndex === index ? ' menu-item-open' : ''}`}
                disabled={item.disabled}
                onClick={() => setOpenIndex(openIndex === index ? undefined : index)}
              >
                <span className="menu-check"><MenuEntryIcon name={item.icon} checked={item.checked} /></span>
                <span>{item.label}</span>
                <span className="menu-shortcut menu-submenu-arrow"><SubmenuArrowGlyph /></span>
              </button>
              {openIndex === index && item.submenu.length > 0 && (
                <MenuPopup items={item.submenu} onClose={onClose} depth={depth + 1} />
              )}
            </div>
          )
        }
        return (
          <button
            role="menuitem"
            aria-checked={item.checked === undefined ? undefined : item.checked}
            className="menu-item"
            disabled={item.disabled}
            key={`it:${depth}:${index}`}
            onPointerEnter={() => setOpenIndex(undefined)}
            onClick={() => { onClose(); item.action?.() }}
          >
            <span className="menu-check"><MenuEntryIcon name={item.icon} checked={item.checked} /></span>
            <span>{item.label}</span>
            <span className="menu-shortcut">{item.shortcut}</span>
          </button>
        )
      })}
    </div>
  )
}
