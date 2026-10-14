import { DockLocation, Model, Orientation, RowNode, TabNode, TabSetNode, type IJsonModel } from 'flexlayout-react'
import { describe, expect, it, vi } from 'vitest'
import {
  buildDocumentTabMenuItems,
  cloneDocumentTab,
  closeAllDocumentTabs,
  closeOtherDocumentTabs,
  createDocumentTabGroup,
  getDocumentTabMenuState,
  getDocumentTabSets,
} from './DocumentTabContextMenu'

const createModel = (tabCount = 2): Model => Model.fromJson({
  global: { tabSetEnableDeleteWhenEmpty: true },
  layout: {
    type: 'row',
    children: [{
      type: 'tabset',
      id: 'documents',
      selected: 0,
      children: Array.from({ length: tabCount }, (_, index) => ({
        type: 'tab' as const,
        id: `doc:${index + 1}`,
        name: `Document ${index + 1}`,
        component: 'document',
        config: { documentId: `${index + 1}` },
      })),
    }],
  },
} satisfies IJsonModel)

const getTab = (model: Model, id: string): TabNode => {
  const tab = model.getNodeById(id)
  if (!(tab instanceof TabNode)) throw new Error(`Missing tab ${id}`)
  return tab
}

const menuKeys = (model: Model, tab: TabNode, canClone = true): string[] => {
  const state = getDocumentTabMenuState(tab, true, canClone)
  if (!state) throw new Error('Missing menu state')
  return buildDocumentTabMenuItems(tab, state, {
    t: (message) => message,
    canSave: () => true,
    canClone: () => canClone,
    onSave: vi.fn(),
    onModelChanged: vi.fn(),
    moveTabToGroup: vi.fn(),
    moveGroup: vi.fn(),
    closeGroup: vi.fn(),
    closeOtherGroups: vi.fn(),
    mergeGroups: vi.fn(),
    arrangeGroups: vi.fn(),
  }).map((item) => item.key)
}

describe('DocumentTabContextMenu', () => {
  it('shows the upstream commands and disables close-others for a single tab', () => {
    const model = createModel(1)
    const tab = getTab(model, 'doc:1')
    const state = getDocumentTabMenuState(tab, true, true)

    expect(state).toMatchObject({
      canSave: true,
      canClose: true,
      canCloseAll: true,
      canCloseOthers: false,
      canClone: true,
      canCreateHorizontalGroup: false,
      canCreateVerticalGroup: false,
    })
    expect(menuKeys(model, tab)).toEqual(['save-code', 'close', 'close-all', 'close-others', 'new-tab'])
  })

  it('clones the active document with a unique id and the same document config', () => {
    const model = createModel(1)
    const source = getTab(model, 'doc:1')

    const first = cloneDocumentTab(source)
    const second = cloneDocumentTab(source)

    expect(first?.getId()).toBe('doc:1:clone:1')
    expect(second?.getId()).toBe('doc:1:clone:2')
    expect(first?.getConfig()).toEqual({ documentId: '1' })
    expect(first?.isSelected()).toBe(false)
    expect(second?.isSelected()).toBe(true)
  })

  it('closes other tabs only in the selected group and closes all tabs across groups', () => {
    const model = createModel(3)
    const selected = getTab(model, 'doc:2')
    createDocumentTabGroup(getTab(model, 'doc:3'), false)

    closeOtherDocumentTabs(selected)
    expect(model.getNodeById('doc:1')).toBeUndefined()
    expect(model.getNodeById('doc:2')).toBe(selected)
    expect(model.getNodeById('doc:3')).toBeInstanceOf(TabNode)

    closeAllDocumentTabs(model)
    expect(getDocumentTabSets(model)).toHaveLength(1)
    expect(getDocumentTabSets(model)[0].getChildren()).toHaveLength(0)
  })

  it('offers only the existing group orientation after the first split', () => {
    const horizontalModel = createModel(3)
    createDocumentTabGroup(getTab(horizontalModel, 'doc:3'), true)
    const horizontalTab = getTab(horizontalModel, 'doc:1')
    const horizontalState = getDocumentTabMenuState(horizontalTab, true, true)
    expect(horizontalState).toMatchObject({
      canCreateHorizontalGroup: true,
      canCreateVerticalGroup: false,
    })
    expect(getDocumentTabSets(horizontalModel)[0].getParent()?.getOrientation()).toBe(Orientation.VERT)

    const verticalModel = createModel(3)
    createDocumentTabGroup(getTab(verticalModel, 'doc:3'), false)
    const verticalTab = getTab(verticalModel, 'doc:1')
    const verticalState = getDocumentTabMenuState(verticalTab, true, true)
    expect(verticalState).toMatchObject({
      canCreateHorizontalGroup: false,
      canCreateVerticalGroup: true,
    })
    const root = verticalModel.getRootRow()
    expect(root).toBeInstanceOf(RowNode)
    expect(root?.getOrientation()).toBe(Orientation.HORZ)
    expect(getDocumentTabSets(verticalModel).every((tabSet) => tabSet instanceof TabSetNode)).toBe(true)
  })

  it('moves the selected tab into the new group', () => {
    const model = createModel(2)
    const tab = getTab(model, 'doc:2')

    createDocumentTabGroup(tab, false)

    expect(getDocumentTabSets(model)).toHaveLength(2)
    expect(tab.isSelected()).toBe(true)
    expect(tab.getParent()).toBeInstanceOf(TabSetNode)
    expect(tab.getParent()?.getId()).not.toBe('documents')
    expect(DockLocation.RIGHT.getOrientation()).toBe(Orientation.HORZ)
  })
})

describe('DocumentTabContextMenu tab group commands', () => {
  // Two groups side by side, which in dnSpy's terms are vertical groups: the row they share runs left to
  // right, so the entries that need a second group are all there and the ones that would make one are not.
  const twoGroups = (): Model => Model.fromJson({
    global: { tabSetEnableDeleteWhenEmpty: true },
    layout: {
      type: 'row',
      children: [1, 2].map((group) => ({
        type: 'tabset' as const,
        id: `documents-${group}`,
        selected: 0,
        children: [1, 2].map((tab) => ({
          type: 'tab' as const,
          id: `doc:${group}-${tab}`,
          name: `Document ${group}-${tab}`,
          component: 'document',
          config: { documentId: `${group}${tab}` },
        })),
      })),
    },
  } satisfies IJsonModel)

  it('offers the group commands a second group makes possible', () => {
    const model = twoGroups()
    const first = getTab(model, 'doc:1-1')
    expect(menuKeys(model, first)).toEqual([
      'save-code', 'close', 'close-all', 'close-others', 'new-tab',
      'tab-groups', 'new-vertical-group',
      'tab-group-moves', 'move-next-group', 'move-all-next-group',
      'tab-group-commands', 'close-group', 'close-other-groups', 'move-group-after', 'merge-groups', 'use-horizontal-groups',
    ])
  })

  it('offers the other way round for the last group, and nothing that would need a group after it', () => {
    const model = twoGroups()
    const last = getTab(model, 'doc:2-1')
    expect(menuKeys(model, last)).toEqual([
      'save-code', 'close', 'close-all', 'close-others', 'new-tab',
      'tab-groups', 'new-vertical-group',
      'tab-group-moves', 'move-previous-group', 'move-all-previous-group',
      'tab-group-commands', 'close-group', 'close-other-groups', 'move-group-before', 'merge-groups', 'use-horizontal-groups',
    ])
  })

  it('leaves out the arrangement the groups are already in', () => {
    const model = twoGroups()
    // The groups are in a row, which is what "use vertical tab groups" — named after the split line — would
    // make of them anyway, so only the other arrangement is offered.
    expect(menuKeys(model, getTab(model, 'doc:1-1'))).not.toContain('use-vertical-groups')
    expect(menuKeys(model, getTab(model, 'doc:1-1'))).toContain('use-horizontal-groups')
  })

  it('runs the command the entry names, over the tab it was opened on', () => {
    const model = twoGroups()
    const tab = getTab(model, 'doc:1-1')
    const state = getDocumentTabMenuState(tab, true, true)!
    const onCloseOtherGroups = vi.fn()
    const items = buildDocumentTabMenuItems(tab, state, {
      t: (message) => message,
      canSave: () => true,
      canClone: () => true,
      onSave: vi.fn(),
      onModelChanged: vi.fn(),
      moveTabToGroup: vi.fn(),
      moveGroup: vi.fn(),
      closeGroup: vi.fn(),
      closeOtherGroups: onCloseOtherGroups,
      mergeGroups: vi.fn(),
      arrangeGroups: vi.fn(),
    })
    const entry = items.find((item) => item.key === 'close-other-groups')
    if (!entry || entry.type === 'divider') throw new Error('Missing menu item close-other-groups')
    entry.onSelect?.({} as never)
    expect(onCloseOtherGroups).toHaveBeenCalledWith(tab)
  })
})
