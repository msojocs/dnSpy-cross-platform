import { describe, expect, it } from 'vitest'
import { backgroundImageSize, limitImageSize, parseTimeSpan, placementAlignment } from './background-image'

describe('parseTimeSpan', () => {
  it('reads dnSpy\'s time span strings, which is what the Interval box holds', () => {
    expect(parseTimeSpan('00:05:00')).toBe(300_000)
    expect(parseTimeSpan('01:00')).toBe(3_600_000)
    expect(parseTimeSpan('1.00:00:00')).toBe(86_400_000)
    expect(parseTimeSpan('00:00:01.5')).toBe(1500)
  })

  it('whitespace around it is not part of it', () => {
    expect(parseTimeSpan('  00:10  ')).toBe(600_000)
  })

  it('has no time for a string that names none', () => {
    expect(parseTimeSpan('5 minutes')).toBeUndefined()
    expect(parseTimeSpan('')).toBeUndefined()
    expect(parseTimeSpan('00:5:00')).toBeUndefined()
  })
})

describe('backgroundImageSize', () => {
  const image = { width: 200, height: 100 }
  const viewport = { width: 800, height: 800 }

  it('draws the image at its own size for Stretch.None', () => {
    expect(backgroundImageSize(image, viewport, 'none', 'both')).toEqual({ width: 200, height: 100 })
  })

  it('fills the viewport for Stretch.Fill, however that distorts it', () => {
    expect(backgroundImageSize(image, viewport, 'fill', 'both')).toEqual({ width: 800, height: 800 })
  })

  it('fits the image inside for Uniform, and covers the viewport for UniformToFill', () => {
    expect(backgroundImageSize(image, viewport, 'uniform', 'both')).toEqual({ width: 800, height: 400 })
    expect(backgroundImageSize(image, viewport, 'uniformToFill', 'both')).toEqual({ width: 1600, height: 800 })
  })

  it('never shrinks an image for StretchDirection.UpOnly, nor grows one for DownOnly', () => {
    const small = { width: 100, height: 100 }
    // Uniform would shrink the 2000x1000 image to fit the viewport; Up Only leaves it at its own size.
    const wide = { width: 2000, height: 1000 }
    expect(backgroundImageSize(wide, viewport, 'uniform', 'upOnly')).toEqual({ width: 2000, height: 1000 })
    expect(backgroundImageSize(wide, viewport, 'uniform', 'both')).toEqual({ width: 800, height: 400 })
    // Down Only does the opposite: a small image is not blown up to fill the viewport.
    expect(backgroundImageSize(small, viewport, 'uniform', 'downOnly')).toEqual({ width: 100, height: 100 })
  })

  it('draws nothing until the image has said how large it is', () => {
    expect(backgroundImageSize({ width: 0, height: 0 }, viewport, 'uniform', 'both')).toEqual({ width: 0, height: 0 })
  })
})

describe('limitImageSize', () => {
  it('leaves a size alone when dnSpy\'s limits are 0, which is how it spells "no limit"', () => {
    expect(limitImageSize({ width: 800, height: 400 }, 0, 0)).toEqual({ width: 800, height: 400 })
  })

  it('holds a size down to the limits that are set', () => {
    expect(limitImageSize({ width: 800, height: 400 }, 320, 0)).toEqual({ width: 320, height: 400 })
    expect(limitImageSize({ width: 800, height: 400 }, 0, 100)).toEqual({ width: 800, height: 100 })
  })
})

describe('placementAlignment', () => {
  it('puts the image at each of dnSpy\'s nine placements', () => {
    expect(placementAlignment('topLeft')).toEqual({ justifyContent: 'flex-start', alignItems: 'flex-start' })
    expect(placementAlignment('topRight')).toEqual({ justifyContent: 'flex-end', alignItems: 'flex-start' })
    expect(placementAlignment('bottomLeft')).toEqual({ justifyContent: 'flex-start', alignItems: 'flex-end' })
    expect(placementAlignment('bottomRight')).toEqual({ justifyContent: 'flex-end', alignItems: 'flex-end' })
    expect(placementAlignment('top')).toEqual({ justifyContent: 'center', alignItems: 'flex-start' })
    expect(placementAlignment('bottom')).toEqual({ justifyContent: 'center', alignItems: 'flex-end' })
    expect(placementAlignment('left')).toEqual({ justifyContent: 'flex-start', alignItems: 'center' })
    expect(placementAlignment('right')).toEqual({ justifyContent: 'flex-end', alignItems: 'center' })
    expect(placementAlignment('center')).toEqual({ justifyContent: 'center', alignItems: 'center' })
  })
})
