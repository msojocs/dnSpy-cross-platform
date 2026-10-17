import { useEffect, useMemo, useState } from 'react'
import type { DebugProcess } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'
import { CloseGlyph } from './DsGlyphs'
import { DsIcon } from './DsIcon'

export const AttachDialog = ({ onClose }: { onClose(): void }): React.JSX.Element => {
  const [processes, setProcesses] = useState<DebugProcess[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [selectedProcessId, setSelectedProcessId] = useState<number>()
  const attachDebug = useAppStore((state) => state.attachDebug)
  const { t } = useLanguage()
  const refresh = (): void => {
    setLoading(true)
    void window.dnSpy.listDebugProcesses().then(setProcesses).finally(() => setLoading(false))
  }
  useEffect(refresh, [])
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized ? processes.filter((process) => process.name.toLowerCase().includes(normalized) || String(process.processId).includes(normalized)) : processes
  }, [processes, query])

  return (
    <div className="modal-backdrop">
      <div className="modal attach-dialog" role="dialog" aria-modal="true" aria-labelledby="attach-title">
        <div className="modal-title"><span id="attach-title">{t('Attach to Process')}</span><button className="icon-button" aria-label={t('Close')} onClick={onClose}><CloseGlyph /></button></div>
        <div className="attach-filter"><input autoFocus aria-label={t('Filter processes')} placeholder={t('Filter')} value={query} onChange={(event) => setQuery(event.target.value)} /><button className="icon-button" title={t('Refresh')} aria-label={t('Refresh')} onClick={refresh}><DsIcon name="Refresh" className={loading ? 'spin' : undefined} /></button></div>
        <div className="process-list" role="list">
          {filtered.map((process) => (
            <button key={process.processId} className={`process-row${selectedProcessId === process.processId ? ' selected' : ''}`} onClick={() => setSelectedProcessId(process.processId)} onDoubleClick={() => void attachDebug(process.processId).then(onClose)}>
              <span>{process.name}</span><span>{process.processId}</span><span title={process.executablePath}>{process.executablePath}</span>
            </button>
          ))}
        </div>
        <div className="modal-actions"><span className="modal-action-spacer" /><button onClick={onClose}>{t('Cancel')}</button><button className="primary" disabled={selectedProcessId === undefined} onClick={() => { if (selectedProcessId !== undefined) void attachDebug(selectedProcessId).then(onClose) }}>{t('Attach')}</button></div>
      </div>
    </div>
  )
}
