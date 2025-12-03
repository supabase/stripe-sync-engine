import type Stripe from 'stripe'
import { StripeSync, runMigrations, hashApiKey } from 'stripe-experiment-sync'
import { vitest, beforeAll, describe, test, expect } from 'vitest'
import { getConfig } from '../utils/config'
import { mockStripe } from './helpers/mockStripe'
import { logger } from '../logger'

let stripeSync: StripeSync
const TEST_ACCOUNT_ID = 'acct_test_account'

beforeAll(async () => {
  process.env.AUTO_EXPAND_LISTS = 'true'
  process.env.BACKFILL_RELATED_ENTITIES = 'false'

  const config = getConfig()
  await runMigrations({
    databaseUrl: config.databaseUrl,
    logger,
  })

  stripeSync = new StripeSync({
    ...config,
    poolConfig: {
      connectionString: config.databaseUrl,
    },
  })
  const stripe = Object.assign(stripeSync.stripe, mockStripe)
  vitest.spyOn(stripeSync, 'stripe', 'get').mockReturnValue(stripe)

  // Mock getCurrentAccount to avoid API calls
  vitest.spyOn(stripeSync, 'getCurrentAccount').mockResolvedValue({
    id: TEST_ACCOUNT_ID,
    object: 'account',
  } as Stripe.Account)

  // Ensure test account exists in database with API key hash
  const apiKeyHash = hashApiKey(config.stripeSecretKey)
  await stripeSync.postgresClient.upsertAccount(
    {
      id: TEST_ACCOUNT_ID,
      raw_data: { id: TEST_ACCOUNT_ID, object: 'account' },
    },
    apiKeyHash
  )
})

describe('checkout sessions', () => {
  test('should upsert checkout sessions and fill line items', async () => {
    const checkoutSessions = [
      {
        id: 'cs_live_9RBjcHiy2i5p99Tf1MYM90c3SHK1grU0E6Ae6pKWR2KPA4ZiuKiB2X1Y3X',
        object: 'checkout.session',
        adaptive_pricing: {
          enabled: true,
        },
        after_expiration: null,
        allow_promotion_codes: true,
        amount_subtotal: 999,
        amount_total: 999,
        automatic_tax: {
          enabled: true,
          liability: {
            type: 'self',
          },
          provider: 'stripe',
          status: 'complete',
        },
        billing_address_collection: null,
        cancel_url: null,
        client_reference_id: null,
        client_secret: null,
        collected_information: {
          shipping_details: null,
        },
        consent: {
          promotions: null,
          terms_of_service: 'accepted',
        },
        consent_collection: {
          payment_method_reuse_agreement: null,
          promotions: 'none',
          terms_of_service: 'required',
        },
        created: 1756310605,
        currency: 'eur',
        currency_conversion: null,
        custom_fields: [],
        custom_text: {
          after_submit: null,
          shipping_address: null,
          submit: null,
          terms_of_service_acceptance: null,
        },
        customer: 'cus_IhGfebO16cMIGN',
        customer_creation: 'if_required',
        customer_details: {
          address: {
            city: '',
            country: '',
            line1: '',
            line2: '',
            postal_code: '',
            state: '',
          },
          email: 'billz@supabase.io',
          name: 'Copple',
          phone: null,
          tax_exempt: 'none',
          tax_ids: [],
        },
        customer_email: null,
        discounts: [],
        expires_at: 1756397005,
        invoice: 'in_1KJqKBJDPojXS6LNJbvLUgEy',
        invoice_creation: {
          enabled: true,
          invoice_data: {
            account_tax_ids: null,
            custom_fields: null,
            description: null,
            footer: null,
            issuer: {
              type: 'self',
            },
            metadata: {},
            rendering_options: null,
          },
        },
        livemode: true,
        locale: null,
        metadata: {},
        mode: 'payment',
        origin_context: null,
        payment_intent: 'pi_1IqxJOJDPojXS6LN9uOebAea',
        payment_link: null,
        payment_method_collection: 'if_required',
        payment_method_configuration_details: {
          id: 'pmc_1OCIhWF1oYtPP4ikyGr0tx7q',
          parent: null,
        },
        payment_method_options: {},
        payment_method_types: ['card', 'klarna', 'link', 'paypal'],
        payment_status: 'paid',
        permissions: null,
        phone_number_collection: {
          enabled: false,
        },
        recovered_from: null,
        saved_payment_method_options: {
          allow_redisplay_filters: ['always'],
          payment_method_remove: 'disabled',
          payment_method_save: null,
        },
        setup_intent: null,
        shipping_address_collection: null,
        shipping_cost: null,
        shipping_details: null,
        shipping_options: [],
        status: 'complete',
        submit_type: null,
        subscription: null,
        success_url: 'https:/supabase.github.io/stripe-sync-engine',
        total_details: {
          amount_discount: 0,
          amount_shipping: 0,
          amount_tax: 65,
        },
        ui_mode: 'hosted',
        url: null,
        wallet_options: null,
      } as Stripe.Checkout.Session,
    ]

    await stripeSync.upsertCheckoutSessions(checkoutSessions, TEST_ACCOUNT_ID, false)

    const lineItems = await stripeSync.postgresClient.query(
      `select id, object, amount_discount, amount_subtotal, amount_tax, amount_total, currency, description, price, quantity from stripe.checkout_session_line_items where checkout_session = 'cs_live_9RBjcHiy2i5p99Tf1MYM90c3SHK1grU0E6Ae6pKWR2KPA4ZiuKiB2X1Y3X'`
    )

    expect(lineItems.rows).toContainEqual({
      id: 'li_123',
      object: 'item',
      amount_discount: 0,
      amount_subtotal: 2198,
      amount_tax: 0,
      amount_total: 2198,
      currency: 'usd',
      description: 'T-shirt',
      price: 'price_1IDQm5JDPojXS6LNM31hxKzp',
      quantity: 1,
    })

    expect(lineItems.rows).toContainEqual({
      id: 'li_456',
      object: 'item',
      amount_discount: 0,
      amount_subtotal: 2198,
      amount_tax: 0,
      amount_total: 2198,
      currency: 'usd',
      description: 'Hoodie',
      price: 'price_1IDQm5JDPojXS6LNM31hxKzp',
      quantity: 2,
    })
  })
})
