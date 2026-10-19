import { useEffect, useRef, useState } from 'react'
import type { DocumentSaveOptions, SaveDocumentsProgress, SaveDocumentsResponse } from '../../../shared/protocol'
import { useLanguage } from '../localization'
import { CloseGlyph } from './DsGlyphs'
import { trapTabKey, useModalLayer } from './modal-stack'
import { SaveModuleOptionsDialog } from './SaveModuleOptionsDialog'

type SaveState = 'ready' | 'saving' | 'canceling' | 'done'

interface SaveModulesDialogProps {
  workspaceId: string
  /** The documents to save, each with the file and options it is saved with. */
  documents: DocumentSaveOptions[]
  /** `single` is dnSpy's SaveSingleModuleDlg, which starts saving the moment it opens; `multiple` is its
   *  SaveMultiModuleDlg, which lists the files and waits for Save All. */
  mode: 'single' | 'multiple'
  /** Called with the run's outcome once the window goes, or with nothing when it went before saving began. */
  onClose(response: SaveDocumentsResponse | undefined): void
}

let nextSaveKey = 0

/**
 * dnSpy's Save Modules window, and its one-file form: the files that will be saved, each one's options a double
 * click away, then the run itself — two bars, the file being written and the whole run — with Cancel, and the
 * log it leaves. A run with nothing in its log closes the window by itself; one with warnings or errors stays to
 * show them.
 */
export const SaveModulesDialog = ({ workspaceId, documents: initialDocuments, mode, onClose }: SaveModulesDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const dialog = useRef<HTMLDivElement>(null)
  const [documents, setDocuments] = useState(initialDocuments)
  const [selected, setSelected] = useState(0)
  const [editing, setEditing] = useState<number>()
  const [state, setState] = useState<SaveState>('ready')
  const [progress, setProgress] = useState<SaveDocumentsProgress>()
  const [response, setResponse] = useState<SaveDocumentsResponse>()
  const [errors, setErrors] = useState<(string | undefined)[]>([])
  const requestKey = useRef(`save-${++nextSaveKey}`)
  const started = useRef(false)

  const close = (): void => {
    if (state === 'saving') {
      if (window.confirm(t('Are you sure you want to cancel the save?')))
        void cancel()
      return
    }
    if (state === 'canceling') {
      if (window.confirm(t('The save is being canceled.\nAre you sure you want to close the window?')))
        onClose(undefined)
      return
    }
    onClose(response)
  }
  const depth = useModalLayer(close)

  // dnSpy's SaveMultiModuleVM re-validates whenever an option changes: a file name that will not do keeps
  // Save All off and puts the file's number in the banner.
  useEffect(() => {
    let current = true
    void Promise.all(documents.map((document) => window.dnSpy.validateSaveFileName(document.fileName))).then((results) => {
      if (current)
        setErrors(results.map((result) => result ? t(result.template, result.folder === undefined ? undefined : { folder: result.folder }) : undefined))
    })
    return () => { current = false }
  }, [documents, t])

  useEffect(() => window.dnSpy.onSaveProgress((next) => {
    if (next.requestKey === requestKey.current)
      setProgress(next)
  }), [])

  const save = async (): Promise<void> => {
    setState('saving')
    setProgress(undefined)
    try {
      const result = await window.dnSpy.saveDocuments(
        workspaceId,
        documents.map((document) => ({ documentId: document.documentId, fileName: document.fileName, writer: document.writer })),
        requestKey.current)
      setResponse(result)
      setState('done')
      const clean = !result.canceled && result.results.every((entry) => entry.saved && entry.errorCount === 0)
      // A run that went through without a word in its log is not worth looking at, and the window goes the way
      // dnSpy's does — after a short moment, so the bars are seen to reach the end.
      if (clean)
        window.setTimeout(() => onClose(result), 250)
    }
    catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      const failed: SaveDocumentsResponse = {
        canceled: false,
        modifiedDocuments: [],
        results: [{ documentId: documents[0]?.documentId ?? '', fileName: documents[0]?.fileName ?? '', saved: false, length: 0, log: [t('An exception occurred\n\n{message}', { message })], errorCount: 1, error: message }],
      }
      setResponse(failed)
      setState('done')
    }
  }

  const cancel = async (): Promise<void> => {
    setState('canceling')
    await window.dnSpy.cancelSave(requestKey.current)
  }

  // The one-file window has nothing to wait for: dnSpy's SaveSingleModuleDlg starts writing as it opens.
  useEffect(() => {
    if (mode === 'single' && !started.current) {
      started.current = true
      void save()
    }
  })

  const firstError = errors.findIndex((error) => error !== undefined)
  const errorCount = response ? response.results.reduce((count, entry) => count + entry.errorCount, 0) : 0
  const log = response
    ? [
      ...response.results.flatMap((entry) => entry.log),
      response.canceled
        ? t('Save was canceled by user.')
        : response.results.every((entry) => entry.saved) ? t('All files written to disk.') : undefined,
    ].filter((line): line is string => line !== undefined).map((line) => translateLogLine(line, t))
    : []
  const title = mode === 'single' ? 'Save Module' : 'Save Modules'
  const percent = (value: number | undefined): number => Math.round(Math.min(1, Math.max(0, value ?? 0)) * 100)

  return (
    <div className="modal-backdrop" role="presentation" style={{ zIndex: 100 + depth * 10 }}>
      <div
        ref={dialog}
        className="modal save-modules-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t(title)}
        onKeyDown={(event) => trapTabKey(event, dialog.current)}
      >
        <div className="modal-title"><span>{t(title)}</span><button type="button" className="icon-button" aria-label={t('Close')} title={t('Close')} onClick={close}><CloseGlyph /></button></div>
        <div className="save-modules-body">
          {mode === 'multiple' && (
            <>
              <div>{t('Files that will be saved:')}</div>
              <div className="save-modules-list" role="listbox" aria-label={t('Files that will be saved:')}>
                {documents.map((document, index) => (
                  <div
                    key={document.documentId}
                    role="option"
                    aria-selected={index === selected}
                    aria-disabled={state !== 'ready'}
                    className={index === selected ? 'selected' : undefined}
                    onClick={() => { if (state === 'ready') setSelected(index) }}
                    onDoubleClick={() => { if (state === 'ready') setEditing(index) }}
                  >
                    {document.fileName || t('<empty filename>')}
                  </div>
                ))}
              </div>
              {state === 'ready' && firstError >= 0 && (
                <div className="modal-error">
                  {t('File #{index} ({name}) has errors', { index: firstError + 1, name: documents[firstError]?.fileName || t('<empty filename>') })} {t('-- Fix the errors by editing the options.')}
                </div>
              )}
            </>
          )}
          {state !== 'ready' && (
            <div className="save-modules-progress">
              <div className="save-modules-file">{progress?.fileName ?? documents[0]?.fileName ?? ''}</div>
              <progress aria-label={t('File progress')} max={100} value={state === 'done' ? 100 : percent(progress?.fileProgress)} />
              <progress aria-label={t('Total progress')} max={100} value={state === 'done' ? 100 : percent(progress?.totalProgress)} />
              {state === 'canceling' && <div className="modal-error">{t('Canceling the save. Please wait...')}</div>}
            </div>
          )}
          {state === 'done' && errorCount > 0 && (
            <>
              <div className="modal-error">{t('There are errors in the log:')}</div>
              <textarea className="save-modules-log" readOnly aria-label={t('There are errors in the log:')} value={log.join('\n')} />
            </>
          )}
        </div>
        <div className="modal-actions">
          {state === 'ready' && mode === 'multiple' && (
            <button type="button" disabled={documents.length === 0} onClick={() => setEditing(selected)}>{t('Options...')}</button>
          )}
          <span className="modal-action-spacer" />
          {state === 'ready' && mode === 'multiple' && (
            <button type="button" className="primary" disabled={firstError >= 0 || documents.length === 0} onClick={() => void save()}>{t('Save All')}</button>
          )}
          {(state === 'ready' || state === 'saving') && <button type="button" onClick={() => state === 'saving' ? void cancel() : onClose(undefined)}>{t('Cancel')}</button>}
          {state === 'done' && <button type="button" className="primary" onClick={() => onClose(response)}>{t('Close')}</button>}
        </div>
      </div>
      {editing !== undefined && documents[editing] && (
        <SaveModuleOptionsDialog
          workspaceId={workspaceId}
          options={documents[editing]}
          onClose={() => setEditing(undefined)}
          onAccept={(next) => {
            setDocuments((current) => current.map((document, index) => index === editing ? next : document))
            setEditing(undefined)
          }}
        />
      )}
    </div>
  )
}

/** The log's lines come from the backend in dnSpy's English; the ones it writes itself are translated here. */
const translateLogLine = (line: string, t: (message: string, values?: Record<string, string | number>) => string): string => {
  const writing = /^Writing (.*)\.\.\.$/.exec(line)
  if (writing)
    return t('Writing {name}...', { name: writing[1] })
  const access = /^Access error: (.*)$/s.exec(line)
  if (access)
    return t('Access error: {message}', { message: access[1] })
  const file = /^File error: (.*)$/s.exec(line)
  if (file)
    return t('File error: {message}', { message: file[1] })
  const exception = /^An exception occurred\n\n(.*)$/s.exec(line)
  if (exception)
    return t('An exception occurred\n\n{message}', { message: exception[1] })
  return line
}
