import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// dnSpy's Roslyn code editor, in the Edit Code window: the language service's colors, completion with dnSpy's
// images and filter buttons, Quick Info, signature help, the word commands of its text structure navigator, and the
// Code Editor options page. The window edits a type of the contracts assembly; nothing is compiled into it.

let application: ElectronApplication
let page: Page
let userDataDirectory: string
const contractsAssemblyPath = path.resolve(import.meta.dirname, '../../../backend/dnSpy.Backend.Contracts/bin/Debug/net10.0/dnSpy.Backend.Contracts.dll')

const launchApp = async (): Promise<void> => {
  userDataDirectory = mkdtempSync(path.join(os.tmpdir(), 'dnspy-e2e-'))
  application = await electron.launch({
    args: ['.', '--no-sandbox', `--user-data-dir=${userDataDirectory}`],
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: { ...process.env, DNSPY_E2E_ASSEMBLY: contractsAssemblyPath, DNSPY_E2E_SAVE_PROMPT: 'discard' },
  })
  page = await application.firstWindow()
  page.on('dialog', (dialog) => void dialog.accept())
  await page.waitForLoadState('domcontentloaded')
  // The window is tall enough for the Edit Code window's editor to show a useful number of lines.
  const browserWindow = await application.browserWindow(page)
  await browserWindow.evaluate((window) => window.setSize(1500, 1000))
}

const closeApp = async (): Promise<void> => {
  await application?.close()
  rmSync(userDataDirectory, { recursive: true, force: true })
}

const expandRow = async (row: Locator): Promise<void> => {
  await expect(row).toBeVisible()
  if ((await row.getAttribute('aria-expanded')) === 'false')
    await row.locator('.tree-expander').click()
}

/** Opens Edit Class (C#) on the contracts assembly's HelloRequest, and waits for the editor's Roslyn colors. */
const openEditClass = async (): Promise<{ dialog: Locator; editor: Locator }> => {
  await page.getByRole('button', { name: 'Open Assembly' }).first().click()
  await expandRow(page.locator('.tree-row[data-kind="assembly"]').first())
  await expandRow(page.locator('.tree-row[data-kind="module"]').first())
  await expandRow(page.locator('.tree-row[data-kind="namespace"]').filter({ hasText: /^dnSpy\.Backend\.Contracts$/ }))
  const type = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^HelloRequest @02000005$/ })
  await type.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Edit Class (C#)...' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit Class (C#)' })
  const editor = dialog.locator('.monaco-editor').first()
  // The language service has colored the document: a keyword in dnSpy's keyword color class.
  await expect(editor.locator('.view-lines .tc-keyword').first()).toBeVisible()
  return { dialog, editor }
}

/** Puts the focus in the editor, at the end of its text, on a new line of its own. */
const typeAtEnd = async (editor: Locator, text: string): Promise<void> => {
  await editor.locator('.native-edit-context, textarea.inputarea').first().focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(text)
}

test.describe('the Roslyn code editor', () => {
  test.beforeEach(async () => { await launchApp() })
  test.afterEach(async () => { await closeApp() })

  test('completes with dnSpy\'s images, colors and filter buttons, and commits by its rules', async () => {
    const { editor } = await openEditClass()
    await typeAtEnd(editor, '\nclass E2E { void M(int count) { System.Console.')

    const suggest = editor.locator('.suggest-widget')
    await expect(suggest).toBeVisible()
    const writeLine = suggest.locator('.monaco-list-row').filter({ hasText: /^WriteLine$/ })
    await page.keyboard.type('WriteL')
    await expect(writeLine).toBeVisible()
    // dnSpy's image for a public method instead of Monaco's codicon, and the name in the method color.
    await expect(writeLine.locator('.ds-completion-icon')).toHaveCSS('background-image', /^url\("data:image\/svg\+xml/)
    await expect(writeLine.locator('.label-name .tc-instanceMethod').first()).toBeVisible()
    // The filter buttons of the kinds in the list, in dnSpy's order, with their keys in the tool tips.
    const filters = suggest.locator('.ds-completion-filter')
    await expect(filters.first()).toBeVisible()
    await expect(suggest.getByRole('button', { name: 'Methods' })).toHaveAttribute('title', 'Methods (Alt+M)')
    await expect(suggest.getByRole('button', { name: 'Properties' })).toBeVisible()

    // Alt+P shows the properties only and Alt+P again brings the rest back — and opens no menu on the way.
    for (let i = 0; i < 'WriteL'.length; i++)
      await page.keyboard.press('Backspace')
    await expect(suggest).toBeVisible()
    const beep = suggest.locator('.monaco-list-row').filter({ hasText: /^Beep$/ })
    await expect(beep).toBeVisible()
    await page.keyboard.press('Alt+P')
    await expect(suggest.getByRole('button', { name: 'Properties' })).toHaveAttribute('aria-pressed', 'true')
    await expect(suggest.locator('.monaco-list-row').filter({ hasText: /^CapsLock$/ })).toBeVisible()
    await expect(beep).not.toBeVisible()
    await expect(page.getByRole('menuitem', { name: /^Open\.\.\./ })).not.toBeVisible()
    await page.keyboard.press('Alt+P')
    await expect(suggest.getByRole('button', { name: 'Properties' })).toHaveAttribute('aria-pressed', 'false')
    await expect(beep).toBeVisible()
    await page.keyboard.type('WriteL')
    await expect(writeLine).toBeVisible()

    // '(' is one of C#'s commit characters: the item goes in, and the '(' after it opens the signature help.
    await page.keyboard.type('(')
    await expect(editor.locator('.view-lines')).toContainText('System.Console.WriteLine(')
    const hints = editor.locator('.parameter-hints-widget')
    await expect(hints).toBeVisible()
    // The signature in the code's colors, the current parameter marked.
    await expect(hints.locator('.ds-signature')).toContainText('Console.WriteLine(')
    await expect(hints.locator('.ds-signature .tc-keyword').first()).toBeVisible()

    // Enter is the editor's own, not the document tab's under the window: it starts a new line.
    await page.keyboard.press('Escape')
    await page.keyboard.type('count);')
    await page.keyboard.press('Enter')
    await page.keyboard.type('}')
    await expect(editor.locator('.view-lines')).toContainText('System.Console.WriteLine(count);')
  })
  test('shows Quick Info with dnSpy\'s image, and moves and selects by Roslyn\'s words', async () => {
    const { editor } = await openEditClass()
    await typeAtEnd(editor, '\n// a comment\nclass E2E { string s = "hello world"; }')
    const lines = editor.locator('.view-lines')
    await expect(lines).toContainText('"hello world"')

    // Quick Info over the type: its image before the description, the description in the code's colors.
    const recordName = editor.locator('.view-line').filter({ hasText: /record\sHelloRequest/ }).locator('span', { hasText: /^HelloRequest$/ }).first()
    const box = (await recordName.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    const hover = page.locator('.monaco-hover').filter({ hasText: 'HelloRequest' })
    await expect(hover).toBeVisible()
    await expect(hover.locator('img').first()).toHaveAttribute('src', /^data:image\/svg\+xml/)

    // Ctrl+Left stops at "}", at ";", at the closing quote — a word of its own — and at "world" inside the string.
    await editor.locator('.native-edit-context, textarea.inputarea').first().focus()
    await page.keyboard.press('End')
    for (const key of ['Control+ArrowLeft', 'Control+ArrowLeft', 'Control+ArrowLeft', 'Control+ArrowLeft'])
      await page.keyboard.press(key)
    await page.keyboard.type('@')
    await expect(lines).toContainText('"hello @world"; }')

    // Ctrl+W at the start of a comment selects all of it, and Ctrl+C copies it.
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Home')
    await page.keyboard.press('Control+W')
    await page.keyboard.press('Control+C')
    await expect.poll(() => application.evaluate(({ clipboard }) => clipboard.readText())).toBe('// a comment')
  })

  test('follows the Code Editor options page', async () => {
    await page.evaluate(() => {
      localStorage.setItem('dnspy.appOptions.v1', JSON.stringify({ codeEditor: { cSharp: { general: { showLineNumbers: false } } } }))
      window.dispatchEvent(new Event('app-options-changed'))
    })
    const { editor } = await openEditClass()
    await expect(editor.locator('.line-numbers')).toHaveCount(0)

    // Ctrl+E W switches word wrap, and the page with it.
    await editor.locator('.native-edit-context, textarea.inputarea').first().focus()
    await page.keyboard.press('Control+E')
    await page.keyboard.press('W')
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('dnspy.appOptions.v1') ?? '{}').codeEditor?.cSharp?.general?.wordWrap)).toBe(false)
  })

  test('edits Visual Basic with the same services', async () => {
    await page.getByRole('combobox').filter({ hasText: 'C#' }).first().selectOption({ label: 'Visual Basic' })
    await page.getByRole('button', { name: 'Open Assembly' }).first().click()
    await expandRow(page.locator('.tree-row[data-kind="assembly"]').first())
    await expandRow(page.locator('.tree-row[data-kind="module"]').first())
    await expandRow(page.locator('.tree-row[data-kind="namespace"]').filter({ hasText: /^dnSpy\.Backend\.Contracts$/ }))
    await page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^HelloRequest @02000005$/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Edit Class (Visual Basic)...' }).click()
    const editor = page.getByRole('dialog', { name: 'Edit Class (Visual Basic)' }).locator('.monaco-editor').first()
    await expect(editor.locator('.view-lines .tc-keyword').first()).toBeVisible()

    await typeAtEnd(editor, '\nClass E2E\nSub M()\nSystem.Console.')
    const suggest = editor.locator('.suggest-widget')
    await page.keyboard.type('WriteL')
    await expect(suggest.locator('.monaco-list-row').filter({ hasText: /^WriteLine$/ })).toBeVisible()
    // Visual Basic's Enter commits and starts a new line too.
    await page.keyboard.press('Enter')
    await expect(editor.locator('.view-lines')).toContainText('System.Console.WriteLine')
    await expect(editor.locator('.view-line').last()).not.toContainText('WriteLine')
  })
})
