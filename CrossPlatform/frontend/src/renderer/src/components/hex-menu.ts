import type { AddressReference, HexMethodTarget, HexRange, HexTargetResponse, TreeNode } from '../../../shared/protocol'
import type { HexBodyKind } from '../app-store'
import type { TranslationValues } from '../localization'

/**
 * The method a body command writes over, copies or pastes into: the node the target was resolved for — the patch
 * is aimed at it, which is what bounds it to the body — the file it is in, and where its body is.
 */
export interface HexBodyTarget {
  nodeId: string
  moduleId: string
  method: HexMethodTarget
}

/**
 * dnSpy's HexContext: what the hex commands act on, built by whoever shows them. It comes from one of two places —
 * the documents tree, whose one selected row the commands act on (`HexContext(creatorObject, nodes)`), or a
 * document viewer, whose caret they act on (`HexContext(documentViewer, textPosition, reference, isDefinition)`) —
 * or from neither, when the Edit menu is opened with the focus in neither, and then nothing is on the menu.
 * `treeHexContext` and `codeHexContext` build the two.
 */
export interface HexContextParts {
  /** Which of the two built the context: dnSpy's CreatorObject. The Go to MD Table Row entry wears its Shift+Alt+R
   *  for either of them and no gesture for neither. */
  hexCreator?: 'tree' | 'code'
  /**
   * The file Open Hex Editor opens, by the id the hex commands name a file by. From the tree it is the selected
   * row's own file when that row is one (a `DsDocumentNode`); from a viewer it is the file of the first node of
   * the document in front (`GetActiveAssemblyTreeNode`). A document that has no file has none.
   */
  hexFileModuleId?: string
  /**
   * Where the hex commands point: for the tree's one selected row, or for the member whose definition the caret is
   * on (`GetMemberDef`, which takes a definition and never resolves a reference). Only the tree has the parts that
   * need a node — a PE structure, a resource — so a viewer's target carries its member's parts alone.
   */
  hexTarget?: HexTargetResponse
  /** The node `hexTarget` was resolved for, which the body commands patch. */
  hexTargetNodeId?: string
  /** The statement under the caret of the viewer, which is what the statement's "Show Instructions in Hex Editor"
   *  acts on — dnSpy's `GetStatements(documentViewer, textPosition)`. */
  hexStatement?: { moduleId: string; range: HexRange }
  /** The address reference under the caret of the viewer — a file offset or an RVA a token comment writes. */
  addressReference?: AddressReference
  /**
   * How many bytes the clipboard's text holds as dnSpy's hexadecimal text (`ClipboardUtils.GetData(canBeEmpty:
   * false)`), or undefined when it holds none. Hex Paste Method Body is on the menu only for bytes that fit.
   */
  clipboardHexLength?: number
}

/**
 * What the hex menu needs to know. It is a subset of `EditMenuContext`, so the Edit menu, the code viewer's
 * context menu and the documents tree's can all drive it from the context object they already build.
 */
export interface HexMenuContext extends HexContextParts {
  t(message: string, values?: TranslationValues): string
  /** Opens the hex editor on an address reference. */
  onShowAddress?(address: AddressReference): void
  /** Opens a file in the hex editor, at its start. */
  onOpenHex(moduleId: string): void
  /** Opens a file in the hex editor on a range of its bytes, which it selects. */
  onShowHex(moduleId: string, range: HexRange): void
  onHexWriteBody(kind: HexBodyKind, target: HexBodyTarget): void
  onHexCopyBody(target: HexBodyTarget): void
  onHexPasteBody(target: HexBodyTarget): void
}

/** One entry of dnSpy's Edit menu hex group (MenuConstants.GROUP_HEX), in the group's own order. */
export interface HexMenuEntry {
  order: number
  /** The dnSpy image the entry wears (its ExportMenuItem's Icon), or none where dnSpy's has none. */
  icon?: string
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

/**
 * dnSpy's HexContext for the documents tree: the commands act on the selection only when it is one row
 * (`context.Nodes.Length == 1`), and `target` is what the backend resolved for that row. Open Hex Editor opens the
 * row's file when the row is a file; a part inside one names no file of its own.
 */
export const treeHexContext = (selection: readonly TreeNode[], target: HexTargetResponse | undefined): HexContextParts => {
  if (selection.length !== 1 || !target)
    return { hexCreator: 'tree' }
  const [node] = selection
  return {
    hexCreator: 'tree',
    hexFileModuleId: documentKinds.includes(node.kind) ? target.moduleId : undefined,
    hexTarget: target,
    hexTargetNodeId: node.id,
  }
}

/**
 * dnSpy's HexContext for a document viewer: the caret's reference and statement. Only a definition names a member
 * (`GetMemberDef` reads `context.Reference as IMemberDef` when `IsDefinition`); a call to a method names the
 * method the caret is in, not the one called, so a reference names nothing here. The commands that need a tree
 * node — a PE structure's, a resource's — have nothing to act on in a viewer.
 */
export const codeHexContext = (parts: {
  fileModuleId?: string
  definition?: { nodeId: string; target: HexTargetResponse }
  statement?: { moduleId: string; range: HexRange }
  address?: AddressReference
}): HexContextParts => ({
  hexCreator: 'code',
  hexFileModuleId: parts.fileModuleId,
  hexTarget: parts.definition && { ...parts.definition.target, resource: null, structure: null, structureData: null },
  hexTargetNodeId: parts.definition?.nodeId,
  hexStatement: parts.statement,
  addressReference: parts.address,
})

/**
 * dnSpy's ShowAddressReferenceInHexEditorCommand: the caret is on an address reference. While it shows, the
 * commands that would act on the document or the selection step aside — their GetAddressReference and
 * GetDocumentNode answer null first thing when it is visible.
 */
const addressShows = (ctx: HexMenuContext): boolean => ctx.addressReference !== undefined && ctx.onShowAddress !== undefined

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
 * are never on screen together. It steps aside itself for the method whose definition the caret is on.
 */
const statementCommandShows = (ctx: HexMenuContext): boolean =>
  !addressShows(ctx) && ctx.hexStatement !== undefined && !hasTarget(ctx.hexTarget?.method)

/** ShowHexNodeInHexEditorCommand (order 30): the selected row is a PE structure. */
const structureCommandShows = (ctx: HexMenuContext): boolean =>
  !addressShows(ctx) && !statementCommandShows(ctx) && hasTarget(ctx.hexTarget?.structure)

/** The method the body commands act on, with what they need to name it. */
const bodyTarget = (ctx: HexMenuContext): HexBodyTarget | undefined => {
  const method = ctx.hexTarget?.method
  return hasTarget(method) && ctx.hexTarget && ctx.hexTargetNodeId !== undefined
    ? { nodeId: ctx.hexTargetNodeId, moduleId: ctx.hexTarget.moduleId, method }
    : undefined
}

/** Runs a body command on the method the context names. */
const withBody = (run: (ctx: HexMenuContext, target: HexBodyTarget) => void) => (ctx: HexMenuContext): void => {
  const target = bodyTarget(ctx)
  if (target)
    run(ctx, target)
}

/** Opens the bytes of one part of the hex target. */
const showPart = (part: (target: HexTargetResponse) => HexRange | null | undefined) => (ctx: HexMenuContext): void => {
  const range = ctx.hexTarget ? part(ctx.hexTarget) : undefined
  if (ctx.hexTarget && hasTarget(range))
    ctx.onShowHex(ctx.hexTarget.moduleId, range)
}

/**
 * dnSpy's TVChangeBodyHexEditorCommand.IsVisibleInternal: a write command shows when it has bytes for the method
 * and they fit the body. The backend hands each canned body over only when it fits, so a null template hides the
 * entry; the pasted bytes are the clipboard's, measured when the menu opened.
 */
const pasteFits = (ctx: HexMenuContext): boolean => {
  const method = ctx.hexTarget?.method
  return bodyTarget(ctx) !== undefined && hasTarget(method) && ctx.clipboardHexLength !== undefined && ctx.clipboardHexLength <= method.bodySize
}

/**
 * dnSpy's GROUP_HEX, shared by the Edit menu (`edit-menu.ts`), the code viewer's context menu
 * (`CodeEditorContextMenu.tsx`) and the documents tree's (`AssemblyExplorerContextMenu.tsx`) so the three
 * can never drift. Every entry reads the context it was given — the tree's selection or the viewer's caret —
 * and the first opens the file that context names.
 */
// Every command that opens the hex editor wears DsImages.Binary; the body writers and the copy and paste
// commands have no image (dnSpy.AsmEditor/Hex/Commands.cs).
export const hexMenuEntries: HexMenuEntry[] = [
  { order: 0, icon: 'Binary', label: (ctx) => ctx.t('Open Hex Editor'), shortcut: 'Ctrl+X', visible: (ctx) => !addressShows(ctx) && !statementCommandShows(ctx) && !structureCommandShows(ctx) && ctx.hexFileModuleId !== undefined, run: (ctx) => { if (ctx.hexFileModuleId !== undefined) ctx.onOpenHex(ctx.hexFileModuleId) } },
  // An address reference inside a code document — dnSpy's ShowAddressReferenceInHexEditorCommand.
  { order: 10, icon: 'Binary', label: (ctx) => ctx.t('Show in Hex Editor'), shortcut: 'Ctrl+X', visible: addressShows, run: (ctx) => { if (ctx.addressReference) ctx.onShowAddress?.(ctx.addressReference) } },
  // The two "Show Instructions" commands are mutually exclusive upstream: this one runs off the
  // statement under the caret, the other off the method the context names.
  { order: 20, icon: 'Binary', label: (ctx) => ctx.t('Show Instructions in Hex Editor'), shortcut: 'Ctrl+X', visible: statementCommandShows, run: (ctx) => { if (ctx.hexStatement) ctx.onShowHex(ctx.hexStatement.moduleId, ctx.hexStatement.range) } },
  // A node of the PE tree — a header, the tables stream, a metadata table or one of its rows: its own bytes.
  { order: 30, icon: 'Binary', label: (ctx) => ctx.t('Show in Hex Editor'), shortcut: 'Ctrl+X', visible: structureCommandShows, run: showPart((target) => target.structure) },
  // A section header or a metadata stream: the data it describes.
  { order: 40, icon: 'Binary', label: (ctx) => ctx.t('Show Data in Hex Editor'), visible: (ctx) => !addressShows(ctx) && !statementCommandShows(ctx) && hasTarget(ctx.hexTarget?.structureData), run: showPart((target) => target.structureData) },
  { order: 50, icon: 'Binary', label: (ctx) => ctx.t('Show Instructions in Hex Editor'), visible: (ctx) => hasTarget(ctx.hexTarget?.method), run: showPart((target) => target.method && { offset: target.method.codeOffset, length: target.method.codeSize }) },
  { order: 60, icon: 'Binary', label: (ctx) => ctx.t('Show Method Body in Hex Editor'), visible: (ctx) => hasTarget(ctx.hexTarget?.method), run: showPart((target) => target.method && { offset: target.method.bodyOffset, length: target.method.bodySize }) },
  { order: 70, icon: 'Binary', label: (ctx) => ctx.t('Show Initial Value in Hex Editor'), visible: (ctx) => hasTarget(ctx.hexTarget?.fieldInitialValue), run: showPart((target) => target.fieldInitialValue) },
  { order: 80, icon: 'Binary', label: (ctx) => ctx.t('Show in Hex Editor'), visible: (ctx) => hasTarget(ctx.hexTarget?.resource), run: showPart((target) => target.resource) },
  { order: 90, label: (ctx) => ctx.t("Hex Write 'return true' Body"), visible: (ctx) => bodyTarget(ctx) !== undefined && hasTarget(ctx.hexTarget?.method?.returnTrueBody), run: withBody((ctx, target) => ctx.onHexWriteBody('returnTrue', target)) },
  { order: 100, label: (ctx) => ctx.t("Hex Write 'return false' Body"), visible: (ctx) => bodyTarget(ctx) !== undefined && hasTarget(ctx.hexTarget?.method?.returnFalseBody), run: withBody((ctx, target) => ctx.onHexWriteBody('returnFalse', target)) },
  { order: 110, label: (ctx) => ctx.t('Hex Write Empty Body'), visible: (ctx) => bodyTarget(ctx) !== undefined && hasTarget(ctx.hexTarget?.method?.emptyBody), run: withBody((ctx, target) => ctx.onHexWriteBody('empty', target)) },
  { order: 120, label: (ctx) => ctx.t('Hex Copy Method Body'), visible: (ctx) => bodyTarget(ctx) !== undefined, run: withBody((ctx, target) => ctx.onHexCopyBody(target)) },
  { order: 130, label: (ctx) => ctx.t('Hex Paste Method Body'), visible: pasteFits, run: withBody((ctx, target) => ctx.onHexPasteBody(target)) },
]

/** The hex entries that are on screen for this context, in group order. */
export const visibleHexMenuEntries = (ctx: HexMenuContext): HexMenuEntry[] =>
  hexMenuEntries.filter((entry) => entry.visible(ctx))

/**
 * dnSpy's OpenHexEditorCommand.ExecuteCommand, Ctrl+X: the address reference under the caret, else the caret's
 * statement, else the selected PE structure, else the file the context names — the first of the four that has
 * something to open. Answers whether one ran, which is what the key's CanExecute is.
 */
export const runHexShortcut = (ctx: HexMenuContext): boolean => {
  for (const order of [10, 20, 30, 0]) {
    const entry = hexMenuEntries.find((candidate) => candidate.order === order)
    if (entry?.visible(ctx)) {
      entry.run(ctx)
      return true
    }
  }
  return false
}
