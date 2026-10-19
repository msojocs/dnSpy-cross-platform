import type { ReactNode } from 'react'
import { showPopupMenu, type PopupMenuEntry } from 'flexlayout-react'
import { isNavigableSpan, type CodeStatement, type TextSpan, type TreeNode } from '../../../shared/protocol'
import { methodBreakpointName, type LineBreakpoint, type MethodBreakpointTarget } from '../app-store'
import type { CreatedKind } from './edit-menu'
import { hexMenuEntries, type HexMenuContext } from './hex-menu'
import { MenuEntryIcon } from './DsIcon'

export type DebugState = 'inactive' | 'starting' | 'running' | 'stopped'

/**
 * Everything the code viewer's context menu reads, gathered where the click happened. It extends the hex
 * group's context, so those entries drop straight in, and it carries the two nodes a command can act on:
 * the reference under the caret (C# documents only — VB and IL are decompiled without spans) and, as the
 * fallback for the method commands, the document's own node.
 */
export interface CodeEditorMenuContext extends HexMenuContext {
  /** The document's own node, which the method commands fall back to. */
  documentNode?: TreeNode
  /** The node the reference under the caret points at. */
  referenceNode?: TreeNode
  /**
   * The reference under the caret itself. dnSpy's "Open in New Tab" acts on the `TextReference`, not on
   * the node it names — a reference into a module the workspace does not hold has no node here — so it
   * is the span that decides whether the command shows.
   */
  referenceTarget?: TextSpan
  /** The statement under the caret, which the line breakpoint commands act on. dnSpy's reference commands —
   *  the copies, Search MSDN, Add Method Breakpoint — read only the reference, so a statement stands in for none. */
  statement?: CodeStatement
  /** Whether the editor holds a non-empty selection, which is what WPF's Copy is gated on. */
  hasSelection: boolean
  /** The breakpoint whose statement covers the caret line, if the line has one. */
  breakpoint?: LineBreakpoint
  debugState: DebugState
  /** A frame is stopped, which is what the commands that jump to the instruction pointer need. */
  stopped: boolean
  /** A debug target is configured, so "Start Debugging..." has something to run. */
  canStartDebug: boolean
  /** Follows the reference under the caret in a tab of its own — dnSpy's `FollowReferenceNewTab`. */
  onOpenInNewTab?(target: TextSpan): void
  /** Whether the menu was opened from the keyboard, which is what picks the gesture "Open in New Tab" shows. */
  openInNewTabFromKeyboard?: boolean
  /** Whether the document's module has an entry point and a global constructor — the token group's two Go to
   *  commands show only when it does — and the commands that go there, and to a token, in that module. */
  hasEntryPoint?: boolean
  hasGlobalCctor?: boolean
  onGoToEntryPoint?(node: TreeNode): void
  onGoToGlobalCctor?(node: TreeNode): void
  onGoToToken?(node: TreeNode): void
  /** dnSpy's Go to MD Table Row: asks for a token in the node's module, or goes to the given one. */
  onGoToMdTableRow?(node: TreeNode, token?: number): void
  onStartDebug?(): void
  onToggleBreakpoint?(): void
  /** Enables or disables `breakpoint`, which is what Ctrl+F9 does. */
  onSetBreakpointEnabled?(enabled: boolean): void
  onShowNextStatement?(): void
  /** dnSpy's Set Next Statement: the stopped thread continues from the statement under the caret. */
  onSetNextStatement?(): void
  /** dnSpy's Run to Cursor: continues to the statement under the caret. */
  onRunToCursor?(): void
  onShowDisassembly?(): void
  /** Breaks at the entry of the methods named — dnSpy's "Add Method Breakpoint", which only adds. */
  onAddMethodBreakpoints?(targets: MethodBreakpointTarget[]): void
  /** dnSpy's "Add Class Breakpoint" and "Add Class Tracepoint", for the type the reference names. */
  onAddClassBreakpoint?(node: TreeNode): void
  onAddClassTracepoint?(node: TreeNode): void
  onDeleteNode?(node: TreeNode): void
  onEditNode?(node: TreeNode): void
  onEditMethodBody?(node: TreeNode): void
  /** dnSpy's "Edit IL Instructions", which opens the body editor on the statement's method. */
  onEditIlInstructions?(statement: CodeStatement): void
  onReplaceMethodBodyWithStub?(node: TreeNode): void
  onCreateMember?(kind: CreatedKind, nested: boolean, node: TreeNode): void
  onAnalyze?(node: TreeNode): void
  /** Analyzes a reference into a module the workspace does not hold, which has no node until it is opened. */
  onAnalyzeReference?(target: TextSpan): void
  /** Opens an address in the browser, which is how dnSpy's Search MSDN command runs. */
  onOpenUrl?(url: string): void
  /** Whether the member the reference under the caret names reads a .resources entry, which the backend
   *  answered before the menu opened — dnSpy's ResourceRef.TryCreate over the TextReference. */
  readsResource?: boolean
  /** Selects and opens the .resources entry that member reads — dnSpy's Go to Resource. */
  onGoToResource?(node: TreeNode): void
  /** Writes plain text to the clipboard, which is what dnSpy's two copy commands put there. */
  copyText?(text: string): void
  onCopy?(): void
  /** The IL instructions the selection covers, in an IL view — what Copy IL Bytes copies — and the command. */
  ilSelection?: { modulePath: string; metadataToken: number; ilOffset: number }[]
  onCopyIlBytes?(): void
  onFind?(): void
  /** dnSpy's Incremental Search, Ctrl+I: what is typed next is looked for from the caret as it is typed. */
  onIncrementalSearch?(): void
}

type CodeMenuIcon = (ctx: CodeEditorMenuContext) => ReactNode

interface CodeMenuEntry {
  group: number
  order: number
  /** Stable across the whole table, since flexlayout addresses every entry by it. */
  key: string
  icon: CodeMenuIcon
  label(ctx: CodeEditorMenuContext): string
  shortcut?: string | ((ctx: CodeEditorMenuContext) => string)
  visible(ctx: CodeEditorMenuContext): boolean
  /** Only consulted for entries that have a run; entries without one render disabled. */
  enabled?(ctx: CodeEditorMenuContext): boolean
  run?(ctx: CodeEditorMenuContext): void
}

// dnSpy's group order constants for the document viewer's context menu
// (dnSpy.Contracts.DnSpy/Menus/MenuConstants.cs). The numeric prefix sorts the groups; an empty group
// contributes nothing, not even a separator — the same rule MenuService.CreateMenuItems applies and
// `buildEditMenu` follows. The groups this port has no entries for are left out of the table entirely:
// 2000 (resources, which a code document never offers), 13000 (reloading method bodies, which this
// engine has no command for) and 10000/12000 (the metadata table document's own groups).
const GROUP_TABS = 0
const GROUP_DEBUG = 1000
const GROUP_ASMED_DELETE = 3000
const GROUP_ASMED_NEW = 4000
const GROUP_ASMED_SETTINGS = 5000
const GROUP_ASMED_ILED = 6000
const GROUP_TOKENS = 7000
const GROUP_HEX = 9000
const GROUP_OTHER = 14000
const GROUP_EDITOR = 15000

/** The dnSpy image an entry wears — its ExportMenuItem's Icon (DsImagesAttribute.X). dnSpy's breakpoint
 *  toggles change their header with the breakpoint under the caret but keep one image. */
const image = (name: string): CodeMenuIcon => () => <MenuEntryIcon name={name} />
/** An entry whose ExportMenuItem has no Icon: its icon column stays blank, as dnSpy's does. */
const noImage: CodeMenuIcon = () => null

// Commands dnSpy shows only where this port has nothing to run: class
// breakpoints and tracepoints, exception-break settings, entering an assembly the workspace does not
// hold, metadata tokens, restructuring the assembly, incremental search and copying IL bytes. They stay
// in the table so the menu keeps WPF's shape, but never show.
const never = (): boolean => false

/** The reference under the caret is one of these node kinds. */
const referenceIs = (...kinds: string[]) => (ctx: CodeEditorMenuContext): boolean =>
  ctx.referenceNode !== undefined && kinds.includes(ctx.referenceNode.kind)

/**
 * Node kinds whose reference is an `IMemberDef`. dnSpy's create commands need one — their CanExecute is
 * "the caret is on a type, or on a member of one" — and the five deletable/editable kinds are the same
 * set, which is why one predicate covers them all.
 */
const isMemberRef = referenceIs('type', 'method', 'field', 'property', 'event')

// The metadata tables an `IMemberDef` token can come from: TypeDef, Field, Method, Event and Property.
const MEMBER_TABLES = [0x02, 0x04, 0x06, 0x14, 0x17]

/**
 * A reference into a module the workspace does not hold, when what it names is a member. dnSpy's Analyze
 * shows for any `IMemberRef` under the caret and resolves it only when it runs; such a reference has no
 * node here, but its token says what it is, and the module is opened on demand when the command runs.
 */
export const externalMemberTarget = (ctx: Pick<CodeEditorMenuContext, 'referenceNode' | 'referenceTarget'>): TextSpan | undefined => {
  const target = ctx.referenceTarget
  if (ctx.referenceNode || !target?.targetModulePath || target.targetMetadataToken === undefined)
    return undefined
  return MEMBER_TABLES.includes(target.targetMetadataToken >>> 24) ? target : undefined
}

/** Whether a node is one Analyze takes: a type or a member — what `isMemberRef` asks of the reference — or
 * a base or derived type row of the assembly tree, which names a type as well. A base type row only names
 * one when its reference resolves, which the backend answers when asked to analyze it. */
export const isAnalyzableNode = (node: TreeNode | undefined): node is TreeNode =>
  node !== undefined && ['type', 'method', 'field', 'property', 'event', 'derivedtype', 'basetype'].includes(node.kind)

/**
 * The method dnSpy's "Edit Method Body" acts on: the reference under the caret when that reference *is* a
 * method, and with the caret merely somewhere inside a document that is one, that method. A caret on a
 * reference of any other kind names no method body, so the commands that need one stay hidden rather than
 * editing the method the reference happens to sit in.
 */
const methodTarget = (ctx: CodeEditorMenuContext): TreeNode | undefined => {
  if (ctx.referenceNode)
    return ctx.referenceNode.kind === 'method' ? ctx.referenceNode : undefined
  return ctx.documentNode?.kind === 'method' ? ctx.documentNode : undefined
}

/**
 * What "Add Method Breakpoint" is for: the method the reference under the caret names, or the property or
 * event whose accessors it stands for — dnSpy's GetMethodReferences, which reads the TextReference at the
 * caret and nothing else. A caret on no reference, or on one to a type or a field, has no method to name.
 */
const methodBreakpointTarget = (ctx: CodeEditorMenuContext): MethodBreakpointTarget | undefined =>
  ctx.referenceNode && ['method', 'property', 'event'].includes(ctx.referenceNode.kind) ? ctx.referenceNode : undefined

/** What the class breakpoint commands are for: the type the reference under the caret names — dnSpy's
 *  GetTypeRef, which resolves the reference to its definition. */
const classBreakpointTarget = (ctx: CodeEditorMenuContext): TreeNode | undefined =>
  ctx.referenceNode?.kind === 'type' ? ctx.referenceNode : undefined

/**
 * The token dnSpy's "Copy MD Token" writes: the reference's under the caret, a member of a module the
 * workspace does not hold included — the reference carries its token either way. `CopyTokenCommand` writes
 * it as `0x` plus eight hex digits.
 */
const metadataTokenOf = (ctx: CodeEditorMenuContext): number | undefined =>
  ctx.referenceNode?.metadataToken ?? ctx.referenceTarget?.targetMetadataToken ?? undefined

const formatToken = (token: number): string => `0x${(token >>> 0).toString(16).toUpperCase().padStart(8, '0')}`

/**
 * What "Copy Full Name" and "Search MSDN" text: dnSpy reads `IFullName.FullName` off the reference under
 * the caret, which the node it names carries.
 */
const fullNameOf = (ctx: CodeEditorMenuContext): string | undefined =>
  ctx.referenceNode?.fullName ?? ctx.referenceNode?.description ?? ctx.referenceNode?.label

/**
 * Where dnSpy's "Search MSDN" sends the browser. `SearchMsdnCommand.GetAddress` builds a docs API address
 * out of the reference's declaring type and member name, rewriting `/` (nested types) to `.` and `` ` ``
 * (generic arity) to `-`. All this port has is the full name a decompiled reference carries, which
 * `methodBreakpointName` already reduces to `Ns.Type.Member` — the same shape, for methods, fields and
 * types alike — and a name that does not reduce falls back to a search of the same site.
 */
export const searchMsdnUrl = (fullName: string): string => {
  const member = methodBreakpointName(fullName)
  const address = member?.replace(/\//g, '.').replace(/`/g, '-')
  return address
    ? `https://learn.microsoft.com/dotnet/api/${address}`
    : `https://learn.microsoft.com/search/?q=${encodeURIComponent(fullName)}`
}

/** dnSpy picks its breakpoint command's header from what the line already holds. */
const toggleBreakpointLabel = (ctx: CodeEditorMenuContext): string =>
  ctx.t(ctx.breakpoint ? 'Delete Breakpoint' : 'Add Breakpoint')

/** The enable/disable pair is one entry upstream too: the header flips with the breakpoint's state. */
const enableBreakpointLabel = (ctx: CodeEditorMenuContext): string =>
  ctx.t(ctx.breakpoint?.enabled ? 'Disable Breakpoint' : 'Enable Breakpoint')

const deleteReference = (ctx: CodeEditorMenuContext): void => {
  if (ctx.referenceNode)
    ctx.onDeleteNode?.(ctx.referenceNode)
}

const editReference = (ctx: CodeEditorMenuContext): void => {
  if (ctx.referenceNode)
    ctx.onEditNode?.(ctx.referenceNode)
}

const createInReference = (ctx: CodeEditorMenuContext, kind: CreatedKind, nested = false): void => {
  if (ctx.referenceNode)
    ctx.onCreateMember?.(kind, nested, ctx.referenceNode)
}

/** The shared hex group (GROUP_HEX), wearing this menu's entry shape. `CodeEditorMenuContext` is a
 *  `HexMenuContext`, so the entries' predicates and actions drop straight in. */
const HEX_ENTRIES: CodeMenuEntry[] = hexMenuEntries.map((entry) => ({
  group: GROUP_HEX,
  order: entry.order,
  key: `hex-${entry.order}`,
  icon: entry.icon ? image(entry.icon) : noImage,
  label: entry.label,
  shortcut: entry.shortcut,
  visible: entry.visible,
  run: entry.run,
}))

// The popup menu's item styles, shared with the document tab menu and the bookmarks pane, so the menus
// that replace Monaco's own read like the rest of the app's.
const menuContent = (icon: ReactNode, label: string, shortcut?: string): ReactNode => (
  <>
    <span className="document-tab-menu-icon">{icon}</span>
    <span className="document-tab-menu-label">{label}</span>
    {shortcut && <span className="document-tab-menu-shortcut">{shortcut}</span>}
  </>
)

// dnSpy's document viewer context menu: one entry per command, in the group and order MenuService sorts
// them by. Entries with no action are the commands this port cannot run yet; they keep their place and
// are hidden by their own visibility rule.
const CODE_ENTRIES: CodeMenuEntry[] = [
  // 0 — Tab commands (GROUP_CTX_DOCVIEWER_TABS). dnSpy's entry follows the TextReference under the
  // caret — `OpenReferenceInNewTabCtxMenuCommand` is visible only when the caret names one — so it
  // shows on a reference and nowhere else.
  { group: GROUP_TABS, order: 0, key: 'open-in-new-tab', icon: noImage, label: (ctx) => ctx.t('Open in New Tab'), shortcut: (ctx) => (ctx.openInNewTabFromKeyboard ? 'Ctrl+F12' : ctx.t('Ctrl+Click')), visible: (ctx) => ctx.referenceTarget !== undefined && isNavigableSpan(ctx.referenceTarget) && ctx.onOpenInNewTab !== undefined, run: (ctx) => { const target = ctx.referenceTarget; if (target) ctx.onOpenInNewTab?.(target) } },

  // 1000 — Debugger (GROUP_CTX_DOCVIEWER_DEBUG)
  // dnSpy's first entry debugs the exe of the document's module ("Debug <module.exe>"). This port has a
  // single launch path, so it wears that command's header and state instead.
  { group: GROUP_DEBUG, order: 0, key: 'start-debugging', icon: image('Run'), label: (ctx) => ctx.t('Start Debugging...'), shortcut: 'F5', visible: (ctx) => ctx.canStartDebug && ctx.debugState === 'inactive' && ctx.onStartDebug !== undefined, run: (ctx) => ctx.onStartDebug?.() },
  // The header flips between Add and Delete exactly as dnSpy's `GetToggleCreateBreakpointKind` does.
  { group: GROUP_DEBUG, order: 10, key: 'toggle-breakpoint', icon: image('CheckDot'), label: toggleBreakpointLabel, shortcut: 'F9', visible: (ctx) => ctx.statement !== undefined && ctx.onToggleBreakpoint !== undefined, run: (ctx) => ctx.onToggleBreakpoint?.() },
  { group: GROUP_DEBUG, order: 20, key: 'enable-breakpoint', icon: image('ToggleAllBreakpoints'), label: enableBreakpointLabel, shortcut: 'Ctrl+F9', visible: (ctx) => ctx.breakpoint !== undefined && ctx.onSetBreakpointEnabled !== undefined, run: (ctx) => ctx.onSetBreakpointEnabled?.(ctx.breakpoint?.enabled !== true) },
  { group: GROUP_DEBUG, order: 30, key: 'show-next-statement', icon: image('GoToNext'), label: (ctx) => ctx.t('Show Next Statement'), shortcut: 'Alt + Numpad *', visible: (ctx) => ctx.stopped && ctx.onShowNextStatement !== undefined, run: (ctx) => ctx.onShowNextStatement?.() },
  { group: GROUP_DEBUG, order: 40, key: 'set-next-statement', icon: image('GoToNextInList'), label: (ctx) => ctx.t('Set Next Statement'), shortcut: 'Ctrl+Shift+F10', visible: (ctx) => ctx.stopped && ctx.statement !== undefined && ctx.onSetNextStatement !== undefined, run: (ctx) => ctx.onSetNextStatement?.() },
  { group: GROUP_DEBUG, order: 45, key: 'run-to-cursor', icon: image('Cursor'), label: (ctx) => ctx.t('Run To Cursor'), shortcut: 'Ctrl+F10', visible: (ctx) => ctx.stopped && ctx.statement !== undefined && ctx.onRunToCursor !== undefined, run: (ctx) => ctx.onRunToCursor?.() },
  { group: GROUP_DEBUG, order: 50, key: 'go-to-disassembly', icon: image('DisassemblyWindow'), label: (ctx) => ctx.t('Go to Disassembly'), visible: (ctx) => ctx.stopped && ctx.onShowDisassembly !== undefined, run: (ctx) => ctx.onShowDisassembly?.() },
  { group: GROUP_DEBUG, order: 100, key: 'add-class-breakpoint', icon: image('CheckDot'), label: (ctx) => ctx.t('Add Class Breakpoint'), visible: (ctx) => classBreakpointTarget(ctx) !== undefined && ctx.onAddClassBreakpoint !== undefined, run: (ctx) => { const node = classBreakpointTarget(ctx); if (node) ctx.onAddClassBreakpoint?.(node) } },
  { group: GROUP_DEBUG, order: 101, key: 'add-class-tracepoint', icon: noImage, label: (ctx) => ctx.t('Add Class Tracepoint'), visible: (ctx) => classBreakpointTarget(ctx) !== undefined && ctx.onAddClassTracepoint !== undefined, run: (ctx) => { const node = classBreakpointTarget(ctx); if (node) ctx.onAddClassTracepoint?.(node) } },
  { group: GROUP_DEBUG, order: 150, key: 'add-method-breakpoint', icon: image('CheckDot'), label: (ctx) => ctx.t('Add Method Breakpoint'), visible: (ctx) => methodBreakpointTarget(ctx) !== undefined && ctx.onAddMethodBreakpoints !== undefined, run: (ctx) => { const target = methodBreakpointTarget(ctx); if (target) ctx.onAddMethodBreakpoints?.([target]) } },
  { group: GROUP_DEBUG, order: 1000, key: 'break-when-exception-thrown', icon: image('Add'), label: (ctx) => ctx.t('Break When Exception Thrown'), visible: never },

  // 3000 — Delete commands (GROUP_CTX_DOCVIEWER_ASMED_DELETE). One entry per deletable node type, so
  // exactly one is ever on screen: the kind of the reference under the caret picks it, and its header
  // names that kind.
  { group: GROUP_ASMED_DELETE, order: 20, key: 'delete-type', icon: image('Cancel'), label: (ctx) => ctx.t('Delete Type'), shortcut: 'Del', visible: referenceIs('type'), run: deleteReference },
  { group: GROUP_ASMED_DELETE, order: 30, key: 'delete-method', icon: image('Cancel'), label: (ctx) => ctx.t('Delete Method'), shortcut: 'Del', visible: referenceIs('method'), run: deleteReference },
  { group: GROUP_ASMED_DELETE, order: 40, key: 'delete-field', icon: image('Cancel'), label: (ctx) => ctx.t('Delete Field'), shortcut: 'Del', visible: referenceIs('field'), run: deleteReference },
  { group: GROUP_ASMED_DELETE, order: 50, key: 'delete-property', icon: image('Cancel'), label: (ctx) => ctx.t('Delete Property'), shortcut: 'Del', visible: referenceIs('property'), run: deleteReference },
  { group: GROUP_ASMED_DELETE, order: 60, key: 'delete-event', icon: image('Cancel'), label: (ctx) => ctx.t('Delete Event'), shortcut: 'Del', visible: referenceIs('event'), run: deleteReference },

  // 4000 — Create commands (GROUP_CTX_DOCVIEWER_ASMED_NEW). A member is created in the type the
  // reference belongs to, which is how the Edit menu files them under the selection too.
  { group: GROUP_ASMED_NEW, order: 50, key: 'create-nested-type', icon: image('NewClass'), label: (ctx) => ctx.t('Create Nested Type...'), visible: referenceIs('type'), run: (ctx) => createInReference(ctx, 'type', true) },
  { group: GROUP_ASMED_NEW, order: 60, key: 'create-method', icon: image('NewMethod'), label: (ctx) => ctx.t('Create Method...'), visible: isMemberRef, run: (ctx) => createInReference(ctx, 'method') },
  { group: GROUP_ASMED_NEW, order: 70, key: 'create-field', icon: image('NewField'), label: (ctx) => ctx.t('Create Field...'), visible: isMemberRef, run: (ctx) => createInReference(ctx, 'field') },
  { group: GROUP_ASMED_NEW, order: 80, key: 'create-property', icon: image('NewProperty'), label: (ctx) => ctx.t('Create Property...'), visible: isMemberRef, run: (ctx) => createInReference(ctx, 'property') },
  { group: GROUP_ASMED_NEW, order: 90, key: 'create-event', icon: image('NewEvent'), label: (ctx) => ctx.t('Create Event...'), visible: isMemberRef, run: (ctx) => createInReference(ctx, 'event') },

  // 5000 — Settings (GROUP_CTX_DOCVIEWER_ASMED_SETTINGS): the Edit X... dialogs, the same ones Alt+Enter
  // opens in the assembly explorer.
  { group: GROUP_ASMED_SETTINGS, order: 20, key: 'edit-type', icon: image('Settings'), label: (ctx) => ctx.t('Edit Type...'), shortcut: 'Alt+Enter', visible: referenceIs('type'), run: editReference },
  { group: GROUP_ASMED_SETTINGS, order: 30, key: 'edit-method', icon: image('Settings'), label: (ctx) => ctx.t('Edit Method...'), shortcut: 'Alt+Enter', visible: referenceIs('method'), run: editReference },
  { group: GROUP_ASMED_SETTINGS, order: 50, key: 'edit-field', icon: image('Settings'), label: (ctx) => ctx.t('Edit Field...'), shortcut: 'Alt+Enter', visible: referenceIs('field'), run: editReference },
  { group: GROUP_ASMED_SETTINGS, order: 60, key: 'edit-property', icon: image('Settings'), label: (ctx) => ctx.t('Edit Property...'), shortcut: 'Alt+Enter', visible: referenceIs('property'), run: editReference },
  { group: GROUP_ASMED_SETTINGS, order: 70, key: 'edit-event', icon: image('Settings'), label: (ctx) => ctx.t('Edit Event...'), shortcut: 'Alt+Enter', visible: referenceIs('event'), run: editReference },

  // 6000 — IL edits (GROUP_CTX_DOCVIEWER_ASMED_ILED). dnSpy's C# compile commands, Merge with Assembly
  // and Edit IL Instructions have no equivalent here; the two that do act on the method the caret names.
  { group: GROUP_ASMED_ILED, order: 20, key: 'edit-il-instructions', icon: image('Editor'), label: (ctx) => ctx.t('Edit IL Instructions'), shortcut: 'Ctrl+Shift+E', visible: never },
  { group: GROUP_ASMED_ILED, order: 20, key: 'edit-method-body', icon: image('Editor'), label: (ctx) => ctx.t('Edit Method Body...'), visible: (ctx) => methodTarget(ctx) !== undefined && ctx.onEditMethodBody !== undefined, run: (ctx) => { const node = methodTarget(ctx); if (node) ctx.onEditMethodBody?.(node) } },
  { group: GROUP_ASMED_ILED, order: 20, key: 'edit-il-instructions', icon: image('Editor'), label: (ctx) => ctx.t('Edit IL Instructions...'), visible: (ctx) => ctx.statement !== undefined && ctx.onEditIlInstructions !== undefined, run: (ctx) => { if (ctx.statement) ctx.onEditIlInstructions?.(ctx.statement) } },
  { group: GROUP_ASMED_ILED, order: 21, key: 'replace-method-body-with-stub', icon: noImage, label: (ctx) => ctx.t('Replace Method Body with stub...'), visible: (ctx) => methodTarget(ctx) !== undefined && ctx.onReplaceMethodBodyWithStub !== undefined, run: (ctx) => { const node = methodTarget(ctx); if (node) ctx.onReplaceMethodBodyWithStub?.(node) } },

  // 7000 — Tokens (GROUP_CTX_DOCVIEWER_TOKENS): where to go, then what to copy.
  { group: GROUP_TOKENS, order: 0, key: 'go-to-entry-point', icon: image('EntryPoint'), label: (ctx) => ctx.t('Go to Entry Point'), visible: (ctx) => ctx.hasEntryPoint === true && ctx.documentNode !== undefined && ctx.onGoToEntryPoint !== undefined, run: (ctx) => { if (ctx.documentNode) ctx.onGoToEntryPoint?.(ctx.documentNode) } },
  { group: GROUP_TOKENS, order: 10, key: 'go-to-global-cctor', icon: noImage, label: (ctx) => ctx.t('Go to Global Cctor'), visible: (ctx) => ctx.hasGlobalCctor === true && ctx.documentNode !== undefined && ctx.onGoToGlobalCctor !== undefined, run: (ctx) => { if (ctx.documentNode) ctx.onGoToGlobalCctor?.(ctx.documentNode) } },
  { group: GROUP_TOKENS, order: 20, key: 'go-to-token', icon: noImage, label: (ctx) => ctx.t('Go to Token...'), shortcut: 'Ctrl+D', visible: (ctx) => ctx.documentNode !== undefined && ctx.onGoToToken !== undefined, run: (ctx) => { if (ctx.documentNode) ctx.onGoToToken?.(ctx.documentNode) } },
  // dnSpy's GoToMDTableRowUIHexEditorCommand and GoToMDTableRowHexEditorCommand: the row of a token asked for in
  // the document's module, and the row of the reference under the caret.
  { group: GROUP_TOKENS, order: 30, key: 'go-to-md-table-row', icon: noImage, label: (ctx) => ctx.t('Go to MD Table Row...'), shortcut: 'Ctrl+Shift+D', visible: (ctx) => ctx.documentNode !== undefined && ctx.onGoToMdTableRow !== undefined, run: (ctx) => { if (ctx.documentNode) ctx.onGoToMdTableRow?.(ctx.documentNode) } },
  { group: GROUP_TOKENS, order: 40, key: 'go-to-md-table-row-token', icon: noImage, label: (ctx) => ctx.t('Go to MD Table Row ({token})', { token: ((ctx.referenceNode?.metadataToken ?? 0) >>> 0).toString(16).toUpperCase().padStart(8, '0') }), shortcut: 'Shift+Alt+R', visible: (ctx) => ctx.referenceNode?.metadataToken !== undefined && ctx.onGoToMdTableRow !== undefined, run: (ctx) => { if (ctx.referenceNode?.metadataToken !== undefined) ctx.onGoToMdTableRow?.(ctx.referenceNode, ctx.referenceNode.metadataToken) } },
  { group: GROUP_TOKENS, order: 50, key: 'copy-md-token', icon: noImage, label: (ctx) => ctx.t('Copy MD Token'), visible: (ctx) => metadataTokenOf(ctx) !== undefined && ctx.copyText !== undefined, run: (ctx) => { const token = metadataTokenOf(ctx); if (token !== undefined) ctx.copyText?.(formatToken(token)) } },
  { group: GROUP_TOKENS, order: 60, key: 'copy-full-name', icon: noImage, label: (ctx) => ctx.t('Copy Full Name'), visible: (ctx) => fullNameOf(ctx) !== undefined && ctx.copyText !== undefined, run: (ctx) => { const name = fullNameOf(ctx); if (name) ctx.copyText?.(name) } },

  // 9000 — Hex editor. The entries live in hex-menu.ts, shared with the Edit menu, which shows the same
  // group (dnSpy registers them once, for whichever document has the focus).
  ...HEX_ENTRIES,

  // 13000 — Reload All Method Bodies has no equivalent here, so only the group's absence shows: with no
  // entries it contributes nothing at all.

  // 14000 — Other (GROUP_CTX_DOCVIEWER_OTHER). Analyze takes a member of the workspace by its node, and a
  // member of a module the workspace does not hold by the reference itself.
  { group: GROUP_OTHER, order: 0, key: 'analyze', icon: image('Search'), label: (ctx) => ctx.t('Analyze'), shortcut: 'Ctrl+Shift+R', visible: (ctx) => (isMemberRef(ctx) && ctx.onAnalyze !== undefined) || (externalMemberTarget(ctx) !== undefined && ctx.onAnalyzeReference !== undefined), run: (ctx) => { const external = externalMemberTarget(ctx); if (ctx.referenceNode) ctx.onAnalyze?.(ctx.referenceNode); else if (external) ctx.onAnalyzeReference?.(external) } },
  { group: GROUP_OTHER, order: 10, key: 'search-msdn', icon: image('Search'), label: (ctx) => ctx.t('Search MSDN'), visible: (ctx) => fullNameOf(ctx) !== undefined && ctx.onOpenUrl !== undefined, run: (ctx) => { const name = fullNameOf(ctx); if (name) ctx.onOpenUrl?.(searchMsdnUrl(name)) } },
  // dnSpy's TextEditorCommand: the reference under the caret is a getter-only property or a method of a
  // strongly typed resources class, which the backend answered before the menu opened.
  { group: GROUP_OTHER, order: 20, key: 'go-to-resource', icon: noImage, label: (ctx) => ctx.t('Go to Resource'), visible: (ctx) => ctx.readsResource === true && ctx.referenceNode !== undefined && ctx.onGoToResource !== undefined, run: (ctx) => { if (ctx.referenceNode) ctx.onGoToResource?.(ctx.referenceNode) } },

  // 15000 — Editor (GROUP_CTX_DOCVIEWER_EDITOR). The document is read-only, so Cut and Paste have
  // nothing to do; Copy is still needed, since the menu replaces Monaco's own.
  { group: GROUP_EDITOR, order: 0, key: 'copy', icon: image('Copy'), label: (ctx) => ctx.t('Copy'), shortcut: 'Ctrl+C', visible: (ctx) => ctx.hasSelection && ctx.onCopy !== undefined, run: (ctx) => ctx.onCopy?.() },
  { group: GROUP_EDITOR, order: 10, key: 'find', icon: image('Search'), label: (ctx) => ctx.t('Find'), shortcut: 'Ctrl+F', visible: (ctx) => ctx.onFind !== undefined, run: (ctx) => ctx.onFind?.() },
  // dnSpy's CopyILBytesCommand: only over a selection that covers an instruction of an IL view.
  { group: GROUP_EDITOR, order: 20, key: 'copy-il-bytes', icon: image('Copy'), label: (ctx) => ctx.t('Copy IL Bytes'), shortcut: 'Ctrl+B', visible: (ctx) => (ctx.ilSelection?.length ?? 0) > 0 && ctx.onCopyIlBytes !== undefined, run: (ctx) => ctx.onCopyIlBytes?.() },
  { group: GROUP_EDITOR, order: 20, key: 'incremental-search', icon: image('Search'), label: (ctx) => ctx.t('Incremental Search'), shortcut: 'Ctrl+I', visible: (ctx) => ctx.onIncrementalSearch !== undefined, run: (ctx) => ctx.onIncrementalSearch?.() },
]

/**
 * Builds the code viewer's context menu: every entry whose visibility rule matches, sorted by group then
 * order, with a separator between each non-empty group. Entries with no action are the commands this port
 * has not implemented — they are hidden by their own rule, so a table entry without a run only shows if
 * someone forgets one, and then it renders disabled.
 */
export const buildCodeEditorMenuItems = (ctx: CodeEditorMenuContext): PopupMenuEntry[] => {
  const groups = new Map<number, CodeMenuEntry[]>()
  for (const entry of CODE_ENTRIES) {
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
        content: menuContent(entry.icon(ctx), entry.label(ctx), typeof entry.shortcut === 'function' ? entry.shortcut(ctx) : entry.shortcut),
        disabled: run ? entry.enabled?.(ctx) === false : true,
        onSelect: run ? () => run(ctx) : undefined,
      })
    }
  }
  return items
}

/** What sits in a code viewer context menu: a point on the screen, and where the focus goes afterwards. */
export interface CodeEditorMenuOptions {
  returnFocusTo?: HTMLElement
  onClose?(): void
}

/** Shows the menu and says whether it did: a context with nothing to offer puts nothing on screen, and
 * then `onClose` is never called either. */
export const showCodeEditorContextMenu = (
  ctx: CodeEditorMenuContext,
  position: { x: number; y: number },
  options: CodeEditorMenuOptions = {},
): boolean => {
  const items = buildCodeEditorMenuItems(ctx)
  if (items.length === 0)
    return false
  showPopupMenu({
    anchor: { x: position.x, y: position.y },
    returnFocusTo: options.returnFocusTo,
    title: ctx.t('Code editor'),
    items,
    onClose: () => options.onClose?.(),
  })
  return true
}
