# Frontend Nexus

Vue-only GitNexus replacement for frontend projects.

The npm package name is `frontend-nexus`, but the public command, MCP tool names, graph vocabulary, storage paths, and web API intentionally stay compatible with GitNexus:

- CLI command: `gitnexus`
- MCP tools: `gitnexus_*`
- local storage: `.gitnexus/lbug`
- metadata: `.gitnexus/meta.json`
- global registry: `~/.gitnexus/registry.json`
- web API: `gitnexus serve`, consumable by GitNexus web

This package does not try to support backend languages. It keeps the scanner small and specialized so Vue/TypeScript frontend graphs can be more precise.

## Install

```bash
npm install -g frontend-nexus
gitnexus analyze --root /path/to/vue-project --embedding
gitnexus serve --port 4747
```

For local development inside this repo:

```bash
npm install
npm run check
npm test
node src/cli.js analyze --root /path/to/vue-project --name my-vue-app --embedding
```

## Analyze Pipeline

`gitnexus analyze` is the core command. The current flow is:

1. Walk frontend source files under the project root.
   - includes `.vue`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`
   - ignores `.git`, `node_modules`, `dist`, `build`, `.nuxt`, `.output`, `coverage`, `.gitnexus`

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
   - `IMPORTS`: static and dynamic imports
   - `CALLS`: TypeScript-resolved function/method/constructor calls
   - `RENDERS`: Vue template component usage
   - `HANDLES`: Vue template expressions referencing script symbols
   - `ROUTES_TO`: Vue Router route objects pointing to components
   - `USES_STORE`: Pinia store usage and store action calls

8. Apply Vue/frontend-specific precision rules.
   - `this.foo()` prefers real same-class/same-file method nodes over class nodes
   - `store.action()` links to the Pinia store action method when the store variable is known
   - route objects are recognized only in route-like contexts, not every object with a `path`
   - type-only/interface callback signatures are filtered out from `CALLS`
   - variable initializer calls also get an edge from the variable node, useful for computed/composable chains

9. Write the graph to LadybugDB.
   - graph database: `.gitnexus/lbug`
   - metadata: `.gitnexus/meta.json`
   - registry entry: `~/.gitnexus/registry.json`

10. Return analysis stats and diagnostics.
    - diagnostics are TypeScript diagnostics; they help reveal unresolved library/shim gaps
    - diagnostics do not automatically mean the graph failed

## Storage Format

The storage format is intentionally GitNexus-compatible.

Project-local files:

```text
<project>/.gitnexus/lbug
<project>/.gitnexus/meta.json
```

Global registry:

```text
~/.gitnexus/registry.json
```

LadybugDB node labels use the existing GitNexus schema where possible:

| Frontend concept | Stored label |
| --- | --- |
| `File` | `File` |
| `Component` | `Class` |
| `Composable` | `Function` |
| `Store` | `Class` |
| `Router` | `CodeElement` |
| `Route` | `Route` |
| `Function` | `Function` |
| `Method` | `Method` |
| `Class` | `Class` |
| `Interface` | `Interface` |
| `Variable` | `Variable` |

Frontend-specific node type information is preserved in the `description` JSON as `frontendType`.

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
gitnexus analyze --root /path/to/vue-project --name my-vue-app --embedding
gitnexus analyze --root /path/to/vue-project --embedding --provider local --model /models/bge-small-zh-v1.5
gitnexus serve --port 4747
```

Inspect the stored graph:

```bash
gitnexus stats --db /path/to/vue-project/.gitnexus/lbug
gitnexus query "getValues" --db /path/to/vue-project/.gitnexus/lbug
gitnexus context --symbol getValues --db /path/to/vue-project/.gitnexus/lbug
gitnexus graph --symbol UserCard --db /path/to/vue-project/.gitnexus/lbug
gitnexus chain --from App --depth 6 --db /path/to/vue-project/.gitnexus/lbug
gitnexus cypher "MATCH (a)-[r:CodeRelation]->(b) RETURN a.id, r.type, b.id LIMIT 20" --db /path/to/vue-project/.gitnexus/lbug
gitnexus export --db /path/to/vue-project/.gitnexus/lbug --out graph.json
gitnexus embed --db /path/to/vue-project/.gitnexus/lbug --provider local --model /models/bge-small-zh-v1.5
gitnexus semantic --db /path/to/vue-project/.gitnexus/lbug --query "用户登录表单" --limit 10
```

Run MCP:

```bash
gitnexus mcp --db /path/to/vue-project/.gitnexus/lbug
```

## MCP Tools

The MCP server exposes GitNexus-style tool names:

- `gitnexus_query`: search indexed nodes
- `gitnexus_semantic_search`: semantic search interface
- `gitnexus_graph`: direct graph slice around a symbol or node id
- `gitnexus_context`: incoming and outgoing relations for one symbol
- `gitnexus_call_chain`: breadth-first traversal over `CALLS`, `RENDERS`, and `HANDLES`
- `gitnexus_cypher`: run Cypher-compatible queries against LadybugDB
- `gitnexus_stats`: node and edge totals
- `gitnexus_export`: full graph export

## GitNexus Web Compatibility

After `gitnexus analyze`, run:

```bash
gitnexus serve --port 4747
```

The server reads `~/.gitnexus/registry.json`, opens each repo's `.gitnexus/lbug`, and exposes GitNexus-compatible HTTP endpoints such as:

```text
/api/repos
/api/graph?repo=<repo-name>
```

This lets the existing GitNexus web app consume frontend-nexus results without changing the web UI.

## Embeddings

Embedding does not affect graph precision.

Graph generation is entirely parser/checker based. `CALLS`, `RENDERS`, `HANDLES`, `ROUTES_TO`, and other edges are created before any vector step and do not depend on embeddings.

`--embedding` now writes vectors into the same LadybugDB store:

- embedding nodes are stored in `CodeEmbedding`
- each row keeps `nodeId`, `chunkIndex`, `startLine`, `endLine`, `embedding`, and `contentHash`
- `.gitnexus/meta.json` records embedding provider, model, vector dimensions, and embedding count
- `~/.gitnexus/registry.json` gets the updated embedding count for GitNexus web/API consumers

Offline local model usage:

```bash
gitnexus analyze \
  --root /path/to/vue-project \
  --embedding \
  --provider local \
  --model /absolute/path/to/local/embedding-model
```

The local provider uses `@huggingface/transformers` and is configured for offline operation by default:

- `GITNEXUS_LOCAL_EMBEDDING_MODEL=/absolute/path/to/local/model`
- `GITNEXUS_TRANSFORMERS_CACHE=/absolute/path/to/cache`
- `GITNEXUS_ALLOW_REMOTE_MODELS=1` only if you explicitly want to allow network model loading

For internal networks, keep `GITNEXUS_ALLOW_REMOTE_MODELS` unset and pass a local model path. The local runtime must have the model files and the platform's `onnxruntime-node` binary available before running.

Other providers:

```bash
gitnexus analyze --root /path/to/vue-project --embedding --provider http --model bge --name my-vue-app
gitnexus analyze --root /path/to/vue-project --embedding --provider hash
```

`http` expects an OpenAI-compatible embedding endpoint:

- `GITNEXUS_EMBEDDING_URL`
- `GITNEXUS_EMBEDDING_MODEL`
- `GITNEXUS_EMBEDDING_API_KEY` if the endpoint requires auth

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
- GitNexus registry writing
- GitNexus-compatible HTTP server
- CLI graph inspection commands
- MCP server with `gitnexus_*` tools
- frontend-specific Codex skill under `skills/gitnexus-vue`

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
- Full monorepo analysis can be slow; prefer package-level roots until incremental indexing is added.
- Template expression extraction links identifier references, but it does not execute Vue runtime behavior.
- Third-party component internals are only linked when their source exists inside the analyzed root.
- LadybugDB vector writing is not finalized yet; graph precision is already independent from that.
