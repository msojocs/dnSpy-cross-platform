import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentSaveOptions } from '../../../shared/protocol'
import { moduleSaveOptions, writerOptions } from './save-options-fixtures'
import { SaveModuleOptionsDialog } from './SaveModuleOptionsDialog'

afterEach(cleanup)

beforeEach(() => {
  Object.assign(window.dnSpy, {
    validateSaveFileName: vi.fn(async (fileName: string) => fileName.trim().length === 0 ? { template: "Filename can't be empty." } : undefined),
    pickSaveFileName: vi.fn(async () => '/tmp/picked.dll'),
    getSaveOptions: vi.fn(async (_workspaceId: string, documentId: string, useMixedMode?: boolean) =>
      moduleSaveOptions({ documentId, writer: writerOptions({ useMixedMode: useMixedMode ?? false, keepExtraPeData: useMixedMode === true }) })),
  })
})

describe('SaveModuleOptionsDialog', () => {
  it('opens on the five pages of dnSpy\'s window, with the file the module came from', () => {
    render(<SaveModuleOptionsDialog workspaceId="w1" options={moduleSaveOptions()} onAccept={() => undefined} onClose={() => undefined} />)
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Main', 'MD Writer Options', 'Metadata', 'Cor20', 'PE'])
    expect(screen.getByLabelText('Filename')).toHaveValue('/tmp/A.dll')
    expect(screen.getByLabelText('Shared Method Bodies')).toBeChecked()
    expect(screen.getByLabelText('Save PDB File')).toBeDisabled()
    expect(screen.getByLabelText('Module Type')).toHaveValue('2')
  })

  it('writes what the user changed, an empty box as no value at all', async () => {
    const onAccept = vi.fn()
    render(<SaveModuleOptionsDialog workspaceId="w1" options={moduleSaveOptions()} onAccept={onAccept} onClose={() => undefined} />)
    fireEvent.click(screen.getByRole('tab', { name: 'MD Writer Options' }))
    fireEvent.click(screen.getByLabelText('Preserve All MD Tokens'))
    fireEvent.click(screen.getByRole('tab', { name: 'PE' }))
    fireEvent.change(screen.getByLabelText('ImageBase'), { target: { value: '0x10000000' } })
    fireEvent.change(screen.getByLabelText('MajorLinkerVersion'), { target: { value: '' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'OK' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    const written = onAccept.mock.calls[0][0] as DocumentSaveOptions
    expect(written.writer?.metadataFlags).toBe(0x7FF)
    expect(written.writer?.imageBase).toBe(0x10000000)
    expect(written.writer?.majorLinkerVersion).toBeNull()
  })

  it('keeps OK off while a box cannot be read', async () => {
    render(<SaveModuleOptionsDialog workspaceId="w1" options={moduleSaveOptions()} onAccept={() => undefined} onClose={() => undefined} />)
    fireEvent.click(screen.getByRole('tab', { name: 'PE' }))
    fireEvent.change(screen.getByLabelText('MajorLinkerVersion'), { target: { value: '300' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled())
  })

  it('sets the subsystem and the Dll bit with the module type, and the machine bits with the machine', () => {
    const onAccept = vi.fn()
    render(<SaveModuleOptionsDialog workspaceId="w1" options={moduleSaveOptions()} onAccept={onAccept} onClose={() => undefined} />)
    fireEvent.change(screen.getByLabelText('Module Type'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('tab', { name: 'PE' }))
    expect(screen.getByLabelText('Subsystem')).toHaveValue('2')
    expect(screen.getByLabelText('Dll')).not.toBeChecked()
    fireEvent.change(screen.getByLabelText('Machine'), { target: { value: String(0x8664) } })
    expect(screen.getByLabelText('32-Bit Machine')).not.toBeChecked()
    expect(screen.getByLabelText('Large Address Aware')).toBeChecked()
  })

  it('shows every box of a flags group undecided while its value is not there', () => {
    render(<SaveModuleOptionsDialog workspaceId="w1" options={moduleSaveOptions({ writer: writerOptions({ cor20Flags: null }) })} onAccept={() => undefined} onClose={() => undefined} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Cor20' }))
    expect((screen.getByLabelText('ILOnly') as HTMLInputElement).indeterminate).toBe(true)
    fireEvent.click(screen.getByLabelText('ILOnly'))
    expect(screen.getByLabelText('ILOnly')).toBeChecked()
    expect((screen.getByLabelText('ILLibrary') as HTMLInputElement).indeterminate).toBe(false)
  })

  it('reads every option again for the other writer when the mixed-mode box is clicked', async () => {
    render(<SaveModuleOptionsDialog workspaceId="w1" options={moduleSaveOptions()} onAccept={() => undefined} onClose={() => undefined} />)
    await act(async () => { fireEvent.click(screen.getByLabelText('Mixed-Mode Module')) })
    expect(window.dnSpy.getSaveOptions).toHaveBeenCalledWith('w1', 'n1', true)
    expect(screen.getByLabelText('Mixed-Mode Module')).toBeChecked()
  })

  it('takes the file the picker answers with', async () => {
    render(<SaveModuleOptionsDialog workspaceId="w1" options={moduleSaveOptions()} onAccept={() => undefined} onClose={() => undefined} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pick a file name' })) })
    expect(window.dnSpy.pickSaveFileName).toHaveBeenCalledWith('/tmp/A.dll', 'module', 'dll')
    expect(screen.getByLabelText('Filename')).toHaveValue('/tmp/picked.dll')
  })

  it('asks only for the file name of a document saved as bytes, and needs one', async () => {
    render(<SaveModuleOptionsDialog workspaceId="w1" options={moduleSaveOptions({ isHexDocument: true, writer: null, fileName: '' })} onAccept={() => undefined} onClose={() => undefined} />)
    expect(screen.queryByRole('tab', { name: 'PE' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled())
    fireEvent.change(screen.getByLabelText('Filename'), { target: { value: '/tmp/native.exe' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'OK' })).toBeEnabled())
  })
})
