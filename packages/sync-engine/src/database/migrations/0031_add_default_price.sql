alter table "{{schema}}"."products"
add column IF NOT EXISTS "default_price" text;
