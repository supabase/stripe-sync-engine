# Stripe Sync Engine Monorepo

![GitHub License](https://img.shields.io/github/license/supabase/stripe-sync-engine)
![NPM Version](https://img.shields.io/npm/v/%40supabase%2Fstripe-sync-engine)
![Docker Image Version](https://img.shields.io/docker/v/supabase/stripe-sync-engine?label=Docker)

This monorepo contains two packages for synchronizing your Stripe account with a Postgres database:

- [`@supabase/stripe-sync-engine`](./packages/sync-engine/README.md): A TypeScript library for syncing Stripe data to Postgres, designed for integration into your own Node.js backend or serverless environment.
- [`stripe-sync-fastify`](./packages/fastify-app/README.md): A Fastify-based server and Docker image that exposes a `/webhooks` endpoint for Stripe, providing a ready-to-run service for real-time Stripe-to-Postgres sync.

![Sync Stripe with Postgres](./docs/stripe-sync-engine.jpg)

---

## Motivation

Sometimes you want to analyze your billing data using SQL. Even more importantly, you want to join your billing data to your product/business data.

This project synchronizes your Stripe account to a Postgres database. It can be a new database, or an existing Postgres database.

---

## How it works

![How it works](./docs/sync-engine-how.png)

- Creates a new schema `stripe` in a Postgres database, with tables & columns matching Stripe.
- Exposes a `/webhooks` endpoint that listens to any Stripe webhooks (via the Fastify app).
- Inserts/updates/deletes changes into the tables whenever there is a change to Stripe.

---

## Packages

- [Library: @supabase/stripe-sync-engine](./packages/sync-engine/README.md)
- [Docker/Server: supabase/stripe-sync-engine](./packages/fastify-app/README.md)

Each package has its own README with installation, configuration, and usage instructions.

---

## Supabase Edge Function

To deploy the sync-engine to a Supabase edge function, follow this [guide](./edge-function.md).

## Webhook Support

- [ ] `balance.available`
- [x] `charge.captured` 🟢
- [x] `charge.expired` 🟢
- [x] `charge.failed` 🟢
- [x] `charge.pending` 🟢
- [x] `charge.refunded` 🟢
- [x] `charge.refund.updated` 🟡 - For updates on all refunds, listen to `refund.updated` instead
- [x] `charge.succeeded` 🟢
- [x] `charge.updated` 🟢
- [x] `charge.dispute.closed` 🟢
- [x] `charge.dispute.created` 🟢
- [x] `charge.dispute.funds_reinstated` 🟢
- [x] `charge.dispute.funds_withdrawn` 🟢
- [x] `charge.dispute.updated` 🟢
- [x] `checkout.session.async_payment_failed` 🟢
- [x] `checkout.session.async_payment_succeeded` 🟢
- [x] `checkout.session.completed` 🟢
- [x] `credit_note.created` 🟢
- [x] `credit_note.updated` 🟢
- [x] `credit_note.voided` 🟢
- [x] `customer.created` 🟢
- [x] `customer.deleted` 🟢
- [ ] `customer.source.created`
- [ ] `customer.source.updated`
- [x] `customer.subscription.created` 🟢
- [x] `customer.subscription.deleted` 🟢
- [x] `customer.subscription.paused` 🟢
- [x] `customer.subscription.pending_update_applied` 🟢
- [x] `customer.subscription.pending_update_expired` 🟢
- [x] `customer.subscription.resumed` 🟢
- [x] `customer.subscription.trial_will_end` 🟢
- [x] `customer.subscription.updated` 🟢
- [x] `customer.tax_id.created` 🟢
- [x] `customer.tax_id.deleted` 🟢
- [x] `customer.tax_id.updated` 🟢
- [x] `customer.updated` 🟢
- [x] `invoice.created` 🟢
- [x] `invoice.deleted` 🟢
- [x] `invoice.finalized` 🟢
- [x] `invoice.finalization_failed` 🟢
- [x] `invoice.marked_uncollectible` 🟢
- [x] `invoice.paid` 🟢
- [x] `invoice.payment_action_required` 🟢
- [x] `invoice.payment_failed` 🟢
- [x] `invoice.payment_succeeded` 🟢
- [x] `invoice.sent` 🟢
- [ ] `invoice.upcoming` 🔴 - Event has no id and cannot be processed
- [x] `invoice.updated` 🟢
- [x] `invoice.overdue` 🟢
- [x] `invoice.overpaid` 🟢
- [x] `invoice.will_be_due` 🟢
- [x] `invoice.voided` 🟢
- [ ] `issuing_authorization.request`
- [ ] `issuing_card.created`
- [ ] `issuing_cardholder.created`
- [x] `payment_intent.amount_capturable_updated` 🟢
- [x] `payment_intent.canceled` 🟢
- [x] `payment_intent.created` 🟢
- [x] `payment_intent.partially_refunded` 🟢
- [x] `payment_intent.payment_failed` 🟢
- [x] `payment_intent.processing` 🟢
- [x] `payment_intent.requires_action` 🟢
- [x] `payment_intent.succeeded` 🟢
- [x] `payment_method.attached` 🟢
- [x] `payment_method.automatically_updated` 🟢
- [x] `payment_method.detached` 🟢
- [x] `payment_method.updated` 🟢
- [x] `plan.created` 🟢
- [x] `plan.deleted` 🟢
- [x] `plan.updated` 🟢
- [x] `price.created` 🟢
- [x] `price.deleted` 🟢
- [x] `price.updated` 🟢
- [x] `product.created` 🟢
- [x] `product.deleted` 🟢
- [x] `product.updated` 🟢
- [x] `radar.early_fraud_warning.created` 🟢
- [x] `radar.early_fraud_warning.updated` 🟢
- [x] `refund.created` 🟢
- [x] `refund.failed` 🟢
- [x] `refund.updated` 🟢
- [x] `review.opened` 🟢
- [x] `review.closed` 🟢
- [x] `setup_intent.canceled` 🟢
- [x] `setup_intent.created` 🟢
- [x] `setup_intent.requires_action` 🟢
- [x] `setup_intent.setup_failed` 🟢
- [x] `setup_intent.succeeded` 🟢
- [x] `subscription_schedule.aborted` 🟢
- [x] `subscription_schedule.canceled` 🟢
- [x] `subscription_schedule.completed` 🟢
- [x] `subscription_schedule.created` 🟢
- [x] `subscription_schedule.expiring` 🟢
- [x] `subscription_schedule.released` 🟢
- [x] `subscription_schedule.updated` 🟢
- [x] `entitlements.active_entitlement_summary.updated` 🟢
