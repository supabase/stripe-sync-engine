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
