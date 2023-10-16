import Stripe from 'stripe'

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  // https://github.com/stripe/stripe-node#configuration
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  apiVersion: process.env.STRIPE_API_VERSION || '2020-08-27',
  appInfo: {
    name: 'Stripe Postgres Sync',
  },
})
