// @ts-nocheck
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import lbug from '@ladybugdb/core';

export const NODE_LABELS = [
  'File',
  'Function',
  'Class',
  'Interface',
  'Method',
  'CodeElement',
  'Variable',
  'Route',
  'ExternalModule',
  'UnresolvedReference',
];
const REL_TYPES = [
  'DEFINES',
  'IMPORTS',
  'CALLS',
  'RENDERS',
  'HANDLES',
  'ROUTES_TO',
  'USES_STORE',
  'MIXES_IN',
  'HAS_UNRESOLVED',
];
const LBUG_MAX_DB_SIZE = 16 * 1024 * 1024 * 1024;
const COPY_CSV_OPTS = `(HEADER=true, ESCAPE='"', DELIM=',', QUOTE='"', PARALLEL=false, auto_detect=false)`;

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

function normalizeCopyPath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function sanitizeCSV(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[\uD800-\uDFFF]/g, '')
    .replace(/[\uFFFE\uFFFF]/g, '');
}

function csv(value) {
  return `"${sanitizeCSV(value).replace(/"/g, '""')}"`;
}

function csvNumber(value, fallback = -1) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return String(fallback);
  return String(Number(value));
}

function csvBool(value) {
  return value ? 'true' : 'false';
}

function csvArray(values = []) {
  return csv(`[${values.map((value) => `'${String(value).replace(/'/g, "''")}'`).join(',')}]`);
}

function tableName(label) {
  return label === 'Variable' ? '`Variable`' : label;
}

function safeJson(value) {
  return JSON.stringify(value ?? {});
}

function graphNodeLabel(type) {
  if (type === 'Component' || type === 'Store') return 'Class';
  if (type === 'Composable') return 'Function';
  if (type === 'Router') return 'CodeElement';
  if (type === 'ExternalModule') return 'ExternalModule';
  if (type === 'UnresolvedReference') return 'UnresolvedReference';
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

export function vuenexusRegistryPath() {
  return path.join(os.homedir(), '.vuenexus', 'registry.json');
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

async function execBatches(conn, queries, { maxChars = 1_000_000 } = {}) {
  let batch = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    await exec(conn, `${batch.join(';\n')};`);
    batch = [];
    size = 0;
  };

  for (const query of queries) {
    if (!query) continue;
    const nextSize = query.length + 2;
    if (batch.length && size + nextSize > maxChars) await flush();
    batch.push(query);
    size += nextSize;
  }
  await flush();
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
  `CREATE NODE TABLE ExternalModule (id STRING, name STRING, filePath STRING, startLine INT64, endLine INT64, isExported BOOLEAN, content STRING, description STRING, PRIMARY KEY (id))`,
  `CREATE NODE TABLE UnresolvedReference (id STRING, kind STRING, name STRING, filePath STRING, startLine INT64, endLine INT64, ownerId STRING, text STRING, reason STRING, candidates STRING, attemptedResolvers STRING, description STRING, PRIMARY KEY (id))`,
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

function nodeCsvFileName(label) {
  return `${label.toLowerCase()}.csv`;
}

function nodeCsvHeader(label) {
  if (label === 'File') return 'id,name,filePath,content';
  if (label === 'Route') return 'id,name,filePath,responseKeys,errorKeys,middleware';
  if (label === 'Method') {
    return 'id,name,filePath,startLine,endLine,isExported,content,description,parameterCount,returnType';
  }
  if (label === 'UnresolvedReference') {
    return 'id,kind,name,filePath,startLine,endLine,ownerId,text,reason,candidates,attemptedResolvers,description';
  }
  if (label === 'Variable') return 'id,name,filePath,startLine,endLine,content,description';
  return 'id,name,filePath,startLine,endLine,isExported,content,description';
}

function nodeCsvRow(node) {
  const label = graphNodeLabel(node.type);
  if (label === 'File') {
    return [csv(node.id), csv(node.name), csv(node.filePath), csv(node.content)].join(',');
  }
  if (label === 'Route') {
    return [
      csv(node.id),
      csv(node.name),
      csv(node.filePath),
      csvArray([]),
      csvArray([]),
      csvArray([]),
    ].join(',');
  }
  if (label === 'Method') {
    return [
      csv(node.id),
      csv(node.name),
      csv(node.filePath),
      csvNumber(node.startLine),
      csvNumber(node.endLine),
      csvBool(Boolean(node.exported)),
      csv(node.content),
      csv(graphNodeDescription(node)),
      '0',
      csv(''),
    ].join(',');
  }
  if (label === 'UnresolvedReference') {
    return [
      csv(node.id),
      csv(node.meta?.kind ?? ''),
      csv(node.name),
      csv(node.filePath),
      csvNumber(node.startLine, 0),
      csvNumber(node.endLine ?? node.startLine, 0),
      csv(node.meta?.ownerId ?? ''),
      csv(node.content ?? node.meta?.text ?? ''),
      csv(node.meta?.reason ?? ''),
      csv((node.meta?.candidates ?? []).join('|')),
      csv((node.meta?.attemptedResolvers ?? []).join('|')),
      csv(graphNodeDescription(node)),
    ].join(',');
  }
  if (label === 'Variable') {
    return [
      csv(node.id),
      csv(node.name),
      csv(node.filePath),
      csvNumber(node.startLine),
      csvNumber(node.endLine),
      csv(node.content),
      csv(graphNodeDescription(node)),
    ].join(',');
  }
  return [
    csv(node.id),
    csv(node.name),
    csv(node.filePath),
    csvNumber(node.startLine),
    csvNumber(node.endLine),
    csvBool(Boolean(node.exported)),
    csv(node.content),
    csv(graphNodeDescription(node)),
  ].join(',');
}

function nodeCopyQuery(label, csvPath) {
  const t = tableName(label);
  const p = normalizeCopyPath(csvPath);
  if (label === 'File') return `COPY ${t}(id, name, filePath, content) FROM "${p}" ${COPY_CSV_OPTS}`;
  if (label === 'Route') {
    return `COPY ${t}(id, name, filePath, responseKeys, errorKeys, middleware) FROM "${p}" ${COPY_CSV_OPTS}`;
  }
  if (label === 'Method') {
    return `COPY ${t}(id, name, filePath, startLine, endLine, isExported, content, description, parameterCount, returnType) FROM "${p}" ${COPY_CSV_OPTS}`;
  }
  if (label === 'UnresolvedReference') {
    return `COPY ${t}(id, kind, name, filePath, startLine, endLine, ownerId, text, reason, candidates, attemptedResolvers, description) FROM "${p}" ${COPY_CSV_OPTS}`;
  }
  if (label === 'Variable') {
    return `COPY ${t}(id, name, filePath, startLine, endLine, content, description) FROM "${p}" ${COPY_CSV_OPTS}`;
  }
  return `COPY ${t}(id, name, filePath, startLine, endLine, isExported, content, description) FROM "${p}" ${COPY_CSV_OPTS}`;
}

async function writeCsvFiles(graph, storagePath) {
  const csvDir = path.join(storagePath, 'csv');
  await fsp.rm(csvDir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(csvDir, { recursive: true });

  const nodesByLabel = new Map();
  for (const node of graph.nodes.values()) {
    const label = graphNodeLabel(node.type);
    if (!nodesByLabel.has(label)) nodesByLabel.set(label, []);
    nodesByLabel.get(label).push(node);
  }

  const nodeFiles = [];
  for (const [label, nodes] of nodesByLabel) {
    const csvPath = path.join(csvDir, nodeCsvFileName(label));
    const rows = [nodeCsvHeader(label), ...nodes.map(nodeCsvRow)];
    await fsp.writeFile(csvPath, `${rows.join('\n')}\n`, 'utf8');
    nodeFiles.push({ label, csvPath, rows: nodes.length });
  }

  const nodesById = new Map([...graph.nodes.values()].map((node) => [node.id, node]));
  const relsByPair = new Map();
  for (const edge of graph.edges.values()) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source || !target) continue;
    const fromLabel = graphNodeLabel(source.type);
    const toLabel = graphNodeLabel(target.type);
    const key = `${fromLabel}|${toLabel}`;
    if (!relsByPair.has(key)) relsByPair.set(key, { fromLabel, toLabel, rows: [] });
    relsByPair.get(key).rows.push([
      csv(edge.source),
      csv(edge.target),
      csv(edge.type),
      csvNumber(edge.confidence ?? 1, 1),
      csv(edge.reason ?? ''),
      csvNumber(edge.line ?? 0, 0),
    ].join(','));
  }

  const relFiles = [];
  for (const { fromLabel, toLabel, rows } of relsByPair.values()) {
    const csvPath = path.join(csvDir, `rel_${fromLabel}_${toLabel}.csv`);
    await fsp.writeFile(csvPath, `from,to,type,confidence,reason,step\n${rows.join('\n')}\n`, 'utf8');
    relFiles.push({ fromLabel, toLabel, csvPath, rows: rows.length });
  }

  return { csvDir, nodeFiles, relFiles };
}

async function cleanupCsvFiles(csvResult) {
  if (!csvResult?.csvDir) return;
  await fsp.rm(csvResult.csvDir, { recursive: true, force: true }).catch(() => {});
}

async function loadGraphCsvToLbug(conn, graph, storagePath) {
  const csvResult = await writeCsvFiles(graph, storagePath);
  try {
    for (const { label, csvPath } of csvResult.nodeFiles) {
      await exec(conn, nodeCopyQuery(label, csvPath));
    }
    for (const { fromLabel, toLabel, csvPath } of csvResult.relFiles) {
      const p = normalizeCopyPath(csvPath);
      await exec(
        conn,
        `COPY CodeRelation FROM "${p}" (from="${fromLabel}", to="${toLabel}", HEADER=true, ESCAPE='"', DELIM=',', QUOTE='"', PARALLEL=false, auto_detect=false)`,
      );
    }
  } finally {
    await cleanupCsvFiles(csvResult);
  }
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
  const registryPath = vuenexusRegistryPath();
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

export async function writeVueNexusLbug(graph, repoPath, options = {}) {
  repoPath = path.resolve(repoPath);
  const storagePath = path.join(repoPath, '.vuenexus');
  const lbugPath = path.join(storagePath, 'lbug');
  await fsp.mkdir(storagePath, { recursive: true });
  for (const suffix of ['', '.wal', '.lock']) {
    await fsp.rm(lbugPath + suffix, { recursive: true, force: true }).catch(() => {});
  }

  const db = openDb(lbugPath);
  const conn = new lbug.Connection(db);
  try {
    await createSchema(conn);
    await loadGraphCsvToLbug(conn, graph, storagePath);
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

  const registryPath = vuenexusRegistryPath();
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

export async function writeVueNexusEmbeddings(lbugPath, embeddings, summary = {}) {
  const db = openDb(lbugPath);
  const conn = new lbug.Connection(db);
  try {
    await createSchema(conn);
    await exec(conn, 'MATCH (n:CodeEmbedding) DELETE n').catch(() => {});
    await execBatches(conn, embeddings.map((embedding) => codeEmbeddingCreateQuery(embedding)));
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

export async function readVueNexusEmbeddings(lbugPath) {
  try {
    return await queryVueNexusLbug(
      lbugPath,
      'MATCH (n:CodeEmbedding) RETURN n.id AS id, n.nodeId AS nodeId, n.chunkIndex AS chunkIndex, n.startLine AS startLine, n.endLine AS endLine, n.embedding AS embedding, n.contentHash AS contentHash',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('does not exist') || message.includes('No table')) return [];
    throw err;
  }
}

export async function queryVueNexusLbug(lbugPath, query) {
  const db = openDb(lbugPath, { readOnly: true });
  const conn = new lbug.Connection(db);
  try {
    return await exec(conn, query);
  } finally {
    await closeDb(db, conn);
  }
}

export function defaultLbugPath(root = process.cwd()) {
  return path.join(path.resolve(root), '.vuenexus', 'lbug');
}
