# frozen_string_literal: true

require 'temporalio/workflow'

class SyncWorkflow < Temporalio::Workflow::Definition
  CONTINUE_AS_NEW_THRESHOLD = 500
  EVENT_BATCH_SIZE = 50

  workflow_query
  def status
    { phase: @phase, paused: @paused, cursors: @cursors, iteration: @iteration }
  end

  workflow_signal
  def stripe_event(event)
    @event_buffer << event
  end

  workflow_signal
  def pause
    @paused = true
  end

  workflow_signal
  def resume
    @paused = false
  end

  workflow_signal
  def update_config(new_config)
    @config = @config.merge(new_config)
  end

  workflow_signal
  def delete
    @deleted = true
  end

  def execute(config)
    @config = config
    @cursors = config['cursors'] || {}
    @phase = config['phase'] || 'setup'
    @paused = false
    @deleted = false
    @event_buffer = []
    @iteration = 0

    case @phase
    when 'setup'
      run_setup
      return if @deleted

      @phase = 'backfill'
      run_backfill
      return if @deleted

      @phase = 'live'
      run_live
    when 'backfill'
      run_backfill
      return if @deleted

      @phase = 'live'
      run_live
    when 'live'
      run_live
    end
  end

  private

  def run_setup
    return run_teardown if @deleted

    Temporalio::Workflow.execute_activity(
      SyncActivities::HealthCheck, @config,
      start_to_close_timeout: 30
    )

    Temporalio::Workflow.execute_activity(
      SyncActivities::SourceSetup, @config,
      start_to_close_timeout: 120,
      retry_policy: default_retry_policy
    )

    Temporalio::Workflow.execute_activity(
      SyncActivities::DestinationSetup, @config,
      start_to_close_timeout: 120,
      retry_policy: default_retry_policy
    )
  end

  def run_backfill
    streams = @config['streams'] || []

    streams.each do |stream_config|
      backfill_stream(stream_config['name'])
      return run_teardown if @deleted
    end
  end

  def backfill_stream(stream_name)
    cursor = @cursors[stream_name]

    loop do
      wait_while_paused
      return if @deleted

      result = Temporalio::Workflow.execute_activity(
        SyncActivities::BackfillPage, @config, stream_name, cursor,
        start_to_close_timeout: 300,
        retry_policy: default_retry_policy,
        heartbeat_timeout: 60
      )

      records = result['records']
      break if records.nil? || records.empty?

      # Write the page to the destination
      write_result = Temporalio::Workflow.execute_activity(
        SyncActivities::WriteBatch, @config, records,
        start_to_close_timeout: 300,
        retry_policy: default_retry_policy,
        heartbeat_timeout: 60
      )

      # Update cursors from state messages
      update_cursors(write_result['states'])
      cursor = @cursors[stream_name]

      tick_iteration

      # Check for stream completion
      complete = result['stream_statuses']&.any? { |s| s['status'] == 'complete' }
      break if complete
    end
  end

  def run_live
    loop do
      wait_while_paused
      return run_teardown if @deleted

      # Wait for events or periodic timeout (60s)
      wait_for_events_or_timeout(60)
      next if @event_buffer.empty? && !@deleted
      return run_teardown if @deleted

      process_event_batch
      tick_iteration
    end
  end

  # wait_condition has no timeout param, so we race a sleep against the condition
  def wait_for_events_or_timeout(seconds)
    @timer_fired = false
    Temporalio::Workflow::Future.new do
      Temporalio::Workflow.sleep(seconds)
      @timer_fired = true
    end
    Temporalio::Workflow.wait_condition { !@event_buffer.empty? || @deleted || @timer_fired }
  end

  def process_event_batch
    batch = @event_buffer.shift(EVENT_BATCH_SIZE)
    return if batch.empty?

    batch.each do |event|
      result = Temporalio::Workflow.execute_activity(
        SyncActivities::ProcessEvent, @config, event,
        start_to_close_timeout: 120,
        retry_policy: default_retry_policy
      )
      update_cursors_from_hash(result['state']) if result['state']
    end
  end

  def run_teardown
    Temporalio::Workflow.execute_activity(
      SyncActivities::DestinationTeardown, @config,
      start_to_close_timeout: 120,
      retry_policy: default_retry_policy
    )

    Temporalio::Workflow.execute_activity(
      SyncActivities::SourceTeardown, @config,
      start_to_close_timeout: 120,
      retry_policy: default_retry_policy
    )
  end

  def wait_while_paused
    Temporalio::Workflow.wait_condition { !@paused || @deleted }
  end

  def tick_iteration
    @iteration += 1
    maybe_continue_as_new
  end

  def maybe_continue_as_new
    return unless @iteration >= CONTINUE_AS_NEW_THRESHOLD

    raise Temporalio::Workflow::ContinueAsNewError.new(
      @config.merge('cursors' => @cursors, 'phase' => @phase)
    )
  end

  def update_cursors(state_messages)
    return unless state_messages

    state_messages.each do |msg|
      @cursors[msg['stream']] = msg['data'] if msg['stream']
    end
  end

  def update_cursors_from_hash(state_hash)
    state_hash.each { |stream, data| @cursors[stream] = data }
  end

  def default_retry_policy
    Temporalio::RetryPolicy.new(
      initial_interval: 1.0,
      backoff_coefficient: 2.0,
      max_interval: 300.0,
      max_attempts: 10
    )
  end
end
