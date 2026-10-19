import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const contractsAssemblyPath = path.resolve(import.meta.dirname, '../../../backend/dnSpy.Backend.Contracts/bin/Debug/net10.0/dnSpy.Backend.Contracts.dll')

let application: ElectronApplication
let page: Page
let userDataDirectory: string

// dnSpy hangs a PE node off the module, with one node per structure of the image below it
// (dnSpy.AsmEditor.Hex.Nodes.PENode). Nothing expands on its own, so every step below is a click.
test.describe('the PE node of an opened assembly', () => {
  test.beforeEach(async () => {
    userDataDirectory = mkdtempSync(path.join(os.tmpdir(), 'dnspy-e2e-pe-'))
    application = await electron.launch({
      args: ['.', '--no-sandbox', `--user-data-dir=${userDataDirectory}`],
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: { ...process.env, DNSPY_E2E_ASSEMBLY: contractsAssemblyPath },
    })
    page = await application.firstWindow()
    page.on('dialog', (dialog) => void dialog.accept())
    await page.waitForLoadState('domcontentloaded')
    await page.getByRole('button', { name: 'Open Assembly' }).first().click()
    await expect(page.getByRole('treeitem').first()).toContainText('dnSpy.Backend.Contracts')
  })
  test.afterEach(async () => {
    await application.close()
    rmSync(userDataDirectory, { recursive: true, force: true })
  })

  /** One row of a kind, expanded — the rows carry the node kind the backend gave them. */
  const expandRow = async (kind: string): Promise<void> => {
    const row = page.locator(`.tree-row[data-kind="${kind}"]`).first()
    await expect(row).toBeVisible()
    await row.locator('.tree-expander').click()
  }

  test('lists the structures of the image, and a structure opens as a document', async () => {
    await expandRow('assembly')
    await expandRow('module')

    const pe = page.locator('.tree-row[data-kind="pe"]')
    await expect(pe).toHaveCount(1)
    await expect(pe).toContainText('PE')

    await expandRow('pe')

    const structures = page.locator('.tree-row[data-kind="pestructure"]')
    await expect(structures.first()).toContainText('DOS Header')
    await expect(structures.filter({ hasText: 'File Header' })).toHaveCount(1)
    await expect(structures.filter({ hasText: /Optional Header \((32|64)-bit\)/ })).toHaveCount(1)
    await expect(structures.filter({ hasText: /Section #0: / })).toHaveCount(1)
    await expect(structures.filter({ hasText: 'Cor20 Header' })).toHaveCount(1)
    await expect(structures.filter({ hasText: /Storage Stream #\d+:/ }).first()).toBeVisible()

    // A structure is not code, so the row expands to nothing — the fields live in its document.
    await expect(structures.filter({ hasText: 'File Header' }).locator('.tree-expander')).toBeDisabled()

    // dnSpy shows a structure as a form of its fields rather than as text: offset, name and value, with the
    // flags of a field under it.
    await structures.filter({ hasText: 'File Header' }).dblclick()
    await expect(page.getByRole('tab', { name: 'File Header' })).toBeVisible()
    const form = page.locator('.hex-structure-view')
    await expect(form.getByRole('textbox', { name: 'Machine', exact: true })).toHaveValue(/^0x/)
    await expect(form.getByRole('combobox', { name: 'Machine' })).toBeVisible()
    await expect(form.getByRole('checkbox', { name: 'Dll', exact: true })).toBeChecked()
  })

  test('opens the whole image as one document from the PE node', async () => {
    await expandRow('assembly')
    await expandRow('module')

    await page.locator('.tree-row[data-kind="pe"]').dblclick()

    await expect(page.getByRole('tab', { name: 'PE' })).toBeVisible()
    await expect.poll(async () => (await page.locator('.monaco-editor .view-lines').innerText()).replaceAll('\u00a0', ' '))
      .toContain('// dnSpy.Backend.Contracts.dll')
    // The PE node's document is the whole image, opened from the node that stands for it.
    await expect.poll(async () => (await page.locator('.monaco-editor .view-lines').innerText()).replaceAll('\u00a0', ' '))
      .toContain('DOS Header')
  })

  test('edits a header field as a patch that undo takes back', async () => {
    await expandRow('assembly')
    await expandRow('module')
    await expandRow('pe')

    await page.locator('.tree-row[data-kind="pestructure"]').filter({ hasText: 'DOS Header' }).dblclick()
    const form = page.locator('.hex-structure-view')
    const magic = form.getByRole('textbox', { name: 'e_magic', exact: true })
    await expect(magic).toHaveValue('0x5A4D')
    // e_ovno is a field nothing reads, so writing it leaves the module as readable as it was.
    const overlay = form.getByRole('textbox', { name: 'e_ovno', exact: true })
    await overlay.fill('0x1234')
    await overlay.press('Enter')
    await expect(page.getByText('Modified', { exact: true })).toBeVisible()
    await expect(overlay).toHaveValue('0x1234')

    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await page.getByRole('menuitem', { name: /^Undo/ }).click()
    await expect(overlay).toHaveValue('0')
    await expect(page.getByText('Modified', { exact: true })).not.toBeVisible()
  })

  test('shows a metadata table as a grid and goes to the row of a token', async () => {
    await expandRow('assembly')
    await expandRow('module')
    await expandRow('pe')
    await page.locator('.tree-row[data-kind="pestructure"]').filter({ hasText: /#~/ }).locator('.tree-expander').click()
    await expandRow('tablesstream')

    const typeDef = page.locator('.tree-row[data-kind="metadatatable"]').filter({ hasText: /^02 TypeDef \(\d+\)$/ })
    await typeDef.dblclick()
    const grid = page.getByRole('grid', { name: '02 TypeDef' })
    await expect(grid.getByRole('columnheader', { name: 'Flags' })).toBeVisible()
    await expect(grid.getByRole('textbox', { name: 'Token 2', exact: true })).toHaveValue('0x02000002')

    // Go to RID selects the row it was asked for.
    await grid.click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('Control+g')
    const ask = page.getByRole('dialog', { name: 'Go to RID' })
    await ask.getByRole('textbox', { name: 'RID' }).fill('2')
    await ask.getByRole('button', { name: 'OK' }).click()
    await expect(grid.locator('tr[aria-rowindex="2"]')).toHaveAttribute('aria-selected', 'true')

    // Go to MD Table Row asks for a token and shows its record as a form.
    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await page.getByRole('menuitem', { name: /^Go to MD Table Row\.\.\./ }).click()
    const goTo = page.getByRole('dialog', { name: 'Go to MD Table Row' })
    await goTo.getByRole('textbox', { name: 'Metadata token' }).fill('0x02FFFFFF')
    await goTo.getByRole('button', { name: 'OK' }).click()
    await expect(goTo.getByRole('alert')).toBeVisible()
    await goTo.getByRole('textbox', { name: 'Metadata token' }).fill('0x02000002')
    await goTo.getByRole('button', { name: 'OK' }).click()
    await expect(goTo).toBeHidden()
    const record = page.locator('.tree-row[data-kind="metadatarecord"][aria-selected="true"]')
    await expect(record).toHaveText(/^2/)
    await expect(page.locator('.hex-structure-view').getByRole('textbox', { name: 'Flags', exact: true })).toBeVisible()
  })
})
