import json, csv
from pathlib import Path

naive = json.load(open('tests/eval/results/answers_naive.json', encoding='utf-8'))
mix   = json.load(open('tests/eval/results/answers_mix.json',   encoding='utf-8'))
naive_map = {str(a['id']): a for a in naive}
mix_map   = {str(a['id']): a for a in mix}

faith = list(csv.DictReader(open('tests/eval/results/compare_faithfulness.csv', encoding='utf-8-sig')))

def gap(r):
    try: return float(r['naive'] or 0) - float(r['mix'] or 0)
    except: return 0

faith.sort(key=gap, reverse=True)

for r in faith[:3]:
    qid = r['id']
    print(f"=== QID {qid} | naive={r['naive']} mix={r['mix']} ===")
    print(f"Q: {r['question'][:80]}")
    na = naive_map.get(qid, {})
    mx = mix_map.get(qid, {})
    nc = na.get('retrieved_contexts', [])
    mc = mx.get('retrieved_contexts', [])
    for i, (n, m) in enumerate(zip(nc[:2], mc[:2])):
        print(f"  ctx[{i}] naive len={len(str(n))} | mix len={len(str(m))}")
        print(f"  naive: {str(n)[:150]}")
        print(f"  mix  : {str(m)[:150]}")
    print(f"  naive answer: {str(na.get('generated_answer',''))[:150]}")
    print(f"  mix   answer: {str(mx.get('generated_answer',''))[:150]}")
    print()
