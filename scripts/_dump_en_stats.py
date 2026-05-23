"""Dump EN-only stats broken down by question type."""
import csv
import json
from collections import defaultdict
from pathlib import Path

RESULTS_DIR = Path("tests/eval/results")
QUESTIONS_PATH = Path("tests/eval/data/ragas_custom_questions.json")
PREFIXES = ["naive", "mix", "agentic"]
METRICS = ["answer_relevancy", "faithfulness", "context_recall", "llm_judge_correctness", "context_precision"]
CP_COL = "llm_context_precision_with_reference"

_EVOLUTION_LABELS = {
    "single_hop_specific_query_synthesizer": "single_hop",
    "multi_hop_specific_query_synthesizer": "multi_hop_specific",
    "multi_hop_abstract_query_synthesizer": "multi_hop_abstract",
}


def load_questions():
    qs = json.loads(QUESTIONS_PATH.read_text(encoding="utf-8"))
    result = {}
    for q in qs:
        qid = str(q["id"])
        text = q["question"]
        cn = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
        lang = "zh" if cn / max(len(text), 1) > 0.1 else "en"
        qtype = _EVOLUTION_LABELS.get(q.get("evolution_type", ""), q.get("evolution_type", "unknown"))
        result[qid] = {"lang": lang, "qtype": qtype}
    return result


def load_judge_state(prefix):
    p = RESULTS_DIR / f"ragas_{prefix}_judge_state.json"
    if not p.exists():
        return set()
    return {str(k) for k in json.loads(p.read_text(encoding="utf-8"))}


def load_scores(prefix):
    p = RESULTS_DIR / f"ragas_{prefix}_scores.csv"
    if not p.exists():
        return {}
    result = {}
    with open(p, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            qid = str(row["question_id"])
            vals = {}
            for m in ["answer_relevancy", "faithfulness", "context_recall", "llm_judge_correctness"]:
                try:
                    vals[m] = float(row[m])
                except (KeyError, ValueError, TypeError):
                    pass
            if vals:
                result[qid] = vals
    return result


def load_cp(prefix):
    p = RESULTS_DIR / f"ragas_{prefix}_cp_scores.csv"
    if not p.exists():
        return {}
    result = {}
    with open(p, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            try:
                result[str(row["question_id"])] = float(row[CP_COL])
            except (KeyError, ValueError, TypeError):
                pass
    return result


def compute(qids, scores, cp, judged):
    judged_q = [q for q in qids if q in judged]
    ans_q = [q for q in judged_q if q in scores]
    n_j = len(judged_q)
    n_a = len(ans_q)
    row = {"n_judged": n_j, "n_answered": n_a, "answer_rate": round(n_a / n_j, 4) if n_j else 0}
    for m in METRICS:
        is_cp = (m == "context_precision")
        full_s, ans_vals = 0.0, []
        for qid in judged_q:
            v = cp.get(qid) if is_cp else scores.get(qid, {}).get(m)
            if v is not None and v == v:
                full_s += v
                ans_vals.append(v)
        row[m] = round(full_s / n_j, 4) if n_j else None
        row[m + "_answered"] = round(sum(ans_vals) / len(ans_vals), 4) if ans_vals else None
    return row


def main():
    meta = load_questions()
    judge_states = {p: load_judge_state(p) for p in PREFIXES}
    all_scores = {p: load_scores(p) for p in PREFIXES}
    all_cp = {p: load_cp(p) for p in PREFIXES}

    en_by_type = defaultdict(list)
    en_all = []
    for qid, info in meta.items():
        if info["lang"] == "en":
            en_by_type[info["qtype"]].append(qid)
            en_all.append(qid)

    print(f"EN total questions: {len(en_all)}")
    for qt, ids in sorted(en_by_type.items()):
        print(f"  {qt}: {len(ids)}")

    print("\n=== EN OVERALL ===")
    for prefix in PREFIXES:
        d = compute(en_all, all_scores[prefix], all_cp[prefix], judge_states[prefix])
        print(f"\n{prefix}: judged={d['n_judged']} answered={d['n_answered']} rate={d['answer_rate']}")
        print("  full:     " + "  ".join(f"{m}={d[m]}" for m in METRICS))
        print("  answered: " + "  ".join(f"{m}={d[m+'_answered']}" for m in METRICS))

    print("\n=== EN BY QUESTION TYPE ===")
    for qt in ["single_hop", "multi_hop_specific", "multi_hop_abstract"]:
        qids = en_by_type.get(qt, [])
        print(f"\n{qt} ({len(qids)} EN questions):")
        for prefix in PREFIXES:
            d = compute(qids, all_scores[prefix], all_cp[prefix], judge_states[prefix])
            print(f"  {prefix}: judged={d['n_judged']} answered={d['n_answered']} rate={d['answer_rate']}")
            print("    full:     " + "  ".join(f"{m}={d[m]}" for m in METRICS))
            print("    answered: " + "  ".join(f"{m}={d[m+'_answered']}" for m in METRICS))


main()
