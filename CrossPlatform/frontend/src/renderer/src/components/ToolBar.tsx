import {
  ArrowLeft,
  ArrowRight,
  FolderOpen,
  Maximize,
  Redo2,
  Save,
  Search,
  Undo2,
} from 'lucide-react'
import { useLanguage } from '../localization'
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

const ToolButton = ({ label, disabled, onClick, children }: React.PropsWithChildren<{ label: string; disabled?: boolean; onClick?: () => void }>): React.JSX.Element => (
  <button className="icon-button toolbar-button" title={label} aria-label={label} disabled={disabled} onClick={onClick}>{children}</button>
)

type DebugIconName = 'run' | 'pause' | 'stop' | 'restart' | 'next' | 'stepInto' | 'stepOver' | 'stepOut'

const DebugIcon = ({ name }: { name: DebugIconName }): React.JSX.Element => {
  const common = { className: 'toolbar-debug-icon', width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true }
  if (name === 'run')
    return <svg {...common}><path d="M4 2.5 13 8l-9 5.5z" fill="#25b34b" /></svg>
  if (name === 'pause')
    return <svg {...common}><path d="M4 3h3v10H4zm5 0h3v10H9z" fill="#72767b" /></svg>
  if (name === 'stop')
    return <svg {...common}><rect x="3" y="3" width="10" height="10" fill="#e32635" /></svg>
  if (name === 'restart')
    return <svg {...common}><path d="M12.8 5.9A5.6 5.6 0 1 0 11.4 12.8" fill="none" stroke="#1688d7" strokeWidth="1.6" strokeLinecap="round" /><path d="M10.1 3.2 12.8 5.9 10.1 8.6" fill="none" stroke="#1688d7" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" transform="rotate(45 12.8 5.9)" /></svg>
  if (name === 'next')
    return <svg {...common}><path d="M8 2v9m-3.2-2.8L8 11.4l3.2-3.2" fill="none" stroke="#7c8388" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
  if (name === 'stepInto')
    return <svg {...common}><path d="M8 2v8m-3-2.8L8 10.2l3-3" fill="none" stroke="#1688d7" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /><circle cx="8" cy="13" r="1.4" fill="#1688d7" /></svg>
  if (name === 'stepOver')
    return <svg {...common}>
        <path id="svg_1" strokeLinecap="round" strokeWidth="1.6" stroke="#1688d7" fill="none" d="m2.5,8.2c1.8,-4.4 7.3,-5.3 10.3,-0.3"/>
  <path stroke="#1688d7" transform="rotate(53 11.5576 6.73604)" id="svg_2" strokeLinejoin="round" strokeLinecap="round" strokeWidth="1.7" fill="none" d="m9.66214,3.47261l3.79088,3.22156l-3.53815,3.30529"/>
  <circle id="svg_3" fill="#1688d7" r="1.4" cy="12.5" cx="7.5"/>
      </svg>
  return <svg {...common}><path id="svg_1" strokeLinejoin="round" strokeLinecap="round" strokeWidth="1.4" stroke="#1688d7" fill="none" d="m8,10.2l0,-8m-3,2.8l3,-3l3,3"/>
  <circle id="svg_2" fill="#1688d7" r="1.4" cy="13" cx="8"/></svg>
}

export const ToolBar = ({ hasWorkspace, busy, onOpen, onSaveAll, onSearch, fullScreen, onToggleFullScreen, canGoBack, canGoForward, onBack, onForward, canUndo, canRedo, onUndo, onRedo, decompilerLanguage, onLanguageChange, debugAvailable, debugState, onStart, onContinue, onPause, onRestart, onShowNextStatement, onStepInto, onStepOver, onStepOut, onStop }: ToolBarProps): React.JSX.Element => {
  const { t } = useLanguage()
  const debugging = debugState !== 'inactive'
  return (
    <div className="tool-bar" role="toolbar" aria-label={t('Main toolbar')}>
      <ToolButton label={t('Open Assembly')} onClick={onOpen}><FolderOpen size={16} /></ToolButton>
      {/* dnSpy's Save button is Save All — its AsmEditor exports it with the SaveAll icon (SaveModuleCommand). */}
      <ToolButton label={t('Save All')} disabled={!hasWorkspace} onClick={onSaveAll}><Save size={16} /></ToolButton>
      <span className="toolbar-separator" />
      <ToolButton label={t('Back')} disabled={!canGoBack} onClick={onBack}><ArrowLeft size={16} /></ToolButton>
      <ToolButton label={t('Forward')} disabled={!canGoForward} onClick={onForward}><ArrowRight size={16} /></ToolButton>
      <span className="toolbar-separator" />
      {decompilerLanguage && <select className="toolbar-language-select" aria-label={t('Decompiler language')} value={decompilerLanguage} onChange={(event) => onLanguageChange(event.target.value as DecompilerLanguage)}>
        <option value="cSharp">C#</option>
        <option value="visualBasic">Visual Basic</option>
        <option value="il">IL</option>
        <option value="ilWithCSharp">IL with C#</option>
      </select>}
      <ToolButton label={t('Undo')} disabled={!canUndo} onClick={onUndo}><Undo2 size={16} /></ToolButton>
      <ToolButton label={t('Redo')} disabled={!canRedo} onClick={onRedo}><Redo2 size={16} /></ToolButton>
      <span className="toolbar-separator" />
      <ToolButton label={debugState === 'stopped' ? t('Continue') : t('Debug a Program')} disabled={!debugAvailable || (debugState !== 'inactive' && debugState !== 'stopped')} onClick={debugState === 'stopped' ? onContinue : onStart}><DebugIcon name="run" /></ToolButton>
      {debugging && <>
        <ToolButton label={t('Pause')} disabled={debugState !== 'running'} onClick={onPause}><DebugIcon name="pause" /></ToolButton>
        <ToolButton label={t('Stop')} disabled={debugState === 'starting'} onClick={onStop}><DebugIcon name="stop" /></ToolButton>
        <ToolButton label={t('Restart')} disabled={debugState === 'starting'} onClick={onRestart}><DebugIcon name="restart" /></ToolButton>
        <span className="toolbar-separator" />
        <ToolButton label={t('Show Next Statement')} disabled={debugState !== 'stopped'} onClick={onShowNextStatement}><DebugIcon name="next" /></ToolButton>
        <ToolButton label={t('Step Into')} disabled={debugState !== 'stopped'} onClick={onStepInto}><DebugIcon name="stepInto" /></ToolButton>
        <ToolButton label={t('Step Over')} disabled={debugState !== 'stopped'} onClick={onStepOver}><DebugIcon name="stepOver" /></ToolButton>
        <ToolButton label={t('Step Out')} disabled={debugState !== 'stopped'} onClick={onStepOut}><DebugIcon name="stepOut" /></ToolButton>
      </>}
      <span className="toolbar-separator" />
      <ToolButton label={t('Search')} disabled={!hasWorkspace} onClick={onSearch}><Search size={16} /></ToolButton>
      <span className="toolbar-spacer" />
      {/* The last group dnSpy's toolbar has: the Full Screen toggle (ToolBarCommands). */}
      <ToolButton label={t('Full Screen')} onClick={onToggleFullScreen}><Maximize size={16} className={fullScreen ? 'toolbar-toggle-on' : undefined} /></ToolButton>
      {busy && <span className="toolbar-busy">{t('Working')}</span>}
    </div>
  )
}
