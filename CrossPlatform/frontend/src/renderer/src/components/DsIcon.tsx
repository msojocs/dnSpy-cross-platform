import { useDsImageClass } from '../ds-image'

/**
 * One of dnSpy's own images, at the size a menu entry and a tool bar button draw it. The drawing itself
 * comes from the stylesheet ds-image.ts keeps, so it is themed the same way every other one is.
 */
export const DsIcon = ({ name, size = 16 }: { name: string; size?: number }): React.JSX.Element => {
  const imageClass = useDsImageClass(name)
  return <span className={`ds-icon${imageClass ? ` ${imageClass}` : ''}`} style={{ width: size, height: size }} aria-hidden />
}
