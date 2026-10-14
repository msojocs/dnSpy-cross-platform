import type { ClassifiedSpan, TextPart } from '../../../shared/protocol'

/**
 * A row's text with dnSpy's syntax highlighting: each stretch in the color class the backend gave it. The
 * stylesheet maps the classes to the theme's colors, and the high-contrast theme leaves them all plain.
 */
export const ColoredText = ({ parts }: { parts: TextPart[] }): React.JSX.Element => (
  <>
    {parts.map((part, index) => <span key={index} className={`tc-${part.color}`}>{part.text}</span>)}
  </>
)

/**
 * Code with Roslyn's semantic colors: each classified span in its color class, the text between them plain. The
 * C# Interactive window draws a submission's echo with the colors its input had.
 */
export const ClassifiedText = ({ text, spans }: { text: string; spans: readonly ClassifiedSpan[] }): React.JSX.Element => {
  const pieces: React.JSX.Element[] = []
  let position = 0
  for (const span of spans) {
    if (span.start < position || span.start + span.length > text.length) continue
    if (span.start > position) pieces.push(<span key={`t${position}`}>{text.slice(position, span.start)}</span>)
    pieces.push(<span key={`c${span.start}`} className={`tc-${span.color}`}>{text.slice(span.start, span.start + span.length)}</span>)
    position = span.start + span.length
  }
  if (position < text.length) pieces.push(<span key={`t${position}`}>{text.slice(position)}</span>)
  return <>{pieces}</>
}
