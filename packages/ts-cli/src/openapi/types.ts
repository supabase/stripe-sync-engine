/** Minimal OpenAPI 3.0 type subset — no external dependency. */

export interface OpenAPISpec {
  paths: Record<string, Record<string, OpenAPIOperation>>
  components?: {
    schemas?: Record<string, OpenAPISchema>
  }
  tags?: Array<{ name: string; description?: string }>
  info?: { title?: string; version?: string }
}

export interface OpenAPIOperation {
  operationId?: string
  tags?: string[]
  summary?: string
  description?: string
  parameters?: OpenAPIParameter[]
  requestBody?: OpenAPIRequestBody
  responses?: Record<string, OpenAPIResponse>
}

export interface OpenAPIParameter {
  name: string
  in: 'path' | 'query' | 'header' | 'cookie'
  required?: boolean
  schema?: OpenAPISchema
  content?: Record<string, { schema?: OpenAPISchema }>
  description?: string
}

export interface OpenAPIRequestBody {
  required?: boolean
  content?: Record<string, { schema?: OpenAPISchema }>
}

export interface OpenAPIResponse {
  description?: string
  content?: Record<string, { schema?: OpenAPISchema }>
}

export interface OpenAPISchema {
  type?: string
  properties?: Record<string, OpenAPISchema>
  required?: string[]
  enum?: unknown[]
  description?: string
  items?: OpenAPISchema
  format?: string
}
