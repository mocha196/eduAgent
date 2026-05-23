"""Prepare Ragas custom evaluation data from parsed Chinese course materials.

Reads all parsed Markdown files from output/parsed/, generates a synthetic
200-question testset using Ragas TestsetGenerator (backed by the project's
own OpenAI-compatible LLM endpoint), and saves the questions.

The inference script will then use EVAL_RAGAS_COURSE_ID (env var) to route
questions through the TS ReAct agent for that course.

Output:
  tests/eval/data/ragas_custom_questions.json  — 200 QA pairs

Usage:
  EVAL_RAGAS_COURSE_ID=<uuid> python -m tests.eval.prepare_ragas_custom
  python -m tests.eval.prepare_ragas_custom --course-id <uuid> [--sample N]
"""
from __future__ import annotations

import argparse
import os
import sys
from collections import Counter

from tests.eval._common import (
    DATA_DIR,
    REPO_ROOT,
    _bootstrap,
    save_json,
)

_bootstrap()

# datasets/ folder under repo root — course materials for 计算机网络基础
_SCAN_DIRS = [
    REPO_ROOT / "datasets",
]


# ---------------------------------------------------------------------------
# Collect markdown documents
# ---------------------------------------------------------------------------

def collect_documents(max_docs: int = 0) -> list[dict]:
    """Gather all .md files from parsed output directories.

    Returns a list of dicts with keys: ``page_content``, ``source``.
    """
    docs: list[dict] = []
    for scan_dir in _SCAN_DIRS:
        if not scan_dir.is_dir():
            continue
        for md_path in sorted(scan_dir.rglob("*.md")):
            # Skip very small files (headers / empty)
            try:
                text = md_path.read_text(encoding="utf-8", errors="replace").strip()
            except OSError:
                continue
            if len(text) < 200:
                continue
            docs.append({"page_content": text, "source": str(md_path)})
            if max_docs and len(docs) >= max_docs:
                break
        if max_docs and len(docs) >= max_docs:
            break

    print(f"[collect] Found {len(docs)} Markdown documents from datasets/.")
    return docs


# ---------------------------------------------------------------------------
# Ragas testset generation
# ---------------------------------------------------------------------------

def _build_langchain_docs(raw_docs: list[dict]):
    """Convert raw dicts to LangChain Document objects."""
    from langchain_core.documents import Document  # type: ignore[import-untyped]

    return [
        Document(page_content=d["page_content"], metadata={"source": d["source"]})
        for d in raw_docs
    ]


def _build_ragas_llm():
    """Build a Ragas-compatible LLM using llm_factory (Instructor backend).

    Instructor enforces structured output at the API level (JSON mode), so the
    model returns a filled Pydantic instance instead of echoing back the schema.
    """
    from rag_mvp.config import settings  # type: ignore[import-untyped]
    from openai import AsyncOpenAI
    from ragas.llms import llm_factory  # type: ignore[import-untyped]

    base_url = settings.effective_chat_base_url
    model = settings.effective_chat_model
    api_key = settings.effective_chat_api_key or "placeholder"

    extra_body: dict | None = None
    if "deepseek.com" in base_url or model.lower().startswith("deepseek"):
        extra_body = {"thinking": {"type": "disabled"}}
    elif "dashscope" in base_url or model.lower().startswith("qwen"):
        extra_body = {"enable_thinking": False}

    client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    factory_kwargs: dict = {"temperature": 0.0}
    if extra_body:
        factory_kwargs["extra_body"] = extra_body

    return llm_factory(
        model=model,
        provider="openai",
        client=client,
        adapter="instructor",
        **factory_kwargs,
    )


def _build_ragas_embeddings():
    """Build a Ragas-compatible embeddings wrapper."""
    from rag_mvp.config import settings  # type: ignore[import-untyped]
    from langchain_openai import OpenAIEmbeddings  # type: ignore[import-untyped]
    from ragas.embeddings import LangchainEmbeddingsWrapper  # type: ignore[import-untyped]

    from pydantic import SecretStr

    emb = OpenAIEmbeddings(  # type: ignore[call-arg]
        model=settings.embedding_model,
        api_key=SecretStr(settings.embedding_api_key or settings.llm_api_key or "placeholder"),
        base_url=settings.embedding_base_url or settings.llm_base_url,
    )
    return LangchainEmbeddingsWrapper(emb)


def _preflight_check() -> None:
    """Verify LLM and embedding endpoints are reachable before running generation."""
    from openai import OpenAI
    from rag_mvp.config import settings  # type: ignore[import-untyped]

    # --- LLM ---
    print("[preflight] Testing LLM ...", end=" ", flush=True)
    base_url = settings.effective_chat_base_url
    model = settings.effective_chat_model
    extra_body: dict | None = None
    if "deepseek.com" in base_url or model.lower().startswith("deepseek"):
        extra_body = {"thinking": {"type": "disabled"}}
    elif "dashscope" in base_url or model.lower().startswith("qwen"):
        extra_body = {"enable_thinking": False}

    llm_client = OpenAI(
        api_key=settings.effective_chat_api_key or "placeholder",
        base_url=base_url,
    )
    resp = llm_client.chat.completions.create(  # type: ignore[call-arg]
        model=model,
        messages=[{"role": "user", "content": "hello"}],
        max_tokens=16,
        extra_body=extra_body,
    )
    print(f"OK  (reply: {repr((resp.choices[0].message.content or '')[:60])})")

    # --- Embeddings ---
    print("[preflight] Testing embeddings ...", end=" ", flush=True)
    emb_client = OpenAI(
        api_key=settings.embedding_api_key or settings.llm_api_key or "placeholder",
        base_url=settings.embedding_base_url or settings.llm_base_url,
    )
    emb_resp = emb_client.embeddings.create(
        model=settings.embedding_model,
        input=["hello"],
    )
    dim = len(emb_resp.data[0].embedding)
    print(f"OK  (model={settings.embedding_model}, dim={dim})")


def _extract_questions(testset, id_offset: int = 0) -> list[dict]:
    """Convert a Ragas Testset object into a list of QA dicts."""
    questions: list[dict] = []
    df = testset.to_pandas()
    for _, row in df.iterrows():
        questions.append(
            {
                "id": str(id_offset + len(questions)),
                "question": str(row.get("user_input", row.get("question", ""))),
                "gold_answer": str(row.get("reference", row.get("ground_truth", ""))),
                "context": str(row.get("reference_contexts", row.get("contexts", ""))),
                "evolution_type": str(row.get("synthesizer_name", row.get("evolution_type", "simple"))),
            }
        )
    return questions


def generate_testset(
    docs: list[dict],
    n: int = 200,
    checkpoint_path=None,
    batch_size: int = 20,
) -> list[dict]:
    """Generate n QA pairs using Ragas TestsetGenerator with incremental saves.

    Generates in batches of *batch_size*. After each successful batch the results
    are written to *checkpoint_path*, so a crash only loses at most one batch.
    On the next run the checkpoint is reloaded and generation resumes from where
    it left off.

    The knowledge graph is built once during the first batch
    (``generate_with_langchain_docs``); subsequent batches call
    ``generator.generate()`` which reuses the cached graph.
    """
    import json
    from pathlib import Path
    from ragas.testset import TestsetGenerator  # type: ignore[import-untyped]

    lc_docs = _build_langchain_docs(docs)
    llm = _build_ragas_llm()
    emb = _build_ragas_embeddings()

    # Resume from checkpoint
    questions: list[dict] = []
    if checkpoint_path is not None:
        cp = Path(checkpoint_path)
        if cp.exists():
            try:
                questions = json.loads(cp.read_text(encoding="utf-8"))
                print(f"[ragas] Resumed from checkpoint: {len(questions)}/{n} already done.")
            except Exception as exc:
                print(f"[ragas] Checkpoint unreadable, starting fresh: {exc}")

    if len(questions) >= n:
        print(f"[ragas] Checkpoint already complete ({len(questions)} >= {n}), skipping.")
        return questions

    generator = TestsetGenerator(llm=llm, embedding_model=emb)
    kg_built = False
    print(f"[ragas] Generating {n - len(questions)} more QA pairs from {len(lc_docs)} documents (batch={batch_size})...")

    while len(questions) < n:
        batch_n = min(batch_size, n - len(questions))
        try:
            if not kg_built:
                # First batch: builds the knowledge graph then generates samples.
                testset = generator.generate_with_langchain_docs(lc_docs, testset_size=batch_n)
                kg_built = True
            else:
                # Subsequent batches: reuse the already-built knowledge graph.
                testset = generator.generate(testset_size=batch_n)

            batch_q = _extract_questions(testset, id_offset=len(questions))
            questions.extend(batch_q)
            print(f"[ragas] Batch done (+{len(batch_q)}). Progress: {len(questions)}/{n}")

            if checkpoint_path is not None:
                save_json(Path(checkpoint_path), questions)

        except Exception as exc:
            print(f"[warn] Batch failed ({type(exc).__name__}: {exc}), skipping.")
            if not kg_built:
                raise  # KG build failure is unrecoverable; propagate

    type_dist = Counter(q["evolution_type"] for q in questions)
    print("\n[ragas] Question type distribution:")
    for qtype, count in sorted(type_dist.items(), key=lambda x: -x[1]):
        print(f"  {qtype}: {count} ({count / len(questions) * 100:.1f}%)")

    print(f"[ragas] Generated {len(questions)} QA pairs total.")
    return questions


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(course_id: str | None = None, sample: int = 200) -> None:
    # Resolve course_id
    cid = course_id or os.environ.get("EVAL_RAGAS_COURSE_ID", "").strip()
    if not cid:
        print(
            "[warn] EVAL_RAGAS_COURSE_ID not set. "
            "The inference script will need --course-id when running against this dataset."
        )

    # # 0. Preflight — verify API endpoints before doing any heavy work
    # print("\n=== Step 0: Preflight API checks ===")
    # _preflight_check()

    # 1. Collect documents
    print("\n=== Step 1: Collect parsed Markdown documents ===")
    docs = collect_documents()
    if not docs:
        print("[error] No Markdown documents found. Check datasets/ directory.")
        sys.exit(1)

    # 2. Generate QA pairs
    print("\n=== Step 2: Generate QA pairs with Ragas ===")
    out_file = DATA_DIR / "ragas_custom_questions.json"
    questions = generate_testset(docs, n=sample, checkpoint_path=out_file)

    # Attach course_id for reference (re-save with course_id populated)
    for q in questions:
        q["course_id"] = cid or ""

    save_json(out_file, questions)

    print("\n✓ prepare_ragas_custom.py complete.")
    print(f"  Questions: {DATA_DIR / 'ragas_custom_questions.json'}")
    if cid:
        print(f"  Target course: {cid}")
    else:
        print("  Run with EVAL_RAGAS_COURSE_ID=<uuid> to attach course for inference.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Prepare Ragas custom eval data")
    parser.add_argument("--course-id", default=None, help="Production course UUID to query during inference")
    parser.add_argument("--sample", type=int, default=200, help="Number of QA pairs to generate")
    args = parser.parse_args()
    main(course_id=args.course_id, sample=args.sample)
