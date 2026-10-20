import type { DecompileResponse, DecompilerLanguage } from '../../shared/protocol'

/** How often entries are looked at, and how long one may go unused before it goes — DecompilationCache's
 *  CLEAR_OLD_ITEMS_EVERY_MS and OLD_ITEM_MS. */
export const CLEAR_OLD_ITEMS_EVERY_MS = 30 * 1000
export const OLD_ITEM_MS = 5 * 60 * 1000

/** What decides whether an edit makes a cached document stale: the modules it was decompiled from and refers to. */
export interface CachedDocumentModules {
  /**
   * The roots — assemblies and other documents of the tree — its nodes hang under; undefined when one of them could
   * not be told, which any edit then counts against.
   */
  roots: string[] | undefined
}

interface Item {
  response: DecompileResponse
  modules: CachedDocumentModules
  lastHit: number
}

/** Which roots a module edit touched, and how to tell the root a node or a module path belongs to. */
export interface ModifiedModules {
  roots: ReadonlySet<string>
  modulePaths: ReadonlySet<string>
  /** The root a node hangs under, when the tree knows it. */
  rootOf(nodeId: string): string | undefined
}

/**
 * dnSpy's DecompilationCache: the documents decompiled so far, by decompiler, nodes and decompiler settings, so a
 * tab shows one again at once — with no wait adorner — instead of decompiling it again. An entry nothing asked for
 * in five minutes is dropped; an edit, a removal or a reload drops the entries of the modules it touched and of the
 * documents that refer to them, and loading another document list drops everything.
 */
export class DecompilationCache {
  private readonly items = new Map<string, Item>()
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** The key of a document: dnSpy's Key(decompiler, nodes, settings), and the workspace its node ids are from. */
  static keyOf(workspaceId: string, language: DecompilerLanguage, nodeIds: readonly string[], settingsKey: string): string {
    return JSON.stringify([workspaceId, language, nodeIds, settingsKey])
  }

  get size(): number {
    return this.items.size
  }

  lookup(key: string): DecompileResponse | undefined {
    const item = this.items.get(key)
    if (!item)
      return undefined
    item.lastHit = this.now()
    return item.response
  }

  cache(key: string, response: DecompileResponse, modules: CachedDocumentModules): void {
    this.items.set(key, { response, modules, lastHit: this.now() })
    this.scheduleClearOld()
  }

  /** DecompilationCache.ClearOld: drops what nothing asked for in OLD_ITEM_MS. */
  clearOld(): void {
    const now = this.now()
    for (const [key, item] of this.items) {
      if (now - item.lastHit > OLD_ITEM_MS)
        this.items.delete(key)
    }
  }

  clearAll(): void {
    this.items.clear()
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /**
   * DecompilationCache.Clear(modules): the documents of a modified module, and the ones whose references lead into
   * one (InModifiedModuleHelper). A document whose own modules are not known is dropped too.
   */
  clearModules(modified: ModifiedModules): void {
    for (const [key, item] of this.items) {
      if (isInModifiedModule(item, modified))
        this.items.delete(key)
    }
  }

  private scheduleClearOld(): void {
    if (this.timer !== undefined)
      return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.clearOld()
      if (this.items.size > 0)
        this.scheduleClearOld()
    }, CLEAR_OLD_ITEMS_EVERY_MS)
  }
}

const isInModifiedModule = (item: Item, modified: ModifiedModules): boolean => {
  const roots = item.modules.roots
  if (!roots || roots.some((root) => modified.roots.has(root)))
    return true
  const checked = new Set<string>()
  for (const span of item.response.spans) {
    if (span.targetModulePath && modified.modulePaths.has(span.targetModulePath))
      return true
    const target = span.targetNodeId
    if (!target || checked.has(target))
      continue
    checked.add(target)
    const root = modified.rootOf(target)
    if (root !== undefined && modified.roots.has(root))
      return true
  }
  return false
}

/** The one cache the document tabs share. */
export const decompilationCache = new DecompilationCache()
