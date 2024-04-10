import Stripe from 'stripe'
import { ConfigType } from '../types/types'

export function getStripe(config: ConfigType): Stripe {
  return new Stripe(config.STRIPE_SECRET_KEY, {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    apiVersion: config.STRIPE_API_VERSION,
    appInfo: {
      name: 'Stripe Postgres Sync',
    },
  })
}
