import { useEffect, useMemo, useRef, useState } from 'react'
import type * as MonacoEditor from 'monaco-editor'
import type { CompilerLanguage } from '../../../shared/protocol'
import { compilerSettingsFor } from '../app-store'
import { editorCommands } from '../editor-commands'
import { LINE_COMPRESSION_SCALE, SELECTION_MARGIN_WIDTH, isCompressedLine, selectWholeLines } from '../editor-margins'
import { useCategoryFont } from '../fonts'
import { monacoThemeName } from '../monaco'
import { attachRoslynDocument, type RoslynDocument } from '../roslyn-language-service'
import { installVirtualSpace, type VirtualSpaceController } from '../virtual-space'
import { normalizeZoom, zoomIn, zoomOut } from '../zoom'
import { loadAppOptions, saveAppOptions, useAppOptions, type EditorPaneOptions } from './app-options'
import CodeEditor from './CodeEditor'
import { ZoomControl } from './ZoomControl'

let nextEditor = 0

interface RoslynCodeEditorProps {
  language: CompilerLanguage
  /** The text the editor opens with; what is typed after is reported through `onChange`. */
  value: string
  onChange(value: string): void
  /** The dnSpy theme the editor is drawn in. */
  theme: string
  /** The module the code is edited in: the language service compiles against what compiling it does. */
  workspaceId?: string
  nodeId?: string
  onMount?(editor: MonacoEditor.editor.IStandaloneCodeEditor): void
}

/** The options of the Code Editor page for a language, which dnSpy's CodeEditorOptionsDefinitions declares. */
const paneOf = (options: ReturnType<typeof useAppOptions>, language: CompilerLanguage): EditorPaneOptions =>
  options.codeEditor[language === 'visualBasic' ? 'visualBasic' : 'cSharp']

const setPaneGeneral = (language: CompilerLanguage, change: Partial<EditorPaneOptions['general']>): void => {
  const options = loadAppOptions()
  const key = language === 'visualBasic' ? 'visualBasic' : 'cSharp'
  const pane = options.codeEditor[key]
  saveAppOptions({ ...options, codeEditor: { ...options.codeEditor, [key]: { ...pane, general: { ...pane.general, ...change } } } })
}

/**
 * dnSpy's Roslyn code editor — the one RoslynLanguageCompiler creates for the Edit Code window: a C# or Visual Basic
 * document of a Roslyn workspace with the language service's colors, completion, Quick Info, signature help, smart
 * indentation and word navigation, drawn with the Text Editor font and the options of Options › Code Editor › C# or
 * Visual Basic: word wrap, line numbers, the current line, virtual space, the scroll bars, tabs and indentation, the
 * selection and glyph margins, line compression and spacing, and zooming with the wheel, the keys and the zoom box.
 */
export const RoslynCodeEditor = ({ language, value, onChange, theme, workspaceId, nodeId, onMount }: RoslynCodeEditorProps): React.JSX.Element => {
  const options = useAppOptions()
  const pane = paneOf(options, language)
  const { general, scrollBars, tabs, advanced } = pane
  const font = useCategoryFont('textEditor')
  // A code editor's zoom is its own and is not kept, as dnSpy's code editors keep none.
  const [zoom, setZoom] = useState(100)
  const fontSize = Math.max(1, Math.round(font.fontSize * zoom / 100))
  const lineHeight = Math.round(fontSize * (advanced.minimumLineSpacing ? 1.2 : 1.5))
  const [path] = useState(() => `edit-code-${++nextEditor}.${language === 'visualBasic' ? 'vb' : 'cs'}`)
  const editorRef = useRef<MonacoEditor.editor.IStandaloneCodeEditor | undefined>(undefined)
  const documentRef = useRef<RoslynDocument | undefined>(undefined)
  const virtualSpaceRef = useRef<VirtualSpaceController | undefined>(undefined)
  const compressionRef = useRef<MonacoEditor.editor.IEditorDecorationsCollection | undefined>(undefined)
  const [editorReady, setEditorReady] = useState(false)
  // The handlers are bound once; these read the options of the render they act in.
  const paneRef = useRef(pane)
  paneRef.current = pane
  const zoomBy = (step: (current: number) => number): void => setZoom((current) => normalizeZoom(step(current)))
  const zoomByRef = useRef(zoomBy)
  zoomByRef.current = zoomBy

  useEffect(() => () => {
    documentRef.current?.dispose()
    documentRef.current = undefined
  }, [])

  // dnSpy's "Compress blank lines" and "Compress lines that do not have any alphanumeric characters".
  const applyCompression = (): void => {
    const editor = editorRef.current
    const model = editor?.getModel()
    const collection = compressionRef.current
    if (!editor || !model || !collection)
      return
    const current = paneRef.current
    const layout = editor.getLayoutInfo()
    const decorations: MonacoEditor.editor.IModelDeltaDecoration[] = []
    for (let lineNumber = 1; lineNumber <= model.getLineCount(); lineNumber++) {
      const text = model.getLineContent(lineNumber)
      if (!isCompressedLine(text, current.advanced, { wraps: current.general.wordWrap, contentWidth: layout.contentWidth, charWidth: fontSize * 0.6, tabSize: current.tabs.tabSize }))
        continue
      decorations.push({
        range: { startLineNumber: lineNumber, startColumn: 1, endLineNumber: lineNumber, endColumn: model.getLineMaxColumn(lineNumber) },
        options: { lineHeight: LINE_COMPRESSION_SCALE },
      })
    }
    collection.set(decorations)
  }
  const applyCompressionRef = useRef(applyCompression)
  applyCompressionRef.current = applyCompression

  useEffect(() => {
    applyCompressionRef.current()
  }, [advanced.compressEmptyOrWhitespaceLines, advanced.compressNonLetterLines, general.wordWrap, tabs.tabSize, fontSize, editorReady])

  // The tab page's settings are the model's: the tab size, the indent size and whether a tab key types spaces.
  useEffect(() => {
    editorRef.current?.getModel()?.updateOptions({ tabSize: tabs.tabSize, indentSize: tabs.indentSize, insertSpaces: tabs.convertTabsToSpaces })
  }, [tabs.tabSize, tabs.indentSize, tabs.convertTabsToSpaces, editorReady])

  // dnSpy's TextCaret on UseVirtualSpace changing: with the option off (or word wrap on) the caret leaves virtual space.
  useEffect(() => {
    virtualSpaceRef.current?.refresh()
  }, [general.useVirtualSpace, general.wordWrap, editorReady])

  const monacoOptions = useMemo((): MonacoEditor.editor.IStandaloneEditorConstructionOptions => ({
    automaticLayout: true,
    // The suggest list, the hover and the parameter hints may reach past the window the editor is in.
    fixedOverflowWidgets: true,
    minimap: { enabled: false },
    lineNumbers: general.showLineNumbers ? 'on' : 'off',
    // dnSpy's SpacerMargin comes before the text; Monaco draws it in the line-decorations strip.
    lineDecorationsWidth: advanced.selectionMargin ? SELECTION_MARGIN_WIDTH : 0,
    selectOnLineNumbers: true,
    glyphMargin: advanced.glyphMargin,
    // Ctrl+wheel is the editor's own zoom (below), which the Mouse wheel zoom option switches.
    mouseWheelZoom: false,
    folding: false,
    renderLineHighlight: general.highlightCurrentLine ? 'line' : 'none',
    wordWrap: general.wordWrap ? 'on' : 'off',
    scrollbar: {
      vertical: scrollBars.verticalScrollBar ? 'auto' : 'hidden',
      horizontal: scrollBars.horizontalScrollBar ? 'auto' : 'hidden',
    },
    scrollBeyondLastLine: false,
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    // dnSpy's code editor completes no braces or quotes and matches no braces; indentation is Roslyn's smart
    // indent (an on-type format of the new line), the previous line's when Roslyn has none.
    autoClosingBrackets: 'never',
    autoClosingQuotes: 'never',
    autoClosingOvertype: 'never',
    autoSurround: 'never',
    autoIndent: 'keep',
    matchBrackets: 'never',
    detectIndentation: false,
    tabSize: tabs.tabSize,
    insertSpaces: tabs.convertTabsToSpaces,
    contextmenu: false,
    fontFamily: font.fontFamily,
    fontSize,
    lineHeight,
  }), [general.showLineNumbers, general.highlightCurrentLine, general.wordWrap, advanced.selectionMargin, advanced.glyphMargin, scrollBars.verticalScrollBar, scrollBars.horizontalScrollBar, tabs.tabSize, tabs.convertTabsToSpaces, font.fontFamily, fontSize, lineHeight])

  const showZoomControl = advanced.zoomControl && scrollBars.horizontalScrollBar

  return (
    <div
      className="roslyn-code-editor"
      data-selection-margin={advanced.selectionMargin ? 'true' : undefined}
      onWheelCapture={(event) => {
        if (!event.ctrlKey || event.deltaY === 0)
          return
        // The editor's text zooms itself; the window's zoom must not take the wheel.
        event.preventDefault()
        event.stopPropagation()
        if (paneRef.current.advanced.mouseWheelZoom)
          zoomBy((current) => event.deltaY < 0 ? zoomIn(current) : zoomOut(current))
      }}
    >
      <div className="roslyn-code-editor-text">
        <CodeEditor
          path={path}
          language={language === 'visualBasic' ? 'vb' : 'csharp'}
          theme={monacoThemeName(theme)}
          // The text is the editor's own once it opens: handing every change back as the value lets a render
          // that lags behind fast typing put an older text back over what was typed since.
          defaultValue={value}
          onChange={(text) => onChange(text ?? '')}
          options={monacoOptions}
          onMount={(editor, monaco) => {
            editorRef.current = editor
            compressionRef.current = editor.createDecorationsCollection()
            editor.getModel()?.updateOptions({ tabSize: paneRef.current.tabs.tabSize, indentSize: paneRef.current.tabs.indentSize, insertSpaces: paneRef.current.tabs.convertTabsToSpaces })
            documentRef.current?.dispose()
            documentRef.current = attachRoslynDocument(monaco, editor, {
              language,
              workspaceId,
              nodeId,
              // The Compiler page's settings, which the Compile button compiles with too.
              settings: compilerSettingsFor(language),
            })
            const addCommand = editorCommands(editor)
            // dnSpy's text editor zoom keys: Ctrl+Shift+. Ctrl+= and Ctrl+NumPad+ in, their opposites out, Ctrl+0 back to 100%.
            for (const key of [monaco.KeyMod.Shift | monaco.KeyCode.Period, monaco.KeyCode.Equal, monaco.KeyCode.NumpadAdd])
              addCommand(monaco.KeyMod.CtrlCmd | key, () => zoomByRef.current(zoomIn))
            for (const key of [monaco.KeyMod.Shift | monaco.KeyCode.Comma, monaco.KeyCode.Minus, monaco.KeyCode.NumpadSubtract])
              addCommand(monaco.KeyMod.CtrlCmd | key, () => zoomByRef.current(zoomOut))
            for (const key of [monaco.KeyCode.Digit0, monaco.KeyCode.Numpad0])
              addCommand(monaco.KeyMod.CtrlCmd | key, () => zoomByRef.current(() => 100))
            // Ctrl+E W and Ctrl+E Ctrl+W switch word wrap, and the Code Editor page with it.
            const toggleWordWrap = (): void => setPaneGeneral(language, { wordWrap: !paneRef.current.general.wordWrap })
            addCommand(monaco.KeyMod.chord(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, monaco.KeyCode.KeyW), toggleWordWrap)
            addCommand(monaco.KeyMod.chord(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW), toggleWordWrap)
            // dnSpy's SpacerMargin: with the selection margin on, a press in the blank strip before the text selects
            // whole lines, and the drag that follows extends them line by line.
            let marginDrag: { anchor: number } | undefined
            editor.onMouseDown((event) => {
              marginDrag = undefined
              if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS || !paneRef.current.advanced.selectionMargin)
                return
              const line = event.target.position?.lineNumber ?? 0
              if (line <= 0)
                return
              const selection = editor.getSelection()
              const anchor = event.event.shiftKey && selection ? selection.selectionStartLineNumber : line
              marginDrag = { anchor }
              selectWholeLines(editor, anchor, line)
              editor.focus()
            })
            editor.onMouseMove((event) => {
              if (!marginDrag)
                return
              const line = event.target.position?.lineNumber
              if (line !== undefined && line > 0)
                selectWholeLines(editor, marginDrag.anchor, line)
            })
            editor.onMouseUp(() => { marginDrag = undefined })
            editor.onDidChangeModelContent(() => applyCompressionRef.current())
            editor.onDidLayoutChange(() => applyCompressionRef.current())
            // dnSpy's virtual space, with text typed in it landing where the caret is drawn.
            const virtualSpace = installVirtualSpace(
              editor,
              monaco,
              () => paneRef.current.general.useVirtualSpace && !paneRef.current.general.wordWrap,
              () => undefined,
            )
            virtualSpaceRef.current = virtualSpace
            editor.onDidDispose(() => {
              virtualSpace.dispose()
              if (virtualSpaceRef.current === virtualSpace)
                virtualSpaceRef.current = undefined
            })
            setEditorReady(true)
            onMount?.(editor)
          }}
        />
      </div>
      {showZoomControl && <ZoomControl className="code-editor-zoom-control" listId={`${path}-zoom-levels`} zoom={zoom} onZoom={(level) => setZoom(level)} />}
    </div>
  )
}
