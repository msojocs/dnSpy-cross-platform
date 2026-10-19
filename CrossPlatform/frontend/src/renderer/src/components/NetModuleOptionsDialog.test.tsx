import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TreeNode } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { NetModuleOptionsDialog } from './NetModuleOptionsDialog'

afterEach(cleanup)

const assemblyNode: TreeNode = { id: 'a1', label: 'Host', kind: 'assembly', hasChildren: true, icon: 'AssemblyFile' }

describe('NetModuleOptionsDialog', () => {
  it('creates a net module of its own from the name, the MVID and the .NET version', async () => {
    const createNetModule = vi.fn(async () => true)
    useAppStore.setState({ workspaceId: 'ws', createNetModule })
    const onClose = vi.fn()
    render(<NetModuleOptionsDialog onClose={onClose} />)

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', 'Create NetModule')
    expect(screen.getByLabelText('Name')).toHaveValue('MyNetModule.netmodule')
    const first = (screen.getByLabelText('Mvid') as HTMLInputElement).value
    fireEvent.click(screen.getByRole('button', { name: 'New' }))
    expect(screen.getByLabelText('Mvid')).not.toHaveValue(first)
    fireEvent.change(screen.getByLabelText('Mvid'), { target: { value: 'not a guid' } })
    expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled()
    expect(screen.getAllByText('Invalid GUID').length).toBeGreaterThan(0)
    fireEvent.change(screen.getByLabelText('Mvid'), { target: { value: '0f8fad5b-d9cb-469f-a165-70867728950e' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(createNetModule).toHaveBeenCalledWith('MyNetModule.netmodule', '0f8fad5b-d9cb-469f-a165-70867728950e', '4.0')
  })

  it('starts a net module of an assembly at the assembly\'s .NET version and adds it there', async () => {
    const addNetModule = vi.fn(async () => true)
    Object.assign(window.dnSpy, { getNetModuleDefaults: vi.fn(async () => ({ clrVersion: '2.0' })) })
    useAppStore.setState({ workspaceId: 'ws', addNetModule })
    render(<NetModuleOptionsDialog assemblyNode={assemblyNode} onClose={() => undefined} />)

    await waitFor(() => expect(screen.getByLabelText('.NET Version')).toHaveValue('2.0'))
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(addNetModule).toHaveBeenCalledWith(assemblyNode, expect.objectContaining({ name: 'MyNetModule.netmodule', clrVersion: '2.0' })))
  })
})
