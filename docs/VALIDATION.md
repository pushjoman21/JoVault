# JoVault foundation validation

State: 2026-10-14. This records the bounded `JOVLT-R0` foundation, optional signed
Boa checkpoint path, and separate conformance experiments. Results apply to their
recorded source/image state, not complete ECMAScript compatibility or certification.

## What is exercised

Permanent tests cover primitive operations, signed zero, computed `NaN`/infinities,
ordered calls, short-circuit evaluation, block bindings, explicit syntax rejection,
register argument windows and return destinations, malformed artifacts, expiry,
resource budgets and input snapshots. Native module-loader tests compare named,
default and aliased exports, live imported functions and one-line/2,109-line modules.
The internal expression-IR interpreter remains a test reference only. The shipped
CLI and public R0 entry use the register interpreter. The demo defaults to R0 and
can explicitly select the configured Boa checkpoint path.

The local browser demo was exercised in Chromium at 1440 and 375 pixels, including
reduced motion, keyboard focus, output switching, disclosure controls, invalid
syntax/arguments, source invalidation and print output. Both executions returned
`1368905075` for its default example and arguments `[123]`. A native infinite loop
was terminated by the page's two-second timer; the VM returned `STEP_LIMIT`.
Worker probes confirmed blocked fetch and nested worker execution while the normal
module worker loaded successfully. Screenshots and original logs remain in the
private task run `jovault/20261014-01`; they contain no production measurements.

## Current check status

The reviewed main revision `45b41ad` completed CI with 645 Node passes, zero failures,
and one explicitly optional Sentry Python-reference skip out of 646 tests. The
skip requires `JOVM_PYTHON` and is not counted as passed. Its browser suite passed
99 tests. The same run passed Rust, repository/build, dependency/license, container,
and public-package checks. These results concern that revision. The later local
checkpoint integration passed its aggregate `npm run check`: strict TypeScript,
668 Node tests with zero failures or skips, and nine Rust tests. The configured
two-test Chromium integration run also passed without skips. The original logs
remain in the private task run `jovault/20261014-02`.

### Signed Boa compiler and browser path

The actual Node compiler-worker smoke test compiled two supplied modules without
guest top-level execution, signed their checkpoint, and loaded it through the shared
verified loader. `main(5)` returned `7`; fuel decreased from 200,000 to 199,984.
A second invocation and modified payload were rejected. The malformed-source case
returned the stable `BOA_COMPILER_REJECTED` code, and the comment canary was absent
from the captured payload in UTF-8 and UTF-16LE.

This run used runtime SHA-256
`fe832b7068df3c2349c792324e17943bd7aea448f901ab5d22e030c76b7cc465`
and audit SHA-256
`fdb6b5a5919d91946e41d9e061f1957fd094e9bc4ec731988b841a7a42024bac`.
The signed payload SHA-256 was
`60acf524f344ceb3b1ff6ed77bae6ac03c5d2bd48e6739276ec6f355f5478df0`.
This is the trusted budget-enabled image, not the later global-Script Test262 image.

An actual Chromium HTTP flow compiled an async/private-class `main` with input `35`,
signed the checkpoint on the server, and verified/restored it in the browser. Both
the awaited native path and signed Boa path returned `42`, with no recorded page
errors. Two permanent configured Chromium tests also passed, covering async native
completion, error, timeout/recovery and signed Boa parity. The configured test command
is `npm run test:jovault:browser`, with the four reviewed asset/pin settings described
in the [guide](USAGE.md). R0 remains the default and no failure switches engines.

The loader permits one invocation attempt and primitive arguments/results. Boa uses
shared 200,000-instruction fuel, a 64 MiB linear-memory maximum, fixed Date at epoch
zero/UTC, and no ambient host APIs. Its expiry checks occur before/after execution,
not at each guest instruction. The compiler worker has a five-second deadline and
128 MiB V8 old-generation limit; the demo admits one compilation at a time. These
are distinct budgets, not a whole-process memory or wall-time guarantee.

### Earlier signed R0 integration

The follow-up run `jovault/20261014-02` adds an authenticated R0 demo path and
language-gap probes. Its complete Node run passed 645 tests with zero failures,
skips or cancellations. Strict TypeScript passed. Independent scoped review
repeated all 37 package, loader, graph and demo tests, and the file-format checks.
The combined `npm run check` command passed with exit code 0: strict TypeScript,
645 Node tests and nine Rust tests. The earlier failed aggregate invocation below
is retained as history. The run used the preserved current-source Shield assets
and task-local native Rust tools described in that history.

The signed browser flow was executed in Chromium 156 at 1,440 px and 375 px, including
reduced motion. Native and VM workers returned `1368905075`. Mutated payload bytes,
signatures and deployment context produced PACKAGE_DIGEST, PACKAGE_SIGNATURE and
PACKAGE_CONTEXT respectively. Unsupported source, source invalidation, invalid
arguments, recovery, the VM instruction budget, native worker termination, visible
keyboard focus and print code were exercised. The new JoVault mark loaded locally;
there were no external HTTP requests or page errors. These are developer-run
integration checks, not an independent attack rate. Firefox was excluded at the
user's request.

The twenty self-authored language probes passed in native Node 24.19 and Chromium 156.
R0 passed two controls and explicitly rejected eighteen unsupported cases. This
measures gaps in this corpus, not a whole-language support percentage. The pinned
Test262 inventory contains 53,616 test units; none had been executed at that stage.
Its revision and runner acceptance rules are in [compatibility](COMPATIBILITY.md).

The separate Boa 0.22 probe built on Linux with Rust 1.98.1 and restored five fixtures
in fresh instances of the identical Wasm binary. Commit `9f2922b4de6d65a09c4ade9e70c65c686eda0cd4`
also passed a conservative binary-state audit: one exported mutable stack global,
no start function, no passive segments or table/segment mutation instructions, and
a maximum of 64 MiB memory. Its exact image hash is
`902852385ed927a08ea9a6ba0b39af907f210d9a79d4c9a8c320af4641c2902b`.
The uncompressed image was 5,235,275 bytes; these are sizes, not latency measurements.

A fresh comment-canary experiment found the entire original source as UTF-16LE in
that checkpoint after the original input allocation was zeroed. That build provides
no source-confidentiality evidence. A later source-retention patch passed six
targeted engine and two parser tests. Its five restored fixtures no longer contained
the exact full source or comment markers in UTF-8 or UTF-16LE. Its image hash is
`22928d5740ed46b9b4935a1893c8537b3122d542035d548d6f4431d85d5b60e4`.
This result applies to those exact probes; it does not establish removal of every
source fragment or resistance to reconstruction.
A whole-memory engine checkpoint contains heap state and compiled code;
it is not a portable, independently validated bytecode format. ABI compile counters
alone do not count every internal engine compilation.

### Boa module-graph checkpoint follow-up

The separate graph adapter has now executed in Linux CI. Its `ci-graph/graph-results.json`
records 20 self-authored feature probes: 20 passed, zero failed, and zero unsupported.
Another 19 negative and boundary cases passed, including missing-module rejection,
known dynamic imports, live reexports, side-effect order, top-level await, source
buffer erasure checks, Unicode inputs, duplicate fields and noncanonical identities.
The twenty-feature corpus includes closures, objects, classes, generators, async
functions, live imports and a module cycle. These results concern restored
same-build Boa checkpoints; the delivered R0 demo still has the two-of-twenty
language boundary recorded above.

The latest [native engine CI run](https://github.com/pushjoman21/JoVM/actions/runs/38551772656)
also passed all 1,120 engine library tests and 314 parser library tests with zero
failures. One parser test, `lexer::tests::illegal_code_point_following_numeric_literal`,
retained its upstream ignored status and reason: its validity needs an assertion.
These library tests and self-authored probes are separate from Test262; no Test262
test had been executed at this stage.

The CI artifact records source commit `6bb3dbf7df5860e4487d81177a49794e3677922f`.
Its Wasm image is 5,290,115 bytes with SHA-256
`d208ae8fe5a7ee89eee835262f5e5ad5150ffd872f6e9ea69ad72a542ce0a205`.
The following hashes come from the artifact's `source.sha256`, relative to the
prototype's `side_pr/JoVault/engine-probe/` directory:

| Measured source                   | SHA-256                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| `Cargo.lock`                      | `9cb14f2bd8e509787e789fb9dc1df802e02eb6b944bb4eb9d2d72a38b2588d11` |
| `src/lib.rs`                      | `5aa4e5a43cf2251a46294520991e8955abbe24c3e8bb852020781dd0e0665df5` |
| `graph-probe.mjs`                 | `2c421d84d65e34429209d1b4d4de0517a6a06b7cb2d7dd63a19fd3f047148684` |
| `fixture-graphs.json`             | `fff094d20bdd7ac067ea9bb2ab5e5eda5c91030a2365f653cb1c53d075975eb0` |
| `patches/manifest.json`           | `01b8a4eb263a5fa7d4520449b20ab057e6a52c1c615cac653c64ff02edf3a13a` |
| `patches/boa_engine-0.22.0.patch` | `fa789f660ffa5c992d67e7d30fbc09c7cbd3ba6b5902574c16ce21c668df648c` |
| `patches/boa_parser-0.22.0.patch` | `605720d84551e233746ad11c117760f715db24b0de833ab02ee9111d52b0d2ff` |

The artifact's complete source inventory, original graph results, binary audit,
compiler identity and image remain with that CI run. The local evidence copy is
`jovault/20261014-02/ci-graph`; its graph-results file has SHA-256
`3183a6fd894c6d76cffa27ad0050dc45796cedd7f9bcc86cab6ff06147d9527f`.
The earlier five-fixture results and image hashes above retain their original
provenance. Passing this corpus does not establish full JavaScript compatibility,
portable bytecode, browser checkpoint execution, production signed checkpoint
loading, or universal source erasure.

### Budget and primitive-argument engine revision

The later raw-engine revision `38e2411297d1dd03a99cb00d9ef1c7b2ac01ff66` completed
31 argument/budget cases, 20 feature probes, 19 boundary cases, and five legacy
restore fixtures. Its native engine library run passed 1,127 tests; parser tests
passed 314 with the same one upstream ignored case and no failures. The image hash
is the `fe832b...` runtime recorded above. Fuel exhaustion is terminal across guest
catch attempts; invocation and Promise jobs consume the same context allowance.
These raw ABI tests are distinct from the single-invocation signed loader contract.

### Initial official Test262 slice

The official source remains pinned at
`d53ebc8b1931d9f1541e43d59650776e4b766248`. The corrected local runner passed all
12 selected synchronous positive module tests and all 14 runner controls. Of the
53,616 discovered standalone test units, 53,604 remain `NOT_RUN`. No whole-suite or
ECMAScript 2025 coverage rate is inferred from this selected slice.

This run used the CI-built global-Script image SHA-256
`a1a9d88be58cd2c3f4fa21903e061814f8718d9dee156f98f4c321c1a289d8a8`.
It compiles the original `assert.js` and `sta.js` as ordered Script sources in the
same guest realm, checkpoints them, then evaluates them before the unchanged module
graph. Each control/test restores a fresh instance. Its ABI compile counter does
not instrument every internal lazy-compiler entry. See the
[runner contract](../engine-probe/conformance/README.md) for reproduction and scope.

The first CI attempt, source revision `dd38d64840abac0cf0ec31b82a9d0ce7d6c9bd72`,
failed a runner control before any selected test executed. The control expected
`Test262Error:` text, while the guest error display used `Test262Error { ... }`.
The actual assertion failure was present; the host display expectation was too
narrow. That original report is preserved with 12 selected `NOT_RUN`, rather than
being overwritten or counted as a language pass. The corrected local display check
then produced the results above using the same image. The corrected revision
`62eb15ccce9d14ac627b70ecd2d600d9ea713b65` subsequently completed
[CI run 38557472492](https://github.com/pushjoman21/JoVM/actions/runs/38557472492)
successfully, including the initial 12-test profile, 14 controls and native units.
The wider 117-case local result below is not relabeled as that CI run's result.

Script-goal tests, general negative-phase classification, async completion,
additional harness files, `$262` host services, and the remaining feature inventory
are outside this initial runner. The selected original tests retain their source
and harness hashes, license, and explicit unselected ledger. These are actual
limited test executions, not evidence that every target language behavior works.

### Wider Test262 follow-up and a remaining failure

The frozen wider local report used the same `a1a9d88b...` image and official source
pin. Its 117 selected tests produced 116 `PASS` and one `FAIL`, with all 14 runner
controls passing. The remaining 53,499 discovered test units are `NOT_RUN`. The
initial 12 tests are part of the same narrow module-positive profile; their passes
must not be added again to the wider denominator.

The failing case is
`test/language/module-code/eval-export-dflt-expr-cls-name-meth.js`. Its parenthesized
anonymous default class defines a static `name()` method; calling that method during
module evaluation produced `TypeError: not a callable function`. The corresponding
unparenthesized declaration case passed. The failure is preserved in the report and
counts. Class-name inference overwrote the method. At that point an engine fix
had no passing result. This is a language failure,
distinct from the earlier runner display-control failure. Its original report is
preserved alongside the later result below.

### Rebuilt class-name fix and standalone CI

The standalone implementation is available in the public
[JoVault repository](https://github.com/pushjoman21/JoVault), with a published
[research preview](https://github.com/pushjoman21/JoVault/releases/tag/research-preview-2026-10-14).
The CI run below was executed while the repository was private.
[CI run 38561260654](https://github.com/pushjoman21/JoVault/actions/runs/38561260654)
completed successfully at revision `b4ee21f2e034a5bdd8c8e6a5014585be2f1ad6d6`.
It rebuilt the cumulative patch from checksum-verified official crates, audited
the actual Wasm image, and executed the same 117 original tests. All 117 passed,
with all 14 runner controls passing. The remaining 53,499 test units are still
`NOT_RUN`; this result does not establish full ECMAScript support.

The fix assigns the inferred default class name before static initialization,
preserving a class's own static `name` method, field or accessor. Eleven targeted
regressions passed on the rebuilt image; the old image passed four and failed seven.
The earlier 116/117 result retains its original image and report.

| Check in this CI run                              | Result                                    |
| ------------------------------------------------- | ----------------------------------------- |
| Original restore fixtures                         | 5 passed                                  |
| Self-authored language / boundary cases           | 20 / 19 passed                            |
| Primitive argument and fuel cases                 | 31 passed                                 |
| Class-name regressions                            | 11 passed                                 |
| Selected Test262 cases / runner controls          | 117 / 14 passed                           |
| Standalone Node tests / configured Chromium tests | 115 / 2 passed, no skips                  |
| Engine library tests                              | 1,138 passed                              |
| Parser library tests                              | 314 passed, one unchanged upstream ignore |

Strict TypeScript, formatting, source inventory, and production feature checks
also passed. The signed browser tests used this newly built image and its audit,
rather than reusing the earlier demo image. The uncompressed image is 5,345,338
bytes, SHA-256 `7641a2c5fea7cd81699e5e07409cdc7d4d27bbacec40d9f37e2fa036a8c8ba9f`.
Its audit SHA-256 is
`04d6b1d77e0b9327ff10c1cd80809fb63d25acfb13d6361c1cbb417d1f43c42e`.
Artifact `11892156851` was downloaded and its ZIP digest verified as
`72ad8e338479d93a8ab6cd608ad03687cb5f7faccff7b6d0c7ebda6a7303b788`.
Original logs, reports and image are retained in the private task's
`ci-private-class-fix/` and `private-ci-b4ee21f.log`. CI artifacts have finite
retention; these local copies preserve the measured state. Package version 0.0.0
identifies an unpublished research snapshot, not a production release.

### Earlier foundation run

| Check                                        | Actual result                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Strict TypeScript                            | Passed                                                                                    |
| Complete Node suite                          | 613 passed, zero failed or skipped; includes 60 JoVault tests                             |
| Rust tests                                   | 9 passed after correcting task-local tool paths                                           |
| Repository structure and public content scan | Passed with a separate review index; real staging area preserved                          |
| Repository format check                      | Passed                                                                                    |
| CLI example                                  | Built a register runtime, wrapper and exact-byte hash manifest                            |
| Browser demo                                 | Chromium desktop/mobile, reduced motion, focus, errors, timeouts, CSP and print exercised |

The first broad check passed 583 of 584 Node tests and failed an existing Shield
memory-clear assertion. An isolated rebuild proved that its default WASM asset was
older than the unchanged current source: the same three Shield tests then passed.
The 613-test run used that private asset directory, preserving existing `dist`.
Its combined `npm run check` invocation subsequently failed in the local Rust
toolchain's import-library generator. A separate locked, offline Rust run passed
all nine tests after resolving existing tools and DLLs through task-local paths.
The aggregate command was not repeated after that environment repair. No test was
removed, filtered, skipped or given a broader allowance to obtain these results.

## Local cost pilot

The [aggregate result source](results.json) records the measured register code,
source hashes, environment and protocol. `npm run jovault:measure -- <new-file.json>`
repeats the serial synthetic Node harness. Seven samples follow one warm-up; native
and VM executions use the same module source and input `123`.

| Lines | Artifact bytes | Instructions | Compile median, ms | Load median, ms | VM invocation median, ms |
| ----- | -------------- | ------------ | ------------------ | --------------- | ------------------------ |
| 1     | 370            | 6            | 0.940              | 0.097           | 0.015                    |
| 104   | 11,543         | 808          | 3.699              | 2.451           | 0.222                    |
| 2,504 | 277,170        | 20,008       | 42.072             | 48.119          | 4.436                    |

All three fixtures matched native return values. Load includes schema validation
and snapshots; invocation excludes load, HTTP and worker startup. This is a JSON
instruction representation, so artifact size includes textual operands and tables.
The large fixture's validation cost exceeds its invocation cost and needs attention
before an application rollout. Native single-call medians were below 0.014 ms;
these short observations are noisy and do not justify a stable slowdown ratio.
Background activity on the developer machine was not controlled. No latency target
or security benefit was inferred from this pilot.

The earlier stack-IR pilot is retained as historical exploratory material. It ran
alongside other checks and is not a register-performance result.

## Claims left open

Most Test262 tests remain unrun. General JavaScript, complete module/host interop,
production signed delivery, automatic rotation/distribution, browser-engine portability, independently
measured analyst resistance and production workloads remain unverified or unfinished.
Local expiry can be bypassed by a modified runtime or clock. Opcode permutation is
observable in the supplied profile. No resistance percentage or claim of being the
safest available VM follows from these checks.

The [research basis](RESEARCH.md) and [roadmap](ROADMAP.md) define the next experiments
and the distinction between local refusal and authoritative server revocation.

## Standalone source provenance

This repository exports the JoVault source tree from JoVM. The implementation,
engine patches, permanent tests and synthetic fixtures retain their source hashes
in [ORIGIN.json](../ORIGIN.json). The copied random helper and existing JoVM brand SVG
retain their original bytes and MIT attribution. Two compiler imports and the demo
asset path resolve locally; this repository contains the same implementation.

The JoVM parent packaging integration test stays in JoVM because it tests that
repository's public allowlist. This export replaces those two parent-only checks
with standalone inventory tests covering source selection, links, pinned engine
inputs, private/generated output exclusion and copied-file hashes. Those checks
are different coverage. `npm run check` runs strict TypeScript and the standalone
Node suite; engine compilation and signed browser integration also run in CI.

The target is ECMAScript 2025 in browser and Node hosts. Full support remains
unproven. Read the compatibility and validation documents before enabling Boa.
