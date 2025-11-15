-- Make _account_id required by:
-- 1. Deleting all rows where _account_id IS NULL
-- 2. Setting _account_id to NOT NULL

-- Delete rows with null _account_id
DELETE FROM "stripe"."active_entitlements" WHERE "_account_id" IS NULL;
DELETE FROM "stripe"."charges" WHERE "_account_id" IS NULL;
DELETE FROM "stripe"."checkout_session_line_items" WHERE "_account_id" IS NULL;
DELETE FROM "stripe"."checkout_sessions" WHERE "_account_id" IS NULL;
DELETE FROM "stripe"."credit_notes" WHERE "_account_id" IS NULL;
DELETE FROM "stripe"."customers" WHERE "_account_id" IS NULL;
DELETE FROM "stripe"."disputes" WHERE "_account_id" IS NULL;
DELETE FROM "stripe"."early_fraud_warnings" WHERE "_account_id" IS NULL;
DELETE FROM "stripe"."features" WHERE "_account_id" IS NULL;
DELETE FROM "stripe"."invoices" WHERE "_account_id" IS NULL;
DELETE FROM "stripe"."_managed_webhooks" WHERE "_account_id" IS NULL;
DELETE FROM "stripe"."payment_intents" WHERE "_account_id" IS NULL;
DELETE FROM "stripe"."payment_methods" WHERE "_account_id" IS NULL;
DELETE FROM "stripe"."plans" WHERE "_account_id" IS NULL;
DELETE FROM "stripe"."prices" WHERE "_account_id" IS NULL;
DELETE FROM "stripe"."products" WHERE "_account_id" IS NULL;
DELETE FROM "stripe"."refunds" WHERE "_account_id" IS NULL;
DELETE FROM "stripe"."reviews" WHERE "_account_id" IS NULL;
DELETE FROM "stripe"."setup_intents" WHERE "_account_id" IS NULL;
DELETE FROM "stripe"."subscription_items" WHERE "_account_id" IS NULL;
DELETE FROM "stripe"."subscription_schedules" WHERE "_account_id" IS NULL;
DELETE FROM "stripe"."subscriptions" WHERE "_account_id" IS NULL;
DELETE FROM "stripe"."tax_ids" WHERE "_account_id" IS NULL;

-- Make _account_id NOT NULL
ALTER TABLE "stripe"."active_entitlements" ALTER COLUMN "_account_id" SET NOT NULL;
ALTER TABLE "stripe"."charges" ALTER COLUMN "_account_id" SET NOT NULL;
ALTER TABLE "stripe"."checkout_session_line_items" ALTER COLUMN "_account_id" SET NOT NULL;
ALTER TABLE "stripe"."checkout_sessions" ALTER COLUMN "_account_id" SET NOT NULL;
ALTER TABLE "stripe"."credit_notes" ALTER COLUMN "_account_id" SET NOT NULL;
ALTER TABLE "stripe"."customers" ALTER COLUMN "_account_id" SET NOT NULL;
ALTER TABLE "stripe"."disputes" ALTER COLUMN "_account_id" SET NOT NULL;
ALTER TABLE "stripe"."early_fraud_warnings" ALTER COLUMN "_account_id" SET NOT NULL;
ALTER TABLE "stripe"."features" ALTER COLUMN "_account_id" SET NOT NULL;
ALTER TABLE "stripe"."invoices" ALTER COLUMN "_account_id" SET NOT NULL;
ALTER TABLE "stripe"."_managed_webhooks" ALTER COLUMN "_account_id" SET NOT NULL;
ALTER TABLE "stripe"."payment_intents" ALTER COLUMN "_account_id" SET NOT NULL;
ALTER TABLE "stripe"."payment_methods" ALTER COLUMN "_account_id" SET NOT NULL;
ALTER TABLE "stripe"."plans" ALTER COLUMN "_account_id" SET NOT NULL;
ALTER TABLE "stripe"."prices" ALTER COLUMN "_account_id" SET NOT NULL;
ALTER TABLE "stripe"."products" ALTER COLUMN "_account_id" SET NOT NULL;
ALTER TABLE "stripe"."refunds" ALTER COLUMN "_account_id" SET NOT NULL;
ALTER TABLE "stripe"."reviews" ALTER COLUMN "_account_id" SET NOT NULL;
ALTER TABLE "stripe"."setup_intents" ALTER COLUMN "_account_id" SET NOT NULL;
ALTER TABLE "stripe"."subscription_items" ALTER COLUMN "_account_id" SET NOT NULL;
ALTER TABLE "stripe"."subscription_schedules" ALTER COLUMN "_account_id" SET NOT NULL;
ALTER TABLE "stripe"."subscriptions" ALTER COLUMN "_account_id" SET NOT NULL;
ALTER TABLE "stripe"."tax_ids" ALTER COLUMN "_account_id" SET NOT NULL;

