import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export function openGraphDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  const schemaPath = new URL('../schema.sql', import.meta.url);
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  return db;
}

export function resetGraph(db) {
  db.exec(`
    DELETE FROM graph_meta;
    DELETE FROM embeddings;
    DELETE FROM edges;
    DELETE FROM nodes;
    DELETE FROM node_fts;
  `);
}

export function createWriter(db) {
  const nodeStmt = db.prepare(`
    INSERT OR REPLACE INTO nodes
    (id, type, name, file_path, start_line, end_line, exported, content, meta_json)
    VALUES
    (@id, @type, @name, @filePath, @startLine, @endLine, @exported, @content, @metaJson)
  `);
  const ftsStmt = db.prepare(`
    INSERT INTO node_fts (id, name, type, file_path, content)
    VALUES (@id, @name, @type, @filePath, @content)
  `);
  const edgeStmt = db.prepare(`
    INSERT OR IGNORE INTO edges
    (id, source, target, type, confidence, reason, source_file_path, target_file_path, line, meta_json)
    VALUES
    (@id, @source, @target, @type, @confidence, @reason, @sourceFilePath, @targetFilePath, @line, @metaJson)
  `);
  const metaStmt = db.prepare(`
    INSERT OR REPLACE INTO graph_meta (key, value)
    VALUES (@key, @value)
  `);

  const write = db.transaction((graph) => {
    metaStmt.run({ key: 'root', value: graph.root });
    metaStmt.run({ key: 'indexedAt', value: new Date().toISOString() });
    metaStmt.run({ key: 'files', value: String(graph.files ?? 0) });
    for (const node of graph.nodes.values()) {
      nodeStmt.run({
        ...node,
        exported: node.exported ? 1 : 0,
        metaJson: JSON.stringify(node.meta ?? {}),
      });
      ftsStmt.run(node);
    }
    for (const edge of graph.edges.values()) {
      edgeStmt.run({
        ...edge,
        metaJson: JSON.stringify(edge.meta ?? {}),
      });
    }
  });

  return { write };
}

export function graphStats(db) {
  const nodeTypes = db
    .prepare('SELECT type, COUNT(*) AS count FROM nodes GROUP BY type ORDER BY count DESC, type')
    .all();
  const edgeTypes = db
    .prepare('SELECT type, COUNT(*) AS count FROM edges GROUP BY type ORDER BY count DESC, type')
    .all();
  const meta = Object.fromEntries(
    db.prepare('SELECT key, value FROM graph_meta ORDER BY key').all().map((row) => [row.key, row.value]),
  );
  const totals = {
    nodes: db.prepare('SELECT COUNT(*) AS count FROM nodes').get().count,
    edges: db.prepare('SELECT COUNT(*) AS count FROM edges').get().count,
    embeddings: db.prepare('SELECT COUNT(*) AS count FROM embeddings').get().count,
  };
  return { meta, totals, nodeTypes, edgeTypes };
}

export function exportGraph(db) {
  return {
    stats: graphStats(db),
    nodes: db.prepare('SELECT * FROM nodes ORDER BY file_path, start_line, type, name').all(),
    edges: db.prepare('SELECT * FROM edges ORDER BY source_file_path, line, type, source, target').all(),
  };
}

export function nodeContext(db, symbolOrId, limit = 40) {
  const slice = graphSlice(db, symbolOrId, limit);
  const node = slice.nodes[0];
  if (!node) return { node: null, incoming: [], outgoing: [] };
  return {
    node,
    incoming: slice.edges.filter((edge) => edge.target === node.id),
    outgoing: slice.edges.filter((edge) => edge.source === node.id),
  };
}

export function searchNodes(db, query, limit = 20) {
  const q = query.trim();
  if (!q) return [];
  return db
    .prepare(
      `
      SELECT n.*, bm25(node_fts) AS score
      FROM node_fts
      JOIN nodes n ON n.id = node_fts.id
      WHERE node_fts MATCH ?
      ORDER BY
        CASE
          WHEN n.name = ? THEN 0
          WHEN n.name LIKE ? THEN 1
          ELSE 2
        END,
        score
      LIMIT ?
    `,
    )
    .all(`${q.replace(/"/g, '""')}*`, q, `%${q}%`, limit);
}

function readLimit(query, fallback = 100) {
  const match = /\bLIMIT\s+(\d+)/i.exec(query);
  return match ? Math.min(Number(match[1]), 1000) : fallback;
}

export function runCypherCompat(db, query) {
  const q = query.trim();
  if (!q) return [];

  try {
    return db.prepare(q).all();
  } catch (sqlError) {
    const limit = readLimit(q);
    if (/^MATCH\s*\(\s*n\s*(?::([A-Za-z]+))?\s*\)\s*RETURN\s+n/i.test(q)) {
      const [, type] = /^MATCH\s*\(\s*n\s*(?::([A-Za-z]+))?\s*\)/i.exec(q) ?? [];
      return type
        ? db.prepare('SELECT * FROM nodes WHERE type = ? LIMIT ?').all(type, limit)
        : db.prepare('SELECT * FROM nodes LIMIT ?').all(limit);
    }

    const named = /^MATCH\s*\(\s*n\s*(?::([A-Za-z]+))?\s*\{\s*name\s*:\s*['"]([^'"]+)['"]\s*\}\s*\)\s*RETURN\s+n/i.exec(q);
    if (named) {
      const [, type, name] = named;
      return type
        ? db.prepare('SELECT * FROM nodes WHERE type = ? AND name = ? LIMIT ?').all(type, name, limit)
        : db.prepare('SELECT * FROM nodes WHERE name = ? LIMIT ?').all(name, limit);
    }

    if (/^MATCH\s*\(\s*\)\s*-\s*\[\s*r\s*(?::([A-Z_]+))?\s*\]\s*->\s*\(\s*\)\s*RETURN\s+r/i.test(q)) {
      const [, type] =
        /^MATCH\s*\(\s*\)\s*-\s*\[\s*r\s*(?::([A-Z_]+))?\s*\]\s*->\s*\(\s*\)/i.exec(q) ?? [];
      return type
        ? db.prepare('SELECT * FROM edges WHERE type = ? LIMIT ?').all(type, limit)
        : db.prepare('SELECT * FROM edges LIMIT ?').all(limit);
    }

    if (/^MATCH\s*\(\s*a\s*\)\s*-\s*\[\s*r\s*(?::([A-Z_]+))?\s*\]\s*->\s*\(\s*b\s*\)\s*RETURN\s+a\s*,\s*r\s*,\s*b/i.test(q)) {
      const [, type] =
        /^MATCH\s*\(\s*a\s*\)\s*-\s*\[\s*r\s*(?::([A-Z_]+))?\s*\]\s*->\s*\(\s*b\s*\)/i.exec(q) ?? [];
      const sql = `
        SELECT
          a.id AS source_id, a.type AS source_type, a.name AS source_name, a.file_path AS source_file_path,
          r.type AS edge_type, r.line AS edge_line, r.reason AS edge_reason,
          b.id AS target_id, b.type AS target_type, b.name AS target_name, b.file_path AS target_file_path
        FROM edges r
        JOIN nodes a ON a.id = r.source
        JOIN nodes b ON b.id = r.target
        ${type ? 'WHERE r.type = ?' : ''}
        LIMIT ?
      `;
      return type ? db.prepare(sql).all(type, limit) : db.prepare(sql).all(limit);
    }

    throw new Error(
      `Unsupported gitnexus cypher query for the SQLite frontend graph. ` +
        `Use SQL over nodes/edges, or a supported subset like MATCH (n:Component) RETURN n LIMIT 20. ` +
        `Original SQL error: ${sqlError.message}`,
    );
  }
}

export function graphSlice(db, symbolOrId, limit = 80) {
  const node =
    db.prepare('SELECT * FROM nodes WHERE id = ?').get(symbolOrId) ??
    db.prepare('SELECT * FROM nodes WHERE name = ? ORDER BY start_line LIMIT 1').get(symbolOrId);
  if (!node) return { nodes: [], edges: [] };

  const edges = db
    .prepare(
      `
      SELECT * FROM edges
      WHERE source = ? OR target = ?
      ORDER BY type, line
      LIMIT ?
    `,
    )
    .all(node.id, node.id, limit);
  const ids = new Set([node.id]);
  for (const edge of edges) {
    ids.add(edge.source);
    ids.add(edge.target);
  }
  const nodes = [...ids].map((id) => db.prepare('SELECT * FROM nodes WHERE id = ?').get(id));
  return { nodes: nodes.filter(Boolean), edges };
}

export function callChain(db, from, depth = 4, limit = 200) {
  const start =
    db.prepare('SELECT * FROM nodes WHERE id = ?').get(from) ??
    db.prepare('SELECT * FROM nodes WHERE name = ? ORDER BY start_line LIMIT 1').get(from);
  if (!start) return { nodes: [], edges: [] };

  const edgeStmt = db.prepare(`
    SELECT * FROM edges
    WHERE source = ? AND type IN ('CALLS', 'RENDERS', 'HANDLES', 'ROUTES_TO', 'USES_STORE')
    ORDER BY line, target
  `);
  const nodeStmt = db.prepare('SELECT * FROM nodes WHERE id = ?');
  const seen = new Set([start.id]);
  const nodes = new Map([[start.id, start]]);
  const edges = [];
  const queue = [{ id: start.id, depth: 0 }];

  while (queue.length && edges.length < limit) {
    const current = queue.shift();
    if (current.depth >= depth) continue;
    for (const edge of edgeStmt.all(current.id)) {
      edges.push(edge);
      if (!seen.has(edge.target)) {
        seen.add(edge.target);
        const target = nodeStmt.get(edge.target);
        if (target) nodes.set(target.id, target);
        queue.push({ id: edge.target, depth: current.depth + 1 });
      }
      if (edges.length >= limit) break;
    }
  }
  return { nodes: [...nodes.values()], edges };
}
