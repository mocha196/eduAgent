# 系统量化评估与可观测性说明

本文档独立记录智能教育平台的质量、性能、可靠性和可观测性指标，不修改论文正文。测试结果必须来自实际运行产物；未执行测试时不填写推测值。

## 1. 指标定义

| 类别 | 指标 | 计算口径 | 数据来源 |
|---|---|---|---|
| 检索质量 | Context Precision / Context Recall | 按现有 RAGAS 评测集计算，同时报告样本量 | `tests/eval/results` |
| 回答质量 | Faithfulness / Answer Correctness | RAGAS 或项目内置评审器得分 | `tests/eval/results` |
| 吞吐能力 | QPS | 稳态阶段完成请求数除以持续秒数 | k6 summary |
| 并发能力 | 最大并发 | 满足预设延迟和错误率阈值时的最大活跃 VU | k6 `vus_max` |
| 响应性能 | avg、P50、P90、P95、P99 | 聊天为完整 SSE 响应耗时；RAG 为 `/rag/query` 完整耗时 | k6 Trend |
| 工具可靠性 | 工具调用成功率 | 成功 `tool_result` 数 / 有结果的工具调用数 | SSE 与 `QaLog.toolCalls` |
| 出题效果 | 题目采纳率 | 发布时保留的初始 AI 题目数 / 初始 AI 题目数 | `Assignment.adoptionMetrics` |
| 出题效果 | 直接采纳率 | 未发生教学内容修改的 AI 题目数 / 初始 AI 题目数 | `Assignment.adoptionMetrics` |

题目的分值调整和排序变化不视为内容修改。题干、选项、答案、解析、题型、教学目标、知识实体或难度发生变化时，记为“修改后采纳”。教师新增题目单独统计，不进入采纳率分母。

## 2. 性能测试

运行前记录测试日期、CPU、内存、操作系统、数据库规模、课程材料数量、模型名称与版本。测试课程和账号应使用固定数据，保证不同轮次可比较。

```powershell
Set-Location edu-platform
New-Item -ItemType Directory -Force output/perf | Out-Null

k6 run -e VUS=10 -e DURATION=60s --summary-export output/perf/api_10_summary.json tests/perf/api_concurrent.js
k6 run -e VUS=20 -e DURATION=60s --summary-export output/perf/api_20_summary.json tests/perf/api_concurrent.js
k6 run -e VUS=30 -e DURATION=60s --summary-export output/perf/api_30_summary.json tests/perf/api_concurrent.js
k6 run --summary-export output/perf/rag-summary.json tests/perf/rag_service.js
k6 run --summary-export output/perf/chat-summary.json tests/perf/chat_concurrent.js
k6 run --summary-export output/perf/load-summary.json tests/perf/load.js

npm run perf:report -- output/perf/rag-summary.json output/perf/chat-summary.json output/perf/load-summary.json
```

可通过 `BASE_URL`、`RAG_URL`、`COURSE_ID` 和 `RAG_SERVICE_API_KEY` 环境变量覆盖默认配置。`api_concurrent.js` 不调用外部模型，用于隔离测量认证、数据库和 Web/API 链路；聊天测试包含 10、20 并发场景，综合负载测试覆盖 5、15、30 VU 阶梯。

结果表由 `tests/perf/summarize-results.mjs` 生成，至少包含 QPS、最大并发、avg、P50、P90、P95、P99、HTTP 错误率、工具成功率和样本数。

## 3. Agent 工具调用可靠性

`tests/eval/collect_answers_agentic.py` 会把 `tool_call` 与相同 `tool_call_id` 的 `tool_result` 配对，保存：

- 工具名称及输入；
- 是否成功；
- 执行耗时；
- 未返回结果的调用。

随后运行：

```powershell
& E:\appProjects\eee-history-0d7760e\.venv\Scripts\Activate.ps1
python -m tests.eval.collect_results
```

统一结果中的 `agentic_tool_calls` 同时提供整体和分工具统计。未返回 `tool_result` 的调用不进入成功率分母，但必须通过 `total - completed` 单独披露，防止超时调用被隐藏。

## 4. AI 题目采纳率

作业生成完成时，系统在 `generated_questions_snapshot` 保存最终 AI 题目基线。教师编辑、删除、重新生成或添加题目不会改变该基线；发布时在同一事务内计算并保存 `adoption_metrics`。

汇总已发布作业：

```powershell
& E:\appProjects\eee-history-0d7760e\.venv\Scripts\Activate.ps1
python -m tests.eval.eval_question_adoption
```

报告必须展示已发布作业样本量、AI 生成数、保留数、原样保留数、修改数、删除数、教师新增数、采纳率和直接采纳率。样本不足时应明确标注为小规模试用数据。

## 5. Langfuse 可观测性

### Trace 追踪

- `edu_turn`：一次完整 ReAct 问答，使用 `traceId` 与 `QaLog.metadata.langfuseTraceId` 关联。
- `assignment.generate`：一次完整作业生成任务，以 assignment ID 生成稳定 trace ID。
- standalone trace：批改、反馈建议、记忆提取等辅助调用。

### Span 与 Generation

- `react_loop` 展示整轮端到端延迟、迭代次数、Token 和工具汇总。
- `tool:<name>` 展示各工具的成功状态、错误等级和耗时。
- 作业 trace 展示参数解析、实体检索、蓝图规划、题目生成、审核和改进阶段。
- LLM generation 记录模型、输入输出、prompt/completion/total Token，使 Langfuse 能按模型估算成本。

### 建议监控视图

1. trace 数量、成功率和错误 trace 列表；
2. 端到端延迟及 LLM、RAG、工具 span 的 P50/P95 分布；
3. 每次 trace、每个用户、每个功能和每个模型的 Token 与成本；
4. 工具调用成功率、慢工具排行和主要错误类型；
5. 作业生成各阶段耗时及 Reviewer 最终质量分。

Langfuse 未配置时追踪模块以 no-op 方式运行，不能影响聊天、检索或作业生成主流程。观测数据中的长输入输出应截断，敏感字段不得写入 trace。

## 6. 2026-09-09 实测结果

测试环境：Windows 11 家庭中文版、AMD Ryzen 7 5800H、13.9 GB 内存、Node.js v22.19.0、Next.js 15.5.18、k6 v2.0.0。Next.js、PostgreSQL、Redis 和 MinIO 均在本机运行。数据库包含 40 个用户、7 门课程、26 份材料、7 个作业和 39 条课程加入记录；目标课程的 RAG 工作区包含 614 个切片。

测试采用固定的 30 个学生账号。每个并发档位持续 60 秒，每次循环依次访问课程列表、课程详情、课时列表、材料列表和聊天历史。表中的 QPS、延迟和样本数只统计这 5 类业务 API，不包含每个虚拟用户首次执行的登录请求。

### 性能结果

| 场景 | 最大并发 | QPS | avg(ms) | P50 | P90 | P95 | P99 | API成功率 | HTTP错误率 | 样本数 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Web/API 业务读链路 | 10 | 110.33 | 48.79 | 44.64 | 87.70 | 99.30 | 125.74 | 100.00% | 0.00% | 6,635 |
| Web/API 业务读链路 | 20 | 131.80 | 107.46 | 107.28 | 178.86 | 200.76 | 275.76 | 100.00% | 0.00% | 7,945 |
| Web/API 业务读链路 | 30 | 149.23 | 156.31 | 156.85 | 266.90 | 289.80 | 343.67 | 100.00% | 0.00% | 9,040 |

30 并发是本轮实际验证的最高档位，不代表系统极限。该档位仍满足 P95 小于 2 秒、错误率低于 1% 的预设阈值；若需要确定最大承载并发，应继续执行逐级加压的 stress 测试。

### 题目采纳结果

| 已发布作业数 | AI生成题数 | 保留 | 原样保留 | 修改 | 删除 | 教师新增 | 采纳率 | 直接采纳率 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 个可评估样本 | 0 | 0 | 0 | 0 | 0 | 0 | 不适用 | 不适用 |

数据库当前有 5 个已发布的历史作业，但都在采纳率埋点上线前创建，没有 `generated_questions_snapshot` 和 `adoption_metrics`，因此不能反推或伪造采纳率。需在新版本中完成至少一次“AI 生成—教师编辑—发布”流程后重新汇总。

### 可观测性结果

本次环境未配置 Langfuse 公钥、密钥和服务地址，因此 trace 样本数、延迟分布、Token 与成本统计均无有效样本，不能填报数值。代码路径已验证为未配置时使用 no-op，不影响上述 Web/API 压测。

RAG 实测探针已真实调用 `/rag/query`，服务在约 2.03 秒后返回 HTTP 500。容器日志确认上游 embedding 服务返回 `AllocationQuota.FreeTierOnly`，即免费额度已耗尽。由于向量检索在查询向量生成阶段即失败，本轮不能形成有效的检索准确率、RAG 延迟、聊天端到端延迟或 Agent 工具调用成功率样本；这些指标必须在补充模型额度后重测，不能把该失败请求当成系统性能样本。

原始、已去除登录令牌的 k6 汇总保存在 `edu-platform/output/perf/api_10_summary.json`、`api_20_summary.json` 和 `api_30_summary.json`；题目采纳汇总保存在 `tests/eval/results/question_adoption.json`。
