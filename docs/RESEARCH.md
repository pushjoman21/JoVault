# JoVault research basis

Reviewed 2026-10-14. JoVault has a bounded JavaScript-to-register-bytecode prototype
and a local comparison demo. The [validation record](VALIDATION.md) reports performed
checks and local pilot measurements. The [roadmap](ROADMAP.md) separates these checks
from the unfinished compatibility, optimization, and attack-resistance research.

## What JoVault is trying to build

In the delivered R0 path, JoVault translates supported JavaScript into its own
instruction format and runs that format with a matching interpreter. An ESM wrapper
exposes exported functions and supplies explicitly imported host functions. The
source parser is the existing TypeScript development dependency; the interpreter
does not need the parser.
Microsoft documents `createSourceFile` and AST traversal in its
[Compiler API guide](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API).
Using that parser saves parser maintenance, but JoVault still owns syntax rejection,
binding analysis, bytecode validation, and execution semantics.

The [register contract](../src/register-contract.ts) defines `JOVLT-R0` artifacts,
`JOVLT-RD0` dialect profiles, and 32 operations. Each instruction has five integer
fields: `[opcode, dst, a, b, c]`. Arithmetic names its source and destination registers;
calls specify a contiguous argument window and a return destination. The
[runtime](../src/register-runtime.ts) gives each call its own register array and
routes the result to the caller's destination. It executes without an operand stack.

The [compiler](../src/register-compiler.ts) currently lowers an internal stack-shaped
frontend representation. It checks temporary-value heights along control-flow edges
and at joins, then assigns those values explicit register positions. That compiler
representation does not ship as the executable artifact. A direct typed semantic
IR and register allocation based on liveness remain proposed improvements.

The initial scope is a finite subset of ordinary JavaScript syntax: function
declarations, function exports, callable imports, local primitive values, control
flow, and direct calls. Equality uses `===`/`!==`; `==`/`!=` are rejected.
Unsupported syntax must produce a compiler error. Shipping the original source as
an execution fallback would break this contract. Objects, closures, exceptions,
asynchronous functions, and complete ESM linking need a broader delivered execution
path before JoVault can accept general JavaScript programs. The separate Boa
checkpoint experiments exercise selected broader semantics; their results and
source-retention limits are recorded in [validation](VALIDATION.md). They do not
expand R0's accepted syntax or establish full JavaScript support.

The [local demo](../demo/index.html) lets a developer edit source, compile it, inspect
the register artifact and generated module, and compare native and VM execution.
The comparison runs in browser workers with termination timeouts; its server binds
to loopback on port 4971 by default and sends a content security policy. Native execution runs
the entered source through the browser's module loader for comparison. It is a
separate demo path; the VM has no native-source fallback. The demo accepts a narrower
entry contract than the library and does not demonstrate full JavaScript support.

## Separation from JoVM

JoVault uses its own artifact tags, opcode profiles, and the dialect-generation
domain label `jovault-register-dialect-0`. Main JoVM protocol versions, keys, and
configuration do not define JoVault bytecode. Reusing a build-time random generator
does not make the two wire formats compatible.

Learning JoVault's instruction format does not provide a matching JoVM profile or
its private configuration. General reverse-engineering skills, instrumentation,
control-flow analysis, and interpreter-analysis techniques can transfer between
projects. Separate formats cannot support a claim that studying JoVault teaches an
analyst nothing about JoVM.

## Semantics that the VM must preserve

JavaScript arithmetic needs more than integer instructions. `Number` includes
fractions, signed zero, infinities, and `NaN`; changing operation order can change
results. See the fixed
[ECMAScript 2025 Number specification](https://tc39.es/ecma262/2025/multipage/ecmascript-data-types-and-values.html#sec-ecmascript-language-types-number-type).
Bitwise instructions require the specified conversions and shift behavior, including
the distinction between signed and unsigned right shift. Primitive coercion and
truthiness follow the corresponding
[abstract operations](https://tc39.es/ecma262/2025/multipage/abstract-operations.html#sec-toint32).
Tests must compare values without losing `NaN` or the sign of zero during JSON
serialization. Short-circuit operators must preserve the selected operand and must
not evaluate a skipped call.

ESM support includes linking, evaluation order, live imported bindings, and cycles.
The standard defines module records and traversal of strongly connected components
in its
[module algorithms](https://tc39.es/ecma262/2025/multipage/ecmascript-language-scripts-and-modules.html#sec-cyclic-module-records).
R0's function bridge is a narrower integration boundary. The wrapper uses
native ESM resolution and reads imported function bindings when called. A mutable
export cannot be represented faithfully by a one-time value copy. A later linker must
implement binding cells and module states before adding mutable exports, re-exports,
or cycles involving initialization. Browser and Node module resolution also require
explicit host contracts.

## Dialects, rotation, and expiry

The register operations cover values, arithmetic, bitwise logic, comparisons,
control flow, calls, and return. A `nop` preserves instruction positions when frontend
operations disappear during lowering. The prototype pairs an artifact with a dialect
profile that maps these operations to numeric instruction codes. The matching profile
is required by the cooperative runtime.
This makes bytecode incompatible with an unrelated profile; the profile
itself discloses the mapping. Changing those numbers does not establish secrecy or
demonstrate that an analyst must repeat all prior work.

The lifetime uses 600-second epochs. An artifact is valid from its epoch's
start, inclusive, until the next epoch, exclusive. Compiling near the boundary leaves
less than 600 seconds of use. The runtime checks validity on invocation and at
instruction boundaries so a loop can expire during execution. Host calls are
synchronous trusted code: the interpreter cannot preempt one that blocks. An expiry
check after a host call cannot undo its effects.

A recipient who controls the runtime can replace the clock, patch the checks, retain
an old interpreter, and dump constants or intermediate values. Local expiry therefore
demonstrates refusal by the supplied runtime, with no hard revocation of copied code.
MITRE describes the general failure mode in
[CWE-602](https://cwe.mitre.org/data/definitions/602.html). Secrets and authorization
decisions must stay with a server or another authority outside that recipient's
control. Signed distribution can authenticate an artifact to an intact verifier;
it cannot force a modified client to stop computing.

## Research method

Opcode coverage should follow observable JavaScript behavior. A longer opcode table
or more randomized handlers alone does not establish compatibility or protection.
First compare compiled execution with native execution for supported programs, then
measure compilation, startup, execution, and artifact size on the same corpus.
Use independent known-answer fixtures as well as generated cases so two paths do
not silently share the same mistake.

Bounded semantic and expiry tests now exist, including independent register fixtures,
branch joins, nested calls, stale instances, and instruction-boundary expiry. Their
recorded outcomes belong in [validation](VALIDATION.md). They establish behavior for
their tested cases. Cost results apply only to the implementation hashes in their
run: the earlier stack pilot cannot establish the register path's cost. A local
synthetic pilot cannot establish distribution capacity or resistance to an
independent analyst. That resistance evaluation remains unmet.

[Test262](https://github.com/tc39/test262) is TC39's ECMAScript conformance suite.
Its [runner requirements](https://github.com/tc39/test262/blob/main/INTERPRETING.md)
include metadata, harness dependencies, module flags, and expected error phases.
Future results must pin a suite commit and disclose unsupported features and runner
adaptations. A curated subset cannot justify a full ECMAScript conformance claim.
The prototype's own tests are separate from a Test262 run.

V8's [code-cache description](https://v8.dev/blog/improved-code-caching), published
2018-04-24, describes reuse of compiled code and rejection after version mismatch.
It is a useful comparison for startup and cache lifecycle, but it does not establish
JoVault portability, confidentiality, or performance. JoVault should own and version
its format rather than assume V8 cache data is a stable distribution format.

Typed IR, register liveness, SSA, and instruction selection are established compiler
research inputs. LLVM documents its [SSA representation](https://llvm.org/docs/LangRef.html#abstract)
and [register allocation](https://llvm.org/docs/CodeGenerator.html#register-allocation).
JoVault's proposed experiments compare their cost and semantic effects in this
runtime; adopting them would not establish novelty or a security proof. JavaScript
coercion, observable call order, `NaN`, and signed zero constrain valid rewrites.

Each proposed experiment in the roadmap needs a fixed corpus, source hashes, runtime
versions, command, hardware description, and raw artifacts before it has a result.
No claim of being impossible to reverse, a new cryptographic primitive, or the
strongest available protection follows from this design.
