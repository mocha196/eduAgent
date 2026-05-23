import psycopg

dsn = "postgresql://edu:edu@localhost:5432/edu_lightrag"
doc_id = "doc-784fa5306a156d7cbb6c851c5d291de7"

with psycopg.connect(dsn) as conn:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, workspace, status, chunks_list FROM lightrag_doc_status WHERE id = %s",
            (doc_id,),
        )
        rows = cur.fetchall()
        print("=== lightrag_doc_status ===")
        if rows:
            for r in rows:
                print(f"  id={r[0]}, ws={r[1]}, status={r[2]}, chunks_list={r[3]}")
        else:
            print("  (no rows)")

        cur.execute(
            "SELECT COUNT(*) FROM lightrag_doc_chunks WHERE full_doc_id = %s",
            (doc_id,),
        )
        print(f"\nlightrag_doc_chunks count for this doc: {cur.fetchone()[0]}")
