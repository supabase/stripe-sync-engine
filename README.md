# Stripe Sync Engine

Continuously synchronizes a Stripe account to a Postgres database.

![Sync Stripe with Postgres](./docs/stripe-sync-engine.jpg)

## Motivation

Sometimes you want to analyze your billing data using SQL. Even more importantly, you want to join your billing data to your product/business data.

This server synchronizes your Stripe account to a Postgres database. It can be a new database, or an existing Postgres database.

## How it works

![How it works](./docs/sync-engine-how.png)

- Creates a new schema `stripe` in a Postgres database, with tables & columns matching Stripe.
- Exposes a `/webhooks` endpoint that listens to any Stripe webhooks.
- Inserts/updates/deletes changes into the tables whenever there is a change to Stripe.

**Not implemented**

- This will not do an initial load of existing Stripe data. You should use CSV loads for this. We might implement this in the future.
- We are progressively working through webhooks.

## Webhook Progress

- [ ] `balance.available`
- [x] `charge.captured` 🟢
- [x] `charge.expired` 🟢
- [x] `charge.failed` 🟢
- [x] `charge.pending` 🟢
- [x] `charge.refunded` 🟢
- [x] `charge.succeeded` 🟢
- [x] `charge.updated` 🟢
- [x] `charge.dispute.closed` 🟢
- [x] `charge.dispute.created` 🟢
- [x] `charge.dispute.funds_reinstated` 🟢
- [x] `charge.dispute.funds_withdrawn` 🟢
- [x] `charge.dispute.updated` 🟢
- [ ] `checkout.session.async_payment_failed`
- [ ] `checkout.session.async_payment_succeeded`
- [ ] `checkout.session.completed`
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
- [x] `invoice.upcoming` 🔴 - Event has no id and cannot be processed
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

## Usage

- Update your Stripe account with all valid webhooks and get the webhook secret
- `mv .env.sample .env` and then rename all the variables
- Make sure the database URL has search_path `stripe`. eg: `DATABASE_URL=postgres://postgres:postgres@hostname:5432/postgres?sslmode=disable&search_path=stripe`
- Deploy the [docker image](https://hub.docker.com/r/supabase/stripe-sync-engine) to your favourite hosting service and expose port `8080`
  - eg: `docker run -e PORT=8080 --env-file .env supabase/stripe-sync-engine`
  - This will automatically run any migrations on your database
- Point your Stripe webooks to your deployed app.

## Backfill from Stripe

```
POST /sync
body: {
  "object": "product",
  "created": {
    "gte": 1643872333
  }
}
```

- `object` **all** | **charge** | **customer** | **dispute** | **invoice** | **payment_method** | **payment_intent** | **plan** | **price** | **product** | **setup_intent** | **subscription**
- `created` is Stripe.RangeQueryParam. It supports **gt**, **gte**, **lt**, **lte**

#### Alternative routes to sync `daily/weekly/monthly` data

```
POST /sync/daily

---

POST /sync/daily
body: {
  "object": "product"
}
```

### Syncing single entity

To backfill/update a single entity, you can use

```
POST /sync/single/cus_12345
```

The entity type is recognized automatically, based on the prefix.

## Future ideas

- Expose an "initialize" endpoint that will fetch data from Stripe and do an initial load (or perhaps `POST` a CSV to an endpoint).

## Development

**Set up**

- Create a Postgres database on [supabase.com](https://supabase.com) (or another Postgres provider)
- Update Stripe with all valid webhooks and get the webhook secret
- `mv .env.sample .env` and then rename all the variables

**Develop**

- `pnpm dev` to start the local server
- `pnpm t` to run tests

**Building Docker**

```bash
docker build -t stripe-sync-engine .
docker run -p 8080:8080 stripe-sync-engine
```

**Release**

Handled by GitHub actions whenever their is a commit to the `main` branch with `fix` or `feat` in the description.

## License

Apache 2.0

## Sponsors

Supabase is building the features of Firebase using enterprise-grade, open source products. We support existing communities wherever possible, and if the products don’t exist we build them and open source them ourselves.

[![New Sponsor](https://user-images.githubusercontent.com/10214025/90518111-e74bbb00-e198-11ea-8f88-c9e3c1aa4b5b.png)](https://github.com/sponsors/supabase)
