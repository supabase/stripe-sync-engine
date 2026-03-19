import fs from 'node:fs'

/**
 * Sync configuration for the filesystem orchestrator.
 */
export interface FsSyncConfig {
  id: string
  source: Record<string, unknown>
  destination: Record<string, unknown>
  streams?: Array<{ name: string; [key: string]: unknown }>
}

/** Load a sync config from a JSON file. */
export function loadSyncConfig(configPath: string): FsSyncConfig {
  const raw = fs.readFileSync(configPath, 'utf8')
  const parsed = JSON.parse(raw) as FsSyncConfig
  if (!parsed.id || typeof parsed.id !== 'string') {
    throw new Error(`Sync config must have a string "id" field`)
  }
  return parsed
}

/** Save a sync config to a JSON file. */
export function saveSyncConfig(configPath: string, config: FsSyncConfig): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
}
