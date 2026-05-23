"""Run official GraphRAG-Bench evaluation metrics on our collected answer files.

Uses the exact metric implementations from the official GraphRAG-Benchmark repository
(https://github.com/GraphRAG-Bench/GraphRAG-Benchmark), copied to
tests/eval/official_metrics/ and imported directly — no repo clone required.

Metrics (same as official leaderboard):
  Generation:
    Fact Retrieval      : rouge_score, answer_correctness
    Complex Reasoning   : rouge_score, answer_correctness
    Contextual Summarize: answer_correctness, coverage_score
    Creative Generation : answer_correctness, coverage_score, faithfulness
  Retrieval:
    context_relevance, evidence_recall

Usage:
  python -m tests.eval.run_official_eval ^
    --questions tests/eval/data/graphrag_bench_questions.json ^
    --naive     tests/eval/results/graphrag_bench_naive_answers.json ^
    --mix       tests/eval/results/graphrag_bench_mix_answers.json ^
    --agentic   tests/eval/results/graphrag_bench_agentic_answers.json

  # Quick test with first 10 questions (naive only):
  python -m tests.eval.run_official_eval ^
    --questions tests/eval/data/graphrag_bench_questions.json ^
    --naive     tests/eval/results/graphrag_bench_naive_answers.json ^
    --limit 10
"""
from __future__ import annotations

import argparse
import ast
import asyncio
import json
import os
from pathlib import Path
from typing import Any

import numpy as np
from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Official metric imports (from local tests/eval/official_metrics/ package)
# ---------------------------------------------------------------------------

from tests.eval.official_metrics import (
    compute_answer_correctness,
    compute_coverage_score,
    compute_evidence_recall,
    compute_faithfulness_score,
    compute_rouge_score,
    compute_context_relevance,
)

METRIC_FNS: dict = {
    "rouge_score": compute_rouge_score,
    "answer_correctness": compute_answer_correctness,
    "coverage_score": compute_coverage_score,
    "faithfulness": compute_faithfulness_score,
    "context_relevance": compute_context_relevance,
    "evidence_recall": compute_evidence_recall,
}


# ---------------------------------------------------------------------------
# Metric routing per question type (matches official leaderboard)
# ---------------------------------------------------------------------------

GENERATION_METRIC_CONFIG: dict[str, list[str]] = {
    "Fact Retrieval": ["rouge_score", "answer_correctness"],
    "Complex Reasoning": ["rouge_score", "answer_correctness"],
    "Contextual Summarize": ["answer_correctness", "coverage_score"],
    "Creative Generation": ["answer_correctness", "coverage_score", "faithfulness"],
}

RETRIEVAL_METRICS = ["context_relevance", "evidence_recall"]

# ---------------------------------------------------------------------------
# Format conversion: our format → official format
# ---------------------------------------------------------------------------

def _parse_evidence(evidence_field: Any) -> list[str]:
    """Parse evidence field (may be JSON string or list)."""
    if not evidence_field:
        return []
    if isinstance(evidence_field, list):
        return [str(e).strip() for e in evidence_field if str(e).strip()]
    s = str(evidence_field).strip()
    if not s or s in ("[]", "null"):
        return []
    # Try JSON first
    try:
        val = json.loads(s)
        if isinstance(val, list):
            return [str(e).strip() for e in val if str(e).strip()]
    except (json.JSONDecodeError, TypeError):
        pass
    # Try Python literal (repr format)
    try:
        val = ast.literal_eval(s)
        if isinstance(val, list):
            return [str(e).strip() for e in val if str(e).strip()]
    except Exception:
        pass
    return [s]


def convert_to_official_format(questions: list[dict], answers: list[dict]) -> list[dict]:
    """Convert our collected answers + questions to the official GraphRAG-Bench format.

    Our format:
      answers:   {id, generated_answer, retrieved_contexts: [...], llm_model, ...}
      questions: {id, question, gold_answer, question_type, evidence, source}

    Official format:
      {id, question, source, context (str), contexts (list), evidence (list),
       question_type, generated_answer, ground_truth}
    """
    q_map = {str(q["id"]): q for q in questions}
    result = []
    for a in answers:
        qid = str(a.get("id", ""))
        q = q_map.get(qid)
        if q is None:
            continue

        # Build contexts list
        contexts: list[str] = []
        rc = a.get("retrieved_contexts", [])
        if isinstance(rc, list):
            contexts = [str(c) for c in rc if str(c).strip()]
        if not contexts:
            # Fallback: tool call outputs (agentic mode)
            for tc in a.get("tool_calls", []):
                out = str(tc.get("output", "")).strip()
                if out:
                    contexts.append(out)

        # evidence as list
        evidence = _parse_evidence(q.get("evidence", ""))

        result.append({
            "id": qid,
            "question": str(q.get("question", "")),
            "source": str(q.get("source", "")),
            "context": "\n\n".join(contexts),   # single string (used by some metrics)
            "contexts": contexts,                 # list (used by faithfulness / retrieval)
            "evidence": evidence,
            "question_type": str(q.get("question_type", "")),
            "generated_answer": str(a.get("generated_answer", "")),
            "ground_truth": str(q.get("gold_answer", "")),
        })
    return result


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

async def _evaluate_one(
    item: dict,
    metrics: list[str],
    metric_fns: dict,
    llm: Any,
    embeddings: Any,
) -> dict[str, float]:
    """Evaluate all requested metrics for a single item, with per-metric retry."""

    # Use factories (callables) so a fresh coroutine can be created on each retry attempt
    factories: dict[str, Any] = {}
    for metric in metrics:
        if metric == "rouge_score":
            factories[metric] = lambda: metric_fns["rouge_score"](
                item["generated_answer"], item["ground_truth"]
            )
        elif metric == "answer_correctness":
            factories[metric] = lambda: metric_fns["answer_correctness"](
                item["question"], item["generated_answer"], item["ground_truth"],
                llm, embeddings,
            )
        elif metric == "coverage_score":
            factories[metric] = lambda: metric_fns["coverage_score"](
                item["question"], item["ground_truth"], item["generated_answer"], llm
            )
        elif metric == "faithfulness":
            factories[metric] = lambda: metric_fns["faithfulness"](
                item["question"], item["generated_answer"], item["contexts"], llm
            )
        elif metric == "context_relevance":
            factories[metric] = lambda: metric_fns["context_relevance"](
                item["question"], item["contexts"], llm
            )
        elif metric == "evidence_recall":
            factories[metric] = lambda: metric_fns["evidence_recall"](
                item["question"], item["contexts"], item["evidence"], llm
            )

    if not factories:
        return {}

    async def _run_with_retry(name: str, factory) -> tuple[str, Any]:
        """Run a metric factory, retrying up to 2 times (3 total) on transient errors."""
        for attempt in range(3):
            try:
                val = await factory()
                return name, val
            except Exception as exc:
                if attempt < 2:
                    wait = 5 * (2 ** attempt)  # 5s, 10s
                    print(f"\n  [RETRY {attempt+1}/2] {name}: {exc} — retrying in {wait}s")
                    await asyncio.sleep(wait)
                else:
                    return name, exc
        return name, float("nan")  # unreachable

    retry_tasks = [_run_with_retry(name, factory) for name, factory in factories.items()]
    pairs = await asyncio.gather(*retry_tasks)

    result: dict[str, float] = {}
    for name, val in pairs:
        if isinstance(val, Exception):
            print(f"\n  [WARN] {name} error: {val}")
            result[name] = float("nan")
        elif isinstance(val, (int, float)):
            result[name] = float(val)
        else:
            result[name] = float("nan")
    return result


# ---------------------------------------------------------------------------
# Checkpoint helpers
# ---------------------------------------------------------------------------

def _load_checkpoint(path: Path) -> dict[str, dict]:
    """Load per-item scores from a JSONL checkpoint file.
    Returns dict: item_id (str) → {metric: score, ...}
    """
    checkpoint: dict[str, dict] = {}
    if not path.exists():
        return checkpoint
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
            item_id = str(rec.get("id", ""))
            if item_id:
                checkpoint[item_id] = rec
        except json.JSONDecodeError:
            pass
    return checkpoint


def _checkpoint_has_all(cached: dict, metrics: list[str]) -> bool:
    """Return True if all metrics exist in cached with finite (non-NaN) float values."""
    for m in metrics:
        v = cached.get(m)
        if not isinstance(v, (int, float)) or np.isnan(v):
            return False
    return True


def _save_checkpoint_item(path: Path, item_id: str, scores: dict) -> None:
    """Append one item's scores to the JSONL checkpoint file."""
    rec = {"id": item_id, **scores}
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


async def _evaluate_dataset(
    data: list[dict],
    generation_config: dict[str, list[str]],
    retrieval_metrics: list[str],
    metric_fns: dict,
    llm: Any,
    embeddings: Any,
    max_concurrent: int = 3,
    checkpoint: dict[str, dict] | None = None,
    checkpoint_path: Path | None = None,
) -> dict:
    """Run generation + retrieval evaluation, return aggregated results.

    Pass ``checkpoint`` (loaded via _load_checkpoint) and ``checkpoint_path``
    to enable resume: items whose required metrics are all valid floats are
    skipped; new results are appended to the checkpoint file immediately.
    """
    if checkpoint is None:
        checkpoint = {}
    semaphore = asyncio.Semaphore(max_concurrent)

    # Collect all metric names an item needs: gen_metrics + retrieval_metrics
    def _all_metrics_for(item: dict) -> list[str]:
        qt = item.get("question_type", "Unknown")
        gm = generation_config.get(qt, [])
        return list(dict.fromkeys(gm + retrieval_metrics))  # dedup, preserve order

    async def _eval_item(item: dict) -> tuple[str, dict[str, float]]:
        """Evaluate all metrics for one item, using checkpoint to skip already-done ones."""
        item_id = str(item.get("id", ""))
        all_metrics = _all_metrics_for(item)
        cached = checkpoint.get(item_id, {})

        # Determine which metrics still need to be computed
        needed = [m for m in all_metrics if not _checkpoint_has_all(cached, [m])]
        if not needed:
            # All metrics cached — skip entirely
            return item_id, {m: cached[m] for m in all_metrics if m in cached}

        qt = item.get("question_type", "Unknown")
        gen_metrics_needed = [m for m in (generation_config.get(qt, [])) if m in needed]
        ret_metrics_needed = [m for m in retrieval_metrics if m in needed]

        new_scores: dict[str, float] = {}
        async with semaphore:
            if gen_metrics_needed:
                s = await _evaluate_one(item, gen_metrics_needed, metric_fns, llm, embeddings)
                new_scores.update(s)
            if ret_metrics_needed:
                s = await _evaluate_one(item, ret_metrics_needed, metric_fns, llm, embeddings)
                new_scores.update(s)

        # Merge with cache and persist
        merged = {**cached, **new_scores}
        checkpoint[item_id] = merged
        if checkpoint_path is not None:
            _save_checkpoint_item(checkpoint_path, item_id, merged)

        return item_id, {m: merged.get(m, float("nan")) for m in all_metrics}

    # ---- Run all items in parallel ----
    tasks = [_eval_item(item) for item in data]
    item_results: dict[str, dict[str, float]] = {}  # id → scores
    completed = 0
    skipped = 0
    for future in asyncio.as_completed(tasks):
        try:
            item_id, scores = await future
            item_results[item_id] = scores
            # Count as skipped if nothing was actually evaluated (all came from cache)
            if item_id in checkpoint and _checkpoint_has_all(checkpoint[item_id], _all_metrics_for(data[0])):
                pass  # just track progress
        except Exception as exc:
            print(f"\n  [WARN] item eval failed: {exc}")
        completed += 1
        print(f"    {completed}/{len(data)}", end="\r", flush=True)
    print()

    # ---- Aggregate generation metrics by question type ----
    by_type: dict[str, list[dict]] = {}
    for item in data:
        qt = item.get("question_type", "Unknown")
        by_type.setdefault(qt, []).append(item)

    gen_results: dict[str, dict] = {}
    for qtype, items in by_type.items():
        gen_metrics = generation_config.get(qtype)
        if not gen_metrics:
            print(f"  [skip] unknown question_type: {qtype!r}")
            continue

        scores_list = [item_results[str(item["id"])] for item in items if str(item["id"]) in item_results]
        agg: dict[str, Any] = {"n": len(items)}
        for metric in gen_metrics:
            vals = [
                s[metric] for s in scores_list
                if metric in s and isinstance(s[metric], float) and not np.isnan(s[metric])
            ]
            agg[metric] = round(float(np.mean(vals)), 4) if vals else float("nan")
            agg[f"{metric}_count"] = len(vals)
        gen_results[qtype] = agg

    # ---- Aggregate retrieval metrics ----
    all_scores = list(item_results.values())
    ret_agg: dict[str, Any] = {"n": len(data)}
    for metric in retrieval_metrics:
        vals = [
            s[metric] for s in all_scores
            if metric in s and isinstance(s[metric], float) and not np.isnan(s[metric])
        ]
        ret_agg[metric] = round(float(np.mean(vals)), 4) if vals else float("nan")
        ret_agg[f"{metric}_count"] = len(vals)

    return {"by_type": gen_results, "retrieval": ret_agg}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main_async(args: argparse.Namespace) -> None:
    load_dotenv()

    metric_fns = METRIC_FNS

    # ---- Set up LLM (ChatOpenAI-compatible, temp=0, seed=42 per official) ----
    from langchain_openai import ChatOpenAI  # type: ignore[import]
    from pydantic import SecretStr  # type: ignore[import]

    llm_api_key = os.getenv("LLM_CHAT_API_KEY") or os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY", "")
    llm_base_url = os.getenv("LLM_CHAT_BASE_URL") or os.getenv("LLM_BASE_URL", "https://api.deepseek.com")
    llm_model = args.model or os.getenv("LLM_CHAT_MODEL") or os.getenv("LLM_MODEL", "deepseek-chat")

    print(f"LLM: {llm_model}  base_url: {llm_base_url}")
    llm = ChatOpenAI(
        model=llm_model,
        base_url=llm_base_url,
        api_key=SecretStr(llm_api_key),
        temperature=0.0,
        max_retries=5,
        timeout=120,
        seed=42,
    )

    # ---- Set up Embeddings (OpenAI-compatible, e.g. SiliconFlow BAAI/bge-m3) ----
    from langchain_openai import OpenAIEmbeddings  # type: ignore[import]

    emb_model = args.embedding_model or os.getenv("EMBEDDING_MODEL", "BAAI/bge-m3")
    emb_base_url = os.getenv("EMBEDDING_BASE_URL") or os.getenv("LLM_BASE_URL")
    emb_api_key = os.getenv("EMBEDDING_API_KEY") or os.getenv("LLM_API_KEY", "")

    print(f"Embeddings: {emb_model}  base_url: {emb_base_url}")
    embeddings = OpenAIEmbeddings(
        model=emb_model,
        base_url=emb_base_url,
        api_key=emb_api_key,
    )

    # ---- Load questions ----
    questions_path = Path(args.questions)
    questions: list[dict] = json.loads(questions_path.read_text(encoding="utf-8"))
    print(f"Questions loaded: {len(questions)}")

    # ---- Determine output dir ----
    results_dir = Path(args.output_dir) if args.output_dir else questions_path.parent.parent / "results"
    results_dir.mkdir(parents=True, exist_ok=True)

    # ---- Evaluate each strategy ----
    strategies: list[tuple[str, Path]] = []
    if args.naive and Path(args.naive).exists():
        strategies.append(("naive", Path(args.naive)))
    elif args.naive:
        print(f"[skip] naive answers not found: {args.naive}")
    if args.mix and Path(args.mix).exists():
        strategies.append(("mix", Path(args.mix)))
    elif args.mix:
        print(f"[skip] mix answers not found: {args.mix}")
    if args.agentic and Path(args.agentic).exists():
        strategies.append(("agentic", Path(args.agentic)))
    elif args.agentic:
        print(f"[skip] agentic answers not found: {args.agentic}")

    if not strategies:
        print("No answer files found. Provide at least one of --naive, --mix, --agentic.")
        return

    all_results: dict[str, dict] = {}

    for label, answers_path in strategies:
        answers: list[dict] = json.loads(answers_path.read_text(encoding="utf-8"))

        # Apply limit
        if args.limit:
            limited_qs = questions[: args.limit]
            limited_ids = {str(q["id"]) for q in limited_qs}
            answers = [a for a in answers if str(a.get("id", "")) in limited_ids]
        else:
            limited_qs = questions

        print(f"\n{'=' * 60}")
        print(f"Evaluating: {label}  ({len(answers)} answers)")
        print("=" * 60)

        data = convert_to_official_format(limited_qs, answers)
        print(f"  Converted {len(data)} items to official format.")
        if not data:
            print("  [skip] no items after format conversion.")
            continue

        # ---- Load checkpoint (resume support) ----
        ckpt_path = results_dir / f"official_eval_{label}_items.jsonl"
        ckpt = _load_checkpoint(ckpt_path)
        if ckpt:
            cached_count = sum(
                1 for item in data
                if _checkpoint_has_all(
                    ckpt.get(str(item["id"]), {}),
                    (GENERATION_METRIC_CONFIG.get(item.get("question_type", ""), []) + RETRIEVAL_METRICS),
                )
            )
            print(f"  Checkpoint loaded: {len(ckpt)} records, {cached_count}/{len(data)} fully cached — will skip those.")

        eval_results = await _evaluate_dataset(
            data,
            GENERATION_METRIC_CONFIG,
            RETRIEVAL_METRICS,
            metric_fns,
            llm,
            embeddings,
            max_concurrent=args.concurrent,
            checkpoint=ckpt,
            checkpoint_path=ckpt_path,
        )
        all_results[label] = eval_results

        # ---- Print summary ----
        print(f"\n  === Results: {label} ===")
        for qtype, metrics in eval_results["by_type"].items():
            print(f"  [{qtype}]  n={metrics.get('n')}")
            for k, v in metrics.items():
                if k not in ("n",) and not k.endswith("_count"):
                    print(f"    {k}: {v:.4f}" if isinstance(v, float) else f"    {k}: {v}")
        print(f"  [Retrieval]  n={eval_results['retrieval'].get('n')}")
        for k, v in eval_results["retrieval"].items():
            if k not in ("n",) and not k.endswith("_count"):
                print(f"    {k}: {v:.4f}" if isinstance(v, float) else f"    {k}: {v}")

        # ---- Save per-strategy output ----
        out_path = results_dir / f"official_eval_{label}.json"
        out_path.write_text(json.dumps(eval_results, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n  Saved: {out_path}")

    # ---- Save combined output ----
    combined_path = results_dir / "official_eval_combined.json"
    combined_path.write_text(json.dumps(all_results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n✓ Combined results: {combined_path}")

    # ---- Print comparison table ----
    if len(all_results) >= 2:
        _print_comparison_table(all_results)


def _print_comparison_table(all_results: dict[str, dict]) -> None:
    """Print a compact comparison table across strategies."""
    print("\n" + "=" * 70)
    print("COMPARISON TABLE (official metrics)")
    print("=" * 70)

    # Collect all question types and metrics
    qtypes: list[str] = []
    for res in all_results.values():
        for qt in res.get("by_type", {}).keys():
            if qt not in qtypes:
                qtypes.append(qt)

    for qtype in qtypes:
        print(f"\n[{qtype}]")
        # Collect all metrics for this type
        all_metrics: list[str] = []
        for res in all_results.values():
            for m in res.get("by_type", {}).get(qtype, {}):
                if m not in ("n",) and not m.endswith("_count") and m not in all_metrics:
                    all_metrics.append(m)
        header = f"  {'Metric':<25}" + "".join(f"{label:>12}" for label in all_results.keys())
        print(header)
        print("  " + "-" * (25 + 12 * len(all_results)))
        for metric in all_metrics:
            row = f"  {metric:<25}"
            for res in all_results.values():
                v = res.get("by_type", {}).get(qtype, {}).get(metric, float("nan"))
                row += f"{v:>12.4f}" if isinstance(v, float) else f"{'N/A':>12}"
            print(row)

    print("\n[Retrieval]")
    all_ret_metrics: list[str] = []
    for res in all_results.values():
        for m in res.get("retrieval", {}):
            if m not in ("n",) and not m.endswith("_count") and m not in all_ret_metrics:
                all_ret_metrics.append(m)
    header = f"  {'Metric':<25}" + "".join(f"{label:>12}" for label in all_results.keys())
    print(header)
    print("  " + "-" * (25 + 12 * len(all_results)))
    for metric in all_ret_metrics:
        row = f"  {metric:<25}"
        for res in all_results.values():
            v = res.get("retrieval", {}).get(metric, float("nan"))
            row += f"{v:>12.4f}" if isinstance(v, float) else f"{'N/A':>12}"
        print(row)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Official GraphRAG-Bench evaluation (generation + retrieval metrics)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Full evaluation (all three strategies):
  python -m tests.eval.run_official_eval ^
    --questions tests/eval/data/graphrag_bench_questions.json ^
    --naive     tests/eval/results/graphrag_bench_naive_answers.json ^
    --mix       tests/eval/results/graphrag_bench_mix_answers.json ^
    --agentic   tests/eval/results/graphrag_bench_agentic_answers.json

  # Quick test with 10 questions, naive only:
  python -m tests.eval.run_official_eval ^
    --questions tests/eval/data/graphrag_bench_questions.json ^
    --naive     tests/eval/results/graphrag_bench_naive_answers.json ^
    --limit 10
""",
    )
    parser.add_argument(
        "--questions",
        default="tests/eval/data/graphrag_bench_questions.json",
        help="Path to questions JSON file",
    )
    parser.add_argument("--naive",   default=None, help="Path to naive answers JSON")
    parser.add_argument("--mix",     default=None, help="Path to mix answers JSON")
    parser.add_argument("--agentic", default=None, help="Path to agentic answers JSON")
    parser.add_argument(
        "--model",
        default=None,
        help="LLM model for evaluation (default: $LLM_CHAT_MODEL env var)",
    )
    parser.add_argument(
        "--embedding-model",
        default=None,
        dest="embedding_model",
        help="Embedding model (default: $EMBEDDING_MODEL env var, e.g. BAAI/bge-m3)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Evaluate only the first N questions (quick test)",
    )
    parser.add_argument(
        "--concurrent",
        type=int,
        default=3,
        help="Max concurrent LLM calls (default: 3)",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Directory to save results (default: tests/eval/results/)",
    )
    args = parser.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
