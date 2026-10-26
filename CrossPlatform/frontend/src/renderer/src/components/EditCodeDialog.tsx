import { useEffect, useRef, useState } from 'react'
import type { CompilerDiagnostic, CompilerLanguage, CompilerMode, TreeNode } from '../../../shared/protocol'
import { compilerLanguageFor, compilerSettingsFor, useAppStore } from '../app-store'
import { loadAppOptions } from './app-options'
import { decompilerSettingsOf } from '../decompiler-settings'
import { useLanguage } from '../localization'
import { CloseGlyph } from './DsGlyphs'
import { useModalLayer } from './modal-stack'
import { RoslynCodeEditor } from './RoslynCodeEditor'

/** dnSpy's headers for the compiler commands, each naming the language — EditCodeVMCreator.GetHeader. */
const TITLES: Record<CompilerMode, string> = {
  editMethod: 'Edit Method ({language})',
  editClass: 'Edit Class ({language})',
  addMembers: 'Add Class Members ({language})',
  addClass: 'Add Class ({language})',
  editAssembly: 'Edit Assembly Attributes ({language})',
}

/** The name dnSpy gives each compiler language in the headers: the decompiler's GenericNameUI. */
export const COMPILER_LANGUAGE_NAMES: Record<CompilerLanguage, string> = { csharp: 'C#', visualBasic: 'Visual Basic' }

interface EditCodeDialogProps {
  node: TreeNode
  mode: CompilerMode
  /** The type whose decompiled source the editor opens with — the outermost type of the edited one. */
  sourceNodeId?: string
  theme: string
  onClose(): void
}

/**
 * dnSpy's Edit Code window: one document in the language the decompiler is in when it has a compiler — C# or
 * Visual Basic, C# otherwise — in dnSpy's Roslyn code editor, a Compile button and the diagnostics it reports. Add
 * Class starts from an empty document, as dnSpy's AddClassVM does.
 * The source is compiled against the module and its references; accepting it imports the generated
 * assembly through dnSpy's ModuleImporter as one undoable edit.
 */
export const EditCodeDialog = ({ node, mode, sourceNodeId, theme, onClose }: EditCodeDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const workspaceId = useAppStore((state) => state.workspaceId)
  const compileCode = useAppStore((state) => state.compileCode)
  const [source, setSource] = useState<string>()
  const [diagnostics, setDiagnostics] = useState<CompilerDiagnostic[]>([])
  const [failure, setFailure] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [compiled, setCompiled] = useState(false)
  // The language is the decompiler's when the window opens, as dnSpy picks it when it builds the window's compiler.
  const [language] = useState<CompilerLanguage>(() => compilerLanguageFor(useAppStore.getState().defaultLanguage))
  const title = t(TITLES[mode], { language: COMPILER_LANGUAGE_NAMES[language] })
  const editor = useRef<{ setPosition(position: { lineNumber: number, column: number }): void, revealLineInCenter(lineNumber: number): void, focus(): void } | undefined>(undefined)
  const depth = useModalLayer(onClose)

  useEffect(() => {
    if (!workspaceId)
      return
    let cancelled = false
    if (mode === 'editAssembly') {
      void window.dnSpy.getAssemblyAttributesSource(workspaceId, node.id, language)
        .then((result) => { if (!cancelled) setSource(result.source) })
        .catch((reason: unknown) => { if (!cancelled) setFailure(reason instanceof Error ? reason.message : String(reason)) })
    }
    else if (sourceNodeId) {
      // The decompiler settings the options pages hold, so the source the editor opens with is the text the
      // document tab shows rather than the backend's defaults.
      void window.dnSpy.decompile(workspaceId, sourceNodeId, language === 'visualBasic' ? 'visualBasic' : 'cSharp', decompilerSettingsOf(loadAppOptions()))
        .then((document) => { if (!cancelled) setSource(document.text) })
        .catch((reason: unknown) => { if (!cancelled) setFailure(reason instanceof Error ? reason.message : String(reason)) })
    }
    else {
      setSource('')
    }
    return () => { cancelled = true }
  }, [workspaceId, sourceNodeId, mode, node.id, language])

  const compile = async (apply: boolean): Promise<void> => {
    if (!source)
      return
    setBusy(true)
    setFailure(undefined)
    if (!apply) {
      try {
        const result = await window.dnSpy.compileSource(workspaceId ?? '', node.id, mode, source, undefined, language, compilerSettingsFor(language))
        setDiagnostics(result.diagnostics)
        setCompiled(result.success)
      }
      catch (reason) {
        setFailure(reason instanceof Error ? reason.message : String(reason))
      }
      finally {
        setBusy(false)
      }
      return
    }
    const result = await compileCode(node, mode, source, language)
    setBusy(false)
    setDiagnostics(result.diagnostics)
    if (result.ok)
      onClose()
    else if (result.diagnostics.length === 0)
      setFailure(useAppStore.getState().error)
  }

  const goTo = (diagnostic: CompilerDiagnostic): void => {
    editor.current?.setPosition({ lineNumber: diagnostic.startLine + 1, column: diagnostic.startColumn + 1 })
    editor.current?.revealLineInCenter(diagnostic.startLine + 1)
    editor.current?.focus()
  }

  const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length

  return (
    <div className="modal-backdrop" role="presentation" style={{ zIndex: 100 + depth * 10 }}>
      <div className="modal edit-code-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-title"><span>{title}</span><button type="button" className="icon-button" aria-label={t('Close')} onClick={onClose}><CloseGlyph /></button></div>
        <div className="edit-code-toolbar">
          <button type="button" disabled={busy || source === undefined} onClick={() => void compile(false)}>{t('Compile')}</button>
          <span className={errorCount > 0 ? 'edit-code-summary error' : 'edit-code-summary'}>
            {diagnostics.length === 0
              ? (compiled ? t('Compiled successfully.') : t('Press Compile to check the code.'))
              : t('{count} diagnostic(s), {errors} error(s).', { count: diagnostics.length, errors: errorCount })}
          </span>
        </div>
        <div className="edit-code-editor">
          {source === undefined
            ? <div className="il-loading">{failure ?? t('Loading...')}</div>
            : (
              <RoslynCodeEditor
                language={language}
                theme={theme}
                value={source}
                onChange={setSource}
                workspaceId={workspaceId}
                nodeId={node.id}
                onMount={(mounted) => { editor.current = mounted }}
              />
            )}
        </div>
        <div className="edit-code-diagnostics" role="list" aria-label={t('Diagnostics')}>
          {diagnostics.map((diagnostic, index) => (
            <button
              type="button"
              role="listitem"
              key={`${index}:${diagnostic.id}`}
              className={`edit-code-diagnostic ${diagnostic.severity}`}
              onClick={() => goTo(diagnostic)}
            >
              <span className="edit-code-severity">{diagnostic.severity}</span>
              <span className="edit-code-id">{diagnostic.id}</span>
              <span className="edit-code-text">{diagnostic.text}</span>
              <span className="edit-code-position">{diagnostic.fileName ?? (language === 'visualBasic' ? 'main.vb' : 'main.cs')}({diagnostic.startLine + 1},{diagnostic.startColumn + 1})</span>
            </button>
          ))}
        </div>
        {failure && <div className="modal-error">{failure}</div>}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
          <button type="button" className="primary" disabled={busy || source === undefined} onClick={() => void compile(true)}>{t('OK')}</button>
        </div>
      </div>
    </div>
  )
}
