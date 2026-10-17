import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'
import { CloseGlyph } from './DsGlyphs'

/**
 * Splits a command line the way a shell would, so `"a b" c` becomes two arguments. The upstream dialog
 * keeps the line as free text and hands it to the process verbatim; here the backend takes an argv array.
 */
export const splitArguments = (input: string): string[] => {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let quoted = false
  for (const char of input) {
    if (quote) {
      if (char === quote)
        quote = undefined
      else
        current += char
    } else if (char === '"' || char === "'") {
      quote = char
      quoted = true
    } else if (/\s/.test(char)) {
      if (quoted || current) args.push(current)
      current = ''
      quoted = false
    } else {
      current += char
    }
  }
  if (quoted || current) args.push(current)
  return args
}

/**
 * Parses the `KEY=VALUE` lines of the environment box. Returns `undefined` for input that could not be
 * a valid environment, which is what disables the OK button.
 */
export const parseEnvironment = (input: string): Record<string, string> | undefined => {
  const environment: Record<string, string> = {}
  for (const line of input.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf('=')
    const key = separator > 0 ? trimmed.slice(0, separator).trim() : ''
    if (!key) return undefined
    environment[key] = trimmed.slice(separator + 1)
  }
  return environment
}

/**
 * The host a framework-dependent assembly is run through unless the user says otherwise, ie. the
 * upstream CoreCLR page's default. WPF derives it from `IsDotNetAppHostFilename`, which needs the
 * file's bytes; here the dialog only sees the path, so a `.dll` is taken to need the host and an
 * apphost (`.exe`, or a Linux apphost with no extension) to run on its own — the same guess the
 * engine makes when the choice is left out.
 */
export const defaultsToHost = (program: string): boolean => program.trim().toLowerCase().endsWith('.dll')

/** What the dialog remembers of a program it started — dnSpy's StartDebuggingOptionsMru, by file. */
interface RememberedLaunch {
  argumentsText: string
  workingDirectory: string
  environmentText: string
  useHost: boolean
  host: string
  hostArgumentsText: string
  breakAt: 'dont-break' | 'create-process' | 'entry-point' | 'module-cctor-or-entry-point'
}

const launchMruStorageKey = 'dnspy.debugProgramMru.v1'
const LAUNCH_MRU_SIZE = 20

const loadLaunchMru = (): Record<string, RememberedLaunch> => {
  try {
    const stored = JSON.parse(localStorage.getItem(launchMruStorageKey) ?? '{}') as unknown
    return typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? stored as Record<string, RememberedLaunch> : {}
  } catch {
    return {}
  }
}

const rememberLaunch = (program: string, launch: RememberedLaunch): void => {
  const entries = Object.entries(loadLaunchMru()).filter(([path]) => path !== program)
  const kept = [[program, launch] as const, ...entries].slice(0, LAUNCH_MRU_SIZE)
  localStorage.setItem(launchMruStorageKey, JSON.stringify(Object.fromEntries(kept)))
}

/**
 * The Debug Program dialog, and with `mode="run"` the one Start Without Debugging opens: the same fields,
 * and the program runs on its own instead of under the debugger.
 */
export const DebugProgramDialog = ({ onClose, mode = 'debug' }: { onClose(): void; mode?: 'debug' | 'run' }): React.JSX.Element => {
  const dialog = useRef<HTMLDivElement>(null)
  const defaultDebugTarget = useAppStore((state) => state.defaultDebugTarget)
  const launchDebug = useAppStore((state) => state.launchDebug)
  const appendOutput = useAppStore((state) => state.appendOutput)
  const { t } = useLanguage()
  const [program, setProgram] = useState(() => defaultDebugTarget() ?? '')
  // The options the program was last started with, which the fields open on.
  const [remembered] = useState(() => loadLaunchMru()[program.trim()])
  // The upstream .NET Framework page validates the executable against the file system on every keystroke
  // (ValidatesOnDataErrors + UpdateSourceTrigger=PropertyChanged): a path that is not a file draws the red
  // error border and keeps OK disabled. The renderer cannot reach the disk, so the answer comes from the
  // main process. A blank field is left unflagged — the dialog opens on it before the user has typed
  // anything — but it still keeps OK disabled, exactly like upstream's MissingFilename.
  const [programMissing, setProgramMissing] = useState(false)
  const [argumentsText, setArgumentsText] = useState(remembered?.argumentsText ?? '')
  const [workingDirectory, setWorkingDirectory] = useState(remembered?.workingDirectory ?? '')
  const [environmentText, setEnvironmentText] = useState(remembered?.environmentText ?? '')
  // The "use host executable" choice and the host it names, mirroring the upstream CoreCLR page. The
  // default follows the target kind; a blank host path means "find the dotnet CLI", and its default
  // argument is `exec`, exactly what upstream fills in.
  const [useHost, setUseHost] = useState(() => remembered?.useHost ?? defaultsToHost(program))
  const [host, setHost] = useState(remembered?.host ?? '')
  const [hostMissing, setHostMissing] = useState(false)
  const [hostArgumentsText, setHostArgumentsText] = useState(remembered?.hostArgumentsText ?? 'exec')
  const [breakAt, setBreakAt] = useState<RememberedLaunch['breakAt']>(remembered?.breakAt ?? 'dont-break')

  // A program picked with Browse... brings back what it was last started with, as dnSpy's MRU does.
  const chooseProgram = (path: string): void => {
    setProgram(path)
    const launch = loadLaunchMru()[path]
    if (!launch) return
    setArgumentsText(launch.argumentsText)
    setWorkingDirectory(launch.workingDirectory)
    setEnvironmentText(launch.environmentText)
    setUseHost(launch.useHost)
    setHost(launch.host)
    setHostArgumentsText(launch.hostArgumentsText)
    setBreakAt(launch.breakAt)
  }

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  // Re-runs per keystroke, like the upstream binding. The stale answers a fast typist leaves behind are
  // dropped by the cleanup flag so an earlier "missing" cannot overwrite a later "found".
  useEffect(() => {
    const trimmed = program.trim()
    if (!trimmed) {
      setProgramMissing(false)
      return
    }
    let cancelled = false
    void window.dnSpy.pathExists(trimmed).then((exists) => {
      if (!cancelled) setProgramMissing(!exists)
    })
    return () => { cancelled = true }
  }, [program])

  // Upstream validates the host the same way, and only when the box is ticked and a path was typed: an
  // empty host is not an error, it is the request to find the dotnet CLI.
  useEffect(() => {
    const trimmed = host.trim()
    if (!useHost || !trimmed) {
      setHostMissing(false)
      return
    }
    let cancelled = false
    void window.dnSpy.pathExists(trimmed).then((exists) => {
      if (!cancelled) setHostMissing(!exists)
    })
    return () => { cancelled = true }
  }, [host, useHost])

  // Same Tab trap as the Options dialog: focus must not reach the toolbar behind the modal.
  const keepFocusInDialog = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Tab' || !dialog.current)
      return
    const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
    if (focusable.length === 0)
      return
    const first = focusable[0]
    const last = focusable.at(-1)!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const environment = parseEnvironment(environmentText)
  const canConfirm = program.trim().length > 0 && !programMissing && environment !== undefined && !(useHost && hostMissing)

  const confirm = (): void => {
    if (!canConfirm) return
    // The dialog closes before the launch, like upstream: the stop lands in the debugger, not in a modal.
    onClose()
    rememberLaunch(program.trim(), { argumentsText, workingDirectory, environmentText, useHost, host, hostArgumentsText, breakAt })
    const options = {
      program: program.trim(),
      arguments: splitArguments(argumentsText),
      workingDirectory: workingDirectory.trim() || undefined,
      environment,
      stopAtEntry: breakAt === 'entry-point',
      ...(breakAt === 'create-process'
        ? { breakKind: 'CreateProcess' as const }
        : breakAt === 'module-cctor-or-entry-point'
          ? { breakKind: 'ModuleCctorOrEntryPoint' as const }
          : {}),
      // The host choice always travels; the host itself and its arguments only when it is used, a blank
      // path meaning "let the backend find the dotnet CLI".
      useHost,
      host: useHost ? host.trim() || undefined : undefined,
      hostArguments: useHost ? splitArguments(hostArgumentsText) : undefined,
    }
    if (mode === 'debug') {
      void launchDebug(options)
      return
    }
    void window.dnSpy.startWithoutDebugging(options).then(
      (processId) => appendOutput(t('Started {target} without debugging (process {processId}).', { target: options.program, processId }), 'debug'),
      (error: unknown) => appendOutput(t('Could not start {target}: {message}', { target: options.program, message: error instanceof Error ? error.message : String(error) }), 'debug'))
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialog} className="modal debug-program-dialog" role="dialog" aria-modal="true" aria-labelledby="debug-program-title" onKeyDown={keepFocusInDialog}>
        <div className="modal-title">
          <span id="debug-program-title">{mode === 'debug' ? t('Debug Program') : t('Start Without Debugging')}</span>
          <button type="button" className="icon-button" aria-label={t('Close')} title={t('Close')} onClick={onClose}><CloseGlyph /></button>
        </div>
        <div className="debug-program-fields">
          <label htmlFor="debug-program-engine">{t('Debug Engine')}</label>
          <div id="debug-program-engine" className="debug-program-engine">.NET</div>
          <span />

          <label htmlFor="debug-program-exe">{t('Executable')}</label>
          <input id="debug-program-exe" aria-invalid={programMissing} value={program} onChange={(event) => setProgram(event.target.value)} />
          <button type="button" onClick={() => void window.dnSpy.chooseDebugTarget().then((path) => { if (path) chooseProgram(path) })}>{t('Browse...')}</button>

          <label htmlFor="debug-program-args">{t('Arguments')}</label>
          <input id="debug-program-args" className="debug-program-wide" value={argumentsText} onChange={(event) => setArgumentsText(event.target.value)} />

          <label htmlFor="debug-program-cwd">{t('Working Directory')}</label>
          <input id="debug-program-cwd" value={workingDirectory} onChange={(event) => setWorkingDirectory(event.target.value)} />
          <button type="button" onClick={() => void window.dnSpy.chooseDebugDirectory().then((path) => { if (path) setWorkingDirectory(path) })}>{t('Browse...')}</button>

          <label htmlFor="debug-program-env">{t('Environment Variables')}</label>
          <textarea id="debug-program-env" className="debug-program-wide" placeholder={t('One KEY=VALUE per line')} value={environmentText} onChange={(event) => setEnvironmentText(event.target.value)} />

          <label className="debug-program-wide debug-program-checkbox" htmlFor="debug-program-use-host">
            <input id="debug-program-use-host" type="checkbox" checked={useHost} onChange={(event) => setUseHost(event.target.checked)} />
            {t('Use host executable')}
          </label>

          <label htmlFor="debug-program-host">{t('Host')}</label>
          <input id="debug-program-host" aria-invalid={useHost && hostMissing} disabled={!useHost} value={host} onChange={(event) => setHost(event.target.value)} />
          <button type="button" disabled={!useHost} onClick={() => void window.dnSpy.chooseDebugHost().then((path) => { if (path) setHost(path) })}>{t('Browse...')}</button>

          <label htmlFor="debug-program-host-args">{t('Host Arguments')}</label>
          <input id="debug-program-host-args" className="debug-program-wide" disabled={!useHost} value={hostArgumentsText} onChange={(event) => setHostArgumentsText(event.target.value)} />

          <label htmlFor="debug-program-break">{t('Break at')}</label>
          <select id="debug-program-break" className="debug-program-wide" value={breakAt} onChange={(event) => {
            const value = event.target.value
            setBreakAt(value === 'create-process' || value === 'entry-point' || value === 'module-cctor-or-entry-point' ? value : 'dont-break')
          }}>
            <option value="dont-break">{t("Don't Break")}</option>
            <option value="create-process">{t('CreateProcess')}</option>
            <option value="entry-point">{t('Entry Point')}</option>
            <option value="module-cctor-or-entry-point">{t('Module .cctor or Entry Point')}</option>
          </select>
        </div>
        <div className="modal-actions">
          <span className="modal-action-spacer" />
          <button type="button" onClick={onClose}>{t('Cancel')}</button>
          <button type="button" className="primary" disabled={!canConfirm} onClick={confirm}>{t('OK')}</button>
        </div>
      </div>
    </div>
  )
}
