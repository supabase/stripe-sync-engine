create or replace function set_updated_at() returns trigger
    language plpgsql
as
$$
begin
  new.updated_at = now();
  return NEW;
end;
$$;

alter table "{{schema}}"."subscriptions"
    add updated_at timestamptz default timezone('utc'::text, now()) not null;

create trigger handle_updated_at
    before update
    on "{{schema}}"."subscriptions"
    for each row
    execute procedure set_updated_at();

alter table "{{schema}}"."products"
    add updated_at timestamptz default timezone('utc'::text, now()) not null;

create trigger handle_updated_at
    before update
    on "{{schema}}"."products"
    for each row
    execute procedure set_updated_at();

alter table "{{schema}}"."customers"
    add updated_at timestamptz default timezone('utc'::text, now()) not null;

create trigger handle_updated_at
    before update
    on "{{schema}}"."customers"
    for each row
    execute procedure set_updated_at();

alter table "{{schema}}"."prices"
    add updated_at timestamptz default timezone('utc'::text, now()) not null;

create trigger handle_updated_at
    before update
    on "{{schema}}"."prices"
    for each row
    execute procedure set_updated_at();

alter table "{{schema}}"."invoices"
    add updated_at timestamptz default timezone('utc'::text, now()) not null;

create trigger handle_updated_at
    before update
    on "{{schema}}"."invoices"
    for each row
    execute procedure set_updated_at();

alter table "{{schema}}"."charges"
    add updated_at timestamptz default timezone('utc'::text, now()) not null;

create trigger handle_updated_at
    before update
    on "{{schema}}"."charges"
    for each row
    execute procedure set_updated_at();

alter table "{{schema}}"."coupons"
    add updated_at timestamptz default timezone('utc'::text, now()) not null;

create trigger handle_updated_at
    before update
    on "{{schema}}"."coupons"
    for each row
    execute procedure set_updated_at();

alter table "{{schema}}"."disputes"
    add updated_at timestamptz default timezone('utc'::text, now()) not null;

create trigger handle_updated_at
    before update
    on "{{schema}}"."disputes"
    for each row
    execute procedure set_updated_at();

alter table "{{schema}}"."events"
    add updated_at timestamptz default timezone('utc'::text, now()) not null;

create trigger handle_updated_at
    before update
    on "{{schema}}"."events"
    for each row
    execute procedure set_updated_at();

alter table "{{schema}}"."payouts"
    add updated_at timestamptz default timezone('utc'::text, now()) not null;

create trigger handle_updated_at
    before update
    on "{{schema}}"."payouts"
    for each row
    execute procedure set_updated_at();

alter table "{{schema}}"."plans"
    add updated_at timestamptz default timezone('utc'::text, now()) not null;

create trigger handle_updated_at
    before update
    on "{{schema}}"."plans"
    for each row
    execute procedure set_updated_at();
