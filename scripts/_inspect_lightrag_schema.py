import psycopg

DSN       = "postgresql://edu:edu@localhost:5432/edu_lightrag"
WORKSPACE = "course_c8b8787f-9c7e-4f37-bab5-fb94a438d9cf"
DOC_ID    = "doc-784fa5306a156d7cbb6c851c5d291de7"

tables = [
    "lightrag_doc_status",
    "lightrag_doc_chunks",
    "lightrag_doc_full",
    "lightrag_vdb_chunks",
    "lightrag_vdb_entity",
    "lightrag_vdb_relation",
    "lightrag_entity_chunks",
    "lightrag_relation_chunks",
    "lightrag_full_entities",
    "lightrag_full_relations",
    "lightrag_llm_cache",
]

conn = psycopg.connect(DSN)
for t in tables:
    cols = conn.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name=%s ORDER BY ordinal_position",
        (t,)
    ).fetchall()
    col_names = [c[0] for c in cols]
    print(f"{t}: {col_names}")
conn.close()
