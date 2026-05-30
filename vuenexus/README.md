# VueNexus

VueNexus is a Vue-focused graph analyzer for codebase tools and agents.

The npm package name, public command, MCP tool names, storage paths, and registry use the `vuenexus` identity:

- CLI command: `vuenexus`
- MCP tools: `vuenexus_*`
- local storage: `.vuenexus/lbug`
- metadata: `.vuenexus/meta.json`
- global registry: `~/.vuenexus/registry.json`
- web API: `vuenexus serve`, shaped so the existing GitNexus repo's `gitnexus-web` can browse it

This package does not try to support backend languages. It keeps the scanner small and specialized so Vue/TypeScript frontend graphs can be more precise.

## Install

VueNexus requires Node.js 20.17 or newer. Node 22 LTS is recommended for internal installs because the local embedding runtime depends on platform-specific ONNX packages.

```bash
npm install -g vuenexus
vuenexus analyze --root /path/to/vue-project --embedding
vuenexus serve --port 4747
```

For local development inside this repo:

```bash
npm install
npm run build
npm run check
npm test
npm pack
npm uninstall -g vuenexus
npm install -g ./vuenexus-0.1.7.tgz
```

VueNexus is implemented in TypeScript and publishes compiled JavaScript from `dist`.

## Supported Vue Projects

VueNexus is designed for Vue frontend repositories that use:

- Vue 2 Options API projects
- Vue 3 Composition API and `<script setup>` projects
- `.vue`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, and `.cjs` source files
- TypeScript, JavaScript, TSX, and JSX scripts inside Vue SFCs
- Pinia and Vuex store patterns
- Vue Router route objects and lazy component imports

## Analyze Pipeline

`vuenexus analyze` is the core command. The current flow is:

1. Walk frontend source files under the project root.
   - includes `.vue`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`
   - ignores `.git`, `node_modules`, `dist`, `build`, `.nuxt`, `.output`, `coverage`, `.vuenexus`

2. Create one `File` node for every scanned source file.

3. Parse Vue SFC files with the official Vue compiler.
   - `@vue/compiler-sfc` parses `.vue`
   - every `.vue` file becomes a `Component` node
   - `<script>` and `<script setup>` are extracted into a virtual `.vue.ts` file
   - source lines are mapped back from virtual script lines to real `.vue` lines

4. Parse Vue templates with `@vue/compiler-dom`.
   - component tags such as `<UserCard>` or `<user-card>` become `RENDERS` edges
   - directive and interpolation expressions become `HANDLES` edges back to script symbols
   - examples: `@click="save"`, `v-if="visible"`, `:items="items"`, `{{ title }}`

5. Build a TypeScript program over real files plus virtual Vue script files.
   - uses the TypeScript compiler API and checker
   - resolves imports, symbols, calls, methods, constructors, class methods, object methods, and variable function declarations
   - `.vue` imports are resolved to their virtual script files while graph nodes still point to the real `.vue` file

6. Collect declaration nodes.
   - functions and arrow-function variables
   - composables named like `useXxx`
   - Pinia stores from `defineStore` or store files
   - routers from `createRouter`
   - classes, interfaces, methods
   - class property methods such as `private submit = () => {}`
   - variables and destructured variables

7. Collect graph edges.
   - `DEFINES`: file contains a declaration
   - `IMPORTS`: static and dynamic imports, including external packages and local assets
   - `CALLS`: TypeScript-resolved function/method/constructor calls
   - `RENDERS`: Vue template component usage
   - `HANDLES`: Vue template expressions referencing script symbols
   - `ROUTES_TO`: Vue Router route objects pointing to components
   - `USES_STORE`: Pinia store usage and store action calls
   - `MIXES_IN`: Vue 2 `mixins` and `extends`
   - `HAS_UNRESOLVED`: an owner/file has an actionable unresolved relation

8. Apply Vue/frontend-specific precision rules.
   - `this.foo()` prefers real same-class/same-file method nodes over class nodes
   - `store.action()` links to the Pinia store action method when the store variable is known
   - Vuex `mapState`, `mapGetters`, `mapActions`, `mapMutations`, `dispatch`, and `commit` are resolved when the store module can be identified
   - Vue 2 Options API props, data, computed, methods, inline components, mixins, and component names are indexed
   - `tsconfig`/`jsconfig`, common Vite/Webpack aliases, package self-imports, `src` directory aliases, barrel re-exports, and Vue component casing are resolved before a relation is marked unresolved
   - route objects are recognized only in route-like contexts, not every object with a `path`
   - type-only/interface callback signatures are filtered out from `CALLS`
   - variable initializer calls also get an edge from the variable node, useful for computed/composable chains
   - third-party packages become `ExternalModule` nodes instead of `UnresolvedReference`

9. Write the graph to LadybugDB.
   - graph database: `.vuenexus/lbug`
   - metadata: `.vuenexus/meta.json`
   - registry entry: `~/.vuenexus/registry.json`

10. Return analysis stats and diagnostics.
    - diagnostics include TypeScript diagnostics, Vue parse diagnostics, and safe fallback warnings
    - diagnostics help reveal unresolved library/shim gaps or TypeScript checker fallback points
    - diagnostics do not automatically mean the graph failed
    - if TypeScript semantic resolution overflows on complex project types, analyze falls back to AST/local resolution and records a diagnostic instead of aborting

## Storage Format

The storage format is VueNexus-native while preserving the LadybugDB graph shape consumed by the existing web UI.

Project-local files:

```text
<project>/.vuenexus/lbug
<project>/.vuenexus/meta.json
```

Global registry:

```text
~/.vuenexus/registry.json
```

LadybugDB node labels use the existing web graph schema where possible:

| Frontend concept | Stored label |
| --- | --- |
| `File` | `File` |
| `Component` | `Class` |
| `Composable` | `Function` |
| `Store` | `Class` |
| `Router` | `CodeElement` |
| `Route` | `Route` |
| `ExternalModule` | `ExternalModule` |
| `UnresolvedReference` | `UnresolvedReference` |
| `Function` | `Function` |
| `Method` | `Method` |
| `Class` | `Class` |
| `Interface` | `Interface` |
| `Variable` | `Variable` |

Frontend-specific node type information is preserved in the `description` JSON as `frontendType`.

`UnresolvedReference` is reserved for actionable graph gaps after local resolvers have been tried. It should not contain ordinary third-party imports.

Relationships are stored in `CodeRelation`:

```text
source -[:CodeRelation {
  type,
  confidence,
  reason,
  step
}]-> target
```

`step` is the source line number where the relation was found.

## CLI

Analyze and serve:

```bash
vuenexus analyze --root /path/to/vue-project --name my-vue-app --embedding
vuenexus analyze --root /path/to/vue-project --embedding --provider local --model /models/bge-small-zh-v1.5
vuenexus analyze --root /path/to/vue-project
vuenexus analyze --root /path/to/vue-project -f
vuenexus analyze --root /path/to/vue-project --checker full
vuenexus analyze --root /path/to/vue-project --diagnostics
vuenexus analyze --root /path/to/vue-project --json
vuenexus analyze --root /path/to/vue-project --quiet
vuenexus serve --port 4747
vuenexus ui --server http://127.0.0.1:4747 --ui-dir /path/to/frontend-nexus/vuenexus-web/dist
```

By default, `analyze` writes lightweight stage progress to stderr and the final JSON result to stdout. The progress
messages are phase-level only, not per-file, so they are useful on large projects without materially slowing analysis.
Use `--json` for machine-readable output with no progress logs, or `--quiet` to suppress progress logs.

`analyze` defaults to `--checker fast`. Fast mode avoids expensive TypeScript checker calls for every call
expression, so large Vue projects do not get stuck in deep dependency/type graphs. It still resolves Vue SFC,
import/export, local calls, Vue template edges, routes, Pinia/Vuex relations, mixins, and common same-file calls.
Use `--checker full` only when you need maximum TypeScript call-target resolution and can accept slower analysis.
Use `--checker off` for the most conservative AST/local-only run.

`analyze` uses incremental analysis by default. The cache stores a small manifest at
`.vuenexus/cache/analysis-cache.json` and per-file graph slices under `.vuenexus/cache/files/`. On the next run,
VueNexus reuses unchanged file slices and re-analyzes changed files plus files that import them. Use `-f` or
`--force` to do a full clean re-analysis and refresh the cache. Use `--no-incremental` to ignore the cache for a
single run.

`analyze` skips generated or minified JavaScript by default. The filter covers obvious vendor/bundle filenames such
as `.min.js`, `jquery*.js`, `cssWorkerMain.js`, runtime/vendor/chunk bundles, very large single-line JS files, and
any `public/` or `static/` directory found inside a monorepo package. Analyze progress prints each skipped path,
reason, and size when available. Use `--include-generated` when you intentionally want those files included in the
graph.

`analyze` skips full TypeScript semantic diagnostics by default because they can dominate runtime on large
projects and do not affect graph generation. Use `--diagnostics` when you explicitly want the TypeScript
diagnostic report alongside the graph.

Inspect the stored graph:

```bash
vuenexus stats --db /path/to/vue-project/.vuenexus/lbug
vuenexus query "getValues" --db /path/to/vue-project/.vuenexus/lbug
vuenexus context --symbol getValues --db /path/to/vue-project/.vuenexus/lbug
vuenexus graph --symbol UserCard --db /path/to/vue-project/.vuenexus/lbug
vuenexus chain --from App --depth 6 --db /path/to/vue-project/.vuenexus/lbug
vuenexus cypher "MATCH (a)-[r:CodeRelation]->(b) RETURN a.id, r.type, b.id LIMIT 20" --db /path/to/vue-project/.vuenexus/lbug
vuenexus export --db /path/to/vue-project/.vuenexus/lbug --out graph.json
vuenexus embed --db /path/to/vue-project/.vuenexus/lbug --provider local --model /models/bge-small-zh-v1.5
vuenexus semantic --db /path/to/vue-project/.vuenexus/lbug --query "用户登录表单" --limit 10
```

Run MCP:

```bash
vuenexus mcp
```

Set up opencode:

```bash
vuenexus setup
```

By default this installs:

- MCP config in `~/.config/opencode/opencode.json`
- skill file in `~/.config/opencode/skill/vuenexus/SKILL.md`

On Windows, `~` is the user profile directory, so the default paths are usually:

```text
C:\Users\<you>\.config\opencode\opencode.json
C:\Users\<you>\.config\opencode\skill\vuenexus\SKILL.md
```

The MCP entry added to opencode is:

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

`vuenexus mcp` defaults to the current workspace's `.vuenexus/lbug`, so the MCP config normally does not need
`--db`. Use `vuenexus setup --db /absolute/path/to/.vuenexus/lbug` only when your agent starts MCP servers from a
different working directory.

For a project-local opencode config:

```bash
vuenexus setup --scope project
```

## MCP Tools

The MCP server exposes VueNexus-style tool names:

- `vuenexus_query`: search indexed nodes
- `vuenexus_semantic_search`: semantic search interface
- `vuenexus_graph`: direct graph slice around a symbol or node id
- `vuenexus_context`: incoming and outgoing relations for one symbol
- `vuenexus_call_chain`: breadth-first traversal over `CALLS`, `RENDERS`, and `HANDLES`
- `vuenexus_unresolved_report`: grouped unresolved references that may hide impact
- `vuenexus_impact_radius`: reverse impact slice with unresolved blockers and a `complete`/`partial` confidence flag
- `vuenexus_cypher`: run Cypher-compatible queries against LadybugDB
- `vuenexus_stats`: node and edge totals
- `vuenexus_export`: full graph export

## GitNexus Web Compatibility

After `vuenexus analyze`, run:

```bash
vuenexus serve --port 4747
```

The server reads `~/.vuenexus/registry.json`, opens each repo's `.vuenexus/lbug`, and exposes the same HTTP endpoint shapes expected by the GitNexus repo's `gitnexus-web`:

```text
/api/repos
/api/graph?repo=<repo-name>
```

This lets the existing `gitnexus-web` app consume VueNexus results without changing the web UI.

## Browser UI

The browser UI lives in the sibling `vuenexus-web` project, not inside the npm CLI package. This keeps
`vuenexus` focused on analyze/storage/MCP/API work, while `vuenexus-web` works like `gitnexus-web`: a standalone
frontend project that connects to a running `vuenexus serve` API.

Run the UI during development:

```bash
cd /path/to/frontend-nexus/vuenexus-web
npm install
npm run dev
```

Typical local workflow:

```bash
vuenexus analyze --root /path/to/vue-project
vuenexus serve --port 3000
```

Then open:

```text
http://127.0.0.1:5173
```

Enter `http://127.0.0.1:3000` in the server input. `vuenexus serve` provides the graph API. `vuenexus-web`
provides the browser experience.

For a production static build, run `npm run build` in `vuenexus-web`. The legacy helper command can serve that
build when useful:

```bash
vuenexus ui --port 5173 --server http://127.0.0.1:3000 --ui-dir /path/to/frontend-nexus/vuenexus-web/dist
```

The UI can:

- connect to a local or remote VueNexus server
- list analyzed repos from `~/.vuenexus/registry.json`
- stream graph data from `/api/graph?stream=true`
- render nodes and edges on a canvas
- search symbols/files/components
- inspect direct relationships for a selected node

## Embeddings

Embedding does not affect graph precision.

Graph generation is entirely parser/checker based. `CALLS`, `RENDERS`, `HANDLES`, `ROUTES_TO`, and other edges are created before any vector step and do not depend on embeddings.

`--embedding` now writes vectors into the same LadybugDB store:

- embedding nodes are stored in `CodeEmbedding`
- each row keeps `nodeId`, `chunkIndex`, `startLine`, `endLine`, `embedding`, and `contentHash`
- `.vuenexus/meta.json` records embedding provider, model, vector dimensions, and embedding count
- `~/.vuenexus/registry.json` gets the updated embedding count for web/API consumers

Offline local model usage:

```bash
vuenexus analyze \
  --root /path/to/vue-project \
  --embedding \
  --provider local \
  --model /absolute/path/to/local/embedding-model
```

The local provider uses `@huggingface/transformers` and is configured for offline operation by default.
When a model is bundled into the npm package at `models/embedding`, this also works without `--model`:

```bash
vuenexus analyze --root /path/to/vue-project --embedding
vuenexus model-info
```

Model resolution order for `provider=local`:

1. `--model /absolute/model/dir`
2. `VUENEXUS_LOCAL_EMBEDDING_MODEL`
3. package-bundled `models/embedding`
4. `--model-package <npm-package>` or `VUENEXUS_LOCAL_EMBEDDING_MODEL_PACKAGE`
5. known model packages such as `@vuenexus/embedding-model`

A bundled model directory must be a Transformers.js feature-extraction model, typically:

```text
models/embedding/config.json
models/embedding/tokenizer.json
models/embedding/onnx/model_quantized.onnx
```

For an internal npm release:

```bash
# copy/export model files before publishing
mkdir -p models/embedding
# models/embedding/config.json, tokenizer.json, onnx/model_quantized.onnx, ...

npm publish --registry http://your-internal-npm/
npm install -g vuenexus --registry http://your-internal-npm/
vuenexus model-info
vuenexus analyze --root /path/to/vue-project --embedding
```

If the model is too large for the main package, publish a companion package with this `package.json` field:

```json
{
  "name": "@your-scope/vuenexus-embedding-model",
  "version": "1.0.0",
  "files": ["models"],
  "vuenexus": {
    "embeddingModelPath": "models/embedding"
  }
}
```

Then install and use it:

```bash
npm install -g vuenexus @your-scope/vuenexus-embedding-model --registry http://your-internal-npm/
vuenexus analyze --root /path/to/vue-project --embedding --model-package @your-scope/vuenexus-embedding-model
```

Environment variables:

- `VUENEXUS_LOCAL_EMBEDDING_MODEL=/absolute/path/to/local/model`
- `VUENEXUS_LOCAL_EMBEDDING_MODEL_PACKAGE=@your-scope/vuenexus-embedding-model`
- `VUENEXUS_TRANSFORMERS_CACHE=/absolute/path/to/cache`
- `VUENEXUS_ALLOW_REMOTE_MODELS=1` only if you explicitly want to allow network model loading

For internal networks, keep `VUENEXUS_ALLOW_REMOTE_MODELS` unset and pass a local model path. The local runtime must have the model files and the platform's `onnxruntime-node` binary available before running.

Other providers:

```bash
vuenexus analyze --root /path/to/vue-project --embedding --provider http --model bge --name my-vue-app
vuenexus analyze --root /path/to/vue-project --embedding --provider hash
```

`http` expects an OpenAI-compatible embedding endpoint:

- `VUENEXUS_EMBEDDING_URL`
- `VUENEXUS_EMBEDDING_MODEL`
- `VUENEXUS_EMBEDDING_API_KEY` if the endpoint requires auth

`hash` is a deterministic offline fallback for tests and smoke checks. It is not a semantic model.

So when validating graph correctness, it is safe to skip vectorization. Vector search is a retrieval feature for agents; it is not used to decide graph edges.

## Implemented Features

- Vue SFC parsing with official Vue compiler packages
- virtual `.vue.ts` script files for TypeScript checker integration
- line mapping from virtual Vue script back to real `.vue` files
- precise TypeScript symbol and call resolution
- Vue template `RENDERS` and `HANDLES` extraction
- Vue Router route-to-component edges
- Pinia store usage and store action call edges
- class method and class property method support
- composable detection
- LadybugDB graph writing
- LadybugDB `CodeEmbedding` vector writing
- local/offline embedding model support through `@huggingface/transformers`
- semantic search over stored LadybugDB embeddings
- VueNexus registry writing
- GitNexus web-compatible HTTP server
- CLI graph inspection commands
- MCP server with `vuenexus_*` tools
- frontend-specific Codex skill under `skills/vuenexus`

## Verified Projects

The scanner has been tested against local fixtures and real Vue projects:

- `vuestic-admin`
  - verified Vue component count, route edges, Pinia store action calls, and long call chains
- `vue-vben-admin/packages/@core/ui-kit`
  - 338 scanned files
  - 2842 nodes
  - 4243 edges
  - verified a long chain from Vue template event to class methods:

```text
vben-use-form.vue @keydown.enter
-> handleKeyDownEnter
-> FormApi.validateAndSubmitForm
-> FormApi.submitForm
-> FormApi.getValues
-> FormApi.handleRangeTimeValue
-> FormApi.handleMultiFields
-> local processFields
-> FormApi.processFields
```

## Current Limits

- This is Vue/frontend-only by design.
- Full monorepo analysis can still be slow on cold cache; prefer package-level roots for the first run, keep generated/static filtering enabled, then use the default incremental cache for repeated analysis.
- Template expression extraction links identifier references, but it does not execute Vue runtime behavior.
- Third-party component internals are only linked when their source exists inside the analyzed root.
- Embedding storage is available, but graph precision remains parser/checker based and independent from vector search.
