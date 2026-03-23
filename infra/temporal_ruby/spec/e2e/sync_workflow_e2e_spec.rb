# frozen_string_literal: true

# E2E test: Temporal SyncWorkflow → Stateless API → Stripe → Postgres
#
# Prerequisites:
#   - STRIPE_API_KEY env var (test mode key with read access)
#   - Postgres running at POSTGRES_URL (default: localhost:5432)
#   - `pnpm build` already run (stateless API + connector binaries)
#
# Run:
#   cd temporal && STRIPE_API_KEY=sk_test_... bundle exec rspec spec/e2e/

require 'temporalio/testing'
require 'temporalio/client'
require 'temporalio/worker'
require 'pg'
require 'stripe'
require 'json'
require 'socket'
require_relative '../../lib/workflows/sync_workflow'
require_relative '../../lib/activities/sync_activities'

RSpec.describe 'SyncWorkflow E2E', :e2e do
  let(:stripe_api_key) { ENV.fetch('STRIPE_API_KEY') }
  let(:postgres_url) { ENV.fetch('POSTGRES_URL', 'postgresql://postgres:postgres@localhost:5432/postgres') }
  let(:schema_name) { "temporal_e2e_#{Time.now.strftime('%Y%m%d%H%M%S')}_#{rand(1000)}" }
  let(:repo_root) { File.expand_path('../../..', __dir__) }

  # Find a free port for the stateless API
  def find_free_port
    server = TCPServer.new('127.0.0.1', 0)
    port = server.addr[1]
    server.close
    port
  end

  # Start the stateless API server as a subprocess
  def start_stateless_api(port)
    stateless_dir = File.join(repo_root, 'apps/stateless')
    api_entry = File.join(stateless_dir, 'dist/api/index.js')

    pid = spawn(
      { 'PORT' => port.to_s },
      'node', api_entry,
      chdir: stateless_dir,
      out: '/tmp/temporal-e2e-api.log',
      err: '/tmp/temporal-e2e-api.log'
    )

    30.times do
      begin
        TCPSocket.new('127.0.0.1', port).close
        return pid
      rescue Errno::ECONNREFUSED
        sleep 0.5
      end
    end
    raise "Stateless API failed to start on port #{port}. Log: #{File.read('/tmp/temporal-e2e-api.log')}"
  end

  # Run a workflow with a monitor thread that verifies data before signaling delete.
  # Verification happens while the workflow is in 'live' phase (after backfill),
  # BEFORE teardown runs, since teardown drops the Postgres schema.
  #
  # When KEEP_TEST_DATA is set, the workflow is cancelled instead of deleted
  # so the schema and data remain in Postgres for inspection.
  def run_workflow_with_verification(env, handle, worker, &verify_block)
    verification_error = nil

    monitor = Thread.new do
      loop do
        sleep 1
        begin
          status = handle.query('status')
          phase = status['phase'] || status[:phase]
          if phase == 'live'
            sleep 1
            begin
              verify_block.call
            rescue StandardError => e
              verification_error = e.message
            end
            if ENV['KEEP_TEST_DATA']
              handle.cancel
            else
              handle.signal('delete')
            end
            break
          end
        rescue StandardError
          # Workflow not yet started or query failed — retry
        end
      end
    end

    begin
      worker.run { handle.result }
    rescue Temporalio::Error::WorkflowFailedError
      # Expected when KEEP_TEST_DATA cancels the workflow
    end
    monitor.join(5)

    raise verification_error if verification_error
  end

  it 'backfills products from Stripe into Postgres via Temporal workflow' do
    api_port = find_free_port
    api_pid = start_stateless_api(api_port)
    engine_url = "http://localhost:#{api_port}"

    pg_conn = PG.connect(postgres_url)

    config = {
      'source_name' => 'stripe',
      'destination_name' => 'postgres',
      'source_config' => {
        'api_key' => stripe_api_key,
        'backfill_limit' => 5
      },
      'destination_config' => {
        'connection_string' => postgres_url,
        'schema' => schema_name
      },
      'streams' => [{ 'name' => 'products' }]
    }

    env = Temporalio::Testing::WorkflowEnvironment.start_local

    handle = env.client.start_workflow(
      SyncWorkflow, config,
      id: "temporal-e2e-#{schema_name}",
      task_queue: 'e2e-queue'
    )

    worker = Temporalio::Worker.new(
      client: env.client,
      task_queue: 'e2e-queue',
      workflows: [SyncWorkflow],
      activities: SyncActivities.create_all(engine_url: engine_url)
    )

    run_workflow_with_verification(env, handle, worker) do
      result = pg_conn.exec("SELECT count(*) AS cnt FROM \"#{schema_name}\".\"products\"")
      count = result[0]['cnt'].to_i
      puts "  Postgres: #{schema_name}.products has #{count} rows"
      raise "Expected > 0 products, got #{count}" if count == 0

      row = pg_conn.exec("SELECT id, _raw_data->>'name' AS name FROM \"#{schema_name}\".\"products\" LIMIT 1")[0]
      puts "  Sample: #{row['id']} → #{row['name']}"
      raise "Expected prod_ prefix, got #{row['id']}" unless row['id'].start_with?('prod_')
    end
  ensure
    if pg_conn
      unless ENV['KEEP_TEST_DATA']
        pg_conn.exec("DROP SCHEMA IF EXISTS \"#{schema_name}\" CASCADE") rescue nil
      end
      pg_conn.close rescue nil
    end
    Process.kill('TERM', api_pid) rescue nil if api_pid
    Process.wait(api_pid) rescue nil if api_pid
    env&.shutdown
  end

  it 'processes a live Stripe event via signal after backfill' do
    api_port = find_free_port
    api_pid = start_stateless_api(api_port)
    engine_url = "http://localhost:#{api_port}"

    pg_conn = PG.connect(postgres_url)
    stripe_client = Stripe::StripeClient.new(stripe_api_key)

    config = {
      'source_name' => 'stripe',
      'destination_name' => 'postgres',
      'source_config' => {
        'api_key' => stripe_api_key,
        'backfill_limit' => 3
      },
      'destination_config' => {
        'connection_string' => postgres_url,
        'schema' => schema_name
      },
      'streams' => [{ 'name' => 'products' }]
    }

    env = Temporalio::Testing::WorkflowEnvironment.start_local

    handle = env.client.start_workflow(
      SyncWorkflow, config,
      id: "temporal-e2e-live-#{schema_name}",
      task_queue: 'e2e-queue'
    )

    verification_error = nil
    event_signaled = false

    monitor = Thread.new do
      loop do
        sleep 1
        begin
          status = handle.query('status')
          phase = status['phase'] || status[:phase]

          if phase == 'live' && !event_signaled
            # Trigger a product update via Stripe API
            products = stripe_client.v1.products.list({ limit: 1 })
            product = products.data.first
            new_name = "temporal-e2e-#{Time.now.to_i}"
            stripe_client.v1.products.update(product.id, { name: new_name })
            puts "  Updated product #{product.id} → #{new_name}"

            # Fetch the event from Stripe events API
            sleep 2
            events = stripe_client.v1.events.list({ limit: 5, type: 'product.updated' })
            event = events.data.first
            puts "  Fetched event #{event.id} (#{event.type})"

            # Signal the event to the workflow
            handle.signal('stripe_event', JSON.parse(event.to_json))
            event_signaled = true

            # Wait for processing, then verify data before teardown
            sleep 3
            begin
              result = pg_conn.exec("SELECT count(*) AS cnt FROM \"#{schema_name}\".\"products\"")
              count = result[0]['cnt'].to_i
              puts "  Postgres: #{schema_name}.products has #{count} rows"
              verification_error = "Expected > 0 products, got #{count}" if count == 0
            rescue StandardError => e
              verification_error = "DB verification failed: #{e.message}"
            end

            handle.signal('delete')
            break
          end
        rescue StandardError => e
          puts "  Monitor: #{e.message}" if ENV['DEBUG']
        end
      end
    end

    worker = Temporalio::Worker.new(
      client: env.client,
      task_queue: 'e2e-queue',
      workflows: [SyncWorkflow],
      activities: SyncActivities.create_all(engine_url: engine_url)
    )

    worker.run { handle.result }
    monitor.join(5)

    raise verification_error if verification_error
  ensure
    if pg_conn
      unless ENV['KEEP_TEST_DATA']
        pg_conn.exec("DROP SCHEMA IF EXISTS \"#{schema_name}\" CASCADE") rescue nil
      end
      pg_conn.close rescue nil
    end
    Process.kill('TERM', api_pid) rescue nil if api_pid
    Process.wait(api_pid) rescue nil if api_pid
    env&.shutdown
  end
end
