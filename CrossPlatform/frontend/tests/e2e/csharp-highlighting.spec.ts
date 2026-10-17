import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const assemblyPath = path.resolve(import.meta.dirname, '../../../backend/dnSpy.Backend.Contracts/bin/Debug/net10.0/dnSpy.Backend.Contracts.dll')

test('draws C# in the colours of dnSpy\'s themes and retains IL highlighting', async () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'dnspy-highlighting-'))
  const application = await electron.launch({
    args: ['.', '--no-sandbox', `--user-data-dir=${profile}`],
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: { ...process.env, DNSPY_E2E_ASSEMBLY: assemblyPath },
  })
  try {
    const page = await application.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    await page.getByRole('button', { name: 'Open Assembly' }).first().click()
    await page.locator('.tree-row[data-kind="assembly"] .tree-expander').click()
    await page.locator('.tree-row[data-kind="module"] .tree-expander').click()
    const namespace = page.locator('.tree-row[data-kind="namespace"]').filter({ hasText: /^dnSpy\.Backend\.Contracts$/ })
    await namespace.locator('.tree-expander').click()
    // The row's tooltip is dnSpy's several-line one, so the row is found by the name it shows.
    await page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^HelloRequest @[0-9A-F]{8}$/ }).dblclick()

    const editor = page.locator('.monaco-editor')
    await expect(editor).toBeVisible()
    await expect.poll(async () => (await editor.locator('.view-lines').innerText()).replaceAll('\u00a0', ' ')).toContain('record HelloRequest')
    const tokenColor = async (text: string): Promise<string | undefined> => editor.locator('.view-lines span[class*="mtk"]').evaluateAll((tokens, text) => {
      const token = tokens.find((token) => token.textContent === text)
      return token ? getComputedStyle(token).color : undefined
    }, text)

    expect(errors).toEqual([])
    await expect.poll(() => tokenColor('HelloRequest')).toBe('rgb(78, 201, 176)')
    // The Type colour of light.dntheme, blue.dntheme and dark.dntheme.
    for (const [theme, color] of [
      ['Light', 'rgb(43, 145, 175)'],
      ['Blue', 'rgb(43, 145, 175)'],
      ['Dark', 'rgb(78, 201, 176)'],
    ]) {
      await page.getByRole('menuitem', { name: 'View' }).click()
      await page.getByRole('menuitem', { name: /^Theme$/ }).hover()
      await page.getByRole('menuitem', { name: theme, exact: true }).click()
      await expect.poll(() => tokenColor('HelloRequest')).toBe(color)
    }
    await page.screenshot({ path: 'test-results/dnspy-csharp-highlighting.png' })

    await page.getByLabel('Decompiler language').selectOption('il')
    await expect(editor).toHaveAttribute('data-language-id', 'il')
    await expect.poll(() => tokenColor('.class')).toBe('rgb(153, 153, 255)')
    // Switching back uses the same model path and must restore the TextMate provider.
    await page.getByLabel('Decompiler language').selectOption('cSharp')
    await expect(editor).toHaveAttribute('data-language-id', 'csharp')
    await expect.poll(() => tokenColor('HelloRequest')).toBe('rgb(78, 201, 176)')
    expect(errors).toEqual([])
  }
  finally {
    await application.close()
    rmSync(profile, { recursive: true, force: true })
  }
})
