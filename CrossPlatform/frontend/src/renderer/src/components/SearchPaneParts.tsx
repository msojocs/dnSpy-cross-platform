import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { SearchResult, SearchType } from '../../../shared/protocol'
import { useLanguage } from '../localization'
import { SEARCH_TYPES } from '../search-model'
import { NodeIcon } from './AssemblyExplorer'
import { ColoredText } from './ColoredText'

/** How long the mouse rests on a row before its tooltip shows — the system's hover time WPF's tooltips wait. */
export const TOOLTIP_DELAY_MS = 400

/**
 * A tooltip that shows once the mouse has rested on something for a moment and goes when it leaves, the way a
 * WPF ToolTip does. `target` names what the tooltip is for; `x` and `y` are where the mouse rested.
 */
export const useHoverToolTip = <T,>(): {
  shown: { target: T; x: number; y: number } | undefined
  enter(target: T, event: React.MouseEvent): void
  move(event: React.MouseEvent): void
  hide(): void
} => {
  const [shown, setShown] = useState<{ target: T; x: number; y: number }>()
  const pending = useRef<{ target: T; x: number; y: number; timer: ReturnType<typeof setTimeout> }>(undefined)

  const cancel = (): void => {
    if (pending.current)
      clearTimeout(pending.current.timer)
    pending.current = undefined
  }
  const hide = useCallback((): void => {
    cancel()
    setShown(undefined)
  }, [])
  useEffect(() => cancel, [])

  const enter = (target: T, event: React.MouseEvent): void => {
    cancel()
    setShown(undefined)
    const timer = setTimeout(() => {
      const resting = pending.current
      pending.current = undefined
      if (resting)
        setShown({ target: resting.target, x: resting.x, y: resting.y })
    }, TOOLTIP_DELAY_MS)
    pending.current = { target, x: event.clientX, y: event.clientY, timer }
  }
  // Until it shows, the tooltip goes where the mouse comes to rest.
  const move = (event: React.MouseEvent): void => {
    if (pending.current)
      pending.current = { ...pending.current, x: event.clientX, y: event.clientY }
  }
  return { shown, enter, move, hide }
}

/**
 * A search result's tooltip — SearchResult.CreateToolTipUI: the member through the decompiler's WriteToolTip, the
 * instruction a match in a method body was found at, and the file. It is drawn with the syntax highlighting when
 * the list is, below and to the right of the mouse, kept inside the window.
 */
export const SearchResultToolTip = ({ result, syntaxHighlight, x, y }: { result: SearchResult; syntaxHighlight: boolean; x: number; y: number }): React.JSX.Element | null => {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x + 12, top: y + 18 })
  useLayoutEffect(() => {
    const element = ref.current
    if (!element)
      return
    const { width, height } = element.getBoundingClientRect()
    const left = Math.max(0, Math.min(x + 12, window.innerWidth - width - 4))
    const top = y + 18 + height > window.innerHeight ? Math.max(0, y - height - 4) : y + 18
    setPosition((current) => current.left === left && current.top === top ? current : { left, top })
  }, [x, y, result])
  if (!result.toolTip && !result.toolTipParts)
    return null
  return (
    <div ref={ref} className="search-tooltip code-colors" role="tooltip" style={position}>
      {syntaxHighlight && result.toolTipParts ? <ColoredText parts={result.toolTipParts} /> : result.toolTip}
    </div>
  )
}

/**
 * The "Search For" box: dnSpy's ComboBox of SearchTypeVMs, each entry its image and its name, with the Ctrl key
 * that picks it as the entry's tooltip. Closed, the arrow keys step through the entries the way a combo box's do;
 * Alt+Down, F4, Enter or Space opens the list.
 */
export const SearchTypeBox = ({ value, label, onChange }: { value: SearchType; label: string; onChange(type: SearchType): void }): React.JSX.Element => {
  const { t } = useLanguage()
  const id = useId()
  const [open, setOpen] = useState(false)
  const selectedIndex = Math.max(0, SEARCH_TYPES.findIndex((entry) => entry.type === value))
  const [active, setActive] = useState(selectedIndex)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const current = SEARCH_TYPES[selectedIndex]

  const show = (): void => {
    setActive(selectedIndex)
    setOpen(true)
  }
  const choose = (index: number): void => {
    setOpen(false)
    const entry = SEARCH_TYPES[index]
    if (entry && entry.type !== value)
      onChange(entry.type)
  }

  // A click anywhere else closes the list.
  useEffect(() => {
    if (!open)
      return
    const onMouseDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node))
        setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown, true)
    return () => document.removeEventListener('mousedown', onMouseDown, true)
  }, [open])

  useLayoutEffect(() => {
    if (open)
      listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active])

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const last = SEARCH_TYPES.length - 1
    let handled = true
    if (!open) {
      if ((event.altKey && event.key === 'ArrowDown') || event.key === 'F4' || event.key === 'Enter' || event.key === ' ')
        show()
      else if (event.altKey || event.ctrlKey || event.metaKey)
        handled = false
      else if (event.key === 'ArrowDown')
        choose(Math.min(selectedIndex + 1, last))
      else if (event.key === 'ArrowUp')
        choose(Math.max(selectedIndex - 1, 0))
      else if (event.key === 'Home')
        choose(0)
      else if (event.key === 'End')
        choose(last)
      else
        handled = false
    } else if (event.key === 'Escape' || (event.altKey && event.key === 'ArrowUp') || event.key === 'F4')
      setOpen(false)
    else if (event.key === 'Enter' || event.key === ' ')
      choose(active)
    else if (event.key === 'Tab') {
      choose(active)
      handled = false
    } else if (event.key === 'ArrowDown')
      setActive(Math.min(active + 1, last))
    else if (event.key === 'ArrowUp')
      setActive(Math.max(active - 1, 0))
    else if (event.key === 'Home')
      setActive(0)
    else if (event.key === 'End')
      setActive(last)
    else
      handled = false
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  const keyTip = (key?: string): string | undefined => key ? `Ctrl+${key.toUpperCase()}` : undefined
  return (
    <div ref={rootRef} className="search-type-box">
      <button
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        data-value={value}
        title={keyTip(current.key)}
        onClick={() => open ? setOpen(false) : show()}
        onKeyDown={onKeyDown}
      >
        <span className="search-type-icon"><NodeIcon icon={current.icon} /></span>
        <span className="search-type-name">{t(current.label)}</span>
        <ChevronDown size={12} aria-hidden />
      </button>
      {open && (
        <ul ref={listRef} id={`${id}-list`} className="search-type-list" role="listbox" aria-label={label}>
          {SEARCH_TYPES.map((entry, index) => (
            <li
              key={entry.type}
              id={`${id}-${index}`}
              role="option"
              aria-selected={index === selectedIndex}
              data-index={index}
              data-value={entry.type}
              className={index === active ? 'active' : undefined}
              title={keyTip(entry.key)}
              onMouseEnter={() => setActive(index)}
              // The button keeps the focus while the list is open.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              <span className="search-type-icon"><NodeIcon icon={entry.icon} /></span>
              <span className="search-type-name">{t(entry.label)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
