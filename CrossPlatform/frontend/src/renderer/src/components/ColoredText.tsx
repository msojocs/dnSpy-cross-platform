import type { TextPart } from '../../../shared/protocol'

/**
 * A row's text with dnSpy's syntax highlighting: each stretch in the color class the backend gave it. The
 * stylesheet maps the classes to the theme's colors, and the high-contrast theme leaves them all plain.
 */
export const ColoredText = ({ parts }: { parts: TextPart[] }): React.JSX.Element => (
  <>
    {parts.map((part, index) => <span key={index} className={`tc-${part.color}`}>{part.text}</span>)}
  </>
)
