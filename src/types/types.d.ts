import { RequestGenericInterface } from 'fastify'
export interface JsonSchema {
  readonly $id: string
  readonly type: 'object'
  readonly properties: Record<string, unknown>
  required: readonly string[]
}
export interface AuthenticatedRequest extends RequestGenericInterface {
  Headers: {
    authorization: string
  }
}
