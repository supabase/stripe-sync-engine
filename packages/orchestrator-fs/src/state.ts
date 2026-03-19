import fs from 'node:fs'
import path from 'node:path'

/**
 * Filesystem-backed state persistence.
 *
 * State is stored as JSON files at `{stateDir}/{syncId}/{stream}.json`.
 * Each file contains the opaque state data for one stream.
 */
export class FsStateStore {
  constructor(private readonly stateDir: string) {}

  /** Load all persisted state for a sync. */
  loadState(syncId: string): Record<string, unknown> {
    const syncDir = path.join(this.stateDir, syncId)
    if (!fs.existsSync(syncDir)) return {}

    const state: Record<string, unknown> = {}
    for (const file of fs.readdirSync(syncDir)) {
      if (!file.endsWith('.json')) continue
      const stream = file.slice(0, -5) // remove .json
      try {
        const raw = fs.readFileSync(path.join(syncDir, file), 'utf8')
        state[stream] = JSON.parse(raw)
      } catch {
        // Skip corrupt state files
      }
    }
    return state
  }

  /** Persist state for a single stream. */
  saveStreamState(syncId: string, stream: string, data: unknown): void {
    const syncDir = path.join(this.stateDir, syncId)
    fs.mkdirSync(syncDir, { recursive: true })
    const filePath = path.join(syncDir, `${stream}.json`)
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
  }

  /** Delete all persisted state for a sync. */
  clearState(syncId: string): void {
    const syncDir = path.join(this.stateDir, syncId)
    if (fs.existsSync(syncDir)) {
      fs.rmSync(syncDir, { recursive: true, force: true })
    }
  }
}
