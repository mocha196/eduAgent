"""Quick check of LightRAG table row counts for both eval workspaces."""
import psycopg

conn = psycopg.connect("host=localhost dbname=edu_lightrag user=edu password=edu")
cur = conn.cursor()

# List all tables
cur.execute("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
all_tables = [r[0] for r in cur.fetchall()]
print("Tables:", all_tables)
print()

workspaces = [
    "course_c0000001-0000-4000-8000-000000000000",  # naive
    "course_c0000002-0000-4000-8000-000000000000",  # full
]

for ws in workspaces:
    print(f"=== {ws} ===")
    for tbl in all_tables:
        try:
            cur.execute(f"SELECT COUNT(*) FROM {tbl} WHERE workspace = %s", (ws,))
            cnt = cur.fetchone()[0]
            if cnt > 0:
                print(f"  {tbl}: {cnt}")
        except Exception as e:
            conn.rollback()
    print()

ws2 = "course_c0000002-0000-4000-8000-000000000000"
print("=== lightrag_full_entities: all distinct workspace values ===")
cur.execute("SELECT workspace, COUNT(*) FROM lightrag_full_entities GROUP BY workspace ORDER BY COUNT(*) DESC LIMIT 10")
for row in cur.fetchall():
    print(f"  {row[0]}: {row[1]}")

print()
print("=== lightrag_full_relations: all distinct workspace values ===")
cur.execute("SELECT workspace, COUNT(*) FROM lightrag_full_relations GROUP BY workspace ORDER BY COUNT(*) DESC LIMIT 10")
for row in cur.fetchall():
    print(f"  {row[0]}: {row[1]}")

print()
print("=== lightrag_vdb_entity columns and sample rows ===")
cur.execute("SELECT column_name FROM information_schema.columns WHERE table_name='lightrag_vdb_entity' ORDER BY ordinal_position")
cols = [r[0] for r in cur.fetchall()]
print("  columns:", cols)
cur.execute("SELECT * FROM lightrag_vdb_entity WHERE workspace = %s LIMIT 2", (ws2,))
for row in cur.fetchall():
    print("  ", {k: str(v)[:80] for k, v in zip(cols, row)})

print()
print("=== lightrag_full_entities sample (c0000002 workspace) ===")
cur.execute("SELECT * FROM lightrag_full_entities WHERE workspace = %s LIMIT 3", (ws2,))
fe_cols_r = cur.description
if fe_cols_r:
    fe_cols = [d[0] for d in fe_cols_r]
    print("  columns:", fe_cols)
    for row in cur.fetchall():
        print("  ", {k: str(v)[:100] for k, v in zip(fe_cols, row)})

conn.close()
