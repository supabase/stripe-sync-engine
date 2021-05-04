SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: stripe; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA stripe;


--
-- Name: invoice_status; Type: TYPE; Schema: stripe; Owner: -
--

CREATE TYPE stripe.invoice_status AS ENUM (
    'draft',
    'open',
    'paid',
    'uncollectible',
    'void'
);


--
-- Name: pricing_tiers; Type: TYPE; Schema: stripe; Owner: -
--

CREATE TYPE stripe.pricing_tiers AS ENUM (
    'graduated',
    'volume'
);


--
-- Name: pricing_type; Type: TYPE; Schema: stripe; Owner: -
--

CREATE TYPE stripe.pricing_type AS ENUM (
    'one_time',
    'recurring'
);


--
-- Name: subscription_status; Type: TYPE; Schema: stripe; Owner: -
--

CREATE TYPE stripe.subscription_status AS ENUM (
    'trialing',
    'active',
    'canceled',
    'incomplete',
    'incomplete_expired',
    'past_due',
    'unpaid'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: customers; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.customers (
    id text NOT NULL,
    address jsonb,
    description text,
    email text,
    metadata jsonb,
    name text,
    phone text,
    shipping jsonb,
    balance integer,
    created integer,
    currency text,
    default_source text,
    delinquent boolean,
    discount jsonb,
    invoice_prefix text,
    invoice_settings jsonb,
    livemode boolean,
    next_invoice_sequence integer,
    preferred_locales jsonb,
    tax_exempt text
);


--
-- Name: invoices; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.invoices (
    id text NOT NULL,
    auto_advance boolean,
    collection_method text,
    currency text,
    description text,
    hosted_invoice_url text,
    lines jsonb,
    metadata jsonb,
    period_end integer,
    period_start integer,
    status stripe.invoice_status,
    total bigint,
    account_country text,
    account_name text,
    account_tax_ids jsonb,
    amount_due bigint,
    amount_paid bigint,
    amount_remaining bigint,
    application_fee_amount bigint,
    attempt_count integer,
    attempted boolean,
    billing_reason text,
    created integer,
    custom_fields jsonb,
    customer_address jsonb,
    customer_email text,
    customer_name text,
    customer_phone text,
    customer_shipping jsonb,
    customer_tax_exempt text,
    customer_tax_ids jsonb,
    default_tax_rates jsonb,
    discount jsonb,
    discounts jsonb,
    due_date integer,
    ending_balance integer,
    footer text,
    invoice_pdf text,
    last_finalization_error jsonb,
    livemode boolean,
    next_payment_attempt integer,
    number text,
    paid boolean,
    payment_settings jsonb,
    post_payment_credit_notes_amount integer,
    pre_payment_credit_notes_amount integer,
    receipt_number text,
    starting_balance integer,
    statement_descriptor text,
    status_transitions jsonb,
    subscription_proration_date integer,
    subtotal integer,
    tax integer,
    threshold_reason jsonb,
    total_discount_amounts jsonb,
    total_tax_amounts jsonb,
    transfer_data jsonb,
    webhooks_delivered_at integer,
    customer text,
    subscription text,
    payment_intent text,
    default_payment_method text,
    default_source text,
    on_behalf_of text,
    charge text
);


--
-- Name: prices; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.prices (
    id text NOT NULL,
    active boolean,
    currency text,
    metadata jsonb,
    nickname text,
    recurring jsonb,
    type stripe.pricing_type,
    unit_amount integer,
    billing_scheme text,
    created integer,
    livemode boolean,
    lookup_key text,
    tiers_mode stripe.pricing_tiers,
    transform_quantity jsonb,
    unit_amount_decimal text,
    product text
);


--
-- Name: products; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.products (
    id text NOT NULL,
    active boolean,
    description text,
    metadata jsonb,
    name text,
    created integer,
    images jsonb,
    livemode boolean,
    package_dimensions jsonb,
    shippable boolean,
    statement_descriptor text,
    unit_label text,
    updated integer,
    url text
);


--
-- Name: schema_migrations; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.schema_migrations (
    version character varying(255) NOT NULL
);


--
-- Name: subscriptions; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.subscriptions (
    id text NOT NULL,
    cancel_at_period_end boolean,
    current_period_end integer,
    current_period_start integer,
    default_payment_method text,
    items jsonb,
    metadata jsonb,
    pending_setup_intent text,
    pending_update jsonb,
    status stripe.subscription_status,
    application_fee_percent numeric(5,2),
    billing_cycle_anchor integer,
    billing_thresholds jsonb,
    cancel_at integer,
    canceled_at integer,
    collection_method text,
    created integer,
    days_until_due integer,
    default_source text,
    default_tax_rates jsonb,
    discount jsonb,
    ended_at integer,
    livemode boolean,
    next_pending_invoice_item_invoice integer,
    pause_collection jsonb,
    pending_invoice_item_interval jsonb,
    start_date integer,
    transfer_data jsonb,
    trial_end jsonb,
    trial_start jsonb,
    schedule text,
    customer text,
    latest_invoice text
);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: prices prices_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.prices
    ADD CONSTRAINT prices_pkey PRIMARY KEY (id);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: subscriptions fk_latest_invoice; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.subscriptions
    ADD CONSTRAINT fk_latest_invoice FOREIGN KEY (latest_invoice) REFERENCES stripe.invoices(id);


--
-- Name: invoices invoices_customer_fkey; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.invoices
    ADD CONSTRAINT invoices_customer_fkey FOREIGN KEY (customer) REFERENCES stripe.customers(id);


--
-- Name: invoices invoices_subscription_fkey; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.invoices
    ADD CONSTRAINT invoices_subscription_fkey FOREIGN KEY (subscription) REFERENCES stripe.subscriptions(id);


--
-- Name: prices prices_product_fkey; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.prices
    ADD CONSTRAINT prices_product_fkey FOREIGN KEY (product) REFERENCES stripe.products(id);


--
-- Name: subscriptions subscriptions_customer_fkey; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.subscriptions
    ADD CONSTRAINT subscriptions_customer_fkey FOREIGN KEY (customer) REFERENCES stripe.customers(id);


--
-- PostgreSQL database dump complete
--


--
-- Dbmate schema migrations
--

INSERT INTO stripe.schema_migrations (version) VALUES
    ('20210428143758'),
    ('20210428143846'),
    ('20210429122427'),
    ('20210429132018'),
    ('20210429140401'),
    ('20210501054139'),
    ('20210501054140');
