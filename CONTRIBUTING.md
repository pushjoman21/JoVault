# Contributing

Use Node.js >=24.11.0 <25 and the pinned npm lockfile. CI selects Node.js 24.11.1.
Run from the repository root:

```sh
npm ci
npm run check
npm run quality:repo
npm run format:check
npx playwright install chromium
npm run test:jovault:browser
```

The browser test requires Chromium. Engine-enabled tests require the four reviewed
Boa asset settings described in [the guide](docs/USAGE.md); leaving them unset exercises
the register path and reports the conditional engine check as skipped. The CI
workflow builds and audits the engine before enabling signed engine integration.
See [engine build instructions](engine-probe/README.md) for pinned Rust 1.98.1,
verified patches and the bounded conformance runner.

Keep TypeScript strict, ESM import suffixes and explicit resource limits. Preserve
tests and source provenance when exporting code. Format only changed files and
report the exact commands and outcomes. General JavaScript compatibility requires
conformance evidence; a successful example does not establish full support.
