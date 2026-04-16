# Stripe Schema Visualizer

This package contains the standalone browser UI for exploring generated Stripe schema data with PGlite.

The visualizer has two parts:

- `pnpm explorer:build` generates static artifacts.
- `apps/visualizer` loads those artifacts into PGlite and lets you run SQL in the browser.

## Generated artifacts

- `apps/visualizer/public/explorer-data/bootstrap.sql`
- `apps/visualizer/public/explorer-data/manifest.json`

These files are generated and should stay out of version control.

## Common commands

```bash
pnpm explorer:build
pnpm visualizer
pnpm visualizer:with-data
```

`pnpm visualizer:with-data` rebuilds the explorer data and then starts the visualizer app.

## How the app loads data

At runtime, the app loads `manifest.json` first and then hydrates PGlite from `bootstrap.sql`.
After hydration, all SQL runs locally in the browser against the generated Stripe schema.

## Direct phase debugging

`pnpm explorer:build` is the normal command, but the underlying phase scripts still exist for debugging:

```bash
bun run scripts/explorer-harness.ts start
bun run scripts/explorer-migrate.ts --api-version=2020-08-27
bun run scripts/explorer-seed.ts --api-version=2020-08-27 --seed=42
bun run scripts/explorer-export.ts
bun run scripts/explorer-harness.ts stop
```

## Notes

- SQL bootstrap is preferred for speed and consistency.
- The build pipeline recreates the artifacts from scratch on each run.
- The deploy/install dashboard stays in `packages/dashboard`; this package only contains the schema visualizer UI.
