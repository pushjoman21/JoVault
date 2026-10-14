<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/jovm-mark.svg">
  <img src="assets/jovm-mark-light.svg" width="48" height="38" alt="JoVM mark">
</picture>

# JoVault

A JavaScript compiler and register-VM research project. Compile supported code,
inspect its instructions, and compare native execution with the matching VM.

[Research](https://jomanvm.vercel.app/posts/2026-10-14-jovault-register-vm.html) · [Guide](docs/USAGE.md) · [Compatibility](docs/COMPATIBILITY.md) · [Validation](docs/VALIDATION.md)

Experimental [research preview](https://github.com/pushjoman21/JoVault/releases/tag/research-preview-2026-10-14). Full JavaScript support and resistance to reverse
engineering remain unproven. Code delivered to a browser remains inspectable.

## Try it

Use Node.js >=24.11.0 <25 and npm. From the repository root:

```sh
npm ci
npm run test:jovault
npm run jovault:demo
```

Open [127.0.0.1:4971](http://127.0.0.1:4971). Edit JavaScript, compile it, then run
the original and compiled versions locally with the same arguments.

## What runs

| Path            | Current contract                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| R0, the default | 32 operations, primitive values, loops and direct calls; function imports and exports through native ESM.                                          |
| Boa, optional   | A Rust JavaScript engine compiled to Wasm; explicit module graphs, signed checkpoints and fresh-instance execution. Requires pinned engine assets. |

Unsupported R0 syntax produces an error. Boa has no ambient DOM, Node, network or
filesystem access; its exposed arguments and results are primitive values.
[The guide](docs/USAGE.md#enable-the-experimental-boa-path) explains how to enable it.
[Validation](docs/VALIDATION.md) distinguishes measured results from open work.

## Security boundary

Signed packages bind code, runtime, deployment and expiry. R0 changes its opcode
mapping in ten-minute epochs. Local expiry checks can be patched by the client
owner; they cannot revoke a copied algorithm. Keep secrets and authorization on a
server. [Architecture](docs/ARCHITECTURE.md) explains the trust boundaries.
