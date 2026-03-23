# webhook-receiver: Ruby Lambda with Function URL
# Receives webhook POST, calls sync-engine /read, streams NDJSON, sends each event to SQS

require 'json'
require 'net/http'
require 'uri'
require 'aws-sdk-sqs'

def post_log(base_url, event_id, stage)
  uri = URI("#{base_url}/log")
  Net::HTTP.post(uri, JSON.generate({ event_id: event_id, stage: stage }), 'Content-Type' => 'application/json')
rescue => e
  $stderr.puts "Failed to log #{stage} for #{event_id}: #{e.message}"
end

def lambda_handler(event:, context:)
  body = event['body']
  body = Base64.decode64(body) if event['isBase64Encoded']

  base_url = ENV.fetch('SYNC_ENGINE_URL')
  sqs_queue_url = ENV.fetch('SQS_QUEUE_URL')

  sqs = Aws::SQS::Client.new

  # Parse webhook ID for logging
  webhook_id = (JSON.parse(body) rescue {})['id'] || 'unknown'
  post_log(base_url, webhook_id, 'webhook.received')

  read_uri = URI("#{base_url}/read")
  events_queued = 0
  buffer = ""

  Net::HTTP.start(read_uri.host, read_uri.port, use_ssl: read_uri.scheme == 'https',
                  read_timeout: 120, open_timeout: 10) do |http|
    request = Net::HTTP::Post.new(read_uri)
    request['Content-Type'] = 'application/json'
    request.body = body

    http.request(request) do |response|
      unless response.is_a?(Net::HTTPSuccess)
        return {
          statusCode: response.code.to_i,
          body: JSON.generate({ error: "sync-engine returned #{response.code}" })
        }
      end

      response.read_body do |chunk|
        buffer << chunk
        while (line_end = buffer.index("\n"))
          line = buffer.slice!(0, line_end + 1).strip
          next if line.empty?

          begin
            evt = JSON.parse(line)
            next unless evt.key?('id')

            sqs.send_message(
              queue_url: sqs_queue_url,
              message_body: JSON.generate(evt)
            )
            events_queued += 1

            post_log(base_url, evt['id'], 'sqs.enqueued')
          rescue JSON::ParserError
            next
          end
        end
      end
    end
  end

  # Handle any remaining data in buffer (no trailing newline)
  unless buffer.strip.empty?
    begin
      evt = JSON.parse(buffer.strip)
      if evt.key?('id')
        sqs.send_message(queue_url: sqs_queue_url, message_body: JSON.generate(evt))
        events_queued += 1
        post_log(base_url, evt['id'], 'sqs.enqueued')
      end
    rescue JSON::ParserError
      # ignore
    end
  end

  {
    statusCode: 200,
    body: JSON.generate({ events_queued: events_queued })
  }
rescue => e
  {
    statusCode: 500,
    body: JSON.generate({ error: e.message })
  }
end
