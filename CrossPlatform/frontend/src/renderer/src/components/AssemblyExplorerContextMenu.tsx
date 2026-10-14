import type { ReactNode } from 'react'
import { showPopupMenu, type PopupMenuEntry } from 'flexlayout-react'
import {
  ArrowDownAZ,
  Binary,
  CircleDot,
  ClipboardCopy,
  CopyPlus,
  Crosshair,
  Eraser,
  FileBox,
  FileCode,
  FilePlus,
  FolderSearch,
  Globe,
  Hash,
  Info,
  Merge,
  PackagePlus,
  Pencil,
  Plus,
  Save,
  ScanSearch,
  Search,
  Trash2,
} from 'lucide-react'
import type { TreeNode } from '../../../shared/protocol'
import type { MethodBreakpointTarget } from '../app-store'
import { isAnalyzableNode } from './CodeEditorContextMenu'
import type { CreatedKind } from './edit-menu'
import { hexMenuEntries, type HexMenuContext } from './hex-menu'

/**
 * The callbacks the shell supplies. Everything the menu needs to know about the click itself — the node,
 * the hex target resolved for it, whether a namespace sibling is empty — is added by the tree, so the
 * shell never has to know which row was clicked. The hex group's own callbacks come along unchanged: the
 * tree shows that group exactly as the Edit menu and the code viewer do.
 */
export interface AssemblyExplorerCommands extends Omit<HexMenuContext, 't' | 'selectionKind' | 'hexTarget' | 'hexStatement'> {
  /** Opens the node in the code viewer, which is what a double click on the same row does. */
  onOpenNode(node: TreeNode): void
  /** Follows the node in a tab of its own — dnSpy's `OpenNewTabInternal`. */
  onOpenInNewTab?(node: TreeNode): void
  /** Removes whole documents from the tree — dnSpy's `RemoveAssemblyCommand`, over the selected roots. */
  onRemoveAssembly?(nodes: TreeNode[]): void
  /** Selects the .resources entry a strongly typed Resources member reads — dnSpy's Go to Resource. */
  onGoToResource?(node: TreeNode): void
  onDeleteNode?(node: TreeNode): void
  onEditNode?(node: TreeNode): void
  onCreateMember?(kind: CreatedKind, nested: boolean, node: TreeNode): void
  onEditMethodBody?(node: TreeNode): void
  onReplaceMethodBodyWithStub?(node: TreeNode): void
  /** Replaces a resource's bytes with a file the user picks — dnSpy's resource editor, which this port
   *  reaches through the same "Edit Resource" command. */
  onEditResource?(node: TreeNode): void
  onRenameNamespace?(node: TreeNode): void
  onMoveTypesToEmptyNamespace?(node: TreeNode): void
  /** Flips a module between a netmodule and an assembly. */
  onConvertModule?(node: TreeNode): void
  /**
   * Merges another assembly into this node's module. No callback is ever supplied: dnSpy's merge is its
   * compiled-module importer — the same machinery that recompiles edited C# — and the port has neither
   * that importer nor a dnlib merger to stand in for it, so the entry stays off the menu rather than
   * promising a command that would corrupt the module it was run on.
   */
  onMergeAssembly?(node: TreeNode): void
  /** Adds a breakpoint for every method of a type — dnSpy's "Add Class Breakpoint". */
  onAddClassBreakpoint?(node: TreeNode): void
  /** Asks for the settings of a tracepoint, then puts one on every method of a type — "Add Class Tracepoint". */
  onAddClassTracepoint?(node: TreeNode): void
  onLoadDependencies?(node: TreeNode, recursive: boolean): void
  onGoToEntryPoint?(node: TreeNode): void
  onGoToGlobalCctor?(node: TreeNode): void
  /** The node the menu was opened over names the module the token is looked up in. */
  onGoToToken?(node: TreeNode): void
  /** Saves what the resources hold — dnSpy's four Save commands: their values or (`raw`) their serialized bytes,
   *  and with several files whether the directories in their names are kept (`useSubDirs`). */
  onSaveResource?(nodes: TreeNode[], raw: boolean, useSubDirs: boolean): void
  onOpenContainingFolder?(node: TreeNode): void
  onSortAssemblies?(): void
  /** Breaks at the entry of the methods named — dnSpy's "Add Method Breakpoint", which only adds. */
  onAddMethodBreakpoints?(targets: MethodBreakpointTarget[]): void
  onAnalyze?(node: TreeNode): void
  /** Opens an address in the browser, which is how dnSpy's Search MSDN command runs. */
  onOpenUrl?(url: string): void
  /** Writes plain text to the clipboard, which is what dnSpy's two copy commands put there. */
  copyText?(text: string): void
  /** Opens the module's metadata tables. dnSpy reaches this document from the View menu; this port also
   *  offers it on the module's own menu, which is the one place the old ad-hoc menu put it. */
  onShowModuleInfo?(node: TreeNode): void
}

/**
 * Everything the assembly explorer's context menu reads. It extends the hex group's context, so those
 * entries drop straight in, and — unlike the code viewer's menu, which acts on the reference under the
 * caret — it acts on one node: the row that was right-clicked, which the tree selects before the menu is
 * built, so the menu and the selection can never disagree.
 */
export interface AssemblyExplorerMenuContext extends AssemblyExplorerCommands, HexMenuContext {
  /** The row that was right-clicked. */
  node: TreeNode
  /**
   * The rows the command acts on: every selected row when the right-clicked one is among them, else that
   * row alone — dnSpy's tree right-clicks into the selection rather than replacing it.
   */
  selection?: TreeNode[]
  /** Whether the right-clicked row reads a .resources entry, which the backend answered before the menu
   *  opened — dnSpy's ResourceRef.TryCreate, which is what shows Go to Resource. */
  readsResource?: boolean
  /**
   * The files the selected resources would save as, both ways, which the backend answered before the menu
   * opened: dnSpy's Save commands are headed by how many there are (one by its name), are only offered when
   * there is something to save, and offer their "use sub dirs" variants only for several with a directory in a
   * name.
   */
  resourceNames?: { names: string[]; rawNames: string[] }
  /**
   * Whether the module holding the selected namespace already has an empty namespace node. dnSpy offers
   * "Move Types to Empty Namespace" only when there is somewhere to move them to.
   */
  hasEmptyNamespaceSibling: boolean
}

type AsmMenuIcon = (ctx: AssemblyExplorerMenuContext) => ReactNode

interface AsmMenuEntry {
  group: number
  order: number
  /** Stable across the whole table, since flexlayout addresses every entry by it. */
  key: string
  icon: AsmMenuIcon
  label(ctx: AssemblyExplorerMenuContext): string
  shortcut?: string
  visible(ctx: AssemblyExplorerMenuContext): boolean
  /** Only consulted for entries that have a run; entries without one render disabled. */
  enabled?(ctx: AssemblyExplorerMenuContext): boolean
  run?(ctx: AssemblyExplorerMenuContext): void
}

// dnSpy's group order constants for the documents tree's context menu
// (dnSpy.Contracts.DnSpy/Menus/MenuConstants.cs, the GROUP_CTX_DOCUMENTS_* family). The numeric prefix
// sorts the groups; an empty group contributes nothing, not even a separator — the same rule
// MenuService.CreateMenuItems applies and `buildEditMenu` follows. The hex group's own prefix is 9000 in
// both families (GROUP_CTX_DOCVIEWER_HEX and GROUP_CTX_DOCUMENTS_DEBUGRT), so the shared hex entries land
// where dnSpy puts them: after the tokens and before the debugger's.
const GROUP_TABS = 0
const GROUP_SAVE = 1000
const GROUP_DELETE = 2000
const GROUP_MISC = 3000
const GROUP_NEW = 4000
const GROUP_SETTINGS = 5000
const GROUP_ILED = 6000
const GROUP_TOKENS = 7000
const GROUP_HEX = 9000
const GROUP_DEBUG = 10000
const GROUP_OTHER = 11000

const iconProps = { size: 14, strokeWidth: 1.7, 'aria-hidden': true as const }
/** An entry whose icon does not depend on the click — which is all of them. */
const fixedIcon = (node: ReactNode): AsmMenuIcon => () => node

// Commands dnSpy shows only where this port has nothing to run: the assembly and netmodule editors, the
// C# compile commands, merging an assembly, exception-break settings, the string
// searcher, creating resources, and disabling memory mapped I/O (this backend loads every image into
// memory and has no `MemoryMappedFile` to turn off). They stay in the table so the menu keeps WPF's
// shape, but never show. Commands that this port *can* run but has no plumbing for yet are not listed
// here: their entries gate on the callback instead, so they appear the moment the shell supplies one.
const never = (): boolean => false

const kindIs = (...kinds: string[]) => (ctx: AssemblyExplorerMenuContext): boolean => kinds.includes(ctx.node.kind)

/**
 * Node kinds that live inside a module — dnSpy's `GetModuleNode(node) is not null`. The assembly root
 * counts: dnSpy's helper answers with the module child of whatever it is handed, so a check on the root
 * finds the module just as it does on a method. Only a document with no managed module — a PE image or an
 * unknown file — is outside.
 */
const inModule = kindIs('assembly', 'module', 'namespace', 'type', 'method', 'field', 'property', 'event', 'resource', 'resourceentry')

/**
 * Node kinds whose reference is an `IMemberDef`. dnSpy's five member-creating commands need one — their
 * CanExecute is "the selected node is a TypeNode, or its parent is one" — and the five deletable and
 * editable kinds are the same set, which is why one predicate covers them all. A member in this port's
 * tree always hangs off a type, so the node kinds alone express that rule exactly.
 */
const isMember = kindIs('type', 'method', 'field', 'property', 'event')

/** The header of dnSpy's "Delete X" commands, which name the node they would remove. */
const deleteLabel = (ctx: AssemblyExplorerMenuContext): string => ctx.t('Delete {name}', { name: ctx.node.label })

/** The rows a command acts on: every selected row when the right-clicked one is among them, else that row. */
const selectionOf = (ctx: Pick<AssemblyExplorerMenuContext, 'node' | 'selection'>): TreeNode[] =>
  ctx.selection && ctx.selection.length > 0 ? ctx.selection : [ctx.node]

/** The documents Remove acts on: the selected roots — RemoveAssemblyCommand.CanExecute wants every node a root. */
const removalTargets = (ctx: AssemblyExplorerMenuContext): TreeNode[] => {
  const selection = selectionOf(ctx)
  return selection.every((node) => DOCUMENT_ROOT_KINDS.includes(node.kind)) ? selection : []
}

/**
 * SaveResourcesCommandBase.FilesGetResourceNodes: a Resources folder selected on its own stands for the resources
 * in it; otherwise the selected resources and resource entries are saved, whatever else is selected with them.
 */
export const resourceTargets = (ctx: Pick<AssemblyExplorerMenuContext, 'node' | 'selection'>): TreeNode[] => {
  const selection = selectionOf(ctx)
  if (selection.length === 1 && selection[0].kind === 'resourcesgroup')
    return selection
  return selection.filter((node) => node.kind === 'resource' || node.kind === 'resourceentry')
}

/** SaveResourcesCommand.GetHeaderInternal: one file by its name, several by how many there are. */
const saveLabel = (ctx: AssemblyExplorerMenuContext, names: readonly string[], one: string, many: string): string =>
  names.length === 1 ? ctx.t(one, { name: names[0] }) : ctx.t(many, { count: names.length })

/** SaveWithPathResourcesCommand.IsVisibleInternal: several files, one of them with a directory in its name. */
const hasSubDirectories = (names: readonly string[]): boolean => names.length > 1 && names.some((name) => /[\\/]/.test(name))

const savedNames = (ctx: AssemblyExplorerMenuContext): string[] => resourceTargets(ctx).length > 0 ? ctx.resourceNames?.names ?? [] : []
const rawSavedNames = (ctx: AssemblyExplorerMenuContext): string[] => resourceTargets(ctx).length > 0 ? ctx.resourceNames?.rawNames ?? [] : []

/** The kinds a root row of the tree has — one per kind of file dnSpy opens. */
const DOCUMENT_ROOT_KINDS = ['assembly', 'pedocument', 'elfdocument', 'unknowndocument']

/** RemoveAssemblyCommand.GetHeader: one document by its row text, several by how many there are. */
const removeLabel = (ctx: AssemblyExplorerMenuContext): string => {
  const targets = removalTargets(ctx)
  return targets.length > 1 ? ctx.t('Remove {count} assemblies', { count: targets.length }) : ctx.t('Remove {name}', { name: ctx.node.label })
}

/**
 * The full name dnSpy's "Copy Full Name" writes: the `IFullName` of the metadata the first selected row stands
 * for — an assembly's display name, a module's name, a type's, a member's or a reference's. A namespace, a folder
 * or a resource stands for no metadata row, and the backend sends no name for one.
 */
const fullNameOf = (ctx: AssemblyExplorerMenuContext): string | undefined => selectionOf(ctx)[0].fullName ?? undefined

/** The token "Copy MD Token" writes, the first selected row's — `CopyTokenCommand` writes it as `0x` plus eight
 *  hex digits, for any row that stands for a metadata row. */
const metadataTokenOf = (ctx: AssemblyExplorerMenuContext): number | undefined => selectionOf(ctx)[0].metadataToken

/**
 * The pages dnSpy's Search MSDN opens: one per selected row that names a public definition — a reference row
 * standing for the one it resolves to — or a namespace. The backend works out the address of each.
 */
const msdnNamesOf = (ctx: AssemblyExplorerMenuContext): string[] =>
  selectionOf(ctx).flatMap((node) => node.msdnName ? [node.msdnName] : [])

/** SearchMsdnCtxMenuCommand's address for what the backend named. */
export const msdnPageUrl = (msdnName: string): string => `https://learn.microsoft.com/dotnet/api/${msdnName}`

const formatToken = (token: number): string => `0x${(token >>> 0).toString(16).toUpperCase().padStart(8, '0')}`

/**
 * What "Add Method Breakpoint" is for: dnSpy's GetMethodReferences takes a method, and a property or an
 * event for the accessors it stands for. Any other row names no method to break in.
 */
const isMethodBreakpointTarget = kindIs('method', 'property', 'event')

/**
 * The group folders that hold a module's references and resources, or a type's base types and subtypes.
 * They name no document of their own, so the commands that open one — "Open in New Tab", the hex group's
 * reader — leave them alone.
 */
const isGroupFolder = kindIs('referencesgroup', 'resourcesgroup', 'typereferencesgroup', 'basetypefolder', 'derivedtypesfolder')

const deleteNode = (ctx: AssemblyExplorerMenuContext): void => ctx.onDeleteNode?.(ctx.node)

const editNode = (ctx: AssemblyExplorerMenuContext): void => ctx.onEditNode?.(ctx.node)

const createInNode = (ctx: AssemblyExplorerMenuContext, kind: CreatedKind, nested = false): void =>
  ctx.onCreateMember?.(kind, nested, ctx.node)

/**
 * Whether the module holding `node` already has an empty namespace node. dnSpy reads the tree's own
 * children for this; the tree is the same one the user is looking at, so the sibling list answers it.
 */
export const hasEmptyNamespaceSibling = (
  node: TreeNode | undefined,
  children: Record<string, TreeNode[] | undefined>,
  parents: Record<string, string | undefined>,
): boolean => {
  if (node?.kind !== 'namespace')
    return false
  const parentId = parents[node.id]
  const siblings = parentId ? children[parentId] : undefined
  return siblings?.some((sibling) => sibling.kind === 'namespace' && sibling.label === '-') ?? false
}

/** The shared hex group (GROUP_HEX), wearing this menu's entry shape. Its predicates read the selection
 *  kind — because in the Edit menu and the code viewer the group answers for the assembly explorer's
 *  selection rather than for what was clicked — and in the tree the row that was clicked *is* the
 *  selection, so the kind comes from the node and the two can never disagree. `documentAvailable` is left
 *  unset: the click is in the tree, so no document viewer is the one the hex commands answer for. */
const hexIcon = fixedIcon(<Binary {...iconProps} />)
const HEX_ENTRIES: AsmMenuEntry[] = hexMenuEntries.map((entry) => {
  const hexCtx = (ctx: AssemblyExplorerMenuContext): HexMenuContext => ({ ...ctx, selectionKind: ctx.node.kind })
  return {
    group: GROUP_HEX,
    order: entry.order,
    key: `hex-${entry.order}`,
    icon: hexIcon,
    label: (ctx) => entry.label(hexCtx(ctx)),
    shortcut: entry.shortcut,
    visible: (ctx) => entry.visible(hexCtx(ctx)),
    run: (ctx) => entry.run(hexCtx(ctx)),
  }
})

// The popup menu's item styles, shared with the document tab menu and the code viewer's context menu, so
// every menu that replaces a native one reads like the rest of the app's.
const menuContent = (icon: ReactNode, label: string, shortcut?: string): ReactNode => (
  <>
    <span className="document-tab-menu-icon">{icon}</span>
    <span className="document-tab-menu-label">{label}</span>
    <span className="document-tab-menu-shortcut">{shortcut}</span>
  </>
)

// dnSpy's documents tree context menu: one entry per command, in the group and order MenuService sorts
// them by. The AsmEditor commands are the very same ones the Edit menu carries (same CanExecute, same
// header), so their rules here are the Edit menu's rules.
const ASM_ENTRIES: AsmMenuEntry[] = [
  // 0 — Tab commands (GROUP_CTX_DOCUMENTS_TABS). dnSpy's entry opens the selected node in a tab of its
  // own, which is what the code viewer's "Open in New Tab" does for a reference.
  { group: GROUP_TABS, order: 0, key: 'open-in-new-tab', icon: fixedIcon(<CopyPlus {...iconProps} />), label: (ctx) => ctx.t('Open in New Tab'), visible: (ctx) => ctx.onOpenInNewTab !== undefined && !isGroupFolder(ctx), run: (ctx) => ctx.onOpenInNewTab?.(ctx.node) },

  // 1000 — Save (GROUP_CTX_DOCUMENTS_ASMED_SAVE). dnSpy's four commands save the selected resources: their
  // values one file each, or into the directories their names hold; and the same pair again for the serialized
  // bytes. A header counts the files rather than the rows — a .resources file saves as one file per entry — and
  // the two "use sub dirs" commands show only for several files with a directory in a name.
  { group: GROUP_SAVE, order: 0, key: 'save-resource', icon: fixedIcon(<Save {...iconProps} />), label: (ctx) => saveLabel(ctx, savedNames(ctx), 'Save {name}', 'Save {count} resources'), visible: (ctx) => savedNames(ctx).length > 0 && ctx.onSaveResource !== undefined, run: (ctx) => ctx.onSaveResource?.(resourceTargets(ctx), false, false) },
  { group: GROUP_SAVE, order: 10, key: 'save-resource-sub-dirs', icon: fixedIcon(<Save {...iconProps} />), label: (ctx) => ctx.t('Save {count} resources, use sub dirs', { count: savedNames(ctx).length }), visible: (ctx) => hasSubDirectories(savedNames(ctx)) && ctx.onSaveResource !== undefined, run: (ctx) => ctx.onSaveResource?.(resourceTargets(ctx), false, true) },
  { group: GROUP_SAVE, order: 20, key: 'save-raw-resource', icon: fixedIcon(<Save {...iconProps} />), label: (ctx) => saveLabel(ctx, rawSavedNames(ctx), 'Raw Save {name}', 'Raw Save {count} resources'), visible: (ctx) => rawSavedNames(ctx).length > 0 && ctx.onSaveResource !== undefined, run: (ctx) => ctx.onSaveResource?.(resourceTargets(ctx), true, false) },
  { group: GROUP_SAVE, order: 30, key: 'save-raw-resource-sub-dirs', icon: fixedIcon(<Save {...iconProps} />), label: (ctx) => ctx.t('Raw Save {count} resources, use sub dirs', { count: rawSavedNames(ctx).length }), visible: (ctx) => hasSubDirectories(rawSavedNames(ctx)) && ctx.onSaveResource !== undefined, run: (ctx) => ctx.onSaveResource?.(resourceTargets(ctx), true, true) },

  // 2000 — AsmEditor: Delete (GROUP_CTX_DOCUMENTS_ASMED_DELETE). Remove comes first, then one entry per
  // deletable node type, so exactly one of the latter is ever on screen: the node's kind picks it, and
  // its header names that node.
  { group: GROUP_DELETE, order: 0, key: 'remove-document', icon: fixedIcon(<Trash2 {...iconProps} />), label: removeLabel, shortcut: 'Del', visible: (ctx) => removalTargets(ctx).length > 0 && ctx.onRemoveAssembly !== undefined, run: (ctx) => ctx.onRemoveAssembly?.(removalTargets(ctx)) },
  { group: GROUP_DELETE, order: 10, key: 'remove-netmodule', icon: fixedIcon(<Trash2 {...iconProps} />), label: (ctx) => ctx.t('Remove NetModule from Assembly'), shortcut: 'Del', visible: never },
  { group: GROUP_DELETE, order: 20, key: 'delete-type', icon: fixedIcon(<Trash2 {...iconProps} />), label: deleteLabel, shortcut: 'Del', visible: (ctx) => kindIs('type')(ctx) && ctx.onDeleteNode !== undefined, run: deleteNode },
  { group: GROUP_DELETE, order: 30, key: 'delete-method', icon: fixedIcon(<Trash2 {...iconProps} />), label: deleteLabel, shortcut: 'Del', visible: (ctx) => kindIs('method')(ctx) && ctx.onDeleteNode !== undefined, run: deleteNode },
  { group: GROUP_DELETE, order: 40, key: 'delete-field', icon: fixedIcon(<Trash2 {...iconProps} />), label: deleteLabel, shortcut: 'Del', visible: (ctx) => kindIs('field')(ctx) && ctx.onDeleteNode !== undefined, run: deleteNode },
  { group: GROUP_DELETE, order: 50, key: 'delete-property', icon: fixedIcon(<Trash2 {...iconProps} />), label: deleteLabel, shortcut: 'Del', visible: (ctx) => kindIs('property')(ctx) && ctx.onDeleteNode !== undefined, run: deleteNode },
  { group: GROUP_DELETE, order: 60, key: 'delete-event', icon: fixedIcon(<Trash2 {...iconProps} />), label: deleteLabel, shortcut: 'Del', visible: (ctx) => kindIs('event')(ctx) && ctx.onDeleteNode !== undefined, run: deleteNode },
  { group: GROUP_DELETE, order: 70, key: 'delete-namespace', icon: fixedIcon(<Trash2 {...iconProps} />), label: (ctx) => ctx.t('Delete Namespace'), shortcut: 'Del', visible: (ctx) => kindIs('namespace')(ctx) && ctx.onDeleteNode !== undefined, run: deleteNode },
  { group: GROUP_DELETE, order: 80, key: 'delete-resource', icon: fixedIcon(<Trash2 {...iconProps} />), label: deleteLabel, shortcut: 'Del', visible: (ctx) => kindIs('resource')(ctx) && ctx.onDeleteNode !== undefined, run: deleteNode },
  { group: GROUP_DELETE, order: 90, key: 'delete-resource-entry', icon: fixedIcon(<Trash2 {...iconProps} />), label: deleteLabel, shortcut: 'Del', visible: never },

  // 3000 — AsmEditor: Misc (GROUP_CTX_DOCUMENTS_ASMED_MISC)
  { group: GROUP_MISC, order: 0, key: 'move-types-to-empty-namespace', icon: fixedIcon(<FileBox {...iconProps} />), label: (ctx) => ctx.t('Move Types to Empty Namespace'), visible: (ctx) => ctx.node.label !== '-' && ctx.hasEmptyNamespaceSibling && ctx.onMoveTypesToEmptyNamespace !== undefined, run: (ctx) => ctx.onMoveTypesToEmptyNamespace?.(ctx.node) },
  { group: GROUP_MISC, order: 10, key: 'rename-namespace', icon: fixedIcon(<Pencil {...iconProps} />), label: (ctx) => ctx.t('Rename Namespace'), visible: (ctx) => kindIs('namespace')(ctx) && ctx.onRenameNamespace !== undefined, run: (ctx) => ctx.onRenameNamespace?.(ctx.node) },
  // dnSpy shows exactly one of these two: a netmodule offers the first, an assembly with a single module
  // the second. This tree cannot tell a netmodule from an assembly module — both are a `module` row — so
  // the first stays out rather than turning up on images it would not act on, and the second is what a
  // module row offers.
  { group: GROUP_MISC, order: 20, key: 'convert-netmodule-to-assembly', icon: fixedIcon(<PackagePlus {...iconProps} />), label: (ctx) => ctx.t('Convert NetModule to Assembly'), visible: never },
  { group: GROUP_MISC, order: 30, key: 'convert-assembly-to-netmodule', icon: fixedIcon(<PackagePlus {...iconProps} />), label: (ctx) => ctx.t('Convert Assembly to NetModule'), visible: (ctx) => kindIs('module')(ctx) && ctx.onConvertModule !== undefined, run: (ctx) => ctx.onConvertModule?.(ctx.node) },

  // 4000 — AsmEditor: New (GROUP_CTX_DOCUMENTS_ASMED_NEW). The four assembly/netmodule commands and the
  // resource creates have no backend here; the six that do are the same ones the Edit menu offers.
  { group: GROUP_NEW, order: 0, key: 'create-assembly', icon: fixedIcon(<Plus {...iconProps} />), label: (ctx) => ctx.t('Create Assembly...'), visible: never },
  { group: GROUP_NEW, order: 10, key: 'add-new-netmodule', icon: fixedIcon(<Plus {...iconProps} />), label: (ctx) => ctx.t('Add New NetModule to Assembly...'), visible: never },
  { group: GROUP_NEW, order: 20, key: 'add-existing-netmodule', icon: fixedIcon(<Plus {...iconProps} />), label: (ctx) => ctx.t('Add Existing NetModule to Assembly...'), visible: never },
  { group: GROUP_NEW, order: 30, key: 'create-netmodule', icon: fixedIcon(<Plus {...iconProps} />), label: (ctx) => ctx.t('Create NetModule...'), visible: never },
  { group: GROUP_NEW, order: 40, key: 'create-type', icon: fixedIcon(<Plus {...iconProps} />), label: (ctx) => ctx.t('Create Type...'), visible: (ctx) => kindIs('type', 'namespace', 'module')(ctx) && ctx.onCreateMember !== undefined, run: (ctx) => createInNode(ctx, 'type') },
  { group: GROUP_NEW, order: 50, key: 'create-nested-type', icon: fixedIcon(<Plus {...iconProps} />), label: (ctx) => ctx.t('Create Nested Type...'), visible: (ctx) => isMember(ctx) && ctx.onCreateMember !== undefined, run: (ctx) => createInNode(ctx, 'type', true) },
  { group: GROUP_NEW, order: 60, key: 'create-method', icon: fixedIcon(<Plus {...iconProps} />), label: (ctx) => ctx.t('Create Method...'), visible: (ctx) => isMember(ctx) && ctx.onCreateMember !== undefined, run: (ctx) => createInNode(ctx, 'method') },
  { group: GROUP_NEW, order: 70, key: 'create-field', icon: fixedIcon(<Plus {...iconProps} />), label: (ctx) => ctx.t('Create Field...'), visible: (ctx) => isMember(ctx) && ctx.onCreateMember !== undefined, run: (ctx) => createInNode(ctx, 'field') },
  { group: GROUP_NEW, order: 80, key: 'create-property', icon: fixedIcon(<Plus {...iconProps} />), label: (ctx) => ctx.t('Create Property...'), visible: (ctx) => isMember(ctx) && ctx.onCreateMember !== undefined, run: (ctx) => createInNode(ctx, 'property') },
  { group: GROUP_NEW, order: 90, key: 'create-event', icon: fixedIcon(<Plus {...iconProps} />), label: (ctx) => ctx.t('Create Event...'), visible: (ctx) => isMember(ctx) && ctx.onCreateMember !== undefined, run: (ctx) => createInNode(ctx, 'event') },
  { group: GROUP_NEW, order: 100, key: 'create-file-resource', icon: fixedIcon(<FilePlus {...iconProps} />), label: (ctx) => ctx.t('Create File Resource...'), visible: never },
  { group: GROUP_NEW, order: 110, key: 'create-multi-file-resource', icon: fixedIcon(<FilePlus {...iconProps} />), label: (ctx) => ctx.t('Create Multi File Resource...'), visible: never },
  { group: GROUP_NEW, order: 120, key: 'create-assembly-linked-resource', icon: fixedIcon(<FilePlus {...iconProps} />), label: (ctx) => ctx.t('Create Assembly Linked Resource...'), visible: never },
  { group: GROUP_NEW, order: 130, key: 'create-file-linked-resource', icon: fixedIcon(<FilePlus {...iconProps} />), label: (ctx) => ctx.t('Create File Linked Resource...'), visible: never },
  { group: GROUP_NEW, order: 140, key: 'create-bitmap-resource', icon: fixedIcon(<FilePlus {...iconProps} />), label: (ctx) => ctx.t('Create System.Data.Bitmap/Icon Resource...'), visible: never },
  { group: GROUP_NEW, order: 150, key: 'create-imagelist-resource', icon: fixedIcon(<FilePlus {...iconProps} />), label: (ctx) => ctx.t('Create System.Windows.Forms.ImageListStreamer Resource...'), visible: never },
  { group: GROUP_NEW, order: 170, key: 'create-byte-array-resource', icon: fixedIcon(<FilePlus {...iconProps} />), label: (ctx) => ctx.t('Create Byte Array Resource...'), visible: never },
  { group: GROUP_NEW, order: 180, key: 'create-stream-resource', icon: fixedIcon(<FilePlus {...iconProps} />), label: (ctx) => ctx.t('Create System.IO.Stream Resource...'), visible: never },
  { group: GROUP_NEW, order: 190, key: 'create-resource', icon: fixedIcon(<FilePlus {...iconProps} />), label: (ctx) => ctx.t('Create Resource...'), visible: never },

  // 5000 — AsmEditor: Settings (GROUP_CTX_DOCUMENTS_ASMED_SETTINGS): the Edit X... dialogs, the same ones
  // Alt+Enter opens in the assembly explorer.
  { group: GROUP_SETTINGS, order: 0, key: 'edit-assembly', icon: fixedIcon(<Pencil {...iconProps} />), label: (ctx) => ctx.t('Edit Assembly...'), shortcut: 'Alt+Enter', visible: never },
  { group: GROUP_SETTINGS, order: 10, key: 'edit-module', icon: fixedIcon(<Pencil {...iconProps} />), label: (ctx) => ctx.t('Edit Module...'), shortcut: 'Alt+Enter', visible: never },
  { group: GROUP_SETTINGS, order: 20, key: 'edit-type', icon: fixedIcon(<Pencil {...iconProps} />), label: (ctx) => ctx.t('Edit Type...'), shortcut: 'Alt+Enter', visible: (ctx) => kindIs('type')(ctx) && ctx.onEditNode !== undefined, run: editNode },
  { group: GROUP_SETTINGS, order: 30, key: 'edit-method', icon: fixedIcon(<Pencil {...iconProps} />), label: (ctx) => ctx.t('Edit Method...'), shortcut: 'Alt+Enter', visible: (ctx) => kindIs('method')(ctx) && ctx.onEditNode !== undefined, run: editNode },
  { group: GROUP_SETTINGS, order: 50, key: 'edit-field', icon: fixedIcon(<Pencil {...iconProps} />), label: (ctx) => ctx.t('Edit Field...'), shortcut: 'Alt+Enter', visible: (ctx) => kindIs('field')(ctx) && ctx.onEditNode !== undefined, run: editNode },
  { group: GROUP_SETTINGS, order: 60, key: 'edit-property', icon: fixedIcon(<Pencil {...iconProps} />), label: (ctx) => ctx.t('Edit Property...'), shortcut: 'Alt+Enter', visible: (ctx) => kindIs('property')(ctx) && ctx.onEditNode !== undefined, run: editNode },
  { group: GROUP_SETTINGS, order: 70, key: 'edit-event', icon: fixedIcon(<Pencil {...iconProps} />), label: (ctx) => ctx.t('Edit Event...'), shortcut: 'Alt+Enter', visible: (ctx) => kindIs('event')(ctx) && ctx.onEditNode !== undefined, run: editNode },
  { group: GROUP_SETTINGS, order: 90, key: 'edit-resource', icon: fixedIcon(<Pencil {...iconProps} />), label: (ctx) => ctx.t('Edit Resource...'), shortcut: 'Alt+Enter', visible: (ctx) => kindIs('resource')(ctx) && ctx.onEditResource !== undefined, run: (ctx) => ctx.onEditResource?.(ctx.node) },
  { group: GROUP_SETTINGS, order: 100, key: 'edit-resource-entry', icon: fixedIcon(<Pencil {...iconProps} />), label: (ctx) => ctx.t('Edit Resource...'), shortcut: 'Alt+Enter', visible: never },

  // 6000 — IL edits (GROUP_CTX_DOCUMENTS_ASMED_ILED). dnSpy's C# compile commands have no equivalent
  // here; the rest act on the module or the method the row names. Merge and the two Load Dependencies
  // commands sit in this group in the tree where the Edit menu files them under Settings — upstream
  // registers them once per menu, with a different group each time.
  { group: GROUP_ILED, order: 10, key: 'edit-method-code', icon: fixedIcon(<FileCode {...iconProps} />), label: (ctx) => ctx.t('Edit Method ({language})...', { language: 'C#' }), visible: never },
  { group: GROUP_ILED, order: 11, key: 'edit-assembly-attributes-code', icon: fixedIcon(<FileCode {...iconProps} />), label: (ctx) => ctx.t('Edit Assembly Attributes ({language})...', { language: 'C#' }), visible: never },
  { group: GROUP_ILED, order: 12, key: 'edit-class-code', icon: fixedIcon(<FileCode {...iconProps} />), label: (ctx) => ctx.t('Edit Class ({language})...', { language: 'C#' }), visible: never },
  { group: GROUP_ILED, order: 13, key: 'add-class-members-code', icon: fixedIcon(<FileCode {...iconProps} />), label: (ctx) => ctx.t('Add Class Members ({language})...', { language: 'C#' }), visible: never },
  { group: GROUP_ILED, order: 14, key: 'add-class-code', icon: fixedIcon(<FileCode {...iconProps} />), label: (ctx) => ctx.t('Add Class ({language})...', { language: 'C#' }), visible: never },
  // The entry is in the table so the group keeps its WPF shape, but no shell supplies its callback: see
  // `onMergeAssembly`. The Edit menu files the same command under Settings, where it renders disabled for
  // the same reason; both are gated on the import this port has no way to run.
  { group: GROUP_ILED, order: 19.999, key: 'merge-with-assembly', icon: fixedIcon(<Merge {...iconProps} />), label: (ctx) => ctx.t('Merge with Assembly...'), visible: (ctx) => inModule(ctx) && ctx.onMergeAssembly !== undefined, run: (ctx) => ctx.onMergeAssembly?.(ctx.node) },
  { group: GROUP_ILED, order: 20, key: 'edit-method-body', icon: fixedIcon(<FileCode {...iconProps} />), label: (ctx) => ctx.t('Edit Method Body...'), visible: (ctx) => kindIs('method')(ctx) && ctx.onEditMethodBody !== undefined, run: (ctx) => ctx.onEditMethodBody?.(ctx.node) },
  { group: GROUP_ILED, order: 21, key: 'replace-method-body-with-stub', icon: fixedIcon(<Eraser {...iconProps} />), label: (ctx) => ctx.t('Replace Method Body with stub...'), visible: (ctx) => kindIs('method')(ctx) && ctx.onReplaceMethodBodyWithStub !== undefined, run: (ctx) => ctx.onReplaceMethodBodyWithStub?.(ctx.node) },
  { group: GROUP_ILED, order: 28.999, key: 'load-dependencies', icon: fixedIcon(<PackagePlus {...iconProps} />), label: (ctx) => ctx.t('Load Dependencies'), visible: (ctx) => inModule(ctx) && ctx.onLoadDependencies !== undefined, run: (ctx) => ctx.onLoadDependencies?.(ctx.node, false) },
  { group: GROUP_ILED, order: 29.999, key: 'load-dependencies-recursively', icon: fixedIcon(<PackagePlus {...iconProps} />), label: (ctx) => ctx.t('Load Dependencies Recursively'), visible: (ctx) => inModule(ctx) && ctx.onLoadDependencies !== undefined, run: (ctx) => ctx.onLoadDependencies?.(ctx.node, true) },

  // 7000 — Tokens (GROUP_CTX_DOCUMENTS_TOKENS): where to go, then what to copy.
  { group: GROUP_TOKENS, order: 0, key: 'go-to-entry-point', icon: fixedIcon(<Crosshair {...iconProps} />), label: (ctx) => ctx.t('Go to Entry Point'), visible: (ctx) => kindIs('assembly', 'module')(ctx) && ctx.onGoToEntryPoint !== undefined, run: (ctx) => ctx.onGoToEntryPoint?.(ctx.node) },
  { group: GROUP_TOKENS, order: 10, key: 'go-to-global-cctor', icon: fixedIcon(<Crosshair {...iconProps} />), label: (ctx) => ctx.t('Go to Global Cctor'), visible: (ctx) => kindIs('assembly', 'module')(ctx) && ctx.onGoToGlobalCctor !== undefined, run: (ctx) => ctx.onGoToGlobalCctor?.(ctx.node) },
  { group: GROUP_TOKENS, order: 20, key: 'go-to-token', icon: fixedIcon(<Search {...iconProps} />), label: (ctx) => ctx.t('Go to Token...'), shortcut: 'Ctrl+D', visible: (ctx) => ctx.onGoToToken !== undefined, run: (ctx) => ctx.onGoToToken?.(ctx.node) },
  { group: GROUP_TOKENS, order: 40, key: 'copy-md-token', icon: fixedIcon(<Hash {...iconProps} />), label: (ctx) => ctx.t('Copy MD Token'), visible: (ctx) => metadataTokenOf(ctx) !== undefined && ctx.copyText !== undefined, run: (ctx) => { const token = metadataTokenOf(ctx); if (token !== undefined) ctx.copyText?.(formatToken(token)) } },
  { group: GROUP_TOKENS, order: 50, key: 'copy-full-name', icon: fixedIcon(<ClipboardCopy {...iconProps} />), label: (ctx) => ctx.t('Copy Full Name'), visible: (ctx) => fullNameOf(ctx) !== undefined && ctx.copyText !== undefined, run: (ctx) => { const name = fullNameOf(ctx); if (name) ctx.copyText?.(name) } },

  // 9000 — Hex editor. The entries live in hex-menu.ts, shared with the Edit menu and the code viewer's
  // context menu, which show the same group (dnSpy registers them once, for whichever view has focus).
  ...HEX_ENTRIES,
  // The module's metadata tables, which dnSpy reaches from the View menu and this port also offers on the
  // module's own menu. It rides in the hex group so the module's two document views stay side by side.
  { group: GROUP_HEX, order: 200, key: 'module-information', icon: fixedIcon(<Info {...iconProps} />), label: (ctx) => ctx.t('Module Information'), visible: (ctx) => kindIs('module')(ctx) && ctx.onShowModuleInfo !== undefined, run: (ctx) => ctx.onShowModuleInfo?.(ctx.node) },

  // 9000 — Reload All Method Bodies (GROUP_CTX_DOCUMENTS_DEBUGRT) has no equivalent here, so only the
  // group's absence shows: with no entries it contributes nothing at all. The command refreshes a module
  // the debuggee loaded and this port never modelled — an in-memory module with no file behind it — so
  // there is nothing to reload.

  // 10000 — Debugger (GROUP_CTX_DOCUMENTS_DEBUG). The class breakpoint is the function-breakpoint list:
  // dnSpy puts a breakpoint at the entry of every method of the type, and the methods are this tree row's
  // own children; the class tracepoint does the same after asking for the trace's settings. "Break When
  // Exception Thrown" stays hidden: it is dnSpy's shortcut for adding a definition to the Exception
  // Settings window, which this port reaches from that window instead — the tree row carries no base-type
  // chain to tell an exception type from any other, which is the check dnSpy's CanExecute makes.
  { group: GROUP_DEBUG, order: 0, key: 'break-when-exception-thrown', icon: fixedIcon(<Info {...iconProps} />), label: (ctx) => ctx.t('Break When Exception Thrown'), visible: never },
  { group: GROUP_DEBUG, order: 100, key: 'add-class-breakpoint', icon: fixedIcon(<CircleDot {...iconProps} />), label: (ctx) => ctx.t('Add Class Breakpoint'), visible: (ctx) => kindIs('type')(ctx) && ctx.onAddClassBreakpoint !== undefined, run: (ctx) => ctx.onAddClassBreakpoint?.(ctx.node) },
  { group: GROUP_DEBUG, order: 101, key: 'add-class-tracepoint', icon: fixedIcon(null), label: (ctx) => ctx.t('Add Class Tracepoint'), visible: (ctx) => kindIs('type')(ctx) && ctx.onAddClassTracepoint !== undefined, run: (ctx) => ctx.onAddClassTracepoint?.(ctx.node) },
  { group: GROUP_DEBUG, order: 150, key: 'add-method-breakpoint', icon: fixedIcon(<Crosshair {...iconProps} />), label: (ctx) => ctx.t('Add Method Breakpoint'), visible: (ctx) => isMethodBreakpointTarget(ctx) && ctx.onAddMethodBreakpoints !== undefined, run: (ctx) => ctx.onAddMethodBreakpoints?.([ctx.node]) },

  // 11000 — Other (GROUP_CTX_DOCUMENTS_OTHER). "Find String References in Module" is dnSpy's string
  // searcher, a tool window of its own that this port has no equivalent of, so it stays in the table
  // without a rule that could ever pass.
  { group: GROUP_OTHER, order: 0, key: 'find-string-references', icon: fixedIcon(<Search {...iconProps} />), label: (ctx) => ctx.t('Find String References in Module'), visible: never },
  { group: GROUP_OTHER, order: 0, key: 'analyze', icon: fixedIcon(<ScanSearch {...iconProps} />), label: (ctx) => ctx.t('Analyze'), shortcut: 'Ctrl+Shift+R', visible: (ctx) => isAnalyzableNode(ctx.node) && ctx.onAnalyze !== undefined, run: (ctx) => ctx.onAnalyze?.(ctx.node) },
  { group: GROUP_OTHER, order: 10, key: 'search-msdn', icon: fixedIcon(<Globe {...iconProps} />), label: (ctx) => ctx.t('Search MSDN'), visible: (ctx) => msdnNamesOf(ctx).length > 0 && ctx.onOpenUrl !== undefined, run: (ctx) => { for (const name of msdnNamesOf(ctx)) ctx.onOpenUrl?.(msdnPageUrl(name)) } },
  // dnSpy's DocumentTreeViewCommand only answers for a single selected row.
  { group: GROUP_OTHER, order: 20, key: 'go-to-resource', icon: fixedIcon(<Search {...iconProps} />), label: (ctx) => ctx.t('Go to Resource'), visible: (ctx) => ctx.readsResource === true && selectionOf(ctx).length === 1 && ctx.onGoToResource !== undefined, run: (ctx) => ctx.onGoToResource?.(ctx.node) },
  { group: GROUP_OTHER, order: 30, key: 'open-containing-folder', icon: fixedIcon(<FolderSearch {...iconProps} />), label: (ctx) => ctx.t('Open Containing Folder'), visible: (ctx) => kindIs('assembly', 'module')(ctx) && ctx.onOpenContainingFolder !== undefined, run: (ctx) => ctx.onOpenContainingFolder?.(ctx.node) },
  { group: GROUP_OTHER, order: 40, key: 'sort-assemblies', icon: fixedIcon(<ArrowDownAZ {...iconProps} />), label: (ctx) => ctx.t('Sort Assemblies'), visible: (ctx) => ctx.onSortAssemblies !== undefined, run: (ctx) => ctx.onSortAssemblies?.() },
  { group: GROUP_OTHER, order: 50, key: 'disable-mmap-io', icon: fixedIcon(<FileBox {...iconProps} />), label: (ctx) => ctx.t('Disable Memory Mapped I/O'), visible: never },
]

/**
 * Builds the assembly explorer's context menu: every entry whose visibility rule matches, sorted by group
 * then order, with a separator between each non-empty group. Entries with no action are the commands this
 * port has not implemented — they are hidden by their own rule, so a table entry without a run only shows
 * if someone forgets one, and then it renders disabled.
 */
export const buildAssemblyExplorerMenuItems = (ctx: AssemblyExplorerMenuContext): PopupMenuEntry[] => {
  const groups = new Map<number, AsmMenuEntry[]>()
  for (const entry of ASM_ENTRIES) {
    if (!entry.visible(ctx))
      continue
    const entries = groups.get(entry.group)
    if (entries)
      entries.push(entry)
    else
      groups.set(entry.group, [entry])
  }

  const items: PopupMenuEntry[] = []
  for (const group of [...groups.keys()].sort((a, b) => a - b)) {
    if (items.length > 0)
      items.push({ type: 'divider', key: `separator-${group}` })
    // Array.prototype.sort is stable, so entries sharing an order keep their table order.
    for (const entry of groups.get(group)!.sort((a, b) => a.order - b.order)) {
      const run = entry.run
      items.push({
        key: entry.key,
        content: menuContent(entry.icon(ctx), entry.label(ctx), entry.shortcut),
        disabled: run ? entry.enabled?.(ctx) === false : true,
        onSelect: run ? () => run(ctx) : undefined,
      })
    }
  }
  return items
}

/** What sits in an assembly explorer context menu: a point on the screen, and where the focus goes after. */
export interface AssemblyExplorerMenuOptions {
  returnFocusTo?: HTMLElement
  onClose?(): void
}

export const showAssemblyExplorerContextMenu = (
  ctx: AssemblyExplorerMenuContext,
  position: { x: number; y: number },
  options: AssemblyExplorerMenuOptions = {},
): void => {
  const items = buildAssemblyExplorerMenuItems(ctx)
  if (items.length === 0)
    return
  showPopupMenu({
    anchor: { x: position.x, y: position.y },
    returnFocusTo: options.returnFocusTo,
    title: ctx.t('Assembly Explorer'),
    items,
    onClose: () => options.onClose?.(),
  })
}
