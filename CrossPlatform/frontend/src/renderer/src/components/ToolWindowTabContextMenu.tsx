import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { Actions, showPopupMenu, TabNode, TabSetNode, type IPopupMenuItem, type PopupMenuEntry } from 'flexlayout-react'
import { DsIcon } from './DsIcon'
import type { ToolWindowLocation } from '../command-line-options'

interface ToolWindowTabMenuOptions {
  t(message: string, values?: Record<string, string | number>): string
  /** Whether the window is somewhere other than the dock the location names — dnSpy's CanMove. */
  canMove(tab: TabNode, location: ToolWindowLocation): boolean
  onMove(tab: TabNode, location: ToolWindowLocation): void
  onMoveGroup(tab: TabNode, location: ToolWindowLocation): void
  onModelChanged(): void
}

/** The four edges dnSpy's Move commands offer, in the order its submenu lists them, with the labels its
 *  "_Move" and "Move _Group" submenus hold. The menu this port draws has no submenus, so each entry says
 *  which of the two it belongs to and the edge it names. */
const LOCATIONS: readonly { location: ToolWindowLocation; label: string; groupLabel: string; icon: ReactNode }[] = [
  { location: 'top', label: 'Move to Top', groupLabel: 'Move Group to Top', icon: <DsIcon name="ToolstripPanelTop" /> },
  { location: 'left', label: 'Move to Left', groupLabel: 'Move Group to Left', icon: <DsIcon name="ToolstripPanelLeft" /> },
  { location: 'right', label: 'Move to Right', groupLabel: 'Move Group to Right', icon: <DsIcon name="ToolstripPanelRight" /> },
  { location: 'bottom', label: 'Move to Bottom', groupLabel: 'Move Group to Bottom', icon: <DsIcon name="ToolstripPanelBottom" /> },
]

const menuItem = (key: string, label: string, icon: ReactNode, onSelect: () => void, disabled = false): IPopupMenuItem => ({
  key,
  content: (
    <>
      <span className="document-tab-menu-icon">{icon}</span>
      <span className="document-tab-menu-label">{label}</span>
    </>
  ),
  disabled,
  onSelect,
})

/** Every tab of a tab set, itself included when it holds tabs of its own. */
const allTabs = (tabSet: TabSetNode): TabNode[] => {
  const tabs: TabNode[] = []
  const visit = (node: ReturnType<TabSetNode['getChildren']>[number]): void => {
    if (node instanceof TabNode)
      tabs.push(node)
    else
      node.getChildren().forEach(visit)
  }
  tabSet.getChildren().forEach(visit)
  return tabs
}

export const buildToolWindowTabMenuItems = (tab: TabNode, options: ToolWindowTabMenuOptions): PopupMenuEntry[] => {
  const group = tab.getParent()
  const isGroup = group instanceof TabSetNode && allTabs(group).length > 1
  const changed = (action: () => void): (() => void) => () => {
    action()
    options.onModelChanged()
  }
  // dnSpy's tool window menu: Hide, Hide All, then the two Move submenus — which are listed flat here,
  // because the menu this port draws has no submenus. The group's own commands are only there when the
  // window shares its dock, which is when there is a group to move.
  const items: PopupMenuEntry[] = [
    menuItem('hide', options.t('Hide'), <DsIcon name="TableViewNameOnly" />, changed(() => {
      tab.getModel().doAction(Actions.deleteTab(tab.getId()))
    }), !tab.isCloseable()),
    menuItem('hide-all', options.t('Hide All Tabs'), <DsIcon name="CloseDocumentGroup" />, changed(() => {
      for (const other of group instanceof TabSetNode ? allTabs(group) : [tab]) {
        if (other.isCloseable())
          tab.getModel().doAction(Actions.deleteTab(other.getId()))
      }
    }), !(group instanceof TabSetNode && allTabs(group).some((other) => other.isCloseable()))),
  ]
  items.push({ type: 'divider', key: 'move' })
  for (const entry of LOCATIONS) {
    items.push(menuItem(`move-${entry.location}`, options.t(entry.label), entry.icon,
      changed(() => options.onMove(tab, entry.location)), !options.canMove(tab, entry.location)))
  }
  if (isGroup) {
    items.push({ type: 'divider', key: 'move-group' })
    for (const entry of LOCATIONS) {
      items.push(menuItem(`move-group-${entry.location}`, options.t(entry.groupLabel), entry.icon,
        changed(() => options.onMoveGroup(tab, entry.location)), !options.canMove(tab, entry.location)))
    }
  }
  return items
}

/** The menu dnSpy offers on a tool window's tab (DsToolWindowServiceCommands). The caller decides which of
 *  the two menus a tab gets: this one is for a dock of tool windows, the tab menu for one of documents. */
export const showToolWindowTabContextMenu = (
  tab: TabNode,
  event: ReactMouseEvent<HTMLElement, MouseEvent>,
  options: ToolWindowTabMenuOptions,
): void => {
  event.preventDefault()
  event.stopPropagation()
  tab.getModel().doAction(Actions.selectTab(tab.getId()))
  options.onModelChanged()
  showPopupMenu({
    anchor: { x: event.clientX, y: event.clientY },
    container: tab.getLayoutRef() ?? undefined,
    returnFocusTo: event.currentTarget,
    title: options.t('Tool Window'),
    items: buildToolWindowTabMenuItems(tab, options),
    onClose: () => undefined,
  })
}
