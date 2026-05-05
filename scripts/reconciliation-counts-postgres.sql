-- Reconciliation counts for sync-engine Postgres tables.
--
-- This destination database is assumed to already be scoped to the merchant
-- and mode you want to reconcile, so this query counts all rows in each table.
--
-- Usage:
--   psql "$DATABASE_URL" --csv -f scripts/reconciliation-counts-postgres.sql

SELECT *
FROM (
  SELECT 'customer' AS resource, count(*) AS n
  FROM public.customer

  UNION ALL
  SELECT 'payment_intent', count(*)
  FROM public.payment_intent

  UNION ALL
  SELECT 'invoice', count(*)
  FROM public.invoice

  UNION ALL
  SELECT 'invoice_line_item', count(*)
  FROM public.invoice_line_item

  UNION ALL
  SELECT 'subscription', count(*)
  FROM public.subscription

  UNION ALL
  SELECT 'plan', count(*)
  FROM public.plan

  UNION ALL
  SELECT 'product', count(*)
  FROM public.product

  UNION ALL
  SELECT 'payment_link', count(*)
  FROM public.payment_link

  UNION ALL
  SELECT 'payment_method_domain', count(*)
  FROM public.payment_method_domain

  UNION ALL
  SELECT 'tax_rate', count(*)
  FROM public.tax_rate

  UNION ALL
  SELECT 'tax_id', count(*)
  FROM public.tax_id

  UNION ALL
  SELECT 'file_link', count(*)
  FROM public.file_link

  UNION ALL
  SELECT 'quote', count(*)
  FROM public.quote

  UNION ALL
  SELECT 'promotion_code', count(*)
  FROM public.promotion_code

  UNION ALL
  SELECT 'payment_method', count(*)
  FROM public.payment_method

  UNION ALL
  SELECT 'climate_order', count(*)
  FROM public.climate_order

  UNION ALL
  SELECT 'checkout_session', count(*)
  FROM public.checkout_session

  UNION ALL
  SELECT 'price', count(*)
  FROM public.price

  UNION ALL
  SELECT 'treasury_financial_account', count(*)
  FROM public.treasury_financial_account
) q
ORDER BY resource;
