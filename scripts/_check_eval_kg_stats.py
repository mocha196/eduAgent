"""Quick script to print LightRAG chunk/entity/relation counts for all workspaces."""
import psycopg

for db_name, dsn in [
    ("edu_lightrag", "postgresql://edu:edu@localhost:5432/edu_lightrag"),
    ("edu_platform", "postgresql://edu:edu@localhost:5432/edu_platform"),
]:
    try:
        conn = psycopg.connect(dsn)
    except Exception as e:
        print(f"{db_name}: connect error - {e}")
        continue

    tables = [r[0] for r in conn.execute(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'lightrag%'"
    ).fetchall()]
    if not tables:
        print(f"{db_name}: no lightrag tables")
        conn.close()
        continue

    print(f"\n=== {db_name} ===")

    # Workspace-level stats for the key tables
    key_tables = {
        "lightrag_vdb_chunks":   "chunks (text blocks)",
        "lightrag_vdb_entity":   "entities",
        "lightrag_vdb_relation": "relations",
    }
    for tbl, label in key_tables.items():
        if tbl not in tables:
            continue
        rows = conn.execute(f"SELECT workspace, COUNT(*) FROM {tbl} GROUP BY workspace ORDER BY workspace").fetchall()
        if not rows:
            continue
        print(f"\n  [{tbl}] — {label}")
        for ws, cnt in rows:
            print(f"    {ws}: {cnt}")

    conn.close()
