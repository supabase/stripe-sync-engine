create table
    if not exists "stripe"."early_fraud_warnings" (
        "id" text primary key,
        object text,
        actionable boolean,
        charge text,
        created integer,
        fraud_type text,
        livemode boolean,
        payment_intent text,
        updated_at timestamptz default timezone('utc'::text, now()) not null
    );

create index stripe_early_fraud_warnings_customer_idx on "stripe"."early_fraud_warnings" using btree (charge);

create index stripe_early_fraud_warnings_invoice_idx on "stripe"."early_fraud_warnings" using btree (payment_intent);

create trigger handle_updated_at
    before update
    on stripe.early_fraud_warnings
    for each row
    execute procedure set_updated_at();
