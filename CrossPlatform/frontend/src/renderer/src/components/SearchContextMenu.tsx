import type { ReactNode } from 'react'
import { showPopupMenu, type PopupMenuEntry } from 'flexlayout-react'
import { Check, CircleDot, ClipboardCopy, Crosshair, Globe, Hash, ScanSearch } from 'lucide-react'
import type { SearchResult, TreeNode } from '../../../shared/protocol'
import type { SearchSettings } from './app-options'
import { isAnalyzableNode, searchMsdnUrl } from './CodeEditorContextMenu'

/**
 * What the search window's context menu acts on: the result that was right-clicked, which the list selects
 * before the menu opens, and the tree node it names — read when the menu opened, since a result carries its
 * name and location only. The callbacks the shell has no plumbing for are left out, and so are their entries.
 */
export interface SearchMenuContext {
  t(message: string, values?: Record<string, string | number>): string
  result: SearchResult
  /** The node the result names; absent when it could not be read, which leaves only the entries that need none. */
  node?: TreeNode
  open(newTab: boolean): void
  copyText(text: string): void
  openUrl?(url: string): void
  analyze?(node: TreeNode): void
  addClassBreakpoint?(node: TreeNode): void
  addClassTracepoint?(node: TreeNode): void
  addMethodBreakpoints?(nodes: TreeNode[]): void
  /** The window's settings, whose switches the options group shows checked while they are on. */
  settings: SearchSettings
  setOption(key: SearchOptionKey, value: boolean): void
}

/** The settings the options group switches. */
export type SearchOptionKey = 'syntaxHighlight' | 'matchWholeWords' | 'caseSensitive' | 'matchAnySearchTerm'
  | 'searchDecompiledData' | 'searchFrameworkAssemblies' | 'searchCompilerGeneratedMembers'

interface SearchMenuEntry {
  group: number
  order: number
  key: string
  icon?(ctx: SearchMenuContext): ReactNode
  label(ctx: SearchMenuContext): string
  shortcut?(ctx: SearchMenuContext): string
  visible(ctx: SearchMenuContext): boolean
  run(ctx: SearchMenuContext): void
}

// dnSpy's search list menu groups (MenuConstants GROUP_CTX_SEARCH_*), in the order they sort.
const GROUP_TABS = 0
const GROUP_TOKENS = 1000
const GROUP_DEBUG = 2000
const GROUP_OTHER = 5000
const GROUP_OPTIONS = 10000

const iconProps = { size: 14, strokeWidth: 1.7, 'aria-hidden': true as const }

const formatToken = (token: number): string => `0x${(token >>> 0).toString(16).toUpperCase().padStart(8, '0')}`

const MEMBER_KINDS = ['type', 'method', 'field', 'property', 'event']

/** The full name dnSpy's Copy Full Name and Search MSDN write: a member's, which its description holds. */
const fullNameOf = (ctx: SearchMenuContext): string | undefined =>
  ctx.node && MEMBER_KINDS.includes(ctx.node.kind) ? ctx.node.description ?? undefined : undefined

const nodeOfKind = (ctx: SearchMenuContext, ...kinds: string[]): TreeNode | undefined =>
  ctx.node && kinds.includes(ctx.node.kind) ? ctx.node : undefined

/** An entry of the options group: the setting it switches, checked while it is on. */
const option = (order: number, key: SearchOptionKey, entryKey: string, label: string): SearchMenuEntry => ({
  group: GROUP_OPTIONS,
  order,
  key: entryKey,
  icon: (ctx) => ctx.settings[key] ? <Check {...iconProps} /> : null,
  label: (ctx) => ctx.t(label),
  visible: () => true,
  run: (ctx) => ctx.setOption(key, !ctx.settings[key]),
})

const ENTRIES: SearchMenuEntry[] = [
  // 0 — Following the result (GROUP_CTX_SEARCH_TABS).
  { group: GROUP_TABS, order: 0, key: 'go-to-reference', label: (ctx) => ctx.t('Go to Reference'), shortcut: (ctx) => ctx.t('Dbl Click'), visible: () => true, run: (ctx) => ctx.open(false) },
  { group: GROUP_TABS, order: 10, key: 'open-in-new-tab', label: (ctx) => ctx.t('Open in New Tab'), shortcut: (ctx) => ctx.t('Shift+Dbl Click'), visible: () => true, run: (ctx) => ctx.open(true) },

  // 1000 — Copying (GROUP_CTX_SEARCH_TOKENS).
  { group: GROUP_TOKENS, order: 0, key: 'copy-md-token', icon: () => <Hash {...iconProps} />, label: (ctx) => ctx.t('Copy MD Token'), visible: (ctx) => ctx.node?.metadataToken != null, run: (ctx) => { if (ctx.node?.metadataToken != null) ctx.copyText(formatToken(ctx.node.metadataToken)) } },
  { group: GROUP_TOKENS, order: 10, key: 'copy-full-name', icon: () => <ClipboardCopy {...iconProps} />, label: (ctx) => ctx.t('Copy Full Name'), visible: (ctx) => fullNameOf(ctx) !== undefined, run: (ctx) => { const name = fullNameOf(ctx); if (name) ctx.copyText(name) } },

  // 2000 — Debugger (GROUP_CTX_SEARCH_DEBUG).
  { group: GROUP_DEBUG, order: 100, key: 'add-class-breakpoint', icon: () => <CircleDot {...iconProps} />, label: (ctx) => ctx.t('Add Class Breakpoint'), visible: (ctx) => ctx.addClassBreakpoint !== undefined && nodeOfKind(ctx, 'type') !== undefined, run: (ctx) => { const node = nodeOfKind(ctx, 'type'); if (node) ctx.addClassBreakpoint?.(node) } },
  { group: GROUP_DEBUG, order: 101, key: 'add-class-tracepoint', label: (ctx) => ctx.t('Add Class Tracepoint'), visible: (ctx) => ctx.addClassTracepoint !== undefined && nodeOfKind(ctx, 'type') !== undefined, run: (ctx) => { const node = nodeOfKind(ctx, 'type'); if (node) ctx.addClassTracepoint?.(node) } },
  { group: GROUP_DEBUG, order: 150, key: 'add-method-breakpoint', icon: () => <Crosshair {...iconProps} />, label: (ctx) => ctx.t('Add Method Breakpoint'), visible: (ctx) => ctx.addMethodBreakpoints !== undefined && nodeOfKind(ctx, 'method', 'property', 'event') !== undefined, run: (ctx) => { const node = nodeOfKind(ctx, 'method', 'property', 'event'); if (node) ctx.addMethodBreakpoints?.([node]) } },

  // 5000 — Other (GROUP_CTX_SEARCH_OTHER).
  { group: GROUP_OTHER, order: 0, key: 'analyze', icon: () => <ScanSearch {...iconProps} />, label: (ctx) => ctx.t('Analyze'), shortcut: () => 'Ctrl+Shift+R', visible: (ctx) => ctx.analyze !== undefined && isAnalyzableNode(ctx.node), run: (ctx) => { if (isAnalyzableNode(ctx.node)) ctx.analyze?.(ctx.node) } },
  { group: GROUP_OTHER, order: 10, key: 'search-msdn', icon: () => <Globe {...iconProps} />, label: (ctx) => ctx.t('Search MSDN'), visible: (ctx) => ctx.openUrl !== undefined && fullNameOf(ctx) !== undefined, run: (ctx) => { const name = fullNameOf(ctx); if (name) ctx.openUrl?.(searchMsdnUrl(name)) } },

  // 10000 — Options (GROUP_CTX_SEARCH_OPTIONS), checked while they are on.
  option(0, 'syntaxHighlight', 'syntax-highlight', 'Syntax Highlight'),
  option(10, 'matchWholeWords', 'match-whole-words', 'Match Whole Words'),
  option(20, 'caseSensitive', 'case-sensitive', 'Case Sensitive Search'),
  option(30, 'matchAnySearchTerm', 'match-any', 'Match Any Search Term'),
  option(40, 'searchDecompiledData', 'decompile-resources', 'Decompile Resources (eg. XAML)'),
  option(50, 'searchFrameworkAssemblies', 'framework-assemblies', 'Search in framework assemblies'),
  option(60, 'searchCompilerGeneratedMembers', 'compiler-generated', 'Search compiler generated members'),
]

const menuContent = (icon: ReactNode, label: string, shortcut?: string): ReactNode => (
  <>
    <span className="document-tab-menu-icon">{icon}</span>
    <span className="document-tab-menu-label">{label}</span>
    <span className="document-tab-menu-shortcut">{shortcut}</span>
  </>
)

/** The search window's context menu: every entry whose rule matches, by group then order, with a separator
 * between the groups that have any. */
export const buildSearchMenuItems = (ctx: SearchMenuContext): PopupMenuEntry[] => {
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
      content: menuContent(entry.icon?.(ctx), entry.label(ctx), entry.shortcut?.(ctx)),
      onSelect: () => entry.run(ctx),
    })
  }
  return items
}

export const showSearchContextMenu = (ctx: SearchMenuContext, position: { x: number; y: number }, returnFocusTo?: HTMLElement): void => {
  showPopupMenu({
    anchor: position,
    returnFocusTo,
    title: ctx.t('Search'),
    items: buildSearchMenuItems(ctx),
    onClose: () => undefined,
  })
}
