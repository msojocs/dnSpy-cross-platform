import { Actions, showPopupMenu, TabSetNode, type IPopupMenuItem, type PopupMenuEntry, type TabNode } from 'flexlayout-react'
import { useLanguage } from '../localization'
import { CloseGlyph, DropDownGlyph } from './DsGlyphs'
import { MenuEntryIcon } from './DsIcon'

interface DockPaneProps {
  /** The pane's tab: its name is what the caption is titled with, and its tab set is the pane the caption
   * belongs to — the one the dropdown lists the windows of and the close button takes the tab out of. */
  tab: TabNode
  children: React.ReactNode
}

/**
 * The caption dnSpy draws across the top of a docked pane: the pane's title, a dotted rule along the rest
 * of the bar, and the pane's own dropdown and close buttons at its end. The pane that was last worked in
 * wears the blue caption, the way the active one does upstream; the others stay in the surface colour.
 *
 * A pane whose tab set shows a tab strip keeps it: the strip runs along the bottom edge of the pane, under
 * the caption, and it is what switches between the tabs, which is also what the dropdown lists. A dock
 * holding a single window shows no strip — one window is not a tab group — and the dropdown is then the
 * only list; see `syncDockTabStrips`.
 */
export const DockPane = ({ tab, children }: DockPaneProps): React.JSX.Element => {
  const { t } = useLanguage()
  const model = tab.getModel()
  const parent = tab.getParent()
  const name = tab.getName()
  const active = parent instanceof TabSetNode && parent.isActive()

  const showWindowMenu = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (!(parent instanceof TabSetNode))
      return
    const selected = parent.getSelectedNode()
    const items: PopupMenuEntry[] = parent.getTabNodes().map((child): IPopupMenuItem => ({
      key: child.getId(),
      content: (
        <>
          <span className="dock-menu-check" aria-hidden="true"><MenuEntryIcon checked={child === selected} /></span>
          <span className="dock-menu-label">{child.getName()}</span>
        </>
      ),
      onSelect: () => model.doAction(Actions.selectTab(child.getId())),
    }))
    showPopupMenu({
      anchor: event.currentTarget,
      returnFocusTo: event.currentTarget,
      container: tab.getLayoutRef() ?? undefined,
      title: t('Window'),
      items,
      onClose: () => undefined,
    })
  }

  return (
    <div className="dock-pane">
      <div className={`dock-caption${active ? ' dock-caption-active' : ''}`}>
        <span className="dock-caption-title" title={name}>{name}</span>
        <span className="dock-caption-dots" aria-hidden="true" />
        <button type="button" className="dock-caption-button dock-caption-menu" aria-label={t('Window')} aria-haspopup="menu" onClick={showWindowMenu}>
          {/* The caption's MenuButton and PART_Close, with the tool window template's own glyphs. */}
          <DropDownGlyph />
        </button>
        {/* Closing a pane's last tab takes the pane with it when the dock does not outlive its windows,
            which is what upstream does with the ✕ in the same corner. */}
        <button type="button" className="dock-caption-button dock-caption-close" aria-label={t('Close')} disabled={!tab.isCloseable()} onClick={() => model.doAction(Actions.deleteTab(tab.getId()))}>
          <CloseGlyph />
        </button>
      </div>
      <div className="dock-pane-body">{children}</div>
    </div>
  )
}
