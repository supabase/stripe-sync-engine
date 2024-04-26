export const getUniqueIds = <T>(entries: T[], key: keyof T): string[] => {
  const set = new Set(
    entries
      .map((subscription) => subscription?.[key]?.toString())
      .filter((it): it is string => Boolean(it))
  )

  return Array.from(set)
}
