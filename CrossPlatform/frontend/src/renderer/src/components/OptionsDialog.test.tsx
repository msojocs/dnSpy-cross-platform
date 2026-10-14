import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OptionsDialog } from './OptionsDialog'
import { defaultAppOptions, loadAppOptions, resetAppOptions, saveAppOptions } from './app-options'

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

const openDialog = (props: { initialCategory?: string } = {}): HTMLElement => {
  const { container } = render(<OptionsDialog onClose={vi.fn()} initialCategory={props.initialCategory} />)
  return container
}

const tree = (): HTMLElement => within(screen.getByRole('dialog', { name: 'Options' })).getByRole('tree', { name: 'Categories' })

/** Top-level nodes, in upstream `AppSettingsPage.Order` sequence. */
const CATEGORIES = [
  'Environment',
  'Decompiler',
  'Compiler',
  'Debugger',
  'Disassembler',
  'Text Viewer',
  'Code Editor',
  'REPL',
  'Output Window',
  'Assembly Explorer',
  'BAML',
  'Hex Editor',
  'Background Image',
  'Bookmarks',
]

/** Every debugger control upstream renders on the single Debugger settings page. */
const DEBUGGER_LABELS = [
  'IsDebuggerPresent',
  'CheckRemoteDebuggerPresent',
  'System.Diagnostics.Debugger',
  'NtRaiseHardError',
  'CloseHandle',
  'Enable property evaluation and other implicit function calls',
  'Call string-conversion function on objects in variables windows',
  'Step over properties and operators',
  'Ignore Debugger.Break() and break instructions',
  'Show the Locals window when the debugger starts',
  "Debug files loaded from the process' memory (uncheck to use disk files)",
  'Break all processes when one process breaks',
  'Enable async debugging',
  'Give focus to debugged process',
  'Bring dnSpy to the foreground when breaking in the debugger',
  "Redirect GUI applications' console output to the Output window",
  'Enable Managed Debugging Assistants (MDA)',
  'Enable Just My Code debugging support',
  'Step over code in system modules',
  'Only step into code located in primary module',
  'Show raw structure of objects in variables windows',
  'Ignore unhandled exceptions',
  'System modules',
  'Program modules',
  'Hide compiler generated members',
  'Respect attributes that hide members',
  'Hide deprecated members in variables windows',
  'Sort parameters',
  'Sort locals',
  'Group parameters and locals together',
  'Show compiler generated variables',
  'Show decompiler generated variables',
  'Show raw locals',
  'Show return values',
  'Highlight changed variables in variables windows',
  'Syntax highlight',
]

describe('OptionsDialog', () => {
  it('renders every upstream settings category in the tree', () => {
    openDialog()
    const dialog = screen.getByRole('dialog', { name: 'Options' })
    expect(dialog).toBeInTheDocument()

    const categories = within(dialog).getByRole('tree', { name: 'Categories' })
    for (const label of CATEGORIES)
      expect(within(categories).getByRole('treeitem', { name: new RegExp(`^${label}`) })).toBeInTheDocument()
  })

  it('renders a category that owns a single page as one childless node', () => {
    openDialog()
    // These categories are a single page each, so the tree has nothing to expand.
    for (const label of ['Debugger', 'Assembly Explorer', 'BAML', 'Background Image', 'Bookmarks']) {
      const node = within(tree()).getByRole('treeitem', { name: new RegExp(`^${label}`) })
      expect(node).not.toHaveAttribute('aria-expanded')
    }
  })

  it('reveals the pages of the selected branch only', () => {
    openDialog()
    const categories = tree()

    // Environment owns General / Font and contains the default selection.
    expect(within(categories).getByRole('treeitem', { name: /^General/ })).toBeInTheDocument()
    expect(within(categories).getByRole('treeitem', { name: /^Font/ })).toBeInTheDocument()

    // Text Viewer is a sibling branch and stays folded until it is opened.
    expect(within(categories).getByRole('treeitem', { name: /^Text Viewer/ })).toHaveAttribute('aria-expanded', 'false')
    expect(within(categories).queryByRole('treeitem', { name: /^Scroll Bars/ })).not.toBeInTheDocument()
  })

  it('selects the Environment / General page by default', () => {
    openDialog()
    expect(screen.getByRole('heading', { name: 'General', level: 2 })).toBeInTheDocument()
    expect(screen.getByLabelText('Check for updates on startup')).toBeInTheDocument()
  })

  it('opens the requested root when initialCategory is given', () => {
    openDialog({ initialCategory: 'debugger' })
    // Upstream exposes every debugger option on one page, so the tree node and the
    // detail heading carry the same title and no breadcrumb is rendered.
    expect(screen.getByRole('heading', { name: 'Debugger', level: 2 })).toBeInTheDocument()
  })

  it('switches the detail pane when a different tree page is selected', () => {
    openDialog()
    expect(screen.getByRole('heading', { name: 'General', level: 2 })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('treeitem', { name: /^Font/ }))
    expect(screen.getByRole('heading', { name: 'Font', level: 2 })).toBeInTheDocument()
    expect((screen.getByLabelText('Font') as HTMLInputElement).value).toBe('Cascadia Mono')
  })

  it('renders every option of the upstream debugger settings page', () => {
    openDialog({ initialCategory: 'debugger' })
    for (const label of DEBUGGER_LABELS)
      expect(screen.getByLabelText(label)).toBeInTheDocument()
  })

  it('groups the debugger page the same way the upstream page does', () => {
    openDialog({ initialCategory: 'debugger' })
    expect(screen.getByRole('group', { name: 'Prevent code from detecting the debugger' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Suppress JIT optimization on module load' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Language' })).toBeInTheDocument()
  })

  it('frames each titled group as a WPF GroupBox and leaves an untitled list bare', () => {
    openDialog({ initialCategory: 'debugger' })
    const body = document.querySelector('.options-detail-body') as HTMLElement

    // The three GroupBoxes on this page. A `legend` inside a `fieldset` is what lets the
    // browser notch the title into the top border, so the frame and the header travel
    // together; the stylesheet relies on this exact markup.
    const framed = Array.from(body.querySelectorAll('fieldset.options-group'))
    expect(framed).toHaveLength(3)
    for (const box of framed)
      expect(box.querySelector('legend.options-group-title')?.textContent).toBeTruthy()

    // The two plain lists are named by the page heading above them, so they get no frame.
    const bare = Array.from(body.querySelectorAll('div.options-group'))
    expect(bare).toHaveLength(2)
    for (const list of bare)
      expect(list.querySelector('legend')).toBeNull()
  })

  it('exposes the debug engine and language selectors of the Language group', () => {
    openDialog({ initialCategory: 'debugger' })
    const engine = screen.getByLabelText('Debug Engine') as HTMLSelectElement
    const language = screen.getByLabelText('Language') as HTMLSelectElement
    expect(engine.value).toBe('dotnet')
    expect(Array.from(engine.options).map((option) => option.value)).toEqual(['dotnet'])
    expect(language.value).toBe('C#')
    expect(Array.from(language.options).map((option) => option.value)).toEqual(['C#', 'Visual Basic'])

    fireEvent.change(language, { target: { value: 'Visual Basic' } })
    expect(language.value).toBe('Visual Basic')
  })

  it('does not offer the debugger options that upstream only exposes from context menus', () => {
    openDialog({ initialCategory: 'debugger' })
    expect(screen.queryByText('Use hexadecimal numbers')).not.toBeInTheDocument()
    expect(screen.queryByText('Use digit separators')).not.toBeInTheDocument()
    expect(screen.queryByText('Show only public members in variables windows')).not.toBeInTheDocument()
  })

  it('updates a debugger checkbox in real time', () => {
    openDialog({ initialCategory: 'debugger' })
    const checkbox = screen.getByLabelText('Ignore Debugger.Break() and break instructions')
    expect(checkbox).not.toBeChecked()

    fireEvent.click(checkbox)
    expect(checkbox).toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(loadAppOptions().debugger.ignoreBreakInstructions).toBe(true)
  })

  it('disables dependent debugger options until their prerequisite is enabled', () => {
    openDialog({ initialCategory: 'debugger' })
    const callConversion = screen.getByLabelText('Call string-conversion function on objects in variables windows')
    const stepOverSystemModules = screen.getByLabelText('Step over code in system modules')
    expect(callConversion).not.toBeDisabled()
    expect(stepOverSystemModules).toBeDisabled()

    fireEvent.click(screen.getByLabelText('Enable property evaluation and other implicit function calls'))
    expect(callConversion).toBeDisabled()
    expect(callConversion).not.toBeChecked()

    fireEvent.click(screen.getByLabelText('Enable Just My Code debugging support'))
    expect(stepOverSystemModules).not.toBeDisabled()
  })

  it('updates the theme from the Environment / General page', () => {
    openDialog()
    const theme = screen.getByLabelText('Theme') as HTMLSelectElement
    expect(theme.value).toBe('dark')
    fireEvent.change(theme, { target: { value: 'light' } })
    expect(theme.value).toBe('light')

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(loadAppOptions().environmentGeneral.theme).toBe('light')
  })

  it('renders the two ILSpy decompiler pages', () => {
    openDialog({ initialCategory: 'decompiler' })
    expect(screen.getByRole('heading', { name: 'C# / Visual Basic (ILSpy)', level: 2 })).toBeInTheDocument()
    expect(screen.getByLabelText('Decompile async methods (async/await)')).toBeChecked()
    // The Decompilation order group box is rendered as a WPF GroupBox would be.
    expect(screen.getByRole('group', { name: 'Decompilation order' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('treeitem', { name: /^Decompiler/ }))
    fireEvent.click(screen.getByRole('treeitem', { name: /^IL \(ILSpy\)/ }))
    expect(screen.getByLabelText('Show IL instruction bytes')).toBeChecked()
    expect(screen.getByLabelText('Show IL opcode comments')).not.toBeChecked()
  })

  it('shows the disassembler page and its nested code style pages', () => {
    openDialog({ initialCategory: 'disassembler' })
    // The Disassembler node is both a page and a container.
    expect(screen.getByRole('heading', { name: 'Disassembler', level: 2 })).toBeInTheDocument()
    expect(screen.getByLabelText('Show decompiled code')).toBeChecked()

    fireEvent.click(screen.getByRole('treeitem', { name: /^Code Style/ }))
    expect(screen.getByRole('treeitem', { name: /^masm/ })).toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: /^nasm/ })).toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: /^AT&T/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('treeitem', { name: /^AT&T/ }))
    // GAS keeps its own prefix/suffix defaults.
    expect((screen.getByLabelText('Hex prefix') as HTMLInputElement).value).toBe('0x')
    expect((screen.getByLabelText('Hex suffix') as HTMLInputElement).value).toBe('')
    // ...and offers an option masm/nasm do not have.
    expect(screen.getByLabelText('Naked registers')).toBeInTheDocument()
    expect(screen.queryByLabelText('Upper case keywords')).not.toBeInTheDocument()
  })

  it('nests a language level under the Code Editor and REPL categories', () => {
    const container = openDialog({ initialCategory: 'codeEditor' })

    // Selecting the category lands on the first leaf of the first language.
    expect(screen.getByRole('heading', { name: 'General', level: 2 })).toBeInTheDocument()
    expect(container.querySelector('.options-detail-breadcrumb')?.textContent).toBe('Code EditorC#General')

    fireEvent.click(screen.getByRole('treeitem', { name: /^Code Editor/ }))
    expect(screen.getByRole('treeitem', { name: /^C#/ })).toBeInTheDocument()
    expect(screen.getByRole('treeitem', { name: /^Visual Basic/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('treeitem', { name: /^Visual Basic/ }))
    expect(container.querySelector('.options-detail-breadcrumb')?.textContent).toBe('Code EditorVisual BasicGeneral')
    expect(screen.getByLabelText('Virtual space')).not.toBeChecked()
  })

  it('renders the text viewer and output pages', () => {
    openDialog({ initialCategory: 'documentViewer' })
    expect(screen.getByRole('heading', { name: 'General', level: 2 })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('treeitem', { name: /^Text Viewer/ }))
    fireEvent.click(screen.getByRole('treeitem', { name: /^Advanced/ }))
    expect(screen.getByLabelText('Show indent guides')).toBeChecked()
    expect((screen.getByLabelText('Indent guides style') as HTMLSelectElement).value).toBe('dashed3')

    cleanup()
    openDialog({ initialCategory: 'output' })
    expect((screen.getByLabelText('Timestamp format') as HTMLInputElement).value).toBe('HH:mm:ss.fff')
  })

  it('renders the compiler pages per language', () => {
    openDialog({ initialCategory: 'compiler' })
    expect((screen.getByLabelText('Conditional compilation symbols') as HTMLInputElement).value).toBe('TRACE')
    fireEvent.click(screen.getByRole('treeitem', { name: /^Visual Basic/ }))
    expect(screen.getByLabelText('Option strict')).not.toBeChecked()
    expect(screen.queryByLabelText('Allow unsafe code')).not.toBeInTheDocument()
  })

  it('shows both hex editor groups and the remaining single pages', () => {
    openDialog({ initialCategory: 'hexEditor' })
    // Hex Editor contains one node per view, each with its own General/Scroll Bars/Advanced.
    expect(screen.getByRole('heading', { name: 'General', level: 2 })).toBeInTheDocument()
    expect(within(tree()).getByRole('treeitem', { name: /^Default/ })).toBeInTheDocument()
    expect(within(tree()).getByRole('treeitem', { name: /^Memory Window/ })).toBeInTheDocument()
    expect((screen.getByLabelText('Group size') as HTMLInputElement).value).toBe('0')
    expect((screen.getByLabelText('Encoding') as HTMLSelectElement).value).toBe('utf8')

    for (const [root, label] of [['backgroundImage', 'Background Image'], ['bookmarks', 'Bookmarks']] as const) {
      cleanup()
      openDialog({ initialCategory: root })
      expect(screen.getByRole('heading', { name: label, level: 2 })).toBeInTheDocument()
    }
  })

  it('restores defaults when Restore Defaults is clicked', async () => {
    saveAppOptions({ ...defaultAppOptions, debugger: { ...defaultAppOptions.debugger, ignoreBreakInstructions: true } })
    openDialog({ initialCategory: 'debugger' })
    expect(screen.getByLabelText('Ignore Debugger.Break() and break instructions')).toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: 'Restore Defaults' }))
    await waitFor(() => expect(screen.getByLabelText('Ignore Debugger.Break() and break instructions')).not.toBeChecked())
  })

  it('filters the tree by category, page and control labels', () => {
    openDialog()
    const categories = tree()
    const search = within(categories.parentElement as HTMLElement).getByLabelText('Search settings')

    fireEvent.change(search, { target: { value: 'Just My Code' } })
    expect(within(categories).getByRole('treeitem', { name: /^Debugger/ })).toBeInTheDocument()
    expect(within(categories).queryByRole('treeitem', { name: /^Decompiler/ })).not.toBeInTheDocument()

    // A match buried three levels deep (Code Editor > C# > Advanced) keeps its ancestors.
    fireEvent.change(search, { target: { value: 'Mouse wheel zoom' } })
    expect(within(categories).getByRole('treeitem', { name: /^Code Editor/ })).toBeInTheDocument()
    expect(within(categories).getByRole('treeitem', { name: /^REPL/ })).toBeInTheDocument()
    // Both three-level branches keep one C# node each, and their Advanced page with it.
    expect(within(categories).getAllByRole('treeitem', { name: /^C#/ })).toHaveLength(2)
    expect(within(categories).getAllByRole('treeitem', { name: /^Advanced/ }).length).toBeGreaterThanOrEqual(2)
    expect(within(categories).queryByRole('treeitem', { name: /^Debugger/ })).not.toBeInTheDocument()
    expect(within(categories).queryByRole('treeitem', { name: /^Environment/ })).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'no-such-setting' } })
    expect(within(categories).queryAllByRole('treeitem')).toHaveLength(0)
  })

  it('closes the dialog when Cancel / close button / Escape are pressed', () => {
    const onClose = vi.fn()
    render(<OptionsDialog onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledOnce()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('does not persist changes when Cancel is clicked', () => {
    saveAppOptions(resetAppOptions())
    openDialog({ initialCategory: 'debugger' })
    fireEvent.click(screen.getByLabelText('Ignore Debugger.Break() and break instructions'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(loadAppOptions().debugger.ignoreBreakInstructions).toBe(false)
  })
})
