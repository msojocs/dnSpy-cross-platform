import { useEffect, useRef, useState } from 'react'
import Editor from './CodeEditor'
import type { editor as MonacoEditor } from 'monaco-editor'
import { showPopupMenu, type PopupMenuEntry } from 'flexlayout-react'
import type { ScriptAskRequest } from '../../../shared/protocol'
import { scriptCodeText, scriptLines, scriptText } from '../script-lines'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'
import { monacoThemeName } from '../monaco'
import { attachClassifier, type Classifier } from '../roslyn-classification'
import { useCategoryFont } from '../fonts'
import { useAppOptions, saveAppOptions, type AppOptions } from './app-options'
import { ClassifiedText } from './ColoredText'
import { DsIcon, MenuEntryIcon } from './DsIcon'

/** The `#`-commands the window answers itself, which Enter runs whatever the syntax looks like. */
const SCRIPT_COMMANDS = new Set(['clear', 'cls', 'help', 'reset'])

const isScriptCommand = (code: string): boolean =>
  code.startsWith('#') && SCRIPT_COMMANDS.has(code.slice(1).trimStart().split(/\s+/)[0] ?? '')

const menuItem = (key: string, label: string, onSelect: (() => void) | undefined, options: { icon?: string; shortcut?: string; checked?: boolean; disabled?: boolean } = {}): PopupMenuEntry => ({
  key,
  content: (
    <>
      <span className="document-tab-menu-icon">{options.checked !== undefined ? <MenuEntryIcon checked={options.checked} /> : options.icon ? <MenuEntryIcon name={options.icon} /> : null}</span>
      <span className="document-tab-menu-label">{label}</span>
      {options.shortcut && <span className="document-tab-menu-shortcut">{options.shortcut}</span>}
    </>
  ),
  disabled: options.disabled,
  onSelect,
})

/**
 * The C# Interactive window: a log of everything submissions have printed, and a Monaco box that
 * collects the next one. It follows dnSpy's REPL: Enter submits only a complete submission (Ctrl+Enter
 * submits whatever is there), Shift+Enter adds a line, Alt+Up/Down walk the history and Ctrl+Alt+Up/Down
 * walk the entries matching the text being typed.
 */
export const CSharpInteractive = ({ theme, transparentBackground }: { theme: string; transparentBackground: boolean }): React.JSX.Element => {
  // dnSpy's REPL editor is in the Text Editor appearance category, so it takes that category's font.
  const font = useCategoryFont('textEditor')
  // The General / Scroll Bars / Tabs / Advanced pages of Options › REPL › C# are the REPL editor's own.
  const options = useAppOptions()
  const repl = options.repl.cSharp
  const wordWrap = repl.general.wordWrap
  const showLineNumbers = repl.general.showLineNumbers
  const entries = useAppStore((state) => state.scriptEntries)
  const running = useAppStore((state) => state.scriptRunning)
  const history = useAppStore((state) => state.scriptHistory)
  const startScript = useAppStore((state) => state.startScript)
  const evaluateScript = useAppStore((state) => state.evaluateScript)
  const resetScript = useAppStore((state) => state.resetScript)
  const clearScriptOutput = useAppStore((state) => state.clearScriptOutput)
  const { t } = useLanguage()

  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | undefined>(undefined)
  const logRef = useRef<HTMLDivElement | null>(null)
  const classifierRef = useRef<Classifier | undefined>(undefined)
  const actionsRef = useRef({
    submit: (_force: boolean): void => undefined,
    recall: (_direction: -1 | 1, _sameText: boolean): void => undefined,
    clearInput: (): void => undefined,
    selectAll: (): void => undefined,
    saveText: (): void => undefined,
    saveCode: (): void => undefined,
    copyCode: (): void => undefined,
    toggleWordWrap: (): void => undefined,
    toggleLineNumbers: (): void => undefined,
    reset: (): void => undefined,
    clearScreen: (): void => undefined,
  })

  const [ask, setAsk] = useState<ScriptAskRequest | undefined>(undefined)
  const [askText, setAskText] = useState('')

  useEffect(() => {
    const unsubscribe = window.dnSpy.onScriptAsk?.((request) => {
      setAsk(request)
      setAskText(request.defaultText ?? '')
    })
    return unsubscribe
  }, [])

  useEffect(() => () => classifierRef.current?.dispose(), [])

  useEffect(() => {
    if (!useAppStore.getState().scriptStarted)
      void startScript()
  }, [startScript])

  // The log is what the user is watching, so it follows the newest line unless they scrolled back.
  useEffect(() => {
    const log = logRef.current
    if (log)
      log.scrollTop = log.scrollHeight
  }, [entries])

  const setMonacoOption = (name: string, value: unknown): void => {
    editorRef.current?.updateOptions({ [name]: value } as MonacoEditor.IEditorOptions)
  }

  const setReplGeneral = (change: Partial<AppOptions['repl']['cSharp']['general']>): void => {
    saveAppOptions({ ...options, repl: { ...options.repl, cSharp: { ...repl, general: { ...repl.general, ...change } } } })
  }

  const toggleWordWrap = (): void => {
    const value = !wordWrap
    setReplGeneral({ wordWrap: value })
    setMonacoOption('wordWrap', value ? 'on' : 'off')
  }

  const toggleLineNumbers = (): void => {
    const value = !showLineNumbers
    setReplGeneral({ showLineNumbers: value })
    setMonacoOption('lineNumbers', value ? 'on' : 'off')
  }

  const insertNewLine = (): void => {
    editorRef.current?.trigger('keyboard', 'type', { text: '\n' })
  }

  const moveCaretToEnd = (): void => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model)
      return
    const end = model.getPositionAt(model.getValueLength())
    editor.setPosition(end)
    editor.revealPositionInCenterIfOutsideViewport(end)
  }

  // The history cursor lives here rather than in the store: it is a property of this input box, not
  // of the session. `undefined` means "past the newest entry".
  const historyCursor = useRef<number | undefined>(undefined)
  const historySearch = useRef<string | undefined>(undefined)

  useEffect(() => {
    historyCursor.current = undefined
    historySearch.current = undefined
  }, [entries.length])

  const recall = (direction: -1 | 1, sameText: boolean): void => {
    const editor = editorRef.current
    if (!editor || history.length === 0)
      return
    let search = ''
    if (sameText) {
      historySearch.current ??= editor.getValue()
      search = historySearch.current
    }
    else
      historySearch.current = undefined
    // dnSpy's ReplCommands has nothing to select next until a previous entry has been selected; the newest
    // entry stays in the box rather than being replaced by an empty one.
    if (direction > 0 && historyCursor.current === undefined)
      return
    if (direction < 0) {
      // dnSpy's ReplCommands: the first press starts at the newest entry and walks back.
      const from = Math.min(historyCursor.current ?? history.length, history.length) - 1
      for (let index = from; index >= 0; index--) {
        if (!search || history[index].includes(search)) {
          historyCursor.current = index
          editor.setValue(history[index])
          moveCaretToEnd()
          editor.focus()
          return
        }
      }
    }
    else {
      for (let index = (historyCursor.current ?? -1) + 1; index < history.length; index++) {
        if (!search || history[index].includes(search)) {
          historyCursor.current = index
          editor.setValue(history[index])
          moveCaretToEnd()
          editor.focus()
          return
        }
      }
    }
  }

  const submit = async (force: boolean): Promise<void> => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || useAppStore.getState().scriptRunning)
      return
    const code = editor.getValue()
    if (code.trim().length === 0)
      return
    const selection = editor.getSelection()
    const atEnd = !selection || (selection.isEmpty() && model.getOffsetAt(selection.getEndPosition()) === model.getValueLength())
    // dnSpy's ReplEditorOperations.HandleEnter: Enter submits only at the end of the input, and only a
    // command or a complete submission; anything else gets the line break it was typing.
    if (!atEnd) {
      insertNewLine()
      return
    }
    if (!force && !isScriptCommand(code)) {
      // The line break goes in before the completeness answer comes back: dnSpy's check is synchronous, and
      // waiting for ours would leave the keystrokes that follow Enter inside the submission being checked.
      const colors = classifierRef.current?.current()
      insertNewLine()
      let complete = true
      try {
        complete = (await window.dnSpy.isScriptComplete(code)).complete
      }
      catch {
        // A host that cannot answer is no reason to swallow the line break.
      }
      if (!complete)
        return
      editor.setValue('')
      void evaluateScript(code, colors)
      return
    }
    // The colors are worked out before the submission runs, so they are the input's, not the ones the
    // code would get once its own declarations exist.
    const colors = classifierRef.current?.current()
    editor.setValue('')
    void evaluateScript(code, colors)
  }

  const clearInput = (): void => {
    const editor = editorRef.current
    if (!editor)
      return
    editor.setValue('')
    editor.focus()
  }

  const selectAll = (): void => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model)
      return
    const selection = editor.getSelection()
    const allInputSelected = !!selection && !selection.isEmpty() && selection.startLineNumber === 1 && selection.startColumn === 1 &&
      model.getOffsetAt(selection.getEndPosition()) === model.getValueLength()
    if (!allInputSelected) {
      editor.setSelection(model.getFullModelRange())
      editor.focus()
      return
    }
    // A second Ctrl+A selects the whole window, the way dnSpy's ReplEditorOperations.SelectAll toggles
    // between the current input buffer and everything.
    const log = logRef.current
    const browserSelection = window.getSelection()
    if (!log || !browserSelection)
      return
    const range = document.createRange()
    range.selectNodeContents(log)
    browserSelection.removeAllRanges()
    browserSelection.addRange(range)
    log.focus()
  }

  const selectedLogCode = (): string | undefined => {
    const log = logRef.current
    const selection = window.getSelection()
    if (!log || !selection || selection.rangeCount === 0 || selection.isCollapsed || !selection.anchorNode || !log.contains(selection.anchorNode))
      return undefined
    const range = selection.getRangeAt(0)
    return [...log.querySelectorAll<HTMLElement>('.script-echo[data-code]')]
      .filter((element) => range.intersectsNode(element))
      .map((element) => element.dataset.code ?? '')
      .join('\n')
  }

  const currentCode = (): string => {
    const editor = editorRef.current
    const selection = editor?.getSelection()
    const model = editor?.getModel()
    if (editor && model && selection && !selection.isEmpty())
      return model.getValueInRange(selection)
    const fromLog = selectedLogCode()
    if (fromLog !== undefined)
      return fromLog
    return scriptCodeText(useAppStore.getState().scriptEntries, editor?.getValue())
  }

  const selectedCode = (): string | undefined => {
    const editor = editorRef.current
    const selection = editor?.getSelection()
    const model = editor?.getModel()
    if (editor && model && selection && !selection.isEmpty())
      return model.getValueInRange(selection)
    return selectedLogCode()
  }

  const saveText = (): void => {
    void window.dnSpy.saveCode('CSharpScript.txt', scriptText(useAppStore.getState().scriptEntries, editorRef.current?.getValue()))
      .catch((error: unknown) => window.dnSpy.showMessage(error instanceof Error ? error.message : String(error)))
  }

  const saveCode = (): void => {
    void window.dnSpy.saveCode('CSharpScript.csx', currentCode())
      .catch((error: unknown) => window.dnSpy.showMessage(error instanceof Error ? error.message : String(error)))
  }

  const copyCode = (): void => {
    // dnSpy's Copy Code is enabled by a selection; without one there is nothing to copy from the log.
    const code = selectedCode()
    if (code === undefined || code.length === 0)
      return
    void navigator.clipboard.writeText(code).catch(() => undefined)
  }

  const reset = (): void => {
    void resetScript()
  }

  const clearScreen = (): void => {
    clearScriptOutput()
  }

  // The commands Monaco is bound to read these at run time, so they never go stale as the options or
  // the history change.
  actionsRef.current = {
    submit: (force) => { void submit(force) },
    recall,
    clearInput,
    selectAll,
    saveText,
    saveCode,
    copyCode,
    toggleWordWrap,
    toggleLineNumbers,
    reset,
    clearScreen,
  }
  const showContextMenu = (event: React.MouseEvent): void => {
    // The menu belongs to the editor, not to the tool bar; the log and the input box are its one text view.
    if (!(event.target as HTMLElement).closest('.script-log, .script-input'))
      return
    event.preventDefault()
    const editor = editorRef.current
    const inputSelection = editor?.getSelection()
    const hasSelection = (!!inputSelection && !inputSelection.isEmpty()) || selectedLogCode() !== undefined
    const items: PopupMenuEntry[] = [
      menuItem('reset', t('Reset'), reset, { icon: 'Restart' }),
      { type: 'divider', key: 'divider-copy' },
      menuItem('cut', t('Cut'), canCut(), { icon: 'Cut', shortcut: 'Ctrl+X' }),
      menuItem('copy', t('Copy'), canCopyAction(), { icon: 'Copy', shortcut: 'Ctrl+C' }),
      menuItem('copy-code', t('Copy Code'), hasSelection ? copyCode : undefined, { icon: 'CopyItem', shortcut: 'Ctrl+Shift+C', disabled: !hasSelection }),
      menuItem('paste', t('Paste'), paste, { icon: 'Paste', shortcut: 'Ctrl+V' }),
      { type: 'divider', key: 'divider-save' },
      menuItem('save', t('Save'), saveText, { icon: 'Save', shortcut: 'Ctrl+S' }),
      menuItem('save-code', t('Save Code...'), saveCode, { shortcut: 'Ctrl+Shift+S' }),
      { type: 'divider', key: 'divider-clear' },
      menuItem('clear', t('Clear Screen'), clearScreen, { icon: 'ClearWindowContent', shortcut: 'Ctrl+L' }),
      { type: 'divider', key: 'divider-settings' },
      menuItem('line-numbers', t('Show Line Numbers'), toggleLineNumbers, { checked: showLineNumbers }),
      menuItem('word-wrap', t('Word Wrap'), toggleWordWrap, { checked: wordWrap, icon: 'WordWrap', shortcut: 'Ctrl+E, Ctrl+W' }),
    ]
    showPopupMenu({
      anchor: { x: event.clientX, y: event.clientY },
      returnFocusTo: editor?.getDomNode() ?? undefined,
      title: t('C# Interactive'),
      items,
      onClose: () => undefined,
    })
  }

  const inputSelectionText = (): string | undefined => {
    const editor = editorRef.current
    const selection = editor?.getSelection()
    const model = editor?.getModel()
    return editor && model && selection && !selection.isEmpty() ? model.getValueInRange(selection) : undefined
  }

  // Monaco's clipboard actions (editor.action.clipboardCopyAction and friends) are not registered in this
  // build, so the menu goes through the clipboard API. The shortcuts themselves are Monaco's own.
  const replaceInputSelection = (text: string): void => {
    const editor = editorRef.current
    const selection = editor?.getSelection()
    const model = editor?.getModel()
    if (!editor || !model || !selection)
      return
    editor.executeEdits('csharp-interactive', [{ range: selection, text, forceMoveMarkers: true }])
    editor.focus()
  }

  const canCut = (): (() => void) | undefined => {
    const text = inputSelectionText()
    return text === undefined ? undefined : () => { void navigator.clipboard.writeText(text).then(() => replaceInputSelection('')).catch(() => undefined) }
  }

  const canCopyAction = (): (() => void) | undefined => {
    const text = inputSelectionText()
    if (text !== undefined)
      return () => { void navigator.clipboard.writeText(text).catch(() => undefined) }
    const browserSelection = window.getSelection()
    if (browserSelection && !browserSelection.isCollapsed && browserSelection.toString().length > 0)
      return () => { void navigator.clipboard.writeText(browserSelection.toString()).catch(() => undefined) }
    return undefined
  }

  const paste = (): void => {
    void navigator.clipboard.readText().then((text) => replaceInputSelection(text)).catch(() => undefined)
  }

  const lines = scriptLines(entries)

  return (
    <div className="script-pane" data-running={String(running)} onContextMenu={showContextMenu}>
      {/* ScriptControl.xaml's tool bar: Reset, Clear Screen, History Previous/Next, Save and Word Wrap, with
          the tooltips (and their shortcuts) the WPF view model builds. */}
      <div className="script-toolbar">
        {/* Deliberately live while a submission runs: rebuilding the session is how a script that
            never returns is stopped, which is what the upstream Reset command is for. */}
        <button className="icon-button" title={t('Reset')} aria-label={t('Reset')} onClick={reset}>
          <DsIcon name="Restart" />
        </button>
        <button className="icon-button" title={`${t('Clear Screen')} (Ctrl+L)`} aria-label={t('Clear Screen')} onClick={clearScreen}>
          <DsIcon name="ClearWindowContent" />
        </button>
        <button className="icon-button" title={`${t('History Previous')} (Alt+Up Arrow)`} aria-label={t('History Previous')} onClick={() => recall(-1, false)} disabled={running || history.length === 0}>
          <DsIcon name="MoveUp" />
        </button>
        <button className="icon-button" title={`${t('History Next')} (Alt+Down Arrow)`} aria-label={t('History Next')} onClick={() => recall(1, false)} disabled={running || history.length === 0}>
          <DsIcon name="DownloadNoColor" />
        </button>
        <span className="script-toolbar-separator" />
        <button className="icon-button" title={`${t('Save')} (Ctrl+S)`} aria-label={t('Save')} onClick={saveText}>
          <DsIcon name="Save" />
        </button>
        <button className="icon-button" title={`${t('Toggle Word Wrap')} (Ctrl+E, Ctrl+W)`} aria-label={t('Toggle Word Wrap')} aria-pressed={wordWrap} onClick={toggleWordWrap}>
          <DsIcon name="WordWrap" />
        </button>
      </div>
      <div className="script-log output-pane" role="log" ref={logRef} tabIndex={-1} style={{ fontFamily: font.fontFamily, fontSize: `${font.fontSize}px` }}>
        {lines.map((line, index) => (
          <div
            key={index}
            className={`script-entry script-${line.kind}`}
            data-code={line.code}
          >
            {line.parts.map((part, partIndex) => part.colors
              ? <ClassifiedText key={partIndex} text={part.text} spans={part.colors} />
              : part.color
                ? <span key={partIndex} className={`tc-${part.color}`}>{part.text}</span>
                : <span key={partIndex}>{part.text}</span>)}
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
            // Enter and Ctrl+Enter submit; Shift+Enter falls through to Monaco's newline. Alt+Up/Down and
            // Ctrl+Alt+Up/Down are claimed from Monaco's own word-move bindings, which the REPL overrides too.
            editor.addCommand(monaco.KeyCode.Enter, () => { void actionsRef.current.submit(false) })
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => { void actionsRef.current.submit(true) })
            editor.addCommand(monaco.KeyCode.Escape, () => actionsRef.current.clearInput())
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyA, () => actionsRef.current.selectAll())
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => actionsRef.current.clearScreen())
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.UpArrow, () => actionsRef.current.recall(-1, true))
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.DownArrow, () => actionsRef.current.recall(1, true))
            editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.UpArrow, () => actionsRef.current.recall(-1, false))
            editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.DownArrow, () => actionsRef.current.recall(1, false))
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => actionsRef.current.saveText())
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, () => actionsRef.current.saveCode())
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyC, () => actionsRef.current.copyCode())
            editor.addCommand(monaco.KeyMod.chord(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW), () => actionsRef.current.toggleWordWrap())
            // The input is colored the way the WPF window's RoslynClassifier colors it while it is typed:
            // compiled as the session's next submission, in dnSpy's theme colors.
            classifierRef.current?.dispose()
            classifierRef.current = attachClassifier(monaco, editor, (code) => window.dnSpy.classifyScript(code))
          }}
          options={{
            readOnly: running,
            automaticLayout: true,
            minimap: { enabled: false },
            lineNumbers: showLineNumbers ? 'on' : 'off',
            glyphMargin: repl.advanced.glyphMargin,
            mouseWheelZoom: repl.advanced.mouseWheelZoom,
            folding: false,
            scrollBeyondLastLine: false,
            renderLineHighlight: repl.general.highlightCurrentLine ? 'line' : 'none',
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            wordWrap: wordWrap ? 'on' : 'off',
            scrollbar: {
              vertical: repl.scrollBars.verticalScrollBar ? 'auto' : 'hidden',
              horizontal: repl.scrollBars.horizontalScrollBar ? 'auto' : 'hidden',
            },
            contextmenu: false,
            // dnSpy's REPL editor has no C# editor features: no brace or quote completion, no suggestions,
            // and no automatic indentation. Monaco's C# language turns them on by default, which changes the
            // text that is typed (and its caret) from what the WPF window keeps.
            autoClosingBrackets: 'never',
            autoClosingQuotes: 'never',
            autoClosingOvertype: 'never',
            autoSurround: 'never',
            autoIndent: 'none',
            quickSuggestions: false,
            suggestOnTriggerCharacters: false,
            wordBasedSuggestions: 'off',
            acceptSuggestionOnEnter: 'off',
            fontFamily: font.fontFamily,
            fontSize: font.fontSize,
            // dnSpy's "Don't add extra line spacing" decides between the tight and the roomy line box.
            lineHeight: Math.round(font.fontSize * (repl.advanced.minimumLineSpacing ? 1.2 : 1.5)),
            tabSize: repl.tabs.tabSize,
            insertSpaces: repl.tabs.convertTabsToSpaces,
            padding: { top: 6, bottom: 6 },
          }}
        />
      </div>
      {ask && (
        <div className="script-ask-overlay" role="presentation">
          <form
            className="script-ask"
            role="dialog"
            aria-modal="true"
            aria-label={ask.title ?? ask.label}
            onSubmit={(event) => {
              event.preventDefault()
              void window.dnSpy.respondScriptAsk(ask.id, askText)
              setAsk(undefined)
            }}
          >
            <div className="script-ask-label">{ask.label}</div>
            {ask.error && <div className="script-ask-error">{ask.error}</div>}
            <input
              className="script-ask-input"
              autoFocus
              value={askText}
              onChange={(event) => setAskText(event.target.value)}
              aria-label={ask.label}
            />
            <div className="script-ask-buttons">
              <button type="submit">{t('OK')}</button>
              <button
                type="button"
                onClick={() => {
                  void window.dnSpy.respondScriptAsk(ask.id, null)
                  setAsk(undefined)
                }}
              >
                {t('Cancel')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
