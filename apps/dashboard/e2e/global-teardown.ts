export default async function globalTeardown() {
  const server = (globalThis as Record<string, unknown>).__engineServer as
    | { close: (cb: (err?: unknown) => void) => void }
    | undefined
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  }
}
