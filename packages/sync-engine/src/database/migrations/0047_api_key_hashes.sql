-- Add api_key_hashes array column to accounts table
-- This stores SHA-256 hashes of Stripe API keys for fast account lookups
-- Enables lookup of account ID by API key hash without making Stripe API calls
-- Supports multiple API keys per account (test/live keys, rotated keys, etc.)

-- Step 1: Add api_key_hashes column as TEXT array
ALTER TABLE "stripe"."accounts" ADD COLUMN "api_key_hashes" TEXT[] DEFAULT '{}';

-- Step 2: Create GIN index for fast array containment lookups
-- This enables efficient queries like: WHERE 'hash_value' = ANY(api_key_hashes)
CREATE INDEX IF NOT EXISTS idx_accounts_api_key_hashes
  ON "stripe"."accounts" USING GIN (api_key_hashes);
