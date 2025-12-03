create table if not exists "{{schema}}"."payment_methods" (
    id text primary key,
    object text,
    created integer,
    customer text,
    type text,
    billing_details jsonb,
    metadata jsonb,
    card jsonb
);

CREATE INDEX stripe_payment_methods_customer_idx ON "{{schema}}"."payment_methods" USING btree (customer);