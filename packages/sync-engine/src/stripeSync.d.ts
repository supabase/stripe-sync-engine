import Stripe from 'stripe'
import { PostgresClient } from './database/postgres'
import { StripeSyncConfig, Sync, SyncBackfill, SyncBackfillParams } from './types'
export declare class StripeSync {
  private config
  stripe: Stripe
  postgresClient: PostgresClient
  constructor(config: StripeSyncConfig)
  processWebhook(payload: Buffer, signature: string | undefined): Promise<void>
  syncSingleEntity(
    stripeId: string
  ): Promise<
    | Stripe.Charge[]
    | (Stripe.Customer | Stripe.DeletedCustomer)[]
    | Stripe.Subscription[]
    | Stripe.TaxId[]
    | Stripe.Invoice[]
    | Stripe.Product[]
    | Stripe.Price[]
    | Stripe.SetupIntent[]
    | Stripe.PaymentMethod[]
    | Stripe.Dispute[]
    | Stripe.PaymentIntent[]
    | Stripe.CreditNote[]
    | undefined
  >
  syncBackfill(params?: SyncBackfillParams): Promise<SyncBackfill>
  syncProducts(syncParams?: SyncBackfillParams): Promise<Sync>
  syncPrices(syncParams?: SyncBackfillParams): Promise<Sync>
  syncPlans(syncParams?: SyncBackfillParams): Promise<Sync>
  syncCustomers(syncParams?: SyncBackfillParams): Promise<Sync>
  syncSubscriptions(syncParams?: SyncBackfillParams): Promise<Sync>
  syncSubscriptionSchedules(syncParams?: SyncBackfillParams): Promise<Sync>
  syncInvoices(syncParams?: SyncBackfillParams): Promise<Sync>
  syncCharges(syncParams?: SyncBackfillParams): Promise<Sync>
  syncSetupIntents(syncParams?: SyncBackfillParams): Promise<Sync>
  syncPaymentIntents(syncParams?: SyncBackfillParams): Promise<Sync>
  syncTaxIds(syncParams?: SyncBackfillParams): Promise<Sync>
  syncPaymentMethods(syncParams?: SyncBackfillParams): Promise<Sync>
  syncDisputes(syncParams?: SyncBackfillParams): Promise<Sync>
  syncCreditNotes(syncParams?: SyncBackfillParams): Promise<Sync>
  private fetchAndUpsert
  private upsertCharges
  private backfillCharges
  private upsertCreditNotes
  upsertCustomers(
    customers: (Stripe.Customer | Stripe.DeletedCustomer)[]
  ): Promise<(Stripe.Customer | Stripe.DeletedCustomer)[]>
  backfillCustomers(customerIds: string[]): Promise<void>
  upsertDisputes(
    disputes: Stripe.Dispute[],
    backfillRelatedEntities?: boolean
  ): Promise<Stripe.Dispute[]>
  upsertInvoices(
    invoices: Stripe.Invoice[],
    backfillRelatedEntities?: boolean
  ): Promise<Stripe.Invoice[]>
  backfillInvoices: (invoiceIds: string[]) => Promise<void>
  upsertPlans(plans: Stripe.Plan[], backfillRelatedEntities?: boolean): Promise<Stripe.Plan[]>
  deletePlan(id: string): Promise<boolean>
  upsertPrices(prices: Stripe.Price[], backfillRelatedEntities?: boolean): Promise<Stripe.Price[]>
  deletePrice(id: string): Promise<boolean>
  upsertProducts(products: Stripe.Product[]): Promise<Stripe.Product[]>
  deleteProduct(id: string): Promise<boolean>
  backfillProducts(productids: string[]): Promise<void>
  upsertPaymentIntents(
    paymentIntents: Stripe.PaymentIntent[],
    backfillRelatedEntities?: boolean
  ): Promise<Stripe.PaymentIntent[]>
  upsertPaymentMethods(
    paymentMethods: Stripe.PaymentMethod[],
    backfillRelatedEntities?: boolean
  ): Promise<Stripe.PaymentMethod[]>
  upsertSetupIntents(
    setupIntents: Stripe.SetupIntent[],
    backfillRelatedEntities?: boolean
  ): Promise<Stripe.SetupIntent[]>
  upsertTaxIds(taxIds: Stripe.TaxId[], backfillRelatedEntities?: boolean): Promise<Stripe.TaxId[]>
  deleteTaxId(id: string): Promise<boolean>
  upsertSubscriptionItems(subscriptionItems: Stripe.SubscriptionItem[]): Promise<void>
  markDeletedSubscriptionItems(
    subscriptionId: string,
    currentSubItemIds: string[]
  ): Promise<{
    rowCount: number
  }>
  upsertSubscriptionSchedules(
    subscriptionSchedules: Stripe.SubscriptionSchedule[],
    backfillRelatedEntities?: boolean
  ): Promise<Stripe.SubscriptionSchedule[]>
  upsertSubscriptions(
    subscriptions: Stripe.Subscription[],
    backfillRelatedEntities?: boolean
  ): Promise<Stripe.Subscription[]>
  backfillSubscriptions(subscriptionIds: string[]): Promise<void>
  backfillSubscriptionSchedules: (subscriptionIds: string[]) => Promise<void>
  private expandEntity
  private fetchMissingEntites
}
//# sourceMappingURL=stripeSync.d.ts.map
