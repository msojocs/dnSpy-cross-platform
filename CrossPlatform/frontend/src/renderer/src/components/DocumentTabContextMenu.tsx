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
import { MenuEntryIcon } from './DsIcon'

export interface DocumentTabMenuState {
  tabSet: TabSetNode
  canSave: boolean
  canClose: boolean
  canCloseAll: boolean
  canCloseOthers: boolean
  canClone: boolean
  canCreateHorizontalGroup: boolean
  canCreateVerticalGroup: boolean
  /** dnSpy's tab group commands, which act on the group the tab is in rather than on the tab. */
  group: DocumentTabGroupState
}

/** What the tab menu's group section can offer, which is dnSpy's own set of rules: a second group has to
 *  be there before anything can be moved between groups, and the group commands need tabs to act on. */
export interface DocumentTabGroupState {
  canMoveToNextGroup: boolean
  canMoveAllToNextGroup: boolean
  canMoveToPreviousGroup: boolean
  canMoveAllToPreviousGroup: boolean
  canCloseGroup: boolean
  canCloseOtherGroups: boolean
  canMoveGroupAfterNext: boolean
  canMoveGroupBeforePrevious: boolean
  canMergeGroups: boolean
  canUseVerticalGroups: boolean
  canUseHorizontalGroups: boolean
}

interface DocumentTabMenuOptions {
  t(message: string): string
  canSave(tab: TabNode): boolean
  canClone(tab: TabNode): boolean
  onSave(tab: TabNode): void
  onModelChanged(): void
  /** The Window menu's own commands, reused here as dnSpy reuses them: the tab menu carries the same
   *  tab-group entries the Window menu does. */
  moveTabToGroup(tab: TabNode, offset: -1 | 1, all: boolean): void
  moveGroup(tab: TabNode, after: boolean): void
  closeGroup(tab: TabNode): void
  closeOtherGroups(tab: TabNode): void
  mergeGroups(): void
  arrangeGroups(horizontal: boolean): void
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

/** Whether a tab is a tool window's — the dock the shell moves and hides from its own menu — as against one
 *  of the editor's documents, which get the tab menu. The explorer counts as a tool window, as it does
 *  upstream: it is a window like any other that happens to be docked down the left. */
export const isToolWindowTab = (tab: TabNode): boolean => {
  const tabSet = getDocumentTabSet(tab)
  return tabSet ? isToolWindowTabSet(tabSet) : false
}

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
  const index = nonEmptyTabSets.indexOf(tabSet)
  // Horizontal groups are stacked top-to-bottom; vertical groups are side-by-side.
  const canCreateHorizontalGroup = canSplit
    && (nonEmptyTabSets.length === 1 || groupOrientation === Orientation.VERT)
  const canCreateVerticalGroup = canSplit
    && (nonEmptyTabSets.length === 1 || groupOrientation === Orientation.HORZ)
  // dnSpy's own rules (TabGroupService's CanExecute properties), which measure everything against the group
  // a command was invoked on: the ones that act on a group need a second one to move to or merge with, the
  // ones that move every tab of a group need more than one tab, and the two arrangements need the groups to
  // be arranged the other way round already.
  const groupCount = nonEmptyTabSets.length
  const hasGroupAfter = index >= 0 && index + 1 < groupCount
  const hasGroupBefore = index > 0
  const closableInGroup = tabsInGroup.some((item) => item.isCloseable())

  return {
    tabSet,
    canSave,
    canClose: tab.isCloseable(),
    canCloseAll: getDocumentTabSets(model).some((candidate) => allTabs(candidate).some((item) => item.isCloseable())),
    canCloseOthers: tabsInGroup.some((item) => item !== tab && item.isCloseable()),
    canClone,
    canCreateHorizontalGroup,
    canCreateVerticalGroup,
    group: {
      canMoveToNextGroup: hasGroupAfter,
      canMoveAllToNextGroup: hasGroupAfter && canSplit,
      canMoveToPreviousGroup: hasGroupBefore,
      canMoveAllToPreviousGroup: hasGroupBefore && canSplit,
      canCloseGroup: groupCount > 1 && closableInGroup,
      canCloseOtherGroups: groupCount > 1 && nonEmptyTabSets.some((candidate) => candidate !== tabSet && allTabs(candidate).some((item) => item.isCloseable())),
      canMoveGroupAfterNext: hasGroupAfter,
      canMoveGroupBeforePrevious: hasGroupBefore,
      canMergeGroups: groupCount > 1,
      // dnSpy's two arrangements are named after the split line, not the stacking: "Use Vertical Tab Groups"
      // lays the groups out side by side, and is offered while they are stacked rather than after.
      canUseVerticalGroups: groupCount > 1 && groupOrientation === Orientation.VERT,
      canUseHorizontalGroups: groupCount > 1 && groupOrientation === Orientation.HORZ,
    },
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
  // Each entry wears the image its ExportMenuItem names in dnSpy's tab menu (GROUP_CTX_TABS_*, TabCommands
  // and SaveCommands); the ones it gives no Icon to leave the column blank.
  const changed = (action: () => void): (() => void) => () => {
    action()
    options.onModelChanged()
  }
  const items: PopupMenuEntry[] = [
    menuItem('save-code', options.t('Save Code...'), <MenuEntryIcon name="Save" />, () => options.onSave(tab), !state.canSave, 'Ctrl+S'),
    menuItem('close', options.t('Close'), null, changed(() => closeDocumentTab(tab)), !state.canClose, 'Ctrl+F4'),
    menuItem('close-all', options.t('Close All Tabs'), <MenuEntryIcon name="CloseDocumentGroup" />, changed(() => closeAllDocumentTabs(tab.getModel())), !state.canCloseAll),
    menuItem('close-others', options.t('Close All But This'), null, changed(() => closeOtherDocumentTabs(tab)), !state.canCloseOthers),
  ]

  if (state.canClone) {
    items.push(menuItem('new-tab', options.t('New Tab'), null, changed(() => {
      cloneDocumentTab(tab)
    })))
  }

  if (state.canCreateHorizontalGroup || state.canCreateVerticalGroup) {
    items.push({ type: 'divider', key: 'tab-groups' })
    if (state.canCreateHorizontalGroup) {
      items.push(menuItem('new-horizontal-group', options.t('New Horizontal Tab Group'), <MenuEntryIcon name="SplitScreenHorizontally" />, changed(() => {
        createDocumentTabGroup(tab, true)
      })))
    }
    if (state.canCreateVerticalGroup) {
      items.push(menuItem('new-vertical-group', options.t('New Vertical Tab Group'), <MenuEntryIcon name="SplitScreenVertically" />, changed(() => {
        createDocumentTabGroup(tab, false)
      })))
    }
  }

  // dnSpy's tab menu carries the Window menu's tab group commands as well (TabCommands' TABS_GROUPS group),
  // in the same order the Window menu lists them. dnSpy hides each one that cannot run rather than greying it
  // out, so a group on its own shows only the entries that act on it, and a section with none is not there.
  const group = state.group
  const groupItems = [
    group.canMoveToNextGroup && menuItem('move-next-group', options.t('Move to Next Tab Group'), null,
      changed(() => options.moveTabToGroup(tab, 1, false))),
    group.canMoveAllToNextGroup && menuItem('move-all-next-group', options.t('Move All Tabs to Next Tab Group'), null,
      changed(() => options.moveTabToGroup(tab, 1, true))),
    group.canMoveToPreviousGroup && menuItem('move-previous-group', options.t('Move to Previous Tab Group'), null,
      changed(() => options.moveTabToGroup(tab, -1, false))),
    group.canMoveAllToPreviousGroup && menuItem('move-all-previous-group', options.t('Move All Tabs to Previous Tab Group'), null,
      changed(() => options.moveTabToGroup(tab, -1, true))),
  ].filter((item): item is IPopupMenuItem => item !== false)
  if (groupItems.length > 0) {
    items.push({ type: 'divider', key: 'tab-group-moves' })
    items.push(...groupItems)
  }

  const closeItems = [
    group.canCloseGroup && menuItem('close-group', options.t('Close Tab Group'), null,
      changed(() => options.closeGroup(tab))),
    group.canCloseOtherGroups && menuItem('close-other-groups', options.t('Close All Tab Groups But This'), null,
      changed(() => options.closeOtherGroups(tab))),
    group.canMoveGroupAfterNext && menuItem('move-group-after', options.t('Move Tab Group After Next Tab Group'), null,
      changed(() => options.moveGroup(tab, true))),
    group.canMoveGroupBeforePrevious && menuItem('move-group-before', options.t('Move Tab Group Before Previous Tab Group'), null,
      changed(() => options.moveGroup(tab, false))),
    group.canMergeGroups && menuItem('merge-groups', options.t('Merge All Tab Groups'), null,
      changed(() => options.mergeGroups())),
  ].filter((item): item is IPopupMenuItem => item !== false)
  const arrangeItems = [
    group.canUseVerticalGroups && menuItem('use-vertical-groups', options.t('Use Vertical Tab Groups'), <MenuEntryIcon name="SplitScreenVertically" />,
      changed(() => options.arrangeGroups(false))),
    group.canUseHorizontalGroups && menuItem('use-horizontal-groups', options.t('Use Horizontal Tab Groups'), <MenuEntryIcon name="SplitScreenHorizontally" />,
      changed(() => options.arrangeGroups(true))),
  ].filter((item): item is IPopupMenuItem => item !== false)
  if (closeItems.length > 0 || arrangeItems.length > 0) {
    items.push({ type: 'divider', key: 'tab-group-commands' })
    items.push(...closeItems, ...arrangeItems)
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
