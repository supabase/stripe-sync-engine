CREATE INDEX stripe_invoices_customer_idx ON "{{schema}}"."invoices" USING btree (customer);
CREATE INDEX stripe_invoices_subscription_idx ON "{{schema}}"."invoices" USING btree (subscription);