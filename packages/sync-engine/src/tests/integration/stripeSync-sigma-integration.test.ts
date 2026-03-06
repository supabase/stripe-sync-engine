import { describe, it, beforeAll, afterAll, beforeEach, vi, expect } from 'vitest'
import {
  setupTestDatabase,
  createTestStripeSync,
  upsertTestAccount,
  DatabaseValidator,
  type TestDatabase,
} from '../testSetup'
import type { StripeSync } from '../../index'
import * as sigmaApi from '../../sigma/sigmaApi'
import type { StripeObject } from '../../resourceRegistry'

const TEST_ACCOUNT_ID = 'acct_test_sigma_integration'
const SIGMA_SCHEMA = 'sigma'
const SUBSCRIPTION_ITEM_CHANGE_EVENTS_OBJECT =
  'subscription_item_change_events_v2_beta' as unknown as StripeObject
const EXCHANGE_RATES_OBJECT = 'exchange_rates_from_usd' as unknown as StripeObject

type CsvRow = Record<string, string>

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function buildCsvContentString(rows: CsvRow[]): string {
  if (rows.length === 0) {
    return ''
  }

  const headers = Object.keys(rows[0])
  const lines = [headers.map(csvEscape).join(',')]
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h] ?? '')).join(','))
  }
  return lines.join('\n')
}

function mockSigmaApiRuns(params: {
  csvs: string[]
  sqlCalls?: string[]
  validateSql?: (sql: string) => void
}): void {
  let runCount = 0

  vi.spyOn(sigmaApi, 'runSigmaQueryAndDownloadCsv').mockImplementation(async ({ sql }) => {
    params.validateSql?.(sql)
    params.sqlCalls?.push(sql)
    runCount += 1
    const queryRunId = `qr_${runCount}`
    const fileId = `file_${runCount}`
    const csv = params.csvs.shift() ?? ''
    return { queryRunId, fileId, csv }
  })
}

const BASE_EVENT_TIMESTAMP = new Date(Date.UTC(2023, 0, 1, 0, 0, 0))

function formatTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '')
}

function buildSubscriptionItemChangeEventRow(index: number, timestamp: Date): CsvRow {
  const suffix = String(index).padStart(6, '0')
  const ts = formatTimestamp(timestamp)
  return {
    product_id: `prod_sigma_${suffix}`,
    price_id: `price_sigma_${suffix}`,
    customer_id: `cus_sigma_${suffix}`,
    subscription_item_id: `si_sigma_${suffix}`,
    subscription_id: `sub_sigma_${suffix}`,
    currency: 'usd',
    event_timestamp: ts,
    event_type: 'ACTIVE_END',
    mrr_change: String(-100000 + index),
    local_event_timestamp: ts,
    quantity_change: '-1',
  }
}

function buildSubscriptionItemChangeEventRows(
  count: number,
  startIndex: number,
  startTimestamp: Date
): CsvRow[] {
  return Array.from({ length: count }, (_, i) =>
    buildSubscriptionItemChangeEventRow(
      startIndex + i,
      new Date(startTimestamp.getTime() + i * 1000)
    )
  )
}

const SUBSCRIPTION_ITEM_CHANGE_EVENTS_ROWS = buildSubscriptionItemChangeEventRows(
  250,
  1,
  BASE_EVENT_TIMESTAMP
)

const SUBSCRIPTION_ITEM_CHANGE_EVENTS_NEW_ROWS = buildSubscriptionItemChangeEventRows(
  5,
  SUBSCRIPTION_ITEM_CHANGE_EVENTS_ROWS.length + 1,
  new Date(
    BASE_EVENT_TIMESTAMP.getTime() + (SUBSCRIPTION_ITEM_CHANGE_EVENTS_ROWS.length + 10) * 1000
  )
)

const EXCHANGE_RATES_ROWS: CsvRow[] = [
  {
    date: '2021-03-07 00:00:00.000',
    sell_currency: 'usd',
    buy_currency_exchange_rates:
      '{"rub":74.3451,"sdg":380.0,"fkp":0.722788,"cuc":1.0,"idr":14399.15,"sll":10201.75017,"xpd":4.2656E-4,"bhd":3.7711499999999996,"pyg":66.64480705,"ssp":130.26,"gnf":100.8,"zmw":21.919498,"cad":1.26541,"nok":8.5574,"sar":3.752242,"jod":7.09,"xaf":5.50479606,"cve":92.625,"try":7.5388,"inr":73.1809,"xau":5.8787E-4,"bgn":1.641285,"myr":4.074,"mzn":74.6,"gel":3.325,"lbp":1524.40851,"tzs":2319.0,"szl":15.115703,"gtq":7.70379,"omr":3.85034,"bbd":2.0,"mru":35.98,"all":103.422016,"cnh":6.5083,"clp":7.33399104,"ugx":3656.29397,"gbp":0.722788,"xpt":8.8379E-4,"qar":3.641,"amd":523.335134,"xof":5.50479606,"ngn":381.0,"gip":0.722788,"srd":14.154,"uzs":10490.0,"gyd":209.115862,"sgd":1.3424,"ern":14.999786,"hkd":7.763355,"pln":3.851825,"nio":35.045,"lsl":15.287456,"dop":57.9,"nzd":1.394992,"std":20337.466992,"vnd":230.65017127,"mro":356.999828,"cup":25.75,"mur":39.853644,"pen":3.691,"tjs":11.389571,"iqd":14625.0,"pkr":157.0,"bsd":1.0,"uah":27.749278,"tmt":3.51,"mwk":780.937682,"scr":21.21469,"rwf":9.93023625,"tnd":27.43,"lrd":173.924986,"zwl":322.0,"uyu":43.923162,"bdt":84.755236,"jmd":151.091863,"vuv":1.07677018,"npr":116.427339,"egp":15.69725,"awg":1.8,"mxn":21.31519,"syp":512.870573,"azn":1.700805,"lkr":195.908041,"thb":30.556138,"clf":0.026579,"ggp":0.722788,"gmd":51.4,"kzt":419.786328,"isk":128.33,"ils":3.33261,"czk":22.0916,"lak":9365.0,"htg":77.517875,"mdl":17.550109,"khr":4060.0,"pgk":3.5325,"fjd":2.035,"bob":6.891786,"wst":2.528329,"php":48.617419,"shp":0.722788,"mga":37.44,"byn":2.60867,"djf":1.780375,"kmf":4.13350013,"kyd":0.832928,"aed":3.673,"afn":77.449998,"bzd":2.014744,"ttd":6.784727,"twd":27.9425,"cop":3649.717748,"mop":7.992612,"xpf":1.00143288,"crc":612.137816,"cny":6.4968,"lyd":4.472126,"stn":20.67,"dzd":133.142566,"ves":1872414.0,"xcd":2.70255,"svc":8.746387,"btc":2.0441459E-5,"mnt":2852.765119,"kgs":84.634401,"sos":585.0,"imp":0.722788,"aud":1.300972,"yer":250.350066,"mvr":15.4,"ron":4.0983,"cdf":1994.0,"jpy":1.0835498382,"jep":0.722788,"nad":15.36,"ang":1.794193,"bnd":1.331312,"mmk":1409.342666,"irr":42105.0,"brl":5.6911,"ars":90.297917,"xag":0.03961497,"sbd":7.985424,"bwp":11.086561,"hnl":24.35,"kwd":3.03095,"usd":1.0,"dkk":6.242,"sek":8.531268,"mkd":51.662999,"kpw":900.0,"xdr":0.698037,"top":2.283438,"btn":72.767103,"chf":0.930716,"aoa":624.234,"bam":1.635091,"huf":308.3225,"bif":19.6,"rsd":98.239368,"pab":1.0,"hrk":6.3557,"eur":0.839201,"zar":15.36436,"ghs":5.74,"kes":109.6,"mad":9.0205,"krw":11.28225,"bmd":1.0,"etb":40.25}',
  },
]

const SUBSCRIPTION_ITEM_CHANGE_EVENTS_CSV = buildCsvContentString(
  SUBSCRIPTION_ITEM_CHANGE_EVENTS_ROWS
)
const SUBSCRIPTION_ITEM_CHANGE_EVENTS_NEW_CSV = buildCsvContentString(
  SUBSCRIPTION_ITEM_CHANGE_EVENTS_NEW_ROWS
)
const EXCHANGE_RATES_CSV = buildCsvContentString(EXCHANGE_RATES_ROWS)

describe('StripeSync Sigma Integration Tests', () => {
  let sync: StripeSync
  let db: TestDatabase
  let validator: DatabaseValidator

  beforeAll(async () => {
    db = await setupTestDatabase({ enableSigma: true })
    validator = new DatabaseValidator(db.databaseUrl)
  })

  afterAll(async () => {
    if (validator) await validator.close()
    if (sync) await sync.postgresClient.pool.end()
    if (db) await db.close()
  })

  beforeEach(async () => {
    if (sync) await sync.postgresClient.pool.end()

    await validator.clearAccountData(TEST_ACCOUNT_ID, [
      `${SIGMA_SCHEMA}.subscription_item_change_events_v2_beta`,
      `${SIGMA_SCHEMA}.exchange_rates_from_usd`,
    ])

    vi.restoreAllMocks()

    sync = await createTestStripeSync({
      databaseUrl: db.databaseUrl,
      accountId: TEST_ACCOUNT_ID,
      stripeSecretKey: 'sk_test_fake_sigma',
      enableSigma: true,
    })

    await upsertTestAccount(sync, TEST_ACCOUNT_ID)
  })

  describe('fullSync (sigma)', () => {
    it('should sync subscription item change events from Sigma', async () => {
      mockSigmaApiRuns({ csvs: [SUBSCRIPTION_ITEM_CHANGE_EVENTS_CSV] })

      const result = await sync.fullSync(
        [SUBSCRIPTION_ITEM_CHANGE_EVENTS_OBJECT],
        false,
        2,
        50,
        false,
        0
      )

      expect(result.results['subscription_item_change_events_v2_beta']?.synced).toStrictEqual(
        SUBSCRIPTION_ITEM_CHANGE_EVENTS_ROWS.length
      )

      const count = await validator.getRowCount(
        `${SIGMA_SCHEMA}.subscription_item_change_events_v2_beta`,
        TEST_ACCOUNT_ID
      )
      expect(count).toStrictEqual(SUBSCRIPTION_ITEM_CHANGE_EVENTS_ROWS.length)
    })

    it('should paginate sigma results using cursor across multiple pages', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sigmaConfig = (sync as any).sigmaRegistry?.subscription_item_change_events_v2_beta
        ?.sigma
      if (!sigmaConfig) {
        throw new Error('Missing sigma config for subscription_item_change_events_v2_beta')
      }

      const originalPageSize = sigmaConfig.pageSize
      sigmaConfig.pageSize = 100

      const sqlCalls: string[] = []
      const csvs = []
      for (let i = 0; i < SUBSCRIPTION_ITEM_CHANGE_EVENTS_ROWS.length; i += sigmaConfig.pageSize) {
        const pageRows = SUBSCRIPTION_ITEM_CHANGE_EVENTS_ROWS.slice(i, i + sigmaConfig.pageSize)
        csvs.push(buildCsvContentString(pageRows))
      }
      mockSigmaApiRuns({ csvs, sqlCalls })

      try {
        const result = await sync.fullSync(
          [SUBSCRIPTION_ITEM_CHANGE_EVENTS_OBJECT],
          false,
          2,
          50,
          false,
          1
        )

        expect(sqlCalls.length).toBeGreaterThan(1)
        expect(sqlCalls[0]).not.toContain('WHERE')
        expect(sqlCalls[1]).toContain('WHERE')
        expect(result.results['subscription_item_change_events_v2_beta']?.synced).toStrictEqual(
          SUBSCRIPTION_ITEM_CHANGE_EVENTS_ROWS.length
        )
      } finally {
        sigmaConfig.pageSize = originalPageSize
      }
    })

    it('should sync exchange rates from Sigma', async () => {
      mockSigmaApiRuns({
        csvs: [EXCHANGE_RATES_CSV],
        validateSql: (sql) => {
          if (!sql.includes('exchange_rates_from_usd')) {
            throw new Error(`Unexpected Sigma query: ${sql}`)
          }
        },
      })

      const result = await sync.fullSync([EXCHANGE_RATES_OBJECT], false, 2, 50, false, 60)

      expect(result.results['exchange_rates_from_usd']?.synced).toStrictEqual(1)

      const count = await validator.getRowCount(
        `${SIGMA_SCHEMA}.exchange_rates_from_usd`,
        TEST_ACCOUNT_ID
      )
      expect(count).toStrictEqual(1)

      const keys = await validator.getColumnValues(
        `${SIGMA_SCHEMA}.exchange_rates_from_usd`,
        'date',
        TEST_ACCOUNT_ID
      )
      expect(keys).toHaveLength(1)
    })

    it('should pick up new subscription item change events on subsequent runs', async () => {
      const csvs = [SUBSCRIPTION_ITEM_CHANGE_EVENTS_CSV, SUBSCRIPTION_ITEM_CHANGE_EVENTS_NEW_CSV]
      mockSigmaApiRuns({
        csvs,
        validateSql: (sql) => {
          if (!sql.includes('subscription_item_change_events_v2_beta')) {
            throw new Error(`Unexpected Sigma query: ${sql}`)
          }
        },
      })

      const first = await sync.fullSync(
        [SUBSCRIPTION_ITEM_CHANGE_EVENTS_OBJECT],
        false,
        2,
        50,
        false,
        0
      )
      expect(first.results['subscription_item_change_events_v2_beta']?.synced).toStrictEqual(
        SUBSCRIPTION_ITEM_CHANGE_EVENTS_ROWS.length
      )

      const second = await sync.fullSync(
        [SUBSCRIPTION_ITEM_CHANGE_EVENTS_OBJECT],
        false,
        2,
        50,
        false,
        0
      )
      expect(second.results['subscription_item_change_events_v2_beta']?.synced).toStrictEqual(
        SUBSCRIPTION_ITEM_CHANGE_EVENTS_NEW_ROWS.length
      )

      const count = await validator.getRowCount(
        `${SIGMA_SCHEMA}.subscription_item_change_events_v2_beta`,
        TEST_ACCOUNT_ID
      )
      expect(count).toStrictEqual(
        SUBSCRIPTION_ITEM_CHANGE_EVENTS_ROWS.length +
          SUBSCRIPTION_ITEM_CHANGE_EVENTS_NEW_ROWS.length
      )
    })
  })
})
