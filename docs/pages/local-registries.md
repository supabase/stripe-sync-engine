# Local Registries

The compose file includes local npm and Docker registries for end-to-end publish testing. They let you run the full publish → install → run loop without touching real registries.

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

# Publish all packages (rewrites workspace:* → real versions)
bash tests/e2e-verdaccio-publish.sh

# Stop
docker compose --profile npm-registry down
```

**Port:** `4873`
**API:** `http://localhost:4873`

The publish script (`tests/e2e-verdaccio-publish.sh`) publishes every workspace package in dependency order, then verifies `npx @stripe/sync-engine --help` works from a clean temp directory — exactly as an end-user would experience it.

CI runs this on every push.

## Docker Registry

An official [Docker Distribution](https://github.com/distribution/distribution) (`registry:2`) instance for testing Docker image builds.

```sh
# Start
docker compose --profile docker-registry up -d docker-registry

# Build, push, pull, run
docker build -t localhost:5050/sync-engine:test .
docker push localhost:5050/sync-engine:test
docker pull localhost:5050/sync-engine:test
docker run --rm localhost:5050/sync-engine:test --help

# Browse contents
curl http://localhost:5050/v2/_catalog
curl http://localhost:5050/v2/sync-engine/tags/list

# Stop
docker compose --profile docker-registry down
```

**Port:** `5050`
**API:** `http://localhost:5050/v2/`

Storage is ephemeral (container volume) — data disappears on `docker compose down`.

## Both registries use compose profiles

They don't start with a bare `docker compose up`. You must opt in:

```sh
docker compose --profile npm-registry up -d npm-registry
docker compose --profile docker-registry up -d docker-registry
```

This keeps `docker compose up` fast for everyday development (only starts postgres, stripe-mock, etc.).
