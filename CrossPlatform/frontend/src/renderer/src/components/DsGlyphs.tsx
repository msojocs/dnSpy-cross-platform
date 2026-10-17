/**
 * The small vector glyphs dnSpy's WPF templates draw themselves rather than take from its image set — the
 * menu's check mark and submenu arrow, the tree's expander, the caption buttons of its windows and tool
 * windows (dnSpy/dnSpy/Themes/wpf.styles.templates.xaml). Each is the template's own Path data, filled with the
 * text colour of wherever it sits, which is what the templates bind their Fill to.
 */

interface GlyphProps {
  className?: string
}

const glyph = (width: number, height: number, path: string, { className }: GlyphProps): React.JSX.Element => (
  <svg className={`ds-glyph${className ? ` ${className}` : ''}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
    <path fill="currentColor" d={path} />
  </svg>
)

/** The MenuItem templates' "Checkmark" geometry, which the glyph panel draws in place of the item's icon. */
export const MenuCheckGlyph = (props: GlyphProps): React.JSX.Element =>
  glyph(16, 16, 'M5,11L3,7 5,7 6,9 9,3 11,3 7,11 5,11z', props)

/** The submenu header template's "RightArrow" geometry, at the end of an entry that opens a submenu. */
export const SubmenuArrowGlyph = (props: GlyphProps): React.JSX.Element =>
  glyph(4, 7, 'M0,0 L4,3.5 L0,7 Z', props)

/** The tool window caption's window-position button (MenuButton), and any drop-down that wears it. */
export const DropDownGlyph = (props: GlyphProps): React.JSX.Element =>
  glyph(8, 4, 'M0,0 L4,4 L8,0 L0,0z', props)

/** The cross on a tab's, a tool window's and a dialog's close button (CloseButtonCross, WinSysType Close). */
export const CloseGlyph = (props: GlyphProps): React.JSX.Element =>
  glyph(10, 8, 'M0,0L2,0 5,3 8,0 10,0 6,4 10,8 8,8 5,5 2,8 0,8 4,4 0,0z', props)

/** WinSysButton's Minimize. */
export const MinimizeGlyph = (props: GlyphProps): React.JSX.Element =>
  glyph(9, 9, 'M0,6L0,9 9,9 9,6 0,6z', props)

/** WinSysButton's Maximize. */
export const MaximizeGlyph = (props: GlyphProps): React.JSX.Element =>
  glyph(9, 9, 'M0,0L0,9 9,9 9,0 0,0 0,3 8,3 8,8 1,8 1,3z', props)

/** WinSysButton's Restore. */
export const RestoreGlyph = (props: GlyphProps): React.JSX.Element =>
  glyph(10, 10, 'M0,10L0,3 3,3 3,0 10,0 10,2 4,2 4,3 7,3 7,6 6,6 6,5 1,5 1,10z M1,10L7,10 7,7 10,7 10,2 9,2 9,6 6,6 6,9 1,9z', props)

/**
 * ExpandCollapseToggleStyle, the expander of dnSpy's tree views: a hollow triangle pointing right while the
 * node is collapsed, turned to a filled one pointing down and to the right once it is expanded. The template
 * centres the 7×7 path in a 16×16 box and turns it about (3, 3) — 135° collapsed, 180° expanded.
 */
export const TreeExpanderGlyph = ({ expanded, className }: GlyphProps & { expanded: boolean }): React.JSX.Element => (
  <svg className={`ds-glyph ds-tree-expander${expanded ? ' expanded' : ''}${className ? ` ${className}` : ''}`} width={16} height={16} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path
      d="M0.5,0.5 L0.5,6.5 L6.5,0.5 z"
      fill={expanded ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1}
      transform={`translate(4.5 4.5) rotate(${expanded ? 180 : 135} 3 3)`}
    />
  </svg>
)

/** The ComboBox template's ArrowDownPath, at the end of a drop-down list's box. */
export const ComboBoxArrowGlyph = (props: GlyphProps): React.JSX.Element =>
  glyph(6, 3, 'M 0 0 L 3 3 L 6 0 Z', props)

/**
 * ExpanderDownHeaderStyle, the toggle of an Expander such as the search window's Options: a 19×19 circle with
 * a chevron in it that points down while the expander is shut and up once it is open.
 */
export const ExpanderGlyph = ({ expanded, className }: GlyphProps & { expanded: boolean }): React.JSX.Element => (
  <svg className={`ds-glyph ds-expander${className ? ` ${className}` : ''}`} width={19} height={19} viewBox="0 0 19 19" aria-hidden="true" focusable="false">
    <circle className="ds-expander-circle" cx={9.5} cy={9.5} r={9} fill="none" stroke="currentColor" />
    <path d={expanded ? 'M 1,4.5 L 4.5,1 L 8,4.5' : 'M 1,1.5 L 4.5,5 L 8,1.5'} fill="none" stroke="currentColor" strokeWidth={2} transform="translate(5 6.5)" />
  </svg>
)
