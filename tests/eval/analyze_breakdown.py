"""Break down Ragas eval scores by language and question type.

Usage:
  python -m tests.eval.analyze_breakdown
  python -m tests.eval.analyze_breakdown --output tests/eval/results/breakdown.json
"""
from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from pathlib import Path

RESULTS_DIR = Path("tests/eval/results")
QUESTIONS_PATH = Path("tests/eval/data/ragas_custom_questions.json")

METRIC_COLS = [
    "answer_relevancy",
    "faithfulness",
    "context_recall",
    "llm_judge_correctness",
]

PREFIXES = ["naive", "mix", "agentic"]

_EVOLUTION_LABELS = {
    "single_hop_specific_query_synthesizer": "single_hop",
    "multi_hop_specific_query_synthesizer": "multi_hop_specific",
    "multi_hop_abstract_query_synthesizer": "multi_hop_abstract",
}


def _detect_lang(text: str) -> str:
    cn = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    return "zh" if cn / max(len(text), 1) > 0.1 else "en"


def _load_questions() -> dict[str, dict]:
    qs = json.loads(QUESTIONS_PATH.read_text(encoding="utf-8"))
    result = {}
    for q in qs:
        qid = str(q["id"])
        result[qid] = {
            "lang": _detect_lang(q["question"]),
            "evolution_type": _EVOLUTION_LABELS.get(
                q.get("evolution_type", ""), q.get("evolution_type", "unknown")
            ),
        }
    return result


def _load_scores(prefix: str) -> list[dict]:
    path = RESULTS_DIR / f"ragas_{prefix}_scores.csv"
    if not path.exists():
        return []
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _mean(vals: list[float]) -> float | None:
    clean = [v for v in vals if v == v]  # drop NaN
    return round(sum(clean) / len(clean), 4) if clean else None


def _group_stats(rows: list[dict], meta: dict[str, dict], group_key: str) -> dict:
    groups: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        qid = str(row["question_id"])
        val = meta.get(qid, {}).get(group_key, "unknown")
        groups[val].append(row)

    result = {}
    for group_val, group_rows in sorted(groups.items()):
        stats: dict = {"n": len(group_rows)}
        for col in METRIC_COLS:
            vals = []
            for r in group_rows:
                try:
                    vals.append(float(r[col]))
                except (KeyError, ValueError, TypeError):
                    pass
            stats[col] = _mean(vals)
        result[group_val] = stats
    return result


def _group_stats_all(
    answered_ids: set[str],
    scored_rows: list[dict],
    meta: dict[str, dict],
    group_key: str,
) -> dict:
    """Like _group_stats but pads unanswered questions as 0 for all metrics."""
    # Build answered scores keyed by question_id
    score_by_id: dict[str, dict] = {}
    for row in scored_rows:
        score_by_id[str(row["question_id"])] = row

    # Group ALL questions in meta by the given key
    groups: dict[str, list[str]] = defaultdict(list)
    for qid, info in meta.items():
        val = info.get(group_key, "unknown")
        groups[val].append(qid)

    result = {}
    for group_val, qids in sorted(groups.items()):
        n_total = len(qids)
        n_answered = sum(1 for qid in qids if qid in answered_ids)
        stats: dict = {"n_total": n_total, "n_answered": n_answered}
        for col in METRIC_COLS:
            vals: list[float] = []
            for qid in qids:
                if qid in score_by_id:
                    try:
                        vals.append(float(score_by_id[qid][col]))
                    except (KeyError, ValueError, TypeError):
                        vals.append(0.0)
                else:
                    vals.append(0.0)
            stats[col] = round(sum(vals) / len(vals), 4) if vals else None
        result[group_val] = stats
    return result


def _filter_rows(rows: list[dict], keep_ids: set[str]) -> list[dict]:
    return [r for r in rows if str(r["question_id"]) in keep_ids]


def main(output_path: str) -> None:
    meta = _load_questions()

    # Load all rows first so we can compute the intersection
    all_rows: dict[str, list[dict]] = {}
    for prefix in PREFIXES:
        rows = _load_scores(prefix)
        if rows:
            all_rows[prefix] = rows

    # Intersection: question IDs answered by every available mode
    id_sets = [
        {str(r["question_id"]) for r in rows}
        for rows in all_rows.values()
    ]
    intersection_ids: set[str] = id_sets[0].intersection(*id_sets[1:]) if id_sets else set()
    print(f"\nIntersection (all modes answered): {len(intersection_ids)} questions")

    report: dict = {}
    report_all: dict = {}
    report_intersection: dict = {}

    for prefix in PREFIXES:
        rows = all_rows.get(prefix)
        if not rows:
            print(f"[skip] No scores for {prefix}")
            continue

        answered_ids = {str(r["question_id"]) for r in rows}
        inter_rows = _filter_rows(rows, intersection_ids)

        print(f"\n=== {prefix} (n={len(rows)}, intersection={len(inter_rows)}) ===")

        by_lang = _group_stats(rows, meta, "lang")
        by_type = _group_stats(rows, meta, "evolution_type")
        by_lang_all = _group_stats_all(answered_ids, rows, meta, "lang")
        by_type_all = _group_stats_all(answered_ids, rows, meta, "evolution_type")
        by_lang_inter = _group_stats(inter_rows, meta, "lang")
        by_type_inter = _group_stats(inter_rows, meta, "evolution_type")

        report[prefix] = {
            "by_language": by_lang,
            "by_question_type": by_type,
        }
        report_all[prefix] = {
            "by_language": by_lang_all,
            "by_question_type": by_type_all,
        }
        report_intersection[prefix] = {
            "n_intersection": len(inter_rows),
            "by_language": by_lang_inter,
            "by_question_type": by_type_inter,
        }

        for breakdown_name, breakdown in [("by_language", by_lang), ("by_question_type", by_type)]:
            print(f"\n  [{breakdown_name}]")
            header = f"  {'group':<28}" + "".join(f"  {m[:12]:>12}" for m in METRIC_COLS) + f"  {'n':>5}"
            print(header)
            print("  " + "-" * (28 + 14 * len(METRIC_COLS) + 7))
            for group_val, stats in breakdown.items():
                row_str = f"  {group_val:<28}"
                for m in METRIC_COLS:
                    v = stats.get(m)
                    row_str += f"  {v:>12.4f}" if v is not None else f"  {'N/A':>12}"
                row_str += f"  {stats['n']:>5}"
                print(row_str)

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n✓ Saved: {out}")

    out_all = out.with_name(out.stem + "_all" + out.suffix)
    out_all.write_text(json.dumps(report_all, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✓ Saved: {out_all}")

    out_inter = out.with_name(out.stem + "_intersection" + out.suffix)
    out_inter.write_text(json.dumps(report_intersection, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✓ Saved: {out_inter}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        default="tests/eval/results/breakdown.json",
    )
    args = parser.parse_args()
    main(args.output)
