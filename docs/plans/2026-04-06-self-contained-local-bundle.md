# Self-Contained Local Bundle

## Context

Today, running sync-engine locally requires separately managing multiple processes:
a Temporal server (Docker or CLI), the service API, the worker, and optionally the
dashboard. Users must install dependencies, configure ports, and manage state across
scattered locations. The goal is a single `npx @stripe/sync-app` (or installed
binary) that starts everything as subprocesses of one supervisor, with all state
persisted to `~/.stripe-sync` by default.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Supervisor / Daemon Process                    │
│  (entry point: `stripe-sync start`)             │
│                                                 │
│  ┌──────────────┐  ┌────────────────────────┐   │
│  │ Temporal      │  │ Service API            │   │
│  │ Dev Server    │  │ (Hono on random port)  │   │
│  │ (SQLite)      │  │                        │   │
│  │ random port   │  │ /pipelines, /health    │   │
│  └──────┬───────┘  └────────┬───────────────┘   │
│         │                   │                    │
│  ┌──────┴───────┐  ┌───────┴────────────────┐   │
│  │ Service       │  │ Dashboard              │   │
│  │ Worker        │  │ (static files served   │   │
│  │ (connects to  │  │  by API or standalone) │   │
│  │  Temporal)    │  │ random port            │   │
│  └──────────────┘  └────────────────────────┘   │
│                                                 │
│  All state: ~/.stripe-sync/                     │
│  ├── temporal.sqlite    (workflow history)       │
│  ├── pipelines/         (pipeline configs)       │
│  ├── engine.pid         (supervisor PID)         │
│  └── ports.json         (allocated ports)        │
└─────────────────────────────────────────────────┘
```

## Components

### 1. Temporal Server (embedded)

- Use `@temporalio/testing`'s `TestWorkflowEnvironment.createLocal()` with
  `dbFilename: ~/.stripe-sync/temporal.sqlite`
- Downloads the Temporal CLI binary on first run, caches it automatically
- Binds to a random free port
- No Docker, no external install required
- **Verified**: this works today — SQLite persistence confirmed

### 2. Service API (`apps/service`)

- Hono HTTP server on a random port
- Pipeline CRUD, webhook ingestion, health checks
- `--data-dir ~/.stripe-sync/pipelines` for pipeline config storage (already defaults here)
- Connects to the embedded Temporal server's address

### 3. Service Worker (`apps/service`)

- Temporal worker that polls the embedded server
- Runs workflows (`pipelineWorkflow`, `googleSheetPipelineWorkflow`)
- Executes activities (engine calls, status updates, Google Sheets read/write)
- Same process or child process of the supervisor

### 4. Engine

- Not a separate process — the worker calls the engine library in-process
  (or via HTTP to a local engine server if subprocess isolation is preferred)
- For the bundled mode, in-process is simplest

### 5. Dashboard (`apps/dashboard`)

- Pre-built static assets (Vite output) served by the API server or a
  lightweight static file server on a random port
- Points at the API server's address
- Opens in browser on `stripe-sync start`

## Process Supervision: Native OS Integration

**Principle:** Don't reimplement process supervision in Node.js — delegate to the OS's
native supervisor (launchd on macOS, systemd on Linux). These are battle-tested, handle
restart-on-crash, log routing, and boot integration out of the box.

### How it works

`stripe-sync start` is an **installer/orchestrator**, not a long-running supervisor:

1. Ensures `~/.stripe-sync/` exists
2. Generates per-process service configs:
   - **macOS:** launchd plists → `~/Library/LaunchAgents/com.stripe.sync.{name}.plist`
   - **Linux:** systemd user units → `~/.config/systemd/user/stripe-sync-{name}.service`
3. Registers services with the OS in dependency order:
   - Start Temporal → health-check poll → start API → start worker → start dashboard
4. Writes `ports.json` with allocated ports
5. Prints URLs to stdout
6. Exits (the OS keeps the services running)

`stripe-sync stop` unloads/stops all services in reverse order.

### What the OS provides for free

| Capability          | launchd (macOS)                         | systemd (Linux)           |
| ------------------- | --------------------------------------- | ------------------------- |
| Restart on crash    | `KeepAlive: true`                       | `Restart=always`          |
| Restart throttle    | `ThrottleInterval: 10`                  | `RestartSec=5`            |
| Log routing         | `StandardOutPath` / `StandardErrorPath` | `journalctl --user-unit`  |
| Start on login      | `RunAtLoad: true`                       | `WantedBy=default.target` |
| Dependency ordering | Sequential bootstrap                    | `After=` / `Requires=`    |
| Process cleanup     | Automatic (no orphan zombies)           | Automatic (cgroup)        |

### Service definitions

Each component gets its own service config. Example launchd plist (generated, not hand-written):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ...>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.stripe.sync.temporal</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/node</string>
    <string>/path/to/stripe-sync-temporal.js</string>
    <string>--data-dir</string>
    <string>~/.stripe-sync</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>~/.stripe-sync/logs/temporal.log</string>
  <key>StandardErrorPath</key><string>~/.stripe-sync/logs/temporal.err</string>
</dict>
</plist>
```

Equivalent systemd unit:

```ini
[Unit]
Description=Stripe Sync - Temporal Server
After=network.target

[Service]
ExecStart=/path/to/node /path/to/stripe-sync-temporal.js --data-dir ~/.stripe-sync
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

### Implementation: ~200 lines of Node.js

The custom code is thin — it generates config files and calls OS commands:

```typescript
interface ServiceDef {
  name: string // e.g. 'temporal', 'api', 'worker', 'dashboard'
  script: string // path to the entry point JS file
  args: string[] // CLI args
  env: Record<string, string> // environment variables (ports, addresses)
  dependsOn?: string[] // health-check these before starting
  healthCheck?: string // URL to poll for readiness
}

// macOS: generate plist XML via string template, write to ~/Library/LaunchAgents/,
//        call `launchctl bootstrap gui/<uid> <plist-path>`
// Linux: generate .service unit via string template, write to ~/.config/systemd/user/,
//        call `systemctl --user enable --now <unit>`
```

No PM2, no node-mac, no external process manager. Plist XML and systemd units are
simple enough to generate with template strings — zero dependencies.

### Startup sequencing

Since launchd has no built-in dependency graph (unlike systemd's `After=`), the
`stripe-sync start` command handles ordering:

1. Bootstrap `com.stripe.sync.temporal`
2. Poll `http://localhost:<port>/health` until ready (timeout 30s)
3. Bootstrap `com.stripe.sync.api` (with `TEMPORAL_ADDRESS` env var)
4. Poll API health endpoint
5. Bootstrap `com.stripe.sync.worker`
6. Bootstrap `com.stripe.sync.dashboard`

On Linux, systemd's `After=` + `ExecStartPre=` health-check handles this natively.

### Graceful shutdown order

`stripe-sync stop`:

1. `launchctl bootout` / `systemctl --user stop` worker (drains in-flight activities)
2. Stop API server
3. Stop dashboard
4. Stop Temporal server (flushes SQLite)
5. Optionally: `launchctl bootout` to deregister (or keep registered for next login)

## CLI Interface

```
stripe-sync start [--data-dir ~/.stripe-sync] [--port 4200]
  Start all services. If --port is given, use it for the API; others random.

stripe-sync stop
  Read PID from ~/.stripe-sync/engine.pid, send SIGTERM.

stripe-sync status
  Show running processes, ports, pipeline count.
```

## State Layout

```
~/.stripe-sync/
├── temporal.sqlite        # Temporal workflow history + visibility
├── pipelines/             # Pipeline config JSON files (FS store)
│   ├── pipe_abc123.json
│   └── pipe_def456.json
├── engine.pid             # Supervisor PID for `stripe-sync stop`
├── ports.json             # { temporal: 7233, api: 4200, dashboard: 4201 }
└── logs/                  # Optional structured logs
    ├── api.log
    └── worker.log
```

## Distribution

### npm

```sh
npm install -g @stripe/sync-engine
stripe-sync start
```

The package includes:

- Compiled JS (service API, worker, engine, dashboard static assets)
- `@temporalio/worker` + platform-specific `@temporalio/core-bridge-*` (auto-resolved by npm)
- `@temporalio/testing` for embedded Temporal server (downloads CLI binary on first run)

No Docker. No Go install. No Java. Just Node.js 24+.

### What gets downloaded on first run

- Temporal CLI binary (~50MB) — cached in OS temp dir by `@temporalio/core-bridge`
- Everything else is in the npm package

## Open Questions

1. ~~**In-process vs subprocess for worker**~~ → **Resolved: separate processes.**
   Each component is its own OS-managed service. Crash isolation is free.

2. **Kafka for Google Sheets**: The queue-based Sheets workflow currently depends on
   Kafka. For a self-contained bundle, options:
   - Replace Kafka with an in-memory or SQLite-backed queue
   - Use the Temporal activity queue itself (no separate message broker)
   - Make Kafka optional (only needed for Sheets destinations)

3. **`@temporalio/testing` in production**: The `TestWorkflowEnvironment` API works
   but is named/documented for testing. We may want to use the underlying
   `runtime.createEphemeralServer()` directly rather than the test wrapper.

4. **Dashboard build**: Should the npm package include pre-built dashboard assets,
   or build them on first run? Pre-built is simpler and faster.

5. **Port persistence**: Should we reuse the same ports across restarts (via
   `ports.json`) or always pick fresh random ports? Fixed ports are more
   predictable for bookmarks/scripts.

6. **Log rotation**: launchd/systemd write logs but don't rotate them. Options:
   - macOS: configure `newsyslog` via `/etc/newsyslog.d/`
   - Linux: systemd journal handles rotation automatically
   - Or: each service entry point rotates its own log on startup if >10MB

## Implementation Order

1. Supervisor process with Temporal server + SQLite
2. Wire up service API as child process
3. Wire up service worker as child process
4. Serve dashboard static assets
5. CLI commands (`start`, `stop`, `status`)
6. npm packaging and `bin` entry point
