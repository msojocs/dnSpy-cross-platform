import type { HexRange, HexTargetResponse } from '../../../shared/protocol'
import type { HexBodyKind } from '../app-store'
import type { TranslationValues } from '../localization'

/**
 * The parts of a selection a "Show ... in Hex Editor" command jumps to. dnSpy registers these commands
 * once per node subtype and they are mutually exclusive, so only the first of each label ever shows.
 */
export type HexShowKind = 'statement' | 'instructions' | 'body' | 'fieldInitialValue' | 'resource'

/**
 * What the hex menu needs to know. It is a subset of `EditMenuContext`, so the Edit menu and the code
 * viewer's context menu can both drive it from the context object they already build.
 */
export interface HexMenuContext {
  t(message: string, values?: TranslationValues): string
  /** `selectedNode.kind` in the Edit menu, the reference under the caret in the context menu. */
  selectionKind?: string
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

/** Node kinds that live inside a module — dnSpy's `GetModuleNode(node) is not null`. */
const inModuleKinds = ['module', 'namespace', 'type', 'method', 'field', 'property', 'event', 'resource', 'resourceentry']

const inModule = (ctx: HexMenuContext): boolean =>
  ctx.selectionKind !== undefined && inModuleKinds.includes(ctx.selectionKind)

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
 * dnSpy's GROUP_HEX: every entry points at the bytes of the current selection — or, for the statement
 * command, at where the code document's caret is — which is why the group is driven by the resolved hex
 * target rather than by which kind of document happens to hold the focus. Shared by the Edit menu
 * (`edit-menu.ts`) and the code viewer's context menu (`CodeEditorContextMenu.tsx`) so the two can
 * never drift.
 */
export const hexMenuEntries: HexMenuEntry[] = [
  { order: 0, label: (ctx) => ctx.t('Open Hex Editor'), shortcut: 'Ctrl+X', visible: inModule, run: (ctx) => ctx.onOpenHex() },
  // An address reference inside a code document — dnSpy's ShowAddressReferenceInHexEditorCommand.
  { order: 10, label: (ctx) => ctx.t('Show in Hex Editor'), shortcut: 'Ctrl+X', visible: never, run: (ctx) => ctx.onShowHexAt('resource') },
  // The two "Show Instructions" commands are mutually exclusive upstream: this one runs off the
  // statement under the caret, the other off the selected method.
  { order: 20, label: (ctx) => ctx.t('Show Instructions in Hex Editor'), shortcut: 'Ctrl+X', visible: (ctx) => ctx.hexStatement !== undefined && !hasTarget(ctx.hexTarget?.method), run: (ctx) => ctx.onShowHexAt('statement') },
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
