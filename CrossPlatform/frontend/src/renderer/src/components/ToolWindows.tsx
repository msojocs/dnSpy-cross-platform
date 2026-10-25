import { useEffect, useRef } from 'react'
import { showPopupMenu, type PopupMenuEntry } from 'flexlayout-react'
import { useAppStore, type OutputLine, type OutputPaneId } from '../app-store'
import { useCategoryFont } from '../fonts'
import { useLanguage } from '../localization'
import { saveAppOptions, useAppOptions, type AppOptions, type OutputLoggerSettings } from './app-options'
import { DsIcon, MenuEntryIcon } from './DsIcon'

/**
 * The panes "Show output from" lists, by name — OutputService orders its buffers by name — with the label each
 * goes by. dnSpy's only pane is the debugger's Debug log (OutputLogger); the port also writes what it does
 * itself, which dnSpy shows in message boxes or not at all, to a pane of its own.
 */
const PANES: readonly { id: OutputPaneId; labelKey: string }[] = [
  { id: 'debug', labelKey: 'Debug' },
  { id: 'dnSpy', labelKey: 'dnSpy' },
]

/** OutputBufferVM.GetText: the pane as it reads, a timestamp and a space in front of every line that has one. */
export const outputText = (lines: readonly OutputLine[]): string =>
  lines.map((line) => line.timestamp === undefined ? line.text : `${line.timestamp} ${line.text}`).join('\n')

type OutputGeneral = AppOptions['output']['general']

/** The Output window's view options are the Output page's (OutputWindowOptionsService.Default), saved at once. */
const setOutputOption = (options: AppOptions, change: Partial<OutputGeneral>): void =>
  saveAppOptions({ ...options, output: { ...options.output, general: { ...options.output.general, ...change } } })

/**
 * dnSpy's Output window (OutputControl): "Show output from" and the Clear All, Save and Word Wrap buttons over
 * the selected pane's log, drawn in the Output Window font with the line numbers, timestamps and wrapping the
 * Output options ask for. Its context menu and keys are OutputContent's: Copy, Clear All (Ctrl+L), the three
 * view toggles, Save (Ctrl+S), Ctrl+E Ctrl+W, and Ctrl+1 to Ctrl+0 to pick a pane.
 */
export const OutputPane = (): React.JSX.Element => {
  const pane = useAppStore((state) => state.outputPane)
  const lines = useAppStore((state) => pane === 'debug' ? state.debugOutput : state.output)
  const clearOutput = useAppStore((state) => state.clearOutput)
  const selectOutputPane = useAppStore((state) => state.selectOutputPane)
  const options = useAppOptions()
  const { wordWrap, showLineNumbers, showTimestamps } = options.output.general
  const font = useCategoryFont('outputWindow')
  const { t } = useLanguage()
  const log = useRef<HTMLDivElement>(null)
  const waitingForSecondKey = useRef(false)
  const paneName = t(PANES.find((entry) => entry.id === pane)!.labelKey)

  // A log follows what is written to it, the way dnSpy's log editor scrolls to the end on every write.
  useEffect(() => {
    const element = log.current
    if (element)
      element.scrollTop = element.scrollHeight
  }, [lines])

  // OutputService.GetFilename: "Output-" and the pane's name without its spaces, as Visual Studio names it.
  const save = async (): Promise<void> => {
    await window.dnSpy.saveCode(`${t('Output')}-${paneName.replace(/ /g, '')}.txt`, outputText(lines), t('Save Output As'))
  }

  const selectedText = (): string => {
    const selection = window.getSelection()
    return selection && log.current && !selection.isCollapsed && log.current.contains(selection.anchorNode) ? selection.toString() : ''
  }

  // OutputBufferVM.Copy: the selection, or the line the caret is on when there is none.
  const copy = (line?: OutputLine): void => {
    const text = selectedText() || (line ? outputText([line]) : '')
    if (text)
      void navigator.clipboard?.writeText(text)
  }

  const toggleWordWrap = (): void => setOutputOption(options, { wordWrap: !wordWrap })

  const showContextMenu = (event: React.MouseEvent, line?: OutputLine): void => {
    event.preventDefault()
    const entry = (key: string, label: string, run: () => void, icon?: React.ReactNode, shortcut?: string): PopupMenuEntry => ({
      key,
      content: (
        <>
          <span className="document-tab-menu-icon">{icon}</span>
          <span className="document-tab-menu-label">{label}</span>
          <span className="document-tab-menu-shortcut">{shortcut}</span>
        </>
      ),
      onSelect: run,
    })
    // dnSpy's Output context menu: the copy group, then the view settings (Output/Commands.cs).
    const items: PopupMenuEntry[] = [
      entry('copy', t('Copy'), () => copy(line), <MenuEntryIcon name="Copy" />, 'Ctrl+C'),
      entry('clear-all', t('Clear All'), () => clearOutput(), <MenuEntryIcon name="ClearWindowContent" />, 'Ctrl+L'),
      { type: 'divider', key: 'settings' },
      entry('line-numbers', t('Show Line Numbers'), () => setOutputOption(options, { showLineNumbers: !showLineNumbers }), <MenuEntryIcon checked={showLineNumbers} />),
      entry('timestamps', t('Show Timestamps'), () => setOutputOption(options, { showTimestamps: !showTimestamps }), <MenuEntryIcon checked={showTimestamps} />),
      entry('word-wrap', t('Word Wrap'), toggleWordWrap, <MenuEntryIcon name="WordWrap" checked={wordWrap} />, 'Ctrl+E, Ctrl+W'),
    ]
    // OutputLogger's switches (Logger/Commands.cs), a group of their own that only the Debug pane's menu has.
    if (pane === 'debug') {
      const logger = options.outputLogger
      const toggle = (key: keyof OutputLoggerSettings, label: string): PopupMenuEntry =>
        entry(key, label, () => saveAppOptions({ ...options, outputLogger: { ...logger, [key]: !logger[key] } }), <MenuEntryIcon checked={logger[key]} />)
      items.push(
        { type: 'divider', key: 'logger' },
        toggle('showExceptionMessages', t('Exception Messages')),
        toggle('showStepFilteringMessages', t('Step Filtering Messages')),
        toggle('showModuleLoadMessages', t('Module Load Messages')),
        toggle('showModuleUnloadMessages', t('Module Unload Messages')),
        toggle('showProcessExitMessages', t('Process Exit Messages')),
        toggle('showThreadExitMessages', t('Thread Exit Messages')),
        toggle('showProgramOutputMessages', t('Program Output')),
        toggle('showMDAMessages', t('MDA Messages')),
      )
    }
    showPopupMenu({ anchor: { x: event.clientX, y: event.clientY }, returnFocusTo: log.current ?? undefined, title: t('Output'), items, onClose: () => undefined })
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const control = event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey
    const key = event.key.toLowerCase()
    // OutputControl_PreviewKeyDown: Ctrl+E arms the chord, W (with or without Ctrl) completes it.
    if (waitingForSecondKey.current) {
      waitingForSecondKey.current = false
      if (key === 'w' && !event.altKey && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        toggleWordWrap()
        return
      }
    }
    if (!control)
      return
    const handled = (): void => { event.preventDefault(); event.stopPropagation() }
    if (key === 'e') {
      handled()
      waitingForSecondKey.current = true
    } else if (key === 'l') {
      handled()
      clearOutput()
    } else if (key === 's') {
      handled()
      void save()
    } else if (key === 'c' || key === 'insert') {
      handled()
      copy()
    } else if (/^[0-9]$/.test(key)) {
      // SelectLogWindowCommands: Ctrl+1 is the first pane, Ctrl+0 the tenth.
      const index = key === '0' ? 9 : Number(key) - 1
      if (index < PANES.length) {
        handled()
        selectOutputPane(PANES[index].id)
      }
    }
  }

  const numberWidth = `${Math.max(2, String(lines.length).length)}ch`

  return (
    <div className="output-window" onKeyDown={onKeyDown}>
      <div className="output-command-bar" role="toolbar" aria-label={t('Output')}>
        <label className="output-source">
          <span>{t('Show output from:')}</span>
          <select value={pane} onChange={(event) => selectOutputPane(event.target.value as OutputPaneId)}>
            {PANES.map((entry, index) => <option key={entry.id} value={entry.id}>{`${t(entry.labelKey)} Ctrl+${(index + 1) % 10}`}</option>)}
          </select>
        </label>
        <span className="toolbar-separator" />
        {/* dnSpy's own three buttons, with the images and tool tips its control gives them (OutputControl.xaml). */}
        <button type="button" className="icon-button" aria-label={t('Clear All')} title={`${t('Clear All')} (Ctrl+L)`} onClick={() => clearOutput()}><DsIcon name="ClearWindowContent" /></button>
        <button type="button" className="icon-button" aria-label={t('Save As')} title={`${t('Save')} (Ctrl+S)`} onClick={() => void save()}><DsIcon name="Save" /></button>
        <span className="toolbar-separator" />
        <button type="button" className="icon-button" aria-label={t('Word Wrap')} title={`${t('Toggle Word Wrap')} (Ctrl+E, Ctrl+W)`} aria-pressed={wordWrap} onClick={toggleWordWrap}><DsIcon name="WordWrap" /></button>
      </div>
      <div
        ref={log}
        className={`output-pane${wordWrap ? ' output-word-wrap' : ''}${showLineNumbers ? ' output-line-numbers' : ''}`}
        role="log"
        aria-label={t('Output')}
        tabIndex={0}
        style={{ fontFamily: font.fontFamily, fontSize: font.fontSize, ['--output-number-width' as string]: numberWidth }}
        onContextMenu={(event) => showContextMenu(event)}
      >
        {lines.map((line, index) => (
          <div key={index} className="output-line" onContextMenu={(event) => { event.stopPropagation(); showContextMenu(event, line) }}>
            {showLineNumbers && <span className="output-line-number tc-lineNumber" aria-hidden="true">{index + 1}</span>}
            <span className="output-line-text">
              {line.timestamp !== undefined && <span className="tc-debugLogTimestamp">{`${line.timestamp} `}</span>}
              {line.color !== undefined ? <span className={`tc-${line.color}`}>{line.text}</span> : line.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export const DebugPlaceholder = ({ label }: { label: string }): React.JSX.Element => (
  <div className="pane-empty">{label}</div>
)
