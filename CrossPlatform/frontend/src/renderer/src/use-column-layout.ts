import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'

/** A debugger list column: an identity and the CSS grid track it starts at. */
export interface ColumnLayoutColumn {
  key: string
  width: string
}

/** What a header cell gets: its key, the pointer handlers, and the resize grip's handlers. */
export interface ColumnHeaderProps {
  'data-column-key': string
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void
}

export interface ColumnLayout<T extends ColumnLayoutColumn = ColumnLayoutColumn> {
  /** The columns in display order; render headers, cells and copied rows in this order. */
  columns: T[]
  /** The value for `grid-template-columns`. */
  template: string
  headerProps(key: string): ColumnHeaderProps
  resizeHandleProps(key: string): {
    'data-column-resizer': string
    'aria-hidden': 'true'
    title: string
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
    onClick: (event: ReactMouseEvent<HTMLElement>) => void
  }
}

const SEPARATOR = '\u0001'
const MIN_WIDTH = 24

// jsdom implements neither, and a browser can reject a stale pointer id; the drag works without either.
const capturePointer = (element: HTMLElement, pointerId: number): void => {
  try {
    element.setPointerCapture?.(pointerId)
  }
  catch {
    // The pointer is already gone.
  }
}

const releasePointer = (element: HTMLElement, pointerId: number): void => {
  try {
    element.releasePointerCapture?.(pointerId)
  }
  catch {
    // The pointer is already gone.
  }
}

/**
 * dnSpy's debugger lists are WPF ListViews with GridView columns: a header can be dragged to another
 * position and its right edge dragged to resize it. WPF does not save either across restarts, so neither
 * does this: the layout belongs to the open window.
 *
 * The rows of the breakpoint and exception windows are grids of their own, not children of the header, so
 * the template is returned instead of being written into one element; those callers put it in a custom
 * property on the pane and let both the header and every row read it.
 */
export function useColumnLayout<T extends ColumnLayoutColumn>(columns: readonly T[], resizeLabel = 'Resize column'): ColumnLayout<T> {
  const keys = columns.map((column) => column.key).join(SEPARATOR)
  const baseKeys = useMemo(() => (keys ? keys.split(SEPARATOR) : []), [keys])
  const [order, setOrder] = useState<string[]>(baseKeys)
  const [widths, setWidths] = useState<Record<string, number>>({})
  const drag = useRef<{ key: string; startX: number; moved: boolean; row: HTMLElement } | null>(null)
  const suppressClick = useRef(false)

  const displayKeys = useMemo(() => {
    if (baseKeys.length === 0)
      return []
    const present = new Set(baseKeys)
    const result = order.filter((key) => present.has(key))
    for (const key of baseKeys) {
      if (!result.includes(key))
        result.push(key)
    }
    return result
  }, [order, baseKeys])

  const byKey = useMemo(() => new Map(columns.map((column) => [column.key, column])), [columns])
  const ordered = useMemo(
    () => displayKeys.map((key) => byKey.get(key)).filter((column): column is T => column !== undefined),
    [displayKeys, byKey],
  )
  const template = ordered.map((column) => (widths[column.key] === undefined ? column.width : `${widths[column.key]}px`)).join(' ')

  const finishDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    const current = drag.current
    drag.current = null
    if (!current)
      return
    releasePointer(event.currentTarget, event.pointerId)
    if (!current.moved)
      return
    // The click that follows the drag would sort the column; swallow it once.
    suppressClick.current = true
    const headers = [...current.row.querySelectorAll<HTMLElement>('[data-column-key]')]
    const target = headers.find((header) => {
      const rect = header.getBoundingClientRect()
      return event.clientX < rect.left + rect.width / 2
    })
    // Dropping in the dragged header's own left half lands before itself: nothing moves.
    if (target?.dataset.columnKey === current.key)
      return
    const remaining = displayKeys.filter((key) => key !== current.key)
    const index = target ? remaining.indexOf(target.dataset.columnKey ?? '') : -1
    setOrder(index < 0 ? [...remaining, current.key] : [...remaining.slice(0, index), current.key, ...remaining.slice(index)])
  }

  const headerProps = (key: string): ColumnHeaderProps => ({
    'data-column-key': key,
    onPointerDown: (event) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest('[data-column-resizer]'))
        return
      // A drag that ended without a click must not swallow the next one.
      suppressClick.current = false
      const row = event.currentTarget.parentElement
      if (!row)
        return
      drag.current = { key, startX: event.clientX, moved: false, row }
      capturePointer(event.currentTarget, event.pointerId)
    },
    onPointerMove: (event) => {
      const current = drag.current
      if (current && !current.moved && Math.abs(event.clientX - current.startX) >= 4)
        current.moved = true
    },
    onPointerUp: finishDrag,
    onPointerCancel: (event) => {
      drag.current = null
      releasePointer(event.currentTarget, event.pointerId)
    },
    onClickCapture: (event) => {
      if (!suppressClick.current)
        return
      suppressClick.current = false
      event.stopPropagation()
      event.preventDefault()
    },
  })

  const resizeHandleProps = (key: string): ReturnType<ColumnLayout['resizeHandleProps']> => ({
    'data-column-resizer': key,
    'aria-hidden': 'true',
    title: resizeLabel,
    onPointerDown: (event) => {
      if (event.button !== 0)
        return
      event.preventDefault()
      event.stopPropagation()
      const header = (event.currentTarget as HTMLElement).parentElement
      if (!header)
        return
      const startX = event.clientX
      const startWidth = header.getBoundingClientRect().width
      const move = (moveEvent: PointerEvent): void => {
        setWidths((current) => ({ ...current, [key]: Math.max(MIN_WIDTH, Math.round(startWidth + moveEvent.clientX - startX)) }))
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    },
    onClick: (event) => {
      event.stopPropagation()
    },
  })

  return { columns: ordered, template, headerProps, resizeHandleProps }
}
