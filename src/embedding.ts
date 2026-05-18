// @ts-nocheck
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readVueNexusEmbeddings, writeVueNexusEmbeddings } from './lbug-writer.js';
import { resolveLocalEmbeddingModel } from './model-resolver.js';

function nodeProps(node) {
  return node.properties ?? node;
}

export function embeddingText(node) {
  const props = nodeProps(node);
  const type = props.frontendType ?? node.type ?? node.label ?? 'Node';
  return [
    `${type}: ${props.name ?? node.name ?? ''}`,
    `Path: ${props.filePath ?? node.filePath ?? ''}`,
    props.startLine ? `Lines: ${props.startLine}-${props.endLine ?? props.startLine}` : '',
    props.description ? `Description: ${props.description}` : '',
    '',
    props.content ?? node.content ?? '',
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function contentHash(text) {
  return createHash('sha1').update('vuenexus-frontend-embedding-v1\n').update(text).digest('hex');
}

function normalizeProvider(provider = process.env.VUENEXUS_EMBEDDING_PROVIDER) {
  return provider ?? 'local';
}

async function embedWithHttp(texts, options = {}) {
  const url = options.url ?? process.env.VUENEXUS_EMBEDDING_URL;
  const model = options.model ?? process.env.VUENEXUS_EMBEDDING_MODEL;
  if (!url || !model) throw new Error('VUENEXUS_EMBEDDING_URL and VUENEXUS_EMBEDDING_MODEL are required for provider=http');
  const response = await fetch(url.replace(/\/$/, '') + '/v1/embeddings', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.VUENEXUS_EMBEDDING_API_KEY
        ? { authorization: `Bearer ${process.env.VUENEXUS_EMBEDDING_API_KEY}` }
        : {}),
    },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!response.ok) throw new Error(`Embedding HTTP ${response.status}: ${await response.text()}`);
  const json = await response.json();
  return json.data.map((row) => row.embedding);
}

function embedWithHash(texts, options = {}) {
  const dims = Number(options.dimensions ?? process.env.VUENEXUS_HASH_EMBEDDING_DIMS ?? 384);
  return texts.map((text) => {
    const vector = new Array(dims).fill(0);
    for (const token of text.toLowerCase().match(/[a-z0-9_.$/-]+/g) ?? []) {
      const hash = createHash('sha1').update(token).digest();
      const idx = hash.readUInt32BE(0) % dims;
      const sign = hash[4] % 2 === 0 ? 1 : -1;
      vector[idx] += sign;
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return vector.map((value) => value / norm);
  });
}

async function embedWithLocalModel(texts, options = {}) {
  const resolved = resolveLocalEmbeddingModel(options);
  const model = resolved.model;

  let transformers;
  try {
    transformers = await import('@huggingface/transformers');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Unable to load @huggingface/transformers local runtime. Install optional dependencies for this platform before using provider=local. ${detail}`,
    );
  }

  const { pipeline, env } = transformers;
  if (env) {
    env.allowRemoteModels = process.env.VUENEXUS_ALLOW_REMOTE_MODELS === '1';
    if (process.env.VUENEXUS_TRANSFORMERS_CACHE) env.cacheDir = process.env.VUENEXUS_TRANSFORMERS_CACHE;
    if (path.isAbsolute(model)) env.localModelPath = path.dirname(model);
  }

  const extractor = await pipeline('feature-extraction', model, {
    local_files_only: process.env.VUENEXUS_ALLOW_REMOTE_MODELS !== '1',
  });
  const out = await extractor(texts, { pooling: 'mean', normalize: true });
  const data = Array.from(out.data);
  const dims = out.dims.at(-1);
  const vectors = [];
  for (let i = 0; i < texts.length; i++) vectors.push(data.slice(i * dims, (i + 1) * dims));
  return vectors;
}

export async function embedTexts(texts, options = {}) {
  const provider = normalizeProvider(options.provider);
  if (provider === 'hash') return { vectors: embedWithHash(texts, options), provider, model: 'hash' };
  if (provider === 'http') {
    return {
      vectors: await embedWithHttp(texts, options),
      provider,
      model: options.model ?? process.env.VUENEXUS_EMBEDDING_MODEL,
    };
  }
  if (provider === 'local') {
    return {
      vectors: await embedWithLocalModel(texts, options),
      provider,
      model: resolveLocalEmbeddingModel(options).model,
    };
  }
  throw new Error(`Unsupported embedding provider: ${provider}`);
}

function embeddableNodes(nodes) {
  return [...nodes].filter((node) => {
    const label = node.label ?? node.type;
    return label && label !== 'File' && label !== 'CodeEmbedding';
  });
}

export async function createEmbeddingsForNodes(nodes, options = {}) {
  const batchSize = Number(options.batchSize ?? process.env.VUENEXUS_EMBEDDING_BATCH_SIZE ?? 16);
  const rows = [];
  const selected = embeddableNodes(nodes);
  let provider = normalizeProvider(options.provider);
  let model =
    options.model ??
    process.env.VUENEXUS_LOCAL_EMBEDDING_MODEL ??
    process.env.VUENEXUS_EMBEDDING_MODEL;

  for (let i = 0; i < selected.length; i += batchSize) {
    const batch = selected.slice(i, i + batchSize);
    const texts = batch.map(embeddingText);
    const result = await embedTexts(texts, options);
    provider = result.provider;
    model = result.model;
    for (let j = 0; j < batch.length; j++) {
      const node = batch[j];
      const props = nodeProps(node);
      const text = texts[j];
      rows.push({
        id: `${node.id}:0`,
        nodeId: node.id,
        chunkIndex: 0,
        startLine: props.startLine ?? node.startLine ?? 0,
        endLine: props.endLine ?? node.endLine ?? props.startLine ?? node.startLine ?? 0,
        embedding: result.vectors[j],
        contentHash: contentHash(text),
      });
    }
  }

  return {
    rows,
    summary: {
      embedded: rows.length,
      provider,
      model,
      dimensions: rows[0]?.embedding?.length ?? 0,
    },
  };
}

export async function embedGraphToLbug(lbugPath, nodes, options = {}) {
  const { rows, summary } = await createEmbeddingsForNodes(nodes, options);
  const written = await writeVueNexusEmbeddings(lbugPath, rows, summary);
  return { ...summary, ...written };
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / ((Math.sqrt(na) || 1) * (Math.sqrt(nb) || 1));
}

export async function semanticSearchLbug(lbugPath, nodes, query, limit = 20, options = {}) {
  const embeddings = await readVueNexusEmbeddings(lbugPath);
  if (!embeddings.length) return [];
  let searchOptions = options;
  if (!searchOptions.provider) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(path.dirname(path.resolve(lbugPath)), 'meta.json'), 'utf8'));
      searchOptions = {
        ...searchOptions,
        provider: meta.embeddings?.provider,
        model: searchOptions.model ?? meta.embeddings?.model,
      };
    } catch {}
  }
  const { vectors } = await embedTexts([query], searchOptions);
  const queryVector = vectors[0];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  return embeddings
    .map((row) => {
      const node = nodesById.get(row.nodeId);
      const props = node ? nodeProps(node) : {};
      return {
        nodeId: row.nodeId,
        chunkIndex: row.chunkIndex,
        startLine: row.startLine,
        endLine: row.endLine,
        label: node?.label ?? node?.type,
        name: props.name,
        filePath: props.filePath,
        score: cosine(queryVector, row.embedding ?? []),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
