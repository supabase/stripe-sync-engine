# frozen_string_literal: true

require 'temporalio/activity'
require 'faraday'
require 'json'

module SyncActivities
  # Shared HTTP client behavior for all activities
  module EngineClient
    def initialize(engine_url:)
      @engine_url = engine_url
      @conn = Faraday.new(url: engine_url) do |f|
        f.response :raise_error
      end
    end

    private

    def sync_params_header(config, state: nil, streams: nil)
      params = {
        'source_name' => config['source_name'],
        'destination_name' => config['destination_name'],
        'source_config' => config['source_config'],
        'destination_config' => config['destination_config'],
        'streams' => streams || config['streams']
      }
      params['state'] = state if state
      params.to_json
    end

    def parse_ndjson(body)
      body.to_s.split("\n").reject(&:empty?).map { |line| JSON.parse(line) }
    end

    def categorize_messages(messages)
      {
        'records' => messages.select { |m| m['type'] == 'record' },
        'states' => messages.select { |m| m['type'] == 'state' },
        'errors' => messages.select { |m| m['type'] == 'error' },
        'stream_statuses' => messages.select { |m| m['type'] == 'stream_status' },
        'messages' => messages
      }
    end

    def extract_cursors(messages)
      cursors = {}
      messages.each do |msg|
        cursors[msg['stream']] = msg['data'] if msg['type'] == 'state' && msg['stream']
      end
      cursors
    end
  end

  # GET /check — validate source + destination connectivity
  class HealthCheck < Temporalio::Activity::Definition
    include EngineClient

    def execute(config)
      resp = @conn.get('/check') do |req|
        req.headers['X-Sync-Params'] = sync_params_header(config)
      end
      JSON.parse(resp.body)
    end
  end

  # POST /setup — create external resources (webhooks, tables, etc.)
  class SourceSetup < Temporalio::Activity::Definition
    include EngineClient

    def execute(config)
      @conn.post('/setup') do |req|
        req.headers['X-Sync-Params'] = sync_params_header(config)
      end
      nil
    end
  end

  # POST /setup — destination-side setup
  class DestinationSetup < Temporalio::Activity::Definition
    include EngineClient

    def execute(config)
      @conn.post('/setup') do |req|
        req.headers['X-Sync-Params'] = sync_params_header(config)
      end
      nil
    end
  end

  # POST /read — pull one page of backfill data for a stream
  class BackfillPage < Temporalio::Activity::Definition
    include EngineClient

    def execute(config, stream, cursor)
      state = cursor ? { stream => cursor } : {}

      resp = @conn.post('/read') do |req|
        req.headers['X-Sync-Params'] = sync_params_header(
          config, state: state, streams: [{ 'name' => stream }]
        )
        req.headers['Content-Type'] = 'application/x-ndjson'
      end

      categorize_messages(parse_ndjson(resp.body))
    end
  end

  # POST /write — send records to the destination
  class WriteBatch < Temporalio::Activity::Definition
    include EngineClient

    def execute(config, records)
      ndjson_body = records.map { |r| JSON.generate(r) }.join("\n") + "\n"

      resp = @conn.post('/write') do |req|
        req.headers['X-Sync-Params'] = sync_params_header(config)
        req.headers['Content-Type'] = 'application/x-ndjson'
        req.body = ndjson_body
      end

      categorize_messages(parse_ndjson(resp.body))
    end
  end

  # POST /read with event input → POST /write with output
  class ProcessEvent < Temporalio::Activity::Definition
    include EngineClient

    def execute(config, event)
      # Pass event through source
      read_resp = @conn.post('/read') do |req|
        req.headers['X-Sync-Params'] = sync_params_header(config)
        req.headers['Content-Type'] = 'application/x-ndjson'
        req.body = JSON.generate(event) + "\n"
      end

      messages = parse_ndjson(read_resp.body)
      records = messages.select { |m| m['type'] == 'record' }

      return { 'records_written' => 0, 'state' => {} } if records.empty?

      # Forward records to destination
      ndjson_body = records.map { |r| JSON.generate(r) }.join("\n") + "\n"

      write_resp = @conn.post('/write') do |req|
        req.headers['X-Sync-Params'] = sync_params_header(config)
        req.headers['Content-Type'] = 'application/x-ndjson'
        req.body = ndjson_body
      end

      write_messages = parse_ndjson(write_resp.body)
      {
        'records_written' => records.length,
        'state' => extract_cursors(write_messages)
      }
    end
  end

  # POST /teardown — clean up source resources
  class SourceTeardown < Temporalio::Activity::Definition
    include EngineClient

    def execute(config)
      @conn.post('/teardown') do |req|
        req.headers['X-Sync-Params'] = sync_params_header(config)
      end
      nil
    end
  end

  # POST /teardown — clean up destination resources
  class DestinationTeardown < Temporalio::Activity::Definition
    include EngineClient

    def execute(config)
      @conn.post('/teardown') do |req|
        req.headers['X-Sync-Params'] = sync_params_header(config)
      end
      nil
    end
  end

  # All activity classes, for worker registration
  ALL_CLASSES = [
    HealthCheck, SourceSetup, DestinationSetup,
    BackfillPage, WriteBatch, ProcessEvent,
    SourceTeardown, DestinationTeardown
  ].freeze

  # Instantiate all activities with a shared engine URL
  def self.create_all(engine_url:)
    ALL_CLASSES.map { |klass| klass.new(engine_url: engine_url) }
  end
end
