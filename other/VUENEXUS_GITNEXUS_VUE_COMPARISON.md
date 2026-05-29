# VueNexus 与 GitNexus 在 Vue 项目上的对比

本文只比较二者面对 Vue 前端项目时的设计、analyze 流程、图谱关系能力和适用场景。结论先说：如果目标是分析一个纯 Vue 前端仓，尤其关注组件、模板事件、路由、Pinia/Vuex、composable、调用链和影响面，VueNexus 更合适；如果目标是统一分析多语言 monorepo、前后端混合仓、服务边界、后端路由、跨语言依赖和通用代码图谱，GitNexus 更合适。

## 一句话定位

| 项目 | 定位 |
| --- | --- |
| GitNexus | 多语言通用代码图谱平台。核心优势是语言覆盖、通用 pipeline、增量/缓存/FTS/embedding/web/MCP/服务分析等完整工程化能力。 |
| VueNexus | Vue 前端专用图谱分析器。核心优势是使用 Vue 官方解析器和 TypeScript compiler API，把 Vue 前端特有关系做得更细、更直接。 |

## 对 Vue 项目的支持方式

### GitNexus

GitNexus 对 `.vue` 文件有有限支持，但不是完整的 Vue SFC 解析器支持。更准确地说，它是在多语言 tree-sitter pipeline 里给 `.vue` 做了一层预处理：先从 SFC 文本里抽出 script，再按 TypeScript/JavaScript 解析。

关键实现方式：

- `.vue` 作为一种语言 provider，复用 TypeScript/JavaScript 的 query、import resolver、call extractor、type extractor、field extractor 等基础设施。
- `.vue` 文件先通过 `vue-sfc-extractor` 用正则抽取 `<script>` 或 `<script setup>` 内容，再交给 TypeScript tree-sitter grammar 解析。
- `<script setup>` 顶层绑定会被当作隐式 export 处理。
- Vue 内置函数如 `ref`、`reactive`、`computed`、`watch`、`defineProps`、`defineEmits` 等被加入 built-in 名单，避免被当作普通业务调用目标。
- 模板组件支持主要是抽取 PascalCase 标签，然后根据 import map 找同名 `.vue` import，生成 `CALLS` 边到被渲染组件文件。

从源码看，GitNexus 的 Vue 处理主要是正则式 SFC 片段抽取，不是 `@vue/compiler-sfc` / `@vue/compiler-dom` 这种官方 AST 解析：

- `<script>` / `<script setup>` 抽取：`src/core/ingestion/vue-sfc-extractor.ts`
- 模板 PascalCase 组件抽取：同文件 `extractTemplateComponents`
- Vue provider：`src/core/ingestion/languages/vue.ts`
- 模板组件边：`src/core/ingestion/call-processor.ts`

这套方案的好处是能接入 GitNexus 大 pipeline，不需要给 Vue 单独维护完全不同的存储、MCP、Web、embedding、增量和查询体系。代价是 Vue SFC/template 语义较浅：它更像“把 `.vue` 里的 script 抽出来当 TS/JS 解析，再补一点模板组件识别”。

### VueNexus

VueNexus 是专门为 Vue 前端项目写的，不支持后端语言，也不追求多语言通用性。

关键实现方式：

- `.vue` 使用官方 `@vue/compiler-sfc` 解析 SFC。
- `<template>` 使用官方 `@vue/compiler-dom` 解析模板 AST。
- `<script>` / `<script setup>` 被转换成虚拟 Vue script 文件，加入 TypeScript Program。
- 使用 TypeScript compiler API 和 checker 做 import、symbol、call、method、constructor、object method、class method、变量函数等解析。
- 图谱仍写 LadybugDB，保持 GitNexus Web 风格的节点/边消费形态。

VueNexus 对 Vue 前端有更多专门关系：

- `RENDERS`：模板中组件标签渲染到真实组件。
- `HANDLES`：模板表达式、事件、指令、插值回到 script 符号，如 `@click="save"`、`v-if="visible"`、`:items="items"`、`{{ title }}`。
- `ROUTES_TO`：Vue Router route object 指向组件，包含 lazy import。
- `USES_STORE`：组件/composable/method 使用 Pinia 或 Vuex store。
- `MIXES_IN`：Vue 2 Options API 的 `mixins` / `extends`。
- `CALLS`：TypeScript 解析出来的函数、方法、构造器、composable、store action 调用。
- `HAS_UNRESOLVED` / `UnresolvedReference`：无法静态确定的前端关系会显式记录，提醒 agent 不要过度相信影响面为空。

这套方案的好处是 Vue 语义更强：不仅知道 script 调用了什么，还知道 template 渲染了什么、事件绑定到哪里、route 到哪个页面、store action 从哪里被触发。代价是它不分析 Java/Python/Go/Rust/PHP 等后端语言。

## Analyze 流程对比

### GitNexus analyze

GitNexus 的 analyze 是完整工程化 pipeline。大致流程：

1. 解析 repo identity、git commit、registry、存储路径。
2. 读取已有 meta、file hash、parse cache，用于判断是否可增量或需要全量。
3. 文件系统遍历，按语言识别文件。
4. 对各语言加载 tree-sitter parser。
5. 对 `.vue` 文件用正则抽取 `<script>` / `<script setup>`，再当 TypeScript parse。
6. 运行 DAG pipeline：
   - parsing
   - import resolving
   - class/function/method/field/variable extraction
   - type extraction
   - call extraction
   - heritage/inheritance
   - route/service/process/community 等扩展阶段
7. 将结果写入 LadybugDB。
8. 创建 FTS 索引。
9. 可选生成 embedding，且支持保留既有 embedding。
10. 写 meta、registry、AI context、skills 等辅助文件。

它的重点是“一个大平台分析很多语言”。Vue 是其中一种语言 provider。

对 Vue 的实际效果：

- script 区域能复用 TS/JS tree-sitter 的通用能力。
- import/call/class/method 等通用关系能进图。
- 模板 PascalCase 组件能被识别成 `CALLS` 到 import 的 `.vue` 文件。
- 对 Vue Router、Pinia/Vuex、template expression、Options API 细粒度语义，GitNexus 不是专门为 Vue 做的，覆盖深度不如 VueNexus。

### VueNexus analyze

VueNexus 的 analyze 更短，目标更窄。大致流程：

1. 遍历前端源码文件：
   - `.vue`
   - `.ts`
   - `.tsx`
   - `.js`
   - `.jsx`
   - `.mjs`
   - `.cjs`
2. 为每个文件创建 `File` 节点。
3. 使用 `@vue/compiler-sfc` 解析 `.vue`。
4. 使用 `@vue/compiler-dom` 解析模板：
   - 组件标签 -> `RENDERS`
   - 指令/事件/插值表达式 -> `HANDLES`
5. 生成 Vue virtual script，构建 TypeScript Program。
6. 使用 TypeScript checker 解析：
   - imports
   - declarations
   - functions/classes/methods/variables
   - calls
   - constructor calls
   - object/class method calls
7. 解析 Vue 特有结构：
   - Vue Router route objects -> `ROUTES_TO`
   - Pinia `defineStore`、store 变量、store action -> `USES_STORE` / `CALLS`
   - Vuex `mapState`、`mapGetters`、`mapActions`、`mapMutations`、`dispatch`、`commit`
   - Vue 2 Options API 的 props/data/computed/methods/components/mixins/extends
8. 对别名、barrel re-export、`.vue` import、component casing、第三方包做前端专门解析。
9. 无法确定的关系记录为 `UnresolvedReference`，并通过 `HAS_UNRESOLVED` 连接到 owner/file。
10. 写入 LadybugDB、`.vuenexus/meta.json`、`~/.vuenexus/registry.json`。
11. 可选 embedding，embedding 不影响图谱关系生成。

它的重点是“让 Vue 前端关系尽量像人读源码一样准确”。

## 节点和边的差异

### GitNexus

GitNexus 更偏通用图谱：

- `File`
- `Class`
- `Function`
- `Method`
- `Interface`
- `Variable`
- `Route`
- `Community`
- `Process`
- `ExternalModule`
- 多语言通用 `CodeRelation`

它的 Vue 模板组件关系用 `CALLS` 表达，原因类似 `vue-template-component`。这能让通用 call graph 消费者看懂，但语义上会把“模板渲染”折叠进“调用”。

### VueNexus

VueNexus 在存储上兼容 LadybugDB/Web 消费形态，但在 `description` 或关系类型中保留前端语义：

- `Component`
- `Composable`
- `Store`
- `Router`
- `Route`
- `Function`
- `Method`
- `Variable`
- `ExternalModule`
- `UnresolvedReference`

关系更 Vue 化：

- `RENDERS`
- `HANDLES`
- `ROUTES_TO`
- `USES_STORE`
- `MIXES_IN`
- `CALLS`
- `IMPORTS`
- `DEFINES`
- `HAS_UNRESOLVED`

对 agent 来说，`RENDERS` 和 `HANDLES` 很重要，因为它们能区分“模板渲染了组件”和“函数调用了函数”，也能从 UI 事件追到 script 逻辑。

## 对 Vue 项目哪个更好

### 如果只看 Vue 前端关系准确度：VueNexus 更好

原因：

- 使用 Vue 官方 SFC/template parser，而不是主要靠正则抽取 template/component。
- 能解析模板表达式，不只是 PascalCase 组件标签。
- 明确建模 Vue Router、Pinia、Vuex、Vue 2 Options API。
- 使用 TypeScript checker 做符号级解析，适合 TS/Vue 项目。
- 对 unresolved 做显式节点，便于 agent 判断影响面是否可信。
- 图谱关系更贴近前端开发者真正关心的问题：
  - 这个页面渲染了哪些组件？
  - 这个按钮点下去走到哪个 handler？
  - handler 调了哪个 composable？
  - composable 或组件用了哪个 store？
  - 这个 route 最后进入哪个页面组件？

### 如果看多语言、大仓、平台能力：GitNexus 更好

原因：

- 支持很多语言，不限 Vue/TS/JS。
- analyze pipeline 更工程化，包含增量、parse cache、file hash、staleness、FTS、embedding preservation、community/process/service 等能力。
- 更适合前后端混合仓、后端服务仓、monorepo、跨语言架构理解。
- GitNexus Web、server API、MCP、skills 等生态更成熟。
- 对非 Vue 部分，例如 Java/Python/Go/Rust/PHP/C++，VueNexus 不会分析。

## 关键取舍

| 维度 | GitNexus | VueNexus |
| --- | --- | --- |
| 目标 | 多语言通用代码图谱 | Vue 前端专用图谱 |
| Vue SFC script | 正则抽取 script 后用 TypeScript tree-sitter | Vue 官方 SFC parser + TS Program |
| Vue template | PascalCase component 抽取为 `CALLS` | 官方 template AST，生成 `RENDERS` / `HANDLES` |
| Vue Router | 非核心 Vue 专用能力 | 专门生成 `ROUTES_TO` |
| Pinia/Vuex | 非核心 Vue 专用能力 | 专门生成 `USES_STORE` 和 store action `CALLS` |
| Vue 2 Options API | 部分可由 JS/TS 通用解析覆盖 | 专门处理 props/data/computed/methods/components/mixins |
| 多语言 | 强 | 不支持 |
| 增量/缓存 | 强 | 目前较弱，偏全量重扫 |
| Web/MCP 成熟度 | 更成熟 | 基本可用，仍在演进 |
| 对 Vue agent 的帮助 | 通用帮助 | 更直接、更细粒度 |

## 实际建议

如果你的项目是纯 Vue 前端，推荐优先用 VueNexus：

```bash
vuenexus analyze
vuenexus stats
vuenexus query "SomeComponent"
vuenexus context --symbol SomeComponent
vuenexus chain --from SomeComponent --depth 6
```

如果你的项目是大型多语言 monorepo，建议：

- 用 GitNexus 做全仓、多语言、跨服务图谱。
- 用 VueNexus 单独分析 Vue 前端子项目。
- 让 agent 在回答前端问题时优先查 VueNexus，在回答跨后端/服务边界问题时查 GitNexus。

## 客观结论

Vue 项目本身不是一种普通 TypeScript 项目。真正的前端关系有很多存在于 template、router、store 和 Options API 里。GitNexus 的设计是正确的通用平台设计，但它对 Vue 的支持目前更像“把 Vue 降维成 TS/JS + 少量模板组件补丁”。这对通用图谱够用，但对 Vue 前端调用链和 UI 关系不够细。

VueNexus 的设计判断是牺牲多语言覆盖，换取 Vue 前端关系的精度和可解释性。因此，在“只分析 Vue 前端项目”的前提下，VueNexus 更适合；在“分析整个多语言系统”的前提下，GitNexus 更适合。

最合理的长期方向不是让 VueNexus 复制 GitNexus 的所有多语言能力，而是：

- VueNexus 保持 Vue 前端专精。
- GitNexus 保持多语言平台能力。
- 二者存储/API/MCP 形态尽量兼容，让 agent 能根据问题选择最可靠的数据源。
