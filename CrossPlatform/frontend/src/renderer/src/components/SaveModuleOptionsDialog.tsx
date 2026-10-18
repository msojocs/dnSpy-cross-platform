import { useState } from 'react'
import type { SaveModuleOptions } from '../../../shared/protocol'
import { useLanguage } from '../localization'
import { OptionsShell } from './OptionsShell'

/** What dnlib writes with when the window has not been opened: dnSpy's own defaults. */
export const defaultSaveModuleOptions = (): SaveModuleOptions => ({
  preserveRids: false,
  preserveUsOffsets: false,
  preserveStringsOffsets: false,
  preserveBlobOffsets: false,
  keepWin32Resources: true,
  shareMethodBodies: false,
  addCheckSum: false,
  addMvidSection: false,
  writePdb: false,
  keepExtraPeData: true,
  mixedMode: false,
  moduleKind: undefined,
})

const CHECKBOXES: { key: Exclude<keyof SaveModuleOptions, 'moduleKind'>; label: string }[] = [
  { key: 'preserveRids', label: 'Preserve RIDs' },
  { key: 'preserveUsOffsets', label: 'Preserve #US offsets' },
  { key: 'preserveStringsOffsets', label: 'Preserve #Strings offsets' },
  { key: 'preserveBlobOffsets', label: 'Preserve #Blob offsets' },
  { key: 'keepWin32Resources', label: 'Keep Win32 resources' },
  { key: 'shareMethodBodies', label: 'Share method bodies' },
  { key: 'addCheckSum', label: 'Add checksum' },
  { key: 'addMvidSection', label: 'Add MVID section' },
  { key: 'writePdb', label: 'Write PDB' },
  { key: 'keepExtraPeData', label: 'Keep extra PE data' },
  { key: 'mixedMode', label: 'Use the native writer (mixed-mode module)' },
]

const MODULE_KINDS = [
  { value: '', label: 'Keep the module kind' },
  { value: '0', label: 'Console' },
  { value: '1', label: 'Windows' },
  { value: '2', label: 'Dll' },
  { value: '3', label: 'NetModule' },
] as const

interface SaveModuleOptionsDialogProps {
  initial?: SaveModuleOptions
  onAccept(options: SaveModuleOptions): void
  onClose(): void
}

/**
 * dnSpy's `SaveModuleOptionsDlg`: the writer options a module is saved with. The window is shown before
 * the Save As picker, the way dnSpy shows it from the Save Multi Module window.
 */
export const SaveModuleOptionsDialog = ({ initial, onAccept, onClose }: SaveModuleOptionsDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [options, setOptions] = useState<SaveModuleOptions>(initial ?? defaultSaveModuleOptions())
  const content = (
    <div className="options-form">
      <fieldset className="il-flags">
        <legend>{t('Writer options')}</legend>
        {CHECKBOXES.map((entry) => (
          <label key={entry.key}>
            <input
              type="checkbox"
              checked={options[entry.key]}
              onChange={(event) => setOptions((current) => ({ ...current, [entry.key]: event.target.checked }))}
            />
            {t(entry.label)}
          </label>
        ))}
      </fieldset>
      <label>{t('Module type')}
        <select
          aria-label={t('Module type')}
          value={options.moduleKind === undefined ? '' : String(options.moduleKind)}
          onChange={(event) => setOptions((current) => ({ ...current, moduleKind: event.target.value === '' ? undefined : Number(event.target.value) }))}
        >
          {MODULE_KINDS.map((entry) => <option key={entry.label} value={entry.value}>{t(entry.label)}</option>)}
        </select>
      </label>
    </div>
  )
  return (
    <OptionsShell
      title="Save Module"
      className="save-options-dialog"
      hideTabStrip
      tabs={[{ label: 'Save', content }]}
      onAccept={() => onAccept(options)}
      onClose={onClose}
      onReset={() => setOptions(defaultSaveModuleOptions())}
    />
  )
}
