"""Delete lightrag_llm_cache rows whose chunk_id no longer exists in lightrag_doc_chunks."""
import psycopg

DSN = "postgresql://edu:edu@localhost:5432/edu_lightrag"

conn = psycopg.connect(DSN)
total = conn.execute("SELECT COUNT(*) FROM lightrag_llm_cache").fetchone()[0]
orphan = conn.execute(
    """
    SELECT COUNT(*) FROM lightrag_llm_cache c
    WHERE c.chunk_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM lightrag_doc_chunks d
          WHERE d.workspace = c.workspace AND d.id = c.chunk_id
      )
    """
).fetchone()[0]
null_chunk = conn.execute(
    "SELECT COUNT(*) FROM lightrag_llm_cache WHERE chunk_id IS NULL"
).fetchone()[0]
print(f"Total rows       : {total}")
print(f"chunk_id IS NULL : {null_chunk}")
print(f"Orphaned (chunk deleted): {orphan}")

deleted = conn.execute(
    """
    DELETE FROM lightrag_llm_cache
    WHERE chunk_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM lightrag_doc_chunks d
          WHERE d.workspace = lightrag_llm_cache.workspace AND d.id = lightrag_llm_cache.chunk_id
      )
    """
).rowcount
conn.commit()
print(f"Deleted {deleted} orphaned cache rows.")
conn.close()
