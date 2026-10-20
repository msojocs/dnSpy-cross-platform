import { useEffect, useMemo, useRef, useState } from 'react'
import type { editor as MonacoEditor } from 'monaco-editor'
import { useAppStore } from '../app-store'
import Editor from './CodeEditor'
import { monacoThemeName } from '../monaco'
import { useCategoryFont } from '../fonts'
import { useLanguage } from '../localization'
import { useAppOptions } from './app-options'
import { HexView, type HexByteSource } from './HexEditor'

/**
 * How much of the address space the Memory window's hex view spans at a time: a scroll range the view can draw.
 * Scrolling or moving the caret to its edge, or going to an address outside it, moves the window there.
 */
const MEMORY_WINDOW = 16 * 1024 * 1024
/** Where the user address space ends: 48 bits on x64 and ARM64. */
const ADDRESS_SPACE_END = 2 ** 48
/** The window starts on a chunk boundary, which keeps the pages the hex view reads aligned. */
const WINDOW_ALIGNMENT = 64 * 1024

const windowBaseFor = (address: number): number =>
  Math.max(0, Math.floor((address - MEMORY_WINDOW / 2) / WINDOW_ALIGNMENT) * WINDOW_ALIGNMENT)

const fromBase64 = (data: string): Uint8Array => Uint8Array.from(atob(data), (character) => character.charCodeAt(0))

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * dnSpy's Memory window (MemoryContent): the hex editor over the debuggee's memory, with its caret, selection, Go to
 * Offset (an address), Copy Special, Find and in-place edits. A page the process does not map shows as `??`. Its
 * context menu's Process submenu picks which process's memory it shows; it is the current process's otherwise.
 */
export const MemoryPane = (): React.JSX.Element => {
  const { t } = useLanguage()
  const currentSessionId = useAppStore((state) => state.debugSessionId)
  const debugState = useAppStore((state) => state.debugState)
  const sessions = useAppStore((state) => state.debugSessions)
  const generation = useAppStore((state) => state.debugGeneration)
  const appendOutput = useAppStore((state) => state.appendOutput)
  const hex = useAppOptions().debugger.useHexadecimal
  const [chosenSession, setChosenSession] = useState<string>()
  const [base, setBase] = useState(0)
  const sessionId = chosenSession && sessions.some((entry) => entry.sessionId === chosenSession) ? chosenSession : currentSessionId
  const stopped = sessionId === currentSessionId ? debugState === 'stopped' : sessions.find((entry) => entry.sessionId === sessionId)?.state === 'stopped'

  const source = useMemo<HexByteSource | undefined>(() => {
    if (!sessionId || !stopped)
      return undefined
    return {
      length: MEMORY_WINDOW,
      base,
      end: ADDRESS_SPACE_END,
      optionsView: 'memoryWindow',
      revision: `${sessionId}:${generation}`,
      read: async (offset, count) => {
        const memory = await window.dnSpy.readDebugMemory(sessionId, `0x${(base + offset).toString(16)}`, count)
        return { bytes: fromBase64(memory.data), readable: memory.readable }
      },
      write: async (offset, data) => {
        try {
          await window.dnSpy.writeDebugMemory(sessionId, `0x${(base + offset).toString(16)}`, toBase64(data))
          return true
        } catch (reason) {
          appendOutput(t('Could not write the memory: {message}', { message: reason instanceof Error ? reason.message : String(reason) }), 'debug')
          return false
        }
      },
      reveal: (address) => {
        const next = windowBaseFor(address)
        setBase(next)
        return address - next
      },
      menu: [{
        label: t('Process'),
        submenu: sessions.map((entry) => ({
          label: entry.process ? `[${hex ? `0x${entry.process.id.toString(16).toUpperCase()}` : entry.process.id}]${entry.process.name ? ` ${entry.process.name}` : ''}` : entry.sessionId,
          checked: entry.sessionId === sessionId,
          action: () => setChosenSession(entry.sessionId),
        })),
      }],
    }
  }, [sessionId, stopped, base, generation, sessions, hex, appendOutput, t])

  if (!source)
    return <div className="pane-empty">{sessionId ? t('Memory can only be read while the process is paused.') : t('Memory can only be read while debugging.')}</div>
  return (
    <div className="debug-tool-pane memory-pane">
      <HexView source={source} />
    </div>
  )
}

/**
 * dnSpy's Disassembly tab (DisassemblyDocumentTabContent): a read-only text view of a method's native code as it was
 * when the tab was asked for — the dialect and style of the Disassembler options, the IL and the decompiled
 * statements as comments — in the theme's assembly colours. Like dnSpy's document viewer it selects, copies and
 * finds; it is a snapshot, so it keeps what it showed when the process moves on.
 */
export const DisassemblyDocumentView = ({ id, theme, transparentBackground }: { id: string; theme: string; transparentBackground: boolean }): React.JSX.Element => {
  const { t } = useLanguage()
  const document = useAppStore((state) => state.disassemblyDocuments[id])
  const font = useCategoryFont('textEditor')
  const zoom = useAppOptions().documentViewer.zoomLevel
  const decorationsRef = useRef<MonacoEditor.IEditorDecorationsCollection | undefined>(undefined)
  const { text, decorations } = useMemo(() => {
    const lines: string[] = []
    const ranges: MonacoEditor.IModelDeltaDecoration[] = []
    document?.lines.forEach((parts, index) => {
      let column = 1
      let line = ''
      for (const part of parts) {
        if (part.text.length > 0 && part.color)
          ranges.push({ range: { startLineNumber: index + 1, startColumn: column, endLineNumber: index + 1, endColumn: column + part.text.length }, options: { inlineClassName: `tc-${part.color}` } })
        line += part.text
        column += part.text.length
      }
      lines.push(line)
    })
    return { text: lines.join('\n'), decorations: ranges }
  }, [document])
  useEffect(() => {
    decorationsRef.current?.set(decorations)
  }, [decorations])
  if (!document)
    return <div className="pane-empty">{t('Document closed')}</div>
  const fontSize = Math.max(1, Math.round(font.fontSize * zoom) / 100)
  return (
    <div className="document-view disassembly-document" role="document" aria-label={t('Disassembly')}>
      <div className="editor-host">
        <Editor
          path={`${id}.asm`}
          value={text}
          language="plaintext"
          theme={monacoThemeName(theme, transparentBackground)}
          onMount={(editor) => {
            decorationsRef.current = editor.createDecorationsCollection(decorations)
          }}
          options={{
            readOnly: true,
            domReadOnly: true,
            minimap: { enabled: false },
            glyphMargin: false,
            folding: false,
            lineNumbers: 'off',
            contextmenu: false,
            renderLineHighlight: 'none',
            scrollBeyondLastLine: false,
            fontFamily: font.fontFamily,
            fontSize,
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  )
}
