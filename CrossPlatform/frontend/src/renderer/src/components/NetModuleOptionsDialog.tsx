import { useEffect, useState } from 'react'
import type { TreeNode } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'
import { CLR_VERSIONS } from './AssemblyModuleDialogs'
import { OptionsShell } from './OptionsShell'

interface NetModuleOptionsDialogProps {
  /** The assembly the net module joins — dnSpy's Add New NetModule to Assembly; Create NetModule has none. */
  assemblyNode?: TreeNode
  onClose(): void
}

const GUID = /^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i

/**
 * dnSpy's NetModuleOptionsDlg, which Create NetModule and Add New NetModule to Assembly both open: the module's name,
 * its MVID with a button that makes a new one, and the .NET version it is made for — the assembly's own when it joins
 * one. The window is titled "Create NetModule" either way, as dnSpy's is.
 */
export const NetModuleOptionsDialog = ({ assemblyNode, onClose }: NetModuleOptionsDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const workspaceId = useAppStore((state) => state.workspaceId)
  const createNetModule = useAppStore((state) => state.createNetModule)
  const addNetModule = useAppStore((state) => state.addNetModule)
  const [name, setName] = useState('MyNetModule.netmodule')
  const [mvid, setMvid] = useState<string>(() => crypto.randomUUID())
  const [clrVersion, setClrVersion] = useState('4.0')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()

  useEffect(() => {
    if (!workspaceId || !assemblyNode)
      return
    let cancelled = false
    void window.dnSpy.getNetModuleDefaults(workspaceId, assemblyNode.id)
      .then((defaults) => { if (!cancelled) setClrVersion(defaults.clrVersion) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [workspaceId, assemblyNode])

  const mvidError = GUID.test(mvid.trim()) ? undefined : t('Invalid GUID')
  const content = (
    <div className="options-form">
      <label>{t('Name')}<input aria-label={t('Name')} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Mvid
        <span className="options-inline">
          <input aria-label="Mvid" value={mvid} aria-invalid={mvidError !== undefined} title={mvidError} onChange={(event) => setMvid(event.target.value)} />
          <button type="button" onClick={() => setMvid(crypto.randomUUID())}>{t('New')}</button>
        </span>
      </label>
      <label>{t('.NET Version')}
        <select aria-label={t('.NET Version')} value={clrVersion} onChange={(event) => setClrVersion(event.target.value)}>
          {CLR_VERSIONS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
        </select>
      </label>
    </div>
  )
  return (
    <OptionsShell
      title="Create NetModule"
      hideTabStrip
      className="netmodule-dialog"
      tabs={[{ label: 'Create NetModule', content }]}
      invalid={mvidError !== undefined}
      busy={busy}
      error={failure ?? mvidError}
      onAccept={() => {
        setBusy(true)
        setFailure(undefined)
        const module = { name, mvid: mvid.trim(), clrVersion }
        const done = assemblyNode ? addNetModule(assemblyNode, module) : createNetModule(module.name, module.mvid, module.clrVersion)
        void done.then((created) => {
          setBusy(false)
          if (created)
            onClose()
          else
            setFailure(useAppStore.getState().error)
        })
      }}
      onClose={onClose}
    />
  )
}
