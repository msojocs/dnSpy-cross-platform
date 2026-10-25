import { useEffect, useMemo, useRef, useState } from 'react'
import Editor from './CodeEditor'
import type { editor as MonacoEditor } from 'monaco-editor'
import { showPopupMenu, type PopupMenuEntry } from 'flexlayout-react'
import type { ScriptAskRequest } from '../../../shared/protocol'
import { scriptCodeText, scriptLines, scriptLineNumbers, scriptText, type ScriptLine } from '../script-lines'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'
import { monacoThemeName } from '../monaco'
import { attachClassifier, type Classifier } from '../roslyn-classification'
import { useCategoryFont } from '../fonts'
import { LINE_COMPRESSION_SCALE, SELECTION_MARGIN_WIDTH, isCompressedLine, selectWholeLines } from '../editor-margins'
import { normalizeZoom, zoomIn, zoomLevels, zoomOut } from '../zoom'
import { useAppOptions, saveAppOptions, type AppOptions } from './app-options'
import { setReplCSharpZoom } from './repl-options'
import { ClassifiedText } from './ColoredText'
import { DsIcon, MenuEntryIcon } from './DsIcon'

/** The `#`-commands the window answers itself, which Enter runs whatever the syntax looks like. */
const SCRIPT_COMMANDS = new Set(['clear', 'cls', 'help', 'reset'])

const isScriptCommand = (code: string): boolean => {
  // dnSpy's UnpackScriptCommand trims the leading whitespace before it looks for the prefix.
  const input = code.trimStart()
  return input.startsWith('#') && SCRIPT_COMMANDS.has(input.slice(1).trimStart().split(/\s+/)[0] ?? '')
}

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

/** dnSpy's ZoomControl box: the zoom as "100 %", which typing a number and Enter changes. */
const ScriptZoomControl = ({ zoom, onZoom }: { zoom: number; onZoom(value: number): void }): React.JSX.Element => {
  const { t } = useLanguage()
  const [text, setText] = useState(`${zoom} %`)
  useEffect(() => setText(`${zoom} %`), [zoom])
  const apply = (): void => {
    const value = Number.parseFloat(text.replace('%', '').trim())
    if (Number.isFinite(value) && value >= zoomLevels[0] && value <= zoomLevels[zoomLevels.length - 1])
      onZoom(normalizeZoom(value))
    else
      setText(`${zoom} %`)
  }
  return (
    <div className="script-zoom-control">
      <input
        aria-label={t('Zoom')}
        list="script-zoom-levels"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => setText(`${zoom} %`)}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') {
            event.preventDefault()
            apply()
          }
          else if (event.key === 'Escape') {
            event.preventDefault()
            setText(`${zoom} %`)
          }
        }}
      />
      <datalist id="script-zoom-levels">
        {[...zoomLevels].reverse().map((level) => <option key={level} value={`${level} %`} />)}
      </datalist>
    </div>
  )
}

/** The text a log line draws, prompts included, which decides whether it is compressed. */
const lineText = (line: ScriptLine): string => line.parts.map((part) => part.text).join('')

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
  const advanced = repl.advanced
  const zoom = repl.zoomLevel
  // The REPL's ZoomLevel scales its text, not the tool bar around it; the log and the input box are the
  // window's one text view, split into two because they are edited differently.
  const editorFontSize = Math.max(1, Math.round(font.fontSize * zoom / 100))
  const lineHeight = Math.round(editorFontSize * (advanced.minimumLineSpacing ? 1.2 : 1.5))
  const entries = useAppStore((state) => state.scriptEntries)
  const running = useAppStore((state) => state.scriptRunning)
  const history = useAppStore((state) => state.scriptHistory)
  const startScript = useAppStore((state) => state.startScript)
  const evaluateScript = useAppStore((state) => state.evaluateScript)
  const resetScript = useAppStore((state) => state.resetScript)
  const clearScriptOutput = useAppStore((state) => state.clearScriptOutput)
  const { t } = useLanguage()

  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | undefined>(undefined)
  const monacoRef = useRef<Parameters<NonNullable<React.ComponentProps<typeof Editor>['onMount']>>[1] | undefined>(undefined)
  const logRef = useRef<HTMLDivElement | null>(null)
  const classifierRef = useRef<Classifier | undefined>(undefined)
  const compressionRef = useRef<MonacoEditor.IEditorDecorationsCollection | undefined>(undefined)
  const [editorReady, setEditorReady] = useState(false)
  const [logWidth, setLogWidth] = useState(0)
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
  // The editor handlers are bound once; these read the options of the render they act in.
  const optionsRef = useRef(repl)
  optionsRef.current = repl

  const [ask, setAsk] = useState<ScriptAskRequest | undefined>(undefined)
  const [askText, setAskText] = useState('')

  const setReplGeneral = (change: Partial<AppOptions['repl']['cSharp']['general']>): void => {
    saveAppOptions({ ...options, repl: { ...options.repl, cSharp: { ...repl, general: { ...repl.general, ...change } } } })
  }

  const toggleWordWrap = (): void => {
    const value = !wordWrap
    setReplGeneral({ wordWrap: value })
    editorRef.current?.updateOptions({ wordWrap: value ? 'on' : 'off' })
  }

  const toggleLineNumbers = (): void => {
    const value = !showLineNumbers
    setReplGeneral({ showLineNumbers: value })
    editorRef.current?.updateOptions({ lineNumbers: value ? 'on' : 'off' })
  }

  /** The width of a character in the log's font, for the line compressor's "does this line wrap" test. */
  const charWidth = useMemo(() => {
    if (typeof document === 'undefined')
      return editorFontSize * 0.6
    const context = document.createElement('canvas').getContext('2d')
    if (!context)
      return editorFontSize * 0.6
    context.font = `${editorFontSize}px ${font.fontFamily}`
    return context.measureText('0').width || editorFontSize * 0.6
  }, [editorFontSize, font.fontFamily])

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

  // The compressor needs the room the log gives a line, which changes when the window is resized.
  useEffect(() => {
    const log = logRef.current
    if (!log || typeof ResizeObserver === 'undefined')
      return
    const observer = new ResizeObserver((records) => {
      const width = records[records.length - 1]?.contentRect.width
      if (width !== undefined)
        setLogWidth(width)
    })
    observer.observe(log)
    setLogWidth(log.clientWidth)
    return () => observer.disconnect()
  }, [])

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
  // A recall sets the input itself, which must not count as the user changing the search text.
  const applyingHistory = useRef(false)

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
          applyingHistory.current = true
          editor.setValue(history[index])
          applyingHistory.current = false
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
          applyingHistory.current = true
          editor.setValue(history[index])
          applyingHistory.current = false
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
    // dnSpy's Ctrl+Enter is Submit(): it goes to the end of the input and clears the selection before it
    // submits, so it works wherever the caret happens to be.
    if (force) {
      const end = model.getPositionAt(model.getValueLength())
      editor.setPosition(end)
      editor.setSelection({ startLineNumber: end.lineNumber, startColumn: end.column, endLineNumber: end.lineNumber, endColumn: end.column })
      editor.revealPositionInCenterIfOutsideViewport(end)
    }
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
    historySearch.current = undefined
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

  /** The line the caret is on, with its line break: dnSpy's CutOrCopyBlankLineIfNoSelection copies it when
   * nothing is selected. */
  const currentInputLine = (): string | undefined => {
    const editor = editorRef.current
    const model = editor?.getModel()
    const position = editor?.getPosition()
    if (!editor || !model || !position)
      return undefined
    return model.getLineContent(position.lineNumber) + (position.lineNumber < model.getLineCount() ? model.getEOL() : '')
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

  /** Ctrl+C in the input: the selection, or else the whole current line, as dnSpy's standard Copy does. */
  const copyInput = (): void => {
    const text = selectedCode() ?? currentInputLine()
    if (text !== undefined)
      void navigator.clipboard.writeText(text).catch(() => undefined)
  }

  const reset = (): void => {
    // dnSpy's Reset closes the input along with the session (`ReplEditor.Reset`), so a half-typed
    // submission does not survive into the engine that replaces it.
    clearInput()
    void resetScript()
  }

  const clearScreen = (): void => {
    // ClearScreen adds a new document: the log and the line being typed both go.
    clearScriptOutput()
    clearInput()
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
    const text = selectedCode()
    if (text !== undefined)
      return () => { void navigator.clipboard.writeText(text).catch(() => undefined) }
    // dnSpy's standard Copy copies the caret's line when nothing is selected; the REPL is one text view, so
    // the input box's current line is that line.
    const line = currentInputLine()
    return line === undefined ? undefined : () => { void navigator.clipboard.writeText(line).catch(() => undefined) }
  }

  const paste = (): void => {
    void navigator.clipboard.readText().then((text) => replaceInputSelection(text)).catch(() => undefined)
  }

  // -- The log's line numbers, compression and selection margin --------------------------------

  const lines = scriptLines(entries)
  const numbers = scriptLineNumbers(lines)
  const maxDigits = numbers.reduce((digits, number) => Math.max(digits, String(number.lineNumber).length), 1)
  const numberWidth = showLineNumbers ? Math.ceil(maxDigits * charWidth) + 8 : 0
  const compressionLayout = {
    wraps: wordWrap,
    contentWidth: Math.max(0, logWidth - numberWidth - (advanced.selectionMargin ? SELECTION_MARGIN_WIDTH : 0)),
    charWidth,
    tabSize: repl.tabs.tabSize,
  }
  const logSelectRef = useRef<{ anchor: number } | undefined>(undefined)
  const inputMarginDragRef = useRef<{ anchor: number } | undefined>(undefined)

  const lineIndexOfNode = (node: Node | null | undefined): number | undefined => {
    const element = node instanceof Element ? node : node?.parentElement ?? null
    const row = element?.closest<HTMLElement>('.script-line')
    if (!row || !logRef.current?.contains(row))
      return undefined
    const index = Number(row.dataset.lineIndex)
    return Number.isFinite(index) ? index : undefined
  }

  const selectLogLines = (from: number, to: number): void => {
    const log = logRef.current
    if (!log)
      return
    const contents = [...log.querySelectorAll<HTMLElement>('.script-line-content')]
    const start = contents[Math.min(from, to)]
    const end = contents[Math.max(from, to)]
    const selection = window.getSelection()
    if (!start || !end || !selection)
      return
    const range = document.createRange()
    range.setStart(start, 0)
    range.setEnd(end, end.childNodes.length)
    selection.removeAllRanges()
    selection.addRange(range)
    log.focus()
  }

  const onLogMouseDown = (event: React.MouseEvent): void => {
    if (!(event.target as HTMLElement).closest('.script-selection-margin'))
      return
    event.preventDefault()
    const line = lineIndexOfNode(event.target as Node)
    if (line === undefined)
      return
    // dnSpy's SelectLine: a plain press starts at this line, Shift extends from the selection's start.
    let anchor = line
    if (event.shiftKey) {
      const selection = window.getSelection()
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined
      anchor = (range ? lineIndexOfNode(range.startContainer) : undefined) ?? logSelectRef.current?.anchor ?? line
    }
    logSelectRef.current = { anchor }
    selectLogLines(anchor, line)
  }

  const onLogMouseMove = (event: React.MouseEvent): void => {
    const drag = logSelectRef.current
    if (!drag || event.buttons !== 1)
      return
    const line = lineIndexOfNode(document.elementFromPoint(event.clientX, event.clientY))
    if (line !== undefined)
      selectLogLines(drag.anchor, line)
  }

  useEffect(() => {
    const release = (): void => {
      logSelectRef.current = undefined
      inputMarginDragRef.current = undefined
    }
    window.addEventListener('mouseup', release)
    return () => window.removeEventListener('mouseup', release)
  }, [])

  // -- The input box's margins and compression ------------------------------------------------

  /** dnSpy's "Compress blank lines" and "Compress lines that do not have any alphanumeric characters", for
   * the input box, the way DocumentView draws them. */
  const applyInputCompression = (): void => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    const model = editor?.getModel()
    const collection = compressionRef.current
    if (!editor || !monaco || !model || !collection)
      return
    const current = optionsRef.current
    const layout = editor.getLayoutInfo()
    const fontInfo = editor.getOption(monaco.editor.EditorOption.fontInfo)
    const modelOptions = model.getOptions()
    const decorations: MonacoEditor.IModelDeltaDecoration[] = []
    for (let lineNumber = 1; lineNumber <= model.getLineCount(); lineNumber++) {
      const text = model.getLineContent(lineNumber)
      if (!isCompressedLine(text, current.advanced, {
        wraps: editor.getOption(monaco.editor.EditorOption.wordWrap) !== 'off',
        contentWidth: layout.contentWidth,
        charWidth: fontInfo.typicalHalfwidthCharacterWidth || editorFontSize * 0.6,
        tabSize: modelOptions.tabSize,
      }))
        continue
      decorations.push({
        range: { startLineNumber: lineNumber, startColumn: 1, endLineNumber: lineNumber, endColumn: model.getLineMaxColumn(lineNumber) },
        options: { lineHeight: LINE_COMPRESSION_SCALE },
      })
    }
    collection.set(decorations)
  }
  const applyInputCompressionRef = useRef(applyInputCompression)
  applyInputCompressionRef.current = applyInputCompression

  useEffect(() => {
    applyInputCompressionRef.current()
  }, [advanced.compressEmptyOrWhitespaceLines, advanced.compressNonLetterLines, wordWrap, repl.tabs.tabSize, editorFontSize, editorReady])

  /** Ctrl+wheel and the zoom keys zoom the REPL's text, as dnSpy's Zoomable text view does. The wheel's own
   * handler is what checks the Mouse wheel zoom option; the zoom keys work whether it is on or off. */
  const zoomBy = (step: (current: number) => number): void => setReplCSharpZoom(step)

  const onLogKeyDown = (event: React.KeyboardEvent): void => {
    // The keys dnSpy's REPL handles whichever part of its text view has the focus.
    if (event.key === 'Escape') {
      event.preventDefault()
      clearInput()
      return
    }
    if (event.ctrlKey && event.key === 'Enter') {
      // dnSpy's Submit() moves to the end of the input, so Ctrl+Enter submits even from the log.
      event.preventDefault()
      event.stopPropagation()
      void submit(true)
      return
    }
    if (!event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const direction = event.key === 'ArrowUp' ? -1 : 1
      if (event.altKey && !event.ctrlKey) {
        event.preventDefault()
        event.stopPropagation()
        recall(direction, false)
        return
      }
      if (event.altKey && event.ctrlKey) {
        event.preventDefault()
        event.stopPropagation()
        recall(direction, true)
        return
      }
    }
    if (!event.ctrlKey || event.altKey)
      return
    const code = event.code
    if (code === 'Equal' || code === 'NumpadAdd' || (event.shiftKey && code === 'Period')) {
      event.preventDefault()
      event.stopPropagation()
      zoomBy(zoomIn)
    }
    else if (code === 'Minus' || code === 'NumpadSubtract' || (event.shiftKey && code === 'Comma')) {
      event.preventDefault()
      event.stopPropagation()
      zoomBy(zoomOut)
    }
    else if ((code === 'Digit0' || code === 'Numpad0') && !event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      setReplCSharpZoom(() => 100)
    }
    else if (code === 'KeyL' && !event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      clearScreen()
    }
    else if (code === 'KeyS') {
      event.preventDefault()
      event.stopPropagation()
      if (event.shiftKey)
        saveCode()
      else
        saveText()
    }
    else if (code === 'KeyC' && event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      copyCode()
    }
    else if (code === 'KeyA' && !event.shiftKey) {
      // SelectAll in the log selects what the window shows there; the input box has its own Ctrl+A.
      const log = logRef.current
      const selection = window.getSelection()
      if (!log || !selection)
        return
      event.preventDefault()
      event.stopPropagation()
      const range = document.createRange()
      range.selectNodeContents(log)
      selection.removeAllRanges()
      selection.addRange(range)
    }
  }

  const logClassName = [
    'script-log output-pane',
    repl.scrollBars.verticalScrollBar ? '' : 'script-no-vertical-scrollbar',
    repl.scrollBars.horizontalScrollBar ? '' : 'script-no-horizontal-scrollbar',
  ].filter(Boolean).join(' ')

  return (
    <div
      className="script-pane"
      data-running={String(running)}
      onContextMenu={showContextMenu}
      onWheelCapture={(event) => {
        if (!event.ctrlKey || event.deltaY === 0)
          return
        // The pane's text zooms itself; the window's tab zoom must not take the wheel.
        event.preventDefault()
        event.stopPropagation()
        if (optionsRef.current.advanced.mouseWheelZoom)
          setReplCSharpZoom((current) => event.deltaY < 0 ? zoomIn(current) : zoomOut(current))
      }}
    >
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
        {/* dnSpy's ZoomControl sits in the text view's bottom margin; here it is at the end of the tool bar,
            the row the window already has above its text. */}
        {advanced.zoomControl && <ScriptZoomControl zoom={zoom} onZoom={(value) => setReplCSharpZoom(() => value)} />}
      </div>
      <div
        className={logClassName}
        role="log"
        ref={logRef}
        tabIndex={-1}
        data-wrap={wordWrap ? 'true' : 'false'}
        data-line-numbers={showLineNumbers ? 'true' : 'false'}
        data-selection-margin={advanced.selectionMargin ? 'true' : undefined}
        style={{
          fontFamily: font.fontFamily,
          fontSize: `${editorFontSize}px`,
          lineHeight: `${lineHeight}px`,
          tabSize: repl.tabs.tabSize,
        }}
        onMouseDown={onLogMouseDown}
        onMouseMove={onLogMouseMove}
        onKeyDown={onLogKeyDown}
      >
        {lines.map((line, index) => {
          const number = numbers[index]
          const compressed = isCompressedLine(lineText(line), advanced, compressionLayout)
          const columns = `${showLineNumbers ? 'auto ' : ''}${advanced.selectionMargin ? `${SELECTION_MARGIN_WIDTH}px ` : ''}${wordWrap ? 'minmax(0, 1fr)' : 'max-content'}`
          return (
            <div
              key={index}
              className={`script-entry script-line script-${line.kind} script-number-${number.color}`}
              data-code={line.code}
              data-line-index={index}
              data-line-number={number.lineNumber}
              style={{ gridTemplateColumns: columns, lineHeight: compressed ? `${Math.round(lineHeight * LINE_COMPRESSION_SCALE)}px` : undefined }}
            >
              {advanced.selectionMargin && <span className="script-selection-margin" aria-hidden="true" />}
              <span className="script-line-content">
                {line.parts.map((part, partIndex) => part.colors
                  ? <span key={partIndex} className={part.color ? `tc-${part.color}` : undefined}><ClassifiedText text={part.text} spans={part.colors} /></span>
                  : part.color
                    ? <span key={partIndex} className={`tc-${part.color}`}>{part.text}</span>
                    : <span key={partIndex}>{part.text}</span>)}
              </span>
            </div>
          )
        })}
      </div>
      <div className="script-input code-colors">
        <Editor
          path="csharp-interactive.csx"
          language="csharp"
          defaultValue=""
          theme={monacoThemeName(theme, transparentBackground)}
          onMount={(editor, monaco) => {
            editorRef.current = editor
            monacoRef.current = monaco
            compressionRef.current = editor.createDecorationsCollection()
            setEditorReady(true)
            // Enter and Ctrl+Enter submit; Shift+Enter falls through to Monaco's newline. Alt+Up/Down and
            // Ctrl+Alt+Up/Down are claimed from Monaco's own word-move bindings, which the REPL overrides too.
            editor.addCommand(monaco.KeyCode.Enter, () => { void actionsRef.current.submit(false) })
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => { void actionsRef.current.submit(true) })
            editor.addCommand(monaco.KeyCode.Escape, () => actionsRef.current.clearInput())
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyA, () => actionsRef.current.selectAll())
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => actionsRef.current.clearScreen())
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC, copyInput)
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.UpArrow, () => actionsRef.current.recall(-1, true))
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.DownArrow, () => actionsRef.current.recall(1, true))
            editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.UpArrow, () => actionsRef.current.recall(-1, false))
            editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.DownArrow, () => actionsRef.current.recall(1, false))
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => actionsRef.current.saveText())
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, () => actionsRef.current.saveCode())
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyC, () => actionsRef.current.copyCode())
            editor.addCommand(monaco.KeyMod.chord(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW), () => actionsRef.current.toggleWordWrap())
            // dnSpy's text editor zoom keys: Ctrl+Shift+. Ctrl+= and Ctrl+NumPad+ in, their opposites out,
            // Ctrl+0 back to 100%.
            for (const key of [monaco.KeyMod.Shift | monaco.KeyCode.Period, monaco.KeyCode.Equal, monaco.KeyCode.NumpadAdd])
              editor.addCommand(monaco.KeyMod.CtrlCmd | key, () => zoomBy(zoomIn))
            for (const key of [monaco.KeyMod.Shift | monaco.KeyCode.Comma, monaco.KeyCode.Minus, monaco.KeyCode.NumpadSubtract])
              editor.addCommand(monaco.KeyMod.CtrlCmd | key, () => zoomBy(zoomOut))
            for (const key of [monaco.KeyCode.Digit0, monaco.KeyCode.Numpad0])
              editor.addCommand(monaco.KeyMod.CtrlCmd | key, () => setReplCSharpZoom(() => 100))
            // A user edit invalidates the text a same-text history search was looking for.
            editor.onDidChangeModelContent(() => {
              if (!applyingHistory.current)
                historySearch.current = undefined
              applyInputCompressionRef.current()
            })
            editor.onDidLayoutChange(() => applyInputCompressionRef.current())
            editor.onDidChangeConfiguration(() => applyInputCompressionRef.current())
            // dnSpy's SpacerMargin: with the selection margin on, a press in the blank strip before the line
            // numbers selects whole lines, and the drag that follows extends them line by line.
            editor.onMouseDown((event) => {
              inputMarginDragRef.current = undefined
              if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS || !optionsRef.current.advanced.selectionMargin)
                return
              const line = event.target.position?.lineNumber ?? 0
              if (line <= 0)
                return
              const selection = editor.getSelection()
              const anchor = event.event.shiftKey && selection ? selection.selectionStartLineNumber : line
              inputMarginDragRef.current = { anchor }
              selectWholeLines(editor, anchor, line)
              editor.focus()
            })
            editor.onMouseMove((event) => {
              const drag = inputMarginDragRef.current
              if (!drag)
                return
              const browserEvent = event.event.browserEvent
              const editorNode = editor.getDomNode()
              const rect = editorNode?.getBoundingClientRect()
              let line = editor.getTargetAtClientPoint(browserEvent.clientX, browserEvent.clientY)?.position?.lineNumber
              if (rect && (browserEvent.clientY < rect.top || browserEvent.clientY > rect.bottom)) {
                const height = editor.getOption(monaco.editor.EditorOption.lineHeight)
                editor.setScrollTop(editor.getScrollTop() + (browserEvent.clientY < rect.top ? -height : height))
                line = editor.getTargetAtClientPoint(browserEvent.clientX, browserEvent.clientY)?.position?.lineNumber
              }
              if (line !== undefined && line > 0)
                selectWholeLines(editor, drag.anchor, line)
            })
            editor.onMouseUp(() => { inputMarginDragRef.current = undefined })
            applyInputCompressionRef.current()
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
            // dnSpy's SpacerMargin comes before the text; Monaco draws it in the line-decorations strip,
            // and its line numbers select their line whether or not the margin is shown.
            lineDecorationsWidth: advanced.selectionMargin ? SELECTION_MARGIN_WIDTH : 0,
            selectOnLineNumbers: true,
            glyphMargin: advanced.glyphMargin,
            mouseWheelZoom: advanced.mouseWheelZoom,
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
            fontSize: editorFontSize,
            lineHeight,
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
