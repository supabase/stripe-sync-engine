# Local Registries

The compose file includes a local npm registry for end-to-end publish testing. It lets you run the full publish → install → run loop without touching real registries.

## Why

`pnpm build` and `pnpm test` catch code errors, but not packaging errors. Things that only break after publishing:

- Missing files in the published tarball (`files` field in package.json)
- Broken `exports` map (works locally via workspace symlinks, fails after install)
- `workspace:*` dependency ranges not rewritten to real versions
- Docker image missing runtime dependencies or failing at startup
- `npx @stripe/sync-engine` not resolving its bin entry

Local registries catch all of these without side effects.

## npm Registry

A [Verdaccio](https://verdaccio.org/) instance for testing npm publish + npx install.

```sh
# Start
docker compose --profile npm-registry up -d npm-registry

# Publish all packages and smoke test
bash tests/e2e-publish.sh

# Stop
docker compose --profile npm-registry down
```

**Port:** `4873`
**API:** `http://localhost:4873`

The `.npmrc` at the repo root points `@stripe:registry` at `$STRIPE_NPM_REGISTRY`. Locally this is set to `http://localhost:4873` via `.envrc` (direnv). In CI it points to GitHub Packages.

The publish script (`tests/e2e-publish.sh`) publishes every workspace package, then verifies `npx @stripe/sync-engine --version`, `--help`, and `check` work from a clean temp directory — exactly as an end-user would experience it.

## Docker

Docker images are built locally with `docker build`. In CI, pushes to `main` and `v2` first publish a multi-arch image to `ghcr.io`, then the same tested image is promoted to Docker Hub (`stripe/sync-engine`) with the branch tag and `latest`.

```sh
# Build and test locally
docker build -t sync-engine:test .
bash tests/docker-test.sh sync-engine:test
```

## Compose profiles

The npm registry doesn't start with a bare `docker compose up`. You must opt in:

```sh
docker compose --profile npm-registry up -d npm-registry
```

This keeps `docker compose up` fast for everyday development (only starts postgres, stripe-mock, etc.).
