# VueNexus

VueNexus 是一个面向 Vue 前端项目的代码图谱分析工具，主要给 codebase tools 和 agent 使用。

这个包统一使用 `vuenexus` 这个身份：

- CLI 命令：`vuenexus`
- MCP 工具名：`vuenexus_*`
- 项目本地存储：`.vuenexus/lbug`
- 元数据：`.vuenexus/meta.json`
- 全局 registry：`~/.vuenexus/registry.json`
- Web API：`vuenexus serve`，接口形状兼容 GitNexus 项目的 `gitnexus-web`

VueNexus 不追求支持后端多语言。它只专注 Vue/TypeScript 前端项目，让扫描器更小，前端图谱关系更精准。

## 安装

VueNexus 要求 Node.js 20.17 或更新版本。内网安装建议使用 Node 22 LTS，因为本地 embedding runtime 依赖平台相关的 ONNX 包。

```bash
npm install -g vuenexus
vuenexus analyze --root /path/to/vue-project --embedding
vuenexus serve --port 4747
```

在本仓库本地开发和打包：

```bash
npm install
npm run build
npm run check
npm test
npm pack
npm uninstall -g vuenexus
npm install -g ./vuenexus-0.1.8.tgz
```

VueNexus 用 TypeScript 实现，npm 包发布的是 `dist` 里的编译后 JavaScript。

## 支持的 Vue 项目

VueNexus 面向这些 Vue 前端仓库：

- Vue 2 Options API 项目
- Vue 3 Composition API 和 `<script setup>` 项目
- `.vue`、`.ts`、`.tsx`、`.js`、`.jsx`、`.mjs`、`.cjs` 源码文件
- Vue SFC 里的 TypeScript、JavaScript、TSX、JSX script
- Pinia 和 Vuex store 模式
- Vue Router route object 和懒加载组件 import

## Analyze 流程

`vuenexus analyze` 是核心命令。当前流程如下：

1. 扫描项目根目录下的前端源码文件。
   - 包含 `.vue`、`.ts`、`.tsx`、`.js`、`.jsx`、`.mjs`、`.cjs`
   - 忽略 `.git`、`node_modules`、`dist`、`build`、`.nuxt`、`.output`、`coverage`、`.vuenexus`
   - 默认跳过 generated/minified JS，以及任意层级的 `public/`、`static/`

2. 给每个扫描到的源码文件创建 `File` 节点。

3. 使用 Vue 官方 compiler 解析 Vue SFC。
   - `@vue/compiler-sfc` 解析 `.vue`
   - 每个 `.vue` 文件生成一个 `Component` 节点
   - `<script>` 和 `<script setup>` 会被抽成虚拟 `.vue.ts` 文件
   - 虚拟 script 的行号会映射回真实 `.vue` 文件行号

4. 使用 `@vue/compiler-dom` 解析 Vue template。
   - `<UserCard>` 或 `<user-card>` 这类组件标签生成 `RENDERS` 边
   - directive 和 interpolation 表达式生成回 script symbol 的 `HANDLES` 边
   - 例如 `@click="save"`、`v-if="visible"`、`:items="items"`、`{{ title }}`

5. 基于真实文件和虚拟 Vue script 文件创建 TypeScript Program。
   - 默认 `--checker fast`，不对每个 call expression 做昂贵的深度类型解析
   - import/export、局部调用、Vue SFC、template、route、Pinia/Vuex、mixin 主要靠 AST-first 规则解析
   - `.vue` import 会解析到虚拟 script 文件，但图谱节点仍指向真实 `.vue`

6. 收集声明节点。
   - function 和 arrow-function variable
   - `useXxx` 风格 composable
   - `defineStore` 或 store 文件里的 Pinia store
   - `createRouter` router
   - class、interface、method
   - `private submit = () => {}` 这类 class property method
   - variable 和 destructured variable

7. 收集图谱边。
   - `DEFINES`：文件包含声明
   - `IMPORTS`：静态 import、动态 import、外部包、本地资源
   - `CALLS`：函数、方法、构造器调用
   - `RENDERS`：Vue template 组件使用
   - `HANDLES`：Vue template 表达式引用 script symbol
   - `ROUTES_TO`：Vue Router route 指向组件
   - `USES_STORE`：Pinia/Vuex store 使用和 action 调用
   - `MIXES_IN`：Vue 2 `mixins` 和 `extends`
   - `HAS_UNRESOLVED`：某个 owner/file 下存在值得 agent 注意的未解析关系

8. 应用 Vue/前端专用精度规则。
   - `this.foo()` 优先匹配真实同类/同文件 method，而不是 class 节点
   - `store.action()` 在 store 变量已知时链接到 Pinia store action method
   - Vuex `mapState`、`mapGetters`、`mapActions`、`mapMutations`、`dispatch`、`commit` 尽量解析到 store/module/action
   - Vue 2 Options API 的 props、data、computed、methods、inline components、mixins、component names 会被索引
   - `tsconfig`/`jsconfig`、常见 Vite/Webpack alias、package self-import、`src` 目录 alias、barrel re-export、Vue 组件大小写会先解析，解析失败才标记 unresolved
   - route object 只在 route-like 上下文识别，不会把所有带 `path` 的对象都当路由
   - type-only/interface callback signature 不会误生成 `CALLS`
   - 变量 initializer call 也会从变量节点补一条边，便于 computed/composable 链路追踪
   - 第三方包会变成 `ExternalModule` 节点，而不是 `UnresolvedReference`

9. 写入 LadybugDB。
   - 图数据库：`.vuenexus/lbug`
   - 元数据：`.vuenexus/meta.json`
   - 全局 registry：`~/.vuenexus/registry.json`

10. 返回分析统计和 diagnostics。
    - diagnostics 包含 Vue parse diagnostic、TypeScript diagnostic、fallback warning
    - diagnostics 用于暴露 unresolved library/shim 或 checker fallback 点
    - diagnostics 不等于图谱失败

## 存储格式

VueNexus 使用自己的前端图谱语义，同时保持 GitNexus Web 能消费的 LadybugDB graph shape。

项目本地文件：

```text
<project>/.vuenexus/lbug
<project>/.vuenexus/meta.json
<project>/.vuenexus/cache/analysis-cache.json
<project>/.vuenexus/cache/files/
```

全局 registry：

```text
~/.vuenexus/registry.json
```

LadybugDB 节点 label 尽量复用现有 Web 图谱 schema：

| 前端概念 | 存储 label |
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

前端原始节点类型会保存在 `description` JSON 的 `frontendType` 字段里。

`UnresolvedReference` 只用于记录本地 resolver 尝试后仍未解析、且对影响面分析有意义的图谱缺口。普通第三方依赖不会放进 unresolved。

关系统一存储为 `CodeRelation`：

```text
source -[:CodeRelation {
  type,
  confidence,
  reason,
  step
}]-> target
```

`step` 是发现关系的源码行号。

## CLI

分析并启动服务：

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

默认情况下，`analyze` 把阶段进度写到 stderr，把最终 JSON 结果写到 stdout。进度是阶段级的，不是逐文件刷屏，因此大项目里也不会明显拖慢分析。需要机器可读输出时用 `--json`；需要安静模式时用 `--quiet`。

`analyze` 默认是 `--checker fast`。fast 模式避免对每个调用表达式触发昂贵的 TypeScript checker 调用，避免大 Vue 项目卡在复杂依赖/类型图里。它仍会解析 Vue SFC、import/export、本地调用、template 边、route、Pinia/Vuex、mixin 和常见同文件调用。

只在你确实需要更深 TypeScript 调用目标解析时使用：

```bash
vuenexus analyze --checker full
```

最保守的 AST/local-only 模式：

```bash
vuenexus analyze --checker off
```

`analyze` 默认使用增量缓存。缓存包含一个小 manifest 和每文件图谱切片：

```text
.vuenexus/cache/analysis-cache.json
.vuenexus/cache/files/
```

下次运行时，未变化文件会复用切片；变化文件和 import 它们的文件会重新分析。

全量重跑并刷新缓存：

```bash
vuenexus analyze -f
vuenexus analyze --force
```

本次忽略缓存：

```bash
vuenexus analyze --no-incremental
```

`analyze` 默认跳过 generated/minified JavaScript 和静态目录。规则覆盖 `.min.js`、`jquery*.js`、`cssWorkerMain.js`、runtime/vendor/chunk bundle、超长单行 JS，以及 monorepo 任意层级下的 `public/` 和 `static/`。进度会打印跳过路径、原因和大小。

确实需要分析这些文件时：

```bash
vuenexus analyze --include-generated
```

如果项目根目录已有 `.gitignore`，`analyze` 会自动追加一次 `.vuenexus/`，避免 graph/cache/LadybugDB 文件出现在 Git changes 里。

默认不收集完整 TypeScript semantic diagnostics，因为它们在大项目里可能非常慢，而且不影响图谱生成。只有明确需要诊断报告时使用：

```bash
vuenexus analyze --diagnostics
```

检查已存图谱：

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

启动 MCP：

```bash
vuenexus mcp
```

配置 opencode：

```bash
vuenexus setup
```

默认会安装：

- MCP 配置：`~/.config/opencode/opencode.json`
- skill 文件：`~/.config/opencode/skill/vuenexus/SKILL.md`

Windows 上 `~` 通常是用户目录，所以默认路径类似：

```text
C:\Users\<you>\.config\opencode\opencode.json
C:\Users\<you>\.config\opencode\skill\vuenexus\SKILL.md
```

写入 opencode 的 MCP 配置：

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

`vuenexus mcp` 默认读取当前工作目录下的 `.vuenexus/lbug`，因此 MCP 配置通常不需要 `--db`。只有当 agent 从项目外部目录启动 MCP server 时，才需要：

```bash
vuenexus setup --db /absolute/path/to/.vuenexus/lbug
```

项目级 opencode 配置：

```bash
vuenexus setup --scope project
```

## MCP 工具

MCP server 暴露这些 VueNexus 风格工具名：

- `vuenexus_query`：搜索已索引节点
- `vuenexus_semantic_search`：语义搜索接口
- `vuenexus_graph`：围绕 symbol 或 node id 获取图谱切片
- `vuenexus_context`：获取一个 symbol 的入边和出边上下文
- `vuenexus_call_chain`：沿 `CALLS`、`RENDERS`、`HANDLES` 做 BFS 遍历
- `vuenexus_unresolved_report`：按类型聚合 unresolved references
- `vuenexus_impact_radius`：反向影响面分析，包含 unresolved blocker 和 `complete`/`partial` 置信标记
- `vuenexus_cypher`：对 LadybugDB 执行 Cypher-compatible 查询
- `vuenexus_stats`：节点和边统计
- `vuenexus_export`：导出完整图谱

## GitNexus Web 兼容

执行 `vuenexus analyze` 后启动：

```bash
vuenexus serve --port 4747
```

server 会读取 `~/.vuenexus/registry.json`，打开每个 repo 的 `.vuenexus/lbug`，并暴露 GitNexus 仓库里的 `gitnexus-web` 期望的 HTTP endpoint：

```text
/api/repos
/api/graph?repo=<repo-name>
```

这让现有 `gitnexus-web` 可以不改 UI 直接消费 VueNexus 结果。

## 浏览器 UI

浏览器 UI 在同级 `vuenexus-web` 项目里，不打进 CLI npm 包。这样 `vuenexus` 专注 analyze/storage/MCP/API，`vuenexus-web` 像 `gitnexus-web` 一样作为独立前端项目连接 `vuenexus serve`。

开发时启动 UI：

```bash
cd /path/to/frontend-nexus/vuenexus-web
npm install
npm run dev
```

典型本地流程：

```bash
vuenexus analyze --root /path/to/vue-project
vuenexus serve --port 3000
```

打开：

```text
http://127.0.0.1:5173
```

在页面 server input 中填：

```text
http://127.0.0.1:3000
```

`vuenexus serve` 提供图谱 API，`vuenexus-web` 提供浏览器交互体验。

如果需要静态构建，在 `vuenexus-web` 里运行：

```bash
npm run build
```

必要时可以用 legacy helper command 托管这个 build：

```bash
vuenexus ui --port 5173 --server http://127.0.0.1:3000 --ui-dir /path/to/frontend-nexus/vuenexus-web/dist
```

UI 能做：

- 连接本地或远端 VueNexus server
- 从 `~/.vuenexus/registry.json` 列出已分析 repo
- 从 `/api/graph?stream=true` 流式读取图谱
- 在 canvas 上渲染节点和边
- 搜索 symbol/file/component
- 查看选中节点的直接关系

## Embedding

Embedding 不影响图谱精度。

图谱生成完全基于 parser/checker。`CALLS`、`RENDERS`、`HANDLES`、`ROUTES_TO` 等边在任何向量步骤之前就已经生成，不依赖 embedding。

`--embedding` 会把向量写入同一个 LadybugDB：

- embedding 节点存储在 `CodeEmbedding`
- 每行包含 `nodeId`、`chunkIndex`、`startLine`、`endLine`、`embedding`、`contentHash`
- `.vuenexus/meta.json` 记录 embedding provider、model、vector dimensions、embedding count
- `~/.vuenexus/registry.json` 会更新 embedding count，供 Web/API 消费

离线本地模型用法：

```bash
vuenexus analyze \
  --root /path/to/vue-project \
  --embedding \
  --provider local \
  --model /absolute/path/to/local/embedding-model
```

local provider 使用 `@huggingface/transformers`，默认离线运行。如果模型已经打包在 npm 包的 `models/embedding` 下，可以不传 `--model`：

```bash
vuenexus analyze --root /path/to/vue-project --embedding
vuenexus model-info
```

`provider=local` 的模型解析顺序：

1. `--model /absolute/model/dir`
2. `VUENEXUS_LOCAL_EMBEDDING_MODEL`
3. 包内置 `models/embedding`
4. `--model-package <npm-package>` 或 `VUENEXUS_LOCAL_EMBEDDING_MODEL_PACKAGE`
5. 已知模型包，例如 `@vuenexus/embedding-model`

打包模型目录必须是 Transformers.js feature-extraction 模型，通常包含：

```text
models/embedding/config.json
models/embedding/tokenizer.json
models/embedding/onnx/model_quantized.onnx
```

内网 npm 发布方式：

```bash
# 发布前复制/导出模型文件
mkdir -p models/embedding
# models/embedding/config.json, tokenizer.json, onnx/model_quantized.onnx, ...

npm publish --registry http://your-internal-npm/
npm install -g vuenexus --registry http://your-internal-npm/
vuenexus model-info
vuenexus analyze --root /path/to/vue-project --embedding
```

如果模型太大，不适合放进主包，可以发一个 companion package，并在 `package.json` 写：

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

安装并使用：

```bash
npm install -g vuenexus @your-scope/vuenexus-embedding-model --registry http://your-internal-npm/
vuenexus analyze --root /path/to/vue-project --embedding --model-package @your-scope/vuenexus-embedding-model
```

环境变量：

- `VUENEXUS_LOCAL_EMBEDDING_MODEL=/absolute/path/to/local/model`
- `VUENEXUS_LOCAL_EMBEDDING_MODEL_PACKAGE=@your-scope/vuenexus-embedding-model`
- `VUENEXUS_TRANSFORMERS_CACHE=/absolute/path/to/cache`
- `VUENEXUS_ALLOW_REMOTE_MODELS=1`，只在你明确允许网络加载模型时设置

内网环境应保持 `VUENEXUS_ALLOW_REMOTE_MODELS` 未设置，并传本地模型路径。运行前需要确保模型文件和当前平台的 `onnxruntime-node` 二进制都可用。

其他 provider：

```bash
vuenexus analyze --root /path/to/vue-project --embedding --provider http --model bge --name my-vue-app
vuenexus analyze --root /path/to/vue-project --embedding --provider hash
```

`http` 需要 OpenAI-compatible embedding endpoint：

- `VUENEXUS_EMBEDDING_URL`
- `VUENEXUS_EMBEDDING_MODEL`
- `VUENEXUS_EMBEDDING_API_KEY`，如果 endpoint 需要鉴权

`hash` 是 deterministic offline fallback，只适合测试和 smoke check，不是语义模型。

所以验证图谱正确性时，可以先跳过向量化。向量搜索是给 agent 的检索能力，不参与边关系生成。

## 已实现能力

- 使用 Vue 官方 compiler 解析 Vue SFC
- 虚拟 `.vue.ts` script 文件
- 虚拟 Vue script 行号映射回真实 `.vue`
- AST-first 的 import/export、本地调用、Vue 关系解析
- 可选 TypeScript checker full 模式
- Vue template `RENDERS` 和 `HANDLES`
- Vue Router route-to-component
- Pinia store usage 和 store action call
- Vuex map helper、dispatch、commit 解析
- class method 和 class property method
- composable 检测
- generated/minified JS 与 public/static 静态目录过滤
- 增量分析缓存
- LadybugDB 图谱写入
- LadybugDB `CodeEmbedding` 向量写入
- 通过 `@huggingface/transformers` 支持本地/离线 embedding 模型
- 存储 embedding 后的语义搜索
- VueNexus registry 写入
- GitNexus Web 兼容 HTTP server
- CLI 图谱检查命令
- MCP server，工具名为 `vuenexus_*`
- 前端专用 Codex skill：`skills/vuenexus`

## 已验证项目

扫描器已经在本地 fixture 和真实 Vue 项目上验证过：

- `vuestic-admin`
  - 验证过 Vue component 数量、route 边、Pinia store action call、长调用链
- `vue-vben-admin/packages/@core/ui-kit`
  - 338 个扫描文件
  - 2842 个节点
  - 4243 条边
  - 验证过从 Vue template event 到 class methods 的长链路：

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

## 当前限制

- 设计上只支持 Vue/frontend，不支持后端多语言。
- 大型 monorepo 冷缓存首次分析仍可能慢；建议首次先按 package root 分析，保持 generated/static 过滤开启，后续依赖默认增量缓存。
- template expression 抽取会链接 identifier reference，但不会执行 Vue runtime 行为。
- 第三方组件内部只有源码在分析 root 内时才会继续链接。
- embedding 存储已支持，但图谱精度仍由 parser/checker 决定，和向量搜索无关。
