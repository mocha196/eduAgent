"""
Re-ingest a material to fix missing chunk_page_mappings.

This script:
1. Deletes the material's stale LightRAG chunks (doc_chunks, vdb_chunks)
2. Deletes stale material_images rows
3. Resets material status to UPLOADED so the cron worker re-processes it
4. On re-processing: MinerU runs → content_list.json → _record_chunk_page_mappings
   produces correct chunk_id ↔ page_idx mappings aligned with the new MinIO images.

Usage:
    cd e:\appProjects\eee
    .venv\Scripts\python.exe scripts\_reingest_material_fix_images.py <material_id> [--dry-run]

Example:
    .venv\Scripts\python.exe scripts\_reingest_material_fix_images.py 8890cf38-2382-46df-99ef-80fd9c2ccdc5
"""
import sys, os
sys.path.insert(0, "src")
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
from dotenv import load_dotenv

load_dotenv(".env", override=False)
load_dotenv("edu-platform/.env.local", override=False)

import psycopg

DRY_RUN = "--dry-run" in sys.argv
material_ids = [a for a in sys.argv[1:] if not a.startswith("-")]

if not material_ids:
    print("Usage: _reingest_material_fix_images.py <material_id> [--dry-run]")
    sys.exit(1)


def _app_dsn() -> str:
    raw = os.environ["DATABASE_URL"]
    p = urlparse(raw)
    qs = {k: v for k, v in parse_qs(p.query).items() if k in ("sslmode", "connect_timeout")}
    return urlunparse(p._replace(query=urlencode({k: v[0] for k, v in qs.items()})))


def reingest_material(material_id: str) -> None:
    app_dsn = _app_dsn()

    # ── 1. Verify material exists and get info ──────────────────────────────
    with psycopg.connect(app_dsn) as app_conn:
        with app_conn.cursor() as cur:
            cur.execute(
                "SELECT id, original_filename, status, course_id FROM materials WHERE id=%s::uuid",
                (material_id,),
            )
            mat = cur.fetchone()
            if not mat:
                print(f"[ERROR] Material {material_id} not found in materials table")
                return
            mat_id, filename, status, course_id = mat
            print(f"Material  : {mat_id}")
            print(f"Filename  : {filename}")
            print(f"Status    : {status}")
            print(f"Course    : {course_id}")

            cur.execute(
                "SELECT COUNT(*) FROM material_images WHERE material_id=%s::uuid",
                (material_id,),
            )
            img_count = cur.fetchone()[0]
            print(f"material_images rows  : {img_count}")

            cur.execute(
                "SELECT COUNT(*) FROM chunk_page_mappings WHERE material_id=%s::uuid",
                (material_id,),
            )
            cpm_count = cur.fetchone()[0]
            print(f"chunk_page_mappings   : {cpm_count}")

    # ── 2. Find LightRAG doc_id for this material ───────────────────────────
    lg_conn = psycopg.connect("host=localhost dbname=edu_lightrag user=edu password=edu")
    try:
        with lg_conn.cursor() as cur:
            cur.execute(
                "SELECT DISTINCT full_doc_id, workspace FROM lightrag_doc_chunks WHERE file_path LIKE %s",
                (f"mat_{material_id}_%",),
            )
            doc_rows = cur.fetchall()
            if doc_rows:
                print(f"\nLightRAG docs found: {len(doc_rows)}")
                for doc_id, ws in doc_rows:
                    cur.execute(
                        "SELECT COUNT(*) FROM lightrag_doc_chunks WHERE full_doc_id=%s AND workspace=%s",
                        (doc_id, ws),
                    )
                    cnt = cur.fetchone()[0]
                    print(f"  {doc_id} in {ws}: {cnt} chunks")
            else:
                print("\nNo LightRAG chunks found for this material.")
    finally:
        lg_conn.close()

    print()
    if DRY_RUN:
        print("[DRY RUN] No changes made. Remove --dry-run to execute.")
        return

    confirm = input("Proceed with re-ingest? This will delete LightRAG chunks and material_images, then reset status to UPLOADED. [y/N] ").strip().lower()
    if confirm != "y":
        print("Aborted.")
        return

    # ── 3. Delete LightRAG chunks for this material ─────────────────────────
    lg_conn = psycopg.connect("host=localhost dbname=edu_lightrag user=edu password=edu")
    try:
        deleted_total = 0
        for doc_id, ws in doc_rows:
            # Get all chunk IDs for this doc
            with lg_conn.cursor() as cur:
                cur.execute(
                    "SELECT id FROM lightrag_doc_chunks WHERE full_doc_id=%s AND workspace=%s",
                    (doc_id, ws),
                )
                chunk_ids = [r[0] for r in cur.fetchall()]

            # Delete from vdb_chunks
            with lg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM lightrag_vdb_chunks WHERE full_doc_id=%s AND workspace=%s",
                    (doc_id, ws),
                )
                n = cur.rowcount
                print(f"  Deleted {n} lightrag_vdb_chunks rows")
                deleted_total += n

            # Delete from doc_chunks
            with lg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM lightrag_doc_chunks WHERE full_doc_id=%s AND workspace=%s",
                    (doc_id, ws),
                )
                n = cur.rowcount
                print(f"  Deleted {n} lightrag_doc_chunks rows")
                deleted_total += n

            # Optionally delete doc_status and doc_full
            with lg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM lightrag_doc_status WHERE id=%s AND workspace=%s",
                    (doc_id, ws),
                )
                n = cur.rowcount
                if n:
                    print(f"  Deleted {n} lightrag_doc_status rows")

            with lg_conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM lightrag_doc_full WHERE id=%s AND workspace=%s",
                    (doc_id, ws),
                )
                n = cur.rowcount
                if n:
                    print(f"  Deleted {n} lightrag_doc_full rows")

        lg_conn.commit()
        print(f"LightRAG cleanup done. Total rows deleted: {deleted_total}")
    finally:
        lg_conn.close()

    # ── 4. Delete material_images and chunk_page_mappings ───────────────────
    with psycopg.connect(app_dsn) as app_conn:
        with app_conn.cursor() as cur:
            cur.execute(
                "DELETE FROM material_images WHERE material_id=%s::uuid",
                (material_id,),
            )
            n = cur.rowcount
            print(f"Deleted {n} material_images rows")

            cur.execute(
                "DELETE FROM chunk_page_mappings WHERE material_id=%s::uuid",
                (material_id,),
            )
            n = cur.rowcount
            print(f"Deleted {n} chunk_page_mappings rows")

        # ── 5. Reset material status to UPLOADED ────────────────────────────
        with app_conn.cursor() as cur:
            cur.execute(
                """
                UPDATE materials
                SET status = 'UPLOADED',
                    status_message = 'Reset for re-ingest (fix chunk_page_mappings)',
                    updated_at = NOW()
                WHERE id = %s::uuid
                """,
                (material_id,),
            )
            n = cur.rowcount
            print(f"Reset {n} materials row to UPLOADED status")
        app_conn.commit()

    print("\n✓ Done. The cron worker will pick up this material and re-process it.")
    print("  After re-processing, chunk_page_mappings will be populated correctly.")
    print("  Monitor with: .venv\\Scripts\\python.exe scripts\\_check_doc_status.py")


for mid in material_ids:
    print(f"\n{'='*60}")
    reingest_material(mid)
