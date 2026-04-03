# Google Sheets Row-Index Workflow

## Context

The Google Sheets destination needs upsert behavior for repeated Stripe objects.
When the same object is seen again in a later sync, we want to overwrite the
existing row instead of appending a duplicate.

Google Sheets does not provide native upsert semantics, and the destination
connector is intentionally stateless. It can read and write sheets, but it has
nowhere to persist "record X was previously written to row Y".

That row mapping has to live somewhere durable outside the destination.

## Constraints

- The Google Sheets destination must remain stateless.
- We do not want to store Google-Sheets-specific metadata in
  `packages/protocol`.
- We want to keep the Kafka-backed read/write split used by the service.
- The generic pipeline workflow should stay simple for destinations that do not
  need row-index bookkeeping.
- Any solution has to survive workflow replay, retries, and continue-as-new.

## Why the generic workflow was not enough

The existing `pipelineWorkflow` keeps a single source checkpoint and assumes the
destination can consume records without extra destination-specific durable
state.

That assumption breaks for Sheets:

- source progress and row-index progress are not the same thing
- writes may lag reads, so source checkpoints cannot be advanced optimistically
- row assignments must survive workflow restarts and continue-as-new
- this logic only applies to one destination type

Trying to fold all of that into the generic workflow would add Google
Sheets-specific state and branching to the default path used by every other
destination.

## Decision

Use a dedicated Temporal workflow for `google-sheets` pipelines.

This workflow owns the Sheets-specific durable state:

- `sourceState`: committed source checkpoint, only advanced after successful
  writes
- `readState`: optimistic read cursor used while backfilling or processing
  events
- `rowIndex`: `stream -> serialized primary key -> sheet row number`
- `catalog`: discovered stream metadata used to derive row keys

The generic workflow remains unchanged for non-Sheets destinations.

## Why workflow state is the right place

Workflow state is the only place in the current architecture that satisfies all
requirements at once:

- durable across retries and worker restarts
- local to the specific pipeline
- not exposed in the wire protocol
- safe to carry through `continueAsNew`
- able to coordinate source progress with destination progress

This keeps connector isolation intact. The destination still only consumes
records and emits output messages. It does not learn about Temporal, Kafka, or
state storage.

## Kafka stays in the design

We considered bypassing the queue for Sheets, but kept Kafka for consistency
with the service's existing read/write split.

The dedicated Sheets workflow still uses:

1. `readIntoQueueWithState` to read from the source and enqueue ordered
   `record` and `state` messages.
2. `writeGoogleSheetsFromQueue` to consume from Kafka, compact duplicate record
   updates by key, inject known row numbers, and write to the destination.

This preserves the operational model already used by the service while letting
Sheets add destination-specific bookkeeping on top.

## Data flow

### Read side

- discover the configured catalog
- derive a stable `_row_key` from the stream primary key
- enqueue `record` and `state` messages to Kafka in source order
- update `readState` optimistically as source state messages arrive

### Write side

- consume a batch from Kafka
- compact duplicate records by `(stream, _row_key)` within the batch
- if the workflow already knows the row, inject `_row_number`
- send the records to the Google Sheets destination
- parse destination-emitted row assignments for newly appended rows
- merge those row assignments into `rowIndex`
- advance `sourceState` only after the write succeeds

## Why `_row_key` and `_row_number` stay local to the Sheets workflow

These fields are still needed on the write side:

- `_row_key`: stable identifier derived from the stream primary key
- `_row_number`: known row number for updates

But the generic engine write path should not know about them. To keep that
boundary intact, the dedicated Sheets write activity calls the Sheets
destination directly instead of routing through the generic engine `/write`
pipeline.

Inside that activity we:

- take the workflow-owned discovered catalog
- add the two Sheets-only metadata fields to a local copy of the catalog
- run catalog enforcement there
- pass the filtered records to the Sheets destination

That keeps `_row_key` and `_row_number` as internal workflow transport
metadata, not engine-wide protocol behavior. The destination still strips them
before writing visible sheet cells.

## Why the destination reports row assignments

For new rows, the workflow does not know the final row number ahead of time.
The destination is authoritative because the sheet itself decides where appended
rows land.

After appending, the destination emits structured metadata describing the row
assignments it observed. The workflow merges that into `rowIndex` and uses it on
future writes.

This keeps the destination stateless while still making it the source of truth
for the exact append result.

## API guardrails

A Sheets pipeline's `rowIndex` is tied to a specific spreadsheet.

Changing a live pipeline to point at a different spreadsheet would silently
reuse stale row mappings and corrupt writes. Because of that, changing the
target spreadsheet now requires recreating the pipeline.

This is intentionally strict.

## Alternatives considered

### Store row numbers in `packages/protocol`

Rejected because it would leak Google-Sheets-specific behavior into the shared
wire format and make connector isolation worse.

### Let the destination persist its own mapping

Rejected because the destination is intentionally stateless and has no access to
durable storage.

### Reuse the generic workflow with destination-type conditionals

Rejected because it pushes one destination's durability requirements into the
default path used by all destinations.

### Make row number the primary key directly

Rejected because row numbers are not stable source identifiers. They are derived
write locations that only become known after the destination has written data.
The stable key must come from the source primary key, not from the sheet.

## Operational risks

- manual row deletion or row reordering in the sheet can invalidate `rowIndex`
- the dedicated workflow adds another workflow type to service operations
- Kafka consumption still needs end-to-end coverage beyond unit and package
  tests

These are acceptable for now because the alternative was to embed Sheets
complexity into the generic pipeline path.

## Outcome

The implementation in PR #228 adds a dedicated Google Sheets workflow that
preserves connector isolation, keeps Kafka in the service design, stores the
minimum extra durable state needed to make row-based upserts work, and keeps
Sheets-only metadata out of the generic engine write path.
