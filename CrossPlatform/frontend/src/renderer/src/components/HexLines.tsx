import { Fragment, memo } from 'react'
import type { HexBufferLine, HexCell, HexLineFormatter, TextSpan } from '../hex-line'

/** Something drawn over a line's characters: a selection, a marker, a highlighted cell. */
export interface HexLineMarker {
  /** The line's index among the lines drawn, 0 being the top one. */
  row: number
  span: TextSpan
  /** The marker's CSS class, which carries the theme colour dnSpy's classification type has. */
  className: string
}

export interface HexLineGeometry {
  charWidth: number
  lineHeight: number
  /** Where a line's first character is drawn. */
  textLeft: number
}

export const spanLeft = (geometry: HexLineGeometry, position: number): number => geometry.textLeft + position * geometry.charWidth

/** The cells of a line that have a byte the view could not read: dnSpy's `HexByteError`. */
const isErrorCell = (line: HexBufferLine, cell: HexCell): boolean =>
  cell.hasData && line.text.slice(cell.textSpan.start, cell.textSpan.end).includes('?') && /^\?+$/.test(line.text.slice(cell.textSpan.start, cell.textSpan.end))

/**
 * One line of the dump, drawn as dnSpy's `DefaultTagger` colours it: the offset, the values in their two group
 * colours, the ASCII column, and the cells that could not be read in the error colour. Every cell is its own
 * span so a byte can be found by its offset.
 */
const HexLineText = memo(({ line, formatter, colorize, loaded, selection }: {
  line: HexBufferLine
  formatter: HexLineFormatter
  colorize: boolean
  loaded: boolean
  /** The selection, marked on the cells it covers so the selected bytes can be read off the page. */
  selection: { start: number; end: number } | undefined
}): React.JSX.Element => {
  const pieces: React.ReactNode[] = []
  const classOf = (base: string): string => colorize ? base : ''
  const selected = (cell: HexCell): boolean | undefined =>
    selection !== undefined && cell.hasData && cell.bufferStart < selection.end && cell.bufferEnd > selection.start ? true : undefined
  if (formatter.showOffset)
    pieces.push(<span key="o" className={classOf('hex-offset')}>{line.text.slice(formatter.offsetSpan.start, formatter.offsetSpan.end)}</span>)
  if (loaded) {
    if (formatter.showValues) {
      if (formatter.showOffset)
        pieces.push(' ')
      line.valueCells.forEach((cell, index) => {
        const error = isErrorCell(line, cell)
        pieces.push(
          <span
            key={`v${index}`}
            className={['hex-byte', classOf(error ? 'hex-byte-error' : cell.groupIndex === 0 ? 'hex-byte0' : 'hex-byte1')].filter(Boolean).join(' ')}
            data-hex-byte={cell.hasData ? cell.bufferStart : undefined}
            data-hex-column="values"
            data-selected={selected(cell)}
          >
            {line.text.slice(cell.cellSpan.start, cell.cellSpan.end)}
          </span>,
        )
        if (cell.separatorSpan.end > cell.separatorSpan.start)
          pieces.push(' ')
      })
    }
    if (formatter.showAscii) {
      if (formatter.showOffset || formatter.showValues)
        pieces.push(' ')
      line.asciiCells.forEach((cell, index) => {
        const text = line.text.slice(cell.cellSpan.start, cell.cellSpan.end)
        pieces.push(
          <span
            key={`a${index}`}
            className={['hex-byte', classOf(cell.hasData && text === '?' ? 'hex-byte-error' : 'hex-ascii')].filter(Boolean).join(' ')}
            data-hex-byte={cell.hasData ? cell.bufferStart : undefined}
            data-hex-column="ascii"
            data-selected={selected(cell)}
          >
            {text}
          </span>,
        )
      })
    }
  }
  return <>{pieces.map((piece, index) => typeof piece === 'string' ? <Fragment key={`s${index}`}>{piece}</Fragment> : piece)}</>
})
HexLineText.displayName = 'HexLineText'

/** The lines in the viewport, each at its row, with the markers drawn under the text and the carets over it. */
export const HexLines = ({ lines, formatter, geometry, colorize, markers, overlays, selection }: {
  lines: { line: HexBufferLine; loaded: boolean }[]
  formatter: HexLineFormatter
  geometry: HexLineGeometry
  colorize: boolean
  markers: HexLineMarker[]
  /** What is drawn over the text: the carets. */
  overlays: React.ReactNode
  selection: { start: number; end: number } | undefined
}): React.JSX.Element => (
  <>
    <div className="hex-marker-layer" aria-hidden="true">
      {markers.map((marker, index) => (
        <div
          key={index}
          className={`hex-marker ${marker.className}`}
          style={{ top: marker.row * geometry.lineHeight, left: spanLeft(geometry, marker.span.start), width: (marker.span.end - marker.span.start) * geometry.charWidth, height: geometry.lineHeight }}
        />
      ))}
    </div>
    <div className="hex-text-layer">
      {lines.map(({ line, loaded }, row) => (
        <div
          key={line.bufferStart}
          className="hex-line"
          data-line-offset={line.bufferStart}
          style={{ top: row * geometry.lineHeight, left: geometry.textLeft, height: geometry.lineHeight, lineHeight: `${geometry.lineHeight}px` }}
        >
          <HexLineText line={line} formatter={formatter} colorize={colorize} loaded={loaded} selection={selection} />
        </div>
      ))}
    </div>
    <div className="hex-caret-layer" aria-hidden="true">{overlays}</div>
  </>
)
