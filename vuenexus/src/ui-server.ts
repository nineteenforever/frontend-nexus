// @ts-nocheck
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultUiDirCandidates = [
  process.env.VUENEXUS_WEB_DIR,
  path.join(packageRoot, '..', 'vuenexus-web', 'dist'),
  path.join(packageRoot, 'web'),
  path.join(packageRoot, 'ui', 'dist'),
].filter(Boolean);

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.ico', 'image/x-icon'],
]);

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    ...headers,
  });
  res.end(body);
}

function contentType(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

async function readStaticFile(uiDir, requestPath) {
  const normalizedPath = decodeURIComponent(requestPath.split('?')[0] || '/');
  const relativePath = normalizedPath === '/' ? 'index.html' : normalizedPath.replace(/^\/+/, '');
  const fullPath = path.resolve(uiDir, relativePath);
  const relative = path.relative(path.resolve(uiDir), fullPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { status: 403, body: 'Forbidden', filePath: 'text/plain' };
  }
  try {
    return {
      status: 200,
      body: await fs.readFile(fullPath),
      filePath: fullPath,
    };
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    return {
      status: 200,
      body: await fs.readFile(path.join(uiDir, 'index.html')),
      filePath: path.join(uiDir, 'index.html'),
    };
  }
}

async function resolveUiDir(uiDir) {
  const candidates = uiDir ? [uiDir] : defaultUiDirCandidates;
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    try {
      await fs.access(path.join(resolved, 'index.html'));
      return resolved;
    } catch {
      // Keep trying the next known layout.
    }
  }
  throw new Error(
    `VueNexus Web build not found. Run "npm run build" in vuenexus-web, then pass --ui-dir ../vuenexus-web/dist or set VUENEXUS_WEB_DIR. Tried: ${candidates.map((candidate) => path.resolve(candidate)).join(', ')}`
  );
}

export async function serveVueNexusUi({
  port = 5173,
  host = '127.0.0.1',
  server = 'http://127.0.0.1:3000',
  uiDir,
} = {}) {
  const resolvedUiDir = await resolveUiDir(uiDir);
  const httpServer = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'GET,OPTIONS',
        });
        res.end();
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      const file = await readStaticFile(resolvedUiDir, req.url ?? '/');
      send(res, file.status, req.method === 'HEAD' ? '' : file.body, {
        'Content-Type': contentType(file.filePath),
        'Cache-Control': file.filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
      });
    } catch (err) {
      send(res, 500, err instanceof Error ? err.message : String(err), {
        'Content-Type': 'text/plain; charset=utf-8',
      });
    }
  });

  await new Promise((resolve) => httpServer.listen(port, host, resolve));
  const url = `http://${host}:${port}/?server=${encodeURIComponent(server)}`;
  process.stdout.write(`VueNexus UI listening at http://${host}:${port}\n`);
  process.stdout.write(`Open ${url}\n`);
  return httpServer;
}
