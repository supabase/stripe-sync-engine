DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_type t
        JOIN pg_namespace n ON t.typnamespace = n.oid
        WHERE t.typname = 'pricing_type' AND n.nspname = '{{schema}}'
    ) THEN
        create type "{{schema}}"."pricing_type" as enum ('one_time', 'recurring');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_type t
        JOIN pg_namespace n ON t.typnamespace = n.oid
        WHERE t.typname = 'pricing_tiers' AND n.nspname = '{{schema}}'
    ) THEN
        create type "{{schema}}"."pricing_tiers" as enum ('graduated', 'volume');
    END IF;
END
$$;


create table if not exists "{{schema}}"."prices" (
  "id" text primary key,
  "object" text,
  "active" boolean,
  "currency" text,
  "metadata" jsonb,
  "nickname" text,
  "recurring" jsonb,
  "type" "{{schema}}"."pricing_type",
  "unit_amount" integer,
  "billing_scheme" text,
  "created" integer,
  "livemode" boolean,
  "lookup_key" text,
  "tiers_mode" "{{schema}}"."pricing_tiers",
  "transform_quantity" jsonb,
  "unit_amount_decimal" text,

  "product" text references "{{schema}}"."products"
);

