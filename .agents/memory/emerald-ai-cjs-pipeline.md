---
name: Emerald AI CJS pipeline in ESM monorepo
description: How to host the CJS pipeline JS files inside the ESM api-server without rewriting them.
---

The pipeline modules (pipeline.js, claude-client.js, social-er.js, etc.) are CommonJS. The api-server package has `"type": "module"` in its package.json, which makes esbuild treat all `.js` files as ESM and refuse `module.exports`.

**Fix**: place a `package.json` with `{ "type": "commonjs" }` inside `artifacts/api-server/src/pipeline/`. This overrides the parent `"type": "module"` for that subdirectory. esbuild respects nested package.json type fields when bundling.

**Why**: renaming to `.cjs` breaks all the internal `require('./other-module')` calls without extension; converting to ESM means rewriting hundreds of `require`/`module.exports` across ~12 files. The nested package.json is a one-line fix with zero code changes.

**How to apply**: any time CJS source files must live inside an ESM pnpm workspace package, drop `{ "type": "commonjs" }` into a `package.json` in their subdirectory before running esbuild.

Also: the graphs/ subdirectory (`action-matrix-graph.js`, `exec-summary-graph.js`, `social-sentinel-graph.js`) must be copied alongside the top-level pipeline files — they are lazy-required at runtime with `require('./graphs/...')`.
