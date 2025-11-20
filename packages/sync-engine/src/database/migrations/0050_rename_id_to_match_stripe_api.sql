-- Rename _id back to id to match Stripe API field names
--
-- Migration 0048 added underscore prefixes to all "reserved" columns including id.
-- However, id is actually a field that comes directly from the Stripe API and should
-- match the API naming for agent/user comprehension.
--
-- Additionally, this migration converts id from a regular column to a GENERATED column
-- derived from _raw_data->>'id', ensuring the raw_data is the single source of truth.

-- ============================================================================
-- Step 1: Drop all foreign key constraints referencing accounts._id
-- ============================================================================

ALTER TABLE "stripe"."active_entitlements" DROP CONSTRAINT IF EXISTS fk_active_entitlements_account;
ALTER TABLE "stripe"."charges" DROP CONSTRAINT IF EXISTS fk_charges_account;
ALTER TABLE "stripe"."checkout_session_line_items" DROP CONSTRAINT IF EXISTS fk_checkout_session_line_items_account;
ALTER TABLE "stripe"."checkout_sessions" DROP CONSTRAINT IF EXISTS fk_checkout_sessions_account;
ALTER TABLE "stripe"."credit_notes" DROP CONSTRAINT IF EXISTS fk_credit_notes_account;
ALTER TABLE "stripe"."customers" DROP CONSTRAINT IF EXISTS fk_customers_account;
ALTER TABLE "stripe"."disputes" DROP CONSTRAINT IF EXISTS fk_disputes_account;
ALTER TABLE "stripe"."early_fraud_warnings" DROP CONSTRAINT IF EXISTS fk_early_fraud_warnings_account;
ALTER TABLE "stripe"."features" DROP CONSTRAINT IF EXISTS fk_features_account;
ALTER TABLE "stripe"."invoices" DROP CONSTRAINT IF EXISTS fk_invoices_account;
ALTER TABLE "stripe"."_managed_webhooks" DROP CONSTRAINT IF EXISTS fk_managed_webhooks_account;
ALTER TABLE "stripe"."payment_intents" DROP CONSTRAINT IF EXISTS fk_payment_intents_account;
ALTER TABLE "stripe"."payment_methods" DROP CONSTRAINT IF EXISTS fk_payment_methods_account;
ALTER TABLE "stripe"."plans" DROP CONSTRAINT IF EXISTS fk_plans_account;
ALTER TABLE "stripe"."prices" DROP CONSTRAINT IF EXISTS fk_prices_account;
ALTER TABLE "stripe"."products" DROP CONSTRAINT IF EXISTS fk_products_account;
ALTER TABLE "stripe"."refunds" DROP CONSTRAINT IF EXISTS fk_refunds_account;
ALTER TABLE "stripe"."reviews" DROP CONSTRAINT IF EXISTS fk_reviews_account;
ALTER TABLE "stripe"."setup_intents" DROP CONSTRAINT IF EXISTS fk_setup_intents_account;
ALTER TABLE "stripe"."subscription_items" DROP CONSTRAINT IF EXISTS fk_subscription_items_account;
ALTER TABLE "stripe"."subscription_schedules" DROP CONSTRAINT IF EXISTS fk_subscription_schedules_account;
ALTER TABLE "stripe"."subscriptions" DROP CONSTRAINT IF EXISTS fk_subscriptions_account;
ALTER TABLE "stripe"."tax_ids" DROP CONSTRAINT IF EXISTS fk_tax_ids_account;
ALTER TABLE "stripe"."_sync_status" DROP CONSTRAINT IF EXISTS fk_sync_status_account;

-- ============================================================================
-- Step 2: Convert accounts._id to generated column accounts.id
-- ============================================================================

ALTER TABLE "stripe"."accounts" DROP CONSTRAINT IF EXISTS accounts_pkey;
ALTER TABLE "stripe"."accounts" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."accounts" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."accounts" ADD PRIMARY KEY (id);

-- ============================================================================
-- Step 3: Convert _id to generated column id for all Stripe entity tables
-- ============================================================================

-- active_entitlements
ALTER TABLE "stripe"."active_entitlements" DROP CONSTRAINT IF EXISTS active_entitlements_pkey;
ALTER TABLE "stripe"."active_entitlements" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."active_entitlements" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."active_entitlements" ADD PRIMARY KEY (id);

-- charges
ALTER TABLE "stripe"."charges" DROP CONSTRAINT IF EXISTS charges_pkey;
ALTER TABLE "stripe"."charges" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."charges" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."charges" ADD PRIMARY KEY (id);

-- checkout_session_line_items
ALTER TABLE "stripe"."checkout_session_line_items" DROP CONSTRAINT IF EXISTS checkout_session_line_items_pkey;
ALTER TABLE "stripe"."checkout_session_line_items" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."checkout_session_line_items" ADD PRIMARY KEY (id);

-- checkout_sessions
ALTER TABLE "stripe"."checkout_sessions" DROP CONSTRAINT IF EXISTS checkout_sessions_pkey;
ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."checkout_sessions" ADD PRIMARY KEY (id);

-- credit_notes
ALTER TABLE "stripe"."credit_notes" DROP CONSTRAINT IF EXISTS credit_notes_pkey;
ALTER TABLE "stripe"."credit_notes" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."credit_notes" ADD PRIMARY KEY (id);

-- coupons
ALTER TABLE "stripe"."coupons" DROP CONSTRAINT IF EXISTS coupons_pkey;
ALTER TABLE "stripe"."coupons" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."coupons" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."coupons" ADD PRIMARY KEY (id);

-- customers
ALTER TABLE "stripe"."customers" DROP CONSTRAINT IF EXISTS customers_pkey;
ALTER TABLE "stripe"."customers" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."customers" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."customers" ADD PRIMARY KEY (id);

-- disputes
ALTER TABLE "stripe"."disputes" DROP CONSTRAINT IF EXISTS disputes_pkey;
ALTER TABLE "stripe"."disputes" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."disputes" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."disputes" ADD PRIMARY KEY (id);

-- early_fraud_warnings
ALTER TABLE "stripe"."early_fraud_warnings" DROP CONSTRAINT IF EXISTS early_fraud_warnings_pkey;
ALTER TABLE "stripe"."early_fraud_warnings" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."early_fraud_warnings" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."early_fraud_warnings" ADD PRIMARY KEY (id);

-- events
ALTER TABLE "stripe"."events" DROP CONSTRAINT IF EXISTS events_pkey;
ALTER TABLE "stripe"."events" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."events" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."events" ADD PRIMARY KEY (id);

-- features
ALTER TABLE "stripe"."features" DROP CONSTRAINT IF EXISTS features_pkey;
ALTER TABLE "stripe"."features" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."features" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."features" ADD PRIMARY KEY (id);

-- invoices
ALTER TABLE "stripe"."invoices" DROP CONSTRAINT IF EXISTS invoices_pkey;
ALTER TABLE "stripe"."invoices" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."invoices" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."invoices" ADD PRIMARY KEY (id);

-- payment_intents
ALTER TABLE "stripe"."payment_intents" DROP CONSTRAINT IF EXISTS payment_intents_pkey;
ALTER TABLE "stripe"."payment_intents" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."payment_intents" ADD PRIMARY KEY (id);

-- payment_methods
ALTER TABLE "stripe"."payment_methods" DROP CONSTRAINT IF EXISTS payment_methods_pkey;
ALTER TABLE "stripe"."payment_methods" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."payment_methods" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."payment_methods" ADD PRIMARY KEY (id);

-- payouts
ALTER TABLE "stripe"."payouts" DROP CONSTRAINT IF EXISTS payouts_pkey;
ALTER TABLE "stripe"."payouts" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."payouts" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."payouts" ADD PRIMARY KEY (id);

-- plans
ALTER TABLE "stripe"."plans" DROP CONSTRAINT IF EXISTS plans_pkey;
ALTER TABLE "stripe"."plans" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."plans" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."plans" ADD PRIMARY KEY (id);

-- prices
ALTER TABLE "stripe"."prices" DROP CONSTRAINT IF EXISTS prices_pkey;
ALTER TABLE "stripe"."prices" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."prices" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."prices" ADD PRIMARY KEY (id);

-- products
ALTER TABLE "stripe"."products" DROP CONSTRAINT IF EXISTS products_pkey;
ALTER TABLE "stripe"."products" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."products" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."products" ADD PRIMARY KEY (id);

-- refunds
ALTER TABLE "stripe"."refunds" DROP CONSTRAINT IF EXISTS refunds_pkey;
ALTER TABLE "stripe"."refunds" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."refunds" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."refunds" ADD PRIMARY KEY (id);

-- reviews
ALTER TABLE "stripe"."reviews" DROP CONSTRAINT IF EXISTS reviews_pkey;
ALTER TABLE "stripe"."reviews" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."reviews" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."reviews" ADD PRIMARY KEY (id);

-- setup_intents
ALTER TABLE "stripe"."setup_intents" DROP CONSTRAINT IF EXISTS setup_intents_pkey;
ALTER TABLE "stripe"."setup_intents" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."setup_intents" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."setup_intents" ADD PRIMARY KEY (id);

-- subscription_items
ALTER TABLE "stripe"."subscription_items" DROP CONSTRAINT IF EXISTS subscription_items_pkey;
ALTER TABLE "stripe"."subscription_items" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."subscription_items" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."subscription_items" ADD PRIMARY KEY (id);

-- subscription_schedules
ALTER TABLE "stripe"."subscription_schedules" DROP CONSTRAINT IF EXISTS subscription_schedules_pkey;
ALTER TABLE "stripe"."subscription_schedules" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."subscription_schedules" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."subscription_schedules" ADD PRIMARY KEY (id);

-- subscriptions
ALTER TABLE "stripe"."subscriptions" DROP CONSTRAINT IF EXISTS subscriptions_pkey;
ALTER TABLE "stripe"."subscriptions" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."subscriptions" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."subscriptions" ADD PRIMARY KEY (id);

-- tax_ids
ALTER TABLE "stripe"."tax_ids" DROP CONSTRAINT IF EXISTS tax_ids_pkey;
ALTER TABLE "stripe"."tax_ids" DROP COLUMN IF EXISTS "_id";
ALTER TABLE "stripe"."tax_ids" ADD COLUMN "id" TEXT GENERATED ALWAYS AS ((_raw_data->>'id')::TEXT) STORED;
ALTER TABLE "stripe"."tax_ids" ADD PRIMARY KEY (id);

-- ============================================================================
-- Step 4: Handle metadata tables
-- ============================================================================

-- _managed_webhooks (internal metadata table, doesn't use _raw_data pattern)
-- Already uses "id" without underscore (migration 0049), no changes needed

-- _sync_status (internal table, uses auto-incrementing id not from Stripe)
-- Already uses "id" without underscore (migration 0049), no changes needed

-- ============================================================================
-- Step 5: Recreate all foreign key constraints
-- ============================================================================

ALTER TABLE "stripe"."active_entitlements" ADD CONSTRAINT fk_active_entitlements_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."charges" ADD CONSTRAINT fk_charges_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."checkout_session_line_items" ADD CONSTRAINT fk_checkout_session_line_items_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."checkout_sessions" ADD CONSTRAINT fk_checkout_sessions_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."credit_notes" ADD CONSTRAINT fk_credit_notes_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."customers" ADD CONSTRAINT fk_customers_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."disputes" ADD CONSTRAINT fk_disputes_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."early_fraud_warnings" ADD CONSTRAINT fk_early_fraud_warnings_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."features" ADD CONSTRAINT fk_features_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."invoices" ADD CONSTRAINT fk_invoices_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."_managed_webhooks" ADD CONSTRAINT fk_managed_webhooks_account FOREIGN KEY ("account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."payment_intents" ADD CONSTRAINT fk_payment_intents_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."payment_methods" ADD CONSTRAINT fk_payment_methods_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."plans" ADD CONSTRAINT fk_plans_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."prices" ADD CONSTRAINT fk_prices_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."products" ADD CONSTRAINT fk_products_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."refunds" ADD CONSTRAINT fk_refunds_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."reviews" ADD CONSTRAINT fk_reviews_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."setup_intents" ADD CONSTRAINT fk_setup_intents_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."subscription_items" ADD CONSTRAINT fk_subscription_items_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."subscription_schedules" ADD CONSTRAINT fk_subscription_schedules_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."subscriptions" ADD CONSTRAINT fk_subscriptions_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."tax_ids" ADD CONSTRAINT fk_tax_ids_account FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);
ALTER TABLE "stripe"."_sync_status" ADD CONSTRAINT fk_sync_status_account FOREIGN KEY ("account_id") REFERENCES "stripe"."accounts" (id);
