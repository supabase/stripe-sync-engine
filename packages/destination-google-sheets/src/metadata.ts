export const ROW_KEY_FIELD = '_row_key'
export const ROW_NUMBER_FIELD = '_row_number'
export const GOOGLE_SHEETS_META_LOG_PREFIX = '__sync_engine_google_sheets__:'

export interface GoogleSheetsRowAssignmentsMeta {
  type: 'row_assignments'
  assignments: Record<string, Record<string, number>>
}

function getPathValue(data: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = data
  for (const segment of path) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

export function serializeRowKey(primaryKey: string[][], data: Record<string, unknown>): string {
  return JSON.stringify(primaryKey.map((path) => getPathValue(data, path)))
}

export function stripSystemFields(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => key !== ROW_KEY_FIELD && key !== ROW_NUMBER_FIELD)
  )
}

export function formatGoogleSheetsMetaLog(meta: GoogleSheetsRowAssignmentsMeta): string {
  return `${GOOGLE_SHEETS_META_LOG_PREFIX}${JSON.stringify(meta)}`
}

export function parseGoogleSheetsMetaLog(
  message: string
): GoogleSheetsRowAssignmentsMeta | undefined {
  if (!message.startsWith(GOOGLE_SHEETS_META_LOG_PREFIX)) return undefined
  try {
    return JSON.parse(
      message.slice(GOOGLE_SHEETS_META_LOG_PREFIX.length)
    ) as GoogleSheetsRowAssignmentsMeta
  } catch {
    return undefined
  }
}
