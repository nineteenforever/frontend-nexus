#!/usr/bin/env node
import path from 'node:path';
import { Command } from 'commander';
import { indexFrontendProject } from './indexer.js';
import { embedGraphToLbug, semanticSearchLbug } from './embedding.js';
import { runMcpServer } from './mcp.js';
import { defaultLbugPath, queryGitNexusLbug, writeGitNexusLbug } from './lbug-writer.js';
import { buildGraph, searchGraph, serveGitNexus } from './server.js';

const program = new Command();

function defaultLbug(root = process.cwd()) {
  return defaultLbugPath(root);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

program.name('gitnexus').description('Frontend-only Git Nexus for Vue projects');

async function analyzeProject(opts) {
  const root = path.resolve(opts.root);
  const graph = indexFrontendProject(root);
  const written = await writeGitNexusLbug(graph, root, { name: opts.name });
  const result = {
    storagePath: written.storagePath,
    lbugPath: written.lbugPath,
    repo: written.registeredName,
    files: graph.files,
    nodes: graph.nodes.size,
    edges: graph.edges.size,
    diagnostics: graph.diagnostics.slice(0, 25),
  };
  if (opts.embeddings || opts.embedding) {
    result.embeddings = await embedGraphToLbug(written.lbugPath, graph.nodes.values(), {
      provider: opts.provider,
      model: opts.model,
      batchSize: opts.batchSize,
    });
  }
  print(result);
}

program
  .command('analyze')
  .description('Analyze/index a Vue frontend project')
  .option('--root <path>', 'project root', process.cwd())
  .option('--name <name>', 'registered repo name')
  .option('--embeddings', 'generate embeddings after indexing')
  .option('--embedding', 'alias for --embeddings')
  .option('--provider <provider>', 'embedding provider for --embedding: local, http, or hash')
  .option('--model <pathOrName>', 'local model directory or HTTP model name for --embedding')
  .option('--batch-size <n>', 'embedding batch size')
  .action(analyzeProject);

program
  .command('index')
  .description('Alias for analyze')
  .option('--root <path>', 'project root', process.cwd())
  .option('--name <name>', 'registered repo name')
  .option('--embeddings', 'generate embeddings after indexing')
  .option('--embedding', 'alias for --embeddings')
  .option('--provider <provider>', 'embedding provider for --embedding: local, http, or hash')
  .option('--model <pathOrName>', 'local model directory or HTTP model name for --embedding')
  .option('--batch-size <n>', 'embedding batch size')
  .action(analyzeProject);

program
  .command('query')
  .description('Search indexed nodes')
  .argument('[text]', 'query text')
  .option('--query <text>', 'query text')
  .option('--db <path>', 'LadybugDB path', defaultLbug())
  .option('--limit <n>', 'limit', '20')
  .option('--semantic', 'search embeddings instead of FTS')
  .option('--provider <provider>', 'embedding provider for semantic query: http, local, or hash')
  .option('--model <pathOrName>', 'local model directory or HTTP model name for semantic query')
  .action(async (text, opts) => {
    const query = opts.query ?? text;
    if (!query) throw new Error('gitnexus query requires query text');
    if (opts.semantic) {
      if (opts.provider) process.env.GITNEXUS_EMBEDDING_PROVIDER = opts.provider;
      const graph = await buildGraph(path.resolve(opts.db), true);
      print(await semanticSearchLbug(path.resolve(opts.db), graph.nodes, query, Number(opts.limit), {
        provider: opts.provider,
        model: opts.model,
      }));
    } else {
      print(await searchGraph(path.resolve(opts.db), query, Number(opts.limit)));
    }
  });

program
  .command('search')
  .description('Search indexed nodes')
  .requiredOption('--query <text>', 'search query')
  .option('--db <path>', 'LadybugDB path', defaultLbug())
  .option('--limit <n>', 'limit', '20')
  .action(async (opts) => {
    print(await searchGraph(path.resolve(opts.db), opts.query, Number(opts.limit)));
  });

program
  .command('cypher')
  .description('Run Cypher over the stored LadybugDB graph')
  .argument('[query]', 'query text')
  .option('--query <text>', 'query text')
  .option('--db <path>', 'LadybugDB path', defaultLbug())
  .action(async (text, opts) => {
    const query = opts.query ?? text;
    if (!query) throw new Error('gitnexus cypher requires query text');
    print(await queryGitNexusLbug(path.resolve(opts.db), query));
  });

program
  .command('serve')
  .description('Serve the GitNexus-compatible HTTP API for gitnexus-web')
  .option('--port <n>', 'port', '3000')
  .option('--host <host>', 'host', '127.0.0.1')
  .action(async (opts) => {
    await serveGitNexus({ port: Number(opts.port), host: opts.host });
  });

program
  .command('graph')
  .description('Show direct graph slice for a symbol or node id')
  .requiredOption('--symbol <nameOrId>', 'symbol name or node id')
  .option('--db <path>', 'LadybugDB path', defaultLbug())
  .option('--limit <n>', 'limit', '80')
  .action(async (opts) => {
    const graph = await buildGraph(path.resolve(opts.db));
    const needle = opts.symbol.toLowerCase();
    const seeds = graph.nodes.filter((node) => node.id === opts.symbol || String(node.properties?.name ?? '').toLowerCase() === needle).slice(0, Number(opts.limit));
    const ids = new Set(seeds.map((node) => node.id));
    const edges = graph.relationships.filter((edge) => ids.has(edge.sourceId) || ids.has(edge.targetId)).slice(0, Number(opts.limit));
    for (const edge of edges) {
      ids.add(edge.sourceId);
      ids.add(edge.targetId);
    }
    print({ nodes: graph.nodes.filter((node) => ids.has(node.id)), edges });
  });

program
  .command('context')
  .description('Show incoming and outgoing context for a symbol or node id')
  .requiredOption('--symbol <nameOrId>', 'symbol name or node id')
  .option('--db <path>', 'LadybugDB path', defaultLbug())
  .option('--limit <n>', 'limit', '80')
  .action(async (opts) => {
    const graph = await buildGraph(path.resolve(opts.db));
    const needle = opts.symbol.toLowerCase();
    const node = graph.nodes.find((n) => n.id === opts.symbol || String(n.properties?.name ?? '').toLowerCase() === needle);
    const edges = node ? graph.relationships.filter((edge) => edge.sourceId === node.id || edge.targetId === node.id).slice(0, Number(opts.limit)) : [];
    print({ node, incoming: edges.filter((edge) => edge.targetId === node?.id), outgoing: edges.filter((edge) => edge.sourceId === node?.id) });
  });

program
  .command('chain')
  .description('Show frontend call chain from a symbol or node id')
  .requiredOption('--from <nameOrId>', 'start symbol name or node id')
  .option('--db <path>', 'LadybugDB path', defaultLbug())
  .option('--depth <n>', 'max depth', '4')
  .option('--limit <n>', 'limit', '200')
  .action(async (opts) => {
    const graph = await buildGraph(path.resolve(opts.db));
    const needle = opts.from.toLowerCase();
    const seeds = graph.nodes.filter((node) => node.id === opts.from || String(node.properties?.name ?? '').toLowerCase() === needle).slice(0, 10);
    const ids = new Set(seeds.map((node) => node.id));
    const edges = [];
    let frontier = seeds.map((node) => node.id);
    const allowed = new Set(['CALLS', 'RENDERS', 'HANDLES']);
    for (let i = 0; i < Number(opts.depth) && frontier.length && edges.length < Number(opts.limit); i++) {
      const next = [];
      for (const edge of graph.relationships) {
        if (!frontier.includes(edge.sourceId) || !allowed.has(edge.type)) continue;
        edges.push(edge);
        if (!ids.has(edge.targetId)) {
          ids.add(edge.targetId);
          next.push(edge.targetId);
        }
        if (edges.length >= Number(opts.limit)) break;
      }
      frontier = next;
    }
    print({ nodes: graph.nodes.filter((node) => ids.has(node.id)), edges });
  });

program
  .command('stats')
  .description('Show graph statistics')
  .option('--db <path>', 'LadybugDB path', defaultLbug())
  .action(async (opts) => {
    const graph = await buildGraph(path.resolve(opts.db));
    const byNodeType = {};
    const byEdgeType = {};
    for (const node of graph.nodes) byNodeType[node.label] = (byNodeType[node.label] ?? 0) + 1;
    for (const edge of graph.relationships) byEdgeType[edge.type] = (byEdgeType[edge.type] ?? 0) + 1;
    print({ nodes: graph.nodes.length, edges: graph.relationships.length, byNodeType, byEdgeType });
  });

program
  .command('export')
  .description('Export stored graph as JSON')
  .option('--db <path>', 'LadybugDB path', defaultLbug())
  .option('--out <path>', 'write JSON to this path instead of stdout')
  .action(async (opts) => {
    const graph = await buildGraph(path.resolve(opts.db), true);
    if (opts.out) {
      const out = path.resolve(opts.out);
      const fs = await import('node:fs');
      fs.writeFileSync(out, `${JSON.stringify(graph, null, 2)}\n`);
      print({ out, nodes: graph.nodes.length, edges: graph.relationships.length });
    } else {
      print(graph);
    }
  });

program
  .command('embed')
  .description('Generate embeddings for an existing index')
  .option('--db <path>', 'LadybugDB path', defaultLbug())
  .option('--provider <provider>', 'embedding provider: http, local, or hash')
  .option('--model <pathOrName>', 'local model directory or HTTP model name')
  .option('--batch-size <n>', 'embedding batch size')
  .action(async (opts) => {
    if (opts.provider) process.env.GITNEXUS_EMBEDDING_PROVIDER = opts.provider;
    const graph = await buildGraph(path.resolve(opts.db), true);
    print(await embedGraphToLbug(path.resolve(opts.db), graph.nodes, {
      provider: opts.provider,
      model: opts.model,
      batchSize: opts.batchSize,
    }));
  });

program
  .command('semantic')
  .description('Semantic search over stored embeddings')
  .requiredOption('--query <text>', 'semantic query')
  .option('--db <path>', 'LadybugDB path', defaultLbug())
  .option('--limit <n>', 'limit', '20')
  .option('--provider <provider>', 'embedding provider for query: http, local, or hash')
  .option('--model <pathOrName>', 'local model directory or HTTP model name')
  .action(async (opts) => {
    if (opts.provider) process.env.GITNEXUS_EMBEDDING_PROVIDER = opts.provider;
    const graph = await buildGraph(path.resolve(opts.db), true);
    print(await semanticSearchLbug(path.resolve(opts.db), graph.nodes, opts.query, Number(opts.limit), {
      provider: opts.provider,
      model: opts.model,
    }));
  });

program
  .command('mcp')
  .description('Run MCP stdio server')
  .option('--db <path>', 'LadybugDB path', defaultLbug())
  .action(async (opts) => {
    await runMcpServer(path.resolve(opts.db));
  });

program.parseAsync();
