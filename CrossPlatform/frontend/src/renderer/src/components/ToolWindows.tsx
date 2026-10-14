import { useEffect, useState } from 'react'
import { Save, ToggleLeft, Trash2 } from 'lucide-react'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'

/** Where the Output window keeps its word wrap. dnSpy keeps it in the settings file with the rest of that
 *  window's options; the port keeps it beside its other per-window settings, in storage of its own. */
const outputWordWrapKey = 'dnspy.output.wordWrap'

/**
 * dnSpy's Output window. Its command bar carries Clear All, Save and the Word Wrap toggle, which are the
 * three its own toolbar has whose meaning does not need the loggers behind the source selector — this port
 * writes to one log, so there is nothing for "Show output from" to switch between.
 */
export const OutputPane = (): React.JSX.Element => {
  const output = useAppStore((state) => state.output)
  const clearOutput = useAppStore((state) => state.clearOutput)
  const [wordWrap, setWordWrap] = useState(() => localStorage.getItem(outputWordWrapKey) === 'true')
  const { t } = useLanguage()

  useEffect(() => {
    localStorage.setItem(outputWordWrapKey, String(wordWrap))
  }, [wordWrap])

  // dnSpy's Save writes the buffer out as text. What is written is what the window shows, one line per row.
  const save = async (): Promise<void> => {
    if (output.length === 0)
      return
    await window.dnSpy.saveCode('output.txt', output.join('\n'), t('Save Output As'))
  }

  return (
    <div className="output-window">
      <div className="output-command-bar" role="toolbar" aria-label={t('Output')}>
        <button type="button" className="icon-button" aria-label={t('Clear All')} title={t('Clear All')} disabled={output.length === 0} onClick={clearOutput}><Trash2 size={15} /></button>
        <button type="button" className="icon-button" aria-label={t('Save As')} title={t('Save As')} disabled={output.length === 0} onClick={() => void save()}><Save size={15} /></button>
        <span className="toolbar-separator" />
        <button type="button" className="icon-button" aria-label={t('Word Wrap')} title={t('Word Wrap')} aria-pressed={wordWrap} onClick={() => setWordWrap(!wordWrap)}><ToggleLeft size={15} /></button>
      </div>
      <div className={`output-pane${wordWrap ? ' output-word-wrap' : ''}`} role="log" aria-label={t('Output')}>
        {output.map((line, index) => <div key={`${index}:${line}`}>{line}</div>)}
      </div>
    </div>
  )
}

export const DebugPlaceholder = ({ label }: { label: string }): React.JSX.Element => (
  <div className="pane-empty">{label}</div>
)
