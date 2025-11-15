-- Add _account_id column to all tables to track which Stripe account each record belongs to
-- Column is nullable for backward compatibility with existing data

ALTER TABLE "stripe"."active_entitlements" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

ALTER TABLE "stripe"."disputes" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

ALTER TABLE "stripe"."early_fraud_warnings" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

ALTER TABLE "stripe"."features" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

ALTER TABLE "stripe"."_managed_webhooks" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

ALTER TABLE "stripe"."payment_methods" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

ALTER TABLE "stripe"."plans" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

ALTER TABLE "stripe"."prices" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

ALTER TABLE "stripe"."products" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

ALTER TABLE "stripe"."refunds" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

ALTER TABLE "stripe"."reviews" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

ALTER TABLE "stripe"."setup_intents" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

ALTER TABLE "stripe"."subscription_items" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

ALTER TABLE "stripe"."tax_ids" ADD COLUMN IF NOT EXISTS "_account_id" TEXT;

