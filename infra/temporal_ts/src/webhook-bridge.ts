import http from 'node:http'
import { Client, Connection } from '@temporalio/client'

async function main() {
  const temporalAddress = process.env.TEMPORAL_ADDRESS || 'localhost:7233'
  const temporalNamespace = process.env.TEMPORAL_NAMESPACE || 'default'
  const port = Number(process.env.WEBHOOK_BRIDGE_PORT || '8088')

  const connection = await Connection.connect({ address: temporalAddress })
  const client = new Client({ connection, namespace: temporalNamespace })

  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
      return
    }

    if (req.url === '/webhooks' && req.method === 'POST') {
      try {
        const body = await readBody(req)
        const event = JSON.parse(body)
        const accountId = event.account || event?.data?.object?.account

        if (!accountId) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"status":"skipped","reason":"no account_id"}')
          return
        }

        const workflowIds = await findWorkflowsForAccount(client, accountId)
        let signaled = 0
        for (const wfId of workflowIds) {
          try {
            const handle = client.workflow.getHandle(wfId)
            await handle.signal('stripe_event', event)
            signaled++
          } catch {
            // Workflow not found — skip
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', signaled }))
      } catch (err: any) {
        if (err instanceof SyntaxError) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `Invalid JSON: ${err.message}` }))
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      }
      return
    }

    res.writeHead(404)
    res.end()
  })

  server.listen(port, () => {
    console.log('Starting webhook bridge...')
    console.log(`  Temporal: ${temporalAddress} (${temporalNamespace})`)
    console.log(`  Port:     ${port}`)
    console.log(`Webhook bridge listening on port ${port}`)
  })

  process.on('SIGINT', () => server.close())
  process.on('SIGTERM', () => server.close())
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

async function findWorkflowsForAccount(client: Client, accountId: string): Promise<string[]> {
  try {
    const query = `WorkflowType = 'syncWorkflow' AND AccountId = '${accountId}' AND ExecutionStatus = 'Running'`
    const ids: string[] = []
    for await (const workflow of client.workflow.list({ query })) {
      ids.push(workflow.workflowId)
    }
    return ids
  } catch {
    return []
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
