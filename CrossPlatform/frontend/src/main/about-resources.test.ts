import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The About box shows two texts that are written elsewhere: dnSpy's own credits, in the WPF tree, and the
// third-party notices, beside the packaging they describe. Both are copied into the frontend's resources/
// because the bundler may not read above the package's root — so the copies have to be kept in step by hand,
// and this is what notices when they are not.
const here = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(here, '../..')
const repositoryRoot = path.resolve(frontendRoot, '../..')

const copies: readonly { copy: string; original: string }[] = [
  { copy: 'resources/CREDITS.txt', original: 'dnSpy/dnSpy/LicenseInfo/CREDITS.txt' },
  { copy: 'resources/THIRD-PARTY-NOTICES.md', original: 'CrossPlatform/packaging/licenses/THIRD-PARTY-NOTICES.md' },
]

describe('the About box resources', () => {
  it.each(copies)('$copy is a copy of $original', ({ copy, original }) => {
    const copied = readFileSync(path.join(frontendRoot, copy), 'utf8')
    const source = readFileSync(path.join(repositoryRoot, original), 'utf8')
    expect(copied).toBe(source)
  })
})
