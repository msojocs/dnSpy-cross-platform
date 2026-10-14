import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TreeNode } from '../../../shared/protocol'
import { TypePickerDialog, type PickerMode } from './TypePickerDialog'

const node = (id: string, label: string, kind: string, hasChildren: boolean, icon?: string): TreeNode => ({ id, label, kind, hasChildren, icon })

/** One module with two namespaces; the first holds a type, and the type holds a field and a method. */
const TREE: Record<string, TreeNode[]> = {
  'ws:n1': [node('n2', 'Alpha', 'namespace', true), node('n3', 'Empty.Namespace', 'namespace', false)],
  'ws:n2': [node('n4', 'Alpha.Widget', 'type', true, 'class')],
  'ws:n4': [
    node('n5', 'Count', 'field', false, 'field'),
    node('n6', 'Reset()', 'method', false, 'method'),
    // dnSpy's tree names a constructor after its type; only the full name says which method it is.
    { ...node('n7', 'Widget(int)', 'method', false, 'method'), description: 'System.Void Alpha.Widget::.ctor(System.Int32)' },
    { ...node('n8', 'Widget()', 'method', false, 'method'), description: 'System.Void Alpha.Widget::.cctor()' },
  ],
}

const getRoots = vi.fn(async () => ({ nodes: [node('n1', 'Sample', 'module', true, 'assembly')] }))
const getChildren = vi.fn(async (_workspaceId: string, nodeId: string) => ({ nodes: TREE[`ws:${nodeId}`] ?? [] }))

beforeEach(() => {
  getRoots.mockClear()
  getChildren.mockClear()
  // The picker reads the tree over the same bridge the explorer uses, so the test only has to answer.
  vi.stubGlobal('dnSpy', { getRoots, getChildren })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const dialog = (): HTMLElement => screen.getByRole('dialog')

/** The row a label sits in. A row is not addressable by role and name — the expander button inside it
 * has a name of its own — so the label is what the test goes through. */
const rowOf = (label: string): HTMLElement => {
  const row = within(dialog()).getByText(label).closest('[role="treeitem"]')
  if (!row)
    throw new Error(`No tree row holds '${label}'.`)
  return row as HTMLElement
}

const expanderOf = (label: string): HTMLElement => within(rowOf(label)).getByRole('button')

/** Opens a row the way the tree does: the chevron, or a double click anywhere on the row. */
const expand = (label: string): void => { fireEvent.click(expanderOf(label)) }
const open = (label: string): void => { fireEvent.doubleClick(rowOf(label)) }

const renderPicker = (mode: PickerMode) => {
  const onPick = vi.fn()
  const onClose = vi.fn()
  render(<TypePickerDialog workspaceId="ws" mode={mode} onPick={onPick} onClose={onClose} />)
  return { onPick, onClose }
}

describe('TypePickerDialog', () => {
  it('opens the modules it found and shows the namespaces under them', async () => {
    renderPicker('type')

    expect(await screen.findByText('Sample')).toBeTruthy()
    expect(await screen.findByText('Alpha')).toBeTruthy()
    // The module is opened for the user, and nothing below it: which namespace to walk into is theirs.
    expect(getChildren).toHaveBeenCalledWith('ws', 'n1')
    expect(within(dialog()).queryByText('Alpha.Widget')).toBeNull()
  })

  it('expands a namespace the user opens and lists the types in it', async () => {
    renderPicker('type')
    await screen.findByText('Alpha')
    expand('Alpha')

    expect(await screen.findByText('Alpha.Widget')).toBeTruthy()
    // The picker owns its expansion state, so the tree it is showing is not the explorer's.
    expect(getChildren).toHaveBeenCalledWith('ws', 'n2')
  })

  it('opens a namespace on a double click as well, which is how the tree is walked', async () => {
    renderPicker('type')
    await screen.findByText('Alpha')
    open('Alpha')

    expect(await screen.findByText('Alpha.Widget')).toBeTruthy()
  })

  it('hides what the mode cannot pick but keeps the type that holds it', async () => {
    const { onPick } = renderPicker('field')
    await screen.findByText('Alpha')
    expand('Alpha')
    await screen.findByText('Alpha.Widget')
    expand('Alpha.Widget')

    const count = await screen.findByText('Count')
    expect(within(dialog()).queryByText('Reset()')).toBeNull()

    // The type is a container here, so it is visible but is not an answer: OK stays disabled until a
    // field is selected, and selecting the type is not enough.
    fireEvent.click(count)
    fireEvent.click(within(dialog()).getByRole('button', { name: 'OK' }))
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0]).toEqual(expect.objectContaining({ id: 'n5' }))

    fireEvent.click(rowOf('Alpha.Widget'))
    expect(within(dialog()).getByRole('button', { name: 'OK' })).toBeDisabled()
  })

  it('offers the instance constructors to pick a constructor from, which the tree names after their type', async () => {
    renderPicker('constructor')
    await screen.findByText('Alpha')
    expand('Alpha')
    await screen.findByText('Alpha.Widget')
    expand('Alpha.Widget')

    await screen.findByText('Widget(int)')
    // The static constructor and the other methods are no answer for a custom attribute.
    expect(within(dialog()).queryByText('Widget()')).toBeNull()
    expect(within(dialog()).queryByText('Reset()')).toBeNull()
  })

  it('hands back the chain that reached the node, which is what names the assembly and namespace', async () => {
    const { onPick } = renderPicker('type')
    await screen.findByText('Alpha')
    expand('Alpha')
    await screen.findByText('Alpha.Widget')
    fireEvent.click(rowOf('Alpha.Widget'))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'OK' }))

    expect(onPick).toHaveBeenCalledTimes(1)
    const [picked, trail] = onPick.mock.calls[0]
    expect(picked).toEqual(expect.objectContaining({ id: 'n4' }))
    expect(trail.map((entry: TreeNode) => entry.label)).toEqual(['Sample', 'Alpha', 'Alpha.Widget'])
  })

  it('picks on double click, so the tree can be walked without reaching for the buttons', async () => {
    const { onPick } = renderPicker('type')
    await screen.findByText('Alpha')
    expand('Alpha')
    await screen.findByText('Alpha.Widget')
    open('Alpha.Widget')

    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0]).toEqual(expect.objectContaining({ id: 'n4' }))
  })

  it('closes on Escape, and only once it is the innermost dialog', async () => {
    const { onClose } = renderPicker('type')
    await screen.findByText('Sample')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('reports a tree that will not load instead of showing an empty one', async () => {
    getRoots.mockRejectedValueOnce(new Error('The workspace no longer exists.'))
    renderPicker('type')

    await waitFor(() => expect(screen.getByText('The workspace no longer exists.')).toBeTruthy())
  })

  it('shows only the roots it was given, which is how a picker is held to one assembly', async () => {
    getRoots.mockResolvedValueOnce({
      nodes: [node('n1', 'Sample', 'module', true, 'assembly'), node('n9', 'Elsewhere', 'module', true, 'assembly')],
    })
    const onPick = vi.fn()
    render(<TypePickerDialog workspaceId="ws" mode="method" rootNodeIds={['n9']} onPick={onPick} onClose={vi.fn()} />)

    expect(await screen.findByText('Elsewhere')).toBeTruthy()
    expect(screen.queryByText('Sample')).toBeNull()
  })

  it('picks a member when it was opened for one, not just the type that holds it', async () => {
    const { onPick } = renderPicker('member')
    await screen.findByText('Alpha')
    expand('Alpha')
    await screen.findByText('Alpha.Widget')
    expand('Alpha.Widget')
    fireEvent.click(await screen.findByText('Reset()'))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'OK' }))

    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0]).toEqual(expect.objectContaining({ id: 'n6', kind: 'method' }))
  })
})
