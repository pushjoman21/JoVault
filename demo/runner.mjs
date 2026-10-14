import { instantiatePackage, prepareBoaRuntime, instantiateBoaPackage } from '/runtime.mjs';
import { trust, expected, boa } from '/trust.mjs';

const MAX_RESULT = 8192;
const primitive = (value) =>
  value === null || ['undefined', 'boolean', 'number', 'string'].includes(typeof value);

function describe(value) {
  if (!primitive(value)) throw new TypeError('Return a primitive value.');
  let display;
  if (typeof value === 'string') display = JSON.stringify(value);
  else if (Object.is(value, -0)) display = '-0';
  else display = String(value);
  if (display.length > MAX_RESULT) throw new RangeError('Result exceeds 8,192 characters.');
  return { display, type: value === null ? 'null' : typeof value };
}

async function boaInstance(data) {
  if (!boa.available || new URL(import.meta.url).pathname !== '/boa-runner.mjs') {
    throw new TypeError('Boa is unavailable in this worker profile.');
  }
  const assets = await Promise.all(
    [boa.wasmUrl, boa.auditUrl].map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error('Boa runtime asset unavailable.');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > 67_108_864)) {
        throw new RangeError('Boa runtime asset exceeds its limit.');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 67_108_864) throw new RangeError('Boa runtime asset exceeds its limit.');
      return bytes;
    }),
  );
  const runtime = await prepareBoaRuntime(assets[0], assets[1], {
    runtimeSha256: boa.runtimeSha256,
    auditSha256: boa.auditSha256,
  });
  if (
    typeof data.payload !== 'string' ||
    data.payload.length > 89_478_488 ||
    data.payload.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(data.payload)
  ) {
    throw new TypeError('Invalid checkpoint transport.');
  }
  const binary = atob(data.payload);
  if (binary.length > 67_108_864) throw new RangeError('Checkpoint exceeds its limit.');
  const payload = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return instantiateBoaPackage(data.envelope, payload, trust, boa.expected, runtime);
}

self.onmessage = async ({ data }) => {
  const id = data?.id;
  if (
    typeof id !== 'string' ||
    !Array.isArray(data.args) ||
    data.args.length > 64 ||
    !data.args.every(primitive)
  )
    return;
  try {
    let result;
    if (data.kind === 'native' && typeof data.source === 'string') {
      const url = URL.createObjectURL(new Blob([data.source], { type: 'text/javascript' }));
      try {
        const module = await import(url);
        if (typeof module.main !== 'function') throw new TypeError('Export a function named main.');
        result = await module.main(...data.args);
      } finally {
        URL.revokeObjectURL(url);
      }
    } else if (data.kind === 'vm' && data.engine === 'boa') {
      const instance = await boaInstance(data);
      result = instance.invoke(data.args);
    } else if (data.kind === 'vm' && data.engine === 'register') {
      if (typeof data.payload !== 'string') throw new TypeError('Missing signed package payload.');
      const instance = await instantiatePackage(
        data.envelope,
        new TextEncoder().encode(data.payload),
        trust,
        expected,
        [],
      );
      result = instance.invoke('main', data.args);
    } else throw new TypeError('Unknown execution mode.');
    self.postMessage({ id, ok: true, ...describe(result) });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message.slice(0, MAX_RESULT) : 'Execution failed.',
    });
  }
};
