// @ts-nocheck
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { semanticSearchLbug } from './embedding.js';
import { queryVueNexusLbug } from './lbug-writer.js';
import { buildGraph, searchGraph } from './server.js';

function jsonContent(value) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function compactNode(node) {
  const meta = node.properties?.description ? JSON.parse(node.properties.description) : {};
  return {
    id: node.id,
    type: node.label,
    name: node.properties?.name,
    filePath: node.properties?.filePath,
    startLine: node.properties?.startLine,
    endLine: node.properties?.endLine,
    kind: node.properties?.kind ?? meta.kind,
    text: node.properties?.text ?? meta.text,
    reason: node.properties?.reason ?? meta.reason,
    ownerId: node.properties?.ownerId ?? meta.ownerId,
    meta,
  };
}

function compactEdge(edge) {
  return {
    source: edge.sourceId,
    target: edge.targetId,
    type: edge.type,
    confidence: edge.properties?.confidence,
    reason: edge.properties?.reason,
    line: edge.properties?.step,
  };
}

function findNodes(graph, symbolOrId, limit = 20) {
  const needle = symbolOrId.toLowerCase();
  return graph.nodes
    .filter((node) => {
      const name = String(node.properties?.name ?? '').toLowerCase();
      return node.id === symbolOrId || name === needle || node.id.toLowerCase().includes(needle);
    })
    .slice(0, limit);
}

function graphSlice(graph, symbolOrId, limit) {
  const seeds = findNodes(graph, symbolOrId, limit);
  const seedIds = new Set(seeds.map((node) => node.id));
  const edges = graph.relationships
    .filter((edge) => seedIds.has(edge.sourceId) || seedIds.has(edge.targetId))
    .slice(0, limit);
  const ids = new Set([...seedIds, ...edges.flatMap((edge) => [edge.sourceId, edge.targetId])]);
  return {
    nodes: graph.nodes.filter((node) => ids.has(node.id)),
    edges,
  };
}

function callChain(graph, from, depth, limit) {
  const seeds = findNodes(graph, from, 10);
  const allowed = new Set(['CALLS', 'RENDERS', 'HANDLES', 'ROUTES_TO', 'USES_STORE', 'MIXES_IN']);
  const seenNodes = new Set(seeds.map((node) => node.id));
  const seenEdges = [];
  let frontier = seeds.map((node) => node.id);
  for (let i = 0; i < depth && frontier.length && seenEdges.length < limit; i++) {
    const next = [];
    for (const edge of graph.relationships) {
      if (!allowed.has(edge.type) || !frontier.includes(edge.sourceId)) continue;
      seenEdges.push(edge);
      if (!seenNodes.has(edge.targetId)) {
        seenNodes.add(edge.targetId);
        next.push(edge.targetId);
      }
      if (seenEdges.length >= limit) break;
    }
    frontier = next;
  }
  return {
    nodes: graph.nodes.filter((node) => seenNodes.has(node.id)),
    edges: seenEdges,
  };
}

function unresolvedNodes(graph, kind) {
  return graph.nodes.filter((node) => {
    if (node.label !== 'UnresolvedReference') return false;
    return !kind || node.properties?.kind === kind;
  });
}

function unresolvedReport(graph, kind, limit) {
  const nodes = unresolvedNodes(graph, kind);
  const byKind = {};
  for (const node of nodes) {
    const k = node.properties?.kind ?? 'unknown';
    byKind[k] = (byKind[k] ?? 0) + 1;
  }
  return {
    total: nodes.length,
    byKind,
    unresolved: nodes.slice(0, limit).map(compactNode),
  };
}

function relatedUnresolved(graph, impactedIds, seedFiles, limit = 50) {
  const ownerIds = new Set(impactedIds);
  const files = new Set(seedFiles.filter(Boolean));
  const viaEdge = new Set(
    graph.relationships
      .filter((edge) => edge.type === 'HAS_UNRESOLVED' && ownerIds.has(edge.sourceId))
      .map((edge) => edge.targetId),
  );
  return graph.nodes
    .filter((node) => {
      if (node.label !== 'UnresolvedReference') return false;
      return viaEdge.has(node.id) || ownerIds.has(node.properties?.ownerId) || files.has(node.properties?.filePath);
    })
    .slice(0, limit)
    .map(compactNode);
}

function impactRadius(graph, symbolOrId, depth, limit) {
  const seeds = findNodes(graph, symbolOrId, 10);
  const allowed = new Set(['CALLS', 'RENDERS', 'HANDLES', 'ROUTES_TO', 'USES_STORE', 'MIXES_IN', 'IMPORTS', 'DEFINES']);
  const seenNodes = new Set(seeds.map((node) => node.id));
  const seenEdges = [];
  let frontier = seeds.map((node) => node.id);

  for (let i = 0; i < depth && frontier.length && seenEdges.length < limit; i++) {
    const next = [];
    for (const edge of graph.relationships) {
      if (!allowed.has(edge.type) || !frontier.includes(edge.targetId)) continue;
      seenEdges.push(edge);
      if (!seenNodes.has(edge.sourceId)) {
        seenNodes.add(edge.sourceId);
        next.push(edge.sourceId);
      }
      if (seenEdges.length >= limit) break;
    }
    frontier = next;
  }

  const impactedNodes = graph.nodes.filter((node) => seenNodes.has(node.id));
  const unresolved = relatedUnresolved(
    graph,
    seenNodes,
    impactedNodes.map((node) => node.properties?.filePath),
  );
  return {
    confidence: unresolved.length ? 'partial' : 'complete',
    seeds: seeds.map(compactNode),
    nodes: impactedNodes.map(compactNode),
    edges: seenEdges.map(compactEdge),
    unresolvedBlockers: unresolved,
    note: unresolved.length
      ? 'Impact radius may be incomplete. Inspect unresolvedBlockers before treating empty or small impact as safe.'
      : 'No unresolved blockers were found near this impact slice.',
  };
}

function stats(graph) {
  const byNodeType = {};
  const byEdgeType = {};
  for (const node of graph.nodes) byNodeType[node.label] = (byNodeType[node.label] ?? 0) + 1;
  for (const edge of graph.relationships) byEdgeType[edge.type] = (byEdgeType[edge.type] ?? 0) + 1;
  return {
    nodes: graph.nodes.length,
    edges: graph.relationships.length,
    byNodeType,
    byEdgeType,
  };
}

export async function runMcpServer(lbugPath) {
  const server = new McpServer({
    name: 'vuenexus',
    version: '0.1.0',
  });

  server.tool(
    'vuenexus_query',
    'Search Vue/TS frontend graph nodes.',
    {
      query: z.string(),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async ({ query, limit }) => jsonContent({ nodes: await searchGraph(lbugPath, query, limit) }),
  );

  server.tool(
    'vuenexus_semantic_search',
    'Semantic search over stored LadybugDB embeddings. Graph precision is independent from embeddings.',
    {
      query: z.string(),
      limit: z.number().int().min(1).max(100).default(20),
      provider: z.enum(['local', 'http', 'hash']).optional(),
      model: z.string().optional(),
    },
    async ({ query, limit, provider, model }) => {
      const graph = await buildGraph(lbugPath, true);
      return jsonContent({
        query,
        limit,
        results: await semanticSearchLbug(lbugPath, graph.nodes, query, limit, { provider, model }),
      });
    },
  );

  server.tool(
    'vuenexus_graph',
    'Return direct incoming/outgoing graph relationships for a node id or symbol name.',
    {
      symbolOrId: z.string(),
      limit: z.number().int().min(1).max(300).default(80),
    },
    async ({ symbolOrId, limit }) => {
      const slice = graphSlice(await buildGraph(lbugPath), symbolOrId, limit);
      return jsonContent({
        nodes: slice.nodes.map(compactNode),
        edges: slice.edges.map(compactEdge),
      });
    },
  );

  server.tool(
    'vuenexus_cypher',
    'Run Cypher over the stored LadybugDB frontend graph.',
    {
      query: z.string(),
    },
    async ({ query }) => jsonContent({ rows: await queryVueNexusLbug(lbugPath, query) }),
  );

  server.tool(
    'vuenexus_context',
    'Return incoming and outgoing context for one frontend symbol.',
    {
      symbolOrId: z.string(),
      limit: z.number().int().min(1).max(300).default(80),
    },
    async ({ symbolOrId, limit }) => {
      const graph = await buildGraph(lbugPath);
      const nodes = findNodes(graph, symbolOrId, 1);
      const node = nodes[0] ?? null;
      const edges = node
        ? graph.relationships.filter((edge) => edge.sourceId === node.id || edge.targetId === node.id).slice(0, limit)
        : [];
      return jsonContent({
        node: node ? compactNode(node) : null,
        incoming: edges.filter((edge) => edge.targetId === node?.id).map(compactEdge),
        outgoing: edges.filter((edge) => edge.sourceId === node?.id).map(compactEdge),
      });
    },
  );

  server.tool(
    'vuenexus_call_chain',
    'Traverse frontend call chains over CALLS, RENDERS, and HANDLES relationships.',
    {
      from: z.string(),
      depth: z.number().int().min(1).max(12).default(4),
      limit: z.number().int().min(1).max(500).default(200),
    },
    async ({ from, depth, limit }) => {
      const chain = callChain(await buildGraph(lbugPath), from, depth, limit);
      return jsonContent({
        nodes: chain.nodes.map(compactNode),
        edges: chain.edges.map(compactEdge),
      });
    },
  );

  server.tool(
    'vuenexus_unresolved_report',
    'Return unresolved imports, route components, template components, store calls, and other graph gaps that may hide impact.',
    {
      kind: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    },
    async ({ kind, limit }) => jsonContent(unresolvedReport(await buildGraph(lbugPath), kind, limit)),
  );

  server.tool(
    'vuenexus_impact_radius',
    'Return reverse impact radius for a symbol/node plus unresolved blockers that may hide additional callers or usages.',
    {
      symbolOrId: z.string(),
      depth: z.number().int().min(1).max(12).default(4),
      limit: z.number().int().min(1).max(1000).default(300),
    },
    async ({ symbolOrId, depth, limit }) =>
      jsonContent(impactRadius(await buildGraph(lbugPath), symbolOrId, depth, limit)),
  );

  server.tool('vuenexus_stats', 'Return graph totals grouped by node and edge type.', {}, async () =>
    jsonContent(stats(await buildGraph(lbugPath))),
  );

  server.tool('vuenexus_export', 'Return the full stored frontend graph as JSON. Use sparingly on large projects.', {}, async () =>
    jsonContent(await buildGraph(lbugPath, true)),
  );

  await server.connect(new StdioServerTransport());
}
