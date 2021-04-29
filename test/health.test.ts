'use strict'
import app from '../src/app'

describe('/health', () => {
  test('is alive', async () => {
    const response = await app().inject({
      url: `/health`,
      method: 'GET',
    })
    const json = JSON.parse(response.body)
    expect(response.statusCode).toBe(200)
    expect(json).toMatchObject({ received: true })
  })
})
