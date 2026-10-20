import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const searchTargetPath = path.resolve(import.meta.dirname, '../../../backend/tests/SearchTarget/bin/Debug/net10.0/SearchTarget.dll')

let application: ElectronApplication
let page: Page
let scratchDirectory: string

// dnSpy's File > Export to Project: the dialog asks for a folder and writes a project per module of the selection,
// with a solution beside them. "Open project" hands the solution to the shell, which a test-driven run writes down.
test.describe('Export to Project', () => {
  test.beforeEach(async () => {
    scratchDirectory = mkdtempSync(path.join(os.tmpdir(), 'dnspy-e2e-export-'))
    application = await electron.launch({
      args: ['.', '--no-sandbox', `--user-data-dir=${path.join(scratchDirectory, 'profile')}`],
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: {
        ...process.env,
        DNSPY_E2E_ASSEMBLY: searchTargetPath,
        DNSPY_E2E_OPEN_PROJECT_PATH: path.join(scratchDirectory, 'opened.txt'),
      },
    })
    page = await application.firstWindow()
    page.on('dialog', (dialog) => void dialog.accept())
    await page.waitForLoadState('domcontentloaded')
    await page.getByRole('button', { name: 'Open Assembly' }).first().click()
    await expect(page.getByRole('treeitem').first()).toContainText('SearchTarget')
  })
  test.afterEach(async () => {
    await application.close()
    rmSync(scratchDirectory, { recursive: true, force: true })
  })

  test('exports the selected assembly to a project and a solution, and opens the solution', async () => {
    const output = path.join(scratchDirectory, 'out')
    await page.locator('.tree-row[data-kind="assembly"]').first().click()

    await page.getByRole('menuitem', { name: 'File' }).click()
    const entry = page.getByRole('menuitem', { name: /^Export to Project/ })
    await expect(entry).toBeEnabled()
    await entry.click()

    const dialog = page.getByRole('dialog', { name: 'Export to Project' })
    await expect(dialog.getByText('One file will be decompiled. Select more than one assembly to decompile more than one file.')).toBeVisible()
    await expect(dialog.getByLabel('Solution', { exact: true })).toHaveValue('SearchTarget.sln')
    await expect(dialog.getByRole('button', { name: 'Export' })).toBeDisabled()
    await dialog.getByLabel('Folder').fill(output)
    await dialog.getByRole('checkbox', { name: 'Use SDK style project format' }).click()
    await dialog.getByRole('checkbox', { name: 'Open project in Visual Studio' }).click()
    await dialog.getByRole('button', { name: 'Export' }).click()

    // An export that logs nothing closes the dialog by itself.
    await expect(dialog).toBeHidden({ timeout: 60_000 })
    expect(existsSync(path.join(output, 'SearchTarget', 'SearchTarget.csproj'))).toBe(true)
    expect(existsSync(path.join(output, 'SearchTarget.sln'))).toBe(true)
    await expect.poll(() => existsSync(path.join(scratchDirectory, 'opened.txt'))).toBe(true)
    expect(readFileSync(path.join(scratchDirectory, 'opened.txt'), 'utf8')).toBe(path.join(output, 'SearchTarget.sln'))
  })
})
