import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import type { ModuleInfoResponse } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'
import { useCategoryFont } from '../fonts'

const pageSize = 4096

export const HexView = ({ moduleId }: { moduleId: string }): React.JSX.Element => {
  const hexFont = useCategoryFont('hexEditor')
  const workspaceId = useAppStore((state) => state.workspaceId)
  // Every edit bumps the state id, and a byte patch is an edit like any other, so the page is read
  // again after one — which is what makes an undo show up here.
  const workspaceStateId = useAppStore((state) => state.workspaceStateId)
  const navigation = useAppStore((state) => state.hexNavigation)
  const [length, setLength] = useState(0)
  const [offset, setOffset] = useState(0)
  const [bytes, setBytes] = useState<Uint8Array>(new Uint8Array())
  /** The bytes a "Show ... in Hex Editor" command pointed at, marked wherever they are on screen. */
  const [highlight, setHighlight] = useState<{ start: number; end: number }>()
  const [loading, setLoading] = useState(false)
  const { locale, t } = useLanguage()

  useEffect(() => {
    if (!workspaceId) return
    void window.dnSpy.getHexLength(workspaceId, moduleId).then((response) => setLength(response.length))
  }, [workspaceId, moduleId])

  // A hex command names the module it wants, and this tab is only the one to answer when the names
  // match — another module's tab stays where it was.
  useEffect(() => {
    if (!navigation || navigation.moduleId !== moduleId) return
    setOffset(Math.floor(navigation.offset / pageSize) * pageSize)
    setHighlight({ start: navigation.offset, end: navigation.offset + Math.max(navigation.length, 1) })
  }, [navigation, moduleId])

  useEffect(() => {
    if (!workspaceId) return
    let canceled = false
    setLoading(true)
    void window.dnSpy.readHex(workspaceId, moduleId, offset, pageSize).then((response) => {
      if (canceled) return
      const binary = atob(response.base64Data)
      setBytes(Uint8Array.from(binary, (character) => character.charCodeAt(0)))
    }).finally(() => { if (!canceled) setLoading(false) })
    return () => { canceled = true }
  }, [workspaceId, moduleId, offset, workspaceStateId])

  const rows = useMemo(() => {
    const result: { address: string; cells: { text: string; marked: boolean }[]; ascii: string }[] = []
    for (let row = 0; row < bytes.length; row += 16) {
      const cells = []
      let ascii = ''
      for (let column = 0; column < 16; column++) {
        const index = row + column
        if (index >= bytes.length)
          break
        const value = bytes[index]
        // The separator lives with its byte so marking one byte leaves the dump's spacing intact.
        cells.push({ text: value.toString(16).toUpperCase().padStart(2, '0') + (column === 15 ? '' : ' '), marked: highlight !== undefined && offset + index >= highlight.start && offset + index < highlight.end })
        ascii += value >= 32 && value <= 126 ? String.fromCharCode(value) : '.'
      }
      result.push({ address: (offset + row).toString(16).toUpperCase().padStart(8, '0'), cells, ascii: ascii.padEnd(16, ' ') })
    }
    return result
  }, [bytes, offset, highlight])

  return (
    <div className="special-document">
      <div className="document-toolbar hex-toolbar">
        <button className="icon-button" title={t('Previous page')} aria-label={t('Previous page')} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}><ChevronLeft size={15} /></button>
        <button className="icon-button" title={t('Next page')} aria-label={t('Next page')} disabled={offset + pageSize >= length} onClick={() => setOffset(offset + pageSize)}><ChevronRight size={15} /></button>
        <label>{t('Offset')} <input value={`0x${offset.toString(16).toUpperCase()}`} onChange={(event) => {
          const parsed = Number.parseInt(event.target.value.replace(/^0x/i, ''), 16)
          if (Number.isFinite(parsed) && parsed >= 0 && parsed < length)
            setOffset(Math.floor(parsed / pageSize) * pageSize)
        }} /></label>
        <span>{offset.toLocaleString(locale)} / {length.toLocaleString(locale)}</span>
        {loading && <RefreshCw className="spin" size={14} />}
      </div>
      {/* The Hex Editor category of Environment › Font, in the theme in use. */}
      <div className="hex-content" style={{ fontFamily: hexFont.fontFamily, fontSize: hexFont.fontSize }}>
        {rows.map((row) => (
          <div className="hex-line" key={row.address}>
            <span className="hex-address">{row.address}</span>{'  '}
            {row.cells.map((cell, column) => <span className={cell.marked ? 'hex-byte hex-byte-marked' : 'hex-byte'} key={column}>{cell.text}</span>)}
            {'  |'}<span className="hex-ascii">{row.ascii}</span>{'|'}
          </div>
        ))}
      </div>
    </div>
  )
}

export const ModuleInfoView = ({ moduleId }: { moduleId: string }): React.JSX.Element => {
  const workspaceId = useAppStore((state) => state.workspaceId)
  const [info, setInfo] = useState<ModuleInfoResponse>()
  const { locale, t } = useLanguage()

  useEffect(() => {
    if (workspaceId)
      void window.dnSpy.getModuleInfo(workspaceId, moduleId).then(setInfo)
  }, [workspaceId, moduleId])

  if (!info)
    return <div className="loading-state">{t('Loading')}</div>

  return (
    <div className="module-info-view">
      <dl>
        <dt>{t('Name')}</dt><dd>{info.name}</dd>
        <dt>{t('Path')}</dt><dd>{info.path}</dd>
        <dt>{t('Runtime')}</dt><dd>{info.runtimeVersion}</dd>
        <dt>{t('Architecture')}</dt><dd>{info.architecture}</dd>
        <dt>{t('Kind')}</dt><dd>{info.moduleKind}</dd>
        <dt>MVID</dt><dd>{info.mvid}</dd>
        <dt>{t('Entry point')}</dt><dd>{info.entryPoint ?? t('None')}</dd>
        <dt>{t('Types')}</dt><dd>{info.typeCount.toLocaleString(locale)}</dd>
        <dt>{t('Resources')}</dt><dd>{info.resourceCount.toLocaleString(locale)}</dd>
      </dl>
      <h3>{t('Assembly References')}</h3>
      <ul>{info.assemblyReferences.map((reference) => <li key={reference}>{reference}</li>)}</ul>
      <h3>{t('PE Headers')}</h3>
      <dl>{Object.entries(info.peHeaders).map(([name, value]) => <div className="definition-row" key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
      <h3>{t('Metadata Tables')}</h3>
      <div className="metadata-table-list" role="table" aria-label={t('Metadata Tables')}>
        <div className="metadata-table-header">{t('Table')}</div><div className="metadata-table-header">{t('Rows')}</div>
        {Object.entries(info.metadataTables).map(([name, rows]) => <div className="metadata-table-row" role="row" key={name}><span>{name}</span><span>{rows.toLocaleString(locale)}</span></div>)}
      </div>
    </div>
  )
}
