import csv, json

scores_by_qid = {}
with open('tests/eval/results/ragas_agentic_scores.csv', encoding='utf-8') as f:
    r = csv.DictReader(f)
    for row in r:
        qid = row['question_id']
        try:
            correctness = float(row['llm_judge_correctness'])
        except Exception:
            correctness = None
        scores_by_qid[qid] = {
            'correctness': correctness,
            'user_input': row['user_input']
        }

with open('tests/eval/results/answers_agentic.json', encoding='utf-8') as f:
    answers = json.load(f)

excellent = []
for a in answers:
    qid = a['id']
    tool_count = a.get('tool_call_count', 0)
    if tool_count <= 1:
        continue
    score_info = scores_by_qid.get(qid, {})
    correctness = score_info.get('correctness')
    if correctness is None or correctness < 0.85:
        continue
    excellent.append({'qid': qid, 'tool_calls': tool_count, 'correctness': correctness, 'question': score_info.get('user_input', '')})

excellent.sort(key=lambda x: int(x['qid']))
print("correctness>=0.85, tool_calls>1: %d 题\n" % len(excellent))
for item in excellent:
    print("[qid %s] (工具调用 %d 次, correctness=%.2f)" % (item['qid'], item['tool_calls'], item['correctness']))
    print("  " + item['question'])
    print()
