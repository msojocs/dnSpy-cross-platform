import { useEffect, useState } from 'react'
import type { ModuleInfoResponse } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'

// The hex editor itself lives in HexEditor.tsx; it is re-exported here because this module is where the
// shell and the tests have always found it.
export { HexView } from './HexEditor'

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
