-- migrate:up

create schema if not exists stripe;

-- migrate:down

drop schema if exists stripe;

