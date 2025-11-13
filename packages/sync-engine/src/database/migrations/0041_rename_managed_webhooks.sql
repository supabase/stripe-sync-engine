-- Rename managed_webhooks table to _managed_webhooks
alter table if exists "stripe"."managed_webhooks" rename to "_managed_webhooks";
