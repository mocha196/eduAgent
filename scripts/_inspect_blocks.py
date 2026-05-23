import json, pathlib

f = pathlib.Path('output/parsed/MinerU_计算机网络自顶向下第八版英文PDF-1-199__20260519044058.json')
data = json.loads(f.read_text('utf-8'))

for btype in ('table', 'chart', 'code'):
    print(f'=== {btype} full spans ===')
    found = False
    for page in data.get('pdf_info', []):
        for block in page.get('preproc_blocks', []):
            if block.get('type') != btype:
                continue
            for sub in block.get('blocks', []):
                stype = sub.get('type', '?')
                print(f'  sub_type={stype}')
                for line in sub.get('lines', [])[:2]:
                    for span in line.get('spans', []):
                        span_type = span.get('type', '?')
                        if 'image_path' in span:
                            print(f'    span type={span_type}  image_path={span["image_path"][:70]}...')
                        elif 'content' in span:
                            print(f'    span type={span_type}  content={repr(span["content"][:60])}')
                        else:
                            print(f'    span keys={list(span.keys())}')
            found = True
            break
        if found:
            break
    print()
