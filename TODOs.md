---

TODO:

- [ ] Make it easier for testing, source stripe, dest-test
  - [ ] Selective sync
  - [ ] Selective backfill

## Success critiera

- [ ] Stateless CLI End to end test of stripe -> postgres sync
  - [ ] Backfill
  - [ ] Update product
  - [ ] Check live event update worked
- [ ] End to end supaabase
- [ ] Install
- [ ] Backfill
- [ ] check sync status is successful
- [ ] Update product
- [ ] Check live event update worked
- [ ] Uninstall

##

- [ ] Add how we allow for indexs and RLS to be possible in destination postgres
- [ ] Secret store for supabase, how do we use that? integrate with env based one?
- [ ] Better rate limit
- [ ] How do we manage fan in?
- [ ] Inngest, how does a generic one work and does it help us?
- [ ] Make it possible to install on non-stripe schema
- [ ] Global state rather than stream state
- [ ] Status reporting in the Supabase ui (ideally live)
  - [ ] Parsing the state properties on the sync object
- [ ] Figure out packaging for Supbase, packaging in particular

- [ ] one webhook, multiple stripe sources
