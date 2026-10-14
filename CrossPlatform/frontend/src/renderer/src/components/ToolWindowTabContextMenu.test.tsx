import { Model, TabNode, TabSetNode, type IJsonModel, type PopupMenuEntry } from 'flexlayout-react'
import { describe, expect, it, vi } from 'vitest'
import { buildToolWindowTabMenuItems } from './ToolWindowTabContextMenu'

/** The window's default docks, in miniature: the explorer's column on the left and the tool windows under
 * the editor, which is the pair the Move commands have to work between. */
const createModel = (toolWindows = ['search', 'analysis']): Model => Model.fromJson({
  global: { tabSetEnableDeleteWhenEmpty: true },
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset',
        id: 'explorer-dock',
        children: [{ type: 'tab' as const, id: 'explorer', name: 'Assembly Explorer', component: 'explorer', enableClose: true }],
      },
      {
        type: 'row',
        id: 'editor-column',
        children: [
          { type: 'tabset', id: 'documents', children: [{ type: 'tab' as const, id: 'start', name: 'Start', component: 'start', enableClose: false }] },
          {
            type: 'tabset',
            id: 'toolwindows',
            children: toolWindows.map((id) => ({ type: 'tab' as const, id, name: id, component: id, enableClose: true })),
          },
        ],
      },
    ],
  },
} satisfies IJsonModel)

const getTab = (model: Model, id: string): TabNode => {
  const tab = model.getNodeById(id)
  if (!(tab instanceof TabNode)) throw new Error(`Missing tab ${id}`)
  return tab
}

const select = (items: PopupMenuEntry[], key: string): void => {
  const item = items.find((entry) => entry.key === key)
  if (!item || item.type === 'divider') throw new Error(`Missing menu item ${key}`)
  item.onSelect?.({} as never)
}

const menuKeys = (model: Model, id: string, canMove: () => boolean = () => true): string[] =>
  buildToolWindowTabMenuItems(getTab(model, id), {
    t: (message) => message,
    canMove,
    onMove: vi.fn(),
    onMoveGroup: vi.fn(),
    onModelChanged: vi.fn(),
  }).map((item) => item.key)

describe('ToolWindowTabContextMenu', () => {
  it('offers dnSpy\'s window commands: Hide, Hide All and the two Move groups', () => {
    const model = createModel()
    expect(menuKeys(model, 'search')).toEqual([
      'hide', 'hide-all', 'move',
      'move-top', 'move-left', 'move-right', 'move-bottom',
      'move-group', 'move-group-top', 'move-group-left', 'move-group-right', 'move-group-bottom',
    ])
  })

  it('leaves the group commands off a window that has no neighbours', () => {
    // One tab in the dock is a window on its own, not a group, so there is no group to move.
    expect(menuKeys(createModel(['search']), 'search')).toEqual([
      'hide', 'hide-all', 'move', 'move-top', 'move-left', 'move-right', 'move-bottom',
    ])
  })

  it('disables a move to the dock the window is already in', () => {
    const model = createModel()
    // dnSpy's CanMove: the tool windows' own dock is below the editor, so moving there is offered to the
    // explorer but not to a window already in it.
    const canMove = (tab: TabNode, location: string): boolean => !(tab.getId() === 'search' && location === 'bottom')
    const items = buildToolWindowTabMenuItems(getTab(model, 'search'), {
      t: (message) => message,
      canMove,
      onMove: vi.fn(),
      onMoveGroup: vi.fn(),
      onModelChanged: vi.fn(),
    })
    expect(items.find((item) => item.key === 'move-bottom')).toMatchObject({ disabled: true })
    expect(items.find((item) => item.key === 'move-left')).toMatchObject({ disabled: false })
  })

  it('hides the window and everything docked beside it', () => {
    const model = createModel()
    const items = buildToolWindowTabMenuItems(getTab(model, 'search'), {
      t: (message) => message,
      canMove: () => true,
      onMove: vi.fn(),
      onMoveGroup: vi.fn(),
      onModelChanged: vi.fn(),
    })
    select(items, 'hide-all')
    expect(model.getNodeById('search')).toBeUndefined()
    expect(model.getNodeById('analysis')).toBeUndefined()
    expect(model.getNodeById('start')).toBeInstanceOf(TabNode)
    // The dock goes with its last window: this model deletes an emptied tab set, as the shell's own docks
    // do not — the tool windows' dock outlives its windows and is what a window is put back into.
    expect(model.getNodeById('toolwindows')).toBeUndefined()
  })

  it('moves the tab the command was opened on to the edge it names', () => {
    const model = createModel()
    const onMove = vi.fn()
    const items = buildToolWindowTabMenuItems(getTab(model, 'search'), {
      t: (message) => message,
      canMove: () => true,
      onMove,
      onMoveGroup: vi.fn(),
      onModelChanged: vi.fn(),
    })
    select(items, 'move-left')
    expect(onMove).toHaveBeenCalledWith(getTab(model, 'search'), 'left')
  })
})
