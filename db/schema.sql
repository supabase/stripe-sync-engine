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
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


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
-- Name: prices prices_product_fkey; Type: FK CONSTRAINT; Schema: stripe; Owner: -
--

ALTER TABLE ONLY stripe.prices
    ADD CONSTRAINT prices_product_fkey FOREIGN KEY (product) REFERENCES stripe.products(id);


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
    ('20210429132018');
