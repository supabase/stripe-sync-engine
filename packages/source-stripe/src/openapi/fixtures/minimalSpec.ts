import type { OpenApiSpec } from '../../types'

export const minimalStripeOpenApiSpec: OpenApiSpec = {
  openapi: '3.0.0',
  info: {
    version: '2020-08-27',
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
    },
  },
}
