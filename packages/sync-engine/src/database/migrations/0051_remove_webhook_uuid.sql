-- Remove UUID from managed webhooks
-- UUID-based routing is no longer used; webhooks are identified by exact URL match
-- Legacy webhooks with UUID in URL will be automatically deleted and recreated

drop index if exists "stripe"."stripe_managed_webhooks_uuid_idx";

alter table "stripe"."_managed_webhooks" drop column if exists "uuid";
