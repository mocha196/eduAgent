"""查看候选案例的具体内容"""
import csv, json

def load_csv(path):
    rows = {}
    with open(path, encoding='utf-8') as f:
        for row in csv.DictReader(f):
            rows[row['question_id']] = row
    return rows

agentic = load_csv('tests/eval/results/ragas_agentic_scores.csv')
mix = load_csv('tests/eval/results/ragas_mix_scores.csv')

for qid in ['17', '155', '38', '126', '149']:
    a = agentic.get(qid, {})
    m = mix.get(qid, {})
    print(f'=== QID {qid} ===')
    print(f'问题: {a.get("user_input", "")}')
    print(f'标准答案: {a.get("reference", "")[:300]}')
    print()
    print(f'[Agentic] correctness={a.get("llm_judge_correctness")}, recall={a.get("context_recall")}')
    print(f'回答: {a.get("response", "")[:400]}')
    ctxs = a.get('retrieved_contexts', '')
    print(f'检索上下文(前200字): {str(ctxs)[:200]}')
    print()
    print(f'[Mix] correctness={m.get("llm_judge_correctness")}, recall={m.get("context_recall")}')
    print(f'回答: {m.get("response", "")[:400]}')
    ctxs = m.get('retrieved_contexts', '')
    print(f'检索上下文(前200字): {str(ctxs)[:200]}')
    print()
    print('='*80)
    print()
