import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../app-store'
import { DebugProgramDialog, defaultsToHost, parseEnvironment, splitArguments } from './DebugProgramDialog'

const launchDebug = vi.fn(async () => undefined)

beforeEach(() => {
  launchDebug.mockClear()
  // The dialog remembers what each program was started with; every test starts from a dialog with no memory.
  localStorage.removeItem('dnspy.debugProgramMru.v1')
  useAppStore.setState({ launchDebug, defaultDebugTarget: () => '/tmp/DebugTarget.dll' })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Debug Program' })
const field = (name: string): HTMLElement => within(dialog()).getByLabelText(name)

describe('splitArguments', () => {
  it('splits on whitespace', () => {
    expect(splitArguments('a b  c')).toEqual(['a', 'b', 'c'])
    expect(splitArguments('')).toEqual([])
  })

  it('keeps quoted runs together and drops the quotes', () => {
    expect(splitArguments('"a b" c')).toEqual(['a b', 'c'])
    expect(splitArguments("'a b' \"c'd\"")).toEqual(['a b', "c'd"])
  })

  it('keeps an empty quoted argument, which is not the same as no argument', () => {
    expect(splitArguments('"" x')).toEqual(['', 'x'])
  })
})

describe('parseEnvironment', () => {
  it('reads one KEY=VALUE per line, ignoring blanks', () => {
    expect(parseEnvironment('A=1\n\n  B=two=3  \n')).toEqual({ A: '1', B: 'two=3' })
  })

  it('rejects a line that has no key', () => {
    expect(parseEnvironment('A=1\nNOEQUALSSIGN')).toBeUndefined()
  })
})

describe('defaultsToHost', () => {
  it('needs the host for a .dll and runs an apphost on its own, matching the engine default', () => {
    expect(defaultsToHost('/tmp/App.dll')).toBe(true)
    expect(defaultsToHost('/tmp/App.exe')).toBe(false)
    expect(defaultsToHost('/tmp/App')).toBe(false)
  })
})

describe('DebugProgramDialog', () => {
  it('prefills the executable from the module the workspace has open', () => {
    render(<DebugProgramDialog onClose={vi.fn()} />)

    expect(field('Executable')).toHaveValue('/tmp/DebugTarget.dll')
    // Upstream defaults the CoreCLR page to DontBreak, and so does the port.
    expect(field('Break at')).toHaveValue('dont-break')
    // A .dll runs through the host, which upstream ticks by default and fills with `exec`.
    expect(field('Use host executable')).toBeChecked()
    expect(field('Host Arguments')).toHaveValue('exec')
  })

  it('launches with the values the dialog collected', () => {
    render(<DebugProgramDialog onClose={vi.fn()} />)

    fireEvent.change(field('Arguments'), { target: { value: '"a b" c' } })
    fireEvent.change(field('Working Directory'), { target: { value: '/tmp' } })
    fireEvent.change(field('Environment Variables'), { target: { value: 'DNSPY_TEST=1' } })
    fireEvent.change(field('Break at'), { target: { value: 'entry-point' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'OK' }))

    expect(launchDebug).toHaveBeenCalledWith({
      program: '/tmp/DebugTarget.dll',
      arguments: ['a b', 'c'],
      workingDirectory: '/tmp',
      environment: { DNSPY_TEST: '1' },
      stopAtEntry: true,
      useHost: true,
      host: undefined,
      hostArguments: ['exec'],
    })
  })

  it('hosts the target through a chosen executable and its arguments', () => {
    render(<DebugProgramDialog onClose={vi.fn()} />)

    fireEvent.change(field('Host'), { target: { value: '/usr/bin/dotnet' } })
    fireEvent.change(field('Host Arguments'), { target: { value: 'exec' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'OK' }))

    expect(launchDebug).toHaveBeenCalledWith(expect.objectContaining({
      useHost: true,
      host: '/usr/bin/dotnet',
      hostArguments: ['exec'],
    }))
  })

  it('runs the target directly when the host is turned off, dropping the host fields', () => {
    render(<DebugProgramDialog onClose={vi.fn()} />)

    fireEvent.click(field('Use host executable'))
    expect(field('Host')).toBeDisabled()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'OK' }))

    expect(launchDebug).toHaveBeenCalledWith(expect.objectContaining({
      useHost: false,
      host: undefined,
      hostArguments: undefined,
    }))
  })

  it('flags a host path that is not a file, but leaves a blank one alone', async () => {
    vi.spyOn(window.dnSpy, 'pathExists').mockImplementation(async (path) => path !== '/tmp/GoneDotnet')
    render(<DebugProgramDialog onClose={vi.fn()} />)
    const ok = (): HTMLElement => within(dialog()).getByRole('button', { name: 'OK' })
    const host = field('Host')

    // A blank host means "find the dotnet CLI", so it is not an error.
    expect(ok()).toBeEnabled()

    fireEvent.change(host, { target: { value: '/tmp/GoneDotnet' } })
    await waitFor(() => expect(host).toHaveAttribute('aria-invalid', 'true'))
    expect(ok()).toBeDisabled()
  })

  it('browses for a host executable', async () => {
    vi.spyOn(window.dnSpy, 'chooseDebugHost').mockResolvedValue('/usr/share/dotnet/dotnet')
    render(<DebugProgramDialog onClose={vi.fn()} />)

    const rows = within(dialog()).getAllByRole('button', { name: 'Browse...' })
    // The host's browse button is the last of the three, after Executable and Working Directory.
    fireEvent.click(rows[2])

    await waitFor(() => expect(field('Host')).toHaveValue('/usr/share/dotnet/dotnet'))
  })

  it('launches with the module cctor startup break kind', () => {
    render(<DebugProgramDialog onClose={vi.fn()} />)

    fireEvent.change(field('Break at'), { target: { value: 'module-cctor-or-entry-point' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'OK' }))

    expect(launchDebug).toHaveBeenCalledWith(expect.objectContaining({
      stopAtEntry: false,
      breakKind: 'ModuleCctorOrEntryPoint',
    }))
  })

  it('launches with the CreateProcess startup break kind', () => {
    render(<DebugProgramDialog onClose={vi.fn()} />)

    fireEvent.change(field('Break at'), { target: { value: 'create-process' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'OK' }))

    expect(launchDebug).toHaveBeenCalledWith(expect.objectContaining({
      stopAtEntry: false,
      breakKind: 'CreateProcess',
    }))
  })

  it('omits a working directory left blank rather than sending an empty string', () => {
    render(<DebugProgramDialog onClose={vi.fn()} />)

    fireEvent.click(within(dialog()).getByRole('button', { name: 'OK' }))

    expect(launchDebug).toHaveBeenCalledWith(expect.objectContaining({ workingDirectory: undefined, stopAtEntry: false }))
  })

  it('disables OK while the executable is empty or the environment cannot be parsed', () => {
    render(<DebugProgramDialog onClose={vi.fn()} />)
    const ok = (): HTMLElement => within(dialog()).getByRole('button', { name: 'OK' })
    expect(ok()).toBeEnabled()

    fireEvent.change(field('Environment Variables'), { target: { value: 'not-a-pair' } })
    expect(ok()).toBeDisabled()

    fireEvent.change(field('Environment Variables'), { target: { value: '' } })
    expect(ok()).toBeEnabled()

    fireEvent.change(field('Executable'), { target: { value: '   ' } })
    expect(ok()).toBeDisabled()
  })

  it('flags an executable that is not a file on disk and clears the flag when it is', async () => {
    vi.spyOn(window.dnSpy, 'pathExists').mockImplementation(async (path) => path === '/tmp/DebugTarget.dll')
    render(<DebugProgramDialog onClose={vi.fn()} />)
    const exe = field('Executable')
    const ok = (): HTMLElement => within(dialog()).getByRole('button', { name: 'OK' })

    // Upstream validates the path on every keystroke, so a value that names no file earns the red border
    // and keeps OK disabled until the path is fixed.
    fireEvent.change(exe, { target: { value: '/tmp/Gone.dll' } })
    await waitFor(() => expect(exe).toHaveAttribute('aria-invalid', 'true'))
    expect(ok()).toBeDisabled()

    fireEvent.change(exe, { target: { value: '/tmp/DebugTarget.dll' } })
    await waitFor(() => expect(exe).toHaveAttribute('aria-invalid', 'false'))
    expect(ok()).toBeEnabled()
  })

  it('closes without launching on Cancel', () => {
    const onClose = vi.fn()
    render(<DebugProgramDialog onClose={onClose} />)

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))

    expect(onClose).toHaveBeenCalled()
    expect(launchDebug).not.toHaveBeenCalled()
  })
})

describe('the launch memory', () => {
  it('opens on the arguments a program was last started with', () => {
    render(<DebugProgramDialog onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Arguments'), { target: { value: '--evaluate --wait' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    cleanup()

    render(<DebugProgramDialog onClose={vi.fn()} />)
    expect(screen.getByLabelText('Arguments')).toHaveValue('--evaluate --wait')
  })
})
