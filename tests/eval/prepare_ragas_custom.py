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

from tests.eval._common import (
    DATA_DIR,
    REPO_ROOT,
    _bootstrap,
    save_json,
)

_bootstrap()

# Candidate parsed-output directories to scan (repo root + edu-platform output)
_SCAN_DIRS = [
    REPO_ROOT / "output" / "parsed",
    REPO_ROOT / "edu-platform" / "output" / "parsed",
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

    print(f"[collect] Found {len(docs)} Markdown documents from parsed outputs.")
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
    """Build a Ragas-compatible LLM wrapper pointing to our DashScope endpoint."""
    from rag_mvp.config import settings  # type: ignore[import-untyped]
    from langchain_openai import ChatOpenAI  # type: ignore[import-untyped]
    from ragas.llms import LangchainLLMWrapper  # type: ignore[import-untyped]

    from pydantic import SecretStr

    llm = ChatOpenAI(
        model=settings.llm_model,
        api_key=SecretStr(settings.llm_api_key or "placeholder"),
        base_url=settings.llm_base_url,
        temperature=0.0,
    )
    return LangchainLLMWrapper(llm)


def _build_ragas_embeddings():
    """Build a Ragas-compatible embeddings wrapper."""
    from rag_mvp.config import settings  # type: ignore[import-untyped]
    from langchain_openai import OpenAIEmbeddings  # type: ignore[import-untyped]
    from ragas.embeddings import LangchainEmbeddingsWrapper  # type: ignore[import-untyped]

    from pydantic import SecretStr

    emb = OpenAIEmbeddings(
        model=settings.embedding_model,
        api_key=SecretStr(settings.llm_api_key or "placeholder"),
        base_url=settings.llm_base_url,
    )
    return LangchainEmbeddingsWrapper(emb)


def generate_testset(docs: list[dict], n: int = 200) -> list[dict]:
    """Generate n QA pairs using Ragas TestsetGenerator.

    Returns a list of dicts with keys: ``question``, ``ground_truth``, ``source``.
    """
    from ragas.testset import TestsetGenerator  # type: ignore[import-untyped]

    lc_docs = _build_langchain_docs(docs)
    llm = _build_ragas_llm()
    emb = _build_ragas_embeddings()

    print(f"[ragas] Generating {n} QA pairs from {len(lc_docs)} documents...")
    generator = TestsetGenerator(llm=llm, embedding_model=emb)
    testset = generator.generate_with_langchain_docs(lc_docs, testset_size=n)

    from ragas.testset import Testset  # type: ignore[import-untyped]
    assert isinstance(testset, Testset), f"Unexpected generate() return type: {type(testset)}"

    questions: list[dict] = []
    df = testset.to_pandas()
    for _, row in df.iterrows():
        questions.append(
            {
                "id": str(len(questions)),
                "question": str(row.get("user_input", row.get("question", ""))),
                "gold_answer": str(row.get("reference", row.get("ground_truth", ""))),
                "context": str(row.get("reference_contexts", row.get("contexts", ""))),
                "evolution_type": str(row.get("synthesizer_name", row.get("evolution_type", "simple"))),
            }
        )

    print(f"[ragas] Generated {len(questions)} QA pairs.")
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

    # 1. Collect documents
    print("\n=== Step 1: Collect parsed Markdown documents ===")
    docs = collect_documents()
    if not docs:
        print("[error] No Markdown documents found. Check output/parsed/ directories.")
        sys.exit(1)

    # 2. Generate QA pairs
    print("\n=== Step 2: Generate QA pairs with Ragas ===")
    questions = generate_testset(docs, n=sample)

    # Attach course_id for reference
    for q in questions:
        q["course_id"] = cid or ""

    save_json(DATA_DIR / "ragas_custom_questions.json", questions)

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
