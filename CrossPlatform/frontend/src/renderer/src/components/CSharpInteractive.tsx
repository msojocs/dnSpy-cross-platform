import { useEffect, useRef } from 'react'
import Editor from './CodeEditor'
import { Eraser, HelpCircle, RotateCcw } from 'lucide-react'
import type { editor as MonacoEditor } from 'monaco-editor'
import type { ScriptOutputEntry } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'
import { monacoThemeName } from '../monaco'
import { attachClassifier, type Classifier } from '../roslyn-classification'
import { useAppOptions } from './app-options'
import { ClassifiedText } from './ColoredText'

/**
 * The C# Interactive window: a log of everything submissions have printed, and a Monaco box that
 * collects the next one. Enter runs, Shift+Enter breaks the line, Alt+Up/Down walks the history —
 * the bindings the upstream window documents in its `#help` text.
 */
export const CSharpInteractive = ({ theme, transparentBackground }: { theme: string; transparentBackground: boolean }): React.JSX.Element => {
  const font = useAppOptions().environmentFont
  const entries = useAppStore((state) => state.scriptEntries)
  const running = useAppStore((state) => state.scriptRunning)
  const startScript = useAppStore((state) => state.startScript)
  const evaluateScript = useAppStore((state) => state.evaluateScript)
  const resetScript = useAppStore((state) => state.resetScript)
  const clearScriptOutput = useAppStore((state) => state.clearScriptOutput)
  const showScriptHelp = useAppStore((state) => state.showScriptHelp)
  const { t } = useLanguage()

  // The submission is read at run time, so the commands Monaco is bound to never go stale, and the
  // store's own actions are stable for the same reason.
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | undefined>(undefined)
  const logRef = useRef<HTMLDivElement | null>(null)
  const runRef = useRef<() => void>(() => {})
  const classifierRef = useRef<Classifier | undefined>(undefined)

  useEffect(() => () => classifierRef.current?.dispose(), [])

  useEffect(() => {
    if (!useAppStore.getState().scriptStarted)
      void startScript()
  }, [startScript])

  runRef.current = () => {
    const editor = editorRef.current
    if (!editor) return
    const code = editor.getValue()
    if (!code.trim() || useAppStore.getState().scriptRunning) return
    const colors = classifierRef.current?.current()
    editor.setValue('')
    void evaluateScript(code, colors)
  }

  // The history cursor lives here rather than in the store: it is a property of this input box, not
  // of the session. `undefined` means "past the newest entry", which is also where a submission
  // leaves it — one cursor value covers both, and the length it is measured against keeps changing.
  const historyCursor = useRef<number | undefined>(undefined)

  useEffect(() => {
    historyCursor.current = undefined
  }, [entries.length])

  const recallHistory = (direction: -1 | 1): void => {
    const editor = editorRef.current
    const history = useAppStore.getState().scriptHistory
    if (!editor || history.length === 0) return
    const cursor = historyCursor.current ?? history.length
    const next = Math.min(history.length, Math.max(0, cursor + direction))
    historyCursor.current = next
    const model = editor.getModel()
    editor.setValue(next === history.length ? '' : history[next])
    if (model) {
      const end = model.getPositionAt(model.getValueLength())
      editor.setPosition(end)
    }
    editor.focus()
  }

  // The log is what the user is watching, so it follows the newest line unless they scrolled back.
  useEffect(() => {
    const log = logRef.current
    if (log)
      log.scrollTop = log.scrollHeight
  }, [entries])

  return (
    <div className="script-pane" data-running={String(running)}>
      <div className="script-toolbar">
        {/* Deliberately live while a submission runs: rebuilding the session is how a script that
            never returns is stopped, which is what the upstream Reset command is for. */}
        <button className="icon-button" title={t('Reset the execution environment')} aria-label={t('Reset the execution environment')} onClick={() => void resetScript()}>
          <RotateCcw size={15} />
        </button>
        <button className="icon-button" title={t('Clear the script editor')} aria-label={t('Clear the script editor')} onClick={clearScriptOutput}>
          <Eraser size={15} />
        </button>
        <button className="icon-button" title={t('Display the help')} aria-label={t('Display the help')} onClick={showScriptHelp}>
          <HelpCircle size={15} />
        </button>
        <span className="script-hint">{t('Enter runs the submission, Shift+Enter adds a line.')}</span>
      </div>
      <div className="script-log output-pane" role="log" ref={logRef}>
        {entries.map((entry, index) => (
          <div key={`${index}:${entry.text}`} className={`script-entry script-${entry.kind}${entry.colors ? ' code-colors' : ''}`}>
            {entry.kind === 'echo'
              ? <>{'> '}{entry.colors ? <ClassifiedText text={entry.text} spans={entry.colors} /> : entry.text}</>
              : entry.text}
          </div>
        ))}
      </div>
      <div className="script-input code-colors">
        <Editor
          path="csharp-interactive.csx"
          language="csharp"
          defaultValue=""
          theme={monacoThemeName(theme, transparentBackground)}
          onMount={(editor, monaco) => {
            editorRef.current = editor
            const run = (): void => runRef.current()
            // Enter runs the submission; Shift+Enter falls through to Monaco's newline. Alt+Up/Down
            // are claimed from Monaco's own word-move bindings, which the REPL window overrides too.
            editor.addCommand(monaco.KeyCode.Enter, run)
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run)
            editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.UpArrow, () => recallHistory(-1))
            editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.DownArrow, () => recallHistory(1))
            // The input is colored the way the WPF window's RoslynClassifier colors it while it is typed:
            // compiled as the session's next submission, in dnSpy's theme colors.
            classifierRef.current?.dispose()
            classifierRef.current = attachClassifier(monaco, editor, (code) => window.dnSpy.classifyScript(code))
          }}
          options={{
            readOnly: running,
            automaticLayout: true,
            minimap: { enabled: false },
            lineNumbers: 'off',
            glyphMargin: false,
            folding: false,
            scrollBeyondLastLine: false,
            renderLineHighlight: 'none',
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            wordWrap: 'on',
            fontFamily: `'${font.fontFamily}', 'JetBrains Mono', monospace`,
            fontSize: font.fontSize,
            lineHeight: Math.round(font.fontSize * 1.5),
            tabSize: 4,
            padding: { top: 6, bottom: 6 },
          }}
        />
      </div>
    </div>
  )
}
