import type { TreeNode } from '../../../shared/protocol'

/**
 * dnSpy's delete commands, one per node kind: DeleteTypeDefCommand, DeleteMethodDefCommand and the rest. Each
 * acts on the whole selection when every selected row is of its kind, and is headed by the one row it would
 * delete, or by how many there are — GetHeader's "Delete {0}" and the plural resource beside it.
 */
interface DeleteCommand {
  /** The header for several rows, with `{count}`. */
  many: string
  /** The header for one row; most name the row, the namespace command does not. */
  one?: string
  /** dnSpy's ignorable "are you sure" — asked once per command, for the kinds code elsewhere may reference. */
  question?: string
}

export const DELETE_COMMANDS: Readonly<Record<string, DeleteCommand>> = {
  type: { many: 'Delete {count} types', question: 'There could be code in some assembly that references this type. Are you sure you want to delete the type?' },
  method: { many: 'Delete {count} methods', question: 'There could be code in some assembly that references this method. Are you sure you want to delete the method?' },
  field: { many: 'Delete {count} fields', question: 'There could be code in some assembly that references this field. Are you sure you want to delete the field?' },
  property: { many: 'Delete {count} properties' },
  event: { many: 'Delete {count} events' },
  namespace: { many: 'Delete {count} Namespaces', one: 'Delete Namespace' },
  resource: { many: 'Delete {count} resources' },
  resourceentry: { many: 'Delete {count} resources' },
}

/** The id dnSpy's three delete questions share, so "don't show again" on one of them silences all three. */
export const DELETE_QUESTION_ID = 'DA7D935C-F5ED-44A4-BFA8-CC794AD0F105'

/** The global `<Module>` type, which dnSpy's DeleteTypeDefCommand leaves alone and does not count. */
const isGlobalType = (node: TreeNode): boolean => node.kind === 'type' && node.label === '<Module>'

/**
 * The rows a delete command takes: every selected row when the one it was run on is among them and they are all
 * of its kind — the TopLevelSelection, without a row whose ancestor is selected too — else that row alone. A
 * type command passes the global type over.
 */
export const deletionTargets = (node: TreeNode, selection: readonly TreeNode[], parents: Readonly<Record<string, string>>): TreeNode[] => {
  const chosen = selection.some((selected) => selected.id === node.id) && selection.every((selected) => selected.kind === node.kind)
    ? selection
    : [node]
  const ids = new Set(chosen.map((selected) => selected.id))
  const hasSelectedAncestor = (candidate: TreeNode): boolean => {
    for (let parent = parents[candidate.id]; parent !== undefined; parent = parents[parent]) {
      if (ids.has(parent))
        return true
    }
    return false
  }
  return chosen.filter((selected) => !hasSelectedAncestor(selected) && !isGlobalType(selected))
}

/** The header of the delete command for the rows: the one row by its name, several by how many. */
export const deleteHeader = (t: (message: string, values?: Record<string, string | number>) => string, kind: string, targets: readonly TreeNode[], fallback: TreeNode): string => {
  const command = DELETE_COMMANDS[kind]
  if (targets.length > 1 && command)
    return t(command.many, { count: targets.length })
  if (command?.one)
    return t(command.one)
  return t('Delete {name}', { name: (targets[0] ?? fallback).label })
}
