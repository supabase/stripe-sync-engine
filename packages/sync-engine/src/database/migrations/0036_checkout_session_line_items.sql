create table if not exists "stripe"."checkout_session_line_items" (
  "id" text,
  "object" text,
  "adjustable_quantity" jsonb,
  "amount_subtotal" integer,
  "amount_total" integer,
  "currency" text,
  "description" text,
  "discounts" jsonb,
  "price" text,
  "quantity" integer,
  "taxes" jsonb,
  "checkout_session" text references "stripe"."checkout_sessions",
  "updated_at" timestamptz default timezone('utc'::text, now()) not null,
  "last_synced_at" timestamptz,
  primary key ("checkout_session", "id")
);

create index stripe_checkout_session_line_items_session_idx on "stripe"."checkout_session_line_items" using btree (checkout_session);
create index stripe_checkout_session_line_items_price_idx on "stripe"."checkout_session_line_items" using btree (price);

create trigger handle_updated_at
    before update
    on stripe.checkout_session_line_items
    for each row
    execute procedure set_updated_at(); 