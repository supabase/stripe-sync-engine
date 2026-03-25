---

TODO:

- [ ] Make it easier for testing, source stripe, dest-test
  - [ ] Selective sync
  - [ ] Selective backfill

- [ ] one webhook, multiple stripe sources

## Success critiera

- [ ] Stateless CLI End to end test of stripe -> postgres sync
  - [ ] Backfill
  - [ ] Update product
  - [ ] Check live event update worked
- [ ] Make it possible to install on non-stripe schema?

## SUpabase

- [ ] End to end supaabase
  - [ ] Install
  - [ ] Backfill
  - [ ] check sync status is successful
  - [ ] Update product
  - [ ] Check live event update worked
  - [ ] Uninstall

- [ ] Status reporting in the Supabase ui (ideally live)
  - [ ] Parsing the state properties on the sync object
- [ ] Figure out packaging for Supbase, packaging in particular
- [ ] Remove esbuild/`?raw` bundling — now that all packages are published to npm, edge functions can use `npm:@stripe/sync-source-stripe@0.1.0` imports directly. Deno resolves them at runtime, no build-time bundling needed. Template version numbers at deploy time. Eliminates esbuild from the repo entirely.

## Replit

- [ ] Add skills file. Ensure package works well on Replit

##

- [ ] Better rate limit
- [ ] Global state rather than stream state
- [ ] How do we manage fan in?

- [ ] Secret store for supabase, how do we use that? integrate with env based one?
- [ ] Add how we allow for indexs and RLS to be possible in destination postgres
- [ ] Inngest, how does a generic one work and does it help us?
- [ ] Create input queue? What's up with that?

- [ ] Test credential refreshing how
