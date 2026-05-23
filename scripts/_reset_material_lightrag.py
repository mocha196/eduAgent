"""
Precisely delete LightRAG rows for ONE specific material doc_id.
Only touches rows that belong to doc-784fa5306a156d7cbb6c851c5d291de7
in workspace course_c8b8787f-9c7e-4f37-bab5-fb94a438d9cf.
All other materials are untouched.
"""
import shutil, sys, json
from pathlib import Path

import psycopg

MATERIAL_ID = "08d1562d-ac3e-4e19-88e4-1a9a3b819b1f"
COURSE_ID   = "c8b8787f-9c7e-4f37-bab5-fb94a438d9cf"
WORKSPACE   = f"course_{COURSE_ID}"
DOC_ID      = "doc-784fa5306a156d7cbb6c851c5d291de7"
DSN         = "postgresql://edu:edu@localhost:5432/edu_lightrag"

conn = psycopg.connect(DSN)

# ── Step 1: collect chunk IDs that belong to this doc ──────────────────────
chunk_rows = conn.execute(
    "SELECT id FROM lightrag_doc_chunks WHERE workspace=%s AND full_doc_id=%s",
    (WORKSPACE, DOC_ID)
).fetchall()
chunk_ids = [r[0] for r in chunk_rows]
print(f"Chunks found for doc {DOC_ID}: {len(chunk_ids)}")

# ── Step 2: preview counts before deletion ─────────────────────────────────
print("\nRows to be deleted:")

n_status = conn.execute(
    "SELECT COUNT(*) FROM lightrag_doc_status WHERE workspace=%s AND id=%s", (WORKSPACE, DOC_ID)
).fetchone()[0]
print(f"  lightrag_doc_status  : {n_status}")

print(f"  lightrag_doc_chunks  : {len(chunk_ids)}")

n_full = conn.execute(
    "SELECT COUNT(*) FROM lightrag_doc_full WHERE workspace=%s AND id=%s", (WORKSPACE, DOC_ID)
).fetchone()[0]
print(f"  lightrag_doc_full    : {n_full}")

n_vdb_chunks = conn.execute(
    "SELECT COUNT(*) FROM lightrag_vdb_chunks WHERE workspace=%s AND full_doc_id=%s", (WORKSPACE, DOC_ID)
).fetchone()[0]
print(f"  lightrag_vdb_chunks  : {n_vdb_chunks}")

# For entities/relations: those whose chunk_ids array is a SUBSET of our material's chunks
# (i.e., the entity/relation is ONLY referenced by this material — safe to remove)
can_delete_kg = False
if chunk_ids:
    try:
        n_ent = conn.execute(
            "SELECT COUNT(*) FROM lightrag_vdb_entity WHERE workspace=%s AND chunk_ids <@ %s::varchar[]",
            (WORKSPACE, chunk_ids)
        ).fetchone()[0]
        print(f"  lightrag_vdb_entity  : {n_ent}  (exclusively from this doc)")

        n_rel = conn.execute(
            "SELECT COUNT(*) FROM lightrag_vdb_relation WHERE workspace=%s AND chunk_ids <@ %s::varchar[]",
            (WORKSPACE, chunk_ids)
        ).fetchone()[0]
        print(f"  lightrag_vdb_relation: {n_rel}  (exclusively from this doc)")

        n_ec = conn.execute(
            "SELECT COUNT(*) FROM lightrag_entity_chunks WHERE workspace=%s AND chunk_ids <@ to_jsonb(%s::text[])",
            (WORKSPACE, chunk_ids)
        ).fetchone()[0]
        print(f"  lightrag_entity_chunks  : {n_ec}")

        n_rc = conn.execute(
            "SELECT COUNT(*) FROM lightrag_relation_chunks WHERE workspace=%s AND chunk_ids <@ to_jsonb(%s::text[])",
            (WORKSPACE, chunk_ids)
        ).fetchone()[0]
        print(f"  lightrag_relation_chunks: {n_rc}")
        can_delete_kg = True
    except Exception as e:
        conn.rollback()
        print(f"  KG tables: cannot filter by chunk_ids ({e}) — will skip")

    n_cache = conn.execute(
        "SELECT COUNT(*) FROM lightrag_llm_cache WHERE workspace=%s AND chunk_id=ANY(%s::varchar[])",
        (WORKSPACE, chunk_ids)
    ).fetchone()[0]
    print(f"  lightrag_llm_cache   : {n_cache}")

print()
confirm = input("Proceed with deletion? [y/N] ").strip().lower()
if confirm != "y":
    print("Aborted.")
    conn.close()
    sys.exit(0)

# ── Step 3: delete ────────────────────────────────────────────────────────
conn.execute("DELETE FROM lightrag_doc_status WHERE workspace=%s AND id=%s", (WORKSPACE, DOC_ID))
print("  ✓ lightrag_doc_status")

conn.execute("DELETE FROM lightrag_doc_full WHERE workspace=%s AND id=%s", (WORKSPACE, DOC_ID))
print("  ✓ lightrag_doc_full")

conn.execute("DELETE FROM lightrag_doc_chunks WHERE workspace=%s AND full_doc_id=%s", (WORKSPACE, DOC_ID))
print("  ✓ lightrag_doc_chunks")

conn.execute("DELETE FROM lightrag_vdb_chunks WHERE workspace=%s AND full_doc_id=%s", (WORKSPACE, DOC_ID))
print("  ✓ lightrag_vdb_chunks")

if chunk_ids:
    if can_delete_kg:
        conn.execute(
            "DELETE FROM lightrag_vdb_entity WHERE workspace=%s AND chunk_ids <@ %s::varchar[]",
            (WORKSPACE, chunk_ids)
        )
        print("  ✓ lightrag_vdb_entity  (exclusive entries)")

        conn.execute(
            "DELETE FROM lightrag_vdb_relation WHERE workspace=%s AND chunk_ids <@ %s::varchar[]",
            (WORKSPACE, chunk_ids)
        )
        print("  ✓ lightrag_vdb_relation  (exclusive entries)")

        conn.execute(
            "DELETE FROM lightrag_entity_chunks WHERE workspace=%s AND chunk_ids <@ to_jsonb(%s::text[])",
            (WORKSPACE, chunk_ids)
        )
        print("  ✓ lightrag_entity_chunks")

        conn.execute(
            "DELETE FROM lightrag_relation_chunks WHERE workspace=%s AND chunk_ids <@ to_jsonb(%s::text[])",
            (WORKSPACE, chunk_ids)
        )
        print("  ✓ lightrag_relation_chunks")

    conn.execute(
        "DELETE FROM lightrag_llm_cache WHERE workspace=%s AND chunk_id=ANY(%s::varchar[])",
        (WORKSPACE, chunk_ids)
    )
    print("  ✓ lightrag_llm_cache")

conn.commit()
conn.close()
print("\nDB cleanup done.")

# ── Step 4: remove staged files in rag_storage ───────────────────────────
rag_storage_dir = Path("rag_storage") / WORKSPACE / MATERIAL_ID
if rag_storage_dir.exists():
    shutil.rmtree(rag_storage_dir)
    print(f"Removed staged dir: {rag_storage_dir}")
else:
    print(f"Staged dir not found (already clean): {rag_storage_dir}")

print("\nDone. Re-run import_course_material.py WITHOUT --resume to start fresh.")
