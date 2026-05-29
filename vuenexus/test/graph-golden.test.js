import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEmbeddingsForNodes } from '../dist/embedding.js';
import { indexFrontendProject } from '../dist/indexer.js';

const fixtureRoot = path.resolve('test/fixtures/vue-app');

function graphRows() {
  const graph = indexFrontendProject(fixtureRoot);
  return {
    graph,
    nodes: [...graph.nodes.values()],
    edges: [...graph.edges.values()],
  };
}

function copyFixtureWithoutStorage(targetRoot) {
  fs.cpSync(fixtureRoot, targetRoot, {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes('.vuenexus'),
  });
}

function findNode(nodes, type, name, filePath) {
  return nodes.find(
    (node) => node.type === type && node.name === name && (!filePath || node.filePath === filePath),
  );
}

function hasEdge(edges, type, source, target) {
  return edges.some((edge) => edge.type === type && edge.source === source && edge.target === target);
}

function findUnresolved(nodes, kind, text) {
  return nodes.find(
    (node) => node.type === 'UnresolvedReference' && node.meta?.kind === kind && node.meta?.text === text,
  );
}

test('indexes the frontend fixture without TypeScript diagnostics', () => {
  const { graph } = graphRows();
  assert.equal(graph.diagnostics.length, 0);
  assert.equal(graph.files, 10);
});

test('reuses unchanged files from the incremental analysis cache', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vuenexus-incremental-'));
  copyFixtureWithoutStorage(tmpRoot);
  fs.rmSync(path.join(tmpRoot, '.vuenexus'), { recursive: true, force: true });

  const first = indexFrontendProject(tmpRoot);
  const second = indexFrontendProject(tmpRoot);

  assert.equal(first.cache.hitFiles, 0);
  assert.ok(second.cache.hitFiles > 0, 'second analyze should reuse cached file slices');
  assert.equal(second.nodes.size, first.nodes.size);
  assert.equal(second.edges.size, first.edges.size);
});

test('skips generated or minified JavaScript files by default', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vuenexus-generated-'));
  copyFixtureWithoutStorage(tmpRoot);
  fs.rmSync(path.join(tmpRoot, '.vuenexus'), { recursive: true, force: true });
  const generatedDir = path.join(tmpRoot, 'src', 'vendor');
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(path.join(generatedDir, 'jquery.min.js'), 'function ignored(){return true}\n');
  fs.writeFileSync(path.join(generatedDir, 'cssWorkerMain.js'), 'function ignoredWorker(){return true}\n');

  const graph = indexFrontendProject(tmpRoot);
  const included = [...graph.nodes.values()].filter((node) => node.type === 'File').map((node) => node.filePath);

  assert.equal(graph.files, 10);
  assert.equal(graph.skippedFiles.length, 2);
  assert.ok(!included.includes('src/vendor/jquery.min.js'));
  assert.ok(!included.includes('src/vendor/cssWorkerMain.js'));
});

test('extracts all expected Vue frontend node types', () => {
  const { nodes } = graphRows();
  const expected = [
    ['Component', 'App', 'src/App.vue'],
    ['Component', 'UserCard', 'src/components/UserCard.vue'],
    ['Composable', 'useUser', 'src/composables/useUser.ts'],
    ['Store', 'useUserStore', 'src/stores/user.ts'],
    ['Router', 'router', 'src/router.ts'],
    ['Route', 'user-detail', 'src/router.ts'],
    ['Variable', 'currentUser', 'src/App.vue'],
    ['Variable', 'refreshUser', 'src/App.vue'],
    ['Function', 'emitRefresh', 'src/components/UserCard.vue'],
    ['Component', 'LegacyPanel', 'src/legacy/LegacyPanel.vue'],
    ['Variable', 'title', 'src/legacy/LegacyPanel.vue'],
    ['Variable', 'localCount', 'src/legacy/LegacyPanel.vue'],
    ['Method', 'displayName', 'src/legacy/LegacyPanel.vue'],
    ['Method', 'loadUser', 'src/legacy/LegacyPanel.vue'],
    ['Method', 'saveUser', 'src/legacy/LegacyPanel.vue'],
    ['Store', 'defaultStore', 'src/legacy/store.js'],
    ['Method', 'loadUser', 'src/legacy/store.js'],
    ['Method', 'saveUser', 'src/legacy/store.js'],
    ['Variable', 'legacyMixin', 'src/legacy/mixin.js'],
    ['Function', 'JsxWidget', 'src/render/JsxWidget.jsx'],
    ['Function', 'TsxWidget', 'src/render/TsxWidget.tsx'],
  ];

  for (const [type, name, filePath] of expected) {
    assert.ok(findNode(nodes, type, name, filePath), `missing ${type}:${filePath}:${name}`);
  }
});

test('preserves precise component, template, route, composable, and store edges', () => {
  const { nodes, edges } = graphRows();
  const app = findNode(nodes, 'Component', 'App', 'src/App.vue');
  const userCard = findNode(nodes, 'Component', 'UserCard', 'src/components/UserCard.vue');
  const currentUser = findNode(nodes, 'Variable', 'currentUser', 'src/App.vue');
  const refreshUser = findNode(nodes, 'Variable', 'refreshUser', 'src/App.vue');
  const emitRefresh = findNode(nodes, 'Function', 'emitRefresh', 'src/components/UserCard.vue');
  const label = findNode(nodes, 'Variable', 'label', 'src/components/UserCard.vue');
  const useUser = findNode(nodes, 'Composable', 'useUser', 'src/composables/useUser.ts');
  const userStore = findNode(nodes, 'Store', 'useUserStore', 'src/stores/user.ts');
  const route = findNode(nodes, 'Route', 'user-detail', 'src/router.ts');

  for (const node of [app, userCard, currentUser, refreshUser, emitRefresh, label, useUser, userStore, route]) {
    assert.ok(node, 'test setup expected all target nodes to exist');
  }

  assert.ok(hasEdge(edges, 'RENDERS', app.id, userCard.id), 'App should render UserCard');
  assert.ok(hasEdge(edges, 'HANDLES', app.id, currentUser.id), 'App :user binding should point to currentUser');
  assert.ok(hasEdge(edges, 'HANDLES', app.id, refreshUser.id), 'App @refresh binding should point to refreshUser');
  assert.ok(hasEdge(edges, 'HANDLES', userCard.id, emitRefresh.id), 'UserCard @click should point to emitRefresh');
  assert.ok(hasEdge(edges, 'HANDLES', userCard.id, label.id), 'UserCard interpolation should point to label');
  assert.ok(hasEdge(edges, 'CALLS', 'File:src/App.vue', useUser.id), 'script setup should call useUser');
  assert.ok(hasEdge(edges, 'CALLS', useUser.id, userStore.id), 'useUser should call useUserStore');
  assert.ok(hasEdge(edges, 'USES_STORE', useUser.id, userStore.id), 'store usage edge should be explicit');
  assert.ok(hasEdge(edges, 'ROUTES_TO', route.id, userCard.id), 'route should point to UserCard');
});

test('captures Vue 2 options, data, props, and Vuex relationships', () => {
  const { nodes, edges } = graphRows();
  const legacy = findNode(nodes, 'Component', 'LegacyPanel', 'src/legacy/LegacyPanel.vue');
  const title = findNode(nodes, 'Variable', 'title', 'src/legacy/LegacyPanel.vue');
  const localCount = findNode(nodes, 'Variable', 'localCount', 'src/legacy/LegacyPanel.vue');
  const displayName = findNode(nodes, 'Method', 'displayName', 'src/legacy/LegacyPanel.vue');
  const mappedLoad = findNode(nodes, 'Method', 'loadUser', 'src/legacy/LegacyPanel.vue');
  const saveUser = findNode(nodes, 'Method', 'saveUser', 'src/legacy/LegacyPanel.vue');
  const store = findNode(nodes, 'Store', 'defaultStore', 'src/legacy/store.js');
  const storeLoad = findNode(nodes, 'Method', 'loadUser', 'src/legacy/store.js');
  const storeSave = findNode(nodes, 'Method', 'saveUser', 'src/legacy/store.js');
  const legacyMixin = findNode(nodes, 'Variable', 'legacyMixin', 'src/legacy/mixin.js');

  for (const node of [legacy, title, localCount, displayName, mappedLoad, saveUser, store, storeLoad, storeSave, legacyMixin]) {
    assert.ok(node, 'test setup expected all Vue 2 target nodes to exist');
  }

  assert.ok(hasEdge(edges, 'HANDLES', legacy.id, title.id), 'Vue 2 template should reference prop');
  assert.ok(hasEdge(edges, 'HANDLES', legacy.id, localCount.id), 'Vue 2 template should reference data');
  assert.ok(hasEdge(edges, 'HANDLES', legacy.id, displayName.id), 'Vue 2 template should reference computed method');
  assert.ok(hasEdge(edges, 'HANDLES', legacy.id, mappedLoad.id), 'Vue 2 template should reference mapped action');
  assert.ok(hasEdge(edges, 'HANDLES', legacy.id, saveUser.id), 'Vue 2 template should reference local method');
  assert.ok(hasEdge(edges, 'CALLS', mappedLoad.id, storeLoad.id), 'mapActions should point to Vuex action');
  assert.ok(hasEdge(edges, 'CALLS', saveUser.id, storeSave.id), 'this.$store.dispatch should point to Vuex action');
  assert.ok(hasEdge(edges, 'CALLS', saveUser.id, mappedLoad.id), 'this.loadUser should point to mapped action');
  assert.ok(hasEdge(edges, 'USES_STORE', saveUser.id, store.id), 'this.$store.dispatch should use Vuex store');
  assert.ok(hasEdge(edges, 'MIXES_IN', legacy.id, legacyMixin.id), 'Vue 2 mixins should point to imported mixin');
});

test('records unresolved graph gaps for agents to treat impact as partial', () => {
  const { nodes, edges } = graphRows();
  const missingImport = findUnresolved(nodes, 'import', './missing-mixin');
  const missingMixin = findUnresolved(nodes, 'mixin', 'MissingMixin');
  const missingWidget = findUnresolved(nodes, 'template-component', 'missing-widget');

  for (const node of [missingImport, missingMixin, missingWidget]) {
    assert.ok(node, 'expected unresolved reference node to exist');
  }

  assert.ok(
    edges.some((edge) => edge.type === 'HAS_UNRESOLVED' && edge.target === missingMixin.id),
    'unresolved mixin should be attached to its component owner',
  );
});

test('does not invent route edges for non-route path-like objects', () => {
  const { edges } = graphRows();
  const badRouteEdges = edges.filter(
    (edge) =>
      edge.type === 'ROUTES_TO' &&
      edge.reason.includes('/not-a-route'),
  );
  assert.deepEqual(badRouteEdges, []);
});

test('creates offline embeddings for non-file frontend nodes', async () => {
  const { nodes } = graphRows();
  const { rows, summary } = await createEmbeddingsForNodes(nodes, {
    provider: 'hash',
    batchSize: 8,
  });
  assert.equal(summary.provider, 'hash');
  assert.equal(summary.dimensions, 384);
  assert.equal(rows.length, nodes.filter((node) => node.type !== 'File').length);
  assert.ok(rows.every((row) => row.nodeId && row.embedding.length === 384 && row.contentHash));
});
