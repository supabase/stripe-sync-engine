'use strict'
import { FastifyInstance } from 'fastify'
import app from '../src/app'

let server: FastifyInstance

beforeAll(async () => {
  server = await app()
})
afterAll(async () => {
  await server.close()
})

describe('/health', () => {
  test('is alive', async () => {
    const response = await server.inject({
      url: `/health`,
      method: 'GET',
    })
    const json = JSON.parse(response.body)
    expect(response.statusCode).toBe(200)
    expect(json).toMatchObject({ received: true })
  })
})
