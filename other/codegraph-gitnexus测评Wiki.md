# codegraph 与 GitNexus 架构识别测评 Wiki

> 本文用于分享本轮 `codegraph` 与 `GitNexus` 在真实代码仓上的架构识别测评设计、结果和结论解读。

## 1. 测评设计：为什么这样评测

本轮测评的目标不是证明某个工具“理论上更强”，而是回答一个更接近实际落地的问题：

```text
当人不熟悉仓库，只能依靠内网 agent 和本地源码时，
codegraph / GitNexus 相对普通源码阅读到底提升了什么？
```

因此评测设计刻意贴近真实使用场景，而不是只跑单个 demo 仓库或单次问答。

### 1.1 样本设计

本轮由 6 个人分别执行测评，每个人都覆盖同一组 5 个仓库，并最终生成交叉测评报告。样本仓库包括：

- Java 仓库：2 个
- Vue 仓库：3 个

每个仓库都在本地离线环境中完成测评，源码已经存在，不依赖公网检索。这样可以尽量贴近内网研发场景：agent 能看到源码，但人不预先熟悉项目，也没有外部资料可以查。

### 1.2 三臂对比

每个仓库都采用三臂对比：

| 实验臂 | 含义 |
| --- | --- |
| Baseline | 不使用专门架构识别工具，只靠 agent 普通源码阅读、文件搜索、命令行探索 |
| codegraph | agent 优先使用 codegraph，再做源码校验 |
| GitNexus | agent 优先使用 GitNexus，再做源码校验 |

Baseline 是关键。没有 Baseline，就只能知道工具“能不能回答”，但不知道它相对普通 agent 阅读源码到底提升了多少。以 Baseline 为基准，才能量化：

- 准确率是否提高
- 响应时间是否减少
- 文件读取和搜索次数是否减少
- tool calls 是否减少
- token 或代理 token 是否节约
- 工具索引成本是否值得

### 1.3 每仓 6 类架构任务

每个仓库都不是只问一个问题，而是覆盖 6 类典型架构识别任务：

| 任务 | 目的 |
| --- | --- |
| 整体架构识别 | 看 agent 能否识别模块、分层、入口和协作关系 |
| 入口流程识别 | 看 agent 能否从主入口追踪到核心运行流程 |
| 依赖关系识别 | 看 agent 能否说清模块之间的依赖方向 |
| 影响范围分析 | 看 agent 能否判断改动核心文件会影响哪里 |
| 新人阅读顺序 | 看 agent 能否形成有效的 onboarding 路径 |
| 架构风险识别 | 看 agent 能否指出影响全局的关键模块或风险点 |

这样设计的原因是：架构识别不是单一能力。一个工具可能很擅长找调用链，但不擅长解释业务模块；也可能很擅长生成总结，但证据不够扎实。多任务能减少单题偶然性。

### 1.4 结果不是只看答案，而是保留可复核证据

每个仓库测评都会输出：

```text
benchmark-cg-gn/
  repo-profile.yaml
  tasks.yaml
  reference-facts.yaml
  index-metrics.yaml
  queue.csv
  runs/
  scores.csv
  repo-report.md
```

其中：

- `repo-profile.yaml` 记录仓库名、语言、文件数、代码行数、规模。
- `tasks.yaml` 记录该仓的 6 个测试问题。
- `reference-facts.yaml` 记录评分参考事实和证据。
- `index-metrics.yaml` 记录索引/analyze 时间、刷新时间。
- `runs/` 保存每个任务、每个实验臂的原始回答、指标和工具日志。
- `scores.csv` 保存每个 case 的评分。
- `repo-report.md` 保存单仓结论。

这使得测评不是“agent 说谁好就是谁好”，而是可以复查：

- 答案是否引用了真实文件
- 是否误用了其他实验臂结果
- 分数是否能从证据中解释
- 工具是否真的节省了探索步骤

### 1.5 隔离机制

为了避免工具结果互相污染，每个实验臂都有明确隔离规则：

| 实验臂 | 允许 | 禁止 |
| --- | --- | --- |
| Baseline | shell、文件读取、文本搜索、git 基础命令 | codegraph CLI/MCP、GitNexus CLI/MCP、工具索引产物、其他实验臂结果 |
| codegraph | codegraph CLI/MCP、源码校验 | GitNexus CLI/MCP、`.gitnexus/`、GitNexus arm 结果 |
| GitNexus | GitNexus CLI/MCP、源码校验 | codegraph CLI/MCP、`.codegraph/`、codegraph arm 结果 |

如果某个 case 使用了禁止工具，结果会标记为 `isolation_violation`，不能进入主评分，必须重跑。

### 1.6 可恢复执行

由于单仓测评需要跑三臂 * 6 个 case，再加上索引和评分，实际可能运行数小时。为了避免中途失败导致重来，手册要求每个仓生成：

```text
state.yaml
queue.csv
```

它们用于支持：

- 从失败阶段继续
- 只重跑失败 case
- 只重算评分
- 只重建报告
- 复用已完成且隔离通过的运行结果

这让测评更接近工程流程，而不是一次性脚本。

### 1.7 多仓复核

单仓测评完成后，再由多仓复核手册统一处理：

- 自动发现每个仓库的 `benchmark-cg-gn/`
- 校验输入是否完整
- 从 `scores.csv` 重算指标，不直接相信报告汇总表
- 抽样检查证据
- 处理异常值、失败样本、缺失指标
- 生成最终交叉测评报告

这个复核层的作用是降低单个执行 agent 的偏差。即使某个仓库测评不完整，也能被标记为 `warning`、`partial` 或 `fail`，避免混入主结论。

### 1.8 为什么这个设计相对可靠

本测评设计的可靠性主要来自 6 点：

1. 有 Baseline，能看到工具相对普通 agent 阅读源码的真实收益。
2. 有多任务，避免单一问题偶然影响结论。
3. 有多仓库和多执行人，降低单个 agent 或单个仓库的偏差。
4. 有证据文件和原始运行日志，结果可以追溯。
5. 有实验臂隔离，减少工具之间互相借答案。
6. 有多仓复核，最终结论不是单仓报告的简单拼接。

它仍然不是完美实验。比如样本数量有限，Vue 和 Java 项目结构差异明显，不同 agent 的执行质量也会影响结果。但作为内网实际选型前的实操测评，它比只看工具介绍、只跑单仓 demo、只问一次架构问题更可信。

## 2. 测评报告

> 这里粘贴本轮交叉测评最终报告。

```text
TODO: 粘贴最终测评报告内容。
```

## 3. 结论解说

本轮测评中，一个比较明显的现象是：

```text
codegraph 和 GitNexus 对 Java 项目的支持整体更容易发挥；
对 Vue，尤其是复杂前端项目的架构识别支持都不算理想。
```

这个现象不只是工具实现问题，也和前端项目，尤其是 Vue 项目的源码形态有关。

### 3.1 为什么这类工具对 Java 更容易发挥

Java 项目通常有比较稳定的结构：

```text
Controller -> Service -> Repository/Mapper/DAO -> Model/Entity
```

或者：

```text
Application main
Config
Controller
Service
Repository
DTO / Entity
```

这些结构对代码分析工具非常友好：

- 类、方法、包名是静态的。
- import 关系明确。
- 注解虽然需要解析，但语义相对稳定，例如 `@Controller`、`@Service`、`@Repository`、`@RequestMapping`。
- 调用链通常可以从方法符号追踪。
- Maven/Gradle 提供清晰的依赖入口。
- 目录结构常常能直接反映架构分层。

所以不管是 graph 类工具，还是上下文检索类工具，都比较容易从 Java 项目中提取稳定事实：

- 哪些类属于入口层
- 哪些类属于服务层
- 哪些接口被调用
- 哪些模块依赖哪些模块
- 改一个 service 可能影响哪些 controller

换句话说，Java 项目的“架构事实”更多写在静态代码结构里。

### 3.2 为什么 Vue / 前端项目更难

Vue 项目的难点在于：很多架构关系不完全存在于静态 import 和函数调用里，而是分散在框架约定、模板、路由、组件组合、状态管理和运行时配置中。

典型复杂点包括：

#### 3.2.1 `.vue` 单文件组件不是普通代码文件

Vue 的核心文件常常是 `.vue`：

```text
<template>
<script setup lang="ts">
<style scoped>
```

一个 `.vue` 文件里同时有：

- 模板结构
- 组件引用
- 事件绑定
- props / emits
- composition API
- 样式作用域
- 可能还有宏和编译期转换

如果分析工具只是按普通 TypeScript/JavaScript AST 处理，很容易只看到 `<script>`，看不到模板里的真实关系。

例如：

```vue
<UserCard :user="currentUser" @refresh="loadUser" />
```

这行代码同时表达了：

- 父组件依赖 `UserCard`
- 向子组件传递 `user`
- 子组件事件会触发父组件 `loadUser`

但这些关系不是普通函数调用。很多代码图工具如果没有 Vue template parser，就不容易把它变成准确的调用关系或数据流。

#### 3.2.2 `script setup` 和宏会改变源码形态

Vue 3 常用：

```ts
defineProps()
defineEmits()
defineExpose()
computed()
watch()
ref()
reactive()
```

其中 `defineProps`、`defineEmits` 等是编译期宏。源码里看起来像函数调用，但实际语义由 Vue 编译器处理。

如果工具不了解 Vue 编译流程，就可能：

- 看不懂 props 从哪里来
- 看不懂 emits 会影响谁
- 看不懂组件公开了什么能力
- 把响应式依赖当成普通变量关系

#### 3.2.3 路由和页面入口经常是配置驱动

前端项目的入口不一定是传统意义上的 `main` 调用链。Vue 常见入口是：

```text
main.ts
router/index.ts
routes.ts
views/
layouts/
```

路由可能是：

- 静态数组
- 动态 import
- 权限过滤后注入
- 后端返回菜单再生成
- 微前端运行时注册

例如：

```ts
component: () => import('@/views/user/index.vue')
```

这不是普通 import，而是动态 import。工具如果只看静态 import 图，就可能漏掉页面入口和路由到页面的关系。

#### 3.2.4 组件依赖不等于 import 依赖

Vue 组件之间的真实关系常常来自：

- template 中使用了子组件
- 全局组件注册
- 自动导入插件
- 组件库按需导入
- slots
- provide / inject
- props / emits

其中很多不是简单 import 能解释的。

例如 `provide/inject` 可以让祖先组件和深层子组件建立关系，但中间没有显式调用链。工具如果只构建 import/call graph，就会低估这种跨层依赖。

#### 3.2.5 状态管理让数据流变成“间接关系”

Vue 项目常见 Pinia/Vuex：

```text
component -> store action -> api client -> backend
component -> store state/getter -> derived UI
```

这类关系经常跨文件、跨组合函数、跨 API 层。组件里可能只写：

```ts
const userStore = useUserStore()
await userStore.loadUser()
```

真正的数据来源、缓存、错误处理、接口请求在 store 或 composable 中。工具要想识别架构，必须理解：

- store 是状态边界
- action 是业务入口
- composable 是复用逻辑
- api/request 是后端接口边界

这已经超出普通代码符号索引。

#### 3.2.6 前端工程有大量别名、插件和构建期能力

Vue 项目通常依赖：

- Vite / Webpack
- TypeScript path alias
- auto-import
- unplugin-vue-components
- JSX/TSX
- CSS modules
- 环境变量
- vite plugin

例如 `@/views/foo.vue` 的 `@` 需要从 `vite.config.ts` 或 `tsconfig.json` 解析。自动导入的组件甚至没有显式 import。

如果工具没有完整读取构建配置，就会出现：

- 文件路径解析不准
- 组件依赖漏掉
- 入口判断错误
- 模块边界识别不完整

### 3.3 为什么现在很多 codebase 工具都对前端，尤其是 Vue 支持不好

很多 codebase 工具的底层能力大致分几类：

| 类型 | 擅长 | 对 Vue 的问题 |
| --- | --- | --- |
| 文本检索/RAG | 找相似文件、总结上下文 | 容易召回片段，但不理解 template、路由、状态流 |
| AST/符号索引 | 识别类、函数、import、调用 | `.vue`、宏、template、动态 import 支持不足 |
| 调用图/依赖图 | 追踪函数调用、模块依赖 | 前端很多关系不是普通函数调用 |
| LSP/语言服务 | TypeScript 符号、跳转定义 | 需要额外接入 Vue language server 才能理解 SFC |
| 构建配置解析 | 理解 alias、插件、入口 | 前端配置高度项目化，难以通用 |

也就是说，Vue 的架构关系经常不是单纯的“代码调用关系”，而是：

```text
源码 + 模板 + 编译宏 + 路由配置 + 状态管理 + 构建配置 + 框架约定
```

这些信息分散在不同层面。工具只要缺一层，结论就容易变成：

- 只总结目录结构
- 只看 main/router/store 这些显眼入口
- 漏掉 template 中的组件关系
- 漏掉动态路由
- 漏掉 store 到 api 的真实业务流
- 把组件依赖和业务依赖混在一起

这也是为什么 agent 即使使用工具，面对 Vue 项目时也常常需要回到源码做大量人工式校验。

### 3.4 为什么 codegraph 索引通常比 GitNexus 快

从本轮测评现象看，codegraph 的索引通常更快。可以从工具目标和索引内容解释。

codegraph 更像是偏代码结构图的工具，核心任务通常是快速建立：

- 文件列表
- 符号
- import / dependency
- 调用关系
- 局部结构索引

这类索引通常更接近“代码结构扫描”，可以做到比较轻量：

```text
读文件 -> 解析语法/符号 -> 建图 -> 保存结构索引
```

GitNexus 更像是偏上下文理解和研发工作流增强的工具。它除了源码结构，往往还会尝试生成更适合 agent 使用的上下文层，例如：

- 仓库摘要
- 模块语义
- 文件/目录解释
- workflow 或 skill 上下文
- 可供问答使用的检索材料
- embeddings 或与 embeddings 相关的准备流程

即使本轮使用 `gitnexus analyze --drop-embeddings` 跳过或丢弃 embedding 相关内容，它的 analyze 仍可能包含更重的仓库理解流程。也就是说，GitNexus 的索引目标不只是“建结构图”，还可能包含“为 agent 准备语义上下文”。

所以两者速度差异可以理解为：

```text
codegraph：偏结构索引，轻量、直接、启动快
GitNexus：偏上下文/工作流分析，信息更厚，但 analyze 成本更高
```

这不代表 codegraph 在所有任务上更强，而是说明它在“快速建立代码结构索引”这件事上更经济。

### 3.5 为什么 codegraph 易用性更好

本轮测评里 codegraph 易用性更好，主要体现在：

- 命令更直接，索引动作更明确。
- 产物边界清楚，agent 容易知道什么时候能用。
- 查询目标更贴近架构识别：找入口、找依赖、找调用、看结构。
- 对 agent 来说，调用 codegraph 后更容易把结果映射回源码证据。

GitNexus 的能力更偏“综合型”，但这也带来一些使用成本：

- analyze 时间更长。
- 命令和参数更容易出错。
- agent 需要理解 GitNexus 产出的上下文到底代表什么。
- 如果索引失败或超时，后续 case 很容易受影响。
- 对实验隔离要求更高，否则 agent 容易把 GitNexus 上下文和其他工具结果混用。

可以简单理解：

```text
codegraph 像一个结构化代码地图；
GitNexus 像一个更大的代码理解工作台。
```

地图的优点是打开快、边界清楚、容易用；工作台的潜在能力更丰富，但要安装、分析、使用好，都更依赖流程和经验。

### 3.6 代码变化后为什么 codegraph 更容易自动索引

本轮观察中，代码变化后 codegraph 更容易自动索引或快速刷新。这也和它的索引模型有关。

结构图工具通常可以围绕文件和符号做增量更新：

```text
文件变更 -> 判断变更文件 -> 重新解析相关文件 -> 更新局部符号/依赖边 -> 刷新索引
```

如果工具维护了文件 hash、mtime 或 commit freshness，就可以快速判断：

- 哪些文件没变
- 哪些文件需要重扫
- 哪些依赖边可能变化
- 是否只需要局部刷新

因此 codegraph 这类工具天然更容易做自动刷新或增量索引。

GitNexus 如果 analyze 的目标包含更高层的语义上下文，就不一定能简单局部更新。原因是：

- 一个文件变化可能影响模块摘要。
- 模块摘要变化可能影响仓库摘要。
- workflow 或上下文材料可能要重新生成。
- 如果涉及 embedding 或语义索引，变更后的上下文一致性更难维护。

所以 GitNexus 更容易表现为：

```text
代码有变化 -> 需要重新 analyze 或刷新较大范围上下文
```

而 codegraph 更容易表现为：

```text
代码有变化 -> 检查 freshness -> 局部或快速重建结构索引
```

这也是为什么在频繁改代码的研发场景里，codegraph 的体感会更轻。

### 3.7 这对选型意味着什么

基于本轮测评和上述原理，可以得到一个相对稳妥的判断：

| 场景 | 更适合 |
| --- | --- |
| 快速理解代码结构、入口、模块依赖 | codegraph |
| 频繁代码变化、需要低成本刷新 | codegraph |
| Java 后端项目的结构识别 | codegraph 优先，GitNexus 可补充 |
| 需要更厚的上下文、工作流、项目说明 | GitNexus 可尝试 |
| Vue / 前端复杂项目 | 两者都需要谨慎，必须结合源码校验 |
| 大规模内网落地的第一步 | codegraph 更适合作为基础结构层 |
| 后续做 AI 开发助手产品 | 可以考虑 codegraph + GitNexus 组合，但要解决前端解析和隔离问题 |

### 3.8 对 Vue 支持的改进方向

如果后续希望这类工具更好支持 Vue，需要补的不是简单“多读几个文件”，而是更完整的前端架构解析能力：

1. 支持 Vue SFC parser，完整解析 `<template>`、`<script setup>`、`<style>`。
2. 接入 Vue language server 或等价能力，理解组件、props、emits、slots。
3. 解析 `vite.config.ts`、`tsconfig.json`、alias、auto import 插件。
4. 从 router 配置恢复页面入口和动态路由关系。
5. 从 Pinia/Vuex 恢复状态流和业务 action。
6. 从 template 中恢复组件树、事件流、props 数据流。
7. 区分 UI 组件依赖、业务模块依赖、接口依赖，不把它们混成一个 import 图。

做到这些之后，前端项目的架构识别才会从“目录总结”变成真正的“运行结构理解”。

### 3.9 一句话总结

这轮测评的价值不只是得出谁赢，而是把工具在真实内网代码仓中的能力边界跑出来了：

```text
codegraph 更适合作为快速、轻量、可刷新、结构化的代码地图；
GitNexus 更像语义更厚的代码理解工作台，但 analyze 成本和使用复杂度更高；
Vue 项目之所以表现一般，是因为前端架构关系大量藏在 template、路由、状态管理、编译宏和构建配置里，不是普通代码图或 RAG 能轻易吃透的。
```
