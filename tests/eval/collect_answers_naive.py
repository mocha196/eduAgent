"""Collect answers for Ragas-custom questions using dense vector RAG.

Retrieves context chunks with pure vector search, then calls the
LLM with a simple, consistent RAG prompt — no query decomposition or rewriting.

Usage:
  python -m tests.eval.collect_answers_naive
  python -m tests.eval.collect_answers_naive --limit 5
  python -m tests.eval.collect_answers_naive \\
      --questions tests/eval/data/ragas_custom_questions.json \\
      --output    tests/eval/results/answers_naive.json \\
      --top-k     5 \\
      --delay     0.5
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from tests.eval._common import (
    RESULTS_DIR,
    COURSE_RAGAS_CUSTOM,
    _bootstrap,
    load_json,
    query_vector_direct,
)

_bootstrap()

_DEFAULT_QUESTIONS = str(Path(__file__).parent / "data" / "ragas_custom_questions.json")
_DEFAULT_OUTPUT = str(RESULTS_DIR / "answers_naive.json")


def main(
    questions_path: str,
    output_path: str,
    course_id: str,
    top_k: int,
    limit: int | None,
    delay: float,
    blacklist_path: str | None = None,
    official: bool = False,
) -> None:
    mode_label = "official protocol" if official else "vector"
    print(f"\n=== Collect Answers — {mode_label} RAG (non-agentic) ===\n")

    questions = load_json(questions_path)
    if blacklist_path:
        p = Path(blacklist_path)
        if p.exists():
            bad_ids = {str(x) for x in json.load(p.open(encoding="utf-8"))}
            before = len(questions)
            questions = [q for q in questions if str(q.get("id", "")) not in bad_ids]
            print(f"Blacklist : {len(bad_ids)} IDs loaded, {before - len(questions)} skipped  →  {len(questions)} eligible")
    if limit:
        questions = questions[:limit]

    out_file = Path(output_path)

    # Resolve LLM model name from settings (loaded after _bootstrap)
    from rag_mvp.config import settings as _s
    llm_model = _s.effective_chat_model

    # Resume: load already-completed answers so a crash doesn't lose work
    existing: list[dict] = []
    if out_file.exists():
        try:
            existing = json.loads(out_file.read_text(encoding="utf-8"))
            print(f"[resume] Found {len(existing)} existing answers in {output_path}")
        except Exception:
            pass
    done_ids = {str(a["id"]) for a in existing if str(a.get("generated_answer", "")).strip()}
    answers: list[dict] = [a for a in existing if str(a.get("generated_answer", "")).strip()]

    pending = [q for q in questions if str(q.get("id", "")) not in done_ids]

    print(f"Questions total     : {len(questions)}")
    print(f"Already answered    : {len(done_ids)}")
    print(f"Remaining           : {len(pending)}")
    print(f"Course ID           : {course_id}")
    print(f"Mode                : vector  |  top_k={top_k}")
    print(f"Official protocol   : {official} (no rewrite/decompose/BM25, EN system prompt)")
    print(f"LLM model           : {llm_model}")
    print(f"Output              : {output_path}\n")

    for i, q in enumerate(pending):
        qid = str(q.get("id", ""))
        question_text = str(q.get("question", ""))
        print(f"[{len(done_ids) + i + 1}/{len(questions)}] {question_text[:80]}...")

        try:
            answer, contexts = query_vector_direct(
                course_id,
                question_text,
                top_k=top_k,
                official=official,
            )
            # Filter image metadata chunks — no semantic text for faithfulness eval
            contexts = [c for c in contexts if "Image Content" not in c and "Image Path" not in c]
        except Exception as exc:
            print(f"  ERROR: {exc}")
            answer = ""
            contexts = []

        answers.append({
            "id": qid,
            "generated_answer": answer,
            "retrieved_contexts": contexts,
            "llm_model": llm_model,
        })
        # Incremental save after every question
        out_file.parent.mkdir(parents=True, exist_ok=True)
        out_file.write_text(
            json.dumps(answers, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        if delay > 0 and i < len(pending) - 1:
            time.sleep(delay)

    print(f"\n✓ {len(answers)} answers saved → {output_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Collect dense vector RAG answers")
    parser.add_argument("--questions", default=_DEFAULT_QUESTIONS)
    parser.add_argument("--output", default=_DEFAULT_OUTPUT)
    parser.add_argument("--course-id", default=COURSE_RAGAS_CUSTOM)
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--limit", type=int, default=None,
                        help="Only process the first N questions (for testing)")
    parser.add_argument("--delay", type=float, default=0.3,
                        help="Seconds to wait between questions (rate-limit guard)")
    parser.add_argument("--blacklist", default="tests/eval/data/bad_question_ids.json",
                        help="Path to JSON file with bad question IDs to skip")
    parser.add_argument("--official", action="store_true",
                        help="Use official vector-RAG benchmark protocol: no query rewrite/decompose/BM25, "
                             "English system prompt. Required for fair leaderboard comparison.")
    args = parser.parse_args()
    main(args.questions, args.output, args.course_id, args.top_k, args.limit, args.delay, args.blacklist, args.official)
