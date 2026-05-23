"""Compare RAGAS scores across all retrieval modes: naive / bm25_only / mix / agentic.

Usage:
  python scripts/_compare_all_modes.py
  python scripts/_compare_all_modes.py --detail      # also show per-question breakdown
"""
from __future__ import annotations

import argparse
import csv
import math
import pathlib

RESULTS = pathlib.Path("tests/eval/results")

MODES = [
    ("naive",   "ragas_naive_scores.csv"),
    ("hybrid",  "ragas_hybrid_scores.csv"),
    ("mix",     "ragas_mix_scores.csv"),
    ("agentic", "ragas_agentic_scores.csv"),
]

METRICS = ["context_recall", "faithfulness", "answer_relevancy", "llm_judge_correctness"]


def _load(fname: str) -> list[dict]:
    p = RESULTS / fname
    if not p.exists():
        return []
    return list(csv.DictReader(p.open(encoding="utf-8")))


def _val(row: dict, col: str) -> float | None:
    v = row.get(col, "")
    if v in ("", "nan", "None", None):
        return None
    try:
        f = float(v)
        return None if math.isnan(f) else f
    except ValueError:
        return None


def _stats(rows: list[dict], col: str) -> tuple[float | None, float | None]:
    """Return (mean_all, mean_answered_only)."""
    all_vals = [_val(r, col) for r in rows]
    all_nums = [v for v in all_vals if v is not None]
    ans_nums = [_val(r, col) for r in rows
                if r.get("is_answered", "").lower() in ("true", "1", "yes")
                and _val(r, col) is not None]
    mean_all = sum(all_nums) / len(all_nums) if all_nums else None
    mean_ans = sum(ans_nums) / len(ans_nums) if ans_nums else None
    return mean_all, mean_ans


def main(detail: bool = False) -> None:
    # ── Summary table ──────────────────────────────────────────────────────
    print("\n=== RAGAS Score Comparison (all modes) ===\n")
    print(f"{'mode':<12} {'n':>4}  ", end="")
    for m in METRICS:
        short = m.replace("llm_judge_correctness", "correctness").replace("answer_relevancy", "relevancy")
        print(f"  {short:>10}", end="")
    print()
    print("-" * (16 + 14 * len(METRICS)))

    all_data: dict[str, list[dict]] = {}
    for label, fname in MODES:
        rows = _load(fname)
        all_data[label] = rows
        if not rows:
            print(f"  {label:<12} {'—':>4}  (file not found: {fname})")
            continue
        n = len(rows)
        n_ans = sum(1 for r in rows if r.get("is_answered", "").lower() in ("true", "1", "yes"))
        print(f"  {label:<12} {n:>4}  ", end="")
        for m in METRICS:
            mean_all, _ = _stats(rows, m)
            s = f"{mean_all:.3f}" if mean_all is not None else "  N/A"
            print(f"  {s:>10}", end="")
        print(f"   (answered={n_ans}/{n})")

    print()

    # ── Answered-only table ────────────────────────────────────────────────
    print("=== Same metrics — answered questions only ===\n")
    print(f"{'mode':<12} {'n_ans':>5}  ", end="")
    for m in METRICS:
        short = m.replace("llm_judge_correctness", "correctness").replace("answer_relevancy", "relevancy")
        print(f"  {short:>10}", end="")
    print()
    print("-" * (18 + 14 * len(METRICS)))

    for label, fname in MODES:
        rows = all_data.get(label, [])
        if not rows:
            continue
        n_ans = sum(1 for r in rows if r.get("is_answered", "").lower() in ("true", "1", "yes"))
        print(f"  {label:<12} {n_ans:>5}  ", end="")
        for m in METRICS:
            _, mean_ans = _stats(rows, m)
            s = f"{mean_ans:.3f}" if mean_ans is not None else "  N/A"
            print(f"  {s:>10}", end="")
        print()

    print()

    if not detail:
        return

    # ── Per-question detail: all modes with valid data on same question ────
    print("=== Per-question detail (common question IDs) ===\n")
    sets = [set(r["question_id"] for r in rows) for _, _ in MODES for rows in [all_data.get(MODES[0][0], [])]]
    # Build common IDs across all available modes
    available = [(label, all_data[label]) for label, _ in MODES if all_data.get(label)]
    if not available:
        return

    common_ids = set(r["question_id"] for r in available[0][1])
    for label, rows in available[1:]:
        common_ids &= {r["question_id"] for r in rows}

    idx: dict[str, dict[str, dict]] = {}
    for label, rows in available:
        for r in rows:
            qid = r["question_id"]
            if qid in common_ids:
                idx.setdefault(qid, {})[label] = r

    header = f"{'qid':>5}  {'question':.<40}  " + "  ".join(
        f"{lb:>9}" for lb, _ in available
    )
    for qid in sorted(common_ids, key=lambda x: int(x) if x.isdigit() else 0):
        rows_by_mode = idx[qid]
        first_row = next(iter(rows_by_mode.values()))
        q_text = first_row.get("user_input", "")[:38]
        for m in METRICS:
            short = m.replace("llm_judge_correctness", "correct").replace("answer_relevancy", "relevancy")[:9]
            scores = [
                f"{_val(rows_by_mode[lb], m):.2f}" if (lb in rows_by_mode and _val(rows_by_mode[lb], m) is not None) else " N/A"
                for lb, _ in available
            ]
            print(f"  {qid:>5}  [{short}]  {q_text:<40}  " + "  ".join(f"{s:>5}" for s in scores))
        print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Compare RAGAS scores across retrieval modes")
    parser.add_argument("--detail", action="store_true", help="Show per-question breakdown")
    args = parser.parse_args()
    main(args.detail)
