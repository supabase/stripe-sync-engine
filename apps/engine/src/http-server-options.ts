import type { ServerOptions as HttpServerOptions } from 'node:http'

const KB = 1024
const MB = 1024 * KB
const ENGINE_MAX_HEADER_SIZE_MB = 50

export const ENGINE_MAX_HEADER_SIZE_BYTES = ENGINE_MAX_HEADER_SIZE_MB * MB

// Pipeline config and connector state are passed via HTTP headers.
// Node.js defaults to 16 KB which is too small for resumed syncs that carry
// both X-Pipeline and X-State. Keep the CLI serve path and API entrypoint on
// the same ceiling so the deployed container and local API behave the same way.
export const ENGINE_SERVER_OPTIONS = {
  maxHeaderSize: ENGINE_MAX_HEADER_SIZE_BYTES,
} satisfies Pick<HttpServerOptions, 'maxHeaderSize'>
