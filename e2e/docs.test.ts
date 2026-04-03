import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const ROOT = join(import.meta.dirname, '..')

// All plan and design files must start with YYYY-MM-DD-
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}-[\w-]+\.md$/

const CHECKED_DIRS = [
  'docs/plans/active',
  'docs/plans/completed',
  'docs/design',
]

for (const dir of CHECKED_DIRS) {
  describe(`${dir} naming convention`, () => {
    const files = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.md'))

    it.each(files)('%s matches YYYY-MM-DD-description.md', (file) => {
      expect(DATE_PATTERN.test(file), `${file} must be named YYYY-MM-DD-description.md`).toBe(true)
    })
  })
}
