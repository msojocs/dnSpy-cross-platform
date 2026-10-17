import { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { DebugDisassembly, DebugDisassemblyOptions } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useCategoryFont } from '../fonts'
import { useLanguage } from '../localization'
import { useAppOptions } from './app-options'
import { ColoredText } from './ColoredText'
import { DsIcon } from './DsIcon'

/** How many bytes the Memory window reads around the address it shows. */
const MEMORY_SPAN = 4096
const BYTES_PER_LINE = 16

const toHex = (value: bigint, width = 16): string => value.toString(16).toUpperCase().padStart(width, '0')

const parseAddress = (text: string): bigint | undefined => {
  const trimmed = text.trim().replace(/_/g, '')
  if (!trimmed) return undefined
  try {
    if (/^0x[0-9a-f]+$/i.test(trimmed)) return BigInt(trimmed)
    if (/^[0-9a-f]+h$/i.test(trimmed)) return BigInt(`0x${trimmed.slice(0, -1)}`)
    if (/^\d+$/.test(trimmed)) return BigInt(trimmed)
    if (/^[0-9a-f]+$/i.test(trimmed)) return BigInt(`0x${trimmed}`)
  } catch {
    return undefined
  }
  return undefined
}

const fromBase64 = (data: string): Uint8Array => Uint8Array.from(atob(data), (character) => character.charCodeAt(0))

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))

/**
 * dnSpy's Memory window: the debuggee's bytes from an address the user types — a number, or an expression whose
 * value is one — with the bytes edited in place. A page the process does not map shows as `??`, as dnSpy's
 * hex view does for memory it cannot read.
 */
export const MemoryPane = (): React.JSX.Element => {
  const { t } = useLanguage()
  const hexFont = useCategoryFont('hexEditor')
  const options = useAppOptions().hexEditor.memoryWindow.general
  const sessionId = useAppStore((state) => state.debugSessionId)
  const debugState = useAppStore((state) => state.debugState)
  const generation = useAppStore((state) => state.debugGeneration)
  const frameId = useAppStore((state) => state.activeDebugFrameId)
  const [addressText, setAddressText] = useState('')
  const [address, setAddress] = useState<bigint>()
  const [bytes, setBytes] = useState<Uint8Array>(new Uint8Array())
  const [readable, setReadable] = useState<boolean[]>([])
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState<{ index: number; text: string }>()
  const [revision, setRevision] = useState(0)
  const stopped = debugState === 'stopped'
  const valueCase = (text: string): string => options.valuesLowerCaseHex ? text.toLowerCase() : text
  const offsetCase = (text: string): string => options.offsetLowerCaseHex ? text.toLowerCase() : text

  // The window shows the line the address is on, from the start of the line.
  const start = address === undefined ? undefined : address - (address % BigInt(BYTES_PER_LINE))

  useEffect(() => {
    if (!sessionId || start === undefined || !stopped) return
    let current = true
    setLoading(true)
    window.dnSpy.readDebugMemory(sessionId, `0x${start.toString(16)}`, MEMORY_SPAN).then((memory) => {
      if (!current) return
      setBytes(fromBase64(memory.data))
      setReadable(memory.readable)
      setError(undefined)
    }, (reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [sessionId, start, stopped, generation, revision])

  const go = async (): Promise<void> => {
    const parsed = parseAddress(addressText)
    if (parsed !== undefined) {
      setAddress(parsed)
      return
    }
    // An expression: its value is the address, as dnSpy's Memory window reads `&x` or a pointer.
    if (!sessionId || frameId === undefined || !addressText.trim()) return
    try {
      const value = await window.dnSpy.evaluateDebugExpression(sessionId, frameId, `${addressText.trim()}, d`)
      const number = parseAddress(value.value.replace(/^\(.*\)\s*/, ''))
      if (value.isError || number === undefined)
        setError(value.isError ? value.value : t('The expression\'s value is not an address.'))
      else
        setAddress(number)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const isReadable = (index: number): boolean => {
    if (start === undefined) return false
    const firstPage = start - (start % 4096n)
    const page = Number((start + BigInt(index) - firstPage) / 4096n)
    return readable[page] === true
  }

  const commitEdit = async (): Promise<void> => {
    if (!editing || !sessionId || start === undefined) return
    const { index, text } = editing
    setEditing(undefined)
    const value = Number.parseInt(text, 16)
    if (!/^[0-9a-f]{1,2}$/i.test(text) || !Number.isFinite(value) || value === bytes[index]) return
    try {
      await window.dnSpy.writeDebugMemory(sessionId, `0x${(start + BigInt(index)).toString(16)}`, toBase64(Uint8Array.of(value)))
      setRevision((current) => current + 1)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const lines = useMemo(() => {
    if (start === undefined) return []
    const result: { address: string; offset: number }[] = []
    for (let offset = 0; offset < bytes.length; offset += BYTES_PER_LINE)
      result.push({ address: offsetCase(toHex(start + BigInt(offset))), offset })
    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, bytes, options.offsetLowerCaseHex])

  const group = Math.max(1, options.groupSizeInBytes || 1)

  return (
    <div className="debug-tool-pane memory-pane">
      <div className="debug-input-row">
        <label htmlFor="memory-address">{t('Address:')}</label>
        <input
          id="memory-address"
          aria-label={t('Address')}
          value={addressText}
          disabled={!stopped}
          placeholder="0x0000000000000000"
          onChange={(event) => setAddressText(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void go() }}
        />
        <button className="icon-button" title={t('Refresh')} aria-label={t('Refresh')} disabled={!stopped || address === undefined} onClick={() => setRevision((current) => current + 1)}>
          {loading ? <RefreshCw className="spin" size={14} /> : <DsIcon name="Refresh" />}
        </button>
        {error ? <span className="bookmarks-status debug-error-text">{error}</span> : null}
      </div>
      <div className="hex-content memory-content" role="grid" aria-label={t('Memory')} style={{ fontFamily: hexFont.fontFamily, fontSize: hexFont.fontSize }}>
        {!stopped ? <div className="pane-empty">{t('Memory can only be read while the process is paused.')}</div> : null}
        {stopped && lines.map((line) => (
          <div className="hex-line" role="row" key={line.address}>
            <span className="hex-address">{line.address}</span>{'  '}
            {Array.from({ length: BYTES_PER_LINE }, (_, column) => {
              const index = line.offset + column
              const separator = column === BYTES_PER_LINE - 1 ? '' : group > 1 && (column + 1) % group === 0 ? '  ' : ' '
              if (editing?.index === index) {
                return (
                  <input
                    key={column}
                    className="hex-byte-editor"
                    autoFocus
                    maxLength={2}
                    value={editing.text}
                    aria-label={t('Byte')}
                    onChange={(event) => setEditing({ index, text: event.target.value })}
                    onBlur={() => void commitEdit()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void commitEdit()
                      else if (event.key === 'Escape') setEditing(undefined)
                    }}
                  />
                )
              }
              const known = isReadable(index)
              return (
                <span
                  className="hex-byte"
                  key={column}
                  onDoubleClick={() => { if (known) setEditing({ index, text: bytes[index].toString(16).padStart(2, '0') }) }}
                >
                  {known ? valueCase(bytes[index].toString(16).toUpperCase().padStart(2, '0')) : '??'}{separator}
                </span>
              )
            })}
            {'  '}
            <span className="hex-ascii">
              {Array.from({ length: BYTES_PER_LINE }, (_, column) => {
                const index = line.offset + column
                if (!isReadable(index)) return '?'
                const value = bytes[index]
                return value >= 32 && value <= 126 ? String.fromCharCode(value) : '.'
              }).join('')}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * dnSpy's Disassembly view of the active frame: the method's native code in the dialect and style of the
 * Disassembler options, the IL and the decompiled statements as comments, and the instruction the frame is at
 * marked with the current-statement arrow.
 */
export const DisassemblyPane = (): React.JSX.Element => {
  const { t } = useLanguage()
  const font = useCategoryFont('textEditor')
  const appOptions = useAppOptions()
  const sessionId = useAppStore((state) => state.debugSessionId)
  const frameId = useAppStore((state) => state.activeDebugFrameId)
  const debugState = useAppStore((state) => state.debugState)
  const generation = useAppStore((state) => state.debugGeneration)
  const [result, setResult] = useState<DebugDisassembly>()
  const [error, setError] = useState<string>()
  const currentRef = useRef<HTMLDivElement>(null)
  const options = useMemo((): DebugDisassemblyOptions => {
    const settings = appOptions.disassembler
    return {
      syntax: settings.syntax,
      showInstructionAddress: settings.showInstructionAddress,
      showInstructionBytes: settings.showInstructionBytes,
      showILCode: settings.showILCode,
      showCode: settings.showCode,
      emptyLineBetweenBasicBlocks: settings.emptyLineBetweenBasicBlocks,
      addLabels: settings.addLabels,
      codeStyle: { ...appOptions.disassemblerCodeStyle[settings.syntax] },
    }
  }, [appOptions.disassembler, appOptions.disassemblerCodeStyle])

  useEffect(() => {
    if (!sessionId || frameId === undefined || debugState !== 'stopped') {
      setResult(undefined)
      setError(undefined)
      return
    }
    let current = true
    window.dnSpy.disassembleDebugFrame(sessionId, { frameId }, options).then((disassembly) => {
      if (!current) return
      setResult(disassembly)
      setError(undefined)
    }, (reason: unknown) => {
      if (!current) return
      setResult(undefined)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { current = false }
  }, [sessionId, frameId, debugState, generation, options])

  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'center' })
  }, [result])

  if (debugState !== 'stopped')
    return <div className="pane-empty">{t('The disassembly is shown while the process is paused.')}</div>
  if (error)
    return <div className="pane-empty debug-error-text">{error}</div>
  if (!result)
    return <div className="pane-empty"><RefreshCw className="spin" size={14} /></div>
  return (
    <div className="disassembly-pane" role="document" aria-label={t('Disassembly')} style={{ fontFamily: font.fontFamily, fontSize: font.fontSize }}>
      <div className="disassembly-title">{result.title}</div>
      {result.lines.map((line, index) => (
        <div
          key={index}
          ref={index === result.currentLine ? currentRef : undefined}
          className={`disassembly-line${index === result.currentLine ? ' disassembly-current' : ''}`}
        >
          <span className="disassembly-glyph">{index === result.currentLine ? <DsIcon name="CurrentInstructionPointer" size={12} /> : null}</span>
          <span className="disassembly-text"><ColoredText parts={line} /></span>
        </div>
      ))}
    </div>
  )
}
