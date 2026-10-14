// Reads pinned source bytes and Git metadata only. Never evaluates guest JavaScript.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function headCommit(root) {
  let gitDirectory = path.join(root, '.git');
  if (!(await stat(gitDirectory)).isDirectory()) {
    const pointer = (await readFile(gitDirectory, 'utf8')).trim();
    assert.match(pointer, /^gitdir: /u);
    gitDirectory = path.resolve(root, pointer.slice(8));
  }
  let commonDirectory = gitDirectory;
  try {
    commonDirectory = path.resolve(
      gitDirectory,
      (await readFile(path.join(gitDirectory, 'commondir'), 'utf8')).trim(),
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const head = (await readFile(path.join(gitDirectory, 'HEAD'), 'utf8')).trim();
  if (/^[a-f0-9]{40}$/u.test(head)) return head;
  assert.match(head, /^ref: refs\/[a-zA-Z0-9_./-]+$/u);
  const reference = head.slice(5);
  assert.ok(!reference.split('/').includes('..'));
  for (const directory of [gitDirectory, commonDirectory]) {
    try {
      return (await readFile(path.join(directory, reference), 'utf8')).trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const packed = (await readFile(path.join(commonDirectory, 'packed-refs'), 'utf8')).split('\n');
  const match = packed.find((line) => line.endsWith(' ' + reference));
  assert.ok(match, 'Git HEAD reference is unavailable');
  return match.split(' ')[0];
}

function inlineList(frontmatter, key) {
  const field = frontmatter.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  if (!field) return [];
  assert.match(field[1], /^\[[^\]\r\n]*\][ \t]*$/u, `reviewed metadata changed shape: ${key}`);
  return field[1]
    .trim()
    .slice(1, -1)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function verifyCases(sourceRoot) {
  const bundle = JSON.parse(await readFile(new URL('cases.json', import.meta.url), 'utf8'));
  const profile = JSON.parse(await readFile(new URL('profile.json', import.meta.url), 'utf8'));
  const classification = JSON.parse(
    await readFile(new URL('classification-summary.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(bundle.profile, profile);
  assert.equal(
    await headCommit(sourceRoot),
    profile.test262Commit,
    'official source Git pin differs',
  );
  assert.equal(profile.test262Commit, 'd53ebc8b1931d9f1541e43d59650776e4b766248');
  assert.ok(Number.isSafeInteger(profile.selectedLimit) && profile.selectedLimit > 0);
  assert.equal(bundle.cases.length, profile.selectedLimit);
  assert.equal(new Set(profile.selectedPaths).size, profile.selectedLimit);
  assert.deepEqual(
    bundle.cases.map((entry) => entry.name),
    profile.selectedPaths,
  );
  assert.equal(classification.discovered, 53616);
  assert.equal(classification.selected, bundle.cases.length);
  assert.equal(
    classification.selected +
      classification.eligibleNotSelected +
      classification.excludedFromInitialSlice,
    classification.discovered,
  );
  const checkedSources = new Map();
  const readOriginal = async (relativeName) => {
    assert.ok(
      !path.isAbsolute(relativeName) &&
        !relativeName.includes('\\') &&
        !relativeName.split('/').includes('..'),
    );
    return readFile(path.join(sourceRoot, relativeName));
  };
  for (const [filename, expected] of Object.entries(bundle.supportHashes)) {
    const bytes = await readOriginal(filename);
    assert.equal(sha256(bytes), expected, `support file changed: ${filename}`);
  }
  assert.equal(classification.featuresSha256, bundle.supportHashes['features.txt']);
  assert.deepEqual(
    await readFile(new URL('LICENSE.test262', import.meta.url)),
    await readOriginal('LICENSE'),
  );
  const allowedFeatures = new Set(profile.allowedFeatures);
  for (const entry of bundle.cases) {
    assert.equal(entry.expected, profile.driverSentinel);
    assert.equal(entry.graph.format, 'JOVLT-BOA-INPUT1');
    assert.equal(entry.graph.entry, '/__jovault_test262_driver.mjs');
    assert.equal(entry.graph.globalScripts.length, 2);
    assert.ok(entry.graph.modules.length > 1 && entry.graph.modules.length + 2 <= 128);
    const identities = new Set();
    for (const [index, script] of entry.graph.globalScripts.entries()) {
      assert.deepEqual(Object.keys(script).sort(), ['id', 'source']);
      assert.equal(script.id, '/__harness/' + profile.harness[index]);
      const bytes = await readOriginal('harness/' + profile.harness[index]);
      assert.deepEqual(
        Buffer.from(script.source, 'utf8'),
        bytes,
        'original harness text/strictness changed',
      );
      assert.ok(!identities.has(script.id));
      identities.add(script.id);
    }
    let originalCount = 0;
    for (const module of entry.graph.modules) {
      assert.deepEqual(Object.keys(module).sort(), ['id', 'source']);
      assert.match(module.id, /^\/[a-zA-Z0-9_./-]+$/u);
      assert.ok(!module.id.split('/').includes('..') && !identities.has(module.id));
      identities.add(module.id);
      if (module.id === entry.graph.entry) {
        assert.equal(
          module.source,
          `import ${JSON.stringify('./' + entry.name)};\nexport function main() { return ${profile.driverSentinel}; }\n`,
        );
      } else {
        const filename = module.id.slice(1);
        const bytes = await readOriginal(filename);
        assert.deepEqual(
          Buffer.from(module.source, 'utf8'),
          bytes,
          `test or dependency source changed: ${filename}`,
        );
        assert.equal(sha256(bytes), entry.sourceHashes[module.id]);
        checkedSources.set(filename, sha256(bytes));
        originalCount++;
      }
    }
    assert.equal(Object.keys(entry.sourceHashes).length, originalCount);
    const test = entry.graph.modules.find((module) => module.id === '/' + entry.name);
    assert.ok(test);
    assert.equal(sha256(Buffer.from(test.source, 'utf8')), entry.testSha256);
    const frontmatter = test.source.match(/\/\*---([\s\S]*?)---\*\//u)?.[1];
    assert.ok(frontmatter);
    // This verifies the fixed reviewed selection, not arbitrary YAML/Test262 inputs.
    const metadata = {
      flags: inlineList(frontmatter, 'flags'),
      features: inlineList(frontmatter, 'features'),
      includes: inlineList(frontmatter, 'includes'),
      negative: null,
    };
    assert.ok(!/^negative:/mu.test(frontmatter));
    assert.deepEqual(metadata, entry.metadata);
    assert.ok(metadata.flags.includes('module'));
    assert.ok(metadata.flags.every((flag) => profile.allowedFlags.includes(flag)));
    assert.equal(new Set(metadata.flags).size, metadata.flags.length);
    assert.equal(metadata.includes.length, 0);
    assert.ok(metadata.features.every((feature) => allowedFeatures.has(feature)));
  }
  return {
    status: 'VERIFIED_INPUTS_ONLY',
    commit: profile.test262Commit,
    selectedTests: bundle.cases.length,
    uniqueOriginalModules: checkedSources.size,
    harnessFiles: 2,
    guestCodeExecuted: false,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--source-root');
  assert.ok(
    index >= 0 && args[index + 1],
    'Usage: node verify-cases.mjs --source-root OFFICIAL_CHECKOUT',
  );
  console.log(JSON.stringify(await verifyCases(path.resolve(args[index + 1]))));
}
