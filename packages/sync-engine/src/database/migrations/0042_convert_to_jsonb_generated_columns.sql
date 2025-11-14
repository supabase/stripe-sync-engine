-- Convert all tables to use jsonb raw_data as source of truth with generated columns
-- This migration adds raw_data column and converts all existing columns to generated columns

-- ============================================================================
-- ACTIVE_ENTITLEMENTS
-- ============================================================================

-- Add raw_data column
ALTER TABLE "stripe"."active_entitlements" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop indexes (will be recreated on generated columns)
DROP INDEX IF EXISTS "stripe"."stripe_active_entitlements_customer_idx";
DROP INDEX IF EXISTS "stripe"."stripe_active_entitlements_feature_idx";

-- Drop unique constraint (will be recreated on generated column)
ALTER TABLE "stripe"."active_entitlements" DROP CONSTRAINT IF EXISTS "active_entitlements_lookup_key_key";

-- Drop existing columns and recreate as generated columns
ALTER TABLE "stripe"."active_entitlements" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."active_entitlements" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."active_entitlements" DROP COLUMN IF EXISTS "livemode";
ALTER TABLE "stripe"."active_entitlements" ADD COLUMN "livemode" boolean GENERATED ALWAYS AS ((raw_data->>'livemode')::boolean) STORED;

ALTER TABLE "stripe"."active_entitlements" DROP COLUMN IF EXISTS "feature";
ALTER TABLE "stripe"."active_entitlements" ADD COLUMN "feature" text GENERATED ALWAYS AS ((raw_data->>'feature')::text) STORED;

ALTER TABLE "stripe"."active_entitlements" DROP COLUMN IF EXISTS "customer";
ALTER TABLE "stripe"."active_entitlements" ADD COLUMN "customer" text GENERATED ALWAYS AS ((raw_data->>'customer')::text) STORED;

ALTER TABLE "stripe"."active_entitlements" DROP COLUMN IF EXISTS "lookup_key";
ALTER TABLE "stripe"."active_entitlements" ADD COLUMN "lookup_key" text GENERATED ALWAYS AS ((raw_data->>'lookup_key')::text) STORED;

-- Recreate indexes
CREATE INDEX stripe_active_entitlements_customer_idx ON "stripe"."active_entitlements" USING btree (customer);
CREATE INDEX stripe_active_entitlements_feature_idx ON "stripe"."active_entitlements" USING btree (feature);

-- Recreate unique constraint
CREATE UNIQUE INDEX active_entitlements_lookup_key_key ON "stripe"."active_entitlements" (lookup_key) WHERE lookup_key IS NOT NULL;

-- ============================================================================
-- CHARGES
-- ============================================================================

ALTER TABLE "stripe"."charges" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop and recreate columns as generated
ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."charges" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "paid";
ALTER TABLE "stripe"."charges" ADD COLUMN "paid" boolean GENERATED ALWAYS AS ((raw_data->>'paid')::boolean) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "order";
ALTER TABLE "stripe"."charges" ADD COLUMN "order" text GENERATED ALWAYS AS ((raw_data->>'order')::text) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "amount";
ALTER TABLE "stripe"."charges" ADD COLUMN "amount" bigint GENERATED ALWAYS AS ((raw_data->>'amount')::bigint) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "review";
ALTER TABLE "stripe"."charges" ADD COLUMN "review" text GENERATED ALWAYS AS ((raw_data->>'review')::text) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "source";
ALTER TABLE "stripe"."charges" ADD COLUMN "source" jsonb GENERATED ALWAYS AS (raw_data->'source') STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "status";
ALTER TABLE "stripe"."charges" ADD COLUMN "status" text GENERATED ALWAYS AS ((raw_data->>'status')::text) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "created";
ALTER TABLE "stripe"."charges" ADD COLUMN "created" integer GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "dispute";
ALTER TABLE "stripe"."charges" ADD COLUMN "dispute" text GENERATED ALWAYS AS ((raw_data->>'dispute')::text) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "invoice";
ALTER TABLE "stripe"."charges" ADD COLUMN "invoice" text GENERATED ALWAYS AS ((raw_data->>'invoice')::text) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "outcome";
ALTER TABLE "stripe"."charges" ADD COLUMN "outcome" jsonb GENERATED ALWAYS AS (raw_data->'outcome') STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "refunds";
ALTER TABLE "stripe"."charges" ADD COLUMN "refunds" jsonb GENERATED ALWAYS AS (raw_data->'refunds') STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "updated";
ALTER TABLE "stripe"."charges" ADD COLUMN "updated" integer GENERATED ALWAYS AS ((raw_data->>'updated')::integer) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "captured";
ALTER TABLE "stripe"."charges" ADD COLUMN "captured" boolean GENERATED ALWAYS AS ((raw_data->>'captured')::boolean) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "currency";
ALTER TABLE "stripe"."charges" ADD COLUMN "currency" text GENERATED ALWAYS AS ((raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "customer";
ALTER TABLE "stripe"."charges" ADD COLUMN "customer" text GENERATED ALWAYS AS ((raw_data->>'customer')::text) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "livemode";
ALTER TABLE "stripe"."charges" ADD COLUMN "livemode" boolean GENERATED ALWAYS AS ((raw_data->>'livemode')::boolean) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "metadata";
ALTER TABLE "stripe"."charges" ADD COLUMN "metadata" jsonb GENERATED ALWAYS AS (raw_data->'metadata') STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "refunded";
ALTER TABLE "stripe"."charges" ADD COLUMN "refunded" boolean GENERATED ALWAYS AS ((raw_data->>'refunded')::boolean) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "shipping";
ALTER TABLE "stripe"."charges" ADD COLUMN "shipping" jsonb GENERATED ALWAYS AS (raw_data->'shipping') STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "application";
ALTER TABLE "stripe"."charges" ADD COLUMN "application" text GENERATED ALWAYS AS ((raw_data->>'application')::text) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "description";
ALTER TABLE "stripe"."charges" ADD COLUMN "description" text GENERATED ALWAYS AS ((raw_data->>'description')::text) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "destination";
ALTER TABLE "stripe"."charges" ADD COLUMN "destination" text GENERATED ALWAYS AS ((raw_data->>'destination')::text) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "failure_code";
ALTER TABLE "stripe"."charges" ADD COLUMN "failure_code" text GENERATED ALWAYS AS ((raw_data->>'failure_code')::text) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "on_behalf_of";
ALTER TABLE "stripe"."charges" ADD COLUMN "on_behalf_of" text GENERATED ALWAYS AS ((raw_data->>'on_behalf_of')::text) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "fraud_details";
ALTER TABLE "stripe"."charges" ADD COLUMN "fraud_details" jsonb GENERATED ALWAYS AS (raw_data->'fraud_details') STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "receipt_email";
ALTER TABLE "stripe"."charges" ADD COLUMN "receipt_email" text GENERATED ALWAYS AS ((raw_data->>'receipt_email')::text) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "payment_intent";
ALTER TABLE "stripe"."charges" ADD COLUMN "payment_intent" text GENERATED ALWAYS AS ((raw_data->>'payment_intent')::text) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "receipt_number";
ALTER TABLE "stripe"."charges" ADD COLUMN "receipt_number" text GENERATED ALWAYS AS ((raw_data->>'receipt_number')::text) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "transfer_group";
ALTER TABLE "stripe"."charges" ADD COLUMN "transfer_group" text GENERATED ALWAYS AS ((raw_data->>'transfer_group')::text) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "amount_refunded";
ALTER TABLE "stripe"."charges" ADD COLUMN "amount_refunded" bigint GENERATED ALWAYS AS ((raw_data->>'amount_refunded')::bigint) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "application_fee";
ALTER TABLE "stripe"."charges" ADD COLUMN "application_fee" text GENERATED ALWAYS AS ((raw_data->>'application_fee')::text) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "failure_message";
ALTER TABLE "stripe"."charges" ADD COLUMN "failure_message" text GENERATED ALWAYS AS ((raw_data->>'failure_message')::text) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "source_transfer";
ALTER TABLE "stripe"."charges" ADD COLUMN "source_transfer" text GENERATED ALWAYS AS ((raw_data->>'source_transfer')::text) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "balance_transaction";
ALTER TABLE "stripe"."charges" ADD COLUMN "balance_transaction" text GENERATED ALWAYS AS ((raw_data->>'balance_transaction')::text) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "statement_descriptor";
ALTER TABLE "stripe"."charges" ADD COLUMN "statement_descriptor" text GENERATED ALWAYS AS ((raw_data->>'statement_descriptor')::text) STORED;

ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "payment_method_details";
ALTER TABLE "stripe"."charges" ADD COLUMN "payment_method_details" jsonb GENERATED ALWAYS AS (raw_data->'payment_method_details') STORED;

-- ============================================================================
-- CHECKOUT_SESSION_LINE_ITEMS
-- ============================================================================

ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop indexes
DROP INDEX IF EXISTS "stripe"."stripe_checkout_session_line_items_session_idx";
DROP INDEX IF EXISTS "stripe"."stripe_checkout_session_line_items_price_idx";

-- Drop and recreate columns as generated
ALTER TABLE "stripe"."checkout_session_line_items" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."checkout_session_line_items" DROP COLUMN IF EXISTS "amount_discount";
ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN "amount_discount" integer GENERATED ALWAYS AS ((raw_data->>'amount_discount')::integer) STORED;

ALTER TABLE "stripe"."checkout_session_line_items" DROP COLUMN IF EXISTS "amount_subtotal";
ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN "amount_subtotal" integer GENERATED ALWAYS AS ((raw_data->>'amount_subtotal')::integer) STORED;

ALTER TABLE "stripe"."checkout_session_line_items" DROP COLUMN IF EXISTS "amount_tax";
ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN "amount_tax" integer GENERATED ALWAYS AS ((raw_data->>'amount_tax')::integer) STORED;

ALTER TABLE "stripe"."checkout_session_line_items" DROP COLUMN IF EXISTS "amount_total";
ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN "amount_total" integer GENERATED ALWAYS AS ((raw_data->>'amount_total')::integer) STORED;

ALTER TABLE "stripe"."checkout_session_line_items" DROP COLUMN IF EXISTS "currency";
ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN "currency" text GENERATED ALWAYS AS ((raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."checkout_session_line_items" DROP COLUMN IF EXISTS "description";
ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN "description" text GENERATED ALWAYS AS ((raw_data->>'description')::text) STORED;

ALTER TABLE "stripe"."checkout_session_line_items" DROP COLUMN IF EXISTS "price";
ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN "price" text GENERATED ALWAYS AS ((raw_data->>'price')::text) STORED;

ALTER TABLE "stripe"."checkout_session_line_items" DROP COLUMN IF EXISTS "quantity";
ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN "quantity" integer GENERATED ALWAYS AS ((raw_data->>'quantity')::integer) STORED;

ALTER TABLE "stripe"."checkout_session_line_items" DROP COLUMN IF EXISTS "checkout_session";
ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN "checkout_session" text GENERATED ALWAYS AS ((raw_data->>'checkout_session')::text) STORED;

-- Recreate indexes
CREATE INDEX stripe_checkout_session_line_items_session_idx ON "stripe"."checkout_session_line_items" USING btree (checkout_session);
CREATE INDEX stripe_checkout_session_line_items_price_idx ON "stripe"."checkout_session_line_items" USING btree (price);

-- ============================================================================
-- CHECKOUT_SESSIONS
-- ============================================================================

ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop indexes
DROP INDEX IF EXISTS "stripe"."stripe_checkout_sessions_customer_idx";
DROP INDEX IF EXISTS "stripe"."stripe_checkout_sessions_subscription_idx";
DROP INDEX IF EXISTS "stripe"."stripe_checkout_sessions_payment_intent_idx";
DROP INDEX IF EXISTS "stripe"."stripe_checkout_sessions_invoice_idx";

-- Drop and recreate columns as generated (all columns from checkoutSessionSchema)
ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "adaptive_pricing";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "adaptive_pricing" jsonb GENERATED ALWAYS AS (raw_data->'adaptive_pricing') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "after_expiration";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "after_expiration" jsonb GENERATED ALWAYS AS (raw_data->'after_expiration') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "allow_promotion_codes";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "allow_promotion_codes" boolean GENERATED ALWAYS AS ((raw_data->>'allow_promotion_codes')::boolean) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "amount_subtotal";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "amount_subtotal" integer GENERATED ALWAYS AS ((raw_data->>'amount_subtotal')::integer) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "amount_total";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "amount_total" integer GENERATED ALWAYS AS ((raw_data->>'amount_total')::integer) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "automatic_tax";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "automatic_tax" jsonb GENERATED ALWAYS AS (raw_data->'automatic_tax') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "billing_address_collection";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "billing_address_collection" text GENERATED ALWAYS AS ((raw_data->>'billing_address_collection')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "cancel_url";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "cancel_url" text GENERATED ALWAYS AS ((raw_data->>'cancel_url')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "client_reference_id";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "client_reference_id" text GENERATED ALWAYS AS ((raw_data->>'client_reference_id')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "client_secret";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "client_secret" text GENERATED ALWAYS AS ((raw_data->>'client_secret')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "collected_information";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "collected_information" jsonb GENERATED ALWAYS AS (raw_data->'collected_information') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "consent";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "consent" jsonb GENERATED ALWAYS AS (raw_data->'consent') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "consent_collection";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "consent_collection" jsonb GENERATED ALWAYS AS (raw_data->'consent_collection') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "created";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "created" integer GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "currency";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "currency" text GENERATED ALWAYS AS ((raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "currency_conversion";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "currency_conversion" jsonb GENERATED ALWAYS AS (raw_data->'currency_conversion') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "custom_fields";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "custom_fields" jsonb GENERATED ALWAYS AS (raw_data->'custom_fields') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "custom_text";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "custom_text" jsonb GENERATED ALWAYS AS (raw_data->'custom_text') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "customer";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "customer" text GENERATED ALWAYS AS ((raw_data->>'customer')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "customer_creation";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "customer_creation" text GENERATED ALWAYS AS ((raw_data->>'customer_creation')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "customer_details";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "customer_details" jsonb GENERATED ALWAYS AS (raw_data->'customer_details') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "customer_email";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "customer_email" text GENERATED ALWAYS AS ((raw_data->>'customer_email')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "discounts";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "discounts" jsonb GENERATED ALWAYS AS (raw_data->'discounts') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "expires_at";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "expires_at" integer GENERATED ALWAYS AS ((raw_data->>'expires_at')::integer) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "invoice";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "invoice" text GENERATED ALWAYS AS ((raw_data->>'invoice')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "invoice_creation";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "invoice_creation" jsonb GENERATED ALWAYS AS (raw_data->'invoice_creation') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "livemode";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "livemode" boolean GENERATED ALWAYS AS ((raw_data->>'livemode')::boolean) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "locale";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "locale" text GENERATED ALWAYS AS ((raw_data->>'locale')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "metadata";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "metadata" jsonb GENERATED ALWAYS AS (raw_data->'metadata') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "mode";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "mode" text GENERATED ALWAYS AS ((raw_data->>'mode')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "optional_items";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "optional_items" jsonb GENERATED ALWAYS AS (raw_data->'optional_items') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "payment_intent";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "payment_intent" text GENERATED ALWAYS AS ((raw_data->>'payment_intent')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "payment_link";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "payment_link" text GENERATED ALWAYS AS ((raw_data->>'payment_link')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "payment_method_collection";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "payment_method_collection" text GENERATED ALWAYS AS ((raw_data->>'payment_method_collection')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "payment_method_configuration_details";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "payment_method_configuration_details" jsonb GENERATED ALWAYS AS (raw_data->'payment_method_configuration_details') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "payment_method_options";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "payment_method_options" jsonb GENERATED ALWAYS AS (raw_data->'payment_method_options') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "payment_method_types";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "payment_method_types" jsonb GENERATED ALWAYS AS (raw_data->'payment_method_types') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "payment_status";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "payment_status" text GENERATED ALWAYS AS ((raw_data->>'payment_status')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "permissions";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "permissions" jsonb GENERATED ALWAYS AS (raw_data->'permissions') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "phone_number_collection";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "phone_number_collection" jsonb GENERATED ALWAYS AS (raw_data->'phone_number_collection') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "presentment_details";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "presentment_details" jsonb GENERATED ALWAYS AS (raw_data->'presentment_details') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "recovered_from";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "recovered_from" text GENERATED ALWAYS AS ((raw_data->>'recovered_from')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "redirect_on_completion";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "redirect_on_completion" text GENERATED ALWAYS AS ((raw_data->>'redirect_on_completion')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "return_url";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "return_url" text GENERATED ALWAYS AS ((raw_data->>'return_url')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "saved_payment_method_options";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "saved_payment_method_options" jsonb GENERATED ALWAYS AS (raw_data->'saved_payment_method_options') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "setup_intent";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "setup_intent" text GENERATED ALWAYS AS ((raw_data->>'setup_intent')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "shipping_address_collection";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "shipping_address_collection" jsonb GENERATED ALWAYS AS (raw_data->'shipping_address_collection') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "shipping_cost";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "shipping_cost" jsonb GENERATED ALWAYS AS (raw_data->'shipping_cost') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "shipping_details";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "shipping_details" jsonb GENERATED ALWAYS AS (raw_data->'shipping_details') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "shipping_options";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "shipping_options" jsonb GENERATED ALWAYS AS (raw_data->'shipping_options') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "status";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "status" text GENERATED ALWAYS AS ((raw_data->>'status')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "submit_type";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "submit_type" text GENERATED ALWAYS AS ((raw_data->>'submit_type')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "subscription";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "subscription" text GENERATED ALWAYS AS ((raw_data->>'subscription')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "success_url";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "success_url" text GENERATED ALWAYS AS ((raw_data->>'success_url')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "tax_id_collection";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "tax_id_collection" jsonb GENERATED ALWAYS AS (raw_data->'tax_id_collection') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "total_details";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "total_details" jsonb GENERATED ALWAYS AS (raw_data->'total_details') STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "ui_mode";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "ui_mode" text GENERATED ALWAYS AS ((raw_data->>'ui_mode')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "url";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "url" text GENERATED ALWAYS AS ((raw_data->>'url')::text) STORED;

ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "wallet_options";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "wallet_options" jsonb GENERATED ALWAYS AS (raw_data->'wallet_options') STORED;

-- Recreate indexes
CREATE INDEX stripe_checkout_sessions_customer_idx ON "stripe"."checkout_sessions" USING btree (customer);
CREATE INDEX stripe_checkout_sessions_subscription_idx ON "stripe"."checkout_sessions" USING btree (subscription);
CREATE INDEX stripe_checkout_sessions_payment_intent_idx ON "stripe"."checkout_sessions" USING btree (payment_intent);
CREATE INDEX stripe_checkout_sessions_invoice_idx ON "stripe"."checkout_sessions" USING btree (invoice);

-- ============================================================================
-- COUPONS
-- ============================================================================

ALTER TABLE "stripe"."coupons" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop and recreate columns as generated
ALTER TABLE "stripe"."coupons" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."coupons" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."coupons" DROP COLUMN IF EXISTS "name";
ALTER TABLE "stripe"."coupons" ADD COLUMN "name" text GENERATED ALWAYS AS ((raw_data->>'name')::text) STORED;

ALTER TABLE "stripe"."coupons" DROP COLUMN IF EXISTS "valid";
ALTER TABLE "stripe"."coupons" ADD COLUMN "valid" boolean GENERATED ALWAYS AS ((raw_data->>'valid')::boolean) STORED;

ALTER TABLE "stripe"."coupons" DROP COLUMN IF EXISTS "created";
ALTER TABLE "stripe"."coupons" ADD COLUMN "created" integer GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED;

ALTER TABLE "stripe"."coupons" DROP COLUMN IF EXISTS "updated";
ALTER TABLE "stripe"."coupons" ADD COLUMN "updated" integer GENERATED ALWAYS AS ((raw_data->>'updated')::integer) STORED;

ALTER TABLE "stripe"."coupons" DROP COLUMN IF EXISTS "currency";
ALTER TABLE "stripe"."coupons" ADD COLUMN "currency" text GENERATED ALWAYS AS ((raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."coupons" DROP COLUMN IF EXISTS "duration";
ALTER TABLE "stripe"."coupons" ADD COLUMN "duration" text GENERATED ALWAYS AS ((raw_data->>'duration')::text) STORED;

ALTER TABLE "stripe"."coupons" DROP COLUMN IF EXISTS "livemode";
ALTER TABLE "stripe"."coupons" ADD COLUMN "livemode" boolean GENERATED ALWAYS AS ((raw_data->>'livemode')::boolean) STORED;

ALTER TABLE "stripe"."coupons" DROP COLUMN IF EXISTS "metadata";
ALTER TABLE "stripe"."coupons" ADD COLUMN "metadata" jsonb GENERATED ALWAYS AS (raw_data->'metadata') STORED;

ALTER TABLE "stripe"."coupons" DROP COLUMN IF EXISTS "redeem_by";
ALTER TABLE "stripe"."coupons" ADD COLUMN "redeem_by" integer GENERATED ALWAYS AS ((raw_data->>'redeem_by')::integer) STORED;

ALTER TABLE "stripe"."coupons" DROP COLUMN IF EXISTS "amount_off";
ALTER TABLE "stripe"."coupons" ADD COLUMN "amount_off" bigint GENERATED ALWAYS AS ((raw_data->>'amount_off')::bigint) STORED;

ALTER TABLE "stripe"."coupons" DROP COLUMN IF EXISTS "percent_off";
ALTER TABLE "stripe"."coupons" ADD COLUMN "percent_off" double precision GENERATED ALWAYS AS ((raw_data->>'percent_off')::double precision) STORED;

ALTER TABLE "stripe"."coupons" DROP COLUMN IF EXISTS "times_redeemed";
ALTER TABLE "stripe"."coupons" ADD COLUMN "times_redeemed" bigint GENERATED ALWAYS AS ((raw_data->>'times_redeemed')::bigint) STORED;

ALTER TABLE "stripe"."coupons" DROP COLUMN IF EXISTS "max_redemptions";
ALTER TABLE "stripe"."coupons" ADD COLUMN "max_redemptions" bigint GENERATED ALWAYS AS ((raw_data->>'max_redemptions')::bigint) STORED;

ALTER TABLE "stripe"."coupons" DROP COLUMN IF EXISTS "duration_in_months";
ALTER TABLE "stripe"."coupons" ADD COLUMN "duration_in_months" bigint GENERATED ALWAYS AS ((raw_data->>'duration_in_months')::bigint) STORED;

ALTER TABLE "stripe"."coupons" DROP COLUMN IF EXISTS "percent_off_precise";
ALTER TABLE "stripe"."coupons" ADD COLUMN "percent_off_precise" double precision GENERATED ALWAYS AS ((raw_data->>'percent_off_precise')::double precision) STORED;

-- ============================================================================
-- CREDIT_NOTES
-- ============================================================================

ALTER TABLE "stripe"."credit_notes" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop indexes
DROP INDEX IF EXISTS "stripe"."stripe_credit_notes_customer_idx";
DROP INDEX IF EXISTS "stripe"."stripe_credit_notes_invoice_idx";

-- Drop and recreate columns as generated
ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "amount";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "amount" integer GENERATED ALWAYS AS ((raw_data->>'amount')::integer) STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "amount_shipping";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "amount_shipping" integer GENERATED ALWAYS AS ((raw_data->>'amount_shipping')::integer) STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "created";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "created" integer GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "currency";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "currency" text GENERATED ALWAYS AS ((raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "customer";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "customer" text GENERATED ALWAYS AS ((raw_data->>'customer')::text) STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "customer_balance_transaction";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "customer_balance_transaction" text GENERATED ALWAYS AS ((raw_data->>'customer_balance_transaction')::text) STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "discount_amount";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "discount_amount" integer GENERATED ALWAYS AS ((raw_data->>'discount_amount')::integer) STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "discount_amounts";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "discount_amounts" jsonb GENERATED ALWAYS AS (raw_data->'discount_amounts') STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "invoice";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "invoice" text GENERATED ALWAYS AS ((raw_data->>'invoice')::text) STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "lines";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "lines" jsonb GENERATED ALWAYS AS (raw_data->'lines') STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "livemode";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "livemode" boolean GENERATED ALWAYS AS ((raw_data->>'livemode')::boolean) STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "memo";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "memo" text GENERATED ALWAYS AS ((raw_data->>'memo')::text) STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "metadata";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "metadata" jsonb GENERATED ALWAYS AS (raw_data->'metadata') STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "number";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "number" text GENERATED ALWAYS AS ((raw_data->>'number')::text) STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "out_of_band_amount";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "out_of_band_amount" integer GENERATED ALWAYS AS ((raw_data->>'out_of_band_amount')::integer) STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "pdf";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "pdf" text GENERATED ALWAYS AS ((raw_data->>'pdf')::text) STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "reason";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "reason" text GENERATED ALWAYS AS ((raw_data->>'reason')::text) STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "refund";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "refund" text GENERATED ALWAYS AS ((raw_data->>'refund')::text) STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "shipping_cost";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "shipping_cost" jsonb GENERATED ALWAYS AS (raw_data->'shipping_cost') STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "status";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "status" text GENERATED ALWAYS AS ((raw_data->>'status')::text) STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "subtotal";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "subtotal" integer GENERATED ALWAYS AS ((raw_data->>'subtotal')::integer) STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "subtotal_excluding_tax";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "subtotal_excluding_tax" integer GENERATED ALWAYS AS ((raw_data->>'subtotal_excluding_tax')::integer) STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "tax_amounts";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "tax_amounts" jsonb GENERATED ALWAYS AS (raw_data->'tax_amounts') STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "total";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "total" integer GENERATED ALWAYS AS ((raw_data->>'total')::integer) STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "total_excluding_tax";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "total_excluding_tax" integer GENERATED ALWAYS AS ((raw_data->>'total_excluding_tax')::integer) STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "type";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "type" text GENERATED ALWAYS AS ((raw_data->>'type')::text) STORED;

ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "voided_at";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "voided_at" text GENERATED ALWAYS AS ((raw_data->>'voided_at')::text) STORED;

-- Recreate indexes
CREATE INDEX stripe_credit_notes_customer_idx ON "stripe"."credit_notes" USING btree (customer);
CREATE INDEX stripe_credit_notes_invoice_idx ON "stripe"."credit_notes" USING btree (invoice);

-- ============================================================================
-- CUSTOMERS
-- ============================================================================

ALTER TABLE "stripe"."customers" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop and recreate columns as generated
ALTER TABLE "stripe"."customers" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."customers" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."customers" DROP COLUMN IF EXISTS "address";
ALTER TABLE "stripe"."customers" ADD COLUMN "address" jsonb GENERATED ALWAYS AS (raw_data->'address') STORED;

ALTER TABLE "stripe"."customers" DROP COLUMN IF EXISTS "description";
ALTER TABLE "stripe"."customers" ADD COLUMN "description" text GENERATED ALWAYS AS ((raw_data->>'description')::text) STORED;

ALTER TABLE "stripe"."customers" DROP COLUMN IF EXISTS "email";
ALTER TABLE "stripe"."customers" ADD COLUMN "email" text GENERATED ALWAYS AS ((raw_data->>'email')::text) STORED;

ALTER TABLE "stripe"."customers" DROP COLUMN IF EXISTS "metadata";
ALTER TABLE "stripe"."customers" ADD COLUMN "metadata" jsonb GENERATED ALWAYS AS (raw_data->'metadata') STORED;

ALTER TABLE "stripe"."customers" DROP COLUMN IF EXISTS "name";
ALTER TABLE "stripe"."customers" ADD COLUMN "name" text GENERATED ALWAYS AS ((raw_data->>'name')::text) STORED;

ALTER TABLE "stripe"."customers" DROP COLUMN IF EXISTS "phone";
ALTER TABLE "stripe"."customers" ADD COLUMN "phone" text GENERATED ALWAYS AS ((raw_data->>'phone')::text) STORED;

ALTER TABLE "stripe"."customers" DROP COLUMN IF EXISTS "shipping";
ALTER TABLE "stripe"."customers" ADD COLUMN "shipping" jsonb GENERATED ALWAYS AS (raw_data->'shipping') STORED;

ALTER TABLE "stripe"."customers" DROP COLUMN IF EXISTS "balance";
ALTER TABLE "stripe"."customers" ADD COLUMN "balance" integer GENERATED ALWAYS AS ((raw_data->>'balance')::integer) STORED;

ALTER TABLE "stripe"."customers" DROP COLUMN IF EXISTS "created";
ALTER TABLE "stripe"."customers" ADD COLUMN "created" integer GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED;

ALTER TABLE "stripe"."customers" DROP COLUMN IF EXISTS "currency";
ALTER TABLE "stripe"."customers" ADD COLUMN "currency" text GENERATED ALWAYS AS ((raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."customers" DROP COLUMN IF EXISTS "default_source";
ALTER TABLE "stripe"."customers" ADD COLUMN "default_source" text GENERATED ALWAYS AS ((raw_data->>'default_source')::text) STORED;

ALTER TABLE "stripe"."customers" DROP COLUMN IF EXISTS "delinquent";
ALTER TABLE "stripe"."customers" ADD COLUMN "delinquent" boolean GENERATED ALWAYS AS ((raw_data->>'delinquent')::boolean) STORED;

ALTER TABLE "stripe"."customers" DROP COLUMN IF EXISTS "discount";
ALTER TABLE "stripe"."customers" ADD COLUMN "discount" jsonb GENERATED ALWAYS AS (raw_data->'discount') STORED;

ALTER TABLE "stripe"."customers" DROP COLUMN IF EXISTS "invoice_prefix";
ALTER TABLE "stripe"."customers" ADD COLUMN "invoice_prefix" text GENERATED ALWAYS AS ((raw_data->>'invoice_prefix')::text) STORED;

ALTER TABLE "stripe"."customers" DROP COLUMN IF EXISTS "invoice_settings";
ALTER TABLE "stripe"."customers" ADD COLUMN "invoice_settings" jsonb GENERATED ALWAYS AS (raw_data->'invoice_settings') STORED;

ALTER TABLE "stripe"."customers" DROP COLUMN IF EXISTS "livemode";
ALTER TABLE "stripe"."customers" ADD COLUMN "livemode" boolean GENERATED ALWAYS AS ((raw_data->>'livemode')::boolean) STORED;

ALTER TABLE "stripe"."customers" DROP COLUMN IF EXISTS "next_invoice_sequence";
ALTER TABLE "stripe"."customers" ADD COLUMN "next_invoice_sequence" integer GENERATED ALWAYS AS ((raw_data->>'next_invoice_sequence')::integer) STORED;

ALTER TABLE "stripe"."customers" DROP COLUMN IF EXISTS "preferred_locales";
ALTER TABLE "stripe"."customers" ADD COLUMN "preferred_locales" jsonb GENERATED ALWAYS AS (raw_data->'preferred_locales') STORED;

ALTER TABLE "stripe"."customers" DROP COLUMN IF EXISTS "tax_exempt";
ALTER TABLE "stripe"."customers" ADD COLUMN "tax_exempt" text GENERATED ALWAYS AS ((raw_data->>'tax_exempt')::text) STORED;

ALTER TABLE "stripe"."customers" DROP COLUMN IF EXISTS "deleted";
ALTER TABLE "stripe"."customers" ADD COLUMN "deleted" boolean GENERATED ALWAYS AS ((raw_data->>'deleted')::boolean) STORED;

-- ============================================================================
-- DISPUTES
-- ============================================================================

ALTER TABLE "stripe"."disputes" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop indexes
DROP INDEX IF EXISTS "stripe"."stripe_dispute_created_idx";

-- Drop and recreate columns as generated
ALTER TABLE "stripe"."disputes" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."disputes" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."disputes" DROP COLUMN IF EXISTS "amount";
ALTER TABLE "stripe"."disputes" ADD COLUMN "amount" bigint GENERATED ALWAYS AS ((raw_data->>'amount')::bigint) STORED;

ALTER TABLE "stripe"."disputes" DROP COLUMN IF EXISTS "charge";
ALTER TABLE "stripe"."disputes" ADD COLUMN "charge" text GENERATED ALWAYS AS ((raw_data->>'charge')::text) STORED;

ALTER TABLE "stripe"."disputes" DROP COLUMN IF EXISTS "reason";
ALTER TABLE "stripe"."disputes" ADD COLUMN "reason" text GENERATED ALWAYS AS ((raw_data->>'reason')::text) STORED;

ALTER TABLE "stripe"."disputes" DROP COLUMN IF EXISTS "status";
ALTER TABLE "stripe"."disputes" ADD COLUMN "status" text GENERATED ALWAYS AS ((raw_data->>'status')::text) STORED;

ALTER TABLE "stripe"."disputes" DROP COLUMN IF EXISTS "created";
ALTER TABLE "stripe"."disputes" ADD COLUMN "created" integer GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED;

ALTER TABLE "stripe"."disputes" DROP COLUMN IF EXISTS "updated";
ALTER TABLE "stripe"."disputes" ADD COLUMN "updated" integer GENERATED ALWAYS AS ((raw_data->>'updated')::integer) STORED;

ALTER TABLE "stripe"."disputes" DROP COLUMN IF EXISTS "currency";
ALTER TABLE "stripe"."disputes" ADD COLUMN "currency" text GENERATED ALWAYS AS ((raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."disputes" DROP COLUMN IF EXISTS "evidence";
ALTER TABLE "stripe"."disputes" ADD COLUMN "evidence" jsonb GENERATED ALWAYS AS (raw_data->'evidence') STORED;

ALTER TABLE "stripe"."disputes" DROP COLUMN IF EXISTS "livemode";
ALTER TABLE "stripe"."disputes" ADD COLUMN "livemode" boolean GENERATED ALWAYS AS ((raw_data->>'livemode')::boolean) STORED;

ALTER TABLE "stripe"."disputes" DROP COLUMN IF EXISTS "metadata";
ALTER TABLE "stripe"."disputes" ADD COLUMN "metadata" jsonb GENERATED ALWAYS AS (raw_data->'metadata') STORED;

ALTER TABLE "stripe"."disputes" DROP COLUMN IF EXISTS "evidence_details";
ALTER TABLE "stripe"."disputes" ADD COLUMN "evidence_details" jsonb GENERATED ALWAYS AS (raw_data->'evidence_details') STORED;

ALTER TABLE "stripe"."disputes" DROP COLUMN IF EXISTS "balance_transactions";
ALTER TABLE "stripe"."disputes" ADD COLUMN "balance_transactions" jsonb GENERATED ALWAYS AS (raw_data->'balance_transactions') STORED;

ALTER TABLE "stripe"."disputes" DROP COLUMN IF EXISTS "is_charge_refundable";
ALTER TABLE "stripe"."disputes" ADD COLUMN "is_charge_refundable" boolean GENERATED ALWAYS AS ((raw_data->>'is_charge_refundable')::boolean) STORED;

ALTER TABLE "stripe"."disputes" DROP COLUMN IF EXISTS "payment_intent";
ALTER TABLE "stripe"."disputes" ADD COLUMN "payment_intent" text GENERATED ALWAYS AS ((raw_data->>'payment_intent')::text) STORED;

-- Recreate indexes
CREATE INDEX stripe_dispute_created_idx ON "stripe"."disputes" USING btree (created);

-- ============================================================================
-- EARLY_FRAUD_WARNINGS
-- ============================================================================

ALTER TABLE "stripe"."early_fraud_warnings" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop indexes
DROP INDEX IF EXISTS "stripe"."stripe_early_fraud_warnings_charge_idx";
DROP INDEX IF EXISTS "stripe"."stripe_early_fraud_warnings_payment_intent_idx";

-- Drop and recreate columns as generated
ALTER TABLE "stripe"."early_fraud_warnings" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."early_fraud_warnings" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."early_fraud_warnings" DROP COLUMN IF EXISTS "actionable";
ALTER TABLE "stripe"."early_fraud_warnings" ADD COLUMN "actionable" boolean GENERATED ALWAYS AS ((raw_data->>'actionable')::boolean) STORED;

ALTER TABLE "stripe"."early_fraud_warnings" DROP COLUMN IF EXISTS "charge";
ALTER TABLE "stripe"."early_fraud_warnings" ADD COLUMN "charge" text GENERATED ALWAYS AS ((raw_data->>'charge')::text) STORED;

ALTER TABLE "stripe"."early_fraud_warnings" DROP COLUMN IF EXISTS "created";
ALTER TABLE "stripe"."early_fraud_warnings" ADD COLUMN "created" integer GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED;

ALTER TABLE "stripe"."early_fraud_warnings" DROP COLUMN IF EXISTS "fraud_type";
ALTER TABLE "stripe"."early_fraud_warnings" ADD COLUMN "fraud_type" text GENERATED ALWAYS AS ((raw_data->>'fraud_type')::text) STORED;

ALTER TABLE "stripe"."early_fraud_warnings" DROP COLUMN IF EXISTS "livemode";
ALTER TABLE "stripe"."early_fraud_warnings" ADD COLUMN "livemode" boolean GENERATED ALWAYS AS ((raw_data->>'livemode')::boolean) STORED;

ALTER TABLE "stripe"."early_fraud_warnings" DROP COLUMN IF EXISTS "payment_intent";
ALTER TABLE "stripe"."early_fraud_warnings" ADD COLUMN "payment_intent" text GENERATED ALWAYS AS ((raw_data->>'payment_intent')::text) STORED;

-- Recreate indexes
CREATE INDEX stripe_early_fraud_warnings_charge_idx ON "stripe"."early_fraud_warnings" USING btree (charge);
CREATE INDEX stripe_early_fraud_warnings_payment_intent_idx ON "stripe"."early_fraud_warnings" USING btree (payment_intent);

-- ============================================================================
-- EVENTS
-- ============================================================================

ALTER TABLE "stripe"."events" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop and recreate columns as generated
ALTER TABLE "stripe"."events" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."events" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."events" DROP COLUMN IF EXISTS "data";
ALTER TABLE "stripe"."events" ADD COLUMN "data" jsonb GENERATED ALWAYS AS (raw_data->'data') STORED;

ALTER TABLE "stripe"."events" DROP COLUMN IF EXISTS "type";
ALTER TABLE "stripe"."events" ADD COLUMN "type" text GENERATED ALWAYS AS ((raw_data->>'type')::text) STORED;

ALTER TABLE "stripe"."events" DROP COLUMN IF EXISTS "created";
ALTER TABLE "stripe"."events" ADD COLUMN "created" integer GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED;

ALTER TABLE "stripe"."events" DROP COLUMN IF EXISTS "request";
ALTER TABLE "stripe"."events" ADD COLUMN "request" text GENERATED ALWAYS AS ((raw_data->>'request')::text) STORED;

ALTER TABLE "stripe"."events" DROP COLUMN IF EXISTS "updated";
ALTER TABLE "stripe"."events" ADD COLUMN "updated" integer GENERATED ALWAYS AS ((raw_data->>'updated')::integer) STORED;

ALTER TABLE "stripe"."events" DROP COLUMN IF EXISTS "livemode";
ALTER TABLE "stripe"."events" ADD COLUMN "livemode" boolean GENERATED ALWAYS AS ((raw_data->>'livemode')::boolean) STORED;

ALTER TABLE "stripe"."events" DROP COLUMN IF EXISTS "api_version";
ALTER TABLE "stripe"."events" ADD COLUMN "api_version" text GENERATED ALWAYS AS ((raw_data->>'api_version')::text) STORED;

ALTER TABLE "stripe"."events" DROP COLUMN IF EXISTS "pending_webhooks";
ALTER TABLE "stripe"."events" ADD COLUMN "pending_webhooks" bigint GENERATED ALWAYS AS ((raw_data->>'pending_webhooks')::bigint) STORED;

-- ============================================================================
-- FEATURES
-- ============================================================================

ALTER TABLE "stripe"."features" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop unique constraint
ALTER TABLE "stripe"."features" DROP CONSTRAINT IF EXISTS "features_lookup_key_key";

-- Drop and recreate columns as generated
ALTER TABLE "stripe"."features" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."features" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."features" DROP COLUMN IF EXISTS "livemode";
ALTER TABLE "stripe"."features" ADD COLUMN "livemode" boolean GENERATED ALWAYS AS ((raw_data->>'livemode')::boolean) STORED;

ALTER TABLE "stripe"."features" DROP COLUMN IF EXISTS "name";
ALTER TABLE "stripe"."features" ADD COLUMN "name" text GENERATED ALWAYS AS ((raw_data->>'name')::text) STORED;

ALTER TABLE "stripe"."features" DROP COLUMN IF EXISTS "lookup_key";
ALTER TABLE "stripe"."features" ADD COLUMN "lookup_key" text GENERATED ALWAYS AS ((raw_data->>'lookup_key')::text) STORED;

ALTER TABLE "stripe"."features" DROP COLUMN IF EXISTS "active";
ALTER TABLE "stripe"."features" ADD COLUMN "active" boolean GENERATED ALWAYS AS ((raw_data->>'active')::boolean) STORED;

ALTER TABLE "stripe"."features" DROP COLUMN IF EXISTS "metadata";
ALTER TABLE "stripe"."features" ADD COLUMN "metadata" jsonb GENERATED ALWAYS AS (raw_data->'metadata') STORED;

-- Recreate unique constraint
CREATE UNIQUE INDEX features_lookup_key_key ON "stripe"."features" (lookup_key) WHERE lookup_key IS NOT NULL;

-- ============================================================================
-- INVOICES
-- ============================================================================

ALTER TABLE "stripe"."invoices" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop indexes
DROP INDEX IF EXISTS "stripe"."stripe_invoices_customer_idx";
DROP INDEX IF EXISTS "stripe"."stripe_invoices_subscription_idx";

-- Drop and recreate columns as generated (enum status converted to text)
ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."invoices" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "auto_advance";
ALTER TABLE "stripe"."invoices" ADD COLUMN "auto_advance" boolean GENERATED ALWAYS AS ((raw_data->>'auto_advance')::boolean) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "collection_method";
ALTER TABLE "stripe"."invoices" ADD COLUMN "collection_method" text GENERATED ALWAYS AS ((raw_data->>'collection_method')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "currency";
ALTER TABLE "stripe"."invoices" ADD COLUMN "currency" text GENERATED ALWAYS AS ((raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "description";
ALTER TABLE "stripe"."invoices" ADD COLUMN "description" text GENERATED ALWAYS AS ((raw_data->>'description')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "hosted_invoice_url";
ALTER TABLE "stripe"."invoices" ADD COLUMN "hosted_invoice_url" text GENERATED ALWAYS AS ((raw_data->>'hosted_invoice_url')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "lines";
ALTER TABLE "stripe"."invoices" ADD COLUMN "lines" jsonb GENERATED ALWAYS AS (raw_data->'lines') STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "period_end";
ALTER TABLE "stripe"."invoices" ADD COLUMN "period_end" integer GENERATED ALWAYS AS ((raw_data->>'period_end')::integer) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "period_start";
ALTER TABLE "stripe"."invoices" ADD COLUMN "period_start" integer GENERATED ALWAYS AS ((raw_data->>'period_start')::integer) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "status";
ALTER TABLE "stripe"."invoices" ADD COLUMN "status" text GENERATED ALWAYS AS ((raw_data->>'status')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "total";
ALTER TABLE "stripe"."invoices" ADD COLUMN "total" bigint GENERATED ALWAYS AS ((raw_data->>'total')::bigint) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "account_country";
ALTER TABLE "stripe"."invoices" ADD COLUMN "account_country" text GENERATED ALWAYS AS ((raw_data->>'account_country')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "account_name";
ALTER TABLE "stripe"."invoices" ADD COLUMN "account_name" text GENERATED ALWAYS AS ((raw_data->>'account_name')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "account_tax_ids";
ALTER TABLE "stripe"."invoices" ADD COLUMN "account_tax_ids" jsonb GENERATED ALWAYS AS (raw_data->'account_tax_ids') STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "amount_due";
ALTER TABLE "stripe"."invoices" ADD COLUMN "amount_due" bigint GENERATED ALWAYS AS ((raw_data->>'amount_due')::bigint) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "amount_paid";
ALTER TABLE "stripe"."invoices" ADD COLUMN "amount_paid" bigint GENERATED ALWAYS AS ((raw_data->>'amount_paid')::bigint) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "amount_remaining";
ALTER TABLE "stripe"."invoices" ADD COLUMN "amount_remaining" bigint GENERATED ALWAYS AS ((raw_data->>'amount_remaining')::bigint) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "application_fee_amount";
ALTER TABLE "stripe"."invoices" ADD COLUMN "application_fee_amount" bigint GENERATED ALWAYS AS ((raw_data->>'application_fee_amount')::bigint) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "attempt_count";
ALTER TABLE "stripe"."invoices" ADD COLUMN "attempt_count" integer GENERATED ALWAYS AS ((raw_data->>'attempt_count')::integer) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "attempted";
ALTER TABLE "stripe"."invoices" ADD COLUMN "attempted" boolean GENERATED ALWAYS AS ((raw_data->>'attempted')::boolean) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "billing_reason";
ALTER TABLE "stripe"."invoices" ADD COLUMN "billing_reason" text GENERATED ALWAYS AS ((raw_data->>'billing_reason')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "created";
ALTER TABLE "stripe"."invoices" ADD COLUMN "created" integer GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "custom_fields";
ALTER TABLE "stripe"."invoices" ADD COLUMN "custom_fields" jsonb GENERATED ALWAYS AS (raw_data->'custom_fields') STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "customer_address";
ALTER TABLE "stripe"."invoices" ADD COLUMN "customer_address" jsonb GENERATED ALWAYS AS (raw_data->'customer_address') STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "customer_email";
ALTER TABLE "stripe"."invoices" ADD COLUMN "customer_email" text GENERATED ALWAYS AS ((raw_data->>'customer_email')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "customer_name";
ALTER TABLE "stripe"."invoices" ADD COLUMN "customer_name" text GENERATED ALWAYS AS ((raw_data->>'customer_name')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "customer_phone";
ALTER TABLE "stripe"."invoices" ADD COLUMN "customer_phone" text GENERATED ALWAYS AS ((raw_data->>'customer_phone')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "customer_shipping";
ALTER TABLE "stripe"."invoices" ADD COLUMN "customer_shipping" jsonb GENERATED ALWAYS AS (raw_data->'customer_shipping') STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "customer_tax_exempt";
ALTER TABLE "stripe"."invoices" ADD COLUMN "customer_tax_exempt" text GENERATED ALWAYS AS ((raw_data->>'customer_tax_exempt')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "customer_tax_ids";
ALTER TABLE "stripe"."invoices" ADD COLUMN "customer_tax_ids" jsonb GENERATED ALWAYS AS (raw_data->'customer_tax_ids') STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "default_tax_rates";
ALTER TABLE "stripe"."invoices" ADD COLUMN "default_tax_rates" jsonb GENERATED ALWAYS AS (raw_data->'default_tax_rates') STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "discount";
ALTER TABLE "stripe"."invoices" ADD COLUMN "discount" jsonb GENERATED ALWAYS AS (raw_data->'discount') STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "discounts";
ALTER TABLE "stripe"."invoices" ADD COLUMN "discounts" jsonb GENERATED ALWAYS AS (raw_data->'discounts') STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "due_date";
ALTER TABLE "stripe"."invoices" ADD COLUMN "due_date" integer GENERATED ALWAYS AS ((raw_data->>'due_date')::integer) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "ending_balance";
ALTER TABLE "stripe"."invoices" ADD COLUMN "ending_balance" integer GENERATED ALWAYS AS ((raw_data->>'ending_balance')::integer) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "footer";
ALTER TABLE "stripe"."invoices" ADD COLUMN "footer" text GENERATED ALWAYS AS ((raw_data->>'footer')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "invoice_pdf";
ALTER TABLE "stripe"."invoices" ADD COLUMN "invoice_pdf" text GENERATED ALWAYS AS ((raw_data->>'invoice_pdf')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "last_finalization_error";
ALTER TABLE "stripe"."invoices" ADD COLUMN "last_finalization_error" jsonb GENERATED ALWAYS AS (raw_data->'last_finalization_error') STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "livemode";
ALTER TABLE "stripe"."invoices" ADD COLUMN "livemode" boolean GENERATED ALWAYS AS ((raw_data->>'livemode')::boolean) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "next_payment_attempt";
ALTER TABLE "stripe"."invoices" ADD COLUMN "next_payment_attempt" integer GENERATED ALWAYS AS ((raw_data->>'next_payment_attempt')::integer) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "number";
ALTER TABLE "stripe"."invoices" ADD COLUMN "number" text GENERATED ALWAYS AS ((raw_data->>'number')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "paid";
ALTER TABLE "stripe"."invoices" ADD COLUMN "paid" boolean GENERATED ALWAYS AS ((raw_data->>'paid')::boolean) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "payment_settings";
ALTER TABLE "stripe"."invoices" ADD COLUMN "payment_settings" jsonb GENERATED ALWAYS AS (raw_data->'payment_settings') STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "post_payment_credit_notes_amount";
ALTER TABLE "stripe"."invoices" ADD COLUMN "post_payment_credit_notes_amount" integer GENERATED ALWAYS AS ((raw_data->>'post_payment_credit_notes_amount')::integer) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "pre_payment_credit_notes_amount";
ALTER TABLE "stripe"."invoices" ADD COLUMN "pre_payment_credit_notes_amount" integer GENERATED ALWAYS AS ((raw_data->>'pre_payment_credit_notes_amount')::integer) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "receipt_number";
ALTER TABLE "stripe"."invoices" ADD COLUMN "receipt_number" text GENERATED ALWAYS AS ((raw_data->>'receipt_number')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "starting_balance";
ALTER TABLE "stripe"."invoices" ADD COLUMN "starting_balance" integer GENERATED ALWAYS AS ((raw_data->>'starting_balance')::integer) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "statement_descriptor";
ALTER TABLE "stripe"."invoices" ADD COLUMN "statement_descriptor" text GENERATED ALWAYS AS ((raw_data->>'statement_descriptor')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "status_transitions";
ALTER TABLE "stripe"."invoices" ADD COLUMN "status_transitions" jsonb GENERATED ALWAYS AS (raw_data->'status_transitions') STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "subtotal";
ALTER TABLE "stripe"."invoices" ADD COLUMN "subtotal" integer GENERATED ALWAYS AS ((raw_data->>'subtotal')::integer) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "tax";
ALTER TABLE "stripe"."invoices" ADD COLUMN "tax" integer GENERATED ALWAYS AS ((raw_data->>'tax')::integer) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "total_discount_amounts";
ALTER TABLE "stripe"."invoices" ADD COLUMN "total_discount_amounts" jsonb GENERATED ALWAYS AS (raw_data->'total_discount_amounts') STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "total_tax_amounts";
ALTER TABLE "stripe"."invoices" ADD COLUMN "total_tax_amounts" jsonb GENERATED ALWAYS AS (raw_data->'total_tax_amounts') STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "transfer_data";
ALTER TABLE "stripe"."invoices" ADD COLUMN "transfer_data" jsonb GENERATED ALWAYS AS (raw_data->'transfer_data') STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "webhooks_delivered_at";
ALTER TABLE "stripe"."invoices" ADD COLUMN "webhooks_delivered_at" integer GENERATED ALWAYS AS ((raw_data->>'webhooks_delivered_at')::integer) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "customer";
ALTER TABLE "stripe"."invoices" ADD COLUMN "customer" text GENERATED ALWAYS AS ((raw_data->>'customer')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "subscription";
ALTER TABLE "stripe"."invoices" ADD COLUMN "subscription" text GENERATED ALWAYS AS ((raw_data->>'subscription')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "payment_intent";
ALTER TABLE "stripe"."invoices" ADD COLUMN "payment_intent" text GENERATED ALWAYS AS ((raw_data->>'payment_intent')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "default_payment_method";
ALTER TABLE "stripe"."invoices" ADD COLUMN "default_payment_method" text GENERATED ALWAYS AS ((raw_data->>'default_payment_method')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "default_source";
ALTER TABLE "stripe"."invoices" ADD COLUMN "default_source" text GENERATED ALWAYS AS ((raw_data->>'default_source')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "on_behalf_of";
ALTER TABLE "stripe"."invoices" ADD COLUMN "on_behalf_of" text GENERATED ALWAYS AS ((raw_data->>'on_behalf_of')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "charge";
ALTER TABLE "stripe"."invoices" ADD COLUMN "charge" text GENERATED ALWAYS AS ((raw_data->>'charge')::text) STORED;

ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "metadata";
ALTER TABLE "stripe"."invoices" ADD COLUMN "metadata" jsonb GENERATED ALWAYS AS (raw_data->'metadata') STORED;

-- Recreate indexes
CREATE INDEX stripe_invoices_customer_idx ON "stripe"."invoices" USING btree (customer);
CREATE INDEX stripe_invoices_subscription_idx ON "stripe"."invoices" USING btree (subscription);

-- ============================================================================
-- PAYMENT_INTENTS
-- ============================================================================

ALTER TABLE "stripe"."payment_intents" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop indexes
DROP INDEX IF EXISTS "stripe"."stripe_payment_intents_customer_idx";
DROP INDEX IF EXISTS "stripe"."stripe_payment_intents_invoice_idx";

-- Drop and recreate columns as generated
ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "amount";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "amount" integer GENERATED ALWAYS AS ((raw_data->>'amount')::integer) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "amount_capturable";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "amount_capturable" integer GENERATED ALWAYS AS ((raw_data->>'amount_capturable')::integer) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "amount_details";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "amount_details" jsonb GENERATED ALWAYS AS (raw_data->'amount_details') STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "amount_received";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "amount_received" integer GENERATED ALWAYS AS ((raw_data->>'amount_received')::integer) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "application";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "application" text GENERATED ALWAYS AS ((raw_data->>'application')::text) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "application_fee_amount";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "application_fee_amount" integer GENERATED ALWAYS AS ((raw_data->>'application_fee_amount')::integer) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "automatic_payment_methods";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "automatic_payment_methods" text GENERATED ALWAYS AS ((raw_data->>'automatic_payment_methods')::text) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "canceled_at";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "canceled_at" integer GENERATED ALWAYS AS ((raw_data->>'canceled_at')::integer) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "cancellation_reason";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "cancellation_reason" text GENERATED ALWAYS AS ((raw_data->>'cancellation_reason')::text) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "capture_method";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "capture_method" text GENERATED ALWAYS AS ((raw_data->>'capture_method')::text) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "client_secret";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "client_secret" text GENERATED ALWAYS AS ((raw_data->>'client_secret')::text) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "confirmation_method";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "confirmation_method" text GENERATED ALWAYS AS ((raw_data->>'confirmation_method')::text) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "created";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "created" integer GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "currency";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "currency" text GENERATED ALWAYS AS ((raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "customer";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "customer" text GENERATED ALWAYS AS ((raw_data->>'customer')::text) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "description";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "description" text GENERATED ALWAYS AS ((raw_data->>'description')::text) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "invoice";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "invoice" text GENERATED ALWAYS AS ((raw_data->>'invoice')::text) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "last_payment_error";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "last_payment_error" text GENERATED ALWAYS AS ((raw_data->>'last_payment_error')::text) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "livemode";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "livemode" boolean GENERATED ALWAYS AS ((raw_data->>'livemode')::boolean) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "metadata";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "metadata" jsonb GENERATED ALWAYS AS (raw_data->'metadata') STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "next_action";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "next_action" text GENERATED ALWAYS AS ((raw_data->>'next_action')::text) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "on_behalf_of";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "on_behalf_of" text GENERATED ALWAYS AS ((raw_data->>'on_behalf_of')::text) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "payment_method";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "payment_method" text GENERATED ALWAYS AS ((raw_data->>'payment_method')::text) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "payment_method_options";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "payment_method_options" jsonb GENERATED ALWAYS AS (raw_data->'payment_method_options') STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "payment_method_types";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "payment_method_types" jsonb GENERATED ALWAYS AS (raw_data->'payment_method_types') STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "processing";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "processing" text GENERATED ALWAYS AS ((raw_data->>'processing')::text) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "receipt_email";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "receipt_email" text GENERATED ALWAYS AS ((raw_data->>'receipt_email')::text) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "review";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "review" text GENERATED ALWAYS AS ((raw_data->>'review')::text) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "setup_future_usage";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "setup_future_usage" text GENERATED ALWAYS AS ((raw_data->>'setup_future_usage')::text) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "shipping";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "shipping" jsonb GENERATED ALWAYS AS (raw_data->'shipping') STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "statement_descriptor";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "statement_descriptor" text GENERATED ALWAYS AS ((raw_data->>'statement_descriptor')::text) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "statement_descriptor_suffix";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "statement_descriptor_suffix" text GENERATED ALWAYS AS ((raw_data->>'statement_descriptor_suffix')::text) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "status";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "status" text GENERATED ALWAYS AS ((raw_data->>'status')::text) STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "transfer_data";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "transfer_data" jsonb GENERATED ALWAYS AS (raw_data->'transfer_data') STORED;

ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "transfer_group";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "transfer_group" text GENERATED ALWAYS AS ((raw_data->>'transfer_group')::text) STORED;

-- Recreate indexes
CREATE INDEX stripe_payment_intents_customer_idx ON "stripe"."payment_intents" USING btree (customer);
CREATE INDEX stripe_payment_intents_invoice_idx ON "stripe"."payment_intents" USING btree (invoice);

-- ============================================================================
-- PAYMENT_METHODS
-- ============================================================================

ALTER TABLE "stripe"."payment_methods" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop indexes
DROP INDEX IF EXISTS "stripe"."stripe_payment_methods_customer_idx";

-- Drop and recreate columns as generated
ALTER TABLE "stripe"."payment_methods" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."payment_methods" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."payment_methods" DROP COLUMN IF EXISTS "created";
ALTER TABLE "stripe"."payment_methods" ADD COLUMN "created" integer GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED;

ALTER TABLE "stripe"."payment_methods" DROP COLUMN IF EXISTS "customer";
ALTER TABLE "stripe"."payment_methods" ADD COLUMN "customer" text GENERATED ALWAYS AS ((raw_data->>'customer')::text) STORED;

ALTER TABLE "stripe"."payment_methods" DROP COLUMN IF EXISTS "type";
ALTER TABLE "stripe"."payment_methods" ADD COLUMN "type" text GENERATED ALWAYS AS ((raw_data->>'type')::text) STORED;

ALTER TABLE "stripe"."payment_methods" DROP COLUMN IF EXISTS "billing_details";
ALTER TABLE "stripe"."payment_methods" ADD COLUMN "billing_details" jsonb GENERATED ALWAYS AS (raw_data->'billing_details') STORED;

ALTER TABLE "stripe"."payment_methods" DROP COLUMN IF EXISTS "metadata";
ALTER TABLE "stripe"."payment_methods" ADD COLUMN "metadata" jsonb GENERATED ALWAYS AS (raw_data->'metadata') STORED;

ALTER TABLE "stripe"."payment_methods" DROP COLUMN IF EXISTS "card";
ALTER TABLE "stripe"."payment_methods" ADD COLUMN "card" jsonb GENERATED ALWAYS AS (raw_data->'card') STORED;

-- Recreate indexes
CREATE INDEX stripe_payment_methods_customer_idx ON "stripe"."payment_methods" USING btree (customer);

-- ============================================================================
-- PAYOUTS
-- ============================================================================

ALTER TABLE "stripe"."payouts" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop and recreate columns as generated
ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."payouts" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "date";
ALTER TABLE "stripe"."payouts" ADD COLUMN "date" text GENERATED ALWAYS AS ((raw_data->>'date')::text) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "type";
ALTER TABLE "stripe"."payouts" ADD COLUMN "type" text GENERATED ALWAYS AS ((raw_data->>'type')::text) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "amount";
ALTER TABLE "stripe"."payouts" ADD COLUMN "amount" bigint GENERATED ALWAYS AS ((raw_data->>'amount')::bigint) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "method";
ALTER TABLE "stripe"."payouts" ADD COLUMN "method" text GENERATED ALWAYS AS ((raw_data->>'method')::text) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "status";
ALTER TABLE "stripe"."payouts" ADD COLUMN "status" text GENERATED ALWAYS AS ((raw_data->>'status')::text) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "created";
ALTER TABLE "stripe"."payouts" ADD COLUMN "created" integer GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "updated";
ALTER TABLE "stripe"."payouts" ADD COLUMN "updated" integer GENERATED ALWAYS AS ((raw_data->>'updated')::integer) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "currency";
ALTER TABLE "stripe"."payouts" ADD COLUMN "currency" text GENERATED ALWAYS AS ((raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "livemode";
ALTER TABLE "stripe"."payouts" ADD COLUMN "livemode" boolean GENERATED ALWAYS AS ((raw_data->>'livemode')::boolean) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "metadata";
ALTER TABLE "stripe"."payouts" ADD COLUMN "metadata" jsonb GENERATED ALWAYS AS (raw_data->'metadata') STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "automatic";
ALTER TABLE "stripe"."payouts" ADD COLUMN "automatic" boolean GENERATED ALWAYS AS ((raw_data->>'automatic')::boolean) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "recipient";
ALTER TABLE "stripe"."payouts" ADD COLUMN "recipient" text GENERATED ALWAYS AS ((raw_data->>'recipient')::text) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "description";
ALTER TABLE "stripe"."payouts" ADD COLUMN "description" text GENERATED ALWAYS AS ((raw_data->>'description')::text) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "destination";
ALTER TABLE "stripe"."payouts" ADD COLUMN "destination" text GENERATED ALWAYS AS ((raw_data->>'destination')::text) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "source_type";
ALTER TABLE "stripe"."payouts" ADD COLUMN "source_type" text GENERATED ALWAYS AS ((raw_data->>'source_type')::text) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "arrival_date";
ALTER TABLE "stripe"."payouts" ADD COLUMN "arrival_date" text GENERATED ALWAYS AS ((raw_data->>'arrival_date')::text) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "bank_account";
ALTER TABLE "stripe"."payouts" ADD COLUMN "bank_account" jsonb GENERATED ALWAYS AS (raw_data->'bank_account') STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "failure_code";
ALTER TABLE "stripe"."payouts" ADD COLUMN "failure_code" text GENERATED ALWAYS AS ((raw_data->>'failure_code')::text) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "transfer_group";
ALTER TABLE "stripe"."payouts" ADD COLUMN "transfer_group" text GENERATED ALWAYS AS ((raw_data->>'transfer_group')::text) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "amount_reversed";
ALTER TABLE "stripe"."payouts" ADD COLUMN "amount_reversed" bigint GENERATED ALWAYS AS ((raw_data->>'amount_reversed')::bigint) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "failure_message";
ALTER TABLE "stripe"."payouts" ADD COLUMN "failure_message" text GENERATED ALWAYS AS ((raw_data->>'failure_message')::text) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "source_transaction";
ALTER TABLE "stripe"."payouts" ADD COLUMN "source_transaction" text GENERATED ALWAYS AS ((raw_data->>'source_transaction')::text) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "balance_transaction";
ALTER TABLE "stripe"."payouts" ADD COLUMN "balance_transaction" text GENERATED ALWAYS AS ((raw_data->>'balance_transaction')::text) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "statement_descriptor";
ALTER TABLE "stripe"."payouts" ADD COLUMN "statement_descriptor" text GENERATED ALWAYS AS ((raw_data->>'statement_descriptor')::text) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "statement_description";
ALTER TABLE "stripe"."payouts" ADD COLUMN "statement_description" text GENERATED ALWAYS AS ((raw_data->>'statement_description')::text) STORED;

ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "failure_balance_transaction";
ALTER TABLE "stripe"."payouts" ADD COLUMN "failure_balance_transaction" text GENERATED ALWAYS AS ((raw_data->>'failure_balance_transaction')::text) STORED;

-- ============================================================================
-- PLANS
-- ============================================================================

ALTER TABLE "stripe"."plans" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop and recreate columns as generated
ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."plans" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "name";
ALTER TABLE "stripe"."plans" ADD COLUMN "name" text GENERATED ALWAYS AS ((raw_data->>'name')::text) STORED;

ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "tiers";
ALTER TABLE "stripe"."plans" ADD COLUMN "tiers" jsonb GENERATED ALWAYS AS (raw_data->'tiers') STORED;

ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "active";
ALTER TABLE "stripe"."plans" ADD COLUMN "active" boolean GENERATED ALWAYS AS ((raw_data->>'active')::boolean) STORED;

ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "amount";
ALTER TABLE "stripe"."plans" ADD COLUMN "amount" bigint GENERATED ALWAYS AS ((raw_data->>'amount')::bigint) STORED;

ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "created";
ALTER TABLE "stripe"."plans" ADD COLUMN "created" integer GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED;

ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "product";
ALTER TABLE "stripe"."plans" ADD COLUMN "product" text GENERATED ALWAYS AS ((raw_data->>'product')::text) STORED;

ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "updated";
ALTER TABLE "stripe"."plans" ADD COLUMN "updated" integer GENERATED ALWAYS AS ((raw_data->>'updated')::integer) STORED;

ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "currency";
ALTER TABLE "stripe"."plans" ADD COLUMN "currency" text GENERATED ALWAYS AS ((raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "interval";
ALTER TABLE "stripe"."plans" ADD COLUMN "interval" text GENERATED ALWAYS AS ((raw_data->>'interval')::text) STORED;

ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "livemode";
ALTER TABLE "stripe"."plans" ADD COLUMN "livemode" boolean GENERATED ALWAYS AS ((raw_data->>'livemode')::boolean) STORED;

ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "metadata";
ALTER TABLE "stripe"."plans" ADD COLUMN "metadata" jsonb GENERATED ALWAYS AS (raw_data->'metadata') STORED;

ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "nickname";
ALTER TABLE "stripe"."plans" ADD COLUMN "nickname" text GENERATED ALWAYS AS ((raw_data->>'nickname')::text) STORED;

ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "tiers_mode";
ALTER TABLE "stripe"."plans" ADD COLUMN "tiers_mode" text GENERATED ALWAYS AS ((raw_data->>'tiers_mode')::text) STORED;

ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "usage_type";
ALTER TABLE "stripe"."plans" ADD COLUMN "usage_type" text GENERATED ALWAYS AS ((raw_data->>'usage_type')::text) STORED;

ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "billing_scheme";
ALTER TABLE "stripe"."plans" ADD COLUMN "billing_scheme" text GENERATED ALWAYS AS ((raw_data->>'billing_scheme')::text) STORED;

ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "interval_count";
ALTER TABLE "stripe"."plans" ADD COLUMN "interval_count" bigint GENERATED ALWAYS AS ((raw_data->>'interval_count')::bigint) STORED;

ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "aggregate_usage";
ALTER TABLE "stripe"."plans" ADD COLUMN "aggregate_usage" text GENERATED ALWAYS AS ((raw_data->>'aggregate_usage')::text) STORED;

ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "transform_usage";
ALTER TABLE "stripe"."plans" ADD COLUMN "transform_usage" text GENERATED ALWAYS AS ((raw_data->>'transform_usage')::text) STORED;

ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "trial_period_days";
ALTER TABLE "stripe"."plans" ADD COLUMN "trial_period_days" bigint GENERATED ALWAYS AS ((raw_data->>'trial_period_days')::bigint) STORED;

ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "statement_descriptor";
ALTER TABLE "stripe"."plans" ADD COLUMN "statement_descriptor" text GENERATED ALWAYS AS ((raw_data->>'statement_descriptor')::text) STORED;

ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "statement_description";
ALTER TABLE "stripe"."plans" ADD COLUMN "statement_description" text GENERATED ALWAYS AS ((raw_data->>'statement_description')::text) STORED;

-- ============================================================================
-- PRICES
-- ============================================================================

ALTER TABLE "stripe"."prices" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop and recreate columns as generated (enum types converted to text)
ALTER TABLE "stripe"."prices" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."prices" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."prices" DROP COLUMN IF EXISTS "active";
ALTER TABLE "stripe"."prices" ADD COLUMN "active" boolean GENERATED ALWAYS AS ((raw_data->>'active')::boolean) STORED;

ALTER TABLE "stripe"."prices" DROP COLUMN IF EXISTS "currency";
ALTER TABLE "stripe"."prices" ADD COLUMN "currency" text GENERATED ALWAYS AS ((raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."prices" DROP COLUMN IF EXISTS "metadata";
ALTER TABLE "stripe"."prices" ADD COLUMN "metadata" jsonb GENERATED ALWAYS AS (raw_data->'metadata') STORED;

ALTER TABLE "stripe"."prices" DROP COLUMN IF EXISTS "nickname";
ALTER TABLE "stripe"."prices" ADD COLUMN "nickname" text GENERATED ALWAYS AS ((raw_data->>'nickname')::text) STORED;

ALTER TABLE "stripe"."prices" DROP COLUMN IF EXISTS "recurring";
ALTER TABLE "stripe"."prices" ADD COLUMN "recurring" jsonb GENERATED ALWAYS AS (raw_data->'recurring') STORED;

ALTER TABLE "stripe"."prices" DROP COLUMN IF EXISTS "type";
ALTER TABLE "stripe"."prices" ADD COLUMN "type" text GENERATED ALWAYS AS ((raw_data->>'type')::text) STORED;

ALTER TABLE "stripe"."prices" DROP COLUMN IF EXISTS "unit_amount";
ALTER TABLE "stripe"."prices" ADD COLUMN "unit_amount" integer GENERATED ALWAYS AS ((raw_data->>'unit_amount')::integer) STORED;

ALTER TABLE "stripe"."prices" DROP COLUMN IF EXISTS "billing_scheme";
ALTER TABLE "stripe"."prices" ADD COLUMN "billing_scheme" text GENERATED ALWAYS AS ((raw_data->>'billing_scheme')::text) STORED;

ALTER TABLE "stripe"."prices" DROP COLUMN IF EXISTS "created";
ALTER TABLE "stripe"."prices" ADD COLUMN "created" integer GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED;

ALTER TABLE "stripe"."prices" DROP COLUMN IF EXISTS "livemode";
ALTER TABLE "stripe"."prices" ADD COLUMN "livemode" boolean GENERATED ALWAYS AS ((raw_data->>'livemode')::boolean) STORED;

ALTER TABLE "stripe"."prices" DROP COLUMN IF EXISTS "lookup_key";
ALTER TABLE "stripe"."prices" ADD COLUMN "lookup_key" text GENERATED ALWAYS AS ((raw_data->>'lookup_key')::text) STORED;

ALTER TABLE "stripe"."prices" DROP COLUMN IF EXISTS "tiers_mode";
ALTER TABLE "stripe"."prices" ADD COLUMN "tiers_mode" text GENERATED ALWAYS AS ((raw_data->>'tiers_mode')::text) STORED;

ALTER TABLE "stripe"."prices" DROP COLUMN IF EXISTS "transform_quantity";
ALTER TABLE "stripe"."prices" ADD COLUMN "transform_quantity" jsonb GENERATED ALWAYS AS (raw_data->'transform_quantity') STORED;

ALTER TABLE "stripe"."prices" DROP COLUMN IF EXISTS "unit_amount_decimal";
ALTER TABLE "stripe"."prices" ADD COLUMN "unit_amount_decimal" text GENERATED ALWAYS AS ((raw_data->>'unit_amount_decimal')::text) STORED;

ALTER TABLE "stripe"."prices" DROP COLUMN IF EXISTS "product";
ALTER TABLE "stripe"."prices" ADD COLUMN "product" text GENERATED ALWAYS AS ((raw_data->>'product')::text) STORED;

-- ============================================================================
-- PRODUCTS
-- ============================================================================

ALTER TABLE "stripe"."products" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop and recreate columns as generated
ALTER TABLE "stripe"."products" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."products" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."products" DROP COLUMN IF EXISTS "active";
ALTER TABLE "stripe"."products" ADD COLUMN "active" boolean GENERATED ALWAYS AS ((raw_data->>'active')::boolean) STORED;

ALTER TABLE "stripe"."products" DROP COLUMN IF EXISTS "default_price";
ALTER TABLE "stripe"."products" ADD COLUMN "default_price" text GENERATED ALWAYS AS ((raw_data->>'default_price')::text) STORED;

ALTER TABLE "stripe"."products" DROP COLUMN IF EXISTS "description";
ALTER TABLE "stripe"."products" ADD COLUMN "description" text GENERATED ALWAYS AS ((raw_data->>'description')::text) STORED;

ALTER TABLE "stripe"."products" DROP COLUMN IF EXISTS "metadata";
ALTER TABLE "stripe"."products" ADD COLUMN "metadata" jsonb GENERATED ALWAYS AS (raw_data->'metadata') STORED;

ALTER TABLE "stripe"."products" DROP COLUMN IF EXISTS "name";
ALTER TABLE "stripe"."products" ADD COLUMN "name" text GENERATED ALWAYS AS ((raw_data->>'name')::text) STORED;

ALTER TABLE "stripe"."products" DROP COLUMN IF EXISTS "created";
ALTER TABLE "stripe"."products" ADD COLUMN "created" integer GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED;

ALTER TABLE "stripe"."products" DROP COLUMN IF EXISTS "images";
ALTER TABLE "stripe"."products" ADD COLUMN "images" jsonb GENERATED ALWAYS AS (raw_data->'images') STORED;

ALTER TABLE "stripe"."products" DROP COLUMN IF EXISTS "marketing_features";
ALTER TABLE "stripe"."products" ADD COLUMN "marketing_features" jsonb GENERATED ALWAYS AS (raw_data->'marketing_features') STORED;

ALTER TABLE "stripe"."products" DROP COLUMN IF EXISTS "livemode";
ALTER TABLE "stripe"."products" ADD COLUMN "livemode" boolean GENERATED ALWAYS AS ((raw_data->>'livemode')::boolean) STORED;

ALTER TABLE "stripe"."products" DROP COLUMN IF EXISTS "package_dimensions";
ALTER TABLE "stripe"."products" ADD COLUMN "package_dimensions" jsonb GENERATED ALWAYS AS (raw_data->'package_dimensions') STORED;

ALTER TABLE "stripe"."products" DROP COLUMN IF EXISTS "shippable";
ALTER TABLE "stripe"."products" ADD COLUMN "shippable" boolean GENERATED ALWAYS AS ((raw_data->>'shippable')::boolean) STORED;

ALTER TABLE "stripe"."products" DROP COLUMN IF EXISTS "statement_descriptor";
ALTER TABLE "stripe"."products" ADD COLUMN "statement_descriptor" text GENERATED ALWAYS AS ((raw_data->>'statement_descriptor')::text) STORED;

ALTER TABLE "stripe"."products" DROP COLUMN IF EXISTS "unit_label";
ALTER TABLE "stripe"."products" ADD COLUMN "unit_label" text GENERATED ALWAYS AS ((raw_data->>'unit_label')::text) STORED;

ALTER TABLE "stripe"."products" DROP COLUMN IF EXISTS "updated";
ALTER TABLE "stripe"."products" ADD COLUMN "updated" integer GENERATED ALWAYS AS ((raw_data->>'updated')::integer) STORED;

ALTER TABLE "stripe"."products" DROP COLUMN IF EXISTS "url";
ALTER TABLE "stripe"."products" ADD COLUMN "url" text GENERATED ALWAYS AS ((raw_data->>'url')::text) STORED;

-- ============================================================================
-- REFUNDS
-- ============================================================================

ALTER TABLE "stripe"."refunds" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop indexes
DROP INDEX IF EXISTS "stripe"."stripe_refunds_charge_idx";
DROP INDEX IF EXISTS "stripe"."stripe_refunds_payment_intent_idx";

-- Drop and recreate columns as generated
ALTER TABLE "stripe"."refunds" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."refunds" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."refunds" DROP COLUMN IF EXISTS "amount";
ALTER TABLE "stripe"."refunds" ADD COLUMN "amount" integer GENERATED ALWAYS AS ((raw_data->>'amount')::integer) STORED;

ALTER TABLE "stripe"."refunds" DROP COLUMN IF EXISTS "balance_transaction";
ALTER TABLE "stripe"."refunds" ADD COLUMN "balance_transaction" text GENERATED ALWAYS AS ((raw_data->>'balance_transaction')::text) STORED;

ALTER TABLE "stripe"."refunds" DROP COLUMN IF EXISTS "charge";
ALTER TABLE "stripe"."refunds" ADD COLUMN "charge" text GENERATED ALWAYS AS ((raw_data->>'charge')::text) STORED;

ALTER TABLE "stripe"."refunds" DROP COLUMN IF EXISTS "created";
ALTER TABLE "stripe"."refunds" ADD COLUMN "created" integer GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED;

ALTER TABLE "stripe"."refunds" DROP COLUMN IF EXISTS "currency";
ALTER TABLE "stripe"."refunds" ADD COLUMN "currency" text GENERATED ALWAYS AS ((raw_data->>'currency')::text) STORED;

ALTER TABLE "stripe"."refunds" DROP COLUMN IF EXISTS "destination_details";
ALTER TABLE "stripe"."refunds" ADD COLUMN "destination_details" jsonb GENERATED ALWAYS AS (raw_data->'destination_details') STORED;

ALTER TABLE "stripe"."refunds" DROP COLUMN IF EXISTS "metadata";
ALTER TABLE "stripe"."refunds" ADD COLUMN "metadata" jsonb GENERATED ALWAYS AS (raw_data->'metadata') STORED;

ALTER TABLE "stripe"."refunds" DROP COLUMN IF EXISTS "payment_intent";
ALTER TABLE "stripe"."refunds" ADD COLUMN "payment_intent" text GENERATED ALWAYS AS ((raw_data->>'payment_intent')::text) STORED;

ALTER TABLE "stripe"."refunds" DROP COLUMN IF EXISTS "reason";
ALTER TABLE "stripe"."refunds" ADD COLUMN "reason" text GENERATED ALWAYS AS ((raw_data->>'reason')::text) STORED;

ALTER TABLE "stripe"."refunds" DROP COLUMN IF EXISTS "receipt_number";
ALTER TABLE "stripe"."refunds" ADD COLUMN "receipt_number" text GENERATED ALWAYS AS ((raw_data->>'receipt_number')::text) STORED;

ALTER TABLE "stripe"."refunds" DROP COLUMN IF EXISTS "source_transfer_reversal";
ALTER TABLE "stripe"."refunds" ADD COLUMN "source_transfer_reversal" text GENERATED ALWAYS AS ((raw_data->>'source_transfer_reversal')::text) STORED;

ALTER TABLE "stripe"."refunds" DROP COLUMN IF EXISTS "status";
ALTER TABLE "stripe"."refunds" ADD COLUMN "status" text GENERATED ALWAYS AS ((raw_data->>'status')::text) STORED;

ALTER TABLE "stripe"."refunds" DROP COLUMN IF EXISTS "transfer_reversal";
ALTER TABLE "stripe"."refunds" ADD COLUMN "transfer_reversal" text GENERATED ALWAYS AS ((raw_data->>'transfer_reversal')::text) STORED;

-- Recreate indexes
CREATE INDEX stripe_refunds_charge_idx ON "stripe"."refunds" USING btree (charge);
CREATE INDEX stripe_refunds_payment_intent_idx ON "stripe"."refunds" USING btree (payment_intent);

-- ============================================================================
-- REVIEWS
-- ============================================================================

ALTER TABLE "stripe"."reviews" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop indexes
DROP INDEX IF EXISTS "stripe"."stripe_reviews_charge_idx";
DROP INDEX IF EXISTS "stripe"."stripe_reviews_payment_intent_idx";

-- Drop and recreate columns as generated
ALTER TABLE "stripe"."reviews" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."reviews" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."reviews" DROP COLUMN IF EXISTS "billing_zip";
ALTER TABLE "stripe"."reviews" ADD COLUMN "billing_zip" text GENERATED ALWAYS AS ((raw_data->>'billing_zip')::text) STORED;

ALTER TABLE "stripe"."reviews" DROP COLUMN IF EXISTS "charge";
ALTER TABLE "stripe"."reviews" ADD COLUMN "charge" text GENERATED ALWAYS AS ((raw_data->>'charge')::text) STORED;

ALTER TABLE "stripe"."reviews" DROP COLUMN IF EXISTS "created";
ALTER TABLE "stripe"."reviews" ADD COLUMN "created" integer GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED;

ALTER TABLE "stripe"."reviews" DROP COLUMN IF EXISTS "closed_reason";
ALTER TABLE "stripe"."reviews" ADD COLUMN "closed_reason" text GENERATED ALWAYS AS ((raw_data->>'closed_reason')::text) STORED;

ALTER TABLE "stripe"."reviews" DROP COLUMN IF EXISTS "livemode";
ALTER TABLE "stripe"."reviews" ADD COLUMN "livemode" boolean GENERATED ALWAYS AS ((raw_data->>'livemode')::boolean) STORED;

ALTER TABLE "stripe"."reviews" DROP COLUMN IF EXISTS "ip_address";
ALTER TABLE "stripe"."reviews" ADD COLUMN "ip_address" text GENERATED ALWAYS AS ((raw_data->>'ip_address')::text) STORED;

ALTER TABLE "stripe"."reviews" DROP COLUMN IF EXISTS "ip_address_location";
ALTER TABLE "stripe"."reviews" ADD COLUMN "ip_address_location" jsonb GENERATED ALWAYS AS (raw_data->'ip_address_location') STORED;

ALTER TABLE "stripe"."reviews" DROP COLUMN IF EXISTS "open";
ALTER TABLE "stripe"."reviews" ADD COLUMN "open" boolean GENERATED ALWAYS AS ((raw_data->>'open')::boolean) STORED;

ALTER TABLE "stripe"."reviews" DROP COLUMN IF EXISTS "opened_reason";
ALTER TABLE "stripe"."reviews" ADD COLUMN "opened_reason" text GENERATED ALWAYS AS ((raw_data->>'opened_reason')::text) STORED;

ALTER TABLE "stripe"."reviews" DROP COLUMN IF EXISTS "payment_intent";
ALTER TABLE "stripe"."reviews" ADD COLUMN "payment_intent" text GENERATED ALWAYS AS ((raw_data->>'payment_intent')::text) STORED;

ALTER TABLE "stripe"."reviews" DROP COLUMN IF EXISTS "reason";
ALTER TABLE "stripe"."reviews" ADD COLUMN "reason" text GENERATED ALWAYS AS ((raw_data->>'reason')::text) STORED;

ALTER TABLE "stripe"."reviews" DROP COLUMN IF EXISTS "session";
ALTER TABLE "stripe"."reviews" ADD COLUMN "session" text GENERATED ALWAYS AS ((raw_data->>'session')::text) STORED;

-- Recreate indexes
CREATE INDEX stripe_reviews_charge_idx ON "stripe"."reviews" USING btree (charge);
CREATE INDEX stripe_reviews_payment_intent_idx ON "stripe"."reviews" USING btree (payment_intent);

-- ============================================================================
-- SETUP_INTENTS
-- ============================================================================

ALTER TABLE "stripe"."setup_intents" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop indexes
DROP INDEX IF EXISTS "stripe"."stripe_setup_intents_customer_idx";

-- Drop and recreate columns as generated
ALTER TABLE "stripe"."setup_intents" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."setup_intents" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."setup_intents" DROP COLUMN IF EXISTS "created";
ALTER TABLE "stripe"."setup_intents" ADD COLUMN "created" integer GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED;

ALTER TABLE "stripe"."setup_intents" DROP COLUMN IF EXISTS "customer";
ALTER TABLE "stripe"."setup_intents" ADD COLUMN "customer" text GENERATED ALWAYS AS ((raw_data->>'customer')::text) STORED;

ALTER TABLE "stripe"."setup_intents" DROP COLUMN IF EXISTS "description";
ALTER TABLE "stripe"."setup_intents" ADD COLUMN "description" text GENERATED ALWAYS AS ((raw_data->>'description')::text) STORED;

ALTER TABLE "stripe"."setup_intents" DROP COLUMN IF EXISTS "payment_method";
ALTER TABLE "stripe"."setup_intents" ADD COLUMN "payment_method" text GENERATED ALWAYS AS ((raw_data->>'payment_method')::text) STORED;

ALTER TABLE "stripe"."setup_intents" DROP COLUMN IF EXISTS "status";
ALTER TABLE "stripe"."setup_intents" ADD COLUMN "status" text GENERATED ALWAYS AS ((raw_data->>'status')::text) STORED;

ALTER TABLE "stripe"."setup_intents" DROP COLUMN IF EXISTS "usage";
ALTER TABLE "stripe"."setup_intents" ADD COLUMN "usage" text GENERATED ALWAYS AS ((raw_data->>'usage')::text) STORED;

ALTER TABLE "stripe"."setup_intents" DROP COLUMN IF EXISTS "cancellation_reason";
ALTER TABLE "stripe"."setup_intents" ADD COLUMN "cancellation_reason" text GENERATED ALWAYS AS ((raw_data->>'cancellation_reason')::text) STORED;

ALTER TABLE "stripe"."setup_intents" DROP COLUMN IF EXISTS "latest_attempt";
ALTER TABLE "stripe"."setup_intents" ADD COLUMN "latest_attempt" text GENERATED ALWAYS AS ((raw_data->>'latest_attempt')::text) STORED;

ALTER TABLE "stripe"."setup_intents" DROP COLUMN IF EXISTS "mandate";
ALTER TABLE "stripe"."setup_intents" ADD COLUMN "mandate" text GENERATED ALWAYS AS ((raw_data->>'mandate')::text) STORED;

ALTER TABLE "stripe"."setup_intents" DROP COLUMN IF EXISTS "single_use_mandate";
ALTER TABLE "stripe"."setup_intents" ADD COLUMN "single_use_mandate" text GENERATED ALWAYS AS ((raw_data->>'single_use_mandate')::text) STORED;

ALTER TABLE "stripe"."setup_intents" DROP COLUMN IF EXISTS "on_behalf_of";
ALTER TABLE "stripe"."setup_intents" ADD COLUMN "on_behalf_of" text GENERATED ALWAYS AS ((raw_data->>'on_behalf_of')::text) STORED;

-- Recreate indexes
CREATE INDEX stripe_setup_intents_customer_idx ON "stripe"."setup_intents" USING btree (customer);

-- ============================================================================
-- SUBSCRIPTION_ITEMS
-- ============================================================================

ALTER TABLE "stripe"."subscription_items" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop and recreate columns as generated
ALTER TABLE "stripe"."subscription_items" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."subscription_items" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."subscription_items" DROP COLUMN IF EXISTS "billing_thresholds";
ALTER TABLE "stripe"."subscription_items" ADD COLUMN "billing_thresholds" jsonb GENERATED ALWAYS AS (raw_data->'billing_thresholds') STORED;

ALTER TABLE "stripe"."subscription_items" DROP COLUMN IF EXISTS "created";
ALTER TABLE "stripe"."subscription_items" ADD COLUMN "created" integer GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED;

ALTER TABLE "stripe"."subscription_items" DROP COLUMN IF EXISTS "deleted";
ALTER TABLE "stripe"."subscription_items" ADD COLUMN "deleted" boolean GENERATED ALWAYS AS ((raw_data->>'deleted')::boolean) STORED;

ALTER TABLE "stripe"."subscription_items" DROP COLUMN IF EXISTS "metadata";
ALTER TABLE "stripe"."subscription_items" ADD COLUMN "metadata" jsonb GENERATED ALWAYS AS (raw_data->'metadata') STORED;

ALTER TABLE "stripe"."subscription_items" DROP COLUMN IF EXISTS "quantity";
ALTER TABLE "stripe"."subscription_items" ADD COLUMN "quantity" integer GENERATED ALWAYS AS ((raw_data->>'quantity')::integer) STORED;

ALTER TABLE "stripe"."subscription_items" DROP COLUMN IF EXISTS "price";
ALTER TABLE "stripe"."subscription_items" ADD COLUMN "price" text GENERATED ALWAYS AS ((raw_data->>'price')::text) STORED;

ALTER TABLE "stripe"."subscription_items" DROP COLUMN IF EXISTS "subscription";
ALTER TABLE "stripe"."subscription_items" ADD COLUMN "subscription" text GENERATED ALWAYS AS ((raw_data->>'subscription')::text) STORED;

ALTER TABLE "stripe"."subscription_items" DROP COLUMN IF EXISTS "tax_rates";
ALTER TABLE "stripe"."subscription_items" ADD COLUMN "tax_rates" jsonb GENERATED ALWAYS AS (raw_data->'tax_rates') STORED;

ALTER TABLE "stripe"."subscription_items" DROP COLUMN IF EXISTS "current_period_end";
ALTER TABLE "stripe"."subscription_items" ADD COLUMN "current_period_end" integer GENERATED ALWAYS AS ((raw_data->>'current_period_end')::integer) STORED;

ALTER TABLE "stripe"."subscription_items" DROP COLUMN IF EXISTS "current_period_start";
ALTER TABLE "stripe"."subscription_items" ADD COLUMN "current_period_start" integer GENERATED ALWAYS AS ((raw_data->>'current_period_start')::integer) STORED;

-- ============================================================================
-- SUBSCRIPTION_SCHEDULES
-- ============================================================================

ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop and recreate columns as generated (enum status converted to text)
ALTER TABLE "stripe"."subscription_schedules" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."subscription_schedules" DROP COLUMN IF EXISTS "application";
ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN "application" text GENERATED ALWAYS AS ((raw_data->>'application')::text) STORED;

ALTER TABLE "stripe"."subscription_schedules" DROP COLUMN IF EXISTS "canceled_at";
ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN "canceled_at" integer GENERATED ALWAYS AS ((raw_data->>'canceled_at')::integer) STORED;

ALTER TABLE "stripe"."subscription_schedules" DROP COLUMN IF EXISTS "completed_at";
ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN "completed_at" integer GENERATED ALWAYS AS ((raw_data->>'completed_at')::integer) STORED;

ALTER TABLE "stripe"."subscription_schedules" DROP COLUMN IF EXISTS "created";
ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN "created" integer GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED;

ALTER TABLE "stripe"."subscription_schedules" DROP COLUMN IF EXISTS "current_phase";
ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN "current_phase" jsonb GENERATED ALWAYS AS (raw_data->'current_phase') STORED;

ALTER TABLE "stripe"."subscription_schedules" DROP COLUMN IF EXISTS "customer";
ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN "customer" text GENERATED ALWAYS AS ((raw_data->>'customer')::text) STORED;

ALTER TABLE "stripe"."subscription_schedules" DROP COLUMN IF EXISTS "default_settings";
ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN "default_settings" jsonb GENERATED ALWAYS AS (raw_data->'default_settings') STORED;

ALTER TABLE "stripe"."subscription_schedules" DROP COLUMN IF EXISTS "end_behavior";
ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN "end_behavior" text GENERATED ALWAYS AS ((raw_data->>'end_behavior')::text) STORED;

ALTER TABLE "stripe"."subscription_schedules" DROP COLUMN IF EXISTS "livemode";
ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN "livemode" boolean GENERATED ALWAYS AS ((raw_data->>'livemode')::boolean) STORED;

ALTER TABLE "stripe"."subscription_schedules" DROP COLUMN IF EXISTS "metadata";
ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN "metadata" jsonb GENERATED ALWAYS AS (raw_data->'metadata') STORED;

ALTER TABLE "stripe"."subscription_schedules" DROP COLUMN IF EXISTS "phases";
ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN "phases" jsonb GENERATED ALWAYS AS (raw_data->'phases') STORED;

ALTER TABLE "stripe"."subscription_schedules" DROP COLUMN IF EXISTS "released_at";
ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN "released_at" integer GENERATED ALWAYS AS ((raw_data->>'released_at')::integer) STORED;

ALTER TABLE "stripe"."subscription_schedules" DROP COLUMN IF EXISTS "released_subscription";
ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN "released_subscription" text GENERATED ALWAYS AS ((raw_data->>'released_subscription')::text) STORED;

ALTER TABLE "stripe"."subscription_schedules" DROP COLUMN IF EXISTS "status";
ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN "status" text GENERATED ALWAYS AS ((raw_data->>'status')::text) STORED;

ALTER TABLE "stripe"."subscription_schedules" DROP COLUMN IF EXISTS "subscription";
ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN "subscription" text GENERATED ALWAYS AS ((raw_data->>'subscription')::text) STORED;

ALTER TABLE "stripe"."subscription_schedules" DROP COLUMN IF EXISTS "test_clock";
ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN "test_clock" text GENERATED ALWAYS AS ((raw_data->>'test_clock')::text) STORED;

-- ============================================================================
-- SUBSCRIPTIONS
-- ============================================================================

ALTER TABLE "stripe"."subscriptions" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop and recreate columns as generated (enum status converted to text)
ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "cancel_at_period_end";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "cancel_at_period_end" boolean GENERATED ALWAYS AS ((raw_data->>'cancel_at_period_end')::boolean) STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "current_period_end";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "current_period_end" integer GENERATED ALWAYS AS ((raw_data->>'current_period_end')::integer) STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "current_period_start";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "current_period_start" integer GENERATED ALWAYS AS ((raw_data->>'current_period_start')::integer) STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "default_payment_method";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "default_payment_method" text GENERATED ALWAYS AS ((raw_data->>'default_payment_method')::text) STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "items";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "items" jsonb GENERATED ALWAYS AS (raw_data->'items') STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "metadata";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "metadata" jsonb GENERATED ALWAYS AS (raw_data->'metadata') STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "pending_setup_intent";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "pending_setup_intent" text GENERATED ALWAYS AS ((raw_data->>'pending_setup_intent')::text) STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "pending_update";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "pending_update" jsonb GENERATED ALWAYS AS (raw_data->'pending_update') STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "status";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "status" text GENERATED ALWAYS AS ((raw_data->>'status')::text) STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "application_fee_percent";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "application_fee_percent" double precision GENERATED ALWAYS AS ((raw_data->>'application_fee_percent')::double precision) STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "billing_cycle_anchor";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "billing_cycle_anchor" integer GENERATED ALWAYS AS ((raw_data->>'billing_cycle_anchor')::integer) STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "billing_thresholds";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "billing_thresholds" jsonb GENERATED ALWAYS AS (raw_data->'billing_thresholds') STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "cancel_at";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "cancel_at" integer GENERATED ALWAYS AS ((raw_data->>'cancel_at')::integer) STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "canceled_at";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "canceled_at" integer GENERATED ALWAYS AS ((raw_data->>'canceled_at')::integer) STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "collection_method";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "collection_method" text GENERATED ALWAYS AS ((raw_data->>'collection_method')::text) STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "created";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "created" integer GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "days_until_due";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "days_until_due" integer GENERATED ALWAYS AS ((raw_data->>'days_until_due')::integer) STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "default_source";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "default_source" text GENERATED ALWAYS AS ((raw_data->>'default_source')::text) STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "default_tax_rates";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "default_tax_rates" jsonb GENERATED ALWAYS AS (raw_data->'default_tax_rates') STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "discount";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "discount" jsonb GENERATED ALWAYS AS (raw_data->'discount') STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "ended_at";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "ended_at" integer GENERATED ALWAYS AS ((raw_data->>'ended_at')::integer) STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "livemode";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "livemode" boolean GENERATED ALWAYS AS ((raw_data->>'livemode')::boolean) STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "next_pending_invoice_item_invoice";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "next_pending_invoice_item_invoice" integer GENERATED ALWAYS AS ((raw_data->>'next_pending_invoice_item_invoice')::integer) STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "pause_collection";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "pause_collection" jsonb GENERATED ALWAYS AS (raw_data->'pause_collection') STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "pending_invoice_item_interval";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "pending_invoice_item_interval" jsonb GENERATED ALWAYS AS (raw_data->'pending_invoice_item_interval') STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "start_date";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "start_date" integer GENERATED ALWAYS AS ((raw_data->>'start_date')::integer) STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "transfer_data";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "transfer_data" jsonb GENERATED ALWAYS AS (raw_data->'transfer_data') STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "trial_end";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "trial_end" jsonb GENERATED ALWAYS AS (raw_data->'trial_end') STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "trial_start";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "trial_start" jsonb GENERATED ALWAYS AS (raw_data->'trial_start') STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "schedule";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "schedule" text GENERATED ALWAYS AS ((raw_data->>'schedule')::text) STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "customer";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "customer" text GENERATED ALWAYS AS ((raw_data->>'customer')::text) STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "latest_invoice";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "latest_invoice" text GENERATED ALWAYS AS ((raw_data->>'latest_invoice')::text) STORED;

ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "plan";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "plan" text GENERATED ALWAYS AS ((raw_data->>'plan')::text) STORED;

-- ============================================================================
-- TAX_IDS
-- ============================================================================

ALTER TABLE "stripe"."tax_ids" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;

-- Drop indexes
DROP INDEX IF EXISTS "stripe"."stripe_tax_ids_customer_idx";

-- Drop and recreate columns as generated
ALTER TABLE "stripe"."tax_ids" DROP COLUMN IF EXISTS "object";
ALTER TABLE "stripe"."tax_ids" ADD COLUMN "object" text GENERATED ALWAYS AS ((raw_data->>'object')::text) STORED;

ALTER TABLE "stripe"."tax_ids" DROP COLUMN IF EXISTS "country";
ALTER TABLE "stripe"."tax_ids" ADD COLUMN "country" text GENERATED ALWAYS AS ((raw_data->>'country')::text) STORED;

ALTER TABLE "stripe"."tax_ids" DROP COLUMN IF EXISTS "customer";
ALTER TABLE "stripe"."tax_ids" ADD COLUMN "customer" text GENERATED ALWAYS AS ((raw_data->>'customer')::text) STORED;

ALTER TABLE "stripe"."tax_ids" DROP COLUMN IF EXISTS "type";
ALTER TABLE "stripe"."tax_ids" ADD COLUMN "type" text GENERATED ALWAYS AS ((raw_data->>'type')::text) STORED;

ALTER TABLE "stripe"."tax_ids" DROP COLUMN IF EXISTS "value";
ALTER TABLE "stripe"."tax_ids" ADD COLUMN "value" text GENERATED ALWAYS AS ((raw_data->>'value')::text) STORED;

ALTER TABLE "stripe"."tax_ids" DROP COLUMN IF EXISTS "created";
ALTER TABLE "stripe"."tax_ids" ADD COLUMN "created" integer GENERATED ALWAYS AS ((raw_data->>'created')::integer) STORED;

ALTER TABLE "stripe"."tax_ids" DROP COLUMN IF EXISTS "livemode";
ALTER TABLE "stripe"."tax_ids" ADD COLUMN "livemode" boolean GENERATED ALWAYS AS ((raw_data->>'livemode')::boolean) STORED;

ALTER TABLE "stripe"."tax_ids" DROP COLUMN IF EXISTS "owner";
ALTER TABLE "stripe"."tax_ids" ADD COLUMN "owner" jsonb GENERATED ALWAYS AS (raw_data->'owner') STORED;

-- Recreate indexes
CREATE INDEX stripe_tax_ids_customer_idx ON "stripe"."tax_ids" USING btree (customer);

