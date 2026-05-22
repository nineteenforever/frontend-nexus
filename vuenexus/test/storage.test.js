import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { indexFrontendProject } from '../dist/indexer.js';
import { defaultLbugPath, vuenexusRegistryPath, writeVueNexusLbug } from '../dist/lbug-writer.js';

const fixtureRoot = path.resolve('test/fixtures/vue-app');

test('writes VueNexus graph storage under .vuenexus by default', async () => {
  const graph = indexFrontendProject(fixtureRoot);
  const written = await writeVueNexusLbug(graph, fixtureRoot, {
    registry: false,
    name: 'fixture',
  });

  assert.equal(written.storagePath, path.join(fixtureRoot, '.vuenexus'));
  assert.equal(written.lbugPath, path.join(fixtureRoot, '.vuenexus', 'lbug'));
  assert.equal(defaultLbugPath(fixtureRoot), written.lbugPath);
  assert.ok(fs.existsSync(path.join(written.storagePath, 'meta.json')));
});

test('uses the VueNexus registry path', () => {
  assert.equal(vuenexusRegistryPath(), path.join(os.homedir(), '.vuenexus', 'registry.json'));
});
