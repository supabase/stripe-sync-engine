import { describe, expect, it } from 'vitest'
import { createInputQueue } from './src-webhook.js'

describe('createInputQueue', () => {
  it('rejects wait() when the abort signal fires', async () => {
    const queue = createInputQueue()
    const ac = new AbortController()

    const pending = queue.wait(ac.signal)
    ac.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
