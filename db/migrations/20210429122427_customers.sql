-- migrate:up


create table "stripe"."customers" (
  "id" text primary key,
  "address" jsonb,
  "description" text,
  "email" text,
  "metadata" jsonb,
  "name" text,
  "phone" text,
  "shipping" jsonb,
  "balance" integer,
  "created" integer,
  "currency" text,
  "default_source" text,
  "delinquent" boolean,
  "discount" jsonb,
  "invoice_prefix" text,
  "invoice_settings" jsonb,
  "livemode" boolean,
  "next_invoice_sequence" integer,
  "preferred_locales" jsonb,
  "tax_exempt" text
);



-- migrate:down


drop table "stripe"."customers";