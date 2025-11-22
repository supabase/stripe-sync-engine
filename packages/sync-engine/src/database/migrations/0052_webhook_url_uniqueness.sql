-- Add unique constraint on URL per account to prevent duplicate webhooks at database level
-- This prevents race conditions where multiple instances try to create webhooks for the same URL
-- Since UUIDs have been removed from URLs, we can enforce strict uniqueness on the URL column per account
-- Note: Different accounts can have webhooks with the same URL

alter table "stripe"."_managed_webhooks"
  add constraint managed_webhooks_url_account_unique unique ("url", "account_id");
