# Boa register-code checkpoint probe

This isolated experiment compiles scripts or module graphs with Boa 0.22, then
executes their compiled register code after restoring a fresh instance of the
exact same WebAssembly engine. It is not the JoVault delivery format or a
production loader. The fixtures do not establish full ECMAScript conformance or
resistance to reverse engineering.

The first instance compiles and links without evaluating guest code. The host
zeros the original input allocation, copies linear memory and exported globals,
then invokes the restored root in a second instance without passing source to it.
Counters check that the second instance does not enter a compile ABI. The
workflow runs five original fixtures, the current module graph fixture inventory,
31 primitive argument, metadata, rejection and instruction budget cases, and a
separately gated 117-test Test262 module profile. The original wider run passed
116 cases and failed one. The rebuilt class-name patch subsequently passed all
117 in [standalone CI](https://github.com/pushjoman21/JoVault/actions/runs/38561260654).
Results belong to the exact engine hash recorded by that workflow run.

The image contains raw Rust allocator, garbage collector, engine and object
state. Only an authenticated image produced by the trusted compiler for the exact
same engine and profile may be restored. Arbitrary images can corrupt engine
invariants. The separate binary audit checks supported globals, tables and
segments; fixture success alone cannot establish arbitrary-image safety.

Build with Rust 1.98.1 and its `wasm32-unknown-unknown` target:

```sh
mkdir -p patches/crate-cache
curl --fail --location --proto '=https' --tlsv1.2 https://static.crates.io/crates/boa_engine/boa_engine-0.22.0.crate \
  --output patches/crate-cache/boa_engine-0.22.0.crate
curl --fail --location --proto '=https' --tlsv1.2 https://static.crates.io/crates/boa_parser/boa_parser-0.22.0.crate \
  --output patches/crate-cache/boa_parser-0.22.0.crate
python3 patches/apply.py --cache-dir patches/crate-cache --destination patches/vendor-budget \
  --manifest-sha256 ca6baa7bf0427ae12571daa09c42fe3a24dbe2096c7a48cac362bdfd775b9f06
RUSTFLAGS='--cfg getrandom_backend="custom" -C link-arg=--max-memory=67108864 -C link-arg=--export=__stack_pointer -C link-arg=--export=__indirect_function_table' \
  cargo +1.98.1 build --locked --target wasm32-unknown-unknown --release --features source-removal,instruction-budget
node probe.mjs
node graph-probe.mjs
node args-probe.mjs
node class-name-probe.mjs
```

The cumulative patches apply directly to the official engine and parser 0.22.0
crate archives at upstream revision `337a3668a0dc86dd401ea20906e782249a64a228`.
The manifest pins archive checksums, patch checksums, changed-file before/after
hashes and complete output trees. The applier validates them before materializing
a new directory; it never overwrites a destination or executes Rust. The earlier
`patches/vendor/` directory, if present locally, is independent and unused by this
profile. Both materialized directories are ignored. Canonical inputs are the
applier, manifest and two unified patches.

The current packet also corrects inferred names for anonymous default class
expressions before their static initialization. Eleven targeted regressions cover
static names, getters, fields, early reads, deleted names and unchanged controls.
The older image failed seven of these cases. The rebuilt image passed all eleven
in the CI run above, alongside 1,138 engine tests and 314 parser tests (one upstream
ignore). Exact image hashes and historical results are in
[validation](../docs/VALIDATION.md); older checkpoints are not relabeled.

With `source-removal`, each compiler context sets `.retain_source_text(false)`.
The parser skips whole-source recording while preserving UTF-16 positions,
literals and JSON reviver data required by JavaScript. Absent function source
uses the engine's native-code fallback. Input and decoded source allocations are
wiped separately. Exact canaries and full-source absence checks test the compiled
image; they cannot prove that no source fragments or reconstructable information
remain. Literal strings and executable dynamic-code strings remain program data.

With `instruction-budget`, every probe context explicitly sets 200,000 VM
dispatches for its entire lifetime. The engine feature exposes the API without
turning on fuzzing dependencies; its upstream-compatible default is unlimited,
so the host's finite setting and ABI readback are required. Parse, compile, load,
link and export-name inspection must leave the initial counter unchanged. Module
initialization, calls and promise jobs share it. The budget never refills after
restoration or subsequent calls. Exhaustion uses an uncatchable engine error and
unwinds nested frames. Before another entry or job pump, a zero counter rejects
execution. The adapter also rejects a zero counter before its final unconditional
job pump, even if a primitive-returning main used its last unit successfully and
the queue is empty. This is a conservative adapter boundary; exact-last-unit
success is not promised here. Discard the instance after exhaustion.

`invoke_json_args(pointer, length)` accepts a bounded JSON array of at most 64
primitive arguments, with a 4 MiB encoded cap and 8,192 UTF-16 units per string.
It rejects nested arrays/objects and non-finite input numbers. Primitive results
use typed JSON, including undefined, negative zero and non-finite numbers.
`export_names_json()` lists module exports before evaluation without reading
bindings. `error_json_ptr()` and `error_json_len()` expose the machine-readable
budget failure `{"ok":false,"error":{"code":"instruction_budget_exhausted"}}`.
Classification uses `EngineError::NoInstructionsRemain`, not error-text matching.
The legacy numeric ABI and bounded diagnostic string remain for original probes.

Instruction fuel cannot preempt one long Rust builtin, RegExp or native callback.
The harness therefore also uses worker deadlines, a 64 MiB Wasm memory maximum
and bounded inputs/results. Only the trusted entropy import is allowed. The
current clock is fixed at zero and the timezone profile is UTC; broad browser or
Node host APIs are not implemented by this probe.

Input format `JOVLT-BOA-INPUT1` adds ordered global Scripts for the official test
harness. They compile in the same Realm before the checkpoint and execute once
after restoration, before module evaluation. Failed initialization invalidates
the instance. The original `JOVLT-BOA-INPUT0` schema remains unchanged. The
[bounded conformance runner](conformance/README.md) verifies original sources
against a pinned official checkout and runs fourteen controls before its selected
tests. This small slice cannot establish full ECMAScript compatibility.

The branch-specific GitHub Actions workflow performs the feature-enabled Wasm
build, binary audit, the execution harnesses, full native engine/parser unit suites
and a production feature audit. It retains the binary, exact source/compiler
identity and actual results. This does not deploy or publish a package.
Dependencies are pinned in Cargo.lock; Boa is MIT or Unlicense. This experiment
remains separate from JoVM's protection VM and wire protocol.
