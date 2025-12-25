-- Add last_synced_at column to all Stripe tables for tracking sync status

-- Charges
alter table "{{schema}}"."charges"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Coupons
alter table "{{schema}}"."coupons"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Credit Notes
alter table "{{schema}}"."credit_notes"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Customers
alter table "{{schema}}"."customers"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Disputes
alter table "{{schema}}"."disputes"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Early Fraud Warnings
alter table "{{schema}}"."early_fraud_warnings"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Events
alter table "{{schema}}"."events"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Invoices
alter table "{{schema}}"."invoices"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Payment Intents
alter table "{{schema}}"."payment_intents"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Payment Methods
alter table "{{schema}}"."payment_methods"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Payouts
alter table "{{schema}}"."payouts"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Plans
alter table "{{schema}}"."plans"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Prices
alter table "{{schema}}"."prices"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Products
alter table "{{schema}}"."products"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Refunds
alter table "{{schema}}"."refunds"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Reviews
alter table "{{schema}}"."reviews"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Setup Intents
alter table "{{schema}}"."setup_intents"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Subscription Items
alter table "{{schema}}"."subscription_items"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Subscription Schedules
alter table "{{schema}}"."subscription_schedules"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Subscriptions
alter table "{{schema}}"."subscriptions"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Tax IDs
alter table "{{schema}}"."tax_ids"
add column IF NOT EXISTS "last_synced_at" timestamptz;
