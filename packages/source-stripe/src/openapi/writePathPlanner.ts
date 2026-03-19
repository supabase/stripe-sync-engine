import type { ParsedResourceTable, ScalarType, WritePlan } from './types'

type TableWritePlan = WritePlan & {
  generatedColumns: Array<{ column: string; pgType: string }>
}

export class WritePathPlanner {
  buildPlans(tables: ParsedResourceTable[]): TableWritePlan[] {
    return [...tables]
      .sort((a, b) => a.tableName.localeCompare(b.tableName))
      .map((table) => this.buildPlan(table))
  }

  buildPlan(table: ParsedResourceTable): TableWritePlan {
    return {
      tableName: table.tableName,
      conflictTarget: ['id'],
      extraColumns: [],
      metadataColumns: ['_raw_data', '_last_synced_at', '_account_id'],
      generatedColumns: table.columns
        .map((column) => ({ column: column.name, pgType: this.scalarTypeToPgType(column.type) }))
        .sort((a, b) => a.column.localeCompare(b.column)),
    }
  }

  private scalarTypeToPgType(type: ScalarType): string {
    switch (type) {
      case 'boolean':
        return 'boolean'
      case 'bigint':
        return 'bigint'
      case 'numeric':
        return 'numeric'
      case 'json':
        return 'jsonb'
      case 'timestamptz':
        return 'timestamptz'
      case 'text':
      default:
        return 'text'
    }
  }
}
