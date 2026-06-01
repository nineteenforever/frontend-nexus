# codegraph 与 GitNexus 单仓 Agent 执行手册

## 0. 使用方式

这份文档是给内部 agent 直接执行的单仓测评手册。

使用场景：

```text
agent 打开一个代码仓库
agent 引用本 md
agent 按步骤自动完成 Baseline / codegraph / GitNexus 三臂测评
agent 输出当前仓库的一份测评报告
```

前提：

- `codegraph` 已安装成功。
- `GitNexus` 已安装成功。
- `codegraph MCP` 可用。
- `GitNexus MCP` 可用。
- 当前 agent 能执行 shell、读取文件、搜索文本、调用 MCP 工具。
- 当前仓库源码已经在内网，不需要联网。

本手册只测当前打开的这个仓库，不负责跨仓汇总。多人分别测多个仓库后，再把各自报告合并即可。

## 1. Agent 总任务

你是测评执行 agent。请在当前仓库中完成：

```text
Baseline vs codegraph vs GitNexus
```

你需要回答：

1. 当前仓库是什么项目，主要语言是什么。
2. 仓库有多少文件、多少代码行。
3. 不用工具时，你理解架构需要多少探索成本。
4. 使用 `codegraph` 后，准确率、效率、响应时间、tool calls、token 或代理 token 是否改善。
5. 使用 `GitNexus` 后，准确率、效率、响应时间、tool calls、token 或代理 token 是否改善。
6. 两个工具的首次索引成本是多少，代码变更或拉取新代码后的刷新成本是多少。
7. 本仓库上更适合用 `codegraph`、`GitNexus`，还是暂时 Baseline 已足够。

最终输出：

```text
benchmark-cg-gn/<repo_name>/repo-report.md
```

同时保存中间产物，便于复核。

## 2. 输出目录

在当前仓库根目录下创建：

```text
benchmark-cg-gn/
  repo-profile.yaml
  tasks.yaml
  reference-facts.yaml
  index-metrics.yaml
  runs/
    baseline/
      T01/
      T02/
      T03/
      T04/
      T05/
      T06/
    codegraph/
      T01/
      T02/
      T03/
      T04/
      T05/
      T06/
    gitnexus/
      T01/
      T02/
      T03/
      T04/
      T05/
      T06/
  scores.csv
  repo-report.md
```

每个任务目录至少包含：

```text
prompt.txt
answer.md
metrics.yaml
tool-log.md
```

如果 agent 无法直接写文件，也必须在最终回答中完整输出这些内容。

## 3. 第一步：识别仓库基础信息

先不要使用 `codegraph` 或 `GitNexus`。只用普通 shell、文件读取、文本搜索。

必须采集：

```yaml
repo:
  name:
  path:
  commit:
  branch:
  dirty:
  project_type: java | vue | go | python | node | other
  languages:
    - string
  frameworks:
    - string
  package_or_build_tool:
    - maven | gradle | pnpm | npm | yarn | go_mod | pip | other
  total_files:
  source_files:
  total_lines:
  source_lines:
  size_bucket: small | medium | large
```

建议命令：

```bash
pwd
basename "$(pwd)"
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
git status --short
rg --files
```

文件数统计建议：

```bash
rg --files | wc -l
```

代码行数统计建议优先使用可用工具：

```bash
cloc .
```

如果没有 `cloc`，使用：

```bash
rg --files -g '!node_modules' -g '!dist' -g '!build' -g '!target' -g '!coverage' \
  | rg '\.(java|kt|go|ts|tsx|js|jsx|vue|py|rs|cs|php|rb|scala|xml|yaml|yml|json)$' \
  | xargs wc -l
```

如果命令不可用，agent 自行用 `rg --files` 和文件扩展名估算，但必须标记为估算。

规模分层：

| size_bucket | source_lines | source_files |
| --- | ---: | ---: |
| small | 1k-10k | 20-200 |
| medium | 10k-100k | 200-2,000 |
| large | 100k+ | 2,000+ |

输出到：

```text
benchmark-cg-gn/repo-profile.yaml
```

## 4. 第二步：自动生成 6 个测评任务

根据当前仓库类型自动生成任务，不要套死前端或 Java 模板。

必须生成 6 个任务：

| task_id | 类型 | 目的 |
| --- | --- | --- |
| T01 | macro_architecture | 整体架构、模块、分层、入口 |
| T02 | entry_flow | 从主入口到核心运行流程 |
| T03 | dependency | 关键模块之间的依赖方向 |
| T04 | impact_analysis | 修改核心文件/接口的影响范围 |
| T05 | onboarding | 新人阅读顺序 |
| T06 | architecture_risk | 最关键、最容易影响全局的模块 |

Java 项目可优先围绕：

- controller
- service
- repository/mapper/dao
- config
- application main
- pom.xml / build.gradle

Vue 项目可优先围绕：

- main.ts / main.js
- router
- views/pages
- components
- store/pinia/vuex
- api/request
- vite.config

Go 项目可优先围绕：

- main.go
- cmd/
- internal/
- pkg/
- router/handler/service/repository
- go.mod

任务格式：

```yaml
tasks:
  - task_id: T01
    type: macro_architecture
    question: >
      请说明当前仓库的整体架构、主要模块、分层关系、关键入口，以及这些模块如何协作。
    required_output:
      - modules
      - responsibilities
      - entrypoints
      - dependencies
      - evidence
```

输出到：

```text
benchmark-cg-gn/tasks.yaml
```

## 5. 第三步：构建轻量参考事实

参考事实用于评分，不要求人熟悉仓库，但每条事实必须有证据。

构建方式：

1. 普通源码扫描。
2. README/docs/config/build/test 文件。
3. `rg` 搜索。
4. package/build 配置。
5. 可选：使用 codegraph 和 GitNexus 辅助构建参考事实，但正式三臂 run 不能读取 reference-facts。

至少生成 20 条 `high` 或 `medium` 事实。

事实类型必须覆盖：

- entrypoint
- module
- dependency
- call_or_data_flow
- impact_candidate
- architecture_risk

格式：

```yaml
facts:
  - fact_id: F001
    type: entrypoint
    claim: string
    evidence:
      - path: string
      - command: string
    confidence: high | medium | low | disputed
```

输出到：

```text
benchmark-cg-gn/reference-facts.yaml
```

正式运行 `Baseline`、`codegraph`、`GitNexus` 三臂时，不允许读取 `reference-facts.yaml`。

## 6. 第四步：准备工具索引

### 6.1 codegraph

执行：

```bash
codegraph --version
codegraph init -i
```

记录：

```yaml
codegraph:
  version:
  index_ok:
  index_time_seconds:
  artifact: .codegraph/
  error:
```

如果 `.codegraph/` 已存在，仍要记录状态，并尽量执行 freshness/status 检查。

### 6.2 GitNexus

执行：

```bash
gitnexus --version
gitnexus analyze --skip-embeddings
```

记录：

```yaml
gitnexus:
  version:
  index_ok:
  index_time_seconds:
  artifact: .gitnexus/
  error:
```

如果项目很大导致 analyze 失败，可尝试：

```bash
gitnexus analyze --skip-embeddings --worker-timeout 60
```

工具失败不能跳过，必须写入报告。

### 6.3 索引耗时记录口径

索引时间必须单独记录到：

```text
benchmark-cg-gn/index-metrics.yaml
```

建议结构：

```yaml
repo:
  name:
  commit:
  source_files:
  source_lines:
  total_files:
  total_lines:
index_runs:
  - tool: codegraph | gitnexus
    scenario: cold_index | no_change_refresh | after_code_change | after_git_pull
    command:
    version:
    start_time:
    end_time:
    duration_seconds:
    success:
    artifact:
    changed_files_count:
    changed_lines_added:
    changed_lines_deleted:
    before_commit:
    after_commit:
    notes:
```

记录口径：

- `cold_index`：当前仓库首次建立索引，或删除旧索引产物后重新索引。
- `no_change_refresh`：源码没有变化时，再执行一次工具推荐的刷新、status、update 或 analyze 命令，记录它判断无需更新或重新扫描的成本。
- `after_code_change`：本地改动少量代码后，重新刷新索引，记录成本。建议只做非业务语义的临时小改动，例如新增一行注释；测完后还原这次临时改动。
- `after_git_pull`：如果本次测评前后确实执行了 `git pull` 或切换到更新 commit，需要记录拉取前后 commit、变更文件数和刷新索引耗时。不要为了测这个场景强行联网或拉代码。

注意：

- 单任务 `answer_time_seconds` 不包含索引时间。
- 报告中必须同时展示“不含索引的回答收益”和“计入首次索引后的端到端收益”。
- 如果工具没有明确的增量索引命令，就按工具文档或 CLI help 能力尝试 `status`、`update`、`refresh`、`analyze` 等命令；找不到增量能力时，记录为“全量重建/全量 analyze”。
- 如果 `.codegraph/` 或 `.gitnexus/` 已存在，不能直接复用而不记录。必须说明索引是否新鲜、对应 commit 是否匹配，以及刷新检查用了多久。

### 6.4 代码变更后是否需要重新索引

执行时按下面规则判断：

| 场景 | GitNexus | codegraph | 必须记录 |
| --- | --- | --- | --- |
| 只是问当前已索引 commit 的架构问题 | 可直接使用现有分析结果，但要确认 commit 匹配 | 可直接使用现有索引，但要确认 freshness | 当前索引 commit、检查耗时 |
| 本地改了代码但未刷新索引 | 不得把旧分析当作最新事实；需要重新 `analyze` 或执行增量刷新 | 不得把旧索引当作最新事实；需要重新 init/update/refresh | 变更文件数、刷新耗时、是否增量 |
| `git pull` 后 commit 变化 | 需要重新分析或刷新，否则结果只代表旧 commit | 需要重新索引或刷新，否则结果只代表旧 commit | pull 前后 commit、变更规模、刷新耗时 |
| 工具不支持增量 | 记录为全量 analyze 成本 | 记录为全量索引成本 | 全量耗时、失败原因 |

结论要分开写：

- `GitNexus` 是否需要重新 analyze：只要代码变更会影响架构事实，就需要刷新；如果没有增量能力或 agent 无法确认增量能力，就按重新 `gitnexus analyze --skip-embeddings` 记录。
- `codegraph` 是否需要重新索引：只要代码变更会影响符号、调用、依赖、入口等结构事实，就需要刷新；如果无法确认增量能力，就按重新 `codegraph init -i` 记录。
- 是否值得使用工具，不能只看回答阶段快不快，还要看索引成本能否被多轮问题摊薄。

## 7. 第五步：执行三臂测评

对每个任务分别跑：

```text
Baseline
codegraph
GitNexus
```

每个 arm 的答案必须独立生成，禁止读取其他 arm 的答案。

### 7.1 Baseline 规则

允许：

- 目录浏览
- 文件读取
- `rg`
- README/docs/config/test

禁止：

- `.codegraph/`
- `.gitnexus/`
- `benchmark-cg-gn/reference-facts.yaml`
- `benchmark-cg-gn/runs/codegraph/`
- `benchmark-cg-gn/runs/gitnexus/`

Baseline prompt：

```text
你正在执行当前仓库的代码架构识别测评，实验臂是 Baseline。

限制：
- 只能使用普通源码阅读、目录浏览、文件读取、文本搜索。
- 禁止使用 codegraph、GitNexus、reference-facts、其他实验臂结果。
- 不允许联网。

任务：
{{task_question}}

请输出：
1. 结论摘要
2. 主要模块与职责
3. 关键入口、关键文件、关键符号
4. 调用链、依赖关系或影响范围
5. 证据：每个关键结论都要给文件路径或符号依据
6. 不确定点
```

### 7.2 codegraph 规则

允许：

- codegraph MCP/CLI
- 源码校验

禁止：

- `.gitnexus/`
- `benchmark-cg-gn/reference-facts.yaml`
- `benchmark-cg-gn/runs/baseline/`
- `benchmark-cg-gn/runs/gitnexus/`

codegraph prompt：

```text
你正在执行当前仓库的代码架构识别测评，实验臂是 codegraph。

限制：
- 必须优先使用 codegraph 查询结构、入口、调用链、依赖关系或影响范围。
- 可以读取源码做必要校验。
- 禁止使用 GitNexus、reference-facts、其他实验臂结果。
- 不允许联网。

任务：
{{task_question}}

请输出：
1. 结论摘要
2. codegraph 发现了什么
3. 源码校验结果
4. 相比普通源码阅读，codegraph 节省了哪些探索步骤
5. 证据：区分 codegraph 证据和源码证据
6. 不确定点
```

### 7.3 GitNexus 规则

允许：

- GitNexus MCP/CLI
- GitNexus context/skills/augment
- 源码校验

禁止：

- `.codegraph/`
- `benchmark-cg-gn/reference-facts.yaml`
- `benchmark-cg-gn/runs/baseline/`
- `benchmark-cg-gn/runs/codegraph/`

GitNexus prompt：

```text
你正在执行当前仓库的代码架构识别测评，实验臂是 GitNexus。

限制：
- 必须优先使用 GitNexus 的索引、MCP/CLI、上下文、skills 或 workflow 能力。
- 可以读取源码做必要校验。
- 禁止使用 codegraph、reference-facts、其他实验臂结果。
- 不允许联网。

任务：
{{task_question}}

请输出：
1. 结论摘要
2. GitNexus 发现了什么
3. 源码校验结果
4. 相比普通源码阅读，GitNexus 节省了哪些探索步骤
5. 证据：区分 GitNexus 证据和源码证据
6. 不确定点
```

## 8. 第六步：记录指标

每个任务、每个 arm 记录：

```yaml
arm:
task_id:
answer_time_seconds:
file_reads:
search_calls:
shell_calls:
tool_calls:
input_tokens:
output_tokens:
total_tokens:
token_available: true | false
answer_chars:
supported_claims:
unsupported_claims:
hallucinated_claims:
evidence_count:
notes:
```

如果 agent 无法拿到真实 token：

```yaml
token_available: false
proxy_token_metrics:
  file_reads:
  search_calls:
  search_output_lines:
  tool_calls:
  tool_output_chars:
  answer_chars:
```

说明：

- `file_reads`：读取源码文件次数。
- `search_calls`：`rg`、grep、搜索工具调用次数。
- `tool_calls`：MCP 或专用工具调用次数。
- `answer_time_seconds`：从开始执行当前任务到输出答案的 wall time，不含索引时间。
- `index_time_seconds`：只记录在工具索引结果中，不混入单任务响应时间。
- `end_to_end_time_seconds`：如需评估单次使用成本，按 `index_time_seconds + answer_time_seconds` 另算，不替代回答阶段耗时。

## 9. 第七步：评分

基于 `reference-facts.yaml` 和各 arm 的答案评分。

每个任务满分 100：

| 指标 | 权重 |
| --- | ---: |
| 准确率 | 35 |
| 证据质量 | 15 |
| 架构抽象 | 15 |
| 幻觉控制 | 10 |
| 效率 | 10 |
| 响应时间 | 10 |
| token 或代理 token | 5 |

相对 Baseline 计算：

```text
quality_gain = tool_quality_score - baseline_quality_score
time_saving = (baseline_time - tool_time) / baseline_time
file_read_saving = (baseline_file_reads - tool_file_reads) / baseline_file_reads
search_saving = (baseline_search_calls - tool_search_calls) / baseline_search_calls
tool_call_saving = (baseline_tool_calls - tool_tool_calls) / baseline_tool_calls
token_saving = (baseline_tokens - tool_tokens) / baseline_tokens
amortized_time_per_task = (index_time_seconds + sum(answer_time_seconds)) / task_count
```

注意：

- 如果 Baseline 某项为 0，该项不计算百分比，报告中写 `N/A`。
- `tool_call_saving` 不一定总是正数。工具组可能 tool calls 更多，但文件读取和 token 更少。报告必须解释这是收益还是成本转移。
- `index_time_seconds` 要单独评价。冷启动索引很慢但多轮任务节省明显时，要计算摊销后平均耗时；单次问题场景则要看端到端耗时。
- 不要只看平均分，也要看典型成功/失败案例。

输出：

```text
benchmark-cg-gn/scores.csv
```

建议列：

```csv
repo_name,project_type,languages,task_id,arm,quality_score,accuracy_score,evidence_score,abstraction_score,hallucination_score,efficiency_score,time_score,token_score,answer_time_seconds,file_reads,search_calls,tool_calls,total_tokens,proxy_token_score
```

## 10. 第八步：输出单仓报告

输出：

```text
benchmark-cg-gn/repo-report.md
```

报告必须包含以下模板。

```markdown
# <repo_name> codegraph 与 GitNexus 单仓测评报告

## 1. 仓库信息

| 字段 | 值 |
| --- | --- |
| 仓库名 | |
| 仓库路径 | |
| 分支 | |
| commit | |
| 工作区是否干净 | |
| 项目类型 | Java / Vue / Go / Python / Node / Other |
| 主要语言 | |
| 框架 | |
| 构建/包管理工具 | |
| 总文件数 | |
| 源码文件数 | |
| 总行数 | |
| 源码行数 | |
| 规模分层 | small / medium / large |

## 2. 工具索引结果

| 工具 | 版本 | 是否成功 | 索引耗时 | 产物 | 失败原因 |
| --- | --- | --- | ---: | --- | --- |
| codegraph | | | | `.codegraph/` | |
| GitNexus | | | | `.gitnexus/` | |

## 2.1 索引刷新与代码变更成本

| 工具 | 场景 | 命令 | 代码变更规模 | 是否成功 | 耗时 | 是否增量 | 说明 |
| --- | --- | --- | --- | --- | ---: | --- | --- |
| codegraph | cold_index | | 当前源码文件数/源码行数 | | | | |
| codegraph | no_change_refresh | | 0 files / 0 lines | | | | |
| codegraph | after_code_change | | | | | | |
| codegraph | after_git_pull | | | | | | |
| GitNexus | cold_index | | 当前源码文件数/源码行数 | | | | |
| GitNexus | no_change_refresh | | 0 files / 0 lines | | | | |
| GitNexus | after_code_change | | | | | | |
| GitNexus | after_git_pull | | | | | | |

## 3. 任务列表

| task_id | 类型 | 问题 |
| --- | --- | --- |

## 4. 总体结果

| 实验臂 | 平均质量分 | 平均响应时间 | 平均文件读取 | 平均搜索次数 | 平均 tool calls | 平均 token/代理 token | 相对 Baseline 质量增益 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | | | | | | | 0 |
| codegraph | | | | | | | |
| GitNexus | | | | | | | |

## 5. 相对 Baseline 节约

| 工具 | 时间节约 | 文件读取节约 | 搜索次数节约 | tool calls 节约 | token/代理 token 节约 | 说明 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| codegraph | | | | | | |
| GitNexus | | | | | | |

## 5.1 计入索引后的端到端时间

| 工具 | 首次索引耗时 | 回答总耗时 | 任务数 | 摊销后每任务耗时 | 相比 Baseline 每任务耗时 | 结论 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| codegraph | | | | | | |
| GitNexus | | | | | | |

## 6. 分任务结果

| task_id | Baseline 分 | codegraph 分 | GitNexus 分 | codegraph 增益 | GitNexus 增益 | 备注 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |

## 7. 准确率观察

## 8. 效率、响应时间、tool calls 观察

## 9. token 或代理 token 观察

## 10. 典型成功案例

## 11. 典型失败或争议案例

## 12. 本仓结论

- 本仓最优方案：
- codegraph 是否值得：
- GitNexus 是否值得：
- 如果仓库持续变化，索引刷新成本是否可接受：
- 是否建议后续测组合臂：
- 对后续仓库测评的建议：
```

## 11. Agent 执行总提示词

如果你是内部 agent，直接按下面提示执行：

```text
你要在当前仓库执行 codegraph 与 GitNexus 单仓测评。

前提：
- codegraph 已安装且 MCP 可用。
- GitNexus 已安装且 MCP 可用。
- 不联网。

请严格执行：

1. 识别当前仓库基础信息：
   - 仓库名、路径、分支、commit、dirty 状态
   - 项目类型
   - 主要语言和框架
   - 总文件数、源码文件数、总行数、源码行数
   - 构建/包管理工具
2. 创建 benchmark-cg-gn/ 输出目录。
3. 生成 repo-profile.yaml。
4. 基于当前仓库自动生成 6 个任务，写入 tasks.yaml。
5. 构建至少 20 条 high/medium reference facts，写入 reference-facts.yaml。
6. 为 codegraph 建索引并记录版本、首次索引耗时、成功/失败。
7. 为 GitNexus 建索引并记录版本、首次 analyze 耗时、成功/失败。
8. 记录索引刷新成本：
   - 无代码变化时各工具刷新/检查一次。
   - 如允许做临时小改动，则改动少量源码注释后刷新一次，并测完还原。
   - 如本轮确实发生 git pull 或 commit 变化，则记录变更规模和刷新耗时。
   - 如果没有增量能力，明确标记为全量重建或全量 analyze。
9. 对每个任务分别执行 Baseline、codegraph、GitNexus 三臂：
   - Baseline 只能普通源码阅读和搜索。
   - codegraph 必须优先使用 codegraph，再源码校验。
   - GitNexus 必须优先使用 GitNexus，再源码校验。
10. 每个任务、每个 arm 保存 prompt、answer、metrics、tool-log。
11. 用 reference-facts 和答案证据评分。
12. 生成 scores.csv。
13. 生成 repo-report.md。

报告必须明确展示：
- 仓库名
- 项目类型
- 主要语言
- 总文件数
- 源码文件数
- 总行数
- 源码行数
- Baseline / codegraph / GitNexus 的质量分
- 响应时间
- 文件读取数
- 搜索次数
- tool calls
- token 或代理 token
- 首次索引/analyze 耗时
- 代码变更或 pull 后的索引刷新耗时
- 计入索引后的端到端耗时和摊销后每任务耗时
- 相对 Baseline 的节约和增益
```
