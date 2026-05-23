"""Compare mix vs agentic RAGAS scores: find questions where mix > agentic."""
import csv
import pathlib

results = pathlib.Path("tests/eval/results")


def load_scores(f):
    rows = list(csv.DictReader((results / f).open(encoding="utf-8")))
    return {r["question_id"]: r for r in rows}


mix = load_scores("ragas_mix_scores.csv")
agt = load_scores("ragas_agentic_scores.csv")

METRICS = ["context_recall", "faithfulness", "answer_relevancy", "llm_judge_correctness"]

common = set(mix) & set(agt)
print(f"Common questions: {len(common)}  (mix={len(mix)}, agentic={len(agt)})\n")

wins = []  # (qid, recall_gap, faith_gap, row_mix, row_agt)
for qid in common:
    m = mix[qid]
    a = agt[qid]

    def val(row, col):
        v = row.get(col, "")
        return float(v) if v not in ("", "nan", "None", None) else None

    recall_m = val(m, "context_recall")
    recall_a = val(a, "context_recall")
    faith_m = val(m, "faithfulness")
    faith_a = val(a, "faithfulness")

    # mix better on recall or faithfulness (both non-None)
    recall_gap = (recall_m - recall_a) if (recall_m is not None and recall_a is not None) else None
    faith_gap = (faith_m - faith_a) if (faith_m is not None and faith_a is not None) else None

    is_mix_better = (recall_gap is not None and recall_gap > 0.1) or (
        faith_gap is not None and faith_gap > 0.1
    )
    if is_mix_better:
        wins.append((qid, recall_gap, faith_gap, m, a))

# Sort by sum of gaps descending
wins.sort(key=lambda x: (x[1] or 0) + (x[2] or 0), reverse=True)

print(f"Mix significantly better than agentic (gap>0.1 on recall or faithfulness): {len(wins)} questions\n")
print(f"{'id':>4}  {'recall_gap':>10}  {'faith_gap':>9}  {'rec_mix':>7}  {'rec_agt':>7}  {'fai_mix':>7}  {'fai_agt':>7}")
print("-" * 80)

detail = []
for qid, rdiff, fdiff, m, a in wins:
    def v(row, col):
        x = row.get(col, "")
        return float(x) if x not in ("", "nan", "None", None) else float("nan")

    print(
        f"{qid:>4}  {rdiff or 0:+10.3f}  {fdiff or 0:+9.3f}"
        f"  {v(m,'context_recall'):7.3f}  {v(a,'context_recall'):7.3f}"
        f"  {v(m,'faithfulness'):7.3f}  {v(a,'faithfulness'):7.3f}"
    )
    detail.append((qid, m["user_input"][:80], m, a))

print("\n\n=== Detailed Questions ===\n")
for qid, rdiff2, fdiff2, m, a in wins[:15]:
    q_text = m["user_input"][:80]
    def vs(col):
        mv = m.get(col, ""); av = a.get(col, "")
        mf = float(mv) if mv not in ("", "nan", "None", None) else None
        af = float(av) if av not in ("", "nan", "None", None) else None
        ms = f"{mf:.3f}" if mf is not None else "N/A"
        as_ = f"{af:.3f}" if af is not None else "N/A"
        return f"mix={ms} agt={as_}"

    print(f"[id={qid}]")
    print(f"  Q: {q_text}")
    print(f"  context_recall:  {vs('context_recall')}")
    print(f"  faithfulness:    {vs('faithfulness')}")
    print(f"  answer_relevancy:{vs('answer_relevancy')}")
    print(f"  llm_correctness: {vs('llm_judge_correctness')}")
    print(f"  mix_ans:  {m.get('response','')[:80]!r}")
    print(f"  agt_ans:  {a.get('response','')[:80]!r}")
    print()
