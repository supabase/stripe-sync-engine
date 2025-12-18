-- event_timestamp and event_type are not generated columns because they are not immutable. 
-- Postgres requires generated expressions to be immutable.

CREATE TABLE IF NOT EXISTS "stripe"."subscription_item_change_events_v2_beta" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz DEFAULT now(),
  "_account_id" text NOT NULL,

  "event_timestamp" timestamptz NOT NULL,
  "event_type" text NOT NULL,
  "subscription_item_id" text NOT NULL,

  PRIMARY KEY ("_account_id", "event_timestamp", "event_type", "subscription_item_id")
);

-- Foreign key to stripe.accounts
ALTER TABLE "stripe"."subscription_item_change_events_v2_beta"
  DROP CONSTRAINT IF EXISTS fk_subscription_item_change_events_v2_beta_account;
ALTER TABLE "stripe"."subscription_item_change_events_v2_beta"
  ADD CONSTRAINT fk_subscription_item_change_events_v2_beta_account
  FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

-- Maintain _updated_at on UPDATE
DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."subscription_item_change_events_v2_beta";
CREATE TRIGGER handle_updated_at
  BEFORE UPDATE ON "stripe"."subscription_item_change_events_v2_beta"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE "stripe"."subscription_item_change_events_v2_beta"
  ADD COLUMN IF NOT EXISTS "currency" text
    GENERATED ALWAYS AS ((NULLIF(_raw_data->>'currency', ''))::text) STORED;

ALTER TABLE "stripe"."subscription_item_change_events_v2_beta"
  ADD COLUMN IF NOT EXISTS "mrr_change" bigint
    GENERATED ALWAYS AS ((NULLIF(_raw_data->>'mrr_change', ''))::bigint) STORED;

ALTER TABLE "stripe"."subscription_item_change_events_v2_beta"
  ADD COLUMN IF NOT EXISTS "quantity_change" bigint
    GENERATED ALWAYS AS ((NULLIF(_raw_data->>'quantity_change', ''))::bigint) STORED;

ALTER TABLE "stripe"."subscription_item_change_events_v2_beta"
  ADD COLUMN IF NOT EXISTS "subscription_id" text
    GENERATED ALWAYS AS ((NULLIF(_raw_data->>'subscription_id', ''))::text) STORED;

ALTER TABLE "stripe"."subscription_item_change_events_v2_beta"
  ADD COLUMN IF NOT EXISTS "customer_id" text
    GENERATED ALWAYS AS ((NULLIF(_raw_data->>'customer_id', ''))::text) STORED;

ALTER TABLE "stripe"."subscription_item_change_events_v2_beta"
  ADD COLUMN IF NOT EXISTS "price_id" text
    GENERATED ALWAYS AS ((NULLIF(_raw_data->>'price_id', ''))::text) STORED;

ALTER TABLE "stripe"."subscription_item_change_events_v2_beta"
  ADD COLUMN IF NOT EXISTS "product_id" text
    GENERATED ALWAYS AS ((NULLIF(_raw_data->>'product_id', ''))::text) STORED;

-- Keep as text to avoid non-immutable timestamp casts in a generated column
ALTER TABLE "stripe"."subscription_item_change_events_v2_beta"
  ADD COLUMN IF NOT EXISTS "local_event_timestamp" text
    GENERATED ALWAYS AS ((NULLIF(_raw_data->>'local_event_timestamp', ''))::text) STORED;