# JavaScript compatibility contract

Status: 2026-10-14. The executable `JOVLT-R0` subset, compiler-input graph, package
foundation, optional signed Boa checkpoint path, and conformance-runner profile
have separate acceptance boundaries.
The [validation record](VALIDATION.md) owns run provenance and result tables.
The [roadmap](ROADMAP.md) defines work still required.

## Language target and host capabilities

The broader target is [ECMAScript 2025, ECMA-262 edition 16](https://262.ecma-international.org/16.0/),
for both browser and Node hosts. It includes Script and Module source goals,
ordinary language semantics, and the ECMA-262 standard library. Annex B browser
compatibility needs its own declared profile. ECMA-402 internationalization and
later proposals have separate scope and denominators.

DOM, network requests, timers, storage, filesystem access, `process`, and native
package resolution are host services. Guest code receives only explicitly granted
capabilities. A guest engine's own `eval` or function compilation is a separate
language feature from forbidden native-host source execution. Disabling guest
dynamic compilation defines a restricted profile that must be reported as such.

## What R0 accepts

R0 accepts one function-oriented module with primitive values. It supports top-level
function declarations, named/default function exports and aliases, and named/default
imports used as direct calls. Parameters are identifiers. Locals use block-scoped
`let` or initialized `const`, with assignment checks. Primitive values are numbers,
strings, booleans, `null`, and `undefined`; arithmetic may produce `NaN`, infinities,
and signed zero.

Control flow includes `if`/`else`, `while`, `for`, `return`, conditional expressions,
and short-circuit logical AND/OR. Operators include arithmetic, bitwise shifts,
comparisons, strict equality, unary operations, numeric updates, and compound
assignments. Calls target statically known local functions or supplied imported
functions, with primitive arguments and results.

R0 rejects objects, arrays, closures, methods, classes, exceptions, async functions,
generators, BigInt, symbols, destructuring, loose equality, `var`, disposal
declarations, `break`/`continue`, namespace or side-effect imports, re-exports, and
mutable exported state. Function values cannot be passed around as ordinary values.
Unsupported syntax produces a located compiler error; there is no native-source
execution fallback.

Local reads before declaration are rejected during compilation, including unreachable
branches. This conservative rule differs from ECMAScript's runtime temporal dead
zone. Exported wrappers preserve declared function aliases and read imported function
bindings at invocation, but reflection, constructor behavior, arbitrary module cycles,
and transparent host/guest object identity are outside this contract. Native
dependencies can initialize before the wrapper checks expiry.

## Evidence and its limits

The self-authored `JOVLT-CONF-BASE-1` baseline contains 20 semantic probes. Native Node
and Chromium each passed 20/20; the current R0 compiler/runtime passed two supported
controls and explicitly rejected 18 cases as unsupported. These are gap probes,
not a percentage estimate of whole-language coverage. See
[validation](VALIDATION.md) for the exact environments, source state, and reproduction.

The pinned Test262 revision is
`d53ebc8b1931d9f1541e43d59650776e4b766248`. Its read-only inventory contains 53,616
standalone test units. A corrected local runner executed 12 selected synchronous
positive module tests successfully, after 14 runner controls passed; 53,604 test
units remained `NOT_RUN` in that initial report. The run used a separate CI-built image that compiles original
global harness scripts as Script in the guest realm before module execution.
The corrected initial profile now also passes in CI at revision `62eb15c`, including
runner controls. The wider follow-up below remains a separate local experiment.
The initial failed display-control run is retained in [validation](VALIDATION.md).
A wider local run found a real module-evaluation failure for a parenthesized
anonymous default class with a static `name()` method. The failure remains counted;
it is not excluded to improve the result. Validation records the wider denominator,
remaining unrun inventory, exact image, and pending engine-fix status.

This selected slice does not define an ES2025 coverage percentage. Expected
strict/sloppy/module variants must be reported separately. The suite tracks newer
proposals as well as the declared edition, so target classification must precede
an ES2025 conformance denominator. Unselected tests stay visible even when the
initial profile excludes their source goal, async behavior, or harness needs.

The runner must preserve the pinned
[Test262 interpretation rules](https://github.com/tc39/test262/blob/d53ebc8b1931d9f1541e43d59650776e4b766248/INTERPRETING.md):
source goals, harness realms and includes, module dependencies, async completion,
and expected parse/resolution/runtime error phases. Rejecting a supported-language
feature as unimplemented is `UNSUPPORTED`, not a passing negative test. Every
discovered variant needs a recorded outcome, including unrun or failed shards.

## Boa checkpoint profile

The optional local demo path compiles one module exporting `main`, signs its
`JOVLTBC1` memory checkpoint as P1 kind `boa-checkpoint`, and verifies it before
restoring a fresh exact-build Wasm instance. The Node compiler API also accepts
explicit bounded module graphs. Operators must pin both the runtime and its binary
audit. R0 remains the default; failures never select another engine automatically.

Boa can use objects, closures and asynchronous jobs inside its guest realm, but
the signed entry boundary accepts finite JSON primitive arguments and returns one
primitive result. One instance permits one invocation attempt. There is no general
host-object membrane, transparent native ESM object export, or ambient Node/DOM/
network/filesystem API. The profile fixes guest time to epoch zero and UTC.

The context shares 200,000 instructions across evaluation, jobs and invocation.
Wasm linear memory is capped at 64 MiB. Package time is checked before and after
execution, rather than at every Boa instruction. External worker deadlines provide
a separate stop mechanism. These policies are observable restrictions and do not
prove equivalence to an unrestricted host.

## What the Boa evidence establishes

Boa 0.22 supplies a Rust JavaScript engine with a register VM. Separate Linux CI
experiments restored compiled state into fresh instances of the matching Wasm image,
including module graphs, closures, private classes, asynchronous jobs, and selected
built-ins. The [validation record](VALIDATION.md) retains the initial fixtures,
later graph results, native library tests, and exact source/image hashes. These
results do not turn those features into R0 capabilities or establish complete Boa
compatibility in JoVault's browser and Node profiles. A signed compiler/loader smoke
test and a native-versus-signed-Boa Chromium comparison now exercise the local
delivery path for bounded examples. Upstream engine conformance
results likewise cannot substitute for runs through the actual delivered JoVault
artifact path.

The probe uses a whole-memory checkpoint rather than a portable serialized
CodeBlock format. The unmodified probe retained the complete original source as
UTF-16LE in its checkpoint after the input buffers were cleared. A binary audit
checked the exact image's mutable-global, segment, table-instruction, start-function,
and memory-limit preconditions. A later source-retention patch passed semantic
regressions and checks for the absence of the exact full source and comment
markers. Broader external-state handling, removal of every source fragment, and internal compiler-entry
instrumentation remain unfinished. Broad browser compatibility, production signed
checkpoint delivery, host capability integration, and the remaining target suite
need their own evidence. The tested fuel/argument profile does not widen R0.

Before a full-support claim, both delivered host paths need reviewed target results,
explicit unsupported/outside-target counts, real module and job semantics, malformed
artifact checks, and default-deny capability tests. The source-input graph and signed
package verifier do not establish complete language semantics.

The signed R0 demo has separate Node package/loader and Chromium desktop/mobile
integration evidence, including tampered-package and wrong-context rejection.
These checks exercise the R0 package boundary. Separate optional-Boa checks establish
bounded browser restoration and primitive-result parity; neither widens the R0 subset.
Detailed results remain in validation.
