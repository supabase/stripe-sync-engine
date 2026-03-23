# frozen_string_literal: true

require 'json'
require 'webrick'
require 'faraday'
require_relative '../lib/ndjson'

RSpec.describe Ndjson do
  describe '.parse' do
    it 'parses a multi-line NDJSON string' do
      text = "{\"a\":1}\n{\"b\":2}\n{\"c\":3}"
      expect(Ndjson.parse(text)).to eq([{ 'a' => 1 }, { 'b' => 2 }, { 'c' => 3 }])
    end

    it 'skips empty lines' do
      text = "{\"a\":1}\n\n{\"b\":2}\n"
      expect(Ndjson.parse(text)).to eq([{ 'a' => 1 }, { 'b' => 2 }])
    end

    it 'returns empty for blank string' do
      expect(Ndjson.parse('')).to eq([])
    end

    it 'handles trailing content without final newline' do
      text = "{\"a\":1}\n{\"b\":2}"
      expect(Ndjson.parse(text)).to eq([{ 'a' => 1 }, { 'b' => 2 }])
    end
  end

  describe '.stream_response' do
    let(:port) { 0 } # auto-assign
    let(:server) { nil }

    def start_server(line_count:, delay:)
      srv = WEBrick::HTTPServer.new(Port: 0, Logger: WEBrick::Log.new('/dev/null'), AccessLog: [])

      srv.mount_proc '/' do |_req, res|
        res['Content-Type'] = 'application/x-ndjson'
        res.chunked = true
        res.body = proc do |out|
          line_count.times do |i|
            msg = JSON.generate({ 'type' => 'record', 'data' => { 'id' => i + 1 } })
            out.write("#{msg}\n")
            sleep(delay) if delay > 0
          end
        end
      end

      thread = Thread.new { srv.start }
      actual_port = srv[:Port]
      [srv, thread, actual_port]
    end

    it 'streams and parses all NDJSON lines' do
      srv, thread, actual_port = start_server(line_count: 5, delay: 0)

      conn = Faraday.new(url: "http://127.0.0.1:#{actual_port}")
      messages = Ndjson.stream_response(conn, :get, '/')

      expect(messages.length).to eq(5)
      expect(messages.first).to eq({ 'type' => 'record', 'data' => { 'id' => 1 } })
      expect(messages.last).to eq({ 'type' => 'record', 'data' => { 'id' => 5 } })
    ensure
      srv&.shutdown
      thread&.join(5)
    end

    it 'invokes the on_message callback with count' do
      srv, thread, actual_port = start_server(line_count: 3, delay: 0)

      conn = Faraday.new(url: "http://127.0.0.1:#{actual_port}")
      counts = []
      on_msg = proc { |_msg, count| counts << count }
      Ndjson.stream_response(conn, :get, '/', on_message: on_msg)

      expect(counts).to eq([1, 2, 3])
    ensure
      srv&.shutdown
      thread&.join(5)
    end

    it 'handles lines split across chunks with delayed streaming' do
      srv, thread, actual_port = start_server(line_count: 3, delay: 0.1)

      conn = Faraday.new(url: "http://127.0.0.1:#{actual_port}")
      messages = Ndjson.stream_response(conn, :get, '/')

      expect(messages.length).to eq(3)
      expect(messages.map { |m| m['data']['id'] }).to eq([1, 2, 3])
    ensure
      srv&.shutdown
      thread&.join(5)
    end
  end
end
