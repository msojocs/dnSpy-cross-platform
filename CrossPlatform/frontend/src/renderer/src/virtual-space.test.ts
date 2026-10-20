import { describe, expect, it } from 'vitest'
import { caretAtVisualColumn, virtualSelectionExtent, virtualSpacesAt, visualColumnOf } from './virtual-space'

describe('virtual space', () => {
  it('counts screen columns the way the view lays a tab out', () => {
    expect(visualColumnOf('abc', 1, 4)).toBe(0)
    expect(visualColumnOf('abc', 4, 4)).toBe(3)
    expect(visualColumnOf('\tx', 2, 4)).toBe(4)
    expect(visualColumnOf('ab\tx', 4, 4)).toBe(4)
  })

  it('lands a vertical move on the nearest boundary, and past the end in virtual space', () => {
    // Inside the text the caret goes to the screen column, as dnSpy's preferred x coordinate does.
    expect(caretAtVisualColumn('abcdef', 3, 4)).toEqual({ column: 4, virtualSpaces: 0 })
    // A tab is one character four columns wide; the caret takes whichever of its edges is nearer.
    expect(caretAtVisualColumn('\tx', 1, 4)).toEqual({ column: 1, virtualSpaces: 0 })
    expect(caretAtVisualColumn('\tx', 3, 4)).toEqual({ column: 2, virtualSpaces: 0 })
    // A shorter line puts the caret at its end and the rest of the way in virtual spaces.
    expect(caretAtVisualColumn('ab', 7, 4)).toEqual({ column: 3, virtualSpaces: 5 })
    expect(caretAtVisualColumn('', 4, 4)).toEqual({ column: 1, virtualSpaces: 4 })
    expect(caretAtVisualColumn('ab', 2, 4)).toEqual({ column: 3, virtualSpaces: 0 })
  })

  it('rounds a press past the end to the nearest virtual space', () => {
    expect(virtualSpacesAt(0, 8)).toBe(0)
    expect(virtualSpacesAt(3.9, 8)).toBe(0)
    expect(virtualSpacesAt(4.1, 8)).toBe(1)
    expect(virtualSpacesAt(31, 8)).toBe(4)
    expect(virtualSpacesAt(-20, 8)).toBe(0)
  })

  it('draws the part of a selection that lies past the end of its last line', () => {
    const at = (lineNumber: number, column: number, virtualSpaces = 0) => ({ lineNumber, column, virtualSpaces })
    // From inside the line to four spaces past its end (its max column being 6).
    expect(virtualSelectionExtent(at(2, 1), at(2, 6, 4), 6)).toEqual({ line: 2, from: 0, to: 4 })
    // Both ends past the end of the same line: only what lies between them.
    expect(virtualSelectionExtent(at(2, 6, 2), at(2, 6, 5), 6)).toEqual({ line: 2, from: 2, to: 5 })
    // A selection from a line above covers its last line's text and then the virtual spaces.
    expect(virtualSelectionExtent(at(1, 6, 3), at(2, 6, 2), 6)).toEqual({ line: 2, from: 0, to: 2 })
    // An end in the text has nothing in virtual space.
    expect(virtualSelectionExtent(at(1, 1), at(2, 3), 6)).toBeUndefined()
  })
})
