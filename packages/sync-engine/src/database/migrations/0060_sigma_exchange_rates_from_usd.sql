
CREATE TABLE IF NOT EXISTS "stripe"."exchange_rates_from_usd" (
  "_raw_data" jsonb NOT NULL,
  "_last_synced_at" timestamptz,
  "_updated_at" timestamptz DEFAULT now(),
  "_account_id" text NOT NULL,

  "date" date NOT NULL,
  "sell_currency" text NOT NULL,

  PRIMARY KEY ("_account_id", "date", "sell_currency")
);

-- Foreign key to stripe.accounts
ALTER TABLE "stripe"."exchange_rates_from_usd"
  DROP CONSTRAINT IF EXISTS fk_exchange_rates_from_usd_account;
ALTER TABLE "stripe"."exchange_rates_from_usd"
  ADD CONSTRAINT fk_exchange_rates_from_usd_account
  FOREIGN KEY ("_account_id") REFERENCES "stripe"."accounts" (id);

-- Maintain _updated_at on UPDATE
DROP TRIGGER IF EXISTS handle_updated_at ON "stripe"."exchange_rates_from_usd";
CREATE TRIGGER handle_updated_at
  BEFORE UPDATE ON "stripe"."exchange_rates_from_usd"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE "stripe"."exchange_rates_from_usd"
  ADD COLUMN IF NOT EXISTS "buy_currency_exchange_rates" text
    GENERATED ALWAYS AS ((NULLIF(_raw_data->>'buy_currency_exchange_rates', ''))::text) STORED;

-- Index on date for efficient range queries
CREATE INDEX IF NOT EXISTS idx_exchange_rates_from_usd_date
  ON "stripe"."exchange_rates_from_usd" ("date");

-- Index on sell_currency for filtering by currency
CREATE INDEX IF NOT EXISTS idx_exchange_rates_from_usd_sell_currency
  ON "stripe"."exchange_rates_from_usd" ("sell_currency");

