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

export const DebugProgramDialog = ({ onClose }: { onClose(): void }): React.JSX.Element => {
  const dialog = useRef<HTMLDivElement>(null)
  const defaultDebugTarget = useAppStore((state) => state.defaultDebugTarget)
  const launchDebug = useAppStore((state) => state.launchDebug)
  const { t } = useLanguage()
  const [program, setProgram] = useState(() => defaultDebugTarget() ?? '')
  // The upstream .NET Framework page validates the executable against the file system on every keystroke
  // (ValidatesOnDataErrors + UpdateSourceTrigger=PropertyChanged): a path that is not a file draws the red
  // error border and keeps OK disabled. The renderer cannot reach the disk, so the answer comes from the
  // main process. A blank field is left unflagged — the dialog opens on it before the user has typed
  // anything — but it still keeps OK disabled, exactly like upstream's MissingFilename.
  const [programMissing, setProgramMissing] = useState(false)
  const [argumentsText, setArgumentsText] = useState('')
  const [workingDirectory, setWorkingDirectory] = useState('')
  const [environmentText, setEnvironmentText] = useState('')
  // The "use host executable" choice and the host it names, mirroring the upstream CoreCLR page. The
  // default follows the target kind; a blank host path means "find the dotnet CLI", and its default
  // argument is `exec`, exactly what upstream fills in.
  const [useHost, setUseHost] = useState(() => defaultsToHost(program))
  const [host, setHost] = useState('')
  const [hostMissing, setHostMissing] = useState(false)
  const [hostArgumentsText, setHostArgumentsText] = useState('exec')
  const [breakAt, setBreakAt] = useState<'dont-break' | 'create-process' | 'entry-point' | 'module-cctor-or-entry-point'>('dont-break')

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
    void launchDebug({
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
    })
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialog} className="modal debug-program-dialog" role="dialog" aria-modal="true" aria-labelledby="debug-program-title" onKeyDown={keepFocusInDialog}>
        <div className="modal-title">
          <span id="debug-program-title">{t('Debug Program')}</span>
          <button type="button" className="icon-button" aria-label={t('Close')} title={t('Close')} onClick={onClose}><CloseGlyph /></button>
        </div>
        <div className="debug-program-fields">
          <label htmlFor="debug-program-engine">{t('Debug Engine')}</label>
          <div id="debug-program-engine" className="debug-program-engine">.NET</div>
          <span />

          <label htmlFor="debug-program-exe">{t('Executable')}</label>
          <input id="debug-program-exe" aria-invalid={programMissing} value={program} onChange={(event) => setProgram(event.target.value)} />
          <button type="button" onClick={() => void window.dnSpy.chooseDebugTarget().then((path) => { if (path) setProgram(path) })}>{t('Browse...')}</button>

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
