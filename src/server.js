import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vuenexusRegistryPath, NODE_LABELS, queryVueNexusLbug } from './lbug-writer.js';

const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
    ...headers,
  });
  res.end(`${JSON.stringify(value)}\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function readRegistry() {
  try {
    const entries = JSON.parse(await fs.readFile(vuenexusRegistryPath(), 'utf8'));
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

async function resolveRepo(repoName) {
  const repos = await readRegistry();
  if (!repoName) return repos[0] ?? null;
  const wanted = path.basename(repoName).toLowerCase();
  return repos.find((repo) => repo.name === repoName) ??
    repos.find((repo) => String(repo.name).toLowerCase() === wanted) ??
    repos.find((repo) => path.basename(repo.path).toLowerCase() === wanted) ??
    null;
}

function nodeQuery(label, includeContent) {
  const quoted = `\`${label}\``;
  if (label === 'File') {
    return includeContent
      ? `MATCH (n:${quoted}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.content AS content`
      : `MATCH (n:${quoted}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
  }
  if (label === 'Route') {
    return `MATCH (n:${quoted}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.responseKeys AS responseKeys, n.errorKeys AS errorKeys, n.middleware AS middleware`;
  }
  if (label === 'UnresolvedReference') {
    return `MATCH (n:${quoted}) RETURN n.id AS id, n.kind AS kind, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.ownerId AS ownerId, n.text AS text, n.reason AS reason, n.candidates AS candidates, n.attemptedResolvers AS attemptedResolvers, n.description AS description`;
  }
  return includeContent
    ? `MATCH (n:${quoted}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.content AS content, n.description AS description`
    : `MATCH (n:${quoted}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.description AS description`;
}

function mapNode(label, row, includeContent) {
  return {
    id: row.id,
    label,
    properties: {
      name: row.name,
      filePath: row.filePath,
      startLine: row.startLine,
      endLine: row.endLine,
      content: includeContent ? row.content : undefined,
      description: row.description,
      responseKeys: row.responseKeys,
      errorKeys: row.errorKeys,
      middleware: row.middleware,
      kind: row.kind,
      ownerId: row.ownerId,
      text: row.text,
      reason: row.reason,
      candidates: row.candidates,
      attemptedResolvers: row.attemptedResolvers,
    },
  };
}

function mapRelationship(row) {
  return {
    sourceId: row.sourceId,
    targetId: row.targetId,
    type: row.type,
    properties: {
      confidence: row.confidence,
      reason: row.reason,
      step: row.step,
    },
  };
}

export async function buildGraph(lbugPath, includeContent = false) {
  const nodes = [];
  for (const label of NODE_LABELS) {
    try {
      const rows = await queryVueNexusLbug(lbugPath, nodeQuery(label, includeContent));
      nodes.push(...rows.map((row) => mapNode(label, row, includeContent)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('does not exist') && !message.includes('No table')) throw err;
    }
  }
  const relRows = await queryVueNexusLbug(
    lbugPath,
    'MATCH (a)-[r:CodeRelation]->(b) RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step',
  );
  return { nodes, relationships: relRows.map(mapRelationship) };
}

export async function searchGraph(lbugPath, query, limit = 20) {
  const needle = String(query).toLowerCase();
  const graph = await buildGraph(lbugPath, false);
  return graph.nodes
    .filter((node) => {
      const props = node.properties ?? {};
      return [node.id, node.label, props.name, props.filePath, props.description]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    })
    .slice(0, limit)
    .map((node) => ({
      id: node.id,
      label: node.label,
      name: node.properties.name,
      filePath: node.properties.filePath,
      startLine: node.properties.startLine,
      endLine: node.properties.endLine,
      score: 1,
      matchType: 'frontend',
    }));
}

async function sendGraphStream(res, graph) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-cache',
  });
  for (const node of graph.nodes) res.write(`${JSON.stringify({ type: 'node', data: node })}\n`);
  for (const relationship of graph.relationships) {
    res.write(`${JSON.stringify({ type: 'relationship', data: relationship })}\n`);
  }
  res.end();
}

export async function serveVueNexus({ port = 3000, host = '127.0.0.1' } = {}) {
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Private-Network': 'true',
        });
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', `http://${host}:${port}`);
      if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true });
      if (url.pathname === '/api/info') {
        return sendJson(res, 200, {
          version: pkg.version,
          launchContext: 'local',
          nodeVersion: process.version,
        });
      }
      if (url.pathname === '/api/repos') {
        const repos = await readRegistry();
        return sendJson(
          res,
          200,
          repos.map((repo) => ({
            name: repo.name,
            path: repo.path,
            indexedAt: repo.indexedAt,
            lastCommit: repo.lastCommit,
            stats: repo.stats,
          })),
        );
      }

      if (url.pathname === '/api/repo') {
        const repo = await resolveRepo(url.searchParams.get('repo') ?? undefined);
        if (!repo) return sendJson(res, 404, { error: 'Repository not found. Run: vuenexus analyze' });
        return sendJson(res, 200, {
          name: repo.name,
          repoPath: repo.path,
          path: repo.path,
          indexedAt: repo.indexedAt,
          stats: repo.stats ?? {},
        });
      }

      if (url.pathname === '/api/graph') {
        const repo = await resolveRepo(url.searchParams.get('repo') ?? undefined);
        if (!repo) return sendJson(res, 404, { error: 'Repository not found' });
        const graph = await buildGraph(
          path.join(repo.storagePath, 'lbug'),
          url.searchParams.get('includeContent') === 'true',
        );
        if (url.searchParams.get('stream') === 'true') return sendGraphStream(res, graph);
        return sendJson(res, 200, graph);
      }

      if (url.pathname === '/api/query' && req.method === 'POST') {
        const body = await readBody(req);
        const repo = await resolveRepo(body.repo);
        if (!repo) return sendJson(res, 404, { error: 'Repository not found' });
        const result = await queryVueNexusLbug(path.join(repo.storagePath, 'lbug'), body.cypher);
        return sendJson(res, 200, { result });
      }

      if (url.pathname === '/api/search' && req.method === 'POST') {
        const body = await readBody(req);
        const repo = await resolveRepo(body.repo);
        if (!repo) return sendJson(res, 404, { error: 'Repository not found' });
        const results = await searchGraph(path.join(repo.storagePath, 'lbug'), body.query, body.limit ?? 20);
        return sendJson(res, 200, { results });
      }

      if (url.pathname === '/api/file') {
        const repo = await resolveRepo(url.searchParams.get('repo') ?? undefined);
        const relPath = url.searchParams.get('path');
        if (!repo || !relPath) return sendJson(res, 404, { error: 'File not found' });
        const fullPath = path.resolve(repo.path, relPath);
        const relative = path.relative(path.resolve(repo.path), fullPath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          return sendJson(res, 403, { error: 'Path traversal denied' });
        }
        const content = await fs.readFile(fullPath, 'utf8');
        return sendJson(res, 200, { content, totalLines: content.split('\n').length });
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>VueNexus</title><body>VueNexus frontend-only API server is running.</body>');
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  process.stdout.write(`VueNexus frontend-only server listening at http://${host}:${port}\n`);
  return server;
}
