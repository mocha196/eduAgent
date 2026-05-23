"""Compare Ragas evaluation scores across naive / mix / agentic modes.

Reads the three *_summary.json files produced by eval_ragas_custom.py and prints
a side-by-side table.

Usage:
  python -m tests.eval.compare_modes
  python -m tests.eval.compare_modes --prefixes naive mix agentic
"""
from __future__ import annotations

import argparse
from pathlib import Path

from tests.eval._common import RESULTS_DIR, _bootstrap, load_json

_bootstrap()

_METRICS = [
    "answer_relevancy",
    "faithfulness",
    "llm_context_precision_with_reference",
    "context_recall",
]

_METRIC_LABELS = {
    "answer_relevancy":                       "Answer Relevancy",
    "faithfulness":                           "Faithfulness",
    "llm_context_precision_with_reference":   "Context Precision",
    "context_recall":                         "Context Recall",
}


def _load_summary(prefix: str) -> dict[str, float] | None:
    path = RESULTS_DIR / f"ragas_{prefix}_summary.json"
    if not path.exists():
        return None
    return load_json(path)


def _fmt(v: float | None) -> str:
    if v is None:
        return "  —   "
    return f"{v:.4f}"


def main(prefixes: list[str]) -> None:
    summaries: dict[str, dict[str, float] | None] = {}
    for p in prefixes:
        summaries[p] = _load_summary(p)

    # Discover all metric keys present in any summary
    all_keys: list[str] = []
    for key in _METRICS:
        for s in summaries.values():
            if s and key in s:
                if key not in all_keys:
                    all_keys.append(key)
                break
    # Append any extra keys not in _METRICS
    for s in summaries.values():
        if s:
            for k in s:
                if k not in all_keys:
                    all_keys.append(k)

    col_w = max(10, *(len(p) + 2 for p in prefixes))
    metric_w = max(len(_METRIC_LABELS.get(k, k)) for k in all_keys) + 2

    header = f"{'Metric':<{metric_w}}" + "".join(f"{p:^{col_w}}" for p in prefixes)
    sep = "-" * len(header)

    print("\n=== Ragas Score Comparison ===\n")
    for p, s in summaries.items():
        status = "OK" if s else "MISSING"
        print(f"  [{status}]  ragas_{p}_summary.json")
    print()
    print(header)
    print(sep)

    for key in all_keys:
        label = _METRIC_LABELS.get(key, key)
        row = f"{label:<{metric_w}}"
        for p in prefixes:
            s = summaries[p]
            val = s.get(key) if s else None
            row += f"{_fmt(val):^{col_w}}"
        print(row)

    print(sep)

    # Best-in-row highlight
    print("\n  Best score per metric:\n")
    for key in all_keys:
        label = _METRIC_LABELS.get(key, key)
        scores = {p: summaries[p].get(key) for p in prefixes if summaries[p]}
        valid = {p: v for p, v in scores.items() if v is not None}
        if not valid:
            continue
        best_p = max(valid, key=lambda p: valid[p])
        print(f"  {label:<{metric_w - 2}} → {best_p}  ({valid[best_p]:.4f})")

    print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Compare Ragas scores across modes")
    parser.add_argument(
        "--prefixes",
        nargs="+",
        default=["naive", "mix", "agentic"],
        help="List of output prefixes to compare (default: naive mix agentic)",
    )
    args = parser.parse_args()
    main(args.prefixes)
