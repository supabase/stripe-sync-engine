## Intended Usage

This engine is designed for working with Stripe data **after** events occur.
It focuses on data ingestion, synchronization, and analytics.

### This engine IS intended for:
- Syncing Stripe data to databases or warehouses
- Processing Stripe webhooks
- Running analytics and reporting
- Building dashboards on Stripe data

### This engine is NOT intended for:
- Handling Stripe Checkout
- Processing live payments
- Creating or managing sales flows
- Replacing Stripe’s official SDKs


## Should I use this engine?

| Use case | Should I use this? |
|--------|------------------|
| Accept payments | ❌ No |
| Stripe Checkout | ❌ No |
| Subscription creation | ❌ No |
| Sync Stripe data | ✅ Yes |
| Analytics & reporting | ✅ Yes |
| Webhook processing | ✅ Yes |


## Docker vs Edge Usage

### Docker
Use Docker when you need:
- Long-running sync jobs
- Batch processing
- High data volumes
- Stable server environments

### Edge
Use Edge when you need:
- Low-latency webhook handling
- Lightweight event processing
- Serverless deployments

⚠️ Edge is not recommended for heavy analytics or long-running jobs.


## Example Usage

If you are starting a new project and want to accept Stripe payments:
- Use Stripe Checkout or Stripe SDKs
- Use this engine only to sync data and run analytics

If you already accept payments and want reporting or dashboards:
- This engine is an appropriate tool
