# frozen_string_literal: true

require 'temporalio/client'
require 'json'
require 'webrick'

# Webhook-to-signal bridge: receives Stripe webhooks and fires signals
# to matching SyncWorkflow instances.
#
# Routing: queries Temporal visibility for workflows with matching AccountId
# search attribute, then signals each one with the event payload.

class WebhookBridge
  def initialize(client:, port: 8088)
    @client = client
    @port = port
  end

  def start
    server = WEBrick::HTTPServer.new(Port: @port, Logger: WEBrick::Log.new($stdout, WEBrick::Log::INFO))

    server.mount_proc '/webhooks' do |req, res|
      handle_webhook(req, res)
    end

    server.mount_proc '/health' do |_req, res|
      res.status = 200
      res.body = '{"ok":true}'
      res['Content-Type'] = 'application/json'
    end

    trap('INT') { server.shutdown }
    trap('TERM') { server.shutdown }

    puts "Webhook bridge listening on port #{@port}"
    server.start
  end

  private

  def handle_webhook(req, res)
    event = JSON.parse(req.body)

    account_id = event['account'] || event.dig('data', 'object', 'account')

    unless account_id
      res.status = 200
      res.body = '{"status":"skipped","reason":"no account_id"}'
      res['Content-Type'] = 'application/json'
      return
    end

    workflow_ids = find_workflows_for_account(account_id)

    signaled = 0
    workflow_ids.each do |wf_id|
      handle = @client.workflow_handle(wf_id)
      handle.signal('stripe_event', event)
      signaled += 1
    rescue Temporalio::Error::WorkflowNotFoundError
      next
    end

    res.status = 200
    res.body = JSON.generate(status: 'ok', signaled: signaled)
    res['Content-Type'] = 'application/json'
  rescue JSON::ParserError => e
    res.status = 400
    res.body = JSON.generate(error: "Invalid JSON: #{e.message}")
    res['Content-Type'] = 'application/json'
  rescue StandardError => e
    res.status = 500
    res.body = JSON.generate(error: e.message)
    res['Content-Type'] = 'application/json'
  end

  def find_workflows_for_account(account_id)
    query = "WorkflowType = 'SyncWorkflow' AND AccountId = '#{account_id}' AND ExecutionStatus = 'Running'"
    workflows = @client.list_workflows(query: query)
    workflows.map(&:id)
  rescue StandardError
    []
  end
end

if __FILE__ == $PROGRAM_NAME
  temporal_address = ENV.fetch('TEMPORAL_ADDRESS', 'localhost:7233')
  temporal_namespace = ENV.fetch('TEMPORAL_NAMESPACE', 'default')
  port = ENV.fetch('WEBHOOK_BRIDGE_PORT', '8088').to_i

  client = Temporalio::Client.connect(temporal_address, temporal_namespace)

  puts "Starting webhook bridge..."
  puts "  Temporal: #{temporal_address} (#{temporal_namespace})"
  puts "  Port:     #{port}"

  WebhookBridge.new(client: client, port: port).start
end
