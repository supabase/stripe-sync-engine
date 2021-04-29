import { RequestGenericInterface } from 'fastify'
import { FromSchema } from 'json-schema-to-ts'

export interface AuthenticatedRequest extends RequestGenericInterface {
  Headers: {
    authorization: string
  }
}
