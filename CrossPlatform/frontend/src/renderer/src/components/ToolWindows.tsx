import { useState } from 'react'
import { Search } from 'lucide-react'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'

export const OutputPane = (): React.JSX.Element => {
  const output = useAppStore((state) => state.output)
  return (
    <div className="output-pane" role="log">
      {output.map((line, index) => <div key={`${index}:${line}`}>{line}</div>)}
    </div>
  )
}

export const SearchPane = ({ onOpenNodeId }: { onOpenNodeId(nodeId: string): void }): React.JSX.Element => {
  const [query, setQuery] = useState('')
  const workspaceId = useAppStore((state) => state.workspaceId)
  const results = useAppStore((state) => state.searchResults)
  const runSearch = useAppStore((state) => state.runSearch)
  const { t } = useLanguage()

  const submit = (): void => {
    if (workspaceId)
      void runSearch(query)
  }

  return (
    <div className="tool-pane search-pane">
      <div className="search-controls">
        <input
          value={query}
          placeholder={t('Search assemblies')}
          aria-label={t('Search assemblies')}
          disabled={!workspaceId}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') submit() }}
        />
        <button className="icon-button" title={t('Search')} aria-label={t('Search')} disabled={!workspaceId || !query.trim()} onClick={submit}>
          <Search size={15} />
        </button>
      </div>
      <div className="result-list">
        {results.map((result, index) => (
          <button
            key={`${result.nodeId}:${index}`}
            className="result-row"
            onDoubleClick={() => {
              onOpenNodeId(result.nodeId)
            }}
          >
            <span className="result-name">{result.name}</span>
            <span className="result-location">{result.location}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

export const DebugPlaceholder = ({ label }: { label: string }): React.JSX.Element => (
  <div className="pane-empty">{label}</div>
)
