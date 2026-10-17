import { useMemo, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { DebugVariable } from '../../../shared/protocol'
import { breakpointConditionsSummary, breakpointsFile, methodBreakpointName, parseLineBreakpointEntries, parseFunctionBreakpoints, useAppStore } from '../app-store'
import type { BreakpointSettings, LineBreakpoint } from '../app-store'
import { useLanguage } from '../localization'
import { BreakpointSettingsDialog } from './BreakpointSettingsDialog'
import { DsIcon } from './DsIcon'
import { TreeExpanderGlyph } from './DsGlyphs'

export const LocalsPane = (): React.JSX.Element => {
  const variables = useAppStore((state) => state.debugVariables)
  const { t } = useLanguage()
  return (
    <div className="debug-table" role="table" aria-label={t('Locals')}>
      <div className="debug-table-header">{t('Name')}</div><div className="debug-table-header">{t('Value')}</div><div className="debug-table-header">{t('Type')}</div>
      {variables.map((variable, index) => <VariableRow variable={variable} depth={0} key={`${variable.name}:${index}`} />)}
    </div>
  )
}

const VariableRow = ({ variable, depth }: { variable: DebugVariable; depth: number }): React.JSX.Element => {
  const sessionId = useAppStore((state) => state.debugSessionId)
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [children, setChildren] = useState<DebugVariable[]>()
  const { t } = useLanguage()
  const toggle = async (): Promise<void> => {
    if (!sessionId || variable.variablesReference === 0) return
    if (!expanded && !children) {
      setLoading(true)
      try { setChildren(await window.dnSpy.getDebugVariables(sessionId, variable.variablesReference)) }
      finally { setLoading(false) }
    }
    setExpanded((value) => !value)
  }
  return (
    <>
      <div className="debug-table-row" role="row">
        <span className="debug-variable-name" style={{ paddingLeft: `${7 + depth * 15}px` }}>
          <button className="tree-expander" aria-label={t(expanded ? 'Collapse {name}' : 'Expand {name}', { name: variable.name })} disabled={variable.variablesReference === 0} onClick={() => void toggle()}>
            {/* The variables windows expand a value with the tree's ExpandCollapseToggleStyle; while its children
                load the port shows its spinner, which dnSpy has no counterpart of. */}
            {loading ? <LoaderCircle className="spin" size={12} /> : <TreeExpanderGlyph expanded={expanded} />}
          </button>
          {variable.name}
        </span>
        <span title={variable.value}>{variable.value}</span><span>{variable.type}</span>
      </div>
      {expanded && children?.map((child, index) => <VariableRow variable={child} depth={depth + 1} key={`${child.name}:${index}`} />)}
    </>
  )
}

export const WatchPane = (): React.JSX.Element => {
  const [expression, setExpression] = useState('')
  const debugState = useAppStore((state) => state.debugState)
  const values = useAppStore((state) => state.watchValues)
  const addWatch = useAppStore((state) => state.addWatch)
  const removeWatch = useAppStore((state) => state.removeWatch)
  // The in-process engine cannot evaluate expressions, so the input is offered only when it can.
  const canEvaluate = useAppStore((state) => state.debugCapabilities.supportsEvaluate !== false)
  const disabled = debugState !== 'stopped' || !canEvaluate
  const { t } = useLanguage()
  const submit = (): void => {
    if (expression.trim()) {
      void addWatch(expression)
      setExpression('')
    }
  }
  return (
    <div className="debug-tool-pane">
      <div className="debug-input-row">
        <input aria-label={t('Watch expression')} placeholder={t('Expression')} value={expression} disabled={disabled} title={canEvaluate ? undefined : t('Not supported by this debug engine')} onChange={(event) => setExpression(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit() }} />
        <button className="icon-button" aria-label={t('Add watch')} title={t('Add watch')} disabled={disabled || !expression.trim()} onClick={submit}><DsIcon name="Watch" /></button>
      </div>
      <div className="debug-table debug-table-watch" role="table" aria-label={t('Watch')}>
        <div className="debug-table-header">{t('Expression')}</div><div className="debug-table-header">{t('Value')}</div><div className="debug-table-header">{t('Type')}</div><div />
        {values.map((variable) => (
          <div className="debug-table-row" role="row" key={variable.name}>
            <span>{variable.name}</span><span title={variable.value}>{variable.value}</span><span>{variable.type}</span>
            <button className="icon-button" aria-label={t('Remove {name}', { name: variable.name })} onClick={() => removeWatch(variable.name)}><DsIcon name="DeleteWatch" /></button>
          </div>
        ))}
      </div>
    </div>
  )
}

export const CallStackPane = (): React.JSX.Element => {
  const frames = useAppStore((state) => state.debugFrames)
  const selectedFrameId = useAppStore((state) => state.selectedDebugFrameId)
  const activeFrameId = useAppStore((state) => state.activeDebugFrameId)
  const selectFrame = useAppStore((state) => state.selectDebugFrame)
  const switchToFrame = useAppStore((state) => state.switchToDebugFrame)
  const { t } = useLanguage()
  return (
    <div className="result-list" role="list" aria-label={t('Call Stack')}>
      {frames.map((frame) => {
        const active = activeFrameId === frame.id
        // WPF's grid has no location column — the frame's name is the whole row — so the file and line
        // stay reachable through the tooltip instead of taking a column of their own.
        const location = `${frame.source?.name ?? frame.source?.path ?? ''}${frame.line > 0 ? `:${frame.line}` : ''}`
        return (
          <button
            key={frame.id}
            className={`result-row stack-row${selectedFrameId === frame.id ? ' selected' : ''}${active ? ' active' : ''}`}
            title={location}
            aria-current={active ? 'true' : undefined}
            onClick={() => void selectFrame(frame.id)}
            onDoubleClick={() => void switchToFrame(frame.id)}
            // A button takes Enter as a click, so the switch has to claim the key before the select does.
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void switchToFrame(frame.id)
              }
            }}
          >
            <span className="stack-marker" aria-hidden="true">{active ? '>' : ''}</span>
            <span className="result-name">{frame.name}</span>
          </button>
        )
      })}
    </div>
  )
}

export const ThreadsPane = (): React.JSX.Element => {
  const threads = useAppStore((state) => state.debugThreads)
  const selectedThreadId = useAppStore((state) => state.selectedDebugThreadId)
  const selectThread = useAppStore((state) => state.selectDebugThread)
  const { t } = useLanguage()
  return (
    <div className="result-list" role="list" aria-label={t('Threads')}>
      {threads.map((thread) => (
        <button key={thread.id} className={`result-row thread-row${selectedThreadId === thread.id ? ' selected' : ''}`} onClick={() => void selectThread(thread.id)}>
          <span className="result-name">{thread.name}</span><span className="result-location">{thread.id}</span>
        </button>
      ))}
    </div>
  )
}

// A line breakpoint is identified by the method it lives in plus the line, so two breakpoints in the same method
// do not read as the same row. The method name is the dotted form the Debug menu also uses, which keeps the pane
// and the "Toggle Method Breakpoint" entry speaking the same language.
const lineBreakpointLabel = (breakpoint: LineBreakpoint): string => {
  const method = methodBreakpointName(breakpoint.description)
  return method ? `${method}:${breakpoint.line}` : `Line ${breakpoint.line}`
}

export const BreakpointsPane = (): React.JSX.Element => {
  const [name, setName] = useState('')
  const [status, setStatus] = useState('')
  // Which breakpoint's settings dialog is open: a line breakpoint by id, a function one by name.
  const [editing, setEditing] = useState<{ kind: 'line' | 'function'; key: string }>()
  const lineBreakpoints = useAppStore((state) => state.lineBreakpoints)
  const removeLineBreakpoint = useAppStore((state) => state.removeLineBreakpoint)
  const setLineBreakpointEnabled = useAppStore((state) => state.setLineBreakpointEnabled)
  const setLineBreakpointSettings = useAppStore((state) => state.setLineBreakpointSettings)
  const breakpoints = useAppStore((state) => state.functionBreakpoints)
  const addBreakpoint = useAppStore((state) => state.addFunctionBreakpoint)
  const removeBreakpoint = useAppStore((state) => state.removeFunctionBreakpoint)
  const setBreakpointEnabled = useAppStore((state) => state.setFunctionBreakpointEnabled)
  const setBreakpointSettings = useAppStore((state) => state.setFunctionBreakpointSettings)
  const importBreakpoints = useAppStore((state) => state.importBreakpoints)
  const { t } = useLanguage()
  const submit = (): void => {
    if (name.trim()) {
      void addBreakpoint(name)
      setName('')
    }
  }

  // The same file the settings are written as, so an export can be dropped back in by hand.
  const exportBreakpoints = async (): Promise<void> => {
    const file = breakpointsFile(useAppStore.getState())
    if (file.breakpoints.length === 0 && file.functions.length === 0)
      return
    const saved = await window.dnSpy.saveCode('breakpoints.json', JSON.stringify(file, null, 2))
    setStatus(saved ? t('Exported breakpoints to {path}.', { path: saved }) : '')
  }

  const runImport = async (): Promise<void> => {
    let text: string | undefined
    try {
      text = await window.dnSpy.readTextFile('breakpoints')
    } catch {
      // A file the host could not read is reported the same way a damaged one is.
      setStatus(t('The breakpoint file could not be read.'))
      return
    }
    if (text === undefined)
      return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      setStatus(t('The breakpoint file could not be read.'))
      return
    }
    const stored = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
    const file = {
      breakpoints: parseLineBreakpointEntries(parsed),
      functions: parseFunctionBreakpoints(stored.functions),
    }
    if (file.breakpoints.length === 0 && file.functions.length === 0) {
      setStatus(t('The breakpoint file could not be read.'))
      return
    }
    setStatus(t('Imported {count} breakpoint(s).', { count: await importBreakpoints(file) }))
  }

  return (
    <div className="debug-tool-pane">
      {/* CodeBreakpointsControl.xaml's import and export buttons, with the images dnSpy gives them; the
          settings and remove buttons on each row are its context menu's _Settings and Remove Breakpoint. */}
      <div className="bookmarks-toolbar">
        <button className="icon-button" title={t('Import Breakpoints')} aria-label={t('Import Breakpoints')} onClick={() => void runImport()}><DsIcon name="Import" /></button>
        <button
          className="icon-button"
          title={t('Export Breakpoints')}
          aria-label={t('Export Breakpoints')}
          disabled={lineBreakpoints.length === 0 && breakpoints.length === 0}
          onClick={() => void exportBreakpoints()}
        ><DsIcon name="Open" /></button>
        {status ? <span className="bookmarks-status">{status}</span> : null}
      </div>
      <div className="result-list">
        {lineBreakpoints.map((breakpoint) => {
          const label = lineBreakpointLabel(breakpoint)
          const summary = breakpointConditionsSummary(breakpoint.settings, breakpoint.hitCount)
          return (
            <div className={`breakpoint-row${breakpoint.enabled ? '' : ' breakpoint-disabled'}`} key={breakpoint.id}>
              <div className="breakpoint-main-row">
                <input
                  type="checkbox"
                  checked={breakpoint.enabled}
                  aria-label={t(breakpoint.enabled ? 'Disable {name}' : 'Enable {name}', { name: label })}
                  onChange={() => void setLineBreakpointEnabled(breakpoint.id, !breakpoint.enabled)}
                />
                <span className={`breakpoint-state breakpoint-state-${breakpoint.state}`} title={breakpoint.message ?? t('Bound')} />
                <span title={breakpoint.message ?? breakpoint.description}>{label}</span>
                <button
                  className="icon-button"
                  aria-label={t('Breakpoint settings for {name}', { name: label })}
                  title={t('Breakpoint settings')}
                  onClick={() => setEditing({ kind: 'line', key: breakpoint.id })}
                >
                  <DsIcon name="Settings" />
                </button>
                <button className="icon-button" aria-label={t('Remove {name}', { name: label })} onClick={() => void removeLineBreakpoint(breakpoint.id)}><DsIcon name="Cancel" /></button>
              </div>
              {summary && <div className="breakpoint-summary">{summary}</div>}
            </div>
          )
        })}
      </div>
      <div className="debug-input-row">
        <input aria-label={t('Function breakpoint')} placeholder="Namespace.Type.Method" value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit() }} />
        <button className="icon-button" aria-label={t('Add function breakpoint')} title={t('Add function breakpoint')} disabled={!name.trim()} onClick={submit}><DsIcon name="Add" /></button>
      </div>
      <div className="result-list">
        {breakpoints.map((breakpoint) => {
          const summary = breakpointConditionsSummary(breakpoint.settings, breakpoint.hitCount)
          return (
            <div className={`breakpoint-row${breakpoint.enabled ? '' : ' breakpoint-disabled'}`} key={breakpoint.name}>
              <div className="breakpoint-main-row">
                <input
                  type="checkbox"
                  checked={breakpoint.enabled}
                  aria-label={t(breakpoint.enabled ? 'Disable {name}' : 'Enable {name}', { name: breakpoint.name })}
                  onChange={() => void setBreakpointEnabled(breakpoint.name, !breakpoint.enabled)}
                />
                <span>{breakpoint.name}</span>
                <button
                  className="icon-button"
                  aria-label={t('Breakpoint settings for {name}', { name: breakpoint.name })}
                  title={t('Breakpoint settings')}
                  onClick={() => setEditing({ kind: 'function', key: breakpoint.name })}
                >
                  <DsIcon name="Settings" />
                </button>
                <button className="icon-button" aria-label={t('Remove {name}', { name: breakpoint.name })} onClick={() => void removeBreakpoint(breakpoint.name)}><DsIcon name="Cancel" /></button>
              </div>
              {summary && <div className="breakpoint-summary">{summary}</div>}
            </div>
          )
        })}
      </div>
      {editing && (
        <BreakpointSettingsDialog
          title={t('Breakpoint settings')}
          settings={
            editing.kind === 'line'
              ? lineBreakpoints.find((bp) => bp.id === editing.key)?.settings
              : breakpoints.find((bp) => bp.name === editing.key)?.settings
          }
          onClose={() => setEditing(undefined)}
          onSave={(settings) => {
            if (editing.kind === 'line') {
              void setLineBreakpointSettings(editing.key, settings)
            } else {
              void setBreakpointSettings(editing.key, settings)
            }
            setEditing(undefined)
          }}
        />
      )}
    </div>
  )
}

export const ModulesPane = (): React.JSX.Element => {
  const modules = useAppStore((state) => state.debugModules)
  const { t } = useLanguage()
  return (
    <div className="debug-table modules-table" role="table" aria-label={t('Modules')}>
      <div className="debug-table-header">{t('Name')}</div><div className="debug-table-header">{t('Path')}</div><div className="debug-table-header">{t('Symbols')}</div>
      {modules.map((module) => (
        <div className="debug-table-row" role="row" key={String(module.id)}>
          <span>{module.name}</span><span title={module.path}>{module.path}</span><span>{module.symbolStatus}</span>
        </div>
      ))}
    </div>
  )
}

export const DebugStatusPane = (): React.JSX.Element => {
  const state = useAppStore((appState) => appState.debugState)
  const reason = useAppStore((appState) => appState.stoppedReason)
  const { locale, t } = useLanguage()
  const label = useMemo(() => state === 'stopped' && reason ? t('Stopped: {reason}', { reason: t(reason) }) : t(state), [state, reason, locale])
  return <div className="pane-empty">{label}</div>
}
