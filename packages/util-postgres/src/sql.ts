/** Identity tagged template — enables SQL syntax highlighting in editors. */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): string {
  let result = ''
  strings.forEach((str, i) => {
    result += str
    if (i < values.length) result += String(values[i])
  })
  return result
}

/** Double-quote a SQL identifier (table name, column name). */
export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** Comma-separated list of quoted identifiers. */
export function identList(names: string[]): string {
  return names.map(ident).join(', ')
}

/** Schema-qualified table name: "schema"."table" or just "table". */
export function qualifiedTable(schema: string | undefined, table: string): string {
  return schema ? `${ident(schema)}.${ident(table)}` : ident(table)
}
