import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportProjectInfo, ExportProjectProgress, ExportProjectResponse } from '../../../shared/protocol'
import { ExportToProjectDialog } from './ExportToProjectDialog'

let progressListener: ((progress: ExportProjectProgress) => void) | undefined

const info = (overrides: Partial<ExportProjectInfo> = {}): ExportProjectInfo => ({
  modulePaths: ['/asm/App.exe'],
  solutionFilename: 'App.sln',
  dontReferenceStdLib: false,
  ...overrides,
})

const exported = (overrides: Partial<ExportProjectResponse> = {}): ExportProjectResponse => ({
  canceled: false,
  errors: [],
  projectFilenames: ['/out/App/App.csproj'],
  solutionFilename: '/out/App.sln',
  fileToOpen: '/out/App.sln',
  ...overrides,
})

beforeEach(() => {
  progressListener = undefined
  localStorage.clear()
  Object.assign(window.dnSpy, {
    getExportProjectInfo: vi.fn(async () => info()),
    exportProject: vi.fn(async () => exported()),
    cancelExportProject: vi.fn(async () => undefined),
    onExportProjectProgress: vi.fn((callback: (progress: ExportProjectProgress) => void) => { progressListener = callback; return () => undefined }),
    pickExportDirectory: vi.fn(async () => '/picked'),
    isExistingFile: vi.fn(async (path: string) => path === '/a/file'),
    openExportedProject: vi.fn(async () => undefined),
  })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const renderDialog = async (props: Partial<React.ComponentProps<typeof ExportToProjectDialog>> = {}): Promise<{ onClose: ReturnType<typeof vi.fn> }> => {
  const onClose = vi.fn()
  render(<ExportToProjectDialog workspaceId="w1" nodeIds={['n1']} language="cSharp" onClose={onClose} {...props} />)
  await screen.findByRole('dialog', { name: 'Export to Project' })
  return { onClose }
}

const exportButton = (): HTMLElement => screen.getByRole('button', { name: 'Export' })

describe('ExportToProjectDialog', () => {
  it('opens the way dnSpy\'s ExportToProjectVM does', async () => {
    await renderDialog()
    expect(window.dnSpy.getExportProjectInfo).toHaveBeenCalledWith('w1', ['n1'])
    expect(screen.getByLabelText('Folder')).toHaveValue('')
    expect(screen.getByLabelText('Solution')).toHaveValue('App.sln')
    expect(screen.getByRole('checkbox', { name: 'Create solution' })).toBeChecked()
    expect(screen.getByLabelText('Version')).toHaveValue('VS2010')
    expect(screen.getByLabelText('Language')).toHaveValue('cSharp')
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'VS2005', 'VS2008', 'VS2010', 'VS2012', 'VS2013', 'VS2015', 'VS2017', 'VS2019', 'VS2022', 'C#', 'Visual Basic',
    ])
    expect((screen.getByLabelText('Project GUID') as HTMLInputElement).value).toMatch(/^[0-9a-f-]{36}$/)
    expect(screen.getByRole('checkbox', { name: 'Unpack resources' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Create .resx files' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Decompile baml to xaml' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Use SDK style project format' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Open project in Visual Studio' })).not.toBeChecked()
    expect(screen.getByText('One file will be decompiled. Select more than one assembly to decompile more than one file.')).toBeInTheDocument()
    // No folder yet: Missing destination folder keeps Export off.
    expect(screen.getByLabelText('Folder')).toHaveAttribute('aria-invalid', 'true')
    expect(exportButton()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('does nothing when the selection names no module', async () => {
    Object.assign(window.dnSpy, { getExportProjectInfo: vi.fn(async () => info({ modulePaths: [] })) })
    const onClose = vi.fn()
    render(<ExportToProjectDialog workspaceId="w1" nodeIds={['n1']} language="cSharp" onClose={onClose} />)
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('counts the files and starts on Visual Basic when that is the language shown', async () => {
    Object.assign(window.dnSpy, { getExportProjectInfo: vi.fn(async () => info({ modulePaths: ['/a.dll', '/b.dll', '/c.dll'] })) })
    await renderDialog({ language: 'visualBasic' })
    expect(screen.getByText('3 files will be decompiled.')).toBeInTheDocument()
    expect(screen.getByLabelText('Language')).toHaveValue('visualBasic')
  })

  it('validates the folder, the solution and the guid as ExportToProjectVM.Verify does', async () => {
    await renderDialog()
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '/a/file' } })
    await waitFor(() => expect(screen.getByLabelText('Folder')).toHaveAttribute('title', 'A file with the same name as the destination folder already exists.'))
    expect(exportButton()).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '/out' } })
    await waitFor(() => expect(exportButton()).toBeEnabled())

    // An empty solution name only matters while a solution is to be written.
    fireEvent.change(screen.getByLabelText('Solution'), { target: { value: '' } })
    expect(exportButton()).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Create solution' }))
    expect(screen.getByLabelText('Solution')).toBeDisabled()
    expect(exportButton()).toBeEnabled()

    fireEvent.change(screen.getByLabelText('Project GUID'), { target: { value: 'nope' } })
    expect(screen.getByLabelText('Project GUID')).toHaveAttribute('title', 'Invalid GUID')
    expect(exportButton()).toBeDisabled()
    // An empty guid is no guid: every project gets a new one.
    fireEvent.change(screen.getByLabelText('Project GUID'), { target: { value: '' } })
    expect(exportButton()).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'New' }))
    expect((screen.getByLabelText('Project GUID') as HTMLInputElement).value).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('turns .resx and XAML off with Unpack resources', async () => {
    await renderDialog()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Unpack resources' }))
    expect(screen.getByRole('checkbox', { name: 'Create .resx files' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Decompile baml to xaml' })).toBeDisabled()
  })

  it('picks the folder starting at the one in the box', async () => {
    await renderDialog()
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '/start' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Browse...' })) })
    expect(window.dnSpy.pickExportDirectory).toHaveBeenCalledWith('/start')
    expect(screen.getByLabelText('Folder')).toHaveValue('/picked')
  })

  it('exports with the options, closes when nothing was logged, remembers the version and opens the solution', async () => {
    const { onClose } = await renderDialog()
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '/out' } })
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: 'VS2019' } })
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'visualBasic' } })
    fireEvent.change(screen.getByLabelText('Project GUID'), { target: { value: '11111111-2222-3333-4444-555555555555' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Create .resx files' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use SDK style project format' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Open project in Visual Studio' }))
    await waitFor(() => expect(exportButton()).toBeEnabled())
    await act(async () => { fireEvent.click(exportButton()) })

    expect(window.dnSpy.exportProject).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'w1',
      nodeIds: ['n1'],
      directory: '/out',
      solutionFilename: 'App.sln',
      projectVersion: 'VS2019',
      useSdkStyleProjectFormat: true,
      language: 'visualBasic',
      projectGuid: '11111111-2222-3333-4444-555555555555',
      dontReferenceStdLib: false,
      unpackResources: true,
      createResX: false,
      decompileXaml: true,
      settings: expect.objectContaining({ cSharp: expect.objectContaining({ anonymousMethods: true }) }),
    }), expect.any(String))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(window.dnSpy.openExportedProject).toHaveBeenCalledWith('/out/App.sln')
    expect(JSON.parse(localStorage.getItem('dnspy.exportToProject.v1')!)).toEqual({ projectVersion: 'VS2019', directory: '/out' })
  })

  it('shows the progress and the error log, then stays open with Close', async () => {
    let finish: (response: ExportProjectResponse) => void = () => undefined
    Object.assign(window.dnSpy, { exportProject: vi.fn(() => new Promise<ExportProjectResponse>((resolve) => { finish = resolve })) })
    localStorage.setItem('dnspy.exportToProject.v1', JSON.stringify({ projectVersion: 'VS2010', directory: '/out' }))
    const { onClose } = await renderDialog()
    expect(screen.getByLabelText('Folder')).toHaveValue('/out')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Open project in Visual Studio' }))
    await waitFor(() => expect(exportButton()).toBeEnabled())
    await act(async () => { fireEvent.click(exportButton()) })
    const key = vi.mocked(window.dnSpy.exportProject).mock.calls[0][1]

    // While it runs, the settings are off, Export is off and Cancel is there.
    expect(exportButton()).toBeDisabled()
    expect(screen.getByLabelText('Folder')).toBeDisabled()
    act(() => progressListener?.({ requestKey: key, progress: 3, maxProgress: 10, errors: [] }))
    expect(screen.getByLabelText('Progress')).toHaveAttribute('max', '10')
    expect(screen.getByLabelText('Progress')).toHaveAttribute('value', '3')

    // An error logged while it runs takes the place of the settings at once.
    act(() => progressListener?.({ requestKey: key, progress: 5, maxProgress: 10, errors: ['first', 'second'] }))
    expect(screen.queryByLabelText('Folder')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Error log' })).toHaveValue('first\nsecond\n')

    await act(async () => { finish(exported({ errors: ['first', 'second', 'An exception occurred\n\nboom'] })) })
    expect(screen.getByRole('textbox', { name: 'Error log' })).toHaveValue('first\nsecond\nAn exception occurred\n\nboom\n')
    expect(screen.queryByLabelText('Progress')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    // dnSpy opens nothing after an export that logged errors.
    expect(window.dnSpy.openExportedProject).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
    expect(onClose).toHaveBeenCalled()
  })

  it('calls the export off and closes on Cancel', async () => {
    Object.assign(window.dnSpy, { exportProject: vi.fn(() => new Promise<ExportProjectResponse>(() => undefined)) })
    const { onClose } = await renderDialog()
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '/out' } })
    await waitFor(() => expect(exportButton()).toBeEnabled())
    await act(async () => { fireEvent.click(exportButton()) })
    const key = vi.mocked(window.dnSpy.exportProject).mock.calls[0][1]
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(window.dnSpy.cancelExportProject).toHaveBeenCalledWith(key)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
