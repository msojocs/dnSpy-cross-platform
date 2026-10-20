import type { TreeNode } from '../../shared/protocol'

/**
 * dnSpy's tab shows an array of tree nodes (DecompileDocumentTabContent.nodes): one for a row the user picked, all of
 * the top-level selection for several. The client keys a document by its nodes, in order — the node's own id for one
 * node, so every document that existed before keeps the id it had. Node ids are "n" and a number, so the separator
 * cannot be part of one.
 */
const SEPARATOR = '+'

export const documentIdOf = (nodeIds: readonly string[]): string => nodeIds.join(SEPARATOR)

/** The nodes a document shows, in the order it shows them. */
export const nodeIdsOfDocument = (documentId: string): string[] => documentId.split(SEPARATOR)

/** Whether the document shows the node — on its own, or as one of the nodes of a multi-selection. */
export const documentShowsNode = (documentId: string, nodeId: string): boolean =>
  documentId === nodeId || (documentId.includes(SEPARATOR) && nodeIdsOfDocument(documentId).includes(nodeId))

/**
 * SharpTreeView.GetTopLevelSelection, which DocumentTabService.DocumentTreeView_SelectionChanged shows: the selected
 * rows, in the order they were selected, without those that sit under another selected row — a type and one of its
 * methods show the type alone.
 */
export const topLevelSelection = (nodes: readonly TreeNode[], parents: Readonly<Record<string, string>>): TreeNode[] => {
  const selected = new Set(nodes.map((node) => node.id))
  return nodes.filter((node) => {
    const seen = new Set<string>()
    for (let parent = parents[node.id]; parent !== undefined && !seen.has(parent); parent = parents[parent]) {
      if (selected.has(parent))
        return false
      seen.add(parent)
    }
    return true
  })
}

/**
 * DecompileDocumentTabContent's title before the document has one of its own — every node's name with ", " between
 * them — and its tooltip, each node's tooltip with an empty line between them.
 */
export const documentTitleOf = (nodes: readonly TreeNode[]): string => nodes.map((node) => node.label).join(', ')

export const documentToolTipOf = (nodes: readonly TreeNode[]): string =>
  nodes.map((node) => node.toolTip ?? node.description ?? node.label).join('\n\n')
