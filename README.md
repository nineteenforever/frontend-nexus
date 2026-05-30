# frontend-nexus

`frontend-nexus` contains two projects:

- `vuenexus`: CLI package, Vue analyzer, LadybugDB storage, MCP server, opencode setup, and `vuenexus serve` API.
- `vuenexus-web`: standalone Vite + React + TypeScript browser UI. Its relationship to `vuenexus` is the same as `gitnexus-web` to `gitnexus`.

Use Node.js `^20.19.0 || >=22.12.0`. Node 22 LTS is recommended.

## Quick Start In An Internal Network

Build and install the CLI from this repo:

```bash
cd vuenexus
npm install
npm run build
npm pack
npm uninstall -g vuenexus
npm install -g ./vuenexus-0.1.8.tgz
```

Configure opencode MCP and the VueNexus skill:

```bash
vuenexus setup
```

Expected opencode MCP entry:

```json
{
  "mcp": {
    "vuenexus": {
      "type": "local",
      "command": ["vuenexus", "mcp"],
      "enabled": true
    }
  }
}
```

`vuenexus setup` also installs the skill file. On Windows, opencode config and skills are usually under:

```text
C:\Users\<you>\.config\opencode\
```

## Analyze A Vue Project

In any Vue repository:

```bash
cd /path/to/vue-project
vuenexus analyze
```

`vuenexus analyze` defaults to `--checker fast`, which is the recommended mode for large Vue projects. It avoids
expensive TypeScript checker calls for every call expression and keeps the run from getting stuck in complex
dependency/type graphs, while still resolving Vue SFC, import/export, local calls, route, component, Pinia, Vuex,
and mixin relationships through AST-first analysis. Use `vuenexus analyze --checker full` only when you explicitly
want deeper TypeScript call-target resolution and can accept slower analysis.

`vuenexus analyze` also uses an incremental analysis cache by default. It stores a small manifest at
`.vuenexus/cache/analysis-cache.json` and per-file graph slices under `.vuenexus/cache/files/`, reuses unchanged
files on the next run, and re-analyzes changed files plus their import dependents. Use `vuenexus analyze -f` or
`vuenexus analyze --force` when you want a clean full re-analysis and cache refresh.

Generated or minified JavaScript files are skipped by default, including obvious vendor bundles such as
`.min.js`, `jquery*.js`, `cssWorkerMain.js`, runtime/vendor/chunk bundles, very large single-line JS files, and
any `public/` or `static/` directory found inside a monorepo package. Analyze progress prints each skipped path,
reason, and size when available. Use `vuenexus analyze --include-generated` only when you intentionally want those
files analyzed too.

Analyze results are written to:

```text
/path/to/vue-project/.vuenexus/lbug
/path/to/vue-project/.vuenexus/meta.json
~/.vuenexus/registry.json
```

If the analyzed project already has a `.gitignore`, `vuenexus analyze` automatically adds `.vuenexus/` once so
generated graph/cache files do not show up as Git changes.

Quick checks:

```bash
vuenexus stats
vuenexus query "App"
vuenexus context --symbol App
vuenexus chain --from App --depth 5
vuenexus cypher "MATCH (a)-[r:CodeRelation]->(b) RETURN a.id, r.type, b.id LIMIT 20"
```

Start opencode from the analyzed project:

```bash
opencode .
```

opencode starts the MCP command `vuenexus mcp`. Because it starts from the Vue project directory, `vuenexus mcp` automatically reads `./.vuenexus/lbug`. You normally do not need `--db`.

## Analyze With Embeddings

Embeddings are optional. They do not affect graph precision: nodes and edges are generated first from Vue/TypeScript parsing, then vectors are written into the same `.vuenexus/lbug` store.

For internal networks, use a local model directory or an internal model package. Do not rely on network model downloads.

Use an explicit local model directory:

```bash
cd /path/to/vue-project
vuenexus analyze --embedding --provider local --model /absolute/path/to/local/embedding-model
```

The local model should be a Transformers.js feature-extraction model, usually shaped like:

```text
/absolute/path/to/local/embedding-model/config.json
/absolute/path/to/local/embedding-model/tokenizer.json
/absolute/path/to/local/embedding-model/onnx/model_quantized.onnx
```

If the model is bundled inside the installed `vuenexus` package at `models/embedding`, this is enough:

```bash
vuenexus analyze --embedding
vuenexus model-info
```

If the model is published as a separate internal npm package:

```bash
npm install -g vuenexus @your-scope/vuenexus-embedding-model --registry http://your-internal-npm/
vuenexus analyze --embedding --model-package @your-scope/vuenexus-embedding-model
```

You can also vectorize an existing graph after a normal analyze:

```bash
vuenexus analyze
vuenexus embed --provider local --model /absolute/path/to/local/embedding-model
```

Then test semantic search:

```bash
vuenexus semantic --query "用户登录表单" --limit 10
```

For smoke tests only, use deterministic hash vectors:

```bash
vuenexus analyze --embedding --provider hash
vuenexus semantic --query "anything" --provider hash
```

`hash` is not semantic search quality; it only proves the embedding storage/query path works.

## Browser Graph UI

Start the API server:

```bash
vuenexus serve --port 3000
```

Start the Web UI from this repository:

```bash
cd /path/to/frontend-nexus/vuenexus-web
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:5173
```

Enter this VueNexus server URL:

```text
http://127.0.0.1:3000
```

`vuenexus serve` reads `~/.vuenexus/registry.json`, so the UI can list multiple projects that have been analyzed.

## Evaluate Whether VueNexus Works Well

Use [EVALUATION_GUIDE.md](./EVALUATION_GUIDE.md) when you want opencode or another agent to compare source code with analyze results. It is an evaluation protocol, not an installed skill.

## Project Layout

```text
frontend-nexus/
  vuenexus/        CLI package, analyzer, MCP, storage, serve API
  vuenexus-web/    browser UI project
  other/           miscellaneous research notes and old error logs
```
