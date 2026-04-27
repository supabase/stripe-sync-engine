import type { ServerOptions as HttpServerOptions } from 'node:http'

// Pipeline config and state are now passed via JSON request body, so the
// large header size override is no longer needed. Use Node.js defaults.
export const ENGINE_SERVER_OPTIONS = {} satisfies Pick<HttpServerOptions, 'maxHeaderSize'>
