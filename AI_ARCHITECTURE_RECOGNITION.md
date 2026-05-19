# 从辅助 AI 识别代码架构出发的方案判断

这份文档从第一性原理出发，讨论如果目标是“辅助 AI 识别代码架构”，Graphify、Understand-Anything、Karpathy LLM Wiki、GitNexus、VueNexus 这些方案各自适合放在哪一层。

这里的目标不是只分析 Vue 项目，而是综合考虑多语言、多框架、多仓库、长期演进和 agent 实际使用。

## 核心问题

“辅助 AI 识别代码架构”不是简单生成一张图。它真正要解决的是：

1. AI 怎么知道代码里的事实关系？
2. AI 怎么把事实关系归纳成架构单元？
3. AI 怎么知道图谱有没有过期？
4. AI 怎么判断改动影响范围？
5. AI 怎么把一次分析结果沉淀成长期记忆？
6. AI 怎么同时理解代码、文档、设计决策和业务语义？

所以，一个完整方案至少需要五层能力：

```text
代码事实层
语言/框架专用增强层
架构理解层
资料知识层
长期记忆层
```

任何单个工具都不能完美覆盖所有层。

## 第一性原则

### 1. 代码事实必须由 parser / resolver 产生

AI 识别架构的基础是事实。

这些事实包括：

- 文件和目录结构
- import/export 关系
- 函数/方法/类/组件定义
- 调用关系
- 类型关系
- 路由入口
- API 入口
- service/repository/controller 边界
- 组件渲染关系
- 状态管理关系
- 跨文件依赖

这些不能靠 LLM 猜。

LLM 可以解释：

```text
为什么这些模块看起来像三层架构
为什么这个组件像页面入口
为什么这个 service 是核心依赖
```

但 LLM 不应该决定：

```text
A 是否真的调用 B
A 是否真的 import B
某个路由是否真的指向某个组件
某个 controller 是否真的调用某个 service
```

因此，底层事实图谱应该来自确定性的 parser、compiler API、language server 或 framework resolver。

### 2. 架构解释可以由 LLM 归纳，但必须引用图谱证据

架构不是单条边，而是许多事实边形成的模式。

例如：

- Controller -> Service -> Repository 可能表示经典三层架构。
- Page -> Component -> Composable -> API client 可能表示前端 feature 架构。
- Handler -> Usecase -> Gateway 可能表示 Clean Architecture。
- Route -> Middleware -> Handler -> DB 可能表示 Web 服务请求链路。

这些模式可以由 LLM 帮忙归纳，但归纳必须基于图谱证据。

更好的输出应该是：

```text
这是一个分层架构。
证据：
- src/routes/user.ts 调用 src/services/user.ts
- src/services/user.ts 调用 src/repositories/user.ts
- repository 层集中访问 db client
```

而不是：

```text
我感觉这是分层架构。
```

### 3. 通用系统必须支持多语言，但框架细节必须由专用插件补齐

真正的公司代码库通常不是单语言：

- 前端 Vue/React/Angular
- Node.js 服务
- Python 服务
- Java/Spring 服务
- Go 服务
- Rust/C++ 基础设施
- PHP/Ruby 老系统
- SQL/schema
- 配置和部署文件

所以通用架构识别系统不能只支持 Vue。

但也不能指望一个通用 parser 精准理解所有框架细节。

合理方式是：

```text
通用多语言事实图谱
+
语言/框架专用增强器
```

例如：

- Vue 增强器理解 SFC、template、router、store、composable。
- Spring 增强器理解 Controller、Service、Repository、Bean、注解路由。
- Django/FastAPI 增强器理解 route、view、serializer、model、dependency injection。
- Go 增强器理解 interface implementation、grpc/gin route、package boundary。
- Rust 增强器理解 crate、module、trait impl。

这比“一个通用规则吃所有语言”更可靠。

### 4. embedding 只能辅助搜索，不能决定架构关系

embedding 适合回答：

- “用户登录相关代码在哪里？”
- “权限校验逻辑在哪里？”
- “订单筛选相关模块有哪些？”

但 embedding 不适合决定：

- A 是否调用 B
- A 是否依赖 B
- A 是否属于某一条真实执行链

所以 embedding 应该是搜索增强层，而不是事实图谱层。

理想系统里：

```text
analyze 先生成确定性图谱
embed 再异步生成向量
semantic search 只辅助定位
```

### 5. 图谱必须支持增量和 freshness 检查

如果图谱过期，AI 使用它会比不用更危险。

因此每个 node/edge 至少应该关联：

- source file
- content hash
- analyzer version
- resolver version
- analyzed time

MCP 和 CLI 查询结果应该能告诉 agent：

```json
{
  "graphFresh": true,
  "embeddingFresh": false,
  "staleFiles": [],
  "complete": true,
  "unresolved": []
}
```

如果代码已经变了，系统应该明确提示：

```text
图谱已过期，请先 update。
```

这点对 AI 架构识别很重要，因为架构判断一旦基于旧图，就会误导重构和影响分析。

### 6. 稳定结论应该沉淀成长期记忆

架构识别不是一次性动作。

AI 分析过一次项目后，应该把稳定结论沉淀下来，例如：

- 架构总览
- 目录职责
- 核心业务流程
- 关键调用链
- 修改风险点
- 历史设计决策
- 业务词汇表

这些内容应该以人类可读的形式存在，例如 Markdown wiki。后续 agent 进入项目时，可以先读这些稳定记忆，再查询最新图谱。

## 五个方案的客观定位

## 1. GitNexus：最适合作为通用事实图谱底座

从通用代码架构识别角度看，GitNexus 是五个方案里最接近“事实图谱底座”的。

它的优势是：

- 支持多语言。
- 使用 tree-sitter 解析代码。
- 有 import、call、scope、cross-file resolution 等代码图谱能力。
- 使用 LadybugDB 做本地图数据库。
- 支持 Cypher 查询。
- 支持 MCP。
- 支持 context、impact、processes。
- 支持 embedding。
- 支持 serve 给 web 使用。

这些能力正好对应 AI 识别架构的底层需求：让 AI 查询结构化代码事实，而不是反复全文搜索。

但 GitNexus 不能被视为完整答案。

它的问题包括：

- 多语言通用导致实现复杂。
- 具体框架语义不一定足够深入。
- 对 Vue 这类 SFC/template 场景不够专用。
- 增量更新和 freshness 机制需要加强。
- embedding 如果和 analyze 绑得太紧，会拖慢工作流。
- 图谱准确率需要更多 golden tests 和真实项目验证。

因此，客观结论是：

```text
GitNexus 的方向最适合作为通用底座。
GitNexus 的现状还需要补增量、freshness、准确率验证和框架专用增强器。
```

## 2. Understand-Anything：最适合作为架构理解层

Understand-Anything 的强项不是做最严格的图数据库，而是把代码图谱变成 AI 和人能理解的上下文。

它适合提供：

- layer detection
- domain / feature 识别
- onboarding path
- explain
- diff impact summary
- LLM context builder
- dashboard
- 代码库理解工作流

这些能力非常贴近“AI 如何识别架构”。

因为 AI 不只是需要知道边，还需要知道：

- 哪些节点构成一个业务域？
- 哪些目录属于同一层？
- 哪些文件应该优先读？
- 改一个模块会影响哪些 feature？
- 这个仓库的核心流程是什么？

Understand-Anything 的价值在于把底层图谱变成可解释架构。

但它不适合作为唯一底座：

- 它的图谱构建混合了 parser 和 LLM/agent 工作流。
- 它更偏项目理解体验，不是严格的本地图数据库。
- 对“真实调用边不能错”的需求，仍需要更确定性的底层图谱支撑。

因此，客观结论是：

```text
Understand-Anything 不应该替代 GitNexus 类事实图谱。
它更适合作为事实图谱之上的架构理解和解释层。
```

## 3. VueNexus：适合作为前端/Vue 专用增强器，不适合作为通用核心

VueNexus 的优势在 Vue/前端领域：

- 使用 `@vue/compiler-sfc` 解析 `.vue`。
- 使用 `@vue/compiler-dom` 解析 template。
- 使用 TypeScript Program 和 TypeChecker。
- 支持 `.vue/.ts/.tsx/.js/.jsx/.mjs/.cjs`。
- 能表达前端关系，例如组件渲染、模板事件、router、store、JSX/TSX 组件使用。
- 使用 LadybugDB、MCP、CLI、serve、embedding。

这使它适合作为“Vue/前端项目专用 analyzer”。

但如果目标是通用 AI 架构识别，VueNexus 不能作为核心。

它不覆盖：

- Python 后端
- Java/Spring
- Go 服务
- Rust/C++
- PHP/Ruby
- 多语言 monorepo 后端链路
- 微服务之间的跨语言架构

因此，客观结论是：

```text
VueNexus 是很适合的前端专用插件。
它不是通用架构识别平台的底座。
```

在理想系统里，VueNexus 应该是：

```text
GitNexus-like 多语言平台中的 Vue/frontend framework analyzer plugin
```

## 4. Graphify：适合作为资料知识层和探索层

Graphify 的核心价值是把多种资料转成知识图谱。

它支持的不只是代码，还包括：

- 文档
- Markdown
- PDF/论文
- 图片
- 视频
- rationale
- 外部资料

它使用 AST + LLM semantic extraction，再通过 NetworkX 合成图，输出 JSON、HTML、报告，也可以接 MCP/Neo4j。

从辅助 AI 识别架构角度看，Graphify 很适合补充“代码之外的知识”：

- README 里的架构描述
- ADR 里的设计决策
- API 文档
- 产品文档
- 部署文档
- 业务流程文档

这些资料对理解架构非常重要，但它们不是代码事实边。

Graphify 的短板是：

- 语义边可能是 inferred 或 ambiguous。
- LLM 参与图谱构建，适合知识探索，不适合作为精确调用链真值。
- 对代码级 impact/call-chain 的严格性不如 parser/resolver 图数据库。

因此，客观结论是：

```text
Graphify 适合做资料扩展和知识图谱探索。
它不适合作为代码架构事实层的唯一来源。
```

## 5. Karpathy LLM Wiki：最适合作为长期记忆层

Karpathy LLM Wiki 的核心不是自动解析代码，而是维护一个长期增长的 Markdown 知识库。

它的结构是：

```text
raw/
wiki/
wiki/index.md
wiki/log.md
```

它适合沉淀：

- 架构总览
- 业务领域解释
- 设计决策
- 重要调用链说明
- 常见修改路径
- 历史问题和解决方案
- agent 调查结论

这对 AI 很重要，因为 AI 不应该每次都从零读完整仓库。

但它不适合作为底层 analyzer：

- 不做 AST。
- 不做 graph DB。
- 不做 call graph。
- 不做 resolver。
- 不做 impact radius。

因此，客观结论是：

```text
Karpathy LLM Wiki 适合作为长期架构记忆。
它应该消费图谱和分析结果，而不是替代图谱系统。
```

## 客观推荐方案

如果目标是“辅助 AI 识别通用代码架构”，最合适的不是单选某一个项目，而是综合它们的设计。

推荐架构如下：

```text
第一层：多语言代码事实图谱
借鉴 GitNexus

第二层：语言/框架专用增强器
借鉴 VueNexus 这类垂直 analyzer

第三层：架构理解和解释
借鉴 Understand-Anything

第四层：资料知识图谱
借鉴 Graphify

第五层：长期架构记忆
借鉴 Karpathy LLM Wiki
```

## 推荐系统形态

### 第一层：多语言事实图谱层

职责：

- 多语言 parser。
- import/export/call/type/scope resolution。
- 文件、符号、模块、调用、依赖、入口点建图。
- 本地图数据库存储。
- Cypher/query/context/impact。
- MCP 给 agent 调用。

主要借鉴：

```text
GitNexus
```

但必须加强：

- 增量更新。
- freshness 检查。
- stale graph 警告。
- changed file reindex。
- embedding 异步化。
- golden graph tests。
- resolver confidence。
- unresolved report。

### 第二层：语言/框架专用增强器

职责：

- 对具体语言和框架做深度理解。
- 弥补通用 AST 不能表达的框架语义。

示例：

```text
Vue analyzer:
- SFC
- template
- router
- store
- composable
- component tree

Spring analyzer:
- Controller
- Service
- Repository
- Bean
- annotation route
- transaction boundary

FastAPI/Django analyzer:
- route
- view
- serializer
- model
- dependency injection

Go analyzer:
- gin/grpc route
- interface implementation
- package boundary

Rust analyzer:
- crate
- module
- trait impl
```

主要借鉴：

```text
VueNexus 的垂直专用思路
```

但不能把 VueNexus 当成通用核心。

### 第三层：架构理解层

职责：

- layer detection。
- domain / feature clustering。
- architecture summary。
- onboarding path。
- explain。
- diff impact summary。
- LLM context builder。
- 架构异味检测。

主要借鉴：

```text
Understand-Anything
```

这里 LLM 可以发挥作用，但必须引用事实图谱证据。

### 第四层：资料知识层

职责：

- 纳入 README、ADR、设计文档、API 文档、部署文档、产品文档。
- 把非代码资料和代码事实关联起来。
- 生成 HTML/report。
- 辅助架构探索。

主要借鉴：

```text
Graphify
```

但资料语义边应该和代码事实边分开标记。

### 第五层：长期记忆层

职责：

- 保存稳定架构结论。
- 保存业务解释。
- 保存历史决策。
- 保存重要流程说明。
- 保存 agent 调查日志。

主要借鉴：

```text
Karpathy LLM Wiki
```

这层应该由图谱和架构理解层生成或更新，但保留人类可读、可审查、可 git diff 的 Markdown 形式。

## 五个方案的适配度排序

如果只看“通用 AI 识别代码架构”的底层适配度：

| 排名 | 方案 | 判断 |
| --- | --- | --- |
| 1 | GitNexus | 最适合作为通用代码事实图谱底座 |
| 2 | Understand-Anything | 最适合作为架构理解、解释、onboarding 层 |
| 3 | Graphify | 适合作为代码外资料的知识图谱扩展 |
| 4 | Karpathy LLM Wiki | 适合作为长期架构记忆 |
| 特化 | VueNexus | 适合作为 Vue/前端专用分析插件，不适合作为通用核心 |

如果看“最终系统应该综合哪些设计”：

```text
GitNexus-like 多语言事实图谱
+
VueNexus-like 框架专用插件
+
Understand-Anything-like 架构理解层
+
Graphify-like 文档资料图谱
+
Karpathy-Wiki-like 长期记忆
```

## 最终结论

从第一性原理看，辅助 AI 识别代码架构的最佳方案不是“某一个工具替代所有工具”。

更合理的答案是：

```text
用 GitNexus 类系统做多语言事实图谱底座；
用 VueNexus 类系统做框架/语言专用增强插件；
用 Understand-Anything 类系统做架构理解和解释；
用 Graphify 类系统纳入代码外资料；
用 Karpathy LLM Wiki 类系统沉淀长期架构记忆。
```

其中最重要的边界是：

```text
parser/resolver 负责事实。
LLM 负责解释。
embedding 负责搜索。
wiki 负责记忆。
框架插件负责精度。
```

如果要做一个真正面向 AI 的通用架构识别平台，应该优先建设：

1. 多语言、可增量、可验证的代码事实图谱。
2. 每种语言/框架的专用 analyzer。
3. 图谱 freshness 和 unresolved 报告。
4. 架构理解层和 evidence-based summary。
5. 长期 Markdown 架构记忆。

这样 AI 才不是“看起来懂代码”，而是真的基于可验证事实理解架构。
