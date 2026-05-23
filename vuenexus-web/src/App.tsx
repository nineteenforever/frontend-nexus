import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Boxes,
  ChevronRight,
  CircleDot,
  Component,
  FileCode2,
  Filter,
  Focus,
  GitBranch,
  Globe2,
  Layers3,
  Loader2,
  Network,
  Play,
  RefreshCcw,
  Route,
  Search,
  Server,
  Workflow,
  Zap,
} from 'lucide-react';

type NodeProperties = {
  name?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  line?: number;
  description?: string;
  reason?: string;
  text?: string;
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
  indexedAt?: string;
  stats?: {
    files?: number;
    nodes?: number;
    edges?: number;
  };
};

type LayoutNode = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
};

type Vec2 = {
  x: number;
  y: number;
};

type DragState =
  | { mode: 'pan'; x: number; y: number; panX: number; panY: number }
  | { mode: 'node'; nodeId: string };

type StreamEvent =
  | { type: 'node'; data: GraphNode }
  | { type: 'relationship'; data: GraphRelationship }
  | { type: 'error'; error: string };

const NODE_COLORS: Record<string, string> = {
  File: '#5ea0ff',
  Class: '#43d59e',
  Component: '#43d59e',
  Function: '#ffd166',
  Method: '#f59e0b',
  Interface: '#c084fc',
  Variable: '#2dd4bf',
  Route: '#fb7185',
  ExternalModule: '#64748b',
  UnresolvedReference: '#ff6b6b',
  CodeElement: '#38bdf8',
};

const IMPORTANT_EDGES = new Set(['CALLS', 'RENDERS', 'HANDLES', 'ROUTES_TO', 'USES_STORE']);
const STRUCTURE_EDGES = new Set(['DEFINES', 'IMPORTS']);

function normalizeServerUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return 'http://127.0.0.1:3000';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1|\[::1\])/i.test(trimmed)) return `http://${trimmed}`;
  return `https://${trimmed}`;
}

function initialServerUrl(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('server') || localStorage.getItem('vuenexus-web.server') || 'http://127.0.0.1:3000';
}

function nodeName(node?: GraphNode): string {
  return node?.properties?.name || node?.id || '';
}

function nodeFile(node?: GraphNode): string {
  return node?.properties?.filePath || '';
}

function nodeLine(node?: GraphNode): number | undefined {
  return node?.properties?.startLine || node?.properties?.line;
}

function frontendType(node: GraphNode): string {
  const description = node.properties?.description;
  if (!description) return node.label;
  try {
    const parsed = JSON.parse(description) as { frontendType?: string };
    return parsed.frontendType || node.label;
  } catch {
    return node.label;
  }
}

function nodeColor(node: GraphNode): string {
  return NODE_COLORS[frontendType(node)] || NODE_COLORS[node.label] || '#94a3b8';
}

function nodeRadius(node: GraphNode, selected: boolean): number {
  const type = frontendType(node);
  if (selected) return 12;
  if (type === 'Component' || type === 'Class') return 8;
  if (type === 'File') return 4;
  if (type === 'Route' || type === 'Store') return 7;
  return 6;
}

function nodeText(node: GraphNode): string {
  return [node.id, node.label, frontendType(node), nodeName(node), nodeFile(node), node.properties?.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      message = body.error || message;
    } catch {
      // Keep the HTTP status text.
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

function appendStreamLine(graph: KnowledgeGraph, line: string): void {
  if (!line.trim()) return;
  const event = JSON.parse(line) as StreamEvent;
  if (event.type === 'error') throw new Error(event.error || 'Graph stream failed');
  if (event.type === 'node') graph.nodes.push(event.data);
  if (event.type === 'relationship') graph.relationships.push(event.data);
}

async function readGraphResponse(res: Response, onProgress: (graph: KnowledgeGraph) => void): Promise<KnowledgeGraph> {
  if (!res.ok) throw new Error(`Server returned ${res.status}: ${res.statusText}`);
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/x-ndjson')) return res.json() as Promise<KnowledgeGraph>;
  if (!res.body) throw new Error('Graph stream response has no body');

  const graph: KnowledgeGraph = { nodes: [], relationships: [] };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastProgress = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) appendStreamLine(graph, line);
    if (performance.now() - lastProgress > 160) {
      onProgress(graph);
      lastProgress = performance.now();
    }
  }
  if (buffer.trim()) appendStreamLine(graph, buffer);
  return graph;
}

function seededPosition(id: string): Vec2 {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const angle = (hash % 6283) / 1000;
  const radius = 120 + (hash % 260);
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function createLayout(graph: KnowledgeGraph): Map<string, LayoutNode> {
  const map = new Map<string, LayoutNode>();
  for (const node of graph.nodes) {
    const p = seededPosition(node.id);
    map.set(node.id, { id: node.id, x: p.x, y: p.y, vx: 0, vy: 0 });
  }
  return map;
}

function tickLayout(graph: KnowledgeGraph, layout: Map<string, LayoutNode>, visible: Set<string>): void {
  const nodes = graph.nodes.filter((node) => visible.has(node.id));
  const rels = graph.relationships.filter((edge) => visible.has(edge.sourceId) && visible.has(edge.targetId));

  for (let i = 0; i < nodes.length; i += 1) {
    const a = layout.get(nodes[i].id);
    if (!a) continue;
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = layout.get(nodes[j].id);
      if (!b) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const distance = Math.max(36, Math.hypot(dx, dy));
      const force = 380 / (distance * distance);
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  for (const edge of rels) {
    const source = layout.get(edge.sourceId);
    const target = layout.get(edge.targetId);
    if (!source || !target) continue;
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const ideal = STRUCTURE_EDGES.has(edge.type) ? 110 : 170;
    const strength = IMPORTANT_EDGES.has(edge.type) ? 0.018 : 0.01;
    const force = (distance - ideal) * strength;
    const fx = (dx / distance) * force;
    const fy = (dy / distance) * force;
    source.vx += fx;
    source.vy += fy;
    target.vx -= fx;
    target.vy -= fy;
  }

  for (const node of nodes) {
    const item = layout.get(node.id);
    if (!item) continue;
    item.vx += -item.x * 0.0009;
    item.vy += -item.y * 0.0009;
    item.vx *= 0.82;
    item.vy *= 0.82;
    item.x += item.vx;
    item.y += item.vy;
  }
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const [serverInput, setServerInput] = useState(initialServerUrl);
  const [serverUrl, setServerUrl] = useState('');
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [repo, setRepo] = useState('');
  const [graph, setGraph] = useState<KnowledgeGraph>({ nodes: [], relationships: [] });
  const [layout, setLayout] = useState<Map<string, LayoutNode>>(new Map());
  const [selectedId, setSelectedId] = useState('');
  const [hoveredId, setHoveredId] = useState('');
  const [query, setQuery] = useState('');
  const [edgeType, setEdgeType] = useState('all');
  const [nodeTypes, setNodeTypes] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('Enter a VueNexus server URL to begin.');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [layoutRunning, setLayoutRunning] = useState(true);
  const [pan, setPan] = useState<Vec2>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);

  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const selectedNode = selectedId ? nodeById.get(selectedId) : undefined;
  const hoveredNode = hoveredId ? nodeById.get(hoveredId) : undefined;

  const edgeTypes = useMemo(() => {
    return Array.from(new Set(graph.relationships.map((edge) => edge.type))).sort();
  }, [graph.relationships]);

  const allNodeTypes = useMemo(() => {
    return Array.from(new Set(graph.nodes.map(frontendType))).sort();
  }, [graph.nodes]);

  useEffect(() => {
    setNodeTypes(new Set(allNodeTypes));
  }, [allNodeTypes]);

  const visibleNodes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const ids = new Set<string>();
    for (const node of graph.nodes) {
      if (!nodeTypes.has(frontendType(node))) continue;
      if (needle && !nodeText(node).includes(needle)) continue;
      ids.add(node.id);
    }
    return ids;
  }, [graph.nodes, nodeTypes, query]);

  const visibleEdges = useMemo(() => {
    return graph.relationships.filter((edge) => {
      if (edgeType !== 'all' && edge.type !== edgeType) return false;
      return visibleNodes.has(edge.sourceId) && visibleNodes.has(edge.targetId);
    });
  }, [edgeType, graph.relationships, visibleNodes]);

  const stats = useMemo(() => {
    const files = graph.nodes.filter((node) => frontendType(node) === 'File').length;
    const components = graph.nodes.filter((node) => frontendType(node) === 'Component' || node.label === 'Class').length;
    const unresolved = graph.nodes.filter((node) => node.label === 'UnresolvedReference').length;
    const important = graph.relationships.filter((edge) => IMPORTANT_EDGES.has(edge.type)).length;
    return { files, components, unresolved, important };
  }, [graph]);

  const adjacent = useMemo(() => {
    if (!selectedNode) return { incoming: [] as GraphRelationship[], outgoing: [] as GraphRelationship[] };
    return {
      incoming: graph.relationships.filter((edge) => edge.targetId === selectedNode.id),
      outgoing: graph.relationships.filter((edge) => edge.sourceId === selectedNode.id),
    };
  }, [graph.relationships, selectedNode]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return graph.nodes.filter((node) => visibleNodes.has(node.id)).slice(0, 30);
    return graph.nodes.filter((node) => visibleNodes.has(node.id) && nodeText(node).includes(needle)).slice(0, 60);
  }, [graph.nodes, query, visibleNodes]);

  const fitGraph = useCallback(() => {
    const canvas = canvasRef.current;
    const nodes = Array.from(layout.values()).filter((node) => visibleNodes.has(node.id));
    if (!canvas || !nodes.length) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x);
      maxY = Math.max(maxY, node.y);
    }
    const width = Math.max(300, maxX - minX);
    const height = Math.max(240, maxY - minY);
    const nextZoom = Math.min(1.8, Math.max(0.25, Math.min(canvas.clientWidth / width, canvas.clientHeight / height) * 0.72));
    setZoom(nextZoom);
    setPan({ x: -((minX + maxX) / 2) * nextZoom, y: -((minY + maxY) / 2) * nextZoom });
  }, [layout, visibleNodes]);

  const connect = useCallback(async () => {
    const nextServer = normalizeServerUrl(serverInput);
    setLoading(true);
    setError('');
    setStatus(`Connecting to ${nextServer}...`);
    try {
      const nextRepos = await fetchJson<RepoInfo[]>(`${nextServer}/api/repos`);
      setServerUrl(nextServer);
      setServerInput(nextServer);
      localStorage.setItem('vuenexus-web.server', nextServer);
      setRepos(nextRepos);
      const preferred = new URLSearchParams(window.location.search).get('repo') || localStorage.getItem('vuenexus-web.repo');
      const nextRepo = nextRepos.find((item) => item.name === preferred)?.name || nextRepos[0]?.name || '';
      setRepo(nextRepo);
      setStatus(nextRepo ? `Connected. Loading ${nextRepo}...` : 'Connected, but no analyzed repositories were found.');
      if (nextRepo) {
        const res = await fetch(`${nextServer}/api/graph?repo=${encodeURIComponent(nextRepo)}&stream=true`);
        const nextGraph = await readGraphResponse(res, (partial) => {
          setStatus(`Streaming graph: ${partial.nodes.length} nodes, ${partial.relationships.length} edges`);
        });
        setGraph(nextGraph);
        setLayout(createLayout(nextGraph));
        setSelectedId('');
        localStorage.setItem('vuenexus-web.repo', nextRepo);
        setStatus(`Ready: ${nextGraph.nodes.length} nodes, ${nextGraph.relationships.length} edges`);
      } else {
        setGraph({ nodes: [], relationships: [] });
        setLayout(new Map());
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setStatus('Connection failed.');
    } finally {
      setLoading(false);
    }
  }, [serverInput]);

  const loadRepo = useCallback(
    async (nextRepo: string) => {
      if (!serverUrl || !nextRepo) return;
      setLoading(true);
      setError('');
      setRepo(nextRepo);
      setStatus(`Loading ${nextRepo}...`);
      try {
        const res = await fetch(`${serverUrl}/api/graph?repo=${encodeURIComponent(nextRepo)}&stream=true`);
        const nextGraph = await readGraphResponse(res, (partial) => {
          setStatus(`Streaming graph: ${partial.nodes.length} nodes, ${partial.relationships.length} edges`);
        });
        setGraph(nextGraph);
        setLayout(createLayout(nextGraph));
        setSelectedId('');
        localStorage.setItem('vuenexus-web.repo', nextRepo);
        setStatus(`Ready: ${nextGraph.nodes.length} nodes, ${nextGraph.relationships.length} edges`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setStatus('Graph load failed.');
      } finally {
        setLoading(false);
      }
    },
    [serverUrl],
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('server')) void connect();
  }, [connect]);

  useEffect(() => {
    if (!layoutRunning || !graph.nodes.length) return;
    const run = () => {
      setLayout((current) => {
        const next = new Map(current);
        for (let i = 0; i < 2; i += 1) tickLayout(graph, next, visibleNodes);
        return next;
      });
      animationRef.current = requestAnimationFrame(run);
    };
    animationRef.current = requestAnimationFrame(run);
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [graph, layoutRunning, visibleNodes]);

  const screenToWorld = useCallback(
    (x: number, y: number): Vec2 => {
      const canvas = canvasRef.current;
      const rect = canvas?.getBoundingClientRect();
      const width = rect?.width || 1;
      const height = rect?.height || 1;
      return { x: (x - width / 2 - pan.x) / zoom, y: (y - height / 2 - pan.y) / zoom };
    },
    [pan, zoom],
  );

  const pickNode = useCallback(
    (clientX: number, clientY: number): string => {
      const world = screenToWorld(clientX, clientY);
      let best = '';
      let bestDistance = Infinity;
      for (const node of graph.nodes) {
        if (!visibleNodes.has(node.id)) continue;
        const p = layout.get(node.id);
        if (!p) continue;
        const distance = Math.hypot(world.x - p.x, world.y - p.y);
        if (distance < Math.max(12, nodeRadius(node, false) + 8) / zoom && distance < bestDistance) {
          best = node.id;
          bestDistance = distance;
        }
      }
      return best;
    },
    [graph.nodes, layout, screenToWorld, visibleNodes, zoom],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.floor(rect.width * ratio);
      canvas.height = Math.floor(rect.height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resize();

    const render = () => {
      const rect = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);
      const gradient = ctx.createRadialGradient(rect.width / 2, rect.height / 2, 30, rect.width / 2, rect.height / 2, rect.width * 0.72);
      gradient.addColorStop(0, 'rgba(67, 213, 158, 0.06)');
      gradient.addColorStop(0.55, 'rgba(94, 160, 255, 0.035)');
      gradient.addColorStop(1, 'rgba(6, 6, 10, 0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, rect.width, rect.height);

      ctx.save();
      ctx.translate(rect.width / 2 + pan.x, rect.height / 2 + pan.y);
      ctx.scale(zoom, zoom);

      for (const edge of visibleEdges) {
        const source = layout.get(edge.sourceId);
        const target = layout.get(edge.targetId);
        if (!source || !target) continue;
        const important = IMPORTANT_EDGES.has(edge.type);
        const selected = selectedId && (edge.sourceId === selectedId || edge.targetId === selectedId);
        ctx.beginPath();
        ctx.moveTo(source.x, source.y);
        const mx = (source.x + target.x) / 2;
        const my = (source.y + target.y) / 2;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const length = Math.max(1, Math.hypot(dx, dy));
        const curve = important ? 18 : 8;
        ctx.quadraticCurveTo(mx - (dy / length) * curve, my + (dx / length) * curve, target.x, target.y);
        ctx.strokeStyle = selected ? 'rgba(67, 213, 158, 0.8)' : important ? 'rgba(94, 160, 255, 0.38)' : 'rgba(148, 163, 184, 0.16)';
        ctx.lineWidth = (selected ? 2.3 : important ? 1.3 : 0.8) / zoom;
        ctx.stroke();
      }

      for (const node of graph.nodes) {
        if (!visibleNodes.has(node.id)) continue;
        const p = layout.get(node.id);
        if (!p) continue;
        const selected = node.id === selectedId;
        const hovered = node.id === hoveredId;
        const radius = nodeRadius(node, selected || hovered);
        const color = nodeColor(node);
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = selected ? 22 : hovered ? 14 : 6;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.lineWidth = selected ? 2.2 / zoom : 1.2 / zoom;
        ctx.strokeStyle = selected ? '#ffffff' : 'rgba(255,255,255,0.42)';
        ctx.stroke();

        if (selected || hovered || zoom > 0.62) {
          ctx.font = `${Math.max(9, 11 / zoom)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
          ctx.fillStyle = selected ? '#ffffff' : 'rgba(228, 228, 237, 0.78)';
          ctx.fillText(nodeName(node).slice(0, 38), p.x + radius + 5 / zoom, p.y + 4 / zoom);
        }
      }

      ctx.restore();
    };

    render();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [graph.nodes, hoveredId, layout, pan, selectedId, visibleEdges, visibleNodes, zoom]);

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const id = pickNode(event.clientX, event.clientY);
    if (id) {
      dragRef.current = { mode: 'node', nodeId: id };
      setSelectedId(id);
    } else {
      dragRef.current = { mode: 'pan', x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag?.mode === 'pan') {
      setPan({ x: drag.panX + event.clientX - drag.x, y: drag.panY + event.clientY - drag.y });
      return;
    }
    if (drag?.mode === 'node') {
      const world = screenToWorld(event.clientX, event.clientY);
      setLayout((current) => {
        const next = new Map(current);
        const item = next.get(drag.nodeId);
        if (item) {
          next.set(drag.nodeId, { ...item, x: world.x, y: world.y, vx: 0, vy: 0 });
        }
        return next;
      });
      return;
    }
    setHoveredId(pickNode(event.clientX, event.clientY));
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    setZoom((value) => Math.min(3, Math.max(0.15, value * factor)));
  };

  const focusNode = (id: string) => {
    const item = layout.get(id);
    if (!item) return;
    setSelectedId(id);
    setPan({ x: -item.x * zoom, y: -item.y * zoom });
  };

  const toggleNodeType = (type: string) => {
    setNodeTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Network size={21} /></div>
          <div>
            <strong>VueNexus Web</strong>
            <span>Frontend graph explorer</span>
          </div>
        </div>
        <form
          className="server-form"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <Server size={16} />
          <input value={serverInput} onChange={(event) => setServerInput(event.target.value)} placeholder="http://127.0.0.1:3000" />
          <button type="submit" disabled={loading}>
            {loading ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
            Connect
          </button>
        </form>
      </header>

      <section className="summary-strip">
        <Metric icon={<CircleDot size={17} />} label="Nodes" value={graph.nodes.length} />
        <Metric icon={<GitBranch size={17} />} label="Edges" value={graph.relationships.length} />
        <Metric icon={<FileCode2 size={17} />} label="Files" value={stats.files} />
        <Metric icon={<Component size={17} />} label="Components" value={stats.components} />
        <Metric icon={<Workflow size={17} />} label="Core Flow" value={stats.important} />
        <Metric icon={<AlertTriangle size={17} />} label="Unresolved" value={stats.unresolved} tone={stats.unresolved ? 'warn' : 'ok'} />
      </section>

      <main className="workspace">
        <aside className="left-panel scrollbar">
          <PanelTitle icon={<Globe2 size={16} />} title="Server Repos" />
          <select value={repo} onChange={(event) => void loadRepo(event.target.value)} disabled={!repos.length || loading}>
            {repos.length ? repos.map((item) => <option key={item.name} value={item.name}>{item.name}</option>) : <option>No repos</option>}
          </select>
          <div className="repo-card">
            <strong>{repo || 'No repository loaded'}</strong>
            <span>{repos.find((item) => item.name === repo)?.path || 'Run vuenexus analyze, then vuenexus serve.'}</span>
          </div>

          <PanelTitle icon={<Filter size={16} />} title="Node Types" />
          <div className="type-list">
            {allNodeTypes.map((type) => (
              <button key={type} className={nodeTypes.has(type) ? 'type active' : 'type'} onClick={() => toggleNodeType(type)} type="button">
                <span style={{ background: NODE_COLORS[type] || '#94a3b8' }} />
                {type}
              </button>
            ))}
          </div>

          <PanelTitle icon={<Search size={16} />} title="Matches" />
          <div className="matches">
            {matches.map((node) => (
              <button key={node.id} type="button" className={node.id === selectedId ? 'match active' : 'match'} onClick={() => focusNode(node.id)}>
                <span className="match-dot" style={{ background: nodeColor(node) }} />
                <span>
                  <strong>{nodeName(node)}</strong>
                  <small>{frontendType(node)} · {nodeFile(node) || node.id}</small>
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className="graph-stage" ref={wrapRef}>
          <div className="graph-toolbar">
            <div className="search-box">
              <Search size={16} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search symbols, files, components..." />
            </div>
            <select value={edgeType} onChange={(event) => setEdgeType(event.target.value)}>
              <option value="all">All edges</option>
              {edgeTypes.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
            <button type="button" onClick={() => setLayoutRunning((value) => !value)}>
              {layoutRunning ? <Activity size={16} /> : <Zap size={16} />}
              {layoutRunning ? 'Live' : 'Paused'}
            </button>
            <button type="button" onClick={fitGraph}><Focus size={16} />Fit</button>
            <button type="button" onClick={() => repo && void loadRepo(repo)} disabled={!repo || loading}><RefreshCcw size={16} />Reload</button>
          </div>
          <canvas
            ref={canvasRef}
            className="graph-canvas"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={() => setHoveredId('')}
            onWheel={handleWheel}
          />
          <div className="status-pill">
            {loading && <Loader2 className="spin" size={15} />}
            <span>{status}</span>
          </div>
          {error && <div className="error-banner"><AlertTriangle size={15} />{error}</div>}
          {hoveredNode && !selectedNode && (
            <div className="hover-label">{nodeName(hoveredNode)} <span>{frontendType(hoveredNode)}</span></div>
          )}
        </section>

        <aside className="right-panel scrollbar">
          <PanelTitle icon={<Layers3 size={16} />} title="Inspector" />
          {selectedNode ? (
            <>
              <div className="node-card">
                <div className="node-icon" style={{ background: nodeColor(selectedNode) }} />
                <div>
                  <strong>{nodeName(selectedNode)}</strong>
                  <span>{frontendType(selectedNode)} · {selectedNode.label}</span>
                </div>
              </div>
              <dl className="detail-grid">
                <dt>File</dt>
                <dd>{nodeFile(selectedNode) || '-'}</dd>
                <dt>Line</dt>
                <dd>{nodeLine(selectedNode) ?? '-'}</dd>
                <dt>ID</dt>
                <dd>{selectedNode.id}</dd>
              </dl>

              <RelationList title="Outgoing" edges={adjacent.outgoing} nodeById={nodeById} onFocus={focusNode} />
              <RelationList title="Incoming" edges={adjacent.incoming} nodeById={nodeById} onFocus={focusNode} incoming />
            </>
          ) : (
            <div className="empty-state">
              <Boxes size={32} />
              <strong>Select a node</strong>
              <span>Click any node to inspect file, line, and incoming/outgoing graph relations.</span>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}

function Metric({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone?: 'warn' | 'ok' }) {
  return (
    <div className={`metric ${tone || ''}`}>
      {icon}
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}

function PanelTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="panel-title">
      {icon}
      <span>{title}</span>
    </div>
  );
}

function RelationList({
  title,
  edges,
  nodeById,
  onFocus,
  incoming = false,
}: {
  title: string;
  edges: GraphRelationship[];
  nodeById: Map<string, GraphNode>;
  onFocus: (id: string) => void;
  incoming?: boolean;
}) {
  return (
    <div className="relation-section">
      <h3>{title} <span>{edges.length}</span></h3>
      {edges.slice(0, 80).map((edge, index) => {
        const otherId = incoming ? edge.sourceId : edge.targetId;
        const other = nodeById.get(otherId);
        return (
          <button key={`${edge.sourceId}-${edge.targetId}-${edge.type}-${index}`} type="button" onClick={() => onFocus(otherId)} className="relation">
            <span className="edge-type">{edge.type}</span>
            <ChevronRight size={14} />
            <strong>{nodeName(other) || otherId}</strong>
            <small>{other ? `${frontendType(other)} · ${nodeFile(other) || other.id}` : otherId}</small>
          </button>
        );
      })}
      {!edges.length && <p className="muted">No relations.</p>}
    </div>
  );
}
