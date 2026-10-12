import { memo, useCallback, useEffect, useRef } from 'react'
import {
  Binary,
  Box,
  Braces,
  Brackets,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDot,
  Code2,
  FileBox,
  FileCode2,
  Files,
  Folder,
  FolderOpen,
  Library,
  LoaderCircle,
  Network,
  Package,
  Search,
  Variable,
} from 'lucide-react'
import type { TreeNode } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'
import { useAppOptions } from './app-options'
import { hasEmptyNamespaceSibling, showAssemblyExplorerContextMenu, type AssemblyExplorerCommands } from './AssemblyExplorerContextMenu'

interface AssemblyExplorerProps {
  /**
   * The commands the tree's rows run: the shell owns them, because a dialog, a tool window or a new tab
   * belongs to the shell rather than to the tree. The object is rebuilt on every shell render so its
   * callbacks close over the newest handlers, which is why the rows read it through a ref.
   */
  commands: AssemblyExplorerCommands
}

/** What one memoized row needs: its place in the tree, and the two commands a click can run. */
interface ExplorerRowProps {
  node: TreeNode
  depth: number
  showToken: boolean
  onOpenNode(node: TreeNode): void
  onContextMenu(node: TreeNode, position: { x: number; y: number }, returnFocusTo?: HTMLElement): void
}

/** The tree's icon for a node, shared with the dialogs that show the same tree — the type picker. */
export const NodeIcon = ({ icon, expanded = false }: { icon?: string; expanded?: boolean }): React.JSX.Element => {
  const props = { size: 15, strokeWidth: 1.6, 'aria-hidden': true as const }
  switch (icon) {
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
    case 'property': return <Braces {...props} />
    case 'event': return <CircleDot {...props} />
    case 'interface': return <Network {...props} />
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
 * The text a tree row wears — dnSpy's NodeFormatter writes "name : RetType @06000004": members name
 * their type after a colon, and a metadata row gets its token appended unless the user turned tokens
 * off. The tooltip keeps the bare label, which is the full signature the row abbreviates.
 */
export const composeTreeRowText = (label: string, node: TreeNode, showToken: boolean): string => {
  const typeSuffix = node.returnType != null && KINDS_WITH_RETURN_TYPE.has(node.kind) ? ` : ${node.returnType}` : ''
  const tokenSuffix = showToken && node.metadataToken != null && KINDS_WITH_TOKEN.has(node.kind) ? ` ${formatMetadataToken(node.metadataToken)}` : ''
  return `${label}${typeSuffix}${tokenSuffix}`
}

const TreeRow = memo(({ node, depth, showToken, onOpenNode, onContextMenu }: ExplorerRowProps): React.JSX.Element => {
  const children = useAppStore((state) => state.children[node.id])
  const expanded = useAppStore((state) => state.expanded[node.id] ?? false)
  const loading = useAppStore((state) => state.loadingNodes[node.id] ?? false)
  const selected = useAppStore((state) => state.selectedNode?.id === node.id)
  const toggleNode = useAppStore((state) => state.toggleNode)
  const selectNode = useAppStore((state) => state.selectNode)
  const rowRef = useRef<HTMLDivElement>(null)
  const { t } = useLanguage()
  const label = GROUP_FOLDER_KINDS.has(node.kind) ? t(node.label) : node.label

  // A row the app selected on its own — a reference followed in the editor, a bookmark, a step — can be
  // anywhere in a long tree, so it is brought into sight the way dnSpy's tree scrolls a selected node
  // into view. `nearest` leaves a row that is already visible where it is, and scrolling does not move
  // the keyboard focus, so the editor keeps it.
  useEffect(() => {
    if (selected)
      rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const open = (): void => {
    selectNode(node)
    if (!GROUP_FOLDER_KINDS.has(node.kind))
      onOpenNode(node)
  }

  return (
    <>
      <div
        ref={rowRef}
        className={`tree-row${selected ? ' selected' : ''}`}
        data-kind={node.kind}
        style={{ paddingLeft: `${6 + depth * 16}px` }}
        role="treeitem"
        aria-expanded={node.hasChildren ? expanded : undefined}
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        title={node.description ?? label}
        onClick={() => selectNode(node)}
        onDoubleClick={open}
        onKeyDown={(event) => {
          if (event.key === 'Enter') open()
          if (event.key === 'ArrowRight' && node.hasChildren && !expanded) void toggleNode(node)
          if (event.key === 'ArrowLeft' && expanded) void toggleNode(node)
        }}
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
        <span className={`tree-icon kind-${node.kind} icon-${node.icon ?? 'item'}`}><NodeIcon icon={node.icon} expanded={expanded} /></span>
        <span className="tree-label">{composeTreeRowText(label, node, showToken)}</span>
      </div>
      {expanded && children?.map((child) => (
        <TreeRow key={child.id} node={child} depth={depth + 1} showToken={showToken} onOpenNode={onOpenNode} onContextMenu={onContextMenu} />
      ))}
    </>
  )
})

export const AssemblyExplorer = ({ commands }: AssemblyExplorerProps): React.JSX.Element => {
  const roots = useAppStore((state) => state.roots)
  const showToken = useAppOptions().assemblyExplorer.showToken
  const { t } = useLanguage()
  // The shell rebuilds `commands` every render, but a memoized row must not see the object change: the two
  // props the rows take read it through a ref, so they keep one identity for as long as the tree lives.
  const commandsRef = useRef(commands)
  commandsRef.current = commands
  const openNode = useCallback((node: TreeNode): void => commandsRef.current.onOpenNode(node), [])

  /**
   * dnSpy builds the tree menu from the *selected* node, and a right click selects the row before the menu
   * opens. The hex group answers for that node, and the backend resolves its target once the selection has
   * changed — which happens after this handler returns — so the answer is asked for here rather than read
   * from whatever the previous selection left behind.
   */
  const openMenu = useCallback((node: TreeNode, position: { x: number; y: number }, returnFocusTo?: HTMLElement): void => {
    void (async () => {
      const store = useAppStore.getState()
      store.selectNode(node)
      await store.resolveHexTarget(node)
      const state = useAppStore.getState()
      showAssemblyExplorerContextMenu({
        ...commandsRef.current,
        t,
        node,
        hexTarget: state.hexTarget,
        hasEmptyNamespaceSibling: hasEmptyNamespaceSibling(node, state.children, state.parents),
      }, position, { returnFocusTo })
    })()
  }, [t])

  if (roots.length === 0)
    return <div className="pane-empty">{t('No assemblies loaded')}</div>

  return (
    <div className="assembly-tree" role="tree" aria-label={t('Assembly Explorer')}>
      {roots.map((root) => (
        <TreeRow key={root.id} node={root} depth={0} showToken={showToken} onOpenNode={openNode} onContextMenu={openMenu} />
      ))}
    </div>
  )
}
