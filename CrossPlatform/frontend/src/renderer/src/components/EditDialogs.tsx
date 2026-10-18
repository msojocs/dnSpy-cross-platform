import { useEffect, useRef, useState } from 'react'
import type { TreeNode } from '../../../shared/protocol'
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
