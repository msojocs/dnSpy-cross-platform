import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResourceElementOptions, ResourceOptions, TreeNode } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { CreateResourceDialog, CreateResourceElementDialog, ResourceElementDialog, ResourceOptionsDialog } from './ResourceDialogs'

const resourceNode: TreeNode = { id: 'r1', label: 'app.resources', kind: 'resource', hasChildren: true, icon: 'SourceFileGroup' }
const entryNode: TreeNode = { id: 'e1', label: 'Greeting', kind: 'resourceentry', hasChildren: false }

const options = (patch: Partial<ResourceOptions> = {}): ResourceOptions => ({
  kind: 'embedded',
  name: 'app.resources',
  attributes: 1,
  assemblyFullName: null,
  linkedFileName: null,
  fileContainsNoMetadata: false,
  fileHash: null,
  customAttributes: [],
  display: 'app.resources',
  ...patch,
})

const elementOptions = (patch: Partial<ResourceElementOptions> = {}): ResourceElementOptions => ({
  kind: 'string',
  name: 'Greeting',
  text: 'hello',
  base64Data: null,
  typeCode: 1,
  typeName: null,
  display: 'Greeting = hello',
  ...patch,
})

interface Harness {
  applyResourceOptions: ReturnType<typeof vi.fn>
  applyResourceElementOptions: ReturnType<typeof vi.fn>
  createResource: ReturnType<typeof vi.fn>
  createResourceElement: ReturnType<typeof vi.fn>
}

const stub = (loaded: ResourceOptions = options(), loadedElement: ResourceElementOptions = elementOptions()): Harness => {
  const applyResourceOptions = vi.fn(async () => true)
  const applyResourceElementOptions = vi.fn(async () => true)
  const createResource = vi.fn(async () => true)
  const createResourceElement = vi.fn(async () => true)
  Object.defineProperty(window, 'dnSpy', {
    configurable: true,
    value: {
      ...window.dnSpy,
      getResourceOptions: vi.fn(async () => loaded),
      getResourceElementOptions: vi.fn(async () => loadedElement),
    },
  })
  useAppStore.setState({ workspaceId: 'ws', applyResourceOptions, applyResourceElementOptions, createResource, createResourceElement })
  return { applyResourceOptions, applyResourceElementOptions, createResource, createResourceElement }
}

const accept = (): void => { fireEvent.click(screen.getByRole('button', { name: 'OK' })) }

beforeEach(() => {
  useAppStore.setState({ workspaceId: undefined })
})

afterEach(cleanup)

describe('ResourceOptionsDialog', () => {
  it('shows the name and visibility dnSpy\'s resource window shows', async () => {
    stub()
    render(<ResourceOptionsDialog node={resourceNode} onClose={() => undefined} />)

    expect(await screen.findByLabelText('Name')).toHaveValue('app.resources')
    expect(screen.getByLabelText('Visibility')).toHaveValue('1')
    // The kind is read from the row and cannot be changed, the way ResourceVM.Type has no setter path.
    expect(screen.getByLabelText('Type')).toHaveValue('embedded')
  })

  it('writes the edited model back', async () => {
    const harness = stub()
    render(<ResourceOptionsDialog node={resourceNode} onClose={() => undefined} />)
    const name = await screen.findByLabelText('Name')
    fireEvent.change(name, { target: { value: 'renamed.resources' } })
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: '2' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Visibility' }), { target: { value: '2' } })
    accept()

    await waitFor(() => expect(harness.applyResourceOptions).toHaveBeenCalledTimes(1))
    const [, written] = harness.applyResourceOptions.mock.calls[0] as [TreeNode, ResourceOptions]
    expect(written.name).toBe('renamed.resources')
    expect(written.attributes & 3).toBe(2)
  })

  it('asks for the assembly a linked resource names', async () => {
    stub(options({ kind: 'assemblyLinked', assemblyFullName: 'System.Runtime' }))
    render(<ResourceOptionsDialog node={resourceNode} onClose={() => undefined} />)
    expect(await screen.findByLabelText('Assembly')).toHaveValue('System.Runtime')
  })
})

describe('ResourceElementDialog', () => {
  it('edits a string entry\'s value', async () => {
    const harness = stub()
    render(<ResourceElementDialog node={entryNode} onClose={() => undefined} />)
    const value = await screen.findByLabelText('Value')
    expect(value).toHaveValue('hello')
    fireEvent.change(value, { target: { value: 'world' } })
    accept()

    await waitFor(() => expect(harness.applyResourceElementOptions).toHaveBeenCalledTimes(1))
    expect(harness.applyResourceElementOptions.mock.calls[0][1]).toMatchObject({ name: 'Greeting', text: 'world' })
  })

  it('shows a byte array as base64', async () => {
    stub(options(), elementOptions({ kind: 'byteArray', text: null, base64Data: 'AQID' }))
    render(<ResourceElementDialog node={entryNode} onClose={() => undefined} />)
    // A byte array has no text box; its bytes are what the editor holds.
    expect(await screen.findByLabelText('Value')).toHaveValue('AQID')
    expect(screen.getByLabelText('Value').tagName).toBe('TEXTAREA')
  })
})

describe('CreateResourceDialog', () => {
  it('creates an assembly-linked resource from the name and assembly fields', async () => {
    const harness = stub()
    render(<CreateResourceDialog owner={resourceNode} kind="assemblyLinked" onClose={() => undefined} />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'linked' } })
    fireEvent.change(screen.getByLabelText('Assembly'), { target: { value: 'System.Runtime, Version=10.0.0.0' } })
    accept()

    await waitFor(() => expect(harness.createResource).toHaveBeenCalledTimes(1))
    expect(harness.createResource.mock.calls[0][1]).toMatchObject({ kind: 'assemblyLinked', name: 'linked', assemblyFullName: 'System.Runtime, Version=10.0.0.0' })
  })

  it('titles each of dnSpy\'s create windows', () => {
    stub()
    render(<CreateResourceDialog owner={resourceNode} kind="multiFile" onClose={() => undefined} />)
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', 'Create Multi File Resource')
  })
})

describe('CreateResourceElementDialog', () => {
  it('adds an entry with the name and value typed in', async () => {
    const harness = stub()
    render(<CreateResourceElementDialog resourceNode={resourceNode} onClose={() => undefined} />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Greeting' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'hello' } })
    accept()

    await waitFor(() => expect(harness.createResourceElement).toHaveBeenCalledTimes(1))
    expect(harness.createResourceElement.mock.calls[0][1]).toMatchObject({ kind: 'string', name: 'Greeting', text: 'hello' })
  })
})
