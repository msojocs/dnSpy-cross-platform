import type { HexBodyKind } from '../app-store'
import type { AddressReference, HexRange, HexTargetResponse, ResourceCreateKind } from '../../../shared/protocol'
import type { TranslationValues } from '../localization'
import type { TreeNode } from '../../../shared/protocol'
import { compilerCommandLanguage } from './compiler-language'
import { deleteHeader, deletionTargets } from './delete-commands'
import { hexMenuEntries, type HexShowKind } from './hex-menu'
import type { MetadataTableCommands } from '../metadata-table'

export type { HexShowKind }

export interface MenuItem {
  label?: string
  shortcut?: string
  disabled?: boolean
  checked?: boolean
  separator?: boolean
  /** The name of the dnSpy image the entry wears in its icon column (ds-images.generated.ts) — its
   *  ExportMenuItem's Icon. An entry dnSpy gives no image to leaves this out. */
  icon?: string
  submenu?: MenuItem[]
  action?: () => void
}

/** The tab component the Edit menu's hex groups key off, mirroring dnSpy's hex/metadata-table documents. */
export type ActiveDocument = 'code' | 'hex' | 'module-info' | 'md-table' | null

export interface EditMenuContext {
  t(message: string, values?: TranslationValues): string
  hasWorkspace: boolean
  /** `selectedNode.kind`, or undefined with nothing selected in the assembly explorer. */
  selectionKind?: string
  /** `selectedNode.label`, used by the dynamic "Delete {name}" / "Remove {name}" headers. */
  selectionLabel?: string
  /** Every selected row and the tree's parent links: a delete command takes the whole selection when it is all of
   *  the command's kind, and is headed by how many rows that is. */
  selection?: TreeNode[]
  parents?: Record<string, string>
  /** `selectedNode.icon`, which tells a .resources file from any other resource. */
  selectionIcon?: string
  /** The kind of the row above the selection, which tells a net module from a module. */
  selectionParentKind?: string
  /** The image of the row above the selection: an assembly root wears an assembly's, a module that stands on its
   *  own — a net module with no assembly — a module's. */
  selectionParentIcon?: string
  /** Where the selection is among its parent's rows; an assembly's manifest module is the first. */
  selectionIndexInParent?: number
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
  /** dnSpy's Edit Assembly / Edit Module windows. */
  onEditAssembly(): void
  onEditModule(): void
  /** The C# compiler commands — dnSpy's Edit Code windows. */
  onEditMethodCode(): void
  onEditClassCode(): void
  onAddClassMembersCode(): void
  onAddClassCode(): void
  onEditAssemblyAttributesCode(): void
  /** dnSpy's Merge with Assembly. */
  onMergeAssembly(): void
  /** Opens one of the Create ... Resource commands for the selection. */
  onCreateResource(kind: ResourceCreateKind): void
  /** Opens the New Resource command of a .resources file — dnSpy's "Create Resource...". */
  onCreateResourceElement(): void
  /** dnSpy's Create System.Data.Bitmap/Icon Resource and Create System.Windows.Forms.ImageListStreamer Resource. */
  onCreateImageResources(): void
  onCreateImageList(): void
  onDelete(): void
  onRenameNamespace(): void
  onMoveTypesToEmptyNamespace(): void
  /** Converts the selected module into a net module, dropping the assembly around it. */
  onConvertModule(toAssembly?: boolean): void
  /** dnSpy's Create Assembly, Create NetModule and the commands that add a net module to the selected assembly or
   *  take the selected one out of it. */
  onCreateAssembly?(): void
  onCreateNetModule?(): void
  onAddNewNetModule?(): void
  onAddExistingNetModule?(): void
  onRemoveNetModule?(): void
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
  /** The address reference under the code document's caret, which Show in Hex Editor opens. */
  addressReference?: AddressReference
  onShowAddress?(address: AddressReference): void
  /** Opens the selected module in a hex tab. */
  onOpenHex(): void
  /** Opens the module in a hex tab and jumps to the bytes of this part of the selection. */
  onShowHexAt(kind: HexShowKind): void
  onHexWriteBody(kind: HexBodyKind): void
  onHexCopyBody(): void
  onHexPasteBody(): void
  /** The commands of the metadata table document that last had the focus — dnSpy's MDTableContext. */
  mdTable?: MetadataTableCommands
  /** Whether Go to MD Table Row has a module to look in: the open code document's or the selection's, read from a
   *  file. */
  canGoToMdTableRow?: boolean
  /** The token of the selected row, which the second Go to MD Table Row entry goes to without asking. */
  mdTableRowToken?: number
  onGoToMdTableRow?(token?: number): void
}

/** The kinds a create command produces — one entry per command of dnSpy's New group. */
export type CreatedKind = 'type' | 'method' | 'field' | 'property' | 'event'

interface EditEntry {
  group: number
  order: number
  /** dnSpy's image for the entry, or none where its ExportMenuItem has no Icon; the compiler commands' depends on
   *  the language they are in. */
  icon?: string | ((ctx: EditMenuContext) => string)
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

/** The rows dnSpy calls DsDocumentNodes: a document root, and a module row. */
const DOCUMENT_KINDS = ['assembly', 'module', 'pedocument', 'elfdocument', 'unknowndocument']

/** An assembly root, as opposed to a root that is a module standing on its own. */
const isAssemblyRoot = (kind: string | undefined, icon: string | undefined): boolean => kind === 'assembly' && icon !== 'ModulePublic'

/** dnSpy's AddNetModuleToAssemblyCommand.CanExecute: one assembly row, or one module row under an assembly. */
const inAssembly = (ctx: EditMenuContext): boolean =>
  (ctx.selection?.length ?? 1) === 1 && (isAssemblyRoot(ctx.selectionKind, ctx.selectionIcon)
    || (ctx.selectionKind === 'module' && isAssemblyRoot(ctx.selectionParentKind, ctx.selectionParentIcon)))

/** RemoveNetModuleFromAssemblyCommand.IsVisible: one module row under an assembly. */
const isNetModuleRow = (ctx: EditMenuContext): boolean =>
  (ctx.selection?.length ?? 1) === 1 && ctx.selectionKind === 'module' && isAssemblyRoot(ctx.selectionParentKind, ctx.selectionParentIcon)

const kindIs = (...kinds: string[]) => (ctx: EditMenuContext): boolean =>
  ctx.selectionKind !== undefined && kinds.includes(ctx.selectionKind)

/**
 * Whether the selection is a .resources file or one of its entries, which is what dnSpy's element
 * commands require — `nodes[0] is ResourceElementSetNode || node.Parent is ResourceElementSetNode`.
 * The tree marks such a file by the folder image dnSpy gives it.
 */
const inResourcesFile = (ctx: EditMenuContext): boolean =>
  ctx.selectionKind === 'resourceentry' || (ctx.selectionKind === 'resource' && ctx.selectionIcon === 'SourceFileGroup')

/** Whether the selection can hold a manifest resource — the Resources folder, or a resource row. */
const canCreateResource = (ctx: EditMenuContext): boolean => kindIs('resource', 'resourceentry')(ctx) || ctx.selectionKind === 'resourcesgroup'

const documentIs = (document: ActiveDocument) => (ctx: EditMenuContext): boolean => ctx.activeDocument === document

/** Node kinds that live inside a module — dnSpy's `GetModuleNode(node) is not null`. The assembly root
 *  counts: its helper answers with the module child of whatever it is handed, so selecting the root is
 *  selecting the module it holds, which is what every entry gated on this acts on. */
/** Any row with a .NET module above it: everything but the documents that are no assembly and the ELF rows. */
const inDotNetModule = (ctx: EditMenuContext): boolean =>
  ctx.selectionKind !== undefined && !['pedocument', 'elfdocument', 'unknowndocument', 'elf', 'elfstructure'].includes(ctx.selectionKind)

const inModule = kindIs('assembly', 'module', 'namespace', 'type', 'method', 'field', 'property', 'event', 'resource', 'resourceentry')

/**
 * Node kinds whose reference is an `IMemberDef` (type or member). The C# class commands need it, and
 * so do dnSpy's five member-creating commands: their CanExecute is "the selected node is a TypeNode,
 * or its parent is one" (MethodDefCommands.cs:339, FieldDefCommands.cs:229, PropertyDefCommands.cs:247,
 * EventDefCommands.cs:252, TypeDefCommands.cs:339 for Create Nested Type). A member in this port's
 * tree always hangs off a type, so the node kinds alone express that rule exactly.
 */
const isMember = kindIs('type', 'method', 'field', 'property', 'event')

/** The selected row as the tree knows it, for the menus that only carry its kind and label. */
const selectedRow = (ctx: EditMenuContext): TreeNode =>
  ctx.selection?.[0] ?? { id: '', kind: ctx.selectionKind ?? '', label: ctx.selectionLabel ?? '', hasChildren: false }

/** The rows a delete command takes: the whole selection when it is all of the command's kind. */
const deleteTargets = (ctx: EditMenuContext): TreeNode[] => deletionTargets(selectedRow(ctx), ctx.selection ?? [selectedRow(ctx)], ctx.parents ?? {})

/** The header of dnSpy's "Delete X" commands: one node shows its name, several show a count. */
const deleteLabel = (ctx: EditMenuContext): string => deleteHeader(ctx.t, ctx.selectionKind ?? '', deleteTargets(ctx), selectedRow(ctx))

/** A delete command shows on its own kind, when the selection gives it something to delete. */
const canDelete = (kind: string) => (ctx: EditMenuContext): boolean => ctx.selectionKind === kind && deleteTargets(ctx).length > 0

/** dnSpy removes each deletable node type through its own command; this port acts on the selection. */
const deleteSelected = (ctx: EditMenuContext): void => ctx.onDelete()

/** The shared hex group, wearing this menu's entry shape. `EditMenuContext` carries everything the hex
 *  entries read, so their predicates and actions drop straight in. */
const HEX_ENTRIES: EditEntry[] = hexMenuEntries.map((entry) => ({
  group: GROUP_HEX,
  order: entry.order,
  icon: entry.icon,
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
  { group: GROUP_UNDO, order: 0, icon: 'Undo', label: (ctx) => ctx.t('Undo'), shortcut: 'Ctrl+Z', visible: always, enabled: (ctx) => ctx.canUndo, action: (ctx) => ctx.onUndo() },
  { group: GROUP_UNDO, order: 10, icon: 'Redo', label: (ctx) => ctx.t('Redo'), shortcut: 'Ctrl+Y', visible: always, enabled: (ctx) => ctx.canRedo, action: (ctx) => ctx.onRedo() },

  // 1000 — Find
  { group: GROUP_FIND, order: 0, icon: 'Search', label: (ctx) => ctx.t('Find'), shortcut: 'Ctrl+F', visible: always, enabled: (ctx) => ctx.activeDocument === 'code', action: (ctx) => ctx.onFind() },
  { group: GROUP_FIND, order: 10, icon: 'Search', label: (ctx) => ctx.t('Search Assemblies'), shortcut: 'Ctrl+Shift+K', visible: always, enabled: (ctx) => ctx.hasWorkspace, action: (ctx) => ctx.onSearchAssemblies() },
  // MenuBarCommand.IsVisible: the tree's selection has a row in a .NET module.
  { group: GROUP_FIND, order: 20, icon: 'Search', label: (ctx) => ctx.t('Find String References in Module'), visible: inDotNetModule, enabled: (ctx) => ctx.hasWorkspace, action: (ctx) => ctx.onFindStringReferences() },

  // 2000 — AsmEditor: Delete
  // RemoveAssemblyCommand.EditMenuCommand: the selection's documents, which are the tree's root rows.
  { group: GROUP_DELETE, order: 0, icon: 'Cancel', label: (ctx) => ctx.t('Remove {name}', { name: ctx.selectionLabel ?? '' }), shortcut: 'Del', visible: kindIs('assembly', 'pedocument', 'elfdocument', 'unknowndocument'), action: deleteSelected },
  // The manifest module is the assembly's first row, and it is the one module that cannot leave it.
  { group: GROUP_DELETE, order: 10, icon: 'Cancel', label: (ctx) => ctx.t('Remove NetModule from Assembly'), shortcut: 'Del', visible: isNetModuleRow, enabled: (ctx) => (ctx.selectionIndexInParent ?? 0) > 0, action: (ctx) => ctx.onRemoveNetModule?.() },
  { group: GROUP_DELETE, order: 20, icon: 'Cancel', label: deleteLabel, shortcut: 'Del', visible: canDelete('type'), action: deleteSelected },
  { group: GROUP_DELETE, order: 30, icon: 'Cancel', label: deleteLabel, shortcut: 'Del', visible: canDelete('method'), action: deleteSelected },
  { group: GROUP_DELETE, order: 40, icon: 'Cancel', label: deleteLabel, shortcut: 'Del', visible: canDelete('field'), action: deleteSelected },
  { group: GROUP_DELETE, order: 50, icon: 'Cancel', label: deleteLabel, shortcut: 'Del', visible: canDelete('property'), action: deleteSelected },
  { group: GROUP_DELETE, order: 60, icon: 'Cancel', label: deleteLabel, shortcut: 'Del', visible: canDelete('event'), action: deleteSelected },
  { group: GROUP_DELETE, order: 70, icon: 'Cancel', label: deleteLabel, shortcut: 'Del', visible: canDelete('namespace'), action: deleteSelected },
  { group: GROUP_DELETE, order: 80, icon: 'Cancel', label: deleteLabel, shortcut: 'Del', visible: canDelete('resource'), action: deleteSelected },
  { group: GROUP_DELETE, order: 90, icon: 'Cancel', label: deleteLabel, shortcut: 'Del', visible: canDelete('resourceentry'), action: deleteSelected },

  // 3000 — AsmEditor: Misc
  { group: GROUP_MISC, order: 0, icon: 'Namespace', label: (ctx) => ctx.t('Move Types to Empty Namespace'), visible: (ctx) => ctx.selectionKind === 'namespace' && ctx.selectionLabel !== '-' && ctx.hasEmptyNamespaceSibling, action: (ctx) => ctx.onMoveTypesToEmptyNamespace() },
  { group: GROUP_MISC, order: 10, icon: 'Namespace', label: (ctx) => ctx.t('Rename Namespace'), visible: kindIs('namespace'), action: (ctx) => ctx.onRenameNamespace() },
  { group: GROUP_MISC, order: 20, label: (ctx) => ctx.t('Convert NetModule to Assembly'), visible: (ctx) => ctx.selectionKind === 'module' && ctx.selectionParentKind !== 'assembly', action: (ctx) => ctx.onConvertModule(true) },
  // dnSpy shows the reverse of this one on a module document standing on its own — a module whose parent
  // is not an assembly row. Every module in this tree hangs off an assembly row, so that rule would never
  // match anything; the conversion this port can run is the one that drops the assembly, and Undo is the
  // way back.
  { group: GROUP_MISC, order: 30, label: (ctx) => ctx.t('Convert Assembly to NetModule'), visible: (ctx) => ctx.selectionKind === 'module' && ctx.selectionParentKind === 'assembly', action: (ctx) => ctx.onConvertModule(false) },

  // 4000 — AsmEditor: New
  // CreateAssemblyCommand: nothing selected, or a document row first; CreateNetModuleCommand: any document row.
  { group: GROUP_NEW, order: 0, label: (ctx) => ctx.t('Create Assembly...'), visible: (ctx) => ctx.selectionKind === undefined || DOCUMENT_KINDS.includes(ctx.selectionKind), action: (ctx) => ctx.onCreateAssembly?.() },
  { group: GROUP_NEW, order: 10, label: (ctx) => ctx.t('Add New NetModule to Assembly...'), visible: inAssembly, action: (ctx) => ctx.onAddNewNetModule?.() },
  { group: GROUP_NEW, order: 20, label: (ctx) => ctx.t('Add Existing NetModule to Assembly...'), visible: inAssembly, action: (ctx) => ctx.onAddExistingNetModule?.() },
  { group: GROUP_NEW, order: 30, label: (ctx) => ctx.t('Create NetModule...'), visible: (ctx) => ctx.selectionKind === undefined || (ctx.selection ?? []).some((node) => DOCUMENT_KINDS.includes(node.kind)) || DOCUMENT_KINDS.includes(ctx.selectionKind), action: (ctx) => ctx.onCreateNetModule?.() },
  { group: GROUP_NEW, order: 40, icon: 'NewClass', label: (ctx) => ctx.t('Create Type...'), visible: kindIs('type', 'namespace', 'module'), action: (ctx) => ctx.onCreateMember('type') },
  { group: GROUP_NEW, order: 50, icon: 'NewClass', label: (ctx) => ctx.t('Create Nested Type...'), visible: isMember, action: (ctx) => ctx.onCreateMember('type', true) },
  { group: GROUP_NEW, order: 60, icon: 'NewMethod', label: (ctx) => ctx.t('Create Method...'), visible: isMember, action: (ctx) => ctx.onCreateMember('method') },
  { group: GROUP_NEW, order: 70, icon: 'NewField', label: (ctx) => ctx.t('Create Field...'), visible: isMember, action: (ctx) => ctx.onCreateMember('field') },
  { group: GROUP_NEW, order: 80, icon: 'NewProperty', label: (ctx) => ctx.t('Create Property...'), visible: isMember, action: (ctx) => ctx.onCreateMember('property') },
  { group: GROUP_NEW, order: 90, icon: 'NewEvent', label: (ctx) => ctx.t('Create Event...'), visible: isMember, action: (ctx) => ctx.onCreateMember('event') },
  { group: GROUP_NEW, order: 100, label: (ctx) => ctx.t('Create File Resource...'), visible: canCreateResource, action: (ctx) => ctx.onCreateResource('file') },
  { group: GROUP_NEW, order: 110, label: (ctx) => ctx.t('Create Multi File Resource...'), visible: canCreateResource, action: (ctx) => ctx.onCreateResource('multiFile') },
  { group: GROUP_NEW, order: 120, label: (ctx) => ctx.t('Create Assembly Linked Resource...'), visible: canCreateResource, action: (ctx) => ctx.onCreateResource('assemblyLinked') },
  { group: GROUP_NEW, order: 130, label: (ctx) => ctx.t('Create File Linked Resource...'), visible: canCreateResource, action: (ctx) => ctx.onCreateResource('fileLinked') },
  { group: GROUP_NEW, order: 140, icon: 'NewImage', label: (ctx) => ctx.t('Create System.Data.Bitmap/Icon Resource...'), visible: inResourcesFile, action: (ctx) => ctx.onCreateImageResources() },
  { group: GROUP_NEW, order: 150, icon: 'NewImage', label: (ctx) => ctx.t('Create System.Windows.Forms.ImageListStreamer Resource...'), visible: inResourcesFile, action: (ctx) => ctx.onCreateImageList() },
  { group: GROUP_NEW, order: 170, label: (ctx) => ctx.t('Create Byte Array Resource...'), visible: inResourcesFile, action: (ctx) => ctx.onCreateResource('byteArray') },
  { group: GROUP_NEW, order: 180, label: (ctx) => ctx.t('Create System.IO.Stream Resource...'), visible: inResourcesFile, action: (ctx) => ctx.onCreateResource('stream') },
  { group: GROUP_NEW, order: 190, label: (ctx) => ctx.t('Create Resource...'), visible: inResourcesFile, action: (ctx) => ctx.onCreateResourceElement() },

  // 5000 — AsmEditor: Settings
  { group: GROUP_SETTINGS, order: 0, icon: 'Settings', label: (ctx) => ctx.t('Edit Assembly...'), shortcut: 'Alt+Enter', visible: kindIs('module'), action: (ctx) => ctx.onEditAssembly() },
  { group: GROUP_SETTINGS, order: 10, icon: 'Settings', label: (ctx) => ctx.t('Edit Module...'), shortcut: 'Alt+Enter', visible: kindIs('module'), action: (ctx) => ctx.onEditModule() },
  { group: GROUP_SETTINGS, order: 20, icon: 'Settings', label: (ctx) => ctx.t('Edit Type...'), shortcut: 'Alt+Enter', visible: kindIs('type'), action: (ctx) => ctx.onEditNode() },
  { group: GROUP_SETTINGS, order: 30, icon: 'Settings', label: (ctx) => ctx.t('Edit Method...'), shortcut: 'Alt+Enter', visible: kindIs('method'), action: (ctx) => ctx.onEditNode() },
  { group: GROUP_SETTINGS, order: 40, icon: () => compilerCommandLanguage().icon, label: (ctx) => ctx.t('Edit Method ({language})...', { language: compilerCommandLanguage().name }), visible: kindIs('method'), action: (ctx) => ctx.onEditMethodCode() },
  { group: GROUP_SETTINGS, order: 41, icon: () => compilerCommandLanguage().icon, label: (ctx) => ctx.t('Edit Assembly Attributes ({language})...', { language: compilerCommandLanguage().name }), visible: kindIs('module'), action: (ctx) => ctx.onEditAssemblyAttributesCode() },
  { group: GROUP_SETTINGS, order: 42, icon: () => compilerCommandLanguage().icon, label: (ctx) => ctx.t('Edit Class ({language})...', { language: compilerCommandLanguage().name }), visible: isMember, action: (ctx) => ctx.onEditClassCode() },
  { group: GROUP_SETTINGS, order: 43, icon: () => compilerCommandLanguage().icon, label: (ctx) => ctx.t('Add Class Members ({language})...', { language: compilerCommandLanguage().name }), visible: isMember, action: (ctx) => ctx.onAddClassMembersCode() },
  { group: GROUP_SETTINGS, order: 44, icon: () => compilerCommandLanguage().icon, label: (ctx) => ctx.t('Add Class ({language})...', { language: compilerCommandLanguage().name }), visible: inModule, action: (ctx) => ctx.onAddClassCode() },
  // dnSpy's merge runs its compiled-module importer over a picked DLL, merging every type it holds into
  // this module. That importer is the machinery behind the C# compile commands and the port has neither
  // it nor a dnlib merger to stand in for it, so the entry keeps its place and stays disabled rather than
  // offering a command that would corrupt the module it was run on.
  { group: GROUP_SETTINGS, order: 49.999, icon: 'Assembly', label: (ctx) => ctx.t('Merge with Assembly...'), visible: inModule, action: (ctx) => ctx.onMergeAssembly() },
  { group: GROUP_SETTINGS, order: 50, icon: 'Settings', label: (ctx) => ctx.t('Edit Field...'), shortcut: 'Alt+Enter', visible: kindIs('field'), action: (ctx) => ctx.onEditNode() },
  { group: GROUP_SETTINGS, order: 50, icon: 'Editor', label: (ctx) => ctx.t('Edit Method Body...'), visible: kindIs('method'), action: (ctx) => ctx.onEditMethodBody() },
  { group: GROUP_SETTINGS, order: 51, label: (ctx) => ctx.t('Replace Method Body with stub...'), visible: kindIs('method'), action: (ctx) => ctx.onReplaceMethodBodyWithStub() },
  { group: GROUP_SETTINGS, order: 58.999, label: (ctx) => ctx.t('Load Dependencies'), visible: inModule, action: (ctx) => ctx.onLoadDependencies(false) },
  { group: GROUP_SETTINGS, order: 59.999, label: (ctx) => ctx.t('Load Dependencies Recursively'), visible: inModule, action: (ctx) => ctx.onLoadDependencies(true) },
  { group: GROUP_SETTINGS, order: 60, icon: 'Settings', label: (ctx) => ctx.t('Edit Property...'), shortcut: 'Alt+Enter', visible: kindIs('property'), action: (ctx) => ctx.onEditNode() },
  { group: GROUP_SETTINGS, order: 70, icon: 'Settings', label: (ctx) => ctx.t('Edit Event...'), shortcut: 'Alt+Enter', visible: kindIs('event'), action: (ctx) => ctx.onEditNode() },
  { group: GROUP_SETTINGS, order: 90, icon: 'Settings', label: (ctx) => ctx.t('Edit Resource...'), shortcut: 'Alt+Enter', visible: kindIs('resource'), action: (ctx) => ctx.onEditResource() },
  { group: GROUP_SETTINGS, order: 100, icon: 'Settings', label: (ctx) => ctx.t('Edit Resource...'), shortcut: 'Alt+Enter', visible: kindIs('resourceentry'), action: (ctx) => ctx.onEditResource() },

  // 6000 — Hex editor. The entries live in hex-menu.ts, shared with the code viewer's context menu,
  // which shows the same group.
  ...HEX_ENTRIES,

  // 7000 — Metadata table document: dnSpy's MDTableContextMenuCommands, on the table that last had the focus.
  { group: GROUP_HEX_MD, order: 0, label: (ctx) => ctx.t('Sort Table'), shortcut: 'Ctrl+Shift+T', visible: documentIs('md-table'), enabled: (ctx) => ctx.mdTable?.canSort === true, action: (ctx) => ctx.mdTable?.sortTable() },
  { group: GROUP_HEX_MD, order: 10, label: (ctx) => ctx.t('Sort Selection'), visible: documentIs('md-table'), enabled: (ctx) => ctx.mdTable?.canSortSelection === true, action: (ctx) => ctx.mdTable?.sortSelection() },
  { group: GROUP_HEX_MD, order: 20, label: (ctx) => ctx.t('Go to RID...'), shortcut: 'Ctrl+G', visible: documentIs('md-table'), enabled: (ctx) => ctx.mdTable !== undefined, action: (ctx) => ctx.mdTable?.goToRid() },
  { group: GROUP_HEX_MD, order: 30, icon: 'Binary', label: (ctx) => ctx.t('Show in Hex Editor'), shortcut: 'Ctrl+X', visible: documentIs('md-table'), enabled: (ctx) => ctx.mdTable?.canShowInHex === true, action: (ctx) => ctx.mdTable?.showInHex() },

  // 8000 — Go to metadata table row: the one that asks for a token, and the one that goes to the selected row's.
  { group: GROUP_HEX_GOTO_MD, order: 0, label: (ctx) => ctx.t('Go to MD Table Row...'), shortcut: 'Ctrl+Shift+D', visible: (ctx) => ctx.canGoToMdTableRow === true && ctx.onGoToMdTableRow !== undefined, action: (ctx) => ctx.onGoToMdTableRow?.() },
  { group: GROUP_HEX_GOTO_MD, order: 10, label: (ctx) => ctx.t('Go to MD Table Row ({token})', { token: (ctx.mdTableRowToken ?? 0).toString(16).toUpperCase().padStart(8, '0') }), visible: (ctx) => ctx.mdTableRowToken !== undefined && ctx.onGoToMdTableRow !== undefined, action: (ctx) => ctx.onGoToMdTableRow?.(ctx.mdTableRowToken) },

  // 9000 — Metadata table copy/paste
  { group: GROUP_HEX_COPY, order: 0, label: (ctx) => ctx.t('Copy as Text'), shortcut: 'Ctrl+Shift+C', visible: documentIs('md-table'), enabled: (ctx) => ctx.mdTable?.hasSelection === true, action: (ctx) => ctx.mdTable?.copyAsText() },
  { group: GROUP_HEX_COPY, order: 10, icon: 'Copy', label: (ctx) => ctx.t('Copy'), shortcut: 'Ctrl+C', visible: documentIs('md-table'), enabled: (ctx) => ctx.mdTable?.hasSelection === true, action: (ctx) => ctx.mdTable?.copy() },
  { group: GROUP_HEX_COPY, order: 20, icon: 'Paste', label: (ctx) => ctx.t('Paste'), shortcut: 'Ctrl+V', visible: documentIs('md-table'), enabled: (ctx) => ctx.mdTable?.hasSelection === true, action: (ctx) => ctx.mdTable?.paste() },
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
        icon: typeof entry.icon === 'function' ? entry.icon(ctx) : entry.icon,
        disabled: action ? entry.enabled?.(ctx) === false : true,
        action: action ? () => action(ctx) : undefined,
      })
    }
  }
  return items
}
