import { useLanguage } from '../localization'
import { useDsImageClass } from '../ds-image'
import type { DecompilerLanguage } from '../../../shared/protocol'

interface ToolBarProps {
  hasWorkspace: boolean
  busy: boolean
  onOpen(): void
  onSaveAll(): void
  onSearch(): void
  fullScreen: boolean
  onToggleFullScreen(): void
  canGoBack: boolean
  canGoForward: boolean
  onBack(): void
  onForward(): void
  canUndo: boolean
  canRedo: boolean
  onUndo(): void
  onRedo(): void
  decompilerLanguage?: DecompilerLanguage
  onLanguageChange(language: DecompilerLanguage): void
  debugAvailable: boolean
  debugState: 'inactive' | 'starting' | 'running' | 'stopped'
  onStart(): void
  onContinue(): void
  onPause(): void
  onRestart(): void
  onShowNextStatement(): void
  onStepInto(): void
  onStepOver(): void
  onStepOut(): void
  onStop(): void
}

/** One of dnSpy's own images, drawn by the stylesheet its images share (ds-image.ts). */
const DsButton = ({ name, label, disabled, onClick }: { name: string; label: string; disabled?: boolean; onClick?: () => void }): React.JSX.Element => {
  const imageClass = useDsImageClass(name)
  return (
    <button className="icon-button toolbar-button" title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      <span className={`toolbar-ds-icon${imageClass ? ` ${imageClass}` : ''}`} />
    </button>
  )
}

export const ToolBar = ({ hasWorkspace, busy, onOpen, onSaveAll, onSearch, fullScreen, onToggleFullScreen, canGoBack, canGoForward, onBack, onForward, canUndo, canRedo, onUndo, onRedo, decompilerLanguage, onLanguageChange, debugAvailable, debugState, onStart, onContinue, onPause, onRestart, onShowNextStatement, onStepInto, onStepOver, onStepOut, onStop }: ToolBarProps): React.JSX.Element => {
  const { t } = useLanguage()
  const fullScreenImage = useDsImageClass('AutoSizeOptimize')
  const debugging = debugState !== 'inactive'
  // dnSpy's own toolbar, in the order its groups give it: the file commands, the navigation, the language the
  // decompiler writes in, the edit history, the debugger, the search window and, last, full screen. Every
  // icon is one of dnSpy's own images (ToolBarCommands and the debugger's tool bar).
  return (
    <div className="tool-bar" role="toolbar" aria-label={t('Main toolbar')}>
      <DsButton name="OpenFolder" label={t('Open Assembly')} onClick={onOpen} />
      <DsButton name="SaveAll" label={t('Save All')} disabled={!hasWorkspace} onClick={onSaveAll} />
      <span className="toolbar-separator" />
      <DsButton name="Backwards" label={t('Back')} disabled={!canGoBack} onClick={onBack} />
      <DsButton name="Forwards" label={t('Forward')} disabled={!canGoForward} onClick={onForward} />
      <span className="toolbar-separator" />
      {decompilerLanguage && <select className="toolbar-language-select" aria-label={t('Decompiler language')} value={decompilerLanguage} onChange={(event) => onLanguageChange(event.target.value as DecompilerLanguage)}>
        <option value="cSharp">C#</option>
        <option value="visualBasic">Visual Basic</option>
        <option value="il">IL</option>
        <option value="ilWithCSharp">IL with C#</option>
      </select>}
      <DsButton name="Undo" label={t('Undo')} disabled={!canUndo} onClick={onUndo} />
      <DsButton name="Redo" label={t('Redo')} disabled={!canRedo} onClick={onRedo} />
      <span className="toolbar-separator" />
      <DsButton name="Run" label={debugState === 'stopped' ? t('Continue') : t('Debug a Program')} disabled={!debugAvailable || (debugState !== 'inactive' && debugState !== 'stopped')} onClick={debugState === 'stopped' ? onContinue : onStart} />
      {debugging && <>
        <DsButton name="Pause" label={t('Pause')} disabled={debugState !== 'running'} onClick={onPause} />
        <DsButton name="Stop" label={t('Stop')} disabled={debugState === 'starting'} onClick={onStop} />
        <DsButton name="Restart" label={t('Restart')} disabled={debugState === 'starting'} onClick={onRestart} />
        <span className="toolbar-separator" />
        <DsButton name="GoToNext" label={t('Show Next Statement')} disabled={debugState !== 'stopped'} onClick={onShowNextStatement} />
        <DsButton name="StepInto" label={t('Step Into')} disabled={debugState !== 'stopped'} onClick={onStepInto} />
        <DsButton name="StepOver" label={t('Step Over')} disabled={debugState !== 'stopped'} onClick={onStepOver} />
        <DsButton name="StepOut" label={t('Step Out')} disabled={debugState !== 'stopped'} onClick={onStepOut} />
      </>}
      <span className="toolbar-separator" />
      <DsButton name="Search" label={t('Search')} disabled={!hasWorkspace} onClick={onSearch} />
      <span className="toolbar-spacer" />
      {busy && <span className="toolbar-busy">{t('Working')}</span>}
      {/* The last group dnSpy's toolbar has: the Full Screen toggle. */}
      <button className="icon-button toolbar-button" title={t('Full Screen')} aria-label={t('Full Screen')} aria-pressed={fullScreen} onClick={onToggleFullScreen}>
        <span className={`toolbar-ds-icon${fullScreenImage ? ` ${fullScreenImage}` : ''}${fullScreen ? ' toolbar-toggle-on' : ''}`} />
      </button>
    </div>
  )
}
