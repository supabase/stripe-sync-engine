# Auto Publish Fixes

## Problem

The npmjs auto-publish flow has three correctness gaps:

1. It treats any version mismatch as publishable, including older local versions.
2. It can promote stale artifacts because it no longer waits for GitHub Packages and does not request an exact package version.
3. It converts every npm publish failure into a warning, which can hide real release failures.

## Plan

1. Gate npmjs publishing on a strict semver increase over the current npmjs version.
2. Restore the dependency on the GitHub Packages publish job and pass the checked-in release version into the promotion script.
3. Update the promotion script to request exact package versions when provided and only tolerate known "already published" failures.

## Verification

1. Run targeted shell validation for the promotion script with mocked npm/curl responses.
2. Inspect the workflow diff to confirm the publish gate and job dependencies match the intended release flow.

## TODO: Switch to npm Trusted Publishing (OIDC)

The current flow uses a long-lived `NPM_TOKEN` secret for publishing to
npmjs.org. This should be replaced with npm's [trusted publishing][tp]
(also called "provenance" or OIDC publishing), which:

- Eliminates stored npm tokens entirely — GitHub Actions gets a
  short-lived OIDC token from npm on each run.
- Adds provenance attestation to published packages (visible on npmjs.org).
- Removes the risk of leaked/expired tokens breaking publishes.

Steps to migrate:
1. Link each `@stripe/sync-*` package to the GitHub repo in npm's
   trusted publishing settings.
2. Add `permissions: id-token: write` to the `publish_npmjs` job.
3. Use `npm publish --provenance` instead of token-based auth.
4. Remove the `NPM_TOKEN` secret from the repo.

[tp]: https://docs.npmjs.com/generating-provenance-statements
