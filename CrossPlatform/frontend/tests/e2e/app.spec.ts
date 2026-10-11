import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let application: ElectronApplication
let page: Page
let userDataDirectory: string
let savePath: string
let saveCodePath: string
let importBookmarksPath: string
let showInFolderPath: string
let saveResourcePath: string
const contractsAssemblyPath = path.resolve(import.meta.dirname, '../../../backend/dnSpy.Backend.Contracts/bin/Debug/net10.0/dnSpy.Backend.Contracts.dll')
const debugTargetPath = path.resolve(import.meta.dirname, '../../../backend/tests/DebugTarget/bin/Debug/net10.0/DebugTarget.dll')
// The one fixture with embedded resources: a WPF project's generated .g.resources, plus the .baml stream
// inside it. Saving needs something to save, which neither of the other two assemblies has.
const bamlTargetPath = path.resolve(import.meta.dirname, '../../../backend/tests/BamlTarget/bin/Debug/net10.0-windows/BamlTarget.dll')
// The one fixture that references another assembly sitting beside it in its own output directory, which is
// what Load Dependencies needs to have anything to resolve.
const coreAssemblyPath = path.resolve(import.meta.dirname, '../../../backend/dnSpy.Backend.Core/bin/Debug/net10.0/dnSpy.Backend.Core.dll')

// A session only survives if the profile does, so a restore test launches twice against one directory
// rather than letting every launch start from a fresh one.
interface LaunchOptions {
  userDataDirectory?: string
  extraArgs?: string[]
  /** What the assembly picker hands back from its second call on. Lets a test open a different file. */
  secondAssembly?: string
}

// The environment decides what the Open Assembly button hands back. A debug test opens the debuggee itself,
// because the in-process engine turns a decompiled line into an IL offset through the module's statement map
// and that map only exists for an assembly the workspace has decompiled.
const launchApp = async (assemblies: string, options: LaunchOptions = {}): Promise<void> => {
  userDataDirectory = options.userDataDirectory ?? mkdtempSync(path.join(os.tmpdir(), 'dnspy-e2e-'))
  savePath = path.join(userDataDirectory, 'saved-module.dll')
  saveCodePath = path.join(userDataDirectory, 'saved-code.cs')
  importBookmarksPath = path.join(userDataDirectory, 'bookmarks-to-import.json')
  showInFolderPath = path.join(userDataDirectory, 'show-in-folder.txt')
  saveResourcePath = path.join(userDataDirectory, 'saved-resource.bin')
  application = await electron.launch({
    args: ['.', '--no-sandbox', `--user-data-dir=${userDataDirectory}`, ...(options.extraArgs ?? [])],
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: {
      ...process.env,
      DNSPY_E2E_ASSEMBLY: assemblies,
      ...(options.secondAssembly ? { DNSPY_E2E_SECOND_ASSEMBLY: options.secondAssembly } : {}),
      DNSPY_E2E_DEBUG_TARGET: debugTargetPath,
      DNSPY_E2E_SAVE_PATH: savePath,
      DNSPY_E2E_SAVE_CODE_PATH: saveCodePath,
      DNSPY_E2E_OPEN_TEXT_FILE: importBookmarksPath,
      DNSPY_E2E_SHOW_IN_FOLDER_PATH: showInFolderPath,
      DNSPY_E2E_SAVE_RESOURCE_PATH: saveResourcePath,
    },
  })
  page = await application.firstWindow()
  page.on('dialog', (dialog) => void dialog.accept())
  await page.waitForLoadState('domcontentloaded')
}

const closeApp = async (options: { keepUserData?: boolean } = {}): Promise<void> => {
  await application?.close()
  if (!options.keepUserData)
    rmSync(userDataDirectory, { recursive: true, force: true })
}

/** The Bookmarks window and Output are not among the tool windows a fresh layout opens with — it carries
 * only the six dnSpy's own does — so each is brought up from the View menu before it is read from. */
const showBookmarksWindow = async (): Promise<void> => {
  await page.getByRole('menuitem', { name: 'View' }).click()
  await page.getByRole('menuitem', { name: 'Bookmarks', exact: true }).hover()
  await page.getByRole('menuitem', { name: /^Bookmarks Window/ }).click()
}

const showOutput = async (): Promise<void> => {
  await page.getByRole('menuitem', { name: 'View' }).click()
  await page.getByRole('menuitem', { name: /^Output/ }).click()
}

/** Breakpoints is not one of the six tool windows the default layout docks — dnSpy keeps it on the Debug
 * menu — so a test that reads the breakpoint list opens the window from there first, the way a user would. */
const showBreakpoints = async (): Promise<void> => {
  await page.getByRole('menuitem', { name: 'Debug', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Window', exact: true }).hover()
  const breakpointsMenuItem = page.getByRole('menuitem', { name: /^Breakpoints/ })
  if ((await breakpointsMenuItem.getAttribute('aria-checked')) === 'true') {
    await page.keyboard.press('Escape')
    return
  }
  await breakpointsMenuItem.click()
}

/** The exception list lives behind the same Debug menu. Unlike Breakpoints the window is docked in the
 * default layout, so it is usually already there as a tab — the menu is only how a closed one comes back. */
const showExceptionSettings = async (): Promise<void> => {
  const tab = page.getByRole('tab', { name: 'Exception Settings' })
  if ((await tab.count()) === 0) {
    await page.getByRole('menuitem', { name: 'Debug', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Window', exact: true }).hover()
    await page.getByRole('menuitem', { name: /^Exception Settings/ }).click()
  }
  await tab.click()
}

/** A row's expander is clicked only when the row is still collapsed: the assembly explorer opens an
 * assembly collapsed, while the type picker opens with its roots already expanded, and a blind click
 * would fold the picker's instead. */
const expandRow = async (row: Locator): Promise<void> => {
  await expect(row).toBeVisible()
  if ((await row.getAttribute('aria-expanded')) === 'false')
    await row.locator('.tree-expander').click()
}

/** An assembly loads as a single collapsed root whose one child is the module; the namespaces and the
 * reference folders hang off that module, the way dnSpy's own tree nests them. Reaching any of them means
 * opening those two levels first. The scope is the assembly explorer by default, or a picker dialog. */
const expandModule = async (scope: Locator | Page = page): Promise<void> => {
  await expandRow(scope.locator('.tree-row[data-kind="assembly"]').first())
  await expandRow(scope.locator('.tree-row[data-kind="module"]').first())
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** A source line and the gutter column beside it — the two coordinates a gutter click is built from.
 * Monaco lays the editor out on its own, once when the document opens and again after a resize, and no
 * check of its own gates the read: the elements are visible throughout, but the relayout rebuilds the view
 * lines, so a box read in its middle belongs to a node the editor is already swapping out — attached, and
 * with nothing left to click in. The boxes are therefore polled rather than read once, and a read is only
 * trusted once a second one agrees with it: the pair is what says the layout has stopped moving, and with
 * it that the coordinates the click is aimed at will still be these by the time it lands. */
const editorLayout = async (line: Locator, margin: Locator): Promise<{ lineBox: Box; marginBox: Box }> => {
  await expect(line).toBeVisible()
  await expect(margin).toBeVisible()
  let seen = ''
  let boxes: { lineBox: Box; marginBox: Box } | undefined
  await expect(async () => {
    const lineBox = await line.boundingBox()
    const marginBox = await margin.boundingBox()
    if (!lineBox?.width || !lineBox.height || !marginBox?.width || !marginBox.height)
      throw new Error('The editor is not laid out yet.')
    const next = JSON.stringify([lineBox, marginBox])
    if (next !== seen) {
      seen = next
      throw new Error('The editor is still being laid out.')
    }
    boxes = { lineBox, marginBox }
  }).toPass({ timeout: 15_000 })
  return boxes!
}

const openAssemblyAndNamespace = async (): Promise<void> => {
  await page.getByRole('button', { name: 'Open Assembly' }).first().click()
  await expect(page.getByRole('treeitem').first()).toContainText('dnSpy.Backend.Contracts')
  // The menu's own entries name files too, so the root button is asked for by its exact name.
  const fileMenu = page.getByRole('menuitem', { name: 'File', exact: true })
  await fileMenu.click()
  // The remembered sessions live under File > Recent Files, the way dnSpy has them. The row is hovered
  // rather than clicked, like the other submenu rows here: a click both hovers the row and toggles the
  // submenu, so it shuts again whenever the hover lands first — a race that only shows up on a slow
  // machine. Hovering can only open it, and the row says whether it did before the entries are read.
  const recentFiles = page.getByRole('menuitem', { name: 'Recent Files' })
  await recentFiles.hover()
  await expect(recentFiles).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('menuitem', { name: /dnSpy\.Backend\.Contracts\.dll/ })).toBeVisible()
  await fileMenu.click()
  await expandModule()
  const namespaceRow = page.locator('.tree-row[data-kind="namespace"]').filter({ hasText: /^dnSpy\.Backend\.Contracts$/ })
  await expect(namespaceRow).toBeVisible()
  await namespaceRow.locator('.tree-expander').click()
}

test.describe('the workspace shell', () => {
  test.beforeEach(async () => { await launchApp(contractsAssemblyPath) })
  test.afterEach(async () => { await closeApp() })

  test('starts the backend and renders the upstream-style shell', async () => {
    await expect(page.getByRole('menubar')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Minimize window' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Maximize window' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Close window' })).toBeVisible()
    await expect(page.getByRole('toolbar', { name: 'Main toolbar' })).toBeVisible()
    await expect(page.getByText('Ready', { exact: true })).toBeVisible()
    await expect(page.locator('.dock-caption-title', { hasText: 'Assembly Explorer' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Locals' })).toBeVisible()
  })

  test('opens and closes the in-app About dialog', async () => {
    const nativeDialogs: string[] = []
    page.on('dialog', (dialog) => nativeDialogs.push(dialog.message()))

    await page.getByRole('menuitem', { name: 'Help' }).click()
    await page.getByRole('menuitem', { name: 'About dnSpy' }).click()

    const about = page.getByRole('dialog', { name: 'About dnSpy' })
    await expect(about).toBeVisible()
    await expect(about).toContainText('Version 1.0.0')
    await expect(about).toContainText('GNU GPL v3.0 only')
    expect(nativeDialogs).toEqual([])

    await page.keyboard.press('Escape')
    await expect(about).not.toBeVisible()
    await expect(page.getByRole('toolbar', { name: 'Main toolbar' })).toBeVisible()
  })

  test('shows the upstream File menu, in its order, with what it cannot do greyed out', async () => {
    await page.getByRole('menuitem', { name: 'File', exact: true }).click()

    // dnSpy hides its restart entry while the app is already elevated, so a run under a normal user
    // and one under root see different menus. Ask the app which it is rather than assuming.
    const elevated = await application.evaluate(() => process.getuid?.() === 0)

    // The labels only: the shortcut column is a sibling span, so the row's text is asked for directly.
    const labels = page.locator('.menu-popup > .menu-item > span:nth-child(2), .menu-popup > .menu-item-row > .menu-item > span:nth-child(2)')
    await expect(labels).toHaveText([
      'Export to Project...', 'Save', 'Save Module...', 'Save All...',
      'Open...', 'Open from GAC...', 'Open List...', 'Recent Files', 'Reload All Assemblies',
      'Close All', 'Close Old In-Memory Modules', 'Close All Framework Assemblies', 'Close All Missing Files',
      'Sort Assemblies',
      ...(elevated ? [] : ['Restart as Administrator']),
      'Exit',
    ])

    // Nothing is open yet, so the entries that work on a workspace are greyed; the ones Linux has no
    // command for are greyed whatever is open. The row is found by its label span, since the shortcut
    // column next to it is part of the button's own text.
    const row = (label: string) => page
      .locator('.menu-popup > .menu-item, .menu-popup > .menu-item-row > .menu-item')
      .filter({ has: page.locator(`span:nth-child(2):text-is("${label}")`) })
    for (const label of ['Export to Project...', 'Save', 'Save All...', 'Open from GAC...', 'Open List...', 'Reload All Assemblies', 'Close All', 'Close Old In-Memory Modules', 'Close All Framework Assemblies', 'Close All Missing Files', 'Sort Assemblies'])
      await expect(row(label)).toBeDisabled()
    await expect(row('Open...')).toBeEnabled()
    // The restart entry is Unix dnSpy's: never greyed, only present or absent.
    if (!elevated)
      await expect(row('Restart as Administrator')).toBeEnabled()
    await expect(row('Exit')).toBeEnabled()
  })

  test('maximizes and restores the window from the title bar', async () => {
    const browserWindow = await application.browserWindow(page)
    await page.getByRole('button', { name: 'Maximize window' }).click()
    await expect(page.getByRole('button', { name: 'Restore window' })).toBeVisible()
    expect(await browserWindow.evaluate((window) => window.isMaximized())).toBe(true)

    await page.getByRole('button', { name: 'Restore window' }).click()
    await expect(page.getByRole('button', { name: 'Maximize window' })).toBeVisible()
    expect(await browserWindow.evaluate((window) => window.isMaximized())).toBe(false)
  })

  test('persists themes across renderer reloads', async () => {
    await page.getByRole('menuitem', { name: 'View' }).click()
    // The themes sit in a submenu, which opens while the pointer rests on its parent row.
    await page.getByRole('menuitem', { name: /^Theme$/ }).hover()
    await page.getByRole('menuitem', { name: 'Light', exact: true }).click()
    await page.getByRole('tab', { name: 'Search' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(page.getByText('Ready', { exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('menuitem', { name: 'View' }).click()
    await page.getByRole('menuitem', { name: /^Theme$/ }).hover()
    await page.getByRole('menuitem', { name: 'High Contrast' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'hc')
  })

  test('switches to Simplified Chinese and persists the language', async () => {
    await page.getByRole('menuitem', { name: 'View' }).click()
    await page.getByRole('menuitem', { name: 'Language' }).hover()
    await page.getByRole('menuitem', { name: 'Simplified Chinese' }).click()

    await expect(page.getByRole('menuitem', { name: '文件' })).toBeVisible()
    await expect(page.getByText('就绪', { exact: true })).toBeVisible()
    await expect(page.locator('.dock-caption-title', { hasText: '程序集资源管理器' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await page.getByRole('button', { name: '打开程序集' }).first().click()
    await expect(page.getByRole('treeitem').first()).toContainText('dnSpy.Backend.Contracts')
    await expandModule()
    await expect(page.locator('.tree-row[data-kind="referencesgroup"]')).toContainText('程序集引用')

    // The C# Interactive window is named the way the WPF menu names it.
    await page.getByRole('menuitem', { name: '视图' }).click()
    await expect(page.getByRole('menuitem', { name: 'C# 交互' })).toBeVisible()
    await page.getByRole('menuitem', { name: '视图' }).click()
    await page.screenshot({ path: 'test-results/dnspy-shell-zh-CN.png' })

    await page.reload()
    await expect(page.getByRole('menuitem', { name: '视图' })).toBeVisible()
    await expect(page.getByText('就绪', { exact: true })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  })

  test('opens a real assembly, expands the tree and decompiles a type', async () => {
    await openAssemblyAndNamespace()
    const browserWindow = await application.browserWindow(page)
    await browserWindow.evaluate((window) => window.setSize(1500, 700))

    const typeRow = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^HelloRequest @02000005$/ })
    await expect(typeRow).toBeVisible()
    await typeRow.dblclick()

    const editor = page.locator('.monaco-editor')
    await expect(editor).toBeVisible()
    await expect.poll(async () => (await editor.locator('.view-lines').innerText()).replaceAll('\u00a0', ' ')).toContain('record HelloRequest')

    await page.getByLabel('Decompiler language').selectOption('il')
    await expect.poll(async () => editor.locator('.view-lines').innerText()).toContain('.class')
    await expect(editor).toHaveAttribute('data-language-id', 'il')
    await editor.click()
    await expect.poll(async () => editor.locator('.view-lines').innerText()).toContain('<ProtocolVersion>k__BackingField')
    const ilTokens = await editor.locator('.view-lines span[class*="mtk"]').evaluateAll((tokens) => tokens.map((token) => ({
      text: token.textContent,
      color: getComputedStyle(token).color,
      fontWeight: getComputedStyle(token).fontWeight,
    })).filter((token) => token.text?.trim()))
    expect(ilTokens.find((token) => token.text === '.method')?.color).toBe('rgb(86, 156, 214)')
    expect(ilTokens.find((token) => token.text === 'IL_0000')?.color).toBe('rgb(215, 186, 125)')
    expect(ilTokens.find((token) => token.text === 'ldarg.0')?.color).toBe('rgb(197, 134, 192)')
    expect(ilTokens.find((token) => token.text === 'ldarg.0')?.fontWeight).toBe('700')
    expect(ilTokens.find((token) => token.text === 'System.Int32')?.color).toBe('rgb(78, 201, 176)')
    expect(ilTokens.find((token) => token.text === '<ProtocolVersion>k__BackingField')?.color).toBe('rgb(220, 220, 170)')
    await page.screenshot({ path: 'test-results/dnspy-il-highlighting.png' })

    await page.getByLabel('Decompiler language').selectOption('ilWithCSharp')
    await editor.click()
    await page.keyboard.press('PageDown')
    await expect.poll(async () => editor.locator('.view-lines').innerText()).toContain('//')
    await expect.poll(async () => editor.locator('.view-lines').innerText()).toContain('IL_')
    await page.screenshot({ path: 'test-results/dnspy-shell.png' })
  })

  test('runs document tab commands from the title context menu', async () => {
    await openAssemblyAndNamespace()
    const helloRequest = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^HelloRequest @02000005$/ })
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @02000076$/ })
    await helloRequest.dblclick()
    await expect.poll(async () => (await page.locator('.monaco-editor .view-lines').innerText()).replaceAll('\u00a0', ' ')).toContain('record HelloRequest')
    await rpcException.dblclick()
    await expect(page.getByRole('tab', { name: 'RpcException' })).toBeVisible()

    const helloTab = page.getByRole('tab', { name: 'HelloRequest' })
    await helloTab.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Tab actions' })
    await expect(menu.getByRole('menuitem', { name: /Save Code/ })).toBeEnabled()
    await expect(menu.getByRole('menuitem', { name: /^Close Ctrl\+F4$/ })).toBeEnabled()
    await expect(menu.getByRole('menuitem', { name: 'Close All Tabs' })).toBeEnabled()
    await expect(menu.getByRole('menuitem', { name: 'Close All But This' })).toBeEnabled()
    await expect(menu.getByRole('menuitem', { name: 'New Tab' })).toBeEnabled()
    await expect(menu.getByRole('menuitem', { name: 'New Horizontal Tab Group' })).toBeEnabled()
    await expect(menu.getByRole('menuitem', { name: 'New Vertical Tab Group' })).toBeEnabled()

    await menu.getByRole('menuitem', { name: /Save Code/ }).click()
    await expect.poll(() => existsSync(saveCodePath)).toBe(true)
    expect(readFileSync(saveCodePath, 'utf8')).toContain('record HelloRequest')

    await helloTab.click({ button: 'right' })
    await page.getByRole('menu', { name: 'Tab actions' }).getByRole('menuitem', { name: 'New Tab' }).click()
    await expect(page.getByRole('tab', { name: 'HelloRequest' })).toHaveCount(2)

    await page.getByRole('tab', { name: 'HelloRequest' }).last().click({ button: 'right' })
    await page.getByRole('menu', { name: 'Tab actions' }).getByRole('menuitem', { name: 'New Horizontal Tab Group' }).click()
    // Four: the explorer's column, the editor group, the one the split added, and the tool window dock.
    await expect(page.locator('.flexlayout__tabset')).toHaveCount(4)

    await page.getByRole('tab', { name: 'RpcException' }).click({ button: 'right' })
    await expect(page.getByRole('menu', { name: 'Tab actions' }).getByRole('menuitem', { name: 'New Horizontal Tab Group' })).toBeVisible()
    await expect(page.getByRole('menu', { name: 'Tab actions' }).getByRole('menuitem', { name: 'New Vertical Tab Group' })).toHaveCount(0)

    await page.keyboard.press('Escape')
    rmSync(saveCodePath)
    await page.keyboard.press('Control+s')
    await expect.poll(() => existsSync(saveCodePath)).toBe(true)
    expect(readFileSync(saveCodePath, 'utf8')).toContain('class RpcException')

    await page.keyboard.press('Control+t')
    await expect(page.getByRole('tab', { name: 'RpcException' })).toHaveCount(2)
    await page.keyboard.press('Control+F4')
    await expect(page.getByRole('tab', { name: 'RpcException' })).toHaveCount(1)
  })

  test('navigates C# references with F12 and document history', async () => {
    await openAssemblyAndNamespace()
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @02000076$/ })
    await rpcException.locator('.tree-expander').click()
    const getCode = page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^get_Code\(\) : int @060008CC$/ })
    await getCode.dblclick()

    await expect(page.locator('.document-view')).toHaveAttribute('data-reference-count', /^[1-9]\d*$/)
    const reference = page.locator('.monaco-editor .view-lines').getByText(/BackingField/).first()
    await expect(reference).toBeVisible()
    await reference.click()
    await page.keyboard.press('F12')

    const targetTab = page.getByRole('tab', { name: /BackingField/ })
    await expect(targetTab).toBeVisible()
    // The explorer follows the tab that came to the front — dnSpy selects a document's nodes whenever its
    // tab is shown — so the row the reference led to is the one the tree is on.
    await expect(page.locator('.tree-row.selected')).toHaveText(/BackingField/)
    const toolbar = page.getByRole('toolbar', { name: 'Main toolbar' })
    await expect(toolbar.getByRole('button', { name: 'Back' })).toBeEnabled()
    await toolbar.getByRole('button', { name: 'Back' }).click()
    await expect(page.getByRole('tab', { name: 'get_Code() : int' })).toHaveAttribute('aria-selected', 'true')
    await expect(toolbar.getByRole('button', { name: 'Forward' })).toBeEnabled()
  })

  test('follows a reference into a module the tree does not hold', async () => {
    await openAssemblyAndNamespace()
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @02000076$/ })
    await rpcException.dblclick()
    await expect(page.getByRole('tab', { name: 'RpcException' })).toBeVisible()

    // The base type belongs to an assembly the workspace holds nothing of. The reference names the file
    // and the token the target has there, so the module is opened on demand and the tree gains a root it
    // never had — and the explorer still has to reach the target, though it has never listed one node of
    // that module and could not have worked out where the node sits from its id.
    await expect(page.locator('.tree-row[data-kind="assembly"]')).toHaveCount(1)
    const baseType = page.locator('.monaco-editor .view-lines').getByText(/^Exception$/).first()
    await expect(baseType).toBeVisible()
    await baseType.click()
    await page.keyboard.press('F12')

    await expect(page.locator('.tree-row[data-kind="assembly"]')).toHaveCount(2)
    const followed = page.locator('.tree-row.selected')
    await expect(followed).toHaveAttribute('data-kind', 'type')
    await expect(followed).toHaveText(/^Exception @/)
  })

  test('opens search results without requiring their tree nodes to be expanded', async () => {
    await page.getByRole('button', { name: 'Open Assembly' }).first().click()
    await expect(page.getByRole('treeitem').first()).toContainText('dnSpy.Backend.Contracts')
    await page.getByRole('toolbar', { name: 'Main toolbar' }).getByRole('button', { name: 'Search' }).click()
    await page.getByRole('textbox', { name: 'Search assemblies' }).fill('HelloRequest')
    await page.getByRole('button', { name: 'Search', exact: true }).last().click()
    const result = page.locator('.result-row').filter({ hasText: 'dnSpy.Backend.Contracts.HelloRequest' }).first()
    await expect(result).toBeVisible()
    await result.dblclick()
    await expect(page.getByRole('tab', { name: 'HelloRequest' })).toBeVisible()
    await expect(page.locator('.monaco-editor')).toBeVisible()
  })

  test('opens module tools and commits metadata and IL edits', async () => {
    await page.getByRole('button', { name: 'Open Assembly' }).first().click()
    await expect(page.getByRole('treeitem').first()).toContainText('dnSpy.Backend.Contracts')
    await expandModule()

    // Module tools live on the module's context menu in the explorer, not in the View menu.
    const moduleRow = page.locator('.tree-row[data-kind="module"]').first()
    await moduleRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Module Information' }).click()
    await expect(page.getByText('MVID', { exact: true })).toBeVisible()
    await expect(page.getByRole('table', { name: 'Metadata Tables' })).toContainText('TypeDef')

    await moduleRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Open Hex Editor' }).click()
    await expect(page.locator('.hex-content')).toContainText('4D 5A')

    const namespaceRow = page.locator('.tree-row[data-kind="namespace"]').filter({ hasText: /^dnSpy\.Backend\.Contracts$/ })
    await namespaceRow.locator('.tree-expander').click()
    const helloType = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^HelloRequest @02000005$/ })
    await helloType.click()
    // Rename is a tree command in dnSpy, not an Edit menu entry, so it is F2 here too.
    await page.keyboard.press('F2')
    const renameDialog = page.getByRole('dialog', { name: 'Rename' })
    await renameDialog.getByLabel('Name').fill('HelloRequestEdited')
    await renameDialog.getByRole('button', { name: 'Rename' }).click()
    await expect(page.locator('.tree-row[data-kind="type"]').filter({ hasText: /HelloRequestEdited/ })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await page.getByRole('menuitem', { name: /^Undo/ }).click()
    await expect(page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^HelloRequest @02000005$/ })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await page.getByRole('menuitem', { name: /^Redo/ }).click()
    await expect(page.locator('.tree-row[data-kind="type"]').filter({ hasText: /HelloRequestEdited/ })).toBeVisible()

    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @02000076$/ })
    await rpcException.locator('.tree-expander').click()
    const getCode = page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^get_Code\(\) : int @060008CC$/ })
    await getCode.click()
    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await page.getByRole('menuitem', { name: 'Edit Method Body...' }).click()
    const ilDialog = page.getByRole('dialog', { name: /Edit IL/ })
    await expect(ilDialog.getByLabel('Opcode 0')).toBeVisible()
    await ilDialog.getByRole('button', { name: 'Apply' }).click()
    await expect(page.getByText('Modified', { exact: true })).toBeVisible()
    await page.getByRole('toolbar', { name: 'Main toolbar' }).getByRole('button', { name: 'Save As' }).click()
    await expect(page.getByText('Modified', { exact: true })).not.toBeVisible()
    expect(existsSync(savePath)).toBe(true)
  })

  test('opens the tree context menu with the WPF commands for the row that was clicked', async () => {
    await openAssemblyAndNamespace()

    // dnSpy builds this menu from the tree's selection, and a right click selects the row before the menu
    // opens, so a type offers the type's own commands: the delete, the six creates, the editor, the token
    // copies, the shared hex group, the one debugger command a type can name — everything its methods are
    // — and the three outer ones. A row is read by its label span, since the shortcut beside it is part of
    // the item's own text.
    const menu = page.getByRole('menu', { name: 'Assembly Explorer' })
    const helloType = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^HelloRequest @02000005$/ })
    await helloType.click({ button: 'right' })
    await expect(menu.locator('.document-tab-menu-label')).toHaveText([
      'Open in New Tab',
      'Delete HelloRequest',
      'Create Type...',
      'Create Nested Type...',
      'Create Method...',
      'Create Field...',
      'Create Property...',
      'Create Event...',
      'Edit Type...',
      'Load Dependencies',
      'Load Dependencies Recursively',
      'Go to Token...',
      'Copy MD Token',
      'Copy Full Name',
      'Open Hex Editor',
      'Add Class Breakpoint',
      'Analyze',
      'Search MSDN',
      'Sort Assemblies',
    ])

    // The entries are not only labels: this one runs, and on the node the click landed on.
    await menu.getByRole('menuitem', { name: /^Edit Type\.\.\./ }).click()
    const editType = page.getByRole('dialog', { name: 'Edit Type' })
    await expect(editType.getByLabel('Name', { exact: true })).toHaveValue('HelloRequest')
    await page.keyboard.press('Escape')
    await expect(editType).not.toBeVisible()

    // A module swaps the member commands for its own: the remove, the one create, the two "Go to ..."
    // navigations, the module's own token, and the three documents and folders it can open.
    await page.locator('.tree-row[data-kind="module"]').first().click({ button: 'right' })
    await expect(menu.locator('.document-tab-menu-label')).toHaveText([
      'Open in New Tab',
      'Remove dnSpy.Backend.Contracts.dll',
      'Convert Assembly to NetModule',
      'Create Type...',
      'Load Dependencies',
      'Load Dependencies Recursively',
      'Go to Entry Point',
      'Go to Global Cctor',
      'Go to Token...',
      'Copy MD Token',
      'Open Hex Editor',
      'Module Information',
      'Open Containing Folder',
      'Sort Assemblies',
    ])
    await page.keyboard.press('Escape')

    // A method adds the IL edits and the breakpoint, and its delete is named after it.
    await page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @02000076$/ }).locator('.tree-expander').click()
    const getCode = page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^get_Code\(\) : int @060008CC$/ })
    await getCode.click({ button: 'right' })
    await expect(menu.locator('.document-tab-menu-label').first()).toBeVisible()
    const methodLabels = await menu.locator('.document-tab-menu-label').allTextContents()
    expect(methodLabels).toEqual(expect.arrayContaining([
      'Delete get_Code()',
      'Create Nested Type...',
      'Create Method...',
      'Edit Method...',
      'Edit Method Body...',
      'Replace Method Body with stub...',
      'Copy Full Name',
      'Show Method Body in Hex Editor',
      'Add Method Breakpoint',
      'Analyze',
    ]))
    await page.keyboard.press('Escape')
  })

  test('breaks on every method of the type the class breakpoint was asked for', async () => {
    await openAssemblyAndNamespace()
    const menu = page.getByRole('menu', { name: 'Assembly Explorer' })

    // The type's methods are not in the tree until the row is expanded, and the command is expected to read
    // them itself — so the row is left exactly as the assembly opened it, collapsed.
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @02000076$/ })
    await rpcException.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Add Class Breakpoint' }).click()

    await showBreakpoints()
    const rows = page.locator('.breakpoint-row')
    // Every method of the type is broken on, named the way a function breakpoint names a method: the
    // declaring type in full, then the method. The constructor and the property's getter are both here.
    await expect(rows.filter({ hasText: 'dnSpy.Backend.Contracts.RpcException..ctor' })).toHaveCount(1)
    await expect(rows.filter({ hasText: 'dnSpy.Backend.Contracts.RpcException.get_Code' })).toHaveCount(1)

    // The output says what was added, and a second run adds nothing: the names are already there.
    const count = await rows.count()
    expect(count).toBeGreaterThan(1)
    await showOutput()
    const output = page.getByRole('tabpanel', { name: 'Output' })
    await expect(output).toContainText(/Added \d+ breakpoint\(s\) for RpcException\./)
    await rpcException.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Add Class Breakpoint' }).click()
    await expect(output).toContainText('RpcException has no method left to break on.')
    await expect(rows).toHaveCount(count)
  })

  test('runs the tree menu commands that reach the module file and the token box', async () => {
    await openAssemblyAndNamespace()
    const menu = page.getByRole('menu', { name: 'Assembly Explorer' })
    const moduleRow = page.locator('.tree-row[data-kind="module"]').first()

    // Open Containing Folder hands the module's own file to the shell, which is stubbed here to record it.
    await moduleRow.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: /^Open Containing Folder/ }).click()
    await expect.poll(() => existsSync(showInFolderPath) ? readFileSync(showInFolderPath, 'utf8') : '').toBe(contractsAssemblyPath)

    // Go to Token reads the row it was opened on as the module the token is looked up in, so the box is
    // opened from a type row and answers for that type's module.
    const helloType = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^HelloRequest @02000005$/ })
    await helloType.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: /^Go to Token\.\.\./ }).click()
    const tokenDialog = page.getByRole('dialog', { name: 'Go to Token' })
    // A token the module has no row for is not a token the tree can go to, and the box says so and stays up.
    await tokenDialog.getByLabel('Token').fill('0x0600FFFF')
    await tokenDialog.getByRole('button', { name: 'OK' }).click()
    await expect(tokenDialog.locator('.modal-error')).toBeVisible()
    // The token the method row is pinned with selects that row, opening the type above it on the way.
    await tokenDialog.getByLabel('Token').fill('0x060008CC')
    await tokenDialog.getByRole('button', { name: 'OK' }).click()
    await expect(tokenDialog).toBeHidden()
    await expect(page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^get_Code\(\) : int @060008CC$/ })).toHaveAttribute('aria-selected', 'true')

    // Remove Assembly takes the row and every row under it, and the tree is left with nothing on it.
    await moduleRow.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: /^Remove dnSpy\.Backend\.Contracts\.dll/ }).click()
    await expect(page.getByText('No assemblies loaded')).toBeVisible()
    await expect(page.locator('.tree-row')).toHaveCount(0)
  })

  test('converts the assembly to a net module and undoes it', async () => {
    await openAssemblyAndNamespace()
    const menu = page.getByRole('menu', { name: 'Assembly Explorer' })
    const root = page.locator('.tree-row[data-kind="assembly"]').first()
    await expect(root).toContainText('dnSpy.Backend.Contracts (1.0.0.0)')

    await page.locator('.tree-row[data-kind="module"]').first().click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Convert Assembly to NetModule', exact: true }).click()

    // The row above the module named the assembly; with the assembly detached there is nothing left for it
    // to name, so it falls back to the module's own file name.
    await expect(root).toContainText('dnSpy.Backend.Contracts.dll')
    await expect(root).not.toContainText('(1.0.0.0)')

    // It is a queued edit like any other, and undo is what puts the assembly back — which also leaves the
    // workspace unmodified, so the window closes without a prompt.
    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await page.getByRole('menuitem', { name: /^Undo/ }).click()
    await expect(root).toContainText('dnSpy.Backend.Contracts (1.0.0.0)')
  })

  test('writes a method body from the hex editor and undoes the bytes', async () => {
    await openAssemblyAndNamespace()
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @02000076$/ })
    await rpcException.locator('.tree-expander').click()
    const getCode = page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^get_Code\(\) : int @060008CC$/ })
    await getCode.click()

    // The hex group is listed in dnSpy's order, and only the entries that have something to point at are
    // in it: an int getter gets no 'return true'/'return false' body, whose commands belong to bool methods.
    await page.getByRole('menuitem', { name: 'Edit' }).click()
    // The shortcut rides along with the label in the item's own text, so it is trimmed off to compare order.
    const labels = (await page.getByRole('menu').last().getByRole('menuitem').allTextContents())
      .map((text) => text.replace(/(Ctrl|Shift|Alt)\+.*$/, '').trim())
    const start = labels.indexOf('Open Hex Editor')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(labels.slice(start, start + 6)).toEqual([
      'Open Hex Editor',
      'Show Instructions in Hex Editor',
      'Show Method Body in Hex Editor',
      'Hex Write Empty Body',
      'Hex Copy Method Body',
      'Hex Paste Method Body',
    ])

    await page.getByRole('menuitem', { name: 'Show Method Body in Hex Editor' }).click()

    // The command marks the bytes it names, so the getter's own body is read off the dump before anything
    // is written over it.
    const marked = page.locator('.hex-byte-marked')
    // The separator between bytes rides along with its own cell, and the last column of a row has none,
    // so the bytes are compared without it.
    const markedBytes = async (): Promise<string[]> => (await marked.allTextContents()).map((text) => text.trim())
    await expect(marked.first()).toBeVisible()
    const original = await markedBytes()

    // The write posts dnSpy's empty-body bytes: a tiny header whose two code bytes return the default. The
    // getter's real body is longer, so its remaining bytes stay where they are under the patch.
    await getCode.click()
    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await page.getByRole('menuitem', { name: 'Hex Write Empty Body' }).click()
    // The write narrates itself to the Output window, which the default layout no longer docks, so it is
    // brought up before the line is read — the pane keeps the backlog, so opening it after the write still
    // shows the message.
    await showOutput()
    await expect(page.getByText('Updated method body bytes for get_Code().')).toBeVisible()
    await expect(page.getByText('Modified', { exact: true })).toBeVisible()
    await expect.poll(async () => (await markedBytes()).slice(0, 3)).toEqual(['0A', '16', '2A'])

    // A byte patch is an edit like any other, so undo puts the file's own bytes back under it.
    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await page.getByRole('menuitem', { name: /^Undo/ }).click()
    await expect.poll(markedBytes).toEqual(original)
    await expect(page.getByText('Modified', { exact: true })).not.toBeVisible()
  })

  test('deletes a type, renames the namespace and restores both with undo', async () => {
    await openAssemblyAndNamespace()
    const namespaceRow = page.locator('.tree-row[data-kind="namespace"]').filter({ hasText: /^dnSpy\.Backend\.Contracts$/ })
    const helloType = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^HelloRequest @02000005$/ })
    await helloType.click()

    // The Edit menu names the node it would delete — the tree's label, the name the row shows.
    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await page.getByRole('menuitem', { name: /^Delete HelloRequest\b/ }).click()
    await expect(helloType).not.toBeVisible()

    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await page.getByRole('menuitem', { name: /^Undo/ }).click()
    await expect(helloType).toBeVisible()

    await namespaceRow.click()
    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await page.getByRole('menuitem', { name: 'Rename Namespace' }).click()
    const namespaceDialog = page.getByRole('dialog', { name: 'Edit Namespace' })
    await namespaceDialog.getByLabel('Name').fill('dnSpy.Backend.Renamed')
    await namespaceDialog.getByRole('button', { name: 'OK' }).click()
    await expect(page.locator('.tree-row[data-kind="namespace"]').filter({ hasText: /^dnSpy\.Backend\.Renamed$/ })).toBeVisible()

    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await page.getByRole('menuitem', { name: /^Undo/ }).click()
    await expect(namespaceRow).toBeVisible()

    // The stub body is built by the backend from the method's signature, so its only job here is to
    // land as an edit the user can undo.
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @02000076$/ })
    await rpcException.locator('.tree-expander').click()
    await page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^get_Code\(\) : int @060008CC$/ }).click()
    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await page.getByRole('menuitem', { name: 'Replace Method Body with stub...' }).click()
    await expect(page.getByText('Modified', { exact: true })).toBeVisible()

    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await page.getByRole('menuitem', { name: /^Undo/ }).click()
    await expect(page.getByText('Modified', { exact: true })).not.toBeVisible()
  })

  test('creates a type, saves it and finds it again after reopening the file', async () => {
    await openAssemblyAndNamespace()
    await page.locator('.tree-row[data-kind="namespace"]').filter({ hasText: /^dnSpy\.Backend\.Contracts$/ }).click()

    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await page.getByRole('menuitem', { name: 'Create Type...' }).click()
    const create = page.getByRole('dialog', { name: 'Create Type' })
    // The namespace comes from the node the command was run on; the name is the user's to type.
    await expect(create.getByLabel('Namespace')).toHaveValue('dnSpy.Backend.Contracts')
    // Exact: the flags beside the box carry `SpecialName` and `RTSpecialName`, which a loose label
    // lookup reads as a second and a third box called Name.
    await create.getByLabel('Name', { exact: true }).fill('E2ECreated')
    await create.getByRole('button', { name: 'OK' }).click()

    await expect(page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^E2ECreated @[0-9A-F]{8}$/ })).toBeVisible()
    await expect(page.getByText('Modified', { exact: true })).toBeVisible()

    await page.getByRole('toolbar', { name: 'Main toolbar' }).getByRole('button', { name: 'Save As' }).click()
    await expect(page.getByText('Modified', { exact: true })).not.toBeVisible()
    expect(existsSync(savePath)).toBe(true)

    // Opening again replaces the workspace with the file that was just written, so what is searched for
    // below is read off the disk rather than out of the session that made it. The picker is native and
    // cannot be driven from a test, so the hook the app opens assemblies through is pointed at the copy.
    await application.evaluate((_electron, saved) => { process.env.DNSPY_E2E_ASSEMBLY = saved }, savePath)
    await page.getByRole('button', { name: 'Open Assembly' }).first().click()
    await expect(page.getByRole('treeitem').first()).toContainText('dnSpy.Backend.Contracts')
    await page.getByRole('toolbar', { name: 'Main toolbar' }).getByRole('button', { name: 'Search' }).click()
    await page.getByRole('textbox', { name: 'Search assemblies' }).fill('E2ECreated')
    await page.getByRole('button', { name: 'Search', exact: true }).last().click()
    await expect(page.locator('.result-row').filter({ hasText: 'E2ECreated' }).first()).toBeVisible()
  })

  test('creates a method with a parameter and an attribute, then renames it with Alt+Enter', async () => {
    await openAssemblyAndNamespace()
    await page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @02000076$/ }).click()

    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await page.getByRole('menuitem', { name: 'Create Method...' }).click()
    const create = page.getByRole('dialog', { name: 'Create Method' })
    await create.getByLabel('Name', { exact: true }).fill('E2EMethod')

    // A parameter belongs to the signature, so it is added there: the type comes out of the picker and
    // the list takes the finished signature.
    await create.getByRole('tab', { name: 'Signature' }).click()
    const parameterTypes = create.locator('details.methodsig-section').filter({ hasText: 'Method Parameter Types' })
    await parameterTypes.getByRole('button', { name: 'Type' }).click()
    const typePicker = page.getByRole('dialog', { name: 'Pick a Type' })
    // The picker opens with the assembly root already expanded; its module and the namespace below it are
    // the user's call.
    await expandModule(typePicker)
    await typePicker.locator('.tree-row[data-kind="namespace"]').filter({ hasText: /^dnSpy\.Backend\.Contracts$/ }).locator('.tree-expander').click()
    await typePicker.locator('.tree-row[data-kind="type"]').filter({ hasText: /^WorkspaceRequest$/ }).click()
    await typePicker.getByRole('button', { name: 'OK' }).click()
    await parameterTypes.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(parameterTypes.getByRole('option')).toHaveText('dnSpy.Backend.Contracts.WorkspaceRequest')

    // The attribute goes through dnSpy's own dialog, which picks its constructor with the same picker.
    await create.getByRole('tab', { name: 'Custom Attrs' }).click()
    await create.getByRole('button', { name: 'Add...' }).click()
    const attribute = page.getByRole('dialog', { name: 'Edit Custom Attribute' })
    await attribute.getByRole('button', { name: 'Pick a Constructor' }).click()
    const constructorPicker = page.getByRole('dialog', { name: 'Pick a Constructor' })
    await expandModule(constructorPicker)
    await constructorPicker.locator('.tree-row[data-kind="namespace"]').filter({ hasText: /^dnSpy\.Backend\.Contracts$/ }).locator('.tree-expander').click()
    await constructorPicker.locator('.tree-row[data-kind="type"]').filter({ hasText: /^WorkspaceRequest$/ }).locator('.tree-expander').click()
    await constructorPicker.locator('.tree-row[data-kind="method"]').filter({ hasText: /^\.ctor\(/ }).first().click()
    await constructorPicker.getByRole('button', { name: 'OK' }).click()
    // The button that opens the picker carries 'Constructor' in its own label too, so the box is named
    // by its role rather than by the label alone.
    await expect(attribute.getByRole('textbox', { name: 'Constructor' })).toHaveValue(/^dnSpy\.Backend\.Contracts\.WorkspaceRequest\(System\.String\)$/)
    await attribute.getByRole('button', { name: 'OK' }).click()
    await expect(create.getByRole('option')).toHaveText(/WorkspaceRequest/)
    await create.getByRole('button', { name: 'OK' }).click()

    const created = page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^E2EMethod\(/ })
    await expect(created).toBeVisible()
    await expect(page.getByText('Modified', { exact: true })).toBeVisible()

    // Alt+Enter is the settings command, and the method it was run on is the one the dialog opens.
    await page.keyboard.press('Alt+Enter')
    const edit = page.getByRole('dialog', { name: 'Edit Method' })
    await expect(edit.getByLabel('Name', { exact: true })).toHaveValue('E2EMethod')
    await edit.getByLabel('Name', { exact: true }).fill('E2EMethodRenamed')
    await edit.getByRole('button', { name: 'OK' }).click()
    await expect(page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^E2EMethodRenamed\(/ })).toBeVisible()

    // Both edits are undone again, which is also what lets the app be closed: a workspace that is still
    // modified asks whether to discard it, and that question is a native window this test cannot answer.
    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await page.getByRole('menuitem', { name: /^Undo/ }).click()
    await expect(page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^E2EMethod\(/ })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await page.getByRole('menuitem', { name: /^Undo/ }).click()
    await expect(page.getByText('Modified', { exact: true })).not.toBeVisible()
  })

  test('closes only the topmost dialog when Escape is pressed', async () => {
    await openAssemblyAndNamespace()
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @02000076$/ })
    await rpcException.locator('.tree-expander').click()
    await page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^get_Code\(\) : int @060008CC$/ }).click()
    await page.keyboard.press('Alt+Enter')
    const method = page.getByRole('dialog', { name: 'Edit Method' })
    await expect(method).toBeVisible()

    // Three deep: the method's window, the attribute row's window, and the picker the row opens.
    await method.getByRole('tab', { name: 'Custom Attrs' }).click()
    await method.getByRole('button', { name: 'Add...' }).click()
    const attribute = page.getByRole('dialog', { name: 'Edit Custom Attribute' })
    await attribute.getByRole('button', { name: 'Pick a Constructor' }).click()
    const picker = page.getByRole('dialog', { name: 'Pick a Constructor' })
    await expect(picker).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(picker).not.toBeVisible()
    await expect(attribute).toBeVisible()
    await expect(method).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(attribute).not.toBeVisible()
    await expect(method).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(method).not.toBeVisible()
  })

  test('toggles a line breakpoint by clicking the editor gutter', async () => {
    await openAssemblyAndNamespace()
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @02000076$/ })
    await rpcException.dblclick()

    // The constructor body is the only place in this document a statement is printed: an auto-property such as
    // `public int Code { get; }` has no body to map, so `Code = code;` is where a click lands on a sequence point.
    // Monaco only renders the lines the viewport can hold, so the editor has to be tall enough to show the body.
    const browserWindow = await application.browserWindow(page)
    await browserWindow.evaluate((window) => window.setSize(1500, 700))

    const bodyLine = page.locator('.monaco-editor .view-lines .view-line').filter({ hasText: /Code\s*=\s*code/ }).first()
    await expect(bodyLine).toBeVisible()

    await showBreakpoints()
    const breakpointRows = page.locator('.breakpoint-row')
    const glyphs = page.locator('.breakpoint-glyph')
    const { lineBox, marginBox } = await editorLayout(bodyLine, page.locator('.monaco-editor .margin').first())
    const clickGutter = async (): Promise<void> => {
      await page.mouse.click(marginBox.x + 8, lineBox.y + lineBox.height / 2)
    }

    await clickGutter()
    await expect(breakpointRows).toContainText('dnSpy.Backend.Contracts.RpcException..ctor')
    await expect(glyphs).toHaveCount(1)

    // Clicking the marker again removes it, the same way the WPF editor toggles an existing breakpoint.
    await clickGutter()
    await expect(breakpointRows).toHaveCount(0)
    await expect(glyphs).toHaveCount(0)
  })

  test('bookmarks a statement from the gutter and clears it from the View menu', async () => {
    await openAssemblyAndNamespace()
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @02000076$/ })
    await rpcException.dblclick()

    const browserWindow = await application.browserWindow(page)
    await browserWindow.evaluate((window) => window.setSize(1500, 700))

    const bodyLine = page.locator('.monaco-editor .view-lines .view-line').filter({ hasText: /Code\s*=\s*code/ }).first()
    await expect(bodyLine).toBeVisible()

    await showBookmarksWindow()
    const rows = page.locator('.bookmark-row')
    const glyphs = page.locator('.bookmark-glyph')
    await expect(rows).toHaveCount(0)

    const { lineBox, marginBox } = await editorLayout(bodyLine, page.locator('.monaco-editor .margin').first())
    // The bookmark strip is the right-hand part of the margin — the breakpoint glyphs are on the left.
    await page.mouse.click(marginBox.x + marginBox.width - 7, lineBox.y + lineBox.height / 2)

    await expect(glyphs).toHaveCount(1)
    await expect(rows).toHaveCount(1)
    // The row names the method the statement sits in, the IL offset it was saved as, and its module.
    await expect(rows.first()).toContainText('dnSpy.Backend.Contracts.RpcException::.ctor')
    await expect(rows.first()).toContainText(/IL_[0-9A-F]{4}/)
    await expect(rows.first()).toContainText('dnSpy.Backend.Contracts.dll')
    // Making one selects it, and the go-to continues from there.
    await expect(rows.first()).toHaveClass(/active/)

    // The same commands the editor offers, reached through the window's View menu. The submenu opens on
    // hover, the way it does for a pointer; clicking the parent instead would close it again.
    await page.getByRole('menuitem', { name: 'View' }).click()
    await page.getByRole('menuitem', { name: 'Bookmarks', exact: true }).hover()
    await expect(page.getByRole('menuitem', { name: /^Previous Bookmark Ctrl\+K/ })).toBeEnabled()
    await page.getByRole('menuitem', { name: /^Clear Bookmarks Ctrl/ }).click()

    await expect(rows).toHaveCount(0)
    await expect(glyphs).toHaveCount(0)
  })

  test('keeps a bookmark across a reload', async () => {
    await openAssemblyAndNamespace()
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @02000076$/ })
    await rpcException.dblclick()

    const browserWindow = await application.browserWindow(page)
    await browserWindow.evaluate((window) => window.setSize(1500, 700))

    const bodyLine = page.locator('.monaco-editor .view-lines .view-line').filter({ hasText: /Code\s*=\s*code/ }).first()
    await expect(bodyLine).toBeVisible()
    const { lineBox, marginBox } = await editorLayout(bodyLine, page.locator('.monaco-editor .margin').first())
    await page.mouse.click(marginBox.x + marginBox.width - 7, lineBox.y + lineBox.height / 2)

    await showBookmarksWindow()
    const rows = page.locator('.bookmark-row')
    await expect(rows).toHaveCount(1)
    const saved = await rows.first().textContent()

    // A bookmark is written down as module plus IL offset, never as the node ids this session handed
    // out, so the restart reads it back with its name, its location and its module intact.
    await page.reload()
    await expect(page.getByText('Ready', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Open Assembly' }).first().click()
    await expect(page.getByRole('treeitem').first()).toContainText('dnSpy.Backend.Contracts')

    await showBookmarksWindow()
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toHaveText(saved)
  })

  test('exports the bookmarks to a file and reads them back', async () => {
    await openAssemblyAndNamespace()
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @02000076$/ })
    await rpcException.dblclick()

    const browserWindow = await application.browserWindow(page)
    await browserWindow.evaluate((window) => window.setSize(1500, 700))

    const bodyLine = page.locator('.monaco-editor .view-lines .view-line').filter({ hasText: /Code\s*=\s*code/ }).first()
    await expect(bodyLine).toBeVisible()
    const { lineBox, marginBox } = await editorLayout(bodyLine, page.locator('.monaco-editor .margin').first())
    await page.mouse.click(marginBox.x + marginBox.width - 7, lineBox.y + lineBox.height / 2)

    await showBookmarksWindow()
    const rows = page.locator('.bookmark-row')
    const status = page.locator('.bookmarks-status')
    await expect(rows).toHaveCount(1)

    await page.getByRole('button', { name: 'Export Bookmarks' }).click()
    await expect(status).toContainText('Exported 1 bookmark(s) to')
    const exported = readFileSync(saveCodePath, 'utf8')
    // The file is the portable shape: module, token and IL offset, with nothing session-local in it.
    const entries = JSON.parse(exported).bookmarks as Record<string, unknown>[]
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ modulePath: contractsAssemblyPath, metadataToken: expect.any(Number), ilOffset: expect.any(Number), labels: [], enabled: true })

    await page.getByRole('button', { name: 'Clear Bookmarks' }).click()
    await expect(rows).toHaveCount(0)

    writeFileSync(importBookmarksPath, exported)
    await page.getByRole('button', { name: 'Import Bookmarks' }).click()

    await expect(rows).toHaveCount(1)
    await expect(status).toContainText('Imported 1 bookmark(s).')
    await expect(rows.first()).toContainText('IL_')
  })

  test('toggles a bookmark with the Ctrl+K chord while the editor has focus', async () => {
    await openAssemblyAndNamespace()
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @02000076$/ })
    await rpcException.dblclick()

    const browserWindow = await application.browserWindow(page)
    await browserWindow.evaluate((window) => window.setSize(1500, 700))

    const bodyLine = page.locator('.monaco-editor .view-lines .view-line').filter({ hasText: /Code\s*=\s*code/ }).first()
    await expect(bodyLine).toBeVisible()
    // Clicking the code puts the caret on the line the chord will bookmark.
    await bodyLine.click()

    await page.keyboard.press('Control+k')
    await page.keyboard.press('Control+k')

    await showBookmarksWindow()
    await expect(page.locator('.bookmark-row')).toHaveCount(1)

    // A second chord on the same statement takes it away again, as the second click in the gutter does.
    await bodyLine.click()
    await page.keyboard.press('Control+k')
    await page.keyboard.press('Control+k')
    await expect(page.locator('.bookmark-row')).toHaveCount(0)
  })

  test('toggles a breakpoint for the current method from the Debug menu', async () => {
    await page.getByRole('button', { name: 'Open Assembly' }).first().click()
    await expect(page.getByRole('treeitem').first()).toContainText('dnSpy.Backend.Contracts')

    await showBreakpoints()
    await expandModule()
    const namespaceRow = page.locator('.tree-row[data-kind="namespace"]').filter({ hasText: /^dnSpy\.Backend\.Contracts$/ })
    await namespaceRow.locator('.tree-expander').click()
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @02000076$/ })
    await rpcException.locator('.tree-expander').click()
    // The tree row keeps focus, so the F9 handler is not suppressed by the editor guard.
    await page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^get_Code\(\) : int @060008CC$/ }).click()

    const breakpointRows = page.locator('.breakpoint-row')
    await page.keyboard.press('F9')
    await expect(breakpointRows).toContainText('dnSpy.Backend.Contracts.RpcException.get_Code')

    // A second press removes it again, like the upstream Toggle Breakpoint command.
    await page.keyboard.press('F9')
    await expect(breakpointRows).toHaveCount(0)
  })

  test('runs submissions in the C# Interactive window', async () => {
    await page.getByRole('menuitem', { name: 'View' }).click()
    await page.getByRole('menuitem', { name: /^C# Interactive/ }).click()

    // Opening the window builds the session, which prints the engine banner; the first submission
    // then has to compile, so the waits below are wider than the default.
    const log = page.locator('.script-log')
    await expect(log).toContainText('Roslyn C# Compiler version', { timeout: 60_000 })
    await expect(log).toContainText('Type "#help" for more information.')

    const pane = page.locator('.script-pane')
    const input = page.locator('.script-input .monaco-editor')
    // The input box is locked while a submission runs, so every submission below waits for the
    // previous one to finish before typing — the same thing a user does in front of the window.
    const submit = async (code: string): Promise<void> => {
      await expect(pane).toHaveAttribute('data-running', 'false', { timeout: 60_000 })
      await input.click()
      await page.keyboard.type(code)
      await page.keyboard.press('Enter')
    }

    await submit('1 + 1')
    await expect(log).toContainText('> 1 + 1')
    await expect(log.locator('.script-result').last()).toHaveText('2', { timeout: 60_000 })

    // The host's stdout is the JSON-RPC channel, so this is also the check that a script writing to
    // the console is captured rather than corrupting the protocol — the submission after it still
    // works, which is what a broken frame would prevent.
    await submit('Console.WriteLine("hello from the console");')
    await expect(log).toContainText('hello from the console')

    // The session outlives a submission, so a variable declared in one is visible to the next.
    await submit('var x = 41;')
    await expect(log).toContainText('> var x = 41;')
    await submit('x + 1')
    await expect(log.locator('.script-result').last()).toHaveText('42', { timeout: 60_000 })

    // #reset drops the session, and the old variable goes with it.
    await submit('#reset')
    await expect(log).toContainText('Resetting execution engine.')
    await submit('x + 1')
    await expect(log.locator('.script-error').last()).toContainText('CS0103', { timeout: 60_000 })

    // #help is answered by the window itself, like the upstream REPL command.
    await submit('#help')
    await expect(log).toContainText('Script directives:')
    await expect(log).toContainText('#load "myscript.csx"')

    await page.getByRole('button', { name: 'Clear the script editor' }).click()
    await expect(log).toBeEmpty()
  })
})

/** Opens the debuggee and unfolds it down to its namespace, which is where its own documents hang off. */
const openDebugTarget = async (): Promise<void> => {
  await page.getByRole('button', { name: 'Open Assembly' }).first().click()
  await expect(page.getByRole('treeitem').first()).toContainText('DebugTarget')
  await expandModule()
  const namespaceRow = page.locator('.tree-row[data-kind="namespace"]').filter({ hasText: /^DebugTarget$/ })
  await expect(namespaceRow).toBeVisible()
  await namespaceRow.locator('.tree-expander').click()
}

// Line breakpoints need the debuggee inside the workspace, and so do function breakpoints: the engine resolves
// both through the workspace's decompiled statement map rather than through PDBs on disk.
test.describe('the in-process debug engine', () => {
  test.beforeEach(async () => { await launchApp(debugTargetPath) })
  test.afterEach(async () => { await closeApp() })

  // Upstream's Start button opens the Debug Program dialog rather than a bare file picker, and the executable
  // is prefilled from the module the workspace already has open — so confirming the dialog is all a test needs.
  // "Break at" defaults to Don't Break, which is why there is no Continue step below: the launch runs straight
  // to the breakpoint instead of stopping on the entry point first.
  const startDebugging = async (): Promise<void> => {
    await page.getByRole('toolbar', { name: 'Main toolbar' }).getByRole('button', { name: 'Debug a Program' }).click()
    await page.getByRole('dialog', { name: 'Debug Program' }).getByRole('button', { name: 'OK' }).click()
  }

  test('sets a line breakpoint from the gutter, stops on it and shows the frame locals', async () => {
    await openDebugTarget()
    const programRow = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^Program @02000002$/ })
    await programRow.locator('.tree-expander').click()
    await page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^Calculate\(/ }).dblclick()

    const editor = page.locator('.monaco-editor')
    // Monaco only renders the lines its viewport can hold, so the window has to be tall enough for the body.
    const browserWindow = await application.browserWindow(page)
    await browserWindow.evaluate((window) => window.setSize(1500, 700))

    // The statement the breakpoint goes on. `return sum;` is where the accumulator holds the value the Locals
    // assertion below reads; the decompiler calls the local `num`, the frame's slots keep the source name.
    const returnLine = editor.locator('.view-lines .view-line').filter({ hasText: /return\s+\w+\s*;/ }).first()
    await expect(returnLine).toBeVisible()

    await showBreakpoints()
    const glyphs = page.locator('.breakpoint-glyph')
    const { lineBox, marginBox } = await editorLayout(returnLine, editor.locator('.margin').first())
    // A click in the margin left of the line numbers toggles a breakpoint on that line.
    await page.mouse.click(marginBox.x + 8, lineBox.y + lineBox.height / 2)

    await expect(page.locator('.breakpoint-row')).toContainText('DebugTarget.Program.Calculate:')
    await expect(glyphs).toHaveCount(1)
    // The marker is echoed on the line the click mapped to, which for a click on a statement is its own line.
    const glyphBox = await glyphs.first().boundingBox()
    if (!glyphBox)
      throw new Error('The breakpoint glyph was not laid out.')
    expect(glyphBox.y).toBeGreaterThanOrEqual(lineBox.y)
    expect(glyphBox.y).toBeLessThan(lineBox.y + lineBox.height)

    const toolbar = page.getByRole('toolbar', { name: 'Main toolbar' })
    await startDebugging()
    // The launch asks not to break at the entry point, so the very first stop is the breakpoint's.
    await expect(page.getByText('Stopped: breakpoint', { exact: true })).toBeVisible()
    // The debuggee's module only loads when the process starts, so the breakpoint was pending until then.
    await expect(page.locator('.breakpoint-state-bound')).toHaveCount(1)

    // The frame's arguments and locals, named through the module's portable PDB and matched to ICorDebug slots by
    // index: the accumulator is 2 * 21 by the time the return statement is reached.
    await page.getByRole('tab', { name: 'Locals' }).click()
    await expect(page.locator('.debug-variable-name')).toContainText(['left', 'right', 'sum', 'i'])
    await expect(page.locator('.debug-table-row').filter({ hasText: 'sum' })).toContainText('42')

    // The stopped line is marked in the editor, on the document the frame decompiled to.
    await expect(page.locator('.debug-stopped-glyph')).toHaveCount(1)

    await toolbar.getByRole('button', { name: 'Stop' }).click()
    await expect(toolbar.getByRole('button', { name: 'Debug a Program' })).toBeEnabled()
  })

  test('breaks at the entry point when the dialog asks for it', async () => {
    await openDebugTarget()

    await page.getByRole('toolbar', { name: 'Main toolbar' }).getByRole('button', { name: 'Debug a Program' }).click()
    const dialog = page.getByRole('dialog', { name: 'Debug Program' })
    // The other half of the dialog's "Break at": upstream's start parameters can stop before Main runs.
    await dialog.getByLabel('Break at').selectOption('entry-point')
    await dialog.getByRole('button', { name: 'OK' }).click()

    await expect(page.locator('.status-bar')).toContainText('Stopped: entry')
    await page.getByRole('tab', { name: 'Call Stack' }).click()
    await expect(page.locator('.result-list[aria-label="Call Stack"] .stack-row').first()).toContainText('DebugTarget.dll!DebugTarget.Program.Main(string[] args)')

    // The entry stop is an ordinary stop: continuing runs the program to its end.
    const toolbar = page.getByRole('toolbar', { name: 'Main toolbar' })
    await toolbar.getByRole('button', { name: 'Continue' }).click()
    await expect(toolbar.getByRole('button', { name: 'Debug a Program' })).toBeEnabled()
  })

  test('stops on a function breakpoint for a method of the debuggee', async () => {
    await openDebugTarget()
    await showBreakpoints()
    await page.getByRole('textbox', { name: 'Function breakpoint', exact: true }).fill('DebugTarget.Program.Calculate')
    await page.getByRole('button', { name: 'Add function breakpoint' }).click()

    const toolbar = page.getByRole('toolbar', { name: 'Main toolbar' })
    await startDebugging()
    await expect(page.getByText('Stopped: breakpoint', { exact: true })).toBeVisible()

    await toolbar.getByRole('button', { name: 'Stop' }).click()
    await expect(toolbar.getByRole('button', { name: 'Debug a Program' })).toBeEnabled()
  })

  // The exception list is the engine's data rather than the client's — it outlives every session — and the
  // window is one of the tool windows the default layout does not dock, so this is also the check that
  // opening it shows a real list instead of an empty pane.
  test('lists the engine exception types and stops on a thrown one that is set to break when thrown', async () => {
    await openDebugTarget()
    await showExceptionSettings()

    // The rows come from the engine's definition files, with the category default row first.
    await expect(page.locator('.exception-row').first()).toContainText('<All Common Language Runtime Exceptions not in this list>')
    // Hundreds of types are listed, so the search narrows the list to the one the fixture throws.
    await page.getByRole('textbox', { name: 'Search for an exception' }).fill('System.InvalidOperationException')
    const row = page.locator('.exception-row').filter({ hasText: 'System.InvalidOperationException' })
    await expect(row).toHaveCount(1)

    // Break When Thrown is off for it by default, and the fixture catches the exception it throws: without
    // this toggle the launch below would run to the end instead of stopping on the throw. The click only
    // reaches the checkbox; the row reads back from the list the engine answered with, so waiting for it to
    // come back checked is waiting for the round trip.
    await row.getByRole('checkbox').click()
    await expect(row.getByRole('checkbox')).toBeChecked()

    const toolbar = page.getByRole('toolbar', { name: 'Main toolbar' })
    await toolbar.getByRole('button', { name: 'Debug a Program' }).click()
    const dialog = page.getByRole('dialog', { name: 'Debug Program' })
    await dialog.getByLabel('Arguments', { exact: true }).fill('--catch')
    await dialog.getByRole('button', { name: 'OK' }).click()

    // The stop is the exception's own: the reason names it, and the frame is the method that threw.
    await expect(page.locator('.status-bar')).toContainText('Stopped: exception')
    await page.getByRole('tab', { name: 'Call Stack' }).click()
    await expect(page.locator('.result-list[aria-label="Call Stack"] .stack-row').first()).toContainText('DebugTarget.dll!DebugTarget.Program.ThrowAndCatch()')
    // The exception itself is reported by name, so the window says what the program stopped on.
    await showOutput()
    await expect(page.getByRole('tabpanel', { name: 'Output' })).toContainText('Exception thrown: System.InvalidOperationException')

    // Continuing lets the fixture's catch swallow it, and the program runs to its end.
    await toolbar.getByRole('button', { name: 'Continue' }).click()
    await expect(toolbar.getByRole('button', { name: 'Debug a Program' })).toBeEnabled()
  })

  test('steps the loop one pass at a time and leaves the method for its caller', async () => {
    await openDebugTarget()
    const programRow = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^Program @02000002$/ })
    await programRow.locator('.tree-expander').click()
    await page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^Calculate\(/ }).dblclick()

    const editor = page.locator('.monaco-editor')
    const browserWindow = await application.browserWindow(page)
    await browserWindow.evaluate((window) => window.setSize(1500, 700))

    // The statement inside the loop: a breakpoint on it stops on every pass, so what a step does to the
    // pass counter and the accumulator is visible in the Locals pane.
    const bodyLine = editor.locator('.view-lines .view-line').filter({ hasText: /\+=\s*\w+\s*;/ }).first()
    await expect(bodyLine).toBeVisible()
    await showBreakpoints()
    const { lineBox, marginBox } = await editorLayout(bodyLine, editor.locator('.margin').first())
    await page.mouse.click(marginBox.x + 8, lineBox.y + lineBox.height / 2)
    await expect(page.locator('.breakpoint-row')).toContainText('DebugTarget.Program.Calculate:')

    const toolbar = page.getByRole('toolbar', { name: 'Main toolbar' })
    await startDebugging()
    await expect(page.getByText('Stopped: breakpoint', { exact: true })).toBeVisible()

    // The frame stopped on the loop body, with the accumulator still 0 for this pass. The line the frame
    // reports is the decompiled document's, the same one the editor is showing.
    await page.getByRole('tab', { name: 'Call Stack' }).click()
    const frameRow = page.locator('.result-list[aria-label="Call Stack"] .stack-row').first()
    await expect(frameRow).toContainText('DebugTarget.dll!DebugTarget.Program.Calculate(int left, int right)')
    // The row has no location column — WPF's grid has none — so the line it reports is the tooltip's.
    await expect(frameRow).toHaveAttribute('title', 'DebugTarget.dll:9')
    await page.getByRole('tab', { name: 'Locals' }).click()
    const sumRow = page.locator('.debug-table-row').filter({ hasText: 'sum' })
    await expect(sumRow).toContainText('0')

    // A step over the body runs the add and stops on the loop header — where the next pass is decided —
    // and the accumulator has grown by the left operand.
    await toolbar.getByRole('button', { name: 'Step Over' }).click()
    await expect(page.getByText('Stopped: step', { exact: true })).toBeVisible()
    await expect(frameRow).toHaveAttribute('title', 'DebugTarget.dll:7')
    await expect(sumRow).toContainText('2')

    // The step after that is the body again: a loop runs its statements more than once, so a step that
    // only ever moved forwards would have left it.
    await toolbar.getByRole('button', { name: 'Step Over' }).click()
    await expect(frameRow).toHaveAttribute('title', 'DebugTarget.dll:9')
    await expect(sumRow).toContainText('2')

    // Stepping out of the body leaves the method rather than running the loop to its end: the stop is
    // reported in the caller, which is the frame the runtime steps back to.
    await page.getByRole('tab', { name: 'Call Stack' }).click()
    await page.getByRole('menuitem', { name: 'Debug' }).click()
    await page.getByRole('menuitem', { name: 'Step Out' }).click()
    await expect(page.getByText('Stopped: step', { exact: true })).toBeVisible()
    await expect(frameRow).toContainText('DebugTarget.dll!DebugTarget.Program.Main(string[] args)')

    // The step out lands after the call, so what follows it is the framework's own call — which has no
    // decompilable source to walk into. A step into degrades to a step over there and stops on the
    // caller's next statement; the editor's marker stays on a statement of the debuggee.
    await page.keyboard.press('F11')
    await expect(page.getByText('Stopped: step', { exact: true })).toBeVisible()
    await expect(frameRow).toContainText('DebugTarget.dll!DebugTarget.Program.Main(string[] args)')
    await expect(frameRow).toHaveAttribute('title', 'DebugTarget.dll:18')

    await toolbar.getByRole('button', { name: 'Stop' }).click()
    await expect(toolbar.getByRole('button', { name: 'Debug a Program' })).toBeEnabled()
  })

  // Upstream shows the Locals window once, when a debugging session starts: `AutoShowLocalsWindow` hangs off
  // `DbgManager_IsDebuggingChanged`, so a break or a step inside the session leaves the dock's tabs where the
  // user put them. Switching to Call Stack before the launch is what makes the difference visible — the start
  // may move the tab, the step that follows it must not.
  test('opens the Locals window when the session starts and leaves the tool tabs alone when stepping', async () => {
    await openDebugTarget()
    const programRow = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^Program @02000002$/ })
    await programRow.locator('.tree-expander').click()
    await page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^Calculate\(/ }).dblclick()

    const editor = page.locator('.monaco-editor')
    const browserWindow = await application.browserWindow(page)
    await browserWindow.evaluate((window) => window.setSize(1500, 700))

    // A breakpoint on the loop body stops on the first pass, which is a stop to step over from.
    const bodyLine = editor.locator('.view-lines .view-line').filter({ hasText: /\+=\s*\w+\s*;/ }).first()
    await expect(bodyLine).toBeVisible()
    await showBreakpoints()
    const { lineBox, marginBox } = await editorLayout(bodyLine, editor.locator('.margin').first())
    await page.mouse.click(marginBox.x + 8, lineBox.y + lineBox.height / 2)
    await expect(page.locator('.breakpoint-row')).toContainText('DebugTarget.Program.Calculate:')

    // The user is already on Call Stack when the debugger starts, so Locals coming to the front is the
    // session-start behaviour this test can see, not just the default layout.
    await page.getByRole('tab', { name: 'Call Stack' }).click()
    await expect(page.getByRole('tab', { name: 'Call Stack' })).toHaveAttribute('aria-selected', 'true')

    const toolbar = page.getByRole('toolbar', { name: 'Main toolbar' })
    await startDebugging()
    await expect(page.getByText('Stopped: breakpoint', { exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Locals' })).toHaveAttribute('aria-selected', 'true')

    // Stepping is the same session, so the dock stays on the window the user chose.
    await page.getByRole('tab', { name: 'Call Stack' }).click()
    await toolbar.getByRole('button', { name: 'Step Over' }).click()
    await expect(page.getByText('Stopped: step', { exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Call Stack' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tab', { name: 'Locals' })).toHaveAttribute('aria-selected', 'false')

    await toolbar.getByRole('button', { name: 'Stop' }).click()
    await expect(toolbar.getByRole('button', { name: 'Debug a Program' })).toBeEnabled()
  })

  // A step into stops before the call runs, so the frame has to be standing on the call statement itself:
  // stepping out of a method lands *after* its call, where there is nothing left to enter.
  test('steps into a call of the debuggee and lands on the callee', async () => {
    await openDebugTarget()
    const programRow = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^Program @02000002$/ })
    await programRow.locator('.tree-expander').click()
    await page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^Main\(/ }).dblclick()

    const editor = page.locator('.monaco-editor')
    const browserWindow = await application.browserWindow(page)
    await browserWindow.evaluate((window) => window.setSize(1500, 700))

    const callLine = editor.locator('.view-lines .view-line').filter({ hasText: /Calculate\(/ }).first()
    // Monaco renders only the lines its viewport holds, and the call sits after the argument-handling
    // branch, so the editor has to be scrolled to it before it exists to be clicked.
    await editor.locator('.view-lines').hover()
    await page.mouse.wheel(0, 400)
    await expect(callLine).toBeVisible()
    await showBreakpoints()
    const { lineBox, marginBox } = await editorLayout(callLine, editor.locator('.margin').first())
    await page.mouse.click(marginBox.x + 8, lineBox.y + lineBox.height / 2)
    await expect(page.locator('.breakpoint-row')).toContainText('DebugTarget.Program.Main:')

    const toolbar = page.getByRole('toolbar', { name: 'Main toolbar' })
    await startDebugging()
    await expect(page.getByText('Stopped: breakpoint', { exact: true })).toBeVisible()

    // The stop is on the call itself: the arguments are read but the callee has not run.
    await page.getByRole('tab', { name: 'Call Stack' }).click()
    const frameRow = page.locator('.result-list[aria-label="Call Stack"] .stack-row').first()
    await expect(frameRow).toContainText('DebugTarget.dll!DebugTarget.Program.Main(string[] args)')

    // The step arms the callee's statements, so the runtime stops on the method's first one rather than
    // walking through code the client has nothing to show for.
    await page.keyboard.press('F11')
    await expect(page.getByText('Stopped: step', { exact: true })).toBeVisible()
    await expect(frameRow).toContainText('DebugTarget.dll!DebugTarget.Program.Calculate(int left, int right)')

    await toolbar.getByRole('button', { name: 'Stop' }).click()
    await expect(toolbar.getByRole('button', { name: 'Debug a Program' })).toBeEnabled()
  })

  test('steps across an await without landing in the state machine', async () => {
    await openDebugTarget()
    const programRow = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^Program @02000002$/ })
    await programRow.locator('.tree-expander').click()
    await page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^AddAsync\(/ }).dblclick()

    const editor = page.locator('.monaco-editor')
    const browserWindow = await application.browserWindow(page)
    await browserWindow.evaluate((window) => window.setSize(1500, 700))

    const sumLine = editor.locator('.view-lines .view-line').filter({ hasText: /=\s*\w+\s*\+\s*\w+\s*;/ }).first()
    await expect(sumLine).toBeVisible()
    await showBreakpoints()
    const { lineBox, marginBox } = await editorLayout(sumLine, editor.locator('.margin').first())
    await page.mouse.click(marginBox.x + 8, lineBox.y + lineBox.height / 2)
    // The statement's own code starts inside the sequence point that covers it — the machine's field store
    // is charged to it — so where the engine can arm the breakpoint is not where the line begins. The row
    // still names the line that was clicked.
    await expect(page.locator('.breakpoint-row')).toContainText('DebugTarget.Program.AddAsync:7')

    const toolbar = page.getByRole('toolbar', { name: 'Main toolbar' })
    await startDebugging()
    // The breakpoint is on the statement inside the state machine, so the stop is on its line.
    await expect(page.getByText('Stopped: breakpoint', { exact: true })).toBeVisible()

    await page.getByRole('tab', { name: 'Call Stack' }).click()
    const frameRow = page.locator('.result-list[aria-label="Call Stack"] .stack-row').first()
    await expect(frameRow).toContainText('DebugTarget.dll!DebugTarget.Program.AddAsync(int left, int right)')
    await expect(frameRow).toHaveAttribute('title', 'DebugTarget.dll:7')

    // The step over crosses the suspension and stops on the await's own line, in the method the user
    // wrote: the frame is a generated MoveNext, so walking its own instructions would stop somewhere in
    // the plumbing between the two statements instead.
    await toolbar.getByRole('button', { name: 'Step Over' }).click()
    await expect(page.getByText('Stopped: step', { exact: true })).toBeVisible()
    await expect(frameRow).toContainText('DebugTarget.dll!DebugTarget.Program.AddAsync(int left, int right)')
    await expect(frameRow).toHaveAttribute('title', 'DebugTarget.dll:8')

    await toolbar.getByRole('button', { name: 'Stop' }).click()
    await expect(toolbar.getByRole('button', { name: 'Debug a Program' })).toBeEnabled()
  })

  // The Call Stack navigates the way the original's does: Ctrl+F10-style switching is a double click,
  // and a single click is only the highlight the user is about to double click.
  test('switches to a frame on a double click and leaves the single click a highlight', async () => {
    await openDebugTarget()
    const programRow = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^Program @02000002$/ })
    await programRow.locator('.tree-expander').click()
    await page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^Calculate\(/ }).dblclick()

    const editor = page.locator('.monaco-editor')
    const browserWindow = await application.browserWindow(page)
    await browserWindow.evaluate((window) => window.setSize(1500, 700))

    // A breakpoint on the loop body stops inside Calculate, whose caller is the frame the navigation
    // has to walk up to.
    const bodyLine = editor.locator('.view-lines .view-line').filter({ hasText: /\+=\s*\w+\s*;/ }).first()
    await expect(bodyLine).toBeVisible()
    await showBreakpoints()
    const { lineBox, marginBox } = await editorLayout(bodyLine, editor.locator('.margin').first())
    await page.mouse.click(marginBox.x + 8, lineBox.y + lineBox.height / 2)

    const toolbar = page.getByRole('toolbar', { name: 'Main toolbar' })
    await startDebugging()
    await expect(page.getByText('Stopped: breakpoint', { exact: true })).toBeVisible()

    await page.getByRole('tab', { name: 'Call Stack' }).click()
    const rows = page.locator('.result-list[aria-label="Call Stack"] .stack-row')
    const frame = rows.first()
    const caller = rows.nth(1)
    await expect(frame).toContainText('DebugTarget.dll!DebugTarget.Program.Calculate(int left, int right)')
    await expect(caller).toContainText('DebugTarget.dll!DebugTarget.Program.Main(string[] args)')
    // Only the frame the debugger is in wears the marker, which is where WPF's arrow sits too.
    await expect(frame).toHaveAttribute('aria-current', 'true')
    await expect(caller).not.toHaveAttribute('aria-current', 'true')

    // A single click is a highlight: the debugger stays in Calculate, so the row that reads the frame's
    // locals does not change and no document comes forward.
    await caller.click()
    await expect(caller).toHaveClass(/selected/)
    await expect(frame).toHaveAttribute('aria-current', 'true')
    await page.getByRole('tab', { name: 'Locals' }).click()
    await expect(page.locator('.debug-table-row').filter({ hasText: 'sum' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Main(string[]) : void' })).toHaveCount(0)

    // The double click is the switch: the caller becomes the active frame — its own locals are what
    // Locals shows now — and its document is opened, selected, and scrolled to the statement it is
    // stopped at, which is the call the debugger has to return from.
    await page.getByRole('tab', { name: 'Call Stack' }).click()
    await caller.dblclick()
    await expect(caller).toHaveAttribute('aria-current', 'true')
    await expect(frame).not.toHaveAttribute('aria-current', 'true')
    await expect(page.getByRole('tab', { name: 'Main(string[]) : void' })).toHaveAttribute('aria-selected', 'true')
    // A whole-line decoration lands in Monaco's overlay layer (a `cdr` div over the line), not on the
    // `.view-line` element itself, and only for the lines the viewport holds — so the reveal, which is
    // what scrolls the stopped line into view, is what makes it render at all.
    const stoppedLine = page.locator('.view-overlays .cdr.debug-stopped-line')
    await expect(stoppedLine).toHaveCount(1)
    await page.getByRole('tab', { name: 'Locals' }).click()
    await expect(page.locator('.debug-table-row').filter({ hasText: 'args' })).toBeVisible()

    await toolbar.getByRole('button', { name: 'Stop' }).click()
    await expect(toolbar.getByRole('button', { name: 'Debug a Program' })).toBeEnabled()
  })
})

// The code viewer's context menu stands in for Monaco's own, so its entries are read back the same way the
// menus are: by role and label. The document is the debuggee's, whose decompiled lines carry both statement
// maps and spans — which is what most of the entries need to have anything to act on.
test.describe('the code viewer context menu', () => {
  test.beforeEach(async () => { await launchApp(debugTargetPath) })
  test.afterEach(async () => { await closeApp() })

  const openMain = async (): Promise<void> => {
    await openDebugTarget()
    const programRow = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^Program @02000002$/ })
    await programRow.locator('.tree-expander').click()
    await page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^Main\(/ }).dblclick()
    // Monaco only renders the lines its viewport can hold, so the window has to be tall enough for the body.
    const browserWindow = await application.browserWindow(page)
    await browserWindow.evaluate((window) => window.setSize(1500, 700))
  }

  /** Right-clicks the call to `ThrowAndCatch`, which is where the menu is at its fullest: the caret is on
   * a reference to a method of the workspace, so every group that names a member has one to name. It is
   * Main's last statement, which is what keeps it inside the viewport once the document is scrolled. */
  const rightClickThrowAndCatch = async (): Promise<Locator> => {
    // Main's body is taller than the editor's viewport, and Monaco renders only the lines it can hold, so
    // the document is scrolled to its end before the call is looked for. A hidden tab keeps its editor
    // mounted, so the click is aimed at the document that is showing rather than whichever comes first.
    const editor = page.locator('.monaco-editor').filter({ visible: true })
    await editor.click()
    await page.keyboard.press('Control+End')
    const call = editor.locator('.view-lines').getByText('ThrowAndCatch', { exact: true }).first()
    await expect(call).toBeVisible()
    await call.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Code editor' })
    await expect(menu).toBeVisible()
    return menu
  }

  /** The entry labels in the order the menu laid them out. A row's text carries its shortcut too, which is
   * trimmed off here so the labels can be compared — the same way the Edit menu test reads them. */
  const menuLabels = async (menu: Locator): Promise<string[]> =>
    (await menu.getByRole('menuitem').allTextContents()).map((text) => text.replace(/(Ctrl|Shift|Alt)\+.*$/, '').trim())

  test('lays the document viewer commands out in dnSpy group and order', async () => {
    await openMain()
    const menu = await rightClickThrowAndCatch()
    const labels = await menuLabels(menu)

    // dnSpy's groups in their order: Tabs, Debug, then the assembly editor's delete, create and settings
    // groups, the IL commands, the tokens, the hex group and finally the editor's own commands. The label
    // names the node the command would act on, which for a caret on a method reference is that method.
    const index = (label: string): number => labels.findIndex((entry) => entry.startsWith(label))
    expect(index('Open in New Tab')).toBe(0)
    expect(index('Start Debugging...')).toBeGreaterThan(index('Open in New Tab'))
    expect(index('Add Breakpoint')).toBeGreaterThan(index('Start Debugging...'))
    expect(index('Add Method Breakpoint')).toBeGreaterThan(index('Add Breakpoint'))
    expect(index('Delete Method')).toBeGreaterThan(index('Add Method Breakpoint'))
    expect(index('Create Method')).toBeGreaterThan(index('Delete Method'))
    expect(index('Edit Method')).toBeGreaterThan(index('Create Method'))
    expect(index('Edit Method Body...')).toBeGreaterThan(index('Edit Method'))
    expect(index('Copy MD Token')).toBeGreaterThan(index('Edit Method Body...'))
    expect(index('Copy Full Name')).toBeGreaterThan(index('Copy MD Token'))
    expect(index('Show Instructions in Hex Editor')).toBeGreaterThan(index('Copy Full Name'))
    expect(index('Analyze')).toBeGreaterThan(index('Show Instructions in Hex Editor'))
    expect(index('Find')).toBeGreaterThan(index('Analyze'))
    // Nothing this port cannot run is on screen, and neither the bookmark group nor Select All is in it.
    for (const absent of ['Set Next Statement', 'Add Class Breakpoint', 'Break When Exception Thrown', 'Go to Token', 'Edit IL Instructions', 'Go to Resource', 'Incremental Search', 'Select All', 'Bookmark'])
      expect(labels.filter((label) => label.includes(absent))).toEqual([])
    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
  })

  test('copies the full name of the member the caret is on, and opens its instructions in hex', async () => {
    await openMain()
    const menu = await rightClickThrowAndCatch()
    await menu.getByRole('menuitem', { name: 'Copy Full Name' }).click()
    // The command writes to the renderer's clipboard, which is the main process's clipboard here.
    await expect.poll(() => application.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain('DebugTarget.Program::ThrowAndCatch()')

    await rightClickThrowAndCatch()
    await page.getByRole('menu', { name: 'Code editor' }).getByRole('menuitem', { name: 'Show Instructions in Hex Editor' }).click()
    // The hex document marks the bytes the command named, so the mark is what says the tab really opened on
    // the selected method's code rather than on the module at large.
    await expect(page.locator('.hex-byte-marked').first()).toBeVisible()
    await expect(page.getByRole('tab', { name: /\[Hex\]/ })).toBeVisible()
  })

  test('follows the reference under the caret into a tab of its own', async () => {
    await openMain()
    const targetTab = page.getByRole('tab', { name: 'ThrowAndCatch() : void' })
    const mainTab = page.getByRole('tab', { name: 'Main(string[]) : void' })
    await expect(mainTab).toHaveCount(1)

    // The target is not open yet, so the command opens the document the reference names. Copying the tab
    // it was asked from — which is what this used to do — would leave Main showing twice instead.
    const menu = await rightClickThrowAndCatch()
    await menu.getByRole('menuitem', { name: 'Open in New Tab' }).click()
    await expect(targetTab).toHaveCount(1)
    await expect(targetTab).toHaveAttribute('aria-selected', 'true')
    await expect(mainTab).toHaveCount(1)

    // Asked again with the target already up, dnSpy gives it another tab rather than bringing the one it
    // has to the front; the tab that comes forward is the new one.
    await mainTab.click()
    const again = await rightClickThrowAndCatch()
    await again.getByRole('menuitem', { name: 'Open in New Tab' }).click()
    await expect(targetTab).toHaveCount(2)
    await expect(targetTab.last()).toHaveAttribute('aria-selected', 'true')
  })

  test('still opens on a document that has neither spans nor a statement map', async () => {
    // IL is decompiled without spans, and the IL map behind the statements is C# only — so a caret in such a
    // document resolves to no member at all. The commands that read the document's own node stay, and the
    // menu is what opens rather than nothing.
    await openMain()
    await page.getByLabel('Decompiler language').selectOption('il')
    const editor = page.locator('.monaco-editor')
    await expect.poll(async () => editor.locator('.view-lines').innerText()).toContain('.method')
    await editor.locator('.view-lines .view-line').nth(2).click({ button: 'right' })

    const menu = page.getByRole('menu', { name: 'Code editor' })
    await expect(menu).toBeVisible()
    const labels = await menuLabels(menu)
    expect(labels).toContain('Edit Method Body...')
    expect(labels).toContain('Find')
    // Nothing that needs a member to act on: no statement for the breakpoint commands, no reference for the
    // ones that name the caret's node. The labels are compared whole, so that "Edit Method Body..." does not
    // stand in for the missing "Edit Method".
    for (const absent of ['Add Breakpoint', 'Copy Full Name', 'Delete Method', 'Analyze', 'Edit Method'])
      expect(labels).not.toContain(absent)
    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
  })
})

// "Go to Entry Point" needs a module that has one. The contracts library the other suites open is a library
// and has none, which is why this one is on the debuggee.
test.describe('the tree navigation commands', () => {
  test.beforeEach(async () => { await launchApp(debugTargetPath) })
  test.afterEach(async () => { await closeApp() })

  test('brings the module entry point into view from the module row', async () => {
    await openDebugTarget()
    const menu = page.getByRole('menu', { name: 'Assembly Explorer' })
    await page.locator('.tree-row[data-kind="module"]').first().click({ button: 'right' })
    await menu.getByRole('menuitem', { name: /^Go to Entry Point/ }).click()
    // The entry point is a member of a type the tree has not opened, so the reveal opens the chain above it
    // and the row is what gets selected, not just the node.
    await expect(page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^Main\(string\[\]\)/ })).toHaveAttribute('aria-selected', 'true')
  })
})

// Save Resource writes a node's bytes to a file the user picks. The picker is stubbed out and the file
// named up front, the way the other save commands' tests do it.
test.describe('saving a resource', () => {
  test.beforeEach(async () => { await launchApp(bamlTargetPath) })
  test.afterEach(async () => { await closeApp() })

  test('writes the bytes of the resource the menu was opened on', async () => {
    await page.getByRole('button', { name: 'Open Assembly' }).first().click()
    await expect(page.getByRole('treeitem').first()).toContainText('BamlTarget')
    await expandModule()
    await expandRow(page.locator('.tree-row[data-kind="resourcesgroup"]').first())
    const generated = page.locator('.tree-row[data-kind="resource"]').filter({ hasText: /\.g\.resources$/ })
    await expect(generated).toBeVisible()

    const menu = page.getByRole('menu', { name: 'Assembly Explorer' })
    await generated.click({ button: 'right' })
    await expect(menu.locator('.document-tab-menu-label').first()).toBeVisible()
    await menu.getByRole('menuitem', { name: /^Save / }).click()

    // The bytes written are the manifest resource's own: a .resources stream opens with its magic. dnSpy's
    // two Save commands differ in what a .resources entry decodes to, not in what the resource holds.
    await expect.poll(() => existsSync(saveResourcePath) ? readFileSync(saveResourcePath).subarray(0, 4).toString('hex') : '').toBe('cecaefbe')
  })
})

// Load Dependencies needs a module whose references resolve to files on this machine. The contracts library
// the main suite opens has almost none; the core assembly's are all beside it, and the resolver finds them
// through its own deps.json.
test.describe('loading an assembly\'s dependencies', () => {
  test.beforeEach(async () => { await launchApp(coreAssemblyPath) })
  test.afterEach(async () => { await closeApp() })

  test('opens the assemblies the module references name', async () => {
    await page.getByRole('button', { name: 'Open Assembly' }).first().click()
    await expect(page.locator('.tree-row[data-kind="assembly"]').first()).toContainText('dnSpy.Backend.Core')
    await expandModule()
    const moduleRow = page.locator('.tree-row[data-kind="module"]').first()
    await expect(moduleRow).toContainText('dnSpy.Backend.Core.dll')
    await expect(page.locator('.tree-row[data-kind="assembly"]')).toHaveCount(1)

    // Every assembly the module's references resolve to is opened, so the reference rows stop being dead
    // ends. Which files that is depends on the machine the suite runs on — the resolver reads the module's
    // own deps.json — so the test pins the one that always resolves, the contracts assembly beside this
    // fixture, and leaves the size of the rest of the closure alone.
    await moduleRow.click({ button: 'right' })
    await page.getByRole('menu', { name: 'Assembly Explorer' })
      .getByRole('menuitem', { name: 'Load Dependencies', exact: true }).click()

    const assemblies = page.locator('.tree-row[data-kind="assembly"]')
    await expect(assemblies.filter({ hasText: /dnSpy\.Backend\.Contracts/ })).toBeVisible()
    expect(await assemblies.count()).toBeGreaterThan(1)
    await showOutput()
    await expect(page.getByRole('tabpanel', { name: 'Output' })).toContainText(/Loaded \d+ dependency module\(s\)\./)

    // The recursive form walks on from there: the assemblies the module's references name, and theirs. How
    // far that reaches again depends on the machine, so the run is pinned by its message, not by a size.
    const lines = page.locator('.output-pane > div')
    const base = await lines.count()
    await moduleRow.click({ button: 'right' })
    await page.getByRole('menu', { name: 'Assembly Explorer' })
      .getByRole('menuitem', { name: 'Load Dependencies Recursively', exact: true }).click()
    await expect(lines).toHaveCount(base + 1)
    await expect(lines.last()).toContainText(/Loaded \d+ dependency module\(s\)\.|No dependencies were found/)
    // An assembly that got in on the way is not opened a second time under a name of its own.
    const labels = await assemblies.locator('.tree-label').allTextContents()
    expect(new Set(labels).size).toBe(labels.length)

    // The same two commands are on the Edit menu, where dnSpy registers them as well, and there they act on
    // the tree's selection — an assembly root names the same module the row below it does. The closure is
    // open by the time they run, so the command says so, and the message names the root it ran on.
    await assemblies.first().click()
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Load Dependencies', exact: true }).click()
    await expect(lines).toHaveCount(base + 2)
    await expect(lines.last()).toContainText(/No dependencies were found for dnSpy\.Backend\.Core/)
  })
})

// Opening a second file adds it to what is already there, the way the original does, instead of throwing
// the workspace away. The picker answers with a different assembly from its second call on, which is also
// how the same file gets picked twice below.
test.describe('opening more than one assembly', () => {
  test.beforeEach(async () => { await launchApp(contractsAssemblyPath, { secondAssembly: debugTargetPath }) })
  test.afterEach(async () => { await closeApp() })

  test('appends to the tree and leaves what was open alone', async () => {
    await openAssemblyAndNamespace()
    await openHelloRequest()

    await page.getByRole('button', { name: 'Open Assembly' }).first().click()

    const assemblies = page.locator('.tree-row[data-kind="assembly"]')
    await expect(assemblies).toHaveCount(2)
    await expect(assemblies.nth(0)).toContainText('dnSpy.Backend.Contracts')
    await expect(assemblies.nth(1)).toContainText('DebugTarget')
    // Everything the first file had brought up is still there: the branch the user expanded, and the tab.
    await expect(page.locator('.tree-row[data-kind="namespace"]').filter({ hasText: /^dnSpy\.Backend\.Contracts$/ })).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('tab', { name: 'HelloRequest' })).toBeVisible()

    // A file that is already open is reported as such, and adds nothing a second time.
    await page.getByRole('button', { name: 'Open Assembly' }).first().click()
    await expect(assemblies).toHaveCount(2)
    // Locals is the tool window that shows by default, so the message is read from the tab the command
    // wrote to, not from whichever pane happens to be on top.
    await showOutput()
    await expect(page.getByRole('tabpanel', { name: 'Output' })).toContainText('already open')
  })
})

// A file dnSpy cannot read is opened all the same, the way WPF's unknown document is: the tree shows it
// under its file name and so does the tab. Opening one used to fail the whole command, which is what made
// an ELF executable — the reported case, and what this fixture is — impossible to open at all.
test.describe('opening a file that is not a managed assembly', () => {
  const fixtureDirectory = mkdtempSync(path.join(os.tmpdir(), 'dnspy-e2e-unknown-'))
  const unknownFilePath = path.join(fixtureDirectory, 'not-an-assembly')

  test.beforeEach(async () => {
    // An ELF header: the file the report was about, and one no PE reader will accept.
    writeFileSync(unknownFilePath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]))
    await launchApp(unknownFilePath)
  })
  test.afterEach(async () => {
    await closeApp()
    rmSync(fixtureDirectory, { recursive: true, force: true })
  })

  test('keeps it in the tree and opens it as a document', async () => {
    await page.getByRole('button', { name: 'Open Assembly' }).first().click()

    const root = page.getByRole('treeitem').first()
    await expect(root).toContainText('not-an-assembly')
    await expect(root).toHaveAttribute('data-kind', 'unknowndocument')

    // The command did what it was asked, so nothing reports a failure — and no dialog is left behind.
    await showOutput()
    const output = page.getByRole('tabpanel', { name: 'Output' })
    await expect(output).toContainText('Opened 1 module(s).')
    await expect(output).not.toContainText('Open failed')

    await root.dblclick()
    await expect(page.getByRole('tab', { name: 'not-an-assembly' })).toBeVisible()
    await expect.poll(async () => (await page.locator('.monaco-editor .view-lines').innerText()).replaceAll(' ', ' '))
      .toContain('// not-an-assembly')
  })
})

// Double-clicking a type row is how every other test opens a document; this is that, named for what the
// session tests do with it.
const openHelloRequest = async (): Promise<void> => {
  const typeRow = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^HelloRequest @02000005$/ })
  await expect(typeRow).toBeVisible()
  await typeRow.dblclick()
  await expect(page.getByRole('tab', { name: 'HelloRequest' })).toBeVisible()
}

const storedSession = async (): Promise<{
  paths: string[]
  nodes: { key: string; expanded: boolean }[]
  documents: { key: string; language: string }[]
  activeDocument?: string
  selectedNode?: string
} | null> => await page.evaluate(() => JSON.parse(localStorage.getItem('dnspy.session.v1') ?? 'null'))

// The three launches share one profile directory: that directory is the only thing that carries a
// session from one run to the next, so they cannot be independent tests. Serial mode keeps them in
// order and skips the rest once one fails, rather than restoring from a state that was never written.
test.describe('the session a run leaves behind', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 })
  const profileDirectory = mkdtempSync(path.join(os.tmpdir(), 'dnspy-e2e-session-'))

  test.afterAll(async () => {
    await application?.close().catch(() => undefined)
    rmSync(profileDirectory, { recursive: true, force: true })
  })

  test('is written while the window is used', async () => {
    await launchApp(contractsAssemblyPath, { userDataDirectory: profileDirectory })
    await openAssemblyAndNamespace()
    await openHelloRequest()

    const session = await storedSession()
    expect(session?.paths).toEqual([contractsAssemblyPath])
    // The module root and the namespace the user opened are both recorded, the namespace as expanded.
    expect(session?.nodes).toContainEqual({ key: `module:${contractsAssemblyPath}`, expanded: true })
    expect(session?.nodes.some((node) => node.key.includes(':namespace:dnSpy.Backend.Contracts') && node.expanded)).toBe(true)
    expect(session?.documents).toHaveLength(1)
    expect(session?.documents[0]).toEqual({ key: session?.selectedNode, language: 'cSharp' })
    expect(session?.activeDocument).toBe(session?.selectedNode)

    await closeApp({ keepUserData: true })
  })

  test('comes back on the next launch, without being asked to open anything', async () => {
    await launchApp(contractsAssemblyPath, { userDataDirectory: profileDirectory })

    // No Open command is issued: the tree, its expansion, the tab and the selection all arrive from the
    // session. The namespace being expanded is what proves the branch was rebuilt rather than reopened.
    await expect(page.getByRole('treeitem').first()).toContainText('dnSpy.Backend.Contracts')
    const namespaceRow = page.locator('.tree-row[data-kind="namespace"]').filter({ hasText: /^dnSpy\.Backend\.Contracts$/ })
    await expect(namespaceRow).toHaveAttribute('aria-expanded', 'true')

    const tab = page.getByRole('tab', { name: 'HelloRequest' })
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    const typeRow = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^HelloRequest @02000005$/ })
    await expect(typeRow).toHaveAttribute('aria-selected', 'true')

    await closeApp({ keepUserData: true })
  })

  test('is left where it is when the app is told not to load any files', async () => {
    await launchApp(contractsAssemblyPath, { userDataDirectory: profileDirectory, extraArgs: ['--no-load-files'] })
    await expect(page.getByText('Ready', { exact: true })).toBeVisible()

    // The saved layout still names the previous document, but nothing brings it back: the window starts
    // on an empty tree and a Start page, and the stored session is still there for a launch without the
    // flag.
    await expect(page.locator('.tree-row')).toHaveCount(0)
    await expect(page.getByRole('tab', { name: 'Start' })).toBeVisible()
    expect((await storedSession())?.paths).toEqual([contractsAssemblyPath])

    await closeApp()
  })
})

// The same serial shape as the session above, and for the same reason: the breakpoint written by the
// first launch is the only thing the second one has to go on.
test.describe('the breakpoints a run leaves behind', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 })
  const profileDirectory = mkdtempSync(path.join(os.tmpdir(), 'dnspy-e2e-breakpoints-'))

  const storedBreakpoints = async (): Promise<{
    breakpoints: { modulePath: string; metadataToken: number; sourceMethodToken: number; ilOffset: number; line: number; enabled: boolean; description?: string }[]
    functions: { name: string; enabled: boolean }[]
  } | null> => await page.evaluate(() => JSON.parse(localStorage.getItem('dnspy.breakpoints.v1') ?? 'null'))

  test.afterAll(async () => {
    await application?.close().catch(() => undefined)
    rmSync(profileDirectory, { recursive: true, force: true })
  })

  test('are written as an IL location, not as a line in a document', async () => {
    await launchApp(contractsAssemblyPath, { userDataDirectory: profileDirectory })
    await openAssemblyAndNamespace()
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @02000076$/ })
    await rpcException.dblclick()

    // Monaco only renders the lines the viewport holds, so the window has to be tall enough to show the
    // constructor body — the one place in this document a click lands on a sequence point.
    const browserWindow = await application.browserWindow(page)
    await browserWindow.evaluate((window) => window.setSize(1500, 700))
    const bodyLine = page.locator('.monaco-editor .view-lines .view-line').filter({ hasText: /Code\s*=\s*code/ }).first()
    await expect(bodyLine).toBeVisible()

    await showBreakpoints()
    const { lineBox, marginBox } = await editorLayout(bodyLine, page.locator('.monaco-editor .margin').first())
    await page.mouse.click(marginBox.x + 8, lineBox.y + lineBox.height / 2)
    await expect(page.locator('.breakpoint-row')).toContainText('dnSpy.Backend.Contracts.RpcException..ctor')

    await page.getByRole('textbox', { name: 'Function breakpoint', exact: true }).fill('dnSpy.Backend.Contracts.RpcException.get_Code')
    await page.getByRole('button', { name: 'Add function breakpoint' }).click()

    await expect.poll(async () => (await storedBreakpoints())?.breakpoints.length).toBe(1)
    const stored = await storedBreakpoints()
    const [entry] = stored!.breakpoints
    // What goes to disk is the location WPF dnSpy persists: the module, the method and the offset in it.
    // The node id the click used is a counter this workspace hands out and is deliberately not there.
    expect(entry.modulePath).toBe(contractsAssemblyPath)
    expect(entry.metadataToken).toBeGreaterThan(0)
    expect(entry.sourceMethodToken).toBeGreaterThan(0)
    expect(entry.ilOffset).toBeGreaterThanOrEqual(0)
    expect(entry.enabled).toBe(true)
    expect(entry.description).toContain('RpcException')
    expect(stored!.functions).toEqual([{ name: 'dnSpy.Backend.Contracts.RpcException.get_Code', enabled: true }])

    await closeApp({ keepUserData: true })
  })

  test('come back on the next launch and find their line again', async () => {
    await launchApp(contractsAssemblyPath, { userDataDirectory: profileDirectory })

    await showBreakpoints()
    // The row is there before anything is decompiled: the method name and the line it was saved on are
    // what the pane labels it with, so a restored breakpoint never reads as "Line 0".
    const breakpointRows = page.locator('.breakpoint-row')
    await expect(breakpointRows).toHaveCount(2)
    await expect(breakpointRows.first()).toContainText('dnSpy.Backend.Contracts.RpcException..ctor:')
    await expect(breakpointRows.nth(1)).toContainText('dnSpy.Backend.Contracts.RpcException.get_Code')

    // The session restores the document, and the restored breakpoint attaches to it by IL identity —
    // which is what puts the glyph back in the gutter without the user clicking anything.
    const browserWindow = await application.browserWindow(page)
    await browserWindow.evaluate((window) => window.setSize(1500, 700))
    await expect(page.getByRole('tab', { name: 'RpcException' })).toBeVisible()
    await expect(page.locator('.breakpoint-glyph')).toHaveCount(1)

    // Removing it is what a restored breakpoint has to support too, and it leaves the storage empty.
    await breakpointRows.first().getByRole('button', { name: /^Remove / }).click()
    await expect(page.locator('.breakpoint-glyph')).toHaveCount(0)
    await expect.poll(async () => (await storedBreakpoints())?.breakpoints.length).toBe(0)

    await closeApp()
  })
})
