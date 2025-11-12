create table
    if not exists "stripe"."managed_webhooks" (
        "id" text primary key,
        "object" text,
        "uuid" text unique not null,
        "url" text not null,
        "enabled_events" jsonb not null,
        "description" text,
        "enabled" boolean,
        "livemode" boolean,
        "metadata" jsonb,
        "secret" text not null,
        "status" text,
        "api_version" text,
        "created" integer,
        "updated_at" timestamptz default timezone('utc'::text, now()) not null,
        "last_synced_at" timestamptz
    );

create index stripe_managed_webhooks_uuid_idx on "stripe"."managed_webhooks" using btree (uuid);
create index stripe_managed_webhooks_status_idx on "stripe"."managed_webhooks" using btree (status);
create index stripe_managed_webhooks_enabled_idx on "stripe"."managed_webhooks" using btree (enabled);

create trigger handle_updated_at
    before update
    on stripe.managed_webhooks
    for each row
    execute procedure set_updated_at();
