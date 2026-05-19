"""Prepare GraphRAG-Bench evaluation data.

Loads the official GraphRAG-Bench novel corpus from the local file
  tests/eval/data/novel.json
(download from https://huggingface.co/datasets/GraphRAG-Bench/GraphRAG-Bench/tree/main/Datasets/Corpus)

Samples 200 questions from the HuggingFace dataset and ingests the corpus
into two eval courses:
  - COURSE_GRAPHRAG_NAIVE  (skip_entity_extraction=True  → vector-only RAG)
  - COURSE_GRAPHRAG_FULL   (skip_entity_extraction=False → full LightRAG KG)

Output:
  tests/eval/data/graphrag_bench_questions.json  — 200 sampled questions

Usage:
  python -m tests.eval.prepare_graphrag_bench [--sample N] [--seed SEED] [--skip-ingest]
  python -m tests.eval.prepare_graphrag_bench --corpus path/to/novel.json
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from tests.eval._common import (
    COURSE_GRAPHRAG_FULL,
    COURSE_GRAPHRAG_NAIVE,
    DATA_DIR,
    ingest_text_full,
    ingest_text_naive,
    stable_material_id,
)

# ---------------------------------------------------------------------------
# Local corpus loader
# ---------------------------------------------------------------------------

DEFAULT_CORPUS_PATH = DATA_DIR / "novel.json"


def _load_local_corpus(path: Path) -> list[tuple[str, str, str]]:
    """Read novel.json and return list of (corpus_name, corpus_name, text).

    Expected format: [{"corpus_name": "...", "context": "..."}, ...]
    """
    if not path.exists():
        raise FileNotFoundError(
            f"Corpus file not found: {path}\n"
            "Download from https://huggingface.co/datasets/GraphRAG-Bench/"
            "GraphRAG-Bench/tree/main/Datasets/Corpus and save as tests/eval/data/novel.json"
        )
    # Stream-friendly: read in chunks to handle large files
    with open(path, encoding="utf-8", errors="replace") as f:
        entries = json.load(f)

    corpus: list[tuple[str, str, str]] = []
    for entry in entries:
        name = str(entry.get("corpus_name", "")).strip()
        text = str(entry.get("context", "")).strip()
        if name and text:
            corpus.append((name, name, text))

    print(f"[corpus] Loaded {len(corpus)} novels from {path}")
    return corpus


def _load_graphrag_bench_dataset(subset: str = "novel"):
    """Load dataset from HuggingFace Hub."""
    from datasets import load_dataset  # type: ignore[import-untyped]

    print(f"[dataset] Loading GraphRAG-Bench ({subset} split)...")
    ds = load_dataset("GraphRAG-Bench/GraphRAG-Bench", subset, trust_remote_code=True)
    # The dataset has a single 'test' split
    split = ds.get("test") or ds.get("train") or next(iter(ds.values()))
    print(f"[dataset] Loaded {len(split)} examples from {subset} subset.")
    return split


def _sample_questions(split, n: int, seed: int) -> list[dict]:
    import random

    rng = random.Random(seed)
    indices = rng.sample(range(len(split)), min(n, len(split)))
    questions = []
    for i in indices:
        row = split[i]
        questions.append(
            {
                "id": str(row.get("id", i)),
                "question": str(row.get("question", "")),
                "gold_answer": str(row.get("answer", row.get("gold_answer", ""))),
                "question_type": str(row.get("question_type", "")),
                "evidence": str(row.get("evidence", row.get("context", ""))),
                "source": str(row.get("source", "novel")),
            }
        )
    print(f"[sample] Selected {len(questions)} questions (seed={seed}).")
    return questions


def _ingest_corpus(books: list[tuple[str, str, str]], course_id: str, mode: str) -> None:
    """Ingest all book texts into a single course (sequentially to avoid OOM)."""
    from tests.eval._common import is_already_ingested
    print(f"\n[ingest:{mode}] Course={course_id}  ({len(books)} books)")
    for corpus_name, title, text in books:
        material_id = stable_material_id(f"corpus:{corpus_name}")
        if is_already_ingested(course_id, material_id):
            print(f"  [{mode}] Skip (already ingested): {title}")
            continue
        filename = f"corpus_{corpus_name.replace(' ', '_')[:60]}.txt"
        print(f"  [{mode}] Ingesting: {title} ({len(text):,} chars)...")
        if mode == "naive":
            n = ingest_text_naive(course_id, material_id, text, filename)
        else:
            n = ingest_text_full(course_id, material_id, text, filename)
        print(f"  [{mode}] ✓ {title}: {n} chunks")


def main(
    sample: int = 200,
    seed: int = 42,
    skip_ingest: bool = False,
    corpus_path: Path = DEFAULT_CORPUS_PATH,
    ingest_mode: str = "both",  # "naive" | "full" | "both"
) -> None:
    # # 1. DB setup
    # print("\n=== Step 1: DB setup ===")
    # setup_eval_db()

    # # 2. Load dataset
    # print("\n=== Step 2: Load GraphRAG-Bench ===")
    # split = _load_graphrag_bench_dataset("novel")

    # # 3. Sample questions
    # print("\n=== Step 3: Sample questions ===")
    # questions = _sample_questions(split, sample, seed)
    # save_json(DATA_DIR / "graphrag_bench_questions.json", questions)

    # if skip_ingest:
    #     print("\n[skip_ingest] Skipping corpus ingest.")
    #     return

    # 4. Load local novel corpus
    print("\n=== Step 4: Load local novel corpus ===")
    corpus = _load_local_corpus(corpus_path)

    if not corpus:
        print("[error] Corpus is empty. Aborting ingest.")
        return

    # 5. Ingest into NAIVE course
    if ingest_mode in ("naive", "both"):
        print("\n=== Step 5: Ingest into NAIVE course ===")
        _ingest_corpus(corpus, COURSE_GRAPHRAG_NAIVE, "naive")
    else:
        print("\n[skip] --mode=full: skipping NAIVE course ingest.")

    # 6. Ingest into FULL course
    if ingest_mode in ("full", "both"):
        print("\n=== Step 6: Ingest into FULL (LightRAG) course ===")
        _ingest_corpus(corpus, COURSE_GRAPHRAG_FULL, "full")
    else:
        print("\n[skip] --mode=naive: skipping FULL course ingest.")

    print("\n✓ prepare_graphrag_bench.py complete.")
    print(f"  Questions: {DATA_DIR / 'graphrag_bench_questions.json'}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Prepare GraphRAG-Bench eval data")
    parser.add_argument("--sample", type=int, default=200, help="Number of questions to sample")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    parser.add_argument("--skip-ingest", action="store_true", help="Skip corpus ingest entirely")
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS_PATH, help="Path to novel.json corpus file")
    parser.add_argument(
        "--mode",
        choices=["naive", "full", "both"],
        default="both",
        help="Which ingest to run: naive (vector-only), full (LightRAG KG), or both (default)",
    )
    args = parser.parse_args()
    main(
        sample=args.sample,
        seed=args.seed,
        skip_ingest=args.skip_ingest,
        corpus_path=args.corpus,
        ingest_mode=args.mode,
    )
