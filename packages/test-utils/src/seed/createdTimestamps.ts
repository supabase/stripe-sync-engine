export type CreatedTimestampRange = {
  startUnix: number
  endUnix: number
}

export function applyCreatedTimestampRange(
  objects: Record<string, unknown>[],
  range: CreatedTimestampRange | undefined
): Record<string, unknown>[] {
  if (!range) return objects
  if (objects.length === 0) return objects

  // Max created is endUnix - 1 so no object lands on the boundary.
  // Matches Stripe's created[gte]/created[lt] semantics.
  const maxCreated = range.endUnix - 1

  if (objects.length === 1) {
    return [{ ...objects[0], created: maxCreated }]
  }

  const span = Math.max(0, maxCreated - range.startUnix)
  return objects.map((object, index) => {
    const ratio = index / (objects.length - 1)
    const created = range.startUnix + Math.floor(span * ratio)
    return { ...object, created }
  })
}
