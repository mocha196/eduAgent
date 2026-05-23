import psycopg
DSN = "postgresql://edu:edu@localhost:5432/edu_lightrag"
conn = psycopg.connect(DSN)
for table in ["lightrag_doc_status", "lightrag_doc_chunks", "lightrag_vdb_chunks"]:
    rows = conn.execute(f"SELECT DISTINCT workspace FROM {table} LIMIT 20").fetchall()
    print(f"{table} workspaces: {[r[0] for r in rows]}")
conn.close()
