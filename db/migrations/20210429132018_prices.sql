-- migrate:up

create type "stripe"."pricing_type" as enum ('one_time', 'recurring');
create type "stripe"."pricing_tiers" as enum ('graduated', 'volume');

create table "stripe"."prices" (
  "id" text primary key,
  "active" boolean,
  "currency" text,
  "metadata" jsonb,
  "nickname" text,
  "recurring" jsonb,
  "type" stripe.pricing_type,
  "unit_amount" integer,
  "billing_scheme" text,
  "created" integer,
  "livemode" boolean,
  "lookup_key" text,
  "tiers_mode" stripe.pricing_tiers,
  "transform_quantity" jsonb,
  "unit_amount_decimal" text,

  "product" text references stripe.products
);

-- migrate:down

drop table "stripe"."prices";
drop type "stripe"."pricing_type";
drop type "stripe"."pricing_tiers";

