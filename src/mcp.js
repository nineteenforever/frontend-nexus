import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { semanticSearchLbug } from './embedding.js';
import { queryGitNexusLbug } from './lbug-writer.js';
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
  return {
    id: node.id,
    type: node.label,
    name: node.properties?.name,
    filePath: node.properties?.filePath,
    startLine: node.properties?.startLine,
    endLine: node.properties?.endLine,
    meta: node.properties?.description ? JSON.parse(node.properties.description) : {},
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
  const allowed = new Set(['CALLS', 'RENDERS', 'HANDLES']);
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
    name: 'gitnexus',
    version: '0.1.0',
  });

  server.tool(
    'gitnexus_query',
    'Search Vue/TS frontend graph nodes.',
    {
      query: z.string(),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async ({ query, limit }) => jsonContent({ nodes: await searchGraph(lbugPath, query, limit) }),
  );

  server.tool(
    'gitnexus_semantic_search',
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
    'gitnexus_graph',
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
    'gitnexus_cypher',
    'Run Cypher over the stored LadybugDB frontend graph.',
    {
      query: z.string(),
    },
    async ({ query }) => jsonContent({ rows: await queryGitNexusLbug(lbugPath, query) }),
  );

  server.tool(
    'gitnexus_context',
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
    'gitnexus_call_chain',
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

  server.tool('gitnexus_stats', 'Return graph totals grouped by node and edge type.', {}, async () =>
    jsonContent(stats(await buildGraph(lbugPath))),
  );

  server.tool('gitnexus_export', 'Return the full stored frontend graph as JSON. Use sparingly on large projects.', {}, async () =>
    jsonContent(await buildGraph(lbugPath, true)),
  );

  await server.connect(new StdioServerTransport());
}
