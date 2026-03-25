# Publishing & Docker Packaging

How workspace packages get from source to published npm tarballs and Docker images.

## Three patterns for monorepo packaging

| Pattern               | What it does                                       | Who uses it                                 |
| --------------------- | -------------------------------------------------- | ------------------------------------------- |
| Publish each package  | Every workspace package → npm with its own version | tRPC, Drizzle, Effect-TS                    |
| Bundle workspace deps | tsup/esbuild inlines workspace code into one dist/ | Turborepo CLI, sync-engine apps             |
| `pnpm deploy`         | Copies one package + resolved node_modules         | Niche — Docker builds without full monorepo |

We use **bundle** for apps and **publish independently** for libraries.

## Dev vs publish: the publishConfig pattern

Workspace packages point `exports` at TypeScript source for development (no build needed with tsx/bun), and use `publishConfig` to override for npm publish:

```json
{
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts",
      "default": "./src/index.ts"
    }
  },
  "publishConfig": {
    "exports": {
      ".": {
        "types": "./dist/index.d.ts",
        "import": "./dist/index.js",
        "require": "./dist/index.cjs"
      }
    }
  }
}
```

- `pnpm install` uses the top-level `exports` → resolves to `src/` → live source, no build needed
- `pnpm publish` / `pnpm pack` applies `publishConfig` → resolves to `dist/`
- `pnpm deploy` does **not** apply `publishConfig` — it copies the dev layout as-is

The `"default"` condition is required alongside `"import"` because tsx's CJS resolver doesn't match the `"import"` condition.

### bin entries

Same pattern for `bin` — source files have `#!/usr/bin/env tsx` shebangs for dev, `publishConfig.bin` points to dist:

```json
{
  "bin": { "source-stripe": "./src/bin.ts" },
  "publishConfig": {
    "bin": { "source-stripe": "./dist/bin.js" }
  }
}
```

tsup preserves shebangs verbatim, so build scripts include a sed step:

```sh
tsup ... && sed -i '' 's|#!/usr/bin/env tsx|#!/usr/bin/env node|' dist/bin.js
```

## Why workspace deps are in devDependencies

`apps/sync-engine` uses tsup with `noExternal: [/^@stripe\//]`, which inlines all workspace package code into `dist/`. At runtime, there are no `require('@stripe/protocol')` calls — the code is compiled into the bundle.

Since these packages are build-time inputs (not runtime dependencies), they belong in `devDependencies`:

```json
{
  "dependencies": {
    "pg": "^8.16.3",
    "stripe": "^17.7.0",
    "hono": "^4"
  },
  "devDependencies": {
    "@stripe/protocol": "workspace:*",
    "@stripe/source-stripe": "workspace:*",
    "@stripe/stateless-sync": "workspace:*"
  }
}
```

This means `npm install --omit=dev` (or `pnpm install --prod`) only installs third-party packages. Consumers of the published package never download workspace internals.

This is the same pattern Turborepo uses for its bundled CLI.

## Docker: hybrid approach

The challenge: tsup bundles workspace code, but third-party dependencies (`pg`, `stripe`, `hono`) still need to be installed at exact lockfile-pinned versions. Plain `npm install` resolves from version ranges, which may differ from what `pnpm-lock.yaml` pins.

Library packages must keep version ranges (not exact pins) so consumers can deduplicate — `"zod": "^4.3.6"` lets a consumer using `zod@4.5.0` avoid two copies. But ranges mean `npm install` without a lockfile isn't reproducible.

The solution is a hybrid: `pnpm deploy` for lockfile-pinned `node_modules/`, tsup `dist/` for bundled workspace code:

```dockerfile
FROM node:24-slim AS build
WORKDIR /app
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter @stripe/sync-engine run build
RUN pnpm --filter @stripe/sync-engine deploy --prod /deploy

FROM node:24-slim
WORKDIR /app
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /app/apps/sync-engine/dist ./dist
COPY --from=build /deploy/package.json ./
CMD ["node", "dist/cli.js"]
```

What each piece provides:

| Layer           | Source               | Why                                                       |
| --------------- | -------------------- | --------------------------------------------------------- |
| `dist/`         | tsup build           | Workspace code bundled, no `@stripe/*` imports at runtime |
| `node_modules/` | `pnpm deploy --prod` | Third-party deps at exact lockfile versions               |
| `package.json`  | `pnpm deploy`        | Metadata only (no workspace refs)                         |

What's **not** in the image: source files, pnpm, workspace structure, devDependencies, `@stripe/*` packages.

### Why not the alternatives?

**Copy whole monorepo + `pnpm install --frozen-lockfile`:**

- Must enumerate every workspace `package.json` in Dockerfile for layer caching
- Every new package = Dockerfile edit
- Any `package.json` change in any package busts the install cache
- Needs pnpm in the runtime image

**`pnpm deploy` alone (without tsup bundling):**

- Copies workspace packages into `node_modules/@stripe/*` with source files
- `publishConfig` not applied → exports point to `src/`, needs tsx in production
- 173MB artifact vs ~5MB for bundled dist/

**`npm install` with pinned versions (no lockfile):**

- Works for apps but breaks library deduplication
- Libraries need ranges (`^4.3.6`), apps could pin, but mixing is confusing

## Verdaccio e2e testing

The full publish → install → run loop is tested locally using Verdaccio. See [local-registries](./local-registries.md) for setup.

The publish test verifies:

- `publishConfig` is applied (exports → dist/, bin → dist/)
- `workspace:*` rewritten to real versions
- `npx @stripe/sync-engine --help` works from a clean install
- No `@stripe/*` workspace packages in published `dependencies`
