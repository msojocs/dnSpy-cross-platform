import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAppStore } from '../app-store'
import { StringReference } from '../../shared/protocol'
import { useTranslation } from 'react-i18next'
import './StringReferencesPane.css'

interface StringReferencesPaneProps {
  workspaceId: string
}

type SortColumn = 'literal' | 'kind' | 'referrer' | 'module'
type SortDirection = 'asc' | 'desc'

export function StringReferencesPane({ workspaceId }: StringReferencesPaneProps) {
  const { t } = useTranslation()
  const [references, setReferences] = useState<StringReference[]>([])
  const [loading, setLoading] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [selectedReference, setSelectedReference] = useState<StringReference | null>(null)
  const [sortColumn, setSortColumn] = useState<SortColumn>('kind')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [matchFormatted, setMatchFormatted] = useState(false)
  const [searchCompilerGenerated, setSearchCompilerGenerated] = useState(true)

  const selectedModules = useAppStore((state) => {
    const tree = state.trees.get(workspaceId)
    if (!tree) return []
    return tree.selectedNodeIds
      .map(id => tree.nodes.get(id))
      .filter(node => node?.kind === 'assembly' || node?.kind === 'module')
      .map(node => node!.id)
  })

  const searchReferences = useCallback(async () => {
    setLoading(true)
    setReferences([])
    try {
      const moduleIds = selectedModules.length > 0 ? selectedModules : null
      const response = await window.dnSpy.searchStringReferences(
        workspaceId,
        moduleIds,
        searchCompilerGenerated
      )
      setReferences(response.references)
    } catch (error) {
      console.error('Failed to search string references:', error)
    } finally {
      setLoading(false)
    }
  }, [workspaceId, selectedModules, searchCompilerGenerated])

  const filteredReferences = useMemo(() => {
    if (!searchText) return references

    try {
      if (useRegex) {
        const regex = new RegExp(searchText, caseSensitive ? '' : 'i')
        return references.filter(ref => {
          const str = matchFormatted ? formatLiteral(ref.literal) : ref.literal
          return regex.test(str)
        })
      } else {
        const comparison = caseSensitive ? 'includes' : 'toLowerCase'
        const needle = caseSensitive ? searchText : searchText.toLowerCase()
        return references.filter(ref => {
          const str = matchFormatted ? formatLiteral(ref.literal) : ref.literal
          const haystack = caseSensitive ? str : str.toLowerCase()
          return haystack.includes(needle)
        })
      }
    } catch {
      // Invalid regex
      return references
    }
  }, [references, searchText, caseSensitive, useRegex, matchFormatted])

  const sortedReferences = useMemo(() => {
    const sorted = [...filteredReferences]
    sorted.sort((a, b) => {
      let comparison = 0
      switch (sortColumn) {
        case 'literal':
          comparison = a.literal.localeCompare(b.literal)
          break
        case 'kind':
          comparison = a.kind.localeCompare(b.kind)
          break
        case 'referrer':
          comparison = a.referrerLabel.localeCompare(b.referrerLabel)
          break
        case 'module':
          comparison = a.moduleName.localeCompare(b.moduleName)
          break
      }
      return sortDirection === 'asc' ? comparison : -comparison
    })
    return sorted
  }, [filteredReferences, sortColumn, sortDirection])

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      setSortColumn(column)
      setSortDirection('asc')
    }
  }

  const handleFollow = useCallback((reference: StringReference, newTab: boolean) => {
    if (!reference.nodeId) return

    const store = useAppStore.getState()
    if (newTab) {
      store.openDocument(workspaceId, reference.nodeId, 'csharp')
    } else {
      store.revealNode(workspaceId, reference.nodeId)
      store.openDocument(workspaceId, reference.nodeId, 'csharp')
    }

    // If there's an IL offset, try to navigate to it
    if (reference.ilOffset !== null && reference.ilOffset !== undefined) {
      // TODO: Navigate to IL offset in the document
    }
  }, [workspaceId])

  const handleDoubleClick = (reference: StringReference) => {
    handleFollow(reference, false)
  }

  const handleKeyDown = (event: React.KeyboardEvent, reference: StringReference) => {
    if (event.key === 'Enter') {
      const newTab = event.ctrlKey || event.shiftKey
      handleFollow(reference, newTab)
    }
  }

  const handleCopyLiteral = () => {
    if (selectedReference) {
      navigator.clipboard.writeText(formatLiteral(selectedReference.literal))
    }
  }

  const handleCopyRawLiteral = () => {
    if (selectedReference) {
      navigator.clipboard.writeText(selectedReference.literal)
    }
  }

  return (
    <div className="string-references-pane">
      <div className="string-references-toolbar">
        <input
          type="text"
          className="string-references-search"
          placeholder={t('stringReferences.searchPlaceholder', 'Search strings...')}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
        />
        <button onClick={searchReferences} disabled={loading}>
          {loading ? t('stringReferences.searching', 'Searching...') : t('stringReferences.refresh', 'Refresh')}
        </button>
        <label>
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.target.checked)}
          />
          {t('stringReferences.caseSensitive', 'Case sensitive')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={useRegex}
            onChange={(e) => setUseRegex(e.target.checked)}
          />
          {t('stringReferences.regex', 'Regex')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={matchFormatted}
            onChange={(e) => setMatchFormatted(e.target.checked)}
          />
          {t('stringReferences.matchFormatted', 'Match formatted')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={searchCompilerGenerated}
            onChange={(e) => setSearchCompilerGenerated(e.target.checked)}
          />
          {t('stringReferences.compilerGenerated', 'Compiler generated')}
        </label>
      </div>

      <div className="string-references-table-container">
        <table className="string-references-table">
          <thead>
            <tr>
              <th onClick={() => handleSort('literal')}>
                {t('stringReferences.literal', 'Literal')}
                {sortColumn === 'literal' && (sortDirection === 'asc' ? ' ▲' : ' ▼')}
              </th>
              <th onClick={() => handleSort('kind')}>
                {t('stringReferences.kind', 'Kind')}
                {sortColumn === 'kind' && (sortDirection === 'asc' ? ' ▲' : ' ▼')}
              </th>
              <th onClick={() => handleSort('referrer')}>
                {t('stringReferences.referrer', 'Referrer')}
                {sortColumn === 'referrer' && (sortDirection === 'asc' ? ' ▲' : ' ▼')}
              </th>
              <th onClick={() => handleSort('module')}>
                {t('stringReferences.module', 'Module')}
                {sortColumn === 'module' && (sortDirection === 'asc' ? ' ▲' : ' ▼')}
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedReferences.map((ref, index) => (
              <tr
                key={index}
                className={selectedReference === ref ? 'selected' : ''}
                onClick={() => setSelectedReference(ref)}
                onDoubleClick={() => handleDoubleClick(ref)}
                onKeyDown={(e) => handleKeyDown(e, ref)}
                tabIndex={0}
              >
                <td className="literal-cell">{formatLiteral(ref.literal)}</td>
                <td>{ref.kind}</td>
                <td>{ref.referrerLabel}</td>
                <td>{ref.moduleName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="string-references-status">
        {loading ? (
          t('stringReferences.loading', 'Loading...')
        ) : (
          t('stringReferences.count', '{{count}} string(s)', { count: sortedReferences.length })
        )}
      </div>
    </div>
  )
}

function formatLiteral(literal: string): string {
  // Format string literal like C# with escape sequences
  let result = '"'
  for (let i = 0; i < literal.length; i++) {
    const ch = literal[i]
    switch (ch) {
      case '\0':
        result += '\\0'
        break
      case '\t':
        result += '\\t'
        break
      case '\n':
        result += '\\n'
        break
      case '\r':
        result += '\\r'
        break
      case '\\':
        result += '\\\\'
        break
      case '"':
        result += '\\"'
        break
      default:
        if (ch < ' ' || ch > '~') {
          result += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
        } else {
          result += ch
        }
        break
    }
  }
  result += '"'
  return result
}
