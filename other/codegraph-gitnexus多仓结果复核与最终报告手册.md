# codegraph 与 GitNexus 多仓结果复核与最终报告手册

## 0. 使用方式

这份文档给内部 agent 直接执行。

使用场景：

```text
一个文件夹下放了多个已经完成测评的代码仓库
每个仓库下都有 benchmark-cg-gn/ 测评结果
agent 在这个父文件夹启动
agent 引用本 md
agent 自动复核各仓结果并生成最终测评报告
```

本手册不重新执行 Baseline / codegraph / GitNexus 三臂测评，只做结果复核、数据清洗、聚合分析和最终报告。只有在复核证据时，可以只读方式打开源码、原始 `runs/`、`scores.csv`、`repo-profile.yaml`、`index-metrics.yaml` 和 `repo-report.md`。

最终输出：

```text
benchmark-cg-gn-final/
  repo-inventory.csv
  repo-validation.csv
  normalized-results.csv
  aggregate-results.csv
  evidence-review.md
  final-report.md
```

如果 agent 无法写文件，必须在最终回答中完整输出上述内容。

## 1. Agent 总任务

你是测评复核 agent。请在当前父目录中完成：

```text
多仓 codegraph / GitNexus 测评结果复核与最终结论
```

你需要回答：

1. 本轮一共复核了多少个仓库，分别是什么语言、项目类型、规模。
2. 每个仓库的测评结果是否完整、可信，是否存在缺失、公式错误、证据不足或异常值。
3. 相对 Baseline，`codegraph` 和 `GitNexus` 在准确率、效率、响应时间、tool calls、token 或代理 token 上分别提升了什么。
4. 两个工具的首次索引/analyze 成本、代码变更后刷新成本，在多轮架构识别任务中是否能被摊薄。
5. 哪些语言、项目类型、规模下，`codegraph` 更值得用；哪些场景下 `GitNexus` 更值得用。
6. 是否建议继续大规模测评、是否建议进入组合方案验证。

## 2. 输入目录约定

当前目录是父目录，例如：

```text
offline-repos/
  repo-a/
    benchmark-cg-gn/
      repo-profile.yaml
      tasks.yaml
      reference-facts.yaml
      index-metrics.yaml
      scores.csv
      repo-report.md
      runs/
  repo-b/
    benchmark-cg-gn/
      ...
```

agent 必须自动发现：

```bash
find . -type d -name benchmark-cg-gn
```

排除：

- `.git/` 下的任何目录。
- `node_modules/`、`target/`、`dist/`、`build/`、`.venv/` 下的目录。
- 空目录或没有 `repo-report.md` 且没有 `scores.csv` 的目录。

## 3. 输出目录

在当前父目录创建：

```text
benchmark-cg-gn-final/
```

输出文件：

| 文件 | 用途 |
| --- | --- |
| `repo-inventory.csv` | 仓库清单、语言、规模、输入文件存在性 |
| `repo-validation.csv` | 每个仓库的复核结论、问题、可信等级 |
| `normalized-results.csv` | 归一化后的每仓每工具指标 |
| `aggregate-results.csv` | 按工具、语言、项目类型、规模聚合后的指标 |
| `evidence-review.md` | 抽样证据复核和异常案例 |
| `final-report.md` | 最终测评报告 |

## 4. 第一步：发现仓库并建立清单

对每个 `benchmark-cg-gn/`，识别：

```yaml
repo:
  name:
  path:
  benchmark_path:
  has_repo_profile:
  has_index_metrics:
  has_scores:
  has_repo_report:
  has_runs:
  project_type:
  languages:
  frameworks:
  source_files:
  source_lines:
  total_files:
  total_lines:
  size_bucket: small | medium | large | unknown
  commit:
  branch:
```

优先从 `repo-profile.yaml` 读取；缺失时从 `repo-report.md` 表格中提取；仍缺失时可只读扫描仓库补充，但必须在 `repo-validation.csv` 标记为 `profile_reconstructed`。

输出 `repo-inventory.csv`，建议列：

```csv
repo_name,repo_path,benchmark_path,project_type,languages,frameworks,source_files,source_lines,total_files,total_lines,size_bucket,commit,has_repo_profile,has_index_metrics,has_scores,has_repo_report,has_runs,input_status
```

## 5. 第二步：完整性复核

每个仓库检查：

| 检查项 | 通过标准 |
| --- | --- |
| 输入完整性 | 至少存在 `scores.csv` 和 `repo-report.md` |
| 仓库信息 | 仓名、语言、源码文件数、源码行数不为空 |
| 三臂完整性 | Baseline / codegraph / GitNexus 都有结果 |
| 任务完整性 | 至少 4 个有效任务，推荐 6 个 |
| 指标完整性 | quality、time、file_reads、search_calls、tool_calls 至少可用 |
| 索引指标 | 首次索引/analyze 耗时至少可用；刷新成本缺失时标记 |
| 证据完整性 | 每个 arm 的答案应有源码证据或工具证据 |
| 公式一致性 | 汇总表和 `scores.csv` 重算结果差异不超过 1% 或 0.5 分 |

输出 `repo-validation.csv`：

```csv
repo_name,validation_status,trust_level,task_count,arms_complete,index_metrics_status,formula_status,evidence_status,issues,include_in_aggregate
```

字段说明：

- `validation_status`：`pass | warning | fail`
- `trust_level`：`high | medium | low`
- `include_in_aggregate`：`yes | partial | no`

规则：

- `fail` 的仓库不能进入主汇总，只能进入“剔除样本说明”。
- `warning` 的仓库可以进入汇总，但报告必须说明影响。
- 缺少 token 时不要判 fail，使用代理 token 指标。
- 缺少刷新成本时不要判 fail，但索引成本结论只能基于有数据的仓。

## 6. 第三步：重算每仓指标

从 `scores.csv` 重算，不要直接相信 `repo-report.md` 汇总表。

每个仓库、每个 arm 计算：

```text
avg_quality_score
avg_accuracy_score
avg_answer_time_seconds
avg_file_reads
avg_search_calls
avg_tool_calls
avg_total_tokens
avg_proxy_token_score
task_count
```

相对 Baseline 计算：

```text
quality_gain = tool_avg_quality - baseline_avg_quality
quality_gain_pct = quality_gain / baseline_avg_quality
time_saving = (baseline_avg_time - tool_avg_time) / baseline_avg_time
file_read_saving = (baseline_avg_file_reads - tool_avg_file_reads) / baseline_avg_file_reads
search_saving = (baseline_avg_search_calls - tool_avg_search_calls) / baseline_avg_search_calls
tool_call_saving = (baseline_avg_tool_calls - tool_avg_tool_calls) / baseline_avg_tool_calls
token_saving = (baseline_avg_tokens - tool_avg_tokens) / baseline_avg_tokens
```

如果分母为 0，写 `N/A`，不要强行算 0。

索引成本计算：

```text
cold_index_seconds
no_change_refresh_seconds
after_code_change_refresh_seconds
after_git_pull_refresh_seconds
answer_total_seconds = sum(answer_time_seconds for tool arm)
amortized_time_per_task = (cold_index_seconds + answer_total_seconds) / task_count
end_to_end_time_saving_vs_baseline = (baseline_avg_answer_time - amortized_time_per_task) / baseline_avg_answer_time
```

注意：

- `time_saving` 只看回答阶段。
- `end_to_end_time_saving_vs_baseline` 计入首次索引成本。
- 如果一个工具索引失败，该工具在该仓不能算平均收益，标记为 `tool_failed`。

输出 `normalized-results.csv`：

```csv
repo_name,project_type,languages,size_bucket,tool,task_count,avg_quality_score,avg_accuracy_score,avg_answer_time_seconds,avg_file_reads,avg_search_calls,avg_tool_calls,avg_total_tokens,avg_proxy_token_score,quality_gain,quality_gain_pct,time_saving,file_read_saving,search_saving,tool_call_saving,token_saving,cold_index_seconds,no_change_refresh_seconds,after_code_change_refresh_seconds,after_git_pull_refresh_seconds,amortized_time_per_task,end_to_end_time_saving_vs_baseline,trust_level
```

## 7. 第四步：证据抽样复核

不要只做数字汇总。每个仓库至少抽样复核：

| 类型 | 数量 | 复核内容 |
| --- | ---: | --- |
| 最高收益任务 | 1 | 工具分数是否确实比 Baseline 好，证据是否支持 |
| 最低收益或负收益任务 | 1 | 工具失败原因是否合理 |
| 架构入口/调用链任务 | 1 | 是否存在幻觉、过度概括、引用错误 |

复核方法：

1. 打开对应 `runs/<arm>/<task_id>/answer.md`。
2. 打开 `runs/<arm>/<task_id>/metrics.yaml`。
3. 对答案中的关键证据，检查源码文件是否存在，路径是否正确。
4. 如果答案声称某文件、类、函数、路由、模块存在，但源码中找不到，记为 `evidence_error`。
5. 如果答案只是没有证据但结论大体正确，记为 `weak_evidence`。
6. 如果分数明显与答案质量不匹配，记为 `score_dispute`。

输出 `evidence-review.md`，结构：

```markdown
# 证据抽样复核

## 复核范围

| 仓库 | 抽样任务数 | 抽样 arm 数 | 结论 |
| --- | ---: | ---: | --- |

## 发现的问题

| 仓库 | task_id | arm | 问题类型 | 说明 | 是否影响汇总 |
| --- | --- | --- | --- | --- | --- |

## 典型可信案例

## 典型不可信案例
```

## 8. 第五步：聚合分析

只使用 `include_in_aggregate = yes` 和 `partial` 的仓库。`partial` 仓库缺什么指标就不参与该指标平均。

至少输出四类聚合：

1. 全部仓库总体聚合。
2. 按语言聚合，例如 Java / Vue / Go / Python / Node。
3. 按项目类型聚合，例如 `java`、`vue`、`go`。
4. 按规模聚合，例如 small / medium / large。

每组、每个工具计算：

```text
repo_count
avg_quality_gain
median_quality_gain
avg_time_saving
median_time_saving
avg_file_read_saving
avg_search_saving
avg_tool_call_saving
avg_token_saving
avg_cold_index_seconds
median_cold_index_seconds
avg_after_code_change_refresh_seconds
avg_amortized_time_per_task
win_rate_quality
win_rate_answer_time
win_rate_end_to_end_time
```

定义：

- `win_rate_quality`：该工具质量分高于 Baseline 的仓库占比。
- `win_rate_answer_time`：该工具回答阶段平均耗时低于 Baseline 的仓库占比。
- `win_rate_end_to_end_time`：计入首次索引摊销后仍快于 Baseline 的仓库占比。

输出 `aggregate-results.csv`：

```csv
group_type,group_name,tool,repo_count,avg_quality_gain,median_quality_gain,avg_time_saving,median_time_saving,avg_file_read_saving,avg_search_saving,avg_tool_call_saving,avg_token_saving,avg_cold_index_seconds,median_cold_index_seconds,avg_after_code_change_refresh_seconds,avg_amortized_time_per_task,win_rate_quality,win_rate_answer_time,win_rate_end_to_end_time
```

## 9. 第六步：异常值和偏差处理

必须检查并报告：

| 异常 | 处理 |
| --- | --- |
| 某仓索引时间极端长 | 保留，另算去极值均值 |
| 某仓任务数明显少 | 标记 `partial`，不要和完整样本等权比较 |
| 某工具在某仓失败 | 不用 0 分拉低平均，单独算失败率 |
| token 不可用 | 使用代理 token，报告注明 |
| 人工评分疑似偏差 | 标记 `score_dispute`，必要时从主汇总剔除 |
| 仓库语言识别错误 | 修正归一化结果，并在复核记录说明 |

最终报告不能只写平均数，必须同时写：

- 样本数。
- 失败率。
- 中位数。
- 典型成功/失败案例。
- 哪些结论只适用于当前样本。

## 10. 第七步：最终报告模板

输出：

```text
benchmark-cg-gn-final/final-report.md
```

使用下面模板。

```markdown
# codegraph 与 GitNexus 多仓测评最终报告

## 1. 结论摘要

- 本轮复核仓库数：
- 纳入主汇总仓库数：
- 样本语言/项目类型：
- 总体最优建议：
- 最主要收益：
- 最主要成本：
- 主要风险：

## 2. 样本概况

| 仓库 | 项目类型 | 主要语言 | 源码文件数 | 源码行数 | 规模 | 可信等级 | 是否纳入汇总 |
| --- | --- | --- | ---: | ---: | --- | --- | --- |

## 3. 数据质量复核

| 复核项 | 通过数量 | warning 数量 | fail 数量 | 说明 |
| --- | ---: | ---: | ---: | --- |

## 4. 总体对比

| 工具 | 仓库数 | 平均质量增益 | 质量胜率 | 平均回答时间节约 | 平均文件读取节约 | 平均搜索节约 | 平均 tool calls 节约 | 平均 token/代理 token 节约 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| codegraph | | | | | | | | |
| GitNexus | | | | | | | | |

## 5. 索引与刷新成本

| 工具 | 平均首次索引/analyze | 中位数首次索引/analyze | 平均无变更刷新 | 平均代码变更后刷新 | 摊销后每任务耗时 | 端到端时间胜率 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| codegraph | | | | | | |
| GitNexus | | | | | | |

## 6. 按语言/项目类型结论

| 分组 | 工具 | 仓库数 | 平均质量增益 | 平均回答时间节约 | 平均索引成本 | 结论 |
| --- | --- | ---: | ---: | ---: | ---: | --- |

## 7. 按规模结论

| 规模 | 工具 | 仓库数 | 平均质量增益 | 平均回答时间节约 | 端到端时间胜率 | 结论 |
| --- | --- | ---: | ---: | ---: | ---: | --- |

## 8. 典型成功案例

| 仓库 | 工具 | 任务 | 提升点 | 证据 |
| --- | --- | --- | --- | --- |

## 9. 典型失败案例

| 仓库 | 工具 | 任务 | 问题 | 影响 |
| --- | --- | --- | --- | --- |

## 10. 最终选型建议

### codegraph

- 适合场景：
- 不适合场景：
- 主要收益：
- 主要成本：

### GitNexus

- 适合场景：
- 不适合场景：
- 主要收益：
- 主要成本：

### 是否建议测组合方案

- 建议/不建议：
- 理由：
- 下一轮组合测评应重点验证：

## 11. 结论可信度和限制

- 样本限制：
- 指标限制：
- 评分限制：
- 需要补测的仓库或场景：
```

## 11. 最终建议口径

写最终建议时，按下面口径判断：

| 现象 | 建议 |
| --- | --- |
| 工具质量增益高，回答时间也节省 | 强建议进入试用 |
| 工具质量增益高，但首次索引很慢 | 适合多轮架构问答，不适合一次性问题 |
| 工具质量一般，但 file/search/token 明显下降 | 适合辅助探索，不适合作为唯一结论来源 |
| 工具在某语言/规模下失败率高 | 限制使用范围，先修工具或补测 |
| 两个工具优势互补 | 建议进入 `GitNexus + codegraph` 组合方案验证 |
| 两个工具都只在少数仓库有效 | 暂不推广，继续扩大样本或改测评任务 |

不要写过度结论。最终报告中的每个强结论都必须对应：

- 样本数量。
- 平均值或中位数。
- 至少一个具体仓库案例。
- 已知限制。

## 12. Agent 执行总提示词

如果你是内部 agent，在多个已测仓库的父目录下直接按下面提示执行：

```text
你要执行 codegraph 与 GitNexus 多仓测评结果复核，并生成最终报告。

当前目录下有多个代码仓库，每个已测仓库下应该有 benchmark-cg-gn/。
不要重新跑 Baseline/codegraph/GitNexus 三臂测评，只复核已有结果。
可以只读打开源码和 benchmark-cg-gn 下的结果文件。

请严格执行：

1. 自动发现所有 benchmark-cg-gn/ 目录，排除 .git、node_modules、dist、build、target、.venv。
2. 为每个仓库读取 repo-profile.yaml、index-metrics.yaml、scores.csv、repo-report.md、runs/。
3. 生成 benchmark-cg-gn-final/repo-inventory.csv。
4. 对每个仓库做完整性复核：
   - 输入文件是否完整。
   - 仓名、语言、源码文件数、源码行数是否可用。
   - Baseline/codegraph/GitNexus 三臂是否完整。
   - 至少 4 个有效任务。
   - 索引/analyze 耗时是否可用。
   - repo-report 汇总和 scores.csv 重算是否一致。
5. 生成 benchmark-cg-gn-final/repo-validation.csv，并标记 high/medium/low 可信等级。
6. 从 scores.csv 重算每仓每工具指标，不要直接相信报告汇总表。
7. 计算相对 Baseline 的质量增益、响应时间节约、文件读取节约、搜索节约、tool calls 节约、token 或代理 token 节约。
8. 计算首次索引/analyze、无变更刷新、代码变更刷新、pull 后刷新，以及计入索引后的摊销耗时。
9. 生成 benchmark-cg-gn-final/normalized-results.csv。
10. 每个仓库至少抽样复核最高收益任务、最低收益任务、入口/调用链任务，检查答案证据是否能在源码或工具日志中支撑。
11. 生成 benchmark-cg-gn-final/evidence-review.md。
12. 按总体、语言、项目类型、规模聚合，生成 benchmark-cg-gn-final/aggregate-results.csv。
13. 识别异常值、失败样本、缺失指标，不要把 fail 样本混入主汇总。
14. 生成 benchmark-cg-gn-final/final-report.md。

最终报告必须明确展示：
- 复核了哪些仓库。
- 每个仓库的语言、源码文件数、源码行数、规模。
- 每个仓库是否纳入最终汇总。
- codegraph 相对 Baseline 的准确率、效率、响应时间、tool calls、token 或代理 token 改善。
- GitNexus 相对 Baseline 的准确率、效率、响应时间、tool calls、token 或代理 token 改善。
- 两个工具的首次索引/analyze 成本和代码变更刷新成本。
- 计入索引后的端到端收益是否仍成立。
- 哪些结论可信，哪些结论需要补测。
- 是否建议进入 GitNexus + codegraph 组合方案验证。
```
