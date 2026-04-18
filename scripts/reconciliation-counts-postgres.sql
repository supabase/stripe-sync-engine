-- Reconciliation counts for sync-engine Postgres tables.
--
-- This destination database is assumed to already be scoped to the merchant
-- and mode you want to reconcile, so this query counts all rows in each table.
--
-- Usage:
--   psql "$DATABASE_URL" --csv -f scripts/reconciliation-counts-postgres.sql

SELECT *
FROM (
  SELECT 'customers' AS resource, count(*) AS n
  FROM public.customers

  UNION ALL
  SELECT 'payment_intents', count(*)
  FROM public.payment_intents

  UNION ALL
  SELECT 'invoices', count(*)
  FROM public.invoices

  UNION ALL
  SELECT 'invoiceitems', count(*)
  FROM public.invoiceitems

  UNION ALL
  SELECT 'subscriptions', count(*)
  FROM public.subscriptions

  UNION ALL
  SELECT 'plans', count(*)
  FROM public.plans

  UNION ALL
  SELECT 'products', count(*)
  FROM public.products

  UNION ALL
  SELECT 'payment_links', count(*)
  FROM public.payment_links

  UNION ALL
  SELECT 'payment_method_domains', count(*)
  FROM public.payment_method_domains

  UNION ALL
  SELECT 'tax_rates', count(*)
  FROM public.tax_rates

  UNION ALL
  SELECT 'tax_ids', count(*)
  FROM public.tax_ids

  UNION ALL
  SELECT 'file_links', count(*)
  FROM public.file_links

  UNION ALL
  SELECT 'quotes', count(*)
  FROM public.quotes

  UNION ALL
  SELECT 'promotion_codes', count(*)
  FROM public.promotion_codes

  UNION ALL
  SELECT 'payment_methods', count(*)
  FROM public.payment_methods

  UNION ALL
  SELECT 'climate_orders', count(*)
  FROM public.climate_orders

  UNION ALL
  SELECT 'checkout_sessions', count(*)
  FROM public.checkout_sessions

  UNION ALL
  SELECT 'prices', count(*)
  FROM public.prices

  UNION ALL
  SELECT 'treasury_financial_accounts', count(*)
  FROM public.treasury_financial_accounts
) q
ORDER BY resource;
