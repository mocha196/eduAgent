"""Check actual course IDs in database vs Neo4j workspace labels."""
import os
import psycopg
from dotenv import load_dotenv

load_dotenv()

db_url = os.getenv("DATABASE_URL", "").split("?")[0]  # strip ?schema=public
conn = psycopg.connect(db_url)
cur = conn.cursor()
cur.execute("SET search_path TO public")
cur.execute("SELECT id::text, name FROM courses WHERE id::text LIKE '%c0000%' ORDER BY id::text")
print("=== Courses matching c0000 ===")
for row in cur.fetchall():
    print(row)

cur.execute("SELECT id::text, name FROM courses ORDER BY id::text LIMIT 10")
print("\n=== First 10 courses ===")
for row in cur.fetchall():
    print(row)

cur.close()
conn.close()
