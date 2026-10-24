import { describe, expect, it, vi } from 'vitest'
import type { HexTargetResponse, TreeNode } from '../../../shared/protocol'
import { codeHexContext, runHexShortcut, treeHexContext, visibleHexMenuEntries, type HexMenuContext } from './hex-menu'

const context = (overrides: Partial<HexMenuContext> = {}): HexMenuContext => ({
  t: (message) => message,
  onOpenHex: vi.fn(),
  onShowHex: vi.fn(),
  onHexWriteBody: vi.fn(),
  onHexCopyBody: vi.fn(),
  onHexPasteBody: vi.fn(),
  ...overrides,
})

const labels = (ctx: HexMenuContext): string[] => visibleHexMenuEntries(ctx).map((entry) => `${entry.order}:${entry.label(ctx)}`)

const run = (ctx: HexMenuContext, order: number): void => {
  const entry = visibleHexMenuEntries(ctx).find((candidate) => candidate.order === order)
  if (!entry)
    throw new Error(`Entry ${order} is not on the menu`)
  entry.run(ctx)
}

// The parts a node has no target for arrive as nulls, the way System.Text.Json writes them.
const target = (overrides: Partial<HexTargetResponse> = {}): HexTargetResponse => ({
  moduleId: 'file-1',
  fileLength: 4096,
  method: null,
  fieldInitialValue: null,
  resource: null,
  structure: null,
  structureData: null,
  ...overrides,
})

const method = { bodyOffset: 0x200, bodySize: 3, codeOffset: 0x201, codeSize: 2, returnTrueBody: 'Chcq', returnFalseBody: 'ChYq', emptyBody: null }
const methodRow: TreeNode = { id: 'n-method', kind: 'method', label: 'Run()', hasChildren: false }
const moduleRow: TreeNode = { id: 'n-module', kind: 'module', label: 'A.dll', hasChildren: true }
const statement = { moduleId: 'file-1', range: { offset: 0x201, length: 1 } }

describe('hex menu group', () => {
  it('shows an address reference under the caret instead of the document commands', () => {
    const onShowAddress = vi.fn()
    const address = { modulePath: '/A.dll', isRva: false, address: 0x200, length: 4 }
    const ctx = context({ ...codeHexContext({ fileModuleId: 'file-1', statement, address }), onShowAddress })
    expect(labels(ctx)).toEqual(['10:Show in Hex Editor'])
    run(ctx, 10)
    expect(onShowAddress).toHaveBeenCalledWith(address)
  })

  it('opens the file the context names, at its start', () => {
    const ctx = context(codeHexContext({ fileModuleId: 'file-1' }))
    expect(labels(ctx)).toEqual(['0:Open Hex Editor'])
    run(ctx, 0)
    expect(ctx.onOpenHex).toHaveBeenCalledWith('file-1')
    // A document with no file — one Create Assembly made — has nothing to open.
    expect(labels(context(codeHexContext({})))).toEqual([])
  })

  it('opens the statement under the caret in place of the file, and steps aside for a method definition', () => {
    const ctx = context(codeHexContext({ fileModuleId: 'file-1', statement }))
    expect(labels(ctx)).toEqual(['20:Show Instructions in Hex Editor'])
    run(ctx, 20)
    expect(ctx.onShowHex).toHaveBeenCalledWith('file-1', statement.range)

    // The caret on the definition of a method with a body: TVShowMethodInstructionsInHexEditorCommand is visible, so
    // the statement's command is not, and the file command comes back.
    const onDefinition = context(codeHexContext({ fileModuleId: 'file-1', statement, definition: { nodeId: 'n-method', target: target({ method }) } }))
    expect(labels(onDefinition)).toEqual([
      '0:Open Hex Editor',
      '50:Show Instructions in Hex Editor',
      '60:Show Method Body in Hex Editor',
      "90:Hex Write 'return true' Body",
      "100:Hex Write 'return false' Body",
      '120:Hex Copy Method Body',
    ])
    run(onDefinition, 50)
    expect(onDefinition.onShowHex).toHaveBeenCalledWith('file-1', { offset: 0x201, length: 2 })
    run(onDefinition, 60)
    expect(onDefinition.onShowHex).toHaveBeenCalledWith('file-1', { offset: 0x200, length: 3 })
  })

  it('gives a viewer none of the commands that need a tree node', () => {
    // A PE structure's and a resource's commands read context.Nodes, which a document viewer's context has none of.
    const rich = target({ structure: { offset: 0, length: 64 }, structureData: { offset: 64, length: 8 }, resource: { offset: 0x300, length: 4 }, fieldInitialValue: { offset: 0x400, length: 0 } })
    const ctx = context(codeHexContext({ definition: { nodeId: 'n-field', target: rich } }))
    expect(labels(ctx)).toEqual(['70:Show Initial Value in Hex Editor'])
    run(ctx, 70)
    expect(ctx.onShowHex).toHaveBeenCalledWith('file-1', { offset: 0x400, length: 0 })
  })

  it('acts on the tree\'s selection only when it is one row', () => {
    const forModule = context(treeHexContext([moduleRow], target()))
    expect(labels(forModule)).toEqual(['0:Open Hex Editor'])
    run(forModule, 0)
    expect(forModule.onOpenHex).toHaveBeenCalledWith('file-1')

    // A part inside a file names no file of its own; its own bytes are what the commands point at.
    expect(labels(context(treeHexContext([methodRow], target({ method }))))).not.toContain('0:Open Hex Editor')
    expect(labels(context(treeHexContext([moduleRow, methodRow], target({ method }))))).toEqual([])

    const structure = context(treeHexContext([{ ...moduleRow, kind: 'pestructure' }], target({ structure: { offset: 0x80, length: 0xF8 } })))
    expect(labels(structure)).toEqual(['30:Show in Hex Editor'])
    run(structure, 30)
    expect(structure.onShowHex).toHaveBeenCalledWith('file-1', { offset: 0x80, length: 0xF8 })
  })

  it('writes, copies and pastes over the method the context names', () => {
    const ctx = context({ ...treeHexContext([methodRow], target({ method })), clipboardHexLength: 3 })
    run(ctx, 90)
    expect(ctx.onHexWriteBody).toHaveBeenCalledWith('returnTrue', { nodeId: 'n-method', moduleId: 'file-1', method })
    run(ctx, 120)
    expect(ctx.onHexCopyBody).toHaveBeenCalledWith({ nodeId: 'n-method', moduleId: 'file-1', method })
    run(ctx, 130)
    expect(ctx.onHexPasteBody).toHaveBeenCalledWith({ nodeId: 'n-method', moduleId: 'file-1', method })
  })

  it('offers Hex Paste Method Body only for hexadecimal bytes on the clipboard that fit the body', () => {
    const paste = (clipboardHexLength?: number): boolean =>
      labels(context({ ...treeHexContext([methodRow], target({ method })), clipboardHexLength })).includes('130:Hex Paste Method Body')
    expect(paste(undefined)).toBe(false)
    expect(paste(4)).toBe(false)
    expect(paste(3)).toBe(true)
    expect(paste(1)).toBe(true)
  })
})

describe('the Ctrl+X shortcut', () => {
  it('runs the first of the address, the statement, the structure and the file that has something to open', () => {
    const onShowAddress = vi.fn()
    const address = { modulePath: '/A.dll', isRva: true, address: 0x2000, length: 0 }
    const withAddress = context({ ...codeHexContext({ fileModuleId: 'file-1', statement, address }), onShowAddress })
    expect(runHexShortcut(withAddress)).toBe(true)
    expect(onShowAddress).toHaveBeenCalledWith(address)
    expect(withAddress.onShowHex).not.toHaveBeenCalled()

    const withStatement = context(codeHexContext({ fileModuleId: 'file-1', statement }))
    runHexShortcut(withStatement)
    expect(withStatement.onShowHex).toHaveBeenCalledWith('file-1', statement.range)
    expect(withStatement.onOpenHex).not.toHaveBeenCalled()

    // On a method's definition the statement steps aside, so the shortcut opens the file.
    const onDefinition = context(codeHexContext({ fileModuleId: 'file-1', statement, definition: { nodeId: 'n-method', target: target({ method }) } }))
    runHexShortcut(onDefinition)
    expect(onDefinition.onOpenHex).toHaveBeenCalledWith('file-1')
    expect(onDefinition.onShowHex).not.toHaveBeenCalled()

    // A method row of the tree has no file and no structure, so the key does nothing there.
    const methodInTree = context(treeHexContext([methodRow], target({ method })))
    expect(runHexShortcut(methodInTree)).toBe(false)
    expect(runHexShortcut(context({}))).toBe(false)
  })
})
