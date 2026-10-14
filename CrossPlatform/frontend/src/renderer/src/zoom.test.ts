import { describe, expect, it } from 'vitest'
import { normalizeZoom, zoomIn, zoomLevels, zoomOut } from './zoom'

describe('zoom levels', () => {
  it('is dnSpy\'s own list, from 20% up to 400%', () => {
    expect(zoomLevels[0]).toBe(20)
    expect(zoomLevels[zoomLevels.length - 1]).toBe(400)
    expect(zoomLevels).toContain(100)
    expect(zoomLevels).toEqual([...zoomLevels].sort((a, b) => a - b))
  })

  it('steps up and down one level at a time', () => {
    expect(zoomIn(100)).toBe(110)
    expect(zoomOut(100)).toBe(91)
    expect(zoomIn(91)).toBe(100)
    expect(zoomOut(110)).toBe(100)
  })

  it('stops at either end rather than running off the list', () => {
    expect(zoomIn(400)).toBe(400)
    expect(zoomOut(20)).toBe(20)
    expect(zoomIn(999)).toBe(400)
    expect(zoomOut(0)).toBe(20)
  })
})

describe('normalizeZoom', () => {
  it('takes a level inside the range as it is', () => {
    expect(normalizeZoom(150)).toBe(150)
    expect(normalizeZoom(20)).toBe(20)
    expect(normalizeZoom(400)).toBe(400)
  })

  it('snaps a level within 5% of 100 back to it, as dnSpy does', () => {
    expect(normalizeZoom(96)).toBe(100)
    expect(normalizeZoom(104.9)).toBe(100)
    expect(normalizeZoom(94)).toBe(94)
  })

  it('holds a level at either end', () => {
    expect(normalizeZoom(5000)).toBe(400)
    expect(normalizeZoom(4)).toBe(20)
  })

  it('reads anything that is not a number as 100%', () => {
    expect(normalizeZoom(Number.NaN)).toBe(100)
    expect(normalizeZoom(Number.POSITIVE_INFINITY)).toBe(100)
  })
})
