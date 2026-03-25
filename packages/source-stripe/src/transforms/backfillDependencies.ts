import type { ResourceConfig } from '../types.js'

function getUniqueIds<T>(entries: T[], key: keyof T & string): string[] {
  const set = new Set(
    entries.map((entry) => entry?.[key]?.toString()).filter((it): it is string => Boolean(it))
  )

  return Array.from(set)
}

export async function backfillDependencies(opts: {
  items: Record<string, any>[] // eslint-disable-line @typescript-eslint/no-explicit-any
  syncObjectName: string
  accountId: string
  syncTimestamp?: string
  registry: Record<string, ResourceConfig>
  backfillAny: (
    ids: string[],
    objectName: string,
    accountId: string,
    syncTimestamp?: string
  ) => Promise<unknown[]>
}): Promise<void> {
  const dependencies = opts.registry[opts.syncObjectName]?.dependencies ?? []
  await Promise.all(
    dependencies.map((dependency) =>
      opts.backfillAny(
        getUniqueIds(opts.items, dependency),
        dependency,
        opts.accountId,
        opts.syncTimestamp
      )
    )
  )
}
