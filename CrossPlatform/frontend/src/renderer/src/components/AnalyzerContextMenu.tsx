import type { ReactNode } from 'react'
import { showPopupMenu, type PopupMenuEntry } from 'flexlayout-react'
import { Check, CircleDot, ClipboardCopy, Copy, CopyPlus, Crosshair, FileSearch, Globe, Hash, ScanSearch, Trash2 } from 'lucide-react'
import type { AnalyzerRow } from '../analyzer-model'
import { searchMsdnUrl } from './CodeEditorContextMenu'

/** What the analyzer's context menu acts on and with: the rows selected, in the order the tree shows them,
 * and the commands the pane runs for it. */
export interface AnalyzerMenuContext {
  t(message: string, values?: Record<string, string | number>): string
  selection: AnalyzerRow[]
  isRoot(key: string): boolean
  showToken: boolean
  syntaxHighlight: boolean
  singleClickExpandsChildren: boolean
  follow(row: AnalyzerRow, newTab: boolean, useCodeRef: boolean): void
  copySelection(): void
  copyText(text: string): void
  openUrl(url: string): void
  analyze(rows: AnalyzerRow[]): void
  removeRoots(rows: AnalyzerRow[]): void
  setShowToken(value: boolean): void
  setSyntaxHighlight(value: boolean): void
  setSingleClickExpandsChildren(value: boolean): void
  /** dnSpy's Add Class Breakpoint, for the type a row names. Left out where there is no debugger to add it to. */
  addClassBreakpoint?(row: AnalyzerRow): void
  /** dnSpy's Add Class Tracepoint: the same breakpoints, after asking for the trace's settings. */
  addClassTracepoint?(row: AnalyzerRow): void
  /** dnSpy's Add Method Breakpoint, for the methods the rows name — a property's or an event's accessors. */
  addMethodBreakpoints?(rows: AnalyzerRow[]): void
}

interface AnalyzerMenuEntry {
  group: number
  order: number
  key: string
  icon(ctx: AnalyzerMenuContext): ReactNode
  label(ctx: AnalyzerMenuContext): string
  shortcut?(ctx: AnalyzerMenuContext): string
  visible(ctx: AnalyzerMenuContext): boolean
  enabled?(ctx: AnalyzerMenuContext): boolean
  run(ctx: AnalyzerMenuContext): void
}

// dnSpy's analyzer menu groups (MenuConstants GROUP_CTX_ANALYZER_*), in the order they sort.
const GROUP_TABS = 0
const GROUP_TOKENS = 1000
const GROUP_DEBUG = 2000
const GROUP_OTHER = 5000
const GROUP_OPTIONS = 10000

const iconProps = { size: 14, strokeWidth: 1.7, 'aria-hidden': true as const }

const formatToken = (token: number): string => `0x${(token >>> 0).toString(16).toUpperCase().padStart(8, '0')}`

/** The rows that name a member, assembly or module rather than run a search. */
const isEntity = (row: AnalyzerRow): boolean => row.node.kind !== 'search'

/** The one row the follow commands act on: dnSpy offers them only for a single selected row. */
const single = (ctx: AnalyzerMenuContext): AnalyzerRow | undefined =>
  ctx.selection.length === 1 && isEntity(ctx.selection[0]) ? ctx.selection[0] : undefined

/** dnSpy analyzes the members it can resolve, which are the type and member rows. */
const isAnalyzable = (row: AnalyzerRow): boolean =>
  !!row.node.nodeId && ['type', 'method', 'field', 'property', 'event'].includes(row.node.kind)

const firstWithToken = (ctx: AnalyzerMenuContext): number | undefined =>
  ctx.selection.find(isEntity)?.node.metadataToken ?? undefined

const firstFullName = (ctx: AnalyzerMenuContext): string | undefined =>
  ctx.selection.find(isEntity)?.node.fullName ?? undefined

/** The type Add Class Breakpoint is for: dnSpy reads the first member selected, and offers it when that is a type. */
const classBreakpointTarget = (ctx: AnalyzerMenuContext): AnalyzerRow | undefined => {
  const first = ctx.selection.find(isEntity)
  return first?.node.kind === 'type' && first.node.nodeId ? first : undefined
}

/** The rows Add Method Breakpoint is for: every method selected, and every property and event, for their accessors. */
const methodBreakpointTargets = (ctx: AnalyzerMenuContext): AnalyzerRow[] =>
  ctx.selection.filter((row) => !!row.node.nodeId && ['method', 'property', 'event'].includes(row.node.kind))

const ENTRIES: AnalyzerMenuEntry[] = [
  // 0 — Following a row (GROUP_CTX_ANALYZER_TABS): to the place the row was found at, or to the row's member.
  { group: GROUP_TABS, order: 0, key: 'show-reference', icon: () => <FileSearch {...iconProps} />, label: (ctx) => ctx.t('Show Reference in Method'), shortcut: (ctx) => ctx.t('Dbl Click'), visible: (ctx) => !!single(ctx)?.node.source, run: (ctx) => ctx.follow(single(ctx)!, false, true) },
  { group: GROUP_TABS, order: 10, key: 'show-reference-new-tab', icon: () => <CopyPlus {...iconProps} />, label: (ctx) => ctx.t('Show Reference in Method (New Tab)'), shortcut: (ctx) => ctx.t('Shift+Dbl Click'), visible: (ctx) => !!single(ctx)?.node.source, run: (ctx) => ctx.follow(single(ctx)!, true, true) },
  { group: GROUP_TABS, order: 20, key: 'go-to-reference', icon: () => null, label: (ctx) => ctx.t('Go to Reference'), visible: (ctx) => !!single(ctx)?.node.nodeId, run: (ctx) => ctx.follow(single(ctx)!, false, false) },
  { group: GROUP_TABS, order: 30, key: 'go-to-reference-new-tab', icon: () => null, label: (ctx) => ctx.t('Go to Reference (New Tab)'), visible: (ctx) => !!single(ctx)?.node.nodeId, run: (ctx) => ctx.follow(single(ctx)!, true, false) },

  // 1000 — Copying (GROUP_CTX_ANALYZER_TOKENS). Copy is always there and only enabled with a selection.
  { group: GROUP_TOKENS, order: -1, key: 'copy', icon: () => <Copy {...iconProps} />, label: (ctx) => ctx.t('Copy'), shortcut: () => 'Ctrl+C', visible: () => true, enabled: (ctx) => ctx.selection.length > 0, run: (ctx) => ctx.copySelection() },
  { group: GROUP_TOKENS, order: 40, key: 'copy-md-token', icon: () => <Hash {...iconProps} />, label: (ctx) => ctx.t('Copy MD Token'), visible: (ctx) => firstWithToken(ctx) !== undefined, run: (ctx) => { const token = firstWithToken(ctx); if (token !== undefined) ctx.copyText(formatToken(token)) } },
  { group: GROUP_TOKENS, order: 50, key: 'copy-full-name', icon: () => <ClipboardCopy {...iconProps} />, label: (ctx) => ctx.t('Copy Full Name'), visible: (ctx) => firstFullName(ctx) !== undefined, run: (ctx) => { const name = firstFullName(ctx); if (name) ctx.copyText(name) } },

  // 2000 — Debugger (GROUP_CTX_ANALYZER_DEBUG).
  { group: GROUP_DEBUG, order: 100, key: 'add-class-breakpoint', icon: () => <CircleDot {...iconProps} />, label: (ctx) => ctx.t('Add Class Breakpoint'), visible: (ctx) => ctx.addClassBreakpoint !== undefined && classBreakpointTarget(ctx) !== undefined, run: (ctx) => { const row = classBreakpointTarget(ctx); if (row) ctx.addClassBreakpoint?.(row) } },
  { group: GROUP_DEBUG, order: 101, key: 'add-class-tracepoint', icon: () => null, label: (ctx) => ctx.t('Add Class Tracepoint'), visible: (ctx) => ctx.addClassTracepoint !== undefined && classBreakpointTarget(ctx) !== undefined, run: (ctx) => { const row = classBreakpointTarget(ctx); if (row) ctx.addClassTracepoint?.(row) } },
  { group: GROUP_DEBUG, order: 150, key: 'add-method-breakpoint', icon: () => <Crosshair {...iconProps} />, label: (ctx) => ctx.t('Add Method Breakpoint'), visible: (ctx) => ctx.addMethodBreakpoints !== undefined && methodBreakpointTargets(ctx).length > 0, run: (ctx) => ctx.addMethodBreakpoints?.(methodBreakpointTargets(ctx)) },

  // 5000 — Other (GROUP_CTX_ANALYZER_OTHER). A root is already analyzed, so Analyze is only offered while
  // some selected row is not one; Remove is the other way round, and only takes roots.
  { group: GROUP_OTHER, order: 0, key: 'analyze', icon: () => <ScanSearch {...iconProps} />, label: (ctx) => ctx.t('Analyze'), shortcut: () => 'Ctrl+Shift+R', visible: (ctx) => ctx.selection.some(isAnalyzable) && !ctx.selection.every((row) => ctx.isRoot(row.key)), run: (ctx) => ctx.analyze(ctx.selection.filter(isAnalyzable)) },
  { group: GROUP_OTHER, order: 10, key: 'search-msdn', icon: () => <Globe {...iconProps} />, label: (ctx) => ctx.t('Search MSDN'), visible: (ctx) => ctx.selection.some((row) => row.node.isPublic && !!row.node.fullName), run: (ctx) => { for (const row of ctx.selection) { if (row.node.isPublic && row.node.fullName) ctx.openUrl(searchMsdnUrl(row.node.fullName)) } } },
  { group: GROUP_OTHER, order: 20, key: 'remove', icon: () => <Trash2 {...iconProps} />, label: (ctx) => ctx.t('Remove'), shortcut: () => 'Del', visible: (ctx) => ctx.selection.length > 0 && ctx.selection.every((row) => ctx.isRoot(row.key)), run: (ctx) => ctx.removeRoots(ctx.selection) },

  // 10000 — Options (GROUP_CTX_ANALYZER_OPTIONS), checked while they are on.
  { group: GROUP_OPTIONS, order: 0, key: 'show-tokens', icon: (ctx) => ctx.showToken ? <Check {...iconProps} /> : null, label: (ctx) => ctx.t('Show Tokens'), visible: () => true, run: (ctx) => ctx.setShowToken(!ctx.showToken) },
  { group: GROUP_OPTIONS, order: 10, key: 'syntax-highlight', icon: (ctx) => ctx.syntaxHighlight ? <Check {...iconProps} /> : null, label: (ctx) => ctx.t('Syntax Highlight'), visible: () => true, run: (ctx) => ctx.setSyntaxHighlight(!ctx.syntaxHighlight) },
  { group: GROUP_OPTIONS, order: 20, key: 'single-click-expands', icon: (ctx) => ctx.singleClickExpandsChildren ? <Check {...iconProps} /> : null, label: (ctx) => ctx.t('Single-click expands nodes'), visible: () => true, run: (ctx) => ctx.setSingleClickExpandsChildren(!ctx.singleClickExpandsChildren) },
]

const menuContent = (icon: ReactNode, label: string, shortcut?: string): ReactNode => (
  <>
    <span className="document-tab-menu-icon">{icon}</span>
    <span className="document-tab-menu-label">{label}</span>
    <span className="document-tab-menu-shortcut">{shortcut}</span>
  </>
)

/** The analyzer's context menu: every entry whose rule matches, by group then order, with a separator
 * between the groups that have any. */
export const buildAnalyzerMenuItems = (ctx: AnalyzerMenuContext): PopupMenuEntry[] => {
  const items: PopupMenuEntry[] = []
  let lastGroup: number | undefined
  const visible = ENTRIES.filter((entry) => entry.visible(ctx))
    .sort((a, b) => a.group - b.group || a.order - b.order)
  for (const entry of visible) {
    if (lastGroup !== undefined && entry.group !== lastGroup)
      items.push({ type: 'divider', key: `separator-${entry.group}` })
    lastGroup = entry.group
    items.push({
      key: entry.key,
      content: menuContent(entry.icon(ctx), entry.label(ctx), entry.shortcut?.(ctx)),
      disabled: entry.enabled?.(ctx) === false,
      onSelect: () => entry.run(ctx),
    })
  }
  return items
}

export const showAnalyzerContextMenu = (ctx: AnalyzerMenuContext, position: { x: number; y: number }, returnFocusTo?: HTMLElement): void => {
  showPopupMenu({
    anchor: position,
    returnFocusTo,
    title: ctx.t('Analyzer'),
    items: buildAnalyzerMenuItems(ctx),
    onClose: () => undefined,
  })
}
