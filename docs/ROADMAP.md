# JoVault implementation and experiment plan

Status reviewed 2026-10-14. R0 implements a bounded JavaScript compiler, register VM,
ESM function bridge, 600-second expiry, and local comparison demo. New work adds a
compiler-input graph and authenticated package foundation. The optional Boa/Rust/Wasm
path now connects a bounded Node compiler, signed checkpoint loader, and Chromium
demo. R0 remains the default, with explicit operator pins required for Boa and no
fallback between them. Separate raw-engine and initial conformance experiments
retain their own image/profile provenance. The unmodified checkpoint retained
source; later patched images passed bounded absence and semantic checks.
The [validation record](VALIDATION.md) holds exact outcomes and provenance.

The broader target is ECMAScript 2025 in browser and Node hosts with explicit host
capabilities. The [compatibility contract](COMPATIBILITY.md) states the current
subset, semantic-gap evidence, and partially executed conformance inventory. Full language
support, source-free engine artifacts, and independent attack-resistance evaluation
remain unfinished.

## Phase 0: make the narrow contract executable

Accept top-level callable imports and function declarations, named/default function
exports, primitive literals, local `let`/`const`, branches, loops, return, primitive
operators, strict equality, short-circuit logic, and direct local/imported calls.
Reject loose equality. Define each accepted syntax form and reject all other forms,
including source fallback. The interpreter must have no dynamic source execution
or arbitrary host property access.

The public path uses 32 register operations and five-field instructions
`[opcode, dst, a, b, c]`. Its runtime has per-call register arrays, explicit argument
windows and return destinations, and no operand stack. The compiler's internal
stack-shaped frontend IR is lowered with control-flow join analysis. The earlier
stack runtime is an internal reference for testing.

Keep opcode meanings separate from their dialect encoding. Validate format, matching
dialect, operands, branch targets, register and constant indices, argument windows,
and resource limits before or during execution as appropriate. Require a total
instruction budget and bounded registers/call depth. Test malformed artifacts as inputs,
including internally consistent but invalid references.

Use 600-second epoch windows with an exclusive expiry boundary. Require validity at
instantiation, every exported invocation, and instruction boundaries. Test the instant
before and at expiry, a loaded instance retained past expiry, an executing loop,
backward clock changes, and dialect mismatch. Record that this policy relies on the
cooperative clock and runtime. It cannot revoke copies held by a modified client.

An ESM acceptance test must import generated output through the native module loader,
call named/default exports, and exercise an imported function with primitive values.
Check that the wrapper reads a live imported function binding at invocation.
Document which dependency code remains native. Do not describe the function bridge
as full ESM compilation.

The local demo provides source editing, compilation, artifact/module inspection, and
native-versus-VM comparison. Retain its loopback binding, content security policy,
worker termination limits, and narrower entry contract. A successful comparison for
an entered program is one semantic observation, not a conformance result.

JoVault's format tags, dialect domain label, and opcode profiles remain separate from
main JoVM's protocol, keys, and configuration. Analyze how general reverse-engineering
methods transfer; format separation alone does not eliminate it.

The compiler-input graph preserves exact source and discovers bounded dependencies.
It does not link module cells or choose ESM evaluation order. Keep source discovery,
compilation, linking, evaluation, and host capability grants as separate contracts.

## Phase 1: establish the broader runtime and artifact contract

Investigate Boa 0.22 as an embedded Rust register VM compiled to Wasm. The completed
CI probe restores compiled state into fresh instances of the same engine image;
this checkpoint approach differs from a portable serialized bytecode format.
The audited image has one exported mutable stack global, no hidden mutable globals,
passive segments, table-mutation instructions, or start function, and a 64 MiB memory
maximum. Retain the exact image/configuration/ABI binding and repeat these checks
for each changed image. Extend evidence for browser restoration, external-state
handling, compiler-entry behavior, GC/root stability, and module/job semantics.
No upstream engine conformance headline replaces JoVault
results through that delivered path.

The unmodified checkpoint contains the original source after input clearing. The
later source-retention patch has bounded passing checks; their exact scope belongs
in [validation](VALIDATION.md). Continue testing source stripping before any general
source-free claim. A host visibility hook alone cannot prove removal. Audit
source-bearing heap allocations and metadata without erasing data required for
semantics; scan complete images and keep regression cases for reflection,
exceptions, closures, and garbage collection.

The Boa graph adapter has exercised selected module and job semantics through
same-build checkpoint restoration. The budget/argument revision passed its raw-engine
checks and now supports a signed local path. Its context fuel spans evaluation, jobs
and invocation; package expiry is checked before/after execution. Keep that policy
separate from R0's instruction-boundary time checks. The local browser/Node examples
do not complete language acceptance or a general host bridge.

The initial official Test262 module slice has actual local execution results and
validated runner controls, now reproduced by the corrected initial-profile CI run. Continue with
explicit new result paths, preserve the original failed display-control report,
and keep unselected tests visible. Do not apply the conformance runner's separate
global-Script image results to the signed demo image without retesting.
A wider local run found a class-name-method failure during module evaluation.
Retain the failing test and original report while investigating a fix; a reduced
corpus or an unverified patch cannot close that gate.

A custom R1 runtime remains a separately versioned design option. Keep R0 entry
points and primitive contracts stable; reject cross-format artifacts and require an
explicit target during incomplete R1 coverage. Its design needs VM-owned tagged
values, heap objects, lexical environments, completion records, and shared execution
budgets. Widening the existing primitive union or forwarding guest operations to
arbitrary host objects would not implement that model.

Maintain a feature matrix for supported, explicitly rejected, and planned behavior.
For a custom R1 implementation, add runtime environments and temporal dead zones,
closures and first-class functions, completion records and exceptions, then objects,
property descriptors, arrays,
prototypes, and method calls. Each increment needs native differential tests and
negative cases before acceptance changes. Specify allocation and memory limits
before introducing heap objects.

For a custom R1 runtime, build a module linker with resolved binding cells,
initialization state, dependency order, and cycle handling. Add mutable exports,
re-exports, namespace imports,
side-effect initialization, and asynchronous module evaluation only with their
corresponding tests. Scope dynamic import and host capabilities explicitly.

Later custom-runtime work covers classes, iterators, generators, promises, async
functions, BigInt, symbols, regular expressions, built-ins, and host integration.
Full ECMAScript support is an engine-sized maintenance commitment. Compare the
embedded-engine and custom-runtime options using semantic coverage, artifact safety,
source retention, host boundaries, bundle cost, licensing, and the same corpus.

## Phase 2: measure rotation cost and analysis transfer

| ID        | Status and question                                                                                              | Evidence required for the broader conclusion                                                                                                                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JV-SEM-1  | Bounded tests exist. Does the accepted subset preserve native behavior across a wider corpus?                    | Fixed known-answer corpus plus seeded generated programs; compare return values, ordered host-call traces, and expected errors; retain minimized counterexamples.                                                                                                 |
| JV-CONF-1 | Initial reviewed module slice executed locally; most tests remain unrun. Which target behaviors pass?            | Pinned Test262 revision, target-edition classification, runner code, harness handling, and separate pass/fail/unsupported/not-run counts.                                                                                                                         |
| JV-COST-1 | A local synthetic pilot is available for validation. Can compilation and distribution sustain 600-second epochs? | Source and artifact hashes; cold/warm parse, compile, encode, load, and invocation times; CPU, peak memory, artifact/runtime bytes, and rotation frequency at several corpus sizes.                                                                               |
| JV-ROT-1  | Unmet. How much analyst work transfers across epochs and between JoVault and JoVM?                               | Fixed programs, independent analyst/tools/time budgets, and success criteria; compare fixed dialects, opcode permutations, and later handler transformations; retain traces and recovered semantics.                                                              |
| JV-EXP-1  | Bounded tests exist. Where does cooperative expiry stop execution?                                               | Recorded boundary, loop, host-call, and stale-instance traces; controlled demonstrations of client-side clock/check bypass.                                                                                                                                       |
| JV-OPT-1  | Proposed. Which register compiler optimizations repay their implementation and compilation cost?                 | Separately compare direct typed semantic IR, register liveness/reuse, SSA conversion, and handler selection/fusion with the present lowering; preserve differential parity and report compile time, runtime, register count, artifact bytes, and validation cost. |

The validation record identifies performed runs. Existing bounded tests and a small
synthetic pilot do not complete any of the broader research questions above.

For JV-COST-1, measure repeated whole-source compilation separately from reuse of
parsed AST or semantic IR with fresh dialect encoding. Separate compiler cost from
network transfer and cache invalidation. Record failed rotations and stale-client
behavior. Keep debug metadata separate when comparing shipped size.

For JV-ROT-1, include an analyst who reads the supplied interpreter and normalizes
numeric opcodes to semantic operations. Measure transfer to held-out epochs rather
than count changed bytes. Additional handler variants or fused instructions need
their own compatibility and cost checks. No resistance level is assigned before
this experiment runs.

For JV-OPT-1, change one compiler stage at a time. Compare direct typed semantic IR
with the current frontend lowering before adding liveness-based register reuse or
SSA. Record coercion and effect information explicitly so optimization cannot reorder
host calls or change primitive semantics. Compare handler selection and fused
instructions under the same programs and dialect policy. These are experiments with
established compiler techniques, with no claim of novelty or protection strength.

## Phase 3: integrate authenticated delivery

The `JOVLT-P1` foundation implements Ed25519 signing, Web Crypto verification,
canonical manifest binding, byte snapshots, caller-supplied trust, and a register
package loader. The default R0 demo uses this path. Node tests and Chromium desktop/mobile
checks exercised accepted packages, tampered payloads and signatures, wrong deployment
context, rejected source, recovery, and execution limits. The validation record owns
the exact results rather than a duplicated table here.
The ordinary R0 CLI hash manifest remains unsigned.

The optional Boa loader uses the existing `boa-checkpoint` package kind and verifies
before restoring heap bytes. Its runtime and audit pins, single invocation, bounded
primitive bridge, and restricted guest clock are explicit. One Node smoke case and
an async/private-class browser comparison exercise the signed path. Production key
distribution and an independent image-safety review remain separate gates.

Bind artifact/profile metadata to package epoch and validity, runtime identity,
application/deployment context, and ABI. Keep signing keys on the server. Next define
production key distribution and rotation, authenticated time policy, cache keys,
server replay rejection, and atomic delivery of the matching runtime/profile/artifact
set. A signature authenticates producer-authorized bytes; it does not validate an
arbitrary engine-memory image or enforce execution after a client patches its clock.

Test partial publication, wrong pairs, expired caches, clock skew, offline clients,
and deployment failure. The server must reject stale authorization independently
of client claims. Define the next-epoch distribution policy before rollout: prefetch
can reduce gaps but also exposes the next profile early. Never restore an expired
epoch as an availability fallback; publish a fresh valid package through the same
verified path.

Production remote delivery, broader embedded-engine acceptance, compatibility expansion, and
resistance experiments retain their own acceptance gates. Record each completed
phase with source state, performed checks, and remaining limitations before changing
its status. Public research articles and source releases must preserve these
distinctions and exclude private evidence, signing keys, and live JoVM configuration.
