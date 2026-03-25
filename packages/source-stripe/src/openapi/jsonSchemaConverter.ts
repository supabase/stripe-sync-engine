import type { ParsedResourceTable, ScalarType } from './types.js'

function scalarTypeToJsonSchema(type: ScalarType): Record<string, unknown> {
  switch (type) {
    case 'text':
      return { type: 'string' }
    case 'boolean':
      return { type: 'boolean' }
    case 'bigint':
      return { type: 'integer' }
    case 'numeric':
      return { type: 'number' }
    case 'json':
      return { type: 'object' }
    case 'timestamptz':
      return { type: 'string', format: 'date-time' }
  }
}

/** Convert a ParsedResourceTable into a standard JSON Schema object. */
export function parsedTableToJsonSchema(table: ParsedResourceTable): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {
    id: { type: 'string' },
  }
  const required: string[] = ['id']

  for (const col of table.columns) {
    const schema = scalarTypeToJsonSchema(col.type)
    if (col.expandableReference) {
      schema['x-expandable-reference'] = true
    }
    properties[col.name] = schema

    if (!col.nullable) {
      required.push(col.name)
    }
  }

  return {
    type: 'object',
    properties,
    required,
    'x-source-schema': table.sourceSchemaName,
  }
}
