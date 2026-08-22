# 普通向量 RAG 评测

本目录保留普通向量检索和 TS ReAct Agent 的评测工具。

运行前需要：

- 启动 PostgreSQL、Redis、MinIO、RAG Service 与 Next.js 应用。
- 配置 `DATABASE_URL`、`RAG_PG_DSN`、Embedding 与对话模型凭据。
- 先把评测语料导入待评测课程。

常用命令：

```bash
python -m tests.eval.collect_answers_naive --course-id <course-id>
python -m tests.eval.collect_answers_bm25_only --course-id <course-id>
python -m tests.eval.collect_answers_agentic --course-id <course-id>
python -m tests.eval.eval_ragas_custom
```

这些脚本分别覆盖纯向量召回、向量与关键词融合检索，以及 ReAct Agent 对同一向量知识工具的调用效果。
