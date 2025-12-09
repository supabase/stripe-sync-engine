-- Fix generated columns: must drop and recreate with ::bigint cast
-- Money columns that can overflow PostgreSQL integer max (~2.1 billion)

-- checkout_session_line_items
ALTER TABLE "stripe"."checkout_session_line_items" DROP COLUMN "amount_discount";
ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN "amount_discount" bigint GENERATED ALWAYS AS ((_raw_data->>'amount_discount')::bigint) STORED;
ALTER TABLE "stripe"."checkout_session_line_items" DROP COLUMN "amount_subtotal";
ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN "amount_subtotal" bigint GENERATED ALWAYS AS ((_raw_data->>'amount_subtotal')::bigint) STORED;
ALTER TABLE "stripe"."checkout_session_line_items" DROP COLUMN "amount_tax";
ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN "amount_tax" bigint GENERATED ALWAYS AS ((_raw_data->>'amount_tax')::bigint) STORED;
ALTER TABLE "stripe"."checkout_session_line_items" DROP COLUMN "amount_total";
ALTER TABLE "stripe"."checkout_session_line_items" ADD COLUMN "amount_total" bigint GENERATED ALWAYS AS ((_raw_data->>'amount_total')::bigint) STORED;

-- checkout_sessions
ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN "amount_subtotal";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "amount_subtotal" bigint GENERATED ALWAYS AS ((_raw_data->>'amount_subtotal')::bigint) STORED;
ALTER TABLE "stripe"."checkout_sessions" DROP COLUMN "amount_total";
ALTER TABLE "stripe"."checkout_sessions" ADD COLUMN "amount_total" bigint GENERATED ALWAYS AS ((_raw_data->>'amount_total')::bigint) STORED;

-- credit_notes
ALTER TABLE "stripe"."credit_notes" DROP COLUMN "amount";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "amount" bigint GENERATED ALWAYS AS ((_raw_data->>'amount')::bigint) STORED;
ALTER TABLE "stripe"."credit_notes" DROP COLUMN "amount_shipping";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "amount_shipping" bigint GENERATED ALWAYS AS ((_raw_data->>'amount_shipping')::bigint) STORED;
ALTER TABLE "stripe"."credit_notes" DROP COLUMN "discount_amount";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "discount_amount" bigint GENERATED ALWAYS AS ((_raw_data->>'discount_amount')::bigint) STORED;
ALTER TABLE "stripe"."credit_notes" DROP COLUMN "out_of_band_amount";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "out_of_band_amount" bigint GENERATED ALWAYS AS ((_raw_data->>'out_of_band_amount')::bigint) STORED;
ALTER TABLE "stripe"."credit_notes" DROP COLUMN "subtotal";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "subtotal" bigint GENERATED ALWAYS AS ((_raw_data->>'subtotal')::bigint) STORED;
ALTER TABLE "stripe"."credit_notes" DROP COLUMN "subtotal_excluding_tax";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "subtotal_excluding_tax" bigint GENERATED ALWAYS AS ((_raw_data->>'subtotal_excluding_tax')::bigint) STORED;
ALTER TABLE "stripe"."credit_notes" DROP COLUMN "total";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "total" bigint GENERATED ALWAYS AS ((_raw_data->>'total')::bigint) STORED;
ALTER TABLE "stripe"."credit_notes" DROP COLUMN "total_excluding_tax";
ALTER TABLE "stripe"."credit_notes" ADD COLUMN "total_excluding_tax" bigint GENERATED ALWAYS AS ((_raw_data->>'total_excluding_tax')::bigint) STORED;

-- customers
ALTER TABLE "stripe"."customers" DROP COLUMN "balance";
ALTER TABLE "stripe"."customers" ADD COLUMN "balance" bigint GENERATED ALWAYS AS ((_raw_data->>'balance')::bigint) STORED;

-- invoices
ALTER TABLE "stripe"."invoices" DROP COLUMN "ending_balance";
ALTER TABLE "stripe"."invoices" ADD COLUMN "ending_balance" bigint GENERATED ALWAYS AS ((_raw_data->>'ending_balance')::bigint) STORED;
ALTER TABLE "stripe"."invoices" DROP COLUMN "starting_balance";
ALTER TABLE "stripe"."invoices" ADD COLUMN "starting_balance" bigint GENERATED ALWAYS AS ((_raw_data->>'starting_balance')::bigint) STORED;
ALTER TABLE "stripe"."invoices" DROP COLUMN "subtotal";
ALTER TABLE "stripe"."invoices" ADD COLUMN "subtotal" bigint GENERATED ALWAYS AS ((_raw_data->>'subtotal')::bigint) STORED;
ALTER TABLE "stripe"."invoices" DROP COLUMN "tax";
ALTER TABLE "stripe"."invoices" ADD COLUMN "tax" bigint GENERATED ALWAYS AS ((_raw_data->>'tax')::bigint) STORED;
ALTER TABLE "stripe"."invoices" DROP COLUMN "post_payment_credit_notes_amount";
ALTER TABLE "stripe"."invoices" ADD COLUMN "post_payment_credit_notes_amount" bigint GENERATED ALWAYS AS ((_raw_data->>'post_payment_credit_notes_amount')::bigint) STORED;
ALTER TABLE "stripe"."invoices" DROP COLUMN "pre_payment_credit_notes_amount";
ALTER TABLE "stripe"."invoices" ADD COLUMN "pre_payment_credit_notes_amount" bigint GENERATED ALWAYS AS ((_raw_data->>'pre_payment_credit_notes_amount')::bigint) STORED;

-- payment_intents
ALTER TABLE "stripe"."payment_intents" DROP COLUMN "amount";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "amount" bigint GENERATED ALWAYS AS ((_raw_data->>'amount')::bigint) STORED;
ALTER TABLE "stripe"."payment_intents" DROP COLUMN "amount_capturable";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "amount_capturable" bigint GENERATED ALWAYS AS ((_raw_data->>'amount_capturable')::bigint) STORED;
ALTER TABLE "stripe"."payment_intents" DROP COLUMN "amount_received";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "amount_received" bigint GENERATED ALWAYS AS ((_raw_data->>'amount_received')::bigint) STORED;
ALTER TABLE "stripe"."payment_intents" DROP COLUMN "application_fee_amount";
ALTER TABLE "stripe"."payment_intents" ADD COLUMN "application_fee_amount" bigint GENERATED ALWAYS AS ((_raw_data->>'application_fee_amount')::bigint) STORED;

-- prices
ALTER TABLE "stripe"."prices" DROP COLUMN "unit_amount";
ALTER TABLE "stripe"."prices" ADD COLUMN "unit_amount" bigint GENERATED ALWAYS AS ((_raw_data->>'unit_amount')::bigint) STORED;

-- refunds
ALTER TABLE "stripe"."refunds" DROP COLUMN "amount";
ALTER TABLE "stripe"."refunds" ADD COLUMN "amount" bigint GENERATED ALWAYS AS ((_raw_data->>'amount')::bigint) STORED;
