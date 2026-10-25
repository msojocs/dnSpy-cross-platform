import { useEffect, useMemo, useRef, useState } from 'react'
import type { editor as MonacoEditor } from 'monaco-editor'
import { useAppStore } from '../app-store'
import Editor from './CodeEditor'
import { monacoThemeName } from '../monaco'
import { useCategoryFont } from '../fonts'
import { useLanguage } from '../localization'
import { useAppOptions } from './app-options'
import { HexView, type HexByteSource } from './HexEditor'
import { memoryStructures } from '../memory-structures'

const fromBase64 = (data: string): Uint8Array => Uint8Array.from(atob(data), (character) => character.charCodeAt(0))

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * dnSpy's Memory window (MemoryContent): the hex editor over the debuggee's whole address space (the span of
 * HexProcessSimpleBufferStream), with its caret, selection, Go to Offset (an address), Copy Special, Find over the
 * readable memory and in-place edits. A page the process does not map shows as `??`. Its context menu's Process
 * submenu picks which process's memory it shows; it is the current process's otherwise.
 */
export const MemoryPane = ({ windowId = 'memory' }: { windowId?: string }): React.JSX.Element => {
  const { t } = useLanguage()
  const currentSessionId = useAppStore((state) => state.debugSessionId)
  const debugState = useAppStore((state) => state.debugState)
  const sessions = useAppStore((state) => state.debugSessions)
  const generation = useAppStore((state) => state.debugGeneration)
  const appendOutput = useAppStore((state) => state.appendOutput)
  const navigation = useAppStore((state) => state.memoryNavigation)
  const hex = useAppOptions().debugger.useHexadecimal
  const [chosenSession, setChosenSession] = useState<string>()
  // A Show in Memory Window request names the process and the window it belongs to; this pane only
  // switches when it is the one asked for.
  useEffect(() => {
    if (navigation?.window === windowId)
      setChosenSession(navigation.sessionId)
  }, [navigation?.nonce, navigation?.window, windowId])
  const sessionId = chosenSession && sessions.some((entry) => entry.sessionId === chosenSession) ? chosenSession : currentSessionId
  const stopped = sessionId === currentSessionId ? debugState === 'stopped' : sessions.find((entry) => entry.sessionId === sessionId)?.state === 'stopped'
  // The address space of the session's process: 2^32 for a 32-bit process, the user space of a 64-bit one.
  const [space, setSpace] = useState<{ sessionId: string; end: number }>()
  useEffect(() => {
    if (!sessionId || !stopped || space?.sessionId === sessionId)
      return
    let current = true
    void window.dnSpy.getDebugMemorySpace(sessionId).then(
      (response) => { if (current) setSpace({ sessionId, end: response.end }) },
      () => { if (current) setSpace({ sessionId, end: 2 ** 47 }) })
    return () => { current = false }
  }, [sessionId, stopped, space?.sessionId])
  const end = space && space.sessionId === sessionId ? space.end : undefined
  const identity = useMemo(() => ({}), [sessionId, stopped, generation, end])
  const currentIdentity = useRef<object | undefined>(identity)
  currentIdentity.current = identity
  useEffect(() => {
    currentIdentity.current = identity
    return () => { if (currentIdentity.current === identity) currentIdentity.current = undefined }
  }, [identity])

  const source = useMemo<HexByteSource | undefined>(() => {
    if (!sessionId || !stopped || end === undefined)
      return undefined
    const optionalBase64 = (bytes: Uint8Array | undefined): string | null => bytes ? toBase64(bytes) : null
    return {
      length: end,
      base: 0,
      optionsView: 'memoryWindow',
      revision: `${sessionId}:${generation}`,
      structures: memoryStructures(sessionId, 0, () => currentIdentity.current === identity),
      refresh: () => window.dnSpy.refreshDebugMemory(sessionId),
      read: async (offset, count) => {
        const memory = await window.dnSpy.readDebugMemory(sessionId, `0x${offset.toString(16)}`, count)
        return { bytes: fromBase64(memory.data), readable: memory.readable }
      },
      write: async (offset, data) => {
        try {
          await window.dnSpy.writeDebugMemory(sessionId, `0x${offset.toString(16)}`, toBase64(data))
          return true
        } catch (reason) {
          appendOutput(t('Could not write the memory: {message}', { message: reason instanceof Error ? reason.message : String(reason) }), 'debug')
          return false
        }
      },
      validSpan: async (position, bounds, forward, fullSpan) => {
        const span = await window.dnSpy.getDebugMemoryValidSpan(sessionId, position, bounds, forward, fullSpan)
        return span.start === null || span.end === null ? undefined : { start: span.start, end: span.end }
      },
      search: async (pattern, run) => (await window.dnSpy.searchDebugMemory(sessionId, {
        base64Pattern: toBase64(pattern.pattern),
        base64Mask: optionalBase64(pattern.mask),
        base64Alternate: optionalBase64(pattern.alternate),
        charLengths: pattern.charLengths ?? null,
        ...run,
      })).offsets,
      menu: [{
        label: t('Process'),
        submenu: sessions.map((entry) => ({
          label: entry.process ? `[${hex ? `0x${entry.process.id.toString(16).toUpperCase()}` : entry.process.id}]${entry.process.name ? ` ${entry.process.name}` : ''}` : entry.sessionId,
          checked: entry.sessionId === sessionId,
          action: () => { currentIdentity.current = undefined; setChosenSession(entry.sessionId) },
        })),
      }],
    }
  }, [sessionId, stopped, end, generation, identity, sessions, hex, appendOutput, t])

  if (!source)
    return <div className="pane-empty">{!sessionId ? t('Memory can only be read while debugging.') : stopped ? t('Loading...') : t('Memory can only be read while the process is paused.')}</div>
  return (
    <div className="debug-tool-pane memory-pane">
      <HexView key={sessionId} source={source} goto={navigation && navigation.window === windowId && navigation.sessionId === sessionId ? { start: navigation.address, length: navigation.length, nonce: navigation.nonce } : undefined} />
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
  const options = useAppOptions()
  const zoom = options.documentViewer.zoomLevel
  const general = options.documentViewer.general
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
            // The Text Viewer page's General group, the same options every document viewer follows.
            lineNumbers: general.showLineNumbers ? 'on' : 'off',
            wordWrap: general.wordWrap ? 'on' : 'off',
            renderLineHighlight: general.highlightCurrentLine ? 'all' : 'none',
            // dnSpy's document viewer menu: Monaco's own has Copy, Select All and Find.
            contextmenu: true,
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
