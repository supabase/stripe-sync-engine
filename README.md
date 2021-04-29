## Postgres Stripe Sync

Continuously synchronizes a Stripe account to a Postgres database.

## Motivation

Sometimes you just want to analyze your billing data using SQL. Most importantly, you want to join your billing data to your product/business data.

This server will synchronize your Stripe account to a Postgres database. It can be a new database, or an existing Postgres database.
## How it works

- Creates a new schema `stripe` in a Postgres database, with tables & columns matching Stripe.
- Exposes a `/webhooks` endpoint that listens to any Stripe webhooks.
- Inserts/updates the tables whenever there is a change to Stripe.

## Progress

- [ ] `balance.available`
- [ ] `charge.captured`
- [ ] `charge.dispute.created`
- [ ] `charge.failed`
- [ ] `charge.refunded`
- [ ] `charge.succeeded`
- [ ] `checkout.session.async_payment_failed`
- [ ] `checkout.session.async_payment_succeeded`
- [ ] `checkout.session.completed`
- [x] `customer.created`
- [ ] `customer.deleted`
- [ ] `customer.source.created`
- [ ] `customer.source.updated`
- [x] `customer.subscription.created`
- [ ] `customer.subscription.deleted`
- [x] `customer.subscription.updated`
- [x] `customer.updated`
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
- [x] `price.created`
- [ ] `price.deleted`
- [x] `price.updated`
- [x] `product.created`
- [ ] `product.deleted`
- [x] `product.updated`
- [ ] `setup_intent.canceled`
- [ ] `setup_intent.created`
- [ ] `setup_intent.setup_failed`
- [ ] `setup_intent.succeeded`
- [ ] `subscription_schedule.canceled`
- [ ] `subscription_schedule.created`
- [ ] `subscription_schedule.released`
- [ ] `subscription_schedule.updated`


## Usage

- Update the `.env` file
  - Make sure the database URL has search_path `stripe`. eg: `DATABASE_URL=postgres://postgres:postgres@hostname:5432/postgres?sslmode=disable&search_path=stripe`
- Run `dbmate up`
## Future ideas

- Expose a "sync" endpoint for each table which will manually fetch and sync from Stripe.
- Expose endpoints for fetching (read-only) rather than reading from Stripe (could be useful for bulk operations?).

## Built With

- Fastify
- Strict Typescript support
- Testing via [Jest](https://jestjs.io/)
- Reading API in a directory via [fastify-autoload](https://github.com/fastify/fastify-autoload)
- Documentation generated via [fastify-swagger](https://github.com/fastify/fastify-swagger)
- Auto generated types from JSON schema with [json-schema-to-ts](https://www.npmjs.com/package/json-schema-to-ts)
- Linting via [eslint](https://eslint.org/)
- Watch files and restart server via [ts-node-dev](https://www.npmjs.com/package/ts-node-dev)
- Code formatting via [Prettier](https://prettier.io/)
- Pretty logs during development via [pino-pretty](https://github.com/pinojs/pino-pretty)

## Development

Building Docker

```
docker build -t postgres-stripe-sync .
docker run -p 8080:8080 postgres-stripe-sync
```

### Todo

- fix `USER root` in Dockerfile
- split dockerfile into builder and runner
- check that pooling is working (one connection per database)