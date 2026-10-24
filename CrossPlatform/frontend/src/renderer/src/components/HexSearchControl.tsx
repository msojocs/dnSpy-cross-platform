import { useEffect, useRef } from 'react'
import { HEX_DATA_KINDS, type HexDataKind } from '../hex-search'
import { useLanguage } from '../localization'
import { HEX_SEARCH_ICONS } from './hex-search-icons'

/** What dnSpy's hex search control shows: its kind, the two strings, the options and whether the last search
 * found anything. */
export interface HexSearchState {
  kind: 'find' | 'replace' | 'incrementalForward' | 'incrementalBackward'
  searchString: string
  replaceString: string
  matchCase: boolean
  bigEndian: boolean
  dataKind: HexDataKind
  foundMatch: boolean
  searching: boolean
}

const SearchIcon = ({ name }: { name: keyof typeof HEX_SEARCH_ICONS }): React.JSX.Element => (
  <svg width="17" height="17" viewBox="0 0 17 17" aria-hidden="true" focusable="false">
    {HEX_SEARCH_ICONS[name].map(([brush, path], index) => <path key={index} d={path} fill={`var(--wpf-${brush})`} />)}
  </svg>
)

/**
 * dnSpy's hex `SearchControl`: the replace toggle, the search box with Find Previous, Find Next and Close, the
 * replace row and the options row (Match Case, Big Endian and the data kind). It floats over the view's top
 * right corner; the view owns the search itself and hands this the state and the commands.
 */
export const HexSearchControl = ({ state, canReplace, replaceReady = canReplace, focusRequest, atBottom = false, controlRef, onChange, onFindNext, onReplaceNext, onReplaceAll, onToggleReplace, onClose, onKeyDown }: {
  state: HexSearchState
  canReplace: boolean
  /** Whether the search and the replacement are valid, which the two replace buttons need. */
  replaceReady?: boolean
  /** Bumped to move the focus into the search box (or the replace box) and select its text. */
  focusRequest: { target: 'search' | 'replace'; token: number }
  /** `SearchControlPosition.BottomRight`: the control moves out of the way of a match it would cover. */
  atBottom?: boolean
  controlRef?: React.Ref<HTMLDivElement>
  onChange(change: Partial<HexSearchState>): void
  onFindNext(forward: boolean): void
  onReplaceNext(): void
  onReplaceAll(): void
  onToggleReplace(): void
  onClose(): void
  /** The control's own key bindings that act on the view: Ctrl+F, Ctrl+H, F3 and the rest. */
  onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void
}): React.JSX.Element => {
  const { t } = useLanguage()
  const searchRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<HTMLInputElement>(null)
  const incremental = state.kind === 'incrementalForward' || state.kind === 'incrementalBackward'
  const replaceMode = state.kind === 'replace'
  const showOptions = state.kind === 'find' || state.kind === 'replace'

  useEffect(() => {
    if (focusRequest.token === 0)
      return
    const input = focusRequest.target === 'replace' ? replaceRef.current : searchRef.current
    input?.focus()
    input?.select()
  }, [focusRequest])

  const tip = (text: string, shortcut?: string): string => shortcut ? `${t(text)} (${shortcut})` : t(text)
  const boxClass = ['hex-search-text', !state.foundMatch ? 'not-found' : '', state.searching ? 'searching' : ''].filter(Boolean).join(' ')

  return (
    <div
      ref={controlRef}
      className={`hex-search-control${atBottom ? ' at-bottom' : ''}`}
      role="search"
      aria-label={t('Find')}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={`hex-search-toggle${replaceMode ? ' expanded' : ''}`}
        aria-pressed={replaceMode}
        aria-label={t('Toggle to switch between find and replace modes')}
        title={t('Toggle to switch between find and replace modes')}
        onClick={onToggleReplace}
      >
        <svg width="9" height="7" viewBox="0 0 9 7" aria-hidden="true"><path d="M1,1.5 L4.5,5 L8,1.5" fill="none" strokeWidth="2" /></svg>
      </button>
      <div className="hex-search-row">
        <input
          ref={searchRef}
          className={boxClass}
          aria-label={t('Find')}
          readOnly={incremental}
          value={state.searchString}
          onChange={(event) => onChange({ searchString: event.target.value })}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button type="button" className="icon-button hex-search-button" tabIndex={-1} aria-label={t('Find previous')} title={tip('Find previous', 'Shift+F3')} onClick={() => onFindNext(false)}><SearchIcon name="findPrevious" /></button>
        <button type="button" className="icon-button hex-search-button" tabIndex={-1} aria-label={t('Find next')} title={tip('Find next', 'F3')} onClick={() => onFindNext(true)}><SearchIcon name="findNext" /></button>
        <button type="button" className="hex-search-close" tabIndex={-1} aria-label={t('Close')} title={tip('Close', 'Esc')} onClick={onClose}>
          <svg width="10" height="8" viewBox="0 0 10 8" aria-hidden="true"><path d="M0,0 L2,0 L5,3 L8,0 L10,0 L6,4 L10,8 L8,8 L5,5 L2,8 L0,8 L4,4 L0,0" /></svg>
        </button>
      </div>
      {replaceMode && (
        <div className="hex-search-row hex-search-replace-row">
          <input
            ref={replaceRef}
            className="hex-search-text"
            aria-label={t('Replace')}
            disabled={!canReplace}
            value={state.replaceString}
            onChange={(event) => onChange({ replaceString: event.target.value })}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button type="button" className="icon-button hex-search-button" tabIndex={-1} aria-label={t('Replace next')} title={tip('Replace next', 'Alt+R')} disabled={!replaceReady} onClick={onReplaceNext}><SearchIcon name="replaceNext" /></button>
          <button type="button" className="icon-button hex-search-button" tabIndex={-1} aria-label={t('Replace all')} title={tip('Replace all', 'Alt+A')} disabled={!replaceReady} onClick={onReplaceAll}><SearchIcon name="replaceAll" /></button>
        </div>
      )}
      {showOptions && (
        <div className="hex-search-row hex-search-options">
          <button type="button" className="icon-button hex-search-button" aria-pressed={state.matchCase} aria-label={t('Match case')} title={tip('Match case', 'Alt+C')} onClick={() => onChange({ matchCase: !state.matchCase })}><SearchIcon name="matchCase" /></button>
          <button type="button" className="icon-button hex-search-button" aria-pressed={state.bigEndian} aria-label={t('Big endian')} title={tip('Big endian', 'Alt+B')} onClick={() => onChange({ bigEndian: !state.bigEndian })}><SearchIcon name="bigEndian" /></button>
          <select aria-label={t('Data kind')} value={state.dataKind} onChange={(event) => onChange({ dataKind: event.target.value as HexDataKind })}>
            {HEX_DATA_KINDS.map((entry) => (
              <option key={entry.kind} value={entry.kind}>{entry.label}{entry.shortcut ? ` (${entry.shortcut})` : ''}</option>
            ))}
          </select>
        </div>
      )}
      <div className="hex-search-focus-bar" />
    </div>
  )
}
