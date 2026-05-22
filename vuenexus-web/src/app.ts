type NodeProperties = {
  name?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  line?: number;
  description?: string;
};

type GraphNode = {
  id: string;
  label: string;
  properties: NodeProperties;
};

type GraphRelationship = {
  sourceId: string;
  targetId: string;
  type: string;
  properties?: {
    confidence?: number;
    reason?: string;
    step?: number;
  };
};

type KnowledgeGraph = {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
};

type RepoInfo = {
  name: string;
  path: string;
  stats?: {
    files?: number;
    nodes?: number;
    edges?: number;
  };
};

type Position = {
  x: number;
  y: number;
};

type DragStart = {
  x: number;
  y: number;
  panX: number;
  panY: number;
};

type GraphStreamEvent =
  | { type: 'node'; data: GraphNode }
  | { type: 'relationship'; data: GraphRelationship }
  | { type: 'error'; error: string };

const NODE_COLORS: Record<string, string> = {
  File: '#94a3b8',
  Class: '#43d59e',
  Component: '#43d59e',
  Function: '#fbbf24',
  Method: '#f59e0b',
  Interface: '#a78bfa',
  Route: '#fb7185',
  ExternalModule: '#64748b',
  UnresolvedReference: '#ff6b6b',
};

const HIERARCHY_EDGES = new Set(['DEFINES', 'IMPORTS', 'CONTAINS']);
const IMPORTANT_LABELS = new Set(['Class', 'Component', 'Route', 'Function']);

const state = {
  serverUrl: '',
  repos: [] as RepoInfo[],
  repo: '',
  graph: { nodes: [], relationships: [] } as KnowledgeGraph,
  positions: new Map<string, Position>(),
  selectedId: '',
  search: '',
  edgeFilter: '',
  zoom: 1,
  panX: 0,
  panY: 0,
  dragging: false,
  dragStart: null as DragStart | null,
};

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.querySelector<T>(id);
  if (!element) throw new Error(`Missing UI element: ${id}`);
  return element;
};

const el = {
  form: byId<HTMLFormElement>('#connect-form'),
  serverUrl: byId<HTMLInputElement>('#server-url'),
  repoSelect: byId<HTMLSelectElement>('#repo-select'),
  search: byId<HTMLInputElement>('#search-input'),
  edgeFilter: byId<HTMLSelectElement>('#edge-filter'),
  fit: byId<HTMLButtonElement>('#fit-button'),
  status: byId<HTMLDivElement>('#status'),
  stats: byId<HTMLElement>('#stats'),
  legend: byId<HTMLDivElement>('#legend'),
  matches: byId<HTMLDivElement>('#matches'),
  details: byId<HTMLDivElement>('#details'),
  canvas: byId<HTMLCanvasElement>('#graph-canvas'),
  summaryNodes: byId<HTMLElement>('#summary-nodes'),
  summaryEdges: byId<HTMLElement>('#summary-edges'),
  summaryFiles: byId<HTMLElement>('#summary-files'),
  summaryComponents: byId<HTMLElement>('#summary-components'),
};

const canvasContext = el.canvas.getContext('2d');
if (!canvasContext) throw new Error('Canvas 2D context is unavailable');
const ctx: CanvasRenderingContext2D = canvasContext;

function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

function defaultServerUrl(): string {
  return params().get('server') || localStorage.getItem('vuenexus.server') || 'http://127.0.0.1:3000';
}

function setStatus(message: string, isError = false): void {
  el.status.textContent = message;
  el.status.classList.toggle('error', isError);
}

function normalizeServerUrl(value: string): string {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!trimmed) return 'http://127.0.0.1:3000';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1|\[::1\])/i.test(trimmed)) return `http://${trimmed}`;
  return `https://${trimmed}`;
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // keep HTTP status message
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

async function readGraphStream(res: Response): Promise<KnowledgeGraph> {
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) throw new Error(`Server returned ${res.status}: ${res.statusText}`);
  if (!contentType.includes('application/x-ndjson')) return res.json() as Promise<KnowledgeGraph>;
  if (!res.body) throw new Error('Graph stream response has no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const graph: KnowledgeGraph = { nodes: [], relationships: [] };
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

function handleGraphLine(graph: KnowledgeGraph, line: string): void {
  if (!line.trim()) return;
  const event = JSON.parse(line) as GraphStreamEvent;
  if (event.type === 'error') throw new Error(event.error || 'Graph stream failed');
  if (event.type === 'node') graph.nodes.push(event.data);
  if (event.type === 'relationship') graph.relationships.push(event.data);
}

async function connect(): Promise<void> {
  state.serverUrl = normalizeServerUrl(el.serverUrl.value);
  el.serverUrl.value = state.serverUrl;
  localStorage.setItem('vuenexus.server', state.serverUrl);
  setStatus('Connecting...');
  const repos = await fetchJson<RepoInfo[]>(`${state.serverUrl}/api/repos`);
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

function renderRepos(): void {
  el.repoSelect.innerHTML = '';
  for (const repo of state.repos) {
    const option = document.createElement('option');
    option.value = repo.name;
    option.textContent = `${repo.name} (${repo.stats?.nodes ?? 0} nodes)`;
    el.repoSelect.append(option);
  }
}

async function loadGraph(): Promise<void> {
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

function nodeName(node?: GraphNode): string {
  return node?.properties?.name || node?.id || '';
}

function nodeFile(node?: GraphNode): string {
  return node?.properties?.filePath || '';
}

function nodeLine(node?: GraphNode): number {
  return node?.properties?.startLine || node?.properties?.line || 0;
}

function nodeFrontendType(node: GraphNode): string {
  const description = node.properties?.description;
  if (!description) return node.label;
  try {
    const parsed = JSON.parse(description) as { frontendType?: string };
    return parsed.frontendType || node.label;
  } catch {
    return node.label;
  }
}

function nodeMatches(node: GraphNode, query: string): boolean {
  if (!query) return true;
  const text = [node.id, node.label, nodeFrontendType(node), nodeName(node), nodeFile(node), node.properties?.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return text.includes(query.toLowerCase());
}

function visibleRelationships(): GraphRelationship[] {
  if (!state.edgeFilter) return state.graph.relationships;
  return state.graph.relationships.filter((edge) => edge.type === state.edgeFilter);
}

function computeLayout(): void {
  state.positions.clear();
  const nodes = state.graph.nodes;
  const children = new Map<string, string[]>();
  const parent = new Map<string, string>();

  for (const edge of state.graph.relationships) {
    if (!HIERARCHY_EDGES.has(edge.type)) continue;
    if (!children.has(edge.sourceId)) children.set(edge.sourceId, []);
    children.get(edge.sourceId)?.push(edge.targetId);
    if (!parent.has(edge.targetId)) parent.set(edge.targetId, edge.sourceId);
  }

  const roots = nodes.filter((node) => !parent.has(node.id) || node.label === 'File');
  const radius = Math.max(300, Math.sqrt(nodes.length) * 46);
  const golden = Math.PI * (3 - Math.sqrt(5));

  roots.forEach((node, index) => {
    const r = radius * Math.sqrt((index + 1) / Math.max(roots.length, 1));
    const angle = index * golden;
    state.positions.set(node.id, { x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  });

  for (const node of nodes) {
    if (state.positions.has(node.id)) continue;
    const parentId = parent.get(node.id);
    const parentPos = parentId ? state.positions.get(parentId) : undefined;
    if (parentPos) {
      const index = parentId ? children.get(parentId)?.indexOf(node.id) ?? 0 : 0;
      const angle = index * golden;
      const r = 42 + (index % 8) * 12;
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

function resizeCanvas(): DOMRect {
  const rect = el.canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (el.canvas.width !== width || el.canvas.height !== height) {
    el.canvas.width = width;
    el.canvas.height = height;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return rect;
}

function screenPoint(pos: Position): Position {
  const rect = el.canvas.getBoundingClientRect();
  return {
    x: rect.width / 2 + (pos.x + state.panX) * state.zoom,
    y: rect.height / 2 + (pos.y + state.panY) * state.zoom,
  };
}

function worldPoint(x: number, y: number): Position {
  const rect = el.canvas.getBoundingClientRect();
  return {
    x: (x - rect.width / 2) / state.zoom - state.panX,
    y: (y - rect.height / 2) / state.zoom - state.panY,
  };
}

function fitGraph(): void {
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
  state.zoom = Math.min(1.6, Math.max(0.1, Math.min(rect.width / (width + 160), rect.height / (height + 160))));
  state.panX = -(minX + maxX) / 2;
  state.panY = -(minY + maxY) / 2;
  draw();
}

function draw(): void {
  const rect = resizeCanvas();
  ctx.clearRect(0, 0, rect.width, rect.height);

  const query = state.search.trim();
  const matched = new Set(state.graph.nodes.filter((node) => nodeMatches(node, query)).map((node) => node.id));
  const filteredEdges = visibleRelationships();

  ctx.lineWidth = 1;
  for (const edge of filteredEdges) {
    const a = state.positions.get(edge.sourceId);
    const b = state.positions.get(edge.targetId);
    if (!a || !b) continue;
    const pa = screenPoint(a);
    const pb = screenPoint(b);
    const highlight = edge.sourceId === state.selectedId || edge.targetId === state.selectedId;
    ctx.strokeStyle = highlight ? 'rgba(67, 213, 158, 0.82)' : edgeColor(edge.type, 0.28);
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
    ctx.globalAlpha = query && !isMatch && !isSelected ? 0.2 : 1;
    ctx.fillStyle = nodeColor(node);
    ctx.beginPath();
    ctx.arc(p.x, p.y, isSelected ? size + 4 : size, 0, Math.PI * 2);
    ctx.fill();
    if (isSelected) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (state.zoom > 0.36 && (isSelected || isMatch || IMPORTANT_LABELS.has(node.label))) {
      ctx.fillStyle = '#e5edf5';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(nodeName(node).slice(0, 34), p.x + size + 5, p.y + 4);
    }
    ctx.globalAlpha = 1;
  }
}

function edgeColor(type: string, alpha = 1): string {
  const color: Record<string, [number, number, number]> = {
    CALLS: [251, 191, 36],
    RENDERS: [67, 213, 158],
    HANDLES: [106, 168, 255],
    ROUTES_TO: [251, 113, 133],
    IMPORTS: [148, 163, 184],
    DEFINES: [100, 116, 139],
  };
  const [r, g, b] = color[type] || [100, 116, 139];
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function nodeColor(node: GraphNode): string {
  return NODE_COLORS[nodeFrontendType(node)] || NODE_COLORS[node.label] || '#cbd5e1';
}

function nodeSize(node: GraphNode): number {
  const type = nodeFrontendType(node);
  if (node.label === 'File') return 4;
  if (type === 'Component' || node.label === 'Class') return 8;
  if (node.label === 'Route') return 7;
  if (node.label === 'UnresolvedReference') return 6;
  return 5;
}

function renderAll(): void {
  renderSummary();
  renderStats();
  renderLegend();
  renderMatches();
  renderDetails();
  draw();
}

function renderSummary(): void {
  el.summaryNodes.textContent = String(state.graph.nodes.length);
  el.summaryEdges.textContent = String(state.graph.relationships.length);
  el.summaryFiles.textContent = String(state.graph.nodes.filter((node) => node.label === 'File').length);
  el.summaryComponents.textContent = String(state.graph.nodes.filter((node) => nodeFrontendType(node) === 'Component').length);
}

function renderStats(): void {
  const counts: Record<string, number> = {};
  for (const node of state.graph.nodes) {
    const type = nodeFrontendType(node);
    counts[type] = (counts[type] || 0) + 1;
  }
  const rows: [string, number][] = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  el.stats.innerHTML = rows.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${value}</dd>`).join('');
}

function renderLegend(): void {
  const types = [...new Set(state.graph.nodes.map(nodeFrontendType))]
    .sort()
    .slice(0, 12);
  el.legend.innerHTML = types.map((type) => `
    <div class="legend-item">
      <span class="legend-name"><span class="dot" style="background:${escapeAttr(NODE_COLORS[type] || '#cbd5e1')}"></span>${escapeHtml(type)}</span>
      <span>${state.graph.nodes.filter((node) => nodeFrontendType(node) === type).length}</span>
    </div>
  `).join('');
}

function renderMatches(): void {
  const query = state.search.trim();
  const nodes = state.graph.nodes
    .filter((node) => nodeMatches(node, query))
    .slice(0, 70);
  el.matches.innerHTML = nodes.map((node) => `
    <div class="match" data-node-id="${escapeAttr(node.id)}">
      <div class="node-name">${escapeHtml(nodeName(node))}</div>
      <div class="node-meta">${escapeHtml(nodeFrontendType(node))} · ${escapeHtml(nodeFile(node))}</div>
    </div>
  `).join('') || '<div class="details empty">No matches</div>';
}

function renderDetails(): void {
  const node = state.graph.nodes.find((item) => item.id === state.selectedId);
  if (!node) {
    el.details.className = 'details empty';
    el.details.textContent = 'Select a node to inspect relationships.';
    return;
  }
  el.details.className = 'details';
  const related = state.graph.relationships
    .filter((edge) => edge.sourceId === node.id || edge.targetId === node.id)
    .slice(0, 90);
  const nodeById = new Map(state.graph.nodes.map((item) => [item.id, item]));
  el.details.innerHTML = `
    <h3>${escapeHtml(nodeName(node))}</h3>
    <div>
      <span class="badge">${escapeHtml(nodeFrontendType(node))}</span>
      <span class="badge">${escapeHtml(node.label)}</span>
      ${nodeLine(node) ? `<span class="badge">line ${nodeLine(node)}</span>` : ''}
    </div>
    <div class="path">${escapeHtml(nodeFile(node) || node.id)}</div>
    <div class="relations">
      ${related.map((edge) => {
        const outgoing = edge.sourceId === node.id;
        const other = nodeById.get(outgoing ? edge.targetId : edge.sourceId);
        const arrow = outgoing ? '->' : '<-';
        const reason = edge.properties?.reason ? ` · ${edge.properties.reason}` : '';
        return `
          <div class="relation" data-node-id="${escapeAttr(other?.id || '')}">
            <div class="node-name">${escapeHtml(edge.type)} ${arrow} ${escapeHtml(nodeName(other) || 'unknown')}</div>
            <div class="relation-meta">${escapeHtml(other ? nodeFrontendType(other) : '')} · ${escapeHtml(other ? nodeFile(other) : '')}${escapeHtml(reason)}</div>
          </div>
        `;
      }).join('') || '<div class="details empty">No direct relationships</div>'}
    </div>
  `;
}

function selectNode(id?: string): void {
  if (!id) return;
  state.selectedId = id;
  renderDetails();
  draw();
}

function nearestNode(clientX: number, clientY: number): GraphNode | null {
  const rect = el.canvas.getBoundingClientRect();
  const target = worldPoint(clientX - rect.left, clientY - rect.top);
  let best: GraphNode | null = null;
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

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch] ?? ch);
}

function escapeAttr(value: unknown): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

el.form.addEventListener('submit', (event) => {
  event.preventDefault();
  connect().catch((err: unknown) => setStatus(err instanceof Error ? err.message : String(err), true));
});

el.repoSelect.addEventListener('change', () => {
  state.repo = el.repoSelect.value;
  loadGraph().catch((err: unknown) => setStatus(err instanceof Error ? err.message : String(err), true));
});

el.search.addEventListener('input', () => {
  state.search = el.search.value;
  renderMatches();
  draw();
});

el.edgeFilter.addEventListener('change', () => {
  state.edgeFilter = el.edgeFilter.value;
  draw();
});

el.fit.addEventListener('click', fitGraph);

el.matches.addEventListener('click', (event) => {
  const item = (event.target as HTMLElement).closest<HTMLElement>('[data-node-id]');
  selectNode(item?.dataset.nodeId);
});

el.details.addEventListener('click', (event) => {
  const item = (event.target as HTMLElement).closest<HTMLElement>('[data-node-id]');
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
connect().catch((err: unknown) => setStatus(err instanceof Error ? err.message : String(err), true));
