# codegraph 与 GitNexus 实操测评方案

## 0. 这份方案要做什么

这份方案用于在内网环境里，针对一批已经离线下载好的代码仓库，实操测评：

```text
Baseline vs codegraph vs GitNexus
```

目标不是一次性做完整学术 benchmark，而是快速回答：

1. 不使用工具时，内部 agent 仅靠普通源码阅读能做到什么程度。
2. 使用 `codegraph` 后，相对 Baseline 提升了什么。
3. 使用 `GitNexus` 后，相对 Baseline 提升了什么。
4. 两个工具分别在准确率、效率、响应时间、token、稳定性、证据质量上是否有实际收益。
5. 每个仓库单独出一份测评结果，最后再综合多个仓库比较。

执行者不需要熟悉仓库。评测依赖 agent 自动探索、证据绑定、交叉校验和可运行/可追溯事实。

## 1. 实验臂

本轮只测 3 个实验臂。

| 实验臂 | 允许能力 | 禁止能力 |
| --- | --- | --- |
| `Baseline` | 目录浏览、文件读取、文本搜索、项目原生 README/docs | 禁止使用 `.codegraph/`、`.gitnexus/`、工具报告、reference 目录 |
| `codegraph` | codegraph index、MCP/CLI 查询、必要源码校验 | 禁止使用 GitNexus 产物和 reference 目录 |
| `GitNexus` | GitNexus analyze、MCP/CLI 查询、augment/skills、必要源码校验 | 禁止使用 codegraph 产物和 reference 目录 |

可选扩展臂：

```text
GitNexus + codegraph
```

本轮先不默认启用组合臂。先把单工具收益测清楚，再决定是否测组合。

## 2. 总体流程

对每个仓库独立执行以下流程：

```text
1. 扫描仓库画像
2. 自动生成任务集
3. 构建轻量参考事实
4. 跑 Baseline
5. 跑 codegraph
6. 跑 GitNexus
7. 自动评分与证据校验
8. 输出单仓测评报告
```

跑完多个仓库后：

```text
9. 汇总所有单仓报告
10. 输出综合对比报告
```

推荐目录结构：

```text
benchmark-cg-gn/
  config/
    models.yaml
    tools.yaml
  repos/
    repos-manifest.yaml
  repo-results/
    <repo_id>/
      repo-profile.yaml
      tasks.yaml
      reference-facts.yaml
      runs/
        baseline/
        codegraph/
        gitnexus/
      scores.csv
      repo-report.md
  aggregate/
    all-scores.csv
    aggregate-report.md
```

## 3. 仓库输入

输入是一个源码仓库根目录，例如：

```text
/path/to/internal/repos
```

agent 扫描所有 git 仓库，生成：

```yaml
repos:
  - repo_id: repo_001
    name: example-service
    path: /absolute/path/to/example-service
    commit: abc123
    size_bucket: small | medium | large
    loc: 12000
    files: 180
    languages:
      - TypeScript
```

规模分层：

| 规模 | LOC | 文件数 | 本轮目的 |
| --- | ---: | ---: | --- |
| 小型 | 1k-10k | 20-200 | 看工具是否有额外成本，Baseline 是否已经够用 |
| 中型 | 10k-100k | 200-2,000 | 看工具对跨模块理解是否有收益 |
| 大型 | 100k+ | 2,000+ | 看工具是否明显节约探索成本和 token |

MVP 建议先选：

- 小仓 1 个
- 中仓 1 个
- 大仓 1 个

正式跑：

- 每个规模 3 个仓
- 总计 9 个仓

## 4. 每个仓自动生成任务

每个仓先由 `Profiler Agent` 生成仓库画像，不使用 codegraph 和 GitNexus。

画像示例：

```yaml
repo_id: repo_001
languages: [TypeScript]
frameworks: [Vue, Vite]
entrypoint_candidates:
  - src/main.ts
  - src/router/index.ts
module_candidates:
  - src/views
  - src/components
  - src/stores
  - src/api
test_commands:
  - pnpm test
  - pnpm lint
architecture_docs:
  - README.md
```

然后自动生成 6 个任务：

| 任务类型 | 数量 | 目的 |
| --- | ---: | --- |
| 宏观架构识别 | 2 | 测模块、分层、入口、职责 |
| 调用链/依赖分析 | 2 | 测跨文件、跨模块路径 |
| 变更影响分析 | 1 | 测影响范围和漏报误报 |
| onboarding/阅读顺序 | 1 | 测高层抽象和新人理解 |

`tasks.yaml` 示例：

```yaml
tasks:
  - task_id: T01
    type: macro_architecture
    difficulty: L3
    question: >
      请说明该仓库的整体架构、主要模块、分层关系、关键入口，以及这些模块如何协作。
    required_evidence:
      - file_path
      - symbol_or_config

  - task_id: T02
    type: call_chain
    difficulty: L3
    question: >
      从应用启动入口到主要页面/服务初始化，中间经过哪些关键模块和文件？
    anchor_files:
      - src/main.ts

  - task_id: T03
    type: dependency
    difficulty: L2
    question: >
      找出 API/数据访问层与业务/页面层之间的主要依赖关系，并说明依赖方向。

  - task_id: T04
    type: impact_analysis
    difficulty: L3
    question: >
      如果修改核心请求封装、配置加载或主入口文件，可能影响哪些模块？

  - task_id: T05
    type: onboarding
    difficulty: L3
    question: >
      新人理解这个仓库应该按什么顺序阅读？每一步应该看哪些文件？

  - task_id: T06
    type: architecture_risk
    difficulty: L4
    question: >
      这个仓库中最关键、最容易影响全局的模块或文件有哪些？为什么？
```

如果某仓不是前端项目，Task Builder Agent 应根据真实入口调整任务，不要强行使用 `src/main.ts`。

## 5. 轻量参考事实构建

执行者不熟悉仓库，所以不要求人工 ground truth。每个仓用自动方式构建 `reference-facts.yaml`。

来源：

1. 普通源码扫描：文件、目录、README、配置、测试。
2. 静态命令：`rg`、依赖清单、路由配置、入口配置。
3. 多 agent 独立分析：至少两个 reference agent 独立总结。
4. 可选工具互证：codegraph 和 GitNexus 的结果可作为参考来源，但正式 run 不能读取 reference。

事实格式：

```yaml
facts:
  - fact_id: F001
    type: entrypoint
    claim: src/main.ts 是前端应用启动入口
    evidence:
      - path: src/main.ts
      - path: package.json
        text: vite
    confidence: high

  - fact_id: F002
    type: dependency
    claim: 页面层通过 src/api 访问后端接口
    evidence:
      - path: src/views
      - path: src/api
      - command: rg "from .*api|@/api" src
    confidence: medium
```

评分只使用 `high` 和 `medium` 事实。`low` 和 `disputed` 事实只做定性分析。

## 6. 工具准备

### 6.1 Baseline

无需安装。只允许：

```text
ls/find/rg/sed/cat
文件读取
项目原生 README/docs/config/test
```

禁止读取：

```text
.codegraph/
.gitnexus/
benchmark-cg-gn/reference/
其他 arm 的 runs/
```

### 6.2 codegraph

每个仓执行：

```bash
cd <repo>
codegraph init -i
codegraph serve --mcp
```

记录：

```yaml
tool: codegraph
version: "<codegraph --version>"
index_time_seconds: 0
index_ok: true
artifact: .codegraph/
```

正式 run 中优先使用：

```text
codegraph_context
codegraph_search
codegraph_callers
codegraph_callees
codegraph_impact
codegraph_files
codegraph_status
```

### 6.3 GitNexus

每个仓执行：

```bash
cd <repo>
gitnexus analyze --skip-embeddings
gitnexus mcp
```

如果需要生成 skills：

```bash
gitnexus analyze --skills --skip-embeddings
```

记录：

```yaml
tool: gitnexus
version: "<gitnexus --version>"
index_time_seconds: 0
index_ok: true
artifact: .gitnexus/
```

正式 run 中优先使用：

```text
GitNexus MCP/CLI 查询
GitNexus 生成的上下文或 skills
GitNexus flow / risk / community / graph 相关能力
```

## 7. 标准 Prompt

### 7.1 Baseline Prompt

```text
你正在参与代码架构识别测评。当前实验臂是 Baseline。

限制：
- 只能使用普通源码阅读、目录浏览、文件读取、文本搜索。
- 可以读取仓库原生 README、docs、配置、测试。
- 禁止读取 .codegraph、.gitnexus、reference、其他实验臂结果。
- 不允许联网。

任务：
{{question}}

输出：
1. 结论摘要
2. 主要模块与职责
3. 关键入口、关键文件、关键符号
4. 调用链、依赖关系或影响范围
5. 证据：每个关键结论都要给文件路径或符号依据
6. 不确定点
```

### 7.2 codegraph Prompt

```text
你正在参与代码架构识别测评。当前实验臂是 codegraph。

限制：
- 必须优先使用 codegraph 查询代码结构、调用链、依赖关系和影响范围。
- 可以读取源码做必要校验。
- 禁止读取 .gitnexus、reference、其他实验臂结果。
- 不允许联网。

任务：
{{question}}

输出：
1. 结论摘要
2. codegraph 发现的主要模块、入口、调用链或影响范围
3. 源码校验结果
4. 工具相比普通源码阅读节省了哪些探索步骤
5. 证据：区分 codegraph 证据和源码证据
6. 不确定点
```

### 7.3 GitNexus Prompt

```text
你正在参与代码架构识别测评。当前实验臂是 GitNexus。

限制：
- 必须优先使用 GitNexus 的索引、MCP/CLI、上下文、skills 或 workflow 能力。
- 可以读取源码做必要校验。
- 禁止读取 .codegraph、reference、其他实验臂结果。
- 不允许联网。

任务：
{{question}}

输出：
1. 结论摘要
2. GitNexus 发现的主要模块、工作流、风险、调用关系或上下文
3. 源码校验结果
4. 工具相比普通源码阅读节省了哪些探索步骤
5. 证据：区分 GitNexus 证据和源码证据
6. 不确定点
```

## 8. 指标体系

每个任务满分 100。

| 指标 | 权重 | 说明 |
| --- | ---: | --- |
| 准确率 | 35 | 模块、入口、依赖、调用链、影响范围是否正确 |
| 证据质量 | 15 | 是否给出文件、符号、工具查询证据 |
| 架构抽象 | 15 | 是否能从文件上升到模块、分层、职责 |
| 幻觉控制 | 10 | 是否编造不存在的模块、调用链、文件 |
| 效率 | 10 | 文件读取、搜索、工具调用是否更少 |
| 响应时间 | 10 | 单任务 wall time 是否更短 |
| token 成本 | 5 | token 是否减少；拿不到真实 token 时用代理指标 |

建议记录原始指标：

```yaml
metrics:
  wall_time_seconds: 0
  index_time_seconds: 0
  answer_time_seconds: 0
  file_reads: 0
  search_calls: 0
  shell_calls: 0
  tool_calls: 0
  input_tokens: null
  output_tokens: null
  total_tokens: null
  answer_chars: 0
  evidence_count: 0
  hallucinated_claims: 0
  supported_claims: 0
```

如果内网 agent 拿不到 token：

| token 代理指标 | 解释 |
| --- | --- |
| 文件读取数 | 读文件越多，通常输入 token 越高 |
| grep/search 输出行数 | 搜索输出越多，token 越高 |
| tool 返回字符数 | MCP 结果越长，token 越高 |
| final answer 字符数 | 输出 token 近似 |
| 上下文轮次 | 多轮探索通常 token 更高 |

## 9. 评分方法

### 9.1 准确率评分

基于 `reference-facts.yaml` 和答案证据：

```text
fact_recall = 命中的 high/medium 参考事实数 / high/medium 参考事实总数
fact_precision = 被证据支持的答案事实数 / 答案提出的事实数
accuracy_score = 0.6 * fact_recall + 0.4 * fact_precision
```

### 9.2 效率评分

以 Baseline 为基准，同仓同任务比较：

```text
file_read_saving = (baseline_file_reads - arm_file_reads) / baseline_file_reads
search_saving = (baseline_search_calls - arm_search_calls) / baseline_search_calls
time_saving = (baseline_answer_time - arm_answer_time) / baseline_answer_time
```

如果某项 Baseline 为 0，则该项不参与平均。

### 9.3 token 节约

如果能拿到 token：

```text
token_saving = (baseline_total_tokens - arm_total_tokens) / baseline_total_tokens
```

如果拿不到 token：

```text
proxy_token_saving =
  0.4 * file_read_saving
+ 0.3 * search_output_saving
+ 0.2 * tool_output_saving
+ 0.1 * answer_length_saving
```

### 9.4 相对 Baseline 增益

每个工具都报告：

```text
quality_gain = tool_quality_score - baseline_quality_score
time_gain = baseline_time - tool_time
token_gain = baseline_tokens - tool_tokens
efficiency_gain = baseline_exploration_steps - tool_exploration_steps
```

不要只看总分。一个工具可能质量提升不大，但节约大量时间；也可能答案更好但成本更高。

## 10. 每个仓的报告模板

每扫一个仓，输出：

```text
repo-results/<repo_id>/repo-report.md
```

模板：

```markdown
# <repo_name> 测评报告

## 1. 仓库信息

- repo_id:
- path:
- commit:
- size_bucket:
- languages:
- files:
- loc:

## 2. 工具索引结果

| 工具 | 是否成功 | 索引耗时 | 产物 | 失败原因 |
| --- | --- | ---: | --- | --- |
| codegraph | | | `.codegraph/` | |
| GitNexus | | | `.gitnexus/` | |

## 3. 任务列表

| task_id | 类型 | 难度 | 问题 |
| --- | --- | --- | --- |

## 4. 总分对比

| 实验臂 | 平均质量分 | 平均耗时 | 平均文件读取 | 平均搜索次数 | 平均工具调用 | token/代理 token | 相对 Baseline 结论 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Baseline | | | | | | | 基线 |
| codegraph | | | | | | | |
| GitNexus | | | | | | | |

## 5. 分任务结果

| task_id | Baseline 分 | codegraph 分 | GitNexus 分 | codegraph 增益 | GitNexus 增益 | 备注 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |

## 6. 准确率观察

- Baseline:
- codegraph:
- GitNexus:

## 7. 效率与响应时间观察

- Baseline:
- codegraph:
- GitNexus:

## 8. token 或代理 token 观察

- Baseline:
- codegraph:
- GitNexus:

## 9. 典型成功案例

## 10. 典型失败或争议案例

## 11. 本仓结论

- 本仓最优方案：
- codegraph 是否值得：
- GitNexus 是否值得：
- 下一步建议：
```

## 11. 跨仓综合报告

所有仓跑完后，输出：

```text
benchmark-cg-gn/aggregate/aggregate-report.md
```

综合表：

| 规模 | 工具 | 平均质量增益 | 平均时间节约 | 平均文件读取节约 | 平均 token 节约 | 成功率 | 结论 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 小型 | codegraph | | | | | | |
| 小型 | GitNexus | | | | | | |
| 中型 | codegraph | | | | | | |
| 中型 | GitNexus | | | | | | |
| 大型 | codegraph | | | | | | |
| 大型 | GitNexus | | | | | | |

最终回答：

1. `codegraph` 是否在大多数仓库上提高准确率。
2. `codegraph` 是否节省响应时间和探索 token。
3. `GitNexus` 是否在模块理解、workflow、风险识别上更强。
4. `GitNexus` 的额外索引和维护成本是否值得。
5. 小/中/大型仓库是否有不同结论。

## 12. 推荐判定规则

### 12.1 选择 codegraph 的条件

如果出现以下结果，优先选 `codegraph`：

- 调用链、依赖关系、影响分析任务增益明显。
- 大仓库文件读取数明显下降。
- 响应时间下降或稳定。
- 幻觉率下降。
- 索引成功率高，维护成本低。

### 12.2 选择 GitNexus 的条件

如果出现以下结果，优先选 `GitNexus`：

- onboarding、模块上下文、workflow、风险分析任务明显更好。
- agent 更快理解业务区域。
- 生成的 skills/context 对后续开发任务有帮助。
- PR review 或风险识别效果明显优于 codegraph。

### 12.3 暂不组合的条件

如果单独 `codegraph` 或单独 `GitNexus` 已经足够好，且组合复杂度高，暂不组合。

组合只在以下情况下继续评测：

- `codegraph` 结构事实强，但产品 workflow 不足。
- `GitNexus` 工作流强，但事实校验不够稳。
- 两者互补带来的质量增益超过额外安装、索引、维护成本。

## 13. 给执行 agent 的总提示词

```text
你要执行 codegraph 与 GitNexus 的实操测评。

输入：
- 离线源码仓库根目录：{{repos_root}}
- benchmark 输出目录：{{output_dir}}
- 内网 agent 当前模型：{{model_id}}
- 可用工具：Baseline、codegraph、GitNexus

请按以下流程执行：

1. 扫描 repos_root 下所有 git 仓库，生成 repos-manifest.yaml。
2. 按 small/medium/large 分层，优先每层选择 1 个仓做 MVP。
3. 对每个仓生成 repo-profile.yaml，不使用 codegraph 或 GitNexus。
4. 对每个仓生成 6 个任务：宏观架构 2 个，调用链/依赖 2 个，影响分析 1 个，onboarding 1 个。
5. 构建 reference-facts.yaml。所有参考事实必须有文件、配置、命令或多 agent 一致性证据。
6. 对每个任务分别运行 Baseline、codegraph、GitNexus。
7. Baseline 禁止读取 .codegraph、.gitnexus、reference、其他实验臂结果。
8. codegraph 组必须优先使用 codegraph 查询，再用源码校验。
9. GitNexus 组必须优先使用 GitNexus 查询、上下文或 skills，再用源码校验。
10. 记录每次 run 的耗时、文件读取数、搜索次数、工具调用数、token 或代理 token。
11. 根据 reference-facts 和答案证据评分。
12. 每个仓输出 repo-report.md。
13. 多仓完成后输出 aggregate-report.md。

判断重点：
- 相对 Baseline，工具是否提高准确率。
- 是否减少文件读取、搜索、探索步骤。
- 是否缩短响应时间。
- 是否节约 token 或代理 token。
- 是否降低幻觉并提高证据质量。
```

