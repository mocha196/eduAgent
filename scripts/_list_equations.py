import json, pathlib
cl = json.loads(pathlib.Path(r'output\parsed\计算机网络content_lists\MinerU_计算机网络自顶向下第八版英文PDF-1-199__20260519044058_content_list.json').read_text(encoding='utf-8'))
eqs = [x for x in cl if x.get('type') == 'equation']
for i, e in enumerate(eqs):
    txt = repr(e.get('text', '')[:80])
    print(f"eq[{i}] page={e.get('page_idx')} text={txt}")
