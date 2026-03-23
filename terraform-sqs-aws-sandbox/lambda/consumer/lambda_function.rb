# sync-message-consumer: Ruby Lambda triggered by SQS
# Reports sqs.dequeued, POSTs NDJSON to sync-engine /write, reads streaming status,
# reports sync_status.received back to /log

require 'json'
require 'net/http'
require 'uri'

def post_log(base_url, event_id, stage)
  uri = URI("#{base_url}/log")
  Net::HTTP.post(uri, JSON.generate({ event_id: event_id, stage: stage }), 'Content-Type' => 'application/json')
rescue => e
  $stderr.puts "Failed to log #{stage} for #{event_id}: #{e.message}"
end

def lambda_handler(event:, context:)
  base_url = ENV.fetch('SYNC_ENGINE_URL')
  write_uri = URI("#{base_url}/write")

  # Parse SQS records
  records = event['Records'].map { |r| JSON.parse(r['body']) }

  # Log sqs.dequeued for each record
  records.each { |r| post_log(base_url, r['id'], 'sqs.dequeued') }

  # Build NDJSON body
  ndjson = records.map { |r| JSON.generate(r) }.join("\n") + "\n"

  # POST to /write with streaming response
  http = Net::HTTP.new(write_uri.host, write_uri.port)
  http.read_timeout = 120

  request = Net::HTTP::Post.new(write_uri.path)
  request['Content-Type'] = 'application/x-ndjson'
  request['Transfer-Encoding'] = 'chunked'
  request.body = ndjson

  confirmations = []
  summary = nil

  http.request(request) do |response|
    unless response.code == '200'
      raise "sync-engine returned #{response.code}: #{response.body}"
    end

    response.read_body do |chunk|
      chunk.split("\n").each do |line|
        next if line.strip.empty?
        parsed = JSON.parse(line)
        if parsed['done']
          summary = parsed
        else
          confirmations << parsed
          post_log(base_url, parsed['event_id'], 'sync_status.received')
        end
      end
    end
  end

  $stdout.puts "Wrote #{confirmations.size} rows, summary: #{summary.inspect}"

  {
    statusCode: 200,
    body: JSON.generate({
      confirmed: confirmations.size,
      summary: summary
    })
  }
rescue => e
  $stderr.puts "Error: #{e.message}\n#{e.backtrace&.first(5)&.join("\n")}"
  raise e
end
