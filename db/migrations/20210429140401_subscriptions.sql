-- migrate:up

create type "stripe"."subscription_status" as enum ('trialing', 'active', 'canceled', 'incomplete', 'incomplete_expired', 'past_due', 'unpaid');
create table "stripe"."subscriptions" (
  "id" text primary key,
  "cancel_at_period_end" boolean,
  "current_period_end" integer,
  "current_period_start" integer,
  "default_payment_method" text,
  "items" jsonb,
  "metadata" jsonb,
  "pending_setup_intent" text,
  "pending_update" jsonb,
  "status" subscription_status,
  "application_fee_percent" numeric(5, 2),
  "billing_cycle_anchor" integer,
  "billing_thresholds" jsonb,
  "cancel_at" integer,
  "canceled_at" integer,
  "collection_method" text,
  "created" integer,
  "days_until_due" integer,
  "default_source" text,
  "default_tax_rates" jsonb,
  "discount" jsonb,
  "ended_at" integer,
  "livemode" boolean,
  "next_pending_invoice_item_invoice" integer,
  "pause_collection" jsonb,
  "pending_invoice_item_interval" jsonb,
  "start_date" integer,
  "transfer_data" jsonb,
  "trial_end" jsonb,
  "trial_start" jsonb,

  "schedule" text,
  "customer" text references "stripe"."customers",
  "latest_invoice" text -- not yet joined
);


-- migrate:down

drop table "stripe"."subscriptions";
drop type "stripe"."subscription_status";