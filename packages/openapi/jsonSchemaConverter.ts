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
    const body: Record<string, unknown> = col.nullable
      ? { oneOf: [mapped, { type: 'null' }] }
      : { ...mapped }
    if (col.expandableReference) body['x-expandable-reference'] = true
    properties[col.name] = body
    if (!col.nullable) required.push(col.name)
  }

  return {
    type: 'object',
    properties,
    required,
  }
}
