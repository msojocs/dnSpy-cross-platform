import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SaveDocumentsProgress, SaveDocumentsResponse } from '../../../shared/protocol'
import { SaveModulesDialog } from './SaveModulesDialog'
import { moduleSaveOptions } from './save-options-fixtures'

afterEach(cleanup)

let progressListener: ((progress: SaveDocumentsProgress) => void) | undefined

const savedResponse = (overrides: Partial<SaveDocumentsResponse> = {}): SaveDocumentsResponse => ({
  canceled: false,
  modifiedDocuments: [],
  results: [{ documentId: 'n1', fileName: '/tmp/A.dll', saved: true, length: 10, sha256: 'aa', log: ['Writing /tmp/A.dll...'], errorCount: 0 }],
  ...overrides,
})

beforeEach(() => {
  progressListener = undefined
  Object.assign(window.dnSpy, {
    validateSaveFileName: vi.fn(async (fileName: string) => fileName.trim().length === 0 ? { template: "Filename can't be empty." } : undefined),
    onSaveProgress: vi.fn((callback: (progress: SaveDocumentsProgress) => void) => { progressListener = callback; return () => undefined }),
    saveDocuments: vi.fn(async () => savedResponse()),
    cancelSave: vi.fn(async () => undefined),
    getSaveOptions: vi.fn(async () => moduleSaveOptions()),
  })
})

describe('SaveModulesDialog', () => {
  it('lists the files and writes them with their options on Save All', async () => {
    const onClose = vi.fn()
    const documents = [moduleSaveOptions(), moduleSaveOptions({ documentId: 'n2', fileName: '/tmp/B.dll' })]
    render(<SaveModulesDialog workspaceId="w1" documents={documents} mode="multiple" onClose={onClose} />)
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['/tmp/A.dll', '/tmp/B.dll'])
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save All' })).toBeEnabled())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save All' })) })
    expect(window.dnSpy.saveDocuments).toHaveBeenCalledWith('w1', [
      { documentId: 'n1', fileName: '/tmp/A.dll', writer: documents[0].writer },
      { documentId: 'n2', fileName: '/tmp/B.dll', writer: documents[1].writer },
    ], expect.any(String))
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(savedResponse()))
  })

  it('names the first file whose options will not do and keeps Save All off', async () => {
    render(<SaveModulesDialog workspaceId="w1" documents={[moduleSaveOptions(), moduleSaveOptions({ documentId: 'n2', fileName: '' })]} mode="multiple" onClose={() => undefined} />)
    expect(await screen.findByText(/File #2 \(<empty filename>\) has errors/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save All' })).toBeDisabled()
  })

  it('opens a file\'s options on a double click, and takes them on OK', async () => {
    render(<SaveModulesDialog workspaceId="w1" documents={[moduleSaveOptions()]} mode="multiple" onClose={() => undefined} />)
    fireEvent.doubleClick(screen.getByRole('option'))
    const dialog = await screen.findByRole('dialog', { name: 'Save Module' })
    fireEvent.change(screen.getAllByLabelText('Filename').at(-1)!, { target: { value: '/tmp/C.dll' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'OK' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    expect(screen.getByRole('option')).toHaveTextContent('/tmp/C.dll')
  })

  it('starts writing at once for one file, shows the bars, and stops on Cancel', async () => {
    let finish: (response: SaveDocumentsResponse) => void = () => undefined
    Object.assign(window.dnSpy, { saveDocuments: vi.fn(() => new Promise<SaveDocumentsResponse>((resolve) => { finish = resolve })) })
    const onClose = vi.fn()
    render(<SaveModulesDialog workspaceId="w1" documents={[moduleSaveOptions()]} mode="single" onClose={onClose} />)
    await waitFor(() => expect(window.dnSpy.saveDocuments).toHaveBeenCalled())
    const key = vi.mocked(window.dnSpy.saveDocuments).mock.calls[0][2]
    act(() => progressListener?.({ requestKey: key, fileIndex: 0, fileName: '/tmp/A.dll', fileProgress: 0.5, totalProgress: 0.5 }))
    expect(screen.getByLabelText('File progress')).toHaveAttribute('value', '50')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })
    expect(window.dnSpy.cancelSave).toHaveBeenCalledWith(key)
    expect(screen.getByText('Canceling the save. Please wait...')).toBeInTheDocument()
    await act(async () => { finish(savedResponse({ canceled: true, results: [] })) })
    expect(onClose).not.toHaveBeenCalled()
    // The title bar's close box is named Close as well; the button row's is the last one.
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
    expect(onClose).toHaveBeenCalledWith(savedResponse({ canceled: true, results: [] }))
  })

  it('stays open with the log when the writer reported anything', async () => {
    Object.assign(window.dnSpy, {
      saveDocuments: vi.fn(async () => savedResponse({ results: [{ documentId: 'n1', fileName: '/tmp/A.dll', saved: true, length: 10, log: ['Writing /tmp/A.dll...', 'Warning: odd signature'], errorCount: 1 }] })),
    })
    const onClose = vi.fn()
    render(<SaveModulesDialog workspaceId="w1" documents={[moduleSaveOptions()]} mode="single" onClose={onClose} />)
    expect(await screen.findByText('There are errors in the log:')).toBeInTheDocument()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Writing /tmp/A.dll...\nWarning: odd signature\nAll files written to disk.')
    expect(onClose).not.toHaveBeenCalled()
  })
})
