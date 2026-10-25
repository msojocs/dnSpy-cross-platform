import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useColumnLayout } from './use-column-layout'

afterEach(cleanup)

// jsdom lays nothing out, so each test gives the headers the rectangles a real row would have.
const Harness = (): React.JSX.Element => {
  const layout = useColumnLayout([
    { key: 'a', width: '100px' },
    { key: 'b', width: '200px' },
    { key: 'c', width: '300px' },
  ])
  return (
    <div data-testid="grid" style={{ gridTemplateColumns: layout.template }}>
      <div>
        {layout.columns.map((column) => (
          <div key={column.key} role="columnheader" {...layout.headerProps(column.key)}>
            {column.key}
            <span {...layout.resizeHandleProps(column.key)} />
          </div>
        ))}
      </div>
    </div>
  )
}

const setRects = (): void => {
  screen.getAllByRole('columnheader').forEach((header, index) => {
    header.getBoundingClientRect = () => ({ left: index * 100, width: 100, right: (index + 1) * 100, top: 0, bottom: 25, height: 25, x: index * 100, y: 0, toJSON: () => ({}) }) as DOMRect
  })
}

const headerNames = (): string[] => screen.getAllByRole('columnheader').map((header) => header.textContent ?? '')

describe('useColumnLayout', () => {
  it('starts with the columns in the order and tracks they were declared with', () => {
    render(<Harness />)
    expect(headerNames()).toEqual(['a', 'b', 'c'])
    expect(screen.getByTestId('grid').style.gridTemplateColumns).toBe('100px 200px 300px')
  })

  it('resizes a column by dragging the grip on its right edge', () => {
    render(<Harness />)
    setRects()
    const grip = screen.getAllByRole('columnheader')[0].querySelector('[data-column-resizer]')!
    fireEvent.pointerDown(grip, { button: 0, clientX: 10, pointerId: 1 })
    fireEvent.pointerMove(document.body, { clientX: 60, pointerId: 1 })
    fireEvent.pointerUp(document.body, { pointerId: 1 })
    expect(screen.getByTestId('grid').style.gridTemplateColumns).toBe('150px 200px 300px')
  })

  it('moves a column to where its header was dragged', () => {
    render(<Harness />)
    setRects()
    const a = screen.getAllByRole('columnheader')[0]
    fireEvent.pointerDown(a, { button: 0, clientX: 50, pointerId: 1 })
    fireEvent.pointerMove(a, { clientX: 210, pointerId: 1 })
    fireEvent.pointerUp(a, { clientX: 210, pointerId: 1 })
    // 210 is past b's middle and before c's, so a lands between them.
    expect(headerNames()).toEqual(['b', 'a', 'c'])
  })

  it('leaves the order alone when the pointer did not move', () => {
    render(<Harness />)
    setRects()
    const a = screen.getAllByRole('columnheader')[0]
    fireEvent.pointerDown(a, { button: 0, clientX: 50, pointerId: 1 })
    fireEvent.pointerUp(a, { clientX: 52, pointerId: 1 })
    expect(headerNames()).toEqual(['a', 'b', 'c'])
  })
})
