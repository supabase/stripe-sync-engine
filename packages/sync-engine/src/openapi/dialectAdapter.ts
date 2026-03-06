import type { ParsedResourceTable } from './types'

export interface DialectAdapter {
  /**
   * Create all statements needed to materialize a single parsed table.
   */
  buildTableStatements(table: ParsedResourceTable): string[]

  /**
   * Create all statements needed to materialize all parsed tables.
   * Implementations must be deterministic for a given input.
   */
  buildAllStatements(tables: ParsedResourceTable[]): string[]
}
