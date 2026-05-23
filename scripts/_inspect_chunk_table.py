"""Inspect LIGHTRAG_VDB_CHUNKS table structure."""
import sys, os
sys.path.insert(0, "src")
from dotenv import load_dotenv; load_dotenv()
import psycopg
from urllib.parse import urlparse, parse_qsl, urlencode, urlunparse

dsn = os.environ.get("LIGHTRAG_PG_DSN") or os.environ.get("DATABASE_URL")
p = urlparse(dsn)
qs = [(k, v) for k, v in parse_qsl(p.query) if k != "schema"]
dsn2 = urlunparse(p._replace(query=urlencode(qs)))

with psycopg.connect(dsn2) as conn:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_name ILIKE '%chunk%' AND table_schema='public' ORDER BY 1"
        )
        print("Chunk tables:", [r[0] for r in cur.fetchall()])

        cur.execute(
            "SELECT column_name, data_type FROM information_schema.columns "
            "WHERE LOWER(table_name)='lightrag_vdb_chunks' AND table_schema='public' "
            "ORDER BY ordinal_position"
        )
        print("VDB_CHUNKS columns:")
        for r in cur.fetchall():
            print("  ", r)

        cur.execute("SELECT COUNT(*) FROM LIGHTRAG_VDB_CHUNKS")
        print("Count:", cur.fetchone()[0])

        cur.execute("SELECT id, workspace, LEFT(content, 100) FROM LIGHTRAG_VDB_CHUNKS LIMIT 3")
        print("Sample rows:")
        for r in cur.fetchall():
            print("  ", r)

        # check if tsvector index already exists
        cur.execute(
            "SELECT indexname, indexdef FROM pg_indexes "
            "WHERE tablename='lightrag_vdb_chunks' AND indexdef ILIKE '%tsvector%'"
        )
        print("Existing tsvector indexes:", cur.fetchall())
