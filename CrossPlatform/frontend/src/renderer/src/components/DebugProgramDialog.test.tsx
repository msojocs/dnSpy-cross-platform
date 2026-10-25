import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../app-store'
import { DebugProgramDialog, DEFAULT_CONNECTION_TIMEOUT_SECONDS, defaultsToHost, isValidConnectionTimeout, splitArguments } from './DebugProgramDialog'
import { parseEnvironmentString, parseEnvironmentRows } from './EnvironmentVariablesDialog'

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

describe('parseEnvironmentRows', () => {
  it('reads one KEY=VALUE per line, dropping blanks and keyless lines', () => {
    expect(parseEnvironmentRows('A=1\n\n  B=two=3  \nNOEQUALSSIGN')).toEqual([{ key: 'A', value: '1' }, { key: 'B', value: 'two=3' }])
  })
})

describe('parseEnvironmentString', () => {
  it('reads the upstream semicolon-separated list, quoted values included', () => {
    expect(parseEnvironmentString('A=1;B="two;3"')).toEqual([{ key: 'A', value: '1' }, { key: 'B', value: 'two;3' }])
    expect(parseEnvironmentString('A=1;')).toEqual([{ key: 'A', value: '1' }])
  })

  it('rejects a string that is not a whole sequence of pairs', () => {
    expect(parseEnvironmentString('A')).toBeUndefined()
    expect(parseEnvironmentString('A=1;B')).toBeUndefined()
    expect(parseEnvironmentString('=1')).toBeUndefined()
  })
})

describe('defaultsToHost', () => {
  it('needs the host for a .dll and runs an apphost on its own, matching the engine default', () => {
    expect(defaultsToHost('/tmp/App.dll')).toBe(true)
    expect(defaultsToHost('/tmp/App.exe')).toBe(false)
    expect(defaultsToHost('/tmp/App')).toBe(false)
  })
})

describe('isValidConnectionTimeout', () => {
  it('accepts the digits-only uint the upstream UInt32VM accepts', () => {
    expect(isValidConnectionTimeout('0')).toBe(true)
    expect(isValidConnectionTimeout(' 5 ')).toBe(true)
    expect(isValidConnectionTimeout('4294967295')).toBe(true)
  })

  it('rejects what the upstream field rejects', () => {
    expect(isValidConnectionTimeout('')).toBe(false)
    expect(isValidConnectionTimeout('  ')).toBe(false)
    expect(isValidConnectionTimeout('-1')).toBe(false)
    expect(isValidConnectionTimeout('1.5')).toBe(false)
    expect(isValidConnectionTimeout('five')).toBe(false)
    expect(isValidConnectionTimeout('4294967296')).toBe(false)
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
    // The upstream page's Filename setter puts the file's directory in Working Directory.
    expect(field('Working Directory')).toHaveValue('/tmp')
    // The upstream CoreCLR page starts its Timeout at DotNetStartDebuggingOptions' five seconds.
    expect(field('Timeout')).toHaveValue(String(DEFAULT_CONNECTION_TIMEOUT_SECONDS))
  })

  it('launches with the values the dialog collected', () => {
    render(<DebugProgramDialog onClose={vi.fn()} />)

    fireEvent.change(field('Arguments'), { target: { value: '"a b" c' } })
    fireEvent.change(field('Working Directory'), { target: { value: '/tmp' } })
    // The environment is edited in its own dialog, like dnSpy's read-only summary plus EditEnvironmentDlg.
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Edit Environment Variables' }))
    const environmentDialog = screen.getByRole('dialog', { name: 'Environment Variables' })
    fireEvent.click(within(environmentDialog).getByRole('button', { name: 'Add' }))
    fireEvent.change(within(environmentDialog).getByLabelText('Key 1'), { target: { value: 'DNSPY_TEST' } })
    fireEvent.change(within(environmentDialog).getByLabelText('Value 1'), { target: { value: '1' } })
    fireEvent.click(within(environmentDialog).getByRole('button', { name: 'OK' }))
    fireEvent.change(field('Timeout'), { target: { value: '12' } })
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
      connectionTimeout: 12,
    })
  })

  it('keeps OK disabled while the Timeout is not the uint the upstream field takes', () => {
    render(<DebugProgramDialog onClose={vi.fn()} />)
    const ok = (): HTMLElement => within(dialog()).getByRole('button', { name: 'OK' })
    const timeout = field('Timeout')

    for (const invalid of ['', '-1', '1.5', 'five']) {
      fireEvent.change(timeout, { target: { value: invalid } })
      expect(timeout).toHaveAttribute('aria-invalid', 'true')
      expect(ok()).toBeDisabled()
    }

    fireEvent.change(timeout, { target: { value: '0' } })
    expect(timeout).toHaveAttribute('aria-invalid', 'false')
    expect(ok()).toBeEnabled()
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

    fireEvent.change(field('Working Directory'), { target: { value: '' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'OK' }))

    expect(launchDebug).toHaveBeenCalledWith(expect.objectContaining({ workingDirectory: undefined, stopAtEntry: false }))
  })

  it('moves Working Directory with the executable, as the upstream Filename setter does', () => {
    render(<DebugProgramDialog onClose={vi.fn()} />)

    fireEvent.change(field('Executable'), { target: { value: '/srv/app/Other.dll' } })

    expect(field('Working Directory')).toHaveValue('/srv/app')
  })

  it('asks before debugging a file whose extension is not .exe or .dll', async () => {
    const askMessage = vi.fn(async (_message: string, _buttons: string[]) => ({ button: 'No', dontShowAgain: false }))
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, askMessage } })
    vi.spyOn(window.dnSpy, 'pathExists').mockResolvedValue(true)
    render(<DebugProgramDialog onClose={vi.fn()} />)

    fireEvent.change(field('Executable'), { target: { value: '/tmp/DebugTarget.bin' } })
    await waitFor(() => expect(field('Executable')).toHaveAttribute('aria-invalid', 'false'))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'OK' }))

    await waitFor(() => expect(askMessage).toHaveBeenCalled())
    expect(askMessage.mock.calls[0][0]).toBe("Are you sure you want to debug this file which doesn't have a valid extension?")
    // A No keeps the dialog open and launches nothing, like StartDebuggingOptionsProvider.
    expect(launchDebug).not.toHaveBeenCalled()
  })

  it('disables OK while the executable is empty', () => {
    render(<DebugProgramDialog onClose={vi.fn()} />)
    const ok = (): HTMLElement => within(dialog()).getByRole('button', { name: 'OK' })
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
    fireEvent.change(screen.getByLabelText('Timeout'), { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    cleanup()

    render(<DebugProgramDialog onClose={vi.fn()} />)
    expect(screen.getByLabelText('Arguments')).toHaveValue('--evaluate --wait')
    expect(screen.getByLabelText('Timeout')).toHaveValue('9')
  })
})
