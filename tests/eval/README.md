# Agentic-RAG Evaluation Harness

Full pipeline for evaluating the TS ReAct agent (LightRAG + KG) against three benchmarks.

---

## Architecture

```
System Under Test:  edu-platform TS ReAct agent
  → /api/v1/courses/{courseId}/chat  (SSE endpoint)
  → agent calls knowledgeQueryTool   (LightRAG retrieval)
  → returns streaming answer

Eval pipeline:
  Python: dataset download + LightRAG ingest + Ragas scoring
  TypeScript: inference (calling the live TS agent via HTTP)
```

---

## Prerequisites

1. **Services running**: `docker-compose up` (postgres, neo4j, minio, redis)
2. **Next.js app running**: `npm run dev` in `edu-platform/`
3. **Python deps**: `uv sync` (adds `ragas`, `datasets`, `argon2-cffi`, `langchain-openai`)
4. **Environment variables** in `.env`:
   ```env
   DATABASE_URL=postgresql://user:pass@localhost:5432/edu_platform
   LIGHTRAG_PG_DSN=postgresql://user:pass@localhost:5432/edu_lightrag
   LLM_API_KEY=...
   LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
   LLM_MODEL=qwen-plus-2025-04-28
   JWT_SECRET=...   # used by run_inference.ts to auto-generate eval JWT
   ```

---

## Step-by-Step Workflow

### 1. Prepare GraphRAG-Bench data

Downloads ~10 classic Gutenberg novels and ingests them into two eval courses:
- `COURSE_GRAPHRAG_NAIVE` — vector-only RAG
- `COURSE_GRAPHRAG_FULL`  — full LightRAG with KG

```bash
python -m tests.eval.prepare_graphrag_bench [--sample 200] [--seed 42]
```

Output: `tests/eval/data/graphrag_bench_questions.json`

### 2. Prepare FRAMES data

Samples 200 multi-hop questions, fetches their Wikipedia sources, ingests into `COURSE_FRAMES`.

```bash
python -m tests.eval.prepare_frames [--sample 200]
```

Output: `tests/eval/data/frames_questions.json`

### 3. Prepare Ragas custom (Chinese course) data

Reads parsed Markdown files from `output/parsed/` and generates 200 synthetic QA pairs.

```bash
EVAL_RAGAS_COURSE_ID=<your-course-uuid> python -m tests.eval.prepare_ragas_custom
```

Output: `tests/eval/data/ragas_custom_questions.json`

---

### 4. Run inference (TypeScript)

Calls the live TS ReAct agent for each question. Requires the Next.js app to be running.

```bash
cd edu-platform

# GraphRAG-Bench — Naive course
npx tsx scripts/eval/run_inference.ts \
  --input  ../tests/eval/data/graphrag_bench_questions.json \
  --output ../tests/eval/results/graphrag_bench_naive_answers.json \
  --course-id c0000001-0000-4000-8000-000000000000

# GraphRAG-Bench — Full LightRAG course
npx tsx scripts/eval/run_inference.ts \
  --input  ../tests/eval/data/graphrag_bench_questions.json \
  --output ../tests/eval/results/graphrag_bench_full_answers.json \
  --course-id c0000002-0000-4000-8000-000000000000

# FRAMES
npx tsx scripts/eval/run_inference.ts \
  --input  ../tests/eval/data/frames_questions.json \
  --output ../tests/eval/results/frames_answers.json \
  --course-id c0000003-0000-4000-8000-000000000000

# Ragas custom (course_id stored per-question)
npx tsx scripts/eval/run_inference.ts \
  --input  ../tests/eval/data/ragas_custom_questions.json \
  --output ../tests/eval/results/ragas_custom_answers.json \
  --course-id-from-input
```

**Script location**: `edu-platform/scripts/eval/run_inference.ts`

**Authentication**: reads `JWT_SECRET` from `.env` and auto-generates
a 7-day Bearer JWT for the eval student user (`e0000002-0000-4000-8000-000000000000`).
Override with `EVAL_JWT_TOKEN=<token>` for a pre-signed token.

---

### 5. Score results

```bash
# GraphRAG-Bench (ROUGE-L, F1, EM, tool-call stats)
python -m tests.eval.eval_graphrag_bench \
  --questions tests/eval/data/graphrag_bench_questions.json \
  --naive     tests/eval/results/graphrag_bench_naive_answers.json \
  --full      tests/eval/results/graphrag_bench_full_answers.json

# FRAMES (Ragas: answer_relevancy, faithfulness, context_precision, context_recall)
python -m tests.eval.eval_frames

# Ragas custom
python -m tests.eval.eval_ragas_custom
```

---

## Output Files

| File | Description |
|------|-------------|
| `data/graphrag_bench_questions.json` | 200 sampled GraphRAG-Bench questions |
| `data/frames_questions.json` | 200 FRAMES questions |
| `data/ragas_custom_questions.json` | 200 synthetic Chinese QA pairs |
| `results/*_answers.json` | Agent answers (incremental, resumable) |
| `results/graphrag_bench_summary.json` | ROUGE-L / F1 / EM comparison table |
| `results/frames_ragas_summary.json` | Ragas metric averages |
| `results/ragas_custom_summary.json` | Ragas metric averages (Chinese) |
| `results/frames_ragas_scores.csv` | Per-question Ragas scores |
| `results/ragas_custom_scores.csv` | Per-question Ragas scores |

---

## Eval Course IDs

These are fixed deterministic UUIDs used by all scripts:

| Variable | UUID | Purpose |
|----------|------|---------|
| `COURSE_GRAPHRAG_NAIVE` | `c0000001-0000-4000-8000-000000000000` | GraphRAG-Bench, naive RAG |
| `COURSE_GRAPHRAG_FULL` | `c0000002-0000-4000-8000-000000000000` | GraphRAG-Bench, full LightRAG |
| `COURSE_FRAMES` | `c0000003-0000-4000-8000-000000000000` | FRAMES Wikipedia corpus |
| `EVAL_RAGAS_COURSE_ID` | (env var) | Your production course for Chinese eval |

Teacher: `e0000001-0000-4000-8000-000000000000` (`eval_teacher`)  
Student: `e0000002-0000-4000-8000-000000000000` (`eval_student`)
