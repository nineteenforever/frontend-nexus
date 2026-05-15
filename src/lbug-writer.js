import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import lbug from '@ladybugdb/core';

export const NODE_LABELS = ['File', 'Function', 'Class', 'Interface', 'Method', 'CodeElement', 'Variable', 'Route'];
const REL_TYPES = [
  'DEFINES',
  'IMPORTS',
  'CALLS',
  'RENDERS',
  'HANDLES',
  'ROUTES_TO',
  'USES_STORE',
];
const LBUG_MAX_DB_SIZE = 16 * 1024 * 1024 * 1024;

function q(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(q).join(', ')}]`;
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function qa(values = []) {
  return `[${values.map(q).join(', ')}]`;
}

function safeJson(value) {
  return JSON.stringify(value ?? {});
}

function graphNodeLabel(type) {
  if (type === 'Component' || type === 'Store') return 'Class';
  if (type === 'Composable') return 'Function';
  if (type === 'Router') return 'CodeElement';
  if (NODE_LABELS.includes(type)) return type;
  return 'CodeElement';
}

function graphNodeDescription(node) {
  const meta = { frontendType: node.type, ...(node.meta ?? {}) };
  return safeJson(meta);
}

function openDb(lbugPath, { readOnly = false } = {}) {
  return new lbug.Database(
    lbugPath,
    0,
    false,
    readOnly,
    LBUG_MAX_DB_SIZE,
    true,
    -1,
    true,
    true,
  );
}

export function gitnexusRegistryPath() {
  return path.join(os.homedir(), '.gitnexus', 'registry.json');
}

async function drain(result) {
  const results = Array.isArray(result) ? result : [result];
  let rows = [];
  for (let i = 0; i < results.length; i++) {
    try {
      const got = await results[i].getAll();
      if (i === 0) rows = got;
    } finally {
      try {
        await results[i].close?.();
      } catch {}
    }
  }
  return rows;
}

async function exec(conn, query) {
  return drain(await conn.query(query));
}

async function closeDb(db, conn) {
  try {
    await conn?.close?.();
  } catch {}
  try {
    await db?.close?.();
  } catch {}
}

const NODE_SCHEMAS = [
  `CREATE NODE TABLE File (id STRING, name STRING, filePath STRING, content STRING, PRIMARY KEY (id))`,
  `CREATE NODE TABLE Function (id STRING, name STRING, filePath STRING, startLine INT64, endLine INT64, isExported BOOLEAN, content STRING, description STRING, PRIMARY KEY (id))`,
  `CREATE NODE TABLE Class (id STRING, name STRING, filePath STRING, startLine INT64, endLine INT64, isExported BOOLEAN, content STRING, description STRING, PRIMARY KEY (id))`,
  `CREATE NODE TABLE Interface (id STRING, name STRING, filePath STRING, startLine INT64, endLine INT64, isExported BOOLEAN, content STRING, description STRING, PRIMARY KEY (id))`,
  `CREATE NODE TABLE Method (id STRING, name STRING, filePath STRING, startLine INT64, endLine INT64, isExported BOOLEAN, content STRING, description STRING, parameterCount INT32, returnType STRING, PRIMARY KEY (id))`,
  `CREATE NODE TABLE CodeElement (id STRING, name STRING, filePath STRING, startLine INT64, endLine INT64, isExported BOOLEAN, content STRING, description STRING, PRIMARY KEY (id))`,
  `CREATE NODE TABLE \`Variable\` (id STRING, name STRING, filePath STRING, startLine INT64, endLine INT64, content STRING, description STRING, PRIMARY KEY (id))`,
  `CREATE NODE TABLE Route (id STRING, name STRING, filePath STRING, responseKeys STRING[], errorKeys STRING[], middleware STRING[], PRIMARY KEY (id))`,
  `CREATE NODE TABLE CodeEmbedding (id STRING, nodeId STRING, chunkIndex INT32, startLine INT64, endLine INT64, embedding FLOAT[], contentHash STRING, PRIMARY KEY (id))`,
];

function relationSchema() {
  const pairs = [];
  for (const from of NODE_LABELS) {
    for (const to of NODE_LABELS) pairs.push(`  FROM \`${from}\` TO \`${to}\``);
  }
  return `CREATE REL TABLE CodeRelation (\n${pairs.join(',\n')},\n  type STRING,\n  confidence DOUBLE,\n  reason STRING,\n  step INT32\n)`;
}

async function createSchema(conn) {
  for (const query of [...NODE_SCHEMAS, relationSchema()]) {
    try {
      await exec(conn, query);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('already exists')) throw err;
    }
  }
}

function nodeCreateQuery(node) {
  const label = graphNodeLabel(node.type);
  if (label === 'File') {
    return `CREATE (n:File {id: ${q(node.id)}, name: ${q(node.name)}, filePath: ${q(node.filePath)}, content: ${q(node.content)}})`;
  }
  if (label === 'Route') {
    return `CREATE (n:Route {id: ${q(node.id)}, name: ${q(node.name)}, filePath: ${q(node.filePath)}, responseKeys: ${qa([])}, errorKeys: ${qa([])}, middleware: ${qa([])}})`;
  }
  if (label === 'Method') {
    return `CREATE (n:Method {id: ${q(node.id)}, name: ${q(node.name)}, filePath: ${q(node.filePath)}, startLine: ${q(node.startLine)}, endLine: ${q(node.endLine)}, isExported: ${q(Boolean(node.exported))}, content: ${q(node.content)}, description: ${q(graphNodeDescription(node))}, parameterCount: 0, returnType: ${q('')}})`;
  }
  if (label === 'Variable') {
    return `CREATE (n:\`Variable\` {id: ${q(node.id)}, name: ${q(node.name)}, filePath: ${q(node.filePath)}, startLine: ${q(node.startLine)}, endLine: ${q(node.endLine)}, content: ${q(node.content)}, description: ${q(graphNodeDescription(node))}})`;
  }
  return `CREATE (n:\`${label}\` {id: ${q(node.id)}, name: ${q(node.name)}, filePath: ${q(node.filePath)}, startLine: ${q(node.startLine)}, endLine: ${q(node.endLine)}, isExported: ${q(Boolean(node.exported))}, content: ${q(node.content)}, description: ${q(graphNodeDescription(node))}})`;
}

function edgeCreateQuery(edge, nodesById) {
  const source = nodesById.get(edge.source);
  const target = nodesById.get(edge.target);
  if (!source || !target) return null;
  const fromLabel = graphNodeLabel(source.type);
  const toLabel = graphNodeLabel(target.type);
  return `
    MATCH (a:\`${fromLabel}\` {id: ${q(edge.source)}})
    MATCH (b:\`${toLabel}\` {id: ${q(edge.target)}})
    CREATE (a)-[:CodeRelation {type: ${q(edge.type)}, confidence: ${q(edge.confidence ?? 1)}, reason: ${q(edge.reason ?? '')}, step: ${q(edge.line ?? 0)}}]->(b)
  `;
}

function tryGit(repoPath, args) {
  try {
    return execFileSync('git', args, { cwd: repoPath, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

async function updateRegistry(repoPath, storagePath, meta, name = path.basename(repoPath)) {
  const registryPath = gitnexusRegistryPath();
  await fsp.mkdir(path.dirname(registryPath), { recursive: true });
  let entries = [];
  try {
    entries = JSON.parse(await fsp.readFile(registryPath, 'utf8'));
  } catch {}
  const resolved = path.resolve(repoPath);
  const entry = {
    name,
    path: resolved,
    storagePath,
    indexedAt: meta.indexedAt,
    lastCommit: meta.lastCommit,
    remoteUrl: meta.remoteUrl,
    stats: meta.stats,
  };
  const idx = entries.findIndex((item) => path.resolve(item.path) === resolved);
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  await fsp.writeFile(registryPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  return name;
}

export async function writeGitNexusLbug(graph, repoPath, options = {}) {
  repoPath = path.resolve(repoPath);
  const storagePath = path.join(repoPath, '.gitnexus');
  const lbugPath = path.join(storagePath, 'lbug');
  await fsp.mkdir(storagePath, { recursive: true });
  for (const suffix of ['', '.wal', '.lock']) {
    await fsp.rm(lbugPath + suffix, { recursive: true, force: true }).catch(() => {});
  }

  const db = openDb(lbugPath);
  const conn = new lbug.Connection(db);
  try {
    await createSchema(conn);
    const nodes = [...graph.nodes.values()];
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    for (const node of nodes) await exec(conn, nodeCreateQuery(node));
    for (const edge of graph.edges.values()) {
      const query = edgeCreateQuery(edge, nodesById);
      if (query) await exec(conn, query);
    }
    await exec(conn, 'CHECKPOINT').catch(() => {});
  } finally {
    await closeDb(db, conn);
  }

  const meta = {
    repoPath,
    lastCommit: tryGit(repoPath, ['rev-parse', 'HEAD']),
    indexedAt: new Date().toISOString(),
    remoteUrl: tryGit(repoPath, ['config', '--get', 'remote.origin.url']) || undefined,
    stats: {
      files: graph.files,
      nodes: graph.nodes.size,
      edges: graph.edges.size,
      embeddings: 0,
    },
    schemaVersion: 1,
  };
  await fsp.writeFile(path.join(storagePath, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  const registeredName =
    options.registry === false
      ? (options.name ?? path.basename(repoPath))
      : await updateRegistry(repoPath, storagePath, meta, options.name);
  return { storagePath, lbugPath, meta, registeredName };
}

function codeEmbeddingCreateQuery(row) {
  return `CREATE (n:CodeEmbedding {id: ${q(row.id)}, nodeId: ${q(row.nodeId)}, chunkIndex: ${q(row.chunkIndex ?? 0)}, startLine: ${q(row.startLine ?? 0)}, endLine: ${q(row.endLine ?? 0)}, embedding: ${q(row.embedding)}, contentHash: ${q(row.contentHash)}})`;
}

async function updateMetaAndRegistryFromLbug(lbugPath, embeddingSummary) {
  const storagePath = path.dirname(path.resolve(lbugPath));
  const metaPath = path.join(storagePath, 'meta.json');
  let meta;
  try {
    meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
  } catch {
    return;
  }
  meta.stats ??= {};
  meta.stats.embeddings = embeddingSummary.embedded;
  meta.embeddings = {
    provider: embeddingSummary.provider,
    model: embeddingSummary.model,
    dimensions: embeddingSummary.dimensions,
    indexedAt: new Date().toISOString(),
  };
  await fsp.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  const registryPath = gitnexusRegistryPath();
  try {
    const entries = JSON.parse(await fsp.readFile(registryPath, 'utf8'));
    const idx = entries.findIndex((item) => path.resolve(item.storagePath ?? '') === storagePath);
    if (idx >= 0) {
      entries[idx].stats = meta.stats;
      entries[idx].indexedAt = meta.indexedAt;
      await fsp.writeFile(registryPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
    }
  } catch {}
}

export async function writeGitNexusEmbeddings(lbugPath, embeddings, summary = {}) {
  const db = openDb(lbugPath);
  const conn = new lbug.Connection(db);
  try {
    await createSchema(conn);
    await exec(conn, 'MATCH (n:CodeEmbedding) DELETE n').catch(() => {});
    for (const embedding of embeddings) await exec(conn, codeEmbeddingCreateQuery(embedding));
    await exec(conn, 'CHECKPOINT').catch(() => {});
  } finally {
    await closeDb(db, conn);
  }
  const embeddingSummary = {
    embedded: embeddings.length,
    provider: summary.provider,
    model: summary.model,
    dimensions: embeddings[0]?.embedding?.length ?? 0,
  };
  await updateMetaAndRegistryFromLbug(lbugPath, embeddingSummary);
  return embeddingSummary;
}

export async function readGitNexusEmbeddings(lbugPath) {
  try {
    return await queryGitNexusLbug(
      lbugPath,
      'MATCH (n:CodeEmbedding) RETURN n.id AS id, n.nodeId AS nodeId, n.chunkIndex AS chunkIndex, n.startLine AS startLine, n.endLine AS endLine, n.embedding AS embedding, n.contentHash AS contentHash',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('does not exist') || message.includes('No table')) return [];
    throw err;
  }
}

export async function queryGitNexusLbug(lbugPath, query) {
  const db = openDb(lbugPath, { readOnly: true });
  const conn = new lbug.Connection(db);
  try {
    return await exec(conn, query);
  } finally {
    await closeDb(db, conn);
  }
}

export function defaultLbugPath(root = process.cwd()) {
  return path.join(path.resolve(root), '.gitnexus', 'lbug');
}
