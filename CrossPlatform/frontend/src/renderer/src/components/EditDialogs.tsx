import { useEffect, useRef, useState } from 'react'
import type { IlInstruction, MethodBodyResponse, TreeNode } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'
import { CloseGlyph } from './DsGlyphs'
import { DsIcon } from './DsIcon'

interface RenameDialogProps {
  node: TreeNode
  onClose(): void
}

export const RenameDialog = ({ node, onClose }: RenameDialogProps): React.JSX.Element => {
  const [name, setName] = useState(node.label.includes('.') ? node.label.split('.').at(-1) ?? node.label : node.label.replace(/\(.*$/, ''))
  const renameNode = useAppStore((state) => state.renameNode)
  const input = useRef<HTMLInputElement>(null)
  const { t } = useLanguage()
  useEffect(() => input.current?.select(), [])

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <form className="modal rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title" onSubmit={(event) => {
        event.preventDefault()
        void renameNode(node, name).then((renamed) => { if (renamed) onClose() })
      }}>
        <div className="modal-title"><span id="rename-title">{t('Rename')}</span><button type="button" className="icon-button" aria-label={t('Close')} onClick={onClose}><CloseGlyph /></button></div>
        <div className="modal-content">
          <label>{t('Name')}<input ref={input} value={name} onChange={(event) => setName(event.target.value)} /></label>
        </div>
        <div className="modal-actions"><button type="button" onClick={onClose}>{t('Cancel')}</button><button type="submit" className="primary" disabled={!name.trim()}>{t('Rename')}</button></div>
      </form>
    </div>
  )
}

/**
 * dnSpy's Edit Namespace dialog: one name field over the namespace the tree selected, with a Reset that
 * puts the original name back. An empty name is accepted — it is how a namespace's types are moved into
 * the unnamed one.
 */
export const RenameNamespaceDialog = ({ node, onClose }: RenameDialogProps): React.JSX.Element => {
  const original = node.label === '-' ? '' : node.label
  const [name, setName] = useState(original)
  const renameNamespace = useAppStore((state) => state.renameNamespace)
  const input = useRef<HTMLInputElement>(null)
  const { t } = useLanguage()
  useEffect(() => input.current?.select(), [])

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <form className="modal rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-namespace-title" onSubmit={(event) => {
        event.preventDefault()
        // dnSpy skips the edit entirely when the name did not change; so does this.
        if (name === original) {
          onClose()
          return
        }
        void renameNamespace(node, name).then((renamed) => { if (renamed) onClose() })
      }}>
        <div className="modal-title"><span id="rename-namespace-title">{t('Edit Namespace')}</span><button type="button" className="icon-button" aria-label={t('Close')} onClick={onClose}><CloseGlyph /></button></div>
        <div className="modal-content">
          <label>{t('Name')}<input ref={input} value={name} onChange={(event) => setName(event.target.value)} /></label>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={() => setName(original)}>{t('Reset')}</button>
          <span className="modal-action-spacer" />
          <button type="button" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" className="primary">{t('OK')}</button>
        </div>
      </form>
    </div>
  )
}

interface GoToTokenDialogProps {
  node: TreeNode
  onClose(): void
}

/**
 * dnSpy's Go to Token box. The row the menu was opened over names the module the token is resolved in;
 * the token itself is typed as hex with or without the `0x`. A token that names no row keeps the box open
 * with the failure under it, which is what dnSpy's dialog does.
 */
export const GoToTokenDialog = ({ node, onClose }: GoToTokenDialogProps): React.JSX.Element => {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string>()
  const goToToken = useAppStore((state) => state.goToToken)
  const input = useRef<HTMLInputElement>(null)
  const { t } = useLanguage()
  useEffect(() => input.current?.focus(), [])

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <form className="modal rename-dialog" role="dialog" aria-modal="true" aria-labelledby="go-to-token-title" onSubmit={(event) => {
        event.preventDefault()
        void goToToken(node, token.trim()).then((found) => {
          if (found) onClose()
          else setError(t('The token {token} does not name a row in {module}.', { token: token.trim(), module: node.label }))
        }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      }}>
        <div className="modal-title"><span id="go-to-token-title">{t('Go to Token')}</span><button type="button" className="icon-button" aria-label={t('Close')} onClick={onClose}><CloseGlyph /></button></div>
        <div className="modal-content">
          <label>{t('Token')}<input ref={input} aria-label={t('Token')} placeholder="0x06000001" value={token} onChange={(event) => { setToken(event.target.value); setError(undefined) }} /></label>
          {error && <div className="modal-error">{error}</div>}
        </div>
        <div className="modal-actions"><button type="button" onClick={onClose}>{t('Cancel')}</button><button type="submit" className="primary" disabled={!token.trim()}>{t('OK')}</button></div>
      </form>
    </div>
  )
}

interface MethodBodyEditorProps {
  node: TreeNode
  onClose(): void
}

export const MethodBodyEditor = ({ node, onClose }: MethodBodyEditorProps): React.JSX.Element => {
  const workspaceId = useAppStore((state) => state.workspaceId)
  const methodBodyChanged = useAppStore((state) => state.methodBodyChanged)
  const appendOutput = useAppStore((state) => state.appendOutput)
  const [body, setBody] = useState<MethodBodyResponse>()
  const [clearHandlers, setClearHandlers] = useState(false)
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const { t } = useLanguage()

  useEffect(() => {
    if (!workspaceId) return
    void window.dnSpy.getMethodBody(workspaceId, node.id).then(setBody).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [workspaceId, node.id])

  const updateInstruction = (index: number, patch: Partial<IlInstruction>): void => {
    setBody((current) => current ? {
      ...current,
      instructions: current.instructions.map((instruction, instructionIndex) => instructionIndex === index ? { ...instruction, ...patch } : instruction),
    } : current)
  }

  const save = async (): Promise<void> => {
    if (!workspaceId || !body) return
    setSaving(true)
    setError(undefined)
    let transactionId: string | undefined
    try {
      transactionId = (await window.dnSpy.beginEdit(workspaceId)).transactionId
      await window.dnSpy.queueMethodBody(workspaceId, transactionId, node.id, body, clearHandlers)
      const committed = await window.dnSpy.commitEdit(workspaceId, transactionId)
      await methodBodyChanged(node, committed)
      onClose()
    } catch (reason) {
      if (transactionId) {
        try { await window.dnSpy.rollbackEdit(workspaceId, transactionId) } catch { /* already committed or invalidated */ }
      }
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      appendOutput(t('IL edit failed: {message}', { message }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal il-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="il-editor-title">
        <div className="modal-title"><span id="il-editor-title">{t('Edit IL · {name}', { name: node.label })}</span><button type="button" className="icon-button" aria-label={t('Close')} onClick={onClose}><CloseGlyph /></button></div>
        <div className="il-editor-options">
          <label>{t('Max stack')} <input type="number" min="0" max="65535" value={body?.maxStack ?? 0} onChange={(event) => setBody((current) => current ? { ...current, maxStack: Number(event.target.value) } : current)} /></label>
          <label><input type="checkbox" checked={body?.initLocals ?? false} onChange={(event) => setBody((current) => current ? { ...current, initLocals: event.target.checked } : current)} /> {t('Initialize locals')}</label>
          {body?.hasExceptionHandlers && <label className="warning-option"><input type="checkbox" checked={clearHandlers} onChange={(event) => setClearHandlers(event.target.checked)} /> {t('Clear exception handlers')}</label>}
        </div>
        <div className="il-grid" role="grid">
          <div className="il-grid-header">{t('Label')}</div><div className="il-grid-header">{t('Opcode')}</div><div className="il-grid-header">{t('Kind')}</div><div className="il-grid-header">{t('Operand')}</div><div />
          {body?.instructions.map((instruction, index) => (
            <div className="il-grid-row" role="row" key={`${index}:${instruction.label}`}>
              <input aria-label={t('Label {index}', { index })} value={instruction.label} onChange={(event) => updateInstruction(index, { label: event.target.value })} />
              <input aria-label={t('Opcode {index}', { index })} value={instruction.opCode} onChange={(event) => updateInstruction(index, { opCode: event.target.value })} />
              <select aria-label={t('Operand kind {index}', { index })} value={instruction.operandKind ?? ''} onChange={(event) => updateInstruction(index, { operandKind: event.target.value || undefined })}>
                <option value="">{t('None')}</option><option value="number">{t('Number')}</option><option value="string">{t('String')}</option><option value="branch">{t('Branch')}</option><option value="switch">{t('Switch')}</option><option value="local">{t('Local')}</option><option value="argument">{t('Argument')}</option><option value="token">{t('Token')}</option>
              </select>
              <input aria-label={t('Operand {index}', { index })} value={instruction.operand ?? ''} title={instruction.operandDisplay} onChange={(event) => updateInstruction(index, { operand: event.target.value })} />
              {/* ListBoxHelperBase's Remove wears DsImages.Cancel; its Append New and the dialog's buttons have no image. */}
              <button type="button" className="icon-button" title={t('Delete instruction')} aria-label={t('Delete instruction {index}', { index })} onClick={() => setBody((current) => current ? { ...current, instructions: current.instructions.filter((_, instructionIndex) => instructionIndex !== index) } : current)}><DsIcon name="Cancel" /></button>
            </div>
          ))}
        </div>
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={() => setBody((current) => current ? { ...current, instructions: [...current.instructions, { label: `L${current.instructions.length}`, opCode: 'nop' }] } : current)}>{t('Add')}</button>
          <span className="modal-action-spacer" />
          <button type="button" onClick={onClose}>{t('Cancel')}</button>
          <button type="button" className="primary" disabled={!body || saving || (body.hasExceptionHandlers && !clearHandlers)} onClick={() => void save()}>{t('Apply')}</button>
        </div>
      </div>
    </div>
  )
}
