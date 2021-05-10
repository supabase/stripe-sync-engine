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
-- Name: charges; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.charges (
    id text NOT NULL,
    object text,
    card jsonb,
    paid boolean,
    "order" text,
    amount bigint,
    review text,
    source jsonb,
    status text,
    created integer,
    dispute text,
    invoice text,
    outcome jsonb,
    refunds jsonb,
    updated integer,
    captured boolean,
    currency text,
    customer text,
    livemode boolean,
    metadata jsonb,
    refunded boolean,
    shipping jsonb,
    application text,
    description text,
    destination text,
    failure_code text,
    on_behalf_of text,
    fraud_details jsonb,
    receipt_email text,
    payment_intent text,
    receipt_number text,
    transfer_group text,
    amount_refunded bigint,
    application_fee text,
    failure_message text,
    source_transfer text,
    balance_transaction text,
    statement_descriptor text,
    statement_description text,
    payment_method_details jsonb
);


--
-- Name: coupons; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.coupons (
    id text NOT NULL,
    object text,
    name text,
    valid boolean,
    created integer,
    updated integer,
    currency text,
    duration text,
    livemode boolean,
    metadata jsonb,
    redeem_by integer,
    amount_off bigint,
    percent_off double precision,
    times_redeemed bigint,
    max_redemptions bigint,
    duration_in_months bigint,
    percent_off_precise double precision
);


--
-- Name: customers; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.customers (
    id text NOT NULL,
    object text,
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
-- Name: disputes; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.disputes (
    id text NOT NULL,
    object text,
    amount bigint,
    charge text,
    reason text,
    status text,
    created integer,
    updated integer,
    currency text,
    evidence jsonb,
    livemode boolean,
    metadata jsonb,
    evidence_details jsonb,
    balance_transactions jsonb,
    is_charge_refundable boolean
);


--
-- Name: events; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.events (
    id text NOT NULL,
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


--
-- Name: invoices; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.invoices (
    id text NOT NULL,
    object text,
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
-- Name: payouts; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.payouts (
    id text NOT NULL,
    object text,
    date text,
    type text,
    amount bigint,
    method text,
    status text,
    created integer,
    updated integer,
    currency text,
    livemode boolean,
    metadata jsonb,
    automatic boolean,
    recipient text,
    description text,
    destination text,
    source_type text,
    arrival_date text,
    bank_account jsonb,
    failure_code text,
    transfer_group text,
    amount_reversed bigint,
    failure_message text,
    source_transaction text,
    balance_transaction text,
    statement_descriptor text,
    statement_description text,
    failure_balance_transaction text
);


--
-- Name: plans; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.plans (
    id text NOT NULL,
    object text,
    name text,
    tiers jsonb,
    active boolean,
    amount bigint,
    created integer,
    product text,
    updated integer,
    currency text,
    "interval" text,
    livemode boolean,
    metadata jsonb,
    nickname text,
    tiers_mode text,
    usage_type text,
    billing_scheme text,
    interval_count bigint,
    aggregate_usage text,
    transform_usage text,
    trial_period_days bigint,
    statement_descriptor text,
    statement_description text
);


--
-- Name: prices; Type: TABLE; Schema: stripe; Owner: -
--

CREATE TABLE stripe.prices (
    id text NOT NULL,
    object text,
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
    object text,
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
    object text,
    cancel_at_period_end boolean,
    current_period_end integer,
    current_period_start integer,
    default_payment_method text,
    items jsonb,
    metadata jsonb,
    pending_setup_intent text,
    pending_update jsonb,
    status stripe.subscription_status,
    application_fee_percent double precision,
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
    latest_invoice text,
    plan text
);


--
-- Name: charges charges_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.charges
    ADD CONSTRAINT charges_pkey PRIMARY KEY (id);


--
-- Name: coupons coupons_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.coupons
    ADD CONSTRAINT coupons_pkey PRIMARY KEY (id);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: disputes disputes_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.disputes
    ADD CONSTRAINT disputes_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: payouts payouts_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.payouts
    ADD CONSTRAINT payouts_pkey PRIMARY KEY (id);


--
-- Name: plans plans_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);


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
    ('20210501054140'),
    ('20210501054141'),
    ('20210501054142'),
    ('20210501054144'),
    ('20210501054145'),
    ('20210501054146');
