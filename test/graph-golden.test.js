import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createEmbeddingsForNodes } from '../src/embedding.js';
import { indexFrontendProject } from '../src/indexer.js';

const fixtureRoot = path.resolve('test/fixtures/vue-app');

function graphRows() {
  const graph = indexFrontendProject(fixtureRoot);
  return {
    graph,
    nodes: [...graph.nodes.values()],
    edges: [...graph.edges.values()],
  };
}

function findNode(nodes, type, name, filePath) {
  return nodes.find(
    (node) => node.type === type && node.name === name && (!filePath || node.filePath === filePath),
  );
}

function hasEdge(edges, type, source, target) {
  return edges.some((edge) => edge.type === type && edge.source === source && edge.target === target);
}

test('indexes the frontend fixture without TypeScript diagnostics', () => {
  const { graph } = graphRows();
  assert.equal(graph.diagnostics.length, 0);
  assert.equal(graph.files, 5);
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
