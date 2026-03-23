import {NativeConnection, Worker} from '@temporalio/worker'
import {createActivities} from './activities'

async function main() {
  const temporalAddress = process.env.TEMPORAL_ADDRESS || 'localhost:7233'
  const temporalNamespace = process.env.TEMPORAL_NAMESPACE || 'default'
  const engineUrl = process.env.ENGINE_URL || 'http://localhost:3001'

  const connection = await NativeConnection.connect({
    address: temporalAddress,
  })

  const worker = await Worker.create({
    connection,
    namespace: temporalNamespace,
    taskQueue: 'sync-engine',
    workflowsPath: require.resolve('./workflows'),
    activities: createActivities(engineUrl),
  })

  console.log('Starting sync-engine Temporal worker...')
  console.log(`  Temporal:  ${temporalAddress} (${temporalNamespace})`)
  console.log(`  Engine:    ${engineUrl}`)
  console.log('  Queue:     sync-engine')

  await worker.run()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
