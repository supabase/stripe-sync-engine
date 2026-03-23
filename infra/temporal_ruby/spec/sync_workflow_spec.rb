# frozen_string_literal: true

require 'temporalio/testing'
require 'temporalio/client'
require 'temporalio/worker'
require_relative '../lib/workflows/sync_workflow'
require_relative '../lib/activities/sync_activities'

RSpec.describe SyncWorkflow do
  let(:config) do
    {
      'source_name' => 'stripe',
      'destination_name' => 'postgres',
      'source_config' => { 'api_key' => 'sk_test_xxx' },
      'destination_config' => { 'connection_string' => 'postgres://localhost/test' },
      'streams' => [{ 'name' => 'customers' }, { 'name' => 'products' }]
    }
  end

  let(:empty_result) do
    { 'records' => [], 'states' => [], 'errors' => [], 'stream_statuses' => [], 'messages' => [] }
  end

  # Stub all activity classes to return safe defaults
  def stub_all_activities
    allow_any_instance_of(SyncActivities::HealthCheck).to receive(:execute)
      .and_return({ 'source' => { 'status' => 'succeeded' }, 'destination' => { 'status' => 'succeeded' } })
    allow_any_instance_of(SyncActivities::SourceSetup).to receive(:execute).and_return(nil)
    allow_any_instance_of(SyncActivities::DestinationSetup).to receive(:execute).and_return(nil)
    allow_any_instance_of(SyncActivities::SourceTeardown).to receive(:execute).and_return(nil)
    allow_any_instance_of(SyncActivities::DestinationTeardown).to receive(:execute).and_return(nil)
    allow_any_instance_of(SyncActivities::BackfillPage).to receive(:execute).and_return(empty_result)
    allow_any_instance_of(SyncActivities::WriteBatch).to receive(:execute).and_return(empty_result)
    allow_any_instance_of(SyncActivities::ProcessEvent).to receive(:execute)
      .and_return({ 'records_written' => 0, 'state' => {} })
  end

  describe 'setup → backfill → live phases' do
    it 'runs through all phases with empty backfill then exits on delete' do
      stub_all_activities

      env = Temporalio::Testing::WorkflowEnvironment.start_local

      handle = env.client.start_workflow(
        SyncWorkflow, config,
        id: 'test-sync-1',
        task_queue: 'test-queue'
      )

      # Let it reach live phase, then delete
      Thread.new do
        sleep 1
        handle.signal('delete')
      end

      worker = Temporalio::Worker.new(
        client: env.client,
        task_queue: 'test-queue',
        workflows: [SyncWorkflow],
        activities: SyncActivities.create_all(engine_url: 'http://unused')
      )

      worker.run { handle.result }
    ensure
      env&.shutdown
    end
  end

  describe 'backfill with data' do
    it 'pages through records and writes them' do
      stub_all_activities

      call_count = 0
      allow_any_instance_of(SyncActivities::BackfillPage).to receive(:execute) do |_instance, _config, stream, _cursor|
        call_count += 1
        if call_count <= 2
          {
            'records' => [{ 'type' => 'record', 'stream' => stream, 'data' => { 'id' => "obj_#{call_count}" }, 'emitted_at' => Time.now.to_i }],
            'states' => [],
            'errors' => [],
            'stream_statuses' => [],
            'messages' => []
          }
        else
          empty_result
        end
      end

      allow_any_instance_of(SyncActivities::WriteBatch).to receive(:execute).and_return({
        'records' => [],
        'states' => [{ 'type' => 'state', 'stream' => 'customers', 'data' => { 'cursor' => 'abc' } }],
        'errors' => [],
        'stream_statuses' => [],
        'messages' => [{ 'type' => 'state', 'stream' => 'customers', 'data' => { 'cursor' => 'abc' } }]
      })

      env = Temporalio::Testing::WorkflowEnvironment.start_local

      handle = env.client.start_workflow(
        SyncWorkflow, config,
        id: 'test-sync-2',
        task_queue: 'test-queue'
      )

      Thread.new do
        sleep 2
        handle.signal('delete')
      end

      worker = Temporalio::Worker.new(
        client: env.client,
        task_queue: 'test-queue',
        workflows: [SyncWorkflow],
        activities: SyncActivities.create_all(engine_url: 'http://unused')
      )

      worker.run { handle.result }
    ensure
      env&.shutdown
    end
  end

  describe 'pause/resume signals' do
    it 'pauses and resumes processing' do
      stub_all_activities

      env = Temporalio::Testing::WorkflowEnvironment.start_local

      handle = env.client.start_workflow(
        SyncWorkflow, config,
        id: 'test-sync-3',
        task_queue: 'test-queue'
      )

      query_result = nil
      Thread.new do
        sleep 0.5
        handle.signal('pause')
        sleep 0.5
        query_result = handle.query('status')
        handle.signal('resume')
        sleep 0.5
        handle.signal('delete')
      end

      worker = Temporalio::Worker.new(
        client: env.client,
        task_queue: 'test-queue',
        workflows: [SyncWorkflow],
        activities: SyncActivities.create_all(engine_url: 'http://unused')
      )

      worker.run { handle.result }

      # Query result uses string keys after serialization
      expect(query_result).to be_a(Hash)
      paused = query_result['paused'] || query_result[:paused]
      expect(paused).to be true
    ensure
      env&.shutdown
    end
  end

  describe 'stripe_event signal in live phase' do
    it 'processes events received via signal' do
      stub_all_activities

      env = Temporalio::Testing::WorkflowEnvironment.start_local

      handle = env.client.start_workflow(
        SyncWorkflow, config,
        id: 'test-sync-4',
        task_queue: 'test-queue'
      )

      Thread.new do
        sleep 1
        handle.signal('stripe_event', { 'id' => 'evt_1', 'type' => 'customer.created' })
        handle.signal('stripe_event', { 'id' => 'evt_2', 'type' => 'product.updated' })
        sleep 1
        handle.signal('delete')
      end

      worker = Temporalio::Worker.new(
        client: env.client,
        task_queue: 'test-queue',
        workflows: [SyncWorkflow],
        activities: SyncActivities.create_all(engine_url: 'http://unused')
      )

      worker.run { handle.result }
    ensure
      env&.shutdown
    end
  end

  describe 'delete signal during backfill' do
    it 'triggers teardown and completes' do
      stub_all_activities

      # Make backfill slow so delete arrives mid-backfill
      allow_any_instance_of(SyncActivities::BackfillPage).to receive(:execute) do
        sleep 0.5
        empty_result
      end

      env = Temporalio::Testing::WorkflowEnvironment.start_local

      handle = env.client.start_workflow(
        SyncWorkflow, config,
        id: 'test-sync-5',
        task_queue: 'test-queue'
      )

      Thread.new do
        sleep 0.2
        handle.signal('delete')
      end

      worker = Temporalio::Worker.new(
        client: env.client,
        task_queue: 'test-queue',
        workflows: [SyncWorkflow],
        activities: SyncActivities.create_all(engine_url: 'http://unused')
      )

      worker.run { handle.result }
    ensure
      env&.shutdown
    end
  end
end
