import psycopg
dsn = "postgresql://edu:edu@localhost:5432/edu_lightrag"
conn = psycopg.connect(dsn)
rows = conn.execute("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").fetchall()
for r in rows:
    print(r[0])
conn.close()
