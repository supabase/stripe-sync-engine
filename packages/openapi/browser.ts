// Browser-safe entry. Excludes specFetchHelper (which imports node:fs / node:path)
// so consumers in webpack/Next.js client bundles can import SpecParser without errors.

export { SpecParser, OPENAPI_RESOURCE_TABLE_ALIASES, resolveTableName } from './specParser.js'
export type { ListEndpoint, NestedEndpoint } from './specParser.js'
export { OPENAPI_COMPATIBILITY_COLUMNS } from './runtimeMappings.js'
export { parsedTableToJsonSchema } from './jsonSchemaConverter.js'
export type {
  ParsedColumn,
  ParsedResourceTable,
  ParsedOpenApiSpec,
  ParseSpecOptions,
  ScalarType,
  OpenApiSpec,
  OpenApiSchemaObject,
  OpenApiSchemaOrReference,
  OpenApiReferenceObject,
  OpenApiResponse,
  OpenApiResponseContent,
  OpenApiOperationObject,
  OpenApiPathItem,
} from './types.js'
