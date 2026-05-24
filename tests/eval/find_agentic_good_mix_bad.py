"""
找出 agentic 效果好、mix 效果差的案例，用于论文示例展示。
"""
import csv

def load_csv(path):
    rows = {}
    with open(path, encoding='utf-8') as f:
        for row in csv.DictReader(f):
            qid = row['question_id']
            rows[qid] = row
    return rows

agentic = load_csv(r'tests/eval/results/ragas_agentic_scores.csv')
mix     = load_csv(r'tests/eval/results/ragas_mix_scores.csv')

candidates = []
for qid in agentic:
    if qid not in mix:
        continue
    a = agentic[qid]
    m = mix[qid]
    try:
        a_correct = float(a['llm_judge_correctness'] or 0)
        m_correct = float(m['llm_judge_correctness'] or 0)
        a_recall  = float(a['context_recall'] or 0)
        m_recall  = float(m['context_recall'] or 0)
        a_faith   = float(a['faithfulness'] or 0)
        m_faith   = float(m['faithfulness'] or 0)
        a_rel     = float(a['answer_relevancy'] or 0)
        m_rel     = float(m['answer_relevancy'] or 0)

        diff = a_correct - m_correct
        if diff >= 0.2:
            candidates.append({
                'qid': qid,
                'question': a['user_input'],
                'a_correct': a_correct, 'm_correct': m_correct,
                'a_recall': a_recall,   'm_recall': m_recall,
                'a_faith': a_faith,     'm_faith': m_faith,
                'a_rel': a_rel,         'm_rel': m_rel,
                'diff': diff,
            })
    except Exception as e:
        print(f'Skip {qid}: {e}')

candidates.sort(key=lambda x: (-x['diff'], -x['a_correct']))

print(f"找到 {len(candidates)} 个候选案例 (agentic 正确率比 mix 高 ≥ 0.2):\n")
for i, c in enumerate(candidates):
    print(f"[{i+1}] QID: {c['qid']}")
    print(f"     问题: {c['question'][:100]}")
    print(f"     Agentic: correctness={c['a_correct']:.2f}, recall={c['a_recall']:.2f}, faith={c['a_faith']:.2f}, rel={c['a_rel']:.2f}")
    print(f"     Mix:     correctness={c['m_correct']:.2f}, recall={c['m_recall']:.2f}, faith={c['m_faith']:.2f}, rel={c['m_rel']:.2f}")
    print(f"     差距: {c['diff']:.2f}")
    print()
