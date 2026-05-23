"""Extract id + question fields from ragas_custom_questions.json."""
import json
from pathlib import Path

src = Path("tests/eval/data/ragas_custom_questions.json")
dst = Path("tests/eval/data/questions_only.json")

data = json.loads(src.read_text(encoding="utf-8"))
out = [{"id": q["id"], "question": q["question"]} for q in data]

dst.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"Extracted {len(out)} questions → {dst}")
