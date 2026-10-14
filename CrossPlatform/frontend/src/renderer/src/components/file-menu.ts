import type { MenuItem } from './edit-menu'
import type { TranslationValues } from '../localization'

export interface FileMenuContext {
  t(message: string, values?: TranslationValues): string
  hasWorkspace: boolean
  /** Whether the workspace holds a module, which is what "Save Module..." acts on. */
  hasModule: boolean
  /** Whether an edit is unsaved. dnSpy gates Save and Save All on there being something to write. */
  dirty: boolean
  /** Whether the app already has elevated rights; "Restart as Administrator" only makes sense if not. */
  elevated: boolean
  /** The files the user opened before, most recent first — dnSpy's AssemblyExplorerMostRecentlyUsedList. */
  recentFiles: string[]
  onOpen(): void
  onOpenFromGac(): void
  onOpenList(): void
  onOpenRecent(path: string): void
  onSave(): void
  onSaveModule(): void
  onSaveAll(): void
  onReloadAll(): void
  onCloseAll(): void
  onCloseAllFramework(): void
  onCloseAllMissing(): void
  onSortAssemblies(): void
  onRestartAsAdministrator(): void
  onQuit(): void
}

interface FileEntry {
  group: number
  order: number
  label(ctx: FileMenuContext): string
  shortcut?: string
  /** dnSpy's IsVisible: the entry is left out of the menu altogether when this is false. */
  visible?(ctx: FileMenuContext): boolean
  /** Only consulted for entries that have an action or a submenu; the rest render disabled. */
  enabled?(ctx: FileMenuContext): boolean
  action?(ctx: FileMenuContext): void
  /** A submenu in place of an action — only "Recent Files" has one, and its entries are the sessions. */
  submenu?(ctx: FileMenuContext): MenuItem[]
}

// dnSpy's group order constants (dnSpy.Contracts.DnSpy/Menus/MenuConstants.cs). The numeric prefix sorts
// the groups, and a separator goes between them — the rule MenuService.CreateMenuItems applies.
const GROUP_SAVE = 0
const GROUP_OPEN = 1000
const GROUP_EXIT = 1000000

const always = (): boolean => true

/**
 * dnSpy's RecentFilesCommand: one entry per remembered file, numbered from 1 and naming the file by its whole
 * path, under the "Recent Files" submenu.
 */
const recentFiles = (ctx: FileMenuContext): MenuItem[] =>
  ctx.recentFiles.map((path, index) => ({
    label: `${index + 1} ${recentFileLabel(path)}`,
    action: () => ctx.onOpenRecent(path),
  }))

/** RecentFilesCommand.GetShortFilename: a path longer than a hundred characters keeps its last hundred. */
const MAX_RECENT_FILE_LABEL = 100
export const recentFileLabel = (path: string): string =>
  path.length > MAX_RECENT_FILE_LABEL ? `[...]${path.slice(path.length - MAX_RECENT_FILE_LABEL)}` : path

/**
 * dnSpy's File menu (AppMenus.cs + the ExportMenuItem registrations across dnSpy.Documents.Tabs,
 * dnSpy.AsmEditor and MainApp), in the order its Group and Order values give. Entries this port has no
 * command for — Export to Project, Close Old In-Memory Modules — keep dnSpy's place and render disabled,
 * so the menu still reads as dnSpy's.
 */
const FILE_ENTRIES: FileEntry[] = [
  // 0 — Save
  { group: GROUP_SAVE, order: 0, label: (ctx) => ctx.t('Export to Project...'), enabled: () => false },
  // "Save" is ApplicationCommands.Save, which has no Header of its own: the header is the command's own
  // text, and its gesture is SaveKey (Ctrl+S).
  { group: GROUP_SAVE, order: 10, label: (ctx) => ctx.t('Save'), shortcut: 'Ctrl+S', enabled: (ctx) => ctx.hasWorkspace && ctx.dirty, action: (ctx) => ctx.onSave() },
  { group: GROUP_SAVE, order: 20, label: (ctx) => ctx.t('Save Module...'), enabled: (ctx) => ctx.hasModule, action: (ctx) => ctx.onSaveModule() },
  { group: GROUP_SAVE, order: 30, label: (ctx) => ctx.t('Save All...'), shortcut: 'Ctrl+Shift+S', enabled: (ctx) => ctx.hasWorkspace && ctx.dirty, action: (ctx) => ctx.onSaveAll() },

  // 1000 — Open and the commands that work on what is open
  { group: GROUP_OPEN, order: 0, label: (ctx) => ctx.t('Open...'), shortcut: 'Ctrl+O', enabled: always, action: (ctx) => ctx.onOpen() },
  { group: GROUP_OPEN, order: 10, label: (ctx) => ctx.t('Open from GAC...'), shortcut: 'Ctrl+Shift+O', enabled: always, action: (ctx) => ctx.onOpenFromGac() },
  { group: GROUP_OPEN, order: 20, label: (ctx) => ctx.t('Open List...'), enabled: always, action: (ctx) => ctx.onOpenList() },
  { group: GROUP_OPEN, order: 30, label: (ctx) => ctx.t('Recent Files'), enabled: (ctx) => ctx.recentFiles.length > 0, submenu: recentFiles },
  { group: GROUP_OPEN, order: 40, label: (ctx) => ctx.t('Reload All Assemblies'), enabled: (ctx) => ctx.hasWorkspace, action: (ctx) => ctx.onReloadAll() },
  // Close All and Close Old In-Memory Modules share dnSpy's Order 50; the stable sort keeps this order.
  { group: GROUP_OPEN, order: 50, label: (ctx) => ctx.t('Close All'), enabled: (ctx) => ctx.hasWorkspace, action: (ctx) => ctx.onCloseAll() },
  { group: GROUP_OPEN, order: 50, label: (ctx) => ctx.t('Close Old In-Memory Modules'), enabled: () => false },
  { group: GROUP_OPEN, order: 55, label: (ctx) => ctx.t('Close All Framework Assemblies'), enabled: (ctx) => ctx.hasWorkspace, action: (ctx) => ctx.onCloseAllFramework() },
  { group: GROUP_OPEN, order: 60, label: (ctx) => ctx.t('Close All Missing Files'), enabled: (ctx) => ctx.hasWorkspace, action: (ctx) => ctx.onCloseAllMissing() },
  { group: GROUP_OPEN, order: 100, label: (ctx) => ctx.t('Sort Assemblies'), enabled: (ctx) => ctx.hasWorkspace, action: (ctx) => ctx.onSortAssemblies() },

  // 1000000 — Exit
  // dnSpy's RestartAsAdministratorCommand is visible only while the app is not already elevated,
  // and unlike the entries above it is never greyed: it is either there and clickable, or gone.
  { group: GROUP_EXIT, order: 900000, label: (ctx) => ctx.t('Restart as Administrator'), visible: (ctx) => !ctx.elevated, enabled: always, action: (ctx) => ctx.onRestartAsAdministrator() },
  { group: GROUP_EXIT, order: 1000000, label: (ctx) => ctx.t('Exit'), shortcut: 'Alt+F4', enabled: always, action: (ctx) => ctx.onQuit() },
]

export const buildFileMenu = (ctx: FileMenuContext): MenuItem[] => {
  const groups = new Map<number, FileEntry[]>()
  for (const entry of FILE_ENTRIES) {
    const entries = groups.get(entry.group)
    if (entries)
      entries.push(entry)
    else
      groups.set(entry.group, [entry])
  }

  const items: MenuItem[] = []
  for (const group of [...groups.keys()].sort((a, b) => a - b)) {
    // An entry the context hides is dropped before the separators are placed, so a group left with
    // nothing in it takes neither a rule nor a gap.
    const entries = groups.get(group)!.sort((a, b) => a.order - b.order).filter((entry) => entry.visible?.(ctx) !== false)
    if (entries.length === 0)
      continue
    if (items.length > 0)
      items.push({ separator: true })
    // Array.prototype.sort is stable, so entries sharing an order keep their table order.
    for (const entry of entries) {
      const submenu = entry.submenu?.(ctx)
      const action = entry.action
      items.push({
        label: entry.label(ctx),
        shortcut: entry.shortcut,
        disabled: submenu ? entry.enabled?.(ctx) === false : action ? entry.enabled?.(ctx) === false : true,
        submenu,
        action: action ? () => action(ctx) : undefined,
      })
    }
  }
  return items
}
