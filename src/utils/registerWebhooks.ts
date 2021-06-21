import { getConfig } from "./config";
import { stripe } from "./StripeClientManager";
import { Stripe } from "stripe";

const enabledEvents: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
    "customer.created",
    "customer.updated",
    "customer.subscription.created",
    "customer.subscription.deleted",
    "customer.subscription.updated",
    "invoice.created",
    "invoice.finalized",
    "invoice.paid",
    "invoice.payment_failed",
    "invoice.payment_succeeded",
    "invoice.updated",
    "product.created",
    "product.updated",
    "product.deleted",
    "price.created",
    "price.updated",
    "price.deleted",
];

const config = getConfig();

let secret: string | undefined = undefined;

export async function registerWebhooks() {
    if (config.STRIPE_WEBHOOK_URL) {

        let webhook: Stripe.WebhookEndpoint | undefined = undefined;

        let hooks = await stripe.webhookEndpoints.list();

        do {
            for (const endpoint of hooks.data) {
                if (
                    !endpoint.metadata || 
                    !endpoint.metadata.createdByStripePostgresSync || 
                    endpoint.url != config.STRIPE_WEBHOOK_URL
                ) {
                    continue;
                }

                if (endpoint.enabled_events.join() != enabledEvents.join()) {
                    console.debug(`Found a webhook that has different enabled events or url`);
                    console.debug(`Updating the webhook ${endpoint.url}`);  
                    stripe.webhookEndpoints.update(endpoint.id, {
                        enabled_events: enabledEvents
                    })
                }

                webhook = endpoint;
            }

            if (hooks.has_more) {
                hooks = await stripe.webhookEndpoints.list({
                    starting_after: hooks.data[hooks.data.length - 1].id
                });
            }
        } while (hooks.has_more);

        if (webhook == undefined) {
            console.log("There was no webhook matching the url and enabled events.");
            console.log(`Creating a new webhook with url ${config.STRIPE_WEBHOOK_URL}`);
            webhook = await stripe.webhookEndpoints.create({
                url: config.STRIPE_WEBHOOK_URL,
                enabled_events: enabledEvents,
                description: "Created by Stripe Postgres Sync",
                metadata: {
                    createdByStripePostgresSync: "true"
                },
            });
        }

        process.env.STRIPE_WEBHOOK_SECRET = webhook.secret;
    }
}

export function getSecret(): string | undefined {
    return secret;
}