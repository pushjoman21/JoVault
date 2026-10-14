import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import { chromium } from '@playwright/test';
import { createDemoServer, type DemoServerOptions } from '../demo/server.js';

const environment = [
  process.env.JOVAULT_BOA_WASM,
  process.env.JOVAULT_BOA_AUDIT,
  process.env.JOVAULT_BOA_WASM_SHA256,
  process.env.JOVAULT_BOA_AUDIT_SHA256,
];
if (
  environment.some((value) => value !== undefined) &&
  !environment.every((value) => typeof value === 'string' && value.length > 0)
) {
  throw new Error('Provide all four JOVAULT_BOA asset and SHA-256 settings for browser coverage.');
}
const options: DemoServerOptions = environment.every(
  (value) => typeof value === 'string' && value.length > 0,
)
  ? {
      boa: {
        wasmPath: environment[0]!,
        auditPath: environment[1]!,
        wasmSha256: environment[2]!,
        auditSha256: environment[3]!,
      },
    }
  : {};

async function openDemo(t: TestContext) {
  await access(chromium.executablePath());
  const app = await createDemoServer(options);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    try {
      await browser?.close();
    } finally {
      app.server.closeAllConnections();
      await app.close();
    }
  });
  const origin = await app.listen({ port: 0, host: '127.0.0.1' });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  await page.goto(origin);
  return page;
}

// Explicit browser check: tsx --test side_pr/JoVault/tests/demo.browser.ts
test(
  'native worker awaits async results and errors while retaining its parent timeout',
  { timeout: 20_000 },
  async (t) => {
    const page = await openDemo(t);
    await page.locator('#args').fill('[35]');
    await page
      .locator('#source')
      .fill('export async function main(value) { return await Promise.resolve(value + 7); }');
    await page.locator('#native').click();
    await page.waitForFunction(
      () => document.getElementById('native-result')?.textContent === '42',
    );
    assert.equal(await page.locator('#native-result').textContent(), '42');

    await page
      .locator('#source')
      .fill('export async function main() { throw new Error("async failure"); }');
    await page.locator('#native').click();
    await page.waitForFunction(
      () => document.getElementById('native-result')?.textContent === 'Error: async failure',
    );

    await page
      .locator('#source')
      .fill('export async function main() { return new Promise(() => {}); }');
    await page.locator('#native').click();
    await page.waitForFunction(
      () =>
        document.getElementById('native-result')?.textContent === 'Error: Stopped after 2 seconds.',
    );

    await page.locator('#source').fill('export function main() { return 8; }');
    await page.locator('#native').click();
    await page.waitForFunction(() => document.getElementById('native-result')?.textContent === '8');
    assert.equal(await page.locator('#native').isEnabled(), true);
  },
);

test(
  'reviewed Boa checkpoint and native workers agree on an async private-class result',
  { skip: !options.boa, timeout: 30_000 },
  async (t) => {
    const page = await openDemo(t);
    const workers: string[] = [];
    page.on('worker', (worker) => workers.push(new URL(worker.url()).pathname));
    await page.locator('#engine').selectOption('boa');
    await page.locator('#args').fill('[35]');
    await page.locator('#source').fill(`class Offset {
  #delta = 7;
  async apply(value) { return await Promise.resolve(value + this.#delta); }
}
export async function main(value) { return await new Offset().apply(value); }`);
    const compiledResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/compile' &&
        response.request().method() === 'POST',
    );
    await page.locator('#compile').click();
    const response = await compiledResponse;
    assert.equal(response.status(), 200, await response.text());
    const compiled = await response.json();
    assert.equal(compiled.engine, 'boa');
    assert.equal(compiled.envelope.manifest.kind, 'boa-checkpoint');
    assert.equal(compiled.envelope.manifest.runtimeSha256, options.boa!.wasmSha256);
    assert.equal(compiled.metadata.auditSha256, options.boa!.auditSha256);
    assert.equal(compiled.metadata.instructionBudget, 200_000);
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#vm')?.disabled);
    const displayed = JSON.parse(await page.locator('#output').inputValue());
    assert.equal(displayed.envelope.manifest.kind, 'boa-checkpoint');
    assert.ok(displayed.metadata.memoryBytes > 0);
    assert.equal(displayed.payload, undefined);
    assert.equal(await page.locator('#wrapper').isDisabled(), true);
    await page.locator('#native').click();
    await page.waitForFunction(
      () => document.getElementById('native-result')?.textContent === '42',
    );
    await page.locator('#vm').click();
    await page.waitForFunction(() => document.getElementById('vm-result')?.textContent === '42');
    assert.equal(
      await page.locator('#comparison').textContent(),
      'Both runs returned the same value.',
    );
    assert.ok(workers.includes('/runner.mjs'));
    assert.ok(workers.includes('/boa-runner.mjs'));
  },
);
