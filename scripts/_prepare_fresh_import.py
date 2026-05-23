"""Check + delete material record from main platform DB for a fresh re-run."""
import os, shutil
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

import psycopg

MATERIAL_ID = "08d1562d-ac3e-4e19-88e4-1a9a3b819b1f"

url = os.environ["DATABASE_URL"].replace("?schema=public", "")
conn = psycopg.connect(url)

row = conn.execute(
    "SELECT id, status, updated_at FROM materials WHERE id=%s::uuid",
    (MATERIAL_ID,)
).fetchone()
print("Current materials row:", row)

if row is None:
    print("No record found — nothing to delete from main DB.")
else:
    deleted = conn.execute(
        "DELETE FROM materials WHERE id=%s::uuid",
        (MATERIAL_ID,)
    ).rowcount
    conn.commit()
    print(f"Deleted {deleted} row from materials table.")

conn.close()

# Remove staged output dir
output_dir = Path("output") / MATERIAL_ID
if output_dir.exists():
    shutil.rmtree(output_dir)
    print(f"Removed staged dir: {output_dir}")
else:
    print(f"Staged dir not found (already clean): {output_dir}")
