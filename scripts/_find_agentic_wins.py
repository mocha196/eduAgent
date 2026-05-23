import csv, json

def load_csv(path):
    with open(path, encoding='utf-8') as f:
        return list(csv.DictReader(f))

agentic = {r['question_id']: r for r in load_csv('tests/eval/results/ragas_agentic_scores.csv')}
naive = {r['question_id']: r for r in load_csv('tests/eval/results/ragas_naive_scores.csv')}
mix = {r['question_id']: r for r in load_csv('tests/eval/results/ragas_mix_scores.csv')}

print('Total questions - agentic:', len(agentic), 'naive:', len(naive), 'mix:', len(mix))
print()

# Find questions where agentic scores high but naive/mix score low
results = []
for qid in agentic:
    if qid not in naive or qid not in mix:
        continue
    a_score = float(agentic[qid]['llm_judge_correctness'] or 0)
    n_score = float(naive[qid]['llm_judge_correctness'] or 0)
    m_score = float(mix[qid]['llm_judge_correctness'] or 0)
    a_answered = agentic[qid].get('is_answered', 'True') == 'True'

    if a_score >= 0.75 and n_score <= 0.5 and m_score <= 0.5 and a_answered:
        results.append({
            'qid': qid,
            'agentic_correctness': a_score,
            'naive_correctness': n_score,
            'mix_correctness': m_score,
            'gap': a_score - max(n_score, m_score),
            'question': agentic[qid]['user_input'],
            'agentic_response': agentic[qid]['response'],
            'naive_response': naive[qid]['response'],
            'mix_response': mix[qid]['response'],
            'reference': agentic[qid]['reference'],
        })

results.sort(key=lambda x: x['gap'], reverse=True)
print(f"Found {len(results)} cases where agentic wins significantly\n")
for r in results[:10]:
    print(f"Q{r['qid']}: agentic={r['agentic_correctness']:.2f} naive={r['naive_correctness']:.2f} mix={r['mix_correctness']:.2f} gap={r['gap']:.2f}")
    print(f"  Question: {r['question'][:120]}")
    print(f"  Reference: {r['reference'][:120]}")
    print(f"  Agentic: {r['agentic_response'][:200]}")
    print(f"  Naive: {r['naive_response'][:200]}")
    print(f"  Mix: {r['mix_response'][:200]}")
    print()
