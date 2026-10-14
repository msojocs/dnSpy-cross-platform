import { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, X } from 'lucide-react'
import {
  applyDocumentListChanges,
  documentListRows,
  filterDocumentListRows,
  loadDocumentLists,
  type DocumentList,
  type StoredDocumentLists,
} from '../document-lists'
import { useLanguage } from '../localization'

/**
 * dnSpy's Open List dialog (OpenDocumentListDlg): the lists the user saved, and one per .NET shared framework
 * on this machine, searchable, with New and Remove. OK hands back the list to open and the lists as they now
 * stand; Cancel leaves both alone, the way dnSpy only saves the dialog's changes on OK.
 */
export const OpenListDialog = ({ onClose, onOpen }: {
  onClose(): void
  onOpen(stored: StoredDocumentLists, chosen: DocumentList | undefined): void
}): React.JSX.Element => {
  const { t } = useLanguage()
  const [stored] = useState(loadDocumentLists)
  const [defaults, setDefaults] = useState<DocumentList[]>()
  const [created, setCreated] = useState<DocumentList[]>([])
  const [removed, setRemoved] = useState<string[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [savedOnly, setSavedOnly] = useState(false)
  const [naming, setNaming] = useState<string>()
  const searchRef = useRef<HTMLInputElement>(null)

  // DefaultDocumentListFinder runs while the dialog is up; the saved lists show at once.
  useEffect(() => {
    let alive = true
    void window.dnSpy.listDefaultDocumentLists()
      .then((response) => { if (alive) setDefaults(response.lists) })
      .catch(() => { if (alive) setDefaults([]) })
    return () => { alive = false }
  }, [])

  const rows = useMemo(() => {
    const saved = [...stored.lists, ...created].filter((list) => !removed.includes(list.name))
    return documentListRows(saved, defaults ?? [])
  }, [stored, created, removed, defaults])
  const shown = useMemo(() => filterDocumentListRows(rows, search, savedOnly), [rows, search, savedOnly])
  const userNames = new Set([...stored.lists, ...created].map((list) => list.name))

  const ok = (chosenName = selected[0]): void => {
    const chosen = rows.find((row) => row.list.name === chosenName)?.list
    onOpen(applyDocumentListChanges(stored, removed, created, chosen), chosen)
    onClose()
  }

  // OpenDocumentListVM.Remove: a list the user had goes on OK; one the machine offers only leaves the view.
  const remove = (): void => {
    setRemoved((current) => [...current, ...selected.filter((name) => userNames.has(name))])
    setCreated((current) => current.filter((list) => !selected.includes(list.name)))
    setSelected([])
  }

  const create = (): void => {
    const name = naming?.trim()
    if (!name)
      return
    setCreated((current) => [...current.filter((list) => list.name !== name), { name, files: [] }])
    setRemoved((current) => current.filter((removedName) => removedName !== name))
    setSelected([name])
    setNaming(undefined)
  }

  return (
    <div className="modal-backdrop">
      <div
        className="modal open-list-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="open-list-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            if (naming !== undefined) setNaming(undefined)
            else onClose()
          }
        }}
      >
        <div className="modal-title"><span id="open-list-title">{t('Open List')}</span><button className="icon-button" aria-label={t('Close')} onClick={onClose}><X size={14} /></button></div>
        <div className="attach-filter">
          <label htmlFor="open-list-search">{t('Search')}</label>
          <input id="open-list-search" ref={searchRef} autoFocus value={search} onChange={(event) => setSearch(event.target.value)} />
          <label className="open-list-saved"><input type="checkbox" checked={savedOnly} onChange={(event) => setSavedOnly(event.target.checked)} />{t('Saved lists')}</label>
        </div>
        <div className="open-list-rows" role="listbox" aria-multiselectable="true" aria-label={t('Open List')}>
          <div className="open-list-row open-list-header" aria-hidden="true"><span>{t('Name')}</span><span>{t('Files')}</span></div>
          {shown.map((row) => (
            <div
              key={row.list.name}
              role="option"
              aria-selected={selected.includes(row.list.name)}
              className={`open-list-row${selected.includes(row.list.name) ? ' selected' : ''}${row.list.name === stored.selected ? ' current' : ''}`}
              onClick={(event) => {
                const name = row.list.name
                if (event.ctrlKey || event.metaKey)
                  setSelected((current) => current.includes(name) ? current.filter((other) => other !== name) : [...current, name])
                else
                  setSelected([name])
              }}
              onDoubleClick={() => ok(row.list.name)}
            >
              <span>{row.list.name}</span><span>{row.list.files.length.toLocaleString()}</span>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          {defaults === undefined && <span className="gac-status"><LoaderCircle className="spin" size={13} /></span>}
          {naming !== undefined && (
            <span className="open-list-naming">
              <input
                autoFocus
                aria-label={t('Name')}
                value={naming}
                onChange={(event) => setNaming(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    event.stopPropagation()
                    create()
                  }
                }}
              />
              {naming.trim().length === 0 && <span className="field-error">{t('Missing name')}</span>}
            </span>
          )}
          <span className="modal-action-spacer" />
          <button disabled={selected.length === 0} onClick={remove}>{t('Remove')}</button>
          <button onClick={() => naming === undefined ? setNaming('') : create()}>{t('New...')}</button>
          <button className="primary" onClick={() => ok()}>{t('Open')}</button>
          <button onClick={onClose}>{t('Cancel')}</button>
        </div>
      </div>
    </div>
  )
}
