const STREAM_NAME = ""; // e.g. products
const OBJECT_NAME = ""; // e.g. product
const OBJECT_ID = ""; // e.g. prod_1234

const res = await fetch("http://localhost:4010/pipeline_sync", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    pipeline: {
      source: {
        type: "stripe",
        stripe: {
          api_key: process.env.STRIPE_API_KEY,
          account_id: process.env.STRIPE_ACCOUNT_ID,
          api_version: process.env.STRIPE_API_VERSION,
          base_url: process.env.STRIPE_API_BASE_URL,
          webhook_url: process.env.STRIPE_WEBHOOK_URL,
        },
      },
      destination: {
        type: "google_sheets",
        google_sheets: {
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          access_token: "",
          refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
          spreadsheet_id: process.env.GOOGLE_SHEET_ID,
          spreadsheet_title: STREAM_NAME,
        },
      },
      streams: [{ name: STREAM_NAME }],
    },
    stdin: [
      {
        type: "source_input",
        source_input: {
          id: "evt_1TRJWRBoxBhC7kEnoXEMDaQR", // Random
          object: "event",
          api_version: process.env.STRIPE_API_VERSION,
          created: 1777413026,
          data: {
            object: {
              id: OBJECT_ID,
              object: OBJECT_NAME,
              active: true,
              attributes: [],
              created: 1777413026,
              default_price: "price_1234",
              description: null,
              features: [],
              images: [],
              livemode: true,
              marketing_features: [],
              metadata: {},
              name: "test",
              package_dimensions: null,
              shippable: null,
              statement_descriptor: null,
              tax_code: "txcd_1234",
              tax_details: { performance_location: null, tax_code: "txcd_1234" },
              type: "service",
              unit_label: null,
              updated: 1777415340,
              url: null,
            },
            previous_attributes: { default_price: null },
          },
          livemode: true,
          pending_webhooks: 3,
          request: {
            id: "req_1234",
            idempotency_key: "1234",
          },
          type: `${OBJECT_NAME}.deleted`,
        },
      },
    ],
    time_limit: 1790.0,
  }),
});

console.log(res.status, res.statusText);
console.log(await res.text());
