"""End-to-end test of query_lightrag_direct with BM25+RRF enabled."""
import sys
from pathlib import Path
sys.path.insert(0, "src")
sys.path.insert(0, str(Path(__file__).parents[1]))
from dotenv import load_dotenv
load_dotenv()

from tests.eval._common import query_lightrag_direct

COURSE_ID = "c8b8787f-9c7e-4f37-bab5-fb94a438d9cf"

questions = [
    "HTTP协议的非持久连接和持久连接有什么区别？",
    "What is the purpose of the DNS protocol?",
]

for q in questions:
    print(f"\n=== Q: {q} ===")
    ans, chunks = query_lightrag_direct(
        COURSE_ID, q, mode="naive", top_k=10,
        enable_rewrite=True, enable_decompose=False, enable_bm25=True,
    )
    print(f"Answer ({len(ans)} chars): {ans[:200]}")
    print(f"Chunks used: {len(chunks)}")
    for i, c in enumerate(chunks[:3]):
        print(f"  [{i+1}] {c[:80]!r}")
