import type { HexRange, HexTargetResponse } from '../../../shared/protocol'
import type { HexBodyKind } from '../app-store'
import type { TranslationValues } from '../localization'

/**
 * The parts of a selection a "Show ... in Hex Editor" command jumps to. dnSpy registers these commands
 * once per node subtype and they are mutually exclusive, so only the first of each label ever shows.
 */
export type HexShowKind = 'statement' | 'instructions' | 'body' | 'fieldInitialValue' | 'resource'

/**
 * What the hex menu needs to know. It is a subset of `EditMenuContext`, so the Edit menu, the code
 * viewer's context menu and the documents tree's can all drive it from the context object they already
 * build.
 */
export interface HexMenuContext {
  t(message: string, values?: TranslationValues): string
  /** `selectedNode.kind` in the Edit menu, the reference under the caret in the context menu. */
  selectionKind?: string
  /**
   * Whether a file-backed document is open in a viewer, which is dnSpy's `GetActiveAssemblyTreeNode`
   * answering with the file the active document belongs to. The code viewer's own context menu always has
   * one, the documents tree's never does, and the Edit menu has one while a code document is open.
   */
  documentAvailable?: boolean
  /**
   * Where the hex commands point for the selection. dnSpy resolves this from the selection itself;
   * here the backend answers it when the selection changes, so the menu only has to read it.
   */
  hexTarget?: HexTargetResponse
  /** The statement under the caret of the focused code document, which is what "Show Instructions in
   * Hex Editor" acts on when the selection is not a method. */
  hexStatement?: { moduleId: string; range: HexRange }
  /** Opens the selected module in a hex tab. */
  onOpenHex(): void
  /** Opens the module in a hex tab and jumps to the bytes of this part of the selection. */
  onShowHexAt(kind: HexShowKind): void
  onHexWriteBody(kind: HexBodyKind): void
  onHexCopyBody(): void
  onHexPasteBody(): void
}

/** One entry of dnSpy's Edit menu hex group (MenuConstants.GROUP_HEX), in the group's own order. */
export interface HexMenuEntry {
  order: number
  label(ctx: HexMenuContext): string
  shortcut?: string
  visible(ctx: HexMenuContext): boolean
  run(ctx: HexMenuContext): void
}

/**
 * Tree rows that stand for a file the hex editor can open: dnSpy's `DsDocumentNode` and its subtypes — an
 * assembly, a module, a PE-only file, an ELF image, and a file nothing could be read from. Every other row
 * is a *part* inside one of those files, and a part is what the commands that read the resolved hex target
 * act on, not the file the command that opens the hex editor opens.
 */
const documentKinds = ['assembly', 'module', 'pedocument', 'elfdocument', 'unknowndocument']

const isDocumentRow = (ctx: HexMenuContext): boolean =>
  ctx.selectionKind !== undefined && documentKinds.includes(ctx.selectionKind)

// Items dnSpy shows only for node types this port has no equivalent of (address references into a hex
// editor, a hex document's own tree, PE section headers). They stay in the table so the group keeps
// WPF's shape, but never show.
const never = (): boolean => false

/**
 * Whether a resolved hex target has a part to point at. The target arrives as JSON, where the parts a
 * node does not have are spelled out as null rather than left off, so a part being absent is null and
 * never undefined.
 */
const hasTarget = <T,>(part: T | null | undefined): part is T => part !== undefined && part !== null

/**
 * The command that acts on the caret's own statement rather than on the selection (order 20 below). dnSpy
 * builds it and the file command from a single `GetDocumentNode`, and that helper answers null while a
 * command acting on the caret's reference is visible — so the file command steps aside for it and the two
 * are never on screen together.
 */
const statementCommandShows = (ctx: HexMenuContext): boolean =>
  ctx.hexStatement !== undefined && !hasTarget(ctx.hexTarget?.method)

/**
 * dnSpy's GROUP_HEX, shared by the Edit menu (`edit-menu.ts`), the code viewer's context menu
 * (`CodeEditorContextMenu.tsx`) and the documents tree's (`AssemblyExplorerContextMenu.tsx`) so the three
 * can never drift. Every entry but the first points at the bytes of the current selection, which is why
 * they are driven by the resolved hex target rather than by which kind of document holds the focus; the
 * first opens the file the selection or the open document belongs to, so its own rule reads that instead.
 */
export const hexMenuEntries: HexMenuEntry[] = [
  { order: 0, label: (ctx) => ctx.t('Open Hex Editor'), shortcut: 'Ctrl+X', visible: (ctx) => !statementCommandShows(ctx) && (isDocumentRow(ctx) || ctx.documentAvailable === true), run: (ctx) => ctx.onOpenHex() },
  // An address reference inside a code document — dnSpy's ShowAddressReferenceInHexEditorCommand.
  { order: 10, label: (ctx) => ctx.t('Show in Hex Editor'), shortcut: 'Ctrl+X', visible: never, run: (ctx) => ctx.onShowHexAt('resource') },
  // The two "Show Instructions" commands are mutually exclusive upstream: this one runs off the
  // statement under the caret, the other off the selected method.
  { order: 20, label: (ctx) => ctx.t('Show Instructions in Hex Editor'), shortcut: 'Ctrl+X', visible: statementCommandShows, run: (ctx) => ctx.onShowHexAt('statement') },
  // A node of a hex document's own tree (PE headers, metadata tables), which this port does not model.
  { order: 30, label: (ctx) => ctx.t('Show in Hex Editor'), shortcut: 'Ctrl+X', visible: never, run: (ctx) => ctx.onShowHexAt('resource') },
  // A PE section header or a metadata stream node, likewise absent here.
  { order: 40, label: (ctx) => ctx.t('Show Data in Hex Editor'), visible: never, run: (ctx) => ctx.onShowHexAt('resource') },
  { order: 50, label: (ctx) => ctx.t('Show Instructions in Hex Editor'), visible: (ctx) => hasTarget(ctx.hexTarget?.method), run: (ctx) => ctx.onShowHexAt('instructions') },
  { order: 60, label: (ctx) => ctx.t('Show Method Body in Hex Editor'), visible: (ctx) => hasTarget(ctx.hexTarget?.method), run: (ctx) => ctx.onShowHexAt('body') },
  { order: 70, label: (ctx) => ctx.t('Show Initial Value in Hex Editor'), visible: (ctx) => hasTarget(ctx.hexTarget?.fieldInitialValue), run: (ctx) => ctx.onShowHexAt('fieldInitialValue') },
  { order: 80, label: (ctx) => ctx.t('Show in Hex Editor'), visible: (ctx) => hasTarget(ctx.hexTarget?.resource), run: (ctx) => ctx.onShowHexAt('resource') },
  // The backend hands each write command its bytes only when they exist and fit the body, which is
  // exactly dnSpy's visibility test, so a null template is what hides the entry.
  { order: 90, label: (ctx) => ctx.t("Hex Write 'return true' Body"), visible: (ctx) => hasTarget(ctx.hexTarget?.method?.returnTrueBody), run: (ctx) => ctx.onHexWriteBody('returnTrue') },
  { order: 100, label: (ctx) => ctx.t("Hex Write 'return false' Body"), visible: (ctx) => hasTarget(ctx.hexTarget?.method?.returnFalseBody), run: (ctx) => ctx.onHexWriteBody('returnFalse') },
  { order: 110, label: (ctx) => ctx.t('Hex Write Empty Body'), visible: (ctx) => hasTarget(ctx.hexTarget?.method?.emptyBody), run: (ctx) => ctx.onHexWriteBody('empty') },
  { order: 120, label: (ctx) => ctx.t('Hex Copy Method Body'), visible: (ctx) => hasTarget(ctx.hexTarget?.method), run: (ctx) => ctx.onHexCopyBody() },
  { order: 130, label: (ctx) => ctx.t('Hex Paste Method Body'), visible: (ctx) => hasTarget(ctx.hexTarget?.method), run: (ctx) => ctx.onHexPasteBody() },
]

/** The hex entries that are on screen for this context, in group order. */
export const visibleHexMenuEntries = (ctx: HexMenuContext): HexMenuEntry[] =>
  hexMenuEntries.filter((entry) => entry.visible(ctx))
