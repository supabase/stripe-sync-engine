import 'dotenv/config'
import { assertUseEnvProxy } from '@stripe/sync-ts-cli/env-proxy'

export function bootstrap() {
  assertUseEnvProxy()
}
