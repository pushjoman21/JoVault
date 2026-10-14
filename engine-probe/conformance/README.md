# Test262 module checkpoint profile

This portable packet contains all 117 candidates from the reviewed synchronous
Module profile at tc39/test262 commit
`d53ebc8b1931d9f1541e43d59650776e4b766248`. The complete inventory contains 53,616
standalone tests; 53,499 remain NOT_RUN by this profile. Exclusions do not imply
that a test is outside ECMAScript 2025. This packet does not establish whole-suite or
edition coverage.

The historical execution of these unchanged cases against WASM SHA-256
`a1a9d88be58cd2c3f4fa21903e061814f8718d9dee156f98f4c321c1a289d8a8`
passed all 14 runner controls and produced 116 PASS, 1 FAIL. The retained failure
is `test/language/module-code/eval-export-dflt-expr-cls-name-meth.js`: a parenthesized
default class expression lost its callable static `name()` method. A proposed engine
fix requires a new actual build and execution; this packet does not claim it passed.
The historical report and frozen twelve-case packet remain unchanged.

## Run

Place this directory at `engine-probe/conformance/`. Use Node with built-in modules
only. Check out the exact official Test262 pin separately, then run:

```sh
node verify-cases.mjs --source-root /path/to/official/test262
node runner.mjs --output NEW-report.json
```

The default WASM path is
`../target/wasm32-unknown-unknown/release/jovault_boa_snapshot_probe.wasm`, resolved
relative to this directory. Override with `--wasm /path/to/file.wasm`. An explicit
new output file is mandatory; existing output files are never overwritten. Run the
verifier before executing the runner. It checks the official Git pin, all 117 test
entries, 181 unique original module files, two original harness Scripts, original
source bytes and SHA-256 hashes, support hashes, exact synthetic drivers, metadata,
profile selections and the upstream license. It does not execute guest JavaScript.

The runner executes the same 14 controls once as a gate, then every selected case.
Counts derive from `profile.selectedLimit` and must match both cases and classification.
Each job compiles original harness sources as separate ordered global Scripts in the
same realm, compiles the unchanged Module graph with a separate importing driver,
zeros the raw input, checkpoints, and restores into a fresh WASM instance before
invocation. The five-second external worker deadline applies to each job. Failed
controls gate every case explicitly as NOT_RUN or BLOCKED_ABI. No test or harness
source is evaluated natively by Node; no case is dropped on failure.

The INPUT1 engine ABI must support ordered global Scripts with original global
bindings and strictness, one-time initialization, failure latching, typed results,
bounded input and finite execution fuel. A same-build memory checkpoint is trusted
experimental state, not a portable or untrusted bytecode package. Compile-call
counters do not prove absence of internal lazy compilation. Browser execution,
asynchronous cases, Script-goal tests, negative tests and additional harness/host
features are outside this particular profile.

## Provenance

`cases.json` preserves original test/dependency/harness source and hashes plus exact
per-entry flags, features, includes and negative metadata. Allowed flags are the
reviewed `module` and `generated`; flags still must match pinned source metadata.
`classification-summary.json` preserves the full original inventory denominator and
exclusion counts. Its execution field describes classification before execution;
actual outcomes belong only to a newly generated runner report.

The original Test262 copyrights remain in source strings. `LICENSE.test262` is the
exact upstream license. Classification used the pinned official metadata parser and
a reviewed feature/path allowlist; the large private inventory is not needed to run
this portable packet. No dependency installation or guest-source evaluation is
required for input verification.
