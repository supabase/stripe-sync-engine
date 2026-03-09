create table
    if not exists "stripe"."promotion_codes" (
        "id" text primary key,
        "object" text,
        "active" boolean,
        "code" text,
        "coupon" text,
        "created" integer,
        "customer" text,
        "customer_account" text,
        "expires_at" integer,
        "livemode" boolean,
        "max_redemptions" bigint,
        "metadata" jsonb,
        "restrictions" jsonb,
        "times_redeemed" bigint,
        "updated_at" timestamptz default timezone('utc'::text, now()) not null,
        "last_synced_at" timestamptz
    );

create index stripe_promotion_codes_coupon_idx on "stripe"."promotion_codes" using btree (coupon);
create index stripe_promotion_codes_customer_idx on "stripe"."promotion_codes" using btree (customer);

create trigger handle_updated_at
    before update
    on stripe.promotion_codes
    for each row
    execute procedure set_updated_at();