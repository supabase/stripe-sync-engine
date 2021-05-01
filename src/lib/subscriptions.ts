import Subscription from 'stripe'
import { query } from '../utils/PostgresConnection'
import { pg as sql } from 'yesql'
import { getConfig } from '../utils/config'

const config = getConfig()

export const upsertSubscription = async (
  subscription: Subscription.Subscription
): Promise<Subscription.Subscription[]> => {
  const prepared = sql(`
    insert into "${config.SCHEMA}"."subscriptions" (
      id,
      cancel_at_period_end,
      current_period_end,
      current_period_start,
      default_payment_method,
      items,
      metadata,
      pending_setup_intent,
      pending_update,
      status,
      application_fee_percent,
      billing_cycle_anchor,
      billing_thresholds,
      cancel_at,
      canceled_at,
      collection_method,
      created,
      days_until_due,
      default_source,
      default_tax_rates,
      discount,
      ended_at,
      livemode,
      next_pending_invoice_item_invoice,
      pause_collection,
      pending_invoice_item_interval,
      start_date,
      transfer_data,
      trial_end,
      trial_start,
      schedule,
      customer,
      latest_invoice
    )
    values (
      :id,
      :cancel_at_period_end,
      :current_period_end,
      :current_period_start,
      :default_payment_method,
      :items,
      :metadata,
      :pending_setup_intent,
      :pending_update,
      :status,
      :application_fee_percent,
      :billing_cycle_anchor,
      :billing_thresholds,
      :cancel_at,
      :canceled_at,
      :collection_method,
      :created,
      :days_until_due,
      :default_source,
      :default_tax_rates,
      :discount,
      :ended_at,
      :livemode,
      :next_pending_invoice_item_invoice,
      :pause_collection,
      :pending_invoice_item_interval,
      :start_date,
      :transfer_data,
      :trial_end,
      :trial_start,
      :schedule,
      :customer,
      :latest_invoice
    )
    on conflict(
      id
    )
    do update set 
      id = :id,
      cancel_at_period_end = :cancel_at_period_end,
      current_period_end = :current_period_end,
      current_period_start = :current_period_start,
      default_payment_method = :default_payment_method,
      items = :items,
      metadata = :metadata,
      pending_setup_intent = :pending_setup_intent,
      pending_update = :pending_update,
      status = :status,
      application_fee_percent = :application_fee_percent,
      billing_cycle_anchor = :billing_cycle_anchor,
      billing_thresholds = :billing_thresholds,
      cancel_at = :cancel_at,
      canceled_at = :canceled_at,
      collection_method = :collection_method,
      created = :created,
      days_until_due = :days_until_due,
      default_source = :default_source,
      default_tax_rates = :default_tax_rates,
      discount = :discount,
      ended_at = :ended_at,
      livemode = :livemode,
      next_pending_invoice_item_invoice = :next_pending_invoice_item_invoice,
      pause_collection = :pause_collection,
      pending_invoice_item_interval = :pending_invoice_item_interval,
      start_date = :start_date,
      transfer_data = :transfer_data,
      trial_end = :trial_end,
      trial_start = :trial_start,
      schedule = :schedule,
      customer = :customer,
      latest_invoice = :latest_invoice;
    `)(subscription)
  const { rows } = await query(prepared.text, prepared.values)
  return rows
}
