import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import {
  AtSign,
  Binary,
  Box,
  Boxes,
  Braces,
  Brackets,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Code2,
  FileBox,
  FileCode2,
  Files,
  Folder,
  FolderOpen,
  Hash,
  Library,
  ListOrdered,
  LoaderCircle,
  Network,
  Package,
  Parentheses,
  Quote,
  Search,
  SquareFunction,
  Variable,
  Zap,
} from 'lucide-react'
import type { TextPart, TreeNode } from '../../../shared/protocol'
import { tokenParts } from '../analyzer-model'
import { useAppStore } from '../app-store'
import { useDsImageClass } from '../ds-image'
import { useLanguage } from '../localization'
import { loadAppOptions, useAppOptions, type MemberKind } from './app-options'
import { ColoredText } from './ColoredText'
import { hasEmptyNamespaceSibling, resourceTargets, showAssemblyExplorerContextMenu, type AssemblyExplorerCommands } from './AssemblyExplorerContextMenu'

interface AssemblyExplorerProps {
  /**
   * The commands the tree's rows run: the shell owns them, because a dialog, a tool window or a new tab
   * belongs to the shell rather than to the tree. The object is rebuilt on every shell render so its
   * callbacks close over the newest handlers, which is why the rows read it through a ref.
   */
  commands: AssemblyExplorerCommands
}

/** What one memoized row needs: its place in the tree, how the options draw it, and the commands a click can run. */
interface ExplorerRowProps {
  node: TreeNode
  depth: number
  display: TreeRowDisplay
  /** dnSpy's ActivateItem — a double click, Enter or Space: open the row, or go where it points. */
  onActivate(node: TreeNode): void
  onContextMenu(node: TreeNode, position: { x: number; y: number }, returnFocusTo?: HTMLElement): void
}

/**
 * The Assembly Explorer options a row reads — dnSpy's DocumentTreeNodeDataContext. One object for all of
 * them, made once per change of the options, so a memoized row only redraws when one of them moved.
 */
export interface TreeRowDisplay {
  showToken: boolean
  syntaxHighlight: boolean
  showAssemblyVersion: boolean
  showAssemblyPublicKeyToken: boolean
  singleClickExpandsChildren: boolean
  /** dnSpy's ShowMember: the C# decompiler's "show hidden compiler generated types and methods". */
  showCompilerGenerated: boolean
  memberKindOrder: readonly MemberKind[]
}

/**
 * The family a row's image belongs to. The backend names images after dnSpy's own set (DsImages —
 * "ClassPublic", "MethodPrivate", "EnumerationItemProtected"), while the search window's type box and a
 * few older rows still use the short family names; both come down to the same family here, which is what
 * the row's class says and what draws a name dnSpy's set has no image for.
 */
export const iconFamily = (icon?: string): string => {
  if (!icon)
    return 'item'
  if (/^[a-z]/.test(icon))
    return icon
  const family = DS_IMAGE_FAMILIES.find(([prefix]) => icon.startsWith(prefix))
  return family ? family[1] : 'item'
}

// Longest names first: "EnumerationItem" before "Enumeration", "AssemblyExe" before "Assembly".
const DS_IMAGE_FAMILIES: [string, string][] = [
  ['AssemblyExe', 'assembly-exe'],
  ['AssemblyError', 'error'],
  ['Assembly', 'assembly'],
  ['Module', 'module'],
  ['Namespace', 'namespace'],
  ['Reference', 'reference'],
  ['Library', 'reference'],
  ['FolderClosed', 'folder'],
  ['FolderOpened', 'folder'],
  ['BinaryFile', 'binary'],
  ['Binary', 'binary'],
  ['EnumerationItem', 'enum-item'],
  ['Enumeration', 'enum'],
  ['Structure', 'struct'],
  ['Interface', 'interface'],
  ['Delegate', 'delegate'],
  ['Exception', 'class'],
  ['Template', 'class'],
  ['Class', 'class'],
  ['Type', 'class'],
  ['ExtensionMethod', 'method'],
  ['Operator', 'method'],
  ['Method', 'method'],
  ['Constant', 'constant'],
  ['Field', 'field'],
  ['Property', 'property'],
  ['Event', 'event'],
  ['Search', 'search'],
  ['String', 'resource'],
  ['Image', 'resource'],
  ['SourceFileGroup', 'resource'],
  ['UserDefinedDataType', 'resource'],
  ['WPFFile', 'resource'],
  ['XMLFile', 'resource'],
  ['XMLSchema', 'resource'],
  ['XSLTransform', 'resource'],
  ['TextFile', 'resource'],
  ['CSFileNode', 'resource'],
  ['VBFileNode', 'resource'],
  ['Dialog', 'resource'],
]

/** dnSpy's image for each short family name — the ones its search window's type box wears for them. */
const FAMILY_IMAGES: Record<string, string> = {
  'assembly': 'Assembly',
  'assembly-exe': 'AssemblyExe',
  'module': 'ModulePublic',
  'namespace': 'Namespace',
  'reference': 'Reference',
  'resource': 'Dialog',
  'folder': 'FolderClosed',
  'binary': 'BinaryFile',
  'error': 'AssemblyError',
  'class': 'ClassPublic',
  'interface': 'InterfacePublic',
  'enum': 'EnumerationPublic',
  'struct': 'StructurePublic',
  'delegate': 'DelegatePublic',
  'method': 'MethodPublic',
  'field': 'FieldPublic',
  'constant': 'ConstantPublic',
  'enum-item': 'EnumerationItemPublic',
  'property': 'Property',
  'event': 'EventPublic',
  'parameter': 'Parameter',
  'local': 'LocalVariable',
  'literal': 'ConstantPublic',
  'search': 'Search',
}

/**
 * The name of dnSpy's image a row wears: the one the backend named, or a family's. A folder shows the open
 * folder while it is expanded — the ExpandedIcon dnSpy's folder nodes give their tree.
 */
export const dsImageName = (icon: string | undefined, expanded = false): string | undefined => {
  if (!icon)
    return undefined
  const name = /^[a-z]/.test(icon) ? FAMILY_IMAGES[icon] : icon
  return name === 'FolderClosed' && expanded ? 'FolderOpened' : name
}

/**
 * The tree's icon for a node, shared with the windows that show the same rows — the analyzer, the search
 * window, the type picker. It is dnSpy's own image, the access it shows included, in the colours dnSpy's
 * ThemedImageCreator gives it on the theme's background; a name dnSpy's set has no image for falls back to a
 * drawing of its family.
 */
export const NodeIcon = ({ icon, expanded = false }: { icon?: string; expanded?: boolean }): React.JSX.Element => {
  const imageClass = useDsImageClass(dsImageName(icon, expanded))
  if (imageClass)
    return <span className={`ds-image ${imageClass}`} aria-hidden="true" />
  return <FamilyIcon icon={icon} expanded={expanded} />
}

const FamilyIcon = ({ icon, expanded }: { icon?: string; expanded: boolean }): React.JSX.Element => {
  const props = { size: 15, strokeWidth: 1.6, 'aria-hidden': true as const }
  switch (iconFamily(icon)) {
    // These shapes follow dnSpy's WPF image set: assemblies are stacked documents, while a
    // module is the purple package shown beneath them in the tree.
    case 'assembly': return <Files {...props} />
    case 'assembly-exe': return <FileCode2 {...props} />
    case 'module': return <Package {...props} />
    // A file that is not a managed assembly: dnSpy shows a PE document with the assembly icon, an ELF image
    // and the structures read out of either with the binary one, and a file it could not read with the error.
    case 'binary': return <Binary {...props} />
    case 'error': return <CircleAlert {...props} />
    case 'namespace': return <Brackets {...props} />
    case 'reference': return <Library {...props} />
    case 'resource': return <FileBox {...props} />
    case 'folder': return expanded ? <FolderOpen {...props} /> : <Folder {...props} />
    case 'method': return <Code2 {...props} />
    case 'field': return <Variable {...props} />
    case 'constant': case 'enum-item': return <Hash {...props} />
    case 'property': return <Braces {...props} />
    case 'event': return <Zap {...props} />
    case 'interface': return <Network {...props} />
    case 'enum': return <ListOrdered {...props} />
    case 'struct': return <Boxes {...props} />
    case 'delegate': return <SquareFunction {...props} />
    // The search window's "Search For" box wears these too: a parameter, a local and a literal.
    case 'parameter': return <Parentheses {...props} />
    case 'local': return <AtSign {...props} />
    case 'literal': return <Quote {...props} />
    // The analyzer's search rows wear dnSpy's DsImages.Search.
    case 'search': return <Search {...props} />
    default: return <Box {...props} />
  }
}

// The kinds whose row names a type after the colon, and the ones dnSpy's NodeFormatter appends a raw
// metadata token to — the metadata rows inside a module: types, members, assembly references and the
// type hierarchy rows, which name a metadata type reference each. The document rows dnSpy builds a file
// node out of write no token (its assembly and module nodes pass showToken: false and its
// PE/ELF/unknown documents write the file name alone), and neither do namespaces, the group folders or
// resources.
const KINDS_WITH_RETURN_TYPE = new Set(['method', 'field', 'property', 'event'])
const KINDS_WITH_TOKEN = new Set(['type', 'assemblyreference', 'basetype', 'derivedtype', ...KINDS_WITH_RETURN_TYPE])

/**
 * The group folders dnSpy labels from its resource table rather than from the node. Their labels are
 * translated here; a type's own hierarchy rows wear the name of the type they name, and are left alone.
 */
const GROUP_FOLDER_KINDS = new Set(['referencesgroup', 'resourcesgroup', 'typereferencesgroup', 'basetypefolder', 'derivedtypesfolder'])

const formatMetadataToken = (token: number): string =>
  `@${(token >>> 0).toString(16).toUpperCase().padStart(8, '0')}`

/**
 * What dnSpy's NodeFormatter writes after an assembly's name — "(1.0.0.0, b77a5c561934e089)" — with each part
 * only when the Assembly Explorer options ask for it, and the token only when the assembly has one.
 */
const assemblySuffixParts = (node: TreeNode, display: Pick<TreeRowDisplay, 'showAssemblyVersion' | 'showAssemblyPublicKeyToken'>): TextPart[] => {
  if (node.kind !== 'assembly')
    return []
  const inside: TextPart[] = []
  if (display.showAssemblyVersion && node.assemblyVersion)
    inside.push({ text: node.assemblyVersion, color: 'number' })
  if (display.showAssemblyPublicKeyToken && node.publicKeyToken) {
    if (inside.length > 0)
      inside.push({ text: ',', color: 'punctuation' }, { text: ' ', color: 'text' })
    inside.push({ text: node.publicKeyToken, color: 'number' })
  }
  return inside.length === 0 ? [] : [{ text: ' ', color: 'text' }, { text: '(', color: 'punctuation' }, ...inside, { text: ')', color: 'punctuation' }]
}

/** The row text options that change what a row says rather than how it looks. */
type RowTextOptions = Pick<TreeRowDisplay, 'showToken' | 'showAssemblyVersion' | 'showAssemblyPublicKeyToken'>

const rowTextOptions = (options: boolean | RowTextOptions): RowTextOptions =>
  typeof options === 'boolean' ? { showToken: options, showAssemblyVersion: true, showAssemblyPublicKeyToken: false } : options

/**
 * The text a tree row wears — dnSpy's NodeFormatter writes "name : RetType @06000004": members name
 * their type after a colon, and a metadata row gets its token appended unless the user turned tokens
 * off. An assembly row writes its version and public key token the options ask for. The tooltip keeps
 * the bare label, which is the full signature the row abbreviates.
 */
export const composeTreeRowText = (label: string, node: TreeNode, options: boolean | RowTextOptions): string => {
  const { showToken, ...assembly } = rowTextOptions(options)
  const assemblySuffix = assemblySuffixParts(node, assembly).map((part) => part.text).join('')
  const typeSuffix = node.returnType != null && KINDS_WITH_RETURN_TYPE.has(node.kind) ? ` : ${node.returnType}` : ''
  const tokenSuffix = showToken && node.metadataToken != null && KINDS_WITH_TOKEN.has(node.kind) ? ` ${formatMetadataToken(node.metadataToken)}` : ''
  return `${label}${assemblySuffix}${typeSuffix}${tokenSuffix}`
}

/**
 * The same text cut where dnSpy's syntax highlighting changes color, as the backend colored the label and
 * the return type. A label the client words itself — a group folder's — is written plain. Only a row the
 * backend colored is drawn this way: one it sent no parts for is plain text in dnSpy too.
 */
export const composeTreeRowParts = (label: string, node: TreeNode, options: boolean | RowTextOptions): TextPart[] => {
  const { showToken, ...assembly } = rowTextOptions(options)
  const parts: TextPart[] = label === node.label && node.labelParts ? [...node.labelParts] : [{ text: label, color: 'text' }]
  // The backend colors an assembly's whole name and version; the version is the client's to write or not.
  // A row with no version part — a module whose assembly was converted away — keeps all it has.
  const versionAt = node.kind === 'assembly' && node.labelParts ? node.labelParts.findIndex((part) => part.text === ' ') : -1
  if (versionAt >= 0)
    parts.splice(versionAt, Infinity)
  parts.push(...assemblySuffixParts(node, assembly))
  if (node.returnType != null && KINDS_WITH_RETURN_TYPE.has(node.kind)) {
    parts.push({ text: ' ', color: 'text' }, { text: ':', color: 'punctuation' }, { text: ' ', color: 'text' })
    parts.push(...(node.returnTypeParts ?? [{ text: node.returnType, color: 'text' }]))
  }
  if (showToken && node.metadataToken != null && KINDS_WITH_TOKEN.has(node.kind))
    parts.push(...tokenParts(node.metadataToken))
  return parts
}

/**
 * The rows a type lists below its two hierarchy folders, in the order the Assembly Explorer options put the
 * member groups — dnSpy's DocumentTreeNodeGroups, whose order the options set. The backend lists them in
 * dnSpy's default order with each group sorted already, so this only moves the groups, never a row in one.
 */
export const orderTypeChildren = (children: readonly TreeNode[], order: readonly MemberKind[]): TreeNode[] => {
  const rank = new Map<string, number>(order.map((kind, index) => [MEMBER_KIND_OF_GROUP[kind], index]))
  const folders = children.filter((child) => !rank.has(child.kind))
  const members = children.filter((child) => rank.has(child.kind))
  // Array.prototype.sort is stable, so the backend's order inside each group survives.
  return [...folders, ...members.sort((left, right) => rank.get(left.kind)! - rank.get(right.kind)!)]
}

const MEMBER_KIND_OF_GROUP: Record<MemberKind, string> = {
  methods: 'method',
  properties: 'property',
  events: 'event',
  fields: 'field',
  nestedTypes: 'type',
}

/** The rows a node shows: dnSpy's ShowMember leaves the compiler's inventions out, and a type orders its groups. */
const visibleChildren = (parent: TreeNode, children: readonly TreeNode[], display: TreeRowDisplay): readonly TreeNode[] => {
  const shown = display.showCompilerGenerated ? children : children.filter((child) => !child.compilerGenerated)
  return parent.kind === 'type' ? orderTypeChildren(shown, display.memberKindOrder) : shown
}

/**
 * The rows that name something living elsewhere in the tree. Activating one — a double click, Enter —
 * selects what it names, the way dnSpy's DocumentTabService.NodeActivated does, instead of opening the row.
 */
const ACTIVATED_KINDS = new Set(['assemblyreference', 'basetype', 'derivedtype', 'typereference', 'methodreference', 'propertyreference', 'eventreference', 'fieldreference'])

type TreeState = Pick<ReturnType<typeof useAppStore.getState>, 'roots' | 'children' | 'expanded'>

/** The rows the tree shows, top to bottom — the list dnSpy's flattened tree is, which the keyboard walks and a
 *  Shift range spans. */
export const visibleRows = (state: TreeState, display: TreeRowDisplay): TreeNode[] => {
  const rows: TreeNode[] = []
  const walk = (nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      rows.push(node)
      const children = state.children[node.id]
      if (state.expanded[node.id] && children)
        walk(visibleChildren(node, children, display))
    }
  }
  walk(state.roots)
  return rows
}

/** The text a row is found by when the user types its first letters — what the row says. */
const rowSearchText = (node: TreeNode, display: TreeRowDisplay, translate: (text: string) => string): string =>
  composeTreeRowText(GROUP_FOLDER_KINDS.has(node.kind) ? translate(node.label) : node.label, node, display)

/**
 * dnSpy's SharpTreeViewTextSearch: typing the first letters of a row selects it. The letters typed in quick
 * succession make one prefix, matched from the current row on and wrapping around; typing the same letter again
 * steps to the next row it starts, and Backspace takes the last letter back. The prefix is forgotten after twice
 * the double-click time.
 */
export class TreeTextSearch {
  private prefix = ''
  private readonly typed: string[] = []
  private lastMatch = -1
  private active = false
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly timeout = 1000) {}

  /** The row to select for one more letter, or -1 for none. `current` is the selected row's index. */
  search(rows: readonly string[], letter: string, current: number): number {
    const start = this.active ? this.lastMatch : Math.max(0, current)
    const lookBackwards = this.typed.length > 0 && this.typed[this.typed.length - 1].toLowerCase() === letter.toLowerCase()
    const { index, used } = this.indexOfMatch(rows, this.prefix + letter, start, lookBackwards)
    let selected = -1
    if (index !== -1) {
      if (!this.active || index !== start) {
        selected = index
        this.lastMatch = index
      }
      if (used) {
        this.prefix += letter
        this.typed.push(letter)
      }
      this.active = true
    }
    if (this.active)
      this.resetTimeout()
    return selected
  }

  /** Takes the last letter back; answers whether there was one. */
  revertLastCharacter(): boolean {
    if (!this.active || this.typed.length === 0)
      return false
    this.prefix = this.prefix.slice(0, this.prefix.length - this.typed.pop()!.length)
    this.resetTimeout()
    return true
  }

  clear(): void {
    this.active = false
    this.prefix = ''
    this.lastMatch = -1
    this.typed.length = 0
    if (this.timer !== undefined)
      clearTimeout(this.timer)
    this.timer = undefined
  }

  private indexOfMatch(rows: readonly string[], needle: string, start: number, tryBackward: boolean): { index: number; used: boolean } {
    if (rows.length === 0 || needle.length === 0)
      return { index: -1, used: false }
    const lowerNeedle = needle.toLowerCase()
    const lowerPrefix = this.prefix.toLowerCase()
    let fallbackIndex = -1
    let fallbackMatch = false
    let i = start
    do {
      const text = rows[i].toLowerCase()
      if (text.startsWith(lowerNeedle))
        return { index: i, used: true }
      if (tryBackward) {
        if (fallbackMatch && lowerPrefix !== '') {
          if (fallbackIndex === -1 && text.startsWith(lowerPrefix))
            fallbackIndex = i
        } else {
          fallbackMatch = true
        }
      }
      i++
      if (i >= rows.length)
        i = 0
    } while (i !== start)
    return { index: fallbackIndex, used: false }
  }

  private resetTimeout(): void {
    if (this.timer !== undefined)
      clearTimeout(this.timer)
    this.timer = setTimeout(() => this.clear(), this.timeout)
  }
}

const TreeRow = memo(({ node, depth, display, onActivate, onContextMenu }: ExplorerRowProps): React.JSX.Element => {
  const children = useAppStore((state) => state.children[node.id])
  const expanded = useAppStore((state) => state.expanded[node.id] ?? false)
  const loading = useAppStore((state) => state.loadingNodes[node.id] ?? false)
  const selected = useAppStore((state) => state.selectedNode?.id === node.id)
  const isInSelection = useAppStore((state) => state.selectedNodes.some((n) => n.id === node.id))
  const toggleNode = useAppStore((state) => state.toggleNode)
  const selectNode = useAppStore((state) => state.selectNode)
  const rowRef = useRef<HTMLDivElement>(null)
  const { t } = useLanguage()
  const label = GROUP_FOLDER_KINDS.has(node.kind) ? t(node.label) : node.label
  const shownChildren = useMemo(() => children && visibleChildren(node, children, display), [children, node, display])

  // A row the app selected on its own — a reference followed in the editor, a bookmark, a step — can be
  // anywhere in a long tree, so it is brought into sight the way dnSpy's tree scrolls a selected node
  // into view. `nearest` leaves a row that is already visible where it is, and scrolling does not move
  // the keyboard focus, so the editor keeps it.
  useEffect(() => {
    if (selected)
      rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return (
    <>
      <div
        ref={rowRef}
        className={`tree-row${selected ? ' selected' : ''}${isInSelection && !selected ? ' multi-selected' : ''}${node.autoLoaded ? ' auto-loaded' : ''}`}
        data-kind={node.kind}
        data-node-id={node.id}
        // dnSpy lets the roots be dragged to another place among the roots; the rows under them stay put.
        draggable={depth === 0}
        onDragStart={depth === 0 ? (event) => {
          const selection = useAppStore.getState().selectedNodes
          const dragged = selection.some((selected) => selected.id === node.id) ? selection.filter((selected) => useAppStore.getState().roots.some((root) => root.id === selected.id)) : [node]
          event.dataTransfer.setData(ROOT_DRAG_TYPE, JSON.stringify(dragged.map((root) => root.id)))
          event.dataTransfer.effectAllowed = 'move'
        } : undefined}
        style={{ paddingLeft: `${6 + depth * 16}px` }}
        role="treeitem"
        aria-expanded={node.hasChildren ? expanded : undefined}
        aria-selected={isInSelection}
        tabIndex={selected ? 0 : -1}
        title={node.toolTip ?? node.description ?? label}
        onClick={(event) => {
          if (event.ctrlKey || event.metaKey) {
            selectNode(node, { toggle: true })
          } else if (event.shiftKey) {
            selectNode(node, { range: true, rows: visibleRows(useAppStore.getState(), display) })
          } else {
            selectNode(node)
            // dnSpy's "Single-click expands nodes": the first click of a double click only, since the
            // second one is the double click's own.
            if (event.detail === 1 && display.singleClickExpandsChildren && node.hasChildren)
              void toggleNode(node)
          }
        }}
        onDoubleClick={() => onActivate(node)}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          // `currentTarget` is only readable while the event is being dispatched, and the menu is built
          // after a round trip, so the focus target is taken from the event here rather than by the menu.
          onContextMenu(node, { x: event.clientX, y: event.clientY }, event.currentTarget)
        }}
      >
        <button
          className="tree-expander"
          aria-label={expanded ? t('Collapse') : t('Expand')}
          disabled={!node.hasChildren}
          onClick={(event) => {
            event.stopPropagation()
            void toggleNode(node)
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {loading ? <LoaderCircle className="spin" size={13} /> : node.hasChildren ? expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
        </button>
        <span className={`tree-icon kind-${node.kind} icon-${iconFamily(node.icon)}`}><NodeIcon icon={node.icon} expanded={expanded && node.hasChildren} /></span>
        <span className="tree-label">{display.syntaxHighlight && node.labelParts ? <ColoredText parts={composeTreeRowParts(label, node, display)} /> : composeTreeRowText(label, node, display)}</span>
      </div>
      {expanded && shownChildren?.map((child) => (
        <TreeRow key={child.id} node={child} depth={depth + 1} display={display} onActivate={onActivate} onContextMenu={onContextMenu} />
      ))}
    </>
  )
})

/** The rows ResourceRef.TryCreate can name a resource from: a getter-only property, or a method. */
const RESOURCE_READER_KINDS = new Set(['property', 'method'])

/** The drag a root row starts carries the ids of the roots it moves, under a type of the tree's own. */
const ROOT_DRAG_TYPE = 'application/x-dnspy-tree-roots'

/** A drag from the desktop carries files, and one from the tree carries its roots; the tree takes either. */
const allowFileDrop = (event: React.DragEvent<HTMLElement>): void => {
  const types = event.dataTransfer.types
  if (!types.includes('Files') && !types.includes(ROOT_DRAG_TYPE))
    return
  event.preventDefault()
  event.dataTransfer.dropEffect = types.includes('Files') ? 'copy' : 'move'
}

export const AssemblyExplorer = ({ commands }: AssemblyExplorerProps): React.JSX.Element => {
  const roots = useAppStore((state) => state.roots)
  const options = useAppOptions()
  const explorer = options.assemblyExplorer
  const showCompilerGenerated = options.decompiler.cSharp.forceShowAllMembers
  const display = useMemo<TreeRowDisplay>(() => ({
    showToken: explorer.showToken,
    syntaxHighlight: explorer.syntaxHighlight,
    showAssemblyVersion: explorer.showAssemblyVersion,
    showAssemblyPublicKeyToken: explorer.showAssemblyPublicKeyToken,
    singleClickExpandsChildren: explorer.singleClickExpandsTreeViewChildren,
    showCompilerGenerated,
    memberKindOrder: explorer.memberKindOrder,
  }), [explorer, showCompilerGenerated])
  const { t } = useLanguage()
  // The shell rebuilds `commands` every render, but a memoized row must not see the object change: the two
  // props the rows take read it through a ref, so they keep one identity for as long as the tree lives.
  const commandsRef = useRef(commands)
  commandsRef.current = commands
  const displayRef = useRef(display)
  displayRef.current = display
  const tRef = useRef(t)
  tRef.current = t
  const treeRef = useRef<HTMLDivElement>(null)
  const textSearch = useRef(new TreeTextSearch())
  // The shell's bookmark chords — Ctrl+K or Ctrl+B and then a key — work from the tree too, so the key that ends
  // one is the chord's and not the start of a row's name. The shell waits two seconds for it; so does this.
  const chordUntil = useRef(0)

  /**
   * dnSpy's ActivateItem: a row that names something elsewhere selects what it names, the way
   * DocumentTabService.NodeActivated does; a group folder is a heading with nothing to open; any other row
   * opens. A row that names a definition the workspace cannot reach — a type in an assembly nothing on this
   * machine provides — has nowhere to go, and opens as the row it is.
   */
  const activate = useCallback((node: TreeNode): void => {
    const store = useAppStore.getState()
    store.selectNode(node)
    if (GROUP_FOLDER_KINDS.has(node.kind))
      return
    if (!ACTIVATED_KINDS.has(node.kind)) {
      commandsRef.current.onOpenNode(node)
      return
    }
    void store.activateNode(node).then((went) => {
      if (!went)
        commandsRef.current.onOpenNode(node)
    })
  }, [])

  /**
   * dnSpy builds the tree menu from the *selected* node, and a right click selects the row before the menu
   * opens. The hex group answers for that node, and the backend resolves its target once the selection has
   * changed — which happens after this handler returns — so the answer is asked for here rather than read
   * from whatever the previous selection left behind.
   */
  const openMenu = useCallback((node: TreeNode, position: { x: number; y: number }, returnFocusTo?: HTMLElement): void => {
    void (async () => {
      const store = useAppStore.getState()
      // A right click into the selection keeps it, so a command can act on every selected row; one
      // outside it selects that row alone, the way dnSpy's tree does.
      const keepsSelection = store.selectedNodes.length > 1 && store.selectedNodes.some((selected) => selected.id === node.id)
      if (!keepsSelection)
        store.selectNode(node)
      const selection = keepsSelection ? store.selectedNodes : [node]
      const resources = resourceTargets({ node, selection })
      // Go to Resource shows only on a member that reads a .resources entry, which only the backend can
      // tell — ResourceRef.TryCreate reads the member's IL — so it is asked alongside the hex target. The
      // Save commands are headed by the files they would write, which only the backend can name too.
      const [readsResource, resourceNames] = await Promise.all([
        RESOURCE_READER_KINDS.has(node.kind) ? store.findResource(node.id).then((id) => id !== null) : Promise.resolve(false),
        resources.length > 0 ? store.getResourceItemNames(resources.map((resource) => resource.id)) : Promise.resolve(undefined),
        store.resolveHexTarget(node),
      ])
      const state = useAppStore.getState()
      showAssemblyExplorerContextMenu({
        ...commandsRef.current,
        t,
        node,
        selection: keepsSelection ? state.selectedNodes : [node],
        readsResource,
        resourceNames,
        hexTarget: state.hexTarget,
        hasEmptyNamespaceSibling: hasEmptyNamespaceSibling(node, state.children, state.parents),
      }, position, { returnFocusTo })
    })()
  }, [t])

  /**
   * dnSpy's tree keys — SharpTreeView over a ListBox in Extended selection mode. The arrows, Home, End and the
   * page keys move to a row and select it alone; with Shift they select from the anchor to it, and with Ctrl they
   * only move the focus, which Ctrl+Space then toggles in or out of the selection. Left collapses a row or goes up
   * to its parent, Right expands it or goes down to its first child, the numeric keypad's + and − expand and
   * collapse and its * expands. Enter and Space activate the one selected row, Ctrl+A selects every row, and
   * typing the first letters of a row selects it.
   */
  const onTreeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    const rowElement = target.closest<HTMLElement>('.tree-row')
    if (!rowElement || event.altKey || event.metaKey)
      return
    const inChord = chordUntil.current > Date.now()
    if (!['Control', 'Shift'].includes(event.key))
      chordUntil.current = event.ctrlKey && !event.shiftKey && ['k', 'b'].includes(event.key.toLowerCase()) ? Date.now() + 2000 : 0
    const store = useAppStore.getState()
    const display = displayRef.current
    const rows = visibleRows(store, display)
    const index = rows.findIndex((row) => row.id === rowElement.dataset.nodeId)
    if (index < 0)
      return
    const node = rows[index]
    const ctrl = event.ctrlKey
    const shift = event.shiftKey

    const focusRow = (row: TreeNode): void => {
      const element = treeRef.current?.querySelector<HTMLElement>(`.tree-row[data-node-id="${CSS.escape(row.id)}"]`)
      element?.focus()
      element?.scrollIntoView({ block: 'nearest' })
    }
    /** ListBox navigation: Ctrl moves the focus alone, Shift spans from the anchor, neither selects the row. */
    const moveTo = (to: number): void => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, to))]
      if (!ctrl) {
        if (shift)
          store.selectNode(row, { range: true, rows })
        else
          store.selectNode(row)
      }
      focusRow(row)
    }
    const pageSize = (): number => Math.max(1, Math.floor((treeRef.current?.clientHeight ?? 0) / (rowElement.offsetHeight || 22)) - 1)
    const expanded = store.expanded[node.id] ?? false

    let handled = true
    switch (event.code === 'NumpadAdd' || event.code === 'NumpadSubtract' || event.code === 'NumpadMultiply' ? event.code : event.key) {
      case 'ArrowUp': moveTo(index - 1); break
      case 'ArrowDown': moveTo(index + 1); break
      case 'Home': moveTo(0); break
      case 'End': moveTo(rows.length - 1); break
      case 'PageUp': moveTo(index - pageSize()); break
      case 'PageDown': moveTo(index + pageSize()); break
      case 'ArrowLeft':
        if (ctrl || shift)
          handled = false
        else if (expanded)
          void store.toggleNode(node)
        else if (store.parents[node.id] !== undefined) {
          const parent = rows.find((row) => row.id === store.parents[node.id])
          if (parent) {
            store.selectNode(parent)
            focusRow(parent)
          }
        }
        break
      case 'ArrowRight':
        if (ctrl || shift)
          handled = false
        else if (!expanded && node.hasChildren)
          void store.expandNode(node)
        else if (expanded && rows[index + 1] && store.parents[rows[index + 1].id] === node.id) {
          store.selectNode(rows[index + 1])
          focusRow(rows[index + 1])
        }
        break
      case 'NumpadAdd':
      case 'NumpadMultiply':
        // dnSpy's nodes load their children lazily, which SharpTreeView never expands recursively: * opens
        // the row the way + does.
        if (node.hasChildren)
          void store.expandNode(node)
        break
      case 'NumpadSubtract':
        if (expanded)
          void store.toggleNode(node)
        break
      case 'Enter':
      case ' ':
        if (ctrl && event.key === ' ')
          store.selectNode(node, { toggle: true })
        else if (!ctrl && !shift && store.selectedNodes.length === 1 && store.selectedNode?.id === node.id)
          activate(node)
        else
          handled = false
        break
      case 'Backspace':
        handled = textSearch.current.revertLastCharacter()
        break
      default:
        if (ctrl && !shift && event.key.toLowerCase() === 'a') {
          store.selectNodes(rows, store.selectedNode)
        } else if (!ctrl && event.key.length === 1 && !inChord) {
          const texts = rows.map((row) => rowSearchText(row, display, tRef.current))
          const selectedIndex = store.selectedNode ? rows.findIndex((row) => row.id === store.selectedNode?.id) : -1
          const found = textSearch.current.search(texts, event.key, selectedIndex)
          if (found >= 0) {
            store.selectNode(rows[found])
            focusRow(rows[found])
          }
          // A letter is the tree's to read, but nothing else's to lose: the shell still sees it.
          event.preventDefault()
          return
        } else {
          handled = false
        }
    }
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }, [activate])

  /**
   * dnSpy's DocumentTreeView drop: files from the desktop open in front of the root they were dropped on —
   * at the end when that was no root — and the Assembly Explorer's dragged-items filter decides which of
   * several are let in. A row that is not a root stands for the root it hangs under.
   */
  const dropOnTree = useCallback((event: React.DragEvent<HTMLElement>): void => {
    const types = event.dataTransfer.types
    if (!types.includes('Files') && !types.includes(ROOT_DRAG_TYPE))
      return
    event.preventDefault()
    event.stopPropagation()
    const state = useAppStore.getState()
    let nodeId = (event.target as HTMLElement).closest<HTMLElement>('.tree-row')?.dataset.nodeId
    while (nodeId !== undefined && state.parents[nodeId] !== undefined)
      nodeId = state.parents[nodeId]
    const found = nodeId === undefined ? -1 : state.roots.findIndex((root) => root.id === nodeId)
    const index = found < 0 ? state.roots.length : found
    // dnSpy's OnDropNodes: the dragged roots go in front of the one they were dropped on.
    if (types.includes(ROOT_DRAG_TYPE)) {
      const ids = JSON.parse(event.dataTransfer.getData(ROOT_DRAG_TYPE) || '[]') as string[]
      if (ids.length > 0)
        void state.moveRoots(ids, index)
      return
    }
    const paths = Array.from(event.dataTransfer.files, (file) => window.dnSpy.pathForFile(file)).filter((path) => path.length > 0)
    void state.dropFiles(paths, index, loadAppOptions().assemblyExplorer.filterDraggedItems)
  }, [])

  if (roots.length === 0)
    return <div className="pane-empty" onDragOver={allowFileDrop} onDrop={dropOnTree}>{t('No assemblies loaded')}</div>

  return (
    <div ref={treeRef} className="assembly-tree" role="tree" aria-label={t('Assembly Explorer')} aria-multiselectable="true" onDragOver={allowFileDrop} onDrop={dropOnTree} onKeyDown={onTreeKeyDown}>
      {roots.map((root) => (
        <TreeRow key={root.id} node={root} depth={0} display={display} onActivate={activate} onContextMenu={openMenu} />
      ))}
    </div>
  )
}
