import Stripe from 'stripe'
import { getConfig } from './config'

const config = getConfig();

export const stripe = new Stripe(config.STRIPE_SECRET_KEY, {
  // https://github.com/stripe/stripe-node#configuration
  apiVersion: '2020-08-27',
  appInfo: {
    name: 'Stripe Postgres Sync',
  },
})
