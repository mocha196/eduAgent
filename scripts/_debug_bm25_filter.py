"""Debug why image chunks still appear in BM25 results."""
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
        # Check what the image chunk content looks like exactly
        cur.execute(
            "SELECT id, LEFT(content, 40), LENGTH(content), "
            "TRIM(content) LIKE 'Image Content%' AS matches_trim "
            "FROM LIGHTRAG_VDB_CHUNKS "
            "WHERE workspace='course_c8b8787f-9c7e-4f37-bab5-fb94a438d9cf' "
            "  AND to_tsvector('english', content) @@ plainto_tsquery('english', 'HTTP protocol') "
            "  AND content ILIKE '%Image Content%' "
            "LIMIT 5"
        )
        print("Image chunks and filter check:")
        for r in cur.fetchall():
            print(f"  id={r[0]!r}  content_start={r[1]!r}  len={r[2]}  trim_match={r[3]}")

        # Now test the actual BM25 query with the filter
        cur.execute(
            "SELECT id, LEFT(content, 60) "
            "FROM LIGHTRAG_VDB_CHUNKS "
            "WHERE workspace='course_c8b8787f-9c7e-4f37-bab5-fb94a438d9cf' "
            "  AND TRIM(content) <> '' "
            "  AND TRIM(content) NOT LIKE 'Image Content%%' "
            "  AND TRIM(content) NOT LIKE 'Image Path%%' "
            "  AND TRIM(content) NOT LIKE 'Code Content%%' "
            "  AND TRIM(content) NOT LIKE '![%%' "
            "  AND TRIM(content) NOT LIKE '<image%%' "
            "  AND to_tsvector('english', content) @@ plainto_tsquery('english', 'HTTP protocol') "
            "ORDER BY ts_rank_cd(to_tsvector('english', content), plainto_tsquery('english', 'HTTP protocol')) DESC "
            "LIMIT 10"
        )
        print("\nWith filter applied:")
        for r in cur.fetchall():
            print(f"  {r[1]!r}")
