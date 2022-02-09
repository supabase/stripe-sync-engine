import { JsonSchema } from '../types/types'
/**
 * Returns an (yesql formatted) upsert function based on the key/vals of an object.
 * eg,
 *  insert into customers ("id", "name")
 *  values (:id, :name)
 *  on conflict (id)
 *  do update set (
 *   "id" = :id,
 *   "name" = :name
 *  )
 */
export const constructUpsertSql = (
  schema: string,
  table: string,
  tableSchema: JsonSchema,
  options?: {
    conflict?: string
  }
): string => {
  const { conflict = 'id' } = options || {}
  const properties = tableSchema.properties

  return `
    insert into "${schema}"."${table}" (
      ${Object.keys(properties)
        .map((x) => `"${x}"`)
        .join(',')}
    )
    values (
      ${Object.keys(properties)
        .map((x) => `:${x}`)
        .join(',')}
    )
    on conflict (
      ${conflict}
    )
    do update set 
      ${Object.keys(properties)
        .map((x) => `"${x}" = :${x}`)
        .join(',')}
    ;`
}

/**
 * For array object field like invoice.custom_fields
 * ex: [{"name":"Project name","value":"Test Project"}]
 *
 * we need to stringify it first cos passing array object directly will end up with
 * {
 * invalid input syntax for type json
 * detail: 'Expected ":", but found "}".',
 * where: 'JSON data, line 1: ...\\":\\"Project name\\",\\"value\\":\\"Test Project\\"}"}',
 * }
 */

export const cleanseArrayField = (obj: {
  [Key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
}): {
  [Key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
} => {
  const cleansed = { ...obj }
  Object.keys(cleansed).map((k) => {
    const data = cleansed[k]
    if (Array.isArray(data)) {
      cleansed[k] = JSON.stringify(data)
    }
  })
  return cleansed
}
