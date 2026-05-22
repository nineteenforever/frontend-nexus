const NODE_COLORS = {
  File: '#94a3b8',
  Class: '#60a5fa',
  Component: '#43d59e',
  Function: '#fbbf24',
  Method: '#f59e0b',
  Interface: '#a78bfa',
  Route: '#fb7185',
  ExternalModule: '#64748b',
  UnresolvedReference: '#ff6b6b',
};

const HIERARCHY_EDGES = new Set(['DEFINES', 'IMPORTS', 'CONTAINS']);

const state = {
  serverUrl: '',
  repos: [],
  repo: '',
  graph: { nodes: [], relationships: [] },
  positions: new Map(),
  selectedId: '',
  search: '',
  zoom: 1,
  panX: 0,
  panY: 0,
  dragging: false,
  dragStart: null,
};

const el = {
  form: document.querySelector('#connect-form'),
  serverUrl: document.querySelector('#server-url'),
  repoSelect: document.querySelector('#repo-select'),
  search: document.querySelector('#search-input'),
  fit: document.querySelector('#fit-button'),
  status: document.querySelector('#status'),
  stats: document.querySelector('#stats'),
  matches: document.querySelector('#matches'),
  details: document.querySelector('#details'),
  canvas: document.querySelector('#graph-canvas'),
};

const ctx = el.canvas.getContext('2d');

function params() {
  return new URLSearchParams(window.location.search);
}

function defaultServerUrl() {
  return params().get('server') || localStorage.getItem('vuenexus.server') || 'http://127.0.0.1:3000';
}

function setStatus(message, isError = false) {
  el.status.textContent = message;
  el.status.classList.toggle('error', isError);
}

function normalizeServerUrl(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!trimmed) return 'http://127.0.0.1:3000';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1|\[::1\])/i.test(trimmed)) return `http://${trimmed}`;
  return `https://${trimmed}`;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

async function readGraphStream(res) {
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) throw new Error(`Server returned ${res.status}: ${res.statusText}`);
  if (!contentType.includes('application/x-ndjson')) return res.json();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const graph = { nodes: [], relationships: [] };
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) handleGraphLine(graph, line);
    setStatus(`Loading graph: ${graph.nodes.length} nodes, ${graph.relationships.length} edges`);
  }
  if (buffer.trim()) handleGraphLine(graph, buffer);
  return graph;
}

function handleGraphLine(graph, line) {
  if (!line.trim()) return;
  const event = JSON.parse(line);
  if (event.type === 'error') throw new Error(event.error || 'Graph stream failed');
  if (event.type === 'node') graph.nodes.push(event.data);
  if (event.type === 'relationship') graph.relationships.push(event.data);
}

async function connect() {
  state.serverUrl = normalizeServerUrl(el.serverUrl.value);
  el.serverUrl.value = state.serverUrl;
  localStorage.setItem('vuenexus.server', state.serverUrl);
  setStatus('Connecting...');
  const repos = await fetchJson(`${state.serverUrl}/api/repos`);
  state.repos = repos;
  renderRepos();
  if (!repos.length) {
    setStatus('Connected, but no analyzed repos were found');
    state.graph = { nodes: [], relationships: [] };
    renderAll();
    return;
  }
  const preferred = params().get('repo') || localStorage.getItem('vuenexus.repo');
  state.repo = repos.find((repo) => repo.name === preferred)?.name || repos[0].name;
  el.repoSelect.value = state.repo;
  await loadGraph();
}

function renderRepos() {
  el.repoSelect.innerHTML = '';
  for (const repo of state.repos) {
    const option = document.createElement('option');
    option.value = repo.name;
    option.textContent = `${repo.name} (${repo.stats?.nodes ?? 0} nodes)`;
    el.repoSelect.append(option);
  }
}

async function loadGraph() {
  if (!state.repo) return;
  localStorage.setItem('vuenexus.repo', state.repo);
  setStatus(`Loading ${state.repo}...`);
  const url = `${state.serverUrl}/api/graph?repo=${encodeURIComponent(state.repo)}&stream=true`;
  const res = await fetch(url);
  state.graph = await readGraphStream(res);
  state.selectedId = '';
  computeLayout();
  fitGraph();
  renderAll();
  setStatus(`Ready: ${state.graph.nodes.length} nodes, ${state.graph.relationships.length} edges`);
}

function nodeName(node) {
  return node?.properties?.name || node?.name || node?.id || '';
}

function nodeFile(node) {
  return node?.properties?.filePath || '';
}

function nodeLine(node) {
  return node?.properties?.startLine || node?.properties?.line || 0;
}

function nodeMatches(node, query) {
  if (!query) return true;
  const text = [node.id, node.label, nodeName(node), nodeFile(node), node.properties?.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return text.includes(query.toLowerCase());
}

function computeLayout() {
  state.positions.clear();
  const nodes = state.graph.nodes;
  const children = new Map();
  const parent = new Map();
  for (const edge of state.graph.relationships) {
    if (!HIERARCHY_EDGES.has(edge.type)) continue;
    if (!children.has(edge.sourceId)) children.set(edge.sourceId, []);
    children.get(edge.sourceId).push(edge.targetId);
    if (!parent.has(edge.targetId)) parent.set(edge.targetId, edge.sourceId);
  }
  const roots = nodes.filter((node) => !parent.has(node.id) || node.label === 'File');
  const radius = Math.max(280, Math.sqrt(nodes.length) * 42);
  const golden = Math.PI * (3 - Math.sqrt(5));
  roots.forEach((node, index) => {
    const r = radius * Math.sqrt((index + 1) / Math.max(roots.length, 1));
    const angle = index * golden;
    state.positions.set(node.id, { x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  });
  for (const node of nodes) {
    if (state.positions.has(node.id)) continue;
    const parentPos = state.positions.get(parent.get(node.id));
    if (parentPos) {
      const index = children.get(parent.get(node.id))?.indexOf(node.id) ?? 0;
      const angle = index * golden;
      const r = 35 + (index % 7) * 12;
      state.positions.set(node.id, {
        x: parentPos.x + Math.cos(angle) * r,
        y: parentPos.y + Math.sin(angle) * r,
      });
    } else {
      const index = state.positions.size;
      const angle = index * golden;
      state.positions.set(node.id, {
        x: Math.cos(angle) * radius * 0.5,
        y: Math.sin(angle) * radius * 0.5,
      });
    }
  }
}

function resizeCanvas() {
  const rect = el.canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (el.canvas.width !== width || el.canvas.height !== height) {
    el.canvas.width = width;
    el.canvas.height = height;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function screenPoint(pos) {
  const rect = el.canvas.getBoundingClientRect();
  return {
    x: rect.width / 2 + (pos.x + state.panX) * state.zoom,
    y: rect.height / 2 + (pos.y + state.panY) * state.zoom,
  };
}

function worldPoint(x, y) {
  const rect = el.canvas.getBoundingClientRect();
  return {
    x: (x - rect.width / 2) / state.zoom - state.panX,
    y: (y - rect.height / 2) / state.zoom - state.panY,
  };
}

function fitGraph() {
  const positions = [...state.positions.values()];
  if (!positions.length) return;
  const rect = el.canvas.getBoundingClientRect();
  const xs = positions.map((p) => p.x);
  const ys = positions.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  state.zoom = Math.min(1.6, Math.max(0.12, Math.min(rect.width / (width + 120), rect.height / (height + 120))));
  state.panX = -(minX + maxX) / 2;
  state.panY = -(minY + maxY) / 2;
  draw();
}

function draw() {
  resizeCanvas();
  const rect = el.canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  const query = state.search.trim();
  const matched = new Set(state.graph.nodes.filter((node) => nodeMatches(node, query)).map((node) => node.id));
  ctx.lineWidth = 1;
  for (const edge of state.graph.relationships) {
    const a = state.positions.get(edge.sourceId);
    const b = state.positions.get(edge.targetId);
    if (!a || !b) continue;
    const pa = screenPoint(a);
    const pb = screenPoint(b);
    const highlight = edge.sourceId === state.selectedId || edge.targetId === state.selectedId;
    ctx.strokeStyle = highlight ? 'rgba(67, 213, 158, 0.78)' : 'rgba(100, 116, 139, 0.22)';
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }
  for (const node of state.graph.nodes) {
    const pos = state.positions.get(node.id);
    if (!pos) continue;
    const p = screenPoint(pos);
    const isSelected = node.id === state.selectedId;
    const isMatch = matched.has(node.id);
    const size = nodeSize(node) * Math.sqrt(state.zoom);
    ctx.globalAlpha = query && !isMatch && !isSelected ? 0.22 : 1;
    ctx.fillStyle = NODE_COLORS[node.label] || '#cbd5e1';
    ctx.beginPath();
    ctx.arc(p.x, p.y, isSelected ? size + 3 : size, 0, Math.PI * 2);
    ctx.fill();
    if (isSelected) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (state.zoom > 0.35 && (isSelected || isMatch || ['Component', 'Route', 'Class'].includes(node.label))) {
      ctx.fillStyle = '#e5edf5';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(nodeName(node).slice(0, 32), p.x + size + 4, p.y + 4);
    }
    ctx.globalAlpha = 1;
  }
}

function nodeSize(node) {
  if (node.label === 'File') return 4;
  if (node.label === 'Component' || node.label === 'Class') return 8;
  if (node.label === 'Route') return 7;
  if (node.label === 'UnresolvedReference') return 6;
  return 5;
}

function renderAll() {
  renderStats();
  renderMatches();
  renderDetails();
  draw();
}

function renderStats() {
  const counts = {};
  for (const node of state.graph.nodes) counts[node.label] = (counts[node.label] || 0) + 1;
  const rows = [
    ['Nodes', state.graph.nodes.length],
    ['Edges', state.graph.relationships.length],
    ...Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8),
  ];
  el.stats.innerHTML = rows.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${value}</dd>`).join('');
}

function renderMatches() {
  const query = state.search.trim();
  const nodes = state.graph.nodes
    .filter((node) => nodeMatches(node, query))
    .slice(0, 60);
  el.matches.innerHTML = nodes.map((node) => `
    <div class="match" data-node-id="${escapeAttr(node.id)}">
      <div class="node-name">${escapeHtml(nodeName(node))}</div>
      <div class="node-meta">${escapeHtml(node.label)} · ${escapeHtml(nodeFile(node))}</div>
    </div>
  `).join('') || '<div class="details empty">No matches</div>';
}

function renderDetails() {
  const node = state.graph.nodes.find((item) => item.id === state.selectedId);
  if (!node) {
    el.details.className = 'details empty';
    el.details.textContent = 'Select a node to inspect relationships.';
    return;
  }
  el.details.className = 'details';
  const related = state.graph.relationships
    .filter((edge) => edge.sourceId === node.id || edge.targetId === node.id)
    .slice(0, 80);
  const nodeById = new Map(state.graph.nodes.map((item) => [item.id, item]));
  el.details.innerHTML = `
    <h3>${escapeHtml(nodeName(node))}</h3>
    <div>
      <span class="badge">${escapeHtml(node.label)}</span>
      ${nodeLine(node) ? `<span class="badge">line ${nodeLine(node)}</span>` : ''}
    </div>
    <div class="path">${escapeHtml(nodeFile(node) || node.id)}</div>
    <div class="relations">
      ${related.map((edge) => {
        const outgoing = edge.sourceId === node.id;
        const other = nodeById.get(outgoing ? edge.targetId : edge.sourceId);
        const arrow = outgoing ? '->' : '<-';
        return `
          <div class="relation" data-node-id="${escapeAttr(other?.id || '')}">
            <div class="node-name">${escapeHtml(edge.type)} ${arrow} ${escapeHtml(nodeName(other) || 'unknown')}</div>
            <div class="relation-meta">${escapeHtml(other?.label || '')} · ${escapeHtml(other ? nodeFile(other) : '')}</div>
          </div>
        `;
      }).join('') || '<div class="details empty">No direct relationships</div>'}
    </div>
  `;
}

function selectNode(id) {
  if (!id) return;
  state.selectedId = id;
  renderDetails();
  draw();
}

function nearestNode(clientX, clientY) {
  const rect = el.canvas.getBoundingClientRect();
  const target = worldPoint(clientX - rect.left, clientY - rect.top);
  let best = null;
  let bestDist = Infinity;
  for (const node of state.graph.nodes) {
    const pos = state.positions.get(node.id);
    if (!pos) continue;
    const dx = pos.x - target.x;
    const dy = pos.y - target.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < bestDist) {
      best = node;
      bestDist = dist;
    }
  }
  return bestDist * state.zoom < 18 ? best : null;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

el.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await connect();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
});

el.repoSelect.addEventListener('change', async () => {
  state.repo = el.repoSelect.value;
  try {
    await loadGraph();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
});

el.search.addEventListener('input', () => {
  state.search = el.search.value;
  renderMatches();
  draw();
});

el.fit.addEventListener('click', fitGraph);

el.matches.addEventListener('click', (event) => {
  const item = event.target.closest('[data-node-id]');
  selectNode(item?.dataset.nodeId);
});

el.details.addEventListener('click', (event) => {
  const item = event.target.closest('[data-node-id]');
  selectNode(item?.dataset.nodeId);
});

el.canvas.addEventListener('mousedown', (event) => {
  state.dragging = true;
  state.dragStart = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY };
});

window.addEventListener('mouseup', () => {
  state.dragging = false;
});

window.addEventListener('mousemove', (event) => {
  if (!state.dragging || !state.dragStart) return;
  state.panX = state.dragStart.panX + (event.clientX - state.dragStart.x) / state.zoom;
  state.panY = state.dragStart.panY + (event.clientY - state.dragStart.y) / state.zoom;
  draw();
});

el.canvas.addEventListener('click', (event) => {
  if (state.dragStart && Math.hypot(event.clientX - state.dragStart.x, event.clientY - state.dragStart.y) > 4) return;
  const node = nearestNode(event.clientX, event.clientY);
  if (node) selectNode(node.id);
});

el.canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  const factor = event.deltaY > 0 ? 0.9 : 1.1;
  state.zoom = Math.max(0.08, Math.min(4, state.zoom * factor));
  draw();
}, { passive: false });

window.addEventListener('resize', draw);

el.serverUrl.value = defaultServerUrl();
connect().catch((err) => setStatus(err instanceof Error ? err.message : String(err), true));
