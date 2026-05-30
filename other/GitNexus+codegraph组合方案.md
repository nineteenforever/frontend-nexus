# GitNexus + codegraph 组合方案

## 0. 结论先行

如果你要做一个**面向 AI 开发助手的产品**，同时又看中了 `GitNexus` 和 `codegraph`，最关键的结论是：

**不要把它们当成两套并列主系统一起上。**

正确的用法不是：

- 两边都全量建索引
- 两边都对 agent 暴露一整套工具
- 让 agent 自己决定问谁

而应该是：

- **只保留一个“主图谱系统”**
- 另一个提供**产品层、工作流层、体验层**能力

我最推荐的组合方式是：

### 推荐路线

- `codegraph` 做底层代码图谱引擎
- 借鉴 `GitNexus` 做 agent 工作流增强层

也就是：

`codegraph = 引擎`

`GitNexus = 产品层设计蓝本`

如果你一定要两者都接入运行，也应该做成：

- `codegraph` 是主查询源
- `GitNexus` 只承担搜索增强、workflow、skills、benchmark 这一层

而不是“双核心”。

## 1. 为什么两者可以组合

### 1.1 表面看起来重合

它们都在做这些事：

- 解析源码
- 构建代码关系图
- 提供给 AI 调用的工具接口
- 帮 AI 做架构理解、调用链追踪、影响分析
- 尝试把大仓库压缩成可消费上下文

所以从表面上看，它们确实有明显重合。

### 1.2 但本质上不是一层

如果按系统分层看，它们更像是不同层面的强化：

#### `codegraph` 更偏底层基础设施

- 把代码转成稳定、确定、可持续同步的知识图谱
- 重点解决“图谱怎么建、怎么保持新鲜、怎么稳定查询”
- 重点能力是 `context / trace / explore / impact / sync`

#### `GitNexus` 更偏 agent 产品层

- 重点不只是“图谱存在”，而是“agent 怎么在真实开发流程里用上图谱”
- 强调：
  - `augment/hook`
  - impact workflow
  - repo-specific skills
  - AI context 注入
  - eval / benchmark

所以它们的关系更适合理解成：

- `codegraph` 解决“底层结构真相”
- `GitNexus` 解决“agent 怎么高效消费这些结构真相”

## 2. 它们各自最有价值的部分

### 2.1 codegraph 最值得拿来用的部分

- 确定性 AST 图谱构建
- framework-aware 关系补边
- dynamic-dispatch 补边
- 自动增量同步
- pending/stale 检测
- 架构导向查询接口：`trace/context/explore/impact`

一句话：

**它最适合做系统里的“唯一真相来源”。**

### 2.2 GitNexus 最值得借鉴的部分

- `augment/hook`：对普通搜索结果自动补结构上下文
- impact/risk workflow：改代码前先做 blast radius 分析
- repo-specific skills：按模块生成定向 agent 使用说明
- agent context 文件：把图谱翻译成 agent 更易消费的规则
- eval harness：严肃 benchmark 体系

一句话：

**它最适合做“让 agent 真正会用图谱”的产品层。**

## 3. 为什么不能把两者平铺接入

如果你把它们当两套并列主系统使用，会出现 5 个问题。

### 3.1 查询路由混乱

agent 不知道：

- 查调用链该问谁
- 做 impact 该问谁
- 搜索增强该问谁

最终不是提升能力，而是增加决策负担。

### 3.2 结果口径不一致

两边都可能回答：

- 谁调用了谁
- 哪些模块相关
- 某处改动影响什么

但由于抽取策略不同，答案不一定完全一致。

一旦口径不一致，agent 和用户都会困惑。

### 3.3 维护成本翻倍

同一个仓库：

- 维护两套索引
- 维护两套增量机制
- 维护两套新鲜度判断
- 维护两套工具协议

这在产品早期非常不划算。

### 3.4 Benchmark 难以归因

如果产品效果变好，你很难回答：

- 是 `codegraph` 的底层图更准
- 还是 `GitNexus` 的 workflow 更好
- 还是两边叠加出来的偶然效果

这会让后续优化方向失焦。

### 3.5 Agent 使用体验反而变差

能力太多不等于体验更好。

对 agent 来说，更好的体验通常是：

- 少量高价值工具
- 清晰的调用顺序
- 稳定的结果口径

而不是十几个功能相近的按钮。

## 4. 正确的组合原则

### 4.1 只保留一个主图谱

必须有且只有一个系统负责：

- 代码结构抽取
- 关系图更新
- freshness 判断
- 架构级查询结果

这个系统我建议是 `codegraph`。

### 4.2 另一个只负责“增强 AI 使用方式”

借鉴 `GitNexus` 的价值，不一定意味着要把它整套索引系统也搬进来。

更合理的是复用它的方法论：

- 自动上下文增强
- impact workflow
- repo skill 生成
- benchmark 体系

### 4.3 对 agent 暴露的是统一接口，而不是两个后端

最终让 agent 感知到的应该是一组统一能力，比如：

- `repo_search_enriched`
- `repo_trace`
- `repo_context`
- `repo_impact`
- `repo_module_guide`

而不是：

- `gitnexus_query`
- `gitnexus_context`
- `codegraph_context`
- `codegraph_trace`
- `codegraph_impact`

让 agent 直接面对两个后端，是产品设计失败。

## 5. 推荐的最终架构

## 5.1 架构总图

```text
IDE / Agent / Chat UI
        |
        v
Agent Orchestration Layer
  - prompt policy
  - tool routing
  - search augmentation
  - risk workflow
  - module skills
        |
        v
Unified Intelligence API
  - search_enriched
  - trace
  - context
  - impact
  - guide
        |
        v
CodeGraph Engine
  - indexing
  - sync
  - staleness
  - graph query
```

### 5.2 分层职责

#### 第一层：`codegraph` 底座

负责：

- 建索引
- 自动增量同步
- 图关系查询
- 高可信调用链
- 影响分析基础数据

#### 第二层：GitNexus 风格的 orchestration 层

负责：

- augment/hook
- workflow
- skill generation
- context packaging
- benchmark/eval

#### 第三层：用户交互层

负责：

- IDE 插件
- MCP server
- Chat 界面
- 可视化面板

## 6. 两者一起时，具体该怎么用

这里给一个最实用的落地方式。

### 6.1 仓库首次接入

流程：

1. 用户克隆仓库
2. 系统初始化 `codegraph` 索引
3. orchestration 层扫描仓库，生成：
   - 模块技能文件
   - 仓库 guide
   - 常见 workflow 模板
4. agent 以后不直接面对原始文件系统，而是优先面对统一工具接口

### 6.2 用户日常搜索代码

不要只给 agent 普通 grep。

正确做法：

1. 用户或 agent 发起搜索
2. orchestration 层先做文本检索
3. 根据命中符号，调用 `codegraph` 查询：
   - callers
   - callees
   - trace
   - process/impact
4. 把这些结构信息包装成“增强搜索结果”
5. 再交给 agent

这就是借鉴 GitNexus 的 `augment/hook` 思路，但底层数据来自 `codegraph`。

### 6.3 用户问“这个模块怎么工作”

建议路由：

1. 先调用 `context`
2. 如问题涉及跨模块流转，再调用 `trace`
3. orchestration 层把结果包装成：
   - 模块职责
   - 上下游依赖
   - 关键入口
   - 推荐阅读顺序

这里不需要两套系统同时回答。

### 6.4 用户要改代码前做影响分析

借鉴 GitNexus 的 workflow，但查询由 `codegraph` 提供。

流程：

1. 用户选中函数/类/文件
2. 调用 `impact`
3. orchestration 层汇总：
   - 直接调用者
   - 关键路径
   - 高风险模块
   - 建议验证点
4. 若风险高，agent 必须先向用户解释 blast radius

### 6.5 用户做 onboarding

这时不要直接扔图给用户。

而应该用 GitNexus 风格的 skills/guide 输出：

- 先看哪些目录
- 哪些模块是核心
- 哪些链路最关键
- 哪些文件最适合作为入口

底层仍然可来自 `codegraph context + trace + explore`。

## 7. 功能边界怎么切

最简单实用的切法如下。

| 能力 | 主负责方 | 说明 |
| --- | --- | --- |
| 代码索引 | codegraph | 唯一主索引 |
| 增量同步 | codegraph | watcher + sync |
| freshness 判断 | codegraph | pending/stale |
| 调用链查询 | codegraph | `trace` 主导 |
| 影响分析基础数据 | codegraph | `impact` 主导 |
| 搜索结果增强 | GitNexus 方法论层 | 借鉴 augment/hook |
| repo/module skills | GitNexus 方法论层 | 借鉴 `--skills` 思路 |
| 风险提示 workflow | GitNexus 方法论层 | 改动前分析 |
| benchmark/eval | GitNexus 方法论层 | 借鉴 eval harness |
| IDE/agent 产品体验 | 自研统一层 | 不直接暴露双后端 |

## 8. 查询路由怎么设计

给你一个可以直接落地的路由规则。

### 8.1 路由原则

- 结构问题，优先 `codegraph`
- 搜索增强，走 orchestration 层
- 解释和工作流，走产品层

### 8.2 路由表

| 用户意图 | 路由 |
| --- | --- |
| “这个函数被谁调用” | `codegraph.trace` / callers |
| “改这个会影响什么” | `codegraph.impact` + 风险汇总 |
| “这个模块怎么工作” | `codegraph.context` + 产品层解释 |
| “帮我搜 auth 相关逻辑” | 文本搜索 + augment |
| “新人应该先看哪里” | module guide / repo skills |
| “这个仓库怎么分层” | `context + trace + guide` 组合输出 |

### 8.3 不要做的事

- 不要同一问题同时问两个后端再做投票
- 不要让 agent 自己决定到底调 `GitNexus` 还是 `codegraph`
- 不要把后端名字暴露给最终用户

## 9. 增量更新策略怎么设计

如果两者一起做产品，更新策略一定要统一。

### 9.1 唯一真相

主索引的新鲜度由 `codegraph` 负责。

原因：

- watcher 更完整
- auto-sync 更成熟
- pending/staleness 设计更适合 agent 场景

### 9.2 上层产物怎么更新

上层 GitNexus 风格产物建议分成两类：

#### 轻量产物

- augment 所需缓存
- module summary
- repo skill 卡片

更新方式：

- 在 `codegraph` 成功 sync 后异步刷新
- 不要求每次保存都强一致

#### 重量产物

- onboarding guide
- 模块地图
- 风险画像
- 周期性 wiki / 架构文档

更新方式：

- 周期性批处理
- 或在用户显式触发时生成

### 9.3 一个重要原则

**不要把所有高层产物都做成每次保存后立即重算。**

否则你会得到：

- 高成本
- 高抖动
- 难以解释的结果变化

正确做法是：

- 底层图实时
- 上层总结准实时或按需

## 10. benchmark 该怎么做

如果你做的是“GitNexus 风格产品层 + codegraph 底座”，benchmark 应该拆成 3 组，而不是 2 组。

### 10.1 三层对照

#### A 组：Baseline

- 不用任何专门图谱工具
- 只允许目录浏览、搜索、读文件

#### B 组：CodeGraph Only

- 允许 `context/trace/impact`
- 不加 augment/hook
- 不加 workflow
- 不加 module skills

#### C 组：CodeGraph + GitNexus-style Product Layer

- 有 `codegraph` 底层能力
- 再加：
  - augment/hook
  - repo skills
  - 风险 workflow
  - guide/context packaging

这样你才能真正回答两个问题：

1. 图谱底层本身有没有价值？
2. 产品层增强是否进一步提升 agent 表现？

### 10.2 你要评测的不是“两个名字”

而是三件事：

- 图谱有没有用
- 自动增强有没有用
- workflow 设计有没有用

### 10.3 建议指标

- 架构识别准确率
- 调用链恢复质量
- 影响分析质量
- 单任务耗时
- token 成本
- 平均读文件数
- 工具调用次数
- 用户/评审主观满意度

## 11. 最小可行产品建议

如果你现在就想做 `MVP`，不要一开始就做全套。

### 11.1 MVP 版本应该只做 4 个能力

1. `search_enriched`
2. `trace`
3. `impact`
4. `module_guide`

### 11.2 MVP 的实现方式

- `trace`、`impact` 直接走 `codegraph`
- `search_enriched` 用 GitNexus 的 augment/hook 思路包装
- `module_guide` 用定时任务或显式命令生成

### 11.3 MVP 不要先做的东西

- 不要一开始做双图谱并存
- 不要一开始做太多 UI
- 不要一开始做十几个 MCP 工具
- 不要一开始做多模型适配

先把“agent 用这 4 个能力是否明显比 baseline 强”证明出来。

## 12. 我建议你的落地顺序

### 第一阶段：研究底座

重点看 `codegraph`：

- 索引流程
- sync 流程
- trace/context/impact 接口
- watcher/staleness 机制

目标：

- 让它成为你的唯一主图谱系统

### 第二阶段：研究产品层

重点看 `GitNexus`：

- `augment/hook`
- impact workflow
- repo-specific skills
- eval harness

目标：

- 不照搬全系统
- 只提炼对 agent 产品真正有价值的部分

### 第三阶段：做统一接口

先抽象成 4 到 6 个能力接口，不暴露底层来源。

### 第四阶段：做 benchmark

验证：

- 只有图谱层的效果
- 图谱 + 产品层的效果

## 13. 最终建议

如果你问我一句话建议，那就是：

**不要把 GitNexus 和 codegraph 当成两个并列工具堆在一起，而要把 `codegraph` 当底层，把 `GitNexus` 当产品设计参考系。**

换句话说：

- `codegraph` 给你“结构真相”
- `GitNexus` 教你“怎么让 agent 真正用好这些结构真相”

这才是这两个项目一起研究时，最有价值、也最可落地的组合方式。
