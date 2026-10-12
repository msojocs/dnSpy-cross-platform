import type { ReactNode } from 'react'
import { showPopupMenu, type PopupMenuEntry } from 'flexlayout-react'
import {
  Binary,
  CircleDashed,
  CircleDot,
  CircleOff,
  CirclePause,
  CirclePlay,
  ClipboardCopy,
  Copy,
  CopyPlus,
  Cpu,
  Crosshair,
  Eraser,
  FileCode,
  Globe,
  Hash,
  Pencil,
  Play,
  Plus,
  ScanSearch,
  Search,
  Trash2,
} from 'lucide-react'
import { isNavigableSpan, type CodeStatement, type TextSpan, type TreeNode } from '../../../shared/protocol'
import { methodBreakpointName, type LineBreakpoint } from '../app-store'
import type { CreatedKind } from './edit-menu'
import { hexMenuEntries, type HexMenuContext } from './hex-menu'

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
  /** The statement under the caret, which stands in for a member when there is no reference. */
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
  onStartDebug?(): void
  onToggleBreakpoint?(): void
  /** Enables or disables `breakpoint`, which is what Ctrl+F9 does. */
  onSetBreakpointEnabled?(enabled: boolean): void
  onShowNextStatement?(): void
  onShowDisassembly?(): void
  onToggleMethodBreakpoint?(name: string): void
  onDeleteNode?(node: TreeNode): void
  onEditNode?(node: TreeNode): void
  onEditMethodBody?(node: TreeNode): void
  onReplaceMethodBodyWithStub?(node: TreeNode): void
  onCreateMember?(kind: CreatedKind, nested: boolean, node: TreeNode): void
  onAnalyze?(node: TreeNode): void
  /** Analyzes a reference into a module the workspace does not hold, which has no node until it is opened. */
  onAnalyzeReference?(target: TextSpan): void
  /** Opens an address in the browser, which is how dnSpy's Search MSDN command runs. */
  onOpenUrl?(url: string): void
  /** Writes plain text to the clipboard, which is what dnSpy's two copy commands put there. */
  copyText?(text: string): void
  onCopy?(): void
  onFind?(): void
}

type CodeMenuIcon = (ctx: CodeEditorMenuContext) => ReactNode

interface CodeMenuEntry {
  group: number
  order: number
  /** Stable across the whole table, since flexlayout addresses every entry by it. */
  key: string
  icon: CodeMenuIcon
  label(ctx: CodeEditorMenuContext): string
  shortcut?: string
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

const iconProps = { size: 14, strokeWidth: 1.7, 'aria-hidden': true as const }
/** An entry whose icon does not depend on the document — which is all but the breakpoint toggle. */
const fixedIcon = (node: ReactNode): CodeMenuIcon => () => node

// Commands dnSpy shows only where this port has nothing to run: setting the instruction pointer, class
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
 * a derived type row of the assembly tree, which names a type as well. */
export const isAnalyzableNode = (node: TreeNode | undefined): node is TreeNode =>
  node !== undefined && ['type', 'method', 'field', 'property', 'event', 'derivedtype'].includes(node.kind)

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

/** What "Add Method Breakpoint" names: the referenced method, or the one the statement belongs to. */
const methodBreakpointTarget = (ctx: CodeEditorMenuContext): string | undefined =>
  methodBreakpointName(ctx.referenceNode?.kind === 'method' ? ctx.referenceNode.description : ctx.statement?.description)

/**
 * The token dnSpy's "Copy MD Token" writes — the reference's, or the statement's when the caret is not on
 * a reference. `CopyTokenCommand` writes it as `0x` plus eight hex digits.
 */
const metadataTokenOf = (ctx: CodeEditorMenuContext): number | undefined =>
  ctx.referenceNode?.metadataToken ?? ctx.statement?.metadataToken

const formatToken = (token: number): string => `0x${token.toString(16).toUpperCase().padStart(8, '0')}`

/**
 * What "Copy Full Name" and "Search MSDN" text: dnSpy copies `IFullName.FullName` of the reference under
 * the caret. A tree node's description is dnlib's FullName for the kinds that have one, and a statement's
 * description is its method's — so a caret that is not on a reference still names something.
 */
const fullNameOf = (ctx: CodeEditorMenuContext): string | undefined =>
  ctx.referenceNode?.description ?? ctx.referenceNode?.label ?? ctx.statement?.description

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
const hexIcon = fixedIcon(<Binary {...iconProps} />)
const HEX_ENTRIES: CodeMenuEntry[] = hexMenuEntries.map((entry) => ({
  group: GROUP_HEX,
  order: entry.order,
  key: `hex-${entry.order}`,
  icon: hexIcon,
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
  { group: GROUP_TABS, order: 0, key: 'open-in-new-tab', icon: fixedIcon(<CopyPlus {...iconProps} />), label: (ctx) => ctx.t('Open in New Tab'), visible: (ctx) => ctx.referenceTarget !== undefined && isNavigableSpan(ctx.referenceTarget) && ctx.onOpenInNewTab !== undefined, run: (ctx) => { const target = ctx.referenceTarget; if (target) ctx.onOpenInNewTab?.(target) } },

  // 1000 — Debugger (GROUP_CTX_DOCVIEWER_DEBUG)
  // dnSpy's first entry debugs the exe of the document's module ("Debug <module.exe>"). This port has a
  // single launch path, so it wears that command's header and state instead.
  { group: GROUP_DEBUG, order: 0, key: 'start-debugging', icon: fixedIcon(<Play {...iconProps} />), label: (ctx) => ctx.t('Start Debugging...'), shortcut: 'F5', visible: (ctx) => ctx.canStartDebug && ctx.debugState === 'inactive' && ctx.onStartDebug !== undefined, run: (ctx) => ctx.onStartDebug?.() },
  // The header flips between Add and Delete exactly as dnSpy's `GetToggleCreateBreakpointKind` does.
  { group: GROUP_DEBUG, order: 10, key: 'toggle-breakpoint', icon: (ctx) => ctx.breakpoint ? <CircleOff {...iconProps} /> : <CircleDot {...iconProps} />, label: toggleBreakpointLabel, shortcut: 'F9', visible: (ctx) => ctx.statement !== undefined && ctx.onToggleBreakpoint !== undefined, run: (ctx) => ctx.onToggleBreakpoint?.() },
  { group: GROUP_DEBUG, order: 20, key: 'enable-breakpoint', icon: (ctx) => ctx.breakpoint?.enabled ? <CirclePause {...iconProps} /> : <CirclePlay {...iconProps} />, label: enableBreakpointLabel, shortcut: 'Ctrl+F9', visible: (ctx) => ctx.breakpoint !== undefined && ctx.onSetBreakpointEnabled !== undefined, run: (ctx) => ctx.onSetBreakpointEnabled?.(ctx.breakpoint?.enabled !== true) },
  { group: GROUP_DEBUG, order: 30, key: 'show-next-statement', icon: fixedIcon(<Crosshair {...iconProps} />), label: (ctx) => ctx.t('Show Next Statement'), shortcut: 'Alt + Numpad *', visible: (ctx) => ctx.stopped && ctx.onShowNextStatement !== undefined, run: (ctx) => ctx.onShowNextStatement?.() },
  { group: GROUP_DEBUG, order: 40, key: 'set-next-statement', icon: fixedIcon(<Crosshair {...iconProps} />), label: (ctx) => ctx.t('Set Next Statement'), shortcut: 'Ctrl+Shift+F10', visible: never },
  { group: GROUP_DEBUG, order: 50, key: 'go-to-disassembly', icon: fixedIcon(<Cpu {...iconProps} />), label: (ctx) => ctx.t('Go to Disassembly'), visible: (ctx) => ctx.stopped && ctx.onShowDisassembly !== undefined, run: (ctx) => ctx.onShowDisassembly?.() },
  { group: GROUP_DEBUG, order: 100, key: 'add-class-breakpoint', icon: fixedIcon(<CircleDot {...iconProps} />), label: (ctx) => ctx.t('Add Class Breakpoint'), visible: never },
  { group: GROUP_DEBUG, order: 101, key: 'add-class-tracepoint', icon: fixedIcon(<CircleDot {...iconProps} />), label: (ctx) => ctx.t('Add Class Tracepoint'), visible: never },
  { group: GROUP_DEBUG, order: 150, key: 'add-method-breakpoint', icon: fixedIcon(<CircleDashed {...iconProps} />), label: (ctx) => ctx.t('Add Method Breakpoint'), visible: (ctx) => methodBreakpointTarget(ctx) !== undefined && ctx.onToggleMethodBreakpoint !== undefined, run: (ctx) => { const name = methodBreakpointTarget(ctx); if (name) ctx.onToggleMethodBreakpoint?.(name) } },
  { group: GROUP_DEBUG, order: 1000, key: 'break-when-exception-thrown', icon: fixedIcon(<CircleDot {...iconProps} />), label: (ctx) => ctx.t('Break When Exception Thrown'), visible: never },

  // 3000 — Delete commands (GROUP_CTX_DOCVIEWER_ASMED_DELETE). One entry per deletable node type, so
  // exactly one is ever on screen: the kind of the reference under the caret picks it, and its header
  // names that kind.
  { group: GROUP_ASMED_DELETE, order: 20, key: 'delete-type', icon: fixedIcon(<Trash2 {...iconProps} />), label: (ctx) => ctx.t('Delete Type'), shortcut: 'Del', visible: referenceIs('type'), run: deleteReference },
  { group: GROUP_ASMED_DELETE, order: 30, key: 'delete-method', icon: fixedIcon(<Trash2 {...iconProps} />), label: (ctx) => ctx.t('Delete Method'), shortcut: 'Del', visible: referenceIs('method'), run: deleteReference },
  { group: GROUP_ASMED_DELETE, order: 40, key: 'delete-field', icon: fixedIcon(<Trash2 {...iconProps} />), label: (ctx) => ctx.t('Delete Field'), shortcut: 'Del', visible: referenceIs('field'), run: deleteReference },
  { group: GROUP_ASMED_DELETE, order: 50, key: 'delete-property', icon: fixedIcon(<Trash2 {...iconProps} />), label: (ctx) => ctx.t('Delete Property'), shortcut: 'Del', visible: referenceIs('property'), run: deleteReference },
  { group: GROUP_ASMED_DELETE, order: 60, key: 'delete-event', icon: fixedIcon(<Trash2 {...iconProps} />), label: (ctx) => ctx.t('Delete Event'), shortcut: 'Del', visible: referenceIs('event'), run: deleteReference },

  // 4000 — Create commands (GROUP_CTX_DOCVIEWER_ASMED_NEW). A member is created in the type the
  // reference belongs to, which is how the Edit menu files them under the selection too.
  { group: GROUP_ASMED_NEW, order: 50, key: 'create-nested-type', icon: fixedIcon(<Plus {...iconProps} />), label: (ctx) => ctx.t('Create Nested Type...'), visible: referenceIs('type'), run: (ctx) => createInReference(ctx, 'type', true) },
  { group: GROUP_ASMED_NEW, order: 60, key: 'create-method', icon: fixedIcon(<Plus {...iconProps} />), label: (ctx) => ctx.t('Create Method...'), visible: isMemberRef, run: (ctx) => createInReference(ctx, 'method') },
  { group: GROUP_ASMED_NEW, order: 70, key: 'create-field', icon: fixedIcon(<Plus {...iconProps} />), label: (ctx) => ctx.t('Create Field...'), visible: isMemberRef, run: (ctx) => createInReference(ctx, 'field') },
  { group: GROUP_ASMED_NEW, order: 80, key: 'create-property', icon: fixedIcon(<Plus {...iconProps} />), label: (ctx) => ctx.t('Create Property...'), visible: isMemberRef, run: (ctx) => createInReference(ctx, 'property') },
  { group: GROUP_ASMED_NEW, order: 90, key: 'create-event', icon: fixedIcon(<Plus {...iconProps} />), label: (ctx) => ctx.t('Create Event...'), visible: isMemberRef, run: (ctx) => createInReference(ctx, 'event') },

  // 5000 — Settings (GROUP_CTX_DOCVIEWER_ASMED_SETTINGS): the Edit X... dialogs, the same ones Alt+Enter
  // opens in the assembly explorer.
  { group: GROUP_ASMED_SETTINGS, order: 20, key: 'edit-type', icon: fixedIcon(<Pencil {...iconProps} />), label: (ctx) => ctx.t('Edit Type...'), shortcut: 'Alt+Enter', visible: referenceIs('type'), run: editReference },
  { group: GROUP_ASMED_SETTINGS, order: 30, key: 'edit-method', icon: fixedIcon(<Pencil {...iconProps} />), label: (ctx) => ctx.t('Edit Method...'), shortcut: 'Alt+Enter', visible: referenceIs('method'), run: editReference },
  { group: GROUP_ASMED_SETTINGS, order: 50, key: 'edit-field', icon: fixedIcon(<Pencil {...iconProps} />), label: (ctx) => ctx.t('Edit Field...'), shortcut: 'Alt+Enter', visible: referenceIs('field'), run: editReference },
  { group: GROUP_ASMED_SETTINGS, order: 60, key: 'edit-property', icon: fixedIcon(<Pencil {...iconProps} />), label: (ctx) => ctx.t('Edit Property...'), shortcut: 'Alt+Enter', visible: referenceIs('property'), run: editReference },
  { group: GROUP_ASMED_SETTINGS, order: 70, key: 'edit-event', icon: fixedIcon(<Pencil {...iconProps} />), label: (ctx) => ctx.t('Edit Event...'), shortcut: 'Alt+Enter', visible: referenceIs('event'), run: editReference },

  // 6000 — IL edits (GROUP_CTX_DOCVIEWER_ASMED_ILED). dnSpy's C# compile commands, Merge with Assembly
  // and Edit IL Instructions have no equivalent here; the two that do act on the method the caret names.
  { group: GROUP_ASMED_ILED, order: 20, key: 'edit-il-instructions', icon: fixedIcon(<FileCode {...iconProps} />), label: (ctx) => ctx.t('Edit IL Instructions'), shortcut: 'Ctrl+Shift+E', visible: never },
  { group: GROUP_ASMED_ILED, order: 21, key: 'edit-method-body', icon: fixedIcon(<FileCode {...iconProps} />), label: (ctx) => ctx.t('Edit Method Body...'), visible: (ctx) => methodTarget(ctx) !== undefined && ctx.onEditMethodBody !== undefined, run: (ctx) => { const node = methodTarget(ctx); if (node) ctx.onEditMethodBody?.(node) } },
  { group: GROUP_ASMED_ILED, order: 21, key: 'replace-method-body-with-stub', icon: fixedIcon(<Eraser {...iconProps} />), label: (ctx) => ctx.t('Replace Method Body with stub...'), visible: (ctx) => methodTarget(ctx) !== undefined && ctx.onReplaceMethodBodyWithStub !== undefined, run: (ctx) => { const node = methodTarget(ctx); if (node) ctx.onReplaceMethodBodyWithStub?.(node) } },

  // 7000 — Tokens (GROUP_CTX_DOCVIEWER_TOKENS): where to go, then what to copy.
  { group: GROUP_TOKENS, order: 0, key: 'go-to-entry-point', icon: fixedIcon(<Crosshair {...iconProps} />), label: (ctx) => ctx.t('Go to Entry Point'), visible: never },
  { group: GROUP_TOKENS, order: 10, key: 'go-to-global-cctor', icon: fixedIcon(<Crosshair {...iconProps} />), label: (ctx) => ctx.t('Go to Global Cctor'), visible: never },
  { group: GROUP_TOKENS, order: 20, key: 'go-to-token', icon: fixedIcon(<Search {...iconProps} />), label: (ctx) => ctx.t('Go to Token...'), shortcut: 'Ctrl+Shift+D', visible: never },
  { group: GROUP_TOKENS, order: 50, key: 'copy-md-token', icon: fixedIcon(<Hash {...iconProps} />), label: (ctx) => ctx.t('Copy MD Token'), shortcut: 'Ctrl+C', visible: (ctx) => metadataTokenOf(ctx) !== undefined && ctx.copyText !== undefined, run: (ctx) => { const token = metadataTokenOf(ctx); if (token !== undefined) ctx.copyText?.(formatToken(token)) } },
  { group: GROUP_TOKENS, order: 60, key: 'copy-full-name', icon: fixedIcon(<ClipboardCopy {...iconProps} />), label: (ctx) => ctx.t('Copy Full Name'), visible: (ctx) => fullNameOf(ctx) !== undefined && ctx.copyText !== undefined, run: (ctx) => { const name = fullNameOf(ctx); if (name) ctx.copyText?.(name) } },

  // 9000 — Hex editor. The entries live in hex-menu.ts, shared with the Edit menu, which shows the same
  // group (dnSpy registers them once, for whichever document has the focus).
  ...HEX_ENTRIES,

  // 13000 — Reload All Method Bodies has no equivalent here, so only the group's absence shows: with no
  // entries it contributes nothing at all.

  // 14000 — Other (GROUP_CTX_DOCVIEWER_OTHER). Analyze takes a member of the workspace by its node, and a
  // member of a module the workspace does not hold by the reference itself.
  { group: GROUP_OTHER, order: 0, key: 'analyze', icon: fixedIcon(<ScanSearch {...iconProps} />), label: (ctx) => ctx.t('Analyze'), shortcut: 'Ctrl+Shift+R', visible: (ctx) => (isMemberRef(ctx) && ctx.onAnalyze !== undefined) || (externalMemberTarget(ctx) !== undefined && ctx.onAnalyzeReference !== undefined), run: (ctx) => { const external = externalMemberTarget(ctx); if (ctx.referenceNode) ctx.onAnalyze?.(ctx.referenceNode); else if (external) ctx.onAnalyzeReference?.(external) } },
  { group: GROUP_OTHER, order: 10, key: 'search-msdn', icon: fixedIcon(<Globe {...iconProps} />), label: (ctx) => ctx.t('Search MSDN'), visible: (ctx) => fullNameOf(ctx) !== undefined && ctx.onOpenUrl !== undefined, run: (ctx) => { const name = fullNameOf(ctx); if (name) ctx.onOpenUrl?.(searchMsdnUrl(name)) } },
  { group: GROUP_OTHER, order: 20, key: 'go-to-resource', icon: fixedIcon(<Search {...iconProps} />), label: (ctx) => ctx.t('Go to Resource'), visible: never },

  // 15000 — Editor (GROUP_CTX_DOCVIEWER_EDITOR). The document is read-only, so Cut and Paste have
  // nothing to do; Copy is still needed, since the menu replaces Monaco's own.
  { group: GROUP_EDITOR, order: 0, key: 'copy', icon: fixedIcon(<Copy {...iconProps} />), label: (ctx) => ctx.t('Copy'), shortcut: 'Ctrl+C', visible: (ctx) => ctx.hasSelection && ctx.onCopy !== undefined, run: (ctx) => ctx.onCopy?.() },
  { group: GROUP_EDITOR, order: 10, key: 'find', icon: fixedIcon(<Search {...iconProps} />), label: (ctx) => ctx.t('Find'), shortcut: 'Ctrl+F', visible: (ctx) => ctx.onFind !== undefined, run: (ctx) => ctx.onFind?.() },
  { group: GROUP_EDITOR, order: 20, key: 'incremental-search', icon: fixedIcon(<Search {...iconProps} />), label: (ctx) => ctx.t('Incremental Search'), shortcut: 'Ctrl+I', visible: never },
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
        content: menuContent(entry.icon(ctx), entry.label(ctx), entry.shortcut),
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
