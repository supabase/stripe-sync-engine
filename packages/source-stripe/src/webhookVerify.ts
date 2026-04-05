import { createHmac, timingSafeEqual } from 'node:crypto'
import { stripeEventSchema, type StripeEvent } from './spec.js'

const DEFAULT_TOLERANCE_SECONDS = 300 // 5 minutes

/**
 * Verify a Stripe webhook signature and parse the event payload.
 * Replaces stripe.webhooks.constructEvent() from the SDK.
 *
 * @see https://docs.stripe.com/webhooks#verify-official-libraries
 */
export function verifyWebhookSignature(
  payload: string | Buffer,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS
): StripeEvent {
  const body = typeof payload === 'string' ? payload : payload.toString('utf8')
  const parts = parseSignatureHeader(signatureHeader)

  if (!parts.timestamp || parts.signatures.length === 0) {
    throw new WebhookSignatureError('No valid signature found in stripe-signature header')
  }

  const expectedSignature = computeSignature(parts.timestamp, body, secret)

  const isValid = parts.signatures.some((sig) => {
    const sigBuffer = Buffer.from(sig, 'hex')
    const expectedBuffer = Buffer.from(expectedSignature, 'hex')
    return sigBuffer.length === expectedBuffer.length && timingSafeEqual(sigBuffer, expectedBuffer)
  })

  if (!isValid) {
    throw new WebhookSignatureError(
      'Webhook signature verification failed. Ensure the webhook secret matches.'
    )
  }

  const timestampAge = Math.floor(Date.now() / 1000) - Number(parts.timestamp)
  if (toleranceSeconds > 0 && timestampAge > toleranceSeconds) {
    throw new WebhookSignatureError(
      `Webhook timestamp too old (${timestampAge}s > ${toleranceSeconds}s tolerance)`
    )
  }

  const event = JSON.parse(body) as unknown
  return stripeEventSchema.parse(event)
}

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebhookSignatureError'
  }
}

function parseSignatureHeader(header: string): {
  timestamp: string | null
  signatures: string[]
} {
  let timestamp: string | null = null
  const signatures: string[] = []

  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2)
    if (!key || !value) continue
    const trimmedKey = key.trim()
    if (trimmedKey === 't') {
      timestamp = value.trim()
    } else if (trimmedKey === 'v1') {
      signatures.push(value.trim())
    }
  }

  return { timestamp, signatures }
}

function computeSignature(timestamp: string, payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')
}
