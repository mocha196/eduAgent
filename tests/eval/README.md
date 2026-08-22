# Vector RAG evaluation

This directory contains the retained vector-retrieval and TS ReAct-agent evaluation utilities.

Prerequisites:

- Start PostgreSQL, Redis, MinIO, the RAG service, and the Next.js application.
- Configure `DATABASE_URL`, `RAG_PG_DSN`, embedding credentials, and chat-model credentials.
- Ingest the evaluation corpus into the selected course before collecting answers.

Common commands:

```bash
python -m tests.eval.collect_answers_naive --course-id <course-id>
python -m tests.eval.collect_answers_bm25_only --course-id <course-id>
python -m tests.eval.collect_answers_agentic --course-id <course-id>
python -m tests.eval.eval_ragas_custom
```

The collectors cover dense retrieval, vector-plus-keyword retrieval, and the same vector knowledge tool when selected by the ReAct agent.
