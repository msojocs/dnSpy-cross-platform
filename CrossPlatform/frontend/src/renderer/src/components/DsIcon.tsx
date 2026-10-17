import { useDsImageClass } from '../ds-image'
import { MenuCheckGlyph } from './DsGlyphs'

/**
 * One of dnSpy's own images, at the size a menu entry and a tool bar button draw it. The drawing itself
 * comes from the stylesheet ds-image.ts keeps, so it is themed the same way every other one is.
 */
export const DsIcon = ({ name, size = 16, className }: { name: string; size?: number; className?: string }): React.JSX.Element => {
  const imageClass = useDsImageClass(name)
  return <span className={`ds-icon${imageClass ? ` ${imageClass}` : ''}${className ? ` ${className}` : ''}`} style={{ width: size, height: size }} aria-hidden />
}

/**
 * What a menu entry shows in its icon column, the way dnSpy's MenuItem templates draw it: a checked entry
 * shows the check mark's glyph panel in place of its image, any other entry its image (MenuService's
 * Add16x16Image), and an entry dnSpy gives no image to shows nothing.
 */
export const MenuEntryIcon = ({ name, checked = false }: { name?: string; checked?: boolean }): React.JSX.Element | null => {
  if (checked)
    return <span className="ds-menu-check-panel" aria-hidden="true"><MenuCheckGlyph /></span>
  return name ? <DsIcon name={name} /> : null
}
