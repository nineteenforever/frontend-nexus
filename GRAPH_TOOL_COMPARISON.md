# 图谱与代码理解工具源码对比：Graphify、Understand-Anything、Karpathy LLM Wiki、GitNexus、VueNexus

这份文档不是 README 摘要，而是基于本地 clone 后的源码扫描整理出来的设计和实现对比。

本地阅读过的仓库路径：

```text
/Users/yezi/Desktop/Flora/project/graphify
/Users/yezi/Desktop/Flora/project/Understand-Anything
/Users/yezi/Desktop/Flora/project/karpathy-llm-wiki
/Users/yezi/Desktop/Flora/GitNexus/gitnexus
/Users/yezi/Desktop/Flora/frontend-nexus
```

要回答的核心问题是：

1. 这几个项目分别有什么用？
2. 它们各自怎么设计？
3. 源码里具体用了什么技术？
4. 它们对 agent、开发者、代码分析有什么帮助？
5. 如果目标是做一个前端 Vue 专用的精准图谱工具，应该学谁、避开谁？

## 一句话结论

Graphify 是“万物资料图谱化”；Understand-Anything 是“让 agent 读懂项目的产品化工作流”；Karpathy LLM Wiki 是“长期沉淀的人类可读知识库”；GitNexus 是“多语言代码图数据库”；VueNexus 是“收窄到 Vue/前端后的 GitNexus 式精准图谱工具”。

如果目标是 Vue 前端项目的精准节点、边、调用链、影响范围和 agent 可消费图谱，最应该保留的是 GitNexus 的 CLI/MCP/LadybugDB/Cypher/serve/embedding 形态，同时把解析层改成 VueNexus 当前这种 Vue 官方解析器 + TypeScript Program + 前端规则引擎。

## 总览表

| 项目 | 核心定位 | 主要技术 | 结果存储 | 对 agent 的价值 | 最大短板 |
| --- | --- | --- | --- | --- | --- |
| Graphify | 任意资料转知识图谱 | Python、NetworkX、tree-sitter、LLM 语义抽取、HTML/Neo4j/MCP 输出 | `graphify-out/graph.json`、HTML、报告、可选全局图 | 快速把代码、文档、论文、图片等变成可探索图谱 | 精确代码调用链不是第一目标，存在推断边 |
| Understand-Anything | 代码库理解插件/产品 | TypeScript、web-tree-sitter、多语言 extractor、LLM 分析、dashboard、context builder | `.understand-anything/knowledge-graph.json` 等 | onboarding、解释文件、diff impact、给 LLM 组织上下文 | 图谱混合 LLM/agent 输出，确定性弱于专用代码图数据库 |
| Karpathy LLM Wiki | LLM 维护的长期知识库 | `SKILL.md` 工作流、Markdown、`raw/`、`wiki/`、索引和日志 | `raw/` + `wiki/*.md` | 长期项目记忆、架构结论、业务知识沉淀 | 不做 AST，不做代码图，不做调用链 |
| GitNexus | 多语言代码图数据库 | Node、tree-sitter、多语言 provider、LadybugDB、MCP、Cypher、embedding、process extraction | `.gitnexus/` LadybugDB、全局 registry | 精确查询代码关系、context、impact、processes、serve 给 web | 多语言通用导致复杂；Vue SFC/template 解析不够专用 |
| VueNexus | Vue/前端专用代码图数据库 | TypeScript、`@vue/compiler-sfc`、`@vue/compiler-dom`、TypeScript Program、LadybugDB、MCP、离线 embedding | `.vuenexus/lbug`、`.vuenexus/meta.json`、`~/.vuenexus/registry.json` | 前端 agent 可直接查 Vue 组件、模板事件、调用链、影响范围 | 范围有意收窄，当前仍需继续补更多 Vue/Vite/Pinia/Nuxt 细节规则 |

## 1. Graphify

### 它是干什么的

Graphify 的目标不是只分析代码，而是把一个目录里的“所有有价值资料”变成知识图谱。

它支持的对象包括：

- 代码文件
- Markdown/文档
- 论文/PDF
- 图片
- 视频
- 人写的 note 或 rationale

它最终输出：

```text
graphify-out/graph.json
graphify-out/graph.html
graphify-out/GRAPH_REPORT.md
```

还可以导出 Neo4j、启动 MCP server、合并 global graph。

所以 Graphify 更像“资料研究和项目探索工具”，不是纯代码静态分析器。

### 源码里的设计思路

Graphify 的核心设计是“两层抽取，再合并成图”：

1. AST 抽取层
   - 对代码走 parser/tree-sitter。
   - 抽函数、类、import、call 等结构化信息。

2. 语义抽取层
   - 对文档、论文、图片、项目概念、rationale 等走 LLM/agent。
   - 产出 concept node、semantic edge、hyperedge。

然后 `graphify/build.py` 把多个 extraction 结果合成一个 NetworkX graph。

源码里比较关键的实现点：

- `build_from_json()` 接收统一的 `nodes` / `edges` / `hyperedges` JSON。
- 图引擎用 NetworkX。
- 支持 directed graph，但也兼容旧的 undirected graph。
- 会把 `links` 兼容成 `edges`。
- 会修正老 schema，例如 `source` 改成 `source_file`。
- 会 normalize LLM 生成的 node id，尽量让语义边能连回 AST 节点。
- 会跳过 dangling edges，例如标准库或外部依赖节点不存在时不报硬错误。
- semantic extraction 可能覆盖 AST node 的一些属性。

这说明 Graphify 在源码层面承认：LLM/agent 生成的图谱信息可能不完全规整，所以需要 normalize、dedup、schema repair。

### 关键技术

- Python
- NetworkX
- tree-sitter 多语言代码解析
- JSON node-link graph
- LLM/agent semantic extraction
- semantic cache
- graph merge / global graph
- HTML graph visualization
- Neo4j export / push
- MCP server
- confidence / inferred / ambiguous edge 思路

### 有什么用

Graphify 对 agent 很有帮助，尤其是 agent 要读的不只是代码时。

它适合回答：

- 这个项目有哪些主要概念？
- 哪些文档、代码、论文互相关联？
- 哪些节点是中心节点？
- 项目的知识社区怎么分布？
- 是否能生成一个 HTML 图谱给人看？

它很适合“探索、研究、总结、报告”，也适合团队把杂乱资料变成知识地图。

### 相比 GitNexus / VueNexus 的不足

Graphify 的边可以是 `EXTRACTED`、`INFERRED`、`AMBIGUOUS`。这对知识探索很好，但对精准代码调用链是风险。

VueNexus 这类工具不能让 LLM 决定：

- 模板事件是否调用某个 handler
- 某个组件是否渲染另一个组件
- 某个 composable 是否调用 API 函数
- 某个 route 是否加载某个页面组件

这些边必须来自确定性 parser 和 resolver。

所以 Graphify 可以借鉴它的报告、可视化、MCP、global graph、知识图谱体验，但不能照搬它的“语义推断边作为图谱事实”的做法。

## 2. Understand-Anything

### 它是干什么的

Understand-Anything 是一个“项目理解插件/产品”，目标是让 agent 快速读懂一个仓库。

它不是只做底层图数据库，而是围绕开发者和 agent 使用体验做了一整套功能：

- 扫描项目
- 生成 knowledge graph
- dashboard
- chat/context
- explain
- onboard
- domain/layer 识别
- diff impact
- semantic search

它更像“代码库理解工作台”。

### 源码里的设计思路

它的源码分成两层：

1. 确定性结构分析层
   - `packages/core/src/plugins/tree-sitter-plugin.ts` 里有 tree-sitter plugin。
   - 这个 plugin 的注释和实现说明它抽取 functions、classes、imports、exports、call graphs。
   - 支持 TypeScript、JavaScript、Python、Go、Rust、Java、Ruby、PHP、C/C++、C# 等多语言 extractor。

2. Agent/LLM 理解层
   - 把 graph node/edge 整理成 LLM 可用 context。
   - 做 explain、onboard、diff impact、domain/layer 分析。
   - 通过 dashboard 和 chat 面向用户。

`context-builder.ts` 的逻辑很典型：

- 先用 SearchEngine 找相关节点。
- 再沿 graph edges 扩展 1 hop。
- 收集相关 nodes、edges、layers。
- 格式化成 Markdown 给 LLM。

`diff-analyzer.ts` 也很典型：

- 把 changed file 映射到 graph nodes。
- 找 contains 子节点。
- 找 1-hop affected nodes。
- 输出 changed nodes、affected nodes、impacted edges、affected layers。

还有一个很值得注意的测试：`merge-recover-imports.test.mjs`。它测试了当 batch/agent 输出漏掉 import edges 时，如何从 `scan-result.json` 的 `importMap` 恢复 imports edge。

这说明它的图谱构建不是完全“parser 真值表”式的，它接受 LLM/agent 批处理可能漏边，然后用 deterministic scan 信息补救。

### 关键技术

- TypeScript
- web-tree-sitter
- 多语言 extractor
- graph builder / knowledge graph JSON
- SearchEngine
- SemanticSearchEngine
- LLM analyzer
- layer detector
- tour/onboarding generator
- diff impact analyzer
- dashboard
- plugin/install scripts

### 有什么用

Understand-Anything 对 agent 的帮助主要是“快速理解项目”：

- 新 agent 进入仓库时知道从哪里开始读。
- 用户问某个文件/功能时，它能拼出相关上下文。
- 改动某个文件时，它能给出可能影响范围。
- 可以生成 onboarding 路线和 layer/domain 解释。

它不是只服务机器查询，也服务人看 dashboard。

### 相比 GitNexus / VueNexus 的不足

它的强项是理解和解释，不是最严格的静态代码关系数据库。

对 VueNexus 来说，可以借鉴：

- onboarding
- layer/domain summary
- diff impact 解释格式
- dashboard
- LLM-ready context formatting

但不要让 LLM/agent 批处理成为精确调用边的来源。

## 3. Karpathy LLM Wiki

### 它是干什么的

Karpathy LLM Wiki 和前面几个完全不同。它不是代码 analyzer，也不是图数据库，而是一个 LLM skill。

它的目标是维护一个长期增长的知识库：

```text
raw/   原始资料，不随意改写
wiki/  LLM 编译后的知识文章
wiki/index.md
wiki/log.md
```

核心理念是：LLM 写和维护 wiki，人类阅读和提问。

### 源码里的设计思路

这个仓最核心的文件是 `SKILL.md`。它定义了三类操作：

1. Ingest
   - 把外部资料放入 `raw/`。
   - 选择或创建 topic。
   - 编译成 `wiki/<topic>/<article>.md`。
   - 如果新资料影响已有文章，就 cascade update。

2. Query
   - 先读 `wiki/index.md`。
   - 再读相关文章。
   - 基于 wiki 回答，而不是凭模型记忆回答。
   - 回答里引用 wiki 页面。

3. Lint
   - 检查 index 和实际文件是否一致。
   - 检查内部链接。
   - 检查 raw 引用。
   - 检查明显缺失的 see also。
   - 报告事实冲突、过期 claims、孤儿页面等。

它的“实现”不是传统代码，而是 skill workflow + markdown schema。

### 关键技术

- Codex/agent skill 设计
- Markdown durable storage
- `raw/` / `wiki/` 双层资料模型
- `index.md` 作为检索入口
- `log.md` 作为操作审计
- ingest/query/lint 工作流
- 人类可读、git 可 diff 的知识库

### 有什么用

它对项目长期维护非常有用。

适合沉淀：

- 架构原则
- 业务规则
- 历史决策
- 踩坑记录
- 重要调用链解释
- 项目 glossary
- agent 分析过的结论

例如 VueNexus 找出一条长调用链后，可以把“这条调用链为什么重要、业务上代表什么、以后改哪里要小心”沉淀到 wiki。

### 相比 GitNexus / VueNexus 的不足

它不做：

- AST 解析
- import/export resolution
- symbol graph
- call graph
- Cypher 查询
- embedding 存储
- impact radius

所以它不能替代 VueNexus，但可以成为 VueNexus 上层的知识沉淀系统。

## 4. GitNexus

### 它是干什么的

GitNexus 是这几个里面最接近“代码图数据库”的项目。

它分析代码仓库，把符号、调用、模块、过程、上下文等写入本地 LadybugDB，然后通过 CLI、MCP、server、Cypher 给 agent 和 web UI 使用。

典型用法：

```text
gitnexus analyze
gitnexus query
gitnexus context
gitnexus cypher
gitnexus serve
gitnexus mcp
```

### 源码里的设计思路

GitNexus 是大型多语言 pipeline。

从源码里可以看到它的分析流程大致包括：

1. scan
   - 找到仓库文件。
   - 根据 supported languages 判断可分析文件。

2. structure
   - 先建立项目结构、文件层级和基础节点。

3. parse
   - 通过 tree-sitter worker 解析多语言源码。
   - 支持 TypeScript、JavaScript、Python、Java、C/C++、C#、Go、Rust、PHP、Ruby 等。

4. import / route / tool / ORM extraction
   - 抽 import/export。
   - 抽路由。
   - 抽 MCP/RPC tool。
   - 抽 ORM/query 相关信息。

5. cross-file resolution
   - 把跨文件引用重新解析到目标符号。

6. scope resolution
   - 更精细地绑定作用域、receiver、继承、方法调用等关系。

7. communities / clusters
   - 对图做聚类。

8. processes
   - 从调用关系里抽执行流/过程。

9. embedding
   - 可选生成 semantic embeddings。

10. LadybugDB write
   - 写入本地图数据库。

### 关键技术

- Node.js
- tree-sitter 原生 parser
- 多语言 provider / extractor / resolver
- worker 解析
- parse cache
- import resolver
- cross-file resolution
- scope resolution
- route/tool/ORM extraction
- graph clustering
- process extraction
- LadybugDB
- Cypher-compatible query
- MCP stdio server
- HTTP server / web API
- local and remote embeddings
- global registry

### Vue 支持的源码细节

GitNexus 支持 `.vue`，但支持方式偏通用。

在 `src/core/ingestion/vue-sfc-extractor.ts` 可以看到：

- 用正则提取 `<script>` / `<script setup>`。
- 提取出来后交给 TypeScript tree-sitter grammar。
- 如果同时存在 `<script>` 和 `<script setup>`，偏向 setup block。
- template 里的组件使用通过 PascalCase 正则扫描。

这对普通 `.vue` 文件有帮助，但它不是 Vue 官方 AST。

Vue template 里有很多不能靠正则准确表达的东西：

- `@click="foo(bar)"`
- `v-on="{ click: foo }"`
- `:is="currentComponent"`
- `v-slot`
- `v-for` 作用域
- `ref`
- `defineProps`
- `defineEmits`
- `defineExpose`
- Options API methods/computed/watch
- Composition API return binding
- JSX/TSX 组件引用

GitNexus 的多语言通用性很强，但 Vue 专用精度不是它的设计中心。

### 有什么用

GitNexus 对 agent 非常有用：

- agent 不必每次全仓搜索。
- 可以直接查 symbol context。
- 可以查某个改动的 impact。
- 可以查调用链/process。
- 可以通过 MCP 暴露给 Claude/Codex/opencode。
- 可以通过 Cypher 做任意图查询。
- 可以 serve 给 web UI 看。
- embedding 让语义搜索更好用。

它是 VueNexus 最应该继承的基础范式。

### 相比 VueNexus 的不足

GitNexus 的问题不是能力弱，而是范围太大。

多语言通用会导致：

- 代码量大。
- 抽象层多。
- 前端框架规则不容易做得极细。
- Vue SFC/template 只能作为多语言之一处理。
- 对“只分析 Vue 前端项目”的用户来说，有很多不需要的复杂度。

VueNexus 的价值就是把范围收窄，换取前端图谱精度。

## 5. VueNexus

### 它是干什么的

VueNexus 是一个 Vue/前端专用的代码图谱工具，目标是保留 GitNexus 式使用体验，但只服务前端项目。

当前身份和用法是：

```text
npm package: vuenexus
CLI: vuenexus
local db: .vuenexus/lbug
metadata: .vuenexus/meta.json
registry: ~/.vuenexus/registry.json
MCP tools: vuenexus_*
```

典型命令：

```text
vuenexus analyze --root /path/to/vue-project --embedding
vuenexus query "useAuth"
vuenexus context --symbol LoginPage
vuenexus chain --from App --depth 6
vuenexus cypher "MATCH (a)-[r:CodeRelation]->(b) RETURN a,r,b LIMIT 20"
vuenexus serve --port 4747
vuenexus mcp --db .vuenexus/lbug
vuenexus setup
```

### 源码里的设计思路

VueNexus 的设计思路是：

```text
GitNexus 的使用形态 + Vue/前端专用解析器 + LadybugDB 存储 + MCP/CLI/serve 给 agent 消费
```

它不是再做一个泛语言平台，而是把精力放在这些前端文件上：

```text
.vue
.ts
.tsx
.js
.jsx
.mjs
.cjs
```

核心入口在 `src/indexer.ts`。

分析流程大致是：

1. 文件扫描
   - 只包含前端源码扩展名。
   - 忽略 `.git`、`node_modules`、`dist`、`build`、`.nuxt`、`.output`、`coverage`、`.vuenexus` 等目录。

2. Vue SFC 解析
   - 使用 `@vue/compiler-sfc` 的 `parse`。
   - 每个 `.vue` 文件成为一个 `Component` node。
   - `<script>` 和 `<script setup>` 被转换成虚拟 `.vue.ts`。
   - 建立虚拟 TS 文件行号到真实 `.vue` 行号的映射。

3. Vue template 解析
   - 使用 `@vue/compiler-dom` 的 `baseParse`。
   - 从 template AST 提取组件使用、事件 handler、表达式引用等。

4. TypeScript Program
   - 真实 `.ts/.tsx/.js/.jsx/.mjs/.cjs` 加入一个 TypeScript Program。
   - `.vue` 文件的 script 部分作为虚拟 `.vue.ts` 加入 Program。
   - 通过 TypeScript checker 做符号解析。

5. import/export resolution
   - 解析相对路径、index 文件、`.vue` 组件、TS/JS/JSX/TSX。
   - `.vue` import 会映射到虚拟 script，但图节点仍指向真实 `.vue` 文件。

6. 前端框架规则
   - Vue component node。
   - script setup 顶层 binding。
   - Options API default export。
   - Vuex store/action/mutation/getter/state。
   - router route object。
   - JSX/TSX component usage。
   - template component rendering。
   - template event handler。

7. 图构建
   - 产生 node 和 edge。
   - 关系类型包括 `CALLS`、`RENDERS`、`HANDLES`、`ROUTES_TO` 等。
   - unresolved 引用不会假装成功，会进入 unresolved report。

8. LadybugDB 写入
   - `src/lbug-writer.ts` 创建 LadybugDB node table 和 relation table。
   - 图数据库写到 `.vuenexus/lbug`。
   - 元信息写到 `.vuenexus/meta.json`。
   - 全局 registry 写到 `~/.vuenexus/registry.json`。

9. embedding
   - embedding 不参与图谱精度。
   - 图谱先由 parser/checker 生成，再可选生成向量。
   - 向量写入 LadybugDB 的 `CodeEmbedding` node table。

10. MCP / CLI / serve
   - CLI 在 `src/cli.ts`。
   - MCP 在 `src/mcp.ts`。
   - serve/web API 在 `src/server.ts`。
   - setup/opencode 自动配置在 `src/setup.ts`。

### 关键技术

VueNexus 当前关键技术包括：

- TypeScript
- `@vue/compiler-sfc`
- `@vue/compiler-dom`
- TypeScript Compiler API / TypeChecker
- Vue SFC virtual file
- Vue virtual line mapping
- import/export resolver
- template AST traversal
- script setup binding analysis
- Options API object analysis
- Vuex helper/action/mutation/getter/state 识别
- router object 识别
- JSX/TSX 支持
- LadybugDB
- Cypher-compatible query
- `@modelcontextprotocol/sdk`
- MCP stdio server
- commander CLI
- HTTP server for GitNexus-web-compatible browsing
- local/offline embedding model resolver
- `@huggingface/transformers` local embedding
- OpenAI-compatible HTTP embedding endpoint
- hash provider for lightweight/dev embedding
- opencode skill and MCP setup

### 存储实现

VueNexus 保持和 GitNexus 类似的本地-first 图数据库思路。

本地项目内：

```text
<project>/.vuenexus/lbug
<project>/.vuenexus/meta.json
```

用户全局：

```text
~/.vuenexus/registry.json
```

embedding 存在 LadybugDB 的 `CodeEmbedding`：

```text
id
nodeId
chunkIndex
startLine
endLine
embedding
contentHash
```

这和 GitNexus 的理念一致：图和向量都在本地，agent 可以离线消费。

### MCP 实现

VueNexus MCP tools 使用 `vuenexus_*` 命名。

当前包括：

- `vuenexus_query`
- `vuenexus_semantic_search`
- `vuenexus_graph`
- `vuenexus_context`
- `vuenexus_call_chain`
- `vuenexus_unresolved_report`
- `vuenexus_impact_radius`
- `vuenexus_cypher`
- `vuenexus_stats`
- `vuenexus_export`

这意味着 opencode、Codex、Claude 或其他 MCP agent 可以直接读取已经分析好的前端图谱。

### 有什么用

VueNexus 对前端 agent 的价值是：把“读仓库”变成“查图谱”。

agent 可以更快完成：

- 找组件被谁渲染。
- 找模板事件最终调用哪个函数。
- 找某个 composable 被哪些页面使用。
- 找 route 对应哪个页面组件。
- 找 Vuex action/mutation 影响范围。
- 找 JSX/TSX 里使用的组件。
- 查一个 symbol 的上下文。
- 查一个改动的反向影响范围。
- 导出完整图给其他 agent 或内网系统。
- 用 embedding 做语义搜索，但不影响图谱事实。

### 当前相对 GitNexus 的优势

VueNexus 的优势来自“少做，但做深”：

- 不需要支持 Python/Java/Go/Rust/PHP 等后端语言。
- 可以把 `.vue` 当作一等公民，而不是预处理成普通 TS。
- 使用 Vue 官方 parser，而不是 regex。
- template AST 可以产生前端专属边。
- TS Program 可以统一处理 `.vue` 虚拟脚本和真实 TS/JS 文件。
- 可以把 Vue Options API、Composition API、Vuex、router、JSX/TSX 放进同一套前端图谱语义。

### 当前还需要继续加强的地方

VueNexus 当前已经有核心框架，但如果目标是“极高精度”，后续还应该继续补：

- Pinia store 识别。
- Nuxt file-based route 识别。
- Vue Router 动态 import 更细解析。
- provide/inject 关系。
- defineEmits 到 parent listener 的更强绑定。
- defineExpose/ref 调用关系。
- template scope 的更完整类型绑定。
- `v-model` 到 prop/update event 的双向关系。
- slot scope 和 scoped slot 关系。
- auto import 生态，如 unplugin-auto-import、components.d.ts。
- Vite alias、tsconfig paths、monorepo workspace resolver。

这些都应该用确定性解析和项目配置解析来做，不应该靠 LLM 猜。

## 五个项目的设计差异

### 数据真值来源不同

Graphify 的真值来源是 AST + LLM semantic extraction。它允许 inferred 和 ambiguous。

Understand-Anything 的真值来源是 parser + agent/LLM workflow。它重视可解释上下文和产品体验。

Karpathy LLM Wiki 的真值来源是 raw source + LLM 整理后的 wiki，人类可读优先。

GitNexus 的真值来源主要是 parser/resolver，然后写入 LadybugDB，适合机器查询。

VueNexus 的真值来源应该只来自 Vue/TS/JS parser 和 resolver。LLM 只能解释，不能造边。

### 存储模型不同

Graphify：

```text
graphify-out/graph.json
graphify-out/graph.html
graphify-out/GRAPH_REPORT.md
optional global graph / Neo4j
```

Understand-Anything：

```text
.understand-anything/knowledge-graph.json
dashboard/context/onboarding artifacts
```

Karpathy LLM Wiki：

```text
raw/
wiki/
wiki/index.md
wiki/log.md
```

GitNexus：

```text
.gitnexus/ LadybugDB
~/.gitnexus/registry.json
```

VueNexus：

```text
.vuenexus/lbug
.vuenexus/meta.json
~/.vuenexus/registry.json
```

### 面向对象不同

Graphify 面向“任意资料图谱化”。

Understand-Anything 面向“agent 和人快速理解仓库”。

Karpathy LLM Wiki 面向“长期知识沉淀”。

GitNexus 面向“多语言代码图谱和 agent 查询”。

VueNexus 面向“Vue/前端项目的精确代码图谱和 agent 查询”。

## 对 VueNexus 的具体启发

### 可以从 Graphify 学什么

- 图谱报告。
- HTML 可视化。
- global graph。
- agent 安装体验。
- 明确标注 extracted/inferred 的思路。

但 VueNexus 里，如果以后有 inferred edge，也必须和 parser edge 分开，不能进入精确调用链。

### 可以从 Understand-Anything 学什么

- onboarding 体验。
- dashboard。
- diff impact 的人类解释。
- layer/domain summary。
- 给 LLM 整理上下文的格式。

但精确边不要依赖 LLM 批处理。

### 可以从 Karpathy LLM Wiki 学什么

- 把分析结论沉淀成 Markdown。
- 让 agent 的调查结果可追溯、可复用。
- 给团队保存业务语义和架构解释。

它适合作为 VueNexus 的上层知识库，不适合作为底层图谱。

### 可以从 GitNexus 学什么

- CLI/MCP/server 的形态。
- LadybugDB 本地存储。
- Cypher 查询。
- context/query/impact/processes。
- registry。
- embedding 和图谱分离。
- web UI 消费图数据库。

VueNexus 当前就是沿这个方向做的。

## 最终判断

这五个工具不是互相完全替代，而是在不同层级解决问题：

```text
Graphify              泛资料知识图谱
Understand-Anything   项目理解产品和 agent 上下文
Karpathy LLM Wiki     长期知识沉淀
GitNexus              多语言代码图数据库
VueNexus              Vue/前端专用代码图数据库
```

如果目标是公司内网里让任意 agent 消费 Vue 前端项目图谱，VueNexus 应该坚持这个原则：

```text
parser/checker 决定图谱事实
LadybugDB 保存图谱和向量
MCP/CLI/server 暴露能力
embedding 增强搜索
LLM 只负责解释和总结
Markdown/wiki/report 负责长期沉淀
```

这样 VueNexus 才能同时满足三个要求：

1. 用法像 GitNexus 一样稳定。
2. 对 Vue/前端项目比 GitNexus 更精准。
3. 输出结果能被 opencode、Codex、Claude、内网 agent 和 web UI 反复消费。
