import json

d = json.load(open("tests/eval/results/breakdown_intersection.json", encoding="utf-8"))
metrics = ["answer_relevancy", "faithfulness", "context_recall", "llm_judge_correctness"]
labels = ["ans_rel", "faith", "ctx_rec", "judge"]

print("=== 交集 84 题：by_question_type ===")
for qt in ["multi_hop_abstract", "multi_hop_specific", "single_hop"]:
    print(f"\n  {qt}")
    for mode in ["naive", "mix", "agentic"]:
        stats = d[mode]["by_question_type"].get(qt, {})
        n = stats.get("n", 0)
        vals = "  ".join(f"{lbl}={stats.get(m, 0):.4f}" for m, lbl in zip(metrics, labels))
        print(f"    {mode:<10} n={n:3d}  {vals}")

print()
print("=== 交集 84 题：by_language ===")
for lang in ["en", "zh"]:
    print(f"\n  {lang}")
    for mode in ["naive", "mix", "agentic"]:
        stats = d[mode]["by_language"].get(lang, {})
        n = stats.get("n", 0)
        vals = "  ".join(f"{lbl}={stats.get(m, 0):.4f}" for m, lbl in zip(metrics, labels))
        print(f"    {mode:<10} n={n:3d}  {vals}")
