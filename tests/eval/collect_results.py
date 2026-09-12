"""Collect and unify all evaluation statistics into result_0522.json.

分母逻辑：
  - 全量 (full): 以各模式 judge_state 中的题目数（147）为分母，未回答记 0。
    这样排除了从未收集过答案的 47 道题，只惩罚系统真正拒答的情况。
  - 仅已回答 (answered): 仅对 scores.csv 中的题目求均值，不含拒答惩罚。
  - 交集 (intersection): 三种模式均已回答的 84 道题，相同样本公平比较。

Usage:
  python -m tests.eval.collect_results
  python -m tests.eval.collect_results --output tests/eval/results/result_0522.json
"""
from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path

RESULTS_DIR = Path("tests/eval/results")
QUESTIONS_PATH = Path("tests/eval/data/ragas_custom_questions.json")
PREFIXES = ["naive", "mix", "agentic"]

RAGAS_METRICS = [
    "answer_relevancy",
    "faithfulness",
    "context_recall",
    "llm_judge_correctness",
]
CP_METRIC = "context_precision"
CP_COL = "llm_context_precision_with_reference"

_EVOLUTION_LABELS = {
    "single_hop_specific_query_synthesizer": "single_hop",
    "multi_hop_specific_query_synthesizer": "multi_hop_specific",
    "multi_hop_abstract_query_synthesizer": "multi_hop_abstract",
}


# ---------------------------------------------------------------------------
# Loaders
# ---------------------------------------------------------------------------

def _load_questions() -> dict[str, dict]:
    """Return {qid: {lang, question_type}} for all 194 questions."""
    qs = json.loads(QUESTIONS_PATH.read_text(encoding="utf-8"))
    result: dict[str, dict] = {}
    for q in qs:
        qid = str(q["id"])
        text = q["question"]
        cn = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
        lang = "zh" if cn / max(len(text), 1) > 0.1 else "en"
        qtype = _EVOLUTION_LABELS.get(
            q.get("evolution_type", ""), q.get("evolution_type", "unknown")
        )
        result[qid] = {"lang": lang, "question_type": qtype}
    return result


def _load_judge_state(prefix: str) -> set[str]:
    """Return set of question IDs that were actually attempted (judged)."""
    p = RESULTS_DIR / f"ragas_{prefix}_judge_state.json"
    if not p.exists():
        return set()
    data = json.loads(p.read_text(encoding="utf-8"))
    return {str(k) for k in data}


def _load_scores(prefix: str) -> dict[str, dict[str, float]]:
    """Return {qid: {metric: value}} for answered questions (from scores.csv)."""
    p = RESULTS_DIR / f"ragas_{prefix}_scores.csv"
    if not p.exists():
        return {}
    result: dict[str, dict[str, float]] = {}
    with open(p, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            qid = str(row["question_id"])
            vals: dict[str, float] = {}
            for col in RAGAS_METRICS:
                try:
                    vals[col] = float(row[col])
                except (KeyError, ValueError, TypeError):
                    pass
            if vals:
                result[qid] = vals
    return result


def _load_cp_scores(prefix: str) -> dict[str, float]:
    """Return {qid: context_precision} for answered questions (from cp_scores.csv)."""
    p = RESULTS_DIR / f"ragas_{prefix}_cp_scores.csv"
    if not p.exists():
        return {}
    result: dict[str, float] = {}
    with open(p, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            qid = str(row["question_id"])
            try:
                result[qid] = float(row[CP_COL])
            except (KeyError, ValueError, TypeError):
                pass
    return result


def _load_agentic_tool_stats() -> dict:
    """Aggregate paired tool_result data captured in answers_agentic.json."""
    path = RESULTS_DIR / "answers_agentic.json"
    if not path.exists():
        return {"total": 0, "completed": 0, "successful": 0, "success_rate": None,
                "average_duration_ms": None, "by_tool": {}}
    answers = json.loads(path.read_text(encoding="utf-8"))
    calls = [call for answer in answers for call in answer.get("tool_calls", [])]
    completed = [call for call in calls if call.get("success") is not None]
    durations = [float(call["duration_ms"]) for call in completed
                 if isinstance(call.get("duration_ms"), (int, float))]
    by_tool: dict[str, dict] = {}
    for name in sorted({str(call.get("name") or "unknown") for call in calls}):
        items = [call for call in calls if str(call.get("name") or "unknown") == name]
        done = [call for call in items if call.get("success") is not None]
        succeeded = sum(call.get("success") is True for call in done)
        tool_durations = [float(call["duration_ms"]) for call in done
                          if isinstance(call.get("duration_ms"), (int, float))]
        by_tool[name] = {
            "total": len(items),
            "completed": len(done),
            "successful": succeeded,
            "success_rate": _round4(succeeded / len(done)) if done else None,
            "average_duration_ms": _round4(sum(tool_durations) / len(tool_durations))
            if tool_durations else None,
        }
    successful = sum(call.get("success") is True for call in completed)
    return {
        "total": len(calls),
        "completed": len(completed),
        "successful": successful,
        "success_rate": _round4(successful / len(completed)) if completed else None,
        "average_duration_ms": _round4(sum(durations) / len(durations)) if durations else None,
        "by_tool": by_tool,
    }


# ---------------------------------------------------------------------------
# Stat computation helpers
# ---------------------------------------------------------------------------

def _round4(v: float) -> float:
    return round(v, 4)


def _compute_stats(
    qids: list[str],
    scores: dict[str, dict[str, float]],
    cp_scores: dict[str, float],
    judged_ids: set[str],
) -> dict:
    """Compute stats for a group of question IDs.

    For full/* metrics: denominator = number of qids that are in judged_ids.
    For answered/* metrics: denominator = number of qids that have scores (answered).
    Unanswered judged questions contribute 0 to full metrics.
    Un-judged questions are excluded from the denominator entirely.
    """
    # Only consider qids that were actually attempted
    judged_qids = [q for q in qids if q in judged_ids]
    answered_qids = [q for q in judged_qids if q in scores]
    n_judged = len(judged_qids)
    n_answered = len(answered_qids)

    result: dict = {
        "n_judged": n_judged,
        "n_answered": n_answered,
        "answer_rate": _round4(n_answered / n_judged) if n_judged > 0 else 0.0,
    }

    all_metrics = RAGAS_METRICS + [CP_METRIC]

    for metric in all_metrics:
        is_cp = metric == CP_METRIC
        src = cp_scores if is_cp else scores

        # Full: sum over judged, unanswered = 0
        full_sum = 0.0
        ans_vals: list[float] = []
        for qid in judged_qids:
            if is_cp:
                v = src.get(qid)  # type: ignore[arg-type]
            else:
                v = src.get(qid, {}).get(metric)  # type: ignore[union-attr]
            if v is not None and v == v:  # not NaN
                full_sum += v
                ans_vals.append(v)
            # else: unanswered → contributes 0 to sum, not counted in answered avg

        result[metric] = _round4(full_sum / n_judged) if n_judged > 0 else None
        result[f"{metric}_answered"] = (
            _round4(sum(ans_vals) / len(ans_vals)) if ans_vals else None
        )

    return result


def _compute_intersection_stats(
    qids: list[str],
    all_scores: dict[str, dict[str, dict[str, float]]],
    all_cp: dict[str, dict[str, float]],
) -> dict:
    """For intersection questions (all answered), compute per-mode stats. No padding needed."""
    result: dict = {"n": len(qids)}
    for prefix in PREFIXES:
        scores = all_scores[prefix]
        cp = all_cp[prefix]
        vals: dict[str, list[float]] = defaultdict(list)
        for qid in qids:
            for metric in RAGAS_METRICS:
                v = scores.get(qid, {}).get(metric)
                if v is not None and v == v:
                    vals[metric].append(v)
            cp_v = cp.get(qid)
            if cp_v is not None and cp_v == cp_v:
                vals[CP_METRIC].append(cp_v)
        mode_stats: dict[str, float | None] = {}
        for metric in RAGAS_METRICS + [CP_METRIC]:
            vs = vals[metric]
            mode_stats[metric] = _round4(sum(vs) / len(vs)) if vs else None
        result[prefix] = mode_stats
    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(output_path: str) -> None:
    meta = _load_questions()

    # Load per-prefix data
    judge_states: dict[str, set[str]] = {}
    all_scores: dict[str, dict[str, dict[str, float]]] = {}
    all_cp: dict[str, dict[str, float]] = {}

    for prefix in PREFIXES:
        judge_states[prefix] = _load_judge_state(prefix)
        all_scores[prefix] = _load_scores(prefix)
        all_cp[prefix] = _load_cp_scores(prefix)
        print(
            f"[{prefix}] judged={len(judge_states[prefix])} "
            f"answered={len(all_scores[prefix])} "
            f"cp_scored={len(all_cp[prefix])}"
        )

    # Intersection: question IDs answered by all modes
    answered_sets = [set(all_scores[p].keys()) for p in PREFIXES]
    intersection_ids = answered_sets[0].intersection(*answered_sets[1:])
    print(f"\nIntersection (all 3 answered): {len(intersection_ids)} questions")

    # Build group maps: lang and question_type
    lang_groups: dict[str, list[str]] = defaultdict(list)
    qtype_groups: dict[str, list[str]] = defaultdict(list)
    for qid, info in meta.items():
        lang_groups[info["lang"]].append(qid)
        qtype_groups[info["question_type"]].append(qid)

    all_qids = list(meta.keys())

    # ---------------------------------------------------------------------------
    # 1. Overall
    # ---------------------------------------------------------------------------
    overall: dict = {}
    for prefix in PREFIXES:
        overall[prefix] = _compute_stats(
            all_qids,
            all_scores[prefix],
            all_cp[prefix],
            judge_states[prefix],
        )

    # ---------------------------------------------------------------------------
    # 2. By language
    # ---------------------------------------------------------------------------
    by_language: dict = {}
    for lang, qids in sorted(lang_groups.items()):
        by_language[lang] = {}
        for prefix in PREFIXES:
            by_language[lang][prefix] = _compute_stats(
                qids,
                all_scores[prefix],
                all_cp[prefix],
                judge_states[prefix],
            )

    # ---------------------------------------------------------------------------
    # 3. By question type
    # ---------------------------------------------------------------------------
    by_question_type: dict = {}
    for qtype, qids in sorted(qtype_groups.items()):
        by_question_type[qtype] = {}
        for prefix in PREFIXES:
            by_question_type[qtype][prefix] = _compute_stats(
                qids,
                all_scores[prefix],
                all_cp[prefix],
                judge_states[prefix],
            )

    # ---------------------------------------------------------------------------
    # 4. Intersection: by language
    # ---------------------------------------------------------------------------
    inter_by_lang: dict = {}
    for lang, qids in sorted(lang_groups.items()):
        inter_qids = [q for q in qids if q in intersection_ids]
        inter_by_lang[lang] = _compute_intersection_stats(
            inter_qids, all_scores, all_cp
        )

    # ---------------------------------------------------------------------------
    # 5. Intersection: by question type
    # ---------------------------------------------------------------------------
    inter_by_qtype: dict = {}
    for qtype, qids in sorted(qtype_groups.items()):
        inter_qids = [q for q in qids if q in intersection_ids]
        inter_by_qtype[qtype] = _compute_intersection_stats(
            inter_qids, all_scores, all_cp
        )

    # ---------------------------------------------------------------------------
    # Assemble output
    # ---------------------------------------------------------------------------
    result = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "note": (
            "分母为各方案实际尝试回答的题目数（judge_state 中的题，通常=147），"
            "不含从未收集答案的题目。未回答（IDK）记0。"
            "context_precision 仅对已回答题目评测，全量时未回答记0。"
        ),
        "dataset_total": len(meta),
        "coverage": {
            prefix: {
                "judged": len(judge_states[prefix]),
                "answered": len(all_scores[prefix]),
                "answer_rate": _round4(
                    len(all_scores[prefix]) / len(judge_states[prefix])
                ) if judge_states[prefix] else 0.0,
            }
            for prefix in PREFIXES
        },
        "overall": overall,
        "agentic_tool_calls": _load_agentic_tool_stats(),
        "by_language": by_language,
        "by_question_type": by_question_type,
        "intersection": {
            "n": len(intersection_ids),
            "note": "三种模式均已回答的题目，分母=n，无拒答惩罚",
            "by_language": inter_by_lang,
            "by_question_type": inter_by_qtype,
        },
    }

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n✓ Saved to {out}")

    # Print quick summary
    print("\n=== Quick Summary (full, denom=judged) ===")
    header = f"{'metric':<32} {'naive':>8} {'mix':>8} {'agentic':>8}"
    print(header)
    print("-" * len(header))
    for metric in RAGAS_METRICS + [CP_METRIC]:
        row = f"{metric:<32}"
        for prefix in PREFIXES:
            v = overall[prefix].get(metric)
            row += f" {v:>8.4f}" if v is not None else f" {'N/A':>8}"
        print(row)
    print("\n=== Answer Rate ===")
    for prefix in PREFIXES:
        c = result["coverage"][prefix]
        print(f"  {prefix}: {c['answered']}/{c['judged']} = {c['answer_rate']:.1%}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        default="tests/eval/results/result_0522.json",
        help="Output JSON path",
    )
    args = parser.parse_args()
    main(args.output)
