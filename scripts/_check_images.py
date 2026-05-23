import json, pathlib, collections

parts = [
    'output/parsed/计算机网络content_lists/MinerU_计算机网络自顶向下第八版英文PDF-1-199__20260519044058_content_list.json',
    'output/parsed/计算机网络content_lists/MinerU_计算机网络自顶向下第八版英文PDF-200-399__20260519050919_content_list.json',
    'output/parsed/计算机网络content_lists/MinerU_计算机网络自顶向下第八版英文PDF-400-599__20260519050929_content_list.json',
    'output/parsed/计算机网络content_lists/MinerU_计算机网络自顶向下第八版英文PDF-600-792__20260519050934_content_list.json',
]
total = collections.Counter()
all_items = []
for i, p in enumerate(parts, 1):
    cl = json.loads(pathlib.Path(p).read_text('utf-8'))
    all_items.extend(cl)
    c = collections.Counter(x['type'] for x in cl)
    print(f'Part {i}: {dict(c)}')
    total += c
print(f'\nTOTAL: {dict(total)}')

imgs = [x for x in all_items if x.get('type') == 'image']
with_path = [x for x in imgs if x.get('img_path')]
without_path = [x for x in imgs if not x.get('img_path')]
print(f'\nImages with img_path  : {len(with_path)}')
print(f'Images without img_path: {len(without_path)}')
if with_path:
    print(f'First image path: {with_path[0]["img_path"]}')
    print(f'Second image path: {with_path[1]["img_path"] if len(with_path) > 1 else "N/A"}')
