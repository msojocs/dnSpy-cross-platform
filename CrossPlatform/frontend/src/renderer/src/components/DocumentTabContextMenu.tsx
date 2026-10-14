import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import {
  Actions,
  DockLocation,
  Model,
  Orientation,
  RowNode,
  showPopupMenu,
  TabNode,
  TabSetNode,
  type IPopupMenuItem,
  type PopupMenuEntry,
} from 'flexlayout-react'
import { Columns2, CopyMinus, CopyPlus, PanelsTopLeft, Rows2, Save, X } from 'lucide-react'

export interface DocumentTabMenuState {
  tabSet: TabSetNode
  canSave: boolean
  canClose: boolean
  canCloseAll: boolean
  canCloseOthers: boolean
  canClone: boolean
  canCreateHorizontalGroup: boolean
  canCreateVerticalGroup: boolean
}

interface DocumentTabMenuOptions {
  t(message: string): string
  canSave(tab: TabNode): boolean
  canClone(tab: TabNode): boolean
  onSave(tab: TabNode): void
  onModelChanged(): void
}

const allTabs = (node: TabSetNode): TabNode[] => {
  const tabs: TabNode[] = []
  const visit = (current: ReturnType<TabSetNode['getChildren']>[number]): void => {
    if (current instanceof TabNode)
      tabs.push(current)
    else
      current.getChildren().forEach(visit)
  }
  node.getChildren().forEach(visit)
  return tabs
}

export const getDocumentTabSet = (tab: TabNode): TabSetNode | undefined => {
  let parent = tab.getParent()
  while (parent && !(parent instanceof TabSetNode))
    parent = parent.getParent()
  return parent instanceof TabSetNode ? parent : undefined
}

/** The components that make up the document area. Every other tab is a tool window, and the tool windows
 *  share the layout root with the editor — the explorer is a border and stays out of it. */
const DOCUMENT_TAB_COMPONENTS = new Set(['document', 'hex', 'module-info', 'start'])

const isDocumentTab = (tab: TabNode): boolean => DOCUMENT_TAB_COMPONENTS.has(tab.getComponent() ?? '')

/** A tab set of tool windows and nothing else. Without this the commands below would treat the tool
 *  window dock as an editor group: the tab menu would be offered for it, "Close All Tabs" would close
 *  the tool windows too, and the split commands would count it as a document group. */
const isToolWindowTabSet = (tabSet: TabSetNode): boolean => {
  const tabs = allTabs(tabSet)
  return tabs.length > 0 && tabs.every((tab) => !isDocumentTab(tab))
}

export const getDocumentTabSets = (model: Model): TabSetNode[] => {
  const root = model.getRootRow()
  if (!root) return []
  const tabSets: TabSetNode[] = []
  const visit = (node: ReturnType<RowNode['getChildren']>[number]): void => {
    if (node instanceof TabSetNode)
      tabSets.push(node)
    else
      node.getChildren().forEach(visit)
  }
  root.getChildren().forEach(visit)
  return tabSets.filter((tabSet) => !isToolWindowTabSet(tabSet))
}

/** Returns every document tab in display order for the Window > All Windows menu. */
export const getDocumentTabs = (model: Model): TabNode[] => getDocumentTabSets(model).flatMap(allTabs)

const belongsToDocumentLayout = (model: Model, tabSet: TabSetNode): boolean =>
  getDocumentTabSets(model).includes(tabSet)

export const getDocumentTabMenuState = (
  tab: TabNode,
  canSave: boolean,
  canClone: boolean,
): DocumentTabMenuState | undefined => {
  const model = tab.getModel()
  const tabSet = getDocumentTabSet(tab)
  if (!tabSet || !belongsToDocumentLayout(model, tabSet))
    return undefined

  const tabsInGroup = allTabs(tabSet)
  const nonEmptyTabSets = getDocumentTabSets(model).filter((candidate) => allTabs(candidate).length > 0)
  const commonParent = nonEmptyTabSets[0]?.getParent()
  const hasFlatGroupLayout = Boolean(commonParent)
    && nonEmptyTabSets.every((candidate) => candidate.getParent() === commonParent)
  const groupOrientation = hasFlatGroupLayout && commonParent instanceof RowNode
    ? commonParent.getOrientation()
    : undefined
  const canSplit = tabsInGroup.length > 1

  return {
    tabSet,
    canSave,
    canClose: tab.isCloseable(),
    canCloseAll: getDocumentTabSets(model).some((candidate) => allTabs(candidate).some((item) => item.isCloseable())),
    canCloseOthers: tabsInGroup.some((item) => item !== tab && item.isCloseable()),
    canClone,
    // Horizontal groups are stacked top-to-bottom; vertical groups are side-by-side.
    canCreateHorizontalGroup: canSplit
      && (nonEmptyTabSets.length === 1 || groupOrientation === Orientation.VERT),
    canCreateVerticalGroup: canSplit
      && (nonEmptyTabSets.length === 1 || groupOrientation === Orientation.HORZ),
  }
}

export const closeDocumentTab = (tab: TabNode): void => {
  if (tab.isCloseable())
    tab.getModel().doAction(Actions.deleteTab(tab.getId()))
}

/** Closes every tab showing `documentId` — what deleting its node does to the documents it had open. A module's
 *  hex and information tabs name it by its root's id, so taking the root away closes those too. */
export const closeDocumentTabsFor = (model: Model, documentId: string): void => {
  for (const tab of getDocumentTabSets(model).flatMap(allTabs)) {
    const config = tab.getConfig() as { documentId?: string; moduleId?: string } | undefined
    if (tab.isCloseable() && (config?.documentId === documentId || config?.moduleId === documentId))
      model.doAction(Actions.deleteTab(tab.getId()))
  }
}

export const closeAllDocumentTabs = (model: Model): void => {
  const tabs = getDocumentTabSets(model)
    .flatMap(allTabs)
    .filter((tab) => tab.isCloseable())
  for (const tab of tabs)
    model.doAction(Actions.deleteTab(tab.getId()))
}

export const closeOtherDocumentTabs = (tab: TabNode): void => {
  const tabSet = getDocumentTabSet(tab)
  if (!tabSet) return
  for (const other of allTabs(tabSet)) {
    if (other !== tab && other.isCloseable())
      tab.getModel().doAction(Actions.deleteTab(other.getId()))
  }
}

export const cloneDocumentTab = (tab: TabNode): TabNode | undefined => {
  const tabSet = getDocumentTabSet(tab)
  if (!tabSet || tab.getComponent() !== 'document') return undefined
  const model = tab.getModel()
  const idPrefix = `${tab.getId()}:clone`
  let cloneNumber = 1
  while (model.getNodeById(`${idPrefix}:${cloneNumber}`))
    cloneNumber++
  const clone = model.doAction(Actions.addNode({
    ...tab.toJson(),
    id: `${idPrefix}:${cloneNumber}`,
  }, tabSet.getId(), DockLocation.CENTER, -1, true))
  return clone instanceof TabNode ? clone : undefined
}

export const createDocumentTabGroup = (tab: TabNode, horizontal: boolean): void => {
  const tabSet = getDocumentTabSet(tab)
  if (!tabSet) return
  tab.getModel().doAction(Actions.moveNode(
    tab.getId(),
    tabSet.getId(),
    horizontal ? DockLocation.BOTTOM : DockLocation.RIGHT,
    -1,
    true,
  ))
}

const menuContent = (icon: ReactNode, label: string, shortcut?: string): ReactNode => (
  <>
    <span className="document-tab-menu-icon">{icon}</span>
    <span className="document-tab-menu-label">{label}</span>
    {shortcut && <span className="document-tab-menu-shortcut">{shortcut}</span>}
  </>
)

const menuItem = (
  key: string,
  label: string,
  icon: ReactNode,
  onSelect: () => void,
  disabled = false,
  shortcut?: string,
): IPopupMenuItem => ({
  key,
  content: menuContent(icon, label, shortcut),
  disabled,
  onSelect,
})

export const buildDocumentTabMenuItems = (
  tab: TabNode,
  state: DocumentTabMenuState,
  options: DocumentTabMenuOptions,
): PopupMenuEntry[] => {
  const iconProps = { size: 14, strokeWidth: 1.7, 'aria-hidden': true as const }
  const changed = (action: () => void): (() => void) => () => {
    action()
    options.onModelChanged()
  }
  const items: PopupMenuEntry[] = [
    menuItem('save-code', options.t('Save Code...'), <Save {...iconProps} />, () => options.onSave(tab), !state.canSave, 'Ctrl+S'),
    menuItem('close', options.t('Close'), <X {...iconProps} />, changed(() => closeDocumentTab(tab)), !state.canClose, 'Ctrl+F4'),
    menuItem('close-all', options.t('Close All Tabs'), <PanelsTopLeft {...iconProps} />, changed(() => closeAllDocumentTabs(tab.getModel())), !state.canCloseAll),
    menuItem('close-others', options.t('Close All But This'), <CopyMinus {...iconProps} />, changed(() => closeOtherDocumentTabs(tab)), !state.canCloseOthers),
  ]

  if (state.canClone) {
    items.push(menuItem('new-tab', options.t('New Tab'), <CopyPlus {...iconProps} />, changed(() => {
      cloneDocumentTab(tab)
    })))
  }

  if (state.canCreateHorizontalGroup || state.canCreateVerticalGroup) {
    items.push({ type: 'divider', key: 'tab-groups' })
    if (state.canCreateHorizontalGroup) {
      items.push(menuItem('new-horizontal-group', options.t('New Horizontal Tab Group'), <Rows2 {...iconProps} />, changed(() => {
        createDocumentTabGroup(tab, true)
      })))
    }
    if (state.canCreateVerticalGroup) {
      items.push(menuItem('new-vertical-group', options.t('New Vertical Tab Group'), <Columns2 {...iconProps} />, changed(() => {
        createDocumentTabGroup(tab, false)
      })))
    }
  }

  return items
}

export const showDocumentTabContextMenu = (
  tab: TabNode,
  event: ReactMouseEvent<HTMLElement, MouseEvent>,
  options: DocumentTabMenuOptions,
): boolean => {
  const state = getDocumentTabMenuState(tab, options.canSave(tab), options.canClone(tab))
  if (!state || !tab.isCloseable())
    return false

  event.preventDefault()
  event.stopPropagation()
  tab.getModel().doAction(Actions.selectTab(tab.getId()))
  options.onModelChanged()
  const returnFocusTo = event.currentTarget
  showPopupMenu({
    anchor: { x: event.clientX, y: event.clientY },
    container: tab.getLayoutRef() ?? undefined,
    returnFocusTo,
    title: options.t('Tab actions'),
    items: buildDocumentTabMenuItems(tab, state, options),
    onClose: () => undefined,
  })
  return true
}
