# TypeScript Configuration

## Target: `nodenext`

The repo uses `module: "nodenext"` with `moduleResolution: "nodenext"`. This is the most portable configuration — code works in Node, Bun, Deno, and bundlers (tsup/vite/esbuild) without modification.

The tradeoff: every relative import needs a `.js` extension, even though the source is `.ts`:

```ts
import { foo } from './foo.js' // Node ✓, Bun ✓, Deno ✓, tsup/vite ✓
import { foo } from './foo' // Node ✗, Bun ✓, Deno ✗, tsup/vite ✓
```

`nodenext` is the common denominator that works across all runtimes without a bundler.

### Comparison with alternatives

| Setting              | Runs without bundler  | Extensionless imports | Future-proof    |
| -------------------- | --------------------- | --------------------- | --------------- |
| `nodenext`           | Yes (Node, Bun, Deno) | No — requires `.js`   | Yes             |
| `esnext` + `bundler` | No — needs tsup/vite  | Yes                   | Tied to bundler |
| `commonjs`           | Node only             | Yes                   | Legacy          |

## Recommended tsconfig.json

```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "nodenext",
    "moduleResolution": "nodenext",

    "strict": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": false,
    "noEmit": true
  }
}
```

### Why each setting

| Setting                | Value      | Rationale                                                                                        |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `target`               | `esnext`   | Don't downlevel — Node 22+, Bun, Deno all support latest syntax                                  |
| `module`               | `nodenext` | Real Node ESM rules, works everywhere                                                            |
| `moduleResolution`     | `nodenext` | Implied by `module: nodenext`, but explicit is clearer                                           |
| `verbatimModuleSyntax` | `true`     | Replaces `isolatedModules` + `esModuleInterop`. Forces `import type` for type-only imports       |
| `isolatedModules`      | `true`     | Redundant with `verbatimModuleSyntax` but keeps esbuild/swc happy                                |
| `esModuleInterop`      | `false`    | `verbatimModuleSyntax` makes this unnecessary — write explicit `import * as` or `import default` |
| `noEmit`               | `true`     | Use tsc for type checking only, let tsup handle emit                                             |
| `skipLibCheck`         | `true`     | Don't typecheck `node_modules` — faster, avoids conflicts in third-party `.d.ts`                 |
| `declaration`          | `true`     | Generate `.d.ts` files for consumers                                                             |
| `declarationMap`       | `true`     | Enables go-to-definition into source from `.d.ts`                                                |

### Settings to avoid

| Setting                        | Why avoid                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `moduleResolution: "bundler"`  | Ties you to a bundler — code won't run directly in Node/Deno                                           |
| `allowImportingTsExtensions`   | Non-standard, only works in dev tooling                                                                |
| `allowSyntheticDefaultImports` | Papered over CJS/ESM mismatch — `verbatimModuleSyntax` is the real fix                                 |
| `resolveJsonModule`            | With `nodenext`, use import attributes instead: `import data from './data.json' with { type: 'json' }` |

## JSON imports

With `nodenext`, JSON imports use the standard import attributes syntax:

```ts
import data from './config.json' with { type: 'json' }
```

This is the TC39 standard that Node, Deno, and bundlers all support.
