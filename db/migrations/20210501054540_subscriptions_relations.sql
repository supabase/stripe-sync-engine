-- migrate:up

delete from "stripe"."subscriptions";

alter table "stripe"."subscriptions" 
    add constraint fk_latest_invoice 
    foreign key (latest_invoice) 
    references "stripe"."invoices" (id);

-- migrate:down

alter table "stripe"."subscriptions"
drop constraint fk_latest_invoice;