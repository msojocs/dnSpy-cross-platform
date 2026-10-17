import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The languages other than English and Simplified Chinese are dnSpy's resx translations, written into
// renderer/src/locales.generated.ts and main/native-messages.generated.ts by scripts/generate-locales.mjs and
// checked in. A string added to one of the hand-kept tables, or a resx that changed, leaves them behind until
// the script is run again — and this is what notices.
const here = path.dirname(fileURLToPath(import.meta.url))
const crossPlatformRoot = path.resolve(here, '../../..')

describe('the generated languages', () => {
  it('are what the generator writes from the resx files and the hand-kept tables', () => {
    // --check compares instead of writing, and fails naming the files that are out of date.
    expect(() => execFileSync(process.execPath, ['scripts/generate-locales.mjs', '--check'], { cwd: crossPlatformRoot, stdio: 'pipe' })).not.toThrow()
  })
})
