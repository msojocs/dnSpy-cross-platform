import type { HexBodyKind } from '../app-store'
import type { HexRange, HexTargetResponse } from '../../../shared/protocol'
import type { TranslationValues } from '../localization'
import { hexMenuEntries, type HexShowKind } from './hex-menu'

export type { HexShowKind }

export interface MenuItem {
  label?: string
  shortcut?: string
  disabled?: boolean
  checked?: boolean
  separator?: boolean
  submenu?: MenuItem[]
  action?: () => void
}

/** The tab component the Edit menu's hex groups key off, mirroring dnSpy's hex/metadata-table documents. */
export type ActiveDocument = 'code' | 'hex' | 'module-info' | null

export interface EditMenuContext {
  t(message: string, values?: TranslationValues): string
  hasWorkspace: boolean
  /** `selectedNode.kind`, or undefined with nothing selected in the assembly explorer. */
  selectionKind?: string
  /** `selectedNode.label`, used by the dynamic "Delete {name}" / "Remove {name}" headers. */
  selectionLabel?: string
  activeDocument: ActiveDocument
  /**
   * Whether a code document is open in a viewer. dnSpy's Edit-menu hex commands fall back to the file the
   * active document belongs to when the tree's selection names no file of its own, and a hex or
   * metadata-table document is not a viewer, so only a code document counts.
   */
  documentAvailable: boolean
  canUndo: boolean
  canRedo: boolean
  /**
   * Whether the module holding the selected namespace already has an empty namespace node. dnSpy
   * offers "Move Types to Empty Namespace" only when there is somewhere to move them to.
   */
  hasEmptyNamespaceSibling: boolean
  onUndo(): void
  onRedo(): void
  onFind(): void
  onSearchAssemblies(): void
  onFindStringReferences(): void
  onEditMethodBody(): void
  onEditResource(): void
  onDelete(): void
  onRenameNamespace(): void
  onMoveTypesToEmptyNamespace(): void
  /** Converts the selected module into a net module, dropping the assembly around it. */
  onConvertModule(): void
  /** Opens the assemblies the selected node's module references name. The recursive form walks the whole
   *  closure instead of stopping at the module's own references; dnSpy registers both on this menu as
   *  well as on the tree's. */
  onLoadDependencies(recursive: boolean): void
  onReplaceMethodBodyWithStub(): void
  /** Opens the create dialog for a node of this kind, in the type the selection belongs to. A nested
   * type goes inside the selected type instead of at the top level, which is the one create command with
   * two forms: dnSpy has one command for each of them. */
  onCreateMember(kind: CreatedKind, nested?: boolean): void
  /** Opens the edit dialog for the selected node, which is also what Alt+Enter does. */
  onEditNode(): void
  /**
   * Where the hex commands point for the selected node. dnSpy resolves this from the selection itself;
   * here the backend answers it when the selection changes, so the menu only has to read it.
   */
  hexTarget?: HexTargetResponse
  /** The statement under the caret of the focused code document, which is what "Show Instructions in
   * Hex Editor" acts on when the selection is not a method. */
  hexStatement?: { moduleId: string; range: HexRange }
  /** Opens the selected module in a hex tab. */
  onOpenHex(): void
  /** Opens the module in a hex tab and jumps to the bytes of this part of the selection. */
  onShowHexAt(kind: HexShowKind): void
  onHexWriteBody(kind: HexBodyKind): void
  onHexCopyBody(): void
  onHexPasteBody(): void
}

/** The kinds a create command produces — one entry per command of dnSpy's New group. */
export type CreatedKind = 'type' | 'method' | 'field' | 'property' | 'event'

interface EditEntry {
  group: number
  order: number
  label(ctx: EditMenuContext): string
  shortcut?: string
  visible(ctx: EditMenuContext): boolean
  /** Only consulted for entries that have an action; entries without one render disabled. */
  enabled?(ctx: EditMenuContext): boolean
  action?(ctx: EditMenuContext): void
}

// dnSpy's group order constants (dnSpy.Contracts.DnSpy/Menus/MenuConstants.cs): the numeric prefix
// sorts the groups inside the Edit menu. Empty groups contribute nothing, not even a separator — the
// same rule MenuService.CreateMenuItems applies.
const GROUP_UNDO = 0
const GROUP_FIND = 1000
const GROUP_DELETE = 2000
const GROUP_MISC = 3000
const GROUP_NEW = 4000
const GROUP_SETTINGS = 5000
const GROUP_HEX = 6000
const GROUP_HEX_MD = 7000
const GROUP_HEX_GOTO_MD = 8000
const GROUP_HEX_COPY = 9000

const always = (): boolean => true
// Items dnSpy shows only for node types this port has no equivalent of (nested netmodules, address
// references into a hex editor). They stay in the table so the menu keeps WPF's shape, but never show.
const never = (): boolean => false

const kindIs = (...kinds: string[]) => (ctx: EditMenuContext): boolean =>
  ctx.selectionKind !== undefined && kinds.includes(ctx.selectionKind)

const documentIs = (document: ActiveDocument) => (ctx: EditMenuContext): boolean => ctx.activeDocument === document

/** Node kinds that live inside a module — dnSpy's `GetModuleNode(node) is not null`. The assembly root
 *  counts: its helper answers with the module child of whatever it is handed, so selecting the root is
 *  selecting the module it holds, which is what every entry gated on this acts on. */
const inModule = kindIs('assembly', 'module', 'namespace', 'type', 'method', 'field', 'property', 'event', 'resource', 'resourceentry')

/**
 * Node kinds whose reference is an `IMemberDef` (type or member). The C# class commands need it, and
 * so do dnSpy's five member-creating commands: their CanExecute is "the selected node is a TypeNode,
 * or its parent is one" (MethodDefCommands.cs:339, FieldDefCommands.cs:229, PropertyDefCommands.cs:247,
 * EventDefCommands.cs:252, TypeDefCommands.cs:339 for Create Nested Type). A member in this port's
 * tree always hangs off a type, so the node kinds alone express that rule exactly.
 */
const isMember = kindIs('type', 'method', 'field', 'property', 'event')

/** The header of dnSpy's "Delete X" commands: one node shows its name, several show a count. */
const deleteLabel = (ctx: EditMenuContext): string => ctx.t('Delete {name}', { name: ctx.selectionLabel ?? '' })

/** dnSpy removes each deletable node type through its own command; this port acts on the selection. */
const deleteSelected = (ctx: EditMenuContext): void => ctx.onDelete()

/** The shared hex group, wearing this menu's entry shape. `EditMenuContext` carries everything the hex
 *  entries read, so their predicates and actions drop straight in. */
const HEX_ENTRIES: EditEntry[] = hexMenuEntries.map((entry) => ({
  group: GROUP_HEX,
  order: entry.order,
  label: entry.label,
  shortcut: entry.shortcut,
  visible: entry.visible,
  action: entry.run,
}))

// dnSpy's "Show in Hex Editor" / "Edit Resource..." commands are registered once per node subtype and
// are mutually exclusive, so only one is ever on screen. This port can't tell those subtypes apart, so
// the table keeps the first of each label and drops the rest rather than printing duplicates.
const EDIT_ENTRIES: EditEntry[] = [
  // 0 — Undo/Redo
  { group: GROUP_UNDO, order: 0, label: (ctx) => ctx.t('Undo'), shortcut: 'Ctrl+Z', visible: always, enabled: (ctx) => ctx.canUndo, action: (ctx) => ctx.onUndo() },
  { group: GROUP_UNDO, order: 10, label: (ctx) => ctx.t('Redo'), shortcut: 'Ctrl+Y', visible: always, enabled: (ctx) => ctx.canRedo, action: (ctx) => ctx.onRedo() },

  // 1000 — Find
  { group: GROUP_FIND, order: 0, label: (ctx) => ctx.t('Find'), shortcut: 'Ctrl+F', visible: always, enabled: (ctx) => ctx.activeDocument === 'code', action: (ctx) => ctx.onFind() },
  { group: GROUP_FIND, order: 10, label: (ctx) => ctx.t('Search Assemblies'), shortcut: 'Ctrl+Shift+K', visible: always, enabled: (ctx) => ctx.hasWorkspace, action: (ctx) => ctx.onSearchAssemblies() },
  { group: GROUP_FIND, order: 20, label: (ctx) => ctx.t('Find String References in Module'), visible: inModule, enabled: (ctx) => ctx.hasWorkspace, action: (ctx) => ctx.onFindStringReferences() },

  // 2000 — AsmEditor: Delete
  // RemoveAssemblyCommand.EditMenuCommand: the selection's documents, which are the tree's root rows.
  { group: GROUP_DELETE, order: 0, label: (ctx) => ctx.t('Remove {name}', { name: ctx.selectionLabel ?? '' }), shortcut: 'Del', visible: kindIs('assembly', 'pedocument', 'elfdocument', 'unknowndocument'), action: deleteSelected },
  { group: GROUP_DELETE, order: 10, label: (ctx) => ctx.t('Remove NetModule from Assembly'), shortcut: 'Del', visible: never },
  { group: GROUP_DELETE, order: 20, label: deleteLabel, shortcut: 'Del', visible: kindIs('type'), action: deleteSelected },
  { group: GROUP_DELETE, order: 30, label: deleteLabel, shortcut: 'Del', visible: kindIs('method'), action: deleteSelected },
  { group: GROUP_DELETE, order: 40, label: deleteLabel, shortcut: 'Del', visible: kindIs('field'), action: deleteSelected },
  { group: GROUP_DELETE, order: 50, label: deleteLabel, shortcut: 'Del', visible: kindIs('property'), action: deleteSelected },
  { group: GROUP_DELETE, order: 60, label: deleteLabel, shortcut: 'Del', visible: kindIs('event'), action: deleteSelected },
  { group: GROUP_DELETE, order: 70, label: (ctx) => ctx.t('Delete Namespace'), shortcut: 'Del', visible: kindIs('namespace'), action: deleteSelected },
  { group: GROUP_DELETE, order: 80, label: deleteLabel, shortcut: 'Del', visible: kindIs('resource'), action: deleteSelected },
  { group: GROUP_DELETE, order: 90, label: deleteLabel, shortcut: 'Del', visible: kindIs('resourceentry') },

  // 3000 — AsmEditor: Misc
  { group: GROUP_MISC, order: 0, label: (ctx) => ctx.t('Move Types to Empty Namespace'), visible: (ctx) => ctx.selectionKind === 'namespace' && ctx.selectionLabel !== '-' && ctx.hasEmptyNamespaceSibling, action: (ctx) => ctx.onMoveTypesToEmptyNamespace() },
  { group: GROUP_MISC, order: 10, label: (ctx) => ctx.t('Rename Namespace'), visible: kindIs('namespace'), action: (ctx) => ctx.onRenameNamespace() },
  { group: GROUP_MISC, order: 20, label: (ctx) => ctx.t('Convert NetModule to Assembly'), visible: never },
  // dnSpy shows the reverse of this one on a module document standing on its own — a module whose parent
  // is not an assembly row. Every module in this tree hangs off an assembly row, so that rule would never
  // match anything; the conversion this port can run is the one that drops the assembly, and Undo is the
  // way back.
  { group: GROUP_MISC, order: 30, label: (ctx) => ctx.t('Convert Assembly to NetModule'), visible: kindIs('module'), action: (ctx) => ctx.onConvertModule() },

  // 4000 — AsmEditor: New
  { group: GROUP_NEW, order: 0, label: (ctx) => ctx.t('Create Assembly...'), visible: (ctx) => ctx.selectionKind === undefined || ctx.selectionKind === 'module' },
  { group: GROUP_NEW, order: 10, label: (ctx) => ctx.t('Add New NetModule to Assembly...'), visible: never },
  { group: GROUP_NEW, order: 20, label: (ctx) => ctx.t('Add Existing NetModule to Assembly...'), visible: never },
  { group: GROUP_NEW, order: 30, label: (ctx) => ctx.t('Create NetModule...'), visible: never },
  { group: GROUP_NEW, order: 40, label: (ctx) => ctx.t('Create Type...'), visible: kindIs('type', 'namespace', 'module'), action: (ctx) => ctx.onCreateMember('type') },
  { group: GROUP_NEW, order: 50, label: (ctx) => ctx.t('Create Nested Type...'), visible: isMember, action: (ctx) => ctx.onCreateMember('type', true) },
  { group: GROUP_NEW, order: 60, label: (ctx) => ctx.t('Create Method...'), visible: isMember, action: (ctx) => ctx.onCreateMember('method') },
  { group: GROUP_NEW, order: 70, label: (ctx) => ctx.t('Create Field...'), visible: isMember, action: (ctx) => ctx.onCreateMember('field') },
  { group: GROUP_NEW, order: 80, label: (ctx) => ctx.t('Create Property...'), visible: isMember, action: (ctx) => ctx.onCreateMember('property') },
  { group: GROUP_NEW, order: 90, label: (ctx) => ctx.t('Create Event...'), visible: isMember, action: (ctx) => ctx.onCreateMember('event') },
  { group: GROUP_NEW, order: 100, label: (ctx) => ctx.t('Create File Resource...'), visible: kindIs('resource', 'resourceentry') },
  { group: GROUP_NEW, order: 110, label: (ctx) => ctx.t('Create Multi File Resource...'), visible: kindIs('resource', 'resourceentry') },
  { group: GROUP_NEW, order: 120, label: (ctx) => ctx.t('Create Assembly Linked Resource...'), visible: kindIs('resource', 'resourceentry') },
  { group: GROUP_NEW, order: 130, label: (ctx) => ctx.t('Create File Linked Resource...'), visible: kindIs('resource', 'resourceentry') },
  { group: GROUP_NEW, order: 140, label: (ctx) => ctx.t('Create System.Data.Bitmap/Icon Resource...'), visible: kindIs('resource', 'resourceentry') },
  { group: GROUP_NEW, order: 150, label: (ctx) => ctx.t('Create System.Windows.Forms.ImageListStreamer Resource...'), visible: kindIs('resource', 'resourceentry') },
  { group: GROUP_NEW, order: 170, label: (ctx) => ctx.t('Create Byte Array Resource...'), visible: kindIs('resource', 'resourceentry') },
  { group: GROUP_NEW, order: 180, label: (ctx) => ctx.t('Create System.IO.Stream Resource...'), visible: kindIs('resource', 'resourceentry') },
  { group: GROUP_NEW, order: 190, label: (ctx) => ctx.t('Create Resource...'), visible: kindIs('resource', 'resourceentry') },

  // 5000 — AsmEditor: Settings
  { group: GROUP_SETTINGS, order: 0, label: (ctx) => ctx.t('Edit Assembly...'), shortcut: 'Alt+Enter', visible: kindIs('module') },
  { group: GROUP_SETTINGS, order: 10, label: (ctx) => ctx.t('Edit Module...'), shortcut: 'Alt+Enter', visible: kindIs('module') },
  { group: GROUP_SETTINGS, order: 20, label: (ctx) => ctx.t('Edit Type...'), shortcut: 'Alt+Enter', visible: kindIs('type'), action: (ctx) => ctx.onEditNode() },
  { group: GROUP_SETTINGS, order: 30, label: (ctx) => ctx.t('Edit Method...'), shortcut: 'Alt+Enter', visible: kindIs('method'), action: (ctx) => ctx.onEditNode() },
  { group: GROUP_SETTINGS, order: 40, label: (ctx) => ctx.t('Edit Method ({language})...', { language: 'C#' }), visible: kindIs('method') },
  { group: GROUP_SETTINGS, order: 41, label: (ctx) => ctx.t('Edit Assembly Attributes ({language})...', { language: 'C#' }), visible: kindIs('module') },
  { group: GROUP_SETTINGS, order: 42, label: (ctx) => ctx.t('Edit Class ({language})...', { language: 'C#' }), visible: isMember },
  { group: GROUP_SETTINGS, order: 43, label: (ctx) => ctx.t('Add Class Members ({language})...', { language: 'C#' }), visible: isMember },
  { group: GROUP_SETTINGS, order: 44, label: (ctx) => ctx.t('Add Class ({language})...', { language: 'C#' }), visible: inModule },
  // dnSpy's merge runs its compiled-module importer over a picked DLL, merging every type it holds into
  // this module. That importer is the machinery behind the C# compile commands and the port has neither
  // it nor a dnlib merger to stand in for it, so the entry keeps its place and stays disabled rather than
  // offering a command that would corrupt the module it was run on.
  { group: GROUP_SETTINGS, order: 49.999, label: (ctx) => ctx.t('Merge with Assembly...'), visible: inModule },
  { group: GROUP_SETTINGS, order: 50, label: (ctx) => ctx.t('Edit Field...'), shortcut: 'Alt+Enter', visible: kindIs('field'), action: (ctx) => ctx.onEditNode() },
  { group: GROUP_SETTINGS, order: 50, label: (ctx) => ctx.t('Edit Method Body...'), visible: kindIs('method'), action: (ctx) => ctx.onEditMethodBody() },
  { group: GROUP_SETTINGS, order: 51, label: (ctx) => ctx.t('Replace Method Body with stub...'), visible: kindIs('method'), action: (ctx) => ctx.onReplaceMethodBodyWithStub() },
  { group: GROUP_SETTINGS, order: 58.999, label: (ctx) => ctx.t('Load Dependencies'), visible: inModule, action: (ctx) => ctx.onLoadDependencies(false) },
  { group: GROUP_SETTINGS, order: 59.999, label: (ctx) => ctx.t('Load Dependencies Recursively'), visible: inModule, action: (ctx) => ctx.onLoadDependencies(true) },
  { group: GROUP_SETTINGS, order: 60, label: (ctx) => ctx.t('Edit Property...'), shortcut: 'Alt+Enter', visible: kindIs('property'), action: (ctx) => ctx.onEditNode() },
  { group: GROUP_SETTINGS, order: 70, label: (ctx) => ctx.t('Edit Event...'), shortcut: 'Alt+Enter', visible: kindIs('event'), action: (ctx) => ctx.onEditNode() },
  { group: GROUP_SETTINGS, order: 90, label: (ctx) => ctx.t('Edit Resource...'), shortcut: 'Alt+Enter', visible: kindIs('resource'), action: (ctx) => ctx.onEditResource() },
  { group: GROUP_SETTINGS, order: 100, label: (ctx) => ctx.t('Edit Resource...'), shortcut: 'Alt+Enter', visible: kindIs('resourceentry') },

  // 6000 — Hex editor. The entries live in hex-menu.ts, shared with the code viewer's context menu,
  // which shows the same group.
  ...HEX_ENTRIES,

  // 7000 — Metadata table document
  { group: GROUP_HEX_MD, order: 0, label: (ctx) => ctx.t('Sort Table'), shortcut: 'Ctrl+Shift+T', visible: documentIs('module-info') },
  { group: GROUP_HEX_MD, order: 10, label: (ctx) => ctx.t('Sort Selection'), visible: documentIs('module-info') },
  { group: GROUP_HEX_MD, order: 20, label: (ctx) => ctx.t('Go to RID...'), shortcut: 'Ctrl+G', visible: documentIs('module-info') },
  { group: GROUP_HEX_MD, order: 30, label: (ctx) => ctx.t('Show in Hex Editor'), shortcut: 'Ctrl+X', visible: documentIs('module-info') },

  // 8000 — Go to metadata table row. dnSpy's second entry embeds the token under the caret in its
  // header (`Go to MD Table Row (06000001)`); with no token model here only the plain one is kept.
  { group: GROUP_HEX_GOTO_MD, order: 0, label: (ctx) => ctx.t('Go to MD Table Row...'), shortcut: 'Ctrl+Shift+D', visible: documentIs('hex') },

  // 9000 — Metadata table copy/paste
  { group: GROUP_HEX_COPY, order: 0, label: (ctx) => ctx.t('Copy as Text'), shortcut: 'Ctrl+Shift+C', visible: documentIs('module-info') },
  { group: GROUP_HEX_COPY, order: 10, label: (ctx) => ctx.t('Copy'), shortcut: 'Ctrl+C', visible: documentIs('module-info') },
  { group: GROUP_HEX_COPY, order: 20, label: (ctx) => ctx.t('Paste'), shortcut: 'Ctrl+V', visible: documentIs('module-info') },
]

/**
 * Builds dnSpy's Edit menu: every entry whose visibility rule matches, sorted by group then order,
 * with a separator between each non-empty group. Entries with no action are the commands this port
 * has not implemented yet — they keep their place in the menu and render disabled.
 */
export const buildEditMenu = (ctx: EditMenuContext): MenuItem[] => {
  const groups = new Map<number, EditEntry[]>()
  for (const entry of EDIT_ENTRIES) {
    if (!entry.visible(ctx))
      continue
    const entries = groups.get(entry.group)
    if (entries)
      entries.push(entry)
    else
      groups.set(entry.group, [entry])
  }

  const items: MenuItem[] = []
  for (const group of [...groups.keys()].sort((a, b) => a - b)) {
    if (items.length > 0)
      items.push({ separator: true })
    // Array.prototype.sort is stable, so entries sharing an order keep their table order.
    for (const entry of groups.get(group)!.sort((a, b) => a.order - b.order)) {
      const action = entry.action
      items.push({
        label: entry.label(ctx),
        shortcut: entry.shortcut,
        disabled: action ? entry.enabled?.(ctx) === false : true,
        action: action ? () => action(ctx) : undefined,
      })
    }
  }
  return items
}
