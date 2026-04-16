# Header Size Limits

## Context

Pipeline configuration (source config, destination config, and connector state) is passed
via the `X-Pipeline` HTTP header. Node.js defaults to a 16 KB total header limit, which
caps usable pipeline state at ~250 entries — far too small for connectors like
`destination-google-sheets` that need row-mapping state (`{ object_id: row_number }`).

## Research Findings

### Node.js default limit

Node.js's HTTP parser (`llhttp`) enforces a 16,384-byte (16 KB) limit on total header
size. Headers exceeding this return HTTP 431 (Request Header Fields Too Large). At ~512 KB
the server drops the connection entirely (ECONNRESET).

### Raising the limit

`@hono/node-server` passes `serverOptions` directly to `http.createServer()`, which
accepts `maxHeaderSize`. This is a parser limit, not a pre-allocation — setting it to
50 MB costs nothing when headers are small.

Bun's `Bun.serve()` does not use Node's HTTP parser and has a much higher default limit.

### Google Sheets row mapping budget

Each `{ "obj_id": row_number }` entry is ~30 bytes. With Google Sheets' 10M cell limit:

| Columns/row | Max rows  | Mapping size (JSON object) |
| ----------- | --------- | -------------------------- |
| 10          | 1,000,000 | ~30 MB                     |
| 20          | 500,000   | ~15 MB                     |
| 50          | 200,000   | ~6 MB                      |

More efficient encodings (sorted array, prefix compression) reduce this by ~30-50% but
don't change the order of magnitude.

### Alternative: read mapping from sheet

Instead of storing the row map in state, read the ID column from the sheet at the start of
each write batch and build the map in memory:

| Sheet rows | API call time | Response size |
| ---------- | ------------- | ------------- |
| 1K         | ~100ms        | ~25 KB        |
| 10K        | ~200ms        | ~250 KB       |
| 100K       | ~1-2s         | ~2.5 MB       |
| 1M         | ~5-15s        | ~25 MB        |

This eliminates the mapping from state entirely. Tradeoff: one extra Sheets API read per
batch. At large row counts the batch write itself takes longer than the lookup.

## Decision

Set `maxHeaderSize: 50 MB` on the Node.js HTTP server to accommodate large connector state.
This is a conservative ceiling — typical headers remain small. The Google Sheets connector
may later move to sheet-based lookup, but the raised limit unblocks all connectors that
carry state in headers without requiring a protocol change.

## Future: `destination_state` message type

Currently only sources emit state (`source_state`). If we introduce a `destination_state`
message type, destinations could persist their own state (e.g., row mappings) through the
engine's state store — the same way sources do today. This would let the Google Sheets
connector store its row map without carrying it in the header or re-reading the sheet on
every batch. The engine would checkpoint `destination_state` alongside `source_state`,
and pass it back to the destination on the next sync via cursor input.
