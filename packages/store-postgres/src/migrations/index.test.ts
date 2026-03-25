import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { migrations } from './index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('migrations barrel', () => {
  it('includes every migration file in the directory', () => {
    const files = fs
      .readdirSync(__dirname)
      .filter((f) => /^\d{4}_.*\.ts$/.test(f))
      .map((f) => f.replace(/\.ts$/, '.sql'))
      .sort()

    const registered = migrations.map((m) => m.name).sort()
    expect(registered).toEqual(files)
  })

  it('migration names match their file prefix', () => {
    for (const m of migrations) {
      expect(m.name).toMatch(/^\d{4}_\w+\.sql$/)
    }
  })

  it('no duplicate migration IDs', () => {
    const ids = migrations.map((m) => parseInt(m.name.slice(0, 4), 10))
    expect(new Set(ids).size).toBe(ids.length)
  })
})
