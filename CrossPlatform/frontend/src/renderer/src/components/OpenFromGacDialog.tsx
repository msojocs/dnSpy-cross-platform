import { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { GacAssemblyDto, GacDetailsResponse } from '../../../shared/protocol'
import { useLanguage } from '../localization'
import { CloseGlyph } from './DsGlyphs'

/**
 * dnSpy's GACFileVM_EqualityComparer: two caches can hold the same assembly, and the one listed second is a
 * duplicate. Culture is left out of the comparison, the way dnSpy leaves it out.
 */
const identityOf = (assembly: GacAssemblyDto): string =>
  `${assembly.name.toUpperCase()}|${assembly.version}|${assembly.publicKeyToken.toLowerCase()}`

/**
 * dnSpy's AssemblyNameComparer with every flag: by name, then version, then culture and token. Versions are
 * compared part by part, so 10.0 sorts after 9.0.
 */
const compareAssemblies = (left: GacAssemblyDto, right: GacAssemblyDto): number => {
  const byName = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  if (byName !== 0)
    return byName
  const leftParts = left.version.split('.').map(Number)
  const rightParts = right.version.split('.').map(Number)
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i++) {
    const difference = (leftParts[i] ?? 0) - (rightParts[i] ?? 0)
    if (difference !== 0)
      return difference
  }
  return left.culture.localeCompare(right.culture) || left.publicKeyToken.localeCompare(right.publicKeyToken)
}

export interface GacRow extends GacAssemblyDto {
  isDuplicate: boolean
}

/** The cache's assemblies in dnSpy's order, each marked when an earlier cache already listed the same one. */
export const gacRowsOf = (assemblies: readonly GacAssemblyDto[]): GacRow[] => {
  const seen = new Set<string>()
  const rows = assemblies.map((assembly) => {
    const identity = identityOf(assembly)
    const isDuplicate = seen.has(identity)
    seen.add(identity)
    return { ...assembly, isDuplicate }
  })
  return rows.sort(compareAssemblies)
}

/**
 * OpenFromGACVM.CalculateIsVisible: a duplicate only when duplicates are shown, and a row only when every
 * space-separated word of the search is in its name or its version, ignoring case.
 */
export const filterGacRows = (rows: readonly GacRow[], search: string, showDuplicates: boolean): GacRow[] => {
  const words = search.trim().toUpperCase().split(' ').filter((word) => word.length > 0)
  return rows.filter((row) => {
    if (!showDuplicates && row.isDuplicate)
      return false
    const name = row.name.toUpperCase()
    const version = row.version.toUpperCase()
    return words.every((word) => name.includes(word) || version.includes(word))
  })
}

/**
 * dnSpy's Open from GAC dialog: every assembly in the global assembly caches this machine has — on Linux the
 * ones Mono keeps — with a search, the duplicates the caches share left out unless asked for, and the
 * selected file's details beside the list. The files chosen open the way File > Open opens them.
 */
export const OpenFromGacDialog = ({ onClose, onOpen }: { onClose(): void; onOpen(paths: string[]): void }): React.JSX.Element => {
  const { t } = useLanguage()
  const [rows, setRows] = useState<GacRow[]>()
  const [search, setSearch] = useState('')
  const [showDuplicates, setShowDuplicates] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [anchor, setAnchor] = useState<string>()
  const [details, setDetails] = useState<{ path: string } & GacDetailsResponse>()
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    void window.dnSpy.listGacAssemblies()
      .then((response) => { if (alive) setRows(gacRowsOf(response.assemblies)) })
      .catch(() => { if (alive) setRows([]) })
    return () => { alive = false }
  }, [])

  const shown = useMemo(() => filterGacRows(rows ?? [], search, showDuplicates), [rows, search, showDuplicates])
  const focused = shown.find((row) => row.path === selected.at(-1))

  // The details panel reads the file's version resource, which only the backend can open; it is asked for
  // the row the selection ended on, the way WPF's panel follows ListView.SelectedItem.
  useEffect(() => {
    if (!focused)
      return
    let alive = true
    void window.dnSpy.getGacDetails(focused.path)
      .then((response) => { if (alive) setDetails({ path: focused.path, ...response }) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [focused])

  const choose = (paths: string[]): void => {
    if (paths.length === 0)
      return
    onOpen(paths)
    onClose()
  }

  const clickRow = (row: GacRow, event: React.MouseEvent): void => {
    if (event.shiftKey && anchor) {
      const from = shown.findIndex((candidate) => candidate.path === anchor)
      const to = shown.findIndex((candidate) => candidate.path === row.path)
      if (from >= 0 && to >= 0) {
        setSelected(shown.slice(Math.min(from, to), Math.max(from, to) + 1).map((candidate) => candidate.path))
        return
      }
    }
    setAnchor(row.path)
    if (event.ctrlKey || event.metaKey)
      setSelected((current) => current.includes(row.path) ? current.filter((path) => path !== row.path) : [...current, row.path])
    else
      setSelected([row.path])
  }

  const total = rows?.length ?? 0
  const detail = focused && details?.path === focused.path ? details : undefined

  return (
    <div className="modal-backdrop">
      <div
        className="modal open-from-gac-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gac-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
          if (event.ctrlKey && event.key.toLowerCase() === 'f') {
            event.preventDefault()
            searchRef.current?.focus()
          }
        }}
      >
        <div className="modal-title"><span id="gac-title">{t('Open from GAC')}</span><button className="icon-button" aria-label={t('Close')} onClick={onClose}><CloseGlyph /></button></div>
        <div className="gac-body">
          <div className="gac-list" role="listbox" aria-multiselectable="true" aria-label={t('Open from GAC')}>
            <div className="gac-row gac-header" aria-hidden="true"><span>{t('Name')}</span><span>{t('Version')}</span></div>
            {shown.map((row) => (
              <div
                key={row.path}
                role="option"
                aria-selected={selected.includes(row.path)}
                className={`gac-row${selected.includes(row.path) ? ' selected' : ''}`}
                title={row.path}
                onClick={(event) => clickRow(row, event)}
                onDoubleClick={() => choose([row.path])}
              >
                <span>{row.name}</span><span>{row.version}</span>
              </div>
            ))}
          </div>
          <div className="gac-side">
            <input ref={searchRef} autoFocus aria-label={t('Search')} title={t('Search (Ctrl+F)')} value={search} onChange={(event) => setSearch(event.target.value)} />
            <label className="gac-duplicates"><input type="checkbox" checked={showDuplicates} onChange={(event) => setShowDuplicates(event.target.checked)} />{t('Show duplicates')}</label>
            <dl className="gac-details">
              <dt>{t('Name:')}</dt><dd>{focused?.name}</dd>
              <dt>{t('Created by:')}</dt><dd>{detail?.createdBy}</dd>
              <dt>{t('Version:')}</dt><dd>{focused?.version}</dd>
              <dt>{t('File Version:')}</dt><dd>{detail?.fileVersion}</dd>
              <dt>{t('Path:')}</dt><dd>{focused?.path}</dd>
            </dl>
          </div>
        </div>
        <div className="modal-actions">
          {rows === undefined
            ? <span className="gac-status"><LoaderCircle className="spin" size={13} /></span>
            : <span className="gac-status">{shown.length === total ? '' : t('Showing {shown} of {total} files', { shown: shown.length.toLocaleString(), total: total.toLocaleString() })}</span>}
          <span className="modal-action-spacer" />
          <button className="primary" disabled={selected.length === 0} onClick={() => choose(shown.filter((row) => selected.includes(row.path)).map((row) => row.path))}>{t('OK')}</button>
          <button onClick={onClose}>{t('Cancel')}</button>
        </div>
      </div>
    </div>
  )
}
