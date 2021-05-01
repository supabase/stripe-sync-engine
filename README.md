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
- [ ] `charge.captured`
- [ ] `charge.dispute.created`
- [ ] `charge.failed`
- [ ] `charge.refunded`
- [ ] `charge.succeeded`
- [ ] `checkout.session.async_payment_failed`
- [ ] `checkout.session.async_payment_succeeded`
- [ ] `checkout.session.completed`
- [x] `customer.created` 🟢
- [ ] `customer.deleted`
- [ ] `customer.source.created`
- [ ] `customer.source.updated`
- [x] `customer.subscription.created` 🟢
- [ ] `customer.subscription.deleted`
- [x] `customer.subscription.updated` 🟢
- [x] `customer.updated` 🟢
- [ ] `invoice.created`
- [ ] `invoice.finalized`
- [ ] `invoice.payment_failed`
- [ ] `invoice.payment_succeeded`
- [ ] `invoice.updated`
- [ ] `issuing_authorization.request`
- [ ] `issuing_card.created`
- [ ] `issuing_cardholder.created`
- [ ] `payment_intent.amount_capturable_updated`
- [ ] `payment_intent.canceled`
- [ ] `payment_intent.created`
- [ ] `payment_intent.payment_failed`
- [ ] `payment_intent.succeeded`
- [ ] `payment_method.attached`
- [ ] `plan.created`
- [ ] `plan.deleted`
- [ ] `plan.updated`
- [x] `price.created` 🟢
- [ ] `price.deleted`
- [x] `price.updated` 🟢
- [x] `product.created` 🟢
- [ ] `product.deleted`
- [x] `product.updated` 🟢
- [ ] `setup_intent.canceled`
- [ ] `setup_intent.created`
- [ ] `setup_intent.setup_failed`
- [ ] `setup_intent.succeeded`
- [ ] `subscription_schedule.canceled`
- [ ] `subscription_schedule.created`
- [ ] `subscription_schedule.released`
- [ ] `subscription_schedule.updated`


## Usage

- Update your Stripe account with all valid webhooks and get the webhook secret
- `mv .env.sample .env` and then rename all the variables
- Make sure the database URL has search_path `stripe`. eg: `DATABASE_URL=postgres://postgres:postgres@hostname:5432/postgres?sslmode=disable&search_path=stripe`
- Run `dbmate up`
- Deploy the [docker image](https://hub.docker.com/r/supabase/stripe-sync-engine) to your favourite hosting service and expose port `8080`
- Point your Stripe webooks to your deployed app.
## Future ideas

- Expose a "sync" endpoint for each table which will manually fetch and sync from Stripe.
- Expose an "initialize" endpoint that will fetch data from Stripe and do an initial load (or perhaps `POST` a CSV to an endpoint).

## Development

**Set up**
- Create a Postgres database on [supabase.com](https://supabase.com) (or another Postgres provider)
- Update Stripe with all valid webhooks and get the webhook secret
- `mv .env.sample .env` and then rename all the variables

**Develop**

- `npm run dev` to start the local server
- `npm run test` to run tests

**Building Docker**

```
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
