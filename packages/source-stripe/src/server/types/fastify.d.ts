import type { WebhookService } from '../webhookService'
import type { MerchantConfig } from '../utils/config'

type MerchantRuntime = {
  host: string
  config: MerchantConfig
}

declare module 'fastify' {
  interface FastifyInstance {
    merchantConfigByHost: Record<string, MerchantConfig>
    resolveMerchantByHost: (host: string) => MerchantRuntime | undefined
    createStripeSyncForHost: (host: string) => Promise<WebhookService | undefined>
  }
}
