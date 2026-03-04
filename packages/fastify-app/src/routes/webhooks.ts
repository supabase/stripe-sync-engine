import { FastifyInstance, FastifyRequest } from 'fastify'
import { logger } from '../logger'
import { normalizeHost } from '../utils/config'

function extractHost(request: FastifyRequest): string {
  const hostHeader = request.headers.host
  if (Array.isArray(hostHeader)) {
    return normalizeHost(hostHeader[0] ?? '')
  }
  return normalizeHost(hostHeader ?? '')
}

export default async function routes(fastify: FastifyInstance) {
  fastify.post('/webhooks', {
    handler: async (request, reply) => {
      const requestHost = extractHost(request)
      const merchantRuntime = fastify.resolveMerchantByHost(requestHost)
      if (!merchantRuntime) {
        logger.warn({ requestHost }, 'Unknown merchant host for webhook request')
        return reply.code(404).send('Merchant not found')
      }
      const stripeSync = await fastify.createStripeSyncForHost(merchantRuntime.host)
      if (!stripeSync) {
        logger.warn({ requestHost }, 'Merchant config missing for webhook request host')
        return reply.code(404).send('Merchant not found')
      }

      const body: { raw: Buffer } = request.body as { raw: Buffer }
      const signatureHeader = request.headers['stripe-signature']
      const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader

      if (typeof signature !== 'string' || signature.length === 0) {
        return reply.code(400).send('Webhook Error: Missing stripe-signature header')
      }

      try {
        await stripeSync.webhook.processWebhook(body.raw, signature)
      } catch (error) {
        logger.error({ err: error, requestHost: merchantRuntime.host }, 'Webhook processing error')
        return reply
          .code(400)
          .send(`Webhook Error: ${error instanceof Error ? error.message : 'Unknown error'}`)
      } finally {
        try {
          await stripeSync.close()
        } catch (closeError) {
          logger.error(
            { err: closeError, requestHost: merchantRuntime.host },
            'Failed to close StripeSync resources'
          )
        }
      }

      return reply.send({ received: true })
    },
  })
}
