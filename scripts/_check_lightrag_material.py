"""Show what's indexed for the networking textbook material in LightRAG DB."""
import sys
sys.path.insert(0, "src")
from rag_mvp.engine import material_stable_doc_id

import psycopg

MATERIAL_ID = "08d1562d-ac3e-4e19-88e4-1a9a3b819b1f"
COURSE_ID = "c8b8787f-9c7e-4f37-bab5-fb94a438d9cf"
WORKSPACE = f"course_{COURSE_ID.replace('-', '_')}"
DSN = "postgresql://edu:edu@localhost:5432/edu_lightrag"

doc_id = material_stable_doc_id(MATERIAL_ID)
print(f"material doc_id : {doc_id}")
print(f"workspace       : {WORKSPACE}")
print()

conn = psycopg.connect(DSN)

# doc_status
rows = conn.execute(
    "SELECT id, status, content_summary, chunks_count FROM lightrag_doc_status WHERE workspace=%s",
    (WORKSPACE,)
).fetchall()
print(f"lightrag_doc_status ({len(rows)} rows):")
for r in rows:
    print(f"  id={r[0]}  status={r[1]}  chunks={r[3]}  summary={str(r[2])[:60]}")

print()
# doc_chunks count
n = conn.execute(
    "SELECT COUNT(*) FROM lightrag_doc_chunks WHERE workspace=%s",
    (WORKSPACE,)
).fetchone()[0]
print(f"lightrag_doc_chunks: {n} rows in workspace")

n2 = conn.execute(
    "SELECT COUNT(*) FROM lightrag_vdb_chunks WHERE workspace=%s",
    (WORKSPACE,)
).fetchone()[0]
print(f"lightrag_vdb_chunks: {n2} rows in workspace")

n3 = conn.execute(
    "SELECT COUNT(*) FROM lightrag_vdb_entity WHERE workspace=%s",
    (WORKSPACE,)
).fetchone()[0]
print(f"lightrag_vdb_entity: {n3} rows in workspace")

n4 = conn.execute(
    "SELECT COUNT(*) FROM lightrag_vdb_relation WHERE workspace=%s",
    (WORKSPACE,)
).fetchone()[0]
print(f"lightrag_vdb_relation: {n4} rows in workspace")

n5 = conn.execute(
    "SELECT COUNT(*) FROM lightrag_full_entities WHERE workspace=%s",
    (WORKSPACE,)
).fetchone()[0]
print(f"lightrag_full_entities: {n5} rows")

n6 = conn.execute(
    "SELECT COUNT(*) FROM lightrag_full_relations WHERE workspace=%s",
    (WORKSPACE,)
).fetchone()[0]
print(f"lightrag_full_relations: {n6} rows")

conn.close()
