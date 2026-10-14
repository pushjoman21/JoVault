import { boa } from '/trust.mjs';

const $ = (id) => document.getElementById(id);
const example = `export function main(value) {
  let mixed = value | 0;
  for (let i = 0; i < 8; i++) {
    mixed = ((mixed ^ (i + 17)) * 31) | 0;
  }
  return mixed >>> 0;
}
`;
let compilation = null;
let revision = 0;
let selectedOutput = 'bytecode';
let compilePending = false;
const workers = new Map();
const results = new Map();
$('source').value = example;
if (boa.available) {
  $('boa-option').disabled = false;
  $('boa-option').textContent = 'Boa checkpoint';
  $('engine-note').textContent =
    'Boa is enabled with reviewed, pinned runtime and audit assets. It compiles one module; browser execution remains experimental.';
}

function status(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}
function drawOutput() {
  $('bytecode').setAttribute('aria-pressed', String(selectedOutput === 'bytecode'));
  $('wrapper').setAttribute('aria-pressed', String(selectedOutput === 'wrapper'));
  const checkpoint = $('engine').value === 'boa';
  $('output').placeholder = checkpoint
    ? 'The signed checkpoint manifest will appear here.'
    : 'Your compiled bytecode will appear here.';
  $('bytecode').textContent = checkpoint ? 'Checkpoint' : 'Bytecode';
  $('wrapper').disabled = checkpoint;
  $('output').value =
    checkpoint && compilation
      ? JSON.stringify(
          {
            envelope: compilation.envelope,
            metadata: compilation.metadata,
            exportNames: compilation.exportNames,
          },
          null,
          2,
        )
      : compilation
        ? selectedOutput === 'wrapper'
          ? compilation.wrapper
          : JSON.stringify(compilation.artifact, null, 2)
        : '';
  $('print-output').textContent = $('output').value;
}
function stopRuns() {
  for (const { worker, timer } of workers.values()) {
    worker.terminate();
    clearTimeout(timer);
  }
  workers.clear();
  $('native').disabled = false;
  $('vm').disabled = !compilation;
}
function clearResults() {
  stopRuns();
  results.clear();
  $('native-result').textContent = 'Not run';
  $('vm-result').textContent = compilation ? 'Not run' : 'Compile first';
  $('native-time').textContent = '';
  $('vm-time').textContent = '';
  $('comparison').textContent = 'Runs use the same arguments in separate browser workers.';
}
function invalidate() {
  $('print-source').textContent = $('source').value;
  revision++;
  compilation = null;
  $('dialect').textContent = '';
  drawOutput();
  clearResults();
  $('profile').textContent =
    'Compile to see the artifact format, dialect, instruction count, and expiry.';
  status('Source changed. Compile to update the output.');
}
$('source').addEventListener('input', invalidate);
$('engine').addEventListener('change', () => {
  selectedOutput = 'bytecode';
  invalidate();
  status('Engine changed. Compile to update the output.');
});
$('print-source').textContent = $('source').value;
$('args').addEventListener('input', clearResults);
$('reset').addEventListener('click', () => {
  $('source').value = example;
  $('args').value = '[123]';
  invalidate();
});
for (const name of ['bytecode', 'wrapper'])
  $('' + name).addEventListener('click', () => {
    selectedOutput = name;
    drawOutput();
  });
$('compile').addEventListener('click', async () => {
  if (compilePending) return;
  compilation = null;
  clearResults();
  drawOutput();
  const current = revision;
  compilePending = true;
  $('compile').disabled = true;
  status('Compiling…');
  try {
    const response = await fetch('/api/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: $('source').value, engine: $('engine').value }),
    });
    const payload = await response.json();
    if (current !== revision) return;
    if (!response.ok) throw new Error(payload.error ?? 'Compilation failed.');
    compilation = payload;
    if ($('engine').value === 'boa') {
      $('dialect').textContent = JSON.stringify(payload.envelope.manifest, null, 2);
      drawOutput();
      $('vm').disabled = false;
      $('vm-result').textContent = 'Not run';
      $('profile').textContent =
        `Signed Boa checkpoint. ${payload.metadata.memoryBytes} memory bytes. Expires at ${new Date(payload.envelope.manifest.expiresAt).toLocaleTimeString()}. Temporary server key ${payload.envelope.keyId}. The browser verifies the package and pinned runtime before restoring a fresh WASM instance. This experimental checkpoint has no secrecy or hard-revocation guarantee.`;
      status('Boa checkpoint compiled and signed locally. Run JoVault to verify and execute it.');
      return;
    }
    $('dialect').textContent = JSON.stringify(payload.dialect, null, 2);
    drawOutput();
    $('vm').disabled = false;
    $('vm-result').textContent = 'Not run';
    const count = payload.artifact.functions.reduce((sum, fn) => sum + fn.code.length, 0);
    $('profile').textContent =
      `${payload.artifact.format}. Dialect ${payload.dialect.id}. ${count} instructions across ${payload.artifact.functions.length} function(s). Valid from ${new Date(payload.artifact.notBefore).toLocaleTimeString()} until ${new Date(payload.artifact.expiresAt).toLocaleTimeString()}. Signed package ${payload.envelope.manifest.format}; key ${payload.envelope.keyId}. This local server uses temporary signing keys. Trust is loaded from this demo origin; restarting the server requires recompilation. The ESM wrapper is an unsigned inspection example; Run JoVault verifies the signed package.`;
    status('Compiled and signed locally. Run JoVault to verify and execute the package.');
  } catch (error) {
    if (current === revision) {
      compilation = null;
      drawOutput();
      clearResults();
      status(error instanceof Error ? error.message : 'Compilation failed.', true);
    }
  } finally {
    compilePending = false;
    $('compile').disabled = false;
  }
});

function argumentsValue() {
  const args = JSON.parse($('args').value);
  if (
    !Array.isArray(args) ||
    args.length > 64 ||
    !args.every(
      (value) => value === null || ['string', 'boolean', 'number'].includes(typeof value),
    ) ||
    args.some(
      (value) =>
        (typeof value === 'string' && value.length > 8192) ||
        (typeof value === 'number' && !Number.isFinite(value)),
    )
  ) {
    throw new TypeError(
      'Use a JSON array of at most 64 primitive arguments; strings are limited to 8,192 characters and numbers must be finite.',
    );
  }
  return args;
}
function run(kind) {
  if (workers.has(kind) || (kind === 'vm' && !compilation)) return;
  let args;
  try {
    args = argumentsValue();
  } catch (error) {
    status(error.message, true);
    return;
  }
  const id = crypto.randomUUID();
  const start = performance.now();
  const engine = $('engine').value;
  const worker = new Worker(kind === 'vm' && engine === 'boa' ? '/boa-runner.mjs' : '/runner.mjs', {
    type: 'module',
  });
  const button = $(kind === 'native' ? 'native' : 'vm');
  results.delete(kind);
  $('comparison').textContent = 'Run both versions to compare their return values.';
  button.disabled = true;
  $(`${kind}-result`).textContent = 'Running…';
  $(`${kind}-time`).textContent = '';
  function finish(data) {
    if (!workers.has(kind)) return;
    const elapsed = performance.now() - start;
    clearTimeout(workers.get(kind).timer);
    worker.terminate();
    workers.delete(kind);
    button.disabled = kind === 'vm' && !compilation;
    $(`${kind}-result`).textContent = data.ok ? data.display : `Error: ${data.error}`;
    $(`${kind}-time`).textContent = `${elapsed.toFixed(1)} ms including worker startup`;
    if (data.ok) results.set(kind, { display: data.display, type: data.type });
    else results.delete(kind);
    if (results.has('native') && results.has('vm')) {
      const a = results.get('native');
      const b = results.get('vm');
      $('comparison').textContent =
        a.type === b.type && a.display === b.display
          ? 'Both runs returned the same value.'
          : 'The runs returned different values.';
    } else $('comparison').textContent = 'Run both versions to compare their return values.';
  }
  const timer = setTimeout(() => finish({ ok: false, error: 'Stopped after 2 seconds.' }), 2000);
  workers.set(kind, { worker, timer });
  worker.onmessage = ({ data }) => {
    if (data?.id !== id || typeof data.ok !== 'boolean') return;
    if (
      data.ok &&
      (typeof data.display !== 'string' ||
        data.display.length > 8192 ||
        typeof data.type !== 'string')
    )
      return;
    if (!data.ok && (typeof data.error !== 'string' || data.error.length > 8192)) return;
    finish(data);
  };
  worker.onerror = () =>
    finish({ ok: false, error: 'Worker failed. Check the source and browser console.' });
  worker.postMessage(
    kind === 'native'
      ? { id, kind, args, source: $('source').value }
      : { id, kind, engine, args, envelope: compilation.envelope, payload: compilation.payload },
  );
}
$('native').addEventListener('click', () => run('native'));
$('vm').addEventListener('click', () => run('vm'));
