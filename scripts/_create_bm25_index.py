"""Create GIN tsvector index on LIGHTRAG_VDB_CHUNKS.content (idempotent)."""
import sys, os
sys.path.insert(0, "src")
from dotenv import load_dotenv; load_dotenv()
import psycopg
from urllib.parse import urlparse, parse_qsl, urlencode, urlunparse

dsn = os.environ.get("LIGHTRAG_PG_DSN") or os.environ.get("DATABASE_URL")
p = urlparse(dsn)
qs = [(k, v) for k, v in parse_qsl(p.query) if k != "schema"]
dsn2 = urlunparse(p._replace(query=urlencode(qs)))

print("Connecting to:", dsn2[:40], "...")

with psycopg.connect(dsn2) as conn:
    print("Creating GIN index (may take a few seconds)...")
    with conn.cursor() as cur:
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_lr_vdb_chunks_fts "
            "ON LIGHTRAG_VDB_CHUNKS USING GIN (to_tsvector('english', content))"
        )
    conn.commit()
    print("Index created (or already existed).")

    with psycopg.connect(dsn2) as conn2:
        with conn2.cursor() as cur2:
            cur2.execute(
                "SELECT indexname, indexdef FROM pg_indexes "
                "WHERE tablename='lightrag_vdb_chunks' AND indexdef ILIKE '%tsvector%'"
            )
            rows = cur2.fetchall()
            print("Tsvector indexes now:", rows)

            # Quick BM25 test query
            cur2.execute(
                "SELECT id, LEFT(content, 80), "
                "ts_rank_cd(to_tsvector('english', content), plainto_tsquery('english', 'HTTP protocol')) AS score "
                "FROM LIGHTRAG_VDB_CHUNKS "
                "WHERE workspace='course_c8b8787f-9c7e-4f37-bab5-fb94a438d9cf' "
                "  AND to_tsvector('english', content) @@ plainto_tsquery('english', 'HTTP protocol') "
                "ORDER BY score DESC LIMIT 5"
            )
            print("\nBM25 test results for 'HTTP protocol':")
            for r in cur2.fetchall():
                print(f"  score={r[2]:.4f}  {r[1]!r}")
