// @ts-ignore - handled by embeddedMigrationsPlugin in tsup.config.ts
import migrationsRaw from './migrations?embedded'

export type EmbeddedMigration = {
  name: string
  sql: string
}

export const embeddedMigrations: EmbeddedMigration[] = migrationsRaw as EmbeddedMigration[]
