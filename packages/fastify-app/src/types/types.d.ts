import { RequestGenericInterface } from 'fastify'

export interface AuthenticatedRequest extends RequestGenericInterface {
  Headers: {
    authorization: string
  }
}
