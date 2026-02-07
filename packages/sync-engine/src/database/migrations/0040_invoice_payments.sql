create table
    if not exists "{{schema}}"."invoice_payments" (
        "id" text primary key,
        object text,
        amount_paid bigint,
        amount_requested bigint,
        created integer,
        currency text,
        invoice text,
        is_default boolean,
        livemode boolean,
        payment jsonb,
        status text,
        status_transitions jsonb,
        last_synced_at timestamptz,
        updated_at timestamptz default timezone('utc'::text, now()) not null
    );

create index "{{schema}}_invoice_payments_invoice_idx" on "{{schema}}"."invoice_payments" using btree (invoice);

create trigger handle_updated_at
    before update
    on "{{schema}}"."invoice_payments"
    for each row
    execute procedure set_updated_at();
