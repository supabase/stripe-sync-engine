---
title: CLI Design Lessons
---

# CLI Design Lessons

Learnings from studying a mature production CLI (Go + Cobra over a REST API) and
from building sync-engine's own CLI. Applicable to future CLI and API design.

## API first, CLI second

The CLI should be a **thin client over the API**, not the other way around. When
the API defines the contract, CLI commands can be generated from the OpenAPI spec
— new endpoints get CLI support for free. If the CLI drives the API shape, you
end up with endpoints that only make sense as "CLI backends" while other
consumers (SDKs, dashboards, agents) suffer.

**Where CLI-first thinking is still valuable:** prototyping workflows exposes
ergonomic gaps in the API. If the CLI feels painful, the API probably has a
modeling problem. Use CLI friction as a feedback signal, not a design driver.

## Two kinds of commands

1. **Workflow commands** — orchestrate multiple steps, manage local state, provide
   progress output. These are hand-written. Examples: `sync`, `check`, `serve`.
2. **Resource commands** — mechanical CRUD over a single API resource, auto-generated
   from the OpenAPI spec. Coverage without hand-coding.

sync-engine's CLI today is all workflow commands. If we add resource management
(create credential, list syncs) the generated layer applies.

## Connector protocol as the plugin interface

Our "plugin system" is connectors speaking NDJSON on stdin/stdout. No gRPC, no
manifest, no checksums — just a binary that implements a set of subcommands.

```
engine → spawn('source-stripe read --config ...')
       → stdout: NDJSON messages
       → stdin:  NDJSON input (for write or live events)
```

**Subcommands every connector implements:**

| Subcommand           | Description                               |
| -------------------- | ----------------------------------------- |
| `spec`               | Return JSON Schema for the config         |
| `check --config`     | Validate credentials, return CheckResult  |
| `discover --config`  | Return available streams (sources only)   |
| `read --config ...`  | Stream records/state to stdout            |
| `write --config ...` | Consume records from stdin, stream output |
| `setup` / `teardown` | Optional lifecycle hooks                  |

This is simpler than gRPC-based plugin systems and language-agnostic — any
binary that speaks the protocol works. Multi-word commands like
`"npx @stripe/source-stripe"` are split on whitespace at spawn time, so
connectors don't need to be local binaries.

## Connector discovery

Resolution order when the engine needs a connector:

1. **Registered** — in-process, passed at startup. Always checked first.
2. **commandMap** — explicit name→command mapping (`--connectors-from-command-map`).
3. **path** — binary matching `source-<name>` in `node_modules/.bin` or `PATH`.
4. **npm** — `npx @stripe/source-<name>` auto-download (opt-in, off by default).

All three dynamic strategies produce a command string and spawn the same way.
See [Connector Loading](./engine/connector-loading.md) for full details.

## Practical concerns

- **Fail loudly on unknown connectors.** Return a clear "not found" error that
  tells the user what to install. Silently downloading code is a security risk;
  npm auto-download (`--connectors-from-npm`) is opt-in for this reason.
- **Path strategy defaults on.** Connectors installed in `node_modules` or on
  `PATH` are discovered automatically — zero config for the common case.
- **Process isolation is free.** Each subprocess resolves its own `node_modules`,
  so pnpm strict mode and connector dependency conflicts are non-issues.
- **Release pipeline matters.** Manual connector releases are brittle. Invest in
  CI-powered releases early.

## Design heuristics

1. **If it orchestrates a workflow, hand-write it.** Multi-step operations deserve
   purpose-built commands with progress output and error recovery.
2. **If it's a resource operation, generate it.** Don't hand-write CRUD commands
   once you have an OpenAPI spec.
3. **If it's optional or external, make it a connector.** Keep the core binary
   focused on the engine and protocol; defer connector logic to subprocesses.
4. **Design for the protocol, not the transport.** `source.read() → destination.write()`
   works locally, over HTTP, or in a workflow orchestrator. Keep the interface
   clean and the transport is swappable.
5. **Let the CLI prototype the API.** Build the CLI command first to validate the
   workflow, then extract the clean API, then optionally generate the CLI from it.
