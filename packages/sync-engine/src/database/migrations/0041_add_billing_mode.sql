-- Add billing_mode column to subscriptions and subscription_schedules tables
-- This field stores the billing mode configuration for flexible billing support
-- See: https://docs.stripe.com/billing/subscriptions/billing-mode

ALTER TABLE "stripe"."subscriptions" 
ADD COLUMN IF NOT EXISTS "billing_mode" jsonb;

ALTER TABLE "stripe"."subscription_schedules" 
ADD COLUMN IF NOT EXISTS "billing_mode" jsonb;
