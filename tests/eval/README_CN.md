# Agentic-RAG 评测框架

用于评测 TS ReAct 智能体（LightRAG + 知识图谱）的完整流水线，覆盖三个基准测试。

---

## 架构

```text
被测系统：edu-platform TS ReAct 智能体
  → /api/v1/courses/{courseId}/chat （SSE 接口）
  → agent 调用 knowledgeQueryTool（LightRAG 检索）
  → 返回流式回答

评测流水线：
  Python：数据集下载 + LightRAG 导入 + Ragas 评分
  TypeScript：推理阶段（通过 HTTP 调用在线 TS agent）
```

---

## 前置条件

1. **服务已启动**：`docker-compose up`（postgres、neo4j、minio、redis）
2. **Next.js 应用已运行**：在 `edu-platform/` 下执行 `npm run dev`
3. **Python 依赖已安装**：`uv sync`（会安装 `ragas`、`datasets`、`argon2-cffi`、`langchain-openai`）
4. `.env` 中配置以下环境变量：

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/edu_platform
LIGHTRAG_PG_DSN=postgresql://user:pass@localhost:5432/edu_lightrag
LLM_API_KEY=...
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_MODEL=qwen-plus-2025-04-28
JWT_SECRET=...   # run_inference.ts 用于自动生成评测 JWT
```

---

## 分步工作流程

### 1. 准备 GraphRAG-Bench 数据

下载约 10 本经典 Gutenberg 小说，并导入两个评测课程：

* `COURSE_GRAPHRAG_NAIVE` —— 仅向量检索的 RAG
* `COURSE_GRAPHRAG_FULL` —— 启用知识图谱的完整 LightRAG

```bash
python -m tests.eval.prepare_graphrag_bench [--sample 200] [--seed 42]
```

输出文件：

```text
tests/eval/data/graphrag_bench_questions.json
```
---

### 3. 准备 Ragas 自定义（中文课程）数据

读取 `output/parsed/` 中解析后的 Markdown 文件，并生成 200 组合成式 QA 数据。

```bash
EVAL_RAGAS_COURSE_ID=<your-course-uuid> python -m tests.eval.prepare_ragas_custom
```

输出文件：

```text
tests/eval/data/ragas_custom_questions.json
```

---

### 4. 运行推理（TypeScript）

针对每个问题调用在线 TS ReAct 智能体。要求 Next.js 应用已经启动。

```bash
cd edu-platform

# GraphRAG-Bench —— Naive 课程
npx tsx scripts/eval/run_inference.ts \
  --input  ../tests/eval/data/graphrag_bench_questions.json \
  --output ../tests/eval/results/graphrag_bench_naive_answers.json \
  --course-id c0000001-0000-4000-8000-000000000000

# GraphRAG-Bench —— 完整 LightRAG 课程
npx tsx scripts/eval/run_inference.ts \
  --input  ../tests/eval/data/graphrag_bench_questions.json \
  --output ../tests/eval/results/graphrag_bench_full_answers.json \
  --course-id c0000002-0000-4000-8000-000000000000

# Ragas 自定义（每个问题内部存储 course_id）
npx tsx scripts/eval/run_inference.ts \
  --input  ../tests/eval/data/ragas_custom_questions.json \
  --output ../tests/eval/results/ragas_custom_answers.json \
  --course-id-from-input
```

**脚本位置**：

```text
edu-platform/scripts/eval/run_inference.ts
```

**认证机制**：

脚本会从 `.env` 中读取 `JWT_SECRET`，并自动为评测学生用户
（`e0000002-0000-4000-8000-000000000000`）生成一个有效期 7 天的 Bearer JWT。

如果已有预签名 Token，可通过以下环境变量覆盖：

```bash
EVAL_JWT_TOKEN=<token>
```

---

### 5. 结果评分

```bash
# GraphRAG-Bench（ROUGE-L、F1、EM、工具调用统计）
python -m tests.eval.eval_graphrag_bench \
  --questions tests/eval/data/graphrag_bench_questions.json \
  --naive     tests/eval/results/graphrag_bench_naive_answers.json \
  --full      tests/eval/results/graphrag_bench_full_answers.json

# Ragas 自定义评测
python -m tests.eval.eval_ragas_custom
```

---

## 输出文件

| 文件                                    | 描述                            |
| ------------------------------------- | ----------------------------- |
| `data/graphrag_bench_questions.json`  | 采样得到的 200 个 GraphRAG-Bench 问题 |
| `data/ragas_custom_questions.json`    | 200 组中文合成 QA 数据               |
| `results/*_answers.json`              | Agent 回答结果（支持增量写入与断点续跑）       |
| `results/graphrag_bench_summary.json` | ROUGE-L / F1 / EM 对比结果表       |
| `results/ragas_custom_summary.json`   | 中文 Ragas 指标平均值                |
| `results/ragas_custom_scores.csv`     | 每个问题的 Ragas 评分                |

---

## 评测课程 ID

以下为所有脚本统一使用的固定 UUID：

| 变量名                     | UUID                                   | 用途                         |
| ----------------------- | -------------------------------------- | -------------------------- |
| `COURSE_GRAPHRAG_NAIVE` | `c0000001-0000-4000-8000-000000000000` | GraphRAG-Bench，基础 RAG      |
| `COURSE_GRAPHRAG_FULL`  | `c0000002-0000-4000-8000-000000000000` | GraphRAG-Bench，完整 LightRAG |
| `EVAL_RAGAS_COURSE_ID`  | （环境变量）                                 | 用于中文评测的生产课程                |

教师用户：

```text
e0000001-0000-4000-8000-000000000000 （eval_teacher）
```

学生用户：

```text
e0000002-0000-4000-8000-000000000000 （eval_student）
```
