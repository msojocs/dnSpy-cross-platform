import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The Assembly Explorer the way dnSpy's own behaves: what a command line opens and selects, the keys the tree
// answers to, dnSpy's own images, Recent Files, Reload All putting the tabs back, and a removal the edit
// history keeps. AnalyzerTarget is the fixture: a handful of public, internal and private members in one
// namespace, small enough to walk with the keyboard.
const analyzerTargetPath = path.resolve(import.meta.dirname, '../../../backend/tests/AnalyzerTarget/bin/Debug/net10.0/AnalyzerTarget.dll')

let application: ElectronApplication
let page: Page
let userDataDirectory: string

const launchApp = async (args: string[] = []): Promise<void> => {
  userDataDirectory = mkdtempSync(path.join(os.tmpdir(), 'dnspy-e2e-tree-'))
  application = await electron.launch({
    args: ['.', '--no-sandbox', `--user-data-dir=${userDataDirectory}`, ...args],
    cwd: path.resolve(import.meta.dirname, '../..'),
    // dnSpy's "save before continuing?" is a native box no test can press; the edits are let go.
    env: { ...process.env, DNSPY_E2E_ASSEMBLY: analyzerTargetPath, DNSPY_E2E_SAVE_PROMPT: 'discard', DNSPY_E2E_ASK_ANSWER: 'first' },
  })
  page = await application.firstWindow()
  page.on('dialog', (dialog) => void dialog.accept())
  await page.waitForLoadState('domcontentloaded')
}

const closeApp = async (): Promise<void> => {
  await application?.close()
  rmSync(userDataDirectory, { recursive: true, force: true })
}

const row = (kind: string, text: RegExp): Locator => page.locator(`.tree-row[data-kind="${kind}"]`).filter({ hasText: text })

const expandRow = async (target: Locator): Promise<void> => {
  await expect(target).toBeVisible()
  if ((await target.getAttribute('aria-expanded')) === 'false')
    await target.locator('.tree-expander').click()
  await expect(target).toHaveAttribute('aria-expanded', 'true')
}

const selectedRows = (): Locator => page.locator('.tree-row[aria-selected="true"]')

test.describe('a command line', () => {
  test.beforeEach(async () => { await launchApp([analyzerTargetPath, '--select', 'T:AnalyzerTarget.Circle']) })
  test.afterEach(async () => { await closeApp() })

  test('opens the files it names, follows --select, and remembers them as recent files', async () => {
    // dnSpy's AppCommandLineArgsHandler follows the member: its document opens and its row is selected.
    await expect(page.getByRole('tab', { name: 'Circle' })).toHaveAttribute('aria-selected', 'true')
    const circle = row('type', /^Circle @02000005$/)
    await expect(circle).toHaveAttribute('aria-selected', 'true')
    // The row wears dnSpy's own image for a public class.
    const image = circle.locator('.ds-image.dsi-ClassPublic')
    await expect(image).toBeVisible()
    expect(await image.evaluate((element) => getComputedStyle(element).backgroundImage)).toMatch(/^url\("data:image\/svg\+xml/)

    const fileMenu = page.getByRole('menuitem', { name: 'File', exact: true })
    await fileMenu.click()
    const recentFiles = page.getByRole('menuitem', { name: 'Recent Files' })
    await recentFiles.hover()
    await expect(recentFiles).toHaveAttribute('aria-expanded', 'true')
    // An entry names the file by its whole path — the last hundred characters of a longer one.
    await expect(page.getByRole('menuitem', { name: /^1 .*AnalyzerTarget\.dll$/ })).toBeVisible()
    await page.keyboard.press('Escape')
  })
})

test.describe('the tree keys', () => {
  test.beforeEach(async () => { await launchApp([analyzerTargetPath]) })
  test.afterEach(async () => { await closeApp() })

  test('walk, open and find rows the way dnSpy\'s tree does', async () => {
    // Without --select the first assembly the command line named is shown, and its row selected.
    const assembly = row('assembly', /^AnalyzerTarget/)
    await expect(page.getByRole('tab', { name: /^AnalyzerTarget/ })).toHaveAttribute('aria-selected', 'true')
    await expect(assembly).toHaveAttribute('aria-selected', 'true')
    await assembly.focus()

    // Right opens a row and then steps into it; Down walks the rows below.
    await page.keyboard.press('ArrowRight')
    await expect(assembly).toHaveAttribute('aria-expanded', 'true')
    const module = row('module', /^AnalyzerTarget\.dll$/)
    await expect(module).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expect(module).toHaveAttribute('aria-selected', 'true')
    await expect(module).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(module).toHaveAttribute('aria-expanded', 'true')
    await expandRow(row('namespace', /^AnalyzerTarget$/))

    // Typing the first letters of a row selects it; Enter opens it.
    const square = row('type', /^Square @02000006$/)
    await expect(square).toBeVisible()
    await row('namespace', /^AnalyzerTarget$/).focus()
    await page.keyboard.type('sq')
    await expect(square).toHaveAttribute('aria-selected', 'true')
    await expect(square).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('tab', { name: 'Square' })).toHaveAttribute('aria-selected', 'true')

    // Shift spans from the anchor, Ctrl+A takes every row, and Left goes back up to the parent.
    await square.focus()
    await page.keyboard.press('Shift+ArrowUp')
    await expect(selectedRows()).toHaveCount(2)
    await page.keyboard.press('Control+a')
    expect(await selectedRows().count()).toBe(await page.locator('.tree-row').count())
    // A click selects a row on its own — and with dnSpy's "single-click expands" opens it, so the first Left
    // folds it again and the second goes up.
    await square.click()
    await expect(square).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('ArrowLeft')
    await expect(square).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('ArrowLeft')
    await expect(row('namespace', /^AnalyzerTarget$/)).toHaveAttribute('aria-selected', 'true')
  })
})

test.describe('Reload All Assemblies', () => {
  test.beforeEach(async () => { await launchApp([analyzerTargetPath, '--select', 'T:AnalyzerTarget.Circle']) })
  test.afterEach(async () => { await closeApp() })

  test('puts the tabs, the open branches and the selection back on the reloaded tree', async () => {
    await expect(page.getByRole('tab', { name: 'Circle' })).toHaveAttribute('aria-selected', 'true')
    await expandRow(row('type', /^Circle @02000005$/))

    await page.getByRole('menuitem', { name: 'File', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Reload All Assemblies' }).click()

    await expect(page.getByRole('tab', { name: 'Circle' })).toHaveAttribute('aria-selected', 'true')
    const circle = row('type', /^Circle @02000005$/)
    await expect(circle).toHaveAttribute('aria-selected', 'true')
    await expect(circle).toHaveAttribute('aria-expanded', 'true')
    await expect(row('method', /^Grow\(\) : void/)).toBeVisible()
  })
})

test.describe('Remove Assembly', () => {
  test.beforeEach(async () => { await launchApp([analyzerTargetPath]) })
  test.afterEach(async () => { await closeApp() })

  test('is undone by Undo once an edit made the assembly part of the history', async () => {
    const assembly = row('assembly', /^AnalyzerTarget/)
    await expandRow(assembly)
    await expandRow(row('module', /^AnalyzerTarget\.dll$/))
    await expandRow(row('namespace', /^AnalyzerTarget$/))
    const square = row('type', /^Square @02000006$/)
    await square.click()
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
    await page.getByRole('menuitem', { name: /^Delete Square\b/ }).click()
    await expect(square).not.toBeVisible()

    // The edit is unsaved, so the removal asks first; the test lets it go unsaved, and the tree is left empty.
    await assembly.click()
    await page.keyboard.press('Delete')
    await expect(page.locator('.tree-row')).toHaveCount(0)

    // dnSpy records the removal in the history: Undo brings the very assembly back, and the edit under it.
    await page.keyboard.press('Control+z')
    await expect(assembly).toBeVisible()
    await page.keyboard.press('Control+z')
    await expandRow(assembly)
    await expandRow(row('module', /^AnalyzerTarget\.dll$/))
    await expandRow(row('namespace', /^AnalyzerTarget$/))
    await expect(square).toBeVisible()
    await expect(page.getByText('Modified', { exact: true })).not.toBeVisible()
  })
})
