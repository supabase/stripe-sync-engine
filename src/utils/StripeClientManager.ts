import Stripe from 'stripe'
import { getConfig } from './config'

export const stripe = new Stripe(getConfig().STRIPE_SECRET_KEY, {
  // https://github.com/stripe/stripe-node#configuration
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  apiVersion: getConfig().STRIPE_API_VERSION,
  appInfo: {
    name: 'Stripe Postgres Sync',
  },
})
