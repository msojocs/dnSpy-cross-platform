import { useEffect, useRef, useState } from 'react'
import type { CompilerDiagnostic, CompilerMode, TreeNode } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'
import CodeEditor from './CodeEditor'
import { CloseGlyph } from './DsGlyphs'
import { useModalLayer } from './modal-stack'

const TITLES: Record<CompilerMode, string> = {
  editMethod: 'Edit Method (C#)',
  editClass: 'Edit Class (C#)',
  addMembers: 'Add Class Members (C#)',
  addClass: 'Add Class (C#)',
  editAssembly: 'Edit Assembly Attributes (C#)',
}

/** What the Add Class and Edit Assembly Attributes windows open with. */
const TEMPLATES: Partial<Record<CompilerMode, string>> = {
  addClass: `namespace MyNamespace
{
    public class MyClass
    {
    }
}
`,
}

interface EditCodeDialogProps {
  node: TreeNode
  mode: CompilerMode
  /** The type whose decompiled source the editor opens with — the outermost type of the edited one. */
  sourceNodeId?: string
  theme: string
  onClose(): void
}

/**
 * dnSpy's Edit Code window: one Monaco document of C#, a Compile button and the diagnostics it reports.
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
  const editor = useRef<{ setPosition(position: { lineNumber: number, column: number }): void, revealLineInCenter(lineNumber: number): void, focus(): void } | undefined>(undefined)
  const depth = useModalLayer(onClose)

  useEffect(() => {
    if (!workspaceId)
      return
    let cancelled = false
    if (mode === 'editAssembly') {
      void window.dnSpy.getAssemblyAttributesSource(workspaceId, node.id)
        .then((result) => { if (!cancelled) setSource(result.source) })
        .catch((reason: unknown) => { if (!cancelled) setFailure(reason instanceof Error ? reason.message : String(reason)) })
    }
    else if (sourceNodeId) {
      void window.dnSpy.decompile(workspaceId, sourceNodeId, 'cSharp')
        .then((document) => { if (!cancelled) setSource(document.text) })
        .catch((reason: unknown) => { if (!cancelled) setFailure(reason instanceof Error ? reason.message : String(reason)) })
    }
    else {
      setSource(TEMPLATES[mode] ?? '')
    }
    return () => { cancelled = true }
  }, [workspaceId, sourceNodeId, mode, node.id])

  const compile = async (apply: boolean): Promise<void> => {
    if (!source)
      return
    setBusy(true)
    setFailure(undefined)
    if (!apply) {
      try {
        const result = await window.dnSpy.compileSource(workspaceId ?? '', node.id, mode, source)
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
    const result = await compileCode(node, mode, source)
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
      <div className="modal edit-code-dialog" role="dialog" aria-modal="true" aria-label={t(TITLES[mode])}>
        <div className="modal-title"><span>{t(TITLES[mode])}</span><button type="button" className="icon-button" aria-label={t('Close')} onClick={onClose}><CloseGlyph /></button></div>
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
              <CodeEditor
                language="csharp"
                theme={theme}
                value={source}
                onChange={(value) => setSource(value ?? '')}
                onMount={(mounted) => { editor.current = mounted }}
                options={{ automaticLayout: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false }}
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
              <span className="edit-code-position">{diagnostic.fileName ?? 'main.cs'}({diagnostic.startLine + 1},{diagnostic.startColumn + 1})</span>
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
