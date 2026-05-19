"""Migrate eval infrastructure IDs to RFC 4122-compliant UUIDs."""
import sys
sys.path.insert(0, "src")
from dotenv import load_dotenv
load_dotenv(".env", override=False)

import os
import psycopg
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

raw = os.environ["DATABASE_URL"]
p = urlparse(raw)
qs = {k: v for k, v in parse_qs(p.query).items() if k in ("sslmode", "connect_timeout")}
edu_dsn = urlunparse(p._replace(query=urlencode({k: v[0] for k, v in qs.items()})))
lightrag_dsn = os.environ["LIGHTRAG_PG_DSN"]

OLD_TEACHER = "e0000001-0000-0000-0000-000000000000"
NEW_TEACHER = "e0000001-0000-4000-8000-000000000000"
OLD_STUDENT = "e0000002-0000-0000-0000-000000000000"
NEW_STUDENT = "e0000002-0000-4000-8000-000000000000"

COURSE_MAP = {
    "c0000001-0000-0000-0000-000000000000": "c0000001-0000-4000-8000-000000000000",
    "c0000002-0000-0000-0000-000000000000": "c0000002-0000-4000-8000-000000000000",
    "c0000003-0000-0000-0000-000000000000": "c0000003-0000-4000-8000-000000000000",
}

LIGHTRAG_TABLES = [
    "lightrag_doc_chunks",
    "lightrag_vdb_chunks",
    "lightrag_doc_full",
    "lightrag_doc_status",
    "lightrag_entity_chunks",
    "lightrag_relation_chunks",
    "lightrag_vdb_entity",
    "lightrag_vdb_relation",
    "lightrag_full_entities",
    "lightrag_full_relations",
    "lightrag_llm_cache",
]

print("=== edu_platform DB ===")
with psycopg.connect(edu_dsn) as conn:
    with conn.cursor() as cur:
        for old, new in COURSE_MAP.items():
            cur.execute("UPDATE courses SET id=%s WHERE id=%s", (new, old))
            print(f"  Course {old} -> {new}: {cur.rowcount}")
        cur.execute("UPDATE users SET id=%s WHERE id=%s", (NEW_TEACHER, OLD_TEACHER))
        print(f"  User(teacher) {OLD_TEACHER} -> {NEW_TEACHER}: {cur.rowcount}")
        cur.execute("UPDATE users SET id=%s WHERE id=%s", (NEW_STUDENT, OLD_STUDENT))
        print(f"  User(student) {OLD_STUDENT} -> {NEW_STUDENT}: {cur.rowcount}")
    conn.commit()

print("\n=== edu_lightrag DB (workspace rename) ===")
with psycopg.connect(lightrag_dsn) as conn:
    with conn.cursor() as cur:
        for old_cid, new_cid in COURSE_MAP.items():
            old_ws = f"course_{old_cid}"
            new_ws = f"course_{new_cid}"
            for table in LIGHTRAG_TABLES:
                cur.execute(
                    f"UPDATE {table} SET workspace=%s WHERE workspace=%s",
                    (new_ws, old_ws),
                )
                if cur.rowcount:
                    print(f"  {table}: {old_ws} -> {new_ws}: {cur.rowcount}")
    conn.commit()

print("\nDone.")
