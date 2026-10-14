# JoVault guide

JoVault researches JavaScript compilation, register VMs, and authenticated artifact
loading. Its executable foundation, `JOVLT-R0`, compiles a defined primitive subset
and bridges function imports and exports through native ECMAScript modules (ESM).
The supplied VM uses explicit source and destination registers. JoVault is separate
from JoVM's browser verification service.

The compiler emits 32 semantic operations with an epoch-specific numeric mapping.
Epochs last ten minutes. The supplied runtime refuses a mismatched profile or an
expired artifact, including an instance loaded before expiry. The bytecode runs
through JoVault rather than as JavaScript source. The browser can still inspect the
interpreter, constants, imports, and intermediate values. There is no measured
resistance to reverse engineering, cryptographic confidentiality, or production
access-control claim.

An optional Boa 0.22 path now compiles modules in a bounded Node worker, signs their
checkpoint, and restores the verified bytes in a matching Wasm engine. Rust implements
that JavaScript register VM. R0 remains the default; selecting Boa requires reviewed
runtime assets and explicit operator configuration. Neither path establishes full
ECMAScript support, portable engine bytecode, or removal of every source fragment.
The [compatibility contract](COMPATIBILITY.md) defines the target, measured gaps,
and unfinished gates; [validation](VALIDATION.md) owns the actual results.

## Run the foundation

Use Node.js >=24.11.0 <25 and npm. Install the pinned dependencies from the
lockfile and run these commands from the repository root:

```sh
npm ci
npm run test:jovault
```

Start the English dark editor with `npm run jovault:demo`, then open the
[local demo](http://127.0.0.1:4971). Edit JavaScript, compile it, inspect the register
instructions or ESM wrapper, and run both versions with the same arguments. Each
run uses a fresh browser worker and a two-second stop timer. The demo supplies no
host imports. It is separate from the blog and its no-JavaScript policy.

The demo uses the signed-package path. Its server keeps the
private signing key, and the browser loader verifies payload bytes before decoding
or creating a VM instance. Node package/loader tests and Chromium desktop/mobile
checks exercised normal execution, tampering, context rejection, recovery, and
execution limits. The [validation record](VALIDATION.md) holds exact outcomes.
This is a local trust setup, not a deployed authority.

### Enable the experimental Boa path

The engine selector defaults to R0. To enable Boa, the operator must provide all
four environment settings below before starting the same demo command. Paths point
to reviewed local artifacts; SHA-256 values pin their exact bytes. Missing settings
leave Boa unavailable, and incomplete or mismatched configuration is rejected.

| Setting                    | Required value                               |
| -------------------------- | -------------------------------------------- |
| `JOVAULT_BOA_WASM`         | Path to the reviewed Boa Wasm engine image   |
| `JOVAULT_BOA_AUDIT`        | Path to that image's binary-state audit JSON |
| `JOVAULT_BOA_WASM_SHA256`  | Lowercase SHA-256 of the exact engine image  |
| `JOVAULT_BOA_AUDIT_SHA256` | Lowercase SHA-256 of the exact audit JSON    |

The demo accepts one source module exporting `main`, finite JSON primitive
arguments, and a primitive result. Its Boa compiler API also accepts a bounded
explicit module graph. There is no automatic switch to R0 or native source when
Boa compilation or execution fails. The native button is a separate comparison path.

The compiler worker has a five-second deadline and a 128 MiB V8 old-generation
limit; the demo permits one Boa compilation at a time. This is not a whole-process
memory quota. The pinned Wasm image caps linear memory at 64 MiB and supplies
200,000 context instructions shared by module evaluation, jobs, and invocation.
The package allows one `main` invocation. Boa checks package expiry before and
after execution; it does not check the wall clock at every guest instruction.
The browser worker's external deadline provides a separate stop mechanism.

This profile grants no ambient Node, DOM, network or filesystem APIs. It uses a
fixed clock at Unix epoch zero and UTC, so time-dependent programs differ from a
normal host. Guest objects may exist inside Boa; the exposed boundary remains
primitive-only. See [architecture](ARCHITECTURE.md) and
[compatibility](COMPATIBILITY.md) before choosing this profile.

Build the example as a module from another terminal:

```sh
npm run jovault:build -- examples/algorithm.mjs jovault-example
node --input-type=module -e "const m = await import('./jovault-example/module.mjs'); console.log(m.mix(123));"
```

The output directory must be new and its parent must exist. The build writes
`module.mjs`, `jovault-runtime.mjs`, and a hash manifest. It rebases relative host
imports to their original locations; it does not copy, protect, or bundle those
dependencies. Keep them available. Bare imports retain the destination's native
resolution rules. Moving this output elsewhere requires a deployment/linking step.
Call the example before `expiresAt` in its manifest. Use another new directory to
rebuild after expiry; there is no automatic rebuild or delivery scheduler yet.

```js
export function checksum(value) {
  let result = value | 0;
  for (let i = 0; i < 12; i++) {
    result = ((result << 5) - result + i) | 0;
  }
  return result;
}
```

## Supported boundary

| Area         | Implemented in format `JOVLT-R0`                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Modules      | Top-level function declarations; named/default function exports and aliases; named/default imports used as direct function calls |
| Values       | Numbers, strings, booleans, `null`, `undefined`; computed `NaN`, infinities and signed zero                                      |
| Locals       | Identifier parameters, initialized or uninitialized `let`, initialized `const`, block scopes and assignment checks               |
| Control flow | `if`/`else`, `while`, `for`, `return`, conditional expressions, logical AND and OR with short-circuit evaluation                 |
| Operators    | Arithmetic, bitwise and shifts, comparisons, strict equality, unary operators, numeric updates and compound assignments          |
| Calls        | Direct local functions and explicitly supplied imported functions; primitive inputs/results only                                 |

Unsupported forms produce a located `CompileError`. There is no source execution
fallback. Objects, arrays, closures, methods, classes, exceptions, async/generators,
BigInt, symbols, loose equality, destructuring, `var`, disposal declarations,
`break`/`continue`, namespace/side-effect imports, re-exports and mutable exported
state are outside this phase. Using an imported/local function as a first-class
value is also unsupported. Local reads before declaration are rejected at compile
time, even in unreachable branches. General ECMAScript equivalence is not claimed.

The ESM bridge preserves aliases to the same exported function object and reads
live imported function bindings when invoked. Protected functions are wrappers:
their names, `toString`, stack traces, constructor behavior and other reflection are
outside the contract. Full module-graph linking, cycles, heap semantics, and general
browser module-loader equivalence remain future work. The new compiler-input graph
discovers dependencies and preserves source; it does not link or execute them.
Native static dependencies evaluate before the wrapper checks expiry, so expiry
cannot prevent their initialization.

## Ten-minute policy and trust

The epoch is `floor(buildTime / 600000)`. The validity interval is
`[epoch * 600000, (epoch + 1) * 600000)`. A build near the end of an epoch has less
than ten minutes left. There is no grace window. The R0 cooperative runtime checks time
at instantiation, exported invocation, each instruction, and after a host returns.
An operation cannot return a VM result after the supplied clock reports expiry.
Already completed host effects cannot be undone; a blocking host call cannot be
preempted by this interpreter.

A recipient can patch these checks, freeze the clock, copy an old interpreter or
normalize the public opcode mapping. Matching profiles and the CLI's hash manifest
detect accidental mismatches. The separate `JOVLT-P1` package foundation uses
Ed25519 signatures and SHA-256 to bind payload bytes, runtime identity, application,
deployment, ABI, and validity interval to a caller-supplied trusted public key.
It authenticates a package to an intact verifier. Keep secrets and authorization
on a server. Hard revocation requires an authority outside the
recipient's control, as specified in the [delivery plan](ROADMAP.md).

Each build selects a time-scoped dialect. A remote authority, production trust-key
distribution, and background rotation are still planned. Signed bytes can be replayed
within their accepted policy unless a server independently rejects them. No claim
about analyst effort follows from changing opcode bytes.

The unmodified Boa probe retained the complete original source as UTF-16LE in its
checkpoint after the input buffers were cleared. Engine memory also contains
constants, heap values, and metadata. Compiling Rust to Wasm does not encrypt those
bytes. Patched checkpoints passed exact full-source and comment-marker absence
checks; literals and other reconstructable program data remain. Inspection of all
restored engine state remains an acceptance gate. Never load a raw untrusted
engine-memory image.

## Limits and evidence

The [register contract](../src/register-contract.ts) caps source size at 1 MiB, total instructions at
100,000, functions at 256, locals per function at 4,096, arguments at 64, strings at
8,192 UTF-16 code units, registers per frame at 8,192, call depth at 64, and invocation
steps at 200,000. Runtime options can lower the step limit. Bytecode data is bounded,
validated and snapshotted before execution. Host functions are trusted capabilities;
these limits cannot bound their own effects or CPU time. The interpreter is not a
host-code sandbox.

The [evidence record](VALIDATION.md) identifies performed tests, browser checks and the local
synthetic cost pilot. A small official Test262 slice has now run through a separate
checkpoint-runner profile; broad conformance, independent analysis resistance,
production signed delivery, and production workloads remain unestablished.
The [research basis](RESEARCH.md) cites language and tooling sources; the
[roadmap](ROADMAP.md) defines experiments and expansion gates.

The [architecture](ARCHITECTURE.md) explains the R0 pipeline, compiler-input graph,
package boundary, Boa probe, and the different roles of JavaScript, Rust, and Wasm.

To repeat the local pilot and retain samples in a new file:

```sh
npm run jovault:measure -- jovault-cost-pilot.json
npm run check
npm run quality:repo
npm run format:check
```

The pilot includes native and VM execution of identical synthetic modules. It
records source/implementation hashes, samples and environment; it does not measure
browser performance or the security benefit of rotation.

The frontend lowers its internal expression IR into register instructions. Its
stack interpreter lives only under `tests/` as a semantic reference. The CLI and public
R0 module entry use `register-runtime.ts`, with no reference-runtime fallback.
The demo defaults to R0 and uses the signed checkpoint loader only when Boa is selected.
JoVault has its own format and dialect domain. It does not expose JoVM deployment
secrets or prevent general compiler-analysis knowledge from transferring between
projects.
