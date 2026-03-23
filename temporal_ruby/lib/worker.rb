# frozen_string_literal: true

require 'temporalio/client'
require 'temporalio/worker'
require_relative 'workflows/sync_workflow'
require_relative 'activities/sync_activities'

temporal_address = ENV.fetch('TEMPORAL_ADDRESS', 'localhost:7233')
temporal_namespace = ENV.fetch('TEMPORAL_NAMESPACE', 'default')
engine_url = ENV.fetch('ENGINE_URL', 'http://localhost:3001')

client = Temporalio::Client.connect(temporal_address, temporal_namespace)

worker = Temporalio::Worker.new(
  client: client,
  task_queue: 'sync-engine',
  workflows: [SyncWorkflow],
  activities: SyncActivities.create_all(engine_url: engine_url)
)

puts "Starting sync-engine Temporal worker..."
puts "  Temporal:  #{temporal_address} (#{temporal_namespace})"
puts "  Engine:    #{engine_url}"
puts "  Queue:     sync-engine"

worker.run(shutdown_signals: %w[SIGINT SIGTERM])
