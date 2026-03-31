# Quality Scorecard

Per-package status at a glance. Update this when adding tests, types, or docs to a package.

| Package                     | Unit Tests | Integration Tests       | Types (declaration) | Docs                                          |
| --------------------------- | ---------- | ----------------------- | ------------------- | --------------------------------------------- |
| `protocol`                  | -          | -                       | Y                   | [protocol.md](/engine/protocol.html)          |
| `source-stripe`             | Y          | Y                       | Y                   | [ARCHITECTURE.md](/engine/ARCHITECTURE.html)  |
| `destination-postgres`      | Y          | Y                       | Y                   | [ARCHITECTURE.md](/engine/ARCHITECTURE.html)  |
| `destination-google-sheets` | -          | -                       | Y                   | -                                             |
| `state-postgres`            | -          | -                       | Y                   | [packages.md](/architecture/packages.html)    |
| `util-postgres`             | -          | -                       | Y                   | [packages.md](/architecture/packages.html)    |
| `openapi`                   | -          | -                       | Y                   | -                                             |
| `ts-cli`                    | -          | -                       | Y                   | -                                             |
| `apps/engine`               | Y          | Y                       | Y                   | [ARCHITECTURE.md](/engine/ARCHITECTURE.html)  |
| `apps/service`              | -          | -                       | Y                   | [ARCHITECTURE.md](/service/ARCHITECTURE.html) |
| `apps/supabase`             | Y          | -                       | Y                   | -                                             |
| `e2e`                       | -          | Y (conformance, layers) | -                   | -                                             |

**Legend:** Y = present, - = missing/not applicable
