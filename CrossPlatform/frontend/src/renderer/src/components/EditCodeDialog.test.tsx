import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TreeNode } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { EditCodeDialog } from './EditCodeDialog'

// The real editor is Monaco, which jsdom cannot lay out; a textarea carries the same value and change
// notifications, which is all this window passes to it.
vi.mock('./CodeEditor', () => ({
  default: ({ value, onChange }: { value?: string, onChange?(value: string | undefined): void }) =>
    <textarea aria-label="Source" value={value ?? ''} onChange={(event) => onChange?.(event.target.value)} />,
}))

const node: TreeNode = { id: 'm1', label: 'Value() : int', kind: 'method', hasChildren: false }
const typeNode: TreeNode = { id: 't1', label: 'CompilerFixture', kind: 'type', hasChildren: true }

const stub = (): { compileSource: ReturnType<typeof vi.fn>, compileCode: ReturnType<typeof vi.fn> } => {
  const compileSource = vi.fn(async () => ({ success: false, diagnostics: [{ severity: 'error', text: "The name 'x' does not exist", id: 'CS0103', fileName: 'main.cs', startLine: 4, startColumn: 8, endLine: 4, endColumn: 9 }] }))
  const compileCode = vi.fn(async () => ({ ok: true, diagnostics: [] }))
  Object.defineProperty(window, 'dnSpy', {
    configurable: true,
    value: {
      ...window.dnSpy,
      decompile: vi.fn(async () => ({ title: 'CompilerFixture', language: 'csharp', text: 'public class CompilerFixture\n{\n    public int Value() { return 1; }\n}\n', spans: [], diagnostics: [] })),
      compileSource,
      getAssemblyAttributesSource: vi.fn(async () => ({ source: '[assembly: System.Reflection.AssemblyTitle("X")]\n' })),
    },
  })
  useAppStore.setState({ workspaceId: 'ws', compileCode })
  return { compileSource, compileCode }
}

beforeEach(() => {
  useAppStore.setState({ workspaceId: undefined })
})

afterEach(cleanup)

describe('EditCodeDialog', () => {
  it('opens on the decompiled type and titles the command', async () => {
    stub()
    render(<EditCodeDialog node={node} mode="editMethod" sourceNodeId={typeNode.id} theme="dark" onClose={() => undefined} />)

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', 'Edit Method (C#)')
    await waitFor(() => expect((screen.getByLabelText('Source') as HTMLTextAreaElement).value).toContain('CompilerFixture'))
  })

  it('shows the diagnostics Compile reports', async () => {
    const harness = stub()
    render(<EditCodeDialog node={node} mode="editMethod" sourceNodeId={typeNode.id} theme="dark" onClose={() => undefined} />)
    await screen.findByLabelText('Source')
    fireEvent.click(screen.getByRole('button', { name: 'Compile' }))

    expect(await screen.findByText("The name 'x' does not exist")).toBeInTheDocument()
    expect(screen.getByText('CS0103')).toBeInTheDocument()
    expect(screen.getByText('1 diagnostic(s), 1 error(s).')).toBeInTheDocument()
    expect(harness.compileSource).toHaveBeenCalledWith('ws', 'm1', 'editMethod', expect.stringContaining('CompilerFixture'))
  })

  it('imports the source through the store when accepted', async () => {
    const harness = stub()
    render(<EditCodeDialog node={node} mode="editMethod" sourceNodeId={typeNode.id} theme="dark" onClose={() => undefined} />)
    const source = await screen.findByLabelText('Source')
    fireEvent.change(source, { target: { value: 'public class CompilerFixture { public int Value() { return 2; } }' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))

    await waitFor(() => expect(harness.compileCode).toHaveBeenCalledTimes(1))
    expect(harness.compileCode).toHaveBeenCalledWith(node, 'editMethod', 'public class CompilerFixture { public int Value() { return 2; } }')
  })

  it('opens Edit Assembly Attributes on the attributes the module already has', async () => {
    stub()
    render(<EditCodeDialog node={node} mode="editAssembly" theme="dark" onClose={() => undefined} />)
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', 'Edit Assembly Attributes (C#)')
    await waitFor(() => expect((screen.getByLabelText('Source') as HTMLTextAreaElement).value).toContain('AssemblyTitle'))
  })

  it('starts Add Class on an empty class the user fills in', async () => {
    stub()
    render(<EditCodeDialog node={node} mode="addClass" theme="dark" onClose={() => undefined} />)
    expect((screen.getByLabelText('Source') as HTMLTextAreaElement).value).toContain('class MyClass')
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', 'Add Class (C#)')
  })
})
