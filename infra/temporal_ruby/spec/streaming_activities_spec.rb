# frozen_string_literal: true

require 'temporalio/testing'
require 'temporalio/client'
require 'temporalio/worker'
require 'webrick'
require 'json'
require_relative '../lib/workflows/sync_workflow'
require_relative '../lib/activities/sync_activities'

RSpec.describe 'Streaming activities with heartbeats' do
  let(:config) do
    {
      'source_name' => 'stripe',
      'destination_name' => 'postgres',
      'source_config' => {},
      'destination_config' => {},
      'streams' => [{ 'name' => 'test' }]
    }
  end

  # Mock server that streams NDJSON with delays.
  # /read returns records on first call, then empty on subsequent calls.
  # /write always streams back the records it receives.
  def start_mock_server(line_count:, delay:)
    read_call_count = 0
    mutex = Mutex.new

    srv = WEBrick::HTTPServer.new(Port: 0, Logger: WEBrick::Log.new('/dev/null'), AccessLog: [])

    srv.mount_proc '/check' do |_req, res|
      res['Content-Type'] = 'application/json'
      res.body = JSON.generate({
        'source' => { 'status' => 'succeeded' },
        'destination' => { 'status' => 'succeeded' }
      })
    end

    srv.mount_proc '/setup' do |_req, res|
      res.status = 200
    end

    srv.mount_proc '/teardown' do |_req, res|
      res.status = 200
    end

    srv.mount_proc '/read' do |_req, res|
      call_num = mutex.synchronize { read_call_count += 1; read_call_count }
      res['Content-Type'] = 'application/x-ndjson'
      res.chunked = true

      if call_num == 1
        # First call: stream records with delays, then stream_status complete
        res.body = proc do |out|
          line_count.times do |i|
            msg = JSON.generate({
              'type' => 'record',
              'stream' => 'test',
              'data' => { 'id' => i + 1 },
              'emitted_at' => Time.now.to_i
            })
            out.write("#{msg}\n")
            sleep(delay) if delay > 0
          end
          # Signal stream completion
          out.write(JSON.generate({
            'type' => 'stream_status',
            'stream' => 'test',
            'status' => 'complete'
          }) + "\n")
        end
      else
        # Subsequent calls: empty response
        res.body = proc { |_out| }
      end
    end

    srv.mount_proc '/write' do |_req, res|
      res['Content-Type'] = 'application/x-ndjson'
      res.chunked = true
      # Stream back state messages
      res.body = proc do |out|
        out.write(JSON.generate({
          'type' => 'state',
          'stream' => 'test',
          'data' => { 'cursor' => 'done' }
        }) + "\n")
      end
    end

    thread = Thread.new { srv.start }
    actual_port = srv[:Port]
    [srv, thread, actual_port]
  end

  it 'backfillPage streams NDJSON through a real Temporal worker' do
    srv, thread, port = start_mock_server(line_count: 10, delay: 0.5)
    engine_url = "http://127.0.0.1:#{port}"

    env = Temporalio::Testing::WorkflowEnvironment.start_local
    activities = SyncActivities.create_all(engine_url: engine_url)

    handle = env.client.start_workflow(
      SyncWorkflow, config,
      id: 'stream-test-ruby-1',
      task_queue: 'stream-test-ruby-1'
    )

    # Signal delete after enough time for backfill + write to complete
    Thread.new do
      sleep 10
      handle.signal('delete')
    end

    worker = Temporalio::Worker.new(
      client: env.client,
      task_queue: 'stream-test-ruby-1',
      workflows: [SyncWorkflow],
      activities: activities
    )

    # 10 records * 500ms = 5s streaming for backfill, then write, then live.
    # If streaming works, the workflow completes after delete signal.
    worker.run { handle.result }
  ensure
    srv&.shutdown
    thread&.join(5)
    env&.shutdown
  end

  it 'writeBatch streams response and collects state messages' do
    srv, thread, port = start_mock_server(line_count: 5, delay: 0.2)
    engine_url = "http://127.0.0.1:#{port}"

    env = Temporalio::Testing::WorkflowEnvironment.start_local
    activities = SyncActivities.create_all(engine_url: engine_url)

    # Stub backfillPage to return one page with a record + complete status
    allow_any_instance_of(SyncActivities::BackfillPage).to receive(:execute)
      .and_return({
        'records' => [{ 'type' => 'record', 'stream' => 'test', 'data' => { 'id' => 1 } }],
        'states' => [],
        'errors' => [],
        'stream_statuses' => [{ 'type' => 'stream_status', 'stream' => 'test', 'status' => 'complete' }],
        'messages' => []
      })

    handle = env.client.start_workflow(
      SyncWorkflow, config,
      id: 'stream-test-ruby-2',
      task_queue: 'stream-test-ruby-2'
    )

    Thread.new do
      sleep 5
      handle.signal('delete')
    end

    worker = Temporalio::Worker.new(
      client: env.client,
      task_queue: 'stream-test-ruby-2',
      workflows: [SyncWorkflow],
      activities: activities
    )

    worker.run { handle.result }
  ensure
    srv&.shutdown
    thread&.join(5)
    env&.shutdown
  end
end
