create table if not exists "{{schema}}"."subscription_items" (
  "id" text primary key,
  "object" text,
  "billing_thresholds" jsonb,
  "created" integer,
  "deleted" boolean,
  "metadata" jsonb,
  "quantity" integer,
  "price" text references "{{schema}}"."prices",
  "subscription" text references "{{schema}}"."subscriptions",
  "tax_rates" jsonb
);