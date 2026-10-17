import type { ReactNode } from 'react'
import { showPopupMenu, type PopupMenuEntry } from 'flexlayout-react'
import type { StringReference } from '../../../shared/protocol'
import { MenuEntryIcon } from './DsIcon'

/** What the String References window's context menu acts on: the row that was right-clicked, which the list
 * selects before the menu opens. */
export interface StringReferencesMenuContext {
  t(message: string, values?: Record<string, string | number>): string
  reference: StringReference
  copyText(text: string): void
  follow(newTab: boolean): void
}

interface StringReferencesMenuEntry {
  group: number
  order: number
  key: string
  icon?: ReactNode
  label(ctx: StringReferencesMenuContext): string
  shortcut?(ctx: StringReferencesMenuContext): string
  visible(ctx: StringReferencesMenuContext): boolean
  run(ctx: StringReferencesMenuContext): void
}

// dnSpy's StringSearcherConstants GUID_CTX_GROUP_COPY ("0,…") and GUID_CTX_GROUP_FOLLOW ("1000,…").
const GROUP_COPY = 0
const GROUP_FOLLOW = 1000

// dnSpy's string searcher gives only the formatted copy an image (DsImagesAttribute.Copy).
const ENTRIES: StringReferencesMenuEntry[] = [
  { group: GROUP_COPY, order: 0, key: 'copy-literal', icon: <MenuEntryIcon name="Copy" />, label: (ctx) => ctx.t('Copy String Literal (Formatted)'), shortcut: () => 'Ctrl+C', visible: () => true, run: (ctx) => ctx.copyText(ctx.reference.formattedLiteral) },
  { group: GROUP_COPY, order: 1, key: 'copy-raw-literal', label: (ctx) => ctx.t('Copy String Literal (Raw)'), visible: () => true, run: (ctx) => ctx.copyText(ctx.reference.literal) },
  { group: GROUP_FOLLOW, order: 0, key: 'go-to-reference', label: (ctx) => ctx.t('Go To Reference in Code'), shortcut: (ctx) => ctx.t('Dbl Click'), visible: (ctx) => ctx.reference.nodeId !== null, run: (ctx) => ctx.follow(false) },
  { group: GROUP_FOLLOW, order: 1, key: 'go-to-reference-new-tab', label: (ctx) => ctx.t('Go To Reference in Code (New Tab)'), visible: (ctx) => ctx.reference.nodeId !== null, run: (ctx) => ctx.follow(true) },
]

const menuContent = (icon: ReactNode, label: string, shortcut?: string): ReactNode => (
  <>
    <span className="document-tab-menu-icon">{icon}</span>
    <span className="document-tab-menu-label">{label}</span>
    <span className="document-tab-menu-shortcut">{shortcut}</span>
  </>
)

/** The menu's entries by group then order, with a separator between the groups that have any. */
export const buildStringReferencesMenuItems = (ctx: StringReferencesMenuContext): PopupMenuEntry[] => {
  const items: PopupMenuEntry[] = []
  let lastGroup: number | undefined
  for (const entry of ENTRIES.filter((candidate) => candidate.visible(ctx)).sort((a, b) => a.group - b.group || a.order - b.order)) {
    if (lastGroup !== undefined && entry.group !== lastGroup)
      items.push({ type: 'divider', key: `separator-${entry.group}` })
    lastGroup = entry.group
    items.push({ key: entry.key, content: menuContent(entry.icon, entry.label(ctx), entry.shortcut?.(ctx)), onSelect: () => entry.run(ctx) })
  }
  return items
}

export const showStringReferencesContextMenu = (ctx: StringReferencesMenuContext, position: { x: number; y: number }, returnFocusTo?: HTMLElement): void => {
  showPopupMenu({
    anchor: position,
    returnFocusTo,
    title: ctx.t('String References'),
    items: buildStringReferencesMenuItems(ctx),
    onClose: () => undefined,
  })
}
