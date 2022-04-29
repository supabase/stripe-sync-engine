-- drop columns that are duplicated / not available anymore
-- card info already available on payment_method_details object
-- statement_description is not available on webhook api_version "2020-03-02"
alter table "stripe"."charges"
    drop column if exists "card",
    drop column if exists "statement_description";