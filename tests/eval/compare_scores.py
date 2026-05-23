"""Generate per-question pivot CSVs comparing naive/mix/agentic scores.

Produces:
  tests/eval/results/compare_faithfulness.csv
  tests/eval/results/compare_answer_relevancy.csv

Each row = one question; columns = naive, mix, agentic scores + best mode.
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

RESULTS_DIR = Path("tests/eval/results")
QUESTIONS_PATH = Path("tests/eval/data/ragas_custom_questions.json")
PREFIXES = ["naive", "mix", "agentic"]
METRICS = ["faithfulness", "answer_relevancy"]

EVO = {
    "single_hop_specific_query_synthesizer": "single_hop",
    "multi_hop_specific_query_synthesizer": "multi_hop_specific",
    "multi_hop_abstract_query_synthesizer": "multi_hop_abstract",
}


def _detect_lang(text: str) -> str:
    cn = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    return "zh" if cn / max(len(text), 1) > 0.1 else "en"


def main() -> None:
    qs = json.loads(QUESTIONS_PATH.read_text(encoding="utf-8"))
    q_map = {str(q["id"]): q for q in qs}

    # Load all scores keyed by (qid, prefix)
    scores: dict[str, dict[str, dict]] = {}
    for prefix in PREFIXES:
        path = RESULTS_DIR / f"ragas_{prefix}_scores.csv"
        if not path.exists():
            print(f"[skip] {path.name} not found")
            continue
        with open(path, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                qid = str(row["question_id"])
                if qid not in scores:
                    scores[qid] = {}
                scores[qid][prefix] = row

    all_qids = sorted(scores.keys(), key=lambda x: int(x) if x.isdigit() else x)
    print(f"Questions with scores in any mode: {len(all_qids)}")

    for metric in METRICS:
        out_path = RESULTS_DIR / f"compare_{metric}.csv"
        with open(out_path, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.writer(f)
            writer.writerow(["id", "lang", "question_type", "question",
                             "naive", "mix", "agentic", "best"])
            for qid in all_qids:
                q = q_map.get(qid, {})
                question = q.get("question", "")
                lang = _detect_lang(question)
                evo = EVO.get(q.get("evolution_type", ""), q.get("evolution_type", ""))

                row_scores: dict[str, float | None] = {}
                for prefix in PREFIXES:
                    try:
                        raw = scores[qid][prefix][metric]
                        row_scores[prefix] = float(raw) if raw not in ("", None) else None
                    except (KeyError, ValueError):
                        row_scores[prefix] = None

                valid = {k: v for k, v in row_scores.items() if v is not None}
                best = max(valid, key=lambda k: valid[k]) if valid else ""

                def fmt(v: float | None) -> str:
                    return f"{v:.4f}" if v is not None else ""

                writer.writerow([
                    qid, lang, evo, question,
                    fmt(row_scores.get("naive")),
                    fmt(row_scores.get("mix")),
                    fmt(row_scores.get("agentic")),
                    best,
                ])

        print(f"Saved: {out_path}")

    # Quick summary: how many questions each mode wins per metric
    print()
    for metric in METRICS:
        out_path = RESULTS_DIR / f"compare_{metric}.csv"
        with open(out_path, encoding="utf-8-sig") as f:
            rows = list(csv.DictReader(f))
        wins = {p: 0 for p in PREFIXES}
        ties = 0
        for row in rows:
            best = row["best"]
            if best in wins:
                wins[best] += 1
            elif best == "":
                pass
            else:
                ties += 1
        total = len(rows)
        print(f"[{metric}] wins out of {total} questions:")
        for p, w in wins.items():
            print(f"  {p}: {w} ({w/total*100:.1f}%)")


if __name__ == "__main__":
    main()
