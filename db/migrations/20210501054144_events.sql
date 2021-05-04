-- migrate:up


CREATE TABLE stripe.events (
    id text primary key,
    object text,
    data jsonb,
    type text,
    created integer,
    request text,
    updated integer,
    livemode boolean,
    api_version text,
    pending_webhooks bigint
);


-- migrate:down

drop table "stripe"."events";