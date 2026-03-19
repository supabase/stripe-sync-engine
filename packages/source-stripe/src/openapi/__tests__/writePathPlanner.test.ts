import { describe, expect, it } from 'vitest'
import { WritePathPlanner } from '../writePathPlanner'
import type { ParsedResourceTable } from '../types'

describe('WritePathPlanner', () => {
  it('builds deterministic write plans aligned to raw json upsert assumptions', () => {
    const planner = new WritePathPlanner()
    const tables: ParsedResourceTable[] = [
      {
        tableName: 'customers',
        resourceId: 'customer',
        sourceSchemaName: 'customer',
        columns: [
          { name: 'deleted', type: 'boolean', nullable: true },
          { name: 'created', type: 'bigint', nullable: false },
        ],
      },
      {
        tableName: 'plans',
        resourceId: 'plan',
        sourceSchemaName: 'plan',
        columns: [{ name: 'active', type: 'boolean', nullable: false }],
      },
    ]

    const plans = planner.buildPlans(tables)
    expect(plans.map((plan) => plan.tableName)).toEqual(['customers', 'plans'])
    expect(plans[0]).toMatchObject({
      tableName: 'customers',
      conflictTarget: ['id'],
      extraColumns: [],
      metadataColumns: ['_raw_data', '_last_synced_at', '_account_id'],
    })
    expect(plans[0].generatedColumns).toEqual([
      { column: 'created', pgType: 'bigint' },
      { column: 'deleted', pgType: 'boolean' },
    ])
  })
})
