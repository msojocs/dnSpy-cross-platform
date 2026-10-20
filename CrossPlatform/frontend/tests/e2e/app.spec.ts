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
// The String References fixture: a string in every place dnSpy's string searcher looks.
const stringTargetPath = path.resolve(import.meta.dirname, '../../../backend/tests/StringTarget/bin/Debug/net10.0/StringTarget.dll')

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
  importBookmarksPath = path.join(userDataDirectory, 'bookmarks-to-import.xml')
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
      // dnSpy's "save before continuing?" is a native box no test can press; the edits are let go.
      DNSPY_E2E_SAVE_PROMPT: 'discard',
      // dnSpy asks before deleting a type or a member; the tests say yes.
      DNSPY_E2E_ASK_ANSWER: 'first',
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
  // The submenu opens on the pointer entering its row; a pointer that is already there when the row is drawn
  // never enters it, so the hover is taken away and given again until the submenu says it is open.
  const windowMenuItem = page.getByRole('menuitem', { name: 'Window', exact: true })
  await expect(async () => {
    await page.getByRole('menuitem', { name: /^Options\.\.\./ }).hover()
    await windowMenuItem.hover()
    await expect(windowMenuItem).toHaveAttribute('aria-expanded', 'true', { timeout: 1000 })
  }).toPass()
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
/** Puts the focus in an editor without a click on its text: a click on a reference follows it, as dnSpy's viewer
 * does, and the middle of a view is usually on one. */
const focusEditor = async (editor: Locator): Promise<void> => {
  await editor.locator('.native-edit-context, textarea.inputarea').first().focus()
}

/** Pages an editor down from its top until the line is drawn: Monaco draws only the lines in its viewport, and a
 * document with dnSpy's token comments and attributes is too long for a fixed scroll to land on a line. */
const revealInEditor = async (editor: Locator, line: Locator): Promise<void> => {
  // Monaco draws a scrolled view on the next animation frames; until then the old lines are still in the DOM.
  const drawn = (): Promise<void> => editor.first().evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await focusEditor(editor)
  await page.keyboard.press('Control+Home')
  await drawn()
  for (let page_ = 0; page_ < 200 && !(await line.isVisible()); page_++) {
    await page.keyboard.press('PageDown')
    await drawn()
  }
}

const expandModule = async (scope: Locator | Page = page): Promise<void> => {
  await expandRow(scope.locator('.tree-row[data-kind="assembly"]').first())
  await expandRow(scope.locator('.tree-row[data-kind="module"]').first())
}

/** A property's getter and setter are rows under the property that declares them, the way dnSpy nests an
 * accessor beneath its member — so a getter is only on screen once the property row itself is open. The
 * row wears the label its type is written after, and the token its own table row gives it. */
const expandPropertyRow = async (label: RegExp): Promise<Locator> => {
  const row = page.locator('.tree-row[data-kind="property"]').filter({ hasText: label })
  await expandRow(row)
  return row
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

/** The search window's row whose name reads exactly `name`. */
const searchResult = (name: string): Locator =>
  page.getByRole('listbox', { name: 'Search results' }).getByRole('option')
    .filter({ has: page.locator('.result-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })

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
    // The version is the packaged one, which is what the About box and the window title both carry.
    const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string
    await expect(about).toContainText(`Version ${version}`)
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
    // command for are greyed whatever is open. The two open dialogs need no workspace. The row is found by
    // its label span, since the shortcut column next to it is part of the button's own text.
    const row = (label: string) => page
      .locator('.menu-popup > .menu-item, .menu-popup > .menu-item-row > .menu-item')
      .filter({ has: page.locator(`span:nth-child(2):text-is("${label}")`) })
    for (const label of ['Export to Project...', 'Save', 'Save All...', 'Reload All Assemblies', 'Close All', 'Close Old In-Memory Modules', 'Close All Framework Assemblies', 'Close All Missing Files', 'Sort Assemblies'])
      await expect(row(label)).toBeDisabled()
    for (const label of ['Open...', 'Open from GAC...', 'Open List...'])
      await expect(row(label)).toBeEnabled()
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
    // ThemesMenu lists the high-contrast theme only while the system is in high contrast, which it is not here.
    await expect(page.getByRole('menuitem', { name: 'High Contrast' })).toHaveCount(0)
    await page.getByRole('menuitem', { name: 'Blue', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'blue')
    // The theme's resources are what the stylesheet draws with: the blue theme's tool windows are white.
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--wpf-EnvironmentToolWindow').trim())).toBe('#ffffff')
  })

  test('switches to Simplified Chinese and persists the language', async () => {
    await page.getByRole('menuitem', { name: 'View' }).click()
    await page.getByRole('menuitem', { name: 'Language' }).hover()
    // The submenu names each language the way dnSpy does, by its native name.
    await page.getByRole('menuitem', { name: '中文（中国）' }).click()

    await expect(page.getByRole('menuitem', { name: '文件' })).toBeVisible()
    await expect(page.getByText('就绪', { exact: true })).toBeVisible()
    await expect(page.locator('.dock-caption-title', { hasText: '程序集资源管理器' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await page.getByRole('button', { name: '打开程序集' }).first().click()
    await expect(page.getByRole('treeitem').first()).toContainText('dnSpy.Backend.Contracts')
    await expandModule()
    await expect(page.locator('.tree-row[data-kind="referencesgroup"]')).toContainText('引用')

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
    // A token is read where it is drawn: the type's header, its fields and its methods are further apart than a
    // viewport holds once the disassembler writes dnSpy's token comments and attributes.
    const ilTokenColor = async (text: string): Promise<string> => {
      // Looked up inside the page, a page of the document at a time: Monaco swaps its lines' elements as it draws
      // them, so a handle from outside can name one it already replaced. A name's quotes may be its own span.
      const colorOnScreen = (): Promise<string> => editor.locator('.view-lines').first().evaluate((lines, wanted) =>
        [...lines.querySelectorAll('span[class*="mtk"]')]
          .filter((span) => (span.textContent ?? '').replaceAll('\u00a0', ' ').trim().replace(/^'(.*)'$/, '$1') === wanted)
          .map((span) => getComputedStyle(span).color)
          .find((value) => value !== '') ?? '', text)
      const drawn = (): Promise<void> => editor.first().evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await focusEditor(editor)
      await page.keyboard.press('Control+Home')
      await drawn()
      for (let page_ = 0; page_ < 200; page_++) {
        const color = await colorOnScreen()
        if (color)
          return color
        await page.keyboard.press('PageDown')
        await drawn()
      }
      return ''
    }
    // dark.dntheme's IL colours: ILDirective, Label, OpCode, Type and the member colour.
    expect(await ilTokenColor('.method')).toBe('rgb(153, 153, 255)')
    expect(await ilTokenColor('IL_0000')).toBe('rgb(128, 111, 77)')
    expect(await ilTokenColor('ldarg.0')).toBe('rgb(173, 92, 133)')
    // dnSpy's disassembler writes a type by its namespace and its name, the name the reference to it — `extends
    // [System.Runtime]System.Object` — and a name that is not an ilasm identifier in quotes.
    expect(await ilTokenColor('Object')).toBe('rgb(78, 201, 176)')
    // The quotes may be written apart from the name they quote.
    expect(await ilTokenColor('<ProtocolVersion>k__BackingField')).toBe('rgb(255, 128, 0)')
    await page.screenshot({ path: 'test-results/dnspy-il-highlighting.png' })

    await page.getByLabel('Decompiler language').selectOption('ilWithCSharp')
    await expect.poll(async () => editor.locator('.view-lines').innerText()).toContain('//')
    await focusEditor(editor)
    for (let step = 0; step < 40 && !(await editor.locator('.view-lines').innerText()).includes('IL_'); step++)
      await page.keyboard.press('PageDown')
    await expect.poll(async () => editor.locator('.view-lines').innerText()).toContain('IL_')
    await page.screenshot({ path: 'test-results/dnspy-shell.png' })
  })

  test('runs document tab commands from the title context menu', async () => {
    await openAssemblyAndNamespace()
    const helloRequest = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^HelloRequest @02000005$/ })
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ })
    await helloRequest.dblclick()
    await expect.poll(async () => (await page.locator('.monaco-editor .view-lines').innerText()).replaceAll('\u00a0', ' ')).toContain('record HelloRequest')
    // dnSpy shows what the tree selects in the tab in front, so a second document needs a second tab: Ctrl+T
    // copies the one in front, and the copy then follows the tree.
    await page.keyboard.press('Control+t')
    await expect(page.getByRole('tab', { name: 'HelloRequest' })).toHaveCount(2)
    await rpcException.click()
    await expect(page.getByRole('tab', { name: 'RpcException' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'HelloRequest' })).toHaveCount(1)

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
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ })
    await rpcException.locator('.tree-expander').click()
    await expandPropertyRow(/^Code : int @[0-9A-F]{8}$/)
    const getCode = page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^get_Code\(\) : int @06000AD6$/ })
    await getCode.dblclick()

    await expect(page.locator('.document-view')).toHaveAttribute('data-reference-count', /^[1-9]\d*$/)
    const reference = page.locator('.monaco-editor .view-lines').getByText(/BackingField/).first()
    await expect(reference).toBeVisible()
    await reference.click()
    await page.keyboard.press('F12')

    // dnSpy follows a reference in the tab it was followed from, and — DecompileFullType being on — shows the
    // whole type the member is in. A backing field is not written out in the type's C#, so the caret has no
    // definition to go to there.
    const targetTab = page.getByRole('tab', { name: 'RpcException' })
    await expect(targetTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tab', { name: 'get_Code() : int' })).toHaveCount(0)
    const toolbar = page.getByRole('toolbar', { name: 'Main toolbar' })
    await expect(toolbar.getByRole('button', { name: 'Back' })).toBeEnabled()
    await toolbar.getByRole('button', { name: 'Back' }).click()
    // Back is the same tab's history: it shows the getter again.
    await expect(page.getByRole('tab', { name: 'get_Code() : int' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tab', { name: 'RpcException' })).toHaveCount(0)
    await expect(toolbar.getByRole('button', { name: 'Forward' })).toBeEnabled()
    await page.keyboard.press('Alt+ArrowRight')
    await expect(page.getByRole('tab', { name: 'RpcException' })).toHaveAttribute('aria-selected', 'true')
  })

  test('follows a reference into a module the tree does not hold', async () => {
    await openAssemblyAndNamespace()
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ })
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
    const result = searchResult('HelloRequest')
    await expect(result).toBeVisible()
    await expect(result.locator('.result-location')).toHaveText('dnSpy.Backend.Contracts')
    await result.dblclick()
    await expect(page.getByRole('tab', { name: 'HelloRequest' })).toBeVisible()
    await expect(page.locator('.monaco-editor')).toBeVisible()
  })

  test('searches as it is typed in, for what the boxes and the options say', async () => {
    await page.getByRole('button', { name: 'Open Assembly' }).first().click()
    await expect(page.getByRole('treeitem').first()).toContainText('dnSpy.Backend.Contracts')
    // Ctrl+Shift+K shows the window with the focus in its text box, and Ctrl and a letter picks what it looks for.
    await page.locator('.tree-row').first().click()
    await page.keyboard.press('Control+Shift+K')
    const input = page.getByRole('textbox', { name: 'Search assemblies' })
    await expect(input).toBeFocused()
    await page.keyboard.press('Control+T')
    await expect(page.getByRole('combobox', { name: 'Search For:' })).toHaveAttribute('data-value', 'type')
    await page.keyboard.type('HelloRequest')
    const list = page.getByRole('listbox', { name: 'Search results' })
    await expect(list.getByRole('option')).toHaveCount(1)
    // A sealed record is written in the sealed type's color.
    await expect(searchResult('HelloRequest').locator('.result-name .tc-sealedType')).toHaveText('HelloRequest')

    // The members are written the way dnSpy's list writes them: the return type first, the parameter types after.
    await page.keyboard.press('Control+M')
    await input.fill('Equals')
    await expect(searchResult('bool Equals(HelloRequest)')).toBeVisible()

    // A whole word has to be the whole name.
    await page.getByRole('button', { name: 'Options' }).click()
    const options = page.getByRole('group', { name: 'Options' })
    await expect(options.getByRole('checkbox')).toHaveCount(6)
    await page.keyboard.press('Control+T')
    await input.fill('HelloReq')
    await expect(searchResult('HelloRequest')).toBeVisible()
    await options.getByRole('checkbox', { name: 'Match Whole Words' }).click()
    await expect(list.getByRole('option')).toHaveCount(0)

    // The context menu switches the same settings.
    await options.getByRole('checkbox', { name: 'Match Whole Words' }).click()
    await searchResult('HelloRequest').click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Search' })
    await menu.getByRole('menuitem', { name: /^Case Sensitive Search/ }).click()
    await expect(options.getByRole('checkbox', { name: 'Case Sensitive Search' })).toBeChecked()
    await input.fill('helloreq')
    await expect(list.getByRole('option')).toHaveCount(0)
  })

  test('writes the search list through the language the toolbar picks, and explains a result in its tooltip', async () => {
    await page.getByRole('button', { name: 'Open Assembly' }).first().click()
    await expect(page.getByRole('treeitem').first()).toContainText('dnSpy.Backend.Contracts')
    await page.getByRole('toolbar', { name: 'Main toolbar' }).getByRole('button', { name: 'Search' }).click()
    // The "Search For" box lists its entries with their images; one is picked with the mouse.
    const searchFor = page.getByRole('combobox', { name: 'Search For:' })
    await searchFor.click()
    const entries = page.getByRole('listbox', { name: 'Search For:' }).getByRole('option')
    await expect(entries).toHaveCount(24)
    await expect(entries.filter({ hasText: /^Method$/ })).toHaveAttribute('title', 'Ctrl+M')
    await expect(entries.filter({ hasText: /^Method$/ }).locator('.ds-image')).toHaveCount(1)
    await entries.filter({ hasText: /^Method$/ }).click()
    await expect(searchFor).toHaveAttribute('data-value', 'method')
    await page.getByRole('textbox', { name: 'Search assemblies' }).fill('HelloRequest')
    const equals = searchResult('bool Equals(HelloRequest)')
    await expect(equals).toBeVisible()

    // Another language writes the list again without searching again: the selection stays where it was.
    await equals.click()
    await page.getByLabel('Decompiler language').selectOption('visualBasic')
    const vbEquals = searchResult('Function Equals(HelloRequest) As Boolean')
    await expect(vbEquals).toBeVisible()
    await expect(vbEquals).toHaveAttribute('aria-selected', 'true')
    await expect(vbEquals.locator('.result-location')).toHaveText('dnSpy.Backend.Contracts.HelloRequest')

    // The tooltip is the decompiler's own: the member with its parameter names, then the file it is in.
    await vbEquals.hover()
    const tip = page.getByRole('tooltip')
    await expect(tip).toContainText(/^Function HelloRequest\.Equals\(\w+ As HelloRequest\) As Boolean/)
    await expect(tip).toContainText('dnSpy.Backend.Contracts.dll')
    await page.mouse.move(0, 0)
    await expect(tip).toHaveCount(0)

    await page.getByLabel('Decompiler language').selectOption('il')
    const ilEquals = searchResult('bool Equals(HelloRequest)')
    await expect(ilEquals).toBeVisible()
    await ilEquals.hover()
    await expect(page.getByRole('tooltip')).toContainText(/^instance bool dnSpy\.Backend\.Contracts\.HelloRequest::Equals\(class dnSpy\.Backend\.Contracts\.HelloRequest\)/)
    await page.getByLabel('Decompiler language').selectOption('cSharp')
    await expect(searchResult('bool Equals(HelloRequest)')).toBeVisible()
  })

  test('analyzes a search result from its context menu and with Ctrl+Shift+R', async () => {
    await page.getByRole('button', { name: 'Open Assembly' }).first().click()
    await expect(page.getByRole('treeitem').first()).toContainText('dnSpy.Backend.Contracts')
    await page.getByRole('toolbar', { name: 'Main toolbar' }).getByRole('button', { name: 'Search' }).click()
    await page.getByRole('textbox', { name: 'Search assemblies' }).fill('HelloRequest')
    const type = searchResult('HelloRequest')
    await expect(type).toBeVisible()

    await type.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Search' })
    await expect(menu).toBeVisible()
    // dnSpy's search list groups: following the result, its token and name, the debugger, then Analyze.
    expect(await menu.getByRole('menuitem').locator('.document-tab-menu-label').allTextContents()).toEqual([
      'Go to Reference', 'Open in New Tab',
      'Copy MD Token', 'Copy Full Name',
      'Add Class Breakpoint', 'Add Class Tracepoint',
      'Analyze', 'Search MSDN',
      'Syntax Highlight', 'Match Whole Words', 'Case Sensitive Search', 'Match Any Search Term',
      'Decompile Resources (eg. XAML)', 'Search in framework assemblies', 'Search compiler generated members',
    ])
    await menu.getByRole('menuitem', { name: /^Analyze/ }).click()
    const roots = page.getByRole('tree', { name: 'Analyzer' }).locator('.tree-row[aria-level="1"]')
    await expect(roots).toHaveText(['HelloRequest @02000005'])

    // The record's Equals(HelloRequest) matches the query too; selected in the list, the key analyzes it.
    // The analyzer shares the search window's dock and came to the front over it.
    await page.getByRole('tab', { name: 'Search', exact: true }).click()
    const equals = searchResult('bool Equals(HelloRequest)')
    await equals.click()
    await expect(equals).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Control+Shift+R')
    await expect(roots).toHaveText(['HelloRequest @02000005', /^dnSpy\.Backend\.Contracts\.HelloRequest\.Equals\(HelloRequest\) : bool @06[0-9A-F]{6}$/])
  })

  test('opens an analyzed property onto its accessors, and its setter onto searches of its own', async () => {
    await openAssemblyAndNamespace()
    const helloRequest = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^HelloRequest @02000005$/ })
    await helloRequest.locator('.tree-expander').click()
    const nonce = page.locator('.tree-row[data-kind="property"]').filter({ hasText: /^Nonce : string @17[0-9A-F]{6}$/ })
    await nonce.click()
    await page.keyboard.press('Control+Shift+R')

    const analyzer = page.getByRole('tree', { name: 'Analyzer' })
    await expect(analyzer.locator('.tree-row[aria-level="1"]')).toHaveText([/^dnSpy\.Backend\.Contracts\.HelloRequest\.Nonce : string @17[0-9A-F]{6}$/])
    // A record's property has no virtual slot to override, so its rows are its two accessors, each written
    // as its keyword — and in the keyword's color.
    const accessors = analyzer.locator('.tree-row[aria-level="2"]')
    await expect(accessors).toHaveText(['get', 'set'])
    await expect(accessors.locator('.tc-keyword')).toHaveText(['get', 'set'])

    // The init setter has a body, so it uses something and can be used; the getter's users are found.
    await accessors.filter({ hasText: /^set$/ }).locator('.tree-expander').click()
    await expect(analyzer.locator('.tree-row[aria-level="3"]')).toHaveText(['Used By', 'Uses'])
    await accessors.filter({ hasText: /^get$/ }).locator('.tree-expander').click()
    const getterUsedBy = analyzer.locator('.tree-row[aria-level="3"]').filter({ hasText: /^Used By$/ }).first()
    await getterUsedBy.locator('.tree-expander').click()
    await expect(analyzer.locator('.tree-row[aria-level="4"]').first()).toHaveText(/^dnSpy\.Backend\.Contracts\.HelloRequest\./)
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

    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ })
    await rpcException.locator('.tree-expander').click()
    await expandPropertyRow(/^Code : int @[0-9A-F]{8}$/)
    const getCode = page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^get_Code\(\) : int @06000AD6$/ })
    await getCode.click()
    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await page.getByRole('menuitem', { name: 'Edit Method Body...' }).click()
    const ilDialog = page.getByRole('dialog', { name: 'Edit Method Body' })
    await expect(ilDialog.getByLabel('OpCode 0')).toBeVisible()
    await ilDialog.getByRole('button', { name: 'OK' }).click()
    await expect(page.getByText('Modified', { exact: true })).toBeVisible()
    // The toolbar's save button is dnSpy's Save All, which writes each module back to its own file; what
    // these two tests write is the copy the save dialog is pointed at, so they go through Save Module...
    await expect(page.getByRole('toolbar', { name: 'Main toolbar' }).getByRole('button', { name: 'Save All' })).toBeVisible()
    await page.getByRole('menuitem', { name: 'File', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Save Module...' }).click()
    // dnSpy's window opens on the module's own file; "..." picks the copy the test writes instead.
    const saveDialog = page.getByRole('dialog', { name: 'Save Module' })
    await saveDialog.getByRole('button', { name: 'Pick a file name' }).click()
    await expect(saveDialog.getByLabel('Filename', { exact: true })).toHaveValue(savePath)
    await saveDialog.getByRole('button', { name: 'OK' }).click()
    await expect(page.getByText('Modified', { exact: true })).not.toBeVisible()
    expect(existsSync(savePath)).toBe(true)
  })

  test('opens the tree context menu with the WPF commands for the row that was clicked', async () => {
    await openAssemblyAndNamespace()

    // dnSpy builds this menu from the tree's selection, and a right click selects the row before the menu
    // opens, so a type offers the type's own commands: the delete, the six creates, the editor, the token
    // copies, the one debugger command a type can name — everything its methods are — and the four outer
    // ones. The hex group contributes nothing: a type is a part inside a file, not a file, and this menu
    // has no document viewer behind it. A row is read by its label span, since the shortcut beside it is
    // part of the item's own text.
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
      'Edit Class (C#)...',
      'Add Class Members (C#)...',
      'Add Class (C#)...',
      'Merge with Assembly...',
      'Load Dependencies',
      'Load Dependencies Recursively',
      'Go to Token...',
      'Copy MD Token',
      'Copy Full Name',
      'Go to MD Table Row...',
      'Go to MD Table Row (02000005)',
      'Add Class Breakpoint',
      'Add Class Tracepoint',
      'Find String References in Module',
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

    // A module swaps the member commands for its own: the document and net module creates, the type create, the
    // two "Go to ..." navigations, the
    // module's own token and name (dnSpy's Copy Full Name writes a module's name), and the three documents and
    // folders it can open. "Open Hex Editor" is back — a
    // module row is a file, so it is one of the rows the hex editor opens. Remove is not: dnSpy's
    // RemoveAssemblyCommand takes only a root of the tree, and the module hangs under its assembly.
    await page.locator('.tree-row[data-kind="module"]').first().click({ button: 'right' })
    await expect(menu.locator('.document-tab-menu-label')).toHaveText([
      'Open in New Tab',
      // dnSpy shows Remove NetModule for any module of an assembly, greyed for the manifest module.
      'Remove NetModule from Assembly',
      'Convert Assembly to NetModule',
      'Create Assembly...',
      'Add New NetModule to Assembly...',
      'Add Existing NetModule to Assembly...',
      'Create NetModule...',
      'Create Type...',
      'Edit Assembly...',
      'Edit Module...',
      'Edit Assembly Attributes (C#)...',
      'Add Class (C#)...',
      'Merge with Assembly...',
      'Load Dependencies',
      'Load Dependencies Recursively',
      'Go to Entry Point',
      'Go to Global Cctor',
      'Go to Token...',
      'Copy MD Token',
      'Copy Full Name',
      'Go to MD Table Row...',
      'Go to MD Table Row (00000001)',
      'Open Hex Editor',
      'Module Information',
      'Find String References in Module',
      'Open Containing Folder',
      'Sort Assemblies',
    ])
    await page.keyboard.press('Escape')

    // A method adds the IL edits and the breakpoint, and its delete is named after it.
    await page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ }).locator('.tree-expander').click()
    await expandPropertyRow(/^Code : int @[0-9A-F]{8}$/)
    const getCode = page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^get_Code\(\) : int @06000AD6$/ })
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
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ })
    await rpcException.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Add Class Breakpoint' }).click()

    await showBreakpoints()
    const rows = page.locator('.breakpoint-row')
    // Every method of the type is broken on at its first instruction, named the way the Breakpoints window names
    // a code location: the method in the C# formatter's words and the IL offset. The constructor and the
    // property's getter are both here.
    await expect(rows.filter({ hasText: 'RpcException.RpcException(int code, string message, [object data], [Exception innerException]) + 0x0000' })).toHaveCount(1)
    await expect(rows.filter({ hasText: 'RpcException.Code.get + 0x0000' })).toHaveCount(1)

    // A second run adds nothing: every method has its breakpoint already.
    const count = await rows.count()
    expect(count).toBeGreaterThan(1)
    await rpcException.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Add Class Breakpoint' }).click()
    await expect(rows).toHaveCount(count)
  })

  test('breaks on a property\'s accessors from Add Method Breakpoint, and leaves a breakpoint that is there alone', async () => {
    await openAssemblyAndNamespace()
    const menu = page.getByRole('menu', { name: 'Assembly Explorer' })
    await page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ }).locator('.tree-expander').click()

    // dnSpy reads a property as the accessors it stands for, so the property row has the command too — and
    // the getter it reaches is not on screen, which the command does not need it to be.
    const code = page.locator('.tree-row[data-kind="property"]').filter({ hasText: /^Code : int @[0-9A-F]{8}$/ })
    await code.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Add Method Breakpoint' }).click()
    await showBreakpoints()
    const getter = page.locator('.breakpoint-row').filter({ hasText: 'RpcException.Code.get + 0x0000' })
    await expect(getter).toHaveCount(1)

    // Asked again, on the property or on the getter itself, it adds nothing and takes nothing away: the
    // command adds, it is not a toggle.
    await code.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Add Method Breakpoint' }).click()
    await expandPropertyRow(/^Code : int @[0-9A-F]{8}$/)
    await page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^get_Code\(\) : int @06000AD6$/ }).click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Add Method Breakpoint' }).click()
    await expect(getter).toHaveCount(1)
  })

  test('asks for a tracepoint\'s settings, then traces every method of the type', async () => {
    await openAssemblyAndNamespace()
    const menu = page.getByRole('menu', { name: 'Assembly Explorer' })
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ })
    await rpcException.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Add Class Tracepoint' }).click()

    // dnSpy opens the breakpoint settings with the trace already switched on, and adds nothing until OK.
    const dialog = page.getByRole('dialog', { name: 'Breakpoint Settings' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('checkbox', { name: 'Log Message' })).toBeChecked()
    await dialog.getByRole('textbox', { name: 'Log Message' }).fill('entered {$FUNCTION}')
    await dialog.getByRole('button', { name: 'OK' }).click()
    await expect(dialog).not.toBeVisible()

    await showBreakpoints()
    const rows = page.locator('.breakpoint-row')
    await expect(rows.filter({ hasText: 'RpcException.RpcException(int code, string message, [object data], [Exception innerException]) + 0x0000' })).toHaveCount(1)
    await expect(rows.filter({ hasText: 'RpcException.Code.get + 0x0000' })).toHaveCount(1)
    // Every breakpoint the command added prints the message rather than stopping: the When Hit column says so.
    const count = await rows.count()
    await expect(rows.filter({ hasText: "Print message 'entered {$FUNCTION}'" })).toHaveCount(count)
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
    // Go to Token is dnSpy's FollowReference: with DecompileFullType on, the method's token opens the type it is
    // declared in — which the tree then selects, opening the chain above it — with the caret on the method.
    await tokenDialog.getByLabel('Token').fill('0x06000AD6')
    await tokenDialog.getByRole('button', { name: 'OK' }).click()
    await expect(tokenDialog).toBeHidden()
    await expect(page.getByRole('tab', { name: 'RpcException', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ })).toHaveAttribute('aria-selected', 'true')

    // Remove Assembly takes the root and every row under it, and the tree is left with nothing on it.
    await page.locator('.tree-row[data-kind="assembly"]').first().click({ button: 'right' })
    await menu.getByRole('menuitem', { name: /^Remove dnSpy\.Backend\.Contracts/ }).click()
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
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ })
    await rpcException.locator('.tree-expander').click()
    await expandPropertyRow(/^Code : int @[0-9A-F]{8}$/)
    const getCode = page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^get_Code\(\) : int @06000AD6$/ })
    await getCode.click()

    // The hex group is listed in dnSpy's order, and only the entries that have something to point at are
    // in it: an int getter gets no 'return true'/'return false' body, whose commands belong to bool
    // methods. The row the click selected is shown in the tab in front, as dnSpy's tree shows its
    // selection, so the file command has that document's file to open, ahead of the method's own bytes.
    await expect(page.getByRole('tab', { name: 'get_Code() : int' })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Edit' }).click()
    // The shortcut rides along with the label in the item's own text, so it is trimmed off to compare order.
    const labels = (await page.getByRole('menu').last().getByRole('menuitem').allTextContents())
      .map((text) => text.replace(/(Ctrl|Shift|Alt)\+.*$/, '').trim())
    const start = labels.indexOf('Show Instructions in Hex Editor')
    expect(labels.indexOf('Open Hex Editor')).toBe(start - 1)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(labels.slice(start, start + 5)).toEqual([
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
    // getter's real body is longer, so its remaining bytes stay where they are under the patch. The getter is
    // still the tree's selection, which the Edit menu's hex commands act on; a click on its row would show it in
    // the tab in front — the hex view's — the way dnSpy's tree replaces what the active tab shows.
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

  test('browses the hex editor: caret, Go to Position, Find and Select All', async () => {
    await openAssemblyAndNamespace()
    const moduleRow = page.locator('.tree-row[data-kind="module"]').first()
    await moduleRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Open Hex Editor' }).click()

    const hex = page.locator('.hex-content')
    await expect(hex).toContainText('4D 5A')
    // The whole file is one dump: the status bar names the address under the caret, not a page offset.
    const statusOffset = page.locator('.hex-status-offset')
    await expect(statusOffset).toHaveText(/^0*0$/)

    // The caret is a byte: the right arrow moves it one nibble, so two presses land on the second byte.
    await page.locator('.hex-byte[data-hex-column="values"]').first().click()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(statusOffset).toHaveText(/^0*1$/)

    // Go to Position takes an address, absolute by default, and moves the caret to it. A number without a
    // prefix is decimal — dnSpy's SimpleTypeConverter — so the hexadecimal one says so.
    await page.keyboard.press('Control+G')
    const goto = page.getByRole('dialog', { name: 'Go to Position' })
    await goto.getByLabel('Offset').fill('0x20')
    await goto.getByRole('button', { name: 'OK' }).click()
    await expect(statusOffset).toHaveText(/^0*20$/)

    // Find searches the file for hexadecimal bytes and lands on the match.
    await page.keyboard.press('Control+F')
    // Exact: the two navigation buttons' labels ("Find Next", "Find Previous") contain "Find" too.
    await page.getByRole('search').getByLabel('Find', { exact: true }).fill('4D5A')
    await page.keyboard.press('Enter')
    // Find continues after the caret, so the match is the next one in the file; what matters is that the
    // bytes it named are selected and the status bar counts them.
    await expect(page.locator('.hex-status')).toContainText('Sel: 0x')
    await expect(page.locator('.hex-byte-selected')).not.toHaveCount(0)
    await page.getByRole('search').getByRole('button', { name: 'Close' }).click()

    // Select All covers the file, and the status bar counts it.
    await page.locator('.hex-byte[data-hex-column="values"]').first().click()
    await page.keyboard.press('Control+A')
    await expect(page.locator('.hex-status')).toContainText(/Sel: 0x0 - 0x[0-9A-F]+ \(\d[\d,]* bytes\)/)

    // Go to Metadata follows a token to its table row.
    await page.keyboard.press('Control+M')
    const metadata = page.getByRole('dialog', { name: 'Go to Metadata' })
    // Exact role and name: the "Metadata token" radio's own label also contains "Token".
    await metadata.getByRole('textbox', { name: 'Token' }).fill('02000088')
    await metadata.getByRole('button', { name: 'OK' }).click()
    await expect(page.locator('.hex-status')).toContainText('Sel: 0x')

    // The hex tab is read-only for a module that has no edits, so the browse ends cleanly.
    await page.keyboard.press('Escape')
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

    // A click selects the row, and with dnSpy's default "Single-click expands nodes" it also folds the open
    // namespace; the rename below works on the selection, and the type rows are opened again after it.
    await namespaceRow.click()
    await expect(namespaceRow).toHaveAttribute('aria-expanded', 'false')
    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await page.getByRole('menuitem', { name: 'Rename Namespace' }).click()
    const namespaceDialog = page.getByRole('dialog', { name: 'Edit Namespace' })
    await namespaceDialog.getByLabel('Name').fill('dnSpy.Backend.Renamed')
    await namespaceDialog.getByRole('button', { name: 'OK' }).click()
    await expect(page.locator('.tree-row[data-kind="namespace"]').filter({ hasText: /^dnSpy\.Backend\.Renamed$/ })).toBeVisible()

    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await page.getByRole('menuitem', { name: /^Undo/ }).click()
    await expect(namespaceRow).toBeVisible()
    await expandRow(namespaceRow)

    // The stub body is built by the backend from the method's signature, so its only job here is to
    // land as an edit the user can undo.
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ })
    await rpcException.locator('.tree-expander').click()
    await expandPropertyRow(/^Code : int @[0-9A-F]{8}$/)
    await page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^get_Code\(\) : int @06000AD6$/ }).click()
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

    // The toolbar's save button is dnSpy's Save All, which writes each module back to its own file; what
    // these two tests write is the copy the save dialog is pointed at, so they go through Save Module...
    await expect(page.getByRole('toolbar', { name: 'Main toolbar' }).getByRole('button', { name: 'Save All' })).toBeVisible()
    await page.getByRole('menuitem', { name: 'File', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Save Module...' }).click()
    // dnSpy's window opens on the module's own file; "..." picks the copy the test writes instead.
    const saveDialog = page.getByRole('dialog', { name: 'Save Module' })
    await saveDialog.getByRole('button', { name: 'Pick a file name' }).click()
    await expect(saveDialog.getByLabel('Filename', { exact: true })).toHaveValue(savePath)
    await saveDialog.getByRole('button', { name: 'OK' }).click()
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
    await expect(page.locator('.result-row').filter({ hasText: 'E2ECreated' }).first()).toBeVisible()
  })

  test('creates a method with a parameter and an attribute, then renames it with Alt+Enter', async () => {
    await openAssemblyAndNamespace()
    await page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ }).click()

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
    // dnSpy names a constructor row after its type, the way the decompiler writes one.
    await constructorPicker.locator('.tree-row[data-kind="method"]').filter({ hasText: /^WorkspaceRequest\(/ }).first().click()
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
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ })
    await rpcException.locator('.tree-expander').click()
    await expandPropertyRow(/^Code : int @[0-9A-F]{8}$/)
    await page.locator('.tree-row[data-kind="method"]').filter({ hasText: /^get_Code\(\) : int @06000AD6$/ }).click()
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
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ })
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
    await expect(breakpointRows).toContainText('RpcException.RpcException(int code, string message, [object data], [Exception innerException]) + 0x')
    await expect(glyphs).toHaveCount(1)

    // Clicking the marker again removes it, the same way the WPF editor toggles an existing breakpoint.
    await clickGutter()
    await expect(breakpointRows).toHaveCount(0)
    await expect(glyphs).toHaveCount(0)
  })

  test('bookmarks a statement from the gutter and clears it from the View menu', async () => {
    await openAssemblyAndNamespace()
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ })
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
    // The row names the method the statement sits in and the IL offset it was saved as, the way dnSpy's
    // Location column writes them — token, C# signature, "+ offset" — and the module's whole path.
    await expect(rows.first().locator('.bookmark-location-cell')).toHaveText(/^0x060[0-9A-F]{5} RpcException\.RpcException\(int code, string message, \[object data\], \[Exception innerException\]\) \+ 0x[0-9A-F]{4}$/)
    await expect(rows.first().locator('.bookmark-module-cell')).toHaveText(contractsAssemblyPath)
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
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ })
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
    // The Location column is written by the backend; the row is read once it has been.
    await expect(rows.first()).toContainText('RpcException.RpcException(')
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
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ })
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
    // The file is dnSpy's own: its settings XML, with the bookmark named by module, token and IL offset and
    // the member's name to check the token against — nothing session-local in it.
    expect(exported).toMatch(/^<\?xml version="1\.0" encoding="utf-8"\?>\s*<settings>\s*<section _="eaa1be38-7a55-44af-ad93-5b7ee2327edd">/)
    expect(exported).toMatch(/<section _="Bookmark" IsEnabled="True" Name="Bookmark \d+">/)
    expect(exported).toContain(`ModuleName="${contractsAssemblyPath}"`)
    expect(exported).toMatch(/__BMT="DotNetBody" AssemblyFullName="dnSpy\.Backend\.Contracts, Version=[^"]+" ModuleName="[^"]+" Offset="\d+" Token="\d+" TokenString="System\.Void dnSpy\.Backend\.Contracts\.RpcException::\.ctor\(/)

    await page.getByRole('button', { name: 'Clear Bookmarks' }).click()
    await expect(rows).toHaveCount(0)

    writeFileSync(importBookmarksPath, exported)
    await page.getByRole('button', { name: 'Import Bookmarks' }).click()

    await expect(rows).toHaveCount(1)
    await expect(status).toContainText('Imported 1 bookmark(s).')
    await expect(rows.first().locator('.bookmark-location-cell')).toContainText('RpcException.RpcException(int code')
  })

  test('toggles a bookmark with the Ctrl+K chord while the editor has focus', async () => {
    await openAssemblyAndNamespace()
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ })
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

  test('bookmarks a declaration line by its member with Ctrl+F2, and walks back to it with F2', async () => {
    await openAssemblyAndNamespace()
    await page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ }).dblclick()
    const browserWindow = await application.browserWindow(page)
    await browserWindow.evaluate((window) => window.setSize(1500, 700))

    // The constructor's declaration line holds no statement, so dnSpy bookmarks the member it defines — a
    // location named by token alone, which the Location column writes without an offset.
    const declaration = page.locator('.monaco-editor .view-lines .view-line').filter({ hasText: /public\s+RpcException\(int\s+code/ }).first()
    await expect(declaration).toBeVisible()
    await declaration.click()
    const activeLineNumber = page.locator('.monaco-editor .line-numbers.active-line-number')
    const declarationLineNumber = (await activeLineNumber.textContent()) ?? ''
    expect(declarationLineNumber).toMatch(/^\d+$/)
    await page.keyboard.press('Control+F2')

    await showBookmarksWindow()
    const rows = page.locator('.bookmark-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first().locator('.bookmark-location-cell')).toHaveText(/^0x060[0-9A-F]{5} RpcException\.RpcException\(int code, string message, \[object data\], \[Exception innerException\]\)$/)
    await expect(page.locator('.bookmark-glyph')).toHaveCount(1)

    // F2 in the code viewer is dnSpy's Next Bookmark: from the body it wraps round to the declaration, and the
    // Ctrl+F2 that follows lands on the bookmark again and takes it away.
    const bodyLine = page.locator('.monaco-editor .view-lines .view-line').filter({ hasText: /Code\s*=\s*code/ }).first()
    await bodyLine.click()
    await expect(activeLineNumber).not.toHaveText(declarationLineNumber)
    await page.keyboard.press('F2')
    await expect(activeLineNumber).toHaveText(declarationLineNumber)
    await page.keyboard.press('Control+F2')
    await expect(rows).toHaveCount(0)
    await expect(page.locator('.bookmark-glyph')).toHaveCount(0)
  })

  test('bookmarks an IL instruction and shows it on the C# statement that holds it', async () => {
    await openAssemblyAndNamespace()
    await page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ }).dblclick()
    const browserWindow = await application.browserWindow(page)
    await browserWindow.evaluate((window) => window.setSize(1500, 700))
    const editor = page.locator('.monaco-editor')
    await expect.poll(async () => (await editor.locator('.view-lines').innerText()).replaceAll('\u00a0', ' ')).toContain('Code = code')

    // The IL view has a statement per instruction, as dnSpy's has: the store into Code's backing field sits in
    // the middle of the C# statement `Code = code;`.
    await page.getByLabel('Decompiler language').selectOption('il')
    // The constructor's first store is into Code's backing field. Its line carries the instruction's bytes too and
    // wraps, so the view line that starts it is the one with the opcode.
    const store = editor.locator('.view-lines .view-line').filter({ hasText: /\bstfld\b/ }).filter({ visible: true }).first()
    // Monaco draws only the lines in its viewport and the store is a few lines below it, so the caret is
    // walked down from the constructor's first instruction until the line has been drawn.
    const first = editor.locator('.view-lines .view-line').filter({ hasText: /IL_0000:/ }).filter({ visible: true }).first()
    await expect(editor).toHaveAttribute('data-language-id', 'il')
    await revealInEditor(editor, first)
    await expect(first).toBeVisible()
    await first.click()
    for (let step = 0; step < 30 && (await store.count()) === 0; step++)
      await page.keyboard.press('ArrowDown')
    await expect(store).toBeVisible()
    // The line's indentation, not its text: a click on the field the instruction names would follow it.
    await store.click({ position: { x: 4, y: 4 } })
    await page.keyboard.press('Control+k')
    await page.keyboard.press('Control+k')

    await showBookmarksWindow()
    const rows = page.locator('.bookmark-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first().locator('.bookmark-location-cell')).toHaveText(/RpcException\.RpcException\(.*\) \+ 0x00[0-9A-F]{2}$/)
    await expect(page.locator('.bookmark-glyph')).toHaveCount(1)

    // Back in C#, the bookmark is drawn on the statement whose IL holds the instruction.
    await page.getByLabel('Decompiler language').selectOption('cSharp')
    const bodyLine = editor.locator('.view-lines .view-line').filter({ hasText: /Code\s*=\s*code/ }).first()
    const glyph = page.locator('.bookmark-glyph')
    await expect(glyph).toHaveCount(1)
    await expect(async () => {
      const lineBox = await bodyLine.boundingBox()
      const glyphBox = await glyph.boundingBox()
      expect(lineBox && glyphBox && Math.abs((glyphBox.y + glyphBox.height / 2) - (lineBox.y + lineBox.height / 2)) < lineBox.height / 2).toBe(true)
    }).toPass({ timeout: 10_000 })
  })

  test('writes the Location column with the display options the context menu switches', async () => {
    await openAssemblyAndNamespace()
    await page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ }).dblclick()
    const browserWindow = await application.browserWindow(page)
    await browserWindow.evaluate((window) => window.setSize(1500, 700))
    const bodyLine = page.locator('.monaco-editor .view-lines .view-line').filter({ hasText: /Code\s*=\s*code/ }).first()
    await bodyLine.click()
    await page.keyboard.press('Control+F2')

    await showBookmarksWindow()
    const row = page.locator('.bookmark-row').first()
    const location = row.locator('.bookmark-location-cell')
    await expect(location).toHaveText(/^0x060[0-9A-F]{5} RpcException\.RpcException\(int code/)
    // dnSpy's syntax highlighting: the keywords in the theme's keyword color.
    await expect(location.locator('.tc-keyword').first()).toHaveText('int')
    await expect(location.locator('.tc-keyword').first()).toHaveCSS('color', 'rgb(86, 156, 214)')

    const option = async (name: string): Promise<void> => {
      await row.click({ button: 'right' })
      const menu = page.getByRole('menu', { name: 'Bookmarks' })
      await expect(menu).toBeVisible()
      await menu.getByRole('menuitem', { name }).click()
    }
    await option('Show Tokens')
    await expect(location).toHaveText(/^RpcException\.RpcException\(int code/)
    await option('Show Module Names')
    await expect(location).toHaveText(/^dnSpy\.Backend\.Contracts\.dll!RpcException\.RpcException\(int code/)
    await option('Show Parameter Names')
    await expect(location).toContainText('RpcException(int, string, [object], [Exception])')
    // The options outlive the window: dnSpy keeps them with its settings.
    await option('Show Tokens')
    await option('Show Module Names')
    await option('Show Parameter Names')
    await expect(location).toHaveText(/^0x060[0-9A-F]{5} RpcException\.RpcException\(int code/)
  })

  test('toggles a breakpoint at the caret from the Debug menu', async () => {
    await openAssemblyAndNamespace()
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ })
    await rpcException.dblclick()
    const browserWindow = await application.browserWindow(page)
    await browserWindow.evaluate((window) => window.setSize(1500, 700))
    const bodyLine = page.locator('.monaco-editor .view-lines .view-line').filter({ hasText: /Code\s*=\s*code/ }).first()
    await expect(bodyLine).toBeVisible()
    await showBreakpoints()

    // dnSpy's Toggle Breakpoint is the code viewer's: it acts on the statement under the caret, which a right click
    // puts there without following the reference a left click would.
    await bodyLine.click({ button: 'right' })
    await expect(page.getByRole('menu', { name: 'Code editor' })).toBeVisible()
    await expect.poll(async () => await page.evaluate(() => document.activeElement?.closest('[role="menu"]') !== null)).toBe(true)
    await page.keyboard.press('Escape')
    const toggle = async (): Promise<void> => {
      await page.getByRole('menuitem', { name: 'Debug', exact: true }).click()
      await page.getByRole('menuitem', { name: /^Toggle Breakpoint/ }).click()
    }
    const breakpointRows = page.locator('.breakpoint-row')
    await toggle()
    await expect(breakpointRows).toContainText('RpcException.RpcException(int code, string message, [object data], [Exception innerException]) + 0x')

    // A second toggle removes it again, like the upstream Toggle Breakpoint command.
    await toggle()
    await expect(breakpointRows).toHaveCount(0)
  })

  test('runs submissions in the C# Interactive window', async () => {
    await page.getByRole('menuitem', { name: 'View' }).click()
    await page.getByRole('menuitem', { name: /^C# Interactive/ }).click()

    // Opening the window builds the session, which prints the engine banner; the first submission
    // then has to compile, so the waits below are wider than the default.
    const log = page.locator('.script-log')
    await expect(log).toContainText('Roslyn C# Compiler version', { timeout: 60_000 })
    // The engine reads its response file from beside the host, as the WPF window's does, and says so.
    await expect(log).toContainText("Loading context from 'CSharpInteractive.rsp'.")
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

    await page.getByRole('button', { name: 'Clear Screen' }).click()
    await expect(log).toBeEmpty()
  })

  test('follows the REPL editing keys, history, saving and the log live', async () => {
    await page.getByRole('menuitem', { name: 'View' }).click()
    await page.getByRole('menuitem', { name: /^C# Interactive/ }).click()
    const log = page.locator('.script-log')
    await expect(log).toContainText('Roslyn C# Compiler version', { timeout: 60_000 })
    const pane = page.locator('.script-pane')
    const input = page.locator('.script-input .monaco-editor')

    // ReplSettings.ShowLineNumbers defaults to true, and the Word Wrap button is a pressed toggle.
    await expect(page.locator('.script-input .line-numbers')).toBeVisible()
    const wordWrap = page.getByRole('button', { name: 'Toggle Word Wrap' })
    await expect(wordWrap).toHaveAttribute('aria-pressed', 'true')
    await wordWrap.click()
    await expect(wordWrap).toHaveAttribute('aria-pressed', 'false')
    await wordWrap.click()
    await expect(wordWrap).toHaveAttribute('aria-pressed', 'true')

    // Enter submits only a complete submission; an open block gets the line break it was typing.
    await input.click()
    await page.keyboard.type('if (true) {')
    await page.keyboard.press('Enter')
    await expect(log.locator('.script-echo')).toHaveCount(0)
    await page.keyboard.type('PrintLine("inside"); }')
    await page.keyboard.press('Enter')
    await expect(log.locator('.script-echo').first()).toContainText('if (true) {')
    await expect(log.locator('.script-echo').last()).toContainText('PrintLine("inside"); }')
    await expect(log).toContainText('inside', { timeout: 60_000 })

    // Escape empties the input, so the help text is all that is submitted next.
    await expect(pane).toHaveAttribute('data-running', 'false', { timeout: 60_000 })
    await page.keyboard.type('this is cleared')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Enter')
    // The block's two lines are its echo's two lines; nothing was submitted after Escape.
    await expect(log.locator('.script-echo')).toHaveCount(2)
    await page.keyboard.type('#help')
    await page.keyboard.press('Enter')
    await expect(log).toContainText('Ctrl+Alt+Up Arrow')

    // Alt+Up recalls the last submission and Enter runs it again.
    await input.click()
    await page.keyboard.press('Alt+ArrowUp')
    await page.keyboard.press('Enter')
    await expect(log.locator('.script-echo')).toHaveCount(4)

    // Ctrl+Alt+Up walks the entries matching what is typed.
    await page.keyboard.type('1 + 1')
    await page.keyboard.press('Enter')
    await expect(log.locator('.script-result').last()).toHaveText('2', { timeout: 60_000 })
    await page.keyboard.type('1')
    await page.keyboard.press('Control+Alt+ArrowUp')
    await page.keyboard.press('Enter')
    await expect(log.locator('.script-echo').last()).toHaveText('> 1 + 1')
    await expect(log.locator('.script-result').last()).toHaveText('2', { timeout: 60_000 })

    // The input box is locked while a submission runs, but its lines fill the log as they are printed.
    await expect(pane).toHaveAttribute('data-running', 'false', { timeout: 60_000 })
    await input.click()
    await page.keyboard.type('for (var i = 0; i < 4; i++) { PrintLine("tick" + i); await Task.Delay(400); }')
    await page.keyboard.press('Enter')
    await expect(log).toContainText('tick0', { timeout: 60_000 })
    await expect(pane).toHaveAttribute('data-running', 'true')
    await expect(pane).toHaveAttribute('data-running', 'false', { timeout: 60_000 })
    await expect(log).toContainText('tick3')

    // A script's Ask box is the window's own dialog; answering it returns the value to the script.
    await page.keyboard.type('PrintLine(Ask<int>("Number"));')
    await page.keyboard.press('Enter')
    const askDialog = page.getByRole('dialog')
    await expect(askDialog).toBeVisible({ timeout: 60_000 })
    await askDialog.getByRole('textbox').fill('42')
    await askDialog.getByRole('button', { name: 'OK' }).click()
    await expect(log.locator('.script-entry').last()).toHaveText('42', { timeout: 60_000 })

    // Ctrl+S writes the whole window; the context menu's Save Code writes only the submissions.
    await input.click()
    await page.keyboard.press('Control+S')
    await expect.poll(() => existsSync(saveCodePath) ? readFileSync(saveCodePath, 'utf8') : '').toContain('> 1 + 1')
    await input.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Save Code...' })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Save Code...' }).click()
    await expect.poll(() => readFileSync(saveCodePath, 'utf8')).toContain('var i = 0')
    await expect.poll(() => readFileSync(saveCodePath, 'utf8')).not.toContain('tick0')

    // Ctrl+L clears the log, as dnSpy's Clear Screen does.
    await input.click()
    await page.keyboard.press('Control+L')
    await expect(log).toBeEmpty()
  })

  test('colors the C# Interactive input the way the WPF window\'s Roslyn classifier does', async () => {
    await page.getByRole('menuitem', { name: 'View' }).click()
    await page.getByRole('menuitem', { name: /^C# Interactive/ }).click()
    const log = page.locator('.script-log')
    await expect(log).toContainText('Roslyn C# Compiler version', { timeout: 60_000 })
    const pane = page.locator('.script-pane')
    const input = page.locator('.script-input .monaco-editor')

    // The input is compiled as the session's next submission: a static class, its static method, a string
    // and a name that binds to nothing each get dnSpy's color for what they are.
    await input.click()
    await page.keyboard.type('Console.WriteLine("hi" + missingName);')
    const colored = page.locator('.script-input')
    await expect(colored.locator('.tc-staticType').filter({ hasText: 'Console' })).toBeVisible({ timeout: 60_000 })
    await expect(colored.locator('.tc-staticMethod').filter({ hasText: 'WriteLine' })).toBeVisible()
    await expect(colored.locator('.tc-string').filter({ hasText: '"hi"' })).toBeVisible()
    await expect(colored.locator('.tc-error').filter({ hasText: 'missingName' })).toBeVisible()

    // A variable an earlier submission declared is colored as a local, and the echo keeps the input's colors.
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Backspace')
    await page.keyboard.type('var answer = 42;')
    await expect(colored.locator('.tc-keyword').filter({ hasText: 'var' })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(pane).toHaveAttribute('data-running', 'false', { timeout: 60_000 })
    await expect(log.locator('.script-echo .tc-keyword').filter({ hasText: 'var' })).toBeVisible()
    await expect(log.locator('.script-echo .tc-number').filter({ hasText: '42' })).toBeVisible()
    // The input is locked while the submission runs, so the next one waits for the window to accept it.
    await expect(pane).toHaveAttribute('data-running', 'false', { timeout: 60_000 })
    await input.click()
    await page.keyboard.type('answer')
    await expect(colored.locator('.tc-local').filter({ hasText: 'answer' })).toBeVisible({ timeout: 60_000 })
  })
})

test.describe('the String References window', () => {
  test.beforeEach(async () => { await launchApp(stringTargetPath) })
  test.afterEach(async () => { await closeApp() })

  test('lists every string of the selected assembly, filters them and follows one to its member', async () => {
    await page.getByRole('button', { name: 'Open Assembly' }).first().click()
    const assemblyRow = page.locator('.tree-row[data-kind="assembly"]').first()
    await expect(assemblyRow).toContainText('StringTarget')

    // dnSpy's tree command: the window opens with the focus in its search box and scans the assembly.
    await assemblyRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^Find String References in Module/ }).click()
    const grid = page.getByRole('grid', { name: 'String References' })
    const search = page.getByRole('textbox', { name: 'Search' })
    await expect(search).toBeFocused()
    const rows = grid.locator('.strings-row')
    const row = (literal: string): Locator => rows.filter({ has: page.locator('.tc-string, .tc-verbatimString').getByText(literal, { exact: true }) })
    await expect(row('"Hello, "')).toBeVisible()
    await expect(row('"Hello, "')).toContainText(/^IL"Hello, "Holder\.Greet\(\[string\]\)\+IL_[0-9A-F]{4}StringTarget\.dll$/)
    await expect(row('"default name"')).toContainText('Holder.Greet([string]) parameter name')
    await expect(row('"default name"').locator('.strings-cell').first()).toHaveText('Constant')
    await expect(row('"type note"').locator('.strings-cell').first()).toHaveText('Attribute')
    await expect(row('@"C:\\temp\\file.txt"')).toBeVisible()
    // The lambda's string is in a member the C# view hides.
    await expect(rows.filter({ hasText: 'inside lambda' })).toHaveCount(0)

    // The box filters as it is typed in; the options match a regular expression or the formatted literal.
    await search.fill('note')
    await expect(rows).toHaveCount(5)
    await page.getByRole('button', { name: 'Options' }).click()
    await page.getByRole('checkbox', { name: 'Regular expression' }).click()
    await search.fill('^(module|return) note$')
    await expect(rows).toHaveCount(2)
    await search.fill('(')
    await expect(search).toHaveAttribute('aria-invalid', 'true')
    await page.getByRole('checkbox', { name: 'Regular expression' }).click()
    await page.getByRole('checkbox', { name: 'Match on formatted string' }).click()
    await search.fill('\\n')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('"line\\nbreak \\"quoted\\""')
    await page.getByRole('checkbox', { name: 'Match on formatted string' }).click()

    // A header sorts by its column.
    await search.fill('')
    await grid.getByRole('columnheader', { name: /Literal/ }).click()
    await expect(grid.getByRole('columnheader', { name: /Literal/ })).toHaveAttribute('aria-sort', 'ascending')

    // Following an ldstr opens its method — in the whole type it is declared in, DecompileFullType being on.
    await search.fill('Hello, ')
    await expect(rows).toHaveCount(1)
    await rows.first().dblclick()
    await expect(page.getByRole('tab', { name: /^Holder/ })).toBeVisible()
  })

  test('writes its rows in the language the toolbar picks and follows an ldstr to its statement in each view', async () => {
    await page.getByRole('button', { name: 'Open Assembly' }).first().click()
    const assemblyRow = page.locator('.tree-row[data-kind="assembly"]').first()
    await expect(assemblyRow).toContainText('StringTarget')
    await assemblyRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^Find String References in Module/ }).click()
    const grid = page.getByRole('grid', { name: 'String References' })
    const rows = grid.locator('.strings-row')
    await page.getByRole('textbox', { name: 'Search' }).fill('Hello, ')
    await expect(rows).toHaveCount(1)
    const referrer = rows.first().locator('.strings-referrer')
    const editor = page.locator('.monaco-editor').filter({ visible: true })
    const caret = editor.locator('.cursors-layer > .cursor')

    /** Follows the row from the top of the document, and waits for the caret on the line of the ldstr's statement. */
    const followsTo = async (line: Locator): Promise<void> => {
      if (await editor.count() > 0) {
        await focusEditor(editor)
        await page.keyboard.press('Control+Home')
      }
      await rows.first().dblclick()
      await expect(line).toBeVisible()
      await expect.poll(async () => {
        const caretBox = await caret.boundingBox()
        const lineBox = await line.boundingBox()
        if (!caretBox || !lineBox)
          return false
        const caretMiddle = caretBox.y + caretBox.height / 2
        return caretMiddle >= lineBox.y && caretMiddle <= lineBox.y + lineBox.height
      }).toBe(true)
    }

    await expect(referrer).toHaveText(/^Holder\.Greet\(\[string\]\)\+IL_[0-9A-F]{4}$/)
    await followsTo(editor.locator('.view-line').filter({ hasText: /return\s"Hello,\s"/ }))

    // dnSpy writes a referrer through the selected decompiler: Visual Basic's formatter has its own words, and
    // the statement is found in the VB view's own statement table.
    await page.getByLabel('Decompiler language').selectOption('visualBasic')
    await expect(editor).toHaveAttribute('data-language-id', 'vb')
    await expect(referrer).toHaveText(/^Function Holder\.Greet\(\[String\]\)\+IL_[0-9A-F]{4}$/)
    await followsTo(editor.locator('.view-line').filter({ hasText: /Return\s"Hello,\s"/ }))

    // The IL views do not override the decompiler's Write, so the row reads as in C#; following goes to the
    // instruction.
    await page.getByLabel('Decompiler language').selectOption('il')
    await expect(editor).toHaveAttribute('data-language-id', 'il')
    await expect(referrer).toHaveText(/^Holder\.Greet\(\[string\]\)\+IL_[0-9A-F]{4}$/)
    await followsTo(editor.locator('.view-line').filter({ hasText: /ldstr\s+"Hello,\s"/ }))
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

// dnSpy's tree hangs two folders under every type — the base type and interfaces it is built out of, and the
// types derived from it — and the rows inside them obey the rest of the tree's rules: a folder is a heading
// rather than a document, a base type row names the type the decompiler would write and wears its token, and
// a type no subtype can come from carries no expander on its Derived Types folder.
test.describe('the type hierarchy groups', () => {
  test.beforeEach(async () => { await launchApp(debugTargetPath) })
  test.afterEach(async () => { await closeApp() })

  /** The hierarchy folder belonging to a type row — the tree is a flat row list, so its own follow it. */
  const folderOf = (row: Locator, kind: 'basetypefolder' | 'derivedtypesfolder'): Locator =>
    row.locator(`xpath=following-sibling::div[@data-kind="${kind}"][1]`)

  test('lists a type\'s base types and the types derived from it', async () => {
    await openDebugTarget()
    const programRow = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^Program @02000002$/ })
    await programRow.locator('.tree-expander').click()

    // The two folders come first, under the type and above its members.
    await expect(page.locator('.tree-row[data-kind="basetypefolder"], .tree-row[data-kind="derivedtypesfolder"]'))
      .toHaveText(['Base Type and Interfaces', 'Derived Types'])

    // A static class is sealed, so nothing can be derived from it: dnSpy's quick check leaves that folder
    // without an expander, while the base types it is built from are still listed, one row per type.
    await expect(folderOf(programRow, 'derivedtypesfolder').locator('.tree-expander')).toBeDisabled()
    await folderOf(programRow, 'basetypefolder').locator('.tree-expander').click()
    await expect(page.locator('.tree-row[data-kind="basetype"]')).toHaveText([/^object @0[0-9A-F]{7}$/])

    // An interface is derived from by the class beside it: the row wears the derived type's name and its
    // token, and the interface's own folder takes an expander because a subtype could still be added.
    const workerInterface = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^IWorker @/ })
    await workerInterface.locator('.tree-expander').click()
    const derivedFolder = folderOf(workerInterface, 'derivedtypesfolder')
    await expect(derivedFolder.locator('.tree-expander')).toBeEnabled()
    await derivedFolder.locator('.tree-expander').click()
    await expect(page.locator('.tree-row[data-kind="derivedtype"]')).toHaveText([/^Worker @/])

    // The class names its interface among its base types, spelled the way the decompiler spells a nested
    // type, and the row wears the interface icon rather than the class one.
    const workerClass = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^Worker @/ })
    await workerClass.locator('.tree-expander').click()
    await folderOf(workerClass, 'basetypefolder').locator('.tree-expander').click()
    const implemented = page.locator('.tree-row[data-kind="basetype"]').filter({ hasText: 'Program.IWorker' })
    await expect(implemented).toHaveText([/^Program\.IWorker @[0-9A-F]{8}$/])
    await expect(implemented.locator('.tree-icon')).toHaveClass(/icon-interface/)
  })
})

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

    await expect(page.locator('.breakpoint-row')).toContainText('Program.Calculate(int left, int right) + 0x')
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
    // The debuggee's module only loads when the process starts, so the breakpoint was pending until then; bound, its
    // row wears the plain breakpoint image rather than a warning.
    await expect(page.locator('.breakpoint-row .breakpoint-image-BreakpointEnabled')).toHaveCount(1)

    // The frame's arguments and locals, named through the module's portable PDB and matched to ICorDebug slots by
    // index: the accumulator is 2 * 21 by the time the return statement is reached — written in hexadecimal,
    // which is how dnSpy's variables windows show a number until Hexadecimal Display is turned off.
    await page.getByRole('tab', { name: 'Locals' }).click()
    await expect(page.locator('.debug-variable-name')).toContainText(['left', 'right', 'sum', 'i'])
    await expect(page.locator('.debug-table-row').filter({ hasText: 'sum' })).toContainText('0x0000002A')

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
    await expect(page.locator('.breakpoint-row')).toContainText('Program.Calculate(int left, int right) + 0x')

    const toolbar = page.getByRole('toolbar', { name: 'Main toolbar' })
    await startDebugging()
    await expect(page.getByText('Stopped: breakpoint', { exact: true })).toBeVisible()

    // The frame stopped on the loop body, with the accumulator still 0 for this pass. The line the frame
    // reports is the decompiled document's, the same one the editor is showing.
    await page.getByRole('tab', { name: 'Call Stack' }).click()
    const frameRow = page.locator('.result-list[aria-label="Call Stack"] .stack-row').first()
    await expect(frameRow).toContainText('DebugTarget.dll!DebugTarget.Program.Calculate(int left, int right)')
    // The row has no location column — WPF's grid has none — so the line it reports is the tooltip's.
    await expect(frameRow).toHaveAttribute('title', 'DebugTarget.dll:10')
    await page.getByRole('tab', { name: 'Locals' }).click()
    const sumRow = page.locator('.debug-table-row').filter({ hasText: 'sum' })
    await expect(sumRow).toContainText('0x00000000')

    // A step over the body runs the add and stops on the loop header — where the next pass is decided —
    // and the accumulator has grown by the left operand.
    await toolbar.getByRole('button', { name: 'Step Over' }).click()
    await expect(page.getByText('Stopped: step', { exact: true })).toBeVisible()
    await expect(frameRow).toHaveAttribute('title', 'DebugTarget.dll:8')
    await expect(sumRow).toContainText('0x00000002')

    // The step after that is the body again: a loop runs its statements more than once, so a step that
    // only ever moved forwards would have left it.
    await toolbar.getByRole('button', { name: 'Step Over' }).click()
    await expect(frameRow).toHaveAttribute('title', 'DebugTarget.dll:10')
    await expect(sumRow).toContainText('0x00000002')

    // Stepping out of the body leaves the method rather than running the loop to its end: the stop is
    // reported in the caller, which is the frame the runtime steps back to.
    await page.getByRole('tab', { name: 'Call Stack' }).click()
    await page.getByRole('menuitem', { name: 'Debug' }).click()
    await page.getByRole('menuitem', { name: 'Step Out' }).click()
    await expect(page.getByText('Stopped: step', { exact: true })).toBeVisible()
    await expect(frameRow).toContainText('DebugTarget.dll!DebugTarget.Program.Main(string[] args)')
    // The step out lands right after the call, which is still the call's statement: dnSpy shows the statement the
    // instruction pointer is in.
    await expect(frameRow).toHaveAttribute('title', 'DebugTarget.dll:18')

    // What follows is the framework's own call — which has no decompilable source to walk into. A step into
    // finishes the call's statement, degrades to a step over there and stops on the caller's next statement;
    // the editor's marker stays on a statement of the debuggee. F11 is a global key, the code viewer included.
    await expect(toolbar.getByRole('button', { name: 'Step Into' })).toBeEnabled()
    await page.keyboard.press('F11')
    await expect(page.getByText('Stopped: step', { exact: true })).toBeVisible()
    await expect(frameRow).toContainText('DebugTarget.dll!DebugTarget.Program.Main(string[] args)')
    await expect(frameRow).toHaveAttribute('title', 'DebugTarget.dll:19')

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
    await expect(page.locator('.breakpoint-row')).toContainText('Program.Calculate(int left, int right) + 0x')

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
    for (let step = 0; step < 12 && !(await callLine.isVisible()); step++)
      await page.mouse.wheel(0, 120)
    await expect(callLine).toBeVisible()
    await showBreakpoints()
    const { lineBox, marginBox } = await editorLayout(callLine, editor.locator('.margin').first())
    await page.mouse.click(marginBox.x + 8, lineBox.y + lineBox.height / 2)
    await expect(page.locator('.breakpoint-row')).toContainText('Program.Main(string[] args) + 0x')

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
    await expect(page.locator('.breakpoint-row')).toContainText('Program.<AddAsync>d__3.MoveNext() + 0x')

    const toolbar = page.getByRole('toolbar', { name: 'Main toolbar' })
    await startDebugging()
    // The breakpoint is on the statement inside the state machine, so the stop is on its line.
    await expect(page.getByText('Stopped: breakpoint', { exact: true })).toBeVisible()

    await page.getByRole('tab', { name: 'Call Stack' }).click()
    const frameRow = page.locator('.result-list[aria-label="Call Stack"] .stack-row').first()
    await expect(frameRow).toContainText('DebugTarget.dll!DebugTarget.Program.AddAsync(int left, int right)')
    await expect(frameRow).toHaveAttribute('title', 'DebugTarget.dll:8')

    // The step over crosses the suspension and stops on the await's own line, in the method the user
    // wrote: the frame is a generated MoveNext, so walking its own instructions would stop somewhere in
    // the plumbing between the two statements instead.
    await toolbar.getByRole('button', { name: 'Step Over' }).click()
    await expect(page.getByText('Stopped: step', { exact: true })).toBeVisible()
    await expect(frameRow).toContainText('DebugTarget.dll!DebugTarget.Program.AddAsync(int left, int right)')
    await expect(frameRow).toHaveAttribute('title', 'DebugTarget.dll:9')

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
    // The caller's statement wears dnSpy's call return marker — the green one — rather than the current statement's
    // yellow, which belongs to the frame the thread is in. A statement decoration lands in Monaco's overlay layer (a
    // `cdr` div over the text), and only for the lines the viewport holds — so the reveal, which is what scrolls the
    // statement into view, is what makes it render at all.
    await expect(page.locator('.view-overlays .cdr.stmt-CallReturn-marker')).toHaveCount(1)
    await expect(page.locator('.view-overlays .cdr.debug-stopped-line')).toHaveCount(0)
    await page.getByRole('tab', { name: 'Locals' }).click()
    await expect(page.locator('.debug-table-row').filter({ hasText: 'args' })).toBeVisible()

    await toolbar.getByRole('button', { name: 'Stop' }).click()
    await expect(toolbar.getByRole('button', { name: 'Debug a Program' })).toBeEnabled()
  })

  /** Opens one of the debugger's windows from Debug → Window, which lists them only while a session runs. */
  const showDebugWindow = async (name: RegExp): Promise<void> => {
    await page.getByRole('menuitem', { name: 'Debug', exact: true }).click()
    const windows = page.getByRole('menuitem', { name: 'Window', exact: true })
    await windows.hover()
    await expect(windows).toHaveAttribute('aria-expanded', 'true')
    await page.getByRole('menuitem', { name }).click()
  }

  // The fixture's --evaluate run stops on a Debugger.Break() with one value of each kind in scope: the variables
  // windows read them through the expression evaluator, and the native windows read the frame's code.
  test('evaluates the stopped frame in the variables windows and shows its native views', async () => {
    await openDebugTarget()
    await page.getByRole('toolbar', { name: 'Main toolbar' }).getByRole('button', { name: 'Debug a Program' }).click()
    const dialog = page.getByRole('dialog', { name: 'Debug Program' })
    await dialog.getByLabel('Arguments', { exact: true }).fill('--evaluate')
    await dialog.getByRole('button', { name: 'OK' }).click()
    await expect(page.getByText('Stopped: user-break', { exact: true })).toBeVisible()

    // The frame the break was called from, written the way dnSpy's stack frame formatter writes it.
    await page.getByRole('tab', { name: 'Call Stack' }).click()
    const frame = page.locator('.result-list[aria-label="Call Stack"] .stack-row').filter({ hasText: 'DebugTarget.Program.Evaluate(int factor)' })
    await expect(frame).toHaveCount(1)
    await frame.dblclick()
    await expect(frame).toHaveAttribute('aria-current', 'true')

    // An object reads as its DebuggerDisplay — whose holes are formatted like any other value, in hexadecimal —
    // and expands into its members.
    await page.getByRole('tab', { name: 'Locals' }).click()
    const locals = page.getByRole('treegrid', { name: 'Locals' })
    const shapeRow = locals.getByRole('row').filter({ hasText: /^shape/ })
    await expect(shapeRow).toContainText('Shape "square" with 0x00000004 sides')
    await shapeRow.getByRole('button', { name: 'Expand shape' }).click()
    await expect(locals.getByRole('row').filter({ hasText: /^Sides/ })).toContainText('0x00000004')

    // A value is edited in place and written into the process.
    const factorRow = locals.getByRole('row').filter({ hasText: /^factor/ })
    await expect(factorRow).toContainText('0x00000002')
    await factorRow.getByText('0x00000002').dblclick()
    const editor = locals.getByRole('textbox', { name: 'Value' })
    await editor.fill('5')
    await editor.press('Enter')
    await expect(factorRow).toContainText('0x00000005')

    // A watch runs a property getter in the debuggee.
    await page.getByRole('tab', { name: 'Watch 1' }).click()
    const watch = page.getByRole('treegrid', { name: 'Watch' })
    await watch.getByRole('button', { name: 'Add watch' }).click()
    const expression = watch.getByRole('textbox', { name: 'Watch expression' })
    await expression.fill('shape.Area')
    await expression.press('Enter')
    await expect(watch.getByRole('row').filter({ hasText: /^shape\.Area/ })).toContainText('0x00000010')

    // Autos lists what the statements around the break wrote.
    await showDebugWindow(/^Autos/)
    await expect(page.getByRole('treegrid', { name: 'Autos' }).getByRole('row').filter({ hasText: /^grid/ })).toBeVisible()

    // The jitted method, in a document tab of its own the way dnSpy's Disassembly tab is: the native code in the
    // Disassembler options' dialect.
    await showDebugWindow(/^Disassembly/)
    const disassembly = page.getByRole('document', { name: 'Disassembly' })
    await expect(disassembly.locator('.view-line').first()).toBeVisible()
    await expect(disassembly.locator('.view-lines')).toContainText(/\b(push|mov|sub|stp|ldr)\b/)

    // The thread that hit the break is the program's main thread.
    await showDebugWindow(/^Threads/)
    await expect(page.getByRole('grid', { name: 'Threads' }).getByRole('row').filter({ hasText: 'Main' }).first()).toBeVisible()

    // The watch was the user's own; it goes with the session the test leaves.
    await page.getByRole('tab', { name: 'Watch 1' }).click()
    await watch.getByRole('row').filter({ hasText: /^shape\.Area/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^Clear All/ }).click()
    await page.getByRole('toolbar', { name: 'Main toolbar' }).getByRole('button', { name: 'Stop' }).click()
    await expect(page.getByRole('toolbar', { name: 'Main toolbar' }).getByRole('button', { name: 'Debug a Program' })).toBeEnabled()
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
    await focusEditor(editor)
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
    expect(index('Edit IL Instructions...')).toBeGreaterThan(index('Edit Method Body...'))
    expect(index('Copy MD Token')).toBeGreaterThan(index('Edit IL Instructions...'))
    expect(index('Copy Full Name')).toBeGreaterThan(index('Copy MD Token'))
    // A code document is open in front of this menu, so the hex editor is one command away from it: the
    // file the command opens is this document's, and the caret's own statement follows it inside the group.
    expect(index('Open Hex Editor')).toBeGreaterThan(index('Copy Full Name'))
    expect(index('Show Instructions in Hex Editor')).toBeGreaterThan(index('Open Hex Editor'))
    expect(index('Analyze')).toBeGreaterThan(index('Show Instructions in Hex Editor'))
    expect(index('Find')).toBeGreaterThan(index('Analyze'))
    // Nothing this port cannot run is on screen, and neither the bookmark group nor Select All is in it.
    // The token group goes to the module's entry point and its <Module> constructor — DebugTarget has a module
    // initializer — and to a token, before its copies.
    expect(index('Go to Entry Point')).toBeGreaterThan(index('Edit IL Instructions...'))
    expect(index('Go to Global Cctor')).toBeGreaterThan(index('Go to Entry Point'))
    expect(index('Go to Token...')).toBeGreaterThan(index('Go to Global Cctor'))
    expect(index('Copy MD Token')).toBeGreaterThan(index('Go to Token...'))
    for (const absent of ['Set Next Statement', 'Add Class Breakpoint', 'Break When Exception Thrown', 'Go to Resource', 'Select All', 'Bookmark'])
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
    // DecompileFullType is on, as it is in dnSpy: a followed member is shown in the whole type it is in.
    const targetTab = page.getByRole('tab', { name: 'Program', exact: true })
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

  test('still opens on a line of the IL view that names no member', async () => {
    // The IL view's spans are its definitions and its statements are its instructions, which only the
    // bookmarks, the hex commands and the analyzer read — the breakpoints are placed by the C# map alone. A
    // caret on `.maxstack` therefore resolves to no member and no breakpoint: the commands that read the
    // document's own node stay, and the menu is what opens rather than nothing.
    await openMain()
    await page.getByLabel('Decompiler language').selectOption('il')
    const editor = page.locator('.monaco-editor')
    await expect.poll(async () => editor.locator('.view-lines').innerText()).toContain('.method')
    // dnSpy's disassembler writes token comments and the header over several lines, so the line is found by its text.
    await editor.locator('.view-lines .view-line').filter({ hasText: /\.maxstack/ }).first().click({ button: 'right' })

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

  test('keeps the caret on what it was right-clicked on, and analyzes a member the tree has not listed', async () => {
    await openMain()
    const editor = page.locator('.monaco-editor').filter({ visible: true })
    await focusEditor(editor)
    await page.keyboard.press('Control+End')
    // `new Worker()` names the constructor of a nested type nothing has expanded, so the tree holds no row for
    // it: the menu has to ask for the node the reference names rather than find it among the loaded ones.
    await expect(page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^Worker @/ })).toHaveAttribute('aria-expanded', 'false')
    const worker = editor.locator('.view-lines').getByText('Worker', { exact: true }).first()
    await expect(worker).toBeVisible()
    await worker.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Code editor' })
    await expect(menu).toBeVisible()

    // The menu has the focus, which is what Monaco hides an editor's caret for. dnSpy keeps it drawn, on the
    // reference the menu is about.
    const caret = editor.locator('.cursors-layer > .cursor')
    await expect(caret).toHaveCSS('visibility', 'visible')
    const caretBox = await caret.boundingBox()
    const workerBox = await worker.boundingBox()
    expect(caretBox?.x).toBeGreaterThanOrEqual((workerBox?.x ?? 0) - 1)
    expect(caretBox?.x).toBeLessThanOrEqual((workerBox?.x ?? 0) + (workerBox?.width ?? 0) + 1)

    await menu.getByRole('menuitem', { name: 'Analyze' }).click()
    await expect(page.getByRole('tab', { name: 'Analyzer' })).toHaveAttribute('aria-selected', 'true')
    // dnSpy's analyzer gains one row, for the constructor the reference names, and takes the focus with it.
    const analyzer = page.getByRole('tree', { name: 'Analyzer' })
    const roots = analyzer.locator('.tree-row[aria-level="1"]')
    await expect(roots).toHaveText([/^DebugTarget\.Program\.Worker\.Worker\(\) : void @06[0-9A-F]{6}$/])
    await expect(roots.first()).toHaveAttribute('aria-selected', 'true')
    await expect(roots.first()).toBeFocused()
  })

  test('opens an analyzed member onto its searches and goes to where a result uses it', async () => {
    await openMain()
    const editor = page.locator('.monaco-editor').filter({ visible: true })
    // Main's body is taller than the viewport, and Monaco draws only the lines it shows.
    await focusEditor(editor)
    await page.keyboard.press('Control+End')
    // Main's first `new Worker()`, the one ViaInterface is handed: the constructor's first use.
    const line = editor.locator('.view-line').filter({ hasText: /ViaInterface\(new\sWorker\(\)\)/ })
    const worker = line.getByText('Worker', { exact: true })
    await expect(worker).toBeVisible()
    await worker.click({ button: 'right' })
    await page.getByRole('menu', { name: 'Code editor' }).getByRole('menuitem', { name: 'Analyze' }).click()

    const analyzer = page.getByRole('tree', { name: 'Analyzer' })
    const root = analyzer.locator('.tree-row[aria-level="1"]')
    await expect(root).toHaveCount(1)
    // The searches dnSpy offers a constructor, sorted by their text.
    await expect(analyzer.locator('.tree-row[aria-level="2"]')).toHaveText(['Used By', 'Uses'])

    // A search runs when its row is opened; Main constructs the Worker twice, and is listed once.
    await analyzer.locator('.tree-row[aria-level="2"]').filter({ hasText: 'Used By' }).locator('.tree-expander').click()
    const caller = analyzer.locator('.tree-row[aria-level="3"]').filter({ hasText: /^DebugTarget\.Program\.Main\(string\[\]\) : void @06[0-9A-F]{6}$/ })
    await expect(caller).toHaveCount(1)

    // Away from the reference, so that landing back on it is the double click's doing.
    await focusEditor(editor)
    await page.keyboard.press('Control+Home')
    await caller.dblclick()
    // DecompileFullType: the method that uses the member is shown in the whole type it is declared in.
    await expect(page.getByRole('tab', { name: 'Program', exact: true })).toHaveAttribute('aria-selected', 'true')
    const caret = editor.locator('.cursors-layer > .cursor')
    await expect.poll(async () => {
      const caretBox = await caret.boundingBox()
      const workerBox = await worker.boundingBox()
      if (!caretBox || !workerBox)
        return false
      // dnSpy puts the caret at the start of the reference, and Monaco draws it a pixel or so to the left.
      const caretMiddle = caretBox.y + caretBox.height / 2
      return Math.abs(caretBox.x - workerBox.x) <= 2 && caretMiddle >= workerBox.y && caretMiddle <= workerBox.y + workerBox.height
    }).toBe(true)

    // Analyzing the member again goes back to its row rather than adding a second one.
    await worker.click({ button: 'right' })
    await page.getByRole('menu', { name: 'Code editor' }).getByRole('menuitem', { name: 'Analyze' }).click()
    await expect(root).toHaveCount(1)
    await expect(root).toBeFocused()

    // Delete takes an analyzed member off the window.
    await page.keyboard.press('Delete')
    await expect(root).toHaveCount(0)

    // And Ctrl+Shift+R analyzes the member selected in the assembly tree.
    const mainRow = page.getByRole('tree', { name: 'Assembly Explorer' }).locator('.tree-row[data-kind="method"]').filter({ hasText: /^Main\(/ })
    await mainRow.click()
    await page.keyboard.press('Control+Shift+R')
    await expect(root).toHaveText([/^DebugTarget\.Program\.Main\(string\[\]\) : void @06[0-9A-F]{6}$/])
  })

  /** A context menu's entry labels in the order it lays them out, without the shortcuts beside them. */
  const entryLabels = async (menu: Locator): Promise<string[]> =>
    menu.getByRole('menuitem').locator('.document-tab-menu-label').allTextContents()

  test('lays the analyzer menu out in dnSpy group and order, and its options rewrite every row', async () => {
    await openMain()
    const mainRow = page.getByRole('tree', { name: 'Assembly Explorer' }).locator('.tree-row[data-kind="method"]').filter({ hasText: /^Main\(/ })
    await mainRow.click()
    await page.keyboard.press('Control+Shift+R')
    const analyzer = page.getByRole('tree', { name: 'Analyzer' })
    const root = analyzer.locator('.tree-row[aria-level="1"]')
    await expect(root).toHaveText([/^DebugTarget\.Program\.Main\(string\[\]\) : void @06[0-9A-F]{6}$/])
    // The row is written in dnSpy's colors: the namespace gold, the static class and method in their own
    // shades, the keywords blue, the token's digits a number's.
    await expect(root.locator('.tc-namespace')).toHaveText('DebugTarget')
    await expect(root.locator('.tc-namespace')).toHaveCSS('color', 'rgb(255, 215, 0)')
    await expect(root.locator('.tc-staticType')).toHaveText('Program')
    await expect(root.locator('.tc-staticMethod')).toHaveText('Main')
    await expect(root.locator('.tc-keyword')).toHaveText(['string', 'void'])
    await expect(root.locator('.tc-keyword').first()).toHaveCSS('color', 'rgb(86, 156, 214)')

    await root.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Analyzer' })
    await expect(menu).toBeVisible()
    // The member's own commands, the debugger's group, Remove for a root — which is already analyzed — and
    // the window's options. Main is private, so there is no MSDN page to look for.
    expect(await entryLabels(menu)).toEqual([
      'Go to Reference', 'Go to Reference (New Tab)',
      'Copy', 'Copy MD Token', 'Copy Full Name',
      'Add Method Breakpoint',
      'Remove',
      'Show Tokens', 'Syntax Highlight', 'Single-click expands nodes',
    ])

    await menu.getByRole('menuitem', { name: 'Show Tokens' }).click()
    await expect(root).toHaveText([/^DebugTarget\.Program\.Main\(string\[\]\) : void$/])
    await root.click({ button: 'right' })
    await page.getByRole('menu', { name: 'Analyzer' }).getByRole('menuitem', { name: 'Syntax Highlight' }).click()
    await expect(root.locator('.tc-namespace')).toHaveCount(0)
    await expect(root).toHaveText([/^DebugTarget\.Program\.Main\(string\[\]\) : void$/])

    // The debugger's group breaks on the row's method, named the way the Breakpoints window names one.
    await root.click({ button: 'right' })
    await page.getByRole('menu', { name: 'Analyzer' }).getByRole('menuitem', { name: 'Add Method Breakpoint' }).click()
    await showBreakpoints()
    await expect(page.locator('.breakpoint-row').filter({ hasText: 'Program.Main(string[] args) + 0x0000' })).toHaveCount(1)
  })

  test('analyzes the reference under the caret with Ctrl+Shift+R', async () => {
    await openMain()
    const editor = page.locator('.monaco-editor').filter({ visible: true })
    await focusEditor(editor)
    await page.keyboard.press('Control+End')
    const call = editor.locator('.view-lines').getByText('ThrowAndCatch', { exact: true }).first()
    await expect(call).toBeVisible()
    // A right click puts the caret on the call — a left one would follow it, as dnSpy's does — and the
    // editor's own binding analyzes what the caret is on.
    await call.click({ button: 'right' })
    // The menu is put up once what it acts on has been read, and takes the keyboard after that; the Escape has to
    // reach it, not come before it.
    await expect(page.getByRole('menu', { name: 'Code editor' })).toBeVisible()
    await expect.poll(async () => await page.evaluate(() => document.activeElement?.closest('[role="menu"]') !== null)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu', { name: 'Code editor' })).not.toBeVisible()
    await page.keyboard.press('Control+Shift+R')
    await expect(page.getByRole('tab', { name: 'Analyzer' })).toHaveAttribute('aria-selected', 'true')
    const roots = page.getByRole('tree', { name: 'Analyzer' }).locator('.tree-row[aria-level="1"]')
    await expect(roots).toHaveText([/^DebugTarget\.Program\.ThrowAndCatch\(\) : void @06[0-9A-F]{6}$/])
    await expect(roots.first()).toBeFocused()
  })

  test('writes the analyzer in the language the toolbar picks, and shows a use in IL on the instruction\'s operand', async () => {
    await openMain()
    const editor = page.locator('.monaco-editor').filter({ visible: true })
    await expect(editor).toHaveAttribute('data-language-id', 'csharp')
    const explorer = page.getByRole('tree', { name: 'Assembly Explorer' })
    const calculateRow = explorer.locator('.tree-row[data-kind="method"]').filter({ hasText: /^Calculate\(/ })
    await calculateRow.click()
    await page.keyboard.press('Control+Shift+R')
    const analyzer = page.getByRole('tree', { name: 'Analyzer' })
    const root = analyzer.locator('.tree-row[aria-level="1"]')
    await expect(root).toHaveText([/^DebugTarget\.Program\.Calculate\(int, int\) : int @06[0-9A-F]{6}$/])

    // dnSpy's language box is the one decompiler of the whole window: the open tab is decompiled again in it,
    // and every analyzer row is written anew through it.
    await page.getByLabel('Decompiler language').selectOption('visualBasic')
    await expect(root).toHaveText([/^DebugTarget\.Program\.Calculate\(Integer, Integer\) : Integer @06[0-9A-F]{6}$/])
    await expect(editor).toHaveAttribute('data-language-id', 'vb')
    await page.getByLabel('Decompiler language').selectOption('il')
    await expect(root).toHaveText([/^DebugTarget\.Program\.Calculate\(int32, int32\) : int32 @06[0-9A-F]{6}$/])
    await expect(editor).toHaveAttribute('data-language-id', 'il')

    // A result found in a body goes to the instruction, with the caret on the member it names.
    await analyzer.locator('.tree-row[aria-level="2"]').filter({ hasText: 'Used By' }).locator('.tree-expander').click()
    const caller = analyzer.locator('.tree-row[aria-level="3"]').filter({ hasText: /^DebugTarget\.Program\.Main\(string\[\]\) : void @06[0-9A-F]{6}$/ })
    await expect(caller).toHaveCount(1)
    await focusEditor(editor)
    await page.keyboard.press('Control+Home')
    await caller.dblclick()
    const call = editor.locator('.view-line').filter({ hasText: /call\s+int32\sDebugTarget\.Program::Calculate\(/ })
    const operand = call.locator('.code-reference').filter({ hasText: /^Calculate$/ })
    await expect(operand).toBeVisible()
    const caret = editor.locator('.cursors-layer > .cursor')
    await expect.poll(async () => {
      const caretBox = await caret.boundingBox()
      const operandBox = await operand.boundingBox()
      if (!caretBox || !operandBox)
        return false
      const caretMiddle = caretBox.y + caretBox.height / 2
      return Math.abs(caretBox.x - operandBox.x) <= 2 && caretMiddle >= operandBox.y && caretMiddle <= operandBox.y + operandBox.height
    }).toBe(true)

    // Analyze over a selection of the tree adds a root for each member in it.
    const mainRow = explorer.locator('.tree-row[data-kind="method"]').filter({ hasText: /^Main\(/ })
    await mainRow.click()
    await calculateRow.click({ modifiers: ['Control'] })
    await calculateRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^Analyze/ }).click()
    await expect(root).toHaveText([/^DebugTarget\.Program\.Calculate\(int32, int32\) : int32 /, /^DebugTarget\.Program\.Main\(string\[\]\) : void /])
    await page.getByLabel('Decompiler language').selectOption('cSharp')
    await expect(root).toHaveText([/^DebugTarget\.Program\.Calculate\(int, int\) : int /, /^DebugTarget\.Program\.Main\(string\[\]\) : void /])
  })

  test('words and sorts the searches in the language the window is in', async () => {
    await openMain()
    const worker = page.getByRole('tree', { name: 'Assembly Explorer' }).locator('.tree-row[data-kind="type"]').filter({ hasText: /^Worker @/ })
    await worker.click()
    await page.keyboard.press('Control+Shift+R')
    const searches = page.getByRole('tree', { name: 'Analyzer' }).locator('.tree-row[aria-level="2"]')
    // A sealed class has no subtypes and is no attribute; the four searches it has sort by their text.
    await expect(searches).toHaveText(['Exposed By', 'Extension Methods', 'Instantiated By', 'Used By'])

    await page.getByRole('menuitem', { name: 'View' }).click()
    await page.getByRole('menuitem', { name: 'Language' }).hover()
    await page.getByRole('menuitem', { name: '中文（中国）' }).click()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
    // The same rows in dnSpy's Chinese wording, sorted again — by code unit, the way dnSpy's
    // OrdinalIgnoreCase does, so 实 (U+5B9E) comes before 扩 (U+6269) and both before 被 (U+88AB).
    const chinese = page.getByRole('tree', { name: '分析器' }).locator('.tree-row[aria-level="2"]')
    await expect(chinese).toHaveText(['实例化于', '扩展方法', '被使用', '被公开于'])
  })

  test('leaves the selection a right-click lands in, so Copy has it to copy', async () => {
    await openMain()
    const editor = page.locator('.monaco-editor').filter({ visible: true })
    await focusEditor(editor)
    await page.keyboard.press('Control+End')
    const call = editor.locator('.view-lines').getByText('ThrowAndCatch', { exact: true }).first()
    await call.dblclick()
    await call.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Code editor' })
    // The entry's name carries its shortcut, which is what keeps it apart from "Copy MD Token" and the rest.
    await menu.getByRole('menuitem', { name: /^Copy Ctrl\+C$/ }).click()
    await expect.poll(() => application.evaluate(({ clipboard }) => clipboard.readText())).toBe('ThrowAndCatch')

    // A right-click outside the selection moves the caret there, which is what drops the selection.
    await editor.locator('.view-lines').getByText('ThrowUnhandled', { exact: true }).first().click({ button: 'right' })
    await expect(menu).toBeVisible()
    expect(await menuLabels(menu)).not.toContain('Copy')
    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
  })

  test('leaves the margins\' breakpoints and bookmarks to the left button', async () => {
    await openMain()
    const editor = page.locator('.monaco-editor').filter({ visible: true })
    // Main's last statement, which is still in the viewport once the document is scrolled to its end.
    await focusEditor(editor)
    await page.keyboard.press('Control+End')
    const statementLine = editor.locator('.view-lines .view-line').filter({ hasText: /^\s*ThrowAndCatch\(\);/ }).first()
    const { lineBox, marginBox } = await editorLayout(statementLine, editor.locator('.margin').first())
    const y = lineBox.y + lineBox.height / 2
    // A menu takes the keyboard once it is up — its first item has the focus — and only then is the Escape its own.
    const menuHasFocus = async (): Promise<boolean> => await page.evaluate(() => document.activeElement?.closest('[role="menu"]') !== null)
    // The glyph margin is the strip next to the line numbers on the left. Its right button is dnSpy's glyph margin
    // menu, which only has the commands of a breakpoint there: on an empty line nothing comes up and nothing changes.
    const glyphX = marginBox.x + 8
    const breakpoints = editor.locator('.breakpoint-glyph')
    await page.mouse.click(glyphX, y, { button: 'right' })
    await expect(page.getByRole('menu', { name: 'Breakpoint' })).toHaveCount(0)
    await expect(breakpoints).toHaveCount(0)
    await page.mouse.click(glyphX, y)
    await expect(breakpoints).toHaveCount(1)
    const glyphMenu = page.getByRole('menu', { name: 'Breakpoint' })
    await page.mouse.click(glyphX, y, { button: 'right' })
    await expect(glyphMenu).toBeVisible()
    expect(await menuLabels(glyphMenu)).toEqual(['Delete Breakpoint', 'Disable Breakpoint', 'Settings...', 'Export...'])
    await expect.poll(menuHasFocus).toBe(true)
    await page.keyboard.press('Escape')
    await expect(glyphMenu).not.toBeVisible()
    await expect(breakpoints).toHaveCount(1)
    await page.mouse.click(glyphX, y)
    await expect(breakpoints).toHaveCount(0)

    // The bookmark strip, on the right of the line numbers, has the code viewer's menu and toggles with the left one.
    const bookmarkX = marginBox.x + marginBox.width - 7
    const bookmarks = editor.locator('.bookmark-glyph, .bookmark-glyph-disabled')
    await page.mouse.click(bookmarkX, y, { button: 'right' })
    const menu = page.getByRole('menu', { name: 'Code editor' })
    await expect.poll(menuHasFocus).toBe(true)
    await page.keyboard.press('Escape')
    await expect(menu).not.toBeVisible()
    await expect(bookmarks).toHaveCount(0)
    await page.mouse.click(bookmarkX, y)
    await expect(bookmarks).toHaveCount(1)
    await page.mouse.click(bookmarkX, y)
    await expect(bookmarks).toHaveCount(0)
  })

  // dnSpy's DocumentViewerHighlightReferencesTagger and MoveToNextReference: with the caret on a local, every use
  // of it is marked — its declaration and the writes in colors of their own — and Tab walks from one to the next.
  test('marks every use of what the caret is on, and walks them with Tab', async () => {
    await openMain()
    const editor = page.locator('.monaco-editor').filter({ visible: true })
    const local = editor.locator('.view-lines .code-local').filter({ hasText: /^args$/ }).first()
    await expect(local).toBeVisible()
    // A plain click on a local only places the caret: dnSpy follows a local with Ctrl, F12 or Enter.
    await local.click()
    await expect(editor.locator('.highlighted-definition, .highlighted-reference, .highlighted-written-reference')).not.toHaveCount(0)
    await page.keyboard.press('Tab')
    await expect(editor.locator('.selected-text')).not.toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(editor.locator('.highlighted-definition, .highlighted-reference, .highlighted-written-reference')).toHaveCount(0)
  })

  // dnSpy's DocumentViewerMouseProcessor: a plain click on a member reference follows it in the same tab —
  // DecompileFullType showing the whole type, with the member's name selected where it is defined — and the
  // tab's own history takes it back.
  test('follows a clicked reference in its own tab and goes back with Alt+Left', async () => {
    await openMain()
    const editor = page.locator('.monaco-editor').filter({ visible: true })
    await focusEditor(editor)
    await page.keyboard.press('Control+End')
    const call = editor.locator('.view-lines').getByText('ThrowAndCatch', { exact: true }).first()
    await expect(call).toBeVisible()
    await call.click()
    await expect(page.getByRole('tab', { name: 'Program', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tab', { name: 'Main(string[]) : void' })).toHaveCount(0)
    const selected = editor.locator('.selected-text')
    await expect(selected).not.toHaveCount(0)
    await expect(editor.locator('.view-line').filter({ has: page.locator('.code-definition', { hasText: /^ThrowAndCatch$/ }) })).toBeVisible()
    await page.keyboard.press('Alt+ArrowLeft')
    await expect(page.getByRole('tab', { name: 'Main(string[]) : void' })).toHaveAttribute('aria-selected', 'true')
    // Ctrl+click goes to a tab of its own instead.
    await page.keyboard.press('Control+End')
    await page.keyboard.down('Control')
    await editor.locator('.view-lines').getByText('ThrowAndCatch', { exact: true }).first().click()
    await page.keyboard.up('Control')
    await expect(page.getByRole('tab', { name: 'Program', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tab', { name: 'Main(string[]) : void' })).toHaveCount(1)
  })

  // dnSpy's tooltips: Quick Info for a member, written the way the document's language writes it, and a number
  // in the four bases.
  test('shows Quick Info over a reference and a number\'s bases over a literal', async () => {
    await openMain()
    const editor = page.locator('.monaco-editor').filter({ visible: true })
    const main = editor.locator('.view-lines .code-definition').filter({ hasText: /^Main$/ }).first()
    await expect(main).toBeVisible()
    await main.hover()
    await expect(page.locator('.monaco-hover').filter({ visible: true })).toContainText('void DebugTarget.Program.Main(string[] args)')
    await editor.locator('.view-lines').getByText('100', { exact: true }).first().hover()
    await expect(page.locator('.monaco-hover').filter({ visible: true })).toContainText('Base 16: 64')
  })

  // dnSpy's Go to Line (Ctrl+G), its zoom box, its block structure lines and its procedure line separators.
  test('goes to a line, zooms its text and draws its blocks and separators', async () => {
    await openMain()
    const editor = page.locator('.monaco-editor').filter({ visible: true })
    await expect(editor.locator('.block-structure-line')).not.toHaveCount(0)
    // The separator is under the method's closing brace, which is drawn once the view is at the end.
    await focusEditor(editor)
    await page.keyboard.press('Control+End')
    await expect(editor.locator('.line-separator')).not.toHaveCount(0)

    await page.keyboard.press('Control+g')
    const dialog = page.getByRole('dialog', { name: 'Go to Line' })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Line [, column]').fill('9999')
    await expect(dialog.locator('.modal-error')).toHaveText('Invalid line: 9999')
    await expect(dialog.getByRole('button', { name: 'OK' })).toBeDisabled()
    await dialog.getByLabel('Line [, column]').fill('5')
    await dialog.getByRole('button', { name: 'OK' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(editor.locator('.line-numbers.active-line-number')).toHaveText('5')

    const fontSize = async (): Promise<number> => Number.parseFloat(await editor.locator('.view-lines').evaluate((element) => getComputedStyle(element).fontSize))
    const before = await fontSize()
    const zoom = page.getByLabel('Zoom')
    await zoom.fill('150')
    await zoom.press('Enter')
    await expect(zoom).toHaveValue('150 %')
    await expect.poll(fontSize).toBeCloseTo(before * 1.5, 0)
    await focusEditor(editor)
    await page.keyboard.press('Control+0')
    await expect(zoom).toHaveValue('100 %')

    // dnSpy's Incremental Search: what is typed after Ctrl+I is looked for as it is typed, and Esc ends it.
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('Control+i')
    const status = page.locator('.document-incremental-search')
    await expect(status).toHaveText('Incremental Search: ')
    await page.keyboard.type('readY')
    await expect(status).toHaveText('Incremental Search: readY')
    await expect(editor.locator('.selected-text')).not.toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(status).toHaveCount(0)
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
    // Go to Entry Point is dnSpy's FollowReference: with DecompileFullType on, the tab shows the type Main is
    // declared in, and the tree reveals and selects that type's row — the chain above it opened on the way.
    await expect(page.getByRole('tab', { name: 'Program', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^Program @02000002$/ })).toHaveAttribute('aria-selected', 'true')
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
    await menu.getByRole('menuitem', { name: /^Raw Save / }).click()

    // Raw Save writes the bytes the manifest resource holds: a .resources stream opens with its magic.
    // (Save writes what its entries decode to instead — dnSpy's deserialized save of a resource set.)
    await expect.poll(() => existsSync(saveResourcePath) ? readFileSync(saveResourcePath).subarray(0, 4).toString('hex') : '').toBe('cecaefbe')
  })

  // dnSpy's ResourceElementSetNodeImpl puts a Save button under the line of a .resources file in its document,
  // which saves the way the tree's Save command does: what the entries decode to — here one BAML entry, as XAML.
  test('saves a resource from the Save button in its document', async () => {
    await page.getByRole('button', { name: 'Open Assembly' }).first().click()
    await expect(page.getByRole('treeitem').first()).toContainText('BamlTarget')
    await expandModule()
    await expandRow(page.locator('.tree-row[data-kind="resourcesgroup"]').first())
    const generated = page.locator('.tree-row[data-kind="resource"]').filter({ hasText: /\.g\.resources$/ })
    await generated.dblclick()

    const editor = page.locator('.monaco-editor')
    await expect.poll(async () => (await editor.locator('.view-lines').innerText()).replaceAll('\u00a0', ' ')).toMatch(/\.g\.resources \(\d+ bytes, Embedded, Public\)/)
    const save = editor.locator('.document-attachment-frame .document-attachment-button')
    await expect(save).toHaveText('Save')
    await save.click()
    await expect.poll(() => existsSync(saveResourcePath) ? readFileSync(saveResourcePath, 'utf8') : '').toContain('UserControl')
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
      // NodeDecompiler.Decompile(UnknownDocumentNode) writes the file's full path.
      .toContain(`// ${unknownFilePath}`)
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

    // The tab is up the moment the document starts to decompile; the session is written a moment later.
    await expect.poll(async () => (await storedSession())?.documents.length).toBe(1)
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
    const rpcException = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^RpcException @0200008D$/ })
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
    await expect(page.locator('.breakpoint-row')).toContainText('RpcException.RpcException(int code, string message, [object data], [Exception innerException]) + 0x')

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
    // The row is there before anything is decompiled: the method and the IL offset it was saved with are what the
    // pane names it by, as dnSpy's Breakpoints window does.
    const breakpointRows = page.locator('.breakpoint-row')
    await expect(breakpointRows).toHaveCount(2)
    await expect(breakpointRows.first()).toContainText('RpcException.RpcException(int code, string message, [object data], [Exception innerException]) + 0x')
    await expect(breakpointRows.nth(1)).toContainText('dnSpy.Backend.Contracts.RpcException.get_Code')

    // The session restores the document, and the restored breakpoint attaches to it by IL identity —
    // which is what puts the glyph back in the gutter without the user clicking anything.
    const browserWindow = await application.browserWindow(page)
    await browserWindow.evaluate((window) => window.setSize(1500, 700))
    await expect(page.getByRole('tab', { name: 'RpcException' })).toBeVisible()
    await expect(page.locator('.breakpoint-glyph')).toHaveCount(1)

    // Removing it is what a restored breakpoint has to support too, and it leaves the storage empty.
    await breakpointRows.first().click()
    await page.getByRole('button', { name: 'Remove breakpoint', exact: true }).click()
    await expect(page.locator('.breakpoint-glyph')).toHaveCount(0)
    await expect.poll(async () => (await storedBreakpoints())?.breakpoints.length).toBe(0)

    await closeApp()
  })
})

// dnSpy's document tabs: the tree's top-level selection decompiles into the tab in front as one document, a group
// folder writes what it holds, and a document that takes a while shows the wait adorner, whose Cancel calls the
// decompilation off and leaves "The operation was canceled" in the tab.
test.describe('the document a tab decompiles', () => {
  test.afterEach(async () => { await closeApp() })

  const openContractsNamespace = async (): Promise<void> => {
    await page.getByRole('button', { name: 'Open Assembly' }).first().click()
    await expect(page.getByRole('treeitem').first()).toContainText('dnSpy.Backend.Contracts')
    await expandModule()
    await expandRow(page.locator('.tree-row[data-kind="namespace"]').filter({ hasText: /^dnSpy\.Backend\.Contracts$/ }))
  }

  test('shows a selection of several rows as one document titled after all of them', async () => {
    await launchApp(contractsAssemblyPath)
    await openContractsNamespace()
    const request = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^HelloRequest @/ })
    const response = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^HelloResponse @/ })
    await request.click()
    await expect(page.getByRole('tab', { name: 'HelloRequest', exact: true })).toHaveAttribute('aria-selected', 'true')
    await response.click({ modifiers: ['Control'] })
    const both = page.getByRole('tab', { name: 'HelloRequest, HelloResponse', exact: true })
    await expect(both).toHaveAttribute('aria-selected', 'true')
    await expect(request).toHaveAttribute('aria-selected', 'true')
    await expect(response).toHaveAttribute('aria-selected', 'true')
    const text = async (): Promise<string> => (await page.locator('.monaco-editor .view-lines').innerText()).replaceAll(' ', ' ')
    await expect.poll(text).toContain('HelloRequest')
    await expect.poll(text).toContain('HelloResponse')

    // The tab's history keeps the single document it showed before.
    await page.keyboard.press('Alt+ArrowLeft')
    await expect(page.getByRole('tab', { name: 'HelloRequest', exact: true })).toHaveAttribute('aria-selected', 'true')
  })

  test('opens the References folder as a document of its rows', async () => {
    await launchApp(contractsAssemblyPath)
    await page.getByRole('button', { name: 'Open Assembly' }).first().click()
    await expandModule()
    const folder = page.locator('.tree-row[data-kind="referencesgroup"]')
    await folder.click()
    await expect.poll(async () => (await page.locator('.monaco-editor .view-lines').innerText()).replaceAll(' ', ' '))
      .toMatch(/\/\/ System\.Runtime, Version=/)
  })

  test('cancels a decompilation from the wait adorner', async () => {
    // The workspace manager of the backend's own core assembly is big enough that decompiling it takes a while.
    // (An assembly's document is only its header and attributes, as in dnSpy, so it is too quick for this.)
    await launchApp(coreAssemblyPath)
    await page.getByRole('button', { name: 'Open Assembly' }).first().click()
    await expandModule()
    await expandRow(page.locator('.tree-row[data-kind="namespace"]').filter({ hasText: /^dnSpy\.Backend\.Core$/ }))
    await page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^WorkspaceManager @/ }).click()
    const adorner = page.locator('.wait-adorner')
    await expect(adorner).toContainText('Decompiling...')
    const cancel = adorner.getByRole('button', { name: 'Cancel' })
    await cancel.click()
    await expect(adorner).toHaveCount(0)
    await expect.poll(async () => (await page.locator('.monaco-editor .view-lines').innerText()).replaceAll(' ', ' '))
      .toContain('The operation was canceled')
    await expect(page.locator('.monaco-editor .tc-error')).toHaveText('The operation was canceled')
  })
})
