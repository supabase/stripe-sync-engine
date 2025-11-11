## Next Week

- Allow table name to be customizable.
- Incremental CDC-style backfill to avoid re-pulling full historical datasets.
- Use JSONB for storing all of the data and allow user to create generated columns as necessary for future proofing. This ensures that read-only columns stay read-only because they are generated and also allow user to drop them without breaking the sync.
- Automatically creating and dropping webhooks
- Integration with ngrok as needed.

## Next Month

- Support additional data destinations such as MySQL, Firestore, and others.
- Dedicated documentation website to really demonstrate how this works, including support for PG Lite to allow it to work in the browser.

## Future ideas

- UI dashboard for monitoring sync health, failed webhooks, and retry status.
- Proxied Stripe API client that can read from the local cache first and fall back to Stripe when data is stale or missing.
- Pluggable transform layer so teams can normalize or mask Stripe data before persistence.
