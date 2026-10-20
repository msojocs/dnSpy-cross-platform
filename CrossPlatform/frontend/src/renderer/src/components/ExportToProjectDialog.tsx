import { useEffect, useRef, useState } from 'react'
import type { DecompilerLanguage, ExportProjectInfo, ExportProjectProgress, ExportProjectRequest, ProjectVersion } from '../../../shared/protocol'
import { projectVersions } from '../../../shared/protocol'
import { useLanguage } from '../localization'
import { loadAppOptions } from './app-options'
import { CloseGlyph } from './DsGlyphs'
import {
  appendErrorLog,
  decompilerSettingsFromOptions,
  exportLanguages,
  initialExportLanguage,
  isValidProjectGuid,
  loadExportToProjectSettings,
  saveExportToProjectSettings,
} from './export-project'
import { trapTabKey, useModalLayer } from './modal-stack'
import './ExportToProjectDialog.css'

/** ExportToProjectVM.State. */
type ExportState = 'editing' | 'exporting' | 'complete'

interface ExportToProjectDialogProps {
  workspaceId: string
  /** The tree's selection the command was started on. */
  nodeIds: string[]
  /** The language the documents are shown in — the dialog starts on it when it can export. */
  language: DecompilerLanguage
  onClose(): void
}

let nextExportKey = 0

/**
 * dnSpy's Export to Project command and its ExportToProjectDlg: the modules the selection names are looked up first —
 * with none, the command does nothing — then the dialog asks where and how to write them: the folder, the solution
 * and whether to write one, the Visual Studio version, the language, the first project's guid, what to do with the
 * resources and the XAML, the SDK project format, and whether to open the result. Export runs it with a progress bar
 * and Cancel; a run that logs nothing closes the dialog, one that does shows its error log instead of the options.
 */
export const ExportToProjectDialog = ({ workspaceId, nodeIds, language, onClose }: ExportToProjectDialogProps): React.JSX.Element | null => {
  const { t } = useLanguage()
  const dialog = useRef<HTMLDivElement>(null)
  const [info, setInfo] = useState<ExportProjectInfo>()
  const [settings] = useState(loadExportToProjectSettings)
  const [directory, setDirectory] = useState(settings.directory ?? '')
  const [directoryIsFile, setDirectoryIsFile] = useState(false)
  const [solutionFilename, setSolutionFilename] = useState('')
  const [createSolution, setCreateSolution] = useState(true)
  const [projectVersion, setProjectVersion] = useState<ProjectVersion>(settings.projectVersion)
  const [exportLanguage, setExportLanguage] = useState(() => initialExportLanguage(language))
  const [projectGuid, setProjectGuid] = useState<string>(() => crypto.randomUUID())
  const [unpackResources, setUnpackResources] = useState(true)
  const [createResX, setCreateResX] = useState(true)
  // dnSpy turns XAML decompilation on when it has a BAML decompiler, which the port always has.
  const canDecompileBamlAtAll = true
  const [decompileXaml, setDecompileXaml] = useState(canDecompileBamlAtAll)
  const [useSdkStyleProjectFormat, setUseSdkStyleProjectFormat] = useState(false)
  const [openProject, setOpenProject] = useState(false)
  const [state, setState] = useState<ExportState>('editing')
  const [maxProgress, setMaxProgress] = useState(1)
  const [progress, setProgress] = useState(0)
  const [errorLog, setErrorLog] = useState('')
  const requestKey = useRef(`export-${++nextExportKey}`)
  const receivedErrors = useRef(0)
  const finished = useRef(false)
  const closed = useRef(false)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  // ExportProjectCommand.Execute: what the selection names, before anything is shown.
  useEffect(() => {
    let current = true
    void window.dnSpy.getExportProjectInfo(workspaceId, nodeIds).then((result) => {
      if (!current)
        return
      if (result.modulePaths.length === 0) {
        onCloseRef.current()
        return
      }
      setSolutionFilename(result.solutionFilename)
      setInfo(result)
    }, () => { if (current) onCloseRef.current() })
    return () => { current = false }
  }, [workspaceId, nodeIds])

  // Verify(Directory): a file standing where the folder would go is an error — the main process looks at the disk.
  useEffect(() => {
    let current = true
    const trimmed = directory.trim()
    if (trimmed.length === 0) {
      setDirectoryIsFile(false)
      return
    }
    void window.dnSpy.isExistingFile(trimmed).then((isFile) => { if (current) setDirectoryIsFile(isFile) }, () => undefined)
    return () => { current = false }
  }, [directory])

  const addErrors = (messages: string[]): void => {
    if (messages.length === 0)
      return
    // dnSpy's ExportTask hands the errors it gathered since the last time to AddError as one entry.
    setErrorLog((log) => appendErrorLog(log, messages.map(translateError).join('\n')))
  }
  const translateError = (message: string): string => {
    const exception = /^An exception occurred\n\n(.*)$/s.exec(message)
    return exception ? t('An exception occurred\n\n{message}', { message: exception[1] }) : message
  }

  useEffect(() => window.dnSpy.onExportProjectProgress((next: ExportProjectProgress) => {
    // A notification that comes in after the response has nothing to add: the response's log has it all.
    if (next.requestKey !== requestKey.current || finished.current)
      return
    setMaxProgress(Math.max(1, next.maxProgress))
    setProgress(next.progress)
    receivedErrors.current += next.errors.length
    addErrors(next.errors)
  }), [])

  const directoryError = directory.trim().length === 0
    ? t('Missing destination folder.')
    : directoryIsFile ? t('A file with the same name as the destination folder already exists.') : undefined
  const solutionError = createSolution && solutionFilename.trim().length === 0 ? t('Missing filename') : undefined
  const guidError = isValidProjectGuid(projectGuid) ? undefined : t('Invalid GUID')
  const hasError = directoryError !== undefined || solutionError !== undefined || guidError !== undefined
  const editing = state === 'editing'
  const canExport = editing && !hasError && info !== undefined
  const exportErrors = errorLog.length > 0
  const canCreateResX = unpackResources && editing
  const canDecompileBaml = unpackResources && canDecompileBamlAtAll

  // The dialog's OnClosed: closing it while it exports calls the export off, as Cancel does.
  const close = (): void => {
    if (closed.current)
      return
    closed.current = true
    if (state === 'exporting')
      void window.dnSpy.cancelExportProject(requestKey.current)
    onClose()
  }
  const depth = useModalLayer(close)

  const exportProjects = async (): Promise<void> => {
    if (!canExport || !info)
      return
    setState('exporting')
    setMaxProgress(1)
    setProgress(0)
    const request: ExportProjectRequest = {
      workspaceId,
      nodeIds,
      directory: directory.trim(),
      solutionFilename: createSolution ? solutionFilename.trim() : null,
      projectVersion,
      useSdkStyleProjectFormat,
      language: exportLanguage,
      projectGuid: projectGuid.trim().length === 0 ? null : projectGuid.trim(),
      dontReferenceStdLib: info.dontReferenceStdLib,
      unpackResources,
      createResX,
      decompileXaml,
      settings: decompilerSettingsFromOptions(loadAppOptions()),
    }
    let errors = false
    let fileToOpen: string | null = null
    try {
      const response = await window.dnSpy.exportProject(request, requestKey.current)
      finished.current = true
      if (response.canceled || closed.current)
        return
      // What the notifications did not bring yet is in the response's log after them.
      const rest = response.errors.slice(receivedErrors.current)
      addErrors(rest)
      errors = response.errors.length > 0
      fileToOpen = response.fileToOpen
    }
    catch (reason) {
      finished.current = true
      if (closed.current)
        return
      addErrors([`An exception occurred\n\n${reason instanceof Error ? reason.message : String(reason)}`])
      errors = true
    }
    // ExportProjectCommand keeps the project version once the dialog has run an export to the end.
    saveExportToProjectSettings({ projectVersion, directory: directory.trim() })
    setState('complete')
    if (!errors) {
      closed.current = true
      onClose()
      if (openProject && fileToOpen)
        void window.dnSpy.openExportedProject(fileToOpen)
    }
  }

  const pickDirectory = async (): Promise<void> => {
    const picked = await window.dnSpy.pickExportDirectory(directory.trim() || undefined)
    if (picked)
      setDirectory(picked)
  }

  if (!info)
    return null

  const filesToExport = info.modulePaths.length === 1
    ? t('One file will be decompiled. Select more than one assembly to decompile more than one file.')
    : t('{count} files will be decompiled.', { count: info.modulePaths.length.toLocaleString() })

  return (
    <div className="modal-backdrop" role="presentation" style={{ zIndex: 100 + depth * 10 }}>
      <div
        ref={dialog}
        className="modal export-project-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('Export to Project')}
        onKeyDown={(event) => {
          trapTabKey(event, dialog.current)
          // The Export button is the dialog's IsDefault one.
          if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement) && !(event.target instanceof HTMLTextAreaElement) && canExport) {
            event.preventDefault()
            void exportProjects()
          }
        }}
      >
        <div className="modal-title"><span>{t('Export to Project')}</span><button type="button" className="icon-button" aria-label={t('Close')} title={t('Close')} onClick={close}><CloseGlyph /></button></div>
        <div className="export-project-body">
          {!exportErrors && (
            <fieldset className="export-project-settings" disabled={!editing}>
              <label htmlFor="export-project-folder">{t('Folder')}</label>
              <input
                id="export-project-folder"
                autoFocus
                value={directory}
                aria-invalid={directoryError !== undefined}
                title={directoryError}
                onChange={(event) => setDirectory(event.target.value)}
              />
              <button type="button" aria-label={t('Browse...')} title={t('Browse...')} onClick={() => void pickDirectory()}>...</button>

              <label htmlFor="export-project-solution">{t('Solution')}</label>
              <input
                id="export-project-solution"
                value={solutionFilename}
                disabled={!createSolution}
                aria-invalid={solutionError !== undefined}
                title={solutionError}
                onChange={(event) => setSolutionFilename(event.target.value)}
              />
              <input type="checkbox" aria-label={t('Create solution')} title={t('Create solution')} checked={createSolution} onChange={(event) => setCreateSolution(event.target.checked)} />

              <label htmlFor="export-project-version">{t('Version')}</label>
              <select id="export-project-version" value={projectVersion} onChange={(event) => setProjectVersion(event.target.value as ProjectVersion)}>
                {projectVersions.map((version) => <option key={version} value={version}>{version}</option>)}
              </select>
              <span />

              <label htmlFor="export-project-language">{t('Language')}</label>
              <select id="export-project-language" value={exportLanguage} onChange={(event) => setExportLanguage(event.target.value as typeof exportLanguage)}>
                {exportLanguages.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
              </select>
              <span />

              <label htmlFor="export-project-guid">{t('Project GUID')}</label>
              <input
                id="export-project-guid"
                value={projectGuid}
                aria-invalid={guidError !== undefined}
                title={guidError}
                onChange={(event) => setProjectGuid(event.target.value)}
              />
              <button type="button" onClick={() => setProjectGuid(crypto.randomUUID())}>{t('New')}</button>

              <label className="export-project-check"><input type="checkbox" checked={unpackResources} onChange={(event) => setUnpackResources(event.target.checked)} />{t('Unpack resources')}</label>
              <label className="export-project-check"><input type="checkbox" checked={createResX} disabled={!canCreateResX} onChange={(event) => setCreateResX(event.target.checked)} />{t('Create .resx files')}</label>
              <label className="export-project-check"><input type="checkbox" checked={decompileXaml} disabled={!canDecompileBaml} onChange={(event) => setDecompileXaml(event.target.checked)} />{t('Decompile baml to xaml')}</label>
              <label className="export-project-check"><input type="checkbox" checked={useSdkStyleProjectFormat} onChange={(event) => setUseSdkStyleProjectFormat(event.target.checked)} />{t('Use SDK style project format')}</label>
              <label className="export-project-check"><input type="checkbox" checked={openProject} onChange={(event) => setOpenProject(event.target.checked)} />{t('Open project in Visual Studio')}</label>

              <div className="export-project-message">{filesToExport}</div>
            </fieldset>
          )}
          {exportErrors && (
            <div className="export-project-errors">
              <div>{t('Error log')}</div>
              <textarea readOnly aria-label={t('Error log')} value={errorLog} />
            </div>
          )}
        </div>
        <div className="modal-actions">
          {state === 'exporting'
            ? <progress className="export-project-progress" aria-label={t('Progress')} max={maxProgress} value={Math.min(progress, maxProgress)} />
            : <span className="modal-action-spacer" />}
          <button type="button" className="primary" disabled={!canExport} onClick={() => void exportProjects()}>{t('Export')}</button>
          {state !== 'complete'
            ? <button type="button" onClick={close}>{t('Cancel')}</button>
            : <button type="button" onClick={close}>{t('Close')}</button>}
        </div>
      </div>
    </div>
  )
}
