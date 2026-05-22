#!/usr/bin/env node
// @ts-nocheck
import path from 'node:path';
import { Command } from 'commander';
import { indexFrontendProject } from './indexer.js';
import { embedGraphToLbug, semanticSearchLbug } from './embedding.js';
import { runMcpServer } from './mcp.js';
import { defaultLbugPath, queryVueNexusLbug, writeVueNexusLbug } from './lbug-writer.js';
import { localEmbeddingModelInfo } from './model-resolver.js';
import { buildGraph, searchGraph, serveVueNexus } from './server.js';
import { setupOpencode } from './setup.js';

const program = new Command();

function defaultLbug(root = process.cwd()) {
  return defaultLbugPath(root);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function createProgressLogger(opts) {
  if (opts.json || opts.quiet) return () => {};
  const started = Date.now();
  return (message) => {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    process.stderr.write(`[vuenexus] ${message} (${elapsed}s)\n`);
  };
}

function embeddingOptions(opts) {
  return {
    provider: opts.provider,
    model: opts.model,
    modelPackage: opts.modelPackage,
    batchSize: opts.batchSize,
  };
}

program.name('vuenexus').description('VueNexus graph analyzer for Vue projects');

async function analyzeProject(opts) {
  const root = path.resolve(opts.root);
  const progress = createProgressLogger(opts);
  const started = Date.now();
  progress(`Analyzing ${root}`);
  const graph = indexFrontendProject(root, { diagnostics: opts.diagnostics, onProgress: progress });
  progress('Writing LadybugDB graph');
  const written = await writeVueNexusLbug(graph, root, { name: opts.name });
  progress(`Graph stored at ${written.lbugPath}`);
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
    progress('Generating embeddings');
    result.embeddings = await embedGraphToLbug(written.lbugPath, graph.nodes.values(), embeddingOptions(opts));
    progress(`Generated ${result.embeddings.embedded} embeddings`);
  }
  result.durationMs = Date.now() - started;
  progress(`Done: ${result.files} files, ${result.nodes} nodes, ${result.edges} edges`);
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
  .option('--model-package <packageName>', 'npm package that contains a local embedding model')
  .option('--batch-size <n>', 'embedding batch size')
  .option('--diagnostics', 'include full TypeScript semantic diagnostics; slower on large projects')
  .option('--json', 'suppress progress logs and print only JSON to stdout')
  .option('--quiet', 'suppress progress logs')
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
  .option('--model-package <packageName>', 'npm package that contains a local embedding model')
  .option('--batch-size <n>', 'embedding batch size')
  .option('--diagnostics', 'include full TypeScript semantic diagnostics; slower on large projects')
  .option('--json', 'suppress progress logs and print only JSON to stdout')
  .option('--quiet', 'suppress progress logs')
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
  .option('--model-package <packageName>', 'npm package that contains a local embedding model')
  .action(async (text, opts) => {
    const query = opts.query ?? text;
    if (!query) throw new Error('vuenexus query requires query text');
    if (opts.semantic) {
      if (opts.provider) process.env.VUENEXUS_EMBEDDING_PROVIDER = opts.provider;
      const graph = await buildGraph(path.resolve(opts.db), true);
      print(await semanticSearchLbug(path.resolve(opts.db), graph.nodes, query, Number(opts.limit), {
        provider: opts.provider,
        model: opts.model,
        modelPackage: opts.modelPackage,
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
    if (!query) throw new Error('vuenexus cypher requires query text');
    print(await queryVueNexusLbug(path.resolve(opts.db), query));
  });

program
  .command('serve')
  .description('Serve a GitNexus web-compatible HTTP API for browsing VueNexus graphs')
  .option('--port <n>', 'port', '3000')
  .option('--host <host>', 'host', '127.0.0.1')
  .action(async (opts) => {
    await serveVueNexus({ port: Number(opts.port), host: opts.host });
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
  .option('--model-package <packageName>', 'npm package that contains a local embedding model')
  .option('--batch-size <n>', 'embedding batch size')
  .action(async (opts) => {
    if (opts.provider) process.env.VUENEXUS_EMBEDDING_PROVIDER = opts.provider;
    const graph = await buildGraph(path.resolve(opts.db), true);
    print(await embedGraphToLbug(path.resolve(opts.db), graph.nodes, embeddingOptions(opts)));
  });

program
  .command('semantic')
  .description('Semantic search over stored embeddings')
  .requiredOption('--query <text>', 'semantic query')
  .option('--db <path>', 'LadybugDB path', defaultLbug())
  .option('--limit <n>', 'limit', '20')
  .option('--provider <provider>', 'embedding provider for query: http, local, or hash')
  .option('--model <pathOrName>', 'local model directory or HTTP model name')
  .option('--model-package <packageName>', 'npm package that contains a local embedding model')
  .action(async (opts) => {
    if (opts.provider) process.env.VUENEXUS_EMBEDDING_PROVIDER = opts.provider;
    const graph = await buildGraph(path.resolve(opts.db), true);
    print(await semanticSearchLbug(path.resolve(opts.db), graph.nodes, opts.query, Number(opts.limit), {
      provider: opts.provider,
      model: opts.model,
      modelPackage: opts.modelPackage,
    }));
  });

program
  .command('model-info')
  .description('Show the local embedding model that provider=local will load')
  .option('--model <pathOrName>', 'local model directory or model package name')
  .option('--model-package <packageName>', 'npm package that contains a local embedding model')
  .action((opts) => {
    print(localEmbeddingModelInfo(opts));
  });

program
  .command('setup')
  .description('Install VueNexus MCP and skill configuration for an agent')
  .option('--agent <agent>', 'agent to configure', 'opencode')
  .option('--scope <scope>', 'global or project opencode config', 'global')
  .option('--db <path>', 'LadybugDB path used by the MCP server', '.vuenexus/lbug')
  .option('--command <command>', 'command used by opencode to launch VueNexus', 'vuenexus')
  .option('--config <path>', 'explicit opencode config path')
  .option('--skill-dir <path>', 'explicit opencode skill directory')
  .action(async (opts) => {
    if (opts.agent !== 'opencode') throw new Error('vuenexus setup currently supports --agent opencode');
    print(await setupOpencode(opts));
  });

program
  .command('mcp')
  .description('Run MCP stdio server')
  .option('--db <path>', 'LadybugDB path', defaultLbug())
  .action(async (opts) => {
    await runMcpServer(path.resolve(opts.db));
  });

program.parseAsync();
