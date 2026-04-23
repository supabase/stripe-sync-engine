export type Range = { gte: string; lt: string }

/**
 * Merge overlapping or adjacent ISO 8601 ranges into a minimal sorted set.
 */
export function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length <= 1) return ranges.slice()
  const sorted = ranges.slice().sort((a, b) => (a.gte < b.gte ? -1 : a.gte > b.gte ? 1 : 0))
  const merged: Range[] = [{ ...sorted[0]! }]
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!
    const last = merged[merged.length - 1]!
    if (cur.gte <= last.lt) {
      last.lt = cur.lt > last.lt ? cur.lt : last.lt
    } else {
      merged.push({ ...cur })
    }
  }
  return merged
}
