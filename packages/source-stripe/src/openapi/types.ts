export type OpenApiSchemaObject = {
  type?: string
  format?: string
  nullable?: boolean
  properties?: Record<string, OpenApiSchemaOrReference>
  items?: OpenApiSchemaOrReference
  oneOf?: OpenApiSchemaOrReference[]
  anyOf?: OpenApiSchemaOrReference[]
  allOf?: OpenApiSchemaOrReference[]
  enum?: unknown[]
  additionalProperties?: boolean | OpenApiSchemaOrReference
  'x-resourceId'?: string
  'x-expandableFields'?: string[]
  'x-expansionResources'?: {
    oneOf?: OpenApiSchemaOrReference[]
  }
}

export type OpenApiReferenceObject = {
  $ref: string
}

export type OpenApiSchemaOrReference = OpenApiSchemaObject | OpenApiReferenceObject

export type OpenApiSpec = {
  openapi: string
  info?: {
    version?: string
  }
  components?: {
    schemas?: Record<string, OpenApiSchemaOrReference>
  }
}

export type ScalarType = 'text' | 'boolean' | 'bigint' | 'numeric' | 'json' | 'timestamptz'

export type ParsedColumn = {
  name: string
  type: ScalarType
  nullable: boolean
  expandableReference?: boolean
}

export type ParsedResourceTable = {
  tableName: string
  resourceId: string
  sourceSchemaName: string
  columns: ParsedColumn[]
}

export type ParsedOpenApiSpec = {
  apiVersion: string
  tables: ParsedResourceTable[]
}

export type ParseSpecOptions = {
  /**
   * Map Stripe x-resourceId values to concrete Postgres table names.
   * Entries are matched case-sensitively.
   */
  resourceAliases?: Record<string, string>
  /**
   * Restrict parsing to these table names.
   * If omitted, all resolvable x-resourceId entries are parsed.
   */
  allowedTables?: string[]
}

export type ResolveSpecConfig = {
  apiVersion: string
  openApiSpecPath?: string
  cacheDir?: string
}

export type ResolvedOpenApiSpec = {
  apiVersion: string
  spec: OpenApiSpec
  source: 'explicit_path' | 'cache' | 'github'
  cachePath?: string
  commitSha?: string
}
