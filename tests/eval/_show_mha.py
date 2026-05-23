import json

d = json.load(open("tests/eval/results/breakdown.json"))
metrics = ["n", "answer_relevancy", "faithfulness", "context_recall", "llm_judge_correctness"]

print("=== multi_hop_abstract ===")
for mode in d:
    row = d[mode]["by_question_type"].get("multi_hop_abstract", {})
    parts = []
    for m in metrics:
        v = row.get(m, "?")
        parts.append(f"{m}={v}" if m == "n" else f"{m}={v:.4f}")
    print(f"{mode:10s}: " + " | ".join(parts))

print()
print("=== single_hop_specific ===")
for mode in d:
    row = d[mode]["by_question_type"].get("single_hop_specific", {})
    parts = []
    for m in metrics:
        v = row.get(m, "?")
        parts.append(f"{m}={v}" if m == "n" else f"{m}={v:.4f}")
    print(f"{mode:10s}: " + " | ".join(parts))
