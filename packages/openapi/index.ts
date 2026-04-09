export type * from './types.js'
export { SpecParser, OPENAPI_RESOURCE_TABLE_ALIASES } from './specParser.js'
export { OPENAPI_COMPATIBILITY_COLUMNS } from './runtimeMappings.js'

export {
  resolveOpenApiSpec,
  BUNDLED_API_VERSION,
  SUPPORTED_API_VERSIONS,
} from './specFetchHelper.js'
export {
  discoverListEndpoints,
  discoverNestedEndpoints,
  isV2Path,
  buildListFn,
  buildRetrieveFn,
  resolveTableName,
  StripeApiRequestError,
} from './listFnResolver.js'
export type {
  ListEndpoint,
  NestedEndpoint,
  ListFn,
  RetrieveFn,
  ListParams,
} from './listFnResolver.js'
export { parsedTableToJsonSchema } from './jsonSchemaConverter.js'
export {
  generateObjectsFromSchema,
  findSchemaNameByResourceId,
} from './objectGenerator.js'
export type { GenerateObjectsOptions } from './objectGenerator.js'
export {
  StripeAccountSchema,
  StripeWebhookEndpointSchema,
  StripeApiListSchema,
  StripeApiErrorSchema,
} from './src/stripeApiTypes.js'
export type {
  StripeAccount,
  StripeApiList,
  StripeWebhookEndpoint,
  StripeApiErrorBody,
} from './src/stripeApiTypes.js'
