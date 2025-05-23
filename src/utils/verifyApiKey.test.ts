import { apiKeyMatches } from './verifyApiKey'

describe('verifyApiKey', () => {
  test.each([
    // false if apikey is undefined
    { userAuth: 'some-pw', apiKey: '', expected: false },
    // false if user auth is undefined
    { userAuth: '', apiKey: 'some-pw', expected: false },

    // false if mismatch with different length
    { userAuth: 'some-pw-2', apiKey: 'some-pw', expected: false },
    { userAuth: 'short', apiKey: 'some-pw', expected: false },
    { userAuth: 'looooooooooooong', apiKey: 'some-pw', expected: false },
    { userAuth: 'sameeee', apiKey: 'some-pw', expected: false },

    // true if actually matches
    {
      userAuth: 'ep5oWe3Aingi2chah9phai5eiKeisahviedei1geiNgaf4Neuv',
      apiKey: 'ep5oWe3Aingi2chah9phai5eiKeisahviedei1geiNgaf4Neuv',
      expected: true,
    },
  ])('testing %s against %s, expected %s', ({ userAuth, apiKey, expected }) => {
    const result = apiKeyMatches(userAuth, apiKey)
    expect(result).toBe(expected)
  })
})
