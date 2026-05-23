"""Find questions where naive=IDK but agentic/mix answered."""
import json
import pathlib

results = pathlib.Path("tests/eval/results")
data_dir = pathlib.Path("tests/eval/data")


def load(f):
    return {str(a["id"]): a for a in json.loads((results / f).read_text(encoding="utf-8"))}


naive = load("answers_naive.json")
mix = load("answers_mix.json")
agentic = load("answers_agentic.json")

IDK = ["i don't know", "i do not know", "i dont know", "未能找到"]


def is_idk(ans):
    t = str(ans.get("generated_answer", "")).lower().strip()
    return not t or any(p in t for p in IDK)


print(f"naive  total={len(naive)}, agentic total={len(agentic)}, mix total={len(mix)}")

compared_ids = set(naive) & (set(agentic) | set(mix))
wins = []
for qid in sorted(compared_ids, key=lambda x: int(x)):
    n_idk = is_idk(naive.get(qid, {}))
    a_ok = qid in agentic and not is_idk(agentic[qid])
    m_ok = qid in mix and not is_idk(mix[qid])
    if n_idk and (a_ok or m_ok):
        wins.append((qid, a_ok, m_ok))

print(f"\nNaive IDK but agentic/mix answered: {len(wins)} questions\n")

q_data = json.loads((data_dir / "ragas_custom_questions.json").read_text(encoding="utf-8"))
q_map = {str(q["id"]): q for q in q_data}

for qid, a_ok, m_ok in wins:
    q = q_map.get(qid, {})
    print(f"id={qid}  agentic={a_ok}  mix={m_ok}")
    print(f"  Q: {q.get('question', '')[:100]}")
    print(f"  naive:   {naive[qid]['generated_answer'][:80]!r}")
    if a_ok and qid in agentic:
        print(f"  agentic: {agentic[qid]['generated_answer'][:100]!r}")
    if m_ok and qid in mix:
        print(f"  mix:     {mix[qid]['generated_answer'][:100]!r}")
    print()
