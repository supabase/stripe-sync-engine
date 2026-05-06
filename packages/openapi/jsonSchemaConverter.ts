import type { ParsedResourceTable, ScalarType } from './types.js'

const SCALAR_TYPE_TO_JSON_SCHEMA: Record<ScalarType, { type: string; format?: string }> = {
  text: { type: 'string' },
  boolean: { type: 'boolean' },
  bigint: { type: 'integer' },
  numeric: { type: 'number' },
  json: { type: 'object' },
  timestamptz: { type: 'string', format: 'date-time' },
}

export function parsedTableToJsonSchema(table: ParsedResourceTable): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    id: { type: 'string' },
  }
  const required: string[] = ['id']

  for (const col of table.columns) {
    const mapped = SCALAR_TYPE_TO_JSON_SCHEMA[col.type] ?? { type: 'string' }
    if (col.nullable) {
      properties[col.name] = { oneOf: [mapped, { type: 'null' }] }
    } else {
      properties[col.name] = mapped
      required.push(col.name)
    }
  }

  return {
    type: 'object',
    properties,
    required,
  }
}
