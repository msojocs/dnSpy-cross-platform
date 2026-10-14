import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, LoaderCircle, X } from 'lucide-react'
import type { TreeNode } from '../../../shared/protocol'
import { useLanguage } from '../localization'
import { iconFamily, NodeIcon } from './AssemblyExplorer'
import { trapTabKey, useModalLayer } from './modal-stack'

/**
 * What the picker is allowed to return, which is dnSpy's `VisibleMembersFlags`: the tree it shows is
 * the assembly explorer's own, with everything the caller did not ask for hidden — a picker opened for
 * a type shows types and the containers that hold them, and nothing else.
 */
export type PickerMode = 'type' | 'member' | 'field' | 'method' | 'constructor'

/**
 * Whether a node is one of the answers this mode is looking for. A mode that only wants part of a kind
 * tells them apart by name: an instance constructor is a method called `.ctor`, which is the name
 * ECMA-335 §II.10.5.1 requires it to have — `.cctor` is the static one and is not a custom attribute's
 * constructor. The row's label names a constructor after its type, the way dnSpy's tree does, so the name
 * is read off the full name the node carries instead ("System.Void NS.Type::.ctor(System.String)").
 */
const isInstanceConstructor = (node: TreeNode): boolean =>
  node.kind === 'method' && (node.description?.includes('::.ctor(') ?? node.label.startsWith('.ctor('))

const SELECTABLE: Record<PickerMode, (node: TreeNode) => boolean> = {
  type: (node) => node.kind === 'type',
  member: (node) => ['type', 'method', 'field', 'property', 'event'].includes(node.kind),
  field: (node) => node.kind === 'field',
  method: (node) => node.kind === 'method',
  constructor: isInstanceConstructor,
}

/**
 * The nodes that lead to a selectable one, which is dnSpy's `FilterType.CheckChildren`: a type is
 * only reachable through the assembly, module and namespace it lives in, and a member only through its
 * type — so all of those stay visible in every mode, as containers rather than as answers.
 */
const CONTAINERS = ['assembly', 'module', 'namespace', 'referencesgroup', 'assemblyreference', 'type']

/** dnSpy's own titles for the pickers, `Pick_Type` and friends. */
const PICKER_TITLES: Record<PickerMode, string> = {
  type: 'Pick a Type',
  member: 'Pick Member',
  field: 'Pick a Field',
  method: 'Pick a Method',
  constructor: 'Pick a Constructor',
}

interface PickerRowProps {
  node: TreeNode
  /** The chain that leads here, outermost first; its length is the row's depth. */
  parents: TreeNode[]
  mode: PickerMode
  children: Record<string, TreeNode[]>
  expanded: Record<string, boolean>
  loading: Record<string, boolean>
  selectedId?: string
  onSelect(node: TreeNode, trail: TreeNode[]): void
  onToggle(node: TreeNode, parents: TreeNode[]): void
  onPick(node: TreeNode, trail: TreeNode[]): void
}

const PickerRow = ({ node, parents, mode, children, expanded, loading, selectedId, onSelect, onToggle, onPick }: PickerRowProps): React.JSX.Element | null => {
  const { t } = useLanguage()
  const selectable = SELECTABLE[mode](node)
  if (!selectable && !CONTAINERS.includes(node.kind))
    return null
  const open = expanded[node.id] ?? false
  const trail = [...parents, node]
  // The folder dnSpy labels from its resources (ReferencesFolder), translated the way the tree translates it.
  const label = node.kind === 'referencesgroup' ? t(node.label) : node.label
  return (
    <>
      <div
        className={`tree-row${selectedId === node.id ? ' selected' : ''}`}
        data-kind={node.kind}
        style={{ paddingLeft: `${6 + parents.length * 16}px` }}
        role="treeitem"
        aria-expanded={node.hasChildren ? open : undefined}
        aria-selected={selectedId === node.id}
        // A row is only disabled when there is nothing to be done with it at all. The containers — a
        // module, a namespace, a type in a mode that is after its members rather than it — cannot be
        // picked, but they can be opened, and the expander beside them is the control that does it:
        // calling the whole row disabled takes that control with it for anything that honours the
        // attribute, this port's own end-to-end tests included.
        aria-disabled={!selectable && !node.hasChildren}
        title={node.description ?? label}
        onClick={() => onSelect(node, trail)}
        onDoubleClick={() => {
          if (selectable)
            onPick(node, trail)
          else if (node.hasChildren)
            onToggle(node, parents)
        }}
      >
        <button
          type="button"
          className="tree-expander"
          aria-label={open ? t('Collapse') : t('Expand')}
          disabled={!node.hasChildren}
          onClick={(event) => {
            event.stopPropagation()
            onToggle(node, parents)
          }}
        >
          {loading[node.id] ? <LoaderCircle className="spin" size={13} /> : node.hasChildren ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
        </button>
        <span className={`tree-icon kind-${node.kind} icon-${iconFamily(node.icon)}`}><NodeIcon icon={node.icon} expanded={open} /></span>
        <span className="tree-label">{label}</span>
      </div>
      {open && children[node.id]?.map((child) => (
        <PickerRow
          key={child.id}
          node={child}
          parents={trail}
          mode={mode}
          children={children}
          expanded={expanded}
          loading={loading}
          selectedId={selectedId}
          onSelect={onSelect}
          onToggle={onToggle}
          onPick={onPick}
        />
      ))}
    </>
  )
}

interface TypePickerDialogProps {
  workspaceId: string
  mode: PickerMode
  /** Overrides the mode's default title, the way an option dialog names the thing it is picking. */
  title?: string
  /** The only roots to show, for a picker whose answer has to come out of one assembly. dnSpy's own way
   * of saying that is wrapping it in a `SameModuleDocumentTreeNodeFilter`, which hides every other
   * module; nothing under a module can be from anywhere else, so hiding the roots is the same tree. */
  rootNodeIds?: string[]
  /** Called with the picked node and its ancestor chain, outermost first and including the node
   * itself — the chain is what tells a caller which assembly and namespace the node came from. */
  onPick(node: TreeNode, trail: TreeNode[]): void
  onClose(): void
}

/**
 * The tree a dialog picks a type or a member from. It is the same tree the assembly explorer shows,
 * read from the same backend calls, but it keeps its expansion state to itself: a picker is opened and
 * dismissed many times over one dialog's lifetime, and folding the explorer underneath the user each
 * time would be wrong.
 *
 * A container is kept even when nothing under it can be picked, where dnSpy folds it away: deciding
 * that means knowing the whole subtree, and this tree is read a level at a time. An empty namespace is
 * a smaller price than a picker that has to load every assembly before it can show anything.
 */
export const TypePickerDialog = ({ workspaceId, mode, title, rootNodeIds, onPick, onClose }: TypePickerDialogProps): React.JSX.Element => {
  const dialog = useRef<HTMLDivElement>(null)
  const depth = useModalLayer(onClose)
  const { t } = useLanguage()
  const [roots, setRoots] = useState<TreeNode[]>([])
  const [children, setChildren] = useState<Record<string, TreeNode[]>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [trail, setTrail] = useState<TreeNode[]>([])
  const [error, setError] = useState<string>()

  // A picker can be dismissed while a load is in flight — the user closes it or picks something —
  // and the response must not land in a dialog that is on its way out.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const loadChildren = async (node: TreeNode): Promise<void> => {
    setLoading((current) => ({ ...current, [node.id]: true }))
    try {
      const response = await window.dnSpy.getChildren(workspaceId, node.id)
      if (alive.current)
        setChildren((current) => ({ ...current, [node.id]: response.nodes }))
    }
    catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : String(cause))
    }
    finally {
      if (alive.current)
        setLoading((current) => ({ ...current, [node.id]: false }))
    }
  }

  // The ids are read through a key so that a caller writing the array inline does not reload the tree on
  // every render — an array is a different value each time, its contents are not.
  const rootKey = rootNodeIds === undefined ? undefined : rootNodeIds.join('\n')

  useEffect(() => {
    void (async () => {
      try {
        const allowed = rootKey === undefined ? undefined : new Set(rootKey.split('\n'))
        const response = await window.dnSpy.getRoots(workspaceId)
        if (!alive.current)
          return
        const shown = allowed === undefined ? response.nodes : response.nodes.filter((node) => allowed.has(node.id))
        setRoots(shown)
        // The roots are assemblies; opening one shows the module inside it, which is as far as the tree
        // is opened for the user. Which module, namespace and type hold the answer is their call.
        setExpanded(Object.fromEntries(shown.map((node) => [node.id, true])))
        await Promise.all(shown.filter((node) => node.hasChildren).map(loadChildren))
      }
      catch (cause) {
        if (alive.current)
          setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
  }, [workspaceId, rootKey])

  const toggle = (node: TreeNode, parents: TreeNode[]): void => {
    setTrail([...parents, node])
    const open = !(expanded[node.id] ?? false)
    setExpanded((current) => ({ ...current, [node.id]: open }))
    if (open && !children[node.id])
      void loadChildren(node)
  }

  const selected = trail.at(-1)
  const canPick = selected !== undefined && SELECTABLE[mode](selected)

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      style={{ zIndex: 100 + depth * 10 }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div
        ref={dialog}
        className="modal picker-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t(title ?? PICKER_TITLES[mode])}
        onKeyDown={(event) => trapTabKey(event, dialog.current)}
      >
        <div className="modal-title">
          <span>{t(title ?? PICKER_TITLES[mode])}</span>
          <button type="button" className="icon-button" aria-label={t('Close')} title={t('Close')} onClick={onClose}><X size={14} /></button>
        </div>
        <div className="picker-body">
          {error && <div className="picker-error">{error}</div>}
          <div className="assembly-tree" role="tree" aria-label={t('Assembly Explorer')}>
            {roots.map((root) => (
              <PickerRow
                key={root.id}
                node={root}
                parents={[]}
                mode={mode}
                children={children}
                expanded={expanded}
                loading={loading}
                selectedId={selected?.id}
                onSelect={(node, nodeTrail) => setTrail(nodeTrail)}
                onToggle={toggle}
                onPick={onPick}
              />
            ))}
          </div>
        </div>
        <div className="modal-actions">
          <span className="modal-action-spacer" />
          <button type="button" onClick={onClose}>{t('Cancel')}</button>
          <button type="button" className="primary" disabled={!canPick} onClick={() => { if (selected) onPick(selected, trail) }}>{t('OK')}</button>
        </div>
      </div>
    </div>
  )
}
