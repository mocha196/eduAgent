"""Test course_bm25_hits_sync end-to-end."""
import sys
sys.path.insert(0, "src")
from dotenv import load_dotenv
load_dotenv()
from rag_mvp.engine import course_bm25_hits_sync

course_id = "c8b8787f-9c7e-4f37-bab5-fb94a438d9cf"
hits = course_bm25_hits_sync(course_id, "HTTP protocol connection", top_k=5)
print(f"BM25 hits: {len(hits)}")
for h in hits:
    score = h["relevance_score"]
    text = h["text"][:80]
    print(f"  [{score:.4f}] {text!r}")
