# frozen_string_literal: true

# Streaming NDJSON parser for Faraday responses.
# Buffers partial lines across chunks and yields complete parsed objects.
module Ndjson
  # Parse an NDJSON string into an array of parsed objects.
  def self.parse(text)
    text.to_s.split("\n").reject(&:empty?).map { |line| JSON.parse(line) }
  end

  # Stream an NDJSON response from Faraday, yielding parsed objects as they arrive.
  # Uses Faraday's on_data callback for true streaming (no full-body buffering).
  #
  # @param conn [Faraday::Connection]
  # @param method [Symbol] HTTP method (:get, :post, etc.)
  # @param path [String] request path
  # @param on_message [Proc, nil] called with (msg, count) for each parsed message
  # @yield [Faraday::Request] optional request configuration block
  # @return [Array<Hash>] all parsed messages
  def self.stream_response(conn, method, path, on_message: nil, &block)
    messages = []
    buffer = +''

    response = conn.send(method, path) do |req|
      block&.call(req)

      req.options.on_data = proc do |chunk, _overall_received_bytes, _env|
        buffer << chunk
        lines = buffer.split("\n", -1)
        # Keep the last (possibly incomplete) line in the buffer
        buffer = lines.pop || +''

        lines.each do |line|
          trimmed = line.strip
          next if trimmed.empty?

          msg = JSON.parse(trimmed)
          messages << msg
          on_message&.call(msg, messages.length)
        end
      end
    end

    # Handle any trailing content without final newline
    trimmed = buffer.strip
    unless trimmed.empty?
      msg = JSON.parse(trimmed)
      messages << msg
      on_message&.call(msg, messages.length)
    end

    # Check for HTTP errors (on_data bypasses raise_error middleware)
    unless response.success?
      raise Faraday::Error, "HTTP #{response.status}: #{response.reason_phrase}"
    end

    messages
  end
end
