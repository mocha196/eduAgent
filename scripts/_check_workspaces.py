"""Check workspace fields in PostgreSQL LightRAG tables."""
import os
import psycopg
from dotenv import load_dotenv

load_dotenv()

db_url = os.getenv("LIGHTRAG_PG_DSN", "")
print(f"Using: {db_url}")
conn = psycopg.connect(db_url)
cur = conn.cursor()

# List lightrag tables
cur.execute("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name")
print("=== LightRAG DB tables ===")
for row in cur.fetchall():
    print(row)

# Check workspace in lightrag_vdb_entity
cur.execute("SELECT workspace, count(*) FROM lightrag_vdb_entity GROUP BY workspace ORDER BY count(*) DESC LIMIT 10")
print("\n=== lightrag_vdb_entity workspaces ===")
for row in cur.fetchall():
    print(row)

cur.close()
conn.close()
