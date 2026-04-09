import type { OpenApiSpec, OpenApiPathItem } from '../../types'
import { cleanOpenApiSpec } from '../../specCleaning'

function listPath(
  schemaRef: string,
  opts: {
    supportsCreatedFilter?: boolean
    supportsLimit?: boolean
    deprecated?: boolean
    description?: string
  } = {}
): OpenApiPathItem {
  const parameters: { name: string; in: string }[] = []
  if (opts.supportsCreatedFilter) {
    parameters.push({ name: 'created', in: 'query' })
  }
  if (opts.supportsLimit !== false) {
    parameters.push({ name: 'limit', in: 'query' })
    parameters.push({ name: 'starting_after', in: 'query' })
    parameters.push({ name: 'ending_before', in: 'query' })
  }
  return {
    get: {
      ...(opts.deprecated ? { deprecated: true } : {}),
      ...(opts.description ? { description: opts.description } : {}),
      parameters,
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  object: { type: 'string', enum: ['list'] },
                  data: { type: 'array', items: { $ref: `#/components/schemas/${schemaRef}` } },
                  has_more: { type: 'boolean' },
                  url: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }
}

function v2ListPath(schemaRef: string): OpenApiPathItem {
  return {
    get: {
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: { type: 'array', items: { $ref: `#/components/schemas/${schemaRef}` } },
                  next_page_url: { type: 'string', nullable: true },
                  previous_page_url: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
      },
    },
  }
}

const rawSpec: OpenApiSpec = {
  openapi: '3.0.0',
  info: {
    version: '2020-08-27',
  },
  paths: {
    '/v1/customers': listPath('customer', { supportsCreatedFilter: true }),
    '/v1/plans': listPath('plan', { supportsCreatedFilter: true }),
    '/v1/prices': listPath('price', { supportsCreatedFilter: true }),
    '/v1/products': listPath('product', { supportsCreatedFilter: true }),
    '/v1/subscription_items': listPath('subscription_item'),
    '/v1/checkout/sessions': listPath('checkout_session', { supportsCreatedFilter: true }),
    '/v1/radar/early_fraud_warnings': listPath('early_fraud_warning', {
      supportsCreatedFilter: true,
    }),
    '/v1/entitlements/active_entitlements': listPath('active_entitlement'),
    '/v1/entitlements/features': listPath('entitlements_feature'),
    '/v2/core/accounts': v2ListPath('v2_core_account'),
    '/v2/core/event_destinations': v2ListPath('v2_core_event_destination'),
    '/v1/recipients': listPath('recipient'),
    '/v1/exchange_rates': listPath('exchange_rate', {
      description:
        '<p>[Deprecated] The <code>ExchangeRate</code> APIs are deprecated. Please use the FX Quotes API instead.</p>',
    }),
    '/v1/deprecated_widgets': listPath('deprecated_widget', { deprecated: true }),
  },
  components: {
    schemas: {
      customer: {
        'x-resourceId': 'customer',
        oneOf: [
          {
            type: 'object',
            properties: {
              id: { type: 'string' },
              object: { type: 'string' },
              created: { type: 'integer' },
            },
          },
          {
            type: 'object',
            properties: {
              id: { type: 'string' },
              deleted: { type: 'boolean' },
            },
          },
        ],
      },
      plan: {
        'x-resourceId': 'plan',
        type: 'object',
        properties: {
          id: { type: 'string' },
          active: { type: 'boolean' },
          amount: { type: 'integer' },
        },
      },
      price: {
        'x-resourceId': 'price',
        type: 'object',
        properties: {
          id: { type: 'string' },
          product: { type: 'string' },
          unit_amount: { type: 'integer' },
          metadata: { type: 'object', additionalProperties: true },
        },
      },
      product: {
        'x-resourceId': 'product',
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
        },
      },
      subscription_item: {
        'x-resourceId': 'subscription_item',
        type: 'object',
        properties: {
          id: { type: 'string' },
          deleted: { type: 'boolean' },
          subscription: { type: 'string' },
          quantity: { type: 'integer' },
        },
      },
      checkout_session: {
        'x-resourceId': 'checkout.session',
        type: 'object',
        properties: {
          id: { type: 'string' },
          amount_total: { type: 'integer' },
          customer: { type: 'string', nullable: true },
        },
      },
      early_fraud_warning: {
        'x-resourceId': 'radar.early_fraud_warning',
        type: 'object',
        properties: {
          id: { type: 'string' },
          charge: { type: 'string' },
        },
      },
      active_entitlement: {
        'x-resourceId': 'entitlements.active_entitlement',
        type: 'object',
        properties: {
          id: { type: 'string' },
          customer: { type: 'string' },
          feature: { type: 'string' },
        },
      },
      entitlements_feature: {
        'x-resourceId': 'entitlements.feature',
        type: 'object',
        properties: {
          id: { type: 'string' },
          lookup_key: { type: 'string' },
        },
      },
      v2_core_account: {
        'x-resourceId': 'v2.core.account',
        type: 'object',
        properties: {
          id: { type: 'string' },
          display_name: { type: 'string' },
          contact_email: { type: 'string', nullable: true },
          created: { type: 'string', format: 'date-time' },
        },
      },
      v2_core_event_destination: {
        'x-resourceId': 'v2.core.event_destination',
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          enabled_events: { type: 'array', items: { type: 'string' } },
          livemode: { type: 'boolean' },
        },
      },
      recipient: {
        'x-resourceId': 'recipient',
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
        },
      },
      exchange_rate: {
        'x-resourceId': 'exchange_rate',
        type: 'object',
        properties: {
          id: { type: 'string' },
          rates: { type: 'object', additionalProperties: true },
        },
      },
      deprecated_widget: {
        'x-resourceId': 'deprecated_widget',
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
        },
      },
    },
  },
}

export const rawMinimalStripeOpenApiSpec: OpenApiSpec = rawSpec
export const minimalStripeOpenApiSpec: OpenApiSpec = cleanOpenApiSpec(rawSpec)
